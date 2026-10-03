import { mkdir, readdir, readFile, rename, stat } from "fs/promises";
import path from "path";
import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { encryptField, decryptField } from "@/lib/crypto";
import { ingestInvoice } from "@/domain/ingest";
import { ingestCsvRows } from "@/domain/csvIngest";
import { ingestFirsInvoice } from "@/domain/einvoice/firs";

const TYPE = "sftp_drop";
const ROOT = path.join(process.cwd(), "storage", "sftp-drops");

export type SftpConfig = {
  /** Local enterprise drop mirror (always available). */
  localIncoming: string;
  localProcessed: string;
  localFailed: string;
  /** Optional remote SFTP */
  host?: string;
  port?: number;
  username?: string;
  remotePath?: string;
};

export async function ensureSftpConnector(organizationId: string) {
  const base = path.join(ROOT, organizationId);
  const incoming = path.join(base, "incoming");
  const processed = path.join(base, "processed");
  const failed = path.join(base, "failed");
  await mkdir(incoming, { recursive: true });
  await mkdir(processed, { recursive: true });
  await mkdir(failed, { recursive: true });

  return prisma.integrationConnector.upsert({
    where: { organizationId_type: { organizationId, type: TYPE } },
    create: {
      organizationId,
      type: TYPE,
      name: "SFTP / drop folder",
      status: "connected",
      configJson: JSON.stringify({
        localIncoming: incoming,
        localProcessed: processed,
        localFailed: failed,
        host: process.env.SFTP_HOST || undefined,
        port: Number(process.env.SFTP_PORT || 22),
        username: process.env.SFTP_USER || undefined,
        remotePath: process.env.SFTP_REMOTE_PATH || "/incoming",
      } satisfies SftpConfig),
      secretsJson: process.env.SFTP_PASSWORD
        ? JSON.stringify({ passwordEnc: encryptField(process.env.SFTP_PASSWORD) })
        : "{}",
    },
    update: {},
  });
}

export async function saveSftpRemoteSettings(input: {
  organizationId: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  remotePath: string;
}) {
  const connector = await ensureSftpConnector(input.organizationId);
  const cfg = JSON.parse(connector.configJson) as SftpConfig;
  const secrets = JSON.parse(connector.secretsJson || "{}") as { passwordEnc?: string };
  if (input.password?.trim()) secrets.passwordEnc = encryptField(input.password.trim());

  await prisma.integrationConnector.update({
    where: { id: connector.id },
    data: {
      status: "connected",
      configJson: JSON.stringify({
        ...cfg,
        host: input.host.trim(),
        port: input.port || 22,
        username: input.username.trim(),
        remotePath: input.remotePath.trim() || "/incoming",
      }),
      secretsJson: JSON.stringify(secrets),
    },
  });
}

async function processDropFile(organizationId: string, absPath: string, filename: string) {
  const bytes = await readFile(absPath);
  const lower = filename.toLowerCase();

  if (lower.endsWith(".csv") || lower.endsWith(".tsv")) {
    return ingestCsvRows({
      organizationId,
      actorType: "system",
      text: bytes.toString("utf8"),
      sync: false,
    });
  }

  if (lower.endsWith(".json")) {
    const payload = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    if (payload.irn || payload.scheme === "firs_einvoice" || payload.supplier) {
      return ingestFirsInvoice({
        organizationId,
        payload: payload as Parameters<typeof ingestFirsInvoice>[0]["payload"],
        sync: false,
      });
    }
    const invoice = await ingestInvoice({
      organizationId,
      actorType: "system",
      source: "api",
      externalId: typeof payload.external_id === "string" ? payload.external_id : null,
      structuredPayload: (payload.document as Record<string, unknown>) || payload,
      filename,
      enqueue: true,
    });
    return { ingested: 1, invoiceIds: [invoice.id] };
  }

  const invoice = await ingestInvoice({
    organizationId,
    actorType: "system",
    source: "upload",
    filename,
    mimeType: lower.endsWith(".pdf") ? "application/pdf" : "application/octet-stream",
    bytes,
    enqueue: true,
  });
  return { ingested: 1, invoiceIds: [invoice.id] };
}

export async function processLocalSftpDrop(organizationId: string) {
  const connector = await ensureSftpConnector(organizationId);
  const cfg = JSON.parse(connector.configJson) as SftpConfig;
  const files = await readdir(cfg.localIncoming);
  let ingested = 0;
  const errors: string[] = [];

  for (const file of files) {
    if (file.startsWith(".")) continue;
    const abs = path.join(cfg.localIncoming, file);
    const st = await stat(abs);
    if (!st.isFile()) continue;
    try {
      const result = await processDropFile(organizationId, abs, file);
      const count = "ingested" in result ? Number(result.ingested || 0) : 1;
      ingested += count;
      await rename(abs, path.join(cfg.localProcessed, `${Date.now()}-${file}`));
    } catch (e) {
      errors.push(`${file}: ${e instanceof Error ? e.message : "failed"}`);
      await rename(abs, path.join(cfg.localFailed, `${Date.now()}-${file}`)).catch(() => null);
    }
  }

  await prisma.integrationConnector.update({
    where: { id: connector.id },
    data: { lastSyncAt: new Date() },
  });

  await writeAudit({
    organizationId,
    actorType: "system",
    action: "connector.sftp_processed",
    entityType: "connector",
    entityId: connector.id,
    metadata: { ingested, errors },
  });

  return { ingested, errors, incomingPath: cfg.localIncoming };
}

export async function processAllSftpDrops() {
  const connectors = await prisma.integrationConnector.findMany({
    where: { type: TYPE, status: "connected" },
  });
  const out = [];
  for (const c of connectors) {
    out.push({
      organizationId: c.organizationId,
      ...(await processLocalSftpDrop(c.organizationId)),
    });
  }
  return out;
}

export async function pullRemoteSftpIfConfigured(organizationId: string) {
  const connector = await prisma.integrationConnector.findUnique({
    where: { organizationId_type: { organizationId, type: TYPE } },
  });
  if (!connector) return { pulled: 0 };
  const cfg = JSON.parse(connector.configJson) as SftpConfig;
  const secrets = JSON.parse(connector.secretsJson || "{}") as { passwordEnc?: string };
  if (!cfg.host || !cfg.username || !secrets.passwordEnc) return { pulled: 0, skipped: true as const };

  try {
    const SftpClient = (await import("ssh2-sftp-client")).default;
    const sftp = new SftpClient();
    await sftp.connect({
      host: cfg.host,
      port: cfg.port || 22,
      username: cfg.username,
      password: decryptField(secrets.passwordEnc),
    });
    const remote = cfg.remotePath || "/incoming";
    const list = (await sftp.list(remote)).filter((f) => f.type === "-");
    let pulled = 0;
    for (const f of list) {
      const remoteFile = `${remote.replace(/\/$/, "")}/${f.name}`;
      const localFile = path.join(cfg.localIncoming, f.name);
      await sftp.fastGet(remoteFile, localFile);
      await sftp.delete(remoteFile);
      pulled += 1;
    }
    await sftp.end();
    return { pulled };
  } catch (e) {
    return { pulled: 0, error: e instanceof Error ? e.message : "sftp failed" };
  }
}
