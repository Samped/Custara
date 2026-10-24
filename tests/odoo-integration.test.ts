import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";
import { encryptField } from "../src/lib/crypto";
import { matchPurchaseOrder } from "../src/domain/contracts";
import { syncOdooInbound, writeOdooPaymentBack } from "../src/domain/connectors/odoo";

if (!process.env.ENCRYPTION_KEY && !process.env.SESSION_SECRET) {
  process.env.ENCRYPTION_KEY = "odoo-integration-test-key";
}

const prisma = new PrismaClient();

type RpcBody = {
  params?: { service?: string; method?: string; args?: unknown[] };
};

function rpcParams(init?: RequestInit) {
  const body = JSON.parse(String(init?.body || "{}")) as RpcBody;
  return {
    service: String(body.params?.service || ""),
    method: String(body.params?.method || ""),
    args: Array.isArray(body.params?.args) ? body.params.args : [],
  };
}

function jsonResult(result: unknown) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("odoo sync and write-back via fetchImpl", () => {
  let organizationId = "";
  const calls: Array<{ model: string; method: string; args: unknown[]; kwargs?: Record<string, unknown> }> = [];
  let residual = 1075;
  let paymentState = "not_paid";
  const payments: Array<{ id: number; memo: string; communication: string; amount: number; state: string; move_id: boolean }> =
    [];

  const fetchImpl: typeof fetch = async (_url, init) => {
    const { service, method, args } = rpcParams(init);
    if (service === "common" && method === "authenticate") return jsonResult(7);
    if (service !== "object" || method !== "execute_kw") return jsonResult(null);

    const model = String(args[3] || "");
    const kwMethod = String(args[4] || "");
    const callArgs = (args[5] as unknown[]) || [];
    const kwargs = (args[6] as Record<string, unknown> | undefined) || {};
    calls.push({ model, method: kwMethod, args: callArgs, kwargs });

    if (kwMethod === "search_count") return jsonResult(1);

    if (model === "res.partner" && kwMethod === "search_read") {
      return jsonResult([
        { id: 42, name: "Northern Haulage Ltd", email: "ap@northern.example", vat: "12345678-0001", active: true, supplier_rank: 1 },
      ]);
    }
    if (model === "res.partner.bank" && kwMethod === "search_read") {
      const domain = (callArgs[0] as unknown[][]) || [];
      if (domain.some((row) => Array.isArray(row) && row[0] === "partner_id")) {
        return jsonResult([
          {
            id: 8,
            partner_id: [42, "Northern Haulage Ltd"],
            sanitized_acc_number: "0123456789",
            bank_id: [1, "GTBank"],
            acc_holder_name: "Northern Haulage Ltd",
          },
        ]);
      }
      return jsonResult([]);
    }
    if (model === "purchase.order" && kwMethod === "search_read") {
      return jsonResult([
        { id: 55, name: "PO-5001", partner_id: [42, "Northern Haulage Ltd"], amount_total: 1075, currency_id: [1, "NGN"], state: "purchase" },
      ]);
    }
    if (model === "purchase.order.line" && kwMethod === "search_read") {
      return jsonResult([{ order_id: [55, "PO-5001"], product_qty: 10, qty_received: 4 }]);
    }
    if (model === "account.move" && kwMethod === "search_read") {
      const domain = (callArgs[0] as unknown[][]) || [];
      const byId = domain.find((row) => Array.isArray(row) && row[0] === "id" && row[1] === "=");
      if (byId) {
        return jsonResult([
          {
            id: 9001,
            payment_state: paymentState,
            amount_residual: residual,
            amount_total: 1075,
            partner_id: [42, "Northern Haulage Ltd"],
          },
        ]);
      }
      return jsonResult([
        {
          id: 9001,
          name: "BILL/2026/0901",
          partner_id: [42, "Northern Haulage Ltd"],
          amount_total: 1075,
          amount_untaxed: 1000,
          amount_tax: 75,
          amount_residual: 1075,
          currency_id: [1, "NGN"],
          invoice_date: "2026-09-10",
          invoice_date_due: "2026-10-10",
          invoice_origin: "PO-5001",
          move_type: "in_invoice",
          state: "posted",
          payment_state: "not_paid",
          invoice_payment_term_id: [3, "30 Days"],
        },
        {
          id: 44,
          name: "RINV/0001",
          partner_id: [42, "Northern Haulage Ltd"],
          amount_total: 200,
          amount_untaxed: 200,
          amount_tax: 0,
          amount_residual: 200,
          currency_id: [1, "NGN"],
          move_type: "in_refund",
          state: "posted",
          payment_state: "not_paid",
        },
      ]);
    }
    if (model === "account.move.line" && kwMethod === "search_read") {
      const domain = (callArgs[0] as unknown[][]) || [];
      if (domain.some((row) => Array.isArray(row) && row[0] === "account_type")) {
        return jsonResult([
          { id: 801, move_id: [9001, "BILL/2026/0901"], account_type: "liability_payable", reconciled: false, amount_residual: residual, account_id: [201, "Payables"] },
          { id: 802, move_id: [12, "BNK1/00001"], account_type: "liability_payable", reconciled: false, amount_residual: -residual, account_id: [101, "Bank"] },
        ]);
      }
      return jsonResult([
        {
          move_id: [9001, "BILL/2026/0901"],
          name: "Haulage",
          quantity: 1,
          price_unit: 1000,
          price_subtotal: 1000,
          display_type: "product",
          account_id: [400, "Expense"],
          product_id: [9, "Haulage"],
          analytic_distribution: { "1": 100 },
        },
      ]);
    }
    if (model === "ir.attachment" && kwMethod === "search_read") {
      return jsonResult([
        {
          id: 3,
          name: "vendor-bill.pdf",
          datas: Buffer.from("%PDF-1.4 test").toString("base64"),
        },
      ]);
    }
    if (model === "ir.attachment" && kwMethod === "create") return jsonResult(99);
    if (model === "account.journal" && kwMethod === "search_read") {
      return jsonResult([{ id: 11, name: "Bank", type: "bank", default_account_id: [101, "Bank"] }]);
    }
    if (model === "res.currency" && kwMethod === "search_read") {
      return jsonResult([{ id: 1, name: "NGN" }]);
    }
    if (model === "account.payment" && kwMethod === "search_read") {
      return jsonResult(payments);
    }
    if (model === "account.payment.register" && kwMethod === "default_get") {
      return jsonResult({ journal_id: 11, amount: residual, currency_id: 1 });
    }
    if (model === "account.payment.register" && kwMethod === "create") {
      const vals = (callArgs[0] as { communication?: string; amount?: number }) || {};
      payments.push({
        id: 70,
        memo: String(vals.communication || ""),
        communication: String(vals.communication || ""),
        amount: Number(vals.amount || 0),
        state: "posted",
        move_id: false,
      });
      return jsonResult(5);
    }
    if (model === "account.payment.register" && kwMethod === "action_create_payments") {
      paymentState = "in_payment";
      return jsonResult(true);
    }
    if (model === "account.payment" && (kwMethod === "action_post" || kwMethod === "action_validate")) {
      return jsonResult(true);
    }
    if (model === "account.move.line" && kwMethod === "reconcile") {
      residual = 0;
      paymentState = "paid";
      return jsonResult(true);
    }
    if (model === "account.move" && kwMethod === "message_post") return jsonResult(1);
    if (model === "account.move" && kwMethod === "create") return jsonResult(12);
    if (model === "account.move" && kwMethod === "action_post") return jsonResult(true);
    return jsonResult([]);
  };

  before(async () => {
    const org = await prisma.organization.create({
      data: {
        name: "Odoo Integration",
        slug: `odoo-int-${Date.now()}`,
        mfaRequiredForRoles: "[]",
      },
    });
    organizationId = org.id;
    await prisma.integrationConnector.create({
      data: {
        organizationId,
        type: "accounting_odoo",
        name: "Odoo",
        status: "connected",
        configJson: JSON.stringify({
          origin: "https://acme.odoo.com",
          database: "acme",
          username: "ap@acme.com",
          journalId: 11,
        }),
        secretsJson: JSON.stringify({
          database: "acme",
          username: "ap@acme.com",
          apiKeyEnc: encryptField("test-odoo-key"),
          uid: 7,
        }),
      },
    });
  });

  after(async () => {
    if (organizationId) {
      await prisma.organization.deleteMany({ where: { id: organizationId } });
    }
    await prisma.$disconnect();
  });

  it("paginates inbound bills, attaches the vendor PDF, and foots tax", async () => {
    const summary = await syncOdooInbound({ organizationId, actorId: "test", fetchImpl });
    assert.equal(summary.ingested, 2);
    assert.equal(summary.vendors, 1);

    const bill = await prisma.invoice.findFirstOrThrow({
      where: { organizationId, externalId: "odoo:9001" },
      include: { documents: true, extraction: true },
    });
    assert.equal(bill.totalAmount, 1075);
    assert.equal(bill.taxAmount, 75);
    assert.ok(bill.documents.some((d) => d.mimeType === "application/pdf"));
    const raw = JSON.parse(bill.extraction?.rawJson || "{}") as { paymentTerm?: string; odooPaymentState?: string };
    assert.equal(raw.paymentTerm, "30 Days");

    const credit = await prisma.invoice.findFirstOrThrow({
      where: { organizationId, externalId: "odoo-refund:44" },
    });
    assert.equal(credit.externalId, "odoo-refund:44");

    const vendor = await prisma.vendor.findFirstOrThrow({
      where: { organizationId, externalId: "odoo-partner:42" },
      include: { endpoints: true, purchaseOrders: true },
    });
    assert.equal(vendor.taxId, "12345678-0001");
    assert.ok(vendor.endpoints.some((e) => e.endpointType === "bank" && e.accountNumberLast4 === "6789"));
    assert.equal(vendor.purchaseOrders[0]?.orderedQty, 10);
    assert.equal(vendor.purchaseOrders[0]?.receivedQty, 4);
  });

  it("flags an incomplete 3-way match from Odoo received qty", async () => {
    const vendor = await prisma.vendor.findFirstOrThrow({
      where: { organizationId, externalId: "odoo-partner:42" },
    });
    const risks = await matchPurchaseOrder({
      organizationId,
      vendorId: vendor.id,
      vendorName: vendor.name,
      poNumber: "PO-5001",
      totalAmount: 1075,
      currency: "NGN",
    });
    assert.ok(risks.some((r) => r.code === "po_receive_short"));
  });

  it("registers an intent-keyed payment and reconciles only that bill", async () => {
    const invoice = await prisma.invoice.findFirstOrThrow({
      where: { organizationId, externalId: "odoo:9001" },
    });
    const intent = await prisma.paymentIntent.create({
      data: {
        organizationId,
        invoiceId: invoice.id,
        idempotencyKey: `odoo-int-${Date.now()}`,
        status: "sent",
        rail: "arc_usdc",
        amount: 0.8,
        currency: "USDC",
        beneficiaryJson: "{}",
        txHash: "0xabc123",
      },
    });
    calls.length = 0;
    const out = await writeOdooPaymentBack({
      organizationId,
      invoiceId: invoice.id,
      paymentIntentId: intent.id,
      amount: 0.8,
      currency: "USDC",
      fetchImpl,
    });
    assert.equal(out.wrote, true);
    const create = calls.find((c) => c.model === "account.payment.register" && c.method === "create");
    const vals = (create?.args[0] || {}) as { communication?: string; amount?: number; currency_id?: number; journal_id?: number };
    assert.match(String(vals.communication), new RegExp(`custara:${intent.id}`));
    assert.equal(vals.amount, 1075);
    assert.equal(vals.journal_id, 11);
    assert.equal(vals.currency_id, 1);
    const reconcile = calls.find((c) => c.model === "account.move.line" && c.method === "reconcile");
    assert.deepEqual(reconcile?.args[0], [801, 802]);
    assert.ok(calls.some((c) => c.model === "account.move" && c.method === "message_post"));
    assert.ok(calls.some((c) => c.model === "ir.attachment" && c.method === "create"));
  });

  it("skips a second write-back for the same payment intent", async () => {
    residual = 0;
    paymentState = "paid";
    const invoice = await prisma.invoice.findFirstOrThrow({
      where: { organizationId, externalId: "odoo:9001" },
    });
    const intent = await prisma.paymentIntent.findFirstOrThrow({
      where: { organizationId, invoiceId: invoice.id },
    });
    const beforeCreates = calls.filter((c) => c.model === "account.payment.register" && c.method === "create").length;
    const out = await writeOdooPaymentBack({
      organizationId,
      invoiceId: invoice.id,
      paymentIntentId: intent.id,
      amount: 0.8,
      currency: "USDC",
      fetchImpl,
    });
    const afterCreates = calls.filter((c) => c.model === "account.payment.register" && c.method === "create").length;
    assert.equal(beforeCreates, afterCreates);
    assert.ok(out.wrote === false || out.reason === "already_paid" || afterCreates === beforeCreates);
  });
});
