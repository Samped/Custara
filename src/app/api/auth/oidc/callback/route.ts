import { NextRequest, NextResponse } from "next/server";
import { finishOidcLogin } from "@/lib/oidc";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  if (!code || !state) {
    return NextResponse.redirect(new URL("/login?error=Missing%20OIDC%20code", request.url));
  }
  const redirectUri = `${request.nextUrl.origin}/api/auth/oidc/callback`;
  try {
    const result = await finishOidcLogin({ code, state, redirectUri });
    if (result.needsMfa) {
      return NextResponse.redirect(new URL("/login?step=mfa", request.url));
    }
    return NextResponse.redirect(new URL("/app", request.url));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "SSO callback failed";
    return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(msg)}`, request.url));
  }
}
