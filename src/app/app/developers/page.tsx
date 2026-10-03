import Link from "next/link";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { readFile } from "fs/promises";
import path from "path";
import { revalidatePath } from "next/cache";
import { requireSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { AppShell } from "@/components/app/AppShell";
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
  const host = h.get("x-forwarded-host") || h.get("host") || "localhost:3000";
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

  let demoKeyNote: string | null = null;
  try {
    const creds = await readFile(path.join(process.cwd(), "storage", "DEMO_CREDENTIALS.txt"), "utf8");
    const match = creds.match(/API key: (cst_live_[a-f0-9]+)/);
    if (match) demoKeyNote = match[1];
  } catch {
    // ignore
  }

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

  const curlIngest = `curl -s ${baseUrl}/api/v1/invoices \\
  -H "Authorization: Bearer $CUSTARA_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: inv-$(date +%s)" \\
  -d '{
    "external_id": "erp-1001",
    "sync": true,
    "currency": "NGN",
    "document": {
      "invoice_number": "INV-1001",
      "vendor_name": "Acme Supplies",
      "total_amount": 250000,
      "currency": "NGN",
      "due_date": "2026-10-20"
    }
  }'`;

  const curlPay = `curl -s ${baseUrl}/api/v1/payment-intents \\
  -H "Authorization: Bearer $CUSTARA_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: pay-$(date +%s)" \\
  -d '{ "invoice_id": "INV_ID", "rail": "arc_usdc" }'`;

  const curlList = `curl -s "${baseUrl}/api/v1/invoices?limit=20" \\
  -H "Authorization: Bearer $CUSTARA_API_KEY"`;

  const curlBulk = `curl -s ${baseUrl}/api/v1/invoices/bulk \\
  -H "Authorization: Bearer $CUSTARA_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: bulk-$(date +%s)" \\
  -d '{ "sync": true, "csv": "vendor_name,invoice_number,total_amount,currency\\nAcme,INV-9,15000,NGN\\n" }'`;

  return (
    <AppShell
      user={user}
      title="API & guide"
      subtitle="Keys · webhooks · curl · OpenAPI"
    >
      {params.error ? <p className="mb-4 text-sm text-danger">{params.error}</p> : null}

      {revealedKey ? (
        <div className="card mb-5 border-[var(--accent)] p-5">
          <h2 className="app-h">Copy your API key now</h2>
          <p className="app-sub">Shown once. Store it in your secrets manager — Custara only keeps a hash.</p>
          <pre className="mt-3 overflow-x-auto rounded-xl bg-[#0f1c1f] p-4 text-xs text-teal-50">{revealedKey}</pre>
        </div>
      ) : null}

      {revealedWebhookSecret ? (
        <div className="card mb-5 border-[var(--accent)] p-5">
          <h2 className="app-h">Webhook signing secret</h2>
          <p className="app-sub">Verify `X-Custara-Signature` (HMAC-SHA256 of the raw body) with this secret.</p>
          <pre className="mt-3 overflow-x-auto rounded-xl bg-[#0f1c1f] p-4 text-xs text-teal-50">{revealedWebhookSecret}</pre>
        </div>
      ) : null}

      <section className="card mb-5 p-5">
        <h2 className="app-h">How companies integrate</h2>
        <ol className="mt-4 space-y-4 text-sm">
          <li className="flex gap-3">
            <span className="feature-index">01</span>
            <div>
              <p className="font-semibold">Create an API key</p>
              <p className="mt-1 text-muted">
                Scoped Bearer token for your backend. Never put keys in browsers or mobile apps.
              </p>
            </div>
          </li>
          <li className="flex gap-3">
            <span className="feature-index">02</span>
            <div>
              <p className="font-semibold">Push invoices from your system</p>
              <p className="mt-1 text-muted">
                `POST /api/v1/invoices` from ERP, billing, or mailbox workers. Custara extracts, scores risk, and
                routes by policy.
              </p>
            </div>
          </li>
          <li className="flex gap-3">
            <span className="feature-index">03</span>
            <div>
              <p className="font-semibold">Subscribe to webhooks</p>
              <p className="mt-1 text-muted">
                Receive approval and payment events on your HTTPS endpoint. Signature header: `X-Custara-Signature`.
              </p>
            </div>
          </li>
          <li className="flex gap-3">
            <span className="feature-index">04</span>
            <div>
              <p className="font-semibold">Connect ingest (ready now)</p>
              <p className="mt-1 text-muted">
                Ingest from email, PDF, or API — Custara parses amount, vendor, and due date, then runs
                risk.{" "}
                <Link href="/app/connectors" className="text-accent hover:underline">
                  Open connectors
                </Link>
                .
              </p>
            </div>
          </li>
        </ol>
        <div className="mt-5 flex flex-wrap gap-2">
          <a href="/api/openapi" className="btn btn-secondary" target="_blank" rel="noreferrer">
            OpenAPI JSON
          </a>
          <a href="/api/health" className="btn btn-secondary" target="_blank" rel="noreferrer">
            Health check
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
          {demoKeyNote ? (
            <p className="mt-4 text-[0.78rem] text-muted">
              Seeded demo key available in <code>storage/DEMO_CREDENTIALS.txt</code> (sandbox only).
            </p>
          ) : null}
        </section>

        <section className="card p-5">
          <h2 className="app-h">Register webhook</h2>
          <p className="app-sub">Your system receives POSTs when invoices move through Custara.</p>
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
        <h2 className="app-h">Dev guide · quickstart</h2>
        <p className="app-sub">
          Export your key, then call the Partner API. Prefer <code>Idempotency-Key</code> on every write.
        </p>
        <pre className="mt-4 overflow-x-auto rounded-xl bg-[#0f1c1f] p-4 text-xs text-teal-50">{`export CUSTARA_API_KEY="cst_live_…"
export CUSTARA_BASE="${baseUrl}"`}</pre>

        <h3 className="mt-5 text-sm font-semibold">1. List invoices</h3>
        <pre className="mt-2 overflow-x-auto rounded-xl bg-[#0f1c1f] p-4 text-xs text-teal-50">{curlList}</pre>

        <h3 className="mt-5 text-sm font-semibold">2. Ingest + analyze an invoice</h3>
        <pre className="mt-2 overflow-x-auto rounded-xl bg-[#0f1c1f] p-4 text-xs text-teal-50">{curlIngest}</pre>

        <h3 className="mt-5 text-sm font-semibold">2b. Bulk CSV ingest</h3>
        <pre className="mt-2 overflow-x-auto rounded-xl bg-[#0f1c1f] p-4 text-xs text-teal-50">{curlBulk}</pre>

        <h3 className="mt-5 text-sm font-semibold">3. Create a payment intent</h3>
        <pre className="mt-2 overflow-x-auto rounded-xl bg-[#0f1c1f] p-4 text-xs text-teal-50">{curlPay}</pre>

        <h3 className="mt-5 text-sm font-semibold">4. Verify webhook signatures</h3>
        <pre className="mt-2 overflow-x-auto rounded-xl bg-[#0f1c1f] p-4 text-xs text-teal-50">{`# Node
const crypto = require("crypto");
const expected = crypto.createHmac("sha256", process.env.CUSTARA_WEBHOOK_SECRET)
  .update(rawBody)
  .digest("hex");
// compare to header X-Custara-Signature`}</pre>

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
            <p className="mt-1 text-muted">`arc_usdc` (primary) · `nigeria_sandbox`</p>
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
