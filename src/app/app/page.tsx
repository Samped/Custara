import Link from "next/link";
import { redirect } from "next/navigation";
import { requireSessionUser } from "@/lib/auth";
import { AppShell } from "@/components/app/AppShell";
import { getDashboardSummary } from "@/domain/dashboard";
import { formatDate, formatMoney, statusBadgeClass } from "@/lib/format";
import { uploadInvoiceAction } from "./actions";
import { DashboardActivityChart } from "@/components/app/DashboardActivityChart";

export default async function DashboardPage() {
  let user;
  try {
    user = await requireSessionUser(undefined, "inbox:read");
  } catch {
    redirect("/login");
  }

  const dash = await getDashboardSummary(user.organizationId);
  const currency = dash.forecast.currency;
  const gapHint = dash.forecast.funding_gap_7d > 0 ? "Needs attention" : "Covered";

  const kpis = [
    {
      label: "Open invoices",
      value: String(dash.openInvoiceCount),
      hint: formatMoney(dash.openInvoiceAmount, currency),
      href: "/app/inbox",
    },
    {
      label: "Pending risk",
      value: String(dash.pendingApprovalCount),
      hint: "Approvals",
      href: "/app/approvals",
    },
    {
      label: "Awaiting pay",
      value: String(dash.paymentQueuedCount),
      hint: "Payment queue",
      href: "/app/payments",
    },
    {
      label: "Paid 30d",
      value: String(dash.paidLast30Count),
      hint: formatMoney(dash.paidLast30Amount, currency),
      href: "/app/cash",
    },
  ];

  return (
    <AppShell user={user} title={user.organizationName} subtitle="Operations overview">
      <div className="dash">
        <div className="dash-toolbar">
          <Link href="/app/inbox" className="btn btn-primary">
            Inbox
          </Link>
          <Link href="/app/approvals" className="btn btn-secondary">
            Approvals
          </Link>
          <Link href="/app/developers" className="btn btn-secondary">
            API
          </Link>
          <Link href="/app/connectors" className="btn btn-secondary">
            Connectors
          </Link>
          <Link href="/app/wallets" className="btn btn-secondary">
            Wallets
          </Link>
        </div>

        <section className="dash-connect">
          <div className="dash-connect-head">
            <div>
              <p className="dash-kicker">Integrate</p>
              <h2 className="dash-h">Connect systems</h2>
            </div>
            <Link href="/app/developers" className="btn btn-primary">
              Developer guide
            </Link>
          </div>
          <div className="dash-connect-grid">
            <Link href="/app/developers" className="dash-mini">
              <span className="dash-mini-label">API keys</span>
              <span className="dash-mini-value">{dash.apiKeyCount}</span>
              <span className="dash-mini-meta">Partner REST</span>
            </Link>
            <Link href="/app/developers" className="dash-mini">
              <span className="dash-mini-label">Webhooks</span>
              <span className="dash-mini-value">{dash.webhookCount}</span>
              <span className="dash-mini-meta">Signed events</span>
            </Link>
            <Link href="/app/connectors" className="dash-mini">
              <span className="dash-mini-label">Connect</span>
              <span className="dash-mini-value">
                {dash.connectedConnectorCount}/{dash.connectors.length || 0}
              </span>
              <span className="dash-mini-meta">Email · API · drop</span>
            </Link>
          </div>
        </section>

        <div className="dash-kpi-grid">
          {kpis.map((kpi) => (
            <Link key={kpi.label} href={kpi.href} className="dash-kpi-card">
              <span className="dash-mini-label">{kpi.label}</span>
              <span className="dash-kpi-value">{kpi.value}</span>
              <span className="dash-mini-meta">{kpi.hint}</span>
            </Link>
          ))}
        </div>

        <div className="dash-split">
          <section className="dash-panel">
            <div className="dash-panel-head">
              <div>
                <h2 className="dash-h">Activity</h2>
                <p className="dash-sub">Last 14 days</p>
              </div>
              <div className="dash-stat-side">
                <span className="dash-mini-label">Paid 30d</span>
                <span className="dash-stat-strong">{dash.paidLast30Count}</span>
                <span className="dash-mini-meta">{formatMoney(dash.paidLast30Amount, currency)}</span>
              </div>
            </div>
            <DashboardActivityChart points={dash.activityByDay} />
          </section>

          <section className="dash-panel">
            <div className="dash-panel-head">
              <div>
                <h2 className="dash-h">Cash</h2>
                <p className="dash-sub">{gapHint}</p>
              </div>
            </div>
            <dl className="dash-dl">
              <div>
                <dt>Obligations 7d</dt>
                <dd>{formatMoney(dash.forecast.obligations_7d, currency)}</dd>
              </div>
              <div>
                <dt>Inflow 7d</dt>
                <dd>{formatMoney(dash.forecast.expected_inflow_7d, currency)}</dd>
              </div>
              <div>
                <dt>Treasury</dt>
                <dd>{dash.treasuryBalance != null ? `${dash.treasuryBalance} USDC` : "—"}</dd>
              </div>
              <div>
                <dt>Agent</dt>
                <dd>{dash.agentBalance != null ? `${dash.agentBalance} USDC` : "—"}</dd>
              </div>
            </dl>
            <Link href="/app/cash" className="btn btn-secondary mt-4 w-full text-center">
              Cash detail
            </Link>
          </section>
        </div>

        <div className="dash-split">
          <section className="dash-panel dash-panel-flush">
            <div className="dash-panel-head dash-panel-pad">
              <h2 className="dash-h">Pending</h2>
              <Link href="/app/approvals" className="dash-link">
                All
              </Link>
            </div>
            {dash.pendingApprovals.length === 0 ? (
              <p className="dash-empty">Clear</p>
            ) : (
              <ul className="dash-list">
                {dash.pendingApprovals.map((req) => (
                  <li key={req.id}>
                    <div className="min-w-0">
                      <Link href={`/app/invoices/${req.invoiceId}`} className="dash-row-title">
                        {req.invoice.invoiceNumber || req.invoiceId.slice(0, 10)}
                      </Link>
                      <p className="dash-mini-meta truncate">
                        {req.invoice.vendor?.name || "Vendor"} ·{" "}
                        {formatMoney(req.invoice.totalAmount, req.invoice.currency)}
                      </p>
                    </div>
                    <span className="badge bg-accent-soft text-accent shrink-0">
                      {req.approvedCount}/{req.requiredCount}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="dash-panel dash-panel-flush">
            <div className="dash-panel-head dash-panel-pad">
              <h2 className="dash-h">Status</h2>
              <Link href="/app/developers" className="dash-link">
                Setup
              </Link>
            </div>
            <ul className="dash-list">
              <li>
                <div>
                  <p className="dash-row-title">Partner API</p>
                  <p className="dash-mini-meta">Keys for ERP sync</p>
                </div>
                <span className={`badge ${dash.apiKeyCount ? "bg-accent-soft text-accent" : "bg-slate-100 text-muted"}`}>
                  {dash.apiKeyCount || "—"}
                </span>
              </li>
              <li>
                <div>
                  <p className="dash-row-title">Webhooks</p>
                  <p className="dash-mini-meta">Outbound events</p>
                </div>
                <span className={`badge ${dash.webhookCount ? "bg-accent-soft text-accent" : "bg-slate-100 text-muted"}`}>
                  {dash.webhookCount || "—"}
                </span>
              </li>
              {dash.connectors.map((c) => (
                <li key={c.id}>
                  <div>
                    <p className="dash-row-title capitalize">{c.type.replace(/_/g, " ")}</p>
                    <p className="dash-mini-meta">{c.lastSyncAt ? formatDate(c.lastSyncAt) : "Idle"}</p>
                  </div>
                  <span className={`badge ${statusBadgeClass(c.status)}`}>{c.status}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <section className="dash-panel dash-panel-flush">
          <div className="dash-panel-head dash-panel-pad">
            <div>
              <h2 className="dash-h">Invoices</h2>
              <p className="dash-sub">Recent</p>
            </div>
            <form action={uploadInvoiceAction} className="dash-upload">
              <input type="file" name="file" accept=".json,.txt,.pdf,application/json,text/plain" required />
              <button type="submit" className="btn btn-primary">
                Upload
              </button>
            </form>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Vendor</th>
                <th>Amount</th>
                <th>Due</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {dash.recentInvoices.map((invoice) => (
                <tr key={invoice.id}>
                  <td>
                    <Link href={`/app/invoices/${invoice.id}`} className="dash-row-title">
                      {invoice.invoiceNumber || invoice.id.slice(0, 10)}
                    </Link>
                  </td>
                  <td>{invoice.vendor?.name || "—"}</td>
                  <td>{formatMoney(invoice.totalAmount, invoice.currency)}</td>
                  <td>{formatDate(invoice.dueDate)}</td>
                  <td>
                    <span className={`badge ${statusBadgeClass(invoice.status)}`}>{invoice.status}</span>
                  </td>
                </tr>
              ))}
              {dash.recentInvoices.length === 0 ? (
                <tr>
                  <td colSpan={5} className="dash-empty-cell">
                    No invoices yet
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </section>
      </div>
    </AppShell>
  );
}
