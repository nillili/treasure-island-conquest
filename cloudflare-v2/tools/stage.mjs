/**
 * 로컬에 "도와줄 학생" 칸을 눈으로 볼 수 있는 판 하나를 차려 놓고 그대로 서 있는다.
 *
 *   npx wrangler dev --port 8799        (다른 창에서 먼저)
 *   node tools/stage.mjs [--base 주소]
 *
 * 학생 다섯이 붙는다. **홀수라 [시작]을 누르면 깍두기가 짝으로 들어온다.**
 *   · 성실이 · 꾸준이 · 튼튼이 — 선생님이 [다음 턴]을 누를 때마다 계속 푼다
 *   · 멈춤이                  — 1라운드만 풀고 조용해진다 (화면이 굳은 학생)
 *   · 유령이                  — 한 번도 안 풀고 접속까지 끊는다 (나가 버린 학생)
 *   · 🤖 깍두기               — 서버가 넣는 가상의 학생. 사람이 조종하지 않는다
 *
 * 라운드를 5까지 올린 뒤 선생님 자리를 비운다. 그때부터 사람이 브라우저로 그 방에 들어와
 * 오른쪽 맨 위 "🙋 도와줄 학생" 에 멈춤이·유령이만 뜨는지 보면 된다.
 *
 * 판정 자체를 브라우저 없이 확인하려면 tools/help-check.mjs 를 쓴다.
 */
import { readFileSync } from "node:fs";
// 경로에 한글이 있으면 URL.pathname 이 퍼센트 인코딩을 준다. fileURLToPath 로 되돌린다.
import { fileURLToPath } from "node:url";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};

const BASE = arg("base", "http://127.0.0.1:8799");
const WS = BASE.replace(/^http/, "ws");
const ID = arg("id", "demo");
const PW = arg("pw", "pw1234");

/** 가입 코드는 .dev.vars 에 있다. 이 도구는 로컬에서만 쓰므로 거기서 그대로 읽는다. */
const signupCode = () => {
  const text = readFileSync(fileURLToPath(new URL("../.dev.vars", import.meta.url)), "utf8");
  const line = text.split(/\r?\n/).find((l) => l.trim().startsWith("SIGNUP_CODE="));
  return line ? line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "") : "";
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

let cookie = "";
async function http(path, options = {}) {
  const res = await fetch(BASE + path, {
    ...options,
    headers: { ...(options.headers ?? {}), ...(cookie ? { cookie } : {}) },
  });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) throw new Error(`${path} → ${res.status} ${body.error ?? ""}`);
  return body;
}

let ROOM = "";

/** 브라우저 한 대. playtest.mjs 의 것을 이 도구에 필요한 만큼만 줄였다. */
class Client {
  constructor(name, hello) { this.name = name; this.hello = hello; this.state = null; this.quiz = null; }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`${WS}/api/rooms/${ROOM}/ws`, { headers: { cookie } });
      this.ws.addEventListener("open", () => this.ws.send(JSON.stringify(this.hello)));
      this.ws.addEventListener("error", reject);
      this.ws.addEventListener("message", (ev) => {
        if (ev.data === "PONG") return;
        const msg = JSON.parse(ev.data);
        this.apply(msg);
        if (msg.t === "state" && !this.ready) { this.ready = true; resolve(this); }
        else if (msg.t === "error" && !this.ready) reject(new Error(`${this.name}: ${msg.code} ${msg.msg}`));
      });
    });
  }
  apply(msg) {
    if (msg.t === "state") { this.state = msg; this.id = msg.myPlayer?.id ?? this.id; }
    else if (msg.t === "patch" && this.state) {
      for (const c of msg.cells) this.state.board[c.idx] = { t: c.t, o: c.o };
      for (const p of msg.players) {
        const at = this.state.players.findIndex((x) => x.id === p.id);
        if (at >= 0) this.state.players[at] = p; else this.state.players.push(p);
        if (p.id === this.id && this.state.myPlayer) this.state.myPlayer.pos = p.pos;
      }
      this.state.cellLocks = msg.cellLocks;
      this.state.status = msg.status;
    } else if (msg.t === "turn" && this.state) {
      for (const c of msg.cells ?? []) this.state.board[c.idx] = { t: c.t, o: c.o };
      Object.assign(this.state, {
        status: msg.status, round: msg.round, turnTeam: msg.turnTeam,
        players: msg.players, cellLocks: msg.cellLocks,
      });
      if (this.state.myPlayer) {
        const mine = msg.players.find((p) => p.id === this.id);
        if (mine) this.state.myPlayer.pos = mine.pos;
        this.state.myPlayer.playedThisTurn = false;
      }
    } else if (msg.t === "quiz") this.quiz = msg;
  }
  send(msg) { this.ws.send(JSON.stringify(msg)); }
  async waitUntil(check, ms = 6000) {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (check()) return true; await sleep(40); }
    return false;
  }
  /** 자기 차례면 이웃 빈 칸 하나를 골라 답을 낸다. 맞고 틀리고는 상관없다 — 답을 냈다는 사실만 남으면 된다. */
  async play() {
    const st = this.state;
    const me = st?.myPlayer;
    if (!me || st.status !== "running" || st.turnTeam !== me.team || me.playedThisTurn || me.pos === null) return;
    const { rows, cols } = st;
    const r = Math.floor(me.pos / cols);
    const c = me.pos % cols;
    const near = [];
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      const i = nr * cols + nc;
      if (st.board[i].o === null && !st.cellLocks[i]) near.push(i);
    }
    if (!near.length) return;
    const cell = near[Math.floor(Math.random() * near.length)];
    this.quiz = null;
    this.send({ t: "pick", cell, actionId: uid(), playerId: me.id });
    if (!await this.waitUntil(() => this.quiz, 3000)) return;
    this.send({ t: "answer", cell, choice: 0, actionId: uid(), playerId: me.id });
    me.playedThisTurn = true;
    await sleep(120);
  }
}

// ── 선생님 ────────────────────────────────────────────────────────────────
try {
  await http("/api/auth/signup", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: signupCode(), id: ID, name: "김선생", password: PW }),
  });
  console.log(`선생님 새로 가입 · ${ID} / ${PW}`);
} catch {
  await http("/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: ID, password: PW }),
  });
  console.log(`선생님 로그인 · ${ID} / ${PW}`);
}

let quizSetId;
try {
  const form = new FormData();
  form.set("title", "국어1");
  form.set("file", new File([readFileSync(fileURLToPath(new URL("../../sample/보물섬점령전_DB.xlsx", import.meta.url)))], "보물섬점령전_DB.xlsx"));
  quizSetId = (await http("/api/quizsets", { method: "POST", body: form })).id;
} catch {
  quizSetId = (await http("/api/quizsets")).sets[0].id; // 이미 올려 둔 것을 그대로 쓴다
}

const room = await http("/api/rooms", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({
    requestId: uid(), quizSetId, label: "3학년 2반",
    rows: 12, cols: 12, turnSeconds: 300, roundLimit: 10,
  }),
});
ROOM = room.code;

// ── 학생 넷 ───────────────────────────────────────────────────────────────
const teacher = await new Client("선생님", { t: "hello", role: "teacher" }).connect();
const students = [];
for (const n of ["성실이", "꾸준이", "튼튼이", "멈춤이", "유령이"]) {
  students.push(await new Client(n, { t: "hello", role: "student", name: n }).connect());
}

teacher.send({ t: "cmd", cmd: "newgame", actionId: uid() });
await sleep(500);

// 라운드 5까지 올린다. [다음 턴]은 2초 연타 방지가 걸려 있어 그보다 넉넉히 둔다.
for (let step = 0; step < 14; step++) {
  teacher.send({ t: "cmd", cmd: "next", actionId: uid() });
  await sleep(2300);
  const round = teacher.state.round;
  for (const s of students) {
    if (s.name === "유령이") continue;
    if (s.name === "멈춤이" && round > 1) continue;
    await s.play();
  }
  if (round >= 5) break;
}

await sleep(600);
console.log(`\n라운드 ${teacher.state.round} · 상태 ${teacher.state.status}`);
for (const p of teacher.state.players) {
  console.log(`  ${p.bot ? "🤖" : "  "} ${p.name}  팀 ${p.team === "H" ? "홍" : "청"}  마지막으로 푼 라운드 ${p.lastRound}`);
}

// 유령이는 접속까지 끊는다. 선생님 자리는 비워, 사람이 브라우저로 들어올 수 있게 한다.
students.find((s) => s.name === "유령이").ws.close();
teacher.ws.close();

console.log(`\n브라우저에서 확인하세요 — ${BASE}`);
console.log(`  선생님 ${ID} / ${PW}  →  열려 있는 내 방  →  ${ROOM}`);
console.log("  오른쪽 맨 위 '🙋 도와줄 학생' 에 멈춤이 · 유령이만 뜨면 성공입니다.");
console.log("  학생 명단에 '🤖 깍두기' 가 있고, 그 말이 판 위에서 혼자 움직이면 성공입니다.");
console.log("\n성실이 · 꾸준이는 [다음 턴]을 누를 때마다 계속 풉니다. Ctrl+C 로 끝냅니다.");

setInterval(() => {
  for (const s of students) if (s.ws.readyState === 1) s.ws.send("PING");
}, 20000);

// 사람이 [다음 턴]을 누르면 둘은 따라 풀고 둘은 가만히 있는다 — 진짜 교실과 같은 그림.
setInterval(() => {
  for (const s of students) {
    if (["성실이", "꾸준이", "튼튼이"].includes(s.name)) s.play().catch(() => {});
  }
}, 1500);
