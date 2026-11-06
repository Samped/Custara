# Custara AP (ERPNext / Frappe)

Custara is the AP control plane. ERPNext stays the ledger.

Approved Purchase Invoices settle in Arc mainnet USDC on https://custara.xyz.
Use https://testnet.custara.xyz only for demos.

## What it does

- **Custara Settings** (singleton): API URL, Partner API key, auto-push on submit
- On Purchase Invoice submit: `POST /api/v1/erp/ingest` with `system: "erpnext"`
- Manual **Send to Custara** button on the Purchase Invoice form
- Comment that settlement is Arc USDC on the configured Custara host

Custara Connectors can also pull over the ERPNext REST API without this app.

## Install

```bash
bench get-app /path/to/custara_ap
# or: bench get-app https://github.com/Samped/custara-frappe.git
bench --site your.site install-app custara_ap
```

See [docs/frappe-app.md](../../docs/frappe-app.md) in the monorepo for the marketplace playbook.
