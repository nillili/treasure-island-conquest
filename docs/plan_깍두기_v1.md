# plan_깍두기_v1 — 인원이 홀수일 때 들어오는 가상의 학생

> 인원이 홀수면 [시작] 때 가상의 학생 "깍두기" **한 명**이 모자란 팀에 들어와, 판 위에서
> 실제로 문제를 풀고 땅을 먹으며 밸런스를 맞춘다.
>
> 조사일 2026-09-05 · 기준 커밋 `670be75` 이후 작업 트리
>
> **이 문서의 내력** — 구현이 플랜 없이 먼저 진행됐고, 선생님 요청으로 그 시점에 멈춰
> 플랜을 문서로 굳혔다. 그래서 아래 내용은 추측이 아니라 전부 실제 코드와 일치하며,
> 이 문서만 보고 처음부터 다시 만들 수 있다.

---

## 1. 제작자의 의도 (왜 만드는가)

### 1-1. 지금의 고통 — 점수가 어디서 왔는지 아무도 모른다

이 게임은 홍팀·청팀이 번갈아 문제를 풀어 땅을 먹는다. 1라운드 = 홍 턴 + 청 턴이라
**한 사람이 한 라운드에 딱 한 번** 기회를 가진다. 그래서 인원이 홀수면 한 팀이
라운드마다 기회를 하나 더 갖는다 — 구조적으로 불공평하다.

지금까지는 이걸 `handicap()` (room.ts) 이 점수로 메꿨다. 모자란 팀에
`인원차 × 지나간 턴 × 전체 정답률` 만큼을 보너스에 얹는다. 수학적으로는 공평하지만
**교실에서는 실패했다.** 점수판의 숫자가 저절로 올라가는데 판 위에는 아무 일도 없다.
학생들은 "쟤네 왜 점수가 더 많아?" 라고 묻고, 선생님은 매번 설명해야 한다.
아이들에게 보이지 않는 보정은 보정이 아니라 의심거리다.

### 1-2. 선생님의 요구 (2026-09-05, 원문 취지 그대로)

- **제목**: 가상의 사람 추가
- 인원이 홀수가 되었을 경우 가상의 사람이 참여하여 게임의 밸런스를 맞춘다.
- **시작 버튼을 눌렀을 때** 짝이 모자라면 가상인물 **"깍두기"** 가 추가되어 짝을 맞춘다.
- 지금과 같은 방법으로(= 전체 인원의 평균값으로) 문제를 맞혀 나간다.
- **실제 땅을 점령하면서 움직인다.** 보물을 만나거나, 폭풍을 만나거나,
  땅의 점령(랜덤)도 일어난다.
- **깍두기는 반드시 한 명뿐이다.** 짝이 안 맞는 경우(=홀수)에 들어오는 것이므로,
  한 명만 들어가면 짝수가 된다. 깍두기가 둘 이상이 되는 것은 논리적으로 불가능하다.

"깍두기"라는 이름 자체가 의도를 말한다 — 놀이에서 편이 안 맞을 때 끼워 주는 아이.
아이들이 이미 아는 개념이라 설명이 필요 없다.

### 1-3. 조사로 드러난 현실 (이미 있는 것)

이 기능의 재료는 대부분 이미 있었다. **새로 발명한 규칙이 하나도 없다**는 것이
이 설계의 핵심이다.

| 필요한 것 | 이미 있던 것 | 위치 |
|---|---|---|
| 성공 확률 | `handicap()` 이 쓰던 전체 정답률 | room.ts `SUM(correct)/SUM(solved)` |
| 자리 잡기 | 늦게 들어온 학생 배치 | game.ts `placeLatePlayer` |
| 칸 먹기·보물·폭풍·공격 | 학생 채점 로직 | room.ts `answer` 내부 (→ `claimCell` 로 분리) |
| 공격 시 무작위 빼앗기 | 2026-08-29 이전의 자동 빼앗기 함수가 **죽은 코드로 남아 있었다** | game.ts `pickStealTarget` |
| 갇힘·구조 | 2026-09-04 갇힘 규칙 | game.ts `trappedPlayers` · `rescueTrapped` |
| 폭풍 쉼 | `skip_turns` / `skip_turn_key` | room.ts `advanceTurn` |

### 1-4. 설계를 가르는 원칙

> **깍두기는 학생과 같은 길을 지난다. 다른 길을 만드는 순간 규칙이 어긋난다.**

깍두기 전용 채점·전용 배치·전용 갇힘 규칙을 만들지 않는다. 학생이 쓰는 함수를
그대로 쓴다. 유일한 차이는 "보기를 고르는 손가락이 없다"는 것뿐이고, 그 자리만
확률(전체 정답률)로 대신한다.

### 1-5. 확정된 결정들

| 결정 | 내용 | 근거 |
|---|---|---|
| 추가 시점 | **[시작](첫 next) 그 순간, 한 번만** | 그때 명단이 확정된다. 판 도중에 넣고 빼면 땅 임자가 사라지거나 낯선 말이 갑자기 나타난다 |
| 인원 | **한 명만.** `\|h−c\| ≠ 1` 이면 아예 안 넣는다 | 선생님 확정. 홀수 → 1명 → 짝수. 강퇴로 차이가 2 이상이면 넣어도 짝이 안 맞으므로 기존 점수 보정(handicap)에 맡긴다 |
| 성공 확률 | 실제 학생들의 전체 정답률. **깍두기 자신은 계산에서 뺀다** | 자기 성적이 자기 확률을 다시 정하는 되먹임 방지 |
| 첫 턴 확률 | 0.75 | 아직 아무도 안 풀었을 때. 실측 20판의 전체 정답률 중앙값 |
| 이중 보정 | **handicap 은 지우지 않는다** | 깍두기가 들어가면 h==c 라 저절로 0. 차이 2 이상인 드문 경우엔 여전히 필요 |
| 기록 | `game_records` 의 인원·시도·정답은 **사람만** 센다 | 판 크기 계수(CLAIM)가 이 값에서 나온다. 봇이 섞이면 판 설계가 틀어진다 |
| 감시·경보 | 🙋 도와줄 학생 · 이상 징후 · watch 경보에서 **제외** | 소켓이 없어 늘 '끊김'으로 보이지만 다가가 볼 사람이 없다 |
| 판별 | 이름이 아니라 **id 접두어(`bot_`)** | 학생이 "깍두기"라고 입력할 수 있다. 이름은 겹치면 깍두기2 |

---

## 2. 개발 방법 (이것만 보고 구현 가능하게)

### 2-1. 무엇을 건드리나

| 파일 | 변경 | 마이그레이션 |
|---|---|---|
| src/game.ts | `botPickCell` 신설 | 없음 |
| src/protocol.ts | `PublicPlayer.bot: boolean` 추가 | 없음 |
| src/room.ts | 상수·`isBot`·`fillTeams`·`answerRate`·`playBots`·`claimCell` 분리 · 제외 4곳 | **없음** — players 표를 그대로 쓴다 |
| public/app.js | 명단 🤖 표시 · `helpNeeded` 제외 · 사람 수만 세기 | 판번호 범프 필요 |
| public/index.html · src/diagnose.ts | 판번호 범프 | — |
| public/style.css | `.person.bot` | — |
| tools/watch.mjs | 🤖 표시 · 경보 제외 | — |
| tools/stage.mjs | 학생 5명(홀수)으로 — 시연에서 깍두기가 보이게 | — |
| test/room.test.ts | 깍두기 10개 + 기존 1개 의도 보존 수정 | — |

**데이터 모델 변경 없음.** 깍두기는 `players` 표의 보통 행이다. DO 스키마는
`CREATE TABLE IF NOT EXISTS` 뿐이라 돌고 있는 방에 새 컬럼을 못 넣는데,
행 하나 추가는 아무 문제가 없다 — 이 제약이 "id 접두어로 구분" 설계를 정했다.

### 2-2. src/game.ts — 둘 칸 고르기 (순수 함수)

```ts
export function botPickCell(view: PlacementView, pos: number, locked: Set<number>): number | null {
  const free = neighbors8(pos, view.rows, view.cols)
    .filter((n) => view.owners[n] === null && !locked.has(n));
  return free.length ? free[Math.floor(Math.random() * free.length)]! : null;
}
```

학생이 고를 수 있는 범위(이웃 8칸 · 임자 없음 · 안 잠김)와 **똑같다.** null 이면 그 턴은
쉰다 — 다음 턴에 `rescueTrapped` 가 어차피 꺼내 준다.

### 2-3. src/room.ts — 본체

**상수·판별** (파일 상단):
```ts
const BOT_PREFIX = "bot_";
const BOT_NAME = "깍두기";
const BOT_FALLBACK_RATE = 0.75;
function isBot(id: string): boolean { return id.startsWith(BOT_PREFIX); }
```

**`fillTeams()`** — advanceTurn 첫머리, `if (!room.turn_team) this.fillTeams();` 로 호출:
1. `|h − c| !== 1` 이면 return (한 명으로 짝이 맞는 경우에만 넣는다)
2. 이름 겹침 회피: 명단에 "깍두기"가 있으면 깍두기2, 깍두기3 …
3. `INSERT INTO players` — id 는 `bot_<base36시각>`
4. 판이 깔려 있으면 `placeLatePlayer` 로 자리 잡고 `applyPlacement`

**`claimCell(me, cell, target)`** — 학생 `answer` 의 "정답일 때 칸에 일어나는 일"을
**그대로 떼어낸 것**(동작 무변경 리팩터): owner/owned_by 갱신 → 보물 +2(`bonus_taken`)
→ pos 이동 → 폭풍 `skip_turns=1` → 공격권 등록. 학생과 깍두기가 함께 쓴다.

**`answerRate()`** — `SELECT SUM(solved), SUM(correct) FROM players WHERE id NOT LIKE 'bot_%'`.
0건이면 `BOT_FALLBACK_RATE`.

**`playBots(turnTeam, round)`** — advanceTurn 에서 `UPDATE room …` (턴 확정) **직후** 호출:
1. 그 팀의 봇만 골라 (`isBot && team && pos !== null`)
2. 폭풍(`skip_turn_key === key`)·갇힘(`isTrapped`)이면 건너뜀 — 학생과 같은 순서로 이미 정리돼 있다
3. `botPickCell` 로 칸 선택 → `Math.random() < rate` 로 채점
4. 정답이면 `claimCell`. 공격권을 받았으면 **그 자리에서** `pickStealTarget` 으로
   상대 땅 하나를 무작위로 가져오고 권리를 지운다 (깍두기는 손가락이 없다)
5. `solved`·`correct`·`last_played_turn_key` 갱신 + `addEvent("answer", …)` — 기록 줄에 남는다
6. 바뀐 칸들을 `patchMessage` 로 방송

**제외 4곳** — 깍두기는 소켓이 없어 늘 '끊김'으로 보인다:
- `gameIssues`: `roster = allPlayers.filter(p => !isBot(p.id))` — 매 판 헛경고 방지
- `recordGame`: `player_count`·`solved`·`correct` 는 사람만 (점수 h_total/c_total 은 깍두기 포함)
- `newGame`: `DELETE FROM players WHERE id LIKE 'bot_%'` — 지난 판 깍두기를 끌고 가지 않는다
- `handicap`: 코드 무변경. 주석으로 "깍두기가 짝을 맞추므로 보통 0" 명시

### 2-4. src/protocol.ts · 화면

- `PublicPlayer` 에 `bot: boolean` 추가, `publicPlayers()` 에서 `bot: isBot(p.id)`
- app.js `renderAdmin`: 봇은 `🤖 깍두기` 배지(점선 테두리 `.person.bot`), 내보내기 × 버튼 없음,
  "N명" 인원수는 `players.filter(p => !p.bot)` 로
- app.js `helpNeeded`: `if (p.bot) continue;` — 🙋 에 안 뜬다
- watch.mjs: 상태 칸에 `🤖 깍두기(가상)`, 🙋 경보 제외

### 2-5. 프로젝트 함정 (이 저장소 고유)

- **판번호 3곳 동시 범프**: app.js `APP_BUILD` · index.html `?v=` · diagnose.ts `BUILD`.
  `test/diagnose.test.ts` 가 어긋남을 잡는다.
- `public/app.js` 는 번들 없이 그대로 나간다 — 서버 규칙을 베낀 부분은 검사 도구로 대조.
- 경로에 한글 → 노드 도구는 `fileURLToPath`.
- 커밋 전 `logs/` 가 스테이징에 없는지 확인 (학생 실명).

### 2-6. 변경 파일 체크리스트

- [x] src/game.ts — botPickCell
- [x] src/protocol.ts — PublicPlayer.bot
- [x] src/room.ts — 상수 · isBot · fillTeams · answerRate · playBots · claimCell 분리 · 제외 4곳
- [x] public/app.js · index.html · style.css — 🤖 표시 · 제외 · 판번호 `2026-09-05b`
- [x] src/diagnose.ts — 판번호
- [x] tools/watch.mjs · tools/stage.mjs
- [x] test/room.test.ts — 10개 신설 · 1개 의도 보존 수정 ("혼자여도 안 튕긴다")
- [x] docs/PROJECT_SPEC.md — FR-J 16항

## 3. 테스트 방법

### 3-1. 자동 (전부 통과 확인됨, 2026-09-05)

```bash
cd cloudflare-v2
npx vitest run                       # 218개 (깍두기 10개 포함)
node tools/plan-check.mjs            # 판 설계 검사 (깍두기와 무관하지만 회귀 확인)
for t in freeze steal result trap help plan; do node tools/$t-check.mjs; done
```

깍두기 10개가 확인하는 것: 홀수→1명·짝맞음 / 자리잡음 / 5명이어도 1명 / 차이 2면 안 넣음 /
짝수면 안 넣음 / 이름 겹침 회피(깍두기2) / 보정 0 / 자기 차례에 풂 / 정답률 1.0이면
확정적으로 땅 먹고 이동(사람 하나를 정답 처리해 rate 를 1.0 으로 만드는 결정적 검증) /
새 게임 때 사라짐.

**고의 파손 4종**으로 테스트가 진짜 잡는지 확인했다: 짝맞추기 제거 → 5개 실패,
차례에 안 둠 → 2개 실패, 새 게임 때 안 지움 → 1개 실패, 이름 회피 제거 → 1개 실패.

### 3-2. 로컬 수동 시연

```bash
npx wrangler dev --port 8799         # 창 1
node tools/stage.mjs                 # 창 2 — 학생 5명(홀수)이라 깍두기가 들어온다
```
- 접속: http://127.0.0.1:8799 · 선생님 demo / pw1234 → 열려 있는 내 방
- 확인: ① 학생 명단에 `🤖 깍두기`(점선 배지, × 버튼 없음) ② 인원수가 "5명"(6명 아님)
  ③ [다음 턴]마다 깍두기 말이 혼자 움직이며 땅을 먹음 ④ 점수의 보너스가 0에서 시작
  ⑤ 🙋 도와줄 학생에 멈춤이·유령이만 (깍두기 없음)

### 3-3. 배포

```bash
npx vitest run && npx wrangler deploy
curl -s https://treasure-island-v2.ds1lph.workers.dev/app.js | grep APP_BUILD   # 2026-09-05b
```
마이그레이션 없음. 배포 즉시 모든 방에 적용되지만, **이미 돌고 있는 판**은 [시작]을
다시 누르기 전까지 깍두기가 없다(추가 시점이 [시작]이므로).

## 부록 — 열린 결정

| 지점 | 지금 기본값 | 바꾸려면 |
|---|---|---|
| 첫 턴 확률 | 0.75 | room.ts `BOT_FALLBACK_RATE` |
| 판 도중 홀수가 되면 | 안 넣음(다음 [시작]부터) | `advanceTurn` 의 호출 조건 |
| 깍두기 강퇴 | 명단에 × 버튼이 없어 화면에선 불가 | 서버 `kick` 은 막지 않았다(id 를 알면 가능) |
| 깍두기 이름 | "깍두기" 고정 | room.ts `BOT_NAME` |
