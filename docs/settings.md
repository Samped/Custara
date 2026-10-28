# Settings

Settings is `/app/settings`. Open it from **Go to → Admin → Settings**. Only an admin can open it.

## Platform

Shortcuts to the rest of administration:

| Link | Opens |
|------|--------|
| Connectors | Mailbox, Odoo, file drop, and other ingest channels |
| API | Keys, webhooks, and the quickstart on `/app/developers` |
| Roles | Team and sign-in MFA by role |
| Controls | Policy versions and the audit list |
| Vendor portal | Upload invites |
| Security | Authenticator and the payment MFA threshold |

## Organization

**Save settings** writes the company profile.

| Field | Effect |
|-------|--------|
| Legal name, website, social profile | Shown on the workspace profile |
| Business location | Suggests the dashboard currency. Nigeria, Ghana, Tanzania, Kenya, and South Africa also unlock PAJ Fund/Withdraw on Home. |
| Dashboard currency | Currency used on Home and Cash |
| Expected inflow 7d / 30d | The inflow side of the Cash outlook |
| Privacy delete days | How long uploaded document bytes are kept |
| Privacy mode | Limits what is retained on ingested documents |
| Payment mode | **Simulated** moves no USDC. **Live Arc** settles USDC through Circle on this host’s chain (testnet or mainnet). API payments follow this mode. |
| Target days payable | Blank pays on the due date, or earlier when a discount is covered. A number is the issue date plus that many days, never later than the due date. |
| Auto-pay | On by default. Pays approved invoices for vendors that are no longer new, on the recommended date. Uncheck to pause. |
| Enforce SSO | Requires single sign-on when it is configured for the workspace |

Under the form, **Audit chain** says `ok` with an event count, or `BROKEN` when the hash chain has a gap.

## MFA

The same authenticator enrollment as [Security](app-security.md), with a link back to that screen.
