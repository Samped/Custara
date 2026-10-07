import { revalidatePath } from "next/cache";
import type { SessionUser } from "@/lib/auth";
import { ingestInvoice } from "@/domain/ingest";
import { runInvoicePipeline } from "@/domain/pipeline";

/** Shared upload handler used by server action and XHR API (extension-safe). */
export async function processInvoiceUpload(
  user: SessionUser,
  file: File,
): Promise<{ redirectTo: string }> {
  if (!file || file.size === 0) {
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
      return { redirectTo: `/app/invoices/${result.results[0].id}` };
    }
    return { redirectTo: `/app/inbox?bulk=${result.ingested}&failed=${result.failed}` };
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
  return { redirectTo: `/app/invoices/${invoice.id}` };
}
