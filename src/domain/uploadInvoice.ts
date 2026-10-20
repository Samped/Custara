import { revalidatePath } from "next/cache";
import type { SessionUser } from "@/lib/auth";
import { sha256 } from "@/lib/crypto";
import { InvoiceConflictError, ingestInvoice } from "@/domain/ingest";
import { runInvoicePipeline } from "@/domain/pipeline";
import { splitMultiInvoicePdf } from "@/domain/splitMultiInvoicePdf";

async function ingestAndAnalyze(input: {
  organizationId: string;
  actorId: string;
  actorType: "user" | "api_key";
  source: "upload" | "api";
  filename: string;
  mimeType: string;
  bytes: Buffer;
  externalId?: string | null;
  sourceBatchId?: string | null;
  sourceSegmentIndex?: number | null;
  enqueue?: boolean;
}): Promise<string> {
  try {
    const invoice = await ingestInvoice({
      organizationId: input.organizationId,
      actorType: input.actorType,
      actorId: input.actorId,
      source: input.source,
      filename: input.filename,
      mimeType: input.mimeType,
      bytes: input.bytes,
      externalId: input.externalId,
      sourceBatchId: input.sourceBatchId,
      sourceSegmentIndex: input.sourceSegmentIndex,
      enqueue: input.enqueue ?? false,
    });
    if (input.enqueue === false || input.enqueue == null) {
      await runInvoicePipeline(invoice.id, { type: input.actorType, id: input.actorId });
    }
    return invoice.id;
  } catch (e) {
    if (e instanceof InvoiceConflictError) {
      return e.invoiceId;
    }
    throw e;
  }
}

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
  const isPdf = file.type.includes("pdf") || name.endsWith(".pdf");

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

  if (isPdf && !isJson) {
    const children = await splitMultiInvoicePdf(bytes, file.name);
    if (children && children.length >= 2) {
      const batchId = `upload:${sha256(bytes)}`;
      const ids: string[] = [];
      for (const child of children) {
        const id = await ingestAndAnalyze({
          organizationId: user.organizationId,
          actorId: user.id,
          actorType: "user",
          source: "upload",
          filename: child.filename,
          mimeType: "application/pdf",
          bytes: child.bytes,
          externalId: `${batchId}:seg:${child.index}`,
          sourceBatchId: batchId,
          sourceSegmentIndex: child.index,
          enqueue: false,
        });
        ids.push(id);
      }
      revalidatePath("/app");
      revalidatePath("/app/inbox");
      return { redirectTo: `/app/inbox?bulk=${ids.length}&split=1` };
    }
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

/** Partner API helper: ingest a PDF buffer, splitting multi-invoice packs when present. */
export async function processPdfInvoiceBytes(input: {
  organizationId: string;
  actorType: "user" | "api_key";
  actorId: string;
  filename: string;
  bytes: Buffer;
  sync?: boolean;
  externalId?: string | null;
  requestId?: string;
}): Promise<{ ids: string[]; split: boolean }> {
  const sync = input.sync !== false;
  const children = await splitMultiInvoicePdf(input.bytes, input.filename);
  if (children && children.length >= 2) {
    const batchId = `upload:${sha256(input.bytes)}`;
    const ids: string[] = [];
    for (const child of children) {
      const id = await ingestAndAnalyze({
        organizationId: input.organizationId,
        actorId: input.actorId,
        actorType: input.actorType,
        source: input.actorType === "api_key" ? "api" : "upload",
        filename: child.filename,
        mimeType: "application/pdf",
        bytes: child.bytes,
        externalId: input.externalId
          ? `${input.externalId}:seg:${child.index}`
          : `${batchId}:seg:${child.index}`,
        sourceBatchId: batchId,
        sourceSegmentIndex: child.index,
        enqueue: !sync,
      });
      ids.push(id);
    }
    return { ids, split: true };
  }

  const id = await ingestAndAnalyze({
    organizationId: input.organizationId,
    actorId: input.actorId,
    actorType: input.actorType,
    source: input.actorType === "api_key" ? "api" : "upload",
    filename: input.filename,
    mimeType: "application/pdf",
    bytes: input.bytes,
    externalId: input.externalId,
    enqueue: !sync,
  });
  return { ids: [id], split: false };
}
