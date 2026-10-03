"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";

async function postWalletAction(body: Record<string, unknown>) {
  const res = await fetch("/api/app/wallets", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
    };
  }
}

export function ConnectTreasuryButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      if (!window.ethereum) {
        throw new Error("No browser wallet found. Use manual address link below, or install MetaMask.");
      }
      const accounts = (await window.ethereum.request({
        method: "eth_requestAccounts",
      })) as string[];
      const address = accounts[0];
      if (!address) throw new Error("No account selected");

      const challenge = (await postWalletAction({ action: "challenge" })) as {
        message: string;
        nonce: string;
      };
      const signature = (await window.ethereum.request({
        method: "personal_sign",
        params: [challenge.message, address],
      })) as string;

      await postWalletAction({
        action: "verify",
        address,
        signature,
        message: challenge.message,
      });
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Connect failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button type="button" className="btn btn-black" disabled={busy} onClick={connect}>
        {busy ? "Connecting…" : "Connect wallet"}
      </button>
      {error ? <p className="mt-1.5 text-[0.72rem] text-danger">{error}</p> : null}
    </div>
  );
}

export function WalletJsonForm({
  action,
  children,
  className,
  extraFields,
  onSuccess,
}: {
  action: string;
  children: ReactNode;
  className?: string;
  extraFields?: Record<string, unknown>;
  onSuccess?: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const form = event.currentTarget;
      const fd = new FormData(form);
      const payload: Record<string, unknown> = { action, ...extraFields };
      fd.forEach((value, key) => {
        if (key === "freeze") payload.freeze = value === "true";
        else if (key === "dailySpendLimitUsd") payload.dailySpendLimitUsd = Number(value);
        else payload[key] = String(value);
      });
      await postWalletAction(payload);
      form.reset();
      onSuccess?.();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className={className}>
      {children}
      {error ? <p className="mt-1.5 text-[0.72rem] text-danger">{error}</p> : null}
      {busy ? <p className="mt-1 text-[0.65rem] text-muted">Working…</p> : null}
    </form>
  );
}
