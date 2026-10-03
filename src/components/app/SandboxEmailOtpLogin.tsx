"use client";

import { useRef, useState } from "react";

type Props = {
  defaultEmail?: string;
};

/** Passwordless Custara email OTP (Resend/SMTP when configured). */
export function SandboxEmailOtpLogin({ defaultEmail = "admin@custara.demo" }: Props) {
  const [email, setEmail] = useState(defaultEmail);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const pendingEmail = useRef(email);

  async function requestOtp(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setStatus("Sending code…");
    pendingEmail.current = email.trim().toLowerCase();
    try {
      const res = await fetch("/api/auth/circle/email-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: pendingEmail.current }),
      });
      const data = (await res.json()) as {
        error?: string;
        mode?: string;
        emailed?: boolean;
        devCode?: string;
      };
      if (!res.ok) throw new Error(data.error || "Could not send OTP");
      setSent(true);
      if (data.mode === "email" || data.emailed) {
        setCode("");
        setStatus(`Code sent to ${pendingEmail.current}. Check your inbox (and spam).`);
      } else if (data.devCode) {
        setCode(data.devCode);
        setStatus(
          `Mail not configured yet — local code is ${data.devCode}. Add RESEND_API_KEY + EMAIL_FROM to send real email.`,
        );
      } else {
        setStatus("Check the Next.js server console for your code.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  async function verifyOtp(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setStatus("Verifying…");
    try {
      const res = await fetch("/api/auth/circle/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "email",
          email: pendingEmail.current,
          code: code.trim(),
        }),
      });
      const data = (await res.json()) as {
        error?: string;
        redirect?: string;
        needsWalletInit?: boolean;
      };
      if (!res.ok) throw new Error(data.error || "Invalid code");

      if (data.needsWalletInit) {
        await fetch("/api/auth/circle/initialize-wallet", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: pendingEmail.current }),
        }).catch(() => null);
      }

      window.location.href = data.redirect || "/app";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
      setBusy(false);
    }
  }

  return (
    <div className="mt-7 space-y-4">
      <form onSubmit={requestOtp} className="space-y-4">
        <div>
          <label className="mb-1.5 block text-[0.78rem] font-semibold" htmlFor="email">
            Work email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            className="input"
            value={email}
            onChange={(ev) => setEmail(ev.target.value)}
            autoComplete="email"
          />
        </div>
        <button type="submit" className="btn btn-black w-full" disabled={busy}>
          {busy && !sent ? "Sending…" : "Send email code"}
        </button>
      </form>

      {sent ? (
        <form onSubmit={verifyOtp} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-[0.78rem] font-semibold" htmlFor="otp">
              One-time code
            </label>
            <input
              id="otp"
              name="otp"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              maxLength={6}
              className="input"
              value={code}
              onChange={(ev) => setCode(ev.target.value)}
            />
          </div>
          <button type="submit" className="btn btn-black w-full" disabled={busy}>
            {busy ? "Verifying…" : "Continue"}
          </button>
        </form>
      ) : null}

      {status ? <p className="text-[0.82rem] text-muted">{status}</p> : null}
      {error ? <p className="text-sm text-danger">{error}</p> : null}
    </div>
  );
}
