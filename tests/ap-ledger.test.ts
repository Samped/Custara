import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { agingBucket, invoiceOpenAmount, vendorAgedFromInvoices } from "../src/domain/apLedger";

describe("invoice residual", () => {
  it("prefers residual over the header total", () => {
    assert.equal(invoiceOpenAmount({ residualAmount: 250, totalAmount: 1000 }), 250);
    assert.equal(invoiceOpenAmount({ residualAmount: null, totalAmount: 1000 }), 1000);
    assert.equal(invoiceOpenAmount({ residualAmount: 0, totalAmount: 1000 }), 0);
  });
});

describe("aged payable buckets", () => {
  const now = new Date("2026-10-24T00:00:00.000Z");

  it("treats a future due date as current", () => {
    assert.equal(agingBucket(new Date("2026-11-01T00:00:00.000Z"), now), "current");
  });

  it("splits overdue bills into 30-day windows", () => {
    assert.equal(agingBucket(new Date("2026-10-10T00:00:00.000Z"), now), "d1_30");
    assert.equal(agingBucket(new Date("2026-09-10T00:00:00.000Z"), now), "d31_60");
    assert.equal(agingBucket(new Date("2026-08-10T00:00:00.000Z"), now), "d61_90");
    assert.equal(agingBucket(new Date("2026-06-01T00:00:00.000Z"), now), "d90");
  });

  it("sums vendor residual into buckets", () => {
    const aged = vendorAgedFromInvoices(
      [
        { residualAmount: 100, totalAmount: 100, currency: "USD", dueDate: new Date("2026-11-01") },
        { residualAmount: 40, totalAmount: 40, currency: "USD", dueDate: new Date("2026-06-01") },
      ],
      "USD",
    );
    assert.equal(aged.current, 100);
    assert.equal(aged.d90, 40);
    assert.equal(aged.open, 140);
  });
});
