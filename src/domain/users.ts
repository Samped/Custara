import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { isMailConfigured, sendEmail } from "@/lib/mail";
import type { Role } from "@/lib/auth";
import { INVITE_ROLE_OPTIONS, roleLabel } from "@/lib/roles";

const ROLES: Role[] = INVITE_ROLE_OPTIONS.map((r) => r.value);

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
  const role = (ROLES.includes(input.role as Role) ? input.role : "viewer") as Role;
  const name =
    input.name?.trim() ||
    email
      .split("@")[0]
      .replace(/[._-]+/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());

  // One email → one startup membership (global unique).
  const elsewhere = await prisma.workspaceUser.findFirst({
    where: { email, NOT: { organizationId: input.organizationId } },
    include: { organization: { select: { name: true } } },
  });
  if (elsewhere) {
    throw new Error(
      `That email already belongs to another workspace (${elsewhere.organization.name}). Each email can only join one startup.`,
    );
  }

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
    const label = roleLabel(role);
    await sendEmail({
      to: email,
      subject: `You're invited to ${org?.name || "Custara"}`,
      text: `You have been invited to ${org?.name || "Custara"} as ${label}. Sign in at ${loginUrl}`,
      html: `<p>You have been invited to <strong>${org?.name || "Custara"}</strong> as <strong>${label}</strong>.</p><p><a href="${loginUrl}">Sign in</a></p>`,
    }).catch((e) => console.warn("[invite] email failed", e));
  }

  return user;
}

export async function updateWorkspaceUserRole(input: {
  organizationId: string;
  actorId: string;
  userId: string;
  role: string;
}) {
  if (!ROLES.includes(input.role as Role)) throw new Error("Invalid role");
  const user = await prisma.workspaceUser.findFirst({
    where: { id: input.userId, organizationId: input.organizationId, disabledAt: null },
  });
  if (!user) throw new Error("User not found");
  if (user.id === input.actorId && input.role !== "admin") {
    throw new Error("Cannot remove your own admin role");
  }
  if (user.role === "admin" && input.role !== "admin") {
    const otherAdmins = await prisma.workspaceUser.count({
      where: {
        organizationId: input.organizationId,
        role: "admin",
        disabledAt: null,
        NOT: { id: user.id },
      },
    });
    if (otherAdmins === 0) throw new Error("Keep at least one admin");
  }

  const updated = await prisma.workspaceUser.update({
    where: { id: user.id },
    data: { role: input.role },
  });
  await writeAudit({
    organizationId: input.organizationId,
    actorType: "user",
    actorId: input.actorId,
    action: "user.role_updated",
    entityType: "workspace_user",
    entityId: user.id,
    metadata: { email: user.email, from: user.role, to: input.role },
  });
  return updated;
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

export async function listWorkspaceMembers(organizationId: string) {
  return prisma.workspaceUser.findMany({
    where: { organizationId },
    orderBy: [{ disabledAt: "asc" }, { email: "asc" }],
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      disabledAt: true,
      lastLoginAt: true,
      mfaEnabled: true,
    },
  });
}
