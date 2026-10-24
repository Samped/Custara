import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";

export async function GET(
  _request: Request,
  context: { params: Promise<{ invoiceId: string; docId: string }> },
) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { invoiceId, docId } = await context.params;
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, organizationId: user.organizationId },
    select: { id: true },
  });
  if (!invoice) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const doc = await prisma.invoiceDocument.findFirst({
    where: { id: docId, invoiceId, deletedAt: null },
  });
  if (!doc?.content) return NextResponse.json({ error: "Document not found" }, { status: 404 });
  const inline = doc.mimeType.includes("pdf") || doc.mimeType.startsWith("image/");
  return new NextResponse(new Uint8Array(doc.content), {
    headers: {
      "Content-Type": doc.mimeType || "application/octet-stream",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${doc.filename.replace(/"/g, "")}"`,
    },
  });
}
