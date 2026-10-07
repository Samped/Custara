"use server";

import { requireSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { isKnownDisplayCurrency, normalizeCurrency } from "@/lib/currency";
import { revalidatePath } from "next/cache";

export async function setDisplayCurrencyAction(formData: FormData) {
  const session = await requireSessionUser();

  const raw = normalizeCurrency(String(formData.get("displayCurrency") || ""));
  if (!isKnownDisplayCurrency(raw) && raw.length !== 3 && raw.length !== 4) {
    throw new Error("Unsupported currency");
  }

  await prisma.organization.update({
    where: { id: session.organizationId },
    data: { displayCurrency: raw },
  });

  await writeAudit({
    organizationId: session.organizationId,
    actorType: "user",
    actorId: session.id,
    action: "org.display_currency_updated",
    entityType: "organization",
    entityId: session.organizationId,
    metadata: { displayCurrency: raw },
  });

  revalidatePath("/app");
  revalidatePath("/app/cash");
  revalidatePath("/app/settings");
  revalidatePath("/app/inbox");
  revalidatePath("/app/approvals");
  revalidatePath("/app/payments");
}
