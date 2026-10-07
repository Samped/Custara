import { verifyUserMfa } from "@/lib/mfa";
import { prisma } from "@/lib/db";

export const MFA_SETUP_REQUIRED_CODE = "MFA_SETUP_REQUIRED";

/**
 * Step-up MFA for money movement.
 * - User pay: MFA must be enabled; then TOTP required
 * - System autopay: no MFA
 * - API keys: require X-Custara-Step-Up in live mode when API_PAY_STEPUP_SECRET is set
 */
export async function assertPayStepUp(input: {
  organizationId: string;
  actorType: "user" | "system" | "api_key";
  actorId?: string;
  mfaCode?: string | null;
  apiStepUpToken?: string | null;
}) {
  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: input.organizationId },
    select: { paymentMode: true },
  });
  const live = org.paymentMode === "live";

  if (input.actorType === "system") {
    return;
  }

  if (input.actorType === "user") {
    if (!input.actorId) throw new Error("Pay step-up requires actorId");
    const user = await prisma.workspaceUser.findUniqueOrThrow({ where: { id: input.actorId } });

    if (!user.mfaEnabled || !user.mfaSecretEnc) {
      throw new Error(
        `${MFA_SETUP_REQUIRED_CODE}: Set up MFA before sending payments. Open Settings → MFA to enable authenticator protection.`,
      );
    }

    if (!input.mfaCode?.trim()) {
      throw new Error("Step-up MFA required: provide mfaCode to initiate payment");
    }
    await verifyUserMfa(user.id, input.mfaCode);
    return;
  }

  // api_key
  if (live) {
    const expected = process.env.API_PAY_STEPUP_SECRET?.trim();
    if (expected) {
      if (!input.apiStepUpToken || input.apiStepUpToken !== expected) {
        throw new Error("Invalid or missing X-Custara-Step-Up for payments:initiate");
      }
    }
  }
}

export function isMfaSetupRequiredError(message: string) {
  return message.includes(MFA_SETUP_REQUIRED_CODE);
}
