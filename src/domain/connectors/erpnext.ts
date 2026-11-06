/**
 * First-class ERPNext connector: REST session, supplier/PO/bill sync, Payment Entry write-back.
 * ERPNext remains the ledger; Custara is controls and settlement.
 */
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { encryptField, decryptField } from "@/lib/crypto";
import { InvoiceConflictError } from "@/domain/ingest";
import {
  ingestErpBill,
  mapErpNextPurchaseInvoice,
  odooIntentKey,
  odooLedgerWriteback,
  toIngestDocument,
} from "@/domain/erp/adapters";
import { enqueueJob } from "@/lib/jobs";
import { runInvoicePipeline } from "@/domain/pipeline";
import { upsertVendorPurchaseOrder } from "@/domain/contracts";
import { isMetadataHost, isPrivateOrLocalIp } from "@/domain/connectors/odoo";

export const ERPNEXT_CONNECTOR_TYPE = "accounting_erpnext";

const REST_TIMEOUT_MS = 20_000;
const PAGE_SIZE = 100;
const HARD_CAP = 2000;
const SYNC_LOCK_MS = 2 * 60_000;

type ErpNextSecrets = {
  apiKeyEnc: string;
  apiSecretEnc: string;
};

type ErpNextConfig = {
  origin: string;
  company?: string | null;
  paidFromAccount?: string | null;
  lastError?: string | null;
  syncStartedAt?: string | null;
  syncDirection?: "two_way" | "inbound" | "outbound";
  truncated?: boolean;
  lastSyncSummary?: Record<string, unknown> | null;
  webhookToken?: string | null;
};

type RestFetcher = typeof fetch;

export function allowPrivateErpNextHost(): boolean {
  if (process.env.ERPNEXT_ALLOW_PRIVATE === "true" || process.env.ODOO_ALLOW_PRIVATE === "true") {
    return true;
  }
  const production = process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);
  return !production;
}

export function isBlockedErpNextHost(host: string, allowPrivate = allowPrivateErpNextHost()): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (isMetadataHost(h)) return true;
  if (allowPrivate) return false;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) {
    return true;
  }
  return isPrivateOrLocalIp(h);
}

export function assertErpNextOrigin(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error("ERPNext URL is not valid.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("ERPNext URL must be http or https.");
  }
  if (isBlockedErpNextHost(parsed.hostname)) {
    throw new Error("ERPNext URL is not allowed.");
  }
  const production = process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);
  const allowHttp =
    process.env.ERPNEXT_ALLOW_HTTP === "true" || process.env.ODOO_ALLOW_HTTP === "true";
  if (production && parsed.protocol !== "https:" && !allowHttp) {
    throw new Error("ERPNext URL must be HTTPS in production.");
  }
  return parsed.origin;
}

export async function assertErpNextResolvedOrigin(origin: string): Promise<void> {
  const host = new URL(origin).hostname;
  if (isBlockedErpNextHost(host)) {
    throw new Error("ERPNext URL is not allowed.");
  }
  let records: Array<{ address: string }>;
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error("ERPNext host could not be resolved.");
  }
  if (!records.length) throw new Error("ERPNext host could not be resolved.");
  const allowPrivate = allowPrivateErpNextHost();
  for (const rec of records) {
    if (isMetadataHost(rec.address) || (isPrivateOrLocalIp(rec.address) && !allowPrivate)) {
      throw new Error("ERPNext URL is not allowed.");
    }
  }
}

function packSecrets(secrets: ErpNextSecrets): string {
  return JSON.stringify(secrets);
}

function parseSecrets(raw: string): Partial<ErpNextSecrets> {
  try {
    return JSON.parse(raw || "{}") as Partial<ErpNextSecrets>;
  } catch {
    return {};
  }
}

function parseConfig(raw: string): Partial<ErpNextConfig> {
  try {
    return JSON.parse(raw || "{}") as Partial<ErpNextConfig>;
  } catch {
    return {};
  }
}

function lockHeld(config: Partial<ErpNextConfig>): boolean {
  if (!config.syncStartedAt) return false;
  const started = Date.parse(config.syncStartedAt);
  if (!Number.isFinite(started)) return false;
  return Date.now() - started < SYNC_LOCK_MS;
}

function authHeader(apiKey: string, apiSecret: string) {
  return `token ${apiKey}:${apiSecret}`;
}

async function erpFetch(input: {
  origin: string;
  apiKey: string;
  apiSecret: string;
  path: string;
  method?: string;
  body?: unknown;
  fetchImpl?: RestFetcher;
}): Promise<unknown> {
  if (!input.fetchImpl) {
    await assertErpNextResolvedOrigin(input.origin);
  }
  const fetchImpl = input.fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${input.origin}${input.path}`, {
      method: input.method || "GET",
      headers: {
        Authorization: authHeader(input.apiKey, input.apiSecret),
        Accept: "application/json",
        ...(input.body != null ? { "Content-Type": "application/json" } : {}),
      },
      body: input.body != null ? JSON.stringify(input.body) : undefined,
      signal: controller.signal,
      redirect: "error",
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { message: text };
    }
    if (!res.ok) {
      const msg =
        (json as { message?: string; exc?: string })?.message ||
        (json as { exc?: string })?.exc ||
        `ERPNext HTTP ${res.status}`;
      throw new Error(String(msg).slice(0, 300));
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function listResource(input: {
  origin: string;
  apiKey: string;
  apiSecret: string;
  doctype: string;
  fields?: string[];
  filters?: unknown[];
  orderBy?: string;
  limit?: number;
  fetchImpl?: RestFetcher;
}): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  const cap = Math.min(input.limit || HARD_CAP, HARD_CAP);
  for (let start = 0; start < cap; start += PAGE_SIZE) {
    const params = new URLSearchParams();
    params.set("limit_start", String(start));
    params.set("limit_page_length", String(Math.min(PAGE_SIZE, cap - start)));
    if (input.fields?.length) params.set("fields", JSON.stringify(input.fields));
    if (input.filters?.length) params.set("filters", JSON.stringify(input.filters));
    if (input.orderBy) params.set("order_by", input.orderBy);
    const json = (await erpFetch({
      origin: input.origin,
      apiKey: input.apiKey,
      apiSecret: input.apiSecret,
      path: `/api/resource/${encodeURIComponent(input.doctype)}?${params}`,
      fetchImpl: input.fetchImpl,
    })) as { data?: Array<Record<string, unknown>> };
    const page = json.data || [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

async function getResource(input: {
  origin: string;
  apiKey: string;
  apiSecret: string;
  doctype: string;
  name: string;
  fetchImpl?: RestFetcher;
}): Promise<Record<string, unknown>> {
  const json = (await erpFetch({
    origin: input.origin,
    apiKey: input.apiKey,
    apiSecret: input.apiSecret,
    path: `/api/resource/${encodeURIComponent(input.doctype)}/${encodeURIComponent(input.name)}`,
    fetchImpl: input.fetchImpl,
  })) as { data?: Record<string, unknown> };
  return json.data || {};
}

export async function ensureErpNextConnector(organizationId: string) {
  return prisma.integrationConnector.upsert({
    where: { organizationId_type: { organizationId, type: ERPNEXT_CONNECTOR_TYPE } },
    create: {
      organizationId,
      type: ERPNEXT_CONNECTOR_TYPE,
      name: "ERPNext",
      status: "disconnected",
      configJson: JSON.stringify({ syncDirection: "two_way" }),
      secretsJson: "{}",
    },
    update: {},
  });
}

export async function connectErpNext(input: {
  organizationId: string;
  actorId: string;
  url: string;
  apiKey?: string;
  apiSecret?: string;
  company?: string | null;
  paidFromAccount?: string | null;
  fetchImpl?: RestFetcher;
}) {
  const existing = await ensureErpNextConnector(input.organizationId);
  const prevSecrets = parseSecrets(existing.secretsJson);
  const prevConfig = parseConfig(existing.configJson);
  const origin = assertErpNextOrigin(input.url);
  const apiKey =
    input.apiKey?.trim() ||
    (prevSecrets.apiKeyEnc ? decryptField(prevSecrets.apiKeyEnc) : "");
  const apiSecret =
    input.apiSecret?.trim() ||
    (prevSecrets.apiSecretEnc ? decryptField(prevSecrets.apiSecretEnc) : "");
  if (!apiKey || !apiSecret) throw new Error("ERPNext API key and secret are required.");

  await assertErpNextResolvedOrigin(origin);
  // Prove credentials: list one Supplier (or empty list on success).
  await listResource({
    origin,
    apiKey,
    apiSecret,
    doctype: "Supplier",
    fields: ["name"],
    limit: 1,
    fetchImpl: input.fetchImpl,
  });

  const webhookToken = prevConfig.webhookToken || randomBytes(24).toString("hex");
  const connector = await prisma.integrationConnector.update({
    where: { id: existing.id },
    data: {
      status: "connected",
      name: "ERPNext",
      configJson: JSON.stringify({
        origin,
        company: input.company ?? prevConfig.company ?? null,
        paidFromAccount: input.paidFromAccount ?? prevConfig.paidFromAccount ?? null,
        lastError: null,
        syncDirection: "two_way",
        webhookToken,
      } satisfies ErpNextConfig),
      secretsJson: packSecrets({
        apiKeyEnc: encryptField(apiKey),
        apiSecretEnc: encryptField(apiSecret),
      }),
    },
  });
  await writeAudit({
    organizationId: input.organizationId,
    actorType: "user",
    actorId: input.actorId,
    action: "connector.erpnext_connected",
    entityType: "connector",
    entityId: connector.id,
    metadata: { origin },
  });
  return connector;
}

export async function disconnectErpNext(input: { organizationId: string; actorId: string }) {
  const existing = await ensureErpNextConnector(input.organizationId);
  const prev = parseConfig(existing.configJson);
  const connector = await prisma.integrationConnector.update({
    where: { id: existing.id },
    data: {
      status: "disconnected",
      lastSyncAt: null,
      secretsJson: "{}",
      configJson: JSON.stringify({
        origin: prev.origin,
        company: prev.company,
        paidFromAccount: prev.paidFromAccount,
        lastError: null,
        syncDirection: "two_way",
      }),
    },
  });
  await writeAudit({
    organizationId: input.organizationId,
    actorType: "user",
    actorId: input.actorId,
    action: "connector.erpnext_disconnected",
    entityType: "connector",
    entityId: connector.id,
    metadata: { origin: prev.origin },
  });
  return connector;
}

async function session(organizationId: string, fetchImpl?: RestFetcher) {
  const connector = await prisma.integrationConnector.findUnique({
    where: { organizationId_type: { organizationId, type: ERPNEXT_CONNECTOR_TYPE } },
  });
  if (!connector || (connector.status !== "connected" && connector.status !== "error")) {
    throw new Error("ERPNext is not connected.");
  }
  const config = parseConfig(connector.configJson);
  const secrets = parseSecrets(connector.secretsJson);
  if (!config.origin || !secrets.apiKeyEnc || !secrets.apiSecretEnc) {
    throw new Error("ERPNext is not connected.");
  }
  return {
    connector,
    origin: config.origin,
    apiKey: decryptField(secrets.apiKeyEnc),
    apiSecret: decryptField(secrets.apiSecretEnc),
    company: config.company || null,
    paidFromAccount: config.paidFromAccount || null,
    fetchImpl,
  };
}

async function upsertErpNextVendor(input: {
  organizationId: string;
  supplierName: string;
  displayName?: string | null;
  email?: string | null;
  taxId?: string | null;
}) {
  const externalId = `erpnext-supplier:${input.supplierName}`;
  const name = (input.displayName || input.supplierName).trim();
  const existing = await prisma.vendor.findUnique({
    where: { organizationId_externalId: { organizationId: input.organizationId, externalId } },
  });
  if (existing) {
    return prisma.vendor.update({
      where: { id: existing.id },
      data: {
        name,
        email: input.email || existing.email,
        taxId: input.taxId || existing.taxId,
      },
    });
  }
  const byName = await prisma.vendor.findFirst({
    where: { organizationId: input.organizationId, name: { equals: name } },
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
      name,
      email: input.email || null,
      taxId: input.taxId || null,
      isNew: true,
    },
  });
}

function modifiedSinceFilter(lastSyncAt: Date | null): unknown[] {
  if (!lastSyncAt) return [];
  const since = new Date(lastSyncAt.getTime() - 24 * 60 * 60 * 1000);
  const stamp = since.toISOString().slice(0, 19).replace("T", " ");
  return ["modified", ">=", stamp];
}

export async function syncErpNextInbound(input: {
  organizationId: string;
  actorId?: string;
  fetchImpl?: RestFetcher;
  skipIfBusy?: boolean;
  full?: boolean;
}): Promise<{
  vendors: number;
  purchaseOrders: number;
  ingested: number;
  skipped: number;
  truncated?: boolean;
}> {
  const sess = await session(input.organizationId, input.fetchImpl);
  const config = parseConfig(sess.connector.configJson);
  if (lockHeld(config)) {
    if (input.skipIfBusy) {
      return { vendors: 0, purchaseOrders: 0, ingested: 0, skipped: 0, truncated: false };
    }
    throw new Error("ERPNext sync is already running.");
  }

  await prisma.integrationConnector.update({
    where: { id: sess.connector.id },
    data: {
      configJson: JSON.stringify({
        ...config,
        origin: sess.origin,
        syncStartedAt: new Date().toISOString(),
      }),
    },
  });

  let vendors = 0;
  let purchaseOrders = 0;
  let ingested = 0;
  let skipped = 0;
  let truncated = false;
  const lastSyncAt = input.full ? null : sess.connector.lastSyncAt;
  const since = modifiedSinceFilter(lastSyncAt);

  try {
    const supplierFilters = since.length ? [since] : [];
    const suppliers = await listResource({
      ...sess,
      doctype: "Supplier",
      fields: ["name", "supplier_name", "email_id", "tax_id", "disabled"],
      filters: supplierFilters,
      orderBy: "modified desc",
      limit: HARD_CAP,
      fetchImpl: input.fetchImpl,
    });
    truncated = truncated || suppliers.length >= HARD_CAP;

    for (const row of suppliers) {
      const name = String(row.name || "").trim();
      if (!name) continue;
      if (row.disabled) continue;
      await upsertErpNextVendor({
        organizationId: input.organizationId,
        supplierName: name,
        displayName: String(row.supplier_name || name),
        email: row.email_id ? String(row.email_id) : null,
        taxId: row.tax_id ? String(row.tax_id) : null,
      });
      vendors += 1;
    }

    const poFilters: unknown[] = [["docstatus", "=", 1]];
    if (since.length) poFilters.push(since);
    const orders = await listResource({
      ...sess,
      doctype: "Purchase Order",
      fields: ["name", "supplier", "supplier_name", "grand_total", "currency", "status", "per_received"],
      filters: poFilters,
      orderBy: "modified desc",
      limit: HARD_CAP,
      fetchImpl: input.fetchImpl,
    });
    truncated = truncated || orders.length >= HARD_CAP;

    for (const po of orders) {
      const poNumber = String(po.name || "").trim();
      const supplier = String(po.supplier || "").trim();
      if (!poNumber || !supplier) continue;
      const vendor = await upsertErpNextVendor({
        organizationId: input.organizationId,
        supplierName: supplier,
        displayName: String(po.supplier_name || supplier),
      });
      const perReceived = Number(po.per_received || 0);
      await upsertVendorPurchaseOrder({
        organizationId: input.organizationId,
        actorId: input.actorId || "erpnext-sync",
        vendorId: vendor.id,
        poNumber,
        amount: Number(po.grand_total) || null,
        currency: String(po.currency || "NGN"),
        label: `ERPNext ${poNumber}`,
        orderedQty: 100,
        receivedQty: Number.isFinite(perReceived) ? perReceived : null,
      });
      purchaseOrders += 1;
    }

    const billFilters: unknown[] = [["docstatus", "=", 1]];
    if (since.length) billFilters.push(since);
    if (sess.company) billFilters.push(["company", "=", sess.company]);
    const billNames = await listResource({
      ...sess,
      doctype: "Purchase Invoice",
      fields: ["name", "modified"],
      filters: billFilters,
      orderBy: "modified desc",
      limit: HARD_CAP,
      fetchImpl: input.fetchImpl,
    });
    truncated = truncated || billNames.length >= HARD_CAP;

    for (const row of billNames) {
      const name = String(row.name || "").trim();
      if (!name) continue;
      try {
        const full = await getResource({
          ...sess,
          doctype: "Purchase Invoice",
          name,
          fetchImpl: input.fetchImpl,
        });
        const bill = mapErpNextPurchaseInvoice(full as Parameters<typeof mapErpNextPurchaseInvoice>[0]);
        try {
          await ingestErpBill({
            organizationId: input.organizationId,
            system: "erpnext",
            bill,
            sync: true,
            actorType: "system",
            actorId: input.actorId || "erpnext-sync",
          });
          ingested += 1;
        } catch (err) {
          if (!(err instanceof InvoiceConflictError)) throw err;
          // Refresh structured JSON + re-extract so older bad pulls get fixed details.
          const existing = await prisma.invoice.findUnique({
            where: { id: err.invoiceId },
            select: { status: true },
          });
          const open =
            existing &&
            !["payment_sent", "payment_queued", "reconciled", "settled", "void"].includes(
              existing.status,
            );
          if (existing && open) {
            const payload = Buffer.from(
              JSON.stringify(toIngestDocument("erpnext", bill), null, 2),
              "utf8",
            );
            const doc = await prisma.invoiceDocument.findFirst({
              where: {
                invoiceId: err.invoiceId,
                deletedAt: null,
                OR: [{ filename: "invoice.json" }, { filename: { endsWith: ".json" } }],
              },
              orderBy: { createdAt: "asc" },
            });
            if (doc) {
              await prisma.invoiceDocument.update({
                where: { id: doc.id },
                data: { content: payload, byteSize: payload.length },
              });
            }
            await runInvoicePipeline(err.invoiceId, {
              type: "system",
              id: input.actorId || "erpnext-sync",
            });
            ingested += 1;
          } else {
            skipped += 1;
          }
        }

        try {
          const files = await listResource({
            ...sess,
            doctype: "File",
            fields: ["name", "file_url", "file_name", "is_private"],
            filters: [
              ["attached_to_doctype", "=", "Purchase Invoice"],
              ["attached_to_name", "=", name],
            ],
            limit: 5,
            fetchImpl: input.fetchImpl,
          });
          if (files.length) {
            await writeAudit({
              organizationId: input.organizationId,
              actorType: "system",
              action: "connector.erpnext_attachments_seen",
              entityType: "invoice",
              entityId: bill.externalId,
              metadata: { count: files.length, files: files.map((f) => f.file_name) },
            });
          }
        } catch {
          // Attachments optional.
        }
      } catch (err) {
        skipped += 1;
        const message = err instanceof Error ? err.message : "ingest failed";
        await writeAudit({
          organizationId: input.organizationId,
          actorType: "system",
          action: "connector.erpnext_bill_skipped",
          entityType: "connector",
          entityId: sess.connector.id,
          metadata: { name, error: message.slice(0, 200) },
        });
      }
    }

    const summary = { vendors, purchaseOrders, ingested, skipped, truncated };
    await prisma.integrationConnector.update({
      where: { id: sess.connector.id },
      data: {
        status: "connected",
        lastSyncAt: new Date(),
        configJson: JSON.stringify({
          ...parseConfig(sess.connector.configJson),
          origin: sess.origin,
          company: sess.company,
          paidFromAccount: sess.paidFromAccount,
          lastError: null,
          syncStartedAt: null,
          truncated,
          lastSyncSummary: summary,
          syncDirection: "two_way",
          webhookToken: config.webhookToken,
        }),
      },
    });
    return summary;
  } catch (err) {
    const message = err instanceof Error ? err.message : "ERPNext sync failed";
    await prisma.integrationConnector.update({
      where: { id: sess.connector.id },
      data: {
        status: "error",
        configJson: JSON.stringify({
          ...config,
          origin: sess.origin,
          lastError: message.slice(0, 240),
          syncStartedAt: null,
        }),
      },
    });
    throw err instanceof Error ? err : new Error(message);
  }
}

export async function syncAllErpNextConnectors() {
  const connectors = await prisma.integrationConnector.findMany({
    where: { type: ERPNEXT_CONNECTOR_TYPE, status: { in: ["connected", "error"] } },
    select: { organizationId: true },
  });
  const results: Array<{ organizationId: string; ok: boolean; error?: string }> = [];
  for (const c of connectors) {
    try {
      await syncErpNextInbound({ organizationId: c.organizationId, skipIfBusy: true });
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

export async function enqueueErpNextSyncByWebhookToken(token: string) {
  const trimmed = token.trim();
  if (!trimmed) return false;
  const connectors = await prisma.integrationConnector.findMany({
    where: { type: ERPNEXT_CONNECTOR_TYPE, status: { in: ["connected", "error"] } },
    select: { organizationId: true, configJson: true },
  });
  const match = connectors.find((c) => parseConfig(c.configJson).webhookToken === trimmed);
  if (!match) return false;
  await enqueueJob({
    queue: "accounting-sync",
    name: "sync_erpnext_org",
    payload: { organizationId: match.organizationId },
    organizationId: match.organizationId,
    maxAttempts: 2,
  });
  return true;
}

function erpNextInvoiceName(externalId: string | null | undefined): string | null {
  if (!externalId) return null;
  if (externalId.startsWith("erpnext:")) return externalId.slice("erpnext:".length);
  if (externalId.startsWith("erpnext-refund:")) return externalId.slice("erpnext-refund:".length);
  return null;
}

export async function writeErpNextPaymentBack(input: {
  organizationId: string;
  invoiceId: string;
  paymentIntentId: string;
  amount: number;
  currency: string;
  fetchImpl?: RestFetcher;
}): Promise<{ wrote: boolean; reason?: string }> {
  const connector = await prisma.integrationConnector.findUnique({
    where: {
      organizationId_type: { organizationId: input.organizationId, type: ERPNEXT_CONNECTOR_TYPE },
    },
  });
  if (!connector || (connector.status !== "connected" && connector.status !== "error")) {
    return { wrote: false, reason: "erpnext_not_connected" };
  }

  const invoice = await prisma.invoice.findFirst({
    where: { id: input.invoiceId, organizationId: input.organizationId },
    select: { externalId: true, totalAmount: true, currency: true, vendorId: true },
  });
  const pinvoice = erpNextInvoiceName(invoice?.externalId);
  if (!pinvoice) return { wrote: false, reason: "not_erpnext_invoice" };

  try {
    const sess = await session(input.organizationId, input.fetchImpl);
    const full = await getResource({
      ...sess,
      doctype: "Purchase Invoice",
      name: pinvoice,
      fetchImpl: input.fetchImpl,
    });
    const outstanding = Number(full.outstanding_amount ?? 0);
    const status = String(full.status || "").toLowerCase();
    if (status === "paid" || (Number.isFinite(outstanding) && outstanding <= 0.01)) {
      return { wrote: false, reason: "already_paid" };
    }

    const intentKey = odooIntentKey(input.paymentIntentId);
    const existing = await listResource({
      ...sess,
      doctype: "Payment Entry",
      fields: ["name", "remarks", "reference_no", "docstatus"],
      filters: [["remarks", "like", `%${intentKey}%`]],
      limit: 5,
      fetchImpl: input.fetchImpl,
    });
    if (existing.some((p) => Number(p.docstatus) !== 2)) {
      return { wrote: false, reason: "already_written" };
    }

    const intent = await prisma.paymentIntent.findFirst({
      where: { id: input.paymentIntentId, organizationId: input.organizationId },
      select: { amount: true, currency: true, txHash: true },
    });
    const ledger = odooLedgerWriteback({
      ledgerAmount:
        Number.isFinite(outstanding) && outstanding > 0.01
          ? outstanding
          : invoice?.totalAmount || input.amount,
      ledgerCurrency: String(full.currency || invoice?.currency || input.currency),
      settledAmount: intent?.amount ?? input.amount,
      settledCurrency: intent?.currency || input.currency,
      txHash: intent?.txHash,
      paymentIntentId: input.paymentIntentId,
    });

    const party = String(full.supplier || "");
    const company = String(full.company || sess.company || "");
    let paidFrom = sess.paidFromAccount || "";
    if (!paidFrom) {
      const accounts = await listResource({
        ...sess,
        doctype: "Account",
        fields: ["name"],
        filters: [
          ["account_type", "in", ["Bank", "Cash"]],
          ["is_group", "=", 0],
          ...(company ? [["company", "=", company]] : []),
        ],
        limit: 1,
        fetchImpl: input.fetchImpl,
      });
      paidFrom = String(accounts[0]?.name || "");
    }
    if (!paidFrom) {
      await writeAudit({
        organizationId: input.organizationId,
        actorType: "system",
        action: "connector.erpnext_writeback_skipped",
        entityType: "payment_intent",
        entityId: input.paymentIntentId,
        metadata: { reason: "no_bank_account", purchaseInvoice: pinvoice },
      });
      return { wrote: false, reason: "no_bank_account" };
    }

    const postingDate = new Date().toISOString().slice(0, 10);
    const createBody = {
      payment_type: "Pay",
      party_type: "Supplier",
      party,
      company: company || undefined,
      posting_date: postingDate,
      paid_amount: ledger.amount,
      received_amount: ledger.amount,
      paid_from: paidFrom,
      paid_to: full.credit_to || undefined,
      reference_no: intentKey,
      reference_date: postingDate,
      remarks: ledger.communication,
      references: [
        {
          reference_doctype: "Purchase Invoice",
          reference_name: pinvoice,
          allocated_amount: ledger.amount,
        },
      ],
    };

    const created = (await erpFetch({
      ...sess,
      path: "/api/resource/Payment Entry",
      method: "POST",
      body: createBody,
      fetchImpl: input.fetchImpl,
    })) as { data?: { name?: string } };

    const peName = created.data?.name;
    if (peName) {
      await erpFetch({
        ...sess,
        path: `/api/resource/Payment Entry/${encodeURIComponent(peName)}`,
        method: "PUT",
        body: { docstatus: 1 },
        fetchImpl: input.fetchImpl,
      }).catch(async () => {
        // Prefer submit via whitelisted method when PUT docstatus is restricted.
        await erpFetch({
          ...sess,
          path: "/api/method/frappe.client.submit",
          method: "POST",
          body: { doc: { doctype: "Payment Entry", name: peName } },
          fetchImpl: input.fetchImpl,
        });
      });
    }

    await writeAudit({
      organizationId: input.organizationId,
      actorType: "system",
      action: "connector.erpnext_payment_written",
      entityType: "payment_intent",
      entityId: input.paymentIntentId,
      metadata: {
        invoiceId: input.invoiceId,
        purchaseInvoice: pinvoice,
        paymentEntry: peName || null,
        amount: ledger.amount,
        currency: ledger.currency,
      },
    });
    return { wrote: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "ERPNext write-back failed";
    await writeAudit({
      organizationId: input.organizationId,
      actorType: "system",
      action: "connector.erpnext_writeback_failed",
      entityType: "payment_intent",
      entityId: input.paymentIntentId,
      metadata: { invoiceId: input.invoiceId, error: message.slice(0, 300) },
    });
    if (!input.fetchImpl) {
      await enqueueJob({
        queue: "accounting-sync",
        name: "erpnext_writeback",
        payload: {
          organizationId: input.organizationId,
          invoiceId: input.invoiceId,
          paymentIntentId: input.paymentIntentId,
          amount: input.amount,
          currency: input.currency,
        },
        organizationId: input.organizationId,
        maxAttempts: 5,
        runAt: new Date(Date.now() + 60_000),
      }).catch(() => undefined);
    }
    return { wrote: false, reason: message };
  }
}

export async function retryFailedErpNextWritebacks(organizationId?: string) {
  const failed = await prisma.auditEvent.findMany({
    where: {
      action: "connector.erpnext_writeback_failed",
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
        action: "connector.erpnext_payment_written",
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
    const out = await writeErpNextPaymentBack({
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

export async function listErpNextWritebackFailures(organizationId: string) {
  const rows = await prisma.auditEvent.findMany({
    where: { organizationId, action: "connector.erpnext_writeback_failed" },
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
