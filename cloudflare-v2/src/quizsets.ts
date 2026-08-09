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

export async function handleQuizSets(request: Request, env: Env, path: string): Promise<Response> {
  const teacherId = await requireTeacher(request, env);
  if (teacherId instanceof Response) return teacherId;

  if (path === "/api/quizsets") {
    if (request.method === "GET") return list(env, teacherId);
    if (request.method === "POST") return upload(request, env, teacherId);
    return fail("GET 또는 POST 로 보내 주세요.", 405);
  }

  const m = /^\/api\/quizsets\/(\d+)(\/title)?$/.exec(path);
  if (!m) return fail("없는 주소입니다.", 404);
  const id = Number(m[1]);

  if (m[2]) {
    if (request.method !== "PATCH") return fail("PATCH 로 보내 주세요.", 405);
    return rename(request, env, id, teacherId);
  }
  if (request.method === "GET") return preview(env, id, teacherId);
  if (request.method === "DELETE") return remove(env, id, teacherId);
  return fail("GET 또는 DELETE 로 보내 주세요.", 405);
}

export { MAX_ITEMS, MAX_TITLE };
