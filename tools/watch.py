#!/usr/bin/env python3
"""수업이 진행되는 동안 게임을 실시간으로 지켜본다.

  python3 tools/watch.py <관리자비번>              # 3초마다 새로 고침
  python3 tools/watch.py <관리자비번> --every 2    # 간격 바꾸기
  python3 tools/watch.py <관리자비번> --save       # 화면에 뿌린 내용을 logs/ 에도 남긴다

fetch-log.py 는 수업이 끝난 뒤 돌아보는 도구이고, 이 도구는 수업 도중에 쓴다.
서버 로그만으로는 "학생 화면이 멈췄다"를 볼 수 없다 — 멈춘 화면은 요청 자체를 안 보내기
때문이다. 그래서 이 도구는 "요청이 오지 않는 것" 자체를 증상으로 잡아낸다.

  · 자기 팀 턴인데 아무 요청도 안 보낸 학생  → ⛔ 멈춤
  · 접속은 살아 있는데 오래 조용한 학생        → ⚠ 의심
  · 화면이 보낸 진단 신호(client 이벤트)       → 그대로 표시

Ctrl+C 로 끝낸다.
"""
import json
import re
import sys
import time
import urllib.request
from collections import deque
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


class Api:
    """관리자 토큰은 자주 만료된다. 만료되면 말없이 다시 로그인한다."""

    def __init__(self, url, secret, pw):
        self.url, self.secret, self.pw = url, secret, pw
        self.token = None
        self.relogins = 0

    def raw(self, action, payload, timeout=40):
        body = json.dumps({"secret": self.secret, "action": action, "payload": payload}).encode()
        req = urllib.request.Request(self.url, data=body,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as res:
            text = res.read().decode()
        try:
            return json.loads(text)
        except ValueError:
            return {"ok": False, "error": "JSON 아님: " + text[:120]}

    def login(self):
        r = self.raw("loginAsAdmin", {"pw": self.pw})
        if not r.get("ok"):
            raise SystemExit("로그인 실패: " + str(r.get("error")))
        self.token = r["token"]

    def call(self, action, payload, timeout=40):
        if not self.token:
            self.login()
        r = self.raw(action, dict(payload, token=self.token), timeout)
        if not r.get("ok") and "인증이 만료" in str(r.get("error", "")):
            self.relogins += 1
            self.login()
            r = self.raw(action, dict(payload, token=self.token), timeout)
        return r


def label(i, cols):
    if i is None:
        return "--"
    r, c = divmod(i, cols)
    return chr(65 + c) + str(r + 1)


def neighbors(i, rows, cols):
    r, c = divmod(i, cols)
    return [(r + dr) * cols + (c + dc)
            for dr in (-1, 0, 1) for dc in (-1, 0, 1)
            if (dr or dc) and 0 <= r + dr < rows and 0 <= c + dc < cols]


def clock(ts):
    try:
        return datetime.fromtimestamp(ts / 1000).strftime("%H:%M:%S")
    except Exception:
        return str(ts)


def detail(ev):
    if "detail" in ev:
        try:
            return json.loads(ev["detail"]) if ev["detail"] else {}
        except ValueError:
            return {"raw": ev["detail"]}
    return {k: v for k, v in ev.items() if k not in ("t", "e", "name", "team", "cell")}


def ago(seconds):
    if seconds is None:
        return "없음"
    if seconds < 60:
        return f"{int(seconds)}초"
    return f"{int(seconds // 60)}분{int(seconds % 60):02d}초"


# 학생이 스스로 보낸 요청으로 인정하는 이벤트. 이게 끊기면 화면이 멈춘 것이다.
STUDENT_ACTIONS = {"pickCell", "answer", "fail", "joinAsStudent", "client"}


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    pw = sys.argv[1]
    every = 3.0
    if "--every" in sys.argv:
        every = float(sys.argv[sys.argv.index("--every") + 1])
    save = "--save" in sys.argv

    url, secret = config()
    api = Api(url, secret, pw)
    api.login()

    out = None
    if save:
        (ROOT / "logs").mkdir(exist_ok=True)
        path = ROOT / "logs" / f"watch_{datetime.now():%Y%m%d_%H%M%S}.txt"
        out = path.open("w", encoding="utf-8")
        print(f"기록: {path}")

    def say(line=""):
        print(line, flush=True)
        if out:
            out.write(line + "\n")
            out.flush()

    seen = set()                 # 이미 뿌린 로그 이벤트
    last_seen = {}               # 짧은 pid -> 마지막 요청 시각(ms)
    last_turn_key = None
    quiet_turns = {}             # 짧은 pid -> 자기 팀 턴인데 조용히 넘어간 횟수
    skew = {}                    # 짧은 pid -> 그 학생 컴퓨터의 시계 차이
    blocked_by = {}              # 짧은 pid -> 화면이 알려 준 "못 누르는 이유"
    ticks = 0
    recent = deque(maxlen=200)

    say(f"실시간 감시 시작 · {every:g}초 간격 · Ctrl+C 로 종료")
    say("=" * 78)

    while True:
        ticks += 1
        try:
            st = api.call("getState", {"rev": -1})
            if not st.get("ok"):
                say(f"{datetime.now():%H:%M:%S} ⚠ 상태 조회 실패: {st.get('error')}")
                time.sleep(every)
                continue

            now = int(time.time() * 1000)
            rows, cols = st.get("rows", 12), st.get("cols", 12)
            board = st.get("board") or []
            players = st.get("players") or {}
            online = set(st.get("presence") or [])
            turn_team = st.get("turnTeam")
            turn_key = f"{st.get('round')}:{turn_team}"

            # ── 로그를 두 번에 한 번만 받아 온다(서버 부담을 줄인다)
            if ticks % 2 == 1:
                lg = api.call("adminGetLog", {"limit": 300}, timeout=60)
                events = list(lg.get("sheet") or []) + list(lg.get("pending") or [])
                events.sort(key=lambda e: e.get("t") or 0)
                for ev in events:
                    key = (ev.get("t"), ev.get("e"), json.dumps(ev, sort_keys=True)[:120])
                    if key in seen:
                        continue
                    seen.add(key)
                    d = detail(ev)
                    pid = str(d.get("pid") or "")
                    kind = ev.get("e")
                    if pid and kind in STUDENT_ACTIONS:
                        last_seen[pid] = ev.get("t") or now
                    # 화면이 알려 준 시계 차이를 기억해 둔다. 몇 초만 어긋나도 못 누르게 된다.
                    if kind == "client" and pid and d.get("시계차"):
                        skew[pid] = str(d.get("시계차"))
                    if kind == "client" and pid and d.get("tag") == "blocked":
                        blocked_by[pid] = str(d.get("이유") or "")
                    if ticks > 1:          # 첫 회차의 과거 로그는 뿌리지 않는다
                        recent.append(ev)
                        mark = {"fail": "  ✗", "client": "  ★"}.get(kind, "   ")
                        who = ev.get("name") or pid or ""
                        info = d.get("msg") or d.get("tag") or ""
                        extra = " ".join(f"{k}={v}" for k, v in d.items()
                                         if k not in ("pid", "ms", "a", "msg"))
                        say(f"{mark} {clock(ev.get('t'))} {str(kind):13s} {str(who):8s} "
                            f"{str(info)[:46]:46s} {extra[:70]}")

            # ── 턴이 바뀌었으면, 직전 턴에 조용했던 학생을 센다
            if last_turn_key and turn_key != last_turn_key:
                prev_team = last_turn_key.split(":")[1]
                for pid_full, p in players.items():
                    short = pid_full.split("_")[-1]
                    if p.get("team") != prev_team:
                        continue
                    seen_at = last_seen.get(short)
                    if seen_at and now - seen_at < 40000:
                        quiet_turns[short] = 0
                    else:
                        quiet_turns[short] = quiet_turns.get(short, 0) + 1
            last_turn_key = turn_key

            # ── 대시보드
            left = (st.get("turnEndsAt") or 0) - now
            head = (f"\n[{datetime.now():%H:%M:%S}] {st.get('status')} · "
                    f"R{st.get('round')}/{st.get('roundLimit')} · "
                    f"{'홍팀' if turn_team == 'H' else '청팀' if turn_team == 'C' else '대기'} 턴 · "
                    f"남은 {max(0, left) // 1000}초 · 접속 {len(online)}명 · "
                    f"점수 홍 {st.get('scores', {}).get('H', {}).get('total')} : "
                    f"청 {st.get('scores', {}).get('C', {}).get('total')}")
            say(head)
            say(f"  {'이름':<8} {'팀':<3} {'위치':<5} {'도전가능':>6} {'접속':<4} "
                f"{'시계차':>6} {'마지막요청':>10}  상태")

            alarms = []
            for pid_full, p in sorted(players.items(), key=lambda kv: kv[1].get("name") or ""):
                short = pid_full.split("_")[-1]
                pos = p.get("pos")
                free = 0
                if pos is not None and board:
                    free = sum(1 for n in neighbors(pos, rows, cols)
                               if board[n].get("o") != p.get("team"))
                seen_at = last_seen.get(short)
                since = (now - seen_at) / 1000 if seen_at else None
                on = pid_full in online
                quiet = quiet_turns.get(short, 0)

                sk = skew.get(short, "")
                bad_clock = sk and sk not in ("0초", "-0초", "1초", "-1초", "2초", "-2초")

                if st.get("status") != "running":
                    status = "· 게임 대기/종료"
                elif not on:
                    status = "· 접속 끊김"
                elif bad_clock:
                    status = f"⛔ 컴퓨터 시계가 {sk} 어긋남 → 시간 동기화 필요"
                    alarms.append((p.get("name"), "컴퓨터 시계를 맞춰 주세요(설정→시간→지금 동기화)"))
                elif pos is not None and free == 0:
                    status = "⚠ 도전할 칸이 없음 → [다음 턴]이 구출"
                elif quiet >= 2:
                    status = f"⛔ 자기 팀 턴 {quiet}회 동안 요청 0건 — 화면 멈춤 의심"
                    alarms.append((p.get("name"), "나갔다 다시 들어오게 하세요(F5 → 이름 재입력)"))
                elif quiet == 1:
                    status = "⚠ 직전 자기 팀 턴에 조용했음"
                elif blocked_by.get(short):
                    status = f"· 화면이 막힘: {blocked_by[short]}"
                elif since is None:
                    status = "· 아직 요청 없음"
                else:
                    status = "정상"

                say(f"  {str(p.get('name')):<8} {'홍' if p.get('team') == 'H' else '청':<3} "
                    f"{label(pos, cols):<5} {free:>6} {'O' if on else 'X':<4} "
                    f"{(sk or '-'):>6} {ago(since):>10}  {status}")

            if alarms:
                say("")
                for name, how in alarms:
                    say(f"  >>> {name}: {how}")

        except KeyboardInterrupt:
            raise
        except Exception as err:                       # 감시 도구가 수업을 방해하면 안 된다
            say(f"{datetime.now():%H:%M:%S} ⚠ 감시 오류(계속 진행): {type(err).__name__} {err}")

        try:
            time.sleep(every)
        except KeyboardInterrupt:
            break

    if out:
        out.close()
    say("\n감시 종료")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n감시 종료")
