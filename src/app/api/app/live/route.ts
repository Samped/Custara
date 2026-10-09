import { NextResponse } from "next/server";
import { AuthError, requireSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { OPEN_INVOICE_STATUSES } from "@/domain/openInvoices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Cheap snapshot so the workspace can refresh after a payment without a manual reload. */
export async function GET() {
  try {
    const user = await requireSessionUser();
    const organizationId = user.organizationId;
    const openWhere = { organizationId, status: { in: [...OPEN_INVOICE_STATUSES] } };

    const [openCount, openSum, agent, pendingApprovals, paymentQueued, invoice, intent] =
      await Promise.all([
        prisma.invoice.count({ where: openWhere }),
        prisma.invoice.aggregate({ where: openWhere, _sum: { totalAmount: true } }),
        prisma.orgWallet.findFirst({
          where: { organizationId, role: "agent", status: "active" },
          orderBy: { createdAt: "desc" },
          select: { balanceUsdc: true, updatedAt: true },
        }),
        prisma.approvalRequest.count({ where: { organizationId, status: "pending" } }),
        prisma.invoice.count({ where: { organizationId, status: "payment_queued" } }),
        prisma.invoice.findFirst({
          where: { organizationId },
          orderBy: { updatedAt: "desc" },
          select: { id: true, status: true, updatedAt: true },
        }),
        prisma.paymentIntent.findFirst({
          where: { organizationId },
          orderBy: { updatedAt: "desc" },
          select: { id: true, status: true, updatedAt: true, amount: true },
        }),
      ]);

    const rev = [
      openCount,
      openSum._sum.totalAmount ?? 0,
      agent?.balanceUsdc ?? "",
      agent?.updatedAt.toISOString() ?? "",
      pendingApprovals,
      paymentQueued,
      invoice?.id ?? "",
      invoice?.status ?? "",
      invoice?.updatedAt.toISOString() ?? "",
      intent?.id ?? "",
      intent?.status ?? "",
      intent?.updatedAt.toISOString() ?? "",
      intent?.amount ?? "",
    ].join("|");

    return NextResponse.json({
      rev,
      openInvoices: openCount,
      openAmount: openSum._sum.totalAmount ?? 0,
      agentBalance: agent?.balanceUsdc ?? null,
      pendingApprovals,
      paymentQueued,
    });
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    const message = e instanceof Error ? e.message : "Server error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
