import { prisma } from "@/lib/db";
import { encryptField, decryptField } from "@/lib/crypto";
import { writeAudit } from "@/lib/audit";
import { enqueueJob } from "@/lib/jobs";
import {
  ingestAccountingBill,
  reconcileAccountingPayment,
  type AccountingBill,
} from "@/domain/connectors/accountingIngest";

type Provider = "qbo" | "sage" | "zoho";

const META: Record<
  Provider,
  { type: string; name: string; envPrefix: string; tokenUrl: string; authUrl: string }
> = {
  qbo: {
    type: "accounting_qbo",
    name: "QuickBooks Online",
    envPrefix: "QBO",
    authUrl: "https://appcenter.intuit.com/connect/oauth2",
    tokenUrl: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
  },
  sage: {
    type: "accounting_sage",
    name: "Sage Business Cloud",
    envPrefix: "SAGE",
    authUrl: "https://www.sageone.com/oauth2/auth/central",
    tokenUrl: "https://oauth.accounting.sage.com/token",
  },
  zoho: {
    type: "accounting_zoho",
    name: "Zoho Books",
    envPrefix: "ZOHO",
    authUrl: "https://accounts.zoho.com/oauth/v2/auth",
    tokenUrl: "https://accounts.zoho.com/oauth/v2/token",
  },
};

function env(prefix: string, key: string) {
  return (process.env[`${prefix}_${key}`] || "").trim();
}

export function isAccountingProviderConfigured(provider: Provider) {
  const p = META[provider].envPrefix;
  return Boolean(env(p, "CLIENT_ID") && env(p, "CLIENT_SECRET") && env(p, "REDIRECT_URI"));
}

export async function ensureAccountingProviderConnector(organizationId: string, provider: Provider) {
  const meta = META[provider];
  const configured = isAccountingProviderConfigured(provider);
  const existing = await prisma.integrationConnector.findUnique({
    where: { organizationId_type: { organizationId, type: meta.type } },
  });
  const nextStatus =
    existing?.status === "connected" && configured ? "connected" : "disconnected";

  return prisma.integrationConnector.upsert({
    where: { organizationId_type: { organizationId, type: meta.type } },
    create: {
      organizationId,
      type: meta.type,
      name: meta.name,
      status: nextStatus,
      configJson: JSON.stringify({
        provider,
        syncDirection: "inbound_bills",
        configured,
      }),
      secretsJson: "{}",
    },
    update: {
      status: nextStatus,
      configJson: JSON.stringify({
        provider,
        syncDirection: "inbound_bills",
        configured,
      }),
    },
  });
}

export async function ensureAllAccountingConnectors(organizationId: string) {
  await Promise.all([
    ensureAccountingProviderConnector(organizationId, "qbo"),
    ensureAccountingProviderConnector(organizationId, "sage"),
    ensureAccountingProviderConnector(organizationId, "zoho"),
  ]);
}

export function buildAccountingAuthUrl(organizationId: string, provider: Provider) {
  if (!isAccountingProviderConfigured(provider)) {
    throw new Error(`${META[provider].name} OAuth env not configured`);
  }
  const meta = META[provider];
  const p = meta.envPrefix;
  const state = Buffer.from(JSON.stringify({ organizationId, provider })).toString("base64url");
  const url = new URL(meta.authUrl);
  url.searchParams.set("client_id", env(p, "CLIENT_ID"));
  url.searchParams.set("redirect_uri", env(p, "REDIRECT_URI"));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  if (provider === "qbo") {
    url.searchParams.set("scope", "com.intuit.quickbooks.accounting");
  } else if (provider === "zoho") {
    url.searchParams.set("scope", "ZohoBooks.fullaccess.all");
    url.searchParams.set("access_type", "offline");
  } else {
    url.searchParams.set("scope", "full_access");
  }
  return { url: url.toString(), state };
}

export async function completeAccountingOAuth(input: {
  provider: Provider;
  code: string;
  state: string;
  actorId?: string;
  realmId?: string;
}) {
  const meta = META[input.provider];
  const p = meta.envPrefix;
  const parsed = JSON.parse(Buffer.from(input.state, "base64url").toString("utf8")) as {
    organizationId: string;
    provider: Provider;
  };
  if (parsed.provider !== input.provider) throw new Error("OAuth state provider mismatch");

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: env(p, "REDIRECT_URI"),
    client_id: env(p, "CLIENT_ID"),
    client_secret: env(p, "CLIENT_SECRET"),
  });

  const tokenRes = await fetch(meta.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  if (!tokenRes.ok) throw new Error(`${meta.name} token exchange failed`);
  const tokens = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  const connector = await ensureAccountingProviderConnector(parsed.organizationId, input.provider);
  await prisma.integrationConnector.update({
    where: { id: connector.id },
    data: {
      status: "connected",
      secretsJson: JSON.stringify({
        accessTokenEnc: tokens.access_token ? encryptField(tokens.access_token) : undefined,
        refreshTokenEnc: tokens.refresh_token ? encryptField(tokens.refresh_token) : undefined,
        expiresAt: tokens.expires_in
          ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
          : undefined,
        realmId: input.realmId || undefined,
      }),
    },
  });

  await writeAudit({
    organizationId: parsed.organizationId,
    actorType: "user",
    actorId: input.actorId,
    action: `connector.${input.provider}_connected`,
    entityType: "connector",
    entityId: connector.id,
  });

  return connector;
}

type StoredSecrets = {
  accessTokenEnc?: string;
  refreshTokenEnc?: string;
  expiresAt?: string;
  realmId?: string;
};

async function getAccessToken(organizationId: string, provider: Provider) {
  const meta = META[provider];
  const connector = await prisma.integrationConnector.findUniqueOrThrow({
    where: { organizationId_type: { organizationId, type: meta.type } },
  });
  const secrets = JSON.parse(connector.secretsJson || "{}") as StoredSecrets;
  if (!secrets.accessTokenEnc) throw new Error(`${meta.name} not connected`);
  return {
    connector,
    accessToken: decryptField(secrets.accessTokenEnc),
    realmId: secrets.realmId,
    secrets,
  };
}

/** Enterprise sync: pull open + paid bills. Uses provider APIs when connected; sandbox fixture when DEMO mode. */
export async function syncAccountingProvider(organizationId: string, provider: Provider) {
  const meta = META[provider];
  const connector = await prisma.integrationConnector.findUnique({
    where: { organizationId_type: { organizationId, type: meta.type } },
  });
  if (!connector || connector.status !== "connected") {
    return { ingested: 0, reconciled: 0, skipped: true as const };
  }

  let bills: AccountingBill[] = [];

  if (process.env[`${meta.envPrefix}_DEMO_SYNC`] === "true") {
    bills = [
      {
        externalId: `${provider}-demo-1`,
        invoiceNumber: `${provider.toUpperCase()}-1001`,
        vendorName: "Demo Vendor NG",
        totalAmount: 125_000,
        currency: "NGN",
        dueDate: new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10),
        status: "authorised",
      },
    ];
  } else if (isAccountingProviderConfigured(provider)) {
    bills = await fetchProviderBills(organizationId, provider);
  }

  let ingested = 0;
  let reconciled = 0;
  for (const bill of bills) {
    const r = await ingestAccountingBill({
      organizationId,
      provider,
      bill,
      sync: false,
    });
    if (r.created) ingested += 1;
    if (bill.status === "paid") {
      const pay = await reconcileAccountingPayment({ organizationId, provider, bill });
      if (pay.reconciled) reconciled += 1;
    }
  }

  await prisma.integrationConnector.update({
    where: { id: connector.id },
    data: { lastSyncAt: new Date() },
  });

  await writeAudit({
    organizationId,
    actorType: "system",
    action: `connector.${provider}_inbound_sync`,
    entityType: "connector",
    entityId: connector.id,
    metadata: { ingested, reconciled },
  });

  return { ingested, reconciled, skipped: false as const };
}

async function fetchProviderBills(organizationId: string, provider: Provider): Promise<AccountingBill[]> {
  const { accessToken, realmId } = await getAccessToken(organizationId, provider);

  if (provider === "qbo") {
    if (!realmId) throw new Error("QBO realmId missing — reconnect QuickBooks");
    const q = encodeURIComponent("select * from Bill maxresults 100");
    const res = await fetch(
      `https://quickbooks.api.intuit.com/v3/company/${realmId}/query?query=${q}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      },
    );
    if (!res.ok) throw new Error(`QBO query failed (${res.status})`);
    const data = (await res.json()) as {
      QueryResponse?: {
        Bill?: Array<{
          Id: string;
          DocNumber?: string;
          TotalAmt?: number;
          CurrencyRef?: { value?: string };
          DueDate?: string;
          TxnDate?: string;
          VendorRef?: { name?: string };
          Balance?: number;
        }>;
      };
    };
    return (data.QueryResponse?.Bill || []).map((b) => ({
      externalId: b.Id,
      invoiceNumber: b.DocNumber,
      vendorName: b.VendorRef?.name,
      totalAmount: b.TotalAmt,
      currency: b.CurrencyRef?.value || "NGN",
      dueDate: b.DueDate,
      invoiceDate: b.TxnDate,
      status: (b.Balance || 0) <= 0 ? "paid" : "authorised",
    }));
  }

  if (provider === "zoho") {
    const orgId = env("ZOHO", "ORGANIZATION_ID");
    const res = await fetch(
      `https://www.zohoapis.com/books/v3/bills?organization_id=${orgId}&status=open`,
      { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } },
    );
    if (!res.ok) throw new Error(`Zoho bills failed (${res.status})`);
    const data = (await res.json()) as {
      bills?: Array<{
        bill_id: string;
        bill_number?: string;
        total?: number;
        currency_code?: string;
        due_date?: string;
        date?: string;
        vendor_name?: string;
        status?: string;
      }>;
    };
    return (data.bills || []).map((b) => ({
      externalId: String(b.bill_id),
      invoiceNumber: b.bill_number,
      vendorName: b.vendor_name,
      totalAmount: b.total,
      currency: b.currency_code || "NGN",
      dueDate: b.due_date,
      invoiceDate: b.date,
      status: b.status === "paid" ? "paid" : "authorised",
    }));
  }

  // Sage Business Cloud Accounting
  const res = await fetch("https://api.accounting.sage.com/v3.1/purchase_invoices?items_per_page=100", {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Sage invoices failed (${res.status})`);
  const data = (await res.json()) as {
    $items?: Array<{
      id: string;
      displayed_as?: string;
      total_amount?: number | string;
      currency?: { currency_iso_code?: string };
      due_date?: string;
      date?: string;
      contact?: { displayed_as?: string };
      status?: { displayed_as?: string };
    }>;
  };
  return (data.$items || []).map((b) => ({
    externalId: b.id,
    invoiceNumber: b.displayed_as,
    vendorName: b.contact?.displayed_as,
    totalAmount: Number(b.total_amount || 0),
    currency: b.currency?.currency_iso_code || "NGN",
    dueDate: b.due_date,
    invoiceDate: b.date,
    status: /paid/i.test(b.status?.displayed_as || "") ? "paid" : "authorised",
  }));
}

export async function enqueueAccountingSync(organizationId: string, provider: Provider) {
  return enqueueJob({
    queue: "accounting-sync",
    name: "sync_provider",
    organizationId,
    payload: { organizationId, provider },
  });
}

export type { Provider as AccountingProvider };
