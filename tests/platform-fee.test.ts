import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  formatBuyerPayLine,
  platformFeeBps,
  platformFeeUsdc,
} from "../src/domain/platformFee";
import { arcExplorerTxUrl } from "../src/domain/receipts";
import { mainnetPayGated } from "../src/domain/arc/config";

const KEYS = [
  "PLATFORM_FEE_BPS",
  "PLATFORM_FEE_MIN_USDC",
  "PLATFORM_FEE_ADDRESS",
  "ARC_CHAIN",
  "ARC_PAYMENTS_LIVE",
] as const;

const prior = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const key of KEYS) {
    if (prior[key] === undefined) delete process.env[key];
    else process.env[key] = prior[key];
  }
});

describe("platformFeeUsdc", () => {
  it("is zero without a treasury address", () => {
    delete process.env.PLATFORM_FEE_ADDRESS;
    assert.equal(platformFeeUsdc(8.78), 0);
  });

  it("takes 75 bps with a 0.10 floor", () => {
    process.env.PLATFORM_FEE_ADDRESS = "0x404e12b800000000000000000000000000000001";
    process.env.PLATFORM_FEE_BPS = "75";
    process.env.PLATFORM_FEE_MIN_USDC = "0.10";
    assert.equal(platformFeeBps(), 75);
    assert.equal(platformFeeUsdc(8.78), 0.1);
    assert.equal(platformFeeUsdc(20), 0.15);
    assert.match(formatBuyerPayLine(8.78), /8\.78 USDC to vendor \+ 0\.10 USDC Custara fee \(0\.75%\)/);
  });
});

describe("arc explorer + mainnet gate", () => {
  it("points explorer at the chain", () => {
    process.env.ARC_CHAIN = "ARC-TESTNET";
    assert.equal(arcExplorerTxUrl("0xabc"), "https://explorer.testnet.arc.io/tx/0xabc");
    process.env.ARC_CHAIN = "ARC";
    assert.equal(arcExplorerTxUrl("0xabc"), "https://arc.etherscan.io/tx/0xabc");
  });

  it("gates mainnet pay until ARC_PAYMENTS_LIVE", () => {
    process.env.ARC_CHAIN = "ARC";
    delete process.env.ARC_PAYMENTS_LIVE;
    assert.equal(mainnetPayGated(), true);
    process.env.ARC_PAYMENTS_LIVE = "true";
    assert.equal(mainnetPayGated(), false);
  });
});
