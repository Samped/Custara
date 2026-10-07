import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { requireSessionUser } from "@/lib/auth";
import { AppShell } from "@/components/app/AppShell";
import { RetryPaymentButton } from "@/components/app/RetryPaymentButton";
import {
  arcExplorerTxUrl,
  getPaymentReceipt,
  isSimulatedIntent,
} from "@/domain/receipts";
import {
  formatDate,
  formatMoney,
  humanizePaymentFailure,
  paymentStatusLabel,
  shortHash,
  statusBadgeClass,
} from "@/lib/format";

function field(label: string, value: ReactNode) {
  return (
    <div className="receipt-field">
      <dt>{label}</dt>
      <dd>{value ?? "—"}</dd>
    </div>
  );
}

export default async function ReceiptDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  let user;
  try {
    user = await requireSessionUser(undefined, "payments:read");
  } catch {
    redirect("/login");
  }

  const { id } = await params;
  const receipt = await getPaymentReceipt(user.organizationId, id);
  if (!receipt) notFound();

  const { intent, auditEvents, beneficiary, agentWallet } = receipt;
  const invoice = intent.invoice;
  const simulated = isSimulatedIntent(intent);
  const txHash = intent.txHash?.startsWith("0x") && !simulated ? intent.txHash : null;
  const failure = intent.status === "failed" ? humanizePaymentFailure(intent.failureReason) : null;
  const canRetry =
    intent.status === "failed" && intent.rail === "arc_usdc" && !simulated && !intent.txHash;

  const destAddress =
    (typeof beneficiary.arcAddress === "string" && beneficiary.arcAddress) ||
    (typeof beneficiary.address === "string" && beneficiary.address) ||
    null;
  const destName =
    (typeof beneficiary.accountName === "string" && beneficiary.accountName) ||
    (typeof beneficiary.name === "string" && beneficiary.name) ||
    invoice.vendor?.name ||
    null;

  return (
    <AppShell
      user={user}
      title="Receipt"
      subtitle={`${invoice.invoiceNumber || invoice.id.slice(0, 10)} · ${paymentStatusLabel(intent.status)}`}
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Link href="/app/receipts" className="btn btn-secondary">
          All receipts
        </Link>
        <Link href={`/app/invoices/${invoice.id}`} className="btn btn-secondary">
          Invoice
        </Link>
        {canRetry ? (
          <RetryPaymentButton paymentIntentId={intent.id} mfaEnabled={user.mfaEnabled} />
        ) : null}
      </div>

      <section className="receipt-hero dash-panel mb-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="dash-kicker">Receipt</p>
            <h2 className="dash-h mt-1">
              {formatMoney(intent.amount, intent.currency)}
              <span className="ml-2 text-[0.85rem] font-normal text-muted">
                {intent.rail === "arc_usdc" ? "Arc USDC" : intent.rail}
                {simulated ? " · demo" : ""}
              </span>
            </h2>
            <p className="dash-sub mt-1">
              {destName || "Vendor"} · {formatDate(intent.createdAt)}
            </p>
          </div>
          <span className={`badge ${statusBadgeClass(intent.status)}`}>
            {paymentStatusLabel(intent.status)}
          </span>
        </div>
        {failure ? <p className="mt-3 text-sm text-danger">{failure}</p> : null}
        {txHash ? (
          <a
            href={arcExplorerTxUrl(txHash)}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-flex font-mono text-[0.8rem] text-accent hover:underline"
          >
            On-chain {shortHash(txHash, 14, 8)} ↗
          </a>
        ) : null}
      </section>

      <div className="receipt-grid mb-4">
        <section className="dash-panel">
          <h3 className="dash-h">Transaction</h3>
          <dl className="receipt-dl mt-3">
            {field("Intent ID", <span className="font-mono text-[0.75rem]">{intent.id}</span>)}
            {field("Idempotency", <span className="font-mono text-[0.75rem]">{intent.idempotencyKey}</span>)}
            {field("Mode", intent.mode)}
            {field("Rail", intent.rail)}
            {field("Amount", formatMoney(intent.amount, intent.currency))}
            {field("Status", paymentStatusLabel(intent.status))}
            {field("Created", formatDate(intent.createdAt))}
            {field("Updated", formatDate(intent.updatedAt))}
            {field(
              "Circle tx",
              intent.circleTxId ? (
                <span className="font-mono text-[0.75rem]">{intent.circleTxId}</span>
              ) : (
                "—"
              ),
            )}
            {field(
              "Tx hash",
              txHash ? (
                <a
                  href={arcExplorerTxUrl(txHash)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-[0.75rem] text-accent hover:underline"
                >
                  {txHash}
                </a>
              ) : intent.txHash ? (
                <span className="font-mono text-[0.75rem]">{intent.txHash}</span>
              ) : (
                "—"
              ),
            )}
            {field(
              "Provider ref",
              intent.providerRef ? (
                <span className="font-mono text-[0.75rem]">{intent.providerRef}</span>
              ) : (
                "—"
              ),
            )}
            {field(
              "Export",
              intent.exportPath ? (
                <a href={`/api/internal/exports/${intent.id}`} className="text-accent hover:underline">
                  Download CSV
                </a>
              ) : (
                "—"
              ),
            )}
            {intent.failureReason
              ? field(
                  "Raw failure",
                  <span className="break-all text-[0.72rem] text-muted">{intent.failureReason}</span>,
                )
              : null}
          </dl>
        </section>

        <section className="dash-panel">
          <h3 className="dash-h">Invoice &amp; beneficiary</h3>
          <dl className="receipt-dl mt-3">
            {field(
              "Invoice",
              <Link href={`/app/invoices/${invoice.id}`} className="text-accent hover:underline">
                {invoice.invoiceNumber || invoice.id}
              </Link>,
            )}
            {field("Invoice status", invoice.status.replace(/_/g, " "))}
            {field("Vendor", invoice.vendor?.name || "—")}
            {field("Vendor email", invoice.vendor?.email || "—")}
            {field("Issue date", formatDate(invoice.issueDate))}
            {field("Due date", formatDate(invoice.dueDate))}
            {field("Invoice total", formatMoney(invoice.totalAmount, invoice.currency))}
            {field("Pay to", destName || "—")}
            {field(
              "Destination",
              destAddress ? (
                <span className="break-all font-mono text-[0.75rem]">{destAddress}</span>
              ) : (
                "—"
              ),
            )}
            {field(
              "Agent wallet",
              agentWallet?.address ? (
                <span className="break-all font-mono text-[0.75rem]">{agentWallet.address}</span>
              ) : (
                "—"
              ),
            )}
            {field(
              "Agent balance",
              agentWallet?.balanceUsdc != null
                ? formatMoney(agentWallet.balanceUsdc, "USDC")
                : "—",
            )}
          </dl>
        </section>
      </div>

      {intent.settlements.length ? (
        <section className="dash-panel dash-panel-flush mb-4">
          <div className="dash-panel-head dash-panel-pad">
            <h3 className="dash-h">Settlements</h3>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Amount</th>
                <th>Reference</th>
              </tr>
            </thead>
            <tbody>
              {intent.settlements.map((s) => (
                <tr key={s.id}>
                  <td>{formatDate(s.settledAt)}</td>
                  <td>{formatMoney(s.amount, s.currency)}</td>
                  <td className="font-mono text-[0.75rem] text-muted">{s.reference || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      <section className="dash-panel dash-panel-flush mb-4">
        <div className="dash-panel-head dash-panel-pad">
          <div>
            <h3 className="dash-h">Settlement tasks</h3>
          </div>
        </div>
        {intent.agentTasks.length ? (
          <ol className="receipt-timeline">
            {intent.agentTasks.map((task, i) => {
              let payload: Record<string, unknown> = {};
              try {
                payload = JSON.parse(task.payloadJson || "{}") as Record<string, unknown>;
              } catch {
                payload = {};
              }
              return (
                <li key={task.id}>
                  <div className="receipt-timeline-marker" aria-hidden>
                    {i + 1}
                  </div>
                  <div className="receipt-timeline-body">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="dash-row-title capitalize">{task.type.replace(/_/g, " ")}</p>
                      <span className={`badge ${statusBadgeClass(task.status)}`}>{task.status}</span>
                    </div>
                    <p className="dash-mini-meta mt-1">
                      {formatDate(task.createdAt)}
                      {task.completedAt ? ` → ${formatDate(task.completedAt)}` : ""}
                      {task.attempts > 1 ? ` · ${task.attempts} attempts` : ""}
                    </p>
                    <dl className="receipt-dl receipt-dl-compact mt-3">
                      {field("Task ID", <span className="font-mono text-[0.72rem]">{task.id}</span>)}
                      {field(
                        "Circle tx",
                        task.circleTxId ? (
                          <span className="font-mono text-[0.72rem]">{task.circleTxId}</span>
                        ) : (
                          "—"
                        ),
                      )}
                      {field(
                        "Tx hash",
                        task.txHash?.startsWith("0x") && !simulated ? (
                          <a
                            href={arcExplorerTxUrl(task.txHash)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-mono text-[0.72rem] text-accent hover:underline"
                          >
                            {task.txHash}
                          </a>
                        ) : task.txHash ? (
                          <span className="font-mono text-[0.72rem]">{task.txHash}</span>
                        ) : (
                          "—"
                        ),
                      )}
                      {task.error
                        ? field(
                            "Error",
                            <span className="break-all text-[0.72rem] text-danger">{task.error}</span>,
                          )
                        : null}
                      {Object.keys(payload).length
                        ? field(
                            "Payload",
                            <pre className="receipt-pre">{JSON.stringify(payload, null, 2)}</pre>,
                          )
                        : null}
                    </dl>
                  </div>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="dash-panel-pad text-sm text-muted">No agent tasks recorded for this payment.</p>
        )}
      </section>

      <section className="dash-panel dash-panel-flush mb-4">
        <div className="dash-panel-head dash-panel-pad">
          <div>
            <h3 className="dash-h">Audit</h3>
          </div>
        </div>
        {auditEvents.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Action</th>
                <th>Actor</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {auditEvents.map((event) => (
                <tr key={event.id}>
                  <td className="whitespace-nowrap text-sm">{formatDate(event.createdAt)}</td>
                  <td className="font-medium">{event.action}</td>
                  <td className="app-sub">
                    {event.actorType}
                    {event.actorId ? ` · ${event.actorId.slice(0, 8)}` : ""}
                  </td>
                  <td className="max-w-xs truncate font-mono text-xs text-muted">
                    {event.metadataJson}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="dash-panel-pad text-sm text-muted">No audit events linked yet.</p>
        )}
      </section>

      {invoice.risks.length ? (
        <section className="dash-panel dash-panel-flush">
          <div className="dash-panel-head dash-panel-pad">
            <h3 className="dash-h">Risk flags at payment time</h3>
          </div>
          <ul className="dash-list">
            {invoice.risks.map((risk) => (
              <li key={risk.id}>
                <div>
                  <p className="dash-row-title">{risk.code}</p>
                  <p className="dash-mini-meta">{risk.message}</p>
                </div>
                <span className={`badge ${statusBadgeClass(risk.severity)}`}>{risk.severity}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </AppShell>
  );
}
