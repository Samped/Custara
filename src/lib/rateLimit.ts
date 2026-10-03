import { prisma } from "./db";

const WINDOW_MS = 60_000;

export async function assertRateLimit(bucket: string, limit: number) {
  const windowStart = new Date(Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS);
  const row = await prisma.apiRateLimit.upsert({
    where: {
      bucket_windowStart: { bucket, windowStart },
    },
    create: { bucket, windowStart, count: 1 },
    update: { count: { increment: 1 } },
  });

  if (row.count > limit) {
    const err = new Error("Rate limit exceeded");
    (err as Error & { status: number }).status = 429;
    throw err;
  }
}
