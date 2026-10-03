/**
 * Policy / money-control unit tests (no DB).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluatePolicy } from "../src/domain/policy";
import { PAYABLESAI_STRICT_RULES } from "../src/lib/types";
import type { RiskItem } from "../src/domain/risk";

describe("evaluatePolicy money controls", () => {
  it("blocks auto-approve on low_confidence hard risk", () => {
    const risks: RiskItem[] = [
      { code: "low_confidence", severity: "hard", message: "low" },
    ];
    const result = evaluatePolicy({
      amount: 100,
      currency: "NGN",
      risks,
      isNewVendor: false,
      bankChanged: false,
      rules: PAYABLESAI_STRICT_RULES,
    });
    assert.equal(result.decision, "hold");
  });

  it("uses USDC auto-approve ceiling", () => {
    const result = evaluatePolicy({
      amount: 6000,
      currency: "USDC",
      risks: [],
      isNewVendor: false,
      bankChanged: false,
      rules: { ...PAYABLESAI_STRICT_RULES, autoApproveMaxUsdc: 5000 },
    });
    assert.notEqual(result.decision, "auto_approve");
  });

  it("auto-approves under USDC ceiling with no hard risks", () => {
    const result = evaluatePolicy({
      amount: 100,
      currency: "USDC",
      risks: [],
      isNewVendor: false,
      bankChanged: false,
      rules: PAYABLESAI_STRICT_RULES,
    });
    assert.equal(result.decision, "auto_approve");
  });

  it("holds unknown Arc destination", () => {
    const risks: RiskItem[] = [
      { code: "destination_not_allowlisted", severity: "hard", message: "no" },
    ];
    const result = evaluatePolicy({
      amount: 100,
      currency: "USDC",
      risks,
      isNewVendor: false,
      bankChanged: false,
      rules: PAYABLESAI_STRICT_RULES,
      hasArcDestination: true,
    });
    assert.equal(result.decision, "hold");
  });
});
