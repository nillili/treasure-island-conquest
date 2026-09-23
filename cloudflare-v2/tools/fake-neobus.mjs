/**
 * 로컬 개발용 가짜 네오버스.
 *
 *   node tools/fake-neobus.mjs            (8798 포트)
 *   node tools/fake-neobus.mjs --port 9000
 *
 * 진짜 네오버스는 학교 쪽 서버다. 로컬에서 선생님으로 들어가 보려면 그 자리를 대신할
 * 무언가가 필요하다. 이 서버는 실제 네오버스와 **같은 계약**만 지킨다.
 *
 *   GET  /merge/authorize          → 확인 화면 없이 바로 되돌려보낸다
 *   POST /api/merge-auth/token     → 인가 코드를 연결 토큰으로 바꾼다
 *   GET  /api/merge-auth/me        → 연결 토큰의 사용자
 *   POST /api/merge-auth/revoke    → 폐기
 *
 * 사용자는 코드 안에 실려 다닌다. 그래서 이 서버는 아무것도 저장하지 않는다.
 * 누구로 들어갈지는 주소로 정한다:
 *
 *   /merge/authorize?...&who=admin       → 최고관리자로 들어간다
 *   /merge/authorize?...&who=학생        → 거절당하는 것을 확인할 수 있다
 *
 * 이 서버는 개발용이다. 실서버 설정(NEOBUS_ORIGIN)에 절대 넣지 않는다.
 */
import { createServer } from "node:http";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const PORT = Number(arg("port", 8798));

/** who 한 글자로 사람을 만든다. 아무것도 안 적으면 보통 선생님이다. */
function userFor(who) {
  const 유형 = { admin: "admin", school: "school_admin", 학생: "학생", pending: "선생님" };
  return {
    user_id: 1,
    login_id: who || "kim",
    name: who === "admin" ? "운영자" : "김선생",
    user_type: 유형[who] ?? "선생님",
    approval_status: who === "pending" ? "pending" : "approved",
  };
}

const send = (res, status, body, headers = {}) => {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": typeof body === "string" ? "text/html; charset=utf-8" : "application/json",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(text);
};
const ok = (res, data) => send(res, 200, { success: true, data });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname === "/merge/authorize") {
    const back = url.searchParams.get("redirect_uri");
    const state = url.searchParams.get("state");
    if (!back || !state) return send(res, 400, "redirect_uri 와 state 가 필요합니다.");
    const user = userFor(url.searchParams.get("who") ?? "");
    const code = "code:" + encodeURIComponent(JSON.stringify(user));
    const to = new URL(back);
    to.searchParams.set("code", code);
    to.searchParams.set("state", state);
    return send(res, 302, "", { location: to.toString() });
  }

  if (url.pathname === "/api/merge-auth/token" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body || "{}");
    const code = String(parsed.code ?? "");
    if (!code.startsWith("code:")) return send(res, 400, { success: false, error: "invalid_grant" });
    return ok(res, { link_token: "tok:" + code.slice(5), expires_at: "", expires_in: 8 * 60 * 60 });
  }

  if (url.pathname === "/api/merge-auth/me") {
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!token.startsWith("tok:")) return send(res, 401, { success: false });
    return ok(res, JSON.parse(decodeURIComponent(token.slice(4))));
  }

  if (url.pathname === "/api/merge-auth/revoke") return send(res, 200, { success: true }); // 실제와 같이 data 없음

  return send(res, 404, { success: false });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`가짜 네오버스가 http://127.0.0.1:${PORT} 에서 돕니다.`);
  console.log(`.dev.vars 나 wrangler.jsonc 의 NEOBUS_ORIGIN 을 이 주소로 두면 로컬에서 로그인됩니다.`);
});
