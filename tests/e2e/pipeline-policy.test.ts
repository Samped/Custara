import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { getSeedOrg, getUserByEmail, requireE2E, prisma } from "./helpers";
import { decideApproval } from "@/domain/pipeline";

describe("e2e pipeline / policy (seed)", () => {
  let orgId = "";

  before(async () => {
    requireE2E();
    orgId = (await getSeedOrg()).id;
  });

  it("seed invoices have expected statuses", async () => {
    const byExt = async (externalId: string) =>
      prisma.invoice.findFirst({ where: { organizationId: orgId, externalId } });

    const small = await byExt("inv_small_001");
    const dual = await byExt("inv_dual_002");
    const dup = await byExt("inv_dup_005");
    const arc = await byExt("inv_arc_usdc_006");

    assert.ok(small, "inv_small_001");
    assert.ok(dual, "inv_dual_002");
    assert.ok(dup, "inv_dup_005");
    assert.ok(arc, "inv_arc_usdc_006");

    assert.ok(
      ["approved", "payment_queued", "payment_sent", "reconciled", "payment_failed"].includes(
        small!.status,
      ),
      `small=${small!.status}`,
    );
    assert.ok(["pending_approval", "approved", "payment_sent", "reconciled"].includes(dual!.status), `dual=${dual!.status}`);
    assert.equal(dup!.status, "duplicate_suspected");
    assert.ok(
      ["needs_review", "pending_approval", "approved", "payment_queued", "payment_sent"].includes(
        arc!.status,
      ),
      `arc=${arc!.status}`,
    );
  });

  it("dual approval maker-checker", async () => {
    const dual = await prisma.invoice.findFirst({
      where: { organizationId: orgId, externalId: "inv_dual_002" },
      include: { approvalRequests: { where: { status: "pending" }, orderBy: { createdAt: "desc" } } },
    });
    if (!dual || dual.status === "approved" || !dual.approvalRequests[0]) {
      return; // already fully approved in a prior run
    }
    const approval = dual.approvalRequests[0];
    const a1 = await getUserByEmail("approver@custara.demo");
    const a2 = await getUserByEmail("approver2@custara.demo");
    await decideApproval({
      approvalId: approval.id,
      organizationId: orgId,
      userId: a1.id,
      decision: "approved",
      note: "e2e a1",
    });
    let err: Error | null = null;
    try {
      await decideApproval({
        approvalId: approval.id,
        organizationId: orgId,
        userId: a1.id,
        decision: "approved",
        note: "same user",
      });
    } catch (e) {
      err = e instanceof Error ? e : new Error(String(e));
    }
    assert.ok(err, "same approver must be rejected");
    await decideApproval({
      approvalId: approval.id,
      organizationId: orgId,
      userId: a2.id,
      decision: "approved",
      note: "e2e a2",
    });
    const refreshed = await prisma.invoice.findUniqueOrThrow({ where: { id: dual.id } });
    assert.equal(refreshed.status, "approved");
  });
});
