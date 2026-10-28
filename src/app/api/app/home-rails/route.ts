import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireSessionUser } from "@/lib/auth";
import {
  fetchPajBanksForWorkspace,
  getPajHomeStatus,
  saveWorkspaceBank,
  startPajOfframp,
  startPajOnramp,
} from "@/domain/banking/pajRails";
import { payClient } from "@/domain/directPayout";
import { isMfaSetupRequiredError } from "@/domain/payStepUp";

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

export async function GET() {
  try {
    const user = await requireSessionUser(undefined, "payments:read");
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
