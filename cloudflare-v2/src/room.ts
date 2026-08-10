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
  neighbors8,
  nextTurn,
  pickStealTarget,
  placeLatePlayer,
  rescueTrapped,
  cellLabel,
  turnKey,
  winnerOf,
} from "./game";
import {
  ERROR_CODES as E,
  type ClientMessage,
  type FxKind,
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

  private scores(room: RoomRow): Scores {
    const rows = this.sql
      .exec<{ owner: Team; n: number }>(
        "SELECT owner, COUNT(*) AS n FROM cells WHERE owner IS NOT NULL GROUP BY owner",
      )
      .toArray();
    const territory = { H: 0, C: 0 };
    for (const r of rows) territory[r.owner] = r.n;
    return {
      H: { territory: territory.H, bonus: room.bonus_h, total: territory.H + room.bonus_h },
      C: { territory: territory.C, bonus: room.bonus_c, total: territory.C + room.bonus_c },
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
      else if (e.type === "A") push((e.stolen ?? null) !== null ? "attack-steal" : "attack-claim", e.name);
      else if (e.type === "S") push("storm", e.name);
      else normal++;
    }

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
          }
        : null,
      iAmSkipping: me ? me.skip_turn_key === turnKey(room.turn_team, room.round) : false,
      myLastResult: me?.last_action_result ? JSON.parse(me.last_action_result) : null,
      maxPlayers: maxPlayers(room.rows, room.cols),
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
    rescueTrapped(view, next.turnTeam);
    this.applyPlacement(view, before);

    this.sql.exec(
      `UPDATE room SET status = 'running', turn_team = ?, round = ?, turn_ends_at = ?, last_turn_at = ? WHERE id = 1`,
      next.turnTeam, next.round, Date.now() + room.turn_seconds * 1000, Date.now(),
    );
    this.bump();
    return { ended: false };
  }

  /** 게임을 끝내고 결과를 만든다. 결과는 남기지 않고 그 자리에서 보여 준다. */
  private endGame(): unknown {
    const room = this.needRoom();
    const scores = this.scores(room);
    const winner = winnerOf(scores.H.total, scores.C.total);
    const roster = this.players();

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
    if (roster.length > maxPlayers(room.rows, room.cols)) {
      throw new Refused(E.roomFull, `학생이 너무 많습니다. 판을 키워 주세요.`);
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
    if (roster.length >= maxPlayers(room.rows, room.cols)) {
      throw new Refused(E.roomFull, "자리가 가득 찼어요. 선생님께 판을 키워 달라고 하세요.");
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

  private requirePlayable(room: RoomRow, me: PlayerRow): void {
    if (room.status !== "running") throw new Refused(E.notRunning, "아직 시작 전이에요. 선생님을 기다려 주세요.");
    if (me.team !== room.turn_team) throw new Refused(E.notMyTurn, "지금은 상대 팀 차례예요.");
    if (me.skip_turn_key === turnKey(room.turn_team, room.round)) {
      throw new Refused(E.skipping, "⛈️ 이번 턴은 폭풍으로 쉽니다.");
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
    let stolen: number | null = null;

    if (correct) {
      this.sql.exec("UPDATE cells SET owner = ?, owned_by = ? WHERE idx = ?", me.team, me.id, cell);

      const bit = me.team === "H" ? 1 : 2;
      if (target.type === "T" && !(target.bonus_taken & bit)) {
        bonus = 2;
        this.sql.exec("UPDATE cells SET bonus_taken = bonus_taken | ? WHERE idx = ?", bit, cell);
        this.sql.exec(
          me.team === "H" ? "UPDATE room SET bonus_h = bonus_h + ? WHERE id = 1" : "UPDATE room SET bonus_c = bonus_c + ? WHERE id = 1",
          bonus,
        );
      }
      this.sql.exec("UPDATE players SET pos = ? WHERE id = ?", cell, me.id);
      if (target.type === "S") this.sql.exec("UPDATE players SET skip_turns = 1 WHERE id = ?", me.id);
      if (target.type === "A") {
        stolen = pickStealTarget(this.cells().map((c) => c.owner), me.team);
        if (stolen !== null) {
          this.sql.exec("UPDATE cells SET owner = ?, owned_by = NULL WHERE idx = ?", me.team, stolen);
          changedCells.push(stolen);
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

    if (msg.t !== "pick" && msg.t !== "answer" && msg.t !== "cancel") {
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
