/**
 * 방 만들기 화면의 "인원만 넣으면 다 잡힌다"가 진짜로 맞는 판을 짜는지 확인한다.
 *
 *   node tools/plan-check.mjs
 *
 * 이 판정은 public/app.js 안에만 있다. 서버는 화면이 보낸 값을 검사만 할 뿐이라,
 * 화면이 서버가 거절할 값을 짜 놓으면 선생님은 [방 만들기] 를 누르고 나서야 알게 된다.
 * 그래서 여기서는 **서버 코드(src/game.ts, src/rooms.ts)를 직접 불러와** 대조한다.
 *
 * 확인하는 것
 *   ① 9명은 12×12 · 10판 · 📦8 ⛈️12 💥12  — 선생님이 좋다고 한 그 판
 *   ② 2~30명 어느 인원이든 서버가 거절하지 않는다 (판 크기 · 정원 · 특수칸 수)
 *   ③ 끝났을 때 점령률이 35~66% 안에 든다 — 헐렁하지도 마르지도 않는다
 *   ④ 16명까지는 10판, 19명부터 판수가 줄어든다
 *   ⑤ 23명은 7판, 30명은 6판 — 사람이 많아도 6판 아래로는 안 내려간다
 *   ⑥ 화면이 쓰는 정원 식이 서버의 maxPlayers 와 한 글자도 다르지 않다
 *
 * 한계 — 진짜 브라우저가 아니다. 입력 칸이 실제로 갱신되는지는 눈으로 봐야 한다.
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";
// 경로에 한글이 있으면 URL.pathname 이 퍼센트 인코딩을 준다. fileURLToPath 로 되돌린다.
import { fileURLToPath } from "node:url";

const HERE = (rel) => fileURLToPath(new URL(rel, import.meta.url));

// 서버 쪽 진짜 규칙. 노드 24 는 .ts 를 그대로 읽는다.
const { maxPlayers, MIN_SIDE, MAX_SIDE, checkBoardSize } = await import(HERE("../src/game.ts"));

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
  vm.runInContext(readFileSync(HERE("../public/app.js"), "utf8"), ctx, { filename: "app.js" });
} catch (err) {
  console.error("app.js 를 불러오지 못했습니다:", err.message);
  process.exit(2);
}

/** planFor 는 app.js 안의 const 라 컨텍스트 객체에 없다. 안에서 불러 결과만 꺼낸다. */
function plan(players, rounds = 10) {
  ctx.__n = players; ctx.__r = rounds;
  return vm.runInContext("planFor(__n, __r)", ctx);
}
const mirrorCap = (rows, cols, rounds) => {
  ctx.__a = rows; ctx.__b = cols; ctx.__c = rounds;
  return vm.runInContext("maxPlayers(__a, __b, __c)", ctx);
};

let bad = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "✅" : "❌"} ${label}` + (ok ? "" : `\n     나온 것 ${JSON.stringify(got)}\n     바란 것 ${JSON.stringify(want)}`));
  if (!ok) bad += 1;
};

// ① 선생님이 좋다고 한 그 판
check("9명 → 12×12 · 10판 · 📦8 ⛈️12 💥12", plan(9),
  { rows: 12, cols: 12, rounds: 10, cntT: 8, cntS: 12, cntA: 12 });

// ⑥ 정원 식이 서버와 같은가 — 8/29 규칙 변경 때 화면만 옛 식으로 남아 60명이라고 안내했었다
const capOff = [];
for (let s = MIN_SIDE; s <= MAX_SIDE; s++) {
  for (const r of [1, 5, 7, 10, 15, 20, 30]) {
    if (mirrorCap(s, s, r) !== maxPlayers(s, s, r)) capOff.push(`${s}×${s}/${r}판`);
  }
}
check("화면의 정원 식이 서버 maxPlayers 와 같다", capOff, []);

// ②③ 2~30명 전부 — 서버가 거절하지 않고, 점령률이 상식 범위에 든다
const rejected = [];
const outOfRange = [];
const tooEmpty = [];
const tooShort = [];
for (let n = 2; n <= 30; n++) {
  const p = plan(n);
  const cells = p.rows * p.cols;
  const fill = (n * (1 + 0.65 * p.rounds)) / cells;
  const specials = p.cntT + p.cntS + p.cntA;

  if (checkBoardSize(p.rows, p.cols)) rejected.push(`${n}명 판크기: ${checkBoardSize(p.rows, p.cols)}`);
  if (p.rounds < 1 || p.rounds > 30) rejected.push(`${n}명 판수 ${p.rounds}`);
  if (maxPlayers(p.rows, p.cols, p.rounds) < n) rejected.push(`${n}명 정원초과(${maxPlayers(p.rows, p.cols, p.rounds)}명)`);
  if (specials >= cells) rejected.push(`${n}명 특수칸 ${specials}/${cells}`);
  if (p.cntT < 0 || p.cntS < 0 || p.cntA < 0) rejected.push(`${n}명 특수칸 음수`);

  // 넘치는 쪽은 게임이 깨지므로 전 구간에서 막는다.
  if (fill > 0.66) outOfRange.push(`${n}명 ${Math.round(fill * 100)}%`);
  // 4판짜리는 수업이 아니다. 인원이 아무리 많아도 6판은 준다.
  if (p.rounds < 6) tooShort.push(`${n}명 ${p.rounds}판`);
  // 모자란 쪽은 판을 10×10 아래로 못 줄여서 생기는 한계다. 5명부터는 안 생겨야 한다.
  if (n >= 5 && fill < 0.35) tooEmpty.push(`${n}명 ${Math.round(fill * 100)}%`);
}
check("2~30명 어느 인원이든 서버가 거절하지 않는다", rejected, []);
check("점령률이 66% 를 넘는 인원이 없다 — 판이 마르지 않는다", outOfRange, []);
check("어떤 인원이든 6판 아래로는 안 줄인다", tooShort, []);
check("5명부터는 점령률이 35% 아래로 안 떨어진다", tooEmpty, []);

// ④ 큰 반에서 판수가 줄어든다
const rounds = {};
for (const n of [10, 15, 16, 19, 20, 23, 26, 30]) rounds[n] = plan(n).rounds;
check("16명까지는 10판", [rounds[10], rounds[15], rounds[16]], [10, 10, 10]);
check("19명부터 판수가 줄어든다", [rounds[19] < 10, rounds[20] < 10, rounds[23] < 10], [true, true, true]);

// ⑤ 선생님이 못 박은 두 지점
check("23명은 7판", rounds[23], 7);
check("30명은 6판", rounds[30], 6);

// 선생님이 일부러 짧게 잡아 둔 판수는 늘리지 않는다
check("30명인데 판수를 3으로 잡아 뒀으면 그대로 3판", plan(30, 3).rounds, 3);

// 특수칸이 인원(=판 크기·판수)에 따라 실제로 늘어나는가
const dense = (n) => { const p = plan(n); return (p.cntT + p.cntS + p.cntA) / (p.rows * p.cols); };
check("인원이 늘면 특수칸도 촘촘해진다", [dense(9) < dense(20), dense(20) < dense(30)], [true, true]);

// 손으로 판수를 늘리면 판도 따라 커진다
check("9명이 20판을 하면 판이 더 커진다", plan(9, 20).rows > plan(9, 10).rows, true);

console.log("\n  인원별로 짜인 판");
console.log(`  ${"인원".padEnd(6)}${"판".padEnd(8)}${"판수".padEnd(6)}${"📦".padEnd(5)}${"⛈️".padEnd(5)}${"💥".padEnd(5)}${"점령률".padEnd(7)}정원`);
for (const n of [4, 6, 9, 10, 12, 14, 16, 17, 20, 23, 26, 30]) {
  const p = plan(n);
  const fill = (n * (1 + 0.65 * p.rounds)) / (p.rows * p.cols);
  console.log(`  ${String(n).padEnd(6)}${`${p.rows}×${p.cols}`.padEnd(8)}${String(p.rounds).padEnd(6)}`
    + `${String(p.cntT).padEnd(5)}${String(p.cntS).padEnd(5)}${String(p.cntA).padEnd(5)}`
    + `${`${Math.round(fill * 100)}%`.padEnd(7)}${maxPlayers(p.rows, p.cols, p.rounds)}명`);
}

if (bad) {
  console.error(`\n❌ ${bad}가지가 어긋납니다 — 선생님이 못 쓰는 판이 만들어집니다.`);
  process.exit(1);
}
console.log("\n✅ 인원만 넣으면 서버가 받아 주는 판이 나옵니다.");
process.exit(0); // app.js 가 걸어 둔 연출 타이머가 뒤에서 계속 돌기 때문에 여기서 끝낸다.
