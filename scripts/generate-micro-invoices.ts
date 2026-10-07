/**
 * Seven small USDC invoices ($1–$3) for agent-pay drills.
 * Output: test-fixtures/pay-ready/micro/ (gitignored)
 */
import { mkdir, writeFile } from "fs/promises";
import path from "path";

const ROOT = path.join(process.cwd(), "test-fixtures", "pay-ready", "micro");
const ARC = "0xd9792bf937d9673ab08c452fe55ec4e26632be54";
const suffix = String(Date.now()).slice(-8);

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

const invoices = [
  { n: 1, total: 1.0, vendor: "Arc Softgoods Inc" },
  { n: 2, total: 1.25, vendor: "Arc Softgoods Inc" },
  { n: 3, total: 1.5, vendor: "Northwind Labs LLC" },
  { n: 4, total: 2.0, vendor: "Northwind Labs LLC" },
  { n: 5, total: 2.25, vendor: "Beacon Supply Co" },
  { n: 6, total: 2.75, vendor: "Beacon Supply Co" },
  { n: 7, total: 3.0, vendor: "Arc Softgoods Inc" },
];

async function main() {
  await mkdir(ROOT, { recursive: true });
  const manifest: Array<{
    file: string;
    number: string;
    vendor: string;
    totalUsdc: number;
  }> = [];

  for (const inv of invoices) {
    const number = `MICRO-${suffix}-${inv.n}`;
    const file = `micro-${inv.n}-${String(inv.total).replace(".", "p")}-usdc.pdf`;
    const lines = [
      `Vendor: ${inv.vendor}`,
      `Invoice Number: ${number}`,
      "Issue Date: 2026-10-01",
      "Due Date: 2026-10-10",
      "Currency: USDC",
      `Total: ${inv.total.toFixed(2)}`,
      `Arc Address: ${ARC}`,
      `PO Number: PO-MICRO-${inv.n}`,
    ];
    await writeFile(path.join(ROOT, file), buildSimplePdf(lines));
    await writeFile(
      path.join(ROOT, file.replace(".pdf", ".json")),
      JSON.stringify(
        {
          vendor_name: inv.vendor,
          invoice_number: number,
          issue_date: "2026-10-01",
          due_date: "2026-10-10",
          currency: "USDC",
          total_amount: inv.total,
          arc_address: ARC,
          po_number: `PO-MICRO-${inv.n}`,
          confidence: 0.95,
        },
        null,
        2,
      ) + "\n",
    );
    manifest.push({ file, number, vendor: inv.vendor, totalUsdc: inv.total });
    console.log(`${inv.n}. $${inv.total.toFixed(2)}  ${number}  ${file}`);
  }

  await writeFile(
    path.join(ROOT, "manifest.json"),
    JSON.stringify({ suffix, arcAddress: ARC, invoices: manifest }, null, 2) + "\n",
  );
  console.log(`\nWrote ${manifest.length} invoices → ${path.relative(process.cwd(), ROOT)}`);
  console.log(`Total to pay: $${manifest.reduce((s, i) => s + i.totalUsdc, 0).toFixed(2)} USDC`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
