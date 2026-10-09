# Getting started

## Requirements

- Node.js 20 or newer
- PostgreSQL 16 (embedded helper or Docker)
- Redis 7, required for the background worker

## Install

```bash
git clone https://github.com/Samped/Custara.git
cd Custara
cp .env.example .env
npm install
```

Set at least these values in `.env`:

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Postgres connection string |
| `REDIS_URL` | Redis for BullMQ |
| `SESSION_SECRET` | Session signing secret, 16 characters or more |
| `ENCRYPTION_KEY` | AES-256-GCM key for bank numbers and webhook secrets |

The example file points Postgres at `127.0.0.1:54329`, which is the embedded database port.

## Run

Use three processes.

**Database**

```bash
npm run db:up
npx prisma db push
```

`npm run db:seed` and `npm run db:reset` delete every organization and user, then recreate only the demo workspace. Do not seed a database that already holds a real workspace. After a schema change on an existing database, run `npx prisma db push` alone.

Docker Compose is the alternative: `docker compose up -d` starts Postgres on port 5432 and Redis on 6379. Point `DATABASE_URL` at that Postgres if you use Compose.

**Worker**

```bash
redis-server
npm run worker
```

Skip `redis-server` when Compose already provides Redis. Without Redis and the worker, invoice analysis still runs when an API call sets `sync: true`, but queued transfers, webhooks, mailbox polls, and autopay do not move.

**Application**

```bash
npm run dev
```

Open `http://localhost:3000`.

## Sign in

When `CIRCLE_APP_ID` is set, Circle sends the email one-time code. When it is unset, Custara sends the code through Resend or SMTP if those are configured. In local development with no mail transport, the code is printed in the server log.

An email maps to one workspace membership. Signing in again returns that same workspace. Outside production, an unknown email can create a workspace when just-in-time creation is enabled. That workspace starts in live payment mode and settles USDC on Arc when the Arc environment gates are on.

Invite teammates from **Settings**. Roles are admin, approver, payer, viewer, and auditor. See [Security](security.md).

## First Arc payment

1. In **Settings**, set payment mode to live. Live mode settles USDC on Arc.
2. Open **Pay → Wallets**. Provision a Circle agent wallet, fund it with USDC, and sync the balance.
3. Allowlist the vendor Arc address, or create the vendor through the API or CLI with `arc_address`, which allowlists it.
4. Ingest a USDC invoice. A new vendor stays in review until a person approves it.
5. Pay with rail `arc_usdc` from the invoice screen, the Partner API, or `custara pay`.

Health is `GET /api/health`. A `503` with `checks.database.ok: true` and Redis down means the app is up and the worker queue is not.
