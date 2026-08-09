#!/usr/bin/env python3
"""배포된 게임의 현재 상태를 확인한다.

  python3 tools/check-state.py            # 배포 버전만 확인(비번 불필요)
  python3 tools/check-state.py <관리자비번>  # 학생 배치까지 확인

curl 로는 Apps Script 의 POST 리디렉션을 통과하지 못해 Google 로그인 HTML 이 돌아온다.
urllib 은 302 를 GET 으로 따라가는 정상 흐름을 타므로 그대로 동작한다.
"""
import json
import re
import sys
import urllib.request
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def config():
    """wrangler.jsonc 의 웹앱 URL 과 .dev.vars 의 공유 비밀을 읽는다."""
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
    with urllib.request.urlopen(req, timeout=40) as res:
        text = res.read().decode()
    try:
        return json.loads(text)
    except ValueError:
        return {"ok": False, "error": "JSON 아님: " + text[:150]}


def label(i, cols):
    r, c = divmod(i, cols)
    return chr(65 + c) + str(r + 1)


def neighbors(i, rows, cols):
    """둘레 8칸 — 서버 neighbors8_ 과 같은 규칙."""
    r, c = divmod(i, cols)
    return [(r + dr) * cols + (c + dc)
            for dr in (-1, 0, 1) for dc in (-1, 0, 1)
            if (dr or dc) and 0 <= r + dr < rows and 0 <= c + dc < cols]


def main():
    url, secret = config()

    with urllib.request.urlopen(url, timeout=30) as res:
        info = json.loads(res.read().decode())
    print(f"배포: version {info.get('version')} · 이동 {info.get('move')} · 점검 {info.get('diagnose')}")
    expected = 19  # app.js 의 APP_VERSION 과 같아야 한다
    if info.get("version") != expected:
        print(f"⚠ 서버가 v{info.get('version')} 입니다. 화면은 v{expected} 이므로 Apps Script를 다시 배포해 주세요.")

    if len(sys.argv) < 2:
        print("\n(학생 배치까지 보려면: python3 tools/check-state.py <관리자비번>)")
        return

    login = post(url, secret, "loginAsAdmin", {"pw": sys.argv[1]})
    if not login.get("ok"):
        print("로그인 실패:", login.get("error"))
        return

    st = post(url, secret, "getState", {"token": login["token"], "rev": -1})
    if not st.get("ok"):
        print("getState 실패:", st.get("error"))
        return

    rows, cols = st.get("rows", 12), st.get("cols", 12)
    board, players = st.get("board") or [], st.get("players") or {}
    sc = st.get("scores", {})
    print(f"\n{st.get('status')} · {rows}x{cols} · 라운드 {st.get('round')}/{st.get('roundLimit')}"
          f" · 차례 {st.get('turnTeam')}")
    print(f"학생 {len(players)}명 · 점수 홍 {sc.get('H',{}).get('total')} : 청 {sc.get('C',{}).get('total')}")

    if not (players and board):
        print("(새 게임을 눌러 보드를 만들어 주세요)")
        return

    placed = [p for p in players.values() if p.get("pos") is not None]
    pos = [p["pos"] for p in placed]
    stuck = [p["name"] for p in placed
             if all(board[n].get("o") == p["team"] for n in neighbors(p["pos"], rows, cols))]

    print(f"겹친 말 {len(pos) - len(set(pos))}개"
          f" · 둘레가 전부 아군이라 문제를 못 받는 학생 {len(stuck)}명 {stuck if stuck else ''}")
    print("팀:", dict(Counter(p["team"] for p in players.values())))
    print("위치:", ", ".join(f"{p['name']}({label(p['pos'], cols)})" for p in placed))
    owned = Counter(c.get("o") for c in board if c.get("o"))
    print("점령 칸:", dict(owned) or "없음")

    if stuck:
        print("\n⚠ 갇힌 학생이 있습니다. [턴]을 누르면 rescueTrapped_ 가 자동으로 옮깁니다.")
    elif len(pos) != len(set(pos)):
        print("\n⚠ 말이 겹쳤습니다. [새 게임]을 눌러 재배치해 주세요.")
    else:
        print("\n정상: 모든 학생이 흩어져 있고 각자 도전할 칸이 있습니다.")


if __name__ == "__main__":
    main()
