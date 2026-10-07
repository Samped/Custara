import type { Role } from "@/lib/auth";

/** Inviteable workspace roles with plain-language copy for Team UI. */
export const INVITE_ROLE_OPTIONS: {
  value: Role;
  label: string;
  description: string;
}[] = [
  {
    value: "viewer",
    label: "Viewer",
    description: "Read-only access.",
  },
  {
    value: "approver",
    label: "Approver",
    description: "Approve and reject invoices.",
  },
  {
    value: "payer",
    label: "Payer",
    description: "Upload invoices and initiate payments.",
  },
  {
    value: "auditor",
    label: "Auditor",
    description: "Read-only plus audit and policies.",
  },
  {
    value: "admin",
    label: "Admin",
    description: "Full workspace administration.",
  },
];

export function roleLabel(role: string) {
  return INVITE_ROLE_OPTIONS.find((r) => r.value === role)?.label || role;
}

export function roleDescription(role: string) {
  return INVITE_ROLE_OPTIONS.find((r) => r.value === role)?.description || "";
}
