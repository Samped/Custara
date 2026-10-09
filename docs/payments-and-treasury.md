# Payments and treasury

Approved bills settle in **USDC on Arc**. The agent wallet is a Circle developer-controlled wallet. The vendor destination is an Arc address on the organization allowlist.

Nigeria bank payment produces an export file (`nigeria_sandbox` / `nigeria_export`). Funds move at a bank only when `NIGERIA_PAYMENT_LIVE=true` after partner onboarding.

Task queues, Circle states, and reconcile are in [Agent payments](agent-payments.md).

## Wallets

| Role | Meaning |
|------|---------|
| `agent` | Pays vendors. Balance is USDC. |
| `treasury_external` | Company treasury address used to fund the agent. It is allowlisted automatically when linked. |

Provision the agent from **Pay → Wallets**. With `ARC_ALLOW_SIMULATED` false, a simulated agent cannot pay. Provisioning replaces it with a Circle wallet on Arc.

The USDC contract is the deployment default, or `ARC_USDC_TOKEN_ADDRESS` when that variable is set.

Fund the agent in USDC from treasury, then sync from the wallet screen or `custara wallets sync`. The balance shown in the product decreases when a transfer is accepted. A later sync reconciles it with Circle. A sync will not raise the balance above a spend recorded in the last 15 minutes.

## What must be true before Arc pay

- Organization payment mode is live
- `ARC_PAYMENTS_LIVE=true` and `ARC_CHAIN` set to the deployment network. A test network also requires `ARC_ALLOW_LIVE_ON_TESTNET=true`
- Circle API key and entity secret are configured
- Invoice currency is `USDC` or `USD`
- Vendor has an active `arc_usdc` endpoint
- That address is on the allowlist
- Invoice status is `approved` or `payment_queued`
- No hard risks remain
- Extraction confidence is at or above the policy floor
- Agent balance covers the amount and the daily spend cap is not exceeded
- For a person paying at or above the MFA threshold, authenticator enrollment and a valid code

Creating a vendor with `arc_address` through `POST /api/v1/vendors` or `custara vendors create` adds the address to the allowlist.

## Autopay

Autopay is on for new and existing organizations unless an admin turns it off.

The worker selects invoices where:

- the organization has autopay enabled
- status is `approved`
- `recommendedPayDate` is today or earlier
- the vendor is not new
- no hard risk remains

It then creates a payment intent as the system actor. That path does not prompt for MFA.

## After pay

1. A payment intent is stored with rail `arc_usdc` and mode `live`.
2. An `arc_transfer` agent task sends USDC from the agent wallet to the vendor address.
3. When Circle reports a terminal success, an `arc_reconcile` task writes the settlement and sets the invoice to `reconciled`.
4. Webhooks `payment.intent_created`, `payment.failed`, and `invoice.reconciled` fire for endpoints subscribed to those events. Nigeria export also emits `payment.executed`.

If Redis is down, the API request runs the transfer in process so a CLI or API pay still reaches Circle. Reconcile of an in-flight transfer still prefers the worker. A completed Circle transaction is reconciled before the HTTP call returns when the transfer is already terminal.

## Failure and retry

A failed intent can be retried from the receipt. Retry sends a new Circle transfer. It does not reuse a burned Circle idempotency key. If the amount is at or above the MFA threshold, the acting user must already have MFA enrolled.

## Environment gates

| Variable | Effect |
|----------|--------|
| `ARC_PAYMENTS_LIVE` | Must be true for live mode to transfer |
| `ARC_CHAIN` | Arc network for the deployment |
| `ARC_ALLOW_LIVE_ON_TESTNET` | Required when `ARC_CHAIN` is a test network |
| `ARC_ALLOW_SIMULATED` | `false` in production |
| `ARC_USDC_TOKEN_ADDRESS` | USDC contract on Arc, when the deployment overrides the default |
| `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET` | Developer-controlled wallets |
| `CIRCLE_WEBHOOK_SECRET` | Verifies Circle webhooks in production |
| `NIGERIA_PAYMENT_LIVE` | Leave false until a bank partner is live |
| `API_PAY_STEPUP_SECRET` | When set, API `payments:initiate` in live mode must send `X-Custara-Step-Up` |
