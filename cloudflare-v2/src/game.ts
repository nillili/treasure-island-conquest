/**
 * 게임 규칙 — apps-script/Backend.gs 에서 그대로 옮겼다. 로직을 바꾸지 않는다.
 *
 * 여기 있는 것은 전부 순수 함수다. SQLite 를 건드리는 부분은 room.ts 가 맡는다.
 * (원본은 상태 객체 하나를 통째로 고쳤지만, 새 구조에서는 정본이 SQLite 라
 *  "읽어서 계산 → SQL 로 쓰기" 모양으로 감싼다.)
 */

export type Team = "H" | "C";
export type Owner = Team | null;
export type CellType = "N" | "T" | "S" | "A";

// ── 기하 (Backend.gs:775-812) ───────────────────────────────────────────────

export function columnLabel(c: number): string {
  let s = "";
  let n = c + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function rc(idx: number, cols: number): { r: number; c: number } {
  return { r: Math.floor(idx / cols), c: idx % cols };
}

export function cellIndex(r: number, c: number, cols: number): number {
  return r * cols + c;
}

export function cellLabel(idx: number, cols: number): string {
  const p = rc(idx, cols);
  return columnLabel(p.c) + (p.r + 1);
}

/**
 * 둘레 8칸(상하좌우 + 대각선). 이동·도전·구출·문제 배분이 전부 이 하나를 쓴다.
 * 모서리 3칸 · 가장자리 5칸 · 안쪽 8칸.
 */
export function neighbors8(pos: number, rows: number, cols: number): number[] {
  const p = rc(pos, cols);
  const out: number[] = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const r = p.r + dr;
      const c = p.c + dc;
      if (r < 0 || r >= rows || c < 0 || c >= cols) continue;
      out.push(cellIndex(r, c, cols));
    }
  }
  return out;
}

export function chebyshev(a: number, b: number, cols: number): number {
  const x = rc(a, cols);
  const y = rc(b, cols);
  return Math.max(Math.abs(x.r - y.r), Math.abs(x.c - y.c));
}

// ── 판 만들기 (Backend.gs:665, 937, 955) ────────────────────────────────────

export function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]!;
    a[i] = a[j]!;
    a[j] = t;
  }
  return a;
}

/**
 * 칸마다 문제 번호를 배분한다. 문항이 칸보다 적으면 돌려 쓰되,
 * 이웃끼리 같은 문제가 안 걸리도록 3패스까지 자리를 바꾼다.
 */
export function assignQuizzes(cellCount: number, rows: number, cols: number, quizCount: number): number[] {
  if (quizCount < 1) throw new Error("문항이 없습니다.");
  let seq: number[] = [];
  while (seq.length < cellCount) {
    const block: number[] = [];
    for (let i = 0; i < quizCount; i++) block.push(i);
    seq = seq.concat(shuffle(block));
  }
  seq = seq.slice(0, cellCount);

  const cells: number[] = [];
  for (let i = 0; i < cellCount; i++) cells.push(i);
  shuffle(cells);

  const q = new Array<number>(cellCount);
  for (let i = 0; i < cellCount; i++) q[cells[i]!] = seq[i]!;

  for (let pass = 0; pass < 3; pass++) {
    let swapped = 0;
    for (let i = 0; i < cellCount; i++) {
      const nb = neighbors8(i, rows, cols);
      for (let k = 0; k < nb.length; k++) {
        if (q[nb[k]!] === q[i]) {
          const j = Math.floor(Math.random() * cellCount);
          const tmp = q[i]!;
          q[i] = q[j]!;
          q[j] = tmp;
          swapped++;
          break;
        }
      }
    }
    if (!swapped) break;
  }
  return q;
}

/** 판 한 변의 범위. 10 아래는 배치가 빡빡하고, 15 위는 교실 화면에서 칸이 너무 작아진다. */
export const MIN_SIDE = 10;
export const MAX_SIDE = 15;

/** 판 크기가 범위 안인지. 문제가 있으면 안내 문구, 없으면 null. */
export function checkBoardSize(rows: number, cols: number): string | null {
  const ok = (n: number) => Number.isInteger(n) && n >= MIN_SIDE && n <= MAX_SIDE;
  if (!ok(rows) || !ok(cols)) return `판 크기는 ${MIN_SIDE}×${MIN_SIDE} 부터 ${MAX_SIDE}×${MAX_SIDE} 까지입니다.`;
  return null;
}

export interface BoardConfig {
  rows: number;
  cols: number;
  cntT: number;
  cntS: number;
  cntA: number;
}

export interface NewCell {
  type: CellType;
  quizIdx: number;
}

export function buildBoard(cfg: BoardConfig, quizCount: number): NewCell[] {
  const sizeProblem = checkBoardSize(cfg.rows, cfg.cols);
  if (sizeProblem) throw new Error(sizeProblem);

  const n = cfg.rows * cfg.cols;
  const total = cfg.cntT + cfg.cntS + cfg.cntA;
  if (total > n) throw new Error("특수칸이 전체 칸보다 많습니다. 특수칸 수를 줄여 주세요.");

  const quizIdx = assignQuizzes(n, cfg.rows, cfg.cols, quizCount);
  const board: NewCell[] = [];
  for (let i = 0; i < n; i++) board.push({ type: "N", quizIdx: quizIdx[i]! });

  const pool: number[] = [];
  for (let i = 0; i < n; i++) pool.push(i);
  shuffle(pool);

  let p = 0;
  const counts: [CellType, number][] = [["T", cfg.cntT], ["S", cfg.cntS], ["A", cfg.cntA]];
  for (const [type, count] of counts) {
    for (let k = 0; k < count; k++) board[pool[p++]!]!.type = type;
  }
  return board;
}

/** 선생님 화면의 판 크기 안내 (Backend.gs:218) */
export function sizeHint(rows: number, cols: number, quizCount: number) {
  return {
    cells: rows * cols,
    repeats: quizCount ? Math.ceil((rows * cols) / quizCount) : 0,
    last: columnLabel(cols - 1) + rows,
  };
}

/**
 * 한 판을 끝까지 하는 데 필요한 칸 수를 어림하는 정답률.
 * 실측(2026-08-25 22명 82.7%, 08-29 9명 85%)에 맞춘 값이다.
 */
const SOLVE_RATE = 0.85;

/**
 * 방 정원.
 *
 * 예전에는 배치 밀도(칸/2.4)만 봤다. 상대 땅을 뺏을 수 있어서 칸이 재활용됐기 때문이다.
 * 2026-08-29 규칙 변경으로 **임자 없는 칸만 먹을 수 있게 되자 칸이 재활용되지 않는다.**
 * 그래서 이제는 게임 길이가 상한을 정한다 — 한 사람이 초기 배치 한 칸에 라운드마다 한 칸씩
 * 더 먹으므로, 그만큼의 빈 칸이 처음부터 있어야 판이 중간에 마르지 않는다.
 *
 * 12×12 · 10라운드 → 15명 · 15×15 · 10라운드 → 23명 (예전에는 각각 60명 · 93명이었다)
 */
export function maxPlayers(rows: number, cols: number, roundLimit = 10): number {
  const cells = rows * cols;
  const byPlacement = Math.floor(cells / 2.4); // 서로 겹치지 않게 세울 수 있는 한계
  const byGameLength = Math.floor(cells / (1 + roundLimit * SOLVE_RATE));
  return Math.max(1, Math.min(byPlacement, byGameLength));
}

/** 이 인원으로 한 판을 하려면 한 변이 최소 얼마여야 하는가. 안내 문구에 쓴다. */
export function minSideFor(players: number, roundLimit = 10): number {
  for (let side = MIN_SIDE; side <= MAX_SIDE; side++) {
    if (maxPlayers(side, side, roundLimit) >= players) return side;
  }
  return MAX_SIDE;
}

// ── 배치 (Backend.gs:868-935) ──────────────────────────────────────────────

export interface PlacementPlayer {
  id: string;
  team: Team;
  pos: number | null;
}

/** 배치 함수들이 보는 최소한의 판. owners 와 players[].pos 를 직접 고친다. */
export interface PlacementView {
  rows: number;
  cols: number;
  owners: Owner[];
  players: PlacementPlayer[];
}

/**
 * 이 자리에 서면 도전할 칸(임자 없는 이웃)이 하나라도 있는가.
 *
 * 2026-08-29 규칙 변경 — **상대가 이미 먹은 땅은 도전할 수 없다.** 그래서 "아군이 아닌 칸"
 * 이 아니라 "임자 없는 칸" 만 센다. 상대 땅을 가져오는 길은 공격 아이템 하나뿐이다.
 * team 을 더는 보지 않지만, 부르는 쪽 서명을 바꾸지 않으려고 자리는 남겨 둔다.
 */
export function canChallengeFrom(view: PlacementView, pos: number, _team: Team): boolean {
  return neighbors8(pos, view.rows, view.cols).some((n) => view.owners[n] === null);
}

function occupiedMap(view: PlacementView, exceptId: string | null): Set<number> {
  const out = new Set<number>();
  for (const p of view.players) {
    if (p.id !== exceptId && p.pos !== null) out.add(p.pos);
  }
  return out;
}

/** 칸 주인을 바꾼다. 실제로 바뀌었으면 true. 영토 수는 SQL 의 COUNT 로 센다. */
export function setOwner(view: PlacementView, idx: number, team: Team): boolean {
  if (view.owners[idx] === team) return false;
  view.owners[idx] = team;
  return true;
}

/**
 * 새 게임: 전원을 서로 겹치지 않게 무작위 배치하고 선 자리를 그 학생의 팀 색으로 칠한다.
 * 시작 칸을 칠하지 않던 때는 교실 TV 에 보드가 온통 회색이라 교사가 "배치가 안 됐다"고 읽었다
 * (2026-08-05 시연 피드백).
 */
/**
 * 새 게임: 전원을 **최대한 서로 멀리** 떼어 놓고, 선 자리를 그 학생의 팀 색으로 칠한다.
 *
 * 예전에는 완전 무작위였다. 상대 땅을 뺏을 수 있던 때는 뭉쳐 서도 서로 풀어 나갈 여지가
 * 있었지만, 임자 없는 칸만 먹을 수 있게 된 뒤로는 뭉치면 곧바로 서로의 앞길을 막는다.
 * 그래서 이미 놓인 사람들에게서 가장 먼 빈 칸을 차례로 고른다(가장 먼 점 고르기).
 *
 * 후보를 전부 훑지 않고 무작위로 몇 개만 보는 이유는, 30명 × 225칸을 매번 완전 탐색하면
 * 느려서가 아니라 **매 판 똑같은 그림이 나오기 때문이다.** 적당히 섞여야 놀이가 된다.
 */
export function assignRandomPositions(view: PlacementView): void {
  const n = view.owners.length;
  if (view.players.length > n) {
    throw new Error(`학생 수(${view.players.length}명)가 칸 수(${n}칸)보다 많습니다. 보드를 키워 주세요.`);
  }

  const free: number[] = [];
  for (let i = 0; i < n; i++) free.push(i);
  shuffle(free);

  const taken: number[] = [];
  const order = shuffle([...view.players]);
  const SAMPLE = 40; // 후보 표본. 전수 탐색이 아니라 이만큼만 보고 그중 가장 먼 곳을 고른다

  for (const p of order) {
    let bestAt = 0;
    if (taken.length) {
      let bestScore = -1;
      const look = Math.min(SAMPLE, free.length);
      for (let k = 0; k < look; k++) {
        const cell = free[k]!;
        // 이미 놓인 사람 중 가장 가까운 사람과의 거리 — 이게 클수록 넓게 퍼진다
        let nearest = Infinity;
        for (const t of taken) {
          const d = chebyshev(cell, t, view.cols);
          if (d < nearest) nearest = d;
          if (nearest <= 1) break; // 더 볼 것 없다
        }
        if (nearest > bestScore) { bestScore = nearest; bestAt = k; }
      }
    }
    const pos = free.splice(bestAt, 1)[0]!;
    p.pos = pos;
    taken.push(pos);
    setOwner(view, pos, p.team);
  }
}

/**
 * 게임이 만들어진 뒤에 들어온 학생. 비어 있는 칸 중 도전 가능한 자리를 우선해 무작위로 준다.
 * 새 게임 때와 똑같이 선 자리를 팀 색으로 칠한다 — 이게 빠져 있어서 새 게임을 먼저 누르고
 * 학생을 받으면 보드가 회색인 채 이름만 뜨는 일이 생겼다(2026-08-05).
 * 남의 땅을 들어오자마자 뺏지는 않으므로 임자 없는 칸을 먼저 고른다.
 */
export function placeLatePlayer(view: PlacementView, playerId: string): number {
  const p = view.players.find((x) => x.id === playerId);
  if (!p) throw new Error("학생을 찾을 수 없습니다.");

  const occupied = occupiedMap(view, playerId);
  const free: number[] = [];
  for (let i = 0; i < view.owners.length; i++) if (!occupied.has(i)) free.push(i);
  if (!free.length) throw new Error("새 학생의 말을 놓을 빈 칸이 없습니다.");

  const usable = (list: number[]) => list.filter((i) => canChallengeFrom(view, i, p.team));
  const neutral = usable(free.filter((i) => !view.owners[i]));
  const usableFree = usable(free);
  const from = neutral.length ? neutral : usableFree.length ? usableFree : free;

  p.pos = from[Math.floor(Math.random() * from.length)]!;
  if (!view.owners[p.pos]) setOwner(view, p.pos, p.team);
  return p.pos;
}

/**
 * 턴 시작 시 아군 영토에 갇힌 학생을 가장 가까운 도전 가능한 빈자리로 옮긴다.
 * 이게 없으면 게임이 진행될수록 자기 팀 땅에 둘러싸인 학생이 문제를 못 푼다.
 * 옮긴 학생의 id 목록을 돌려준다.
 */
export function rescueTrapped(view: PlacementView, team: Team, leaveAlone?: Set<string>): string[] {
  const occupied = occupiedMap(view, null);
  const moved: string[] = [];

  for (const p of view.players) {
    if (p.team !== team) continue;
    if (p.pos === null) continue;
    if (canChallengeFrom(view, p.pos, team)) continue;
    // 이번 턴을 갇힌 벌로 쉬는 사람은 그 자리에 둔다. 몰아넣은 쪽이 결과를 볼 수 있어야
    // 가두는 전략이 성립한다. 쉬고 난 다음 턴에 이 함수가 꺼내 준다.
    if (leaveAlone?.has(p.id)) continue;

    const seen = new Set<number>();
    const queue: number[] = [p.pos];
    while (queue.length) {
      const cur = queue.shift()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      if (cur !== p.pos && !occupied.has(cur) && canChallengeFrom(view, cur, team)) {
        occupied.delete(p.pos);
        p.pos = cur;
        occupied.add(cur);
        moved.push(p.id);
        break;
      }
      for (const n of neighbors8(cur, view.rows, view.cols)) if (!seen.has(n)) queue.push(n);
    }
  }
  return moved;
}

/**
 * 지금 갇혀 있는 학생의 id 목록. 둘레 8칸에 임자 없는 칸이 하나도 없는 사람이다.
 *
 * 2026-09-01 에 규칙이 바뀌었다. 예전에는 갇히면 조용히 빈자리로 옮겨 줬는데,
 * 이제는 갇힌 그 턴을 쉰다 — 상대를 가두는 것이 하나의 수가 된다.
 */
export function trappedPlayers(view: PlacementView, team: Team): string[] {
  const out: string[] = [];
  for (const p of view.players) {
    if (p.team !== team || p.pos === null) continue;
    if (!canChallengeFrom(view, p.pos, team)) out.push(p.id);
  }
  return out;
}

/** 공격칸: 빼앗을 상대 칸 하나를 무작위로 고른다. 없으면 null. */
export function pickStealTarget(owners: Owner[], team: Team): number | null {
  const enemy: Team = team === "H" ? "C" : "H";
  const owned: number[] = [];
  owners.forEach((o, i) => {
    if (o === enemy) owned.push(i);
  });
  if (!owned.length) return null;
  return owned[Math.floor(Math.random() * owned.length)]!;
}

// ── 턴 (Backend.gs:843, 1146) ──────────────────────────────────────────────

export function turnKey(turnTeam: Team | null, round: number): string {
  return `${turnTeam}:${round}`;
}

/** 다음 차례. 아직 시작 전이면 홍팀부터, 청팀이 끝나면 라운드가 하나 오른다. */
export function nextTurn(turnTeam: Team | null, round: number): { turnTeam: Team; round: number } {
  if (!turnTeam) return { turnTeam: "H", round };
  if (turnTeam === "H") return { turnTeam: "C", round };
  return { turnTeam: "H", round: round + 1 };
}

export function winnerOf(hTotal: number, cTotal: number): string {
  if (hTotal === cTotal) return "무승부";
  return hTotal > cTotal ? "홍팀" : "청팀";
}
