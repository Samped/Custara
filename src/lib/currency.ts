/** Display FX and crypto settlement. Rates come from a live book — never a hardcoded NGN peg. */

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

export type FxSource =
  | "identity"
  | "circle_par"
  | "circle_cpn"
  | "circle_mint"
  | "coinbase"
  | "coingecko"
  | "open_er"
  | "ecb_frankfurter"
  | "test";

export type FxBook = {
  unitsPerUsd: Record<string, number>;
  sources: Record<string, FxSource>;
  fetchedAt: string;
  expiresAt: number;
  quoteId?: string;
};

const PAR: Record<string, number> = { USD: 1, USDC: 1, USDT: 1 };

let liveBook: FxBook | null = null;

export function peekFxBook(): FxBook | null {
  return liveBook;
}

export function fxBookIsFresh(book: FxBook | null = liveBook, now = Date.now()) {
  return Boolean(book && book.expiresAt > now);
}

export function replaceFxBook(book: FxBook): FxBook {
  liveBook = book;
  return book;
}

/** Tests only — never a production settlement path. */
export function setFxBookForTests(unitsPerUsd: Record<string, number>, ttlMs = 60_000) {
  const sources: Record<string, FxSource> = {};
  for (const code of Object.keys(unitsPerUsd)) sources[code] = "test";
  return replaceFxBook({
    unitsPerUsd: { ...PAR, ...unitsPerUsd },
    sources: { USD: "identity", USDC: "circle_par", USDT: "circle_par", ...sources },
    fetchedAt: new Date().toISOString(),
    expiresAt: Date.now() + ttlMs,
  });
}

export function clearFxBookForTests() {
  liveBook = null;
}

function unitsPerUsd(currency: string): number | undefined {
  const code = normalizeCurrency(currency);
  if (PAR[code]) return PAR[code];
  return liveBook?.unitsPerUsd[code];
}

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

export type ArcSettlement = {
  amount: number;
  currency: "USDC";
  sourceAmount: number;
  sourceCurrency: string;
  quoted: boolean;
  unitsPerUsd?: number;
  source?: FxSource;
  fetchedAt?: string;
  quoteId?: string;
};

/** USDC to send on Arc when the bill is in another currency. Requires a live book. */
export function settleArcAmount(amount: number, currency: string | null | undefined): ArcSettlement {
  const sourceCurrency = normalizeCurrency(currency || "NGN");
  if (sourceCurrency === "USDC" || sourceCurrency === "USD") {
    return {
      amount,
      currency: "USDC",
      sourceAmount: amount,
      sourceCurrency,
      quoted: true,
      unitsPerUsd: 1,
      source: sourceCurrency === "USDC" ? "circle_par" : "identity",
    };
  }
  const rate = unitsPerUsd(sourceCurrency);
  const book = peekFxBook();
  if (!rate) {
    return {
      amount: 0,
      currency: "USDC",
      sourceAmount: amount,
      sourceCurrency,
      quoted: false,
    };
  }
  const converted = amount / rate;
  return {
    amount: Math.round(converted * 1e6) / 1e6,
    currency: "USDC",
    sourceAmount: amount,
    sourceCurrency,
    quoted: true,
    unitsPerUsd: rate,
    source: book?.sources[sourceCurrency],
    fetchedAt: book?.fetchedAt,
    quoteId: book?.quoteId,
  };
}

export function convertAmount(
  amount: number,
  fromCurrency: string | null | undefined,
  toCurrency: string | null | undefined,
): number {
  const from = normalizeCurrency(fromCurrency);
  const to = normalizeCurrency(toCurrency);
  if (from === to) return amount;
  const fromRate = unitsPerUsd(from);
  const toRate = unitsPerUsd(to);
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
