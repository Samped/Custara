import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import {
  createTreasuryLinkChallenge,
  ensureAgentWallet,
  fundAgentTestnet,
  linkTreasuryAddressManual,
  syncWalletBalances,
  upgradeAgentWalletToCircle,
  verifyAndLinkTreasuryWallet,
} from "@/domain/arc/wallets";
import { addDestination, revokeDestination } from "@/domain/arc/allowlist";
import { enqueueAgentTask } from "@/domain/arc/tasks";

export const runtime = "nodejs";
/** Allow Fund button to wait through Circle faucet rate limits + balance sync. */
export const maxDuration = 300;

async function jsonError(e: unknown) {
  if (e instanceof AuthError) {
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
  return NextResponse.json({ error: e instanceof Error ? e.message : "Request failed" }, { status: 400 });
}

/** JSON-only wallet mutations — avoids FormData/server-action fetch that wallet extensions break via structuredClone. */
export async function POST(request: NextRequest) {
  try {
    const user = await requireSessionUser(["admin", "payer"]);
    const body = (await request.json()) as Record<string, unknown>;
    const action = String(body.action || "");

    if (action === "challenge") {
      const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || "custara.xyz";
      const proto = request.headers.get("x-forwarded-proto") || (host.includes("localhost") ? "http" : "https");
      const challenge = await createTreasuryLinkChallenge({
        organizationId: user.organizationId,
        userId: user.id,
        domain: host,
        uri: `${proto}://${host}/app/payments?tab=wallets`,
      });
      return NextResponse.json({
        message: challenge.message,
        nonce: challenge.nonce,
        expiresAt: challenge.expiresAt.toISOString(),
      });
    }

    if (action === "verify") {
      await verifyAndLinkTreasuryWallet({
        organizationId: user.organizationId,
        userId: user.id,
        address: String(body.address || ""),
        signature: String(body.signature || ""),
        message: String(body.message || ""),
      });
      return NextResponse.json({ ok: true });
    }

    if (action === "link_manual") {
      await requireSessionUser(["admin"]);
      await linkTreasuryAddressManual({
        organizationId: user.organizationId,
        userId: user.id,
        address: String(body.address || ""),
      });
      return NextResponse.json({ ok: true });
    }

    if (action === "provision_agent") {
      await requireSessionUser(["admin"]);
      const wallet = await ensureAgentWallet({
        organizationId: user.organizationId,
        actorType: "user",
        actorId: user.id,
      });
      return NextResponse.json({ ok: true, wallet });
    }

    if (action === "upgrade_agent_circle") {
      await requireSessionUser(["admin"]);
      const wallet = await upgradeAgentWalletToCircle({
        organizationId: user.organizationId,
        actorType: "user",
        actorId: user.id,
      });
      return NextResponse.json({ ok: true, wallet });
    }

    if (action === "fund_agent_testnet") {
      await requireSessionUser(["admin", "payer"]);
      const waitSec = Math.max(0, Math.min(Number(body.waitSec ?? 90) || 0, 180));
      const result = await fundAgentTestnet({
        organizationId: user.organizationId,
        actorId: user.id,
        waitMs: waitSec * 1000,
      });
      return NextResponse.json({ ok: true, ...result });
    }

    if (action === "sync") {
      await enqueueAgentTask({ organizationId: user.organizationId, type: "wallet_sync" });
      const wallets = await syncWalletBalances(user.organizationId);
      return NextResponse.json({ ok: true, wallets });
    }

    if (action === "toggle_freeze") {
      await requireSessionUser(["admin"]);
      const freeze = Boolean(body.freeze);
      await prisma.organization.update({
        where: { id: user.organizationId },
        data: { agentWalletFrozen: freeze },
      });
      await writeAudit({
        organizationId: user.organizationId,
        actorType: "user",
        actorId: user.id,
        action: freeze ? "wallet.agent_frozen" : "wallet.agent_unfrozen",
        entityType: "organization",
        entityId: user.organizationId,
      });
      return NextResponse.json({ ok: true });
    }

    if (action === "save_limit") {
      await requireSessionUser(["admin"]);
      await prisma.organization.update({
        where: { id: user.organizationId },
        data: { dailySpendLimitUsd: Number(body.dailySpendLimitUsd || 250000) },
      });
      return NextResponse.json({ ok: true });
    }

    if (action === "allowlist_add") {
      await requireSessionUser(["admin"]);
      await addDestination({
        organizationId: user.organizationId,
        address: String(body.address || ""),
        label: body.label ? String(body.label) : undefined,
        actorId: user.id,
      });
      return NextResponse.json({ ok: true });
    }

    if (action === "allowlist_revoke") {
      await requireSessionUser(["admin"]);
      await revokeDestination({
        organizationId: user.organizationId,
        address: String(body.address || ""),
        actorId: user.id,
      });
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (e) {
    return jsonError(e);
  }
}
