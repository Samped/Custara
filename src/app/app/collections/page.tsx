import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { AppShell } from "@/components/app/AppShell";
import { formatDate, formatMoney } from "@/lib/format";
import {
  createReceivable,
  listCollectionsQueue,
  markReceivablePaid,
  upsertCustomer,
} from "@/domain/collections";

export default async function CollectionsPage() {
  let user;
  try {
    user = await requireSessionUser(["admin", "payer", "approver"], "cash:read");
  } catch {
    redirect("/login");
  }

  const queue = await listCollectionsQueue(user.organizationId);
  const customers = await prisma.customer.findMany({
    where: { organizationId: user.organizationId },
    orderBy: { name: "asc" },
    take: 200,
  });

  async function addCustomer(formData: FormData) {
    "use server";
    const session = await requireSessionUser(["admin", "payer"], "cash:read");
    await upsertCustomer({
      organizationId: session.organizationId,
      name: String(formData.get("name") || ""),
      email: String(formData.get("email") || "") || null,
    });
    revalidatePath("/app/collections");
  }

  async function addReceivable(formData: FormData) {
    "use server";
    const session = await requireSessionUser(["admin", "payer"], "cash:read");
    const due = String(formData.get("dueDate") || "");
    await createReceivable({
      organizationId: session.organizationId,
      customerId: String(formData.get("customerId") || ""),
      amount: Number(formData.get("amount") || 0),
      currency: String(formData.get("currency") || "NGN"),
      invoiceNumber: String(formData.get("invoiceNumber") || "") || null,
      dueDate: due ? new Date(due) : null,
      issueDate: new Date(),
      actorId: session.id,
    });
    revalidatePath("/app/collections");
  }

  async function markPaid(formData: FormData) {
    "use server";
    const session = await requireSessionUser(["admin", "payer"], "cash:read");
    await markReceivablePaid({
      organizationId: session.organizationId,
      receivableId: String(formData.get("receivableId") || ""),
      actorId: session.id,
    });
    revalidatePath("/app/collections");
  }

  return (
    <AppShell
      user={user}
      title="Collections"
      subtitle="AR queue · behavior score · timed follow-ups"
    >
      <div className="mb-5 grid gap-4 lg:grid-cols-2">
        <section className="card p-5">
          <h2 className="app-h">Add customer</h2>
          <form action={addCustomer} className="mt-3 grid gap-2">
            <input name="name" className="input" placeholder="Customer name" required />
            <input name="email" type="email" className="input" placeholder="billing@customer.com" />
            <button type="submit" className="btn btn-primary">
              Save customer
            </button>
          </form>
        </section>
        <section className="card p-5">
          <h2 className="app-h">Open receivable</h2>
          <form action={addReceivable} className="mt-3 grid gap-2">
            <select name="customerId" className="input" required defaultValue="">
              <option value="" disabled>
                Select customer
              </option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} (score {Math.round(c.behaviorScore)})
                </option>
              ))}
            </select>
            <input name="invoiceNumber" className="input" placeholder="Invoice #" />
            <div className="grid grid-cols-2 gap-2">
              <input name="amount" type="number" step="0.01" className="input" placeholder="Amount" required />
              <input name="currency" className="input" defaultValue="NGN" />
            </div>
            <input name="dueDate" type="date" className="input" />
            <button type="submit" className="btn btn-primary" disabled={!customers.length}>
              Create receivable
            </button>
          </form>
        </section>
      </div>

      <section className="card p-5">
        <h2 className="app-h">Priority queue</h2>
        <p className="app-sub">Higher priority = chase sooner (overdue + lower behavior score)</p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-[0.72rem] uppercase tracking-wide text-muted">
              <tr>
                <th className="pb-2 pr-3">Customer</th>
                <th className="pb-2 pr-3">Amount</th>
                <th className="pb-2 pr-3">Due</th>
                <th className="pb-2 pr-3">Priority</th>
                <th className="pb-2 pr-3">Reminders</th>
                <th className="pb-2">Action</th>
              </tr>
            </thead>
            <tbody>
              {queue.map((r) => (
                <tr key={r.id} className="border-t border-black/5">
                  <td className="py-3 pr-3">
                    <p className="font-semibold">{r.customer.name}</p>
                    <p className="text-[0.72rem] text-muted">
                      Score {Math.round(r.customer.behaviorScore)}
                      {r.invoiceNumber ? ` · ${r.invoiceNumber}` : ""}
                    </p>
                  </td>
                  <td className="py-3 pr-3">{formatMoney(r.amount, r.currency)}</td>
                  <td className="py-3 pr-3 text-muted">{formatDate(r.dueDate)}</td>
                  <td className="py-3 pr-3">{r.priority}</td>
                  <td className="py-3 pr-3 text-muted">
                    {r.reminderCount}
                    {r.lastReminderAt ? ` · ${formatDate(r.lastReminderAt)}` : ""}
                  </td>
                  <td className="py-3">
                    <form action={markPaid}>
                      <input type="hidden" name="receivableId" value={r.id} />
                      <button type="submit" className="btn btn-secondary text-[0.72rem]">
                        Mark paid
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
              {!queue.length ? (
                <tr>
                  <td colSpan={6} className="py-8 text-muted">
                    No open receivables. Worker sends `receivable.reminder` webhooks for overdue items.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </AppShell>
  );
}
