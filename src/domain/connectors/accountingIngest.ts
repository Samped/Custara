import { prisma } from "@/lib/db";
import { ingestInvoice } from "@/domain/ingest";
import { runInvoicePipeline } from "@/domain/pipeline";
import { reconcileSettlement } from "@/domain/cash";

export type AccountingBill = {
  externalId: string;
  invoiceNumber?: string;
  vendorName?: string;
  totalAmount?: number;
  currency?: string;
  dueDate?: string;
  invoiceDate?: string;
  status?: string; // draft | authorised | paid | void
  description?: string;
  raw?: Record<string, unknown>;
};

/** Idempotent ingest of an AP bill from any accounting system. */
export async function ingestAccountingBill(input: {
  organizationId: string;
  provider: string;
  bill: AccountingBill;
  sync?: boolean;
}) {
  const externalId = `${input.provider}:${input.bill.externalId}`;
  const existing = await prisma.invoice.findFirst({
    where: { organizationId: input.organizationId, externalId },
  });
  if (existing) return { invoice: existing, created: false };

  const document: Record<string, unknown> = {
    vendor_name: input.bill.vendorName,
    invoice_number: input.bill.invoiceNumber,
    total_amount: input.bill.totalAmount,
    currency: (input.bill.currency || "NGN").toUpperCase(),
    due_date: input.bill.dueDate,
    invoice_date: input.bill.invoiceDate,
    description: input.bill.description,
    source_provider: input.provider,
    ...(input.bill.raw || {}),
  };

  const invoice = await ingestInvoice({
    organizationId: input.organizationId,
    actorType: "system",
    source: "accounting",
    externalId,
    currency: String(document.currency),
    structuredPayload: document,
    filename: `${input.provider}-${input.bill.externalId}.json`,
    enqueue: input.sync ? false : true,
  });

  if (input.sync) {
    await runInvoicePipeline(invoice.id, { type: "system" });
  }

  return { invoice, created: true };
}

/** If bill is paid in the accounting system, reconcile a matching Custara invoice. */
export async function reconcileAccountingPayment(input: {
  organizationId: string;
  provider: string;
  bill: AccountingBill;
}) {
  const externalId = `${input.provider}:${input.bill.externalId}`;
  const inv =
    (await prisma.invoice.findFirst({
      where: { organizationId: input.organizationId, externalId },
    })) ||
    (input.bill.invoiceNumber
      ? await prisma.invoice.findFirst({
          where: {
            organizationId: input.organizationId,
            invoiceNumber: input.bill.invoiceNumber,
            status: { in: ["payment_sent", "approved", "payment_queued", "pending_approval"] },
          },
        })
      : null);

  if (!inv) return { reconciled: false };
  if (inv.status === "reconciled" || inv.status === "settled") return { reconciled: false };

  const reference = `${input.provider}:${input.bill.externalId}`;
  const existing = await prisma.settlement.findFirst({
    where: { invoiceId: inv.id, reference },
  });
  if (existing) return { reconciled: false };

  await reconcileSettlement({
    organizationId: input.organizationId,
    invoiceId: inv.id,
    amount: Number(input.bill.totalAmount || inv.totalAmount || 0),
    currency: input.bill.currency || inv.currency,
    reference,
    actorType: "system",
  });
  return { reconciled: true };
}
