import { redirect } from "next/navigation";
import { headers } from "next/headers";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { requireSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { AppShell } from "@/components/app/AppShell";
import { CopyButton } from "@/components/app/CopyButton";
import {
  defaultIngestEmailForSlug,
  ensureMailboxConnector,
} from "@/domain/mailbox";
import {
  ensureSftpConnector,
  processLocalSftpDrop,
  pullRemoteSftpIfConfigured,
} from "@/domain/sftpIngest";

export default async function ConnectorsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; sftp?: string }>;
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

  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: user.organizationId },
  });
  const ingestEmail = org.ingestEmail || defaultIngestEmailForSlug(org.slug);
  const sftpConfig = JSON.parse(sftp.configJson || "{}") as { localIncoming?: string };
  const incomingPath = sftpConfig.localIncoming || "";

  const h = await headers();
  const host = h.get("x-forwarded-host") || h.get("host") || "localhost:3000";
  const proto = h.get("x-forwarded-proto") || "http";
  const baseUrl = `${proto}://${host}`;

  const invoiceCurl = `curl -X POST '${baseUrl}/api/v1/invoices' \\
  -H 'Authorization: Bearer YOUR_API_KEY' \\
  -H 'Content-Type: application/json' \\
  -H 'Idempotency-Key: inv-$(date +%s)' \\
  -d '{
  "external_id": "erp-1001",
  "currency": "NGN",
  "document": {
    "vendor_name": "Acme Supplies",
    "invoice_number": "INV-1001",
    "total_amount": 250000,
    "due_date": "2026-10-31"
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

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="dash-panel">
          <h2 className="dash-h">Email ingest</h2>
          <p className="mt-3 break-all font-mono text-[0.85rem] text-foreground">{ingestEmail}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <CopyButton value={ingestEmail} label="Copy address" />
          </div>
          <p className="mt-3 text-[0.72rem] text-muted">
            Webhook: <code>POST /api/ingest/mailbox</code>
          </p>
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
