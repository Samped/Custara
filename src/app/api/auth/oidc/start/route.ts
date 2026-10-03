import { NextRequest, NextResponse } from "next/server";
import { beginOidcLogin, isOidcConfigured } from "@/lib/oidc";

export async function GET(request: NextRequest) {
  if (!isOidcConfigured()) {
    return NextResponse.redirect(new URL("/login?error=SSO%20not%20configured", request.url));
  }
  const origin = request.nextUrl.origin;
  const redirectUri = `${origin}/api/auth/oidc/callback`;
  try {
    const url = await beginOidcLogin(redirectUri);
    return NextResponse.redirect(url);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "SSO failed";
    return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(msg)}`, request.url));
  }
}
