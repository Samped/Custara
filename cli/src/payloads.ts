export function ingestBody(input: {
  fileBody?: Record<string, unknown> | null;
  vendor?: string;
  number?: string;
  amount?: string;
  currency?: string;
  due?: string;
  arcAddress?: string;
  externalId?: string;
}) {
  if (input.fileBody && (input.fileBody.document || input.fileBody.external_id || input.fileBody.sync != null)) {
    return {
      sync: true,
      ...input.fileBody,
    };
  }
  const document = {
    ...(input.fileBody || {}),
    ...(input.vendor ? { vendor_name: input.vendor } : {}),
    ...(input.number ? { invoice_number: input.number } : {}),
    ...(input.amount ? { total_amount: Number(input.amount) } : {}),
    ...(input.currency ? { currency: input.currency } : {}),
    ...(input.due ? { due_date: input.due } : {}),
    ...(input.arcAddress ? { arc_address: input.arcAddress } : {}),
  };
  const currency = input.currency || String(document.currency || "USDC");
  return {
    external_id: input.externalId || input.number || undefined,
    sync: true,
    currency,
    document: { ...document, currency },
  };
}

export function payBody(invoiceId: string, rail = "arc_usdc") {
  return { invoice_id: invoiceId, rail };
}

export function idempotencyKey(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}
