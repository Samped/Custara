import { NextRequest, NextResponse } from "next/server";
import { AuthError, canApprove, canPay, requireSessionUser } from "@/lib/auth";
import { decideApproval } from "@/domain/pipeline";
import { createPaymentIntent } from "@/domain/payment";
import { reconcileSettlement } from "@/domain/cash";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 60;

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
      const amountRaw = body.amount != null ? Number(body.amount) : null;
      const intent = await createPaymentIntent({
        organizationId: user.organizationId,
        invoiceId,
        idempotencyKey,
        actorType: "user",
        actorId: user.id,
        mfaCode,
        amount: amountRaw && amountRaw > 0 ? amountRaw : null,
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

    if (action === "apply_credit") {
      const user = await requireSessionUser(["admin", "approver", "payer"], "payments:write");
      const { applyVendorCredit } = await import("@/domain/apLedger");
      await applyVendorCredit({
        organizationId: user.organizationId,
        invoiceId: String(body.invoiceId || ""),
        creditInvoiceId: String(body.creditInvoiceId || ""),
        actorId: user.id,
      });
      return NextResponse.json({ ok: true, redirectTo: `/app/invoices/${body.invoiceId}` });
    }

    if (action === "waive_credit") {
      const user = await requireSessionUser(["admin", "approver", "payer"], "payments:write");
      const { waiveVendorCredits } = await import("@/domain/apLedger");
      await waiveVendorCredits({
        organizationId: user.organizationId,
        invoiceId: String(body.invoiceId || ""),
        actorId: user.id,
      });
      return NextResponse.json({ ok: true, redirectTo: `/app/invoices/${body.invoiceId}` });
    }

    if (action === "add_comment") {
      const user = await requireSessionUser(undefined, "invoice:read");
      const { addInvoiceComment } = await import("@/domain/apWork");
      await addInvoiceComment({
        organizationId: user.organizationId,
        invoiceId: String(body.invoiceId || ""),
        authorId: user.id,
        body: String(body.body || ""),
      });
      return NextResponse.json({ ok: true, redirectTo: `/app/invoices/${body.invoiceId}` });
    }

    if (action === "add_activity") {
      const user = await requireSessionUser(["admin", "approver", "payer"], "approvals:write");
      const { addInvoiceActivity } = await import("@/domain/apWork");
      await addInvoiceActivity({
        organizationId: user.organizationId,
        invoiceId: String(body.invoiceId || ""),
        title: String(body.title || ""),
        dueAt: body.dueAt ? new Date(String(body.dueAt)) : null,
        actorId: user.id,
      });
      return NextResponse.json({ ok: true, redirectTo: `/app/invoices/${body.invoiceId}` });
    }

    if (action === "complete_activity") {
      const user = await requireSessionUser(["admin", "approver", "payer"], "approvals:write");
      const { completeInvoiceActivity } = await import("@/domain/apWork");
      await completeInvoiceActivity({
        organizationId: user.organizationId,
        activityId: String(body.activityId || ""),
        actorId: user.id,
      });
      return NextResponse.json({ ok: true, redirectTo: `/app/invoices/${body.invoiceId}` });
    }

    if (action === "set_hold") {
      const user = await requireSessionUser(["admin", "approver"], "approvals:write");
      const { setInvoiceHoldReason } = await import("@/domain/apWork");
      await setInvoiceHoldReason({
        organizationId: user.organizationId,
        invoiceId: String(body.invoiceId || ""),
        holdReason: String(body.holdReason || ""),
        actorId: user.id,
      });
      return NextResponse.json({ ok: true, redirectTo: `/app/invoices/${body.invoiceId}` });
    }

    if (action === "set_recurring") {
      const user = await requireSessionUser(["admin", "payer"], "payments:write");
      const invoiceId = String(body.invoiceId || "");
      const interval = String(body.recurringInterval || "") || null;
      await prisma.invoice.updateMany({
        where: { id: invoiceId, organizationId: user.organizationId },
        data: { recurringInterval: interval === "monthly" || interval === "weekly" ? interval : null },
      });
      return NextResponse.json({ ok: true, redirectTo: `/app/invoices/${invoiceId}` });
    }

    if (action === "spawn_recurring") {
      const user = await requireSessionUser(["admin", "payer"], "payments:write");
      const { spawnRecurringInvoice } = await import("@/domain/apWork");
      const next = await spawnRecurringInvoice({
        organizationId: user.organizationId,
        invoiceId: String(body.invoiceId || ""),
        actorId: user.id,
      });
      return NextResponse.json({ ok: true, redirectTo: `/app/invoices/${next.id}` });
    }

    if (action === "create_pay_run") {
      const user = await requireSessionUser(["admin", "payer"], "payments:write");
      const { createPayRun, executePayRun } = await import("@/domain/payRun");
      const ids = String(body.invoiceIds || "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
      const run = await createPayRun({
        organizationId: user.organizationId,
        actorId: user.id,
        items: ids.map((invoiceId) => ({ invoiceId })),
      });
      await executePayRun({
        organizationId: user.organizationId,
        payRunId: run.id,
        actorId: user.id,
        mfaCode: body.mfaCode ? String(body.mfaCode) : null,
      });
      return NextResponse.json({ ok: true, redirectTo: `/app/payments?tab=run&run=${run.id}` });
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
