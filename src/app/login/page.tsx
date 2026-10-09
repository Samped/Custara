import { redirect } from "next/navigation";
import {
  createSession,
  getMfaPendingUserId,
  getSessionUser,
} from "@/lib/auth";
import { BrandLogo } from "@/components/app/BrandLogo";
import { PageAtmosphere } from "@/components/app/GridAtmosphere";
import { EmailOtpGate } from "@/components/app/EmailOtpGate";
import { isOidcConfigured } from "@/lib/oidc";
import { userNeedsMfaChallenge, verifyUserMfa } from "@/lib/mfa";
import { prisma } from "@/lib/db";
import { getCircleAppId, isCircleUserAuthConfigured } from "@/lib/emailOtp";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; step?: string }>;
}) {
  const user = await getSessionUser();
  if (user) redirect("/app");
  const params = await searchParams;
  const oidcReady = isOidcConfigured();
  const pendingId = await getMfaPendingUserId();
  const mfaStep = params.step === "mfa" || Boolean(pendingId);

  const ssoOnlyOrgs = await prisma.organization.count({
    where: { ssoEnforced: true },
  });
  const hideOtp = oidcReady && ssoOnlyOrgs > 0 && !mfaStep;
  const circleReady = isCircleUserAuthConfigured();
  const circleAppId = getCircleAppId() || null;

  async function verifyMfa(formData: FormData) {
    "use server";
    const pending = await getMfaPendingUserId();
    if (!pending) redirect("/login?error=MFA%20session%20expired");
    const code = String(formData.get("code") || "");
    const found = await prisma.workspaceUser.findUnique({
      where: { id: pending },
      include: { organization: true },
    });
    if (!found) redirect("/login?error=MFA%20session%20expired");

    const need = await userNeedsMfaChallenge(found);
    if (need !== "challenge") {
      await createSession(found.id);
      redirect("/app");
    }

    try {
      await verifyUserMfa(found.id, code);
    } catch {
      redirect("/login?step=mfa&error=Invalid%20MFA%20code");
    }
    await createSession(found.id);
    redirect("/app");
  }

  return (
    <PageAtmosphere className="app-shell flex min-h-screen items-center justify-center px-4">
      <div className="login-panel">
        <BrandLogo href={null} size={30} wordmarkClassName="text-[0.95rem]" />
        <h1 className="mt-6 page-title">{mfaStep ? "MFA verification" : "Sign in"}</h1>
        <p className="mt-2 page-subtitle">
          {mfaStep ? "Enter your authenticator code." : "Work email · one-time code"}
        </p>

        {params.error ? <p className="mt-4 text-sm text-danger">{params.error}</p> : null}

        {oidcReady && !mfaStep ? (
          <a href="/api/auth/oidc/start" className="btn btn-secondary mt-6 w-full text-center">
            Continue with SSO
          </a>
        ) : null}

        {mfaStep ? (
          <form action={verifyMfa} className="mt-7 space-y-4">
            <div>
              <label className="mb-1.5 block text-[0.78rem] font-semibold" htmlFor="code">
                Authenticator code
              </label>
              <input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" required className="input" />
            </div>
            <button type="submit" className="btn btn-black w-full">
              Verify
            </button>
          </form>
        ) : hideOtp ? (
          <p className="mt-6 text-sm text-muted">Email OTP is disabled while SSO is enforced.</p>
        ) : (
          <EmailOtpGate circleReady={circleReady} circleAppId={circleAppId} />
        )}
      </div>
    </PageAtmosphere>
  );
}
