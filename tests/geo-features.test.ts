import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isNigeriaWorkspace } from "../src/lib/geoFeatures";
import { paymentKindLabel, paymentIntentTitle } from "../src/lib/format";

describe("isNigeriaWorkspace", () => {
  it("matches NG regardless of case or spaces", () => {
    assert.equal(isNigeriaWorkspace({ country: "NG" }), true);
    assert.equal(isNigeriaWorkspace({ country: " ng " }), true);
    assert.equal(isNigeriaWorkspace({ country: "US" }), false);
    assert.equal(isNigeriaWorkspace({ country: null }), false);
    assert.equal(isNigeriaWorkspace({}), false);
  });
});

describe("payment kind labels", () => {
  it("maps ledger types", () => {
    assert.equal(paymentKindLabel("invoice"), "Bill");
    assert.equal(paymentKindLabel("direct"), "Client");
    assert.equal(paymentKindLabel("paj_onramp"), "Bank in");
    assert.equal(paymentKindLabel("paj_offramp"), "Bank out");
  });

  it("titles invoice-less intents", () => {
    assert.equal(paymentIntentTitle({ kind: "direct" }), "Client payout");
    assert.equal(paymentIntentTitle({ kind: "paj_onramp" }), "Bank fund");
    assert.equal(paymentIntentTitle({ kind: "paj_offramp" }), "Bank withdraw");
    assert.equal(
      paymentIntentTitle({ kind: "invoice", invoice: { invoiceNumber: "INV-9", id: "abc" } }),
      "INV-9",
    );
  });
});
