import { prisma } from "@/lib/db";
import { PAYABLESAI_STRICT_RULES, type PolicyRules } from "@/lib/types";
import type { RiskItem } from "@/domain/risk";

export type PolicyResult = {
  decision: "auto_approve" | "single_approval" | "dual_control" | "hold" | "reject_duplicate";
  requiredApprovals: number;
  reason: string;
  nextStatus: string;
  policyVersion: number | null;
  policyId: string | null;
};

export async function getActivePolicyVersion(organizationId: string) {
  const policy = await prisma.approvalPolicy.findFirst({
    where: { organizationId, isActive: true },
    include: { versions: { orderBy: { version: "desc" }, take: 1 } },
  });
  if (!policy || !policy.versions[0]) return null;
  return {
    policy,
    version: policy.versions[0],
    rules: JSON.parse(policy.versions[0].rulesJson) as PolicyRules,
  };
}

/** Default rules: Strict when org is live; otherwise classic mid thresholds. */
export async function loadPolicyRules(organizationId: string): Promise<PolicyRules> {
  const active = await getActivePolicyVersion(organizationId);
  if (active) return active.rules;

  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { paymentMode: true },
  });
  if (org?.paymentMode === "live") {
    return { ...PAYABLESAI_STRICT_RULES };
  }
  return {
    autoApproveMax: 50000,
    autoApproveMaxUsdc: 5000,
    singleApproverMax: 500000,
    dualControlAbove: 500000,
    currency: "NGN",
    holdOnNewVendor: true,
    holdOnBankChange: true,
    holdOnDuplicate: true,
    requirePoMatch: false,
    holdOnUnknownDestination: true,
    blockAutoApproveUntilAllowlisted: true,
    minConfidenceForAutoApprove: 0.6,
  };
}

/** When switching to live, ensure a Strict policy version exists if none published. */
export async function ensureStrictPolicyForLive(organizationId: string, createdBy?: string) {
  const active = await getActivePolicyVersion(organizationId);
  if (active) return active;
  const version = await publishPolicyVersion({
    organizationId,
    name: "PayablesAI Strict",
    rules: PAYABLESAI_STRICT_RULES,
    changelog: "Auto-applied Strict defaults for live payment mode",
    createdBy,
  });
  return getActivePolicyVersion(organizationId).then((a) => a || { version });
}

export async function publishPolicyVersion(input: {
  organizationId: string;
  policyId?: string;
  name: string;
  rules: PolicyRules;
  changelog?: string;
  createdBy?: string;
}) {
  const policy =
    input.policyId
      ? await prisma.approvalPolicy.update({
          where: { id: input.policyId },
          data: { name: input.name, isActive: true },
        })
      : await prisma.approvalPolicy.create({
          data: {
            organizationId: input.organizationId,
            name: input.name,
            isActive: true,
          },
        });

  const latest = await prisma.approvalPolicyVersion.findFirst({
    where: { policyId: policy.id },
    orderBy: { version: "desc" },
  });
  const version = (latest?.version || 0) + 1;

  return prisma.approvalPolicyVersion.create({
    data: {
      policyId: policy.id,
      version,
      rulesJson: JSON.stringify(input.rules),
      changelog: input.changelog || `Published v${version}`,
      createdBy: input.createdBy,
    },
  });
}

function autoApproveCeiling(rules: PolicyRules, currency: string) {
  const c = (currency || "").toUpperCase();
  if (c === "USDC" || c === "USD") {
    return rules.autoApproveMaxUsdc ?? rules.autoApproveMax;
  }
  return rules.autoApproveMax;
}

export function evaluatePolicy(input: {
  amount: number;
  currency?: string;
  risks: RiskItem[];
  isNewVendor: boolean;
  bankChanged: boolean;
  rules: PolicyRules;
  hasArcDestination?: boolean;
}): Omit<PolicyResult, "policyVersion" | "policyId"> {
  const hard = input.risks.filter((r) => r.severity === "hard");
  const hasDuplicate = hard.some(
    (r) =>
      r.code === "duplicate_invoice" ||
      r.code === "duplicate_document_checksum" ||
      r.code === "fuzzy_duplicate",
  );
  const hasNewVendor = input.isNewVendor || hard.some((r) => r.code === "new_vendor");
  const hasBankChange =
    input.bankChanged ||
    hard.some((r) => r.code === "bank_detail_change" || r.code === "arc_address_change");
  const hasUnknownDest = hard.some((r) => r.code === "destination_not_allowlisted");
  const hasPoVendorMismatch = hard.some((r) => r.code === "po_vendor_mismatch" || r.code === "po_amount_mismatch");
  const hasPoUnknown = input.risks.some((r) => r.code === "po_unknown");
  const hasLowConfidence = hard.some((r) => r.code === "low_confidence");

  if (hasDuplicate && input.rules.holdOnDuplicate) {
    return {
      decision: "reject_duplicate",
      requiredApprovals: 0,
      reason: "Duplicate suspected — invoice placed on duplicate hold.",
      nextStatus: "duplicate_suspected",
    };
  }
  if (input.rules.holdOnUnknownDestination && hasUnknownDest) {
    return {
      decision: "hold",
      requiredApprovals: 1,
      reason: "Vendor wallet is not allowlisted — confirm destination before approval.",
      nextStatus: "needs_review",
    };
  }
  if (
    input.rules.blockAutoApproveUntilAllowlisted !== false &&
    input.hasArcDestination &&
    hasUnknownDest
  ) {
    return {
      decision: "hold",
      requiredApprovals: 1,
      reason: "Arc destination present but not allowlisted — no auto-approve until allowlisted.",
      nextStatus: "needs_review",
    };
  }
  if (input.rules.requirePoMatch && (hasPoVendorMismatch || hasPoUnknown)) {
    return {
      decision: "hold",
      requiredApprovals: 1,
      reason: hasPoVendorMismatch
        ? "PO vendor/amount mismatch requires review."
        : "Invoice PO is not on file — validate against contract.",
      nextStatus: "needs_review",
    };
  }
  if ((hasNewVendor && input.rules.holdOnNewVendor) || (hasBankChange && input.rules.holdOnBankChange)) {
    return {
      decision: "hold",
      requiredApprovals: 1,
      reason: hasBankChange
        ? "Bank detail change requires mandatory human verification."
        : "New vendor requires mandatory human verification.",
      nextStatus: "needs_review",
    };
  }
  if (hard.some((r) => r.code === "amount_invalid") || hasLowConfidence) {
    return {
      decision: "hold",
      requiredApprovals: 1,
      reason: hasLowConfidence
        ? "Low extraction confidence requires human review."
        : "Invalid amount requires review.",
      nextStatus: "needs_review",
    };
  }

  const ceiling = autoApproveCeiling(input.rules, input.currency || input.rules.currency);
  if (input.amount <= ceiling && !hasNewVendor && !hasBankChange && hard.length === 0) {
    return {
      decision: "auto_approve",
      requiredApprovals: 0,
      reason: `Amount ${input.amount} under auto-approve threshold ${ceiling} (${(input.currency || input.rules.currency).toUpperCase()}) with no hard risks.`,
      nextStatus: "approved",
    };
  }
  if (input.amount <= input.rules.singleApproverMax) {
    return {
      decision: "single_approval",
      requiredApprovals: 1,
      reason: `Amount requires single finance approver (≤ ${input.rules.singleApproverMax}).`,
      nextStatus: "pending_approval",
    };
  }
  return {
    decision: "dual_control",
    requiredApprovals: 2,
    reason: `Amount above ${input.rules.dualControlAbove} requires dual control.`,
    nextStatus: "pending_approval",
  };
}

export async function applyPolicy(input: {
  organizationId: string;
  invoiceId: string;
  amount: number;
  currency?: string;
  risks: RiskItem[];
  isNewVendor: boolean;
  bankChanged: boolean;
  hasArcDestination?: boolean;
}): Promise<PolicyResult> {
  const active = await getActivePolicyVersion(input.organizationId);
  const rules = active?.rules || (await loadPolicyRules(input.organizationId));
  const base = evaluatePolicy({ ...input, rules });

  await prisma.invoice.update({
    where: { id: input.invoiceId },
    data: {
      status: base.nextStatus,
      explanation: base.reason,
      policyVersionId: active?.version.id || null,
    },
  });

  if (base.requiredApprovals > 0) {
    await prisma.approvalRequest.create({
      data: {
        organizationId: input.organizationId,
        invoiceId: input.invoiceId,
        status: "pending",
        requiredCount: base.requiredApprovals,
        reason: base.reason,
        policyVersion: active?.version.version ?? null,
      },
    });
  }

  if (base.decision === "auto_approve") {
    const invoice = await prisma.invoice.findUnique({ where: { id: input.invoiceId } });
    if (invoice?.vendorId) {
      await prisma.vendor.update({
        where: { id: invoice.vendorId },
        data: { isNew: false },
      });
    }
  }

  return {
    ...base,
    policyVersion: active?.version.version ?? null,
    policyId: active?.policy.id ?? null,
  };
}

export function simulatePolicy(input: {
  amount: number;
  currency?: string;
  isNewVendor: boolean;
  bankChanged: boolean;
  duplicate: boolean;
  rules: PolicyRules;
}) {
  const risks: RiskItem[] = [];
  if (input.duplicate) {
    risks.push({ code: "duplicate_invoice", severity: "hard", message: "sim" });
  }
  if (input.isNewVendor) {
    risks.push({ code: "new_vendor", severity: "hard", message: "sim" });
  }
  if (input.bankChanged) {
    risks.push({ code: "bank_detail_change", severity: "hard", message: "sim" });
  }
  return evaluatePolicy({
    amount: input.amount,
    currency: input.currency,
    risks,
    isNewVendor: input.isNewVendor,
    bankChanged: input.bankChanged,
    rules: input.rules,
  });
}
