# Agent payments & on-chain Arc flow

How Custara assigns agent tasks, pays due invoices, tracks status, and settles USDC on Arc.

## Mental model

The **agent wallet** holds USDC. An **AgentTask** is work the BullMQ worker executes. Humans or autopay create a **PaymentIntent**; only the Arc rail becomes an on-chain transfer. **Decision** (approve + when to pay) is separate from **execution** (Circle transfer).

```
Invoice approved + timing
  → Human (MFA) or Autopay cron
  → createPaymentIntent
       ├─ arc_usdc  → AgentTask(arc_transfer) → Circle USDC → arc_reconcile → Settlement
       └─ nigeria_* → CSV/JSON export (no chain by default)
```

Key code: [`src/domain/payment.ts`](../src/domain/payment.ts), [`src/domain/arc/tasks.ts`](../src/domain/arc/tasks.ts), [`src/domain/timing.ts`](../src/domain/timing.ts), [`src/worker.ts`](../src/worker.ts), [`src/domain/arc/circle.ts`](../src/domain/arc/circle.ts).

---

## 1. How agents get tasks

`AgentTask` rows + Redis queue `agent-tasks`.

| Type | When | What |
|------|------|------|
| `arc_transfer` | After Arc `createPaymentIntent` | USDC agent → vendor Arc address |
| `arc_reconcile` | Transfer terminal or Circle webhook | Settlement + invoice `reconciled` |
| `wallet_sync` | Wallets **Sync** / API | Refresh `OrgWallet.balanceUsdc` |

Enqueue inserts `AgentTask` (`pending`) then `enqueueJob({ queue: "agent-tasks" })`. The worker runs `runAgentTask`.

**Ops:** Redis + `npm run worker` required. Without the worker, intents stay `pending_transfer`. Recent tasks appear on `/app/wallets`.

---

## 2. How agents pay invoices

Shared entry: `createPaymentIntent`.

### Human

Invoice detail → **Initiate payment** → MFA (`assertPayStepUp`) → intent → `arc_transfer`.

### Autopay

Settings → **Auto-pay approved invoices on recommended pay date**. Worker cron every 15 minutes (`payment-schedule` / `run_autopay`):

- Invoice `approved`
- `recommendedPayDate <= today`
- No hard risks
- System actor (no MFA); idempotency `autopay:{invoiceId}:{date}`

### Arc prerequisites

- Invoice currency `USD` or `USDC`
- Vendor active `arc_usdc` endpoint
- Destination on org allowlist
- Agent wallet provisioned, not frozen
- Synced agent balance ≥ amount
- Under `dailySpendLimitUsd`

### Nigeria

Same intent API, **no** AgentTask — sandbox/export only unless `NIGERIA_PAYMENT_LIVE=true`.

---

## 3. Due invoices: when does “due” become “pay”?

After approval, `recommendPayTiming` sets `Invoice.recommendedPayDate` (usually the **due date**; earlier if early-pay discount and cash allows).

- **Due ≠ auto-pay by itself.** Autopay runs when `recommendedPayDate` has arrived and autopay is on.
- `/app/cash` “suggested pays” lists approved invoices with recommended/due in the next 7 days.
- Without autopay, a payer must initiate payment (UI or `POST /api/v1/payment-intents`).

---

## 4. How payment is tracked

| Layer | Arc lifecycle |
|-------|----------------|
| **Invoice** | `approved` → `payment_queued` → `payment_sent` → `reconciled` (or `payment_failed`) |
| **PaymentIntent** | `queued` → `pending_transfer` → `completed` / `failed` |
| **AgentTask** | `pending` → `running` → `completed` / `failed` (`circleTxId` / `txHash`) |
| **Settlement** | Created on successful reconcile |

Close the loop:

1. Worker sees terminal Circle status → enqueue `arc_reconcile`
2. Circle webhook `POST /api/webhooks/circle` → complete intent → `arc_reconcile`
3. UI/API manual reconcile for export rails

`/app/payments` lists intents; invoice detail shows the latest intent and reconcile actions.

---

## 5. On-chain transactions (Arc USDC)

Enterprise default is **real Circle transfers on Arc testnet** (not invented hashes).

`createUsdcTransfer` spends from the **agent** `circleWalletId` to the vendor address:

1. Org **Payment mode = live** (Settings). Simulated mode refuses Arc unless `ARC_ALLOW_SIMULATED=true`.
2. Env: `ARC_PAYMENTS_LIVE=true`, `ARC_CHAIN=ARC-TESTNET`, `ARC_ALLOW_LIVE_ON_TESTNET=true`, `ARC_ALLOW_SIMULATED=false`.
3. Circle developer wallets: `CIRCLE_API_KEY` + `CIRCLE_ENTITY_SECRET` (+ ciphertext for REST).
4. Agent wallet **provider=circle** (Wallets → Upgrade to Circle testnet if still simulated).
5. Fund agent with **testnet USDC** (`npm run fund:agent` or Wallets → Fund), Sync, confirm destination on invoice, initiate pay.
6. Idempotency `arc-transfer-{intentId}` → real Circle tx id + on-chain `txHash` when confirmed.

`ARC_ALLOW_SIMULATED=true` is the only path that invents `sbx_tx_*` / fake hashes (local demos).

### Fund agent (Arc testnet USDC)

```bash
npm run fund:agent
# optional: --org <id>  --wait 3600  --poll 120  --sync-only  --once  --force
```

Calls Circle `POST /v1/faucet/drips` (~20 USDC). On API rate limits it keeps retrying up to `--wait` seconds and polls balance, so a parallel drip at [faucet.circle.com](https://faucet.circle.com/) (ARC + USDC + captcha) still completes the script. Requires mainnet-upgraded Circle API key for the programmatic path.

**Not automated today**

- Treasury → agent top-ups beyond the testnet faucet
- Nigeria live bank rails (export by default)
- Arc mainnet without `ARC_CHAIN=ARC` + live gates

---

## End-to-end checklist (enterprise testnet)

1. Circle Console: developer-controlled API key + register entity secret → put in `.env`
2. Settings → Payment mode **live**; Wallets → **Upgrade to Circle testnet**
3. `npm run fund:agent` (or public faucet + Sync); balance must be ≥ invoice
4. Extract + clear risks → invoice `approved`; confirm destination on invoice
5. Redis + `npm run worker`; payer initiates payment (MFA if required in live)
6. `/app/payments` mode column shows `live` (not `simulated`); `txHash` is a real Circle/on-chain hash

### Env

| Variable | Role |
|----------|------|
| `CIRCLE_API_KEY` + `CIRCLE_ENTITY_SECRET` | Developer wallets / transfers (required) |
| `CIRCLE_ENTITY_SECRET_CIPHERTEXT` | REST transfer path |
| `ARC_CHAIN` | `ARC-TESTNET` (pilots) or `ARC` (mainnet) |
| `ARC_PAYMENTS_LIVE` | `true` for live org Arc spends |
| `ARC_ALLOW_LIVE_ON_TESTNET` | `true` for enterprise testnet drills |
| `ARC_ALLOW_SIMULATED` | `false` in customer envs (blocks fake COMPLETE) |
| `CIRCLE_WEBHOOK_SECRET` | Webhook verify (required in production) |
| `REDIS_URL` | Worker queues |

Also see [qa-runbook.md](./qa-runbook.md).
