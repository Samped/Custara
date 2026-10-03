import { NextResponse } from "next/server";
import { AuthError, authenticateApiKey } from "@/lib/auth";
import { assertRateLimit } from "@/lib/rateLimit";
import { createRequestId } from "@/lib/audit";
import { hashRequestBody, withIdempotency } from "@/lib/idempotency";
import { ingestFirsInvoice, type FirsInvoicePayload } from "@/domain/einvoice/firs";

export async function POST(request: Request) {
  try {
    const auth = await authenticateApiKey(request.headers.get("authorization"), ["invoices:write"]);
    await assertRateLimit(`api:${auth.organizationId}:firs`, 60);
    const requestId = request.headers.get("x-request-id") || createRequestId();
    const body = (await request.json()) as FirsInvoicePayload & {
      sync?: boolean;
      idempotency_key?: string;
    };

    const idempotencyKey = request.headers.get("idempotency-key") || body.idempotency_key || null;

    const run = async () => {
      const result = await ingestFirsInvoice({
        organizationId: auth.organizationId,
        payload: body,
        sync: Boolean(body.sync),
        actorType: "api_key",
        actorId: auth.apiKeyId,
      });
      return {
        status: result.created ? 201 : 200,
        body: {
          id: result.invoice.id,
          status: result.invoice.status,
          created: result.created,
          request_id: requestId,
        },
      };
    };

    if (idempotencyKey) {
      const result = await withIdempotency({
        organizationId: auth.organizationId,
        key: `firs:${idempotencyKey}`,
        requestHash: hashRequestBody(body),
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
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "FIRS ingest failed" },
      { status: 400 },
    );
  }
}
