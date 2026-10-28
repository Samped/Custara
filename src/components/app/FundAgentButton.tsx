"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import QRCode from "qrcode";
import { encodeFunctionData, parseUnits } from "viem";
import { useRouter } from "next/navigation";

const FAUCET_URL = "https://faucet.circle.com/";
const ARC_USDC = "0x3600000000000000000000000000000000000000" as const;

const ERC20_TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

type ArcChainProp = "ARC" | "ARC-TESTNET";
type FundMode = "connect" | "scan";

type Eip1193Provider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

type DiscoveredWallet = {
  uuid: string;
  name: string;
  icon?: string;
  provider: Eip1193Provider;
};

type InjectedEthereum = Eip1193Provider & { providers?: Eip1193Provider[] };

function injectedEthereum(): InjectedEthereum | undefined {
  return (window as Window & { ethereum?: InjectedEthereum }).ethereum;
}

function arcNetwork(chain: ArcChainProp) {
  if (chain === "ARC") {
    return {
      chainId: 5042,
      chainIdHex: "0x13b2",
      name: "Arc",
      rpcUrl: "https://rpc.mainnet.arc.io",
      explorer: "https://arc.etherscan.io",
    };
  }
  return {
    chainId: 5042002,
    chainIdHex: "0x4cef52",
    name: "Arc Testnet",
    rpcUrl: "https://rpc.testnet.arc.io",
    explorer: "https://explorer.testnet.arc.io",
  };
}

/** EIP-681 payment URI for Arc USDC (ERC-20 view). Amount optional. */
function buildPaymentUri(input: {
  agentAddress: string;
  usdcAddress: string;
  chain: ArcChainProp;
  amountUsdc?: string;
}) {
  const net = arcNetwork(input.chain);
  const token = input.usdcAddress.toLowerCase();
  const to = input.agentAddress.toLowerCase();
  const trimmed = input.amountUsdc?.trim() || "";
  const value = Number(trimmed);
  if (trimmed && Number.isFinite(value) && value > 0) {
    const atomic = parseUnits(trimmed, 6).toString();
    return `ethereum:${token}@${net.chainId}/transfer?address=${to}&uint256=${atomic}`;
  }
  return `ethereum:${token}@${net.chainId}/transfer?address=${to}`;
}

function discoverWallets(): Promise<DiscoveredWallet[]> {
  return new Promise((resolve) => {
    const found = new Map<string, DiscoveredWallet>();

    function add(wallet: DiscoveredWallet) {
      if (!found.has(wallet.uuid)) found.set(wallet.uuid, wallet);
    }

    const onAnnounce = (event: Event) => {
      const detail = (
        event as CustomEvent<{ info: { uuid: string; name: string; icon?: string }; provider: Eip1193Provider }>
      ).detail;
      if (!detail?.info?.uuid || !detail.provider) return;
      add({
        uuid: detail.info.uuid,
        name: detail.info.name || "Wallet",
        icon: detail.info.icon,
        provider: detail.provider,
      });
    };

    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));

    window.setTimeout(() => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      const injected = injectedEthereum();
      if (found.size === 0 && injected) {
        const providers: Eip1193Provider[] = injected.providers?.length ? injected.providers : [injected];
        providers.forEach((provider: Eip1193Provider, index: number) => {
          add({
            uuid: `injected-${index}`,
            name: index === 0 ? "Browser wallet" : `Browser wallet ${index + 1}`,
            provider,
          });
        });
      }
      resolve([...found.values()]);
    }, 120);
  });
}

async function ensureArcChain(provider: Eip1193Provider, chain: ArcChainProp) {
  const net = arcNetwork(chain);
  const current = String(await provider.request({ method: "eth_chainId" })).toLowerCase();
  if (current === net.chainIdHex) return;

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: net.chainIdHex }],
    });
  } catch (err) {
    const code = typeof err === "object" && err && "code" in err ? Number((err as { code: number }).code) : 0;
    if (code !== 4902 && code !== -32603) throw err;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: net.chainIdHex,
          chainName: net.name,
          nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
          rpcUrls: [net.rpcUrl],
          blockExplorerUrls: [net.explorer],
        },
      ],
    });
  }
}

/** Fund the Circle agent: faucet on testnet, wallet transfer on mainnet. */
export function FundAgentButton({
  address,
  chain = "ARC-TESTNET",
  usdcAddress = ARC_USDC,
  disabled,
  buttonLabel,
  className,
  embedded,
}: {
  address?: string | null;
  chain?: ArcChainProp;
  usdcAddress?: string;
  disabled?: boolean;
  buttonLabel?: string;
  className?: string;
  /** Render wallet/faucet UI inside a parent sheet — no second overlay. */
  embedded?: boolean;
}) {
  const isMainnet = chain === "ARC";
  const router = useRouter();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [mode, setMode] = useState<FundMode>("connect");
  const [wallets, setWallets] = useState<DiscoveredWallet[]>([]);
  const [selected, setSelected] = useState<DiscoveredWallet | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const paymentUri = useMemo(() => {
    if (!address) return "";
    try {
      return buildPaymentUri({
        agentAddress: address,
        usdcAddress,
        chain,
        amountUsdc: amount,
      });
    } catch {
      return `ethereum:${address.toLowerCase()}@${arcNetwork(chain).chainId}`;
    }
  }, [address, amount, chain, usdcAddress]);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open && !embedded) return;
    void discoverWallets().then(setWallets);
    dialogRef.current?.focus();
  }, [open, embedded]);

  useEffect(() => {
    if ((!open && !embedded) || mode !== "scan" || !paymentUri) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(paymentUri, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 220,
      color: { dark: "#0f172a", light: "#ffffff" },
    })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, mode, paymentUri]);

  async function fundTestnet() {
    if (disabled || !address) return;
    try {
      await navigator.clipboard.writeText(address);
      setMessage(
        `Address copied: ${address.slice(0, 6)}…${address.slice(-4)}. Choose ARC + USDC, paste, then Sync.`,
      );
    } catch {
      setMessage(`Paste this address on the faucet: ${address}. Choose ARC + USDC, then Sync.`);
    }
    window.open(FAUCET_URL, "_blank", "noopener,noreferrer");
  }

  function openFundModal() {
    if (disabled || !address) return;
    setError(null);
    setMessage(null);
    setSelected(null);
    setAccount(null);
    setAmount("");
    setMode("connect");
    setOpen(true);
  }

  function closeModal() {
    if (busy) return;
    setOpen(false);
  }

  async function connectWallet(wallet: DiscoveredWallet) {
    setBusy(true);
    setError(null);
    setSelected(wallet);
    try {
      await ensureArcChain(wallet.provider, chain);
      const accounts = (await wallet.provider.request({
        method: "eth_requestAccounts",
      })) as string[];
      const next = accounts[0];
      if (!next) throw new Error("No account selected");
      setAccount(next);
    } catch (e) {
      setAccount(null);
      setError(e instanceof Error ? e.message : "Could not connect wallet");
    } finally {
      setBusy(false);
    }
  }

  async function sendUsdc() {
    if (!selected || !account || !address) return;
    const trimmed = amount.trim();
    const value = Number(trimmed);
    if (!trimmed || !Number.isFinite(value) || value <= 0) {
      setError("Enter a USDC amount greater than zero.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await ensureArcChain(selected.provider, chain);
      const data = encodeFunctionData({
        abi: ERC20_TRANSFER_ABI,
        functionName: "transfer",
        args: [address as `0x${string}`, parseUnits(trimmed, 6)],
      });
      const txHash = (await selected.provider.request({
        method: "eth_sendTransaction",
        params: [
          {
            from: account,
            to: usdcAddress,
            data,
          },
        ],
      })) as string;
      setMessage(`Sent. Tx ${txHash.slice(0, 10)}… — click Sync when confirmed.`);
      setOpen(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Transfer failed");
    } finally {
      setBusy(false);
    }
  }

  async function copyText(text: string, ok: string) {
    try {
      await navigator.clipboard.writeText(text);
      setMessage(ok);
      setError(null);
    } catch {
      setError("Could not copy — select the address manually.");
    }
  }

  if (!isMainnet) {
    if (embedded) {
      return (
        <div className="space-y-3">
          <p className="money-sheet-lead">
            Copy the agent address, open Circle’s faucet, send Arc testnet USDC, then Sync.
          </p>
          <div className="money-addr">
            <code>{address || "Wallet not ready"}</code>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={disabled || !address || busy}
              onClick={() => void copyText(address || "", "Address copied.")}
            >
              Copy
            </button>
          </div>
          <button
            type="button"
            className="btn btn-primary w-full"
            disabled={disabled || !address}
            onClick={fundTestnet}
          >
            Open Circle faucet
          </button>
          {message ? <p className="money-note money-note--ok">{message}</p> : null}
          {error ? <p className="money-note money-note--err">{error}</p> : null}
        </div>
      );
    }
    return (
      <div>
        <button type="button" className={className || "btn btn-primary"} disabled={disabled || !address} onClick={fundTestnet}>
          {buttonLabel || "Fund testnet USDC"}
        </button>
        {message ? <p className="mt-1.5 text-[0.72rem] text-accent">{message}</p> : null}
      </div>
    );
  }

  const walletBody = (
    <>
        <div className="fund-mode-tabs" role="tablist" aria-label="Funding method">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "connect"}
            className={`fund-mode-tab${mode === "connect" ? " is-active" : ""}`}
            disabled={busy}
            onClick={() => {
              setMode("connect");
              setError(null);
            }}
          >
            Connect wallet
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "scan"}
            className={`fund-mode-tab${mode === "scan" ? " is-active" : ""}`}
            disabled={busy}
            onClick={() => {
              setMode("scan");
              setError(null);
            }}
          >
            Scan &amp; send
          </button>
        </div>

        {mode === "connect" ? (
          <>
            <div className="fund-wallet-list" role="listbox" aria-label="Wallets">
              {wallets.length === 0 ? (
                <p className="dash-mini-meta">
                  No wallet detected. Install MetaMask, Rabby, or Coinbase Wallet — or use Scan &amp; send on your phone.
                </p>
              ) : (
                wallets.map((wallet) => {
                  const active = selected?.uuid === wallet.uuid;
                  return (
                    <button
                      key={wallet.uuid}
                      type="button"
                      role="option"
                      aria-selected={active}
                      className={`fund-wallet-option${active ? " is-active" : ""}`}
                      disabled={busy}
                      onClick={() => void connectWallet(wallet)}
                    >
                      {wallet.icon ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={wallet.icon} alt="" width={22} height={22} className="fund-wallet-icon" />
                      ) : (
                        <span className="fund-wallet-icon fund-wallet-icon-fallback" aria-hidden />
                      )}
                      <span className="fund-wallet-name">{wallet.name}</span>
                      {active && account ? (
                        <span className="fund-wallet-addr">
                          {account.slice(0, 6)}…{account.slice(-4)}
                        </span>
                      ) : (
                        <span className="fund-wallet-addr">{active ? "Connecting…" : "Connect"}</span>
                      )}
                    </button>
                  );
                })
              )}
            </div>

            <label className="wallet-field mt-3">
              <span className="dash-mini-label">Amount (USDC)</span>
              <input
                className="input"
                inputMode="decimal"
                placeholder="100.00"
                value={amount}
                disabled={busy || !account}
                onChange={(event) => setAmount(event.target.value)}
              />
            </label>
          </>
        ) : (
          <div className="fund-scan-panel">
            <p className="dash-mini-meta">
              Open your mobile wallet, scan this QR on Arc, then Sync after the transfer confirms.
            </p>
            <label className="wallet-field mt-3">
              <span className="dash-mini-label">Amount (USDC, optional)</span>
              <input
                className="input"
                inputMode="decimal"
                placeholder="Leave blank to enter on phone"
                value={amount}
                disabled={busy}
                onChange={(event) => setAmount(event.target.value)}
              />
            </label>
            <div className="fund-qr-wrap">
              {qrDataUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={qrDataUrl} alt="Scan to send USDC to agent" className="fund-qr-img" width={220} height={220} />
              ) : (
                <p className="dash-mini-meta">Generating QR…</p>
              )}
            </div>
            <p className="fund-scan-address font-mono" title={address || undefined}>
              {address}
            </p>
            <div className="fund-scan-actions">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy || !address}
                onClick={() => void copyText(address || "", "Agent address copied.")}
              >
                Copy address
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy || !paymentUri}
                onClick={() => void copyText(paymentUri, "Payment link copied.")}
              >
                Copy payment link
              </button>
            </div>
          </div>
        )}

        {error ? <p className="upload-modal-error">{error}</p> : null}

        <div className="upload-modal-actions">
          {embedded ? null : (
            <button type="button" className="btn btn-secondary" onClick={closeModal} disabled={busy}>
              {mode === "scan" ? "Done" : "Cancel"}
            </button>
          )}
          {mode === "connect" ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !account || !amount.trim()}
              onClick={() => void sendUsdc()}
            >
              {busy ? "Working…" : "Send USDC"}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                setMessage("After your phone confirms the transfer, click Sync.");
                router.refresh();
              }}
            >
              I sent it — Sync next
            </button>
          )}
        </div>
    </>
  );

  if (embedded) {
    return (
      <div>
        <p className="money-sheet-lead mb-3">
          Send USDC on Arc to{" "}
          <span className="font-mono text-foreground">
            {address?.slice(0, 6)}…{address?.slice(-4)}
          </span>
        </p>
        {walletBody}
      </div>
    );
  }

  const dialog = open ? (
    <div className="upload-modal-root" onMouseDown={closeModal}>
      <div
        ref={dialogRef}
        className="upload-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="upload-modal-head">
          <div>
            <p className="dash-kicker">Agent</p>
            <h2 id={titleId} className="upload-modal-title">
              Fund agent
            </h2>
            <p className="upload-modal-sub">
              Send real USDC on Arc to{" "}
              <span className="font-mono">
                {address?.slice(0, 6)}…{address?.slice(-4)}
              </span>
            </p>
          </div>
          <button type="button" className="upload-modal-close" onClick={closeModal} disabled={busy} aria-label="Close">
            Close
          </button>
        </div>
        {walletBody}
      </div>
    </div>
  ) : null;

  return (
    <div>
      <button type="button" className={className || "btn btn-primary"} disabled={disabled || !address} onClick={openFundModal}>
        {buttonLabel || "Fund agent"}
      </button>
      {message ? <p className="mt-1.5 text-[0.72rem] text-accent">{message}</p> : null}
      {mounted && dialog ? createPortal(dialog, document.body) : null}
    </div>
  );
}
