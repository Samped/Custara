import { NextResponse } from "next/server";
import { AuthError, authenticateApiKey } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { createPartnerWebhook } from "@/domain/partnerApi";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const auth = await authenticateApiKey(request.headers.get("authorization"), ["connectors:write"]);
    const rows = await prisma.webhookEndpoint.findMany({
      where: { organizationId: auth.organizationId },
      orderBy: { createdAt: "desc" },
      select: { id: true, url: true, eventsJson: true, isActive: true, createdAt: true },
    });
    return NextResponse.json({
      data: rows.map((row) => ({
        id: row.id,
        url: row.url,
        events: JSON.parse(row.eventsJson || "[]") as string[],
        is_active: row.isActive,
        created_at: row.createdAt,
      })),
    });
  } catch (e) {
    return apiError(e);
  }
}

export async function POST(request: Request) {
  try {
    const auth = await authenticateApiKey(request.headers.get("authorization"), ["connectors:write"]);
    const body = (await request.json()) as { url?: string; events?: string[] | string };
    const events = Array.isArray(body.events)
      ? body.events.map(String)
      : String(body.events || "")
          .split(",")
          .map((e) => e.trim())
          .filter(Boolean);
    const created = await createPartnerWebhook({
      organizationId: auth.organizationId,
      actorId: auth.apiKeyId,
      url: String(body.url || ""),
      events,
    });
    return NextResponse.json(
      {
        id: created.endpoint.id,
        url: created.endpoint.url,
        events,
        secret: created.secret,
      },
      { status: 201 },
    );
  } catch (e) {
    return apiError(e);
  }
}

function apiError(e: unknown) {
  if (e instanceof AuthError) {
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
  const message = e instanceof Error ? e.message : "Server error";
  return NextResponse.json({ error: message }, { status: 400 });
}
