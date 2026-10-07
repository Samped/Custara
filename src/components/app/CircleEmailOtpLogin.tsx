"use client";

import { useEffect, useRef, useState } from "react";

type Props = {
  circleAppId: string;
  defaultEmail?: string;
};

type OtpTokens = {
  deviceToken: string;
  deviceEncryptionKey: string;
  otpToken: string;
};

type CircleSdk = {
  getDeviceId: () => Promise<string> | string;
  updateConfigs: (c: unknown, onLogin?: unknown) => void;
  verifyOtp: () => void;
  setAuthentication: (a: { userToken: string; encryptionKey: string }) => void;
  setOnResendOtpEmail?: (cb: () => void) => void;
  setLocalizations?: (loc: unknown) => void;
  setThemeColor?: (theme: unknown) => void;
};

type Step = "email" | "code" | "finishing";

type LoginResult = {
  userToken?: string;
  encryptionKey?: string;
};

function loginErrorMessage(err: unknown) {
  if (!err) return "Verification failed";
  if (typeof err === "string") return err;
  const e = err as { message?: string; code?: number | string };
  if (e.message) return e.message;
  if (e.code != null) return `Circle error ${e.code}`;
  return "Verification failed";
}

function styleOtpIframe(iframe: HTMLIFrameElement, host: HTMLElement) {
  iframe.removeAttribute("width");
  iframe.removeAttribute("height");
  iframe.style.cssText = [
    "position:absolute",
    "inset:0",
    "width:100%",
    "height:100%",
    "border:0",
    "border-radius:12px",
    "transform:none",
    "top:0",
    "left:0",
    "z-index:2",
    "display:block",
    "background:transparent",
  ].join(";");
  if (iframe.parentElement !== host) {
    host.appendChild(iframe);
  }
}

/** Circle email OTP — email in, code panel opens, then into Custara. */
export default function CircleEmailOtpLogin({
  circleAppId,
  defaultEmail = "",
}: Props) {
  const [email, setEmail] = useState(defaultEmail);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<Step>("email");
  const [sdkReady, setSdkReady] = useState(false);
  const [otpTokens, setOtpTokens] = useState<OtpTokens | null>(null);
  const [deviceId, setDeviceId] = useState("");
  const [resendIn, setResendIn] = useState(0);
  const sdkRef = useRef<CircleSdk | null>(null);
  const pendingEmail = useRef(email);
  const aliveRef = useRef(true);
  const otpHostRef = useRef<HTMLDivElement | null>(null);
  const embedObserverRef = useRef<MutationObserver | null>(null);
  const requestOtpRef = useRef<(e?: React.FormEvent) => Promise<void>>(async () => undefined);
  const finishRef = useRef<(userToken: string, encryptionKey: string) => Promise<void>>(
    async () => undefined,
  );

  function stopEmbedding() {
    embedObserverRef.current?.disconnect();
    embedObserverRef.current = null;
  }

  function startEmbedding() {
    stopEmbedding();
    const sync = () => {
      const host = otpHostRef.current;
      const iframe = document.getElementById("sdkIframe") as HTMLIFrameElement | null;
      if (!host || !iframe) return;
      const fixed = iframe.style.position === "fixed" || iframe.parentElement === document.body;
      if (fixed || iframe.parentElement !== host) {
        styleOtpIframe(iframe, host);
      }
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "width", "height"],
    });
    embedObserverRef.current = observer;
    // Circle often flips to fullscreen on showUi — re-pin a few times.
    [50, 150, 400, 800, 1600].forEach((ms) => window.setTimeout(sync, ms));
  }

  async function finishCircleLogin(userToken: string, encryptionKey: string) {
    setBusy(true);
    setError("");
    setStep("finishing");
    stopEmbedding();
    try {
      sdkRef.current?.setAuthentication?.({ userToken, encryptionKey });
      const res = await fetch("/api/auth/circle/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "circle",
          email: pendingEmail.current,
          userToken,
          encryptionKey,
        }),
      });
      const data = (await res.json()) as {
        error?: string;
        redirect?: string;
        needsWalletInit?: boolean;
      };
      if (!res.ok) throw new Error(data.error || "Login failed");

      if (data.needsWalletInit) {
        await fetch("/api/auth/circle/initialize-wallet", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userToken, email: pendingEmail.current }),
        }).catch(() => null);
      }

      window.location.href = data.redirect || "/app";
    } catch (e) {
      setError(e instanceof Error ? e.message : "Login failed");
      setBusy(false);
      setStep("code");
    }
  }

  finishRef.current = finishCircleLogin;

  function bindLoginCallback(sdk: CircleSdk, configs?: Record<string, unknown>) {
    const onLoginComplete = (err: unknown, result: LoginResult | null | undefined) => {
      if (!aliveRef.current) return;
      if (err) {
        setError(loginErrorMessage(err));
        setBusy(false);
        setStep("code");
        return;
      }
      const userToken = result?.userToken;
      const encryptionKey = result?.encryptionKey;
      if (!userToken || !encryptionKey) {
        setError("Verification succeeded but no session tokens were returned");
        setBusy(false);
        setStep("code");
        return;
      }
      void finishRef.current(userToken, encryptionKey);
    };

    sdk.updateConfigs(configs ?? { appSettings: { appId: circleAppId } }, onLoginComplete);
  }

  function openCodePanel(tokens: OtpTokens) {
    const sdk = sdkRef.current;
    if (!sdk?.verifyOtp) {
      setError("Sign-in is still loading — wait a moment");
      return;
    }

    bindLoginCallback(sdk, {
      appSettings: { appId: circleAppId },
      loginConfigs: {
        deviceToken: tokens.deviceToken,
        deviceEncryptionKey: tokens.deviceEncryptionKey,
        otpToken: tokens.otpToken,
      },
    });

    sdk.setLocalizations?.({
      emailOtp: {
        title: "Enter your code",
        subtitle: "Enter the code from your email",
        resendHint: "Didn’t get it?",
        resend: "Resend",
      },
    });

    sdk.setThemeColor?.({
      backdrop: "#ffffff",
      backdropOpacity: 0,
      bg: "#ffffff",
      textMain: "#111111",
      textMain2: "#111111",
      textAuxiliary: "#667085",
      textAuxiliary2: "#667085",
      textPlaceholder: "#98a2b3",
      inputText: "#111111",
      inputBorderFocused: "#111111",
      mainBtnBg: "#111111",
      mainBtnText: "#ffffff",
    });

    setStep("code");
    setBusy(true);
    setError("");

    window.setTimeout(() => {
      try {
        startEmbedding();
        sdk.verifyOtp();
        startEmbedding();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not open code entry");
        setBusy(false);
        stopEmbedding();
      }
    }, 80);
  }

  useEffect(() => {
    aliveRef.current = true;
    let cancelled = false;

    (async () => {
      try {
        const mod = await import("@circle-fin/w3s-pw-web-sdk");
        const W3SSdk = (mod as { W3SSdk: new (cfg: unknown, onLogin?: unknown) => CircleSdk }).W3SSdk;
        const sdk = new W3SSdk({ appSettings: { appId: circleAppId } });
        if (cancelled) return;
        sdkRef.current = sdk;
        bindLoginCallback(sdk, { appSettings: { appId: circleAppId } });
        sdk.setOnResendOtpEmail?.(() => {
          if (!aliveRef.current) return;
          void requestOtpRef.current();
        });

        try {
          const cached = window.localStorage.getItem("custara_circle_device_id");
          if (cached) setDeviceId(cached);
          else {
            const id = await Promise.resolve(sdk.getDeviceId());
            if (cancelled) return;
            setDeviceId(id);
            window.localStorage.setItem("custara_circle_device_id", id);
          }
        } catch {
          setDeviceId(crypto.randomUUID());
        }
        if (!cancelled) setSdkReady(true);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? `Sign-in unavailable (${e.message})` : "Sign-in unavailable");
        }
      }
    })();

    return () => {
      cancelled = true;
      aliveRef.current = false;
      stopEmbedding();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [circleAppId]);

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = window.setTimeout(() => setResendIn((n) => n - 1), 1000);
    return () => window.clearTimeout(t);
  }, [resendIn]);

  async function requestOtp(e?: React.FormEvent) {
    e?.preventDefault();
    const nextEmail = email.trim().toLowerCase();
    if (!nextEmail.includes("@")) {
      setError("Enter a valid work email");
      return;
    }
    if (!sdkReady || !sdkRef.current) {
      setError("Preparing secure sign-in… try again in a second");
      return;
    }

    setBusy(true);
    setError("");
    pendingEmail.current = nextEmail;

    try {
      const useDeviceId =
        deviceId || window.localStorage.getItem("custara_circle_device_id") || crypto.randomUUID();
      const res = await fetch("/api/auth/circle/email-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: nextEmail, deviceId: useDeviceId }),
      });
      const data = (await res.json()) as {
        error?: string;
        deviceToken?: string;
        deviceEncryptionKey?: string;
        otpToken?: string;
      };
      if (!res.ok) throw new Error(data.error || "Could not send code");
      if (!data.deviceToken || !data.deviceEncryptionKey || !data.otpToken) {
        throw new Error("Incomplete response from Circle");
      }
      const tokens = {
        deviceToken: data.deviceToken,
        deviceEncryptionKey: data.deviceEncryptionKey,
        otpToken: data.otpToken,
      };
      setOtpTokens(tokens);
      setResendIn(30);
      openCodePanel(tokens);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
      setBusy(false);
      setStep("email");
      stopEmbedding();
    }
  }

  requestOtpRef.current = requestOtp;

  function resetEmail() {
    stopEmbedding();
    const iframe = document.getElementById("sdkIframe");
    iframe?.parentNode?.removeChild(iframe);
    setOtpTokens(null);
    setStep("email");
    setError("");
    setBusy(false);
    setResendIn(0);
  }

  return (
    <div className="login-circle mt-7">
      <div className="login-steps" aria-hidden>
        <span className={step === "email" ? "on" : "done"} />
        <span className={step === "code" ? "on" : step === "finishing" ? "done" : ""} />
        <span className={step === "finishing" ? "on" : ""} />
      </div>

      {step === "email" ? (
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
              autoFocus
              className="input"
              placeholder="you@company.com"
              value={email}
              onChange={(ev) => setEmail(ev.target.value)}
              autoComplete="email"
              disabled={busy}
            />
          </div>
          <button type="submit" className="btn btn-black w-full" disabled={busy || !sdkReady}>
            {busy ? "Sending…" : !sdkReady ? "Preparing…" : "Continue"}
          </button>
          <p className="text-[0.78rem] text-muted">A one-time code will be sent to this email.</p>
        </form>
      ) : step === "finishing" ? (
        <div className="space-y-4">
          <div className="login-sent-card">
            <p className="text-[0.9rem] font-semibold tracking-[-0.02em]">You’re in</p>
            <p className="mt-2 text-[0.82rem] text-muted">Opening your workspace…</p>
          </div>
          <button type="button" className="btn btn-black w-full" disabled>
            Signing you in…
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <p className="text-[0.9rem] font-semibold tracking-[-0.02em]">Enter your code</p>
            <p className="mt-1 text-[0.82rem] text-muted break-all">Sent to {pendingEmail.current}</p>
          </div>

          <div ref={otpHostRef} className="login-otp-host" aria-label="One-time code entry" />

          <div className="flex flex-wrap items-center justify-between gap-2 text-[0.78rem]">
            <button
              type="button"
              className="text-muted underline-offset-2 hover:underline disabled:opacity-40"
              disabled={resendIn > 0}
              onClick={() => void requestOtp()}
            >
              {resendIn > 0 ? `Resend in ${resendIn}s` : "Resend code"}
            </button>
            <button type="button" className="text-muted underline-offset-2 hover:underline" onClick={resetEmail}>
              Different email
            </button>
            {otpTokens ? (
              <button
                type="button"
                className="text-muted underline-offset-2 hover:underline"
                onClick={() => openCodePanel(otpTokens)}
              >
                Reload code entry
              </button>
            ) : null}
          </div>
        </div>
      )}

      {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}
    </div>
  );
}
