import { redirect } from "next/navigation";
import { requireSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { AppShell } from "@/components/app/AppShell";
import { TeamPanel } from "@/components/app/TeamPanel";
import { MfaRolesForm } from "@/components/app/MfaRolesForm";
import { parseMfaRequiredRoles } from "@/lib/mfa";
import { INVITE_ROLE_OPTIONS } from "@/lib/roles";

export default async function RolesPage() {
  let user;
  try {
    user = await requireSessionUser(["admin"], "settings:write");
  } catch {
    redirect("/login");
  }

  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: user.organizationId },
    select: { mfaRequiredForRoles: true },
  });
  const users = await prisma.workspaceUser.findMany({
    where: { organizationId: user.organizationId },
    orderBy: { email: "asc" },
  });
  const mfaRoles = parseMfaRequiredRoles(org.mfaRequiredForRoles);

  return (
    <AppShell user={user} title="Roles">
      <section className="dash-panel mb-4">
        <h2 className="dash-h">Role catalog</h2>
        <ul className="role-catalog mt-4">
          {INVITE_ROLE_OPTIONS.map((r) => (
            <li key={r.value}>
              <strong>{r.label}</strong>
              <span>{r.description}</span>
            </li>
          ))}
        </ul>
      </section>

      <TeamPanel members={users} currentUserId={user.id} />

      <section className="dash-panel mt-4">
        <h2 className="dash-h">MFA by role</h2>
        <p className="dash-sub">Selected roles require MFA at sign-in.</p>
        <MfaRolesForm mfaRoles={mfaRoles} />
      </section>
    </AppShell>
  );
}
