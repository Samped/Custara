import { NextRequest, NextResponse } from "next/server";
import { handlePaystackEvent, verifyPaystackSignature } from "@/domain/banking/nigeria";

export const runtime = "nodejs";

/**
 * Paystack webhook → settlement reconcile.
 * Route org via ?org= or PAYSTACK_DEFAULT_ORG_ID.
 */
export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-paystack-signature");
  if (!verifyPaystackSignature(rawBody, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const organizationId =
    request.nextUrl.searchParams.get("org") ||
    (process.env.PAYSTACK_DEFAULT_ORG_ID || "").trim();
  if (!organizationId) {
    return NextResponse.json({ error: "org query or PAYSTACK_DEFAULT_ORG_ID required" }, { status: 400 });
  }

  try {
    const event = JSON.parse(rawBody) as Parameters<typeof handlePaystackEvent>[1];
    const result = await handlePaystackEvent(organizationId, event);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Paystack webhook failed" },
      { status: 400 },
    );
  }
}
