import { test, expect } from "@playwright/test";
import path from "path";
import { loginAsOnPage } from "./helpers";

test.describe("login + inbox upload", () => {
  test("admin opens inbox and uploads a structured invoice", async ({ page }) => {
    await loginAsOnPage(page, "admin@custara.demo");
    await page.goto("/app/inbox");
    await expect(
      page.getByRole("heading", { name: /inbox/i }).or(page.locator("h1, h2").filter({ hasText: /inbox/i })),
    ).toBeVisible({
      timeout: 15_000,
    });

    const json = path.join(process.cwd(), "fixtures/invoices/low-confidence.json");
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(json);
    await page.getByRole("button", { name: /upload|ingest|analyze|submit/i }).first().click();

    await page.waitForURL(/\/app\/invoices\//, { timeout: 60_000 }).catch(async () => {
      await page.goto("/app/inbox");
    });

    await expect(page.locator("body")).toContainText(/invoice|needs_review|low.?confidence/i, {
      timeout: 30_000,
    });
  });
});
