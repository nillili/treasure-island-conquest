export function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store", ...headers } });
}

export function fail(message: string, status = 400, code?: string): Response {
  return json({ ok: false, error: message, code }, status);
}

/** 본문이 JSON 이 아니면 null. 호출한 쪽이 안내 문구를 정한다. */
export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
