import Link from "next/link";
import { formatMoney } from "@/lib/format";
import type { PlatformMetrics } from "@/domain/platformMetrics";

export function PlatformInsights({ metrics }: { metrics: PlatformMetrics }) {
  const stats = [
    {
      value: metrics.businessesRegistered.toLocaleString(),
      label: "Businesses",
      note: `${metrics.verifiedBusinesses} verified`,
    },
    {
      value: metrics.invoicesProcessed.toLocaleString(),
      label: "Invoices",
      note: `${metrics.invoicesSettled} settled`,
    },
    {
      value: formatMoney(metrics.settledVolumeUsd, "USD"),
      label: "Settled",
      note: `${metrics.transactionsTotal} transactions`,
    },
    {
      value: metrics.duplicatesDetected.toLocaleString(),
      label: "Duplicates",
      note: "caught across the network",
    },
  ];

  return (
    <section className="net-proof shell" aria-label="Network">
      <Link href="/network" className="net-proof-kicker">
        Live network
      </Link>
      <dl>
        {stats.map((item) => (
          <div key={item.label}>
            <dd>{item.value}</dd>
            <dt>{item.label}</dt>
            <p>{item.note}</p>
          </div>
        ))}
      </dl>
    </section>
  );
}
