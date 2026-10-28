import { redirect } from "next/navigation";
import { headers } from "next/headers";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { requireSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { AppShell } from "@/components/app/AppShell";
import { CopyButton } from "@/components/app/CopyButton";
import { SettingsJsonForm } from "@/components/app/SettingsForms";
import {
  defaultIngestEmailForSlug,
  ensureMailboxConnector,
} from "@/domain/mailbox";
import {
  ensureSftpConnector,
  processLocalSftpDrop,
  pullRemoteSftpIfConfigured,
} from "@/domain/sftpIngest";
import { ensureOdooConnector, listOdooWritebackFailures } from "@/domain/connectors/odoo";
import { getArcChain } from "@/domain/arc/config";

export default async function ConnectorsPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    sftp?: string;
    mailbox?: string;
    odoo?: string;
    ingested?: string;
    vendors?: string;
  }>;
}) {
  let user;
  try {
    user = await requireSessionUser(["admin"], "connectors:read");
  } catch {
    redirect("/login");
  }

  const params = await searchParams;
  await ensureMailboxConnector(user.organizationId);
  const sftp = await ensureSftpConnector(user.organizationId);
  const odoo = await ensureOdooConnector(user.organizationId);
  const odooConfig = JSON.parse(odoo.configJson || "{}") as {
    origin?: string;
    database?: string;
    username?: string;
    lastError?: string | null;
    companyId?: number | null;
    journalId?: number | null;
    companies?: Array<{ id: number; name: string }>;
    truncated?: boolean;
    lastSyncSummary?: {
      vendors?: number;
      ingested?: number;
      customerInvoices?: number;
      truncated?: boolean;
    };
    webhookToken?: string | null;
  };
  const odooFailures = await listOdooWritebackFailures(user.organizationId);
  const odooSecrets = JSON.parse(odoo.secretsJson || "{}") as { apiKeyEnc?: string };

  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: user.organizationId },
  });
  const mailbox = await prisma.integrationConnector.findUnique({
    where: {
      organizationId_type: { organizationId: user.organizationId, type: "mailbox_imap" },
    },
  });
  const mailboxConfig = JSON.parse(mailbox?.configJson || "{}") as {
    host?: string;
    port?: number;
    secure?: boolean;
    user?: string;
    folder?: string;
  };
  const mailboxSecrets = JSON.parse(mailbox?.secretsJson || "{}") as { passwordEnc?: string };
  const ingestEmail = org.ingestEmail || defaultIngestEmailForSlug(org.slug);
  const sftpConfig = JSON.parse(sftp.configJson || "{}") as { localIncoming?: string };
  const incomingPath = sftpConfig.localIncoming || "";

  const h = await headers();
  const host = h.get("x-forwarded-host") || h.get("host") || "custara.xyz";
  const proto = h.get("x-forwarded-proto") || (host.includes("localhost") ? "http" : "https");
  const baseUrl = `${proto}://${host}`;

  const invoiceCurl = `curl -X POST '${baseUrl}/api/v1/invoices' \\
  -H 'Authorization: Bearer YOUR_API_KEY' \\
  -H 'Content-Type: application/json' \\
  -H 'Idempotency-Key: inv-$(date +%s)' \\
  -d '{
  "external_id": "erp-1001",
  "currency": "USDC",
  "document": {
    "vendor_name": "Acme Supplies",
    "invoice_number": "INV-1001",
    "total_amount": 25,
    "currency": "USDC",
    "due_date": "2026-10-31",
    "arc_address": "0x0000000000000000000000000000000000000000"
  }
}'`;

  const firsCurl = `curl -X POST '${baseUrl}/api/v1/einvoice/firs' \\
  -H 'Authorization: Bearer YOUR_API_KEY' \\
  -H 'Content-Type: application/json' \\
  -H 'Idempotency-Key: firs-$(date +%s)' \\
  -d '{
  "irn": "IRN-DEMO-001",
  "invoice_number": "FIRS-1001",
  "supplier": { "name": "Lagos Vendor Ltd", "tin": "12345678-0001" },
  "currency": "NGN",
  "total_amount": 180000,
  "issue_date": "2026-10-01",
  "due_date": "2026-10-21"
}'`;

  async function processDrop() {
    "use server";
    const session = await requireSessionUser(["admin"], "connectors:write");
    try {
      await pullRemoteSftpIfConfigured(session.organizationId);
      await processLocalSftpDrop(session.organizationId);
    } catch (e) {
      redirect(
        `/app/connectors?error=${encodeURIComponent(e instanceof Error ? e.message : "Process failed")}`,
      );
    }
    revalidatePath("/app/connectors");
    revalidatePath("/app/inbox");
    redirect("/app/connectors?sftp=synced");
  }

  return (
    <AppShell user={user} title="Connectors">
      {params.error ? <p className="mb-4 text-sm text-danger">{params.error}</p> : null}
      {params.sftp === "synced" ? (
        <p className="mb-4 text-sm text-accent">Drop folder processed.</p>
      ) : null}
      {params.mailbox === "saved" ? (
        <p className="mb-4 text-sm text-accent">Mailbox connected. Polling uses the saved IMAP settings.</p>
      ) : null}
      {params.odoo === "synced" ? (
        <p className="mb-4 text-sm text-accent">
          Odoo sync finished
          {params.ingested ? ` · ${params.ingested} new bills` : ""}
          {params.vendors ? ` · ${params.vendors} vendors` : ""}.
        </p>
      ) : null}
      {params.odoo === "connected" ? (
        <p className="mb-4 text-sm text-accent">Odoo connected. Run Sync if the first pull did not finish.</p>
      ) : null}
      {params.odoo === "disconnected" ? (
        <p className="mb-4 text-sm text-accent">Odoo disconnected. The API key was removed.</p>
      ) : null}
      {params.odoo === "retry" ? (
        <p className="mb-4 text-sm text-accent">Retrying failed Odoo write-backs.</p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="dash-panel">
          <h2 className="dash-h">Email ingest</h2>
          <p className="mt-3 break-all font-mono text-[0.85rem] text-foreground">{ingestEmail}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <CopyButton value={ingestEmail} label="Copy address" />
          </div>
          <p className="mt-3 text-[0.72rem] text-muted">
            Webhook: <code>POST /api/ingest/mailbox</code>
            {mailbox?.status === "connected" ? " · IMAP connected" : " · IMAP not connected"}
            {mailboxSecrets.passwordEnc ? " · password on file" : ""}
          </p>
          <SettingsJsonForm action="save_mailbox" className="mt-4 grid gap-3">
            <label className="text-sm">
              IMAP host
              <input name="host" className="input mt-1" defaultValue={mailboxConfig.host || ""} required />
            </label>
            <label className="text-sm">
              User
              <input name="user" className="input mt-1" defaultValue={mailboxConfig.user || ""} required />
            </label>
            <label className="text-sm">
              App password
              <input
                name="password"
                type="password"
                autoComplete="new-password"
                className="input mt-1"
                placeholder={mailboxSecrets.passwordEnc ? "Leave blank to keep the saved password" : ""}
                required={!mailboxSecrets.passwordEnc}
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-sm">
                Port
                <input
                  name="port"
                  type="number"
                  className="input mt-1"
                  defaultValue={mailboxConfig.port || 993}
                />
              </label>
              <label className="text-sm">
                Folder
                <input name="folder" className="input mt-1" defaultValue={mailboxConfig.folder || "INBOX"} />
              </label>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input name="secure" type="checkbox" defaultChecked={mailboxConfig.secure !== false} />
              TLS
            </label>
            <button type="submit" className="btn btn-primary w-fit">
              Save mailbox
            </button>
          </SettingsJsonForm>
        </section>

        <section className="dash-panel">
          <h2 className="dash-h">Odoo</h2>
          <p className="mt-3 text-[0.78rem] text-muted">
            Odoo stays the ledger. Custara is approvals, risk, and Arc{" "}
            <strong>{getArcChain() === "ARC" ? "mainnet" : "testnet"}</strong> USDC settlement. Dual
            control and payment MFA live under Controls and Security.
          </p>
          <p className="mt-2 text-[0.72rem] text-muted">
            {odoo.status === "connected" && odooConfig.origin
              ? `Connected to ${odooConfig.origin.replace(/^https?:\/\//, "")} as ${odooConfig.username || user.email}`
              : "Disconnected"}
            {odoo.lastSyncAt ? ` · last sync ${odoo.lastSyncAt.toISOString().slice(0, 16).replace("T", " ")} UTC` : ""}
            {odooConfig.lastSyncSummary
              ? ` · ${odooConfig.lastSyncSummary.ingested || 0} bills / ${odooConfig.lastSyncSummary.vendors || 0} vendors`
              : ""}
          </p>
          <p className="mt-2 text-[0.72rem] text-muted">
            Posted vendor bills appear in Inbox within a minute. You do not need to click Sync.
          </p>
          {(odooConfig.lastSyncSummary?.ingested || 0) === 0 &&
          (odooConfig.lastSyncSummary?.customerInvoices || 0) > 0 ? (
            <p className="mt-2 text-[0.72rem] text-warn">
              Odoo has {odooConfig.lastSyncSummary?.customerInvoices} customer invoice
              {(odooConfig.lastSyncSummary?.customerInvoices || 0) === 1 ? "" : "s"} (INV/…). Those are
              money owed to you. Create a vendor bill under Accounting → Vendors → Bills to pay a
              supplier.
            </p>
          ) : null}
          {odooConfig.truncated ? (
            <p className="mt-2 text-[0.72rem] text-warn">
              Last sync hit the record cap. Older Odoo rows were skipped — use Sync now after the first
              pull, or raise the cap in a follow-up.
            </p>
          ) : null}
          {odooConfig.lastError ? (
            <p className="mt-2 text-[0.72rem] text-danger">{odooConfig.lastError}</p>
          ) : null}
          <SettingsJsonForm action="save_odoo" busyLabel="Connecting…" className="mt-4 grid gap-3">
            <label className="text-sm">
              Database URL
              <input
                name="url"
                type="url"
                inputMode="url"
                autoComplete="url"
                className="input mt-1"
                placeholder="https://your-company.odoo.com"
                defaultValue={odooConfig.origin || ""}
                required
              />
              <span className="mt-1 block text-[0.72rem] text-muted">
                Copy this from the address bar on Discuss or Accounting. Example: https://acme.odoo.com
              </span>
            </label>
            <label className="text-sm">
              Odoo user email
              <input
                name="username"
                type="email"
                className="input mt-1"
                placeholder={user.email}
                defaultValue={odooConfig.username || ""}
              />
            </label>
            {odooConfig.companies && odooConfig.companies.length > 1 ? (
              <label className="text-sm">
                Company
                <select name="companyId" className="input mt-1" defaultValue={odooConfig.companyId || ""}>
                  <option value="">Default company</option>
                  {odooConfig.companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className="text-sm">
              Payment journal id
              <input
                name="journalId"
                className="input mt-1"
                placeholder="Odoo Bank journal id"
                defaultValue={odooConfig.journalId || ""}
              />
            </label>
            <label className="text-sm">
              API key
              <input
                name="apiKey"
                type="password"
                autoComplete="new-password"
                className="input mt-1"
                placeholder={odooSecrets.apiKeyEnc ? "Leave blank to keep the saved key" : "Odoo API key"}
                required={!odooSecrets.apiKeyEnc}
              />
            </label>
            <button type="submit" className="btn btn-primary w-fit">
              Connect
            </button>
          </SettingsJsonForm>
          {odoo.status === "connected" || odoo.status === "error" ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <SettingsJsonForm action="sync_odoo" busyLabel="Syncing…">
                <button type="submit" className="btn btn-secondary w-fit">
                  Sync now
                </button>
              </SettingsJsonForm>
              <SettingsJsonForm action="retry_odoo_writebacks" busyLabel="Retrying…">
                <button type="submit" className="btn btn-secondary w-fit">
                  Retry failed write-backs
                </button>
              </SettingsJsonForm>
              <SettingsJsonForm action="disconnect_odoo" busyLabel="Disconnecting…">
                <button type="submit" className="btn btn-secondary w-fit">
                  Disconnect
                </button>
              </SettingsJsonForm>
            </div>
          ) : null}
          {odooFailures.length ? (
            <div className="mt-4 rounded-xl border border-line px-3 py-2">
              <p className="text-[0.72rem] font-medium">Failed Odoo write-backs</p>
              {odooFailures.map((row) => (
                <p key={row.id} className="mt-1 text-[0.7rem] text-muted">
                  {row.createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC · {row.error}
                </p>
              ))}
            </div>
          ) : null}
        </section>

        <section className="dash-panel">
          <h2 className="dash-h">Vendor portal</h2>
          <div className="mt-4">
            <Link href="/app/vendors?tab=portal" className="btn btn-primary">
              Manage invites
            </Link>
          </div>
        </section>

        <section className="dash-panel lg:col-span-2">
          <h2 className="dash-h">API</h2>
          <pre className="mt-4 overflow-x-auto rounded-xl bg-[#f7fafb] p-3 text-[0.72rem] text-muted">
            {invoiceCurl}
          </pre>
          <div className="mt-4 flex flex-wrap gap-2">
            <CopyButton value={invoiceCurl} label="Copy curl" />
            <Link href="/app/developers" className="btn btn-primary">
              API keys
            </Link>
          </div>
        </section>

        <section className="dash-panel lg:col-span-2">
          <h2 className="dash-h">FIRS</h2>
          <pre className="mt-4 overflow-x-auto rounded-xl bg-[#f7fafb] p-3 text-[0.72rem] text-muted">
            {firsCurl}
          </pre>
          <div className="mt-4 flex flex-wrap gap-2">
            <CopyButton value={firsCurl} label="Copy curl" />
          </div>
        </section>

        <section className="dash-panel lg:col-span-2">
          <h2 className="dash-h">File drop</h2>
          <p className="mt-3 break-all font-mono text-[0.78rem] text-foreground">
            {incomingPath || "—"}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {incomingPath ? <CopyButton value={incomingPath} label="Copy path" /> : null}
            <form action={processDrop}>
              <button type="submit" className="btn btn-primary">
                Process
              </button>
            </form>
          </div>
        </section>
      </div>
    </AppShell>
  );
}
