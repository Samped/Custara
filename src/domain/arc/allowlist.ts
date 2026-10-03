import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";

function normalizeAddress(address: string) {
  const a = address.trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(a)) throw new Error("Invalid address");
  return a;
}

export async function isDestinationAllowed(organizationId: string, address: string) {
  const normalized = normalizeAddress(address);
  const row = await prisma.destinationAllowlist.findFirst({
    where: { organizationId, address: normalized, isActive: true, revokedAt: null },
  });
  return Boolean(row);
}

export async function assertDestinationAllowed(organizationId: string, address: string) {
  const ok = await isDestinationAllowed(organizationId, address);
  if (!ok) {
    throw new Error(`Destination ${address} is not on the organization allowlist`);
  }
}

export async function addDestination(input: {
  organizationId: string;
  address: string;
  label?: string;
  vendorId?: string;
  actorId?: string;
}) {
  const address = normalizeAddress(input.address);
  const { screenDestination } = await import("@/domain/screening");
  await screenDestination({
    organizationId: input.organizationId,
    address,
    context: "allowlist_add",
  });
  const row = await prisma.destinationAllowlist.upsert({
    where: { organizationId_address: { organizationId: input.organizationId, address } },
    create: {
      organizationId: input.organizationId,
      address,
      label: input.label || null,
      vendorId: input.vendorId || null,
      isActive: true,
    },
    update: {
      label: input.label || null,
      vendorId: input.vendorId || null,
      isActive: true,
      revokedAt: null,
    },
  });
  await writeAudit({
    organizationId: input.organizationId,
    actorType: "user",
    actorId: input.actorId,
    action: "wallet.allowlist_added",
    entityType: "destination_allowlist",
    entityId: row.id,
    metadata: { address },
  });
  return row;
}

export async function revokeDestination(input: {
  organizationId: string;
  address: string;
  actorId?: string;
}) {
  const address = normalizeAddress(input.address);
  const row = await prisma.destinationAllowlist.update({
    where: { organizationId_address: { organizationId: input.organizationId, address } },
    data: { isActive: false, revokedAt: new Date() },
  });
  await writeAudit({
    organizationId: input.organizationId,
    actorType: "user",
    actorId: input.actorId,
    action: "wallet.allowlist_revoked",
    entityType: "destination_allowlist",
    entityId: row.id,
    metadata: { address },
  });
  return row;
}

export async function getDailySpendUsd(organizationId: string) {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const intents = await prisma.paymentIntent.findMany({
    where: {
      organizationId,
      rail: "arc_usdc",
      status: { in: ["submitted", "exported", "completed", "queued", "pending_transfer"] },
      createdAt: { gte: start },
      currency: { in: ["USDC", "USD"] },
    },
  });
  return intents.reduce((acc, i) => acc + i.amount, 0);
}

export async function assertSpendLimits(organizationId: string, amountUsd: number) {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
  if (org.agentWalletFrozen) {
    throw new Error("Agent wallet is frozen — unfreeze in Wallets settings before transferring");
  }
  const spent = await getDailySpendUsd(organizationId);
  if (spent + amountUsd > org.dailySpendLimitUsd) {
    throw new Error(
      `Daily spend limit exceeded (${spent + amountUsd} > ${org.dailySpendLimitUsd} USDC). Raise limit or wait until UTC midnight.`,
    );
  }
}
