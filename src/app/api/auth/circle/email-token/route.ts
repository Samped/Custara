import { NextRequest, NextResponse } from "next/server";
import { assertRateLimit } from "@/lib/rateLimit";
import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import {
  getCircleAppId,
  isCircleUserAuthConfigured,
  requestEmailOtp,
} from "@/lib/emailOtp";
import { requestCircleEmailToken } from "@/domain/arc/userAuth";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { email?: string; deviceId?: string };
    const email = String(body.email || "")
      .trim()
      .toLowerCase();
    if (!email || !email.includes("@")) {
      return NextResponse.json({ error: "Valid email required" }, { status: 400 });
    }

    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    await assertRateLimit(`otp:email:${email}`, 5);
    await assertRateLimit(`otp:ip:${ip}`, 20);

    const existing = await prisma.workspaceUser.findFirst({
      where: { email, disabledAt: null },
      select: { organizationId: true, id: true },
      orderBy: { createdAt: "asc" },
    });

    const loginMode = isCircleUserAuthConfigured() ? "circle" : "sandbox";

    if (existing) {
      await writeAudit({
        organizationId: existing.organizationId,
        actorType: "user",
        actorId: existing.id,
        action: "auth.otp_requested",
        entityType: "workspace_user",
        entityId: existing.id,
        metadata: { email, mode: loginMode },
      }).catch((err) => {
        console.warn("[custara] auth.otp_requested audit failed", err);
      });
    }

    // Primary: Circle email token → Circle sends OTP to the user's inbox.
    if (isCircleUserAuthConfigured()) {
      const deviceId = String(body.deviceId || "").trim();
      if (!deviceId) {
        return NextResponse.json({ error: "deviceId required for Circle OTP" }, { status: 400 });
      }
      const tokens = await requestCircleEmailToken({ email, deviceId });
      return NextResponse.json({
        ...tokens,
        appId: getCircleAppId(),
      });
    }

    // Dev fallback only when Circle App ID / API key are missing.
    const result = await requestEmailOtp(email);
    return NextResponse.json(result);
  } catch (e) {
    const status = (e as Error & { status?: number }).status || 400;
    return NextResponse.json({ error: e instanceof Error ? e.message : "Request failed" }, { status });
  }
}
