"use server";

import { revalidatePath } from "next/cache";
import { requireSessionUser } from "@/lib/auth";
import { disableWorkspaceUser, inviteWorkspaceUser } from "@/domain/users";

export async function inviteTeamMemberAction(formData: FormData) {
  const session = await requireSessionUser(["admin"], "settings:write");
  await inviteWorkspaceUser({
    organizationId: session.organizationId,
    actorId: session.id,
    email: String(formData.get("email") || ""),
    name: String(formData.get("name") || "") || undefined,
    role: String(formData.get("role") || "viewer"),
  });
  revalidatePath("/app");
  revalidatePath("/app/settings");
}

export async function disableTeamMemberAction(formData: FormData) {
  const session = await requireSessionUser(["admin"], "settings:write");
  await disableWorkspaceUser({
    organizationId: session.organizationId,
    actorId: session.id,
    userId: String(formData.get("userId") || ""),
  });
  revalidatePath("/app");
  revalidatePath("/app/settings");
}
