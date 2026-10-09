# Webhooks

Custara pushes workspace events to HTTPS endpoints you register. Registration is on **Developers**, `POST /api/v1/webhooks`, or `custara webhooks create`. The scope is `connectors:write`.

Create returns a signing secret once (`whsec_…`). It is stored encrypted. Disable an endpoint with `DELETE /api/v1/webhooks/{id}` or `custara webhooks disable`. Disabling sets `is_active` to false. It does not delete delivery history.

## Events the server emits

| Event | When |
|-------|------|
| `invoice.ingested` | A bill is stored |
| `invoice.received` | Same ingest, second notification |
| `invoice.analyzed` | Pipeline finished |
| `invoice.anomaly_detected` | Pipeline recorded an anomaly |
| `approval.needed` | An approval request is pending |
| `approval.decided` | An approver approved or rejected |
| `payment.intent_created` | A payment intent was created |
| `payment.executed` | Nigeria export adapter finished |
| `payment.failed` | Transfer or adapter failed |
| `invoice.reconciled` | A settlement was recorded |
| `receivable.reminder` | Collections sent a reminder |
| `*` | Every event above |

The subscription picker also lists `approval.requested`, `payment.created`, and `payment.sent`. Those three names are not delivered. For Arc settlement, subscribe to `payment.intent_created` and `invoice.reconciled`, or use `*`.

The payload is JSON:

```json
{ "event": "payment.intent_created", "created_at": "2026-10-08T18:00:00.000Z", "data": {} }
```

Delivery sets `X-Custara-Event` to the event name and `X-Custara-Signature` to hex HMAC-SHA256 of the raw body using the endpoint secret.

## Delivery

The worker queue `webhooks` delivers `deliver_webhook` jobs. Without Redis and `npm run worker`, deliveries stay pending in Postgres.

Each delivery is retried with backoff, up to eight attempts, then dead-lettered. Deliveries are visible from the developer tools and the `WebhookDelivery` records.

Verify the signature with the endpoint secret before you trust the body. Treat retries as at-least-once: key your handler on the event id and the payment or invoice id inside the payload.

## Circle

Circle transfer notifications arrive at `POST /api/webhooks/circle` and are checked with `CIRCLE_WEBHOOK_SECRET`. That route is for Circle, not for your ERP. Your ERP subscribes to the Custara events above.

Paystack and Mono have their own inbound routes for bank reconciliation. They are configured with `PAYSTACK_*` and `MONO_*` and are not a substitute for Custara outbound webhooks.
