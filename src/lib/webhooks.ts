import { createHmac } from "crypto";
import { prisma } from "./db";
import { enqueueJob } from "./jobs";
import { decryptWebhookSecret } from "./crypto";

const BACKOFF_MS = [60_000, 300_000, 1_800_000, 7_200_000, 7_200_000, 7_200_000, 7_200_000, 7_200_000];

export async function dispatchWebhook(
  organizationId: string,
  event: string,
  payload: Record<string, unknown>,
) {
  const endpoints = await prisma.webhookEndpoint.findMany({
    where: { organizationId, isActive: true },
  });

  const body = JSON.stringify({
    event,
    created_at: new Date().toISOString(),
    data: payload,
  });

  for (const endpoint of endpoints) {
    const events = JSON.parse(endpoint.eventsJson) as string[];
    if (!events.includes("*") && !events.includes(event)) continue;

    const delivery = await prisma.webhookDelivery.create({
      data: {
        endpointId: endpoint.id,
        event,
        payloadJson: body,
        attempts: 0,
        maxAttempts: 8,
        nextAttemptAt: new Date(),
        success: false,
      },
    });

    await enqueueJob({
      queue: "webhooks",
      name: "deliver_webhook",
      organizationId,
      payload: { deliveryId: delivery.id },
      maxAttempts: 8,
    });
  }
}

export async function attemptWebhookDelivery(deliveryId: string) {
  const delivery = await prisma.webhookDelivery.findUniqueOrThrow({
    where: { id: deliveryId },
    include: { endpoint: true },
  });
  if (delivery.success || delivery.deadLetteredAt) return delivery;

  const secret = decryptWebhookSecret(delivery.endpoint.secret);
  const signature = createHmac("sha256", secret)
    .update(delivery.payloadJson)
    .digest("hex");

  let statusCode: number | null = null;
  let success = false;
  let lastError: string | null = null;

  try {
    const res = await fetch(delivery.endpoint.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Custara-Signature": signature,
        "X-Custara-Event": delivery.event,
      },
      body: delivery.payloadJson,
      signal: AbortSignal.timeout(5000),
    });
    statusCode = res.status;
    success = res.ok;
    if (!success) lastError = `HTTP ${res.status}`;
  } catch (e) {
    success = false;
    lastError = e instanceof Error ? e.message : "fetch failed";
  }

  const attempts = delivery.attempts + 1;
  if (success) {
    return prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        success: true,
        statusCode,
        attempts,
        lastError: null,
        nextAttemptAt: null,
      },
    });
  }

  if (attempts >= delivery.maxAttempts) {
    return prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        success: false,
        statusCode,
        attempts,
        lastError,
        deadLetteredAt: new Date(),
        nextAttemptAt: null,
      },
    });
  }

  const delay = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)];
  const nextAttemptAt = new Date(Date.now() + delay);
  const updated = await prisma.webhookDelivery.update({
    where: { id: delivery.id },
    data: {
      success: false,
      statusCode,
      attempts,
      lastError,
      nextAttemptAt,
    },
  });

  await enqueueJob({
    queue: "webhooks",
    name: "deliver_webhook",
    payload: { deliveryId: delivery.id },
    runAt: nextAttemptAt,
    maxAttempts: 1,
  });

  return updated;
}

export async function replayWebhookDelivery(deliveryId: string, organizationId: string) {
  const delivery = await prisma.webhookDelivery.findFirst({
    where: { id: deliveryId, endpoint: { organizationId } },
  });
  if (!delivery) throw new Error("Delivery not found");
  await prisma.webhookDelivery.update({
    where: { id: deliveryId },
    data: {
      deadLetteredAt: null,
      nextAttemptAt: new Date(),
      lastError: null,
    },
  });
  await enqueueJob({
    queue: "webhooks",
    name: "deliver_webhook",
    organizationId,
    payload: { deliveryId },
  });
}
