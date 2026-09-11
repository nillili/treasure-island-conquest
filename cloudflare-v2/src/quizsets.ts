/**
 * 퀴즈 보관함 — 선생님이 올린 문제 묶음을 목록으로 들고 있는다.
 *
 * 두 가지를 반드시 지킨다.
 *  ① 모든 조회에 `AND teacher_id = ?` 를 붙인다. id 만으로 찾는 문장을 하나도 남기지 않는다.
 *  ② 덮어쓰기는 UPDATE 한 줄이다. 문항을 행으로 쪼개지 않고 JSON 한 컬럼에 두었기 때문에
 *     "지우다가 실패해서 빈 퀴즈가 남는" 경우가 아예 생기지 않는다.
 */
import { requireTeacher } from "./auth";
import { fail, json, readJson, str } from "./http";
import { MAX_ITEMS, type QuizItem, parseCsv, parseQuizFile, parseQuizValues } from "./quiz";

const MAX_TITLE = 20;
const PREVIEW_COUNT = 5;

interface SetRow {
  id: number;
  title: string;
  item_count: number;
  source_name: string | null;
  skipped: number;
  problems_json: string | null;
  items_json: string;
  updated_at: number;
  used_at: number | null;
}

/** 이 선생님의 퀴즈 하나. 남의 것이면 null. */
export async function loadQuizSet(env: Env, id: number, teacherId: string) {
  const row = await env.DB.prepare(
    "SELECT id, title, items_json FROM quiz_sets WHERE id = ? AND teacher_id = ?",
  )
    .bind(id, teacherId)
    .first<{ id: number; title: string; items_json: string }>();
  if (!row) return null;
  return { id: row.id, title: row.title, items: JSON.parse(row.items_json) as QuizItem[] };
}

/**
 * 가입한 선생님에게 상식 문제 한 벌을 미리 넣어 준다.
 * 처음 들어오자마자 빈 보관함을 보면 무엇을 어떻게 만들어야 할지 알 수 없다.
 * 같은 파일을 [샘플 받기]로 내려받아 고쳐 쓰면 형식을 그대로 따라갈 수 있다.
 */
export async function seedSampleQuiz(env: Env, teacherId: string): Promise<void> {
  try {
    const res = await env.ASSETS.fetch(new Request("https://assets.local/sample-quiz.csv"));
    if (!res.ok) return;
    const parsed = parseQuizValues(parseCsv(await res.text()));
    if (!parsed.bank.length) return;
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO quiz_sets (teacher_id, title, items_json, item_count, source_name, skipped, problems_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, '[]', ?, ?)`,
    )
      .bind(teacherId, "상식1(샘플)", JSON.stringify(parsed.bank), parsed.bank.length, "sample-quiz.csv", now, now)
      .run();
  } catch {
    // 샘플이 없어도 가입 자체는 되어야 한다.
  }
}

function checkTitle(title: string): string | null {
  if (!title) return "퀴즈 이름을 적어 주세요.";
  if (title.length > MAX_TITLE) return `퀴즈 이름은 ${MAX_TITLE}자까지입니다.`;
  return null;
}

async function list(env: Env, teacherId: string): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT id, title, item_count, source_name, skipped, updated_at, used_at
       FROM quiz_sets WHERE teacher_id = ? ORDER BY updated_at DESC`,
  )
    .bind(teacherId)
    .all<Omit<SetRow, "items_json" | "problems_json">>();

  return json({
    ok: true,
    sets: results.map((r) => ({
      id: r.id,
      title: r.title,
      itemCount: r.item_count,
      sourceName: r.source_name,
      skipped: r.skipped,
      updatedAt: r.updated_at,
      usedAt: r.used_at,
    })),
  });
}

async function upload(request: Request, env: Env, teacherId: string): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail("파일을 찾지 못했습니다. 다시 올려 주세요.");
  }

  const title = str(form.get("title"));
  const titleProblem = checkTitle(title);
  if (titleProblem) return fail(titleProblem);

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return fail("올릴 파일을 골라 주세요.");

  let parsed;
  try {
    parsed = await parseQuizFile(file);
  } catch (err) {
    return fail(err instanceof Error ? err.message : "파일을 읽지 못했습니다.");
  }
  if (!parsed.bank.length) {
    return json(
      { ok: false, error: "읽을 수 있는 문항이 하나도 없습니다.", problems: parsed.problems },
      400,
    );
  }

  const now = Date.now();
  const existing = await env.DB.prepare(
    "SELECT id FROM quiz_sets WHERE teacher_id = ? AND title = ?",
  )
    .bind(teacherId, title)
    .first<{ id: number }>();

  const payload = [
    JSON.stringify(parsed.bank),
    parsed.bank.length,
    file.name,
    parsed.skipped,
    JSON.stringify(parsed.problems),
    now,
  ] as const;

  if (existing) {
    if (str(form.get("overwrite")) !== "true") {
      return json(
        { ok: false, error: `이미 '${title}' 이 있습니다. 덮어쓸까요?`, code: "duplicate-title" },
        409,
      );
    }
    // 한 문장이라 중간에 실패해서 빈 퀴즈가 남을 수 없다.
    await env.DB.prepare(
      `UPDATE quiz_sets
          SET items_json = ?, item_count = ?, source_name = ?, skipped = ?, problems_json = ?, updated_at = ?
        WHERE id = ? AND teacher_id = ?`,
    )
      .bind(...payload, existing.id, teacherId)
      .run();
    return json({ ok: true, id: existing.id, title, itemCount: parsed.bank.length, skipped: parsed.skipped, problems: parsed.problems });
  }

  const inserted = await env.DB.prepare(
    `INSERT INTO quiz_sets (teacher_id, title, items_json, item_count, source_name, skipped, problems_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  )
    .bind(teacherId, title, ...payload.slice(0, 5), now, now)
    .first<{ id: number }>();

  return json({ ok: true, id: inserted!.id, title, itemCount: parsed.bank.length, skipped: parsed.skipped, problems: parsed.problems });
}

async function preview(env: Env, id: number, teacherId: string): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT id, title, item_count, skipped, problems_json, items_json
       FROM quiz_sets WHERE id = ? AND teacher_id = ?`,
  )
    .bind(id, teacherId)
    .first<Pick<SetRow, "id" | "title" | "item_count" | "skipped" | "problems_json" | "items_json">>();
  if (!row) return fail("퀴즈를 찾을 수 없습니다.", 404);

  const items = JSON.parse(row.items_json) as QuizItem[];
  return json({
    ok: true,
    id: row.id,
    title: row.title,
    itemCount: row.item_count,
    skipped: row.skipped,
    problems: row.problems_json ? (JSON.parse(row.problems_json) as string[]) : [],
    preview: items.slice(0, PREVIEW_COUNT),
  });
}

async function remove(env: Env, id: number, teacherId: string): Promise<Response> {
  // 지우기 전에, 지금 이 퀴즈로 돌고 있는 방이 있는지 본다.
  // 막지는 않는다 — 방 안에는 사본이 있어서 진행 중인 게임은 멀쩡히 끝난다.
  const { results } = await env.DB.prepare(
    "SELECT code FROM rooms WHERE quiz_set_id = ? AND teacher_id = ? AND status = 'ready'",
  )
    .bind(id, teacherId)
    .all<{ code: string }>();

  const done = await env.DB.prepare("DELETE FROM quiz_sets WHERE id = ? AND teacher_id = ?")
    .bind(id, teacherId)
    .run();
  if (!done.meta.changes) return fail("퀴즈를 찾을 수 없습니다.", 404);

  return json({ ok: true, usedByRooms: results.map((r) => r.code) });
}

async function rename(request: Request, env: Env, id: number, teacherId: string): Promise<Response> {
  const body = await readJson(request);
  if (!body) return fail("요청 형식이 올바르지 않습니다.");
  const title = str(body.title);
  const titleProblem = checkTitle(title);
  if (titleProblem) return fail(titleProblem);

  try {
    const done = await env.DB.prepare(
      "UPDATE quiz_sets SET title = ?, updated_at = ? WHERE id = ? AND teacher_id = ?",
    )
      .bind(title, Date.now(), id, teacherId)
      .run();
    if (!done.meta.changes) return fail("퀴즈를 찾을 수 없습니다.", 404);
  } catch {
    return fail(`이미 '${title}' 이 있습니다. 다른 이름을 지어 주세요.`, 409, "duplicate-title");
  }
  return json({ ok: true, title });
}

/**
 * CSV 한 칸. 쉼표·따옴표·줄바꿈이 들어 있으면 따옴표로 감싸고, 안의 따옴표는 둘로 늘린다.
 */
const csvCell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/**
 * 보관함의 문항을 **올릴 때와 똑같은 CSV** 로 되돌린다.
 *
 * 원본 파일은 보관하지 않는다(`items_json` 만 남는다). 그러니 내려받기는 "그때 그 파일"이
 * 아니라 **지금 문항으로 다시 만든 파일**이다. 열 이름과 정답 표기(번호)를 업로드 형식과
 * 같게 맞춰 두었으므로, 받아서 고친 뒤 그대로 다시 올릴 수 있다 — 그게 이 기능의 쓸모다.
 *
 * · 맨 앞의 BOM 은 엑셀에서 한글이 깨지지 않게 한다(`public/sample-quiz.csv` 와 같다).
 * · 보기 칸 수는 **가장 많은 문항에 맞춘다.** 보기가 적은 문항은 뒤를 빈 칸으로 둔다.
 */
function toCsv(items: QuizItem[]): string {
  const width = Math.max(2, ...items.map((it) => it.options.length));
  const head = ["질문", "정답", ...Array.from({ length: width }, (_, i) => `예제${i + 1}`)];
  const rows = items.map((it) => {
    const cells = [it.q, String(it.ans + 1), ...it.options];
    while (cells.length < head.length) cells.push("");
    return cells.map(csvCell).join(",");
  });
  return `\uFEFF${[head.join(","), ...rows].join("\r\n")}\r\n`;
}

/** 내려받기. 남의 퀴즈는 내려받을 수 없다 — 다른 조회와 같이 `teacher_id` 를 같이 건다. */
async function download(env: Env, id: number, teacherId: string): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT title, items_json FROM quiz_sets WHERE id = ? AND teacher_id = ?",
  )
    .bind(id, teacherId)
    .first<{ title: string; items_json: string }>();
  if (!row) return fail("없는 퀴즈입니다.", 404);

  const items = JSON.parse(row.items_json) as QuizItem[];
  if (!items.length) return fail("문항이 없는 퀴즈입니다.", 409);

  // 파일 이름에 못 쓰는 글자만 걸러낸다. 제목이 한글이라 filename* 로 한 번 더 적는다 —
  // 옛 브라우저는 filename= 을, 요즘 브라우저는 filename*= 을 읽는다.
  const safe = row.title.replace(/[\\/:*?"<>|]/g, "_").trim() || `퀴즈${id}`;
  return new Response(toCsv(items), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition":
        `attachment; filename="quiz-${id}.csv"; filename*=UTF-8''${encodeURIComponent(safe)}.csv`,
      "Cache-Control": "no-store",
    },
  });
}

export async function handleQuizSets(request: Request, env: Env, path: string): Promise<Response> {
  const teacherId = await requireTeacher(request, env);
  if (teacherId instanceof Response) return teacherId;

  if (path === "/api/quizsets") {
    if (request.method === "GET") return list(env, teacherId);
    if (request.method === "POST") return upload(request, env, teacherId);
    return fail("GET 또는 POST 로 보내 주세요.", 405);
  }

  const m = /^\/api\/quizsets\/(\d+)(\/title|\/download)?$/.exec(path);
  if (!m) return fail("없는 주소입니다.", 404);
  const id = Number(m[1]);

  if (m[2] === "/title") {
    if (request.method !== "PATCH") return fail("PATCH 로 보내 주세요.", 405);
    return rename(request, env, id, teacherId);
  }
  if (m[2] === "/download") {
    if (request.method !== "GET") return fail("GET 으로 보내 주세요.", 405);
    return download(env, id, teacherId);
  }
  if (request.method === "GET") return preview(env, id, teacherId);
  if (request.method === "DELETE") return remove(env, id, teacherId);
  return fail("GET 또는 DELETE 로 보내 주세요.", 405);
}

export { MAX_ITEMS, MAX_TITLE };
