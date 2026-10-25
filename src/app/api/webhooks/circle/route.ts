import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "crypto";
import { handleCircleWebhookPayload } from "@/domain/arc/tasks";

function verifyCircleSignature(rawBody: string, signature: string | null) {
  const secret = process.env.CIRCLE_WEBHOOK_SECRET?.trim();
  if (!secret) return false;
  if (!signature) return false;
  const digest = createHash("sha256").update(`${secret}${rawBody}`).digest("hex");
  const a = Buffer.from(digest);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Circle pings this URL before it shows the signing secret. */
export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "custara",
    configured: Boolean(process.env.CIRCLE_WEBHOOK_SECRET?.trim()),
  });
}

export async function POST(request: NextRequest) {
  const secret = process.env.CIRCLE_WEBHOOK_SECRET?.trim();
  const raw = await request.text();

  if (!secret) {
    return NextResponse.json({
      ok: true,
      configured: false,
      note: "Handshake only. Set CIRCLE_WEBHOOK_SECRET to apply payment events.",
    });
  }

  const signature =
    request.headers.get("x-circle-signature") ||
    request.headers.get("circle-signature") ||
    request.headers.get("x-signature");

  if (!verifyCircleSignature(raw, signature)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const result = await handleCircleWebhookPayload(payload);
  if (result.reason === "unknown_tx") {
    console.error("[ALERT] circle.unknown_tx", result);
  }
  return NextResponse.json({ ok: true, ...result });
}
