import { NextResponse } from "next/server";
import { AuthError, authenticateApiKey } from "@/lib/auth";
import { assertRateLimit } from "@/lib/rateLimit";
import { createRequestId } from "@/lib/audit";
import { hashRequestBody, withIdempotency } from "@/lib/idempotency";
import {
  ingestErpBill,
  mapDynamicsPurchaseInvoice,
  mapOdooAccountMove,
  mapSapApInvoice,
} from "@/domain/erp/adapters";

/**
 * Generic ERP ingest endpoint.
 * Body: { system: "odoo"|"sap"|"dynamics", payload: {...}, sync?: boolean }
 */
export async function POST(request: Request) {
  try {
    const auth = await authenticateApiKey(request.headers.get("authorization"), ["invoices:write"]);
    await assertRateLimit(`api:${auth.organizationId}:erp`, 60);
    const requestId = request.headers.get("x-request-id") || createRequestId();
    const body = (await request.json()) as {
      system?: "odoo" | "sap" | "dynamics";
      payload?: Record<string, unknown>;
      sync?: boolean;
      idempotency_key?: string;
    };

    if (!body.system || !body.payload) {
      return NextResponse.json({ error: "system and payload required" }, { status: 400 });
    }

    const bill =
      body.system === "odoo"
        ? mapOdooAccountMove(body.payload as Parameters<typeof mapOdooAccountMove>[0])
        : body.system === "sap"
          ? mapSapApInvoice(body.payload as Parameters<typeof mapSapApInvoice>[0])
          : mapDynamicsPurchaseInvoice(
              body.payload as Parameters<typeof mapDynamicsPurchaseInvoice>[0],
            );

    const idempotencyKey = request.headers.get("idempotency-key") || body.idempotency_key || null;

    const run = async () => {
      const invoice = await ingestErpBill({
        organizationId: auth.organizationId,
        system: body.system!,
        bill,
        sync: Boolean(body.sync),
        actorType: "api_key",
        actorId: auth.apiKeyId,
      });
      return {
        status: 201,
        body: {
          id: invoice.id,
          status: invoice.status,
          external_id: invoice.externalId,
          system: body.system,
          request_id: requestId,
        },
      };
    };

    if (idempotencyKey) {
      const result = await withIdempotency({
        organizationId: auth.organizationId,
        key: `erp:${body.system}:${idempotencyKey}`,
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
      { error: e instanceof Error ? e.message : "ERP ingest failed" },
      { status: 400 },
    );
  }
}
