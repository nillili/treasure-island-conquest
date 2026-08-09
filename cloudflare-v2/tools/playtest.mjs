/**
 * 실제로 한 판을 끝까지 해 본다 — 선생님 하나, 학생 여럿, WebSocket 으로.
 *
 *   SIGNUP_CODE=가입코드 node tools/playtest.mjs [--base 주소] [--students 6] [--rounds 4]
 *
 * 화면 없이 브라우저가 하는 그대로 한다. 확인하는 것:
 *   · 한 명이 정답을 내면 다른 학생 화면이 즉시 바뀌는가(방송)
 *   · 화면이 본 문제와 채점 결과가 늘 맞는가
 *   · 같은 요청을 두 번 보내도 점수가 한 번만 오르는가
 *   · stateRev 가 건너뛰지 않는가
 */
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const BASE = arg("base", "http://127.0.0.1:8799");
const STUDENTS = Number(arg("students", 6));
const ROUNDS = Number(arg("rounds", 4));
const WS_BASE = BASE.replace(/^http/, "ws");

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

/** 브라우저 한 대. */
class Client {
  constructor(name, hello) {
    this.name = name;
    this.hello = hello;
    this.state = null;
    this.rev = -1;
    this.gaps = 0;
    this.quiz = null;
    this.results = [];
  }
  connect() {
    return new Promise((resolve, reject) => {
      // 선생님으로 붙으려면 세션 쿠키가 업그레이드 요청에 실려야 한다(브라우저는 알아서 한다).
      this.ws = new WebSocket(`${WS_BASE}/api/rooms/${ROOM}/ws`, { headers: { cookie } });
      this.ws.addEventListener("open", () => this.ws.send(JSON.stringify(this.hello)));
      this.ws.addEventListener("error", reject);
      this.ws.addEventListener("message", (ev) => {
        if (ev.data === "PONG") return;
        const msg = JSON.parse(ev.data);
        this.apply(msg);
        if (msg.t === "state" && !this.ready) { this.ready = true; resolve(this); }
        // 거절당했는데 계속 기다리면 영영 멈춘다. 바로 알려 준다.
        else if (msg.t === "error" && !this.ready) reject(new Error(`${this.name} 거절: ${msg.code} ${msg.msg}`));
      });
    });
  }
  apply(msg) {
    if (typeof msg.stateRev === "number") {
      if (msg.stateRev > this.rev + 1 && this.rev >= 0) this.gaps++;
      if (msg.stateRev >= this.rev) this.rev = msg.stateRev;
    }
    if (msg.t === "state") { this.state = msg; this.id = msg.myPlayer?.id ?? this.id; }
    else if (msg.t === "patch" && this.state) {
      for (const c of msg.cells) this.state.board[c.idx] = { t: c.t, o: c.o };
      for (const p of msg.players) {
        const at = this.state.players.findIndex((x) => x.id === p.id);
        if (at >= 0) this.state.players[at] = p; else this.state.players.push(p);
        if (p.id === this.id && this.state.myPlayer) this.state.myPlayer.pos = p.pos;
      }
      this.state.cellLocks = msg.cellLocks;
      this.state.scores = msg.scores;
      this.state.status = msg.status;
    } else if (msg.t === "turn" && this.state) {
      Object.assign(this.state, {
        status: msg.status, round: msg.round, turnTeam: msg.turnTeam,
        turnEndsAt: msg.turnEndsAt, players: msg.players, cellLocks: msg.cellLocks,
      });
      if (this.state.myPlayer) {
        const mine = msg.players.find((p) => p.id === this.id);
        if (mine) this.state.myPlayer.pos = mine.pos;
        this.state.myPlayer.playedThisTurn = false;
      }
    } else if (msg.t === "quiz") this.quiz = msg;
    else if (msg.t === "result") this.results.push(msg);
    else if (msg.t === "error") this.lastError = msg;
  }
  send(msg) { this.ws.send(JSON.stringify(msg)); }
  /** 기다릴 것을 정확히 기다린다. 고정 시간으로 어림하면 느린 회선에서 헛되이 실패한다. */
  async waitUntil(check, ms = 6000) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (check()) return true;
      await sleep(40);
    }
    return false;
  }
  async sync() {
    this.quiz = null;
    const before = this.rev;
    this.send({ t: "sync" });
    await this.waitUntil(() => this.rev >= before, 3000);
    await sleep(60);
  }
}

function pickable(state) {
  const me = state.myPlayer;
  if (!me || me.pos === null) return null;
  const { rows, cols } = state;
  const r = Math.floor(me.pos / cols);
  const c = me.pos % cols;
  const out = [];
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    if (!dr && !dc) continue;
    const nr = r + dr;
    const nc = c + dc;
    if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
    const i = nr * cols + nc;
    if (state.board[i].o !== me.team && !state.cellLocks[i]) out.push(i);
  }
  return out.length ? out[Math.floor(Math.random() * out.length)] : null;
}

let ROOM = "";

const stats = { picked: 0, answered: 0, correct: 0, wrongGraded: 0, dupIgnored: 0, gaps: 0, errors: {} };

async function main() {
  const csv = await (await fetch(`${BASE}/`)).text().then(() => null).catch(() => null);
  void csv;

  console.log("① 선생님 가입 · 퀴즈 올리기");
  const id = `play${Math.random().toString(36).slice(2, 7)}`;
  const signupCode = process.env.SIGNUP_CODE ?? arg("code", "");
  if (!signupCode) {
    console.error("가입 코드가 필요합니다: SIGNUP_CODE=... 또는 --code ...");
    process.exit(1);
  }
  await http("/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: signupCode, id, name: "김선생", password: "pw1234" }),
  });

  const { readFileSync } = await import("node:fs");
  const buf = readFileSync(new URL("../../sample/보물섬점령전_DB.xlsx", import.meta.url));
  const form = new FormData();
  form.set("title", "국어1");
  form.set("file", new File([buf], "보물섬점령전_DB.xlsx"));
  const up = await http("/api/quizsets", { method: "POST", body: form });
  console.log(`   ${up.title} · ${up.itemCount}문항`);

  const room = await http("/api/rooms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId: uid(), quizSetId: up.id, label: "3학년 2반", rows: 12, cols: 12, turnSeconds: 300 }),
  });
  ROOM = room.code;
  console.log(`② 방 ${ROOM} · ${room.quizTitle}`);

  const teacher = await new Client("선생님", { t: "hello", role: "teacher" }).connect();
  const students = [];
  for (let i = 0; i < STUDENTS; i++) {
    students.push(await new Client(`학생${i + 1}`, { t: "hello", role: "student", name: `학생${i + 1}` }).connect());
  }
  console.log(`③ 학생 ${students.length}명 입장 · 홍 ${students.filter((s) => s.state.myPlayer.team === "H").length} : 청 ${students.filter((s) => s.state.myPlayer.team === "C").length}`);

  teacher.send({ t: "cmd", cmd: "newgame", actionId: uid() });
  await sleep(400);

  for (let turn = 0; turn < ROUNDS * 2; turn++) {
    teacher.send({ t: "cmd", cmd: "next", actionId: uid() });
    await sleep(400);
    const team = teacher.state.turnTeam;
    if (!team || teacher.state.status === "ended") break;

    const playing = students.filter((s) => s.state.myPlayer.team === team);
    for (const s of playing) {
      await s.sync();
      const cell = pickable(s.state);
      if (cell === null) continue;

      s.quiz = null;
      s.lastError = null;
      s.send({ t: "pick", cell, actionId: uid() });
      await s.waitUntil(() => s.quiz || s.lastError);
      if (!s.quiz) { const k = s.lastError?.code ?? "응답없음"; stats.errors[k] = (stats.errors[k] ?? 0) + 1; continue; }
      stats.picked++;

      // 화면이 본 보기 그대로 고른다. 서버 정답과 어긋나면 여기서 드러난다.
      const shown = s.quiz;
      const before = s.results.length;
      const actionId = uid();
      s.send({ t: "answer", cell, choice: 0, actionId });
      await s.waitUntil(() => s.results.length > before);
      // 같은 actionId 로 한 번 더 — 끊겼다 다시 보내는 상황을 흉내 낸다
      s.send({ t: "answer", cell, choice: 0, actionId });
      await s.waitUntil(() => s.results.length > before + 1);

      const got = s.results.slice(before);
      if (!got.length) continue;
      stats.answered++;
      if (got.length > 1 && JSON.stringify(got[0]) === JSON.stringify(got[1])) stats.dupIgnored++;
      const r = got[0];
      if (r.correct) stats.correct++;
      // 서버가 알려 준 정답 글자가 내가 본 보기 안에 있어야 한다
      if (!shown.options.includes(r.answerText)) stats.wrongGraded++;
    }
    await sleep(300);
  }

  teacher.send({ t: "cmd", cmd: "end", actionId: uid() });
  await sleep(500);

  for (const c of [teacher, ...students]) stats.gaps += c.gaps;
  const s0 = students[0].state;
  console.log("");
  console.log("─".repeat(58));
  console.log(`라운드 ${teacher.state.round} · 상태 ${teacher.state.status}`);
  console.log(`점수  홍 ${teacher.state.scores.H.total} : 청 ${teacher.state.scores.C.total}`);
  console.log(`도전 ${stats.picked} · 채점 ${stats.answered} · 정답 ${stats.correct}`);
  console.log(`문제-정답 어긋남 ${stats.wrongGraded}  ← 0 이어야 한다`);
  console.log(`재시도를 한 번만 반영 ${stats.dupIgnored}/${stats.answered}  ← 같아야 한다`);
  console.log(`순번(rev) 건너뜀 ${stats.gaps}  ← 0 이어야 한다`);
  console.log(`학생 화면이 본 마지막 점수: 홍 ${s0.scores.H.total} : 청 ${s0.scores.C.total}  ← 선생님과 같아야 한다`);
  if (Object.keys(stats.errors).length) console.log("거절:", stats.errors);

  const bad = stats.wrongGraded || stats.gaps || stats.dupIgnored !== stats.answered
    || s0.scores.H.total !== teacher.state.scores.H.total;
  console.log(bad ? "\n❌ 문제가 있다" : "\n✅ 통과");
  for (const c of [teacher, ...students]) c.ws.close();
  process.exit(bad ? 1 : 0);
}

main().catch((err) => { console.error("실패:", err); process.exit(1); });
