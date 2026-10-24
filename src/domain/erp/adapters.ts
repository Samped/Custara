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
  poNumber?: string | null;
  arcAddress?: string | null;
  paymentMethod?: string | null;
  subtotal?: number | null;
  taxAmount?: number | null;
  moveType?: string | null;
  odooState?: string | null;
  paymentState?: string | null;
  residual?: number | null;
  paymentTerm?: string | null;
  taxLabel?: string | null;
  lineItems?: Array<{
    description?: string;
    quantity?: number;
    unitPrice?: number;
    amount?: number;
    accountCode?: string | null;
    analytic?: string | null;
    product?: string | null;
  }>;
  raw?: Record<string, unknown>;
};

const ARC_ADDRESS_RE = /0x[a-fA-F0-9]{40}/;

export function parseArcAddress(raw: unknown): string | null {
  const match = String(raw || "").match(ARC_ADDRESS_RE);
  return match ? match[0].toLowerCase() : null;
}

export function wantsCryptoSettlement(input: {
  paymentReference?: string | null;
  bankName?: string | null;
  accountNumber?: string | null;
  narration?: string | null;
}): boolean {
  if (
    parseArcAddress(input.accountNumber) ||
    parseArcAddress(input.paymentReference) ||
    parseArcAddress(input.narration)
  ) {
    return true;
  }
  const blob = [input.paymentReference, input.bankName, input.narration].filter(Boolean).join(" ");
  return /\b(crypto|usdc|arc|wallet|stablecoin)\b/i.test(blob);
}

type OdooLine = {
  name?: string;
  quantity?: number;
  price_unit?: number;
  price_subtotal?: number;
  display_type?: string | false;
  account_id?: unknown;
  analytic_distribution?: unknown;
  product_id?: unknown;
  tax_ids?: unknown;
};

/** Odoo one2many commands are `[0, 0, {…}]`; search_read may return ids or dicts. */
export function normalizeOdooInvoiceLines(raw: unknown): OdooLine[] {
  if (!Array.isArray(raw)) return [];
  const lines: OdooLine[] = [];
  for (const item of raw) {
    if (Array.isArray(item) && item[2] && typeof item[2] === "object") {
      lines.push(item[2] as OdooLine);
      continue;
    }
    if (item && typeof item === "object" && !Array.isArray(item) && "name" in item) {
      lines.push(item as OdooLine);
    }
  }
  return lines;
}

function odooMany2one(value: unknown): { id?: number; name?: string } | undefined {
  if (value == null || value === false) return undefined;
  if (Array.isArray(value) && value.length >= 2) {
    return { id: Number(value[0]), name: String(value[1] || "") };
  }
  if (typeof value === "object") {
    const rec = value as { id?: number; name?: string };
    return { id: rec.id, name: rec.name };
  }
  return undefined;
}

export function odooIntentKey(paymentIntentId: string) {
  return `custara:${paymentIntentId}`;
}

export function paymentMentionsIntent(
  payment: { memo?: string | null; communication?: string | null; ref?: string | null; payment_reference?: string | null },
  paymentIntentId: string,
) {
  const key = odooIntentKey(paymentIntentId);
  return [payment.memo, payment.communication, payment.ref, payment.payment_reference]
    .filter(Boolean)
    .join(" ")
    .includes(key);
}

export function isOdooCreditMove(moveType: string | null | undefined) {
  return String(moveType || "") === "in_refund";
}

/** Product lines only; tax is a header so the bill still foots. */
export function odooProductLines(lines: OdooLine[]) {
  return lines.filter((l) => {
    const display = l.display_type ? String(l.display_type) : "";
    return !display || display === "product";
  });
}

export function odooTaxFooting(input: {
  amountUntaxed?: number | null;
  amountTax?: number | null;
  amountTotal?: number | null;
  productLineTotal: number;
}) {
  const tax = Number(input.amountTax || 0);
  const untaxed = Number(input.amountUntaxed || input.productLineTotal || 0);
  const total = Number(input.amountTotal || untaxed + tax);
  return { subtotal: untaxed, taxAmount: tax, totalAmount: total };
}

/** Odoo account.move (vendor bill or credit) JSON-RPC / webhook shape → normalized bill */
export function mapOdooAccountMove(move: {
  id?: number | string;
  name?: string;
  partner_id?: unknown;
  amount_total?: number;
  amount_untaxed?: number;
  amount_tax?: number;
  currency_id?: unknown;
  invoice_date_due?: string;
  invoice_date?: string;
  invoice_origin?: string;
  ref?: string;
  payment_reference?: string;
  narration?: string;
  acc_number?: string;
  bank_name?: string;
  invoice_line_ids?: unknown;
  move_type?: string;
  state?: string;
  payment_state?: string;
  amount_residual?: number;
  invoice_payment_term_id?: unknown;
}): ErpNormalizedBill {
  const partner = odooMany2one(move.partner_id);
  const currency = odooMany2one(move.currency_id);
  const poNumber = (move.invoice_origin || move.ref || "").trim() || null;
  const paymentReference = (move.payment_reference || "").trim();
  const narration = (move.narration || "").trim();
  const accountNumber = (move.acc_number || "").trim();
  const bankName = (move.bank_name || "").trim();
  const arcAddress =
    parseArcAddress(accountNumber) ||
    parseArcAddress(paymentReference) ||
    parseArcAddress(narration) ||
    parseArcAddress(bankName);
  const paymentMethod = wantsCryptoSettlement({
    paymentReference,
    bankName,
    accountNumber,
    narration,
  })
    ? "crypto"
    : null;
  const productLines = odooProductLines(normalizeOdooInvoiceLines(move.invoice_line_ids));
  const lineItems = productLines.map((l) => {
    const quantity = Number(l.quantity ?? 1) || 1;
    const unitPrice = Number(l.price_unit ?? 0) || 0;
    const amount = Number(l.price_subtotal ?? quantity * unitPrice) || 0;
    return {
      description: l.name,
      quantity,
      unitPrice,
      amount,
      accountCode: odooMany2one(l.account_id)?.name || null,
      analytic:
        typeof l.analytic_distribution === "string"
          ? l.analytic_distribution
          : l.analytic_distribution
            ? JSON.stringify(l.analytic_distribution)
            : null,
      product: odooMany2one(l.product_id)?.name || null,
    };
  });
  const productTotal = lineItems.reduce((sum, l) => sum + (l.amount || 0), 0);
  const footing = odooTaxFooting({
    amountUntaxed: move.amount_untaxed,
    amountTax: move.amount_tax,
    amountTotal: move.amount_total,
    productLineTotal: productTotal,
  });
  if (footing.taxAmount > 0) {
    lineItems.push({
      description: "Tax",
      quantity: 1,
      unitPrice: footing.taxAmount,
      amount: footing.taxAmount,
      accountCode: null,
      analytic: null,
      product: null,
    });
  }
  const moveType = (move.move_type || "in_invoice").trim();
  const prefix = isOdooCreditMove(moveType) ? "odoo-refund" : "odoo";
  return {
    externalId: `${prefix}:${move.id}`,
    vendorName: partner?.name,
    vendorExternalId: partner?.id != null ? `odoo-partner:${partner.id}` : undefined,
    invoiceNumber: move.name || move.ref,
    totalAmount: footing.totalAmount,
    subtotal: footing.subtotal,
    taxAmount: footing.taxAmount,
    currency: currency?.name || "NGN",
    dueDate: move.invoice_date_due,
    invoiceDate: move.invoice_date,
    description: paymentReference || move.ref,
    poNumber,
    arcAddress,
    paymentMethod,
    moveType,
    odooState: move.state || null,
    paymentState: move.payment_state || null,
    residual: move.amount_residual ?? null,
    paymentTerm: odooMany2one(move.invoice_payment_term_id)?.name || null,
    lineItems,
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

export function toIngestDocument(system: string, bill: ErpNormalizedBill): Record<string, unknown> {
  return {
    vendor_name: bill.vendorName,
    invoice_number: bill.invoiceNumber,
    total_amount: bill.totalAmount,
    currency: (bill.currency || "NGN").toUpperCase(),
    due_date: bill.dueDate,
    invoice_date: bill.invoiceDate,
    description: bill.description,
    po_number: bill.poNumber,
    line_items: bill.lineItems,
    erp_system: system,
    arc_address: bill.arcAddress,
    payment_method: bill.paymentMethod,
    subtotal: bill.subtotal,
    tax_amount: bill.taxAmount,
    move_type: bill.moveType,
    odoo_state: bill.odooState,
    payment_state: bill.paymentState,
    amount_residual: bill.residual,
    payment_term: bill.paymentTerm,
    ...(bill.raw || {}),
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
  const document = toIngestDocument(input.system, input.bill);

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

/** Odoo stays in the bill currency. Crypto settlement is memo only — never the posted amount. */
export function odooLedgerWriteback(input: {
  ledgerAmount: number;
  ledgerCurrency?: string | null;
  settledAmount: number;
  settledCurrency?: string | null;
  txHash?: string | null;
  paymentIntentId?: string | null;
}) {
  const currency = (input.ledgerCurrency || "NGN").trim().toUpperCase() || "NGN";
  const settledCurrency = (input.settledCurrency || currency).trim().toUpperCase();
  const hash = (input.txHash || "").trim();
  const key = input.paymentIntentId ? odooIntentKey(input.paymentIntentId) : null;
  const communication = [key, "Custara", `${input.settledAmount} ${settledCurrency}`, hash]
    .filter(Boolean)
    .join(" ");
  return {
    amount: input.ledgerAmount,
    currency,
    communication,
  };
}
