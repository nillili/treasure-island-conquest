// 보물섬 점령전 Apps Script 백엔드
// 이 파일 하나에 API, 설정, 상태, 퀴즈, 기하, 게임 로직을 모두 포함합니다.


// ============================================================================
// Code 모듈
// ============================================================================

function fail_(e) { return { ok:false, error:(e && e.message) ? e.message : String(e) }; }
function randomId_(prefix) { return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8); }

function jsonOutput_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

// 화면(app.js)의 APP_VERSION 과 이 값이 다르면 배포가 어긋난 것이다.
// 2026-08-05 시연이 바로 그 어긋남으로 무너졌으므로 [시스템 점검]이 이것부터 확인한다.
var BACKEND_VERSION = 18;
var MOVE_RULE = '8way';

function doGet() {
  // 배포 확인용. curl <웹앱URL> 한 번으로 무엇이 올라가 있는지 알 수 있다.
  return jsonOutput_({ ok:true, service:'보물섬점령전 API', version:BACKEND_VERSION,
    placement:'random', rescue:true, eventlog:true, move:MOVE_RULE, safeBackup:true, diagnose:true });
}

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var expected = PropertiesService.getScriptProperties().getProperty('BACKEND_SECRET');
    if (!expected || String(body.secret || '') !== expected) throw new Error('백엔드 인증에 실패했습니다.');
    var action = String(body.action || ''), payload = body.payload || {};
    var handlers = {
      joinAsStudent:joinAsStudent, loginAsAdmin:loginAsAdmin, getState:getState,
      pickCell:pickCell, submitAnswer:submitAnswer, cancelPick:cancelPick,
      adminNewGame:adminNewGame, adminNextTurn:adminNextTurn, adminEndGame:adminEndGame,
      adminKick:adminKick, adminPeekCell:adminPeekCell,
      adminGetConfig:adminGetConfig, adminSaveConfig:adminSaveConfig, adminGetLog:adminGetLog, adminRestore:adminRestore,
      adminDiagnose:adminDiagnose, adminRepair:adminRepair
    };
    if (!handlers[action]) throw new Error('허용되지 않은 작업입니다.');
    var started = Date.now(), out = handlers[action](payload);
    logAction_(action, payload, out, Date.now() - started);
    return jsonOutput_(out);
  } catch (err) { return jsonOutput_(fail_(err)); }
}

function loginAsAdmin(arg) {
  try {
    var pw = PropertiesService.getScriptProperties().getProperty('ADMIN_PW') || DEFAULTS_.ADMIN_PW;
    if (!arg || String(arg.pw || '') !== pw) throw new Error('비밀번호가 올바르지 않습니다.');
    var token = randomId_('admin');
    CacheService.getScriptCache().put('ADMIN_TOKEN:' + token, '1', CACHE_TTL);
    return { ok:true, token:token };
  } catch (e) { return fail_(e); }
}

function requireAdmin_(token) {
  if (!token || CacheService.getScriptCache().get('ADMIN_TOKEN:' + token) !== '1') {
    throw new Error('관리자 인증이 만료되었습니다. 다시 로그인해 주세요.');
  }
}

function joinAsStudent(arg) {
  try {
    arg = arg || {};
    var requestedId = String(arg.playerId || '');
    if (requestedId) {
      var existingState = loadState_(), existing = existingState.players[requestedId];
      if (existing) {
        touchPresence_(existingState.gameId, requestedId);
        return { ok:true, playerId:requestedId, team:existing.team, pos:existing.pos, name:existing.name,
          allQuizzes:allCellQuizzes_(existingState) };
      }
    }
    var name = String(arg.name || '').trim();
    if (!name || name.length > 10) throw new Error('이름은 1~10자로 입력해 주세요.');
    var result = withLock_(function (st) {
      var used = {};
      Object.keys(st.players).forEach(function (id) { used[st.players[id].name] = true; });
      var base = name, n = 2;
      while (used[name]) name = base + n++;
      var h = countTeam_(st, 'H'), c = countTeam_(st, 'C');
      var team = h < c ? 'H' : (c < h ? 'C' : (Math.random() < .5 ? 'H' : 'C'));
      var id = randomId_('p');
      var p = { name:name, team:team, pos:null, skipTurns:0, skipTurnKey:null, lastPlayedTurnKey:null, solved:0, correct:0 };
      st.players[id] = p;
      if (st.board.length) placeLatePlayer_(st, id);
      return { ok:true, playerId:id, team:team, pos:p.pos, name:name };
    });
    var joinedState = loadState_();
    result.allQuizzes = allCellQuizzes_(joinedState);
    touchPresence_(joinedState.gameId, result.playerId);
    return result;
  } catch (e) { return fail_(e); }
}


// ============================================================================
// Config 모듈
// ============================================================================

var DEFAULTS_ = {
  QUIZ_SHEET: '퀴즈', TURN_SECONDS: '60', ROWS: '12', COLS: '12', ROUND_LIMIT: '10',
  CNT_T: '8', CNT_S: '7', CNT_A: '7', ADMIN_PW: '1234', SS_ID: ''
};

function setupDefaults() {
  var p = PropertiesService.getScriptProperties(), cur = p.getProperties(), add = {};
  Object.keys(DEFAULTS_).forEach(function (k) { if (cur[k] === undefined) add[k] = DEFAULTS_[k]; });
  if (Object.keys(add).length) p.setProperties(add, false);
  return getConfig_();
}

function resetDefaults() {
  var p = PropertiesService.getScriptProperties(), stateId = p.getProperty('STATE_SS_ID');
  p.setProperties(DEFAULTS_, true);
  if (stateId) p.setProperty('STATE_SS_ID', stateId);
  CacheService.getScriptCache().remove(STATE_KEY);
  return getConfig_();
}

function getConfig_() {
  var p = PropertiesService.getScriptProperties(), v = p.getProperties();
  function val(k) { return v[k] === undefined ? DEFAULTS_[k] : v[k]; }
  return {
    ssId: val('SS_ID'), quizSheet: val('QUIZ_SHEET'), turnSeconds: Number(val('TURN_SECONDS')),
    rows: Number(val('ROWS')), cols: Number(val('COLS')), roundLimit: Number(val('ROUND_LIMIT')),
    cnt: { T: Number(val('CNT_T')), S: Number(val('CNT_S')), A: Number(val('CNT_A')) }
  };
}

function validateConfig_(c) {
  function integer(n, min, max, label) {
    n = Number(n); if (!Number.isInteger(n) || n < min || n > max) throw new Error(label + ' 범위를 확인해 주세요.'); return n;
  }
  var out = {
    ssId: String(c.ssId || '').trim(), quizSheet: String(c.quizSheet || '퀴즈').trim(),
    turnSeconds: integer(c.turnSeconds, 10, 600, '풀이 시간'), rows: integer(c.rows, 5, 20, '행'),
    cols: integer(c.cols, 5, 20, '열'), roundLimit: integer(c.roundLimit, 1, 50, '라운드'), cnt: {}
  };
  ['T','S','A'].forEach(function (t) { out.cnt[t] = integer((c.cnt || {})[t], 0, 400, '특수칸'); });
  var special = out.cnt.T + out.cnt.S + out.cnt.A;
  if (special > out.rows * out.cols * 0.6) throw new Error('특수칸 합계는 전체 칸의 60% 이하여야 합니다.');
  if (!out.quizSheet) throw new Error('퀴즈 탭 이름을 입력해 주세요.');
  return out;
}

function validateSheet_(c) {
  var ss;
  try { ss = c.ssId ? SpreadsheetApp.openById(c.ssId) : SpreadsheetApp.getActiveSpreadsheet(); }
  catch (e) { throw new Error('시트를 열 수 없습니다. ID와 공유 권한을 확인하세요.'); }
  if (!ss) throw new Error('스프레드시트 ID를 입력해 주세요.');
  var sh = ss.getSheetByName(c.quizSheet);
  if (!sh) throw new Error("'" + c.quizSheet + "' 탭이 없습니다.");
  var parsed = parseQuizValues_(sh.getDataRange().getDisplayValues());
  if (!parsed.bank.length) throw new Error('읽을 수 있는 문항이 없습니다.');
  return parsed.bank.length;
}

function adminGetConfig(arg) {
  try { requireAdmin_(arg && arg.token); var c = getConfig_(); c.quizCount = sourceQuizCount_(c); return { ok:true, config:c }; }
  catch (e) { return fail_(e); }
}

function adminSaveConfig(arg) {
  try {
    requireAdmin_(arg && arg.token);
    var c = validateConfig_(arg.config || {}), count = validateSheet_(c), p = PropertiesService.getScriptProperties();
    p.setProperties({ SS_ID:c.ssId, QUIZ_SHEET:c.quizSheet, TURN_SECONDS:String(c.turnSeconds), ROWS:String(c.rows),
      COLS:String(c.cols), ROUND_LIMIT:String(c.roundLimit), CNT_T:String(c.cnt.T), CNT_S:String(c.cnt.S),
      CNT_A:String(c.cnt.A), CNT_Q:'0' }, false);
    if (arg.config.adminPw) p.setProperty('ADMIN_PW', String(arg.config.adminPw));
    return { ok:true, quizCount:count, sizeHint:sizeHint_(c.rows, c.cols, count), message:'저장했습니다. 다음 새 게임부터 적용됩니다.' };
  } catch (e) { return fail_(e); }
}

/** 퀴즈 탭을 읽어 통째로 돌려준다(건너뛴 줄 목록 포함). 점검 화면이 쓴다. */
function sourceQuizParse_(c) {
  try {
    var ss = c.ssId ? SpreadsheetApp.openById(c.ssId) : SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss && ss.getSheetByName(c.quizSheet);
    return sh ? parseQuizValues_(sh.getDataRange().getDisplayValues()) : { bank:[], skipped:0, problems:[] };
  } catch (e) { return { bank:[], skipped:0, problems:[] }; }
}

function sourceQuizCount_(c) { return sourceQuizParse_(c).bank.length; }

function sizeHint_(r, c, n) {
  return { cells:r*c, repeats:n ? Math.ceil(r*c/n) : 0, last:columnLabel_(c-1)+r };
}


// ============================================================================
// State 모듈
// ============================================================================

var RESET_MARK_KEY = 'RESET_MARK';
var STATE_KEY = 'GAME_STATE';
var CACHE_TTL = 21600;
var PRESENCE_TTL = 45;

function emptyState_() {
  return {
    gameId: 'g_' + Date.now(), rev: 0, status: 'waiting', rows: 12, cols: 12,
    round: 1, turnTeam: null, turnEndsAt: null, roundLimit: 10,
    quizSnapId: null,
    territory: { H: 0, C: 0 }, bonus: { H: 0, C: 0 }, board: [], players: {},
    cellLocks: {}, attempts: {}, log: []
  };
}

/**
 * allowEmpty=true 일 때만 빈 상태를 새로 만든다([새 게임] 전용).
 * 그 밖에는, 진행 중이던 게임이 있는데 캐시도 시트도 못 읽으면 예외를 던진다.
 * 예전에는 조용히 emptyState_() 를 돌려주고 그걸 캐시에 저장해 버려서,
 * 캐시가 한 번 증발하면 학생 명단·보드·점수가 통째로 사라졌다.
 */
function loadState_(allowEmpty) {
  var cache = CacheService.getScriptCache(), hit = cache.get(STATE_KEY);
  if (hit) return JSON.parse(hit);
  var restored = restoreFromSheet_();
  if (restored) {
    cache.put(STATE_KEY, JSON.stringify(restored), CACHE_TTL);
    return restored;
  }
  if (!allowEmpty && PropertiesService.getScriptProperties().getProperty('LIVE_GAME_ID')) {
    throw new Error('서버가 잠시 불안정합니다. 잠시 후 다시 시도해 주세요.');
  }
  return emptyState_();
}

function saveState_(st) {
  CacheService.getScriptCache().put(STATE_KEY, JSON.stringify(st), CACHE_TTL);
}

function withLock_(fn, allowEmpty) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('서버가 혼잡합니다. 잠시 후 다시 시도하세요.');
  try {
    var st = loadState_(allowEmpty), result = fn(st);
    st.rev = (st.rev || 0) + 1;
    assertTerritory_(st);
    saveState_(st);
    return result;
  } finally { lock.releaseLock(); }
}

function assertTerritory_(st) {
  if (!st.board || !st.board.length) return;
  var actual = { H: 0, C: 0 };
  st.board.forEach(function (c) { if (c.o === 'H' || c.o === 'C') actual[c.o]++; });
  if (actual.H !== st.territory.H || actual.C !== st.territory.C) {
    throw new Error('영토 점수 불일치가 감지되었습니다.');
  }
}

function getDb_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('STATE_SS_ID');
  if (id) return SpreadsheetApp.openById(id);
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) {
    props.setProperty('STATE_SS_ID', active.getId());
    return active;
  }
  id = getConfig_().ssId;
  if (!id) throw new Error('스프레드시트 ID를 환경설정에 입력해 주세요.');
  props.setProperty('STATE_SS_ID', id);
  return SpreadsheetApp.openById(id);
}

function getOrCreateSheet_(name) {
  var ss = getDb_(), sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (!sh.isSheetHidden()) sh.hideSheet();
  return sh;
}

function sha256_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}

function writeChunked_(sheetName, id, json) {
  var sh = getOrCreateSheet_(sheetName), size = 40000, chunks = [], i;
  for (i = 0; i < json.length; i += size) chunks.push(json.substr(i, size));
  var rows = [['META', id, chunks.length, ''], ['HASH', sha256_(json), '', '']];
  chunks.forEach(function (c, n) { rows.push(['CHUNK', n, c, '']); });
  // clearContents() 없이 overwrite: 쓰는 도중 캐시가 증발해도 이전 데이터가 시트에 남아 있다.
  sh.getRange(1, 1, rows.length, 4).setValues(rows);
  var lastRow = sh.getLastRow();
  if (lastRow > rows.length) sh.deleteRows(rows.length + 1, lastRow - rows.length);
  if (!sh.isSheetHidden()) sh.hideSheet();
}

function readChunked_(sheetName, id) {
  var sh = getDb_().getSheetByName(sheetName);
  if (!sh) return null;
  var rows = sh.getDataRange().getValues();
  if (rows.length < 3 || rows[0][0] !== 'META' || String(rows[0][1]) !== String(id)) return null;
  var count = Number(rows[0][2]), hash = String(rows[1][1]), parts = [];
  rows.slice(2).forEach(function (r) { if (r[0] === 'CHUNK') parts[Number(r[1])] = String(r[2]); });
  if (parts.length !== count) return null;
  for (var i = 0; i < count; i++) if (parts[i] === undefined) return null;
  var json = parts.join('');
  return sha256_(json) === hash ? json : null;
}

var BACKUP_LOCK_KEY = 'BACKUP_LOCK';
function backupToSheet_(st) {
  var cache = CacheService.getScriptCache();
  if (cache.get(BACKUP_LOCK_KEY)) return; // 다른 요청이 백업 중이면 건너뜀
  cache.put(BACKUP_LOCK_KEY, '1', 30);
  try { writeChunked_('_상태', st.gameId, JSON.stringify(st)); } finally { cache.remove(BACKUP_LOCK_KEY); }
}

function adminRestore(arg) {
  try {
    requireAdmin_(arg && arg.token);
    var st = restoreFromSheet_();
    if (!st) throw new Error('스프레드시트에 저장된 상태가 없습니다. 새 게임을 시작해 주세요.');
    saveState_(st);
    return { ok:true, round:st.round, status:st.status, players:Object.keys(st.players).length };
  } catch(e) { return fail_(e); }
}


// ============================================================================
// Diagnostics 모듈 — 관리자 [시스템 점검] 버튼
//   수업 중에 "왜 안 되는지"를 교사가 혼자 판단하고 혼자 고칠 수 있어야 한다.
//   점검은 상태를 절대 바꾸지 않는다. 고치는 것은 adminRepair 가 따로 한다.
// ============================================================================

function adminDiagnose(arg) {
  try {
    requireAdmin_(arg && arg.token);
    var started = Date.now(), checks = [];
    function add(name, level, detail, fix, fixLabel) {
      checks.push({ name:name, level:level, detail:detail, fix:fix || null, fixLabel:fixLabel || null });
    }

    // ── 1. 배포 버전 ────────────────────────────────────────────────
    var appVersion = Number(arg && arg.appVersion) || 0;
    if (!appVersion) {
      add('배포 버전', 'ok', '서버 v' + BACKEND_VERSION + ' · 이동 ' + MOVE_RULE);
    } else if (appVersion === BACKEND_VERSION) {
      add('배포 버전', 'ok', '화면과 서버 모두 v' + BACKEND_VERSION + ' · 이동 ' + MOVE_RULE);
    } else {
      add('배포 버전', 'error',
        '화면 v' + appVersion + ' ↔ 서버 v' + BACKEND_VERSION + ' 가 다릅니다. '
        + '둘 중 하나가 배포되지 않았습니다. 학생이 칸을 눌러도 거부될 수 있습니다.');
    }

    // ── 2. 스프레드시트 ─────────────────────────────────────────────
    var ss = null;
    try { ss = getDb_(); add('스프레드시트 연결', 'ok', ss.getName()); }
    catch (e) { add('스프레드시트 연결', 'error', e.message); }

    // ── 3. 퀴즈 문항 ────────────────────────────────────────────────
    var cfg = getConfig_();
    try {
      var parsed = sourceQuizParse_(cfg), quizN = parsed.bank.length, cells = cfg.rows * cfg.cols;
      if (!quizN) add('퀴즈 문항', 'error', "'" + cfg.quizSheet + "' 탭에서 읽을 수 있는 문항이 0개입니다. 새 게임을 시작할 수 없습니다.");
      else if (quizN < cells) add('퀴즈 문항', 'warn', quizN + '개 · 보드 ' + cells + '칸이라 같은 문제가 최대 ' + Math.ceil(cells / quizN) + '번 나옵니다.');
      else add('퀴즈 문항', 'ok', quizN + '개 (보드 ' + cells + '칸)');
      // 못 읽은 줄은 그냥 버려지므로 교사가 알 방법이 없었다. 몇 행이 왜 빠졌는지 보여 준다.
      if (parsed.skipped) {
        add('건너뛴 문항', 'warn', parsed.skipped + '줄을 읽지 못해 게임에서 빠졌습니다. — '
          + parsed.problems.join(' / '));
      }
    } catch (e) { add('퀴즈 문항', 'error', e.message); }

    // ── 4. 캐시 ─────────────────────────────────────────────────────
    var cache = CacheService.getScriptCache();
    try {
      var probe = 'DIAG:' + Date.now();
      cache.put(probe, 'x', 60);
      var back = cache.get(probe);
      cache.remove(probe);
      add('임시 저장소(캐시)', back === 'x' ? 'ok' : 'error',
        back === 'x' ? '읽기·쓰기 정상' : '방금 쓴 값을 다시 읽지 못했습니다. 게임 상태가 수시로 사라질 수 있습니다.');
    } catch (e) { add('임시 저장소(캐시)', 'error', e.message); }

    // ── 5. 게임 상태 ────────────────────────────────────────────────
    var st = null, cached = !!cache.get(STATE_KEY);
    try { st = loadState_(true); } catch (e) { add('게임 상태', 'error', e.message); }
    if (st) {
      if (!st.board.length) {
        add('게임 상태', 'warn', '아직 보드가 없습니다. [새 게임]을 눌러 주세요.');
      } else {
        var placed = playersAll_(st).filter(function (p) { return p.pos !== null && p.pos !== undefined; });
        var seen = {}, dup = 0, stuck = [];
        placed.forEach(function (p) {
          if (seen[p.pos]) dup++; else seen[p.pos] = true;
          if (!canChallengeFrom_(st, p.pos, p.team)) stuck.push(p.name);
        });
        var head = ({ waiting:'대기 중', running:'진행 중', ended:'종료됨' }[st.status] || st.status)
          + ' · 라운드 ' + st.round + '/' + st.roundLimit
          + ' · 학생 ' + Object.keys(st.players).length + '명';
        if (dup || stuck.length) {
          add('학생 배치', 'warn', head + ' · 겹친 말 ' + dup + '개 · 갇힌 학생 ' + stuck.length + '명'
            + (stuck.length ? ' (' + stuck.join(', ') + ')' : '') + ' — 이 학생들은 문제를 받지 못합니다.',
            'rescue', '갇힌 학생 구조하기');
        } else {
          add('학생 배치', 'ok', head + ' · 겹침 없음 · 전원 도전 가능');
        }
        var locks = Object.keys(st.cellLocks || {}).length;
        if (locks) add('공략 중인 칸', locks > 3 ? 'warn' : 'ok', locks + '칸이 잠겨 있습니다.'
          + (locks > 3 ? ' 학생이 나간 뒤 잠금이 남았을 수 있습니다.' : ''), 'unlock', '잠긴 칸 풀기');
      }
      if (!cached) add('상태 보관', 'warn', '임시 저장소에 상태가 없어 스프레드시트에서 복구했습니다. 한 번 더 사라지면 게임이 끊깁니다.', 'backup', '지금 상태 백업하기');
    }

    // ── 6. 시트 백업 ────────────────────────────────────────────────
    try {
      var saved = restoreFromSheet_();
      if (!saved) add('스프레드시트 백업', 'warn', '저장된 백업이 없습니다. 상태가 사라지면 되돌릴 수 없습니다.', 'backup', '지금 백업하기');
      else if (st && saved.gameId !== st.gameId) add('스프레드시트 백업', 'warn', '백업이 지난 게임 것입니다.', 'backup', '지금 백업하기');
      else add('스프레드시트 백업', 'ok', '최신 상태가 저장되어 있습니다.');
    } catch (e) { add('스프레드시트 백업', 'error', e.message, 'backup', '지금 백업하기'); }

    // ── 7. 동시 처리(락) ────────────────────────────────────────────
    try {
      var lock = LockService.getScriptLock(), t = Date.now(), got = lock.tryLock(3000), waited = Date.now() - t;
      if (got) lock.releaseLock();
      if (!got) add('동시 처리', 'error', '3초를 기다려도 순서를 잡지 못했습니다. 서버가 밀려 있습니다. 학생들에게 잠시 기다리라고 한 뒤 다시 점검해 주세요.');
      else if (waited > 800) add('동시 처리', 'warn', waited + 'ms 기다렸습니다. 요청이 몰리는 중입니다.');
      else add('동시 처리', 'ok', waited + 'ms 만에 순서를 잡았습니다.');
    } catch (e) { add('동시 처리', 'error', e.message); }

    // ── 8. 로그 적체 ────────────────────────────────────────────────
    try {
      var pending = JSON.parse(cache.get(EVENTLOG_KEY) || '[]').length;
      add('기록', pending > EVENTLOG_MAX * 0.8 ? 'warn' : 'ok',
        '아직 시트에 내려가지 않은 기록 ' + pending + '건', pending ? 'flushlog' : null, '기록 저장하기');
    } catch (e) { add('기록', 'warn', e.message); }

    add('응답 속도', 'ok', (Date.now() - started) + 'ms');

    var bad = checks.filter(function (c) { return c.level === 'error'; }).length;
    var warn = checks.filter(function (c) { return c.level === 'warn'; }).length;
    return { ok:true, checks:checks, errorCount:bad, warnCount:warn,
      summary: bad ? '문제 ' + bad + '건을 찾았습니다.'
             : warn ? '주의 ' + warn + '건이 있습니다. 게임은 진행할 수 있습니다.'
             : '모두 정상입니다.' };
  } catch (e) { return fail_(e); }
}

/** 점검에서 찾은 문제를 실제로 고친다. what 은 adminDiagnose 가 준 fix 값이다. */
function adminRepair(arg) {
  try {
    requireAdmin_(arg && arg.token);
    var what = String((arg && arg.what) || '');
    if (what === 'backup') {
      var st = loadState_(true);
      writeChunked_('_상태', st.gameId, JSON.stringify(st));
      return { ok:true, message:'현재 상태를 스프레드시트에 저장했습니다.' };
    }
    if (what === 'restore') {
      var got = restoreFromSheet_();
      if (!got) throw new Error('스프레드시트에 저장된 상태가 없습니다.');
      saveState_(got);
      return { ok:true, message:'저장된 상태로 되돌렸습니다. 학생 ' + Object.keys(got.players).length + '명.' };
    }
    if (what === 'flushlog') { flushEventLog_(); return { ok:true, message:'기록을 시트에 저장했습니다.' }; }
    if (what === 'unlock') {
      var r1 = withLock_(function (s) { var n = Object.keys(s.cellLocks || {}).length; s.cellLocks = {}; s.attempts = {}; return n; });
      return { ok:true, message:r1 + '칸의 잠금을 풀었습니다.' };
    }
    if (what === 'rescue') {
      var moved = withLock_(function (s) {
        if (!s.board.length) throw new Error('먼저 새 게임을 시작해 주세요.');
        var before = {}; playersAll_(s).forEach(function (p) { before[p.name] = p.pos; });
        // 겹친 말부터 떼어 놓고, 그다음 갇힌 학생을 구조한다.
        var occupied = {}, names = [];
        playersAll_(s).forEach(function (p) {
          if (p.pos === null || p.pos === undefined) return;
          if (!occupied[p.pos]) { occupied[p.pos] = true; return; }
          for (var i = 0; i < s.board.length; i++) {
            if (!occupied[i] && canChallengeFrom_(s, i, p.team)) { p.pos = i; occupied[i] = true; return; }
          }
        });
        ['H','C'].forEach(function (team) { rescueTrapped_(s, team); });
        playersAll_(s).forEach(function (p) { if (before[p.name] !== p.pos) names.push(p.name); });
        snapshotPlacement_(s, 'repair');
        return names;
      });
      return { ok:true, message: moved.length ? moved.join(', ') + ' 학생의 자리를 옮겼습니다.' : '옮길 학생이 없었습니다.' };
    }
    throw new Error('알 수 없는 조치입니다.');
  } catch (e) { return fail_(e); }
}


// ============================================================================
// EventLog 모듈 — 수업 후 사후 분석용
//   · 캐시에 쌓고 굵은 이벤트(턴 전환·종료)에서만 시트에 내린다. 게임 중 시트 쓰기는 느리다.
//   · 로그가 실패해도 게임은 계속되어야 하므로 전부 try/catch 로 감싼다.
// ============================================================================

var EVENTLOG_KEY = 'EVENT_LOG';
var EVENTLOG_MAX = 500;
var EVENTLOG_SHEET = '_로그';

function logEvent_(type, data) {
  try {
    var cache = CacheService.getScriptCache();
    var buf = JSON.parse(cache.get(EVENTLOG_KEY) || '[]');
    var row = { t: Date.now(), e: type };
    if (data) Object.keys(data).forEach(function (k) { if (data[k] !== undefined) row[k] = data[k]; });
    buf.push(row);
    if (buf.length > EVENTLOG_MAX) buf = buf.slice(-EVENTLOG_MAX);
    cache.put(EVENTLOG_KEY, JSON.stringify(buf), CACHE_TTL);
  } catch (err) { /* 로그 실패는 무시한다 */ }
}

/** 캐시에 쌓인 이벤트를 _로그 탭에 한 번에 내린다. */
function flushEventLog_() {
  try {
    var cache = CacheService.getScriptCache();
    var buf = JSON.parse(cache.get(EVENTLOG_KEY) || '[]');
    if (!buf.length) return;
    var sh = getDb_().getSheetByName(EVENTLOG_SHEET) || getDb_().insertSheet(EVENTLOG_SHEET);
    if (sh.getLastRow() === 0) sh.appendRow(['시각', '이벤트', '학생', '팀', '칸', '상세']);
    var rows = buf.map(function (r) {
      var rest = {};
      Object.keys(r).forEach(function (k) {
        if (['t','e','name','team','cell'].indexOf(k) < 0) rest[k] = r[k];
      });
      return [new Date(r.t), r.e, r.name || '', r.team || '',
              (r.cell === undefined ? '' : r.cell), JSON.stringify(rest)];
    });
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, 6).setValues(rows);
    cache.remove(EVENTLOG_KEY);
  } catch (err) { /* 로그 실패는 무시한다 */ }
}

/** 관리자/분석 도구용 조회. 캐시에 남은 것 + 시트에 내려간 것을 합쳐 준다. */
function adminGetLog(arg) {
  try {
    requireAdmin_(arg && arg.token);
    var limit = Math.min(Number(arg.limit) || 300, 2000), sheet = [];
    try {
      var sh = getDb_().getSheetByName(EVENTLOG_SHEET);
      if (sh && sh.getLastRow() > 1) {
        var start = Math.max(2, sh.getLastRow() - limit + 1);
        sheet = sh.getRange(start, 1, sh.getLastRow() - start + 1, 6).getValues().map(function (r) {
          return { t: r[0] instanceof Date ? r[0].getTime() : r[0], e: r[1],
                   name: r[2], team: r[3], cell: r[4], detail: r[5] };
        });
      }
    } catch (err) { /* 시트가 아직 없을 수 있다 */ }
    var pending = JSON.parse(CacheService.getScriptCache().get(EVENTLOG_KEY) || '[]');
    return { ok: true, sheet: sheet, pending: pending, pendingCount: pending.length };
  } catch (e) { return fail_(e); }
}

/** 새 게임·턴 시작 시 배치 상태를 통째로 남긴다. 사후에 '누가 갇혔나'를 재현할 수 있다. */
function snapshotPlacement_(st, reason) {
  try {
    var rows = st.rows, cols = st.cols, seen = {}, dup = 0, stuck = [], detail = [];
    playersAll_(st).forEach(function (p) {
      if (p.pos === null || p.pos === undefined) return;
      if (seen[p.pos]) dup++; else seen[p.pos] = true;
      var free = neighbors8_(p.pos, rows, cols).filter(function (n) { return st.board[n].o !== p.team; });
      if (!free.length) stuck.push(p.name);
      detail.push(p.name + ':' + p.team + '@' + cellLabel_(p.pos, cols) + '(' + free.length + ')');
    });
    logEvent_('placement', { why: reason, n: detail.length, dup: dup,
      stuck: stuck.length ? stuck.join(',') : '', pos: detail.join(' ') });
  } catch (err) { /* 로그 실패는 무시한다 */ }
}

var LOG_ACTIONS_ = { pickCell:1, submitAnswer:1, joinAsStudent:1, adminNewGame:1,
  adminNextTurn:1, adminEndGame:1, adminKick:1, adminSaveConfig:1 };

/**
 * doPost 가 모든 액션 뒤에 부른다. 실패는(중복을 걸러서) 전부, 성공은 게임 흐름에 관계된 것만 남긴다.
 *
 * 중복을 거르는 이유: logEvent_ 는 로그 배열 전체를 읽어 파싱하고 다시 직렬화해 캐시에 쓴다.
 * 학생 15명이 폴링마다 같은 오류를 맞으면 초당 수십 번 그 짓을 하게 되고,
 * 그 부하가 다시 응답을 늦춰 더 많은 오류를 부른다. 같은 오류는 20초에 한 번만 남긴다.
 */
function logAction_(action, payload, out, ms) {
  try {
    payload = payload || {};
    var pid = payload.playerId ? String(payload.playerId).slice(-6) : undefined;
    if (!out || out.ok === false) {
      var msg = (out && out.error) || '?';
      var dupKey = 'FAILDUP:' + action + ':' + msg.slice(0, 40);
      var fc = CacheService.getScriptCache();
      if (fc.get(dupKey)) return;
      fc.put(dupKey, '1', 20);
      logEvent_('fail', { a:action, msg:msg, pid:pid, cell:payload.cell, ms:ms });
      return;
    }
    if (!LOG_ACTIONS_[action]) return;
    var d = { a:action, ms:ms, pid:pid };
    if (action === 'pickCell')          { d.cell = payload.cell; d.moved = !!out.moved; }
    else if (action === 'submitAnswer') { d.cell = payload.cell; d.hit = !!out.correct; d.gain = out.gain; d.kind = out.cellType; }
    else if (action === 'joinAsStudent'){ d.name = out.name; d.team = out.team; d.pos = out.pos; d.pid = String(out.playerId||'').slice(-6); }
    else if (action === 'adminNewGame') { d.students = out.playerCount; d.cells = out.cellCount; d.quiz = out.quizCount; }
    else if (action === 'adminNextTurn'){ d.round = out.round; d.team = out.turnTeam; }
    else if (action === 'adminEndGame') { d.winner = out.winner; }
    logEvent_(action === 'submitAnswer' ? 'answer' : action, d);
  } catch (err) { /* 로그 실패는 무시한다 */ }
}

function playersAll_(st) {
  return Object.keys(st.players).map(function (id) { return st.players[id]; });
}
function restoreFromSheet_() {
  try {
    var sh = getDb_().getSheetByName('_상태');
    if (!sh) return null;
    var rows = sh.getDataRange().getValues();
    if (!rows.length || rows[0][0] !== 'META') return null;
    var json = readChunked_('_상태', String(rows[0][1]));
    return json ? JSON.parse(json) : null;
  } catch (e) { return null; }
}

function touchPresence_(gameId, playerId) {
  if (gameId && playerId) CacheService.getScriptCache().put('PRESENCE:' + gameId + ':' + playerId, '1', PRESENCE_TTL);
}

function getPresence_(st) {
  var ids = Object.keys(st.players || {});
  if (!ids.length) return [];
  var keys = ids.map(function (id) { return 'PRESENCE:' + st.gameId + ':' + id; });
  var hits = CacheService.getScriptCache().getAll(keys);
  return ids.filter(function (id, i) { return hits[keys[i]] !== undefined; });
}

function shuffle_(a) {
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}


// ============================================================================
// Quiz 모듈
// ============================================================================

/**
 * 시트 한 줄 = 문항 하나.  A:질문 · B:정답 · C~F:예제1~예제4
 *
 * 정답은 번호로 쓴다. 1 = 예제1 … 4 = 예제4.
 * (예전에는 정답 칸에 보기 '내용'을 적어도 받아 줬다. 그 방식은 시트를 고칠 때
 *  보기 문구만 바꾸고 정답 칸을 안 고치면 조용히 어긋난다. 번호는 그럴 일이 없다.)
 * 옛 시트를 그대로 쓸 수 있게 글자로 적은 정답도 계속 받되, 문제가 있는 줄은 이유를 남긴다.
 *
 * 빈 칸은 '뒤쪽만' 잘라 낸다. 가운데를 지우면 번호가 밀려 3번이 4번을 가리키게 된다.
 */
function parseQuizValues_(values) {
  var bank = [], skipped = 0, problems = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r], q = String(row[0] || '').trim(), raw = String(row[1] || '').trim();
    if (!q && !raw) continue;                                   // 완전히 빈 줄은 조용히 넘긴다
    var line = r + 1;                                           // 시트에 보이는 행 번호
    if (!q || !raw) { skipped++; problems.push(line + '행: ' + (q ? '정답' : '질문') + ' 칸이 비었습니다.'); continue; }

    var opts = row.slice(2, 6).map(function (x) { return String(x || '').trim(); });
    while (opts.length && opts[opts.length - 1] === '') opts.pop();   // 뒤쪽 빈 칸만 제거
    if (opts.length < 2) { skipped++; problems.push(line + '행: 보기가 2개 미만입니다.'); continue; }
    if (opts.indexOf('') >= 0) { skipped++; problems.push(line + '행: 보기 중간이 비었습니다. 앞에서부터 채워 주세요.'); continue; }

    var ans = -1;
    if (/^[1-9][0-9]*$/.test(raw)) {
      var num = Number(raw);
      if (num >= 1 && num <= opts.length) ans = num - 1;
      else { skipped++; problems.push(line + '행: 정답이 ' + num + '번인데 보기는 ' + opts.length + '개뿐입니다.'); continue; }
    } else {
      var needle = raw.toLocaleLowerCase();
      for (var i = 0; i < opts.length; i++) if (opts[i].toLocaleLowerCase() === needle) { ans = i; break; }
      if (ans < 0) { skipped++; problems.push(line + "행: 정답 '" + raw + "' 이 보기 안에 없습니다. 정답 칸에 번호(1~" + opts.length + ")를 적어 주세요."); continue; }
    }
    bank.push({ q:q, options:opts, ans:ans });
  }
  return { bank:bank, skipped:skipped, problems:problems.slice(0, 20) };
}

function getSourceQuizzes_() {
  var cfg = getConfig_(), ss;
  try { ss = cfg.ssId ? SpreadsheetApp.openById(cfg.ssId) : SpreadsheetApp.getActiveSpreadsheet(); }
  catch (e) { throw new Error('시트를 열 수 없습니다. ID와 공유 권한을 확인하세요.'); }
  if (!ss) throw new Error('환경설정에서 스프레드시트 ID를 입력해 주세요.');
  var sh = ss.getSheetByName(cfg.quizSheet);
  if (!sh) throw new Error("'" + cfg.quizSheet + "' 탭이 없습니다.");
  return parseQuizValues_(sh.getDataRange().getDisplayValues()).bank.slice(0, 500);
}

function saveQuizSnapshot_(st, src) {
  var map = {}, snap = [];
  st.board.forEach(function (c) {
    if (map[c.q] === undefined) { map[c.q] = snap.length; snap.push(src[c.q]); }
    c.q = map[c.q];
  });
  st.quizSnapId = st.gameId;
  var json = JSON.stringify(snap), key = 'QUIZ_SNAP:' + st.gameId;
  if (json.length < 95000) CacheService.getScriptCache().put(key, json, CACHE_TTL);
  writeChunked_('_퀴즈스냅샷', st.gameId, json);
  return snap;
}

function getGameQuizzes_(st) {
  if (!st.quizSnapId) throw new Error('새 게임을 먼저 시작해 주세요.');
  var key = 'QUIZ_SNAP:' + st.quizSnapId, hit = CacheService.getScriptCache().get(key);
  if (hit) return JSON.parse(hit);
  var json = readChunked_('_퀴즈스냅샷', st.quizSnapId);
  if (!json) throw new Error('이번 게임의 문제 사본을 찾을 수 없습니다. 새 게임을 눌러 주세요.');
  if (json.length < 95000) CacheService.getScriptCache().put(key, json, CACHE_TTL);
  return JSON.parse(json);
}

function allCellQuizzes_(st) {
  if (!st.board || !st.board.length || !st.quizSnapId) return {};
  var bank = getGameQuizzes_(st), out = {};
  st.board.forEach(function (cell, idx) {
    var item = bank[cell.q];
    if (item) out[idx] = { q:item.q, options:item.options.slice(), ans:item.ans };
  });
  return out;
}

function getNeighborQuizzes_(st, playerId, bank) {
  var p = st.players[playerId], out = {};
  if (!p || p.pos === null || p.skipTurnKey === turnKey_(st)) return out;
  neighbors8_(p.pos, st.rows, st.cols).forEach(function (cell) {
    var c = st.board[cell];
    if (c.o === p.team || st.cellLocks[cell]) return;
    var item = bank[c.q];
    if (item) out[cell] = { q:item.q, options:item.options.slice() };
  });
  return out;
}


// ============================================================================
// Geometry 모듈
// ============================================================================

function columnLabel_(c) {
  var s = '', n = Number(c) + 1;
  while (n > 0) {
    var m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function rc_(idx, cols) { return { r: Math.floor(idx / cols), c: idx % cols }; }
function idx_(r, c, cols) { return r * cols + c; }
function cellLabel_(idx, cols) {
  var p = rc_(idx, cols);
  return columnLabel_(p.c) + (p.r + 1);
}

/**
 * 둘레 8칸(상하좌우 + 대각선). 이동·도전·구조·문제 배분이 전부 이 하나를 쓴다.
 * 모서리 3칸 · 가장자리 5칸 · 안쪽 8칸.
 */
function neighbors8_(pos, rows, cols) {
  var p = rc_(pos, cols), out = [];
  for (var dr = -1; dr <= 1; dr++) {
    for (var dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      var r = p.r + dr, c = p.c + dc;
      if (r < 0 || r >= rows || c < 0 || c >= cols) continue;
      out.push(idx_(r, c, cols));
    }
  }
  return out;
}

function chebyshev_(a, b, cols) {
  var x = rc_(a, cols), y = rc_(b, cols);
  return Math.max(Math.abs(x.r - y.r), Math.abs(x.c - y.c));
}

function runGeometryTests() {
  var tests = [
    ['colA', columnLabel_(0) === 'A'], ['colZ', columnLabel_(25) === 'Z'],
    ['colAA', columnLabel_(26) === 'AA'], ['A1', cellLabel_(0, 12) === 'A1'],
    ['L1', cellLabel_(11, 12) === 'L1'], ['A12', cellLabel_(132, 12) === 'A12'],
    ['L12', cellLabel_(143, 12) === 'L12'],
    ['rc roundtrip', idx_(rc_(87, 12).r, rc_(87, 12).c, 12) === 87],
    ['corner neighbors', neighbors8_(0, 12, 12).length === 3],
    ['edge neighbors', neighbors8_(5, 12, 12).length === 5],
    ['inner neighbors', neighbors8_(20, 12, 12).length === 8],
    ['diagonal included', neighbors8_(13, 12, 12).indexOf(0) >= 0],
    ['chebyshev', chebyshev_(0, 13, 12) === 1]
  ];
  tests.forEach(function (t) { Logger.log((t[1] ? 'PASS ' : 'FAIL ') + t[0]); });
  if (tests.some(function (t) { return !t[1]; })) throw new Error('Geometry tests failed');
  return true;
}


// ============================================================================
// Game 모듈
// ============================================================================

function countTeam_(st, team) {
  return Object.keys(st.players || {}).filter(function (id) { return st.players[id].team === team; }).length;
}
function playersOfTeam_(st, team) {
  return Object.keys(st.players).filter(function (id) { return st.players[id].team === team; }).map(function (id) { return st.players[id]; });
}
function turnKey_(st) { return st.turnTeam + ':' + st.round; }
function canPlayNow_(st, playerId) {
  var p = st.players[playerId];
  return !!p && st.status === 'running' && p.team === st.turnTeam && p.skipTurnKey !== turnKey_(st) && Date.now() <= st.turnEndsAt + 2000;
}
function totals_(st) {
  return {
    H:{ territory:st.territory.H, bonus:st.bonus.H, total:st.territory.H + st.bonus.H },
    C:{ territory:st.territory.C, bonus:st.bonus.C, total:st.territory.C + st.bonus.C }
  };
}
function transferCellOwner_(st, cellIdx, newTeam, cause) {
  var cell = st.board[cellIdx];
  if (!cell || cell.o === newTeam) return 0;
  if (cell.o) st.territory[cell.o]--;
  cell.o = newTeam; st.territory[newTeam]++;
  if (cause !== 'solve') cell.by = null;
  return 1;
}

// ── 배치 ────────────────────────────────────────────────────────────────────
// 팀별 씨앗에서 뭉쳐 놓던 방식을 버리고 전원을 보드 전체에 무작위로 흩뿌린다.
// 뭉쳐 두면 안쪽 학생의 둘레가 전부 아군 칸이 되어 문제를 아예 받지 못했다.

/** 이 자리에 서면 도전할 칸(아군 칸이 아닌 이웃)이 하나라도 있는가 */
function canChallengeFrom_(st, pos, team) {
  return neighbors8_(pos, st.rows, st.cols).some(function (n) { return st.board[n].o !== team; });
}

function occupiedMap_(st, exceptId) {
  var out = {};
  Object.keys(st.players).forEach(function (id) {
    var q = st.players[id];
    if (id !== exceptId && q.pos !== null && q.pos !== undefined) out[q.pos] = true;
  });
  return out;
}

/**
 * 새 게임: 전원을 서로 겹치지 않게 무작위 배치하고, 선 자리를 그 학생의 팀 색으로 칠한다.
 * 시작 칸을 칠하지 않던 때는 교실 TV에 보드가 온통 회색이라 교사가 "배치가 안 됐다"고 읽었다.
 * (2026-08-05 시연 피드백) 칠해 두면 팀 분포가 한눈에 보이고 학생도 '내 땅'을 바로 알아본다.
 */
function assignRandomPositions_(st) {
  var ids = Object.keys(st.players), n = st.board.length;
  if (ids.length > n) throw new Error('학생 수(' + ids.length + '명)가 칸 수(' + n + '칸)보다 많습니다. 보드를 키워 주세요.');
  var pool = []; for (var i = 0; i < n; i++) pool.push(i);
  shuffle_(pool);
  shuffle_(ids).forEach(function (id, k) {
    var p = st.players[id];
    p.pos = pool[k];
    transferCellOwner_(st, p.pos, p.team, 'start');   // territory 도 함께 올라간다
  });
}

/**
 * 게임이 만들어진 뒤에 들어온 학생. 비어 있는 칸 중 도전 가능한 자리를 우선해 무작위로 준다.
 * 새 게임 때와 똑같이 선 자리를 팀 색으로 칠한다 — 이게 빠져 있어서, 새 게임을 먼저 누르고
 * 학생을 받으면 보드가 회색인 채 이름만 뜨는 일이 생겼다(2026-08-05).
 * 남의 땅을 들어오자마자 뺏지는 않으므로, 임자 없는 칸을 먼저 고른다.
 */
function placeLatePlayer_(st, playerId) {
  var p = st.players[playerId], occupied = occupiedMap_(st, playerId), free = [];
  for (var i = 0; i < st.board.length; i++) if (!occupied[i]) free.push(i);
  if (!free.length) throw new Error('새 학생의 말을 놓을 빈 칸이 없습니다.');
  function usable(list) { return list.filter(function (i) { return canChallengeFrom_(st, i, p.team); }); }
  var neutral = usable(free.filter(function (i) { return !st.board[i].o; }));
  var from = neutral.length ? neutral : (usable(free).length ? usable(free) : free);
  p.pos = from[Math.floor(Math.random() * from.length)];
  if (!st.board[p.pos].o) transferCellOwner_(st, p.pos, p.team, 'start');
}

/**
 * 턴 시작 시 아군 영토에 갇힌 학생을 가장 가까운 도전 가능한 빈자리로 옮긴다.
 * 이게 없으면 게임이 진행될수록 자기 팀 땅에 둘러싸인 학생이 문제를 못 푼다.
 */
function rescueTrapped_(st, team) {
  var occupied = occupiedMap_(st, null);
  playersOfTeam_(st, team).forEach(function (p) {
    if (p.pos === null || p.pos === undefined) return;
    if (canChallengeFrom_(st, p.pos, team)) return;
    var seen = {}, q = [p.pos];
    while (q.length) {
      var cur = q.shift();
      if (seen[cur]) continue;
      seen[cur] = true;
      if (cur !== p.pos && !occupied[cur] && canChallengeFrom_(st, cur, team)) {
        delete occupied[p.pos]; p.pos = cur; occupied[cur] = true; return;
      }
      neighbors8_(cur, st.rows, st.cols).forEach(function (n) { if (!seen[n]) q.push(n); });
    }
  });
}

function assignQuizzes_(board, rows, cols, n) {
  var m = board.length, seq = [], cells = [], i;
  while (seq.length < m) { var block = []; for (i = 0; i < n; i++) block.push(i); seq = seq.concat(shuffle_(block)); }
  seq = seq.slice(0, m); for (i = 0; i < m; i++) cells.push(i); shuffle_(cells);
  for (i = 0; i < m; i++) board[cells[i]].q = seq[i];
  for (var pass = 0; pass < 3; pass++) {
    var swapped = 0;
    for (i = 0; i < m; i++) {
      var nb = neighbors8_(i, rows, cols);
      for (var k = 0; k < nb.length; k++) if (board[nb[k]].q === board[i].q) {
        var j = Math.floor(Math.random() * m), tmp = board[i].q; board[i].q = board[j].q; board[j].q = tmp; swapped++; break;
      }
    }
    if (!swapped) break;
  }
}

function buildBoard_(cfg, quizCount) {
  var n = cfg.rows * cfg.cols, board = [], pool = [], i;
  for (i = 0; i < n; i++) board.push({ t:'N', q:-1, o:null, by:null, bc:0, tried:0 });
  for (i = 0; i < n; i++) pool.push(i);
  var total = cfg.cnt.T + cfg.cnt.S + cfg.cnt.A;
  if (total > pool.length) throw new Error('특수칸이 전체 칸보다 많습니다. 특수칸 수를 줄여 주세요.');
  shuffle_(pool); var p = 0;
  ['T','S','A'].forEach(function (type) { for (var k = 0; k < cfg.cnt[type]; k++) board[pool[p++]].t = type; });
  assignQuizzes_(board, cfg.rows, cfg.cols, quizCount);
  return board;
}


function adminNewGame(arg) {
  try {
    arg = arg || {};
    requireAdmin_(arg.token);
    var cfg = getConfig_(), src = getSourceQuizzes_();
    if (!src.length) throw new Error('퀴즈 탭에 읽을 수 있는 문항이 없습니다.');

    // 보드 만들기와 퀴즈 스냅샷 저장(시트 쓰기)은 락 밖에서 끝낸다.
    // 예전에는 둘 다 락 안에 있어 [새 게임] 한 번이 2초 가까이 락을 물었고,
    // 그동안 학생 요청 전부가 대기열에 쌓여 시작 버튼이 먹통이 됐다.
    var fresh = emptyState_(); fresh.gameId = randomId_('g');
    fresh.rows = cfg.rows; fresh.cols = cfg.cols; fresh.roundLimit = cfg.roundLimit;
    fresh.board = buildBoard_(cfg, src.length);
    saveQuizSnapshot_(fresh, src);

    var response = withLock_(function (old) {
      // clearPlayers=true 는 [초기화] 전용이다. 다음 반이 들어오기 전에 명단을 비운다.
      fresh.players = arg.clearPlayers ? {} : (old.players || {});
      // 학생 화면은 튕기면 저장된 이름으로 스스로 다시 들어온다(연결 끊김 대비).
      // 초기화는 '일부러 내보낸 것'이므로 그 자동 복구가 돌면 안 된다. 10분간 표시를 남겨
      // getState 가 다른 안내문을 주고, 화면은 그 문구를 보면 입장 화면으로 돌아간다.
      // 반드시 [초기화]일 때만 남긴다 — 평범한 [새 게임]에도 남기면 그 10분 동안
      // 자동 복구가 통째로 꺼져서, 정작 필요한 순간에 안전망이 사라진다.
      var rc = CacheService.getScriptCache();
      if (arg.clearPlayers) rc.put(RESET_MARK_KEY, '1', 600); else rc.remove(RESET_MARK_KEY);
      Object.keys(fresh.players).forEach(function (id) {
        var q = fresh.players[id];
        q.pos = null; q.skipTurns = 0; q.skipTurnKey = null; q.lastPlayedTurnKey = null; q.solved = 0; q.correct = 0;
      });
      assignRandomPositions_(fresh);
      // 시작 칸을 팀 색으로 칠하므로, 학생이 빽빽하면 첫 판부터 아군 땅에 둘러싸일 수 있다.
      ['H','C'].forEach(function (t) { rescueTrapped_(fresh, t); });
      snapshotPlacement_(fresh, 'newgame');
      Object.keys(old).forEach(function (k) { delete old[k]; }); Object.keys(fresh).forEach(function (k) { old[k] = fresh[k]; });
      var warning = src.length < fresh.board.length ? '문항 ' + src.length + '개로 ' + fresh.board.length + '칸을 채웠습니다. 각 문제가 최대 ' + Math.ceil(fresh.board.length/src.length) + '번 나옵니다.' : null;
      return { ok:true, quizCount:src.length, cellCount:fresh.board.length, playerCount:Object.keys(fresh.players).length, warning:warning };
    }, true);
    PropertiesService.getScriptProperties().setProperty('LIVE_GAME_ID', fresh.gameId);
    backupToSheet_(loadState_()); return response;
  } catch (e) { return fail_(e); }
}

function maskBoard_(st) { return st.board.map(function (c) { return { t:c.o ? c.t : '?', o:c.o }; }); }
function publicPlayers_(st) {
  var out = {}; Object.keys(st.players).forEach(function (id) { var p=st.players[id]; out[id]={name:p.name,team:p.team,pos:p.pos}; }); return out;
}

function getState(arg) {
  try {
    arg = arg || {}; var st = loadState_(), admin = false, p = arg.playerId ? st.players[arg.playerId] : null;
    if (arg.token) { requireAdmin_(arg.token); admin = true; }
    else if (!p) {
      throw new Error(CacheService.getScriptCache().get(RESET_MARK_KEY)
        ? '선생님이 게임을 초기화했어요. 이름을 다시 입력해 주세요.'
        : '다시 입장해 주세요.');
    }
    if (st.status === 'running' && st.turnEndsAt && Date.now() >= st.turnEndsAt) {
      // 15명이 같은 순간에 턴 종료를 감지하면 전원이 락 앞에 줄을 선다.
      // 뒤에 선 요청은 10초를 기다리다 실패하고, 그 사이 관리자의 [새 게임]까지 대기열에 갇힌다.
      // (2026-08-05 시연이 이렇게 무너졌다.) 턴당 한 요청만 넘기고 나머지는 그냥 현재 상태를 받는다.
      var advKey = 'ADVANCING:' + st.gameId + ':' + turnKey_(st), ac = CacheService.getScriptCache();
      if (!ac.get(advKey)) {
        ac.put(advKey, '1', 60);
        var auto = withLock_(function (live) {
          if (live.status !== 'running' || !live.turnEndsAt || Date.now() < live.turnEndsAt) return { advanced:false };
          return { advanced:true, result:advanceTurn_(live) };
        });
        if (auto.advanced) backupToSheet_(loadState_());
        st = loadState_(); p = arg.playerId ? st.players[arg.playerId] : null;
      }
    }
    if (p) touchPresence_(st.gameId, arg.playerId);
    var quizzes;
    if (arg.needQuizzes && canPlayNow_(st, arg.playerId)) {
      quizzes = getNeighborQuizzes_(st, arg.playerId, getGameQuizzes_(st));
      // 자기 차례이고 쉬는 것도 아닌데 받을 문제가 하나도 없다 = 어제 터진 그 증상.
      // 턴당 학생당 한 번만 남긴다(폴링마다 쌓이면 로그가 못 쓰게 된다).
      if (!quizzes || !Object.keys(quizzes).length) {
        var mark = 'NOQUIZ:' + st.gameId + ':' + turnKey_(st) + ':' + arg.playerId;
        var mc = CacheService.getScriptCache();
        if (p && !mc.get(mark)) {
          mc.put(mark, '1', 600);
          var free = neighbors8_(p.pos, st.rows, st.cols).filter(function (n) { return st.board[n].o !== p.team; });
          logEvent_('noquiz', { name:p.name, team:p.team, cell:p.pos,
            at:cellLabel_(p.pos, st.cols), free:free.length, round:st.round });
        }
      }
    }
    var same = Number(arg.rev) === st.rev;
    if (same) return { ok:true, nochange:true, rev:st.rev, endsAt:st.turnEndsAt, myQuizzes:quizzes,
      iAmSkipping:p ? p.skipTurnKey === turnKey_(st) : false, presence:admin ? getPresence_(st) : undefined };
    // gameId 를 반드시 함께 보낸다. 화면은 이 값이 바뀌면 들고 있던 문제 배정표를 버리고 새로 받는다.
    // 이게 없어서, [새 게임] 뒤에도 학생 화면이 옛 배정표로 문제를 보여 주고
    // 서버는 새 배정표로 채점하는 일이 생겼다(2026-08-05: 정답을 눌러도 오답 처리).
    return { ok:true, gameId:st.gameId, rev:st.rev, status:st.status, rows:st.rows, cols:st.cols, round:st.round,
      roundLimit:st.roundLimit, turnTeam:st.turnTeam, turnEndsAt:st.turnEndsAt, scores:totals_(st),
      board:admin ? st.board : maskBoard_(st), players:publicPlayers_(st), cellLocks:st.cellLocks,
      myPlayer:p ? {name:p.name,team:p.team,pos:p.pos,solved:p.solved,correct:p.correct,
        playedThisTurn:p.lastPlayedTurnKey === turnKey_(st)} : null,
      myQuizzes:quizzes, iAmSkipping:p ? p.skipTurnKey === turnKey_(st) : false,
      presence:admin ? getPresence_(st) : undefined, log:admin ? st.log : undefined };
  } catch (e) { return fail_(e); }
}

function validateStudentAction_(st, playerId) {
  var p = st.players[playerId]; if (!p) throw new Error('다시 입장해 주세요.');
  if (!canPlayNow_(st, playerId)) {
    if (p.skipTurnKey === turnKey_(st)) throw new Error('이번 턴은 폭풍으로 쉽니다.');
    if (Date.now() > (st.turnEndsAt || 0) + 2000) throw new Error('시간이 끝났어요.');
    throw new Error('지금은 우리 팀 차례가 아니에요.');
  }
  return p;
}

function pickCell(arg) {
  try {
    var before = loadState_(), bank = before.quizSnapId ? getGameQuizzes_(before) : null;
    return withLock_(function (st) {
      var p = validateStudentAction_(st, arg.playerId), cell = Number(arg.cell);
      if (neighbors8_(p.pos, st.rows, st.cols).indexOf(cell) < 0) throw new Error('내 말 둘레의 칸(대각선 포함)만 선택할 수 있어요.');
      var lock = st.cellLocks[cell]; if (lock && lock.by !== arg.playerId && lock.until > Date.now()) throw new Error('이미 다른 친구가 공략 중인 칸이에요.');
      if (st.board[cell].o === p.team) {
        p.pos = cell;
        return { ok:true, moved:true, myPos:cell, myQuizzes:getNeighborQuizzes_(st, arg.playerId, bank) };
      }
      if (p.lastPlayedTurnKey === turnKey_(st)) throw new Error('이번 턴에는 이미 문제를 한 번 풀었어요. 상대 팀 턴을 기다려 주세요.');
      var item = bank && bank[st.board[cell].q];
      if (!item) throw new Error('이 칸의 문제를 찾을 수 없어요.');
      st.cellLocks[cell] = { by:arg.playerId, until:st.turnEndsAt };
      st.attempts[arg.playerId] = { cell:cell, startedAt:Date.now() };
      // 채점에 쓸 바로 그 문제를 함께 돌려준다. 화면은 이걸로 다시 그린다.
      // 미리 받아 둔 사본으로만 그리면, 사본이 낡았을 때 학생이 본 보기와 채점 기준이 어긋난다
      // (2026-08-05: 정답을 눌렀는데 엉뚱한 문제의 정답이 표시됨). 출제와 채점의 출처를 하나로 묶는다.
      return { ok:true, quiz:{ q:item.q, options:item.options.slice() } };
    });
  } catch (e) { return fail_(e); }
}

function submitAnswer(arg) {
  try {
    var bank = getGameQuizzes_(loadState_());
    return withLock_(function (st) {
      var p = validateStudentAction_(st, arg.playerId), cell = Number(arg.cell), attempt = st.attempts[arg.playerId];
      if (!attempt || attempt.cell !== cell) throw new Error('문제 정보가 없어요.');
      if (!st.cellLocks[cell] || st.cellLocks[cell].by !== arg.playerId) throw new Error('내가 잠근 칸이 아니에요.');
      var c = st.board[cell], item = bank[c.q]; if (!item) throw new Error('문제 사본이 손상되었습니다.');
      var choice = Number(arg.choice), correct = choice === item.ans, bonus = 0, gain = 0, attack = 0;
      if (correct) {
        transferCellOwner_(st, cell, p.team, 'solve'); c.by = arg.playerId;
        var bit = p.team === 'H' ? 1 : 2, value = {N:0,T:2,S:0,A:0}[c.t] || 0;
        if (value && !(c.bc & bit)) { bonus = value; st.bonus[p.team] += value; c.bc |= bit; }
        p.pos = cell; if (c.t === 'S') p.skipTurns = 1; if (c.t === 'A') attack = attackSteal_(st, p.team);
        p.correct++; gain = 1 + bonus;
      }
      c.tried++; p.solved++; p.lastPlayedTurnKey=turnKey_(st); delete st.cellLocks[cell]; delete st.attempts[arg.playerId];
      st.log.unshift({at:Date.now(),team:p.team,name:p.name,cell:cell,ok:correct,gain:gain,type:c.t,cause:'solve'}); st.log=st.log.slice(0,30);
      return { ok:true, correct:correct, answerIdx:item.ans, answerText:item.options[item.ans], gain:gain,
        bonus:bonus, bonusSkipped:correct && c.t==='T' && bonus===0, attack:attack,
        cellType:c.t, scores:totals_(st), myPos:p.pos, playedThisTurn:true };
    });
  } catch (e) { return fail_(e); }
}

function attackSteal_(st, team) {
  var enemy = team === 'H' ? 'C' : 'H', owned = [];
  st.board.forEach(function (c,i) { if (c.o === enemy) owned.push(i); });
  if (!owned.length) return 0;
  return transferCellOwner_(st, owned[Math.floor(Math.random()*owned.length)], team, 'steal');
}

function cancelPick(arg) {
  try { return withLock_(function (st) { var a=st.attempts[arg.playerId]; if(a) delete st.cellLocks[a.cell]; delete st.attempts[arg.playerId]; return {ok:true}; }); }
  catch(e){ return fail_(e); }
}

function advanceTurn_(st) {
  if (!st.board.length) throw new Error('새 게임을 먼저 시작해 주세요.');
  if (st.status === 'ended') throw new Error('종료된 게임입니다.');
  if (st.lastTurnAt && Date.now() - st.lastTurnAt < 2000) throw new Error('방금 전환했습니다. 잠시 후 다시 눌러 주세요.');
  st.lastTurnAt = Date.now();
  st.cellLocks = {}; st.attempts = {};
  if (!st.turnTeam) st.turnTeam = 'H';
  else if (st.turnTeam === 'H') st.turnTeam = 'C';
  else { st.turnTeam = 'H'; st.round++; }
  if (st.round > st.roundLimit) return endGame_(st);
  var key = turnKey_(st);
  Object.keys(st.players).forEach(function (id) {
    var p = st.players[id]; if (p.team !== st.turnTeam) return;
    if (p.skipTurns > 0) { p.skipTurns--; p.skipTurnKey = key; }
    else if (p.skipTurnKey !== key) p.skipTurnKey = null;
  });
  rescueTrapped_(st, st.turnTeam);
  snapshotPlacement_(st, 'turn' + st.round + ':' + st.turnTeam);
  st.status = 'running'; st.turnEndsAt = Date.now() + getConfig_().turnSeconds * 1000;
  return { ok:true, round:st.round, turnTeam:st.turnTeam, turnEndsAt:st.turnEndsAt };
}

function adminNextTurn(arg) {
  try {
    requireAdmin_(arg && arg.token); var result = withLock_(function (st) {
      return advanceTurn_(st);
    }); backupToSheet_(loadState_()); flushEventLog_(); return result;
  } catch(e){ return fail_(e); }
}

function endGame_(st) {
  st.status='ended'; st.turnEndsAt=null; st.cellLocks={}; st.attempts={}; var scores=totals_(st);
  var winner=scores.H.total===scores.C.total?'무승부':(scores.H.total>scores.C.total?'홍팀':'청팀');
  try { var sh=getDb_().getSheetByName('_기록')||getDb_().insertSheet('_기록'); if(sh.getLastRow()===0) sh.appendRow(['종료시각','라운드','홍영토','홍보너스','홍합계','청영토','청보너스','청합계','승리팀','참가자수','참가자명단']); sh.appendRow([new Date(),st.round,scores.H.territory,scores.H.bonus,scores.H.total,scores.C.territory,scores.C.bonus,scores.C.total,winner,Object.keys(st.players).length,Object.keys(st.players).map(function(id){return st.players[id].name;}).join(', ')]); } catch(e) {}
  // 학생 명단은 지우지 않는다. 예전에는 여기서 st.players={} 로 비웠는데,
  // 그러면 게임이 끝나는 순간 전원이 '다시 입장해 주세요'로 튕겨 이름을 다시 쳐야 했다.
  // (2026-08-05 시연: 15명이 한꺼번에 튕겼다.) 명단을 남겨 두면 [새 게임] 한 번으로 이어서 한다.
  playersAll_(st).forEach(function (p) {
    p.pos = null; p.skipTurns = 0; p.skipTurnKey = null; p.lastPlayedTurnKey = null;
  });
  flushEventLog_();
  return {ok:true,winner:winner,scores:scores,players:Object.keys(st.players).length};
}
function adminEndGame(arg){try{requireAdmin_(arg&&arg.token);var r=withLock_(endGame_);backupToSheet_(loadState_());return r;}catch(e){return fail_(e);}}
function adminKick(arg){try{requireAdmin_(arg&&arg.token);return withLock_(function(st){var p=st.players[arg.playerId];if(!p)throw new Error('학생을 찾을 수 없습니다.');var a=st.attempts[arg.playerId];if(a)delete st.cellLocks[a.cell];delete st.attempts[arg.playerId];delete st.players[arg.playerId];return{ok:true};});}catch(e){return fail_(e);}}
function adminPeekCell(arg){try{requireAdmin_(arg&&arg.token);var st=loadState_(),cell=Number(arg.cell),c=st.board[cell],bank=getGameQuizzes_(st);if(!c||!bank[c.q])throw new Error('칸을 찾을 수 없습니다.');var q=bank[c.q];return{ok:true,cellLabel:cellLabel_(cell,st.cols),type:c.t,owner:c.o,tried:c.tried,quiz:{q:q.q,options:q.options,ansIdx:q.ans},ended:st.status==='ended'};}catch(e){return fail_(e);}}
