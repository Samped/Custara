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

export type PayAddressRisk = {
  code: string;
  severity: "hard";
  message: string;
  evidence?: Record<string, unknown>;
};

/**
 * Allowlist plus optional ADDRESS_SCREEN_URL.
 * Risk assessment records the risks. Pay blocks when `blocked` is true.
 * Live mode with a screen URL treats an unreachable screener as a deny.
 * Sandbox without the URL stays allowlist-only.
 */
export async function screenPayAddress(input: {
  organizationId: string;
  address: string;
}): Promise<{ risks: PayAddressRisk[]; blocked: boolean }> {
  const raw = input.address.trim().toLowerCase();
  const valid = /^0x[a-f0-9]{40}$/.test(raw);
  if (!valid) {
    return {
      blocked: true,
      risks: [
        {
          code: "address_screen_failed",
          severity: "hard",
          message: "Pay address is not a valid destination.",
          evidence: { address: raw },
        },
      ],
    };
  }

  const org = await prismaOrganizationMode(input.organizationId);
  const risks: PayAddressRisk[] = [];
  const allowed = await prismaAllowlisted(input.organizationId, raw);
  if (!allowed) {
    risks.push({
      code: "destination_not_allowlisted",
      severity: "hard",
      message: `Vendor wallet ${raw} is new to this workspace — confirm the destination on this invoice before paying.`,
      evidence: { address: raw },
    });
  }

  const url = process.env.ADDRESS_SCREEN_URL?.trim();
  if (!url) {
    return { risks, blocked: risks.length > 0 };
  }

  let denied = false;
  let unreachable = false;
  let reason = "Address screening denied this destination.";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: raw, organization_id: input.organizationId }),
      signal: AbortSignal.timeout(8_000),
    });
    const body = (await res.json().catch(() => ({}))) as {
      cleared?: boolean;
      decision?: string;
      reason?: string;
    };
    const decision = (body.decision || "").toLowerCase();
    if (!res.ok || body.cleared === false || decision === "deny") {
      denied = true;
      reason = body.reason || `Address screening denied this destination (HTTP ${res.status}).`;
    }
  } catch {
    unreachable = true;
    reason = "Address screening could not be reached.";
  }

  if (denied || (unreachable && org.live)) {
    risks.push({
      code: "address_screen_failed",
      severity: "hard",
      message: reason,
      evidence: { address: raw, unreachable },
    });
    await writeAudit({
      organizationId: input.organizationId,
      actorType: "system",
      action: "screening.denied",
      entityType: "destination",
      entityId: raw,
      metadata: { provider: "address_screen_url", reason, unreachable },
    });
  }

  const blocked = risks.some((r) => r.code === "destination_not_allowlisted" || r.code === "address_screen_failed");
  return { risks, blocked };
}

async function prismaOrganizationMode(organizationId: string) {
  const { prisma } = await import("@/lib/db");
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { paymentMode: true },
  });
  return { live: org?.paymentMode === "live" };
}

async function prismaAllowlisted(organizationId: string, address: string) {
  const { prisma } = await import("@/lib/db");
  const row = await prisma.destinationAllowlist.findFirst({
    where: { organizationId, address, isActive: true, revokedAt: null },
  });
  return Boolean(row);
}
