# Operations

## Processes

| Process | Command | Role |
|---------|---------|------|
| Database | `npm run db:up` or Docker Compose | Postgres |
| Application | `npm run dev` or `npm run build && npm start` | HTTP, console, Partner API |
| Worker | `npm run worker` | BullMQ consumers and crons |
| Redis | `redis-server` or Compose | Required by the worker |

Queues: `invoice-pipeline`, `agent-tasks`, `webhooks`, `xero-sync`, `accounting-sync`, `mailbox-poll`, `sftp-poll`, `payment-schedule`, `collections-dunning`, `retention-purge`.

Scheduled work includes autopay, collections reminders, mailbox and SFTP polls, Odoo bill/vendor sync, and retention deletion of expired documents.

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
E2E=1 npm run test:e2e
```

`npm test` covers policy, currency, tenant isolation, collections cadence, and the CLI client. End-to-end tests need `E2E=1` and a database. The Arc Circle test skips when Circle credentials are absent. Set `E2E_ARC=0` to skip that suite on purpose. The checklist is [QA runbook](qa-runbook.md).

## CLI package

```bash
npm run build --prefix cli
```

Output is `cli/dist` and is not committed. Install with `npm i -g ./cli` from the repository root.

## Hosting on Vercel and Render

Custara runs as **two hosts**. Same Git repo, different env and databases. Do not flip `ARC_CHAIN=ARC` on the database that already has test invoices.

| | `testnet.custara.xyz` | `custara.xyz` |
|--|-----------------------|---------------|
| Database | Current Render Postgres (moved in place) | New Postgres, `db push`, no seed |
| Worker | Current worker (`render.yaml`) | New worker |
| Circle | Existing **testnet** keys / agent | **Mainnet** Circle app, new agent, new webhook secret |
| `ARC_CHAIN` | `ARC-TESTNET` | `ARC` |
| `ARC_ALLOW_LIVE_ON_TESTNET` | `true` | unset |
| `ARC_USDC_TOKEN_ADDRESS` | testnet default | **required** Circle mainnet USDC |
| `ARC_PAYMENTS_LIVE` | `true` | `true` only after the fee wallet and agent are funded |
| `ALLOW_JIT_ORG_CREATION` | as today | `true` only until the first real workspace |
| `ENCRYPTION_KEY` | keep the key that decrypts the moved rows | **new** secrets |
| `APP_URL` | `https://testnet.custara.xyz` | `https://custara.xyz` |
| Circle webhook | `https://testnet.custara.xyz/api/webhooks/circle` | `https://custara.xyz/api/webhooks/circle` |

Postgres, Redis, and the worker run on Render.

- [`render.yaml`](../render.yaml) is **testnet only** (`custara-worker` / `custara-postgres`, `APP_URL=https://testnet.custara.xyz`, `ARC_CHAIN=ARC-TESTNET`).
- [`render.mainnet.yaml`](../render.mainnet.yaml) is the **empty apex** stack (`custara-mainnet-worker` / `custara-mainnet-postgres`, `ARC_CHAIN=ARC`, `ARC_PAYMENTS_LIVE=false`). Env template: [`.env.mainnet.example`](../.env.mainnet.example).

Do not apply `render.mainnet.yaml` on top of the existing testnet blueprint. That would reuse names or, worse, tempt you to point apex at the old database.

### Enterprise mainnet cutover

Testnet stays where it is. Apex is a new empty stack.

1. **Freeze testnet.** Existing Vercel project keeps `testnet.custara.xyz`, current `DATABASE_URL`, current `ENCRYPTION_KEY`, `ARC_CHAIN=ARC-TESTNET`. Circle testnet webhook stays `https://testnet.custara.xyz/api/webhooks/circle`.
2. **New Render Blueprint** from [`render.mainnet.yaml`](../render.mainnet.yaml). Fill new `SESSION_SECRET`, `ENCRYPTION_KEY` (not the testnet key), Circle **mainnet** keys, `PLATFORM_FEE_ADDRESS`, `ARC_USDC_TOKEN_ADDRESS`, R2. Do not seed.
3. **New Vercel project** from the same Git repo. Copy [`.env.mainnet.example`](../.env.mainnet.example). Use the **external** URL of `custara-mainnet-postgres` and the `rediss://` URL of `custara-mainnet-redis`. `ARC_PAYMENTS_LIVE=false`. `REDIRECT_APEX_TO_TESTNET` unset.
4. **Move apex domains.** Remove `custara.xyz` and `www.custara.xyz` from the testnet Vercel project. Add them on the mainnet project. Wait for the certificate. Spaceship `@` / `www` records stay Vercel; only the owning project changes.
5. **Circle mainnet app** (not the testnet one). Webhook `https://custara.xyz/api/webhooks/circle`.
6. **First workspace.** `GET https://custara.xyz/api/health` — `ok: true`, `gates.arc_chain` is `ARC`, `arc_payments_live` is false. Sign in; JIT creates an empty org (autopay off). Invite the team. Set `ALLOW_JIT_ORG_CREATION=false` on apex Vercel + worker and redeploy.
7. Connect **production** Odoo with API URL `https://custara.xyz`. Allowlist real vendor `0x`. Enable MFA for pay roles. Leave autopay off.
8. **Enable pay** only after the mainnet agent holds real USDC and `PLATFORM_FEE_ADDRESS` is a funded mainnet treasury: set `ARC_PAYMENTS_LIVE=true` on apex Vercel + worker, redeploy, then one small real pay.

Odoo Apps listing: free LGPL-3 module in [Samped/custara-odoo](https://github.com/Samped/custara-odoo) branch `18.0`. Register `ssh://git@github.com/Samped/custara-odoo#18.0` on [apps.odoo.com/apps/upload](https://apps.odoo.com/apps/upload) after authorizing GitHub user `online-odoo`. Customer API URL `https://custara.xyz`; demos `https://testnet.custara.xyz`. See [Odoo app](odoo-app.md).

Free Render Postgres is 1 GB, has no backups, and expires 30 days after creation. After a 14-day grace period Render deletes it. Free Key Value is 25 MB and does not keep data across restarts. The worker is a free web service, because background workers are not on the free plan. It sleeps after 15 minutes without HTTP traffic. Autopay, webhook delivery, and polls resume when the next request wakes it. A ping every 10 minutes to the worker `/health` URL keeps it awake.

Vercel and the worker do not share a disk. Set `STORAGE_BACKEND=s3` and point `S3_ENDPOINT` at a Cloudflare R2 bucket (or another S3-compatible store). Invoice files fail in production without that.

### Render

Create a Blueprint from this repository. For testnet, use root `render.yaml`. For mainnet, use `render.mainnet.yaml` as a **second** Render project. The worker build installs dev dependencies because `tsx` and the Prisma CLI live there. The free plan does not allow a pre-deploy command, so the start command runs `npx prisma db push` and then the worker. Do not seed.

Copy the **external** Postgres URL and the Key Value URL for the matching Vercel project. The worker receives the internal URLs from the blueprint. Fill the prompted secrets on each worker: `SESSION_SECRET`, `ENCRYPTION_KEY`, Circle keys, `PLATFORM_FEE_ADDRESS`, and the R2 keys. Testnet `APP_URL` is `https://testnet.custara.xyz`. Mainnet `APP_URL` is `https://custara.xyz`.

### Vercel

Import the GitHub repository. Framework is Next.js. Node.js is 22. Set the same `DATABASE_URL` (external), `REDIS_URL` (`rediss://`), `SESSION_SECRET`, `ENCRYPTION_KEY`, `OPENAI_API_KEY`, Circle keys, `ARC_PAYMENTS_LIVE`, `ARC_ALLOW_SIMULATED=false`, `ARC_CHAIN`, `APP_URL`, `NEXT_PUBLIC_APP_URL`, `PLATFORM_FEE_*`, and the R2 variables. `OPENAI_API_KEY` is required for invoice extraction on both Vercel and the worker.

The **existing** Vercel project stays on the testnet database and `testnet.custara.xyz`. Apex is a **new** Vercel project pointed at `custara-mainnet-postgres`. Never paste the testnet `DATABASE_URL` into the apex project.

Set `ALLOW_JIT_ORG_CREATION=true` only until the first workspace exists, then remove it and redeploy. Production does not create a workspace for an unknown email when that variable is unset.

### DNS

At the registrar for `custara.xyz`:

| Record | Name | Value |
|--------|------|--------|
| A | `@` | `76.76.21.21` |
| CNAME | `www` | `cname.vercel-dns.com` |
| CNAME | `testnet` | `cname.vercel-dns.com` |

`testnet.custara.xyz` stays on the testnet Vercel project (Spaceship CNAME `testnet` → the value Vercel shows). After the mainnet Vercel project exists, move `custara.xyz` and `www.custara.xyz` to that project.

### After the first deploy

- `GET https://testnet.custara.xyz/api/health` returns `ok: true` when Postgres and Redis answer. After cutover, the same check on `https://custara.xyz` hits the **mainnet** database.
- Circle webhooks go to `{APP_URL}/api/webhooks/circle` for that stack.
- `CIRCLE_WEBHOOK_SECRET` is set on Vercel. Production rejects unsigned Circle webhooks.
- PAJ African bank rails: set `PAJ_API_KEY` and `PAJ_WEBHOOK_SECRET` on the Vercel app (not the worker). Ramp webhook `{APP_URL}/api/webhooks/paj`.
- The worker log shows `worker health listening`.
- Health `gates.app_url` matches the host you are on.

## Production checklist

- `SESSION_SECRET` and `ENCRYPTION_KEY` are long random values, not the examples
- `ALLOW_JIT_ORG_CREATION` is false
- Redis is reachable and the worker is supervised
- `STORAGE_BACKEND=s3` with a private bucket
- `ARC_ALLOW_SIMULATED=false`
- Circle entity secret and webhook secret are set before live USDC volume
- `NIGERIA_PAYMENT_LIVE` stays false until the older Nigeria file-export partner is contracted
- Live African Fund/Withdraw: `PAJ_API_KEY` and `PAJ_WEBHOOK_SECRET` on Vercel; webhook `{APP_URL}/api/webhooks/paj`
- OIDC is configured if the organization enforces SSO
- MFA threshold is set to the organization's policy, not left at the default by accident
- `GET /api/health` returns `ok: true`
- Apex: `gates.arc_chain` is `ARC` and `arc_payments_live` is false until the agent and `PLATFORM_FEE_ADDRESS` are funded
- After the first apex workspace, `ALLOW_JIT_ORG_CREATION` is false
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

Custara is MIT licensed. See [LICENSE](../LICENSE).
