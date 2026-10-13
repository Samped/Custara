import Link from "next/link";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { AppShell } from "@/components/app/AppShell";
import { CopyButton } from "@/components/app/CopyButton";
import { replayWebhookDelivery } from "@/lib/webhooks";
import {
  PARTNER_API_SCOPES,
  WEBHOOK_EVENT_OPTIONS,
  createPartnerApiKey,
  createPartnerWebhook,
  revokePartnerApiKey,
  setPartnerWebhookActive,
} from "@/domain/partnerApi";
import { formatDate } from "@/lib/format";
import { getArcChain, getArcExecutionMode, getUsdcTokenAddress } from "@/domain/arc/config";

function CodeSample({ value }: { value: string }) {
  return (
    <div className="code-sample">
      <div className="code-sample-bar">
        <CopyButton value={value} label="Copy" className="btn code-sample-copy" />
      </div>
      <pre>{value}</pre>
    </div>
  );
}

const ONCE_COOKIE = "custara_new_api_key";
const WEBHOOK_SECRET_COOKIE = "custara_new_webhook_secret";

export default async function DevelopersPage({
  searchParams,
}: {
  searchParams: Promise<{ created?: string; webhook?: string; error?: string }>;
}) {
  let user;
  try {
    user = await requireSessionUser(["admin"], "developers:read");
  } catch {
    redirect("/login");
  }

  const params = await searchParams;
  const cookieStore = await cookies();
  const revealedKey = cookieStore.get(ONCE_COOKIE)?.value || null;
  const revealedWebhookSecret = cookieStore.get(WEBHOOK_SECRET_COOKIE)?.value || null;

  const h = await headers();
  const host = h.get("x-forwarded-host") || h.get("host") || "custara.xyz";
  const proto = h.get("x-forwarded-proto") || (host.includes("localhost") ? "http" : "https");
  const baseUrl = `${proto}://${host}`;

  const [keys, webhooks, deliveries] = await Promise.all([
    prisma.apiKey.findMany({
      where: { organizationId: user.organizationId },
      orderBy: { createdAt: "desc" },
    }),
    prisma.webhookEndpoint.findMany({
      where: { organizationId: user.organizationId },
      orderBy: { createdAt: "desc" },
    }),
    prisma.webhookDelivery.findMany({
      where: {
        endpoint: { organizationId: user.organizationId },
        OR: [{ deadLetteredAt: { not: null } }, { success: false }],
      },
      orderBy: { createdAt: "desc" },
      take: 30,
      include: { endpoint: true },
    }),
  ]);

  async function createKey(formData: FormData) {
    "use server";
    const session = await requireSessionUser(["admin"], "developers:read");
    const scopes = formData.getAll("scope").map(String);
    try {
      const { raw } = await createPartnerApiKey({
        organizationId: session.organizationId,
        actorId: session.id,
        name: String(formData.get("name") || "Partner API key"),
        scopes,
      });
      const jar = await cookies();
      jar.set(ONCE_COOKIE, raw, { httpOnly: true, sameSite: "lax", maxAge: 120, path: "/" });
    } catch (e) {
      redirect(`/app/developers?error=${encodeURIComponent(e instanceof Error ? e.message : "Failed")}`);
    }
    revalidatePath("/app/developers");
    redirect("/app/developers?created=1");
  }

  async function revokeKey(formData: FormData) {
    "use server";
    const session = await requireSessionUser(["admin"], "developers:read");
    await revokePartnerApiKey({
      organizationId: session.organizationId,
      actorId: session.id,
      apiKeyId: String(formData.get("apiKeyId") || ""),
    });
    revalidatePath("/app/developers");
  }

  async function createWebhook(formData: FormData) {
    "use server";
    const session = await requireSessionUser(["admin"], "developers:read");
    try {
      const { secret } = await createPartnerWebhook({
        organizationId: session.organizationId,
        actorId: session.id,
        url: String(formData.get("url") || ""),
        events: formData.getAll("event").map(String),
      });
      const jar = await cookies();
      jar.set(WEBHOOK_SECRET_COOKIE, secret, { httpOnly: true, sameSite: "lax", maxAge: 120, path: "/" });
    } catch (e) {
      redirect(`/app/developers?error=${encodeURIComponent(e instanceof Error ? e.message : "Failed")}`);
    }
    revalidatePath("/app/developers");
    redirect("/app/developers?webhook=1");
  }

  async function toggleWebhook(formData: FormData) {
    "use server";
    const session = await requireSessionUser(["admin"], "developers:read");
    await setPartnerWebhookActive({
      organizationId: session.organizationId,
      actorId: session.id,
      endpointId: String(formData.get("endpointId") || ""),
      isActive: String(formData.get("isActive") || "") === "true",
    });
    revalidatePath("/app/developers");
  }

  async function replay(formData: FormData) {
    "use server";
    const session = await requireSessionUser(["admin"], "developers:read");
    await replayWebhookDelivery(String(formData.get("deliveryId") || ""), session.organizationId);
    revalidatePath("/app/developers");
  }

  const arcMode = getArcExecutionMode(user.paymentMode);
  const arcChain = getArcChain();
  const usdcToken = arcChain === "ARC-TESTNET" ? getUsdcTokenAddress() : null;
  const settlementLabel =
    arcMode === "testnet"
      ? `Arc testnet USDC (${arcChain})`
      : arcMode === "mainnet"
        ? "Arc mainnet USDC"
        : arcMode === "simulated"
          ? "Simulated"
          : "Blocked until Payment mode is Arc testnet";

  const curlAllow = `curl -s ${baseUrl}/api/v1/vendors \\
  -H "Authorization: Bearer $CUSTARA_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "Acme Supplies",
    "arc_address": "0xVENDOR_WALLET",
    "currency": "USDC"
  }'`;

  const curlIngest = `STAMP=$(date +%s)
curl -s ${baseUrl}/api/v1/invoices \\
  -H "Authorization: Bearer $CUSTARA_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: inv-$STAMP" \\
  -d '{
    "external_id": "erp-'"$STAMP"'",
    "sync": true,
    "currency": "USDC",
    "document": {
      "invoice_number": "INV-'"$STAMP"'",
      "vendor_name": "Acme Supplies",
      "total_amount": 25,
      "currency": "USDC",
      "due_date": "2026-10-20",
      "po_number": "PO-1001",
      "arc_address": "0xVENDOR_WALLET",
      "confidence": 0.95
    }
  }'`;

  const curlAnalysis = `curl -s ${baseUrl}/api/v1/invoices/$INVOICE_ID/analysis \\
  -H "Authorization: Bearer $CUSTARA_API_KEY"`;

  const curlApprove = `curl -s ${baseUrl}/api/v1/approvals/$APPROVAL_ID/decide \\
  -H "Authorization: Bearer $CUSTARA_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "decision": "approved", "note": "ok" }'`;

  const curlPay = `curl -s ${baseUrl}/api/v1/payment-intents \\
  -H "Authorization: Bearer $CUSTARA_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: pay-$(date +%s)" \\
  -d '{ "invoice_id": "'"$INVOICE_ID"'", "rail": "arc_usdc" }'`;

  const curlList = `curl -s "${baseUrl}/api/v1/invoices?limit=20" \\
  -H "Authorization: Bearer $CUSTARA_API_KEY"`;

  const curlBulk = `curl -s ${baseUrl}/api/v1/invoices/bulk \\
  -H "Authorization: Bearer $CUSTARA_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: bulk-$(date +%s)" \\
  -d '{ "sync": true, "csv": "vendor_name,invoice_number,total_amount,currency\\nAcme,INV-9,25,USDC\\n" }'`;

  return (
    <AppShell user={user} title="API">
      {params.error ? <p className="mb-4 text-sm text-danger">{params.error}</p> : null}

      {revealedKey ? (
        <div className="card mb-5 border-[var(--accent)] p-5">
          <h2 className="app-h">API key</h2>
          <p className="app-sub">Shown once. Store securely; only a hash is retained.</p>
          <CodeSample value={revealedKey} />
        </div>
      ) : null}

      {revealedWebhookSecret ? (
        <div className="card mb-5 border-[var(--accent)] p-5">
          <h2 className="app-h">Webhook secret</h2>
          <p className="app-sub">HMAC-SHA256 via `X-Custara-Signature`.</p>
          <CodeSample value={revealedWebhookSecret} />
        </div>
      ) : null}

      <section className="card mb-5 p-5">
        <h2 className="app-h">Resources</h2>
        <div className="mt-4 flex flex-wrap gap-2">
          <a href="/api/openapi" className="btn btn-secondary" target="_blank" rel="noreferrer">
            OpenAPI
          </a>
          <a href="/api/health" className="btn btn-secondary" target="_blank" rel="noreferrer">
            Health
          </a>
          <Link href="/app/connectors" className="btn btn-secondary">
            Connectors
          </Link>
        </div>
      </section>

      <div className="mb-5 grid gap-5 lg:grid-cols-2">
        <section className="card p-5">
          <h2 className="app-h">Create API key</h2>
          <p className="app-sub">Base URL for this workspace: <code className="text-[0.78rem]">{baseUrl}</code></p>
          <form action={createKey} className="mt-4 space-y-4">
            <div>
              <label className="mb-1.5 block text-[0.78rem] font-semibold" htmlFor="keyName">
                Key name
              </label>
              <input id="keyName" name="name" className="input" placeholder="ERP production" required />
            </div>
            <fieldset>
              <legend className="mb-2 text-[0.78rem] font-semibold">Scopes</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {PARTNER_API_SCOPES.map((scope) => (
                  <label key={scope} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name="scope" value={scope} defaultChecked />
                    <span className="font-mono text-[0.78rem]">{scope}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <button type="submit" className="btn btn-primary">
              Generate key
            </button>
          </form>
          <p className="mt-4 text-[0.78rem] text-muted">
            Settlement for this workspace: <span className="font-medium text-foreground">{settlementLabel}</span>
            {usdcToken ? (
              <>
                {" "}
                · token <code className="text-[0.72rem]">{usdcToken}</code>
              </>
            ) : null}
            . Webhooks for <code>payment.sent</code> carry the Arc testnet transfer when this mode is on.
          </p>
        </section>

        <section className="card p-5">
          <h2 className="app-h">Register webhook</h2>
          <form action={createWebhook} className="mt-4 space-y-4">
            <div>
              <label className="mb-1.5 block text-[0.78rem] font-semibold" htmlFor="whUrl">
                HTTPS endpoint URL
              </label>
              <input
                id="whUrl"
                name="url"
                className="input"
                placeholder="https://api.yourcompany.com/hooks/custara"
                required
              />
            </div>
            <fieldset>
              <legend className="mb-2 text-[0.78rem] font-semibold">Events</legend>
              <div className="grid gap-2">
                {WEBHOOK_EVENT_OPTIONS.map((ev) => (
                  <label key={ev.value} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name="event" value={ev.value} defaultChecked={ev.value === "*"} />
                    <span>{ev.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <button type="submit" className="btn btn-primary">
              Add webhook
            </button>
          </form>
        </section>
      </div>

      <section className="card mb-5 overflow-hidden">
        <div className="border-b border-[var(--line)] px-5 py-4">
          <h2 className="app-h">API keys</h2>
        </div>
        <ul className="divide-y divide-[var(--line)]">
          {keys.map((key) => {
            const scopes = (() => {
              try {
                return JSON.parse(key.scopesJson) as string[];
              } catch {
                return [];
              }
            })();
            return (
              <li key={key.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5 text-sm">
                <div>
                  <p className="font-medium">
                    {key.name}{" "}
                    <span className="font-mono text-[0.78rem] text-muted">{key.keyPrefix}…</span>
                  </p>
                  <p className="mt-1 text-[0.78rem] text-muted">
                    {key.revokedAt ? "Revoked" : "Active"}
                    {key.lastUsedAt ? ` · last used ${formatDate(key.lastUsedAt)}` : " · never used"}
                    {" · "}
                    {scopes.join(", ") || "no scopes"}
                  </p>
                </div>
                {!key.revokedAt ? (
                  <form action={revokeKey}>
                    <input type="hidden" name="apiKeyId" value={key.id} />
                    <button type="submit" className="btn btn-secondary h-9 px-3 text-xs">
                      Revoke
                    </button>
                  </form>
                ) : (
                  <span className="badge bg-red-50 text-danger">revoked</span>
                )}
              </li>
            );
          })}
          {keys.length === 0 ? <li className="px-5 py-8 text-sm text-muted">No API keys yet.</li> : null}
        </ul>
      </section>

      <section className="card mb-5 overflow-hidden">
        <div className="border-b border-[var(--line)] px-5 py-4">
          <h2 className="app-h">Webhooks</h2>
        </div>
        <ul className="divide-y divide-[var(--line)]">
          {webhooks.map((wh) => (
            <li key={wh.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5 text-sm">
              <div className="min-w-0">
                <p className="truncate font-medium">{wh.url}</p>
                <p className="mt-1 text-[0.78rem] text-muted">Events: {wh.eventsJson}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className={`badge ${wh.isActive ? "bg-accent-soft text-accent" : "bg-slate-100 text-muted"}`}>
                  {wh.isActive ? "active" : "inactive"}
                </span>
                <form action={toggleWebhook}>
                  <input type="hidden" name="endpointId" value={wh.id} />
                  <input type="hidden" name="isActive" value={wh.isActive ? "false" : "true"} />
                  <button type="submit" className="btn btn-secondary h-9 px-3 text-xs">
                    {wh.isActive ? "Disable" : "Enable"}
                  </button>
                </form>
              </div>
            </li>
          ))}
          {webhooks.length === 0 ? <li className="px-5 py-8 text-sm text-muted">No webhooks registered.</li> : null}
        </ul>
      </section>

      <section className="card mb-5 p-5">
        <h2 className="app-h">Quickstart</h2>
        <p className="app-sub mt-2">
          Allow the vendor wallet, create the bill, approve it, then pay. Use the same vendor name and the same
          0x address in steps 1 and 2. Replace 0xVENDOR_WALLET before you send either call.
        </p>
        <CodeSample
          value={`export CUSTARA_API_KEY="cst_live_…"
export CUSTARA_BASE="${baseUrl}"`}
        />

        <h3 className="mt-5 text-sm font-semibold">1. Allow a wallet address</h3>
        <p className="mt-1 text-[0.78rem] text-muted">
          Needs <code>invoices:write</code>. This creates the vendor and puts the address on the allowlist.
        </p>
        <CodeSample value={curlAllow} />

        <h3 className="mt-5 text-sm font-semibold">2. Create and analyze an invoice</h3>
        <p className="mt-1 text-[0.78rem] text-muted">
          Save <code>id</code> from the response. Each run uses a new <code>external_id</code> and invoice number from <code>STAMP</code>.
          Sending an <code>external_id</code> that already exists returns <code>409</code> and that invoice's <code>id</code>.
          If <code>status</code> is already <code>approved</code>, skip step 3.
        </p>
        <CodeSample value={curlIngest} />

        <h3 className="mt-5 text-sm font-semibold">3. Approve the invoice</h3>
        <p className="mt-1 text-[0.78rem] text-muted">
          Export <code>INVOICE_ID</code> from step 2, then run the analysis call. It needs <code>approvals:write</code> for the decide call.
          Export <code>APPROVAL_ID</code> from <code>policy_result.latest_approval.id</code>.
          When <code>required_count</code> is 2, send the decide call a second time.
        </p>
        <CodeSample value={curlAnalysis} />
        <CodeSample value={curlApprove} />

        <h3 className="mt-5 text-sm font-semibold">4. List invoices</h3>
        <p className="mt-1 text-[0.78rem] text-muted">
          The pay call uses <code>id</code> from <code>data</code>, not the invoice number.
        </p>
        <CodeSample value={curlList} />

        <h3 className="mt-5 text-sm font-semibold">5. Pay the invoice</h3>
        <p className="mt-1 text-[0.78rem] text-muted">
          Needs <code>payments:initiate</code> and the same <code>INVOICE_ID</code>. <code>mode</code> is <code>live</code> when this workspace settles on
          Arc. If the response asks for <code>X-Custara-Step-Up</code>, add that header with your step-up secret.
        </p>
        <CodeSample value={curlPay} />

        <h3 className="mt-5 text-sm font-semibold">6. Bulk CSV ingest</h3>
        <CodeSample value={curlBulk} />

        <h3 className="mt-5 text-sm font-semibold">7. Verify webhook signatures</h3>
        <CodeSample
          value={`# Node
const crypto = require("crypto");
const expected = crypto.createHmac("sha256", process.env.CUSTARA_WEBHOOK_SECRET)
  .update(rawBody)
  .digest("hex");
// compare to header X-Custara-Signature`}
        />

        <div className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
          <div className="rounded-xl border border-[var(--line)] p-4">
            <p className="font-semibold">Auth</p>
            <p className="mt-1 text-muted">`Authorization: Bearer cst_live_…`</p>
          </div>
          <div className="rounded-xl border border-[var(--line)] p-4">
            <p className="font-semibold">Idempotency</p>
            <p className="mt-1 text-muted">`Idempotency-Key` on POST payment / ingest writes</p>
          </div>
          <div className="rounded-xl border border-[var(--line)] p-4">
            <p className="font-semibold">Rails</p>
            <p className="mt-1 text-muted">`arc_usdc` on {arcChain}. Nigeria sandbox is export-only.</p>
          </div>
          <div className="rounded-xl border border-[var(--line)] p-4">
            <p className="font-semibold">Spec</p>
            <p className="mt-1 text-muted">
              <a href="/api/openapi" className="text-accent hover:underline" target="_blank" rel="noreferrer">
                /api/openapi
              </a>
            </p>
          </div>
        </div>
      </section>

      <section className="card p-5">
        <h2 className="app-h">Failed / DLQ deliveries</h2>
        <ul className="mt-3 space-y-2 text-sm">
          {deliveries.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--line)] py-2">
              <div>
                <p>
                  {d.event} · attempts {d.attempts}
                  {d.deadLetteredAt ? " · DLQ" : ""}
                </p>
                <p className="text-muted">{d.lastError || d.statusCode || "—"}</p>
              </div>
              <form action={replay}>
                <input type="hidden" name="deliveryId" value={d.id} />
                <button type="submit" className="btn btn-secondary h-9 px-3 text-xs">
                  Replay
                </button>
              </form>
            </li>
          ))}
          {deliveries.length === 0 ? <li className="text-muted">No failed deliveries.</li> : null}
        </ul>
      </section>
    </AppShell>
  );
}
