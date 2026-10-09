export class CustaraError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export async function apiRequest(input: {
  baseUrl: string;
  token: string;
  path: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}) {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(input.token ? { Authorization: `Bearer ${input.token}` } : {}),
    ...(input.headers || {}),
  };
  let body: string | undefined;
  if (input.body !== undefined) {
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
    body = JSON.stringify(input.body);
  }
  const res = await fetch(`${input.baseUrl}${input.path}`, {
    method: input.method || (body ? "POST" : "GET"),
    headers,
    body,
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { error: text };
  }
  if (!res.ok) {
    const message =
      parsed && typeof parsed === "object" && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new CustaraError(message, res.status, parsed);
  }
  return parsed;
}
