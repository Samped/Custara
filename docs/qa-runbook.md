# Custara QA runbook

End-to-end checklist from ingest through payment and reconcile. Use after `npm run db:seed` with Redis + `npm run worker` + `npm run dev` running.

Fixtures: `npm run fixtures:generate` → [`fixtures/`](../fixtures/). Local pay-ready (gitignored): `npm run fixtures:pay-ready` → `test-fixtures/pay-ready/` (see [fixtures/README.md](../fixtures/README.md)).

Demo users (sandbox email OTP when Circle App ID unset):

| Email | Role |
|-------|------|
| admin@custara.demo | admin |
| approver@custara.demo | approver |
| approver2@custara.demo | approver |
| payer@custara.demo | payer |
| auditor@custara.demo | auditor |

API key: seed output / `storage/DEMO_CREDENTIALS.txt`.

---

## 1. Bootstrap

- [ ] `GET /api/health` → `ok`
- [ ] Seed org `lagos-distribution` present
- [ ] Worker logs show BullMQ ready

## 2. Seed invoice asserts

On `/app/inbox` (or API list):

| external_id | Expected status (approx) |
|-------------|--------------------------|
| inv_small_001 | `approved` |
| inv_dual_002 | `pending_approval` (dual) |
| inv_bankchange_003 | `needs_review` |
| inv_newvendor_004 | `needs_review` |
| inv_dup_005 | `duplicate_suspected` |
| inv_arc_usdc_006 | `needs_review` (`destination_not_allowlisted`) |

## 3. UI PDF upload

1. Sign in as admin → `/app/inbox`
2. Upload `fixtures/invoices/happy-ngn.pdf` → detail shows vendor **Northern Haulage Ltd**, amount 42000
3. Upload `fixtures/invoices/new-vendor.pdf` → status `needs_review`, risk `new_vendor`

## 4. CSV bulk

- [ ] UI: upload `fixtures/csv/bulk-ap.csv`
- [ ] API: `POST /api/v1/invoices/bulk` with CSV body + Bearer key + `Idempotency-Key`

## 5. API sync vs async

```bash
# sync
curl -s localhost:3000/api/v1/invoices -H "Authorization: Bearer $KEY" \
  -H "Idempotency-Key: qa-sync-1" -H "Content-Type: application/json" \
  -d @<(jq -n --slurpfile d fixtures/invoices/low-confidence.json '{external_id:"qa_low",sync:true,document:$d[0]}')

# async (needs worker)
# same with "sync": false → poll GET /api/v1/invoices/{id} until not extracting/received
```

Expect low-confidence → `needs_review`.

## 6. Mailbox webhook

Set `MAILBOX_INBOUND_SECRET` in `.env`. POST multipart/JSON per `/api/ingest/mailbox` (see OpenAPI). Expect invoice `source=mailbox` after worker runs.

## 7. SFTP drop

Copy a fixture PDF into `storage/sftp-drops/{orgId}/incoming/`, open `/app/connectors` → Process drop. File moves to `processed/`.

## 8. Vendor portal

`/app/vendor-portal` → create invite → open `/vendor/{token}` → upload `happy-ngn.pdf` with unique invoice number.

## 9. FIRS + ERP

```bash
curl -s localhost:3000/api/v1/einvoice/firs -H "Authorization: Bearer $KEY" \
  -H "Idempotency-Key: qa-firs-1" -H "Content-Type: application/json" \
  -d @fixtures/api/firs.json

curl -s localhost:3000/api/v1/erp/ingest -H "Authorization: Bearer $KEY" \
  -H "Idempotency-Key: qa-erp-1" -H "Content-Type: application/json" \
  -d @fixtures/api/erp-odoo.json
```

## 10. Dual approval

1. Approver1 on `/app/approvals` → approve `inv_dual_002` (or FIX-DUAL)
2. Same user cannot approve twice (maker-checker)
3. Approver2 completes second decision → invoice `approved` + pay timing set

## 11. Arc pay (Circle Arc testnet — real txs)

See also [agent-payments.md](./agent-payments.md) for task types, autopay timing, and on-chain status tracking.

Requires `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`, `ARC_PAYMENTS_LIVE=true`, `ARC_ALLOW_LIVE_ON_TESTNET=true`, `ARC_ALLOW_SIMULATED=false`, `ARC_CHAIN=ARC-TESTNET`, funded **Circle** agent wallet.

Local upload files (gitignored): `npm run fixtures:pay-ready` → `test-fixtures/pay-ready/agent-pay-usdc.pdf` (or `.json`).

1. Settings → Payment mode **live**; Wallets → **Upgrade to Circle testnet**; fund + Sync
2. Upload pay-ready Arc file → **Confirm destination & unlock pay** (`0xd9792bf937d9673ab08c452fe55ec4e26632be54`; seed fixtures still use `0x1111…1111`)
3. Verify new vendor / approve until invoice `approved` if needed
4. Payer → Initiate payment (MFA if required in live)
5. Worker `arc_transfer` → real Circle tx → Payments mode must not say `simulated`

Automated: `E2E=1 npm run test:e2e` (Arc file skips without Circle keys) and `npx playwright test e2e/pay-arc.spec.ts`.

## 12. Nigeria export pay

Local upload files (gitignored): `test-fixtures/pay-ready/export-pay-ngn.pdf` (or `.json`) after `npm run fixtures:pay-ready`.

On an approved NGN invoice **without** Arc endpoint:

1. Payer → Initiate payment
2. Intent rail `nigeria_sandbox` / exported
3. Download CSV via `/api/internal/exports/{intentId}` (session)

## 13. Pay guards

- [ ] Pay while status `needs_review` → error
- [ ] User with MFA enabled, live pay without MFA code → step-up error
- [ ] User with MFA off can initiate live pay without MFA code
- [ ] Live API pay without `X-Custara-Step-Up` when `API_PAY_STEPUP_SECRET` set → 400

## 14. Reconcile

- [ ] UI Mark reconciled on `payment_sent`
- [ ] `POST /api/v1/reconcile` with `invoice_id` + `amount` → `reconciled`

## 15. Manual-only (not automated)

- WhatsApp webhook, live Xero/QBO OAuth, production Circle OTP email delivery

---

## Commands cheat sheet

```bash
npm run fixtures:generate
npm run db:up          # or docker compose up -d
npx prisma db push && npm run db:seed
redis-server           # if not Compose
npm run worker
npm run dev
E2E=1 npm run test:e2e
npx playwright install chromium   # once
npm run test:e2e:ui
```
