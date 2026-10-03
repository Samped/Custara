import { NextRequest, NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/auth";
import { buildXeroAuthUrl, isXeroConfigured } from "@/domain/connectors/xero";

export async function GET(request: NextRequest) {
  try {
    const user = await requireSessionUser(["admin"], "connectors:write");
    if (!isXeroConfigured()) {
      return NextResponse.redirect(
        new URL("/app/connectors?error=Xero%20env%20not%20configured", request.url),
      );
    }
    const { url } = buildXeroAuthUrl(user.organizationId);
    return NextResponse.redirect(url);
  } catch {
    return NextResponse.redirect(new URL("/login", request.url));
  }
}
