import { DurableObject } from "cloudflare:workers";
import {
  type CellType,
  type Owner,
  type PlacementPlayer,
  type PlacementView,
  type Team,
  assignRandomPositions,
  buildBoard,
  maxPlayers,
  minSideFor,
  neighbors8,
  nextTurn,
  placeLatePlayer,
  rescueTrapped,
  trappedPlayers,
  cellLabel,
  turnKey,
  winnerOf,
} from "./game";
import {
  ERROR_CODES as E,
  type ClientMessage,
  type FxKind,
  type GameIssue,
  type LogEntry,
  type PublicCell,
  type PublicPlayer,
  type Scores,
  type TurnFx,
} from "./protocol";
import { loadQuizSet } from "./quizsets";
import { SCHEMA } from "./schema";

const IDLE_MS = 3 * 60 * 60 * 1000; // 마지막 활동 후 3시간이면 방을 닫는다
const TURN_DEBOUNCE_MS = 2000; // [다음 턴] 연타 방지
const LOG_LIMIT = 30;

export interface InitArg {
  provisionId: string;
  code: string;
  teacherId: string;
  label: string | null;
  quizSetId: number;
  rows: number;
  cols: number;
  roundLimit: number;
  turnSeconds: number;
  cntT: number;
  cntS: number;
  cntA: number;
}

export interface RoomSummary {
  ready: boolean;
  code: string;
  label: string | null;
  quizTitle: string | null;
  status: string;
  playerCount: number;
}

interface RoomRow {
  [key: string]: SqlStorageValue;
  code: string;
  teacher_id: string;
  label: string | null;
  quiz_set_id: number | null;
  quiz_title: string | null;
  status: string;
  game_id: string | null;
  rows: number;
  cols: number;
  round: number;
  round_limit: number;
  turn_team: Team | null;
  turn_ends_at: number | null;
  turn_seconds: number;
  cnt_t: number;
  cnt_s: number;
  cnt_a: number;
  bonus_h: number;
  bonus_c: number;
  rev: number;
  last_turn_at: number | null;
  last_cmd_id: string | null;
  last_cmd_result: string | null;
  provision_id: string | null;
  created_at: number;
  last_active_at: number;
}

interface PlayerRow {
  [key: string]: SqlStorageValue;
  id: string;
  name: string;
  team: Team;
  pos: number | null;
  skip_turns: number;
  skip_turn_key: string | null;
  last_played_turn_key: string | null;
  attempt_cell: number | null;
  solved: number;
  correct: number;
  last_action_id: string | null;
  last_action_result: string | null;
}

interface CellRow {
  [key: string]: SqlStorageValue;
  idx: number;
  type: CellType;
  quiz_idx: number;
  owner: Owner;
  bonus_taken: number;
  tried: number;
  locked_by: string | null;
  locked_until: number | null;
}

interface Attach {
  role: "student" | "teacher" | null;
  playerId?: string;
  teacherAtUpgrade: string | null;
}

/** 요청자에게 돌려줄 것과 방 전체에 뿌릴 것. */
interface ActionResult {
  reply?: unknown;
  broadcast?: unknown;
  /**
   * 전체 상태를 뿌려야 하는 경우. 하나를 만들어 돌려 쓰면 안 된다 —
   * state 에는 "내 말·내 점수"(myPlayer)가 들어 있어서, 한 벌로 뿌리면
   * 모든 학생이 자기 정보를 잃고 아무것도 못 누르게 된다.
   */
  broadcastState?: boolean;
}

class Refused extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** 방 하나 = 이 객체 하나. 방번호로 getByName() 하면 항상 같은 인스턴스로 온다. */
export class RoomDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ensureSchema();
    });
    // 살아있음 확인은 DO 를 깨우지 않는다. 시계 보정은 state·patch·turn 에 얹어 보낸다.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("PING", "PONG"));
  }

  private get sql() {
    return this.ctx.storage.sql;
  }

  /**
   * 멱등이라 몇 번을 불러도 안전하다. 생성자와 init() 두 곳에서 부른다.
   * 방을 정리할 때 deleteAll() 로 테이블까지 지우는데, 같은 인스턴스가 메모리에 남아 있으면
   * 생성자가 다시 돌지 않는다. init() 에서 보장하지 않으면 재사용된 방번호가 SQL 오류로 죽는다.
   */
  private ensureSchema(): void {
    this.sql.exec(SCHEMA);
  }

  // ── 읽기 ────────────────────────────────────────────────────────────────

  private room(): RoomRow | undefined {
    return this.sql.exec<RoomRow>("SELECT * FROM room WHERE id = 1").toArray()[0];
  }

  private needRoom(): RoomRow {
    const row = this.room();
    if (!row) throw new Refused(E.noRoom, "방이 아직 준비되지 않았습니다.");
    return row;
  }

  private players(): PlayerRow[] {
    return this.sql.exec<PlayerRow>("SELECT * FROM players").toArray();
  }

  private player(id: string): PlayerRow | undefined {
    return this.sql.exec<PlayerRow>("SELECT * FROM players WHERE id = ?", id).toArray()[0];
  }

  private cells(): CellRow[] {
    return this.sql.exec<CellRow>("SELECT * FROM cells ORDER BY idx").toArray();
  }

  /**
   * 인원이 홀수라 팀이 안 맞을 때, 적은 쪽에 얹어 주는 점수.
   *
   * 가상의 한 명이 **양 팀 전체 평균 정답률**로 따라간다고 본다. 전체 정답률이 70% 면
   * 그 팀은 지나간 턴마다 0.7 점씩 쌓는다. 자기 팀 평균을 쓰면 잘하는 팀은 더 유리해지고
   * 못하는 팀은 더 불리해져서, 공평하게 하려던 것이 거꾸로 된다.
   *
   * 표시할 때는 **소수점을 무조건 버린다**(0.7 → 0, 1.2 → 1, 9.6 → 9).
   * 학생이 암산으로 따라올 수 있어야 해서 반올림하지 않는다.
   */
  private handicap(room: RoomRow): { H: number; C: number } {
    const roster = this.players();
    const h = roster.filter((p) => p.team === "H").length;
    const c = roster.length - h;
    if (h === c) return { H: 0, C: 0 };

    const totals = this.sql
      .exec<{ solved: number; correct: number }>(
        "SELECT COALESCE(SUM(solved),0) AS solved, COALESCE(SUM(correct),0) AS correct FROM players",
      )
      .one();
    if (!totals.solved) return { H: 0, C: 0 };

    // 지나간 턴 수 = 그 팀이 실제로 차례를 가진 횟수. 아직 안 온 차례까지 세면 안 된다.
    const turns = room.turn_team ? room.round - (room.turn_team === "H" ? 1 : 0) : 0;
    if (turns <= 0) return { H: 0, C: 0 };

    const rate = totals.correct / totals.solved;
    const short = h < c ? "H" : "C";
    const gained = Math.floor((c - h === 0 ? 0 : Math.abs(h - c)) * turns * rate);
    return short === "H" ? { H: gained, C: 0 } : { H: 0, C: gained };
  }

  private scores(room: RoomRow): Scores {
    // 끝난 판은 다시 계산하지 않는다. 홀수 보정은 그때그때의 인원을 세기 때문에,
    // 게임이 끝난 뒤 누가 들어오거나 나가면 발표된 승패가 뒤집혀 보인다.
    if (room.status === "ended" && room.game_id) {
      const frozen = this.sql
        .exec<{ h_territory: number; h_bonus: number; c_territory: number; c_bonus: number }>(
          "SELECT h_territory, h_bonus, c_territory, c_bonus FROM final_scores WHERE game_key = ?",
          room.game_id,
        )
        .toArray()[0];
      if (frozen) {
        return {
          H: { territory: frozen.h_territory, bonus: frozen.h_bonus, total: frozen.h_territory + frozen.h_bonus },
          C: { territory: frozen.c_territory, bonus: frozen.c_bonus, total: frozen.c_territory + frozen.c_bonus },
        };
      }
    }

    const rows = this.sql
      .exec<{ owner: Team; n: number }>(
        "SELECT owner, COUNT(*) AS n FROM cells WHERE owner IS NOT NULL GROUP BY owner",
      )
      .toArray();
    const territory = { H: 0, C: 0 };
    for (const r of rows) territory[r.owner] = r.n;
    const evenUp = this.handicap(room);
    return {
      H: {
        territory: territory.H,
        bonus: room.bonus_h + evenUp.H,
        total: territory.H + room.bonus_h + evenUp.H,
      },
      C: {
        territory: territory.C,
        bonus: room.bonus_c + evenUp.C,
        total: territory.C + room.bonus_c + evenUp.C,
      },
    };
  }

  private log(): LogEntry[] {
    return this.sql
      .exec<{ detail: string }>(
        "SELECT detail FROM events WHERE kind = 'answer' ORDER BY id DESC LIMIT ?",
        LOG_LIMIT,
      )
      .toArray()
      .map((r) => JSON.parse(r.detail) as LogEntry);
  }

  /**
   * 이번 턴에 지금 차례 팀이 한 일을 fx 테이블에 남긴다.
   *
   * `events.at >= room.last_turn_at` 이 곧 "이번 턴"이다. 턴이 시작될 때 last_turn_at 을 새로
   * 찍기 때문이다(advanceTurn 끝의 UPDATE). 그래서 **턴이 넘어가기 직전에** 불러야 한다.
   * 넘어간 뒤에 부르면 그 경계가 이미 지워져 있다.
   *
   * 같은 턴에 두 번 불릴 수 있다 — 라운드 한계에 닿으면 advanceTurn 이 endGame 을 부르고
   * 둘 다 이 함수를 지난다. turnKey 로 막는다.
   */
  private captureFx(): void {
    const room = this.needRoom();
    if (!room.turn_team || !room.last_turn_at) return; // 첫 [시작] 에는 직전 턴이 없다

    const key = turnKey(room.turn_team, room.round);
    const prev = this.sql
      .exec<{ detail: string }>("SELECT detail FROM fx WHERE team = ?", room.turn_team)
      .toArray()[0];
    if (prev && (JSON.parse(prev.detail) as TurnFx).turnKey === key) return; // 이미 떴다

    const done = this.sql
      .exec<{ detail: string }>(
        "SELECT detail FROM events WHERE kind = 'answer' AND at >= ? ORDER BY id",
        room.last_turn_at,
      )
      .toArray()
      .map((r) => JSON.parse(r.detail) as LogEntry)
      // 맞힌 것만 센다. 틀린 것을 교실 TV 에 이름과 함께 띄우지 않는다.
      .filter((e) => e.ok && e.team === room.turn_team);

    const names: Partial<Record<FxKind, string[]>> = {};
    const push = (kind: FxKind, name: string) => {
      const list = (names[kind] ??= []);
      if (!list.includes(name)) list.push(name);
    };

    let normal = 0;
    for (const e of done) {
      // 정본이 실제로 바꾼 것만 말한다.
      // 배포 직전에 채점된 답에는 bonus·stolen 이 없을 수 있으므로 기본값을 정해 둔다.
      if (e.type === "T") push((e.bonus ?? 0) > 0 ? "treasure-bonus" : "treasure-claim", e.name);
      // 공격칸은 이제 점령하는 순간 빼앗지 않고 "고를 권리" 만 준다. 실제로 빼앗은 것은
      // 아래에서 steal 기록을 보고 따로 센다 — 고르는 것이 다음 턴으로 넘어갈 수도 있다.
      else if (e.type === "A") push("attack-claim", e.name);
      else if (e.type === "S") push("storm", e.name);
      else normal++;
    }

    // 이번 턴에 실제로 남의 땅을 가져간 사람. 공격칸을 먹은 턴과 다를 수 있다.
    const robbed = this.sql
      .exec<{ detail: string }>(
        "SELECT detail FROM events WHERE kind = 'steal' AND at >= ? ORDER BY id",
        room.last_turn_at,
      )
      .toArray()
      .map((r) => JSON.parse(r.detail) as { name: string; team: Team });
    for (const e of robbed) if (e.team === room.turn_team) push("attack-steal", e.name);

    const fx: TurnFx = { turnKey: key, round: room.round, normal, names };
    this.sql.exec(
      `INSERT INTO fx (team, detail, at) VALUES (?, ?, ?)
         ON CONFLICT(team) DO UPDATE SET detail = excluded.detail, at = excluded.at`,
      room.turn_team,
      JSON.stringify(fx),
      Date.now(),
    );
  }

  private fxAll(): { H: TurnFx | null; C: TurnFx | null } {
    const out: { H: TurnFx | null; C: TurnFx | null } = { H: null, C: null };
    for (const r of this.sql.exec<{ team: Team; detail: string }>("SELECT team, detail FROM fx").toArray()) {
      out[r.team] = JSON.parse(r.detail) as TurnFx;
    }
    return out;
  }

  private onlineIds(): string[] {
    const out: string[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attach | null;
      if (att?.playerId) out.push(att.playerId);
    }
    return out;
  }

  // ── 쓰기 도우미 ─────────────────────────────────────────────────────────

  /** 정본이 바뀔 때마다 부른다. 화면은 이 번호로 놓친 것을 알아챈다. */
  private bump(): number {
    const row = this.sql
      .exec<{ rev: number }>(
        "UPDATE room SET rev = rev + 1, last_active_at = ? WHERE id = 1 RETURNING rev",
        Date.now(),
      )
      .one();
    return row.rev;
  }

  private touch(): void {
    this.sql.exec("UPDATE room SET last_active_at = ? WHERE id = 1", Date.now());
  }

  private addEvent(kind: string, playerId: string | null, cell: number | null, detail: unknown): void {
    this.sql.exec(
      "INSERT INTO events (at, kind, player_id, cell, detail) VALUES (?, ?, ?, ?, ?)",
      Date.now(), kind, playerId, cell, JSON.stringify(detail),
    );
  }

  // ── 메시지 만들기 ───────────────────────────────────────────────────────

  private publicCells(room: RoomRow, forTeacher: boolean): PublicCell[] {
    return this.cells().map((c) => ({
      // 임자 없는 칸의 종류를 학생에게 미리 보여 주면 보물칸만 노린다.
      t: forTeacher || c.owner ? c.type : "?",
      o: c.owner,
    }));
  }

  private publicPlayers(): PublicPlayer[] {
    return this.players().map((p) => ({ id: p.id, name: p.name, team: p.team, pos: p.pos }));
  }

  private lockMap(): Record<number, string> {
    const out: Record<number, string> = {};
    for (const c of this.cells()) if (c.locked_by) out[c.idx] = c.locked_by;
    return out;
  }

  private stateMessage(forTeacher: boolean, me: PlayerRow | null): unknown {
    const room = this.needRoom();
    return {
      t: "state",
      stateRev: room.rev,
      serverNow: Date.now(),
      code: room.code,
      label: room.label,
      quizTitle: room.quiz_title,
      status: room.status,
      rows: room.rows,
      cols: room.cols,
      round: room.round,
      roundLimit: room.round_limit,
      turnTeam: room.turn_team,
      turnEndsAt: room.turn_ends_at,
      turnSeconds: room.turn_seconds,
      board: this.publicCells(room, forTeacher),
      players: this.publicPlayers(),
      cellLocks: this.lockMap(),
      scores: this.scores(room),
      presence: this.onlineIds(),
      log: this.log(),
      myPlayer: me
        ? {
            id: me.id,
            name: me.name,
            team: me.team,
            pos: me.pos,
            solved: me.solved,
            correct: me.correct,
            playedThisTurn: me.last_played_turn_key === turnKey(room.turn_team, room.round),
            // 공격권은 서버가 들고 있다. 새로고침하거나 끊겼다 붙어도 이어서 고를 수 있어야 한다.
            hasSteal: this.hasSteal(me.id),
          }
        : null,
      iAmSkipping: me ? me.skip_turn_key === turnKey(room.turn_team, room.round) : false,
      iAmTrapped: me ? this.isTrapped(me.id, turnKey(room.turn_team, room.round)) : false,
      myLastResult: me?.last_action_result ? JSON.parse(me.last_action_result) : null,
      maxPlayers: maxPlayers(room.rows, room.cols, room.round_limit),
      turnFx: this.fxAll(),
    };
  }

  /** 바뀐 것만. 채점 한 번에 200바이트 안팎이라 40명에게 뿌려도 가볍다. */
  private patchMessage(changedCells: number[], changedPlayers: string[]): unknown {
    const room = this.needRoom();
    const cellSet = new Set(changedCells);
    const playerSet = new Set(changedPlayers);
    return {
      t: "patch",
      stateRev: room.rev,
      serverNow: Date.now(),
      status: room.status,
      cells: this.cells()
        .filter((c) => cellSet.has(c.idx))
        .map((c) => ({ idx: c.idx, o: c.owner, t: c.owner ? c.type : "?" })),
      players: this.publicPlayers().filter((p) => playerSet.has(p.id)),
      cellLocks: this.lockMap(),
      scores: this.scores(room),
      log: this.log(),
    };
  }

  private turnMessage(): unknown {
    const room = this.needRoom();
    return {
      t: "turn",
      stateRev: room.rev,
      serverNow: Date.now(),
      status: room.status,
      round: room.round,
      turnTeam: room.turn_team,
      turnEndsAt: room.turn_ends_at,
      players: this.publicPlayers(),
      cellLocks: this.lockMap(),
      // 학생에게도 그냥 간다. 이 메시지는 한 번 만들어 전원에게 뿌리는 구조라 선생님만 골라
      // 보내려면 소켓마다 따로 만들어야 하는데, 실을 것은 이름 몇 개와 숫자뿐이고
      // 학생 화면은 이 값을 아예 안 읽는다. 연출 하나 때문에 방송 경로를 복잡하게 만들지 않는다.
      turnFx: this.fxAll(),
    };
  }

  private broadcast(payload: unknown): void {
    const text = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      // 끊어진 소켓 하나가 나머지 전원의 방송을 막으면 안 된다.
      try {
        ws.send(text);
      } catch {
        /* 이 소켓은 이미 죽었다 */
      }
    }
  }

  // ── 배치용 보기 ─────────────────────────────────────────────────────────

  private placementView(room: RoomRow): PlacementView {
    return {
      rows: room.rows,
      cols: room.cols,
      owners: this.cells().map((c) => c.owner),
      players: this.players().map<PlacementPlayer>((p) => ({ id: p.id, team: p.team, pos: p.pos })),
    };
  }

  /** 배치 함수가 고친 결과를 SQL 에 되돌린다. 바뀐 칸·학생을 알려 준다. */
  private applyPlacement(view: PlacementView, before: PlacementView): { cells: number[]; players: string[] } {
    const cells: number[] = [];
    const players: string[] = [];
    for (let i = 0; i < view.owners.length; i++) {
      if (view.owners[i] !== before.owners[i]) {
        this.sql.exec("UPDATE cells SET owner = ? WHERE idx = ?", view.owners[i], i);
        cells.push(i);
      }
    }
    const posBefore = new Map(before.players.map((p) => [p.id, p.pos]));
    for (const p of view.players) {
      if (posBefore.get(p.id) !== p.pos) {
        this.sql.exec("UPDATE players SET pos = ? WHERE id = ?", p.pos, p.id);
        players.push(p.id);
      }
    }
    return { cells, players };
  }

  private snapshotView(view: PlacementView): PlacementView {
    return {
      rows: view.rows,
      cols: view.cols,
      owners: [...view.owners],
      players: view.players.map((p) => ({ ...p })),
    };
  }

  // ── 초기화 · 요약 (Worker 가 RPC 로 부른다) ─────────────────────────────

  async init(arg: InitArg): Promise<void> {
    this.ensureSchema();

    const existing = this.room();
    if (existing) {
      if (existing.provision_id === arg.provisionId) return; // 같은 요청의 재시도
      throw new Error("이 방번호는 이미 쓰이고 있습니다.");
    }

    // D1 읽기를 완전히 끝낸 다음 DO SQLite 쓰기를 한 덩어리로 한다.
    // 중간에 await 를 끼우면 다른 요청이 끼어들어 원자성이 깨진다.
    const set = await loadQuizSet(this.env, arg.quizSetId, arg.teacherId);
    if (!set) throw new Error("퀴즈를 찾을 수 없습니다.");
    if (!set.items.length) throw new Error("이 퀴즈에는 문항이 없습니다.");

    const now = Date.now();
    this.sql.exec(
      `INSERT INTO room (id, code, teacher_id, label, quiz_set_id, quiz_title, status,
                         rows, cols, round_limit, turn_seconds, cnt_t, cnt_s, cnt_a,
                         provision_id, created_at, last_active_at)
       VALUES (1, ?, ?, ?, ?, ?, 'waiting', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      arg.code, arg.teacherId, arg.label, arg.quizSetId, set.title,
      arg.rows, arg.cols, arg.roundLimit, arg.turnSeconds, arg.cntT, arg.cntS, arg.cntA,
      arg.provisionId, now, now,
    );
    this.writeQuizzes(set.items);
    await this.reschedule();
  }

  private writeQuizzes(items: { q: string; options: string[]; ans: number }[]): void {
    this.sql.exec("DELETE FROM quizzes");
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      this.sql.exec(
        "INSERT INTO quizzes (idx, q, options, ans) VALUES (?, ?, ?, ?)",
        i, item.q, JSON.stringify(item.options), item.ans,
      );
    }
  }

  summary(): RoomSummary {
    const row = this.room();
    if (!row) return { ready: false, code: "", label: null, quizTitle: null, status: "none", playerCount: 0 };
    const n = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM players").one().n;
    return { ready: true, code: row.code, label: row.label, quizTitle: row.quiz_title, status: row.status, playerCount: n };
  }

  quizCount(): number {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM quizzes").one().n;
  }

  /** 시스템 점검이 방마다 물어보는 것. 수업 중 문제가 되는 것만 본다. */
  diagnose(): {
    ready: boolean; code: string; label: string | null; quizTitle: string | null;
    status: string; quizCount: number; cellCount: number;
    players: number; placed: number; online: number; duplicates: number; stuck: string[];
    turnEndsIn: number | null;
  } {
    const room = this.room();
    if (!room) {
      return { ready: false, code: "", label: null, quizTitle: null, status: "none", quizCount: 0,
        cellCount: 0, players: 0, placed: 0, online: 0, duplicates: 0, stuck: [], turnEndsIn: null };
    }
    const cells = this.cells();
    const roster = this.players();
    const placed = roster.filter((p) => p.pos !== null);
    const seen = new Set<number>();
    let duplicates = 0;
    for (const p of placed) {
      if (seen.has(p.pos!)) duplicates++;
      seen.add(p.pos!);
    }
    // 둘레가 전부 아군이라 도전할 칸이 없는 학생 — 이게 있으면 그 학생은 아무것도 못 한다
    const owners = cells.map((c) => c.owner);
    const stuck = placed
      .filter((p) => !neighbors8(p.pos!, room.rows, room.cols).some((n) => owners[n] !== p.team))
      .map((p) => p.name);

    return {
      ready: true, code: room.code, label: room.label, quizTitle: room.quiz_title,
      status: room.status, quizCount: this.quizCount(), cellCount: cells.length,
      players: roster.length, placed: placed.length, online: this.onlineIds().length,
      duplicates, stuck,
      turnEndsIn: room.turn_ends_at ? room.turn_ends_at - Date.now() : null,
    };
  }

  /**
   * 선생님이 방을 닫는다. 학생들에게 먼저 알리고 나서 지운다.
   * 알리지 않고 지우면 학생 화면은 "연결이 끊겼다"로 보고 계속 다시 붙으려 한다.
   */
  async closeNow(): Promise<void> {
    this.broadcast({ t: "closed", msg: "선생님이 방을 닫았어요.", serverNow: Date.now() });
    await this.closeRoom();
  }

  // ── 턴 타이머 · 방 정리 ─────────────────────────────────────────────────

  /**
   * 알람은 DO 당 하나뿐이고 setAlarm() 은 기존 것을 교체한다.
   * 그래서 "지금 다음에 할 일"을 매번 계산해 하나로 건다.
   * 게임 중이면 턴 마감, 아니면 3시간 뒤 방 정리.
   */
  private nextDeadline(): number {
    const room = this.room();
    if (!room) return Date.now() + IDLE_MS;
    return room.status === "running" && room.turn_ends_at
      ? room.turn_ends_at
      : room.last_active_at + IDLE_MS;
  }

  private async reschedule(): Promise<void> {
    await this.ctx.storage.setAlarm(this.nextDeadline());
  }

  async alarm(): Promise<void> {
    const room = this.room();
    if (!room) return;

    const due = this.nextDeadline();
    if (Date.now() < due - 500) {
      // 이르게 깨어났다. 알람이 재시도로 두 번 도는 경우를 여기서 막는다.
      await this.ctx.storage.setAlarm(due);
      return;
    }

    if (room.status === "running") {
      // 알람은 절대 예외로 끝내지 않는다. 여기서 던지면 런타임이 재시도만 반복하고
      // 다음 알람이 안 걸려서 그 방의 시계가 통째로 멈춘다.
      try {
        const out = this.advanceTurn();
        if (out.ended) this.broadcastState();
        else this.broadcast(this.turnMessage());
      } catch (err) {
        this.addEvent("error", null, null, { where: "alarm", msg: String(err) });
      }
      await this.reschedule();
      return;
    }
    await this.closeRoom();
  }

  private async closeRoom(): Promise<void> {
    const room = this.room();
    if (!room) {
      // 방 정보가 없는데 여기까지 왔다 = 없는 방번호를 누가 건드려 빈 DO 가 깨어난 것이다.
      // 생성자가 만들어 둔 빈 표까지 지워서 껍데기를 남기지 않는다.
      await this.ctx.storage.deleteAll();
      return;
    }
    this.sql.exec("UPDATE room SET status = 'closing' WHERE id = 1");
    try {
      await this.env.DB.prepare(
        "UPDATE rooms SET status = 'closed', closed_at = ? WHERE code = ? AND status != 'closed'",
      )
        .bind(Date.now(), room.code)
        .run();
    } catch {
      // D1 이 잠시 안 되면 지우지 않고 나중에 다시 시도한다. 기록을 잃는 것보다 낫다.
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
      return;
    }
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, "방이 닫혔습니다.");
      } catch {
        /* 이미 닫힌 소켓 */
      }
    }
    await this.ctx.storage.deleteAll();
  }

  // ── 게임 진행 ───────────────────────────────────────────────────────────

  private clearAttempts(): void {
    this.sql.exec("UPDATE cells SET locked_by = NULL, locked_until = NULL WHERE locked_by IS NOT NULL");
    this.sql.exec("UPDATE players SET attempt_cell = NULL, attempt_started_at = NULL");
  }

  private advanceTurn(): { ended: boolean } {
    const room = this.needRoom();
    if (!this.cells().length) throw new Refused(E.notRunning, "새 게임을 먼저 눌러 주세요.");
    if (room.status === "ended") throw new Refused(E.notRunning, "이미 끝난 게임입니다.");
    // 연타 방지는 여기가 아니라 [다음 턴] 명령에만 건다.
    // 타이머가 시간이 다 돼서 넘기는 것은 연타가 아니다. 여기서 막으면 알람이 예외로 죽고,
    // 죽은 알람은 런타임이 계속 재시도해서 턴이 영영 안 넘어간다.

    this.captureFx(); // last_turn_at 이 덮어써지기 전에 이번 턴을 갈무리한다
    this.clearAttempts();
    const next = nextTurn(room.turn_team, room.round);
    if (next.round > room.round_limit) {
      this.broadcast(this.endGame());
      return { ended: true };
    }

    const key = turnKey(next.turnTeam, next.round);
    for (const p of this.players()) {
      if (p.team !== next.turnTeam) continue;
      if (p.skip_turns > 0) {
        this.sql.exec("UPDATE players SET skip_turns = skip_turns - 1, skip_turn_key = ? WHERE id = ?", key, p.id);
      } else if (p.skip_turn_key !== key) {
        this.sql.exec("UPDATE players SET skip_turn_key = NULL WHERE id = ?", p.id);
      }
    }

    const view = this.placementView({ ...room, turn_team: next.turnTeam, round: next.round });
    const before = this.snapshotView(view);

    // 갇히면 한 턴 쉰다(2026-09-01). 예전에는 곧바로 빈자리로 옮겨 줬지만, 이제는
    // 갇힌 그 자리에서 한 턴을 쉬고 그다음 턴에 꺼내 준다. 상대를 가두는 것이 하나의 수가 된다.
    //
    // 직전 차례에 이미 쉰 사람은 또 가두지 않는다. 안 그러면 둘러싸인 채로 영영 쉰다.
    const prevKey = turnKey(next.turnTeam, next.round - 1);
    const rested = new Set(
      this.sql
        .exec<{ player_id: string }>("SELECT player_id FROM traps WHERE turn_key = ?", prevKey)
        .toArray()
        .map((r) => r.player_id),
    );
    // 이 팀 사람의 지난 기록만 지운다. 상대 팀 것은 그 팀 차례에 쓰인다.
    for (const p of this.players()) {
      if (p.team === next.turnTeam) this.sql.exec("DELETE FROM traps WHERE player_id = ?", p.id);
    }
    const nowTrapped = trappedPlayers(view, next.turnTeam).filter((id) => !rested.has(id));
    for (const id of nowTrapped) {
      this.sql.exec("INSERT OR REPLACE INTO traps (player_id, turn_key) VALUES (?, ?)", id, key);
    }

    rescueTrapped(view, next.turnTeam, new Set(nowTrapped));
    this.applyPlacement(view, before);

    this.sql.exec(
      `UPDATE room SET status = 'running', turn_team = ?, round = ?, turn_ends_at = ?, last_turn_at = ? WHERE id = 1`,
      next.turnTeam, next.round, Date.now() + room.turn_seconds * 1000, Date.now(),
    );
    this.bump();
    return { ended: false };
  }

  /**
   * 이 판이 잘 돌았는지 훑는다. 관제 화면의 "오류 여부" 가 여기서 나온다.
   *
   * 이름은 한 글자도 담지 않는다 — 몇 명인지만 센다.
   * 누가 멈췄는지는 수업 중에 watch.mjs 가 실시간으로 알려 주는 몫이고,
   * 여기 남는 것은 나중에 "그날 뭔가 이상했나" 를 되짚기 위한 표시다.
   */
  private gameIssues(room: RoomRow, roster: PlayerRow[]): GameIssue[] {
    const issues: GameIssue[] = [];

    const errors = this.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE kind = 'error'")
      .toArray()[0]?.n ?? 0;
    if (errors) {
      issues.push({ kind: "server-error", level: "error", detail: `서버 오류 ${errors}건이 기록되었습니다.` });
    }

    if (room.round < room.round_limit) {
      issues.push({
        kind: "short",
        level: "warn",
        detail: `${room.round_limit}라운드로 정했는데 ${room.round}라운드에서 끝났습니다.`,
      });
    }

    if (!roster.length) {
      issues.push({ kind: "empty", level: "warn", detail: "학생이 한 명도 없이 끝났습니다." });
      return issues;
    }

    const silent = roster.filter((p) => p.solved === 0).length;
    if (silent) {
      issues.push({ kind: "no-answer", level: "warn", detail: `한 번도 답을 내지 않은 학생 ${silent}명.` });
    }

    // 처음엔 풀다가 도중에 조용해진 학생. 마지막으로 푼 라운드가 끝보다 세 라운드 이상 앞서면
    // 화면이 멈췄거나 손을 놓은 것이다. 수업 중 watch.mjs 가 ⛔ 로 잡던 것을 기록에도 남긴다.
    const stalled = roster.filter((p) => {
      if (p.solved === 0) return false; // 위에서 이미 셌다
      const round = Number(String(p.last_played_turn_key ?? "").split(":")[1] ?? 0);
      return round > 0 && room.round - round >= 3;
    }).length;
    if (stalled) {
      issues.push({ kind: "stalled", level: "warn", detail: `중간에 멈춘 것으로 보이는 학생 ${stalled}명.` });
    }

    // 접속 여부는 WebSocket 이 붙어 있는지로만 알 수 있다. 그런데 소켓이 막힌 교실에서는
    // 화면이 폴링으로 떨어지고, 그때는 멀쩡히 수업 중인 학생도 '끊김'으로 보인다.
    // 한 명도 안 붙어 있으면 '전원 폴백'인지 '전원 퇴장'인지 가릴 수 없으므로 아무 말도 하지 않는다.
    // 못 가리는 것을 단정해 적으면, 나중에 이 기록을 믿고 엉뚱한 데를 파게 된다.
    const online = new Set(this.onlineIds());
    if (online.size) {
      const offline = roster.filter((p) => !online.has(p.id)).length;
      if (offline) {
        issues.push({ kind: "offline", level: "warn", detail: `끝날 때 접속이 끊겨 있던 학생 ${offline}명.` });
      }
    }

    return issues;
  }

  /**
   * 끝난 판을 D1 에 한 줄로 남긴다. 학생 이름은 넣지 않는다(2026-08-09 결정).
   *
   * 기록에 실패해도 게임은 이미 끝났다. 여기서 예외가 새어 나가면 결과 화면이 안 뜨므로
   * 삼키고 사건으로만 남긴다 — 수업을 망치는 것보다 기록 한 줄을 잃는 편이 낫다.
   */
  private recordGame(room: RoomRow, scores: Scores, winner: string, roster: PlayerRow[]): void {
    const gameKey = room.game_id;
    if (!gameKey) return; // [새 게임]을 누른 적이 없는 판. 남길 것이 없다.

    const startedAt = Number.parseInt(gameKey.slice(2), 36) || room.created_at;
    const issues = this.gameIssues(room, roster);
    const solved = roster.reduce((n, p) => n + p.solved, 0);
    const correct = roster.reduce((n, p) => n + p.correct, 0);

    this.ctx.waitUntil(
      this.env.DB.prepare(
        `INSERT OR IGNORE INTO game_records
           (room_code, game_key, teacher_id, label, quiz_title, started_at, ended_at,
            rounds, round_limit, h_total, c_total, winner, player_count, solved, correct, issues_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          room.code, gameKey, room.teacher_id, room.label, room.quiz_title, startedAt, Date.now(),
          room.round, room.round_limit, scores.H.total, scores.C.total, winner,
          roster.length, solved, correct, JSON.stringify(issues),
        )
        .run()
        .then(() => undefined)
        .catch((err: unknown) => {
          this.addEvent("error", null, null, { where: "recordGame", msg: String(err) });
        }),
    );
  }

  /** 게임을 끝내고 결과를 만든다. 학생별 결과는 그 자리에서 보여 주고, 서버에는 집계만 남는다. */
  private endGame(): unknown {
    const room = this.needRoom();
    const scores = this.scores(room);
    const winner = winnerOf(scores.H.total, scores.C.total);
    const roster = this.players();

    // 명단을 비우기 전에 남긴다. 아래 UPDATE 가 last_played_turn_key 를 지우면
    // "중간에 멈춘 학생" 을 셀 수 없게 된다.
    this.recordGame(room, scores, winner, roster);

    // 발표한 점수를 그대로 얼려 둔다. 아래에서 status 가 'ended' 가 되는 순간부터
    // scores() 는 이 값을 읽는다 — 뒤늦게 들어온 사람이 결과를 흔들지 못한다.
    if (room.game_id) {
      this.sql.exec(
        `INSERT OR REPLACE INTO final_scores
           (game_key, h_territory, h_bonus, c_territory, c_bonus) VALUES (?, ?, ?, ?, ?)`,
        room.game_id, scores.H.territory, scores.H.bonus, scores.C.territory, scores.C.bonus,
      );
    }

    // [종료] 버튼은 advanceTurn 을 안 거친다. 여기서 갈무리하지 않으면 마지막 턴에 터진
    // 보물이 화면에서 사라진 채로 게임이 끝난다. (자동 종료 경로에서 두 번 불려도 안전하다)
    this.captureFx();
    this.clearAttempts();
    this.sql.exec("UPDATE room SET status = 'ended', turn_ends_at = NULL WHERE id = 1");
    // 명단은 지우지 않는다. 예전에는 여기서 비웠는데, 그러면 게임이 끝나는 순간
    // 전원이 '다시 입장해 주세요'로 튕겨 이름을 다시 쳐야 했다(2026-08-05 시연).
    this.sql.exec(
      "UPDATE players SET pos = NULL, skip_turns = 0, skip_turn_key = NULL, last_played_turn_key = NULL",
    );
    this.sql.exec("DELETE FROM traps"); // 끝난 판의 갇힘 표시를 다음 판까지 끌고 가지 않는다
    this.bump();

    return {
      t: "gameover",
      serverNow: Date.now(),
      winner,
      scores,
      rounds: room.round,
      quizTitle: room.quiz_title,
      label: room.label,
      players: roster
        .map((p) => ({ name: p.name, team: p.team, solved: p.solved, correct: p.correct }))
        .sort((a, b) => b.correct - a.correct || b.solved - a.solved),
    };
  }

  private newGame(clearPlayers: boolean): void {
    const room = this.needRoom();
    if (clearPlayers) this.sql.exec("DELETE FROM players");

    const quizCount = this.quizCount();
    if (!quizCount) throw new Refused(E.noQuiz, "이 방에는 문항이 없습니다.");

    const roster = this.players();
    const 정원 = maxPlayers(room.rows, room.cols, room.round_limit);
    if (roster.length > 정원) {
      // 그냥 "많습니다" 라고만 하면 선생님이 판을 얼마나 키워야 하는지 알 수 없다.
      const 필요 = minSideFor(roster.length, room.round_limit);
      throw new Refused(
        E.roomFull,
        `${roster.length}명은 ${room.rows}×${room.cols} 판에 많습니다(정원 ${정원}명). ` +
          `${필요}×${필요} 이상으로 새 방을 만들어 주세요.`,
      );
    }

    const board = buildBoard(
      { rows: room.rows, cols: room.cols, cntT: room.cnt_t, cntS: room.cnt_s, cntA: room.cnt_a },
      quizCount,
    );
    this.sql.exec("DELETE FROM cells");
    for (let i = 0; i < board.length; i++) {
      this.sql.exec("INSERT INTO cells (idx, type, quiz_idx) VALUES (?, ?, ?)", i, board[i]!.type, board[i]!.quizIdx);
    }
    this.sql.exec(
      `UPDATE players SET pos = NULL, skip_turns = 0, skip_turn_key = NULL, last_played_turn_key = NULL,
                          attempt_cell = NULL, attempt_started_at = NULL, solved = 0, correct = 0,
                          last_action_id = NULL, last_action_result = NULL`,
    );
    this.sql.exec("DELETE FROM events");
    this.sql.exec("DELETE FROM fx"); // 지난 게임의 3D 결과가 새 판에 남으면 안 된다
    this.sql.exec("DELETE FROM traps"); // 갇힘 표시도 판이 바뀌면 무효다
    // 지난 판에서 안 쓰고 남은 공격권도 여기서 버린다. 새 판 첫 턴에 갑자기 땅을 빼앗기면
    // 아무도 영문을 모른다. (2026-09-01 에 traps 를 넣다가 함께 발견)
    this.sql.exec("DELETE FROM steals");
    this.sql.exec(
      `UPDATE room SET status = 'waiting', game_id = ?, round = 1, turn_team = NULL, turn_ends_at = NULL,
                       bonus_h = 0, bonus_c = 0, last_turn_at = NULL WHERE id = 1`,
      `g_${Date.now().toString(36)}`,
    );

    const view = this.placementView(this.needRoom());
    const before = this.snapshotView(view);
    assignRandomPositions(view);
    // 시작 칸을 팀 색으로 칠하므로, 학생이 빽빽하면 첫 판부터 아군에 둘러싸일 수 있다.
    for (const team of ["H", "C"] as Team[]) rescueTrapped(view, team);
    this.applyPlacement(view, before);
    this.bump();
  }

  // ── 명령 처리 (WebSocket 과 폴백 RPC 가 같은 길을 지난다) ───────────────

  private helloStudent(playerId: string | undefined, rawName: string): PlayerRow {
    const room = this.needRoom();

    if (playerId) {
      const found = this.player(playerId);
      if (found) {
        this.sql.exec("UPDATE players SET last_seen_at = ? WHERE id = ?", Date.now(), found.id);
        return found;
      }
    }

    const name = rawName.trim();
    if (!name || name.length > 10) throw new Refused(E.noPlayer, "이름은 1~10자로 적어 주세요.");

    // 같은 이름이 있고 그 학생이 지금 접속 중이 아니면 그 자리를 이어받는다.
    // 이게 없어서 2026-08-09 수업에 "수경" 이 10번, "수경2", "수경3" 이 따로 생겼다.
    // 화면이 굳어 다시 들어올 때마다 서버가 새 사람을 만들었기 때문이다.
    const online = new Set(this.onlineIds());
    const sameName = this.sql.exec<PlayerRow>("SELECT * FROM players WHERE name = ?", name).toArray()[0];
    if (sameName && !online.has(sameName.id)) {
      this.sql.exec("UPDATE players SET last_seen_at = ? WHERE id = ?", Date.now(), sameName.id);
      return sameName;
    }

    // 접속 중인 동명이인이다. 다른 사람으로 보고 번호를 붙인다.
    let finalName = name;
    for (let n = 2; this.sql.exec("SELECT 1 FROM players WHERE name = ?", finalName).toArray().length; n++) {
      finalName = `${name}${n}`;
    }

    const roster = this.players();
    if (roster.length >= maxPlayers(room.rows, room.cols, room.round_limit)) {
      throw new Refused(E.roomFull, "자리가 가득 찼어요. 선생님께 더 큰 판으로 방을 새로 만들어 달라고 하세요.");
    }

    const h = roster.filter((p) => p.team === "H").length;
    const c = roster.length - h;
    const team: Team = h < c ? "H" : c < h ? "C" : Math.random() < 0.5 ? "H" : "C";
    const id = `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();

    this.sql.exec(
      "INSERT INTO players (id, name, team, joined_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
      id, finalName, team, now, now,
    );

    if (this.cells().length) {
      const view = this.placementView(this.needRoom());
      const before = this.snapshotView(view);
      placeLatePlayer(view, id);
      this.applyPlacement(view, before);
    }
    this.bump();
    this.addEvent("join", id, null, { name: finalName, team });
    return this.player(id)!;
  }

  /** 이 학생이 이번 턴을 "갇힘" 으로 쉬는 중인가. */
  private isTrapped(playerId: string, key: string): boolean {
    return (
      this.sql
        .exec<{ n: number }>(
          "SELECT COUNT(*) AS n FROM traps WHERE player_id = ? AND turn_key = ?",
          playerId, key,
        )
        .one().n > 0
    );
  }

  private requirePlayable(room: RoomRow, me: PlayerRow): void {
    if (room.status !== "running") throw new Refused(E.notRunning, "아직 시작 전이에요. 선생님을 기다려 주세요.");
    if (me.team !== room.turn_team) throw new Refused(E.notMyTurn, "지금은 상대 팀 차례예요.");
    if (me.skip_turn_key === turnKey(room.turn_team, room.round)) {
      throw new Refused(E.skipping, "⛈️ 이번 턴은 폭풍으로 쉽니다.");
    }
    if (this.isTrapped(me.id, turnKey(room.turn_team, room.round))) {
      throw new Refused(E.skipping, "🚧 갇혀서 이번 턴은 쉽니다.");
    }
    // 2초는 넘겨준다. 답을 누르는 순간 턴이 넘어가면 억울하다.
    if (Date.now() > (room.turn_ends_at ?? 0) + 2000) {
      throw new Refused(E.timeUp, "이번 턴 시간이 끝났어요.");
    }
  }

  private doPick(me: PlayerRow, cell: number): ActionResult {
    const room = this.needRoom();
    this.requirePlayable(room, me);
    if (me.pos === null) throw new Refused(E.noPlayer, "아직 말이 놓이지 않았어요.");
    if (!neighbors8(me.pos, room.rows, room.cols).includes(cell)) {
      throw new Refused(E.tooFar, "내 말 둘레의 칸(대각선 포함)만 고를 수 있어요.");
    }

    const target = this.sql.exec<CellRow>("SELECT * FROM cells WHERE idx = ?", cell).toArray()[0];
    if (!target) throw new Refused(E.tooFar, "없는 칸이에요.");

    // 이번 턴에 이미 풀었으면 아무것도 못 한다 — 아군 칸으로 옮기는 것도 안 된다.
    // 옮길 수 있게 두었더니 아이들이 "한 문제 더 풀 수 있다"고 착각했다(2026-08-09 수업).
    if (me.last_played_turn_key === turnKey(room.turn_team, room.round)) {
      throw new Refused(E.alreadyPlayed, "이번 턴 문제는 이미 풀었어요. 다음 턴을 기다려요.");
    }

    // 아군 칸이면 문제 없이 이동만 한다.
    if (target.owner === me.team) {
      this.sql.exec("UPDATE players SET pos = ? WHERE id = ?", cell, me.id);
      this.bump();
      return { reply: { t: "moved", cell }, broadcast: this.patchMessage([], [me.id]) };
    }

    // 2026-08-29 규칙 — 상대가 이미 먹은 땅은 문제를 풀어도 가져올 수 없다.
    // 그 땅을 가져오는 길은 공격칸으로 얻는 빼앗기 한 번뿐이다.
    if (target.owner) {
      throw new Refused(E.tooFar, "상대 팀이 먹은 땅이에요. 임자 없는 칸만 고를 수 있어요.");
    }

    const now = Date.now();
    const taken = this.sql.exec(
      `UPDATE cells SET locked_by = ?, locked_until = ?
        WHERE idx = ? AND (locked_by IS NULL OR locked_by = ? OR locked_until < ?)`,
      me.id, room.turn_ends_at, cell, me.id, now,
    );
    if (!taken.rowsWritten) throw new Refused(E.cellBusy, "이미 다른 친구가 공략 중인 칸이에요.");

    const quiz = this.sql
      .exec<{ q: string; options: string; ans: number }>("SELECT q, options, ans FROM quizzes WHERE idx = ?", target.quiz_idx)
      .toArray()[0];
    if (!quiz) throw new Refused(E.noQuiz, "이 칸의 문제를 찾을 수 없어요.");

    this.sql.exec("UPDATE players SET attempt_cell = ?, attempt_started_at = ? WHERE id = ?", cell, now, me.id);
    this.bump();

    // 채점에 쓸 바로 그 문제를 보낸다. 정답은 넣지 않는다 — 채점하는 곳이 하나여야 어긋나지 않는다.
    return {
      reply: { t: "quiz", cell, q: quiz.q, options: JSON.parse(quiz.options) as string[], serverNow: now },
      broadcast: this.patchMessage([], []),
    };
  }

  /** 상대 팀이 가진 칸 수. 공격권을 줄지 말지 여기서 가린다. */
  private enemyCellCount(team: Team): number {
    const enemy: Team = team === "H" ? "C" : "H";
    const row = this.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM cells WHERE owner = ?", enemy)
      .one();
    return row.n;
  }

  /** 이 학생이 지금 빼앗을 권리를 들고 있는가 */
  private hasSteal(playerId: string): boolean {
    return this.sql.exec("SELECT 1 FROM steals WHERE player_id = ?", playerId).toArray().length > 0;
  }

  /**
   * 공격으로 얻은 권리를 써서 상대 땅 하나를 가져온다.
   *
   * 고를 수 있는 범위는 **판 전체**다. 둘레로 제한하면 근처에 상대 땅이 없을 때
   * 애써 얻은 권리를 못 쓰고 버리게 된다.
   * 권리는 턴이 넘어가도 남는다 — 문제를 푼 그 턴에 고르지 못했다고 사라지면 억울하다.
   */
  private doSteal(me: PlayerRow, cell: number): ActionResult {
    const room = this.needRoom();
    if (room.status !== "running") throw new Refused(E.notRunning, "지금은 고를 수 없어요.");
    if (!this.hasSteal(me.id)) throw new Refused(E.noAttempt, "빼앗을 권리가 없어요.");

    const enemy: Team = me.team === "H" ? "C" : "H";
    const target = this.sql.exec<CellRow>("SELECT * FROM cells WHERE idx = ?", cell).toArray()[0];
    if (!target) throw new Refused(E.tooFar, "없는 칸이에요.");
    if (target.owner !== enemy) throw new Refused(E.tooFar, "상대 팀의 땅만 가져올 수 있어요.");

    this.sql.exec("UPDATE cells SET owner = ?, owned_by = NULL WHERE idx = ?", me.team, cell);
    this.sql.exec("DELETE FROM steals WHERE player_id = ?", me.id);
    this.addEvent("steal", me.id, cell, { at: Date.now(), name: me.name, team: me.team, cell });
    this.bump();

    return {
      reply: { t: "stolen", cell, serverNow: Date.now() },
      broadcast: this.patchMessage([cell], []),
    };
  }

  private doAnswer(me: PlayerRow, cell: number, choice: number): ActionResult {
    const room = this.needRoom();
    this.requirePlayable(room, me);
    if (me.attempt_cell !== cell) throw new Refused(E.noAttempt, "문제 정보가 없어요.");

    const target = this.sql.exec<CellRow>("SELECT * FROM cells WHERE idx = ?", cell).toArray()[0];
    if (!target || target.locked_by !== me.id) throw new Refused(E.noAttempt, "내가 잠근 칸이 아니에요.");

    const quiz = this.sql
      .exec<{ q: string; options: string; ans: number }>("SELECT q, options, ans FROM quizzes WHERE idx = ?", target.quiz_idx)
      .toArray()[0];
    if (!quiz) throw new Refused(E.noQuiz, "문제 사본이 손상되었습니다.");

    const options = JSON.parse(quiz.options) as string[];
    const correct = choice === quiz.ans;
    const changedCells: number[] = [cell];
    let bonus = 0;
    const stolen: number | null = null; // 즉시 빼앗기는 없어졌다. 자리는 화면 호환을 위해 남긴다
    let stealGranted = false;

    if (correct) {
      this.sql.exec("UPDATE cells SET owner = ?, owned_by = ? WHERE idx = ?", me.team, me.id, cell);

      // 보물·공격은 처음 점령할 때 한 번만 발동한다. bonus_taken > 0 이면 이미 소진된 칸이다.
      // 폭풍은 점령할 때마다 발동하므로 별도 플래그 없이 항상 건다.
      if (target.type === "T" && !target.bonus_taken) {
        bonus = 2;
        this.sql.exec("UPDATE cells SET bonus_taken = 1 WHERE idx = ?", cell);
        this.sql.exec(
          me.team === "H" ? "UPDATE room SET bonus_h = bonus_h + ? WHERE id = 1" : "UPDATE room SET bonus_c = bonus_c + ? WHERE id = 1",
          bonus,
        );
      }
      this.sql.exec("UPDATE players SET pos = ? WHERE id = ?", cell, me.id);
      if (target.type === "S") this.sql.exec("UPDATE players SET skip_turns = 1 WHERE id = ?", me.id);
      if (target.type === "A" && !target.bonus_taken) {
        // 첫 점령 때만 공격 효과 발동. 이후 재점령은 일반 땅처럼 취급한다.
        this.sql.exec("UPDATE cells SET bonus_taken = 1 WHERE idx = ?", cell);
        // 예전에는 서버가 아무 칸이나 골라 즉시 빼앗았다. 이제는 학생이 판을 보고 직접 고른다.
        // 빼앗을 상대 땅이 하나도 없으면 권리를 주지 않는다 — 고를 게 없는 손가락은 답답하기만 하다.
        if (this.enemyCellCount(me.team) > 0) {
          this.sql.exec("INSERT OR REPLACE INTO steals (player_id, granted_at) VALUES (?, ?)", me.id, Date.now());
          stealGranted = true;
        }
      }
    }

    const gain = correct ? 1 + bonus : 0;
    this.sql.exec("UPDATE cells SET tried = tried + 1, locked_by = NULL, locked_until = NULL WHERE idx = ?", cell);
    this.sql.exec(
      `UPDATE players SET solved = solved + 1, correct = correct + ?, last_played_turn_key = ?,
                          attempt_cell = NULL, attempt_started_at = NULL WHERE id = ?`,
      correct ? 1 : 0, turnKey(room.turn_team, room.round), me.id,
    );
    this.addEvent("answer", me.id, cell, {
      at: Date.now(), name: me.name, team: me.team, cell, ok: correct, gain, type: target.type,
      // bonus·stolen 을 함께 남긴다. 이게 없으면 턴 요약이 "보물 +2"·"땅을 빼앗았다"를
      // 실제로 그런 일이 없었을 때도 말하게 된다. gain 에서 보너스는 역산되지만 stolen 은 안 된다.
      bonus, stolen,
    } satisfies LogEntry);
    this.bump();

    const reply = {
      t: "result",
      correct,
      answerIdx: quiz.ans,
      answerText: options[quiz.ans],
      gain,
      bonus,
      bonusSkipped: correct && target.type === "T" && bonus === 0,
      cellType: target.type,
      stolen,
      // 참이면 화면이 "어디를 가져올까?" 손가락 고르기로 넘어간다
      stealGranted,
      myPos: correct ? cell : me.pos,
      // 화면이 이 값을 받아야 칸이 다시 켜지지 않는다. patch 에는 "내" 정보가 없다.
      playedThisTurn: true,
      skipNextTurn: target.type === "S" && correct,
      serverNow: Date.now(),
    };
    return { reply, broadcast: this.patchMessage(changedCells, [me.id]) };
  }

  /** 선생님이 칸 하나를 눌러 문제와 정답을 확인한다. 상태는 건드리지 않는다. */
  private peekCell(cell: number): unknown {
    const room = this.needRoom();
    const target = this.sql.exec<CellRow>("SELECT * FROM cells WHERE idx = ?", cell).toArray()[0];
    if (!target) throw new Refused(E.tooFar, "없는 칸입니다.");
    const quiz = this.sql
      .exec<{ q: string; options: string; ans: number }>("SELECT q, options, ans FROM quizzes WHERE idx = ?", target.quiz_idx)
      .toArray()[0];
    if (!quiz) throw new Refused(E.noQuiz, "이 칸의 문제를 찾을 수 없습니다.");

    const owner = this.players().find((p) => p.id === target.owned_by);
    return {
      t: "peek",
      cell,
      label: cellLabel(cell, room.cols),
      type: target.type,
      owner: target.owner,
      ownerName: owner?.name ?? null,
      tried: target.tried,
      lockedBy: target.locked_by ? (this.player(target.locked_by)?.name ?? null) : null,
      q: quiz.q,
      options: JSON.parse(quiz.options) as string[],
      ans: quiz.ans,
      serverNow: Date.now(),
    };
  }

  private doCancel(me: PlayerRow): ActionResult {
    if (me.attempt_cell !== null) {
      this.sql.exec("UPDATE cells SET locked_by = NULL, locked_until = NULL WHERE idx = ?", me.attempt_cell);
    }
    this.sql.exec("UPDATE players SET attempt_cell = NULL, attempt_started_at = NULL WHERE id = ?", me.id);
    this.bump();
    return { reply: { t: "ok" }, broadcast: this.patchMessage([], []) };
  }

  private doCommand(msg: ClientMessage & { t: "cmd" }): ActionResult {
    switch (msg.cmd) {
      case "newgame": {
        const quizSetId = typeof msg.quizSetId === "number" ? msg.quizSetId : null;
        if (quizSetId !== null) throw new Refused(E.conflict, "퀴즈 교체는 changeQuiz 로 보내 주세요.");
        this.newGame(false);
        return { reply: { t: "ok" }, broadcastState: true };
      }
      case "reset":
        this.newGame(true);
        return { reply: { t: "ok" }, broadcastState: true };
      case "next": {
        const room = this.needRoom();
        if (room.last_turn_at && Date.now() - room.last_turn_at < TURN_DEBOUNCE_MS) {
          throw new Refused(E.conflict, "방금 넘겼습니다. 잠시 후 다시 눌러 주세요.");
        }
        const out = this.advanceTurn();
        return out.ended
          ? { reply: { t: "ok" }, broadcastState: true }
          : { reply: { t: "ok" }, broadcast: this.turnMessage() };
      }
      case "end": {
        const result = this.endGame();
        this.broadcast(result); // 학생 화면에도 결과가 뜬다
        return { reply: result, broadcastState: true };
      }
      case "kick": {
        const id = String(msg.playerId ?? "");
        const found = this.player(id);
        if (!found) throw new Refused(E.noPlayer, "학생을 찾을 수 없습니다.");
        if (found.attempt_cell !== null) {
          this.sql.exec("UPDATE cells SET locked_by = NULL, locked_until = NULL WHERE idx = ?", found.attempt_cell);
        }
        this.sql.exec("DELETE FROM players WHERE id = ?", id);
        this.bump();
        for (const ws of this.ctx.getWebSockets()) {
          const att = ws.deserializeAttachment() as Attach | null;
          if (att?.playerId === id) {
            try {
              ws.close(4001, "선생님이 내보냈습니다.");
            } catch {
              /* 이미 닫힘 */
            }
          }
        }
        return { reply: { t: "ok" }, broadcastState: true };
      }
      default:
        throw new Refused(E.conflict, "모르는 명령입니다.");
    }
  }

  /**
   * 퀴즈 교체는 D1 을 읽어야 해서 따로 둔다.
   * 보드를 다시 만드는 순간이 유일하게 안전한 지점이다 — 게임 도중에 바꾸면
   * 이미 배정된 칸의 문제가 사라진다.
   */
  private async changeQuizAndNewGame(quizSetId: number): Promise<void> {
    const room = this.needRoom();
    const set = await loadQuizSet(this.env, quizSetId, room.teacher_id);
    if (!set) throw new Refused(E.noQuiz, "퀴즈를 찾을 수 없습니다.");
    if (!set.items.length) throw new Refused(E.noQuiz, "이 퀴즈에는 문항이 없습니다.");

    // 여기부터 await 없음. 퀴즈·제목·보드를 한 덩어리로 바꾼다.
    this.writeQuizzes(set.items);
    this.sql.exec("UPDATE room SET quiz_set_id = ?, quiz_title = ? WHERE id = 1", quizSetId, set.title);
    this.newGame(false);
  }

  // ── 멱등 ────────────────────────────────────────────────────────────────

  private rememberStudent(playerId: string, actionId: string, reply: unknown): void {
    this.sql.exec(
      "UPDATE players SET last_action_id = ?, last_action_result = ? WHERE id = ?",
      actionId, JSON.stringify(reply ?? null), playerId,
    );
  }

  private rememberTeacher(actionId: string, reply: unknown): void {
    this.sql.exec(
      "UPDATE room SET last_cmd_id = ?, last_cmd_result = ? WHERE id = 1",
      actionId, JSON.stringify(reply ?? null),
    );
  }

  /**
   * 끊김·재연결·폴백 전환이 일상인 교실에서 재시도는 반드시 일어난다.
   * 같은 actionId 가 다시 오면 상태를 바꾸지 않고 저장해 둔 답을 그대로 돌려준다.
   */
  async handleAction(msg: ClientMessage, actor: Attach): Promise<ActionResult> {
    if (msg.t === "sync") {
      const me = actor.playerId ? (this.player(actor.playerId) ?? null) : null;
      return { reply: this.stateMessage(actor.role === "teacher", me) };
    }

    if (msg.t === "peek") {
      if (actor.role !== "teacher") throw new Refused(E.notOwner, "선생님만 볼 수 있습니다.");
      return { reply: this.peekCell(Number(msg.cell)) };
    }

    if (msg.t === "cmd") {
      if (actor.role !== "teacher") throw new Refused(E.notOwner, "선생님만 쓸 수 있습니다.");
      const room = this.needRoom();
      if (room.last_cmd_id && room.last_cmd_id === msg.actionId) {
        return { reply: JSON.parse(room.last_cmd_result ?? "null") };
      }
      // 퀴즈를 바꾸며 새 게임을 하는 경우만 D1 을 읽는다.
      if (msg.cmd === "newgame" && typeof msg.quizSetId === "number") {
        await this.changeQuizAndNewGame(msg.quizSetId);
        const out: ActionResult = { reply: { t: "ok" }, broadcastState: true };
        this.rememberTeacher(msg.actionId, out.reply);
        this.touch();
        await this.reschedule();
        return out;
      }
      const out = this.doCommand(msg);
      this.rememberTeacher(msg.actionId, out.reply);
      this.touch();
      await this.reschedule();
      return out;
    }

    if (msg.t !== "pick" && msg.t !== "answer" && msg.t !== "cancel" && msg.t !== "steal") {
      throw new Refused(E.conflict, "모르는 요청입니다.");
    }
    if (!actor.playerId) throw new Refused(E.needHello, "먼저 입장해 주세요.");
    const me = this.player(actor.playerId);
    if (!me) throw new Refused(E.noPlayer, "다시 입장해 주세요.");

    if (me.last_action_id && me.last_action_id === msg.actionId) {
      return { reply: JSON.parse(me.last_action_result ?? "null") };
    }

    const out =
      msg.t === "pick"
        ? this.doPick(me, Number(msg.cell))
        : msg.t === "answer"
          ? this.doAnswer(me, Number(msg.cell), Number(msg.choice))
          : msg.t === "steal"
            ? this.doSteal(me, Number(msg.cell))
            : this.doCancel(me);

    // 상태 변경과 응답 기록이 같은 덩어리 안에 있어야 한다. sql.exec 가 동기라 자연히 지켜진다.
    this.rememberStudent(me.id, msg.actionId, out.reply);
    await this.reschedule();
    return out;
  }

  // ── WebSocket ───────────────────────────────────────────────────────────

  async fetch(request: Request): Promise<Response> {
    // 방을 닫을 때 deleteAll() 로 표까지 지운다. 그런데 같은 DO 인스턴스가 메모리에 남아 있으면
    // 생성자가 다시 돌지 않아서, 그 뒤에 오는 요청은 "no such table" 이라는 날 SQL 오류로 죽는다.
    // 학생 화면에는 그게 code:"unknown" 으로 뜬다 — 왜 안 되는지 알 길이 없다.
    // 멱등이고 값싼 호출이라 여기서 한 번 보장한다. 그러면 "그런 방이 없어요" 로 제대로 답한다.
    this.ensureSchema();

    const url = new URL(request.url);
    const teacherAtUpgrade = request.headers.get("x-teacher-id") || null;

    if (url.pathname.endsWith("/ws")) {
      const pair = new WebSocketPair();
      // accept() 가 아니라 acceptWebSocket() 이다. 그래야 방이 조용할 때 DO 가 잠든다.
      this.ctx.acceptWebSocket(pair[1]);
      // Hibernation 중에는 메모리가 통째로 날아간다. 소켓에 붙여 두면 깨어난 뒤에도 남는다.
      pair[1].serializeAttachment({ role: null, teacherAtUpgrade } satisfies Attach);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    // 폴백(폴링)도 WebSocket 과 똑같은 길을 지난다. 규칙이 두 벌이 되면 반드시 어긋난다.
    let body: (ClientMessage & { playerId?: string }) | null = null;
    try {
      body = (await request.json()) as ClientMessage & { playerId?: string };
    } catch {
      return Response.json({ ok: false, error: "JSON 이 아닙니다." }, { status: 400 });
    }
    try {
      // 입장도 폴백으로 할 수 있어야 한다. 학교 방화벽이 WebSocket 을 막으면
      // 이 길밖에 없는데, 여기로 못 들어오면 그 학생은 수업에서 통째로 빠진다.
      if (body.t === "hello") {
        const out = this.helloAny(body, teacherAtUpgrade);
        if (out.broadcast) this.broadcast(out.broadcast);
        return Response.json({ ok: true, reply: out.reply });
      }
      const actor = await this.actorFor(body, teacherAtUpgrade);
      const out = await this.handleAction(body, actor);
      if (out.broadcastState) this.broadcastState();
      else if (out.broadcast) this.broadcast(out.broadcast);
      // 폴백은 방송을 못 받으므로, 바뀐 뒤 상태를 응답에 함께 실어 준다.
      const me = actor.playerId ? (this.player(actor.playerId) ?? null) : null;
      return Response.json({
        ok: true,
        reply: out.reply,
        state: out.broadcastState || out.broadcast ? this.stateMessage(actor.role === "teacher", me) : null,
      });
    } catch (err) {
      return Response.json(this.errorPayload(err), { status: 200 });
    }
  }

  /** 폴백 요청에는 소켓이 없으므로 매번 누구인지 정한다. */
  private async actorFor(body: ClientMessage & { playerId?: string }, teacherAtUpgrade: string | null): Promise<Attach> {
    const room = this.needRoom();
    if (teacherAtUpgrade && teacherAtUpgrade === room.teacher_id) {
      return { role: "teacher", teacherAtUpgrade };
    }
    const playerId = body.playerId;
    if (playerId && this.player(playerId)) return { role: "student", playerId, teacherAtUpgrade: null };
    throw new Refused(E.needHello, "먼저 입장해 주세요.");
  }

  private errorPayload(err: unknown): unknown {
    if (err instanceof Refused) return { t: "error", code: err.code, msg: err.message, serverNow: Date.now() };
    const msg = err instanceof Error ? err.message : "알 수 없는 오류입니다.";
    return { t: "error", code: "unknown", msg, serverNow: Date.now() };
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)) as ClientMessage;
    } catch {
      ws.send(JSON.stringify({ t: "error", code: "bad-json", msg: "잘못된 요청입니다.", serverNow: Date.now() }));
      return;
    }

    const att = (ws.deserializeAttachment() as Attach | null) ?? { role: null, teacherAtUpgrade: null };

    try {
      if (msg.t === "hello") {
        const next = await this.doHello(ws, msg, att);
        ws.send(JSON.stringify(next.reply));
        if (next.broadcast) this.broadcastExcept(ws, next.broadcast);
        return;
      }
      // hello 전에는 아무 명령도 받지 않는다. 소켓 상태가 단순해진다.
      if (!att.role) throw new Refused(E.needHello, "먼저 입장해 주세요.");

      const out = await this.handleAction(msg, att);
      if (out.reply !== undefined) ws.send(JSON.stringify(out.reply));
      if (out.broadcastState) this.broadcastState();
      else if (out.broadcast) this.broadcast(out.broadcast);
    } catch (err) {
      ws.send(JSON.stringify(this.errorPayload(err)));
    }
  }

  /** 전체 상태를 소켓마다 그 사람 기준으로 만들어 보낸다. */
  private broadcastState(): void {
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attach | null;
      const me = att?.playerId ? (this.player(att.playerId) ?? null) : null;
      try {
        ws.send(JSON.stringify(this.stateMessage(att?.role === "teacher", me)));
      } catch {
        /* 죽은 소켓 */
      }
    }
  }

  private broadcastExcept(exclude: WebSocket, payload: unknown): void {
    const text = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      try {
        ws.send(text);
      } catch {
        /* 죽은 소켓 */
      }
    }
  }

  /** 소켓이 있든(WebSocket) 없든(폴백) 같은 입장 규칙을 쓴다. */
  private helloAny(msg: ClientMessage & { t: "hello" }, teacherAtUpgrade: string | null): ActionResult & { me?: PlayerRow } {
    const room = this.needRoom();

    if (msg.role === "teacher") {
      // 쿠키는 업그레이드 때 Worker 가 이미 확인했다. 화면 JS 는 토큰을 만질 필요가 없다.
      if (!teacherAtUpgrade || teacherAtUpgrade !== room.teacher_id) {
        throw new Refused(E.notOwner, "이 방의 선생님이 아닙니다.");
      }
      this.touch();
      return { reply: this.stateMessage(true, null) };
    }

    const me = this.helloStudent(msg.playerId, String(msg.name ?? ""));
    return {
      me,
      reply: this.stateMessage(false, me),
      broadcast: this.patchMessage(me.pos === null ? [] : [me.pos], [me.id]),
    };
  }

  private async doHello(
    ws: WebSocket,
    msg: ClientMessage & { t: "hello" },
    att: Attach,
  ): Promise<ActionResult> {
    const out = this.helloAny(msg, att.teacherAtUpgrade);
    // Hibernation 중에는 메모리가 날아간다. 누구인지는 소켓에 붙여 둬야 살아남는다.
    ws.serializeAttachment(
      out.me
        ? ({ role: "student", playerId: out.me.id, teacherAtUpgrade: null } satisfies Attach)
        : ({ role: "teacher", teacherAtUpgrade: att.teacherAtUpgrade } satisfies Attach),
    );
    await this.reschedule();
    return { reply: out.reply, broadcast: out.broadcast };
  }

  async webSocketClose(): Promise<void> {
    // 누가 나갔는지 나머지 화면에 알린다. 명단에서 지우지는 않는다 — 다시 들어올 수 있다.
    this.broadcast({ t: "presence", online: this.onlineIds(), serverNow: Date.now() });
  }

  async webSocketError(): Promise<void> {
    this.broadcast({ t: "presence", online: this.onlineIds(), serverNow: Date.now() });
  }
}
