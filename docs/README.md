# Custara documentation

Custara is an accounts-payable system. It ingests supplier invoices, scores risk, applies a versioned approval policy, and settles approved bills in USDC on Arc through Circle. Home can **Pay client** in USDC, and African workspaces can **Fund** and **Withdraw** local currency through PAJ (NGN, GHS, TZS, KES, ZAR). Nigeria file-export is a separate, gated rail.

This handbook is the operator and integrator reference.

## Who should read what

| Reader | Start here |
|--------|------------|
| Operator standing up a workspace | [Getting started](getting-started.md) |
| Finance, approver, or payer | [Home](home.md), [Inbox](inbox.md), [Approvals](approvals.md), [Console](console.md) |
| Treasurer or payer moving USDC | [Payments and treasury](payments-and-treasury.md), [Fund, withdraw, Pay client](money-rails.md) |
| Security or compliance | [Security](security.md), [Audit](audit.md) |
| Engineer integrating an ERP or service | [Partner API](partner-api.md), [Webhooks](webhooks.md), [CLI](cli.md) |
| Platform operator | [Operations](operations.md) |

## Map

1. [Getting started](getting-started.md) — install, database, worker, first sign-in
2. [Invoice lifecycle](invoice-lifecycle.md) — statuses, risk, policy, timing
3. [Console](console.md) — workspace map
4. Work, Money, and Admin in the docs sidebar — each screen in the **Go to** menu
5. [Payments and treasury](payments-and-treasury.md) — Arc USDC, allowlist, autopay, balances. Home Money: [Fund, withdraw, Pay client](money-rails.md)
6. [Security](security.md) — sessions, MFA threshold, API keys, encryption
7. [Partner API](partner-api.md) — authentication, scopes, endpoints, idempotency
8. [CLI](cli.md) — `custara` command for the same operations
9. [Webhooks](webhooks.md) — events, signing, delivery
10. [Connectors](connectors.md) — email, SFTP, ERP, accounting, WhatsApp
11. [Audit](audit.md) — hash chain, export, verification
12. [Operations](operations.md) — processes, two-host hosting, enterprise mainnet cutover

Reference:

- [Agent payments](agent-payments.md) — task queue, Circle transfer, reconcile
- [ERP adapters](erp-adapters.md) — Odoo connector, SAP, and Dynamics field maps
- [Odoo app](odoo-app.md) — optional Apps module (list after the two-host split)
- [Release verification](qa-runbook.md)
- [SOC 2 readiness](soc2-roadmap.md)

## Operating boundaries

Bank account numbers and webhook secrets are encrypted at rest. Production workspace creation for an unknown email is off unless `ALLOW_JIT_ORG_CREATION=true`. Each email belongs to one workspace. SOC 2 Type I and Type II reports are not issued; the control map is in [SOC 2 readiness](soc2-roadmap.md).
