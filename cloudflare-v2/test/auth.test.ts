import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BASE, codeFor, fakeTeacher, login, loginOk, otherTeacher } from "./sso";

async function me(cookie: string) {
  return SELF.fetch(`${BASE}/api/auth/me`, { headers: { cookie } });
}

function setCookies(res: Response): string[] {
  return res.headers.getSetCookie();
}

describe("네오버스로 들어가기", () => {
  it("승인된 선생님은 들어와 프로필이 생긴다", async () => {
    const { res, cookie } = await login(fakeTeacher({ name: "김선생" }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?teacher=1");
    expect(cookie).toMatch(/^tsession=/);

    const who = await me(cookie);
    expect(who.status).toBe(200);
    expect(await who.json()).toMatchObject({ ok: true, name: "김선생", isSuper: false });
  });

  it("주소창에 인가 코드를 남기지 않는다", async () => {
    const { res } = await login(fakeTeacher());
    expect(res.headers.get("location")).not.toContain("code=");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("두 번 들어와도 선생님은 하나다", async () => {
    await loginOk(fakeTeacher());
    await loginOk(fakeTeacher({ name: "김선생님" }));
    const rows = await env.DB.prepare("SELECT id, display_name FROM teachers").all<{ display_name: string }>();
    expect(rows.results).toHaveLength(1);
    // 네오버스에서 이름을 바꾸면 이쪽도 따라간다.
    expect(rows.results[0]!.display_name).toBe("김선생님");
  });

  it("처음 들어온 선생님에게는 샘플 퀴즈가 하나 생긴다", async () => {
    await loginOk(fakeTeacher());
    await loginOk(fakeTeacher()); // 두 번째부터는 늘어나지 않는다
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM quiz_sets").first<{ n: number }>();
    expect(count!.n).toBe(1);
  });

  it("클래스 관리 선생님(school_admin)도 들어온다", async () => {
    const { cookie } = await login(fakeTeacher({ user_type: "school_admin" }));
    expect(cookie).not.toBe("");
    expect(await (await me(cookie)).json()).toMatchObject({ isSuper: false });
  });
});

describe("최고관리자 승계", () => {
  it("네오버스 admin 은 보물섬에서도 최고관리자다", async () => {
    const cookie = await loginOk(fakeTeacher({ user_type: "admin", name: "운영자" }));
    expect(await (await me(cookie)).json()).toMatchObject({ isSuper: true });
  });

  it("보통 선생님은 아니다", async () => {
    const cookie = await loginOk(fakeTeacher());
    expect(await (await me(cookie)).json()).toMatchObject({ isSuper: false });
  });
});

describe("들여보내지 않는 사람", () => {
  it("학생은 거절한다", async () => {
    const { res, cookie } = await login(fakeTeacher({ user_type: "학생" }));
    expect(res.status).toBe(403);
    expect(cookie).toBe("");
  });

  it("승인 대기 중인 선생님은 거절한다", async () => {
    const { res, cookie } = await login(fakeTeacher({ approval_status: "pending" }));
    expect(res.status).toBe(403);
    expect(cookie).toBe("");
  });

  it("모르는 계정 유형은 거절한다", async () => {
    const { res } = await login(fakeTeacher({ user_type: "teacher" })); // 영문 teacher 는 없는 값이다
    expect(res.status).toBe(403);
  });

  it("거절당한 사람의 프로필·퀴즈·세션은 만들어지지 않는다", async () => {
    await login(fakeTeacher({ user_type: "학생" }));
    for (const table of ["teachers", "quiz_sets", "sessions"]) {
      const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
      expect(n!.n, table).toBe(0);
    }
  });
});

describe("로그인 왕복의 규칙", () => {
  it("state 가 다르면 거절한다", async () => {
    const start = await SELF.fetch(`${BASE}/auth/start`, { redirect: "manual" });
    const tx = setCookies(start)[0]!.split(";")[0]!;
    const res = await SELF.fetch(
      `${BASE}/auth/callback?code=${encodeURIComponent(codeFor(fakeTeacher()))}&state=엉뚱한값`,
      { headers: { cookie: tx }, redirect: "manual" },
    );
    expect(res.status).toBe(400);
  });

  it("같은 콜백을 두 번 쓰지 못한다", async () => {
    const start = await SELF.fetch(`${BASE}/auth/start`, { redirect: "manual" });
    const tx = setCookies(start)[0]!.split(";")[0]!;
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const url = `${BASE}/auth/callback?code=${encodeURIComponent(codeFor(fakeTeacher()))}&state=${encodeURIComponent(state)}`;
    expect((await SELF.fetch(url, { headers: { cookie: tx }, redirect: "manual" })).status).toBe(302);
    expect((await SELF.fetch(url, { headers: { cookie: tx }, redirect: "manual" })).status).toBe(400);
  });

  it("로그인 중 쿠키가 없으면 거절한다", async () => {
    const start = await SELF.fetch(`${BASE}/auth/start`, { redirect: "manual" });
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const res = await SELF.fetch(
      `${BASE}/auth/callback?code=${encodeURIComponent(codeFor(fakeTeacher()))}&state=${encodeURIComponent(state)}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(400);
  });

  it("인가 화면으로 보낼 때 verifier 가 아니라 해시만 붙인다", async () => {
    const start = await SELF.fetch(`${BASE}/auth/start`, { redirect: "manual" });
    const to = new URL(start.headers.get("location")!);
    expect(to.origin).toBe("https://neobus.test");
    expect(to.pathname).toBe("/merge/authorize");
    expect(to.searchParams.get("code_challenge_method")).toBe("S256");
    expect(to.searchParams.get("code_challenge")).toHaveLength(43);
    expect(to.search).not.toContain("verifier");
    const tx = await env.DB.prepare("SELECT verifier FROM login_tx").first<{ verifier: string }>();
    expect(start.headers.get("set-cookie")).not.toContain(tx!.verifier);
  });

  it("코드를 바꾸지 못하면 들어가지 못한다", async () => {
    const { res, cookie } = await login("엉뚱한코드");
    expect(res.status).toBe(502);
    expect(cookie).toBe("");
  });
});

describe("세션", () => {
  it("쿠키가 없으면 401", async () => {
    expect((await SELF.fetch(`${BASE}/api/auth/me`)).status).toBe(401);
  });

  it("브라우저에는 연결 토큰이 나가지 않는다", async () => {
    const cookie = await loginOk(fakeTeacher());
    const row = await env.DB.prepare("SELECT token_hash, link_token FROM sessions").first<{
      token_hash: string;
      link_token: string;
    }>();
    // 쿠키 값 원문은 DB 에 없다. 해시만 있다.
    expect(cookie).not.toContain(row!.token_hash);
    expect(cookie).not.toContain(row!.link_token);
  });

  it("로그아웃하면 그 자리에서 끊긴다", async () => {
    const cookie = await loginOk(fakeTeacher());
    const out = await SELF.fetch(`${BASE}/api/auth/logout`, { method: "POST", headers: { cookie } });
    expect(out.status).toBe(200);
    expect((await me(cookie)).status).toBe(401);
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>();
    expect(left!.n).toBe(0);
  });

  it("두 번 들어오면 세션이 둘 다 산다", async () => {
    const a = await loginOk(fakeTeacher());
    const b = await loginOk(fakeTeacher());
    expect(a).not.toBe(b);
    expect((await me(a)).status).toBe(200);
    expect((await me(b)).status).toBe(200);
  });

  it("네오버스가 연결을 끊으면 다음 확인에서 막힌다", async () => {
    const cookie = await loginOk(fakeTeacher());
    // 연결 토큰이 폐기된 상황을 만든다. 30초 확인 주기도 함께 지나가게 한다.
    await env.DB.prepare("UPDATE sessions SET link_token = 'tok:revoked', verified_at = 0").run();
    expect((await me(cookie)).status).toBe(401);
  });

  it("네오버스가 잠깐 안 되는 것은 로그아웃이 아니다", async () => {
    const cookie = await loginOk(fakeTeacher());
    await env.DB.prepare("UPDATE sessions SET link_token = 'tok:down', verified_at = 0").run();
    const res = await me(cookie);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "neobus-down" });
    // 세션을 지우지 않았다. 네오버스가 돌아오면 그대로 이어서 쓴다.
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>();
    expect(left!.n).toBe(1);
  });

  it("선생님 자격을 잃으면 세션도 끊긴다", async () => {
    const cookie = await loginOk(fakeTeacher());
    // 네오버스에서 학생으로 바뀐 상황.
    const 학생 = "tok:" + encodeURIComponent(JSON.stringify(fakeTeacher({ user_type: "학생" })));
    await env.DB.prepare("UPDATE sessions SET link_token = ?, verified_at = 0").bind(학생).run();
    expect((await me(cookie)).status).toBe(401);
  });

  it("다른 사람의 세션은 서로 건드리지 않는다", async () => {
    const a = await loginOk(otherTeacher(11, "가선생"));
    const b = await loginOk(otherTeacher(12, "나선생"));
    await SELF.fetch(`${BASE}/api/auth/logout`, { method: "POST", headers: { cookie: a } });
    expect((await me(a)).status).toBe(401);
    expect((await me(b)).status).toBe(200);
  });
});

describe("없어진 길", () => {
  it("가입과 비밀번호 로그인은 더 이상 없다", async () => {
    for (const path of ["/api/auth/signup", "/api/auth/login"]) {
      const res = await SELF.fetch(`${BASE}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "kim", password: "pw1234" }),
      });
      expect(res.status, path).toBe(410);
      expect(await res.json()).toMatchObject({ code: "sso-only" });
    }
  });
});

describe("네오버스 연결 토큰 폐기", () => {
  it("로그아웃하면 그 자리에서 폐기되고 대기열에 남지 않는다", async () => {
    const cookie = await loginOk(fakeTeacher());
    await SELF.fetch(`${BASE}/api/auth/logout`, { method: "POST", headers: { cookie } });
    // 실제 네오버스는 revoke 에 data 없이 { success: true } 만 준다. 그걸 실패로 보면 여기 쌓인다.
    const queued = await env.DB.prepare("SELECT COUNT(*) AS n FROM revoke_queue").first<{ n: number }>();
    expect(queued!.n).toBe(0);
  });
});
