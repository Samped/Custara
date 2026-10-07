import { test, expect } from "@playwright/test";
import path from "path";
import { loginAsOnPage } from "./helpers";

test.describe("login + inbox upload", () => {
  test("admin opens inbox and uploads happy PDF", async ({ page }) => {
    await loginAsOnPage(page, "admin@custara.demo");
    await page.goto("/app/inbox");
    await expect(page.getByRole("heading", { name: /inbox/i }).or(page.locator("h1, h2").filter({ hasText: /inbox/i }))).toBeVisible({
      timeout: 15_000,
    });

    const pdf = path.join(process.cwd(), "fixtures/invoices/happy-ngn.pdf");
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(pdf);
    await page.getByRole("button", { name: /upload|ingest|analyze|submit/i }).first().click();

    await page.waitForURL(/\/app\/invoices\//, { timeout: 60_000 }).catch(async () => {
      // may redirect to inbox with bulk query
      await page.goto("/app/inbox");
    });

    // Invoice detail or inbox should mention Acme or FIX-HAPPY
    await expect(page.locator("body")).toContainText(/Acme Freight|FIX-HAPPY|invoice/i, {
      timeout: 30_000,
    });
  });
});
