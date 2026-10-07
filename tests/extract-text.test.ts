import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import path from "path";
import { extractFromText, parseFlexibleDate } from "../src/domain/extract";

const SAMPLE_TEXT = `
AC
Acme Corporation
1234 Business Ave, Suite 100
San Francisco, CA 94102
Phone: (555) 123-4567
Email: billing@acmecorp.example
INVOICE
Invoice #2024-0847
Date: October 28, 2024
Due: November 27, 2024
BILL TO
GlobalTech Solutions Inc.
PO Number: PO-456789
Subtotal 	$29,220.00
Tax (8.5%) 	$2,483.70
Total Due 	$31,703.70
Payment Information
Bank: First National Bank
Account Name: Acme Corporation
Account Number: 1234567890
Routing Number: 987654321
`;

describe("extractFromText real-world PDF layouts", () => {
  it("parses named dates", () => {
    assert.equal(parseFlexibleDate("October 28, 2024"), "2024-10-28");
    assert.equal(parseFlexibleDate("November 27, 2024"), "2024-11-27");
    assert.equal(parseFlexibleDate("2024-10-28"), "2024-10-28");
  });

  it("extracts Acme sample invoice fields", () => {
    const e = extractFromText(SAMPLE_TEXT);
    assert.ok(e);
    assert.equal(e!.vendorName, "Acme Corporation");
    assert.equal(e!.invoiceNumber, "2024-0847");
    assert.equal(e!.totalAmount, 31703.7);
    assert.equal(e!.currency, "USD");
    assert.equal(e!.issueDate, "2024-10-28");
    assert.equal(e!.dueDate, "2024-11-27");
    assert.equal(e!.poNumber, "PO-456789");
    assert.equal(e!.bankName, "First National Bank");
    assert.equal(e!.accountNumber, "1234567890");
    assert.equal(e!.subtotal, 29220);
    assert.equal(e!.taxAmount, 2483.7);
  });

  it("still supports labeled fixture format", () => {
    const e = extractFromText(`
Vendor: Northern Haulage Ltd
Invoice Number: INV-1001
Currency: NGN
Total: 150000
Due Date: 2024-12-01
Account Name: Northern Haulage Ltd
Account Number: 0123456789
Bank: Access Bank
`);
    assert.ok(e);
    assert.equal(e!.vendorName, "Northern Haulage Ltd");
    assert.equal(e!.invoiceNumber, "INV-1001");
    assert.equal(e!.totalAmount, 150000);
    assert.equal(e!.currency, "NGN");
  });

  it("extracts from the downloaded sample PDF bytes via pdf-parse", async () => {
    const pdfPath = "/home/samuel/Downloads/invoice_sample.pdf";
    let buf: Buffer;
    try {
      buf = readFileSync(pdfPath);
    } catch {
      // Optional path — skip if user file missing
      return;
    }
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: buf });
    const result = await parser.getText();
    await parser.destroy?.();
    const e = extractFromText(result.text || "");
    assert.ok(e, "should parse PDF text");
    assert.equal(e!.vendorName, "Acme Corporation");
    assert.equal(e!.invoiceNumber, "2024-0847");
    assert.equal(e!.totalAmount, 31703.7);
    assert.equal(e!.currency, "USD");
  });
});
