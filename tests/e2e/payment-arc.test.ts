import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import {
  circleConfigured,
  getSeedOrg,
  getUserByEmail,
  requireE2E,
  prisma,
} from "./helpers";
import { addDestination } from "@/domain/arc/allowlist";
import { createPaymentIntent } from "@/domain/payment";
import { runInvoicePipeline } from "@/domain/pipeline";
import { ingestInvoice } from "@/domain/ingest";

const ARC = "0x1111111111111111111111111111111111111111";

describe("e2e Arc Circle sandbox payment", () => {
  let orgId = "";

  before(async () => {
    requireE2E();
    if (!circleConfigured()) {
      console.warn("[skip] CIRCLE_API_KEY / CIRCLE_ENTITY_SECRET not set — Arc E2E skipped");
    }
    orgId = (await getSeedOrg()).id;
  });

  it("allowlists destination, approves Arc invoice, creates arc_usdc intent", async (t) => {
    if (!circleConfigured()) {
      t.skip("Circle sandbox not configured");
      return;
    }

    const admin = await getUserByEmail("admin@custara.demo");
    const payer = await getUserByEmail("payer@custara.demo");

    await addDestination({
      organizationId: orgId,
      address: ARC,
      label: "e2e arc",
      actorId: admin.id,
    });

    const invNumber = `E2E-ARC-${Date.now()}`;
    const invoice = await ingestInvoice({
      organizationId: orgId,
      actorType: "user",
      actorId: admin.id,
      source: "api",
      filename: "arc.json",
      mimeType: "application/json",
      bytes: null,
      structuredPayload: {
        vendor_name: "Arc Softgoods Inc",
        invoice_number: invNumber,
        total_amount: 1.25,
        currency: "USDC",
        arc_address: ARC,
        confidence: 0.95,
      },
      enqueue: false,
      externalId: `e2e_arc_${Date.now()}`,
    });

    await runInvoicePipeline(invoice.id, { type: "user", id: admin.id });

    let row = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    // Human-approve if held
    if (row.status === "needs_review" || row.status === "pending_approval") {
      await prisma.invoice.update({
        where: { id: row.id },
        data: { status: "approved", explanation: "e2e force approved after allowlist" },
      });
      await prisma.approvalRequest.updateMany({
        where: { invoiceId: row.id, status: "pending" },
        data: { status: "approved" },
      });
      row = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    }
    assert.equal(row.status, "approved");

    const intent = await createPaymentIntent({
      organizationId: orgId,
      invoiceId: row.id,
      idempotencyKey: `e2e-arc-${row.id}`,
      rail: "arc_usdc",
      actorType: "user",
      actorId: payer.id,
    });

    assert.equal(intent.rail, "arc_usdc");
    assert.ok(
      ["pending_transfer", "queued", "completed", "exported", "failed"].includes(intent.status),
      `unexpected status ${intent.status}`,
    );

    // Worker may still be running transfer — poll briefly
    for (let i = 0; i < 15; i++) {
      const latest = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } });
      const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: row.id } });
      if (["completed", "failed", "exported"].includes(latest.status) || ["payment_sent", "payment_failed", "reconciled"].includes(inv.status)) {
        assert.ok(true, `settled to intent=${latest.status} invoice=${inv.status}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    // Queued pending worker is acceptable for CI without long wait
    const finalIntent = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } });
    assert.ok(
      ["pending_transfer", "queued", "completed"].includes(finalIntent.status),
      `stuck intent ${finalIntent.status}`,
    );
  });
});
