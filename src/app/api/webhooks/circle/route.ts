import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "crypto";
import { handleCircleWebhookPayload } from "@/domain/arc/tasks";

function verifyCircleSignature(rawBody: string, signature: string | null) {
  const secret = process.env.CIRCLE_WEBHOOK_SECRET;
  // Fail closed in production — never accept unsigned Circle webhooks.
  if (!secret) {
    if (process.env.NODE_ENV === "production" || process.env.PAYMENT_MODE_FORCE_LIVE === "true") {
      return false;
    }
    return true;
  }
  if (!signature) return false;
  const digest = createHash("sha256").update(`${secret}${rawBody}`).digest("hex");
  const a = Buffer.from(digest);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(request: NextRequest) {
  const secret = process.env.CIRCLE_WEBHOOK_SECRET;
  if (
    !secret &&
    (process.env.NODE_ENV === "production" || process.env.REQUIRE_CIRCLE_WEBHOOK_SECRET === "true")
  ) {
    return NextResponse.json(
      { error: "CIRCLE_WEBHOOK_SECRET required in production" },
      { status: 503 },
    );
  }

  const raw = await request.text();
  const signature =
    request.headers.get("x-circle-signature") ||
    request.headers.get("circle-signature") ||
    request.headers.get("x-signature");

  if (!verifyCircleSignature(raw, signature)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const result = await handleCircleWebhookPayload(payload);
  if (result.reason === "unknown_tx") {
    // Surface for ops alerting / log scrapers
    console.error("[ALERT] circle.unknown_tx", result);
  }
  return NextResponse.json({ ok: true, ...result });
}
