import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { orgNeedsOnboarding } from "@/domain/onboarding";

export default async function AppSectionLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = (await headers()).get("x-pathname") || "";
  const onOnboarding = pathname.startsWith("/app/onboarding");
  const user = await getSessionUser();

  if (user) {
    const needs = await orgNeedsOnboarding(user.organizationId);
    if (needs && !onOnboarding) redirect("/app/onboarding");
    if (!needs && onOnboarding) redirect("/app");
  }

  return children;
}
