# Custara Frappe / ERPNext app

The connector in **Connectors** (site URL + API key/secret) is the default for ERPNext and Frappe Cloud. The worker pulls submitted Purchase Invoices every minute. If this module is installed and Custara Settings has the API URL plus Partner API key, submitting a Purchase Invoice can also push it to Custara immediately.

The optional app in [`frappe_apps/custara_ap`](../frappe_apps/custara_ap) is for self-hosted bench sites and the [Frappe Cloud Marketplace](https://frappecloud.com/marketplace).

## What it does

- **Custara Settings** (singleton): API URL, Partner API key, auto-push on submit. Production: `https://custara.xyz`. Demos: `https://testnet.custara.xyz`.
- Purchase Invoice submit hook (when auto-push is on): `POST /api/v1/erp/ingest` with `system: "erpnext"`
- Form button **Send to Custara** (same payload; Idempotency-Key = invoice name)
- Comment that settlement is Arc USDC on the Custara API host you configured

Custara still pulls on a worker cron. The button is for operators who want a bill in Inbox immediately.

## Install

```bash
bench get-app https://github.com/Samped/custara-frappe.git
bench --site your.site install-app custara_ap
```

Or copy `frappe_apps/custara_ap` into your bench apps path and install.

Open **Custara Settings**, paste the Partner API key, optionally enable auto-push.

## Connectors vs marketplace app

| Path | Use when |
|------|----------|
| Custara **Connectors → ERPNext** | Frappe Cloud / hosted site; pull suppliers, POs, bills; Payment Entry write-back |
| **custara_ap** Frappe app | Push-on-submit + Send button; Marketplace listing; self-hosted bench |

Both can run together. Pull sync and write-back do not require the Frappe app.

## Frappe Cloud Marketplace

**Title:** Custara AP  

**One-liner:** Custara is the AP control plane. ERPNext stays the ledger. Approved bills settle in USDC on Arc mainnet.

**License:** MIT (free)  

**Listing repo:** [Samped/custara-frappe](https://github.com/Samped/custara-frappe) (public)

Register via [Frappe Cloud Marketplace publishing](https://docs.frappe.io/cloud/marketplace/publishing-an-app-to-marketplace):

1. Create public `custara-frappe` GitHub repo; sync monorepo `frappe_apps/custara_ap` to the repo root on a version branch.
2. Frappe Cloud → Become Publisher → Add from GitHub → complete listing (200×200 logo, five required URLs, short + long description, screenshots). Do not put install steps in the listing — Cloud installs for you.
3. Submit release → Mark ready for review.
4. Set production Partner API keys for customers (`https://custara.xyz`); demos on testnet.

Canonical module source stays in this monorepo under `frappe_apps/custara_ap`. Sync that folder into `custara-frappe` when the module changes.

## Partner one-pager

Custara sits in front of ERPNext Accounts. Controllers keep the general ledger, taxes, and bank reconciliation in ERPNext. AP reviewers get dual control, MFA, live FX quotes, and a destination allowlist in Custara.

1. Connect the site URL and API key/secret (Connectors) or install this app (push).
2. Sync pulls suppliers, purchase orders, submitted Purchase Invoices, taxes, and attachment metadata.
3. Approve in Custara.
4. Pay on Arc **mainnet** USDC at `custara.xyz`. Custara writes `custara:{paymentIntentId}` on the Payment Entry against that Purchase Invoice and retries if ERPNext was down.

ERPNext remains the book of record. A failed Custara payment does not mark the invoice paid.
