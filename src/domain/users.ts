import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { isMailConfigured, sendEmail } from "@/lib/mail";
import type { Role } from "@/lib/auth";

const ROLES: Role[] = ["admin", "approver", "payer", "viewer", "auditor"];

/** Admin-provisioned workspace user (invite-only / SSO mapping). */
export async function inviteWorkspaceUser(input: {
  organizationId: string;
  actorId: string;
  email: string;
  name?: string;
  role?: string;
}) {
  const email = input.email.trim().toLowerCase();
  if (!email.includes("@")) throw new Error("Valid email required");
  const role = (ROLES.includes(input.role as Role) ? input.role : "viewer") as string;
  const name =
    input.name?.trim() ||
    email
      .split("@")[0]
      .replace(/[._-]+/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());

  const existing = await prisma.workspaceUser.findFirst({
    where: { organizationId: input.organizationId, email },
  });
  if (existing && !existing.disabledAt) {
    throw new Error("User already in this organization");
  }

  const user = existing
    ? await prisma.workspaceUser.update({
        where: { id: existing.id },
        data: { disabledAt: null, role, name },
      })
    : await prisma.workspaceUser.create({
        data: {
          organizationId: input.organizationId,
          email,
          name,
          role,
        },
      });

  await writeAudit({
    organizationId: input.organizationId,
    actorType: "user",
    actorId: input.actorId,
    action: "user.invited",
    entityType: "workspace_user",
    entityId: user.id,
    metadata: { email, role },
  });

  if (isMailConfigured()) {
    const org = await prisma.organization.findUnique({ where: { id: input.organizationId } });
    const appUrl = (process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "");
    const loginUrl = appUrl ? `${appUrl}/login` : "/login";
    await sendEmail({
      to: email,
      subject: `You're invited to ${org?.name || "Custara"}`,
      text: `You have been invited to ${org?.name || "Custara"} as ${role}. Sign in at ${loginUrl}`,
      html: `<p>You have been invited to <strong>${org?.name || "Custara"}</strong> as <strong>${role}</strong>.</p><p><a href="${loginUrl}">Sign in</a></p>`,
    }).catch((e) => console.warn("[invite] email failed", e));
  }

  return user;
}

export async function disableWorkspaceUser(input: {
  organizationId: string;
  actorId: string;
  userId: string;
}) {
  if (input.userId === input.actorId) throw new Error("Cannot disable yourself");
  const user = await prisma.workspaceUser.findFirst({
    where: { id: input.userId, organizationId: input.organizationId },
  });
  if (!user) throw new Error("User not found");
  const updated = await prisma.workspaceUser.update({
    where: { id: user.id },
    data: { disabledAt: new Date() },
  });
  await writeAudit({
    organizationId: input.organizationId,
    actorType: "user",
    actorId: input.actorId,
    action: "user.disabled",
    entityType: "workspace_user",
    entityId: user.id,
  });
  return updated;
}
