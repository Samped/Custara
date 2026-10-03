import { NextResponse } from "next/server";
import { AuthError, authenticateApiKey } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { loadPolicyRules } from "@/domain/policy";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await authenticateApiKey(request.headers.get("authorization"), ["invoices:read"]);
    const { id } = await context.params;

    const invoice = await prisma.invoice.findFirst({
      where: { id, organizationId: auth.organizationId },
      include: {
        extraction: true,
        risks: true,
        approvalRequests: { orderBy: { createdAt: "desc" }, take: 1 },
        vendor: true,
      },
    });
    if (!invoice) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const policy = await loadPolicyRules(auth.organizationId);

    return NextResponse.json({
      id: invoice.id,
      status: invoice.status,
      extraction: invoice.extraction
        ? {
            ...invoice.extraction,
            lineItems: JSON.parse(invoice.extraction.lineItemsJson),
          }
        : null,
      confidence: invoice.extraction?.confidence ?? null,
      risks: invoice.risks.map((r) => ({
        code: r.code,
        severity: r.severity,
        message: r.message,
      })),
      policy_result: {
        explanation: invoice.explanation,
        active_policy: policy,
        latest_approval: invoice.approvalRequests[0] || null,
      },
      vendor: invoice.vendor
        ? { id: invoice.vendor.id, name: invoice.vendor.name, is_new: invoice.vendor.isNew }
        : null,
    });
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
