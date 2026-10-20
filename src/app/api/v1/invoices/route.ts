import { NextResponse } from "next/server";
import { AuthError, authenticateApiKey } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { InvoiceConflictError, ingestInvoice } from "@/domain/ingest";
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
      /** Base64 PDF bytes — multi-invoice packs are split into separate invoices. */
      pdf_base64?: string;
      filename?: string;
      content_base64?: string;
    };

    const idempotencyKey = request.headers.get("idempotency-key") || body.idempotency_key || null;
    const pdfB64 = body.pdf_base64 || body.content_base64 || null;
    const pdfName = (body.filename || `${body.external_id || "api"}-invoice.pdf`).toLowerCase();
    const isPdfUpload = Boolean(pdfB64 && (pdfName.endsWith(".pdf") || body.pdf_base64));

    const run = async () => {
      if (isPdfUpload && pdfB64) {
        const { processPdfInvoiceBytes } = await import("@/domain/uploadInvoice");
        const bytes = Buffer.from(pdfB64, "base64");
        const result = await processPdfInvoiceBytes({
          organizationId: auth.organizationId,
          actorType: "api_key",
          actorId: auth.apiKeyId,
          filename: body.filename || `${body.external_id || "api"}-invoice.pdf`,
          bytes,
          sync: Boolean(body.sync),
          externalId: body.external_id || null,
          requestId,
        });
        const invoices = await prisma.invoice.findMany({
          where: { id: { in: result.ids }, organizationId: auth.organizationId },
          select: { id: true, status: true, externalId: true },
        });
        return {
          status: 201,
          body: {
            id: invoices[0]?.id || result.ids[0],
            status: invoices[0]?.status || "received",
            external_id: invoices[0]?.externalId || null,
            ids: result.ids,
            split: result.split,
            count: result.ids.length,
            invoices: invoices.map((row) => ({
              id: row.id,
              status: row.status,
              external_id: row.externalId,
            })),
            request_id: requestId,
            async: !body.sync,
          },
        };
      }

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
          ids: [refreshed.id],
          split: false,
          count: 1,
          invoices: [
            {
              id: refreshed.id,
              status: refreshed.status,
              external_id: refreshed.externalId,
            },
          ],
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
  if (e instanceof InvoiceConflictError) {
    return NextResponse.json(
      { error: e.message, id: e.invoiceId, external_id: e.externalId },
      { status: 409 },
    );
  }
  const status = typeof e === "object" && e && "status" in e ? Number((e as { status: number }).status) : 400;
  const message = e instanceof Error ? e.message : "Server error";
  const safe = message.includes("Invalid `prisma.") ? "Server error" : message;
  return NextResponse.json({ error: safe }, { status: status || 400 });
}
