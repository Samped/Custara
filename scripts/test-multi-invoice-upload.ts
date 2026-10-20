/**
 * Local smoke test: split a 5-invoice PDF and ingest each child.
 * Usage: npx tsx scripts/test-multi-invoice-upload.ts [/tmp/custara-multi-5.pdf]
 */
import { readFileSync } from "node:fs";
import { prisma } from "../src/lib/db";
import { splitMultiInvoicePdf } from "../src/domain/splitMultiInvoicePdf";
import { processPdfInvoiceBytes } from "../src/domain/uploadInvoice";

async function main() {
  const pdfPath = process.argv[2] || "/tmp/custara-multi-5.pdf";
  const bytes = readFileSync(pdfPath);

  const split = await splitMultiInvoicePdf(bytes, "custara-multi-5.pdf");
  console.log(
    "split",
    split
      ? {
          count: split.length,
          segments: split.map((c) => ({
            index: c.index,
            pages: `${c.pageStart}-${c.pageEnd}`,
            file: c.filename,
            vendor: c.vendorName,
            number: c.invoiceNumber,
            bytes: c.bytes.length,
          })),
        }
      : null,
  );
  if (!split || split.length < 2) {
    throw new Error(`Expected 5 child PDFs, got ${split?.length ?? 0}`);
  }

  let org = await prisma.organization.findFirst({ orderBy: { createdAt: "asc" } });
  let user = org
    ? await prisma.workspaceUser.findFirst({ where: { organizationId: org.id }, orderBy: { createdAt: "asc" } })
    : null;

  if (!org || !user) {
    org = await prisma.organization.create({
      data: {
        name: "Multi Invoice Test Co",
        slug: `multi-test-${Date.now()}`,
      },
    });
    user = await prisma.workspaceUser.create({
      data: {
        organizationId: org.id,
        email: `multi-test-${Date.now()}@custara.local`,
        name: "Multi Tester",
        role: "admin",
      },
    });
    console.log("created org/user for test", org.id, user.id);
  } else {
    console.log("using org/user", org.id, user.id);
  }

  const result = await processPdfInvoiceBytes({
    organizationId: org.id,
    actorType: "user",
    actorId: user.id,
    filename: "custara-multi-5.pdf",
    bytes,
    sync: true,
  });

  const rows = await prisma.invoice.findMany({
    where: { id: { in: result.ids } },
    include: {
      extraction: true,
      vendor: true,
      risks: { select: { code: true, severity: true } },
    },
    orderBy: { sourceSegmentIndex: "asc" },
  });

  console.log(
    JSON.stringify(
      {
        split: result.split,
        count: result.ids.length,
        invoices: rows.map((r) => ({
          id: r.id,
          segment: r.sourceSegmentIndex,
          batch: r.sourceBatchId,
          status: r.status,
          number: r.invoiceNumber || r.extraction?.invoiceNumber,
          vendor: r.vendor?.name || r.extraction?.vendorName,
          amount: r.totalAmount ?? r.extraction?.totalAmount,
          currency: r.currency || r.extraction?.currency,
          arcAddress: (() => {
            try {
              const raw = JSON.parse(r.extraction?.rawJson || "{}") as { arcAddress?: string };
              return raw.arcAddress || null;
            } catch {
              return null;
            }
          })(),
          risks: r.risks.map((x) => x.code),
        })),
      },
      null,
      2,
    ),
  );

  if (result.ids.length !== 5) {
    throw new Error(`Expected 5 invoices, got ${result.ids.length}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
