import { createHmac, timingSafeEqual } from "crypto";
import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { encryptField, decryptField } from "@/lib/crypto";
import { ingestInvoice } from "@/domain/ingest";

const TYPE = "whatsapp_business";

export function isWhatsAppConfigured() {
  return Boolean(
    process.env.WHATSAPP_TOKEN?.trim() &&
      process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() &&
      process.env.WHATSAPP_VERIFY_TOKEN?.trim(),
  );
}

export async function ensureWhatsAppConnector(organizationId: string) {
  return prisma.integrationConnector.upsert({
    where: { organizationId_type: { organizationId, type: TYPE } },
    create: {
      organizationId,
      type: TYPE,
      name: "WhatsApp Business ingest",
      status: isWhatsAppConfigured() ? "connected" : "disconnected",
      configJson: JSON.stringify({
        phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || null,
        ingestMedia: true,
      }),
      secretsJson: process.env.WHATSAPP_APP_SECRET
        ? JSON.stringify({ appSecretEnc: encryptField(process.env.WHATSAPP_APP_SECRET) })
        : "{}",
    },
    update: {
      status: isWhatsAppConfigured() ? "connected" : "disconnected",
    },
  });
}

export function verifyWhatsAppWebhookChallenge(input: {
  mode?: string | null;
  token?: string | null;
  challenge?: string | null;
}) {
  const verify = (process.env.WHATSAPP_VERIFY_TOKEN || "").trim();
  if (input.mode === "subscribe" && input.token === verify && input.challenge) {
    return input.challenge;
  }
  return null;
}

export function verifyWhatsAppSignature(rawBody: string, signatureHeader: string | null) {
  const secret = (process.env.WHATSAPP_APP_SECRET || "").trim();
  if (!secret) return true; // allow if secret unset (dev)
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const got = signatureHeader.slice("sha256=".length);
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(got));
  } catch {
    return false;
  }
}

type WaMessage = {
  id?: string;
  from?: string;
  type?: string;
  text?: { body?: string };
  document?: { id?: string; filename?: string; mime_type?: string };
  image?: { id?: string; mime_type?: string; caption?: string };
};

async function downloadWhatsAppMedia(mediaId: string): Promise<{ bytes: Buffer; mimeType: string }> {
  const token = process.env.WHATSAPP_TOKEN!;
  const metaRes = await fetch(`https://graph.facebook.com/v19.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!metaRes.ok) throw new Error("WhatsApp media metadata failed");
  const meta = (await metaRes.json()) as { url?: string; mime_type?: string };
  if (!meta.url) throw new Error("WhatsApp media URL missing");
  const fileRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${token}` } });
  if (!fileRes.ok) throw new Error("WhatsApp media download failed");
  const bytes = Buffer.from(await fileRes.arrayBuffer());
  return { bytes, mimeType: meta.mime_type || "application/octet-stream" };
}

export async function resolveOrgForWhatsAppSender(waFrom: string) {
  // Map vendor phone → org via destination allowlist label or connector config routing table
  const connectors = await prisma.integrationConnector.findMany({
    where: { type: TYPE, status: "connected" },
  });
  for (const c of connectors) {
    const cfg = JSON.parse(c.configJson || "{}") as { allowedSenders?: string[] };
    if (cfg.allowedSenders?.some((s) => waFrom.endsWith(s.replace(/\D/g, "")) || s === waFrom)) {
      return c.organizationId;
    }
  }
  // Fallback: single-tenant WHATSAPP_DEFAULT_ORG_ID
  return (process.env.WHATSAPP_DEFAULT_ORG_ID || "").trim() || null;
}

export async function ingestWhatsAppMessages(input: {
  organizationId: string;
  messages: WaMessage[];
}) {
  const results: string[] = [];
  for (const msg of input.messages) {
    const externalId = msg.id ? `wa:${msg.id}` : null;
    if (externalId) {
      const exists = await prisma.invoice.findFirst({
        where: { organizationId: input.organizationId, externalId },
        select: { id: true },
      });
      if (exists) {
        results.push(exists.id);
        continue;
      }
    }

    if (msg.type === "document" && msg.document?.id) {
      const { bytes, mimeType } = await downloadWhatsAppMedia(msg.document.id);
      const invoice = await ingestInvoice({
        organizationId: input.organizationId,
        actorType: "system",
        source: "mailbox",
        externalId,
        filename: msg.document.filename || `wa-${msg.id}.bin`,
        mimeType,
        bytes,
        enqueue: true,
      });
      results.push(invoice.id);
      continue;
    }

    if (msg.type === "image" && msg.image?.id) {
      const { bytes, mimeType } = await downloadWhatsAppMedia(msg.image.id);
      const invoice = await ingestInvoice({
        organizationId: input.organizationId,
        actorType: "system",
        source: "mailbox",
        externalId,
        filename: `wa-${msg.id}.jpg`,
        mimeType,
        bytes,
        enqueue: true,
      });
      results.push(invoice.id);
      continue;
    }

    if (msg.type === "text" && msg.text?.body) {
      // Structured text invoice from vendors (Africa-friendly)
      const body = msg.text.body;
      const invoice = await ingestInvoice({
        organizationId: input.organizationId,
        actorType: "system",
        source: "mailbox",
        externalId,
        filename: `wa-${msg.id || "text"}.txt`,
        mimeType: "text/plain",
        bytes: Buffer.from(body, "utf8"),
        enqueue: true,
      });
      results.push(invoice.id);
    }
  }

  await writeAudit({
    organizationId: input.organizationId,
    actorType: "system",
    action: "connector.whatsapp_ingested",
    entityType: "connector",
    metadata: { count: results.length },
  });

  return { ingested: results.length, invoiceIds: results };
}

export async function saveWhatsAppAllowedSenders(organizationId: string, senders: string[]) {
  const connector = await ensureWhatsAppConnector(organizationId);
  const cfg = JSON.parse(connector.configJson || "{}") as Record<string, unknown>;
  await prisma.integrationConnector.update({
    where: { id: connector.id },
    data: {
      configJson: JSON.stringify({
        ...cfg,
        allowedSenders: senders.map((s) => s.trim()).filter(Boolean),
      }),
      status: isWhatsAppConfigured() ? "connected" : "disconnected",
    },
  });
}

/** Keep decrypt import used when reading secrets in future refresh paths */
void decryptField;
