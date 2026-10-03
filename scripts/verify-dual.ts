import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const key = "cst_live_28d63d87e265e73a3e5a01d2a946bbd6735ed42a64be5af9";

async function decide(id: string, note: string) {
  const res = await fetch(`http://localhost:3000/api/v1/approvals/${id}/decide`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ decision: "approved", note }),
  });
  console.log(note, await res.json());
}

async function main() {
  const approval = await prisma.approvalRequest.findFirst({
    where: { status: "pending", requiredCount: 2 },
  });
  if (!approval) {
    console.log("No dual pending approval found");
    return;
  }
  console.log("approval", approval.id, "invoice", approval.invoiceId);
  await decide(approval.id, "first");
  await decide(approval.id, "second");
  const pay = await fetch("http://localhost:3000/api/v1/payment-intents", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      invoice_id: approval.invoiceId,
      idempotency_key: `pay_dual_${approval.invoiceId}`,
      rail: "nigeria_export",
    }),
  });
  console.log("payment", await pay.json());
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
