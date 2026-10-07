import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  convertAmount,
  currencyFromCountry,
  resolveDisplayCurrency,
  sumInCurrency,
} from "../src/lib/currency";

describe("currency helpers", () => {
  it("defaults to USD when country is missing", () => {
    assert.equal(currencyFromCountry(null), "USD");
    assert.equal(currencyFromCountry(""), "USD");
    assert.equal(resolveDisplayCurrency({}), "USD");
  });

  it("maps country to local currency", () => {
    assert.equal(currencyFromCountry("NG"), "NGN");
    assert.equal(currencyFromCountry("gb"), "GBP");
    assert.equal(currencyFromCountry("US"), "USD");
  });

  it("prefers explicit displayCurrency over country", () => {
    assert.equal(resolveDisplayCurrency({ country: "NG", displayCurrency: "EUR" }), "EUR");
    assert.equal(resolveDisplayCurrency({ country: "NG", displayCurrency: null }), "NGN");
  });

  it("converts amounts for dashboard display", () => {
    assert.equal(convertAmount(1600, "NGN", "USD"), 1);
    assert.equal(convertAmount(1, "USD", "USDC"), 1);
    const sum = sumInCurrency(
      [
        { amount: 1600, currency: "NGN" },
        { amount: 1, currency: "USD" },
      ],
      "USD",
    );
    assert.equal(sum, 2);
  });
});
