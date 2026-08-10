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
  clockOffset: 0,
  sets: [],
  teacher: null,
};

/** 서버의 BUILD 와 같아야 한다. 다르면 브라우저가 옛 화면을 물고 있는 것이다. */
const APP_BUILD = "2026-08-10b";

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
  if (!admin && me && me.pos !== null && canPlay()) {
    for (const i of neighbors(me.pos, st.rows, st.cols)) {
      if (st.cellLocks[i]) continue;
      candidates[i] = st.board[i].o === me.team ? "move" : st.board[i].o ? "enemy" : "can";
    }
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
    if (!APP.syncing) { APP.syncing = true; netSend({ t: "sync" }); }
    return false;
  }
  return false; // 늦게 도착한 옛 메시지
}

function onMessage(msg) {
  applyClock(msg);
  switch (msg.t) {
    case "state": {
      APP.syncing = false;
      APP.rev = msg.stateRev;
      APP.state = msg;
      if (msg.myPlayer) {
        APP.playerId = msg.myPlayer.id;
        localStorage.setItem("treasure-player-id", msg.myPlayer.id);
      }
      if (APP.mode !== "solving") APP.mode = "waiting";
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
      }
      if (APP.mode !== "solving") APP.mode = "waiting";
      // 폭풍으로 쉬는지는 서버만 안다. 턴이 바뀌면 내 상태를 한 번 확인한다.
      if (APP.role === "student") netSend({ t: "sync" });
      render();
      return;
    }
    case "quiz":
      if (APP.mode === "solving" && APP.currentCell === msg.cell) renderQuiz(msg);
      return;
    case "result":
      showResult(msg);
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
function hideQuiz() {
  $("quiz-card").classList.add("hidden");
  $("student-message").classList.remove("hidden");
}

function renderQuiz(msg) {
  $("quiz-cell").textContent = cellLabel(msg.cell, APP.state.cols);
  $("quiz-question").textContent = msg.q;
  $("quiz-options").innerHTML = msg.options
    .map((x, i) => `<button class="option" data-choice="${i}"><b>${i + 1}</b>${esc(x)}</button>`)
    .join("");
  $("student-message").classList.add("hidden");
  $("result-card").classList.add("hidden");
  $("quiz-card").classList.remove("hidden");
}

function selectCell(cell) {
  const why = blockReason();
  if (why || APP.mode === "solving") {
    const said = {
      시간초과: "이번 턴 시간이 끝났어요.",
      상대팀턴: "지금은 상대 팀 차례예요.",
      이번턴완료: "이번 턴 문제는 이미 풀었어요.",
      폭풍쉼: "⛈️ 이번 턴은 폭풍으로 쉽니다.",
      시작전: "아직 시작 전이에요. 선생님을 기다려 주세요.",
      게임종료: "게임이 끝났어요.",
    }[why];
    if (said) toast(said);
    return;
  }
  APP.currentCell = cell;
  APP.mode = "solving";
  // 문제는 미리 안 들고 있는다. 서버가 채점에 쓸 바로 그 문제를 보내 주면 그때 그린다.
  netSend({ t: "pick", cell, actionId: newActionId() });
}

function submitChoice(choice) {
  if (APP.submitting || APP.mode !== "solving") return;
  APP.submitting = true;
  // 두 번 눌리면 두 번째 채점이 실패하고, 그 실패가 화면을 굳게 만들었다(2026-08-09 "정").
  for (const b of $("quiz-options").querySelectorAll("button")) b.disabled = true;
  netSend({ t: "answer", cell: APP.currentCell, choice, actionId: newActionId() });
}

function showResult(msg) {
  APP.submitting = false;
  APP.mode = "result";
  // patch 에는 "내" 정보가 없다. 서버가 알려 준 이 값을 안 넣으면
  // 결과창이 사라진 뒤 칸이 다시 켜져서 한 문제 더 풀 수 있는 것처럼 보인다.
  if (APP.state?.myPlayer) {
    APP.state.myPlayer.playedThisTurn = true;
    if (msg.skipNextTurn) APP.state.iAmSkipping = true;
  }
  hideQuiz();
  $("student-message").classList.add("hidden");
  $("result-card").classList.remove("hidden");
  $("result-big").className = `big ${msg.correct ? "ok" : "no"}`;
  $("result-big").textContent = msg.correct ? "정답!" : "아쉬워요";
  $("result-message").textContent = msg.correct && msg.bonusSkipped
    ? "정답입니다. 이 칸의 보너스는 이미 받았어요."
    : `정답은 ${msg.answerText} 입니다.`;
  $("result-gain").textContent = msg.correct ? `+${msg.gain}점` : "점령 실패";
  setTimeout(() => {
    if (APP.mode !== "result") return;
    APP.mode = "waiting";
    $("result-card").classList.add("hidden");
    $("student-message").classList.remove("hidden");
    render();
  }, 3000);
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

function updateSizeHint() {
  const rows = Number($("cfg-rows").value);
  const cols = Number($("cfg-cols").value);
  const set = APP.sets.find((s) => s.id === selectedSetId());
  const cells = rows * cols;
  const repeats = set ? Math.ceil(cells / set.itemCount) : 0;
  $("size-hint").innerHTML = `${rows}×${cols} = <b>${cells}칸</b> · 정원 <b>${Math.floor(cells / 2.4)}명</b>`
    + (set ? ` · 문항 ${set.itemCount}개라 각 문제가 최대 ${repeats}번 나와요` : "");
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
    if (APP.role === "student") return selectCell(idx);
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
  showInfo("🏁 게임 끝!",
    `<div class="roomcode" style="font-size:34px;letter-spacing:2px">${esc(msg.winner)} 승리</div>
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

for (const id of ["cfg-rows", "cfg-cols"]) $(id).addEventListener("input", updateSizeHint);
$("quizsets").addEventListener("change", updateSizeHint);

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
