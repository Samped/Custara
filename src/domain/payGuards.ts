import { prisma } from "@/lib/db";
import { loadPolicyRules } from "@/domain/policy";
import { assertSpendLimits } from "@/domain/arc/allowlist";
import { screenDestination, screenPayAddress } from "@/domain/screening";

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

  // Stale destination_not_allowlisted is ignored when pay-time allowlist check will pass.
  const hard = invoice.risks.filter((r) => {
    if (r.severity !== "hard") return false;
    if (r.code === "destination_not_allowlisted" && input.rail === "arc_usdc" && input.arcAddress) {
      return false;
    }
    return true;
  });
  if (hard.length) {
    throw new Error(
      `Pay blocked: hard risks still present (${hard.map((r) => r.code).join(", ")})`,
    );
  }

  const rules = await loadPolicyRules(input.organizationId);
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
    await assertSpendLimits(input.organizationId, input.amount);

    const agent = await prisma.orgWallet.findFirst({
      where: {
        organizationId: input.organizationId,
        role: "agent",
        status: "active",
      },
    });
    if (!agent) throw new Error("Pay blocked: agent wallet not provisioned");
    if (agent.balanceUsdc != null && agent.balanceUsdc < input.amount) {
      throw new Error(
        `Pay blocked: agent wallet balance ${agent.balanceUsdc} USDC < ${input.amount}`,
      );
    }
  }
}
