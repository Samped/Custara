import { readFileSync, existsSync } from "fs";
import path from "path";
import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();
export const BASE_URL = process.env.E2E_BASE_URL || "http://127.0.0.1:3000";

export function requireE2E() {
  if (process.env.E2E !== "1") {
    throw new Error("Set E2E=1 to run tests/e2e (needs DB + seeded org + preferably running app/worker)");
  }
}

export function circleConfigured() {
  const key = process.env.CIRCLE_API_KEY?.trim() || "";
  const secret = process.env.CIRCLE_ENTITY_SECRET?.trim() || "";
  // Placeholder keys from .env.example / local stubs should not trigger live Arc E2E
  if (!key || !secret) return false;
  if (key.startsWith("TEST_") || key.includes("replace") || secret.includes("replace")) return false;
  if (process.env.E2E_ARC === "0") return false;
  return true;
}

export function readDemoApiKey(): string {
  const p = path.join(process.cwd(), "storage", "DEMO_CREDENTIALS.txt");
  if (existsSync(p)) {
    const text = readFileSync(p, "utf8");
    const m = text.match(/cst_live_[a-f0-9]+/i);
    if (m) return m[0];
  }
  if (process.env.E2E_API_KEY) return process.env.E2E_API_KEY;
  throw new Error("No API key — run npm run db:seed or set E2E_API_KEY");
}

export async function getSeedOrg() {
  const org = await prisma.organization.findFirst({
    where: { slug: "lagos-distribution" },
  });
  if (!org) throw new Error("Seed org missing — npm run db:seed");
  return org;
}

export async function getUserByEmail(email: string) {
  const user = await prisma.workspaceUser.findFirst({
    where: { email, disabledAt: null },
  });
  if (!user) throw new Error(`User ${email} missing — seed`);
  return user;
}

export async function apiJson(
  method: string,
  pathName: string,
  opts: { key?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = {
    ...(opts.headers || {}),
  };
  if (opts.key) headers.Authorization = `Bearer ${opts.key}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE_URL}${pathName}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json, text };
}
