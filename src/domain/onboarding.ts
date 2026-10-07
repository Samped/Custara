import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { nanoid } from "nanoid";
import { defaultIngestEmailForSlug } from "@/domain/mailbox";
import { currencyFromCountry } from "@/lib/currency";

export const BUSINESS_TYPES = [
  { value: "company", label: "Company" },
  { value: "startup", label: "Startup" },
  { value: "sole_trader", label: "Sole trader / freelancer" },
  { value: "nonprofit", label: "Nonprofit" },
  { value: "other", label: "Other" },
] as const;

export function slugifyCompanyName(name: string) {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 28) || "company";
  return `${base}-${nanoid(4)}`.toLowerCase();
}

export async function orgNeedsOnboarding(organizationId: string) {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { onboardingCompletedAt: true },
  });
  return !org?.onboardingCompletedAt;
}

export async function completeCompanyOnboarding(input: {
  organizationId: string;
  actorId: string;
  name: string;
  legalName?: string;
  businessType: string;
  industry?: string;
  country?: string;
  website?: string;
}) {
  const name = input.name.trim();
  if (name.length < 2) throw new Error("Company name is required");

  const allowed = new Set(BUSINESS_TYPES.map((t) => t.value));
  if (!allowed.has(input.businessType as (typeof BUSINESS_TYPES)[number]["value"])) {
    throw new Error("Select a business type");
  }

  let website = (input.website || "").trim();
  if (website && !/^https?:\/\//i.test(website)) {
    website = `https://${website}`;
  }

  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: input.organizationId },
    select: { slug: true, onboardingCompletedAt: true },
  });

  // Keep existing slug unless still a JIT placeholder pattern (email-local-nanoid).
  let slug = org.slug;
  if (!org.onboardingCompletedAt) {
    slug = slugifyCompanyName(name);
    const clash = await prisma.organization.findFirst({
      where: { slug, NOT: { id: input.organizationId } },
      select: { id: true },
    });
    if (clash) slug = slugifyCompanyName(`${name}-${nanoid(2)}`);
  }

  const country = (input.country || "").trim().toUpperCase().slice(0, 2) || null;
  // Location sets the dashboard default currency; no location → USD.
  const displayCurrency = currencyFromCountry(country);

  const updated = await prisma.organization.update({
    where: { id: input.organizationId },
    data: {
      name,
      slug,
      legalName: (input.legalName || "").trim() || null,
      businessType: input.businessType,
      industry: (input.industry || "").trim() || null,
      country,
      displayCurrency,
      website: website || null,
      onboardingCompletedAt: new Date(),
      ingestEmail: defaultIngestEmailForSlug(slug),
    },
  });

  await writeAudit({
    organizationId: input.organizationId,
    actorType: "user",
    actorId: input.actorId,
    action: "org.onboarding_completed",
    entityType: "organization",
    entityId: input.organizationId,
    metadata: {
      name: updated.name,
      businessType: updated.businessType,
      country: updated.country,
      displayCurrency: updated.displayCurrency,
    },
  });

  return updated;
}
