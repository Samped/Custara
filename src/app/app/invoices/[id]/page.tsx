import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireSessionUser, canPay } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { AppShell } from "@/components/app/AppShell";
import { formatDate, formatMoney, statusBadgeClass } from "@/lib/format";
import { convertAmount } from "@/lib/currency";
import { fxSourceLabel, quoteArcSettlement, refreshLiveFxBook } from "@/domain/fx/liveQuote";
import { InvoiceActionForm } from "@/components/app/InvoiceActionForm";
import { MfaSetupRequired } from "@/components/app/MfaSetupRequired";
import { invoiceOpenAmount, listOpenVendorCredits } from "@/domain/apLedger";
import { dropStaleContractRequired, loadPolicyRules } from "@/domain/policy";

export default async function InvoiceWorkbenchPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ reread?: string }>;
}) {
  let user;
  try {
    user = await requireSessionUser(undefined, "invoice:read");
  } catch {
    redirect("/login");
  }

  const { id } = await params;
  const { reread } = await searchParams;
  const invoice = await prisma.invoice.findFirst({
    where: { id, organizationId: user.organizationId },
    include: {
      vendor: { include: { endpoints: { where: { isActive: true }, orderBy: { version: "desc" }, take: 1 } } },
      extraction: true,
      risks: true,
      approvalRequests: { orderBy: { createdAt: "desc" }, include: { decidedBy: true } },
      paymentIntents: { orderBy: { createdAt: "desc" } },
      documents: true,
      comments: { orderBy: { createdAt: "asc" } },
      activities: { orderBy: { createdAt: "desc" } },
      installments: { orderBy: { sequence: "asc" } },
    },
  });

  if (!invoice) notFound();

  const emptyRead =
    invoice.extraction?.vendorName === "Unknown Vendor" &&
    invoice.extraction.confidence <= 0.2 &&
    Number(invoice.extraction.totalAmount) === 0;
  const closed = ["paid", "settled", "void", "payment_queued"].includes(invoice.status);
  const hasFile = invoice.documents.some((doc) => !doc.deletedAt);
  if (emptyRead && hasFile && !closed && reread !== "1") {
    try {
      const { runInvoicePipeline } = await import("@/domain/pipeline");
      await runInvoicePipeline(invoice.id, { type: "system", id: user.id });
    } catch (err) {
      console.warn("[custara] reread invoice", err instanceof Error ? err.message : err);
    }
    redirect(`/app/invoices/${invoice.id}?reread=1`);
  }

  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: user.organizationId },
    select: { mfaPayThresholdUsd: true },
  });
  await refreshLiveFxBook();
  const payThresholdUsd = org.mfaPayThresholdUsd ?? 5000;
  const payAmountUsd = convertAmount(invoice.totalAmount || 0, invoice.currency, "USD");
  const cryptoQuote =
    invoice.totalAmount != null
      ? await quoteArcSettlement(invoice.totalAmount, invoice.currency)
      : null;
  const mfaRequiredForPay = payAmountUsd >= payThresholdUsd;

  const pendingApproval = invoice.approvalRequests.find((a) => a.status === "pending");
  const latestIntent = invoice.paymentIntents[0];
  const lineItems = invoice.extraction
    ? (JSON.parse(invoice.extraction.lineItemsJson) as Array<{
        description: string;
        amount: number;
        accountCode?: string | null;
        analytic?: string | null;
        product?: string | null;
      }>)
    : [];
  let extractionMeta: { paymentTerm?: string | null; odooState?: string | null; odooPaymentState?: string | null } = {};
  try {
    extractionMeta = invoice.extraction?.rawJson ? JSON.parse(invoice.extraction.rawJson) : {};
  } catch {
    extractionMeta = {};
  }
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
  const policyRules = await loadPolicyRules(user.organizationId);
  if (!policyRules.requirePurchaseOrder) {
    await dropStaleContractRequired(user.organizationId, policyRules);
  }
  const visibleRisks = invoice.risks.filter((r) => {
    if (r.code !== "contract_required") return true;
    if (!policyRules.requirePurchaseOrder) return false;
    return !["approved", "payment_queued", "payment_sent"].includes(invoice.status);
  });
  const hardRisks = visibleRisks.filter((r) => {
    if (r.severity !== "hard") return false;
    // Allowlist live — don't keep blocking Initiate on a stale destination hold.
    if (r.code === "destination_not_allowlisted" && allowlisted) return false;
    if (r.code === "odoo_open_credit" && invoice.creditWaivedAt) return false;
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
  const openAmount = invoiceOpenAmount(invoice);
  const openCredits = invoice.vendorId
    ? await listOpenVendorCredits(user.organizationId, invoice.vendorId)
    : [];
  const relatedCredits = openCredits.filter((c) => c.id !== invoice.id);
  const po = invoice.poNumber
    ? await prisma.vendorPurchaseOrder.findUnique({
        where: {
          organizationId_poNumber: {
            organizationId: user.organizationId,
            poNumber: invoice.poNumber,
          },
        },
      })
    : null;
  const pdf = invoice.documents.find((d) => d.mimeType.includes("pdf") && !d.deletedAt);
  const auditTrail = await prisma.auditEvent.findMany({
    where: { organizationId: user.organizationId, entityId: invoice.id },
    orderBy: { createdAt: "desc" },
    take: 8,
  });

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
                  {invoice.vendorId ? (
                    <Link href={`/app/vendors/${invoice.vendorId}`} className="hover:underline">
                      {invoice.vendor?.name || invoice.extraction?.vendorName || "Unknown"}
                    </Link>
                  ) : (
                    invoice.vendor?.name || invoice.extraction?.vendorName || "Unknown"
                  )}
                </h2>
              </div>
              <span className={`badge ${statusBadgeClass(invoice.status)}`}>{invoice.status}</span>
            </div>
            <div className="mt-5 grid gap-4 sm:grid-cols-3">
              <div>
                <p className="text-xs uppercase tracking-wide text-muted">Open / residual</p>
                <p className="mt-1 font-semibold">{formatMoney(openAmount, invoice.currency)}</p>
                {invoice.totalAmount != null && Math.abs(openAmount - invoice.totalAmount) > 0.01 ? (
                  <p className="text-[0.72rem] text-muted">
                    of {formatMoney(invoice.totalAmount, invoice.currency)}
                    {invoice.creditApplied > 0 ? ` · credit ${formatMoney(invoice.creditApplied, invoice.currency)}` : ""}
                  </p>
                ) : null}
                {(() => {
                  let paymentMethod: string | null = null;
                  try {
                    paymentMethod = invoice.extraction?.rawJson
                      ? ((JSON.parse(invoice.extraction.rawJson) as { paymentMethod?: string }).paymentMethod ??
                        null)
                      : null;
                  } catch {
                    paymentMethod = null;
                  }
                  const crypto = Boolean(arcAddress) || paymentMethod === "crypto";
                  if (!crypto || !invoice.totalAmount || !cryptoQuote) return null;
                  if (cryptoQuote.sourceCurrency === "USDC" || cryptoQuote.sourceCurrency === "USD") {
                    return null;
                  }
                  if (!cryptoQuote.quoted) {
                    return (
                      <p className="mt-1 text-[0.72rem] text-muted">
                        Live USDC quote unavailable. Payment is blocked until Circle or Coinbase
                        responds.
                      </p>
                    );
                  }
                  const rate = cryptoQuote.unitsPerUsd
                    ? new Intl.NumberFormat("en-NG", {
                        style: "currency",
                        currency: cryptoQuote.sourceCurrency,
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      }).format(cryptoQuote.unitsPerUsd)
                    : null;
                  const quotedAt = cryptoQuote.fetchedAt
                    ? new Date(cryptoQuote.fetchedAt).toLocaleString("en-GB", {
                        hour: "2-digit",
                        minute: "2-digit",
                        timeZone: "UTC",
                        timeZoneName: "short",
                      })
                    : null;
                  return (
                    <p className="mt-1 text-[0.72rem] text-muted">
                      Crypto: {formatMoney(cryptoQuote.amount, "USDC")} on Arc testnet
                      {rate
                        ? ` · ${rate} / USDC · ${fxSourceLabel(cryptoQuote.source)}${quotedAt ? ` · ${quotedAt}` : ""}`
                        : ""}
                      {arcAddress ? "" : " — add a 0x wallet on the Odoo vendor bank and sync"}
                    </p>
                  );
                })()}
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
                ["Payment terms", invoice.paymentTerm || extractionMeta.paymentTerm],
                ["Tax", invoice.taxAmount != null ? formatMoney(invoice.taxAmount, invoice.currency) : null],
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
            {po ? (
              <p className="mt-4 text-sm text-muted">
                PO {po.poNumber}: received {po.receivedQty ?? "—"} of {po.orderedQty ?? "—"}
              </p>
            ) : null}
            {invoice.installments.length ? (
              <ul className="mt-3 text-sm text-muted">
                {invoice.installments.map((row) => (
                  <li key={row.id}>
                    Installment {row.sequence} · {formatDate(row.dueDate)} · {formatMoney(row.amount, invoice.currency)}
                    {row.label ? ` · ${row.label}` : ""}
                  </li>
                ))}
              </ul>
            ) : null}
            {lineItems.length ? (
              <div className="mt-4">
                <p className="text-sm font-medium">Line items</p>
                <ul className="mt-2 space-y-1 text-sm text-muted">
                  {lineItems.map((item, idx) => (
                    <li key={idx} className="flex justify-between gap-3">
                      <span>
                        {item.description}
                        {item.accountCode || item.product || item.analytic ? (
                          <span className="block text-[0.7rem]">
                            {[item.product, item.accountCode, item.analytic].filter(Boolean).join(" · ")}
                          </span>
                        ) : null}
                      </span>
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
            {visibleRisks.length === 0 ? (
              <p className="mt-3 text-sm text-muted">No risks flagged.</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {visibleRisks.map((risk) => {
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

          {relatedCredits.length && !invoice.externalId?.startsWith("odoo-refund:") ? (
            <div className="card p-5">
              <h3 className="app-h">Open credits</h3>
              <p className="app-sub">Apply a credit to reduce residual, or waive to pay the full open amount.</p>
              {relatedCredits.map((credit) => (
                <div key={credit.id} className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm">
                  <Link href={`/app/invoices/${credit.id}`} className="text-accent hover:underline">
                    {credit.invoiceNumber || credit.externalId} · {formatMoney(invoiceOpenAmount(credit), credit.currency)}
                  </Link>
                  <InvoiceActionForm action="apply_credit">
                    <input type="hidden" name="invoiceId" value={invoice.id} />
                    <input type="hidden" name="creditInvoiceId" value={credit.id} />
                    <button type="submit" className="btn btn-secondary">
                      Apply
                    </button>
                  </InvoiceActionForm>
                </div>
              ))}
              {!invoice.creditWaivedAt ? (
                <InvoiceActionForm action="waive_credit" className="mt-3">
                  <input type="hidden" name="invoiceId" value={invoice.id} />
                  <button type="submit" className="btn btn-secondary">
                    Waive and pay full residual
                  </button>
                </InvoiceActionForm>
              ) : (
                <p className="mt-2 text-[0.72rem] text-muted">Credits waived for this bill.</p>
              )}
            </div>
          ) : null}

          {invoice.status === "approved" && canPay(user.role) ? (
            <div className="card p-5">
              <h3 className="app-h">Create payment intent</h3>
              {mfaRequiredForPay && !user.mfaEnabled ? (
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
              {mfaRequiredForPay && !user.mfaEnabled ? null : (
                <InvoiceActionForm
                  action="create_payment"
                  className="mt-4 space-y-3"
                  disabled={hardRisks.length > 0}
                >
                  <input type="hidden" name="invoiceId" value={invoice.id} />
                  <input
                    type="hidden"
                    name="idempotencyKey"
                    value={`pay_${invoice.id}_${invoice.invoiceNumber || "x"}_${openAmount}`}
                  />
                  <label className="block text-sm">
                    Amount to pay ({invoice.currency})
                    <input
                      name="amount"
                      type="number"
                      step="0.01"
                      min="0.01"
                      max={openAmount}
                      className="input mt-1"
                      defaultValue={openAmount}
                    />
                  </label>
                  {mfaRequiredForPay ? (
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
                  ) : null}
                  <button
                    type="submit"
                    className="btn btn-primary w-full"
                    disabled={hardRisks.length > 0}
                  >
                    Initiate payment
                  </button>
                </InvoiceActionForm>
              )}
            </div>
          ) : null}

          {invoice.paymentIntents.length ? (
            <div className="card p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="app-h">Payments</h3>
                {latestIntent ? (
                  <Link href={`/app/receipts/${latestIntent.id}`} className="dash-link">
                    Full receipt
                  </Link>
                ) : null}
              </div>
              <ul className="mt-2 space-y-2 text-sm">
                {invoice.paymentIntents.map((intent) => (
                  <li key={intent.id}>
                    <span className={`badge ${statusBadgeClass(intent.status)}`}>{intent.status.replace(/_/g, " ")}</span>
                    <span className="ml-2 text-muted">
                      {formatMoney(intent.amount, intent.currency)} · {formatDate(intent.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
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
            {pdf ? (
              <iframe
                title={pdf.filename}
                className="mt-3 h-80 w-full rounded-xl border border-line"
                src={`/api/internal/invoices/${invoice.id}/documents/${pdf.id}`}
              />
            ) : null}
            <ul className="mt-3 space-y-1 text-sm text-muted">
              {invoice.documents.map((doc) => (
                <li key={doc.id}>
                  <a
                    className="text-accent hover:underline"
                    href={`/api/internal/invoices/${invoice.id}/documents/${doc.id}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {doc.filename}
                  </a>{" "}
                  · {(doc.byteSize / 1024).toFixed(1)} KB
                  {doc.retainedUntil ? ` · privacy delete by ${formatDate(doc.retainedUntil)}` : ""}
                </li>
              ))}
            </ul>
          </div>

          <div className="card p-5">
            <h3 className="app-h">Comments</h3>
            <ul className="mt-3 space-y-2 text-sm">
              {invoice.comments.map((row) => (
                <li key={row.id} className="rounded-xl border border-line px-3 py-2">
                  <p>{row.body}</p>
                  <p className="text-[0.7rem] text-muted">
                    {formatDate(row.createdAt)}
                    {row.postedToOdoo ? " · posted to Odoo" : ""}
                  </p>
                </li>
              ))}
              {!invoice.comments.length ? <li className="text-muted">No comments yet.</li> : null}
            </ul>
            <InvoiceActionForm action="add_comment" className="mt-3 space-y-2">
              <input type="hidden" name="invoiceId" value={invoice.id} />
              <textarea name="body" className="input" rows={2} placeholder="Internal note" required />
              <button type="submit" className="btn btn-secondary">
                Add comment
              </button>
            </InvoiceActionForm>
          </div>

          <div className="card p-5">
            <h3 className="app-h">Activities</h3>
            <ul className="mt-3 space-y-2 text-sm">
              {invoice.activities.map((row) => (
                <li key={row.id} className="flex items-center justify-between gap-2">
                  <span>
                    {row.title}
                    {row.dueAt ? ` · due ${formatDate(row.dueAt)}` : ""}
                    <span className="text-muted"> · {row.status}</span>
                  </span>
                  {row.status === "open" ? (
                    <InvoiceActionForm action="complete_activity">
                      <input type="hidden" name="invoiceId" value={invoice.id} />
                      <input type="hidden" name="activityId" value={row.id} />
                      <button type="submit" className="btn btn-secondary">
                        Done
                      </button>
                    </InvoiceActionForm>
                  ) : null}
                </li>
              ))}
            </ul>
            <InvoiceActionForm action="add_activity" className="mt-3 grid gap-2">
              <input type="hidden" name="invoiceId" value={invoice.id} />
              <input name="title" className="input" placeholder="Need W-9 / Confirm GRN" required />
              <input name="dueAt" type="date" className="input" />
              <button type="submit" className="btn btn-secondary">
                Add activity
              </button>
            </InvoiceActionForm>
            <InvoiceActionForm action="set_hold" className="mt-4 grid gap-2">
              <input type="hidden" name="invoiceId" value={invoice.id} />
              <input
                name="holdReason"
                className="input"
                placeholder="Hold reason (price / qty / missing PO)"
                defaultValue={invoice.holdReason || ""}
              />
              <button type="submit" className="btn btn-secondary">
                Set hold
              </button>
            </InvoiceActionForm>
            <InvoiceActionForm action="set_recurring" className="mt-4 grid gap-2">
              <input type="hidden" name="invoiceId" value={invoice.id} />
              <select name="recurringInterval" className="input" defaultValue={invoice.recurringInterval || ""}>
                <option value="">Not recurring</option>
                <option value="monthly">Monthly</option>
                <option value="weekly">Weekly</option>
              </select>
              <button type="submit" className="btn btn-secondary">
                Save recurrence
              </button>
            </InvoiceActionForm>
            {invoice.recurringInterval ? (
              <InvoiceActionForm action="spawn_recurring" className="mt-2">
                <input type="hidden" name="invoiceId" value={invoice.id} />
                <button type="submit" className="btn btn-secondary">
                  Create next occurrence
                </button>
              </InvoiceActionForm>
            ) : null}
          </div>

          {auditTrail.length ? (
            <div className="card p-5">
              <h3 className="app-h">Timeline</h3>
              <ul className="mt-3 space-y-1 text-[0.78rem] text-muted">
                {auditTrail.map((row) => (
                  <li key={row.id}>
                    {formatDate(row.createdAt)} · {row.action}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>
    </AppShell>
  );
}
