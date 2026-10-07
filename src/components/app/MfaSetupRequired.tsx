import Link from "next/link";

/** Shown on pay surfaces when the actor has not enabled MFA. */
export function MfaSetupRequired({ compact }: { compact?: boolean }) {
  if (compact) {
    return (
      <p className="text-[0.72rem] text-danger">
        MFA required.{" "}
        <Link href="/app/security" className="font-semibold underline">
          Set up
        </Link>
      </p>
    );
  }

  return (
    <div className="mfa-gate">
      <p className="mfa-gate-title">MFA required</p>
      <p className="mfa-gate-sub">Enable MFA under Security, then retry payment.</p>
      <Link href="/app/security" className="btn btn-primary mt-3 inline-flex">
        Set up MFA
      </Link>
    </div>
  );
}
