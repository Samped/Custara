/** Arc / Circle configuration — USDC address comes from env, never hardcoded blindly. */

export type ArcChain = "ARC-TESTNET" | "ARC";

export type ArcExecutionMode = "simulated" | "testnet" | "mainnet" | "blocked";

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

/** Local demo only — invents wallets/tx hashes. Off by default for enterprise / testnet. */
export function allowSimulatedArc(): boolean {
  return process.env.ARC_ALLOW_SIMULATED === "true";
}

export function requireCircleOrThrow(action: string) {
  if (isCircleConfigured()) return;
  if (allowSimulatedArc()) return;
  throw new Error(
    `${action} requires Circle developer wallets. Set CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET (and CIRCLE_ENTITY_SECRET_CIPHERTEXT for REST). For local demos only, set ARC_ALLOW_SIMULATED=true.`,
  );
}

/**
 * Resolve how Arc will execute for this process + org payment mode.
 * - simulated: fake COMPLETE (dev)
 * - testnet: real Circle txs on ARC-TESTNET
 * - mainnet: real Circle txs on ARC
 * - blocked: misconfigured / gated
 */
export function getArcExecutionMode(orgPaymentMode: "sandbox" | "live" | string): ArcExecutionMode {
  if (orgPaymentMode !== "live") {
    return allowSimulatedArc() ? "simulated" : "blocked";
  }
  if (process.env.ARC_PAYMENTS_LIVE !== "true") return "blocked";
  if (!isCircleConfigured() && !allowSimulatedArc()) return "blocked";
  if (!isCircleConfigured() && allowSimulatedArc()) return "simulated";
  if (getArcChain() === "ARC") return "mainnet";
  if (process.env.ARC_ALLOW_LIVE_ON_TESTNET !== "true") return "blocked";
  return "testnet";
}

/** Live Arc transfers require sandbox→live org mode AND explicit env gate. */
export function assertArcPaymentsAllowed(mode: "sandbox" | "live") {
  if (mode === "sandbox") {
    if (!allowSimulatedArc()) {
      throw new Error(
        "Simulated Arc payments are disabled. Set org Payment mode to live (Arc testnet) in Settings, with ARC_PAYMENTS_LIVE=true and ARC_ALLOW_LIVE_ON_TESTNET=true.",
      );
    }
    return;
  }
  if (process.env.ARC_PAYMENTS_LIVE !== "true") {
    throw new Error("Live Arc payments disabled. Set ARC_PAYMENTS_LIVE=true after compliance clearance.");
  }
  if (getArcChain() === "ARC-TESTNET" && process.env.ARC_ALLOW_LIVE_ON_TESTNET !== "true") {
    throw new Error(
      "Live mode on ARC-TESTNET blocked. Set ARC_ALLOW_LIVE_ON_TESTNET=true for enterprise testnet drills, or ARC_CHAIN=ARC for mainnet.",
    );
  }
  requireCircleOrThrow("Arc transfer");
}

export function circleApiBase(): string {
  return process.env.CIRCLE_API_BASE?.replace(/\/$/, "") || "https://api.circle.com";
}
