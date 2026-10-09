# CLI

The `custara` command is an HTTP client. It does not embed the database or Circle. It talks to a running Custara server.

The package lives in `cli/` and is named `custara`. The Next.js app package stays private so the two do not collide on npm.

## Install

From a checkout of Custara:

```bash
npm run build --prefix cli
npm i -g ./cli
```

Publishing the `cli` directory to the npm registry is what makes `npm i -g custara` work on another machine.

Node.js 20 or newer is required.

## Configure

```bash
custara login --api-key "$CUSTARA_API_KEY" --url https://custara.xyz
custara login --email you@company.com
```

The API key is for invoices, approvals, payments, vendors, wallets, cash, audit, and webhooks. The email login is for MFA, organization settings, and team invites, because those belong to a person.

Email login calls `POST /api/v1/cli/login/start`, prompts for the code, then `POST /api/v1/cli/login/finish`. When local mail is not configured, the server log prints the code, and the start response includes `devCode` outside production so the CLI can show it.

Both secrets are stored in `~/.custara/config.json` with file mode `0600`. Environment variables override the file:

| Variable | Overrides |
|----------|-----------|
| `CUSTARA_URL` | Base URL. Default `https://custara.xyz` |
| `CUSTARA_API_KEY` | API key |
| `CUSTARA_TOKEN` | User session token |
| `CUSTARA_STEP_UP` | `X-Custara-Step-Up` on pay |

`custara logout` clears the key and the user token and keeps the base URL. `custara whoami` prints the server identity for whichever credentials are present.

Add `--json` to any command for the raw response body. Failures print the API `error` string and exit non-zero.

## Commands

### Invoices

```bash
custara invoices ingest \
  --vendor "Acme Supplies" \
  --number INV-1 \
  --amount 25 \
  --currency USDC \
  --due 2026-10-20 \
  --arc-address 0xVENDOR \
  --external-id erp-1

custara invoices ingest --file invoice.json
custara invoices list
custara invoices get INVOICE_ID
custara invoices analysis INVOICE_ID
custara invoices bulk --file bills.csv
```

Ingest defaults to `sync: true` and generates an idempotency key. Pass `--idempotency-key` to supply your own. A JSON file may be a full API body (`document`, `external_id`, `sync`) or a document object.

### Approve and pay

```bash
custara approvals decide APPROVAL_ID --decision approved
custara pay INVOICE_ID --rail arc_usdc
```

`--decision` is `approved` or `rejected`. Optional `--note` and `--approver-email`.

`custara pay` generates an idempotency key and sends `X-Custara-Step-Up` when `--step-up` or `CUSTARA_STEP_UP` is set. The default rail is `arc_usdc`.

The approval id is `policy_result.latest_approval.id` from `custara invoices analysis`.

### Treasury, cash, audit, webhooks

```bash
custara vendors create --name "Acme Supplies" --arc-address 0xVENDOR
custara wallets list
custara wallets sync
custara cash
custara audit export
custara audit verify
custara webhooks list
custara webhooks create --url https://example.com/hook --events payment.intent_created,invoice.reconciled
custara webhooks disable WEBHOOK_ID
```

Vendor create allowlists the Arc address. Webhook create prints the signing secret once.

### Account

```bash
custara mfa enroll
custara mfa confirm 123456
custara mfa disable 123456
custara org set --payment-mode live --autopay true --mfa-threshold 5000
custara team invite --email person@company.com --role approver --name "Ada Lovelace"
```

`mfa enroll` prints the Base32 secret and the `otpauth://` URL. Confirm with a code from the authenticator app. Organization and team commands require an admin user session.

`--payment-mode` accepts `live` (USDC on Arc) or `sandbox` (simulated balances). `--autopay` is `true` or `false`. `--mfa-threshold` is the USD amount at or above which a person must pass MFA to pay.
