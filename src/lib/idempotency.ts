import { createHash } from "crypto";
import { prisma } from "./db";

export async function withIdempotency<T>(input: {
  organizationId: string;
  key: string;
  requestHash: string;
  handler: () => Promise<{ status: number; body: T }>;
}): Promise<{ status: number; body: T; replayed: boolean }> {
  const existing = await prisma.idempotencyRecord.findUnique({
    where: {
      organizationId_key: {
        organizationId: input.organizationId,
        key: input.key,
      },
    },
  });

  if (existing) {
    if (existing.requestHash !== input.requestHash) {
      const err = new Error("Idempotency-Key reused with different payload");
      (err as Error & { status: number }).status = 409;
      throw err;
    }
    return {
      status: existing.statusCode,
      body: JSON.parse(existing.responseJson) as T,
      replayed: true,
    };
  }

  const result = await input.handler();
  await prisma.idempotencyRecord.create({
    data: {
      organizationId: input.organizationId,
      key: input.key,
      requestHash: input.requestHash,
      responseJson: JSON.stringify(result.body),
      statusCode: result.status,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });
  return { ...result, replayed: false };
}

export function hashRequestBody(body: unknown) {
  return createHash("sha256").update(JSON.stringify(body ?? {})).digest("hex");
}
