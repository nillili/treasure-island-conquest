/**
 * 선생님 계정 — Neobus 로 들어온다.
 *
 * 이 앱에는 가입도 비밀번호도 없다. 누가 선생님인지는 Neobus 가 정하고, 이 앱은 그것을
 * 매번 되물어 확인만 한다. 그래서 Neobus 에서 승인이 취소되거나 계정 유형이 바뀌면
 * 다음 확인에서 그대로 막힌다 — 이 앱에 따로 지워 줄 명단이 없다.
 *
 * 세션 토큰은 HttpOnly 쿠키로만 오간다. 화면 JS 는 이 값을 읽지 않고, 읽을 필요도 없다.
 * WebSocket 업그레이드 요청에도 브라우저가 알아서 실어 보내므로 거기서 확인한다.
 */
import { fail, json } from "./http";
import {
  exchangeCode,
  fetchLinkedUser,
  isNeobusUser,
  judge,
  randomBase64Url,
  revokeLinkToken,
  s256Challenge,
  sha256Hex,
  timingSafeEqual,
} from "./neobus";
import { seedSampleQuiz } from "./quizsets";
import { sweepOldRecords, sweepStaleRooms } from "./sweep";

const COOKIE = "tsession";
const TX_COOKIE = "tlogin";
const SESSION_MS = 8 * 60 * 60 * 1000; // 하루 수업을 덮되, Neobus 토큰 만료를 넘지 않는다
const TX_MS = 10 * 60 * 1000; // Neobus 로그인 화면에서 아이디·비밀번호를 치는 시간
/**
 * Neobus 에 다시 물어보는 간격.
 *
 * 매 요청마다 물으면 선생님 화면의 버튼 하나가 Neobus 왕복 한 번이 된다. 그렇다고 세션
 * 수명 내내 안 물으면 승인 취소가 8시간 늦게 반영된다. 30초는 그 사이의 값이고,
 * 조용한 WebSocket 을 확인하는 주기와 같은 값이다(계획 문서 5-5).
 */
const RECHECK_MS = 30 * 1000;

export interface Teacher {
  id: string;
  displayName: string;
}

/** 확인 결과. `temp` 는 "자격이 없다" 가 아니라 "지금 Neobus 에 못 물었다" 이다. */
export type Verdict =
  | { ok: true; teacherId: string; isSuper: boolean }
  | { ok: false; reason: "no-session" | "temp" };

/** 선생님 세션 쿠키가 붙어 있기라도 한가. 값이 맞는지는 보지 않는다. */
export function hasSessionCookie(request: Request): boolean {
  return readCookie(request, COOKIE) !== null;
}

export function sessionHashOf(request: Request): Promise<string> | null {
  const token = readCookie(request, COOKIE);
  return token ? sha256Hex(token) : null;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function buildCookie(
  request: Request,
  name: string,
  value: string,
  maxAgeSec: number,
  path: string,
): string {
  // 로컬 개발은 http 다. 여기에 Secure 를 붙이면 쿠키가 아예 저장되지 않아
  // "로그인이 안 된다"로 보인다. https 일 때만 붙인다.
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${name}=${value}; HttpOnly; SameSite=Lax; Path=${path}; Max-Age=${maxAgeSec}${secure}`;
}

async function dropSession(env: Env, tokenHash: string): Promise<void> {
  await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
}

/**
 * 쿠키의 세션이 살아 있고, 그 사람이 지금도 Neobus 의 승인된 선생님인가.
 *
 * 30초 안에 이미 물어봤으면 다시 묻지 않는다. 그 사이에는 DB 의 값을 믿는다.
 */
export async function verifyTeacher(request: Request, env: Env): Promise<Verdict> {
  const token = readCookie(request, COOKIE);
  if (!token) return { ok: false, reason: "no-session" };
  return verifySessionHash(env, await sha256Hex(token));
}

/**
 * 쿠키 없이, 세션 해시만으로 같은 확인을 한다.
 *
 * 방 DO 가 쓴다. DO 는 브라우저 쿠키를 다시 받지 않고, Worker 가 업그레이드 때 넘겨 준
 * 해시만 들고 있다. 바깥에서 보낸 헤더는 Worker 가 덮어쓰므로 조작할 수 없다.
 */
export async function verifySessionHash(env: Env, tokenHash: string | null): Promise<Verdict> {
  if (!tokenHash) return { ok: false, reason: "no-session" };

  const row = await env.DB.prepare(
    `SELECT s.teacher_id, s.link_token, s.expires_at, s.verified_at,
            t.is_super, t.neobus_origin, t.neobus_user_id
       FROM sessions s JOIN teachers t ON t.id = s.teacher_id
      WHERE s.token_hash = ?`,
  )
    .bind(tokenHash)
    .first<{
      teacher_id: string;
      link_token: string;
      expires_at: number;
      verified_at: number;
      is_super: number;
      neobus_origin: string;
      neobus_user_id: string;
    }>();

  const now = Date.now();
  if (!row) return { ok: false, reason: "no-session" };
  if (row.expires_at < now) {
    await dropSession(env, tokenHash);
    return { ok: false, reason: "no-session" };
  }
  if (now - row.verified_at < RECHECK_MS) {
    return { ok: true, teacherId: row.teacher_id, isSuper: !!row.is_super };
  }

  const who = await fetchLinkedUser(env, row.link_token);
  if (!who.ok) {
    // 잠깐 안 되는 것과 자격이 없어진 것은 다르다. 앞엣것으로 세션을 지우지 않는다.
    if (who.kind === "temp") return { ok: false, reason: "temp" };
    await dropSession(env, tokenHash);
    return { ok: false, reason: "no-session" };
  }
  if (!isNeobusUser(who.data)) return { ok: false, reason: "temp" };

  // 같은 토큰인데 다른 사람이 나오면 그 세션은 믿을 수 없다.
  if (String(who.data.user_id) !== row.neobus_user_id || env.NEOBUS_ORIGIN !== row.neobus_origin) {
    await dropSession(env, tokenHash);
    return { ok: false, reason: "no-session" };
  }

  const verdict = judge(who.data);
  if (!verdict.teacher) {
    await dropSession(env, tokenHash);
    return { ok: false, reason: "no-session" };
  }

  // 이름과 관리자 여부는 Neobus 가 정본이다. 바뀌었으면 여기서 따라간다.
  await env.DB.batch([
    env.DB
      .prepare("UPDATE teachers SET display_name = ?, is_super = ? WHERE id = ?")
      .bind(who.data.name, verdict.isSuper ? 1 : 0, row.teacher_id),
    env.DB.prepare("UPDATE sessions SET verified_at = ? WHERE token_hash = ?").bind(now, tokenHash),
  ]);
  return { ok: true, teacherId: row.teacher_id, isSuper: verdict.isSuper };
}

/** 쿠키의 세션이 살아 있으면 선생님 아이디, 아니면 null. */
export async function teacherFromCookie(request: Request, env: Env): Promise<string | null> {
  const verdict = await verifyTeacher(request, env);
  return verdict.ok ? verdict.teacherId : null;
}

function notTeacher(reason: "no-session" | "temp"): Response {
  return reason === "temp"
    ? fail("네오버스에 연결하지 못했습니다. 잠시 뒤 다시 해 주세요.", 503, "neobus-down")
    : fail("선생님 로그인이 필요합니다.", 401, "no-session");
}

/** 로그인한 선생님만 지나갈 수 있는 문. 통과하면 아이디, 아니면 401·503 응답. */
export async function requireTeacher(request: Request, env: Env): Promise<string | Response> {
  const verdict = await verifyTeacher(request, env);
  return verdict.ok ? verdict.teacherId : notTeacher(verdict.reason);
}

/**
 * 슈퍼관리자만 지나갈 수 있는 문.
 *
 * 로그인하지 않은 사람과 권한이 없는 선생님을 굳이 갈라서 알려 주지 않는다.
 * 관제 화면이 있다는 사실 자체가 보통 선생님에게 드러날 이유가 없다.
 *
 * 관리자 여부는 Neobus 의 `admin` 에서 온다. 이 앱에 따로 손으로 적는 명단이 없고,
 * Neobus 에서 내려가면 다음 확인(최대 30초)에 이 문도 닫힌다.
 */
export async function requireSuper(request: Request, env: Env): Promise<string | Response> {
  const verdict = await verifyTeacher(request, env);
  if (!verdict.ok) return notTeacher(verdict.reason);
  if (!verdict.isSuper) return fail("없는 주소입니다.", 404);
  return verdict.teacherId;
}

/** 로그인·로그아웃 때 함께 치우는 것들. 상주하는 데몬이 없어서 여기가 유일한 기회다. */
async function sweepAuth(env: Env): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM login_tx WHERE expires_at < ?").bind(now),
    // 원래 만료 시각이 지난 것은 Neobus 가 알아서 만료시킨다. 더 부를 이유가 없다.
    env.DB.prepare("DELETE FROM revoke_queue WHERE expires_at < ?").bind(now),
  ]);
}

/**
 * 못 지운 Neobus 토큰을 다시 지운다. 한 번에 다섯 개까지만 — 로그인이 느려지면 안 된다.
 * 실패하면 기다리는 시간을 두 배로 늘린다(1분 → 2분 → 4분 …).
 */
async function retryRevokes(env: Env): Promise<void> {
  const now = Date.now();
  const due = await env.DB.prepare(
    "SELECT id, link_token FROM revoke_queue WHERE next_try_at <= ? AND origin = ? LIMIT 5",
  )
    .bind(now, env.NEOBUS_ORIGIN)
    .all<{ id: number; link_token: string }>();
  for (const item of due.results ?? []) {
    const done = await revokeLinkToken(env, item.link_token);
    if (done.ok) {
      await env.DB.prepare("DELETE FROM revoke_queue WHERE id = ?").bind(item.id).run();
    } else {
      await env.DB
        .prepare(
          "UPDATE revoke_queue SET tries = tries + 1, next_try_at = ? + (60000 << MIN(tries, 6)) WHERE id = ?",
        )
        .bind(now, item.id)
        .run();
    }
  }
}

/** 오류 화면. 무엇이 잘못됐는지와 다시 들어가는 문만 있으면 된다. */
function errorPage(message: string, status: number, extraCookies: string[] = []): Response {
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "private, no-store",
  });
  for (const cookie of extraCookies) headers.append("set-cookie", cookie);
  const safe = message.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  return new Response(
    `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>보물섬 점령전 — 로그인</title>
<style>
 body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f172a;color:#e2e8f0;
      font-family:system-ui,-apple-system,"Noto Sans KR",sans-serif}
 .box{max-width:26rem;padding:2rem;text-align:center}
 h1{font-size:1.2rem;margin:0 0 .75rem}
 p{margin:0 0 1.5rem;color:#94a3b8;line-height:1.6}
 a{display:inline-block;padding:.7rem 1.4rem;border-radius:.5rem;background:#38bdf8;color:#0f172a;
   font-weight:700;text-decoration:none}
</style></head><body><div class="box">
<h1>들어가지 못했습니다</h1><p>${safe}</p><a href="/auth/start">네오버스로 다시 로그인</a>
</div></body></html>`,
    { status, headers },
  );
}

/**
 * 이 Neobus 사용자에 해당하는 이 앱의 선생님. 없으면 만든다.
 *
 * 같은 사람이 두 탭에서 동시에 처음 들어와도 프로필은 하나여야 한다. UNIQUE 인덱스에
 * 맡기고, 내가 만든 경우에만 샘플 퀴즈를 넣는다. 매번 넣으면 로그인할 때마다 늘어난다.
 */
async function upsertTeacher(
  env: Env,
  neobusUserId: string,
  name: string,
  isSuper: boolean,
): Promise<string> {
  const now = Date.now();
  const made = await env.DB
    .prepare(
      `INSERT INTO teachers (id, display_name, is_super, created_at, last_login_at,
                             neobus_origin, neobus_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (neobus_origin, neobus_user_id) DO NOTHING`,
    )
    .bind(crypto.randomUUID(), name, isSuper ? 1 : 0, now, now, env.NEOBUS_ORIGIN, neobusUserId)
    .run();

  const row = await env.DB
    .prepare("SELECT id FROM teachers WHERE neobus_origin = ? AND neobus_user_id = ?")
    .bind(env.NEOBUS_ORIGIN, neobusUserId)
    .first<{ id: string }>();
  const teacherId = row!.id;

  if (made.meta.changes) {
    // 처음부터 보관함이 비어 있으면 뭘 해야 할지 알 수 없다.
    await seedSampleQuiz(env, teacherId);
  } else {
    await env.DB
      .prepare("UPDATE teachers SET display_name = ?, is_super = ?, last_login_at = ? WHERE id = ?")
      .bind(name, isSuper ? 1 : 0, now, teacherId)
      .run();
  }
  return teacherId;
}

/**
 * 브라우저가 지나가는 로그인 경로. `/auth/start` 와 `/auth/callback` 두 개뿐이다.
 *
 * 이 경로들은 JSON 이 아니라 이동(302)과 화면으로 답한다. 주소창에 인증 값이 남지 않도록
 * 끝에는 query 가 없는 주소로 보낸다.
 */
export async function handleAuthPages(request: Request, env: Env, path: string): Promise<Response> {
  if (request.method !== "GET") return fail("GET 으로 들어와 주세요.", 405);

  if (path === "/auth/start") {
    if (!env.NEOBUS_ORIGIN || !env.MERGE_CLIENT_ID || !env.MERGE_REDIRECT_URI) {
      return errorPage("네오버스 연결이 아직 설정되지 않았습니다. 관리자에게 알려 주세요.", 503);
    }
    const now = Date.now();
    const txId = randomBase64Url(16);
    const state = randomBase64Url(24);
    const verifier = randomBase64Url(48);
    await env.DB
      .prepare("INSERT INTO login_tx (id, state, verifier, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .bind(txId, state, verifier, now, now + TX_MS)
      .run();

    const authorize = new URL("/merge/authorize", env.NEOBUS_ORIGIN);
    authorize.searchParams.set("client_id", env.MERGE_CLIENT_ID);
    authorize.searchParams.set("redirect_uri", env.MERGE_REDIRECT_URI);
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("code_challenge", await s256Challenge(verifier));
    authorize.searchParams.set("code_challenge_method", "S256");

    return new Response(null, {
      status: 302,
      headers: {
        location: authorize.toString(),
        "set-cookie": buildCookie(request, TX_COOKIE, txId, TX_MS / 1000, "/auth"),
        "cache-control": "private, no-store",
      },
    });
  }

  if (path === "/auth/callback") {
    const url = new URL(request.url);
    const code = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? "";
    const txId = readCookie(request, TX_COOKIE);
    // 로그인 중 쿠키는 성공·실패와 무관하게 한 번 쓰면 버린다.
    const clearTx = buildCookie(request, TX_COOKIE, "", 0, "/auth");

    if (!txId || !code || !state) {
      return errorPage("연결 요청이 올바르지 않습니다.", 400, [clearTx]);
    }

    // 꺼내면서 지운다. 뒤로 가기로 같은 주소에 다시 들어와도 두 번째는 꺼낼 것이 없다.
    const tx = await env.DB
      .prepare("DELETE FROM login_tx WHERE id = ? RETURNING state, verifier, expires_at")
      .bind(txId)
      .first<{ state: string; verifier: string; expires_at: number }>();
    if (!tx || tx.expires_at < Date.now() || !timingSafeEqual(tx.state, state)) {
      return errorPage("연결 요청이 만료되었거나 올바르지 않습니다. 다시 로그인해 주세요.", 400, [clearTx]);
    }

    const exchanged = await exchangeCode(env, { code, codeVerifier: tx.verifier });
    if (!exchanged.ok) {
      return errorPage("네오버스와 연결하지 못했습니다. 잠시 뒤 다시 해 주세요.", 502, [clearTx]);
    }
    const linkToken = exchanged.data.link_token;

    const who = await fetchLinkedUser(env, linkToken);
    if (!who.ok || !isNeobusUser(who.data)) {
      // 받아 둔 토큰을 그대로 버려두지 않는다.
      await revokeLinkToken(env, linkToken);
      return errorPage("계정 정보를 확인하지 못했습니다. 잠시 뒤 다시 해 주세요.", 502, [clearTx]);
    }

    const verdict = judge(who.data);
    if (!verdict.teacher) {
      await revokeLinkToken(env, linkToken);
      return errorPage(
        "선생님 계정만 들어올 수 있습니다. 네오버스에서 선생님 승인을 받은 뒤 다시 해 주세요.",
        403,
        [clearTx],
      );
    }

    const teacherId = await upsertTeacher(env, String(who.data.user_id), who.data.name, verdict.isSuper);

    const now = Date.now();
    const token = randomBase64Url(24);
    const remoteMs = Number(exchanged.data.expires_in) * 1000;
    // 이 앱의 세션이 Neobus 토큰보다 오래 살면 안 된다. 짧은 쪽을 쓴다.
    const life = Number.isFinite(remoteMs) && remoteMs > 0 ? Math.min(SESSION_MS, remoteMs) : SESSION_MS;
    await env.DB
      .prepare(
        `INSERT INTO sessions (token_hash, teacher_id, link_token, created_at, expires_at, verified_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(await sha256Hex(token), teacherId, linkToken, now, now + life, now)
      .run();

    await sweepAuth(env);
    await retryRevokes(env);
    // 어제 방과 두 달 지난 기록도 여기서 함께 걷는다. 로그인 때만 돈다.
    await sweepStaleRooms(env);
    await sweepOldRecords(env);

    const headers = new Headers({ location: "/?teacher=1", "cache-control": "private, no-store" });
    headers.append("set-cookie", clearTx);
    headers.append("set-cookie", buildCookie(request, COOKIE, token, Math.floor(life / 1000), "/"));
    return new Response(null, { status: 302, headers });
  }

  return fail("없는 주소입니다.", 404);
}

export async function handleAuth(request: Request, env: Env, path: string): Promise<Response> {
  if (path === "/api/auth/me") {
    const verdict = await verifyTeacher(request, env);
    if (!verdict.ok) {
      return verdict.reason === "temp"
        ? fail("네오버스에 연결하지 못했습니다. 잠시 뒤 다시 해 주세요.", 503, "neobus-down")
        : fail("로그인되어 있지 않습니다.", 401, "no-session");
    }
    const row = await env.DB.prepare("SELECT id, display_name, is_super FROM teachers WHERE id = ?")
      .bind(verdict.teacherId)
      .first<{ id: string; display_name: string; is_super: number }>();
    if (!row) return fail("로그인되어 있지 않습니다.", 401, "no-session");
    return json({ ok: true, id: row.id, name: row.display_name, isSuper: !!row.is_super });
  }

  if (request.method !== "POST") return fail("POST 로 보내 주세요.", 405);

  if (path === "/api/auth/logout") {
    const token = readCookie(request, COOKIE);
    if (token) {
      const tokenHash = await sha256Hex(token);
      // 이 앱의 권한은 Neobus 응답을 기다리지 않고 그 자리에서 없앤다.
      const gone = await env.DB
        .prepare("DELETE FROM sessions WHERE token_hash = ? RETURNING link_token, expires_at")
        .bind(tokenHash)
        .first<{ link_token: string; expires_at: number }>();
      if (gone) {
        const done = await revokeLinkToken(env, gone.link_token);
        if (!done.ok) {
          // 못 지웠으면 적어 두고 다음 로그인 때 다시 지운다.
          await env.DB
            .prepare(
              "INSERT INTO revoke_queue (link_token, origin, next_try_at, expires_at) VALUES (?, ?, ?, ?)",
            )
            .bind(gone.link_token, env.NEOBUS_ORIGIN, Date.now() + 60_000, gone.expires_at)
            .run();
        }
      }
    }
    return json({ ok: true }, 200, { "set-cookie": buildCookie(request, COOKIE, "", 0, "/") });
  }

  // 자체 가입·비밀번호는 2026-09-23 에 없앴다. 주소만 남겨 두고 무엇이 바뀌었는지 알려 준다.
  if (path === "/api/auth/signup" || path === "/api/auth/login") {
    return fail("이제 네오버스에서 로그인합니다. 네오버스로 들어와 주세요.", 410, "sso-only");
  }

  return fail("없는 주소입니다.", 404);
}
