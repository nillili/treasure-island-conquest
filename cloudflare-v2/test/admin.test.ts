import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { idOf, loginAs } from "./sso";
import sampleCsv from "../../sample/퀴즈_샘플_v3.csv?raw";

const BASE = "https://t.test";

/** 옛 이름 그대로 둔다 — 안이 네오버스 로그인으로 바뀌었을 뿐이다. */
async function signupOk(id: string, name = "선생") {
  return loginAs(id, name);
}

/** 관제는 D1 의 is_super 만 본다. 화면을 거치지 않고 바로 세워 둔다. */
async function makeSuper(id: string) {
  await env.DB.prepare("UPDATE teachers SET is_super = 1 WHERE id = ?").bind(id).run();
}

const get = (path: string, cookie?: string) =>
  SELF.fetch(`${BASE}${path}`, { headers: cookie ? { cookie } : {} });

let quizSeq = 0;
async function makeRoom(cookie: string) {
  const form = new FormData();
  form.set("title", `퀴즈${quizSeq++}`);
  form.set("file", new File([sampleCsv], "퀴즈.csv", { type: "text/csv" }));
  const up = await SELF.fetch(`${BASE}/api/quizsets`, { method: "POST", headers: { cookie }, body: form });
  const quizSetId = ((await up.json()) as { id: number }).id;

  const res = await SELF.fetch(`${BASE}/api/rooms`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ requestId: crypto.randomUUID(), quizSetId, label: "3학년 2반" }),
  });
  if (res.status !== 200) throw new Error(`방 개설 실패: ${await res.text()}`);
  return ((await res.json()) as { code: string }).code;
}

const rpc = (room: string, body: Record<string, unknown>, cookie?: string) =>
  SELF.fetch(`${BASE}/api/rooms/${room}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  }).then((r) => r.json() as Promise<{ ok?: boolean; reply?: unknown; msg?: string }>);

/** 학생 둘을 넣고 새 게임을 깐 뒤 곧바로 끝낸다 — 기록 한 줄이 남는다. */
async function playAndEnd(room: string, cookie: string) {
  await rpc(room, { t: "hello", role: "student", name: "민수" });
  await rpc(room, { t: "hello", role: "student", name: "영희" });
  await rpc(room, { t: "cmd", cmd: "newgame", actionId: crypto.randomUUID() }, cookie);
  await rpc(room, { t: "cmd", cmd: "end", actionId: crypto.randomUUID() }, cookie);
}

interface Overview {
  ok: boolean;
  teachers: { id: string; name: string; isSuper: boolean; quizCount: number; gameCount: number; openRooms: number }[];
  openRooms: { code: string; teacherId: string; live: { players: number } | null }[];
  recentGames: {
    roomCode: string; teacherId: string; playerCount: number; winner: string;
    issues: { kind: string; detail: string }[]; level: string;
  }[];
}

let bossCookie = "";
let plainCookie = "";
// 선생님 id 는 이제 네오버스 신원에서 나오는 UUID 다. 시험도 그 값을 받아서 쓴다.
let boss = "";
let plain = "";

beforeEach(async () => {
  bossCookie = await signupOk("kimssam", "김선생");
  plainCookie = await signupOk("parkssam", "박선생");
  boss = await idOf("kimssam");
  plain = await idOf("parkssam");
  await makeSuper(boss);
});

describe("문지기", () => {
  it("슈퍼관리자는 관제를 볼 수 있다", async () => {
    const res = await get("/api/admin/overview", bossCookie);
    expect(res.status).toBe(200);
    expect((await res.json()) as Overview).toMatchObject({ ok: true });
  });

  it("보통 선생님에게는 관제가 아예 없는 주소다", async () => {
    const res = await get("/api/admin/overview", plainCookie);
    // 403 이 아니라 404 다 — 관제가 있다는 사실 자체를 알려 주지 않는다.
    expect(res.status).toBe(404);
  });

  it("로그인하지 않으면 401 이다", async () => {
    const res = await get("/api/admin/overview");
    expect(res.status).toBe(401);
  });

  it("권한을 거두면 그 자리에서 막힌다", async () => {
    await env.DB.prepare("UPDATE teachers SET is_super = 0 WHERE id = ?").bind(boss).run();
    expect((await get("/api/admin/overview", bossCookie)).status).toBe(404);
  });

  it("고치거나 지우는 길은 없다", async () => {
    const res = await SELF.fetch(`${BASE}/api/admin/quizsets/1`, {
      method: "DELETE",
      headers: { cookie: bossCookie },
    });
    expect(res.status).toBe(405);
  });
});

describe("로그인 응답", () => {
  it("슈퍼관리자는 isSuper 가 참이다", async () => {
    const res = await SELF.fetch(`${BASE}/api/auth/me`, { headers: { cookie: bossCookie } });
    expect(await res.json()).toMatchObject({ id: boss, isSuper: true });
  });

  it("보통 선생님은 거짓이다", async () => {
    const res = await SELF.fetch(`${BASE}/api/auth/me`, { headers: { cookie: plainCookie } });
    expect(await res.json()).toMatchObject({ id: plain, isSuper: false });
  });
});

describe("관제 첫 화면", () => {
  it("모든 선생님이 보인다 — 남의 것까지", async () => {
    const d = (await (await get("/api/admin/overview", bossCookie)).json()) as Overview;
    expect(d.teachers.map((t) => t.id).sort()).toEqual([boss, plain].sort());
    expect(d.teachers.find((t) => t.id === boss)!.isSuper).toBe(true);
  });

  it("남이 연 방도 보인다", async () => {
    const room = await makeRoom(plainCookie);
    const d = (await (await get("/api/admin/overview", bossCookie)).json()) as Overview;
    const found = d.openRooms.find((r) => r.code === room);
    expect(found).toBeTruthy();
    expect(found!.teacherId).toBe(plain);
  });

  it("퀴즈 수를 선생님별로 센다", async () => {
    await makeRoom(plainCookie);
    const d = (await (await get("/api/admin/overview", bossCookie)).json()) as Overview;
    // 가입할 때 샘플 퀴즈가 한 개 깔린다(seedSampleQuiz). 올린 것 하나가 그 위에 더해진다.
    expect(d.teachers.find((t) => t.id === plain)!.quizCount).toBe(2);
    expect(d.teachers.find((t) => t.id === boss)!.quizCount).toBe(1);
  });
});

describe("지난 수업 기록", () => {
  it("게임이 끝나면 한 줄이 남는다", async () => {
    const room = await makeRoom(plainCookie);
    await playAndEnd(room, plainCookie);

    const d = (await (await get("/api/admin/overview", bossCookie)).json()) as Overview;
    expect(d.recentGames).toHaveLength(1);
    expect(d.recentGames[0]).toMatchObject({ roomCode: room, teacherId: plain, playerCount: 2 });
  });

  it("학생 이름은 어디에도 남지 않는다", async () => {
    const room = await makeRoom(plainCookie);
    await playAndEnd(room, plainCookie);

    // 응답 전체를 글자로 훑는다. 이름이 새는 길이 하나라도 생기면 여기서 걸린다.
    const raw = await (await get("/api/admin/overview", bossCookie)).text();
    expect(raw).not.toContain("민수");
    expect(raw).not.toContain("영희");

    const row = await env.DB.prepare("SELECT * FROM game_records").first<Record<string, unknown>>();
    expect(JSON.stringify(row)).not.toContain("민수");
  });

  it("같은 판을 두 번 끝내도 한 줄만 남는다", async () => {
    const room = await makeRoom(plainCookie);
    await playAndEnd(room, plainCookie);
    await rpc(room, { t: "cmd", cmd: "end", actionId: crypto.randomUUID() }, plainCookie);

    const { results } = await env.DB.prepare("SELECT id FROM game_records").all();
    expect(results).toHaveLength(1);
  });

  it("새 게임을 깔면 판마다 따로 남는다", async () => {
    const room = await makeRoom(plainCookie);
    await playAndEnd(room, plainCookie);
    await playAndEnd(room, plainCookie);

    const { results } = await env.DB.prepare("SELECT id FROM game_records").all();
    expect(results).toHaveLength(2);
  });

  it("라운드를 다 못 채우고 끝나면 이상 징후로 남는다", async () => {
    const room = await makeRoom(plainCookie);
    await playAndEnd(room, plainCookie); // 1라운드에서 [종료]

    const d = (await (await get("/api/admin/overview", bossCookie)).json()) as Overview;
    const kinds = d.recentGames[0]!.issues.map((i) => i.kind);
    expect(kinds).toContain("short");
    expect(kinds).toContain("no-answer"); // 아무도 답을 안 냈다
    expect(d.recentGames[0]!.level).toBe("warn");
  });

  it("소켓이 하나도 안 붙어 있으면 접속 끊김을 말하지 않는다", async () => {
    // 이 테스트는 폴백(RPC)만 쓴다 = 붙어 있는 소켓이 0개.
    // 폴백으로 수업 중인 교실과 다 나간 교실을 가릴 수 없으므로 단정하지 않는 것이 맞다.
    const room = await makeRoom(plainCookie);
    await playAndEnd(room, plainCookie);

    const d = (await (await get("/api/admin/overview", bossCookie)).json()) as Overview;
    expect(d.recentGames[0]!.issues.map((i) => i.kind)).not.toContain("offline");
  });

  it("이상 징후 문구에도 이름이 없다 — 몇 명인지만 센다", async () => {
    const room = await makeRoom(plainCookie);
    await playAndEnd(room, plainCookie);

    const d = (await (await get("/api/admin/overview", bossCookie)).json()) as Overview;
    const silent = d.recentGames[0]!.issues.find((i) => i.kind === "no-answer")!;
    expect(silent.detail).toBe("한 번도 답을 내지 않은 학생 2명.");
  });
});

describe("선생님 펼쳐 보기", () => {
  it("남의 퀴즈와 지난 수업이 함께 나온다", async () => {
    const room = await makeRoom(plainCookie);
    await playAndEnd(room, plainCookie);

    const res = await get(`/api/admin/teachers/${plain}`, bossCookie);
    const d = (await res.json()) as {
      teacher: { id: string; name: string };
      quizSets: { id: number; title: string }[];
      games: { roomCode: string }[];
      rooms: { code: string }[];
    };
    expect(d.teacher).toMatchObject({ id: plain, name: "박선생" });
    expect(d.quizSets).toHaveLength(2); // 가입할 때 깔린 샘플 + 올린 것
    expect(d.games).toHaveLength(1);
    expect(d.rooms.map((r) => r.code)).toContain(room);
  });

  it("없는 선생님은 404 다", async () => {
    expect((await get("/api/admin/teachers/00000000-0000-4000-8000-000000000000", bossCookie)).status).toBe(404);
  });
});

describe("남의 퀴즈 훑어보기", () => {
  it("앞 몇 문항만 보여 준다", async () => {
    await makeRoom(plainCookie);
    const id = (await env.DB.prepare("SELECT id FROM quiz_sets WHERE teacher_id = ?")
      .bind(plain)
      .first<{ id: number }>())!.id;

    const res = await get(`/api/admin/quizsets/${id}`, bossCookie);
    const d = (await res.json()) as {
      teacherId: string; itemCount: number; preview: { q: string }[];
    };
    expect(d.teacherId).toBe(plain);
    expect(d.preview.length).toBeLessThanOrEqual(5);
    expect(d.preview.length).toBeLessThan(d.itemCount);
    expect(d.preview[0]!.q).toBeTruthy();
  });

  it("보통 선생님은 남의 퀴즈를 이 길로 볼 수 없다", async () => {
    await makeRoom(plainCookie);
    const id = (await env.DB.prepare("SELECT id FROM quiz_sets WHERE teacher_id = ?")
      .bind(plain)
      .first<{ id: number }>())!.id;
    expect((await get(`/api/admin/quizsets/${id}`, plainCookie)).status).toBe(404);
  });
});

describe("기록 보관 기간", () => {
  it("60일이 지난 기록은 로그인할 때 사라진다", async () => {
    const room = await makeRoom(plainCookie);
    await playAndEnd(room, plainCookie);

    const old = Date.now() - 61 * 24 * 60 * 60 * 1000;
    await env.DB.prepare("UPDATE game_records SET ended_at = ?").bind(old).run();

    // 청소는 선생님이 들어오는 순간에 돈다.
    await loginAs("kimssam", "김선생");

    const { results } = await env.DB.prepare("SELECT id FROM game_records").all();
    expect(results).toHaveLength(0);
  });

  it("두 달 안쪽 기록은 남는다", async () => {
    const room = await makeRoom(plainCookie);
    await playAndEnd(room, plainCookie);

    const recent = Date.now() - 59 * 24 * 60 * 60 * 1000;
    await env.DB.prepare("UPDATE game_records SET ended_at = ?").bind(recent).run();

    // 청소는 선생님이 들어오는 순간에 돈다.
    await loginAs("kimssam", "김선생");

    const { results } = await env.DB.prepare("SELECT id FROM game_records").all();
    expect(results).toHaveLength(1);
  });
});
