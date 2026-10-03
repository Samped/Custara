import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { dispatchWebhook } from "@/lib/webhooks";

export async function getCashForecast(organizationId: string) {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
  const now = new Date();
  const in7 = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const in30 = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const openStatuses = ["approved", "pending_approval", "needs_review", "payment_queued", "received", "extracting"];
  const invoices = await prisma.invoice.findMany({
    where: {
      organizationId,
      status: { in: openStatuses },
      totalAmount: { not: null },
    },
  });

  const due7 = invoices.filter((i) => i.dueDate && i.dueDate <= in7);
  const due30 = invoices.filter((i) => i.dueDate && i.dueDate <= in30);
  const sum = (rows: typeof invoices) => rows.reduce((acc, i) => acc + (i.totalAmount || 0), 0);

  const obligations7d = sum(due7.length ? due7 : invoices.filter((i) => !i.dueDate).slice(0, 3));
  const obligations30d = sum(due30.length ? due30 : invoices);

  const gap7 = obligations7d - org.expectedInflow7d;
  const gap30 = obligations30d - org.expectedInflow30d;

  const { listSuggestedPays } = await import("@/domain/timing");
  const suggested = await listSuggestedPays(organizationId);

  return {
    currency: "NGN",
    obligations_7d: obligations7d,
    obligations_30d: obligations30d,
    expected_inflow_7d: org.expectedInflow7d,
    expected_inflow_30d: org.expectedInflow30d,
    funding_gap_7d: gap7,
    funding_gap_30d: gap30,
    recommendation:
      gap7 > 0
        ? "Funding gap in 7 days — defer non-critical approved pays or accelerate collections."
        : "7-day cash position looks covered under current expected inflows.",
    invoice_count_open: invoices.length,
    suggested_pays: suggested.map((i) => ({
      id: i.id,
      vendor: i.vendor?.name || null,
      amount: i.totalAmount,
      currency: i.currency,
      recommended_pay_date: i.recommendedPayDate?.toISOString() || null,
      pay_timing_reason: i.payTimingReason,
      due_date: i.dueDate?.toISOString() || null,
    })),
    auto_pay_enabled: org.autoPayEnabled,
  };
}

export async function reconcileSettlement(input: {
  organizationId: string;
  invoiceId: string;
  amount: number;
  currency?: string;
  reference?: string;
  paymentIntentId?: string;
  actorType: "user" | "system" | "api_key";
  actorId?: string;
}) {
  const invoice = await prisma.invoice.findFirst({
    where: { id: input.invoiceId, organizationId: input.organizationId },
  });
  if (!invoice) throw new Error("Invoice not found");

  const settlement = await prisma.settlement.create({
    data: {
      organizationId: input.organizationId,
      invoiceId: input.invoiceId,
      paymentIntentId: input.paymentIntentId || null,
      amount: input.amount,
      currency: input.currency || invoice.currency,
      reference: input.reference || null,
    },
  });

  await prisma.invoice.update({
    where: { id: invoice.id },
    data: { status: "reconciled" },
  });

  await writeAudit({
    organizationId: input.organizationId,
    actorType: input.actorType,
    actorId: input.actorId,
    action: "invoice.reconciled",
    entityType: "settlement",
    entityId: settlement.id,
    metadata: { invoiceId: invoice.id, amount: input.amount },
  });

  await dispatchWebhook(input.organizationId, "invoice.reconciled", {
    invoice_id: invoice.id,
    settlement_id: settlement.id,
    amount: input.amount,
  });

  return settlement;
}
