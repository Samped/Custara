import { createHash, randomBytes } from "crypto";
import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { ingestInvoice } from "@/domain/ingest";
import { runInvoicePipeline } from "@/domain/pipeline";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function createVendorPortalInvite(input: {
  organizationId: string;
  actorId: string;
  email: string;
  vendorId?: string | null;
  label?: string | null;
  expiresInDays?: number;
}) {
  const email = input.email.trim().toLowerCase();
  if (!email || !email.includes("@")) throw new Error("Valid vendor email required");

  if (input.vendorId) {
    const vendor = await prisma.vendor.findFirst({
      where: { id: input.vendorId, organizationId: input.organizationId },
    });
    if (!vendor) throw new Error("Vendor not found");
  }

  const raw = `vp_${randomBytes(24).toString("base64url")}`;
  const expiresAt = new Date(Date.now() + (input.expiresInDays || 30) * 864e5);

  const invite = await prisma.vendorPortalInvite.create({
    data: {
      organizationId: input.organizationId,
      vendorId: input.vendorId || null,
      email,
      tokenHash: hashToken(raw),
      label: input.label?.trim() || null,
      expiresAt,
    },
  });

  await writeAudit({
    organizationId: input.organizationId,
    actorType: "user",
    actorId: input.actorId,
    action: "vendor_portal.invite_created",
    entityType: "vendor_portal_invite",
    entityId: invite.id,
    metadata: { email },
  });

  return { invite, token: raw };
}

export async function listVendorPortalInvites(organizationId: string) {
  return prisma.vendorPortalInvite.findMany({
    where: { organizationId },
    include: { vendor: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
}

export async function revokeVendorPortalInvite(input: {
  organizationId: string;
  inviteId: string;
  actorId: string;
}) {
  const invite = await prisma.vendorPortalInvite.findFirst({
    where: { id: input.inviteId, organizationId: input.organizationId },
  });
  if (!invite) throw new Error("Invite not found");
  await prisma.vendorPortalInvite.update({
    where: { id: invite.id },
    data: { revokedAt: new Date() },
  });
  await writeAudit({
    organizationId: input.organizationId,
    actorType: "user",
    actorId: input.actorId,
    action: "vendor_portal.invite_revoked",
    entityType: "vendor_portal_invite",
    entityId: invite.id,
  });
}

export async function resolveVendorPortalToken(rawToken: string) {
  const token = rawToken.trim();
  if (!token) return null;
  const invite = await prisma.vendorPortalInvite.findUnique({
    where: { tokenHash: hashToken(token) },
    include: {
      organization: { select: { id: true, name: true, slug: true } },
      vendor: { select: { id: true, name: true, email: true } },
    },
  });
  if (!invite) return null;
  if (invite.revokedAt) return null;
  if (invite.expiresAt.getTime() < Date.now()) return null;
  return invite;
}

export async function submitVendorPortalInvoice(input: {
  token: string;
  filename: string;
  mimeType: string;
  bytes: Buffer;
  invoiceNumber?: string;
  totalAmount?: number;
  currency?: string;
  notes?: string;
  sync?: boolean;
}) {
  const invite = await resolveVendorPortalToken(input.token);
  if (!invite) throw new Error("Invalid or expired portal link");

  if (!input.bytes.length) throw new Error("Empty file");
  if (input.bytes.length > 25 * 1024 * 1024) throw new Error("File too large (max 25MB)");

  const structured: Record<string, unknown> = {
    source_channel: "vendor_portal",
    vendor_email: invite.email,
    vendor_name: invite.vendor?.name,
    invoice_number: input.invoiceNumber || undefined,
    total_amount: input.totalAmount,
    currency: (input.currency || "NGN").toUpperCase(),
    description: input.notes || undefined,
  };

  const invoice = await ingestInvoice({
    organizationId: invite.organizationId,
    actorType: "system",
    source: "upload",
    externalId: `vp:${invite.id}:${Date.now()}`,
    currency: String(structured.currency),
    vendorExternalId: invite.vendorId || null,
    filename: input.filename,
    mimeType: input.mimeType,
    bytes: input.bytes,
    structuredPayload: structured,
    enqueue: input.sync ? false : true,
  });

  if (invite.vendorId) {
    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { vendorId: invite.vendorId },
    });
  }

  if (input.sync) {
    await runInvoicePipeline(invoice.id, { type: "system" });
  }

  await prisma.vendorPortalInvite.update({
    where: { id: invite.id },
    data: { lastUsedAt: new Date() },
  });

  await writeAudit({
    organizationId: invite.organizationId,
    actorType: "system",
    action: "vendor_portal.invoice_submitted",
    entityType: "invoice",
    entityId: invoice.id,
    metadata: { inviteId: invite.id, email: invite.email },
  });

  return { invoiceId: invoice.id, organizationName: invite.organization.name };
}
