/**
 * Enterprise ops: probe Circle transfer + requeue failed Arc intents.
 *   npx tsx scripts/retry-failed-arc.ts
 */
import { readFileSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";

function loadEnv() {
  try {
    const text = readFileSync(path.join(process.cwd(), ".env"), "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) {
        process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    // ignore
  }
}

async function main() {
  loadEnv();
  const { PrismaClient } = await import("@prisma/client");
  const { createUsdcTransfer } = await import("../src/domain/arc/circle");
  const { retryFailedArcPayment } = await import("../src/domain/arc/tasks");
  const prisma = new PrismaClient();

  console.log("Probing Circle transfer ($1.00)…");
  const probe = await createUsdcTransfer({
    mode: "live",
    walletId: "a4597117-c831-53b4-8f35-bce27cf22bd1",
    walletAddress: "0xcfc944e56b1abfa83e8cd6d7187bb1a5cc51063b",
    provider: "circle",
    destinationAddress: "0xd9792bf937d9673ab08c452fe55ec4e26632be54",
    amount: 1,
    idempotencyKey: randomUUID(),
  });
  console.log("Probe OK:", probe);

  const failed = await prisma.paymentIntent.findMany({
    where: { status: "failed", rail: "arc_usdc" },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  console.log(`Requeueing ${failed.length} failed Arc intent(s)…`);
  for (const intent of failed) {
    const out = await retryFailedArcPayment({
      organizationId: intent.organizationId,
      paymentIntentId: intent.id,
    });
    console.log(
      out.alreadyCompleted
        ? `  ${intent.id} $${intent.amount} → already completed`
        : `  ${intent.id} $${intent.amount} → task ${out.task?.id}`,
    );
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
