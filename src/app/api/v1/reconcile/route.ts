import { NextResponse } from "next/server";
import { AuthError, authenticateApiKey } from "@/lib/auth";
import { reconcileSettlement } from "@/domain/cash";

export async function POST(request: Request) {
  try {
    const auth = await authenticateApiKey(request.headers.get("authorization"), ["payments:initiate"]);
    const body = (await request.json()) as {
      invoice_id?: string;
      amount?: number;
      currency?: string;
      reference?: string;
      payment_intent_id?: string;
    };

    if (!body.invoice_id || body.amount == null) {
      return NextResponse.json({ error: "invoice_id and amount required" }, { status: 400 });
    }

    const settlement = await reconcileSettlement({
      organizationId: auth.organizationId,
      invoiceId: body.invoice_id,
      amount: body.amount,
      currency: body.currency,
      reference: body.reference,
      paymentIntentId: body.payment_intent_id,
      actorType: "api_key",
      actorId: auth.apiKeyId,
    });

    return NextResponse.json({ id: settlement.id, invoice_id: settlement.invoiceId, status: "reconciled" });
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    const message = e instanceof Error ? e.message : "Server error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
