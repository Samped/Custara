import { NextResponse } from "next/server";
import { AuthError, requireUserBearer } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";

export const runtime = "nodejs";

function asBool(value: unknown) {
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  return text === "true" || text === "1" || text === "yes" || text === "on";
}

export async function POST(request: Request) {
  try {
    const user = await requireUserBearer(request, ["admin"], "settings:write");
    const body = (await request.json()) as Record<string, unknown>;
    const action = String(body.action || "");

    if (action === "invite_member") {
      const { inviteWorkspaceUser } = await import("@/domain/users");
      const member = await inviteWorkspaceUser({
        organizationId: user.organizationId,
        actorId: user.id,
        email: String(body.email || ""),
        name: body.name ? String(body.name) : undefined,
        role: String(body.role || "viewer"),
      });
      return NextResponse.json({ ok: true, id: member.id, email: member.email, role: member.role });
    }

    if (action === "save_mfa_threshold") {
      const amount = Number(body.mfaPayThresholdUsd);
      if (!Number.isFinite(amount) || amount < 0) {
        return NextResponse.json({ error: "Enter a USD amount of 0 or more." }, { status: 400 });
      }
      await prisma.organization.update({
        where: { id: user.organizationId },
        data: { mfaPayThresholdUsd: amount },
      });
      await writeAudit({
        organizationId: user.organizationId,
        actorType: "user",
        actorId: user.id,
        action: "org.mfa_pay_threshold_updated",
        entityType: "organization",
        entityId: user.organizationId,
        metadata: { mfaPayThresholdUsd: amount },
      });
      return NextResponse.json({ ok: true, mfaPayThresholdUsd: amount });
    }

    if (action === "save_org") {
      const data: { paymentMode?: string; autoPayEnabled?: boolean } = {};
      if (body.paymentMode != null && String(body.paymentMode).trim() !== "") {
        const mode = String(body.paymentMode);
        data.paymentMode = mode === "live" ? "live" : "sandbox";
      }
      if (body.autoPayEnabled != null && String(body.autoPayEnabled).trim() !== "") {
        data.autoPayEnabled = asBool(body.autoPayEnabled);
      }
      if (!Object.keys(data).length) {
        return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
      }
      const org = await prisma.organization.update({
        where: { id: user.organizationId },
        data,
        select: { paymentMode: true, autoPayEnabled: true, name: true },
      });
      if (data.paymentMode === "live") {
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
        metadata: { ...data, source: "cli" },
      });
      return NextResponse.json({ ok: true, ...org });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    const message = e instanceof Error ? e.message : "Server error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
