import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { receivableReminderDue } from "../src/domain/collections";
import { averageDayGap } from "../src/domain/platformMetrics";
import { matchPurchaseOrder } from "../src/domain/contracts";

describe("customer collection cadence", () => {
  const due = new Date("2026-01-01T00:00:00.000Z");

  it("waits a week and sends one reminder for fast payers", () => {
    const tooSoon = new Date("2026-01-03T00:00:00.000Z");
    assert.equal(
      receivableReminderDue({
        now: tooSoon,
        dueDate: due,
        lastReminderAt: null,
        reminderCount: 0,
        behaviorScore: 90,
      }),
      false,
    );
    const weekLater = new Date("2026-01-08T00:00:00.000Z");
    assert.equal(
      receivableReminderDue({
        now: weekLater,
        dueDate: due,
        lastReminderAt: null,
        reminderCount: 0,
        behaviorScore: 90,
      }),
      true,
    );
    assert.equal(
      receivableReminderDue({
        now: new Date("2026-01-20T00:00:00.000Z"),
        dueDate: due,
        lastReminderAt: weekLater,
        reminderCount: 1,
        behaviorScore: 90,
      }),
      false,
    );
  });

  it("reminds slow payers the day after due, then every two days, and stops at six", () => {
    assert.equal(
      receivableReminderDue({
        now: new Date("2026-01-01T12:00:00.000Z"),
        dueDate: due,
        lastReminderAt: null,
        reminderCount: 0,
        behaviorScore: 20,
      }),
      false,
    );
    assert.equal(
      receivableReminderDue({
        now: new Date("2026-01-02T00:00:00.000Z"),
        dueDate: due,
        lastReminderAt: null,
        reminderCount: 0,
        behaviorScore: 20,
      }),
      true,
    );
    const sent = new Date("2026-01-02T00:00:00.000Z");
    assert.equal(
      receivableReminderDue({
        now: new Date("2026-01-03T00:00:00.000Z"),
        dueDate: due,
        lastReminderAt: sent,
        reminderCount: 1,
        behaviorScore: 20,
      }),
      false,
    );
    assert.equal(
      receivableReminderDue({
        now: new Date("2026-01-04T00:00:00.000Z"),
        dueDate: due,
        lastReminderAt: sent,
        reminderCount: 1,
        behaviorScore: 20,
      }),
      true,
    );
    assert.equal(
      receivableReminderDue({
        now: new Date("2026-02-01T00:00:00.000Z"),
        dueDate: due,
        lastReminderAt: null,
        reminderCount: 6,
        behaviorScore: 20,
      }),
      false,
    );
  });
});

describe("days outstanding windows", () => {
  it("returns null for an empty window and averages the other", () => {
    const start = new Date("2026-01-01T00:00:00.000Z");
    const mid = new Date("2026-04-01T00:00:00.000Z");
    const end = new Date("2026-07-01T00:00:00.000Z");
    const rows = [
      { at: new Date("2026-02-01T00:00:00.000Z"), from: new Date("2026-01-01T00:00:00.000Z") },
      { at: new Date("2026-05-11T00:00:00.000Z"), from: new Date("2026-05-01T00:00:00.000Z") },
    ];
    assert.equal(averageDayGap(rows, start, mid), 31);
    assert.equal(averageDayGap(rows, mid, end), 10);
    assert.equal(averageDayGap([], start, mid), null);
  });
});

describe("contract hold", () => {
  it("emits a hard risk when a purchase order is required and missing", async () => {
    const risks = await matchPurchaseOrder({
      organizationId: "org",
      vendorId: "vendor",
      vendorName: "Acme",
      poNumber: "",
      totalAmount: 10,
      currency: "USD",
      requirePurchaseOrder: true,
    });
    assert.equal(risks.length, 1);
    assert.equal(risks[0]?.code, "contract_required");
    assert.equal(risks[0]?.severity, "hard");
  });

  it("does not flag a missing purchase order when the policy does not require one", async () => {
    const risks = await matchPurchaseOrder({
      organizationId: "org",
      vendorId: "vendor",
      vendorName: "Acme",
      poNumber: null,
      totalAmount: 10,
      currency: "USD",
      requirePurchaseOrder: false,
    });
    assert.deepEqual(risks, []);
  });
});
