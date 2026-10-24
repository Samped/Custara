import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { convertAmount, resolveDisplayCurrency, sumInCurrency } from "@/lib/currency";
import { OPEN_INVOICE_STATUSES } from "@/domain/openInvoices";

export function invoiceOpenAmount(invoice: { residualAmount?: number | null; totalAmount?: number | null }) {
  if (invoice.residualAmount != null && Number.isFinite(invoice.residualAmount)) {
    return Math.max(0, invoice.residualAmount);
  }
  return Math.max(0, Number(invoice.totalAmount || 0));
}

export type AgingBucket = "current" | "d1_30" | "d31_60" | "d61_90" | "d90";

export function agingBucket(dueDate: Date | null | undefined, now = new Date()): AgingBucket {
  if (!dueDate) return "current";
  const days = Math.floor((now.getTime() - dueDate.getTime()) / 86_400_000);
  if (days <= 0) return "current";
  if (days <= 30) return "d1_30";
  if (days <= 60) return "d31_60";
  if (days <= 90) return "d61_90";
  return "d90";
}

export async function getAgedPayable(organizationId: string) {
  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: { displayCurrency: true, country: true },
  });
  const displayCurrency = resolveDisplayCurrency(org);
  const invoices = await prisma.invoice.findMany({
    where: {
      organizationId,
      status: { in: [...OPEN_INVOICE_STATUSES] },
      NOT: { externalId: { startsWith: "odoo-refund:" } },
    },
    select: {
      id: true,
      residualAmount: true,
      totalAmount: true,
      currency: true,
      dueDate: true,
      vendorId: true,
    },
  });
  const empty = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90: 0, overdue: 0, count: invoices.length };
  const groups: Record<AgingBucket, typeof invoices> = {
    current: [],
    d1_30: [],
    d31_60: [],
    d61_90: [],
    d90: [],
  };
  const now = new Date();
  for (const inv of invoices) {
    groups[agingBucket(inv.dueDate, now)].push(inv);
  }
  const sum = (rows: typeof invoices) =>
    sumInCurrency(
      rows.map((i) => ({ amount: invoiceOpenAmount(i), currency: i.currency })),
      displayCurrency,
    );
  const aged = {
    currency: displayCurrency,
    current: sum(groups.current),
    d1_30: sum(groups.d1_30),
    d31_60: sum(groups.d31_60),
    d61_90: sum(groups.d61_90),
    d90: sum(groups.d90),
    overdue: 0,
    count: invoices.length,
  };
  aged.overdue = aged.d1_30 + aged.d31_60 + aged.d61_90 + aged.d90;
  return aged || empty;
}

export function vendorAgedFromInvoices(
  invoices: Array<{ residualAmount?: number | null; totalAmount?: number | null; currency: string; dueDate: Date | null }>,
  displayCurrency: string,
) {
  const now = new Date();
  const groups: Record<AgingBucket, typeof invoices> = {
    current: [],
    d1_30: [],
    d31_60: [],
    d61_90: [],
    d90: [],
  };
  for (const inv of invoices) {
    groups[agingBucket(inv.dueDate, now)].push(inv);
  }
  const sum = (rows: typeof invoices) =>
    sumInCurrency(
      rows.map((i) => ({ amount: invoiceOpenAmount(i), currency: i.currency })),
      displayCurrency,
    );
  return {
    current: sum(groups.current),
    d1_30: sum(groups.d1_30),
    d31_60: sum(groups.d31_60),
    d61_90: sum(groups.d61_90),
    d90: sum(groups.d90),
    open: sum(invoices),
  };
}

export async function listOpenVendorCredits(organizationId: string, vendorId: string) {
  return prisma.invoice.findMany({
    where: {
      organizationId,
      vendorId,
      externalId: { startsWith: "odoo-refund:" },
      status: { notIn: ["void", "reconciled", "rejected"] },
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function applyVendorCredit(input: {
  organizationId: string;
  invoiceId: string;
  creditInvoiceId: string;
  actorId?: string;
}) {
  const bill = await prisma.invoice.findFirst({
    where: { id: input.invoiceId, organizationId: input.organizationId },
  });
  const credit = await prisma.invoice.findFirst({
    where: {
      id: input.creditInvoiceId,
      organizationId: input.organizationId,
      vendorId: bill?.vendorId || undefined,
      externalId: { startsWith: "odoo-refund:" },
      status: { notIn: ["void", "reconciled", "rejected"] },
    },
  });
  if (!bill || !credit) throw new Error("Bill or credit not found.");
  if (bill.externalId?.startsWith("odoo-refund:")) throw new Error("Cannot apply a credit to another credit.");
  const open = invoiceOpenAmount(bill);
  const creditOpen = invoiceOpenAmount(credit);
  const applied = Math.min(open, creditOpen);
  if (applied <= 0.01) throw new Error("Nothing left to apply.");

  const nextResidual = Math.max(0, open - applied);
  const creditLeft = Math.max(0, creditOpen - applied);
  await prisma.invoice.update({
    where: { id: bill.id },
    data: {
      residualAmount: nextResidual,
      creditApplied: (bill.creditApplied || 0) + applied,
      status: nextResidual <= 0.01 && ["approved", "pending_approval", "needs_review"].includes(bill.status)
        ? "reconciled"
        : bill.status,
      explanation: nextResidual <= 0.01 ? "Net to zero with vendor credit." : bill.explanation,
    },
  });
  await prisma.invoice.update({
    where: { id: credit.id },
    data: {
      residualAmount: creditLeft,
      status: creditLeft <= 0.01 ? "reconciled" : credit.status,
      explanation: "Applied to a vendor bill in Custara.",
    },
  });
  await prisma.riskAssessment.deleteMany({
    where: { invoiceId: bill.id, code: "odoo_open_credit" },
  });
  await writeAudit({
    organizationId: input.organizationId,
    actorType: "user",
    actorId: input.actorId,
    action: "invoice.credit_applied",
    entityType: "invoice",
    entityId: bill.id,
    metadata: { creditInvoiceId: credit.id, applied },
  });
  try {
    const { assignOdooCreditToBill } = await import("@/domain/connectors/odoo");
    await assignOdooCreditToBill({
      organizationId: input.organizationId,
      billInvoiceId: bill.id,
      creditInvoiceId: credit.id,
    });
  } catch {
    /* Odoo assign is best-effort */
  }
  return { applied, residual: nextResidual };
}

export async function waiveVendorCredits(input: {
  organizationId: string;
  invoiceId: string;
  actorId?: string;
}) {
  const bill = await prisma.invoice.findFirst({
    where: { id: input.invoiceId, organizationId: input.organizationId },
  });
  if (!bill) throw new Error("Invoice not found.");
  await prisma.invoice.update({
    where: { id: bill.id },
    data: { creditWaivedAt: new Date() },
  });
  await prisma.riskAssessment.deleteMany({
    where: { invoiceId: bill.id, code: "odoo_open_credit" },
  });
  await writeAudit({
    organizationId: input.organizationId,
    actorType: "user",
    actorId: input.actorId,
    action: "invoice.credit_waived",
    entityType: "invoice",
    entityId: bill.id,
  });
}

export function assertFiscalUnlocked(invoice: {
  fiscalPeriodLocked?: boolean | null;
  issueDate?: Date | null;
}) {
  if (invoice.fiscalPeriodLocked) {
    throw new Error("Odoo fiscal period is locked for this bill. Unlock it in Odoo before paying.");
  }
}

export function convertOpenAmount(
  invoice: { residualAmount?: number | null; totalAmount?: number | null; currency: string },
  displayCurrency: string,
) {
  return convertAmount(invoiceOpenAmount(invoice), invoice.currency, displayCurrency);
}
