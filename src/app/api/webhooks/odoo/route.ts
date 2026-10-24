import { NextRequest, NextResponse } from "next/server";
import { enqueueOdooSyncByWebhookToken } from "@/domain/connectors/odoo";

export const runtime = "nodejs";

/** Odoo posts here when a vendor bill is confirmed. The worker then pulls the bill. */
export async function POST(request: NextRequest) {
  const token =
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ||
    request.headers.get("x-custara-odoo-token")?.trim() ||
    request.nextUrl.searchParams.get("token")?.trim() ||
    "";
  if (!token) {
    return NextResponse.json({ error: "Missing token" }, { status: 401 });
  }
  const ok = await enqueueOdooSyncByWebhookToken(token);
  if (!ok) {
    return NextResponse.json({ error: "Unknown token" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
