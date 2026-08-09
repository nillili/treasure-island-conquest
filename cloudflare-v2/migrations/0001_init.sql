-- 보물섬 점령전 v2 — 전역 데이터(계정 · 보관함 · 방 목록 · 결과)
-- 수업이 도는 동안에는 이 DB 를 건드리지 않는다. 진행 중 정본은 방마다의 DO SQLite 다.

-- ── 선생님 계정 ────────────────────────────────────────────
CREATE TABLE teachers (
  id            TEXT PRIMARY KEY,          -- 로그인 아이디 (영문/숫자 4~20자)
  display_name  TEXT NOT NULL,
  pw_salt       TEXT NOT NULL,
  pw_hash       TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE sessions (
  token      TEXT PRIMARY KEY,
  teacher_id TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_expire ON sessions(expires_at);

-- ── 퀴즈 보관함 ────────────────────────────────────────────
-- 문항을 행으로 쪼개지 않고 JSON 한 컬럼에 둔다.
-- 문항을 SQL 로 조회할 일이 한 번도 없고, 이렇게 두면 덮어쓰기가 UPDATE 한 줄이라
-- "중간에 실패해서 빈 세트가 남는" 경우가 설계에서 사라진다.
CREATE TABLE quiz_sets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id    TEXT    NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  title         TEXT    NOT NULL,          -- "국어1", "사회1" — 게임 좌상단에 보이는 이름
  items_json    TEXT    NOT NULL,          -- [{q, options:[...], ans}]
  item_count    INTEGER NOT NULL,
  source_name   TEXT,
  skipped       INTEGER NOT NULL DEFAULT 0,
  problems_json TEXT,                      -- 건너뛴 행 안내(최대 20건)
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  used_at       INTEGER
);
CREATE UNIQUE INDEX idx_quiz_sets_title ON quiz_sets(teacher_id, title);
CREATE INDEX idx_quiz_sets_list ON quiz_sets(teacher_id, updated_at DESC);

-- ── 방 목록 ────────────────────────────────────────────────
-- code 가 PRIMARY KEY 다. INSERT 가 성공하는 것이 곧 방번호 예약이다.
-- 조회 후 삽입으로 하면 두 선생님이 같은 번호를 받는 틈이 생긴다.
CREATE TABLE rooms (
  code              TEXT PRIMARY KEY,      -- 4자리 숫자
  status            TEXT NOT NULL,         -- provisioning | ready | closed
  teacher_id        TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  create_request_id TEXT NOT NULL,         -- 개설 멱등키. 두 번 눌러도 방은 하나
  label             TEXT,
  quiz_set_id       INTEGER REFERENCES quiz_sets(id) ON DELETE SET NULL,
  quiz_title        TEXT,                  -- 사본. 보관함에서 지워도 남는다
  created_at        INTEGER NOT NULL,
  last_active_at    INTEGER NOT NULL,
  closed_at         INTEGER
);
CREATE UNIQUE INDEX idx_rooms_request ON rooms(teacher_id, create_request_id);
CREATE INDEX idx_rooms_teacher ON rooms(teacher_id, status, last_active_at DESC);
CREATE INDEX idx_rooms_open ON rooms(status, last_active_at);

-- ── 수업 결과 ──────────────────────────────────────────────
CREATE TABLE results (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  room_code    TEXT    NOT NULL,
  teacher_id   TEXT,
  label        TEXT,
  quiz_title   TEXT,
  ended_at     INTEGER NOT NULL,
  rounds       INTEGER NOT NULL,
  h_territory  INTEGER NOT NULL, h_bonus INTEGER NOT NULL, h_total INTEGER NOT NULL,
  c_territory  INTEGER NOT NULL, c_bonus INTEGER NOT NULL, c_total INTEGER NOT NULL,
  winner       TEXT    NOT NULL,           -- 홍팀 | 청팀 | 무승부
  player_count INTEGER NOT NULL,
  players      TEXT    NOT NULL            -- JSON [{name,team,solved,correct}]
);
CREATE INDEX idx_results_teacher ON results(teacher_id, ended_at DESC);
