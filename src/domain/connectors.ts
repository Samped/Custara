import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { encryptField } from "@/lib/crypto";
import { putObject } from "@/lib/storage";

export async function ensureAccountingConnector(organizationId: string) {
  return prisma.integrationConnector.upsert({
    where: {
      organizationId_type: {
        organizationId,
        type: "accounting_csv",
      },
    },
    create: {
      organizationId,
      type: "accounting_csv",
      name: "Accounting CSV / Xero-ready export",
      status: "connected",
      configJson: JSON.stringify({
        format: "xero_bill_csv",
        syncDirection: "export",
      }),
    },
    update: {},
  });
}

export async function ensurePaymentConnector(organizationId: string) {
  return prisma.integrationConnector.upsert({
    where: {
      organizationId_type: {
        organizationId,
        type: "payment_nigeria",
      },
    },
    create: {
      organizationId,
      type: "payment_nigeria",
      name: "Nigeria payment partner (sandbox)",
      status: "connected",
      configJson: JSON.stringify({
        adapter: "nigeria_sandbox",
        requiresLicense: true,
      }),
      secretsJson: JSON.stringify({
        // placeholder encrypted partner token slot
        partnerApiKeyEnc: encryptField("sandbox-partner-key"),
      }),
    },
    update: {},
  });
}

/** Export approved/paid invoices as Xero-compatible bill CSV */
export async function exportAccountingBills(organizationId: string) {
  const invoices = await prisma.invoice.findMany({
    where: {
      organizationId,
      status: { in: ["approved", "payment_queued", "payment_sent", "reconciled"] },
    },
    include: { vendor: true },
    orderBy: { createdAt: "desc" },
    take: 500,
  });

  const header = [
    "ContactName",
    "InvoiceNumber",
    "InvoiceDate",
    "DueDate",
    "Description",
    "Quantity",
    "UnitAmount",
    "AccountCode",
    "TaxType",
    "Currency",
  ];

  const rows = invoices.map((inv) =>
    [
      inv.vendor?.name || "Unknown",
      inv.invoiceNumber || inv.id,
      inv.issueDate?.toISOString().slice(0, 10) || "",
      inv.dueDate?.toISOString().slice(0, 10) || "",
      `Custara AP ${inv.invoiceNumber || inv.id}`,
      "1",
      String(inv.totalAmount ?? 0),
      "200",
      "Tax Exempt",
      inv.currency,
    ]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(","),
  );

  const csv = [header.join(","), ...rows].join("\n");
  const rel = `${organizationId}/accounting/xero-bills-${Date.now()}.csv`;
  await putObject(rel, csv, "text/csv");

  await prisma.integrationConnector.update({
    where: {
      organizationId_type: { organizationId, type: "accounting_csv" },
    },
    data: { lastSyncAt: new Date(), status: "connected" },
  });

  await writeAudit({
    organizationId,
    actorType: "system",
    action: "connector.accounting_export",
    entityType: "connector",
    metadata: { path: rel, count: invoices.length },
  });

  return { path: rel, count: invoices.length, csv };
}
