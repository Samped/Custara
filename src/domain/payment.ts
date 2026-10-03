import { randomUUID } from "crypto";
import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { dispatchWebhook } from "@/lib/webhooks";
import { decryptField } from "@/lib/crypto";
import { putObject } from "@/lib/storage";
import { enqueueAgentTask } from "@/domain/arc/tasks";
import { ensureAgentWallet } from "@/domain/arc/wallets";

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

  const { assertPayStepUp } = await import("@/domain/payStepUp");
  await assertPayStepUp({
    organizationId: input.organizationId,
    actorType: input.actorType,
    actorId: input.actorId,
    mfaCode: input.mfaCode,
    apiStepUpToken: input.apiStepUpToken,
  });

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

  if (rail === "arc_usdc") {
    const arcAddress = arc?.arcAddress;
    if (!arcAddress) {
      throw new Error("Arc USDC rail requires an active vendor arc_usdc endpoint");
    }
    if (invoice.currency !== "USDC" && invoice.currency !== "USD") {
      throw new Error(`Arc rail requires USDC invoice currency (got ${invoice.currency})`);
    }
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
      amount: invoice.totalAmount,
      currency: invoice.currency,
      arcAddress,
    });

    beneficiary = {
      vendorId: invoice.vendorId,
      vendorName: invoice.vendor?.name || invoice.extraction?.vendorName,
      arcAddress: arcAddress.toLowerCase(),
      endpointType: "arc_usdc",
      currency: invoice.currency === "USD" ? "USDC" : invoice.currency,
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
      amount: invoice.totalAmount,
      currency: invoice.currency,
    });
  }

  const intent = await prisma.paymentIntent.create({
    data: {
      organizationId: input.organizationId,
      invoiceId: invoice.id,
      idempotencyKey: input.idempotencyKey,
      status: "queued",
      rail,
      amount: invoice.totalAmount,
      currency: rail === "arc_usdc" ? "USDC" : invoice.currency,
      beneficiaryJson: JSON.stringify({
        ...beneficiary,
        _accountNumber: undefined,
        accountNumber: undefined,
      }),
      mode,
    },
  });

  await prisma.invoice.update({
    where: { id: invoice.id },
    data: { status: "payment_queued" },
  });

  try {
    if (rail === "arc_usdc") {
      const task = await enqueueAgentTask({
        organizationId: input.organizationId,
        type: "arc_transfer",
        paymentIntentId: intent.id,
        payload: { invoiceId: invoice.id },
      });

      const updated = await prisma.paymentIntent.update({
        where: { id: intent.id },
        data: {
          status: "pending_transfer",
          providerRef: task.id,
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

    return updated;
  } catch (e) {
    const message = e instanceof Error ? e.message : "Payment adapter error";
    await prisma.paymentIntent.update({
      where: { id: intent.id },
      data: { status: "failed", failureReason: message },
    });
    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { status: "payment_failed" },
    });
    await dispatchWebhook(input.organizationId, "payment.failed", {
      id: intent.id,
      invoice_id: invoice.id,
      error: message,
    });
    throw e instanceof Error ? e : new Error(message);
  }
}
