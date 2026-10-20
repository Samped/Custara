import { readFileSync } from "node:fs";
import { splitMultiInvoicePdf } from "../src/domain/splitMultiInvoicePdf";
import { resolveChildExtractionFields } from "../src/domain/extract";

async function main() {
  const buf = readFileSync("fixtures/custara-multi-5.pdf");
  const children = await splitMultiInvoicePdf(buf, "custara-multi-5.pdf");
  if (!children) throw new Error("expected split");
  for (const child of children) {
    const r = await resolveChildExtractionFields({
      bytes: child.bytes,
      filename: child.filename,
      pageText: child.pageText,
    });
    console.log({
      index: child.index,
      vendor: r.payload?.vendorName,
      invoice: r.payload?.invoiceNumber,
      total: r.payload?.totalAmount,
      currency: r.payload?.currency,
      textChars: r.textSidecar?.length || 0,
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
