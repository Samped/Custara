import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PDFDocument } from "pdf-lib";

export type PageText = { num: number; text: string };

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
    const requireFromRoot = createRequire(path.join(process.cwd(), "package.json"));
    const pdfjsEntry = requireFromRoot.resolve("pdfjs-dist/package.json");
    const root = path.dirname(pdfjsEntry);
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
    const requireFromRoot = createRequire(path.join(process.cwd(), "package.json"));
    return pathToFileURL(requireFromRoot.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")).href;
  } catch {
    return undefined;
  }
}

type PdfParseCtor = (new (opts: { data: Uint8Array }) => {
  getText: (params?: { partial?: number[] }) => Promise<{ text?: string; pages?: PageText[]; total?: number }>;
  destroy?: () => Promise<void>;
}) & { setWorker?: (src?: string) => string };

async function openPdfParse(buf: Buffer) {
  ensurePromiseWithResolvers();
  const bytes = new Uint8Array(buf.byteLength);
  bytes.set(buf);
  const mod = await import(/* webpackIgnore: true */ "pdf-parse");
  const PDFParse = (mod as { PDFParse?: PdfParseCtor }).PDFParse;
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
  const pdfjs = await import(/* webpackIgnore: true */ "pdfjs-dist/legacy/build/pdf.mjs");
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
    // Prefer in-process parsing on serverless; worker files are often missing from the bundle.
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
        .map((item) => ("str" in item && typeof item.str === "string" ? item.str : ""))
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
 * Order: pdf-parse → pdf.js → empty page shells from pdf-lib (never throws).
 */
export async function loadPdfPages(buf: Buffer): Promise<{ pages: PageText[]; total: number; text: string }> {
  ensurePromiseWithResolvers();
  let pageCountHint = 0;
  try {
    pageCountHint = (await PDFDocument.load(buf, { ignoreEncryption: true })).getPageCount();
  } catch {
    pageCountHint = 0;
  }

  try {
    const parsed = await loadWithPdfParse(buf);
    if (nonEmptyCount(parsed.pages) >= 1) return parsed;
  } catch (err) {
    console.warn("[custara] pdf-parse page load failed", err instanceof Error ? err.message : err);
  }

  try {
    const viaJs = await loadWithPdfJs(buf);
    if (nonEmptyCount(viaJs.pages) >= 1 || viaJs.total >= 2) return viaJs;
  } catch (err) {
    console.warn("[custara] pdfjs page load failed", err instanceof Error ? err.message : err);
  }

  if (pageCountHint >= 1) return emptyPages(pageCountHint);
  return emptyPages(1);
}

/** Full-document text for invoice extract (same fallbacks as page load). */
export async function extractPdfText(buf: Buffer): Promise<string> {
  ensurePromiseWithResolvers();
  try {
    const parsed = await loadWithPdfParse(buf);
    if (parsed.text.replace(/\s/g, "").length >= 40) return parsed.text;
  } catch (err) {
    console.warn("[custara] extractPdfText pdf-parse failed", err instanceof Error ? err.message : err);
  }

  try {
    const viaJs = await loadWithPdfJs(buf);
    if (viaJs.text.replace(/\s/g, "").length >= 8) return viaJs.text;
  } catch (err) {
    console.warn("[custara] extractPdfText pdfjs failed", err instanceof Error ? err.message : err);
  }

  return "";
}
