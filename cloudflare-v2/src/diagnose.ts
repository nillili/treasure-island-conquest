/**
 * 시스템 점검 — 수업 시작 전에 선생님이 한 번 누른다.
 *
 * 확인하는 것은 "수업이 실제로 안 돌아가게 만드는 것"뿐이다.
 * 지난 판(앱스크립트)에서 점검하던 캐시·백업·시트 연결은 이 구조에 아예 없다.
 */
import { requireTeacher } from "./auth";
import { json } from "./http";

export const BUILD = "2026-09-05b"; // public/app.js 의 APP_BUILD, index.html 의 ?v= 와 같아야 한다

/** 선생님 화면 3D 무대에 쓰는 그림. 배포에서 빠지면 이모지로 떨어진다. */
export const FX_KINDS = ["search", "treasure", "storm", "attack"] as const;

export interface Check {
  name: string;
  level: "ok" | "warn" | "error";
  detail: string;
  fix?: string;
}

export async function handleDiagnose(request: Request, env: Env): Promise<Response> {
  const teacherId = await requireTeacher(request, env);
  if (teacherId instanceof Response) return teacherId;

  const checks: Check[] = [];
  const add = (name: string, level: Check["level"], detail: string, fix?: string) =>
    checks.push({ name, level, detail, fix });

  // ① 데이터베이스
  try {
    await env.DB.prepare("SELECT 1").first();
    add("데이터베이스", "ok", "정상입니다.");
  } catch (err) {
    add("데이터베이스", "error", err instanceof Error ? err.message : "연결하지 못했습니다.",
      "잠시 뒤 다시 눌러 보세요. 계속되면 배포를 다시 해야 합니다.");
  }

  // ② 퀴즈 보관함
  const { results: sets } = await env.DB.prepare(
    "SELECT id, title, item_count FROM quiz_sets WHERE teacher_id = ? ORDER BY updated_at DESC",
  )
    .bind(teacherId)
    .all<{ id: number; title: string; item_count: number }>();

  if (!sets.length) {
    add("퀴즈 보관함", "error", "올려 둔 퀴즈가 없습니다.", "[＋ 엑셀 올리기]로 문제를 먼저 올려 주세요.");
  } else {
    const empty = sets.filter((s) => s.item_count < 1);
    const thin = sets.filter((s) => s.item_count > 0 && s.item_count < 20);
    if (empty.length) {
      add("퀴즈 보관함", "error", `문항이 없는 퀴즈: ${empty.map((s) => s.title).join(", ")}`, "그 퀴즈를 다시 올려 주세요.");
    } else if (thin.length) {
      add("퀴즈 보관함", "warn",
        `퀴즈 ${sets.length}개. 문항이 적은 것: ${thin.map((s) => `${s.title}(${s.item_count})`).join(", ")}`,
        "12×12 판은 144칸이라, 문항이 적으면 같은 문제가 여러 번 나옵니다.");
    } else {
      add("퀴즈 보관함", "ok", `${sets.length}개 · ${sets.map((s) => `${s.title}(${s.item_count})`).join(", ")}`);
    }
  }

  // ③ 3D 그림 — 없어도 게임은 돌지만(이모지로 떨어진다) 수업 전에 알 수 있어야 한다
  const missing: string[] = [];
  for (const kind of FX_KINDS) {
    for (const team of ["H", "C"]) {
      const res = await env.ASSETS.fetch(new URL(`/assets/fx/${kind}-${team}.webp`, request.url));
      if (!res.ok) missing.push(`${kind}-${team}`);
    }
  }
  if (missing.length) {
    add("3D 그림", "warn", `${missing.length}장이 없습니다 (${missing.join(", ")}). 그 자리는 이모지로 나옵니다.`,
      "배포가 덜 올라간 것입니다. 다시 배포해 주세요.");
  } else {
    add("3D 그림", "ok", "8장 모두 정상입니다.");
  }

  // ④ 열려 있는 방
  const { results: rooms } = await env.DB.prepare(
    "SELECT code, label FROM rooms WHERE teacher_id = ? AND status = 'ready' ORDER BY last_active_at DESC",
  )
    .bind(teacherId)
    .all<{ code: string; label: string | null }>();

  if (!rooms.length) {
    add("열려 있는 방", "warn", "지금 열린 방이 없습니다.", "[방 만들기]로 방을 열고 학생들에게 번호를 알려 주세요.");
  } else {
    add("열려 있는 방", "ok", rooms.map((r) => `${r.code}${r.label ? `(${r.label})` : ""}`).join(", "));
  }

  // ⑤ 방마다 자세히
  for (const r of rooms) {
    const d = await env.ROOM.getByName(r.code).diagnose();
    const where = `방 ${r.code}`;
    if (!d.ready) {
      add(where, "error", "방 정보를 읽지 못했습니다.", "이 방을 폭파하고 새로 만들어 주세요.");
      continue;
    }
    if (!d.quizCount) {
      add(where, "error", "이 방에 문항이 없습니다.", "방을 폭파하고 다시 만들어 주세요.");
      continue;
    }
    if (!d.cellCount) {
      add(where, "warn", `학생 ${d.players}명 · 판이 아직 없습니다.`, "[새 게임]을 누르면 판이 깔립니다.");
      continue;
    }
    if (d.duplicates) {
      add(where, "error", `말이 ${d.duplicates}개 겹쳤습니다.`, "[새 게임]을 눌러 다시 배치해 주세요.");
      continue;
    }
    if (d.stuck.length) {
      add(where, "warn", `둘레가 전부 아군이라 문제를 못 받는 학생: ${d.stuck.join(", ")}`,
        "[다음 턴]을 누르면 자동으로 옮겨 줍니다.");
      continue;
    }
    add(where, "ok",
      `${d.quizTitle} · 학생 ${d.players}명(접속 ${d.online}) · ${d.cellCount}칸 · 문항 ${d.quizCount} · ${d.status}`);
  }

  const worst = checks.some((c) => c.level === "error") ? "error"
    : checks.some((c) => c.level === "warn") ? "warn" : "ok";

  return json({ ok: true, build: BUILD, serverNow: Date.now(), worst, checks });
}
