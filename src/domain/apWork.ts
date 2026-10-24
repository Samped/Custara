import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { ingestInvoice } from "@/domain/ingest";
import { runInvoicePipeline } from "@/domain/pipeline";

export async function addInvoiceComment(input: {
  organizationId: string;
  invoiceId: string;
  authorId?: string;
  body: string;
}) {
  const body = input.body.trim();
  if (!body) throw new Error("Comment is required.");
  const invoice = await prisma.invoice.findFirst({
    where: { id: input.invoiceId, organizationId: input.organizationId },
    select: { id: true, externalId: true },
  });
  if (!invoice) throw new Error("Invoice not found.");
  let postedToOdoo = false;
  if (invoice.externalId?.startsWith("odoo:")) {
    try {
      const { writeOdooChatter } = await import("@/domain/connectors/odoo");
      postedToOdoo = await writeOdooChatter({
        organizationId: input.organizationId,
        invoiceId: invoice.id,
        body: `Custara: ${body}`,
      });
    } catch {
      postedToOdoo = false;
    }
  }
  const comment = await prisma.invoiceComment.create({
    data: {
      organizationId: input.organizationId,
      invoiceId: invoice.id,
      authorId: input.authorId || null,
      body,
      postedToOdoo,
    },
  });
  await writeAudit({
    organizationId: input.organizationId,
    actorType: "user",
    actorId: input.authorId,
    action: "invoice.commented",
    entityType: "invoice",
    entityId: invoice.id,
  });
  return comment;
}

export async function addInvoiceActivity(input: {
  organizationId: string;
  invoiceId: string;
  title: string;
  dueAt?: Date | null;
  assigneeId?: string | null;
  actorId?: string;
}) {
  const title = input.title.trim();
  if (!title) throw new Error("Activity title is required.");
  const invoice = await prisma.invoice.findFirst({
    where: { id: input.invoiceId, organizationId: input.organizationId },
    select: { id: true },
  });
  if (!invoice) throw new Error("Invoice not found.");
  const activity = await prisma.invoiceActivity.create({
    data: {
      organizationId: input.organizationId,
      invoiceId: invoice.id,
      title,
      dueAt: input.dueAt || null,
      assigneeId: input.assigneeId || null,
    },
  });
  await writeAudit({
    organizationId: input.organizationId,
    actorType: "user",
    actorId: input.actorId,
    action: "invoice.activity_added",
    entityType: "invoice",
    entityId: invoice.id,
    metadata: { title },
  });
  return activity;
}

export async function completeInvoiceActivity(input: {
  organizationId: string;
  activityId: string;
  actorId?: string;
}) {
  const activity = await prisma.invoiceActivity.findFirst({
    where: { id: input.activityId, organizationId: input.organizationId },
  });
  if (!activity) throw new Error("Activity not found.");
  return prisma.invoiceActivity.update({
    where: { id: activity.id },
    data: { status: "done", completedAt: new Date() },
  });
}

export async function setInvoiceHoldReason(input: {
  organizationId: string;
  invoiceId: string;
  holdReason: string;
  actorId?: string;
}) {
  const holdReason = input.holdReason.trim();
  const invoice = await prisma.invoice.findFirst({
    where: { id: input.invoiceId, organizationId: input.organizationId },
  });
  if (!invoice) throw new Error("Invoice not found.");
  const next = await prisma.invoice.update({
    where: { id: invoice.id },
    data: {
      holdReason: holdReason || null,
      status: holdReason && !["payment_sent", "reconciled", "settled", "void"].includes(invoice.status)
        ? "on_hold"
        : invoice.status,
    },
  });
  await writeAudit({
    organizationId: input.organizationId,
    actorType: "user",
    actorId: input.actorId,
    action: "invoice.hold_set",
    entityType: "invoice",
    entityId: invoice.id,
    metadata: { holdReason },
  });
  return next;
}

export async function spawnRecurringInvoice(input: {
  organizationId: string;
  invoiceId: string;
  actorId?: string;
}) {
  const source = await prisma.invoice.findFirst({
    where: { id: input.invoiceId, organizationId: input.organizationId },
    include: { extraction: true },
  });
  if (!source?.recurringInterval) throw new Error("This bill is not marked recurring.");
  const days = source.recurringInterval === "weekly" ? 7 : 30;
  const nextDue = source.dueDate
    ? new Date(source.dueDate.getTime() + days * 86_400_000)
    : new Date(Date.now() + days * 86_400_000);
  const payload = source.extraction?.rawJson ? JSON.parse(source.extraction.rawJson) : {};
  const invoice = await ingestInvoice({
    organizationId: input.organizationId,
    actorType: "system",
    actorId: input.actorId || "recurring",
    source: "accounting",
    externalId: source.externalId ? `${source.externalId}:r${nextDue.toISOString().slice(0, 10)}` : null,
    currency: source.currency,
    structuredPayload: {
      ...payload,
      invoice_number: `${source.invoiceNumber || "REC"}-${nextDue.toISOString().slice(0, 10)}`,
      due_date: nextDue.toISOString().slice(0, 10),
      issue_date: new Date().toISOString().slice(0, 10),
    },
    filename: `recurring-${source.id}.json`,
    enqueue: false,
  });
  await prisma.invoice.update({
    where: { id: invoice.id },
    data: {
      vendorId: source.vendorId,
      residualAmount: source.totalAmount,
      paymentTerm: source.paymentTerm,
      recurringInterval: source.recurringInterval,
    },
  });
  await runInvoicePipeline(invoice.id, { type: "system", id: input.actorId || "recurring" });
  return invoice;
}

export async function spawnDueRecurringInvoices() {
  const sources = await prisma.invoice.findMany({
    where: {
      recurringInterval: { in: ["monthly", "weekly"] },
      status: { in: ["approved", "payment_sent", "reconciled", "settled"] },
    },
    take: 40,
  });
  const created: string[] = [];
  for (const source of sources) {
    const days = source.recurringInterval === "weekly" ? 7 : 30;
    const nextDue = source.dueDate
      ? new Date(source.dueDate.getTime() + days * 86_400_000)
      : null;
    if (!nextDue || nextDue > new Date()) continue;
    const stamp = nextDue.toISOString().slice(0, 10);
    const exists = await prisma.invoice.findFirst({
      where: {
        organizationId: source.organizationId,
        invoiceNumber: `${source.invoiceNumber || "REC"}-${stamp}`,
      },
    });
    if (exists) continue;
    try {
      const next = await spawnRecurringInvoice({
        organizationId: source.organizationId,
        invoiceId: source.id,
      });
      created.push(next.id);
    } catch {
      /* skip a single failure */
    }
  }
  return created;
}
