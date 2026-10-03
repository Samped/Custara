import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { dispatchWebhook } from "@/lib/webhooks";
import { extractInvoice } from "./extract";
import { assessRisks } from "./risk";
import { applyPolicy } from "./policy";

export async function runInvoicePipeline(
  invoiceId: string,
  actor: { type: "user" | "system" | "api_key"; id?: string; requestId?: string },
) {
  const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });

  const extraction = await extractInvoice(invoiceId);
  const { risks, isNewVendor, bankChanged } = await assessRisks(
    invoice.organizationId,
    invoiceId,
    extraction,
  );

  await writeAudit({
    organizationId: invoice.organizationId,
    actorType: actor.type,
    actorId: actor.id,
    action: "invoice.analyzed",
    entityType: "invoice",
    entityId: invoiceId,
    requestId: actor.requestId,
    metadata: {
      confidence: extraction.confidence,
      riskCount: risks.length,
      hardRisks: risks.filter((r) => r.severity === "hard").map((r) => r.code),
    },
  });

  await dispatchWebhook(invoice.organizationId, "invoice.analyzed", {
    id: invoiceId,
    confidence: extraction.confidence,
    risks,
  });

  const hard = risks.filter((r) => r.severity === "hard");
  if (hard.length) {
    await dispatchWebhook(invoice.organizationId, "invoice.anomaly_detected", {
      id: invoiceId,
      risks: hard,
    });
  }

  const policy = await applyPolicy({
    organizationId: invoice.organizationId,
    invoiceId,
    amount: extraction.totalAmount,
    currency: extraction.currency,
    risks,
    isNewVendor,
    bankChanged,
    hasArcDestination: Boolean(extraction.arcAddress),
  });

  if (policy.nextStatus === "approved") {
    const { recommendPayTiming } = await import("@/domain/timing");
    await recommendPayTiming({
      organizationId: invoice.organizationId,
      invoiceId,
    });
  }

  if (policy.nextStatus === "pending_approval" || policy.nextStatus === "needs_review") {
    await dispatchWebhook(invoice.organizationId, "approval.needed", {
      invoice_id: invoiceId,
      decision: policy.decision,
      required: policy.requiredApprovals,
      reason: policy.reason,
      policy_version: policy.policyVersion,
    });
  }

  const refreshed = await prisma.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    include: {
      extraction: true,
      risks: true,
      vendor: { include: { endpoints: { where: { isActive: true } } } },
      approvalRequests: { orderBy: { createdAt: "desc" }, include: { decisions: true } },
    },
  });

  return { invoice: refreshed, policy, extraction, risks };
}

export async function decideApproval(input: {
  approvalId: string;
  organizationId: string;
  userId: string;
  decision: "approved" | "rejected";
  note?: string;
  requestId?: string;
}) {
  const approval = await prisma.approvalRequest.findFirst({
    where: { id: input.approvalId, organizationId: input.organizationId },
    include: { invoice: true, decisions: true },
  });
  if (!approval) throw new Error("Approval not found");
  if (approval.status !== "pending") throw new Error("Approval already decided");

  const prior = approval.decisions.find((d) => d.userId === input.userId);
  if (prior) throw new Error("This user already recorded a decision on this approval (maker-checker)");

  if (input.decision === "rejected") {
    await prisma.approvalDecision.create({
      data: {
        approvalId: approval.id,
        userId: input.userId,
        decision: "rejected",
        note: input.note,
      },
    });
    const updated = await prisma.approvalRequest.update({
      where: { id: approval.id },
      data: {
        status: "rejected",
        decidedById: input.userId,
        decidedAt: new Date(),
        reason: input.note || approval.reason,
      },
    });
    await prisma.invoice.update({
      where: { id: approval.invoiceId },
      data: { status: "rejected", explanation: input.note || "Rejected by approver" },
    });
    await writeAudit({
      organizationId: input.organizationId,
      actorType: "user",
      actorId: input.userId,
      action: "approval.decided",
      entityType: "approval",
      entityId: approval.id,
      requestId: input.requestId,
      metadata: { decision: "rejected", invoiceId: approval.invoiceId },
    });
    await dispatchWebhook(input.organizationId, "approval.decided", {
      id: approval.id,
      invoice_id: approval.invoiceId,
      decision: "rejected",
    });
    return updated;
  }

  await prisma.approvalDecision.create({
    data: {
      approvalId: approval.id,
      userId: input.userId,
      decision: "approved",
      note: input.note,
    },
  });

  const approvedCount = approval.approvedCount + 1;
  const fullyApproved = approvedCount >= approval.requiredCount;

  const updated = await prisma.approvalRequest.update({
    where: { id: approval.id },
    data: {
      approvedCount,
      status: fullyApproved ? "approved" : "pending",
      decidedById: input.userId,
      decidedAt: fullyApproved ? new Date() : null,
      reason: input.note || approval.reason,
    },
  });

  if (fullyApproved) {
    await prisma.invoice.update({
      where: { id: approval.invoiceId },
      data: {
        status: "approved",
        explanation: `Approved (${approvedCount}/${approval.requiredCount}) under policy v${approval.policyVersion ?? "?"}`,
      },
    });
    if (approval.invoice.vendorId) {
      await prisma.vendor.update({
        where: { id: approval.invoice.vendorId },
        data: { isNew: false },
      });
    }
    const { recommendPayTiming } = await import("@/domain/timing");
    await recommendPayTiming({
      organizationId: input.organizationId,
      invoiceId: approval.invoiceId,
    });
  } else {
    await prisma.invoice.update({
      where: { id: approval.invoiceId },
      data: {
        explanation: `Awaiting dual control (${approvedCount}/${approval.requiredCount})`,
      },
    });
  }

  await writeAudit({
    organizationId: input.organizationId,
    actorType: "user",
    actorId: input.userId,
    action: "approval.decided",
    entityType: "approval",
    entityId: approval.id,
    requestId: input.requestId,
    metadata: {
      decision: "approved",
      approvedCount,
      requiredCount: approval.requiredCount,
      invoiceId: approval.invoiceId,
    },
  });

  await dispatchWebhook(input.organizationId, "approval.decided", {
    id: approval.id,
    invoice_id: approval.invoiceId,
    decision: fullyApproved ? "approved" : "partial",
    approved_count: approvedCount,
    required_count: approval.requiredCount,
  });

  return updated;
}
