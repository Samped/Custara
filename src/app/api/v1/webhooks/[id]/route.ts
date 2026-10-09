import { NextResponse } from "next/server";
import { AuthError, authenticateApiKey } from "@/lib/auth";
import { setPartnerWebhookActive } from "@/domain/partnerApi";

export const runtime = "nodejs";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await authenticateApiKey(request.headers.get("authorization"), ["connectors:write"]);
    const { id } = await context.params;
    const endpoint = await setPartnerWebhookActive({
      organizationId: auth.organizationId,
      actorId: auth.apiKeyId,
      endpointId: id,
      isActive: false,
    });
    return NextResponse.json({ id: endpoint.id, url: endpoint.url, is_active: endpoint.isActive });
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    const message = e instanceof Error ? e.message : "Server error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
