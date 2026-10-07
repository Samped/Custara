import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { AppShell } from "@/components/app/AppShell";
import { SectionTabs } from "@/components/app/SectionTabs";
import { VendorPortalPanel } from "@/components/app/VendorPortalPanel";
import { formatDate, formatMoney } from "@/lib/format";
import { addDestination } from "@/domain/arc/allowlist";
import { writeAudit } from "@/lib/audit";
import { encryptField, last4 } from "@/lib/crypto";
import { upsertVendorPurchaseOrder } from "@/domain/contracts";

export default async function VendorsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; created?: string; error?: string; link?: string }>;
}) {
  let user;
  try {
    user = await requireSessionUser(undefined, "vendors:read");
  } catch {
    redirect("/login");
  }

  const params = await searchParams;
  const tab = params.tab === "portal" ? "portal" : "directory";
  const tabs = [
    { id: "directory", label: "Directory", href: "/app/vendors" },
    { id: "portal", label: "Portal", href: "/app/vendors?tab=portal" },
  ];

  if (tab === "portal") {
    try {
      await requireSessionUser(["admin"], "connectors:write");
    } catch {
      redirect("/app/vendors");
    }
    return (
      <AppShell user={user} title="Vendors">
        <SectionTabs tabs={tabs} active="portal" />
        <VendorPortalPanel
          organizationId={user.organizationId}
          params={{ created: params.created, error: params.error, link: params.link }}
        />
      </AppShell>
    );
  }

  const vendors = await prisma.vendor.findMany({
    where: { organizationId: user.organizationId },
    include: {
      endpoints: { orderBy: { version: "desc" } },
      purchaseOrders: {
        where: { status: "open" },
        orderBy: { createdAt: "desc" },
        take: 20,
      },
    },
    orderBy: { name: "asc" },
  });

  async function addArcEndpoint(formData: FormData) {
    "use server";
    const session = await requireSessionUser(["admin", "payer"]);
    const vendorId = String(formData.get("vendorId") || "");
    const arcAddress = String(formData.get("arcAddress") || "").toLowerCase();
    const vendor = await prisma.vendor.findFirst({
      where: { id: vendorId, organizationId: session.organizationId },
      include: { endpoints: { orderBy: { version: "desc" }, take: 1 } },
    });
    if (!vendor) throw new Error("Vendor not found");
    if (!/^0x[a-f0-9]{40}$/.test(arcAddress)) throw new Error("Invalid Arc address");

    await prisma.vendorPaymentEndpoint.updateMany({
      where: { vendorId, endpointType: "arc_usdc", isActive: true },
      data: { isActive: false },
    });
    const version = (vendor.endpoints[0]?.version || 0) + 1;
    await prisma.vendorPaymentEndpoint.create({
      data: {
        vendorId,
        endpointType: "arc_usdc",
        version,
        accountName: vendor.name,
        arcAddress,
        currency: "USDC",
        isActive: true,
      },
    });
    await addDestination({
      organizationId: session.organizationId,
      address: arcAddress,
      label: vendor.name,
      vendorId,
      actorId: session.id,
    });
    await writeAudit({
      organizationId: session.organizationId,
      actorType: "user",
      actorId: session.id,
      action: "vendor.arc_endpoint_added",
      entityType: "vendor",
      entityId: vendorId,
      metadata: { arcAddress },
    });
    revalidatePath("/app/vendors");
  }

  async function addBankEndpoint(formData: FormData) {
    "use server";
    const session = await requireSessionUser(["admin", "payer"]);
    const vendorId = String(formData.get("vendorId") || "");
    const accountName = String(formData.get("accountName") || "");
    const accountNumber = String(formData.get("accountNumber") || "");
    const vendor = await prisma.vendor.findFirst({
      where: { id: vendorId, organizationId: session.organizationId },
      include: { endpoints: { orderBy: { version: "desc" }, take: 1 } },
    });
    if (!vendor) throw new Error("Vendor not found");
    await prisma.vendorPaymentEndpoint.updateMany({
      where: { vendorId, endpointType: "bank", isActive: true },
      data: { isActive: false },
    });
    await prisma.vendorPaymentEndpoint.create({
      data: {
        vendorId,
        endpointType: "bank",
        version: (vendor.endpoints[0]?.version || 0) + 1,
        accountName,
        accountNumberEncrypted: encryptField(accountNumber),
        accountNumberLast4: last4(accountNumber),
        bankName: String(formData.get("bankName") || "") || null,
        bankCode: String(formData.get("bankCode") || "") || null,
        currency: "NGN",
        isActive: true,
      },
    });
    revalidatePath("/app/vendors");
  }

  async function addPurchaseOrder(formData: FormData) {
    "use server";
    const session = await requireSessionUser(["admin", "payer"], "vendors:write");
    const amountRaw = String(formData.get("amount") || "").trim();
    await upsertVendorPurchaseOrder({
      organizationId: session.organizationId,
      actorId: session.id,
      vendorId: String(formData.get("vendorId") || ""),
      poNumber: String(formData.get("poNumber") || ""),
      amount: amountRaw ? Number(amountRaw) : null,
      currency: String(formData.get("currency") || "NGN"),
      label: String(formData.get("label") || "") || null,
    });
    revalidatePath("/app/vendors");
  }

  async function saveEarlyPay(formData: FormData) {
    "use server";
    const session = await requireSessionUser(["admin", "payer"], "vendors:write");
    const vendorId = String(formData.get("vendorId") || "");
    const vendor = await prisma.vendor.findFirst({
      where: { id: vendorId, organizationId: session.organizationId },
    });
    if (!vendor) throw new Error("Vendor not found");
    const pct = String(formData.get("earlyPayDiscountPct") || "").trim();
    const days = String(formData.get("earlyPayDays") || "").trim();
    await prisma.vendor.update({
      where: { id: vendorId },
      data: {
        earlyPayDiscountPct: pct ? Number(pct) : null,
        earlyPayDays: days ? Number(days) : null,
      },
    });
    revalidatePath("/app/vendors");
  }

  return (
    <AppShell
      user={user}
      title="Vendors"
    >
      <SectionTabs tabs={tabs} active="directory" />
      <div className="mt-5 space-y-4">
        {vendors.map((vendor) => {
          const activeArc = vendor.endpoints.find((e) => e.isActive && e.endpointType === "arc_usdc");
          const activeBank = vendor.endpoints.find((e) => e.isActive && e.endpointType === "bank");
          return (
            <div key={vendor.id} className="card p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="app-h">{vendor.name}</h2>
                  <p className="app-sub">{vendor.email || vendor.externalId || vendor.id}</p>
                </div>
                {vendor.isNew ? <span className="badge bg-amber-50 text-warn">new vendor</span> : null}
              </div>

              <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted">Arc USDC</p>
                  {activeArc?.arcAddress ? (
                    <p className="mt-1 break-all font-mono text-[0.8rem]">{activeArc.arcAddress}</p>
                  ) : (
                    <p className="mt-1 text-muted">No Arc endpoint</p>
                  )}
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted">Bank</p>
                  {activeBank ? (
                    <p className="mt-1">
                      {activeBank.accountName} · ••••{activeBank.accountNumberLast4}
                      <span className="text-muted">
                        {" "}
                        · {activeBank.bankName || "—"} ({activeBank.bankCode || "—"})
                      </span>
                    </p>
                  ) : (
                    <p className="mt-1 text-muted">No bank endpoint</p>
                  )}
                </div>
              </div>

              <div className="mt-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                  Early-pay terms
                </p>
                <p className="mt-1 text-[0.72rem] text-muted">
                  {vendor.earlyPayDiscountPct != null
                    ? `${vendor.earlyPayDiscountPct}% if paid ${vendor.earlyPayDays ?? "?"} days before due`
                    : "No discount configured"}
                </p>
                <form action={saveEarlyPay} className="mt-2 grid gap-2 sm:grid-cols-3">
                  <input type="hidden" name="vendorId" value={vendor.id} />
                  <input
                    name="earlyPayDiscountPct"
                    type="number"
                    step="0.01"
                    className="input"
                    placeholder="% discount"
                    defaultValue={vendor.earlyPayDiscountPct ?? ""}
                  />
                  <input
                    name="earlyPayDays"
                    type="number"
                    className="input"
                    placeholder="Days before due"
                    defaultValue={vendor.earlyPayDays ?? ""}
                  />
                  <button type="submit" className="btn btn-secondary">
                    Save terms
                  </button>
                </form>
              </div>

              <div className="mt-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                  Purchase orders / contracts
                </p>
                <ul className="mt-2 space-y-1 text-sm text-muted">
                  {vendor.purchaseOrders.map((po) => (
                    <li key={po.id}>
                      <span className="font-mono text-foreground">{po.poNumber}</span>
                      {po.amount != null
                        ? ` · ${formatMoney(po.amount, po.currency)}`
                        : ""}
                      {po.label ? ` · ${po.label}` : ""}
                    </li>
                  ))}
                  {!vendor.purchaseOrders.length ? (
                    <li>No open POs — add one to validate invoice PO numbers.</li>
                  ) : null}
                </ul>
                <form action={addPurchaseOrder} className="mt-3 grid gap-2 md:grid-cols-4">
                  <input type="hidden" name="vendorId" value={vendor.id} />
                  <input name="poNumber" className="input" placeholder="PO-1001" required />
                  <input name="amount" type="number" step="0.01" className="input" placeholder="Amount" />
                  <input name="currency" className="input" defaultValue="NGN" placeholder="Currency" />
                  <input name="label" className="input md:col-span-3" placeholder="Label (optional)" />
                  <button type="submit" className="btn btn-secondary">
                    Add PO
                  </button>
                </form>
              </div>

              <div className="mt-4 grid gap-3 md:grid-cols-2">
                <form action={addArcEndpoint} className="flex flex-col gap-2">
                  <input type="hidden" name="vendorId" value={vendor.id} />
                  <input name="arcAddress" className="input" placeholder="0x… Arc payout address" required />
                  <button type="submit" className="btn btn-secondary">
                    Set Arc endpoint
                  </button>
                </form>
                <form action={addBankEndpoint} className="grid gap-2">
                  <input type="hidden" name="vendorId" value={vendor.id} />
                  <input name="accountName" className="input" placeholder="Account name" required />
                  <input name="accountNumber" className="input" placeholder="Account number" required />
                  <div className="grid grid-cols-2 gap-2">
                    <input name="bankName" className="input" placeholder="Bank" />
                    <input name="bankCode" className="input" placeholder="Code" />
                  </div>
                  <button type="submit" className="btn btn-secondary">
                    Set bank endpoint
                  </button>
                </form>
              </div>

              <div className="mt-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted">Endpoint versions</p>
                <ul className="mt-2 space-y-1 text-sm text-muted">
                  {vendor.endpoints.map((ep) => (
                    <li key={ep.id}>
                      v{ep.version} · {ep.endpointType}
                      {ep.endpointType === "arc_usdc"
                        ? ` · ${ep.arcAddress?.slice(0, 10)}…`
                        : ` · ••••${ep.accountNumberLast4}`}{" "}
                      · {ep.isActive ? "active" : "inactive"} · {formatDate(ep.createdAt)}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          );
        })}
      </div>
    </AppShell>
  );
}
