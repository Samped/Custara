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

function extractFromText(text: string): Extraction | null {
  const vendor = text.match(/Vendor:\s*(.+)/i)?.[1]?.trim();
  const invoiceNumber = text.match(/Invoice\s*(?:Number|#):\s*(\S+)/i)?.[1]?.trim();
  const total = text.match(/Total:\s*([0-9,.]+)/i)?.[1]?.replace(/,/g, "");
  const currency = text.match(/Currency:\s*([A-Z]{3})/i)?.[1] || "NGN";
  const accountNumber = text.match(/Account(?: Number)?:\s*(\d+)/i)?.[1];
  const accountName = text.match(/Account Name:\s*(.+)/i)?.[1]?.trim();
  const bankName = text.match(/Bank:\s*(.+)/i)?.[1]?.trim();
  const dueDate = text.match(/Due(?: Date)?:\s*(\d{4}-\d{2}-\d{2})/i)?.[1];
  const issueDate = text.match(/Issue(?: Date)?:\s*(\d{4}-\d{2}-\d{2})/i)?.[1];
  const poNumber = text.match(/PO(?: Number)?:\s*(\S+)/i)?.[1];

  if (!vendor || !invoiceNumber || !total) return null;

  return extractionSchema.parse({
    vendorName: vendor,
    invoiceNumber,
    issueDate: issueDate || null,
    dueDate: dueDate || null,
    currency,
    totalAmount: Number(total),
    poNumber: poNumber || null,
    accountName: accountName || null,
    accountNumber: accountNumber || null,
    bankName: bankName || null,
    bankCode: null,
    lineItems: [],
    confidence: 0.8,
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
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: buf });
    const result = await parser.getText();
    return (result?.text || "").trim();
  } catch {
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
