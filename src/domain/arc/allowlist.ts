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
  // Clear pay holds that existed only because this destination was unknown.
  await prisma.riskAssessment.deleteMany({
    where: {
      code: "destination_not_allowlisted",
      invoice: { organizationId: input.organizationId },
      OR: [
        { evidenceJson: { contains: address } },
        {
          invoice: {
            vendor: {
              endpoints: {
                some: { endpointType: "arc_usdc", arcAddress: address },
              },
            },
          },
        },
      ],
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

/**
 * Confirm the invoice's Arc destination from the workbench (no Wallets detour).
 * Adds to org allowlist and clears destination_not_allowlisted holds.
 */
export async function confirmInvoiceDestination(input: {
  organizationId: string;
  invoiceId: string;
  actorId: string;
}) {
  const invoice = await prisma.invoice.findFirst({
    where: { id: input.invoiceId, organizationId: input.organizationId },
    include: {
      vendor: {
        include: {
          endpoints: { where: { isActive: true, endpointType: "arc_usdc" }, orderBy: { version: "desc" } },
        },
      },
      risks: true,
      extraction: true,
    },
  });
  if (!invoice) throw new Error("Invoice not found");

  const fromEndpoint = invoice.vendor?.endpoints.find((e) => e.arcAddress)?.arcAddress;
  const destRisk = invoice.risks.find((r) => r.code === "destination_not_allowlisted");
  let evidence: { address?: string } | null = null;
  if (destRisk?.evidenceJson) {
    try {
      evidence = JSON.parse(destRisk.evidenceJson) as { address?: string };
    } catch {
      evidence = null;
    }
  }
  let fromRaw: string | null = null;
  if (invoice.extraction?.rawJson) {
    try {
      const raw = JSON.parse(invoice.extraction.rawJson) as { arcAddress?: string; arc_address?: string };
      fromRaw = raw.arcAddress || raw.arc_address || null;
    } catch {
      fromRaw = null;
    }
  }
  const address = (fromEndpoint || evidence?.address || fromRaw || "").trim();
  if (!address) throw new Error("No Arc destination found on this invoice");

  const label =
    invoice.vendor?.name || invoice.extraction?.vendorName || invoice.extraction?.accountName || undefined;

  return addDestination({
    organizationId: input.organizationId,
    address,
    label: label || undefined,
    vendorId: invoice.vendorId || undefined,
    actorId: input.actorId,
  });
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
