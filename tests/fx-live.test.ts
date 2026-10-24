import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { clearFxBookForTests, peekFxBook } from "../src/lib/currency";
import { quoteArcSettlement, refreshLiveFxBook } from "../src/domain/fx/liveQuote";

describe("live FX quotes", { concurrency: false }, () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearFxBookForTests();
    delete process.env.CIRCLE_API_KEY;
  });

  it("builds a book from Coinbase and prefers Circle CPN for NGN", async () => {
    process.env.CIRCLE_API_KEY = "test-key";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("coinbase.com")) {
        return new Response(
          JSON.stringify({ data: { currency: "USD", rates: { NGN: "1500", EUR: "0.92" } } }),
          { status: 200 },
        );
      }
      if (url.includes("/v1/cpn/quotes")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "q-ngn",
                exchangeRate: { pair: "USDC/NGN", rate: "1480.25" },
                sourceAmount: { amount: "6.756", currency: "USDC" },
                destinationAmount: { amount: "10000", currency: "NGN" },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    const book = await refreshLiveFxBook({ force: true });
    assert.equal(book.ok, true);
    assert.equal(book.unitsPerUsd.NGN, 1480.25);
    assert.equal(book.sources.NGN, "circle_cpn");
    assert.equal(book.unitsPerUsd.EUR, 0.92);
    assert.equal(book.sources.EUR, "coinbase");

    const quote = await quoteArcSettlement(2960.5, "NGN");
    assert.equal(quote.quoted, true);
    assert.equal(quote.currency, "USDC");
    assert.ok(Math.abs(quote.amount - 2) < 0.01);
    assert.equal(quote.source, "circle_cpn");
  });

  it("uses Coinbase when Circle is silent", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("coinbase.com")) {
        return new Response(
          JSON.stringify({ data: { currency: "USD", rates: { NGN: "1605.4" } } }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 503 });
    }) as typeof fetch;

    const quote = await quoteArcSettlement(1605.4, "NGN", { fresh: true });
    assert.equal(quote.quoted, true);
    assert.equal(quote.amount, 1);
    assert.equal(quote.source, "coinbase");
  });

  it("refuses a fresh settlement quote when every feed fails", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 503 })) as typeof fetch;
    const quote = await quoteArcSettlement(3000, "NGN", { fresh: true });
    assert.equal(quote.quoted, false);
    assert.equal(quote.amount, 0);
    assert.equal(peekFxBook()?.unitsPerUsd.NGN, undefined);
  });
});
