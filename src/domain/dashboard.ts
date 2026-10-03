import { prisma } from "@/lib/db";
import { getCashForecast } from "@/domain/cash";

const OPEN_INVOICE_STATUSES = [
  "approved",
  "pending_approval",
  "needs_review",
  "payment_queued",
  "received",
  "extracting",
];

function dayKey(d: Date) {
  return d.toISOString().slice(0, 10);
}

export async function getDashboardSummary(organizationId: string) {
  const now = new Date();
  const since = new Date(now.getTime() - 13 * 24 * 60 * 60 * 1000);
  since.setUTCHours(0, 0, 0, 0);

  const [
    forecast,
    invoiceStatusGroups,
    pendingApprovals,
    pendingApprovalCount,
    paymentQueuedCount,
    recentInvoices,
    connectors,
    wallets,
    recentInvoicesForChart,
    paidLast30,
    apiKeyCount,
    webhookCount,
  ] = await Promise.all([
    getCashForecast(organizationId),
    prisma.invoice.groupBy({
      by: ["status"],
      where: { organizationId },
      _count: { _all: true },
      _sum: { totalAmount: true },
    }),
    prisma.approvalRequest.findMany({
      where: { organizationId, status: "pending" },
      include: { invoice: { include: { vendor: true } } },
      orderBy: { createdAt: "desc" },
      take: 6,
    }),
    prisma.approvalRequest.count({
      where: { organizationId, status: "pending" },
    }),
    prisma.invoice.count({
      where: { organizationId, status: "payment_queued" },
    }),
    prisma.invoice.findMany({
      where: { organizationId },
      include: { vendor: true, risks: true },
      orderBy: { createdAt: "desc" },
      take: 8,
    }),
    prisma.integrationConnector.findMany({
      where: {
        organizationId,
        type: { in: ["mailbox_imap", "sftp_drop"] },
      },
      orderBy: { type: "asc" },
    }),
    prisma.orgWallet.findMany({
      where: { organizationId, status: "active" },
      orderBy: { role: "asc" },
    }),
    prisma.invoice.findMany({
      where: { organizationId, createdAt: { gte: since } },
      select: { createdAt: true, totalAmount: true, status: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.invoice.aggregate({
      where: {
        organizationId,
        status: { in: ["payment_sent", "reconciled", "settled"] },
        updatedAt: { gte: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) },
      },
      _sum: { totalAmount: true },
      _count: { _all: true },
    }),
    prisma.apiKey.count({
      where: { organizationId, revokedAt: null },
    }),
    prisma.webhookEndpoint.count({
      where: { organizationId, isActive: true },
    }),
  ]);

  const statusCounts: Record<string, number> = {};
  let openInvoiceCount = 0;
  let openInvoiceAmount = 0;
  for (const row of invoiceStatusGroups) {
    statusCounts[row.status] = row._count._all;
    if (OPEN_INVOICE_STATUSES.includes(row.status)) {
      openInvoiceCount += row._count._all;
      openInvoiceAmount += row._sum.totalAmount || 0;
    }
  }

  const activityByDay: { date: string; count: number; amount: number }[] = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(since.getTime() + i * 24 * 60 * 60 * 1000);
    activityByDay.push({ date: dayKey(d), count: 0, amount: 0 });
  }
  const index = new Map(activityByDay.map((row, i) => [row.date, i]));
  for (const inv of recentInvoicesForChart) {
    const key = dayKey(inv.createdAt);
    const idx = index.get(key);
    if (idx == null) continue;
    activityByDay[idx].count += 1;
    activityByDay[idx].amount += inv.totalAmount || 0;
  }

  const treasury = wallets.find((w) => w.role === "treasury_external");
  const agent = wallets.find((w) => w.role === "agent");

  return {
    forecast,
    openInvoiceCount,
    openInvoiceAmount,
    pendingApprovalCount,
    paymentQueuedCount,
    paidLast30Count: paidLast30._count._all,
    paidLast30Amount: paidLast30._sum.totalAmount || 0,
    statusCounts,
    pendingApprovals,
    recentInvoices,
    connectors,
    activityByDay,
    treasuryBalance: treasury?.balanceUsdc ?? null,
    agentBalance: agent?.balanceUsdc ?? null,
    treasuryAddress: treasury?.address ?? null,
    agentAddress: agent?.address ?? null,
    apiKeyCount,
    webhookCount,
    connectedConnectorCount: connectors.filter((c) => c.status === "connected").length,
  };
}

export type DashboardSummary = Awaited<ReturnType<typeof getDashboardSummary>>;
