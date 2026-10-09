import { createHash, randomBytes } from "crypto";
import { cookies } from "next/headers";
import * as jose from "jose";
import { prisma } from "@/lib/db";
import { createSession, isEmailDomainAllowed, setMfaPending } from "@/lib/auth";
import { userNeedsMfaChallenge } from "@/lib/mfa";

const OIDC_STATE_COOKIE = "custara_oidc_state";

export function isOidcConfigured() {
  return Boolean(
    process.env.OIDC_ISSUER?.trim() &&
      process.env.OIDC_CLIENT_ID?.trim() &&
      process.env.OIDC_CLIENT_SECRET?.trim(),
  );
}

async function discover() {
  const issuer = process.env.OIDC_ISSUER!.replace(/\/$/, "");
  const res = await fetch(`${issuer}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error("OIDC discovery failed");
  return res.json() as Promise<{
    authorization_endpoint: string;
    token_endpoint: string;
    jwks_uri: string;
    userinfo_endpoint?: string;
  }>;
}

export async function beginOidcLogin(redirectUri: string) {
  if (!isOidcConfigured()) throw new Error("OIDC is not configured");
  const discovery = await discover();
  const state = randomBytes(16).toString("hex");
  const nonce = randomBytes(16).toString("hex");
  const cookieStore = await cookies();
  cookieStore.set(OIDC_STATE_COOKIE, JSON.stringify({ state, nonce, redirectUri }), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600,
  });

  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set("client_id", process.env.OIDC_CLIENT_ID!);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  return url.toString();
}

export async function finishOidcLogin(input: {
  code: string;
  state: string;
  redirectUri: string;
}): Promise<{ userId: string; needsMfa: boolean }> {
  if (!isOidcConfigured()) throw new Error("OIDC is not configured");
  const cookieStore = await cookies();
  const raw = cookieStore.get(OIDC_STATE_COOKIE)?.value;
  if (!raw) throw new Error("Missing OIDC state");
  const saved = JSON.parse(raw) as { state: string; nonce: string; redirectUri: string };
  if (saved.state !== input.state) throw new Error("OIDC state mismatch");
  cookieStore.delete(OIDC_STATE_COOKIE);

  const discovery = await discover();
  const tokenRes = await fetch(discovery.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: process.env.OIDC_CLIENT_ID!,
      client_secret: process.env.OIDC_CLIENT_SECRET!,
    }),
  });
  if (!tokenRes.ok) throw new Error("OIDC token exchange failed");
  const tokens = (await tokenRes.json()) as { id_token?: string };
  if (!tokens.id_token) throw new Error("OIDC id_token missing");

  const jwks = jose.createRemoteJWKSet(new URL(discovery.jwks_uri));
  const { payload } = await jose.jwtVerify(tokens.id_token, jwks, {
    issuer: process.env.OIDC_ISSUER!.replace(/\/$/, ""),
    audience: process.env.OIDC_CLIENT_ID!,
  });
  if (saved.nonce && payload.nonce && payload.nonce !== saved.nonce) {
    throw new Error("OIDC nonce mismatch");
  }

  const email = String(payload.email || "").toLowerCase();
  const sub = String(payload.sub || "");
  if (!email || !sub) throw new Error("OIDC profile missing email/sub");
  if (!isEmailDomainAllowed(email)) throw new Error("Email domain not allowed for SSO");

  let user = await prisma.workspaceUser.findFirst({
    where: { OR: [{ ssoSubject: sub }, { email }] },
    include: { organization: true },
  });
  if (!user) {
    throw new Error("No Custara user mapped for this SSO identity. Ask an admin to provision your account.");
  }
  if (user.disabledAt) throw new Error("User disabled");

  user = await prisma.workspaceUser.update({
    where: { id: user.id },
    data: { ssoSubject: sub },
    include: { organization: true },
  });

  const need = await userNeedsMfaChallenge(user);
  if (need === "challenge") {
    await setMfaPending(user.id);
    return { userId: user.id, needsMfa: true };
  }

  await createSession(user.id);
  return { userId: user.id, needsMfa: false };
}
