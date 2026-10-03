import Link from "next/link";
import { redirect } from "next/navigation";
import { requireSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { AppShell } from "@/components/app/AppShell";
import { formatDate, formatMoney, statusBadgeClass } from "@/lib/format";

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ intent?: string }>;
}) {
  let user;
  try {
    user = await requireSessionUser(undefined, "payments:read");
  } catch {
    redirect("/login");
  }
  const params = await searchParams;

  const intents = await prisma.paymentIntent.findMany({
    where: { organizationId: user.organizationId },
    include: { invoice: true },
    orderBy: { createdAt: "desc" },
  });

  return (
    <AppShell user={user} title="Payments" subtitle="Intents · Arc USDC · export rails">
      {params.intent ? (
        <div className="dash-panel mb-3 text-[0.78rem]">
          Created intent {params.intent}. Arc tasks show under Wallets.
        </div>
      ) : null}

      <div className="dash-panel dash-panel-flush">
        <table className="table">
          <thead>
            <tr>
              <th>Intent</th>
              <th>Invoice</th>
              <th>Amount</th>
              <th>Rail</th>
              <th>Status</th>
              <th>Tx / Export</th>
            </tr>
          </thead>
          <tbody>
            {intents.map((intent) => (
              <tr key={intent.id}>
                <td className="font-mono text-[0.68rem]">{intent.id.slice(0, 12)}</td>
                <td>
                  <Link href={`/app/invoices/${intent.invoiceId}`} className="dash-row-title">
                    {intent.invoice.invoiceNumber || intent.invoiceId.slice(0, 8)}
                  </Link>
                  <p className="dash-mini-meta">{formatDate(intent.createdAt)}</p>
                </td>
                <td>{formatMoney(intent.amount, intent.currency)}</td>
                <td>{intent.rail}</td>
                <td>
                  <span className={`badge ${statusBadgeClass(intent.status)}`}>{intent.status}</span>
                </td>
                <td>
                  {intent.txHash ? (
                    <span className="font-mono text-[0.68rem]">{intent.txHash.slice(0, 14)}…</span>
                  ) : intent.exportPath ? (
                    <a href={`/api/internal/exports/${intent.id}`} className="dash-link">
                      CSV
                    </a>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
            {intents.length === 0 ? (
              <tr>
                <td colSpan={6} className="dash-empty-cell">
                  No payment intents yet
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </AppShell>
  );
}
