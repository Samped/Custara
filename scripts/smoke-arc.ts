import { prisma } from "../src/lib/db";
import { ensureAgentWallet, listOrgWallets, syncWalletBalances } from "../src/domain/arc/wallets";
import { createPaymentIntent } from "../src/domain/payment";
import { claimNextJob, completeJob, failJob } from "../src/lib/jobs";
import { runAgentTask } from "../src/domain/arc/tasks";

async function drainAgentTasks(max = 10) {
  for (let i = 0; i < max; i++) {
    const job = await claimNextJob("agent-tasks");
    if (!job) break;
    try {
      const payload = JSON.parse(job.payloadJson) as { agentTaskId: string };
      await runAgentTask(payload.agentTaskId);
      await completeJob(job.id);
      console.log("completed", job.name, payload.agentTaskId);
    } catch (e) {
      await failJob(job.id, e instanceof Error ? e.message : "fail");
      console.log("failed job", e);
    }
  }
}

async function main() {
  const org = await prisma.organization.findFirstOrThrow();
  const agent = await ensureAgentWallet({ organizationId: org.id, actorType: "system" });
  console.log("agent", agent.address, agent.provider);

  await syncWalletBalances(org.id);
  console.log(
    "wallets",
    (await listOrgWallets(org.id)).map((w) => ({ role: w.role, bal: w.balanceUsdc, status: w.status })),
  );

  const invoice = await prisma.invoice.findFirst({
    where: { organizationId: org.id, currency: "USDC", status: "approved" },
  });
  if (!invoice) {
    // approve the seeded arc invoice if pending
    const pending = await prisma.invoice.findFirst({
      where: { organizationId: org.id, currency: "USDC" },
    });
    console.log("usdc invoice status", pending?.status, pending?.id);
    if (pending && (pending.status === "pending_approval" || pending.status === "needs_review")) {
      await prisma.invoice.update({ where: { id: pending.id }, data: { status: "approved" } });
      console.log("force-approved for smoke");
    }
  }

  const ready = await prisma.invoice.findFirst({
    where: { organizationId: org.id, currency: "USDC", status: { in: ["approved", "payment_queued"] } },
  });
  if (!ready) {
    console.log("no ready USDC invoice");
    return;
  }

  const intent = await createPaymentIntent({
    organizationId: org.id,
    invoiceId: ready.id,
    idempotencyKey: `smoke_arc_${Date.now()}`,
    rail: "arc_usdc",
    actorType: "system",
  });
  console.log("intent", intent.id, intent.status, intent.rail);

  await drainAgentTasks();

  const refreshed = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } });
  console.log("final", refreshed.status, refreshed.txHash, refreshed.circleTxId);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => prisma.$disconnect());
