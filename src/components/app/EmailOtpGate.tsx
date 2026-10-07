"use client";

import dynamic from "next/dynamic";
import { SandboxEmailOtpLogin } from "@/components/app/SandboxEmailOtpLogin";

const CircleEmailOtpLogin = dynamic(() => import("@/components/app/CircleEmailOtpLogin"), {
  ssr: false,
  loading: () => (
    <div className="mt-7 space-y-4">
      <div className="login-skeleton h-10 w-full" />
      <div className="login-skeleton h-11 w-full" />
      <p className="text-[0.78rem] text-muted">Loading…</p>
    </div>
  ),
});

export function EmailOtpGate({
  circleReady,
  circleAppId,
}: {
  circleReady: boolean;
  circleAppId: string | null;
}) {
  if (circleReady && circleAppId) {
    return <CircleEmailOtpLogin circleAppId={circleAppId} />;
  }

  return (
    <div className="mt-7 space-y-4">
      <div className="rounded-md border border-[var(--line)] p-4 text-sm">
        <p className="font-semibold">Circle sign-in is not configured</p>
        <p className="mt-2 text-muted leading-relaxed">
          Add <code className="font-mono text-[0.78rem]">CIRCLE_API_KEY</code>,{" "}
          <code className="font-mono text-[0.78rem]">CIRCLE_APP_ID</code>, and{" "}
          <code className="font-mono text-[0.78rem]">NEXT_PUBLIC_CIRCLE_APP_ID</code> to{" "}
          <code className="font-mono text-[0.78rem]">.env</code>, then restart.
        </p>
      </div>
      <SandboxEmailOtpLogin />
    </div>
  );
}
