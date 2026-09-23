/**
 * 백업 검증 — manifest 의 모든 퀴즈 CSV 를 **앱의 실제 파서**로 다시 읽어 원본과 대조한다.
 *
 *   node --experimental-strip-types --import ./tools/ts-register.mjs tools/verify-neobus-backup.mjs <백업루트> [--upload http://127.0.0.1:8799]
 *
 * 확인하는 것 (계획 문서 6-5)
 *   1. 파일 수: DB 퀴즈 수 = manifest 퀴즈 수 = 엑셀모음/*.csv 수. 선생님별 합계도.
 *   2. 해시: 각 CSV 의 SHA-256 이 manifest 와 같다.
 *   3. 왕복: parseCsv → parseQuizValues 로 읽어 skipped=0, q/options/ans 가 원본과 완전히 같다.
 *   4. (--upload) 로컬 서버에 실제로 올려서, 내려받은 CSV 가 백업 CSV 와 **바이트까지** 같다.
 *      운영이 아니라 로컬(가짜 네오버스) 서버에만 올린다.
 *
 * 결과는 <백업루트>/verification.json 에 적는다. 하나라도 틀리면 FAIL 이고 종료 코드 1.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseCsv, parseQuizValues } from "../src/quiz.ts";
import { teacherCookie } from "./session.mjs";

const root = process.argv[2];
if (!root) {
  console.error("사용법: node --experimental-strip-types --import ./tools/ts-register.mjs tools/verify-neobus-backup.mjs <백업루트> [--upload 주소]");
  process.exit(2);
}
const uploadAt = (() => {
  const i = process.argv.indexOf("--upload");
  return i > 0 ? process.argv[i + 1] : "";
})();

const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const quizSets = JSON.parse(readFileSync(join(root, "운영복구용/quiz_sets.json"), "utf8"));
const byId = new Map(quizSets.map((q) => [q.id, q]));
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const checks = [];
const fail = (name, detail) => checks.push({ name, ok: false, detail });
const pass = (name, detail = "") => checks.push({ name, ok: true, detail });

// ── 1. 개수 ───────────────────────────────────────────────────────────────
const dbCount = manifest.snapshot.rowCounts.quiz_sets;
const csvFiles = [];
for (const t of manifest.teachers) {
  const dir = join(root, t.folder, "엑셀모음");
  const files = readdirSync(dir).filter((f) => f.endsWith(".csv"));
  csvFiles.push(...files.map((f) => relative(root, join(dir, f))));
  if (files.length !== t.quizCount) fail(`선생님 ${t.name} 파일 수`, `${files.length} ≠ manifest ${t.quizCount}`);
}
if (dbCount === manifest.quizzes.length && manifest.quizzes.length === csvFiles.length && quizSets.length === dbCount) {
  pass("퀴즈 수 일치", `DB ${dbCount} = manifest ${manifest.quizzes.length} = CSV ${csvFiles.length}`);
} else {
  fail("퀴즈 수 일치", `DB ${dbCount} · manifest ${manifest.quizzes.length} · CSV ${csvFiles.length} · json ${quizSets.length}`);
}
if (manifest.teachers.length !== manifest.snapshot.rowCounts.teachers) {
  fail("선생님 수", `manifest ${manifest.teachers.length} ≠ DB ${manifest.snapshot.rowCounts.teachers}`);
} else pass("선생님 수", String(manifest.teachers.length));

// ── 2·3. 해시와 왕복 ──────────────────────────────────────────────────────
let roundTrips = 0;
for (const e of manifest.quizzes) {
  const buf = readFileSync(join(root, e.csv));
  if (sha(buf) !== e.csvSha256) { fail(`해시 ${e.csv}`, "manifest 와 다름"); continue; }
  const original = byId.get(e.id);
  if (!original) { fail(`원본 ${e.csv}`, "quiz_sets.json 에 없음"); continue; }
  if (original.item_count !== original.items.length) fail(`item_count quiz-${e.id}`, `${original.item_count} ≠ ${original.items.length}`);

  const text = new TextDecoder("utf-8").decode(buf);
  const parsed = parseQuizValues(parseCsv(text));
  const want = original.items.map((it) => ({ q: it.q, options: it.options, ans: it.ans }));
  if (parsed.skipped !== 0) { fail(`왕복 ${e.csv}`, `skipped=${parsed.skipped}: ${parsed.problems.join(" / ")}`); continue; }
  if (!same(parsed.bank, want)) {
    const at = parsed.bank.findIndex((it, i) => !same(it, want[i]));
    fail(`왕복 ${e.csv}`, `문항 #${at} 이 다름: ${JSON.stringify(parsed.bank[at])} vs ${JSON.stringify(want[at])}`);
    continue;
  }
  roundTrips++;
}
if (roundTrips === manifest.quizzes.length) pass("CSV 전수 왕복", `${roundTrips}개 모두 원본과 같음`);

// 특수 문자 표본 — 무엇이 실제로 들어 있었는지 기록으로 남긴다.
const specials = { 줄바꿈: 0, 큰따옴표: 0, 쉼표: 0, 보기2개: 0, 보기4개: 0, 수식모양: 0 };
for (const q of quizSets) for (const it of q.items) {
  const all = [it.q, ...it.options];
  if (all.some((s) => /[\r\n]/.test(s))) specials.줄바꿈++;
  if (all.some((s) => s.includes('"'))) specials.큰따옴표++;
  if (all.some((s) => s.includes(","))) specials.쉼표++;
  if (it.options.length === 2) specials.보기2개++;
  if (it.options.length === 4) specials.보기4개++;
  if (all.some((s) => /^[=+\-@]/.test(s))) specials.수식모양++;
}
pass("특수 문자 표본", JSON.stringify(specials));

// ── 4. 실제 업로드 왕복 (로컬 서버) ───────────────────────────────────────
if (uploadAt) {
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)/.test(uploadAt)) {
    fail("업로드 대상", `${uploadAt} — 로컬이 아니다. 운영에는 올리지 않는다.`);
  } else {
    const cookie = await teacherCookie(uploadAt, { who: "backupcheck", quiet: true });
    if (!cookie) fail("업로드 로그인", "가짜 네오버스로 로그인하지 못했다");
    else {
      let ok = 0;
      for (const e of manifest.quizzes) {
        const buf = readFileSync(join(root, e.csv));
        const form = new FormData();
        form.set("title", `검증${e.id}`);
        form.set("file", new File([buf], "quiz.csv", { type: "text/csv" }));
        const up = await fetch(`${uploadAt}/api/quizsets`, { method: "POST", headers: { cookie }, body: form });
        const body = await up.json().catch(() => ({}));
        if (!up.ok || !body.ok) { fail(`업로드 ${e.csv}`, `${up.status} ${body.error ?? ""}`); continue; }
        if (body.skipped !== 0 || body.itemCount !== e.itemCount) {
          fail(`업로드 ${e.csv}`, `skipped=${body.skipped} itemCount=${body.itemCount} (기대 ${e.itemCount})`);
          continue;
        }
        const down = await fetch(`${uploadAt}/api/quizsets/${body.id}/download`, { headers: { cookie } });
        const got = Buffer.from(await down.arrayBuffer());
        if (!got.equals(buf)) { fail(`내려받기 ${e.csv}`, "서버가 돌려준 CSV 가 백업 CSV 와 바이트가 다름"); continue; }
        await fetch(`${uploadAt}/api/quizsets/${body.id}`, { method: "DELETE", headers: { cookie } });
        ok++;
      }
      if (ok === manifest.quizzes.length) pass("실제 업로드 왕복", `${ok}개 올려서 내려받은 파일이 바이트까지 같음`);
    }
  }
}

// ── 결과 ──────────────────────────────────────────────────────────────────
const failed = checks.filter((c) => !c.ok);
const result = {
  verifiedAt: new Date().toISOString(),
  root: root,
  manifestRunId: manifest.runId,
  result: failed.length ? "FAIL" : "PASS",
  checks,
};
writeFileSync(join(root, "verification.json"), JSON.stringify(result, null, 1) + "\n");
for (const c of checks) console.log(`${c.ok ? "✅" : "❌"} ${c.name}${c.detail ? " — " + c.detail : ""}`);
console.log(failed.length ? `\n❌ FAIL (${failed.length})` : "\n✅ PASS");
process.exit(failed.length ? 1 : 0);
