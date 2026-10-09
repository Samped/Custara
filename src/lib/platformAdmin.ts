/** Platform operators see cross-workspace Network metrics on Home. */

export function isPlatformOperator(
  email: string | null | undefined,
  role?: string | null,
): boolean {
  const normalized = (email || "").trim().toLowerCase();
  const raw = process.env.PLATFORM_ADMIN_EMAILS || "";
  const allow = raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  if (allow.includes("*")) return true;
  if (normalized && allow.includes(normalized)) return true;

  // Local/dev: any workspace admin can open Network metrics (avoids silent empty allowlist).
  if (process.env.NODE_ENV !== "production" && role === "admin") return true;

  return false;
}
