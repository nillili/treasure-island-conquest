import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import sampleCsv from "../../sample/퀴즈_샘플_v3.csv?raw";

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

function xlsxBytes(): ArrayBuffer {
  const bin = atob(env.FIXTURE_XLSX);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

async function upload(cookie: string, title: string, file: File, overwrite = false) {
  const form = new FormData();
  form.set("title", title);
  form.set("file", file);
  if (overwrite) form.set("overwrite", "true");
  return SELF.fetch(`${BASE}/api/quizsets`, { method: "POST", headers: { cookie }, body: form });
}

const csvFile = (name = "퀴즈.csv") => new File([sampleCsv], name, { type: "text/csv" });
const xlsxFile = () => new File([xlsxBytes()], "보물섬점령전_DB.xlsx");

const get = (cookie: string, path: string, init: RequestInit = {}) =>
  SELF.fetch(`${BASE}${path}`, { ...init, headers: { cookie, ...(init.headers ?? {}) } });

let cookie = "";

beforeEach(async () => {
  cookie = await signupOk("owner1");
});

/** 보관함에 있는 이름들. 가입할 때 들어가는 샘플이 늘 하나 있다. */
async function titles(who = cookie): Promise<string[]> {
  const body = (await (await get(who, "/api/quizsets")).json()) as { sets: { title: string }[] };
  return body.sets.map((s) => s.title);
}
const SAMPLE = "상식1(샘플)";

describe("가입 선물", () => {
  it("가입하면 상식 샘플 한 벌이 보관함에 들어 있다", async () => {
    expect(await titles()).toEqual([SAMPLE]);
    const id = ((await (await get(cookie, "/api/quizsets")).json()) as { sets: { id: number }[] }).sets[0]!.id;
    const preview = (await (await get(cookie, `/api/quizsets/${id}`)).json()) as { itemCount: number };
    expect(preview.itemCount).toBe(50);
  });

  it("샘플 파일은 내려받을 수 있다", async () => {
    const res = await SELF.fetch(`${BASE}/sample-quiz.csv`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("질문,정답");
  });
});

describe("업로드", () => {
  it("CSV 를 올리면 보관함에 들어간다", async () => {
    const res = await upload(cookie, "국어1", csvFile());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, title: "국어1", itemCount: 50, skipped: 0 });
  });

  it("엑셀도 그대로 올라간다", async () => {
    const res = await upload(cookie, "사회1", xlsxFile());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, itemCount: 50 });
  });

  it("목록에 최근 것이 먼저 나온다", async () => {
    await upload(cookie, "국어1", csvFile());
    await upload(cookie, "사회1", xlsxFile());

    const body = (await (await get(cookie, "/api/quizsets")).json()) as {
      sets: { title: string; itemCount: number }[];
    };
    expect(body.sets.map((s) => s.title)).toEqual(["사회1", "국어1", SAMPLE]);
    expect(body.sets[0]!.itemCount).toBe(50);
  });

  it("같은 이름은 물어본 뒤에만 덮어쓴다", async () => {
    await upload(cookie, "국어1", csvFile());

    const blocked = await upload(cookie, "국어1", csvFile());
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ code: "duplicate-title" });

    const ok = await upload(cookie, "국어1", csvFile("다시.csv"), true);
    expect(ok.status).toBe(200);

    // 덮어썼으니 '국어1' 은 여전히 하나다(샘플은 따로 있다)
    expect((await titles()).filter((t) => t === "국어1")).toHaveLength(1);
  });

  it("이름이 없거나 너무 길면 거절한다", async () => {
    expect((await upload(cookie, "", csvFile())).status).toBe(400);
    expect((await upload(cookie, "가".repeat(21), csvFile())).status).toBe(400);
  });

  it("읽을 문항이 하나도 없으면 이유와 함께 거절한다", async () => {
    const bad = new File(["질문,정답,예제1,예제2\n질문?,,가,나\n"], "빈.csv");
    const res = await upload(cookie, "빈퀴즈", bad);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { problems: string[] };
    expect(body.problems[0]).toContain("2행");
  });

  it("80문항을 넘기면 건너뛴 수를 알려 준다", async () => {
    const rows = ["질문,정답,예제1,예제2"];
    for (let i = 0; i < 100; i++) rows.push(`Q${i},1,가,나`);
    const res = await upload(cookie, "많은퀴즈", new File([rows.join("\n")], "많음.csv"));
    expect(await res.json()).toMatchObject({ itemCount: 80, skipped: 20 });
  });
});

describe("미리보기 · 이름 바꾸기 · 삭제", () => {
  async function makeSet(title = "국어1") {
    const res = await upload(cookie, title, csvFile());
    return ((await res.json()) as { id: number }).id;
  }

  it("앞 5문항과 건너뛴 안내를 보여 준다", async () => {
    const id = await makeSet();
    const body = (await (await get(cookie, `/api/quizsets/${id}`)).json()) as {
      title: string;
      itemCount: number;
      preview: { q: string; options: string[]; ans: number }[];
    };
    expect(body.title).toBe("국어1");
    expect(body.itemCount).toBe(50);
    expect(body.preview).toHaveLength(5);
    expect(body.preview[0]).toEqual({
      q: "고조선을 세운 인물은 누구인가요?",
      options: ["단군왕검", "온조", "박혁거세", "주몽"],
      ans: 0,
    });
  });

  it("이름을 바꾼다", async () => {
    const id = await makeSet();
    const res = await get(cookie, `/api/quizsets/${id}/title`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "국어-1학기" }),
    });
    expect(res.status).toBe(200);

    const body = (await (await get(cookie, "/api/quizsets")).json()) as { sets: { title: string }[] };
    expect(body.sets[0]!.title).toBe("국어-1학기");
  });

  it("이미 있는 이름으로는 못 바꾼다", async () => {
    await makeSet("국어1");
    const id = await makeSet("사회1");
    const res = await get(cookie, `/api/quizsets/${id}/title`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "국어1" }),
    });
    expect(res.status).toBe(409);
  });

  it("삭제하면 목록에서 사라진다", async () => {
    const id = await makeSet();
    expect((await get(cookie, `/api/quizsets/${id}`, { method: "DELETE" })).status).toBe(200);
    expect(await titles()).not.toContain("국어1");
  });

  it("없는 퀴즈를 건드리면 404 다", async () => {
    expect((await get(cookie, "/api/quizsets/99999")).status).toBe(404);
    expect((await get(cookie, "/api/quizsets/99999", { method: "DELETE" })).status).toBe(404);
  });
});

describe("남의 퀴즈는 손댈 수 없다", () => {
  it("목록·미리보기·이름변경·삭제가 전부 막힌다", async () => {
    const mine = await upload(cookie, "국어1", csvFile());
    const id = ((await mine.json()) as { id: number }).id;

    const other = await signupOk("other1");

    // 남의 목록에는 안 보인다 (자기 샘플만 있다)
    expect(await titles(other)).toEqual([SAMPLE]);

    // 아이디를 알아도 열리지 않는다
    expect((await get(other, `/api/quizsets/${id}`)).status).toBe(404);
    expect(
      (
        await get(other, `/api/quizsets/${id}/title`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "가로채기" }),
        })
      ).status,
    ).toBe(404);
    expect((await get(other, `/api/quizsets/${id}`, { method: "DELETE" })).status).toBe(404);

    // 원래 주인에게는 그대로 남아 있다
    const still = (await (await get(cookie, `/api/quizsets/${id}`)).json()) as { title: string };
    expect(still.title).toBe("국어1");
  });

  it("같은 이름을 서로 다른 선생님이 각자 쓸 수 있다", async () => {
    await upload(cookie, "국어1", csvFile());
    const other = await signupOk("other2");
    const res = await upload(other, "국어1", csvFile());
    expect(res.status).toBe(200);
  });
});

describe("로그인 없이는 아무것도 못 한다", () => {
  it("보관함 전체가 401 이다", async () => {
    expect((await SELF.fetch(`${BASE}/api/quizsets`)).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/api/quizsets/1`)).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/api/quizsets/1`, { method: "DELETE" })).status).toBe(401);
  });
});
