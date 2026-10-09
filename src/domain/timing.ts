import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { getCashForecast } from "@/domain/cash";

export type PayTimingRecommendation = {
  recommendedPayDate: Date;
  reason: string;
  takeDiscount: boolean;
  discountPct: number | null;
  discountDeadline: Date | null;
  dueDate: Date | null;
};

function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** Recommend pay date: take early-pay discount when cash allows; otherwise preserve cash until due. */
export async function recommendPayTiming(input: {
  organizationId: string;
  invoiceId: string;
}): Promise<PayTimingRecommendation> {
  const invoice = await prisma.invoice.findFirstOrThrow({
    where: { id: input.invoiceId, organizationId: input.organizationId },
    include: { vendor: true, organization: { select: { targetDpoDays: true } } },
  });

  const today = startOfDay(new Date());
  const due = invoice.dueDate ? startOfDay(invoice.dueDate) : null;
  const issued = startOfDay(invoice.issueDate || invoice.createdAt);
  const discountPct = invoice.vendor?.earlyPayDiscountPct ?? null;
  const earlyDays = invoice.vendor?.earlyPayDays ?? null;

  let discountDeadline: Date | null = null;
  if (discountPct && earlyDays != null && due) {
    discountDeadline = startOfDay(new Date(due.getTime() - earlyDays * 864e5));
  }

  const forecast = await getCashForecast(input.organizationId);
  const cashTight = forecast.funding_gap_7d > 0;

  let recommendedPayDate = due || today;
  let takeDiscount = false;
  let reason = due
    ? `Pay on due date ${due.toISOString().slice(0, 10)} to preserve cash.`
    : "No due date — recommend paying today after approval.";

  if (discountPct && discountDeadline && discountDeadline >= today && !cashTight) {
    recommendedPayDate = discountDeadline < today ? today : discountDeadline;
    takeDiscount = true;
    reason = `Take ${discountPct}% early-pay discount by ${discountDeadline.toISOString().slice(0, 10)} (7-day cash covered).`;
  } else if (discountPct && discountDeadline && cashTight) {
    reason = `Early-pay discount available (${discountPct}%) but 7-day funding gap — defer to due date to preserve cash.`;
    recommendedPayDate = due && due > today ? due : today;
    takeDiscount = false;
  } else if (invoice.organization.targetDpoDays != null && invoice.organization.targetDpoDays >= 0) {
    const target = startOfDay(
      new Date(issued.getTime() + invoice.organization.targetDpoDays * 864e5),
    );
    recommendedPayDate = due && target > due ? due : target;
    if (recommendedPayDate < today) recommendedPayDate = today;
    reason = `Scheduled ${recommendedPayDate.toISOString().slice(0, 10)} to hold about ${invoice.organization.targetDpoDays} days payable, not past the due date.`;
  } else if (cashTight && due && due > today) {
    reason = `Funding gap in 7 days — schedule pay on due date ${due.toISOString().slice(0, 10)}.`;
  }

  await prisma.invoice.update({
    where: { id: invoice.id },
    data: {
      recommendedPayDate,
      payTimingReason: reason,
    },
  });

  return {
    recommendedPayDate,
    reason,
    takeDiscount,
    discountPct,
    discountDeadline,
    dueDate: due,
  };
}

export async function listSuggestedPays(organizationId: string) {
  const today = startOfDay(new Date());
  const week = new Date(today.getTime() + 7 * 864e5);
  return prisma.invoice.findMany({
    where: {
      organizationId,
      status: "approved",
      OR: [
        { recommendedPayDate: { lte: week } },
        { recommendedPayDate: null, dueDate: { lte: week } },
      ],
    },
    include: { vendor: true },
    orderBy: [{ recommendedPayDate: "asc" }, { dueDate: "asc" }],
    take: 50,
  });
}

/** Auto-pay invoices from approved vendors (not new) when the recommended pay date is due. */
export async function runScheduledAutoPays() {
  const orgs = await prisma.organization.findMany({
    where: { autoPayEnabled: true },
    select: { id: true },
  });
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);
  const results: Array<{ organizationId: string; paid: number; errors: string[] }> = [];

  const { createPaymentIntent } = await import("@/domain/payment");

  for (const org of orgs) {
    const due = await prisma.invoice.findMany({
      where: {
        organizationId: org.id,
        status: "approved",
        recommendedPayDate: { lte: todayEnd },
        risks: { none: { severity: "hard" } },
        vendor: { isNew: false },
      },
      take: 25,
    });
    let paid = 0;
    const errors: string[] = [];
    for (const inv of due) {
      try {
        await createPaymentIntent({
          organizationId: org.id,
          invoiceId: inv.id,
          idempotencyKey: `autopay:${inv.id}:${inv.recommendedPayDate?.toISOString().slice(0, 10) || "na"}`,
          actorType: "system",
        });
        paid += 1;
        await writeAudit({
          organizationId: org.id,
          actorType: "system",
          action: "payment.autopay_triggered",
          entityType: "invoice",
          entityId: inv.id,
        });
      } catch (e) {
        errors.push(`${inv.id}: ${e instanceof Error ? e.message : "failed"}`);
      }
    }
    results.push({ organizationId: org.id, paid, errors });
  }
  return results;
}
