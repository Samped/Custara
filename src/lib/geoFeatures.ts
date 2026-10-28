/** Workspace location features. Company of record — not GPS or IP. */

function normalizeCountry(country?: string | null) {
  return (country || "").trim().toUpperCase();
}

/** True when the company of record is Nigeria (ISO code, name, or NGN books). */
export function isNigeriaWorkspace(org: {
  country?: string | null;
  displayCurrency?: string | null;
}) {
  const country = normalizeCountry(org.country);
  if (country === "NG" || country === "NGA" || country === "NIGERIA") return true;
  return (org.displayCurrency || "").trim().toUpperCase() === "NGN";
}
