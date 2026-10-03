/** Arc / Circle configuration — USDC address comes from env, never hardcoded blindly. */

export type ArcChain = "ARC-TESTNET" | "ARC";

export function getArcChain(): ArcChain {
  const raw = (process.env.ARC_CHAIN || "ARC-TESTNET").toUpperCase();
  return raw === "ARC" || raw === "ARC-MAINNET" ? "ARC" : "ARC-TESTNET";
}

export function getUsdcTokenAddress(): string {
  const fromEnv = process.env.ARC_USDC_TOKEN_ADDRESS?.trim();
  if (fromEnv) return fromEnv;
  // Circle Arc testnet USDC (documented Circle default; override via env in production)
  if (getArcChain() === "ARC-TESTNET") {
    return "0x3600000000000000000000000000000000000000";
  }
  throw new Error("ARC_USDC_TOKEN_ADDRESS is required for Arc mainnet");
}

export function isCircleConfigured(): boolean {
  return Boolean(process.env.CIRCLE_API_KEY?.trim() && process.env.CIRCLE_ENTITY_SECRET?.trim());
}

/** Live Arc transfers require sandbox→live org mode AND explicit env gate. */
export function assertArcPaymentsAllowed(mode: "sandbox" | "live") {
  if (mode === "live" && process.env.ARC_PAYMENTS_LIVE !== "true") {
    throw new Error("Live Arc payments disabled. Set ARC_PAYMENTS_LIVE=true after compliance clearance.");
  }
  if (mode === "live" && getArcChain() === "ARC-TESTNET" && process.env.ARC_ALLOW_LIVE_ON_TESTNET !== "true") {
    throw new Error("Live mode on ARC-TESTNET blocked. Set ARC_CHAIN=ARC for mainnet or ARC_ALLOW_LIVE_ON_TESTNET=true for drills.");
  }
}

export function circleApiBase(): string {
  return process.env.CIRCLE_API_BASE?.replace(/\/$/, "") || "https://api.circle.com";
}
