import { createHmac, timingSafeEqual } from "node:crypto";

const PAJ_BASE = "https://api.paj.cash";

export function pajConfigured() {
  return Boolean(process.env.PAJ_API_KEY?.trim());
}

export function pajWebhookSecret() {
  return (process.env.PAJ_WEBHOOK_SECRET || "").trim();
}

export class PajApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "PajApiError";
    this.status = status;
  }
}

export type PajBank = {
  id?: string;
  name: string;
  country?: string;
  code: string;
  logo?: string | null;
};

export type PajBankAccount = {
  id: string;
  accountName: string;
  accountNumber: string;
  bank?: string;
  address?: string;
};

export type PajTransaction = {
  id: string;
  address?: string;
  signature?: string | null;
  mint?: string;
  currency?: string;
  amount?: number;
  usdcAmount?: number;
  fiatAmount?: number;
  sender?: string;
  recipient?: string;
  rate?: number;
  status?: string;
  transactionType?: string;
  createdAt?: string;
  accountNumber?: string;
  accountName?: string;
  bank?: string;
  fee?: number;
  chain?: string;
};

function pajKey() {
  const key = process.env.PAJ_API_KEY?.trim();
  if (!key) throw new Error("Bank rails not configured");
  return key;
}

async function pajFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${PAJ_BASE}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-api-key": pajKey(),
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const message =
      (body && typeof body === "object" && "message" in body && typeof body.message === "string"
        ? body.message
        : null) ||
      (typeof body === "string" && body.trim() ? body.trim().slice(0, 240) : null) ||
      `PAJ ${res.status}`;
    throw new PajApiError(res.status, message);
  }
  return body as T;
}

export async function listPajBanks(country = "NG") {
  return pajFetch<PajBank[]>(`/pub/v2/bank?country=${encodeURIComponent(country)}`);
}

export async function registerPajBankAccount(input: { bankCode: string; accountNumber: string }) {
  return pajFetch<PajBankAccount>("/pub/v2/bank-account", {
    method: "POST",
    body: JSON.stringify({
      bankCode: input.bankCode.trim(),
      accountNumber: input.accountNumber.trim(),
    }),
  });
}

export async function createPajOnrampOrder(input: {
  fiatAmount: number;
  currency?: string;
  chain: string;
  mint: string;
  recipient: string;
  webhookURL?: string;
  userExternalId?: string;
}) {
  return pajFetch<PajTransaction>("/pub/v2/onramp", {
    method: "POST",
    body: JSON.stringify({
      fiatAmount: input.fiatAmount,
      currency: input.currency || "NGN",
      chain: input.chain,
      mint: input.mint,
      recipient: input.recipient,
      webhookURL: input.webhookURL,
      userExternalId: input.userExternalId,
    }),
  });
}

export async function createPajOfframpOrder(input: {
  bankCode: string;
  accountNumber: string;
  currency?: string;
  amount: number;
  chain: string;
  mint: string;
  webhookURL?: string;
  description?: string;
}) {
  return pajFetch<PajTransaction>("/pub/v2/offramp", {
    method: "POST",
    body: JSON.stringify({
      bankCode: input.bankCode.trim(),
      accountNumber: input.accountNumber.trim(),
      currency: input.currency || "NGN",
      amount: input.amount,
      chain: input.chain,
      mint: input.mint,
      webhookURL: input.webhookURL,
      description: input.description,
    }),
  });
}

/** HMAC-SHA256 over `{timestamp}.{rawBody}`. Secret is used as issued (including `whsec_`). */
export function verifyPajWebhook(input: {
  rawBody: string;
  timestamp: string | null;
  signature: string | null;
  secret?: string;
  nowMs?: number;
  maxSkewSec?: number;
}) {
  const secret = (input.secret ?? pajWebhookSecret()).trim();
  if (!secret) return false;
  const timestamp = (input.timestamp || "").trim();
  const received = (input.signature || "").trim().replace(/^v1=/, "");
  if (!timestamp || !received) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const nowSec = (input.nowMs ?? Date.now()) / 1000;
  const maxSkew = input.maxSkewSec ?? 300;
  if (Math.abs(nowSec - ts) > maxSkew) return false;

  const expected = createHmac("sha256", secret).update(`${timestamp}.${input.rawBody}`).digest("hex");
  if (received.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(received, "utf8"), Buffer.from(expected, "utf8"));
}

export function pajArcTxHash(signature?: string | null) {
  const hash = (signature || "").trim();
  return hash.startsWith("0x") ? hash : null;
}
