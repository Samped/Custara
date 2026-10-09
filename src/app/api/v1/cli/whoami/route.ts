import { NextResponse } from "next/server";
import { AuthError, authenticateApiKey, requireUserBearer } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const header = request.headers.get("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    if (token && !token.startsWith("cst_live_")) {
      const user = await requireUserBearer(request);
      return NextResponse.json({
        type: "user",
        email: user.email,
        name: user.name,
        role: user.role,
        organizationName: user.organizationName,
        paymentMode: user.paymentMode,
        mfaEnabled: user.mfaEnabled,
      });
    }
    const auth = await authenticateApiKey(header, []);
    return NextResponse.json({
      type: "api_key",
      organizationName: auth.organizationName,
      paymentMode: auth.paymentMode,
      scopes: auth.scopes,
    });
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    const message = e instanceof Error ? e.message : "Server error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
