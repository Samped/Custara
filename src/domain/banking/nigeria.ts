import { createHmac, timingSafeEqual } from "crypto";
import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { reconcileSettlement } from "@/domain/cash";

/**
 * Nigeria open-banking / payment provider webhooks → settlement reconcile.
 * Supports Paystack + Mono-style payment references matched to invoice numbers.
 */
export async function ensureBankingConnectors(organizationId: string) {
  await prisma.integrationConnector.upsert({
    where: { organizationId_type: { organizationId, type: "banking_paystack" } },
    create: {
      organizationId,
      type: "banking_paystack",
      name: "Paystack payment references",
      status: process.env.PAYSTACK_SECRET_KEY ? "connected" : "disconnected",
      configJson: JSON.stringify({ role: "reconcile_only" }),
      secretsJson: "{}",
    },
    update: {
      status: process.env.PAYSTACK_SECRET_KEY ? "connected" : "disconnected",
    },
  });

  await prisma.integrationConnector.upsert({
    where: { organizationId_type: { organizationId, type: "banking_mono" } },
    create: {
      organizationId,
      type: "banking_mono",
      name: "Mono open banking",
      status: process.env.MONO_SECRET_KEY ? "connected" : "disconnected",
      configJson: JSON.stringify({ role: "reconcile_only" }),
      secretsJson: "{}",
    },
    update: {
      status: process.env.MONO_SECRET_KEY ? "connected" : "disconnected",
    },
  });
}

function safeEqual(a: string, b: string) {
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

export function verifyPaystackSignature(rawBody: string, signature: string | null) {
  const secret = (process.env.PAYSTACK_SECRET_KEY || "").trim();
  if (!secret || !signature) return false;
  const hash = createHmac("sha512", secret).update(rawBody).digest("hex");
  return safeEqual(hash, signature);
}

export function verifyMonoWebhook(signature: string | null) {
  const expected = (process.env.MONO_WEBHOOK_SECRET || "").trim();
  if (!expected) return Boolean(process.env.MONO_SECRET_KEY);
  return Boolean(signature && safeEqual(signature, expected));
}

export async function reconcileFromPaymentReference(input: {
  organizationId: string;
  provider: "paystack" | "mono" | "okra";
  reference: string;
  amount: number;
  currency?: string;
  invoiceNumber?: string;
  metadata?: Record<string, unknown>;
}) {
  const inv = await prisma.invoice.findFirst({
    where: {
      organizationId: input.organizationId,
      OR: [
        input.invoiceNumber ? { invoiceNumber: input.invoiceNumber } : undefined,
        { externalId: input.reference },
        { id: input.reference },
      ].filter(Boolean) as Array<{ invoiceNumber?: string; externalId?: string; id?: string }>,
      status: { in: ["approved", "payment_queued", "payment_sent", "pending_approval"] },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!inv) {
    return { reconciled: false, reason: "invoice_not_found" as const };
  }

  const existing = await prisma.settlement.findFirst({
    where: { invoiceId: inv.id, reference: `${input.provider}:${input.reference}` },
  });
  if (existing) return { reconciled: false, reason: "already_settled" as const };

  await reconcileSettlement({
    organizationId: input.organizationId,
    invoiceId: inv.id,
    amount: input.amount,
    currency: input.currency || inv.currency,
    reference: `${input.provider}:${input.reference}`,
    actorType: "system",
  });

  await writeAudit({
    organizationId: input.organizationId,
    actorType: "system",
    action: `banking.${input.provider}_reconciled`,
    entityType: "invoice",
    entityId: inv.id,
    metadata: { reference: input.reference, ...(input.metadata || {}) },
  });

  return { reconciled: true, invoiceId: inv.id, reason: null };
}

export async function handlePaystackEvent(organizationId: string, event: {
  event?: string;
  data?: {
    reference?: string;
    amount?: number;
    currency?: string;
    metadata?: { invoice_number?: string; invoice_id?: string };
  };
}) {
  if (event.event !== "charge.success" && event.event !== "transfer.success") {
    return { ignored: true };
  }
  const data = event.data || {};
  const amount = Number(data.amount || 0) / 100; // Paystack kobo
  return reconcileFromPaymentReference({
    organizationId,
    provider: "paystack",
    reference: data.reference || "",
    amount,
    currency: data.currency || "NGN",
    invoiceNumber: data.metadata?.invoice_number,
    metadata: { event: event.event },
  });
}

export async function handleMonoEvent(organizationId: string, event: {
  event?: string;
  data?: {
    reference?: string;
    amount?: number;
    narration?: string;
    currency?: string;
  };
}) {
  if (!/debit|credit|payment/i.test(event.event || "")) {
    return { ignored: true };
  }
  const data = event.data || {};
  const narration = data.narration || "";
  const invoiceGuess = narration.match(/INV[\-_]?[A-Z0-9]+/i)?.[0];
  return reconcileFromPaymentReference({
    organizationId,
    provider: "mono",
    reference: data.reference || `mono-${Date.now()}`,
    amount: Number(data.amount || 0),
    currency: data.currency || "NGN",
    invoiceNumber: invoiceGuess,
    metadata: { event: event.event, narration },
  });
}
