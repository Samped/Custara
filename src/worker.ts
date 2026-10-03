import { createWorker, ensureRepeatableJob } from "@/lib/jobs";
import { runInvoicePipeline } from "@/domain/pipeline";
import { runAgentTask } from "@/domain/arc/tasks";
import { attemptWebhookDelivery } from "@/lib/webhooks";
import { syncXeroInbound } from "@/domain/connectors/xero";
import { pollAllMailboxes } from "@/domain/mailbox";
import {
  syncAccountingProvider,
  type AccountingProvider,
} from "@/domain/connectors/accountingProviders";
import {
  processAllSftpDrops,
  processLocalSftpDrop,
  pullRemoteSftpIfConfigured,
} from "@/domain/sftpIngest";
import { runScheduledAutoPays } from "@/domain/timing";
import { runCollectionsDunning } from "@/domain/collections";
import { purgeExpiredDocuments } from "@/domain/retention";

async function main() {
  console.log(
    "Custara BullMQ worker starting (invoice-pipeline, agent-tasks, webhooks, sync, mailbox, sftp, payment-schedule, collections-dunning, retention-purge)",
  );

  const invoiceWorker = createWorker("invoice-pipeline", async (name, payload) => {
    if (name !== "analyze_invoice") throw new Error(`Unknown job ${name}`);
    await runInvoicePipeline(String(payload.invoiceId), {
      type: (payload.actorType as "user" | "system" | "api_key") || "system",
      id: payload.actorId as string | undefined,
      requestId: payload.requestId as string | undefined,
    });
  });

  const agentWorker = createWorker("agent-tasks", async (_name, payload) => {
    const agentTaskId = String(payload.agentTaskId || "");
    if (!agentTaskId) throw new Error("agentTaskId required");
    await runAgentTask(agentTaskId);
  });

  const webhookWorker = createWorker(
    "webhooks",
    async (name, payload) => {
      if (name !== "deliver_webhook") throw new Error(`Unknown job ${name}`);
      await attemptWebhookDelivery(String(payload.deliveryId));
    },
    4,
  );

  const xeroWorker = createWorker("xero-sync", async (name, payload) => {
    if (name !== "sync_inbound") throw new Error(`Unknown job ${name}`);
    await syncXeroInbound(String(payload.organizationId));
  });

  const accountingWorker = createWorker("accounting-sync", async (name, payload) => {
    if (name !== "sync_provider") throw new Error(`Unknown job ${name}`);
    const provider = String(payload.provider) as AccountingProvider;
    const organizationId = String(payload.organizationId);
    await syncAccountingProvider(organizationId, provider);
  });

  const mailboxWorker = createWorker("mailbox-poll", async (name) => {
    if (name !== "poll_all") throw new Error(`Unknown job ${name}`);
    const summary = await pollAllMailboxes();
    console.log("[mailbox-poll]", JSON.stringify(summary));
  });

  const sftpWorker = createWorker("sftp-poll", async (name, payload) => {
    if (name === "poll_all") {
      const orgs = await processAllSftpDrops();
      console.log("[sftp-poll]", JSON.stringify(orgs));
      return;
    }
    if (name === "poll_org") {
      const organizationId = String(payload.organizationId);
      await pullRemoteSftpIfConfigured(organizationId);
      const result = await processLocalSftpDrop(organizationId);
      console.log("[sftp-poll-org]", organizationId, JSON.stringify(result));
      return;
    }
    throw new Error(`Unknown job ${name}`);
  });

  const payScheduleWorker = createWorker("payment-schedule", async (name) => {
    if (name !== "run_autopay") throw new Error(`Unknown job ${name}`);
    const summary = await runScheduledAutoPays();
    console.log("[payment-schedule]", JSON.stringify(summary));
  });

  const collectionsWorker = createWorker("collections-dunning", async (name) => {
    if (name !== "run_dunning") throw new Error(`Unknown job ${name}`);
    const summary = await runCollectionsDunning();
    console.log("[collections-dunning]", JSON.stringify(summary));
  });

  const retentionWorker = createWorker("retention-purge", async (name) => {
    if (name !== "purge_expired") throw new Error(`Unknown job ${name}`);
    const summary = await purgeExpiredDocuments();
    console.log("[retention-purge]", JSON.stringify(summary));
  });

  for (const w of [
    invoiceWorker,
    agentWorker,
    webhookWorker,
    xeroWorker,
    accountingWorker,
    mailboxWorker,
    sftpWorker,
    payScheduleWorker,
    collectionsWorker,
    retentionWorker,
  ]) {
    w.on("failed", (job, err) => {
      console.error(`Job failed ${job?.queueName}/${job?.name}`, err.message);
    });
  }

  // Durable BullMQ repeatables (HA-friendly vs in-process setInterval)
  await ensureRepeatableJob({
    queue: "mailbox-poll",
    name: "poll_all",
    everyMs: 5 * 60_000,
    jobId: "cron-mailbox-poll",
  });
  await ensureRepeatableJob({
    queue: "sftp-poll",
    name: "poll_all",
    everyMs: 5 * 60_000,
    jobId: "cron-sftp-poll",
  });
  await ensureRepeatableJob({
    queue: "payment-schedule",
    name: "run_autopay",
    everyMs: 15 * 60_000,
    jobId: "cron-autopay",
  });
  await ensureRepeatableJob({
    queue: "collections-dunning",
    name: "run_dunning",
    everyMs: 60 * 60_000,
    jobId: "cron-collections",
  });
  await ensureRepeatableJob({
    queue: "retention-purge",
    name: "purge_expired",
    everyMs: 6 * 60 * 60_000,
    jobId: "cron-retention-purge",
  });

  console.log("Custara worker ready (BullMQ repeatable crons registered)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
