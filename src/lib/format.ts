export function statusBadgeClass(status: string) {
  switch (status) {
    case "approved":
    case "reconciled":
    case "settled":
    case "payment_sent":
    case "connected":
    case "active":
      return "bg-accent-soft text-accent";
    case "pending_approval":
    case "needs_review":
    case "payment_queued":
    case "pending":
      return "bg-amber-50 text-warn";
    case "rejected":
    case "duplicate_suspected":
    case "on_hold":
    case "error":
    case "disconnected":
    case "payment_failed":
      return "bg-red-50 text-danger";
    default:
      return "bg-slate-100 text-muted";
  }
}

const CRYPTO_OR_STABLE = new Set(["USDC", "USDT", "EURC", "DAI"]);

export function formatMoney(amount: number | null | undefined, currency = "NGN") {
  if (amount == null) return "—";
  const code = (currency || "NGN").toUpperCase();

  // Stablecoins / non-ISO codes are not valid Intl currency identifiers
  if (CRYPTO_OR_STABLE.has(code)) {
    return `${new Intl.NumberFormat("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount)} ${code}`;
  }

  try {
    const fractionDigits = code === "USD" || code === "EUR" || code === "GBP" ? 2 : 0;
    return new Intl.NumberFormat(code === "NGN" ? "en-NG" : "en-US", {
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
