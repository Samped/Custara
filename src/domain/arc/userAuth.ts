import { createHash, randomUUID } from "crypto";
import { circleApiBase, getArcChain } from "./config";
import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { getCircleAppId, isCircleUserAuthConfigured } from "@/lib/emailOtp";

async function circleFetch(path: string, init?: RequestInit & { userToken?: string }) {
  const apiKey = process.env.CIRCLE_API_KEY;
  if (!apiKey) throw new Error("CIRCLE_API_KEY missing");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (init?.userToken) headers["X-User-Token"] = init.userToken;
  const res = await fetch(`${circleApiBase()}${path}`, {
    ...init,
    headers,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      (body as { message?: string; code?: number })?.message ||
      (typeof body === "object" ? JSON.stringify(body) : "Circle error");
    const err = new Error(`Circle API ${res.status}: ${msg}`) as Error & { circleCode?: number };
    err.circleCode = (body as { code?: number })?.code;
    throw err;
  }
  return body as { data?: unknown };
}

export async function requestCircleEmailToken(input: { email: string; deviceId: string }) {
  if (!isCircleUserAuthConfigured()) {
    throw new Error("Circle user auth is not configured");
  }
  const email = input.email.trim().toLowerCase();
  const res = await circleFetch("/v1/w3s/users/email/token", {
    method: "POST",
    body: JSON.stringify({
      idempotencyKey: randomUUID(),
      deviceId: input.deviceId,
      email,
    }),
  });
  const data = res.data as {
    deviceToken?: string;
    deviceEncryptionKey?: string;
    otpToken?: string;
  };
  if (!data?.deviceToken || !data?.deviceEncryptionKey || !data?.otpToken) {
    throw new Error("Circle email token response incomplete");
  }
  return {
    mode: "circle" as const,
    appId: getCircleAppId(),
    email,
    deviceToken: data.deviceToken,
    deviceEncryptionKey: data.deviceEncryptionKey,
    otpToken: data.otpToken,
  };
}

function sandboxTreasuryAddress(email: string) {
  const hex = createHash("sha256").update(`circle_user:${email}`).digest("hex");
  return `0x${hex.slice(0, 40)}`;
}

/**
 * Initialize or load Circle user-controlled wallet on Arc, then link as org treasury.
 * Error 155106 = user already initialized — fetch wallets instead.
 */
export async function initializeAndLinkCircleUserTreasury(input: {
  organizationId: string;
  userId: string;
  email: string;
  userToken: string;
}) {
  const chain = getArcChain() === "ARC" ? "ARC" : "ARC-TESTNET";

  if (!isCircleUserAuthConfigured()) {
    // Sandbox mirror: deterministic treasury from email
    return linkCircleUserTreasury({
      organizationId: input.organizationId,
      userId: input.userId,
      address: sandboxTreasuryAddress(input.email),
      circleWalletId: `sbx_user_${createHash("sha256").update(input.email).digest("hex").slice(0, 16)}`,
      provider: "sandbox",
    });
  }

  let wallet: { id: string; address: string } | null = null;

  try {
    const initRes = await circleFetch("/v1/w3s/user/initialize", {
      method: "POST",
      userToken: input.userToken,
      body: JSON.stringify({
        idempotencyKey: randomUUID(),
        accountType: "SCA",
        blockchains: [chain],
      }),
    });
    // initialize may return challengeId; wallets might appear after execute — try fetch either way
    void initRes;
  } catch (e) {
    const code = (e as Error & { circleCode?: number }).circleCode;
    if (code !== 155106) throw e;
  }

  const listRes = await circleFetch("/v1/w3s/wallets", {
    method: "GET",
    userToken: input.userToken,
  });
  const wallets = (listRes.data as { wallets?: Array<{ id: string; address: string; blockchain?: string }> })
    ?.wallets;
  const onArc = wallets?.find((w) => (w.blockchain || "").toUpperCase().includes("ARC")) || wallets?.[0];
  if (onArc?.id && onArc.address) {
    wallet = { id: onArc.id, address: onArc.address };
  }

  if (!wallet) {
    // Create wallet explicitly if list empty
    const createRes = await circleFetch("/v1/w3s/user/wallets", {
      method: "POST",
      userToken: input.userToken,
      body: JSON.stringify({
        idempotencyKey: randomUUID(),
        blockchains: [chain],
        accountType: "SCA",
        count: 1,
      }),
    });
    const created = (createRes.data as { wallets?: Array<{ id: string; address: string }> })?.wallets?.[0];
    if (!created?.id || !created.address) {
      throw new Error("Circle user wallet not available yet — complete any PIN/challenge in the SDK, then retry");
    }
    wallet = { id: created.id, address: created.address };
  }

  return linkCircleUserTreasury({
    organizationId: input.organizationId,
    userId: input.userId,
    address: wallet.address.toLowerCase(),
    circleWalletId: wallet.id,
    provider: "circle_user",
  });
}

export async function linkCircleUserTreasury(input: {
  organizationId: string;
  userId: string;
  address: string;
  circleWalletId?: string | null;
  provider: "circle_user" | "sandbox";
}) {
  const address = input.address.trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(address)) throw new Error("Invalid Arc wallet address");

  await prisma.orgWallet.updateMany({
    where: { organizationId: input.organizationId, role: "treasury_external", status: "active" },
    data: { status: "revoked" },
  });

  const wallet = await prisma.orgWallet.create({
    data: {
      organizationId: input.organizationId,
      role: "treasury_external",
      provider: input.provider,
      blockchain: getArcChain(),
      address,
      circleWalletId: input.circleWalletId || null,
      status: "active",
      label: input.provider === "circle_user" ? "Circle email wallet" : "Sandbox email treasury",
      verifiedAt: new Date(),
    },
  });

  await prisma.destinationAllowlist.upsert({
    where: {
      organizationId_address: { organizationId: input.organizationId, address },
    },
    create: {
      organizationId: input.organizationId,
      address,
      label: "Company treasury",
      isActive: true,
    },
    update: { isActive: true, revokedAt: null, label: "Company treasury" },
  });

  await writeAudit({
    organizationId: input.organizationId,
    actorType: "user",
    actorId: input.userId,
    action: "wallet.treasury_linked",
    entityType: "org_wallet",
    entityId: wallet.id,
    metadata: { address, provider: input.provider },
  });

  return wallet;
}
