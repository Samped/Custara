import { SiweMessage } from "siwe";
import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { allowSimulatedArc, getArcChain, isCircleConfigured, requireCircleOrThrow } from "./config";
import {
  createAgentWallet,
  getWalletUsdcBalance,
  newChallengeNonce,
  requestTestnetUsdcFaucet,
} from "./circle";

function normalizeAddress(address: string) {
  const a = address.trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(a)) throw new Error("Invalid Arc wallet address");
  return a;
}

export async function ensureAgentWallet(input: {
  organizationId: string;
  actorType: "user" | "system" | "api_key";
  actorId?: string;
}) {
  const existing = await prisma.orgWallet.findFirst({
    where: { organizationId: input.organizationId, role: "agent", status: { in: ["active", "pending"] } },
    orderBy: { createdAt: "asc" },
  });
  if (existing) return existing;

  const created = await createAgentWallet({ organizationId: input.organizationId });
  const wallet = await prisma.orgWallet.create({
    data: {
      organizationId: input.organizationId,
      role: "agent",
      provider: created.provider,
      blockchain: created.blockchain,
      address: created.address.toLowerCase(),
      circleWalletId: created.id,
      circleWalletSetId: created.walletSetId,
      status: "active",
      label: "Custara agent wallet",
      verifiedAt: new Date(),
    },
  });

  await writeAudit({
    organizationId: input.organizationId,
    actorType: input.actorType,
    actorId: input.actorId,
    action: "wallet.agent_provisioned",
    entityType: "org_wallet",
    entityId: wallet.id,
    metadata: { address: wallet.address, provider: wallet.provider, blockchain: wallet.blockchain },
  });

  return wallet;
}

/**
 * Replace a simulated (sandbox) agent wallet with a real Circle developer wallet on ARC-TESTNET/ARC.
 * Prior agent address is revoked — re-fund the new address with testnet USDC.
 */
export async function upgradeAgentWalletToCircle(input: {
  organizationId: string;
  actorType: "user" | "system" | "api_key";
  actorId?: string;
}) {
  requireCircleOrThrow("Circle agent upgrade");
  if (!isCircleConfigured()) {
    throw new Error("Circle API key + entity secret required to provision a real testnet agent");
  }

  const existing = await prisma.orgWallet.findFirst({
    where: { organizationId: input.organizationId, role: "agent", status: { in: ["active", "pending"] } },
    orderBy: { createdAt: "asc" },
  });

  if (existing?.provider === "circle" && existing.circleWalletId && !existing.circleWalletId.startsWith("sbx_")) {
    return existing;
  }

  if (existing) {
    await prisma.orgWallet.update({
      where: { id: existing.id },
      data: {
        status: "revoked",
        label: existing.label ? `${existing.label} (replaced)` : "Simulated agent (replaced)",
      },
    });
  }

  const created = await createAgentWallet({
    organizationId: input.organizationId,
    label: `custara-agent-${input.organizationId}`,
  });
  if (created.provider !== "circle") {
    throw new Error("Circle wallet create returned a non-Circle provider — check CIRCLE_* credentials");
  }

  const wallet = await prisma.orgWallet.create({
    data: {
      organizationId: input.organizationId,
      role: "agent",
      provider: "circle",
      blockchain: created.blockchain,
      address: created.address.toLowerCase(),
      circleWalletId: created.id,
      circleWalletSetId: created.walletSetId,
      status: "active",
      label: "Custara agent wallet (Circle)",
      verifiedAt: new Date(),
      balanceUsdc: null,
      balanceSyncedAt: null,
    },
  });

  await writeAudit({
    organizationId: input.organizationId,
    actorType: input.actorType,
    actorId: input.actorId,
    action: "wallet.agent_upgraded_circle",
    entityType: "org_wallet",
    entityId: wallet.id,
    metadata: {
      address: wallet.address,
      previousAddress: existing?.address,
      previousProvider: existing?.provider,
      blockchain: wallet.blockchain,
      simulatedAllowed: allowSimulatedArc(),
    },
  });

  try {
    await syncWalletBalances(input.organizationId);
  } catch {
    // balance sync may be empty until funded
  }

  return prisma.orgWallet.findUniqueOrThrow({ where: { id: wallet.id } });
}

export async function createTreasuryLinkChallenge(input: {
  organizationId: string;
  userId: string;
  domain: string;
  uri: string;
}) {
  const nonce = newChallengeNonce();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  const chain = getArcChain();
  const message = [
    `${input.domain} wants you to sign in with your Arc wallet:`,
    "",
    `URI: ${input.uri}`,
    `Version: 1`,
    `Chain ID: ${chain === "ARC" ? 5042002 : 5042002}`,
    `Nonce: ${nonce}`,
    `Issued At: ${new Date().toISOString()}`,
    `Expiration Time: ${expiresAt.toISOString()}`,
    "",
    "Link this address as the company treasury wallet for Custara.",
  ].join("\n");

  await prisma.walletLinkChallenge.create({
    data: {
      organizationId: input.organizationId,
      nonce,
      message,
      expiresAt,
      createdById: input.userId,
    },
  });

  return { nonce, message, expiresAt };
}

export async function verifyAndLinkTreasuryWallet(input: {
  organizationId: string;
  userId: string;
  address: string;
  signature: string;
  message?: string;
}) {
  const address = normalizeAddress(input.address);
  const challenge = await prisma.walletLinkChallenge.findFirst({
    where: {
      organizationId: input.organizationId,
      consumedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!challenge) throw new Error("No active wallet link challenge");

  const messageText = input.message || challenge.message;
  if (!messageText.includes(challenge.nonce)) {
    throw new Error("Challenge nonce mismatch");
  }

  // Prefer SIWE parse when message is SIWE-shaped; otherwise recover via viem personal_sign
  let recovered: string | null = null;
  try {
    if (messageText.includes("wants you to sign in with your Ethereum account")) {
      const siwe = new SiweMessage(messageText);
      const result = await siwe.verify({ signature: input.signature });
      if (!result.success) throw new Error("SIWE verification failed");
      recovered = result.data.address.toLowerCase();
    }
  } catch {
    recovered = null;
  }

  if (!recovered) {
    const { verifyMessage } = await import("viem");
    const ok = await verifyMessage({
      address: address as `0x${string}`,
      message: messageText,
      signature: input.signature as `0x${string}`,
    });
    if (!ok) throw new Error("Signature verification failed");
    recovered = address;
  }

  if (recovered !== address) {
    throw new Error("Signed address does not match claimed treasury address");
  }

  await prisma.walletLinkChallenge.update({
    where: { id: challenge.id },
    data: { consumedAt: new Date() },
  });

  // Deactivate prior treasury wallets
  await prisma.orgWallet.updateMany({
    where: { organizationId: input.organizationId, role: "treasury_external", status: "active" },
    data: { status: "revoked" },
  });

  const wallet = await prisma.orgWallet.create({
    data: {
      organizationId: input.organizationId,
      role: "treasury_external",
      provider: "external",
      blockchain: getArcChain(),
      address,
      status: "active",
      label: "Company treasury",
      verifiedAt: new Date(),
    },
  });

  // Auto-allowlist treasury for funding agent wallet
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
    metadata: { address },
  });

  return wallet;
}

/** Dev/sandbox path: link treasury without browser wallet when CIRCLE not required. */
export async function linkTreasuryAddressManual(input: {
  organizationId: string;
  userId: string;
  address: string;
}) {
  const address = normalizeAddress(input.address);
  await prisma.orgWallet.updateMany({
    where: { organizationId: input.organizationId, role: "treasury_external", status: "active" },
    data: { status: "revoked" },
  });
  const wallet = await prisma.orgWallet.create({
    data: {
      organizationId: input.organizationId,
      role: "treasury_external",
      provider: "external",
      blockchain: getArcChain(),
      address,
      status: "active",
      label: "Company treasury",
      verifiedAt: new Date(),
    },
  });
  await prisma.destinationAllowlist.upsert({
    where: { organizationId_address: { organizationId: input.organizationId, address } },
    create: { organizationId: input.organizationId, address, label: "Company treasury", isActive: true },
    update: { isActive: true, revokedAt: null },
  });
  await writeAudit({
    organizationId: input.organizationId,
    actorType: "user",
    actorId: input.userId,
    action: "wallet.treasury_linked_manual",
    entityType: "org_wallet",
    entityId: wallet.id,
    metadata: { address },
  });
  return wallet;
}

function sleepMs(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fund the active Circle agent via Circle testnet faucet.
 * When waitMs > 0, retries through rate limits and polls Sync until balance rises or time runs out.
 */
export async function fundAgentTestnet(input: {
  organizationId: string;
  actorId?: string;
  /** How long to keep retrying / polling in this request (ms). Cap ~3 minutes for HTTP. */
  waitMs?: number;
}) {
  const agent = await prisma.orgWallet.findFirst({
    where: { organizationId: input.organizationId, role: "agent", status: "active" },
    orderBy: { createdAt: "desc" },
  });
  if (!agent) throw new Error("No active agent wallet — provision or upgrade first");
  if (agent.provider !== "circle" || agent.circleWalletId?.startsWith("sbx_")) {
    throw new Error("Upgrade to a Circle testnet agent before funding");
  }
  const chain = agent.blockchain || getArcChain();
  if (chain !== "ARC-TESTNET" && !String(chain).toUpperCase().includes("TESTNET")) {
    throw new Error("Fund is only for testnet agent wallets");
  }

  const waitMs = Math.max(0, Math.min(input.waitMs ?? 0, 180_000));
  const deadline = Date.now() + waitMs;
  const before =
    (await getWalletUsdcBalance({
      walletId: agent.circleWalletId,
      address: agent.address,
      provider: agent.provider,
    }).catch(() => agent.balanceUsdc ?? 0)) ?? 0;

  let wallets = await listOrgWallets(input.organizationId);
  let balanceUsdc = wallets.find((w) => w.id === agent.id)?.balanceUsdc ?? before;

  if (before > 0) {
    return {
      faucet: {
        ok: true as const,
        method: "circle_api" as const,
        message: `Already funded — agent has ${before} USDC.`,
      },
      funded: true,
      agentAddress: agent.address,
      blockchain: chain,
      balanceUsdc: before,
      balanceBefore: before,
      wallets,
    };
  }

  let faucet = await requestTestnetUsdcFaucet({
    address: agent.address,
    blockchain: chain,
    retries: 0,
  });

  await writeAudit({
    organizationId: input.organizationId,
    actorType: "user",
    actorId: input.actorId,
    action: "wallet.agent_fund_requested",
    entityType: "org_wallet",
    entityId: agent.id,
    metadata: {
      address: agent.address,
      method: faucet.method,
      ok: faucet.ok,
      blockchain: chain,
      waitMs,
    },
  });

  const refreshBalance = async () => {
    try {
      wallets = await syncWalletBalances(input.organizationId);
    } catch {
      // ignore transient sync errors
    }
    balanceUsdc =
      wallets.find((w) => w.id === agent.id)?.balanceUsdc ??
      (await getWalletUsdcBalance({
        walletId: agent.circleWalletId,
        address: agent.address,
        provider: agent.provider,
      }).catch(() => balanceUsdc));
    return balanceUsdc;
  };

  if (faucet.ok || waitMs > 0) {
    await refreshBalance();
  }

  while (balanceUsdc <= before && Date.now() < deadline) {
    if (!faucet.ok) {
      const pause =
        faucet.method === "rate_limited"
          ? Math.min(faucet.retryAfterMs || 60_000, Math.max(5_000, deadline - Date.now()))
          : Math.min(30_000, Math.max(5_000, deadline - Date.now()));
      if (pause <= 0) break;
      await sleepMs(pause);
      faucet = await requestTestnetUsdcFaucet({
        address: agent.address,
        blockchain: chain,
        retries: 0,
      });
    } else {
      await sleepMs(Math.min(8_000, Math.max(3_000, deadline - Date.now())));
    }
    await refreshBalance();
  }

  const funded = balanceUsdc > before;
  return {
    faucet: funded
      ? {
          ok: true as const,
          method: "circle_api" as const,
          message: `Funded — agent now has ${balanceUsdc} USDC.`,
        }
      : faucet,
    funded,
    agentAddress: agent.address,
    blockchain: chain,
    balanceUsdc,
    balanceBefore: before,
    wallets,
  };
}

export async function syncWalletBalances(organizationId: string) {
  const wallets = await prisma.orgWallet.findMany({
    where: { organizationId, status: "active" },
  });
  const now = new Date();
  for (const w of wallets) {
    const balance = await getWalletUsdcBalance({
      walletId: w.circleWalletId,
      address: w.address,
      provider: w.provider,
    });
    await prisma.orgWallet.update({
      where: { id: w.id },
      data: { balanceUsdc: balance, balanceSyncedAt: now },
    });
  }
  return prisma.orgWallet.findMany({
    where: { organizationId, status: "active" },
    orderBy: { role: "asc" },
  });
}

export async function listOrgWallets(organizationId: string) {
  return prisma.orgWallet.findMany({
    where: { organizationId },
    orderBy: [{ role: "asc" }, { createdAt: "desc" }],
  });
}
