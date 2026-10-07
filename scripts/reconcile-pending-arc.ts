import { readFileSync } from "fs";
import path from "path";

function loadEnv() {
  const text = readFileSync(path.join(process.cwd(), ".env"), "utf8");
  for (const line of text.split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) {
      process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
}

async function main() {
  loadEnv();
  const { PrismaClient } = await import("@prisma/client");
  const { getCircleTransaction } = await import("../src/domain/arc/circle");
  const { enqueueAgentTask, retryFailedArcPayment } = await import("../src/domain/arc/tasks");
  const { reconcileSettlement } = await import("../src/domain/cash");
  const prisma = new PrismaClient();

  const pending = await prisma.paymentIntent.findMany({
    where: {
      rail: "arc_usdc",
      status: { in: ["pending_transfer", "failed"] },
      OR: [{ circleTxId: { not: null } }, { status: "failed" }],
    },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  for (const intent of pending) {
    if (intent.status === "failed" && !intent.circleTxId) {
      const out = await retryFailedArcPayment({
        organizationId: intent.organizationId,
        paymentIntentId: intent.id,
      });
      console.log(
        out.alreadyCompleted
          ? `already completed ${intent.id}`
          : `requeued failed ${intent.id} → ${out.task?.id}`,
      );
      continue;
    }
    if (!intent.circleTxId) continue;
    const tx = await getCircleTransaction(intent.circleTxId);
    console.log(intent.id.slice(0, 14), "circle", tx.state, tx.txHash?.slice(0, 18));
    if (["COMPLETE", "COMPLETED", "CONFIRMED"].includes(tx.state.toUpperCase())) {
      await prisma.paymentIntent.update({
        where: { id: intent.id },
        data: {
          status: "completed",
          txHash: tx.txHash || intent.txHash,
          circleTxId: tx.id,
          failureReason: null,
        },
      });
      const existing = await prisma.settlement.findFirst({ where: { paymentIntentId: intent.id } });
      if (!existing) {
        await reconcileSettlement({
          organizationId: intent.organizationId,
          invoiceId: intent.invoiceId,
          paymentIntentId: intent.id,
          amount: intent.amount,
          currency: intent.currency,
          reference: tx.txHash || tx.id,
          actorType: "system",
        });
      }
      console.log("  settled", intent.amount, intent.currency);
    } else {
      await enqueueAgentTask({
        organizationId: intent.organizationId,
        type: "arc_reconcile",
        paymentIntentId: intent.id,
        payload: { circleTxId: intent.circleTxId },
      });
      console.log("  enqueued reconcile");
    }
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
