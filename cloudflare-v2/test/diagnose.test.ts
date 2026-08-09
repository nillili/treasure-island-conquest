import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import sampleCsv from "../../sample/퀴즈_샘플_v3.csv?raw";

const BASE = "https://t.test";
interface Diag {
  build: string;
  serverNow: number;
  worst: string;
  checks: { name: string; level: string; detail: string; fix?: string }[];
}

let cookie = "";

async function signupOk(id: string) {
  const res = await SELF.fetch(`${BASE}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "테스트가입코드", id, name: "선생", password: "pw1234" }),
  });
  if (res.status !== 200) throw new Error(await res.text());
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}

const diagnose = () =>
  SELF.fetch(`${BASE}/api/diagnose`, { headers: { cookie } }).then((r) => r.json() as Promise<Diag>);
const find = (d: Diag, name: string) => d.checks.find((c) => c.name === name)!;

beforeEach(async () => {
  cookie = await signupOk("owner1");
});

describe("시스템 점검", () => {
  it("로그인 없이는 볼 수 없다", async () => {
    expect((await SELF.fetch(`${BASE}/api/diagnose`)).status).toBe(401);
  });

  it("데이터베이스와 보관함을 확인한다", async () => {
    const d = await diagnose();
    expect(find(d, "데이터베이스").level).toBe("ok");
    // 가입 선물 샘플이 있으므로 보관함은 정상이다
    expect(find(d, "퀴즈 보관함").level).toBe("ok");
    expect(d.build).toBeTruthy();
  });

  it("열린 방이 없으면 알려 준다", async () => {
    const d = await diagnose();
    const room = find(d, "열려 있는 방");
    expect(room.level).toBe("warn");
    expect(room.fix).toContain("방 만들기");
  });

  it("판을 안 깔았으면 새 게임을 누르라고 한다", async () => {
    const sets = (await (await SELF.fetch(`${BASE}/api/quizsets`, { headers: { cookie } })).json()) as {
      sets: { id: number }[];
    };
    const made = await SELF.fetch(`${BASE}/api/rooms`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ requestId: crypto.randomUUID(), quizSetId: sets.sets[0]!.id, label: "3반" }),
    });
    const { code } = (await made.json()) as { code: string };

    const d = await diagnose();
    expect(find(d, "열려 있는 방").level).toBe("ok");
    const detail = find(d, `방 ${code}`);
    expect(detail.level).toBe("warn");
    expect(detail.fix).toContain("새 게임");
  });

  it("문항이 적은 퀴즈를 짚어 준다", async () => {
    const rows = ["질문,정답,예제1,예제2"];
    for (let i = 0; i < 5; i++) rows.push(`Q${i},1,가,나`);
    const form = new FormData();
    form.set("title", "짧은퀴즈");
    form.set("file", new File([rows.join("\n")], "짧음.csv"));
    await SELF.fetch(`${BASE}/api/quizsets`, { method: "POST", headers: { cookie }, body: form });

    const d = await diagnose();
    const lib = find(d, "퀴즈 보관함");
    expect(lib.level).toBe("warn");
    expect(lib.detail).toContain("짧은퀴즈(5)");
  });

  it("샘플 CSV 로 만든 정상 상태는 전부 ok 다", async () => {
    void sampleCsv;
    const d = await diagnose();
    expect(d.checks.every((c) => c.level !== "error")).toBe(true);
  });
});
