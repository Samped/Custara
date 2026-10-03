import { ImapFlow } from "imapflow";
import { prisma } from "@/lib/db";
import { decryptField, encryptField, sha256 } from "@/lib/crypto";
import { ingestInvoice } from "@/domain/ingest";
import { writeAudit } from "@/lib/audit";

const MAILBOX_TYPE = "mailbox_imap";
const BODY_SNIPPET_MAX = 200;

/** Privacy-safe email audit: subject + truncated snippet + hash of full provided text (body not stored as a document). */
export function buildEmailAuditMeta(input: {
  subject?: string;
  bodyText?: string;
  messageId?: string;
}) {
  const subject = (input.subject || "").trim().slice(0, 300) || undefined;
  const rawBody = (input.bodyText || "").trim();
  const bodySnippet = rawBody ? rawBody.slice(0, BODY_SNIPPET_MAX) : undefined;
  const bodyHash = rawBody ? sha256(rawBody) : undefined;
  return {
    subject,
    bodySnippet,
    bodyHash,
    messageId: input.messageId || undefined,
    bodyStored: false as const,
  };
}

export type MailboxConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  folder: string;
};

export function ingestEmailDomain() {
  return (process.env.INGEST_EMAIL_DOMAIN || "ingest.custara.local").trim().toLowerCase();
}

export function defaultIngestEmailForSlug(slug: string) {
  return `invoices+${slug}@${ingestEmailDomain()}`;
}

export async function ensureMailboxConnector(organizationId: string) {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
  if (!org.ingestEmail) {
    await prisma.organization.update({
      where: { id: organizationId },
      data: { ingestEmail: defaultIngestEmailForSlug(org.slug) },
    });
  }

  return prisma.integrationConnector.upsert({
    where: {
      organizationId_type: { organizationId, type: MAILBOX_TYPE },
    },
    create: {
      organizationId,
      type: MAILBOX_TYPE,
      name: "Invoice email inbox",
      status: "disconnected",
      configJson: JSON.stringify({
        host: "",
        port: 993,
        secure: true,
        user: "",
        folder: "INBOX",
      } satisfies MailboxConfig),
      secretsJson: JSON.stringify({}),
    },
    update: {},
  });
}

export async function saveMailboxSettings(input: {
  organizationId: string;
  actorId: string;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password?: string;
  folder?: string;
  ingestEmail?: string;
}) {
  await ensureMailboxConnector(input.organizationId);
  const host = input.host.trim();
  const user = input.user.trim();
  if (!host || !user) throw new Error("IMAP host and user are required");

  const existing = await prisma.integrationConnector.findUniqueOrThrow({
    where: {
      organizationId_type: { organizationId: input.organizationId, type: MAILBOX_TYPE },
    },
  });
  const prevSecrets = JSON.parse(existing.secretsJson || "{}") as { passwordEnc?: string };
  const password = (input.password || "").trim();
  const secrets: { passwordEnc?: string } = { ...prevSecrets };
  if (password) secrets.passwordEnc = encryptField(password);
  if (!secrets.passwordEnc) throw new Error("IMAP password required");

  const config: MailboxConfig = {
    host,
    port: input.port || 993,
    secure: input.secure,
    user,
    folder: (input.folder || "INBOX").trim() || "INBOX",
  };

  let ingestEmail = (input.ingestEmail || "").trim().toLowerCase();
  if (ingestEmail) {
    const clash = await prisma.organization.findFirst({
      where: { ingestEmail, NOT: { id: input.organizationId } },
      select: { id: true },
    });
    if (clash) throw new Error("That ingest email is already used by another workspace");
  } else {
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: input.organizationId } });
    ingestEmail = org.ingestEmail || defaultIngestEmailForSlug(org.slug);
  }

  await prisma.organization.update({
    where: { id: input.organizationId },
    data: { ingestEmail },
  });

  const connector = await prisma.integrationConnector.update({
    where: { id: existing.id },
    data: {
      status: "connected",
      configJson: JSON.stringify(config),
      secretsJson: JSON.stringify(secrets),
    },
  });

  await writeAudit({
    organizationId: input.organizationId,
    actorType: "user",
    actorId: input.actorId,
    action: "connector.mailbox_configured",
    entityType: "connector",
    entityId: connector.id,
    metadata: { host: config.host, user: config.user, ingestEmail },
  });

  return connector;
}

export async function resolveOrganizationByIngestRecipient(recipients: string[]) {
  const domain = ingestEmailDomain();
  const normalized = recipients
    .map((r) => r.toLowerCase().trim())
    .filter(Boolean)
    .map((r) => {
      const m = r.match(/<?([^\s<>]+@[^\s<>]+)>?/);
      return (m?.[1] || r).toLowerCase();
    });

  for (const email of normalized) {
    const org = await prisma.organization.findFirst({
      where: { ingestEmail: email },
    });
    if (org) return org;
  }

  // Fallback: invoices+{slug}@domain
  for (const email of normalized) {
    const m = email.match(new RegExp(`^invoices\\+([a-z0-9-]+)@${domain.replace(/\./g, "\\.")}$`));
    if (!m) continue;
    const org = await prisma.organization.findUnique({ where: { slug: m[1] } });
    if (org) return org;
  }

  return null;
}

export type InboundAttachment = {
  filename: string;
  mimeType: string;
  bytes: Buffer;
};

/** Privacy-first: only attachments become documents; email body is discarded after optional audit hash. */
export async function ingestMailboxAttachments(input: {
  organizationId: string;
  actorType: "user" | "system" | "api_key";
  actorId?: string;
  messageId?: string;
  subject?: string;
  /** Optional plain-text body for audit hash/snippet only — never written to invoice documents. */
  bodyText?: string;
  attachments: InboundAttachment[];
  requestId?: string;
}) {
  const usable = input.attachments.filter((a) => a.bytes.length > 0);
  if (!usable.length) {
    return { ingested: 0, invoiceIds: [] as string[], skipped: "no_attachments" as const };
  }

  const emailMeta = buildEmailAuditMeta({
    subject: input.subject,
    bodyText: input.bodyText,
    messageId: input.messageId,
  });

  const invoiceIds: string[] = [];
  for (const att of usable) {
    const lower = att.filename.toLowerCase();
    const isCsv = lower.endsWith(".csv") || att.mimeType.includes("csv");
    if (isCsv) {
      try {
        const { ingestCsvRows } = await import("@/domain/csvIngest");
        const bulk = await ingestCsvRows({
          organizationId: input.organizationId,
          actorType: input.actorType,
          actorId: input.actorId,
          text: att.bytes.toString("utf8"),
          sync: false,
          requestId: input.requestId,
        });
        invoiceIds.push(...bulk.results.map((r) => r.id));
        continue;
      } catch {
        // fall through to single-file ingest
      }
    }

    const isJson = att.mimeType.includes("json") || lower.endsWith(".json");
    let structuredPayload: Record<string, unknown> | null = null;
    if (isJson) {
      try {
        structuredPayload = JSON.parse(att.bytes.toString("utf8")) as Record<string, unknown>;
      } catch {
        structuredPayload = null;
      }
    }

    const externalId = input.messageId
      ? `mail:${input.messageId}:${att.filename}`.slice(0, 190)
      : null;

    if (externalId) {
      const existing = await prisma.invoice.findFirst({
        where: { organizationId: input.organizationId, externalId },
        select: { id: true },
      });
      if (existing) {
        invoiceIds.push(existing.id);
        continue;
      }
    }

    const invoice = await ingestInvoice({
      organizationId: input.organizationId,
      actorType: input.actorType,
      actorId: input.actorId,
      source: "mailbox",
      externalId,
      filename: att.filename,
      mimeType: att.mimeType,
      bytes: structuredPayload ? null : att.bytes,
      structuredPayload,
      requestId: input.requestId,
      enqueue: true,
    });
    invoiceIds.push(invoice.id);
  }

  await writeAudit({
    organizationId: input.organizationId,
    actorType: input.actorType,
    actorId: input.actorId,
    action: "mailbox.ingested",
    entityType: "mailbox",
    requestId: input.requestId,
    metadata: {
      ...emailMeta,
      ingested: invoiceIds.length,
      invoiceIds,
      attachmentCount: usable.length,
    },
  });

  return { ingested: invoiceIds.length, invoiceIds, skipped: null };
}

export async function pollOrganizationMailbox(organizationId: string) {
  const connector = await prisma.integrationConnector.findUnique({
    where: { organizationId_type: { organizationId, type: MAILBOX_TYPE } },
  });
  if (!connector || connector.status !== "connected") {
    return { polled: false, ingested: 0, reason: "not_connected" as const };
  }

  const config = JSON.parse(connector.configJson || "{}") as MailboxConfig;
  const secrets = JSON.parse(connector.secretsJson || "{}") as { passwordEnc?: string };
  if (!config.host || !config.user || !secrets.passwordEnc) {
    return { polled: false, ingested: 0, reason: "missing_credentials" as const };
  }

  const password = decryptField(secrets.passwordEnc);
  const client = new ImapFlow({
    host: config.host,
    port: config.port || 993,
    secure: config.secure !== false,
    auth: { user: config.user, pass: password },
    logger: false,
  });

  let ingested = 0;
  const invoiceIds: string[] = [];

  try {
    await client.connect();
    const lock = await client.getMailboxLock(config.folder || "INBOX");
    try {
      // Unseen only — privacy + avoid reprocessing
      for await (const msg of client.fetch({ seen: false }, { uid: true, envelope: true, source: true })) {
        const source = msg.source;
        if (!source) continue;
        const parsed = parseMimeAttachments(Buffer.from(source));
        const messageId = msg.envelope?.messageId || `uid-${msg.uid}`;
        const result = await ingestMailboxAttachments({
          organizationId,
          actorType: "system",
          messageId,
          subject: msg.envelope?.subject || undefined,
          attachments: parsed,
        });
        ingested += result.ingested;
        invoiceIds.push(...result.invoiceIds);
        await client.messageFlagsAdd({ uid: msg.uid }, ["\\Seen"]);
      }
    } finally {
      lock.release();
    }

    await prisma.integrationConnector.update({
      where: { id: connector.id },
      data: { lastSyncAt: new Date(), status: "connected" },
    });

    return { polled: true, ingested, invoiceIds, reason: null };
  } catch (e) {
    await prisma.integrationConnector.update({
      where: { id: connector.id },
      data: { status: "error" },
    });
    throw e;
  } finally {
    try {
      await client.logout();
    } catch {
      // ignore
    }
  }
}

export async function pollAllMailboxes() {
  const connectors = await prisma.integrationConnector.findMany({
    where: { type: MAILBOX_TYPE, status: { in: ["connected", "error"] } },
  });
  const summary: { organizationId: string; ingested: number; error?: string }[] = [];
  for (const c of connectors) {
    try {
      const r = await pollOrganizationMailbox(c.organizationId);
      summary.push({ organizationId: c.organizationId, ingested: r.ingested });
    } catch (e) {
      summary.push({
        organizationId: c.organizationId,
        ingested: 0,
        error: e instanceof Error ? e.message : "poll failed",
      });
    }
  }
  return summary;
}

/** Minimal MIME multipart extractor for common invoice attachments. */
export function parseMimeAttachments(raw: Buffer): InboundAttachment[] {
  const text = raw.toString("binary");
  const boundaryMatch = text.match(/boundary="?([^"\r\n;]+)"?/i);
  if (!boundaryMatch) {
    // Single-part: treat whole body as attachment if Content-Disposition attachment
    return [];
  }
  const boundary = boundaryMatch[1];
  const parts = text.split(`--${boundary}`);
  const out: InboundAttachment[] = [];

  for (const part of parts) {
    if (part.startsWith("--") || part.length < 20) continue;
    const headerEnd = part.indexOf("\r\n\r\n");
    const headerEnd2 = part.indexOf("\n\n");
    const splitAt = headerEnd >= 0 ? headerEnd : headerEnd2;
    if (splitAt < 0) continue;
    const headers = part.slice(0, splitAt);
    let body = part.slice(splitAt + (headerEnd >= 0 ? 4 : 2));
    if (body.endsWith("\r\n")) body = body.slice(0, -2);
    else if (body.endsWith("\n")) body = body.slice(0, -1);

    const disposition = /content-disposition:\s*([^\r\n]+)/i.exec(headers)?.[1] || "";
    const isAttachment = /attachment/i.test(disposition) || /name=/i.test(disposition);
    const filenameMatch =
      /filename\*?=(?:UTF-8''|")?([^\";\r\n]+)"?/i.exec(disposition) ||
      /name="?([^\";\r\n]+)"?/i.exec(headers);
    if (!isAttachment && !filenameMatch) continue;

    const filename = decodeURIComponent((filenameMatch?.[1] || "attachment.bin").replace(/"/g, "").trim());
    const mimeType =
      /content-type:\s*([^;\r\n]+)/i.exec(headers)?.[1]?.trim() || "application/octet-stream";
    const encoding = /content-transfer-encoding:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim().toLowerCase() || "";

    let bytes: Buffer;
    if (encoding === "base64") {
      bytes = Buffer.from(body.replace(/\s+/g, ""), "base64");
    } else if (encoding === "quoted-printable") {
      bytes = Buffer.from(
        body
          .replace(/=\r?\n/g, "")
          .replace(/=([0-9A-F]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16))),
        "binary",
      );
    } else {
      bytes = Buffer.from(body, "binary");
    }

    const lower = filename.toLowerCase();
    const okExt =
      lower.endsWith(".pdf") ||
      lower.endsWith(".json") ||
      lower.endsWith(".txt") ||
      lower.endsWith(".csv") ||
      lower.endsWith(".png") ||
      lower.endsWith(".jpg") ||
      lower.endsWith(".jpeg");
    if (!okExt) continue;
    if (bytes.length === 0) continue;
    out.push({ filename, mimeType, bytes });
  }

  return out;
}
