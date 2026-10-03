import { NextResponse } from "next/server";
import { AuthError, authenticateApiKey } from "@/lib/auth";
import { assertRateLimit } from "@/lib/rateLimit";
import { createRequestId } from "@/lib/audit";
import { hashRequestBody, withIdempotency } from "@/lib/idempotency";
import { ingestCsvRows } from "@/domain/csvIngest";

/** Bulk AP ingest from CSV text or rows. */
export async function POST(request: Request) {
  try {
    const auth = await authenticateApiKey(request.headers.get("authorization"), ["invoices:write"]);
    await assertRateLimit(`api:${auth.organizationId}:invoices:bulk`, 20);
    const requestId = request.headers.get("x-request-id") || createRequestId();
    const contentType = request.headers.get("content-type") || "";

    let csvText = "";
    let sync = false;
    let idempotencyKey =
      request.headers.get("idempotency-key") || (null as string | null);

    if (contentType.includes("text/csv") || contentType.includes("text/plain")) {
      csvText = await request.text();
    } else {
      const body = (await request.json()) as {
        csv?: string;
        sync?: boolean;
        idempotency_key?: string;
      };
      csvText = String(body.csv || "");
      sync = Boolean(body.sync);
      idempotencyKey = idempotencyKey || body.idempotency_key || null;
    }

    if (!csvText.trim()) {
      return NextResponse.json({ error: "csv text required" }, { status: 400 });
    }

    const run = async () => {
      const result = await ingestCsvRows({
        organizationId: auth.organizationId,
        actorType: "api_key",
        actorId: auth.apiKeyId,
        text: csvText,
        sync,
        requestId,
      });
      return {
        status: 201,
        body: { ...result, request_id: requestId },
      };
    };

    if (idempotencyKey) {
      const result = await withIdempotency({
        organizationId: auth.organizationId,
        key: `invoice-bulk:${idempotencyKey}`,
        requestHash: hashRequestBody({ csvText, sync }),
        handler: run,
      });
      return NextResponse.json(result.body, {
        status: result.status,
        headers: {
          "x-request-id": requestId,
          "x-idempotent-replay": result.replayed ? "true" : "false",
        },
      });
    }

    const result = await run();
    return NextResponse.json(result.body, {
      status: result.status,
      headers: { "x-request-id": requestId },
    });
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    const status = typeof e === "object" && e && "status" in e ? Number((e as { status: number }).status) : 400;
    const message = e instanceof Error ? e.message : "Server error";
    return NextResponse.json({ error: message }, { status: status || 400 });
  }
}
