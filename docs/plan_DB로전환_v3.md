# plan_DB로전환_v3

> 보물섬 점령전을 **Apps Script + 스프레드시트** 백엔드에서 **Cloudflare Durable Objects + WebSocket**으로 옮긴다.
> 선생님은 **아이디/비번으로 로그인**하고, 올린 엑셀은 **보관함에 목록으로 남는다**. 목록에서 하나를 골라 방을 열면
> 학생은 방번호+이름으로 들어온다. 방 하나 = DO 하나.
>
> 조사일 2026-08-09 · 기준 코드 `apps-script/Backend.gs` v19 (1190행), `cloudflare/public/app.js` v19 (261행)
> **v3은 v2 + 코덱스 검토(`plan_DB로전환_v2_codex.md`, `plan_DB로전환_v2_토론.md`) 반영본이다.** → [1-8](#1-8-검토-반영-내역)

---

## 📌 구현 현황 (2026-08-09)

**만들었고 배포했다.** → https://treasure-island-v2.ds1lph.workers.dev
기존 앱스크립트판(`treasure-island-conquest`)은 그대로 두고 병행 운영한다.

| 항목 | 상태 |
|---|---|
| D1 스키마 · 로그인 · 퀴즈 보관함 | ✅ `migrations/` `src/auth.ts` `src/quizsets.ts` |
| 엑셀(.xlsx) 자체 파서 | ✅ `src/xlsx.ts` — 실제 파일로 CSV 와 동일 결과 확인 |
| 방 개설 saga (D1 예약 → DO init → ready) | ✅ `src/rooms.ts` |
| 게임 엔진 (WS/RPC 공용 · actionId 멱등 · alarm) | ✅ `src/room.ts` |
| 화면 (재연결 · 폴백 · 퀴즈 제목 · 범례) | ✅ `public/` |
| 시스템 점검 | ✅ `src/diagnose.ts` |
| 실시간 감시 도구 | ✅ `tools/watch.mjs` (Node. 파이썬 아님) |
| 실제 플레이 확인 | ✅ `tools/playtest.mjs` — 실서버 20명 완주 |
| 자동 테스트 | ✅ 135개 |
| 부하 시험 | ⬜ 아직 |

**설계에서 달라진 것**

| 설계(v3 본문) | 실제 | 왜 |
|---|---|---|
| `results` 테이블에 수업 기록을 남긴다 | **테이블을 없앴다**(`0002`) | 지난 게임은 보지 않기로 함. 결과는 [종료] 그 자리에서 보여 준다 |
| 최대 500문항 | **80문항** | 선생님 결정. 넘는 줄은 자동으로 건너뛴다 |
| 판 크기 자유 | **10×10 ~ 15×15** | 선생님 결정 |
| `tools/watch.py` (파이썬) | **`tools/watch.mjs`** (Node) | 추가 설치 없이 WebSocket 을 쓸 수 있다 |
| 한 방 93명까지 시험 | **20명 기준** | 한 반이 보통 16명, 많아야 20명 |
| 가입하면 빈 보관함 | **상식 샘플 50문항 자동 제공** | 빈 화면을 보면 뭘 할지 알 수 없다 |

**구현하면서 잡은 것 — 설계에 없던 문제**

| 무엇 | 증상이었을 모습 |
|---|---|
| 전체 상태를 한 벌로 방송 | **[새 게임]을 누르면 학생 전원이 자기 정보를 잃고 아무것도 못 누름** |
| 폴백(폴링)에 입장 경로 없음 | 방화벽 뒤 학생은 수업에서 통째로 빠짐 |
| 2초 연타 방지가 타이머까지 막음 | 알람이 예외로 죽고 그 방의 시계가 멈춤 |
| 채점 결과에 "이번 턴 끝"이 없음 | 3초 뒤 칸이 다시 켜져 한 문제 더 풀 수 있는 것처럼 보임 |
| 거절당하면 빈 화면에 갇힘 | 선생님이 남의 방에 붙으면 아무것도 없는 화면 |

**남은 것** — 부하 시험(20명 한 방 · 여러 방 동시), 수업 한 달 운영(2026-08-11~).

---

## 1. 제작자의 의도 (왜 만드는가)

### 1-1. 지금 무엇이 아픈가

이 게임은 이미 두 번의 수업에서 무너졌다.

**2026-08-05 공개 시연** — 15명 중 2명만 플레이했고 한 게임도 끝내지 못했다. 원인은 다섯 개가 얽혀 있었지만, 뿌리는 하나였다. `[시작]` 버튼을 눌러도 아무 일이 없었고, 선생님은 할 수 있는 게 없었다.

**2026-08-09 수업** — 다섯 명으로 줄여서 다시 했다. 그런데도 "수경"은 21분 동안 서버에 요청을 한 건도 보내지 못했고, "유진"은 2문제를 풀면 화면이 굳어 나갔다 들어오기를 반복했다. 하나씩 잡아 고쳤지만, 고칠 때마다 같은 모양의 새 구멍이 나왔다.

구멍의 모양이 매번 같은 이유가 있다.

**① 전역 락 — 모든 학생이 한 줄로 선다**

```js
// apps-script/Backend.gs:267
var lock = LockService.getScriptLock();
if (!lock.tryLock(10000)) throw new Error('서버가 혼잡합니다...');
```

이 락은 방마다가 아니라 **배포 전체에 하나**다. 15명이 동시에 답을 내면 15명이 줄을 선다. 부하 테스트에서 평균 응답 1,529ms, **최대 41,165ms**가 나온 게 이것이다. 처리량이 부족한 게 아니라 구조가 직렬이다.

**② 상태를 통째로 읽고 통째로 쓴다**

`loadState_()`는 게임 전체(보드 144칸 + 학생 + 잠금 + 로그)를 JSON 한 덩어리로 읽어 고치고 다시 쓴다. 서로 다른 칸을 고른 학생 둘도 반드시 충돌한다. 충돌할 이유가 없는데 충돌한다.

**③ 캐시가 예고 없이 증발한다**

`CacheService`(TTL 21600초)가 정본이고 스프레드시트는 백업이다. 캐시가 날아가면 시트에서 복구하는데, 이 복구 경로 자체가 사고의 단골이었다.

**④ 화면이 서버 상태를 흉내 낸다 — 그리고 어긋난다**

폴링이라 화면은 항상 몇 초 낡았다. 그래서 화면이 자기 사본을 들고 있어야 했고(`APP.myQuizzes`), 그 사본이 낡으면서 **학생이 본 문제와 채점된 문제가 어긋나는** 사고가 났다(2026-08-05).

**⑤ 화면이 굳으면 살아날 길이 없다**

```js
// 고치기 전 app.js — mode가 "solving"이면 간격이 0이 되어 타이머를 아예 안 건다
const ms = APP.mode==="solving" ? 0 : ...;
if(ms) APP.pollTimer = setTimeout(...)
```

채점이 한 번 실패하면 이 상태에 갇혀 클릭도 폴링도 죽었다. "유진"이 겪은 게 이것이다.

**⑥ 같은 이름으로 계속 다시 들어온다**

2026-08-09 로그에 "수경"이 10번, "수경2", "수경3"이 각각 따로 남아 있다. 화면이 굳을 때마다 학생이 다시 들어왔고, 그때마다 **서버는 새 사람으로 등록**했다. 선생님 명단이 유령으로 채워지고 팀 인원이 틀어졌다.

**⑦ 퀴즈가 스프레드시트 한 곳에 묶여 있다**

지금은 선생님 한 명의 스프레드시트 `퀴즈` 탭 하나만 읽는다(`Backend.gs:715 getSourceQuizzes_`). 과목을 바꾸려면 그 탭을 통째로 갈아엎어야 하고, 지난주 문제로 돌아갈 방법이 없다.

### 1-2. 왜 지금 바꾸는가

선생님의 요구가 커졌다.

> 모든 사람이 각자의 퀴즈로 사용할 수 있는지? … 이것이 동시에 진행된다면?
> 현재는 15명 절반만 성공, 실제로는 5명까지만 성공했음. 최대 동시접속 100명 정도 가능할런지?
>
> 선생님은 아이디/비번으로 입장. 등록된 엑셀은 목록 형태로 보관하고 있고,
> 게임 상단 왼쪽에 엑셀의 제목이 보인다(국어1, 사회1…). 목록에서 1개만 선택된다.

**지금 구조로는 불가능하다.** DB를 다시 설계해도 안 된다. 방을 열 개 만들어도 전역 락 하나를 열 방이 나눠 쓰기 때문에 100명이 한 줄로 선다.

그리고 지금이 바꾸기 좋은 때다. **버그를 하나씩 잡아 온 결과, 이 게임의 규칙은 이미 코드로 정확히 확정되어 있다.** 옮길 대상이 흔들리지 않는다.

### 1-3. 확정한 방향

Durable Objects로 간다. **방 하나가 곧 서버 하나**가 된다.

```
학생 ──WebSocket──┐
학생 ──WebSocket──┤→ [방 1234 DO]  상태·타이머·퀴즈가 전부 여기, 내장 SQLite에 저장
학생 ──WebSocket──┘
                    [방 5678 DO]  완전히 별개. 서로 밀지 않는다
```

| 지금의 고통 | DO에서는 |
|---|---|
| ① 전역 락에 100명이 줄 섬 | DO는 방 하나당 한 번에 하나씩 처리 → 경합이 **구조적으로 불가능** |
| ② 상태를 통째로 읽고 씀 | 내장 SQLite에 행 단위로. 필요한 칸만 건드림 |
| ③ 캐시 증발 | SQLite가 정본이자 영속. 복구 경로 자체가 사라짐 |
| ④ 화면 사본이 어긋남 | 서버가 밀어 준다. **화면이 사본을 들 이유가 없어짐** |
| ⑤ 굳으면 못 살아남 | 연결이 끊기면 끊긴 걸 안다. 재연결이 곧 재동기화 |
| ⑥ 같은 이름이 새 사람이 됨 | **접속이 끊긴 동명이면 그 자리를 이어받는다** ([2-10](#hello-학생--이름-이어받기)) |
| ⑦ 퀴즈가 시트 한 곳에 묶임 | D1 보관함에 선생님별로 누적. 목록에서 골라 쓴다 |

### 1-4. 설계를 가르는 세 줄

> **① 화면은 아무것도 기억하지 않는다. 서버가 보낸 것만 그린다.**

이 프로젝트에서 난 사고의 절반은 "화면이 들고 있던 낡은 사본"이 원인이었다. `APP.myQuizzes`는 통째로 삭제한다. 문제는 칸을 고른 그 순간 서버가 보내 준다. **화면에는 정답이 가지 않으므로 채점자는 서버 하나뿐이다** — 이건 보안이 아니라 정합성 문제다. 채점자가 둘이면 반드시 어긋난다.

> **② 보관함은 원본, 방 안의 퀴즈는 사본이다.**

방을 만들 때 고른 퀴즈는 DO 안으로 복사된다. 게임이 도는 동안 선생님이 보관함에서 그 퀴즈를 고치거나 지워도 진행 중인 게임은 흔들리지 않는다. 지금 `saveQuizSnapshot_`(`Backend.gs:725`)이 존재하는 이유가 정확히 이것이다.

> **③ 같은 요청이 두 번 와도 결과는 한 번이다.**

끊김·재연결·폴백 전환이 일상인 교실에서 **재시도는 반드시 일어난다.** 이미 2026-08-09 로그에 이중 제출이 18건 있었고, 그중 하나가 "유진"의 화면을 굳혔다. 모든 변경 명령에 `actionId`를 달고, 같은 ID가 다시 오면 **상태를 바꾸지 않고 저장된 답을 돌려준다.**

### 1-5. 이번에 확정한 결정

| 결정 | 선택 | 뜻 |
|---|---|---|
| 선생님 인증 | **아이디 + 비밀번호 로그인** | 로그인하면 내 퀴즈 보관함과 내 방만 보인다 |
| 퀴즈 보관 | **D1 보관함에 누적** | 한 번 올리면 계속 남는다. 목록에서 골라 쓴다 |
| 퀴즈 선택 | **목록에서 하나만** (라디오) | 여러 개를 섞지 않는다 |
| 제목 표시 | **게임 화면 좌상단** | 학생·선생님 모두 지금 무슨 과목인지 항상 보인다 |
| 업로드 형식 | **엑셀(.xlsx) 그대로** | CSV도 받는다 |
| 전환 방식 | **새 주소로 병행 운영 후 전환** | 수업 중 사고가 나도 즉시 되돌아간다 |

### 1-6. v1 → v2에서 바뀐 것

| | v1 | v2 이후 |
|---|---|---|
| 선생님 인증 | 공용 개설 비밀번호 | **계정 로그인** |
| 방 교사 PIN | 방마다 4자리 발급 | **삭제** — 계정이 그 일을 더 잘 한다 |
| 퀴즈 업로드 | 방 만들 때마다 파일 첨부 | **보관함에 올려 두고 목록에서 선택** |
| 퀴즈 저장 | DO 안에만 | **D1 보관함(원본) + DO(사본)** |
| 과목 표시 | 없음 | **게임 좌상단에 제목** |

### 1-7. v2 → v3에서 바뀐 것 (요약)

| # | 무엇 | 왜 |
|---|---|---|
| 1 | WebSocket 교사 인증을 **업그레이드 요청의 쿠키 검증**으로 | v2 규격은 **작동하지 않는다.** HttpOnly 쿠키를 JS가 읽어 보낼 수 없다 |
| 2 | 방 개설을 **D1 예약 먼저 → DO init → ready** 순서로 | 같은 번호를 두 선생님이 받거나 반쪽 방이 남는다 |
| 3 | `rev`를 **정본을 바꾸는 메시지에만** | 모든 메시지에 붙이면 정상 ping이 전체 재전송을 부른다 |
| 4 | 변경 명령에 **`actionId` 멱등키** | 응답이 유실된 재시도가 점수를 두 번 올린다 |
| 5 | 알람을 **하나의 스케줄러**로 (턴 + 정리) | DO 알람은 하나뿐인데 v2는 두 용도로 쓴다 → 정리가 영영 안 돈다 |
| 6 | 퀴즈 문항을 **JSON 한 컬럼**으로 | 덮어쓰기가 UPDATE 한 줄이 되어 원자성 문제가 **사라진다** |
| 7 | 모든 보관함 조회에 **`AND teacher_id = ?`** | 남의 퀴즈가 내 방에 복사될 수 있었다 |
| 8 | xlsx는 **골든 픽스처 3종 통과 후에** 생산 코드 | "150행이면 된다"는 낙관이었다 |
| 9 | 살아있음 확인을 **자동 응답**으로, 시계는 편승 | DO를 20초마다 깨울 이유가 없다 |
| 10 | 방 존재 확인은 **D1만** 본다 | `getByName()`은 없는 방도 DO를 만든다 |
| 11 | **동명 이어받기** | 오늘 "수경/수경2/수경3"이 난 이유 |
| 12 | 방 인원 상한을 **판 크기에서 계산** | 12×12에 100명은 배치가 불가능하다 |

### 1-8. 검토 반영 내역

`plan_DB로전환_v2_codex.md` 의 7개 지적을 모두 검토했다.

| 검토 | 판정 | v3에서 |
|---|---|---|
| **F-001** WebSocket·RPC 인증 경계 | **부분 채택** | HttpOnly 모순은 고친다(→ [2-6](#2-6-로그인과-소켓-인증)). 나머지는 아래 별항 |
| **F-002** 방 개설 D1↔DO 일관성 | **채택 (축소)** | D1 PK 선점 + `create_request_id` 멱등키 + `status`. `provision_id`는 생략 — 코드 PK와 requestId로 충분하다 (→ [2-8](#post-apirooms--방-개설)) |
| **F-003** 상태 순번 규격 | **전면 채택** | v2의 명백한 실수였다 (→ [2-11](#상태-순번-staterev)) |
| **F-004** 변경 명령 멱등성 | **채택 (축소)** | 별도 테이블 대신 `players.last_action_*` / `room.last_cmd_*` 컬럼. 방 수명이 3시간이라 별도 정리가 필요 없다 (→ [2-12](#멱등성--actionid)) |
| **F-005** 알람과 코드 재사용 | **전면 채택** | v2의 명백한 버그였다 (→ [2-13](#알람--턴과-정리를-하나로)) |
| **F-006** 퀴즈 원자성·소유권 | **채택하되 설계를 바꿔 문제를 없앰** | 문항을 JSON 한 컬럼으로 옮겨 batch 한도 논의 자체를 제거. 소유권 조건은 전면 채택 (→ [2-4](#2-4-데이터-모델--d1)) |
| **F-007** xlsx 수용 범위 | **전면 채택** | 골든 픽스처 3종 + 타임박스 게이트 (→ [2-7](#2-7-엑셀-파싱)) |
| **N-001** ping 최적화 | **채택 (조정)** | 자동 응답은 살아있음만. 시계는 `serverNow` 편승 (→ [2-14](#살아있음-확인과-시계)) |
| **N-002** 불변식 fuzz 테스트 | **채택** | (→ [3-2](#3-2-단위-테스트)) |
| **OUT-001** 외부 SSO | 범위 밖 | 고정 조건(아이디+비번)을 바꾼다 |
| **OUT-002** 방번호 6자리 | 범위 밖 | 아이들이 치기 쉬운 4자리를 고정으로 뒀다. 충돌은 F-002의 원자적 예약으로 푼다 |

#### 채택하지 않은 것 — 보안 강화 항목

이 프로젝트는 **보안 강화를 설계 목표로 두지 않는다.** 선생님이 명시적으로 정한 방침이다(퀴즈는 감출 대상이 아니고, 그 논의로 개발이 지연되는 것을 원치 않음). 따라서 F-001 중 다음은 넣지 않는다.

- 로그인·가입 속도 제한, 공통 오류 문구
- Origin 검사
- 학생용 `playerSecret` 발급 — 학생 식별은 지금과 같이 localStorage의 `playerId` 하나로 한다

**다만 F-001이 짚은 HttpOnly 모순은 보안 문제가 아니라 "작동하지 않는 규격"이므로 반드시 고친다.** 브라우저 JS는 HttpOnly 쿠키 값을 읽을 수 없어서, v2대로 만들면 선생님이 아예 접속하지 못한다.

방 사이의 격리는 부수적으로 확보된다 — `getByName(code)`가 방마다 다른 DO로 가고 `players` 테이블이 각자 있으므로, 다른 방의 `playerId`는 그냥 존재하지 않는 학생이 되어 이름으로 다시 들어오게 된다. 따로 만들 것이 없다.

### 1-9. 조사로 드러난 현실 — 이미 있는 것

**그대로 가져다 쓰는 것 (게임 규칙은 이미 정확하다)**

| 대상 | 위치 |
|---|---|
| 8방향 이웃 | `Backend.gs:796 neighbors8_` |
| 보드 생성 · 문제 배분 | `:955 buildBoard_` · `:937 assignQuizzes_` |
| 배치·구출 | `assignRandomPositions_` `placeLatePlayer_` `rescueTrapped_` `canChallengeFrom_` `occupiedMap_` |
| 점령·공격·점수 | `transferCellOwner_` `attackSteal_` `totals_` |
| 턴 진행 · 종료 | `:1146 advanceTurn_` · `:1175 endGame_` |
| 채점 | `:1108 submitAnswer` (보너스 중복 방지 비트마스크 포함) |
| 퀴즈 파싱 | `:687 parseQuizValues_` — **이 규칙 그대로 유지** |
| 판 크기 힌트 | `:218 sizeHint_` — 인원 상한 계산에 쓴다 |

**이미 고쳐 놓아 반드시 이어받아야 할 것**

| 교훈 | 근거 |
|---|---|
| 서버 시각을 함께 보내 화면이 시계 차이를 보정한다 | `app.js` `applyServerNow`/`now()` — 학생 PC 시계가 틀리면 아무것도 못 누른다 |
| 채점이 실패해도 반드시 풀이 상태에서 빠져나온다 | `submitChoice` catch |
| 보기를 한 번 누르면 나머지를 잠근다 | 이중 제출이 굳힘의 방아쇠였다 |
| 게임이 끝나도 학생 명단은 지우지 않는다 | 지웠더니 15명이 한꺼번에 튕겼다 |
| 선생님 버튼은 절대 비활성화하지 않는다 | 눌러도 반응 없는 버튼 앞에서 할 수 있는 게 없었다 |
| 막혔으면 왜 막혔는지 말해 준다 | `playBlockReason()` |

**새 구조에서 지우고 가는 것**

`withLock_` / `LockService` · `loadState_` / `saveState_` / `CacheService` · `backupToSheet_` / `restoreFromSheet_` / `writeChunked_` / `readChunked_` / `sha256_` · `getSourceQuizzes_` 와 스프레드시트 설정 · `adminDiagnose`/`adminRepair` 8개 중 5개 · `APP.myQuizzes` · `getNeighborQuizzes_` / `allCellQuizzes_` · 폴링 타이머(폴백용으로만 남긴다).

**KV는 쓰지 않는다.** 정적 파일은 Assets 바인딩, 방 상태는 DO SQLite, 계정·보관함·결과는 D1이 맡는다. 세션을 KV에 두는 안도 봤지만, **KV는 쓴 값이 퍼지는 데 시간이 걸려 방금 로그인한 사람이 거절당할 수 있다.** 세션은 D1에 둔다.

---

## 2. 개발 방법

### 2-0. 무엇을 건드리나

| 대상 | 변경 |
|---|---|
| `cloudflare-v2/` | **신규** — 기존 `cloudflare/`는 손대지 않는다 |
| `apps-script/`, `cloudflare/` | **변경 없음** (병행 운영) |

### 2-1. 전체 그림

```
                    ┌─ POST /api/auth/{signup,login,logout}   세션 쿠키
                    ├─ GET/POST/DELETE /api/quizsets…         보관함 (세션 필요)
브라우저 ──HTTP──> Worker ─┼─ POST /api/rooms                       방 개설 (세션 필요)
                    ├─ GET  /api/rooms/mine                  내 방 목록
                    ├─ GET  /api/rooms/:code                  방 존재 확인 (D1만 조회)
                    ├─ GET  /api/rooms/:code/ws              ← 여기서 쿠키를 검증한다
                    └─ POST /api/rooms/:code/rpc              폴링 폴백
                              │  teacherId 를 내부 인자로 실어 보낸다
                              ↓ getByName(code)
                    ┌─────────────────────────────┐
                    │  RoomDO (방 1234)            │
                    │  · 내장 SQLite = 게임 정본    │
                    │  · quizzes = 보관함에서 복사  │
                    │  · alarm() = 턴 + 정리        │
                    │  · WebSocket 방송             │
                    └─────────────────────────────┘
                              ↕ env.DB
                    D1: teachers · sessions · quiz_sets · rooms · results
```

### 2-2. wrangler 설정

```jsonc
// cloudflare-v2/wrangler.jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "treasure-island-v2",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-03",
  "compatibility_flags": ["nodejs_compat"],

  "assets": {
    "directory": "./public",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*"]
  },

  "durable_objects": { "bindings": [{ "name": "ROOM", "class_name": "RoomDO" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["RoomDO"] }],

  "d1_databases": [
    { "binding": "DB", "database_name": "treasure", "database_id": "<wrangler d1 create 후>" }
  ],

  "observability": { "enabled": true, "logs": { "head_sampling_rate": 1 } }
}
```

**함정 ①** `new_sqlite_classes`를 반드시 쓴다. `new_classes`(구 KV 방식)로 만들면 `ctx.storage.sql`을 못 쓰고 **나중에 바꿀 수 없다.**

**함정 ②** 가입 코드는 secret으로. `npx wrangler secret put SIGNUP_CODE`

**함정 ③** D1 마이그레이션은 로컬과 원격이 따로다. `--remote` 를 빼먹기 쉽다.

### 2-3. 데이터 모델 — DO 내장 SQLite (방마다 독립)

```sql
-- cloudflare-v2/src/schema.ts 안에 문자열로 둔다. ensureSchema() 가 멱등 실행한다.

CREATE TABLE IF NOT EXISTS room (
  id            INTEGER PRIMARY KEY CHECK (id = 1),   -- 항상 1행
  code          TEXT    NOT NULL,
  teacher_id    TEXT    NOT NULL,
  label         TEXT,
  quiz_set_id   INTEGER,
  quiz_title    TEXT,                                 -- ← 게임 좌상단에 보이는 이름
  status        TEXT    NOT NULL DEFAULT 'waiting',   -- waiting | running | ended | closing
  game_id       TEXT,
  rows          INTEGER NOT NULL DEFAULT 12,
  cols          INTEGER NOT NULL DEFAULT 12,
  round         INTEGER NOT NULL DEFAULT 1,
  round_limit   INTEGER NOT NULL DEFAULT 10,
  turn_team     TEXT,
  turn_ends_at  INTEGER,
  turn_seconds  INTEGER NOT NULL DEFAULT 20,
  cnt_t         INTEGER NOT NULL DEFAULT 8,
  cnt_s         INTEGER NOT NULL DEFAULT 7,
  cnt_a         INTEGER NOT NULL DEFAULT 7,
  bonus_h       INTEGER NOT NULL DEFAULT 0,
  bonus_c       INTEGER NOT NULL DEFAULT 0,
  rev           INTEGER NOT NULL DEFAULT 0,
  last_turn_at  INTEGER,
  last_cmd_id   TEXT,                                 -- 선생님 명령 멱등키
  last_cmd_result TEXT,                               -- 그 명령의 응답(JSON)
  provision_id  TEXT,                                 -- init 멱등키
  created_at    INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL
);

-- 보관함에서 복사해 온 사본. 게임 중 보관함이 바뀌어도 흔들리지 않는다.
CREATE TABLE IF NOT EXISTS quizzes (
  idx     INTEGER PRIMARY KEY,        -- 0-based
  q       TEXT    NOT NULL,
  options TEXT    NOT NULL,           -- JSON 배열
  ans     INTEGER NOT NULL            -- 0-based
);

CREATE TABLE IF NOT EXISTS cells (
  idx          INTEGER PRIMARY KEY,    -- r*cols + c
  type         TEXT    NOT NULL,       -- N | T | S | A
  quiz_idx     INTEGER NOT NULL,
  owner        TEXT,                   -- 'H' | 'C' | NULL
  owned_by     TEXT,
  bonus_taken  INTEGER NOT NULL DEFAULT 0,   -- 비트마스크: 1=홍, 2=청
  tried        INTEGER NOT NULL DEFAULT 0,
  locked_by    TEXT,
  locked_until INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cells_owner ON cells(owner);

CREATE TABLE IF NOT EXISTS players (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL UNIQUE,
  team                TEXT NOT NULL,
  pos                 INTEGER,
  skip_turns          INTEGER NOT NULL DEFAULT 0,
  skip_turn_key       TEXT,
  last_played_turn_key TEXT,
  attempt_cell        INTEGER,
  attempt_started_at  INTEGER,
  solved              INTEGER NOT NULL DEFAULT 0,
  correct             INTEGER NOT NULL DEFAULT 0,
  last_action_id      TEXT,                 -- 학생 명령 멱등키
  last_action_result  TEXT,                 -- 그 명령의 응답(JSON)
  joined_at           INTEGER NOT NULL,
  last_seen_at        INTEGER NOT NULL
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
```

**설계 메모**

- `territory`는 컬럼으로 두지 않는다. `SELECT owner, COUNT(*) FROM cells WHERE owner IS NOT NULL GROUP BY owner` 한 줄이면 되고, 지금 `assertTerritory_`가 하던 "카운터가 실제와 어긋났는지 검사"가 통째로 필요 없어진다.
- `bonus_h`/`bonus_c`만 누적 컬럼으로 둔다(칸에서 유도 불가).
- **`ctx.storage.sql.exec()`는 동기 함수다.** "읽고 → 고치고 → 쓰기" 사이에 `await`가 끼지 않는다. 지금 락으로 지키던 원자성이 공짜로 따라온다.
- **DO 안에서는 상태를 메모리에 캐시하지 않는다.** 매 요청마다 SQLite에서 읽는다. 캐시 불일치라는 사고 종류가 통째로 사라진다.

**`ensureSchema()` 는 반드시 멱등이고, 두 곳에서 부른다** (검토 F-005)

```ts
constructor(ctx, env) { super(ctx, env); ctx.blockConcurrencyWhile(async () => this.ensureSchema()); }
async init(arg) { this.ensureSchema(); ... }        // ← 정리 후 재사용된 코드 대비
```

방을 정리할 때 `ctx.storage.deleteAll()` 로 테이블까지 지운다. 그런데 **같은 DO 인스턴스가 메모리에 남아 있으면 생성자가 다시 돌지 않는다.** `init()` 에서 한 번 더 보장하지 않으면 재사용된 방번호가 SQL 오류로 죽는다.

### 2-4. 데이터 모델 — D1

```sql
-- cloudflare-v2/migrations/0001_init.sql

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
-- 문항을 별도 테이블로 쪼개지 않는다. 이유는 아래 [설계 메모] 참고.
CREATE TABLE quiz_sets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id  TEXT    NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  title       TEXT    NOT NULL,            -- "국어1", "사회1"
  items_json  TEXT    NOT NULL,            -- [{q, options:[…], ans}] 전체
  item_count  INTEGER NOT NULL,
  source_name TEXT,
  skipped     INTEGER NOT NULL DEFAULT 0,
  problems_json TEXT,                      -- 건너뛴 행 안내(최대 20건)
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  used_at     INTEGER
);
CREATE UNIQUE INDEX idx_quiz_sets_title ON quiz_sets(teacher_id, title);
CREATE INDEX idx_quiz_sets_list ON quiz_sets(teacher_id, updated_at DESC);

-- ── 방 목록 ────────────────────────────────────────────────
CREATE TABLE rooms (
  code           TEXT PRIMARY KEY,         -- 4자리 숫자. 이 PK 가 곧 예약이다
  status         TEXT NOT NULL,            -- provisioning | ready | closed
  teacher_id     TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  create_request_id TEXT NOT NULL,         -- 개설 멱등키
  label          TEXT,
  quiz_set_id    INTEGER REFERENCES quiz_sets(id) ON DELETE SET NULL,
  quiz_title     TEXT,                     -- 사본. 보관함에서 지워도 남는다
  created_at     INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  closed_at      INTEGER
);
CREATE UNIQUE INDEX idx_rooms_request ON rooms(teacher_id, create_request_id);
CREATE INDEX idx_rooms_teacher ON rooms(teacher_id, status, last_active_at DESC);
CREATE INDEX idx_rooms_open ON rooms(status, last_active_at);

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
  winner       TEXT    NOT NULL,
  player_count INTEGER NOT NULL,
  players      TEXT    NOT NULL            -- JSON [{name,team,solved,correct}]
);
CREATE INDEX idx_results_teacher ON results(teacher_id, ended_at DESC);
```

**설계 메모 — 문항을 왜 JSON 한 컬럼에 두는가** (검토 F-006)

검토는 `quiz_items` 500행을 하나의 `db.batch()`로 원자 교체하라고 했고, 500문항이 batch 한도를 넘으면 "새 version에 적재 후 포인터 교체"를 제안했다. 그런데 **이 프로젝트는 문항을 SQL로 조회할 일이 한 번도 없다.**

- 목록 → `title`, `item_count`, `updated_at` 만 필요
- 미리보기 → JSON 앞 5개를 잘라 쓰면 된다
- 방으로 복사 → 어차피 전부 읽는다

관계로 쪼갤 이유가 없다. **JSON 한 컬럼으로 두면 덮어쓰기가 `UPDATE` 한 줄이 되어 원자성 문제가 존재하지 않게 된다.** batch 한도도, version 포인터도, 오래된 version 정리도 필요 없다. 검토가 지적한 위험(중간 실패로 빈 세트가 남음)이 설계에서 사라진다.

> 문항 상한이 **80개**(2026-08-09 선생님 결정)라 JSON 은 15KB 안팎이다. D1 한 컬럼에 넉넉히 들어가므로 분할을 고민할 필요가 없다.

**설계 메모 — `rooms.status` 와 `create_request_id`** (검토 F-002)

- `code` 가 PRIMARY KEY다. **`INSERT` 가 성공하는 것이 곧 방번호 예약이다.** 조회 후 삽입이 아니라 삽입 자체로 경쟁을 끝낸다.
- `(teacher_id, create_request_id)` 가 UNIQUE다. 선생님이 [방 만들기]를 두 번 눌러도 방은 하나다. 응답이 유실돼 다시 눌러도 **같은 방번호를 돌려준다.**
- 학생 입장 화면의 존재 확인과 내 방 목록은 **`status='ready'` 만** 보여 준다.

**D1은 로그인·업로드·방 개설·새 게임·종료 때만 쓴다.** 수업 중 문제를 푸는 동안에는 건드리지 않는다.

### 2-5. Worker 라우터

```ts
import { RoomDO } from "./room";
export { RoomDO };

export interface Env {
  ROOM: DurableObjectNamespace<RoomDO>;
  DB: D1Database;
  ASSETS: Fetcher;
  SIGNUP_CODE: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url), p = url.pathname;

    if (p.startsWith("/api/auth/"))     return auth(request, env, p);
    if (p.startsWith("/api/quizsets"))  return quizsets(request, env, p);
    if (p === "/api/rooms" && request.method === "POST") return createRoom(request, env);
    if (p === "/api/rooms/mine")        return myRooms(request, env);

    const m = p.match(/^\/api\/rooms\/(\d{4})(\/ws|\/rpc)?$/);
    if (m) return roomRoute(request, env, m[1], m[2]);

    return env.ASSETS.fetch(request);
  },
};
```

**함정** `assets.run_worker_first: ["/api/*"]` 가 있어야 `/api/*` 가 Worker로 온다.

#### 방 존재 확인은 D1만 본다 (v3 추가)

```ts
// GET /api/rooms/:code — 학생 입장 화면용. 로그인 불필요
const row = await env.DB.prepare(
  "SELECT label, quiz_title FROM rooms WHERE code = ? AND status = 'ready'").bind(code).first();
if (!row) return json({ exists: false }, 404);
```

**절대 DO에게 묻지 않는다.** `env.ROOM.getByName("9999")` 는 **없는 방이어도 DO를 만들어 낸다.** 아이가 아무 번호나 쳤을 때 빈 방이 생기고, "존재한다"는 답이 나가 버린다. 존재의 정본은 D1이다.

### 2-6. 로그인과 소켓 인증

| 경로 | 메서드 | 내용 |
|---|---|---|
| `/api/auth/signup` | POST | `{code, id, name, password}` — `code` 가 `SIGNUP_CODE` 와 같아야 한다 |
| `/api/auth/login` | POST | `{id, password}` → 세션 토큰을 `HttpOnly` 쿠키로 |
| `/api/auth/me` | GET | `{id, name}` 또는 401 |
| `/api/auth/logout` | POST | 세션 삭제 |

```ts
async function hashPassword(pw: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw),
    "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: new TextEncoder().encode(salt), iterations: 100_000, hash: "SHA-256" },
    key, 256);
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, "0")).join("");
}
```

- 세션 유효기간 **12시간**. 쿠키 `tsession`, `HttpOnly; SameSite=Lax; Path=/` (+ https면 `Secure`)
- 만료 청소는 로그인 때마다 `DELETE FROM sessions WHERE expires_at < ?` 를 함께 돌린다. 스케줄러가 필요 없다.

**함정** 로컬(`http://localhost`)에서는 `Secure` 쿠키가 안 붙는다. `url.protocol === "https:"` 일 때만 넣는다. 이걸 안 하면 로컬에서 로그인이 안 되는 걸로 보여 한참 헤맨다.

#### 소켓 인증 — 검토 F-001의 핵심 수정

**v2는 작동하지 않는다.** 교사 `hello` 에 `{session}` 을 넣으라고 했는데, HttpOnly 쿠키는 JS가 읽을 수 없다.

**고친 규격 — 쿠키는 업그레이드 요청에 자동으로 실린다. 거기서 확인한다.**

```ts
async function roomRoute(request, env, code, tail) {
  if (tail === "/ws" || tail === "/rpc") {
    // 쿠키는 브라우저가 알아서 붙여 보낸다. JS가 읽을 필요가 없다.
    const teacherId = await teacherFromCookie(request, env);      // 없으면 null = 학생
    const stub = env.ROOM.getByName(code);
    return stub.fetch(request, { headers: { "x-teacher-id": teacherId ?? "" } });
  }
  ...
}
```

- 이 헤더는 **Worker가 DO에게 직접 거는 내부 호출**에만 실린다. 바깥에서 온 요청의 같은 이름 헤더는 위에서 통째로 덮어쓴다.
- DO는 받은 `teacherId` 를 `room.teacher_id` 와 다시 대조하고, 같을 때만 `attachment.role = "teacher"` 로 고정한다.
- **`hello` 전에는 `ping` 외 어떤 메시지도 받지 않는다.** 소켓 상태 기계가 단순해지고, 첫 메시지가 반드시 역할을 정한다.
- 폴백 `/rpc` 도 같은 경로를 지난다. **WS와 RPC의 자격 판정이 한 벌이다.**

선생님이 노트북과 태블릿 두 화면에서 같은 방에 붙는 것은 허용한다. 둘 다 `teacher` 역할이고 어느 쪽에서 눌러도 동작한다. 수업 중 실제로 쓰는 방식이다.

### 2-7. 엑셀 파싱

**입력 규격은 지금과 완전히 같다.** `sample/퀴즈_샘플_v3.csv` 그대로:

| 질문 | 정답 | 예제1 | 예제2 | 예제3 | 예제4 |
|---|---|---|---|---|---|
| 고조선을 세운 인물은 누구인가요? | 1 | 단군왕검 | 온조 | 박혁거세 | 주몽 |

- 1행은 머리글, 2행부터. 정답은 **숫자**(1~보기수)
- 보기는 뒤쪽 빈 칸만 잘라내고, 중간이 비면 그 행을 건너뛰며 **행 번호와 이유를 보고**
- 최대 80문항. 넘는 줄은 읽지 않고 건너뛴다

```ts
export type QuizItem = { q: string; options: string[]; ans: number };
export type ParseResult = { bank: QuizItem[]; skipped: number; problems: string[] };
export function parseQuizValues(values: string[][]): ParseResult      // Backend.gs:687 이식
export async function parseQuizFile(file: File): Promise<ParseResult>
```

#### xlsx — 골든 픽스처 게이트 (검토 F-007 전면 채택)

v2는 "자체 파서 150행이면 된다"고 썼다. **낙관이었다.** 엑셀·LibreOffice·구글 시트가 만드는 `.xlsx` 는 서로 다르다.

**생산 코드를 쓰기 전에 반드시 통과해야 하는 게이트**

1. 골든 픽스처를 만든다 — 같은 퀴즈 표를 **Excel · LibreOffice · Google Sheets** 로 각각 저장
2. 다음을 포함시킨다: workbook relationships, shared string · inline string · rich text, **중간이 빈 셀**, 압축 방식 변형
3. **1~2일 타임박스**로 자체 파서를 시도한다
4. 핵심 픽스처가 하나라도 실패하면 → 그 시점의 공식 배포처·번들 크기를 확인해 검증된 라이브러리로 간다
5. 통과 기준: **모든 골든 xlsx가 CSV와 완전히 같은 `ParseResult`를 낸다**

*자체 파서를 시도할 때의 뼈대 (`src/xlsx.ts`)*
1. 파일 끝에서 ZIP 중앙 디렉터리(`PK\x05\x06`)를 찾는다
2. `xl/workbook.xml` + `xl/_rels/workbook.xml.rels` 로 **첫 시트의 실제 경로**를 찾는다 — `sheet1.xml` 로 고정하면 안 된다
3. 항목을 `DecompressionStream("deflate-raw")` 로 푼다
4. `sharedStrings.xml` → `<si>` 안의 `<t>` 를 순서대로. **`<r>` 안에 조각난 rich text 도 이어 붙인다**
5. 시트 XML → `<c r="A2" t="s">` 의 `r` 속성으로 **열 번호를 계산해 자리를 맞춘다.** 빈 칸은 XML에서 통째로 빠져 있으므로, 순서대로 채우면 **열이 밀린다**

**미지원 구조는 조용히 건너뛰지 않는다.** 해석할 수 없는 파일은 "이 파일은 읽지 못했습니다. 엑셀에서 [다른 이름으로 저장 → CSV] 로 저장한 뒤 올려 주세요"로 **거절**한다. 조용히 절반만 읽으면 수업 중에 엉뚱한 문제가 나온다 — 가장 나쁜 실패다.

**함정** 시트가 여러 개인 파일이 실제로 온다(선생님의 `보물섬점령전_DB.xlsx` 에는 `퀴즈`·`_상태`·`_퀴즈스냅샷` 세 개가 있었다).
규칙 — **`퀴즈` 라는 이름의 시트를 먼저 찾고, 없으면 맨 앞의 보이는 시트를 읽는다. 숨긴 시트는 건너뛴다. 병합된 칸은 좌상단 값만 유효하다.**

### 2-8. 퀴즈 보관함과 방 개설

#### 보관함 API

| 경로 | 메서드 | 내용 |
|---|---|---|
| `/api/quizsets` | GET | 내 목록 `[{id, title, itemCount, sourceName, updatedAt, usedAt}]` |
| `/api/quizsets` | POST | 업로드 (`multipart/form-data`: `title`, `file`, `overwrite?`) |
| `/api/quizsets/:id` | GET | 미리보기 — 앞 5문항 + 건너뛴 행 목록 |
| `/api/quizsets/:id` | DELETE | 삭제 |
| `/api/quizsets/:id/title` | PATCH | 제목만 바꾸기 |

**모든 조회에 소유자 조건을 붙인다** (검토 F-006)

```sql
SELECT … FROM quiz_sets WHERE id = ? AND teacher_id = ?
```

`id` 만으로 조회하는 문장을 코드에 **하나도 남기지 않는다.** 특히 `newgame {quizSetId}` 가 그렇다 — v2는 여기에 조건이 빠져 있어 남의 퀴즈가 내 방에 복사될 수 있었다.

**업로드 처리**
1. 세션 확인 → `teacher_id`
2. `title` 1~20자 (게임 좌상단에 들어가므로 길면 잘린다)
3. 파일 → `parseQuizFile()` → `{bank, skipped, problems}`
4. `bank.length < 1` → 400 + `problems`(행 번호 포함)
5. 같은 `(teacher_id, title)` 이 있으면
   - `overwrite` 없이 왔으면 409 → 화면이 "이미 '국어1'이 있습니다. 덮어쓸까요?"
   - `overwrite=true` 면 **`UPDATE quiz_sets SET items_json=?, item_count=?, … WHERE id=? AND teacher_id=?`** — 한 줄이라 중간 실패가 없다
6. 응답 `{id, title, itemCount, skipped, problems}`

**진행 중인 방이 쓰는 퀴즈를 지워도 막지 않는다.** DO 안에 사본이 있으므로 게임은 멀쩡히 끝난다. 화면에 "이 퀴즈는 지금 방 1234에서 쓰는 중입니다. 진행 중인 게임에는 영향이 없습니다."라고 알려만 준다.

#### `POST /api/rooms` — 방 개설

요청 `{requestId, label?, quizSetId, rows?, cols?, roundLimit?, turnSeconds?, cntT?, cntS?, cntA?}`
`requestId` 는 화면이 만든 UUID다. **[방 만들기] 버튼을 누를 때 한 번 만들고, 재시도할 때는 같은 값을 보낸다.**

```
1. 세션 확인 → teacherId
2. 같은 (teacherId, requestId) 로 만든 방이 이미 있으면 → 그 방을 그대로 돌려준다 (끝)
3. quizSetId 가 내 것인지 확인 (AND teacher_id = ?). 아니면 403
4. 방번호 예약 — 아래를 성공할 때까지 최대 20회
     INSERT INTO rooms (code, status, teacher_id, create_request_id, …)
     VALUES (?, 'provisioning', ?, ?, …)
   PK 충돌 = 이미 쓰는 번호 → 다른 번호로 재시도
5. RoomDO.init({ provisionId: requestId, code, teacherId, label, quizSetId, quizTitle, config })
     · DO 는 ensureSchema() 후, 같은 provisionId 면 조용히 성공(멱등)
     · 다른 provisionId 로 이미 초기화된 방이면 거절
     · env.DB 로 quiz_sets.items_json 을 읽어 자기 quizzes 테이블에 복사
6. UPDATE rooms SET status='ready'
7. UPDATE quiz_sets SET used_at=?
8. 응답 {code, quizTitle, quizCount}

5번이 실패하면 → UPDATE rooms SET status='closed', closed_at=? (예약 반납) 후 오류
```

**순서가 핵심이다.** v2는 "번호 조회 → DO init → D1 INSERT" 였다. 조회와 삽입 사이에 다른 요청이 끼어들면 **두 선생님이 같은 DO를 공유**한다. v3은 **삽입이 곧 예약**이라 그 틈이 없다.

**`provisioning` 이 오래 남아 있으면** — 다음 개설 요청이 같은 번호를 뽑았을 때, `created_at` 이 10분 넘은 `provisioning` 행은 `closed` 로 바꾸고 그 번호를 다시 쓴다. 별도 청소 작업이 필요 없다.

### 2-9. RoomDO 뼈대

```ts
import { DurableObject } from "cloudflare:workers";
import { SCHEMA } from "./schema";

type Attach = { role: "student" | "teacher"; playerId?: string; teacherId?: string };

export class RoomDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => { this.ensureSchema(); });
  }
  private ensureSchema() { this.ctx.storage.sql.exec(SCHEMA); }   // 멱등

  async init(arg: InitArg): Promise<void>    // 방 개설. provisionId 로 멱등
  summary(): RoomSummary

  async fetch(request: Request): Promise<Response> {
    const teacherId = request.headers.get("x-teacher-id") || null;
    if (new URL(request.url).pathname.endsWith("/ws")) {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);        // ← Hibernation. accept() 아님
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return Response.json(await this.handleAction(await request.json(), { teacherId }));
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) { … }
  async webSocketClose(ws: WebSocket) { … }
  async webSocketError(ws: WebSocket) { … }
  async alarm() { … }
}
```

**WS와 RPC가 같은 `handleAction()` 을 지난다.** 검토 F-004가 짚은 대로, 두 경로가 다른 코드를 타면 폴백으로 내려간 순간 규칙이 달라진다.

**함정 ①** 반드시 `this.ctx.acceptWebSocket(ws)`. `ws.accept()` 를 쓰면 Hibernation이 꺼져 방이 비어 있는 동안에도 DO가 깨어 있고 요금이 계속 나간다.

**함정 ②** Hibernation 중에는 **메모리가 통째로 날아간다.** 소켓별 정보를 `this.sockets = new Map()` 에 두면 안 된다.
```ts
ws.serializeAttachment({ role: "student", playerId: id });
const att = ws.deserializeAttachment() as Attach | null;
```

**함정 ③** `blockConcurrencyWhile()` 은 생성자의 스키마 생성에만. 매 요청에 쓰면 처리량이 죽는다.

#### 퀴즈 복사 — 보관함(D1) → 방(DO)

```ts
private async loadQuizSet(setId: number, teacherId: string) {
  const row = await this.env.DB.prepare(
    "SELECT title, items_json FROM quiz_sets WHERE id = ? AND teacher_id = ?")   // ← 소유자 조건
    .bind(setId, teacherId).first<{title:string; items_json:string}>();
  if (!row) throw new Error("퀴즈를 찾을 수 없습니다.");
  const items = JSON.parse(row.items_json) as QuizItem[];
  if (!items.length) throw new Error("이 퀴즈에는 문항이 없습니다.");

  // ── 여기부터 await 없음. DO SQLite 쓰기를 한 덩어리로 끝낸다.
  const sql = this.ctx.storage.sql;
  sql.exec("DELETE FROM quizzes");
  for (let i = 0; i < items.length; i++)
    sql.exec("INSERT INTO quizzes (idx,q,options,ans) VALUES (?,?,?,?)",
      i, items[i].q, JSON.stringify(items[i].options), items[i].ans);
  sql.exec("UPDATE room SET quiz_set_id=?, quiz_title=? WHERE id=1", setId, row.title);
}
```

**함정** `await` 하는 D1 읽기와 동기 `sql.exec` 쓰기가 섞인다. **D1 읽기를 완전히 끝낸 뒤 DO SQLite 쓰기를 한 덩어리로 한다.** 중간에 `await` 를 끼우면 다른 요청이 끼어들어 원자성이 깨진다.

**제목도 D1에서 파생한다.** 화면이 보낸 제목을 믿지 않는다 — 어긋나면 보드와 좌상단 표시가 따로 논다.

이 함수는 **방 개설 때와 `새 게임` 때만** 부른다.

### 2-10. 화면 → 서버 메시지

| 메시지 | 내용 |
|---|---|
| `{t:"hello", role:"student", playerId?, name?}` | 학생 연결 직후 |
| `{t:"hello", role:"teacher"}` | 선생님 연결 직후 — **토큰을 싣지 않는다.** 쿠키는 업그레이드에서 이미 확인됐다 |
| `{t:"pick", cell, actionId}` | 칸 도전 |
| `{t:"answer", cell, choice, actionId}` | 답 제출 |
| `{t:"cancel", actionId}` | 풀이 취소 |
| `{t:"cmd", cmd, actionId, …}` | 선생님 명령 |
| `{t:"sync"}` | 화면이 누락을 감지했을 때 |

`hello` 전에는 `ping` 외 전부 거절한다.

#### `hello` (학생) — 이름 이어받기 (v3 추가)

```
playerId 가 있고 그 학생이 존재하면 → 그 학생으로 인정
없으면 name 으로 찾는다
  · 같은 이름이 있고 그 학생이 지금 접속 중이 아니면 → 그 자리를 이어받는다 ★
  · 같은 이름이 있고 접속 중이면 → 다른 사람으로 보고 뒤에 2,3… 을 붙인다
  · 없으면 새로 만든다 (팀은 인원 적은 쪽, 같으면 무작위)
보드가 이미 있으면 placeLatePlayer_ 로 배치하고 시작 칸을 팀 색으로 칠한다
ws.serializeAttachment({role:"student", playerId})
→ 본인에게 state, 나머지에게 presence
```

**★ 이 한 줄이 오늘 난 사고를 막는다.** 2026-08-09 로그에 "수경"이 10번, "수경2", "수경3"이 남았다. 화면이 굳어 다시 들어올 때마다 서버가 새 사람을 만들었기 때문이다. 명단이 유령으로 차고 팀 인원이 틀어졌다.

동명이인 두 명이 동시에 있는 경우는 "접속 중이면 번호를 붙인다"로 갈린다. 교실에서 **같은 이름 = 같은 아이가 다시 들어온 것**인 경우가 압도적이다.

#### `hello` (선생님)

업그레이드에서 확인한 `teacherId` 를 `room.teacher_id` 와 대조. 다르면 `error{code:"not-owner"}`. 같으면 attachment에 고정하고 관리자용 `state` 를 보낸다.

### 2-11. 서버 → 화면 메시지

| 메시지 | `stateRev` | 언제 |
|---|:---:|---|
| `state` | ✅ | 연결·재동기화·새 게임·종료 — 전체 |
| `patch` | ✅ | 채점·이동·강퇴·입장 — 바뀐 것만 (보통 200바이트) |
| `turn` | ✅ | 턴이 넘어갈 때 |
| `quiz` | ❌ | `pick` 응답 — **채점에 쓸 바로 그 문제.** 정답은 넣지 않는다 |
| `result` | ❌ | `answer` 응답 — 결과 카드용 표시일 뿐, 정본 적용이 아니다 |
| `presence` | ❌ | 접속·해제 |
| `error` | ❌ | 거절 (`code` 로 화면이 분기) |
| `pong` | ❌ | 시계 보정 |

#### 상태 순번 `stateRev` (검토 F-003 전면 채택)

v2는 "**모든** 서버 메시지에 `rev`, 직전+1이 아니면 sync"라고 썼다. **잘못이다.** `pong`·`error`·`quiz` 는 정본을 바꾸지 않고, 한 번의 채점에서 본인에게는 `result` 와 `patch` 가 연달아 간다. 그대로 만들면 정상 통신이 전체 재전송을 계속 부른다.

**고친 규칙 — 화면이 `stateRev` 를 받았을 때**

| 받은 값 | 뜻 | 행동 |
|---|---|---|
| `= 내 rev` | 이미 반영한 변경 (중복 도착) | **무시** |
| `= 내 rev + 1` | 새 변경 | 적용 |
| `> 내 rev + 1` | 놓친 것이 있다 | `{t:"sync"}` → `state` 로 전부 다시 |

- `stateRev` 가 없는 메시지는 순번 검사를 하지 않는다.
- **sync 는 병합한다.** 이미 sync 를 보내고 답을 기다리는 중이면 또 보내지 않는다. 40명이 동시에 놓쳤을 때 sync 폭주가 나면 안 된다.
- `serverNow` 는 **모든** 메시지에 유지한다(순번과 무관).

**rev 를 올리는 것 / 올리지 않는 것**

| 올린다 | 올리지 않는다 |
|---|---|
| 정답·오답 채점, 아군 칸으로 이동, 칸 잠금(`pick`), 턴 전환, 새 게임, 종료, 입장·강퇴·초기화 | `ping`/`pong`, `quiz` 발급, `error`, 접속 상태 변화(`presence`) |

`pick` 이 rev 를 올리는 이유 — 다른 학생 화면에 그 칸이 "공략 중"으로 보여야 한다.

#### 방송

```ts
private broadcast(payload: object, exclude?: WebSocket) {
  const s = JSON.stringify(payload);
  for (const ws of this.ctx.getWebSockets()) {
    if (ws !== exclude) { try { ws.send(s); } catch {} }
  }
}
```

**함정** 끊어진 소켓에 `send` 하면 예외가 난다. 반드시 **개별** `try/catch`. 한 명의 죽은 연결이 나머지 전원의 방송을 막으면 안 된다.

**전체 상태를 방송하지 않는다.** 12×12 전체는 10KB가 넘는다. 40명 × 초당 3회면 1MB/s다. 채점은 `patch` 200바이트로. 전체 `state` 는 연결·재동기화·새 게임·종료 때만.

### 2-12. 멱등성 — `actionId` (검토 F-004)

교실에서 **재시도는 반드시 일어난다.** 끊김, 재연결, WS→폴링 전환, 그리고 아이가 버튼을 두 번 누르는 것. 2026-08-09 로그에 이중 제출이 18건 있었다.

**규칙**

```
학생 명령(pick/answer/cancel)
  actionId === players.last_action_id  →  상태를 바꾸지 않고 last_action_result 를 그대로 돌려준다
  아니면                                →  실행하고, 같은 SQLite 덩어리 안에서
                                            last_action_id / last_action_result 를 함께 기록

선생님 명령(cmd)
  actionId === room.last_cmd_id        →  room.last_cmd_result 를 그대로
  아니면                                →  실행 + 기록
```

- **응답 기록과 상태 변경이 같은 덩어리 안에 있어야 한다.** 사이에 `await` 를 넣으면 "바뀌었는데 기록은 안 된" 상태가 생긴다. `sql.exec` 가 동기라 자연스럽게 지켜진다.
- 별도 멱등 테이블을 두지 않는다. **학생당/방당 마지막 하나만 기억하면 충분하다** — 재시도는 직전 명령에 대해서만 일어난다. 방 수명이 3시간이라 정리도 필요 없다.
- 재접속 `state` 에 `myLastResult` 를 실어 준다. 답을 낸 직후 끊겼던 학생의 결과 카드가 복구된다.

`[다음 턴]` 의 2초 연타 방지(`advanceTurn_` 의 `lastTurnAt`)는 그대로 유지한다. `actionId` 와 역할이 다르다 — 하나는 같은 명령의 재시도를, 다른 하나는 서로 다른 두 번의 의도적 클릭을 막는다.

### 2-13. 알람 — 턴과 정리를 하나로 (검토 F-005)

**v2의 버그** — `alarm()` 은 `status !== "running"` 이면 즉시 반환하는데, 방 정리는 "running 이 아닌 상태에서 3시간 뒤"에 하겠다고 했다. **DO 알람은 하나뿐이고 `setAlarm()` 은 기존 알람을 교체한다.** 그대로 만들면 대기·종료 방이 영원히 정리되지 않는다.

**고친 규격 — 알람은 하나의 스케줄러다**

```ts
private nextDeadline(): number {
  const r = this.room();
  return r.status === "running" && r.turn_ends_at
    ? r.turn_ends_at
    : r.last_active_at + IDLE_MS;              // 3시간
}
private async reschedule() { await this.ctx.storage.setAlarm(this.nextDeadline()); }

async alarm() {
  const r = this.room();
  const due = this.nextDeadline();
  if (Date.now() < due - 500) { await this.ctx.storage.setAlarm(due); return; }  // 이른 깨어남

  if (r.status === "running") {
    const out = this.advanceTurn();
    this.broadcast(out.ended ? this.stateMessage() : this.turnMessage());
  } else {
    await this.closeRoom();                    // 정리
    return;                                    // 정리했으면 다시 걸지 않는다
  }
  await this.reschedule();
}
```

**모든 활동과 상태 전환에서 `reschedule()` 을 부른다** — 입장, 채점, 턴 전환, 새 게임, 종료, 강퇴. `last_active_at` 이 바뀌면 다음 기한도 따라 움직여야 한다.

**정리 순서**
```
1. room.status = 'closing'
2. D1  UPDATE rooms SET status='closed', closed_at=? WHERE code=?   (멱등)
3. 남은 소켓을 닫는다
4. ctx.storage.deleteAll()
D1 이 실패하면 → deleteAll() 하지 않고 알람을 다시 건다 (재시도)
```

결과는 `end` 시점에 이미 D1 `results` 로 옮겨 두므로 지워도 남는다.

**함정** 알람은 실패하면 자동 재시도된다. `advanceTurn` 이 두 번 돌아도 괜찮도록 위의 "이른 깨어남" 방어를 반드시 넣는다.

**함정** `deleteAll()` 후 같은 방번호가 재발급되면 테이블이 없다. `init()` 의 `ensureSchema()` 가 이걸 막는다 ([2-3](#2-3-데이터-모델--do-내장-sqlite-방마다-독립)).

### 2-14. 살아있음 확인과 시계 (검토 N-001)

두 가지를 **분리한다.**

**① 살아있음 — DO를 깨우지 않는다**

```ts
this.ctx.setWebSocketAutoResponse(
  new WebSocketRequestResponsePair("PING", "PONG"));
```

화면이 20초마다 문자열 `"PING"` 을 보낸다. Hibernation 상태의 DO는 **깨어나지 않고** 런타임이 대신 답한다. 25초 안에 `"PONG"` 이 없으면 소켓을 강제로 닫고 재연결한다.

**② 시계 — 편승시킨다**

`state`·`patch`·`turn`·`result`·`error` 모두에 `serverNow` 가 들어 있다. 턴이 30~60초마다 바뀌므로 시계는 저절로 최신을 유지한다. 대기 중에는 시각이 중요하지 않고, 턴이 시작되는 순간 `turn` 이 `serverNow` 를 싣고 온다.

**두 용도를 하나로 합치지 않는다.** 자동 응답은 고정 문자열만 돌려줄 수 있어서 `clientNow/serverNow` 를 실을 수 없다. 억지로 합치면 20초마다 DO를 깨우게 되고, Hibernation 을 쓰는 의미가 사라진다.

### 2-15. 핵심 동작

**`pick`** — `Backend.gs:1085 pickCell` 이식
```
0. actionId 멱등 검사
1. running 인가, 우리 팀 턴인가, 폭풍으로 쉬는 턴인가, 시간이 남았는가
2. cell 이 내 말 둘레 8칸인가                       ← neighbors8
3. 아군 칸이면 → 이동만 하고 끝 (문제 없음). rev++
4. 이번 턴에 이미 풀었는가
5. UPDATE cells SET locked_by=?, locked_until=?
    WHERE idx=? AND (locked_by IS NULL OR locked_by=? OR locked_until<?)
   → changes 가 0이면 "이미 다른 친구가 공략 중인 칸이에요."
6. UPDATE players SET attempt_cell=?, attempt_started_at=?
7. rev++, 전원에게 patch(잠금 표시), 본인에게 quiz
```

**`answer`** — `Backend.gs:1108 submitAnswer` 이식
```
0. actionId 멱등 검사
1. attempt_cell 이 이 칸인가, 내가 잠근 칸인가
2. quizzes 에서 정답을 읽어 채점       ← 화면이 보낸 것은 choice(번호) 뿐
3. 맞으면
   · cells.owner 를 우리 팀으로                     (transferCellOwner_)
   · 보물칸(T)이고 우리 팀이 아직 안 받았으면 +2, bonus_taken 비트 설정
   · players.pos = cell
   · 폭풍칸(S)이면 skip_turns = 1
   · 공격칸(A)이면 상대 칸 하나를 무작위로 빼앗는다   (attackSteal_)
4. cells.tried++, players.solved++, last_played_turn_key 기록
5. 잠금·attempt 해제
6. events 기록, rev++, last_action_id/result 기록      ← 전부 같은 덩어리
7. 본인에게 result, 전원에게 patch
```

**`cmd` (선생님)** — `attachment.role === "teacher"` 인 소켓만

| cmd | 인자 | 동작 |
|---|---|---|
| `newgame` | `{quizSetId?, actionId}` | `quizSetId` 가 오면 **소유자 확인 후** 그 퀴즈를 새로 복사한다. 보드 재생성, 학생 명단 **유지**, 위치·점수만 초기화, `assignRandomPositions_` → `rescueTrapped_`. 전원에게 `state`(새 `quizTitle` 포함) |
| `next` | `{actionId}` | `advanceTurn_`. 2초 연타 거절. 전원에게 `turn` + `reschedule()` |
| `end` | `{actionId}` | `endGame_`. 결과를 D1 `results` 에 기록. 학생 명단 유지 |
| `reset` | `{actionId}` | 명단까지 비우고 새 판 |
| `kick` | `{playerId, actionId}` | 그 학생 삭제 + 그 소켓만 닫기 |
| `config` | 판 설정 | 다음 `newgame` 부터 적용 |

**퀴즈 교체가 `newgame` 에 붙는 이유** — 보드를 다시 만드는 순간이 유일하게 안전한 지점이다. 게임 도중에 바꾸면 이미 배정된 칸의 문제가 사라진다.

### 2-16. 방 인원 상한 (v3 추가)

v2는 "방당 60명"으로 고정했고, 검토 체크리스트는 "100명 한 방"을 시험하라고 했다. **둘은 양립하지 않는다.** 12×12=144칸에 100명이면 `assignRandomPositions_` 가 서로 붙지 않는 자리를 찾지 못하고, 찾아도 전원이 아군에 둘러싸여 도전할 칸이 없다.

**판 크기에서 계산한다.**

```ts
const maxPlayers = Math.floor(rows * cols / 2.4);
// 10×10 → 41명 · 12×12 → 60명 · 15×15 → 93명   (판은 10~15 사이만 허용)
```

정원을 넘으면 입장을 막고 **"자리가 가득 찼어요. 선생님께 판을 키워 달라고 하세요"** 라고 알린다. 선생님 화면에는 `sizeHint_`(`Backend.gs:218`)를 그대로 써서 "지금 인원이면 14×14 이상을 권합니다"를 띄운다. 판은 **10×10 ~ 15×15** 만 받는다.

따라서 부하 시험도 **93명 한 방(15×15) + 3방×34명** 으로 잡는다 ([3-4](#3-4-부하-시험)).

### 2-17. 화면

**그대로 가져오는 것** — 보드 렌더링(`renderBoard`), 좌표 라벨, 퀴즈 카드, 결과 카드, 명단, 토스트, `style.css`.

#### 화면 구성

```
① 입장 화면          학생: [방번호 4자리] [이름] → 입장
                     선생님: [선생님 로그인] 링크

② 선생님 로그인      아이디 / 비밀번호 / [가입하기]

③ 선생님 홈          ┌ 퀴즈 보관함 ────────────────────┐
                     │ ◉ 국어1      50문항  8월 3일    │  ← 라디오. 하나만
                     │ ○ 사회1      40문항  8월 7일    │
                     │ [＋ 엑셀 올리기] [미리보기] [삭제] │
                     └──────────────────────────────┘
                     ┌ 방 만들기 ──────────────────────┐
                     │ 반 이름 [3학년 2반]              │
                     │ 판 크기·턴 시간·특수칸 …          │
                     │ [방 만들기]                      │
                     └──────────────────────────────┘
                     ┌ 열려 있는 내 방 ─────────────────┐
                     │ 1234  3학년 2반  국어1  [들어가기] │
                     └──────────────────────────────┘

④ 게임 화면          ┌──────────────────────────────┐
                     │ 📘 국어1        홍 12 : 청 9  01:23│  ← 좌상단 퀴즈 제목
                     │  (보드)                          │
                     └──────────────────────────────┘
```

```html
<div class="quiz-badge" id="quiz-title">📘 <span></span></div>
```
```css
.quiz-badge{position:absolute;left:12px;top:10px;font-weight:700;font-size:15px;
  max-width:40vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
```

**함정** 제목이 길면 보드를 밀어낸다. `max-width` + `ellipsis` 를 반드시. 업로드에서도 20자로 제한한다.

**보관함 목록은 `<input type="radio">` 다.** 브라우저가 "하나만"을 보장한다. 체크박스로 만들고 JS로 막지 않는다 — 그렇게 하면 반드시 두 개가 선택되는 순간이 생긴다.

선택된 것이 없는 채로 `[방 만들기]` 를 누르면 "퀴즈를 하나 골라 주세요"라고 알린다. **버튼을 비활성화하지 않는다** — 눌러도 반응 없는 버튼 앞에서 선생님이 헤매는 일을 두 번 겪었다.

#### 통신 계층 교체

| 지금 | 새로 |
|---|---|
| `call(action, payload)` → `fetch` | `send({t, …, actionId})` → WebSocket |
| `pollState()` / `schedulePoll()` / 20초 감시 | 서버 push + `"PING"` 자동 응답 |
| `APP.myQuizzes` | **삭제.** `{t:"quiz"}` 를 받아 그때 그린다 |
| `APP.rev` nochange 판정 | `stateRev` 3분기 ([2-11](#상태-순번-staterev)) |
| `applyServerNow` / `now()` | **그대로 유지** |
| 환경설정의 스프레드시트 ID·탭 이름 | **삭제.** 보관함이 대체 |

#### 연결 관리 (`public/net.js`)

**재연결** — 0.5s → 1s → 2s → 4s → 8s(상한) + 지터. 열리면 `hello` 를 보내고 서버가 `state` 로 전부 다시 준다. **재연결이 곧 재동기화다.**

**폴백** — 첫 연결이 3초 안에 안 열리거나 30초 안에 3번 이상 끊기면 폴링으로 내려간다. `POST /api/rooms/:code/rpc` 로 `{action:"state", rev}` 를 3초마다. **DO가 같은 `handleAction()` 을 쓰므로 서버 코드는 한 벌이다.** 화면 오른쪽 위에 작게 `연결: 느림` 배지.

> 학교 방화벽이 WebSocket을 막는 경우가 있다. 이 폴백이 없으면 시연 당일 전멸한다. **선택이 아니라 필수다.**

**탭 복귀** — `visibilitychange` 에서 숨김 해제 시 즉시 확인, 응답 없으면 재연결.

#### 화면이 지켜야 할 규칙

1. **서버 메시지 없이 상태를 바꾸지 않는다.** 답을 눌러도 점수를 미리 올리지 않는다.
2. **`stateRev` 3분기를 지킨다.** 같으면 무시, +1이면 적용, 그보다 크면 `sync`(병합).
3. **변경 명령에는 `actionId` 를 붙이고, 재시도할 때 같은 값을 쓴다.**
4. **보기를 한 번 누르면 나머지를 잠근다.**
5. **선생님 버튼은 절대 비활성화하지 않는다.**
6. **막히면 이유를 말한다.** `error.code` 로 분기해 사람 말로.

**함정** 캐시. `index.html` 의 `?v=` 를 배포마다 올린다. `_headers` 의 no-cache 규칙(`/*`, `/`, `/index.html`)도 그대로 가져온다. 이걸 빠뜨려 학생들이 옛 화면을 계속 쓴 일이 두 번 있었다.

### 2-18. 게임 규칙 이식 (`src/game.ts`)

`Backend.gs` 의 순수 함수를 TypeScript로 옮긴다. **로직을 바꾸지 않는다.**

| 옮길 것 | 원본 |
|---|---|
| `neighbors8` `rc` `idx` `cellLabel` `colLabel` `chebyshev` | `Backend.gs:775-812` |
| `shuffle` | `:665` |
| `assignQuizzes` `buildBoard` | `:937` `:955` |
| `assignRandomPositions` `placeLatePlayer` `rescueTrapped` `canChallengeFrom` `occupiedMap` | `:886-935` |
| `transferCellOwner` `attackSteal` `totals` | `:854` `:1136` `:848` |
| `advanceTurn` `endGame` | `:1146` `:1175` |
| `canPlayNow` `turnKey` `validateStudentAction` | `:844` `:843` `:1073` |
| `parseQuizValues` | `:687` |
| `sizeHint` | `:218` |

**함정** 이 함수들은 지금 "상태 객체를 직접 고치는" 방식이다. 순수 계산(`neighbors8`, `buildBoard`, `assignQuizzes`)은 그대로 두고, 상태를 고치는 부분만 `room.ts` 의 메서드로 옮겨 **읽어서 계산 → SQL로 쓰기** 모양으로 감싼다.

### 2-19. 변경 파일 체크리스트

```
신규 ─ cloudflare-v2/
  □ package.json / tsconfig.json / wrangler.jsonc
  □ migrations/0001_init.sql        teachers · sessions · quiz_sets · rooms · results
  □ src/index.ts                    라우터 + 쿠키→teacherId 경계
  □ src/auth.ts                     가입 · 로그인 · 세션 · PBKDF2
  □ src/quizsets.ts                 보관함 (모든 조회에 teacher_id 조건)
  □ src/rooms.ts                    방 개설 saga (예약 → init → ready)
  □ src/room.ts                     RoomDO (fetch/webSocket*/alarm/handleAction/퀴즈 복사)
  □ src/schema.ts                   DO SQLite DDL (ensureSchema 멱등)
  □ src/game.ts                     게임 규칙 이식
  □ src/quiz.ts                     parseQuizValues + parseQuizFile
  □ src/xlsx.ts                     ← 골든 픽스처 게이트 통과 후에 작성
  □ src/protocol.ts                 메시지 타입 + stateRev 표시
  □ public/index.html               입장 · 로그인 · 선생님 홈 · 게임(퀴즈 제목 배지)
  □ public/app.js                   화면 로직 (myQuizzes 삭제, 폴링 삭제)
  □ public/net.js                   WebSocket · 재연결 · 폴백 · actionId
  □ public/teacher.js               로그인 · 보관함 · 방 만들기
  □ public/style.css / public/_headers
  □ test/fixtures/                  골든 xlsx 3종 (Excel · LibreOffice · Google Sheets)
  □ test/{game,quiz,xlsx,auth,rooms,room,protocol}.test.ts
  □ tools/loadtest.mjs

변경 없음 ─ apps-script/  cloudflare/
문서 ─ □ docs/PROJECT_SPEC.md 에 v2 구조 절 추가 (전환 완료 후)
```

---

## 3. 테스트 방법

### 3-1. 로컬 준비

```bash
cd cloudflare-v2
npm install
npx wrangler d1 create treasure          # database_id 를 wrangler.jsonc 에
npx wrangler d1 migrations apply treasure --local
npm run dev
```

`.dev.vars` (로컬 전용, **커밋 금지**)
```
SIGNUP_CODE=테스트가입코드
```

### 3-2. 단위 테스트

```bash
npm test
```

**`test/game.test.ts`** — 지금 `runGeometryTests()`(`Backend.gs:814`) 가 확인하던 것과 같은 값이 나오는지.

| 확인 | 기대 |
|---|---|
| `neighbors8` 모서리/변/안쪽 | 3 / 5 / 8개 |
| `neighbors8` 대각선 포함 | 12×12 에서 13번의 이웃에 0번이 있다 |
| `buildBoard` 특수칸 수 | T·S·A 가 설정값과 정확히 일치 |
| `assignQuizzes` | 이웃끼리 같은 문제가 없다 |
| `advanceTurn` | H→C→H, 라운드 1 증가, 초과 시 종료 |
| 폭풍칸 / 보물칸 | 다음 자기 턴 1회 쉼 / 같은 팀 보너스 중복 없음 |
| `maxPlayers` | 10×10 → 41, 12×12 → 60, 15×15 → 93 |
| `checkBoardSize` | 10~15 밖은 거절 |

**`test/quiz.test.ts` · `test/xlsx.test.ts`**

| 확인 | 기대 |
|---|---|
| 숫자 정답 `"1"` | `ans:0` |
| 보기 3개인데 정답 4 / 보기 중간이 빔 | 건너뛰고 **행 번호를 보고** |
| 뒤쪽 빈 칸 | 잘라내고 정상 처리 |
| **골든 xlsx 3종** (Excel · LibreOffice · Google Sheets) | CSV와 **완전히 같은 `ParseResult`** |
| 중간이 빈 셀이 있는 xlsx | **열이 밀리지 않는다** |
| rich text(`<r>` 조각) 셀 | 이어 붙여 한 문자열 |
| 해석 불가 파일 | 조용히 건너뛰지 않고 **명시적 거절** |

**`test/auth.test.ts`**

| 확인 | 기대 |
|---|---|
| 틀린 가입 코드 / 아이디 중복 | 거절 |
| 세션 없이 `/api/quizsets` | 401 |
| 남의 `quizSetId` 로 방 개설 · `newgame` · 미리보기 · 삭제 | 전부 거절 |
| 쿠키 없는 교사 WS · 다른 소유자 | `not-owner` |
| `hello` 전 `cmd` | 거절, 상태 변화 없음 |

**`test/rooms.test.ts`** — 방 개설 saga (검토 F-002)

| 확인 | 기대 |
|---|---|
| 난수를 같게 강제한 동시 개설 2건 | 서로 다른 코드 두 개, 둘 다 `ready` |
| 같은 `requestId` 로 두 번 | **같은 방** 하나 |
| DO `init` 실패 주입 | `rooms` 행이 `closed`, 고아 방 없음 |
| `ready` 전환 후 응답 유실 → 재시도 | 방이 하나만 |
| 10분 지난 `provisioning` 코드 재사용 | 정상 발급 |

**`test/room.test.ts`** — `@cloudflare/vitest-pool-workers`

| 확인 | 기대 |
|---|---|
| **보관함에서 퀴즈를 지운 뒤 게임 진행** | **정상 진행** (사본이므로) |
| `newgame {quizSetId}` | 퀴즈와 `quizTitle` 이 함께 바뀐다 |
| **끊긴 동명 학생이 다시 들어옴** | **그 자리를 이어받는다** (새 사람이 안 생긴다) |
| 접속 중인 동명이 또 들어옴 | 뒤에 2가 붙는다 |
| 같은 칸을 두 명이 `pick` | 한 명만 성공 |
| 이번 턴 두 번째 `pick` | 거절 |
| 오답 | 칸이 안 넘어가고 `tried` 만 증가 |
| **같은 `actionId` 로 `answer` 두 번** | `tried`·`solved`·`correct`·`bonus`·`rev` 가 **한 번만** 변하고 같은 결과 |
| 같은 `actionId`, 다른 내용 | `action-conflict` |
| `alarm` 을 시각 넘겨 호출 / 두 번 호출 | 턴이 **한 번만** 넘어간다 |
| **waiting 방을 3시간 가속** | 정리된다 |
| **ended 방을 3시간 가속** | 정리된다 |
| 정리 중 D1 실패 | `deleteAll()` 하지 않고 알람 재설정 |
| 정리된 코드로 새 방 | 스키마가 정상 초기화 |
| 정원 초과 입장 | 거절 + 안내 |

**`test/protocol.test.ts`** — 불변식 fuzz (검토 N-002)

예시 순서만 보지 않는다. 메시지를 **중복·순서 바꿈·유실·재연결** 로 무작위 생성해 두 가지 불변식을 검증한다.

1. **서버 정본 == 클라이언트 정본** (모든 시나리오 종료 시점)
2. **변경 명령 하나당 효과는 한 번**

부수 확인: `pong`/`presence`/`error`/`quiz` 를 아무리 끼워 넣어도 `sync` 가 발생하지 않는다. 실제로 `patch` 하나를 버렸을 때만 `sync` 가 **정확히 한 번** 발생한다.

### 3-3. 수동 시나리오

시크릿 창을 쓰면 `localStorage`·쿠키가 분리돼 여러 사람 흉내가 쉽다.

**① 선생님 계정** — 가입 → 로그아웃 → 재로그인 → 틀린 비번 → 새로고침 후 유지

**② 퀴즈 보관함**
1. `sample/퀴즈_샘플_v3.csv` 를 "국어1"로 → 목록에 50문항
2. **실제 엑셀(.xlsx)** 을 "사회1"로 → CSV와 같은 결과
3. "국어1"을 또 올리기 → "덮어쓸까요?"
4. 깨뜨린 파일 → **몇 행이 왜 건너뛰어졌는지** 보이는지
5. **목록에서 두 개를 동시에 선택 시도 → 안 되어야 한다**

**③ 방 만들기**
1. 퀴즈 고르고 [방 만들기] → 방번호 4자리
2. **퀴즈를 안 고르고 [방 만들기]** → 안내가 뜨고, **버튼은 눌려야 한다**
3. **[방 만들기]를 빠르게 두 번** → 방이 **하나만**
4. 다른 PC에서 로그인 → [열려 있는 내 방]에서 이어받기

**④ 학생 입장**
1. 방번호+이름 → 보드
2. **좌상단에 "📘 국어1"** ← 이번에 추가한 기능
3. 없는 방번호 → "그런 방이 없어요"
4. **아무 번호나 여러 번 쳐 본 뒤 선생님 화면 → 유령 방이 안 생겼는지**
5. 새로고침 → 그대로 돌아오는지

**⑤ 게임 진행**
1. [새 게임] → 시작 칸이 팀 색으로
2. [시작] → 홍팀만 고를 수 있는지
3. 칸을 고르면 **문제가 즉시** 뜨는지
4. 한 학생이 정답 → **다른 학생 화면의 그 칸이 즉시** 바뀌는지 ← 이번 작업의 핵심
5. 같은 칸을 두 명이 동시에 → 한 명만, 다른 한 명은 이유를 듣는지
6. 폭풍칸 / 공격칸 / 보물칸 각각
7. **아무도 안 누르고 기다리기** → 시간이 되면 턴이 저절로 넘어가는지 ← 지금은 안 되던 것
8. [종료] → 승패가 뜨고 학생이 튕기지 않는지

**⑥ 퀴즈 교체** — 게임 중 "사회1"을 고르고 [새 게임] → 좌상단 제목이 학생 화면에서도 바뀌는지, 실제로 사회 문제가 나오는지

**⑦ 사본 확인 (이번 설계의 핵심)**
1. "국어1"로 게임 시작 → **게임 중에 다른 창에서 "국어1" 삭제**
2. 진행 중인 게임이 멀쩡히 끝나는지
3. 삭제 시 "지금 방 1234에서 쓰는 중입니다" 안내가 나오는지

**⑧ 끊김**
1. Network → Offline 5초 → 온라인 → **저절로 돌아오는지**
2. 노트북 덮개를 닫았다 열기
3. 문제를 푸는 중에 끊기 → 굳지 않는지
4. **답을 제출하는 순간 끊기 → 재연결 후 점수가 한 번만 올라갔는지** ← F-004
5. 선생님 창을 끊었다 다시 → 진행 중인 게임이 그대로

**⑨ 이름 이어받기 (v3 추가)**
1. 학생이 들어와 문제를 풀고 → 창을 닫는다
2. **같은 이름으로 다시 들어온다** → 점수·위치가 **그대로 이어지는지** (새 사람이 안 생기는지)
3. 접속 중인 상태에서 다른 창이 같은 이름 → "○○2" 로 들어가는지
4. 선생님 명단에 유령이 없는지

**⑩ 폴백** — WebSocket을 막거나 `FORCE_POLL=true` → 게임이 그대로 되는지, `연결: 느림` 배지

**⑪ 여러 방 · 여러 선생님**
1. 계정 2개, 각자 다른 퀴즈, 동시 진행 → **문제가 안 섞이는지**
2. 각 방의 좌상단 제목이 각자 맞는지
3. A 선생님이 B 선생님 방에 선생님으로 붙기 → `not-owner`

**⑫ 정원** — 12×12에 61번째 학생 → "자리가 가득 찼어요" + 선생님 화면에 판 크기 권고

**⑬ 회귀 — 지금까지 난 사고**

| 과거 사고 | 확인 |
|---|---|
| 정답인데 오답 처리 | 30문제 이상 풀어 화면 문제와 채점이 늘 맞는지 |
| 화면이 굳어 나갔다 들어와야 함 | ⑧-3, ⑧-4 |
| **PC 시계가 틀리면 못 누름** | 학생 PC 시계를 5분 앞당기고 정상인지 ← **반드시** |
| 이중 제출 | 보기를 빠르게 두 번 클릭 |
| 게임 끝나면 전원 튕김 | ⑤-8 |
| 같은 이름이 계속 새로 생김 | ⑨ |
| 선생님 버튼 먹통 | 서버를 끄고 버튼을 눌러 이유가 뜨는지 |

### 3-4. 부하 시험

```bash
node tools/loadtest.mjs --room 1234 --students 93 --questions 10      # 15×15 한 방 정원
node tools/loadtest.mjs --rooms 3 --students 34 --questions 10        # 102명 · 방 3개
```

- 재는 것: 문제 요청→표시, 답 제출→결과, 방송 도달, 끊김 횟수, **정답인데 오답 처리된 수(0이어야 한다)**, **중복 적용된 변경 수(0이어야 한다)**
- 목표: 중앙값 100ms 미만, 상위 5% 300ms 미만 *(지금은 중앙 1,342ms · 최대 41,165ms)*
- 방 3개 시험은 **방끼리 안 미는지**를 본다. 한 방의 응답시간이 다른 방 때문에 나빠지면 설계가 틀린 것이다.

> **v2의 "100명 한 방"은 폐기했다.** 12×12에 100명은 배치가 불가능하다 ([2-16](#2-16-방-인원-상한-v3-추가)). 100명은 방을 나눠서 만든다.

**함정** 로컬 `wrangler dev` 는 실제 성능과 다르다. 부하 시험은 **반드시 배포된 환경에서.**

### 3-5. 배포

```bash
cd cloudflare-v2
npm run check                                        # 타입 + dry-run
npx wrangler d1 migrations apply treasure --remote   # ← 원격에 따로
npx wrangler secret put SIGNUP_CODE
npx wrangler deploy
```

첫 배포 때 DO 마이그레이션(`new_sqlite_classes`)이 함께 적용된다. **출력에 마이그레이션 줄이 보이는지 확인한다.**

```bash
curl -s https://treasure-island-v2.<계정>.workers.dev/api/rooms/0000    # 404 가 정상
```

**병행 운영** — 지금 주소(`treasure-island-conquest.ds1lph.workers.dev`)는 그대로 둔다. 새 주소에서 몇 번 수업해 보고 문제가 없으면 그때 바꾼다. 되돌리려면 옛 주소를 그대로 쓴다.

### 3-6. 구현 순서 (권장)

검토가 짚은 차단 항목을 먼저 세운다.

```
1주차  ├ D1 스키마 + auth (로그인 → 세션 쿠키 → /api/auth/me)
       ├ 보관함 CRUD (CSV만) + 소유자 조건 테스트
       └ xlsx 골든 픽스처 게이트  ← 1~2일 타임박스. 여기서 자체/라이브러리 결정
2주차  ├ 방 개설 saga + rooms 테스트 (동시·실패 주입)
       ├ RoomDO 뼈대 + ensureSchema + game.ts 이식 + game 테스트
       └ handleAction (WS/RPC 공용) + actionId 멱등 + room 테스트
3주차  ├ WebSocket 방송 + stateRev + protocol fuzz 테스트
       ├ alarm 스케줄러 (턴 + 정리) + 가속 테스트
       └ 화면 이식 + net.js (재연결·폴백)
4주차  ├ 부하 시험 (배포 환경)
       └ 실제 수업 1회 (병행)
```

**차단 항목이 통과하기 전에는 그 위에 아무것도 쌓지 않는다.** xlsx 게이트가 실패하면 라이브러리로 갈아타는 결정을 먼저 하고, 방 개설 saga가 동시성 테스트를 통과하기 전에는 게임 로직으로 넘어가지 않는다.

---

## 부록 — 열린 결정

기본값으로 정한 것들. 바꾸고 싶으면 말씀 주시면 문서를 고친다.

| 항목 | 정한 값 | 근거 · 바꿀 때 |
|---|---|---|
| 계정 만들기 | **가입 코드 + 스스로 가입** | 학교에서 코드 하나를 공유. 관리자가 직접 만들려면 가입 화면을 빼고 `wrangler d1 execute` 로 |
| 아이디 규칙 | 영문/숫자 4~20자 | |
| 세션 유효기간 | **12시간** | 하루 수업을 덮는다. 번거로우면 7일 |
| 퀴즈 제목 | **1~20자**, 선생님 안에서 유일 | 게임 좌상단에 들어간다 |
| 같은 제목 재업로드 | **물어본 뒤 덮어쓰기** | 목록에 같은 이름이 둘 뜨는 걸 막는다 |
| 문항 저장 | **JSON 한 컬럼** | 덮어쓰기가 원자적이 된다. 80문항 ≈ 15KB |
| 최대 문항 | **80** | 선생님 결정(2026-08-09). 넘는 줄은 자동으로 건너뛴다. 80문항 JSON 은 15KB 안팎이라 D1 한 컬럼에 넉넉히 들어간다 |
| 퀴즈 교체 시점 | **`새 게임` 때만** | 게임 도중 교체는 배정된 칸을 깨뜨린다 |
| 방번호 | **4자리 숫자** | 아이들이 치기 쉽다. 충돌은 D1 PK 예약으로 |
| 개설 멱등키 | 화면이 만든 UUID, `(teacher_id, request_id)` UNIQUE | 두 번 눌러도 방은 하나 |
| `provisioning` 만료 | **10분** | 그 뒤엔 번호를 재사용한다. 개설 부하 시험 후 조정 |
| 방 수명 | 마지막 활동 후 **3시간** | 한 교시 + 여유. 다음 반까지 이어 쓰려면 늘린다 |
| 멱등 기록 보관 | 학생/방당 **마지막 하나** | 방 수명과 함께 사라진다 |
| 판 크기 | **10×10 ~ 15×15** | 선생님 결정(2026-08-09). 그보다 작으면 배치가 빡빡하고, 크면 교실 화면에서 칸이 너무 작아진다 |
| 판 기본값 | 12×12 · 10라운드 · 60초 · 보물8/폭풍7/공격7 | `Backend.gs:132 DEFAULTS_` 그대로 |
| 방 정원 | **`rows*cols/2.4`** (10×10 → 41명 · 12×12 → 60명 · 15×15 → 93명) | 배치가 빡빡해지는 경계. 실측 후 계수 조정 |
| 동명 처리 | **끊긴 동명이면 이어받기, 접속 중이면 번호** | 교실에서는 같은 이름 = 같은 아이가 다시 들어온 것 |
| 엑셀 읽기 | **자체 파서 확정** (2026-08-09) | `src/xlsx.ts`. 실제 파일로 CSV 와 동일 결과 확인 |
| 시트 선택 | **`퀴즈` 시트 우선, 없으면 맨 앞 보이는 시트** | 숨긴 탭은 건너뛴다. 고르게 하려면 업로드 화면에 목록을 |
| 살아있음 확인 | `setWebSocketAutoResponse("PING"→"PONG")`, 20초 | DO를 깨우지 않는다 |
| 수업 기록 | D1 `results` 에 영구 보관 | 선생님이 볼 화면이 필요하면 별도 작업 |
| 로그 | DO `events` 에 방별로. 방이 지워질 때 함께 | 남겨야 하면 종료 시 D1으로 |
| 실시간 감시 도구 | `tools/watch.py` 를 v2용으로 다시 | WebSocket으로 붙으면 훨씬 정확해진다 |

### 구현 전에 확인해야 할 것 (검토가 남긴 결정)

| 시점 | 확인할 것 | 통과하지 못하면 |
|---|---|---|
| ~~보관함 구현 전~~ | ~~D1 값 크기 한도~~ → 문항 상한이 80개로 정해져 **해소됨** | — |
| ~~`xlsx.ts` 작성 전~~ | ~~골든 픽스처 3종~~ → **2026-08-09 통과.** 자체 파서로 확정 | — |
| 방 개설 구현 전 | `provisioning` 만료 시간 | 개설 부하 시험으로 실측 |
| 배포 전 | 정리 알람 · D1 실패 재시도 간격 | 가속 3시간 테스트로 실측 |
