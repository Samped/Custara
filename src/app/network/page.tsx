import Link from "next/link";
import { getSessionUser } from "@/lib/auth";
import { BrandLogo } from "@/components/app/BrandLogo";
import { ThemeToggle } from "@/components/app/ThemeProvider";
import { PageAtmosphere } from "@/components/app/GridAtmosphere";
import { getPublicNetworkLedger, NETWORK_LEDGER_PREVIEW } from "@/domain/networkLedger";
import { formatDate, formatMoney, paymentStatusLabel, shortHash } from "@/lib/format";

export default async function NetworkLedgerPage({
  searchParams,
}: {
  searchParams: Promise<{ all?: string }>;
}) {
  const params = await searchParams;
  const showAll = params.all === "1";
  const [user, ledger] = await Promise.all([
    getSessionUser(),
    getPublicNetworkLedger({ all: showAll }).catch((err) => {
      console.error("[network-ledger]", err);
      return { rows: [], total: 0 };
    }),
  ]);
  const { rows, total } = ledger;
  const onChain = rows.filter((row) => row.onChain).length;
  const more = total - rows.length;

  return (
    <PageAtmosphere>
      <header className="app-header">
        <div className="shell site-header-bar">
          <BrandLogo href="/" size={36} wordmarkClassName="text-[1.05rem]" />
          <div className="site-header-actions">
            <Link href="/docs" className="btn btn-secondary">
              Docs
            </Link>
            <ThemeToggle />
            {user ? (
              <Link href="/app" className="btn btn-secondary">
                Open workspace
              </Link>
            ) : (
              <Link href="/login" className="btn btn-secondary">
                Sign in
              </Link>
            )}
          </div>
        </div>
      </header>

      <main className="shell pb-24 pt-14">
        <p className="net-proof-kicker">Live network</p>
        <h1 className="mt-3 max-w-[16ch] font-[family-name:var(--font-display)] text-[2rem] font-semibold leading-[1.05] tracking-[-0.04em]">
          Verify a Custara payment
        </h1>
        <p className="mt-4 max-w-[34rem] text-[0.95rem] leading-relaxed text-muted">
          Each row is a payment recorded in Custara. On-chain settlements open on Arcscan so you can
          check the transaction yourself. {onChain} of {rows.length} listed here have a public hash.
          {more > 0 ? ` Showing the latest ${rows.length} of ${total.toLocaleString()}.` : null}
        </p>

        <div className="mt-10 overflow-x-auto border-t border-[var(--line)]">
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Verify</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={4} className="dash-empty-cell">
                    No payments recorded yet.
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.id}>
                    <td className="whitespace-nowrap">{formatDate(row.createdAt)}</td>
                    <td className="whitespace-nowrap">{formatMoney(row.amount, row.currency)}</td>
                    <td>{paymentStatusLabel(row.status)}</td>
                    <td>
                      {row.explorerUrl && row.txHash ? (
                        <a
                          href={row.explorerUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono text-[0.78rem] text-accent hover:underline"
                        >
                          {shortHash(row.txHash, 10, 6)}
                        </a>
                      ) : (
                        <span className="text-[0.78rem] text-muted">Recorded in Custara</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-4">
          {more > 0 ? (
            <Link href="/network?all=1" className="btn btn-secondary">
              Show all
            </Link>
          ) : showAll && total > NETWORK_LEDGER_PREVIEW ? (
            <Link href="/network" className="btn btn-secondary">
              Show latest {NETWORK_LEDGER_PREVIEW}
            </Link>
          ) : null}
          <Link href="/" className="text-[0.82rem] text-muted hover:text-foreground">
            Back to Custara
          </Link>
        </div>
      </main>
    </PageAtmosphere>
  );
}
