import { describe, expect, it } from "vitest";
import {
  assignQuizzes,
  assignRandomPositions,
  buildBoard,
  canChallengeFrom,
  cellIndex,
  cellLabel,
  checkBoardSize,
  chebyshev,
  columnLabel,
  maxPlayers,
  neighbors8,
  nextTurn,
  pickStealTarget,
  placeLatePlayer,
  rc,
  rescueTrapped,
  winnerOf,
  type Owner,
  type PlacementPlayer,
  type PlacementView,
  type Team,
} from "../src/game";

function view(rows: number, cols: number, players: PlacementPlayer[] = []): PlacementView {
  return { rows, cols, owners: new Array<Owner>(rows * cols).fill(null), players };
}

// ── 기하 — Backend.gs 의 runGeometryTests() 와 같은 값이 나와야 한다 ────────
describe("기하", () => {
  it("열 이름", () => {
    expect(columnLabel(0)).toBe("A");
    expect(columnLabel(25)).toBe("Z");
    expect(columnLabel(26)).toBe("AA");
  });

  it("칸 이름 (12열 기준)", () => {
    expect(cellLabel(0, 12)).toBe("A1");
    expect(cellLabel(11, 12)).toBe("L1");
    expect(cellLabel(132, 12)).toBe("A12");
    expect(cellLabel(143, 12)).toBe("L12");
  });

  it("rc 왕복", () => {
    const p = rc(87, 12);
    expect(cellIndex(p.r, p.c, 12)).toBe(87);
  });

  it("둘레는 모서리 3 · 가장자리 5 · 안쪽 8", () => {
    expect(neighbors8(0, 12, 12)).toHaveLength(3);
    expect(neighbors8(5, 12, 12)).toHaveLength(5);
    expect(neighbors8(20, 12, 12)).toHaveLength(8);
  });

  it("대각선이 포함된다", () => {
    expect(neighbors8(13, 12, 12)).toContain(0);
  });

  it("체비셰프 거리", () => {
    expect(chebyshev(0, 13, 12)).toBe(1);
  });

  it("이웃은 서로를 가리킨다", () => {
    for (const i of [0, 5, 20, 143]) {
      for (const n of neighbors8(i, 12, 12)) {
        expect(neighbors8(n, 12, 12)).toContain(i);
      }
    }
  });
});

// ── 판 만들기 ───────────────────────────────────────────────────────────────
describe("판 만들기", () => {
  it("특수칸 수가 설정값과 정확히 일치한다", () => {
    const board = buildBoard({ rows: 12, cols: 12, cntT: 8, cntS: 7, cntA: 7 }, 50);
    expect(board).toHaveLength(144);
    const count = (t: string) => board.filter((c) => c.type === t).length;
    expect(count("T")).toBe(8);
    expect(count("S")).toBe(7);
    expect(count("A")).toBe(7);
    expect(count("N")).toBe(144 - 22);
  });

  it("모든 칸에 문제가 배정된다", () => {
    const board = buildBoard({ rows: 12, cols: 12, cntT: 8, cntS: 7, cntA: 7 }, 50);
    for (const c of board) {
      expect(c.quizIdx).toBeGreaterThanOrEqual(0);
      expect(c.quizIdx).toBeLessThan(50);
    }
  });

  it("특수칸이 전체 칸보다 많으면 거절한다", () => {
    expect(() => buildBoard({ rows: 10, cols: 10, cntT: 50, cntS: 50, cntA: 50 }, 50)).toThrow();
  });

  it("판 크기가 범위 밖이면 거절한다", () => {
    expect(() => buildBoard({ rows: 9, cols: 12, cntT: 8, cntS: 7, cntA: 7 }, 50)).toThrow();
    expect(() => buildBoard({ rows: 16, cols: 12, cntT: 8, cntS: 7, cntA: 7 }, 50)).toThrow();
  });

  it("문항이 충분하면 이웃끼리 같은 문제가 거의 없다", () => {
    // 3패스 교환은 최선 노력이라 0을 보장하지 않는다. 전체의 1% 미만이면 통과.
    const q = assignQuizzes(144, 12, 12, 50);
    let clash = 0;
    for (let i = 0; i < 144; i++) {
      for (const n of neighbors8(i, 12, 12)) if (q[n] === q[i]) clash++;
    }
    expect(clash / 144).toBeLessThan(0.01);
  });

  it("문항이 없으면 거절한다", () => {
    expect(() => assignQuizzes(144, 12, 12, 0)).toThrow();
  });
});

describe("판 크기", () => {
  it("10×10 부터 15×15 까지만 받는다", () => {
    expect(checkBoardSize(10, 10)).toBeNull();
    expect(checkBoardSize(12, 12)).toBeNull();
    expect(checkBoardSize(15, 15)).toBeNull();
    expect(checkBoardSize(9, 12)).toContain("10×10");
    expect(checkBoardSize(12, 16)).toContain("15×15");
    expect(checkBoardSize(12.5, 12)).not.toBeNull();
  });

  it("정원은 판 크기에서 계산한다", () => {
    expect(maxPlayers(10, 10)).toBe(41);
    expect(maxPlayers(12, 12)).toBe(60);
    expect(maxPlayers(15, 15)).toBe(93);
  });
});

// ── 배치 ────────────────────────────────────────────────────────────────────
describe("배치", () => {
  const roster = (n: number): PlacementPlayer[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `p${i}`,
      team: (i % 2 === 0 ? "H" : "C") as Team,
      pos: null,
    }));

  it("새 게임: 겹치지 않고 시작 칸이 팀 색으로 칠해진다", () => {
    const v = view(12, 12, roster(15));
    assignRandomPositions(v);

    const positions = v.players.map((p) => p.pos!);
    expect(new Set(positions).size).toBe(15);
    for (const p of v.players) expect(v.owners[p.pos!]).toBe(p.team);
    expect(v.owners.filter(Boolean)).toHaveLength(15);
  });

  it("학생이 칸보다 많으면 거절한다", () => {
    const v = view(3, 3, roster(10));
    expect(() => assignRandomPositions(v)).toThrow();
  });

  it("늦게 온 학생도 자리를 받고 칸이 칠해진다", () => {
    const v = view(12, 12, roster(5));
    assignRandomPositions(v);
    v.players.push({ id: "late", team: "H", pos: null });

    const pos = placeLatePlayer(v, "late");
    expect(v.players.filter((p) => p.pos === pos)).toHaveLength(1);
    expect(v.owners[pos]).toBe("H");
    expect(canChallengeFrom(v, pos, "H")).toBe(true);
  });

  it("아군에 둘러싸인 학생을 구출한다", () => {
    // 5×5 의 안쪽 3×3 만 홍팀이 먹고 한가운데(12)에 홍팀 학생을 세운다.
    // 둘레 8칸이 전부 아군이라 도전할 곳이 없다. 바깥 테두리는 비어 있다.
    const v = view(5, 5, [{ id: "stuck", team: "H", pos: 12 }]);
    for (const i of [6, 7, 8, 11, 12, 13, 16, 17, 18]) v.owners[i] = "H";
    expect(canChallengeFrom(v, 12, "H")).toBe(false);

    const moved = rescueTrapped(v, "H");
    expect(moved).toEqual(["stuck"]);
    expect(v.players[0]!.pos).not.toBe(12);
    expect(canChallengeFrom(v, v.players[0]!.pos!, "H")).toBe(true);
  });

  it("갇히지 않은 학생은 움직이지 않는다", () => {
    const v = view(12, 12, [{ id: "ok", team: "H", pos: 20 }]);
    expect(rescueTrapped(v, "H")).toEqual([]);
    expect(v.players[0]!.pos).toBe(20);
  });
});

// ── 공격칸 ──────────────────────────────────────────────────────────────────
describe("공격칸", () => {
  it("상대 칸 중 하나를 고른다", () => {
    const owners: Owner[] = ["H", "C", null, "C"];
    const target = pickStealTarget(owners, "H");
    expect([1, 3]).toContain(target);
  });

  it("상대 칸이 없으면 아무것도 고르지 않는다", () => {
    expect(pickStealTarget(["H", "H", null], "H")).toBeNull();
  });
});

// ── 턴 ──────────────────────────────────────────────────────────────────────
describe("턴", () => {
  it("시작 → 홍 → 청 → 홍(라운드 +1)", () => {
    expect(nextTurn(null, 1)).toEqual({ turnTeam: "H", round: 1 });
    expect(nextTurn("H", 1)).toEqual({ turnTeam: "C", round: 1 });
    expect(nextTurn("C", 1)).toEqual({ turnTeam: "H", round: 2 });
  });

  it("승패", () => {
    expect(winnerOf(10, 8)).toBe("홍팀");
    expect(winnerOf(8, 10)).toBe("청팀");
    expect(winnerOf(9, 9)).toBe("무승부");
  });
});
