import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import path from "path";
import { apiJson, getSeedOrg, readDemoApiKey, requireE2E, prisma } from "./helpers";

describe("e2e ingest API", () => {
  let key = "";
  let orgId = "";

  before(async () => {
    requireE2E();
    key = readDemoApiKey();
    orgId = (await getSeedOrg()).id;
  });

  it("health reports database up", async () => {
    const res = await apiJson("GET", "/api/health");
    assert.ok(res.status === 200 || res.status === 503, `status ${res.status}`);
    const body = res.json as { checks?: { database?: { ok?: boolean } } };
    assert.equal(body.checks?.database?.ok, true);
  });

  it("sync JSON ingest + analysis", async () => {
    const stamp = Date.now();
    const externalId = `e2e_sync_${stamp}`;
    const invoiceNumber = `E2E-${stamp}`;
    const res = await apiJson("POST", "/api/v1/invoices", {
      key,
      headers: { "Idempotency-Key": externalId },
      body: {
        external_id: externalId,
        sync: true,
        document: {
          vendor_name: "Northern Haulage Ltd",
          invoice_number: invoiceNumber,
          total_amount: 15000 + (stamp % 9000),
          currency: "NGN",
          due_date: "2027-01-15",
          account_name: "Northern Haulage Ltd",
          account_number: "0123456789",
          bank_name: "GTBank",
          confidence: 0.95,
        },
      },
    });
    assert.ok(res.status === 200 || res.status === 201, res.text);
    const id = (res.json as { id?: string }).id;
    assert.ok(id, res.text);
    const analysis = await apiJson("GET", `/api/v1/invoices/${id}/analysis`, { key });
    assert.equal(analysis.status, 200, analysis.text);
    const inv = await prisma.invoice.findFirst({ where: { id, organizationId: orgId } });
    assert.ok(inv);
    assert.ok(
      ["approved", "pending_approval", "needs_review"].includes(inv!.status),
      `status=${inv!.status}`,
    );
  });

  it("bulk CSV ingest", async () => {
    const csv = readFileSync(path.join(process.cwd(), "fixtures/csv/bulk-ap.csv"), "utf8");
    const stamp = Date.now();
    const unique = csv
      .split("\n")
      .map((line, i) => {
        if (i === 0 || !line.trim()) return line;
        const parts = line.split(",");
        parts[parts.length - 1] = `e2e_csv_${stamp}_${i}`;
        parts[1] = `E2E-CSV-${stamp}-${i}`;
        return parts.join(",");
      })
      .join("\n");
    const res = await apiJson("POST", "/api/v1/invoices/bulk", {
      key,
      headers: { "Idempotency-Key": `bulk-${stamp}` },
      body: { sync: true, csv: unique },
    });
    assert.ok(res.status === 200 || res.status === 201, res.text);
  });

  it("low confidence JSON holds", async () => {
    const stamp = Date.now();
    const res = await apiJson("POST", "/api/v1/invoices", {
      key,
      headers: { "Idempotency-Key": `low-${stamp}` },
      body: {
        external_id: `e2e_low_${stamp}`,
        sync: true,
        document: {
          vendor_name: `LowConf Vendor ${stamp}`,
          invoice_number: `E2E-LOW-${stamp}`,
          total_amount: 9000 + (stamp % 100),
          currency: "NGN",
          due_date: "2026-10-01",
          confidence: 0.4,
          account_name: `LowConf Vendor ${stamp}`,
          account_number: "0123456789",
          bank_name: "Access Bank",
        },
      },
    });
    assert.ok(res.status === 200 || res.status === 201, res.text);
    const id = (res.json as { id: string }).id;
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id } });
    assert.equal(inv.status, "needs_review", `got ${inv.status}`);
  });
});
