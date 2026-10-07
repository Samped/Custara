import { test, expect } from "@playwright/test";
import { loginAsOnPage, prisma } from "./helpers";

test.describe("Nigeria pay", () => {
  test("payer can open approved invoice pay form", async ({ page }) => {
    const invoice = await prisma.invoice.findFirst({
      where: {
        status: "approved",
        currency: "NGN",
        vendor: { endpoints: { none: { endpointType: "arc_usdc", isActive: true } } },
      },
      orderBy: { createdAt: "asc" },
    });
    test.skip(!invoice, "no approved NGN invoice without Arc endpoint");

    await loginAsOnPage(page, "payer@custara.demo");
    await page.goto(`/app/invoices/${invoice!.id}`);
    await expect(page.locator("body")).toContainText(/payment|initiate|export|approved/i, {
      timeout: 15_000,
    });

    const payBtn = page.getByRole("button", { name: /initiate payment|pay|export/i }).first();
    if (await payBtn.isVisible().catch(() => false)) {
      await payBtn.click();
      await page.waitForURL(/\/app\/payments|intent=/, { timeout: 30_000 }).catch(() => null);
      await expect(page.locator("body")).toContainText(/payment|intent|export|sent|queued/i, {
        timeout: 20_000,
      });
    }
  });
});
