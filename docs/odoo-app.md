# Custara Odoo app

The connector in **Connectors** (database URL + API key) is the default for Odoo Online.

The optional module in [`odoo_apps/custara_ap`](../odoo_apps/custara_ap) is for self-hosted Odoo and the Odoo Apps listing.

## What it does

- Settings → Accounting → **Custara AP**: API URL (`https://custara.xyz`) and a Custara Partner API key
- Vendor bill / credit: **Send to Custara** posts `POST /api/v1/erp/ingest`
- Chatter notes that settlement is **Arc testnet USDC**, not mainnet

Custara still pulls on a 15-minute cron. The button is for operators who want a bill in Inbox immediately.

## Install

Copy `odoo_apps/custara_ap` into the Odoo addons path, update the apps list, install **Custara AP**.

## Marketplace listing (odoo.com/apps)

**Title:** Custara AP

**One-liner:** Custara is the AP control plane. Odoo stays the ledger. Approved bills can settle in Arc testnet USDC until mainnet is explicitly gated.

**Do not** describe this as a mainnet USDC or live on-chain payment app.

## Partner one-pager

Custara sits in front of Odoo Accounting. Controllers keep the general ledger, taxes, journals, and bank reconciliation in Odoo. AP reviewers get dual control, MFA, live FX quotes, and a destination allowlist in Custara.

1. Connect the database URL and an API key (Odoo Online) or install this module (self-hosted).
2. Sync pulls suppliers, purchase orders, draft and posted bills, credits, taxes, and vendor PDFs.
3. Approve in Custara. Draft bills can post back to Odoo with chatter.
4. Pay on Arc **testnet** USDC. Custara writes `custara:{paymentIntentId}` on the Odoo payment, reconciles that bill only, and retries if Odoo was down.

Odoo remains the book of record. A failed Custara payment does not mark the bill paid.
