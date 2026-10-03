import Link from "next/link";
import { redirect } from "next/navigation";
import { requireSessionUser } from "@/lib/auth";
import { AppShell } from "@/components/app/AppShell";
import { getCashForecast } from "@/domain/cash";
import { formatDate, formatMoney } from "@/lib/format";

export default async function CashPage() {
  let user;
  try {
    user = await requireSessionUser(undefined, "cash:read");
  } catch {
    redirect("/login");
  }

  const forecast = await getCashForecast(user.organizationId);

  return (
    <AppShell user={user} title="Cash" subtitle="Obligations · suggested pays · timing">
      <div className="dash">
        <div className="dash-kpi-grid">
          {[
            ["Obligations 7d", forecast.obligations_7d],
            ["Inflow 7d", forecast.expected_inflow_7d],
            ["Obligations 30d", forecast.obligations_30d],
            ["Inflow 30d", forecast.expected_inflow_30d],
          ].map(([label, value]) => (
            <div key={label as string} className="dash-kpi-card" style={{ cursor: "default" }}>
              <span className="dash-mini-label">{label as string}</span>
              <span className="dash-kpi-value">{formatMoney(value as number, forecast.currency)}</span>
            </div>
          ))}
        </div>

        <section className="dash-panel">
          <p className="dash-kicker">Outlook</p>
          <h2 className="dash-h">Recommendation</h2>
          <p className="dash-sub mt-2">{forecast.recommendation}</p>
          <p className="mt-2 text-[0.72rem] text-muted">
            Auto-pay: {forecast.auto_pay_enabled ? "enabled" : "off"} (Settings)
          </p>
          <dl className="dash-dl">
            <div>
              <dt>7d gap</dt>
              <dd>{formatMoney(forecast.funding_gap_7d, forecast.currency)}</dd>
            </div>
            <div>
              <dt>30d gap</dt>
              <dd>{formatMoney(forecast.funding_gap_30d, forecast.currency)}</dd>
            </div>
            <div>
              <dt>Open invoices</dt>
              <dd>{forecast.invoice_count_open}</dd>
            </div>
          </dl>
        </section>

        <section className="dash-panel">
          <div className="dash-panel-head">
            <div>
              <h2 className="dash-h">Suggested pays this week</h2>
              <p className="dash-sub">From payment-timing engine (discount vs cash)</p>
            </div>
          </div>
          <ul className="mt-2 divide-y divide-black/5">
            {forecast.suggested_pays.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                <div>
                  <Link href={`/app/invoices/${p.id}`} className="font-semibold text-accent hover:underline">
                    {p.vendor || p.id.slice(0, 8)}
                  </Link>
                  <p className="text-[0.72rem] text-muted">{p.pay_timing_reason || "—"}</p>
                </div>
                <div className="text-right">
                  <p className="font-semibold">{formatMoney(p.amount, p.currency)}</p>
                  <p className="text-[0.72rem] text-muted">
                    Pay {formatDate(p.recommended_pay_date ? new Date(p.recommended_pay_date) : null)}
                  </p>
                </div>
              </li>
            ))}
            {!forecast.suggested_pays.length ? (
              <li className="py-6 text-sm text-muted">No approved invoices scheduled this week.</li>
            ) : null}
          </ul>
        </section>
      </div>
    </AppShell>
  );
}
