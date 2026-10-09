import { headers } from "next/headers";

export const dynamic = "force-dynamic";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { orgNeedsOnboarding } from "@/domain/onboarding";
import { userNeedsMfaPrompt } from "@/lib/mfa";

export default async function AppSectionLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = (await headers()).get("x-pathname") || "";
  const onCompanyOnboarding = pathname === "/app/onboarding" || pathname === "/app/onboarding/";
  const onMfaOnboarding = pathname.startsWith("/app/onboarding/mfa");
  const user = await getSessionUser();

  if (user) {
    const needsCompany = await orgNeedsOnboarding(user.organizationId);

    if (needsCompany && !onCompanyOnboarding) {
      redirect("/app/onboarding");
    }

    if (!needsCompany && onCompanyOnboarding) {
      const needsMfaPrompt = await userNeedsMfaPrompt(user.id);
      redirect(needsMfaPrompt ? "/app/onboarding/mfa" : "/app");
    }

    if (!needsCompany && !onMfaOnboarding) {
      const needsMfaPrompt = await userNeedsMfaPrompt(user.id);
      if (needsMfaPrompt) redirect("/app/onboarding/mfa");
    }
  }

  return children;
}
