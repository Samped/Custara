import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { completeJob, enqueueJob, failJob } from "@/lib/jobs";
import { dispatchWebhook } from "@/lib/webhooks";
import { assertDestinationAllowed, assertSpendLimits } from "./allowlist";
import { createUsdcTransfer, getCircleTransaction } from "./circle";
import { applyAgentSpend, ensureAgentWallet, restoreAgentSpend, syncWalletBalances } from "./wallets";
import { reconcileSettlement } from "@/domain/cash";

export async function enqueueAgentTask(input: {
  organizationId: string;
  type: "arc_transfer" | "arc_reconcile" | "wallet_sync";
  paymentIntentId?: string;
  payload?: Record<string, unknown>;
  /** Settle a reconcile immediately when Circle is already terminal. In-flight reconciles stay queued. */
  runInline?: boolean;
  runAt?: Date;
}) {
  const task = await prisma.agentTask.create({
    data: {
      organizationId: input.organizationId,
      type: input.type,
      status: "pending",
      paymentIntentId: input.paymentIntentId || null,
      payloadJson: JSON.stringify(input.payload || {}),
    },
  });

  // Pay from the request. The Render worker sleeps, so a queued transfer stays on Sending.
  const runInRequest = input.runInline || (input.type === "arc_transfer" && !input.runAt);
  if (runInRequest) {
    await runAgentTask(task.id);
    return task;
  }

  const queued = await enqueueJob({
    queue: "agent-tasks",
    name: input.type,
    organizationId: input.organizationId,
    payload: { agentTaskId: task.id },
    runAt: input.runAt,
  });

  const runNow = !queued.bullmqId && input.type !== "arc_reconcile";
  if (runNow) {
    try {
      await runAgentTask(task.id);
      await completeJob(queued.id);
    } catch (e) {
      await failJob(queued.id, e instanceof Error ? e.message : "agent task failed");
      throw e;
    }
  }

  return task;
}

export async function runAgentTask(agentTaskId: string) {
  const claimed = await prisma.agentTask.updateMany({
    where: { id: agentTaskId, status: "pending" },
    data: { status: "running", attempts: { increment: 1 } },
  });
  if (claimed.count === 0) {
    return prisma.agentTask.findUniqueOrThrow({ where: { id: agentTaskId } });
  }

  const task = await prisma.agentTask.findUniqueOrThrow({ where: { id: agentTaskId } });

  try {
    if (task.type === "wallet_sync") {
      const { syncWalletBalances } = await import("./wallets");
      await syncWalletBalances(task.organizationId);
    } else if (task.type === "arc_transfer") {
      await executeArcTransferTask(task.id);
    } else if (task.type === "arc_reconcile") {
      await executeArcReconcileTask(task.id);
    } else {
      throw new Error(`Unknown agent task type ${task.type}`);
    }

    return prisma.agentTask.update({
      where: { id: task.id },
      data: { status: "completed", completedAt: new Date(), error: null },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Agent task failed";
    await prisma.agentTask.update({
      where: { id: task.id },
      data: { status: "failed", error: message },
    });
    throw e;
  }
}

async function markInvoicePaymentFailed(invoiceId: string, reason: string) {
  await prisma.invoice.update({
    where: { id: invoiceId },
    data: { status: "payment_failed", explanation: reason },
  });
}

async function executeArcTransferTask(taskId: string) {
  const task = await prisma.agentTask.findUniqueOrThrow({
    where: { id: taskId },
    include: { paymentIntent: true },
  });
  const intent = task.paymentIntent;
  if (!intent) throw new Error("arc_transfer requires paymentIntentId");

  try {
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: task.organizationId } });
    const mode = org.paymentMode === "live" ? "live" : "sandbox";
    const beneficiary = JSON.parse(intent.beneficiaryJson) as {
      arcAddress?: string;
      vendorName?: string;
    };
    const destination = beneficiary.arcAddress;
    if (!destination) throw new Error("Payment intent missing arcAddress beneficiary");

    await assertDestinationAllowed(task.organizationId, destination);
    const { screenDestination } = await import("@/domain/screening");
    await screenDestination({
      organizationId: task.organizationId,
      address: destination,
      vendorName: beneficiary.vendorName,
      context: "pre_pay",
    });
    await assertSpendLimits(task.organizationId, intent.amount);

    const { assertPayTimeGuards } = await import("@/domain/payGuards");
    await assertPayTimeGuards({
      organizationId: task.organizationId,
      invoiceId: intent.invoiceId,
      rail: "arc_usdc",
      amount: intent.amount,
      currency: intent.currency,
      arcAddress: destination,
    });

    const agent = await ensureAgentWallet({
      organizationId: task.organizationId,
      actorType: "system",
    });
    if (!agent.circleWalletId) throw new Error("Agent wallet missing circleWalletId");
    const { allowSimulatedArc } = await import("./config");
    if (agent.provider === "sandbox" && !allowSimulatedArc()) {
      throw new Error(
        "Agent wallet is simulated. Upgrade to Circle testnet agent in Wallets before paying.",
      );
    }

    // Unique per agent-task attempt so retries never reuse a burned Circle idempotency key.
    const attempt = Math.max(1, task.attempts || 1);
    let transfer = await createUsdcTransfer({
      mode,
      walletId: agent.circleWalletId,
      walletAddress: agent.address,
      provider: agent.provider,
      destinationAddress: destination,
      amount: intent.amount,
      idempotencyKey: `arc-transfer-${intent.id}-${task.id}-a${attempt}`,
    });

    const settled = (state: string) =>
      ["COMPLETE", "COMPLETED", "CONFIRMED", "FAILED", "CANCELLED", "DENIED"].includes(state.toUpperCase());
    for (let i = 0; i < 8 && !settled(transfer.state); i++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const tx = await getCircleTransaction(transfer.id);
      transfer = { ...transfer, id: tx.id, state: tx.state, txHash: tx.txHash || transfer.txHash };
    }

    await prisma.agentTask.update({
      where: { id: task.id },
      data: { circleTxId: transfer.id, txHash: transfer.txHash || null, error: null },
    });

    const failed = ["FAILED", "CANCELLED", "DENIED"].includes(transfer.state.toUpperCase());
    if (failed) {
      await prisma.paymentIntent.update({
        where: { id: intent.id },
        data: { status: "failed", failureReason: `Circle tx ${transfer.state}`, circleTxId: transfer.id },
      });
      await markInvoicePaymentFailed(intent.invoiceId, `Arc transfer ${transfer.state}`);
      await dispatchWebhook(task.organizationId, "payment.failed", {
        id: intent.id,
        invoice_id: intent.invoiceId,
        error: `Circle tx ${transfer.state}`,
        circle_tx_id: transfer.id,
      });
      throw new Error(`Transfer ${transfer.state}`);
    }

    const terminal = ["COMPLETE", "COMPLETED", "CONFIRMED"].includes(transfer.state.toUpperCase());
    const initiated = ["INITIATED", "PENDING", "QUEUED", "SENT", "STAGED", "CLEARING"].includes(
      transfer.state.toUpperCase(),
    );
    await prisma.paymentIntent.update({
      where: { id: intent.id },
      data: {
        status: terminal ? "completed" : "pending_transfer",
        providerRef: transfer.id,
        circleTxId: transfer.id,
        txHash: transfer.txHash || null,
        failureReason: null,
      },
    });

    await prisma.invoice.update({
      where: { id: intent.invoiceId },
      data: { status: terminal ? "payment_sent" : "payment_queued" },
    });

    if (terminal) {
      const { writeOdooPaymentBack } = await import("@/domain/connectors/odoo");
      await writeOdooPaymentBack({
        organizationId: task.organizationId,
        invoiceId: intent.invoiceId,
        paymentIntentId: intent.id,
        amount: intent.amount,
        currency: intent.currency,
      });
    }

    await applyAgentSpend({
      organizationId: task.organizationId,
      paymentIntentId: intent.id,
      amount: intent.amount,
    });

    await writeAudit({
      organizationId: task.organizationId,
      actorType: "system",
      action: "agent.arc_transfer",
      entityType: "payment_intent",
      entityId: intent.id,
      metadata: {
        circleTxId: transfer.id,
        txHash: transfer.txHash,
        state: transfer.state,
        destination,
        amount: intent.amount,
        provider: transfer.provider,
        attempt,
      },
    });

    // Poll reconcile for terminal or in-flight Circle states (webhooks may be absent in local).
    if (terminal || initiated) {
      await enqueueAgentTask({
        organizationId: task.organizationId,
        type: "arc_reconcile",
        paymentIntentId: intent.id,
        payload: { circleTxId: transfer.id },
        runInline: terminal,
      });
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : "Arc transfer failed";
    await prisma.agentTask.update({
      where: { id: task.id },
      data: { error: message.slice(0, 1000) },
    });
    const current = await prisma.paymentIntent.findUnique({ where: { id: intent.id } });
    if (current && current.status !== "completed") {
      await prisma.paymentIntent.update({
        where: { id: intent.id },
        data: { status: "failed", failureReason: message.slice(0, 1000) },
      });
      await markInvoicePaymentFailed(intent.invoiceId, message.slice(0, 500));
    }
    throw e;
  }
}

/** Re-queue a failed Arc payment intent for another on-chain attempt. */
export async function retryFailedArcPayment(input: {
  organizationId: string;
  paymentIntentId: string;
  actorId?: string;
}) {
  const intent = await prisma.paymentIntent.findFirst({
    where: { id: input.paymentIntentId, organizationId: input.organizationId },
  });
  if (!intent) throw new Error("Payment intent not found");

  if (input.actorId) {
    const { convertAmount } = await import("@/lib/currency");
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: input.organizationId },
      select: { mfaPayThresholdUsd: true },
    });
    const threshold = org.mfaPayThresholdUsd ?? 5000;
    const amountUsd = convertAmount(intent.amount, intent.currency, "USD");
    if (amountUsd >= threshold) {
      const actor = await prisma.workspaceUser.findUniqueOrThrow({ where: { id: input.actorId } });
      if (!actor.mfaEnabled || !actor.mfaSecretEnc) {
        const { MFA_SETUP_REQUIRED_CODE } = await import("@/domain/payStepUp");
        throw new Error(
          `${MFA_SETUP_REQUIRED_CODE}: Set up MFA before sending payments at or above the organization threshold. Open Security to enable authenticator protection.`,
        );
      }
    }
  }
  if (intent.rail !== "arc_usdc") throw new Error("Only Arc USDC intents can be retried here");
  if (intent.status === "completed" || intent.txHash) {
    // Idempotent — UI may still show Retry briefly after settle.
    return { intent, task: null as null, alreadyCompleted: true as const };
  }

  await prisma.paymentIntent.update({
    where: { id: intent.id },
    data: { status: "pending_transfer", failureReason: null },
  });
  await prisma.invoice.update({
    where: { id: intent.invoiceId },
    data: { status: "payment_queued", explanation: null },
  });

  const task = await enqueueAgentTask({
    organizationId: input.organizationId,
    type: "arc_transfer",
    paymentIntentId: intent.id,
    payload: { invoiceId: intent.invoiceId, retry: true },
  });

  await writeAudit({
    organizationId: input.organizationId,
    actorType: "user",
    actorId: input.actorId,
    action: "payment.retry_arc_transfer",
    entityType: "payment_intent",
    entityId: intent.id,
    metadata: { agentTaskId: task.id },
  });

  return { intent, task, alreadyCompleted: false as const };
}

async function executeArcReconcileTask(taskId: string) {
  const task = await prisma.agentTask.findUniqueOrThrow({
    where: { id: taskId },
    include: { paymentIntent: true },
  });
  const intent = task.paymentIntent;
  if (!intent) throw new Error("arc_reconcile requires paymentIntentId");

  const txId = task.circleTxId || intent.circleTxId;
  if (!txId) throw new Error("Missing circleTxId for reconcile");

  const tx = await getCircleTransaction(txId);
  await prisma.agentTask.update({
    where: { id: task.id },
    data: { circleTxId: tx.id, txHash: tx.txHash || intent.txHash },
  });

  const state = tx.state.toUpperCase();
  if (["FAILED", "CANCELLED", "DENIED"].includes(state)) {
    await prisma.paymentIntent.update({
      where: { id: intent.id },
      data: { status: "failed", failureReason: `Circle tx ${state}` },
    });
    await prisma.invoice.update({
      where: { id: intent.invoiceId },
      data: { status: "payment_failed", explanation: `Circle tx ${state}` },
    });
    await restoreAgentSpend({
      organizationId: task.organizationId,
      paymentIntentId: intent.id,
      amount: intent.amount,
    });
    await dispatchWebhook(task.organizationId, "payment.failed", {
      id: intent.id,
      invoice_id: intent.invoiceId,
      error: `Circle tx ${state}`,
      circle_tx_id: txId,
    });
    throw new Error(`Transfer ${state}`);
  }

  if (!["COMPLETE", "COMPLETED", "CONFIRMED"].includes(state)) {
    const payload = JSON.parse(task.payloadJson || "{}") as { poll?: number };
    const poll = Number(payload.poll || 0);
    if (poll < 48) {
      await enqueueAgentTask({
        organizationId: task.organizationId,
        type: "arc_reconcile",
        paymentIntentId: intent.id,
        payload: { circleTxId: tx.id, poll: poll + 1 },
        runAt: new Date(Date.now() + 45_000),
      });
      return;
    }
    throw new Error(`Transfer still ${state}`);
  }

  await prisma.paymentIntent.update({
    where: { id: intent.id },
    data: {
      status: "completed",
      txHash: tx.txHash || intent.txHash,
      circleTxId: tx.id,
    },
  });

  const existing = await prisma.settlement.findFirst({
    where: { paymentIntentId: intent.id },
  });
  if (!existing) {
    await reconcileSettlement({
      organizationId: task.organizationId,
      invoiceId: intent.invoiceId,
      paymentIntentId: intent.id,
      amount: intent.amount,
      currency: intent.currency,
      reference: tx.txHash || tx.id,
      actorType: "system",
    });
  }

  await syncWalletBalances(task.organizationId).catch(() => null);

  await writeAudit({
    organizationId: task.organizationId,
    actorType: "system",
    action: "agent.arc_reconciled",
    entityType: "payment_intent",
    entityId: intent.id,
    metadata: { circleTxId: tx.id, txHash: tx.txHash },
  });
}

/** Finish transfers the sleeping worker never picked up, and keep polling ones Circle has accepted. */
export async function resumeStuckArcPayments(organizationId?: string) {
  const cutoff = new Date(Date.now() - 90_000);
  const intents = await prisma.paymentIntent.findMany({
    where: {
      ...(organizationId ? { organizationId } : {}),
      rail: "arc_usdc",
      status: { in: ["queued", "pending_transfer"] },
      updatedAt: { lt: cutoff },
    },
    take: 5,
    orderBy: { updatedAt: "asc" },
  });
  let resumed = 0;
  for (const intent of intents) {
    if (intent.circleTxId) {
      const openReconcile = await prisma.agentTask.findFirst({
        where: {
          paymentIntentId: intent.id,
          type: "arc_reconcile",
          status: { in: ["pending", "running"] },
        },
      });
      if (openReconcile) continue;
      await enqueueAgentTask({
        organizationId: intent.organizationId,
        type: "arc_reconcile",
        paymentIntentId: intent.id,
        payload: { circleTxId: intent.circleTxId, source: "sweep" },
        runInline: true,
      });
      resumed += 1;
      continue;
    }

    const openTransfer = await prisma.agentTask.findFirst({
      where: {
        paymentIntentId: intent.id,
        type: "arc_transfer",
        status: { in: ["pending", "running"] },
      },
      orderBy: { createdAt: "desc" },
    });
    if (openTransfer?.status === "running") continue;
    if (openTransfer?.status === "pending") {
      await runAgentTask(openTransfer.id);
      resumed += 1;
      continue;
    }
    await enqueueAgentTask({
      organizationId: intent.organizationId,
      type: "arc_transfer",
      paymentIntentId: intent.id,
      payload: { invoiceId: intent.invoiceId, resume: true },
    });
    resumed += 1;
  }
  return { scanned: intents.length, resumed };
}

export async function handleCircleWebhookPayload(payload: Record<string, unknown>) {
  const notification = (payload.notification || payload) as Record<string, unknown>;
  const txId =
    (notification.id as string) ||
    (notification.transactionId as string) ||
    ((notification.transaction as { id?: string } | undefined)?.id);
  if (!txId) return { handled: false };

  const intent = await prisma.paymentIntent.findFirst({
    where: { circleTxId: txId },
  });
  if (!intent) {
    console.error("[ALERT] circle.unknown_tx", txId, {
      notificationKeys: Object.keys(notification),
    });
    return { handled: false, reason: "unknown_tx", alerted: true };
  }

  const state = String(notification.state || notification.status || "").toUpperCase();
  const txHash =
    (notification.txHash as string) ||
    (notification.transactionHash as string) ||
    intent.txHash;

  if (["COMPLETE", "COMPLETED", "CONFIRMED"].includes(state)) {
    await prisma.paymentIntent.update({
      where: { id: intent.id },
      data: { status: "completed", txHash: txHash || null },
    });
    await enqueueAgentTask({
      organizationId: intent.organizationId,
      type: "arc_reconcile",
      paymentIntentId: intent.id,
      payload: { circleTxId: txId, source: "webhook" },
    });
    return { handled: true, action: "reconcile_enqueued" };
  }

  if (["FAILED", "CANCELLED", "DENIED"].includes(state)) {
    await prisma.paymentIntent.update({
      where: { id: intent.id },
      data: { status: "failed", failureReason: `Circle webhook ${state}` },
    });
    await prisma.invoice.update({
      where: { id: intent.invoiceId },
      data: { status: "payment_failed", explanation: `Circle webhook ${state}` },
    });
    await restoreAgentSpend({
      organizationId: intent.organizationId,
      paymentIntentId: intent.id,
      amount: intent.amount,
    });
    await dispatchWebhook(intent.organizationId, "payment.failed", {
      id: intent.id,
      invoice_id: intent.invoiceId,
      error: `Circle webhook ${state}`,
      circle_tx_id: txId,
    });
    await writeAudit({
      organizationId: intent.organizationId,
      actorType: "system",
      action: "payment.failed",
      entityType: "payment_intent",
      entityId: intent.id,
      metadata: { circleTxId: txId, state },
    });
    return { handled: true, action: "marked_failed" };
  }

  return { handled: true, action: "ignored_state", state };
}
