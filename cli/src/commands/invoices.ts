import { readFile } from "node:fs/promises";
import { apiRequest } from "../client.js";
import { loadConfig, resolveRuntime } from "../config.js";
import { flagString, type Flags } from "../flags.js";
import { printResult } from "../output.js";
import { idempotencyKey, ingestBody } from "../payloads.js";

function runtimeOrThrow(apiKey: string, baseUrl: string) {
  if (!apiKey) throw new Error("API key required. Run custara login --api-key.");
  return { apiKey, baseUrl };
}

export async function invoices(sub: string | undefined, rest: string[], flags: Flags, asJson: boolean) {
  const runtime = resolveRuntime(await loadConfig());
  const auth = runtimeOrThrow(runtime.apiKey, runtime.baseUrl);
  if (sub === "list") {
    const body = await apiRequest({
      baseUrl: auth.baseUrl,
      token: auth.apiKey,
      path: "/api/v1/invoices",
      method: "GET",
    });
    printResult(body, asJson);
    return;
  }
  if (sub === "get" || sub === "analysis") {
    const id = rest[0];
    if (!id) throw new Error("Invoice id required");
    const path = sub === "get" ? `/api/v1/invoices/${id}` : `/api/v1/invoices/${id}/analysis`;
    const body = await apiRequest({ baseUrl: auth.baseUrl, token: auth.apiKey, path, method: "GET" });
    printResult(body, asJson);
    return;
  }
  if (sub === "bulk") {
    const file = flagString(flags, "file");
    if (!file) throw new Error("--file is required");
    const csv = await readFile(file, "utf8");
    const body = await apiRequest({
      baseUrl: auth.baseUrl,
      token: auth.apiKey,
      path: "/api/v1/invoices/bulk",
      body: { csv, sync: true },
      headers: { "Idempotency-Key": idempotencyKey("bulk") },
    });
    printResult(body, asJson);
    return;
  }
  if (sub === "ingest") {
    const file = flagString(flags, "file");
    const fileBody = file ? ((JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>) || null) : null;
    const payload = ingestBody({
      fileBody,
      vendor: flagString(flags, "vendor"),
      number: flagString(flags, "number"),
      amount: flagString(flags, "amount"),
      currency: flagString(flags, "currency") || "USDC",
      due: flagString(flags, "due"),
      arcAddress: flagString(flags, "arc-address"),
      externalId: flagString(flags, "external-id"),
    });
    const body = await apiRequest({
      baseUrl: auth.baseUrl,
      token: auth.apiKey,
      path: "/api/v1/invoices",
      body: payload,
      headers: { "Idempotency-Key": flagString(flags, "idempotency-key") || idempotencyKey("erp") },
    });
    printResult(body, asJson);
    return;
  }
  throw new Error("Use custara invoices list|get|analysis|ingest|bulk");
}
