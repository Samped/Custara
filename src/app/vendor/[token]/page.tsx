"use client";

import { FormEvent, useEffect, useState } from "react";
import { useParams } from "next/navigation";

type PortalMeta = {
  organization: string;
  vendor: string | null;
  email: string;
  expires_at: string;
};

export default function VendorPortalPage() {
  const params = useParams<{ token: string }>();
  const token = params.token;
  const [meta, setMeta] = useState<PortalMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/vendor-portal/${encodeURIComponent(token)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Invalid link");
        if (!cancelled) setMeta(data);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Invalid link");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const form = e.currentTarget;
      const fd = new FormData(form);
      const res = await fetch(`/api/vendor-portal/${encodeURIComponent(token)}`, {
        method: "POST",
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed");
      setOk(`Invoice received (${data.invoiceId}). ${data.organizationName} will process it.`);
      form.reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-[linear-gradient(165deg,#f4f7f8_0%,#e8f0f2_45%,#dfe9ec_100%)] px-4 py-16">
      <div className="mx-auto max-w-lg">
        <p className="font-[family-name:var(--font-display)] text-2xl font-semibold tracking-tight text-[#0b2a32]">
          Custara
        </p>
        <h1 className="mt-6 font-[family-name:var(--font-display)] text-3xl font-semibold text-[#0b2a32]">
          Vendor invoice portal
        </h1>
        {meta ? (
          <p className="mt-2 text-sm text-[#4a6570]">
            Submit invoices to <strong>{meta.organization}</strong>
            {meta.vendor ? ` as ${meta.vendor}` : ""} ({meta.email}).
          </p>
        ) : null}

        {error ? <p className="mt-4 text-sm text-red-700">{error}</p> : null}
        {ok ? <p className="mt-4 text-sm text-emerald-800">{ok}</p> : null}

        {meta ? (
          <form onSubmit={onSubmit} className="mt-8 space-y-4 rounded-2xl bg-white/80 p-6 shadow-sm ring-1 ring-black/5">
            <label className="block text-sm">
              Invoice file (PDF / image)
              <input name="file" type="file" required accept=".pdf,.png,.jpg,.jpeg,.webp" className="mt-1 block w-full text-sm" />
            </label>
            <label className="block text-sm">
              Invoice number
              <input name="invoice_number" className="input mt-1" placeholder="INV-1001" />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-sm">
                Amount
                <input name="total_amount" type="number" step="0.01" className="input mt-1" />
              </label>
              <label className="block text-sm">
                Currency
                <input name="currency" className="input mt-1" defaultValue="NGN" />
              </label>
            </div>
            <label className="block text-sm">
              Notes
              <textarea name="notes" rows={2} className="input mt-1" />
            </label>
            <button type="submit" className="btn btn-primary w-full" disabled={busy}>
              {busy ? "Uploading…" : "Submit invoice"}
            </button>
          </form>
        ) : null}
      </div>
    </main>
  );
}
