import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { ingestInvoice } from "@/domain/ingest";
import { runInvoicePipeline } from "@/domain/pipeline";

/**
 * Nigeria FIRS / e-invoicing style structured invoice adapter.
 * Accepts UBL-like JSON or FIRS IRN payloads and maps into ingestInvoice.
 */
export type FirsInvoicePayload = {
  irn?: string;
  invoice_number?: string;
  invoiceNumber?: string;
  supplier?: { name?: string; tin?: string };
  vendor_name?: string;
  buyer?: { name?: string; tin?: string };
  issue_date?: string;
  due_date?: string;
  currency?: string;
  total?: number;
  total_amount?: number;
  line_items?: Array<{ description?: string; quantity?: number; unit_price?: number }>;
  raw_xml?: string;
};

export async function ensureFirsConnector(organizationId: string) {
  return prisma.integrationConnector.upsert({
    where: { organizationId_type: { organizationId, type: "einvoice_firs" } },
    create: {
      organizationId,
      type: "einvoice_firs",
      name: "FIRS / e-Invoice",
      status: "connected",
      configJson: JSON.stringify({
        mode: process.env.FIRS_MODE || "sandbox",
        acceptStructuredJson: true,
      }),
      secretsJson: "{}",
    },
    update: {},
  });
}

export function mapFirsToDocument(payload: FirsInvoicePayload): Record<string, unknown> {
  return {
    vendor_name: payload.vendor_name || payload.supplier?.name,
    vendor_tin: payload.supplier?.tin,
    buyer_name: payload.buyer?.name,
    buyer_tin: payload.buyer?.tin,
    invoice_number: payload.invoice_number || payload.invoiceNumber || payload.irn,
    irn: payload.irn,
    invoice_date: payload.issue_date,
    due_date: payload.due_date,
    currency: (payload.currency || "NGN").toUpperCase(),
    total_amount: payload.total_amount ?? payload.total,
    line_items: payload.line_items,
    scheme: "firs_einvoice",
  };
}

export async function ingestFirsInvoice(input: {
  organizationId: string;
  payload: FirsInvoicePayload;
  sync?: boolean;
  actorType?: "user" | "system" | "api_key";
  actorId?: string;
}) {
  await ensureFirsConnector(input.organizationId);
  const document = mapFirsToDocument(input.payload);
  const externalId = input.payload.irn
    ? `firs:${input.payload.irn}`
    : input.payload.invoice_number
      ? `firs:${input.payload.invoice_number}`
      : null;

  if (externalId) {
    const existing = await prisma.invoice.findFirst({
      where: { organizationId: input.organizationId, externalId },
    });
    if (existing) return { invoice: existing, created: false };
  }

  const invoice = await ingestInvoice({
    organizationId: input.organizationId,
    actorType: input.actorType || "api_key",
    actorId: input.actorId,
    source: "accounting",
    externalId,
    currency: String(document.currency || "NGN"),
    structuredPayload: document,
    filename: `firs-${externalId || "invoice"}.json`,
    bytes: input.payload.raw_xml ? Buffer.from(input.payload.raw_xml, "utf8") : null,
    mimeType: input.payload.raw_xml ? "application/xml" : undefined,
    enqueue: input.sync ? false : true,
  });

  if (input.sync) {
    await runInvoicePipeline(invoice.id, {
      type: input.actorType || "system",
      id: input.actorId,
    });
  }

  await writeAudit({
    organizationId: input.organizationId,
    actorType: input.actorType || "system",
    actorId: input.actorId,
    action: "einvoice.firs_ingested",
    entityType: "invoice",
    entityId: invoice.id,
    metadata: { irn: input.payload.irn },
  });

  return { invoice, created: true };
}
