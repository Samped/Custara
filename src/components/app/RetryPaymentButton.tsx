"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { isMfaSetupRequiredError } from "@/domain/payStepUp";

function MfaRetryBlocked() {
  return (
    <p className="text-[0.68rem] text-danger">
      MFA required.{" "}
      <Link href="/app/security" className="font-semibold underline">
        Set up
      </Link>
    </p>
  );
}

export function RetryPaymentButton({
  paymentIntentId,
  mfaEnabled = true,
}: {
  paymentIntentId: string;
  mfaEnabled?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [mfaBlocked, setMfaBlocked] = useState(false);

  if (!mfaEnabled || mfaBlocked) {
    return <MfaRetryBlocked />;
  }

  async function retry() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/api/app/invoice-actions");
        xhr.setRequestHeader("Content-Type", "application/json");
        xhr.setRequestHeader("Accept", "application/json");
        xhr.withCredentials = true;
        xhr.onload = () => {
          let data: { error?: string; redirectTo?: string; alreadyCompleted?: boolean } = {};
          try {
            data = JSON.parse(xhr.responseText || "{}") as typeof data;
          } catch {
            reject(new Error(`Retry failed (${xhr.status})`));
            return;
          }
          if (xhr.status < 200 || xhr.status >= 300) {
            if (/already completed/i.test(data.error || "")) {
              setMessage("Already paid — refreshing…");
              router.refresh();
              resolve();
              return;
            }
            if (isMfaSetupRequiredError(data.error || "")) {
              setMfaBlocked(true);
              resolve();
              return;
            }
            reject(new Error(data.error || `Retry failed (${xhr.status})`));
            return;
          }
          setMessage(data.alreadyCompleted ? "Already paid" : "Retry queued");
          if (data.redirectTo) router.push(data.redirectTo);
          router.refresh();
          resolve();
        };
        xhr.onerror = () => reject(new Error("Network error"));
        xhr.send(JSON.stringify({ action: "retry_payment", paymentIntentId }));
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Retry failed";
      if (isMfaSetupRequiredError(msg)) setMfaBlocked(true);
      else setMessage(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="inline-flex flex-col items-end gap-1">
      <button type="button" className="btn btn-secondary text-[0.68rem]" disabled={busy} onClick={retry}>
        {busy ? "Retrying…" : "Retry"}
      </button>
      {message ? <p className="text-[0.65rem] text-muted">{message}</p> : null}
    </div>
  );
}
