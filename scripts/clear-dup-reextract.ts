import fs from "fs";
import { PrismaClient } from "@prisma/client";

for (const line of fs.readFileSync(".env", "utf8").split("\n")) {
  const m = line.match(/^([^#=]+)=(.*)$/);
  if (m && !process.env[m[1].trim()]) {
    process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

async function main() {
  const prisma = new PrismaClient();
  const keepId = "cmush1lm9000eh46w6ae0c04y";
  const dropId = "cmusggexq000bw7qoix6ux2j1";

  await prisma.invoiceDocument.updateMany({
    where: { invoiceId: dropId },
    data: { deletedAt: new Date() },
  });
  await prisma.riskAssessment.deleteMany({ where: { invoiceId: dropId } });
  await prisma.approvalRequest.deleteMany({ where: { invoiceId: dropId } });
  await prisma.extractionResult.deleteMany({ where: { invoiceId: dropId } });
  await prisma.invoice.update({
    where: { id: dropId },
    data: { status: "rejected", invoiceNumber: `REJECTED-DUP-${dropId.slice(-6)}` },
  });
  console.log("rejected older duplicate", dropId);

  await prisma.riskAssessment.deleteMany({ where: { invoiceId: keepId } });
  await prisma.approvalRequest.deleteMany({ where: { invoiceId: keepId } });

  const { runInvoicePipeline } = await import("../src/domain/pipeline");
  const r = await runInvoicePipeline(keepId, { type: "system", id: "clear-dup" });
  console.log({
    status: r.invoice.status,
    vendor: r.extraction.vendorName,
    total: r.extraction.totalAmount,
    currency: r.extraction.currency,
    risks: r.risks.map((x) => `${x.severity}:${x.code}`),
    policyDecision: r.policy.decision,
    policyReason: r.policy.reason,
    nextStatus: r.policy.nextStatus,
  });
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
