import { generateSecret, generateURI, verifySync } from "otplib";
import { decryptField, encryptField } from "./crypto";
import { prisma } from "./db";
import type { Role } from "./auth";

export function generateMfaSecret() {
  return generateSecret();
}

export function buildOtpauthUrl(input: { email: string; secret: string; issuer?: string }) {
  return generateURI({
    issuer: input.issuer || "Custara",
    label: input.email,
    secret: input.secret,
  });
}

export function verifyTotp(secret: string, token: string) {
  const result = verifySync({ secret, token: token.replace(/\s+/g, "") });
  return Boolean(result?.valid);
}

export async function startMfaEnrollment(userId: string) {
  const user = await prisma.workspaceUser.findUniqueOrThrow({ where: { id: userId } });
  const secret = generateMfaSecret();
  await prisma.workspaceUser.update({
    where: { id: userId },
    data: {
      mfaSecretEnc: encryptField(secret),
      mfaEnabled: false,
      mfaVerifiedAt: null,
    },
  });
  return {
    secret,
    otpauth: buildOtpauthUrl({ email: user.email, secret }),
  };
}

export async function confirmMfaEnrollment(userId: string, token: string) {
  const user = await prisma.workspaceUser.findUniqueOrThrow({ where: { id: userId } });
  if (!user.mfaSecretEnc) throw new Error("MFA enrollment not started");
  const secret = decryptField(user.mfaSecretEnc);
  if (!verifyTotp(secret, token)) throw new Error("Invalid MFA code");
  return prisma.workspaceUser.update({
    where: { id: userId },
    data: {
      mfaEnabled: true,
      mfaVerifiedAt: new Date(),
      mfaPromptCompletedAt: new Date(),
    },
  });
}

/** Mark post-signup MFA prompt as done (skip). Does not enable MFA. */
export async function skipMfaPrompt(userId: string) {
  return prisma.workspaceUser.update({
    where: { id: userId },
    data: { mfaPromptCompletedAt: new Date() },
  });
}

export async function userNeedsMfaPrompt(userId: string) {
  const user = await prisma.workspaceUser.findUnique({
    where: { id: userId },
    select: { mfaEnabled: true, mfaPromptCompletedAt: true },
  });
  if (!user) return false;
  if (user.mfaEnabled) return false;
  return !user.mfaPromptCompletedAt;
}

export async function disableMfa(userId: string, token: string) {
  const user = await prisma.workspaceUser.findUniqueOrThrow({ where: { id: userId } });
  if (!user.mfaSecretEnc || !user.mfaEnabled) {
    return prisma.workspaceUser.update({
      where: { id: userId },
      data: { mfaEnabled: false, mfaSecretEnc: null, mfaVerifiedAt: null },
    });
  }
  const secret = decryptField(user.mfaSecretEnc);
  if (!verifyTotp(secret, token)) throw new Error("Invalid MFA code");
  return prisma.workspaceUser.update({
    where: { id: userId },
    data: { mfaEnabled: false, mfaSecretEnc: null, mfaVerifiedAt: null },
  });
}

export async function userNeedsMfaChallenge(user: {
  role: string;
  mfaEnabled: boolean;
  mfaSecretEnc: string | null;
  organization: { mfaRequiredForRoles: string };
}) {
  let required: string[] = ["admin", "payer", "approver"];
  try {
    required = JSON.parse(user.organization.mfaRequiredForRoles) as string[];
  } catch {
    // keep default
  }
  if (required.includes(user.role) && (!user.mfaEnabled || !user.mfaSecretEnc)) {
    return "enroll" as const;
  }
  if (user.mfaEnabled && user.mfaSecretEnc) return "challenge" as const;
  return "none" as const;
}

export async function verifyUserMfa(userId: string, token: string) {
  const user = await prisma.workspaceUser.findUniqueOrThrow({ where: { id: userId } });
  if (!user.mfaSecretEnc) throw new Error("MFA not configured");
  const secret = decryptField(user.mfaSecretEnc);
  if (!verifyTotp(secret, token)) throw new Error("Invalid MFA code");
  return true;
}

export function parseMfaRequiredRoles(json: string): Role[] {
  try {
    return JSON.parse(json) as Role[];
  } catch {
    return ["admin", "payer", "approver"];
  }
}
