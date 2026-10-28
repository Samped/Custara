# Home

Home is `/app`. Open it from **Go to → Work → Home**. Anyone who can read the inbox can open it.

Home is the workspace summary. It refreshes every few seconds while the tab is visible, so a bill created from the API or CLI appears without a reload.

Payers and admins see **Money**: **Pay client** in every workspace, plus **Fund** and **Withdraw** when the company of record is Nigeria, Ghana, Tanzania, Kenya, or South Africa. Details are in [Fund, withdraw, Pay client](money-rails.md).

## What you see

| Card | Opens |
|------|--------|
| Approvals | Count of requests still waiting. Opens [Approvals](approvals.md). |
| Pay queue | Bills with a payment in flight. Opens [Pay](pay.md). |
| Open invoices | Bills that still need a payment decision, with the total in the dashboard currency. Opens [Inbox](inbox.md). |
| Payment wallet | USDC balance of the wallet that pays vendors. **Low balance** means it is under 5 USDC. Opens Pay → Wallets. |

**Needs approval** lists the first waiting requests, with how many approvals are in (`1/1` or `1/2`). **Recent invoices** lists the latest bills. A row with a receipt opens the receipt. A row without one opens the invoice.

## Upload from Home

Admins and payers see **Upload invoice**. The dialog accepts JSON, TXT, or PDF. Choose a file or drop it, then confirm. Viewers, approvers, and auditors do not see the button.

**API** opens the developers page for keys and the quickstart.
