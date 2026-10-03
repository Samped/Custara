import { createHash } from "crypto";
import { randomUUID } from "crypto";
import { prisma } from "./db";

export function createRequestId() {
  return randomUUID();
}

function canonicalAuditPayload(input: {
  organizationId: string;
  actorType: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  requestId: string | null;
  metadataJson: string;
  prevHash: string | null;
  createdAtIso: string;
}) {
  return JSON.stringify({
    organizationId: input.organizationId,
    actorType: input.actorType,
    actorId: input.actorId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    requestId: input.requestId,
    metadataJson: input.metadataJson,
    prevHash: input.prevHash,
    createdAt: input.createdAtIso,
  });
}

export async function writeAudit(input: {
  organizationId: string;
  actorType: "user" | "system" | "api_key";
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  requestId?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const latest = await prisma.auditEvent.findFirst({
    where: { organizationId: input.organizationId },
    orderBy: { createdAt: "desc" },
    select: { entryHash: true },
  });
  const prevHash = latest?.entryHash || null;
  const createdAt = new Date();
  const metadataJson = JSON.stringify(input.metadata ?? {});
  const entryHash = createHash("sha256")
    .update(
      canonicalAuditPayload({
        organizationId: input.organizationId,
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        requestId: input.requestId ?? null,
        metadataJson,
        prevHash,
        createdAtIso: createdAt.toISOString(),
      }),
    )
    .digest("hex");

  return prisma.auditEvent.create({
    data: {
      organizationId: input.organizationId,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      requestId: input.requestId ?? null,
      metadataJson,
      prevHash,
      entryHash,
      createdAt,
    },
  });
}

export async function verifyAuditChain(organizationId: string) {
  const events = await prisma.auditEvent.findMany({
    where: { organizationId },
    orderBy: { createdAt: "asc" },
  });
  let prev: string | null = null;
  for (const e of events) {
    if ((e.prevHash || null) !== prev) {
      return { ok: false as const, brokenId: e.id, count: events.length };
    }
    const expected = createHash("sha256")
      .update(
        canonicalAuditPayload({
          organizationId: e.organizationId,
          actorType: e.actorType,
          actorId: e.actorId,
          action: e.action,
          entityType: e.entityType,
          entityId: e.entityId,
          requestId: e.requestId,
          metadataJson: e.metadataJson,
          prevHash: e.prevHash,
          createdAtIso: e.createdAt.toISOString(),
        }),
      )
      .digest("hex");
    if (e.entryHash !== expected) {
      return { ok: false as const, brokenId: e.id, count: events.length };
    }
    prev = e.entryHash;
  }
  return { ok: true as const, count: events.length };
}
