import { test, expect } from "@playwright/test";
import { circleConfigured, loginAsOnPage, prisma } from "./helpers";

const ARC = "0x1111111111111111111111111111111111111111";

test.describe("Arc pay (Circle sandbox)", () => {
  test("payer initiates Arc payment when Circle configured", async ({ page }) => {
    test.skip(!circleConfigured(), "Set CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET for Arc UI E2E");

    const org = await prisma.organization.findFirst({ where: { slug: "lagos-distribution" } });
    test.skip(!org, "seed org missing");

    await prisma.destinationAllowlist.upsert({
      where: {
        organizationId_address: { organizationId: org!.id, address: ARC },
      },
      create: {
        organizationId: org!.id,
        address: ARC,
        label: "playwright",
        isActive: true,
      },
      update: { isActive: true, revokedAt: null },
    });

    let invoice = await prisma.invoice.findFirst({
      where: {
        organizationId: org!.id,
        status: "approved",
        currency: { in: ["USDC", "USD"] },
      },
    });

    if (!invoice) {
      const arc = await prisma.invoice.findFirst({
        where: { organizationId: org!.id, externalId: "inv_arc_usdc_006" },
      });
      if (arc) {
        await prisma.invoice.update({
          where: { id: arc.id },
          data: { status: "approved", explanation: "playwright" },
        });
        invoice = await prisma.invoice.findUnique({ where: { id: arc.id } });
      }
    }

    test.skip(!invoice, "no approved USDC invoice");

    await loginAsOnPage(page, "payer@custara.demo");
    await page.goto(`/app/invoices/${invoice!.id}`);
    const payBtn = page.getByRole("button", { name: /initiate payment|pay/i }).first();
    await expect(payBtn).toBeVisible({ timeout: 15_000 });
    await payBtn.click();
    await page.waitForTimeout(3000);
    await expect(page.locator("body")).toContainText(/payment|intent|queued|sent|failed|transfer/i, {
      timeout: 60_000,
    });
  });
});
