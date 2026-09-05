/**
 * 효과음이 실제로 소리가 되는지 브라우저 없이 확인한다.
 *
 *   node tools/sfx-check.mjs
 *
 * 소리는 눈에 안 보인다. 그래서 틀려도 티가 안 난다 — 조용할 뿐이다.
 * 특히 Web Audio 에는 조용히 죽는 함정이 둘 있다.
 *   · exponentialRampToValueAtTime(0, …) 은 **예외를 던진다.** 소리 하나가 아니라
 *     그 소리 전체가 안 난다. 0 대신 0.0001 을 써야 한다.
 *   · 노드를 만들고 connect 를 안 하면 아무 일도 안 일어난다. 오류도 없다.
 *
 * 그래서 Web Audio 를 흉내 낸 가짜 오디오를 만들어 sfx.js 를 vm 안에서 돌리고,
 * 실제로 무엇이 울렸는지 **기록해서** 따진다.
 *
 * 한계 — 소리의 좋고 나쁨은 여기서 알 수 없다. 그건 사람이 sfx-preview.html 로 듣는다.
 * 여기서 보는 것은 "울리기는 하는가, 규칙을 어기지 않는가" 뿐이다.
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

// 경로에 한글이 있으면 URL.pathname 이 퍼센트 인코딩을 준다. fileURLToPath 로 되돌린다.
const ROOT = fileURLToPath(new URL("../public", import.meta.url));

/* ── 가짜 Web Audio ────────────────────────────────────────────────────────
 * 진짜와 다른 점은 소리를 내지 않는다는 것뿐이다. 부르는 순서·값은 그대로 적는다.
 */
function makeAudio(log) {
  const param = (name, node) => ({
    value: 0,
    setValueAtTime(v, t) { log.push({ k: "param", node, name, op: "set", v, t }); return this; },
    linearRampToValueAtTime(v, t) { log.push({ k: "param", node, name, op: "lin", v, t }); return this; },
    exponentialRampToValueAtTime(v, t) {
      // 진짜 브라우저는 0 이나 음수를 받으면 여기서 던진다. 그대로 흉내 낸다.
      if (v <= 0) throw new RangeError(`exponentialRampToValueAtTime(${v}) — 0 이하는 못 쓴다`);
      log.push({ k: "param", node, name, op: "exp", v, t });
      return this;
    },
  });

  let seq = 0;
  const mk = (type) => {
    const id = `${type}#${++seq}`;
    const n = {
      id, type: type === "osc" ? "sine" : undefined,
      connect(dst) { log.push({ k: "connect", from: id, to: dst && dst.id }); return dst; },
      disconnect() {},
    };
    if (type === "osc") {
      n.frequency = param("frequency", id);
      n.start = (t) => log.push({ k: "start", node: id, kind: "osc", t, wave: n.type });
      n.stop = (t) => log.push({ k: "stop", node: id, t });
    }
    if (type === "gain") n.gain = param("gain", id);
    if (type === "filter") {
      n.frequency = param("frequency", id);
      n.Q = { value: 1 };
      n.type = "lowpass";
    }
    if (type === "conv") n.buffer = null;   // 울림(ConvolverNode)
    if (type === "buffersrc") {
      n.buffer = null;
      n.start = (t) => log.push({ k: "start", node: id, kind: "noise", t });
      n.stop = (t) => log.push({ k: "stop", node: id, t });
    }
    return n;
  };

  class FakeCtx {
    constructor() {
      this.id = "ctx";
      this.state = "running";
      this.sampleRate = 48000;
      this.currentTime = 0;
      this.destination = { id: "dest", connect() {} };
    }
    createOscillator() { return mk("osc"); }
    createGain() { return mk("gain"); }
    createBiquadFilter() { return mk("filter"); }
    createBufferSource() { return mk("buffersrc"); }
    createConvolver() { return mk("conv"); }
    createBuffer(ch, len, rate) {
      if (!(len > 0)) throw new RangeError(`createBuffer 길이가 ${len} 이다`);
      const d = new Float32Array(len);
      return { length: len, sampleRate: rate, getChannelData: () => d };
    }
    resume() { this.state = "running"; }
  }
  return FakeCtx;
}

/** sfx.js 를 새 가짜 세상에서 한 번 돌리고, 그 안의 SFX 와 기록을 돌려준다. */
function load(opts = {}) {
  const log = [];
  const FakeCtx = makeAudio(log);
  const win = {
    AudioContext: opts.noAudio ? undefined : FakeCtx,
    webkitAudioContext: undefined,
    addEventListener() {},
    localStorage: {
      _d: opts.saved ? { "treasure.sfx": opts.saved } : {},
      getItem(k) { return this._d[k] ?? null; },
      setItem(k, v) { this._d[k] = String(v); },
    },
  };
  const ctx = {
    window: win, localStorage: win.localStorage,
    console, Math, Object, Array, Float32Array, Number, String, RangeError, Error,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(`${ROOT}/sfx.js`, "utf8"), ctx, { filename: "sfx.js" });

  // 스피커로 가는 마지막 관문(master)이 누구인지 미리 알아 둔다. 소리마다 여기까지
  // 실제로 이어졌는지 따지려면 이름이 필요하다.
  let master = null;
  if (win.SFX && !opts.noAudio) {
    win.SFX.unlock();                                   // 이때 master 가 만들어진다
    const toDest = log.find((e) => e.k === "connect" && e.to === "dest");
    master = toDest ? toDest.from : null;
  }
  return { SFX: win.SFX, log, win, master };
}

/**
 * 소리를 낸 노드가 **스피커까지 실제로 이어졌는지** 따진다.
 *
 * connect 를 한 번이라도 불렀는지만 보면 안 된다. osc→gain 까지만 잇고 gain→master 를
 * 빠뜨려도 connect 는 호출된다 — 그런데 소리는 안 난다. 오류도 안 난다.
 * 그래서 연결을 그래프로 세우고, 울린 노드마다 master 까지 길이 있는지 걸어 본다.
 */
function reachesSpeaker(conns, startId, master) {
  const edge = new Map();
  for (const c of conns) {
    if (!c.from) continue;
    if (!edge.has(c.from)) edge.set(c.from, []);
    edge.get(c.from).push(c.to);
  }
  const seen = new Set([startId]);
  const queue = [startId];
  while (queue.length) {
    const at = queue.shift();
    if (at === master || at === "dest") return true;
    for (const nx of edge.get(at) || []) if (nx && !seen.has(nx)) { seen.add(nx); queue.push(nx); }
  }
  return false;
}

/** 한 소리를 울리고, 그 동안 일어난 일만 잘라 낸다. */
function ring(SFX, log, name) {
  log.length = 0;
  SFX.play(name);
  const starts = log.filter((e) => e.k === "start");
  const stops = log.filter((e) => e.k === "stop");
  const conns = log.filter((e) => e.k === "connect");
  const freqs = log.filter((e) => e.k === "param" && e.name === "frequency").map((e) => e.v);
  const gains = log.filter((e) => e.k === "param" && e.name === "gain" && e.op !== "exp").map((e) => e.v);
  const last = stops.length ? Math.max(...stops.map((e) => e.t)) : 0;
  const first = starts.length ? Math.min(...starts.map((e) => e.t)) : 0;
  return { starts, stops, conns, freqs, gains, dur: last - first, peak: Math.max(0, ...gains) };
}

/* ── 검사 ─────────────────────────────────────────────────────────────────── */

const NEED = ["correct", "wrong", "treasure", "storm", "attack", "myturn", "tick", "claim", "gameover"];
// 소리마다 "이 정도 길이는 되어야/넘으면 안 된다". 수업에서 겪은 것을 숫자로 박아 둔다.
//  · tick 은 여러 번 울린다. 길면 소음이 된다.
//  · storm 은 벌이다. 너무 짧으면 벌처럼 안 들린다.
//  · correct 는 뒤에 다음 화면이 바로 온다. 길면 겹친다.
const RANGE = {
  correct:  [0.70, 1.30],
  wrong:    [0.50, 1.10],
  treasure: [0.90, 1.80],
  storm:    [1.40, 2.30],
  attack:   [0.50, 1.20],
  myturn:   [0.90, 1.80],
  tick:     [0.01, 0.12],
  claim:    [0.25, 0.70],
  gameover: [2.00, 3.40],
};

const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); return cond; };
const line = (mark, msg) => console.log(`  ${mark} ${msg}`);

console.log("\n효과음 검사\n");

/* ① 소리 목록 */
{
  const { SFX } = load();
  ok(SFX, "SFX 가 window 에 붙지 않았다");
  const missing = NEED.filter((n) => !SFX.names.includes(n));
  ok(missing.length === 0, `없는 소리: ${missing.join(", ")}`);
  line(missing.length ? "❌" : "✅", `소리 ${SFX.names.length}개 — ${SFX.names.join(", ")}`);
}

/* ② 소리마다: 울리는가 · 연결됐는가 · 길이가 맞는가 · 사람 귀에 들리는 음인가 */
{
  const { SFX, log, master } = load();
  SFX.setEnabled(true);
  console.log("");
  for (const name of NEED) {
    let r;
    try {
      r = ring(SFX, log, name);
    } catch (e) {
      fails.push(`${name}: 재생 중 예외 — ${e.message}`);
      line("❌", `${name} — 예외: ${e.message}`);
      continue;
    }
    const bad = [];
    if (r.starts.length === 0) bad.push("아무 소리도 안 난다");
    // 울린 노드가 스피커까지 닿는가. 중간에 한 마디만 빠져도 소리는 사라진다.
    const stranded = r.starts.filter((e) => !reachesSpeaker(r.conns, e.node, master));
    if (stranded.length) bad.push(`스피커까지 안 이어진 소리 ${stranded.length}개(무음)`);
    // 시작한 노드는 반드시 멈춰야 한다. 안 그러면 오실레이터가 영원히 남는다.
    if (r.stops.length !== r.starts.length) bad.push(`start ${r.starts.length} · stop ${r.stops.length} 불일치`);
    const [lo, hi] = RANGE[name];
    if (r.dur < lo || r.dur > hi) bad.push(`길이 ${r.dur.toFixed(2)}초 (기대 ${lo}~${hi})`);
    const outOfRange = r.freqs.filter((f) => f < 20 || f > 20000);
    if (outOfRange.length) bad.push(`가청 밖 주파수 ${outOfRange.map((f) => f.toFixed(0)).join(",")}`);
    if (r.peak > 0.5) bad.push(`한 소리가 너무 크다(${r.peak.toFixed(2)}) — 겹치면 찢어진다`);
    if (r.peak <= 0) bad.push("음량이 0 이다");

    if (bad.length) { fails.push(`${name}: ${bad.join(" / ")}`); line("❌", `${name} — ${bad.join(" / ")}`); }
    else line("✅", `${name} — 노드 ${r.starts.length}개 · ${r.dur.toFixed(2)}초 · 최대 ${r.peak.toFixed(2)}`);
  }
}

/* ③ 울림이 걸려 있는가
 * 울림 없는 소리는 "이게 뭐지" 싶게 얄팍하다(2026-09-05 확인). tick 만 예외다 —
 * 여러 번 울리는 소리라 울림을 키우면 소음이 된다.
 */
{
  const { SFX, log } = load();
  SFX.setEnabled(true);
  console.log("");
  let convMade = 0;
  const dry = [];
  for (const name of NEED) {
    log.length = 0;
    SFX.play(name);
    const sends = log.filter((e) => e.k === "connect" && String(e.to || "").startsWith("conv#"));
    if (name !== "tick" && sends.length === 0) dry.push(name);
    convMade = Math.max(convMade, log.filter((e) => String(e.from || "").startsWith("conv#")).length);
  }
  const good = ok(dry.length === 0, `울림이 안 걸린 소리: ${dry.join(", ")}`);
  line(good ? "✅" : "❌", "울림 — 모든 소리가 방 안에서 난다(tick 제외)");
}

/* ④ 한꺼번에 울려도 소리가 찢어지지 않는가
 * 게임에서 정답·점령·보물이 0.1초 안에 겹쳐 난다. 게인 합이 1 을 넘으면 클리핑이다.
 */
{
  const { SFX, log } = load();
  SFX.setEnabled(true);
  console.log("");
  const combos = [["correct", "treasure"], ["correct", "attack", "claim"], ["myturn", "tick"]];
  for (const combo of combos) {
    let sum = 0;
    for (const n of combo) sum += ring(SFX, log, n).peak;
    const good = ok(sum <= 1.0, `겹침 ${combo.join("+")} 게인 합 ${sum.toFixed(2)} > 1.0 — 찢어진다`);
    line(good ? "✅" : "❌", `겹쳐 울림 ${combo.join(" + ")} — 합 ${sum.toFixed(2)}`);
  }
}

/* ⑤ 소리를 끄면 정말 조용한가 */
{
  const { SFX, log } = load();
  SFX.setEnabled(false);
  log.length = 0;
  for (const n of NEED) SFX.play(n);
  const good = ok(log.length === 0, `껐는데 오디오 호출이 ${log.length}건 있었다`);
  line(good ? "✅" : "❌", "껐을 때 — 아무것도 울리지 않는다");
}

/* ⑥ 오디오가 없는 기기에서 게임이 죽지 않는가
 * 이 프로젝트의 제1 규칙이다. 소리는 절대 수업을 막지 않는다.
 */
{
  const { SFX } = load({ noAudio: true });
  let threw = null;
  try { SFX.setEnabled(true); for (const n of NEED) SFX.play(n); SFX.unlock(); }
  catch (e) { threw = e; }
  const good = ok(!threw, `AudioContext 없는 기기에서 예외 — ${threw && threw.message}`);
  line(good ? "✅" : "❌", "오디오 없는 기기 — 조용히 넘어간다");
}

/* ⑦ 없는 이름을 불러도 죽지 않는가 */
{
  const { SFX } = load();
  SFX.setEnabled(true);
  let threw = null;
  try { SFX.play("없는소리"); SFX.play(); SFX.play(null); } catch (e) { threw = e; }
  const good = ok(!threw, `없는 이름에 예외 — ${threw && threw.message}`);
  line(good ? "✅" : "❌", "없는 이름 — 조용히 넘어간다");
}

/* ⑧ 켬/끔 기억
 * 선생님 화면은 기본 켬, 학생은 기본 끔. 하지만 한 번이라도 사람이 정했으면 그게 이긴다.
 */
{
  const fresh = load();
  const good1 = ok(fresh.SFX.setDefault(true) === true, "기본 켬이 안 먹었다");
  const good2 = ok(load().SFX.setDefault(false) === false, "기본 끔이 안 먹었다");
  // 저장된 값이 있으면 기본값을 무시해야 한다
  const good3 = ok(load({ saved: "0" }).SFX.setDefault(true) === false, "껐던 기억보다 기본값이 이겼다");
  const good4 = ok(load({ saved: "1" }).SFX.setDefault(false) === true, "켰던 기억보다 기본값이 이겼다");
  const good = good1 && good2 && good3 && good4;
  line(good ? "✅" : "❌", "켬/끔 — 사람이 정한 것이 기본값을 이긴다");
}

/* ⑨ 깨어나기 전에는 억지로 소리내지 않는가
 * suspended 인 채로 소리를 밀어 넣으면 브라우저가 밀린 소리를 나중에 한꺼번에 터뜨린다.
 */
{
  const log = [];
  const FakeCtx = makeAudio(log);
  class Stuck extends FakeCtx { constructor() { super(); this.state = "suspended"; } resume() { /* 안 풀린다 */ } }
  const win = { AudioContext: Stuck, addEventListener() {}, localStorage: { _d: {}, getItem: () => null, setItem() {} } };
  const c = { window: win, localStorage: win.localStorage, console, Math, Object, Array, Float32Array, Number, String, RangeError, Error };
  c.globalThis = c;
  vm.createContext(c);
  vm.runInContext(readFileSync(`${ROOT}/sfx.js`, "utf8"), c, { filename: "sfx.js" });
  win.SFX.setEnabled(true);
  log.length = 0;
  win.SFX.play("correct");
  const good = ok(log.filter((e) => e.k === "start").length === 0, "잠긴 상태인데 소리를 밀어 넣었다");
  line(good ? "✅" : "❌", "아직 안 깨어남 — 소리를 쌓아 두지 않는다");
}

/* ⑩ 미리듣기 페이지가 실제 소리 목록과 맞는가 */
{
  const html = readFileSync(`${ROOT}/sfx-preview.html`, "utf8");
  const listed = [...html.matchAll(/id:"([a-z]+)"/g)].map((m) => m[1]);
  const missing = NEED.filter((n) => !listed.includes(n));
  const extra = listed.filter((n) => !NEED.includes(n));
  const good = ok(missing.length === 0 && extra.length === 0,
    `미리듣기 목록 어긋남 — 빠짐:${missing.join(",") || "없음"} 남음:${extra.join(",") || "없음"}`);
  line(good ? "✅" : "❌", `미리듣기 페이지 — ${listed.length}개 모두 실제 소리와 맞는다`);
}

/* ⑪ 미리듣기의 샘플 찾기가 폴백 페이지에 속지 않는가
 * wrangler 가 없는 파일에도 index.html 을 200 으로 준다(not_found_handling).
 * status 만 보면 샘플이 다 있는 줄 알고 버튼이 전부 켜진다 — 2026-09-05 에 실제로 그랬다.
 */
{
  const html = readFileSync(`${ROOT}/sfx-preview.html`, "utf8");
  const good = ok(/content-type/i.test(html) && /text\/html/.test(html),
    "샘플 찾기가 Content-Type 을 안 본다 — 없는 파일도 있다고 판정한다");
  line(good ? "✅" : "❌", "샘플 찾기 — 폴백 페이지를 소리로 착각하지 않는다");
}

/* ⑫ 게임이 실제로 소리를 부르는가
 * sfx.js 가 아무리 멀쩡해도 app.js 가 안 부르면 교실에서는 조용하다.
 * 어느 소리가 어디서 울려야 하는지를 여기 박아 둔다.
 */
{
  const app = readFileSync(`${ROOT}/app.js`, "utf8");
  const html = readFileSync(`${ROOT}/index.html`, "utf8");

  // sfx("x") · sfxSlow("x", 450) · sfx(cond ? "x" : "y") 를 모두 잡는다
  const silent = NEED.filter((n) => !new RegExp(`sfx(Slow)?\\([^)]*"${n}"`).test(app));
  // 보물·폭풍·공격은 showItemFx 가 kind 를 받아 한 줄로 낸다 — 이름이 직접 안 적힌다.
  const viaKind = ["treasure", "storm", "attack"];
  const reallySilent = silent.filter((n) => !(viaKind.includes(n) && /sfx\(kind\)/.test(app)));
  const good1 = ok(reallySilent.length === 0, `게임이 안 부르는 소리: ${reallySilent.join(", ")}`);
  line(good1 ? "✅" : "❌", "게임 연결 — 소리 9개가 모두 불린다");

  // sfx.js 가 app.js 보다 **먼저** 실려야 한다. 뒤면 setupSfx 에서 window.SFX 가 없다.
  const iSfx = html.indexOf("/sfx.js");
  const iApp = html.indexOf("/app.js");
  const good2 = ok(iSfx > 0 && iSfx < iApp, "index.html 에서 sfx.js 가 app.js 보다 늦게 실린다");
  line(good2 ? "✅" : "❌", "싣는 순서 — sfx.js 가 app.js 보다 먼저");

  // 판번호 세 곳이 어긋나면 브라우저가 옛 화면을 문다. 이 프로젝트의 단골 사고다.
  const vApp = (app.match(/APP_BUILD = "([^"]+)"/) || [])[1];
  const vHtml = (html.match(/\?v=([0-9a-z-]+)/) || [])[1];
  const vDiag = (readFileSync(fileURLToPath(new URL("../src/diagnose.ts", import.meta.url)), "utf8")
    .match(/BUILD = "([^"]+)"/) || [])[1];
  const good3 = ok(vApp && vApp === vHtml && vApp === vDiag,
    `판번호 어긋남 — app.js:${vApp} index.html:${vHtml} diagnose.ts:${vDiag}`);
  line(good3 ? "✅" : "❌", `판번호 — 세 곳 모두 ${vApp}`);
}

/* ── 끝 ───────────────────────────────────────────────────────────────────── */
console.log("");
if (fails.length) {
  console.log(`❌ ${fails.length}건 실패\n`);
  for (const f of fails) console.log(`   · ${f}`);
  console.log("");
  process.exit(1);
}
console.log("✅ 모두 통과\n");
