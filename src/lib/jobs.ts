import { Queue, Worker, type JobsOptions } from "bullmq";
import IORedis from "ioredis";
import { prisma } from "./db";

export type JobPayload = Record<string, unknown>;

export type QueueName =
  | "invoice-pipeline"
  | "agent-tasks"
  | "webhooks"
  | "xero-sync"
  | "mailbox-poll"
  | "accounting-sync"
  | "sftp-poll"
  | "payment-schedule"
  | "collections-dunning"
  | "retention-purge";

let connection: IORedis | null = null;

export function getRedisConnection() {
  if (connection) return connection;
  const url = process.env.REDIS_URL || "redis://127.0.0.1:6379";
  const tls = url.startsWith("rediss://");
  connection = new IORedis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    connectTimeout: tls ? 10_000 : 2_000,
    ...(tls ? { tls: {} } : {}),
    retryStrategy(times) {
      if (times > 8) return null;
      return Math.min(times * 200, 2_000);
    },
  });
  connection.on("error", (err) => {
    console.warn("[redis]", err.message);
  });
  return connection;
}

export async function redisHealth() {
  try {
    const pong = await getRedisConnection().ping();
    return { ok: pong === "PONG", detail: pong };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : "redis down" };
  }
}

const queueCache = new Map<string, Queue>();

export function getQueue(name: QueueName) {
  const existing = queueCache.get(name);
  if (existing) return existing;
  const q = new Queue(name, { connection: getRedisConnection() });
  queueCache.set(name, q);
  return q;
}

export async function enqueueJob(input: {
  queue: QueueName | string;
  name: string;
  payload: JobPayload;
  organizationId?: string;
  runAt?: Date;
  maxAttempts?: number;
}) {
  const queueName = input.queue as QueueName;
  const delay = input.runAt ? Math.max(0, input.runAt.getTime() - Date.now()) : undefined;
  const opts: JobsOptions = {
    attempts: input.maxAttempts ?? 5,
    backoff: { type: "exponential", delay: 15_000 },
    removeOnComplete: 1000,
    removeOnFail: 5000,
    delay,
  };

  const mirror = await prisma.backgroundJob.create({
    data: {
      queue: queueName,
      name: input.name,
      payloadJson: JSON.stringify(input.payload),
      organizationId: input.organizationId,
      runAt: input.runAt || new Date(),
      maxAttempts: input.maxAttempts ?? 5,
      status: "pending",
    },
  });

  try {
    const redis = getRedisConnection();
    const reachable = await Promise.race([
      redis.ping().then((p) => p === "PONG"),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_500)),
    ]);
    if (!reachable) {
      console.warn(
        "[jobs] Redis unreachable — job kept in Postgres pending. Start Redis + npm run worker.",
      );
      return { id: mirror.id, bullmqId: null, queue: queueName, name: input.name };
    }

    const job = await getQueue(queueName).add(
      input.name,
      { ...input.payload, _mirrorJobId: mirror.id, organizationId: input.organizationId },
      opts,
    );
    return { id: mirror.id, bullmqId: job.id, queue: queueName, name: input.name };
  } catch (e) {
    console.error(
      "[jobs] Redis/BullMQ enqueue failed — job kept in Postgres pending. Start Redis + npm run worker.",
      e instanceof Error ? e.message : e,
    );
    return { id: mirror.id, bullmqId: null, queue: queueName, name: input.name };
  }
}

/** @deprecated Prefer BullMQ workers; kept for scripts that drain locally */
export async function claimNextJob(queue: string) {
  const now = new Date();
  const job = await prisma.backgroundJob.findFirst({
    where: { queue, status: "pending", runAt: { lte: now } },
    orderBy: { createdAt: "asc" },
  });
  if (!job) return null;
  const updated = await prisma.backgroundJob.updateMany({
    where: { id: job.id, status: "pending" },
    data: { status: "active", lockedAt: now, attempts: { increment: 1 } },
  });
  if (updated.count === 0) return null;
  return prisma.backgroundJob.findUnique({ where: { id: job.id } });
}

export async function completeJob(id: string) {
  return prisma.backgroundJob.update({
    where: { id },
    data: { status: "completed", completedAt: new Date(), lastError: null },
  });
}

export async function failJob(id: string, error: string, retryDelayMs = 15_000) {
  const job = await prisma.backgroundJob.findUniqueOrThrow({ where: { id } });
  if (job.attempts >= job.maxAttempts) {
    return prisma.backgroundJob.update({
      where: { id },
      data: { status: "failed", lastError: error },
    });
  }
  return prisma.backgroundJob.update({
    where: { id },
    data: {
      status: "pending",
      lastError: error,
      runAt: new Date(Date.now() + retryDelayMs * job.attempts),
      lockedAt: null,
    },
  });
}

export function createWorker(
  queue: QueueName,
  processor: (jobName: string, payload: JobPayload) => Promise<void>,
  concurrency = 2,
) {
  return new Worker(
    queue,
    async (job) => {
      const payload = job.data as JobPayload;
      const mirrorId = payload._mirrorJobId as string | undefined;
      if (mirrorId) {
        await prisma.backgroundJob.updateMany({
          where: { id: mirrorId },
          data: { status: "active", lockedAt: new Date(), attempts: { increment: 1 } },
        });
      }
      try {
        await processor(job.name, payload);
        if (mirrorId) await completeJob(mirrorId);
      } catch (e) {
        if (mirrorId) await failJob(mirrorId, e instanceof Error ? e.message : "failed");
        throw e;
      }
    },
    { connection: getRedisConnection(), concurrency },
  );
}

/**
 * Durable repeatable jobs via BullMQ job schedulers (survives worker restarts).
 */
export async function ensureRepeatableJob(input: {
  queue: QueueName;
  name: string;
  everyMs: number;
  jobId: string;
}) {
  const q = getQueue(input.queue);
  await q.upsertJobScheduler(
    input.jobId,
    { every: input.everyMs },
    {
      name: input.name,
      data: { scheduled: true },
      opts: {
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    },
  );
}
