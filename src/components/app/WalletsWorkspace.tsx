import { prisma } from "@/lib/db";
import { ConnectTreasuryButton, WalletJsonForm } from "@/components/app/ConnectTreasuryButton";
import { FundAgentButton } from "@/components/app/FundAgentButton";
import { ensureAgentWallet, listOrgWallets, syncWalletBalances } from "@/domain/arc/wallets";
import { getDailySpendUsd } from "@/domain/arc/allowlist";
import { getArcChain, getArcExecutionMode, isCircleConfigured } from "@/domain/arc/config";

function shortAddr(addr: string) {
  if (addr.length < 14) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatTaskTime(d: Date) {
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Treasury + agent wallet workspace (embedded under Pay). */
export async function WalletsWorkspace({
  organizationId,
  userId,
}: {
  organizationId: string;
  userId: string;
}) {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
  await ensureAgentWallet({ organizationId, actorType: "user", actorId: userId });
  let wallets = await listOrgWallets(organizationId);
  try {
    wallets = await syncWalletBalances(organizationId);
  } catch {
    // keep last known balances
  }

  const allowlist = await prisma.destinationAllowlist.findMany({
    where: { organizationId },
    orderBy: { createdAt: "desc" },
  });
  const tasks = await prisma.agentTask.findMany({
    where: { organizationId },
    orderBy: { createdAt: "desc" },
    take: 12,
  });
  const spentToday = await getDailySpendUsd(organizationId);
  const agent = wallets.find((w) => w.role === "agent" && w.status === "active");
  const treasury = wallets.find((w) => w.role === "treasury_external" && w.status === "active");
  const chain = getArcChain();
  const execution = getArcExecutionMode(org.paymentMode);
  const agentNeedsUpgrade =
    Boolean(agent) &&
    (agent!.provider === "sandbox" || Boolean(agent!.circleWalletId?.startsWith("sbx_")));

  return (
      <div className="dash">
        <div className="dash-toolbar">
          <span className="badge bg-accent-soft text-accent">{chain}</span>
          <span className={`badge ${execution === "testnet" || execution === "mainnet" ? "bg-accent-soft text-accent" : "bg-amber-50 text-warn"}`}>
            {execution === "testnet"
              ? "Arc testnet (real txs)"
              : execution === "mainnet"
                ? "Arc mainnet"
                : execution === "simulated"
                  ? "Simulated only"
                  : "Arc blocked — check Settings / Circle keys"}
          </span>
          <span className="badge bg-accent-soft text-accent">
            {isCircleConfigured() ? "Circle configured" : "Circle keys missing"}
          </span>
          {org.agentWalletFrozen ? <span className="badge bg-amber-50 text-warn">frozen</span> : null}
        </div>

        <div className="dash-split">
          <section className="dash-panel">
            <p className="dash-kicker">Treasury</p>
            <h2 className="dash-h">Company</h2>
            <p className="dash-sub">External treasury</p>

            {treasury ? (
              <div className="wallet-facts">
                <p className="wallet-addr" title={treasury.address}>
                  {treasury.address}
                </p>
                <dl className="dash-dl">
                  <div>
                    <dt>Balance</dt>
                    <dd>{treasury.balanceUsdc != null ? `${treasury.balanceUsdc} USDC` : "—"}</dd>
                  </div>
                  <div>
                    <dt>Provider</dt>
                    <dd>{treasury.provider}</dd>
                  </div>
                </dl>
                {agent ? (
                  <p className="dash-mini-meta mt-2">
                    Send USDC to agent {shortAddr(agent.address)}
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="dash-empty" style={{ paddingInline: 0 }}>
                Not linked — connect or paste an address
              </p>
            )}

            <div className="wallet-actions">
              <ConnectTreasuryButton />
              <WalletJsonForm action="link_manual" className="wallet-inline-form">
                <input name="address" className="input" placeholder="0x… address" required />
                <button type="submit" className="btn btn-secondary">
                  Link
                </button>
              </WalletJsonForm>
            </div>
          </section>

          <section className="dash-panel">
            <p className="dash-kicker">Agent</p>
            <h2 className="dash-h">Payment wallet</h2>

            {agent ? (
              <div className="wallet-facts">
                <p className="wallet-addr" title={agent.address}>
                  {agent.address}
                </p>
                <dl className="dash-dl">
                  <div>
                    <dt>Balance</dt>
                    <dd>{agent.balanceUsdc != null ? `${agent.balanceUsdc} USDC` : "—"}</dd>
                  </div>
                  <div>
                    <dt>Network</dt>
                    <dd>{agent.blockchain}</dd>
                  </div>
                  <div>
                    <dt>Provider</dt>
                    <dd>{agent.provider === "circle" && !agentNeedsUpgrade ? "circle" : "simulated"}</dd>
                  </div>
                </dl>
                {agentNeedsUpgrade ? (
                  <p className="dash-mini-meta mt-2 text-warn">
                    Simulated wallet. Upgrade for live {chain}, then fund with USDC.
                  </p>
                ) : (
                  <p className="dash-mini-meta mt-2">Fund USDC, then sync before paying.</p>
                )}
              </div>
            ) : (
              <p className="dash-empty" style={{ paddingInline: 0 }}>
                Not provisioned
              </p>
            )}

            <div className="wallet-actions wallet-actions-row">
              {!agentNeedsUpgrade && agent ? (
                <FundAgentButton address={agent.address} disabled={org.agentWalletFrozen} />
              ) : null}
              {agentNeedsUpgrade || !agent ? (
                <WalletJsonForm action="upgrade_agent_circle">
                  <button type="submit" className="btn btn-primary">
                    {agentNeedsUpgrade ? "Upgrade to Circle testnet" : "Provision Circle agent"}
                  </button>
                </WalletJsonForm>
              ) : (
                <WalletJsonForm action="provision_agent">
                  <button type="submit" className="btn btn-secondary">
                    Ensure
                  </button>
                </WalletJsonForm>
              )}
              <WalletJsonForm action="sync">
                <button type="submit" className="btn btn-secondary">
                  Sync
                </button>
              </WalletJsonForm>
              <WalletJsonForm action="toggle_freeze" extraFields={{ freeze: !org.agentWalletFrozen }}>
                <button type="submit" className="btn btn-secondary">
                  {org.agentWalletFrozen ? "Unfreeze" : "Freeze"}
                </button>
              </WalletJsonForm>
            </div>
          </section>
        </div>

        <section className="dash-panel">
          <div className="dash-panel-head">
            <div>
              <p className="dash-kicker">Limits</p>
              <h2 className="dash-h">Spend controls</h2>
            </div>
            <div className="dash-stat-side">
              <span className="dash-mini-label">Today</span>
              <span className="dash-stat-strong">
                {spentToday.toLocaleString()} / {org.dailySpendLimitUsd.toLocaleString()}
              </span>
              <span className="dash-mini-meta">USDC</span>
            </div>
          </div>
          <WalletJsonForm action="save_limit" className="wallet-inline-form mt-3">
            <label className="wallet-field">
              <span className="dash-mini-label">Daily limit</span>
              <input
                name="dailySpendLimitUsd"
                type="number"
                className="input"
                defaultValue={org.dailySpendLimitUsd}
              />
            </label>
            <button type="submit" className="btn btn-primary">
              Save
            </button>
          </WalletJsonForm>
        </section>

        <section className="dash-panel dash-panel-flush">
          <div className="dash-panel-head dash-panel-pad">
            <div>
              <p className="dash-kicker">Allowlist</p>
              <h2 className="dash-h">Destinations</h2>
            </div>
          </div>
          <div className="dash-panel-pad pt-0">
            <WalletJsonForm action="allowlist_add" className="wallet-allow-form">
              <input name="address" className="input" placeholder="0x… Arc address" required />
              <input name="label" className="input" placeholder="Vendor label" />
              <button type="submit" className="btn btn-secondary">
                Add destination
              </button>
            </WalletJsonForm>
          </div>
          <ul className="dash-list">
            {allowlist.map((row) => (
              <li key={row.id}>
                <div className="min-w-0">
                  <p className="wallet-addr-sm" title={row.address}>
                    {row.address}
                  </p>
                  <p className="dash-mini-meta">
                    {row.label || "Untitled"} · {row.isActive ? "active" : "revoked"}
                  </p>
                </div>
                {row.isActive ? (
                  <WalletJsonForm action="allowlist_revoke" extraFields={{ address: row.address }}>
                    <button type="submit" className="btn btn-secondary h-8 px-2.5 text-[0.68rem]">
                      Revoke
                    </button>
                  </WalletJsonForm>
                ) : (
                  <span className="badge bg-slate-100 text-muted">off</span>
                )}
              </li>
            ))}
            {allowlist.length === 0 ? <li className="dash-empty">None yet</li> : null}
          </ul>
        </section>

        <section className="dash-panel dash-panel-flush">
          <div className="dash-panel-head dash-panel-pad">
            <div>
              <p className="dash-kicker">Activity</p>
              <h2 className="dash-h">Agent tasks</h2>
            </div>
          </div>
          <ul className="dash-list">
            {tasks.map((t) => (
              <li key={t.id}>
                <div className="min-w-0">
                  <p className="dash-row-title" style={{ color: "var(--foreground)" }}>
                    {t.type.replace(/_/g, " ")}
                  </p>
                  <p className="dash-mini-meta">
                    {t.status}
                    {t.txHash ? ` · ${shortAddr(t.txHash)}` : ""}
                  </p>
                </div>
                <span className="dash-mini-meta shrink-0">{formatTaskTime(t.createdAt)}</span>
              </li>
            ))}
            {tasks.length === 0 ? <li className="dash-empty">No tasks</li> : null}
          </ul>
        </section>
      </div>
  );
}
