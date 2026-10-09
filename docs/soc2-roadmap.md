# SOC 2 readiness

Control map for security review. Custara does not hold a SOC 2 Type I or Type II report.

## Scope

- Multi-tenant payables: ingest, extract, risk, policy, payment intents, USDC on Arc, Nigeria export, reconcile
- Partner API with scoped keys, idempotency, and rate limits
- Hash-chained audit log and export
- Email one-time code, Circle one-time code, or OpenID Connect, plus authenticator MFA on pay above the organization threshold

## Controls

| Domain | Status | Evidence |
|--------|--------|----------|
| Access control | Partial | Roles, invite-only workspaces in production (`ALLOW_JIT_ORG_CREATION` unset), OIDC with provisioned users |
| Encryption at rest | Partial | AES-256-GCM for bank fields and webhook secrets. Disk encryption is the operator's responsibility |
| Encryption in transit | Partial | TLS at the edge. Production endpoints are HTTPS |
| Change management | Partial | Pull-request checks: lint, typecheck, tenant-isolation tests |
| Logging | Partial | Audit chain, webhook dead-letter queue, Circle unknown-transaction alerts |
| Money movement | In place | Allowlist, spend caps, pay-time guards, `payment_failed`, Circle webhooks fail closed without `CIRCLE_WEBHOOK_SECRET` |
| Destination screening | Optional | `SCREENING_PROVIDER=http` and `SCREENING_API_URL`. Default is allowlist only |
| Data retention | In place | `retainedUntil` and the `retention-purge` worker |
| Availability | Partial | Redis and the worker are required. Use managed Redis where high availability is required |
| Subprocessors | Documented | Circle for wallets and transfers. Optional mail transport and S3 |

## Open items

1. SOC 2 Type I and Type II examination
2. Penetration test and remediation record
3. SCIM provisioning
4. Customer-managed encryption keys
5. Incident response runbook and tabletop record
6. A named sanctions and KYB vendor of record

## Review answers

- **SSO.** OpenID Connect. Users are provisioned by an admin. Production does not create a workspace for an unknown email.
- **MFA.** Authenticator (TOTP). A person paying at or above the organization USD threshold must be enrolled and must submit a current code. Autopay is exempt.
- **API secrets.** Webhook signing secrets are encrypted at rest with AES-256-GCM.
- **Audit trail.** Hash-chained events with export and verify endpoints.
- **Deletion.** Privacy mode sets `retainedUntil`. The purge worker removes stored bytes after expiry.
