/**
 * 학생 화면이 갇히지 않는지 브라우저 없이 확인한다.
 *
 *   node tools/freeze-check.mjs
 *
 * 2026-08-29 수업에서 학생 둘이 "눌러도 문제가 안 뜬다" 로 멈췄다. 원인은 서버가
 * 아니라 화면이었는데, 이 프로젝트에는 화면을 시험할 도구가 없어 사람 눈으로만
 * 확인해야 했다. 그래서 최소한의 DOM 흉내를 만들어 app.js 를 vm 안에서 돌린다.
 *
 * 확인하는 것 — pick 을 보냈는데 답이 영영 오지 않을 때
 *   ① 갇힌 동안 또 눌러도 아무 말 없이 삼키지 않는가
 *   ② 5초 뒤 스스로 풀려나는가
 *   ③ 풀린 뒤 실제로 다시 누를 수 있는가(요청이 나가는가)
 *
 * 한계 — 진짜 브라우저가 아니다. 그리기·CSS·실제 클릭은 확인하지 못한다.
 * 여기서 통과해도 화면이 이상할 수 있다. 다만 "갇힘" 만은 여기서 잡힌다.
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";

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
    addEventListener() {}, removeEventListener() {},
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

// 학생이 자기 차례인 상태를 만든다
vm.runInContext(`
  APP.role = "student";
  APP.playerId = "p1";
  APP.rev = 1;
  APP.mode = "waiting";
  APP.clockOffset = 0;
  APP.state = {
    status: "running", turnTeam: "H", turnEndsAt: Date.now() + 60000,
    rows: 3, cols: 3, board: Array.from({length:9},()=>({t:"N",o:null})),
    cellLocks: {}, players: [], scores: {H:{total:0},C:{total:0}},
    myPlayer: { id: "p1", name: "테스트", team: "H", pos: 4, playedThisTurn: false },
  };
`, ctx);

const modeNow = () => vm.runInContext("APP.mode", ctx);
const saidNow = () => vm.runInContext("JSON.stringify(_said)", ctx);
const callsNow = () => vm.runInContext("netSendCalls.length", ctx);

console.log("① 처음 상태:", modeNow(), "· canPlay:", vm.runInContext("canPlay()", ctx));
if (modeNow() !== "waiting") { console.error("❌ 시작 상태가 waiting 이 아니다"); process.exit(1); }

// 칸을 누른다 — 서버는 영영 답하지 않는다
vm.runInContext("selectCell(1)", ctx);
await new Promise((r) => setTimeout(r, 100));
console.log("② 누른 직후:", modeNow(), "· 보낸 것", callsNow(), "건");
if (modeNow() !== "solving") { console.error("❌ solving 으로 안 갔다"); process.exit(1); }

// 갇힌 동안 또 눌러 본다 — 예전에는 아무 말이 없었다
vm.runInContext("selectCell(2)", ctx);
await new Promise((r) => setTimeout(r, 50));
const midSaid = JSON.parse(saidNow());
console.log("③ 갇힌 동안 또 누름 → 안내:", midSaid.length ? `"${midSaid[midSaid.length-1]}"` : "(없음 ← 예전 버그)");
if (!midSaid.length) { console.error("❌ 침묵하는 거절이 아직 남아 있다"); process.exit(1); }

// 5초를 기다린다
console.log("④ 5.5초 기다리는 중…");
await new Promise((r) => setTimeout(r, 5500));
const after = modeNow();
const said = JSON.parse(saidNow());
console.log("⑤ 5.5초 뒤:", after, "· 마지막 안내:", said.length ? `"${said[said.length-1]}"` : "(없음)");

// render() 는 고를 수 있는 상태를 "select" 로 표시한다. 갇힘만 아니면 된다.
if (after === "solving") { console.error(`\n❌ 아직 갇혀 있다 (mode=${after})`); process.exit(1); }

// 진짜 확인 — 다시 누르면 실제로 새 요청이 나가는가
const before = callsNow();
vm.runInContext("selectCell(3)", ctx);
await new Promise((r) => setTimeout(r, 100));
const now2 = callsNow();
console.log(`⑥ 다시 누름 → 서버로 나간 요청 ${before} → ${now2}건`);
if (now2 <= before) { console.error("\n❌ 풀린 척만 하고 실제로는 못 누른다"); process.exit(1); }

console.log("\n✅ 스스로 풀려났고, 다시 누르니 요청이 나간다");
process.exit(0); // app.js 의 타이머가 계속 돌아 저절로 끝나지 않는다
