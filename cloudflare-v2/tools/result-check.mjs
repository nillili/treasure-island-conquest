/**
 * "정답!" 창이 얼어붙지 않는지 브라우저 없이 확인한다.
 *
 *   node tools/result-check.mjs
 *
 * 2026-08-29 수업에서 결과창이 뜬 채 게임으로 못 돌아가는 일이 있었다.
 * 결과창은 3초 뒤 스스로 닫히는데, 그 사이 턴이 바뀌면 sync 응답(state)이 와서
 * APP.mode 를 밀어내고, 닫기 타이머가 "내 창이 아니네" 하며 되돌아가 창이 영영 남았다.
 *
 * 확인하는 것 — 결과창이 떠 있는 동안 state 가 도착해도 제때 닫히는가.
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
  var _said = [];
  var _origToast = toast;
  toast = function (t) { _said.push(t); };
`, ctx);

// 평범한 칸을 맞힌 직후 — "정답!" 창이 뜬 상태를 만든다
vm.runInContext(`
  APP.role = "student"; APP.playerId = "p1"; APP.rev = 1; APP.clockOffset = 0;
  var board = []; for (var i = 0; i < 9; i++) board.push({ t: "N", o: null });
  APP.state = {
    status: "running", turnTeam: "H", turnEndsAt: Date.now() + 60000,
    rows: 3, cols: 3, board: board, cellLocks: {}, players: [],
    scores: { H: { total: 0 }, C: { total: 0 } },
    myPlayer: { id: "p1", name: "토끼", team: "H", pos: 4, playedThisTurn: false },
  };
  APP.mode = "solving"; APP.currentCell = 1;
  var _said = []; toast = function (t) { _said.push(t); };
`, ctx);

const modalHidden = () =>
  vm.runInContext('document.getElementById("play-modal").classList.contains("hidden")', ctx);

// 채점 결과가 온다 (아이템 아님, +1점)
vm.runInContext(`showResult({ t:"result", correct:true, gain:1, bonus:0, cellType:"N",
  answerText:"월요일", stolen:null, stealGranted:false, playedThisTurn:true })`, ctx);
console.log("① 결과창 떴나:", modalHidden() ? "안 떴다 ❌" : "떴다");

// ★ 여기가 문제였다 — 3초를 기다리는 동안 턴이 바뀌고, 그 뒤 sync 응답(state)이 온다.
// state 는 APP.mode 를 "waiting" 으로 밀고, render() 가 다시 "select" 로 만든다.
await new Promise((r) => setTimeout(r, 400));
vm.runInContext(`onMessage({
  t: "state", stateRev: APP.rev + 1, status: "running", turnTeam: "H", round: 1,
  turnEndsAt: Date.now() + 60000, rows: 3, cols: 3,
  board: APP.state.board, cellLocks: {}, players: [],
  scores: { H:{total:1}, C:{total:0} }, presence: [], log: [],
  myPlayer: { id:"p1", name:"토끼", team:"H", pos:4, playedThisTurn:false },
})`, ctx);
console.log("② 턴이 바뀌어 state 도착 · 그때 APP.mode:", vm.runInContext("APP.mode", ctx));

// 결과창이 스스로 닫히는지 본다
await new Promise((r) => setTimeout(r, 3400));
const hidden = modalHidden();
console.log("③ 3.8초 뒤 결과창:", hidden ? "닫혔다" : "아직 떠 있다");

if (!hidden) {
  console.error("\n❌ '정답!' 에서 얼음 — 선생님이 겪은 그 증상");
  process.exit(1);
}
console.log("\n✅ 남이 답해도 결과창은 제때 닫힌다");
process.exit(0);
