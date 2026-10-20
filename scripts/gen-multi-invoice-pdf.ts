/**
 * Build a 5-page PDF with five distinct invoices (different vendors + Arc addresses).
 * Usage: npx tsx scripts/gen-multi-invoice-pdf.ts [outPath]
 */
import { writeFileSync } from "node:fs";
import { PDFDocument, StandardFonts } from "pdf-lib";

const INVOICES = [
  {
    vendor: "Northwind Labs LLC",
    number: "MULTI-5001",
    amount: "12.50",
    address: "0x1111111111111111111111111111111111111111",
    po: "PO-5001",
  },
  {
    vendor: "Beacon Supply Co",
    number: "MULTI-5002",
    amount: "8.25",
    address: "0x2222222222222222222222222222222222222222",
    po: "PO-5002",
  },
  {
    vendor: "Riverstone Freight Ltd",
    number: "MULTI-5003",
    amount: "19.00",
    address: "0x3333333333333333333333333333333333333333",
    po: "PO-5003",
  },
  {
    vendor: "Cedar Peak Services Inc",
    number: "MULTI-5004",
    amount: "5.75",
    address: "0x4444444444444444444444444444444444444444",
    po: "PO-5004",
  },
  {
    vendor: "Harbor Grid Systems PLC",
    number: "MULTI-5005",
    amount: "31.40",
    address: "0x5555555555555555555555555555555555555555",
    po: "PO-5005",
  },
];

async function main() {
  const out = process.argv[2] || "/tmp/custara-multi-5.pdf";
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  for (const inv of INVOICES) {
    const page = doc.addPage([612, 792]);
    let y = 720;
    const line = (text: string, size = 12, useBold = false) => {
      page.drawText(text, { x: 56, y, size, font: useBold ? bold : font });
      y -= size + 10;
    };
    line("INVOICE", 22, true);
    line(`Vendor: ${inv.vendor}`);
    line(`Invoice Number: ${inv.number}`);
    line("Currency: USDC");
    line(`Total Due: ${inv.amount}`);
    line("Due Date: 2026-11-01");
    line(`PO Number: ${inv.po}`);
    line(`Arc Address: ${inv.address}`);
    line("Bill To: Custara Demo Workspace");
    line("Thank you for your business.");
  }

  const bytes = Buffer.from(await doc.save());
  writeFileSync(out, bytes);
  console.log(JSON.stringify({ out, pages: INVOICES.length, bytes: bytes.length, invoices: INVOICES }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
