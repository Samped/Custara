/**
 * Generate text-based invoice PDF/JSON/CSV fixtures for QA + E2E.
 * PDFs are minimal PDF 1.4 text streams (no pdfkit) so offline installs still work.
 * Run: npm run fixtures:generate
 */
import { mkdir, writeFile } from "fs/promises";
import path from "path";

const ROOT = path.join(process.cwd(), "fixtures");

/** Minimal one-page PDF with Helvetica text lines (pdf-parse readable). */
function buildSimplePdf(lines: string[]): Buffer {
  const escape = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const contentLines = ["BT", "/F1 11 Tf", "50 750 Td", "14 TL"];
  lines.forEach((line, i) => {
    if (i === 0) contentLines.push(`(${escape(line)}) Tj`);
    else contentLines.push(`T* (${escape(line)}) Tj`);
  });
  contentLines.push("ET");
  const stream = contentLines.join("\n");
  const objects = [
    "1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n",
    "2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n",
    "3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources<< /Font<< /F1 5 0 R >> >> >>endobj\n",
    `4 0 obj<< /Length ${Buffer.byteLength(stream, "utf8")} >>stream\n${stream}\nendstream\nendobj\n`,
    "5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj\n",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body, "utf8"));
    body += obj;
  }
  const xrefPos = Buffer.byteLength(body, "utf8");
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  body += xref;
  body += `trailer<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(body, "utf8");
}

async function writePdf(rel: string, lines: string[]) {
  const abs = path.join(ROOT, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, buildSimplePdf(lines));
  console.log("wrote", rel);
}

async function writeText(rel: string, body: string) {
  const abs = path.join(ROOT, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, body, "utf8");
  console.log("wrote", rel);
}

async function main() {
  await writePdf("invoices/happy-ngn.pdf", [
    "Vendor: Northern Haulage Ltd",
    "Invoice Number: FIX-HAPPY-001",
    "Issue Date: 2026-09-01",
    "Due Date: 2026-09-30",
    "Currency: NGN",
    "Total: 42000",
    "Account Name: Northern Haulage Ltd",
    "Account Number: 0123456789",
    "Bank: Access Bank",
    "PO Number: PO-100",
  ]);

  await writePdf("invoices/dual-control.pdf", [
    "Vendor: Northern Haulage Ltd",
    "Invoice Number: FIX-DUAL-002",
    "Issue Date: 2026-09-01",
    "Due Date: 2026-10-15",
    "Currency: NGN",
    "Total: 780000",
    "Account Name: Northern Haulage Ltd",
    "Account Number: 0123456789",
    "Bank: Access Bank",
  ]);

  await writePdf("invoices/new-vendor.pdf", [
    "Vendor: Unknown Widget Co",
    "Invoice Number: FIX-NEW-003",
    "Issue Date: 2026-09-05",
    "Due Date: 2026-10-05",
    "Currency: NGN",
    "Total: 15000",
    "Account Name: Unknown Widget Co",
    "Account Number: 9988776655",
    "Bank: GTBank",
  ]);

  await writePdf("invoices/arc-usdc.pdf", [
    "Vendor: Arc Softgoods Inc",
    "Invoice Number: FIX-ARC-004",
    "Issue Date: 2026-09-01",
    "Due Date: 2026-09-20",
    "Currency: USDC",
    "Total: 125.50",
    "Arc Address: 0x1111111111111111111111111111111111111111",
  ]);

  await writePdf("invoices/duplicate-pair/dup-a.pdf", [
    "Vendor: Northern Haulage Ltd",
    "Invoice Number: FIX-DUP-100",
    "Issue Date: 2026-09-01",
    "Due Date: 2026-09-30",
    "Currency: NGN",
    "Total: 33000",
    "Account Name: Northern Haulage Ltd",
    "Account Number: 0123456789",
    "Bank: Access Bank",
  ]);

  await writePdf("invoices/duplicate-pair/dup-b.pdf", [
    "Vendor: Northern Haulage Ltd",
    "Invoice Number: FIX-DUP-100",
    "Issue Date: 2026-09-02",
    "Due Date: 2026-09-30",
    "Currency: NGN",
    "Total: 33000",
    "Account Name: Northern Haulage Ltd",
    "Account Number: 0123456789",
    "Bank: Access Bank",
  ]);

  await writeText(
    "invoices/low-confidence.json",
    JSON.stringify(
      {
        vendor_name: "Northern Haulage Ltd",
        invoice_number: "FIX-LOWCONF-005",
        total_amount: 9000,
        currency: "NGN",
        due_date: "2026-10-01",
        confidence: 0.4,
        account_name: "Northern Haulage Ltd",
        account_number: "0123456789",
        bank_name: "Access Bank",
      },
      null,
      2,
    ),
  );

  await writeText(
    "csv/bulk-ap.csv",
    [
      "vendor_name,invoice_number,total_amount,currency,due_date,account_name,account_number,bank_name,external_id",
      "Northern Haulage Ltd,FIX-CSV-001,12000,NGN,2026-10-01,Northern Haulage Ltd,0123456789,Access Bank,fix_csv_001",
      "Unknown Widget Co,FIX-CSV-002,8000,NGN,2026-10-05,Unknown Widget Co,9988776655,GTBank,fix_csv_002",
      "Arc Softgoods Inc,FIX-CSV-003,50,USDC,2026-09-25,,,,,fix_csv_003",
    ].join("\n") + "\n",
  );

  await writeText(
    "api/erp-odoo.json",
    JSON.stringify(
      {
        system: "odoo",
        sync: true,
        payload: {
          id: 9001,
          name: "BILL/2026/0901",
          partner_id: [42, "Northern Haulage Ltd"],
          amount_total: 27500,
          currency_id: [1, "NGN"],
          invoice_date: "2026-09-10",
          invoice_date_due: "2026-10-10",
          ref: "FIX-ODOO-001",
          invoice_line_ids: [[0, 0, { name: "Haulage", price_subtotal: 27500 }]],
        },
      },
      null,
      2,
    ),
  );

  await writeText(
    "api/firs.json",
    JSON.stringify(
      {
        sync: true,
        irn: "IRN-FIX-2026-0001",
        supplier_name: "Northern Haulage Ltd",
        invoice_number: "FIX-FIRS-001",
        total_amount: 18500,
        currency: "NGN",
        issue_date: "2026-09-12",
        due_date: "2026-10-12",
      },
      null,
      2,
    ),
  );

  await writeText(
    "README.md",
    `# Fixtures

Generated by \`npm run fixtures:generate\` (zero extra deps).

| File | Expected after sync analyze (default seed policy) |
|------|---------------------------------------------------|
| \`invoices/happy-ngn.pdf\` | Known vendor → often \`approved\` or \`pending_approval\` |
| \`invoices/dual-control.pdf\` | Large amount → \`pending_approval\` (dual) |
| \`invoices/new-vendor.pdf\` | \`needs_review\` (\`new_vendor\`) |
| \`invoices/arc-usdc.pdf\` | \`needs_review\` until \`0x1111…1111\` allowlisted |
| \`invoices/low-confidence.json\` | \`needs_review\` (\`low_confidence\`) |
| \`invoices/duplicate-pair/*\` | Second → \`duplicate_suspected\` |
| \`csv/bulk-ap.csv\` | Mix of known / new / USDC |
| \`api/erp-odoo.json\` | \`POST /api/v1/erp/ingest\` |
| \`api/firs.json\` | \`POST /api/v1/einvoice/firs\` |
`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
