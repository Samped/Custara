import { prisma } from "@/lib/db";
import { arcExplorerTxUrl, isSimulatedIntent } from "@/domain/receipts";

export const NETWORK_LEDGER_PREVIEW = 100;

export async function getPublicNetworkLedger(options?: { all?: boolean }) {
  const all = Boolean(options?.all);
  const [intents, total] = await Promise.all([
    prisma.paymentIntent.findMany({
      orderBy: { createdAt: "desc" },
      ...(all ? {} : { take: NETWORK_LEDGER_PREVIEW }),
      select: {
        id: true,
        amount: true,
        currency: true,
        status: true,
        txHash: true,
        createdAt: true,
        mode: true,
        circleTxId: true,
        providerRef: true,
      },
    }),
    prisma.paymentIntent.count(),
  ]);

  const rows = intents.map((intent) => {
    const simulated = isSimulatedIntent(intent);
    const onChain = Boolean(intent.txHash?.startsWith("0x")) && !simulated;
    return {
      id: intent.id,
      amount: intent.amount,
      currency: intent.currency,
      status: intent.status,
      createdAt: intent.createdAt,
      onChain,
      txHash: onChain ? intent.txHash : null,
      explorerUrl: onChain && intent.txHash ? arcExplorerTxUrl(intent.txHash) : null,
    };
  });

  return { rows, total };
}
