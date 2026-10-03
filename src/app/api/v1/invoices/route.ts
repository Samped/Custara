import { NextResponse } from "next/server";
import { AuthError, authenticateApiKey } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ingestInvoice } from "@/domain/ingest";
import { runInvoicePipeline } from "@/domain/pipeline";
import { assertRateLimit } from "@/lib/rateLimit";
import { createRequestId } from "@/lib/audit";
import { pageResult, parseCursorPagination } from "@/lib/pagination";
import { hashRequestBody, withIdempotency } from "@/lib/idempotency";

export async function GET(request: Request) {
  try {
    const auth = await authenticateApiKey(request.headers.get("authorization"), ["invoices:read"]);
    await assertRateLimit(`api:${auth.organizationId}:invoices:read`, 120);
    const { limit, cursor } = parseCursorPagination(new URL(request.url));
    const rows = await prisma.invoice.findMany({
      where: { organizationId: auth.organizationId },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        status: true,
        externalId: true,
        invoiceNumber: true,
        currency: true,
        totalAmount: true,
        dueDate: true,
        createdAt: true,
        source: true,
      },
    });
    return NextResponse.json(pageResult(rows, limit));
  } catch (e) {
    return apiError(e);
  }
}

export async function POST(request: Request) {
  try {
    const auth = await authenticateApiKey(request.headers.get("authorization"), ["invoices:write"]);
    await assertRateLimit(`api:${auth.organizationId}:invoices:write`, 60);
    const requestId = request.headers.get("x-request-id") || createRequestId();
    const body = (await request.json()) as {
      external_id?: string;
      currency?: string;
      vendor_external_id?: string;
      document?: Record<string, unknown>;
      sync?: boolean;
      idempotency_key?: string;
    };

    const idempotencyKey = request.headers.get("idempotency-key") || body.idempotency_key || null;

    const run = async () => {
      const invoice = await ingestInvoice({
        organizationId: auth.organizationId,
        actorType: "api_key",
        actorId: auth.apiKeyId,
        source: "api",
        externalId: body.external_id || null,
        currency: body.currency || "NGN",
        vendorExternalId: body.vendor_external_id || null,
        structuredPayload: body.document || body,
        filename: `${body.external_id || "api"}-invoice.json`,
        requestId,
        enqueue: body.sync ? false : true,
      });

      if (body.sync) {
        await runInvoicePipeline(invoice.id, {
          type: "api_key",
          id: auth.apiKeyId,
          requestId,
        });
      }

      const refreshed = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
      return {
        status: 201,
        body: {
          id: refreshed.id,
          status: refreshed.status,
          external_id: refreshed.externalId,
          request_id: requestId,
          async: !body.sync,
        },
      };
    };

    if (idempotencyKey) {
      const result = await withIdempotency({
        organizationId: auth.organizationId,
        key: `invoice:${idempotencyKey}`,
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
    return apiError(e);
  }
}

function apiError(e: unknown) {
  if (e instanceof AuthError) {
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
  const status = typeof e === "object" && e && "status" in e ? Number((e as { status: number }).status) : 400;
  const message = e instanceof Error ? e.message : "Server error";
  return NextResponse.json({ error: message }, { status: status || 400 });
}
