/**
 * 관제 화면 — 슈퍼관리자 한 사람이 학교 전체를 한눈에 본다.
 *
 * 보통 선생님은 자기 것만 본다. 그 경계는 지금까지 teacher_id 로 지켜 왔고,
 * 여기서만 그 경계를 넘는다. 그래서 이 파일의 모든 길은 requireSuper 를 먼저 지난다.
 *
 * 거의 다 보여 주기만 한다. 남의 퀴즈를 고치거나 지우는 길은 여기에 없다 —
 * 관제는 "무슨 일이 있었나" 를 아는 자리이지 남의 수업을 손대는 자리가 아니다.
 *
 * 딱 하나 예외가 비밀번호 재설정이다. 잊어버린 선생님을 되살릴 길이 달리 없어서 뚫었다
 * (2026-08-29). 그래서 쓰기는 이 한 곳뿐이고, 나머지는 GET 만 받는다.
 *
 * 학생 이름은 어디에도 나오지 않는다. game_records 에 애초에 담기지 않는다
 * (migrations/0003, 2026-08-09 결정).
 */
import { requireSuper, setPassword, tempPassword } from "./auth";
import { fail, json } from "./http";
import type { GameIssue } from "./protocol";

const RECENT_GAMES = 50; // 관제 첫 화면에 올리는 최근 수업 수
const TEACHER_GAMES = 100; // 선생님 한 명을 펼쳤을 때
const PREVIEW_ITEMS = 5; // 남의 퀴즈는 앞 몇 문항만 훑어본다

interface TeacherRow {
  id: string;
  display_name: string;
  is_super: number;
  created_at: number;
  last_login_at: number | null;
  quiz_count: number;
  open_rooms: number;
  game_count: number;
  last_game_at: number | null;
}

interface GameRow {
  id: number;
  room_code: string;
  teacher_id: string | null;
  label: string | null;
  quiz_title: string | null;
  started_at: number;
  ended_at: number;
  rounds: number;
  round_limit: number;
  h_total: number;
  c_total: number;
  winner: string;
  player_count: number;
  solved: number;
  correct: number;
  issues_json: string;
}

function issuesOf(raw: string): GameIssue[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as GameIssue[]) : [];
  } catch {
    return []; // 옛 기록이 깨져 있어도 관제 화면이 통째로 죽으면 안 된다
  }
}

function gameView(r: GameRow) {
  const issues = issuesOf(r.issues_json);
  return {
    id: r.id,
    roomCode: r.room_code,
    teacherId: r.teacher_id,
    label: r.label,
    quizTitle: r.quiz_title,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    rounds: r.rounds,
    roundLimit: r.round_limit,
    scores: { H: r.h_total, C: r.c_total },
    winner: r.winner,
    playerCount: r.player_count,
    solved: r.solved,
    correct: r.correct,
    issues,
    // 목록에서 한 눈에 고르라고 가장 나쁜 등급을 미리 접어 둔다.
    level: issues.some((i) => i.level === "error") ? "error" : issues.length ? "warn" : "ok",
  };
}

/** 지금 열려 있는 방 — 선생님을 가리지 않는다. 관제의 핵심 질문 하나다. */
async function openRooms(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT r.code, r.label, r.quiz_title, r.teacher_id, r.created_at, r.last_active_at, t.display_name
       FROM rooms r LEFT JOIN teachers t ON t.id = r.teacher_id
      WHERE r.status = 'ready' ORDER BY r.last_active_at DESC`,
  ).all<{
    code: string; label: string | null; quiz_title: string | null; teacher_id: string;
    created_at: number; last_active_at: number; display_name: string | null;
  }>();

  // 방 안이 어떤지는 DO 만 안다. 방마다 한 번씩 물어본다.
  // 열린 방은 많아야 수십 개라 이 정도 왕복은 관제 화면을 여는 값으로 싸다.
  return Promise.all(
    results.map(async (r) => {
      const live = await env.ROOM.getByName(r.code)
        .diagnose()
        .catch(() => null);
      return {
        code: r.code,
        label: r.label,
        quizTitle: r.quiz_title,
        teacherId: r.teacher_id,
        teacherName: r.display_name,
        createdAt: r.created_at,
        lastActiveAt: r.last_active_at,
        live: live && live.ready
          ? { status: live.status, players: live.players, online: live.online, cellCount: live.cellCount }
          : null,
      };
    }),
  );
}

/** 관제 첫 화면 — 선생님 목록 · 열린 방 · 최근 수업. */
async function overview(env: Env): Promise<Response> {
  const { results: teachers } = await env.DB.prepare(
    `SELECT t.id, t.display_name, t.is_super, t.created_at, t.last_login_at,
            (SELECT COUNT(*) FROM quiz_sets q WHERE q.teacher_id = t.id)                         AS quiz_count,
            (SELECT COUNT(*) FROM rooms r WHERE r.teacher_id = t.id AND r.status = 'ready')      AS open_rooms,
            (SELECT COUNT(*) FROM game_records g WHERE g.teacher_id = t.id)                      AS game_count,
            (SELECT MAX(g.ended_at) FROM game_records g WHERE g.teacher_id = t.id)               AS last_game_at
       FROM teachers t ORDER BY t.created_at`,
  ).all<TeacherRow>();

  const { results: games } = await env.DB.prepare(
    `SELECT * FROM game_records ORDER BY ended_at DESC LIMIT ?`,
  )
    .bind(RECENT_GAMES)
    .all<GameRow>();

  return json({
    ok: true,
    serverNow: Date.now(),
    teachers: teachers.map((t) => ({
      id: t.id,
      name: t.display_name,
      isSuper: !!t.is_super,
      createdAt: t.created_at,
      lastLoginAt: t.last_login_at,
      quizCount: t.quiz_count,
      openRooms: t.open_rooms,
      gameCount: t.game_count,
      lastGameAt: t.last_game_at,
    })),
    openRooms: await openRooms(env),
    recentGames: games.map(gameView),
  });
}

/** 선생님 한 명 — 퀴즈 목록과 지난 수업. */
async function teacherDetail(env: Env, id: string): Promise<Response> {
  const teacher = await env.DB.prepare(
    "SELECT id, display_name, is_super, created_at, last_login_at FROM teachers WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string; display_name: string; is_super: number; created_at: number; last_login_at: number | null }>();
  if (!teacher) return fail("그런 선생님이 없습니다.", 404);

  const { results: sets } = await env.DB.prepare(
    `SELECT id, title, item_count, source_name, skipped, created_at, updated_at, used_at
       FROM quiz_sets WHERE teacher_id = ? ORDER BY updated_at DESC`,
  )
    .bind(id)
    .all<{
      id: number; title: string; item_count: number; source_name: string | null;
      skipped: number; created_at: number; updated_at: number; used_at: number | null;
    }>();

  const { results: games } = await env.DB.prepare(
    "SELECT * FROM game_records WHERE teacher_id = ? ORDER BY ended_at DESC LIMIT ?",
  )
    .bind(id, TEACHER_GAMES)
    .all<GameRow>();

  const { results: rooms } = await env.DB.prepare(
    `SELECT code, label, quiz_title, status, created_at, last_active_at, closed_at
       FROM rooms WHERE teacher_id = ? ORDER BY last_active_at DESC LIMIT 20`,
  )
    .bind(id)
    .all<{
      code: string; label: string | null; quiz_title: string | null; status: string;
      created_at: number; last_active_at: number; closed_at: number | null;
    }>();

  return json({
    ok: true,
    teacher: {
      id: teacher.id,
      name: teacher.display_name,
      isSuper: !!teacher.is_super,
      createdAt: teacher.created_at,
      lastLoginAt: teacher.last_login_at,
    },
    quizSets: sets.map((s) => ({
      id: s.id,
      title: s.title,
      itemCount: s.item_count,
      sourceName: s.source_name,
      skipped: s.skipped,
      createdAt: s.created_at,
      updatedAt: s.updated_at,
      usedAt: s.used_at,
    })),
    games: games.map(gameView),
    rooms: rooms.map((r) => ({
      code: r.code,
      label: r.label,
      quizTitle: r.quiz_title,
      status: r.status,
      createdAt: r.created_at,
      lastActiveAt: r.last_active_at,
      closedAt: r.closed_at,
    })),
  });
}

/**
 * 남의 퀴즈 훑어보기 — 읽기만 한다.
 * 앞 몇 문항만 돌려준다. 관제는 "어떤 문제를 쓰는지" 를 알면 되지 문제집을 통째로 가져갈 자리가 아니다.
 */
async function quizPreview(env: Env, id: number): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT q.id, q.title, q.item_count, q.skipped, q.items_json, q.teacher_id, t.display_name
       FROM quiz_sets q LEFT JOIN teachers t ON t.id = q.teacher_id
      WHERE q.id = ?`,
  )
    .bind(id)
    .first<{
      id: number; title: string; item_count: number; skipped: number;
      items_json: string; teacher_id: string; display_name: string | null;
    }>();
  if (!row) return fail("퀴즈를 찾을 수 없습니다.", 404);

  let items: unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(row.items_json);
    if (Array.isArray(parsed)) items = parsed;
  } catch {
    return fail("퀴즈 내용을 읽지 못했습니다.", 500);
  }

  return json({
    ok: true,
    id: row.id,
    title: row.title,
    itemCount: row.item_count,
    skipped: row.skipped,
    teacherId: row.teacher_id,
    teacherName: row.display_name,
    preview: items.slice(0, PREVIEW_ITEMS),
  });
}

/**
 * 비밀번호를 새로 정해 준다. 새 비밀번호를 주면 그것으로, 안 주면 임시 비밀번호를 지어 준다.
 * 지어 준 비밀번호는 **이 응답에서 한 번만** 돌려준다 — 저장해 두지 않으므로 다시 볼 수 없다.
 */
async function resetPassword(request: Request, env: Env, teacherId: string): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { password?: unknown };
  const given = typeof body.password === "string" ? body.password.trim() : "";
  const password = given || tempPassword();

  const problem = await setPassword(env, teacherId, password);
  if (problem) return fail(problem, given ? 400 : 404);

  return json({
    ok: true,
    teacherId,
    password,
    // 바꾸는 순간 그 선생님의 열린 세션이 모두 끊긴다. 화면이 이걸 알려 줘야 당황하지 않는다.
    signedOut: true,
  });
}

export async function handleAdmin(request: Request, env: Env, path: string): Promise<Response> {
  const me = await requireSuper(request, env);
  if (me instanceof Response) return me;

  // 쓰기는 여기 하나뿐이다. 이 검사보다 먼저 GET 을 강제하면 재설정이 막힌다.
  const reset = /^\/api\/admin\/teachers\/([A-Za-z0-9]{4,20})\/password$/.exec(path);
  if (reset) {
    if (request.method !== "POST") return fail("POST 로 보내 주세요.", 405);
    return resetPassword(request, env, reset[1]!);
  }

  if (request.method !== "GET") return fail("GET 으로 보내 주세요.", 405);

  if (path === "/api/admin/overview") return overview(env);

  const teacher = /^\/api\/admin\/teachers\/([A-Za-z0-9]{4,20})$/.exec(path);
  if (teacher) return teacherDetail(env, teacher[1]!);

  const quiz = /^\/api\/admin\/quizsets\/(\d+)$/.exec(path);
  if (quiz) return quizPreview(env, Number(quiz[1]));

  return fail("없는 주소입니다.", 404);
}
