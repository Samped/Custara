import Link from "next/link";
import { redirect } from "next/navigation";
import { requireSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { AppShell } from "@/components/app/AppShell";
import { formatDate, formatMoney, statusBadgeClass } from "@/lib/format";
import { syncMailboxAction, uploadInvoiceAction } from "../actions";
import { ensureMailboxConnector } from "@/domain/mailbox";

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ bulk?: string; failed?: string; mailbox?: string }>;
}) {
  let user;
  try {
    user = await requireSessionUser(undefined, "inbox:read");
  } catch {
    redirect("/login");
  }

  const params = await searchParams;
  await ensureMailboxConnector(user.organizationId).catch(() => null);
  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: user.organizationId },
    select: { ingestEmail: true },
  });
  const mailbox = await prisma.integrationConnector.findUnique({
    where: {
      organizationId_type: { organizationId: user.organizationId, type: "mailbox_imap" },
    },
  });

  const invoices = await prisma.invoice.findMany({
    where: { organizationId: user.organizationId },
    include: { vendor: true, risks: true },
    orderBy: { createdAt: "desc" },
  });

  return (
    <AppShell user={user} title="Inbox" subtitle="Upload · CSV · email · API">
      <div className="dash">
        {params.bulk ? (
          <p className="dash-sub">
            Bulk ingest: {params.bulk} created
            {params.failed && Number(params.failed) > 0 ? ` · ${params.failed} failed` : ""}
          </p>
        ) : null}
        {params.mailbox === "synced" ? <p className="dash-sub">Mailbox sync finished</p> : null}

        <section className="dash-panel">
          <div className="dash-panel-head">
            <div>
              <p className="dash-kicker">Ingest</p>
              <h2 className="dash-h">Upload</h2>
              <p className="dash-sub">JSON, PDF, text, or CSV bulk</p>
            </div>
            <a href="/api/v1/invoices/csv-template" className="dash-link">
              CSV template
            </a>
          </div>
          <form action={uploadInvoiceAction} className="dash-upload mt-3">
            <input
              type="file"
              name="file"
              accept=".json,.txt,.pdf,.csv,.tsv,application/json,text/plain,text/csv"
              required
            />
            <button type="submit" className="btn btn-primary">
              Analyze
            </button>
          </form>
        </section>

        <section className="dash-panel">
          <div className="dash-panel-head">
            <div>
              <p className="dash-kicker">Email</p>
              <h2 className="dash-h">Mailbox</h2>
              <p className="dash-sub">
                Forward invoices to{" "}
                <span className="font-mono text-[0.72rem] text-foreground">
                  {org.ingestEmail || "configure ingest email"}
                </span>
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link href="/app/connectors" className="btn btn-secondary">
                Configure
              </Link>
              {mailbox?.status === "connected" ? (
                <form action={syncMailboxAction}>
                  <button type="submit" className="btn btn-secondary">
                    Sync now
                  </button>
                </form>
              ) : null}
            </div>
          </div>
          <p className="dash-mini-meta mt-2">
            Status: {mailbox?.status || "not set"} · attachments only (body discarded)
          </p>
        </section>

        <section className="dash-panel dash-panel-flush">
          <table className="table">
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Vendor</th>
                <th>Amount</th>
                <th>Due</th>
                <th>Status</th>
                <th>Source</th>
                <th>Risks</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((invoice) => (
                <tr key={invoice.id}>
                  <td>
                    <Link href={`/app/invoices/${invoice.id}`} className="dash-row-title">
                      {invoice.invoiceNumber || invoice.id.slice(0, 10)}
                    </Link>
                  </td>
                  <td>{invoice.vendor?.name || "—"}</td>
                  <td>{formatMoney(invoice.totalAmount, invoice.currency)}</td>
                  <td>{formatDate(invoice.dueDate)}</td>
                  <td>
                    <span className={`badge ${statusBadgeClass(invoice.status)}`}>{invoice.status}</span>
                  </td>
                  <td className="dash-mini-meta">{invoice.source}</td>
                  <td className="dash-mini-meta">
                    {invoice.risks.length ? invoice.risks.map((r) => r.code).join(", ") : "none"}
                  </td>
                </tr>
              ))}
              {invoices.length === 0 ? (
                <tr>
                  <td colSpan={7} className="dash-empty-cell">
                    No invoices yet
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </section>
      </div>
    </AppShell>
  );
}
