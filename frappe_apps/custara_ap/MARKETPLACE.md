# Frappe Cloud Marketplace listing checklist

**App name:** `custara_ap`  
**Title:** Custara AP  
**License:** MIT  
**Logo:** `custara_ap/public/images/logo.png` (200×200)  
**Screenshots:** `custara_ap/public/images/screenshot_*.png`

**Short description:** Custara is the AP control plane. ERPNext stays the ledger. Approved bills settle in USDC on Arc mainnet.

**Long description:** see `custara_ap/public/description.md`

## Publish steps

1. Create public GitHub repo `Samped/custara-frappe`.
2. Sync monorepo folder `frappe_apps/custara_ap/` to that repo root.
3. Frappe Cloud → Become Publisher → Add from GitHub → select `custara-frappe`.
4. Complete listing: logo, five required URLs, short + long description, screenshots.
5. Submit release → Mark ready for review.

Canonical source remains in the Custara monorepo under `frappe_apps/custara_ap`.
