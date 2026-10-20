import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { dispatchWebhook } from "@/lib/webhooks";
import { sha256 } from "@/lib/crypto";
import { enqueueJob } from "@/lib/jobs";

export async function ensureStorage() {
  return;
}

export class InvoiceConflictError extends Error {
  status = 409;
  invoiceId: string;
  externalId: string;

  constructor(invoiceId: string, externalId: string) {
    super(
      `An invoice with external_id ${externalId} already exists. Use id ${invoiceId}, or send a new external_id.`,
    );
    this.name = "InvoiceConflictError";
    this.invoiceId = invoiceId;
    this.externalId = externalId;
  }
}

function isUniqueConflict(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

export async function ingestInvoice(input: {
  organizationId: string;
  actorType: "user" | "system" | "api_key";
  actorId?: string;
  source: "upload" | "api" | "mailbox" | "accounting";
  externalId?: string | null;
  currency?: string;
  vendorExternalId?: string | null;
  filename?: string;
  mimeType?: string;
  bytes?: Buffer | null;
  structuredPayload?: Record<string, unknown> | null;
  requestId?: string;
  enqueue?: boolean;
  sourceBatchId?: string | null;
  sourceSegmentIndex?: number | null;
}) {
  await ensureStorage();

  const externalId = input.externalId || null;
  if (externalId) {
    const existing = await prisma.invoice.findUnique({
      where: {
        organizationId_externalId: {
          organizationId: input.organizationId,
          externalId,
        },
      },
      select: { id: true },
    });
    if (existing) throw new InvoiceConflictError(existing.id, externalId);
  }

  let invoice;
  try {
    invoice = await prisma.invoice.create({
      data: {
        organizationId: input.organizationId,
        externalId,
        currency: input.currency || "NGN",
        source: input.source,
        status: "received",
        requestId: input.requestId || null,
        sourceBatchId: input.sourceBatchId || null,
        sourceSegmentIndex: input.sourceSegmentIndex ?? null,
      },
    });
  } catch (error) {
    if (externalId && isUniqueConflict(error)) {
      const existing = await prisma.invoice.findUnique({
        where: {
          organizationId_externalId: {
            organizationId: input.organizationId,
            externalId,
          },
        },
        select: { id: true },
      });
      if (existing) throw new InvoiceConflictError(existing.id, externalId);
    }
    throw error;
  }

  if (input.bytes && input.filename) {
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: input.organizationId },
    });
    const retainedUntil = org.privacyMode
      ? new Date(Date.now() + org.privacyDeleteDays * 24 * 60 * 60 * 1000)
      : null;

    await prisma.invoiceDocument.create({
      data: {
        invoiceId: invoice.id,
        filename: input.filename,
        mimeType: input.mimeType || "application/octet-stream",
        storagePath: `db/${invoice.id}/${input.filename}`,
        content: input.bytes,
        byteSize: input.bytes.length,
        checksumSha256: sha256(input.bytes),
        retainedUntil,
      },
    });
  }

  if (input.structuredPayload) {
    const payload = Buffer.from(JSON.stringify(input.structuredPayload, null, 2), "utf8");
    await prisma.invoiceDocument.create({
      data: {
        invoiceId: invoice.id,
        filename: input.filename || "invoice.json",
        mimeType: "application/json",
        storagePath: `db/${invoice.id}/invoice.json`,
        content: payload,
        byteSize: payload.length,
        checksumSha256: sha256(payload),
      },
    });
  }

  await writeAudit({
    organizationId: input.organizationId,
    actorType: input.actorType,
    actorId: input.actorId,
    action: "invoice.received",
    entityType: "invoice",
    entityId: invoice.id,
    requestId: input.requestId,
    metadata: { source: input.source, externalId: input.externalId },
  });

  await dispatchWebhook(input.organizationId, "invoice.ingested", {
    id: invoice.id,
    status: invoice.status,
    source: input.source,
  });
  // Backward-compatible alias for older webhook subscriptions
  await dispatchWebhook(input.organizationId, "invoice.received", {
    id: invoice.id,
    status: invoice.status,
    source: input.source,
  });

  if (input.enqueue !== false) {
    await enqueueJob({
      queue: "invoice-pipeline",
      name: "analyze_invoice",
      organizationId: input.organizationId,
      payload: {
        invoiceId: invoice.id,
        actorType: input.actorType,
        actorId: input.actorId,
        requestId: input.requestId,
      },
    });
  }

  return invoice;
}
