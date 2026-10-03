import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";

export async function upsertVendorPurchaseOrder(input: {
  organizationId: string;
  actorId: string;
  vendorId: string;
  poNumber: string;
  amount?: number | null;
  currency?: string;
  label?: string | null;
}) {
  const poNumber = input.poNumber.trim();
  if (!poNumber) throw new Error("PO number required");

  const vendor = await prisma.vendor.findFirst({
    where: { id: input.vendorId, organizationId: input.organizationId },
  });
  if (!vendor) throw new Error("Vendor not found");

  const po = await prisma.vendorPurchaseOrder.upsert({
    where: {
      organizationId_poNumber: {
        organizationId: input.organizationId,
        poNumber,
      },
    },
    create: {
      organizationId: input.organizationId,
      vendorId: vendor.id,
      poNumber,
      amount: input.amount ?? null,
      currency: (input.currency || "NGN").toUpperCase(),
      label: input.label?.trim() || null,
      status: "open",
    },
    update: {
      vendorId: vendor.id,
      amount: input.amount ?? null,
      currency: (input.currency || "NGN").toUpperCase(),
      label: input.label?.trim() || null,
      status: "open",
    },
  });

  await writeAudit({
    organizationId: input.organizationId,
    actorType: "user",
    actorId: input.actorId,
    action: "vendor.po_upserted",
    entityType: "vendor_purchase_order",
    entityId: po.id,
    metadata: { poNumber, vendorId: vendor.id, amount: po.amount },
  });

  return po;
}

export async function listVendorPurchaseOrders(organizationId: string, vendorId?: string) {
  return prisma.vendorPurchaseOrder.findMany({
    where: {
      organizationId,
      ...(vendorId ? { vendorId } : {}),
      status: "open",
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
}

/** Compare extracted PO against stored vendor PO / contract lines. */
export async function matchPurchaseOrder(input: {
  organizationId: string;
  vendorId: string;
  vendorName: string;
  poNumber: string | null | undefined;
  totalAmount: number;
  currency: string;
}): Promise<
  Array<{
    code: string;
    severity: "low" | "medium" | "hard";
    message: string;
    evidence?: Record<string, unknown>;
  }>
> {
  const poNumber = (input.poNumber || "").trim();
  if (!poNumber) return [];

  const po = await prisma.vendorPurchaseOrder.findUnique({
    where: {
      organizationId_poNumber: {
        organizationId: input.organizationId,
        poNumber,
      },
    },
    include: { vendor: { select: { id: true, name: true } } },
  });

  if (!po || po.status !== "open") {
    return [
      {
        code: "po_unknown",
        severity: "medium",
        message: `PO ${poNumber} is not on file for this workspace.`,
        evidence: { poNumber },
      },
    ];
  }

  const risks: Array<{
    code: string;
    severity: "low" | "medium" | "hard";
    message: string;
    evidence?: Record<string, unknown>;
  }> = [];

  if (po.vendorId !== input.vendorId) {
    risks.push({
      code: "po_vendor_mismatch",
      severity: "hard",
      message: `PO ${poNumber} belongs to vendor "${po.vendor.name}", not "${input.vendorName}".`,
      evidence: {
        poNumber,
        expectedVendorId: po.vendorId,
        invoiceVendorId: input.vendorId,
      },
    });
  }

  if (po.amount != null && Number.isFinite(po.amount)) {
    const currencyMatch =
      !po.currency || po.currency.toUpperCase() === (input.currency || "").toUpperCase();
    if (!currencyMatch) {
      risks.push({
        code: "po_currency_mismatch",
        severity: "medium",
        message: `PO ${poNumber} currency is ${po.currency}; invoice is ${input.currency}.`,
        evidence: { poCurrency: po.currency, invoiceCurrency: input.currency },
      });
    }
    // Allow 1% tolerance for tax/rounding
    const max = po.amount * 1.01;
    if (input.totalAmount > max) {
      risks.push({
        code: "po_amount_mismatch",
        severity: "hard",
        message: `Invoice total ${input.totalAmount} exceeds PO ${poNumber} amount ${po.amount}.`,
        evidence: { poAmount: po.amount, invoiceAmount: input.totalAmount },
      });
    }
  }

  return risks;
}
