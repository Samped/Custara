import Link from "next/link";
import { redirect } from "next/navigation";
import { requireSessionUser } from "@/lib/auth";
import { AppShell } from "@/components/app/AppShell";
import { SectionTabs } from "@/components/app/SectionTabs";
import { ClickableRow } from "@/components/app/ClickableRow";
import { listPaymentReceipts, isSimulatedIntent } from "@/domain/receipts";
import {
  formatDate,
  formatMoney,
  paymentStatusLabel,
  shortHash,
  statusBadgeClass,
} from "@/lib/format";

export default async function ReceiptsPage() {
  let user;
  try {
    user = await requireSessionUser(undefined, "payments:read");
  } catch {
    redirect("/login");
  }

  const receipts = await listPaymentReceipts(user.organizationId);
  const tabs = [
    { id: "intents", label: "Intents", href: "/app/payments" },
    { id: "receipts", label: "Receipts", href: "/app/receipts" },
    { id: "wallets", label: "Wallets", href: "/app/payments?tab=wallets" },
  ];

  return (
    <AppShell user={user} title="Pay">
      <SectionTabs tabs={tabs} active="receipts" />

      <div className="dash-panel dash-panel-flush mt-4">
        <table className="table">
          <thead>
            <tr>
              <th>Receipt</th>
              <th>Vendor</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Tx</th>
            </tr>
          </thead>
          <tbody>
            {receipts.map((intent) => {
              const simulated = isSimulatedIntent(intent);
              const txHash = intent.txHash && !simulated ? intent.txHash : null;
              const task = intent.agentTasks[0];
              const href = `/app/receipts/${intent.id}`;
              return (
                <ClickableRow key={intent.id} href={href}>
                  <td>
                    <Link href={href} className="dash-row-title">
                      {intent.invoice.invoiceNumber || intent.invoiceId.slice(0, 10)}
                    </Link>
                    <p className="dash-mini-meta">
                      {formatDate(intent.createdAt)}
                      {intent.rail === "arc_usdc" ? " · Arc USDC" : ` · ${intent.rail}`}
                      {simulated ? " · demo" : ""}
                    </p>
                  </td>
                  <td>{intent.invoice.vendor?.name || "—"}</td>
                  <td className="whitespace-nowrap">{formatMoney(intent.amount, intent.currency)}</td>
                  <td>
                    <span className={`badge ${statusBadgeClass(intent.status)}`}>
                      {paymentStatusLabel(intent.status)}
                    </span>
                    {task ? (
                      <p className="dash-mini-meta mt-1">
                        Agent · {task.type.replace(/_/g, " ")} · {task.status}
                      </p>
                    ) : null}
                  </td>
                  <td className="font-mono text-[0.72rem] text-muted">
                    {txHash ? shortHash(txHash, 10, 6) : simulated && intent.status === "completed" ? "demo" : "—"}
                  </td>
                </ClickableRow>
              );
            })}
            {receipts.length === 0 ? (
              <tr>
                <td colSpan={5} className="dash-empty-cell">
                  No receipts
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </AppShell>
  );
}
