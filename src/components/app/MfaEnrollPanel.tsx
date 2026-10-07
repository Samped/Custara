"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { ConfirmMfaForm } from "@/components/app/SettingsForms";

/** QR + manual TOTP setup for authenticator apps. */
export function MfaEnrollPanel({
  secret,
  otpauth,
}: {
  secret: string;
  otpauth: string;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setQrError(null);
    QRCode.toDataURL(otpauth, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 220,
      color: { dark: "#0f172a", light: "#ffffff" },
    })
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrError("Could not render QR — use the secret below.");
      });
    return () => {
      cancelled = true;
    };
  }, [otpauth]);

  return (
    <div className="mt-3 space-y-4 text-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <div className="shrink-0 rounded-xl border border-line bg-white p-3">
          {dataUrl ? (
            <img src={dataUrl} alt="MFA QR code — scan with authenticator app" width={220} height={220} />
          ) : (
            <div className="flex h-[220px] w-[220px] items-center justify-center text-[0.75rem] text-muted">
              {qrError || "Generating QR…"}
            </div>
          )}
        </div>
        <div className="min-w-0 space-y-2">
          <p className="font-medium text-foreground">Scan with TOTP app</p>
          <p className="text-[0.78rem] text-muted">Or enter this secret manually:</p>
          <p className="break-all rounded-lg border border-line bg-[#f7fafb] px-3 py-2 font-mono text-[0.72rem]">
            {secret}
          </p>
          <details className="text-[0.72rem] text-muted">
            <summary className="cursor-pointer font-medium text-foreground">Advanced: otpauth URI</summary>
            <p className="mt-1 break-all font-mono">{otpauth}</p>
          </details>
        </div>
      </div>
      <ConfirmMfaForm />
    </div>
  );
}
