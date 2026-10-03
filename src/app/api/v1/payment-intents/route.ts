import { NextResponse } from "next/server";
import { AuthError, authenticateApiKey } from "@/lib/auth";
import { createPaymentIntent } from "@/domain/payment";
import { assertRateLimit } from "@/lib/rateLimit";
import { hashRequestBody, withIdempotency } from "@/lib/idempotency";
import { createRequestId } from "@/lib/audit";

export async function POST(request: Request) {
  try {
    const auth = await authenticateApiKey(request.headers.get("authorization"), ["payments:initiate"]);
    await assertRateLimit(`api:${auth.organizationId}:payments`, 30);
    const requestId = request.headers.get("x-request-id") || createRequestId();
    const body = (await request.json()) as {
      invoice_id?: string;
      idempotency_key?: string;
      rail?: string;
    };

    const idempotencyKey =
      request.headers.get("idempotency-key") || body.idempotency_key;
    if (!body.invoice_id || !idempotencyKey) {
      return NextResponse.json(
        { error: "invoice_id and idempotency_key (or Idempotency-Key header) required" },
        { status: 400 },
      );
    }

    const result = await withIdempotency({
      organizationId: auth.organizationId,
      key: `payment:${idempotencyKey}`,
      requestHash: hashRequestBody(body),
      handler: async () => {
        const intent = await createPaymentIntent({
          organizationId: auth.organizationId,
          invoiceId: body.invoice_id!,
          idempotencyKey,
          rail: body.rail || "arc_usdc",
          actorType: "api_key",
          actorId: auth.apiKeyId,
          requestId,
          apiStepUpToken: request.headers.get("x-custara-step-up"),
        });
        return {
          status: 201,
          body: {
            id: intent.id,
            status: intent.status,
            rail: intent.rail,
            mode: intent.mode,
            export_path: intent.exportPath,
            provider_ref: intent.providerRef,
            circle_tx_id: intent.circleTxId,
            tx_hash: intent.txHash,
            amount: intent.amount,
            currency: intent.currency,
            request_id: requestId,
          },
        };
      },
    });

    return NextResponse.json(result.body, {
      status: result.status,
      headers: {
        "x-request-id": requestId,
        "x-idempotent-replay": result.replayed ? "true" : "false",
      },
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
