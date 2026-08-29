/**
 * 방 하나의 DO 내장 SQLite 스키마. 수업이 도는 동안의 정본이다.
 *
 * ensureSchema() 가 생성자와 init() 두 곳에서 멱등 실행한다.
 * 방을 정리할 때 ctx.storage.deleteAll() 로 테이블까지 지우는데, 같은 DO 인스턴스가
 * 메모리에 남아 있으면 생성자가 다시 돌지 않는다. init() 에서 한 번 더 보장하지 않으면
 * 재사용된 방번호가 SQL 오류로 죽는다.
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS room (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  code           TEXT    NOT NULL,
  teacher_id     TEXT    NOT NULL,
  label          TEXT,
  quiz_set_id    INTEGER,
  quiz_title     TEXT,
  status         TEXT    NOT NULL DEFAULT 'waiting',
  game_id        TEXT,
  rows           INTEGER NOT NULL DEFAULT 12,
  cols           INTEGER NOT NULL DEFAULT 12,
  round          INTEGER NOT NULL DEFAULT 1,
  round_limit    INTEGER NOT NULL DEFAULT 10,
  turn_team      TEXT,
  turn_ends_at   INTEGER,
  turn_seconds   INTEGER NOT NULL DEFAULT 20,
  cnt_t          INTEGER NOT NULL DEFAULT 8,
  cnt_s          INTEGER NOT NULL DEFAULT 7,
  cnt_a          INTEGER NOT NULL DEFAULT 7,
  bonus_h        INTEGER NOT NULL DEFAULT 0,
  bonus_c        INTEGER NOT NULL DEFAULT 0,
  rev            INTEGER NOT NULL DEFAULT 0,
  last_turn_at   INTEGER,
  last_cmd_id    TEXT,
  last_cmd_result TEXT,
  provision_id   TEXT,
  created_at     INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS quizzes (
  idx     INTEGER PRIMARY KEY,
  q       TEXT    NOT NULL,
  options TEXT    NOT NULL,
  ans     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cells (
  idx          INTEGER PRIMARY KEY,
  type         TEXT    NOT NULL,
  quiz_idx     INTEGER NOT NULL,
  owner        TEXT,
  owned_by     TEXT,
  bonus_taken  INTEGER NOT NULL DEFAULT 0,
  tried        INTEGER NOT NULL DEFAULT 0,
  locked_by    TEXT,
  locked_until INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cells_owner ON cells(owner);

CREATE TABLE IF NOT EXISTS players (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL UNIQUE,
  team                 TEXT NOT NULL,
  pos                  INTEGER,
  skip_turns           INTEGER NOT NULL DEFAULT 0,
  skip_turn_key        TEXT,
  last_played_turn_key TEXT,
  attempt_cell         INTEGER,
  attempt_started_at   INTEGER,
  solved               INTEGER NOT NULL DEFAULT 0,
  correct              INTEGER NOT NULL DEFAULT 0,
  last_action_id       TEXT,
  last_action_result   TEXT,
  joined_at            INTEGER NOT NULL,
  last_seen_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        INTEGER NOT NULL,
  kind      TEXT    NOT NULL,
  player_id TEXT,
  cell      INTEGER,
  detail    TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_at ON events(at);

-- 방금 끝난 턴에 각 팀이 한 일. 선생님 화면의 3D 무대가 이것만 보고 그린다. 팀당 한 줄.
-- room 에 컬럼을 더하지 않은 이유: 여기는 CREATE TABLE IF NOT EXISTS 뿐이라 이미 만들어져
-- 돌고 있는 방의 DO 에는 새 컬럼이 안 생긴다. 새 테이블은 안전하다.
CREATE TABLE IF NOT EXISTS fx (
  team   TEXT PRIMARY KEY,
  detail TEXT    NOT NULL,
  at     INTEGER NOT NULL
);

-- 공격칸을 처음 점령해 "땅을 하나 빼앗을 권리" 를 얻은 학생. 쓰면 지운다.
-- 예전에는 서버가 아무 칸이나 골라 즉시 빼앗았지만, 2026-08-29 부터는 학생이 직접 고른다.
-- players 에 컬럼을 더하지 않은 이유는 위 fx 와 같다 — 돌고 있는 방에는 새 컬럼이 안 생긴다.
CREATE TABLE IF NOT EXISTS steals (
  player_id  TEXT PRIMARY KEY,
  granted_at INTEGER NOT NULL
);
`;
