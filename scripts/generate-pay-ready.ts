/**
 * Mint local pay-ready PDF/JSON invoices for upload + agent-pay drills.
 * Output: test-fixtures/pay-ready/ (gitignored — never push).
 * Run: npm run fixtures:pay-ready
 */
import { mkdir, writeFile } from "fs/promises";
import path from "path";

const ROOT = path.join(process.cwd(), "test-fixtures", "pay-ready");
const suffix = String(Date.now()).slice(-8);

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

async function writePdf(name: string, lines: string[]) {
  const abs = path.join(ROOT, name);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, buildSimplePdf(lines));
  console.log("wrote", path.relative(process.cwd(), abs));
}

async function writeJson(name: string, data: Record<string, unknown>) {
  const abs = path.join(ROOT, name);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, JSON.stringify(data, null, 2) + "\n", "utf8");
  console.log("wrote", path.relative(process.cwd(), abs));
}

async function main() {
  const arcNumber = `PAY-ARC-${suffix}`;
  const ngnNumber = `PAY-NGN-${suffix}`;
  // Vary totals each run so fuzzy_duplicate does not fire against prior QA uploads.
  const usdcTotal = Number((80 + (Number(suffix) % 9000) / 100).toFixed(2));
  const ngnTotal = 50000 + (Number(suffix) % 9000);

  const arcLines = [
    "Vendor: Arc Softgoods Inc",
    `Invoice Number: ${arcNumber}`,
    "Issue Date: 2026-10-01",
    "Due Date: 2026-10-20",
    "Currency: USDC",
    `Total: ${usdcTotal}`,
    "Arc Address: 0xd9792bf937d9673ab08c452fe55ec4e26632be54",
    "PO Number: PO-PAY-ARC",
  ];

  const ngnLines = [
    "Vendor: Northern Haulage Ltd",
    `Invoice Number: ${ngnNumber}`,
    "Issue Date: 2026-10-01",
    "Due Date: 2026-10-25",
    "Currency: NGN",
    `Total: ${ngnTotal}`,
    "Account Name: Northern Haulage Ltd",
    "Account Number: 0123456789",
    "Bank: Access Bank",
    "Bank Code: 044",
    "PO Number: PO-PAY-NGN",
  ];

  await writePdf("agent-pay-usdc.pdf", arcLines);
  await writeJson("agent-pay-usdc.json", {
    vendor_name: "Arc Softgoods Inc",
    invoice_number: arcNumber,
    issue_date: "2026-10-01",
    due_date: "2026-10-20",
    currency: "USDC",
    total_amount: usdcTotal,
    arc_address: "0xd9792bf937d9673ab08c452fe55ec4e26632be54",
    po_number: "PO-PAY-ARC",
    confidence: 0.95,
  });

  await writePdf("export-pay-ngn.pdf", ngnLines);
  await writeJson("export-pay-ngn.json", {
    vendor_name: "Northern Haulage Ltd",
    invoice_number: ngnNumber,
    issue_date: "2026-10-01",
    due_date: "2026-10-25",
    currency: "NGN",
    total_amount: ngnTotal,
    account_name: "Northern Haulage Ltd",
    account_number: "0123456789",
    bank_name: "Access Bank",
    bank_code: "044",
    po_number: "PO-PAY-NGN",
    confidence: 0.94,
  });

  console.log(`\nPay-ready invoices ready (suffix ${suffix}).`);
  console.log(`USDC total ${usdcTotal} · NGN total ${ngnTotal}`);
  console.log("Folder is gitignored — upload from test-fixtures/pay-ready/");
  console.log("Agent pay:  agent-pay-usdc.pdf | agent-pay-usdc.json");
  console.log("Export pay: export-pay-ngn.pdf | export-pay-ngn.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
