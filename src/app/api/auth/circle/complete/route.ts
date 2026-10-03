import { NextRequest, NextResponse } from "next/server";
import { assertRateLimit } from "@/lib/rateLimit";
import {
  completeEmailLogin,
  fingerprintToken,
  isCircleUserAuthConfigured,
  verifySandboxEmailOtp,
} from "@/lib/emailOtp";

export const runtime = "nodejs";

/**
 * Finish passwordless login after Circle Web SDK verifyOtp (userToken)
 * or sandbox OTP code entry.
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      email?: string;
      mode?: string;
      code?: string;
      userToken?: string;
      encryptionKey?: string;
    };
    const email = String(body.email || "")
      .trim()
      .toLowerCase();
    if (!email || !email.includes("@")) {
      return NextResponse.json({ error: "Valid email required" }, { status: 400 });
    }

    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    await assertRateLimit(`otp:complete:${email}`, 10);
    await assertRateLimit(`otp:complete-ip:${ip}`, 30);

    const mode = String(body.mode || (isCircleUserAuthConfigured() ? "circle" : "email"));

    if (mode === "sandbox" || mode === "email") {
      const code = String(body.code || "").trim();
      if (!/^\d{6}$/.test(code)) {
        return NextResponse.json({ error: "6-digit OTP required" }, { status: 400 });
      }
      const result = await verifySandboxEmailOtp(email, code);
      return NextResponse.json({
        ok: true,
        redirect: result.redirect,
        organizationId: result.organizationId,
        userId: result.userId,
        jitCreated: result.jitCreated,
        needsWalletInit: true,
      });
    }

    // Circle path: Web SDK already verified OTP; we trust userToken presence + email from client.
    // Production hardening can decode/validate Circle userToken JWT against Circle JWKS if needed.
    const userToken = String(body.userToken || "").trim();
    if (!userToken) {
      return NextResponse.json({ error: "userToken required" }, { status: 400 });
    }
    if (!isCircleUserAuthConfigured()) {
      return NextResponse.json({ error: "Circle user auth is not configured" }, { status: 400 });
    }

    void fingerprintToken(userToken);
    const result = await completeEmailLogin(email, { method: "circle_otp" });
    return NextResponse.json({
      ok: true,
      redirect: result.redirect,
      organizationId: result.organizationId,
      userId: result.userId,
      jitCreated: result.jitCreated,
      needsWalletInit: true,
    });
  } catch (e) {
    const status = (e as Error & { status?: number }).status || 400;
    return NextResponse.json({ error: e instanceof Error ? e.message : "Login failed" }, { status });
  }
}
