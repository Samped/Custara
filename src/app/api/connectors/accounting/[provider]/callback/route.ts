import { NextRequest, NextResponse } from "next/server";
import {
  completeAccountingOAuth,
  type AccountingProvider,
} from "@/domain/connectors/accountingProviders";

const PROVIDERS = new Set(["qbo", "sage", "zoho"]);

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ provider: string }> },
) {
  const { provider: raw } = await ctx.params;
  if (!PROVIDERS.has(raw)) {
    return NextResponse.redirect(
      new URL("/app/connectors?error=Unknown%20accounting%20provider", request.url),
    );
  }
  const provider = raw as AccountingProvider;
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const realmId =
    request.nextUrl.searchParams.get("realmId") ||
    request.nextUrl.searchParams.get("realm_id");

  if (!code || !state) {
    return NextResponse.redirect(
      new URL("/app/connectors?error=Missing%20OAuth%20code", request.url),
    );
  }

  try {
    await completeAccountingOAuth({ provider, code, state, realmId: realmId || undefined });
    return NextResponse.redirect(
      new URL(`/app/connectors?accounting=${provider}`, request.url),
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "OAuth connect failed";
    return NextResponse.redirect(
      new URL(`/app/connectors?error=${encodeURIComponent(msg)}`, request.url),
    );
  }
}
