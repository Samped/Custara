import { redirect } from "next/navigation";
import { requireSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { AppShell } from "@/components/app/AppShell";
import { writeAudit } from "@/lib/audit";
import { revalidatePath } from "next/cache";
import { confirmMfaEnrollment, disableMfa, startMfaEnrollment, parseMfaRequiredRoles } from "@/lib/mfa";
import { verifyAuditChain } from "@/lib/audit";

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
  const users = await prisma.workspaceUser.findMany({
    where: { organizationId: user.organizationId },
    orderBy: { email: "asc" },
  });
  const me = await prisma.workspaceUser.findUniqueOrThrow({ where: { id: user.id } });
  const mfaRoles = parseMfaRequiredRoles(org.mfaRequiredForRoles);
  let chainStatus = "not checked";
  try {
    const v = await verifyAuditChain(user.organizationId);
    chainStatus = v.ok ? `ok (${v.count} events)` : `BROKEN at ${v.brokenId}`;
  } catch {
    chainStatus = "unavailable";
  }

  async function saveOrg(formData: FormData) {
    "use server";
    const session = await requireSessionUser(["admin"], "settings:write");
    const paymentMode = String(formData.get("paymentMode") || "sandbox");
    const roles = formData.getAll("mfaRole").map(String);
    const nextMode = paymentMode === "live" ? "live" : "sandbox";
    await prisma.organization.update({
      where: { id: session.organizationId },
      data: {
        name: String(formData.get("name") || "Organization"),
        privacyMode: formData.get("privacyMode") === "on",
        privacyDeleteDays: Number(formData.get("privacyDeleteDays") || 30),
        expectedInflow7d: Number(formData.get("expectedInflow7d") || 0),
        expectedInflow30d: Number(formData.get("expectedInflow30d") || 0),
        paymentMode: nextMode,
        ssoEnforced: formData.get("ssoEnforced") === "on",
        mfaRequiredForRoles: JSON.stringify(roles),
        // Live mode never enables auto-pay by default from this form unless explicitly checked
        autoPayEnabled: nextMode === "live" ? formData.get("autoPayEnabled") === "on" : formData.get("autoPayEnabled") === "on",
      },
    });
    if (nextMode === "live") {
      const { ensureStrictPolicyForLive } = await import("@/domain/policy");
      await ensureStrictPolicyForLive(session.organizationId, session.id);
    }
    await writeAudit({
      organizationId: session.organizationId,
      actorType: "user",
      actorId: session.id,
      action: "org.settings_updated",
      entityType: "organization",
      entityId: session.organizationId,
      metadata: {
        paymentMode: nextMode,
        mfaRequiredForRoles: roles,
        autoPayEnabled: formData.get("autoPayEnabled") === "on",
        strictPolicyEnsured: nextMode === "live",
      },
    });
    revalidatePath("/app/settings");
    revalidatePath("/app/policies");
  }

  async function beginMfa() {
    "use server";
    const session = await requireSessionUser(["admin"], "settings:write");
    const result = await startMfaEnrollment(session.id);
    await writeAudit({
      organizationId: session.organizationId,
      actorType: "user",
      actorId: session.id,
      action: "user.mfa_enroll_started",
      entityType: "workspace_user",
      entityId: session.id,
    });
    redirect(
      `/app/settings?mfa=enroll&enrollSecret=${encodeURIComponent(result.secret)}&otpauth=${encodeURIComponent(result.otpauth)}`,
    );
  }

  async function confirmMfa(formData: FormData) {
    "use server";
    const session = await requireSessionUser(["admin"], "settings:write");
    await confirmMfaEnrollment(session.id, String(formData.get("code") || ""));
    await writeAudit({
      organizationId: session.organizationId,
      actorType: "user",
      actorId: session.id,
      action: "user.mfa_enabled",
      entityType: "workspace_user",
      entityId: session.id,
    });
    revalidatePath("/app/settings");
    redirect("/app/settings");
  }

  async function turnOffMfa(formData: FormData) {
    "use server";
    const session = await requireSessionUser(["admin"], "settings:write");
    await disableMfa(session.id, String(formData.get("code") || ""));
    await writeAudit({
      organizationId: session.organizationId,
      actorType: "user",
      actorId: session.id,
      action: "user.mfa_disabled",
      entityType: "workspace_user",
      entityId: session.id,
    });
    revalidatePath("/app/settings");
  }

  async function inviteUser(formData: FormData) {
    "use server";
    const session = await requireSessionUser(["admin"], "settings:write");
    const { inviteWorkspaceUser } = await import("@/domain/users");
    await inviteWorkspaceUser({
      organizationId: session.organizationId,
      actorId: session.id,
      email: String(formData.get("email") || ""),
      name: String(formData.get("name") || "") || undefined,
      role: String(formData.get("role") || "viewer"),
    });
    revalidatePath("/app/settings");
  }

  async function disableUser(formData: FormData) {
    "use server";
    const session = await requireSessionUser(["admin"], "settings:write");
    const { disableWorkspaceUser } = await import("@/domain/users");
    await disableWorkspaceUser({
      organizationId: session.organizationId,
      actorId: session.id,
      userId: String(formData.get("userId") || ""),
    });
    revalidatePath("/app/settings");
  }

  return (
    <AppShell
      user={user}
      title="Settings"
      subtitle="Privacy · MFA · payment mode"
    >
      <div className="card mb-5 p-5">
        <h2 className="app-h">Controls</h2>
        <form action={saveOrg} className="mt-4 grid gap-3 md:grid-cols-2">
          <label className="text-sm md:col-span-2">
            Legal name
            <input name="name" className="input mt-1" defaultValue={org.name} />
          </label>
          <label className="text-sm">
            Expected inflow 7d
            <input name="expectedInflow7d" type="number" className="input mt-1" defaultValue={org.expectedInflow7d} />
          </label>
          <label className="text-sm">
            Expected inflow 30d
            <input name="expectedInflow30d" type="number" className="input mt-1" defaultValue={org.expectedInflow30d} />
          </label>
          <label className="text-sm">
            Privacy delete days
            <input name="privacyDeleteDays" type="number" className="input mt-1" defaultValue={org.privacyDeleteDays} />
          </label>
          <label className="text-sm">
            Payment mode
            <select name="paymentMode" className="input mt-1" defaultValue={org.paymentMode}>
              <option value="sandbox">sandbox</option>
              <option value="live">live (applies PayablesAI Strict if no policy)</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input name="privacyMode" type="checkbox" defaultChecked={org.privacyMode} />
            Privacy Mode (scoped retention)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input name="autoPayEnabled" type="checkbox" defaultChecked={org.autoPayEnabled} />
            Auto-pay approved invoices on recommended pay date
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input name="ssoEnforced" type="checkbox" defaultChecked={org.ssoEnforced} />
            Enforce SSO (OIDC env required)
          </label>
          <fieldset className="md:col-span-2">
            <legend className="text-sm font-semibold">MFA required for roles</legend>
            <div className="mt-2 flex flex-wrap gap-3 text-sm">
              {(["admin", "approver", "payer", "viewer", "auditor"] as const).map((role) => (
                <label key={role} className="flex items-center gap-2">
                  <input name="mfaRole" type="checkbox" value={role} defaultChecked={mfaRoles.includes(role)} />
                  {role}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="md:col-span-2">
            <button type="submit" className="btn btn-primary">
              Save settings
            </button>
          </div>
        </form>
        <p className="mt-4 text-xs text-muted">
          SSO: OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, optional OIDC_ALLOWED_EMAIL_DOMAINS. Audit chain:{" "}
          {chainStatus}
        </p>
      </div>

      <div className="card mb-5 p-5">
        <h2 className="app-h">Your MFA (TOTP)</h2>
        <p className="app-sub">
          Status: {me.mfaEnabled ? "enabled" : params.mfa === "enroll" ? "enrollment in progress" : "disabled"}
        </p>
        {params.enrollSecret ? (
          <div className="mt-3 space-y-2 text-sm">
            <p className="font-mono break-all text-xs">Secret: {params.enrollSecret}</p>
            <p className="font-mono break-all text-xs">otpauth: {params.otpauth}</p>
            <form action={confirmMfa} className="flex max-w-sm flex-col gap-2">
              <input name="code" className="input" placeholder="6-digit code" required />
              <button type="submit" className="btn btn-black">
                Confirm enrollment
              </button>
            </form>
          </div>
        ) : me.mfaEnabled ? (
          <form action={turnOffMfa} className="mt-3 flex max-w-sm flex-col gap-2">
            <input name="code" className="input" placeholder="Code to disable" required />
            <button type="submit" className="btn btn-secondary">
              Disable MFA
            </button>
          </form>
        ) : (
          <form action={beginMfa} className="mt-3">
            <button type="submit" className="btn btn-secondary">
              Start MFA enrollment
            </button>
          </form>
        )}
      </div>

      <div className="card mb-5 p-5">
        <h2 className="app-h">Invite teammate</h2>
        <p className="app-sub">
          Production is invite-only (JIT org creation off). SSO users must be provisioned here before first login.
        </p>
        <form action={inviteUser} className="mt-4 grid gap-3 md:grid-cols-3">
          <label className="text-sm">
            Email
            <input name="email" type="email" className="input mt-1" required placeholder="finance@acme.com" />
          </label>
          <label className="text-sm">
            Name
            <input name="name" className="input mt-1" placeholder="Optional" />
          </label>
          <label className="text-sm">
            Role
            <select name="role" className="input mt-1" defaultValue="viewer">
              {(["admin", "approver", "payer", "viewer", "auditor"] as const).map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <div className="md:col-span-3">
            <button type="submit" className="btn btn-secondary">
              Invite user
            </button>
          </div>
        </form>
      </div>

      <div className="card overflow-hidden">
        <table className="table">
          <thead>
            <tr>
              <th>User</th>
              <th>Role</th>
              <th>MFA</th>
              <th>Last login</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>
                  <p className="font-medium">{u.name}</p>
                  <p className="text-xs text-muted">{u.email}</p>
                </td>
                <td>{u.role}</td>
                <td>{u.mfaEnabled ? "on" : "off"}</td>
                <td>{u.lastLoginAt ? u.lastLoginAt.toISOString() : "—"}</td>
                <td>{u.disabledAt ? "disabled" : "active"}</td>
                <td>
                  {!u.disabledAt && u.id !== user.id ? (
                    <form action={disableUser}>
                      <input type="hidden" name="userId" value={u.id} />
                      <button type="submit" className="text-xs text-danger hover:underline">
                        Disable
                      </button>
                    </form>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AppShell>
  );
}
