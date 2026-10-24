import { prisma } from "@/lib/db";
import { dropStaleContractRequired, loadPolicyRules } from "@/domain/policy";
import { assertSpendLimits } from "@/domain/arc/allowlist";
import { getPayingAgentWallet } from "@/domain/arc/wallets";
import { screenDestination, screenPayAddress } from "@/domain/screening";
import { describePlatformFee } from "@/domain/platformFee";

/** Hard risks that still stop pay after approval and the live policy. */
export function payBlockingHardRisks(
  risks: Array<{ code: string; severity: string }>,
  opts: {
    requirePurchaseOrder?: boolean;
    invoiceStatus?: string;
    ignoreDestinationAllowlist?: boolean;
  },
) {
  return risks.filter((r) => {
    if (r.severity !== "hard") return false;
    if (r.code === "destination_not_allowlisted" && opts.ignoreDestinationAllowlist) {
      return false;
    }
    if (r.code === "contract_required") {
      if (!opts.requirePurchaseOrder) return false;
      if (["approved", "payment_queued", "payment_sent"].includes(opts.invoiceStatus || "")) {
        return false;
      }
    }
    return true;
  });
}

/**
 * Pay-time re-checks before creating/executing a payment intent.
 * Fail closed on hard risks, allowlist, confidence, agent balance, and spend limits.
 */
export async function assertPayTimeGuards(input: {
  organizationId: string;
  invoiceId: string;
  rail: string;
  amount: number;
  currency: string;
  arcAddress?: string | null;
}) {
  const invoice = await prisma.invoice.findFirst({
    where: { id: input.invoiceId, organizationId: input.organizationId },
    include: {
      extraction: true,
      risks: true,
    },
  });
  if (!invoice) throw new Error("Invoice not found for pay-time guards");

  const rules = await loadPolicyRules(input.organizationId);
  if (!rules.requirePurchaseOrder) {
    await dropStaleContractRequired(input.organizationId, rules);
  }

  const hard = payBlockingHardRisks(invoice.risks, {
    requirePurchaseOrder: rules.requirePurchaseOrder,
    invoiceStatus: invoice.status,
    ignoreDestinationAllowlist: input.rail === "arc_usdc" && Boolean(input.arcAddress),
  });
  if (hard.length) {
    throw new Error(
      `Pay blocked: hard risks still present (${hard.map((r) => r.code).join(", ")})`,
    );
  }
  const floor = rules.minConfidenceForAutoApprove ?? 0.6;
  const confidence = invoice.extraction?.confidence ?? 0;
  if (confidence < floor) {
    throw new Error(
      `Pay blocked: extraction confidence ${confidence.toFixed(2)} below floor ${floor}`,
    );
  }

  if (input.rail === "arc_usdc") {
    const addr = input.arcAddress;
    if (!addr) throw new Error("Pay blocked: Arc destination missing");
    const screened = await screenPayAddress({
      organizationId: input.organizationId,
      address: addr,
    });
    if (screened.blocked) {
      throw new Error(screened.risks.map((r) => r.message).join(" "));
    }
    await screenDestination({
      organizationId: input.organizationId,
      address: addr,
      context: "pre_pay",
    });
    const { feeAmount, totalDebit } = describePlatformFee(input.amount);
    await assertSpendLimits(input.organizationId, totalDebit);

    const agent = await getPayingAgentWallet(input.organizationId);
    if (!agent) throw new Error("Pay blocked: agent wallet not provisioned");
    if (agent.balanceUsdc != null && agent.balanceUsdc < totalDebit) {
      throw new Error(
        feeAmount > 0
          ? `Pay blocked: agent wallet balance ${agent.balanceUsdc} USDC < ${totalDebit} (vendor ${input.amount} + Custara fee ${feeAmount})`
          : `Pay blocked: agent wallet balance ${agent.balanceUsdc} USDC < ${input.amount}`,
      );
    }
  }
}
