#!/usr/bin/env python3
"""수업이 끝난 뒤 게임 로그를 내려받아 요약한다.

  python3 tools/fetch-log.py <관리자비번>            # 요약만
  python3 tools/fetch-log.py <관리자비번> --full     # 전체 이벤트까지
  python3 tools/fetch-log.py <관리자비번> --save     # logs/ 에 JSON 저장(분석 의뢰용)

문제가 생겼을 때는 --save 로 저장한 파일을 그대로 보여 주면 된다.
"""
import json
import re
import sys
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def config():
    raw = (ROOT / "cloudflare" / "wrangler.jsonc").read_text(encoding="utf-8")
    raw = re.sub(r"^\s*//.*$", "", raw, flags=re.M)
    url = json.loads(re.sub(r",(\s*[}\]])", r"\1", raw))["vars"]["APPS_SCRIPT_URL"]
    secret = ""
    for line in (ROOT / "cloudflare" / ".dev.vars").read_text(encoding="utf-8").splitlines():
        if line.startswith("APPS_SCRIPT_SECRET"):
            secret = line.split("=", 1)[1].strip().strip("\"'")
    return url, secret


def post(url, secret, action, payload):
    body = json.dumps({"secret": secret, "action": action, "payload": payload}).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as res:
        text = res.read().decode()
    try:
        return json.loads(text)
    except ValueError:
        return {"ok": False, "error": "JSON 아님: " + text[:150]}


def when(ts):
    try:
        return datetime.fromtimestamp(ts / 1000).strftime("%H:%M:%S")
    except Exception:
        return str(ts)


def detail(ev):
    """시트에서 온 행과 캐시에 남은 행의 모양을 하나로 맞춘다."""
    if "detail" in ev:
        try:
            return json.loads(ev["detail"]) if ev["detail"] else {}
        except ValueError:
            return {"raw": ev["detail"]}
    return {k: v for k, v in ev.items() if k not in ("t", "e", "name", "team", "cell")}


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    pw = sys.argv[1]
    full = "--full" in sys.argv
    save = "--save" in sys.argv

    url, secret = config()
    login = post(url, secret, "loginAsAdmin", {"pw": pw})
    if not login.get("ok"):
        print("로그인 실패:", login.get("error"))
        return

    res = post(url, secret, "adminGetLog", {"token": login["token"], "limit": 2000})
    if not res.get("ok"):
        print("로그 조회 실패:", res.get("error"))
        return

    events = list(res.get("sheet") or []) + list(res.get("pending") or [])
    events.sort(key=lambda e: e.get("t") or 0)
    if not events:
        print("로그가 비어 있습니다. 수업을 한 번 진행한 뒤 다시 실행하세요.")
        return

    print(f"이벤트 {len(events)}개 "
          f"(시트 {len(res.get('sheet') or [])} · 아직 안 내려간 것 {res.get('pendingCount', 0)})")
    if events:
        print(f"기간 {when(events[0].get('t'))} ~ {when(events[-1].get('t'))}\n")

    kinds = Counter(e.get("e") for e in events)
    print("이벤트 종류:", dict(kinds))

    # ── 사고 신호 ────────────────────────────────────────────────
    noquiz = [e for e in events if e.get("e") == "noquiz"]
    if noquiz:
        print(f"\n⚠ 자기 차례인데 받을 문제가 없던 경우 {len(noquiz)}건 ← 어제 터진 그 증상")
        for e in noquiz[:15]:
            d = detail(e)
            print(f"   {when(e.get('t'))} {e.get('name')}({e.get('team')}) "
                  f"@{d.get('at')} 라운드{d.get('round')} 주변 빈칸 {d.get('free')}")
    else:
        print("\n정상: '차례인데 문제를 못 받은' 경우 0건")

    fails = [e for e in events if e.get("e") == "fail"]
    if fails:
        msgs = Counter(detail(e).get("msg", "?") for e in fails)
        print(f"\n실패 {len(fails)}건 — 사유별")
        for msg, n in msgs.most_common(12):
            print(f"   {n:4d}  {msg}")

    # ── 배치 ─────────────────────────────────────────────────────
    places = [e for e in events if e.get("e") == "placement"]
    if places:
        print(f"\n배치 스냅샷 {len(places)}개")
        for e in places[:6]:
            d = detail(e)
            flag = ""
            if d.get("dup"):
                flag += f" ⚠겹침{d['dup']}"
            if d.get("stuck"):
                flag += f" ⚠갇힘[{d['stuck']}]"
            print(f"   {when(e.get('t'))} {d.get('why')}: {d.get('n')}명{flag or ' 정상'}")
        if len(places) > 6:
            print(f"   … 외 {len(places)-6}개 (--full 로 전체)")

    # ── 참여도: 이게 핵심이다 ────────────────────────────────────
    answers = [e for e in events if e.get("e") == "answer"]
    if answers:
        by_pid = defaultdict(lambda: [0, 0])
        for e in answers:
            d = detail(e)
            pid = d.get("pid", "?")
            by_pid[pid][0] += 1
            if d.get("hit"):
                by_pid[pid][1] += 1
        names = {}
        for e in events:
            if e.get("e") == "joinAsStudent":
                d = detail(e)
                if d.get("pid"):
                    names[d["pid"]] = d.get("name", "?")
        print(f"\n학생별 참여 (푼 문제 / 맞힌 문제) — 총 {len(answers)}문제")
        rows = sorted(by_pid.items(), key=lambda kv: -kv[1][0])
        for pid, (tried, hit) in rows:
            print(f"   {names.get(pid, pid):>10}  {tried:3d}문제  정답 {hit}")
        counts = [v[0] for v in by_pid.values()]
        if counts:
            print(f"   → 참여 {len(counts)}명 · 최다 {max(counts)}문제 · 최소 {min(counts)}문제")
            if max(counts) - min(counts) >= 3:
                print("   ⚠ 학생 간 편차가 큽니다. 일부만 플레이했을 수 있습니다.")

    turns = [e for e in events if e.get("e") == "adminNextTurn"]
    if turns:
        print(f"\n턴 전환 {len(turns)}회")

    if full:
        print("\n── 전체 이벤트 ──")
        for e in events:
            print(f"{when(e.get('t'))} {e.get('e'):14} {e.get('name') or '':>8} {detail(e)}")

    if save:
        out = ROOT / "logs"
        out.mkdir(exist_ok=True)
        path = out / f"game-{datetime.now():%Y%m%d-%H%M}.json"
        path.write_text(json.dumps(events, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"\n저장: {path.relative_to(ROOT)}  ← 문제가 있으면 이 파일을 보여 주세요")


if __name__ == "__main__":
    main()
