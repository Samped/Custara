/** Cursor pagination helper for partner APIs. */
export function parseCursorPagination(url: URL, defaults?: { limit?: number; max?: number }) {
  const limitDefault = defaults?.limit ?? 50;
  const max = defaults?.max ?? 200;
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || limitDefault), 1), max);
  const cursor = url.searchParams.get("cursor") || undefined;
  return { limit, cursor };
}

export function pageResult<T extends { id: string }>(rows: T[], limit: number) {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  return {
    data,
    next_cursor: hasMore ? data[data.length - 1]?.id ?? null : null,
  };
}
