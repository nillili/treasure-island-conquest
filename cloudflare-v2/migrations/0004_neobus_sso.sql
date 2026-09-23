-- Neobus SSO 전환 — 자체 비밀번호를 없애고 Neobus 신원으로 갈아탄다.
--
-- 이 마이그레이션은 **비어 있는 DB 에만** 적용된다. 기존 선생님·퀴즈·방·기록이 한 줄이라도
-- 남아 있으면 맨 앞의 가드에서 실패하고 아무것도 바꾸지 않는다.
-- 백업 없이 이 파일을 적용해 자료를 잃는 길을 만들지 않기 위해서다.
-- (docs/plan_Neobus_SSO_전환_v1.md 5-3)

-- ── 0. 가드 ────────────────────────────────────────────────
-- ok 는 0 이어야만 들어간다. 한 줄이라도 남아 있으면 CHECK 가 걸려 여기서 멈춘다.
-- 주석이나 셸 출력 확인이 아니라 DB 가 직접 막는다.
CREATE TABLE _sso_guard (ok INTEGER NOT NULL CHECK (ok = 0));
INSERT INTO _sso_guard (ok)
SELECT (SELECT COUNT(*) FROM teachers)
     + (SELECT COUNT(*) FROM sessions)
     + (SELECT COUNT(*) FROM quiz_sets)
     + (SELECT COUNT(*) FROM rooms)
     + (SELECT COUNT(*) FROM game_records);
DROP TABLE _sso_guard;

-- ── 1. 선생님 ──────────────────────────────────────────────
-- 비밀번호를 지운다. 가짜 값을 채워 두는 우회를 하지 않는다.
ALTER TABLE teachers DROP COLUMN pw_salt;
ALTER TABLE teachers DROP COLUMN pw_hash;

-- 누구인지는 Neobus 가 정한다. id 는 이 앱 안에서만 쓰는 새 내부 ID(UUID)다.
-- 로그인 문자열을 그대로 쓰지 않는 이유: Neobus 에서 아이디를 바꿔도 퀴즈 주인이 바뀌면 안 된다.
-- origin 을 함께 두는 이유: 개발 Neobus 의 3번과 운영 Neobus 의 3번은 다른 사람이다.
ALTER TABLE teachers ADD COLUMN neobus_origin  TEXT NOT NULL DEFAULT '';
ALTER TABLE teachers ADD COLUMN neobus_user_id TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX idx_teachers_neobus ON teachers(neobus_origin, neobus_user_id);

-- ── 2. 세션 ────────────────────────────────────────────────
-- 브라우저에는 임의 토큰만 주고, DB 에는 그 해시를 둔다. DB 가 새어도 쿠키가 되지 않는다.
-- link_token 은 Neobus 를 부를 때 쓰는 서버 전용 값이다. 브라우저·DO·로그로 나가지 않는다.
DROP TABLE sessions;
CREATE TABLE sessions (
  token_hash  TEXT    PRIMARY KEY,           -- 쿠키 값의 SHA-256
  teacher_id  TEXT    NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  link_token  TEXT    NOT NULL,              -- Neobus 연결 토큰 (서버 전용)
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,              -- 최대 8시간, Neobus 토큰 만료를 넘지 않는다
  verified_at INTEGER NOT NULL               -- Neobus 에 마지막으로 되물은 시각
);
CREATE INDEX idx_sessions_expire  ON sessions(expires_at);
CREATE INDEX idx_sessions_teacher ON sessions(teacher_id);

-- ── 3. 로그인 진행 중 ──────────────────────────────────────
-- /auth/start 와 /auth/callback 사이에만 사는 값. 브라우저에는 id 만 준다.
-- verifier 를 브라우저에 주면 PKCE 가 아무것도 막지 못한다.
CREATE TABLE login_tx (
  id         TEXT    PRIMARY KEY,
  state      TEXT    NOT NULL,
  verifier   TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL               -- 10분
);
CREATE INDEX idx_login_tx_expire ON login_tx(expires_at);

-- ── 4. 원격 폐기 재시도 ────────────────────────────────────
-- 로그아웃할 때 Neobus 가 대답하지 않아도 이 앱의 권한은 그 자리에서 없앤다.
-- 남은 원격 토큰은 여기 적어 두고 나중에 다시 폐기한다. 이 줄로는 로그인할 수 없다.
CREATE TABLE revoke_queue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  link_token  TEXT    NOT NULL,
  origin      TEXT    NOT NULL,
  tries       INTEGER NOT NULL DEFAULT 0,
  next_try_at INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL              -- 이 시각이 지나면 Neobus 가 알아서 만료시킨다
);
CREATE INDEX idx_revoke_queue_due ON revoke_queue(next_try_at);
