import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { getSeedOrg, getUserByEmail, requireE2E, prisma } from "./helpers";
import { createPaymentIntent } from "@/domain/payment";
import { reconcileSettlement } from "@/domain/cash";
import { ingestInvoice } from "@/domain/ingest";
import { runInvoicePipeline } from "@/domain/pipeline";

describe("e2e Nigeria payment export", () => {
  let orgId = "";

  before(async () => {
    requireE2E();
    orgId = (await getSeedOrg()).id;
  });

  it("creates nigeria_sandbox export for approved NGN invoice", async () => {
    const admin = await getUserByEmail("admin@custara.demo");
    const payer = await getUserByEmail("payer@custara.demo");
    const stamp = Date.now();

    const created = await ingestInvoice({
      organizationId: orgId,
      actorType: "user",
      actorId: admin.id,
      source: "api",
      externalId: `e2e_ng_pay_${stamp}`,
      enqueue: false,
      structuredPayload: {
        vendor_name: "Northern Haulage Ltd",
        invoice_number: `E2E-NG-PAY-${stamp}`,
        total_amount: 22000,
        currency: "NGN",
        account_name: "Northern Haulage Ltd",
        account_number: "0123456789",
        bank_name: "Access Bank",
        confidence: 0.95,
      },
    });
    await runInvoicePipeline(created.id, { type: "user", id: admin.id });

    let invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: created.id } });
    // Clear hard risks so pay-time guards allow Nigeria export (E2E focuses on rail, not risk replay)
    await prisma.riskAssessment.deleteMany({ where: { invoiceId: invoice.id } });
    if (invoice.status !== "approved") {
      await prisma.invoice.update({
        where: { id: invoice.id },
        data: { status: "approved", explanation: "e2e force approve for nigeria rail" },
      });
      await prisma.approvalRequest.updateMany({
        where: { invoiceId: invoice.id, status: "pending" },
        data: { status: "approved" },
      });
      invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: created.id } });
    }

    const intent = await createPaymentIntent({
      organizationId: orgId,
      invoiceId: invoice.id,
      idempotencyKey: `e2e-ng-${invoice.id}-${stamp}`,
      rail: "nigeria_sandbox",
      actorType: "user",
      actorId: payer.id,
    });

    assert.ok(intent.exportPath || intent.status === "exported", JSON.stringify(intent));
    const refreshed = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    assert.ok(["payment_sent", "payment_queued"].includes(refreshed.status), refreshed.status);

    if (refreshed.status === "payment_sent") {
      await reconcileSettlement({
        organizationId: orgId,
        invoiceId: invoice.id,
        amount: intent.amount,
        paymentIntentId: intent.id,
        actorType: "user",
        actorId: payer.id,
      });
      const done = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
      assert.equal(done.status, "reconciled");
    }
  });
});
