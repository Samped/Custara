import { NextResponse } from "next/server";
import { AuthError, authenticateApiKey } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { decideApproval } from "@/domain/pipeline";
import { assertRateLimit } from "@/lib/rateLimit";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await authenticateApiKey(request.headers.get("authorization"), ["approvals:write"]);
    await assertRateLimit(`api:${auth.organizationId}:approvals`, 60);
    const { id } = await context.params;
    const body = (await request.json()) as {
      decision?: "approved" | "rejected";
      note?: string;
      approver_email?: string;
    };

    if (!body.decision || !["approved", "rejected"].includes(body.decision)) {
      return NextResponse.json({ error: "decision must be approved|rejected" }, { status: 400 });
    }

    let approver = body.approver_email
      ? await prisma.workspaceUser.findFirst({
          where: {
            organizationId: auth.organizationId,
            email: body.approver_email.toLowerCase(),
            role: { in: ["approver", "admin"] },
            disabledAt: null,
          },
        })
      : null;

    if (!approver) {
      // Pick an approver who has not yet decided on this request
      const existing = await prisma.approvalDecision.findMany({ where: { approvalId: id } });
      const used = new Set(existing.map((d) => d.userId));
      const candidates = await prisma.workspaceUser.findMany({
        where: {
          organizationId: auth.organizationId,
          role: { in: ["approver", "admin"] },
          disabledAt: null,
        },
        orderBy: { email: "asc" },
      });
      approver = candidates.find((c) => !used.has(c.id)) || null;
    }

    if (!approver) {
      return NextResponse.json({ error: "No eligible approver remaining for maker-checker" }, { status: 400 });
    }

    const updated = await decideApproval({
      approvalId: id,
      organizationId: auth.organizationId,
      userId: approver.id,
      decision: body.decision,
      note: body.note || `API decision via key ${auth.apiKeyId}`,
    });

    return NextResponse.json({
      id: updated.id,
      status: updated.status,
      approved_count: updated.approvedCount,
      required_count: updated.requiredCount,
      decided_by: approver.email,
    });
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    const message = e instanceof Error ? e.message : "Server error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
