import { z } from "zod";

export const extractionSchema = z.object({
  vendorName: z.string().min(1),
  invoiceNumber: z.string().min(1),
  issueDate: z.string().optional().nullable(),
  dueDate: z.string().optional().nullable(),
  currency: z.string().default("NGN"),
  subtotal: z.number().nonnegative().optional().nullable(),
  taxAmount: z.number().nonnegative().optional().nullable(),
  totalAmount: z.number().nonnegative(),
  poNumber: z.string().optional().nullable(),
  accountName: z.string().optional().nullable(),
  accountNumber: z.string().optional().nullable(),
  bankName: z.string().optional().nullable(),
  bankCode: z.string().optional().nullable(),
  arcAddress: z.string().optional().nullable(),
  lineItems: z
    .array(
      z.object({
        description: z.string(),
        quantity: z.number().optional(),
        unitPrice: z.number().optional(),
        amount: z.number(),
      }),
    )
    .default([]),
  confidence: z.number().min(0).max(1).default(0.85),
});

export type Extraction = z.infer<typeof extractionSchema>;

export const invoiceStatuses = [
  "received",
  "extracting",
  "needs_review",
  "pending_approval",
  "approved",
  "payment_queued",
  "payment_sent",
  "payment_failed",
  "settled",
  "reconciled",
  "rejected",
  "on_hold",
  "duplicate_suspected",
] as const;

export type InvoiceStatus = (typeof invoiceStatuses)[number];

export type PolicyRules = {
  autoApproveMax: number;
  /** Separate USDC/USD auto-approve ceiling (Arc rail). Defaults to autoApproveMax when unset. */
  autoApproveMaxUsdc?: number;
  singleApproverMax: number;
  dualControlAbove: number;
  currency: string;
  holdOnNewVendor: boolean;
  holdOnBankChange: boolean;
  holdOnDuplicate: boolean;
  /** PayablesAI strict: require matched open PO when invoice has poNumber */
  requirePoMatch?: boolean;
  /** Hold invoices that have no purchase order. */
  requirePurchaseOrder?: boolean;
  /** Hold when Arc destination is not allowlisted */
  holdOnUnknownDestination?: boolean;
  /** Block auto-approve when invoice has an Arc address until allowlisted */
  blockAutoApproveUntilAllowlisted?: boolean;
  /** Minimum extraction confidence for auto-approve (default 0.6) */
  minConfidenceForAutoApprove?: number;
};

export const PAYABLESAI_STRICT_RULES: PolicyRules = {
  autoApproveMax: 25000,
  autoApproveMaxUsdc: 5000,
  singleApproverMax: 250000,
  dualControlAbove: 250000,
  currency: "NGN",
  holdOnNewVendor: true,
  holdOnBankChange: true,
  holdOnDuplicate: true,
  requirePoMatch: true,
  requirePurchaseOrder: true,
  holdOnUnknownDestination: true,
  blockAutoApproveUntilAllowlisted: true,
  minConfidenceForAutoApprove: 0.75,
};
