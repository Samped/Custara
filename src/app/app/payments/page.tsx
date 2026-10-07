import Link from "next/link";
import { redirect } from "next/navigation";
import { requireSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { AppShell } from "@/components/app/AppShell";
import { SectionTabs } from "@/components/app/SectionTabs";
import { RetryPaymentButton } from "@/components/app/RetryPaymentButton";
import { WalletsWorkspace } from "@/components/app/WalletsWorkspace";
import { ClickableRow } from "@/components/app/ClickableRow";
import {
  formatDate,
  formatMoney,
  humanizePaymentFailure,
  paymentStatusLabel,
  shortHash,
  statusBadgeClass,
} from "@/lib/format";
import { getArcExecutionMode } from "@/domain/arc/config";

function arcExplorerTxUrl(txHash: string) {
  return `https://testnet.arcscan.app/tx/${txHash}`;
}

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ intent?: string; tab?: string }>;
}) {
  let user;
  try {
    user = await requireSessionUser(undefined, "payments:read");
  } catch {
    redirect("/login");
  }
  const params = await searchParams;
  const tab = params.tab === "wallets" ? "wallets" : "intents";

  const tabs = [
    { id: "intents", label: "Intents", href: "/app/payments" },
    { id: "receipts", label: "Receipts", href: "/app/receipts" },
    { id: "wallets", label: "Wallets", href: "/app/payments?tab=wallets" },
  ];

  if (tab === "wallets") {
    try {
      await requireSessionUser(["admin", "payer"], "wallets:read");
    } catch {
      redirect("/app/payments");
    }
    return (
    <AppShell user={user} title="Pay">
      <SectionTabs tabs={tabs} active="wallets" />
        <div className="mt-5">
          <WalletsWorkspace organizationId={user.organizationId} userId={user.id} />
        </div>
      </AppShell>
    );
  }

  const intents = await prisma.paymentIntent.findMany({
    where: { organizationId: user.organizationId },
    include: { invoice: true },
    orderBy: { createdAt: "desc" },
  });
  const execution = getArcExecutionMode(user.paymentMode);

  return (
    <AppShell user={user} title="Pay">
      <SectionTabs tabs={tabs} active="intents" />

      {params.intent ? (
        <div className="dash-panel mt-4 mb-3 text-[0.78rem] text-accent">Payment queued.</div>
      ) : null}

      <section className="dash-panel mt-4 mb-4 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <p className="dash-kicker">Rail</p>
          <h2 className="dash-h">
            {execution === "testnet"
              ? "Arc testnet"
              : execution === "mainnet"
                ? "Arc mainnet"
                : execution === "simulated"
                  ? "Simulated"
                  : "Unavailable"}
          </h2>
        </div>
      </section>

      <div className="dash-panel dash-panel-flush">
        <table className="table">
          <thead>
            <tr>
              <th>Invoice</th>
              <th>Amount</th>
              <th>Status</th>
              <th>On-chain</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {intents.map((intent) => {
              const simulated =
                intent.mode === "sandbox" ||
                Boolean(intent.circleTxId?.startsWith("sbx_tx_")) ||
                Boolean(intent.providerRef?.startsWith("sbx_"));
              const paid = intent.status === "completed" || intent.status === "exported";
              const failed = intent.status === "failed";
              const failure = failed ? humanizePaymentFailure(intent.failureReason) : null;
              const canRetry = failed && intent.rail === "arc_usdc" && !simulated && !intent.txHash;
              const txHash = intent.txHash && !simulated ? intent.txHash : null;

              return (
                <ClickableRow key={intent.id} href={`/app/receipts/${intent.id}`}>
                  <td>
                    <Link href={`/app/receipts/${intent.id}`} className="dash-row-title">
                      {intent.invoice.invoiceNumber || intent.invoiceId.slice(0, 10)}
                    </Link>
                    <p className="dash-mini-meta">
                      {formatDate(intent.createdAt)}
                      {intent.rail === "arc_usdc" ? " · Arc USDC" : ` · ${intent.rail}`}
                      {simulated ? " · demo" : ""}
                    </p>
                  </td>
                  <td className="whitespace-nowrap">{formatMoney(intent.amount, intent.currency)}</td>
                  <td>
                    <span className={`badge ${statusBadgeClass(intent.status)}`}>
                      {paymentStatusLabel(intent.status)}
                    </span>
                  </td>
                  <td>
                    {txHash ? (
                      <a
                        href={arcExplorerTxUrl(txHash)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-[0.72rem] text-accent hover:underline"
                        title={txHash}
                      >
                        {shortHash(txHash, 10, 6)}
                      </a>
                    ) : intent.exportPath ? (
                      <a href={`/api/internal/exports/${intent.id}`} className="dash-link">
                        Download CSV
                      </a>
                    ) : paid && simulated ? (
                      <span className="text-[0.72rem] text-muted">Demo settlement</span>
                    ) : failed ? (
                      <span className="text-[0.72rem] text-muted">—</span>
                    ) : (
                      <span className="text-[0.72rem] text-muted">Pending…</span>
                    )}
                  </td>
                  <td className="text-right">
                    {failure ? <p className="mb-1 text-left text-[0.72rem] text-danger">{failure}</p> : null}
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <Link href={`/app/receipts/${intent.id}`} className="dash-link">
                        Receipt
                      </Link>
                      {canRetry ? (
                        <RetryPaymentButton paymentIntentId={intent.id} mfaEnabled={user.mfaEnabled} />
                      ) : null}
                    </div>
                  </td>
                </ClickableRow>
              );
            })}
            {intents.length === 0 ? (
              <tr>
                <td colSpan={5} className="dash-empty-cell">
                  No payments yet
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </AppShell>
  );
}
