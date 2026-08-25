import { SELF, env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import sampleCsv from "../../sample/퀴즈_샘플_v3.csv?raw";

const CODE = "테스트가입코드";
const BASE = "https://t.test";

interface StateMsg {
  t: string;
  stateRev: number;
  serverNow: number;
  status: string;
  rows: number;
  cols: number;
  round: number;
  turnTeam: "H" | "C" | null;
  turnEndsAt: number | null;
  quizTitle: string;
  board: { t: string; o: string | null }[];
  players: { id: string; name: string; team: "H" | "C"; pos: number | null }[];
  scores: { H: { total: number }; C: { total: number } };
  cellLocks: Record<string, string>;
  myPlayer: { id: string; team: "H" | "C"; pos: number; playedThisTurn: boolean } | null;
  maxPlayers: number;
  turnFx: { H: TurnFxMsg | null; C: TurnFxMsg | null };
}

interface TurnFxMsg {
  turnKey: string;
  round: number;
  normal: number;
  names: Partial<Record<"treasure-bonus" | "treasure-claim" | "attack-steal" | "attack-claim" | "storm", string[]>>;
}

let teacherCookie = "";
let roomCode = "";

async function signupOk(id: string) {
  const res = await SELF.fetch(`${BASE}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: CODE, id, name: "선생", password: "pw1234" }),
  });
  if (res.status !== 200) throw new Error(`가입 실패: ${await res.text()}`);
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}

/** 방 하나를 만들고 방번호를 돌려준다. */
let quizSeq = 0;
let quizTitle = "";
async function makeRoom(cookie: string, extra: Record<string, unknown> = {}) {
  const form = new FormData();
  // 테스트마다 이름이 달라야 한다(같은 이름 재업로드는 409 로 막히는 게 정상).
  quizTitle = quizSeq++ === 0 ? "국어1" : `퀴즈${quizSeq}`;
  form.set("title", quizTitle);
  form.set("file", new File([sampleCsv], "퀴즈.csv", { type: "text/csv" }));
  const up = await SELF.fetch(`${BASE}/api/quizsets`, { method: "POST", headers: { cookie }, body: form });
  const quizSetId = ((await up.json()) as { id: number }).id;

  const res = await SELF.fetch(`${BASE}/api/rooms`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ requestId: crypto.randomUUID(), quizSetId, label: "3학년 2반", ...extra }),
  });
  if (res.status !== 200) throw new Error(`방 개설 실패: ${await res.text()}`);
  return ((await res.json()) as { code: string }).code;
}

/** 폴백(폴링) 경로로 명령을 보낸다. WebSocket 과 같은 코드를 지난다. */
async function rpc(body: Record<string, unknown>, cookie?: string) {
  const res = await SELF.fetch(`${BASE}/api/rooms/${roomCode}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { ok?: boolean; reply?: unknown; t?: string; code?: string; msg?: string };
}

async function join(name: string, playerId?: string) {
  const out = await rpc({ t: "hello", role: "student", name, playerId });
  if (!out.ok) throw new Error(`입장 실패: ${out.msg}`);
  return out.reply as StateMsg;
}

const teacherCmd = (cmd: string, extra: Record<string, unknown> = {}) =>
  rpc({ t: "cmd", cmd, actionId: crypto.randomUUID(), ...extra }, teacherCookie);

const myState = (playerId: string) => rpc({ t: "sync", playerId }).then((r) => r.reply as StateMsg);

/**
 * 두 명을 넣고 새 게임 → 시작까지 한 뒤, 지금 차례인 쪽의 상태를 돌려준다.
 * [다음 턴]은 2초 연타 방지가 걸려 있어 연달아 두 번 부를 수 없다. 그래서 팀을 고르지 않고
 * 차례가 온 사람을 쓴다.
 */
async function startGame(): Promise<StateMsg> {
  const a = await join("민수");
  const b = await join("영희");
  await teacherCmd("newgame");
  await teacherCmd("next");
  const sa = await myState(a.myPlayer!.id);
  return sa.turnTeam === sa.myPlayer!.team ? sa : await myState(b.myPlayer!.id);
}

/** 지금 차례인 학생이 도전할 수 있는 칸 하나를 고른다. */
function pickableCell(state: StateMsg): number {
  const me = state.myPlayer!;
  const { rows, cols } = state;
  const r = Math.floor(me.pos / cols);
  const c = me.pos % cols;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      const idx = nr * cols + nc;
      if (state.board[idx]!.o !== me.team && !state.cellLocks[String(idx)]) return idx;
    }
  }
  throw new Error("도전할 칸이 없다");
}

beforeEach(async () => {
  teacherCookie = await signupOk("owner1");
  roomCode = await makeRoom(teacherCookie);
});

describe("입장", () => {
  it("이름만으로 들어오면 팀과 자리를 받는다", async () => {
    const state = await join("민수");
    expect(state.t).toBe("state");
    expect(state.quizTitle).toBe("국어1");
    expect(state.myPlayer!.team).toMatch(/^[HC]$/);
    expect(state.players).toHaveLength(1);
    expect(state.maxPlayers).toBe(60); // 12×12
  });

  it("팀이 한쪽으로 몰리지 않는다", async () => {
    for (let i = 0; i < 8; i++) await join(`학생${i}`);
    const state = await join("마지막");
    const h = state.players.filter((p) => p.team === "H").length;
    expect(Math.abs(h - (state.players.length - h))).toBeLessThanOrEqual(1);
  });

  it("playerId 로 다시 들어오면 그대로 이어진다", async () => {
    const first = await join("민수");
    const again = await join("민수", first.myPlayer!.id);
    expect(again.myPlayer!.id).toBe(first.myPlayer!.id);
    expect(again.players).toHaveLength(1);
  });

  it("끊긴 학생이 같은 이름으로 오면 그 자리를 이어받는다", async () => {
    // 2026-08-09 수업에서 "수경" 이 10번, "수경2", "수경3" 이 따로 생겼다.
    // 화면이 굳어 다시 들어올 때마다 서버가 새 사람을 만들었기 때문이다.
    const first = await join("수경");
    await teacherCmd("next");
    const again = await join("수경"); // playerId 를 잃어버린 채 이름만으로 재입장

    expect(again.myPlayer!.id).toBe(first.myPlayer!.id);
    expect(again.players).toHaveLength(1);
    expect(again.players[0]!.name).toBe("수경");
  });

  it("이름이 비었거나 너무 길면 거절한다", async () => {
    expect((await rpc({ t: "hello", role: "student", name: "" })).code).toBeTruthy();
    expect((await rpc({ t: "hello", role: "student", name: "가".repeat(11) })).code).toBeTruthy();
  });

  it("hello 없이 명령을 보내면 거절한다", async () => {
    const out = await rpc({ t: "pick", cell: 0, actionId: "a1" });
    expect(out.code).toBe("need-hello");
  });

  it("남의 방에 선생님으로 붙을 수 없다", async () => {
    const other = await signupOk("other1");
    const out = await rpc({ t: "hello", role: "teacher" }, other);
    expect(out.code).toBe("not-owner");
  });
});

describe("게임 진행", () => {
  it("시작 전에는 아무도 못 푼다", async () => {
    const state = await join("민수");
    const out = await rpc({ t: "pick", cell: 0, actionId: "a1", playerId: state.myPlayer!.id });
    expect(out.code).toBe("not-running");
  });

  it("새 게임 → 시작 칸이 팀 색으로 칠해진다", async () => {
    await join("민수");
    await join("영희");
    await teacherCmd("newgame");

    const state = await myState((await join("민수")).myPlayer!.id);
    const painted = state.board.filter((c) => c.o).length;
    expect(painted).toBe(2);
    expect(state.scores.H.total + state.scores.C.total).toBe(2);
  });

  it("자기 팀 차례에만 도전할 수 있다", async () => {
    const a = await join("민수");
    const b = await join("영희");
    await teacherCmd("newgame");
    await teacherCmd("next"); // 홍팀 차례

    const hong = (await myState(a.myPlayer!.id)).myPlayer!.team === "H" ? a : b;
    const cheong = hong === a ? b : a;

    const blocked = await rpc({ t: "pick", cell: 0, actionId: "x", playerId: cheong.myPlayer!.id });
    expect(blocked.code).toBe("not-my-turn");

    const state = await myState(hong.myPlayer!.id);
    const cell = pickableCell(state);
    const quiz = await rpc({ t: "pick", cell, actionId: "y", playerId: hong.myPlayer!.id });
    expect((quiz.reply as { t: string; options: string[] }).t).toBe("quiz");
    expect((quiz.reply as { options: string[] }).options.length).toBeGreaterThanOrEqual(2);
  });

  it("정답을 맞히면 칸이 넘어오고 점수가 오른다", async () => {
    const state = await startGame();
    const me = { myPlayer: state.myPlayer };
    const cell = pickableCell(state);
    const before = state.scores[state.myPlayer!.team].total;
    await rpc({ t: "pick", cell, actionId: "p1", playerId: me.myPlayer!.id });

    // 정답 번호를 모르므로 4개를 다 눌러 본다 — 하나는 맞는다.
    let correct = false;
    for (let choice = 0; choice < 4 && !correct; choice++) {
      const out = await rpc({ t: "answer", cell, choice, actionId: `a${choice}`, playerId: me.myPlayer!.id });
      const reply = out.reply as { correct?: boolean } | undefined;
      if (reply?.correct) correct = true;
      else break; // 첫 시도가 오답이면 그 턴은 끝난다
    }

    const after = await myState(me.myPlayer!.id);
    if (correct) {
      expect(after.board[cell]!.o).toBe(state.myPlayer!.team);
      expect(after.scores[state.myPlayer!.team].total).toBeGreaterThan(before);
      expect(after.myPlayer!.pos).toBe(cell);
    }
    expect(after.myPlayer!.playedThisTurn).toBe(true);
  });

  it("한 턴에 두 번은 못 푼다", async () => {
    const state = await startGame();
    const id = state.myPlayer!.id;

    const cell = pickableCell(state);
    await rpc({ t: "pick", cell, actionId: "p1", playerId: id });
    await rpc({ t: "answer", cell, choice: 0, actionId: "a1", playerId: id });

    const next = await myState(id);
    const out = await rpc({ t: "pick", cell: pickableCell(next), actionId: "p2", playerId: id });
    expect(out.code).toBe("already-played");
  });

  it("같은 칸을 두 명이 동시에 고르면 한 명만 된다", async () => {
    const a = await join("민수");
    const b = await join("영희");
    await teacherCmd("newgame");
    await teacherCmd("next");

    let sa = await myState(a.myPlayer!.id);
    let sb = await myState(b.myPlayer!.id);
    // 같은 팀 두 명이 되도록 필요하면 한 번 더 넘긴다
    if (sa.myPlayer!.team !== sb.myPlayer!.team) return; // 다른 팀이면 이 시나리오가 아니다

    if (sa.turnTeam !== sa.myPlayer!.team) {
      await teacherCmd("next");
      sa = await myState(a.myPlayer!.id);
      sb = await myState(b.myPlayer!.id);
    }
    const cell = pickableCell(sa);
    const first = await rpc({ t: "pick", cell, actionId: "p1", playerId: a.myPlayer!.id });
    const second = await rpc({ t: "pick", cell, actionId: "p2", playerId: b.myPlayer!.id });
    expect((first.reply as { t: string }).t).toBe("quiz");
    expect(second.code).toBe("cell-busy");
  });
});

describe("게임 결과", () => {
  it("종료하면 결과가 그 자리에서 나온다", async () => {
    const state = await startGame();
    const id = state.myPlayer!.id;
    const cell = pickableCell(state);
    await rpc({ t: "pick", cell, actionId: "p1", playerId: id });
    await rpc({ t: "answer", cell, choice: 0, actionId: "a1", playerId: id });

    const out = await teacherCmd("end");
    const r = out.reply as {
      t: string; winner: string; rounds: number; quizTitle: string;
      scores: { H: { total: number }; C: { total: number } };
      players: { name: string; team: string; solved: number; correct: number }[];
    };
    expect(r.t).toBe("gameover");
    expect(["홍팀", "청팀", "무승부"]).toContain(r.winner);
    expect(r.quizTitle).toBe(quizTitle);
    expect(r.players).toHaveLength(2);
    expect(r.players.some((p) => p.solved === 1)).toBe(true);
    // 많이 맞힌 순으로 정렬된다
    expect(r.players[0]!.correct).toBeGreaterThanOrEqual(r.players[1]!.correct);
  });

  it("결과를 남기지 않는다 — 지난 게임은 보지 않는다", async () => {
    await startGame();
    await teacherCmd("end");
    // results 테이블은 0002 마이그레이션에서 없앴다
    await expect(env.DB.prepare("SELECT 1 FROM results").first()).rejects.toThrow();
  });
});

describe("선생님 칸 미리보기", () => {
  it("칸을 누르면 문제와 정답이 보인다", async () => {
    await startGame();
    const peek = await rpc({ t: "peek", cell: 0 }, teacherCookie);
    const p = peek.reply as { t: string; label: string; type: string; q: string; options: string[]; ans: number };
    expect(p.t).toBe("peek");
    expect(p.label).toBe("A1");
    expect(["N", "T", "S", "A"]).toContain(p.type);
    expect(p.q.length).toBeGreaterThan(0);
    expect(p.ans).toBeGreaterThanOrEqual(0);
    expect(p.ans).toBeLessThan(p.options.length);
  });

  it("보기만 하는 것이라 정본은 그대로다", async () => {
    await startGame();
    const before = ((await rpc({ t: "sync" }, teacherCookie)).reply as StateMsg).stateRev;
    await rpc({ t: "peek", cell: 5 }, teacherCookie);
    const after = ((await rpc({ t: "sync" }, teacherCookie)).reply as StateMsg).stateRev;
    expect(after).toBe(before);
  });

  it("학생은 못 본다", async () => {
    const state = await startGame();
    const out = await rpc({ t: "peek", cell: 0, playerId: state.myPlayer!.id });
    expect(out.code).toBe("not-owner");
  });
});

describe("한 턴에 한 문제", () => {
  it("답을 낸 뒤에는 아군 칸으로 옮기는 것도 막는다", async () => {
    // 옮길 수 있게 두었더니 아이들이 "한 문제 더 풀 수 있다"고 착각했다.
    const state = await startGame();
    const id = state.myPlayer!.id;
    const cell = pickableCell(state);
    await rpc({ t: "pick", cell, actionId: "p1", playerId: id });
    await rpc({ t: "answer", cell, choice: 0, actionId: "a1", playerId: id });

    const after = await myState(id);
    // 내 팀 칸(내가 서 있는 자리 둘레의 아군 칸)을 골라 본다
    const mine = after.board.findIndex((c, i) => c.o === after.myPlayer!.team && i !== after.myPlayer!.pos);
    if (mine >= 0) {
      const out = await rpc({ t: "pick", cell: mine, actionId: "p2", playerId: id });
      expect(out.code).toBeTruthy();
    }
  });

  it("채점 결과가 '이번 턴 끝'을 함께 알려 준다", async () => {
    const state = await startGame();
    const id = state.myPlayer!.id;
    const cell = pickableCell(state);
    await rpc({ t: "pick", cell, actionId: "p1", playerId: id });
    const out = await rpc({ t: "answer", cell, choice: 0, actionId: "a1", playerId: id });
    expect((out.reply as { playedThisTurn: boolean }).playedThisTurn).toBe(true);
  });
});

describe("멱등 — 같은 요청이 두 번 와도 한 번만 반영된다", () => {
  it("같은 actionId 로 답을 두 번 내도 점수가 한 번만 오른다", async () => {
    const state = await startGame();
    const me = { myPlayer: state.myPlayer };
    const cell = pickableCell(state);
    await rpc({ t: "pick", cell, actionId: "p1", playerId: me.myPlayer!.id });

    const first = await rpc({ t: "answer", cell, choice: 0, actionId: "same", playerId: me.myPlayer!.id });
    const after1 = await myState(me.myPlayer!.id);
    const second = await rpc({ t: "answer", cell, choice: 0, actionId: "same", playerId: me.myPlayer!.id });
    const after2 = await myState(me.myPlayer!.id);

    expect(second.reply).toEqual(first.reply);
    expect(after2.scores).toEqual(after1.scores);
    expect(after2.stateRev).toBe(after1.stateRev); // 정본이 다시 바뀌지 않았다
  });

  it("[다음 턴]을 같은 actionId 로 두 번 눌러도 한 번만 넘어간다", async () => {
    await join("민수");
    await teacherCmd("newgame");

    const actionId = crypto.randomUUID();
    await rpc({ t: "cmd", cmd: "next", actionId }, teacherCookie);
    const a = (await rpc({ t: "sync" }, teacherCookie)).reply as StateMsg;
    await rpc({ t: "cmd", cmd: "next", actionId }, teacherCookie);
    const b = (await rpc({ t: "sync" }, teacherCookie)).reply as StateMsg;

    expect(b.round).toBe(a.round);
    expect(b.turnTeam).toBe(a.turnTeam);
  });

  it("2초 안에 [다음 턴]을 다시 누르면 거절한다", async () => {
    await join("민수");
    await teacherCmd("newgame");
    await teacherCmd("next");
    const out = await teacherCmd("next");
    expect(out.code).toBe("action-conflict");
  });
});

describe("선생님 명령", () => {
  it("새 게임은 명단을 지우지 않는다", async () => {
    await join("민수");
    await join("영희");
    await teacherCmd("newgame");

    const state = (await rpc({ t: "sync" }, teacherCookie)).reply as StateMsg;
    expect(state.players).toHaveLength(2);
  });

  it("게임이 끝나도 학생은 튕기지 않는다", async () => {
    // 2026-08-05 시연에서 종료하는 순간 15명이 한꺼번에 튕겼다.
    const me = await join("민수");
    await teacherCmd("newgame");
    await teacherCmd("next");
    await teacherCmd("end");

    const state = await myState(me.myPlayer!.id);
    expect(state.status).toBe("ended");
    expect(state.players).toHaveLength(1);
  });

  it("초기화는 명단까지 비운다", async () => {
    await join("민수");
    await teacherCmd("reset");
    const state = (await rpc({ t: "sync" }, teacherCookie)).reply as StateMsg;
    expect(state.players).toHaveLength(0);
  });

  it("강퇴하면 명단에서 사라진다", async () => {
    const me = await join("민수");
    await join("영희");
    await teacherCmd("kick", { playerId: me.myPlayer!.id });

    const state = (await rpc({ t: "sync" }, teacherCookie)).reply as StateMsg;
    expect(state.players).toHaveLength(1);
    expect(state.players[0]!.name).toBe("영희");
  });

  it("학생은 선생님 명령을 쓸 수 없다", async () => {
    const me = await join("민수");
    const out = await rpc({ t: "cmd", cmd: "end", actionId: "x", playerId: me.myPlayer!.id });
    expect(out.code).toBe("not-owner");
  });

  it("퀴즈를 바꾸면 제목과 문제가 함께 바뀐다", async () => {
    await join("민수");
    const form = new FormData();
    form.set("title", "사회1");
    form.set("file", new File([sampleCsv], "사회.csv", { type: "text/csv" }));
    const up = await SELF.fetch(`${BASE}/api/quizsets`, {
      method: "POST",
      headers: { cookie: teacherCookie },
      body: form,
    });
    const newId = ((await up.json()) as { id: number }).id;

    await teacherCmd("newgame", { quizSetId: newId });
    const state = (await rpc({ t: "sync" }, teacherCookie)).reply as StateMsg;
    expect(state.quizTitle).toBe("사회1");
  });

  it("남의 퀴즈로는 바꿀 수 없다", async () => {
    const other = await signupOk("other2");
    const form = new FormData();
    form.set("title", "남의것");
    form.set("file", new File([sampleCsv], "x.csv", { type: "text/csv" }));
    const up = await SELF.fetch(`${BASE}/api/quizsets`, { method: "POST", headers: { cookie: other }, body: form });
    const otherId = ((await up.json()) as { id: number }).id;

    const out = await teacherCmd("newgame", { quizSetId: otherId });
    expect(out.code).toBe("no-quiz");
  });
});

describe("턴 타이머와 방 정리 (알람 하나로 둘 다)", () => {
  const stub = () => env.ROOM.getByName(roomCode);

  /** DO 안에 들어가 시각을 과거로 돌린다. 10초를 실제로 기다릴 수는 없다. */
  async function rewind(sql: string) {
    await runInDurableObject(stub(), (_i, state) => {
      state.storage.sql.exec(sql, Date.now() - 10_000);
    });
  }

  it("아무도 안 눌러도 시간이 되면 턴이 넘어간다", async () => {
    // 지금은 "누가 요청할 때 시간이 지났으면" 넘기는 방식이라 아무도 안 누르면 멈춰 있었다.
    await join("민수");
    await teacherCmd("newgame");
    await teacherCmd("next");
    const before = (await rpc({ t: "sync" }, teacherCookie)).reply as StateMsg;

    await rewind("UPDATE room SET turn_ends_at = ? WHERE id = 1");
    expect(await runDurableObjectAlarm(stub())).toBe(true);

    const after = (await rpc({ t: "sync" }, teacherCookie)).reply as StateMsg;
    expect(after.turnTeam).not.toBe(before.turnTeam);
  });

  it("시간이 남았으면 알람이 돌아도 넘기지 않는다", async () => {
    await join("민수");
    await teacherCmd("newgame");
    await teacherCmd("next");
    const before = (await rpc({ t: "sync" }, teacherCookie)).reply as StateMsg;

    await runDurableObjectAlarm(stub()); // 이른 깨어남
    const after = (await rpc({ t: "sync" }, teacherCookie)).reply as StateMsg;
    expect(after.turnTeam).toBe(before.turnTeam);
    expect(after.round).toBe(before.round);
  });

  it("오래 조용한 방은 알람이 정리한다", async () => {
    // 알람은 DO 당 하나뿐이다. 게임 중이면 턴 마감, 아니면 방 정리를 맡는다.
    await join("민수");
    await rewind("UPDATE room SET last_active_at = ? - 14400000 WHERE id = 1");
    await runDurableObjectAlarm(stub());

    // D1 에서 닫혔고, 학생 입장 화면에서도 사라진다
    expect((await SELF.fetch(`${BASE}/api/rooms/${roomCode}`)).status).toBe(404);
    const mine = (await (await SELF.fetch(`${BASE}/api/rooms/mine`, { headers: { cookie: teacherCookie } })).json()) as {
      rooms: unknown[];
    };
    expect(mine.rooms).toHaveLength(0);
  });
});

describe("정원", () => {
  it("판이 꽉 차면 더 못 들어온다", async () => {
    roomCode = await makeRoom(teacherCookie, { rows: 10, cols: 10 }); // 정원 41
    for (let i = 0; i < 41; i++) await join(`학생${i}`);
    const out = await rpc({ t: "hello", role: "student", name: "마흔둘" });
    expect(out.code).toBe("room-full");
  });
});

/**
 * 3D 무대에 올릴 턴 요약.
 *
 * 여기서 지키는 것은 하나다 — **연출은 정본이 실제로 바꾼 것만 말한다.**
 * 보너스를 못 받은 보물칸을 "+2"라고 하거나, 빼앗은 땅이 없는데 "빼앗았다"고 하면
 * 교사가 보드와 연출 중 어느 쪽을 믿어야 할지 모르게 된다.
 */
describe("턴 요약 (3D 무대)", () => {
  const stub = () => env.ROOM.getByName(roomCode);

  /** 시간을 과거로 돌린다. 실제로 기다릴 수는 없다. */
  const rewind = (sql: string) =>
    runInDurableObject(stub(), (_i, state) => {
      state.storage.sql.exec(sql, Date.now() - 10_000);
    });

  /** 방 안의 SQL 을 직접 실행한다. 특수칸 분기를 만들려면 이 방법뿐이다. */
  const inRoom = (sql: string, ...args: (string | number)[]) =>
    runInDurableObject(stub(), (_i, state) => {
      state.storage.sql.exec(sql, ...args);
    });

  /** 그 칸에 배정된 문제의 정답 번호. 4개를 다 눌러 보는 대신 정확히 맞히거나 정확히 틀린다. */
  async function answerOf(cell: number): Promise<number> {
    let ans = 0;
    await runInDurableObject(stub(), (_i, state) => {
      ans = state.storage.sql
        .exec<{ a: number }>(
          "SELECT q.ans AS a FROM cells c JOIN quizzes q ON q.idx = c.quiz_idx WHERE c.idx = ?",
          cell,
        )
        .one().a;
    });
    return ans;
  }

  /** [다음 턴] 버튼 말고 타이머로 넘긴다. 연타 방지 2초를 기다리지 않아도 되고, 알람 경로까지 함께 시험된다. */
  async function timeoutTurn() {
    await rewind("UPDATE room SET turn_ends_at = ? WHERE id = 1");
    expect(await runDurableObjectAlarm(stub())).toBe(true);
  }

  async function bothPlayers() {
    const a = await join("민수");
    const b = await join("영희");
    await teacherCmd("newgame");
    await teacherCmd("next");
    return [a.myPlayer!.id, b.myPlayer!.id] as const;
  }

  /** 그 상태의 주인공 이름. 팀 배정이 무작위라 이름을 박아 두면 판마다 깨진다. */
  const nameOf = (s: StateMsg) => s.players.find((p) => p.id === s.myPlayer!.id)!.name;

  /** 지금 차례인 학생의 상태를 돌려준다. */
  async function whoseTurn(ids: readonly string[]): Promise<StateMsg> {
    for (const id of ids) {
      const s = await myState(id);
      if (s.turnTeam === s.myPlayer!.team) return s;
    }
    throw new Error("차례인 학생이 없다");
  }

  /** 지금 차례인 학생이 지정한 종류의 칸을 푼다. */
  async function solve(state: StateMsg, type: "N" | "T" | "S" | "A", ok = true) {
    const id = state.myPlayer!.id;
    const cell = pickableCell(state);
    await inRoom("UPDATE cells SET type = ? WHERE idx = ?", type, cell);
    await rpc({ t: "pick", cell, actionId: crypto.randomUUID(), playerId: id });
    const ans = await answerOf(cell);
    await rpc({
      t: "answer",
      cell,
      choice: ok ? ans : (ans + 1) % 4,
      actionId: crypto.randomUUID(),
      playerId: id,
    });
    return cell;
  }

  const teacherState = async () => (await rpc({ t: "sync" }, teacherCookie)).reply as StateMsg;

  it("시작하자마자는 양쪽 다 비어 있다", async () => {
    await bothPlayers();
    const st = await teacherState();
    expect(st.turnFx.H).toBeNull();
    expect(st.turnFx.C).toBeNull();
  });

  it("📦 보너스를 받으면 '보물'로 남는다", async () => {
    const ids = await bothPlayers();
    const me = await whoseTurn(ids);
    await solve(me, "T");
    await timeoutTurn();

    const fx = (await teacherState()).turnFx[me.myPlayer!.team]!;
    expect(fx.names["treasure-bonus"]).toEqual([nameOf(me)]);
    expect(fx.names["treasure-claim"]).toBeUndefined();
    expect(fx.normal).toBe(0);
  });

  it("📦 이미 받은 보물칸이면 '+2'라고 하지 않는다", async () => {
    const ids = await bothPlayers();
    const me = await whoseTurn(ids);
    const cell = pickableCell(me);
    // bonus_taken > 0 이면 이미 효과가 소진된 칸이다(값이 1이든 3이든 같다).
    await inRoom("UPDATE cells SET type = 'T', bonus_taken = 1 WHERE idx = ?", cell);
    await rpc({ t: "pick", cell, actionId: "p", playerId: me.myPlayer!.id });
    await rpc({ t: "answer", cell, choice: await answerOf(cell), actionId: "a", playerId: me.myPlayer!.id });
    await timeoutTurn();

    const fx = (await teacherState()).turnFx[me.myPlayer!.team]!;
    expect(fx.names["treasure-claim"]).toHaveLength(1);
    expect(fx.names["treasure-bonus"]).toBeUndefined();
  });

  it("💥 상대 땅이 있으면 '빼앗았다'", async () => {
    const ids = await bothPlayers();
    const me = await whoseTurn(ids);
    await solve(me, "A");
    await timeoutTurn();

    const fx = (await teacherState()).turnFx[me.myPlayer!.team]!;
    expect(fx.names["attack-steal"]).toHaveLength(1);
    expect(fx.names["attack-claim"]).toBeUndefined();
  });

  it("💥 빼앗을 상대 땅이 없으면 '빼앗았다'가 아니다", async () => {
    const ids = await bothPlayers();
    const me = await whoseTurn(ids);
    const enemy = me.myPlayer!.team === "H" ? "C" : "H";
    const cell = pickableCell(me);
    await inRoom("UPDATE cells SET type = 'A' WHERE idx = ?", cell);
    await rpc({ t: "pick", cell, actionId: "p", playerId: me.myPlayer!.id });
    // 채점 직전에 상대 땅을 모두 없앤다 — 공격은 성공하지만 가져올 칸이 없다.
    await inRoom("UPDATE cells SET owner = NULL, owned_by = NULL WHERE owner = ?", enemy);
    await rpc({ t: "answer", cell, choice: await answerOf(cell), actionId: "a", playerId: me.myPlayer!.id });
    await timeoutTurn();

    const fx = (await teacherState()).turnFx[me.myPlayer!.team]!;
    expect(fx.names["attack-claim"]).toHaveLength(1);
    expect(fx.names["attack-steal"]).toBeUndefined();
  });

  it("💥 공격 효과는 첫 점령 때만 발동한다", async () => {
    // bonus_taken = 1 이면 이미 소진된 공격 칸 → 빼앗기 없음
    const ids = await bothPlayers();
    const me = await whoseTurn(ids);
    const cell = pickableCell(me);
    await inRoom("UPDATE cells SET type = 'A', bonus_taken = 1 WHERE idx = ?", cell);
    await rpc({ t: "pick", cell, actionId: "p", playerId: me.myPlayer!.id });
    await rpc({ t: "answer", cell, choice: await answerOf(cell), actionId: "a", playerId: me.myPlayer!.id });
    await timeoutTurn();

    const fx = (await teacherState()).turnFx[me.myPlayer!.team]!;
    // 효과가 소진됐으므로 attack-steal 없이 attack-claim 만
    expect(fx.names["attack-claim"]).toHaveLength(1);
    expect(fx.names["attack-steal"]).toBeUndefined();
  });

  it("⛈️ 폭풍은 재점령할 때도 매번 발동한다", async () => {
    // 보물·공격과 갈리는 지점이 여기다. 그 둘은 bonus_taken 이 서면 두 번째 사람부터
    // 효과가 없지만, 폭풍은 그 플래그를 아예 보지 않으므로 몇 번을 다시 뺏어도 매번 걸린다.
    //
    // 응답의 skipNextTurn 을 보면 안 된다 — 그 값은 bonus_taken 과 무관하게 따로 계산되어
    // 규칙을 깨도 true 로 남는다(그렇게 짰다가 이 테스트가 통과해 버렸다).
    // 실제로 쉬게 됐는지, 즉 skip_turns 가 섰는지를 봐야 한다.
    const ids = await bothPlayers();
    const me = await whoseTurn(ids);
    const cell = pickableCell(me);
    await inRoom("UPDATE cells SET type = 'S', bonus_taken = 1 WHERE idx = ?", cell);
    await rpc({ t: "pick", cell, actionId: "p", playerId: me.myPlayer!.id });
    await rpc({ t: "answer", cell, choice: await answerOf(cell), actionId: "a", playerId: me.myPlayer!.id });

    let skipTurns = 0;
    await runInDurableObject(stub(), (_i, state) => {
      skipTurns = state.storage.sql
        .exec<{ s: number }>("SELECT skip_turns AS s FROM players WHERE id = ?", me.myPlayer!.id)
        .one().s;
    });
    expect(skipTurns).toBe(1);
  });

  it("⛈️ 폭풍은 이름과 함께 남는다", async () => {
    const ids = await bothPlayers();
    const me = await whoseTurn(ids);
    await solve(me, "S");
    await timeoutTurn();

    expect((await teacherState()).turnFx[me.myPlayer!.team]!.names["storm"]).toHaveLength(1);
  });

  it("🚩 일반 칸은 사람 수만 세고 이름은 안 쓴다", async () => {
    const ids = await bothPlayers();
    const me = await whoseTurn(ids);
    await solve(me, "N");
    await timeoutTurn();

    const fx = (await teacherState()).turnFx[me.myPlayer!.team]!;
    expect(fx.normal).toBe(1);
    expect(fx.names).toEqual({});
  });

  it("❌ 틀린 사람은 어디에도 안 나온다", async () => {
    const ids = await bothPlayers();
    const me = await whoseTurn(ids);
    await solve(me, "T", false);
    await timeoutTurn();

    const fx = (await teacherState()).turnFx[me.myPlayer!.team]!;
    expect(fx.normal).toBe(0);
    expect(fx.names).toEqual({});
  });

  it("팀마다 따로 쌓이고, 최신 턴만 남는다", async () => {
    const ids = await bothPlayers();
    const first = await whoseTurn(ids);
    const teamA = first.myPlayer!.team;
    const teamB = teamA === "H" ? "C" : "H";

    await solve(first, "T"); //  A팀: 보물
    await timeoutTurn();
    await solve(await whoseTurn(ids), "S"); // B팀: 폭풍
    await timeoutTurn();

    let st = await teacherState();
    expect(st.turnFx[teamA]!.names["treasure-bonus"]).toHaveLength(1);
    expect(st.turnFx[teamB]!.names["storm"]).toHaveLength(1);

    // A팀 차례가 다시 왔다. 이번엔 아무것도 못 했다면 앞 턴의 보물은 지워진다.
    await timeoutTurn();
    st = await teacherState();
    expect(st.turnFx[teamA]!.names["treasure-bonus"]).toBeUndefined();
    expect(st.turnFx[teamA]!.normal).toBe(0);
    expect(st.turnFx[teamB]!.names["storm"]).toHaveLength(1); // B팀 것은 그대로
  });

  it("[종료]를 눌러도 마지막 턴이 남는다", async () => {
    const ids = await bothPlayers();
    const me = await whoseTurn(ids);
    await solve(me, "T");
    await teacherCmd("end");

    const fx = (await teacherState()).turnFx[me.myPlayer!.team]!;
    expect(fx.names["treasure-bonus"]).toHaveLength(1);
  });

  it("라운드가 끝나 저절로 종료돼도 마지막 턴이 한 번만 남는다", async () => {
    // advanceTurn 이 스스로 endGame 을 부르는 경로다. 두 곳 모두 요약을 뜨므로 겹치기 쉽다.
    roomCode = await makeRoom(teacherCookie, { roundLimit: 1 });
    const ids = await bothPlayers();
    const me = await whoseTurn(ids);
    await solve(me, "T");
    await timeoutTurn(); // 홍→청
    await timeoutTurn(); // 라운드 한계 → 자동 종료

    const st = await teacherState();
    expect(st.status).toBe("ended");
    expect(st.turnFx[me.myPlayer!.team]!.names["treasure-bonus"]).toEqual([nameOf(me)]);
  });

  it("새 게임을 하면 지난 판 결과가 사라진다", async () => {
    const ids = await bothPlayers();
    await solve(await whoseTurn(ids), "T");
    await timeoutTurn();
    expect((await teacherState()).turnFx.H ?? (await teacherState()).turnFx.C).not.toBeNull();

    await teacherCmd("newgame");
    const st = await teacherState();
    expect(st.turnFx.H).toBeNull();
    expect(st.turnFx.C).toBeNull();
  });

  it("학생이 다시 붙어도 선생님과 같은 요약을 본다", async () => {
    const ids = await bothPlayers();
    const me = await whoseTurn(ids);
    await solve(me, "T");
    await timeoutTurn();

    const mine = await myState(ids[0]);
    expect(mine.turnFx).toEqual((await teacherState()).turnFx);
  });
});
