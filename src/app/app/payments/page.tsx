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
  paymentIntentTitle,
  paymentStatusLabel,
  shortHash,
  statusBadgeClass,
} from "@/lib/format";
import { arcNetworkCopy, getArcExecutionMode, mainnetPayGated } from "@/domain/arc/config";
import { InvoiceActionForm } from "@/components/app/InvoiceActionForm";
import { invoiceOpenAmount } from "@/domain/apLedger";
import { listPayRunCandidates } from "@/domain/payRun";
import { canPay } from "@/lib/auth";
import { platformFeeUsdc } from "@/domain/platformFee";
import { arcExplorerTxUrl } from "@/domain/receipts";

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ intent?: string; tab?: string; run?: string }>;
}) {
  let user;
  try {
    user = await requireSessionUser(undefined, "payments:read");
  } catch {
    redirect("/login");
  }
  const params = await searchParams;
  const tab = params.tab === "wallets" ? "wallets" : params.tab === "run" ? "run" : "intents";
  const execution = getArcExecutionMode(user.paymentMode);
  const networkCopy = arcNetworkCopy(execution);
  const payGated = execution === "blocked" || mainnetPayGated();

  const tabs = [
    { id: "intents", label: "Intents", href: "/app/payments" },
    { id: "run", label: "Pay run", href: "/app/payments?tab=run" },
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

  if (tab === "run") {
    const candidates = await listPayRunCandidates(user.organizationId);
    const recentRuns = await prisma.payRun.findMany({
      where: { organizationId: user.organizationId },
      include: { items: true },
      orderBy: { createdAt: "desc" },
      take: 8,
    });
    return (
      <AppShell user={user} title="Pay">
        <SectionTabs tabs={tabs} active="run" />
        {params.run ? (
          <p className="dash-panel mt-4 mb-3 text-[0.78rem] text-accent">Pay run {params.run.slice(0, 8)} submitted on {networkCopy}.</p>
        ) : null}
        {payGated ? (
          <p className="dash-panel mt-4 mb-3 text-[0.78rem] text-danger">
            {mainnetPayGated()
              ? "Mainnet pay is gated until the Circle agent and fee wallet are funded (ARC_PAYMENTS_LIVE=false)."
              : "Arc pay is unavailable on this host. Check Settings payment mode and Circle keys."}
          </p>
        ) : null}
        <section className="dash-panel mt-4">
          <h2 className="dash-h">Approved bills</h2>
          <p className="dash-sub mt-1">Select bills, then settle residual on {networkCopy} in one MFA step. The buyer pays the vendor in full plus a disclosed Custara fee.</p>
          {canPay(user.role) ? (
            <InvoiceActionForm action="create_pay_run" className="mt-4 space-y-3">
              {candidates.map((inv) => (
                <label key={inv.id} className="flex items-center justify-between gap-3 text-sm">
                  <span className="flex items-center gap-2">
                    <input type="checkbox" name="invoiceIds" value={inv.id} />
                    <Link href={`/app/invoices/${inv.id}`} className="text-accent hover:underline">
                      {inv.invoiceNumber || inv.id.slice(0, 8)}
                    </Link>
                    <span className="text-muted">{inv.vendor?.name || "Vendor"}</span>
                  </span>
                  <span className="text-right">
                    {formatMoney(invoiceOpenAmount(inv), inv.currency)}
                    {inv.currency === "USDC" || inv.currency === "USD"
                      ? platformFeeUsdc(invoiceOpenAmount(inv)) > 0
                        ? ` + ${formatMoney(platformFeeUsdc(invoiceOpenAmount(inv)), "USDC")} fee`
                        : ""
                      : ""}
                  </span>
                </label>
              ))}
              {!candidates.length ? <p className="text-sm text-muted">No approved bills ready to pay.</p> : null}
              {candidates.length ? (
                <>
                  <label className="block text-sm">
                    Step-up MFA (if required)
                    <input name="mfaCode" className="input mt-1" inputMode="numeric" autoComplete="one-time-code" placeholder="6-digit TOTP" />
                  </label>
                  <button type="submit" className="btn btn-primary" disabled={payGated}>
                    Pay selected on {networkCopy}
                  </button>
                </>
              ) : null}
            </InvoiceActionForm>
          ) : (
            <p className="mt-3 text-sm text-muted">A payer must run this batch.</p>
          )}
        </section>
        <section className="dash-panel mt-4">
          <h2 className="dash-h">Recent runs</h2>
          <ul className="mt-3 space-y-2 text-sm text-muted">
            {recentRuns.map((run) => (
              <li key={run.id}>
                {formatDate(run.createdAt)} · {run.status} · {run.items.length} bills
              </li>
            ))}
            {!recentRuns.length ? <li>No pay runs yet.</li> : null}
          </ul>
        </section>
      </AppShell>
    );
  }

  const intents = await prisma.paymentIntent.findMany({
    where: { organizationId: user.organizationId },
    include: { invoice: true },
    orderBy: { createdAt: "desc" },
  });

  return (
    <AppShell user={user} title="Pay">
      <SectionTabs tabs={tabs} active="intents" />

      {params.intent ? (
        <div className="dash-panel mt-4 mb-3 text-[0.78rem] text-accent">Payment queued.</div>
      ) : null}

      {payGated ? (
        <p className="dash-panel mt-4 mb-3 text-[0.78rem] text-danger">
          {mainnetPayGated()
            ? "Mainnet pay is gated until the Circle agent and fee wallet are funded."
            : "Arc pay is unavailable on this host."}
        </p>
      ) : null}

      <section className="dash-panel mt-4 mb-4 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <p className="dash-kicker">Rail</p>
          <h2 className="dash-h">{networkCopy}</h2>
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
              const canRetry =
                failed &&
                (intent.rail === "arc_usdc" || intent.rail === "paj_offramp") &&
                !simulated &&
                !intent.txHash;
              const txHash = intent.txHash && !simulated ? intent.txHash : null;

              return (
                <ClickableRow key={intent.id} href={`/app/receipts/${intent.id}`}>
                  <td>
                    <Link href={`/app/receipts/${intent.id}`} className="dash-row-title">
                      {paymentIntentTitle(intent)}
                    </Link>
                    <p className="dash-mini-meta">
                      {formatDate(intent.createdAt)}
                      {intent.rail === "arc_usdc" ? " · Arc USDC" : ` · ${intent.rail}`}
                      {simulated ? " · demo" : ""}
                    </p>
                  </td>
                  <td className="whitespace-nowrap">
                    {formatMoney(intent.amount, intent.currency)}
                    {intent.feeAmount ? (
                      <p className="dash-mini-meta">+ {formatMoney(intent.feeAmount, "USDC")} fee</p>
                    ) : null}
                  </td>
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
