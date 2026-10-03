import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getObject, getSignedDownloadUrl } from "@/lib/storage";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const intent = await prisma.paymentIntent.findFirst({
    where: { id, organizationId: user.organizationId },
  });
  if (!intent?.exportPath) return NextResponse.json({ error: "Export not found" }, { status: 404 });

  const signed = await getSignedDownloadUrl(intent.exportPath);
  if (signed) {
    return NextResponse.redirect(signed);
  }

  const csv = await getObject(intent.exportPath);
  return new NextResponse(new Uint8Array(csv), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="custara-${intent.id}.csv"`,
    },
  });
}
