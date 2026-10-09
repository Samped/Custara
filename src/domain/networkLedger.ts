import { prisma } from "@/lib/db";
import { arcExplorerTxUrl, isSimulatedIntent } from "@/domain/receipts";

export async function getPublicNetworkLedger() {
  const intents = await prisma.paymentIntent.findMany({
    orderBy: { createdAt: "desc" },
    take: 40,
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
  });

  return intents.map((intent) => {
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
}
