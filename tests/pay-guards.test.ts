import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { payBlockingHardRisks } from "../src/domain/payGuards";

describe("payBlockingHardRisks", () => {
  it("ignores a missing-PO risk after the bill is approved", () => {
    const hard = payBlockingHardRisks(
      [{ code: "contract_required", severity: "hard" }],
      { requirePurchaseOrder: true, invoiceStatus: "approved" },
    );
    assert.equal(hard.length, 0);
  });

  it("ignores a missing-PO risk when the policy no longer requires one", () => {
    const hard = payBlockingHardRisks(
      [{ code: "contract_required", severity: "hard" }],
      { requirePurchaseOrder: false, invoiceStatus: "needs_review" },
    );
    assert.equal(hard.length, 0);
  });

  it("still blocks other hard risks", () => {
    const hard = payBlockingHardRisks(
      [{ code: "odoo_fiscal_lock", severity: "hard" }],
      { requirePurchaseOrder: false, invoiceStatus: "approved" },
    );
    assert.equal(hard[0]?.code, "odoo_fiscal_lock");
  });
});
