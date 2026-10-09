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
