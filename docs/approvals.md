# Approvals

Approvals is `/app/approvals`. Open it from **Go to → Work → Approvals**. Admins, approvers, payers, and auditors can open the queue. Viewers cannot.

Each card is one approval request:

- Invoice number and vendor. The invoice number opens the bill.
- Amount and currency.
- The policy reason, such as a new vendor, a missing purchase order, or an amount that needs a second person.
- Progress, written as approved count over required count (`0/1` or `1/2`).
- Risk badges. A red badge is a hard risk.

## Decide

A pending request shows a note field, **Approve**, and **Reject**. Admins and approvers can submit. Payers and auditors can read the queue and cannot decide.

One person cannot vote twice on the same request. When the approved count reaches the required count, the invoice becomes `approved`, the vendor is no longer marked new, and Custara sets a recommended pay date. **Reject** sets the invoice to `rejected`.

If the card says `0/2`, a second admin or approver must approve before anyone can pay.

An empty queue says **No approval requests**.
