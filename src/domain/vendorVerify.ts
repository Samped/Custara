import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";

const REVIEW_RISK_CODES = [
  "new_vendor",
  "bank_detail_change",
  "low_confidence",
  "arc_address_change",
] as const;

/**
 * Mark vendor as verified and clear review holds so pay-time guards can proceed.
 * Used after human confirmation (approval completion or explicit Verify on invoice).
 */
export async function verifyVendorForInvoice(input: {
  organizationId: string;
  invoiceId: string;
  actorId: string;
}) {
  const invoice = await prisma.invoice.findFirst({
    where: { id: input.invoiceId, organizationId: input.organizationId },
    include: { vendor: true, risks: true, approvalRequests: { where: { status: "pending" } } },
  });
  if (!invoice) throw new Error("Invoice not found");

  if (invoice.vendorId) {
    await prisma.vendor.update({
      where: { id: invoice.vendorId },
      data: { isNew: false },
    });
  }

  await prisma.riskAssessment.deleteMany({
    where: {
      invoiceId: invoice.id,
      code: { in: [...REVIEW_RISK_CODES] },
    },
  });

  // If still in needs_review with a pending approval for new-vendor style holds, approve it.
  const pending = invoice.approvalRequests[0];
  if (pending && (invoice.status === "needs_review" || invoice.status === "pending_approval")) {
    const { decideApproval } = await import("@/domain/pipeline");
    await decideApproval({
      approvalId: pending.id,
      organizationId: input.organizationId,
      userId: input.actorId,
      decision: "approved",
      note: "Vendor verified",
    });
  } else if (invoice.status === "needs_review") {
    await prisma.invoice.update({
      where: { id: invoice.id },
      data: {
        status: "approved",
        explanation: "Vendor verified — ready for payment",
      },
    });
    const { recommendPayTiming } = await import("@/domain/timing");
    await recommendPayTiming({
      organizationId: input.organizationId,
      invoiceId: invoice.id,
    });
  }

  await writeAudit({
    organizationId: input.organizationId,
    actorType: "user",
    actorId: input.actorId,
    action: "vendor.verified",
    entityType: "invoice",
    entityId: invoice.id,
    metadata: { vendorId: invoice.vendorId, vendorName: invoice.vendor?.name },
  });

  return prisma.invoice.findFirstOrThrow({
    where: { id: invoice.id },
    include: { risks: true, vendor: true },
  });
}
