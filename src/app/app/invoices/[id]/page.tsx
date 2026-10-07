import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireSessionUser, canPay } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { AppShell } from "@/components/app/AppShell";
import { formatDate, formatMoney, statusBadgeClass } from "@/lib/format";
import { InvoiceActionForm } from "@/components/app/InvoiceActionForm";
import { MfaSetupRequired } from "@/components/app/MfaSetupRequired";

export default async function InvoiceWorkbenchPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  let user;
  try {
    user = await requireSessionUser(undefined, "invoice:read");
  } catch {
    redirect("/login");
  }

  const { id } = await params;
  const invoice = await prisma.invoice.findFirst({
    where: { id, organizationId: user.organizationId },
    include: {
      vendor: { include: { endpoints: { where: { isActive: true }, orderBy: { version: "desc" }, take: 1 } } },
      extraction: true,
      risks: true,
      approvalRequests: { orderBy: { createdAt: "desc" }, include: { decidedBy: true } },
      paymentIntents: { orderBy: { createdAt: "desc" } },
      documents: true,
    },
  });

  if (!invoice) notFound();

  const pendingApproval = invoice.approvalRequests.find((a) => a.status === "pending");
  const latestIntent = invoice.paymentIntents[0];
  const lineItems = invoice.extraction ? (JSON.parse(invoice.extraction.lineItemsJson) as Array<{ description: string; amount: number }>) : [];
  const canVerifyVendor = user.role === "admin" || user.role === "approver";
  const arcEndpoint = invoice.vendor?.endpoints.find((e) => e.endpointType === "arc_usdc" && e.arcAddress);
  const allowlisted = arcEndpoint?.arcAddress
    ? await prisma.destinationAllowlist.findFirst({
        where: {
          organizationId: user.organizationId,
          address: arcEndpoint.arcAddress.toLowerCase(),
          isActive: true,
          revokedAt: null,
        },
      })
    : null;
  const hardRisks = invoice.risks.filter((r) => {
    if (r.severity !== "hard") return false;
    // Allowlist live — don't keep blocking Initiate on a stale destination hold.
    if (r.code === "destination_not_allowlisted" && allowlisted) return false;
    return true;
  });
  const needsVendorVerify = hardRisks.some((r) => r.code === "new_vendor");
  const destRisk = invoice.risks.find((r) => r.code === "destination_not_allowlisted");
  let destEvidence: { address?: string } | null = null;
  if (destRisk?.evidenceJson) {
    try {
      destEvidence = JSON.parse(destRisk.evidenceJson) as { address?: string };
    } catch {
      destEvidence = null;
    }
  }
  let arcFromRaw: string | null = null;
  if (invoice.extraction?.rawJson) {
    try {
      const raw = JSON.parse(invoice.extraction.rawJson) as { arcAddress?: string; arc_address?: string };
      arcFromRaw = raw.arcAddress || raw.arc_address || null;
    } catch {
      arcFromRaw = null;
    }
  }
  const arcAddress =
    arcEndpoint?.arcAddress || destEvidence?.address || arcFromRaw || null;
  const needsDestinationConfirm = Boolean(arcAddress && !allowlisted && destRisk);
  const canConfirmDestination =
    user.role === "admin" || user.role === "approver" || user.role === "payer";

  return (
    <AppShell user={user} title="Invoice" subtitle={invoice.invoiceNumber || invoice.id}>
      <div className="mb-4">
        <Link href="/app" className="text-sm font-medium text-accent hover:underline">
          ← Inbox
        </Link>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        <div className="space-y-5">
          <div className="card p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="app-sub">Vendor</p>
                <h2 className="app-h">
                  {invoice.vendor?.name || invoice.extraction?.vendorName || "Unknown"}
                </h2>
              </div>
              <span className={`badge ${statusBadgeClass(invoice.status)}`}>{invoice.status}</span>
            </div>
            <div className="mt-5 grid gap-4 sm:grid-cols-3">
              <div>
                <p className="text-xs uppercase tracking-wide text-muted">Amount owed</p>
                <p className="mt-1 font-semibold">{formatMoney(invoice.totalAmount, invoice.currency)}</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-muted">Due</p>
                <p className="mt-1 font-semibold">{formatDate(invoice.dueDate)}</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-muted">Confidence</p>
                <p className="mt-1 font-semibold">
                  {invoice.extraction ? `${Math.round(invoice.extraction.confidence * 100)}%` : "—"}
                </p>
              </div>
            </div>
            {invoice.recommendedPayDate || invoice.payTimingReason ? (
              <div className="mt-4 rounded-xl border border-line bg-[#f7fafb] px-3 py-2 text-sm">
                <p className="text-xs uppercase tracking-wide text-muted">Recommended pay date</p>
                <p className="mt-1 font-semibold">{formatDate(invoice.recommendedPayDate)}</p>
                {invoice.payTimingReason ? (
                  <p className="mt-1 text-muted">{invoice.payTimingReason}</p>
                ) : null}
              </div>
            ) : null}
            {invoice.explanation ? (
              <p className="mt-4 rounded-xl bg-accent-soft/60 px-3 py-2 text-sm text-foreground">
                <span className="font-semibold">Policy: </span>
                {invoice.explanation}
              </p>
            ) : null}
          </div>

          <div className="card p-5">
            <h3 className="app-h">Extraction</h3>
            <dl className="mt-4 grid gap-3 sm:grid-cols-2 text-sm">
              {[
                ["Invoice #", invoice.extraction?.invoiceNumber],
                ["PO", invoice.extraction?.poNumber],
                ["Arc address", arcAddress],
                ["Account name", invoice.extraction?.accountName],
                ["Account", invoice.extraction?.accountNumberLast4 ? `••••${invoice.extraction.accountNumberLast4}` : "—"],
                ["Bank", invoice.extraction?.bankName],
                ["Bank code", invoice.extraction?.bankCode],
              ].map(([label, value]) => (
                <div key={label as string} className={label === "Arc address" ? "sm:col-span-2" : undefined}>
                  <dt className="text-muted">{label}</dt>
                  <dd
                    className={`mt-0.5 font-medium ${label === "Arc address" ? "break-all font-mono text-[0.8rem]" : ""}`}
                    title={(value as string) || undefined}
                  >
                    {(value as string) || "—"}
                  </dd>
                </div>
              ))}
            </dl>
            {lineItems.length ? (
              <div className="mt-4">
                <p className="text-sm font-medium">Line items</p>
                <ul className="mt-2 space-y-1 text-sm text-muted">
                  {lineItems.map((item, idx) => (
                    <li key={idx} className="flex justify-between gap-3">
                      <span>{item.description}</span>
                      <span>{formatMoney(item.amount, invoice.currency)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </div>

        <div className="space-y-5">
          <div className="card p-5">
            <h3 className="app-h">Risk assessment</h3>
            {arcAddress ? (
              <p className="mt-2 text-[0.78rem] text-muted">
                Destination:{" "}
                <span className={allowlisted ? "text-accent" : "text-danger"}>
                  {allowlisted ? "confirmed for pay" : "needs confirmation on this invoice"}
                </span>
              </p>
            ) : null}
            {invoice.risks.length === 0 ? (
              <p className="mt-3 text-sm text-muted">No risks flagged.</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {invoice.risks.map((risk) => {
                  const clearedDest =
                    risk.code === "destination_not_allowlisted" && allowlisted;
                  return (
                  <li
                    key={risk.id}
                    className={`rounded-xl border px-3 py-2 ${clearedDest ? "border-line/70 opacity-60" : "border-line"}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold">{risk.code}</span>
                      <span
                        className={`badge ${
                          clearedDest
                            ? "bg-emerald-50 text-accent"
                            : risk.severity === "hard"
                              ? "bg-red-50 text-danger"
                              : "bg-amber-50 text-warn"
                        }`}
                      >
                        {clearedDest ? "cleared" : risk.severity}
                      </span>
                    </div>
                    <p className="app-sub">{risk.message}</p>
                  </li>
                  );
                })}
              </ul>
            )}
          </div>

          {needsDestinationConfirm && canConfirmDestination ? (
            <div className="card p-5">
              <h3 className="app-h">Confirm destination</h3>
              <p className="app-sub">Confirm this Arc address matches the vendor.</p>
              <p className="mt-3 break-all rounded-xl border border-line bg-[#f7fafb] px-3 py-2 font-mono text-[0.78rem]">
                {arcAddress}
              </p>
              <p className="app-sub mt-2">
                {invoice.vendor?.name || invoice.extraction?.vendorName || "Vendor"}
              </p>
              <InvoiceActionForm action="confirm_destination" className="mt-4">
                <input type="hidden" name="invoiceId" value={invoice.id} />
                <button type="submit" className="btn btn-primary w-full">
                  Confirm destination
                </button>
              </InvoiceActionForm>
            </div>
          ) : null}

          {needsVendorVerify && canVerifyVendor ? (
            <div className="card p-5">
              <h3 className="app-h">Verify vendor</h3>
              <p className="app-sub">
                {invoice.vendor?.name || invoice.extraction?.vendorName || "Vendor"} is new. Verify to clear hold.
              </p>
              <InvoiceActionForm action="verify_vendor" className="mt-4">
                <input type="hidden" name="invoiceId" value={invoice.id} />
                <button type="submit" className="btn btn-primary w-full">
                  Verify vendor
                </button>
              </InvoiceActionForm>
            </div>
          ) : null}

          {pendingApproval ? (
            <div className="card p-5">
              <h3 className="app-h">Approval needed</h3>
              <p className="app-sub">
                {pendingApproval.approvedCount}/{pendingApproval.requiredCount} approvals · {pendingApproval.reason}
              </p>
              <InvoiceActionForm action="decide_approval" className="mt-4 space-y-3">
                <input type="hidden" name="approvalId" value={pendingApproval.id} />
                <input name="note" className="input" placeholder="Decision note (optional)" />
                <div className="flex gap-2">
                  <button type="submit" name="decision" value="approved" className="btn btn-primary flex-1">
                    Approve
                  </button>
                  <button type="submit" name="decision" value="rejected" className="btn btn-secondary flex-1">
                    Reject
                  </button>
                </div>
              </InvoiceActionForm>
            </div>
          ) : null}

          {invoice.status === "approved" && canPay(user.role) ? (
            <div className="card p-5">
              <h3 className="app-h">Create payment intent</h3>
              {!user.mfaEnabled ? (
                <div className="mt-3">
                  <MfaSetupRequired />
                </div>
              ) : hardRisks.length ? (
                <p className="app-sub text-danger">
                  Pay blocked until hard risks are cleared ({hardRisks.map((r) => r.code).join(", ")}).
                  {needsDestinationConfirm ? " Confirm destination above." : ""}
                  {needsVendorVerify ? " Verify vendor above." : ""}
                </p>
              ) : (
                <p className="app-sub">Creates a payment intent after policy checks.</p>
              )}
              {user.mfaEnabled ? (
                <InvoiceActionForm
                  action="create_payment"
                  className="mt-4 space-y-3"
                  disabled={hardRisks.length > 0}
                >
                  <input type="hidden" name="invoiceId" value={invoice.id} />
                  <input
                    type="hidden"
                    name="idempotencyKey"
                    value={`pay_${invoice.id}_${invoice.invoiceNumber || "x"}`}
                  />
                  <label className="block text-sm">
                    Step-up MFA code
                    <input
                      name="mfaCode"
                      className="input mt-1"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      placeholder="6-digit TOTP"
                      required
                    />
                  </label>
                  <button
                    type="submit"
                    className="btn btn-primary w-full"
                    disabled={hardRisks.length > 0}
                  >
                    Initiate payment
                  </button>
                </InvoiceActionForm>
              ) : null}
            </div>
          ) : null}

          {latestIntent ? (
            <div className="card p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="app-h">Payment</h3>
                <Link href={`/app/receipts/${latestIntent.id}`} className="dash-link">
                  Full receipt
                </Link>
              </div>
              <p className="mt-2 text-sm">
                <span className={`badge ${statusBadgeClass(latestIntent.status)}`}>
                  {latestIntent.status === "completed"
                    ? "Paid"
                    : latestIntent.status === "failed"
                      ? "Failed"
                      : latestIntent.status === "pending_transfer"
                        ? "Sending"
                        : latestIntent.status.replace(/_/g, " ")}
                </span>
                <span className="ml-2 text-muted">
                  {formatMoney(latestIntent.amount, latestIntent.currency)} ·{" "}
                  {latestIntent.rail === "arc_usdc" ? "Arc USDC" : latestIntent.rail}
                </span>
              </p>
              {latestIntent.txHash?.startsWith("0x") &&
              !String(latestIntent.circleTxId || "").startsWith("sbx_") ? (
                <a
                  className="mt-3 inline-flex font-mono text-[0.78rem] text-accent hover:underline"
                  href={`https://testnet.arcscan.app/tx/${latestIntent.txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {latestIntent.txHash.slice(0, 12)}…{latestIntent.txHash.slice(-6)}
                </a>
              ) : null}
              {latestIntent.status === "failed" && latestIntent.failureReason ? (
                <p className="mt-2 text-[0.78rem] text-danger">
                  {latestIntent.failureReason.includes("idempotency")
                    ? "Transfer rejected — use Retry on Payments."
                    : latestIntent.failureReason.split(" — SDK:")[0].slice(0, 100)}
                </p>
              ) : null}
              {latestIntent.exportPath ? (
                <a
                  className="mt-3 inline-flex text-sm font-medium text-accent hover:underline"
                  href={`/api/internal/exports/${latestIntent.id}`}
                >
                  Download pay-ready CSV
                </a>
              ) : null}
              {invoice.status === "payment_sent" ? (
                <InvoiceActionForm action="reconcile" className="mt-4">
                  <input type="hidden" name="invoiceId" value={invoice.id} />
                  <input type="hidden" name="paymentIntentId" value={latestIntent.id} />
                  <input type="hidden" name="amount" value={String(latestIntent.amount)} />
                  <button type="submit" className="btn btn-secondary w-full">
                    Mark reconciled
                  </button>
                </InvoiceActionForm>
              ) : null}
            </div>
          ) : null}

          <div className="card p-5">
            <h3 className="app-h">Documents</h3>
            <ul className="mt-3 space-y-1 text-sm text-muted">
              {invoice.documents.map((doc) => (
                <li key={doc.id}>
                  {doc.filename} · {(doc.byteSize / 1024).toFixed(1)} KB
                  {doc.retainedUntil ? ` · privacy delete by ${formatDate(doc.retainedUntil)}` : ""}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
