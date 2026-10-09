# Agent payments

How Custara creates a payment intent, moves USDC on Arc, and records settlement.

The agent wallet holds USDC. An agent task is work the worker executes. A person or autopay creates a payment intent. The Arc rail becomes an on-chain transfer. Approval and pay timing are separate from execution.

```
Invoice approved
  → Payer or autopay
  → payment intent
       ├─ arc_usdc   → arc_transfer → Circle USDC → arc_reconcile → settlement
       └─ nigeria_*  → bank export file
```

## Tasks

Agent tasks are rows plus the Redis queue `agent-tasks`.

| Type | When | Result |
|------|------|--------|
| `arc_transfer` | After an Arc payment intent | USDC from the agent wallet to the vendor Arc address |
| `arc_reconcile` | Transfer reaches a terminal Circle state, or a Circle webhook arrives | Settlement row and invoice `reconciled` |
| `wallet_sync` | Wallets sync, or `POST /api/v1/wallets` with `action: sync` | Refresh `balanceUsdc` |

Enqueue inserts the task as `pending`, then queues it. The worker runs the task. Redis and `npm run worker` are required for background execution. Recent tasks appear on `/app/wallets`.

## Who initiates pay

Shared entry is payment-intent creation.

A person uses **Initiate payment** on the invoice. MFA applies when the USD amount is at or above the organization threshold (default 5,000). Below that threshold, no authenticator code is required. The intent becomes an `arc_transfer` task.

Autopay is on by default. The control is **Auto-pay approved vendors on the recommended date**. The worker selects invoices where:

- the organization has autopay enabled
- status is `approved`
- `recommendedPayDate` is today or earlier
- the vendor is not new
- no hard risk remains

The job runs as the system actor and does not prompt for MFA. Idempotency key: `autopay:{invoiceId}:{date}`.

### Arc prerequisites

- Invoice currency `USD` or `USDC`
- Vendor has an active `arc_usdc` endpoint
- Destination is on the organization allowlist
- Agent wallet is a Circle wallet and is not frozen
- Synced agent balance covers the amount
- The payment is under `dailySpendLimitUsd`

### Nigeria

The same intent API produces an export file. No agent task is created unless `NIGERIA_PAYMENT_LIVE=true`.

## Pay timing

After approval, Custara sets `recommendedPayDate`. The date is usually the due date, and earlier when an early-pay discount is available and cash covers it. Autopay runs when that date has arrived. `/app/cash` lists approved invoices with a recommended or due date in the next 7 days. With autopay off, a payer initiates payment in the console or with `POST /api/v1/payment-intents`.

## Status

| Record | Path |
|--------|------|
| Invoice | `approved` → `payment_queued` → `payment_sent` → `reconciled`, or `payment_failed` |
| Payment intent | `queued` → `pending_transfer` → `completed` or `failed` |
| Agent task | `pending` → `running` → `completed` or `failed`, with `circleTxId` and `txHash` |
| Settlement | Written on successful reconcile |

Settlement closes in one of three ways:

1. The worker sees a terminal Circle status and enqueues `arc_reconcile`.
2. `POST /api/webhooks/circle` completes the intent and enqueues `arc_reconcile`.
3. An operator reconciles an export rail from the console or `POST /api/v1/reconcile`.

`/app/payments` lists intents. The invoice shows the latest intent.

## On-chain USDC

Live mode sends a Circle transfer from the agent wallet to the vendor address.

1. Organization payment mode is live. Simulated mode refuses Arc pay while `ARC_ALLOW_SIMULATED` is false.
2. `ARC_PAYMENTS_LIVE=true`, `ARC_CHAIN` set for the deployment, and `ARC_ALLOW_SIMULATED=false`. A test network also requires `ARC_ALLOW_LIVE_ON_TESTNET=true`.
3. `CIRCLE_API_KEY` and `CIRCLE_ENTITY_SECRET` are set. REST transfers also use `CIRCLE_ENTITY_SECRET_CIPHERTEXT`.
4. The agent wallet provider is Circle. Replace a simulated wallet from **Pay → Wallets** before paying.
5. Fund the agent with USDC and sync. Confirm the destination on the invoice, then initiate pay.
6. Idempotency key `arc-transfer-{intentId}` produces a Circle transaction id and, once confirmed, an on-chain `txHash`.

`ARC_ALLOW_SIMULATED=true` records simulated transaction ids for local development. Leave it false in production.

### Environment

| Variable | Role |
|----------|------|
| `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET` | Wallets and transfers |
| `CIRCLE_ENTITY_SECRET_CIPHERTEXT` | REST transfer path |
| `ARC_CHAIN` | Arc network for the deployment |
| `ARC_PAYMENTS_LIVE` | Required for live Arc spends |
| `ARC_ALLOW_LIVE_ON_TESTNET` | Required when `ARC_CHAIN` is a test network |
| `ARC_ALLOW_SIMULATED` | `false` in production |
| `ARC_USDC_TOKEN_ADDRESS` | USDC contract when the deployment overrides the default |
| `CIRCLE_WEBHOOK_SECRET` | Verifies Circle webhooks in production |
| `REDIS_URL` | Worker queues |

Release checks are in [Release verification](qa-runbook.md).
