import { after } from "next/server";
import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { AuthError, requireSessionUser } from "@/lib/auth";
import { processInvoiceUpload } from "@/domain/uploadInvoice";
import { runInvoicePipeline } from "@/domain/pipeline";

export const runtime = "nodejs";
// Multi-invoice packs finish analysis after the response; keep room for that work.
export const maxDuration = 300;

/**
 * Invoice upload — prefers JSON { fileName, contentBase64 } (wallet-extension safe).
 * Still accepts multipart for non-browser clients.
 */
export async function POST(req: Request) {
  const wantsJson =
    req.headers.get("x-custara-upload") === "xhr" ||
    (req.headers.get("content-type") || "").includes("application/json");
  try {
    const user = await requireSessionUser(undefined, "inbox:write");
    const contentType = req.headers.get("content-type") || "";
    let file: File;

    if (contentType.includes("application/json")) {
      const body = (await req.json()) as {
        fileName?: string;
        contentType?: string;
        contentBase64?: string;
      };
      if (!body.contentBase64 || !body.fileName) {
        return NextResponse.json({ error: "File required" }, { status: 400 });
      }
      const bytes = Buffer.from(body.contentBase64, "base64");
      // Copy into a fresh ArrayBuffer. A pooled Buffer view can make File include extra bytes.
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      file = new File([copy], body.fileName, {
        type: body.contentType || "application/octet-stream",
      });
    } else {
      const form = await req.formData();
      const raw = form.get("file");
      if (!(raw instanceof File)) {
        if (wantsJson) return NextResponse.json({ error: "File required" }, { status: 400 });
        return NextResponse.redirect(new URL("/app/inbox?upload=missing", req.url), 303);
      }
      file = raw;
    }

    const result = await processInvoiceUpload(user, file);

    if (result.pendingInvoiceIds?.length) {
      const ids = result.pendingInvoiceIds;
      const actorId = user.id;
      after(async () => {
        await Promise.allSettled(
          ids.map(async (invoiceId) => {
            try {
              await runInvoicePipeline(invoiceId, { type: "user", id: actorId });
            } catch (err) {
              console.warn(
                "[custara] background pipeline failed",
                invoiceId,
                err instanceof Error ? err.message : err,
              );
            }
          }),
        );
        revalidatePath("/app");
        revalidatePath("/app/inbox");
      });
    }

    if (wantsJson) {
      return NextResponse.json({ ok: true, redirectTo: result.redirectTo });
    }
    return NextResponse.redirect(new URL(result.redirectTo, req.url), 303);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Upload failed";
    const status = e instanceof AuthError ? e.status : 400;
    if (wantsJson) {
      return NextResponse.json({ error: message }, { status });
    }
    const dest =
      status === 401 || status === 403
        ? "/login"
        : `/app/inbox?upload=error&msg=${encodeURIComponent(message.slice(0, 120))}`;
    return NextResponse.redirect(new URL(dest, req.url), 303);
  }
}
