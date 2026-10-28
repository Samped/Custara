"use client";

import { useEffect, useId, useRef, useState } from "react";
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

type VirtualOrder = {
  accountNumber?: string;
  accountName?: string;
  bank?: string;
  fiatAmount?: number;
  fiatCurrency?: string;
  usdcAmount?: number | null;
};

type TrackedIntent = {
  id: string;
  kind: "paj_onramp" | "paj_offramp" | "direct";
  label: string;
};

type DoneState = {
  title: string;
  amountLabel: string;
  detail: string;
  kind: TrackedIntent["kind"];
};

type IntentStatus = {
  id: string;
  kind: string;
  status: string;
  amount: number;
  currency: string;
  txHash?: string | null;
  failureReason?: string | null;
  fiatAmount?: number | null;
  fiatCurrency?: string | null;
};

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

function IconCheck() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden>
      <circle cx="14" cy="14" r="13" stroke="currentColor" strokeWidth="1.6" opacity="0.35" />
      <path
        d="M8.2 14.2 12.1 18l7.7-8.2"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function formatMoneyAmount(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toLocaleString("en")} ${currency}`;
  }
}

function formatUsdc(amount: number) {
  return `${amount.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 6 })} USDC`;
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
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [mounted, setMounted] = useState(false);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [fundMode, setFundMode] = useState<FundMode>("choose");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [virtual, setVirtual] = useState<VirtualOrder | null>(null);
  const [tracked, setTracked] = useState<TrackedIntent | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [done, setDone] = useState<DoneState | null>(null);
  const [savedBanks, setSavedBanks] = useState(banks);
  const [pajBanks, setPajBanks] = useState<Array<{ code: string; name: string }>>([]);
  const [fiatAmount, setFiatAmount] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [bankAccountId, setBankAccountId] = useState(banks[0]?.id || "");
  const [newBankCode, setNewBankCode] = useState("");
  const [newAccountNumber, setNewAccountNumber] = useState("");
  const [clientAddress, setClientAddress] = useState("");
  const [clientAmount, setClientAmount] = useState("");
  const [interval, setIntervalState] = useState("once");
  const [mfaCode, setMfaCode] = useState("");
  const [mfaBlocked, setMfaBlocked] = useState(false);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  if (!canPay) return null;

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  function resetFlow() {
    stopPolling();
    setFundMode("choose");
    setError(null);
    setMessage(null);
    setVirtual(null);
    setTracked(null);
    setWaiting(false);
    setDone(null);
    setMfaCode("");
    setFiatAmount("");
    setWithdrawAmount("");
    setClientAddress("");
    setClientAmount("");
    setIntervalState("once");
  }

  function close() {
    if (busy && !done) return;
    const shouldRefresh = Boolean(done);
    setSheet(null);
    resetFlow();
    if (shouldRefresh) router.refresh();
  }

  function finishDone() {
    setSheet(null);
    resetFlow();
    router.refresh();
  }

  function openSheet(next: Sheet) {
    resetFlow();
    setSheet(next);
  }

  async function refreshHomeBalances() {
    try {
      await fetch("/api/app/wallets", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ action: "sync" }),
      });
    } catch {
      /* Home still refreshes from the last known balance. */
    }
    router.refresh();
  }

  function markDoneFromIntent(intent: IntentStatus, kind: TrackedIntent["kind"]) {
    stopPolling();
    setWaiting(false);
    setVirtual(null);
    setTracked(null);
    setMessage(null);
    setError(null);

    if (kind === "paj_onramp") {
      const usdc = intent.currency === "USDC" ? intent.amount : Number(intent.amount) || 0;
      const fiat =
        intent.fiatAmount != null
          ? formatMoneyAmount(intent.fiatAmount, intent.fiatCurrency || fiatCurrency)
          : null;
      setDone({
        kind,
        title: "Funded",
        amountLabel: formatUsdc(usdc),
        detail: fiat
          ? `${fiat} received. USDC is on the payment wallet — you can pay bills now.`
          : "USDC is on the payment wallet — you can pay bills now.",
      });
      void refreshHomeBalances();
      return;
    }

    if (kind === "paj_offramp") {
      setDone({
        kind,
        title: "Withdraw sent",
        amountLabel: formatUsdc(intent.amount),
        detail: `${fiatCurrency} is on the way to your bank. Keep this receipt if you need the transfer hash.`,
      });
      void refreshHomeBalances();
      return;
    }

    setDone({
      kind,
      title: "Paid",
      amountLabel: formatUsdc(intent.amount),
      detail: "USDC left the payment wallet for the client address.",
    });
    void refreshHomeBalances();
  }

  function startTracking(next: TrackedIntent) {
    stopPolling();
    setTracked(next);
    setWaiting(true);
    setError(null);

    const tick = async () => {
      try {
        const res = await fetch(`/api/app/home-rails?intentId=${encodeURIComponent(next.id)}`, {
          credentials: "include",
          headers: { accept: "application/json" },
        });
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
          intent?: IntentStatus;
        };
        if (!res.ok || !data.intent) return;
        const intent = data.intent;
        if (intent.status === "completed" || intent.status === "exported" || intent.status === "submitted") {
          markDoneFromIntent(intent, next.kind);
          return;
        }
        if (intent.status === "failed") {
          stopPolling();
          setWaiting(false);
          setTracked(null);
          setError(intent.failureReason || `${next.label} failed`);
        }
      } catch {
        /* keep polling */
      }
    };

    void tick();
    pollRef.current = setInterval(() => void tick(), 2500);
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
      order?: VirtualOrder;
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
      setMessage(`Pay this exact ${fiatCurrency} amount. We will mark Funded when PAJ confirms.`);
      if (data.intentId) {
        startTracking({ id: data.intentId, kind: "paj_onramp", label: "Fund" });
      }
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
      const data = await post("withdraw", {
        amountUsdc: Number(withdrawAmount),
        bankAccountId: bankAccountId || undefined,
        bankCode: !bankAccountId ? newBankCode : undefined,
        accountNumber: !bankAccountId ? newAccountNumber : undefined,
        mfaCode: mfaCode || undefined,
      });
      setMessage(`Sending ${formatUsdc(Number(withdrawAmount))}. Waiting for the transfer to finish…`);
      if (data.intentId) {
        startTracking({ id: data.intentId, kind: "paj_offramp", label: "Withdraw" });
      }
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
      const data = await post("pay_client", {
        toAddress: clientAddress,
        amountUsdc: Number(clientAmount),
        interval,
        mfaCode: mfaCode || undefined,
      });
      setMessage(
        interval === "once"
          ? "Sending to the client. Waiting for confirmation…"
          : "First payout is sending. Later runs follow the schedule.",
      );
      if (data.intentId) {
        startTracking({ id: data.intentId, kind: "direct", label: "Pay client" });
      }
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

  const title = done
    ? done.title
    : sheet === "fund"
      ? "Fund"
      : sheet === "withdraw"
        ? "Withdraw"
        : "Pay client";
  const lead = done
    ? done.detail
    : sheet === "fund"
      ? "Add USDC to the workspace payment wallet."
      : sheet === "withdraw"
        ? `Send agent USDC to a local bank. PAJ pays out in ${fiatCurrency}.`
        : "Send USDC from the agent wallet to any address.";

  const showForms = !done;
  const lockForms = waiting || busy;

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
            <button
              type="button"
              className="money-sheet-x"
              onClick={close}
              disabled={busy && !done}
              aria-label="Close"
            >
              <IconX />
            </button>
          </div>

          {done ? (
            <div className="money-done">
              <div className="money-done-mark" aria-hidden>
                <IconCheck />
              </div>
              <p className="money-done-amount">{done.amountLabel}</p>
              <p className="money-done-copy">{done.detail}</p>
              <button type="button" className="btn btn-primary w-full" onClick={finishDone}>
                Continue
              </button>
            </div>
          ) : null}

          {showForms && sheet === "fund" && fundMode !== "choose" && !waiting ? (
            <button
              type="button"
              className="money-back"
              disabled={lockForms}
              onClick={() => {
                setFundMode("choose");
                setError(null);
                setMessage(null);
                setVirtual(null);
              }}
            >
              ← All methods
            </button>
          ) : null}

          {showForms && sheet === "fund" && fundMode === "choose" ? (
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

          {showForms && sheet === "fund" && fundMode === "wallet" ? (
            <FundAgentButton
              embedded
              address={agentAddress}
              chain={chain}
              usdcAddress={usdcAddress}
              disabled={!agentAddress}
              onFunded={(amountUsdc) => {
                setDone({
                  kind: "paj_onramp",
                  title: "Funded",
                  amountLabel: formatUsdc(amountUsdc),
                  detail: "USDC is on the payment wallet — you can pay bills now.",
                });
                void (async () => {
                  for (let i = 0; i < 6; i++) {
                    await refreshHomeBalances();
                    await new Promise((r) => setTimeout(r, 2500));
                  }
                })();
              }}
            />
          ) : null}

          {showForms && sheet === "fund" && fundMode === "bank" ? (
            <div className="space-y-3">
              {!pajConfigured ? (
                <p className="money-sheet-lead">Bank rails not configured. Add PAJ_API_KEY on the server.</p>
              ) : virtual ? (
                <>
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
                          ? formatMoneyAmount(virtual.fiatAmount, virtual.fiatCurrency || fiatCurrency)
                          : "—"}
                      </dd>
                    </div>
                  </dl>
                  {waiting ? (
                    <div className="money-wait" role="status" aria-live="polite">
                      <span className="money-wait-dot" aria-hidden />
                      <div>
                        <p className="money-wait-title">Waiting for your bank transfer</p>
                        <p className="money-wait-copy">
                          Keep this open. When PAJ confirms, we show Funded with the USDC amount.
                        </p>
                      </div>
                    </div>
                  ) : null}
                </>
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
                        disabled={lockForms}
                        onChange={(e) => setFiatAmount(e.target.value)}
                        placeholder="150,000"
                      />
                    </div>
                  </label>
                  <button
                    type="button"
                    className="btn btn-primary w-full"
                    disabled={lockForms || !fiatAmount.trim()}
                    onClick={() => void fundBank()}
                  >
                    {busy ? "Opening…" : "Get virtual account"}
                  </button>
                </>
              )}
            </div>
          ) : null}

          {showForms && sheet === "withdraw" ? (
            <div className="space-y-3">
              {!pajConfigured ? (
                <p className="money-sheet-lead">Bank rails not configured. Add PAJ_API_KEY on the server.</p>
              ) : waiting ? (
                <div className="money-wait" role="status" aria-live="polite">
                  <span className="money-wait-dot" aria-hidden />
                  <div>
                    <p className="money-wait-title">Sending withdraw</p>
                    <p className="money-wait-copy">
                      Transferring USDC to PAJ. We will show the amount when it completes.
                    </p>
                  </div>
                </div>
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
                        disabled={lockForms}
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
                        disabled={lockForms}
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
                          disabled={lockForms}
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
                          disabled={lockForms}
                          onChange={(e) => setNewAccountNumber(e.target.value)}
                          placeholder="0123456789"
                        />
                      </label>
                      <button
                        type="button"
                        className="btn btn-secondary w-full"
                        disabled={lockForms}
                        onClick={() => void saveBank()}
                      >
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
                        disabled={lockForms}
                        onChange={(e) => setMfaCode(e.target.value)}
                        placeholder="6-digit TOTP"
                      />
                    </label>
                  ) : mfaBlocked ? (
                    <p className="money-note money-note--err">
                      Set up MFA in Security before withdrawing at this amount.
                    </p>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn-primary w-full"
                    disabled={lockForms || !withdrawAmount.trim()}
                    onClick={() => void withdraw()}
                  >
                    {busy ? "Working…" : "Withdraw"}
                  </button>
                </>
              )}
            </div>
          ) : null}

          {showForms && sheet === "pay" ? (
            <div className="space-y-3">
              {waiting ? (
                <div className="money-wait" role="status" aria-live="polite">
                  <span className="money-wait-dot" aria-hidden />
                  <div>
                    <p className="money-wait-title">Paying client</p>
                    <p className="money-wait-copy">Waiting for the Arc transfer to confirm.</p>
                  </div>
                </div>
              ) : (
                <>
                  <label className="wallet-field">
                    <span className="dash-mini-label">Wallet address</span>
                    <input
                      className="input font-mono"
                      value={clientAddress}
                      disabled={lockForms}
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
                        disabled={lockForms}
                        onChange={(e) => setClientAmount(e.target.value)}
                        placeholder="10.00"
                      />
                    </div>
                  </label>
                  <label className="wallet-field">
                    <span className="dash-mini-label">Schedule</span>
                    <select
                      className="input"
                      value={interval}
                      disabled={lockForms}
                      onChange={(e) => setIntervalState(e.target.value)}
                    >
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
                        disabled={lockForms}
                        onChange={(e) => setMfaCode(e.target.value)}
                        placeholder="6-digit TOTP"
                      />
                    </label>
                  ) : mfaBlocked ? (
                    <p className="money-note money-note--err">
                      Set up MFA in Security before paying at this amount.
                    </p>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn-primary w-full"
                    disabled={lockForms || !clientAddress.trim() || !clientAmount.trim()}
                    onClick={() => void sendClient()}
                  >
                    {busy ? "Working…" : "Send"}
                  </button>
                </>
              )}
            </div>
          ) : null}

          {!done && error ? <p className="money-note money-note--err">{error}</p> : null}
          {!done && message && !waiting ? <p className="money-note money-note--ok">{message}</p> : null}
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
