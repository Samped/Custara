# Operations

## Processes

| Process | Command | Role |
|---------|---------|------|
| Database | `npm run db:up` or Docker Compose | Postgres |
| Application | `npm run dev` or `npm run build && npm start` | HTTP, console, Partner API |
| Worker | `npm run worker` | BullMQ consumers and crons |
| Redis | `redis-server` or Compose | Required by the worker |

Queues: `invoice-pipeline`, `agent-tasks`, `webhooks`, `xero-sync`, `accounting-sync`, `mailbox-poll`, `sftp-poll`, `payment-schedule`, `collections-dunning`, `retention-purge`.

Scheduled work includes autopay, collections reminders, mailbox and SFTP polls, and retention deletion of expired documents.

If Redis is unreachable, jobs are stored in Postgres as pending and a warning is logged. Arc pay from the API still attempts the transfer inside the request. Webhook delivery, autopay, and polls wait for Redis and the worker.

## Health

`GET /api/health`

| Field | Meaning |
|-------|---------|
| `ok` | True only when required checks pass |
| `checks.database` | Postgres |
| `checks.redis` | `PONG` from Redis |
| `checks.storage` | Local disk or S3 |
| `gates` | Arc, Nigeria, Circle, OIDC, and storage flags. No secrets |

A `503` with a healthy database and a closed Redis connection means fix Redis before you rely on background work.

## Schema

```bash
npx prisma db push
```

Do not run `db:seed` or `db:reset` on a database you need to keep. Both wipe organizations.

After a schema change, restart `npm run dev` if a page reports an unknown Prisma field. The dev server can keep a generated client from before the push.

## Storage

`STORAGE_BACKEND=local` uses `STORAGE_ROOT` or the default local directory. `s3` uses `S3_BUCKET`, `S3_REGION`, and credentials. `S3_ENDPOINT` targets MinIO or another S3-compatible store.

## Tests

```bash
npm test
npm run fixtures:generate
E2E=1 npm run test:e2e
```

`npm test` covers policy, currency, tenant isolation, collections cadence, and the CLI client. End-to-end tests need `E2E=1` and a database. The Arc Circle test skips when Circle credentials are absent. Set `E2E_ARC=0` to skip that suite on purpose. The checklist is [QA runbook](qa-runbook.md).

## CLI package

```bash
npm run build --prefix cli
```

Output is `cli/dist` and is not committed. Install with `npm i -g ./cli` from the repository root.

## Hosting on Vercel and Render

The public site is the Next.js app on Vercel at `https://custara.xyz`. Postgres, Redis, and the worker run on Render’s free plan. `render.yaml` at the repository root is the blueprint.

Free Render Postgres is 1 GB, has no backups, and expires 30 days after creation. After a 14-day grace period Render deletes it. Free Key Value is 25 MB and does not keep data across restarts. The worker is a free web service, because background workers are not on the free plan. It sleeps after 15 minutes without HTTP traffic. Autopay, webhook delivery, and polls resume when the next request wakes it. A ping every 10 minutes to the worker `/health` URL keeps it awake.

Vercel and the worker do not share a disk. Set `STORAGE_BACKEND=s3` and point `S3_ENDPOINT` at a Cloudflare R2 bucket (or another S3-compatible store). Invoice files fail in production without that.

### Render

Create a Blueprint from this repository. The worker build installs dev dependencies because `tsx` and the Prisma CLI live there. The free plan does not allow a pre-deploy command, so the start command runs `npx prisma db push` and then the worker. Do not seed.

Copy the **external** Postgres URL and the Key Value URL for Vercel. The worker receives the internal URLs from the blueprint. Fill the prompted secrets on the worker: `SESSION_SECRET`, `ENCRYPTION_KEY`, Circle keys, `ARC_CHAIN`, and the R2 keys. `APP_URL` is `https://custara.xyz`.

### Vercel

Import the GitHub repository. Framework is Next.js. Node.js is 20. Set the same `DATABASE_URL` (external), `REDIS_URL` (`rediss://`), `SESSION_SECRET`, `ENCRYPTION_KEY`, `OPENAI_API_KEY`, Circle keys, `ARC_PAYMENTS_LIVE=true`, `ARC_ALLOW_SIMULATED=false`, `ARC_CHAIN`, `APP_URL`, `NEXT_PUBLIC_APP_URL`, and the R2 variables. `OPENAI_API_KEY` is required for invoice extraction on both Vercel and the worker.

Set `ALLOW_JIT_ORG_CREATION=true` only until the first workspace exists, then remove it and redeploy. Production does not create a workspace for an unknown email when that variable is unset.

### DNS

At the registrar for `custara.xyz`:

| Record | Name | Value |
|--------|------|--------|
| A | `@` | `76.76.21.21` |
| CNAME | `www` | `cname.vercel-dns.com` |

Add `custara.xyz` and `www.custara.xyz` in the Vercel project and wait for the certificate.

### After the first deploy

- `GET https://custara.xyz/api/health` returns `ok: true` when Postgres and Redis answer.
- Circle webhooks go to `https://custara.xyz/api/webhooks/circle`.
- `CIRCLE_WEBHOOK_SECRET` is set on Vercel. Production rejects unsigned Circle webhooks.
- The worker log shows `worker health listening`.

## Production checklist

- `SESSION_SECRET` and `ENCRYPTION_KEY` are long random values, not the examples
- `ALLOW_JIT_ORG_CREATION` is false
- Redis is reachable and the worker is supervised
- `STORAGE_BACKEND=s3` with a private bucket
- `ARC_ALLOW_SIMULATED=false`
- Circle entity secret and webhook secret are set before live USDC volume
- `NIGERIA_PAYMENT_LIVE` stays false until a bank partner is contracted
- OIDC is configured if the organization enforces SSO
- MFA threshold is set to the organization's policy, not left at the default by accident
- `GET /api/health` returns `ok: true`
- API keys are scoped to what each integration needs and can be revoked
- Webhook endpoints are HTTPS and verify signatures

## Incident handles

| Symptom | Look at |
|---------|---------|
| Pay stays `pending_transfer` and Circle has no transaction | Redis and the worker |
| `Idempotency-Key reused with different payload` | The client reused a key for a new body. Send a new key |
| `Invoice not found` on pay | The id is a placeholder or belongs to another workspace |
| `Invoice status needs_review cannot create payment intent` | Approve the bill first. Analysis lists the hard risks |
| Destination not allowlisted | Allowlist the vendor Arc address, or create the vendor with `arc_address` |
| Agent balance does not cover the amount | Fund the agent with USDC, then `custara wallets sync` |

## License

No open-source license is published. Contact the maintainers before redistributing the repository or the CLI package.
