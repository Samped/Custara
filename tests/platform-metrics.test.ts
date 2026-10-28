import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { railActivityTotals } from "../src/domain/platformMetrics";

function row(
  status: string,
  amount: number,
  currency = "USDC",
): {
  status: string;
  amount: number;
  currency: string;
  createdAt: Date;
  updatedAt: Date;
} {
  const at = new Date("2026-10-28T00:00:00.000Z");
  return { status, amount, currency, createdAt: at, updatedAt: at };
}

describe("railActivityTotals", () => {
  it("counts bank in as processed and adds completed USDC to volume", () => {
    const totals = railActivityTotals([
      row("completed", 2.14),
      row("pending_transfer", 2.86),
    ]);
    assert.equal(totals.processed, 2);
    assert.equal(totals.settled, 1);
    assert.equal(totals.volumeUsd, 2.14);
  });

  it("ignores invoice rails that never completed", () => {
    const totals = railActivityTotals([row("queued", 10), row("failed", 4)]);
    assert.equal(totals.processed, 2);
    assert.equal(totals.settled, 0);
    assert.equal(totals.volumeUsd, 0);
  });
});
