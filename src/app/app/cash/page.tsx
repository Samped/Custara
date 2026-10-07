import Link from "next/link";
import { redirect } from "next/navigation";
import { requireSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { AppShell } from "@/components/app/AppShell";
import { SectionTabs } from "@/components/app/SectionTabs";
import { getCashForecast } from "@/domain/cash";
import { listCollectionsQueue } from "@/domain/collections";
import { resolveDisplayCurrency } from "@/lib/currency";
import { formatDate, formatMoney } from "@/lib/format";
import {
  AddCustomerForm,
  AddReceivableForm,
  MarkPaidButton,
} from "@/components/app/CollectionsForms";

export default async function CashPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  let user;
  try {
    user = await requireSessionUser(undefined, "cash:read");
  } catch {
    redirect("/login");
  }

  const params = await searchParams;
  const tab = params.tab === "collections" ? "collections" : "outlook";
  const tabs = [
    { id: "outlook", label: "Outlook", href: "/app/cash" },
    { id: "collections", label: "Collections", href: "/app/cash?tab=collections" },
  ];

  if (tab === "collections") {
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: user.organizationId },
      select: { displayCurrency: true, country: true },
    });
    const defaultCurrency = resolveDisplayCurrency(org);
    const queue = await listCollectionsQueue(user.organizationId);
    const customers = await prisma.customer.findMany({
      where: { organizationId: user.organizationId },
      orderBy: { name: "asc" },
      take: 200,
    });

    return (
      <AppShell user={user} title="Cash">
        <SectionTabs tabs={tabs} active="collections" />
        <div className="mt-5 mb-5 grid gap-4 lg:grid-cols-2">
          <section className="dash-panel">
            <h2 className="dash-h">Add customer</h2>
            <AddCustomerForm />
          </section>
          <section className="dash-panel">
            <h2 className="dash-h">Open receivable</h2>
            <AddReceivableForm
              customers={customers.map((c) => ({
                id: c.id,
                name: c.name,
                behaviorScore: c.behaviorScore,
              }))}
              defaultCurrency={defaultCurrency}
            />
          </section>
        </div>
        <section className="dash-panel dash-panel-flush">
          <div className="dash-panel-head dash-panel-pad">
            <h2 className="dash-h">Priority queue</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Amount</th>
                  <th>Due</th>
                  <th>Priority</th>
                  <th>Reminders</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {queue.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <p className="dash-row-title" style={{ color: "var(--foreground)" }}>
                        {r.customer.name}
                      </p>
                      <p className="dash-mini-meta">
                        Score {Math.round(r.customer.behaviorScore)}
                        {r.invoiceNumber ? ` · ${r.invoiceNumber}` : ""}
                      </p>
                    </td>
                    <td>{formatMoney(r.amount, r.currency)}</td>
                    <td className="text-muted">{formatDate(r.dueDate)}</td>
                    <td>{r.priority}</td>
                    <td className="text-muted">
                      {r.reminderCount}
                      {r.lastReminderAt ? ` · ${formatDate(r.lastReminderAt)}` : ""}
                    </td>
                    <td>
                      <MarkPaidButton receivableId={r.id} />
                    </td>
                  </tr>
                ))}
                {!queue.length ? (
                  <tr>
                    <td colSpan={6} className="dash-empty-cell">
                      No open receivables
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>
      </AppShell>
    );
  }

  const forecast = await getCashForecast(user.organizationId);

  return (
    <AppShell user={user} title="Cash">
      <SectionTabs tabs={tabs} active="outlook" />
      <div className="dash mt-5">
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
              <p className="dash-sub">Suggested pay dates</p>
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
