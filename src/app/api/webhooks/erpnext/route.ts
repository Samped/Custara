import { NextResponse } from "next/server";
import { enqueueErpNextSyncByWebhookToken } from "@/domain/connectors/erpnext";

/**
 * Optional ERPNext webhook: POST with ?token= or Authorization Bearer token matching
 * the connector webhookToken to enqueue an immediate pull sync.
 */
export async function POST(request: Request) {
  const url = new URL(request.url);
  const header = request.headers.get("authorization") || "";
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const token = (url.searchParams.get("token") || bearer || "").trim();
  if (!token) {
    return NextResponse.json({ error: "token required" }, { status: 401 });
  }
  const ok = await enqueueErpNextSyncByWebhookToken(token);
  if (!ok) return NextResponse.json({ error: "unknown token" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
