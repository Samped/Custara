# Release verification

Checklist from ingest through payment and reconcile. Run it against a disposable database after `npm run db:seed`, with Redis, `npm run worker`, and the application running.

Generate fixtures with `npm run fixtures:generate`. Pay-ready local files (gitignored) come from `npm run fixtures:pay-ready`.

The seed command creates a demo workspace and prints an API key. Do not seed a database that holds a production workspace.

| Email | Role |
|-------|------|
| admin@custara.demo | admin |
| approver@custara.demo | approver |
| approver2@custara.demo | approver |
| payer@custara.demo | payer |
| auditor@custara.demo | auditor |

## 1. Bootstrap

- [ ] `GET /api/health` returns `ok: true`
- [ ] Seed organization is present
- [ ] Worker logs show the queues ready

## 2. Seed invoices

| external_id | Expected status |
|-------------|-----------------|
| inv_small_001 | `approved` |
| inv_dual_002 | `pending_approval` |
| inv_bankchange_003 | `needs_review` |
| inv_newvendor_004 | `needs_review` |
| inv_dup_005 | `duplicate_suspected` |
| inv_arc_usdc_006 | `needs_review` (`destination_not_allowlisted`) |

## 3. PDF upload

1. Sign in as admin and open `/app/inbox`.
2. Upload `fixtures/invoices/happy-ngn.pdf`. Detail shows vendor **Northern Haulage Ltd**, amount 42000.
3. Upload `fixtures/invoices/new-vendor.pdf`. Status is `needs_review` with risk `new_vendor`.

## 4. CSV bulk

- [ ] Upload `fixtures/csv/bulk-ap.csv` from Inbox
- [ ] `POST /api/v1/invoices/bulk` with a CSV body, bearer key, and `Idempotency-Key`

## 5. API sync and async

```bash
curl -s https://custara.xyz/api/v1/invoices -H "Authorization: Bearer $KEY" \
  -H "Idempotency-Key: qa-sync-1" -H "Content-Type: application/json" \
  -d @<(jq -n --slurpfile d fixtures/invoices/low-confidence.json '{external_id:"qa_low",sync:true,document:$d[0]}')
```

Expect `needs_review` for low confidence. Repeat with `"sync": false` and poll `GET /api/v1/invoices/{id}` until the status leaves `extracting` and `received`. Async ingest requires the worker.

## 6. Mailbox

Set `MAILBOX_INBOUND_SECRET`. Post to `/api/ingest/mailbox` as described in OpenAPI. After the worker runs, the invoice source is `mailbox`.

## 7. SFTP

Copy a fixture PDF into `storage/sftp-drops/{orgId}/incoming/`. On `/app/connectors`, process the drop. The file moves to `processed/`.

## 8. Vendor portal

On the vendor record, create an invite. Open `/vendor/{token}` and upload `happy-ngn.pdf` with a unique invoice number.

## 9. FIRS and ERP

```bash
curl -s https://custara.xyz/api/v1/einvoice/firs -H "Authorization: Bearer $KEY" \
  -H "Idempotency-Key: qa-firs-1" -H "Content-Type: application/json" \
  -d @fixtures/api/firs.json

curl -s https://custara.xyz/api/v1/erp/ingest -H "Authorization: Bearer $KEY" \
  -H "Idempotency-Key: qa-erp-1" -H "Content-Type: application/json" \
  -d @fixtures/api/erp-odoo.json
```

## 10. Dual approval

1. First approver approves `inv_dual_002` on `/app/approvals`.
2. The same user cannot approve twice.
3. Second approver completes the decision. The invoice is `approved` and a recommended pay date is set.

## 11. Arc pay

Requires Circle credentials, `ARC_PAYMENTS_LIVE=true`, `ARC_ALLOW_SIMULATED=false`, `ARC_CHAIN` for the deployment, and a funded Circle agent wallet. A test network also requires `ARC_ALLOW_LIVE_ON_TESTNET=true`.

`npm run fixtures:pay-ready` writes `test-fixtures/pay-ready/agent-pay-usdc.pdf`.

1. Set payment mode to live. Provision the Circle agent, fund it with USDC, and sync.
2. Upload the pay-ready file and confirm the destination. The address must be on the allowlist.
3. Clear review until the invoice is `approved`.
4. Initiate payment. MFA applies at or above the organization threshold.
5. The worker runs `arc_transfer`. The payment mode is `live` and `txHash` is the Circle transaction hash.

Automated coverage: `E2E=1 npm run test:e2e`. The Arc file skips when Circle credentials are absent.

## 12. Nigeria export

After `npm run fixtures:pay-ready`, use `test-fixtures/pay-ready/export-pay-ngn.pdf` on an approved NGN invoice with no Arc endpoint.

1. Initiate payment.
2. The intent rail is `nigeria_sandbox` and the status is exported.
3. Download the CSV from `/api/internal/exports/{intentId}` with a session.

## 13. Pay guards

- [ ] Pay while status is `needs_review` returns an error
- [ ] A user with MFA enabled who pays in live mode without a code receives a step-up error
- [ ] A user with MFA off can initiate a live payment under the threshold without a code
- [ ] Live API pay without `X-Custara-Step-Up`, when `API_PAY_STEPUP_SECRET` is set, returns 400

## 14. Reconcile

- [ ] Mark reconciled on a `payment_sent` invoice
- [ ] `POST /api/v1/reconcile` with `invoice_id` and `amount` sets `reconciled`

## 15. Manual checks

WhatsApp webhook delivery, live Xero and QuickBooks OAuth, and production Circle email delivery are verified by hand.

## Commands

```bash
npm run fixtures:generate
npm run db:up
npx prisma db push && npm run db:seed
npm run worker
npm run dev
E2E=1 npm run test:e2e
```
