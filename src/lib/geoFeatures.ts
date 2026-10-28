/** Workspace location features. Company of record — not GPS or IP. */

export function isNigeriaWorkspace(org: { country?: string | null }) {
  return (org.country || "").trim().toUpperCase() === "NG";
}
