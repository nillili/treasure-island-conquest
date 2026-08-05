# plan_3D표시_v1

> 턴이 끝난 직후, **관리자 화면에만** 방금 끝난 턴의 공격·보물·폭풍 사건을 CSS 3D 아이콘으로 한꺼번에 재생하고, 재생이 끝나면 지금처럼 평면 마킹으로 되돌아간다.
> 조사 기준: 2026-08-05 작업본 (Backend.gs `version:9`, 정적 자산 `?v=20260803-3`). 버전 관리 저장소가 아니므로 기준 커밋 해시는 없다.

---

## 1. 제작자의 의도 (왜 만드는가)

### 1-1. 지금의 불편

현재 보드는 **결과만 남고 사건이 사라진다.**

한 학생이 문제를 풀면 서버는 다음 중 하나의 결과를 만든다.

| 결과 | 서버 동작 | 지금 화면에 남는 것 |
|---|---|---|
| 점령 (일반칸 정답) | 칸 주인이 바뀜 | 칸 색만 바뀜 |
| 보물 📦 | 칸 주인 + 보너스 2점 | 칸 색 + 사이드바 점수 숫자 |
| 폭풍 ⛈️ | 칸 주인 + 그 학생 다음 턴 쉼 | 칸 색만 바뀜 |
| 공격 💥 | 칸 주인 + **상대 땅 한 칸을 무작위로 빼앗음** | 칸 색 + 지도 어딘가의 색이 조용히 바뀜 |
| 실패 (오답) | 아무것도 안 바뀜 | 아무 표시 없음 |

특히 **공격**이 문제다. `attackSteal_()`([Backend.gs:813](../apps-script/Backend.gs#L813))은 상대 팀 소유 칸 중 하나를 무작위로 골라 소유권을 옮긴다. 교사가 12×12 = 144칸 지도를 보고 있다가 "방금 어디가 뒤집혔지?"를 눈으로 찾아내는 것은 사실상 불가능하다. 교실에서 이 게임의 재미는 "누가 뭘 터뜨렸는가"인데, **가장 극적인 순간이 아무 연출 없이 지나간다.**

보물도 마찬가지다. 보너스 2점은 사이드바 숫자가 `16 → 18`로 조용히 바뀌는 것으로 끝난다. 폭풍에 걸려 다음 턴을 통째로 쉬게 된 학생도 화면상으론 흔적이 없다.

### 1-2. 왜 지금, 왜 이 타이밍인가

이 게임은 **교사 화면을 교실 프로젝터에 띄워 놓고** 진행한다. 학생 화면은 각자 태블릿/노트북이고 문제 풀이에 집중한다. 즉 **연출이 의미를 갖는 화면은 관리자 화면 하나뿐이다.**

그리고 재생 타이밍이 자연스럽게 정해진다. 홍팀 턴이 끝나면 청팀 턴이 시작되고, **청팀 학생들이 문제를 푸는 동안 홍팀 학생들과 교사는 할 일이 없다.** 바로 이 빈 구간이 "방금 홍팀이 무슨 짓을 했는지" 되짚어 주기에 완벽한 시간이다. 사용자가 말한 그대로다 — *"턴이 끝난 뒤 관리자 화면에만 한꺼번에 재생한다. 아마 이때는 상대방이 문제를 풀고 있을 때이다."*

턴 중간에 실시간으로 띄우지 않는 이유도 여기 있다. 한 턴에 20명이 동시에 문제를 풀면 이벤트가 산발적으로 터져서 관리자 화면이 계속 흔들린다. **모아서, 턴 경계에서, 한 번에** 보여주는 편이 교실 통제에 유리하다.

### 1-3. 조사로 드러난 현실

**이미 있는 것 (재사용):**

- **이벤트 로그가 이미 쌓이고 있다.** [Backend.gs:806](../apps-script/Backend.gs#L806)에서 문제를 풀 때마다
  `{at, team, name, cell, ok, gain, type, cause}` 를 `st.log` 앞에 넣고 30개로 자른다.
  → **필요한 정보(누가·어느 칸·무슨 종류·성공 여부)는 이미 전부 있다.**
- **관리자에게만 내려가고 있다.** [Backend.gs:755](../apps-script/Backend.gs#L755) — `log: admin ? st.log : undefined`.
  → 학생에게 새지 않게 하는 장치가 이미 되어 있다. 그대로 쓴다.
- **턴 식별자가 있다.** `turnKey_(st)` = `"H:3"` 형태([Backend.gs:579](../apps-script/Backend.gs#L579)).
- **클라이언트가 턴 전환을 이미 감지한다.** [app.js:20](../cloudflare/public/app.js#L20) `pollState` 안의
  `const changed = APP.state && (APP.state.turnTeam!==r.turnTeam || APP.state.round!==r.round)`.
- **아이콘 문자가 이미 정의돼 있다.** [app.js:32](../cloudflare/public/app.js#L32) `const ICON={N:"",Q:"",T:"📦",S:"⛈️",A:"💥"}`.
- **셀 애니메이션 전례가 있다.** `.cell.attacking{animation:attacking .8s infinite}`([style.css:4](../cloudflare/public/style.css#L4)).

**없는 것 (이번에 만든다):**

1. **로그 항목에 턴 정보가 없다.** `at`(타임스탬프)만 있어서 "3라운드 홍팀 턴에 일어난 일"을 골라낼 수 없다.
2. **공격으로 빼앗은 칸 번호가 어디에도 안 남는다.** `attackSteal_()`은 `transferCellOwner_()`의 반환값(성공 1 / 실패 0)을 그대로 돌려주기 때문에, **몇 번 칸을 빼앗았는지가 그 자리에서 버려진다.** 이번 기능의 핵심 요구("공격당한 상대 영역도 3D 아이콘으로 표시")를 위해 **반드시 서버를 고쳐야 한다.**
3. 3D 렌더 레이어 자체.

**함정 (설계에 반영해야 함):**

- **관리자는 2초마다 폴링하고, 그때마다 보드 DOM을 통째로 다시 그린다.**
  [app.js:22](../cloudflare/public/app.js#L22) `ms = APP.role==="admin" ? 2000 : ...`
  → [app.js:40](../cloudflare/public/app.js#L40) `renderAdmin` → [app.js:32](../cloudflare/public/app.js#L32) `renderBoard` → `host.innerHTML = html`.
  **3D 요소를 `#admin-board` 안에 넣으면 최대 2초 만에 지워진다.** 재생은 6~8초 지속되므로, 3D 레이어는 반드시 **보드 DOM 바깥의 형제 요소**여야 한다.
- **칸 크기가 매 렌더마다 다시 계산된다.** `px = Math.max(23, Math.min(45, Math.floor((innerWidth-330)/(cols+1))))`.
  → 오버레이 좌표를 상수로 굳히면 안 되고, 실제 셀 DOM의 위치를 읽어 배치해야 한다.
- **보드 그리드에는 축(axis) 행/열이 하나씩 더 있다.** `(cols+1) × (rows+1)`, `gap:2px`. 칸 인덱스 `i`는 그리드상 `(row+1, col+1)` 자리다.
- **`.cell`은 `overflow:hidden`이고 최대 45px다.** 3D 아이콘과 이름표는 칸 밖으로 튀어나와야 하므로 셀 내부에 넣을 수 없다.
- **턴은 관리자 버튼 없이도 넘어간다.** `getState` 안에서 시간 초과 시 `advanceTurn_`이 자동 실행된다([Backend.gs:721](../apps-script/Backend.gs#L721)). 따라서 스냅샷 로직은 `adminNextTurn` 핸들러가 아니라 **`advanceTurn_` 안**에 넣어야 두 경로 모두 잡힌다.
- **정적 자산 캐시버전.** [index.html:2](../cloudflare/public/index.html#L2)의 `?v=20260803-3` (css/js 2곳). `public/_headers`에서 `no-store`도 걸려 있지만 관례상 같이 올린다.

### 1-4. 확정된 방향

| 결정 | 선택 | 근거 |
|---|---|---|
| 대상 화면 | **관리자 전용** | 사용자 지정. 학생 화면은 손대지 않는다 |
| 재생 시점 | **턴 전환 직후 1회** | 상대 팀이 문제 푸는 빈 시간 |
| 표시 대상 | **공격 💥 · 보물 📦 · 폭풍 ⛈️** (정답인 것만) + **공격으로 빼앗긴 상대 칸** | 사용자 지정. 일반 점령·실패는 제외 |
| 소멸 방식 | **자동 소멸** (전부 뜬 뒤 3초 유지 → 페이드아웃, 총 6~8초) | 사용자 선택. 교사 시야를 오래 막지 않음. 사이드바 `⟳ 지난 턴 다시 보기`로 재생 가능 |
| 리듬 | **순차 등장** (0.45초 간격, 먼저 나온 것은 남아 있음) | 사용자 선택. 10개가 겹쳐도 읽힌다 |
| 이름 표기 | **성 한 글자** (`name.charAt(0)`) | 사용자 선택. 기존 말 배지와 같은 규칙 |
| 기술 | **CSS 3D** (`perspective` + `transform` + `@keyframes`) | 빌드 도구가 없는 단일 파일 구조. three.js는 번들러 도입이 필요해 과하다 |

**설계 원칙 — 3D 레이어는 게임 상태를 읽기만 하는 순수 연출이다.**
게임 로직·점수·소유권은 이미 서버가 결정한다. 이 레이어는 그 결과를 예쁘게 다시 말할 뿐이며, 실패하거나 꺼져도 게임 진행에는 아무 영향이 없어야 한다.

---

## 2. 개발 방법

### 2-1. 무엇을 건드리나

| 파일 | 변경 | 마이그레이션 |
|---|---|---|
| `apps-script/Backend.gs` | 로그에 턴 키·빼앗긴 칸 기록, `advanceTurn_`에서 턴 스냅샷 생성, `getState` 응답에 `lastTurn` 추가 | 없음 (아래 2-2 참조) |
| `cloudflare/public/style.css` | `.fx-*` 3D 연출 클래스 추가 | — |
| `cloudflare/public/app.js` | 리플레이 엔진(약 25줄), `renderBoard`에 재배치 훅 1줄, 버튼 바인딩 | — |
| `cloudflare/public/index.html` | 보드를 `#board-stage`로 감싸기, `#fx-layer` 추가, `⟳ 다시 보기` 버튼, 캐시버전 범프 | — |
| `mockup/08-admin-replay.html` | **신규.** 백엔드 없이 3D 연출만 확인하는 정적 시안 | — |
| `docs/PROJECT_SPEC.md` | 구현 후 상태 필드·API 응답 반영 | — |

### 2-2. 데이터 모델 변경

**스키마 마이그레이션은 없다.** 상태는 Google Apps Script `CacheService`의 JSON 한 덩어리이고([Backend.gs:202](../apps-script/Backend.gs#L202) `loadState_`), 스프레드시트 `_상태` 탭에 통째로 백업된다. 필드를 추가해도 기존 게임이 깨지지 않는다.

단, **`emptyState_()`에 기본값을 넣어야 한다.** 진행 중인 게임의 캐시에는 새 필드가 없으므로, 읽는 쪽은 항상 `st.lastTurn || null` 로 방어한다.

**`st.log[]` 항목 (기존 → 확장):**

```js
// 기존
{ at, team, name, cell, ok, gain, type, cause }
// 추가
{ ..., turn: "H:3",   // turnKey_(st) — 이 사건이 일어난 턴
       steal: 87 }    // 공격(A)일 때 빼앗은 상대 칸 인덱스. 없으면 필드 자체를 넣지 않음
```

**`st.lastTurn` (신규):**

```js
st.lastTurn = {
  key: "H:3",          // 방금 끝난 턴
  team: "H",           // 그 턴을 진행한 팀
  round: 3,
  events: [            // 시간순(오래된 것 먼저). 최대 12개
    { type:"A", cell:41, name:"김철수", team:"H", steal:87 },
    { type:"T", cell:19, name:"이영희", team:"H", gain:3 },
    { type:"S", cell:66, name:"박민수", team:"H" }
  ]
}
```

### 2-3. 서버 변경 (`apps-script/Backend.gs`)

#### (a) `emptyState_()` — 기본값 추가

[Backend.gs:198](../apps-script/Backend.gs#L198)

```js
cellLocks: {}, attempts: {}, log: [], lastTurn: null
```

#### (b) `attackSteal_()` — 빼앗은 칸 번호를 돌려준다

[Backend.gs:813](../apps-script/Backend.gs#L813). 현재는 `transferCellOwner_`의 성공 여부(1/0)를 그대로 반환한다. **칸 인덱스를 반환하도록 바꾸되, 인덱스 0이 falsy인 함정을 피하려고 실패는 `-1`로 한다.**

```js
function attackSteal_(st, team) {
  var enemy = team === 'H' ? 'C' : 'H', owned = [];
  st.board.forEach(function (c,i) { if (c.o === enemy) owned.push(i); });
  if (!owned.length) return -1;
  var target = owned[Math.floor(Math.random()*owned.length)];
  return transferCellOwner_(st, target, team, 'steal') ? target : -1;
}
```

#### (c) `submitAnswer()` — 호출부와 로그

[Backend.gs:797~807](../apps-script/Backend.gs#L797). 지역변수 `attack`이 응답 필드 `attack:attack`으로 그대로 나간다. **응답의 의미(0/1)는 유지하고 칸 번호는 로그에만 넣는다.** (프런트 `submitChoice`는 현재 `r.attack`을 쓰지 않지만, 외부 계약을 조용히 바꾸지 않는다.)

```js
// 기존:  var correct = ..., bonus = 0, gain = 0, attack = 0;
   var correct = ..., bonus = 0, gain = 0, attack = 0, stolen = -1;
   ...
// 기존:  if (c.t === 'A') attack = attackSteal_(st, p.team);
   if (c.t === 'A') { stolen = attackSteal_(st, p.team); attack = stolen >= 0 ? 1 : 0; }
   ...
// 기존 806행 로그 한 줄을 아래로 교체
   var entry = { at:Date.now(), team:p.team, name:p.name, cell:cell, ok:correct,
                 gain:gain, type:c.t, cause:'solve', turn:turnKey_(st) };
   if (stolen >= 0) entry.steal = stolen;
   st.log.unshift(entry); st.log = st.log.slice(0, 30);
```

> `turnKey_(st)`는 `st.turnTeam + ':' + st.round`이고, 이 시점에는 아직 턴이 넘어가지 않았으므로 **푼 학생의 턴**이 정확히 찍힌다.

#### (d) `advanceTurn_()` — 끝나는 턴을 스냅샷

[Backend.gs:826](../apps-script/Backend.gs#L826). **함수 맨 앞, 어떤 상태도 바뀌기 전에** 넣는다. 이렇게 하면 관리자의 `adminNextTurn`과 시간 초과 자동 전환([Backend.gs:721](../apps-script/Backend.gs#L721)) 두 경로가 모두 잡히고, `round > roundLimit`로 `endGame_`이 호출되는 마지막 턴도 포함된다.

```js
function advanceTurn_(st) {
  if (!st.board.length) throw new Error('새 게임을 먼저 시작해 주세요.');
  if (st.status === 'ended') throw new Error('종료된 게임입니다.');
  snapshotTurnEvents_(st);          // ← 추가 (기존 로직은 이 아래 그대로)
  st.cellLocks = {}; st.attempts = {};
  ...
}

// 새 함수. 방금 끝난 턴에서 3D로 보여줄 사건만 골라 st.lastTurn 에 담는다.
function snapshotTurnEvents_(st) {
  if (!st.turnTeam) { st.lastTurn = null; return; }   // 게임 첫 '시작' 클릭
  var key = turnKey_(st), events = [];
  // st.log 는 최신이 앞이다. 시간순으로 보여주려고 뒤에서부터 훑는다.
  for (var i = st.log.length - 1; i >= 0; i--) {
    var L = st.log[i];
    if (L.turn !== key || !L.ok) continue;
    if (L.type !== 'A' && L.type !== 'T' && L.type !== 'S') continue;
    var e = { type:L.type, cell:L.cell, name:L.name, team:L.team };
    if (L.gain) e.gain = L.gain;
    if (typeof L.steal === 'number') e.steal = L.steal;
    events.push(e);
    if (events.length >= 12) break;   // 재생 시간 상한
  }
  st.lastTurn = events.length ? { key:key, team:st.turnTeam, round:st.round, events:events } : null;
}
```

> **`st.log`가 30개로 잘린다는 점을 감안한다.** 20명이 한 턴에 전부 풀면 30개 안에 이전 턴 기록이 밀려 나갈 수 있지만, 우리가 필요한 것은 **가장 최근 턴**이므로 항상 앞쪽에 남아 있다. 안전하다.

#### (e) `getState()` — 관리자 응답에 실어 보낸다

[Backend.gs:755](../apps-script/Backend.gs#L755), `log:admin ? st.log : undefined` 옆에 추가한다.

```js
presence:admin ? getPresence_(st) : undefined,
log:admin ? st.log : undefined,
lastTurn:admin ? (st.lastTurn || null) : undefined
```

**`nochange:true` 분기([Backend.gs:747](../apps-script/Backend.gs#L747))에는 넣지 않는다.** 턴 전환은 `withLock_`을 거치면서 `st.rev`를 올리므로([Backend.gs:222](../apps-script/Backend.gs#L222)) 반드시 전체 상태 응답으로 내려간다.

#### (f) 배포 확인용 버전 표시

[Backend.gs:18](../apps-script/Backend.gs#L18) `doGet`의 `version:9` → `version:10`, `replay3d:true` 추가. `curl <웹앱URL>` 한 번으로 새 백엔드가 올라갔는지 확인하는 기존 관례를 따른다.

### 2-4. 프런트엔드 — HTML 구조

[index.html:10](../cloudflare/public/index.html#L10) 관리자 섹션. **보드를 무대(stage)로 감싸고 3D 레이어를 형제로 둔다.** (2초마다 `#admin-board`의 innerHTML이 날아가므로 안에 넣으면 안 된다.)

```html
<!-- 기존 -->
<main class="panel board-wrap admin-main"><div id="admin-board"></div><small ...>

<!-- 변경 -->
<main class="panel board-wrap admin-main">
  <div id="board-stage"><div id="admin-board"></div><div id="fx-layer" aria-hidden="true"></div></div>
  <small class="board-help">셀을 클릭하면 문제를 미리 볼 수 있습니다.</small>
```

사이드바 버튼 묶음(`<div class="buttons">`) 위에 다시 보기 버튼을 넣는다.

```html
<button id="replay-button" class="button muted hidden">⟳ 지난 턴 다시 보기</button>
```

`<head>`의 캐시버전을 올린다(css·js 2곳): `?v=20260803-3` → `?v=20260805-1`.

### 2-5. 프런트엔드 — CSS 3D (`style.css` 끝에 추가)

무대와 원근:

```css
#board-stage{position:relative;width:max-content;margin:auto}
#fx-layer{position:absolute;inset:0;pointer-events:none;z-index:6;
  perspective:620px;perspective-origin:50% 25%}
```

개별 연출 요소. 칸 위에 절대 배치하고, 아이콘 타일이 **보드에서 솟아오르며 회전**한다.

```css
.fx{position:absolute;width:var(--cell,42px);height:var(--cell,42px);
  transform-style:preserve-3d;opacity:0;
  animation:fx-in .55s cubic-bezier(.2,1.5,.4,1) forwards}
.fx.out{animation:fx-out .45s ease-in forwards}

/* 바닥 그림자 — 높이를 눈으로 알게 해 준다 */
.fx:before{content:"";position:absolute;left:12%;bottom:-6px;width:76%;height:9px;
  border-radius:50%;background:#0b2b3f;filter:blur(3px);opacity:.42;
  transform:translateZ(-1px)}

/* 솟아오른 타일: Y축으로 계속 도는 3D 판 */
.fx-tile{position:absolute;inset:0;display:grid;place-items:center;
  font-size:calc(var(--cell,42px) * .62);line-height:1;
  border-radius:9px;background:#fffdf5;border:2px solid #d7b477;
  box-shadow:0 6px 14px #0b2b3f66;
  transform-style:preserve-3d;backface-visibility:visible;
  animation:fx-spin 3.2s linear infinite}

/* 이름표 — 타일 아래에 평면으로 붙는다 */
.fx-name{position:absolute;left:50%;bottom:-19px;transform:translateX(-50%);
  font-size:11px;font-weight:900;color:#fff;white-space:nowrap;
  padding:1px 7px;border-radius:9px;box-shadow:0 2px 5px #0b2b3f88}
.fx.H .fx-name{background:var(--H)} .fx.C .fx-name{background:var(--C)}

/* 종류별 강조 */
.fx-A .fx-tile{border-color:#e05a4f;box-shadow:0 6px 16px #e05a4f88}
.fx-T .fx-tile{border-color:var(--gold);box-shadow:0 6px 16px #f0b42999}
.fx-S .fx-tile{border-color:#5f7d92;box-shadow:0 6px 16px #2b3a4499}

/* 빼앗긴 상대 칸: 솟지 않고 가라앉으며 붉게 흔들린다 */
.fx-steal{animation:fx-steal-in .6s ease-out forwards}
.fx-steal .fx-tile{background:#ffe9e6;border-color:#e05a4f;animation:fx-shake .5s ease-in-out 2}

@keyframes fx-in{
  0%{opacity:0;transform:translateZ(0) translateY(10px) rotateX(72deg) scale(.45)}
  100%{opacity:1;transform:translateZ(46px) translateY(-14px) rotateX(0deg) scale(1)}}
@keyframes fx-steal-in{
  0%{opacity:0;transform:translateZ(46px) rotateX(0deg) scale(1.25)}
  100%{opacity:1;transform:translateZ(6px) rotateX(38deg) scale(1)}}
@keyframes fx-spin{to{transform:rotateY(360deg)}}
@keyframes fx-shake{25%{transform:translateX(-4px)}75%{transform:translateX(4px)}}
@keyframes fx-out{to{opacity:0;transform:translateZ(0) translateY(6px) rotateX(60deg) scale(.6)}}

@media (prefers-reduced-motion:reduce){
  .fx,.fx-steal{animation-duration:.01s}
  .fx-tile{animation:none}
}
```

> `--cell`은 `renderBoard`가 이미 보드 요소에 `host.style.setProperty("--cell", px+"px")`로 심어 둔다([app.js:32](../cloudflare/public/app.js#L32)). `#fx-layer`는 형제라 상속을 못 받으므로, 아래 JS에서 무대(`#board-stage`)에도 같은 값을 심는다.

### 2-6. 프런트엔드 — 리플레이 엔진 (`app.js`)

기존 코드는 한 줄에 한 함수를 몰아 쓰는 압축 스타일이다. **같은 스타일을 유지한다.**

`APP` 객체([app.js:2](../cloudflare/public/app.js#L2))에 필드 추가: `fxKey:null, fxTimers:[]`.

```js
/* ── 턴 리플레이 (관리자 전용, 순수 연출) ───────────────────── */
const FX_ICON={T:"📦",S:"⛈️",A:"💥"},FX_STEP=450,FX_HOLD=3000;
function fxCellBox(cell){const el=document.querySelector(`#admin-board [data-cell="${cell}"]`);return el?{x:el.offsetLeft,y:el.offsetTop}:null}
function fxClear(){APP.fxTimers.forEach(clearTimeout);APP.fxTimers=[];const layer=$("fx-layer");if(layer)layer.innerHTML=""}
function fxPlace(node){const box=fxCellBox(Number(node.dataset.cell));if(!box)return;node.style.left=`${box.x}px`;node.style.top=`${box.y}px`}
function fxReposition(){const px=$("admin-board").style.getPropertyValue("--cell");if(px)$("board-stage").style.setProperty("--cell",px);document.querySelectorAll("#fx-layer .fx").forEach(fxPlace)}
function fxNode(cell,team,type,label,steal){const node=document.createElement("div");node.className=`fx ${team} fx-${type}${steal?" fx-steal":""}`;node.dataset.cell=cell;node.innerHTML=`<div class="fx-tile">${steal?"💢":FX_ICON[type]}</div><div class="fx-name">${escapeHtml(label)}</div>`;return node}
function playReplay(lastTurn){
  if(!lastTurn?.events?.length||!$("fx-layer"))return;fxClear();APP.fxKey=lastTurn.key;
  const layer=$("fx-layer"),items=[];
  lastTurn.events.forEach(e=>{items.push({cell:e.cell,team:e.team,type:e.type,label:e.name.charAt(0),steal:false});
    if(e.type==="A"&&typeof e.steal==="number")items.push({cell:e.steal,team:e.team==="H"?"C":"H",type:"A",label:e.team==="H"?"청":"홍",steal:true})});
  const step=Math.min(FX_STEP,Math.floor(4000/Math.max(1,items.length)));
  items.forEach((it,i)=>APP.fxTimers.push(setTimeout(()=>{const node=fxNode(it.cell,it.team,it.type,it.label,it.steal);layer.appendChild(node);fxReposition()},i*step)));
  const total=(items.length-1)*step+FX_HOLD;
  APP.fxTimers.push(setTimeout(()=>document.querySelectorAll("#fx-layer .fx").forEach(n=>n.classList.add("out")),total));
  APP.fxTimers.push(setTimeout(fxClear,total+500));
}
```

**연결 지점 3곳:**

1. **턴 전환 감지** — `pollState`([app.js:20](../cloudflare/public/app.js#L20)) 안, `APP.state=r; APP.rev=r.rev;` 다음에 한 줄:
   ```js
   if(APP.role==="admin"&&r.lastTurn&&r.lastTurn.key!==APP.fxKey)playReplay(r.lastTurn);
   ```
   `APP.fxKey`가 마지막으로 재생한 턴 키라서 **같은 턴이 두 번 재생되지 않는다.** (2초마다 폴링하므로 이 방어가 필수다.)

2. **보드 재렌더 후 재배치** — `renderBoard`([app.js:32](../cloudflare/public/app.js#L32)) 마지막 `host.innerHTML=html` 다음에:
   ```js
   if(admin&&APP.fxTimers.length)fxReposition();
   ```
   2초마다 셀 DOM이 새로 생겨도 오버레이가 정확한 칸 위에 다시 붙는다. 창 크기 변화로 `px`가 달라져도 따라간다.

3. **다시 보기 버튼** — `renderAdmin` 끝에 `$("replay-button").classList.toggle("hidden",!APP.state?.lastTurn)`, 그리고 [app.js:53](../cloudflare/public/app.js#L53) 바인딩 줄에
   ```js
   $("replay-button").addEventListener("click",()=>playReplay(APP.state?.lastTurn));
   ```
   버튼 재생은 `APP.fxKey`를 이미 같은 값으로 덮어써도 무관하다(직접 호출이므로 중복 방어를 거치지 않는다).

**게임 종료·새 게임 시 정리:** `leaveApp`([app.js:15](../cloudflare/public/app.js#L15))과 `newGame` 성공 처리에 `fxClear(); APP.fxKey=null;`을 넣는다.

### 2-7. 목업 (`mockup/08-admin-replay.html`) — 신규

백엔드·워커 없이 **파일을 더블클릭해서 3D 연출만** 확인하는 정적 시안. `mockup/ui.css`를 쓰되 위 `.fx-*` CSS를 복사해 넣고, 가짜 이벤트 배열로 `playReplay`와 동일한 로직을 인라인 스크립트로 돌린다. 기존 `mockup/05-admin-main.html`의 관리자 레이아웃을 복제하고 하단에 `[재생]` 버튼을 둔다.

**연출 타이밍·색·크기를 다듬는 작업은 전부 여기서 한다.** Apps Script 배포는 왕복이 느려서 연출 튜닝에 쓰면 안 된다.

### 2-8. 변경 파일 체크리스트

- [ ] `apps-script/Backend.gs` — `emptyState_` 에 `lastTurn:null`
- [ ] `apps-script/Backend.gs` — `attackSteal_` 반환값을 칸 인덱스(실패 `-1`)로
- [ ] `apps-script/Backend.gs` — `submitAnswer`의 `attack` 계산부 + 로그 항목(`turn`,`steal`)
- [ ] `apps-script/Backend.gs` — `snapshotTurnEvents_` 신규 + `advanceTurn_` 첫 줄 호출
- [ ] `apps-script/Backend.gs` — `getState` 응답에 `lastTurn`
- [ ] `apps-script/Backend.gs` — `doGet` `version:10, replay3d:true`
- [ ] `cloudflare/public/index.html` — `#board-stage`/`#fx-layer` 래핑, `#replay-button`, 캐시버전 `?v=20260805-1`
- [ ] `cloudflare/public/style.css` — `.fx-*` 3D 블록
- [ ] `cloudflare/public/app.js` — `APP.fxKey/fxTimers`, 리플레이 엔진, 연결 3곳, 정리 2곳
- [ ] `mockup/08-admin-replay.html` — 신규 시안
- [ ] `docs/PROJECT_SPEC.md` — `st.lastTurn`, `log.turn/steal`, `getState.lastTurn` 반영

---

## 3. 테스트 방법

### 3-1. 1단계 — 연출만 (백엔드 불필요)

```bash
xdg-open mockup/08-admin-replay.html
```

- [ ] `[재생]`을 누르면 아이콘이 **0.45초 간격으로 하나씩** 솟아오른다.
- [ ] 각 아이콘이 계속 Y축 회전하고, 아래에 타원 그림자가 있어 떠 있어 보인다.
- [ ] 이름표는 **성 한 글자**, 팀 색(홍=빨강 / 청=초록) 배경이다.
- [ ] 공격 이벤트는 **두 개**가 뜬다 — 공격한 칸(💥, 공격팀 색)과 빼앗긴 칸(💢, 피해팀 색, 가라앉으며 흔들림).
- [ ] 전부 뜬 뒤 3초 유지 → 페이드아웃 → 보드가 평면 마킹만 남는다.
- [ ] 브라우저 창 폭을 줄였다 늘려도 아이콘이 해당 칸 위에 붙어 있다.
- [ ] OS 설정에서 "동작 줄이기"를 켜면 회전이 멈춘다.

### 3-2. 2단계 — 로컬 워커

```bash
cd cloudflare && npm run dev      # wrangler dev
```

`.dev.vars`에 `APPS_SCRIPT_SECRET`이 있어야 `/api`가 실제 백엔드로 나간다(자세한 절차는 [DEPLOY.md](DEPLOY.md)).

- [ ] `npm run check` 통과 (`wrangler types --check && tsc --noEmit && wrangler deploy --dry-run`)
- [ ] 관리자로 로그인 → 보드가 평소대로 그려진다(무대 래핑이 레이아웃을 깨지 않았는지).
- [ ] 브라우저 콘솔에 오류가 없다.

### 3-3. 3단계 — 실제 게임 시나리오

준비: 관리자 1 + 학생 2명(홍/청 각 1명, 시크릿 창). 환경설정에서 **행/열 6×6, 특수칸 T=4 S=4 A=4** 로 줄이면 특수칸을 금방 밟는다. 풀이 시간은 60초 정도로.

| # | 시나리오 | 기대 결과 |
|---|---|---|
| 1 | 홍팀 학생이 💥 공격칸 정답 → 관리자가 `다음 턴` 클릭 | 관리자 화면에 💥(공격 칸, `김`) + 💢(빼앗긴 청팀 칸, `청`) 두 개가 뜬다. 💢 위치가 실제로 색이 바뀐 칸과 일치한다 |
| 2 | 보물 📦 정답 후 턴 전환 | 📦 + 이름. 사이드바 보너스 증가와 같은 턴 |
| 3 | 폭풍 ⛈️ 정답 후 턴 전환 | ⛈️ + 이름. 다음 턴에 그 학생 화면이 "폭풍에 갇혔어요"가 된다 |
| 4 | 일반칸만 점령하고 턴 전환 | **아무것도 재생되지 않는다.** `다시 보기` 버튼도 숨겨진다 |
| 5 | 전원 오답만 내고 턴 전환 | 아무것도 재생되지 않는다 |
| 6 | 한 턴에 특수칸 4개 이상 발생 | 순차로 전부 뜨고, 총 등장 구간이 4초를 넘지 않는다 |
| 7 | 재생 중 8초 이상 그대로 둔다 | 2초 폴링으로 보드가 다시 그려져도 **아이콘이 사라지거나 어긋나지 않는다** (2-6의 연결 지점 2 검증) |
| 8 | 재생 끝난 뒤 `⟳ 지난 턴 다시 보기` | 같은 연출이 처음부터 다시 재생된다 |
| 9 | 재생 중 버튼을 연타 | 이전 재생이 정리되고 새로 시작한다(타이머 누수 없음) |
| 10 | 재생 중 다시 턴이 넘어간다(시간 초과 자동 전환) | 이전 재생이 지워지고 새 턴 것으로 교체된다 |
| 11 | **학생 화면**을 같은 시점에 확인 | 3D 아이콘이 **전혀 나타나지 않는다.** 개발자도구 Network에서 학생 `getState` 응답에 `lastTurn` 키가 없다 |
| 12 | 마지막 라운드 종료(`roundLimit` 도달) | 마지막 턴 사건이 정상 재생된다. 오류 없음 |
| 13 | `새 게임` 실행 | 남아 있던 아이콘이 즉시 사라진다 |

### 3-4. 배포

1. **Apps Script** — `apps-script/Backend.gs` 전체를 편집기에 붙여넣고 **`배포 → 배포 관리 → 편집 → 새 버전`** 으로 기존 배포를 갱신한다(새 배포를 만들면 URL이 바뀌어 `wrangler.jsonc`의 `APPS_SCRIPT_URL`도 고쳐야 한다).
   확인:
   ```bash
   curl -s "<웹앱 URL>" | head -c 200   # version:10, replay3d:true 가 보여야 한다
   ```
2. **Cloudflare**
   ```bash
   cd cloudflare && npm run deploy
   ```
3. 브라우저 강력 새로고침(Ctrl+Shift+R). `public/_headers`가 `no-store`라 보통은 불필요하지만, `?v=` 범프와 함께 확인한다.

**롤백:** Apps Script는 `배포 관리`에서 이전 버전으로 되돌린다. Cloudflare는 대시보드에서 이전 배포를 `Rollback` 한다. 3D 레이어는 순수 연출이라 프런트만 되돌려도 게임은 정상 동작한다.

---

## 부록 — 열린 결정

기본값으로 정해 둔 것들이다. 구현 전에 바꾸고 싶으면 말해 달라.

| # | 항목 | 기본값 | 대안 |
|---|---|---|---|
| 1 | 빼앗긴 칸 아이콘 | `💢` + 피해팀 한 글자(`홍`/`청`) | `🏴` / `❌`, 또는 이름 대신 `-1점` |
| 2 | 재생 대상 | 공격·보물·폭풍 (정답만) | 일반 점령(`type:"N"/"Q"`)이나 오답(`ok:false`)도 추가 — 서버 필터 한 줄, 클라이언트 아이콘만 추가하면 된다 |
| 3 | 최대 이벤트 수 | 12개 (`snapshotTurnEvents_`) | 20명 학급에서 특수칸이 많으면 상향 |
| 4 | 유지 시간 | 등장 후 3초 (`FX_HOLD`) | 프로젝터 거리가 멀면 4~5초 |
| 5 | 게임 첫 `시작` 클릭 | 재생 없음(`st.turnTeam`이 `null`이라 스냅샷을 건너뜀) | 그대로 두는 것이 맞다고 판단 |
| 6 | 학생 화면 | 변경 없음 | 나중에 자기 팀 것만 보여주는 축소판을 넣을 여지는 있다 |
