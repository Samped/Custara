import { readFileSync } from "fs";
import path from "path";
import { extractFromText } from "../src/domain/extract";

async function main() {
  const abs = path.join(
    process.cwd(),
    "storage/cmuset65r00gncd46pwdej2x2/cmush1lm9000eh46w6ae0c04y-invoice_sample.pdf",
  );
  const buf = readFileSync(abs);
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: buf });
  const result = await parser.getText();
  await parser.destroy?.();
  const text = (result?.text || "").trim();
  console.log("textLen", text.length);
  console.log(text.slice(0, 500));
  const e = extractFromText(text);
  console.log("extract", e);
  console.log("openai", Boolean(process.env.OPENAI_API_KEY?.trim()?.length));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
