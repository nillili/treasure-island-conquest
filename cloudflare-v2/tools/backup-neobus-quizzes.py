#!/usr/bin/env python3
"""
운영 D1 스냅샷(SQL) → 선생님별 퀴즈 CSV 백업.

  python3 tools/backup-neobus-quizzes.py <백업루트> [--deployment 배포판ID] [--build 판번호]

  <백업루트>/운영복구용/database-before-reset.sql 이 이미 있어야 한다
  (npx wrangler d1 export treasure --remote --output=... 로 받은 파일).

만드는 것
  운영복구용/source.sqlite            SQL 을 그대로 가져온 로컬 사본. 이후 모든 읽기는 여기서.
  운영복구용/teachers.json            기존 ID·이름·권한 (비밀번호 해시 없음)
  운영복구용/quiz_sets.json           전체 문항과 메타데이터
  운영복구용/rooms-before-close.json  방 목록 전체 (상태 불문)
  전달용/<선생님>/엑셀모음/<제목>__quiz-<ID>.csv
  전달용/<선생님>/퀴즈목록.csv
  전달용/<선생님>/다시올리는방법.txt
  manifest.json · checksums.sha256

지키는 것
  · 조회는 이 스냅샷 하나에서만 한다. 운영을 다시 부르지 않는다.
  · CSV 는 앱의 toCsv(src/quizsets.ts) 와 **바이트까지 같은** 규칙으로 쓴다.
    UTF-8 BOM · CRLF · 쉼표/따옴표/줄바꿈이 있는 칸만 따옴표 · 정답은 ans+1.
  · 원문을 고치지 않는다. 형식이 어긋나면 고치지 말고 실패로 멈춘다.
  · 주인 없는 퀴즈가 있으면 빼지 말고 실패로 멈춘다.
  · 파일 이름은 정리하되, 제목 원문은 manifest 와 퀴즈목록에 그대로 남긴다.
"""
import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone, timedelta

KST = timezone(timedelta(hours=9))
MAX_ITEMS = 80          # src/quiz.ts MAX_ITEMS 와 같아야 한다
TOOL_VERSION = "2026-09-24"


def die(msg: str) -> None:
    print(f"❌ {msg}", file=sys.stderr)
    sys.exit(1)


def csv_cell(v: str) -> str:
    """src/quizsets.ts csvCell 과 같은 규칙."""
    return '"' + v.replace('"', '""') + '"' if re.search(r'[",\r\n]', v) else v


def to_csv(items: list[dict]) -> str:
    """src/quizsets.ts toCsv 와 같은 결과."""
    width = max(2, *(len(it["options"]) for it in items))
    head = ["질문", "정답"] + [f"예제{i + 1}" for i in range(width)]
    rows = []
    for it in items:
        cells = [it["q"], str(it["ans"] + 1)] + list(it["options"])
        while len(cells) < len(head):
            cells.append("")
        rows.append(",".join(csv_cell(c) for c in cells))
    return "﻿" + "\r\n".join([",".join(head)] + rows) + "\r\n"


def safe_name(text: str, limit: int = 60) -> str:
    """경로 구분자·금지 문자·제어 문자를 치환하고 길이를 자른다. 빈 값이면 '_'."""
    out = re.sub(r'[\\/:*?"<>|\x00-\x1f\x7f]', "_", text).strip().strip(".")
    out = re.sub(r"\s+", " ", out)
    return (out[:limit] or "_")


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def items_hash(items: list[dict]) -> str:
    """문항 배열을 정규화한 JSON 의 SHA-256. CSV 와 무관하게 '내용' 만 비교하는 열쇠."""
    normalized = json.dumps(
        [{"q": it["q"], "options": list(it["options"]), "ans": it["ans"]} for it in items],
        ensure_ascii=False, separators=(",", ":"),
    )
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def check_items(quiz_id: int, items: object) -> list[dict]:
    """저장된 문항이 앱의 규칙 안에 있는지. 하나라도 어긋나면 멈춘다 — 조용히 고치지 않는다."""
    if not isinstance(items, list) or not items:
        die(f"quiz {quiz_id}: items_json 이 비어 있거나 배열이 아닙니다.")
    if len(items) > MAX_ITEMS:
        die(f"quiz {quiz_id}: 문항이 {len(items)}개로 {MAX_ITEMS}개를 넘습니다. 재업로드가 잘라 냅니다.")
    for i, it in enumerate(items):
        if not isinstance(it, dict):
            die(f"quiz {quiz_id} #{i}: 문항이 객체가 아닙니다.")
        q, opts, ans = it.get("q"), it.get("options"), it.get("ans")
        if not isinstance(q, str) or not q.strip():
            die(f"quiz {quiz_id} #{i}: 질문이 비었습니다.")
        if not isinstance(opts, list) or not (2 <= len(opts) <= 4):
            die(f"quiz {quiz_id} #{i}: 보기가 2~4개가 아닙니다 ({len(opts) if isinstance(opts, list) else '?'}).")
        if any(not isinstance(o, str) or not o.strip() for o in opts):
            die(f"quiz {quiz_id} #{i}: 빈 보기가 있습니다.")
        if not isinstance(ans, int) or not (0 <= ans < len(opts)):
            die(f"quiz {quiz_id} #{i}: 정답 번호가 범위 밖입니다 ({ans}).")
        # 파서는 trim 을 한다. 저장값에 앞뒤 공백이 있으면 다시 올렸을 때 달라진다.
        if q != q.strip() or any(o != o.strip() for o in opts):
            die(f"quiz {quiz_id} #{i}: 앞뒤 공백이 있어 재업로드 때 값이 달라집니다. 원본을 보존하고 따로 다룹니다.")
    return items


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("root")
    ap.add_argument("--deployment", default="")
    ap.add_argument("--build", default="")
    ap.add_argument("--account", default="")
    ap.add_argument("--database-id", default="")
    ap.add_argument("--commit", default="")
    a = ap.parse_args()

    root = os.path.abspath(a.root)
    recover = os.path.join(root, "운영복구용")
    deliver = os.path.join(root, "전달용")
    sql_path = os.path.join(recover, "database-before-reset.sql")
    if not os.path.isfile(sql_path):
        die(f"스냅샷이 없습니다: {sql_path}")
    if os.path.isdir(deliver) and os.listdir(deliver):
        die("전달용/ 이 비어 있지 않습니다. 이전 백업을 덮어쓰지 않습니다.")
    os.makedirs(deliver, exist_ok=True)

    # ── 1. SQL → 로컬 사본 ─────────────────────────────────────────
    db_path = os.path.join(recover, "source.sqlite")
    if os.path.exists(db_path):
        os.remove(db_path)
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    with open(sql_path, encoding="utf-8") as f:
        con.executescript(f.read())
    con.commit()

    counts = {t: con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
              for t in ("teachers", "sessions", "quiz_sets", "rooms", "game_records")}
    orphan = con.execute("SELECT COUNT(*) FROM quiz_sets WHERE teacher_id NOT IN (SELECT id FROM teachers)").fetchone()[0]
    if orphan:
        die(f"주인 없는 퀴즈가 {orphan}개 있습니다. 빼지 않고 멈춥니다.")

    # ── 2. 복구용 JSON ──────────────────────────────────────────────
    teachers = [dict(r) for r in con.execute(
        "SELECT id, display_name, is_super, created_at, last_login_at FROM teachers ORDER BY id")]
    quiz_rows = [dict(r) for r in con.execute(
        "SELECT id, teacher_id, title, items_json, item_count, source_name, skipped, problems_json, "
        "created_at, updated_at, used_at FROM quiz_sets ORDER BY teacher_id, id")]
    rooms = [dict(r) for r in con.execute(
        "SELECT code, status, teacher_id, label, quiz_set_id, quiz_title, created_at, last_active_at, closed_at "
        "FROM rooms ORDER BY created_at")]

    def dump(name: str, obj: object) -> None:
        with open(os.path.join(recover, name), "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, indent=1)
            f.write("\n")

    dump("teachers.json", teachers)
    dump("rooms-before-close.json", rooms)

    quizzes_full = []
    for row in quiz_rows:
        items = check_items(row["id"], json.loads(row["items_json"]))
        if row["item_count"] != len(items):
            die(f"quiz {row['id']}: item_count({row['item_count']}) 와 실제 문항 수({len(items)}) 가 다릅니다.")
        q = dict(row)
        q["items"] = items
        del q["items_json"]
        quizzes_full.append(q)
    dump("quiz_sets.json", quizzes_full)

    # ── 3. 선생님 폴더 이름 — 동명이인은 아이디로 가른다 ─────────────
    by_name: dict[str, list[dict]] = {}
    for t in teachers:
        by_name.setdefault(safe_name(t["display_name"]), []).append(t)
    folder_of: dict[str, str] = {}
    for name, group in by_name.items():
        for t in group:
            folder_of[t["id"]] = name if len(group) == 1 else f"{name}__{safe_name(t['id'])}"

    # ── 4. 전달용 CSV ───────────────────────────────────────────────
    manifest_quizzes = []
    per_teacher: dict[str, list[dict]] = {t["id"]: [] for t in teachers}
    used_paths: set[str] = set()
    for q in quizzes_full:
        folder = os.path.join(deliver, folder_of[q["teacher_id"]], "엑셀모음")
        os.makedirs(folder, exist_ok=True)
        fname = f"{safe_name(q['title'])}__quiz-{q['id']}.csv"
        rel = os.path.relpath(os.path.join(folder, fname), root)
        if rel in used_paths:
            die(f"파일 이름이 겹칩니다: {rel}")
        used_paths.add(rel)
        full = os.path.join(root, rel)
        if os.path.commonpath([root, os.path.realpath(os.path.dirname(full))]) != root:
            die(f"백업 루트 밖으로 나가는 경로: {rel}")
        with open(full, "w", encoding="utf-8", newline="") as f:
            f.write(to_csv(q["items"]))
        entry = {
            "id": q["id"], "title": q["title"], "teacherId": q["teacher_id"],
            "itemCount": len(q["items"]), "csv": rel, "csvSha256": sha256_file(full),
            "itemsSha256": items_hash(q["items"]),
            "sourceName": q["source_name"], "createdAt": q["created_at"], "updatedAt": q["updated_at"],
        }
        manifest_quizzes.append(entry)
        per_teacher[q["teacher_id"]].append(entry)

    def kst(ms) -> str:
        return datetime.fromtimestamp(ms / 1000, KST).strftime("%Y-%m-%d %H:%M") if ms else ""

    manifest_teachers = []
    for t in teachers:
        tdir = os.path.join(deliver, folder_of[t["id"]])
        os.makedirs(os.path.join(tdir, "엑셀모음"), exist_ok=True)
        mine = per_teacher[t["id"]]
        # 퀴즈목록.csv — 사람이 읽는 표. 퀴즈 파일 수에는 넣지 않는다.
        lines = ["﻿제목,파일,문항수,만든날,고친날,원본파일명"]
        for e in mine:
            lines.append(",".join(csv_cell(x) for x in [
                e["title"], os.path.basename(e["csv"]), str(e["itemCount"]),
                kst(e["createdAt"]), kst(e["updatedAt"]), e["sourceName"] or ""]))
        with open(os.path.join(tdir, "퀴즈목록.csv"), "w", encoding="utf-8", newline="") as f:
            f.write("\r\n".join(lines) + "\r\n")
        with open(os.path.join(tdir, "다시올리는방법.txt"), "w", encoding="utf-8") as f:
            f.write(HOWTO.format(name=t["display_name"], n=len(mine),
                                 total=sum(e["itemCount"] for e in mine)))
        manifest_teachers.append({
            "id": t["id"], "name": t["display_name"], "isSuper": bool(t["is_super"]),
            "folder": os.path.relpath(tdir, root), "quizCount": len(mine),
            "itemCount": sum(e["itemCount"] for e in mine),
            "createdAt": t["created_at"], "lastLoginAt": t["last_login_at"],
        })

    # ── 5. manifest ────────────────────────────────────────────────
    manifest = {
        "runId": os.path.basename(root),
        "backedUpAt": datetime.now(KST).isoformat(timespec="seconds"),
        "cloudflare": {"account": a.account, "databaseId": a.database_id, "databaseName": "treasure",
                       "worker": "treasure-island-v2", "deployment": a.deployment, "build": a.build},
        "sourceCommit": a.commit,
        "snapshot": {"file": "운영복구용/database-before-reset.sql",
                     "sha256": sha256_file(sql_path), "rowCounts": counts},
        "teachers": manifest_teachers,
        "quizzes": manifest_quizzes,
        "totals": {"teachers": len(teachers), "quizzes": len(manifest_quizzes),
                   "items": sum(e["itemCount"] for e in manifest_quizzes)},
        "tool": {"name": "backup-neobus-quizzes.py", "version": TOOL_VERSION,
                 "python": sys.version.split()[0], "sqlite": sqlite3.sqlite_version},
    }
    with open(os.path.join(root, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
        f.write("\n")

    # ── 6. checksums — 고정된 파일만. 자기 자신과 실행기록은 뺀다 ────
    fixed = []
    for dirpath, _, files in os.walk(root):
        for fn in files:
            if fn in ("checksums.sha256", "실행기록.md", "verification.json", "source.sqlite"):
                continue
            fixed.append(os.path.relpath(os.path.join(dirpath, fn), root))
    with open(os.path.join(root, "checksums.sha256"), "w", encoding="utf-8") as f:
        for rel in sorted(fixed):
            f.write(f"{sha256_file(os.path.join(root, rel))}  {rel}\n")

    os.chmod(recover, 0o700)
    print(f"✅ 선생님 {len(teachers)}명 · 퀴즈 {len(manifest_quizzes)}개 · 문항 {manifest['totals']['items']}개")
    for t in manifest_teachers:
        print(f"   {t['folder']:<24} 퀴즈 {t['quizCount']}개 · 문항 {t['itemCount']}개")
    print(f"   행 수: {counts}")


HOWTO = """{name} 선생님께

보물섬 점령전이 네오버스 로그인으로 바뀌면서, 선생님이 올려 두셨던 퀴즈 {n}개(문항 {total}개)를
이 폴더에 파일로 담았습니다.

■ 다시 올리는 방법
  1. 네오버스에 로그인한 뒤 보물섬 점령전에 들어갑니다.
  2. 📚 퀴즈 보관함 → 업로드 를 누릅니다.
  3. 「엑셀모음」 폴더 안의 .csv 파일을 하나씩 올립니다.
     제목 칸에는 원래 제목을 적어 주세요. 원래 제목은 「퀴즈목록.csv」에 있습니다.
     (파일 이름 끝의 __quiz-숫자 는 구분용이라 제목에 넣지 않으셔도 됩니다)
  4. 「퀴즈목록.csv」 자체는 퀴즈가 아니므로 올리지 않습니다.

■ 알아 두실 것
  · 이 파일들은 "그때 올리신 원본 파일" 이 아니라 "지금 등록돼 있는 문항" 을 다시 만든 것입니다.
    올릴 때 건너뛰었던 줄은 들어 있지 않습니다.
  · 파일은 그대로 올릴 수 있습니다. 엑셀에서 열어 저장하면 형식이 바뀔 수 있으니,
    고칠 것이 없으면 열지 말고 그대로 올리시는 편이 안전합니다.
  · 처음 들어오면 「상식1(샘플)」 이 자동으로 들어 있습니다. 같은 제목을 올리면 덮어쓸지 묻습니다.
"""

if __name__ == "__main__":
    main()
