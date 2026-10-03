import { NextRequest, NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/auth";
import {
  buildAccountingAuthUrl,
  isAccountingProviderConfigured,
  type AccountingProvider,
} from "@/domain/connectors/accountingProviders";

const PROVIDERS = new Set(["qbo", "sage", "zoho"]);

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ provider: string }> },
) {
  try {
    const user = await requireSessionUser(["admin"], "connectors:write");
    const { provider: raw } = await ctx.params;
    if (!PROVIDERS.has(raw)) {
      return NextResponse.redirect(
        new URL("/app/connectors?error=Unknown%20accounting%20provider", request.url),
      );
    }
    const provider = raw as AccountingProvider;
    if (!isAccountingProviderConfigured(provider)) {
      return NextResponse.redirect(
        new URL(
          `/app/connectors?error=${encodeURIComponent(`${provider.toUpperCase()} OAuth env not configured`)}`,
          request.url,
        ),
      );
    }
    const { url } = buildAccountingAuthUrl(user.organizationId, provider);
    return NextResponse.redirect(url);
  } catch {
    return NextResponse.redirect(new URL("/login", request.url));
  }
}
