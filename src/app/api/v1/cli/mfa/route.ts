import { NextResponse } from "next/server";
import { AuthError, requireUserBearer } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import { confirmMfaEnrollment, disableMfa, startMfaEnrollment } from "@/lib/mfa";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const user = await requireUserBearer(request);
    const body = (await request.json()) as { action?: string; code?: string };
    const action = String(body.action || "");

    if (action === "begin") {
      const result = await startMfaEnrollment(user.id);
      await writeAudit({
        organizationId: user.organizationId,
        actorType: "user",
        actorId: user.id,
        action: "user.mfa_enroll_started",
        entityType: "workspace_user",
        entityId: user.id,
      });
      return NextResponse.json({ ok: true, secret: result.secret, otpauth: result.otpauth });
    }

    if (action === "confirm") {
      await confirmMfaEnrollment(user.id, String(body.code || ""));
      await writeAudit({
        organizationId: user.organizationId,
        actorType: "user",
        actorId: user.id,
        action: "user.mfa_enabled",
        entityType: "workspace_user",
        entityId: user.id,
      });
      return NextResponse.json({ ok: true, mfaEnabled: true });
    }

    if (action === "disable") {
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
      return NextResponse.json({ ok: true, mfaEnabled: false });
    }

    return NextResponse.json({ error: "action must be begin, confirm, or disable" }, { status: 400 });
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    const message = e instanceof Error ? e.message : "Server error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
