import { apiRequest } from "../client.js";
import { loadConfig, resolveRuntime, saveConfig, type CustaraConfig } from "../config.js";
import { flagString, type Flags } from "../flags.js";
import { printResult } from "../output.js";
import { prompt } from "../prompt.js";

export async function login(flags: Flags, asJson: boolean) {
  const current = await loadConfig();
  const next: CustaraConfig = { ...current };
  const url = flagString(flags, "url");
  if (url) next.baseUrl = url.replace(/\/$/, "");
  const apiKey = flagString(flags, "api-key");
  const email = flagString(flags, "email");
  if (!apiKey && !email) {
    throw new Error("Pass --api-key, --email, or both.");
  }
  if (apiKey) next.apiKey = apiKey;
  if (email) {
    const runtime = resolveRuntime(next);
    const started = (await apiRequest({
      baseUrl: runtime.baseUrl,
      token: "",
      path: "/api/v1/cli/login/start",
      body: { email },
    })) as { devCode?: string; emailed?: boolean };
    if (started.devCode) console.error(`Dev code: ${started.devCode}`);
    else if (started.emailed) console.error(`Code sent to ${email}`);
    const code = flagString(flags, "code") || (await prompt("Email code: "));
    if (!code) throw new Error("Email code required");
    const finished = (await apiRequest({
      baseUrl: runtime.baseUrl,
      token: "",
      path: "/api/v1/cli/login/finish",
      body: { email, code },
    })) as { token: string; email: string };
    next.userToken = finished.token;
    next.email = finished.email;
    await saveConfig(next);
    printResult({ ok: true, email: finished.email, baseUrl: next.baseUrl, apiKey: Boolean(next.apiKey) }, asJson);
    return;
  }
  await saveConfig(next);
  printResult({ ok: true, baseUrl: next.baseUrl, apiKey: true }, asJson);
}

export async function logout(asJson: boolean) {
  const current = await loadConfig();
  await saveConfig({ baseUrl: current.baseUrl });
  printResult({ ok: true, baseUrl: current.baseUrl }, asJson);
}

export async function whoami(asJson: boolean) {
  const runtime = resolveRuntime(await loadConfig());
  const parts: Record<string, unknown> = { baseUrl: runtime.baseUrl };
  if (runtime.userToken) {
    parts.user = await apiRequest({
      baseUrl: runtime.baseUrl,
      token: runtime.userToken,
      path: "/api/v1/cli/whoami",
      method: "GET",
    });
  }
  if (runtime.apiKey) {
    parts.apiKey = await apiRequest({
      baseUrl: runtime.baseUrl,
      token: runtime.apiKey,
      path: "/api/v1/cli/whoami",
      method: "GET",
    });
  }
  if (!runtime.userToken && !runtime.apiKey) {
    throw new Error("Not logged in. Run custara login --api-key or custara login --email.");
  }
  printResult(parts, asJson);
}

export async function mfa(action: string, positional: string | undefined, flags: Flags, asJson: boolean) {
  const runtime = resolveRuntime(await loadConfig());
  if (!runtime.userToken) throw new Error("Run custara login --email before MFA commands.");
  if (action === "enroll") {
    const body = await apiRequest({
      baseUrl: runtime.baseUrl,
      token: runtime.userToken,
      path: "/api/v1/cli/mfa",
      body: { action: "begin" },
    });
    printResult(body, asJson);
    return;
  }
  const code = positional || flagString(flags, "code");
  if (!code) throw new Error("Pass the authenticator code.");
  const endpointAction = action === "confirm" ? "confirm" : action === "disable" ? "disable" : "";
  if (!endpointAction) throw new Error("Use custara mfa enroll, confirm, or disable.");
  const body = await apiRequest({
    baseUrl: runtime.baseUrl,
    token: runtime.userToken,
    path: "/api/v1/cli/mfa",
    body: { action: endpointAction, code },
  });
  printResult(body, asJson);
}

export async function orgSet(flags: Flags, asJson: boolean) {
  const runtime = resolveRuntime(await loadConfig());
  if (!runtime.userToken) throw new Error("Run custara login --email before org commands.");
  const paymentMode = flagString(flags, "payment-mode");
  const autopay = flagString(flags, "autopay");
  const threshold = flagString(flags, "mfa-threshold");
  if (!paymentMode && autopay == null && !threshold) {
    throw new Error("Pass --payment-mode, --autopay, or --mfa-threshold.");
  }
  const results: unknown[] = [];
  if (paymentMode || autopay != null) {
    results.push(
      await apiRequest({
        baseUrl: runtime.baseUrl,
        token: runtime.userToken,
        path: "/api/v1/cli/settings",
        body: {
          action: "save_org",
          ...(paymentMode ? { paymentMode } : {}),
          ...(autopay != null ? { autoPayEnabled: autopay } : {}),
        },
      }),
    );
  }
  if (threshold) {
    results.push(
      await apiRequest({
        baseUrl: runtime.baseUrl,
        token: runtime.userToken,
        path: "/api/v1/cli/settings",
        body: { action: "save_mfa_threshold", mfaPayThresholdUsd: Number(threshold) },
      }),
    );
  }
  printResult(results.length === 1 ? results[0] : results, asJson);
}

export async function teamInvite(flags: Flags, asJson: boolean) {
  const runtime = resolveRuntime(await loadConfig());
  if (!runtime.userToken) throw new Error("Run custara login --email before team commands.");
  const email = flagString(flags, "email");
  if (!email) throw new Error("--email is required");
  const body = await apiRequest({
    baseUrl: runtime.baseUrl,
    token: runtime.userToken,
    path: "/api/v1/cli/settings",
    body: {
      action: "invite_member",
      email,
      name: flagString(flags, "name"),
      role: flagString(flags, "role") || "viewer",
    },
  });
  printResult(body, asJson);
}
