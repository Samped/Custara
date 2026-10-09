# Invoice lifecycle

Every bill follows the same path.

```
ingest → extract → risk → policy → approve → pay timing → payment intent → settle → reconcile
```

## How an invoice arrives

| Channel | Where |
|---------|--------|
| Upload | Inbox, PDF or JSON |
| Partner API | `POST /api/v1/invoices` |
| CSV | `POST /api/v1/invoices/bulk` or Inbox |
| ERP | `POST /api/v1/erp/ingest` (`odoo`, `sap`, `dynamics`) |
| Email | Mailbox connector or `POST /api/ingest/mailbox` |
| SFTP | Drop folder polled by the worker |
| FIRS e-invoice | `POST /api/v1/einvoice/firs` |
| Vendor portal | Invite link on the vendor record |
| WhatsApp | Cloud API webhook, when configured |

`sync: true` on an API ingest runs extraction, risk, and policy in the request. Omit it and the worker runs the pipeline from the `invoice-pipeline` queue.

Writes should send `Idempotency-Key`. Reusing a key with the same body returns the original response. Reusing it with a different body returns `409`.

## Statuses

| Status | Meaning |
|--------|---------|
| `received` | Stored, pipeline not finished |
| `extracting` | Extraction in progress |
| `needs_review` | A hard risk or policy hold needs a person |
| `pending_approval` | Waiting on one or two approvers |
| `approved` | Cleared to pay on the recommended date |
| `payment_queued` | A payment intent exists and settlement is in flight |
| `payment_sent` | The rail accepted the payment |
| `reconciled` | A settlement row is tied to the invoice |
| `settled` | Closed through accounting sync where that path is used |
| `payment_failed` | The rail or a pay-time guard rejected the attempt |
| `rejected` | An approver rejected the bill |
| `duplicate_suspected` | Duplicate controls stopped automatic approval |

**Open invoices** on Home and Cash are bills that still need a payment decision: `received`, `extracting`, `needs_review`, `pending_approval`, and `approved`. A bill leaves that count when a payment intent is created.

## Risk

Hard risks block automatic approval and block pay until they are cleared.

| Code | Typical cause |
|------|----------------|
| `new_vendor` | Vendor has not been verified. Approval sets `isNew` to false. |
| `bank_detail_change` / `arc_address_change` | Payment destination changed |
| `duplicate_invoice`, `duplicate_document_checksum`, `fuzzy_duplicate` | Same bill or a near match |
| `contract_required` | Policy requires a purchase order and none is present |
| `destination_not_allowlisted` | Arc address is not on the organization allowlist |
| `address_screen_failed` | Optional address screener denied the destination, or live mode could not reach it |
| `low_confidence` | Extraction confidence is under the policy floor |

## Policy

Rules live on a versioned approval policy, edited under **Controls**. If no policy is published:

- Organizations in simulated mode use mid-market defaults (auto-approve up to 50,000 in the policy currency, or 5,000 USDC, confidence floor 0.60, purchase order not required).
- Switching payment mode to live publishes **PayablesAI Strict** when nothing is published yet: auto-approve up to 25,000 / 5,000 USDC, confidence floor 0.75, purchase order required, new-vendor and duplicate holds on.

Decisions:

| Decision | Result |
|----------|--------|
| `auto_approve` | Invoice becomes `approved` |
| `single_approval` | One approver |
| `dual_control` | Two different approvers |
| `hold` | Stays in review |
| `reject_duplicate` | Duplicate path |

An approver cannot decide twice on the same request. The API picks an eligible admin or approver when `approver_email` is omitted.

## Pay timing

After approval, Custara sets `recommendedPayDate`.

- An early-pay discount is taken when cash covers it.
- If a discount exists but cash is tight, the date moves to the due date.
- If the organization sets **target days payable** (0–365), the date is the issue date plus that many days, never later than the due date, and never before today.
- Otherwise the date is the due date.

Autopay, on by default, pays approved invoices for vendors that are not new, on the recommended date, when no hard risk remains. Amounts above the policy ceiling still need a human approval before the status becomes `approved`. The system actor that runs autopay does not require MFA.
