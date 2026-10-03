import { NextRequest, NextResponse } from "next/server";
import { AuthError, authenticateApiKey } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { assertRateLimit } from "@/lib/rateLimit";

/** SIEM-oriented audit export with cursor pagination. */
export async function GET(request: NextRequest) {
  try {
    const auth = await authenticateApiKey(request.headers.get("authorization"), ["audit:read"]);
    await assertRateLimit(`api:${auth.organizationId}:audit:export`, 30);

    const cursor = request.nextUrl.searchParams.get("cursor") || undefined;
    const take = Math.min(Number(request.nextUrl.searchParams.get("limit") || 100), 500);

    const events = await prisma.auditEvent.findMany({
      where: { organizationId: auth.organizationId },
      orderBy: { createdAt: "desc" },
      take: take + 1,
      ...(cursor
        ? {
            cursor: { id: cursor },
            skip: 1,
          }
        : {}),
    });

    const hasMore = events.length > take;
    const data = hasMore ? events.slice(0, take) : events;
    const nextCursor = hasMore ? data[data.length - 1]?.id : null;

    return NextResponse.json({
      data: data.map((e) => ({
        id: e.id,
        action: e.action,
        entity_type: e.entityType,
        entity_id: e.entityId,
        actor_type: e.actorType,
        actor_id: e.actorId,
        request_id: e.requestId,
        metadata: JSON.parse(e.metadataJson || "{}"),
        prev_hash: e.prevHash,
        entry_hash: e.entryHash,
        created_at: e.createdAt.toISOString(),
      })),
      next_cursor: nextCursor,
    });
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: e instanceof Error ? e.message : "Error" }, { status: 400 });
  }
}
