# Custara SOC 2 readiness roadmap

Security questionnaire pack for enterprise procurement. This is a working control map, not a certification claim.

## Scope (in)

- Multi-tenant AP agent: ingest → extract → risk → policy → payment intents → Arc USDC / Nigeria export → reconcile
- Partner API (scoped keys, idempotency, rate limits)
- Hash-chained audit log + SIEM export
- Session auth (email OTP / Circle OTP / OIDC) + TOTP MFA + pay-time step-up

## Control map

| Domain | Status | Evidence / notes |
|--------|--------|------------------|
| Access control | Partial | Roles, MFA-required roles, invite-only orgs in production (`ALLOW_JIT_ORG_CREATION`), OIDC without JIT user creation |
| Encryption at rest | Partial | AES-256-GCM for bank fields + webhook secrets; Postgres disk encryption is deploy-owner |
| Encryption in transit | Partial | TLS terminated at edge; require HTTPS in production |
| Change management | Partial | GitHub PR CI: lint, typecheck, tenant-isolation tests |
| Logging / monitoring | Partial | Audit chain, webhook delivery DLQ, Circle unknown_tx alerts |
| Money movement | Hardened | Allowlist, spend caps, pay-time guards, payment_failed status, CIRCLE_WEBHOOK_SECRET fail-closed |
| Vendor / destination screening | Plug-in | `SCREENING_PROVIDER=http` + `SCREENING_API_URL` (default allowlist-only) |
| Data retention | Hardened | `retainedUntil` + BullMQ `retention-purge` worker |
| Availability | Partial | Redis/BullMQ required; durable repeatable crons; managed Redis recommended for HA |
| Subprocessors | Document | Circle (wallets/transfers), optional Resend/SMTP, optional S3 |

## Gaps before Type II readiness

1. Formal SOC 2 Type I/II engagement with an auditor
2. Penetration test + remediations
3. SCIM provisioning (admin invite covers SSO mapping today)
4. Customer-managed keys / BYOK
5. Formal incident response runbooks and tabletop evidence
6. Production KYC/KYB + sanctions vendor of record (beyond plug-in)

## Sales boundary

- **OK now:** design-partner pilots with sandbox Arc, Strict policy, auto-pay off
- **Not yet:** primary AP system of record for $50M+ enterprises without Wave 1–2 controls reviewed by customer security

## Questionnaire shortcuts

- **Do you support SSO?** Yes — OIDC; users must be admin-provisioned (no silent JIT tenants in production).
- **Is MFA available?** Yes — TOTP; step-up MFA on pay initiation in live mode.
- **Are API secrets encrypted?** Webhook signing secrets encrypted at rest (`enc:` AES-GCM).
- **Audit trail?** Append-only hash chain with export + verify endpoints.
- **Data deletion?** Privacy mode sets `retainedUntil`; purge worker removes bytes after expiry.
