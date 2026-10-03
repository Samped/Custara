import { NextRequest, NextResponse } from "next/server";
import { AuthError, authenticateApiKey, requireSessionUser } from "@/lib/auth";
import { verifyAuditChain } from "@/lib/audit";

export async function GET(request: NextRequest) {
  try {
    let organizationId: string;
    const authHeader = request.headers.get("authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const auth = await authenticateApiKey(authHeader, ["audit:read"]);
      organizationId = auth.organizationId;
    } else {
      const user = await requireSessionUser(undefined, "audit:read");
      organizationId = user.organizationId;
    }
    const result = await verifyAuditChain(organizationId);
    return NextResponse.json(result, { status: result.ok ? 200 : 409 });
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: e instanceof Error ? e.message : "Error" }, { status: 400 });
  }
}
