import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import sampleCsv from "../../sample/퀴즈_샘플_v3.csv?raw";

const CODE = "테스트가입코드";
const BASE = "https://t.test";

async function signupOk(id: string, name = "선생") {
  const res = await SELF.fetch(`${BASE}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: CODE, id, name, password: "pw1234" }),
  });
  if (res.status !== 200) throw new Error(`가입 실패: ${await res.text()}`);
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
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

beforeEach(async () => {
  bossCookie = await signupOk("kimssam", "김선생");
  plainCookie = await signupOk("parkssam", "박선생");
  await makeSuper("kimssam");
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
    await env.DB.prepare("UPDATE teachers SET is_super = 0 WHERE id = ?").bind("kimssam").run();
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
    expect(await res.json()).toMatchObject({ id: "kimssam", isSuper: true });
  });

  it("보통 선생님은 거짓이다", async () => {
    const res = await SELF.fetch(`${BASE}/api/auth/me`, { headers: { cookie: plainCookie } });
    expect(await res.json()).toMatchObject({ id: "parkssam", isSuper: false });
  });
});

describe("관제 첫 화면", () => {
  it("모든 선생님이 보인다 — 남의 것까지", async () => {
    const d = (await (await get("/api/admin/overview", bossCookie)).json()) as Overview;
    expect(d.teachers.map((t) => t.id).sort()).toEqual(["kimssam", "parkssam"]);
    expect(d.teachers.find((t) => t.id === "kimssam")!.isSuper).toBe(true);
  });

  it("남이 연 방도 보인다", async () => {
    const room = await makeRoom(plainCookie);
    const d = (await (await get("/api/admin/overview", bossCookie)).json()) as Overview;
    const found = d.openRooms.find((r) => r.code === room);
    expect(found).toBeTruthy();
    expect(found!.teacherId).toBe("parkssam");
  });

  it("퀴즈 수를 선생님별로 센다", async () => {
    await makeRoom(plainCookie);
    const d = (await (await get("/api/admin/overview", bossCookie)).json()) as Overview;
    // 가입할 때 샘플 퀴즈가 한 개 깔린다(seedSampleQuiz). 올린 것 하나가 그 위에 더해진다.
    expect(d.teachers.find((t) => t.id === "parkssam")!.quizCount).toBe(2);
    expect(d.teachers.find((t) => t.id === "kimssam")!.quizCount).toBe(1);
  });
});

describe("지난 수업 기록", () => {
  it("게임이 끝나면 한 줄이 남는다", async () => {
    const room = await makeRoom(plainCookie);
    await playAndEnd(room, plainCookie);

    const d = (await (await get("/api/admin/overview", bossCookie)).json()) as Overview;
    expect(d.recentGames).toHaveLength(1);
    expect(d.recentGames[0]).toMatchObject({ roomCode: room, teacherId: "parkssam", playerCount: 2 });
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

    const res = await get("/api/admin/teachers/parkssam", bossCookie);
    const d = (await res.json()) as {
      teacher: { id: string; name: string };
      quizSets: { id: number; title: string }[];
      games: { roomCode: string }[];
      rooms: { code: string }[];
    };
    expect(d.teacher).toMatchObject({ id: "parkssam", name: "박선생" });
    expect(d.quizSets).toHaveLength(2); // 가입할 때 깔린 샘플 + 올린 것
    expect(d.games).toHaveLength(1);
    expect(d.rooms.map((r) => r.code)).toContain(room);
  });

  it("없는 선생님은 404 다", async () => {
    expect((await get("/api/admin/teachers/nobody00", bossCookie)).status).toBe(404);
  });
});

describe("남의 퀴즈 훑어보기", () => {
  it("앞 몇 문항만 보여 준다", async () => {
    await makeRoom(plainCookie);
    const id = (await env.DB.prepare("SELECT id FROM quiz_sets WHERE teacher_id = ?")
      .bind("parkssam")
      .first<{ id: number }>())!.id;

    const res = await get(`/api/admin/quizsets/${id}`, bossCookie);
    const d = (await res.json()) as {
      teacherId: string; itemCount: number; preview: { q: string }[];
    };
    expect(d.teacherId).toBe("parkssam");
    expect(d.preview.length).toBeLessThanOrEqual(5);
    expect(d.preview.length).toBeLessThan(d.itemCount);
    expect(d.preview[0]!.q).toBeTruthy();
  });

  it("보통 선생님은 남의 퀴즈를 이 길로 볼 수 없다", async () => {
    await makeRoom(plainCookie);
    const id = (await env.DB.prepare("SELECT id FROM quiz_sets WHERE teacher_id = ?")
      .bind("parkssam")
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

    await SELF.fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "kimssam", password: "pw1234" }),
    });

    const { results } = await env.DB.prepare("SELECT id FROM game_records").all();
    expect(results).toHaveLength(0);
  });

  it("두 달 안쪽 기록은 남는다", async () => {
    const room = await makeRoom(plainCookie);
    await playAndEnd(room, plainCookie);

    const recent = Date.now() - 59 * 24 * 60 * 60 * 1000;
    await env.DB.prepare("UPDATE game_records SET ended_at = ?").bind(recent).run();

    await SELF.fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "kimssam", password: "pw1234" }),
    });

    const { results } = await env.DB.prepare("SELECT id FROM game_records").all();
    expect(results).toHaveLength(1);
  });
});

/**
 * 비밀번호 재설정 — 관제에서 유일하게 남의 것을 바꾸는 길이다.
 * 그래서 "누가 부를 수 있나" 를 가장 촘촘히 지킨다.
 */
describe("비밀번호 재설정", () => {
  const reset = (id: string, cookie?: string, body: Record<string, unknown> = {}) =>
    SELF.fetch(`${BASE}/api/admin/teachers/${id}/password`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });

  const login = (id: string, password: string) =>
    SELF.fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, password }),
    });

  it("슈퍼가 아니면 있는 줄도 모른다 (403 이 아니라 404)", async () => {
    const res = await reset("parkssam", plainCookie);
    expect(res.status).toBe(404);
  });

  it("로그인도 안 했으면 401", async () => {
    const res = await reset("parkssam");
    expect(res.status).toBe(401);
  });

  it("GET 으로는 부를 수 없다", async () => {
    const res = await get("/api/admin/teachers/parkssam/password", bossCookie);
    expect(res.status).toBe(405);
  });

  it("임시 비밀번호를 지어 주고, 그것으로 실제 로그인이 된다", async () => {
    const res = await reset("parkssam", bossCookie);
    expect(res.status).toBe(200);
    const out = (await res.json()) as { password: string; signedOut: boolean };
    expect(out.password.length).toBeGreaterThanOrEqual(8);
    expect(out.signedOut).toBe(true);

    expect((await login("parkssam", out.password)).status).toBe(200);
    expect((await login("parkssam", "pw1234")).status).toBe(401); // 옛 비밀번호는 죽는다
  });

  it("원하는 비밀번호를 직접 정해 줄 수도 있다", async () => {
    const res = await reset("parkssam", bossCookie, { password: "새비밀번호99" });
    expect(res.status).toBe(200);
    expect((await login("parkssam", "새비밀번호99")).status).toBe(200);
  });

  it("너무 짧은 비밀번호는 거절한다", async () => {
    const res = await reset("parkssam", bossCookie, { password: "12" });
    expect(res.status).toBe(400);
    expect((await login("parkssam", "pw1234")).status).toBe(200); // 안 바뀌었다
  });

  it("없는 선생님이면 404", async () => {
    const res = await reset("nobodyhere", bossCookie);
    expect(res.status).toBe(404);
  });

  it("바꾸면 그 선생님의 열린 세션이 끊긴다", async () => {
    const before = await get("/api/quizsets", plainCookie);
    expect(before.status).toBe(200); // 아직 살아 있다

    await reset("parkssam", bossCookie);

    const after = await get("/api/quizsets", plainCookie);
    expect(after.status).toBe(401); // 옛 쿠키로는 못 들어온다
  });
});

