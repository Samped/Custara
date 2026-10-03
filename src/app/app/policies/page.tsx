import { redirect } from "next/navigation";
import { requireSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { AppShell } from "@/components/app/AppShell";
import { formatDate } from "@/lib/format";
import { publishPolicyVersion, simulatePolicy, getActivePolicyVersion } from "@/domain/policy";
import { PAYABLESAI_STRICT_RULES, type PolicyRules } from "@/lib/types";
import { revalidatePath } from "next/cache";

export default async function PoliciesPage() {
  let user;
  try {
    user = await requireSessionUser(["admin", "auditor"], "policies:read");
  } catch {
    redirect("/login");
  }

  const active = await getActivePolicyVersion(user.organizationId);
  const versions = active
    ? await prisma.approvalPolicyVersion.findMany({
        where: { policyId: active.policy.id },
        orderBy: { version: "desc" },
      })
    : [];

  async function publish(formData: FormData) {
    "use server";
    const session = await requireSessionUser(["admin"]);
    const rules: PolicyRules = {
      autoApproveMax: Number(formData.get("autoApproveMax") || 50000),
      autoApproveMaxUsdc: Number(formData.get("autoApproveMaxUsdc") || 5000),
      singleApproverMax: Number(formData.get("singleApproverMax") || 500000),
      dualControlAbove: Number(formData.get("dualControlAbove") || 500000),
      currency: String(formData.get("currency") || "NGN"),
      holdOnNewVendor: formData.get("holdOnNewVendor") === "on",
      holdOnBankChange: formData.get("holdOnBankChange") === "on",
      holdOnDuplicate: formData.get("holdOnDuplicate") === "on",
      requirePoMatch: formData.get("requirePoMatch") === "on",
      holdOnUnknownDestination: formData.get("holdOnUnknownDestination") === "on",
      blockAutoApproveUntilAllowlisted: formData.get("blockAutoApproveUntilAllowlisted") === "on",
      minConfidenceForAutoApprove: Number(formData.get("minConfidenceForAutoApprove") || 0.6),
    };
    await publishPolicyVersion({
      organizationId: session.organizationId,
      policyId: String(formData.get("policyId") || "") || undefined,
      name: String(formData.get("name") || "Corporate AP Policy"),
      rules,
      changelog: String(formData.get("changelog") || "Policy update"),
      createdBy: session.id,
    });
    revalidatePath("/app/policies");
  }

  async function publishStrict() {
    "use server";
    const session = await requireSessionUser(["admin"]);
    await publishPolicyVersion({
      organizationId: session.organizationId,
      policyId: undefined,
      name: "PayablesAI Strict",
      rules: PAYABLESAI_STRICT_RULES,
      changelog: "Enterprise strict preset — PO match, allowlist, low auto-approve",
      createdBy: session.id,
    });
    revalidatePath("/app/policies");
  }

  const sim = active
    ? simulatePolicy({
        amount: 780000,
        isNewVendor: false,
        bankChanged: false,
        duplicate: false,
        rules: active.rules,
      })
    : null;

  return (
    <AppShell
      user={user}
      title="Policies"
      subtitle="Versioned rules · deterministic math"
    >
      {active ? (
        <div className="card mb-5 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="app-h">{active.policy.name}</h2>
              <p className="app-sub">Active version v{active.version.version}</p>
            </div>
            {sim ? (
              <p className="app-sub">
                Simulator (₦780k known vendor): <span className="font-semibold text-foreground">{sim.decision}</span>
              </p>
            ) : null}
          </div>
          <pre className="mt-4 overflow-x-auto rounded-xl bg-[#0f1c1f] p-4 text-xs text-teal-50">
            {JSON.stringify(active.rules, null, 2)}
          </pre>
        </div>
      ) : null}

      <div className="card mb-5 p-5">
        <h2 className="app-h">Publish new version</h2>
        <form action={publish} className="mt-4 grid gap-3 md:grid-cols-2">
          <input type="hidden" name="policyId" value={active?.policy.id || ""} />
          <label className="text-sm">
            Name
            <input name="name" className="input mt-1" defaultValue={active?.policy.name || "Corporate AP Policy"} />
          </label>
          <label className="text-sm">
            Changelog
            <input name="changelog" className="input mt-1" placeholder="Why this change" />
          </label>
          <label className="text-sm">
            Auto-approve max
            <input name="autoApproveMax" type="number" className="input mt-1" defaultValue={active?.rules.autoApproveMax ?? 50000} />
          </label>
          <label className="text-sm">
            Auto-approve max (USDC)
            <input
              name="autoApproveMaxUsdc"
              type="number"
              className="input mt-1"
              defaultValue={active?.rules.autoApproveMaxUsdc ?? 5000}
            />
          </label>
          <label className="text-sm">
            Min confidence for auto-approve
            <input
              name="minConfidenceForAutoApprove"
              type="number"
              step="0.01"
              min="0"
              max="1"
              className="input mt-1"
              defaultValue={active?.rules.minConfidenceForAutoApprove ?? 0.6}
            />
          </label>
          <label className="text-sm">
            Single approver max
            <input
              name="singleApproverMax"
              type="number"
              className="input mt-1"
              defaultValue={active?.rules.singleApproverMax ?? 500000}
            />
          </label>
          <label className="text-sm">
            Dual control above
            <input
              name="dualControlAbove"
              type="number"
              className="input mt-1"
              defaultValue={active?.rules.dualControlAbove ?? 500000}
            />
          </label>
          <label className="text-sm">
            Currency
            <input name="currency" className="input mt-1" defaultValue={active?.rules.currency || "NGN"} />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input name="holdOnNewVendor" type="checkbox" defaultChecked={active?.rules.holdOnNewVendor ?? true} />
            Hold on new vendor
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input name="holdOnBankChange" type="checkbox" defaultChecked={active?.rules.holdOnBankChange ?? true} />
            Hold on bank change
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input name="holdOnDuplicate" type="checkbox" defaultChecked={active?.rules.holdOnDuplicate ?? true} />
            Hold on duplicate
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              name="requirePoMatch"
              type="checkbox"
              defaultChecked={active?.rules.requirePoMatch ?? false}
            />
            Require PO / contract match
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              name="holdOnUnknownDestination"
              type="checkbox"
              defaultChecked={active?.rules.holdOnUnknownDestination ?? true}
            />
            Hold if wallet not allowlisted
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              name="blockAutoApproveUntilAllowlisted"
              type="checkbox"
              defaultChecked={active?.rules.blockAutoApproveUntilAllowlisted ?? true}
            />
            Block auto-approve until Arc destination allowlisted
          </label>
          <div className="flex flex-wrap gap-2 md:col-span-2">
            <button type="submit" className="btn btn-primary">
              Publish policy version
            </button>
            <button type="submit" formAction={publishStrict} className="btn btn-secondary">
              Apply PayablesAI Strict preset
            </button>
          </div>
        </form>
      </div>

      <div className="card overflow-hidden">
        <table className="table">
          <thead>
            <tr>
              <th>Version</th>
              <th>Changelog</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.id}>
                <td>v{v.version}</td>
                <td>{v.changelog || "—"}</td>
                <td>{formatDate(v.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AppShell>
  );
}
