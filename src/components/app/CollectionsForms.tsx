"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent, type ReactNode } from "react";

async function postCollections(body: Record<string, unknown>) {
  const res = await fetch("/api/app/collections", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function JsonForm({
  action,
  children,
  className,
  extra,
}: {
  action: string;
  children: ReactNode;
  className?: string;
  extra?: Record<string, unknown>;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);

    const form = formRef.current;
    if (!form) {
      setBusy(false);
      setError("Form not ready — try again");
      return;
    }

    const fd = new FormData(form);
    const body: Record<string, unknown> = { action, ...extra };
    fd.forEach((value, key) => {
      if (typeof value === "string") body[key] = value;
    });

    try {
      await postCollections(body);
      setFormKey((k) => k + 1);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form key={formKey} ref={formRef} onSubmit={onSubmit} className={className}>
      {children}
      {error ? <p className="text-[0.72rem] text-danger">{error}</p> : null}
      {busy ? <p className="text-[0.72rem] text-muted">Saving…</p> : null}
    </form>
  );
}

export function AddCustomerForm() {
  return (
    <JsonForm action="add_customer" className="mt-3 grid gap-2">
      <input name="name" className="input" placeholder="Customer name" required />
      <input name="email" type="email" className="input" placeholder="billing@customer.com" />
      <button type="submit" className="btn btn-primary">
        Save customer
      </button>
    </JsonForm>
  );
}

export function AddReceivableForm({
  customers,
  defaultCurrency,
}: {
  customers: { id: string; name: string; behaviorScore: number }[];
  defaultCurrency: string;
}) {
  return (
    <JsonForm action="add_receivable" className="mt-3 grid gap-2">
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
        <input name="currency" className="input" defaultValue={defaultCurrency} />
      </div>
      <input name="dueDate" type="date" className="input" />
      <button type="submit" className="btn btn-primary" disabled={!customers.length}>
        Create receivable
      </button>
    </JsonForm>
  );
}

export function MarkPaidButton({ receivableId }: { receivableId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setBusy(true);
    setError(null);
    try {
      await postCollections({ action: "mark_paid", receivableId });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button type="button" className="btn btn-secondary text-[0.72rem]" disabled={busy} onClick={onClick}>
        {busy ? "…" : "Mark paid"}
      </button>
      {error ? <p className="mt-1 text-[0.72rem] text-danger">{error}</p> : null}
    </div>
  );
}
