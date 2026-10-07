import Link from "next/link";
import { redirect } from "next/navigation";
import { requireSessionUser } from "@/lib/auth";
import { roleHasCapability } from "@/lib/rbac";
import { AppShell } from "@/components/app/AppShell";
import { getDashboardSummary } from "@/domain/dashboard";
import {
  connectorStatusLabel,
  connectorTypeLabel,
  formatDate,
  formatMoney,
  paymentStatusLabel,
  statusBadgeClass,
} from "@/lib/format";
import { InvoiceUploadForm } from "@/components/app/InvoiceUploadForm";
import { DashboardActivityChart } from "@/components/app/DashboardActivityChart";
import { ClickableRow } from "@/components/app/ClickableRow";

function invoiceLabel(status: string) {
  if (status === "pending_approval") return "Needs approval";
  if (status === "payment_queued") return "Ready to pay";
  if (status === "payment_sent" || status === "reconciled" || status === "settled") return "Paid";
  if (status === "needs_review") return "Needs review";
  return paymentStatusLabel(status);
}

export default async function DashboardPage() {
  let user;
  try {
    user = await requireSessionUser(undefined, "inbox:read");
  } catch {
    redirect("/login");
  }

  const canUpload = roleHasCapability(user.role, "inbox:write");
  const dash = await getDashboardSummary(user.organizationId);
  const currency = dash.displayCurrency || dash.forecast.currency;
  const attentionCount = dash.pendingApprovalCount + dash.paymentQueuedCount;
  const agentBal = dash.agentBalance;
  const lowAgent = agentBal != null && agentBal < 5;
  const gapHint = dash.forecast.funding_gap_7d > 0 ? "Needs attention" : "Covered";

  const queue = [
    {
      label: "Approvals",
      value: dash.pendingApprovalCount,
      hint: dash.pendingApprovalCount ? "Pending" : "None",
      href: "/app/approvals",
      hot: dash.pendingApprovalCount > 0,
    },
    {
      label: "Pay queue",
      value: dash.paymentQueuedCount,
      hint: dash.paymentQueuedCount ? "Ready" : "None",
      href: "/app/payments",
      hot: dash.paymentQueuedCount > 0,
    },
    {
      label: "Open invoices",
      value: dash.openInvoiceCount,
      hint: formatMoney(dash.openInvoiceAmount, currency),
      href: "/app/inbox",
      hot: false,
    },
    {
      label: "Payment wallet",
      value: agentBal != null ? formatMoney(agentBal, "USDC") : "—",
      hint: lowAgent ? "Low balance" : "Balance",
      href: "/app/payments?tab=wallets",
      hot: lowAgent,
    },
  ];

  return (
    <AppShell
      user={user}
      title="Home"
      subtitle={
        attentionCount
          ? `${attentionCount} pending`
          : undefined
      }
    >
      <div className="dash space-y-5">
        <section className="dash-panel flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="dash-kicker">{user.organizationName}</p>
            <h2 className="dash-h">Workspace</h2>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canUpload ? (
              <InvoiceUploadForm
                className="inline-flex flex-col items-start"
                accept=".json,.txt,.pdf,application/json,text/plain,application/pdf"
                buttonLabel="Upload invoice"
              />
            ) : null}
            <Link href="/app/developers" className="btn btn-secondary">
              API
            </Link>
          </div>
        </section>

        <section className="dash-kpi-grid">
          {queue.map((item) => (
            <Link
              key={item.label}
              href={item.href}
              className={`dash-kpi-card ${item.hot ? "dash-kpi-card--hot" : ""}`}
            >
              <span className="dash-mini-label">{item.label}</span>
              <span className="dash-kpi-value">{item.value}</span>
              <span className="dash-mini-meta">{item.hint}</span>
            </Link>
          ))}
        </section>

        {dash.pendingApprovals.length > 0 ? (
          <section className="dash-panel dash-panel-flush">
            <div className="dash-panel-head dash-panel-pad">
              <h2 className="dash-h">Needs approval</h2>
              <Link href="/app/approvals" className="dash-link">
                View all
              </Link>
            </div>
            <ul className="dash-list">
              {dash.pendingApprovals.slice(0, 5).map((req) => (
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
                  <span className="badge bg-amber-50 text-warn shrink-0">
                    {req.approvedCount}/{req.requiredCount}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="dash-panel dash-panel-flush">
          <div className="dash-panel-head dash-panel-pad">
            <h2 className="dash-h">Recent invoices</h2>
            <div className="flex items-center gap-3">
              <Link href="/app/receipts" className="dash-link">
                Receipts
              </Link>
              <Link href="/app/inbox" className="dash-link">
                Inbox
              </Link>
            </div>
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
              {dash.recentInvoices.map((invoice) => {
                const latestPay = invoice.paymentIntents[0];
                const href = latestPay
                  ? `/app/receipts/${latestPay.id}`
                  : `/app/invoices/${invoice.id}`;
                return (
                  <ClickableRow key={invoice.id} href={href}>
                    <td>
                      <Link href={href} className="dash-row-title">
                        {invoice.invoiceNumber || invoice.id.slice(0, 10)}
                      </Link>
                      {latestPay ? (
                        <p className="dash-mini-meta">
                          Receipt · {paymentStatusLabel(latestPay.status)}
                          {latestPay.txHash?.startsWith("0x") ? " · on-chain" : ""}
                        </p>
                      ) : null}
                    </td>
                    <td>{invoice.vendor?.name || "—"}</td>
                    <td>{formatMoney(invoice.totalAmount, invoice.currency)}</td>
                    <td>{formatDate(invoice.dueDate)}</td>
                    <td>
                      <span className={`badge ${statusBadgeClass(invoice.status)}`}>
                        {invoiceLabel(invoice.status)}
                      </span>
                    </td>
                  </ClickableRow>
                );
              })}
              {dash.recentInvoices.length === 0 ? (
                <tr>
                  <td colSpan={5} className="dash-empty-cell">
                    No invoices
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </section>

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
                <p className="dash-sub">
                  {gapHint} · {currency}
                </p>
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
                <dd>{dash.treasuryBalance != null ? formatMoney(dash.treasuryBalance, "USDC") : "—"}</dd>
              </div>
              <div>
                <dt>Agent</dt>
                <dd>{dash.agentBalance != null ? formatMoney(dash.agentBalance, "USDC") : "—"}</dd>
              </div>
            </dl>
            <Link href="/app/cash" className="btn btn-secondary mt-4 w-full text-center">
              Cash detail
            </Link>
          </section>
        </div>

        <section className="dash-panel dash-panel-flush">
          <div className="dash-panel-head dash-panel-pad">
            <h2 className="dash-h">Integrations</h2>
            <Link href="/app/connectors" className="dash-link">
              Manage
            </Link>
          </div>
          <ul className="dash-list">
            <li>
              <div>
                <p className="dash-row-title">API</p>
                <p className="dash-mini-meta">Keys</p>
              </div>
              <span className={`badge ${dash.apiKeyCount ? "bg-accent-soft text-accent" : "bg-slate-100 text-muted"}`}>
                {dash.apiKeyCount || "—"}
              </span>
            </li>
            <li>
              <div>
                <p className="dash-row-title">Webhooks</p>
                <p className="dash-mini-meta">Outbound</p>
              </div>
              <span
                className={`badge ${dash.webhookCount ? "bg-accent-soft text-accent" : "bg-slate-100 text-muted"}`}
              >
                {dash.webhookCount || "—"}
              </span>
            </li>
            {dash.connectors.map((c) => {
              const setupHint =
                c.type === "mailbox_imap"
                  ? "Not configured"
                  : c.type === "sftp_drop"
                    ? "Not configured"
                    : "Not configured";
              return (
                <li key={c.id}>
                  <div>
                    <p className="dash-row-title">{connectorTypeLabel(c.type)}</p>
                    <p className="dash-mini-meta">
                      {c.lastSyncAt
                        ? `Synced ${formatDate(c.lastSyncAt)}`
                        : c.status === "connected"
                          ? "Awaiting sync"
                          : setupHint}
                    </p>
                  </div>
                  <span className={`badge ${statusBadgeClass(c.status)}`}>
                    {connectorStatusLabel(c.status)}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </AppShell>
  );
}
