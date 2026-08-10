# plan_3D표시_v3

> 선생님 화면의 **보드 좌우 빈 공간**을 팀별 무대로 쓴다.
> 왼쪽은 홍팀, 오른쪽은 청팀. **지금 차례인 팀 무대에는 팀 색 빛이 깔리고** 수색 그림이 움직인다.
> 차례가 끝나면 그 자리에 **그 턴에 실제로 일어난 일**(보물·공격·폭풍·일반)이 3D 그림으로 남는다.
>
> 조사 기준: `65e721a` (2026-08-09) · `cloudflare-v2/` (Durable Objects 판) · `APP_BUILD = "2026-08-09b"`
> 이 문서 하나만 남긴다. `plan_3D표시_v1.md`(앱스크립트판 오버레이 설계), `plan_3D표시_v2.md`,
> `plan_3D표시_v2_codex.md`(검토본)는 **이 문서로 합치고 지웠다.**

---

## 구현 현황 (2026-08-10)

**다 됐다.** 시험 148개 통과 · 타입 검사 통과 · 로컬에서 8명 5라운드 완주(턴 요약 어긋남 0/10).
아래는 설계와 달라진 것과, 만들면서 실제로 나온 문제다. 배포는 아직 안 했다.

| 단계 | 상태 |
|---|---|
| 1단계 그림 8장 | ✅ A안(픽사풍) · 참조 원본에서 파생 · 청팀은 좌우 반전 · WebP 1.5MB |
| 2단계 서버 (`fx` 테이블 · `captureFx` · `TurnFx`) | ✅ 시험 13개 추가 |
| 3단계 화면 (무대 · 빛 · 회전 · 시계) | ✅ 실제 선생님 화면에서 확인 |
| 빛 값 확정 | ✅ 2026-08-10 `/fx-preview` 에서 정함 (아래) |
| 배포 | ⬜ |

### 설계와 달라진 것

| 설계 | 실제 | 왜 |
|---|---|---|
| 그림을 PNG 로 배포 | **WebP** (원본 PNG 는 `img/`) | PNG 8장이 6.5MB. 768px 로 줄이고 색을 깎아도 2.4MB 였다. WebP 는 **1024px 그대로 1.5MB** 다 |
| 뷰포트 1200px 미만에서 접기 | **실제 남는 폭 190px 기준** | 1366 노트북 + 12×12 판이면 한쪽에 정확히 199.5px 가 남는다. 뷰포트로는 판이 커지면(15×15=750px) 판정이 어긋난다 |
| 멀미 줄이기: 첫 카드만 남김 | **세로로 전부 펼침** | 첫 장만 남기면 보물을 열었다는 사실을 못 보고 지나간다. 움직임만 없애고 정보는 지킨다 |
| 장면별 크기 보정 없음 | **`--fx-s-*` 변수 추가** | 폭풍은 야자수가 화면의 93%를 먹어 인물이 작아 보인다. 미세 조정만 한다(크게 키우면 무대 밖으로 나간다) |
| 발밑 조명 `bottom:78px` | **`bottom:26%` (변수)** | 78px 은 이름표 뒤였다. 발끝 높이는 무대 높이에 비례한다 |
| 시계 흰색 | **팀 색** | 크림색 패널 위에서 흰 글씨가 안 읽혔다. 팀 색이면 누구 시간인지도 같이 말해 준다 |

### 만들면서 나온 문제 넷

1. **`dim` 이름이 겹쳤다.** 결과 카드에 `dim` 클래스를 붙였는데, `style.css` 에 이미
   모달 뒷배경용 `.dim{position:fixed;background:#102b3d99}` 이 있었다.
   **차례가 아닌 쪽 무대에 남색 사각형이 통째로 칠해졌다.** `faded` 로 바꿨다.
   → 한 낱말짜리 클래스 이름은 이 파일에서 반드시 충돌을 확인하고 쓴다.
2. **시계가 이름표와 겹쳤다.** 카드는 `inset:0` 로 가운데 정렬인데 시계는 `bottom:6px` 절대배치라
   둘이 같은 자리를 썼다. 카드에 `padding-bottom:52px` 로 시계 자리를 비웠다.
3. **빛이 너무 옅었다.** 설계할 때 "바다 배경 위"를 가정했는데 무대는 크림색 패널(`--paper`) 위에 얹힌다.
   기본 진하기를 `.22 → .34` 로 올렸다.
4. **`playtest.mjs` 가 턴을 안 넘기고 있었다.** [다음 턴]의 2초 연타 방지에 걸려 명령이 조용히
   거절되는데, 도구는 넘어간 줄 알고 진행했다. 그래서 학생 전원이 `already-played` 로 튕기고
   있었다(예전 기록의 `already-played: 12`, `20` 이 그것이다).
   **넘어간 것을 확인할 때까지 기다리도록** 고쳤다 — 같은 5라운드에서 채점이 20 → 40 으로 늘었다.
   제품 결함이 아니라 시험 도구의 결함이었지만, 그동안 부하 시험의 절반이 헛돌고 있었다.

### 확인한 것

```
시험 148개 (턴 요약 13개 추가)      npx vitest run
타입 + 배포 예행                    npm run check
사람 없이 한 판 (8명 · 5라운드)      SIGNUP_CODE=... npm run play -- --base http://localhost:8787
  · 문제-정답 어긋남 0 · 재시도 중복 0 · 순번 건너뜀 0 · 턴 요약 어긋남 0/10
실제 선생님 화면                     헤드리스 크롬으로 띄워 확인
  · board-stage wide(접기 판정 통과) · 그림 8장 로딩 · turnFx 전달 · 팀 색 빛
```

### 정해진 빛 값 (2026-08-10)

```css
--fx-tint-alpha:.49;   /* 처음 잡은 .22 는 크림색 패널 위에서 거의 안 보였다 */
--fx-tint-size:73%;
--fx-glow:1;           /* 발밑 조명은 최대 */
--fx-glow-y:36%;
--fx-rest:.35;         /* 쉬는 쪽을 더 물렸다 */
--fx-s-storm:1;      /* 1.3 은 그림이 무대를 넘어 보드에 걸쳤다 */
```

`fx-preview.html` 의 초기값도 같은 값으로 맞춰 두었다. **한쪽만 고치면 다음에 열었을 때 어긋난다.**

**장면별 크기 보정은 결국 안 쓰기로 했다.** 폭풍을 1.3 배로 키워 보니 그림이 420 → 524px 이 되어
무대(477px)를 좌우로 24px 씩 넘고, 야자수 잎이 보드 위로 걸쳤다. 좁은 화면에서는 비율만큼 더 넘는다.
**인물이 작아 보이는 것보다 보드를 가리는 것이 더 나쁘다.** 네 장면 모두 1.0 으로 둔다
(`--fx-s-*` 변수는 남겨 두었으니 나중에 필요하면 그 값만 바꾸면 된다).

**남은 것** — 배포, 그리고 원래 남아 있던 부하 시험.

---

## 0. 검토(v2_codex) 반영 결과

| 항목 | 판정 | 이 문서에서 |
|---|---|---|
| **F-001** 특수칸 문구가 실제 효과와 다를 수 있다 | **그대로 채택** | 진짜 버그였다. `LogEntry`에 `bonus`·`stolen`을 남기고, 연출 종류를 6가지로 쪼갠다 → §2-4, §2-5 |
| **F-002** 프롬프트 반복만으로는 8장이 같은 캐릭터가 안 된다 | **그대로 채택** | `search-H` 한 장을 **참조 원본**으로 확정하고 나머지 7장을 파생한다 → §2-2 |
| **F-003** `_headers` 규칙 충돌 + 고정 이름에 `immutable` | **그대로 채택** | `/*` 통짜 규칙을 해체한다. 그림 URL에 `?v=APP_BUILD`. `immutable`은 안 쓴다 → §2-10 |
| **F-004** 자동 종료에서 같은 턴을 두 번 캡처 | **그대로 채택** | `captureFx()`를 turnKey 기준 멱등으로 만든다 → §2-5 |
| **F-005** 뷰포트 1200px으로는 배치 가능 여부를 못 정한다 | **채택하되 방법을 바꿈** | 지적이 맞다. 다만 컨테이너 쿼리 대신 **실제 보드 폭을 재서** 판정한다. 이유는 §2-8 |
| **F-006** 시험이 분기를 못 덮는다 / 멀미 줄이기 | **대부분 채택, 한 가지 불채택** | 서버 분기 시험 전부 + `playtest.mjs` 확장 + 멀미 줄이기. **DOM 자동화는 안 한다** — 이유는 §3-4 |
| **N-001** 문구를 서버 키 + 클라이언트 사전으로 | **그대로 채택** | `FxKind` 6종 → §2-4 |
| **N-002** 프리뷰에 화면폭·멀미 토글 | **채택하고 더 키움** | 색 조절 도구까지 겸한다 → §2-11 |
| **OUT-001** 학생 화면에도 3D | 범위 밖 | 학생 화면은 안 건드린다 |
| **OUT-002** Three.js 실시간 3D | 범위 밖 | PNG 8장 + CSS |

**F-001은 이 검토의 값어치를 혼자 다 했다.** 실제로 `doAnswer()`는 이미 보너스를 받은 팀이 보물칸을 다시
점령하면 `bonus = 0`이고([room.ts:817](../cloudflare-v2/src/room.ts#L817)), 공격칸을 맞혀도 빼앗을 상대 땅이
없으면 `stolen = null`이다([room.ts:832](../cloudflare-v2/src/room.ts#L832)). v2 설계대로 만들었으면
**점수는 +1인데 교실 TV에는 "+2"라고 뜨는** 화면이 나왔다. 교사가 보드와 연출 중 뭘 믿어야 하는지
모르게 되는 순간 이 기능은 없느니만 못하다.

---

## 1. 제작자의 의도 (왜 만드는가)

### 1-1. 지금 화면은 이렇게 생겼다

2026-08-09 감시 테스트 화면 그대로다. 12×12 판, 학생 4명.

```
┌────────────────────────────────────────────────────────────────┬─────────┐
│ 📘 상식1(샘플)   4529 · 감시테스트                    [연결됨] │ ⚙ 설정  │
├────────────────────────────────────────────────────────────────┼─────────┤
│ ┌────────────────────────────────────────────────────────────┐ │ 홍팀  2 │
│ │ [종료] 라운드 1 / 10                              00:00    │ │ 청팀  2 │
│ │                                                            │ ├─────────┤
│ │                    A B C D E F G H I J K L                 │ │ 학생 4명│
│ │                  1 ? ? ? ? ? ? ? ? ? ? ? ?                 │ ├─────────┤
│ │  ←── 여기가  ──→ 2 ? ? ▩ ? ? ? ? ? ? ? ? ?   ←── 여기가 ──→│ │ 새 게임 │
│ │      통째로      3 ? ? ? ? ? ? ? ? ? ? ? ?       통째로     │ │ 종료    │
│ │      비어 있다   … (12줄)                        비어 있다  │ │ 초기화  │
│ │                 12 ? ? ? ? ? ? ? ? ? ? ? ?                 │ ├─────────┤
│ └────────────────────────────────────────────────────────────┘ │ 판 기록 │
└────────────────────────────────────────────────────────────────┴─────────┘
```

낭비가 숫자로 나온다. 보드는 `.board{width:max-content;margin:auto}`라 가운데 붙어 있고
남는 폭이 전부 좌우로 갈라진다.

| 화면 폭 | 본문 폭(사이드바 270 제외) | 보드 폭(12칸) | **한쪽에 남는 폭** |
|---|---|---|---|
| 1920 (교실 TV) | ≈ 1600 | 609 | **≈ 480px** |
| 1600 | ≈ 1290 | 609 | ≈ 325px |
| 1366 (노트북) | ≈ 1050 | 609 | ≈ 205px |

칸 크기는 `px = max(23, min(45, floor((innerWidth-330)/(cols+1))))`([app.js:97](../cloudflare-v2/public/app.js#L97))로
**45px에서 상한이 걸린다.** 화면이 아무리 넓어도 보드는 609px에서 더 안 커지고, 늘어난 폭은 전부 여백이 된다.
**교실 TV가 클수록 빈 공간이 넓어지는 구조다.**

### 1-2. 그 빈 공간이 아까운 진짜 이유

이 게임에서 **가장 재미있는 순간이 화면에 하나도 안 남는다.**

한 학생이 문제를 풀면 서버는 넷 중 하나를 한다([room.ts:795](../cloudflare-v2/src/room.ts#L795) `doAnswer`).

| 결과 | 서버가 하는 일 | 지금 선생님 화면에 남는 것 |
|---|---|---|
| 일반 칸 정답 | 칸 주인이 바뀐다 | 칸 색만 바뀐다 |
| 📦 보물 | 칸 + 보너스 2점 (**팀당 한 번만**) | 칸 색 + 사이드바 숫자가 `2 → 4` |
| ⛈️ 폭풍 | 칸 + 그 학생 다음 턴 쉼 | 칸 색만 바뀐다 |
| 💥 공격 | 칸 + **상대 땅 하나를 무작위로 빼앗음** (**빼앗을 땅이 있을 때만**) | 칸 색 + 지도 어딘가가 조용히 뒤집힌다 |

특히 공격이 그렇다. `pickStealTarget()`이 상대 칸 하나를 골라 소유권을 옮기는데,
144칸 지도에서 **어디가 뒤집혔는지 교사가 눈으로 찾는 것은 사실상 불가능하다.**
교실에서 이 게임의 재미는 "누가 뭘 터뜨렸냐"인데, 가장 극적인 순간이 아무 연출 없이 지나간다.

사이드바의 `이번 판 기록`이 그나마 이걸 보여주지만 이렇게 생겼다([app.js:142](../cloudflare-v2/public/app.js#L142)).

```
✅ 민수    +3
✅ 영희    +1
❌ 철수     -
```

**칸 종류가 없다.** `+3`이 보물이었다는 걸 읽어내려면 산수를 해야 하고, 글자는 11px이라
교실 뒤에서는 보이지도 않는다. 이건 교사 확인용이지 학생에게 보여주는 화면이 아니다.

### 1-3. 그래서 이렇게 만든다

빈 좌우를 **팀별 무대**로 쓴다. 왼쪽은 홍팀 전용, 오른쪽은 청팀 전용으로 고정한다.
사이드바 점수판이 홍(위)·청(아래) 순서라 어긋나지 않고, 무엇보다
**교사가 "왼쪽 봐, 홍팀!" 하고 손으로 가리킬 수 있다.**

한쪽 무대는 항상 둘 중 하나다.

```
    ┌── 홍팀 차례일 때 ──┐          ┌── 청팀 차례일 때 ──┐
왼쪽│ ▨ 붉은 빛 ▨        │   →     │  📦 보물을 열었다!  │
    │  🔍 수색 (움직임)   │          │  민수 · 영희        │  ← 방금 끝난 홍팀 턴의 결과
    │  "3명이 푸는 중"    │          │  (빛 없음, 채도 낮음)│
    └────────────────────┘          └────────────────────┘

오른│  ⛈️ 폭풍에 갇혔다   │   →     │ ▨ 초록 빛 ▨        │
쪽  │  수경               │          │  🔍 수색 (움직임)   │
    │  (빛 없음)          │          │  "2명이 푸는 중"    │
    └────────────────────┘          └────────────────────┘
      ↑ 직전 청팀 턴의 결과
```

**어느 순간에도 한쪽은 빛을 받으며 수색 중이고, 다른 쪽은 방금 한 일을 자랑하고 있다.**
이게 설계의 전부다. 재생 버튼도, 사라지는 타이머도 없다.
다음 턴이 시작되면 차례가 된 쪽에 빛이 옮겨 붙고, 반대쪽에 결과가 올라간다.

사용자가 말한 그대로다 —
*"문제를 풀 때는 일반 화면만 나온다… 움직인다. 문제 풀이가 끝나 다음 턴으로 넘어가면 화면에 결과로 3D 이미지가 나온다."*

**지금 누구 차례인지를 색으로 알린다**(이번 판에서 새로 들어온 요구). 왼쪽이 차례면 왼쪽 무대에
붉은 기가, 오른쪽이면 초록 기가 은은하게 깔린다. 색이 진하면 3D 그림이 상한다는 것도 사용자가 짚었다.
**그래서 색·투명도·퍼지는 정도를 플레이 예제 페이지에서 직접 돌려 보고 정한다.** §2-3, §2-11.

### 1-4. 조사로 드러난 현실

**이미 있는 것 (그대로 쓴다):**

- **사건 기록이 이미 쌓인다.** [room.ts:847](../cloudflare-v2/src/room.ts#L847) — 채점할 때마다
  `events` 테이블에 `kind='answer'` 로 `{at,name,team,cell,ok,gain,type}`이 들어간다.
  누가·어느 팀·무슨 칸(N/T/S/A)·맞았는지가 있다. **다만 `bonus`와 `stolen`이 빠져 있다 → F-001.**
- **턴 경계 시각이 이미 있다.** `room.last_turn_at`이 턴이 시작될 때마다 갱신된다([room.ts:602](../cloudflare-v2/src/room.ts#L602)).
  → `events.at >= last_turn_at` 이 곧 **이번 턴에 일어난 일**이다. 턴 번호를 따로 안 박아도 된다.
- **턴 전환 통로가 하나다.** `advanceTurn()`([room.ts:571](../cloudflare-v2/src/room.ts#L571))은
  [다음 턴] 버튼과 시간 초과 알람이 **둘 다** 지나가는 유일한 길이다.
- **화면 갱신 통로도 하나다.** `turnMessage()`([room.ts:328](../cloudflare-v2/src/room.ts#L328))가 턴이 바뀔 때
  전원에게, `stateMessage()`([room.ts:268](../cloudflare-v2/src/room.ts#L268))가 새로 붙은 사람에게 나간다.
- **누가 지금 문제를 푸는 중인지 알 수 있다.** `cellLocks`(칸번호 → playerId)가 이미 모든 메시지에 실려 있다.
  → "3명이 푸는 중"을 서버 변경 없이 셀 수 있다.
- **늦은 답이 다음 턴에 섞이지 않는다(확인함).** `requirePlayable()`은 마감 +2초까지 답을 받아 주지만,
  알람이 먼저 돌아 턴이 넘어갔으면 `me.team !== room.turn_team`에서 먼저 걸린다.
  **`captureFx()`를 `advanceTurn()` 맨 앞에 두면 그 시점까지 커밋된 답이 정확히 그 턴의 전부다.**

**없는 것 (이번에 만든다):**

1. **실제 효과 기록.** `bonus`(0 또는 2)와 `stolen`(칸 번호 또는 null)이 이벤트에 안 남는다. → F-001
2. **끝난 턴의 요약.** 턴이 넘어가는 순간 `last_turn_at`이 덮어써지므로,
   **넘어가기 직전에 계산해서 저장하지 않으면 영영 못 만든다.**
3. 3D 그림 8장. **이게 1단계다.**
4. 무대·빛·회전.

**함정 (설계에 반드시 반영):**

- ⚠ **`ensureSchema()`는 `CREATE TABLE IF NOT EXISTS` 뿐이다**([schema.ts](../cloudflare-v2/src/schema.ts)).
  이미 돌고 있는 방의 DO에는 **새 컬럼이 안 생긴다.** `room` 테이블에 `fx_h`, `fx_c` 같은 컬럼을 더하면
  **배포 직후 진행 중이던 방이 SQL 오류로 죽는다.** → 새 테이블은 안전하다. `fx` 테이블을 따로 판다.
- ⚠ **`renderAdmin()`은 보드를 통째로 다시 그린다**([app.js:210](../cloudflare-v2/public/app.js#L210) → `host.innerHTML = html`).
  학생이 한 문제 풀 때마다 `patch`가 와서 `render()`가 돈다. 한 턴에 스무 번도 돈다.
  → 3D를 `#admin-board` **안에** 넣으면 지워진다. `.board-wrap`의 **형제**로 둔다.
  → 더 중요한 것: 무대도 매번 `innerHTML`로 다시 만들면 **CSS 애니메이션이 그때마다 되감긴다.**
  수색 캐릭터가 계속 움찔거린다. **내용이 바뀔 때만 다시 만들고 평소엔 클래스만 토글한다.**
- ⚠ **`stateRev` 규칙.** 3D는 순수 연출이므로 **절대 `bump()`를 부르지 않는다.**
  턴이 바뀔 때 이미 도는 `bump()`에 얹혀 간다. 여기서 순번을 더 올리면 학생 전원이 `sync`로 몰린다.
- ⚠ **`_headers`가 모든 것에 `no-store`를 건다**([_headers](../cloudflare-v2/public/_headers)).
  지금 `/assets/treasure-island-bg.png`(2.1MB)도 매번 새로 받고 있다. 규칙이 **합쳐지므로**
  `/assets/*`를 덧붙이는 것만으로는 안 풀린다. → §2-10에서 통짜 규칙을 해체한다.
- ⚠ **청팀은 초록색이다.** `--C:#2f9e44`. 이름만 청팀이고 화면은 초록이다.
  **그림에도 빛에도 파란색을 쓰면 보드와 안 맞고, 배경이 바다(파랑)라 묻힌다.** 홍팀은 `--H:#e05a4f`.
- ⚠ **`APP_BUILD`와 `BUILD`는 항상 같이 올린다.** [app.js:30](../cloudflare-v2/public/app.js#L30) ↔
  [diagnose.ts:10](../cloudflare-v2/src/diagnose.ts#L10). 다르면 시스템 점검이 "옛 화면"이라고 잡는다.
  이번엔 **그림 URL의 `?v=`도 이 값을 쓴다.**
- ⚠ **`newGame()`이 `DELETE FROM events`를 한다**([room.ts:664](../cloudflare-v2/src/room.ts#L664)).
  `fx`도 같은 자리에서 지워야 지난 게임 결과가 새 판에 남지 않는다.
- ⚠ **판은 10×10 ~ 15×15다.** 15×15면 보드 폭이 750px이라 1366 화면에서는 좌우에 127px밖에 안 남는다.
  **뷰포트 폭으로 접기를 판정할 수 없다** → F-005. 실제 폭을 재야 한다.

### 1-5. 확정된 방향

| 결정 | 선택 | 근거 |
|---|---|---|
| 표시 화면 | **선생님 화면만** | 사용자 확정. 교실 TV가 유일하게 여백 있는 화면 |
| 수색 소품 | **보물탐지기 + 삽** | 사용자 확정. 보물섬 주제와 이어지고, 교실 프로젝터에 계속 떠 있는 그림이라는 점 고려 |
| 움직임 | **그림 1장 + CSS 변형** | 사용자 확정. 8장으로 끝나고 실패할 여지가 없다 |
| 결과 여러 종류 | **한 장씩 2.5초 회전** | 사용자 확정. 프로젝터에서 크게 보인다 |
| 그림 장수 | **8장** (4자세 × 2팀) | 팀 색이 게임의 뼈대다. CSS 색조 필터는 3D 렌더를 탁하게 만든다 |
| 8장 만드는 법 | **`search-H` 참조 원본 → 나머지 파생** | F-002. 텍스트만 같은 독립 생성은 매번 다른 사람을 그린다 |
| 연출 종류 | **6가지** (`treasure-bonus`/`treasure-claim`/`attack-steal`/`attack-claim`/`storm`/`normal`) | F-001+N-001. 효과가 없었으면 없었다고 말한다 |
| 효과 없는 T/A 그림 | **같은 그림, 제목만 다르게** | 그림을 12장으로 늘릴 만한 차이가 아니다. F-001의 열린 결정을 여기서 닫는다 |
| 턴 표시 | **차례인 팀 무대에 팀 색 빛 + 발밑 조명, 반대쪽은 채도 낮춤** | 신규 요구. 값은 플레이 예제에서 정한다 |
| 결과 유지 | **다음 자기 차례까지** | 사라지는 타이머가 없으면 버그도 없다 |
| 오답 | **표시 안 함** | 틀린 것을 교실 TV에 이름과 함께 띄우지 않는다 |
| 접기 판정 | **실제 남는 폭을 재서** (한쪽 200px 미만이면 접음) | F-005. 판 크기가 10×10~15×15로 변해서 뷰포트로는 못 정한다 |

**설계 원칙 1 — 3D 무대는 게임 상태를 읽기만 하는 순수 연출이다.**
점수·소유권·턴은 서버가 정한다. 무대는 그 결과를 다시 말할 뿐이다.
**그림이 하나도 없어도, 회전이 멈춰도, 게임은 아무 영향 없이 굴러가야 한다.**

**설계 원칙 2 — 연출은 정본이 실제로 바꾼 것만 말한다.**
+2를 안 줬으면 +2라고 쓰지 않는다. 빼앗은 땅이 없으면 빼앗았다고 하지 않는다.
이 원칙 하나 때문에 §2-4의 필드가 늘어난다. 그만한 값이 있다.

---

## 2. 개발 방법

### 2-1. 무엇을 건드리나

| 파일 | 변경 | 마이그레이션 |
|---|---|---|
| `public/assets/fx/*.webp` | **완료 8장.** 원본 PNG 는 `img/` 에 둔다 | — |
| `src/schema.ts` | `fx` 테이블 추가 (**새 테이블만. 컬럼 추가 금지**) | DO 내부, 자동 |
| `src/protocol.ts` | `LogEntry`에 `bonus`·`stolen`, `FxKind`·`TurnFx` 추가 | — |
| `src/room.ts` | `captureFx()`·`fxAll()`, `doAnswer` 이벤트 2필드, `advanceTurn`/`endGame`/`newGame` 각 한 줄, 두 메시지에 `turnFx` | — |
| `public/index.html` | `.board-stage`로 감싸고 `#fx-H`·`#fx-C`, 캐시버전 | — |
| `public/style.css` | `.fx*` 클래스·빛·키프레임·멀미 줄이기 | — |
| `public/app.js` | `APP_BUILD`, `renderFx()`, 회전 타이머, 미리받기, 접기 판정, `turn`에 `turnFx` | — |
| `public/_headers` | **통짜 `/*` 해체** + `/assets/*` 캐시 | — |
| `src/diagnose.ts` | `BUILD` 동시 갱신 + 그림 8장 점검 | — |
| `public/fx-preview.html` | **신규.** 그림 확인 + **빛 색 조절 도구** | — |
| `test/room.test.ts` | 분기 시험 (§3-2) | — |
| `tools/playtest.mjs` | 한 판 도는 김에 `turnFx` 대조 | — |
| `README.md` | 한 줄 | — |

D1 마이그레이션은 **없다.** 이 기능은 방 하나 안에서만 산다.

### 2-2. 1단계 — 3D 그림 만들기 (제일 먼저 한다)

**코드보다 이게 먼저다.** 스타일이 확정돼야 나머지를 뽑을 수 있다.

#### (a) 캐릭터 시트 — 8장 내내 고정할 문장

```
CHARACTER (keep identical in every image):
A cheerful 10-year-old treasure hunter kid, round friendly face, big expressive eyes,
wide-brim khaki explorer hat, short-sleeve khaki explorer shirt, brown shorts,
sturdy brown boots, small canvas backpack.
TEAM MARK: a large [COLOR] neck scarf and a [COLOR] band on the hat.
```

| 팀 | `[COLOR]` 자리 | 화면 색 |
|---|---|---|
| 홍팀 | `warm coral red (#e05a4f)` | `--H` |
| 청팀 | `fresh leaf green (#2f9e44)` | `--C` |

> **청팀은 초록이다.** 파랑으로 뽑으면 보드의 초록 땅과 따로 놀고, 배경이 바다라 묻힌다.

#### (b) 스타일 블록 — 1단계에서 A/B/C 중 하나로 확정

**"수색" 한 장만** 세 가지로 뽑아 고른다. 고른 것을 나머지 7장에 그대로 쓴다.

**A안 — 픽사풍 3D 카툰** *(기본 추천: 배경 그림·이모지와 가장 잘 붙는다)*
```
STYLE: Pixar-style 3D cartoon render, soft global illumination, warm rim light,
chunky rounded shapes, smooth matte surfaces, vivid saturated colors, playful and friendly.
```
**B안 — 클레이 스톱모션**
```
STYLE: claymation stop-motion 3D render, visible soft clay texture and fingerprints,
handcrafted miniature look, soft studio lighting, warm saturated colors.
```
**C안 — 미니어처 디오라마**
```
STYLE: tilt-shift miniature diorama 3D render, tiny handcrafted island set,
soft depth of field, bright midday sun, toy-like proportions.
```

**여덟 장 공통 규격** (스타일 뒤에 항상 붙인다)
```
FRAMING: single full-body character, centered, facing camera at a 3/4 angle,
head near the top edge, feet with a soft contact shadow near the bottom,
about 12% empty margin on all sides.
BACKGROUND: transparent. No text, no letters, no logos, no watermark, no frame, no border.
OUTPUT: square 1:1, 1024x1024, PNG with alpha.
```

> 투명 배경이 안 되면 **단색 `#fffdf5`**(카드 배경색 `--paper`)로 뽑는다.
> Midjourney면 끝에 `--ar 1:1 --style raw`.

#### (c) 8장을 같은 사람으로 만드는 법 (F-002)

**같은 문장을 여덟 번 붙이는 것으로는 안 된다.** 독립 생성은 모자 모양·얼굴·체형·배낭을 매번 다르게 그린다.
왼쪽 무대와 오른쪽 무대에 딴 사람이 서 있으면 연출이 통째로 싸구려가 된다.

**한 장을 원본으로 못 박고 나머지를 파생한다.**

```
① A/B/C 로 search-H 만 뽑는다 → 스타일 확정         ← 컨펌 1
② 확정된 search-H 를 **참조 원본**으로 고정한다 (파일 1장을 따로 보관)
③ search-H 를 참조로 넣고 "스카프와 모자 띠만 초록으로" → search-C   ← 컨펌 2 (두 팀 구별)
④ search-H 를 참조로 넣고 자세만 바꿔 treasure-H / storm-H / attack-H
⑤ 같은 방식으로 -C 세 장
⑥ 8장을 4×2 격자로 늘어놓고 얼굴·모자·옷·배낭·신발을 대조            ← 컨펌 3
```

②~⑤에서 쓸 참조 방법은 도구마다 이름이 다르다. **가장 강하게 잠기는 것을 쓴다.**

| 도구가 제공하면 | 쓰는 법 |
|---|---|
| 캐릭터 참조 / character reference | 원본을 참조로 넣고 자세 문장만 바꾼다 (가장 강함) |
| 이미지 편집 / image-to-image | 원본을 넣고 "자세만 바꿔라"로 지시 |
| seed 고정 | 같은 seed + 자세 문장만 교체 (약함, 얼굴이 흔들리면 위로 올라간다) |

> **도구는 아직 안 정했다.** 프롬프트는 도구를 안 가리게 썼다. 1단계-①이 끝나는 시점에
> 그 도구가 위 셋 중 무엇을 주는지 확인하고 ②의 방법을 확정한다.
> **7장을 다 뽑은 뒤에 틀린 걸 발견하는 것이 제일 비싸다.** 그래서 컨펌을 3번 끊는다.

#### (d) 상태별 프롬프트 — (a)+(b)에 이 문장 하나만 갈아 끼운다

| 파일 | 상태 | ACTION 문장 |
|---|---|---|
| `search-{H,C}.png` | 🔍 수색 | `ACTION: walking forward while sweeping a glowing metal detector over golden sand, a small shovel strapped on the backpack, eyes searching the ground, one foot mid-step, eager expression.` |
| `treasure-{H,C}.png` | 📦 보물 | `ACTION: kneeling behind an open wooden treasure chest, golden light bursting out and lighting the face from below, both arms thrown up in joy, gold coins floating in the air.` |
| `storm-{H,C}.png` | ⛈️ 폭풍 | `ACTION: caught in a comic tropical storm, leaning hard into the wind while hugging a bending palm tree, hat blown off and flying away, rain streaks and swirling leaves, funny surprised face (not scared, not sad).` |
| `attack-{H,C}.png` | 💥 공격 | `ACTION: triumphantly planting a [COLOR] flag into the sand with both hands while an enemy flag lies knocked over beside it, sand and sparks bursting at the base, victorious grin.` |

**공격은 "깃발 꽂기"다.** 게임에서 공격은 *상대 땅 한 칸을 빼앗는 것*이므로,
대포를 쏘는 그림보다 상대 깃발을 뽑고 내 깃발을 꽂는 그림이 규칙을 그대로 보여준다.
사람을 겨누는 장면도 안 나온다.

한국어 도구를 쓴다면 뜻만 옮기면 된다.

```
10살짜리 보물 사냥꾼 아이. 둥근 얼굴, 큰 눈, 챙 넓은 카키색 탐험가 모자,
카키색 반팔 셔츠, 갈색 반바지, 갈색 부츠, 작은 캔버스 배낭.
목에 [따뜻한 코랄 빨강 / 산뜻한 잎사귀 초록] 스카프, 모자에 같은 색 띠.
동작: 금빛 모래 위로 금속탐지기를 훑으며 걸어가는 중. 배낭에 작은 삽. 한 발은 떠 있음.
스타일: 픽사풍 3D 카툰 렌더, 부드러운 조명, 통통한 형태, 선명한 색.
구도: 전신 한 명, 가운데, 3/4 각도, 발밑에 그림자, 사방 여백 12%.
배경: 투명. 글자·로고·워터마크·테두리 없음. 정사각형 1024×1024 PNG.
```

#### (e) 파일 넣는 곳과 규격

생성 도구에서는 **PNG(투명)** 로 뽑고, 원본은 `img/` 에 남긴다.
배포용은 **WebP 로 변환**해서 넣는다 — 같은 1024px 해상도에서 6.5MB → 1.5MB 로 줄었다.

```
img/                                   ← 원본 PNG (보관)
  fx_search-H.png  fx_treasure-H.png  fx_storm-H.png  fx_attack-H.png
  fx_search-C.png  fx_treasure-C.png  fx_storm-C.png  fx_attack-C.png

cloudflare-v2/public/assets/fx/        ← 배포본 WebP
  search-H.webp   treasure-H.webp   storm-H.webp   attack-H.webp
  search-C.webp   treasure-C.webp   storm-C.webp   attack-C.webp
```

변환은 이 한 줄이다.

```bash
python3 -c "
from PIL import Image
for n in ['search-H','search-C','treasure-H','treasure-C','storm-H','storm-C','attack-H','attack-C']:
    Image.open(f'img/fx_{n}.png').convert('RGBA').save(
        f'cloudflare-v2/public/assets/fx/{n}.webp','WEBP',quality=92,method=4)
"
```

⚠ **청팀 그림은 좌우로 뒤집혀 있다.** 생성 도구는 여덟 장을 다 오른쪽을 보게 그리는데,
청팀 무대는 보드 **오른쪽**이라 그대로 두면 **화면 밖으로 걸어 나가는 그림**이 된다.
뒤집어야 두 팀이 보드를 향해 마주 본다. `img/fx_*-C.png` 원본 자체를 뒤집어 두었으므로
위 변환은 그대로 쓰면 되지만, **새로 뽑은 청팀 그림은 넣기 전에 한 번 뒤집는다.**

- 1024×1024, 알파 유지. **실측 130~243KB, 합계 1.5MB** (WebP q92). 목표(3MB)를 넉넉히 밑돈다.
- 화면에는 최대 420px로 줄여 나온다. 1024면 고해상도 TV에서도 충분하다.
- **이름은 코드가 그대로 조립한다**(`fx/${kind}-${team}.webp`). 대소문자·하이픈을 정확히.

### 2-3. 턴 표시 — 색과 조명 (신규 요구)

지금 누구 차례인지는 상단 바의 작은 `[홍팀]` 태그와 보드 위쪽 글자뿐이다. 교실 뒤에서는 안 보인다.
**무대 자체가 말하게 한다.**

세 가지를 같이 쓴다. 셋 다 값을 플레이 예제에서 돌려 보고 정한다(§2-11).

**① 배경 빛 (사용자 아이디어)** — 차례인 팀 무대에 팀 색이 은은하게 깔린다.

> **네모난 반투명 판이 아니라 둥근 빛으로 깐다.** 사각형 판을 덮으면 바다 배경 위에
> 경계선이 뚜렷한 네모가 생겨서 화면이 지저분해지고, 캐릭터의 그림자와도 부딪힌다.
> `radial-gradient`로 가운데가 밝고 가장자리로 사라지는 빛을 깔면 **무대 조명**처럼 읽히고
> 3D 그림을 건드리지 않는다. 사용자가 걱정한 "너무 붉으면 그림을 해친다"가 여기서 풀린다.

**② 발밑 조명** — 캐릭터 발밑에 팀 색 타원 빛. 무대에 서 있는 느낌을 주고,
배경 빛을 아주 옅게 줄여도 팀 색이 남는다. (①만으로 부족할 때의 보험)

**③ 차례가 아닌 쪽을 한 걸음 물린다** — 결과 카드의 채도를 낮춘다.
**색을 더하지 않고 대비를 만드는 방법**이라, 두 무대가 동시에 소리치는 것을 막는다.

조절할 값은 다섯 개다. `:root`에 변수로 두고, 플레이 예제가 이 다섯 개를 그대로 출력한다.

| 변수 | 뜻 | 초기값 |
|---|---|---|
| `--fx-tint-H` | 홍팀 빛 색 (RGB 채널) | `224 90 79` (`#e05a4f`) |
| `--fx-tint-C` | 청팀 빛 색 | `47 158 68` (`#2f9e44`) |
| `--fx-tint-alpha` | 배경 빛 진하기 | `.22` |
| `--fx-tint-size` | 빛이 퍼지는 반경 | `78%` |
| `--fx-rest` | 차례 아닌 쪽 채도 | `.55` |

> 색을 `#e05a4f`가 아니라 `224 90 79`로 두는 이유: `rgb(var(--fx-tint-H) / var(--fx-tint-alpha))`처럼
> **투명도를 따로 조절**할 수 있다. 색과 진하기를 각각 슬라이더로 만들려면 이 형태여야 한다.

**다른 아이디어 (추천 순)**

| 아이디어 | 무엇 | 판정 |
|---|---|---|
| **타이머를 무대 아래로 복제** | 남은 시간을 차례인 팀 무대 밑에 큰 숫자로. 지금 타이머는 상단 오른쪽에 있어 **어느 팀 시간인지 안 보인다** | **같이 넣기를 권함.** 색보다 강하게 "지금 너희 차례"를 말한다. 숫자는 이미 `updateTimer()`가 만든다 |
| **무대 테두리 맥박** | 무대 가장자리 팀 색 테두리가 숨 쉬듯 밝아지고, 남은 시간이 줄면 빨라진다 | 효과는 크지만 **시간이 급할 때 화면이 요란해진다.** 부록에 남긴다 |
| **보드 쪽 삼각형 포인터** | 무대에서 보드로 향하는 팀 색 삼각형 | 빛이 이미 방향을 주므로 겹친다. 안 넣는다 |
| **제목 앞 ▶ 깜빡임** | "▶ 홍팀 수색 중" | 값싸고 해롭지 않다. `.fx-title`에 넣는다 |

→ **채택: ① 배경 빛 + ② 발밑 조명 + ③ 반대쪽 채도 낮춤 + 타이머 복제 + ▶ 표시.**
전부 플레이 예제에서 껐다 켤 수 있게 만들어, 실제로 보고 뺄 것은 뺀다.

### 2-4. 서버 — 데이터 모델

#### (a) `fx` 테이블 (신규)

[schema.ts](../cloudflare-v2/src/schema.ts)의 `SCHEMA` 끝에 붙인다.

```sql
-- 방금 끝난 턴에 각 팀이 한 일. 팀당 한 행만 산다(덮어쓴다).
-- room 테이블에 컬럼을 더하지 않는 이유: ensureSchema 는 CREATE TABLE IF NOT EXISTS 뿐이라
-- 이미 돌고 있는 방의 DO 에는 새 컬럼이 안 생긴다. 새 테이블은 안전하다.
CREATE TABLE IF NOT EXISTS fx (
  team   TEXT PRIMARY KEY,   -- 'H' | 'C'
  detail TEXT NOT NULL,      -- TurnFx JSON
  at     INTEGER NOT NULL
);
```

#### (b) `LogEntry` 확장 — F-001

[protocol.ts:41](../cloudflare-v2/src/protocol.ts#L41)

```ts
export interface LogEntry {
  at: number;
  name: string;
  team: Team;
  cell: number;
  ok: boolean;
  gain: number;
  type: CellType;
  /** 실제로 받은 보물 보너스. 이미 그 팀이 받은 칸이면 0 이다. */
  bonus: number;
  /** 공격으로 실제 빼앗은 상대 칸. 빼앗을 땅이 없었으면 null. */
  stolen: number | null;
}
```

> `gain`(= 1 + bonus)에서 보너스를 역산할 수도 있지만 **`stolen`은 어디서도 역산할 수 없다.**
> 둘 다 명시해 두면 나중에 이 로그를 다른 데 쓸 때도 헷갈리지 않는다.

#### (c) 연출 종류와 `TurnFx` — N-001

```ts
/**
 * 무대에 올릴 연출 종류. **서버는 이 키만 정하고 한국어 문구·그림은 화면이 고른다.**
 * 문구를 다듬는다고 서버 프로토콜을 건드리지 않기 위해서다.
 */
export type FxKind =
  | "treasure-bonus"   // 📦 보물 +2 — 실제로 보너스를 받았다
  | "treasure-claim"   // 📦 보물칸이지만 그 팀이 이미 받은 칸이라 점령만 했다
  | "attack-steal"     // 💥 상대 땅을 실제로 빼앗았다
  | "attack-claim"     // 💥 공격칸인데 빼앗을 상대 땅이 없었다
  | "storm";           // ⛈️ 폭풍 — 다음 턴 쉼

export interface TurnFx {
  turnKey: string;   // "H:3" — 멱등 가드에도 쓴다
  round: number;
  /** 일반 칸을 차지한 사람 수. 이름은 안 쓴다(사용자 지정). */
  normal: number;
  /** 연출 종류 → 그 일을 한 사람들. 없는 종류는 키 자체가 없다. */
  names: Partial<Record<FxKind, string[]>>;
}
```

### 2-5. 서버 — `src/room.ts`

#### (a) `doAnswer` — 실제 효과를 이벤트에 남긴다

[room.ts:847](../cloudflare-v2/src/room.ts#L847). `bonus`와 `stolen`은 **이미 그 함수 안에 지역 변수로 있다.**
이벤트에 안 넣고 버리고 있을 뿐이다.

```ts
    this.addEvent("answer", me.id, cell, {
      at: Date.now(), name: me.name, team: me.team, cell, ok: correct, gain, type: target.type,
      bonus, stolen,          // ← 추가. 연출이 "실제로 일어난 일"만 말하게 하는 근거
    } satisfies LogEntry);
```

#### (b) 턴이 끝나는 순간 요약을 뜬다

`advanceTurn()`([room.ts:571](../cloudflare-v2/src/room.ts#L571))의 `this.clearAttempts();` **바로 위**:

```ts
    this.captureFx();      // ← last_turn_at 이 덮어써지기 전에 떠야 한다
    this.clearAttempts();
```

`endGame()`([room.ts:610](../cloudflare-v2/src/room.ts#L610))의 `this.clearAttempts();` 위에도 같은 한 줄.
[종료] 버튼은 `advanceTurn`을 안 거치므로, 없으면 **마지막 턴에 터진 보물이 사라진 채로 게임이 끝난다.**

> **F-004** — `advanceTurn()`은 라운드가 한계를 넘으면 스스로 `endGame()`을 부른다.
> 그래서 자동 종료 경로에서는 `captureFx()`가 **같은 턴에 두 번** 불린다.
> 지금 구조에서는 결과가 같아 문제가 안 보이지만, `captureFx()`를 **turnKey 기준 멱등**으로 만들어 둔다.
> 세 줄이면 되고, 나중에 여기에 순번이나 통계가 붙어도 안전하다.

`newGame()`의 `DELETE FROM events`([room.ts:664](../cloudflare-v2/src/room.ts#L664)) 바로 뒤:

```ts
    this.sql.exec("DELETE FROM fx");   // 지난 게임 결과가 새 판에 남으면 안 된다
```

#### (c) `captureFx()` · `fxAll()` — 새 메서드

`log()`([room.ts:205](../cloudflare-v2/src/room.ts#L205)) 옆에 둔다.

```ts
  /**
   * 이번 턴에 지금 차례 팀이 한 일을 fx 테이블에 남긴다.
   *
   * events.at >= room.last_turn_at 이 곧 "이번 턴"이다. 턴이 시작될 때 last_turn_at 을 새로 찍기
   * 때문이다(advanceTurn 끝의 UPDATE). 그래서 **턴이 넘어가기 직전에** 불러야 한다.
   * 넘어간 뒤에 부르면 그 경계가 이미 지워져 있다.
   *
   * 같은 턴을 두 번 부를 수 있다 — 라운드 한계로 advanceTurn 이 endGame 을 부르는 경로다.
   * turnKey 로 막는다.
   */
  private captureFx(): void {
    const room = this.needRoom();
    if (!room.turn_team || !room.last_turn_at) return; // 첫 [시작] 에는 직전 턴이 없다

    const key = turnKey(room.turn_team, room.round);
    const prev = this.sql
      .exec<{ detail: string }>("SELECT detail FROM fx WHERE team = ?", room.turn_team)
      .toArray()[0];
    if (prev && (JSON.parse(prev.detail) as TurnFx).turnKey === key) return; // 이미 떴다

    const done = this.sql
      .exec<{ detail: string }>(
        "SELECT detail FROM events WHERE kind = 'answer' AND at >= ? ORDER BY id",
        room.last_turn_at,
      )
      .toArray()
      .map((r) => JSON.parse(r.detail) as LogEntry)
      // 맞힌 것만 센다. 틀린 것을 교실 TV 에 이름과 함께 띄우지 않는다.
      .filter((e) => e.ok && e.team === room.turn_team);

    const names: Partial<Record<FxKind, string[]>> = {};
    const push = (kind: FxKind, name: string) => {
      const list = (names[kind] ??= []);
      if (!list.includes(name)) list.push(name); // 같은 사람이 두 번 나오지 않게
    };

    let normal = 0;
    for (const e of done) {
      // 정본이 실제로 바꾼 것만 말한다. bonus 가 0 이면 +2 라고 하지 않고,
      // stolen 이 null 이면 빼앗았다고 하지 않는다.
      if (e.type === "T") push(e.bonus > 0 ? "treasure-bonus" : "treasure-claim", e.name);
      else if (e.type === "A") push(e.stolen !== null ? "attack-steal" : "attack-claim", e.name);
      else if (e.type === "S") push("storm", e.name);
      else normal++;
    }

    const fx: TurnFx = { turnKey: key, round: room.round, normal, names };
    this.sql.exec(
      `INSERT INTO fx (team, detail, at) VALUES (?, ?, ?)
         ON CONFLICT(team) DO UPDATE SET detail = excluded.detail, at = excluded.at`,
      room.turn_team, JSON.stringify(fx), Date.now(),
    );
  }

  private fxAll(): { H: TurnFx | null; C: TurnFx | null } {
    const out: { H: TurnFx | null; C: TurnFx | null } = { H: null, C: null };
    for (const r of this.sql.exec<{ team: Team; detail: string }>("SELECT team, detail FROM fx").toArray()) {
      out[r.team] = JSON.parse(r.detail) as TurnFx;
    }
    return out;
  }
```

`import` 에 `FxKind`, `TurnFx` 를 더한다.

> **옛 이벤트 방어.** 배포 순간 진행 중이던 방에는 `bonus`·`stolen`이 없는 이벤트가 남아 있다.
> `e.bonus > 0`은 `undefined > 0` → `false`, `e.stolen !== null`은 `undefined !== null` → `true`가 된다.
> 즉 **보물은 "점령만"으로, 공격은 "빼앗음"으로** 읽힌다. 한 턴짜리 오차이고 수업 중 배포는 안 하지만,
> 정확히 하려면 `e.stolen ?? null` 로 받는다. 위 코드에 그렇게 쓰지 않은 이유가 없으므로 그렇게 쓴다.
> → `else if (e.type === "A") push((e.stolen ?? null) !== null ? "attack-steal" : "attack-claim", e.name);`

#### (d) 메시지에 얹는다

`stateMessage()`([room.ts:268](../cloudflare-v2/src/room.ts#L268))의 `maxPlayers` 줄 옆, 그리고
`turnMessage()`([room.ts:328](../cloudflare-v2/src/room.ts#L328))의 `cellLocks` 옆에:

```ts
      turnFx: this.fxAll(),
```

> **학생에게도 그냥 보낸다.** `turnMessage()`는 한 번 만들어 전원에게 뿌리는 구조라,
> 선생님만 골라 보내려면 소켓마다 따로 만들어야 한다. 실을 것은 이름 몇 개와 숫자뿐(200바이트 안팎)이고
> 학생 화면은 이 값을 아예 안 읽는다. **연출 하나 때문에 방송 경로를 복잡하게 만들지 않는다.**

> **`bump()`는 절대 부르지 않는다.** 3D는 정본이 아니다. 턴이 바뀔 때 이미 도는 `bump()`에 얹혀 간다.

> **`patchMessage()`에는 넣지 않는다.** 학생이 한 문제 풀 때마다 전원에게 나가므로 낭비고,
> 무엇보다 **턴 도중에 결과가 미리 바뀌면 안 된다.**

### 2-6. 화면 — HTML (`public/index.html`)

선생님 게임 화면(`#admin-screen`)의 `.board-wrap`을 3칸 무대로 감싼다.

```html
        <div class="board-stage" id="board-stage">
          <div class="fx" id="fx-H" data-team="H"></div>
          <div class="board-wrap"><div id="admin-board" class="board"></div></div>
          <div class="fx" id="fx-C" data-team="C"></div>
        </div>
```

`<head>`의 캐시버전 3곳을 **`APP_BUILD`와 같은 값**으로 바꾼다(F-003).

```html
<link rel="stylesheet" href="/style.css?v=2026-08-10a">
<script src="/net.js?v=2026-08-10a" defer></script>
<script src="/app.js?v=2026-08-10a" defer></script>
```

### 2-7. 화면 — CSS (`style.css` 끝에 추가)

```css
/* ── 3D 팀 무대 ─────────────────────────────────────────────────────────── */
:root{
  /* 지금 차례인 팀 무대에 깔리는 빛. 값은 fx-preview.html 에서 정해 여기에 박는다. */
  --fx-tint-H:224 90 79;    /* #e05a4f */
  --fx-tint-C:47 158 68;    /* #2f9e44 — 청팀은 초록이다 */
  --fx-tint-alpha:.22;      /* 배경 빛 진하기 */
  --fx-tint-size:78%;       /* 빛이 퍼지는 반경 */
  --fx-glow:.55;            /* 발밑 조명 세기 */
  --fx-rest:.55;            /* 차례가 아닌 쪽 채도 */
}

/* 보드는 가운데(auto), 좌우는 남는 만큼. 무대를 접으면 .board-stage 에서 wide 가 빠진다. */
.board-stage{display:block}
.board-stage .fx{display:none}
.board-stage.wide{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);
  gap:10px;align-items:stretch}
.board-stage.wide .fx{display:flex}

.fx{position:relative;min-width:0;min-height:0;flex-direction:column;
  align-items:center;justify-content:center}
.fx[data-team="H"]{--tint:var(--fx-tint-H)}
.fx[data-team="C"]{--tint:var(--fx-tint-C)}

/* ① 배경 빛 — 네모난 판이 아니라 둥근 빛이다. 사각형을 덮으면 바다 배경 위에
   경계선이 생기고 캐릭터 그림자와 부딪힌다. */
.fx::before{content:"";position:absolute;inset:-6px;border-radius:26px;z-index:0;
  opacity:0;transition:opacity .6s ease;pointer-events:none;
  background:radial-gradient(closest-side circle at 50% 58%,
    rgb(var(--tint) / var(--fx-tint-alpha)) 0%,
    rgb(var(--tint) / 0) var(--fx-tint-size))}
/* ② 발밑 조명 — 무대에 서 있는 느낌. 배경 빛을 아주 옅게 줘도 팀 색이 남는다. */
.fx::after{content:"";position:absolute;left:50%;bottom:78px;transform:translateX(-50%);
  width:56%;height:34px;border-radius:50%;z-index:0;filter:blur(3px);
  opacity:0;transition:opacity .6s ease;pointer-events:none;
  background:radial-gradient(ellipse, rgb(var(--tint) / var(--fx-glow)) 0%, rgb(var(--tint) / 0) 70%)}
.fx.turn::before,.fx.turn::after{opacity:1}
/* ③ 차례가 아닌 쪽은 한 걸음 물린다. 색을 더하지 않고 대비를 만든다. */
.fx:not(.turn) .fx-card{filter:saturate(var(--fx-rest))}

/* 카드는 겹쳐 두고 .on 만 보인다. 회전할 때 그림이 다시 로딩되지 않는다. */
.fx-card{position:absolute;inset:0;z-index:1;display:flex;flex-direction:column;
  align-items:center;justify-content:center;
  opacity:0;transform:scale(.96);transition:opacity .45s,transform .45s;pointer-events:none}
.fx-card.on{opacity:1;transform:scale(1)}
/* 세로도 잘리면 안 된다. 제목·이름·타이머 자리를 빼고 남는 만큼만 그림에 준다. */
.fx-card img{width:min(100%,420px);max-height:calc(100% - 132px);object-fit:contain;
  filter:drop-shadow(0 12px 18px #12384f55)}
.fx-fallback{font-size:clamp(60px,9vw,120px);line-height:1;filter:drop-shadow(0 10px 14px #12384f55)}

.fx-title{margin-top:6px;font-size:clamp(16px,1.5vw,26px);font-weight:900;color:#fff;
  background:#12384fcc;border-radius:12px;padding:6px 16px;text-align:center;z-index:1}
.fx-names{margin-top:6px;font-size:clamp(13px,1.1vw,20px);font-weight:800;color:#fff;
  background:#12384f99;border-radius:10px;padding:4px 13px;text-align:center;
  max-width:100%;overflow:hidden;text-overflow:ellipsis;z-index:1}
.fx[data-team="H"] .fx-title{background:#b53a30ee}
.fx[data-team="C"] .fx-title{background:#227a34ee}
/* 남은 시간을 차례인 팀 밑에 크게 복제한다. 상단 타이머는 어느 팀 것인지 안 보인다. */
.fx-clock{position:absolute;bottom:6px;z-index:1;font-size:clamp(26px,2.6vw,44px);
  font-weight:900;color:#fff;text-shadow:0 3px 10px #0b2f45;display:none}
.fx.turn .fx-clock{display:block}
.fx-lead{animation:fx-blink 1.4s ease-in-out infinite}
@keyframes fx-blink{50%{opacity:.25}}

/* 몇 장짜리인지 알려 주는 점. 한 장뿐이면 안 그린다. */
.fx-dots{position:absolute;bottom:2px;display:flex;gap:6px;z-index:1}
.fx-dots i{width:8px;height:8px;border-radius:50%;background:#ffffff70}
.fx-dots i.on{background:#fff}

/* 수색 중 — 걸어가며 훑는 느낌. 그림 1장으로 만든다. */
.fx-card.searching img{animation:fx-search 2.6s ease-in-out infinite}
@keyframes fx-search{
  0%,100%{transform:translate(-9px,0) rotate(-1.6deg)}
  25%,75%{transform:translate(0,-11px) rotate(0deg)}
  50%    {transform:translate(9px,0)  rotate(1.6deg)}
}
/* 결과가 올라올 때 한 번 통 튄다. */
.fx-card.pop img{animation:fx-pop .55s cubic-bezier(.2,1.5,.4,1) 1}
@keyframes fx-pop{0%{transform:scale(.7)}60%{transform:scale(1.07)}100%{transform:scale(1)}}
/* 차례를 기다리는 중 / 이번 턴 성과 없음 */
.fx-card.dim img,.fx-card.dim .fx-fallback{filter:grayscale(.7) opacity(.45)}

/* 아주 좁으면 안전망. 평소 접기는 JS 가 실제 폭을 재서 한다(§2-8). */
@media(max-width:1100px){.board-stage.wide{display:block}.board-stage.wide .fx{display:none}}

/* 멀미 줄이기 — 움직임을 멈추는 대신 **정보를 잃지 않게** 세로로 전부 펼친다.
   첫 카드만 남기면 보물을 열었다는 사실을 못 보고 지나간다. */
@media(prefers-reduced-motion:reduce){
  .fx{justify-content:flex-start;overflow:auto}
  .fx-card{position:relative;inset:auto;opacity:1;transform:none;transition:none}
  .fx-card img{max-height:22vh;animation:none}
  .fx-card.searching img,.fx-card.pop img{animation:none}
  .fx-lead{animation:none}
  .fx-dots{display:none}
  .fx::before,.fx::after{transition:none}
}
```

### 2-8. 화면 — `public/app.js`

`APP_BUILD`를 올린다(예: `"2026-08-10a"`). `index.html`의 `?v=`, `diagnose.ts`의 `BUILD`도 **같은 값**이다.

```js
// ── 3D 팀 무대 ───────────────────────────────────────────────────────────────
// 규칙 두 개.
//  · **내용이 바뀔 때만** DOM 을 다시 만든다. 매 render 마다 다시 만들면 patch 가 올 때마다
//    수색 애니메이션이 처음으로 되감겨 움찔거린다(한 턴에 스무 번도 온다).
//  · 무대를 펼칠지는 **실제 남는 폭을 재서** 정한다. 판이 10×10~15×15 라 보드 폭이 609~750px 로
//    변하고, 그래서 뷰포트 폭만으로는 판정이 안 된다.
const FX_KIND = {
  "treasure-bonus": { img: "treasure", title: "📦 보물을 열었다! +2" },
  "treasure-claim": { img: "treasure", title: "📦 보물칸을 점령했다" },
  "attack-steal":   { img: "attack",   title: "💥 상대 땅을 빼앗았다!" },
  "attack-claim":   { img: "attack",   title: "💥 공격 거점을 점령했다" },
  "storm":          { img: "storm",    title: "⛈️ 폭풍에 갇혔다 — 다음 턴 쉼" },
};
const FX_ORDER = ["treasure-bonus", "attack-steal", "treasure-claim", "attack-claim", "storm"];
const FX_EMOJI = { search: "🔍", treasure: "📦", storm: "⛈️", attack: "💥" };
const FX_MIN_SIDE = 200; // 한쪽에 이만큼도 안 남으면 접는다
const FX_FILES = [];
for (const k of ["search", "treasure", "storm", "attack"]) for (const t of ["H", "C"]) FX_FILES.push(fxSrc(k, t));
const FX = { H: { sig: "", i: 0, n: 1 }, C: { sig: "", i: 0, n: 1 } };
const fxCalm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** 그림 URL. 배포 버전을 붙여야 그림을 고쳐 올렸을 때 옛 그림이 안 남는다(F-003). */
function fxSrc(kind, team) { return `/assets/fx/${kind}-${team}.webp?v=${APP_BUILD}`; }

function fxImg(kind, team) {
  // 그림이 없어도 수업은 굴러가야 한다. 못 받으면 큰 이모지로 대신한다.
  return `<img src="${fxSrc(kind, team)}" alt=""
    onerror="this.outerHTML='<div class=\\'fx-fallback\\'>${FX_EMOJI[kind]}</div>'">`;
}

/** 이번 턴 요약 → 보여줄 카드 목록. 배열 순서가 곧 회전 순서다. */
function fxCards(fx) {
  const out = [];
  for (const kind of FX_ORDER) {
    const names = fx.names?.[kind];
    if (!names || !names.length) continue;
    const shown = names.slice(0, 6).join(" · ") + (names.length > 6 ? ` 외 ${names.length - 6}명` : "");
    out.push({ kind: FX_KIND[kind].img, title: FX_KIND[kind].title, names: shown });
  }
  if (fx.normal > 0) out.push({ kind: "search", title: `🚩 ${fx.normal}명이 땅을 넓혔다`, names: "" });
  if (!out.length) out.push({ kind: "search", title: "이번 턴엔 아무도 못 했어요", names: "", dim: true });
  return out;
}

/** 무대를 펼칠 자리가 있는지 실제로 잰다. 보드가 그려진 뒤에 부른다. */
function fxFits() {
  const stage = $("board-stage"), board = $("admin-board");
  if (!stage || !board) return false;
  // clientWidth 는 무대가 접혀 있을 때도 본문 폭 그대로다.
  const free = (stage.clientWidth - board.offsetWidth - 20) / 2; // 20 = 좌우 gap
  return free >= FX_MIN_SIDE;
}

function renderFx() {
  const st = APP.state;
  if (!st) return;
  const stage = $("board-stage");
  stage.classList.toggle("wide", fxFits());
  if (!stage.classList.contains("wide")) return; // 접혀 있으면 그릴 필요도 없다

  const solving = new Set(Object.values(st.cellLocks || {}));
  for (const team of ["H", "C"]) {
    const host = $(`fx-${team}`);
    const myTurn = st.status === "running" && st.turnTeam === team;
    host.classList.toggle("turn", myTurn);

    let cards;
    if (myTurn) {
      const n = st.players.filter((p) => p.team === team && solving.has(p.id)).length;
      cards = [{ kind: "search", searching: true,
                 title: `▶ ${team === "H" ? "홍팀" : "청팀"} 수색 중`,
                 names: n ? `${n}명이 문제를 푸는 중` : "" }];
    } else {
      const fx = st.turnFx?.[team];
      cards = fx ? fxCards(fx) : [{ kind: "search", title: "차례를 기다리는 중", names: "", dim: true }];
    }

    // 서명이 같으면 DOM 을 건드리지 않는다 — 애니메이션이 이어진다.
    const sig = `${st.status}|${st.turnTeam}|${cards.map((c) => c.kind + c.title + c.names).join("~")}`;
    if (FX[team].sig === sig) continue;
    FX[team].sig = sig;
    FX[team].i = 0;
    FX[team].n = cards.length;
    host.innerHTML =
      cards.map((c, i) => `<div class="fx-card ${i === 0 ? "on" : ""} ${c.searching ? "searching" : "pop"} ${c.dim ? "dim" : ""}">
          ${fxImg(c.kind, team)}
          <div class="fx-title${c.searching ? " fx-lead" : ""}">${esc(c.title)}</div>
          ${c.names ? `<div class="fx-names">${esc(c.names)}</div>` : ""}
        </div>`).join("")
      + `<div class="fx-clock" id="fx-clock-${team}"></div>`
      + (cards.length > 1 && !fxCalm()
          ? `<div class="fx-dots">${cards.map((_, i) => `<i class="${i === 0 ? "on" : ""}"></i>`).join("")}</div>`
          : "");
  }
}

// 2.5초마다 다음 카드. 한 장뿐이거나 멀미 줄이기면 안 돈다(멀미 줄이기에서는 CSS 가 전부 펼친다).
setInterval(() => {
  if (APP.role !== "teacher" || fxCalm()) return;
  for (const team of ["H", "C"]) {
    if (FX[team].n < 2) continue;
    const host = $(`fx-${team}`);
    if (!host) continue;
    FX[team].i = (FX[team].i + 1) % FX[team].n;
    host.querySelectorAll(".fx-card").forEach((el, i) => el.classList.toggle("on", i === FX[team].i));
    host.querySelectorAll(".fx-dots i").forEach((el, i) => el.classList.toggle("on", i === FX[team].i));
  }
}, 2500);
```

**세 곳에 한 줄씩 더 넣는다.**

```js
// ① renderAdmin() 끝 (renderLog("a-log"); 다음)
  renderFx();

// ② updateTimer() — 남은 시간을 차례인 팀 무대에도 크게 복제한다
  if (APP.role === "teacher") {
    const el2 = $(`fx-clock-${APP.state.turnTeam}`);
    if (el2) el2.textContent = text;
  }

// ③ enterAsTeacher() 첫 줄 — 미리 받아 두지 않으면 첫 턴이 끝나는 순간 빈 칸이 잠깐 보인다
  for (const src of FX_FILES) { const im = new Image(); im.src = src; }
```

`turn` 메시지 처리([app.js:282](../cloudflare-v2/public/app.js#L282))의 `Object.assign`에 `turnFx`를 더한다.
**이걸 빼먹으면 첫 접속 때만 3D가 맞고 그 뒤로는 영영 안 바뀐다.**

```js
      Object.assign(APP.state, {
        status: msg.status, round: msg.round, turnTeam: msg.turnTeam,
        turnEndsAt: msg.turnEndsAt, players: msg.players, cellLocks: msg.cellLocks,
        turnFx: msg.turnFx,                     // ← 추가
      });
```

창 크기가 바뀌면 접기 판정을 다시 한다. `renderBoard`가 칸 크기를 다시 재는 것과 짝이다.

```js
addEventListener("resize", () => { if (APP.role === "teacher") render(); });
```

> **왜 컨테이너 쿼리가 아닌가 (F-005 divergence).** 검토의 지적은 맞다 — 뷰포트 1200px으로는 못 정한다.
> 다만 컨테이너 쿼리를 써도 **경계값을 판 크기별로 따로 써야 한다.** 보드 폭은 CSS가 모르고
> `renderBoard()`가 `cols`와 `--cell`로 계산하기 때문이다(10×10이면 609px, 15×15면 750px).
> 이미 그 자리에서 재고 있으므로 **`offsetWidth` 한 번 읽는 쪽이 정확하고 짧다.**
> CSS `max-width:1100px` 규칙은 JS가 죽어도 화면이 안 깨지도록 안전망으로 남긴다.

### 2-9. `src/diagnose.ts`

`BUILD`를 `APP_BUILD`와 **같은 값**으로 올리고, 점검 하나를 더한다.
수업 직전 [🩺 시스템 점검]에서 8장이 다 올라갔는지 확인할 수 있어야 한다.

```ts
  // 3D 그림 — 배포에서 빠지면 화면이 이모지로 떨어진다. 수업 전에 알 수 있어야 한다.
  const missing: string[] = [];
  for (const k of ["search", "treasure", "storm", "attack"]) {
    for (const t of ["H", "C"]) {
      const res = await env.ASSETS.fetch(new URL(`/assets/fx/${k}-${t}.webp`, request.url));
      if (!res.ok) missing.push(`${k}-${t}`);
    }
  }
  missing.length
    ? add("3D 그림", "warn", `${missing.length}장이 없습니다 (${missing.join(", ")}). 이모지로 대신 나옵니다.`)
    : add("3D 그림", "ok", "8장 모두 정상");
```

`add(name, level, detail, fix?)`는 [diagnose.ts:24](../cloudflare-v2/src/diagnose.ts#L24)에 이미 있다.

### 2-10. `public/_headers` — 통짜 규칙을 해체한다 (F-003)

지금 `/*`가 모든 것에 `no-store`를 건다. **여러 규칙이 매칭되면 헤더가 합쳐지므로**
`/assets/*`를 덧붙이는 것만으로는 `no-store`가 안 사라진다. 파일을 이렇게 바꾼다.

```
/
  Cache-Control: no-cache, no-store, must-revalidate

/index.html
  Cache-Control: no-cache, no-store, must-revalidate

/app.js
  Cache-Control: no-cache, no-store, must-revalidate

/net.js
  Cache-Control: no-cache, no-store, must-revalidate

/style.css
  Cache-Control: no-cache, no-store, must-revalidate

/fx-preview.html
  Cache-Control: no-cache, no-store, must-revalidate

/assets/*
  Cache-Control: public, max-age=604800
```

- **`immutable`은 안 쓴다.** 이름이 `search-H.webp`로 고정이라, `immutable`을 주면 그림을 고쳐 올려도
  일주일간 옛 그림이 남는 브라우저가 생긴다. 되돌릴 길을 남긴다.
- 대신 **URL에 `?v=APP_BUILD`를 붙인다**(§2-8 `fxSrc`). 배포 버전이 올라가면 URL이 바뀌어 새로 받는다.
- `sample-quiz.csv`는 캐시돼도 무해하다(내용이 바뀌면 배포 때 함께 나간다).

배포 뒤 확인한다.

```bash
B=https://treasure-island-v2.ds1lph.workers.dev
curl -sI $B/assets/fx/search-H.webp | grep -i cache-control   # public, max-age=604800
curl -sI $B/app.js                 | grep -i cache-control   # no-store
```

### 2-11. `public/fx-preview.html` — 그림 확인 + 빛 색 조절 도구

**이 페이지가 1단계 컨펌 도구이자 §2-3의 색을 정하는 자리다.** 백엔드가 필요 없다.

할 수 있어야 하는 것:

1. 무대 두 개를 실제 모양으로 띄운다 — 왼쪽은 수색(차례), 오른쪽은 결과. **좌우 바꾸기** 버튼.
2. **홍/청 빛 색**을 색 선택기로, **진하기·퍼짐·발밑 조명·반대쪽 채도**를 슬라이더로 조절.
3. **화면 폭 흉내** 1100 / 1366 / 1600 / 1920 — 접기 경계를 눈으로 본다.
4. **멀미 줄이기** 토글 — 카드가 세로로 펼쳐지는지 본다.
5. **8장 격자** — 얼굴·옷 대조용(F-002 컨펌 3).
6. **CSS 복사** — 정한 값을 `style.css`의 `:root`에 그대로 붙일 수 있게 출력.

```html
<!doctype html><meta charset="utf-8"><title>3D 무대 확인</title>
<link rel="stylesheet" href="/style.css">
<style>
  body{background:url('/assets/treasure-island-bg.png') center/cover fixed,#348fc0;margin:0}
  .tools{position:sticky;top:0;z-index:9;display:flex;flex-wrap:wrap;gap:14px;align-items:center;
    padding:10px 14px;background:#12384fe8;color:#fff;font:13px "Noto Sans KR",sans-serif}
  .tools label{display:flex;gap:6px;align-items:center;white-space:nowrap}
  .tools input[type=range]{width:110px}
  .frame{margin:16px auto;background:#fffdf5ec;border-radius:13px;padding:13px}
  pre{margin:16px;padding:12px;background:#12384fe8;color:#9ff;border-radius:10px;font-size:12px;overflow:auto}
  .grid{display:flex;flex-wrap:wrap;gap:14px;padding:16px}
  .grid figure{margin:0;text-align:center;color:#fff;font-weight:800}
  .grid img{width:220px;filter:drop-shadow(0 10px 14px #12384f55)}
</style>

<div class="tools">
  <label>홍 <input type="color" id="cH" value="#e05a4f"></label>
  <label>청 <input type="color" id="cC" value="#2f9e44"></label>
  <label>진하기 <input type="range" id="alpha" min="0" max="50" value="22"><b id="vAlpha"></b></label>
  <label>퍼짐 <input type="range" id="size" min="40" max="100" value="78"><b id="vSize"></b></label>
  <label>발밑 <input type="range" id="glow" min="0" max="100" value="55"><b id="vGlow"></b></label>
  <label>반대쪽 채도 <input type="range" id="rest" min="0" max="100" value="55"><b id="vRest"></b></label>
  <label>폭
    <select id="width"><option>1100</option><option>1366</option><option>1600</option><option selected>1920</option></select>
  </label>
  <label><input type="checkbox" id="calm"> 멀미 줄이기</label>
  <button class="button muted" id="swap">좌우 바꾸기</button>
  <button class="button primary" id="copy">CSS 복사</button>
</div>

<div class="frame" id="frame">
  <div class="board-stage wide" id="stage">
    <div class="fx turn" data-team="H" id="sH"></div>
    <div class="board-wrap"><div class="board" id="fakeboard"></div></div>
    <div class="fx" data-team="C" id="sC"></div>
  </div>
</div>

<pre id="out"></pre>
<div class="grid" id="all"></div>

<script>
const $=id=>document.getElementById(id);
const hex2rgb=h=>[1,3,5].map(i=>parseInt(h.slice(i,i+2),16)).join(" ");
const card=(kind,team,title,names,cls="")=>`<div class="fx-card on ${cls}">
  <img src="/assets/fx/${kind}-${team}.webp?t=${Date.now()}"
       onerror="this.outerHTML='<div class=\\'fx-fallback\\'>🔍</div>'">
  <div class="fx-title">${title}</div>${names?`<div class="fx-names">${names}</div>`:""}</div>`;

let flip=false;
function paint(){
  const r=document.documentElement.style;
  r.setProperty("--fx-tint-H",hex2rgb($("cH").value));
  r.setProperty("--fx-tint-C",hex2rgb($("cC").value));
  r.setProperty("--fx-tint-alpha",($("alpha").value/100).toFixed(2));
  r.setProperty("--fx-tint-size",$("size").value+"%");
  r.setProperty("--fx-glow",($("glow").value/100).toFixed(2));
  r.setProperty("--fx-rest",($("rest").value/100).toFixed(2));
  $("vAlpha").textContent=($("alpha").value/100).toFixed(2);
  $("vSize").textContent=$("size").value+"%";
  $("vGlow").textContent=($("glow").value/100).toFixed(2);
  $("vRest").textContent=($("rest").value/100).toFixed(2);

  // 차례인 쪽 = 수색, 반대쪽 = 결과 두 장
  const turn=flip?"C":"H", rest=flip?"H":"C";
  $("s"+turn).className="fx turn"; $("s"+rest).className="fx";
  $("s"+turn).innerHTML=card("search",turn,"▶ "+(turn==="H"?"홍팀":"청팀")+" 수색 중","3명이 문제를 푸는 중","searching")
    +`<div class="fx-clock">00:42</div>`;
  $("s"+rest).innerHTML=card("treasure",rest,"📦 보물을 열었다! +2","민수 · 영희")
    +card("attack",rest,"💥 상대 땅을 빼앗았다!","철수").replace("on ","");

  $("frame").style.maxWidth=($("width").value-312)+"px";   // 사이드바·여백을 뺀 본문 폭
  $("fakeboard").style.cssText="width:609px;height:609px;background:#f5d9a0aa;border-radius:6px";
  document.body.style.setProperty("--calm",$("calm").checked?1:0);
  $("out").textContent=`:root{
  --fx-tint-H:${hex2rgb($("cH").value)};
  --fx-tint-C:${hex2rgb($("cC").value)};
  --fx-tint-alpha:${($("alpha").value/100).toFixed(2)};
  --fx-tint-size:${$("size").value}%;
  --fx-glow:${($("glow").value/100).toFixed(2)};
  --fx-rest:${($("rest").value/100).toFixed(2)};
}`;
  localStorage.setItem("fxtune",$("out").textContent);
}
for(const el of document.querySelectorAll(".tools input,.tools select")) el.addEventListener("input",paint);
$("swap").onclick=()=>{flip=!flip;paint()};
$("copy").onclick=()=>navigator.clipboard.writeText($("out").textContent);
$("all").innerHTML=["H","C"].flatMap(t=>["search","treasure","storm","attack"]
  .map(k=>`<figure><img src="/assets/fx/${k}-${t}.webp?t=${Date.now()}"><figcaption>${k}-${t}</figcaption></figure>`)).join("");
paint();
</script>
```

> 멀미 줄이기 토글은 OS 설정을 흉내 내는 것이라 `@media`가 반응하지 않는다.
> 실제 확인은 OS/브라우저의 "동작 줄이기"를 켜고 본다. 이 토글은 **레이아웃이 세로로 펼쳐지는지**만 눈으로 보는 용도다.

### 2-12. 변경 파일 체크리스트

```
1단계 (그림) — ✅ 2026-08-10 완료
  [x] search-H 를 A/B/C 로 뽑아 스타일 확정 (A안: 픽사풍 3D 카툰)
  [x] search-C 파생 → 두 팀 구별 확인
  [x] treasure/storm/attack × H,C 6장 파생
  [x] 8장 대조 — 같은 캐릭터 · 팀 색 정확 · 세로 91~96% · 투명 배경
  [x] WebP 변환 → public/assets/fx/ 배치 (합계 1.5MB)
  [ ] 빛 값 결정 — fx-preview.html 을 만든 뒤에 한다(3단계로 넘어감)

2단계 (서버)
  [ ] src/schema.ts       fx 테이블 (새 테이블만, 컬럼 추가 금지)
  [ ] src/protocol.ts     LogEntry.bonus/stolen · FxKind · TurnFx
  [ ] src/room.ts         doAnswer 이벤트 2필드 · captureFx(멱등) · fxAll
                          advanceTurn/endGame/newGame 각 한 줄 · 두 메시지에 turnFx
  [ ] test/room.test.ts   §3-2 분기 전부
  [ ] tools/playtest.mjs  턴마다 turnFx 대조

3단계 (화면)
  [ ] public/index.html   .board-stage · #fx-H · #fx-C · ?v=APP_BUILD
  [ ] public/style.css    :root 빛 변수 · .fx* · 키프레임 · 멀미 줄이기
  [ ] public/app.js       APP_BUILD · FX_KIND 사전 · renderFx · fxFits · 회전 · 미리받기
                          updateTimer 복제 · turn 에 turnFx · resize
  [ ] public/_headers     통짜 /* 해체 + /assets/*
  [ ] src/diagnose.ts     BUILD(=APP_BUILD) · 그림 8장 점검
  [ ] public/fx-preview.html
  [ ] README.md
```

---

## 3. 테스트 방법

### 3-1. 준비

```bash
cd cloudflare-v2
npm install
cp .dev.vars.example .dev.vars     # SIGNUP_CODE 를 정한다
npm run db:local
npm run dev                        # http://localhost:8787
```

### 3-2. 1단계 — 그림과 빛 (코드 없이)

`http://localhost:8787/fx-preview.html`

| 확인 | 기준 |
|---|---|
| 8장이 같은 사람인가 | 얼굴·모자·셔츠·배낭·신발을 하나씩 대조. 하나라도 다르면 그 장을 다시 뽑는다 |
| 홍/청이 멀리서 구별되는가 | 교실 TV에 띄우고 뒤에서 본다 |
| 네 자세가 글자 없이 구별되는가 | 탐지기 / 상자 / 비바람 / 깃발 |
| 배경이 투명한가 | 흰 사각형이 보이면 다시 뽑는다 |
| **빛이 그림을 해치지 않는가** | 진하기를 0부터 올리며 캐릭터 색이 탁해지기 직전에서 멈춘다 |
| **차례인 쪽이 한눈에 보이는가** | 좌우 바꾸기를 눌러 시선이 따라가는지 본다 |
| 폭 1100에서 | 무대가 접히고 보드만 남는가 |
| 멀미 줄이기 | 카드가 세로로 전부 펼쳐지는가 |
| 용량 | `du -h public/assets/fx/*` |

정한 값은 [CSS 복사]로 뽑아 `style.css`의 `:root`에 붙인다.

### 3-3. 2단계 — 서버 (자동 시험)

`test/room.test.ts`에 넣는다. 기존 방식(`runInDurableObject`)을 그대로 쓴다.
**개수를 목표로 삼지 않는다.** 아래 분기가 다 덮이면 된다(F-006).

| 시험 | 확인할 것 |
|---|---|
| 첫 [시작] | `turnFx.H` · `turnFx.C` 둘 다 `null` |
| 📦 첫 보물 | `names["treasure-bonus"] === ["민수"]` |
| 📦 같은 팀이 그 칸을 다시 | `names["treasure-claim"]` 에 들어가고 `treasure-bonus` 는 없다 |
| 💥 상대 땅 있음 | `names["attack-steal"]` |
| 💥 상대 땅 없음 | `names["attack-claim"]` — **"빼앗았다"가 아니어야 한다** |
| ⛈️ 폭풍 | `names["storm"]` |
| 🚩 일반 | `normal === 1`, 이름은 어디에도 없다 |
| ❌ 오답 | 그 이름이 어디에도 없다 |
| 수동 [다음 턴] / 알람 자동 전환 | 둘 다 같은 요약이 뜬다 |
| 수동 [종료] | 마지막 턴 요약이 남는다 |
| 라운드 한계 자동 종료 | 요약이 **한 번만** 저장된다 (F-004 멱등) |
| 두 턴 연속 | 최신 턴만 담긴다 |
| 새 게임 | 양팀 `turnFx` 가 `null`, `fx`·`events` 가 비어 있다 |
| 재접속 | `state.turnFx` 와 직전 `turn.turnFx` 가 같다 |
| 학생 소켓 | `turnFx` 가 실려 와도 오류 없이 무시된다 |
| 기존 DO | `CREATE TABLE IF NOT EXISTS fx` 뒤 정상 응답 |

한 개만 예시로:

```ts
it("빼앗을 상대 땅이 없으면 '빼앗았다'가 아니다", async () => {
  // … 상대 칸이 하나도 없는 상태를 만들고 공격칸을 맞힌다 …
  await teacherCmd(stub, "next");
  const fx = (await state(stub)).turnFx.H;
  expect(fx.names["attack-claim"]).toEqual(["민수"]);
  expect(fx.names["attack-steal"]).toBeUndefined();
});
```

```bash
npm test          # 전체 통과가 기준
npm run check     # 타입 + 배포 예행
```

**`tools/playtest.mjs` 확장** — 이미 사람 없이 한 판을 끝까지 돈다.
턴이 넘어갈 때마다 자기가 보낸 정답/오답과 받은 `turnFx`를 대조하는 확인을 붙인다.
**서버 분기 시험이 못 잡는 "실제 한 판에서의 누적 어긋남"을 여기서 잡는다.**

### 3-4. 3단계 — 실제로 한 판 (눈으로)

브라우저 셋. 선생님 1 + 학생 2(홍/청 한 명씩).

| 확인 | 기대 |
|---|---|
| 🆕 새 게임 직후 | 양쪽 흐린 "차례를 기다리는 중", 빛 없음 |
| ▶ 시작 (홍팀) | **왼쪽에만** 붉은 빛 + 발밑 조명, 수색 그림이 흔들리고 시간이 밑에 크게 |
| 홍팀 학생이 칸을 고른 순간 | 왼쪽 밑에 "1명이 문제를 푸는 중" |
| 맞히고 3초 뒤 | **왼쪽이 안 바뀐다** — 결과는 턴이 끝나야 나온다 |
| 다음 턴 | 왼쪽이 결과로 바뀌며 통 튄다. 빛이 **오른쪽으로 옮겨 간다** |
| 보물+공격 같은 턴 | 2.5초마다 📦 ↔ 💥, 점 2개가 따라 움직인다 |
| **이미 보너스 받은 보물칸** | "보물칸을 점령했다" — **"+2"가 아니다** ← F-001 |
| **상대 땅 없을 때 공격** | "공격 거점을 점령했다" — **"빼앗았다"가 아니다** ← F-001 |
| 아무도 못 맞힌 턴 | "이번 턴엔 아무도 못 했어요" (흐리게) |
| 시간 초과 자동 전환 | 버튼으로 넘긴 것과 **똑같이** 동작 ← `advanceTurn` 한 곳만 고쳤는지 보는 시험 |
| 종료 | 마지막 턴 결과가 결과창 뒤에 남아 있다 |
| **F5** | 진행 중에 새로고침해도 좌우가 같은 그림으로 복구된다 |

**회귀 — 반드시 본다**

| 확인 | 왜 |
|---|---|
| 한 턴에 학생이 5문제 푸는 동안 **수색 그림이 한 번도 안 튄다** | `patch`마다 DOM을 다시 만들면 움찔거린다. 서명 검사가 도는지 보는 유일한 시험 |
| 학생 화면이 아무것도 안 변했다 | 이번 변경은 선생님 화면 전용 |
| 15×15 판을 1600 화면에서 | 무대가 접히거나 보드가 잘리지 않는다 (`fxFits`의 값어치) |
| 창을 1100px로 줄인다 | 무대가 사라지고 보드는 그대로 |
| 그림 하나를 지우고 새로고침 | 이모지로 떨어지고 콘솔 오류·게임 중단 없음 |
| OS "동작 줄이기" 켜고 | 회전이 멈추고 카드가 **세로로 전부** 보인다 (하나만 남지 않는다) |
| 🩺 시스템 점검 | "3D 그림 8장 모두 정상", 빌드 경고 없음 |

> **DOM 자동화는 안 한다 (F-006 divergence).** 검토는 Vitest DOM 또는 Playwright를 권한다.
> 지금 테스트는 `@cloudflare/vitest-pool-workers`로 **workerd 안에서** 돈다. jsdom을 못 올린다.
> `app.js`는 837줄짜리 고전 스크립트(모듈이 아니고 export가 없다)라, 테스트를 붙이려면
> **먼저 모듈로 쪼개야 한다.** 그 리팩터의 위험이 이 기능의 위험보다 크다.
> 대신 이렇게 나눈다 — **정확성(어떤 문구가 뜨는가)은 서버 시험과 playtest가 전부 덮고**,
> DOM 전용 위험 두 가지(애니메이션 재시작, 카드 순환)는 위 표의 눈 확인으로 잡는다.
> 이 둘은 틀려도 **연출이 덜 매끄러울 뿐 수업이 멈추지 않는다.** 값과 위험이 맞는 쪽을 골랐다.

### 3-5. 배포

```bash
cd cloudflare-v2
npm test && npm run check
npx wrangler deploy

B=https://treasure-island-v2.ds1lph.workers.dev
curl -sI $B/assets/fx/search-H.webp | grep -i cache-control   # public, max-age=604800
curl -sI $B/app.js                 | grep -i cache-control   # no-store
```

D1 마이그레이션은 **없다.** `fx` 테이블은 각 방의 DO가 깨어날 때 스스로 만든다
(`ensureSchema()`가 생성자와 `init()` 양쪽에서 돈다).

**그림을 고쳐 올린 뒤에는** `APP_BUILD`/`BUILD`/`index.html`의 `?v=`를 같이 올린다.
그래야 이미 열려 있던 탭도 새 그림을 받는다. 배포 후 §3-4를 한 번 훑는다.
**수업 중 배포는 하지 않는다.**

---

## 부록 A — 열린 결정

바꾸고 싶으면 말해 주면 된다.

| 항목 | 지금 값 | 대안 |
|---|---|---|
| 대기 그림 | 수색 그림을 흐리게 재활용 | 전용 "배에서 지도 보는" 그림 추가 (10장이 된다) |
| 공격 그림 | 상대 깃발을 뽑고 내 깃발을 꽂기 | 만화풍 해적 대포로 코코넛 발사 |
| 효과 없는 T/A | 같은 그림, 제목만 다르게 | 전용 그림 4장 추가 |
| 오답 | 표시 안 함 | "아쉽게 놓쳤다" + 인원수만(이름 없이) |
| 회전 간격 | 2.5초 | 3초(느긋) / 2초(경쾌) |
| 이름 한도 | 6명 + "외 N명" | 전원 표시 |
| 무대 최소 폭 | 200px | 실제 TV에서 보고 조정 |
| 빛 값 | `alpha .22 / size 78% / glow .55 / rest .55` | **플레이 예제에서 정한다** |
| 무대 테두리 맥박 | 안 넣음 | 남은 시간이 줄면 빨라지는 팀 색 테두리 — 급할 때 요란해진다 |
| 색을 선생님이 실시간 변경 | 안 넣음 | ⚙ 설정에 넣고 `localStorage` 저장. 지금은 배포 시 고정 |
| 파일 형식 | **WebP** (원본 PNG 는 `img/` 보관) | 문제가 생기면 PNG 로 되돌린다 — 코드의 확장자 한 곳만 바꾸면 된다 |
| 소리 | 없음 | 보물/공격에 짧은 효과음 — 교실에서 시끄러울 수 있어 뺐다 |
| 학생 화면 | 안 건드림 | 1366에서 좌우 여백이 100px뿐이라 옆에는 못 넣는다. 보드 아래 가로 띠라면 가능 |
| 생성 도구 | 미정 | 프롬프트는 도구를 안 가린다. Midjourney면 `--ar 1:1 --style raw` |

## 부록 B — 범위 밖으로 둔 것

| 아이디어 | 왜 안 하는가 |
|---|---|
| 학생 화면에도 3D 결과 (OUT-001) | "선생님 화면만"이 이번 판의 고정 결정이다 |
| Three.js 실시간 3D (OUT-002) | PNG 8장 + CSS로 제한한 범위, 그리고 "그림이 실패해도 게임은 돈다"는 원칙을 깬다 |
| 지난 게임 결과 보관 | 이미 내린 결정 — 종료하면 안 남긴다(`results` 테이블은 지웠다) |
