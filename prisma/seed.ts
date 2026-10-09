import { PrismaClient } from "@prisma/client";
import { createHash, randomBytes } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { encryptField, last4 } from "../src/lib/crypto";
import { publishPolicyVersion } from "../src/domain/policy";
import { ensureAccountingConnector, ensurePaymentConnector } from "../src/domain/connectors";

const prisma = new PrismaClient();

function hashApiKey(raw: string) {
  return createHash("sha256").update(raw).digest("hex");
}

async function main() {
  await prisma.webhookDelivery.deleteMany();
  await prisma.webhookEndpoint.deleteMany();
  await prisma.apiKey.deleteMany();
  await prisma.auditEvent.deleteMany();
  await prisma.agentTask.deleteMany();
  await prisma.settlement.deleteMany();
  await prisma.paymentIntent.deleteMany();
  await prisma.approvalDecision.deleteMany();
  await prisma.approvalRequest.deleteMany();
  await prisma.approvalPolicyVersion.deleteMany();
  await prisma.approvalPolicy.deleteMany();
  await prisma.riskAssessment.deleteMany();
  await prisma.extractionResult.deleteMany();
  await prisma.invoiceDocument.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.vendorPaymentEndpoint.deleteMany();
  await prisma.vendor.deleteMany();
  await prisma.destinationAllowlist.deleteMany();
  await prisma.walletLinkChallenge.deleteMany();
  await prisma.orgWallet.deleteMany();
  await prisma.session.deleteMany();
  await prisma.loginChallenge.deleteMany();
  await prisma.workspaceUser.deleteMany();
  await prisma.integrationConnector.deleteMany();
  await prisma.idempotencyRecord.deleteMany();
  await prisma.backgroundJob.deleteMany();
  await prisma.apiRateLimit.deleteMany();
  await prisma.organization.deleteMany();

      const org = await prisma.organization.create({
    data: {
      name: "Lagos Distribution Co",
      slug: "lagos-distribution",
      legalName: "Lagos Distribution Company Ltd",
      businessType: "company",
      industry: "Wholesale & distribution",
      country: "NG",
      displayCurrency: "NGN",
      ingestEmail: "invoices+lagos-distribution@ingest.custara.local",
      onboardingCompletedAt: new Date(),
      privacyMode: true,
      privacyDeleteDays: 30,
      expectedInflow7d: 2_500_000,
      expectedInflow30d: 9_000_000,
      paymentMode: "sandbox",
      ssoEnforced: false,
      mfaRequiredForRoles: "[]",
    },
  });

  await Promise.all([
    prisma.workspaceUser.create({
      data: {
        organizationId: org.id,
        email: "admin@custara.demo",
        name: "Ada Admin",
        role: "admin",
      },
    }),
    prisma.workspaceUser.create({
      data: {
        organizationId: org.id,
        email: "approver@custara.demo",
        name: "Femi Approver",
        role: "approver",
      },
    }),
    prisma.workspaceUser.create({
      data: {
        organizationId: org.id,
        email: "approver2@custara.demo",
        name: "Chioma Approver",
        role: "approver",
      },
    }),
    prisma.workspaceUser.create({
      data: {
        organizationId: org.id,
        email: "payer@custara.demo",
        name: "Ngozi Payer",
        role: "payer",
      },
    }),
    prisma.workspaceUser.create({
      data: {
        organizationId: org.id,
        email: "auditor@custara.demo",
        name: "Ibrahim Auditor",
        role: "auditor",
      },
    }),
  ]);

  await publishPolicyVersion({
    organizationId: org.id,
    name: "Corporate AP Policy",
    changelog: "Initial production policy v1",
    createdBy: "seed",
    rules: {
      autoApproveMax: 50000,
      singleApproverMax: 500000,
      dualControlAbove: 500000,
      currency: "NGN",
      holdOnNewVendor: true,
      holdOnBankChange: true,
      holdOnDuplicate: true,
    },
  });

  await prisma.vendor.create({
    data: {
      organizationId: org.id,
      externalId: "sup_91",
      name: "Northern Haulage Ltd",
      email: "billing@northernhaulage.ng",
      isNew: false,
      endpoints: {
        create: {
          endpointType: "bank",
          accountName: "Northern Haulage Ltd",
          accountNumberEncrypted: encryptField("0123456789"),
          accountNumberLast4: last4("0123456789"),
          bankName: "GTBank",
          bankCode: "058",
          currency: "NGN",
          version: 1,
          isActive: true,
        },
      },
    },
  });

  await prisma.vendor.create({
    data: {
      organizationId: org.id,
      externalId: "sup_arc_01",
      name: "Arc Softgoods Inc",
      email: "ap@arcsoftgoods.demo",
      isNew: false,
      endpoints: {
        create: {
          endpointType: "arc_usdc",
          accountName: "Arc Softgoods Inc",
          arcAddress: "0x1111111111111111111111111111111111111111",
          currency: "USDC",
          version: 1,
          isActive: true,
        },
      },
    },
  });

  const { ensureAgentWallet } = await import("../src/domain/arc/wallets");
  await ensureAgentWallet({ organizationId: org.id, actorType: "system" });
  const rawKey = `cst_live_${randomBytes(24).toString("hex")}`;
  await prisma.apiKey.create({
    data: {
      organizationId: org.id,
      name: "Production-shaped sandbox key",
      keyPrefix: rawKey.slice(0, 16),
      keyHash: hashApiKey(rawKey),
      scopesJson: JSON.stringify([
        "invoices:read",
        "invoices:write",
        "approvals:write",
        "payments:initiate",
        "cash:read",
        "audit:read",
        "connectors:write",
      ]),
    },
  });

  await prisma.webhookEndpoint.create({
    data: {
      organizationId: org.id,
      url: "https://example.com/webhooks/custara",
      secret: "whsec_demo_secret",
      eventsJson: JSON.stringify(["*"]),
      isActive: false,
    },
  });

  await ensureAccountingConnector(org.id);
  await ensurePaymentConnector(org.id);

  await mkdir(path.join(process.cwd(), "storage", org.id), { recursive: true });

  const { ingestInvoice } = await import("../src/domain/ingest");
  const { runInvoicePipeline } = await import("../src/domain/pipeline");

  const samples = [
    {
      externalId: "inv_small_001",
      payload: {
        vendor_name: "Northern Haulage Ltd",
        invoice_number: "NH-1001",
        issue_date: "2026-09-20",
        due_date: "2026-10-05",
        currency: "NGN",
        total_amount: 42000,
        po_number: "PO-2201",
        account_name: "Northern Haulage Ltd",
        account_number: "0123456789",
        bank_name: "GTBank",
        bank_code: "058",
        confidence: 0.96,
      },
    },
    {
      externalId: "inv_dual_002",
      payload: {
        vendor_name: "Northern Haulage Ltd",
        invoice_number: "NH-2050",
        issue_date: "2026-09-22",
        due_date: "2026-10-08",
        currency: "NGN",
        total_amount: 780000,
        po_number: "PO-2208",
        account_name: "Northern Haulage Ltd",
        account_number: "0123456789",
        bank_name: "GTBank",
        bank_code: "058",
        confidence: 0.94,
      },
    },
    {
      externalId: "inv_bankchange_003",
      payload: {
        vendor_name: "Northern Haulage Ltd",
        invoice_number: "NH-2099",
        issue_date: "2026-09-25",
        due_date: "2026-10-10",
        currency: "NGN",
        total_amount: 210000,
        po_number: "PO-2210",
        account_name: "Northern Haulage Ltd",
        account_number: "9988776655",
        bank_name: "Access Bank",
        bank_code: "044",
        confidence: 0.91,
      },
    },
    {
      externalId: "inv_newvendor_004",
      payload: {
        vendor_name: "Kano Packaging Supplies",
        invoice_number: "KP-501",
        issue_date: "2026-09-26",
        due_date: "2026-10-12",
        currency: "NGN",
        total_amount: 185000,
        po_number: "PO-2211",
        account_name: "Kano Packaging Supplies",
        account_number: "1231231230",
        bank_name: "Zenith Bank",
        bank_code: "057",
        confidence: 0.9,
      },
    },
    {
      externalId: "inv_dup_005",
      payload: {
        vendor_name: "Northern Haulage Ltd",
        invoice_number: "NH-1001",
        issue_date: "2026-09-27",
        due_date: "2026-10-15",
        currency: "NGN",
        total_amount: 42000,
        po_number: "PO-2201",
        account_name: "Northern Haulage Ltd",
        account_number: "0123456789",
        bank_name: "GTBank",
        bank_code: "058",
        confidence: 0.93,
      },
    },
    {
      externalId: "inv_arc_usdc_006",
      payload: {
        vendor_name: "Arc Softgoods Inc",
        invoice_number: "ARC-9001",
        issue_date: "2026-09-28",
        due_date: "2026-10-20",
        currency: "USDC",
        total_amount: 1250,
        po_number: "PO-3301",
        arc_address: "0x1111111111111111111111111111111111111111",
        confidence: 0.97,
      },
    },
  ];

  for (const sample of samples) {
    const invoice = await ingestInvoice({
      organizationId: org.id,
      actorType: "system",
      source: "api",
      externalId: sample.externalId,
      currency: String((sample.payload as { currency?: string }).currency || "NGN"),
      structuredPayload: sample.payload,
      filename: `${sample.externalId}.json`,
      enqueue: false,
    });
    await runInvoicePipeline(invoice.id, { type: "system" });
  }

  await writeFile(
    path.join(process.cwd(), "storage", "DEMO_CREDENTIALS.txt"),
    [
      "Custara enterprise sandbox credentials",
      "",
      "Login: https://custara.xyz/login (email OTP — no password)",
      "  admin@custara.demo",
      "  approver@custara.demo",
      "  approver2@custara.demo  (dual control second signer)",
      "  payer@custara.demo",
      "  auditor@custara.demo",
      "",
      "Sandbox OTP: with Circle unset, the 6-digit code is printed in the Next.js server console.",
      "Circle OTP: set CIRCLE_API_KEY + CIRCLE_APP_ID / NEXT_PUBLIC_CIRCLE_APP_ID (SMTP in Circle Console).",
      "",
      `API key: ${rawKey}`,
      "Header: Authorization: Bearer <API key>",
      "Idempotency: Idempotency-Key header on payment intents",
    ].join("\n"),
    "utf8",
  );

  console.log("Seeded Custara enterprise sandbox.");
  console.log("Login: email OTP to admin@custara.demo (no password)");
  console.log(`API key: ${rawKey}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
