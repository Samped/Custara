import Link from "next/link";

/** Persistent notice when MFA is not enabled. */
export function MfaBanner() {
  return (
    <div className="mfa-banner" role="status">
      <div className="mfa-banner-copy">
        <p className="mfa-banner-title">MFA not enabled</p>
        <p className="mfa-banner-sub">Required for payment authorization.</p>
      </div>
      <Link href="/app/security" className="btn btn-primary mfa-banner-cta">
        Set up MFA
      </Link>
    </div>
  );
}
