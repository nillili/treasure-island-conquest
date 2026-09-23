/**
 * Neobus SSO 전환 — 운영 자료 정리 도구. 계획 문서 §7.
 *
 *   node tools/transition-neobus.mjs probe-rooms <백업루트>            방 DO 55개가 비었는지 전수 확인
 *   node tools/transition-neobus.mjs verify-d1   <백업루트> [--local 디렉터리]   운영 D1 이 백업과 같은지
 *   node tools/transition-neobus.mjs purge-d1    <백업루트> --yes [--local 디렉터리]  기존 자료 삭제
 *
 * 원칙
 *   · 백업 manifest 에 적힌 대상만 지운다. manifest 에 없는 행이 있으면 멈춘다.
 *   · 지우기 직전에 운영 내용을 백업과 다시 대조한다. 한 글자라도 다르면 멈춘다.
 *   · 삭제는 한 배치(원자적)로 보내고, 배치 안에 행 수 가드를 둔다 — 대조와 삭제 사이에
 *     누가 뭘 바꿨어도 가드가 걸려 통째로 되돌아간다.
 *   · --local 은 로컬 사본(wrangler --persist-to)에 같은 절차를 돌려 보는 용도다. 운영에 가기 전 연습.
 *   · 새 SSO 자료(neobus_user_id 컬럼)가 이미 생긴 DB 에는 절대 돌지 않는다.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

const [cmd, rootArg] = process.argv.slice(2);
const flag = (n) => process.argv.includes(`--${n}`);
const opt = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : ""; };
if (!cmd || !rootArg) {
  console.error("사용법: node tools/transition-neobus.mjs <probe-rooms|verify-d1|purge-d1> <백업루트> [--local 디렉터리] [--yes]");
  process.exit(2);
}
const root = rootArg;
const BASE = "https://treasure-island-v2.ds1lph.workers.dev";
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const local = opt("local");
const ID_RE = /^[A-Za-z0-9]{4,20}$/;            // 옛 가입 규칙. 이걸 통과한 값만 SQL 에 실린다.
const TABLES = ["sessions", "game_records", "rooms", "quiz_sets", "teachers"];  // 자식부터

const sha = (s) => createHash("sha256").update(s).digest("hex");
const log = (s) => console.log(s);

/** wrangler d1 execute 를 돌리고 results 배열들을 돌려준다. --local 이면 로컬 사본에. */
function d1(sqlOrFile, { file = false } = {}) {
  const args = ["wrangler", "d1", "execute", "treasure", "--json", local ? "--local" : "--remote"];
  if (local) args.push("--persist-to", local);
  args.push(file ? "--file" : "--command", sqlOrFile);
  const out = execFileSync("npx", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 });
  const start = out.indexOf("[\n");
  const parsed = JSON.parse(out.slice(start));
  if (!parsed.every((r) => r.success)) throw new Error("D1 실패: " + JSON.stringify(parsed).slice(0, 300));
  return parsed.map((r) => r.results);
}

/** 백업의 source.sqlite. 대조의 기준이다. */
function snapshot() {
  return new DatabaseSync(join(root, "운영복구용/source.sqlite"), { readOnly: true });
}

// 내용 대조에 쓰는 열. sessions 는 로그인마다 바뀌므로 행 수만 본다.
const CONTENT = {
  teachers: "SELECT id, display_name, is_super, created_at, last_login_at FROM teachers ORDER BY id",
  quiz_sets: "SELECT id, teacher_id, title, items_json, item_count, source_name, skipped, created_at, updated_at FROM quiz_sets ORDER BY id",
  rooms: "SELECT code, status, teacher_id, label, quiz_set_id, quiz_title, created_at FROM rooms ORDER BY code",
  game_records: "SELECT id, room_code, game_key, teacher_id, ended_at, h_total, c_total, winner, player_count, solved, correct FROM game_records ORDER BY id",
};
const canon = (rows) => sha(JSON.stringify(rows.map((r) => Object.fromEntries(Object.entries(r).sort()))));

function verifyD1() {
  const snap = snapshot();
  const report = { at: new Date().toISOString(), target: local ? `local:${local}` : "remote", tables: {}, ok: true };

  // 새 스키마 흔적이 있으면 이미 전환된 DB 다. 여기서 절대 더 가지 않는다.
  const cols = d1("SELECT name FROM pragma_table_info('teachers')")[0].map((r) => r.name);
  if (cols.includes("neobus_user_id") || !cols.includes("pw_hash")) {
    report.ok = false;
    report.reason = "teachers 표가 이미 SSO 스키마다. 전환 뒤 DB 에는 정리를 돌리지 않는다.";
    return report;
  }

  const counts = d1(TABLES.map((t) => `SELECT '${t}' AS t, COUNT(*) AS n FROM ${t}`).join("; "));
  for (const [i, t] of TABLES.entries()) {
    const live = counts[i][0].n;
    const want = manifest.snapshot.rowCounts[t];
    const entry = { live, backup: want, countOk: live === want };
    if (CONTENT[t]) {
      const liveHash = canon(d1(CONTENT[t])[0]);
      const snapHash = canon(snap.prepare(CONTENT[t]).all());
      entry.contentOk = liveHash === snapHash;
      if (!entry.contentOk) report.ok = false;
    }
    if (!entry.countOk && t !== "sessions") report.ok = false;
    if (!entry.countOk && t === "sessions") entry.note = "세션은 로그인마다 바뀐다. 행 수만 적어 둔다.";
    report.tables[t] = entry;
  }
  // manifest 밖의 선생님이 있으면 안 된다.
  const liveIds = d1("SELECT id FROM teachers ORDER BY id")[0].map((r) => r.id);
  const known = manifest.teachers.map((t) => t.id).sort();
  report.unknownTeachers = liveIds.filter((id) => !known.includes(id));
  if (report.unknownTeachers.length) report.ok = false;
  snap.close();
  return report;
}

if (cmd === "probe-rooms") {
  // 방 DO 가 비었는지: 폴백 rpc 로 sync 를 보내면 자료가 없는 방은 no-room, 남은 방은 need-hello 로 답한다.
  // 공개 경로라 배포·인증이 필요 없다. ensureSchema 가 빈 표를 다시 만드는 것은 자료가 아니다.
  const rooms = JSON.parse(readFileSync(join(root, "운영복구용/rooms-before-close.json"), "utf8"));
  const results = [];
  for (const r of rooms) {
    let verdict;
    try {
      const res = await fetch(`${BASE}/api/rooms/${r.code}/rpc`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ t: "sync" }),
        signal: AbortSignal.timeout(10000),
      });
      const body = await res.json();
      verdict = { code: r.code, statusInD1: r.status, http: res.status, reply: body.code ?? body.t ?? "?",
                  empty: body.code === "no-room" };
    } catch (err) {
      verdict = { code: r.code, statusInD1: r.status, http: 0, reply: String(err), empty: false };
    }
    results.push(verdict);
    log(`${verdict.empty ? "✅" : "❌"} 방 ${r.code} → ${verdict.reply}`);
  }
  const notEmpty = results.filter((r) => !r.empty);
  const out = { probedAt: new Date().toISOString(), base: BASE, total: results.length,
                empty: results.length - notEmpty.length, notEmpty: notEmpty.map((r) => r.code), rooms: results };
  writeFileSync(join(root, "운영복구용/rooms-close-results.json"), JSON.stringify(out, null, 1) + "\n");
  log(notEmpty.length ? `\n❌ 비어 있지 않은 방 ${notEmpty.length}개` : `\n✅ 방 ${results.length}개 전부 비어 있음`);
  process.exit(notEmpty.length ? 1 : 0);
}

if (cmd === "verify-d1") {
  const report = verifyD1();
  writeFileSync(join(root, local ? "verification-d1-local.json" : "verification-d1.json"), JSON.stringify(report, null, 1) + "\n");
  for (const [t, e] of Object.entries(report.tables ?? {})) {
    log(`${e.countOk && e.contentOk !== false ? "✅" : "❌"} ${t}: 운영 ${e.live} · 백업 ${e.backup}${"contentOk" in e ? (e.contentOk ? " · 내용 동일" : " · 내용 다름") : ""}${e.note ? " · " + e.note : ""}`);
  }
  if (report.reason) log("❌ " + report.reason);
  if (report.unknownTeachers?.length) log("❌ manifest 에 없는 선생님: " + report.unknownTeachers.join(", "));
  log(report.ok ? "\n✅ 운영 D1 은 백업과 같다" : "\n❌ 다르다 — 지우지 않는다");
  process.exit(report.ok ? 0 : 1);
}

if (cmd === "purge-d1") {
  if (!flag("yes")) { console.error("--yes 가 없으면 지우지 않습니다."); process.exit(2); }
  if (!local) {
    // 운영이면 방 정리 증거가 먼저 있어야 한다.
    let probe;
    try { probe = JSON.parse(readFileSync(join(root, "운영복구용/rooms-close-results.json"), "utf8")); }
    catch { console.error("❌ rooms-close-results.json 이 없습니다. probe-rooms 를 먼저 돌리세요."); process.exit(1); }
    if (probe.notEmpty.length || probe.total !== manifest.snapshot.rowCounts.rooms) {
      console.error(`❌ 방 정리가 끝나지 않았습니다 (비어 있지 않음 ${probe.notEmpty.length} · 확인 ${probe.total}/${manifest.snapshot.rowCounts.rooms}).`);
      process.exit(1);
    }
    const v = JSON.parse(readFileSync(join(root, "verification.json"), "utf8"));
    if (v.result !== "PASS") { console.error("❌ 백업 검증이 PASS 가 아닙니다."); process.exit(1); }
  }
  const before = verifyD1();
  if (!before.ok) { console.error("❌ 삭제 직전 대조 실패. 지우지 않습니다. " + (before.reason ?? "")); process.exit(1); }

  const ids = manifest.teachers.map((t) => t.id);
  if (!ids.every((id) => ID_RE.test(id))) { console.error("❌ 선생님 ID 형식이 이상합니다."); process.exit(1); }
  const idList = ids.map((id) => `'${id}'`).join(",");
  const rc = manifest.snapshot.rowCounts;

  // 한 파일 = 한 배치. 가드가 걸리면 D1 이 배치 전체를 되돌린다.
  // sessions 는 로그인마다 바뀌므로 가드에서 뺀다 — 어차피 전부 지운다.
  const sql = [
    `CREATE TABLE _purge_guard (ok INTEGER NOT NULL CHECK (ok = 0));`,
    `INSERT INTO _purge_guard (ok) SELECT`,
    `    ((SELECT COUNT(*) FROM teachers) - ${rc.teachers})`,
    `  + ((SELECT COUNT(*) FROM quiz_sets) - ${rc.quiz_sets})`,
    `  + ((SELECT COUNT(*) FROM rooms) - ${rc.rooms})`,
    `  + ((SELECT COUNT(*) FROM game_records) - ${rc.game_records})`,
    `  + (SELECT COUNT(*) FROM teachers WHERE id NOT IN (${idList}))`,
    `  + (SELECT COUNT(*) FROM quiz_sets WHERE teacher_id NOT IN (${idList}))`,
    `  + (SELECT COUNT(*) FROM rooms WHERE teacher_id NOT IN (${idList}));`,
    `DELETE FROM sessions;`,
    `DELETE FROM game_records WHERE teacher_id IN (${idList}) OR teacher_id IS NULL;`,
    `DELETE FROM rooms WHERE teacher_id IN (${idList});`,
    `DELETE FROM quiz_sets WHERE teacher_id IN (${idList});`,
    `DELETE FROM teachers WHERE id IN (${idList});`,
    `DROP TABLE _purge_guard;`,
  ].join("\n");
  const dir = mkdtempSync(join(tmpdir(), "purge-"));
  const file = join(dir, "purge.sql");
  writeFileSync(file, sql);
  writeFileSync(join(root, "운영복구용", local ? "purge-local.sql" : "purge.sql"), sql);   // 무엇을 보냈는지 남긴다
  let failed = null;
  try { d1(file, { file: true }); } catch (err) { failed = String(err); }
  rmSync(dir, { recursive: true, force: true });

  const after = d1(TABLES.map((t) => `SELECT '${t}' AS t, COUNT(*) AS n FROM ${t}`).join("; ")).map((r) => r[0]);
  const fk = d1("PRAGMA foreign_key_check")[0];
  const result = { at: new Date().toISOString(), target: local ? `local:${local}` : "remote",
                   before: before.tables, failed, after: Object.fromEntries(after.map((r) => [r.t, r.n])), foreignKeyViolations: fk.length };
  writeFileSync(join(root, "운영복구용", local ? "purge-result-local.json" : "purge-result.json"), JSON.stringify(result, null, 1) + "\n");
  for (const r of after) log(`${r.n === 0 ? "✅" : "❌"} ${r.t}: ${r.n}행`);
  if (failed) { log("❌ 배치 실패 (되돌아감): " + failed.slice(0, 200)); process.exit(1); }
  const clean = after.every((r) => r.n === 0) && fk.length === 0;
  log(clean ? "\n✅ 정리 완료 — 표 5개 모두 0행, 외래키 위반 0" : "\n❌ 남은 행이 있다");
  process.exit(clean ? 0 : 1);
}

console.error("모르는 명령: " + cmd);
process.exit(2);
