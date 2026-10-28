/** Workspace location features. Company of record — not GPS or IP. */

/** Fiat PAJ currently ramps (African local currencies). USD is listed by PAJ but is not a bank-rail gate. */
export const PAJ_FIAT_CURRENCIES = ["NGN", "GHS", "TZS", "KES", "ZAR"] as const;

const COUNTRY_ALIASES: Record<string, string> = {
  NG: "NG",
  NGA: "NG",
  NIGERIA: "NG",
  GH: "GH",
  GHA: "GH",
  GHANA: "GH",
  KE: "KE",
  KEN: "KE",
  KENYA: "KE",
  TZ: "TZ",
  TZA: "TZ",
  TANZANIA: "TZ",
  ZA: "ZA",
  ZAF: "ZA",
  SOUTHAFRICA: "ZA",
  "SOUTH AFRICA": "ZA",
};

const COUNTRY_TO_CURRENCY: Record<string, string> = {
  NG: "NGN",
  GH: "GHS",
  TZ: "TZS",
  KE: "KES",
  ZA: "ZAR",
};

const CURRENCY_TO_COUNTRY: Record<string, string> = {
  NGN: "NG",
  GHS: "GH",
  TZS: "TZ",
  KES: "KE",
  ZAR: "ZA",
};

function normalizeCountry(country?: string | null) {
  return (country || "").trim().toUpperCase().replace(/\s+/g, " ");
}

export function pajCountryCode(org: {
  country?: string | null;
  displayCurrency?: string | null;
}): string | null {
  const country = COUNTRY_ALIASES[normalizeCountry(org.country)];
  if (country) return country;
  const currency = (org.displayCurrency || "").trim().toUpperCase();
  return CURRENCY_TO_COUNTRY[currency] || null;
}

export function pajFiatCurrency(org: {
  country?: string | null;
  displayCurrency?: string | null;
}): string | null {
  const country = pajCountryCode(org);
  if (country) return COUNTRY_TO_CURRENCY[country];
  const currency = (org.displayCurrency || "").trim().toUpperCase();
  return (PAJ_FIAT_CURRENCIES as readonly string[]).includes(currency) ? currency : null;
}

/** True when the company of record is in a PAJ African bank market. */
export function isPajBankWorkspace(org: {
  country?: string | null;
  displayCurrency?: string | null;
}) {
  return pajFiatCurrency(org) != null;
}

/** True when the company of record is Nigeria (ISO code, name, or NGN books). */
export function isNigeriaWorkspace(org: {
  country?: string | null;
  displayCurrency?: string | null;
}) {
  return pajCountryCode(org) === "NG";
}
