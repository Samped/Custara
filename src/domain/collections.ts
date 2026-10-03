import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { dispatchWebhook } from "@/lib/webhooks";

export async function upsertCustomer(input: {
  organizationId: string;
  name: string;
  email?: string | null;
  externalId?: string | null;
}) {
  const name = input.name.trim();
  if (!name) throw new Error("Customer name required");
  if (input.externalId) {
    return prisma.customer.upsert({
      where: {
        organizationId_externalId: {
          organizationId: input.organizationId,
          externalId: input.externalId,
        },
      },
      create: {
        organizationId: input.organizationId,
        name,
        email: input.email?.trim() || null,
        externalId: input.externalId,
      },
      update: { name, email: input.email?.trim() || null },
    });
  }
  const existing = await prisma.customer.findFirst({
    where: { organizationId: input.organizationId, name: { equals: name } },
  });
  if (existing) {
    return prisma.customer.update({
      where: { id: existing.id },
      data: { email: input.email?.trim() || existing.email },
    });
  }
  return prisma.customer.create({
    data: {
      organizationId: input.organizationId,
      name,
      email: input.email?.trim() || null,
    },
  });
}

export async function createReceivable(input: {
  organizationId: string;
  customerId: string;
  amount: number;
  currency?: string;
  invoiceNumber?: string | null;
  dueDate?: Date | null;
  issueDate?: Date | null;
  notes?: string | null;
  actorId?: string;
}) {
  const customer = await prisma.customer.findFirst({
    where: { id: input.customerId, organizationId: input.organizationId },
  });
  if (!customer) throw new Error("Customer not found");
  if (!(input.amount > 0)) throw new Error("Amount required");

  const priority = Math.min(
    100,
    Math.max(10, Math.round(100 - customer.behaviorScore + (input.dueDate && input.dueDate < new Date() ? 20 : 0))),
  );

  const row = await prisma.receivable.create({
    data: {
      organizationId: input.organizationId,
      customerId: customer.id,
      amount: input.amount,
      currency: (input.currency || "NGN").toUpperCase(),
      invoiceNumber: input.invoiceNumber || null,
      dueDate: input.dueDate || null,
      issueDate: input.issueDate || null,
      notes: input.notes || null,
      priority,
      status: "open",
    },
  });

  await writeAudit({
    organizationId: input.organizationId,
    actorType: "user",
    actorId: input.actorId,
    action: "receivable.created",
    entityType: "receivable",
    entityId: row.id,
  });

  return row;
}

/** Recompute customer behavior from paid receivables (days-to-pay). */
export async function recomputeCustomerBehavior(customerId: string) {
  const paid = await prisma.receivable.findMany({
    where: { customerId, status: "paid", paidAt: { not: null }, issueDate: { not: null } },
    take: 50,
    orderBy: { paidAt: "desc" },
  });
  if (!paid.length) return null;
  const days = paid.map((r) => {
    const issue = r.issueDate!.getTime();
    const paidAt = r.paidAt!.getTime();
    return Math.max(0, (paidAt - issue) / 864e5);
  });
  const avg = days.reduce((a, b) => a + b, 0) / days.length;
  // Score: pay in 0 days = 100, 60+ days = ~20
  const behaviorScore = Math.max(5, Math.min(100, Math.round(100 - avg * 1.3)));
  return prisma.customer.update({
    where: { id: customerId },
    data: { avgDaysToPay: avg, behaviorScore },
  });
}

export async function markReceivablePaid(input: {
  organizationId: string;
  receivableId: string;
  actorId?: string;
}) {
  const row = await prisma.receivable.findFirst({
    where: { id: input.receivableId, organizationId: input.organizationId },
  });
  if (!row) throw new Error("Receivable not found");
  const updated = await prisma.receivable.update({
    where: { id: row.id },
    data: { status: "paid", paidAt: new Date() },
  });
  await recomputeCustomerBehavior(row.customerId);
  await writeAudit({
    organizationId: input.organizationId,
    actorType: "user",
    actorId: input.actorId,
    action: "receivable.paid",
    entityType: "receivable",
    entityId: row.id,
  });
  return updated;
}

export async function listCollectionsQueue(organizationId: string) {
  return prisma.receivable.findMany({
    where: { organizationId, status: { in: ["open", "partially_paid"] } },
    include: { customer: true },
    orderBy: [{ priority: "desc" }, { dueDate: "asc" }],
    take: 100,
  });
}

/** Send timed follow-up webhooks + optional native email for overdue receivables. */
export async function runCollectionsDunning() {
  const now = new Date();
  const overdue = await prisma.receivable.findMany({
    where: {
      status: { in: ["open", "partially_paid"] },
      dueDate: { lt: now },
      OR: [{ lastReminderAt: null }, { lastReminderAt: { lt: new Date(now.getTime() - 3 * 864e5) } }],
    },
    include: { customer: true },
    take: 100,
  });

  const { isMailConfigured, sendEmail } = await import("@/lib/mail");
  const mailOk = isMailConfigured();

  const out = [];
  for (const r of overdue) {
    await prisma.receivable.update({
      where: { id: r.id },
      data: {
        lastReminderAt: now,
        reminderCount: r.reminderCount + 1,
        priority: Math.min(100, r.priority + 5),
      },
    });
    await dispatchWebhook(r.organizationId, "receivable.reminder", {
      receivable_id: r.id,
      customer: r.customer.name,
      customer_email: r.customer.email,
      amount: r.amount,
      currency: r.currency,
      due_date: r.dueDate?.toISOString() || null,
      reminder_count: r.reminderCount + 1,
      behavior_score: r.customer.behaviorScore,
    });

    if (mailOk && r.customer.email) {
      const subject = `Payment reminder: ${r.invoiceNumber || r.id} · ${r.amount} ${r.currency}`;
      const text = `Hello ${r.customer.name},\n\nThis is a friendly reminder that ${r.amount} ${r.currency} is past due${r.dueDate ? ` (due ${r.dueDate.toISOString().slice(0, 10)})` : ""}.\n\nPlease arrange payment at your earliest convenience.\n\n— Collections via Custara`;
      await sendEmail({
        to: r.customer.email,
        subject,
        text,
        html: `<p>Hello ${r.customer.name},</p><p>This is a friendly reminder that <strong>${r.amount} ${r.currency}</strong> is past due${r.dueDate ? ` (due ${r.dueDate.toISOString().slice(0, 10)})` : ""}.</p><p>Please arrange payment at your earliest convenience.</p><p style="color:#666;font-size:12px">Collections via Custara</p>`,
      }).catch((e) => console.warn("[collections] email failed", r.id, e));
    }

    await writeAudit({
      organizationId: r.organizationId,
      actorType: "system",
      action: "receivable.reminder_sent",
      entityType: "receivable",
      entityId: r.id,
      metadata: {
        reminderCount: r.reminderCount + 1,
        emailSent: Boolean(mailOk && r.customer.email),
      },
    });
    out.push(r.id);
  }
  return { reminded: out.length, ids: out, emailEnabled: mailOk };
}
