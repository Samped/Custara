import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  fetchPajBanksForWorkspace,
  getPajHomeStatus,
  saveWorkspaceBank,
  startPajOfframp,
  startPajOnramp,
} from "@/domain/banking/pajRails";
import { payClient } from "@/domain/directPayout";
import { isMfaSetupRequiredError } from "@/domain/payStepUp";
import { applyAgentDeposit, syncWalletBalances } from "@/domain/arc/wallets";

export const runtime = "nodejs";
export const maxDuration = 120;

function jsonError(e: unknown) {
  if (e instanceof AuthError) {
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
  const message = e instanceof Error ? e.message : "Request failed";
  const status = isMfaSetupRequiredError(message) ? 403 : 400;
  return NextResponse.json({ error: message }, { status });
}

export async function GET(request: NextRequest) {
  try {
    const user = await requireSessionUser(undefined, "payments:read");
    const intentId = request.nextUrl.searchParams.get("intentId")?.trim();
    if (intentId) {
      const intent = await prisma.paymentIntent.findFirst({
        where: { id: intentId, organizationId: user.organizationId },
        select: {
          id: true,
          kind: true,
          status: true,
          amount: true,
          currency: true,
          txHash: true,
          failureReason: true,
          beneficiaryJson: true,
        },
      });
      if (!intent) {
        return NextResponse.json({ error: "Payment not found" }, { status: 404 });
      }
      let fiatAmount: number | null = null;
      let fiatCurrency: string | null = null;
      try {
        const bene = JSON.parse(intent.beneficiaryJson || "{}") as {
          fiatAmount?: number | null;
          fiatCurrency?: string | null;
        };
        if (typeof bene.fiatAmount === "number") fiatAmount = bene.fiatAmount;
        if (typeof bene.fiatCurrency === "string") fiatCurrency = bene.fiatCurrency;
      } catch {
        /* ignore */
      }
      const terminal =
        intent.status === "completed" ||
        intent.status === "exported" ||
        intent.status === "submitted";
      if (terminal && intent.kind === "paj_onramp" && intent.currency === "USDC" && intent.amount > 0) {
        await applyAgentDeposit({
          organizationId: user.organizationId,
          paymentIntentId: intent.id,
          amount: intent.amount,
        });
        await syncWalletBalances(user.organizationId, { trustIncrease: true }).catch(() => null);
      }
      if (terminal && (intent.kind === "paj_offramp" || intent.kind === "direct")) {
        await syncWalletBalances(user.organizationId).catch(() => null);
      }

      return NextResponse.json({
        intent: {
          id: intent.id,
          kind: intent.kind,
          status: intent.status,
          amount: intent.amount,
          currency: intent.currency,
          txHash: intent.txHash,
          failureReason: intent.failureReason,
          fiatAmount,
          fiatCurrency,
        },
      });
    }
    const status = await getPajHomeStatus(user.organizationId);
    return NextResponse.json(status);
  } catch (e) {
    return jsonError(e);
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireSessionUser(["admin", "payer"], "payments:write");
    const body = (await request.json()) as Record<string, unknown>;
    const action = String(body.action || "");

    if (action === "list_banks") {
      const banks = await fetchPajBanksForWorkspace(user.organizationId);
      return NextResponse.json({ banks });
    }

    if (action === "save_bank") {
      const bank = await saveWorkspaceBank({
        organizationId: user.organizationId,
        bankCode: String(body.bankCode || ""),
        accountNumber: String(body.accountNumber || ""),
        actorId: user.id,
      });
      return NextResponse.json({ ok: true, bank });
    }

    if (action === "fund_bank") {
      const result = await startPajOnramp({
        organizationId: user.organizationId,
        fiatAmount: Number(body.fiatAmount ?? body.fiatAmountNgn),
        actorId: user.id,
      });
      return NextResponse.json({
        ok: true,
        intentId: result.intent.id,
        order: result.order,
      });
    }

    if (action === "withdraw") {
      const result = await startPajOfframp({
        organizationId: user.organizationId,
        amountUsdc: Number(body.amountUsdc),
        bankAccountId: body.bankAccountId ? String(body.bankAccountId) : undefined,
        bankCode: body.bankCode ? String(body.bankCode) : undefined,
        accountNumber: body.accountNumber ? String(body.accountNumber) : undefined,
        actorId: user.id,
        mfaCode: body.mfaCode ? String(body.mfaCode) : null,
      });
      return NextResponse.json({
        ok: true,
        intentId: result.intent.id,
        fundingAddress: result.fundingAddress,
      });
    }

    if (action === "pay_client") {
      const result = await payClient({
        organizationId: user.organizationId,
        toAddress: String(body.toAddress || ""),
        amountUsdc: Number(body.amountUsdc),
        interval: body.interval ? String(body.interval) : "once",
        actorId: user.id,
        mfaCode: body.mfaCode ? String(body.mfaCode) : null,
      });
      return NextResponse.json({
        ok: true,
        intentId: result.intent.id,
        recurringId: result.recurring?.id || null,
      });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (e) {
    return jsonError(e);
  }
}
