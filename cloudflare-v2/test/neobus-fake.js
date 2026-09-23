/**
 * 시험용 가짜 네오버스.
 *
 * 테스트 워커가 바깥으로 보내는 fetch 는 전부 여기로 온다(miniflare outboundService).
 * 상태를 들고 있지 않다 — 사용자를 인가 코드 안에 실어 보내고, 여기서는 그것을 되읽어
 * 그대로 답한다. 그래서 테스트끼리 서로의 사용자를 밟지 않는다.
 *
 *   코드      "code:" + encodeURIComponent(JSON.stringify(사용자))
 *   연결토큰  "tok:"  + 같은 값
 *
 * 특별한 값 두 개로 고장을 흉내 낸다.
 *   tok:down     → 503 (네오버스가 잠깐 안 됨)
 *   tok:revoked  → 401 (연결이 끊김 · 로그아웃)
 */
const ok = (data) => Response.json({ success: true, data });

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/api/merge-auth/token") {
      const body = await request.json();
      const code = String(body.code ?? "");
      if (!body.client_id || !body.client_secret || !body.redirect_uri || !body.code_verifier) {
        return Response.json({ success: false, error: "invalid_request" }, { status: 400 });
      }
      if (!code.startsWith("code:")) {
        return Response.json({ success: false, error: "invalid_grant" }, { status: 400 });
      }
      return ok({ link_token: "tok:" + code.slice(5), expires_at: "", expires_in: 8 * 60 * 60 });
    }

    if (url.pathname === "/api/merge-auth/me") {
      const token = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      if (!token.startsWith("tok:")) return Response.json({ success: false }, { status: 401 });
      const who = token.slice(4);
      if (who === "revoked") return Response.json({ success: false }, { status: 401 });
      if (who === "down") return new Response("잠깐 안 됩니다", { status: 503 });
      return ok(JSON.parse(decodeURIComponent(who)));
    }

    // 실제 네오버스는 여기서 data 없이 { success: true } 만 준다. 똑같이 한다 —
    // 2026-09-24 에 이 차이를 가짜가 감춰서 "revoke 가 늘 실패로 분류되는" 버그를 놓쳤다.
    if (url.pathname === "/api/merge-auth/revoke") return Response.json({ success: true });

    return new Response("없는 주소", { status: 404 });
  },
};
