import { NextRequest, NextResponse } from "next/server";
import { AuthError, canApprove, canPay, requireSessionUser } from "@/lib/auth";
import { decideApproval } from "@/domain/pipeline";
import { createPaymentIntent } from "@/domain/payment";
import { reconcileSettlement } from "@/domain/cash";

export const runtime = "nodejs";

/** JSON invoice mutations — avoids FormData server actions broken by wallet extensions. */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const action = String(body.action || "");

    if (action === "confirm_destination") {
      const user = await requireSessionUser(["admin", "approver", "payer"]);
      const invoiceId = String(body.invoiceId || "");
      const { confirmInvoiceDestination } = await import("@/domain/arc/allowlist");
      await confirmInvoiceDestination({
        organizationId: user.organizationId,
        invoiceId,
        actorId: user.id,
      });
      return NextResponse.json({ ok: true, redirectTo: `/app/invoices/${invoiceId}` });
    }

    if (action === "verify_vendor") {
      const user = await requireSessionUser(["admin", "approver"], "approvals:write");
      if (!canApprove(user.role)) throw new AuthError("Forbidden", 403);
      const invoiceId = String(body.invoiceId || "");
      const { verifyVendorForInvoice } = await import("@/domain/vendorVerify");
      await verifyVendorForInvoice({
        organizationId: user.organizationId,
        invoiceId,
        actorId: user.id,
      });
      return NextResponse.json({ ok: true, redirectTo: `/app/invoices/${invoiceId}` });
    }

    if (action === "decide_approval") {
      const user = await requireSessionUser(["admin", "approver"], "approvals:write");
      if (!canApprove(user.role)) throw new AuthError("Forbidden", 403);
      const approvalId = String(body.approvalId || "");
      const decision = String(body.decision || "") as "approved" | "rejected";
      const note = body.note ? String(body.note) : undefined;
      await decideApproval({
        approvalId,
        organizationId: user.organizationId,
        userId: user.id,
        decision,
        note,
      });
      return NextResponse.json({ ok: true });
    }

    if (action === "create_payment") {
      const user = await requireSessionUser(["admin", "payer"], "payments:write");
      if (!canPay(user.role)) throw new AuthError("Forbidden", 403);
      const invoiceId = String(body.invoiceId || "");
      const idempotencyKey =
        String(body.idempotencyKey || "") || `pay_${invoiceId}_${Date.now()}`;
      const mfaCode = body.mfaCode ? String(body.mfaCode) : null;
      const intent = await createPaymentIntent({
        organizationId: user.organizationId,
        invoiceId,
        idempotencyKey,
        actorType: "user",
        actorId: user.id,
        mfaCode,
      });
      return NextResponse.json({ ok: true, redirectTo: `/app/payments?intent=${intent.id}` });
    }

    if (action === "reconcile") {
      const user = await requireSessionUser(["admin", "payer"], "payments:write");
      const invoiceId = String(body.invoiceId || "");
      const amount = Number(body.amount || 0);
      const paymentIntentId = body.paymentIntentId ? String(body.paymentIntentId) : undefined;
      await reconcileSettlement({
        organizationId: user.organizationId,
        invoiceId,
        amount,
        paymentIntentId,
        actorType: "user",
        actorId: user.id,
      });
      return NextResponse.json({ ok: true, redirectTo: `/app/invoices/${invoiceId}` });
    }

    if (action === "retry_payment") {
      const user = await requireSessionUser(["admin", "payer"], "payments:write");
      const paymentIntentId = String(body.paymentIntentId || "");
      const { retryFailedArcPayment } = await import("@/domain/arc/tasks");
      const result = await retryFailedArcPayment({
        organizationId: user.organizationId,
        paymentIntentId,
        actorId: user.id,
      });
      return NextResponse.json({
        ok: true,
        alreadyCompleted: result.alreadyCompleted,
        redirectTo: `/app/payments?intent=${result.intent.id}`,
        taskId: result.task?.id ?? null,
      });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Request failed" },
      { status: 400 },
    );
  }
}
