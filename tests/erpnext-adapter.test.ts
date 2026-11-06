import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapErpNextPurchaseInvoice, odooIntentKey } from "../src/domain/erp/adapters";

describe("mapErpNextPurchaseInvoice", () => {
  it("maps supplier, totals, items, and outstanding", () => {
    const bill = mapErpNextPurchaseInvoice({
      name: "PINV-0001",
      supplier: "SUP-ACME",
      supplier_name: "Acme Supplies",
      grand_total: 11000,
      net_total: 10000,
      total_taxes_and_charges: 1000,
      outstanding_amount: 11000,
      currency: "NGN",
      posting_date: "2026-09-10",
      due_date: "2026-10-10",
      bill_no: "VEN-42",
      docstatus: 1,
      status: "Unpaid",
      items: [
        {
          item_code: "HAUL",
          item_name: "Haulage",
          qty: 1,
          rate: 10000,
          amount: 10000,
          expense_account: "Expenses - C",
          purchase_order: "PO-100",
        },
      ],
      taxes: [{ description: "VAT 10%", tax_amount: 1000 }],
    });
    assert.equal(bill.externalId, "erpnext:PINV-0001");
    assert.equal(bill.vendorName, "Acme Supplies");
    assert.equal(bill.vendorExternalId, "erpnext-supplier:SUP-ACME");
    assert.equal(bill.invoiceNumber, "VEN-42");
    assert.equal(bill.totalAmount, 11000);
    assert.equal(bill.subtotal, 10000);
    assert.equal(bill.taxAmount, 1000);
    assert.equal(bill.currency, "NGN");
    assert.equal(bill.poNumber, "PO-100");
    assert.equal(bill.residual, 11000);
    assert.equal(bill.odooState, "posted");
    assert.equal(bill.paymentState, "not_paid");
    assert.equal(bill.lineItems?.[0]?.description, "Haulage");
    assert.equal(bill.lineItems?.[1]?.description, "VAT 10%");
    assert.equal(bill.lineItems?.[1]?.amount, 1000);
  });

  it("prefixes credit notes / returns", () => {
    const bill = mapErpNextPurchaseInvoice({
      name: "PINV-R-1",
      supplier: "SUP-1",
      supplier_name: "Vendor",
      grand_total: -500,
      is_return: 1,
      currency: "USD",
    });
    assert.equal(bill.externalId, "erpnext-refund:PINV-R-1");
    assert.equal(bill.moveType, "in_refund");
  });

  it("detects Arc wallet in remarks", () => {
    const bill = mapErpNextPurchaseInvoice({
      name: "PINV-2",
      supplier: "SUP-2",
      grand_total: 100,
      remarks: "Pay crypto to 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    assert.equal(bill.arcAddress, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    assert.equal(bill.paymentMethod, "crypto");
  });
});

describe("erpnext intent key", () => {
  it("reuses custara: memo prefix", () => {
    assert.equal(odooIntentKey("pi_123"), "custara:pi_123");
  });
});
