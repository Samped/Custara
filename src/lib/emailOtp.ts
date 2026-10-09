import { createHash, randomInt } from "crypto";
import { headers } from "next/headers";
import { nanoid } from "nanoid";
import { prisma } from "./db";
import { writeAudit } from "./audit";
import { createSession, hashToken, isEmailDomainAllowed, setMfaPending } from "./auth";
import { isOidcConfigured } from "./oidc";
import { userNeedsMfaChallenge } from "./mfa";
import { ensureAgentWallet } from "@/domain/arc/wallets";
import { isMailConfigured, otpEmailContent, sendEmail } from "./mail";

const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

/** Production defaults to invite-only; set ALLOW_JIT_ORG_CREATION=true for demos. */
export function allowJitOrgCreation() {
  if (process.env.ALLOW_JIT_ORG_CREATION === "true") return true;
  if (process.env.ALLOW_JIT_ORG_CREATION === "false") return false;
  return process.env.NODE_ENV !== "production";
}

export function isCircleUserAuthConfigured() {
  return Boolean(process.env.CIRCLE_API_KEY?.trim() && getCircleAppId());
}

export function getCircleAppId() {
  return (process.env.NEXT_PUBLIC_CIRCLE_APP_ID || process.env.CIRCLE_APP_ID || "").trim();
}

function clientIpFromHeaders(h: Headers) {
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
}

/** Custara-owned email OTP (Resend/SMTP). Preferred when Circle App ID is not set. */
export async function requestEmailOtp(email: string) {
  const normalized = email.trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) throw new Error("Valid email required");

  const code = String(randomInt(100000, 999999));
  const h = await headers();
  const ip = clientIpFromHeaders(h);

  await prisma.loginChallenge.updateMany({
    where: { email: normalized, consumedAt: null },
    data: { consumedAt: new Date() },
  });

  await prisma.loginChallenge.create({
    data: {
      email: normalized,
      codeHash: hashToken(code),
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
      ip,
    },
  });

  if (isMailConfigured()) {
    const content = otpEmailContent(code);
    await sendEmail({ to: normalized, ...content });
    console.info(`[custara:otp] emailed code to ${normalized}`);
    return {
      mode: "email" as const,
      email: normalized,
      expiresInSec: OTP_TTL_MS / 1000,
      emailed: true,
    };
  }

  // Local fallback when mail is not configured
  console.info(`[custara:otp] ${normalized} → ${code} (expires in 10m; mail not configured)`);
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Email delivery is not configured. Set RESEND_API_KEY and EMAIL_FROM (or SMTP_*).",
    );
  }

  return {
    mode: "sandbox" as const,
    email: normalized,
    expiresInSec: OTP_TTL_MS / 1000,
    emailed: false,
    devCode: code,
  };
}

/** @deprecated use requestEmailOtp */
export const requestSandboxEmailOtp = requestEmailOtp;

/** Validate and consume an email code without creating a browser session. */
export async function consumeEmailOtp(email: string, code: string) {
  const normalized = email.trim().toLowerCase();
  const challenge = await prisma.loginChallenge.findFirst({
    where: { email: normalized, consumedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (!challenge) throw new Error("OTP expired or not found — request a new code");

  if (challenge.attempts >= MAX_ATTEMPTS) {
    await prisma.loginChallenge.update({
      where: { id: challenge.id },
      data: { consumedAt: new Date() },
    });
    throw new Error("Too many attempts — request a new code");
  }

  await prisma.loginChallenge.update({
    where: { id: challenge.id },
    data: { attempts: { increment: 1 } },
  });

  const ok = challenge.codeHash === hashToken(code.trim());
  if (!ok) throw new Error("Invalid OTP code");

  await prisma.loginChallenge.update({
    where: { id: challenge.id },
    data: { consumedAt: new Date() },
  });

  return normalized;
}

export async function verifyEmailOtp(email: string, code: string) {
  const normalized = await consumeEmailOtp(email, code);
  return completeEmailLogin(normalized, { method: "email_otp" });
}

/** @deprecated use verifyEmailOtp */
export const verifySandboxEmailOtp = verifyEmailOtp;

export type LoginCompleteResult = {
  redirect: string;
  organizationId: string;
  userId: string;
  jitCreated: boolean;
};

export async function resolveOrCreateUserByEmail(email: string) {
  const normalized = email.trim().toLowerCase();

  // Prefer any existing membership (including incomplete onboarding) over JIT.
  // Disabled memberships are reactivated instead of creating a sibling org.
  const anyExisting = await prisma.workspaceUser.findFirst({
    where: { email: normalized },
    include: { organization: true },
    orderBy: { createdAt: "asc" },
  });

  if (anyExisting) {
    let user = anyExisting;
    if (user.disabledAt) {
      user = await prisma.workspaceUser.update({
        where: { id: user.id },
        data: { disabledAt: null },
        include: { organization: true },
      });
      await writeAudit({
        organizationId: user.organizationId,
        actorType: "user",
        actorId: user.id,
        action: "user.reactivated_on_login",
        entityType: "workspace_user",
        entityId: user.id,
        metadata: { email: normalized },
      });
    }

    if (user.organization.ssoEnforced && isOidcConfigured()) {
      throw new Error("SSO required for this organization");
    }
    if (!isEmailDomainAllowed(user.email) && isOidcConfigured()) {
      throw new Error("Email domain not allowed");
    }
    return { user, jitCreated: false };
  }

  if (!allowJitOrgCreation()) {
    throw new Error(
      "No workspace found for this email. Ask an admin to invite you, or set ALLOW_JIT_ORG_CREATION=true for local demos.",
    );
  }

  const local = normalized.split("@")[0] || "workspace";
  const slugBase =
    local
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 24) || "org";
  const slug = `${slugBase}-${nanoid(6)}`.toLowerCase();
  const displayName =
    local.replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) || "Workspace";

  const org = await prisma.organization.create({
    data: {
      name: `${displayName}'s workspace`,
      slug,
      privacyMode: true,
      // Enterprise default: real Arc rails (testnet/mainnet via env). Simulated requires ARC_ALLOW_SIMULATED.
      paymentMode: "live",
      displayCurrency: "USD",
      ssoEnforced: false,
      mfaRequiredForRoles: "[]",
    },
  });

  const user = await prisma.workspaceUser.create({
    data: {
      organizationId: org.id,
      email: normalized,
      name: displayName,
      role: "admin",
    },
    include: { organization: true },
  });

  await writeAudit({
    organizationId: org.id,
    actorType: "user",
    actorId: user.id,
    action: "auth.jit_org_created",
    entityType: "organization",
    entityId: org.id,
    metadata: {
      email: normalized,
      slug,
      note: "New workspace — prior membership not found. db:seed/db:reset wipes custom startups.",
    },
  });

  console.warn(
    `[custara] JIT org created for ${normalized} → ${slug} (no existing WorkspaceUser; seed/reset may have wiped data)`,
  );

  return { user, jitCreated: true };
}

export async function completeEmailLogin(
  email: string,
  meta: { method: "circle_otp" | "sandbox_otp" | "email_otp" },
): Promise<LoginCompleteResult> {
  const { user, jitCreated } = await resolveOrCreateUserByEmail(email);

  await writeAudit({
    organizationId: user.organizationId,
    actorType: "user",
    actorId: user.id,
    action: "auth.otp_verified",
    entityType: "workspace_user",
    entityId: user.id,
    metadata: { method: meta.method, jitCreated },
  });

  // Provision agent wallet early so funding path is ready after login
  await ensureAgentWallet({
    organizationId: user.organizationId,
    actorType: "user",
    actorId: user.id,
  }).catch((e) => {
    console.warn("[custara] ensureAgentWallet on login failed", e);
  });

  const need = await userNeedsMfaChallenge(user);
  if (need === "challenge") {
    await setMfaPending(user.id);
    return {
      redirect: "/login?step=mfa",
      organizationId: user.organizationId,
      userId: user.id,
      jitCreated,
    };
  }

  await createSession(user.id);
  const needsOnboarding = !user.organization.onboardingCompletedAt;
  if (needsOnboarding || jitCreated) {
    return {
      redirect: "/app/onboarding",
      organizationId: user.organizationId,
      userId: user.id,
      jitCreated,
    };
  }
  const { userNeedsMfaPrompt } = await import("@/lib/mfa");
  if (await userNeedsMfaPrompt(user.id)) {
    return {
      redirect: "/app/onboarding/mfa",
      organizationId: user.organizationId,
      userId: user.id,
      jitCreated,
    };
  }
  return {
    redirect: "/app",
    organizationId: user.organizationId,
    userId: user.id,
    jitCreated,
  };
}

/** Opaque fingerprint for logging only — never store raw Circle tokens. */
export function fingerprintToken(token: string) {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}
