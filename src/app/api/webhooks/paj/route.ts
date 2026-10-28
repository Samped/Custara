import { NextRequest, NextResponse } from "next/server";
import { handlePajWebhookPayload } from "@/domain/banking/pajRails";
import { pajWebhookSecret, verifyPajWebhook, type PajTransaction } from "@/domain/banking/paj";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const secret = pajWebhookSecret();
  if (!secret) {
    return NextResponse.json({ error: "Webhook secret not configured" }, { status: 401 });
  }
  const ok = verifyPajWebhook({
    rawBody,
    timestamp: request.headers.get("x-paj-timestamp"),
    signature: request.headers.get("x-paj-signature"),
    secret,
  });
  if (!ok) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  try {
    const payload = JSON.parse(rawBody) as PajTransaction;
    const result = await handlePajWebhookPayload(payload);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "PAJ webhook failed" },
      { status: 400 },
    );
  }
}
