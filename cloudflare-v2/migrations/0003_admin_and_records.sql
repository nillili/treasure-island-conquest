-- 슈퍼관리자와 수업 기록 — 전체를 볼 수 있는 관제 화면의 바탕.

-- ── 슈퍼관리자 ─────────────────────────────────────────────
-- 0 이 보통 선생님, 1 이 전체를 볼 수 있는 사람.
-- 따로 표를 두지 않은 이유: 계정을 확인할 때마다 표를 하나 더 뒤지는 값을 치를 이유가 없다.
ALTER TABLE teachers ADD COLUMN is_super INTEGER NOT NULL DEFAULT 0;

-- ── 수업 기록 ──────────────────────────────────────────────
-- 2026-08-09 에 results 표를 지웠던 이유는 "학생 이름이 서버에 계속 쌓인다" 였다.
-- 그래서 이 표에는 이름이 한 글자도 들어가지 않는다. 몇 명이 몇 문제를 풀었는지까지만 센다.
-- 관제 화면이 답해야 하는 질문은 "언제 했고, 잘 돌았나" 이지 "누가 잘했나" 가 아니다.
CREATE TABLE game_records (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  room_code    TEXT    NOT NULL,
  game_key     TEXT    NOT NULL,             -- 방 안에서 판을 가리키는 이름(DO 의 game_id)
  teacher_id   TEXT    REFERENCES teachers(id) ON DELETE CASCADE,
  label        TEXT,                         -- 반 이름. 방을 지워도 남는 사본
  quiz_title   TEXT,
  started_at   INTEGER NOT NULL,             -- [새 게임]을 누른 시각
  ended_at     INTEGER NOT NULL,
  rounds       INTEGER NOT NULL,             -- 실제로 돈 라운드
  round_limit  INTEGER NOT NULL,             -- 하기로 했던 라운드
  h_total      INTEGER NOT NULL,
  c_total      INTEGER NOT NULL,
  winner       TEXT    NOT NULL,             -- 홍팀 | 청팀 | 무승부
  player_count INTEGER NOT NULL,
  solved       INTEGER NOT NULL,             -- 전체 시도 수(이름 없이 합계만)
  correct      INTEGER NOT NULL,             -- 전체 정답 수
  issues_json  TEXT    NOT NULL DEFAULT '[]' -- 이상 징후 [{kind, level, detail}]
);
CREATE INDEX idx_game_records_teacher ON game_records(teacher_id, ended_at DESC);
CREATE INDEX idx_game_records_time ON game_records(ended_at);

-- 같은 판이 두 번 적히면 안 된다. [종료] 버튼과 마지막 턴 자동 종료가 겹쳐 들어올 수 있다.
-- game_key 는 [새 게임]마다 새로 붙으므로, 이 짝이 곧 "그 판" 이다.
CREATE UNIQUE INDEX idx_game_records_once ON game_records(room_code, game_key);
