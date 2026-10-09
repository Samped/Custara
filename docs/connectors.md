# Connectors

Connectors bring bills in or push outcomes to an accounting system. Secrets for mailbox passwords and OAuth tokens are stored encrypted.

## Mailbox

**Connectors** stores IMAP settings: host, user, app password, port, folder, and TLS. The password is optional on a later save when one is already on file. The worker polls connected mailboxes. `POST /api/ingest/mailbox` accepts an inbound webhook when `MAILBOX_INBOUND_SECRET` matches.

The organization ingest address is shown on the connector screen when `MAILBOX_INGEST_DOMAIN` is set.

## SFTP

Set `SFTP_HOST`, `SFTP_PORT`, `SFTP_USER`, `SFTP_PASSWORD`, and `SFTP_REMOTE_PATH`. The worker pulls the remote drop and ingests files from the local drop directory.

## Accounting

OAuth connectors:

| System | Environment |
|--------|-------------|
| Xero | `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `XERO_REDIRECT_URI` |
| QuickBooks Online | `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_REDIRECT_URI` |
| Sage | `SAGE_CLIENT_ID`, `SAGE_CLIENT_SECRET`, `SAGE_REDIRECT_URI` |
| Zoho Books | `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REDIRECT_URI`, `ZOHO_ORGANIZATION_ID` |

Start URLs are `/api/connectors/xero/start` and `/api/connectors/accounting/{provider}/start`. Leave `QBO_DEMO_SYNC`, `SAGE_DEMO_SYNC`, and `ZOHO_DEMO_SYNC` unset in production.

## ERP push

Integrations use the Partner API. `POST /api/v1/erp/ingest` accepts Odoo, SAP, and Dynamics payloads. Field lists are in [ERP adapters](erp-adapters.md). An ERP that already emits Custara's document shape calls `POST /api/v1/invoices`.

## WhatsApp

`WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, and `WHATSAPP_DEFAULT_ORG_ID` enable the Cloud API webhook at `/api/webhooks/whatsapp`. Media and text are ingested into the default organization.

## Vendor portal

A vendor invite is a tokenized link. The vendor uploads a file without a Custara login. The upload lands in the same pipeline as an inbox file.

## Collections

**Collections** sends receivable reminders on a fixed cadence. Reminder timing depends on a customer behavior score:

- Score 80 or higher: first reminder 7 days after due, one reminder maximum
- Score under 40: first reminder the day after due, then every 2 days, stop after 6
- Otherwise: the day the bill is overdue, then every 3 days

The worker job is `collections-dunning`.
