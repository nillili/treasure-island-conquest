/**
 * 공격권(땅 빼앗기) 화면이 제대로 도는지 브라우저 없이 확인한다.
 *
 *   node tools/steal-check.mjs
 *
 * 2026-08-29 수업에서 "상대 칸을 눌러도 안 된다 · 무한 기다림" 이 나왔다.
 * 원인은 고르기 중에 **모든 클릭을 뺏기로 보내** 학생이 아무것도 못 하게 된 것이었다.
 *
 * 확인하는 것
 *   ① 상대 땅을 누르면 steal 이 나가는가
 *   ② 고르기 중에도 임자 없는 칸은 평소대로 도전되는가 (여기서 갇혔었다)
 *
 * 한계 — 진짜 브라우저가 아니다. 그리기·CSS·실제 클릭은 확인하지 못한다.
 * 여기서 통과해도 화면이 이상할 수 있다. 다만 "갇힘" 만은 여기서 잡힌다.
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";


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

// 공격권을 얻은 상태를 만든다 — 홍팀이고, 청팀 땅이 판에 있다
vm.runInContext(`
  APP.role = "student";
  APP.playerId = "p1";
  APP.rev = 1;
  APP.mode = "waiting";
  APP.clockOffset = 0;
  var board = [];
  for (var i = 0; i < 9; i++) board.push({ t: "N", o: null });
  board[8] = { t: "N", o: "C" };   // 8번 칸이 청팀(상대) 땅
  APP.state = {
    status: "running", turnTeam: "H", turnEndsAt: Date.now() + 60000,
    rows: 3, cols: 3, board: board,
    cellLocks: {}, players: [], scores: {H:{total:0},C:{total:0}},
    myPlayer: { id: "p1", name: "거북이", team: "H", pos: 4, playedThisTurn: true },
  };
`, ctx);

const said = () => JSON.parse(vm.runInContext("JSON.stringify(_said)", ctx));
const sent2 = () => JSON.parse(vm.runInContext("JSON.stringify(netSendCalls)", ctx));

// toast 를 가로챈다
vm.runInContext(`var _said = []; toast = function (t) { _said.push(t); };`, ctx);

console.log("① 공격권 받기 전:", vm.runInContext("APP.stealing", ctx));

vm.runInContext("startStealing()", ctx);
console.log("② startStealing 뒤 APP.stealing:", vm.runInContext("APP.stealing", ctx));
if (vm.runInContext("APP.stealing", ctx) !== true) { console.error("❌ 고르기로 못 들어갔다"); process.exit(1); }

// 상대 땅(8번)을 누른다
vm.runInContext("takeCell(8)", ctx);
await new Promise((r) => setTimeout(r, 200));

const out = sent2();
console.log("③ 상대 땅 클릭 → 서버로 보낸 것:", JSON.stringify(out));
console.log("   안내:", JSON.stringify(said()));

const stealMsg = out.find((m) => m.t === "steal");
if (!stealMsg) { console.error("\n❌ steal 요청이 안 나갔다 — 이게 선생님이 겪은 증상이다"); process.exit(1); }
if (stealMsg.cell !== 8) { console.error(`\n❌ 엉뚱한 칸을 보냈다: ${stealMsg.cell}`); process.exit(1); }

// 내 땅을 누르면 거절해야 한다
vm.runInContext("APP.stealing = true; takeCell(0)", ctx);
await new Promise((r) => setTimeout(r, 100));
const after = sent2().filter((m) => m.t === "steal");
console.log(`④ 임자 없는 칸 클릭 → steal 요청 ${after.length}건 (1이어야 정상)`);

console.log("\n── 여기까지는 takeCell 을 직접 부른 것. 이제 진짜 '클릭' 을 재현한다 ──");

// 판 위의 칸을 흉내 낸 요소. 브라우저의 closest 처럼 동작한다.
function cellEl(idx) {
  const el = fakeEl(`cell-${idx}`);
  el.dataset = { cell: String(idx) };
  el.closest = (sel) => (sel === "[data-cell]" ? el : null);
  el.classList._s.add("cell");
  return el;
}

vm.runInContext("netSendCalls.length = 0; APP.stealing = true; _said.length = 0;", ctx);
const handlers = clickHandlers.click ?? [];
console.log(`⑤ 문서에 걸린 click 처리기: ${handlers.length}개`);
if (!handlers.length) { console.error("❌ click 처리기가 없다"); process.exit(1); }

for (const fn of handlers) await fn({ target: cellEl(8) });
await new Promise((r) => setTimeout(r, 200));

const clicked = sent2().filter((m) => m.t === "steal");
console.log("⑥ 상대 땅(8번)을 '클릭' → steal 요청:", JSON.stringify(clicked));
console.log("   안내:", JSON.stringify(said()));

if (!clicked.length) {
  console.error("\n❌ 클릭이 takeCell 까지 못 갔다 — 선생님이 겪은 바로 그 증상");
  process.exit(1);
}
console.log("\n── 이제 핵심: 고르기 중에도 평소처럼 놀 수 있는가 ──");

// 고르기 중에 '임자 없는 칸' 을 누른다. 예전에는 여기서 갇혔다.
vm.runInContext(`
  netSendCalls.length = 0; _said.length = 0;
  APP.stealing = true; APP.mode = "waiting";
  APP.state.myPlayer.playedThisTurn = false;
  APP.state.turnEndsAt = Date.now() + 60000;
`, ctx);

for (const fn of handlers) await fn({ target: cellEl(1) });   // 1번 = 임자 없는 칸
await new Promise((r) => setTimeout(r, 200));

const normal = sent2();
console.log("⑦ 고르기 중 빈 칸 클릭 → 보낸 것:", JSON.stringify(normal));
console.log("   안내:", JSON.stringify(said()));

const picked = normal.find((m) => m.t === "pick");
if (!picked) {
  console.error("\n❌ 고르기 중에는 평소 도전을 못 한다 — 학생이 갇힌다");
  process.exit(1);
}

// 그리고 상대 땅은 여전히 뺏기로 가야 한다
vm.runInContext(`netSendCalls.length = 0; APP.mode = "waiting"; APP.state.myPlayer.playedThisTurn = false;`, ctx);
for (const fn of handlers) await fn({ target: cellEl(8) });
await new Promise((r) => setTimeout(r, 200));
const again = sent2().find((m) => m.t === "steal");
console.log("⑧ 고르기 중 상대 땅 클릭 → steal:", JSON.stringify(again ?? null));
if (!again) { console.error("\n❌ 상대 땅이 뺏기로 안 간다"); process.exit(1); }

console.log("\n✅ 상대 땅은 뺏기로, 나머지는 평소대로 — 갇히지 않는다");
process.exit(0);
