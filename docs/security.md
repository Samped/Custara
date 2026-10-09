# Security

## Sessions

People sign in with an email one-time code (Circle, or Custara mail when Circle user auth is not configured). Enterprise SSO is OpenID Connect. Set `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, and optionally `OIDC_ALLOWED_EMAIL_DOMAINS`. An organization can require SSO (`ssoEnforced`). SSO users must already be invited. SCIM and SAML are not implemented.

Sessions last 14 days. The cookie is `HttpOnly`. The CLI stores a bearer copy of the same session token in `~/.custara/config.json` after `custara login --email`.

Production does not create a workspace for an unknown email unless `ALLOW_JIT_ORG_CREATION=true`.

## MFA

MFA is an authenticator (TOTP) on the user, not a requirement to sign in.

- Enroll from **Security** or `custara mfa enroll`, then confirm with a code from the app.
- If MFA is already on, sign-in still asks for a code in the browser.
- Paying is gated by amount. The organization field **Require MFA at or above (USD)** defaults to 5,000. Amounts in other currencies are converted to USD before the comparison.
- Below the threshold, a person can initiate payment with no code and without enrollment.
- At or above the threshold, enrollment is required and the pay form requires a current code.
- Autopay and other system jobs are exempt.
- A missing amount on a user-initiated pay is treated as at the threshold.

API keys do not enroll MFA. In live mode, if `API_PAY_STEPUP_SECRET` is set, `POST /api/v1/payment-intents` must send that value in `X-Custara-Step-Up`. The CLI flag is `--step-up`, or the `CUSTARA_STEP_UP` environment variable.

## API keys

Keys are created on **Developers**. The secret is shown once and stored as a hash. The prefix is `cst_live_`. A key is scoped:

| Scope | Allows |
|-------|--------|
| `invoices:read` | List and read invoices and analysis |
| `invoices:write` | Ingest, bulk CSV, create vendors |
| `approvals:write` | Decide an approval |
| `payments:initiate` | Create a payment intent, provision or sync wallets |
| `cash:read` | Cash forecast and wallet list |
| `audit:read` | Audit export and chain verify |
| `connectors:write` | Create and disable webhooks |

Keys are organization-wide. Settlement follows the workspace payment mode: live mode moves USDC on Arc.

Revoke a key from Developers. Revocation is immediate.

## Destination controls

An Arc payment requires the vendor address on the organization allowlist. Adding an address can call an external screener when `SCREENING_PROVIDER=http` and `SCREENING_API_URL` are set.

Pay-time screening uses `ADDRESS_SCREEN_URL` when set. A deny, or a non-success response, blocks pay with `address_screen_failed`. If the screener cannot be reached, live mode blocks the payment. Simulated mode allows it.

Spend is also capped by the organization daily USD limit checked at pay time.

## Data protection

- Bank account numbers and webhook signing secrets are encrypted with AES-256-GCM using `ENCRYPTION_KEY`.
- Audit events are hash-chained. See [Audit](audit.md).
- Documents sit on local disk or S3 (`STORAGE_BACKEND`).
- Platform-wide network metrics on the public home page are limited to emails in `PLATFORM_ADMIN_EMAILS`.

## Certification

[SOC 2 readiness](soc2-roadmap.md) is the control map. Custara has no SOC 2 Type I or Type II report, no third-party penetration test on file, no SCIM, and no multi-region failover. Rotate `SESSION_SECRET`, `ENCRYPTION_KEY`, Circle keys, and webhook secrets, and restrict who can create API keys.
