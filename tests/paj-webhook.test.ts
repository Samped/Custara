import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { pajArcTxHash, verifyPajWebhook } from "../src/domain/banking/paj";

describe("verifyPajWebhook", () => {
  const secret = "whsec_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const rawBody = '{"id":"pay_1","amount":25.5}';
  const timestamp = "1788224623";

  function sign(ts: string, body: string) {
    return `v1=${createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`;
  }

  it("accepts a timely v1 signature", () => {
    const nowMs = Number(timestamp) * 1000;
    assert.equal(
      verifyPajWebhook({
        rawBody,
        timestamp,
        signature: sign(timestamp, rawBody),
        secret,
        nowMs,
      }),
      true,
    );
  });

  it("rejects a stale timestamp", () => {
    assert.equal(
      verifyPajWebhook({
        rawBody,
        timestamp,
        signature: sign(timestamp, rawBody),
        secret,
        nowMs: Number(timestamp) * 1000 + 400_000,
      }),
      false,
    );
  });

  it("rejects a mutated body", () => {
    assert.equal(
      verifyPajWebhook({
        rawBody: '{"id":"pay_1","amount":1}',
        timestamp,
        signature: sign(timestamp, rawBody),
        secret,
        nowMs: Number(timestamp) * 1000,
      }),
      false,
    );
  });

  it("only treats 0x hashes as Arc verify links", () => {
    assert.equal(pajArcTxHash("0xabc123"), "0xabc123");
    assert.equal(pajArcTxHash("2oLx7XrXP7Df9dZca1difJ91"), null);
    assert.equal(pajArcTxHash(null), null);
  });
});
