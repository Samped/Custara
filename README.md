# Custara

Custara is an accounts-payable system for B2B teams. It takes invoices from email, upload, CSV, or API, runs extraction and risk checks, applies a versioned approval policy, and settles approved bills in Arc testnet USDC through Circle. Nigeria bank movement is an export file unless a licensed live flag is on.

This repo is the full app: console, Partner API, CLI, background worker, and Postgres schema.

**Documentation:** [docs/README.md](docs/README.md)

**Status:** usable for design-partner pilots on Arc testnet. Not a SOC 2–certified primary ledger — see [docs/soc2-roadmap.md](docs/soc2-roadmap.md).

---

## What it does

```
ingest → extract → risk → policy → (approve) → pay timing → payment intent → Arc / NG export → reconcile
```

| Area | Details |
|------|---------|
| Ingest | Upload, CSV, org ingest email, mailbox webhook, SFTP drop, FIRS e-invoice, ERP adapters, vendor portal |
| Controls | Versioned policies, maker-checker approvals, MFA above a USD threshold, destination allowlist, spend caps |
| Money | Arc USDC via Circle agent wallet; Nigeria rail is export/sandbox unless partner live is enabled |
| Audit | Hash-chained events, request IDs, SIEM export |
| API | Scoped keys, idempotency, rate limits — `GET /api/openapi` |

Auto-pay for approved vendors is **on** by default. Live payment mode applies stricter policy defaults. API pay in live mode requires `X-Custara-Step-Up` only when `API_PAY_STEPUP_SECRET` is set.

---

## Stack

- [Next.js](https://nextjs.org/) (App Router) + TypeScript
- [PostgreSQL](https://www.postgresql.org/) via [Prisma](https://www.prisma.io/)
- [Redis](https://redis.io/) + [BullMQ](https://docs.bullmq.io/) for the worker
- [Circle](https://www.circle.com/) programmable wallets (Arc USDC + optional email OTP)
- Local disk or S3 for documents

---

## Requirements

- Node 20+
- Postgres 16 (embedded helper or Docker)
- Redis 7 (required for the worker)

---

## Quick start

```bash
git clone https://github.com/Samped/Custara.git
cd Custara
cp .env.example .env
npm install
```

**Terminal 1 — database**

```bash
# Option A: embedded Postgres on :54329 (matches .env.example)
npm run db:up

# Option B: Docker Compose (Postgres :5432 + Redis :6379)
docker compose up -d
# then set DATABASE_URL=postgresql://custara:custara@127.0.0.1:5432/custara in .env
```

**Migrate + seed**

```bash
npx prisma db push
npm run db:seed
```

> **Warning:** `npm run db:seed` and `npm run db:reset` **delete all organizations and users**, then recreate only the Lagos demo workspace. Your own startup (e.g. LOOP) and its data will be wiped. Do **not** seed when you want to keep a workspace you registered via OTP. Prefer `npx prisma db push` alone after schema changes.

Your email is tied to one startup membership (`WorkspaceUser.email` is globally unique). Log out and back in resumes the same company — unless the database was wiped as above.
**Terminal 2 — Redis + worker** (skip Redis if Compose already started it)

```bash
redis-server   # if not using docker compose
npm run worker
```

**Terminal 3 — app**

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Seed users (email OTP / Circle OTP depending on env):

| Email | Role |
|-------|------|
| `admin@custara.demo` | admin |
| `approver@custara.demo` | approver |
| `approver2@custara.demo` | approver (dual control) |
| `payer@custara.demo` | payer |
| `auditor@custara.demo` | auditor |

API key material is written by seed (see seed output / local credentials file under `storage/` when present).

Health: `GET /api/health`

---

## Configuration

Copy [`.env.example`](.env.example). Minimum for local:

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Postgres |
| `REDIS_URL` | Worker queues |
| `SESSION_SECRET` | Session cookies (≥16 chars) |
| `ENCRYPTION_KEY` | Field encryption for bank details / webhook secrets |

Auth:

- **Circle user OTP** — set `CIRCLE_API_KEY` + `CIRCLE_APP_ID` / `NEXT_PUBLIC_CIRCLE_APP_ID` (Circle sends the email).
- **Local email OTP** — if Circle App ID is unset, configure `RESEND_API_KEY` + `EMAIL_FROM` (or SMTP_*).

Payments:

- Arc: Circle developer-controlled wallet keys + `CIRCLE_WEBHOOK_SECRET` (required in production).
- Nigeria live bank movement stays gated behind `NIGERIA_PAYMENT_LIVE=true`.

Optional: OIDC (`OIDC_*`), Xero/QBO/Sage/Zoho, mailbox/SFTP/WhatsApp, S3 storage — all documented in `.env.example`.

---

## Console map

| Path | Purpose |
|------|---------|
| `/app` | Ops overview + team invites (admin) |
| `/app/inbox` | Ingest and triage |
| `/app/approvals` | Maker-checker |
| `/app/policies` | Publish / simulate rules |
| `/app/wallets` | Treasury + agent wallet + agent tasks |
| `/app/payments` | Payment intents (Arc USDC + export) |
| `/app/cash` | Obligations and suggested pays |
| `/app/collections` | Thin AR / dunning |
| `/app/connectors` | Ready ingest paths |
| `/app/developers` | Keys, webhooks, curl |
| `/app/settings` | Org, MFA, currency, team, live/sandbox |
| `/app/audit` | Audit trail |

---

## Partner API

Bearer API keys (`cst_live_…`). Prefer `Idempotency-Key` on writes. Live payments may require `X-Custara-Step-Up`.

```bash
export KEY=cst_live_…

curl -s http://localhost:3000/api/v1/invoices \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: inv-1" \
  -d '{
    "external_id": "inv_100",
    "sync": true,
    "document": {
      "vendor_name": "Acme Supplies",
      "invoice_number": "INV-100",
      "total_amount": 250000,
      "currency": "NGN"
    }
  }'
```

Full surface: [http://localhost:3000/api/openapi](http://localhost:3000/api/openapi)

ERP shape notes: [docs/erp-adapters.md](docs/erp-adapters.md)

---

## Tests

```bash
npm test                 # unit: tenant isolation + policy money + csv parse
npm run fixtures:generate
E2E=1 npm run test:e2e   # API/domain E2E (app + DB + seed; Arc skips without Circle)
npx playwright install chromium
npm run test:e2e:ui      # Playwright smoke (app must be running)
```

Full checklist: [docs/qa-runbook.md](docs/qa-runbook.md). Agent tasks / Arc on-chain: [docs/agent-payments.md](docs/agent-payments.md). Sample files: [fixtures/](fixtures/).

---

## Repo layout

```
src/app/          # Next.js routes (console + API)
src/domain/       # Business logic (pipeline, payments, Arc, connectors)
src/lib/          # Auth, crypto, jobs, audit, storage
src/worker.ts     # BullMQ consumers + scheduled jobs
prisma/           # Schema + seed
tests/            # Node test runner
cli/              # custara command-line client
docs/             # Operator and integrator handbook
```

---

## Security notes (honest)

- Bank account numbers and webhook signing secrets are encrypted at rest (AES-256-GCM).
- Production disables JIT org creation unless `ALLOW_JIT_ORG_CREATION=true`.
- Each email maps to one workspace membership (login resumes the same startup). Admins invite teammates from the dashboard Team panel with roles: Viewer, Approver, Payer (upload + pay), Auditor, Admin (API + settings).
- SSO users must be invited first; OIDC is supported, SCIM/SAML are not.
- Destination screening defaults to allowlist-only; optional HTTP screener via `SCREENING_PROVIDER`.
- Nigeria fiat is file export unless a licensed partner live flag is set.

---

## What’s still open

- SOC 2 Type I/II and a third-party pen test
- KYC/KYB + a sanctions vendor of record (plug-in exists; no VoR baked in)
- SCIM / SAML
- Multi-region HA story beyond a single Redis URL
- Full AR product depth (collections today are thin)

Tracked in [docs/soc2-roadmap.md](docs/soc2-roadmap.md).

---

## License

Proprietary for now — no open-source license is published in this repository. Contact the maintainers before redistributing.
