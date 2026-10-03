import { NextRequest, NextResponse } from "next/server";
import { AuthError, authenticateApiKey } from "@/lib/auth";
import { assertRateLimit } from "@/lib/rateLimit";
import { ensureAgentWallet, listOrgWallets, syncWalletBalances } from "@/domain/arc/wallets";
import { enqueueAgentTask } from "@/domain/arc/tasks";

export async function GET(request: NextRequest) {
  try {
    const auth = await authenticateApiKey(request.headers.get("authorization"), ["cash:read"]);
    await assertRateLimit(`api:${auth.organizationId}:wallets`, 60);
    const wallets = await listOrgWallets(auth.organizationId);
    return NextResponse.json({ data: wallets });
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: e instanceof Error ? e.message : "Error" }, { status: 400 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await authenticateApiKey(request.headers.get("authorization"), ["payments:initiate"]);
    await assertRateLimit(`api:${auth.organizationId}:wallets:write`, 20);
    const body = (await request.json().catch(() => ({}))) as { action?: string };
    if (body.action === "provision_agent") {
      const wallet = await ensureAgentWallet({
        organizationId: auth.organizationId,
        actorType: "api_key",
        actorId: auth.apiKeyId,
      });
      return NextResponse.json({ data: wallet });
    }
    if (body.action === "sync") {
      await enqueueAgentTask({ organizationId: auth.organizationId, type: "wallet_sync" });
      const wallets = await syncWalletBalances(auth.organizationId);
      return NextResponse.json({ data: wallets });
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: e instanceof Error ? e.message : "Error" }, { status: 400 });
  }
}
