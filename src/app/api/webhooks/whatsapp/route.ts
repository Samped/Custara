import { NextRequest, NextResponse } from "next/server";
import {
  ingestWhatsAppMessages,
  resolveOrgForWhatsAppSender,
  verifyWhatsAppSignature,
  verifyWhatsAppWebhookChallenge,
} from "@/domain/whatsapp";

export const runtime = "nodejs";

/** Meta WhatsApp Cloud API webhook verification */
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const challenge = verifyWhatsAppWebhookChallenge({
    mode: sp.get("hub.mode"),
    token: sp.get("hub.verify_token"),
    challenge: sp.get("hub.challenge"),
  });
  if (challenge) {
    return new NextResponse(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");
  if (!verifyWhatsAppSignature(rawBody, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  try {
    const body = JSON.parse(rawBody) as {
      entry?: Array<{
        changes?: Array<{
          value?: {
            messages?: Array<{
              id?: string;
              from?: string;
              type?: string;
              text?: { body?: string };
              document?: { id?: string; filename?: string; mime_type?: string };
              image?: { id?: string; mime_type?: string; caption?: string };
            }>;
          };
        }>;
      }>;
    };

    const messages =
      body.entry?.flatMap((e) => e.changes?.flatMap((c) => c.value?.messages || []) || []) || [];

    if (!messages.length) {
      return NextResponse.json({ ok: true, ingested: 0 });
    }

    const from = messages[0]?.from || "";
    const organizationId = await resolveOrgForWhatsAppSender(from);
    if (!organizationId) {
      return NextResponse.json({ error: "No org mapped for sender" }, { status: 404 });
    }

    const result = await ingestWhatsAppMessages({ organizationId, messages });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "WhatsApp ingest failed" },
      { status: 400 },
    );
  }
}
