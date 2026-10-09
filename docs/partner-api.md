# Partner API

The base URL is the deployment origin. Local development uses `http://localhost:3000`.

Machine clients send `Authorization: Bearer cst_live_…`. MFA, organization settings, and team invites use a user session from `POST /api/v1/cli/login/finish`. See [CLI](cli.md).

The machine-readable contract is `GET /api/openapi`.

## Conventions

- Send `Content-Type: application/json` on JSON bodies.
- Send `Idempotency-Key` on creates. The same key and body replays the first response. The same key and a different body returns `409` with `Idempotency-Key reused with different payload`.
- Cursor lists accept `limit` and `cursor` and return `data` plus `next_cursor`.
- Errors are `{ "error": "message" }` with an HTTP status.
- Rate limits are per organization and route. Exceeding them returns `429`.

## Invoices

### Create

`POST /api/v1/invoices` requires `invoices:write`.

```bash
curl -sS -X POST "$CUSTARA_URL/api/v1/invoices" \
  -H "Authorization: Bearer $CUSTARA_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: erp-1001" \
  -d '{
    "external_id": "erp-1001",
    "sync": true,
    "currency": "USDC",
    "document": {
      "vendor_name": "Acme Supplies",
      "invoice_number": "INV-1001",
      "total_amount": 25,
      "currency": "USDC",
      "due_date": "2026-10-20",
      "arc_address": "0xVENDOR",
      "confidence": 0.95
    }
  }'
```

`sync: true` runs the pipeline before the response. The body includes `id` and `status`. Use a new idempotency key and a new invoice number for each bill.

### Read

| Method | Path | Scope |
|--------|------|--------|
| GET | `/api/v1/invoices` | `invoices:read` |
| GET | `/api/v1/invoices/{id}` | `invoices:read` |
| GET | `/api/v1/invoices/{id}/analysis` | `invoices:read` |
| POST | `/api/v1/invoices/bulk` | `invoices:write` |
| GET | `/api/v1/invoices/csv-template` | none |

Bulk accepts JSON `{ "csv": "...", "sync": true }` or a `text/csv` body. The CSV template endpoint downloads the column header row.

### ERP

`POST /api/v1/erp/ingest` with `{ "system": "odoo" | "sap" | "dynamics", "payload": { }, "sync": false }`. Field maps are in [ERP adapters](erp-adapters.md).

`POST /api/v1/einvoice/firs` accepts a structured FIRS payload.

## Approvals

`POST /api/v1/approvals/{id}/decide` requires `approvals:write`.

```json
{ "decision": "approved", "note": "ok", "approver_email": "approver@company.com" }
```

`decision` is `approved` or `rejected`. Omit `approver_email` and the server selects an admin or approver who has not yet voted. The approval id comes from analysis: `policy_result.latest_approval.id`.

A full approval clears the new-vendor hold and sets a recommended pay date.

## Payments

`POST /api/v1/payment-intents` requires `payments:initiate`, `invoice_id`, and an idempotency key.

```json
{ "invoice_id": "INVOICE_ID", "rail": "arc_usdc" }
```

`rail` defaults to `arc_usdc`, which settles USDC on Arc. `nigeria_sandbox` produces a bank export file. In live mode that rail is rejected unless `NIGERIA_PAYMENT_LIVE=true`.

The response includes `id`, `status`, `rail`, `mode`, `circle_tx_id`, `tx_hash`, `amount`, and `currency`. `mode` is `live` when the organization payment mode is live.

If `API_PAY_STEPUP_SECRET` is set, add `X-Custara-Step-Up`.

The API returns an error when the invoice is not approved, the destination is not allowlisted, a hard risk remains, or the agent balance is short. See [Payments and treasury](payments-and-treasury.md).

## Vendors and wallets

`POST /api/v1/vendors` (`invoices:write`) creates a vendor. With `arc_address`, the endpoint type is `arc_usdc` and the address is allowlisted.

`GET /api/v1/wallets` (`cash:read`) lists wallets.

`POST /api/v1/wallets` (`payments:initiate`) accepts `{ "action": "provision_agent" }` or `{ "action": "sync" }`.

## Cash, audit, reconcile

| Method | Path | Scope |
|--------|------|--------|
| GET | `/api/v1/cash/forecast` | `cash:read` |
| GET | `/api/v1/audit/export` | `audit:read` |
| GET | `/api/v1/audit/verify` | `audit:read` |
| POST | `/api/v1/reconcile` | `payments:initiate` |

Audit export is cursor-paginated (`limit`, `cursor`) and is shaped for a SIEM. Verify returns whether the hash chain is intact. A broken chain responds with `409`.

## Webhooks

`GET` and `POST /api/v1/webhooks`, and `DELETE /api/v1/webhooks/{id}`, require `connectors:write`. Create returns the signing secret once. See [Webhooks](webhooks.md).

## Account routes for the CLI

These accept a user session bearer, not an API key.

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/v1/cli/login/start` | Send or log an email code. Body `{ "email" }` |
| POST | `/api/v1/cli/login/finish` | Body `{ "email", "code" }`. Returns `token`, `email`, `expiresAt` |
| GET | `/api/v1/cli/whoami` | User session or API key identity |
| POST | `/api/v1/cli/mfa` | `{ "action": "begin" \| "confirm" \| "disable", "code" }` |
| POST | `/api/v1/cli/settings` | Admin: `save_org`, `save_mfa_threshold`, `invite_member` |

`begin` returns `{ "secret", "otpauth" }`. Confirm and disable require the current authenticator code.

## Health

`GET /api/health` needs no authentication. `ok` is false when Redis or another check fails. Read `checks` and `gates` rather than treating every `503` as a down database. `gates` reports Arc, Circle, Nigeria, and storage flags without secrets.
