import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { createPaymentIntent } from "@/domain/payment";
import { invoiceOpenAmount } from "@/domain/apLedger";
import { OPEN_INVOICE_STATUSES } from "@/domain/openInvoices";

export async function listPayRunCandidates(organizationId: string) {
  return prisma.invoice.findMany({
    where: {
      organizationId,
      status: "approved",
      NOT: { externalId: { startsWith: "odoo-refund:" } },
    },
    include: { vendor: true },
    orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }],
    take: 80,
  });
}

export async function createPayRun(input: {
  organizationId: string;
  actorId: string;
  items: Array<{ invoiceId: string; amount?: number }>;
}) {
  if (!input.items.length) throw new Error("Select at least one bill.");
  const invoices = await prisma.invoice.findMany({
    where: {
      organizationId: input.organizationId,
      id: { in: input.items.map((i) => i.invoiceId) },
      status: { in: [...OPEN_INVOICE_STATUSES, "approved"] },
    },
  });
  if (!invoices.length) throw new Error("No payable bills in that selection.");
  const run = await prisma.payRun.create({
    data: {
      organizationId: input.organizationId,
      status: "draft",
      createdById: input.actorId,
      items: {
        create: invoices.map((inv) => {
          const chosen = input.items.find((i) => i.invoiceId === inv.id);
          const amount = chosen?.amount && chosen.amount > 0 ? chosen.amount : invoiceOpenAmount(inv);
          return { invoiceId: inv.id, amount, currency: inv.currency };
        }),
      },
    },
    include: { items: true },
  });
  await writeAudit({
    organizationId: input.organizationId,
    actorType: "user",
    actorId: input.actorId,
    action: "pay_run.created",
    entityType: "pay_run",
    entityId: run.id,
    metadata: { count: run.items.length },
  });
  return run;
}

export async function executePayRun(input: {
  organizationId: string;
  payRunId: string;
  actorId: string;
  mfaCode?: string | null;
}) {
  const run = await prisma.payRun.findFirst({
    where: { id: input.payRunId, organizationId: input.organizationId },
    include: { items: true },
  });
  if (!run) throw new Error("Pay run not found.");
  if (run.status === "paid") return run;
  const results: Array<{ invoiceId: string; ok: boolean; error?: string }> = [];
  for (const item of run.items) {
    try {
      await createPaymentIntent({
        organizationId: input.organizationId,
        invoiceId: item.invoiceId,
        idempotencyKey: `payrun_${run.id}_${item.invoiceId}`,
        actorType: "user",
        actorId: input.actorId,
        mfaCode: input.mfaCode,
        amount: item.amount,
      });
      results.push({ invoiceId: item.invoiceId, ok: true });
    } catch (err) {
      results.push({
        invoiceId: item.invoiceId,
        ok: false,
        error: err instanceof Error ? err.message : "pay failed",
      });
    }
  }
  const paid = results.some((r) => r.ok);
  const updated = await prisma.payRun.update({
    where: { id: run.id },
    data: {
      status: paid && results.every((r) => r.ok) ? "paid" : paid ? "partial" : "failed",
      approvedAt: new Date(),
    },
  });
  await writeAudit({
    organizationId: input.organizationId,
    actorType: "user",
    actorId: input.actorId,
    action: "pay_run.executed",
    entityType: "pay_run",
    entityId: run.id,
    metadata: { results },
  });
  return updated;
}
