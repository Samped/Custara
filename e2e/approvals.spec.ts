import { test, expect } from "@playwright/test";
import { loginAsOnPage, prisma } from "./helpers";

test.describe("approvals", () => {
  test("approver can open approvals deck", async ({ page }) => {
    await loginAsOnPage(page, "approver@custara.demo");
    await page.goto("/app/approvals");
    await expect(page.locator("body")).toContainText(/approvals|human|pending|maker/i, {
      timeout: 15_000,
    });

    const pending = await prisma.approvalRequest.findFirst({
      where: { status: "pending" },
    });
    if (!pending) return;

    const approveBtn = page.getByRole("button", { name: /approve/i }).first();
    if (await approveBtn.isVisible().catch(() => false)) {
      await approveBtn.click();
      await page.waitForTimeout(1000);
    }
  });
});
