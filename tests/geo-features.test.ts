import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isNigeriaWorkspace, isPajBankWorkspace, pajFiatCurrency } from "../src/lib/geoFeatures";
import { paymentKindLabel, paymentIntentTitle } from "../src/lib/format";

describe("isNigeriaWorkspace", () => {
  it("matches NG regardless of case or spaces", () => {
    assert.equal(isNigeriaWorkspace({ country: "NG" }), true);
    assert.equal(isNigeriaWorkspace({ country: " ng " }), true);
    assert.equal(isNigeriaWorkspace({ country: "Nigeria" }), true);
    assert.equal(isNigeriaWorkspace({ country: "US" }), false);
    assert.equal(isNigeriaWorkspace({ country: null }), false);
    assert.equal(isNigeriaWorkspace({}), false);
  });

  it("treats NGN books as Nigeria when country was never stored", () => {
    assert.equal(isNigeriaWorkspace({ country: null, displayCurrency: "NGN" }), true);
    assert.equal(isNigeriaWorkspace({ country: "", displayCurrency: "ngn" }), true);
    assert.equal(isNigeriaWorkspace({ country: null, displayCurrency: "USD" }), false);
  });
});

describe("isPajBankWorkspace", () => {
  it("opens bank rails for PAJ African markets", () => {
    assert.equal(isPajBankWorkspace({ country: "GH" }), true);
    assert.equal(isPajBankWorkspace({ country: "Kenya" }), true);
    assert.equal(isPajBankWorkspace({ country: "TZ" }), true);
    assert.equal(isPajBankWorkspace({ country: "ZA" }), true);
    assert.equal(isPajBankWorkspace({ country: null, displayCurrency: "GHS" }), true);
    assert.equal(isPajBankWorkspace({ country: null, displayCurrency: "KES" }), true);
    assert.equal(isPajBankWorkspace({ country: "US" }), false);
    assert.equal(isPajBankWorkspace({ displayCurrency: "USD" }), false);
  });

  it("maps the local fiat PAJ should quote", () => {
    assert.equal(pajFiatCurrency({ country: "NG" }), "NGN");
    assert.equal(pajFiatCurrency({ country: "Ghana" }), "GHS");
    assert.equal(pajFiatCurrency({ country: "Tanzania" }), "TZS");
    assert.equal(pajFiatCurrency({ displayCurrency: "ZAR" }), "ZAR");
    assert.equal(pajFiatCurrency({ country: "US" }), null);
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
  });
});
