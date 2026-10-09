import { getObject } from "@/lib/storage";
import { prisma } from "@/lib/db";
import { extractionSchema, type Extraction } from "@/lib/types";
import { encryptField, last4 } from "@/lib/crypto";

function parseLooseJson(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseMoneyToken(raw: string): number | null {
  const cleaned = raw.replace(/[^\d.,-]/g, "").replace(/,/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

const MONTHS: Record<string, string> = {
  jan: "01",
  january: "01",
  feb: "02",
  february: "02",
  mar: "03",
  march: "03",
  apr: "04",
  april: "04",
  may: "05",
  jun: "06",
  june: "06",
  jul: "07",
  july: "07",
  aug: "08",
  august: "08",
  sep: "09",
  sept: "09",
  september: "09",
  oct: "10",
  october: "10",
  nov: "11",
  november: "11",
  dec: "12",
  december: "12",
};

/** Normalize common invoice date strings to YYYY-MM-DD. */
export function parseFlexibleDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];

  const named = s.match(/^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/);
  if (named) {
    const month = MONTHS[named[1].toLowerCase()];
    if (month) return `${named[3]}-${month}-${named[2].padStart(2, "0")}`;
  }

  const namedAlt = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+),?\s+(\d{4})$/);
  if (namedAlt) {
    const month = MONTHS[namedAlt[2].toLowerCase()];
    if (month) return `${namedAlt[3]}-${month}-${namedAlt[1].padStart(2, "0")}`;
  }

  // US-style MM/DD/YYYY when first segment ≤ 12
  const slash = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (slash) {
    const a = Number(slash[1]);
    const b = Number(slash[2]);
    if (a > 12 && b <= 12) {
      // DD/MM/YYYY
      return `${slash[3]}-${slash[2].padStart(2, "0")}-${slash[1].padStart(2, "0")}`;
    }
    return `${slash[3]}-${slash[1].padStart(2, "0")}-${slash[2].padStart(2, "0")}`;
  }

  const t = Date.parse(s);
  if (!Number.isNaN(t)) {
    return new Date(t).toISOString().slice(0, 10);
  }
  return null;
}

function detectCurrency(text: string, explicit?: string | null): string {
  if (explicit) return explicit.toUpperCase();
  const labeled = text.match(/Currency:\s*([A-Z]{3,4})/i)?.[1];
  if (labeled) return labeled.toUpperCase();
  if (/₦|NGN\b/i.test(text)) return "NGN";
  if (/€|EUR\b/.test(text)) return "EUR";
  if (/£|GBP\b/.test(text)) return "GBP";
  if (/\$|USD\b|USDC\b/.test(text)) return "USD";
  return "USD";
}

function guessVendorName(text: string): string | null {
  const labeled =
    text.match(/Vendor:\s*(.+)/i)?.[1]?.trim() ||
    text.match(/From:\s*(.+)/i)?.[1]?.trim() ||
    text.match(/Supplier:\s*(.+)/i)?.[1]?.trim() ||
    text.match(/Account Name:\s*(.+)/i)?.[1]?.trim();
  if (labeled && !/^unknown/i.test(labeled)) {
    return labeled.split("\n")[0].replace(/\)\s*Tj\b.*$/i, "").trim();
  }

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const skip =
    /^(invoice|tax\s*invoice|bill\s*to|ship\s*to|description|qty|quantity|amount|payment|project|date|due|total|subtotal|page|notes?)\b/i;
  const addressLike = /^(\d+|phone:|email:|tel:|fax:|www\.|http|p\.?o\.?\s*box)/i;
  const companyHint =
    /\b(corp|corporation|inc|llc|ltd|limited|gmbh|plc|co\.|company|services|solutions|labs?)\b/i;

  // Prefer a company-like line before BILL TO / invoice body
  const billIdx = lines.findIndex((l) => /^bill\s*to\b/i.test(l));
  const scan = billIdx > 0 ? lines.slice(0, billIdx) : lines.slice(0, 12);

  for (const line of scan) {
    if (line.length < 3 || line.length > 80) continue;
    if (skip.test(line) || addressLike.test(line)) continue;
    if (/^invoice\s*#/i.test(line)) continue;
    if (companyHint.test(line) || /^[A-Z][A-Za-z0-9&'’.\- ]{2,}$/.test(line)) {
      if (!/^\d+$/.test(line) && line.toUpperCase() !== "INVOICE" && line.length > 2) {
        // Skip ultra-short logo initials like "AC"
        if (line.length <= 3 && line === line.toUpperCase()) continue;
        return line;
      }
    }
  }
  return null;
}

function extractInvoiceNumber(text: string): string | null {
  return (
    text.match(/Invoice\s*(?:Number|No\.?|#)\s*[:#]?\s*([A-Z0-9][A-Z0-9\-\/]+)/i)?.[1]?.trim() ||
    text.match(/\bINV[-\s]?([A-Z0-9\-\/]+)/i)?.[0]?.trim() ||
    null
  );
}

function extractTotalAmount(text: string): number | null {
  const patterns = [
    /Total\s*Due\s*[:\-]?\s*([€£₦$]?\s*[\d,]+\.?\d*)/i,
    /Amount\s*Due\s*[:\-]?\s*([€£₦$]?\s*[\d,]+\.?\d*)/i,
    /Grand\s*Total\s*[:\-]?\s*([€£₦$]?\s*[\d,]+\.?\d*)/i,
    /Balance\s*Due\s*[:\-]?\s*([€£₦$]?\s*[\d,]+\.?\d*)/i,
    /Total\s*(?:Amount)?\s*[:\-]?\s*([€£₦$]?\s*[\d,]+\.?\d*)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const n = parseMoneyToken(m[1]);
      if (n != null && n > 0) return n;
    }
  }
  return null;
}

function extractLabeledMoney(text: string, label: RegExp): number | null {
  const m = text.match(label);
  if (!m) return null;
  return parseMoneyToken(m[1]);
}

function deterministicExtract(payload: Record<string, unknown>): Extraction {
  const lineItems = Array.isArray(payload.line_items)
    ? (payload.line_items as Extraction["lineItems"])
    : Array.isArray(payload.lineItems)
      ? (payload.lineItems as Extraction["lineItems"])
      : [];

  return extractionSchema.parse({
    vendorName: String(payload.vendor_name || payload.vendorName || payload.vendor || "Unknown Vendor"),
    invoiceNumber: String(
      payload.invoice_number || payload.invoiceNumber || payload.number || `INV-${Date.now()}`,
    ),
    issueDate: (payload.issue_date || payload.issueDate || null) as string | null,
    dueDate: (payload.due_date || payload.dueDate || null) as string | null,
    currency: String(payload.currency || "NGN"),
    subtotal: Number(payload.subtotal ?? payload.sub_total ?? 0) || null,
    taxAmount: Number(payload.tax_amount ?? payload.taxAmount ?? 0) || null,
    totalAmount: Number(payload.total_amount ?? payload.totalAmount ?? payload.amount ?? 0),
    poNumber: (payload.po_number || payload.poNumber || null) as string | null,
    accountName: (payload.account_name || payload.accountName || null) as string | null,
    accountNumber: (payload.account_number || payload.accountNumber || null) as string | null,
    bankName: (payload.bank_name || payload.bankName || null) as string | null,
    bankCode: (payload.bank_code || payload.bankCode || null) as string | null,
    arcAddress: (payload.arc_address || payload.arcAddress || null) as string | null,
    lineItems,
    confidence: Number(payload.confidence ?? 0.92),
  });
}

/**
 * Heuristic text extractor for labeled fixtures and real-world PDF layouts.
 * Exported for unit tests.
 */
export function extractFromText(text: string): Extraction | null {
  const vendorName = guessVendorName(text);
  const invoiceNumber = extractInvoiceNumber(text);
  const totalAmount = extractTotalAmount(text);

  if (!vendorName || !invoiceNumber || totalAmount == null) return null;

  const currency = detectCurrency(
    text,
    text.match(/Currency:\s*([A-Z]{3,4})/i)?.[1] || null,
  );

  const issueRaw =
    text.match(/(?:^|\n)\s*(?:Issue(?:\s*Date)?|Invoice\s*Date)\s*:\s*([^\n]+)/im)?.[1]?.trim() ||
    text.match(/(?:^|\n)\s*Date\s*:\s*([^\n]+)/im)?.[1]?.trim() ||
    text.match(/Issue(?: Date)?:\s*(\d{4}-\d{2}-\d{2})/i)?.[1];
  const dueRaw =
    text.match(/(?:^|\n)\s*Due(?:\s*Date)?\s*:\s*([^\n]+)/im)?.[1]?.trim() ||
    text.match(/Due(?: Date)?:\s*(\d{4}-\d{2}-\d{2})/i)?.[1];

  const cleanDateField = (v?: string | null) =>
    v ? v.replace(/\s{2,}.*/, "").trim() : null;

  const accountNumber =
    text.match(/Account(?:\s*Number)?\s*:\s*([0-9]{6,})/i)?.[1] ||
    text.match(/Account(?: Number)?:\s*(\d+)/i)?.[1];
  const accountName = text.match(/Account Name:\s*(.+)/i)?.[1]?.trim()?.split("\n")[0];
  const bankName = text.match(/Bank:\s*(.+)/i)?.[1]?.trim()?.split("\n")[0];
  const bankCode =
    text.match(/(?:Bank Code|Routing(?:\s*Number)?|Sort Code)\s*:\s*([A-Z0-9\-]+)/i)?.[1] || null;
  const poNumber =
    text.match(/PO(?:\s*Number)?\s*:\s*(\S+)/i)?.[1] ||
    text.match(/Purchase Order\s*:\s*(\S+)/i)?.[1] ||
    null;
  const arcAddress = text.match(/Arc Address:\s*(0x[a-fA-F0-9]{40})/i)?.[1]?.toLowerCase();

  const subtotal = extractLabeledMoney(text, /Subtotal\s*[:\-]?\s*([€£₦$]?\s*[\d,]+\.?\d*)/i);
  const taxAmount = extractLabeledMoney(
    text,
    /Tax(?:\s*\([^)]*\))?\s*[:\-]?\s*([€£₦$]?\s*[\d,]+\.?\d*)/i,
  );

  // Labeled fixture format used higher confidence; layout PDFs slightly lower
  const labeled = /Vendor:\s*.+/i.test(text) && /Total:\s*[0-9,.]+/i.test(text);

  return extractionSchema.parse({
    vendorName,
    invoiceNumber,
    issueDate: parseFlexibleDate(cleanDateField(issueRaw)),
    dueDate: parseFlexibleDate(cleanDateField(dueRaw)),
    currency,
    subtotal,
    taxAmount,
    totalAmount,
    poNumber: poNumber || null,
    accountName: accountName || null,
    accountNumber: accountNumber || null,
    bankName: bankName || null,
    bankCode,
    arcAddress: arcAddress || null,
    lineItems: [],
    confidence: labeled ? 0.8 : 0.72,
  });
}

const EXTRACT_SYSTEM =
  "Extract invoice fields as JSON. Use numbers for money, ISO dates when known, and null when a field is not on the document. Keys: vendorName, invoiceNumber, issueDate, dueDate, currency, subtotal, taxAmount, totalAmount, poNumber, accountName, accountNumber, bankName, bankCode, arcAddress, lineItems[{description,quantity,unitPrice,amount}], confidence (0-1).";

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value.replace(/[^0-9.-]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function firstString(data: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

export function parseModelExtraction(raw: string): Extraction | null {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (data.invoice && typeof data.invoice === "object") data = data.invoice as Record<string, unknown>;
  const items = Array.isArray(data.lineItems) ? data.lineItems : Array.isArray(data.line_items) ? data.line_items : [];
  const confidence = asNumber(data.confidence);
  const vendorName = firstString(data, ["vendorName", "vendor_name", "vendor", "supplier", "supplier_name", "supplierName"]);
  const invoiceNumber = firstString(data, ["invoiceNumber", "invoice_number", "invoice_no", "number", "invoice"]);
  try {
    return extractionSchema.parse({
      vendorName: vendorName || "Unknown Vendor",
      invoiceNumber: invoiceNumber || "UNKNOWN",
      issueDate: firstString(data, ["issueDate", "issue_date", "invoice_date", "date"]) || null,
      dueDate: firstString(data, ["dueDate", "due_date", "due"]) || null,
      currency: firstString(data, ["currency"]) || "USD",
      subtotal: asNumber(data.subtotal ?? data.sub_total),
      taxAmount: asNumber(data.taxAmount ?? data.tax_amount ?? data.tax),
      totalAmount: asNumber(data.totalAmount ?? data.total_amount ?? data.total ?? data.grand_total ?? data.amount) ?? 0,
      poNumber: firstString(data, ["poNumber", "po_number", "purchase_order"]) || null,
      accountName: firstString(data, ["accountName", "account_name"]) || null,
      accountNumber: firstString(data, ["accountNumber", "account_number"]) || null,
      bankName: firstString(data, ["bankName", "bank_name", "bank"]) || null,
      bankCode: firstString(data, ["bankCode", "bank_code"]) || null,
      arcAddress: firstString(data, ["arcAddress", "arc_address"]) || null,
      lineItems: items.map((item) => {
        const row = item as Record<string, unknown>;
        return {
          description: String(row.description || "Line"),
          quantity: asNumber(row.quantity) ?? undefined,
          unitPrice: asNumber(row.unitPrice ?? row.unit_price) ?? undefined,
          amount: asNumber(row.amount) ?? 0,
        };
      }),
      confidence: confidence == null ? 0.85 : Math.min(1, Math.max(0, confidence)),
    });
  } catch (err) {
    console.warn("[custara] model extraction parse failed", err instanceof Error ? err.message : err);
    return null;
  }
}

async function readModelResponse(res: Response): Promise<Extraction | null> {
  if (!res.ok) {
    console.warn("[custara] openai extraction", res.status, (await res.text()).slice(0, 300));
    return null;
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content) return null;
  return parseModelExtraction(content);
}

async function maybeLlmExtract(text: string): Promise<Extraction | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key || !text.trim()) return null;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: EXTRACT_SYSTEM },
          { role: "user", content: text.slice(0, 24000) },
        ],
      }),
      signal: AbortSignal.timeout(25000),
    });
    return await readModelResponse(res);
  } catch (err) {
    console.warn("[custara] openai text extraction", err instanceof Error ? err.message : err);
    return null;
  }
}

async function maybeLlmVisionExtract(buf: Buffer, mimeType: string, filename: string): Promise<Extraction | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key || buf.length === 0 || buf.length > 12_000_000) return null;
  const b64 = buf.toString("base64");
  const filePart =
    mimeType === "application/pdf"
      ? {
          type: "file",
          file: { filename: filename || "invoice.pdf", file_data: `data:application/pdf;base64,${b64}` },
        }
      : { type: "image_url", image_url: { url: `data:${mimeType};base64,${b64}` } };
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: EXTRACT_SYSTEM },
          { role: "user", content: [filePart] },
        ],
      }),
      signal: AbortSignal.timeout(45000),
    });
    return await readModelResponse(res);
  } catch (err) {
    console.warn("[custara] openai vision extraction", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Read text operators out of a PDF when the parser is missing or returns nothing.
 * Generated invoices store lines as `(Vendor: …) Tj`.
 */
export function textFromPdfLiterals(buf: Buffer): string {
  const raw = buf.toString("latin1");
  const lines: string[] = [];
  let i = 0;
  while (i < raw.length) {
    if (raw[i] !== "(") {
      i += 1;
      continue;
    }
    i += 1;
    let out = "";
    let depth = 1;
    while (i < raw.length && depth > 0) {
      const ch = raw[i];
      if (ch === "\\") {
        const next = raw[i + 1];
        if (next === "n") out += "\n";
        else if (next === "r") out += "\r";
        else if (next === "t") out += "\t";
        else if (next != null) out += next;
        i += 2;
        continue;
      }
      if (ch === "(") {
        depth += 1;
        out += ch;
        i += 1;
        continue;
      }
      if (ch === ")") {
        depth -= 1;
        if (depth === 0) break;
        out += ch;
        i += 1;
        continue;
      }
      out += ch;
      i += 1;
    }
    i += 1;
    const text = out.replace(/[ \t]+/g, " ").trim();
    if (text.length >= 2 && /[A-Za-z0-9]/.test(text)) lines.push(text);
  }
  return lines.join("\n");
}

async function extractPdfText(buf: Buffer): Promise<string> {
  let parsed = "";
  try {
    // Force Node build — Turbopack can resolve the browser export otherwise.
    const mod = await import(/* webpackIgnore: true */ "pdf-parse");
    const PDFParse = (mod as { PDFParse?: new (opts: { data: Buffer }) => { getText: () => Promise<{ text?: string }>; destroy?: () => Promise<void> } }).PDFParse;
    if (!PDFParse) throw new Error("pdf-parse PDFParse export missing");
    const parser = new PDFParse({ data: Buffer.from(buf) });
    const result = await parser.getText();
    parsed = (result?.text || "").trim();
    await parser.destroy?.();
  } catch (err) {
    console.warn("[custara] extractPdfText failed", err instanceof Error ? err.message : err);
  }
  if (parsed.replace(/\s/g, "").length >= 40) return parsed;
  const literals = textFromPdfLiterals(buf);
  return literals.length > parsed.length ? literals : parsed || literals;
}

function isBinaryDoc(mimeType: string, filename: string) {
  const lower = filename.toLowerCase();
  return (
    mimeType.includes("pdf") ||
    lower.endsWith(".pdf") ||
    mimeType.startsWith("image/") ||
    /\.(png|jpe?g|webp|gif)$/i.test(lower)
  );
}

export async function extractInvoice(invoiceId: string): Promise<Extraction> {
  await prisma.invoice.update({
    where: { id: invoiceId },
    data: { status: "extracting" },
  });

  const docs = await prisma.invoiceDocument.findMany({
    where: { invoiceId, deletedAt: null },
    orderBy: { createdAt: "asc" },
  });

  let extraction: Extraction | null = null;

  for (const doc of docs) {
    const buf = doc.content?.byteLength ? Buffer.from(doc.content) : await getObject(doc.storagePath);
    const binary = isBinaryDoc(doc.mimeType, doc.filename);

    if (doc.mimeType.includes("json") || doc.filename.endsWith(".json")) {
      const parsed = parseLooseJson(buf.toString("utf8"));
      if (parsed) {
        extraction = deterministicExtract(parsed);
        break;
      }
    }

    let text = "";
    if (doc.mimeType.includes("pdf") || doc.filename.toLowerCase().endsWith(".pdf")) {
      text = await extractPdfText(buf);
    } else if (!binary) {
      text = buf.toString("utf8");
    }

    const fromText = text ? extractFromText(text) : null;
    // Labeled invoices already have vendor, number, and total in the file.
    // Use that read before a model call so a slow or missing key cannot wipe it.
    if (fromText && fromText.confidence >= 0.8 && fromText.totalAmount > 0) {
      extraction = fromText;
      break;
    }

    if (process.env.OPENAI_API_KEY && binary) {
      const mime = doc.mimeType.startsWith("image/")
        ? doc.mimeType
        : doc.mimeType.includes("pdf") || doc.filename.toLowerCase().endsWith(".pdf")
          ? "application/pdf"
          : "image/png";
      const fromVision = await maybeLlmVisionExtract(buf, mime, doc.filename);
      if (fromVision && (fromVision.totalAmount > 0 || fromVision.vendorName !== "Unknown Vendor")) {
        extraction = fromVision;
        break;
      }
    }

    if (process.env.OPENAI_API_KEY && text) {
      const fromLlm = await maybeLlmExtract(text);
      if (fromLlm && (fromLlm.totalAmount > 0 || fromLlm.vendorName !== "Unknown Vendor")) {
        extraction = fromLlm;
        break;
      }
    }

    if (fromText) {
      extraction = fromText;
      break;
    }
  }

  if (!extraction) {
    extraction = extractionSchema.parse({
      vendorName: "Unknown Vendor",
      invoiceNumber: `UNK-${invoiceId.slice(-6)}`,
      currency: "NGN",
      totalAmount: 0,
      lineItems: [],
      confidence: 0.2,
    });
  }

  const accountEncrypted = extraction.accountNumber ? encryptField(extraction.accountNumber) : null;
  const accountLast4 = extraction.accountNumber ? last4(extraction.accountNumber) : null;

  await prisma.extractionResult.upsert({
    where: { invoiceId },
    create: {
      invoiceId,
      confidence: extraction.confidence,
      vendorName: extraction.vendorName,
      invoiceNumber: extraction.invoiceNumber,
      issueDate: extraction.issueDate || null,
      dueDate: extraction.dueDate || null,
      currency: extraction.currency,
      subtotal: extraction.subtotal ?? null,
      taxAmount: extraction.taxAmount ?? null,
      totalAmount: extraction.totalAmount,
      poNumber: extraction.poNumber || null,
      accountName: extraction.accountName || null,
      accountNumberEncrypted: accountEncrypted,
      accountNumberLast4: accountLast4,
      bankName: extraction.bankName || null,
      bankCode: extraction.bankCode || null,
      lineItemsJson: JSON.stringify(extraction.lineItems),
      rawJson: JSON.stringify({
        ...extraction,
        accountNumber: accountLast4 ? `••••${accountLast4}` : null,
      }),
    },
    update: {
      confidence: extraction.confidence,
      vendorName: extraction.vendorName,
      invoiceNumber: extraction.invoiceNumber,
      issueDate: extraction.issueDate || null,
      dueDate: extraction.dueDate || null,
      currency: extraction.currency,
      subtotal: extraction.subtotal ?? null,
      taxAmount: extraction.taxAmount ?? null,
      totalAmount: extraction.totalAmount,
      poNumber: extraction.poNumber || null,
      accountName: extraction.accountName || null,
      accountNumberEncrypted: accountEncrypted,
      accountNumberLast4: accountLast4,
      bankName: extraction.bankName || null,
      bankCode: extraction.bankCode || null,
      lineItemsJson: JSON.stringify(extraction.lineItems),
      rawJson: JSON.stringify({
        ...extraction,
        accountNumber: accountLast4 ? `••••${accountLast4}` : null,
      }),
    },
  });

  await prisma.invoice.update({
    where: { id: invoiceId },
    data: {
      invoiceNumber: extraction.invoiceNumber,
      currency: extraction.currency,
      subtotal: extraction.subtotal ?? null,
      taxAmount: extraction.taxAmount ?? null,
      totalAmount: extraction.totalAmount,
      poNumber: extraction.poNumber || null,
      issueDate: extraction.issueDate ? new Date(extraction.issueDate) : null,
      dueDate: extraction.dueDate ? new Date(extraction.dueDate) : null,
    },
  });

  return extraction;
}
