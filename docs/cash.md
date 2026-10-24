# Cash

Cash is `/app/cash`. Open it from **Go to → Money → Cash**. Every workspace role can open it.

Amounts use the dashboard currency from [Settings](settings.md).

## Outlook

Outlook compares what you owe with the inflow you entered in Settings.

| Figure | Meaning |
|--------|---------|
| Obligations 7d / 30d | Approved and open bills due in that window |
| Inflow 7d / 30d | Expected inflow saved on the organization |
| 7d gap / 30d gap | Obligations minus inflow. A gap above zero needs funding. |

**Aged payable** buckets open residual as current, 1–30, 31–60, 61–90, and 90+ days past due. The same buckets appear on Home and on each vendor workspace.

**Recommendation** is the sentence Custara writes from that gap. The line under it says whether auto-pay is on. **Suggested pays this week** lists approved bills whose recommended pay date falls in the week, with the reason (due date, early-pay discount, or target days payable). Each row opens the invoice.

## Collections

Collections is money owed to you.

- **Add customer** creates the customer Custara will remind.
- **Open receivable** records an amount, currency, and due date against that customer.
- **Priority queue** lists open receivables with a score, reminder count, and **Mark paid**.

Marking a receivable paid removes it from the open queue.
