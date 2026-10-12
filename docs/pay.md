# Pay

Pay is `/app/payments`. Open it from **Go to → Money → Pay**. Admins, payers, and viewers can open it. Approvers and auditors cannot.

The header names the rail for this workspace. On the hosted site that is Arc testnet, which settles USDC from the payment wallet.

Pay has three tabs.

## Intents

A payment intent is one attempt to settle a bill. The list shows the invoice, amount, status, and the transaction hash when Circle has one. **Payment queued** means the intent was just created.

A failed intent can be retried from its receipt. Retry sends a new transfer.

The pay button itself is on the invoice, after the bill is `approved`. Under the payment MFA threshold, **Initiate payment** sends immediately. At or above the threshold, the payer enters a current authenticator code. See [Security](app-security.md).

## Receipts

Receipts opens `/app/receipts`. Each receipt is one intent, including settled and in-flight transfers. A transaction hash links to the Arc testnet explorer.

## Wallets

Wallets is for admins and payers.

- **Payment wallet** is the Circle agent that sends USDC. **Provision Circle agent** creates it. **Sync** reads the latest Circle balance into Custara.
- **Company** is the treasury address used to fund that wallet.
- **Spend controls** set the daily cap.
- **Destinations** lists allowlisted vendor addresses. Adding an address here is the same allowlist used on [Vendors](vendors.md).

The balance on this tab is the balance Custara will spend. Fund the wallet in USDC, then Sync, before a class or a live pay run.
