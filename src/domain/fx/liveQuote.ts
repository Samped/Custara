/**
 * Live FX for display and Arc settlement.
 * Never invent a naira (or other fiat) rate. Settlement fails closed if no quote returns.
 *
 * Order:
 * 1. Circle CPN quote for NGN/USDC when CIRCLE_API_KEY can reach that corridor
 * 2. Circle Mint reference quote for Mint-enabled pairs
 * 3. Coinbase spot (USD book, includes NGN)
 * 4. open.er-api.com, then ECB Frankfurter
 *
 * USDC is 1:1 with USD (Circle mint/redeem at par).
 */

import { circleApiBase, getArcChain } from "@/domain/arc/config";
import {
  fxBookIsFresh,
  normalizeCurrency,
  peekFxBook,
  replaceFxBook,
  settleArcAmount,
  type ArcSettlement,
  type FxBook,
  type FxSource,
} from "@/lib/currency";

const CACHE_TTL_MS = Math.max(15_000, Number(process.env.FX_CACHE_TTL_MS || 60_000) || 60_000);
const FETCH_MS = 7_000;

const PAR_USD = new Set(["USD", "USDC", "USDT"]);

/** Fiat Circle Mint will quote against USDC (account must have the corridor). */
const CIRCLE_MINT_FIAT = new Set(["MXN", "BRL", "HKD", "SGD"]);

export type LiveFxRefresh = FxBook & { ok: boolean };

type Json = Record<string, unknown>;

async function fetchJson(
  url: string,
  init: RequestInit = {},
  timeoutMs = FETCH_MS,
): Promise<{ ok: boolean; status: number; body: Json }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = new Headers(init.headers);
    if (!headers.has("User-Agent")) headers.set("User-Agent", "Custara/1.0");
    const res = await fetch(url, {
      ...init,
      headers,
      signal: ctrl.signal,
      cache: "no-store",
    });
    const body = (await res.json().catch(() => ({}))) as Json;
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function parsePositive(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(String(value ?? "").replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function mergeRates(
  target: Record<string, number>,
  sources: Record<string, FxSource>,
  incoming: Record<string, number>,
  source: FxSource,
  { overwrite = false }: { overwrite?: boolean } = {},
) {
  for (const [code, units] of Object.entries(incoming)) {
    const key = normalizeCurrency(code);
    if (PAR_USD.has(key)) continue;
    if (!overwrite && target[key]) continue;
    target[key] = units;
    sources[key] = source;
  }
}

async function fetchCoinbaseUsdBook(): Promise<Record<string, number> | null> {
  const [bookRes, usdcNgn] = await Promise.all([
    fetchJson("https://api.coinbase.com/v2/exchange-rates?currency=USD", {}, 3_500),
    fetchJson("https://api.coinbase.com/v2/prices/USDC-NGN/spot", {}, 3_500),
  ]);
  const out: Record<string, number> = {};
  if (bookRes.ok) {
    const data = bookRes.body.data as { rates?: Record<string, string> } | undefined;
    for (const [code, raw] of Object.entries(data?.rates || {})) {
      const n = parsePositive(raw);
      if (n) out[normalizeCurrency(code)] = n;
    }
  }
  const spot = parsePositive((usdcNgn.body.data as { amount?: unknown } | undefined)?.amount);
  if (usdcNgn.ok && spot) out.NGN = spot;
  return Object.keys(out).length ? out : null;
}

async function fetchCoinGeckoUsdcBook(): Promise<Record<string, number> | null> {
  const res = await fetchJson(
    "https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=ngn,usd,eur,gbp,ghs,kes,zar,inr,cad,aud",
    {},
    3_500,
  );
  if (!res.ok) return null;
  const row = (res.body["usd-coin"] || res.body) as Record<string, number>;
  const out: Record<string, number> = {};
  for (const [code, raw] of Object.entries(row || {})) {
    const n = parsePositive(raw);
    if (n && normalizeCurrency(code) !== "USD") out[normalizeCurrency(code)] = n;
  }
  return Object.keys(out).length ? out : null;
}

async function fetchOpenExchangeUsdBook(): Promise<Record<string, number> | null> {
  const res = await fetchJson("https://open.er-api.com/v6/latest/USD");
  if (!res.ok) return null;
  const rates = res.body.rates as Record<string, number> | undefined;
  if (!rates) return null;
  const out: Record<string, number> = {};
  for (const [code, raw] of Object.entries(rates)) {
    const n = parsePositive(raw);
    if (n) out[normalizeCurrency(code)] = n;
  }
  return Object.keys(out).length ? out : null;
}

async function fetchFrankfurterUsdBook(): Promise<Record<string, number> | null> {
  const res = await fetchJson("https://api.frankfurter.app/latest?from=USD");
  if (!res.ok) return null;
  const rates = res.body.rates as Record<string, number> | undefined;
  if (!rates) return null;
  const out: Record<string, number> = {};
  for (const [code, raw] of Object.entries(rates)) {
    const n = parsePositive(raw);
    if (n) out[normalizeCurrency(code)] = n;
  }
  return Object.keys(out).length ? out : null;
}

function cpnBlockchain() {
  return getArcChain() === "ARC" ? "ETH" : "ETH-SEPOLIA";
}

function readCircleQuoteRate(quote: Json | undefined): { unitsPerUsd: number; quoteId?: string } | null {
  if (!quote) return null;
  const quoteId = typeof quote.id === "string" ? quote.id : undefined;
  const exchange = quote.exchangeRate as { pair?: string; rate?: unknown } | undefined;
  const raw = quote.rawExchangeRate as { pair?: string; rate?: unknown } | undefined;
  const pair = String(exchange?.pair || raw?.pair || "").toUpperCase();
  const rate = parsePositive(exchange?.rate) || parsePositive(raw?.rate);
  if (rate && (pair === "USDC/NGN" || pair.endsWith("/NGN") || pair.startsWith("USD/"))) {
    return { unitsPerUsd: rate, quoteId };
  }
  const src = quote.sourceAmount as { amount?: unknown; currency?: string } | undefined;
  const dst = quote.destinationAmount as { amount?: unknown; currency?: string } | undefined;
  const srcAmt = parsePositive(src?.amount);
  const dstAmt = parsePositive(dst?.amount);
  const srcCur = normalizeCurrency(src?.currency);
  const dstCur = normalizeCurrency(dst?.currency);
  if (srcAmt && dstAmt && srcCur === "USDC" && dstCur === "NGN") {
    return { unitsPerUsd: dstAmt / srcAmt, quoteId };
  }
  if (rate) return { unitsPerUsd: rate, quoteId };
  return null;
}

/** Circle Crypto Payment Network — executable NGN corridor when the account has it. */
async function fetchCircleCpnNgn(): Promise<{ unitsPerUsd: number; quoteId?: string } | null> {
  const apiKey = process.env.CIRCLE_API_KEY?.trim();
  if (!apiKey) return null;
  try {
    const res = await fetchJson(`${circleApiBase()}/v1/cpn/quotes`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        senderCountry: "NG",
        destinationCountry: "NG",
        sourceAmount: { amount: "", currency: "USDC" },
        destinationAmount: { amount: "10000", currency: "NGN" },
        blockchain: cpnBlockchain(),
        senderType: "BUSINESS",
        recipientType: "BUSINESS",
        paymentMethodType: "BANK-TRANSFER",
        transactionVersion: "VERSION_2",
      }),
    });
    if (!res.ok) return null;
    const data = res.body.data;
    const quote = Array.isArray(data) ? (data[0] as Json) : (data as Json);
    return readCircleQuoteRate(quote);
  } catch {
    return null;
  }
}

/** Circle Mint indicative quote. NGN is not on this API. */
async function fetchCircleMintReference(currency: string): Promise<number | null> {
  const apiKey = process.env.CIRCLE_API_KEY?.trim();
  if (!apiKey) return null;
  const code = normalizeCurrency(currency);
  if (!CIRCLE_MINT_FIAT.has(code)) return null;
  try {
    const res = await fetchJson(`${circleApiBase()}/v1/exchange/quotes`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "reference",
        from: { currency: code, amount: "100.00" },
        to: { currency: "USDC" },
      }),
    });
    if (!res.ok) return null;
    const data = (res.body.data || res.body) as Json;
    const rate = parsePositive(data.rate);
    if (rate) return rate;
    const fromAmt = parsePositive((data.from as { amount?: unknown } | undefined)?.amount);
    const toAmt = parsePositive((data.to as { amount?: unknown } | undefined)?.amount);
    if (fromAmt && toAmt) return fromAmt / toAmt;
    return null;
  } catch {
    return null;
  }
}

export async function refreshLiveFxBook(opts?: { force?: boolean }): Promise<LiveFxRefresh> {
  if (!opts?.force) {
    const existing = peekFxBook();
    if (existing && fxBookIsFresh(existing)) return { ...existing, ok: true };
  }

  const unitsPerUsd: Record<string, number> = { USD: 1, USDC: 1, USDT: 1 };
  const sources: Record<string, FxSource> = {
    USD: "identity",
    USDC: "circle_par",
    USDT: "circle_par",
  };

  const [coinbase, gecko, openEr, frankfurter, circleNgn, mintMxn, mintBrl, mintHkd, mintSgd] =
    await Promise.all([
      fetchCoinbaseUsdBook().catch(() => null),
      fetchCoinGeckoUsdcBook().catch(() => null),
      fetchOpenExchangeUsdBook().catch(() => null),
      fetchFrankfurterUsdBook().catch(() => null),
      fetchCircleCpnNgn().catch(() => null),
      fetchCircleMintReference("MXN").catch(() => null),
      fetchCircleMintReference("BRL").catch(() => null),
      fetchCircleMintReference("HKD").catch(() => null),
      fetchCircleMintReference("SGD").catch(() => null),
    ]);

  if (frankfurter) mergeRates(unitsPerUsd, sources, frankfurter, "ecb_frankfurter");
  if (openEr) mergeRates(unitsPerUsd, sources, openEr, "open_er");
  if (gecko) mergeRates(unitsPerUsd, sources, gecko, "coingecko", { overwrite: true });
  if (coinbase) mergeRates(unitsPerUsd, sources, coinbase, "coinbase", { overwrite: true });

  if (mintMxn) mergeRates(unitsPerUsd, sources, { MXN: mintMxn }, "circle_mint", { overwrite: true });
  if (mintBrl) mergeRates(unitsPerUsd, sources, { BRL: mintBrl }, "circle_mint", { overwrite: true });
  if (mintHkd) mergeRates(unitsPerUsd, sources, { HKD: mintHkd }, "circle_mint", { overwrite: true });
  if (mintSgd) mergeRates(unitsPerUsd, sources, { SGD: mintSgd }, "circle_mint", { overwrite: true });
  if (circleNgn) {
    mergeRates(unitsPerUsd, sources, { NGN: circleNgn.unitsPerUsd }, "circle_cpn", { overwrite: true });
  }

  const fiatKeys = Object.keys(unitsPerUsd).filter((k) => !PAR_USD.has(k));
  const ok = fiatKeys.length > 0;
  if (!ok) {
    const previous = peekFxBook();
    if (previous) return { ...previous, ok: false };
  }
  const now = Date.now();
  const book = replaceFxBook({
    unitsPerUsd,
    sources,
    fetchedAt: new Date(now).toISOString(),
    expiresAt: now + CACHE_TTL_MS,
    quoteId: circleNgn?.quoteId,
  });
  return { ...book, ok };
}

/** Fresh quote at pay time. Display may use the 60s cache. */
export async function quoteArcSettlement(
  amount: number,
  currency: string | null | undefined,
  opts?: { fresh?: boolean },
): Promise<ArcSettlement> {
  const book = await refreshLiveFxBook({ force: Boolean(opts?.fresh) });
  const quote = settleArcAmount(amount, currency);
  if (quote.sourceCurrency === "USD" || quote.sourceCurrency === "USDC") return quote;
  if (opts?.fresh && !book.ok) {
    return { ...quote, amount: 0, quoted: false };
  }
  return quote;
}

export function fxSourceLabel(source: FxSource | undefined) {
  switch (source) {
    case "circle_cpn":
      return "Circle CPN";
    case "circle_mint":
      return "Circle Mint";
    case "circle_par":
      return "Circle USDC par";
    case "coinbase":
      return "Coinbase";
    case "coingecko":
      return "CoinGecko";
    case "open_er":
      return "Open Exchange Rates";
    case "ecb_frankfurter":
      return "ECB";
    case "identity":
      return "1:1";
    default:
      return "Live FX";
  }
}
