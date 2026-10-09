# Console

The signed-in workspace lives under `/app`. The public site is `/` and the network ledger is `/network`.

| Path | Who | Purpose |
|------|-----|---------|
| `/app` | Anyone who can read the inbox | Home: approvals waiting, pay queue, open invoices, payment-wallet balance, recent bills |
| `/app/inbox` | Inbox read; upload needs inbox write | All invoices, upload, mailbox status |
| `/app/invoices/[id]` | Invoice read | Extraction, risks, approval, and pay |
| `/app/approvals` | Approver, admin | Maker-checker queue |
| `/app/policies` | Policy read; publish needs policy write | Versioned rules, including purchase-order requirement |
| `/app/payments` | Payer, admin | Payment intents. Wallets are the **Wallets** tab |
| `/app/wallets` | Payer, admin | Same treasury and agent workspace |
| `/app/receipts` | Payments read | Settled and in-flight receipts |
| `/app/cash` | Cash read | Obligations, funding gap, suggested pays |
| `/app/collections` | Cash read | Receivable reminders |
| `/app/vendors` | Vendor read; edits need vendor write | Vendor record, destination, portal invite |
| `/app/connectors` | Connector read | Mailbox, SFTP, accounting connections |
| `/app/developers` | Developers read | API keys, webhooks, examples |
| `/app/security` | Admin for the threshold | Payment MFA threshold |
| `/app/settings` | Admin | Organization profile, payment mode, autopay, target days payable |
| `/app/roles` | Admin | Role descriptions |
| `/app/audit` | Auditor, admin | Hash-chained event list |
| `/app/onboarding` | Admin of a new workspace | Company profile |

Home, Inbox, Pay, and Cash refresh themselves every few seconds while the tab is visible, so a payment made from the API or CLI shows up without a manual reload.

## Roles

| Role | Can |
|------|-----|
| Admin | Everything, including settings, API keys, policy publish, and team invites |
| Approver | Read bills, decide approvals, read policy and audit |
| Payer | Upload, pay, manage wallets and vendors, read cash and audit |
| Viewer | Read inbox, invoices, vendors, payments, and cash |
| Auditor | Read the same books plus the audit trail and approvals |

Payer does not publish policy or create API keys. Approver does not initiate payment.

## Pay card on an invoice

Custara converts the invoice amount to USD and compares it with the organization threshold (default 5,000 USD).

- Under the threshold, **Initiate payment** does not ask for an authenticator code.
- At or above the threshold, the payer must have MFA enrolled and must enter a current code.
- The system autopay job is exempt.

## Payment mode

Settings stores payment mode as `sandbox` or `live`.

- `sandbox` keeps balances simulated. No USDC moves on Arc.
- `live` settles USDC on Arc through Circle. API payments and webhooks follow that mode.

The chain is deployment configuration (`ARC_CHAIN`). Application behavior is the same on every Arc network: live mode transfers USDC from the Circle agent wallet to an allowlisted vendor address.
