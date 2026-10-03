import Link from "next/link";
import { redirect } from "next/navigation";
import { requireSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { AppShell } from "@/components/app/AppShell";
import { formatMoney, statusBadgeClass } from "@/lib/format";
import { decideApprovalAction } from "../actions";

export default async function ApprovalsPage() {
  let user;
  try {
    user = await requireSessionUser(undefined, "approvals:read");
  } catch {
    redirect("/login");
  }

  const approvals = await prisma.approvalRequest.findMany({
    where: { organizationId: user.organizationId },
    include: { invoice: { include: { vendor: true, risks: true } } },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
  });

  return (
    <AppShell user={user} title="Approvals" subtitle="Human-in-the-loop · risks at decision time">
      <div className="dash space-y-3">
        {approvals.map((approval) => (
          <div key={approval.id} className="dash-panel">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <Link href={`/app/invoices/${approval.invoiceId}`} className="dash-row-title">
                  {approval.invoice.invoiceNumber || approval.invoiceId.slice(0, 10)}
                </Link>
                <p className="dash-sub">
                  {approval.invoice.vendor?.name || "Unknown vendor"} ·{" "}
                  {formatMoney(approval.invoice.totalAmount, approval.invoice.currency)}
                </p>
              </div>
              <span className={`badge ${statusBadgeClass(approval.status)}`}>{approval.status}</span>
            </div>

            <p className="mt-2 text-[0.78rem]">{approval.reason}</p>
            <p className="dash-mini-meta mt-1">
              {approval.approvedCount}/{approval.requiredCount} approvals
            </p>

            {approval.invoice.risks.length ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {approval.invoice.risks.map((risk) => (
                  <span
                    key={risk.id}
                    className={`badge ${risk.severity === "hard" ? "bg-red-50 text-danger" : "bg-amber-50 text-warn"}`}
                  >
                    {risk.code}
                  </span>
                ))}
              </div>
            ) : null}

            {approval.status === "pending" ? (
              <form action={decideApprovalAction} className="mt-3 flex flex-col gap-2 sm:flex-row">
                <input type="hidden" name="approvalId" value={approval.id} />
                <input name="note" className="input" placeholder="Note" />
                <button type="submit" name="decision" value="approved" className="btn btn-primary">
                  Approve
                </button>
                <button type="submit" name="decision" value="rejected" className="btn btn-secondary">
                  Reject
                </button>
              </form>
            ) : null}
          </div>
        ))}
        {approvals.length === 0 ? <div className="dash-panel dash-empty">No approval requests</div> : null}
      </div>
    </AppShell>
  );
}
