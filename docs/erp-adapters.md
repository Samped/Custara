# ERP adapters

Odoo can be connected from **Connectors** in the workspace. Custara pulls posted vendor bills, suppliers, and purchase orders over JSON-RPC, then writes payment back after Arc or Nigeria settlement. Odoo stays the ledger.

SAP Business One / S/4HANA and Dynamics 365 Finance / Business Central still normalize through the Partner API.

```http
POST /api/v1/erp/ingest
Authorization: Bearer <api_key>
Idempotency-Key: <stable-erp-document-id>
```

```json
{
  "system": "odoo",
  "payload": {},
  "sync": false
}
```

`system` is `odoo`, `sap`, or `dynamics`. An ERP that already emits Custara's document shape calls `POST /api/v1/invoices` instead.

## Odoo

**Console:** admin pastes the database URL, Odoo user email, optional company and bank journal id, and an API key. Disconnect removes the stored key. The worker repeats sync every 15 minutes and retries failed payment write-backs every 2 minutes. After the first pull, only records written in the last day plus the previous sync window are fetched. Sync paginates; Connectors warns if the record cap is hit.

**What syncs**

| Odoo | Custara |
|------|---------|
| `res.partner` (`supplier_rank > 0`) | Vendors (`externalId` `odoo-partner:{id}`), VAT, address, payment terms, bank accounts |
| `purchase.order` (`purchase` / `done`) plus order lines | Vendor purchase orders and received vs ordered qty (3-way) |
| `product.supplierinfo` | Agreed unit prices |
| `account.move` vendor bills and credits (`in_invoice`, `in_refund`), draft or posted | Inbox invoices (`odoo:{id}` or `odoo-refund:{id}`), tax totals, residual, PDF attachments |
| `account.payment.term.line` | Installment due dates |
| Odoo `payment_state` / residual / fiscal lock | Residual pay, credit apply, refuse pay when the period is locked |

Approvals post draft bills and write chatter. After a payment settles, Custara registers `account.payment` in the **bill currency** with memo `custara:{paymentIntentId}` plus the USDC amount and tx hash (Arc **testnet**), posts the bank/AP journal entry, and reconciles **that bill only**. Failed write-backs retry from the worker or **Retry failed write-backs** on Connectors. A failed Custara payment does not mark the Odoo bill paid.

Optional Odoo Apps module: [Odoo app](odoo-app.md).

**Partner API** (middleware or an Odoo addon): `POST /api/v1/erp/ingest` with `system: "odoo"`. Fields: `id`, `name`, `partner_id`, `amount_total`, `currency_id`, `invoice_date_due`, `invoice_date`, `invoice_origin`, `ref`, `invoice_line_ids`.

Production requires HTTPS and a public host for the Odoo URL. `ODOO_ALLOW_HTTP=true` permits HTTP. `ODOO_ALLOW_PRIVATE=true` permits RFC1918 and loopback. Metadata and link-local addresses are always rejected. RPC does not follow redirects. A payment is registered on the Odoo bill at most once per Custara payment intent.

## SAP

Source: Service Layer `PurchaseInvoices`, or IDoc `INVOIC02`.

Fields: `DocEntry`, `DocNum`, `CardCode`, `CardName`, `DocTotal`, `DocCurrency`, `DocDueDate`, `DocDate`, `DocumentLines`.

## Dynamics 365

Source: OData `purchaseInvoices`.

Fields: `id`, `number`, `vendorNumber`, `vendorName`, `totalAmountIncludingTax`, `currencyCode`, `dueDate`, `invoiceDate`.

## Webhooks after ingest

`invoice.ingested`, `invoice.analyzed`, `approval.needed`, `approval.decided`, `payment.intent_created`, `payment.failed`, `invoice.reconciled`.

Subscribe with `*` to receive every emitted event. `approval.requested`, `payment.created`, and `payment.sent` are listed in the picker and are not delivered.
