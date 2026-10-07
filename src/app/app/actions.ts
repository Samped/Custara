"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { canApprove, canPay, requireSessionUser } from "@/lib/auth";
import { decideApproval } from "@/domain/pipeline";
import { createPaymentIntent } from "@/domain/payment";
import { reconcileSettlement } from "@/domain/cash";

export async function uploadInvoiceAction(formData: FormData) {
  const user = await requireSessionUser(undefined, "inbox:write");
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    throw new Error("File required");
  }
  const { processInvoiceUpload } = await import("@/domain/uploadInvoice");
  const { redirectTo } = await processInvoiceUpload(user, file);
  redirect(redirectTo);
}

export async function syncMailboxAction() {
  const { pollOrganizationMailbox } = await import("@/domain/mailbox");
  const user = await requireSessionUser(["admin"], "connectors:write");
  await pollOrganizationMailbox(user.organizationId);
  revalidatePath("/app/inbox");
  revalidatePath("/app/connectors");
  redirect("/app/inbox?mailbox=synced");
}

export async function decideApprovalAction(formData: FormData) {
  const user = await requireSessionUser(["admin", "approver"], "approvals:write");
  if (!canApprove(user.role)) throw new Error("Forbidden");

  const approvalId = String(formData.get("approvalId") || "");
  const decision = String(formData.get("decision") || "") as "approved" | "rejected";
  const note = String(formData.get("note") || "");

  await decideApproval({
    approvalId,
    organizationId: user.organizationId,
    userId: user.id,
    decision,
    note: note || undefined,
  });

  revalidatePath("/app/approvals");
  revalidatePath("/app");
}

export async function createPaymentAction(formData: FormData) {
  const user = await requireSessionUser(["admin", "payer"], "payments:write");
  if (!canPay(user.role)) throw new Error("Forbidden");

  const invoiceId = String(formData.get("invoiceId") || "");
  const idempotencyKey = String(formData.get("idempotencyKey") || `pay_${invoiceId}_${Date.now()}`);
  const mfaCode = String(formData.get("mfaCode") || "") || null;

  const intent = await createPaymentIntent({
    organizationId: user.organizationId,
    invoiceId,
    idempotencyKey,
    actorType: "user",
    actorId: user.id,
    mfaCode,
  });

  revalidatePath("/app/payments");
  revalidatePath(`/app/invoices/${invoiceId}`);
  redirect(`/app/payments?intent=${intent.id}`);
}

export async function reconcileAction(formData: FormData) {
  const user = await requireSessionUser(["admin", "payer"], "payments:write");
  const invoiceId = String(formData.get("invoiceId") || "");
  const amount = Number(formData.get("amount") || 0);
  const paymentIntentId = String(formData.get("paymentIntentId") || "") || undefined;

  await reconcileSettlement({
    organizationId: user.organizationId,
    invoiceId,
    amount,
    paymentIntentId,
    actorType: "user",
    actorId: user.id,
  });

  revalidatePath("/app/payments");
  revalidatePath(`/app/invoices/${invoiceId}`);
}

export async function verifyVendorAction(formData: FormData) {
  const user = await requireSessionUser(["admin", "approver"], "approvals:write");
  if (!canApprove(user.role)) throw new Error("Forbidden");
  const invoiceId = String(formData.get("invoiceId") || "");
  const { verifyVendorForInvoice } = await import("@/domain/vendorVerify");
  await verifyVendorForInvoice({
    organizationId: user.organizationId,
    invoiceId,
    actorId: user.id,
  });
  revalidatePath(`/app/invoices/${invoiceId}`);
  revalidatePath("/app/approvals");
  revalidatePath("/app/vendors");
  revalidatePath("/app");
  redirect(`/app/invoices/${invoiceId}`);
}

export async function confirmDestinationAction(formData: FormData) {
  // Control decision on the invoice — no Wallets detour; admin / approver / payer.
  const user = await requireSessionUser(["admin", "approver", "payer"]);
  const invoiceId = String(formData.get("invoiceId") || "");
  const { confirmInvoiceDestination } = await import("@/domain/arc/allowlist");
  await confirmInvoiceDestination({
    organizationId: user.organizationId,
    invoiceId,
    actorId: user.id,
  });
  revalidatePath(`/app/invoices/${invoiceId}`);
  revalidatePath("/app/payments");
  redirect(`/app/invoices/${invoiceId}`);
}
