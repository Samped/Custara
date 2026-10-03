import { verifyUserMfa } from "@/lib/mfa";
import { prisma } from "@/lib/db";

/**
 * Step-up MFA for money movement.
 * - Live mode: always required for user-initiated pay
 * - Sandbox: required when user has MFA enabled
 * - API keys: require X-Custara-Step-Up header matching org step-up secret in live mode
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
    // Auto-pay path — org must have autoPayEnabled (checked by caller); no MFA for system cron
    return;
  }

  if (input.actorType === "user") {
    if (!input.actorId) throw new Error("Step-up MFA requires actorId");
    const user = await prisma.workspaceUser.findUniqueOrThrow({ where: { id: input.actorId } });
    if (live || user.mfaEnabled) {
      if (!input.mfaCode?.trim()) {
        throw new Error("Step-up MFA required: provide mfaCode to initiate payment");
      }
      if (!user.mfaEnabled || !user.mfaSecretEnc) {
        throw new Error("Enable MFA before initiating payments in live mode");
      }
      await verifyUserMfa(user.id, input.mfaCode);
    }
    return;
  }

  // api_key
  if (live) {
    const expected = process.env.API_PAY_STEPUP_SECRET?.trim();
    if (!expected) {
      throw new Error(
        "Live API payments require API_PAY_STEPUP_SECRET and X-Custara-Step-Up header",
      );
    }
    if (!input.apiStepUpToken || input.apiStepUpToken !== expected) {
      throw new Error("Invalid or missing X-Custara-Step-Up for payments:initiate");
    }
  }
}
