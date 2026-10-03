import { randomBytes, createHash } from "crypto";
import { prisma } from "@/lib/db";
import { encryptField, decryptField } from "@/lib/crypto";
import { writeAudit } from "@/lib/audit";
import { enqueueJob } from "@/lib/jobs";
import {
  ingestAccountingBill,
  reconcileAccountingPayment,
} from "@/domain/connectors/accountingIngest";

const XERO_AUTH = "https://login.xero.com/identity/connect/authorize";
const XERO_TOKEN = "https://identity.xero.com/connect/token";
const XERO_API = "https://api.xero.com/api.xro/2.0";

export function isXeroConfigured() {
  return Boolean(
    process.env.XERO_CLIENT_ID?.trim() &&
      process.env.XERO_CLIENT_SECRET?.trim() &&
      process.env.XERO_REDIRECT_URI?.trim(),
  );
}

type XeroSecrets = {
  accessToken?: string;
  refreshToken?: string;
  tenantId?: string;
  expiresAt?: string;
};

function parseSecrets(raw: string): XeroSecrets {
  try {
    const obj = JSON.parse(raw) as Record<string, string>;
    return {
      accessToken: obj.accessTokenEnc ? decryptField(obj.accessTokenEnc) : undefined,
      refreshToken: obj.refreshTokenEnc ? decryptField(obj.refreshTokenEnc) : undefined,
      tenantId: obj.tenantId,
      expiresAt: obj.expiresAt,
    };
  } catch {
    return {};
  }
}

function packSecrets(s: XeroSecrets) {
  return JSON.stringify({
    accessTokenEnc: s.accessToken ? encryptField(s.accessToken) : undefined,
    refreshTokenEnc: s.refreshToken ? encryptField(s.refreshToken) : undefined,
    tenantId: s.tenantId,
    expiresAt: s.expiresAt,
  });
}

export async function ensureXeroConnector(organizationId: string) {
  const configured = isXeroConfigured();
  const existing = await prisma.integrationConnector.findUnique({
    where: { organizationId_type: { organizationId, type: "accounting_xero" } },
  });
  const nextStatus =
    existing?.status === "connected" && configured ? "connected" : "disconnected";

  return prisma.integrationConnector.upsert({
    where: { organizationId_type: { organizationId, type: "accounting_xero" } },
    create: {
      organizationId,
      type: "accounting_xero",
      name: "Xero Accounting",
      status: nextStatus,
      configJson: JSON.stringify({
        syncDirection: "two_way",
        configured,
      }),
      secretsJson: "{}",
    },
    update: {
      status: nextStatus,
      configJson: JSON.stringify({
        syncDirection: "two_way",
        configured,
      }),
    },
  });
}

export function buildXeroAuthUrl(organizationId: string) {
  if (!isXeroConfigured()) throw new Error("Xero env not configured");
  const state = Buffer.from(
    JSON.stringify({ organizationId, nonce: randomBytes(8).toString("hex") }),
  ).toString("base64url");
  const url = new URL(XERO_AUTH);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", process.env.XERO_CLIENT_ID!);
  url.searchParams.set("redirect_uri", process.env.XERO_REDIRECT_URI!);
  url.searchParams.set("scope", "openid profile email accounting.transactions accounting.contacts offline_access");
  url.searchParams.set("state", state);
  return { url: url.toString(), state };
}

export async function exchangeXeroCode(input: { code: string; state: string; actorId?: string }) {
  if (!isXeroConfigured()) throw new Error("Xero env not configured");
  const parsed = JSON.parse(Buffer.from(input.state, "base64url").toString("utf8")) as {
    organizationId: string;
  };
  const basic = Buffer.from(
    `${process.env.XERO_CLIENT_ID}:${process.env.XERO_CLIENT_SECRET}`,
  ).toString("base64");

  const tokenRes = await fetch(XERO_TOKEN, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: process.env.XERO_REDIRECT_URI!,
    }),
  });
  if (!tokenRes.ok) throw new Error(`Xero token exchange failed: ${tokenRes.status}`);
  const tokens = (await tokenRes.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const connectionsRes = await fetch("https://api.xero.com/connections", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!connectionsRes.ok) throw new Error("Failed to list Xero tenants");
  const connections = (await connectionsRes.json()) as Array<{ tenantId: string; tenantName: string }>;
  const tenant = connections[0];
  if (!tenant) throw new Error("No Xero organisation connected");

  const connector = await ensureXeroConnector(parsed.organizationId);
  await prisma.integrationConnector.update({
    where: { id: connector.id },
    data: {
      status: "connected",
      secretsJson: packSecrets({
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        tenantId: tenant.tenantId,
        expiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      }),
      configJson: JSON.stringify({
        syncDirection: "two_way",
        configured: true,
        tenantName: tenant.tenantName,
        tenantId: tenant.tenantId,
      }),
      lastSyncAt: new Date(),
    },
  });

  await writeAudit({
    organizationId: parsed.organizationId,
    actorType: "user",
    actorId: input.actorId,
    action: "connector.xero_connected",
    entityType: "connector",
    entityId: connector.id,
    metadata: { tenantId: tenant.tenantId },
  });

  return connector;
}

async function refreshIfNeeded(organizationId: string) {
  const connector = await prisma.integrationConnector.findUniqueOrThrow({
    where: { organizationId_type: { organizationId, type: "accounting_xero" } },
  });
  const secrets = parseSecrets(connector.secretsJson);
  if (!secrets.refreshToken || !secrets.accessToken) throw new Error("Xero not connected");
  const expires = secrets.expiresAt ? new Date(secrets.expiresAt).getTime() : 0;
  if (expires > Date.now() + 60_000) return { connector, secrets };

  const basic = Buffer.from(
    `${process.env.XERO_CLIENT_ID}:${process.env.XERO_CLIENT_SECRET}`,
  ).toString("base64");
  const tokenRes = await fetch(XERO_TOKEN, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: secrets.refreshToken,
    }),
  });
  if (!tokenRes.ok) throw new Error("Xero refresh failed");
  const tokens = (await tokenRes.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  const next = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    tenantId: secrets.tenantId,
    expiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
  };
  await prisma.integrationConnector.update({
    where: { id: connector.id },
    data: { secretsJson: packSecrets(next) },
  });
  return { connector, secrets: next };
}

async function xeroFetch(organizationId: string, path: string, init?: RequestInit) {
  const { secrets } = await refreshIfNeeded(organizationId);
  const res = await fetch(`${XERO_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${secrets.accessToken}`,
      "Xero-tenant-id": secrets.tenantId || "",
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`Xero API ${res.status}: ${text.slice(0, 200)}`);
  return data;
}

/** Push approved invoices as Xero ACCPAY bills (idempotent by InvoiceNumber). */
export async function pushInvoicesToXero(organizationId: string) {
  if (!isXeroConfigured()) throw new Error("Xero env not configured");
  const invoices = await prisma.invoice.findMany({
    where: {
      organizationId,
      status: { in: ["approved", "payment_queued", "payment_sent", "reconciled"] },
    },
    include: { vendor: true },
    take: 50,
    orderBy: { updatedAt: "desc" },
  });

  const bills = invoices.map((inv) => ({
    Type: "ACCPAY",
    Contact: { Name: inv.vendor?.name || "Vendor" },
    LineItems: [
      {
        Description: inv.invoiceNumber || inv.id,
        Quantity: 1,
        UnitAmount: inv.totalAmount || 0,
        AccountCode: "400",
      },
    ],
    Date: (inv.issueDate || inv.createdAt).toISOString().slice(0, 10),
    DueDate: (inv.dueDate || inv.createdAt).toISOString().slice(0, 10),
    InvoiceNumber: inv.invoiceNumber || inv.id.slice(0, 20),
    CurrencyCode: inv.currency === "USDC" ? "USD" : inv.currency,
    Status: "AUTHORISED",
    Reference: inv.id,
  }));

  if (bills.length === 0) return { pushed: 0 };
  await xeroFetch(organizationId, "/Invoices", {
    method: "POST",
    body: JSON.stringify({ Invoices: bills }),
  });

  await prisma.integrationConnector.update({
    where: { organizationId_type: { organizationId, type: "accounting_xero" } },
    data: { lastSyncAt: new Date(), status: "connected" },
  });

  await writeAudit({
    organizationId,
    actorType: "system",
    action: "connector.xero_export",
    entityType: "connector",
    metadata: { count: bills.length },
  });

  return { pushed: bills.length };
}

/** Pull ACCPAY bills: ingest missing authorised bills, reconcile paid ones. */
export async function syncXeroInbound(organizationId: string) {
  if (!isXeroConfigured()) {
    return { reconciled: 0, ingested: 0, skipped: true };
  }

  const connector = await prisma.integrationConnector.findUnique({
    where: { organizationId_type: { organizationId, type: "accounting_xero" } },
  });
  if (!connector || connector.status !== "connected") {
    return { reconciled: 0, ingested: 0 };
  }

  let ingested = 0;
  let reconciled = 0;

  // Authorised / submitted AP bills → create Custara invoices
  const openData = await xeroFetch(
    organizationId,
    "/Invoices?Statuses=AUTHORISED%2CSUBMITTED&where=Type%3D%3D%22ACCPAY%22",
  );
  const openBills = (openData.Invoices || []) as Array<{
    InvoiceNumber?: string;
    Reference?: string;
    Total?: number;
    CurrencyCode?: string;
    InvoiceID?: string;
    DueDateString?: string;
    DateString?: string;
    Status?: string;
    Contact?: { Name?: string };
  }>;

  for (const xi of openBills) {
    if (!xi.InvoiceID) continue;
    const result = await ingestAccountingBill({
      organizationId,
      provider: "xero",
      sync: false,
      bill: {
        externalId: xi.InvoiceID,
        invoiceNumber: xi.InvoiceNumber,
        vendorName: xi.Contact?.Name,
        totalAmount: Number(xi.Total || 0),
        currency: xi.CurrencyCode || "NGN",
        dueDate: xi.DueDateString,
        invoiceDate: xi.DateString,
        status: xi.Status?.toLowerCase(),
        description: xi.Reference,
      },
    });
    if (result.created) ingested += 1;
  }

  // Paid AP bills → reconcile
  const paidData = await xeroFetch(
    organizationId,
    "/Invoices?Statuses=PAID&where=Type%3D%3D%22ACCPAY%22",
  );
  const paidBills = (paidData.Invoices || []) as Array<{
    InvoiceNumber?: string;
    Reference?: string;
    Total?: number;
    CurrencyCode?: string;
    InvoiceID?: string;
    Contact?: { Name?: string };
  }>;

  for (const xi of paidBills) {
    if (!xi.InvoiceID) continue;
    // Ensure invoice exists first
    await ingestAccountingBill({
      organizationId,
      provider: "xero",
      sync: false,
      bill: {
        externalId: xi.InvoiceID,
        invoiceNumber: xi.InvoiceNumber,
        vendorName: xi.Contact?.Name,
        totalAmount: Number(xi.Total || 0),
        currency: xi.CurrencyCode || "NGN",
        status: "paid",
      },
    });
    const r = await reconcileAccountingPayment({
      organizationId,
      provider: "xero",
      bill: {
        externalId: xi.InvoiceID,
        invoiceNumber: xi.InvoiceNumber,
        totalAmount: Number(xi.Total || 0),
        currency: xi.CurrencyCode || "NGN",
        status: "paid",
      },
    });
    if (r.reconciled) reconciled += 1;
  }

  await prisma.integrationConnector.update({
    where: { id: connector.id },
    data: { lastSyncAt: new Date() },
  });

  await writeAudit({
    organizationId,
    actorType: "system",
    action: "connector.xero_inbound_sync",
    entityType: "connector",
    entityId: connector.id,
    metadata: { reconciled, ingested },
  });

  return { reconciled, ingested };
}

export async function enqueueXeroSync(organizationId: string) {
  return enqueueJob({
    queue: "xero-sync",
    name: "sync_inbound",
    organizationId,
    payload: { organizationId },
  });
}

export async function disconnectXero(organizationId: string, actorId?: string) {
  const connector = await ensureXeroConnector(organizationId);
  await prisma.integrationConnector.update({
    where: { id: connector.id },
    data: { status: "disconnected", secretsJson: "{}" },
  });
  await writeAudit({
    organizationId,
    actorType: "user",
    actorId,
    action: "connector.xero_disconnected",
    entityType: "connector",
    entityId: connector.id,
  });
}

export function xeroStateHash(organizationId: string) {
  return createHash("sha256").update(organizationId).digest("hex").slice(0, 16);
}
