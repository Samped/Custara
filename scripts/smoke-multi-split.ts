import { readFileSync } from "node:fs";
import { splitMultiInvoicePdf } from "../src/domain/splitMultiInvoicePdf";
import { loadWithPdfJs } from "../src/domain/pdfPages";
import { extractFromText } from "../src/domain/extract";

async function main() {
  const buf = readFileSync("fixtures/custara-multi-5.pdf");
  const viaJs = await loadWithPdfJs(buf);
  console.log("pdfjs pages", viaJs.total, "chars", viaJs.text.length);

  const children = await splitMultiInvoicePdf(buf, "custara-multi-5.pdf");
  if (!children || children.length < 2) {
    throw new Error(`expected multi split, got ${children?.length ?? null}`);
  }
  for (const child of children) {
    const fields = child.pageText ? extractFromText(child.pageText) : null;
    console.log({
      index: child.index,
      invoiceNumber: child.invoiceNumber,
      vendorName: child.vendorName,
      total: fields?.totalAmount,
      currency: fields?.currency,
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
