import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { convertAmount } from "@/lib/currency";
import { addDestination, isDestinationAllowed } from "@/domain/arc/allowlist";
import { assertPayTimeGuards } from "@/domain/payGuards";
import { assertPayStepUp } from "@/domain/payStepUp";
import { enqueueAgentTask } from "@/domain/arc/tasks";
import { ensureAgentWallet } from "@/domain/arc/wallets";
import { assertArcPaymentsAllowed } from "@/domain/arc/config";

const INTERVALS = new Set(["weekly", "monthly"]);

function normalizeAddress(address: string) {
  const a = address.trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(a)) throw new Error("Enter a valid 0x wallet address");
  return a;
}

function nextRunAt(interval: string, from = new Date()) {
  const days = interval === "weekly" ? 7 : 30;
  return new Date(from.getTime() + days * 86_400_000);
}

export async function payClient(input: {
  organizationId: string;
  toAddress: string;
  amountUsdc: number;
  interval?: string | null;
  actorId: string;
  mfaCode?: string | null;
}) {
  if (!(input.amountUsdc > 0)) throw new Error("Enter a USDC amount");
  const toAddress = normalizeAddress(input.toAddress);
  const interval = (input.interval || "once").trim().toLowerCase();
  if (interval !== "once" && !INTERVALS.has(interval)) {
    throw new Error("Recurring interval must be weekly or monthly");
  }

  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: input.organizationId },
    select: { paymentMode: true },
  });
  const mode = org.paymentMode === "live" ? "live" : "sandbox";
  assertArcPaymentsAllowed(mode);

  await assertPayStepUp({
    organizationId: input.organizationId,
    actorType: "user",
    actorId: input.actorId,
    amountUsd: convertAmount(input.amountUsdc, "USDC", "USD"),
    mfaCode: input.mfaCode,
  });

  await ensureAgentWallet({
    organizationId: input.organizationId,
    actorType: "user",
    actorId: input.actorId,
  });

  if (!(await isDestinationAllowed(input.organizationId, toAddress))) {
    await addDestination({
      organizationId: input.organizationId,
      address: toAddress,
      label: "Pay client",
      actorId: input.actorId,
    });
  }

  await assertPayTimeGuards({
    organizationId: input.organizationId,
    rail: "arc_usdc",
    amount: input.amountUsdc,
    currency: "USDC",
    arcAddress: toAddress,
  });

  const intent = await createDirectIntent({
    organizationId: input.organizationId,
    toAddress,
    amountUsdc: input.amountUsdc,
    mode,
    source: interval === "once" ? "pay_client" : `pay_client_${interval}`,
  });

  await enqueueAgentTask({
    organizationId: input.organizationId,
    type: "arc_transfer",
    paymentIntentId: intent.id,
    payload: { kind: "direct" },
  });

  let recurring = null;
  if (interval !== "once") {
    recurring = await prisma.recurringPayout.create({
      data: {
        organizationId: input.organizationId,
        toAddress,
        amount: input.amountUsdc,
        currency: "USDC",
        interval,
        nextRunAt: nextRunAt(interval),
        active: true,
        lastIntentId: intent.id,
      },
    });
  }

  await writeAudit({
    organizationId: input.organizationId,
    actorType: "user",
    actorId: input.actorId,
    action: "payment.pay_client",
    entityType: "payment_intent",
    entityId: intent.id,
    metadata: { toAddress, amount: input.amountUsdc, interval, recurringId: recurring?.id },
  });

  return { intent, recurring };
}

async function createDirectIntent(input: {
  organizationId: string;
  toAddress: string;
  amountUsdc: number;
  mode: "live" | "sandbox";
  source: string;
}) {
  return prisma.paymentIntent.create({
    data: {
      organizationId: input.organizationId,
      invoiceId: null,
      kind: "direct",
      idempotencyKey: `direct_${input.organizationId}_${input.toAddress}_${Date.now()}`,
      status: "queued",
      rail: "arc_usdc",
      amount: input.amountUsdc,
      currency: "USDC",
      beneficiaryJson: JSON.stringify({
        arcAddress: input.toAddress,
        vendorName: "Pay client",
        source: input.source,
      }),
      mode: input.mode,
    },
  });
}

export async function runDueRecurringPayouts() {
  const due = await prisma.recurringPayout.findMany({
    where: { active: true, nextRunAt: { lte: new Date() } },
    take: 40,
    orderBy: { nextRunAt: "asc" },
  });
  const results: Array<{ id: string; ok: boolean; error?: string }> = [];

  for (const row of due) {
    try {
      const org = await prisma.organization.findUniqueOrThrow({
        where: { id: row.organizationId },
        select: { paymentMode: true, agentWalletFrozen: true },
      });
      if (org.agentWalletFrozen) {
        throw new Error("Agent wallet is frozen");
      }
      const mode = org.paymentMode === "live" ? "live" : "sandbox";
      assertArcPaymentsAllowed(mode);
      await assertPayTimeGuards({
        organizationId: row.organizationId,
        rail: "arc_usdc",
        amount: row.amount,
        currency: row.currency,
        arcAddress: row.toAddress,
      });
      const intent = await createDirectIntent({
        organizationId: row.organizationId,
        toAddress: row.toAddress,
        amountUsdc: row.amount,
        mode,
        source: `recurring_${row.interval}`,
      });
      await enqueueAgentTask({
        organizationId: row.organizationId,
        type: "arc_transfer",
        paymentIntentId: intent.id,
        payload: { kind: "direct", recurringPayoutId: row.id },
      });
      await prisma.recurringPayout.update({
        where: { id: row.id },
        data: { nextRunAt: nextRunAt(row.interval), lastIntentId: intent.id },
      });
      await writeAudit({
        organizationId: row.organizationId,
        actorType: "system",
        action: "payment.recurring_payout",
        entityType: "payment_intent",
        entityId: intent.id,
        metadata: { recurringPayoutId: row.id },
      });
      results.push({ id: row.id, ok: true });
    } catch (e) {
      results.push({ id: row.id, ok: false, error: e instanceof Error ? e.message : "failed" });
      await prisma.recurringPayout.update({
        where: { id: row.id },
        data: { nextRunAt: nextRunAt(row.interval) },
      });
    }
  }

  return results;
}
