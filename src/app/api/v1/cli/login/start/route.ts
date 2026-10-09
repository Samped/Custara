import { NextResponse } from "next/server";
import { requestEmailOtp } from "@/lib/emailOtp";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { email?: string };
    const result = await requestEmailOtp(String(body.email || ""));
    return NextResponse.json({
      ok: true,
      email: result.email,
      emailed: result.emailed,
      expiresInSec: result.expiresInSec,
      ...(result.mode === "sandbox" && "devCode" in result ? { devCode: result.devCode } : {}),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Server error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
