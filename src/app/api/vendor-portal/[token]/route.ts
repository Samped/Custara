import { NextRequest, NextResponse } from "next/server";
import {
  resolveVendorPortalToken,
  submitVendorPortalInvoice,
} from "@/domain/vendorPortal";

export const runtime = "nodejs";

export async function GET(
  _request: NextRequest,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params;
  const invite = await resolveVendorPortalToken(token);
  if (!invite) {
    return NextResponse.json({ error: "Invalid or expired link" }, { status: 404 });
  }
  return NextResponse.json({
    organization: invite.organization.name,
    vendor: invite.vendor?.name || null,
    email: invite.email,
    expires_at: invite.expiresAt.toISOString(),
  });
}

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ token: string }> },
) {
  try {
    const { token } = await ctx.params;
    const contentType = request.headers.get("content-type") || "";

    if (!contentType.includes("multipart/form-data")) {
      return NextResponse.json({ error: "multipart/form-data required" }, { status: 400 });
    }

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "file required" }, { status: 400 });
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    const result = await submitVendorPortalInvoice({
      token,
      filename: file.name || "invoice.pdf",
      mimeType: file.type || "application/octet-stream",
      bytes,
      invoiceNumber: String(form.get("invoice_number") || "") || undefined,
      totalAmount: form.get("total_amount")
        ? Number(form.get("total_amount"))
        : undefined,
      currency: String(form.get("currency") || "NGN") || undefined,
      notes: String(form.get("notes") || "") || undefined,
      sync: form.get("sync") === "true",
    });

    return NextResponse.json({ ok: true, ...result }, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Upload failed" },
      { status: 400 },
    );
  }
}
