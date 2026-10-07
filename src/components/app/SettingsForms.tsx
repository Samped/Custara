"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";

async function postSettings(body: Record<string, unknown>) {
  const res = await fetch("/api/app/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as {
    error?: string;
    redirectTo?: string;
  };
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export function SettingsJsonForm({
  action,
  children,
  className,
  transform,
}: {
  action: string;
  children: ReactNode;
  className?: string;
  transform?: (fd: FormData, body: Record<string, unknown>) => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const form = event.currentTarget;
      const fd = new FormData(form);
      const body: Record<string, unknown> = { action };
      fd.forEach((value, key) => {
        if (typeof value !== "string") return;
        if (key === "mfaRole") {
          const roles = (body.mfaRoles as string[]) || [];
          roles.push(value);
          body.mfaRoles = roles;
          return;
        }
        if (
          key === "privacyMode" ||
          key === "autoPayEnabled" ||
          key === "ssoEnforced"
        ) {
          body[key] = true;
          return;
        }
        body[key] = value;
      });
      // Unchecked checkboxes are absent from FormData — normalize booleans.
      if (action === "save_org") {
        body.privacyMode = fd.get("privacyMode") === "on";
        body.autoPayEnabled = fd.get("autoPayEnabled") === "on";
        body.ssoEnforced = fd.get("ssoEnforced") === "on";
        if (!body.mfaRoles) body.mfaRoles = [];
      }
      if (action === "save_mfa_roles" && !body.mfaRoles) {
        body.mfaRoles = [];
      }
      transform?.(fd, body);
      const data = await postSettings(body);
      if (data.redirectTo) router.push(data.redirectTo);
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
      {error ? <p className="mt-2 text-[0.72rem] text-danger md:col-span-2">{error}</p> : null}
      {busy ? <p className="mt-1 text-[0.65rem] text-muted md:col-span-2">Saving…</p> : null}
    </form>
  );
}

export function SettingsOrgForm({ children }: { children: ReactNode }) {
  return (
    <SettingsJsonForm action="save_org" className="mt-4 grid gap-3 md:grid-cols-2">
      {children}
    </SettingsJsonForm>
  );
}

export function BeginMfaForm({
  redirectBase = "/app/settings",
  buttonLabel = "Start MFA enrollment",
  buttonClassName = "btn btn-secondary",
  className = "mt-3",
}: {
  redirectBase?: string;
  buttonLabel?: string;
  buttonClassName?: string;
  className?: string;
}) {
  return (
    <SettingsJsonForm
      action="begin_mfa"
      className={className}
      transform={(_fd, body) => {
        body.redirectBase = redirectBase;
      }}
    >
      <button type="submit" className={buttonClassName}>
        {buttonLabel}
      </button>
    </SettingsJsonForm>
  );
}

export function ConfirmMfaForm({
  redirectTo = "/app/settings",
  className = "flex max-w-sm flex-col gap-2",
}: {
  redirectTo?: string;
  className?: string;
}) {
  return (
    <SettingsJsonForm
      action="confirm_mfa"
      className={className}
      transform={(_fd, body) => {
        body.redirectTo = redirectTo;
      }}
    >
      <input name="code" className="input" placeholder="6-digit code" required />
      <button type="submit" className="btn btn-black">
        Confirm enrollment
      </button>
    </SettingsJsonForm>
  );
}

export function DisableMfaForm() {
  return (
    <div className="mt-4 max-w-md space-y-3 rounded-xl border border-line bg-[#f7fafb] px-4 py-3">
      <div>
        <p className="text-sm font-semibold text-foreground">Disable MFA</p>
        <p className="mt-1 text-[0.78rem] text-muted">Requires current authenticator code.</p>
      </div>
      <SettingsJsonForm action="disable_mfa" className="flex flex-col gap-2">
        <input
          name="code"
          className="input"
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="6-digit code"
          required
        />
        <button type="submit" className="btn btn-secondary">
          Turn off MFA
        </button>
      </SettingsJsonForm>
    </div>
  );
}
