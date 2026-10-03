/**
 * Enterprise ERP adapter examples for Odoo, SAP, and Microsoft Dynamics.
 * These normalize ERP payloads into Custara's ingestInvoice contract.
 *
 * Production pattern:
 * 1. ERP webhook / scheduled poll → adapter.map*()
 * 2. POST /api/v1/invoices with Idempotency-Key
 * 3. Subscribe to invoice.* + approval.* + payment.* webhooks
 */

import { ingestInvoice } from "@/domain/ingest";
import { runInvoicePipeline } from "@/domain/pipeline";

export type ErpNormalizedBill = {
  externalId: string;
  vendorName?: string;
  vendorExternalId?: string;
  invoiceNumber?: string;
  totalAmount?: number;
  currency?: string;
  dueDate?: string;
  invoiceDate?: string;
  description?: string;
  lineItems?: Array<{ description?: string; quantity?: number; unitPrice?: number }>;
  raw?: Record<string, unknown>;
};

/** Odoo account.move (in_invoice) JSON-RPC / webhook shape → normalized bill */
export function mapOdooAccountMove(move: {
  id?: number | string;
  name?: string;
  partner_id?: [number, string] | { id?: number; name?: string };
  amount_total?: number;
  currency_id?: [number, string] | { name?: string };
  invoice_date_due?: string;
  invoice_date?: string;
  ref?: string;
  invoice_line_ids?: Array<{ name?: string; quantity?: number; price_unit?: number }>;
}): ErpNormalizedBill {
  const partner = Array.isArray(move.partner_id)
    ? { id: move.partner_id[0], name: move.partner_id[1] }
    : move.partner_id;
  const currency = Array.isArray(move.currency_id)
    ? move.currency_id[1]
    : move.currency_id?.name;
  return {
    externalId: `odoo:${move.id}`,
    vendorName: partner?.name,
    vendorExternalId: partner?.id != null ? `odoo-partner:${partner.id}` : undefined,
    invoiceNumber: move.name || move.ref,
    totalAmount: move.amount_total,
    currency: currency || "NGN",
    dueDate: move.invoice_date_due,
    invoiceDate: move.invoice_date,
    description: move.ref,
    lineItems: (move.invoice_line_ids || []).map((l) => ({
      description: l.name,
      quantity: l.quantity,
      unitPrice: l.price_unit,
    })),
    raw: move as Record<string, unknown>,
  };
}

/** SAP Business One / S/4HANA AP invoice fragment → normalized bill */
export function mapSapApInvoice(doc: {
  DocEntry?: number | string;
  DocNum?: string | number;
  CardCode?: string;
  CardName?: string;
  DocTotal?: number;
  DocCurrency?: string;
  DocDueDate?: string;
  DocDate?: string;
  Comments?: string;
  DocumentLines?: Array<{ ItemDescription?: string; Quantity?: number; Price?: number }>;
}): ErpNormalizedBill {
  return {
    externalId: `sap:${doc.DocEntry}`,
    vendorName: doc.CardName,
    vendorExternalId: doc.CardCode ? `sap-bp:${doc.CardCode}` : undefined,
    invoiceNumber: doc.DocNum != null ? String(doc.DocNum) : undefined,
    totalAmount: doc.DocTotal,
    currency: doc.DocCurrency || "NGN",
    dueDate: doc.DocDueDate,
    invoiceDate: doc.DocDate,
    description: doc.Comments,
    lineItems: (doc.DocumentLines || []).map((l) => ({
      description: l.ItemDescription,
      quantity: l.Quantity,
      unitPrice: l.Price,
    })),
    raw: doc as Record<string, unknown>,
  };
}

/** Dynamics 365 Finance / Business Central purchase invoice → normalized bill */
export function mapDynamicsPurchaseInvoice(inv: {
  id?: string;
  number?: string;
  vendorNumber?: string;
  vendorName?: string;
  totalAmountIncludingTax?: number;
  currencyCode?: string;
  dueDate?: string;
  invoiceDate?: string;
  description?: string;
  purchaseInvoiceLines?: Array<{
    description?: string;
    quantity?: number;
    unitCost?: number;
  }>;
}): ErpNormalizedBill {
  return {
    externalId: `dynamics:${inv.id}`,
    vendorName: inv.vendorName,
    vendorExternalId: inv.vendorNumber ? `dynamics-vendor:${inv.vendorNumber}` : undefined,
    invoiceNumber: inv.number,
    totalAmount: inv.totalAmountIncludingTax,
    currency: inv.currencyCode || "NGN",
    dueDate: inv.dueDate,
    invoiceDate: inv.invoiceDate,
    description: inv.description,
    lineItems: (inv.purchaseInvoiceLines || []).map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitCost,
    })),
    raw: inv as Record<string, unknown>,
  };
}

export async function ingestErpBill(input: {
  organizationId: string;
  system: "odoo" | "sap" | "dynamics";
  bill: ErpNormalizedBill;
  sync?: boolean;
  actorType?: "api_key" | "system";
  actorId?: string;
}) {
  const document: Record<string, unknown> = {
    vendor_name: input.bill.vendorName,
    invoice_number: input.bill.invoiceNumber,
    total_amount: input.bill.totalAmount,
    currency: (input.bill.currency || "NGN").toUpperCase(),
    due_date: input.bill.dueDate,
    invoice_date: input.bill.invoiceDate,
    description: input.bill.description,
    line_items: input.bill.lineItems,
    erp_system: input.system,
    ...(input.bill.raw || {}),
  };

  const invoice = await ingestInvoice({
    organizationId: input.organizationId,
    actorType: input.actorType || "api_key",
    actorId: input.actorId,
    source: "accounting",
    externalId: input.bill.externalId,
    currency: String(document.currency),
    vendorExternalId: input.bill.vendorExternalId || null,
    structuredPayload: document,
    filename: `${input.system}-${input.bill.externalId}.json`,
    enqueue: input.sync ? false : true,
  });

  if (input.sync) {
    await runInvoicePipeline(invoice.id, {
      type: input.actorType || "system",
      id: input.actorId,
    });
  }

  return invoice;
}
