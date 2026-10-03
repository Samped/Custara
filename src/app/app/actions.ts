"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { canApprove, canPay, requireSessionUser } from "@/lib/auth";
import { ingestInvoice } from "@/domain/ingest";
import { runInvoicePipeline, decideApproval } from "@/domain/pipeline";
import { createPaymentIntent } from "@/domain/payment";
import { reconcileSettlement } from "@/domain/cash";

export async function uploadInvoiceAction(formData: FormData) {
  const user = await requireSessionUser(["admin", "payer", "approver"], "inbox:read");
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    throw new Error("File required");
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const name = file.name.toLowerCase();
  const isJson = file.type.includes("json") || name.endsWith(".json");
  const isCsv = file.type.includes("csv") || name.endsWith(".csv") || name.endsWith(".tsv");

  if (isCsv) {
    const { ingestCsvRows } = await import("@/domain/csvIngest");
    const result = await ingestCsvRows({
      organizationId: user.organizationId,
      actorType: "user",
      actorId: user.id,
      text: bytes.toString("utf8"),
      sync: true,
    });
    revalidatePath("/app");
    revalidatePath("/app/inbox");
    if (result.results.length === 1) {
      redirect(`/app/invoices/${result.results[0].id}`);
    }
    redirect(`/app/inbox?bulk=${result.ingested}&failed=${result.failed}`);
  }

  let structuredPayload: Record<string, unknown> | null = null;
  if (isJson) {
    structuredPayload = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  }

  const invoice = await ingestInvoice({
    organizationId: user.organizationId,
    actorType: "user",
    actorId: user.id,
    source: "upload",
    filename: file.name,
    mimeType: file.type || (isJson ? "application/json" : "application/octet-stream"),
    bytes: isJson ? null : bytes,
    structuredPayload,
    enqueue: false,
  });

  await runInvoicePipeline(invoice.id, { type: "user", id: user.id });
  revalidatePath("/app");
  revalidatePath("/app/inbox");
  redirect(`/app/invoices/${invoice.id}`);
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
