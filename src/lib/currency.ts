/** Display + FX helpers. Payments always use the invoice's own currency. */

export const DEFAULT_DISPLAY_CURRENCY = "USD";

/** Currencies offered in the dashboard / settings toggle. */
export const DISPLAY_CURRENCIES = [
  { code: "USD", label: "US Dollar (USD)" },
  { code: "EUR", label: "Euro (EUR)" },
  { code: "GBP", label: "British Pound (GBP)" },
  { code: "NGN", label: "Nigerian Naira (NGN)" },
  { code: "GHS", label: "Ghanaian Cedi (GHS)" },
  { code: "KES", label: "Kenyan Shilling (KES)" },
  { code: "ZAR", label: "South African Rand (ZAR)" },
  { code: "CAD", label: "Canadian Dollar (CAD)" },
  { code: "AUD", label: "Australian Dollar (AUD)" },
  { code: "INR", label: "Indian Rupee (INR)" },
  { code: "USDC", label: "USDC" },
] as const;

export type DisplayCurrencyCode = (typeof DISPLAY_CURRENCIES)[number]["code"];

/** ISO-2 country → default local currency. */
export const COUNTRY_CURRENCY: Record<string, string> = {
  US: "USD",
  GB: "GBP",
  NG: "NGN",
  GH: "GHS",
  KE: "KES",
  ZA: "ZAR",
  CA: "CAD",
  AU: "AUD",
  IN: "INR",
  DE: "EUR",
  FR: "EUR",
  NL: "EUR",
  IE: "EUR",
  ES: "EUR",
  IT: "EUR",
  PT: "EUR",
  BE: "EUR",
  AT: "EUR",
  FI: "EUR",
  LU: "EUR",
  EE: "EUR",
  LV: "EUR",
  LT: "EUR",
  SK: "EUR",
  SI: "EUR",
  CY: "EUR",
  MT: "EUR",
  HR: "EUR",
  GR: "EUR",
};

export const COUNTRY_OPTIONS = [
  { code: "US", label: "United States" },
  { code: "GB", label: "United Kingdom" },
  { code: "NG", label: "Nigeria" },
  { code: "GH", label: "Ghana" },
  { code: "KE", label: "Kenya" },
  { code: "ZA", label: "South Africa" },
  { code: "CA", label: "Canada" },
  { code: "AU", label: "Australia" },
  { code: "IN", label: "India" },
  { code: "DE", label: "Germany" },
  { code: "FR", label: "France" },
  { code: "NL", label: "Netherlands" },
  { code: "IE", label: "Ireland" },
  { code: "ES", label: "Spain" },
  { code: "IT", label: "Italy" },
] as const;

/**
 * Approximate units of currency per 1 USD (display conversion only).
 * Not for settlement — payments stay in invoice currency.
 */
const UNITS_PER_USD: Record<string, number> = {
  USD: 1,
  USDC: 1,
  USDT: 1,
  EURC: 1,
  EUR: 0.92,
  GBP: 0.79,
  NGN: 1600,
  GHS: 15.5,
  KES: 129,
  ZAR: 18.5,
  CAD: 1.36,
  AUD: 1.53,
  INR: 83,
};

export function currencyFromCountry(country: string | null | undefined): string {
  const code = (country || "").trim().toUpperCase().slice(0, 2);
  if (!code) return DEFAULT_DISPLAY_CURRENCY;
  return COUNTRY_CURRENCY[code] || DEFAULT_DISPLAY_CURRENCY;
}

export function normalizeCurrency(code: string | null | undefined): string {
  const c = (code || "").trim().toUpperCase();
  return c || DEFAULT_DISPLAY_CURRENCY;
}

export function isKnownDisplayCurrency(code: string): boolean {
  return DISPLAY_CURRENCIES.some((c) => c.code === code);
}

/** Resolve org dashboard display currency: explicit preference → country → USD. */
export function resolveDisplayCurrency(org: {
  displayCurrency?: string | null;
  country?: string | null;
}): string {
  const explicit = (org.displayCurrency || "").trim().toUpperCase();
  if (explicit) return explicit;
  return currencyFromCountry(org.country);
}

export function convertAmount(
  amount: number,
  fromCurrency: string | null | undefined,
  toCurrency: string | null | undefined,
): number {
  const from = normalizeCurrency(fromCurrency);
  const to = normalizeCurrency(toCurrency);
  if (from === to) return amount;
  const fromRate = UNITS_PER_USD[from];
  const toRate = UNITS_PER_USD[to];
  if (!fromRate || !toRate) {
    // Unknown pair: return as-is rather than inventing a rate
    return amount;
  }
  const inUsd = amount / fromRate;
  return inUsd * toRate;
}

export function sumInCurrency(
  rows: { amount: number | null | undefined; currency: string | null | undefined }[],
  displayCurrency: string,
): number {
  return rows.reduce(
    (acc, row) => acc + convertAmount(row.amount || 0, row.currency, displayCurrency),
    0,
  );
}
