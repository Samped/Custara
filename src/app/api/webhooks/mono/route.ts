import { NextRequest, NextResponse } from "next/server";
import { handleMonoEvent, verifyMonoWebhook } from "@/domain/banking/nigeria";

export const runtime = "nodejs";

/** Mono open-banking webhook → settlement reconcile */
export async function POST(request: NextRequest) {
  const signature =
    request.headers.get("mono-webhook-secret") ||
    request.headers.get("x-mono-webhook-secret");
  if (!verifyMonoWebhook(signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const organizationId =
    request.nextUrl.searchParams.get("org") ||
    (process.env.MONO_DEFAULT_ORG_ID || "").trim();
  if (!organizationId) {
    return NextResponse.json({ error: "org query or MONO_DEFAULT_ORG_ID required" }, { status: 400 });
  }

  try {
    const event = (await request.json()) as Parameters<typeof handleMonoEvent>[1];
    const result = await handleMonoEvent(organizationId, event);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Mono webhook failed" },
      { status: 400 },
    );
  }
}
