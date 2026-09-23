/**
 * 도구가 선생님 자격을 얻는 두 가지 길.
 *
 * ① 실서버 — 브라우저에서 네오버스로 로그인한 뒤, 그 탭의 `tsession` 쿠키 한 줄을
 *    파일에 적어 둔다. 도구는 그 파일만 읽는다.
 *    네오버스 비밀번호나 연결 토큰은 도구에 들어오지 않는다.
 *
 *      echo 'tsession=여기에값' > .teacher.cookie
 *      chmod 600 .teacher.cookie
 *
 * ② 로컬 — tools/fake-neobus.mjs 가 돌고 있으면 도구가 직접 왕복해 쿠키를 얻는다.
 *
 * 세션은 언젠가 끝난다. 그때는 다시 로그인해 파일을 새로 적어야 한다.
 * 도구가 몰래 다시 로그인하는 길은 없다 — 그런 길이 있으면 그게 곧 뒷문이다.
 */
import { readFileSync, statSync } from "node:fs";

export const COOKIE_FILE = new URL("../.teacher.cookie", import.meta.url);

/** 파일에서 쿠키 한 줄을 읽는다. 없으면 빈 문자열. */
export function readSessionCookie(path = COOKIE_FILE) {
  let raw;
  try {
    raw = readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
  if (!raw) return "";
  try {
    const mode = statSync(path).mode & 0o077;
    if (mode) console.error("⚠ 쿠키 파일을 남이 읽을 수 있습니다. chmod 600 으로 줄여 주세요.");
  } catch {
    /* 권한을 못 보는 곳도 있다 */
  }
  const line = raw.split(/\r?\n/)[0].trim();
  return line.startsWith("tsession=") ? line.split(";")[0] : `tsession=${line}`;
}

/**
 * 로컬 가짜 네오버스를 거쳐 실제 로그인 왕복을 한다.
 *
 * 운영에 테스트용 뒷문을 만들지 않기 위해, 여기서도 화면과 똑같은 길을 지난다.
 * 가짜 네오버스가 안 돌고 있으면 빈 문자열을 돌려준다.
 */
export async function loginViaFakeNeobus(base, who = "") {
  const start = await fetch(`${base}/auth/start`, { redirect: "manual" });
  const tx = (start.headers.get("set-cookie") ?? "").split(";")[0];
  const to = start.headers.get("location");
  if (!to || !tx.startsWith("tlogin=")) return "";

  const authorize = new URL(to);
  if (who) authorize.searchParams.set("who", who);
  let hop;
  try {
    hop = await fetch(authorize, { redirect: "manual" });
  } catch {
    return ""; // 가짜 네오버스가 안 돌고 있다
  }
  const back = hop.headers.get("location");
  if (!back) return "";

  const done = await fetch(back, { headers: { cookie: tx }, redirect: "manual" });
  for (const raw of done.headers.getSetCookie()) {
    if (raw.startsWith("tsession=")) return raw.split(";")[0];
  }
  return "";
}

/** 쿠키 파일이 먼저, 없으면 로컬 왕복. 둘 다 안 되면 왜 안 되는지 말하고 끝낸다. */
export async function teacherCookie(base, { who = "", quiet = false } = {}) {
  const fromFile = readSessionCookie();
  if (fromFile) return fromFile;
  const fromLocal = await loginViaFakeNeobus(base, who);
  if (fromLocal) {
    if (!quiet) console.log("가짜 네오버스로 로그인했습니다(로컬).");
    return fromLocal;
  }
  return "";
}

export const NEED_LOGIN = [
  "선생님 자격을 얻지 못했습니다.",
  "",
  "  · 실서버를 볼 때 — 브라우저에서 네오버스로 로그인한 뒤 그 탭의 tsession 쿠키를",
  "    cloudflare-v2/.teacher.cookie 에 한 줄로 적어 주세요 (chmod 600).",
  "  · 로컬을 볼 때  — 다른 창에서 node tools/fake-neobus.mjs 를 켜 두세요.",
].join("\n");
