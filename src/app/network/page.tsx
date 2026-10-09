import Link from "next/link";
import { getSessionUser } from "@/lib/auth";
import { BrandLogo } from "@/components/app/BrandLogo";
import { ThemeToggle } from "@/components/app/ThemeProvider";
import { PageAtmosphere } from "@/components/app/GridAtmosphere";
import { getPublicNetworkLedger } from "@/domain/networkLedger";
import { formatDate, formatMoney, paymentStatusLabel, shortHash } from "@/lib/format";

export default async function NetworkLedgerPage() {
  const [user, rows] = await Promise.all([
    getSessionUser(),
    getPublicNetworkLedger().catch((err) => {
      console.error("[network-ledger]", err);
      return [];
    }),
  ]);
  const onChain = rows.filter((row) => row.onChain).length;

  return (
    <PageAtmosphere>
      <header className="app-header">
        <div className="shell flex h-14 items-center justify-between">
          <BrandLogo href="/" size={36} wordmarkClassName="text-[1.05rem]" />
          <div className="flex items-center gap-2.5">
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

        <p className="mt-6">
          <Link href="/" className="text-[0.82rem] text-muted hover:text-foreground">
            Back to Custara
          </Link>
        </p>
      </main>
    </PageAtmosphere>
  );
}
