"use strict";
/**
 * 화면.
 *
 * 지키는 규칙 — 이 프로젝트에서 난 사고의 절반이 이걸 안 지켜서 생겼다.
 *  ① 화면은 아무것도 기억하지 않는다. 서버가 보낸 것만 그린다.
 *     문제도 미리 받아 두지 않는다. 칸을 고른 그 순간 서버가 보내 준다.
 *  ② stateRev 가 건너뛰면 즉시 전체를 다시 받는다(sync). 중복은 그냥 무시한다.
 *  ③ 변경 명령에는 actionId 를 붙이고, 다시 보낼 때는 같은 값을 쓴다.
 *  ④ 선생님 버튼은 절대 비활성화하지 않는다. 눌러도 반응 없는 버튼 앞에서
 *     교사가 할 수 있는 일이 없어진다(2026-08-05 시연).
 *  ⑤ 막히면 왜 막혔는지 말해 준다.
 */
const APP = {
  role: null, // "student" | "teacher"
  code: null,
  playerId: null,
  state: null,
  rev: -1,
  mode: "waiting", // waiting | select | solving | result
  currentCell: null,
  submitting: false,
  syncing: false,
  stealing: false, // 공격권을 얻어 "어디를 가져올까" 고르는 중
  clockOffset: 0,
  sets: [],
  teacher: null,
};

/** 서버의 BUILD 와 같아야 한다. 다르면 브라우저가 옛 화면을 물고 있는 것이다. */
const APP_BUILD = "2026-09-04b";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const ICON = { N: "", T: "📦", S: "⛈️", A: "💥" };

/** 남은 시간은 반드시 이걸로 잰다. 학생 PC 시계가 틀어져도 정상 동작한다. */
const now = () => Date.now() + APP.clockOffset;
const newActionId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(el.timer);
  el.timer = setTimeout(() => el.classList.remove("show"), 3000);
}

/**
 * 서버 답을 기다리며 화면을 잠가 두는 시간의 한계.
 *
 * 2026-08-29 수업에서 학생 둘이 여기 갇혔다(민서 3라운드, 미소 7분).
 * pick 을 보내고 mode 를 "solving" 으로 바꾼 뒤 문제가 영영 오지 않으면,
 * 그 뒤의 모든 클릭이 selectCell 첫 줄에서 조용히 되돌아간다.
 * 화면은 녹색 테두리로 "고르세요" 라고 말하는데 눌리지는 않는다.
 * 서버에는 요청이 한 건도 오지 않으므로 선생님도 알아챌 방법이 없다.
 */
const REPLY_TIMEOUT_MS = 5000;

let stuckTimer = 0;
let syncGuard = 0;

/** 보낸 것의 답이 제때 오는지 지켜본다. 안 오면 스스로 풀어 준다. */
function watchReply(what) {
  clearTimeout(stuckTimer);
  stuckTimer = setTimeout(() => {
    if (APP.mode !== "solving") return; // 제때 왔다
    unstick(`${what} 응답이 늦어요. 다시 눌러 보세요.`);
  }, REPLY_TIMEOUT_MS);
}
const replyArrived = () => clearTimeout(stuckTimer);

/**
 * 갇힘을 푼다 — 화면을 고를 수 있는 상태로 되돌리고 왜 그런지 말해 준다.
 * 학생이 이유를 모른 채 같은 칸을 계속 누르는 일이 없어야 한다.
 */
function unstick(why) {
  clearTimeout(stuckTimer);
  APP.mode = "waiting";
  APP.currentCell = null;
  APP.submitting = false;
  hideQuiz();
  toast(why);
  render();
}

// 조용한 죽음을 없앤다. 처리되지 않은 예외 하나가 화면을 굳혀 놓고도 아무 말이
// 없으면, 학생은 눌러도 안 되는 화면 앞에서 이유를 알 수 없다.
addEventListener("unhandledrejection", (event) => {
  console.error("처리되지 않은 오류", event.reason);
  if (APP.role === "student" && APP.mode === "solving") unstick("문제가 생겼어요. 다시 눌러 보세요.");
});
addEventListener("error", (event) => console.error("화면 오류", event.error || event.message));

function showScreen(id) {
  for (const s of document.querySelectorAll(".screen")) s.classList.toggle("hidden", s.id !== id);
}
const openModal = (id) => $(id).classList.remove("hidden");
const closeModal = (id) => $(id).classList.add("hidden");

async function api(path, options = {}) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) throw new Error(body.error || "요청에 실패했습니다.");
  return body;
}

// ── 좌표 ────────────────────────────────────────────────────────────────────
function colLabel(c) {
  let s = "";
  let n = c + 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
const cellLabel = (i, cols) => colLabel(i % cols) + (Math.floor(i / cols) + 1);
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

// ── 왜 못 누르는지 ──────────────────────────────────────────────────────────
function blockReason() {
  const st = APP.state;
  if (!st) return "상태없음";
  if (st.status !== "running") return st.status === "ended" ? "게임종료" : "시작전";
  if (!st.myPlayer) return "관전";
  if (st.turnTeam !== st.myPlayer.team) return "상대팀턴";
  if (st.iAmSkipping) return "폭풍쉼";
  if (st.iAmTrapped) return "갇힘쉼";
  if (st.myPlayer.playedThisTurn) return "이번턴완료";
  if (now() >= (st.turnEndsAt || 0)) return "시간초과";
  return "";
}
const canPlay = () => !blockReason();

// ── 그리기 ──────────────────────────────────────────────────────────────────
function renderBoard(hostId, admin) {
  const st = APP.state;
  if (!st || !st.board) return;
  const host = $(hostId);
  const px = Math.max(23, Math.min(admin ? 45 : 42, Math.floor((innerWidth - (admin ? 330 : 300)) / (st.cols + 1))));
  host.style.setProperty("--cell", `${px}px`);
  host.style.gridTemplateColumns = `repeat(${st.cols + 1},${px}px)`;

  const pawns = {};
  for (const p of st.players) if (p.pos !== null) (pawns[p.pos] ??= []).push(p);

  const me = st.myPlayer;
  const candidates = {};
  if (!admin && me && me.pos !== null && canPlay() && APP.mode !== "solving") {
    for (const i of neighbors(me.pos, st.rows, st.cols)) {
      if (st.cellLocks[i]) continue;
      // 2026-08-29 규칙 — 상대가 먹은 땅은 도전 대상이 아니다. 아군 칸은 이동만 된다.
      if (st.board[i].o === me.team) candidates[i] = "move";
      else if (!st.board[i].o) candidates[i] = "can";
    }
  }

  // 공격으로 가져올 수 있는 칸 — 판 전체의 상대 땅
  const stealable = {};
  if (!admin && me && APP.stealing) {
    const enemy = me.team === "H" ? "C" : "H";
    st.board.forEach((c, i) => { if (c.o === enemy) stealable[i] = true; });
  }

  let html = '<div class="axis"></div>';
  for (let c = 0; c < st.cols; c++) html += `<div class="axis">${colLabel(c)}</div>`;
  for (let r = 0; r < st.rows; r++) {
    html += `<div class="axis">${r + 1}</div>`;
    for (let c = 0; c < st.cols; c++) {
      const i = r * st.cols + c;
      const cell = st.board[i];
      const cls = ["cell"];
      if (cell.o) cls.push(cell.o);
      if (st.cellLocks[i]) cls.push(admin ? "attacking" : "locked");
      if (candidates[i]) cls.push("can", candidates[i]);
      if (stealable[i]) cls.push("steal-ok");
      if (!admin && me && me.pos === i) cls.push("me");
      const icon = cell.o ? ICON[cell.t] || "" : "?";
      html += `<button class="${cls.join(" ")}" data-cell="${i}"><span class="coord">${cellLabel(i, st.cols)}</span><span>${icon}</span>`;
      if (pawns[i]) {
        const group = pawns[i];
        const label = group.length > 1 ? `${group[0].team === "H" ? "홍" : "청"}×${group.length}` : esc(group[0].name.charAt(0));
        html += `<span class="pawn">${label}</span>`;
      }
      html += "</button>";
    }
  }
  host.innerHTML = html;
}

// ── 3D 팀 무대 (선생님 화면 전용) ────────────────────────────────────────────
// 규칙 두 개만 지키면 된다.
//  · **내용이 바뀔 때만** DOM 을 다시 만든다. 매 render 마다 새로 만들면 patch 가 올 때마다
//    (한 턴에 스무 번도 온다) 수색 애니메이션이 처음으로 되감겨 캐릭터가 계속 움찔거린다.
//  · 무대를 펼칠지는 **실제 남는 폭을 재서** 정한다. 판이 10×10~15×15 라 보드 폭이
//    609~750px 사이를 오가므로 화면 폭만으로는 판정이 안 된다.
const FX_KIND = {
  "treasure-bonus": { img: "treasure", title: "📦 보물을 열었다! +2" },
  "treasure-claim": { img: "treasure", title: "📦 보물칸을 점령했다" },
  "attack-steal": { img: "attack", title: "💥 상대 땅을 빼앗았다!" },
  "attack-claim": { img: "attack", title: "💥 공격 거점을 점령했다" },
  storm: { img: "storm", title: "⛈️ 폭풍에 갇혔다 — 다음 턴 쉼" },
};
const FX_ORDER = ["treasure-bonus", "attack-steal", "treasure-claim", "attack-claim", "storm"];
const FX_EMOJI = { search: "🔍", treasure: "📦", storm: "⛈️", attack: "💥" };
// 한쪽에 이만큼도 안 남으면 접는다. 1366px 노트북에서 12×12 판이면 정확히 199.5px 가 남는다
// — 거기서 잘리지 않도록 190 으로 둔다. 이 아래로는 그림이 너무 작아 알아볼 수 없다.
const FX_MIN_SIDE = 190;
const FX = { H: { sig: "", i: 0, n: 1 }, C: { sig: "", i: 0, n: 1 } };
const fxCalm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * 배포 버전을 붙인다. 그림을 고쳐 올렸을 때 열려 있던 탭에 옛 그림이 남지 않는다.
 *
 * ⚠ **그림 파일을 바꿨으면 반드시 APP_BUILD 도 올린다.**
 *   /assets/* 는 7일 캐시라(public/_headers), 이 값이 그대로면 URL 이 안 바뀌고
 *   브라우저는 옛 그림을 계속 쓴다. 2026-08-10 에 청팀 그림을 뒤집어 배포하고도
 *   화면이 안 바뀐 것이 이 때문이다. app.js · index.html 의 ?v= · diagnose.ts 의 BUILD 셋을 같이 올린다.
 */
const fxSrc = (kind, team) => `/assets/fx/${kind}-${team}.webp?v=${APP_BUILD}`;
const FX_FILES = [];
for (const k of ["search", "treasure", "storm", "attack"]) for (const t of ["H", "C"]) FX_FILES.push(fxSrc(k, t));

function fxImg(kind, team) {
  // 그림이 없어도 수업은 굴러가야 한다. 못 받으면 큰 이모지로 대신한다.
  return `<img src="${fxSrc(kind, team)}" alt=""
    onerror="this.outerHTML='<div class=\'fx-fallback\'>${FX_EMOJI[kind]}</div>'">`;
}

/** 턴 요약 → 보여줄 카드 목록. 배열 순서가 곧 회전 순서다. */
function fxCards(fx) {
  const out = [];
  for (const kind of FX_ORDER) {
    const names = fx.names?.[kind];
    if (!names || !names.length) continue;
    const shown = names.slice(0, 6).join(" · ") + (names.length > 6 ? ` 외 ${names.length - 6}명` : "");
    out.push({ kind: FX_KIND[kind].img, title: FX_KIND[kind].title, names: shown });
  }
  if (fx.normal > 0) out.push({ kind: "search", title: `🚩 ${fx.normal}명이 땅을 넓혔다`, names: "" });
  if (!out.length) out.push({ kind: "search", title: "이번 턴엔 아무도 못 했어요", names: "", faded: true });
  return out;
}

/** 무대를 펼칠 자리가 있는지 실제로 잰다. 보드를 그린 뒤에 부른다. */
function fxFits() {
  const stage = $("board-stage");
  const board = $("admin-board");
  if (!stage || !board || !board.offsetWidth) return false;
  return (stage.clientWidth - board.offsetWidth - 20) / 2 >= FX_MIN_SIDE; // 20 = 좌우 gap
}

function renderFx() {
  const st = APP.state;
  const stage = $("board-stage");
  if (!st || !stage) return;
  stage.classList.toggle("wide", fxFits());
  if (!stage.classList.contains("wide")) return;

  const solving = new Set(Object.values(st.cellLocks || {}));
  for (const team of ["H", "C"]) {
    const host = $(`fx-${team}`);
    const myTurn = st.status === "running" && st.turnTeam === team;
    host.classList.toggle("turn", myTurn);

    let cards;
    if (myTurn) {
      const n = st.players.filter((p) => p.team === team && solving.has(p.id)).length;
      cards = [{
        kind: "search", searching: true,
        title: `▶ ${team === "H" ? "홍팀" : "청팀"} 수색 중`,
        names: n ? `${n}명이 문제를 푸는 중` : "",
      }];
    } else {
      const fx = st.turnFx?.[team];
      cards = fx ? fxCards(fx) : [{ kind: "search", title: "차례를 기다리는 중", names: "", faded: true }];
    }

    // 서명이 같으면 DOM 을 건드리지 않는다 — 그래야 애니메이션이 이어진다.
    const sig = `${st.status}|${st.turnTeam}|${cards.map((c) => c.kind + c.title + c.names).join("~")}`;
    if (FX[team].sig === sig) continue;
    FX[team].sig = sig;
    FX[team].i = 0;
    FX[team].n = cards.length;
    host.innerHTML =
      cards.map((c, i) => `<div class="fx-card ${i === 0 ? "on" : ""} ${c.searching ? "searching" : "pop"} ${c.faded ? "faded" : ""}" data-kind="${c.kind}">
          ${fxImg(c.kind, team)}
          <div class="fx-title${c.searching ? " fx-lead" : ""}">${esc(c.title)}</div>
          ${c.names ? `<div class="fx-names">${esc(c.names)}</div>` : ""}
        </div>`).join("")
      + `<div class="fx-clock" id="fx-clock-${team}"></div>`
      + (cards.length > 1 && !fxCalm()
        ? `<div class="fx-dots">${cards.map((_, i) => `<i class="${i === 0 ? "on" : ""}"></i>`).join("")}</div>`
        : "");
  }
}

// 2.5초마다 다음 카드. 한 장뿐이거나 멀미 줄이기면 돌지 않는다
// (멀미 줄이기에서는 CSS 가 카드를 세로로 전부 펼쳐서 정보가 사라지지 않는다).
setInterval(() => {
  if (APP.role !== "teacher" || fxCalm()) return;
  for (const team of ["H", "C"]) {
    if (FX[team].n < 2) continue;
    const host = $(`fx-${team}`);
    if (!host) continue;
    FX[team].i = (FX[team].i + 1) % FX[team].n;
    host.querySelectorAll(".fx-card").forEach((el, i) => el.classList.toggle("on", i === FX[team].i));
    host.querySelectorAll(".fx-dots i").forEach((el, i) => el.classList.toggle("on", i === FX[team].i));
  }
}, 2500);

// 창 크기가 바뀌면 칸 크기와 함께 무대 접기도 다시 잰다.
addEventListener("resize", () => { if (APP.role === "teacher") render(); });

function renderLog(hostId) {
  const rows = (APP.state?.log || []).slice(0, 8);
  $(hostId).innerHTML = rows.length
    ? rows.map((e) => `<div class="kv"><span>${e.ok ? "✅" : "❌"} ${esc(e.name)}</span><b>${e.ok ? `+${e.gain}` : "-"}</b></div>`).join("")
    : '<small style="color:#8a97a0">아직 없어요</small>';
}

function renderStudent() {
  const st = APP.state;
  if (!st) return;
  $("s-quiz").textContent = st.quizTitle || "-";
  const me = st.myPlayer;
  if (me) {
    $("s-team").className = `tag ${me.team}`;
    $("s-team").textContent = me.team === "H" ? "홍팀" : "청팀";
    $("s-name").textContent = me.name;
    $("s-stats").textContent = `${me.pos === null ? "" : `내 위치 ${cellLabel(me.pos, st.cols)} · `}정답 ${me.correct}/${me.solved}`;
  }
  $("s-score-h").textContent = st.scores.H.total;
  $("s-score-c").textContent = st.scores.C.total;
  renderBoard("student-board", false);
  renderLog("s-log");

  if (APP.mode === "solving" || APP.mode === "result") return;
  const msg = $("student-message");
  const why = blockReason();
  if (why === "게임종료") msg.innerHTML = "<b>게임이 끝났습니다.</b><br><small>선생님이 새 게임을 만들면 이어서 해요.</small>";
  else if (why === "폭풍쉼") msg.innerHTML = "<b>⛈️ 폭풍에 갇혔어요! 이번 턴은 쉽니다.</b>";
  else if (why === "갇힘쉼") msg.innerHTML = "<b>🚧 갇혔습니다! 한 판 쉽니다.</b><br><small>다음 턴에 빈자리로 옮겨 드려요.</small>";
  else if (why === "이번턴완료") msg.innerHTML = "<b>이번 턴 문제를 풀었습니다.</b><br><small>상대 팀 차례가 끝날 때까지 기다려요.</small>";
  else if (why === "상대팀턴") msg.innerHTML = "<b>상대 팀 차례예요. 조금만 기다려요.</b>";
  else if (why === "시간초과") msg.innerHTML = "<b>이번 턴 시간이 끝났어요.</b><br><small>다음 턴을 기다려 주세요.</small>";
  else if (why) msg.innerHTML = "<b>선생님이 시작할 때까지 기다려 주세요.</b>";
  else {
    APP.mode = "select";
    msg.innerHTML = "<b>🎯 어디를 공략할까?</b><br><small>내 말 둘레 8칸(대각선 포함)을 고르세요.</small>";
  }
}

const TURN_LABEL = { new: "🆕 새 게임 만들기", start: "▶ 시작", next: "다음 턴" };
function turnMode(st) {
  if (!st || !st.board || !st.board.length) return "new";
  if (st.status === "ended") return "new";
  if (!st.turnTeam) return "start";
  return "next";
}

/**
 * 지금 선생님이 손봐야 할 학생만 추린다.
 *
 * 두 가지다 — 접속이 끊긴 학생, 그리고 자기 차례가 몇 번 지나도록 한 문제도 못 푼 학생.
 * 조치는 둘 다 같다. 가서 F5 로 다시 들어오게 한다.
 *
 * 라운드 차이를 3으로 잡은 이유: 폭풍(⛈️)은 한 턴만 쉬게 하므로 2까지는 멀쩡한 학생도 나온다.
 * 서버가 판 끝에 남기는 stalled 판정과 같은 기준이라 화면과 기록이 어긋나지 않는다.
 *
 * 한 명도 안 붙어 있으면 접속은 따지지 않는다. 소켓이 막힌 교실에서는 수업 중인 학생도
 * 전원 '끊김'으로 보이는데, 그때 반 전체를 부르라고 적으면 선생님이 이 칸을 안 믿게 된다.
 */
const QUIET_ROUNDS = 3;
const OFFLINE_ROUNDS = 2; // 접속까지 끊겼으면 증거가 둘이라 조금 일찍 부른다

function helpNeeded(st) {
  if (!st || st.status !== "running") return [];
  const online = new Set(st.presence || []);
  const out = [];
  for (const p of st.players) {
    const behind = st.round - (p.lastRound || 0);
    // 끊긴 것으로 보여도 방금 문제를 푼 학생은 부르지 않는다.
    // 30초에 세 번 끊긴 화면은 스스로 폴링으로 내려가는데(net.js), 서버의 접속자 명단은
    // WebSocket 만 세므로 멀쩡히 수업 중인 학생이 '끊김' 으로 보인다. 방화벽이 WebSocket 을
    // 막는 교실에서 늘 일어나는 일이다. 푸는 사람을 불러 F5 를 시키면 수업을 방해할 뿐이다.
    if (online.size && !online.has(p.id) && behind >= OFFLINE_ROUNDS) {
      out.push({ id: p.id, name: p.name, team: p.team, why: "접속 끊김" });
      continue;
    }
    if (behind >= QUIET_ROUNDS) {
      out.push({ id: p.id, name: p.name, team: p.team, why: `${behind}라운드 동안 조용` });
    }
  }
  return out;
}

function renderHelp() {
  const list = helpNeeded(APP.state);
  $("help-card").classList.toggle("hidden", list.length === 0);
  if (!list.length) return;
  $("help-count").textContent = `${list.length}명`;
  $("help-list").innerHTML = list
    .map((p) => `<div class="help-row"><b>${p.team === "H" ? "🔴" : "🟢"} ${esc(p.name)}</b><span>${esc(p.why)}</span></div>`)
    .join("");
}

function renderAdmin() {
  const st = APP.state;
  if (!st) return;
  $("a-quiz").textContent = st.quizTitle || "-";
  $("a-room").textContent = `${st.code}${st.label ? ` · ${st.label}` : ""}`;
  $("a-turn").className = `tag ${st.turnTeam || ""}`;
  $("a-turn").textContent = st.status === "ended" ? "종료" : st.turnTeam ? (st.turnTeam === "H" ? "홍팀" : "청팀") : "대기";
  $("a-round").textContent = `${st.round} / ${st.roundLimit}`;
  $("a-score-h").textContent = st.scores.H.total;
  $("a-score-c").textContent = st.scores.C.total;
  $("a-sub-h").textContent = `영토 ${st.scores.H.territory} + 보너스 ${st.scores.H.bonus}`;
  $("a-sub-c").textContent = `영토 ${st.scores.C.territory} + 보너스 ${st.scores.C.bonus}`;

  const online = new Set(st.presence || []);
  $("online-count").textContent = `${st.players.length}명 · 접속 ${online.size}명`;
  $("roster").innerHTML = st.players
    .map((p) => `<span class="person ${online.has(p.id) ? "" : "off"}">${p.team === "H" ? "🔴" : "🟢"} ${esc(p.name)}<button class="kick" data-kick="${p.id}" title="내보내기">×</button></span>`)
    .join("");

  const button = $("turn-button");
  button.textContent = TURN_LABEL[turnMode(st)];
  button.disabled = false; // 어떤 상황에서도 잠그지 않는다
  renderBoard("admin-board", true);
  renderLog("a-log");
  renderHelp();
  renderFx();
}

const render = () => (APP.role === "teacher" ? renderAdmin() : renderStudent());

function updateTimer() {
  const st = APP.state;
  if (!st) return;
  const left = Math.max(0, (st.turnEndsAt || 0) - now());
  const s = Math.ceil(left / 1000);
  const text = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  const el = APP.role === "teacher" ? $("a-timer") : $("s-timer");
  if (el) el.textContent = text;
  // 위쪽 타이머는 어느 팀 시간인지 안 보인다. 차례인 팀 무대 밑에 크게 한 번 더 띄운다.
  if (APP.role === "teacher" && st.turnTeam) {
    const clock = $(`fx-clock-${st.turnTeam}`);
    if (clock) clock.textContent = text;
  }
  if (APP.role === "student" && left === 0 && APP.mode === "solving") {
    APP.mode = "waiting";
    hideQuiz();
    toast("시간이 끝났어요. 다음 턴을 기다려 주세요.");
    render();
  }
}
setInterval(updateTimer, 250);

// ── 서버 메시지 ─────────────────────────────────────────────────────────────
function applyClock(msg) {
  if (typeof msg.serverNow === "number") APP.clockOffset = msg.serverNow - Date.now();
}

/** 정본 순번 확인. 놓친 게 있으면 전체를 다시 받는다. */
function acceptRev(msg) {
  if (typeof msg.stateRev !== "number") return true;
  if (msg.stateRev === APP.rev) return false; // 이미 반영했다
  if (msg.stateRev === APP.rev + 1 || APP.rev < 0) { APP.rev = msg.stateRev; return true; }
  if (msg.stateRev > APP.rev + 1) {
    // sync 는 하나로 합친다. 40명이 동시에 놓쳤을 때 폭주하면 안 된다.
    //
    // 다만 이 요청이 사라지면 syncing 이 영영 참으로 남는다. 그러면 그 뒤의 모든
    // 갱신을 "순서가 어긋났다" 며 버리면서 다시 요청하지도 않아, 화면이 옛 판에
    // 멈춘 채 조용히 굳는다. selectCell 과 같은 계열의 덫이라 같이 막는다.
    if (!APP.syncing) {
      APP.syncing = true;
      clearTimeout(syncGuard);
      syncGuard = setTimeout(() => { APP.syncing = false; }, REPLY_TIMEOUT_MS);
      netSend({ t: "sync" }).catch(() => { APP.syncing = false; });
    }
    return false;
  }
  return false; // 늦게 도착한 옛 메시지
}

function onMessage(msg) {
  applyClock(msg);
  switch (msg.t) {
    case "state": {
      clearTimeout(syncGuard);
      APP.syncing = false;
      APP.rev = msg.stateRev;
      APP.state = msg;
      if (msg.myPlayer) {
        APP.playerId = msg.myPlayer.id;
        localStorage.setItem("treasure-player-id", msg.myPlayer.id);
        // 권리는 서버가 들고 있다. 새로고침하거나 끊겼다 붙어도 이어서 고를 수 있어야 한다.
        if (msg.myPlayer.hasSteal && !APP.stealing) startStealing();
        else if (!msg.myPlayer.hasSteal && APP.stealing) stopStealing();
      }
      // "result" 도 건드리지 않는다. 남이 답한 patch 하나가 내 결과창을 밀어내면,
      // 닫기 타이머가 "내 차례가 아니네" 하고 되돌아가 창이 영영 남는다(2026-08-29).
      if (APP.mode !== "solving" && APP.mode !== "result") APP.mode = "waiting";
      noticeTrapped();
      render();
      return;
    }
    case "patch": {
      if (!APP.state || !acceptRev(msg)) return;
      for (const c of msg.cells) APP.state.board[c.idx] = { t: c.t, o: c.o };
      for (const p of msg.players) {
        const at = APP.state.players.findIndex((x) => x.id === p.id);
        if (at >= 0) APP.state.players[at] = p;
        else APP.state.players.push(p);
        if (p.id === APP.playerId && APP.state.myPlayer) APP.state.myPlayer.pos = p.pos;
      }
      APP.state.cellLocks = msg.cellLocks;
      APP.state.scores = msg.scores;
      APP.state.log = msg.log;
      APP.state.status = msg.status;
      render();
      return;
    }
    case "turn": {
      if (!APP.state || !acceptRev(msg)) return;
      Object.assign(APP.state, {
        status: msg.status, round: msg.round, turnTeam: msg.turnTeam,
        turnEndsAt: msg.turnEndsAt, players: msg.players, cellLocks: msg.cellLocks,
        turnFx: msg.turnFx,
      });
      if (APP.state.myPlayer) {
        const mine = msg.players.find((p) => p.id === APP.playerId);
        if (mine) APP.state.myPlayer.pos = mine.pos;
        APP.state.myPlayer.playedThisTurn = false;
        APP.state.iAmSkipping = false;
        APP.state.iAmTrapped = false; // 이어지는 sync 가 참이면 다시 켜 준다
      }
      // "result" 도 건드리지 않는다. 남이 답한 patch 하나가 내 결과창을 밀어내면,
      // 닫기 타이머가 "내 차례가 아니네" 하고 되돌아가 창이 영영 남는다(2026-08-29).
      if (APP.mode !== "solving" && APP.mode !== "result") APP.mode = "waiting";
      // 폭풍으로 쉬는지는 서버만 안다. 턴이 바뀌면 내 상태를 한 번 확인한다.
      if (APP.role === "student") netSend({ t: "sync" });
      render();
      return;
    }
    case "quiz":
      if (APP.mode === "solving" && APP.currentCell === msg.cell) { replyArrived(); renderQuiz(msg); }
      return;
    case "result":
      showResult(msg);
      return;
    case "stolen":
      // 다 가져왔다. 띠와 손가락을 걷고 판을 다시 그린다.
      stopStealing();
      toast("💥 땅을 빼앗았어요!");
      return;
    case "closed": {
      // 선생님이 방을 닫았다. 학생은 입장 화면으로, 선생님은 설정으로 돌아간다.
      netClose();
      toast(msg.msg || "방이 닫혔어요.");
      if (APP.role === "teacher") { APP.role = null; loadHome().catch(() => showScreen("entry")); }
      else { localStorage.removeItem("treasure-room"); leave(); }
      return;
    }
    case "gameover":
      showGameOver(msg);
      return;
    case "peek":
      showPeek(msg);
      return;
    case "presence":
      if (APP.state) { APP.state.presence = msg.online; render(); }
      return;
    case "error":
      onError(msg);
      return;
    default:
  }
}

function onError(msg) {
  replyArrived();
  if (APP.mode === "solving") { APP.mode = "waiting"; hideQuiz(); }
  APP.submitting = false;

  // 붙지 못하는 이유라면 빈 화면에 갇히지 않게 돌려보낸다.
  if (msg.code === "not-owner" || msg.code === "no-room") {
    netClose();
    toast(msg.msg);
    if (APP.role === "teacher") { APP.role = null; loadHome().catch(() => showScreen("entry")); }
    else leave();
    return;
  }
  if (msg.code === "room-full") { netClose(); toast(msg.msg); return leave(); }

  if (msg.code === "no-player") {
    // 선생님이 내보냈거나 방이 새로 깔렸다. 이름으로 다시 들어간다.
    localStorage.removeItem("treasure-player-id");
    APP.playerId = null;
    toast("다시 입장할게요…");
    NET.hello = { t: "hello", role: "student", name: localStorage.getItem("treasure-player-name") || "" };
    netSend(NET.hello);
    return;
  }
  toast(msg.msg || "요청이 거절되었습니다.");
  render();
}

function onStatus(kind, text) {
  const el = APP.role === "teacher" ? $("a-net") : $("s-net");
  if (!el) return;
  el.textContent = text;
  el.className = `net ${kind === "ok" ? "" : kind === "slow" ? "slow" : "down"}`;
}

// ── 학생: 칸 고르기 · 답 ────────────────────────────────────────────────────
/**
 * 화면 한가운데 놀이 창. 문제·결과·아이템이 이 한 자리를 차례로 쓴다(2026-08-29).
 * 무엇을 보일지 하나만 정하면 나머지는 알아서 감춘다 — 두 개가 겹쳐 뜨는 사고를 없앤다.
 */
function showPlay(which) {
  const modal = $("play-modal");
  if (!which) {
    modal.classList.add("hidden");
    $("student-message").classList.remove("hidden");
    return;
  }
  for (const name of ["quiz", "result", "fx"]) {
    $(`play-${name}`).classList.toggle("hidden", name !== which);
  }
  $("student-message").classList.add("hidden");
  modal.classList.remove("hidden");
}

function hideQuiz() {
  showPlay(null);
}

function renderQuiz(msg) {
  playGen++; // 새 문제가 창을 넘겨받는다. 앞 결과의 닫기 타이머는 무효가 된다.
  $("quiz-cell").textContent = cellLabel(msg.cell, APP.state.cols);
  $("quiz-question").textContent = msg.q;
  $("quiz-options").innerHTML = msg.options
    .map((x, i) => `<button class="option" data-choice="${i}"><b>${i + 1}</b>${esc(x)}</button>`)
    .join("");
  showPlay("quiz");
}

/** 보물·폭풍·공격을 만났을 때. 글자 대신 그 자리에 3D 그림을 띄운다. */
const FX_SAY = {
  treasure: "📦 보물을 찾았다!",
  storm: "⛈️ 폭풍! 다음 턴은 쉰다",
  attack: "💥 공격! 땅을 빼앗을 수 있다",
};
function showItemFx(kind) {
  const team = APP.state?.myPlayer?.team ?? "H";
  $("play-fx-art").innerHTML = fxImg(kind, team);
  $("play-fx-say").textContent = FX_SAY[kind] ?? "";
  showPlay("fx");
}

async function selectCell(cell) {
  const why = blockReason();
  if (why || APP.mode === "solving") {
    const said = {
      시간초과: "이번 턴 시간이 끝났어요.",
      상대팀턴: "지금은 상대 팀 차례예요.",
      이번턴완료: "이번 턴 문제는 이미 풀었어요.",
      폭풍쉼: "⛈️ 이번 턴은 폭풍으로 쉽니다.",
      갇힘쉼: "🚧 갇혀서 이번 턴은 쉽니다.",
      시작전: "아직 시작 전이에요. 선생님을 기다려 주세요.",
      게임종료: "게임이 끝났어요.",
      관전: "이 방의 내 자리를 찾지 못했어요. 새로고침 뒤 이름을 다시 넣어 주세요.",
      상태없음: "아직 판을 받지 못했어요. 잠시만요.",
    }[why];
    // ⑤ 막히면 왜 막혔는지 말해 준다. 예전에는 표에 없는 사유(관전·상태없음)와
    // solving 갇힘이 아무 말 없이 되돌아가, 학생이 이유도 모르고 계속 눌렀다.
    toast(said ?? (APP.mode === "solving" ? "앞의 문제를 기다리는 중이에요." : "지금은 고를 수 없어요."));
    return;
  }
  APP.currentCell = cell;
  APP.mode = "solving";
  render(); // 고를 수 없게 됐으니 녹색 후보도 그 즉시 꺼야 한다
  watchReply("문제");
  // 문제는 미리 안 들고 있는다. 서버가 채점에 쓸 바로 그 문제를 보내 주면 그때 그린다.
  try {
    await netSend({ t: "pick", cell, actionId: newActionId() });
  } catch {
    // 폴백 POST 가 실패하면 예전에는 조용히 사라져, 여기서 영영 갇혔다.
    unstick("보내지 못했어요. 다시 눌러 보세요.");
  }
}

async function submitChoice(choice) {
  if (APP.submitting || APP.mode !== "solving") return;
  APP.submitting = true;
  // 두 번 눌리면 두 번째 채점이 실패하고, 그 실패가 화면을 굳게 만들었다(2026-08-09 "정").
  for (const b of $("quiz-options").querySelectorAll("button")) b.disabled = true;
  watchReply("채점");
  try {
    await netSend({ t: "answer", cell: APP.currentCell, choice, actionId: newActionId() });
  } catch {
    // 보기가 전부 비활성인 채로 굳는 자리였다. 되돌려 다시 누를 수 있게 한다.
    unstick("답을 보내지 못했어요. 다시 눌러 보세요.");
  }
}

/**
 * 놀이 창 세대 번호. 창을 새로 띄울 때마다 오른다.
 *
 * 닫기 타이머가 APP.mode 를 보고 판단하던 때는, 그 사이 남이 답한 patch 가 mode 를
 * 바꿔 놓으면 타이머가 그냥 되돌아가 **창이 영영 남았다**(2026-08-29 "정답!" 얼음).
 * 이제는 "내가 띄운 그 창이 아직 떠 있는가" 만 보고 닫는다.
 */
let playGen = 0;

function showResult(msg) {
  replyArrived();
  APP.submitting = false;
  APP.mode = "result";
  // patch 에는 "내" 정보가 없다. 서버가 알려 준 이 값을 안 넣으면
  // 결과창이 사라진 뒤 칸이 다시 켜져서 한 문제 더 풀 수 있는 것처럼 보인다.
  if (APP.state?.myPlayer) {
    APP.state.myPlayer.playedThisTurn = true;
    if (msg.skipNextTurn) APP.state.iAmSkipping = true;
  }
  $("result-big").className = `big ${msg.correct ? "ok" : "no"}`;
  $("result-big").textContent = msg.correct ? "정답!" : "아쉬워요";
  $("result-message").textContent = msg.correct && msg.bonusSkipped
    ? "정답입니다. 이 칸의 보너스는 이미 받았어요."
    : `정답은 ${msg.answerText} 입니다.`;
  $("result-gain").textContent = msg.correct ? `+${msg.gain}점` : "점령 실패";
  showPlay("result");

  // 맞혀서 아이템을 만났으면, 결과를 잠깐 보여 준 뒤 같은 자리에 3D 그림으로 바꿔 준다.
  const item = msg.correct ? { T: "treasure", S: "storm", A: "attack" }[msg.cellType] : null;

  const mine = ++playGen;
  setTimeout(() => {
    if (playGen !== mine) return; // 그 사이 새 창이 떴다
    if (!item) return closePlay();
    showItemFx(item);
    // 그림은 **다음 턴 얼마 전까지** 머문다. 잠깐 떴다 사라지면 아이들이 못 본다.
    setTimeout(() => {
      if (playGen !== mine) return;
      closePlay();
      // 공격이면 그림이 사라진 자리에서 곧바로 "어디를 가져올까" 고르기로 넘어간다.
      if (msg.stealGranted) startStealing();
    }, fxLinger(item));
  }, item ? 1200 : 3000);
}

/**
 * 갇혔다고 한 번만 알린다.
 *
 * 5초마다 오는 state 마다 창을 다시 띄우면 아무것도 못 한다. 그래서 "어느 턴의 갇힘인지"
 * 를 기억해 두고, 그 턴에 한 번만 띄운다. 그림은 없고 글자만이다 — 폭풍처럼 3D 를 만들면
 * 가둔 쪽이 아니라 갇힌 쪽이 상을 받는 것처럼 보인다.
 */
let trapSaidFor = "";
function noticeTrapped() {
  const st = APP.state;
  const key = `${st?.round}:${st?.turnTeam}`;
  if (!st?.iAmTrapped || APP.role !== "student") { if (!st?.iAmTrapped) trapSaidFor = ""; return; }
  if (trapSaidFor === key) return;
  if (APP.mode === "solving" || APP.mode === "result") return; // 앞 창을 밀어내지 않는다
  trapSaidFor = key;

  $("result-big").className = "big no";
  $("result-big").textContent = "🚧 갇혔습니다";
  $("result-message").textContent = "둘레가 모두 막혔어요. 한 판 쉽니다.";
  $("result-gain").textContent = "다음 턴에 빈자리로 옮겨 드려요";
  showPlay("result");

  const mine = ++playGen;
  setTimeout(() => {
    if (playGen !== mine) return; // 그 사이 새 창이 떴다
    closePlay();
  }, 3000);
}

/**
 * 아이템 그림을 얼마나 띄워 둘까.
 *
 * 보통은 다음 턴 5초 전까지 둔다. 다만 **공격은 10초 전에 걷는다** — 그림이 사라진 뒤
 * 상대 땅을 골라야 하는데, 5초는 판을 훑어보기에 짧다(2026-08-29 수업 확인).
 * 턴이 얼마 안 남았으면 최소한은 보여 주고, 아주 길어도 너무 오래 판을 가리지 않는다.
 */
const FX_CLEAR_BEFORE = { attack: 10000 };
function fxLinger(kind) {
  const left = (APP.state?.turnEndsAt ?? 0) - now();
  const before = FX_CLEAR_BEFORE[kind] ?? 5000;
  return Math.max(2000, Math.min(left - before, 12000));
}

/**
 * 공격권을 얻었다 — 판 전체에서 가져올 상대 땅 하나를 고른다.
 *
 * 모달로 덮으면 판이 안 보여 고를 수가 없다. 그래서 위쪽 띠로 알리고,
 * 커다란 손가락이 마우스를 따라다니며 가리키는 상대 땅을 켠다.
 * 고르기 전에 턴이 넘어가도 권리는 서버에 남아 있으므로 서두를 필요가 없다.
 */
function startStealing() {
  if (APP.stealing) return; // 이미 고르는 중이면 그대로 둔다
  APP.stealing = true;
  $("steal-banner").classList.remove("hidden");
  $("steal-finger").classList.remove("hidden");
  document.body.classList.add("stealing");
  render();
}

function stopStealing() {
  APP.stealing = false;
  $("steal-banner").classList.add("hidden");
  $("steal-finger").classList.add("hidden");
  document.body.classList.remove("stealing");
  render();
}

// 손가락은 마우스를 따라다닌다. 고르는 중이 아닐 때는 아무 일도 하지 않는다.
addEventListener("pointermove", (event) => {
  if (!APP.stealing) return;
  const finger = $("steal-finger");
  finger.style.left = `${event.clientX}px`;
  finger.style.top = `${event.clientY}px`;

  // 지금 가리키는 상대 땅만 켠다
  const over = event.target.closest?.("[data-cell]");
  for (const el of document.querySelectorAll(".cell.steal-hot")) el.classList.remove("steal-hot");
  if (over && over.classList.contains("steal-ok")) over.classList.add("steal-hot");
});

/** 손가락으로 고른 칸을 실제로 가져온다. */
async function takeCell(cell) {
  const st = APP.state;
  const enemy = st?.myPlayer?.team === "H" ? "C" : "H";
  if (st?.board?.[cell]?.o !== enemy) return toast("상대 팀의 땅만 가져올 수 있어요.");

  stopStealing();
  try {
    await netSend({ t: "steal", cell, actionId: newActionId() });
  } catch {
    // 못 보냈으면 권리는 서버에 그대로 있다. 다시 고를 수 있게 되돌린다.
    startStealing();
    toast("보내지 못했어요. 다시 골라 보세요.");
  }
}

/** 놀이 창을 닫고 판으로 돌아간다. */
function closePlay() {
  APP.mode = "waiting";
  showPlay(null);
  render();
}

// ── 입장 ────────────────────────────────────────────────────────────────────
async function enterAsStudent(code, name) {
  const room = await api(`/api/rooms/${code}`);
  localStorage.setItem("treasure-room", code);
  localStorage.setItem("treasure-player-name", name);
  APP.role = "student";
  APP.code = code;
  APP.rev = -1;
  closeModal("student-login");
  showScreen("student-screen");
  $("s-quiz").textContent = room.quizTitle || "-";
  netConnect(
    code,
    { t: "hello", role: "student", name, playerId: localStorage.getItem("treasure-player-id") || undefined },
    onMessage,
    onStatus,
  );
}

function enterAsTeacher(code) {
  // 미리 받아 두지 않으면 첫 턴이 끝나는 순간 그림이 늦게 떠서 빈 자리가 잠깐 보인다.
  for (const src of FX_FILES) { const im = new Image(); im.src = src; }
  APP.role = "teacher";
  APP.code = code;
  APP.rev = -1;
  showScreen("admin-screen");
  netConnect(code, { t: "hello", role: "teacher" }, onMessage, onStatus);
}

function leave() {
  netClose();
  Object.assign(APP, { role: null, code: null, state: null, rev: -1, mode: "waiting", playerId: null });
  showScreen("entry");
}

// ── 선생님 홈 ───────────────────────────────────────────────────────────────
async function loadHome() {
  const me = await api("/api/auth/me");
  APP.teacher = me;
  $("teacher-name").textContent = `${me.name} 선생님`;
  // 톱니바퀴는 슈퍼관리자에게만. 서버도 /api/admin/* 을 따로 막으므로
  // 여기서 숨기는 것은 잠금장치가 아니라 화면을 어지럽히지 않으려는 것이다.
  $("super-open").classList.toggle("hidden", !me.isSuper);
  showScreen("teacher-home");
  await Promise.all([loadSets(), loadRooms()]);
  updateSizeHint();
}

async function loadSets() {
  const { sets } = await api("/api/quizsets");
  APP.sets = sets;
  $("quizsets").innerHTML = sets.length
    ? sets.map((s, i) => `<li><label>
        <input type="radio" name="quizset" value="${s.id}"${i === 0 ? " checked" : ""}>
        <b>${esc(s.title)}</b>
        <small>${s.itemCount}문항${s.skipped ? ` · 건너뜀 ${s.skipped}` : ""}<br>${new Date(s.updatedAt).toLocaleDateString("ko-KR")}</small>
      </label></li>`).join("")
    : '<li class="empty">아직 올린 퀴즈가 없어요. [＋ 엑셀 올리기]를 눌러 주세요.</li>';
}

async function loadRooms() {
  const { rooms } = await api("/api/rooms/mine");
  $("roomlist").innerHTML = rooms.length
    ? rooms.map((r) => `<div class="roomrow">
        <span class="code">${r.code}</span>
        <span>${esc(r.label || "")} <small style="color:#7d8b94">· ${esc(r.quizTitle || "")}</small></span>
        <span><button class="button muted" data-blast="${r.code}">💣 폭파</button>
        <button class="button primary" data-enter="${r.code}">들어가기</button></span>
      </div>`).join("")
    : '<div class="empty">열려 있는 방이 없어요.</div>';
}

const selectedSetId = () => {
  const picked = document.querySelector('input[name="quizset"]:checked');
  return picked ? Number(picked.value) : 0;
};

// ── 인원 하나로 판을 짠다 (2026-09-04) ──────────────────────────────────────
//
// 1라운드는 홍 턴 + 청 턴이라(game.ts nextTurn) 학생 한 명이 한 라운드에 먹을 수 있는 칸은
// 많아야 하나다. 정답일 때만 칸을 먹고(room.ts answer), 임자 있는 칸은 다시 못 먹으니
// (game.ts canChallengeFrom) 칸이 재활용되지 않는다. 그래서
//
//     끝났을 때 채워진 칸 = 인원 + 총정답수 = 인원 × (1 + 판수 × CLAIM)
//
// D1 게임 기록 16판으로 확인했다 — CLAIM 중앙값 0.65, 최저 0.50, 최고 0.89.
const CLAIM = 0.65;

// 9명 · 10판 · 12×12 가 정확히 절반(72/144)이었고, 그 판이 좋았다.
// 절반이 차야 영역끼리 맞닿아 서로 가둘 수 있고, 절반이 남아야 처음부터 갇히는 학생이 없다.
const FILL_AIM = 0.50;

// 판이 마르기 시작하는 선. 처음에는 55% 로 잡았는데 30명이 4판밖에 못 하게 나왔다.
// 4판은 수업이 아니다. 그래서 상한을 60% 로 올리고 판수에 하한을 뒀다 — 30명 6판(65%),
// 23명 7판(57%). 사람이 많을수록 판이 빽빽해지지만, 그래야 게임다운 길이가 나온다.
const FILL_MAX = 0.60;
const ROUNDS_MIN = 6; // 아무리 사람이 많아도 이보다 짧게는 줄이지 않는다
const SIDE_MIN = 10;   // game.ts 의 MIN_SIDE
const SIDE_MAX = 15;   // game.ts 의 MAX_SIDE
const SPECIAL_MAX = 0.40; // 특수칸이 이보다 많으면 보통 칸으로 하는 게임이 아니게 된다

// 특수칸 기준점 — 9명 판(12×12 · 10판)에서 📦8 ⛈️12 💥12.
// 원래 기본값 8·7·7 은 폭풍과 공격권이 너무 안 나왔다(2026-09-04 확인).
const SPECIAL_BASE = { cells: 144, rounds: 10, t: 8, s: 12, a: 12 };

/** 방 정원. game.ts 의 maxPlayers 와 같은 식이어야 한다 — tools/plan-check.mjs 가 대조한다. */
function maxPlayers(rows, cols, rounds) {
  const cells = rows * cols;
  return Math.max(1, Math.min(Math.floor(cells / 2.4), Math.floor(cells / (1 + rounds * 0.85))));
}

/** 이 인원이 이 판수를 다 돌면 채워질 칸 수. */
function claimedCells(players, rounds) {
  return players * (1 + CLAIM * rounds);
}

/**
 * 인원을 넣으면 판 크기 · 판수 · 특수칸을 한꺼번에 정해 준다.
 * 판은 15×15 보다 크게 만들 수 없으므로, 17명쯤부터는 판수를 깎아서 맞춘다.
 */
function planFor(players, rounds) {
  const n = Math.max(1, Math.round(players) || 1);
  let want = Math.max(1, Math.round(rounds) || SPECIAL_BASE.rounds);

  // ① 판 크기 — 다 끝났을 때 절반이 차는 크기에 가장 가까운 한 변
  const off = (side) => Math.abs(claimedCells(n, want) / (side * side) - FILL_AIM);
  let side = SIDE_MIN;
  for (let s = SIDE_MIN + 1; s <= SIDE_MAX; s++) if (off(s) < off(side)) side = s;
  const cells = side * side;

  // ② 판수 — 판을 더 키울 수 없는데도 넘치면 판수를 깎는다. 19명부터 여기에 걸린다.
  //    선생님이 일부러 짧게 잡아 둔 판수는 건드리지 않는다(min). 하한 아래로도 안 내려간다(max).
  if (claimedCells(n, want) > cells * FILL_MAX) {
    const fits = Math.floor((cells * FILL_MAX / n - 1) / CLAIM);
    want = Math.min(want, Math.max(ROUNDS_MIN, fits));
  }

  // ③ 특수칸 — 학생 한 명이 한 판에서 만나는 특수칸 수를 9명 판과 같게 맞춘다.
  //    만나는 횟수 = 채워진 칸 × 특수칸 비율 ÷ 인원 = (1 + 판수 × CLAIM) × 특수칸 ÷ 전체 칸
  //    이라 인원은 약분된다. 판이 커지면 늘리고, 판수가 줄면 만날 기회가 주니 더 촘촘히 깐다.
  const base = SPECIAL_BASE.t + SPECIAL_BASE.s + SPECIAL_BASE.a;
  const denser = (1 + CLAIM * SPECIAL_BASE.rounds) / (1 + CLAIM * want);
  const total = Math.min(
    Math.floor(cells * SPECIAL_MAX),
    Math.round(base * (cells / SPECIAL_BASE.cells) * denser),
  );
  const cntT = Math.round((total * SPECIAL_BASE.t) / base);
  const cntS = Math.round((total * SPECIAL_BASE.s) / base);
  return { rows: side, cols: side, rounds: want, cntT, cntS, cntA: total - cntT - cntS };
}

/** 이 인원이 이 판을 얼마만큼 채우려면 몇 판이 필요한가. 힌트에 숫자로 찍어 준다. */
function roundsForFill(players, cells, target) {
  if (players < 1) return 1;
  return Math.max(1, Math.min(30, Math.round((cells * target / players - 1) / CLAIM)));
}

/** 인원 칸을 건드리면 나머지를 전부 다시 잡는다. */
function applyPlan() {
  const plan = planFor(Number($("cfg-players").value), Number($("cfg-round").value));
  $("cfg-rows").value = plan.rows;
  $("cfg-cols").value = plan.cols;
  $("cfg-round").value = plan.rounds;
  $("cfg-t").value = plan.cntT;
  $("cfg-s").value = plan.cntS;
  $("cfg-a").value = plan.cntA;
  updateSizeHint();
}

function updateSizeHint() {
  const rows = Number($("cfg-rows").value);
  const cols = Number($("cfg-cols").value);
  const rounds = Number($("cfg-round").value);
  const players = Number($("cfg-players").value);
  const set = APP.sets.find((s) => s.id === selectedSetId());
  const cells = rows * cols;
  const specials = Number($("cfg-t").value) + Number($("cfg-s").value) + Number($("cfg-a").value);
  const cap = maxPlayers(rows, cols, rounds);
  const fill = cells > 0 ? claimedCells(players, rounds) / cells : 0;

  // 판정은 하나만 보여 준다. 여러 줄로 늘어놓으면 선생님이 어느 것을 고쳐야 할지 모른다.
  let verdict;
  if (players > cap) verdict = `<b class="bad">정원 초과예요 — 이 판은 ${cap}명까지</b>`;
  else if (specials >= cells) verdict = '<b class="bad">특수칸이 판보다 많아요</b>';
  else if (fill > FILL_MAX + 0.08) verdict = `<b class="bad">판이 말라요</b> — ${roundsForFill(players, cells, FILL_MAX)}판으로 줄이세요`;
  // 판은 10×10 보다 작게 만들 수 없다. 그래서 인원이 적으면 판수로 채우는 수밖에 없는데,
  // 선생님이 일부러 짧게 잡았을 수도 있으니 고쳐 주지는 않고 몇 판이면 되는지만 알려 준다.
  else if (fill < 0.35) verdict = `<b>판이 헐렁해요</b> — ${roundsForFill(players, cells, FILL_AIM)}판이면 절반이 차요`;
  else verdict = "<b>딱 좋아요</b>";

  $("size-hint").innerHTML =
    `${rows}×${cols} = <b>${cells}칸</b> · ${players}명이 ${rounds}판 하면 `
    + `<b>${Math.round(fill * 100)}%</b> 채워요 · ${verdict}`
    + (set ? `<br>문항 ${set.itemCount}개라 각 문제가 최대 ${Math.ceil(cells / set.itemCount)}번 나와요` : "");
}

// ── 클릭 ────────────────────────────────────────────────────────────────────
document.addEventListener("click", async (event) => {
  const t = event.target;

  const close = t.closest("[data-close]");
  if (close) return closeModal(close.dataset.close);
  if (t.closest("[data-leave]")) return leave();

  if (t.closest("#go-student")) {
    $("in-code").value = localStorage.getItem("treasure-room") || "";
    $("in-name").value = localStorage.getItem("treasure-player-name") || "";
    return openModal("student-login");
  }
  if (t.closest("#go-teacher")) {
    try { await loadHome(); } catch { openModal("teacher-login"); }
    return;
  }

  const cell = t.closest("[data-cell]");
  if (cell) {
    const idx = Number(cell.dataset.cell);
    if (APP.role === "student") {
      // 고르기 중이라도 **상대 땅일 때만** 뺏기로 간다. 예전에는 모든 클릭을 뺏기로 보내는 바람에
      // 빼앗기 전에는 아무것도 못 하고 갇혔다(2026-08-29 수업에서 "무한 기다림" 으로 나타났다).
      const enemyTeam = APP.state?.myPlayer?.team === "H" ? "C" : "H";
      if (APP.stealing && APP.state?.board?.[idx]?.o === enemyTeam) return takeCell(idx);
      return selectCell(idx);
    }
    if (APP.role === "teacher") return netSend({ t: "peek", cell: idx });
  }

  const choice = t.closest("[data-choice]");
  if (choice) return submitChoice(Number(choice.dataset.choice));
  if (t.closest("#quiz-cancel")) {
    APP.mode = "waiting";
    hideQuiz();
    netSend({ t: "cancel", actionId: newActionId() });
    return render();
  }

  const enter = t.closest("[data-enter]");
  if (enter) return enterAsTeacher(enter.dataset.enter);

  const blast = t.closest("[data-blast]");
  if (blast) {
    const code = blast.dataset.blast;
    if (!confirm(`방 ${code} 을 폭파할까요?\n\n· 학생들이 모두 나가고 입장 화면으로 돌아갑니다\n· 새 방을 만들면 번호가 새로 나옵니다`)) return;
    try {
      await api(`/api/rooms/${code}`, { method: "DELETE" });
      toast(`방 ${code} 을 닫았습니다.`);
      await loadRooms();
    } catch (err) { toast(err.message); }
    return;
  }
  if (t.closest("#back-home")) { netClose(); APP.role = null; return loadHome(); }

  const kick = t.closest("[data-kick]");
  if (kick) {
    const p = APP.state.players.find((x) => x.id === kick.dataset.kick);
    if (p && confirm(`${p.name} 학생을 내보낼까요?`)) netSend({ t: "cmd", cmd: "kick", playerId: p.id, actionId: newActionId() });
    return;
  }

  if (t.closest("#logout")) {
    await fetch("/api/auth/logout", { method: "POST" });
    return showScreen("entry");
  }
  if (t.closest("#toggle-signup")) {
    const on = $("signup-fields").classList.toggle("hidden");
    $("teacher-submit").textContent = on ? "로그인" : "가입하기";
    $("toggle-signup").textContent = on ? "가입하기" : "로그인으로";
    return;
  }
  if (t.closest("#upload-open")) {
    $("upload-problems").classList.add("hidden");
    return openModal("upload-modal");
  }

  if (t.closest("#super-open")) return openSuper();
  if (t.closest("#super-refresh")) return openSuper();
  // 재설정 버튼은 선생님 줄 안에 있다. 줄보다 먼저 잡아야 줄이 접히지 않는다.
  const resetBtn = t.closest("[data-reset]");
  if (resetBtn) return resetTeacherPassword(resetBtn.dataset.reset);
  const teacherRow = t.closest("[data-teacher]");
  if (teacherRow) return toggleTeacher(teacherRow.dataset.teacher);
  const quizBtn = t.closest("[data-quiz]");
  if (quizBtn) return previewOtherQuiz(quizBtn.dataset.quiz);

  if (t.closest("#diagnose")) return runDiagnose();
  if (t.closest("#preview-set")) return previewSet();
  if (t.closest("#delete-set")) return deleteSet();
  if (t.closest("#create-room")) return createRoom();

  // 선생님 게임 버튼 — 어떤 상황에서도 눌리고, 안 되면 이유를 말한다
  if (t.closest("#new-game-button")) return teacherCommand("newgame", "새 판을 만드는 중…");
  if (t.closest("#turn-button")) {
    const mode = turnMode(APP.state);
    if (mode === "new") return teacherCommand("newgame", "새 판을 만드는 중…");
    return teacherCommand("next", "턴을 넘기는 중…");
  }
  if (t.closest("#end-game-button")) {
    if (confirm("게임을 끝낼까요? 학생들은 그대로 남아 있습니다.")) teacherCommand("end", "마무리하는 중…");
    return;
  }
  if (t.closest("#reset-button")) {
    if (confirm("학생 명단까지 모두 비우고 새 판을 깝니다. 다음 반 수업을 시작할 때 쓰는 버튼입니다.\n계속할까요?")) {
      teacherCommand("reset", "초기화하는 중…");
    }
  }
});

function setTurnHint(text, bad) {
  $("turn-hint").textContent = text;
  $("turn-hint").className = `turn-hint${bad ? " bad" : ""}`;
}

function teacherCommand(cmd, working) {
  setTurnHint(working, false);
  netSend({ t: "cmd", cmd, actionId: newActionId() });
  setTimeout(() => { if ($("turn-hint").textContent === working) setTurnHint("", false); }, 2500);
}

// ── 폼 ──────────────────────────────────────────────────────────────────────
$("student-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await enterAsStudent($("in-code").value.trim(), $("in-name").value.trim());
  } catch (err) {
    $("room-hint").textContent = err.message;
    $("room-hint").classList.remove("hidden");
  }
});

$("teacher-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const signup = !$("signup-fields").classList.contains("hidden");
  const body = { id: $("in-id").value.trim(), password: $("in-pw").value };
  if (signup) { body.name = $("in-teacher-name").value.trim(); body.code = $("in-signup-code").value.trim(); }
  try {
    await api(`/api/auth/${signup ? "signup" : "login"}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    closeModal("teacher-login");
    await loadHome();
  } catch (err) {
    toast(err.message);
  }
});

$("upload-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const file = $("up-file").files[0];
  if (!file) return toast("파일을 골라 주세요.");
  const form = new FormData();
  form.set("title", $("up-title").value.trim());
  form.set("file", file);
  await sendUpload(form);
});

async function sendUpload(form) {
  const res = await fetch("/api/quizsets", { method: "POST", body: form });
  const body = await res.json().catch(() => ({}));

  if (res.status === 409) {
    if (confirm(body.error)) { form.set("overwrite", "true"); return sendUpload(form); }
    return;
  }
  if (!res.ok) {
    toast(body.error || "올리지 못했습니다.");
    if (body.problems?.length) {
      $("upload-problems").innerHTML = body.problems.map((p) => `<div>• ${esc(p)}</div>`).join("");
      $("upload-problems").classList.remove("hidden");
    }
    return;
  }
  closeModal("upload-modal");
  toast(`${body.title} · ${body.itemCount}문항${body.skipped ? ` (건너뜀 ${body.skipped})` : ""}`);
  if (body.problems?.length) showInfo("건너뛴 줄", body.problems.map((p) => `<div>• ${esc(p)}</div>`).join(""));
  $("up-title").value = "";
  $("up-file").value = "";
  await loadSets();
  updateSizeHint();
}

/** [종료]를 누른 그 자리에서 결과를 보여 준다. 지난 게임은 남기지 않는다. */
function showGameOver(msg) {
  if (APP.mode === "solving") { APP.mode = "waiting"; hideQuiz(); }
  const medal = ["🥇", "🥈", "🥉"];
  const rows = msg.players
    .map((p, i) => `<div class="kv"><span>${medal[i] ?? "&nbsp;&nbsp;"} ${p.team === "H" ? "🔴" : "🟢"} ${esc(p.name)}</span><b>${p.correct} / ${p.solved}</b></div>`)
    .join("");
  // 동점이면 "무승부 승리" 가 된다. 2026-09-01 수업에서 실제로 그렇게 떴다.
  const crown = msg.winner === "무승부" ? "무승부" : `${msg.winner} 승리`;
  showInfo("🏁 게임 끝!",
    `<div class="roomcode" style="font-size:34px;letter-spacing:2px">${esc(crown)}</div>
     <div class="scores" style="margin:10px 0">
       <div class="team score-H">홍팀 <b>${msg.scores.H.total}</b></div>
       <small>영토 ${msg.scores.H.territory} + 보너스 ${msg.scores.H.bonus}</small>
       <div class="team score-C">청팀 <b>${msg.scores.C.total}</b></div>
       <small>영토 ${msg.scores.C.territory} + 보너스 ${msg.scores.C.bonus}</small>
     </div>
     <h3 style="margin:14px 0 6px">맞힌 문제 (${msg.rounds}라운드 · ${esc(msg.quizTitle ?? "")})</h3>
     ${rows}`);
}

const CELL_NAME = { N: "보통 칸", T: "📦 보물 칸 (+2)", S: "⛈️ 폭풍 칸 (다음 턴 쉼)", A: "💥 공격 칸 (상대 칸 뺏기)" };

/** 선생님만 본다. 정답이 함께 보이므로 교실 TV 에 띄운 채로는 열지 않는 게 좋다. */
function showPeek(msg) {
  const owner = msg.owner ? `${msg.owner === "H" ? "홍팀" : "청팀"}${msg.ownerName ? ` (${esc(msg.ownerName)})` : ""}` : "아직 임자 없음";
  const options = msg.options
    .map((o, i) => `<div class="option" style="${i === msg.ans ? "border-color:#2b7d4a;background:#eaf6ee" : ""}">
        <b style="${i === msg.ans ? "background:#2b7d4a" : ""}">${i + 1}</b>${esc(o)}${i === msg.ans ? " ✅" : ""}</div>`)
    .join("");
  showInfo(`${msg.label} · ${CELL_NAME[msg.type] ?? msg.type}`,
    `<div class="kv"><span>주인</span><b>${owner}</b></div>
     <div class="kv"><span>도전 횟수</span><b>${msg.tried}회</b></div>
     ${msg.lockedBy ? `<div class="kv"><span>지금 푸는 중</span><b>${esc(msg.lockedBy)}</b></div>` : ""}
     <h3 style="margin:14px 0 8px">${esc(msg.q)}</h3>
     <div class="options">${options}</div>`);
}

function showInfo(title, html) {
  $("info-title").textContent = title;
  $("info-body").innerHTML = html;
  openModal("info-modal");
}

const LEVEL = { ok: "", warn: "warn", error: "error" };
const LEVEL_ICON = { ok: "✅", warn: "⚠️", error: "⛔" };

async function runDiagnose() {
  showInfo("🩺 시스템 점검", "<p>확인하는 중…</p>");
  let d;
  try {
    d = await api("/api/diagnose");
  } catch (err) {
    $("info-body").innerHTML = `<div class="diag error"><b>⛔ 서버에 물어보지 못했습니다</b><span>${esc(err.message)}</span></div>`;
    return;
  }

  // 화면 쪽에서만 알 수 있는 것들을 앞에 붙인다.
  const rows = [];
  if (d.build !== APP_BUILD) {
    rows.push({ level: "error", name: "화면 버전",
      detail: `브라우저가 옛 화면(${APP_BUILD})을 쓰고 있습니다. 서버는 ${d.build} 입니다.`,
      fix: "Ctrl+Shift+R 로 새로고침해 주세요. 학생 기기도 함께 해야 합니다." });
  } else {
    rows.push({ level: "ok", name: "화면 버전", detail: `서버와 같습니다 (${d.build}).` });
  }

  const skew = Math.round((d.serverNow - Date.now()) / 1000);
  rows.push(Math.abs(skew) > 30
    ? { level: "error", name: "이 컴퓨터 시계", detail: `서버와 ${skew}초 어긋나 있습니다.`,
        fix: "설정 → 시간 → [지금 동기화]. 시계가 틀리면 남은 시간이 이상하게 보입니다." }
    : { level: "ok", name: "이 컴퓨터 시계", detail: `서버와 ${skew}초 차이 — 정상입니다.` });

  rows.push(...d.checks);

  const worst = rows.some((r) => r.level === "error") ? "error" : rows.some((r) => r.level === "warn") ? "warn" : "ok";
  const summary = { ok: "✅ 모두 정상입니다. 수업을 시작하세요.",
    warn: "⚠️ 확인할 것이 있습니다. 아래를 읽어 주세요.",
    error: "⛔ 이대로는 수업이 안 됩니다. 아래를 먼저 해결해 주세요." }[worst];

  $("info-body").innerHTML =
    `<div class="warning ${worst === "error" ? "hot" : ""}">${summary}</div>
     <div class="diag-list">${rows.map((r) => `<div class="diag ${LEVEL[r.level]}">
        <b>${LEVEL_ICON[r.level]} ${esc(r.name)}</b>
        <span>${esc(r.detail)}${r.fix ? `<br><b>→ ${esc(r.fix)}</b>` : ""}</span>
      </div>`).join("")}</div>`;
}

async function previewSet() {
  const id = selectedSetId();
  if (!id) return toast("퀴즈를 하나 골라 주세요.");
  const d = await api(`/api/quizsets/${id}`);
  const items = d.preview
    .map((q, i) => `<p><b>${i + 1}. ${esc(q.q)}</b><br>${q.options.map((o, k) => `${k === q.ans ? "▶" : "&nbsp;&nbsp;"} ${k + 1}) ${esc(o)}`).join("<br>")}</p>`)
    .join("");
  const problems = d.problems.length ? `<div class="problems">${d.problems.map((p) => `<div>• ${esc(p)}</div>`).join("")}</div>` : "";
  showInfo(`${d.title} · ${d.itemCount}문항`, items + problems);
}

async function deleteSet() {
  const id = selectedSetId();
  if (!id) return toast("퀴즈를 하나 골라 주세요.");
  const set = APP.sets.find((s) => s.id === id);
  if (!confirm(`'${set.title}' 을 지울까요?`)) return;
  const out = await api(`/api/quizsets/${id}`, { method: "DELETE" });
  if (out.usedByRooms?.length) {
    toast(`지웠습니다. 방 ${out.usedByRooms.join(", ")} 은 그대로 진행됩니다.`);
  } else toast("지웠습니다.");
  await loadSets();
  updateSizeHint();
}

async function createRoom() {
  const quizSetId = selectedSetId();
  if (!quizSetId) return toast("퀴즈를 하나 골라 주세요.");
  // 같은 requestId 를 재시도에 그대로 쓰면 두 번 눌러도 방은 하나만 생긴다.
  const requestId = newActionId();
  try {
    const out = await api("/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId, quizSetId,
        label: $("cfg-label").value.trim(),
        rows: Number($("cfg-rows").value), cols: Number($("cfg-cols").value),
        turnSeconds: Number($("cfg-time").value), roundLimit: Number($("cfg-round").value),
        cntT: Number($("cfg-t").value), cntS: Number($("cfg-s").value), cntA: Number($("cfg-a").value),
      }),
    });
    showInfo("방을 만들었어요", `<div class="roomcode">${out.code}</div>
      <p style="text-align:center">학생들에게 이 번호를 알려 주세요.<br><b>${esc(out.quizTitle)}</b> · ${out.quizCount}문항</p>`);
    await loadRooms();
  } catch (err) {
    toast(err.message);
  }
}

// 인원은 나머지를 전부 다시 잡고, 나머지는 손으로 고쳐도 그대로 둔 채 판정만 새로 한다.
$("cfg-players").addEventListener("input", applyPlan);
for (const id of ["cfg-rows", "cfg-cols", "cfg-round", "cfg-t", "cfg-s", "cfg-a"]) {
  $(id).addEventListener("input", updateSizeHint);
}
$("quizsets").addEventListener("change", updateSizeHint);

// ── 관제 (슈퍼관리자 전용) ─────────────────────────────────────────────────
// 이 화면은 "누가 잘했나"를 묻지 않는다. "언제 했고, 잘 돌았나"만 묻는다.
// 그래서 학생 이름은 서버에도 없고 여기에도 나오지 않는다.
const SUP = { open: null }; // 펼쳐 둔 선생님 아이디

function supTime(ms) {
  if (!ms) return "—";
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const supRate = (correct, solved) => (solved ? `${Math.round((correct / solved) * 100)}%` : "—");

/** 이상 징후를 한 칸에 요약한다. 자세한 것은 펼쳤을 때 목록으로 보인다. */
function supLevel(g) {
  if (g.level === "error") return '<span class="sup-chip error">오류</span>';
  if (g.level === "warn") return `<span class="sup-chip warn">확인 ${g.issues.length}</span>`;
  return '<span class="sup-chip ok">정상</span>';
}

function supGames(games, withTeacher) {
  if (!games.length) return '<div class="sup-empty">아직 끝난 수업이 없습니다.</div>';
  return `<table class="sup-table">
    <tr><th>끝난 때</th><th>방</th>${withTeacher ? "<th>선생님</th>" : ""}<th>퀴즈</th>
        <th>결과</th><th class="num">인원</th><th class="num">정답률</th><th>상태</th></tr>
    ${games.map((g) => `<tr>
      <td>${supTime(g.endedAt)}</td>
      <td>${esc(g.roomCode)}${g.label ? `<br><small>${esc(g.label)}</small>` : ""}</td>
      ${withTeacher ? `<td>${esc(g.teacherId ?? "—")}</td>` : ""}
      <td>${esc(g.quizTitle ?? "—")}</td>
      <td>홍 ${g.scores.H} : 청 ${g.scores.C}<br><small>${esc(g.winner)} · ${g.rounds}/${g.roundLimit}R</small></td>
      <td class="num">${g.playerCount}</td>
      <td class="num">${supRate(g.correct, g.solved)}</td>
      <td>${supLevel(g)}${g.issues.length
        ? `<ul class="sup-issues">${g.issues.map((i) => `<li>${esc(i.detail)}</li>`).join("")}</ul>`
        : ""}</td>
    </tr>`).join("")}
  </table>`;
}

function supRender(d) {
  $("super-when").textContent = `· ${supTime(d.serverNow)} 기준`;

  const rooms = d.openRooms.length
    ? `<table class="sup-table">
        <tr><th>방</th><th>반</th><th>선생님</th><th>퀴즈</th><th>지금</th><th>연 때</th></tr>
        ${d.openRooms.map((r) => `<tr>
          <td class="sup-name">${esc(r.code)}</td>
          <td>${esc(r.label ?? "—")}</td>
          <td>${esc(r.teacherName ?? r.teacherId)}</td>
          <td>${esc(r.quizTitle ?? "—")}</td>
          <td>${r.live
            ? `<span class="sup-chip live">${esc(r.live.status)}</span> 학생 ${r.live.players}명 · 접속 ${r.live.online}`
            : '<span class="sup-chip error">응답 없음</span>'}</td>
          <td>${supTime(r.createdAt)}</td>
        </tr>`).join("")}
      </table>`
    : '<div class="sup-empty">지금 열려 있는 방이 없습니다.</div>';

  const teachers = `<table class="sup-table">
    <tr><th>선생님</th><th class="num">퀴즈</th><th class="num">수업</th>
        <th>마지막 수업</th><th>마지막 로그인</th><th class="num">열린 방</th></tr>
    ${d.teachers.map((t) => `<tr class="sup-row${SUP.open === t.id ? " on" : ""}" data-teacher="${esc(t.id)}">
      <td><span class="sup-name">${esc(t.name)}</span> <small>${esc(t.id)}</small>
          ${t.isSuper ? '<span class="sup-chip super">관리자</span>' : ""}</td>
      <td class="num">${t.quizCount}</td>
      <td class="num">${t.gameCount}</td>
      <td>${supTime(t.lastGameAt)}</td>
      <td>${supTime(t.lastLoginAt)}</td>
      <td class="num">${t.openRooms || "—"}</td>
    </tr>`).join("")}
  </table>
  <div id="super-detail"></div>`;

  $("super-body").innerHTML =
    `<div class="sup-sec"><h3>지금 열려 있는 방 (${d.openRooms.length})</h3>${rooms}</div>
     <div class="sup-sec"><h3>선생님 (${d.teachers.length}명) — 줄을 누르면 펼쳐집니다</h3>${teachers}</div>
     <div class="sup-sec"><h3>최근 수업 (${d.recentGames.length})</h3>${supGames(d.recentGames, true)}</div>
     <div class="sup-note">수업 기록에는 학생 이름이 들어가지 않습니다. 60일이 지나면 자동으로 지워집니다.</div>`;

  if (SUP.open) supDetail(SUP.open);
}

async function openSuper() {
  openModal("super-modal");
  $("super-body").innerHTML = '<div class="sup-empty">불러오는 중…</div>';
  try {
    supRender(await api("/api/admin/overview"));
  } catch (err) {
    $("super-body").innerHTML = `<div class="warning hot">관제 정보를 읽지 못했습니다 — ${esc(err.message)}</div>`;
  }
}

async function toggleTeacher(id) {
  if (SUP.open === id) {
    SUP.open = null;
    $("super-detail").innerHTML = "";
    for (const el of document.querySelectorAll(".sup-row.on")) el.classList.remove("on");
    return;
  }
  SUP.open = id;
  for (const el of document.querySelectorAll("[data-teacher]")) {
    el.classList.toggle("on", el.dataset.teacher === id);
  }
  await supDetail(id);
}

async function supDetail(id) {
  const box = $("super-detail");
  if (!box) return;
  box.innerHTML = '<div class="sup-empty">불러오는 중…</div>';
  let d;
  try {
    d = await api(`/api/admin/teachers/${encodeURIComponent(id)}`);
  } catch (err) {
    box.innerHTML = `<div class="warning hot">${esc(err.message)}</div>`;
    return;
  }

  const quizzes = d.quizSets.length
    ? `<ul class="sup-quiz">${d.quizSets.map((s) => `<li>
        <span><b>${esc(s.title)}</b> <small>${s.itemCount}문항${s.skipped ? ` · 건너뜀 ${s.skipped}` : ""}
          · ${supTime(s.updatedAt)}</small></span>
        <button class="button muted" data-quiz="${s.id}">훑어보기</button>
      </li>`).join("")}</ul>`
    : '<div class="sup-empty">올려 둔 퀴즈가 없습니다.</div>';

  box.innerHTML = `<div class="sup-detail">
    <h3>📚 ${esc(d.teacher.name)} 선생님의 퀴즈 (${d.quizSets.length}) — 보기만 합니다</h3>
    ${quizzes}
    <h3 style="margin-top:12px">🎮 지난 수업 (${d.games.length})</h3>
    ${supGames(d.games, false)}
    <h3 style="margin-top:12px">🔑 비밀번호</h3>
    <div class="sup-reset">
      <span>잊어버렸다고 하면 새로 정해 줄 수 있습니다. 옛 비밀번호는 아무도 알 수 없습니다.</span>
      <button class="button muted" data-reset="${esc(d.teacher.id)}">비밀번호 재설정</button>
    </div>
  </div>`;
}

/**
 * 남의 비밀번호를 새로 정해 준다. 관제에서 유일하게 남의 것을 바꾸는 자리라,
 * 실수로 눌리지 않게 한 번 되묻고 결과를 크게 보여 준다.
 */
async function resetTeacherPassword(id) {
  const 직접 = prompt(
    `${id} 선생님의 비밀번호를 새로 정합니다.\n\n` +
      "· 새 비밀번호를 적으면 그것으로 바뀝니다\n" +
      "· 비워 두고 확인을 누르면 임시 비밀번호를 지어 드립니다\n" +
      "· 그 선생님은 지금 열려 있는 화면에서 모두 로그아웃됩니다",
    "",
  );
  if (직접 === null) return; // 취소

  try {
    const out = await api(`/api/admin/teachers/${encodeURIComponent(id)}/password`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: 직접.trim() }),
    });
    showInfo(
      "🔑 비밀번호를 새로 정했습니다",
      `<p><b>${esc(id)}</b> 선생님의 새 비밀번호입니다. <b>이 창을 닫으면 다시 볼 수 없습니다.</b></p>
       <div class="sup-newpw">${esc(out.password)}</div>
       <div class="warning">그 선생님은 열려 있던 화면에서 모두 로그아웃되었습니다.
         ${id === APP.teacher?.id ? "<b>본인 계정이므로 나가기 후 다시 로그인해야 합니다.</b>" : ""}</div>`,
    );
  } catch (err) {
    toast(err.message);
  }
}

async function previewOtherQuiz(id) {
  showInfo("📖 퀴즈 훑어보기", "<p>불러오는 중…</p>");
  try {
    const q = await api(`/api/admin/quizsets/${id}`);
    $("info-title").textContent = `📖 ${q.title}`;
    $("info-body").innerHTML =
      `<p><b>${esc(q.teacherName ?? q.teacherId)}</b> 선생님 · ${q.itemCount}문항
        ${q.skipped ? ` · 건너뜀 ${q.skipped}` : ""}</p>
       <div class="diag-list">${q.preview.map((it, i) => `<div class="diag">
         <b>${i + 1}. ${esc(it.q)}</b>
         <span>${it.options.map((o, k) => `${k === it.ans ? "✅" : "·"} ${esc(o)}`).join("<br>")}</span>
       </div>`).join("")}</div>
       <div class="sup-note">앞 ${q.preview.length}문항만 보여 줍니다. 고치거나 지울 수는 없습니다.</div>`;
  } catch (err) {
    $("info-body").innerHTML = `<div class="warning hot">${esc(err.message)}</div>`;
  }
}

// 새로고침해도 하던 자리로 돌아온다.
(async () => {
  try {
    await loadHome();
  } catch {
    const code = localStorage.getItem("treasure-room");
    const name = localStorage.getItem("treasure-player-name");
    if (code && name) {
      try { await enterAsStudent(code, name); } catch { showScreen("entry"); }
    } else showScreen("entry");
  }
})();
