import { readFile } from "fs/promises";
import path from "path";
import { prisma } from "@/lib/db";
import { extractionSchema, type Extraction } from "@/lib/types";
import { encryptField, last4 } from "@/lib/crypto";

const STORAGE_ROOT = path.join(process.cwd(), "storage");

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
  if (labeled && !/^unknown/i.test(labeled)) return labeled.split("\n")[0].trim();

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
          {
            role: "system",
            content:
              "Extract invoice fields as JSON with keys: vendorName, invoiceNumber, issueDate, dueDate, currency, subtotal, taxAmount, totalAmount, poNumber, accountName, accountNumber, bankName, bankCode, arcAddress, lineItems[{description,quantity,unitPrice,amount}], confidence (0-1).",
          },
          { role: "user", content: text.slice(0, 12000) },
        ],
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;
    return extractionSchema.parse(JSON.parse(content));
  } catch {
    return null;
  }
}

async function maybeLlmVisionExtract(buf: Buffer, mimeType: string): Promise<Extraction | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  try {
    const b64 = buf.toString("base64");
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
          {
            role: "system",
            content:
              "Extract invoice fields from this document image as JSON with keys: vendorName, invoiceNumber, issueDate, dueDate, currency, subtotal, taxAmount, totalAmount, poNumber, accountName, accountNumber, bankName, bankCode, arcAddress, lineItems[{description,quantity,unitPrice,amount}], confidence (0-1).",
          },
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: `data:${mimeType};base64,${b64}` },
              },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;
    return extractionSchema.parse(JSON.parse(content));
  } catch {
    return null;
  }
}

async function extractPdfText(buf: Buffer): Promise<string> {
  try {
    // Force Node build — Turbopack can resolve the browser export otherwise.
    const mod = await import(/* webpackIgnore: true */ "pdf-parse");
    const PDFParse = (mod as { PDFParse?: new (opts: { data: Buffer }) => { getText: () => Promise<{ text?: string }>; destroy?: () => Promise<void> } }).PDFParse;
    if (!PDFParse) throw new Error("pdf-parse PDFParse export missing");
    const parser = new PDFParse({ data: Buffer.from(buf) });
    const result = await parser.getText();
    const text = (result?.text || "").trim();
    await parser.destroy?.();
    return text;
  } catch (err) {
    console.warn("[custara] extractPdfText failed", err instanceof Error ? err.message : err);
    return "";
  }
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
    const abs = path.join(STORAGE_ROOT, doc.storagePath);
    const buf = await readFile(abs);
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

    if (text) {
      const fromText = extractFromText(text);
      if (fromText) {
        extraction = fromText;
        break;
      }
      const fromLlm = await maybeLlmExtract(text);
      if (fromLlm) {
        extraction = fromLlm;
        break;
      }
    }

    if (binary) {
      const mime = doc.mimeType.startsWith("image/")
        ? doc.mimeType
        : doc.mimeType.includes("pdf")
          ? "application/pdf"
          : "image/png";
      // Vision works best on images; for PDF without text, try LLM on pdf text already attempted
      if (mime.startsWith("image/")) {
        const fromVision = await maybeLlmVisionExtract(buf, mime);
        if (fromVision) {
          extraction = fromVision;
          break;
        }
      } else if (!text) {
        // Scanned PDF with no extractable text — ask LLM with a note (text path already failed)
        const fromLlm = await maybeLlmExtract(
          `[PDF binary invoice filename=${doc.filename} size=${buf.length}. No extractable text. Return best-effort empty fields with low confidence if unknown.]`,
        );
        if (fromLlm && fromLlm.totalAmount > 0) {
          extraction = fromLlm;
          break;
        }
      }
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
