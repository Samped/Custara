import { redirect } from "next/navigation";
import { requireSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { BrandLogo } from "@/components/app/BrandLogo";
import { PageAtmosphere } from "@/components/app/GridAtmosphere";
import { MfaEnrollPanel } from "@/components/app/MfaEnrollPanel";
import { BeginMfaForm, ConfirmMfaForm } from "@/components/app/SettingsForms";
import { skipMfaPrompt } from "@/lib/mfa";
import { writeAudit } from "@/lib/audit";

export default async function OnboardingMfaPage({
  searchParams,
}: {
  searchParams: Promise<{ enrollSecret?: string; otpauth?: string; error?: string }>;
}) {
  let user;
  try {
    user = await requireSessionUser();
  } catch {
    redirect("/login");
  }

  const params = await searchParams;
  const me = await prisma.workspaceUser.findUniqueOrThrow({ where: { id: user.id } });

  if (me.mfaEnabled || me.mfaPromptCompletedAt) {
    redirect("/app");
  }

  async function skipMfa() {
    "use server";
    const session = await requireSessionUser();
    await skipMfaPrompt(session.id);
    await writeAudit({
      organizationId: session.organizationId,
      actorType: "user",
      actorId: session.id,
      action: "user.mfa_prompt_skipped",
      entityType: "workspace_user",
      entityId: session.id,
    });
    redirect("/app");
  }

  const enrolling = Boolean(params.enrollSecret && params.otpauth);

  return (
    <PageAtmosphere className="app-shell flex min-h-screen items-center justify-center px-4 py-10">
      <div className="login-panel" style={{ width: "min(480px, 100%)" }}>
        <BrandLogo href={null} size={30} wordmarkClassName="text-[0.95rem]" />
        <h1 className="mt-6 page-title">Set up MFA</h1>
        <p className="mt-2 page-subtitle">Required for payment authorization.</p>

        {params.error ? <p className="mt-4 text-sm text-danger">{params.error}</p> : null}

        {enrolling ? (
          <div className="mt-7 space-y-4">
            <MfaEnrollPanel secret={params.enrollSecret!} otpauth={params.otpauth!} />
            <ConfirmMfaForm redirectTo="/app" />
          </div>
        ) : (
          <div className="mt-7 space-y-3">
            <BeginMfaForm
              redirectBase="/app/onboarding/mfa"
              buttonLabel="Set up MFA"
              buttonClassName="btn btn-black w-full"
            />
            <form action={skipMfa}>
              <button type="submit" className="btn btn-secondary w-full">
                Skip
              </button>
            </form>
          </div>
        )}
      </div>
    </PageAtmosphere>
  );
}
