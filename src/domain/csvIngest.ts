import { ingestInvoice } from "@/domain/ingest";
import { runInvoicePipeline } from "@/domain/pipeline";

export const CSV_TEMPLATE_HEADERS = [
  "vendor_name",
  "invoice_number",
  "total_amount",
  "currency",
  "due_date",
  "invoice_date",
  "description",
  "bank_name",
  "account_number",
  "account_name",
  "arc_address",
  "external_id",
] as const;

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function normalizeHeader(h: string) {
  return h
    .trim()
    .toLowerCase()
    .replace(/^\ufeff/, "")
    .replace(/\s+/g, "_");
}

export function parseInvoiceCsv(text: string): {
  headers: string[];
  rows: Record<string, string>[];
} {
  const lines = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) throw new Error("CSV needs a header row and at least one data row");

  const headers = splitCsvLine(lines[0]).map(normalizeHeader);
  if (!headers.includes("vendor_name") && !headers.includes("invoice_number")) {
    throw new Error("CSV must include vendor_name and/or invoice_number columns");
  }

  const rows: Record<string, string>[] = [];
  for (const line of lines.slice(1)) {
    const cols = splitCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = (cols[i] || "").trim();
    });
    if (Object.values(row).every((v) => !v)) continue;
    rows.push(row);
  }
  if (!rows.length) throw new Error("No data rows found in CSV");
  return { headers, rows };
}

export function rowToDocument(row: Record<string, string>): Record<string, unknown> {
  const amountRaw = row.total_amount || row.amount || "";
  const amount = amountRaw ? Number(String(amountRaw).replace(/,/g, "")) : undefined;
  return {
    vendor_name: row.vendor_name || row.vendor || undefined,
    invoice_number: row.invoice_number || row.number || undefined,
    total_amount: Number.isFinite(amount) ? amount : undefined,
    currency: (row.currency || "NGN").toUpperCase(),
    due_date: row.due_date || undefined,
    invoice_date: row.invoice_date || row.date || undefined,
    description: row.description || undefined,
    bank_name: row.bank_name || undefined,
    account_number: row.account_number || undefined,
    account_name: row.account_name || undefined,
    arc_address: row.arc_address || undefined,
  };
}

export async function ingestCsvRows(input: {
  organizationId: string;
  actorType: "user" | "system" | "api_key";
  actorId?: string;
  text: string;
  sync?: boolean;
  requestId?: string;
}) {
  const { rows } = parseInvoiceCsv(input.text);
  const results: { external_id: string | null; id: string; status: string }[] = [];
  const errors: { row: number; error: string }[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const document = rowToDocument(row);
      const externalId = row.external_id || null;
      const invoice = await ingestInvoice({
        organizationId: input.organizationId,
        actorType: input.actorType,
        actorId: input.actorId,
        source: "upload",
        externalId,
        currency: String(document.currency || "NGN"),
        structuredPayload: document,
        filename: `csv-row-${i + 1}.json`,
        requestId: input.requestId,
        enqueue: input.sync ? false : true,
      });
      if (input.sync) {
        await runInvoicePipeline(invoice.id, {
          type: input.actorType,
          id: input.actorId,
          requestId: input.requestId,
        });
      }
      const refreshed = await (
        await import("@/lib/db")
      ).prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
      results.push({
        external_id: refreshed.externalId,
        id: refreshed.id,
        status: refreshed.status,
      });
    } catch (e) {
      errors.push({ row: i + 2, error: e instanceof Error ? e.message : "Failed" });
    }
  }

  return {
    total: rows.length,
    ingested: results.length,
    failed: errors.length,
    results,
    errors,
  };
}

export function csvTemplateContent() {
  return `${CSV_TEMPLATE_HEADERS.join(",")}\nAcme Supplies,INV-1001,250000,NGN,2026-10-20,2026-10-01,Office supplies,Access Bank,0123456789,Acme Supplies,,erp-1001\n`;
}
