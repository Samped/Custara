import { SiweMessage } from "siwe";
import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { getArcChain } from "./config";
import { createAgentWallet, getWalletUsdcBalance, newChallengeNonce } from "./circle";

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
