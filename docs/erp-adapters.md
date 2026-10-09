# ERP adapters

Odoo, SAP Business One / S/4HANA, and Dynamics 365 Finance / Business Central normalize into the Partner API.

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

Source: `account.move` with `move_type=in_invoice`. Subscribe to create and write, or poll with XML-RPC or JSON-RPC.

Fields read by the mapper: `id`, `name`, `partner_id`, `amount_total`, `currency_id`, `invoice_date_due`, `invoice_date`, `ref`, `invoice_line_ids`.

## SAP

Source: Service Layer `PurchaseInvoices`, or IDoc `INVOIC02`.

Fields: `DocEntry`, `DocNum`, `CardCode`, `CardName`, `DocTotal`, `DocCurrency`, `DocDueDate`, `DocDate`, `DocumentLines`.

## Dynamics 365

Source: OData `purchaseInvoices`.

Fields: `id`, `number`, `vendorNumber`, `vendorName`, `totalAmountIncludingTax`, `currencyCode`, `dueDate`, `invoiceDate`.

## Webhooks after ingest

`invoice.ingested`, `invoice.analyzed`, `approval.needed`, `approval.decided`, `payment.intent_created`, `payment.failed`, `invoice.reconciled`.

Subscribe with `*` to receive every emitted event. `approval.requested`, `payment.created`, and `payment.sent` are listed in the picker and are not delivered.
