import { createHash, randomBytes, randomUUID } from "crypto";
import {
  assertArcPaymentsAllowed,
  circleApiBase,
  getArcChain,
  getUsdcTokenAddress,
  isCircleConfigured,
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
    const msg = (body as { message?: string })?.message || JSON.stringify(body);
    throw new Error(`Circle API ${res.status}: ${msg}`);
  }
  return body as { data?: unknown };
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
  if (input.provider === "sandbox" || !isCircleConfigured()) {
    // Deterministic demo balance for sandbox agent wallets
    const n = parseInt(createHash("sha256").update(input.address).digest("hex").slice(0, 6), 16);
    return Math.round(((n % 500000) / 100 + 1000) * 100) / 100;
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

  if (input.provider === "sandbox" || !isCircleConfigured()) {
    const id = `sbx_tx_${createHash("sha256").update(input.idempotencyKey).digest("hex").slice(0, 20)}`;
    const txHash = `0x${createHash("sha256").update(`${id}:${input.destinationAddress}`).digest("hex")}`;
    return { id, state: "COMPLETE", txHash, provider: "sandbox" };
  }

  const chain = getArcChain();
  const tokenAddress = getUsdcTokenAddress();
  const amountStr = String(input.amount);

  try {
    const mod = await import("@circle-fin/developer-controlled-wallets");
    const initiateDeveloperControlledWalletsClient =
      (mod as { initiateDeveloperControlledWalletsClient?: Function }).initiateDeveloperControlledWalletsClient;
    if (initiateDeveloperControlledWalletsClient) {
      const client = initiateDeveloperControlledWalletsClient({
        apiKey: process.env.CIRCLE_API_KEY!,
        entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
      });
      const transfer = await client.createTransaction({
        walletId: input.walletId,
        tokenAddress,
        destinationAddress: input.destinationAddress,
        amounts: [amountStr],
        fee: { type: "level", config: { feeLevel: "MEDIUM" } },
        blockchain: chain,
        idempotencyKey: input.idempotencyKey,
      });
      const data = transfer.data;
      return {
        id: data?.id || data?.transaction?.id || randomUUID(),
        state: data?.state || data?.transaction?.state || "PENDING",
        txHash: data?.txHash || data?.transactionHash || null,
        provider: "circle",
      };
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes("ARC_PAYMENTS")) throw e;
  }

  const entitySecretCiphertext = process.env.CIRCLE_ENTITY_SECRET_CIPHERTEXT;
  const body: Record<string, unknown> = {
    idempotencyKey: input.idempotencyKey,
    walletId: input.walletId,
    tokenAddress,
    destinationAddress: input.destinationAddress,
    amounts: [amountStr],
    feeLevel: "MEDIUM",
    blockchain: chain,
  };
  if (entitySecretCiphertext) body.entitySecretCiphertext = entitySecretCiphertext;

  const res = await circleFetch("/v1/w3s/developer/transactions/transfer", {
    method: "POST",
    body: JSON.stringify(body),
    idempotencyKey: input.idempotencyKey,
  });
  const data = res.data as { id?: string; state?: string; txHash?: string; transactionHash?: string };
  return {
    id: data?.id || randomUUID(),
    state: data?.state || "PENDING",
    txHash: data?.txHash || data?.transactionHash || null,
    provider: "circle",
  };
}

export async function getCircleTransaction(txId: string): Promise<CircleTransferResult> {
  if (txId.startsWith("sbx_tx_") || !isCircleConfigured()) {
    return {
      id: txId,
      state: "COMPLETE",
      txHash: `0x${createHash("sha256").update(txId).digest("hex")}`,
      provider: "sandbox",
    };
  }
  const res = await circleFetch(`/v1/w3s/transactions/${txId}`);
  const data = res.data as { id?: string; state?: string; txHash?: string; transactionHash?: string };
  return {
    id: data?.id || txId,
    state: data?.state || "UNKNOWN",
    txHash: data?.txHash || data?.transactionHash || null,
    provider: "circle",
  };
}

export function newChallengeNonce() {
  return randomBytes(16).toString("hex");
}
