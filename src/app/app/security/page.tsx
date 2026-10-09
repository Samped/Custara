import { redirect } from "next/navigation";
import { canAdmin, requireSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { AppShell } from "@/components/app/AppShell";
import { BeginMfaForm, ConfirmMfaForm, DisableMfaForm, SettingsJsonForm } from "@/components/app/SettingsForms";
import { MfaEnrollPanel } from "@/components/app/MfaEnrollPanel";

export default async function SecurityPage({
  searchParams,
}: {
  searchParams: Promise<{ mfa?: string; enrollSecret?: string; otpauth?: string }>;
}) {
  let user;
  try {
    user = await requireSessionUser();
  } catch {
    redirect("/login");
  }

  const params = await searchParams;
  const me = await prisma.workspaceUser.findUniqueOrThrow({
    where: { id: user.id },
    include: { organization: { select: { mfaPayThresholdUsd: true } } },
  });
  const threshold = me.organization.mfaPayThresholdUsd ?? 5000;

  return (
    <AppShell user={user} title="Security">
      <section className="dash-panel">
        <h2 className="dash-h">Authenticator</h2>
        <p className="dash-sub mt-1">
          Status:{" "}
          <span className={me.mfaEnabled ? "font-medium text-accent" : "text-muted"}>
            {me.mfaEnabled ? "Enabled" : params.enrollSecret ? "Enrollment in progress" : "Off"}
          </span>
        </p>

        {params.enrollSecret && params.otpauth ? (
          <div className="mt-4 space-y-4">
            <MfaEnrollPanel secret={params.enrollSecret} otpauth={params.otpauth} />
            <ConfirmMfaForm redirectTo="/app/security" />
          </div>
        ) : me.mfaEnabled ? (
          <div className="mt-4">
            <DisableMfaForm />
          </div>
        ) : (
          <div className="mt-4">
            <BeginMfaForm
              redirectBase="/app/security"
              buttonLabel="Set up MFA"
              buttonClassName="btn btn-primary"
            />
          </div>
        )}
      </section>

      {canAdmin(user.role) ? (
        <section className="dash-panel mt-6">
          <h2 className="dash-h">Payment MFA</h2>
          <p className="dash-sub mt-1">
            Authenticator step-up applies to payments at or above this USD amount. Smaller payments do not require a code.
          </p>
          <SettingsJsonForm action="save_mfa_threshold" className="mt-4 max-w-sm space-y-3">
            <label className="block text-sm">
              Require MFA at or above (USD)
              <input
                name="mfaPayThresholdUsd"
                className="input mt-1"
                type="number"
                min={0}
                step="0.01"
                defaultValue={threshold}
                required
              />
            </label>
            <button type="submit" className="btn btn-primary">
              Save threshold
            </button>
          </SettingsJsonForm>
        </section>
      ) : null}
    </AppShell>
  );
}
