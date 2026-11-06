# Custara AP

**Short:** Custara is the AP control plane. ERPNext stays the ledger. Approved bills settle in USDC on Arc mainnet.

**Long:**

Custara sits in front of ERPNext Accounts. Controllers keep the general ledger, taxes, and bank reconciliation in ERPNext. AP reviewers get dual control, MFA, live FX quotes, and a destination allowlist in Custara.

1. Install this app (or connect ERPNext from Custara Connectors with site URL + API key/secret).
2. Set Custara API URL and Partner API key under Custara Settings. Production: `https://custara.xyz`. Demos: `https://testnet.custara.xyz`.
3. Submit a Purchase Invoice — auto-push (optional) or use **Send to Custara**.
4. Approve and pay on Arc mainnet USDC. Custara writes a Payment Entry with memo `custara:{paymentIntentId}` and retries if ERPNext was down.

ERPNext remains the book of record. A failed Custara payment does not mark the Purchase Invoice paid.

License: MIT (free listing).
