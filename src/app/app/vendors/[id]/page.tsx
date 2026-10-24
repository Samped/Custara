import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { AppShell } from "@/components/app/AppShell";
import { formatDate, formatMoney, statusBadgeClass } from "@/lib/format";
import { resolveDisplayCurrency } from "@/lib/currency";
import { invoiceOpenAmount, vendorAgedFromInvoices } from "@/domain/apLedger";
import { OPEN_INVOICE_STATUSES } from "@/domain/openInvoices";

export default async function VendorWorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireSessionUser(undefined, "vendors:read");
  } catch {
    redirect("/login");
  }
  const { id } = await params;
  const vendor = await prisma.vendor.findFirst({
    where: { id, organizationId: user.organizationId },
    include: {
      endpoints: { orderBy: { version: "desc" } },
      purchaseOrders: { where: { status: "open" }, orderBy: { createdAt: "desc" } },
      supplierPrices: { orderBy: { product: "asc" } },
      invoices: {
        orderBy: { createdAt: "desc" },
        take: 40,
        select: {
          id: true,
          invoiceNumber: true,
          status: true,
          totalAmount: true,
          residualAmount: true,
          currency: true,
          dueDate: true,
          externalId: true,
          paymentTerm: true,
        },
      },
    },
  });
  if (!vendor) notFound();
  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: user.organizationId },
    select: { displayCurrency: true, country: true },
  });
  const display = resolveDisplayCurrency(org);
  const bills = vendor.invoices.filter((i) => !i.externalId?.startsWith("odoo-refund:"));
  const credits = vendor.invoices.filter((i) => i.externalId?.startsWith("odoo-refund:"));
  const openBills = bills.filter((i) => (OPEN_INVOICE_STATUSES as readonly string[]).includes(i.status));
  const aged = vendorAgedFromInvoices(openBills, display);
  const activeArc = vendor.endpoints.find((e) => e.isActive && e.endpointType === "arc_usdc");
  const activeBank = vendor.endpoints.find((e) => e.isActive && e.endpointType === "bank");

  return (
    <AppShell user={user} title={vendor.name} subtitle="Vendor workspace">
      <div className="mb-4">
        <Link href="/app/vendors" className="text-sm font-medium text-accent hover:underline">
          ← Vendors
        </Link>
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <section className="card p-5">
          <h2 className="app-h">Partner</h2>
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            {[
              ["VAT / TIN", vendor.taxId],
              ["Payment terms", vendor.paymentTerm],
              ["Email", vendor.email],
              ["Address", vendor.address],
              ["Notes", vendor.notes],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-muted">{label}</dt>
                <dd className="mt-0.5 font-medium">{value || "—"}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 text-sm">
            Arc: {activeArc?.arcAddress || "—"}
            <br />
            Bank: {activeBank ? `${activeBank.accountName} · ••••${activeBank.accountNumberLast4}` : "—"}
          </p>
        </section>
        <section className="card p-5">
          <h2 className="app-h">Aged payable</h2>
          <p className="mt-2 text-2xl font-semibold">{formatMoney(aged.open, display)}</p>
          <ul className="mt-3 space-y-1 text-sm text-muted">
            <li>Current {formatMoney(aged.current, display)}</li>
            <li>1–30 {formatMoney(aged.d1_30, display)}</li>
            <li>31–60 {formatMoney(aged.d31_60, display)}</li>
            <li>61–90 {formatMoney(aged.d61_90, display)}</li>
            <li>90+ {formatMoney(aged.d90, display)}</li>
          </ul>
        </section>
      </div>
      <section className="card mt-5 p-5">
        <h2 className="app-h">Bills</h2>
        <ul className="mt-3 space-y-2 text-sm">
          {bills.map((inv) => (
            <li key={inv.id} className="flex justify-between gap-3">
              <Link href={`/app/invoices/${inv.id}`} className="text-accent hover:underline">
                {inv.invoiceNumber || inv.id.slice(0, 8)}
              </Link>
              <span>
                <span className={`badge ${statusBadgeClass(inv.status)}`}>{inv.status}</span>{" "}
                {formatMoney(invoiceOpenAmount(inv), inv.currency)}
                {inv.dueDate ? ` · due ${formatDate(inv.dueDate)}` : ""}
              </span>
            </li>
          ))}
          {!bills.length ? <li className="text-muted">No bills.</li> : null}
        </ul>
      </section>
      <section className="card mt-5 p-5">
        <h2 className="app-h">Credits</h2>
        <ul className="mt-3 space-y-2 text-sm">
          {credits.map((inv) => (
            <li key={inv.id}>
              <Link href={`/app/invoices/${inv.id}`} className="text-accent hover:underline">
                {inv.invoiceNumber || inv.externalId}
              </Link>{" "}
              · {formatMoney(invoiceOpenAmount(inv), inv.currency)} · {inv.status}
            </li>
          ))}
          {!credits.length ? <li className="text-muted">No vendor credits.</li> : null}
        </ul>
      </section>
      <section className="card mt-5 p-5">
        <h2 className="app-h">Purchase orders</h2>
        <ul className="mt-3 space-y-1 text-sm text-muted">
          {vendor.purchaseOrders.map((po) => (
            <li key={po.id}>
              {po.poNumber}
              {po.amount != null ? ` · ${formatMoney(po.amount, po.currency)}` : ""}
              {po.orderedQty != null ? ` · received ${po.receivedQty ?? 0} of ${po.orderedQty}` : ""}
            </li>
          ))}
        </ul>
      </section>
      {vendor.supplierPrices.length ? (
        <section className="card mt-5 p-5">
          <h2 className="app-h">Agreed prices</h2>
          <ul className="mt-3 space-y-1 text-sm text-muted">
            {vendor.supplierPrices.map((row) => (
              <li key={row.id}>
                {row.product} · max {formatMoney(row.maxUnitPrice, row.currency)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </AppShell>
  );
}
