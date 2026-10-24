import { prisma } from "@/lib/db";
import type { Extraction } from "@/lib/types";
import { decryptField, encryptField, last4 } from "@/lib/crypto";

export type RiskItem = {
  code: string;
  severity: "low" | "medium" | "hard";
  message: string;
  evidence?: Record<string, unknown>;
};

export async function assessRisks(
  organizationId: string,
  invoiceId: string,
  extraction: Extraction,
): Promise<{ risks: RiskItem[]; vendorId: string | null; bankChanged: boolean; isNewVendor: boolean }> {
  const risks: RiskItem[] = [];

  let vendor = await prisma.vendor.findFirst({
    where: {
      organizationId,
      name: { equals: extraction.vendorName },
    },
    include: { endpoints: { where: { isActive: true }, orderBy: { version: "desc" } } },
  });

  let isNewVendor = false;
  if (!vendor) {
    vendor = await prisma.vendor.create({
      data: {
        organizationId,
        name: extraction.vendorName,
        isNew: true,
        endpoints:
          extraction.arcAddress
            ? {
                create: {
                  endpointType: "arc_usdc",
                  accountName: extraction.accountName || extraction.vendorName,
                  accountNumberEncrypted: "",
                  accountNumberLast4: "",
                  arcAddress: extraction.arcAddress.toLowerCase(),
                  currency: extraction.currency === "USD" ? "USDC" : extraction.currency,
                  version: 1,
                  isActive: true,
                },
              }
            : extraction.accountNumber && extraction.accountName
              ? {
                  create: {
                    endpointType: "bank",
                    accountName: extraction.accountName,
                    accountNumberEncrypted: encryptField(extraction.accountNumber),
                    accountNumberLast4: last4(extraction.accountNumber),
                    bankName: extraction.bankName || null,
                    bankCode: extraction.bankCode || null,
                    currency: extraction.currency,
                    version: 1,
                    isActive: true,
                  },
                }
              : undefined,
      },
      include: { endpoints: { where: { isActive: true }, orderBy: { version: "desc" } } },
    });
    isNewVendor = true;
  }

  await prisma.invoice.update({
    where: { id: invoiceId },
    data: { vendorId: vendor.id },
  });

  if (vendor.isNew || isNewVendor) {
    risks.push({
      code: "new_vendor",
      severity: "hard",
      message: `Vendor "${extraction.vendorName}" is new and requires human verification.`,
      evidence: { vendorId: vendor.id },
    });
  }

  const self = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: { sourceBatchId: true },
  });
  const siblingBatch = self?.sourceBatchId || null;
  const notSibling = siblingBatch
    ? { OR: [{ sourceBatchId: null }, { sourceBatchId: { not: siblingBatch } }] }
    : {};

  const duplicate = await prisma.invoice.findFirst({
    where: {
      organizationId,
      id: { not: invoiceId },
      invoiceNumber: extraction.invoiceNumber,
      vendorId: vendor.id,
      status: { notIn: ["rejected"] },
      ...notSibling,
    },
  });

  if (duplicate) {
    risks.push({
      code: "duplicate_invoice",
      severity: "hard",
      message: `Possible duplicate of invoice ${duplicate.id} with number ${extraction.invoiceNumber}.`,
      evidence: { duplicateInvoiceId: duplicate.id },
    });
  }

  // Same-bytes document across invoices. An unread file is not a duplicate of another unread file.
  const unread =
    extraction.totalAmount <= 0 &&
    (!extraction.vendorName || /^unknown\b/i.test(extraction.vendorName)) &&
    (extraction.confidence < 0.4 || extraction.invoiceNumber.startsWith("UNK-"));
  const docs = unread
    ? []
    : await prisma.invoiceDocument.findMany({
    where: { invoiceId, deletedAt: null, checksumSha256: { not: null } },
    select: { checksumSha256: true, filename: true },
  });
  for (const doc of docs) {
    if (!doc.checksumSha256) continue;
    const collision = await prisma.invoiceDocument.findFirst({
      where: {
        checksumSha256: doc.checksumSha256,
        deletedAt: null,
        invoiceId: { not: invoiceId },
        invoice: {
          organizationId,
          status: { notIn: ["rejected"] },
          ...(siblingBatch
            ? { OR: [{ sourceBatchId: null }, { sourceBatchId: { not: siblingBatch } }] }
            : {}),
        },
      },
      select: { invoiceId: true, filename: true },
    });
    if (collision) {
      risks.push({
        code: "duplicate_document_checksum",
        severity: "hard",
        message: `Identical file previously ingested on invoice ${collision.invoiceId} (${collision.filename}).`,
        evidence: { checksum: doc.checksumSha256, otherInvoiceId: collision.invoiceId },
      });
      break;
    }
  }

  // Fuzzy duplicate: same vendor + amount + due date within 3 days
  if (extraction.totalAmount > 0) {
    const due = extraction.dueDate ? new Date(extraction.dueDate) : null;
    const windowStart = due ? new Date(due.getTime() - 3 * 864e5) : null;
    const windowEnd = due ? new Date(due.getTime() + 3 * 864e5) : null;
    const fuzzy = await prisma.invoice.findFirst({
      where: {
        organizationId,
        id: { not: invoiceId },
        vendorId: vendor.id,
        totalAmount: extraction.totalAmount,
        status: { notIn: ["rejected"] },
        ...(windowStart && windowEnd
          ? { dueDate: { gte: windowStart, lte: windowEnd } }
          : {}),
        invoiceNumber: { not: extraction.invoiceNumber },
        ...notSibling,
      },
    });
    if (fuzzy) {
      risks.push({
        code: "fuzzy_duplicate",
        severity: "hard",
        message: `Similar invoice ${fuzzy.id} has same vendor/amount` +
          (due ? " and nearby due date" : "") +
          ".",
        evidence: { otherInvoiceId: fuzzy.id },
      });
    }
  }

  if (extraction.arcAddress) {
    const { screenPayAddress } = await import("@/domain/screening");
    const screen = await screenPayAddress({
      organizationId,
      address: extraction.arcAddress,
    });
    risks.push(...screen.risks);
  }

  let bankChanged = false;
  const bankActive = vendor.endpoints.find((e) => e.endpointType === "bank") || null;
  const arcActive = vendor.endpoints.find((e) => e.endpointType === "arc_usdc") || null;

  if (extraction.arcAddress) {
    const next = extraction.arcAddress.toLowerCase();
    if (arcActive?.arcAddress && arcActive.arcAddress.toLowerCase() !== next) {
      bankChanged = true;
      risks.push({
        code: "arc_address_change",
        severity: "hard",
        message: `Vendor Arc address changed from ${arcActive.arcAddress} to ${next}.`,
        evidence: { previous: arcActive.arcAddress, next },
      });
      await prisma.vendorPaymentEndpoint.updateMany({
        where: { vendorId: vendor.id, endpointType: "arc_usdc", isActive: true },
        data: { isActive: false },
      });
      await prisma.vendorPaymentEndpoint.create({
        data: {
          vendorId: vendor.id,
          endpointType: "arc_usdc",
          version: (arcActive.version || 1) + 1,
          accountName: extraction.accountName || extraction.vendorName,
          arcAddress: next,
          currency: extraction.currency === "USD" ? "USDC" : extraction.currency,
          isActive: true,
        },
      });
    } else if (!arcActive) {
      await prisma.vendorPaymentEndpoint.create({
        data: {
          vendorId: vendor.id,
          endpointType: "arc_usdc",
          version: 1,
          accountName: extraction.accountName || extraction.vendorName,
          arcAddress: next,
          currency: extraction.currency === "USD" ? "USDC" : extraction.currency,
          isActive: true,
        },
      });
    }
  }

  if (extraction.accountNumber) {
    const active = bankActive;
    if (active) {
      const existingAccount = decryptField(active.accountNumberEncrypted);
      if (existingAccount !== extraction.accountNumber) {
        bankChanged = true;
        risks.push({
          code: "bank_detail_change",
          severity: "hard",
          message: `Bank account changed from ••••${active.accountNumberLast4} to ••••${last4(extraction.accountNumber)}.`,
          evidence: {
            previousLast4: active.accountNumberLast4,
            nextLast4: last4(extraction.accountNumber),
          },
        });

        await prisma.vendorPaymentEndpoint.updateMany({
          where: { vendorId: vendor.id, endpointType: "bank", isActive: true },
          data: { isActive: false },
        });
        await prisma.vendorPaymentEndpoint.create({
          data: {
            vendorId: vendor.id,
            endpointType: "bank",
            version: (active.version || 1) + 1,
            accountName: extraction.accountName || active.accountName,
            accountNumberEncrypted: encryptField(extraction.accountNumber),
            accountNumberLast4: last4(extraction.accountNumber),
            bankName: extraction.bankName || active.bankName,
            bankCode: extraction.bankCode || active.bankCode,
            currency: extraction.currency,
            isActive: true,
          },
        });
      }
    } else {
      await prisma.vendorPaymentEndpoint.create({
        data: {
          vendorId: vendor.id,
          endpointType: "bank",
          version: 1,
          accountName: extraction.accountName || extraction.vendorName,
          accountNumberEncrypted: encryptField(extraction.accountNumber),
          accountNumberLast4: last4(extraction.accountNumber),
          bankName: extraction.bankName || null,
          bankCode: extraction.bankCode || null,
          currency: extraction.currency,
          isActive: true,
        },
      });
    }
  }

  if (extraction.confidence < 0.6) {
    risks.push({
      code: "low_confidence",
      severity: "hard",
      message: `Extraction confidence is low (${extraction.confidence.toFixed(2)}).`,
    });
  }

  if (extraction.odooMoveType === "in_refund") {
    risks.push({
      code: "odoo_credit_note",
      severity: "hard",
      message: "This Odoo document is a vendor credit. Do not pay it; apply it to an open bill.",
      evidence: { moveType: extraction.odooMoveType },
    });
  }
  if (extraction.odooPaymentState === "paid" || (extraction.odooResidual != null && extraction.odooResidual <= 0.01)) {
    risks.push({
      code: "odoo_already_paid",
      severity: "hard",
      message: "Odoo already shows this bill as paid. Custara will not pay it again.",
      evidence: { paymentState: extraction.odooPaymentState, residual: extraction.odooResidual },
    });
  }
  if (extraction.odooState === "draft") {
    risks.push({
      code: "odoo_draft",
      severity: "medium",
      message: "This bill is still a draft in Odoo. Approving in Custara will post it there.",
      evidence: { state: extraction.odooState },
    });
  }
  const current = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: { creditWaivedAt: true, creditApplied: true, fiscalPeriodLocked: true },
  });
  if (vendor && extraction.odooMoveType !== "in_refund" && !current?.creditWaivedAt && (current?.creditApplied || 0) <= 0.01) {
    const openCredit = await prisma.invoice.findFirst({
      where: {
        organizationId,
        vendorId: vendor.id,
        externalId: { startsWith: "odoo-refund:" },
        status: { notIn: ["void", "reconciled", "rejected"] },
      },
      select: { id: true, externalId: true, invoiceNumber: true },
    });
    if (openCredit) {
      risks.push({
        code: "odoo_open_credit",
        severity: "hard",
        message: `Vendor has an open credit (${openCredit.invoiceNumber || openCredit.externalId}). Apply or waive it before paying.`,
        evidence: { creditInvoiceId: openCredit.id, creditExternalId: openCredit.externalId },
      });
    }
  }
  if (current?.fiscalPeriodLocked) {
    risks.push({
      code: "odoo_fiscal_lock",
      severity: "hard",
      message: "Odoo fiscal period is locked for this bill.",
    });
  }
  if (vendor && extraction.lineItems?.length) {
    const prices = await prisma.vendorSupplierPrice.findMany({ where: { vendorId: vendor.id } });
    for (const line of extraction.lineItems) {
      const product = (line.product || line.description || "").trim();
      const unit = Number(line.unitPrice || 0);
      const agreed = prices.find((p) => p.product.toLowerCase() === product.toLowerCase());
      if (agreed && unit > agreed.maxUnitPrice * 1.01) {
        risks.push({
          code: "vendor_price_over",
          severity: "hard",
          message: `${product} is ${unit} vs agreed ${agreed.maxUnitPrice} ${agreed.currency}.`,
          evidence: { product, unit, maxUnitPrice: agreed.maxUnitPrice },
        });
      }
    }
  }
  if (extraction.totalAmount <= 0) {
    risks.push({
      code: "amount_invalid",
      severity: "hard",
      message: "Invoice total is missing or zero.",
    });
  }

  const { loadPolicyRules } = await import("@/domain/policy");
  const { matchPurchaseOrder } = await import("@/domain/contracts");
  const policyRules = await loadPolicyRules(organizationId);
  if (policyRules.requireAnalyticApproval) {
    const names = (policyRules.analyticApprovalNames || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const analytics = (extraction.lineItems || [])
      .map((l) => (l.analytic || "").trim())
      .filter(Boolean);
    const matched = names.length
      ? analytics.filter((a) => names.some((n) => a.toLowerCase().includes(n)))
      : analytics;
    if (matched.length) {
      risks.push({
        code: "analytic_approval",
        severity: "medium",
        message: names.length
          ? `Cost center ${matched[0]} requires approval.`
          : "This bill is coded to a cost center and the policy requires review.",
        evidence: { analytics: matched },
      });
    }
  }
  const billedQty = (extraction.lineItems || [])
    .filter((l) => l.description !== "Tax")
    .reduce((n, l) => n + Number(l.quantity || 0), 0);
  const poRisks = await matchPurchaseOrder({
    organizationId,
    vendorId: vendor.id,
    vendorName: extraction.vendorName,
    poNumber: extraction.poNumber,
    totalAmount: extraction.totalAmount,
    currency: extraction.currency,
    billedQty: billedQty || null,
    requirePurchaseOrder: Boolean(policyRules.requirePurchaseOrder),
  });
  risks.push(...poRisks);

  await prisma.riskAssessment.deleteMany({ where: { invoiceId } });
  if (risks.length) {
    await prisma.riskAssessment.createMany({
      data: risks.map((r) => ({
        invoiceId,
        code: r.code,
        severity: r.severity,
        message: r.message,
        evidenceJson: JSON.stringify(r.evidence ?? {}),
      })),
    });
  }

  return { risks, vendorId: vendor.id, bankChanged, isNewVendor: vendor.isNew || isNewVendor };
}
