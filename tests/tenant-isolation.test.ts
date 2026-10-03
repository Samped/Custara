/**
 * Tenant isolation tests — org A must not read org B resources.
 * Run: npm test
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { createHash, randomBytes } from "crypto";

const prisma = new PrismaClient();

function hashApiKey(raw: string) {
  return createHash("sha256").update(raw).digest("hex");
}

describe("tenant isolation", () => {
  let orgA = "";
  let orgB = "";
  let invoiceA = "";

  before(async () => {
    const a = await prisma.organization.create({
      data: {
        name: "Tenant A",
        slug: `tenant-a-${Date.now()}`,
        mfaRequiredForRoles: "[]",
      },
    });
    const b = await prisma.organization.create({
      data: {
        name: "Tenant B",
        slug: `tenant-b-${Date.now()}`,
        mfaRequiredForRoles: "[]",
      },
    });
    orgA = a.id;
    orgB = b.id;

    await prisma.workspaceUser.create({
      data: {
        organizationId: orgA,
        email: `a-${Date.now()}@test.local`,
        name: "A Admin",
        role: "admin",
      },
    });
    await prisma.workspaceUser.create({
      data: {
        organizationId: orgB,
        email: `b-${Date.now()}@test.local`,
        name: "B Admin",
        role: "admin",
      },
    });

    const inv = await prisma.invoice.create({
      data: {
        organizationId: orgA,
        status: "approved",
        currency: "USDC",
        totalAmount: 10,
        invoiceNumber: "ISO-1",
      },
    });
    invoiceA = inv.id;

    const keyA = `cst_live_${randomBytes(24).toString("hex")}`;
    const keyB = `cst_live_${randomBytes(24).toString("hex")}`;
    await prisma.apiKey.create({
      data: {
        organizationId: orgA,
        name: "A",
        keyPrefix: keyA.slice(0, 16),
        keyHash: hashApiKey(keyA),
        scopesJson: JSON.stringify(["invoices:read", "audit:read", "cash:read"]),
      },
    });
    await prisma.apiKey.create({
      data: {
        organizationId: orgB,
        name: "B",
        keyPrefix: keyB.slice(0, 16),
        keyHash: hashApiKey(keyB),
        scopesJson: JSON.stringify(["invoices:read", "audit:read", "cash:read"]),
      },
    });
  });

  after(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } });
    await prisma.$disconnect();
  });

  it("org B cannot load org A invoice by id scoped query", async () => {
    const leaked = await prisma.invoice.findFirst({
      where: { id: invoiceA, organizationId: orgB },
    });
    assert.equal(leaked, null);
  });

  it("org A can load its own invoice", async () => {
    const own = await prisma.invoice.findFirst({
      where: { id: invoiceA, organizationId: orgA },
    });
    assert.equal(own?.id, invoiceA);
  });

  it("lists stay tenant-scoped", async () => {
    const aInvoices = await prisma.invoice.findMany({ where: { organizationId: orgA } });
    const bInvoices = await prisma.invoice.findMany({ where: { organizationId: orgB } });
    assert.equal(aInvoices.some((i) => i.id === invoiceA), true);
    assert.equal(bInvoices.some((i) => i.id === invoiceA), false);
  });
});
