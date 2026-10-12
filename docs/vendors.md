# Vendors

Vendors is `/app/vendors`. Open it from **Go to → Work → Vendors**. Anyone who can read vendors can open the directory. Admins and payers can change a destination, a purchase order, or early-pay terms.

## Directory

Each vendor card shows:

- **Arc USDC** — the address Custara pays. Empty means there is no Arc endpoint yet.
- **Bank** — account name and the last four digits, when a bank endpoint exists.
- **new vendor** — the first bills from this vendor still need a person, even when the amount is small.

To allowlist a wallet, paste a `0x` address of 40 hex characters under Arc USDC and save it. That address is added to the workspace allowlist. Paying requires this step before an Arc payment will go through.

**Purchase orders / contracts** stores a PO number, amount, and currency on the vendor. A live policy that requires a purchase order looks for that number on the invoice.

**Early-pay terms** is a discount percent and how many days before the due date the discount applies. Cash uses those terms when it suggests a pay date.

## Portal

**Portal** is an admin tab. It creates an upload invite for a vendor so they can send a bill without a Custara login. The invite link is shown once when it is created.
