/**
 * Sanctions / address screening plug-in.
 * Default: allowlist-only pass-through. Set SCREENING_PROVIDER=http + SCREENING_API_URL
 * to call an external screener before allowlist-add and pre-pay.
 */
import { writeAudit } from "@/lib/audit";

export type ScreeningResult = {
  cleared: boolean;
  provider: string;
  reason?: string;
  raw?: Record<string, unknown>;
};

export async function screenDestination(input: {
  organizationId: string;
  address: string;
  vendorName?: string | null;
  context: "allowlist_add" | "pre_pay";
}): Promise<ScreeningResult> {
  const provider = (process.env.SCREENING_PROVIDER || "allowlist_only").toLowerCase();
  const address = input.address.trim().toLowerCase();

  if (provider === "http") {
    const url = process.env.SCREENING_API_URL?.trim();
    if (!url) {
      throw new Error("SCREENING_PROVIDER=http requires SCREENING_API_URL");
    }
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.SCREENING_API_KEY
          ? { Authorization: `Bearer ${process.env.SCREENING_API_KEY}` }
          : {}),
      },
      body: JSON.stringify({
        address,
        vendor_name: input.vendorName || null,
        organization_id: input.organizationId,
        context: input.context,
      }),
      signal: AbortSignal.timeout(8_000),
    });
    const body = (await res.json().catch(() => ({}))) as {
      cleared?: boolean;
      reason?: string;
    };
    if (!res.ok || body.cleared === false) {
      const reason = body.reason || `Screening denied (HTTP ${res.status})`;
      await writeAudit({
        organizationId: input.organizationId,
        actorType: "system",
        action: "screening.denied",
        entityType: "destination",
        entityId: address,
        metadata: { context: input.context, provider, reason },
      });
      throw new Error(`Destination screening failed: ${reason}`);
    }
    await writeAudit({
      organizationId: input.organizationId,
      actorType: "system",
      action: "screening.cleared",
      entityType: "destination",
      entityId: address,
      metadata: { context: input.context, provider },
    });
    return { cleared: true, provider, raw: body as Record<string, unknown> };
  }

  // allowlist_only — destination must still pass assertDestinationAllowed separately
  return { cleared: true, provider: "allowlist_only" };
}
