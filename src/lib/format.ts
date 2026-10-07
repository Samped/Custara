export function statusBadgeClass(status: string) {
  switch (status) {
    case "approved":
    case "reconciled":
    case "settled":
    case "payment_sent":
    case "completed":
    case "exported":
    case "connected":
    case "active":
      return "bg-accent-soft text-accent";
    case "pending_approval":
    case "needs_review":
    case "payment_queued":
    case "pending_transfer":
    case "pending":
    case "queued":
      return "bg-amber-50 text-warn";
    case "rejected":
    case "duplicate_suspected":
    case "on_hold":
    case "error":
    case "payment_failed":
    case "failed":
      return "bg-red-50 text-danger";
    case "disconnected":
      return "bg-slate-100 text-muted";
    default:
      return "bg-slate-100 text-muted";
  }
}

/** Human labels for integration connector types. */
export function connectorTypeLabel(type: string) {
  switch (type) {
    case "mailbox_imap":
      return "Email inbox";
    case "sftp_drop":
      return "SFTP drop";
    case "accounting_xero":
      return "Xero";
    case "accounting_qbo":
      return "QuickBooks";
    case "accounting_sage":
      return "Sage";
    case "accounting_zoho":
      return "Zoho Books";
    case "einvoice_firs":
      return "FIRS e-invoice";
    case "whatsapp_business":
      return "WhatsApp";
    default:
      return type.replace(/_/g, " ");
  }
}

/** Operator-facing connector status. */
export function connectorStatusLabel(status: string) {
  switch (status) {
    case "connected":
      return "Connected";
    case "disconnected":
      return "Not set up";
    case "error":
      return "Error";
    default:
      return status.replace(/_/g, " ");
  }
}

/** Short labels for payment intent rows. */
export function paymentStatusLabel(status: string) {
  switch (status) {
    case "completed":
      return "Paid";
    case "pending_transfer":
    case "queued":
      return "Sending";
    case "failed":
      return "Failed";
    case "exported":
      return "Exported";
    default:
      return status.replace(/_/g, " ");
  }
}

/** Operator-facing failure copy — never dump raw Circle SDK blobs in the UI. */
export function humanizePaymentFailure(reason: string | null | undefined): string | null {
  if (!reason?.trim()) return null;
  const r = reason.toLowerCase();
  if (r.includes("idempotency")) return "Transfer rejected — retry with a fresh attempt.";
  if (r.includes("entitysecret") || r.includes("ciphertext")) {
    return "Circle signing misconfigured. Check entity secret, then retry.";
  }
  if (r.includes("insufficient") || r.includes("balance")) {
    return "Agent wallet balance too low. Fund and Sync, then retry.";
  }
  if (r.includes("allowlist") || r.includes("destination")) {
    return "Destination not allowlisted. Confirm on the invoice, then retry.";
  }
  if (r.includes("already completed") || r.includes("payment already")) {
    return null;
  }
  // Truncate noisy dual SDK/REST dumps
  const cut = reason.split(" — SDK:")[0].split("; REST:")[0].trim();
  return cut.length > 90 ? `${cut.slice(0, 90)}…` : cut;
}

export function shortHash(value: string | null | undefined, head = 10, tail = 4) {
  if (!value) return null;
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

const CRYPTO_OR_STABLE = new Set(["USDC", "USDT", "EURC", "DAI"]);

export function formatMoney(amount: number | null | undefined, currency = "USD") {
  if (amount == null) return "—";
  const code = (currency || "USD").toUpperCase();

  // Stablecoins / non-ISO codes are not valid Intl currency identifiers
  if (CRYPTO_OR_STABLE.has(code)) {
    return `${new Intl.NumberFormat("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount)} ${code}`;
  }

  try {
    const fractionDigits =
      code === "USD" || code === "EUR" || code === "GBP" || code === "CAD" || code === "AUD" ? 2 : 0;
    const locale =
      code === "NGN" ? "en-NG" : code === "GBP" ? "en-GB" : code === "EUR" ? "en-IE" : "en-US";
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: code,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).format(amount);
  } catch {
    return `${new Intl.NumberFormat("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount)} ${code}`;
  }
}

export function formatDate(value: Date | string | null | undefined) {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
