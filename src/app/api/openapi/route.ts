import { NextResponse } from "next/server";

/** Partner OpenAPI surface — used by /app/developers and integrators. */
export async function GET() {
  const errorSchema = {
    type: "object",
    properties: { error: { type: "string" } },
    required: ["error"],
  };

  return NextResponse.json({
    openapi: "3.0.3",
    info: {
      title: "Custara Partner API",
      version: "1.2.0",
      description:
        "Privacy-first B2B finance agent API. Authenticate with Bearer API keys. Prefer Idempotency-Key on writes. Live payments require X-Custara-Step-Up when API_PAY_STEPUP_SECRET is set. Nigeria rail is export/sandbox unless NIGERIA_PAYMENT_LIVE=true.",
    },
    servers: [{ url: "/", description: "Current host" }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "API key" },
        stepUp: {
          type: "apiKey",
          in: "header",
          name: "X-Custara-Step-Up",
          description: "Required for payments:initiate in live mode",
        },
      },
      schemas: {
        Error: errorSchema,
        Invoice: {
          type: "object",
          properties: {
            id: { type: "string" },
            status: {
              type: "string",
              enum: [
                "received",
                "extracting",
                "needs_review",
                "pending_approval",
                "approved",
                "payment_queued",
                "payment_sent",
                "payment_failed",
                "settled",
                "reconciled",
                "rejected",
                "on_hold",
                "duplicate_suspected",
              ],
            },
            currency: { type: "string" },
            total_amount: { type: "number" },
            invoice_number: { type: "string", nullable: true },
            vendor_name: { type: "string", nullable: true },
          },
        },
        IngestInvoiceRequest: {
          type: "object",
          properties: {
            sync: { type: "boolean", default: false },
            source: { type: "string" },
            filename: { type: "string" },
            mime_type: { type: "string" },
            payload: { type: "object", additionalProperties: true },
            document_base64: { type: "string", description: "Optional PDF/image bytes" },
          },
        },
        PaymentIntentRequest: {
          type: "object",
          required: ["invoice_id"],
          properties: {
            invoice_id: { type: "string" },
            idempotency_key: { type: "string" },
            rail: {
              type: "string",
              enum: ["arc_usdc", "nigeria_sandbox", "nigeria_export"],
              default: "arc_usdc",
            },
          },
        },
        PaymentIntent: {
          type: "object",
          properties: {
            id: { type: "string" },
            status: { type: "string" },
            rail: { type: "string" },
            mode: { type: "string", enum: ["sandbox", "live"] },
            amount: { type: "number" },
            currency: { type: "string" },
            export_path: { type: "string", nullable: true },
            provider_ref: { type: "string", nullable: true },
            circle_tx_id: { type: "string", nullable: true },
            tx_hash: { type: "string", nullable: true },
            request_id: { type: "string" },
          },
        },
        ApprovalDecision: {
          type: "object",
          required: ["decision"],
          properties: {
            decision: { type: "string", enum: ["approved", "rejected"] },
            note: { type: "string" },
          },
        },
        VendorUpsert: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string" },
            external_id: { type: "string" },
            email: { type: "string" },
            arc_address: { type: "string" },
            account_name: { type: "string" },
            account_number: { type: "string" },
            bank_name: { type: "string" },
            bank_code: { type: "string" },
            currency: { type: "string" },
          },
        },
        ReconcileRequest: {
          type: "object",
          required: ["invoice_id", "amount"],
          properties: {
            invoice_id: { type: "string" },
            amount: { type: "number" },
            payment_intent_id: { type: "string" },
            reference: { type: "string" },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }],
    paths: {
      "/api/health": {
        get: {
          summary: "Liveness / config fingerprint",
          security: [],
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean" },
                      redis: { type: "object" },
                      storage: { type: "object" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/v1/invoices": {
        get: {
          summary: "List invoices",
          description: "Cursor pagination via ?limit=&cursor=",
          responses: {
            "200": {
              description: "Invoice page",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      items: { type: "array", items: { $ref: "#/components/schemas/Invoice" } },
                      next_cursor: { type: "string", nullable: true },
                    },
                  },
                },
              },
            },
          },
        },
        post: {
          summary: "Ingest invoice",
          description:
            "Pass sync:true to analyze inline; otherwise enqueue worker. Prefer Idempotency-Key header.",
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/IngestInvoiceRequest" } },
            },
          },
          responses: {
            "201": {
              description: "Created",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/Invoice" } },
              },
            },
            "400": {
              description: "Bad request",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
          },
        },
      },
      "/api/v1/invoices/bulk": {
        post: {
          summary: "Bulk ingest CSV",
          description: "Body { csv, sync } or text/csv. Idempotency-Key supported.",
          responses: { "200": { description: "Bulk result" } },
        },
      },
      "/api/v1/invoices/csv-template": {
        get: { summary: "Download AP CSV template", security: [], responses: { "200": { description: "CSV" } } },
      },
      "/api/v1/einvoice/firs": {
        post: {
          summary: "Ingest FIRS / e-invoice structured payload",
          description: "IRN / UBL-like JSON. Idempotency-Key supported.",
          responses: { "201": { description: "Created" } },
        },
      },
      "/api/v1/erp/ingest": {
        post: {
          summary: "Ingest Odoo / SAP / Dynamics bill",
          description: "Body { system, payload, sync }. Maps ERP shapes into Custara invoices.",
          responses: { "201": { description: "Created" } },
        },
      },
      "/api/ingest/mailbox": {
        post: {
          summary: "Inbound email attachments",
          description:
            "ESP webhook; auth with MAILBOX_INBOUND_SECRET. Attachments become invoices. Optional subject/text used only for audit snippet + body hash — body is not stored as a document.",
          security: [],
          responses: { "200": { description: "Accepted" } },
        },
      },
      "/api/webhooks/whatsapp": {
        get: { summary: "WhatsApp webhook verify", security: [], responses: { "200": { description: "Verify" } } },
        post: { summary: "WhatsApp media/text invoice ingest", security: [], responses: { "200": { description: "OK" } } },
      },
      "/api/webhooks/paystack": {
        post: {
          summary: "Paystack reconcile webhook",
          description: "Use ?org= or PAYSTACK_DEFAULT_ORG_ID",
          security: [],
          responses: { "200": { description: "OK" } },
        },
      },
      "/api/webhooks/mono": {
        post: {
          summary: "Mono open-banking reconcile webhook",
          description: "Use ?org= or MONO_DEFAULT_ORG_ID",
          security: [],
          responses: { "200": { description: "OK" } },
        },
      },
      "/api/webhooks/circle": {
        post: {
          summary: "Circle transfer webhooks",
          description: "Requires CIRCLE_WEBHOOK_SECRET in production (fail closed).",
          security: [],
          responses: { "200": { description: "Handled" }, "401": { description: "Invalid signature" } },
        },
      },
      "/api/vendor-portal/{token}": {
        get: { summary: "Resolve vendor portal invite", security: [], responses: { "200": { description: "Invite" } } },
        post: {
          summary: "Vendor portal file upload",
          description: "multipart/form-data with file field",
          security: [],
          responses: { "201": { description: "Ingested" } },
        },
      },
      "/api/v1/invoices/{id}": {
        get: {
          summary: "Get invoice",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              description: "Invoice",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/Invoice" } },
              },
            },
          },
        },
      },
      "/api/v1/invoices/{id}/analysis": {
        get: {
          summary: "Get extraction + risk analysis",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Analysis" } },
        },
      },
      "/api/v1/vendors": {
        post: {
          summary: "Upsert vendor",
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/VendorUpsert" } },
            },
          },
          responses: { "200": { description: "Vendor" } },
        },
      },
      "/api/v1/approvals/{id}/decide": {
        post: {
          summary: "Approve or reject",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/ApprovalDecision" } },
            },
          },
          responses: { "200": { description: "Decision recorded" } },
        },
      },
      "/api/v1/payment-intents": {
        post: {
          summary: "Create payment intent (arc_usdc or nigeria export)",
          description:
            "Live mode requires X-Custara-Step-Up. Pay-time guards re-check allowlist, confidence, hard risks, and agent balance.",
          security: [{ bearerAuth: [], stepUp: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/PaymentIntentRequest" } },
            },
          },
          responses: {
            "201": {
              description: "Created",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/PaymentIntent" } },
              },
            },
            "400": {
              description: "Blocked by guards / validation",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
          },
        },
      },
      "/api/v1/reconcile": {
        post: {
          summary: "Record settlement / reconcile invoice",
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/ReconcileRequest" } },
            },
          },
          responses: { "200": { description: "Settled" } },
        },
      },
      "/api/v1/wallets": {
        get: { summary: "List org wallets", responses: { "200": { description: "Wallets" } } },
        post: { summary: "provision_agent | sync balances", responses: { "200": { description: "OK" } } },
      },
      "/api/v1/cash/forecast": {
        get: { summary: "Cash obligations vs expected inflows", responses: { "200": { description: "Forecast" } } },
      },
      "/api/v1/audit/export": {
        get: { summary: "SIEM-friendly audit export", responses: { "200": { description: "Events" } } },
      },
      "/api/v1/audit/verify": {
        get: { summary: "Verify hash-chained audit integrity", responses: { "200": { description: "Chain status" } } },
      },
      "/api/openapi": {
        get: { summary: "This document", security: [], responses: { "200": { description: "OpenAPI JSON" } } },
      },
    },
  });
}
