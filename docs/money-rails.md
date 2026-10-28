# Fund, withdraw, and Pay client

Home (`/app`) has a **Money** strip for payers and admins: **Fund**, **Withdraw**, and **Pay client**. Bill pay on an invoice is unchanged — that still settles an approved vendor bill. These three actions move USDC on the agent wallet without an invoice.

Completed bank-in, bank-out, and client pays appear on the public [network ledger](/network) and count toward live-network volume.

## Pay client

Available in every workspace.

Sends USDC from the Circle agent to a `0x` address, once or on a weekly or monthly schedule. There is no invoice. The first new address is allowlisted as **Pay client**. MFA, spend caps, freeze, and allowlist still apply.

A one-time send creates a `direct` payment intent and an `arc_transfer` task. A schedule stores a recurring payout; the worker job `run_payouts` opens the later intents.

## African bank Fund and Withdraw

**Fund** and **Withdraw** show when the company of record is in a PAJ African market — not from GPS or IP. That is business location (or dashboard currency) of:

| Country | Local currency |
|---------|----------------|
| Nigeria | NGN |
| Ghana | GHS |
| Tanzania | TZS |
| Kenya | KES |
| South Africa | ZAR |

PAJ also lists USD; Custara does not treat a USD workspace as a bank-rail market.

Set **Business location** in [Settings](settings.md). Onboarding requires a country. If the books are already in one of those currencies and country was never saved, Home writes the matching country.

Both directions use PAJ (`PAJ_API_KEY` on the web host). The agent still holds **USDC on Arc**. Local currency is only the bank leg.

### Fund

Two methods:

- **Wallet** — send USDC to the agent (browser wallet or QR on mainnet; faucet on testnet).
- **Local bank** — enter a fiat amount. PAJ opens a one-time virtual account in that country’s currency. Pay that exact amount from a local bank. When PAJ confirms, USDC credits the agent. The intent kind is `paj_onramp` (**Bank in** on `/network`).

### Withdraw

Enter a USDC amount and a local bank account (saved after PAJ confirms the number). Custara opens a PAJ offramp order, allowlists the one-off Arc funding address as **PAJ offramp**, and sends agent USDC there. PAJ pays the bank in local currency. Kind `paj_offramp` (**Bank out**). MFA applies at the usual pay threshold.

Standing PAJ bank addresses are Solana-only, so Custara always uses an Arc offramp order plus a Circle transfer.

## Server setup

| Variable | Where | Role |
|----------|--------|------|
| `PAJ_API_KEY` | Vercel (the `custara.xyz` or testnet app) | Opens onramp, offramp, and bank-account calls |
| `PAJ_WEBHOOK_SECRET` | Same Vercel project | HMAC on `POST /api/webhooks/paj` (`whsec_…`) |
| `APP_URL` | Same project | Must be the public HTTPS origin, e.g. `https://custara.xyz` |

Point PAJ’s **ramp** webhook at `{APP_URL}/api/webhooks/paj`. The secret is on the API key in the PAJ dashboard, and in the response to `PATCH /pub/v2/webhook`. The Render worker does not need PAJ keys; it already sends the Circle USDC leg.

Without `PAJ_API_KEY`, Home still shows Fund/Withdraw for an African workspace but bank methods say the rails are not configured. Without the webhook secret, naira (or other local currency) can move at PAJ while Custara stays on **Sending**.

The older Nigeria **file export** rail (`NIGERIA_PAYMENT_LIVE`) is separate. It is not how live bank Fund/Withdraw works.
