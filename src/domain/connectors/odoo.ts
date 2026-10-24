/**
 * First-class Odoo connector: JSON-RPC session, vendor/PO/bill sync, payment write-back.
 * Odoo remains the ledger; Custara is controls and settlement.
 */
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { encryptField, decryptField } from "@/lib/crypto";
import { InvoiceConflictError } from "@/domain/ingest";
import {
  ingestErpBill,
  isOdooCreditMove,
  mapOdooAccountMove,
  odooIntentKey,
  odooLedgerWriteback,
  paymentMentionsIntent,
  toIngestDocument,
} from "@/domain/erp/adapters";
import { enqueueJob } from "@/lib/jobs";
import { runInvoicePipeline } from "@/domain/pipeline";
import { upsertVendorPurchaseOrder } from "@/domain/contracts";

export const ODOO_CONNECTOR_TYPE = "accounting_odoo";

const RPC_TIMEOUT_MS = 15_000;
const PAGE_SIZE = 200;
const HARD_CAP = 5000;
const MAX_VENDORS = HARD_CAP;
const MAX_POS = HARD_CAP;
const MAX_BILLS = HARD_CAP;
const SYNC_LOCK_MS = 2 * 60_000;
const SKIP_LINE_DISPLAY = new Set([
  "line_section",
  "line_note",
  "payment_term",
  "rounding",
  "cogs",
]);
const METADATA_HOSTS = new Set([
  "169.254.169.254",
  "169.254.170.2",
  "metadata.google.internal",
  "metadata.google.com",
  "kubernetes.default",
  "kubernetes.default.svc",
]);

type OdooSecrets = {
  database: string;
  username: string;
  apiKeyEnc: string;
  uid?: number;
};

type OdooConfig = {
  origin: string;
  database: string;
  username: string;
  companyId?: number | null;
  journalId?: number | null;
  lastError?: string | null;
  syncStartedAt?: string | null;
  syncDirection?: "two_way" | "inbound" | "outbound";
  truncated?: boolean;
  lastSyncSummary?: Record<string, unknown> | null;
  companies?: Array<{ id: number; name: string }>;
  webhookToken?: string | null;
};

type RpcFetcher = typeof fetch;

function parseIpv4(host: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/** Link-local, loopback, RFC1918, CGNAT, unique-local IPv6. */
export function isPrivateOrLocalIp(ip: string): boolean {
  const raw = ip.toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = raw.startsWith("::ffff:") ? raw.slice(7) : raw;
  const v4 = parseIpv4(mapped);
  if (v4 != null) {
    const a = v4 >>> 24;
    const b = (v4 >>> 16) & 255;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (raw === "::1" || raw === "::" || raw === "0:0:0:0:0:0:0:1") return true;
  if (raw.startsWith("fe80:") || raw.startsWith("fc") || raw.startsWith("fd")) return true;
  return false;
}

export function isMetadataHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (METADATA_HOSTS.has(h) || h.endsWith(".metadata.google.internal")) return true;
  const v4 = parseIpv4(h);
  if (v4 != null) {
    const a = v4 >>> 24;
    const b = (v4 >>> 16) & 255;
    if (a === 169 && b === 254) return true;
  }
  return false;
}

export function allowPrivateOdooHost(): boolean {
  if (process.env.ODOO_ALLOW_PRIVATE === "true") return true;
  const production = process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);
  return !production;
}

export function isBlockedOdooHost(host: string, allowPrivate = allowPrivateOdooHost()): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (isMetadataHost(h)) return true;
  if (allowPrivate) return false;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) {
    return true;
  }
  return isPrivateOrLocalIp(h);
}

export function assertOdooOrigin(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error("Odoo URL is not valid.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Odoo URL must be http or https.");
  }
  if (isBlockedOdooHost(parsed.hostname)) {
    throw new Error("Odoo URL is not allowed.");
  }
  const production = process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);
  const allowHttp = process.env.ODOO_ALLOW_HTTP === "true";
  if (production && parsed.protocol !== "https:" && !allowHttp) {
    throw new Error("Odoo URL must be HTTPS in production.");
  }
  return parsed.origin;
}

/** Reject DNS that resolves to metadata or (in production) private addresses. */
export async function assertOdooResolvedOrigin(origin: string): Promise<void> {
  const host = new URL(origin).hostname;
  if (isBlockedOdooHost(host)) {
    throw new Error("Odoo URL is not allowed.");
  }
  let records: Array<{ address: string }>;
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error("Odoo host could not be resolved.");
  }
  if (!records.length) throw new Error("Odoo host could not be resolved.");
  const allowPrivate = allowPrivateOdooHost();
  for (const rec of records) {
    if (isMetadataHost(rec.address) || (isPrivateOrLocalIp(rec.address) && !allowPrivate)) {
      throw new Error("Odoo URL is not allowed.");
    }
  }
}

function packSecrets(secrets: OdooSecrets): string {
  return JSON.stringify({
    database: secrets.database,
    username: secrets.username,
    apiKeyEnc: secrets.apiKeyEnc,
    uid: secrets.uid,
  });
}

function parseSecrets(raw: string): Partial<OdooSecrets> {
  try {
    return JSON.parse(raw || "{}") as Partial<OdooSecrets>;
  } catch {
    return {};
  }
}

function parseConfig(raw: string): Partial<OdooConfig> {
  try {
    return JSON.parse(raw || "{}") as Partial<OdooConfig>;
  } catch {
    return {};
  }
}

const CONSUMER_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "icloud.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
]);

/** `acme.odoo.com` / `acme.dev.odoo.com` → `acme`. */
export function odooDatabaseFromHost(host: string): string | null {
  const h = host.toLowerCase().replace(/\.$/, "");
  const hosted = /^([a-z0-9-]+)(?:\.[a-z0-9-]+)?\.odoo\.com$/.exec(h);
  if (hosted) return hosted[1];
  const first = h.split(".")[0] || "";
  if (first && first !== "www" && first !== "odoo") return first;
  return null;
}

export function odooOriginCandidates(input: {
  website?: string | null;
  slug?: string | null;
  email?: string | null;
  savedOrigin?: string | null;
  urlHint?: string | null;
}): string[] {
  const out: string[] = [];
  const add = (raw?: string | null) => {
    if (!raw?.trim()) return;
    const trimmed = raw.trim();
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    try {
      const origin = assertOdooOrigin(withScheme);
      if (!out.includes(origin)) out.push(origin);
    } catch {
      // skip invalid or blocked hosts
    }
  };
  add(input.urlHint);
  add(input.savedOrigin);
  add(input.website);
  if (input.slug) add(`https://${input.slug}.odoo.com`);
  const domain = input.email?.split("@")[1]?.toLowerCase();
  if (domain && !CONSUMER_EMAIL_DOMAINS.has(domain) && domain.includes(".")) {
    add(`https://${domain}`);
    add(`https://${domain.split(".")[0]}.odoo.com`);
  }
  return out.slice(0, 5);
}

export function odooDatabaseCandidates(input: {
  origin: string;
  slug?: string | null;
  savedDatabase?: string | null;
  listed?: string[];
  databaseHint?: string | null;
}): string[] {
  const out: string[] = [];
  const add = (raw?: string | null) => {
    const value = (raw || "").trim();
    if (value && !out.includes(value)) out.push(value);
  };
  add(input.databaseHint);
  add(input.savedDatabase);
  for (const name of input.listed || []) add(name);
  try {
    add(odooDatabaseFromHost(new URL(input.origin).hostname));
  } catch {
    // ignore
  }
  add(input.slug);
  return out.slice(0, 6);
}

export function isOptionalOdooModelError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /doesn'?t exist|does not exist|Access Denied|not allowed to access/i.test(message);
}

export function odooUsernameCandidates(input: {
  actorEmail?: string | null;
  savedUsername?: string | null;
  workspaceEmails?: string[];
}): string[] {
  const out: string[] = [];
  const add = (raw?: string | null) => {
    const value = (raw || "").trim().toLowerCase();
    if (value.includes("@") && !out.includes(value)) out.push(value);
  };
  add(input.actorEmail);
  add(input.savedUsername);
  for (const email of input.workspaceEmails || []) add(email);
  return out.slice(0, 8);
}

async function jsonRpc(input: {
  origin: string;
  service: "common" | "object" | "db";
  method: string;
  args: unknown[];
  fetchImpl?: RpcFetcher;
}): Promise<unknown> {
  const fetchImpl = input.fetchImpl || fetch;
  if (!input.fetchImpl) {
    await assertOdooResolvedOrigin(input.origin);
  }
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await jsonRpcOnce({ ...input, fetchImpl });
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (!/Odoo RPC HTTP (429|5\d\d)/.test(lastErr.message) || attempt === 2) throw lastErr;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw lastErr || new Error("Odoo RPC failed");
}

async function jsonRpcOnce(input: {
  origin: string;
  service: "common" | "object" | "db";
  method: string;
  args: unknown[];
  fetchImpl: RpcFetcher;
}): Promise<unknown> {
  const res = await input.fetchImpl(`${input.origin}/jsonrpc`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "Custara-OdooConnector/1.0",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "call",
      params: { service: input.service, method: input.method, args: input.args },
      id: Date.now(),
    }),
    redirect: "manual",
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (res.status >= 300 && res.status < 400) {
    throw new Error("Odoo RPC redirected; refusing to follow.");
  }
  const text = await res.text();
  let body: { result?: unknown; error?: { message?: string; data?: { message?: string } } };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new Error(`Odoo RPC returned non-JSON (${res.status}).`);
  }
  if (!res.ok) {
    throw new Error(`Odoo RPC HTTP ${res.status}.`);
  }
  if (body.error) {
    throw new Error(body.error.data?.message || body.error.message || "Odoo RPC error.");
  }
  return body.result;
}

export async function authenticateOdoo(input: {
  origin: string;
  database: string;
  username: string;
  apiKey: string;
  fetchImpl?: RpcFetcher;
}): Promise<number> {
  const uid = await jsonRpc({
    origin: input.origin,
    service: "common",
    method: "authenticate",
    args: [input.database, input.username, input.apiKey, {}],
    fetchImpl: input.fetchImpl,
  });
  const id = Number(uid);
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error("Odoo authentication failed. Check database, user, and API key.");
  }
  return id;
}

async function executeKw(input: {
  origin: string;
  database: string;
  uid: number;
  apiKey: string;
  model: string;
  method: string;
  args?: unknown[];
  kwargs?: Record<string, unknown>;
  companyId?: number | null;
  fetchImpl?: RpcFetcher;
}): Promise<unknown> {
  const kwargs = { ...(input.kwargs || {}) };
  if (input.companyId) {
    const ctx = (kwargs.context as Record<string, unknown> | undefined) || {};
    kwargs.context = { ...ctx, allowed_company_ids: [input.companyId], company_id: input.companyId };
  }
  const callArgs: unknown[] = [
    input.database,
    input.uid,
    input.apiKey,
    input.model,
    input.method,
    input.args || [],
  ];
  if (Object.keys(kwargs).length) {
    callArgs.push(kwargs);
  }
  return jsonRpc({
    origin: input.origin,
    service: "object",
    method: "execute_kw",
    args: callArgs,
    fetchImpl: input.fetchImpl,
  });
}

export async function ensureOdooConnector(organizationId: string) {
  return prisma.integrationConnector.upsert({
    where: { organizationId_type: { organizationId, type: ODOO_CONNECTOR_TYPE } },
    create: {
      organizationId,
      type: ODOO_CONNECTOR_TYPE,
      name: "Odoo",
      status: "disconnected",
      configJson: JSON.stringify({ syncDirection: "two_way" }),
      secretsJson: "{}",
    },
    update: {},
  });
}

export async function connectOdoo(input: {
  organizationId: string;
  actorId: string;
  actorEmail: string;
  apiKey?: string;
  url?: string;
  database?: string;
  username?: string;
  companyId?: number | null;
  journalId?: number | null;
  fetchImpl?: RpcFetcher;
}) {
  const existing = await ensureOdooConnector(input.organizationId);
  const prevSecrets = parseSecrets(existing.secretsJson);
  const prevConfig = parseConfig(existing.configJson);
  const apiKey = input.apiKey?.trim() || (prevSecrets.apiKeyEnc ? decryptField(prevSecrets.apiKeyEnc) : "");
  if (!apiKey) throw new Error("Odoo API key is required.");

  const org = await prisma.organization.findUnique({
    where: { id: input.organizationId },
    select: {
      website: true,
      slug: true,
      users: { select: { email: true, role: true } },
    },
  });
  const explicitUser = (input.username || "").trim().toLowerCase();
  const usernames = explicitUser
    ? [explicitUser]
    : odooUsernameCandidates({
        actorEmail: input.actorEmail,
        savedUsername: prevConfig.username,
        workspaceEmails: [
          ...(org?.users.filter((u) => u.role === "admin").map((u) => u.email) || []),
          ...(org?.users.map((u) => u.email) || []),
        ],
      });
  if (!usernames.length) throw new Error("Sign in again, then connect Odoo.");

  const origins = odooOriginCandidates({
    urlHint: input.url,
    savedOrigin: prevConfig.origin,
    website: org?.website,
    slug: org?.slug,
    email: usernames[0],
  });
  if (!origins.length) {
    throw new Error(
      "Paste the database URL from the address bar while you are on Discuss or Accounting (https://name.odoo.com).",
    );
  }

  let lastError = "Odoo authentication failed.";
  for (const origin of origins) {
    let listed: string[] = [];
    try {
      const raw = await jsonRpc({
        origin,
        service: "db",
        method: "list",
        args: [],
        fetchImpl: input.fetchImpl,
      });
      if (Array.isArray(raw)) listed = raw.map((name) => String(name));
    } catch {
      listed = [];
    }
    const databases = odooDatabaseCandidates({
      origin,
      slug: org?.slug,
      savedDatabase: prevSecrets.database || prevConfig.database,
      listed,
      databaseHint: input.database,
    });
    for (const database of databases) {
      for (const username of usernames) {
        try {
          const uid = await authenticateOdoo({
            origin,
            database,
            username,
            apiKey,
            fetchImpl: input.fetchImpl,
          });
          let companies: Array<{ id: number; name: string }> = [];
          try {
            companies = ((await executeKw({
              origin,
              database,
              uid,
              apiKey,
              model: "res.company",
              method: "search_read",
              args: [[]],
              kwargs: { fields: ["id", "name"], limit: 50 },
              fetchImpl: input.fetchImpl,
            })) as Array<{ id: number; name: string }>) || [];
          } catch {
            companies = [];
          }
          const companyId =
            input.companyId ||
            prevConfig.companyId ||
            (companies.length === 1 ? companies[0].id : null);
          const webhookToken = prevConfig.webhookToken || randomBytes(24).toString("hex");
          const connector = await prisma.integrationConnector.update({
            where: { id: existing.id },
            data: {
              status: "connected",
              name: "Odoo",
              configJson: JSON.stringify({
                origin,
                database,
                username,
                companyId,
                journalId: input.journalId ?? prevConfig.journalId ?? null,
                companies,
                lastError: null,
                syncDirection: "two_way",
                webhookToken,
              } satisfies OdooConfig),
              secretsJson: packSecrets({
                database,
                username,
                apiKeyEnc: encryptField(apiKey),
                uid,
              }),
            },
          });
          await writeAudit({
            organizationId: input.organizationId,
            actorType: "user",
            actorId: input.actorId,
            action: "connector.odoo_connected",
            entityType: "connector",
            entityId: connector.id,
            metadata: { origin, database, username },
          });
          return connector;
        } catch (err) {
          lastError = err instanceof Error ? err.message : lastError;
        }
      }
    }
  }

  throw new Error(
    lastError.includes("not allowed") ||
      lastError.includes("HTTPS") ||
      lastError.includes("resolved") ||
      lastError.includes("URL")
      ? lastError
      : "Odoo rejected the key for that database URL. Use the URL from the apps home (…odoo.com/odoo), and a key created there for this workspace email.",
  );
}

export async function disconnectOdoo(input: { organizationId: string; actorId: string }) {
  const existing = await ensureOdooConnector(input.organizationId);
  const prev = parseConfig(existing.configJson);
  const connector = await prisma.integrationConnector.update({
    where: { id: existing.id },
    data: {
      status: "disconnected",
      lastSyncAt: null,
      secretsJson: "{}",
      configJson: JSON.stringify({
        origin: prev.origin,
        database: prev.database,
        username: prev.username,
        companyId: prev.companyId,
        journalId: prev.journalId,
        lastError: null,
        syncDirection: "two_way",
      }),
    },
  });
  await writeAudit({
    organizationId: input.organizationId,
    actorType: "user",
    actorId: input.actorId,
    action: "connector.odoo_disconnected",
    entityType: "connector",
    entityId: connector.id,
    metadata: { origin: prev.origin, database: prev.database },
  });
  return connector;
}

async function session(organizationId: string, fetchImpl?: RpcFetcher) {
  const connector = await prisma.integrationConnector.findUnique({
    where: { organizationId_type: { organizationId, type: ODOO_CONNECTOR_TYPE } },
  });
  if (!connector || (connector.status !== "connected" && connector.status !== "error")) {
    throw new Error("Odoo is not connected.");
  }
  const config = parseConfig(connector.configJson);
  const secrets = parseSecrets(connector.secretsJson);
  if (!config.origin || !secrets.database || !secrets.username || !secrets.apiKeyEnc) {
    throw new Error("Odoo is not connected.");
  }
  const apiKey = decryptField(secrets.apiKeyEnc);
  const uid =
    secrets.uid ||
    (await authenticateOdoo({
      origin: config.origin,
      database: secrets.database,
      username: secrets.username,
      apiKey,
      fetchImpl,
    }));
  return {
    connector,
    origin: config.origin,
    database: secrets.database,
    uid,
    apiKey,
    companyId: config.companyId || null,
    fetchImpl,
  };
}

function many2oneId(value: unknown): number | null {
  if (value == null || value === false) return null;
  if (Array.isArray(value)) return Number(value[0]) || null;
  if (typeof value === "object" && value && "id" in value) {
    return Number((value as { id?: number }).id) || null;
  }
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function many2oneName(value: unknown): string | null {
  if (Array.isArray(value) && value[1]) return String(value[1]);
  if (typeof value === "object" && value && "name" in value) {
    return String((value as { name?: string }).name || "") || null;
  }
  return null;
}

async function searchReadPaged(
  kw: (model: string, method: string, args?: unknown[], kwargs?: Record<string, unknown>) => Promise<unknown>,
  model: string,
  domain: unknown[][],
  fields: string[],
  firstLimit: number,
): Promise<{ rows: Array<Record<string, unknown>>; truncated: boolean; total: number }> {
  let total = 0;
  try {
    total = Number(await kw(model, "search_count", [domain])) || 0;
  } catch {
    total = 0;
  }
  const cap = Math.min(HARD_CAP, Math.max(firstLimit, PAGE_SIZE));
  const rows: Array<Record<string, unknown>> = [];
  for (let offset = 0; offset < cap; offset += PAGE_SIZE) {
    const page = (await kw(model, "search_read", [domain], {
      fields,
      limit: PAGE_SIZE,
      offset,
      order: "id desc",
    })) as Array<Record<string, unknown>>;
    if (!page?.length) break;
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  const truncated = total > rows.length || rows.length >= HARD_CAP;
  return { rows, truncated, total: total || rows.length };
}

async function upsertOdooVendor(input: {
  organizationId: string;
  partnerId: number;
  name: string;
  email?: string | null;
  taxId?: string | null;
}) {
  const externalId = `odoo-partner:${input.partnerId}`;
  const existing = await prisma.vendor.findUnique({
    where: { organizationId_externalId: { organizationId: input.organizationId, externalId } },
  });
  if (existing) {
    return prisma.vendor.update({
      where: { id: existing.id },
      data: {
        name: input.name,
        email: input.email || existing.email,
        taxId: input.taxId || existing.taxId,
      },
    });
  }
  const byName = await prisma.vendor.findFirst({
    where: { organizationId: input.organizationId, name: { equals: input.name } },
  });
  if (byName && !byName.externalId) {
    return prisma.vendor.update({
      where: { id: byName.id },
      data: {
        externalId,
        email: input.email || byName.email,
        taxId: input.taxId || byName.taxId,
      },
    });
  }
  return prisma.vendor.create({
    data: {
      organizationId: input.organizationId,
      externalId,
      name: input.name,
      email: input.email || null,
      taxId: input.taxId || null,
      isNew: true,
    },
  });
}

function odooDatetime(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 19);
}

function withWriteDateSince(
  domain: unknown[][],
  lastSyncAt: Date | null,
  firstLimit: number,
): { domain: unknown[][]; limit: number } {
  if (!lastSyncAt) return { domain, limit: firstLimit };
  const since = new Date(lastSyncAt.getTime() - 24 * 60 * 60 * 1000);
  return {
    domain: [...domain, ["write_date", ">=", odooDatetime(since)]],
    limit: Math.min(firstLimit * 2, 1000),
  };
}

function lockHeld(config: Partial<OdooConfig>): boolean {
  if (!config.syncStartedAt) return false;
  const t = Date.parse(config.syncStartedAt);
  return Number.isFinite(t) && Date.now() - t < SYNC_LOCK_MS;
}

export async function syncOdooInbound(input: {
  organizationId: string;
  actorId?: string;
  fetchImpl?: RpcFetcher;
  skipIfBusy?: boolean;
  /** Ignore write_date window — used on connect and Sync now. */
  full?: boolean;
}): Promise<{
  vendors: number;
  purchaseOrders: number;
  ingested: number;
  skipped: number;
  customerInvoices?: number;
  truncated?: boolean;
}> {
  const sess = await session(input.organizationId, input.fetchImpl);
  const config = parseConfig(sess.connector.configJson);
  if (lockHeld(config)) {
    if (input.skipIfBusy) {
      return { vendors: 0, purchaseOrders: 0, ingested: 0, skipped: 0, customerInvoices: 0, truncated: false };
    }
    throw new Error("Odoo sync is already running.");
  }

  await prisma.integrationConnector.update({
    where: { id: sess.connector.id },
    data: {
      configJson: JSON.stringify({
        ...config,
        origin: sess.origin,
        database: sess.database,
        syncStartedAt: new Date().toISOString(),
      }),
    },
  });

  const kw = (model: string, method: string, args?: unknown[], kwargs?: Record<string, unknown>) =>
    executeKw({ ...sess, model, method, args, kwargs, fetchImpl: input.fetchImpl });

  let vendors = 0;
  let purchaseOrders = 0;
  let ingested = 0;
  let skipped = 0;
  let truncated = false;
  let customerInvoices = 0;
  const lastSyncAt = input.full ? null : sess.connector.lastSyncAt;
  let fiscalLock: Date | null = null;

  try {
    try {
      const companies = (await kw(
        "res.company",
        "search_read",
        sess.companyId ? [[["id", "=", sess.companyId]]] : [[]],
        { fields: ["id", "fiscalyear_lock_date", "period_lock_date"], limit: 5 },
      )) as Array<{ fiscalyear_lock_date?: string; period_lock_date?: string }>;
      const raw = companies?.[0]?.period_lock_date || companies?.[0]?.fiscalyear_lock_date;
      if (raw) fiscalLock = new Date(raw);
    } catch {
      fiscalLock = null;
    }
    const partnerQuery = withWriteDateSince([["supplier_rank", ">", 0]], lastSyncAt, MAX_VENDORS);
    let partners: Array<Record<string, unknown>> = [];
    try {
      const page = await searchReadPaged(kw, "res.partner", partnerQuery.domain, [
        "id",
        "name",
        "email",
        "vat",
        "active",
        "supplier_rank",
        "street",
        "city",
        "comment",
        "property_payment_term_id",
      ], partnerQuery.limit);
      partners = page.rows;
      truncated = truncated || page.truncated;
    } catch {
      try {
        const legacy = withWriteDateSince([["supplier", "=", true]], lastSyncAt, MAX_VENDORS);
        const page = await searchReadPaged(kw, "res.partner", legacy.domain, ["id", "name", "email", "vat"], legacy.limit);
        partners = page.rows;
        truncated = truncated || page.truncated;
      } catch {
        partners = [];
      }
    }

    for (const partner of partners || []) {
      const id = Number(partner.id);
      const name = String(partner.name || "");
      if (!id || !name) continue;
      if (partner.active === false) {
        const archived = await prisma.vendor.findUnique({
          where: {
            organizationId_externalId: {
              organizationId: input.organizationId,
              externalId: `odoo-partner:${id}`,
            },
          },
          select: { id: true },
        });
        if (archived) {
          await prisma.vendorPaymentEndpoint.updateMany({
            where: { vendorId: archived.id, isActive: true },
            data: { isActive: false },
          });
        }
        continue;
      }
      const vendor = await upsertOdooVendor({
        organizationId: input.organizationId,
        partnerId: id,
        name,
        email: partner.email ? String(partner.email) : null,
        taxId: partner.vat ? String(partner.vat) : null,
      });
      const term = many2oneName(partner.property_payment_term_id);
      const address = [partner.street, partner.city].filter(Boolean).join(", ") || null;
      await prisma.vendor.update({
        where: { id: vendor.id },
        data: {
          paymentTerm: term || vendor.paymentTerm,
          address: address || vendor.address,
          notes: partner.comment ? String(partner.comment) : vendor.notes,
        },
      });
      vendors += 1;
    }

    const partnerIds = partners.map((p) => Number(p.id)).filter((id) => id > 0);
    if (partnerIds.length) {
      try {
        const banks = (await kw(
          "res.partner.bank",
          "search_read",
          [[["partner_id", "in", partnerIds]]],
          {
            fields: ["id", "partner_id", "sanitized_acc_number", "proxy_value", "bank_id", "acc_holder_name"],
            limit: Math.min(partnerIds.length * 5, HARD_CAP),
          },
        )) as Array<Record<string, unknown>>;
        for (const bank of banks || []) {
          const partnerId = many2oneId(bank.partner_id);
          const acc = String(bank.sanitized_acc_number || bank.proxy_value || "").trim();
          if (!partnerId || !acc || /^0x[a-fA-F0-9]{40}$/i.test(acc)) continue;
          const vendor = await prisma.vendor.findUnique({
            where: {
              organizationId_externalId: {
                organizationId: input.organizationId,
                externalId: `odoo-partner:${partnerId}`,
              },
            },
          });
          if (!vendor) continue;
          const last4 = acc.slice(-4);
          const existing = await prisma.vendorPaymentEndpoint.findFirst({
            where: { vendorId: vendor.id, endpointType: "bank", isActive: true },
          });
          if (existing?.accountNumberLast4 === last4) continue;
          if (existing) {
            await prisma.vendorPaymentEndpoint.update({ where: { id: existing.id }, data: { isActive: false } });
          }
          await prisma.vendorPaymentEndpoint.create({
            data: {
              vendorId: vendor.id,
              endpointType: "bank",
              version: (existing?.version || 0) + 1,
              accountName: String(bank.acc_holder_name || vendor.name),
              accountNumberEncrypted: encryptField(acc),
              accountNumberLast4: last4,
              bankName: many2oneName(bank.bank_id),
              currency: "NGN",
              isActive: true,
            },
          });
        }
      } catch {
        // Invoicing-only databases may omit partner banks.
      }
      try {
        const prices = (await kw(
          "product.supplierinfo",
          "search_read",
          [[["partner_id", "in", partnerIds]]],
          { fields: ["partner_id", "product_id", "product_name", "price", "currency_id"], limit: HARD_CAP },
        )) as Array<Record<string, unknown>>;
        for (const row of prices || []) {
          const partnerId = many2oneId(row.partner_id);
          const product = many2oneName(row.product_id) || String(row.product_name || "").trim();
          const price = Number(row.price || 0);
          if (!partnerId || !product || price <= 0) continue;
          const vendor = await prisma.vendor.findUnique({
            where: {
              organizationId_externalId: {
                organizationId: input.organizationId,
                externalId: `odoo-partner:${partnerId}`,
              },
            },
          });
          if (!vendor) continue;
          await prisma.vendorSupplierPrice.upsert({
            where: { vendorId_product: { vendorId: vendor.id, product } },
            create: {
              vendorId: vendor.id,
              product,
              maxUnitPrice: price,
              currency: many2oneName(row.currency_id) || "NGN",
            },
            update: { maxUnitPrice: price, currency: many2oneName(row.currency_id) || "NGN" },
          });
        }
      } catch (err) {
        if (!isOptionalOdooModelError(err)) throw err;
      }
    }

    try {
      const orderQuery = withWriteDateSince(
        [["state", "in", ["purchase", "done"]]],
        lastSyncAt,
        MAX_POS,
      );
      const orderPage = await searchReadPaged(
        kw,
        "purchase.order",
        orderQuery.domain,
        ["id", "name", "partner_id", "amount_total", "currency_id", "state"],
        orderQuery.limit,
      );
      truncated = truncated || orderPage.truncated;
      const orders = orderPage.rows;
      const poIds = orders.map((po) => Number(po.id)).filter((id) => id > 0);
      const qtyByPo = new Map<number, { ordered: number; received: number }>();
      if (poIds.length) {
        try {
          const poLines = (await kw(
            "purchase.order.line",
            "search_read",
            [[["order_id", "in", poIds]]],
            { fields: ["order_id", "product_qty", "qty_received"], limit: Math.min(poIds.length * 20, HARD_CAP) },
          )) as Array<{ order_id?: unknown; product_qty?: number; qty_received?: number }>;
          for (const line of poLines || []) {
            const orderId = many2oneId(line.order_id);
            if (!orderId) continue;
            const cur = qtyByPo.get(orderId) || { ordered: 0, received: 0 };
            cur.ordered += Number(line.product_qty || 0);
            cur.received += Number(line.qty_received || 0);
            qtyByPo.set(orderId, cur);
          }
        } catch (err) {
          if (!isOptionalOdooModelError(err)) throw err;
        }
      }

      for (const po of orders || []) {
        const partnerId = many2oneId(po.partner_id);
        const poNumber = String(po.name || "").trim();
        if (!partnerId || !poNumber) continue;
        const vendor = await upsertOdooVendor({
          organizationId: input.organizationId,
          partnerId,
          name: many2oneName(po.partner_id) || `Odoo partner ${partnerId}`,
        });
        const qty = qtyByPo.get(Number(po.id));
        await upsertVendorPurchaseOrder({
          organizationId: input.organizationId,
          actorId: input.actorId || "odoo-sync",
          vendorId: vendor.id,
          poNumber,
          amount: Number(po.amount_total) || null,
          currency: many2oneName(po.currency_id) || "NGN",
          label: `Odoo ${poNumber}`,
          orderedQty: qty?.ordered ?? null,
          receivedQty: qty?.received ?? null,
        });
        purchaseOrders += 1;
      }
    } catch (err) {
      if (!isOptionalOdooModelError(err)) throw err;
    }

    try {
      customerInvoices =
        Number(
          await kw("account.move", "search_count", [
            [
              ["move_type", "=", "out_invoice"],
              ["state", "in", ["draft", "posted"]],
            ],
          ]),
        ) || 0;
    } catch {
      customerInvoices = 0;
    }

    const billQuery = withWriteDateSince(
      [
        ["move_type", "in", ["in_invoice", "in_refund"]],
        ["state", "in", ["draft", "posted"]],
      ],
      lastSyncAt,
      MAX_BILLS,
    );
    const movePage = await searchReadPaged(
      kw,
      "account.move",
      billQuery.domain,
      [
        "id",
        "name",
        "partner_id",
        "amount_total",
        "amount_untaxed",
        "amount_tax",
        "amount_residual",
        "currency_id",
        "invoice_date_due",
        "invoice_date",
        "invoice_origin",
        "ref",
        "payment_reference",
        "narration",
        "partner_bank_id",
        "move_type",
        "state",
        "payment_state",
        "invoice_payment_term_id",
      ],
      billQuery.limit,
    );
    truncated = truncated || movePage.truncated;
    const moves = movePage.rows;

    const bankById = new Map<number, { acc_number?: string; bank_name?: string }>();
    const bankIds = (moves || [])
      .map((m) => many2oneId(m.partner_bank_id))
      .filter((id): id is number => id != null);
    if (bankIds.length) {
      try {
        const banks = (await kw(
          "res.partner.bank",
          "search_read",
          [[["id", "in", bankIds]]],
          {
            fields: ["id", "sanitized_acc_number", "proxy_value", "bank_id", "acc_holder_name"],
            limit: bankIds.length,
          },
        )) as Array<{
          id: number;
          sanitized_acc_number?: string;
          proxy_value?: string;
          bank_id?: unknown;
        }>;
        for (const bank of banks || []) {
          bankById.set(bank.id, {
            acc_number: bank.sanitized_acc_number || bank.proxy_value,
            bank_name: many2oneName(bank.bank_id) || undefined,
          });
        }
      } catch {
        // Invoicing-only databases may omit bank account fields.
      }
    }

    const moveIds = (moves || []).map((m) => Number(m.id)).filter((id) => Number.isFinite(id) && id > 0);
    const lineByMove = new Map<number, Array<Record<string, unknown>>>();
    if (moveIds.length) {
      const lines = (await kw(
        "account.move.line",
        "search_read",
        [[["move_id", "in", moveIds]]],
        {
          fields: [
            "move_id",
            "name",
            "quantity",
            "price_unit",
            "price_subtotal",
            "display_type",
            "account_id",
            "product_id",
            "analytic_distribution",
          ],
          limit: Math.min(moveIds.length * 20, HARD_CAP),
        },
      )) as Array<Record<string, unknown>>;
      for (const line of lines || []) {
        const display = line.display_type ? String(line.display_type) : "";
        if (display && SKIP_LINE_DISPLAY.has(display)) continue;
        const moveId = many2oneId(line.move_id);
        if (!moveId) continue;
        const list = lineByMove.get(moveId) || [];
        list.push(line);
        lineByMove.set(moveId, list);
      }
      await nameOdooAnalytics(kw, [...lineByMove.values()].flat());
    }

    for (const move of moves || []) {
      const id = Number(move.id);
      const bank = bankById.get(many2oneId(move.partner_bank_id) || 0);
      const withLines = {
        ...move,
        invoice_line_ids: lineByMove.get(id) || [],
        acc_number: bank?.acc_number,
        bank_name: bank?.bank_name || many2oneName(move.partner_bank_id) || undefined,
      };
      const bill = mapOdooAccountMove(withLines);
      if (bill.vendorExternalId) {
        const partnerId = Number(String(bill.vendorExternalId).replace("odoo-partner:", ""));
        if (Number.isFinite(partnerId) && bill.vendorName) {
          await upsertOdooVendor({
            organizationId: input.organizationId,
            partnerId,
            name: bill.vendorName,
          });
        }
      }
      try {
        const invoice = await ingestErpBill({
          organizationId: input.organizationId,
          system: "odoo",
          bill,
          sync: true,
          actorType: "system",
          actorId: input.actorId || "odoo-sync",
        });
        await attachOdooPdf(kw, invoice.id, id);
        await applyOdooLedgerState(invoice.id, bill);
        await markFiscalLock(invoice.id, fiscalLock);
        await syncOdooInstallments(kw, invoice.id, move);
        ingested += 1;
      } catch (err) {
        if (err instanceof InvoiceConflictError) {
          const existing = await prisma.invoice.findUnique({
            where: { id: err.invoiceId },
            select: { status: true },
          });
          const open =
            existing &&
            !["payment_sent", "payment_queued", "reconciled", "settled", "void"].includes(existing.status);
          if (existing && open) {
            const payload = Buffer.from(JSON.stringify(toIngestDocument("odoo", bill), null, 2), "utf8");
            const doc = await prisma.invoiceDocument.findFirst({
              where: { invoiceId: err.invoiceId, filename: "invoice.json", deletedAt: null },
            });
            if (doc) {
              await prisma.invoiceDocument.update({
                where: { id: doc.id },
                data: { content: payload, byteSize: payload.length },
              });
            }
            await runInvoicePipeline(err.invoiceId, {
              type: "system",
              id: input.actorId || "odoo-sync",
            });
            await attachOdooPdf(kw, err.invoiceId, id);
            await applyOdooLedgerState(err.invoiceId, bill);
            await markFiscalLock(err.invoiceId, fiscalLock);
            await syncOdooInstallments(kw, err.invoiceId, move);
            ingested += 1;
            continue;
          }
          skipped += 1;
          continue;
        }
        throw err;
      }
    }

    await prisma.integrationConnector.update({
      where: { id: sess.connector.id },
      data: {
        lastSyncAt: new Date(),
        status: "connected",
        configJson: JSON.stringify({
          ...parseConfig(sess.connector.configJson),
          origin: sess.origin,
          database: sess.database,
          lastError: truncated ? "Sync hit the record cap. Some older Odoo rows were not pulled." : null,
          syncStartedAt: null,
          truncated,
          webhookToken: parseConfig(sess.connector.configJson).webhookToken || randomBytes(24).toString("hex"),
          lastSyncSummary: { vendors, purchaseOrders, ingested, skipped, customerInvoices, truncated },
        }),
      },
    });

    await writeAudit({
      organizationId: input.organizationId,
      actorType: "system",
      actorId: input.actorId,
      action: "connector.odoo_synced",
      entityType: "connector",
      entityId: sess.connector.id,
      metadata: { vendors, purchaseOrders, ingested, skipped, customerInvoices, truncated },
    });

    return { vendors, purchaseOrders, ingested, skipped, customerInvoices, truncated };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Odoo sync failed";
    await prisma.integrationConnector.update({
      where: { id: sess.connector.id },
      data: {
        status: "error",
        configJson: JSON.stringify({
          ...parseConfig(sess.connector.configJson),
          origin: sess.origin,
          database: sess.database,
          lastError: message.slice(0, 240),
          syncStartedAt: null,
        }),
      },
    });
    throw err instanceof Error ? err : new Error(message);
  }
}

export async function syncAllOdooConnectors() {
  const connectors = await prisma.integrationConnector.findMany({
    where: { type: ODOO_CONNECTOR_TYPE, status: { in: ["connected", "error"] } },
    select: { organizationId: true },
  });
  const results: Array<{ organizationId: string; ok: boolean; error?: string }> = [];
  for (const c of connectors) {
    try {
      await syncOdooInbound({ organizationId: c.organizationId, skipIfBusy: true });
      results.push({ organizationId: c.organizationId, ok: true });
    } catch (err) {
      results.push({
        organizationId: c.organizationId,
        ok: false,
        error: err instanceof Error ? err.message : "sync failed",
      });
    }
  }
  return results;
}

export async function enqueueOdooSyncByWebhookToken(token: string) {
  const trimmed = token.trim();
  if (!trimmed) return false;
  const connectors = await prisma.integrationConnector.findMany({
    where: { type: ODOO_CONNECTOR_TYPE, status: { in: ["connected", "error"] } },
    select: { organizationId: true, configJson: true },
  });
  const match = connectors.find((c) => parseConfig(c.configJson).webhookToken === trimmed);
  if (!match) return false;
  await enqueueJob({
    queue: "accounting-sync",
    name: "sync_odoo_org",
    payload: { organizationId: match.organizationId },
    organizationId: match.organizationId,
    maxAttempts: 2,
  });
  return true;
}

async function nameOdooAnalytics(
  kw: (model: string, method: string, args?: unknown[], kwargs?: Record<string, unknown>) => Promise<unknown>,
  lines: Array<Record<string, unknown>>,
) {
  const ids = new Set<number>();
  for (const line of lines) {
    const dist = line.analytic_distribution;
    if (dist && typeof dist === "object") {
      for (const key of Object.keys(dist as object)) {
        const id = Number(key);
        if (id > 0) ids.add(id);
      }
    }
  }
  if (!ids.size) return;
  try {
    const accounts = (await kw(
      "account.analytic.account",
      "search_read",
      [[["id", "in", [...ids]]]],
      { fields: ["id", "name"], limit: ids.size },
    )) as Array<{ id: number; name?: string }>;
    const names = new Map(accounts.map((a) => [a.id, a.name || String(a.id)]));
    for (const line of lines) {
      const dist = line.analytic_distribution;
      if (!dist || typeof dist !== "object") continue;
      const labeled = Object.entries(dist as Record<string, number>)
        .map(([id, pct]) => `${names.get(Number(id)) || id} ${pct}%`)
        .join(", ");
      line.analytic_distribution = labeled;
    }
  } catch {
    /* analytic app optional */
  }
}

async function syncOdooInstallments(
  kw: (model: string, method: string, args?: unknown[], kwargs?: Record<string, unknown>) => Promise<unknown>,
  invoiceId: string,
  move: Record<string, unknown>,
) {
  const termId = many2oneId(move.invoice_payment_term_id);
  const total = Number(move.amount_total || move.amount_residual || 0);
  const invoiceDate = String(move.invoice_date || "").slice(0, 10);
  if (!termId || total <= 0) return;
  try {
    const lines = (await kw(
      "account.payment.term.line",
      "search_read",
      [[["payment_id", "=", termId]]],
      { fields: ["nb_days", "value", "value_amount", "delay_type"], limit: 12 },
    )) as Array<{ nb_days?: number; value?: string; value_amount?: number }>;
    if (!lines?.length) return;
    await prisma.invoiceInstallment.deleteMany({ where: { invoiceId } });
    const start = invoiceDate ? new Date(invoiceDate) : new Date();
    let remaining = total;
    for (const [i, line] of lines.entries()) {
      const days = Number(line.nb_days || 0);
      const due = new Date(start.getTime() + days * 86_400_000);
      const isPercent = String(line.value || "").includes("percent");
      const amount =
        i === lines.length - 1
          ? remaining
          : isPercent
            ? (total * Number(line.value_amount || 0)) / 100
            : Number(line.value_amount || 0) || remaining;
      remaining = Math.max(0, remaining - amount);
      await prisma.invoiceInstallment.create({
        data: {
          invoiceId,
          sequence: i + 1,
          dueDate: due,
          amount,
          label: `${days} days`,
        },
      });
    }
  } catch {
    /* payment term lines optional */
  }
}

async function markFiscalLock(invoiceId: string, lock: Date | null) {
  if (!lock) return;
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: { issueDate: true },
  });
  const issue = invoice?.issueDate;
  if (!issue) return;
  await prisma.invoice.update({
    where: { id: invoiceId },
    data: { fiscalPeriodLocked: issue <= lock },
  });
}

async function attachOdooPdf(
  kw: (model: string, method: string, args?: unknown[], kwargs?: Record<string, unknown>) => Promise<unknown>,
  invoiceId: string,
  moveId: number,
) {
  const existing = await prisma.invoiceDocument.findFirst({
    where: { invoiceId, mimeType: "application/pdf", deletedAt: null },
    select: { id: true },
  });
  if (existing) return;
  try {
    const atts = (await kw(
      "ir.attachment",
      "search_read",
      [[["res_model", "=", "account.move"], ["res_id", "=", moveId], ["mimetype", "=", "application/pdf"]]],
      { fields: ["id", "name", "mimetype", "datas"], limit: 1 },
    )) as Array<{ id: number; name?: string; datas?: string }>;
    const att = atts?.[0];
    if (!att?.datas) return;
    const bytes = Buffer.from(String(att.datas), "base64");
    if (!bytes.length) return;
    await prisma.invoiceDocument.create({
      data: {
        invoiceId,
        filename: att.name || `odoo-${moveId}.pdf`,
        mimeType: "application/pdf",
        storagePath: `odoo/${invoiceId}/${att.id}.pdf`,
        content: bytes,
        byteSize: bytes.length,
      },
    });
  } catch {
    // Some databases hide ir.attachment.datas from the API key.
  }
}

async function applyOdooLedgerState(
  invoiceId: string,
  bill: {
    paymentState?: string | null;
    residual?: number | null;
    moveType?: string | null;
    odooState?: string | null;
    paymentTerm?: string | null;
  },
) {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: { status: true, issueDate: true },
  });
  if (!invoice) return;
  const paidInOdoo =
    bill.paymentState === "paid" || (bill.residual != null && bill.residual <= 0.01 && bill.odooState === "posted");
  const data: {
    residualAmount?: number;
    paymentTerm?: string | null;
    status?: string;
    explanation?: string;
    fiscalPeriodLocked?: boolean;
  } = {};
  if (bill.residual != null && Number.isFinite(bill.residual)) data.residualAmount = bill.residual;
  if (bill.paymentTerm) data.paymentTerm = bill.paymentTerm;
  if (
    paidInOdoo &&
    !isOdooCreditMove(bill.moveType) &&
    ["received", "extracting", "needs_review", "pending_approval", "approved"].includes(invoice.status)
  ) {
    data.status = "reconciled";
    data.explanation = "Already paid in Odoo — Custara will not pay again.";
  }
  if (Object.keys(data).length) {
    await prisma.invoice.update({ where: { id: invoiceId }, data });
  }
}

type OdooMovePayment = {
  id: number;
  payment_state?: string;
  amount_residual?: number;
  amount_total?: number;
  partner_id?: unknown;
  invoice_outstanding_credits_debits_widget?: unknown;
};

function parseOutstandingLineIds(widget: unknown): number[] {
  if (!widget || widget === false) return [];
  let data: { content?: Array<{ id?: number }> } | null = null;
  if (typeof widget === "string") {
    try {
      data = JSON.parse(widget) as { content?: Array<{ id?: number }> };
    } catch {
      return [];
    }
  } else if (typeof widget === "object") {
    data = widget as { content?: Array<{ id?: number }> };
  }
  return (data?.content || []).map((row) => Number(row.id)).filter((id) => Number.isFinite(id) && id > 0);
}

async function readOdooMovePayment(
  kw: (model: string, method: string, args?: unknown[], kwargs?: Record<string, unknown>) => Promise<unknown>,
  moveId: number,
): Promise<OdooMovePayment | null> {
  try {
    const rows = (await kw(
      "account.move",
      "search_read",
      [[["id", "=", moveId]]],
      {
        fields: [
          "id",
          "payment_state",
          "amount_residual",
          "amount_total",
          "partner_id",
          "invoice_outstanding_credits_debits_widget",
        ],
        limit: 1,
      },
    )) as OdooMovePayment[];
    return rows?.[0] || null;
  } catch {
    const rows = (await kw(
      "account.move",
      "search_read",
      [[["id", "=", moveId]]],
      { fields: ["id", "payment_state", "amount_residual", "amount_total", "partner_id"], limit: 1 },
    )) as OdooMovePayment[];
    return rows?.[0] || null;
  }
}

async function postOdooPayments(
  kw: (model: string, method: string, args?: unknown[], kwargs?: Record<string, unknown>) => Promise<unknown>,
  paymentIds: number[],
) {
  for (const id of paymentIds) {
    for (const method of ["action_post", "action_validate"]) {
      try {
        await kw("account.payment", method, [[id]]);
      } catch {
        // Draft vs already-posted; next method or reconcile still runs.
      }
    }
  }
}

async function postLedgerForOdooPayment(
  kw: (model: string, method: string, args?: unknown[], kwargs?: Record<string, unknown>) => Promise<unknown>,
  input: {
    billMoveId: number;
    partnerId: number;
    amount: number;
    communication: string;
    journalId: number;
    payableAccountId: number;
    bankAccountId: number;
  },
) {
  const moveId = Number(
    await kw("account.move", "create", [
      {
        move_type: "entry",
        journal_id: input.journalId,
        date: new Date().toISOString().slice(0, 10),
        ref: input.communication.slice(0, 120),
        line_ids: [
          [
            0,
            0,
            {
              account_id: input.payableAccountId,
              partner_id: input.partnerId,
              name: input.communication.slice(0, 120),
              debit: input.amount,
              credit: 0,
            },
          ],
          [
            0,
            0,
            {
              account_id: input.bankAccountId,
              partner_id: input.partnerId,
              name: input.communication.slice(0, 120),
              debit: 0,
              credit: input.amount,
            },
          ],
        ],
      },
    ]),
  );
  if (!Number.isFinite(moveId) || moveId <= 0) return null;
  try {
    await kw("account.move", "action_post", [[moveId]]);
  } catch {
    try {
      await kw("account.move", "write", [[moveId], { state: "posted" }]);
    } catch {
      return moveId;
    }
  }
  return moveId;
}

async function reconcileOdooBillLines(
  kw: (model: string, method: string, args?: unknown[], kwargs?: Record<string, unknown>) => Promise<unknown>,
  partnerId: number,
  billMoveId: number,
) {
  let lines: Array<{
    id: number;
    move_id?: unknown;
    account_type?: string;
    reconciled?: boolean;
    amount_residual?: number;
  }> = [];
  try {
    lines = (await kw(
      "account.move.line",
      "search_read",
      [[["partner_id", "=", partnerId], ["parent_state", "=", "posted"], ["account_type", "=", "liability_payable"]]],
      { fields: ["id", "move_id", "account_type", "reconciled", "amount_residual"], limit: 40 },
    )) as typeof lines;
  } catch {
    return;
  }
  const open = lines.filter((l) => !l.reconciled && Number(l.amount_residual) !== 0);
  const billIds = open
    .filter((l) => {
      const move = Array.isArray(l.move_id) ? l.move_id[0] : l.move_id;
      return move === billMoveId;
    })
    .map((l) => l.id);
  const otherIds = open.filter((l) => !billIds.includes(l.id)).map((l) => l.id);
  if (billIds[0] && otherIds[0]) {
    try {
      await kw("account.move.line", "reconcile", [[billIds[0], otherIds[0]]]);
    } catch {
      // Outstanding-account journals stay In Payment until bank rec.
    }
  }
}

async function assignOdooOutstanding(
  kw: (model: string, method: string, args?: unknown[], kwargs?: Record<string, unknown>) => Promise<unknown>,
  move: OdooMovePayment,
) {
  for (const lineId of parseOutstandingLineIds(move.invoice_outstanding_credits_debits_widget)) {
    try {
      await kw("account.move", "js_assign_outstanding_line", [[move.id], lineId]);
    } catch {
      // Invoicing-only databases may omit this method.
    }
  }
}

/** After Custara settlement, register payment on the Odoo vendor bill. Never throws to the payer. */
export async function writeOdooPaymentBack(input: {
  organizationId: string;
  invoiceId: string;
  paymentIntentId: string;
  amount: number;
  currency: string;
  fetchImpl?: RpcFetcher;
}): Promise<{ wrote: boolean; reason?: string; paymentState?: string; residual?: number }> {
  const connector = await prisma.integrationConnector.findUnique({
    where: { organizationId_type: { organizationId: input.organizationId, type: ODOO_CONNECTOR_TYPE } },
  });
  if (!connector || (connector.status !== "connected" && connector.status !== "error")) {
    return { wrote: false, reason: "odoo_not_connected" };
  }

  const invoice = await prisma.invoice.findFirst({
    where: { id: input.invoiceId, organizationId: input.organizationId },
    select: { externalId: true, invoiceNumber: true, totalAmount: true, currency: true },
  });
  const moveIdRaw = invoice?.externalId?.startsWith("odoo:")
    ? Number(invoice.externalId.slice(5))
    : NaN;
  if (!Number.isFinite(moveIdRaw) || moveIdRaw <= 0) {
    return { wrote: false, reason: "not_odoo_invoice" };
  }

  try {
    const sess = await session(input.organizationId, input.fetchImpl);
    const kw = (model: string, method: string, args?: unknown[], kwargs?: Record<string, unknown>) =>
      executeKw({ ...sess, model, method, args, kwargs, fetchImpl: input.fetchImpl });

    const before = await readOdooMovePayment(kw, moveIdRaw);
    const residual = Number(before?.amount_residual);
    const paymentState = String(before?.payment_state || "");
    if (before && Number.isFinite(residual) && residual <= 0.01 && paymentState === "paid") {
      return { wrote: false, reason: "already_paid", paymentState, residual };
    }

    const intent = await prisma.paymentIntent.findFirst({
      where: { id: input.paymentIntentId, organizationId: input.organizationId },
      select: { amount: true, currency: true, txHash: true },
    });
    const ledger = odooLedgerWriteback({
      ledgerAmount:
        Number.isFinite(residual) && residual > 0.01
          ? residual
          : invoice?.totalAmount || input.amount,
      ledgerCurrency: invoice?.currency || input.currency,
      settledAmount: intent?.amount ?? input.amount,
      settledCurrency: intent?.currency || input.currency,
      txHash: intent?.txHash,
      paymentIntentId: input.paymentIntentId,
    });

    let wrotePayment = false;
    let existingPays: Array<{
      id: number;
      amount?: number;
      move_id?: unknown;
      memo?: string;
      communication?: string;
      ref?: string;
    }> = [];
    const intentKey = odooIntentKey(input.paymentIntentId);
    try {
      existingPays = (await kw(
        "account.payment",
        "search_read",
        [[["state", "!=", "canceled"], "|", ["memo", "ilike", intentKey], ["communication", "ilike", intentKey]]],
        { fields: ["id", "amount", "move_id", "state", "memo", "communication", "ref"], limit: 20 },
      )) as typeof existingPays;
    } catch {
      try {
        existingPays = (await kw(
          "account.payment",
          "search_read",
          [[]],
          { fields: ["id", "amount", "move_id", "state", "memo", "communication", "ref"], limit: 40 },
        )) as typeof existingPays;
        existingPays = existingPays.filter((p) => paymentMentionsIntent(p, input.paymentIntentId));
      } catch {
        existingPays = [];
      }
    }
    const residualCovered = existingPays.length > 0;
    if ((!before || !Number.isFinite(residual) || residual > 0.01) && !residualCovered) {
      const mappedJournal = parseConfig(sess.connector.configJson).journalId;
      let journals = mappedJournal
        ? ((await kw(
            "account.journal",
            "search_read",
            [[["id", "=", mappedJournal]]],
            { fields: ["id", "name", "type"], limit: 1 },
          )) as Array<{ id: number }>)
        : [];
      if (!journals?.[0]?.id) {
        journals = (await kw(
          "account.journal",
          "search_read",
          [[["type", "=", "bank"]]],
          { fields: ["id", "name", "type"], limit: 1 },
        )) as Array<{ id: number }>;
      }
      if (!journals?.[0]?.id) {
        journals = (await kw(
          "account.journal",
          "search_read",
          [[["type", "=", "cash"]]],
          { fields: ["id", "name", "type"], limit: 1 },
        )) as Array<{ id: number }>;
      }
      const journalId = journals?.[0]?.id;
      if (!journalId) {
        await writeAudit({
          organizationId: input.organizationId,
          actorType: "system",
          action: "connector.odoo_writeback_skipped",
          entityType: "payment_intent",
          entityId: input.paymentIntentId,
          metadata: { reason: "no_bank_journal", moveId: moveIdRaw },
        });
        return { wrote: false, reason: "no_bank_journal" };
      }

      const ctx = {
        context: { active_model: "account.move", active_ids: [moveIdRaw], active_id: moveIdRaw },
      };
      let defaults: Record<string, unknown> = {};
      try {
        defaults = (await kw(
          "account.payment.register",
          "default_get",
          [["payment_date", "journal_id", "amount", "line_ids", "communication", "currency_id", "payment_type"]],
          ctx,
        )) as Record<string, unknown>;
      } catch {
        defaults = {};
      }
      let currencyId = defaults.currency_id;
      if (!currencyId && ledger.currency) {
        try {
          const curs = (await kw(
            "res.currency",
            "search_read",
            [[["name", "=", ledger.currency]]],
            { fields: ["id", "name"], limit: 1 },
          )) as Array<{ id: number }>;
          currencyId = curs?.[0]?.id;
        } catch {
          currencyId = undefined;
        }
      }
      const wizardId = await kw(
        "account.payment.register",
        "create",
        [
          {
            ...defaults,
            payment_date: new Date().toISOString().slice(0, 10),
            journal_id: journalId,
            amount: ledger.amount,
            communication: ledger.communication,
            ...(currencyId ? { currency_id: currencyId } : {}),
          },
        ],
        ctx,
      );
      const id = Number(wizardId);
      if (Number.isFinite(id) && id > 0) {
        await kw("account.payment.register", "action_create_payments", [[id]]);
        wrotePayment = true;
      }
    }

    const partnerId = Array.isArray(before?.partner_id)
      ? Number(before.partner_id[0])
      : Number(before?.partner_id);
    try {
      const pays = existingPays.length
        ? existingPays
        : (((await kw(
            "account.payment",
            "search_read",
            [[["memo", "ilike", intentKey]]],
            { fields: ["id", "move_id", "amount", "state"], limit: 10 },
          )) as Array<{ id: number; move_id?: unknown }>) || []);
      await postOdooPayments(
        kw,
        pays.filter((p) => !p.move_id || p.move_id === false).map((p) => p.id),
      );
    } catch {
      // Payment post is best-effort; reconcile still runs.
    }
    const mid = await readOdooMovePayment(kw, moveIdRaw);
    if (mid) await assignOdooOutstanding(kw, mid);
    if (partnerId) await reconcileOdooBillLines(kw, partnerId, moveIdRaw);

    const stillOpen = await readOdooMovePayment(kw, moveIdRaw);
    const stillResidual = Number(stillOpen?.amount_residual);
    if (partnerId && Number.isFinite(stillResidual) && stillResidual > 0.01) {
      try {
        const mappedJournal = parseConfig(sess.connector.configJson).journalId;
        const journals = (await kw(
          "account.journal",
          "search_read",
          mappedJournal ? [[["id", "=", mappedJournal]]] : [[["type", "=", "bank"]]],
          { fields: ["id", "default_account_id"], limit: 1 },
        )) as Array<{ id: number; default_account_id?: unknown }>;
        const journalId = journals?.[0]?.id;
        const bankAccountId = Array.isArray(journals?.[0]?.default_account_id)
          ? Number(journals[0].default_account_id[0])
          : Number(journals?.[0]?.default_account_id);
        const payableLines = (await kw(
          "account.move.line",
          "search_read",
          [[["move_id", "=", moveIdRaw], ["account_type", "=", "liability_payable"]]],
          { fields: ["id", "account_id"], limit: 1 },
        )) as Array<{ account_id?: unknown }>;
        const payableAccountId = Array.isArray(payableLines?.[0]?.account_id)
          ? Number(payableLines[0].account_id[0])
          : Number(payableLines?.[0]?.account_id);
        if (journalId && bankAccountId && payableAccountId) {
          await postLedgerForOdooPayment(kw, {
            billMoveId: moveIdRaw,
            partnerId,
            amount: stillResidual,
            communication: ledger.communication,
            journalId,
            payableAccountId,
            bankAccountId,
          });
          await reconcileOdooBillLines(kw, partnerId, moveIdRaw);
        }
      } catch {
        // Odoo 18 may keep In Payment until a bank statement is matched.
      }
    }

    const after = (await readOdooMovePayment(kw, moveIdRaw)) || stillOpen || mid || before;

    try {
      await kw("account.move", "message_post", [[moveIdRaw]], {
        body: `Paid ${ledger.amount} ${ledger.currency} in Custara (${intent?.amount ?? input.amount} ${intent?.currency || input.currency} Arc testnet). ${intent?.txHash || ""} ${intentKey}`.trim(),
      });
    } catch {
      /* chatter optional */
    }
    try {
      await kw("ir.attachment", "create", [
        {
          name: `custara-remittance-${input.paymentIntentId}.txt`,
          res_model: "account.move",
          res_id: moveIdRaw,
          type: "binary",
          datas: Buffer.from(ledger.communication, "utf8").toString("base64"),
          mimetype: "text/plain",
        },
      ]);
    } catch {
      /* remittance attach optional */
    }

    await writeAudit({
      organizationId: input.organizationId,
      actorType: "system",
      action: "connector.odoo_payment_written",
      entityType: "payment_intent",
      entityId: input.paymentIntentId,
      metadata: {
        moveId: moveIdRaw,
        invoiceNumber: invoice?.invoiceNumber,
        currency: ledger.currency,
        amount: ledger.amount,
        settledAmount: intent?.amount ?? input.amount,
        settledCurrency: intent?.currency || input.currency,
        paymentState: after?.payment_state,
        residual: after?.amount_residual,
        completedResidual: wrotePayment,
      },
    });
    return {
      wrote: true,
      paymentState: after?.payment_state,
      residual: after?.amount_residual,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Odoo write-back failed";
    console.warn("[custara] odoo payment write-back", message);
    await writeAudit({
      organizationId: input.organizationId,
      actorType: "system",
      action: "connector.odoo_writeback_failed",
      entityType: "payment_intent",
      entityId: input.paymentIntentId,
      metadata: { error: message.slice(0, 240), moveId: moveIdRaw, invoiceId: input.invoiceId },
    });
    if (!input.fetchImpl) {
      await enqueueJob({
        queue: "accounting-sync",
        name: "odoo_writeback",
        organizationId: input.organizationId,
        payload: {
          organizationId: input.organizationId,
          invoiceId: input.invoiceId,
          paymentIntentId: input.paymentIntentId,
          amount: input.amount,
          currency: input.currency,
        },
        maxAttempts: 8,
      }).catch(() => undefined);
    }
    return { wrote: false, reason: message };
  }
}

export async function writeOdooApprovalBack(input: {
  organizationId: string;
  invoiceId: string;
  actorEmail?: string | null;
  fetchImpl?: RpcFetcher;
}) {
  try {
    const invoice = await prisma.invoice.findFirst({
      where: { id: input.invoiceId, organizationId: input.organizationId },
      include: { extraction: true },
    });
    const moveId = invoice?.externalId?.startsWith("odoo:")
      ? Number(invoice.externalId.slice(5))
      : NaN;
    if (!Number.isFinite(moveId) || moveId <= 0) return { wrote: false };
    const sess = await session(input.organizationId, input.fetchImpl);
    const kw = (model: string, method: string, args?: unknown[], kwargs?: Record<string, unknown>) =>
      executeKw({ ...sess, model, method, args, kwargs, fetchImpl: input.fetchImpl });
    const raw = invoice?.extraction?.rawJson ? JSON.parse(invoice.extraction.rawJson) : {};
    if (raw.odooState === "draft" || raw.odoo_state === "draft") {
      try {
        await kw("account.move", "action_post", [[moveId]]);
      } catch {
        /* already posted */
      }
    }
    try {
      await kw("account.move", "message_post", [
        [moveId],
      ], {
        body: `Approved in Custara${input.actorEmail ? ` by ${input.actorEmail}` : ""}. Settlement stays Arc testnet USDC.`,
      });
    } catch {
      /* chatter optional */
    }
    return { wrote: true };
  } catch {
    return { wrote: false };
  }
}

export async function retryFailedOdooWritebacks(organizationId?: string) {
  const failed = await prisma.auditEvent.findMany({
    where: {
      action: "connector.odoo_writeback_failed",
      ...(organizationId ? { organizationId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 40,
  });
  const results: Array<{ paymentIntentId: string; ok: boolean; reason?: string }> = [];
  const seen = new Set<string>();
  for (const row of failed) {
    if (!row.entityId || seen.has(row.entityId)) continue;
    seen.add(row.entityId);
    const later = await prisma.auditEvent.findFirst({
      where: {
        organizationId: row.organizationId,
        action: "connector.odoo_payment_written",
        entityType: "payment_intent",
        entityId: row.entityId,
        createdAt: { gt: row.createdAt },
      },
    });
    if (later) continue;
    const meta = JSON.parse(row.metadataJson || "{}") as { invoiceId?: string };
    const intent = await prisma.paymentIntent.findFirst({
      where: { id: row.entityId, organizationId: row.organizationId },
    });
    if (!intent || !meta.invoiceId) continue;
    const out = await writeOdooPaymentBack({
      organizationId: row.organizationId,
      invoiceId: meta.invoiceId,
      paymentIntentId: intent.id,
      amount: intent.amount,
      currency: intent.currency,
    });
    results.push({ paymentIntentId: intent.id, ok: out.wrote, reason: out.reason });
  }
  return results;
}

export async function listOdooWritebackFailures(organizationId: string) {
  const rows = await prisma.auditEvent.findMany({
    where: { organizationId, action: "connector.odoo_writeback_failed" },
    orderBy: { createdAt: "desc" },
    take: 15,
  });
  return rows.map((row) => ({
    id: row.id,
    paymentIntentId: row.entityId,
    createdAt: row.createdAt,
    error: (JSON.parse(row.metadataJson || "{}") as { error?: string }).error || "write-back failed",
  }));
}

export async function writeOdooChatter(input: {
  organizationId: string;
  invoiceId: string;
  body: string;
  fetchImpl?: RpcFetcher;
}) {
  const invoice = await prisma.invoice.findFirst({
    where: { id: input.invoiceId, organizationId: input.organizationId },
    select: { externalId: true },
  });
  const moveId = invoice?.externalId?.startsWith("odoo:")
    ? Number(invoice.externalId.slice(5))
    : NaN;
  if (!Number.isFinite(moveId) || moveId <= 0) return false;
  const sess = await session(input.organizationId, input.fetchImpl);
  const kw = (model: string, method: string, args?: unknown[], kwargs?: Record<string, unknown>) =>
    executeKw({ ...sess, model, method, args, kwargs, fetchImpl: input.fetchImpl });
  await kw("account.move", "message_post", [[moveId]], { body: input.body });
  return true;
}

export async function assignOdooCreditToBill(input: {
  organizationId: string;
  billInvoiceId: string;
  creditInvoiceId: string;
  fetchImpl?: RpcFetcher;
}) {
  const bill = await prisma.invoice.findFirst({
    where: { id: input.billInvoiceId, organizationId: input.organizationId },
    select: { externalId: true },
  });
  const moveId = bill?.externalId?.startsWith("odoo:") ? Number(bill.externalId.slice(5)) : NaN;
  if (!Number.isFinite(moveId)) return false;
  const sess = await session(input.organizationId, input.fetchImpl);
  const kw = (model: string, method: string, args?: unknown[], kwargs?: Record<string, unknown>) =>
    executeKw({ ...sess, model, method, args, kwargs, fetchImpl: input.fetchImpl });
  const move = await readOdooMovePayment(kw, moveId);
  if (move) await assignOdooOutstanding(kw, move);
  return true;
}

export async function listOdooJournals(organizationId: string, fetchImpl?: RpcFetcher) {
  const sess = await session(organizationId, fetchImpl);
  const kw = (model: string, method: string, args?: unknown[], kwargs?: Record<string, unknown>) =>
    executeKw({ ...sess, model, method, args, kwargs, fetchImpl });
  return ((await kw(
    "account.journal",
    "search_read",
    [[["type", "in", ["bank", "cash"]]]],
    { fields: ["id", "name", "type"], limit: 30 },
  )) || []) as Array<{ id: number; name: string; type: string }>;
}
