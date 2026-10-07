import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { confirmMfaEnrollment, disableMfa, startMfaEnrollment } from "@/lib/mfa";
import { currencyFromCountry } from "@/lib/currency";

export const runtime = "nodejs";

function mfaBeginRedirect(redirectBase: string, secret: string, otpauth: string) {
  const base = redirectBase.startsWith("/app/") ? redirectBase : "/app/settings";
  const url = new URL(base, "http://local.invalid");
  if (base.includes("/settings")) url.searchParams.set("mfa", "enroll");
  url.searchParams.set("enrollSecret", secret);
  url.searchParams.set("otpauth", otpauth);
  return `${url.pathname}?${url.searchParams.toString()}`;
}

/** JSON settings/MFA mutations — avoids FormData server actions broken by wallet extensions. */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const action = String(body.action || "");

    // Self-service MFA — any signed-in user for their own account.
    if (action === "begin_mfa") {
      const user = await requireSessionUser();
      const result = await startMfaEnrollment(user.id);
      await writeAudit({
        organizationId: user.organizationId,
        actorType: "user",
        actorId: user.id,
        action: "user.mfa_enroll_started",
        entityType: "workspace_user",
        entityId: user.id,
      });
      const redirectBase = String(body.redirectBase || "/app/settings");
      return NextResponse.json({
        ok: true,
        redirectTo: mfaBeginRedirect(redirectBase, result.secret, result.otpauth),
      });
    }

    if (action === "confirm_mfa") {
      const user = await requireSessionUser();
      await confirmMfaEnrollment(user.id, String(body.code || ""));
      await writeAudit({
        organizationId: user.organizationId,
        actorType: "user",
        actorId: user.id,
        action: "user.mfa_enabled",
        entityType: "workspace_user",
        entityId: user.id,
      });
      const redirectTo = String(body.redirectTo || "/app/settings");
      return NextResponse.json({
        ok: true,
        redirectTo: redirectTo.startsWith("/app") ? redirectTo : "/app/settings",
      });
    }

    if (action === "disable_mfa") {
      const user = await requireSessionUser();
      await disableMfa(user.id, String(body.code || ""));
      const org = await prisma.organization.findUniqueOrThrow({
        where: { id: user.organizationId },
        select: { mfaRequiredForRoles: true },
      });
      let roles: string[] = [];
      try {
        roles = JSON.parse(org.mfaRequiredForRoles || "[]") as string[];
      } catch {
        roles = [];
      }
      if (roles.includes(user.role)) {
        await prisma.organization.update({
          where: { id: user.organizationId },
          data: { mfaRequiredForRoles: JSON.stringify(roles.filter((r) => r !== user.role)) },
        });
      }
      await writeAudit({
        organizationId: user.organizationId,
        actorType: "user",
        actorId: user.id,
        action: "user.mfa_disabled",
        entityType: "workspace_user",
        entityId: user.id,
      });
      return NextResponse.json({ ok: true, redirectTo: "/app/security" });
    }

    const user = await requireSessionUser(["admin"], "settings:write");

    if (action === "invite_member") {
      const { inviteWorkspaceUser } = await import("@/domain/users");
      await inviteWorkspaceUser({
        organizationId: user.organizationId,
        actorId: user.id,
        email: String(body.email || ""),
        name: body.name ? String(body.name) : undefined,
        role: String(body.role || "viewer"),
      });
      return NextResponse.json({ ok: true });
    }

    if (action === "update_role") {
      const { updateWorkspaceUserRole } = await import("@/domain/users");
      await updateWorkspaceUserRole({
        organizationId: user.organizationId,
        actorId: user.id,
        userId: String(body.userId || ""),
        role: String(body.role || ""),
      });
      return NextResponse.json({ ok: true });
    }

    if (action === "disable_member") {
      const { disableWorkspaceUser } = await import("@/domain/users");
      await disableWorkspaceUser({
        organizationId: user.organizationId,
        actorId: user.id,
        userId: String(body.userId || ""),
      });
      return NextResponse.json({ ok: true });
    }

    if (action === "save_mfa_roles") {
      const roles = Array.isArray(body.mfaRoles)
        ? body.mfaRoles.map(String)
        : typeof body.mfaRoles === "string"
          ? [String(body.mfaRoles)]
          : [];
      await prisma.organization.update({
        where: { id: user.organizationId },
        data: { mfaRequiredForRoles: JSON.stringify(roles) },
      });
      await writeAudit({
        organizationId: user.organizationId,
        actorType: "user",
        actorId: user.id,
        action: "org.mfa_roles_updated",
        entityType: "organization",
        entityId: user.organizationId,
        metadata: { mfaRequiredForRoles: roles },
      });
      return NextResponse.json({ ok: true, redirectTo: "/app/roles" });
    }

    if (action === "save_org") {
      const paymentMode = String(body.paymentMode || "sandbox");
      const nextMode = paymentMode === "live" ? "live" : "sandbox";
      const countryRaw = String(body.country || "")
        .trim()
        .toUpperCase()
        .slice(0, 2);
      const country = countryRaw || null;
      const currencyRaw = String(body.displayCurrency || "")
        .trim()
        .toUpperCase();
      const displayCurrency = currencyRaw || (country ? currencyFromCountry(country) : "USD");
      const autoPayEnabled = Boolean(body.autoPayEnabled);

      await prisma.organization.update({
        where: { id: user.organizationId },
        data: {
          name: String(body.name || "Organization"),
          country,
          displayCurrency,
          privacyMode: Boolean(body.privacyMode),
          privacyDeleteDays: Number(body.privacyDeleteDays || 30),
          expectedInflow7d: Number(body.expectedInflow7d || 0),
          expectedInflow30d: Number(body.expectedInflow30d || 0),
          paymentMode: nextMode,
          ssoEnforced: Boolean(body.ssoEnforced),
          autoPayEnabled,
        },
      });
      if (nextMode === "live") {
        const { ensureStrictPolicyForLive } = await import("@/domain/policy");
        await ensureStrictPolicyForLive(user.organizationId, user.id);
      }
      await writeAudit({
        organizationId: user.organizationId,
        actorType: "user",
        actorId: user.id,
        action: "org.settings_updated",
        entityType: "organization",
        entityId: user.organizationId,
        metadata: {
          paymentMode: nextMode,
          autoPayEnabled,
          strictPolicyEnsured: nextMode === "live",
          country,
          displayCurrency,
        },
      });
      return NextResponse.json({ ok: true, redirectTo: "/app/settings" });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Request failed" },
      { status: 400 },
    );
  }
}
