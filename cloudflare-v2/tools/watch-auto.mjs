/**
 * 방이 열리기를 기다렸다가, 열리는 즉시 watch.mjs 를 붙인다.
 * 방이 닫히면 다시 기다린다 — 껐다 켜지 않는 한 계속 산다.
 *
 *   node tools/watch-auto.mjs            (방이 생길 때마다 자동으로 기록)
 *
 * 수업 한 번이 끝나도 죽지 않는 것이 요점이다. watch.mjs 는 방이 닫히면 스스로 끝나는데,
 * 이 런처는 그 뒤에 다시 대기 상태로 돌아간다. 그래야 "나중에 문제가 생겼을 때
 * 그 시각 기록이 남아 있다"가 성립한다.
 *
 * 남는 것은 두 갈래다.
 *   · logs/watch_<방번호>_<시각>.txt  — 방마다 한 벌, 학생별 움직임 전체
 *   · logs/watch-auto.txt             — 런처 자신의 기록(언제 붙었고 언제 떨어졌나)
 *
 * 두 번째가 있어야 "그 수업 기록이 왜 없지?"를 나중에 되짚을 수 있다.
 * Ctrl+C 로 끝낸다.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const BASE = "https://treasure-island-v2.ds1lph.workers.dev";
const POLL_MS = 5000;
const devVars = (key) => {
  try {
    const text = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8");
    const line = text.split(/\r?\n/).find((l) => l.trim().startsWith(`${key}=`));
    return line ? line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "") : "";
  } catch {
    return "";
  }
};

const ID = process.env.WATCH_ID || devVars("WATCH_ID");
const PW = process.env.WATCH_PW || devVars("WATCH_PW");

mkdirSync(new URL("../logs", import.meta.url), { recursive: true });
const selfLog = fileURLToPath(new URL("../logs/watch-auto.txt", import.meta.url));
const stamp = () => new Date().toLocaleString("ko-KR", { hour12: false });

function say(line) {
  console.log(line);
  appendFileSync(selfLog, `${stamp()}  ${line}\n`);
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

/** 세션은 언젠가 만료된다. 하루 종일 켜 두는 도구라 다시 로그인할 수 있어야 한다. */
async function login() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: ID, password: PW }),
  });
  if (!res.ok) return "";
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

let cookie = await login();
if (!cookie) {
  console.error("로그인 실패 — .dev.vars 의 WATCH_ID · WATCH_PW 를 확인하세요.");
  process.exit(1);
}

say("── 자동 감시 시작 ──");

/** 열린 방 하나를 찾는다. 세션이 끊겼으면 조용히 다시 로그인한다. */
async function findRoom() {
  const r = await fetch(`${BASE}/api/rooms/mine`, { headers: { cookie } })
    .then((x) => x.json())
    .catch(() => null);
  if (r?.ok) return r.rooms?.[0] ?? null;

  // ok 가 아니면 세션 만료이거나 서버가 잠깐 흔들린 것이다. 둘 다 재로그인으로 회복된다.
  const fresh = await login();
  if (fresh) {
    cookie = fresh;
    say("세션이 만료되어 다시 로그인했습니다.");
  }
  return null;
}

/** 붙어 있는 동안 새 방이 열렸는지 살피는 간격. */
const SWITCH_MS = 15000;

/**
 * watch.mjs 를 붙이고, 끝날 때까지 기다린다.
 *
 * 붙어 있는 동안에도 방 목록을 계속 살핀다. 끝난 방은 선생님이 닫지 않으면 계속
 * 열린 채로 남는데, 예전에는 감시가 그 빈 방을 붙잡고 새 방을 따라가지 못했다
 * (2026-08-29 오후, 58분 동안 빈 방만 508KB 기록했다).
 * 목록은 최근에 만든 방이 앞이므로, 맨 앞이 바뀌면 그쪽으로 옮겨 붙는다.
 */
function attach(code) {
  return new Promise((done) => {
    const child = spawn(
      process.execPath,
      // 경로에 한글이 있으면 URL.pathname 은 퍼센트 인코딩된 문자열을 준다. 반드시 fileURLToPath 로 되돌린다.
      [fileURLToPath(new URL("./watch.mjs", import.meta.url)), "--room", code, "--save"],
      { stdio: "inherit" },
    );

    let moved = false;
    const looking = setInterval(async () => {
      const top = await findRoom();
      if (!top || top.code === code) return;
      moved = true;
      say(`새 방 ${top.code} 이 열렸습니다 — 옮겨 붙습니다.`);
      child.kill();
    }, SWITCH_MS);

    const finish = (exitCode) => { clearInterval(looking); done({ exitCode, moved }); };
    child.on("exit", (exitCode) => finish(exitCode ?? 0));
    child.on("error", () => finish(-1));
  });
}

let waiting = false;
let lastCode = null;
let quickFails = 0;

while (true) {
  const room = await findRoom();

  if (!room) {
    if (!waiting) {
      say("방이 열리기를 기다립니다…");
      waiting = true;
    }
    lastCode = null;
    await sleep(POLL_MS);
    continue;
  }

  waiting = false;
  say(`🎯 방 ${room.code} 발견 (${room.quizTitle ?? "퀴즈 미지정"}) — 기록을 시작합니다.`);

  const startedAt = Date.now();
  const { exitCode, moved } = await attach(room.code);
  const lasted = Math.round((Date.now() - startedAt) / 1000);
  say(`방 ${room.code} 기록 종료 (${lasted}초 · exit ${exitCode})`);

  // 새 방으로 옮기려고 내가 끊은 것은 실패가 아니다. 곧바로 다음 방을 잡는다.
  if (moved) { quickFails = 0; lastCode = room.code; continue; }

  // 붙자마자 죽으면 같은 방을 무한히 다시 붙게 된다. 몇 번 연달아 실패하면 간격을 벌린다.
  if (lasted < 5 && room.code === lastCode) {
    quickFails += 1;
    if (quickFails >= 3) {
      say(`⚠ 방 ${room.code} 에 계속 붙지 못합니다. 30초 쉬었다 다시 시도합니다.`);
      await sleep(30000);
      quickFails = 0;
    }
  } else {
    quickFails = 0;
  }
  lastCode = room.code;

  await sleep(POLL_MS);
}
