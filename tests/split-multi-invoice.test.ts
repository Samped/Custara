import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  detectInvoiceSegmentsFromPages,
  splitMultiInvoicePdf,
} from "../src/domain/splitMultiInvoicePdf";

describe("detectInvoiceSegmentsFromPages", () => {
  it("returns one segment for a single invoice across pages", () => {
    const segments = detectInvoiceSegmentsFromPages([
      {
        num: 1,
        text: `Vendor: Acme Corp\nInvoice Number: INV-1001\nTotal: 100`,
      },
      {
        num: 2,
        text: `Line items continued\nAmount Due: 100`,
      },
    ]);
    assert.equal(segments.length, 1);
    assert.equal(segments[0].pageStart, 1);
    assert.equal(segments[0].pageEnd, 2);
    assert.equal(segments[0].invoiceNumber, "INV-1001");
  });

  it("splits when a new invoice number starts on a later page", () => {
    const segments = detectInvoiceSegmentsFromPages([
      {
        num: 1,
        text: `Vendor: Acme Corp\nInvoice Number: INV-1001\nTotal Due: 25 USDC`,
      },
      {
        num: 2,
        text: `Vendor: Beacon Supply Co\nInvoice Number: INV-2002\nTotal Due: 40 USDC`,
      },
    ]);
    assert.equal(segments.length, 2);
    assert.equal(segments[0].invoiceNumber, "INV-1001");
    assert.equal(segments[0].pageStart, 1);
    assert.equal(segments[0].pageEnd, 1);
    assert.equal(segments[1].invoiceNumber, "INV-2002");
    assert.equal(segments[1].pageStart, 2);
    assert.equal(segments[1].pageEnd, 2);
  });
});

describe("splitMultiInvoicePdf", () => {
  it("returns null for a one-invoice PDF", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([612, 792]);
    page.drawText("Vendor: Acme Corp", { x: 50, y: 700, size: 12, font });
    page.drawText("Invoice Number: INV-ONLY-1", { x: 50, y: 680, size: 12, font });
    page.drawText("Total Due: 12.50", { x: 50, y: 660, size: 12, font });
    const bytes = Buffer.from(await doc.save());
    const children = await splitMultiInvoicePdf(bytes, "single.pdf");
    assert.equal(children, null);
  });

  it("splits a two-page PDF with two invoice numbers into two child PDFs", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const p1 = doc.addPage([612, 792]);
    p1.drawText("Invoice", { x: 50, y: 740, size: 18, font });
    p1.drawText("Vendor: Acme Corp", { x: 50, y: 700, size: 12, font });
    p1.drawText("Invoice Number: INV-1001", { x: 50, y: 680, size: 12, font });
    p1.drawText("Total Due: 25.00", { x: 50, y: 660, size: 12, font });
    const p2 = doc.addPage([612, 792]);
    p2.drawText("Invoice", { x: 50, y: 740, size: 18, font });
    p2.drawText("Vendor: Beacon Supply Co", { x: 50, y: 700, size: 12, font });
    p2.drawText("Invoice Number: INV-2002", { x: 50, y: 680, size: 12, font });
    p2.drawText("Total Due: 40.00", { x: 50, y: 660, size: 12, font });
    const bytes = Buffer.from(await doc.save());

    const children = await splitMultiInvoicePdf(bytes, "pack.pdf");
    assert.ok(children);
    assert.equal(children!.length, 2);
    assert.equal(children![0].filename, "pack-inv-1.pdf");
    assert.equal(children![1].filename, "pack-inv-2.pdf");
    assert.ok(children![0].bytes.byteLength > 0);
    assert.ok(children![1].bytes.byteLength > 0);
    assert.notEqual(children![0].bytes.equals(children![1].bytes), true);
    assert.match(children![0].pageText || "", /INV-1001/);
    assert.match(children![1].pageText || "", /INV-2002/);
    assert.equal(children![0].invoiceNumber, "INV-1001");
    assert.equal(children![1].invoiceNumber, "INV-2002");

    const again = await PDFDocument.load(children![0].bytes);
    assert.equal(again.getPageCount(), 1);
  });

  it("splits the five-invoice sample fixture and keeps page text for extract", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const bytes = readFileSync(resolve("fixtures/custara-multi-5.pdf"));
    const children = await splitMultiInvoicePdf(bytes, "custara-multi-5.pdf");
    assert.ok(children);
    assert.equal(children!.length, 5);
    assert.match(children![0].pageText || "", /MULTI-5001/);
    assert.match(children![4].pageText || "", /MULTI-5005/);
  });

  it("still reads pages when Promise.withResolvers is missing (Vercel Node 20)", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const { loadWithPdfJs } = await import("../src/domain/pdfPages");
    const original = Promise.withResolvers;
    Object.defineProperty(Promise, "withResolvers", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    delete (Promise as { withResolvers?: unknown }).withResolvers;
    try {
      const bytes = readFileSync(resolve("fixtures/custara-multi-5.pdf"));
      const loaded = await loadWithPdfJs(bytes);
      assert.equal(loaded.total, 5);
      assert.match(loaded.text, /MULTI-5001/);
    } finally {
      Object.defineProperty(Promise, "withResolvers", {
        value: original,
        configurable: true,
        writable: true,
      });
    }
  });
});

