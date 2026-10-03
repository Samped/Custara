import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { redisHealth } from "@/lib/jobs";
import { storageHealth } from "@/lib/storage";

export async function GET() {
  const checks: Record<string, { ok: boolean; detail?: string }> = {};

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = { ok: true };
  } catch (e) {
    checks.database = { ok: false, detail: e instanceof Error ? e.message : "db error" };
  }

  checks.redis = await redisHealth();
  checks.storage = await storageHealth();

  const ok = Object.values(checks).every((c) => c.ok);
  return NextResponse.json(
    {
      ok,
      service: "custara",
      checks,
      gates: {
        arc_payments_live: process.env.ARC_PAYMENTS_LIVE === "true",
        nigeria_payment_live: process.env.NIGERIA_PAYMENT_LIVE === "true",
        xero_configured: Boolean(process.env.XERO_CLIENT_ID && process.env.XERO_CLIENT_SECRET),
        oidc_configured: Boolean(process.env.OIDC_ISSUER && process.env.OIDC_CLIENT_ID),
        auth_provider: process.env.AUTH_PROVIDER || "circle",
        circle_user_auth: Boolean(
          process.env.CIRCLE_API_KEY?.trim() &&
            (process.env.CIRCLE_APP_ID?.trim() || process.env.NEXT_PUBLIC_CIRCLE_APP_ID?.trim()),
        ),
        circle_dev_wallets: Boolean(
          process.env.CIRCLE_API_KEY?.trim() && process.env.CIRCLE_ENTITY_SECRET?.trim(),
        ),
        storage_backend: process.env.STORAGE_BACKEND || "local",
      },
    },
    { status: ok ? 200 : 503 },
  );
}
