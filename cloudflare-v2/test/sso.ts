/**
 * 테스트가 선생님으로 들어가는 길.
 *
 * 실제와 같은 길을 지난다 — /auth/start 로 시작해 네오버스(가짜)를 거쳐 /auth/callback 으로
 * 돌아온다. 운영에 테스트용 로그인 우회를 만들지 않기 위해서다.
 */
import { SELF } from "cloudflare:test";

export const BASE = "https://t.test";

export interface FakeUser {
  user_id: number;
  login_id: string;
  name: string;
  user_type: string;
  approval_status: string;
}

/** 승인된 보통 선생님 하나. 바꾸고 싶은 값만 넘긴다. */
export function fakeTeacher(over: Partial<FakeUser> = {}): FakeUser {
  return {
    user_id: 1,
    login_id: "kim",
    name: "김선생",
    user_type: "선생님",
    approval_status: "approved",
    ...over,
  };
}

/** 가짜 네오버스가 알아보는 인가 코드. 사용자를 코드 안에 실어 보낸다. */
export function codeFor(user: FakeUser): string {
  return "code:" + encodeURIComponent(JSON.stringify(user));
}

function cookieNamed(res: Response, name: string): string {
  for (const raw of res.headers.getSetCookie()) {
    const head = raw.split(";")[0] ?? "";
    if (head.startsWith(`${name}=`)) return head;
  }
  return "";
}

export interface LoginResult {
  res: Response;
  /** 성공했으면 `tsession=...`, 아니면 빈 문자열. */
  cookie: string;
}

/** 로그인 한 번. 실패도 그대로 돌려준다 — 거절을 확인하는 테스트가 쓴다. */
export async function login(user: FakeUser | string): Promise<LoginResult> {
  const start = await SELF.fetch(`${BASE}/auth/start`, { redirect: "manual" });
  const tx = cookieNamed(start, "tlogin");
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const code = typeof user === "string" ? user : codeFor(user);
  const res = await SELF.fetch(
    `${BASE}/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    { headers: { cookie: tx }, redirect: "manual" },
  );
  return { res, cookie: cookieNamed(res, "tsession") };
}

/** 준비 단계로 쓰는 로그인. 여기서 실패하면 바로 알려 준다 — 안 그러면 뒤에서 401 로만 보인다. */
export async function loginOk(user: FakeUser = fakeTeacher()): Promise<string> {
  const { res, cookie } = await login(user);
  if (!cookie) throw new Error(`로그인 실패(${res.status}): ${await res.text()}`);
  return cookie;
}

/** 서로 다른 선생님이 필요할 때. 번호만 다르면 다른 사람이다. */
export function otherTeacher(n: number, name = `선생${n}`): FakeUser {
  return fakeTeacher({ user_id: n, login_id: `t${n}`, name });
}

// ── 옛 시험 코드가 쓰던 별명 ────────────────────────────────────────────────
// 예전에는 선생님을 "owner1" 처럼 아이디 문자열로 만들었다. 이제 아이디는 네오버스가 주는
// 번호에서 나오므로, 별명을 번호 하나에 대응시켜 그 시험들을 그대로 살려 둔다.
const aliases = new Map<string, number>();

export function userNamed(alias: string, name = "선생"): FakeUser {
  if (!aliases.has(alias)) aliases.set(alias, aliases.size + 1);
  return fakeTeacher({ user_id: aliases.get(alias)!, login_id: alias, name });
}

/** 별명으로 로그인. 같은 별명은 언제나 같은 사람이다. */
export function loginAs(alias: string, name?: string): Promise<string> {
  return loginOk(userNamed(alias, name));
}

/** 그 별명이 이 앱 안에서 받은 실제 선생님 id(UUID). */
export async function idOf(alias: string): Promise<string> {
  const { env } = await import("cloudflare:test");
  const row = await env.DB.prepare("SELECT id FROM teachers WHERE neobus_user_id = ?")
    .bind(String(userNamed(alias).user_id))
    .first<{ id: string }>();
  if (!row) throw new Error(`${alias} 선생님이 아직 들어오지 않았습니다.`);
  return row.id;
}
