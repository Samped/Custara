import { apiRequest } from "../client.js";
import { loadConfig, resolveRuntime } from "../config.js";
import { flagString, type Flags } from "../flags.js";
import { printResult } from "../output.js";
import { idempotencyKey, payBody } from "../payloads.js";

async function authed() {
  const runtime = resolveRuntime(await loadConfig());
  if (!runtime.apiKey) throw new Error("API key required. Run custara login --api-key.");
  return runtime;
}

export async function approvals(rest: string[], flags: Flags, asJson: boolean) {
  const runtime = await authed();
  const sub = rest[0];
  const id = rest[1];
  if (sub !== "decide" || !id) throw new Error("Use custara approvals decide <id> --decision approved|rejected");
  const decision = flagString(flags, "decision");
  if (decision !== "approved" && decision !== "rejected") {
    throw new Error("--decision must be approved or rejected");
  }
  const body = await apiRequest({
    baseUrl: runtime.baseUrl,
    token: runtime.apiKey,
    path: `/api/v1/approvals/${id}/decide`,
    body: {
      decision,
      note: flagString(flags, "note"),
      approver_email: flagString(flags, "approver-email"),
    },
  });
  printResult(body, asJson);
}

export async function pay(invoiceId: string | undefined, flags: Flags, asJson: boolean) {
  const runtime = await authed();
  if (!invoiceId) throw new Error("Use custara pay <invoiceId> --rail arc_usdc");
  const rail = flagString(flags, "rail") || "arc_usdc";
  const stepUp = flagString(flags, "step-up") || runtime.stepUp;
  const body = await apiRequest({
    baseUrl: runtime.baseUrl,
    token: runtime.apiKey,
    path: "/api/v1/payment-intents",
    body: payBody(invoiceId, rail),
    headers: {
      "Idempotency-Key": flagString(flags, "idempotency-key") || idempotencyKey("pay"),
      ...(stepUp ? { "X-Custara-Step-Up": stepUp } : {}),
    },
  });
  printResult(body, asJson);
}

export async function vendors(flags: Flags, asJson: boolean) {
  const runtime = await authed();
  const name = flagString(flags, "name");
  if (!name) throw new Error("--name is required");
  const arc = flagString(flags, "arc-address");
  const body = await apiRequest({
    baseUrl: runtime.baseUrl,
    token: runtime.apiKey,
    path: "/api/v1/vendors",
    body: {
      name,
      email: flagString(flags, "email"),
      arc_address: arc,
      currency: flagString(flags, "currency") || (arc ? "USDC" : "NGN"),
      endpoint_type: arc ? "arc_usdc" : "bank",
      account_name: flagString(flags, "account-name"),
      account_number: flagString(flags, "account-number"),
      bank_name: flagString(flags, "bank-name"),
    },
  });
  printResult(body, asJson);
}

export async function wallets(sub: string | undefined, asJson: boolean) {
  const runtime = await authed();
  if (sub === "sync") {
    const body = await apiRequest({
      baseUrl: runtime.baseUrl,
      token: runtime.apiKey,
      path: "/api/v1/wallets",
      body: { action: "sync" },
    });
    printResult(body, asJson);
    return;
  }
  if (sub === "list" || !sub) {
    const body = await apiRequest({
      baseUrl: runtime.baseUrl,
      token: runtime.apiKey,
      path: "/api/v1/wallets",
      method: "GET",
    });
    printResult(body, asJson);
    return;
  }
  throw new Error("Use custara wallets list|sync");
}

export async function cash(asJson: boolean) {
  const runtime = await authed();
  const body = await apiRequest({
    baseUrl: runtime.baseUrl,
    token: runtime.apiKey,
    path: "/api/v1/cash/forecast",
    method: "GET",
  });
  printResult(body, asJson);
}

export async function audit(sub: string | undefined, asJson: boolean) {
  const runtime = await authed();
  if (sub === "verify") {
    const body = await apiRequest({
      baseUrl: runtime.baseUrl,
      token: runtime.apiKey,
      path: "/api/v1/audit/verify",
      method: "GET",
    });
    printResult(body, asJson);
    return;
  }
  if (sub === "export" || !sub) {
    const body = await apiRequest({
      baseUrl: runtime.baseUrl,
      token: runtime.apiKey,
      path: "/api/v1/audit/export",
      method: "GET",
    });
    printResult(body, asJson);
    return;
  }
  throw new Error("Use custara audit export|verify");
}

export async function webhooks(sub: string | undefined, rest: string[], flags: Flags, asJson: boolean) {
  const runtime = await authed();
  if (sub === "list" || !sub) {
    const body = await apiRequest({
      baseUrl: runtime.baseUrl,
      token: runtime.apiKey,
      path: "/api/v1/webhooks",
      method: "GET",
    });
    printResult(body, asJson);
    return;
  }
  if (sub === "create") {
    const url = flagString(flags, "url");
    const events = flagString(flags, "events");
    if (!url || !events) throw new Error("Pass --url and --events");
    const body = await apiRequest({
      baseUrl: runtime.baseUrl,
      token: runtime.apiKey,
      path: "/api/v1/webhooks",
      body: { url, events: events.split(",").map((e) => e.trim()).filter(Boolean) },
    });
    printResult(body, asJson);
    return;
  }
  if (sub === "disable") {
    const id = rest[0];
    if (!id) throw new Error("Webhook id required");
    const body = await apiRequest({
      baseUrl: runtime.baseUrl,
      token: runtime.apiKey,
      path: `/api/v1/webhooks/${id}`,
      method: "DELETE",
    });
    printResult(body, asJson);
    return;
  }
  throw new Error("Use custara webhooks list|create|disable");
}
