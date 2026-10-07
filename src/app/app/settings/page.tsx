import Link from "next/link";
import { redirect } from "next/navigation";
import { requireSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { AppShell } from "@/components/app/AppShell";
import { verifyAuditChain } from "@/lib/audit";
import {
  COUNTRY_OPTIONS,
  DISPLAY_CURRENCIES,
  currencyFromCountry,
  resolveDisplayCurrency,
} from "@/lib/currency";
import { BeginMfaForm, DisableMfaForm, SettingsOrgForm } from "@/components/app/SettingsForms";
import { MfaEnrollPanel } from "@/components/app/MfaEnrollPanel";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ mfa?: string; enrollSecret?: string; otpauth?: string }>;
}) {
  let user;
  try {
    user = await requireSessionUser(["admin"], "settings:write");
  } catch {
    redirect("/login");
  }

  const params = await searchParams;
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: user.organizationId } });
  const me = await prisma.workspaceUser.findUniqueOrThrow({ where: { id: user.id } });
  const displayCurrency = resolveDisplayCurrency(org);
  let chainStatus = "not checked";
  try {
    const v = await verifyAuditChain(user.organizationId);
    chainStatus = v.ok ? `ok (${v.count} events)` : `BROKEN at ${v.brokenId}`;
  } catch {
    chainStatus = "unavailable";
  }

  return (
    <AppShell user={user} title="Settings">
      <section className="dash-panel mb-5">
        <h2 className="dash-h">Platform</h2>
        <div className="platform-hub mt-4">
          <Link href="/app/connectors">
            <strong>Connectors</strong>
            <span>Ingest channels</span>
          </Link>
          <Link href="/app/developers">
            <strong>API</strong>
            <span>Keys and webhooks</span>
          </Link>
          <Link href="/app/roles">
            <strong>Roles</strong>
            <span>Team access</span>
          </Link>
          <Link href="/app/policies">
            <strong>Controls</strong>
            <span>Policies and audit</span>
          </Link>
          <Link href="/app/vendors?tab=portal">
            <strong>Vendor portal</strong>
            <span>Upload invites</span>
          </Link>
          <Link href="/app/security">
            <strong>Security</strong>
            <span>MFA</span>
          </Link>
        </div>
      </section>

      <div className="card mb-5 p-5">
        <h2 className="app-h">Organization</h2>
        <SettingsOrgForm>
          <label className="text-sm md:col-span-2">
            Legal name
            <input name="name" className="input mt-1" defaultValue={org.name} />
          </label>
          <label className="text-sm">
            Business location
            <select name="country" className="input mt-1" defaultValue={org.country || ""}>
              <option value="">Not set — USD default</option>
              {COUNTRY_OPTIONS.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label} ({currencyFromCountry(c.code)})
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            Dashboard currency
            <select name="displayCurrency" className="input mt-1" defaultValue={displayCurrency}>
              {DISPLAY_CURRENCIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            Expected inflow 7d ({displayCurrency})
            <input name="expectedInflow7d" type="number" className="input mt-1" defaultValue={org.expectedInflow7d} />
          </label>
          <label className="text-sm">
            Expected inflow 30d ({displayCurrency})
            <input name="expectedInflow30d" type="number" className="input mt-1" defaultValue={org.expectedInflow30d} />
          </label>
          <label className="text-sm">
            Privacy delete days
            <input name="privacyDeleteDays" type="number" className="input mt-1" defaultValue={org.privacyDeleteDays} />
          </label>
          <label className="text-sm md:col-span-2">
            Payment mode
            <select name="paymentMode" className="input mt-1" defaultValue={org.paymentMode}>
              <option value="sandbox">Simulated</option>
              <option value="live">Live</option>
            </select>
            <span className="mt-1 block text-[0.75rem] text-muted">
              Live requires Circle and Arc environment configuration.
            </span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input name="privacyMode" type="checkbox" defaultChecked={org.privacyMode} />
            Privacy mode
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input name="autoPayEnabled" type="checkbox" defaultChecked={org.autoPayEnabled} />
            Auto-pay on recommended date
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input name="ssoEnforced" type="checkbox" defaultChecked={org.ssoEnforced} />
            Enforce SSO
          </label>
          <div className="md:col-span-2">
            <button type="submit" className="btn btn-primary">
              Save settings
            </button>
          </div>
        </SettingsOrgForm>
        <p className="mt-4 text-xs text-muted">Audit chain: {chainStatus}</p>
      </div>

      <div className="card mb-5 p-5">
        <h2 className="app-h">MFA</h2>
        <p className="app-sub">
          Status:{" "}
          <span className={me.mfaEnabled ? "font-medium text-accent" : "text-muted"}>
            {me.mfaEnabled ? "Enabled" : params.mfa === "enroll" ? "Enrollment in progress" : "Off"}
          </span>
          {" · "}
          <Link href="/app/security" className="text-accent hover:underline">
            Security
          </Link>
        </p>
        {params.enrollSecret && params.otpauth ? (
          <MfaEnrollPanel secret={params.enrollSecret} otpauth={params.otpauth} />
        ) : me.mfaEnabled ? (
          <DisableMfaForm />
        ) : (
          <BeginMfaForm />
        )}
      </div>
    </AppShell>
  );
}
