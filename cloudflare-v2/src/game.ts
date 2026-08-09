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
 * 방 정원. 10×10 → 41명 · 12×12 → 60명 · 15×15 → 93명.
 * 이보다 빽빽하면 서로 겹치지 않는 자리를 찾지 못하거나, 찾아도 둘레가 전부 아군이 된다.
 */
export function maxPlayers(rows: number, cols: number): number {
  return Math.floor((rows * cols) / 2.4);
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

/** 이 자리에 서면 도전할 칸(아군 칸이 아닌 이웃)이 하나라도 있는가 */
export function canChallengeFrom(view: PlacementView, pos: number, team: Team): boolean {
  return neighbors8(pos, view.rows, view.cols).some((n) => view.owners[n] !== team);
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
export function assignRandomPositions(view: PlacementView): void {
  const n = view.owners.length;
  if (view.players.length > n) {
    throw new Error(`학생 수(${view.players.length}명)가 칸 수(${n}칸)보다 많습니다. 보드를 키워 주세요.`);
  }
  const pool: number[] = [];
  for (let i = 0; i < n; i++) pool.push(i);
  shuffle(pool);

  const order = shuffle([...view.players]);
  order.forEach((p, k) => {
    p.pos = pool[k]!;
    setOwner(view, p.pos, p.team);
  });
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
export function rescueTrapped(view: PlacementView, team: Team): string[] {
  const occupied = occupiedMap(view, null);
  const moved: string[] = [];

  for (const p of view.players) {
    if (p.team !== team) continue;
    if (p.pos === null) continue;
    if (canChallengeFrom(view, p.pos, team)) continue;

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
