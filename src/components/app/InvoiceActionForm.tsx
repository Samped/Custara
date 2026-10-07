"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { isMfaSetupRequiredError } from "@/domain/payStepUp";

/** JSON via XHR — never FormData / window.fetch (wallet extensions structuredClone-crash both). */
function postInvoiceAction(body: Record<string, unknown>): Promise<{
  error?: string;
  redirectTo?: string;
}> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/app/invoice-actions");
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.setRequestHeader("Accept", "application/json");
    xhr.withCredentials = true;
    xhr.onload = () => {
      let data: { error?: string; redirectTo?: string } = {};
      try {
        data = JSON.parse(xhr.responseText || "{}") as typeof data;
      } catch {
        reject(new Error(`Request failed (${xhr.status})`));
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(data.error || `Request failed (${xhr.status})`));
        return;
      }
      resolve(data);
    };
    xhr.onerror = () => reject(new Error("Network error"));
    xhr.send(JSON.stringify(body));
  });
}

function readFormFields(form: HTMLFormElement): Record<string, string> {
  const out: Record<string, string> = {};
  for (const el of Array.from(form.elements)) {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      if (!el.name || el.disabled) continue;
      if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio") && !el.checked) {
        continue;
      }
      if (el instanceof HTMLInputElement && el.type === "file") continue;
      out[el.name] = el.value;
    }
  }
  return out;
}

/** No FormData — wallet extensions clone FormData and crash pay / approve. */
export function InvoiceActionForm({
  action,
  children,
  className,
  extra,
  disabled,
}: {
  action: string;
  children: ReactNode;
  className?: string;
  extra?: Record<string, unknown>;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || disabled) return;
    setBusy(true);
    setError(null);
    try {
      const form = event.currentTarget;
      const body: Record<string, unknown> = { action, ...extra, ...readFormFields(form) };
      const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | undefined;
      if (submitter?.name && submitter.value) {
        body[submitter.name] = submitter.value;
      }
      const data = await postInvoiceAction(body);
      if (data.redirectTo) {
        router.push(data.redirectTo);
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className={className}>
      {children}
      {error ? (
        <div className="mt-2 text-[0.72rem] text-danger">
          {isMfaSetupRequiredError(error) ? (
            <p>
              MFA must be set up before transfers.{" "}
              <Link href="/app/security" className="font-semibold underline">
                Set up MFA
              </Link>
            </p>
          ) : (
            <p>{error}</p>
          )}
        </div>
      ) : null}
      {busy ? <p className="mt-1 text-[0.65rem] text-muted">Working…</p> : null}
    </form>
  );
}
