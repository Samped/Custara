import { redirect } from "next/navigation";

/** Audit lives under Controls → Audit. */
export default function AuditRedirectPage() {
  redirect("/app/policies?tab=audit");
}
