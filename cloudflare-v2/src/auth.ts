/**
 * 선생님 계정 — 가입 · 로그인 · 세션.
 *
 * 세션 토큰은 HttpOnly 쿠키로만 오간다. 화면 JS 는 이 값을 읽지 않고, 읽을 필요도 없다.
 * WebSocket 업그레이드 요청에도 브라우저가 알아서 실어 보내므로 거기서 확인한다
 * (docs/plan_DB로전환_v3.md 2-6).
 */
import { fail, json, readJson, str } from "./http";
import { seedSampleQuiz } from "./quizsets";

const COOKIE = "tsession";
const SESSION_MS = 12 * 60 * 60 * 1000; // 12시간 — 하루 수업을 덮는다
const ID_RE = /^[A-Za-z0-9]{4,20}$/;

export interface Teacher {
  id: string;
  displayName: string;
}

async function hashPassword(password: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: new TextEncoder().encode(salt), iterations: 100_000, hash: "SHA-256" },
    key,
    256,
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
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

function sessionCookie(request: Request, token: string, maxAgeSec: number): string {
  // 로컬 개발은 http 다. 여기에 Secure 를 붙이면 쿠키가 아예 저장되지 않아
  // "로그인이 안 된다"로 보인다. https 일 때만 붙인다.
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${secure}`;
}

/** 쿠키의 세션이 살아 있으면 선생님 아이디, 아니면 null. */
export async function teacherFromCookie(request: Request, env: Env): Promise<string | null> {
  const token = readCookie(request, COOKIE);
  if (!token) return null;
  const row = await env.DB.prepare("SELECT teacher_id, expires_at FROM sessions WHERE token = ?")
    .bind(token)
    .first<{ teacher_id: string; expires_at: number }>();
  if (!row || row.expires_at < Date.now()) return null;
  return row.teacher_id;
}

/** 로그인한 선생님만 지나갈 수 있는 문. 통과하면 아이디, 아니면 401 응답. */
export async function requireTeacher(request: Request, env: Env): Promise<string | Response> {
  const teacherId = await teacherFromCookie(request, env);
  return teacherId ?? fail("선생님 로그인이 필요합니다.", 401, "no-session");
}

async function startSession(request: Request, env: Env, teacherId: string): Promise<Response> {
  const now = Date.now();
  const token = crypto.randomUUID();
  await env.DB.batch([
    // 만료된 세션은 로그인할 때마다 함께 치운다. 따로 도는 정리 작업이 필요 없다.
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
    env.DB.prepare(
      "INSERT INTO sessions (token, teacher_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    ).bind(token, teacherId, now, now + SESSION_MS),
    env.DB.prepare("UPDATE teachers SET last_login_at = ? WHERE id = ?").bind(now, teacherId),
  ]);
  const teacher = await env.DB.prepare("SELECT id, display_name FROM teachers WHERE id = ?")
    .bind(teacherId)
    .first<{ id: string; display_name: string }>();
  return json(
    { ok: true, id: teacher!.id, name: teacher!.display_name },
    200,
    { "set-cookie": sessionCookie(request, token, SESSION_MS / 1000) },
  );
}

export async function handleAuth(request: Request, env: Env, path: string): Promise<Response> {
  if (path === "/api/auth/me") {
    const teacherId = await teacherFromCookie(request, env);
    if (!teacherId) return fail("로그인되어 있지 않습니다.", 401, "no-session");
    const row = await env.DB.prepare("SELECT id, display_name FROM teachers WHERE id = ?")
      .bind(teacherId)
      .first<{ id: string; display_name: string }>();
    if (!row) return fail("로그인되어 있지 않습니다.", 401, "no-session");
    return json({ ok: true, id: row.id, name: row.display_name });
  }

  if (request.method !== "POST") return fail("POST 로 보내 주세요.", 405);

  if (path === "/api/auth/logout") {
    const token = readCookie(request, COOKIE);
    if (token) await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
    return json({ ok: true }, 200, { "set-cookie": sessionCookie(request, "", 0) });
  }

  const body = await readJson(request);
  if (!body) return fail("요청 형식이 올바르지 않습니다.");

  if (path === "/api/auth/signup") {
    if (str(body.code) !== env.SIGNUP_CODE) return fail("가입 코드가 맞지 않습니다.", 403);

    const id = str(body.id);
    const name = str(body.name);
    const password = typeof body.password === "string" ? body.password : "";
    if (!ID_RE.test(id)) return fail("아이디는 영문·숫자 4~20자로 지어 주세요.");
    if (!name || name.length > 20) return fail("이름은 1~20자로 적어 주세요.");
    if (password.length < 4) return fail("비밀번호는 4자 이상으로 정해 주세요.");

    const salt = crypto.randomUUID();
    const hash = await hashPassword(password, salt);
    const now = Date.now();
    try {
      await env.DB.prepare(
        "INSERT INTO teachers (id, display_name, pw_salt, pw_hash, created_at) VALUES (?, ?, ?, ?, ?)",
      )
        .bind(id, name, salt, hash, now)
        .run();
    } catch {
      return fail("이미 있는 아이디입니다. 다른 아이디를 지어 주세요.", 409, "duplicate-id");
    }
    await seedSampleQuiz(env, id); // 처음부터 보관함이 비어 있으면 뭘 해야 할지 알 수 없다
    return startSession(request, env, id);
  }

  if (path === "/api/auth/login") {
    const id = str(body.id);
    const password = typeof body.password === "string" ? body.password : "";
    const row = await env.DB.prepare("SELECT id, pw_salt, pw_hash FROM teachers WHERE id = ?")
      .bind(id)
      .first<{ id: string; pw_salt: string; pw_hash: string }>();
    if (!row) return fail("아이디 또는 비밀번호가 맞지 않습니다.", 401);
    if ((await hashPassword(password, row.pw_salt)) !== row.pw_hash) {
      return fail("아이디 또는 비밀번호가 맞지 않습니다.", 401);
    }
    return startSession(request, env, row.id);
  }

  return fail("없는 주소입니다.", 404);
}
