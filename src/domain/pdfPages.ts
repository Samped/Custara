import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";
import { PDFDocument } from "pdf-lib";

export type PageText = { num: number; text: string };

const requireFromRoot = createRequire(path.join(process.cwd(), "package.json"));

/** Decode PDF text operators from one inflated content stream. */
function textFromContentOperators(content: string): string {
  const lines: string[] = [];
  for (const m of content.matchAll(/<([0-9A-Fa-f\s]+)>\s*Tj/g)) {
    const hex = m[1].replace(/\s+/g, "");
    if (hex.length < 2 || hex.length % 2 !== 0) continue;
    try {
      const decoded = Buffer.from(hex, "hex").toString("utf8");
      if (decoded.replace(/\s/g, "").length >= 1) lines.push(decoded);
    } catch {
      /* ignore bad hex */
    }
  }
  for (const m of content.matchAll(/\((?:\\.|[^\\)])*\)\s*Tj/g)) {
    const close = m[0].lastIndexOf(")");
    const inner = m[0].slice(1, close);
    const decoded = inner.replace(/\\([nrt\\()])/g, (_, c: string) => {
      if (c === "n") return "\n";
      if (c === "r") return "\r";
      if (c === "t") return "\t";
      return c;
    });
    if (decoded.replace(/\s/g, "").length >= 1) lines.push(decoded);
  }
  return lines.join("\n").trim();
}

/**
 * Pure Node PDF text: inflate FlateDecode streams and read `<hex> Tj` / `(…) Tj`.
 * Works on Vercel without pdf.js (labeled pdf-lib invoices use hex strings).
 */
export function textFromPdfContentStreams(buf: Buffer): string {
  return loadPagesFromContentStreams(buf).text;
}

function inflatePdfStreams(buf: Buffer): string[] {
  const raw = buf.toString("latin1");
  const chunks: string[] = [];
  let idx = 0;
  while (true) {
    const start = raw.indexOf("stream", idx);
    if (start < 0) break;
    let bodyStart = start + 6;
    if (raw[bodyStart] === "\r") bodyStart += 1;
    if (raw[bodyStart] === "\n") bodyStart += 1;
    const end = raw.indexOf("endstream", bodyStart);
    if (end < 0) break;
    let body = Buffer.from(raw.slice(bodyStart, end), "latin1");
    if (body[body.length - 1] === 0x0a) body = body.subarray(0, body.length - 1);
    if (body[body.length - 1] === 0x0d) body = body.subarray(0, body.length - 1);
    let inflated: Buffer | null = null;
    try {
      inflated = zlib.inflateSync(body);
    } catch {
      try {
        inflated = zlib.inflateRawSync(body);
      } catch {
        inflated = null;
      }
    }
    chunks.push((inflated || body).toString("latin1"));
    idx = end + 9;
  }
  return chunks;
}

function looksLikeInvoiceText(text: string): boolean {
  return (
    text.replace(/\s/g, "").length >= 20 &&
    (/Vendor\s*:/i.test(text) ||
      /Invoice\s*(?:Number|No\.?|#|ID)/i.test(text) ||
      /Total\s*(?:Due|Amount)?\s*:/i.test(text) ||
      /\binvoice\b/i.test(text))
  );
}

/** Per-page text from content streams (no pdf.js). */
export function loadPagesFromContentStreams(
  buf: Buffer,
  pageCountHint = 0,
): { pages: PageText[]; total: number; text: string } {
  const streamTexts = inflatePdfStreams(buf)
    .map(textFromContentOperators)
    .filter((t) => t.replace(/\s/g, "").length >= 8);
  const invoiceStreams = streamTexts.filter(looksLikeInvoiceText);
  const usable = invoiceStreams.length >= 1 ? invoiceStreams : streamTexts;
  const total = pageCountHint || usable.length || 1;

  if (usable.length >= 2 && (usable.length === total || pageCountHint === 0)) {
    const pages = usable.map((text, i) => ({ num: i + 1, text }));
    return { pages, total: pages.length, text: pages.map((p) => p.text).join("\n\n") };
  }

  if (usable.length === 1) {
    return {
      pages: [{ num: 1, text: usable[0] }],
      total: Math.max(1, pageCountHint || 1),
      text: usable[0],
    };
  }

  if (usable.length > 1 && pageCountHint >= 2 && usable.length !== pageCountHint) {
    // Prefer invoice-looking streams aligned to page count when possible.
    if (invoiceStreams.length === pageCountHint) {
      const pages = invoiceStreams.map((text, i) => ({ num: i + 1, text }));
      return { pages, total: pageCountHint, text: pages.map((p) => p.text).join("\n\n") };
    }
  }

  const merged = usable.join("\n\n");
  if (merged) {
    return {
      pages: Array.from({ length: Math.max(1, pageCountHint || 1) }, (_, i) => ({
        num: i + 1,
        text: i === 0 ? merged : "",
      })),
      total: Math.max(1, pageCountHint || 1),
      text: merged,
    };
  }

  return emptyPages(Math.max(1, pageCountHint || 1));
}

/** Vercel defaults to Node 20; pdf.js requires Promise.withResolvers (Node 22+). */
function ensurePromiseWithResolvers() {
  if (typeof Promise.withResolvers === "function") return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Promise as any).withResolvers = function withResolvers<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

ensurePromiseWithResolvers();

function pdfjsAssetDirs(): { standardFontDataUrl?: string; cMapUrl?: string } {
  try {
    const root = path.dirname(requireFromRoot.resolve("pdfjs-dist/package.json"));
    return {
      standardFontDataUrl: pathToFileURL(path.join(root, "standard_fonts") + path.sep).href,
      cMapUrl: pathToFileURL(path.join(root, "cmaps") + path.sep).href,
    };
  } catch {
    return {};
  }
}

function pdfWorkerSrc(): string | undefined {
  try {
    return pathToFileURL(requireFromRoot.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")).href;
  } catch {
    return undefined;
  }
}

/** Absolute file URL import — more reliable on Vercel than a bare package specifier. */
async function importPdfJs() {
  ensurePromiseWithResolvers();
  const pdfPath = requireFromRoot.resolve("pdfjs-dist/legacy/build/pdf.mjs");
  return import(/* webpackIgnore: true */ pathToFileURL(pdfPath).href);
}

type PdfParseCtor = (new (opts: { data: Uint8Array }) => {
  getText: (params?: { partial?: number[] }) => Promise<{ text?: string; pages?: PageText[]; total?: number }>;
  destroy?: () => Promise<void>;
}) & { setWorker?: (src?: string) => string };

async function openPdfParse(buf: Buffer) {
  ensurePromiseWithResolvers();
  const bytes = new Uint8Array(buf.byteLength);
  bytes.set(buf);
  let mod: { PDFParse?: PdfParseCtor };
  try {
    const parsePath = requireFromRoot.resolve("pdf-parse");
    mod = await import(/* webpackIgnore: true */ pathToFileURL(parsePath).href);
  } catch {
    mod = await import(/* webpackIgnore: true */ "pdf-parse");
  }
  const PDFParse = mod.PDFParse;
  if (!PDFParse) throw new Error("pdf-parse PDFParse export missing");
  const worker = pdfWorkerSrc();
  if (worker) PDFParse.setWorker?.(worker);
  return new PDFParse({ data: bytes });
}

async function loadWithPdfParse(buf: Buffer): Promise<{ pages: PageText[]; total: number; text: string }> {
  const parser = await openPdfParse(buf);
  try {
    const result = await parser.getText();
    const pages = (result.pages || []).map((p) => ({
      num: p.num,
      text: (p.text || "").trim(),
    }));
    return {
      pages: pages.length ? pages : [{ num: 1, text: (result.text || "").trim() }],
      total: result.total || pages.length || 1,
      text: (result.text || "").trim(),
    };
  } finally {
    await parser.destroy?.();
  }
}

/** pdf.js text extraction — works on Vercel when pdf-parse's worker path breaks. */
export async function loadWithPdfJs(buf: Buffer): Promise<{ pages: PageText[]; total: number; text: string }> {
  ensurePromiseWithResolvers();
  const pdfjs = await importPdfJs();
  const worker = pdfWorkerSrc();
  if (worker && pdfjs.GlobalWorkerOptions) {
    pdfjs.GlobalWorkerOptions.workerSrc = worker;
  }

  const data = new Uint8Array(buf.byteLength);
  data.set(buf);
  const assets = pdfjsAssetDirs();
  const loadingTask = pdfjs.getDocument({
    data,
    useSystemFonts: true,
    isEvalSupported: false,
    disableWorker: true,
    ...assets,
    cMapPacked: true,
  } as Parameters<typeof pdfjs.getDocument>[0]);
  const doc = await loadingTask.promise;
  try {
    const pages: PageText[] = [];
    for (let num = 1; num <= doc.numPages; num += 1) {
      const page = await doc.getPage(num);
      const content = await page.getTextContent();
      const text = content.items
        .map((item: { str?: string }) => (typeof item.str === "string" ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      pages.push({ num, text });
    }
    return {
      pages,
      total: doc.numPages,
      text: pages.map((p) => p.text).join("\n\n"),
    };
  } finally {
    await doc.destroy?.();
    await loadingTask.destroy?.();
  }
}

function emptyPages(total: number): { pages: PageText[]; total: number; text: string } {
  const pages = Array.from({ length: Math.max(1, total) }, (_, i) => ({ num: i + 1, text: "" }));
  return { pages, total: pages.length, text: "" };
}

function nonEmptyCount(pages: PageText[]): number {
  return pages.filter((p) => p.text.replace(/\s/g, "").length >= 8).length;
}

/**
 * Load per-page text for split + extract.
 * Order: content-stream inflate (Vercel-safe) → pdf.js → pdf-parse → empty shells.
 */
export async function loadPdfPages(buf: Buffer): Promise<{ pages: PageText[]; total: number; text: string }> {
  ensurePromiseWithResolvers();
  let pageCountHint = 0;
  try {
    pageCountHint = (await PDFDocument.load(buf, { ignoreEncryption: true })).getPageCount();
  } catch {
    pageCountHint = 0;
  }

  // Pure Node first — no pdf.js worker / Promise.withResolvers dependency.
  try {
    const fromStreams = loadPagesFromContentStreams(buf, pageCountHint);
    if (nonEmptyCount(fromStreams.pages) >= 1) return fromStreams;
  } catch (err) {
    console.warn("[custara] content-stream page load failed", err instanceof Error ? err.message : err);
  }

  try {
    const viaJs = await loadWithPdfJs(buf);
    if (nonEmptyCount(viaJs.pages) >= 1 || viaJs.total >= 2) return viaJs;
  } catch (err) {
    console.warn("[custara] pdfjs page load failed", err instanceof Error ? err.message : err);
  }

  try {
    const parsed = await loadWithPdfParse(buf);
    if (nonEmptyCount(parsed.pages) >= 1) return parsed;
  } catch (err) {
    console.warn("[custara] pdf-parse page load failed", err instanceof Error ? err.message : err);
  }

  if (pageCountHint >= 1) return emptyPages(pageCountHint);
  return emptyPages(1);
}

/** Full-document text for invoice extract (same fallbacks as page load). */
export async function extractPdfText(buf: Buffer): Promise<string> {
  ensurePromiseWithResolvers();

  try {
    const fromStreams = textFromPdfContentStreams(buf).trim();
    if (fromStreams.replace(/\s/g, "").length >= 8) return fromStreams;
  } catch (err) {
    console.warn("[custara] extractPdfText content-stream failed", err instanceof Error ? err.message : err);
  }

  try {
    const viaJs = await loadWithPdfJs(buf);
    if (viaJs.text.replace(/\s/g, "").length >= 8) return viaJs.text;
  } catch (err) {
    console.warn("[custara] extractPdfText pdfjs failed", err instanceof Error ? err.message : err);
  }

  try {
    const parsed = await loadWithPdfParse(buf);
    if (parsed.text.replace(/\s/g, "").length >= 40) return parsed.text;
  } catch (err) {
    console.warn("[custara] extractPdfText pdf-parse failed", err instanceof Error ? err.message : err);
  }

  return "";
}
