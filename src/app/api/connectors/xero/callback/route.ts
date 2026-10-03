import { NextRequest, NextResponse } from "next/server";
import { exchangeXeroCode } from "@/domain/connectors/xero";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  if (!code || !state) {
    return NextResponse.redirect(new URL("/app/connectors?error=Missing%20Xero%20code", request.url));
  }
  try {
    await exchangeXeroCode({ code, state });
    return NextResponse.redirect(new URL("/app/connectors?xero=connected", request.url));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Xero connect failed";
    return NextResponse.redirect(new URL(`/app/connectors?error=${encodeURIComponent(msg)}`, request.url));
  }
}
