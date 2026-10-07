import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { cookies, headers } from "next/headers";
import { prisma } from "./db";
import { assertCapability, type AppCapability } from "./rbac";
import { resolveDisplayCurrency } from "./currency";

export type Role = "admin" | "approver" | "payer" | "viewer" | "auditor";

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  organizationId: string;
  organizationName: string;
  paymentMode: string;
  displayCurrency: string;
  country: string | null;
  ssoEnforced: boolean;
  mfaEnabled: boolean;
};

const SESSION_COOKIE = "custara_session";
const MFA_PENDING_COOKIE = "custara_mfa_pending";
const SESSION_DAYS = 14;

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function hashApiKey(rawKey: string) {
  return createHash("sha256").update(rawKey).digest("hex");
}

export function generateApiKey() {
  const raw = `cst_live_${randomBytes(24).toString("hex")}`;
  return {
    raw,
    prefix: raw.slice(0, 16),
    hash: hashApiKey(raw),
  };
}

export async function createSession(userId: string) {
  const { token, expiresAt } = await createSessionToken(userId);
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
  cookieStore.delete(MFA_PENDING_COOKIE);
}

/** Create a session row and return the raw cookie token (for E2E / Playwright). */
export async function createSessionToken(userId: string) {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  let ip: string | null = null;
  let userAgent: string | null = null;
  try {
    const h = await headers();
    ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
    userAgent = h.get("user-agent")?.slice(0, 300) || null;
  } catch {
    // Outside a Next.js request (scripts / Playwright helpers)
  }
  await prisma.session.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt,
      ip,
      userAgent,
    },
  });
  await prisma.workspaceUser.update({
    where: { id: userId },
    data: { lastLoginAt: new Date() },
  });
  return { token, expiresAt, cookieName: SESSION_COOKIE };
}

export async function setMfaPending(userId: string) {
  const cookieStore = await cookies();
  cookieStore.set(MFA_PENDING_COOKIE, userId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600,
  });
}

export async function getMfaPendingUserId() {
  const cookieStore = await cookies();
  return cookieStore.get(MFA_PENDING_COOKIE)?.value || null;
}

export async function destroySession() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (token) {
    await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
  }
  cookieStore.delete(SESSION_COOKIE);
  cookieStore.delete(MFA_PENDING_COOKIE);
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { include: { organization: true } } },
  });

  if (!session || session.expiresAt < new Date() || session.user.disabledAt) {
    if (session) await prisma.session.delete({ where: { id: session.id } }).catch(() => null);
    return null;
  }

  await prisma.session.update({
    where: { id: session.id },
    data: { lastSeenAt: new Date() },
  });

  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role: session.user.role as Role,
    organizationId: session.user.organizationId,
    organizationName: session.user.organization.name,
    paymentMode: session.user.organization.paymentMode,
    displayCurrency: resolveDisplayCurrency(session.user.organization),
    country: session.user.organization.country,
    ssoEnforced: session.user.organization.ssoEnforced,
    mfaEnabled: session.user.mfaEnabled,
  };
}

export async function requireSessionUser(roles?: Role[], capability?: AppCapability) {
  const user = await getSessionUser();
  if (!user) throw new AuthError("Unauthorized", 401);
  if (roles && !roles.includes(user.role) && user.role !== "admin") {
    throw new AuthError("Forbidden", 403);
  }
  if (capability) assertCapability(user.role, capability);
  return user;
}

export function isEmailDomainAllowed(email: string) {
  const raw = process.env.OIDC_ALLOWED_EMAIL_DOMAINS?.trim();
  if (!raw) return true;
  const domains = raw
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  const domain = email.split("@")[1]?.toLowerCase();
  return Boolean(domain && domains.includes(domain));
}

export class AuthError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export type ApiScope =
  | "invoices:read"
  | "invoices:write"
  | "approvals:write"
  | "payments:initiate"
  | "cash:read"
  | "audit:read"
  | "connectors:write";

function hashesEqual(a: string, b: string) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export async function authenticateApiKey(authHeader: string | null, required: ApiScope[]) {
  if (!authHeader?.startsWith("Bearer ")) {
    throw new AuthError("Missing API key", 401);
  }
  const raw = authHeader.slice("Bearer ".length).trim();
  if (!raw) throw new AuthError("Missing API key", 401);

  const prefix = raw.slice(0, 16);
  const candidates = await prisma.apiKey.findMany({
    where: { keyPrefix: prefix, revokedAt: null },
    include: { organization: true },
  });

  const key = candidates.find((c) => hashesEqual(c.keyHash, hashApiKey(raw)));
  if (!key) throw new AuthError("Invalid API key", 401);

  const scopes = JSON.parse(key.scopesJson) as string[];
  for (const scope of required) {
    if (!scopes.includes(scope)) throw new AuthError(`Missing scope: ${scope}`, 403);
  }

  await prisma.apiKey.update({
    where: { id: key.id },
    data: { lastUsedAt: new Date() },
  });

  return {
    apiKeyId: key.id,
    organizationId: key.organizationId,
    organizationName: key.organization.name,
    paymentMode: key.organization.paymentMode,
    scopes,
  };
}

export function canApprove(role: Role) {
  return role === "admin" || role === "approver";
}

export function canPay(role: Role) {
  return role === "admin" || role === "payer";
}

export function canAdmin(role: Role) {
  return role === "admin";
}
