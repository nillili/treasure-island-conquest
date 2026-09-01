/**
 * "갇히면 한 판 쉰다" 규칙이 화면에서 제대로 도는지 브라우저 없이 확인한다.
 *
 *   node tools/trap-check.mjs
 *
 * 2026-09-01 에 넣은 규칙이다. 갇힌 학생은 그 턴을 쉬는데, 쉬는 동안 화면이 갇혀
 * 버리면 예전의 "무한 기다림" 이 그대로 되살아난다. 그래서 세 가지를 본다.
 *
 *   ① 갇히면 "갇힘쉼" 으로 막히고, 눌러도 그 이유를 말해 준다(조용히 삼키지 않는다)
 *   ② 갇혔다는 창은 그 턴에 한 번만 뜬다 — state 가 5초마다 오는데 매번 뜨면 못 논다
 *   ③ 그 창은 스스로 닫힌다 — 닫히지 않으면 그게 곧 얼음이다
 *
 * 한계 — 진짜 브라우저가 아니다. 그리기·CSS 는 확인하지 못한다.
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";


// 경로에 한글이 있으면 URL.pathname 이 퍼센트 인코딩을 준다. fileURLToPath 로 되돌린다.

// 경로에 한글이 있으면 URL.pathname 이 퍼센트 인코딩을 준다. fileURLToPath 로 되돌린다.
import { fileURLToPath } from "node:url";
// 경로에 한글이 있으면 URL.pathname 이 퍼센트 인코딩을 준다. fileURLToPath 로 되돌린다.
const ROOT = fileURLToPath(new URL("../public", import.meta.url));

/** 무엇을 물어도 그럴듯하게 답하는 가짜 엘리먼트. */
function fakeEl(id = "") {
  const el = {
    id, textContent: "", innerHTML: "", value: "", disabled: false, style: { setProperty() {} },
    dataset: {}, timer: 0,
    classList: { _s: new Set(), add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); },
      contains(c) { return this._s.has(c); } },
    addEventListener() {}, removeEventListener() {},
    querySelectorAll() { return []; }, querySelector() { return null; },
    closest() { return null; }, appendChild() {}, focus() {},
    getBoundingClientRect() { return { width: 0, height: 0 }; },
  };
  return el;
}

const clickHandlers = {};
const els = new Map();
const byId = (id) => { if (!els.has(id)) els.set(id, fakeEl(id)); return els.get(id); };

const toasts = [];
const sent = [];

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
    addEventListener(type, fn) { (clickHandlers[type] ??= []).push(fn); },
    removeEventListener() {},
    createElement: () => fakeEl(),
    body: fakeEl("body"), documentElement: fakeEl("html"), hidden: false,
  },
  // 보낸 것을 기록만 하고 답은 주지 않는다 — "응답이 사라진" 상황을 만든다
  WebSocket: class { constructor() { this.readyState = 1; } send() {} close() {} addEventListener() {} },
  fetch: async () => { throw new Error("네트워크 없음"); },
  confirm: () => true, alert() {},
};
ctx.window = ctx;
ctx.globalThis = ctx;
vm.createContext(ctx);

// net.js 는 통째로 흉내 낸다. 우리가 볼 것은 app.js 의 갇힘 해제이지 전송 계층이 아니다.
vm.runInContext(`
  var NET = { code: null, hello: null, onMessage: null, mode: "ws", stopped: false };
  var netSendCalls = [];
  async function netSend(msg) { netSendCalls.push(msg); /* 답은 영영 오지 않는다 */ }
  function netOpen() {} function netClose() {} function netStatus() {}
  function netStart() {}
`, ctx);

const appSrc = readFileSync(`${ROOT}/app.js`, "utf8");
try {
  vm.runInContext(appSrc, ctx, { filename: "app.js" });
} catch (err) {
  console.error("app.js 를 불러오지 못했습니다:", err.message);
  process.exit(2);
}

// toast 를 가로채 무엇을 말했는지 본다
vm.runInContext(`
  APP.role = "student"; APP.playerId = "p1"; APP.rev = 1; APP.clockOffset = 0;
  var board = []; for (var i = 0; i < 9; i++) board.push({ t: "N", o: null });
  APP.state = {
    status: "running", turnTeam: "H", round: 3, turnEndsAt: Date.now() + 60000,
    rows: 3, cols: 3, board: board, cellLocks: {}, players: [],
    scores: { H: { total: 0 }, C: { total: 0 } },
    myPlayer: { id: "p1", name: "토끼", team: "H", pos: 4, playedThisTurn: false },
    iAmTrapped: true,
  };
  APP.mode = "waiting";
  var _said = []; toast = function (t) { _said.push(t); };
`, ctx);

const modalHidden = () =>
  vm.runInContext('document.getElementById("play-modal").classList.contains("hidden")', ctx);
const fail = (why) => { console.error(`\n❌ ${why}`); process.exit(1); };

// ① 막히는 이유가 "갇힘쉼" 인가
const why = vm.runInContext("blockReason()", ctx);
console.log("① 못 누르는 이유:", why);
if (why !== "갇힘쉼") fail(`갇혔는데 이유가 "${why}" 다 — 갇힘을 아무도 안 보고 있다.`);

// ② 눌렀을 때 이유를 말해 주는가. 조용히 삼키면 학생은 계속 누르며 기다린다.
vm.runInContext("selectCell(1)", ctx);
const said = vm.runInContext("_said.join(' | ')", ctx);
console.log("② 눌렀을 때 한 말:", said || "(아무 말 없음)");
if (!said.includes("갇혀서")) fail("갇힌 채로 눌렀는데 아무 말이 없다 — 2026-08-29 의 무한 기다림과 같은 모양이다.");
if (vm.runInContext("APP.mode", ctx) === "solving") fail("갇혔는데 solving 으로 들어갔다 — 여기서 얼어붙는다.");

// ③ 갇혔다는 창이 뜨는가
vm.runInContext("noticeTrapped()", ctx);
if (modalHidden()) fail("갇혔는데 알려 주는 창이 안 뜬다.");
console.log("③ 갇힘 창:", vm.runInContext('document.getElementById("result-big").textContent', ctx));

// ④ 같은 턴에 state 가 또 와도 다시 뜨지 않는가 (5초마다 온다)
vm.runInContext("closePlay(); noticeTrapped(); noticeTrapped();", ctx);
if (!modalHidden()) fail("같은 턴에 창이 다시 떴다 — 5초마다 뜨면 아무것도 못 한다.");
console.log("④ 같은 턴에 다시 부름: 안 뜬다");

// ⑤ 턴이 바뀌면 다시 알려 주는가
vm.runInContext("APP.state.round = 4; noticeTrapped();", ctx);
if (modalHidden()) fail("턴이 바뀌었는데도 안 알려 준다 — 두 번째 갇힘을 학생이 모른다.");
console.log("⑤ 다음 턴에 또 갇힘: 다시 알려 준다");

// ⑥ 그 창은 스스로 닫히는가
await new Promise((r) => setTimeout(r, 3400));
if (!modalHidden()) fail("갇힘 창이 안 닫힌다 — 이게 곧 얼음이다.");
console.log("⑥ 3.4초 뒤: 스스로 닫혔다");

// ⑦ 동점이면 "무승부 승리" 라고 하지 않는가 (2026-09-01 수업에서 실제로 그렇게 떴다)
vm.runInContext(`showGameOver({ t:"gameover", winner:"무승부", rounds:10, quizTitle:"국어",
  scores:{H:{total:42,territory:40,bonus:2},C:{total:42,territory:42,bonus:0}}, players:[] })`, ctx);
const crown = vm.runInContext('document.getElementById("info-body").innerHTML', ctx);
if (crown.includes("무승부 승리")) fail('동점인데 "무승부 승리" 라고 뜬다.');
console.log("⑦ 동점 화면:", crown.includes("무승부") ? "무승부 (승리 안 붙음)" : "무승부라는 말이 없다 ❓");

console.log("\n✅ 갇힘 규칙이 화면에서 제대로 돈다");
process.exit(0);
