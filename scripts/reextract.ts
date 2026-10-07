import fs from "fs";
import { PrismaClient } from "@prisma/client";

for (const line of fs.readFileSync(".env", "utf8").split("\n")) {
  const m = line.match(/^([^#=]+)=(.*)$/);
  if (m && !process.env[m[1].trim()]) {
    process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

async function main() {
  const { runInvoicePipeline } = await import("../src/domain/pipeline");
  const prisma = new PrismaClient();
  const ids = process.argv.slice(2);
  const targets =
    ids.length > 0
      ? ids
      : (
          await prisma.invoice.findMany({
            where: { OR: [{ invoiceNumber: { startsWith: "UNK-" } }, { extraction: { vendorName: "Unknown Vendor" } }] },
            select: { id: true },
            take: 20,
          })
        ).map((i) => i.id);

  for (const id of targets) {
    try {
      const r = await runInvoicePipeline(id, { type: "system", id: "reextract" });
      console.log(
        id,
        r.extraction.vendorName,
        r.extraction.invoiceNumber,
        r.extraction.totalAmount,
        r.extraction.currency,
        r.invoice.status,
        r.risks.map((x) => x.code).join(","),
      );
    } catch (e) {
      console.error(id, e instanceof Error ? e.message : e);
    }
  }
  await prisma.$disconnect();
}

main();
