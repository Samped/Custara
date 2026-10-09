import { NextResponse } from "next/server";
import { createSessionToken } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import { consumeEmailOtp, resolveOrCreateUserByEmail } from "@/lib/emailOtp";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { email?: string; code?: string };
    const email = await consumeEmailOtp(String(body.email || ""), String(body.code || ""));
    const { user } = await resolveOrCreateUserByEmail(email);
    const { token, expiresAt } = await createSessionToken(user.id);
    await writeAudit({
      organizationId: user.organizationId,
      actorType: "user",
      actorId: user.id,
      action: "auth.cli_login",
      entityType: "workspace_user",
      entityId: user.id,
      metadata: { method: "email_otp" },
    });
    return NextResponse.json({
      token,
      email: user.email,
      name: user.name,
      role: user.role,
      organizationName: user.organization.name,
      expiresAt: expiresAt.toISOString(),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Server error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
