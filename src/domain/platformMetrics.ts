import { prisma } from "@/lib/db";
import { isVerifiedBusiness } from "@/lib/businessPresence";
import { convertAmount } from "@/lib/currency";

const INGEST_STATUSES = ["received", "extracting"] as const;
const SETTLED_STATUSES = ["payment_sent", "reconciled", "settled"] as const;
const DUPLICATE_RISK_CODES = [
  "duplicate_invoice",
  "duplicate_document_checksum",
  "fuzzy_duplicate",
] as const;
const OPEN_STATUSES = [
  "approved",
  "pending_approval",
  "needs_review",
  "received",
  "extracting",
] as const;

/** Average day gap for events inside [start, end). Null when the window is empty. */
export function averageDayGap(
  rows: { at: Date; from: Date | null }[],
  start: Date,
  end: Date,
): number | null {
  const samples = rows.filter((row) => row.from && row.at >= start && row.at < end);
  if (!samples.length) return null;
  const sum = samples.reduce(
    (acc, row) => acc + Math.max(0, (row.at.getTime() - row.from!.getTime()) / 864e5),
    0,
  );
  return sum / samples.length;
}

function dayKey(d: Date) {
  return d.toISOString().slice(0, 10);
}

function emptySeries(days: number, end: Date): { date: string; count: number; amount: number }[] {
  const out: { date: string; count: number; amount: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end.getTime() - i * 24 * 60 * 60 * 1000);
    out.push({ date: dayKey(d), count: 0, amount: 0 });
  }
  return out;
}

export async function getPlatformMetrics() {
  const now = new Date();
  const since30 = new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000);
  since30.setUTCHours(0, 0, 0, 0);

  const [
    orgs,
    invoicesProcessed,
    settlementInvoiceIds,
    settledStatusInvoiceIds,
    paymentIntentGroups,
    duplicateRiskInvoiceIds,
    duplicateStatusInvoiceIds,
    openCount,
    needsReviewCount,
    settlements,
    invoicesCreated30,
    settlementsCreated30,
    orgsRegistered30,
  ] = await Promise.all([
    prisma.organization.findMany({
      select: {
        onboardingCompletedAt: true,
        website: true,
        socialUrl: true,
      },
    }),
    prisma.invoice.count({
      where: { status: { notIn: [...INGEST_STATUSES] } },
    }),
    prisma.settlement.findMany({
      select: { invoiceId: true },
      distinct: ["invoiceId"],
    }),
    prisma.invoice.findMany({
      where: { status: { in: [...SETTLED_STATUSES] } },
      select: { id: true },
    }),
    prisma.paymentIntent.groupBy({
      by: ["status"],
      _count: { _all: true },
    }),
    prisma.riskAssessment.findMany({
      where: { code: { in: [...DUPLICATE_RISK_CODES] } },
      select: { invoiceId: true },
      distinct: ["invoiceId"],
    }),
    prisma.invoice.findMany({
      where: { status: "duplicate_suspected" },
      select: { id: true },
    }),
    prisma.invoice.count({
      where: { status: { in: [...OPEN_STATUSES] } },
    }),
    prisma.invoice.count({
      where: { status: "needs_review" },
    }),
    prisma.settlement.findMany({
      select: { amount: true, currency: true },
    }),
    prisma.invoice.findMany({
      where: { createdAt: { gte: since30 } },
      select: { createdAt: true },
    }),
    prisma.settlement.findMany({
      where: { settledAt: { gte: since30 } },
      select: { settledAt: true, amount: true, currency: true },
    }),
    prisma.organization.findMany({
      where: { onboardingCompletedAt: { gte: since30 } },
      select: { onboardingCompletedAt: true },
    }),
  ]);

  const businessesRegistered = orgs.filter((o) => o.onboardingCompletedAt != null).length;
  const verifiedBusinesses = orgs.filter((o) => isVerifiedBusiness(o)).length;

  const settledInvoiceIdSet = new Set(settlementInvoiceIds.map((s) => s.invoiceId));
  for (const inv of settledStatusInvoiceIds) settledInvoiceIdSet.add(inv.id);
  const invoicesSettled = settledInvoiceIdSet.size;

  let transactionsTotal = 0;
  let transactionsCompleted = 0;
  let transactionsFailed = 0;
  for (const g of paymentIntentGroups) {
    const n = g._count._all;
    transactionsTotal += n;
    if (g.status === "completed" || g.status === "exported" || g.status === "submitted") {
      transactionsCompleted += n;
    } else if (g.status === "failed") {
      transactionsFailed += n;
    }
  }

  const duplicateInvoiceIds = new Set(duplicateRiskInvoiceIds.map((r) => r.invoiceId));
  for (const inv of duplicateStatusInvoiceIds) duplicateInvoiceIds.add(inv.id);
  const duplicatesDetected = duplicateInvoiceIds.size;

  let settledVolumeUsd = 0;
  for (const s of settlements) {
    settledVolumeUsd += convertAmount(s.amount, s.currency, "USD");
  }

  const successRate = transactionsTotal > 0 ? transactionsCompleted / transactionsTotal : 0;

  const invoiceSeries = emptySeries(30, now);
  const invoiceIndex = new Map(invoiceSeries.map((p, i) => [p.date, i]));
  for (const inv of invoicesCreated30) {
    const key = dayKey(inv.createdAt);
    const idx = invoiceIndex.get(key);
    if (idx != null) invoiceSeries[idx].count += 1;
  }

  const settlementSeries = emptySeries(30, now);
  const settlementIndex = new Map(settlementSeries.map((p, i) => [p.date, i]));
  for (const s of settlementsCreated30) {
    const key = dayKey(s.settledAt);
    const idx = settlementIndex.get(key);
    if (idx != null) {
      settlementSeries[idx].count += 1;
      settlementSeries[idx].amount += convertAmount(s.amount, s.currency, "USD");
    }
  }

  const businessSeries = emptySeries(30, now);
  const businessIndex = new Map(businessSeries.map((p, i) => [p.date, i]));
  for (const o of orgsRegistered30) {
    if (!o.onboardingCompletedAt) continue;
    const key = dayKey(o.onboardingCompletedAt);
    const idx = businessIndex.get(key);
    if (idx != null) businessSeries[idx].count += 1;
  }

  const since90 = new Date(now.getTime() - 90 * 864e5);
  const since180 = new Date(now.getTime() - 180 * 864e5);
  const [cycleSettlements, cycleReceivables] = await Promise.all([
    prisma.settlement.findMany({
      where: { settledAt: { gte: since180 } },
      select: {
        settledAt: true,
        invoice: { select: { issueDate: true, createdAt: true } },
      },
    }),
    prisma.receivable.findMany({
      where: { status: "paid", paidAt: { gte: since180 }, issueDate: { not: null } },
      select: { paidAt: true, issueDate: true },
    }),
  ]);
  const dpoRows = cycleSettlements.map((row) => ({
    at: row.settledAt,
    from: row.invoice.issueDate || row.invoice.createdAt,
  }));
  const dsoRows = cycleReceivables.map((row) => ({
    at: row.paidAt!,
    from: row.issueDate,
  }));
  const dpo = {
    after: averageDayGap(dpoRows, since90, new Date(now.getTime() + 1)),
    before: averageDayGap(dpoRows, since180, since90),
  };
  const dso = {
    after: averageDayGap(dsoRows, since90, new Date(now.getTime() + 1)),
    before: averageDayGap(dsoRows, since180, since90),
  };

  return {
    businessesRegistered,
    verifiedBusinesses,
    invoicesProcessed,
    invoicesSettled,
    transactionsTotal,
    transactionsCompleted,
    transactionsFailed,
    duplicatesDetected,
    settledVolumeUsd,
    successRate,
    dpo,
    dso,
    openCount,
    needsReviewCount,
    series: {
      invoices: invoiceSeries,
      settlements: settlementSeries,
      businesses: businessSeries,
    },
  };
}

export type PlatformMetrics = Awaited<ReturnType<typeof getPlatformMetrics>>;
