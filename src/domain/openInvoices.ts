/** Invoices that still need a payment. A queued or sent payment is no longer open. */
export const OPEN_INVOICE_STATUSES = [
  "approved",
  "pending_approval",
  "needs_review",
  "received",
  "extracting",
] as const;
