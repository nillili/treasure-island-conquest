/**
 * Neobus 연결 인증 — PKCE 도구와 서버 간 호출.
 *
 * 이 파일만 Neobus 를 부른다. 브라우저는 여기에 나오는 값(client_secret · code_verifier ·
 * link_token)을 한 번도 보지 못한다. 표준 OIDC 가 아니라 Neobus 자체 OAuth 규약이라
 * 라이브러리를 쓰지 않고 계약대로 직접 부른다.
 *
 * 규약 원문: 문서 「16 Neobus 로그인 SSO」 03·05장.
 */

/** Neobus `/api/merge-auth/me` 가 돌려주는 사용자. 토큰에 굳은 값이 아니라 지금 값이다. */
export interface NeobusUser {
  user_id: number;
  login_id: string;
  name: string;
  user_type: string;
  approval_status: string;
}

export interface LinkToken {
  link_token: string;
  expires_at: string;
  expires_in: number;
}

/**
 * 호출 결과. 실패를 두 가지로 나눈다.
 *
 * - `auth`  : 자격이 없다. 세션을 버리고 다시 로그인시킨다.
 * - `temp`  : Neobus 가 잠깐 안 된다. 세션을 버리지 않는다.
 *
 * 이 구분이 없으면 Neobus 가 1분 끊긴 것이 선생님 로그아웃으로 번진다.
 */
export type Called<T> = { ok: true; data: T } | { ok: false; kind: "auth" | "temp" };

const TIMEOUT_MS = 5000;

/** 교사로 인정하는 Neobus 계정 유형. `학생` 은 없다 — 값은 한글 그대로다. */
const TEACHER_TYPES = new Set(["선생님", "school_admin", "admin"]);
/** 보물섬 최고관리자로 승계하는 유형. Neobus 사이트 전체 관리자만이다. */
const SUPER_TYPE = "admin";

/** base64url(패딩 없음). PKCE 의 표준 표현이다(RFC 7636). */
function base64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 암호학적 난수. Math.random 을 쓰면 PKCE 가 막으려던 공격이 그대로 통한다. */
export function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

/** S256 challenge. 변형하지 않는다 — Neobus 가 43자 형식까지 검사한다. */
export async function s256Challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

/** SHA-256 16진. 세션 토큰은 원문 대신 이 값을 저장한다. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 길이가 달라도 시간차를 남기지 않는 비교. state 대조에 쓴다.
 * 평범한 === 는 다른 글자에서 멈춰서, 그 시간 차이로 값을 한 글자씩 알아낼 수 있다.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

/**
 * Neobus 를 한 번 부른다.
 *
 * 200 이 왔다는 것만으로 성공으로 보지 않는다. `success` 가 true 이고 `data` 가 객체일 때만
 * 통과시킨다. 시간이 오래 걸리면 끊는다 — 여기서 매달리면 선생님 화면 전체가 멈춘다.
 */
async function callJson<T>(url: string, init: RequestInit): Promise<Called<T>> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return { ok: false, kind: "temp" }; // 그물이 끊겼거나 너무 느리다
  }
  if (res.status === 401 || res.status === 403) return { ok: false, kind: "auth" };
  if (!res.ok) return { ok: false, kind: "temp" };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, kind: "temp" }; // JSON 이 아니면 Neobus 가 아니라 중간의 무언가다
  }
  if (typeof body !== "object" || body === null) return { ok: false, kind: "temp" };
  const envelope = body as { success?: unknown; data?: unknown };
  if (envelope.success !== true) return { ok: false, kind: "auth" };
  if (typeof envelope.data !== "object" || envelope.data === null) return { ok: false, kind: "temp" };
  return { ok: true, data: envelope.data as T };
}

/**
 * 답에 `data` 가 없는 호출용. revoke 가 그렇다 — `{ success: true }` 한 줄로 끝난다.
 *
 * 2026-09-24 운영 첫날, revoke 응답에 data 가 없다는 이유로 매번 "잠깐 안 됨"으로 분류해
 * 폐기 대기열에 쌓이기만 하고 실제로는 하나도 폐기되지 않았다. 성공 여부만 본다.
 */
async function callAck(url: string, init: RequestInit): Promise<Called<unknown>> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return { ok: false, kind: "temp" };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, kind: "auth" };
  if (!res.ok) return { ok: false, kind: "temp" };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, kind: "temp" };
  }
  const success = typeof body === "object" && body !== null && (body as { success?: unknown }).success === true;
  return success ? { ok: true, data: {} } : { ok: false, kind: "auth" };
}

/**
 * 인가 코드를 연결 토큰으로 바꾼다. **서버에서만** 부른다.
 *
 * redirect_uri 를 여기서도 보낸다. Neobus 는 코드를 낼 때 쓴 주소와 바꿀 때 온 주소가
 * 정확히 같은지 본다. 한 글자만 달라도 거절한다.
 */
export function exchangeCode(
  env: Env,
  params: { code: string; codeVerifier: string },
): Promise<Called<LinkToken>> {
  return callJson<LinkToken>(`${env.NEOBUS_ORIGIN}/api/merge-auth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: env.MERGE_CLIENT_ID,
      client_secret: env.MERGE_CLIENT_SECRET,
      redirect_uri: env.MERGE_REDIRECT_URI,
      code: params.code,
      code_verifier: params.codeVerifier,
    }),
  });
}

/** 연결 토큰의 **현재** 사용자. 이름·유형·승인 상태가 바뀌면 다음 호출부터 바뀐 값이 온다. */
export function fetchLinkedUser(env: Env, linkToken: string): Promise<Called<NeobusUser>> {
  return callJson<NeobusUser>(`${env.NEOBUS_ORIGIN}/api/merge-auth/me`, {
    method: "GET",
    headers: { authorization: `Bearer ${linkToken}` },
  });
}

/** 연결 토큰을 폐기한다. 없는 토큰이어도 Neobus 는 성공으로 답한다. */
export function revokeLinkToken(env: Env, linkToken: string): Promise<Called<unknown>> {
  return callAck(`${env.NEOBUS_ORIGIN}/api/merge-auth/revoke`, {
    method: "POST",
    headers: { authorization: `Bearer ${linkToken}` },
  });
}

/** 응답이 사람 모양인지 본다. 모르는 모양을 통과시키지 않는다. */
export function isNeobusUser(value: unknown): value is NeobusUser {
  if (typeof value !== "object" || value === null) return false;
  const u = value as Record<string, unknown>;
  return (
    typeof u.user_id === "number" &&
    Number.isFinite(u.user_id) &&
    typeof u.name === "string" &&
    u.name.length > 0 &&
    typeof u.user_type === "string" &&
    typeof u.approval_status === "string"
  );
}

/**
 * 이 사람이 보물섬 선생님인가. 그리고 최고관리자인가.
 *
 * 2026-09-23 확정: 교사는 `선생님 · school_admin · admin` 중 승인된 사람,
 * 최고관리자는 `admin` 뿐이다. 모르는 유형·승인 상태는 통과시키지 않는다.
 */
export function judge(user: NeobusUser): { teacher: boolean; isSuper: boolean } {
  const approved = user.approval_status === "approved";
  return {
    teacher: approved && TEACHER_TYPES.has(user.user_type),
    isSuper: approved && user.user_type === SUPER_TYPE,
  };
}
