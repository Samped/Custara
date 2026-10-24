import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isOdooCreditMove,
  mapOdooAccountMove,
  normalizeOdooInvoiceLines,
  odooIntentKey,
  odooLedgerWriteback,
  odooTaxFooting,
  parseArcAddress,
  paymentMentionsIntent,
  wantsCryptoSettlement,
} from "../src/domain/erp/adapters";
import { setFxBookForTests, settleArcAmount } from "../src/lib/currency";
import {
  assertOdooOrigin,
  isBlockedOdooHost,
  isMetadataHost,
  isPrivateOrLocalIp,
  odooDatabaseCandidates,
  odooDatabaseFromHost,
  odooOriginCandidates,
  odooUsernameCandidates,
  isOptionalOdooModelError,
} from "../src/domain/connectors/odoo";

describe("normalizeOdooInvoiceLines", () => {
  it("reads command-tuple lines used in Odoo create payloads", () => {
    const lines = normalizeOdooInvoiceLines([
      [0, 0, { name: "Haulage", quantity: 1, price_unit: 27500 }],
    ]);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].name, "Haulage");
    assert.equal(lines[0].price_unit, 27500);
  });

  it("reads dict lines from search_read", () => {
    const lines = normalizeOdooInvoiceLines([{ name: "Fuel", quantity: 2, price_unit: 10 }]);
    assert.equal(lines[0].name, "Fuel");
  });

  it("ignores bare ids", () => {
    assert.equal(normalizeOdooInvoiceLines([12, 13]).length, 0);
  });
});

describe("mapOdooAccountMove", () => {
  it("maps partner tuples and invoice origin as PO", () => {
    const bill = mapOdooAccountMove({
      id: 9001,
      name: "BILL/2026/0901",
      partner_id: [42, "Northern Haulage Ltd"],
      amount_total: 27500,
      currency_id: [1, "NGN"],
      invoice_date: "2026-09-10",
      invoice_date_due: "2026-10-10",
      invoice_origin: "PO-5001",
      ref: "FIX-ODOO-001",
      invoice_line_ids: [[0, 0, { name: "Haulage", quantity: 1, price_unit: 27500 }]],
    });
    assert.equal(bill.externalId, "odoo:9001");
    assert.equal(bill.vendorName, "Northern Haulage Ltd");
    assert.equal(bill.vendorExternalId, "odoo-partner:42");
    assert.equal(bill.invoiceNumber, "BILL/2026/0901");
    assert.equal(bill.totalAmount, 27500);
    assert.equal(bill.currency, "NGN");
    assert.equal(bill.poNumber, "PO-5001");
    assert.equal(bill.lineItems?.[0]?.description, "Haulage");
    assert.equal(bill.lineItems?.[0]?.amount, 27500);
  });

  it("reads a crypto payment reference and 0x bank account", () => {
    const bill = mapOdooAccountMove({
      id: 2,
      name: "BILL/2026/10/0001",
      partner_id: [7, "Custara"],
      amount_total: 3000,
      currency_id: [1, "NGN"],
      payment_reference: "crypto",
      acc_number: "0x1111111111111111111111111111111111111111",
      bank_name: "wallet address",
    });
    assert.equal(bill.paymentMethod, "crypto");
    assert.equal(bill.arcAddress, "0x1111111111111111111111111111111111111111");
    const fromBankName = mapOdooAccountMove({
      id: 3,
      name: "BILL/2",
      payment_reference: "crypto",
      bank_name: "0xe82f0b71ab6f471bd95801c0dca04797b9709b11",
    });
    assert.equal(fromBankName.arcAddress, "0xe82f0b71ab6f471bd95801c0dca04797b9709b11");
  });

  it("treats false many2one as missing", () => {
    const bill = mapOdooAccountMove({
      id: 1,
      name: "BILL/1",
      partner_id: false,
      currency_id: false,
      amount_total: 1,
    });
    assert.equal(bill.vendorName, undefined);
    assert.equal(bill.currency, "NGN");
  });
});

describe("assertOdooOrigin", () => {
  it("accepts https origins and strips paths", () => {
    assert.equal(assertOdooOrigin("https://company.odoo.com/web"), "https://company.odoo.com");
  });

  it("rejects metadata hosts", () => {
    assert.throws(() => assertOdooOrigin("http://169.254.169.254/"), /not allowed/);
  });

  it("rejects non-http schemes", () => {
    assert.throws(() => assertOdooOrigin("file:///etc/passwd"), /http/);
  });

  it("rejects metadata even when private hosts are allowed", () => {
    assert.equal(isBlockedOdooHost("169.254.169.254", true), true);
    assert.equal(isBlockedOdooHost("metadata.google.internal", true), true);
  });

  it("rejects loopback and RFC1918 when private hosts are not allowed", () => {
    assert.equal(isBlockedOdooHost("127.0.0.1", false), true);
    assert.equal(isBlockedOdooHost("10.0.0.8", false), true);
    assert.equal(isBlockedOdooHost("192.168.1.20", false), true);
    assert.equal(isBlockedOdooHost("172.16.0.1", false), true);
    assert.equal(isBlockedOdooHost("localhost", false), true);
    assert.equal(isBlockedOdooHost("company.odoo.com", false), false);
  });
});

describe("odoo target inference", () => {
  it("reads the company database from odoo.com hosts", () => {
    assert.equal(odooDatabaseFromHost("acme.odoo.com"), "acme");
    assert.equal(odooDatabaseFromHost("acme.dev.odoo.com"), "acme");
  });

  it("builds hosts from website, slug, and work email", () => {
    const origins = odooOriginCandidates({
      website: "https://books.northern.example/web",
      slug: "lagos-distribution",
      email: "ap@northern.example",
    });
    assert.ok(origins.includes("https://books.northern.example"));
    assert.ok(origins.includes("https://lagos-distribution.odoo.com"));
    assert.ok(origins.includes("https://northern.odoo.com"));
  });

  it("does not invent odoo.com hosts from gmail", () => {
    const origins = odooOriginCandidates({ email: "ada@gmail.com" });
    assert.equal(origins.length, 0);
  });

  it("tries the signed-in admin then other workspace emails", () => {
    const emails = odooUsernameCandidates({
      actorEmail: "admin@custara.demo",
      workspaceEmails: ["michaelsamuelpedro@gmail.com", "admin@custara.demo"],
    });
    assert.equal(emails[0], "admin@custara.demo");
    assert.ok(emails.includes("michaelsamuelpedro@gmail.com"));
  });

  it("prefers an explicit database then the host label", () => {
    const dbs = odooDatabaseCandidates({
      origin: "https://acme.odoo.com",
      slug: "lagos-distribution",
      databaseHint: "prod",
    });
    assert.equal(dbs[0], "prod");
    assert.ok(dbs.includes("acme"));
  });
});

describe("odoo crypto settlement", { concurrency: false }, () => {
  it("parses a wallet and flags crypto wording", () => {
    assert.equal(parseArcAddress("pay 0xAbcdefabcdefabcdefabcdefabcdefabcdefabcd"), "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd");
    assert.equal(wantsCryptoSettlement({ paymentReference: "crypto", bankName: "wallet address" }), true);
    assert.equal(wantsCryptoSettlement({ paymentReference: "NET30" }), false);
  });

  it("converts naira to USDC for Arc from a live book", () => {
    setFxBookForTests({ NGN: 1600 });
    const quote = settleArcAmount(3200, "NGN");
    assert.equal(quote.amount, 2);
    assert.equal(quote.currency, "USDC");
    assert.equal(quote.quoted, true);
  });

  it("writes the naira residual to Odoo and keeps USDC on the memo", () => {
    const back = odooLedgerWriteback({
      ledgerAmount: 3000,
      ledgerCurrency: "NGN",
      settledAmount: 2.247814,
      settledCurrency: "USDC",
      txHash: "0xd9a9175f64cef9938bc98858221e04e2791e19d4c601b28f3c8173e39298b4b2",
      paymentIntentId: "intent_1",
    });
    assert.equal(back.amount, 3000);
    assert.equal(back.currency, "NGN");
    assert.match(back.communication, /custara:intent_1/);
    assert.match(back.communication, /2\.247814 USDC/);
    assert.match(back.communication, /0xd9a9/);
    assert.equal(paymentMentionsIntent({ memo: back.communication }, "intent_1"), true);
    assert.equal(paymentMentionsIntent({ memo: "other" }, "intent_1"), false);
    assert.equal(odooIntentKey("intent_1"), "custara:intent_1");
  });
});

describe("odoo tax and credits", () => {
  it("foots tax as a header so product lines plus tax equal the total", () => {
    const foot = odooTaxFooting({
      amountUntaxed: 1000,
      amountTax: 75,
      amountTotal: 1075,
      productLineTotal: 1000,
    });
    assert.equal(foot.subtotal, 1000);
    assert.equal(foot.taxAmount, 75);
    assert.equal(foot.totalAmount, 1075);
    const bill = mapOdooAccountMove({
      id: 9,
      name: "BILL/TAX",
      amount_total: 1075,
      amount_untaxed: 1000,
      amount_tax: 75,
      invoice_line_ids: [{ name: "Service", quantity: 1, price_unit: 1000, price_subtotal: 1000 }],
    });
    const sum = (bill.lineItems || []).reduce((n, l) => n + (l.amount || 0), 0);
    assert.equal(sum, 1075);
    assert.equal(bill.taxAmount, 75);
  });

  it("maps vendor credits to odoo-refund ids", () => {
    const credit = mapOdooAccountMove({
      id: 44,
      name: "RINV/0001",
      move_type: "in_refund",
      amount_total: 500,
    });
    assert.equal(credit.externalId, "odoo-refund:44");
    assert.equal(isOdooCreditMove("in_refund"), true);
  });
});

describe("odoo login candidates", () => {
  it("keeps an explicit username first", () => {
    const users = odooUsernameCandidates({
      actorEmail: "ap@acme.com",
      savedUsername: "saved@acme.com",
      workspaceEmails: ["other@acme.com"],
    });
    assert.equal(users[0], "ap@acme.com");
    assert.ok(users.includes("saved@acme.com"));
  });
});

describe("optional Odoo models", () => {
  it("treats a missing purchase.order app as skippable", () => {
    assert.equal(isOptionalOdooModelError(new Error("Object purchase.order doesn't exist")), true);
    assert.equal(isOptionalOdooModelError(new Error("Odoo RPC HTTP 500.")), false);
  });
});

describe("odoo host classification", () => {
  it("flags private IPv4 and IPv6", () => {
    assert.equal(isPrivateOrLocalIp("10.1.2.3"), true);
    assert.equal(isPrivateOrLocalIp("::1"), true);
    assert.equal(isPrivateOrLocalIp("8.8.8.8"), false);
    assert.equal(isPrivateOrLocalIp("::ffff:127.0.0.1"), true);
  });

  it("flags cloud metadata hosts", () => {
    assert.equal(isMetadataHost("169.254.169.254"), true);
    assert.equal(isMetadataHost("169.254.170.2"), true);
    assert.equal(isMetadataHost("company.odoo.com"), false);
  });
});
