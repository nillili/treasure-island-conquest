/**
 * 수업이 도는 동안 실시간으로 지켜본다.
 *
 *   node tools/watch.mjs --room 1234 --id 내아이디 --pw 내비밀번호
 *   node tools/watch.mjs --room 1234 --id 내아이디 --pw 내비밀번호 --save
 *
 * 선생님 자격으로 방에 붙어, 학생 화면이 보는 것과 같은 것을 본다.
 * 서버 로그로는 "화면이 멈췄다"를 볼 수 없다 — 멈춘 화면은 요청 자체를 안 보내기 때문이다.
 * 그래서 이 도구는 **요청이 오지 않는 것 자체**를 증상으로 잡는다.
 *
 *   · 자기 팀 턴인데 아무것도 안 한 학생   → ⛔ 멈춤 의심
 *   · 접속이 끊긴 학생                     → · 끊김
 *   · 둘레가 전부 아군이라 못 푸는 학생     → ⚠ 갇힘
 *
 * Ctrl+C 로 끝낸다.
 */
import { appendFileSync, mkdirSync } from "node:fs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const has = (name) => process.argv.includes(`--${name}`);

const BASE = arg("base", "https://treasure-island-v2.ds1lph.workers.dev");
const ROOM = arg("room", "");
const ID = arg("id", "");
const PW = arg("pw", "");
const SAVE = has("save");

if (!ROOM || !ID || !PW) {
  console.log("사용법: node tools/watch.mjs --room 1234 --id 아이디 --pw 비밀번호 [--base 주소] [--save]");
  process.exit(1);
}

let logPath = null;
if (SAVE) {
  mkdirSync(new URL("../logs", import.meta.url), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  logPath = new URL(`../logs/watch_${ROOM}_${stamp}.txt`, import.meta.url);
}

function say(line = "") {
  console.log(line);
  if (logPath) appendFileSync(logPath, `${line}\n`);
}

const pad = (s, n) => {
  // 한글은 두 칸을 차지한다. 표가 밀리지 않게 폭을 직접 센다.
  const width = [...String(s)].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x1100 ? 2 : 1), 0);
  return String(s) + " ".repeat(Math.max(0, n - width));
};
const clock = (ms) => new Date(ms).toLocaleTimeString("ko-KR", { hour12: false });
const ago = (ms) => (ms < 60000 ? `${Math.floor(ms / 1000)}초` : `${Math.floor(ms / 60000)}분${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}초`);

// ── 로그인 ────────────────────────────────────────────────────────────────
let cookie = "";
const res = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ id: ID, password: PW }),
});
if (!res.ok) {
  console.error(`로그인 실패: ${(await res.json().catch(() => ({}))).error ?? res.status}`);
  process.exit(1);
}
cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];

const check = await (await fetch(`${BASE}/api/rooms/${ROOM}`)).json();
if (!check.exists) {
  console.error(`방 ${ROOM} 을 찾을 수 없습니다.`);
  process.exit(1);
}

// ── 감시 상태 ─────────────────────────────────────────────────────────────
const seen = new Map(); // playerId -> 마지막으로 무언가 한 시각
const quiet = new Map(); // playerId -> 자기 팀 턴인데 조용히 넘어간 횟수
let state = null;
let lastTurnKey = null;
let lastLogAt = 0;
let ws = null;
let backoff = 500;

function onMessage(msg) {
  if (msg.t === "state") {
    state = msg;
    for (const p of msg.players) if (!seen.has(p.id)) seen.set(p.id, Date.now());
  } else if (msg.t === "patch" && state) {
    for (const c of msg.cells) state.board[c.idx] = { t: c.t, o: c.o };
    for (const p of msg.players) {
      const at = state.players.findIndex((x) => x.id === p.id);
      if (at >= 0) state.players[at] = p;
      else state.players.push(p);
      seen.set(p.id, Date.now()); // 움직였다 = 살아 있다
    }
    state.cellLocks = msg.cellLocks;
    state.scores = msg.scores;
    state.status = msg.status;
    // 새로 들어온 기록으로 누가 무엇을 했는지 뽑는다
    for (const e of msg.log ?? []) {
      if (e.at <= lastLogAt) continue;
      lastLogAt = Math.max(lastLogAt, e.at);
      say(`  ${clock(e.at)} ${e.ok ? "✅" : "❌"} ${pad(e.name, 10)} ${e.type === "T" ? "📦" : e.type === "S" ? "⛈️" : e.type === "A" ? "💥" : "  "} ${e.ok ? `+${e.gain}` : ""}`);
    }
    state.log = msg.log;
  } else if (msg.t === "turn" && state) {
    Object.assign(state, msg);
    say(`\n── ${clock(Date.now())}  라운드 ${msg.round} · ${msg.turnTeam === "H" ? "홍팀" : "청팀"} 차례 ──`);
  } else if (msg.t === "presence" && state) {
    state.presence = msg.online;
  } else if (msg.t === "gameover") {
    say(`\n🏁 ${msg.winner} 승리 · 홍 ${msg.scores.H.total} : 청 ${msg.scores.C.total}`);
    for (const p of msg.players) say(`   ${pad(p.name, 10)} ${p.correct}/${p.solved}`);
  } else if (msg.t === "closed") {
    say("\n방이 닫혔습니다.");
    process.exit(0);
  } else if (msg.t === "error") {
    say(`⚠ ${msg.code}: ${msg.msg}`);
  }
}

function connect() {
  ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/api/rooms/${ROOM}/ws`, { headers: { cookie } });
  ws.addEventListener("open", () => {
    backoff = 500;
    ws.send(JSON.stringify({ t: "hello", role: "teacher" }));
    say(`감시 시작 · 방 ${ROOM} · ${BASE}`);
    if (logPath) say(`기록: ${logPath.pathname}`);
  });
  ws.addEventListener("message", (ev) => {
    if (ev.data === "PONG") return;
    try { onMessage(JSON.parse(ev.data)); } catch { /* 무시 */ }
  });
  ws.addEventListener("close", () => {
    say(`⚠ ${clock(Date.now())} 연결이 끊겼습니다. 다시 붙는 중…`);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 8000);
  });
  ws.addEventListener("error", () => { /* close 가 이어서 온다 */ });
}
connect();

setInterval(() => {
  if (ws?.readyState === WebSocket.OPEN) ws.send("PING");
}, 20000);

// ── 표 ────────────────────────────────────────────────────────────────────
function neighbors(pos, rows, cols) {
  const r = Math.floor(pos / cols);
  const c = pos % cols;
  const out = [];
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    if (!dr && !dc) continue;
    const nr = r + dr;
    const nc = c + dc;
    if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) out.push(nr * cols + nc);
  }
  return out;
}
const label = (i, cols) => (i === null ? "--" : String.fromCharCode(65 + (i % cols)) + (Math.floor(i / cols) + 1));

function dashboard() {
  if (!state) return;
  const now = Date.now();

  // 턴이 바뀌었으면, 직전 턴에 조용했던 학생을 센다
  const key = `${state.round}:${state.turnTeam}`;
  if (lastTurnKey && key !== lastTurnKey) {
    const prevTeam = lastTurnKey.split(":")[1];
    for (const p of state.players) {
      if (p.team !== prevTeam) continue;
      const last = seen.get(p.id) ?? 0;
      if (now - last < 45000) quiet.set(p.id, 0);
      else quiet.set(p.id, (quiet.get(p.id) ?? 0) + 1);
    }
  }
  lastTurnKey = key;

  const online = new Set(state.presence ?? []);
  const left = Math.max(0, (state.turnEndsAt ?? 0) - now);
  say(`\n[${clock(now)}] ${state.status} · R${state.round}/${state.roundLimit} · `
    + `${state.turnTeam === "H" ? "홍팀" : state.turnTeam === "C" ? "청팀" : "대기"} · 남은 ${Math.floor(left / 1000)}초 · `
    + `홍 ${state.scores.H.total} : 청 ${state.scores.C.total} · 접속 ${online.size}/${state.players.length}`);
  say(`  ${pad("이름", 11)}${pad("팀", 4)}${pad("위치", 6)}${pad("도전가능", 9)}${pad("마지막", 9)}상태`);

  const alarms = [];
  for (const p of [...state.players].sort((a, b) => a.name.localeCompare(b.name, "ko"))) {
    const free = p.pos === null ? 0
      : neighbors(p.pos, state.rows, state.cols).filter((n) => state.board[n].o !== p.team).length;
    const last = seen.get(p.id) ?? 0;
    const q = quiet.get(p.id) ?? 0;

    let status = "정상";
    if (state.status !== "running") status = "· 대기/종료";
    else if (!online.has(p.id)) status = "· 접속 끊김";
    else if (p.pos !== null && free === 0) { status = "⚠ 도전할 칸 없음"; alarms.push([p.name, "[다음 턴]을 누르면 자동으로 옮겨 줍니다"]); }
    else if (q >= 2) { status = `⛔ 자기 팀 턴 ${q}회 조용함`; alarms.push([p.name, "나갔다 다시 들어오게 하세요(F5 → 이름 재입력)"]); }
    else if (q === 1) status = "⚠ 직전 턴에 조용했음";

    say(`  ${pad(p.name, 11)}${pad(p.team === "H" ? "홍" : "청", 4)}${pad(label(p.pos, state.cols), 6)}`
      + `${pad(free, 9)}${pad(last ? ago(now - last) : "없음", 9)}${status}`);
  }
  for (const [name, how] of alarms) say(`  >>> ${name}: ${how}`);
}

setInterval(dashboard, Number(arg("every", 5)) * 1000);

process.on("SIGINT", () => {
  say("\n감시 종료");
  process.exit(0);
});
