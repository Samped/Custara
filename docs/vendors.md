# Vendors

Vendors is `/app/vendors`. Open it from **Go to → Work → Vendors**. Anyone who can read vendors can open the directory. Admins and payers can change a destination, a purchase order, or early-pay terms.

## Directory

Open a vendor name for the workspace: VAT, payment terms, address, open residual, aged payable, bills, credits, POs, and agreed prices from Odoo.

Each vendor card shows:

- **Arc USDC** — the address Custara pays. Empty means there is no Arc endpoint yet.
- **Bank** — account name and the last four digits, when a bank endpoint exists.
- **new vendor** — the first bills from this vendor still need a person, even when the amount is small.

To allowlist a wallet, paste a `0x` address of 40 hex characters under Arc USDC and save it. That address is added to the workspace allowlist. Paying requires this step before an Arc payment will go through.

Vendors synced from Odoo keep `odoo-partner:{id}` as their external id. Purchase orders from Odoo land on the same vendor card. Arc pay still needs an allowlisted address unless one was saved here.

**Purchase orders / contracts** stores a PO number, amount, and currency on the vendor. A live policy that requires a purchase order looks for that number on the invoice.

**Early-pay terms** is a discount percent and how many days before the due date the discount applies. Cash uses those terms when it suggests a pay date.

## Portal

**Portal** is an admin tab. It creates an upload invite for a vendor so they can send a bill without a Custara login. The invite link is shown once when it is created.
