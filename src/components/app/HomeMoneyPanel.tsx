"use client";

import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { FundAgentButton } from "@/components/app/FundAgentButton";
import { isMfaSetupRequiredError } from "@/domain/payStepUp";
import type { ArcChain } from "@/domain/arc/config";

type BankRow = {
  id: string;
  bankCode: string;
  accountNumber: string;
  accountName: string;
  currency: string;
};

type Sheet = "fund" | "withdraw" | "pay" | null;
type FundMode = "choose" | "wallet" | "bank";

function IconPlus() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M8 3.2v9.6M3.2 8h9.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function IconOut() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M8 3.2v9.6M4.4 6.2 8 3.2l3.6 3"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconSend() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M2.6 8h10.8M9.6 4.2 13.4 8l-3.8 3.8"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconWallet() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
      <rect x="2.4" y="4.2" width="13.2" height="10.2" rx="2.2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M11.2 9.3h3.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconBank() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
      <path d="M3 7.2 9 3.4l6 3.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4.2 7.8v5.4M9 7.8v5.4M13.8 7.8v5.4M3 13.8h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconX() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path d="M3.2 3.2 10.8 10.8M10.8 3.2 3.2 10.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconChev() {
  return (
    <svg className="money-choice-go" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M6 3.6 10.4 8 6 12.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function HomeMoneyPanel({
  showBankRails,
  fiatCurrency,
  canPay,
  agentAddress,
  chain,
  usdcAddress,
  pajConfigured,
  banks,
  mfaEnabled,
}: {
  showBankRails: boolean;
  fiatCurrency: string;
  canPay: boolean;
  agentAddress?: string | null;
  chain: ArcChain;
  usdcAddress: string;
  pajConfigured: boolean;
  banks: BankRow[];
  mfaEnabled: boolean;
}) {
  const router = useRouter();
  const titleId = useId();
  const [mounted, setMounted] = useState(false);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [fundMode, setFundMode] = useState<FundMode>("choose");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [virtual, setVirtual] = useState<{
    accountNumber?: string;
    accountName?: string;
    bank?: string;
    fiatAmount?: number;
  } | null>(null);
  const [savedBanks, setSavedBanks] = useState(banks);
  const [pajBanks, setPajBanks] = useState<Array<{ code: string; name: string }>>([]);
  const [fiatAmount, setFiatAmount] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [bankAccountId, setBankAccountId] = useState(banks[0]?.id || "");
  const [newBankCode, setNewBankCode] = useState("");
  const [newAccountNumber, setNewAccountNumber] = useState("");
  const [clientAddress, setClientAddress] = useState("");
  const [clientAmount, setClientAmount] = useState("");
  const [interval, setInterval] = useState("once");
  const [mfaCode, setMfaCode] = useState("");
  const [mfaBlocked, setMfaBlocked] = useState(false);

  useEffect(() => setMounted(true), []);

  if (!canPay) return null;

  function close() {
    if (busy) return;
    setSheet(null);
    setFundMode("choose");
    setError(null);
    setMessage(null);
    setVirtual(null);
    setMfaCode("");
  }

  function openSheet(next: Sheet) {
    setError(null);
    setMessage(null);
    setVirtual(null);
    setFundMode("choose");
    setSheet(next);
  }

  async function post(action: string, extra: Record<string, unknown> = {}) {
    const res = await fetch("/api/app/home-rails", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ action, ...extra }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      intentId?: string;
      order?: typeof virtual;
      banks?: Array<{ code: string; name: string }>;
      bank?: BankRow;
    };
    if (!res.ok) {
      if (isMfaSetupRequiredError(data.error || "")) {
        setMfaBlocked(true);
      }
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    return data;
  }

  async function loadBanks() {
    if (!pajConfigured || pajBanks.length) return;
    try {
      const data = await post("list_banks");
      setPajBanks(data.banks || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load banks");
    }
  }

  async function fundBank() {
    setBusy(true);
    setError(null);
    try {
      const data = await post("fund_bank", { fiatAmount: Number(fiatAmount) });
      setVirtual(data.order || null);
      setMessage(`Pay this exact ${fiatCurrency} amount. USDC credits the agent after PAJ confirms.`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Fund failed");
    } finally {
      setBusy(false);
    }
  }

  async function withdraw() {
    setBusy(true);
    setError(null);
    try {
      await post("withdraw", {
        amountUsdc: Number(withdrawAmount),
        bankAccountId: bankAccountId || undefined,
        bankCode: !bankAccountId ? newBankCode : undefined,
        accountNumber: !bankAccountId ? newAccountNumber : undefined,
        mfaCode: mfaCode || undefined,
      });
      setMessage(`Withdraw queued. ${fiatCurrency} lands after the Arc transfer confirms.`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Withdraw failed");
    } finally {
      setBusy(false);
    }
  }

  async function sendClient() {
    setBusy(true);
    setError(null);
    try {
      await post("pay_client", {
        toAddress: clientAddress,
        amountUsdc: Number(clientAmount),
        interval,
        mfaCode: mfaCode || undefined,
      });
      setMessage(interval === "once" ? "Client payout queued." : "First payout queued. Later runs follow the schedule.");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Pay client failed");
    } finally {
      setBusy(false);
    }
  }

  async function saveBank() {
    setBusy(true);
    setError(null);
    try {
      const data = await post("save_bank", { bankCode: newBankCode, accountNumber: newAccountNumber });
      if (data.bank) {
        setSavedBanks((prev) => {
          const next = prev.filter((b) => b.id !== data.bank!.id);
          return [data.bank!, ...next];
        });
        setBankAccountId(data.bank.id);
        setNewBankCode("");
        setNewAccountNumber("");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save bank");
    } finally {
      setBusy(false);
    }
  }

  const title = sheet === "fund" ? "Fund" : sheet === "withdraw" ? "Withdraw" : "Pay client";
  const lead =
    sheet === "fund"
      ? "Add USDC to the workspace payment wallet."
      : sheet === "withdraw"
        ? `Send agent USDC to a local bank. PAJ pays out in ${fiatCurrency}.`
        : "Send USDC from the agent wallet to any address.";

  const dialog =
    sheet && mounted ? (
      <div className="money-sheet-root" onMouseDown={close}>
        <div
          className="money-sheet"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="money-sheet-head">
            <div>
              <p className="dash-kicker">Money</p>
              <h2 id={titleId} className="money-sheet-title">
                {title}
              </h2>
              <p className="money-sheet-lead">{lead}</p>
            </div>
            <button type="button" className="money-sheet-x" onClick={close} disabled={busy} aria-label="Close">
              <IconX />
            </button>
          </div>

          {sheet === "fund" && fundMode !== "choose" ? (
            <button
              type="button"
              className="money-back"
              disabled={busy}
              onClick={() => {
                setFundMode("choose");
                setError(null);
                setMessage(null);
              }}
            >
              ← All methods
            </button>
          ) : null}

          {sheet === "fund" && fundMode === "choose" ? (
            <div className="money-choices">
              <button
                type="button"
                className="money-choice"
                disabled={!agentAddress}
                onClick={() => {
                  setFundMode("wallet");
                  setError(null);
                }}
              >
                <span className="money-choice-icon">
                  <IconWallet />
                </span>
                <span>
                  <span className="money-choice-title">Wallet</span>
                  <p className="money-choice-copy">
                    {chain === "ARC"
                      ? "Connect a browser wallet or scan a QR on Arc."
                      : "Copy the agent address and mint testnet USDC."}
                  </p>
                </span>
                <IconChev />
              </button>
              {showBankRails ? (
                <button
                  type="button"
                  className="money-choice"
                  onClick={() => {
                    setFundMode("bank");
                    setError(null);
                  }}
                >
                  <span className="money-choice-icon">
                    <IconBank />
                  </span>
                  <span>
                    <span className="money-choice-title">Local bank</span>
                    <p className="money-choice-copy">
                      Pay {fiatCurrency} to a one-time virtual account. USDC arrives on Arc.
                    </p>
                  </span>
                  <IconChev />
                </button>
              ) : null}
            </div>
          ) : null}

          {sheet === "fund" && fundMode === "wallet" ? (
            <FundAgentButton
              embedded
              address={agentAddress}
              chain={chain}
              usdcAddress={usdcAddress}
              disabled={!agentAddress}
            />
          ) : null}

          {sheet === "fund" && fundMode === "bank" ? (
            <div className="space-y-3">
              {!pajConfigured ? (
                <p className="money-sheet-lead">Bank rails not configured. Add PAJ_API_KEY on the server.</p>
              ) : virtual ? (
                <dl className="money-virt">
                  <div className="money-virt-row">
                    <dt>Bank</dt>
                    <dd>{virtual.bank || "—"}</dd>
                  </div>
                  <div className="money-virt-row">
                    <dt>Account</dt>
                    <dd className="font-mono">{virtual.accountNumber || "—"}</dd>
                  </div>
                  <div className="money-virt-row">
                    <dt>Name</dt>
                    <dd>{virtual.accountName || "—"}</dd>
                  </div>
                  <div className="money-virt-row">
                    <dt>Pay exactly</dt>
                    <dd>
                      {virtual.fiatAmount != null
                        ? new Intl.NumberFormat("en", { style: "currency", currency: fiatCurrency }).format(
                            virtual.fiatAmount,
                          )
                        : "—"}
                    </dd>
                  </div>
                </dl>
              ) : (
                <>
                  <label className="wallet-field">
                    <span className="dash-mini-label">Amount</span>
                    <div className="money-amount">
                      <span className="money-amount-affix">{fiatCurrency}</span>
                      <input
                        className="input"
                        inputMode="decimal"
                        value={fiatAmount}
                        disabled={busy}
                        onChange={(e) => setFiatAmount(e.target.value)}
                        placeholder="150,000"
                      />
                    </div>
                  </label>
                  <button
                    type="button"
                    className="btn btn-primary w-full"
                    disabled={busy || !fiatAmount.trim()}
                    onClick={() => void fundBank()}
                  >
                    {busy ? "Opening…" : "Get virtual account"}
                  </button>
                </>
              )}
            </div>
          ) : null}

          {sheet === "withdraw" ? (
            <div className="space-y-3">
              {!pajConfigured ? (
                <p className="money-sheet-lead">Bank rails not configured. Add PAJ_API_KEY on the server.</p>
              ) : (
                <>
                  <label className="wallet-field">
                    <span className="dash-mini-label">Amount</span>
                    <div className="money-amount">
                      <span className="money-amount-affix">USDC</span>
                      <input
                        className="input"
                        inputMode="decimal"
                        value={withdrawAmount}
                        disabled={busy}
                        onChange={(e) => setWithdrawAmount(e.target.value)}
                        placeholder="25.00"
                      />
                    </div>
                  </label>
                  {savedBanks.length ? (
                    <label className="wallet-field">
                      <span className="dash-mini-label">Saved bank</span>
                      <select
                        className="input"
                        value={bankAccountId}
                        disabled={busy}
                        onChange={(e) => setBankAccountId(e.target.value)}
                      >
                        {savedBanks.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.accountName} · {b.accountNumber}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <div className="space-y-2">
                      <label className="wallet-field">
                        <span className="dash-mini-label">Bank</span>
                        <select
                          className="input"
                          value={newBankCode}
                          disabled={busy}
                          onFocus={() => void loadBanks()}
                          onChange={(e) => setNewBankCode(e.target.value)}
                        >
                          <option value="">Select bank</option>
                          {pajBanks.map((b) => (
                            <option key={b.code} value={b.code}>
                              {b.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="wallet-field">
                        <span className="dash-mini-label">Account number</span>
                        <input
                          className="input"
                          value={newAccountNumber}
                          disabled={busy}
                          onChange={(e) => setNewAccountNumber(e.target.value)}
                          placeholder="0123456789"
                        />
                      </label>
                      <button type="button" className="btn btn-secondary w-full" disabled={busy} onClick={() => void saveBank()}>
                        Confirm account
                      </button>
                    </div>
                  )}
                  {mfaEnabled ? (
                    <label className="wallet-field">
                      <span className="dash-mini-label">MFA code</span>
                      <input
                        className="input"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        value={mfaCode}
                        disabled={busy}
                        onChange={(e) => setMfaCode(e.target.value)}
                        placeholder="6-digit TOTP"
                      />
                    </label>
                  ) : mfaBlocked ? (
                    <p className="money-note money-note--err">Set up MFA in Security before withdrawing at this amount.</p>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn-primary w-full"
                    disabled={busy || !withdrawAmount.trim()}
                    onClick={() => void withdraw()}
                  >
                    {busy ? "Working…" : "Withdraw"}
                  </button>
                </>
              )}
            </div>
          ) : null}

          {sheet === "pay" ? (
            <div className="space-y-3">
              <label className="wallet-field">
                <span className="dash-mini-label">Wallet address</span>
                <input
                  className="input font-mono"
                  value={clientAddress}
                  disabled={busy}
                  onChange={(e) => setClientAddress(e.target.value)}
                  placeholder="0x…"
                />
              </label>
              <label className="wallet-field">
                <span className="dash-mini-label">Amount</span>
                <div className="money-amount">
                  <span className="money-amount-affix">USDC</span>
                  <input
                    className="input"
                    inputMode="decimal"
                    value={clientAmount}
                    disabled={busy}
                    onChange={(e) => setClientAmount(e.target.value)}
                    placeholder="10.00"
                  />
                </div>
              </label>
              <label className="wallet-field">
                <span className="dash-mini-label">Schedule</span>
                <select className="input" value={interval} disabled={busy} onChange={(e) => setInterval(e.target.value)}>
                  <option value="once">One-time</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </select>
              </label>
              {mfaEnabled ? (
                <label className="wallet-field">
                  <span className="dash-mini-label">MFA code</span>
                  <input
                    className="input"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={mfaCode}
                    disabled={busy}
                    onChange={(e) => setMfaCode(e.target.value)}
                    placeholder="6-digit TOTP"
                  />
                </label>
              ) : mfaBlocked ? (
                <p className="money-note money-note--err">Set up MFA in Security before paying at this amount.</p>
              ) : null}
              <button
                type="button"
                className="btn btn-primary w-full"
                disabled={busy || !clientAddress.trim() || !clientAmount.trim()}
                onClick={() => void sendClient()}
              >
                {busy ? "Working…" : "Send"}
              </button>
            </div>
          ) : null}

          {error ? <p className="money-note money-note--err">{error}</p> : null}
          {message ? <p className="money-note money-note--ok">{message}</p> : null}
        </div>
      </div>
    ) : null;

  return (
    <section className="dash-panel money-rail">
      <div className="money-rail-head">
        <h2 className="dash-h">Money</h2>
        <div className="money-actions">
          {showBankRails ? (
            <>
              <button type="button" className="money-action money-action--primary" onClick={() => openSheet("fund")}>
                <span className="money-action-icon">
                  <IconPlus />
                </span>
                Fund
              </button>
              <button type="button" className="money-action" onClick={() => openSheet("withdraw")}>
                <span className="money-action-icon">
                  <IconOut />
                </span>
                Withdraw
              </button>
            </>
          ) : null}
          <button type="button" className="money-action" onClick={() => openSheet("pay")}>
            <span className="money-action-icon">
              <IconSend />
            </span>
            Pay client
          </button>
        </div>
      </div>
      {dialog ? createPortal(dialog, document.body) : null}
    </section>
  );
}
