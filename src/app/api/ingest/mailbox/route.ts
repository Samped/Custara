import { NextRequest, NextResponse } from "next/server";
import { createRequestId } from "@/lib/audit";
import {
  ingestMailboxAttachments,
  parseMimeAttachments,
  resolveOrganizationByIngestRecipient,
  type InboundAttachment,
} from "@/domain/mailbox";

export const runtime = "nodejs";

/**
 * Inbound email webhook for ESP providers (Mailgun/SendGrid-style) or custom forwarders.
 * Privacy-first: only file attachments are ingested; message body is not stored.
 *
 * Auth: Bearer MAILBOX_INBOUND_SECRET or header x-mailbox-secret
 */
export async function POST(request: NextRequest) {
  try {
    const secret = (process.env.MAILBOX_INBOUND_SECRET || "").trim();
    const auth = request.headers.get("authorization") || "";
    const headerSecret = request.headers.get("x-mailbox-secret") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : headerSecret;
    if (!secret || token !== secret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const requestId = request.headers.get("x-request-id") || createRequestId();
    const contentType = request.headers.get("content-type") || "";

    let recipients: string[] = [];
    let messageId = "";
    let subject = "";
    let bodyText = "";
    let attachments: InboundAttachment[] = [];

    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const to = String(form.get("recipient") || form.get("to") || "");
      const cc = String(form.get("cc") || "");
      recipients = [...to.split(","), ...cc.split(",")].map((s) => s.trim()).filter(Boolean);
      messageId = String(form.get("Message-Id") || form.get("message_id") || form.get("Message-ID") || "");
      subject = String(form.get("subject") || "");
      bodyText = String(
        form.get("body-plain") || form.get("stripped-text") || form.get("text") || "",
      );

      for (const [key, value] of form.entries()) {
        if (!(value instanceof File)) continue;
        if (!/attachment/i.test(key) && !value.name) continue;
        const bytes = Buffer.from(await value.arrayBuffer());
        if (!bytes.length) continue;
        attachments.push({
          filename: value.name || "attachment.bin",
          mimeType: value.type || "application/octet-stream",
          bytes,
        });
      }

      // Some providers send raw MIME
      const raw = form.get("body-mime") || form.get("email");
      if (typeof raw === "string" && raw.length > 0) {
        attachments = [...attachments, ...parseMimeAttachments(Buffer.from(raw, "utf8"))];
      }
    } else {
      const body = (await request.json()) as {
        to?: string | string[];
        recipient?: string;
        cc?: string | string[];
        message_id?: string;
        subject?: string;
        text?: string;
        body_plain?: string;
        stripped_text?: string;
        attachments?: { filename: string; content_type?: string; content_base64: string }[];
        raw_mime_base64?: string;
      };
      const toList = Array.isArray(body.to) ? body.to : body.to ? [body.to] : [];
      const ccList = Array.isArray(body.cc) ? body.cc : body.cc ? [body.cc] : [];
      if (body.recipient) toList.push(body.recipient);
      recipients = [...toList, ...ccList];
      messageId = body.message_id || "";
      subject = body.subject || "";
      bodyText = body.body_plain || body.stripped_text || body.text || "";
      attachments = (body.attachments || []).map((a) => ({
        filename: a.filename,
        mimeType: a.content_type || "application/octet-stream",
        bytes: Buffer.from(a.content_base64, "base64"),
      }));
      if (body.raw_mime_base64) {
        attachments = [
          ...attachments,
          ...parseMimeAttachments(Buffer.from(body.raw_mime_base64, "base64")),
        ];
      }
    }

    const org = await resolveOrganizationByIngestRecipient(recipients);
    if (!org) {
      return NextResponse.json(
        { error: "No workspace matched recipient ingest email", recipients },
        { status: 404 },
      );
    }

    const result = await ingestMailboxAttachments({
      organizationId: org.id,
      actorType: "system",
      messageId: messageId || undefined,
      subject,
      bodyText: bodyText || undefined,
      attachments,
      requestId,
    });

    return NextResponse.json({
      ok: true,
      organization_id: org.id,
      ...result,
      request_id: requestId,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Mailbox ingest failed" },
      { status: 400 },
    );
  }
}
