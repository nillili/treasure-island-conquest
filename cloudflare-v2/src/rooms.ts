/**
 * 방 개설 — D1 예약이 먼저, DO 초기화가 나중.
 *
 * 순서가 핵심이다. "빈 번호를 찾아본 뒤 DO 를 만들고 마지막에 D1 에 넣는" 순서로 하면
 * 찾는 것과 넣는 것 사이에 다른 요청이 끼어들어 두 선생님이 같은 DO 를 나눠 쓰게 된다.
 * code 가 PRIMARY KEY 이므로 **INSERT 가 성공하는 것 자체가 방번호 예약**이다. 그 틈이 없다.
 *
 * 그리고 (teacher_id, create_request_id) 가 UNIQUE 다. 선생님이 [방 만들기]를 두 번 눌러도,
 * 응답이 유실돼 다시 눌러도 같은 방 하나만 생긴다.
 */
import { requireTeacher, teacherFromCookie } from "./auth";
import { MAX_SIDE, MIN_SIDE, checkBoardSize } from "./game";
import { fail, json, readJson, str } from "./http";
import { loadQuizSet } from "./quizsets";
import { sweepStaleRooms } from "./sweep";

const CODE_TRIES = 20;
const PROVISION_STALE_MS = 10 * 60 * 1000; // 이보다 오래 준비 중인 방번호는 회수한다

// 화면이 인원에 맞춰 값을 보내 주므로(public/app.js 의 planFor) 여기 값은 그것이 오지 않을 때만
// 쓰인다. 10명 기준이다 — 12×12 · 10판이면 끝났을 때 절반쯤 찬다.
// 폭풍·공격권은 원래 7·7 이었는데 너무 안 나와서 12·12 로 올렸다(2026-09-04).
const DEFAULTS = {
  rows: 12,
  cols: 12,
  roundLimit: 10,
  turnSeconds: 20,
  cntT: 8,
  cntS: 12,
  cntA: 12,
};

function num(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function randomCode(): string {
  return String(1000 + Math.floor(Math.random() * 9000)); // 1000~9999
}

interface RoomConfig {
  rows: number;
  cols: number;
  roundLimit: number;
  turnSeconds: number;
  cntT: number;
  cntS: number;
  cntA: number;
}

function readConfig(body: Record<string, unknown>): RoomConfig | string {
  const cfg: RoomConfig = {
    rows: num(body.rows, DEFAULTS.rows),
    cols: num(body.cols, DEFAULTS.cols),
    roundLimit: num(body.roundLimit, DEFAULTS.roundLimit),
    turnSeconds: num(body.turnSeconds, DEFAULTS.turnSeconds),
    cntT: num(body.cntT, DEFAULTS.cntT),
    cntS: num(body.cntS, DEFAULTS.cntS),
    cntA: num(body.cntA, DEFAULTS.cntA),
  };
  const sizeProblem = checkBoardSize(cfg.rows, cfg.cols);
  if (sizeProblem) return sizeProblem;
  if (cfg.roundLimit < 1 || cfg.roundLimit > 30) return "라운드는 1~30 사이로 정해 주세요.";
  if (cfg.turnSeconds < 10 || cfg.turnSeconds > 300) return "턴 시간은 10~300초 사이로 정해 주세요.";
  if (cfg.cntT < 0 || cfg.cntS < 0 || cfg.cntA < 0) return "특수칸 수는 0 이상이어야 합니다.";
  if (cfg.cntT + cfg.cntS + cfg.cntA >= cfg.rows * cfg.cols) {
    return "특수칸이 너무 많습니다. 수를 줄여 주세요.";
  }
  return cfg;
}

/** 아직 아무도 안 쓰는 방번호를 하나 잡는다. 잡히면 그 번호, 다 실패하면 null. */
async function reserveCode(
  env: Env,
  teacherId: string,
  requestId: string,
  label: string | null,
  quizSetId: number,
  quizTitle: string,
): Promise<string | null> {
  const now = Date.now();
  for (let i = 0; i < CODE_TRIES; i++) {
    const code = randomCode();
    try {
      await env.DB.prepare(
        `INSERT INTO rooms (code, status, teacher_id, create_request_id, label, quiz_set_id, quiz_title, created_at, last_active_at)
         VALUES (?, 'provisioning', ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(code, teacherId, requestId, label, quizSetId, quizTitle, now, now)
        .run();
      return code;
    } catch {
      // 이미 쓰는 번호다. 닫힌 방이거나 준비하다 만 방이면 그 자리를 넘겨받는다.
      const taken = await env.DB.prepare(
        `UPDATE rooms
            SET status = 'provisioning', teacher_id = ?, create_request_id = ?, label = ?,
                quiz_set_id = ?, quiz_title = ?, created_at = ?, last_active_at = ?, closed_at = NULL
          WHERE code = ?
            AND (status = 'closed' OR (status = 'provisioning' AND created_at < ?))`,
      )
        .bind(teacherId, requestId, label, quizSetId, quizTitle, now, now, code, now - PROVISION_STALE_MS)
        .run();
      if (taken.meta.changes) return code;
    }
  }
  return null;
}

async function createRoom(request: Request, env: Env): Promise<Response> {
  const teacherId = await requireTeacher(request, env);
  if (teacherId instanceof Response) return teacherId;

  const body = await readJson(request);
  if (!body) return fail("요청 형식이 올바르지 않습니다.");

  const requestId = str(body.requestId);
  if (!requestId) return fail("요청 번호가 없습니다.");

  // 같은 요청으로 이미 만든 방이 있으면 그것을 그대로 돌려준다. 두 번 눌러도 방은 하나다.
  const already = await env.DB.prepare(
    `SELECT code, quiz_title, status FROM rooms
      WHERE teacher_id = ? AND create_request_id = ? AND status != 'closed'`,
  )
    .bind(teacherId, requestId)
    .first<{ code: string; quiz_title: string; status: string }>();
  if (already) {
    return json({ ok: true, code: already.code, quizTitle: already.quiz_title, reused: true });
  }

  const quizSetId = num(body.quizSetId, 0);
  if (!quizSetId) return fail("퀴즈를 하나 골라 주세요.");

  const cfg = readConfig(body);
  if (typeof cfg === "string") return fail(cfg);

  const set = await loadQuizSet(env, quizSetId, teacherId);
  if (!set) return fail("퀴즈를 찾을 수 없습니다.", 404);
  if (!set.items.length) return fail("이 퀴즈에는 문항이 없습니다.");

  const label = str(body.label) || null;
  const code = await reserveCode(env, teacherId, requestId, label, quizSetId, set.title);
  if (!code) return fail("지금은 방을 만들 수 없습니다. 잠시 후 다시 눌러 주세요.", 503);

  const stub = env.ROOM.getByName(code);
  try {
    await stub.init({ provisionId: requestId, code, teacherId, label, quizSetId, ...cfg });
  } catch (err) {
    // 예약만 하고 실패했다. 번호를 반납한다 — 반쪽 방을 남기지 않는다.
    await env.DB.prepare("UPDATE rooms SET status = 'closed', closed_at = ? WHERE code = ? AND status = 'provisioning'")
      .bind(Date.now(), code)
      .run();
    return fail(err instanceof Error ? err.message : "방을 만들지 못했습니다.", 500);
  }

  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE rooms SET status = 'ready', last_active_at = ? WHERE code = ?").bind(now, code),
    env.DB.prepare("UPDATE quiz_sets SET used_at = ? WHERE id = ? AND teacher_id = ?").bind(now, quizSetId, teacherId),
  ]);

  return json({ ok: true, code, quizTitle: set.title, quizCount: set.items.length, label });
}

/** 학생 입장 화면이 방번호를 확인한다. 로그인은 필요 없다. */
async function checkRoom(env: Env, code: string): Promise<Response> {
  // 반드시 D1 만 본다. env.ROOM.getByName() 은 없는 방이어도 DO 를 만들어 내기 때문에,
  // 아이가 아무 번호나 치면 빈 방이 생기고 "있다"는 답이 나가 버린다.
  const row = await env.DB.prepare(
    "SELECT label, quiz_title FROM rooms WHERE code = ? AND status = 'ready'",
  )
    .bind(code)
    .first<{ label: string | null; quiz_title: string | null }>();
  if (!row) return json({ ok: false, exists: false, error: "그런 방이 없어요. 번호를 다시 확인해 주세요." }, 404);

  const summary = await env.ROOM.getByName(code).summary();
  return json({
    ok: true,
    exists: true,
    code,
    label: row.label,
    quizTitle: row.quiz_title,
    status: summary.status,
    playerCount: summary.playerCount,
  });
}

/** 선생님이 다른 PC 에서 로그인해 진행 중인 방을 이어받을 때 쓴다. */
async function myRooms(request: Request, env: Env): Promise<Response> {
  const teacherId = await requireTeacher(request, env);
  if (teacherId instanceof Response) return teacherId;

  // 한 번 로그인해 두고 며칠 쓰는 선생님도 있다. 홈을 열 때마다 어제 방을 치운다.
  await sweepStaleRooms(env);

  const { results } = await env.DB.prepare(
    `SELECT code, label, quiz_title, created_at, last_active_at
       FROM rooms WHERE teacher_id = ? AND status = 'ready' ORDER BY last_active_at DESC`,
  )
    .bind(teacherId)
    .all<{ code: string; label: string | null; quiz_title: string | null; created_at: number; last_active_at: number }>();

  return json({
    ok: true,
    rooms: results.map((r) => ({
      code: r.code,
      label: r.label,
      quizTitle: r.quiz_title,
      createdAt: r.created_at,
      lastActiveAt: r.last_active_at,
    })),
  });
}

/** 방을 닫는다. 학생들은 알림을 받고 입장 화면으로 돌아간다. */
async function closeRoom(request: Request, env: Env, code: string): Promise<Response> {
  const teacherId = await requireTeacher(request, env);
  if (teacherId instanceof Response) return teacherId;

  const row = await env.DB.prepare(
    "SELECT code FROM rooms WHERE code = ? AND teacher_id = ? AND status != 'closed'",
  )
    .bind(code, teacherId)
    .first<{ code: string }>();
  if (!row) return fail("방을 찾을 수 없습니다.", 404);

  await env.ROOM.getByName(code).closeNow();
  await env.DB.prepare("UPDATE rooms SET status = 'closed', closed_at = ? WHERE code = ?")
    .bind(Date.now(), code)
    .run();
  return json({ ok: true, code });
}

export async function handleRooms(request: Request, env: Env, path: string): Promise<Response> {
  if (path === "/api/rooms") {
    if (request.method !== "POST") return fail("POST 로 보내 주세요.", 405);
    return createRoom(request, env);
  }
  if (path === "/api/rooms/mine") return myRooms(request, env);

  const m = /^\/api\/rooms\/(\d{4})(\/ws|\/rpc)?$/.exec(path);
  if (!m) return fail("없는 주소입니다.", 404);
  const code = m[1]!;

  if (!m[2]) {
    if (request.method === "DELETE") return closeRoom(request, env, code);
    return checkRoom(env, code);
  }

  // 쿠키는 브라우저가 업그레이드 요청에도 알아서 실어 보낸다. 여기서 확인해 DO 에 넘긴다.
  // 화면 JS 가 HttpOnly 토큰을 읽어 보낼 수는 없기 때문에, 이 자리가 유일한 확인 지점이다.
  const teacherId = await teacherFromCookie(request, env);
  const headers = new Headers(request.headers);
  headers.set("x-teacher-id", teacherId ?? ""); // 바깥에서 온 같은 이름 헤더는 여기서 덮인다
  return env.ROOM.getByName(code).fetch(new Request(request, { headers }));
}

export { DEFAULTS, MAX_SIDE, MIN_SIDE };
