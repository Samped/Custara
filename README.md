# Custara — B2B Finance Agent (Enterprise)

Privacy-first, embeddable AI finance operations platform for companies and fintechs:

- Invoice intelligence with confidence + risk evidence
- Versioned policy engine and maker-checker approvals
- Encrypted beneficiary details + append-only audit
- Durable async pipeline jobs
- Accounting export + Nigeria payment partner sandbox
- Partner API with scopes, rate limits, and idempotency

## Architecture

- **App:** Next.js App Router + TypeScript
- **DB:** PostgreSQL (Prisma)
- **Jobs:** DB-backed durable queue (`BackgroundJob`) + worker process
- **Optional infra:** Redis/BullMQ + Docker Compose for production deploys
- **Security:** AES-256-GCM field encryption, httpOnly sessions, RBAC, API scopes

```bash
# Production-shaped local stack
npm run db:up      # embedded Postgres (terminal 1)
npx prisma db push
npm run db:seed
npm run worker     # invoice pipeline worker (terminal 2)
npm run dev        # console + API (terminal 3)
```

Or with Docker:

```bash
docker compose up -d
# set DATABASE_URL=postgresql://custara:custara@127.0.0.1:5432/custara
npx prisma db push && npm run db:seed
npm run worker
npm run dev
```

## Demo access

| Email | Role |
|---|---|
| admin@custara.demo | admin |
| approver@custara.demo | approver |
| approver2@custara.demo | approver (dual control) |
| payer@custara.demo | payer |
| auditor@custara.demo | auditor |

**Login is Circle email OTP** (user-controlled wallet). Set `CIRCLE_API_KEY` + `CIRCLE_APP_ID` / `NEXT_PUBLIC_CIRCLE_APP_ID`, and configure SMTP in the Circle Console so Circle can email codes. After login, Custara links the Circle wallet as treasury and provisions the agent wallet for invoice payments.

API key: printed by seed / `storage/DEMO_CREDENTIALS.txt`

## Enterprise console

- `/app` Unified dashboard (KPIs, cash, pending, integrations)
- `/app/inbox` Invoice inbox
- `/app/onboarding` Company registration
- `/app/approvals` Maker-checker deck
- `/app/policies` Versioned policy publish + simulator
- `/app/connectors` Accounting CSV/Xero export + Nigeria rail
- `/app/settings` Privacy, payment mode, SSO posture
- `/app/developers` **API keys, webhooks, curl guide, OpenAPI**
- `/app/audit` Append-only trail with request IDs

## Integrate your company systems

1. Sign in → register company → open **API & guide** (`/app/developers`)
2. Generate a scoped API key (Bearer `cst_live_…`)
3. Ingest invoices:
   - `POST /api/v1/invoices` (ERP) with `Idempotency-Key`
   - `POST /api/v1/invoices/bulk` (CSV)
   - Inbox UI upload (JSON / PDF / CSV)
   - Email: forward attachments to org ingest address, or IMAP on **Connectors**, or `POST /api/ingest/mailbox`
4. Register a webhook URL (`invoice.ingested`, approvals, payments)
5. Optional: Xero / Nigeria payment connectors

Machine-readable contract: `GET /api/openapi`

```bash
export KEY=...

# Single invoice (sync analyze)
curl -s http://localhost:3000/api/v1/invoices \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: inv-demo-1" \
  -d '{"external_id":"inv_100","sync":true,"document":{"vendor_name":"Acme","invoice_number":"INV-100","total_amount":250000,"currency":"NGN"}}'

# Bulk CSV
curl -s http://localhost:3000/api/v1/invoices/bulk \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: bulk-1" \
  -d '{"sync":true,"csv":"vendor_name,invoice_number,total_amount,currency\nAcme,INV-2,10000,NGN\n"}'

curl -s http://localhost:3000/api/v1/payment-intents \
  -H "Authorization: Bearer $KEY" \
  -H "Idempotency-Key: pay-100" \
  -H "Content-Type: application/json" \
  -d '{"invoice_id":"...","rail":"nigeria_sandbox"}'
```

Env for email ingest: `MAILBOX_INBOUND_SECRET`, optional `INGEST_EMAIL_DOMAIN`.

## Security defaults

- Bank account numbers encrypted at rest (AES-GCM); UI shows last4 only
- Separation of powers: approver ≠ payer via RBAC + API scopes
- Payment mode defaults to **sandbox**; live requires org setting + `NIGERIA_PAYMENT_LIVE=true`
- Privacy Mode enabled by default with retention window
- Security headers middleware + request IDs

## Still staged for full enterprise rollout

- Production OIDC SSO login UI wiring
- Licensed live bank partner credentials
- SOC 2 evidence pack / pen test
- Multi-region HA Postgres

These are operational/compliance steps on top of this production-shaped codebase.
