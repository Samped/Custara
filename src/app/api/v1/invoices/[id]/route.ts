import { NextResponse } from "next/server";
import { AuthError, authenticateApiKey } from "@/lib/auth";
import { prisma } from "@/lib/db";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await authenticateApiKey(request.headers.get("authorization"), ["invoices:read"]);
    const { id } = await context.params;
    const invoice = await prisma.invoice.findFirst({
      where: { id, organizationId: auth.organizationId },
    });
    if (!invoice) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(invoice);
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
