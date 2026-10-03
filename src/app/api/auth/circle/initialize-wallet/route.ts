import { NextRequest, NextResponse } from "next/server";
import { AuthError, getSessionUser, requireSessionUser } from "@/lib/auth";
import { initializeAndLinkCircleUserTreasury } from "@/domain/arc/userAuth";
import { ensureAgentWallet } from "@/domain/arc/wallets";

export const runtime = "nodejs";

/** Link Circle email (user-controlled) wallet as company treasury after OTP login. */
export async function POST(request: NextRequest) {
  try {
    const user = await requireSessionUser(["admin", "payer"]);
    const body = (await request.json()) as { userToken?: string; email?: string };
    const userToken = String(body.userToken || "").trim();
    const email = String(body.email || user.email)
      .trim()
      .toLowerCase();

    // Sandbox path may omit userToken
    const wallet = await initializeAndLinkCircleUserTreasury({
      organizationId: user.organizationId,
      userId: user.id,
      email,
      userToken: userToken || "sandbox",
    });

    await ensureAgentWallet({
      organizationId: user.organizationId,
      actorType: "user",
      actorId: user.id,
    });

    return NextResponse.json({
      ok: true,
      treasury: {
        id: wallet.id,
        address: wallet.address,
        provider: wallet.provider,
      },
    });
  } catch (e) {
    if (e instanceof AuthError) {
      // Allow initialize right after OTP before MFA session in edge cases — still require session
      const session = await getSessionUser();
      if (!session) {
        return NextResponse.json({ error: e.message }, { status: e.status });
      }
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : "Wallet init failed" }, { status: 400 });
  }
}
