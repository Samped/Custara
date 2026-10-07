import { createHash, randomBytes, randomUUID } from "crypto";
import {
  allowSimulatedArc,
  assertArcPaymentsAllowed,
  circleApiBase,
  getArcChain,
  getUsdcTokenAddress,
  isCircleConfigured,
  requireCircleOrThrow,
} from "./config";

export type CircleWallet = {
  id: string;
  address: string;
  blockchain: string;
  walletSetId: string;
  provider: "circle" | "sandbox";
};

export type CircleTransferResult = {
  id: string;
  state: string;
  txHash?: string | null;
  provider: "circle" | "sandbox";
};

export type CircleBalance = {
  tokenSymbol: string;
  amount: number;
};

async function circleFetch(path: string, init?: RequestInit & { idempotencyKey?: string }) {
  const apiKey = process.env.CIRCLE_API_KEY;
  if (!apiKey) throw new Error("CIRCLE_API_KEY missing");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (init?.idempotencyKey) headers["X-Request-Id"] = init.idempotencyKey;
  const res = await fetch(`${circleApiBase()}${path}`, {
    ...init,
    headers,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const b = body as {
      message?: string;
      errors?: Array<{ location?: string; message?: string }>;
    };
    const detail = b.errors?.map((e) => e.message || e.location).filter(Boolean).join("; ");
    const msg = detail ? `${b.message || "error"} (${detail})` : b.message || JSON.stringify(body);
    throw new Error(`Circle API ${res.status}: ${msg}`);
  }
  return body as { data?: unknown };
}

/** Circle requires idempotencyKey to be UUID-shaped — hash arbitrary seeds into one. */
export function toCircleIdempotencyKey(seed: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(seed)) {
    return seed.toLowerCase();
  }
  const h = createHash("sha256").update(`custara:circle:${seed}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function formatCircleSdkError(e: unknown): string {
  if (!e || typeof e !== "object") return String(e);
  const any = e as {
    message?: string;
    data?: { message?: string; errors?: Array<{ message?: string; location?: string }> };
    body?: { message?: string; errors?: Array<{ message?: string; location?: string }> };
    response?: { data?: { message?: string; errors?: Array<{ message?: string; location?: string }> } };
  };
  const payload = any.data || any.body || any.response?.data;
  const detail = payload?.errors?.map((x) => x.message || x.location).filter(Boolean).join("; ");
  const base = payload?.message || any.message || "Circle transfer failed";
  return detail ? `${base} (${detail})` : base;
}

async function getCircleSdk() {
  const mod = await import("@circle-fin/developer-controlled-wallets");
  const initiate =
    (mod as { initiateDeveloperControlledWalletsClient?: Function }).initiateDeveloperControlledWalletsClient;
  const generate =
    (mod as { generateEntitySecretCiphertext?: Function }).generateEntitySecretCiphertext;
  if (!initiate || !generate) {
    throw new Error("Circle developer-controlled-wallets SDK is not installed correctly");
  }
  const apiKey = process.env.CIRCLE_API_KEY!;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET!;
  if (!apiKey?.trim() || !entitySecret?.trim()) {
    throw new Error("CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET are required for Arc transfers");
  }
  const client = initiate({
    apiKey,
    entitySecret,
    baseUrl: circleApiBase(),
  }) as {
    createTransaction: (input: Record<string, unknown>) => Promise<{ data?: Record<string, unknown> }>;
  };
  return {
    client,
    generateCiphertext: async () => {
      const ct = await generate({ apiKey, entitySecret, baseUrl: circleApiBase() });
      if (typeof ct === "string" && ct.length > 0) return ct;
      if (ct && typeof ct === "object" && typeof (ct as { data?: unknown }).data === "string") {
        return (ct as { data: string }).data;
      }
      throw new Error("generateEntitySecretCiphertext returned empty value");
    },
  };
}

function sandboxAddress(seed: string) {
  const hex = createHash("sha256").update(seed).digest("hex");
  return `0x${hex.slice(0, 40)}`;
}

export async function createAgentWallet(input: {
  organizationId: string;
  label?: string;
}): Promise<CircleWallet> {
  const chain = getArcChain();

  if (!isCircleConfigured()) {
    requireCircleOrThrow("Agent wallet provisioning");
    const id = `sbx_wal_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    return {
      id,
      address: sandboxAddress(`agent:${input.organizationId}:${id}`),
      blockchain: chain,
      walletSetId: `sbx_set_${input.organizationId.slice(0, 12)}`,
      provider: "sandbox",
    };
  }

  // Prefer SDK when available; fall back to REST
  try {
    const mod = await import("@circle-fin/developer-controlled-wallets");
    const initiateDeveloperControlledWalletsClient =
      (mod as { initiateDeveloperControlledWalletsClient?: Function }).initiateDeveloperControlledWalletsClient ||
      (mod as { default?: { initiateDeveloperControlledWalletsClient?: Function } }).default
        ?.initiateDeveloperControlledWalletsClient;
    if (initiateDeveloperControlledWalletsClient) {
      const client = initiateDeveloperControlledWalletsClient({
        apiKey: process.env.CIRCLE_API_KEY!,
        entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
      });
      const walletSet = await client.createWalletSet({
        name: input.label || `custara-${input.organizationId}`,
      });
      const setId = walletSet.data?.walletSet?.id as string;
      const wallets = await client.createWallets({
        walletSetId: setId,
        blockchains: [chain],
        count: 1,
        accountType: "EOA",
      });
      const w = wallets.data?.wallets?.[0];
      if (!w?.id || !w.address) throw new Error("Circle wallet create returned empty");
      return {
        id: w.id,
        address: w.address,
        blockchain: chain,
        walletSetId: setId,
        provider: "circle",
      };
    }
  } catch (e) {
    // Fall through to REST if SDK shape differs
    if (!(e instanceof Error && e.message.startsWith("Circle"))) {
      // continue
    } else {
      throw e;
    }
  }

  const setRes = await circleFetch("/v1/w3s/developer/walletSets", {
    method: "POST",
    body: JSON.stringify({
      name: input.label || `custara-${input.organizationId}`,
      idempotencyKey: randomUUID(),
    }),
    idempotencyKey: randomUUID(),
  });
  const setId = (setRes.data as { walletSet?: { id?: string } })?.walletSet?.id;
  if (!setId) throw new Error("Circle wallet set create failed");

  const walRes = await circleFetch("/v1/w3s/developer/wallets", {
    method: "POST",
    body: JSON.stringify({
      walletSetId: setId,
      blockchains: [chain],
      count: 1,
      accountType: "EOA",
      idempotencyKey: randomUUID(),
    }),
  });
  const w = (walRes.data as { wallets?: Array<{ id: string; address: string }> })?.wallets?.[0];
  if (!w) throw new Error("Circle wallet create failed");
  return {
    id: w.id,
    address: w.address,
    blockchain: chain,
    walletSetId: setId,
    provider: "circle",
  };
}

export async function getWalletUsdcBalance(input: {
  walletId?: string | null;
  address: string;
  provider: string;
}): Promise<number> {
  if (input.provider === "sandbox" || (!isCircleConfigured() && allowSimulatedArc())) {
    // Deterministic demo balance for simulated agent wallets only
    const n = parseInt(createHash("sha256").update(input.address).digest("hex").slice(0, 6), 16);
    return Math.round(((n % 500000) / 100 + 1000) * 100) / 100;
  }
  if (!isCircleConfigured()) {
    requireCircleOrThrow("Wallet balance sync");
  }

  try {
    const path = input.walletId
      ? `/v1/w3s/wallets/${input.walletId}/balances`
      : `/v1/w3s/wallets/${encodeURIComponent(input.address)}/balances`;
    const res = await circleFetch(path);
    const tokenBalances = (res.data as { tokenBalances?: Array<{ token?: { symbol?: string }; amount?: string }> })
      ?.tokenBalances;
    const usdc = tokenBalances?.find((b) => b.token?.symbol === "USDC");
    return usdc?.amount ? Number(usdc.amount) : 0;
  } catch {
    return 0;
  }
}

export async function createUsdcTransfer(input: {
  mode: "sandbox" | "live";
  walletId: string;
  walletAddress: string;
  provider: string;
  destinationAddress: string;
  amount: number;
  idempotencyKey: string;
}): Promise<CircleTransferResult> {
  assertArcPaymentsAllowed(input.mode);

  if (input.provider === "sandbox") {
    if (!allowSimulatedArc()) {
      throw new Error(
        "Agent wallet is still simulated (sandbox). Open Wallets → Upgrade to Circle testnet agent, fund it with testnet USDC, then pay again.",
      );
    }
    const id = `sbx_tx_${createHash("sha256").update(input.idempotencyKey).digest("hex").slice(0, 20)}`;
    const txHash = `0x${createHash("sha256").update(`${id}:${input.destinationAddress}`).digest("hex")}`;
    return { id, state: "COMPLETE", txHash, provider: "sandbox" };
  }
  if (!isCircleConfigured()) {
    requireCircleOrThrow("USDC transfer");
    const id = `sbx_tx_${createHash("sha256").update(input.idempotencyKey).digest("hex").slice(0, 20)}`;
    const txHash = `0x${createHash("sha256").update(`${id}:${input.destinationAddress}`).digest("hex")}`;
    return { id, state: "COMPLETE", txHash, provider: "sandbox" };
  }

  if (!input.walletId || input.walletId.startsWith("sbx_")) {
    throw new Error("Invalid Circle walletId — upgrade the agent wallet to Circle testnet first");
  }
  if (!(input.amount > 0)) throw new Error("Transfer amount must be greater than zero");

  const chain = getArcChain();
  const tokenAddress = getUsdcTokenAddress();
  const amounts = [Number(input.amount).toFixed(2)];
  const destinationAddress = input.destinationAddress.trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(destinationAddress)) {
    throw new Error(`Invalid destination Arc address: ${input.destinationAddress}`);
  }

  const { client, generateCiphertext } = await getCircleSdk();
  const idempotencyKey = toCircleIdempotencyKey(input.idempotencyKey);

  // Primary path: Circle SDK (encrypts entity secret per request).
  try {
    const transfer = await client.createTransaction({
      walletId: input.walletId,
      tokenAddress,
      destinationAddress,
      amounts,
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
      blockchain: chain,
      idempotencyKey,
    });
    const data = (transfer?.data || transfer) as Record<string, unknown>;
    const nested = ((data?.transaction as Record<string, unknown>) || data) as Record<string, unknown>;
    const id = String(nested?.id || data?.id || "");
    if (!id) throw new Error("Circle createTransaction returned no transaction id");
    return {
      id,
      state: String(nested?.state || data?.state || "PENDING"),
      txHash: (nested?.txHash || nested?.transactionHash || data?.txHash || data?.transactionHash || null) as
        | string
        | null,
      provider: "circle",
    };
  } catch (e) {
    const sdkMsg = formatCircleSdkError(e);
    // Explicit REST fallback with a fresh one-time ciphertext (never empty).
    try {
      const entitySecretCiphertext = await generateCiphertext();
      const res = await circleFetch("/v1/w3s/developer/transactions/transfer", {
        method: "POST",
        body: JSON.stringify({
          idempotencyKey,
          walletId: input.walletId,
          tokenAddress,
          destinationAddress,
          amounts,
          feeLevel: "MEDIUM",
          blockchain: chain,
          entitySecretCiphertext,
        }),
        idempotencyKey,
      });
      const data = res.data as { id?: string; state?: string; txHash?: string; transactionHash?: string };
      if (!data?.id) throw new Error("Circle REST transfer returned no transaction id");
      return {
        id: data.id,
        state: data.state || "PENDING",
        txHash: data.txHash || data.transactionHash || null,
        provider: "circle",
      };
    } catch (restErr) {
      const restMsg = restErr instanceof Error ? restErr.message : String(restErr);
      throw new Error(`Arc USDC transfer failed — SDK: ${sdkMsg}; REST: ${restMsg}`);
    }
  }
}

export async function getCircleTransaction(txId: string): Promise<CircleTransferResult> {
  if (txId.startsWith("sbx_tx_") || (!isCircleConfigured() && allowSimulatedArc())) {
    if (!allowSimulatedArc() && txId.startsWith("sbx_tx_")) {
      throw new Error("Simulated Circle tx id cannot be reconciled when ARC_ALLOW_SIMULATED is off");
    }
    return {
      id: txId,
      state: "COMPLETE",
      txHash: `0x${createHash("sha256").update(txId).digest("hex")}`,
      provider: "sandbox",
    };
  }
  requireCircleOrThrow("Circle transaction lookup");
  const res = await circleFetch(`/v1/w3s/transactions/${txId}`);
  // Circle wraps as { data: { transaction: {...} } } (or sometimes flat data).
  const raw = res.data as Record<string, unknown> | undefined;
  const tx = ((raw?.transaction as Record<string, unknown> | undefined) || raw || {}) as {
    id?: string;
    state?: string;
    txHash?: string;
    transactionHash?: string;
  };
  return {
    id: tx.id || txId,
    state: tx.state || "UNKNOWN",
    txHash: tx.txHash || tx.transactionHash || null,
    provider: "circle",
  };
}

export function newChallengeNonce() {
  return randomBytes(16).toString("hex");
}

export type TestnetFaucetResult =
  | { ok: true; method: "circle_api"; message: string }
  | {
      ok: false;
      method: "rate_limited";
      message: string;
      retryAfterMs: number;
      faucetUrl: string;
      address: string;
      blockchain: string;
    }
  | {
      ok: false;
      method: "public_faucet";
      message: string;
      faucetUrl: string;
      address: string;
      blockchain: string;
    };

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const CIRCLE_PUBLIC_FAUCET_URL = "https://faucet.circle.com/";

/**
 * Single attempt (or short retry burst) against Circle `/v1/faucet/drips`.
 * Rate limits return `method: "rate_limited"` so callers can wait longer externally.
 * Forbidden / missing mainnet upgrade falls back to the public faucet URL.
 */
export async function requestTestnetUsdcFaucet(input: {
  address: string;
  blockchain?: string;
  /** Short burst retries for transient errors. Default 2. Use 0 for a single shot. */
  retries?: number;
}): Promise<TestnetFaucetResult> {
  const address = input.address.trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(address)) throw new Error("Invalid address for faucet");
  const blockchain = input.blockchain || getArcChain();
  if (
    blockchain !== "ARC-TESTNET" &&
    !String(blockchain).toUpperCase().includes("TESTNET") &&
    !String(blockchain).toUpperCase().includes("SEPOLIA")
  ) {
    throw new Error(`Faucet only available on testnets (got ${blockchain})`);
  }

  const faucetUrl = CIRCLE_PUBLIC_FAUCET_URL;
  const retries = input.retries ?? 2;
  requireCircleOrThrow("Testnet faucet");

  let lastError = "";
  let lastStatus = 0;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${circleApiBase()}/v1/faucet/drips`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.CIRCLE_API_KEY}`,
          "Content-Type": "application/json",
          "X-Request-Id": randomUUID(),
        },
        body: JSON.stringify({ address, blockchain, usdc: true, native: true }),
      });
      lastStatus = res.status;
      if (res.status === 204 || res.ok) {
        return {
          ok: true,
          method: "circle_api",
          message: "Circle faucet accepted the request (~20 USDC). Sync in a minute if balance is still 0.",
        };
      }
      const body = await res.json().catch(() => ({}));
      const msg = (body as { message?: string })?.message || `HTTP ${res.status}`;
      lastError = msg;

      if (res.status === 429 || /rate limit/i.test(msg)) {
        // Circle often clears API-key throttles in ~1–5 minutes; address drip window is ~1h.
        const retryAfterMs = Math.min(300_000, 45_000 * (attempt + 1));
        if (attempt < retries) {
          await sleep(retryAfterMs);
          continue;
        }
        return {
          ok: false,
          method: "rate_limited",
          message: `Circle faucet API rate-limited (${msg}). Will retry; public faucet also works with captcha.`,
          retryAfterMs: 120_000,
          faucetUrl,
          address,
          blockchain,
        };
      }

      if (res.status === 401 || res.status === 403 || /forbidden|upgrade|mainnet/i.test(msg)) {
        break;
      }

      // Per-address drip window — soft success so callers sync/poll.
      if (/already|too many|wait|exceeded/i.test(msg) && !/rate limit/i.test(msg)) {
        return {
          ok: true,
          method: "circle_api",
          message: `Faucet responded: ${msg}. Sync / poll balance shortly.`,
        };
      }
      await sleep(2_000 * (attempt + 1));
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      if (/rate limit|429/i.test(lastError)) {
        if (attempt < retries) {
          await sleep(Math.min(300_000, 45_000 * (attempt + 1)));
          continue;
        }
        return {
          ok: false,
          method: "rate_limited",
          message: `Circle faucet API rate-limited (${lastError}).`,
          retryAfterMs: 120_000,
          faucetUrl,
          address,
          blockchain,
        };
      }
      await sleep(2_000 * (attempt + 1));
    }
  }

  return {
    ok: false,
    method: "public_faucet",
    message:
      lastError
        ? `Circle faucet API unavailable (${lastStatus || "?"} ${lastError}). Open the public faucet, choose ARC + USDC, paste the agent address, then Sync.`
        : "Open Circle’s public faucet, choose ARC + USDC, paste the agent address, then Sync. Limit ~20 USDC / hour.",
    faucetUrl,
    address,
    blockchain,
  };
}
