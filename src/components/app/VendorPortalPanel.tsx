import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requireSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { formatDate } from "@/lib/format";
import {
  createVendorPortalInvite,
  listVendorPortalInvites,
  revokeVendorPortalInvite,
} from "@/domain/vendorPortal";

export async function VendorPortalPanel({
  organizationId,
  params,
}: {
  organizationId: string;
  params: { created?: string; error?: string; link?: string };
}) {
  const vendors = await prisma.vendor.findMany({
    where: { organizationId },
    orderBy: { name: "asc" },
    take: 200,
    select: { id: true, name: true, email: true },
  });
  const invites = await listVendorPortalInvites(organizationId);
  const h = await headers();
  const host = h.get("x-forwarded-host") || h.get("host") || "localhost:3000";
  const proto = h.get("x-forwarded-proto") || "http";
  const baseUrl = `${proto}://${host}`;

  async function createInvite(formData: FormData) {
    "use server";
    const session = await requireSessionUser(["admin"], "connectors:write");
    try {
      const { token, invite } = await createVendorPortalInvite({
        organizationId: session.organizationId,
        actorId: session.id,
        email: String(formData.get("email") || ""),
        vendorId: String(formData.get("vendorId") || "") || null,
        label: String(formData.get("label") || "") || null,
        expiresInDays: Number(formData.get("expiresInDays") || 30),
      });
      const hdrs = await headers();
      const hostName = hdrs.get("x-forwarded-host") || hdrs.get("host") || "localhost:3000";
      const protocol = hdrs.get("x-forwarded-proto") || "http";
      const link = `${protocol}://${hostName}/vendor/${token}`;
      revalidatePath("/app/vendors");
      redirect(
        `/app/vendors?tab=portal&created=${invite.id}&link=${encodeURIComponent(link)}`,
      );
    } catch (e) {
      redirect(
        `/app/vendors?tab=portal&error=${encodeURIComponent(e instanceof Error ? e.message : "Failed")}`,
      );
    }
  }

  async function revokeInvite(formData: FormData) {
    "use server";
    const session = await requireSessionUser(["admin"], "connectors:write");
    await revokeVendorPortalInvite({
      organizationId: session.organizationId,
      inviteId: String(formData.get("inviteId") || ""),
      actorId: session.id,
    });
    revalidatePath("/app/vendors");
    redirect("/app/vendors?tab=portal");
  }

  return (
    <div className="mt-5 space-y-4">
      {params.error ? <p className="text-sm text-danger">{params.error}</p> : null}
      {params.link ? (
        <div className="dash-panel text-sm text-accent">
          Invite created:
          <p className="mt-2 break-all font-mono text-[0.78rem] text-foreground">{params.link}</p>
        </div>
      ) : null}

      <section className="dash-panel">
        <h2 className="dash-h">Create invite</h2>
        <form action={createInvite} className="mt-4 grid gap-3 md:grid-cols-2">
          <label className="text-sm">
            Vendor email
            <input name="email" type="email" required className="input mt-1" placeholder="ap@supplier.ng" />
          </label>
          <label className="text-sm">
            Link label
            <input name="label" className="input mt-1" placeholder="Q4 AP submissions" />
          </label>
          <label className="text-sm">
            Link to vendor (optional)
            <select name="vendorId" className="input mt-1" defaultValue="">
              <option value="">— Unlinked —</option>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                  {v.email ? ` (${v.email})` : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            Expires (days)
            <input name="expiresInDays" type="number" min={1} max={365} defaultValue={30} className="input mt-1" />
          </label>
          <div className="md:col-span-2">
            <button type="submit" className="btn btn-primary">
              Generate portal link
            </button>
          </div>
        </form>
        <p className="mt-3 text-[0.72rem] text-muted">
          Public path pattern: {baseUrl}/vendor/&lt;token&gt;
        </p>
      </section>

      <section className="dash-panel dash-panel-flush">
        <div className="dash-panel-head dash-panel-pad">
          <div>
            <h2 className="dash-h">Active invites</h2>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Vendor</th>
                <th>Expires</th>
                <th>Last used</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {invites.map((inv) => {
                const revoked = Boolean(inv.revokedAt);
                const expired = inv.expiresAt.getTime() < Date.now();
                return (
                  <tr key={inv.id}>
                    <td>{inv.email}</td>
                    <td className="text-muted">{inv.vendor?.name || "—"}</td>
                    <td className="text-muted">{formatDate(inv.expiresAt)}</td>
                    <td className="text-muted">{formatDate(inv.lastUsedAt)}</td>
                    <td>
                      {revoked || expired ? (
                        <span className="text-muted">{revoked ? "revoked" : "expired"}</span>
                      ) : (
                        <form action={revokeInvite}>
                          <input type="hidden" name="inviteId" value={inv.id} />
                          <button type="submit" className="btn btn-secondary text-[0.72rem]">
                            Revoke
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!invites.length ? (
                <tr>
                  <td colSpan={5} className="py-6 text-muted">
                    No invites yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
