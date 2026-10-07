import { createHash, randomBytes } from "crypto";
import { PrismaClient } from "@prisma/client";
import type { BrowserContext, Page } from "@playwright/test";

const prisma = new PrismaClient();
const SESSION_COOKIE = "custara_session";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function loginAs(context: BrowserContext, email: string) {
  const user = await prisma.workspaceUser.findFirst({
    where: { email, disabledAt: null },
  });
  if (!user) throw new Error(`No user ${email} — run npm run db:seed`);
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  await prisma.session.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt,
    },
  });
  await context.addCookies([
    {
      name: SESSION_COOKIE,
      value: token,
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  return user;
}

export async function loginAsOnPage(page: Page, email: string) {
  return loginAs(page.context(), email);
}

export function circleConfigured() {
  const key = process.env.CIRCLE_API_KEY?.trim() || "";
  const secret = process.env.CIRCLE_ENTITY_SECRET?.trim() || "";
  if (!key || !secret) return false;
  if (key.startsWith("TEST_") || key.includes("replace") || secret.includes("replace")) return false;
  if (process.env.E2E_ARC === "0") return false;
  return true;
}

export { prisma };
