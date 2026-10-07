import { NextResponse } from "next/server";
import { AuthError, requireSessionUser } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import {
  createReceivable,
  markReceivablePaid,
  upsertCustomer,
} from "@/domain/collections";

export const runtime = "nodejs";

/** JSON collections mutations — avoids FormData server actions broken by wallet extensions. */
export async function POST(req: Request) {
  try {
    const user = await requireSessionUser(["admin", "payer"], "cash:read");
    const body = (await req.json()) as Record<string, unknown>;
    const action = String(body.action || "");

    if (action === "add_customer") {
      const customer = await upsertCustomer({
        organizationId: user.organizationId,
        name: String(body.name || ""),
        email: String(body.email || "") || null,
      });
      revalidatePath("/app/cash");
      return NextResponse.json({ ok: true, customer });
    }

    if (action === "add_receivable") {
      const due = String(body.dueDate || "");
      const receivable = await createReceivable({
        organizationId: user.organizationId,
        customerId: String(body.customerId || ""),
        amount: Number(body.amount || 0),
        currency: String(body.currency || "USD"),
        invoiceNumber: String(body.invoiceNumber || "") || null,
        dueDate: due ? new Date(due) : null,
        issueDate: new Date(),
        actorId: user.id,
      });
      revalidatePath("/app/cash");
      return NextResponse.json({ ok: true, receivable });
    }

    if (action === "mark_paid") {
      await markReceivablePaid({
        organizationId: user.organizationId,
        receivableId: String(body.receivableId || ""),
        actorId: user.id,
      });
      revalidatePath("/app/cash");
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Request failed" },
      { status: 400 },
    );
  }
}
