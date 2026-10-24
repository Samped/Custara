import { randomUUID } from "crypto";
import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { dispatchWebhook } from "@/lib/webhooks";
import { decryptField } from "@/lib/crypto";
import { putObject } from "@/lib/storage";
import { enqueueAgentTask } from "@/domain/arc/tasks";
import { ensureAgentWallet } from "@/domain/arc/wallets";
import { convertAmount } from "@/lib/currency";
import { quoteArcSettlement, refreshLiveFxBook } from "@/domain/fx/liveQuote";
import { assertFiscalUnlocked, invoiceOpenAmount, listOpenVendorCredits } from "@/domain/apLedger";
import { describePlatformFee } from "@/domain/platformFee";

export type PaymentAdapterResult = {
  status: "exported" | "submitted" | "failed" | "queued";
  providerRef: string;
  exportPath?: string;
  raw?: Record<string, unknown>;
};

/** Nigeria partner sandbox adapter — export-only sales boundary unless NIGERIA_PAYMENT_LIVE=true. No live bank movement by default. */
export async function nigeriaSandboxAdapter(input: {
  organizationId: string;
  intentId: string;
  amount: number;
  currency: string;
  beneficiary: Record<string, unknown>;
  invoiceNumber?: string | null;
  mode: "sandbox" | "live";
}): Promise<PaymentAdapterResult> {
  if (input.mode === "live" && process.env.NIGERIA_PAYMENT_LIVE !== "true") {
    throw new Error("Live Nigeria rail disabled. Set NIGERIA_PAYMENT_LIVE=true and complete partner onboarding.");
  }

  const providerRef = `ng_sbx_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
  const exportRel = `${input.organizationId}/exports/${input.intentId}.json`;
  const payload = {
    adapter: "nigeria_sandbox",
    mode: input.mode,
    provider_ref: providerRef,
    payment_intent_id: input.intentId,
    amount: input.amount,
    currency: input.currency,
    invoice_number: input.invoiceNumber,
    beneficiary: input.beneficiary,
    created_at: new Date().toISOString(),
    instruction:
      input.mode === "sandbox"
        ? "Sandbox only — no funds moved. Hand-off file ready for partner rail."
        : "Live hand-off — execute via licensed partner API.",
  };

  await putObject(exportRel, JSON.stringify(payload, null, 2), "application/json");

  const csvRel = `${input.organizationId}/exports/${input.intentId}.csv`;
  const b = input.beneficiary;
  const csv = [
    "payment_intent_id,provider_ref,invoice_number,vendor,account_name,account_last4,bank_name,bank_code,amount,currency,mode",
    [
      input.intentId,
      providerRef,
      input.invoiceNumber || "",
      b.vendorName || "",
      b.accountName || "",
      b.accountNumberLast4 || "",
      b.bankName || "",
      b.bankCode || "",
      input.amount,
      input.currency,
      input.mode,
    ]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(","),
  ].join("\n");
  await putObject(csvRel, csv, "text/csv");

  return {
    status: "exported",
    providerRef,
    exportPath: csvRel,
    raw: payload,
  };
}

function pickActiveEndpoint(
  endpoints: Array<{
    isActive: boolean;
    endpointType: string;
    version: number;
    arcAddress: string | null;
    accountName: string;
    accountNumberEncrypted: string;
    accountNumberLast4: string;
    bankName: string | null;
    bankCode: string | null;
    currency: string;
  }>,
) {
  const active = endpoints.filter((e) => e.isActive).sort((a, b) => b.version - a.version);
  const arc = active.find((e) => e.endpointType === "arc_usdc" && e.arcAddress);
  const bank = active.find((e) => e.endpointType === "bank");
  return { arc, bank, preferred: arc || bank || active[0] };
}

export async function createPaymentIntent(input: {
  organizationId: string;
  invoiceId: string;
  idempotencyKey: string;
  rail?: string;
  actorType: "user" | "system" | "api_key";
  actorId?: string;
  requestId?: string;
  mfaCode?: string | null;
  apiStepUpToken?: string | null;
  amount?: number | null;
}) {
  const existing = await prisma.paymentIntent.findUnique({
    where: {
      organizationId_idempotencyKey: {
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey,
      },
    },
  });
  if (existing) return existing;

  const org = await prisma.organization.findUniqueOrThrow({ where: { id: input.organizationId } });
  const invoice = await prisma.invoice.findFirst({
    where: { id: input.invoiceId, organizationId: input.organizationId },
    include: {
      vendor: { include: { endpoints: { where: { isActive: true }, orderBy: { version: "desc" } } } },
      extraction: true,
      approvalRequests: { orderBy: { createdAt: "desc" }, take: 1, include: { decisions: true } },
      risks: true,
    },
  });

  if (!invoice) throw new Error("Invoice not found");
  if (invoice.status !== "approved" && invoice.status !== "payment_queued") {
    throw new Error(`Invoice status ${invoice.status} cannot create payment intent`);
  }
  if (!invoice.totalAmount || invoice.totalAmount <= 0) {
    throw new Error("Invoice amount missing");
  }
  assertFiscalUnlocked(invoice);
  const residual = invoiceOpenAmount(invoice);
  if (residual <= 0.01) {
    throw new Error("Nothing left to pay on this bill.");
  }
  const ledgerPay =
    input.amount != null && Number.isFinite(input.amount) && input.amount > 0
      ? Math.min(input.amount, residual)
      : residual;
  if (ledgerPay <= 0.01) throw new Error("Payment amount is too small.");
  let odooMeta: { odooMoveType?: string; odooPaymentState?: string; odooResidual?: number } = {};
  try {
    odooMeta = invoice.extraction?.rawJson ? JSON.parse(invoice.extraction.rawJson) : {};
  } catch {
    odooMeta = {};
  }
  if (odooMeta.odooMoveType === "in_refund") {
    throw new Error("This Odoo document is a vendor credit. Apply it to a bill instead of paying.");
  }
  if (odooMeta.odooPaymentState === "paid" || (odooMeta.odooResidual != null && odooMeta.odooResidual <= 0.01)) {
    throw new Error("Odoo already shows this bill as paid.");
  }
  if (invoice.vendorId && !invoice.creditWaivedAt && (invoice.creditApplied || 0) <= 0.01) {
    const openCredits = await listOpenVendorCredits(input.organizationId, invoice.vendorId);
    if (openCredits.length) {
      throw new Error(
        `Vendor has an open credit (${openCredits[0].invoiceNumber || openCredits[0].externalId}). Apply or waive it before paying.`,
      );
    }
  }

  await refreshLiveFxBook();
  const { assertPayStepUp } = await import("@/domain/payStepUp");
  await assertPayStepUp({
    organizationId: input.organizationId,
    actorType: input.actorType,
    actorId: input.actorId,
    amountUsd: convertAmount(ledgerPay, invoice.currency, "USD"),
    mfaCode: input.mfaCode,
    apiStepUpToken: input.apiStepUpToken,
  });

  const latestApproval = invoice.approvalRequests[0];
  if (latestApproval && latestApproval.status !== "approved") {
    throw new Error("Invoice approval is not complete");
  }

  const { arc, bank, preferred } = pickActiveEndpoint(invoice.vendor?.endpoints || []);
  const useArc =
    input.rail === "arc_usdc" ||
    (!input.rail && Boolean(arc)) ||
    (input.rail !== "nigeria_sandbox" && input.rail !== "nigeria_export" && Boolean(arc));

  const rail =
    input.rail === "nigeria_sandbox" || input.rail === "nigeria_export"
      ? input.rail
      : useArc
        ? "arc_usdc"
        : input.rail || "nigeria_sandbox";

  // Sales boundary: Nigeria rail is export/sandbox unless NIGERIA_PAYMENT_LIVE=true
  if (
    (rail === "nigeria_sandbox" || rail === "nigeria_export") &&
    org.paymentMode === "live" &&
    process.env.NIGERIA_PAYMENT_LIVE !== "true"
  ) {
    throw new Error(
      "Nigeria rail is export-only in this deployment. Use Arc USDC for live settlement, or set NIGERIA_PAYMENT_LIVE=true after partner onboarding.",
    );
  }

  const mode = org.paymentMode === "live" ? "live" : "sandbox";

  let beneficiary: Record<string, unknown>;
  const arcSettlement =
    rail === "arc_usdc"
      ? await quoteArcSettlement(ledgerPay, invoice.currency, { fresh: true })
      : null;
  if (arcSettlement && !arcSettlement.quoted) {
    throw new Error(
      "Live FX quote unavailable. Custara will not invent a naira/USDC rate. Retry when Circle or Coinbase responds.",
    );
  }

  if (rail === "arc_usdc") {
    const arcAddress = arc?.arcAddress;
    if (!arcAddress) {
      throw new Error("Arc USDC rail requires an active vendor arc_usdc endpoint");
    }
    const settlement = arcSettlement!;
    const { assertArcPaymentsAllowed } = await import("@/domain/arc/config");
    assertArcPaymentsAllowed(mode);

    await ensureAgentWallet({
      organizationId: input.organizationId,
      actorType: input.actorType,
      actorId: input.actorId,
    });
    const { assertDestinationAllowed } = await import("@/domain/arc/allowlist");
    await assertDestinationAllowed(input.organizationId, arcAddress);

    const { assertPayTimeGuards } = await import("@/domain/payGuards");
    await assertPayTimeGuards({
      organizationId: input.organizationId,
      invoiceId: invoice.id,
      rail,
      amount: settlement.amount,
      currency: settlement.currency,
      arcAddress,
    });

    beneficiary = {
      vendorId: invoice.vendorId,
      vendorName: invoice.vendor?.name || invoice.extraction?.vendorName,
      arcAddress: arcAddress.toLowerCase(),
      endpointType: "arc_usdc",
      currency: settlement.currency,
      sourceAmount: settlement.sourceAmount,
      sourceCurrency: settlement.sourceCurrency,
      fxUnitsPerUsd: settlement.unitsPerUsd,
      fxSource: settlement.source,
      fxFetchedAt: settlement.fetchedAt,
      fxQuoteId: settlement.quoteId,
      frozenAt: new Date().toISOString(),
    };
  } else {
    const endpoint = bank || preferred;
    let accountNumber: string | null = null;
    let accountLast4: string | null = null;
    if (endpoint && endpoint.endpointType !== "arc_usdc") {
      accountNumber = decryptField(endpoint.accountNumberEncrypted);
      accountLast4 = endpoint.accountNumberLast4;
    } else if (invoice.extraction?.accountNumberEncrypted) {
      accountNumber = decryptField(invoice.extraction.accountNumberEncrypted);
      accountLast4 = invoice.extraction.accountNumberLast4;
    }
    beneficiary = {
      vendorId: invoice.vendorId,
      vendorName: invoice.vendor?.name || invoice.extraction?.vendorName,
      accountName: endpoint?.accountName || invoice.extraction?.accountName,
      accountNumberLast4: accountLast4,
      accountNumberEncrypted: endpoint?.accountNumberEncrypted || invoice.extraction?.accountNumberEncrypted,
      bankName: endpoint?.bankName || invoice.extraction?.bankName,
      bankCode: endpoint?.bankCode || invoice.extraction?.bankCode,
      currency: invoice.currency,
      frozenAt: new Date().toISOString(),
      _accountNumber: accountNumber,
      exportOnly: true,
      salesBoundary: "nigeria_export_sandbox",
    };
    if (!accountNumber || !beneficiary.accountName) {
      throw new Error("Missing beneficiary bank details");
    }

    const { assertPayTimeGuards } = await import("@/domain/payGuards");
    await assertPayTimeGuards({
      organizationId: input.organizationId,
      invoiceId: invoice.id,
      rail,
      amount: ledgerPay,
      currency: invoice.currency,
    });
  }

  const nextResidual = Math.max(0, residual - ledgerPay);
  const fee =
    rail === "arc_usdc" && arcSettlement ? describePlatformFee(arcSettlement.amount) : null;
  const intent = await prisma.paymentIntent.create({
    data: {
      organizationId: input.organizationId,
      invoiceId: invoice.id,
      idempotencyKey: input.idempotencyKey,
      status: "queued",
      rail,
      amount: arcSettlement?.amount ?? ledgerPay,
      currency: arcSettlement?.currency ?? invoice.currency,
      beneficiaryJson: JSON.stringify({
        ...beneficiary,
        _accountNumber: undefined,
        accountNumber: undefined,
      }),
      mode,
      ...(fee && fee.feeAmount > 0 ? { feeAmount: fee.feeAmount, feeBps: fee.feeBps } : {}),
    },
  });

  await prisma.invoice.update({
    where: { id: invoice.id },
    data: {
      residualAmount: nextResidual,
      status: nextResidual <= 0.01 ? "payment_queued" : "approved",
    },
  });

  try {
    if (rail === "arc_usdc") {
      const task = await enqueueAgentTask({
        organizationId: input.organizationId,
        type: "arc_transfer",
        paymentIntentId: intent.id,
        payload: { invoiceId: invoice.id },
      });

      const current = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } });
      const settled = current.status === "completed" || current.status === "failed";
      const accepted = Boolean(current.circleTxId) || current.status === "pending_transfer";
      const updated = await prisma.paymentIntent.update({
        where: { id: intent.id },
        data: {
          status: settled ? current.status : accepted ? "pending_transfer" : current.status,
          providerRef: current.circleTxId || current.providerRef || task.id,
        },
      });

      await writeAudit({
        organizationId: input.organizationId,
        actorType: input.actorType,
        actorId: input.actorId,
        action: "payment.intent_created",
        entityType: "payment_intent",
        entityId: intent.id,
        requestId: input.requestId,
        metadata: {
          invoiceId: invoice.id,
          rail,
          mode,
          agentTaskId: task.id,
          idempotencyKey: input.idempotencyKey,
          fxSource: arcSettlement?.source,
          fxUnitsPerUsd: arcSettlement?.unitsPerUsd,
          fxFetchedAt: arcSettlement?.fetchedAt,
        },
      });

      await dispatchWebhook(input.organizationId, "payment.intent_created", {
        id: intent.id,
        invoice_id: invoice.id,
        status: updated.status,
        rail,
        mode,
        agent_task_id: task.id,
      });

      return updated;
    }

    const accountNumber = beneficiary._accountNumber as string;
    const adapterResult = await nigeriaSandboxAdapter({
      organizationId: input.organizationId,
      intentId: intent.id,
      amount: intent.amount,
      currency: intent.currency,
      invoiceNumber: invoice.invoiceNumber,
      mode,
      beneficiary: {
        ...beneficiary,
        accountNumber,
      },
    });

    const updated = await prisma.paymentIntent.update({
      where: { id: intent.id },
      data: {
        status: adapterResult.status === "failed" ? "failed" : "exported",
        exportPath: adapterResult.exportPath,
        providerRef: adapterResult.providerRef,
        failureReason: adapterResult.status === "failed" ? "Adapter failed" : null,
      },
    });

    await prisma.invoice.update({
      where: { id: invoice.id },
      data: {
        status:
          updated.status === "exported"
            ? "payment_sent"
            : updated.status === "failed"
              ? "payment_failed"
              : "payment_queued",
      },
    });

    await writeAudit({
      organizationId: input.organizationId,
      actorType: input.actorType,
      actorId: input.actorId,
      action: "payment.intent_created",
      entityType: "payment_intent",
      entityId: intent.id,
      requestId: input.requestId,
      metadata: {
        invoiceId: invoice.id,
        rail,
        mode,
        providerRef: adapterResult.providerRef,
        idempotencyKey: input.idempotencyKey,
        exportOnly: true,
      },
    });

    await dispatchWebhook(input.organizationId, "payment.intent_created", {
      id: intent.id,
      invoice_id: invoice.id,
      status: updated.status,
      rail,
      mode,
      provider_ref: adapterResult.providerRef,
    });
    await dispatchWebhook(input.organizationId, "payment.executed", {
      id: intent.id,
      invoice_id: invoice.id,
      status: updated.status,
      export_path: adapterResult.exportPath,
      provider_ref: adapterResult.providerRef,
    });

    if (updated.status === "exported") {
      const { writeOdooPaymentBack } = await import("@/domain/connectors/odoo");
      await writeOdooPaymentBack({
        organizationId: input.organizationId,
        invoiceId: invoice.id,
        paymentIntentId: intent.id,
        amount: intent.amount,
        currency: intent.currency,
      });
    }

    return updated;
  } catch (e) {
    const message = e instanceof Error ? e.message : "Payment adapter error";
    await prisma.paymentIntent.update({
      where: { id: intent.id },
      data: { status: "failed", failureReason: message },
    });
    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { status: nextResidual <= 0.01 ? "payment_failed" : "approved", residualAmount: residual },
    });
    await dispatchWebhook(input.organizationId, "payment.failed", {
      id: intent.id,
      invoice_id: invoice.id,
      error: message,
    });
    throw e instanceof Error ? e : new Error(message);
  }
}
