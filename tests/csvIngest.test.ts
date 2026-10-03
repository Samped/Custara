import test from "node:test";
import assert from "node:assert/strict";
import { parseInvoiceCsv, rowToDocument } from "../src/domain/csvIngest";

test("parseInvoiceCsv maps African AP template rows", () => {
  const csv = `vendor_name,invoice_number,total_amount,currency,due_date
Acme Supplies,INV-1001,"250,000",NGN,2026-10-20
`;
  const { rows } = parseInvoiceCsv(csv);
  assert.equal(rows.length, 1);
  const doc = rowToDocument(rows[0]);
  assert.equal(doc.vendor_name, "Acme Supplies");
  assert.equal(doc.invoice_number, "INV-1001");
  assert.equal(doc.total_amount, 250000);
  assert.equal(doc.currency, "NGN");
});
