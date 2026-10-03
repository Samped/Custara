import type { Role } from "./auth";
import { AuthError } from "./auth";

/** Default-deny capability matrix for console surfaces and mutations. */
export type AppCapability =
  | "inbox:read"
  | "invoice:read"
  | "approvals:read"
  | "approvals:write"
  | "vendors:read"
  | "vendors:write"
  | "payments:read"
  | "payments:write"
  | "wallets:read"
  | "wallets:write"
  | "cash:read"
  | "audit:read"
  | "policies:read"
  | "policies:write"
  | "connectors:read"
  | "connectors:write"
  | "settings:write"
  | "developers:read";

const ROLE_CAPS: Record<Role, AppCapability[]> = {
  admin: [
    "inbox:read",
    "invoice:read",
    "approvals:read",
    "approvals:write",
    "vendors:read",
    "vendors:write",
    "payments:read",
    "payments:write",
    "wallets:read",
    "wallets:write",
    "cash:read",
    "audit:read",
    "policies:read",
    "policies:write",
    "connectors:read",
    "connectors:write",
    "settings:write",
    "developers:read",
  ],
  approver: [
    "inbox:read",
    "invoice:read",
    "approvals:read",
    "approvals:write",
    "vendors:read",
    "cash:read",
    "audit:read",
    "policies:read",
  ],
  payer: [
    "inbox:read",
    "invoice:read",
    "approvals:read",
    "vendors:read",
    "vendors:write",
    "payments:read",
    "payments:write",
    "wallets:read",
    "wallets:write",
    "cash:read",
    "audit:read",
  ],
  viewer: ["inbox:read", "invoice:read", "vendors:read", "payments:read", "cash:read"],
  auditor: [
    "inbox:read",
    "invoice:read",
    "approvals:read",
    "vendors:read",
    "payments:read",
    "cash:read",
    "audit:read",
    "policies:read",
  ],
};

export function roleHasCapability(role: Role, capability: AppCapability) {
  return ROLE_CAPS[role]?.includes(capability) ?? false;
}

export function assertCapability(role: Role, capability: AppCapability) {
  if (!roleHasCapability(role, capability)) {
    throw new AuthError(`Forbidden: missing ${capability}`, 403);
  }
}

/** Route → minimum capability to view the page */
export const ROUTE_CAPABILITY: Record<string, AppCapability> = {
  "/app": "inbox:read",
  "/app/approvals": "approvals:read",
  "/app/vendors": "vendors:read",
  "/app/payments": "payments:read",
  "/app/wallets": "wallets:read",
  "/app/cash": "cash:read",
  "/app/collections": "cash:read",
  "/app/audit": "audit:read",
  "/app/policies": "policies:read",
  "/app/connectors": "connectors:read",
  "/app/vendor-portal": "connectors:write",
  "/app/settings": "settings:write",
  "/app/developers": "developers:read",
};

export function capabilityForPath(pathname: string): AppCapability | null {
  if (pathname.startsWith("/app/invoices/")) return "invoice:read";
  if (ROUTE_CAPABILITY[pathname]) return ROUTE_CAPABILITY[pathname];
  const match = Object.keys(ROUTE_CAPABILITY)
    .filter((k) => k !== "/app" && pathname.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return match ? ROUTE_CAPABILITY[match] : null;
}
