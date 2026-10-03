import { randomBytes } from "crypto";
import { prisma } from "@/lib/db";
import { generateApiKey } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";

export const PARTNER_API_SCOPES = [
  "invoices:read",
  "invoices:write",
  "approvals:write",
  "payments:initiate",
  "cash:read",
  "audit:read",
  "connectors:write",
] as const;

export const WEBHOOK_EVENT_OPTIONS = [
  { value: "*", label: "All events" },
  { value: "invoice.ingested", label: "invoice.ingested" },
  { value: "invoice.received", label: "invoice.received (alias)" },
  { value: "invoice.analyzed", label: "invoice.analyzed" },
  { value: "approval.requested", label: "approval.requested" },
  { value: "approval.needed", label: "approval.needed" },
  { value: "approval.decided", label: "approval.decided" },
  { value: "payment.created", label: "payment.created" },
  { value: "payment.sent", label: "payment.sent" },
  { value: "invoice.reconciled", label: "invoice.reconciled" },
  { value: "receivable.reminder", label: "receivable.reminder" },
] as const;

export async function createPartnerApiKey(input: {
  organizationId: string;
  actorId: string;
  name: string;
  scopes?: string[];
}) {
  const name = input.name.trim() || "Partner API key";
  const scopes = (input.scopes?.length ? input.scopes : [...PARTNER_API_SCOPES]).filter((s) =>
    (PARTNER_API_SCOPES as readonly string[]).includes(s),
  );
  if (!scopes.length) throw new Error("Select at least one scope");

  const { raw, prefix, hash } = generateApiKey();
  const key = await prisma.apiKey.create({
    data: {
      organizationId: input.organizationId,
      name,
      keyPrefix: prefix,
      keyHash: hash,
      scopesJson: JSON.stringify(scopes),
    },
  });

  await writeAudit({
    organizationId: input.organizationId,
    actorType: "user",
    actorId: input.actorId,
    action: "api_key.created",
    entityType: "api_key",
    entityId: key.id,
    metadata: { name, scopes, prefix },
  });

  return { key, raw };
}

export async function revokePartnerApiKey(input: {
  organizationId: string;
  actorId: string;
  apiKeyId: string;
}) {
  const existing = await prisma.apiKey.findFirst({
    where: { id: input.apiKeyId, organizationId: input.organizationId },
  });
  if (!existing) throw new Error("API key not found");
  if (existing.revokedAt) return existing;

  const key = await prisma.apiKey.update({
    where: { id: existing.id },
    data: { revokedAt: new Date() },
  });

  await writeAudit({
    organizationId: input.organizationId,
    actorType: "user",
    actorId: input.actorId,
    action: "api_key.revoked",
    entityType: "api_key",
    entityId: key.id,
    metadata: { name: key.name, prefix: key.keyPrefix },
  });

  return key;
}

export async function createPartnerWebhook(input: {
  organizationId: string;
  actorId: string;
  url: string;
  events: string[];
}) {
  const url = input.url.trim();
  if (!/^https?:\/\//i.test(url)) throw new Error("Webhook URL must start with http:// or https://");

  const allowed = new Set(WEBHOOK_EVENT_OPTIONS.map((e) => e.value));
  const events = input.events.filter((e) => allowed.has(e as (typeof WEBHOOK_EVENT_OPTIONS)[number]["value"]));
  if (!events.length) throw new Error("Select at least one webhook event");

  const secret = `whsec_${randomBytes(24).toString("hex")}`;
  const { encryptWebhookSecret } = await import("@/lib/crypto");
  const endpoint = await prisma.webhookEndpoint.create({
    data: {
      organizationId: input.organizationId,
      url,
      secret: encryptWebhookSecret(secret),
      eventsJson: JSON.stringify(events),
      isActive: true,
    },
  });

  await writeAudit({
    organizationId: input.organizationId,
    actorType: "user",
    actorId: input.actorId,
    action: "webhook.created",
    entityType: "webhook_endpoint",
    entityId: endpoint.id,
    metadata: { url, events },
  });

  // Return plaintext once — never stored plaintext at rest
  return { endpoint, secret };
}

export async function setPartnerWebhookActive(input: {
  organizationId: string;
  actorId: string;
  endpointId: string;
  isActive: boolean;
}) {
  const existing = await prisma.webhookEndpoint.findFirst({
    where: { id: input.endpointId, organizationId: input.organizationId },
  });
  if (!existing) throw new Error("Webhook not found");

  const endpoint = await prisma.webhookEndpoint.update({
    where: { id: existing.id },
    data: { isActive: input.isActive },
  });

  await writeAudit({
    organizationId: input.organizationId,
    actorType: "user",
    actorId: input.actorId,
    action: input.isActive ? "webhook.activated" : "webhook.deactivated",
    entityType: "webhook_endpoint",
    entityId: endpoint.id,
    metadata: { url: endpoint.url },
  });

  return endpoint;
}
