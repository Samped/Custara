/** Public origin for this deployment. Testnet keeps current data; apex is mainnet. */

export const TESTNET_HOST = "testnet.custara.xyz";
export const APEX_HOST = "custara.xyz";

export function publicAppUrl() {
  const raw = (process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "");
  if (raw) return raw;
  if (getArcChainSafe() === "ARC") return `https://${APEX_HOST}`;
  return `https://${TESTNET_HOST}`;
}

function getArcChainSafe() {
  const raw = (process.env.ARC_CHAIN || "ARC-TESTNET").toUpperCase();
  return raw === "ARC" || raw === "ARC-MAINNET" ? "ARC" : "ARC-TESTNET";
}

export function hostFromHeaders(hostHeader?: string | null) {
  return (hostHeader || "").split(":")[0].toLowerCase();
}

export function isApexHost(host?: string | null) {
  const h = hostFromHeaders(host);
  return h === APEX_HOST || h === `www.${APEX_HOST}`;
}

export function isTestnetHost(host?: string | null) {
  return hostFromHeaders(host) === TESTNET_HOST;
}

/** During cutover, send apex traffic to the testnet stack so nobody pays on a half-moved DB. */
export function shouldRedirectApexToTestnet() {
  return process.env.REDIRECT_APEX_TO_TESTNET === "true";
}
