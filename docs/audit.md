# Audit

Every material change writes an `AuditEvent`: who acted, what they did, which record changed, and a request id when the call came from the API.

Actors are `user`, `api_key`, or `system`. System covers autopay, the worker, and Circle reconcile.

## Hash chain

Events in an organization are chained. Each row stores the previous entry hash and its own hash over a canonical payload. `GET /api/v1/audit/verify` (scope `audit:read`) walks the chain.

- `200` and `ok: true` means the chain matches.
- `409` means a row was altered or removed. Treat that as a security incident, not a retry.

`custara audit verify` calls the same route. The console list is `/app/audit`.

## Export

`GET /api/v1/audit/export?limit=100&cursor=` returns a page of events for a SIEM. `limit` caps at 500. `custara audit export` prints the latest page. Page with `next_cursor` until it is null. Metadata is JSON. Bank account numbers are not included in the clear; those fields stay encrypted on the vendor endpoint.

## What is recorded

Representative actions:

| Action | When |
|--------|------|
| `auth.cli_login` / `auth.otp_verified` | Sign-in |
| `user.invited` | Team invite |
| `user.mfa_enroll_started`, `user.mfa_enabled`, `user.mfa_disabled` | Authenticator setup |
| `org.settings_updated` | Payment mode, autopay, profile |
| `org.mfa_pay_threshold_updated` | MFA pay threshold |
| `api_key.created`, `api_key.revoked` | Developer keys |
| `webhook.created`, `webhook.activated`, `webhook.deactivated` | Endpoints |
| `wallet.allowlist_added`, `wallet.allowlist_revoked` | Destinations |
| `wallet.balance_spent`, `wallet.balance_restored` | Agent balance movement around a transfer |
| `payment.intent_created` | Pay |
| `agent.arc_transfer`, `agent.arc_reconciled` | On-chain execution |
| `invoice.reconciled` | Settlement |
| `approval.decided` | Approver vote |

Request ids on API responses (`request_id`, header `x-request-id`) match the audit row when the route supplies one.
