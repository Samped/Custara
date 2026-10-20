import { PDFDocument } from "pdf-lib";
import { loadPdfPages, type PageText } from "@/domain/pdfPages";

export type InvoiceSegment = {
  pageStart: number;
  pageEnd: number;
  invoiceNumber?: string | null;
  vendorName?: string | null;
};

export type SplitChildPdf = {
  index: number;
  pageStart: number;
  pageEnd: number;
  filename: string;
  bytes: Buffer;
  /** Per-segment text captured during split (used when child PDF re-read fails on serverless). */
  pageText?: string;
  invoiceNumber?: string | null;
  vendorName?: string | null;
};

function pageInvoiceNumber(text: string): string | null {
  return (
    text.match(/Invoice\s*(?:Number|No\.?|#|ID)\s*[:#]?\s*([A-Z0-9][A-Z0-9\-\/]+)/i)?.[1]?.trim() ||
    text.match(/Bill\s*(?:Number|No\.?|#)\s*[:#]?\s*([A-Z0-9][A-Z0-9\-\/]+)/i)?.[1]?.trim() ||
    text.match(/\bINV[-\s]?([A-Z0-9][A-Z0-9\-\/]+)/i)?.[0]?.trim() ||
    null
  );
}

function pageVendorHint(text: string): string | null {
  return (
    text.match(/Vendor:\s*(.+)/i)?.[1]?.trim()?.split("\n")[0]?.slice(0, 80) ||
    text.match(/From:\s*(.+)/i)?.[1]?.trim()?.split("\n")[0]?.slice(0, 80) ||
    text.match(/Supplier:\s*(.+)/i)?.[1]?.trim()?.split("\n")[0]?.slice(0, 80) ||
    null
  );
}

function looksLikeInvoiceStart(text: string): boolean {
  const head = text.slice(0, 400);
  return (
    /\binvoice\b/i.test(head) ||
    /\bbill\s*(to|from|number|no\.?|#)/i.test(head) ||
    /Invoice\s*(?:Number|No\.?|#|ID)\s*[:#]?/i.test(text)
  );
}

/** Pure heuristic: group consecutive pages that belong to the same bill. */
export function detectInvoiceSegmentsFromPages(pages: PageText[]): InvoiceSegment[] {
  if (!pages.length) return [];

  const segments: InvoiceSegment[] = [];
  let current: InvoiceSegment | null = null;

  for (const page of pages) {
    const invoiceNumber = pageInvoiceNumber(page.text);
    const vendorName = pageVendorHint(page.text);
    const startsBill = looksLikeInvoiceStart(page.text);

    const numberChanged =
      Boolean(invoiceNumber) &&
      Boolean(current?.invoiceNumber) &&
      invoiceNumber!.toLowerCase() !== current!.invoiceNumber!.toLowerCase();

    const newBill =
      !current ||
      numberChanged ||
      (startsBill &&
        Boolean(invoiceNumber) &&
        (!current.invoiceNumber || invoiceNumber!.toLowerCase() !== current.invoiceNumber.toLowerCase()));

    if (newBill) {
      if (current) segments.push(current);
      current = {
        pageStart: page.num,
        pageEnd: page.num,
        invoiceNumber,
        vendorName,
      };
    } else if (current) {
      current.pageEnd = page.num;
      if (!current.invoiceNumber && invoiceNumber) current.invoiceNumber = invoiceNumber;
      if (!current.vendorName && vendorName) current.vendorName = vendorName;
    }
  }

  if (current) segments.push(current);

  // Collapse a single "whole document" into one segment when we never found boundaries.
  if (segments.length === 0 && pages.length) {
    return [
      {
        pageStart: pages[0].num,
        pageEnd: pages[pages.length - 1].num,
        invoiceNumber: pageInvoiceNumber(pages.map((p) => p.text).join("\n")),
        vendorName: pageVendorHint(pages.map((p) => p.text).join("\n")),
      },
    ];
  }

  return segments;
}

function countDistinctInvoiceNumbers(text: string): number {
  const found = new Set<string>();
  const patterns = [
    /Invoice\s*(?:Number|No\.?|#|ID)\s*[:#]?\s*([A-Z0-9][A-Z0-9\-\/]+)/gi,
    /\bINV[-\s]?([A-Z0-9][A-Z0-9\-\/]+)/gi,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      found.add((m[1] || m[0]).toLowerCase());
    }
  }
  return found.size;
}

async function maybeLlmSegments(pages: PageText[], text: string): Promise<InvoiceSegment[] | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  if (pages.length < 2) return null;
  if (countDistinctInvoiceNumbers(text) < 2 && pages.length < 3) return null;
  // Need some text — blind LLM calls burn the upload budget on Vercel.
  if (text.replace(/\s/g, "").length < 40) return null;

  const pageOutline = pages
    .map((p) => `--- page ${p.num} ---\n${p.text.slice(0, 1200)}`)
    .join("\n\n")
    .slice(0, 24000);

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You split a PDF that may contain several supplier invoices. Return JSON {\"segments\":[{\"pageStart\":1,\"pageEnd\":1,\"invoiceNumber\":string|null,\"vendorName\":string|null}]}. pageStart/pageEnd are 1-based inclusive. Use one segment per distinct invoice. If there is only one invoice, return a single segment covering all pages.",
          },
          { role: "user", content: pageOutline },
        ],
      }),
      // Keep short so the outer upload timeout still has room to build child PDFs.
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = body.choices?.[0]?.message?.content || "";
    const parsed = JSON.parse(raw) as { segments?: InvoiceSegment[] };
    const segments = (parsed.segments || [])
      .map((s) => ({
        pageStart: Number(s.pageStart),
        pageEnd: Number(s.pageEnd),
        invoiceNumber: s.invoiceNumber || null,
        vendorName: s.vendorName || null,
      }))
      .filter(
        (s) =>
          Number.isFinite(s.pageStart) &&
          Number.isFinite(s.pageEnd) &&
          s.pageStart >= 1 &&
          s.pageEnd >= s.pageStart,
      );
    return segments.length ? segments : null;
  } catch (err) {
    console.warn("[custara] multi-invoice LLM split failed", err instanceof Error ? err.message : err);
    return null;
  }
}

async function buildChildPdf(source: Buffer, pageStart: number, pageEnd: number): Promise<Buffer> {
  const src = await PDFDocument.load(source, { ignoreEncryption: true });
  const child = await PDFDocument.create();
  const indices: number[] = [];
  for (let p = pageStart; p <= pageEnd; p += 1) {
    const idx = p - 1;
    if (idx >= 0 && idx < src.getPageCount()) indices.push(idx);
  }
  if (!indices.length) throw new Error(`No pages in range ${pageStart}-${pageEnd}`);
  const copied = await child.copyPages(src, indices);
  for (const page of copied) child.addPage(page);
  return Buffer.from(await child.save());
}

function baseName(filename: string): string {
  return filename.replace(/\.pdf$/i, "") || "invoice";
}

function segmentText(pages: PageText[], pageStart: number, pageEnd: number): string {
  return pages
    .filter((p) => p.num >= pageStart && p.num <= pageEnd)
    .map((p) => p.text)
    .join("\n\n")
    .trim();
}

/**
 * If the PDF clearly contains 2+ invoices, return one child PDF per invoice.
 * Otherwise return null so the caller keeps the single-invoice path.
 */
export async function splitMultiInvoicePdf(
  buf: Buffer,
  filename: string,
): Promise<SplitChildPdf[] | null> {
  let pages: PageText[];
  let text: string;
  try {
    const loaded = await loadPdfPages(buf);
    pages = loaded.pages;
    text = loaded.text;
  } catch (err) {
    console.warn("[custara] splitMultiInvoicePdf load failed", err instanceof Error ? err.message : err);
    return null;
  }

  let segments = detectInvoiceSegmentsFromPages(pages);

  if (segments.length < 2) {
    const llm = await maybeLlmSegments(pages, text);
    if (llm && llm.length >= 2) segments = llm;
  }

  // Multi-page packs: one invoice per page when each page looks like a bill, or
  // when we see 2+ distinct invoice numbers even if page shells were incomplete.
  if (segments.length < 2 && pages.length >= 2) {
    const marked = pages.filter((p) => looksLikeInvoiceStart(p.text) || pageInvoiceNumber(p.text));
    const distinct = countDistinctInvoiceNumbers(text);
    const noReadableText = text.replace(/\s/g, "").length < 40;
    // On serverless, if text extraction still fails, fan out pages so each child can
    // be vision-extracted instead of one blank UNK for the whole pack.
    if (marked.length >= 2 || distinct >= 2 || (noReadableText && pages.length <= 20)) {
      console.warn("[custara] multi-invoice split using one-page segments", {
        pages: pages.length,
        marked: marked.length,
        distinct,
        noReadableText,
      });
      segments = pages.map((p) => ({
        pageStart: p.num,
        pageEnd: p.num,
        invoiceNumber: pageInvoiceNumber(p.text),
        vendorName: pageVendorHint(p.text),
      }));
    }
  }

  if (segments.length < 2) {
    console.warn("[custara] multi-invoice split found no boundaries", {
      pages: pages.length,
      textChars: text.length,
    });
    return null;
  }

  // Clamp to actual page count
  const maxPage = pages[pages.length - 1]?.num || pages.length;
  segments = segments.map((s) => ({
    ...s,
    pageStart: Math.max(1, Math.min(s.pageStart, maxPage)),
    pageEnd: Math.max(1, Math.min(s.pageEnd, maxPage)),
  }));

  const stem = baseName(filename);
  const children: SplitChildPdf[] = [];
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    const bytes = await buildChildPdf(buf, seg.pageStart, seg.pageEnd);
    const pageText = segmentText(pages, seg.pageStart, seg.pageEnd);
    children.push({
      index: i + 1,
      pageStart: seg.pageStart,
      pageEnd: seg.pageEnd,
      filename: `${stem}-inv-${i + 1}.pdf`,
      bytes,
      pageText: pageText || undefined,
      invoiceNumber: seg.invoiceNumber || pageInvoiceNumber(pageText),
      vendorName: seg.vendorName || pageVendorHint(pageText),
    });
  }
  return children;
}
