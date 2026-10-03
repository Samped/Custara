# ERP adapter examples — Odoo, SAP Business One / S/4, Dynamics 365 Finance / BC
#
# All adapters normalize into Custara's Partner API:
#   POST /api/v1/erp/ingest
#   Authorization: Bearer <api_key>
#   Idempotency-Key: <stable-erp-document-id>
#   { "system": "odoo" | "sap" | "dynamics", "payload": { ...erp document... }, "sync": false }
#
# Or push already-normalized documents to POST /api/v1/invoices with document fields.
#
# --- Odoo (account.move, move_type=in_invoice) ---
# Subscribe to create/write on account.move or poll via XML-RPC / JSON-RPC.
# Example payload fields consumed by mapOdooAccountMove:
#   id, name, partner_id, amount_total, currency_id, invoice_date_due, invoice_date, ref, invoice_line_ids
#
# --- SAP Business One / S/4HANA AP ---
# Service Layer PurchaseInvoices or IDoc/INVOIC02 → mapSapApInvoice
#   DocEntry, DocNum, CardCode, CardName, DocTotal, DocCurrency, DocDueDate, DocDate, DocumentLines
#
# --- Microsoft Dynamics 365 Finance / Business Central ---
# OData purchaseInvoices → mapDynamicsPurchaseInvoice
#   id, number, vendorNumber, vendorName, totalAmountIncludingTax, currencyCode, dueDate, invoiceDate
#
# Webhooks to subscribe after ingest:
#   invoice.ingested, invoice.analyzed, approval.requested, approval.decided,
#   payment.created, payment.sent, invoice.reconciled
#
# Source: src/domain/erp/adapters.ts
