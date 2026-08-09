const ACTIONS = new Set([
  "joinAsStudent", "loginAsAdmin", "getState", "pickCell", "submitAnswer", "cancelPick",
  "adminNewGame", "adminNextTurn", "adminEndGame", "adminKick", "adminPeekCell",
  "adminGetConfig", "adminSaveConfig",
  "adminGetLog", "adminRestore", "adminDiagnose", "adminRepair",
  "clientLog",
]);

const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

function json(value: object, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { ...SECURITY_HEADERS, "cache-control": "no-store" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (request.method !== "POST") return json({ ok: false, error: "POST 요청만 허용됩니다." }, 405);

    const action = decodeURIComponent(url.pathname.slice(5));
    if (!ACTIONS.has(action)) return json({ ok: false, error: "허용되지 않은 작업입니다." }, 404);
    const length = Number(request.headers.get("content-length") || "0");
    if (length > 32768) return json({ ok: false, error: "요청이 너무 큽니다." }, 413);

    let payload: unknown;
    try { payload = await request.json(); }
    catch { return json({ ok: false, error: "JSON 요청이 필요합니다." }, 400); }
    if (!isRecord(payload)) return json({ ok: false, error: "요청 형식이 올바르지 않습니다." }, 400);

    try {
      const upstream = await fetch(env.APPS_SCRIPT_URL, {
        method: "POST",
        redirect: "follow",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret: env.APPS_SCRIPT_SECRET, action, payload }),
        signal: AbortSignal.timeout(15000),
      });
      if (!upstream.ok) throw new Error(`upstream ${upstream.status}`);
      return new Response(upstream.body, {
        status: 200,
        headers: { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      });
    } catch (error) {
      console.error(JSON.stringify({ event: "apps_script_proxy_error", action, message: error instanceof Error ? error.message : String(error) }));
      return json({ ok: false, error: "데이터베이스 서버에 연결할 수 없습니다." }, 502);
    }
  },
} satisfies ExportedHandler<Env>;
