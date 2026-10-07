import { prisma } from "@/lib/db";

export async function listPaymentReceipts(organizationId: string, take = 100) {
  return prisma.paymentIntent.findMany({
    where: { organizationId },
    include: {
      invoice: { include: { vendor: true } },
      agentTasks: { orderBy: { createdAt: "desc" }, take: 1 },
    },
    orderBy: { createdAt: "desc" },
    take,
  });
}

export async function getPaymentReceipt(organizationId: string, paymentIntentId: string) {
  const intent = await prisma.paymentIntent.findFirst({
    where: { id: paymentIntentId, organizationId },
    include: {
      invoice: {
        include: {
          vendor: true,
          risks: { orderBy: { createdAt: "desc" } },
        },
      },
      settlements: { orderBy: { settledAt: "desc" } },
      agentTasks: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!intent) return null;

  const taskIds = intent.agentTasks.map((t) => t.id);
  const auditEvents = await prisma.auditEvent.findMany({
    where: {
      organizationId,
      OR: [
        { entityType: "payment_intent", entityId: intent.id },
        { entityType: "invoice", entityId: intent.invoiceId },
        ...(taskIds.length
          ? [{ entityType: "agent_task" as const, entityId: { in: taskIds } }]
          : []),
        {
          action: { contains: "payment" },
          entityId: intent.invoiceId,
        },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: 80,
  });

  let beneficiary: Record<string, unknown> = {};
  try {
    beneficiary = JSON.parse(intent.beneficiaryJson || "{}") as Record<string, unknown>;
  } catch {
    beneficiary = {};
  }

  const agentWallet = await prisma.orgWallet.findFirst({
    where: { organizationId, role: "agent", status: "active" },
  });

  return { intent, auditEvents, beneficiary, agentWallet };
}

export type PaymentReceipt = NonNullable<Awaited<ReturnType<typeof getPaymentReceipt>>>;

export function arcExplorerTxUrl(txHash: string) {
  return `https://testnet.arcscan.app/tx/${txHash}`;
}

export function isSimulatedIntent(intent: {
  mode: string;
  circleTxId: string | null;
  providerRef: string | null;
}) {
  return (
    intent.mode === "sandbox" ||
    Boolean(intent.circleTxId?.startsWith("sbx_tx_")) ||
    Boolean(intent.providerRef?.startsWith("sbx_"))
  );
}
