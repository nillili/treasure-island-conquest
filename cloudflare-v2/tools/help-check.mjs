/**
 * 선생님 화면 오른쪽 위 "도와줄 학생" 칸이 제대로 사람을 가리는지 브라우저 없이 확인한다.
 *
 *   node tools/help-check.mjs
 *
 * 2026-08-29 수업에서 민서·미소가 화면이 굳은 채 앉아 있었는데 선생님은 몰랐다.
 * 서버 기록에는 남았지만 그건 판이 끝난 뒤였다. 수업 중에 보여야 손을 쓸 수 있다.
 *
 * 확인하는 것 — 멀쩡한 학생은 안 뜨고, 손이 필요한 학생만 뜨는가.
 *   ① 다 잘 풀고 있으면 칸이 숨어 있다
 *   ② 접속이 끊긴 학생은 뜬다
 *   ③ 세 라운드째 조용한 학생은 뜬다
 *   ④ 폭풍으로 한 턴 쉰 학생은 안 뜬다 (억울한 호출을 만들지 않는다)
 *   ⑤ 아무도 안 붙어 있으면(소켓이 막힌 교실) 접속으로는 아무도 부르지 않는다
 *   ⑥ 게임이 안 도는 동안에는 아무도 안 뜬다
 *
 * 한계 — 진짜 브라우저가 아니다. 그리기·CSS 는 확인하지 못한다.
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";
// 경로에 한글이 있으면 URL.pathname 이 퍼센트 인코딩을 준다. fileURLToPath 로 되돌린다.
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../public", import.meta.url));

/** 무엇을 물어도 그럴듯하게 답하는 가짜 엘리먼트. */
function fakeEl(id = "") {
  return {
    id, textContent: "", innerHTML: "", value: "", disabled: false, style: { setProperty() {} },
    dataset: {},
    classList: { _s: new Set(), add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); },
      contains(c) { return this._s.has(c); } },
    addEventListener() {}, removeEventListener() {},
    querySelectorAll() { return []; }, querySelector() { return null; },
    closest() { return null; }, appendChild() {}, focus() {},
    getBoundingClientRect() { return { width: 0, height: 0 }; },
  };
}

const els = new Map();
const byId = (id) => { if (!els.has(id)) els.set(id, fakeEl(id)); return els.get(id); };

const ctx = {
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  Date, Math, JSON, Number, String, Object, Array, Set, Map, Promise, Error,
  localStorage: { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } },
  location: { href: "http://t/", search: "", pathname: "/" },
  innerWidth: 1280, innerHeight: 800,
  addEventListener() {}, removeEventListener() {},
  document: {
    getElementById: byId,
    querySelectorAll() { return []; },
    querySelector() { return null; },
    addEventListener() {}, removeEventListener() {},
    createElement: () => fakeEl(),
    body: fakeEl("body"), documentElement: fakeEl("html"), hidden: false,
  },
  WebSocket: class { constructor() { this.readyState = 1; } send() {} close() {} addEventListener() {} },
  fetch: async () => { throw new Error("네트워크 없음"); },
  confirm: () => true, alert() {},
  matchMedia: () => ({ matches: false, addEventListener() {} }),
};
ctx.window = ctx;
ctx.globalThis = ctx;
vm.createContext(ctx);

// net.js 는 통째로 흉내 낸다. 우리가 볼 것은 판정이지 전송 계층이 아니다.
vm.runInContext(`
  var NET = { code: null, hello: null, onMessage: null, mode: "ws", stopped: false };
  async function netSend() {}
  function netOpen() {} function netClose() {} function netStatus() {}
  function netStart() {}
`, ctx);

try {
  vm.runInContext(readFileSync(`${ROOT}/app.js`, "utf8"), ctx, { filename: "app.js" });
} catch (err) {
  console.error("app.js 를 불러오지 못했습니다:", err.message);
  process.exit(2);
}

/**
 * 5라운드째를 돌고 있는 방 하나. 학생마다 마지막으로 푼 라운드를 달리 준다.
 *   잘함 5 · 폭풍 3(한 턴 쉬었다) · 멈춤 2(세 라운드째 조용) · 처음부터 0
 */
function room({ round = 5, status = "running", online = ["a", "b", "c", "d"] } = {}) {
  return {
    status, round, roundLimit: 10, turnTeam: "H", turnEndsAt: Date.now() + 20000,
    code: "1234", label: null, quizTitle: "상식", rows: 3, cols: 3,
    board: [], cellLocks: {}, scores: { H: { total: 0, territory: 0, bonus: 0 }, C: { total: 0, territory: 0, bonus: 0 } },
    log: [], presence: online,
    players: [
      { id: "a", name: "잘함", team: "H", pos: 0, lastRound: 5 },
      { id: "b", name: "폭풍", team: "H", pos: 1, lastRound: 3 },
      { id: "c", name: "멈춤", team: "C", pos: 2, lastRound: 2 },
      { id: "d", name: "처음부터", team: "C", pos: null, lastRound: 0 },
    ],
  };
}

/** 판정을 돌리고 불린 사람의 이름만 돌려준다. */
function called(state) {
  ctx.__state = state;
  return vm.runInContext("helpNeeded(__state)", ctx).map((p) => p.name);
}

/** 화면에 실제로 칸이 나타나는지까지 본다 — 판정만 맞고 안 그려지면 소용없다. */
function cardShown(state) {
  ctx.__state = state;
  vm.runInContext("APP.role = 'teacher'; APP.state = __state; renderHelp();", ctx);
  return !byId("help-card").classList.contains("hidden");
}

let bad = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "✅" : "❌"} ${label}\n     나온 것 ${JSON.stringify(got)}${ok ? "" : `\n     바란 것 ${JSON.stringify(want)}`}`);
  if (!ok) bad += 1;
};

// ① 다 잘 풀고 있으면 아무도 안 부른다
check("모두 방금 풀었으면 아무도 안 뜬다",
  called({ ...room(), players: room().players.map((p) => ({ ...p, lastRound: 5 })) }), []);

// ②③④ 한 방에 섞여 있을 때 — 멈춘 둘만 부른다
check("멈춘 학생만 부른다 (폭풍으로 한 턴 쉰 학생은 빼고)",
  called(room()), ["멈춤", "처음부터"]);

// ② 끊긴 데다 밀리기까지 했으면 부른다 (폭풍이는 5라운드에 마지막이 3 — 두 라운드 밀렸다)
check("끊긴 데다 두 라운드 밀린 학생은 부른다",
  called(room({ online: ["a", "c", "d"] })), ["폭풍", "멈춤", "처음부터"]);

// ★ 끊겨 보여도 방금 푼 학생은 안 부른다 — 폴링으로 내려갔을 뿐 수업 중이다
check("끊겨 보여도 방금 푼 학생은 안 부른다",
  called(room({ online: ["b", "c", "d"] })), ["멈춤", "처음부터"]);

// ⑤ 아무도 안 붙어 있으면 접속으로는 부르지 않는다 (소켓이 막힌 교실)
check("전원 폴백이면 접속으로는 아무도 안 부른다",
  called(room({ online: [] })), ["멈춤", "처음부터"]);

// ⑥ 게임이 안 도는 동안에는 조용한 게 정상이다
check("대기·종료 중에는 아무도 안 뜬다", called(room({ status: "ended" })), []);

// 판이 막 시작해 라운드가 얕으면 아직 아무도 늦지 않았다
check("2라운드째에는 아직 아무도 안 뜬다", called(room({ round: 2 })), []);

// 화면까지 — 없으면 숨고, 있으면 나타난다
check("아무도 없으면 칸이 숨는다", cardShown(room({ status: "ended" })), false);
check("있으면 칸이 나타난다", cardShown(room()), true);
check("나타난 칸에 이름이 적힌다", byId("help-list").innerHTML.includes("멈춤"), true);

if (bad) {
  console.error(`\n❌ ${bad}가지가 어긋납니다 — 선생님이 엉뚱한 학생을 부르게 됩니다.`);
  process.exit(1);
}
console.log("\n✅ 도와줄 학생 칸이 부를 사람만 부릅니다.");
process.exit(0); // app.js 가 걸어 둔 연출 타이머가 뒤에서 계속 돌기 때문에 여기서 끝낸다.
