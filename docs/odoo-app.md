# Custara Odoo app

The connector in **Connectors** (database URL + API key) is the default for Odoo Online. The worker pulls posted vendor bills every minute. If this module is installed and the API URL plus Partner API key are set, posting a vendor bill also pushes it to Custara immediately.

The optional module in [`odoo_apps/custara_ap`](../odoo_apps/custara_ap) is for self-hosted Odoo, Odoo.sh, and the [Odoo Apps](https://apps.odoo.com) listing.

## What it does

- Settings → Accounting → **Custara AP**: API URL and a Custara Partner API key. Production: `https://custara.xyz`. Demos: `https://testnet.custara.xyz`.
- Vendor bill / credit: **Send to Custara** posts `POST /api/v1/erp/ingest`
- Chatter notes that settlement is Arc USDC on the Custara API host you configured

Custara still pulls on a worker cron. The button is for operators who want a bill in Inbox immediately.

## Install

Copy `odoo_apps/custara_ap` into the Odoo addons path (Odoo **18.0**), update the apps list, install **Custara AP**.

Or install from the Apps Store listing repo (see below).

## Marketplace listing (apps.odoo.com)

**Title:** Custara AP  

**One-liner:** Custara is the AP control plane. Odoo stays the ledger. Approved bills settle in USDC on Arc mainnet.

**License:** LGPL-3 (free)  

**Series:** Odoo 18.0  

**Listing repo:** [Samped/custara-odoo](https://github.com/Samped/custara-odoo) branch `18.0`  

Register on [apps.odoo.com/apps/upload](https://apps.odoo.com/apps/upload):

```text
ssh://git@github.com/Samped/custara-odoo#18.0
```

The listing repo is **public**, so Odoo can clone without a collaborator invite. If the scan still asks for access, add GitHub user **`online-odoo`** (not `odoo-online`) with read access on that repo.

**Operator steps after this repo exists:**

1. Sign in at [apps.odoo.com/apps/upload](https://apps.odoo.com/apps/upload).
2. Register `ssh://git@github.com/Samped/custara-odoo#18.0`.
3. Wait for the scan (often a few hours). Confirm **Custara AP** appears under Accounting.

Canonical module source stays in this monorepo under `odoo_apps/custara_ap`. Sync that folder into `custara-odoo` when the module changes. Do **not** publish from Custara `master` — the store needs the module at the repo root on a series-named branch.

Customer API URL: `https://custara.xyz`. Demo / test data: `https://testnet.custara.xyz`.

## Partner one-pager

Custara sits in front of Odoo Accounting. Controllers keep the general ledger, taxes, journals, and bank reconciliation in Odoo. AP reviewers get dual control, MFA, live FX quotes, and a destination allowlist in Custara.

1. Connect the database URL and an API key (Odoo Online) or install this module (self-hosted / Odoo.sh).
2. Sync pulls suppliers, purchase orders, draft and posted bills, credits, taxes, and vendor PDFs.
3. Approve in Custara. Draft bills can post back to Odoo with chatter.
4. Pay on Arc **mainnet** USDC at `custara.xyz`. Custara writes `custara:{paymentIntentId}` on the Odoo payment, reconciles that bill only, and retries if Odoo was down.

Odoo remains the book of record. A failed Custara payment does not mark the bill paid.
