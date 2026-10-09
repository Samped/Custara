export function printResult(value: unknown, asJson: boolean) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (value && typeof value === "object" && "data" in value && Array.isArray((value as { data: unknown }).data)) {
    const rows = (value as { data: Record<string, unknown>[] }).data;
    if (!rows.length) {
      console.log("No rows.");
      return;
    }
    for (const row of rows) console.log(formatRow(row));
    return;
  }
  console.log(formatRow(value));
}

function formatRow(value: unknown) {
  if (!value || typeof value !== "object") return String(value);
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v != null && v !== "");
  return entries
    .map(([key, val]) => {
      const shown = typeof val === "object" ? JSON.stringify(val) : String(val);
      return `${key}: ${shown}`;
    })
    .join("  ");
}

export function fail(error: unknown): never {
  const message = error instanceof Error ? error.message : "Command failed";
  console.error(message);
  process.exit(1);
}
