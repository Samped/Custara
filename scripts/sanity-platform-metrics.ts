import { prisma } from "../src/lib/db";
import {
  isVerifiedBusiness,
  isValidWebsite,
  isValidSocialUrl,
} from "../src/lib/businessPresence";
import { getPlatformMetrics } from "../src/domain/platformMetrics";
import { isPlatformOperator } from "../src/lib/platformAdmin";

async function main() {
  console.log("presence", {
    goodSite: isValidWebsite("acme.com"),
    badLocal: isValidWebsite("http://localhost"),
    goodSocial: isValidSocialUrl("linkedin.com/company/acme"),
    badSocial: isValidSocialUrl("https://acme.com"),
  });

  const orgs = await prisma.organization.findMany({
    select: {
      id: true,
      name: true,
      onboardingCompletedAt: true,
      website: true,
      socialUrl: true,
    },
  });
  console.log(
    "orgs",
    orgs.length,
    orgs.map((o) => ({
      name: o.name,
      onboarded: !!o.onboardingCompletedAt,
      verified: isVerifiedBusiness(o),
      website: o.website,
      socialUrl: o.socialUrl,
    })),
  );

  const onboarded = orgs.filter((o) => o.onboardingCompletedAt);
  if (onboarded[0] && !isVerifiedBusiness(onboarded[0])) {
    await prisma.organization.update({
      where: { id: onboarded[0].id },
      data: { website: "https://acme.example.com" },
    });
    console.log("patched", onboarded[0].name, "with website");
  }
  if (onboarded[1]) {
    await prisma.organization.update({
      where: { id: onboarded[1].id },
      data: { website: null, socialUrl: null },
    });
    console.log("cleared presence on", onboarded[1].name);
  }

  const m = await getPlatformMetrics();
  console.log("metrics", {
    businessesRegistered: m.businessesRegistered,
    verifiedBusinesses: m.verifiedBusinesses,
    invoicesProcessed: m.invoicesProcessed,
    invoicesSettled: m.invoicesSettled,
    transactionsTotal: m.transactionsTotal,
    duplicatesDetected: m.duplicatesDetected,
    settledVolumeUsd: Math.round(m.settledVolumeUsd * 100) / 100,
    successRate: m.successRate,
    openCount: m.openCount,
    needsReviewCount: m.needsReviewCount,
    invoiceSeriesSum: m.series.invoices.reduce((a, p) => a + p.count, 0),
    settlementSeriesSum: m.series.settlements.reduce((a, p) => a + p.count, 0),
  });

  process.env.PLATFORM_ADMIN_EMAILS = "ops@custara.xyz, admin@example.com";
  console.log("operator gate", {
    yes: isPlatformOperator("ops@custara.xyz"),
    no: isPlatformOperator("tenant@acme.com"),
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
