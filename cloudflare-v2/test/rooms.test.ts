import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import sampleCsv from "../../sample/퀴즈_샘플_v3.csv?raw";
import { startOfTodayKST } from "../src/sweep";

const CODE = "테스트가입코드";
const BASE = "https://t.test";

async function signupOk(id: string) {
  const res = await SELF.fetch(`${BASE}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: CODE, id, name: "선생", password: "pw1234" }),
  });
  if (res.status !== 200) throw new Error(`가입 실패(${res.status}): ${await res.text()}`);
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}

async function uploadQuiz(cookie: string, title: string) {
  const form = new FormData();
  form.set("title", title);
  form.set("file", new File([sampleCsv], "퀴즈.csv", { type: "text/csv" }));
  const res = await SELF.fetch(`${BASE}/api/quizsets`, { method: "POST", headers: { cookie }, body: form });
  if (res.status !== 200) throw new Error(`업로드 실패: ${await res.text()}`);
  return ((await res.json()) as { id: number }).id;
}

function makeRoom(cookie: string, body: Record<string, unknown>) {
  return SELF.fetch(`${BASE}/api/rooms`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

let cookie = "";
let quizId = 0;

beforeEach(async () => {
  cookie = await signupOk("owner1");
  quizId = await uploadQuiz(cookie, "국어1");
});

describe("방 개설", () => {
  it("방번호 4자리와 퀴즈 제목이 나온다", async () => {
    const res = await makeRoom(cookie, { requestId: crypto.randomUUID(), quizSetId: quizId, label: "3학년 2반" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: string; quizTitle: string; quizCount: number };
    expect(body.code).toMatch(/^\d{4}$/);
    expect(body.quizTitle).toBe("국어1");
    expect(body.quizCount).toBe(50);
  });

  it("같은 요청 번호로 두 번 눌러도 방은 하나다", async () => {
    const requestId = crypto.randomUUID();
    const a = (await (await makeRoom(cookie, { requestId, quizSetId: quizId })).json()) as { code: string };
    const b = (await (await makeRoom(cookie, { requestId, quizSetId: quizId })).json()) as {
      code: string;
      reused: boolean;
    };
    expect(b.code).toBe(a.code);
    expect(b.reused).toBe(true);

    const mine = (await (await SELF.fetch(`${BASE}/api/rooms/mine`, { headers: { cookie } })).json()) as {
      rooms: unknown[];
    };
    expect(mine.rooms).toHaveLength(1);
  });

  it("요청 번호가 다르면 방이 따로 생긴다", async () => {
    const a = (await (await makeRoom(cookie, { requestId: crypto.randomUUID(), quizSetId: quizId })).json()) as { code: string };
    const b = (await (await makeRoom(cookie, { requestId: crypto.randomUUID(), quizSetId: quizId })).json()) as { code: string };
    expect(a.code).not.toBe(b.code);
  });

  // 방 8개는 곧 Durable Object 8개다. 로컬 흉내 런타임에서는 이것만 몇 초가 걸린다.
  // (실서버에서는 문제가 안 되지만, 기본 5초 제한에 걸려 가끔 헛되이 실패했다.)
  it("여러 방을 동시에 만들어도 번호가 겹치지 않는다", { timeout: 30_000 }, async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => makeRoom(cookie, { requestId: crypto.randomUUID(), quizSetId: quizId })),
    );
    const codes: string[] = [];
    for (const r of results) {
      expect(r.status).toBe(200);
      codes.push(((await r.json()) as { code: string }).code);
    }
    expect(new Set(codes).size).toBe(8);
  });

  it("퀴즈를 안 고르면 거절한다", async () => {
    const res = await makeRoom(cookie, { requestId: crypto.randomUUID() });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("퀴즈를 하나");
  });

  it("판 크기가 10~15 밖이면 거절한다", async () => {
    for (const size of [9, 16]) {
      const res = await makeRoom(cookie, { requestId: crypto.randomUUID(), quizSetId: quizId, rows: size, cols: 12 });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("10×10");
    }
  });

  it("10×10 과 15×15 는 받는다", async () => {
    for (const size of [10, 15]) {
      const res = await makeRoom(cookie, { requestId: crypto.randomUUID(), quizSetId: quizId, rows: size, cols: size });
      expect(res.status).toBe(200);
    }
  });

  it("턴 시간·라운드가 범위 밖이면 거절한다", async () => {
    const bad = [{ turnSeconds: 5 }, { turnSeconds: 400 }, { roundLimit: 0 }, { roundLimit: 99 }];
    for (const extra of bad) {
      const res = await makeRoom(cookie, { requestId: crypto.randomUUID(), quizSetId: quizId, ...extra });
      expect(res.status).toBe(400);
    }
  });

  it("남의 퀴즈로는 방을 못 만든다", async () => {
    const other = await signupOk("other1");
    const res = await makeRoom(other, { requestId: crypto.randomUUID(), quizSetId: quizId });
    expect(res.status).toBe(404);

    // 반쪽 방이 남지 않았는지
    const mine = (await (await SELF.fetch(`${BASE}/api/rooms/mine`, { headers: { cookie: other } })).json()) as {
      rooms: unknown[];
    };
    expect(mine.rooms).toHaveLength(0);
  });

  it("로그인 없이는 못 만든다", async () => {
    const res = await SELF.fetch(`${BASE}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: crypto.randomUUID(), quizSetId: quizId }),
    });
    expect(res.status).toBe(401);
  });
});

describe("방 확인 (학생용)", () => {
  it("만든 방은 로그인 없이 확인된다", async () => {
    const { code } = (await (
      await makeRoom(cookie, { requestId: crypto.randomUUID(), quizSetId: quizId, label: "3학년 2반" })
    ).json()) as { code: string };

    const res = await SELF.fetch(`${BASE}/api/rooms/${code}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      exists: true,
      code,
      label: "3학년 2반",
      quizTitle: "국어1",
      status: "waiting",
      playerCount: 0,
    });
  });

  it("없는 번호는 404 이고, 유령 방이 생기지 않는다", async () => {
    // getByName() 은 없는 방이어도 DO 를 만들어 낸다. 그래서 존재 확인은 D1 만 본다.
    // 아이가 아무 번호나 여러 번 쳐도 방 목록이 늘어나면 안 된다.
    for (const guess of ["1000", "9999", "5555"]) {
      expect((await SELF.fetch(`${BASE}/api/rooms/${guess}`)).status).toBe(404);
    }
    const mine = (await (await SELF.fetch(`${BASE}/api/rooms/mine`, { headers: { cookie } })).json()) as {
      rooms: unknown[];
    };
    expect(mine.rooms).toHaveLength(0);
  });
});

describe("내 방 목록", () => {
  it("내가 만든 방만 보인다", async () => {
    await makeRoom(cookie, { requestId: crypto.randomUUID(), quizSetId: quizId, label: "3반" });

    const other = await signupOk("other2");
    const mineList = (await (await SELF.fetch(`${BASE}/api/rooms/mine`, { headers: { cookie } })).json()) as {
      rooms: { label: string }[];
    };
    const otherList = (await (await SELF.fetch(`${BASE}/api/rooms/mine`, { headers: { cookie: other } })).json()) as {
      rooms: unknown[];
    };
    expect(mineList.rooms).toHaveLength(1);
    expect(mineList.rooms[0]!.label).toBe("3반");
    expect(otherList.rooms).toHaveLength(0);
  });
});

describe("퀴즈 사본", () => {
  it("보관함에서 퀴즈를 지워도 방은 제 문항을 그대로 들고 있다", async () => {
    const { code } = (await (
      await makeRoom(cookie, { requestId: crypto.randomUUID(), quizSetId: quizId })
    ).json()) as { code: string };

    const del = await SELF.fetch(`${BASE}/api/quizsets/${quizId}`, { method: "DELETE", headers: { cookie } });
    expect(del.status).toBe(200);
    expect(await del.json()).toMatchObject({ usedByRooms: [code] });

    // 방은 멀쩡하다. 제목도 남아 있다.
    const res = await SELF.fetch(`${BASE}/api/rooms/${code}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ quizTitle: "국어1" });
    expect(await env.ROOM.getByName(code).quizCount()).toBe(50);
  });
});

/**
 * 어제 방 자동 청소.
 *
 * 상주하는 데몬이 없어서 **선생님이 들어오는 순간이 유일한 청소 기회**다.
 * 그래서 "누가 들어왔을 때 실제로 치워졌는가"를 확인한다.
 */
describe("어제 방 자동 청소", () => {
  const login = (id: string) =>
    SELF.fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, password: "pw1234" }),
    });

  /** 방을 하나 만들고 방번호를 돌려준다. */
  async function openRoom(who: string) {
    const c = await signupOk(who);
    const q = await uploadQuiz(c, `퀴즈_${who}`);
    const res = await makeRoom(c, { requestId: crypto.randomUUID(), quizSetId: q });
    return { cookie: c, code: ((await res.json()) as { code: string }).code };
  }

  /** D1 의 created_at 을 과거로 돌린다. 하루를 실제로 기다릴 수는 없다. */
  const backdate = (code: string, at: number) =>
    env.DB.prepare("UPDATE rooms SET created_at = ? WHERE code = ?").bind(at, code).run();

  const statusOf = (code: string) =>
    env.DB.prepare("SELECT status FROM rooms WHERE code = ?")
      .bind(code)
      .first<{ status: string }>()
      .then((r) => r?.status);

  it("한국 시각 오늘 0시를 기준으로 삼는다", () => {
    // 한국 0시 정각과 그 1분 뒤는 같은 날이어야 한다(전날로 밀리면 멀쩡한 방이 닫힌다).
    const kstMidnight = Date.UTC(2026, 7, 9, 15, 0, 0); // = 2026-08-10 00:00 KST
    expect(startOfTodayKST(kstMidnight)).toBe(kstMidnight);
    expect(startOfTodayKST(kstMidnight + 60_000)).toBe(kstMidnight);
    // 1초 전은 전날이다
    expect(startOfTodayKST(kstMidnight - 1000)).toBe(kstMidnight - 86_400_000);
  });

  it("어제 만든 방은 로그인하는 순간 닫힌다", async () => {
    const { code } = await openRoom("sweep1");
    await backdate(code, startOfTodayKST() - 1000); // 어제 23:59:59
    expect(await statusOf(code)).toBe("ready");

    await login("sweep1");

    expect(await statusOf(code)).toBe("closed");
    expect((await SELF.fetch(`${BASE}/api/rooms/${code}`)).status).toBe(404);
  });

  it("오늘 만든 방은 건드리지 않는다", async () => {
    const { code } = await openRoom("sweep2");
    await backdate(code, startOfTodayKST() + 1000); // 오늘 00:00:01
    await login("sweep2");
    expect(await statusOf(code)).toBe("ready");
  });

  it("만든 사람이 누구든 상관없이 닫는다", async () => {
    const { code } = await openRoom("sweep3");
    await backdate(code, startOfTodayKST() - 1000);

    await signupOk("sweep4"); // 다른 선생님이 들어와도 치워진다
    expect(await statusOf(code)).toBe("closed");
  });

  it("선생님 홈을 열 때도 치운다", async () => {
    const { cookie: c, code } = await openRoom("sweep5");
    await backdate(code, startOfTodayKST() - 1000);

    await SELF.fetch(`${BASE}/api/rooms/mine`, { headers: { cookie: c } });
    expect(await statusOf(code)).toBe("closed");
  });

  it("방 안에 있던 학생은 다시 붙을 수 없다", async () => {
    const { code } = await openRoom("sweep6");
    const rpc = (body: unknown) =>
      SELF.fetch(`${BASE}/api/rooms/${code}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await rpc({ t: "hello", role: "student", name: "민수" })).status).toBe(200);

    await backdate(code, startOfTodayKST() - 1000);
    await login("sweep6");

    // 방이 통째로 사라졌으니 같은 번호로 다시 들어올 수도 없다.
    const again = (await (await rpc({ t: "hello", role: "student", name: "민수" })).json()) as { code?: string };
    expect(again.code).toBe("no-room");
  });
});
