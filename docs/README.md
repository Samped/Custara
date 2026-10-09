# Custara documentation

Custara is an accounts-payable system. It ingests supplier invoices, scores risk, applies a versioned approval policy, and settles approved bills in USDC on Arc through Circle. Nigeria bank movement is an export file unless a licensed live flag is turned on.

This handbook is the operator and integrator reference.

## Who should read what

| Reader | Start here |
|--------|------------|
| Operator standing up a workspace | [Getting started](getting-started.md) |
| Finance, approver, or payer | [Console](console.md), [Invoice lifecycle](invoice-lifecycle.md) |
| Treasurer or payer moving USDC | [Payments and treasury](payments-and-treasury.md) |
| Security or compliance | [Security](security.md), [Audit](audit.md) |
| Engineer integrating an ERP or service | [Partner API](partner-api.md), [Webhooks](webhooks.md), [CLI](cli.md) |
| Platform operator | [Operations](operations.md) |

## Map

1. [Getting started](getting-started.md) — install, database, worker, first sign-in
2. [Invoice lifecycle](invoice-lifecycle.md) — statuses, risk, policy, timing
3. [Console](console.md) — workspace screens
4. [Payments and treasury](payments-and-treasury.md) — Arc USDC, allowlist, autopay, balances
5. [Security](security.md) — sessions, MFA threshold, API keys, encryption
6. [Partner API](partner-api.md) — authentication, scopes, endpoints, idempotency
7. [CLI](cli.md) — `custara` command for the same operations
8. [Webhooks](webhooks.md) — events, signing, delivery
9. [Connectors](connectors.md) — email, SFTP, ERP, accounting, WhatsApp
10. [Audit](audit.md) — hash chain, export, verification
11. [Operations](operations.md) — processes, health, production checklist

Reference:

- [Agent payments](agent-payments.md) — task queue, Circle transfer, reconcile
- [ERP adapters](erp-adapters.md) — Odoo, SAP, and Dynamics field maps
- [Release verification](qa-runbook.md)
- [SOC 2 readiness](soc2-roadmap.md)

## Operating boundaries

Bank account numbers and webhook secrets are encrypted at rest. Production workspace creation for an unknown email is off unless `ALLOW_JIT_ORG_CREATION=true`. Each email belongs to one workspace. SOC 2 Type I and Type II reports are not issued; the control map is in [SOC 2 readiness](soc2-roadmap.md).
