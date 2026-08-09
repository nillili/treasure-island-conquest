import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const CODE = "테스트가입코드";

/** 브라우저 대신 쿠키를 손으로 들고 다닌다. 쿠키 규약 자체도 함께 확인하게 된다. */
async function post(path: string, body: unknown, cookie?: string) {
  return SELF.fetch(`https://t.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

function cookieOf(res: Response): string {
  const raw = res.headers.get("set-cookie") ?? "";
  return raw.split(";")[0] ?? "";
}

async function signup(id: string, name = "김선생", password = "pw1234") {
  const res = await post("/api/auth/signup", { code: CODE, id, name, password });
  return { res, cookie: cookieOf(res) };
}

/** 준비 단계로 쓰는 가입. 여기서 실패하면 바로 알려 준다 — 안 그러면 뒤에서 401 로만 보인다. */
async function signupOk(id: string, name?: string, password?: string) {
  const { res, cookie } = await signup(id, name, password);
  if (res.status !== 200) throw new Error(`가입 실패(${res.status}): ${await res.text()}`);
  return cookie;
}

describe("가입", () => {
  it("가입하면 바로 로그인된다", async () => {
    const { res, cookie } = await signup("teacher1");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, id: "teacher1", name: "김선생" });
    expect(cookie).toMatch(/^tsession=/);
    expect(res.headers.get("set-cookie")).toContain("HttpOnly");
  });

  it("가입 코드가 틀리면 거절한다", async () => {
    const res = await post("/api/auth/signup", {
      code: "틀린코드",
      id: "teacher2",
      name: "박선생",
      password: "pw1234",
    });
    expect(res.status).toBe(403);
  });

  it("같은 아이디로 두 번 가입할 수 없다", async () => {
    await signupOk("teacher3");
    const { res } = await signup("teacher3");
    expect(res.status).toBe(409);
  });

  it("아이디 규칙을 지키지 않으면 거절한다", async () => {
    for (const id of ["ab", "한글아이디", "with space", "a".repeat(21)]) {
      const res = await post("/api/auth/signup", { code: CODE, id, name: "이", password: "pw1234" });
      expect(res.status).toBe(400);
    }
  });

  it("비밀번호가 너무 짧으면 거절한다", async () => {
    const res = await post("/api/auth/signup", { code: CODE, id: "teacher4", name: "이", password: "1" });
    expect(res.status).toBe(400);
  });
});

describe("로그인", () => {
  it("맞는 비밀번호로 들어간다", async () => {
    await signupOk("login1", "최선생", "correct-horse");
    const res = await post("/api/auth/login", { id: "login1", password: "correct-horse" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, id: "login1", name: "최선생" });
  });

  it("틀린 비밀번호는 거절한다", async () => {
    await signupOk("login2", "최선생", "correct-horse");
    const res = await post("/api/auth/login", { id: "login2", password: "wrong" });
    expect(res.status).toBe(401);
  });

  it("없는 아이디는 거절한다", async () => {
    const res = await post("/api/auth/login", { id: "nobody", password: "pw1234" });
    expect(res.status).toBe(401);
  });
});

describe("세션", () => {
  it("쿠키가 있으면 내 정보가 나온다", async () => {
    const cookie = await signupOk("me001", "정선생");
    const res = await SELF.fetch("https://t.test/api/auth/me", { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "me001", name: "정선생" });
  });

  it("쿠키가 없으면 401 이다", async () => {
    const res = await SELF.fetch("https://t.test/api/auth/me");
    expect(res.status).toBe(401);
  });

  it("가짜 토큰은 통하지 않는다", async () => {
    const res = await SELF.fetch("https://t.test/api/auth/me", {
      headers: { cookie: "tsession=not-a-real-token" },
    });
    expect(res.status).toBe(401);
  });

  it("로그아웃하면 그 쿠키는 더 이상 통하지 않는다", async () => {
    const cookie = await signupOk("out1");
    expect((await SELF.fetch("https://t.test/api/auth/me", { headers: { cookie } })).status).toBe(200);

    await post("/api/auth/logout", {}, cookie);
    expect((await SELF.fetch("https://t.test/api/auth/me", { headers: { cookie } })).status).toBe(401);
  });

  it("한 선생님이 두 화면에서 각각 로그인할 수 있다", async () => {
    await signupOk("two1", "한선생", "pw1234");
    const a = cookieOf(await post("/api/auth/login", { id: "two1", password: "pw1234" }));
    const b = cookieOf(await post("/api/auth/login", { id: "two1", password: "pw1234" }));
    expect(a).not.toBe(b);
    for (const cookie of [a, b]) {
      expect((await SELF.fetch("https://t.test/api/auth/me", { headers: { cookie } })).status).toBe(200);
    }
  });
});
