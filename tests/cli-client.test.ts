import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { apiRequest } from "../cli/src/client";
import { loadConfig, resolveRuntime, saveConfig } from "../cli/src/config";
import { parseFlags } from "../cli/src/flags";
import { ingestBody, payBody } from "../cli/src/payloads";

test("config file stores the API key and URL", async () => {
  const dir = await mkdtemp(join(tmpdir(), "custara-cli-"));
  const path = join(dir, "config.json");
  await saveConfig({ baseUrl: "http://localhost:3000/", apiKey: "cst_live_example" }, path);
  const loaded = await loadConfig(path);
  const runtime = resolveRuntime(loaded, {});
  assert.equal(runtime.baseUrl, "http://localhost:3000");
  assert.equal(runtime.apiKey, "cst_live_example");
  assert.equal(resolveRuntime(loaded, { CUSTARA_API_KEY: "cst_live_env" }).apiKey, "cst_live_env");
});

test("ingest and pay payloads match the partner API", () => {
  const invoice = ingestBody({
    vendor: "Acme Supplies",
    number: "INV-1",
    amount: "25",
    currency: "USDC",
    due: "2026-10-20",
    arcAddress: "0xd9792bf937d9673ab08c452fe55ec4e26632be54",
    externalId: "erp-1",
  });
  assert.equal(invoice.sync, true);
  assert.equal(invoice.currency, "USDC");
  assert.equal(invoice.document.vendor_name, "Acme Supplies");
  assert.equal(invoice.document.total_amount, 25);
  assert.equal(invoice.document.arc_address, "0xd9792bf937d9673ab08c452fe55ec4e26632be54");
  assert.deepEqual(payBody("inv_1", "arc_usdc"), { invoice_id: "inv_1", rail: "arc_usdc" });
});

test("pay request sends the idempotency key and step-up header", async () => {
  const original = globalThis.fetch;
  const seen = {
    url: "",
    authorization: null as string | null,
    idempotency: null as string | null,
    stepUp: null as string | null,
    body: null as unknown,
  };
  globalThis.fetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    seen.url = String(url);
    seen.authorization = headers.get("authorization");
    seen.idempotency = headers.get("idempotency-key");
    seen.stepUp = headers.get("x-custara-step-up");
    seen.body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ id: "pi_1", status: "pending_transfer" }), { status: 201 });
  };
  try {
    await apiRequest({
      baseUrl: "http://localhost:3000",
      token: "cst_live_test",
      path: "/api/v1/payment-intents",
      body: payBody("inv_1"),
      headers: { "Idempotency-Key": "pay-1", "X-Custara-Step-Up": "step" },
    });
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(seen.url, "http://localhost:3000/api/v1/payment-intents");
  assert.equal(seen.authorization, "Bearer cst_live_test");
  assert.equal(seen.idempotency, "pay-1");
  assert.equal(seen.stepUp, "step");
  assert.deepEqual(seen.body, { invoice_id: "inv_1", rail: "arc_usdc" });
});

test("command flags keep positionals", () => {
  const parsed = parseFlags(["pay", "inv_1", "--rail", "arc_usdc", "--json"]);
  assert.deepEqual(parsed.positionals, ["pay", "inv_1"]);
  assert.equal(parsed.flags.rail, "arc_usdc");
  assert.equal(parsed.flags.json, true);
});
