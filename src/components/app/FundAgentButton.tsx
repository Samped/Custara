"use client";

import { useState } from "react";

const FAUCET_URL = "https://faucet.circle.com/";

/** Open Circle’s public faucet with the agent address copied for paste. */
export function FundAgentButton({
  address,
  disabled,
}: {
  address?: string | null;
  disabled?: boolean;
}) {
  const [message, setMessage] = useState<string | null>(null);

  async function fund() {
    if (disabled || !address) return;
    try {
      await navigator.clipboard.writeText(address);
      setMessage(`Address copied: ${address.slice(0, 6)}…${address.slice(-4)}. Choose ARC + USDC, paste, then Sync.`);
    } catch {
      setMessage(`Paste this address on the faucet: ${address}. Choose ARC + USDC, then Sync.`);
    }
    window.open(FAUCET_URL, "_blank", "noopener,noreferrer");
  }

  return (
    <div>
      <button type="button" className="btn btn-primary" disabled={disabled || !address} onClick={fund}>
        Fund testnet USDC
      </button>
      {message ? <p className="mt-1.5 text-[0.72rem] text-accent">{message}</p> : null}
    </div>
  );
}
