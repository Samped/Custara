import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { dispatchWebhook } from "@/lib/webhooks";
import { encryptField } from "@/lib/crypto";
import { isPajBankWorkspace, pajCountryCode, pajFiatCurrency } from "@/lib/geoFeatures";
import { publicAppUrl } from "@/lib/publicUrl";
import { convertAmount } from "@/lib/currency";
import { getUsdcTokenAddress } from "@/domain/arc/config";
import { addDestination } from "@/domain/arc/allowlist";
import { applyAgentDeposit, ensureAgentWallet, syncWalletBalances } from "@/domain/arc/wallets";
import { enqueueAgentTask } from "@/domain/arc/tasks";
import { assertPayStepUp } from "@/domain/payStepUp";
import { assertPayTimeGuards } from "@/domain/payGuards";
import {
  createPajOfframpOrder,
  createPajOnrampOrder,
  listPajBanks,
  pajArcTxHash,
  pajConfigured,
  registerPajBankAccount,
  type PajTransaction,
} from "./paj";

function pajWebhookUrl() {
  return `${publicAppUrl()}/api/webhooks/paj`;
}

function pajMint() {
  try {
    return getUsdcTokenAddress();
  } catch {
    return "0x3600000000000000000000000000000000000000";
  }
}

export async function ensurePajConnector(organizationId: string) {
  return prisma.integrationConnector.upsert({
    where: {
      organizationId_type: { organizationId, type: "payment_paj" },
    },
    create: {
      organizationId,
      type: "payment_paj",
      name: "PAJ bank rails",
      status: pajConfigured() ? "connected" : "disconnected",
      configJson: JSON.stringify({ adapter: "paj", chain: "ARC" }),
      secretsJson: JSON.stringify({
        configured: pajConfigured(),
        apiKeyEnc: pajConfigured() ? encryptField("env:PAJ_API_KEY") : null,
      }),
    },
    update: {
      status: pajConfigured() ? "connected" : "disconnected",
    },
  });
}

export async function requirePajOrg(organizationId: string) {
  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: { id: true, country: true, displayCurrency: true, paymentMode: true },
  });
  if (!isPajBankWorkspace(org)) {
    throw new Error(
      "Fund and Withdraw from bank are available in PAJ African markets. Set business location in Settings.",
    );
  }
  return org;
}

export async function getPajHomeStatus(organizationId: string) {
  const [org, banks] = await Promise.all([
    prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { country: true, displayCurrency: true },
    }),
    prisma.bankAccount.findMany({
      where: { organizationId },
      orderBy: { updatedAt: "desc" },
    }),
  ]);
  return {
    paj: isPajBankWorkspace(org),
    nigeria: isPajBankWorkspace(org),
    fiatCurrency: pajFiatCurrency(org),
    configured: pajConfigured(),
    banks: banks.map((b) => ({
      id: b.id,
      bankCode: b.bankCode,
      accountNumber: b.accountNumber,
      accountName: b.accountName,
      currency: b.currency,
    })),
  };
}

export async function fetchPajBanksForWorkspace(organizationId: string) {
  const org = await requirePajOrg(organizationId);
  if (!pajConfigured()) throw new Error("Bank rails not configured");
  return listPajBanks(pajCountryCode(org) || "NG");
}

export async function saveWorkspaceBank(input: {
  organizationId: string;
  bankCode: string;
  accountNumber: string;
  actorId?: string;
}) {
  const org = await requirePajOrg(input.organizationId);
  if (!pajConfigured()) throw new Error("Bank rails not configured");
  await ensurePajConnector(input.organizationId);
  const confirmed = await registerPajBankAccount({
    bankCode: input.bankCode,
    accountNumber: input.accountNumber,
  });
  const row = await prisma.bankAccount.upsert({
    where: {
      organizationId_bankCode_accountNumber: {
        organizationId: input.organizationId,
        bankCode: input.bankCode.trim(),
        accountNumber: confirmed.accountNumber || input.accountNumber.trim(),
      },
    },
    create: {
      organizationId: input.organizationId,
      bankCode: input.bankCode.trim(),
      accountNumber: confirmed.accountNumber || input.accountNumber.trim(),
      accountName: confirmed.accountName,
      currency: pajFiatCurrency(org) || "NGN",
    },
    update: {
      accountName: confirmed.accountName,
    },
  });
  await writeAudit({
    organizationId: input.organizationId,
    actorType: "user",
    actorId: input.actorId,
    action: "bank.account_saved",
    entityType: "bank_account",
    entityId: row.id,
    metadata: { bankCode: row.bankCode, accountNumber: row.accountNumber },
  });
  return row;
}

export async function startPajOnramp(input: {
  organizationId: string;
  fiatAmountNgn?: number;
  fiatAmount?: number;
  actorId?: string;
}) {
  const org = await requirePajOrg(input.organizationId);
  if (!pajConfigured()) throw new Error("Bank rails not configured");
  const fiatCurrency = pajFiatCurrency(org) || "NGN";
  const fiatAmount = Number(input.fiatAmount ?? input.fiatAmountNgn);
  if (!(fiatAmount > 0)) throw new Error(`Enter a ${fiatCurrency} amount to fund`);
  await ensurePajConnector(input.organizationId);

  const agent = await ensureAgentWallet({
    organizationId: input.organizationId,
    actorType: "user",
    actorId: input.actorId,
  });
  if (!agent.address) throw new Error("Payment wallet is not ready");

  const order = await createPajOnrampOrder({
    fiatAmount,
    currency: fiatCurrency,
    chain: "ARC",
    mint: pajMint(),
    recipient: agent.address,
    webhookURL: pajWebhookUrl(),
    userExternalId: input.organizationId,
  });

  const usdc = Number(order.usdcAmount || 0);
  const intent = await prisma.paymentIntent.create({
    data: {
      organizationId: input.organizationId,
      invoiceId: null,
      kind: "paj_onramp",
      idempotencyKey: `paj_onramp_${order.id}`,
      status: mapPajStatus(order.status),
      rail: "paj_onramp",
      amount: usdc > 0 ? usdc : fiatAmount,
      currency: usdc > 0 ? "USDC" : fiatCurrency,
      beneficiaryJson: JSON.stringify({
        rail: "paj_onramp",
        accountNumber: order.accountNumber,
        accountName: order.accountName,
        bank: order.bank,
        fiatAmount: order.fiatAmount ?? fiatAmount,
        fiatCurrency,
        recipient: agent.address,
        chain: "ARC",
      }),
      providerRef: order.id,
      mode: org.paymentMode === "live" ? "live" : "sandbox",
      txHash: pajArcTxHash(order.signature),
    },
  });

  await writeAudit({
    organizationId: input.organizationId,
    actorType: "user",
    actorId: input.actorId,
    action: "payment.paj_onramp_opened",
    entityType: "payment_intent",
    entityId: intent.id,
    metadata: { pajOrderId: order.id, fiatAmount, fiatCurrency },
  });

  return {
    intent,
    order: {
      id: order.id,
      accountNumber: order.accountNumber,
      accountName: order.accountName,
      bank: order.bank,
      fiatAmount: order.fiatAmount ?? fiatAmount,
      fiatCurrency,
      usdcAmount: order.usdcAmount ?? null,
      status: order.status,
    },
  };
}

export async function startPajOfframp(input: {
  organizationId: string;
  amountUsdc: number;
  bankAccountId?: string;
  bankCode?: string;
  accountNumber?: string;
  actorId: string;
  mfaCode?: string | null;
}) {
  const org = await requirePajOrg(input.organizationId);
  if (!pajConfigured()) throw new Error("Bank rails not configured");
  if (!(input.amountUsdc > 0)) throw new Error("Enter a USDC amount to withdraw");

  await assertPayStepUp({
    organizationId: input.organizationId,
    actorType: "user",
    actorId: input.actorId,
    amountUsd: convertAmount(input.amountUsdc, "USDC", "USD"),
    mfaCode: input.mfaCode,
  });

  let bank = input.bankAccountId
    ? await prisma.bankAccount.findFirst({
        where: { id: input.bankAccountId, organizationId: input.organizationId },
      })
    : null;
  if (!bank) {
    if (!input.bankCode || !input.accountNumber) {
      throw new Error("Save a local bank account first");
    }
    bank = await saveWorkspaceBank({
      organizationId: input.organizationId,
      bankCode: input.bankCode,
      accountNumber: input.accountNumber,
      actorId: input.actorId,
    });
  }

  await ensurePajConnector(input.organizationId);
  const order = await createPajOfframpOrder({
    bankCode: bank.bankCode,
    accountNumber: bank.accountNumber,
    currency: pajFiatCurrency(org) || bank.currency || "NGN",
    amount: input.amountUsdc,
    chain: "ARC",
    mint: pajMint(),
    webhookURL: pajWebhookUrl(),
    description: "Custara withdraw",
  });

  const fundingAddress = (order.address || "").trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(fundingAddress)) {
    throw new Error("PAJ did not return an Arc funding address");
  }

  await addDestination({
    organizationId: input.organizationId,
    address: fundingAddress,
    label: "PAJ offramp",
    actorId: input.actorId,
  });

  await assertPayTimeGuards({
    organizationId: input.organizationId,
    rail: "paj_offramp",
    amount: input.amountUsdc,
    currency: "USDC",
    arcAddress: fundingAddress,
  });

  const intent = await prisma.paymentIntent.create({
    data: {
      organizationId: input.organizationId,
      invoiceId: null,
      kind: "paj_offramp",
      idempotencyKey: `paj_offramp_${order.id}`,
      status: "queued",
      rail: "paj_offramp",
      amount: input.amountUsdc,
      currency: "USDC",
      beneficiaryJson: JSON.stringify({
        rail: "paj_offramp",
        arcAddress: fundingAddress.toLowerCase(),
        bankCode: bank.bankCode,
        accountNumber: bank.accountNumber,
        accountName: bank.accountName,
        bank: order.bank,
        fiatAmount: order.fiatAmount ?? null,
        pajOrderId: order.id,
      }),
      providerRef: order.id,
      mode: org.paymentMode === "live" ? "live" : "sandbox",
    },
  });

  await enqueueAgentTask({
    organizationId: input.organizationId,
    type: "arc_transfer",
    paymentIntentId: intent.id,
    payload: { kind: "paj_offramp", pajOrderId: order.id },
  });

  await writeAudit({
    organizationId: input.organizationId,
    actorType: "user",
    actorId: input.actorId,
    action: "payment.paj_offramp_opened",
    entityType: "payment_intent",
    entityId: intent.id,
    metadata: { pajOrderId: order.id, amount: input.amountUsdc, bankAccountId: bank.id },
  });

  return { intent, bank, fundingAddress };
}

export async function handlePajWebhookPayload(payload: PajTransaction) {
  const orderId = payload.id;
  if (!orderId) return { handled: false, reason: "missing_id" };

  const intent = await prisma.paymentIntent.findFirst({
    where: { providerRef: orderId },
  });
  if (!intent) return { handled: false, reason: "unknown_order" };

  const status = mapPajStatus(payload.status);
  const txHash = pajArcTxHash(payload.signature) || intent.txHash;
  const usdc = Number(payload.usdcAmount || 0);
  const nextAmount = intent.kind === "paj_onramp" && usdc > 0 ? usdc : intent.amount;
  const nextCurrency = intent.kind === "paj_onramp" && usdc > 0 ? "USDC" : intent.currency;

  await prisma.paymentIntent.update({
    where: { id: intent.id },
    data: {
      status,
      txHash,
      failureReason: status === "failed" ? `PAJ ${payload.status || "ERROR"}` : null,
      amount: nextAmount,
      currency: nextCurrency,
    },
  });

  if (status === "completed") {
    if (intent.kind === "paj_onramp" && nextCurrency === "USDC" && nextAmount > 0) {
      await applyAgentDeposit({
        organizationId: intent.organizationId,
        paymentIntentId: intent.id,
        amount: nextAmount,
      });
      await syncWalletBalances(intent.organizationId, { trustIncrease: true }).catch(() => null);
    }
    await dispatchWebhook(intent.organizationId, "payment.completed", {
      id: intent.id,
      kind: intent.kind,
      paj_order_id: orderId,
      amount: nextAmount,
      currency: nextCurrency,
    });
  }
  if (status === "failed") {
    await dispatchWebhook(intent.organizationId, "payment.failed", {
      id: intent.id,
      kind: intent.kind,
      paj_order_id: orderId,
      error: `PAJ ${payload.status || "ERROR"}`,
    });
  }

  await writeAudit({
    organizationId: intent.organizationId,
    actorType: "system",
    action: "payment.paj_webhook",
    entityType: "payment_intent",
    entityId: intent.id,
    metadata: { pajOrderId: orderId, status: payload.status, mapped: status },
  });

  return { handled: true, intentId: intent.id, status };
}

function mapPajStatus(status?: string | null) {
  const raw = (status || "").toUpperCase();
  if (raw === "COMPLETED" || raw === "COMPLETE" || raw === "CONFIRMED") return "completed";
  if (raw === "ERROR" || raw === "FAILED" || raw === "CANCELLED") return "failed";
  if (raw === "PROCESSING" || raw === "PENDING" || raw === "PENDDING") return "pending_transfer";
  return "queued";
}
