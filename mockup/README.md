# 화면 목업 (mockup)

디자인 스펙을 눈으로 확인하기 위한 **정적 HTML 시안**이다.
**구현 코드가 아니다.** 서버 호출·게임 로직이 전혀 없고, 화면만 그린다.

## 보는 방법

브라우저에서 파일을 직접 연다(더블클릭 또는 아래 명령).

```bash
xdg-open 01-entry.html          # 리눅스
```

## 이미지로 다시 뽑기

디자인을 고친 뒤 `../img/*.png` 를 갱신하려면 프로젝트 루트(`보물섬점령전/`)에서:

```bash
shoot(){ google-chrome --headless=new --disable-gpu --hide-scrollbars --no-sandbox \
  --force-device-scale-factor=2 --virtual-time-budget=3000 \
  --window-size=$3,$4 --screenshot="img/$2" "file://$PWD/mockup/$1"; }

shoot 01-entry.html            01_진입화면.png            1100 620
shoot 02-student-select.html   02_학생_칸선택.png          1000 800
shoot 03-student-quiz.html     03_학생_문제풀이.png        1000 600
shoot 04-student-result.html   04_학생_결과.png            1000 700
shoot 05-admin-main.html       05_관리자_메인.png          1180 820
shoot 06-admin-settings.html   06_관리자_환경설정.png       1180 820
shoot 07-admin-peek.html       07_관리자_문제미리보기.png    1180 820
```

## 파일

| 파일 | 화면 | 문서 대응 |
|---|---|---|
| `ui.css` | 공통 스타일(색·패턴·셀·모달) | 2-12 |
| `board.js` | 12×12 보드 렌더러 + 예시 스냅샷 | 2-1, 2-2, 2-6 |
| `01-entry.html` | 진입(학생/선생님 선택) | 1-2 |
| `02-student-select.html` | 학생 — 칸 선택 | 2-6 |
| `03-student-quiz.html` | 학생 — 문제 풀이 | 2-6 |
| `04-student-result.html` | 학생 — 결과 | 2-6 |
| `05-admin-main.html` | 관리자 — 메인 | 2-12 |
| `06-admin-settings.html` | 관리자 — ⚙ 환경설정 | 2-12 |
| `07-admin-peek.html` | 관리자 — 문제 미리보기 | 2-12 |

## 예시 스냅샷 (`board.js`)

라운드 7, 홍팀 차례. 홍팀 12칸 / 청팀 11칸.

- 홍팀 씨앗 **D4** 주변, 청팀 씨앗 **I9** 주변 — 2-9의 BFS 분산 배치 결과를 흉내 낸 것
- 공략 중(잠금): `F3`, `G4`, `E6` — 관리자 화면에서 붉게 반짝인다
- 학생 화면의 '나' = **박민수 D6** (전선에 있어 빈 칸을 고를 수 있다)
- `D7`은 보물 칸이라 02→03→04가 한 학생의 이야기로 이어진다

숫자를 바꾸려면 `OWN_H` / `OWN_C` / `SPECIAL` / `PAWNS` / `LOCKED` / `ME` 만 고치면 된다.

## 목업에서 확인한 것 (실제 구현 시 주의)

1. **CSS 클래스 이름 충돌** — 진입 화면의 `.pick`(카드)과 보드 셀의 `.pick`이 겹쳐 셀이
   `width:230px`로 터졌다. 셀 쪽을 `.can`으로 바꿔 해결. 구현 때도 전역 클래스명을 조심할 것.
2. **`aspect-ratio` + grid** — 셀에 `aspect-ratio:1`만 주면 레이아웃이 불안정했다.
   `--cell` 변수로 `width`/`height`를 고정하고 `grid-auto-rows`를 함께 지정하는 편이 안전하다.
3. **이모지 폴백** — `⚔`(U+2694)는 흑백 기호로 폴백되어 TV에서 잘 안 보인다. `💥`처럼
   기본이 컬러인 이모지를 쓰거나 VS16(`⛈️`)을 붙일 것.
4. **모달 `z-index`** — 반짝이는 셀(`z-index:2`)이 모달을 뚫고 올라왔다. `.dim`에 `z-index:100`.

## 섬 배경 (05만 적용)

`05-admin-main.html` 에만 보물섬 배경을 넣어 봤다. **외부 이미지 없이 인라인 SVG**로 그린다
(바다 그라데이션 + 잔물결 + 해변 + 섬 + 야자수·바위·배·조개).

- 켜기/끄기: `.mapbox` 의 **`isle` 클래스 하나**로 토글된다. 빼면 원래 흰 패널로 돌아간다.
- 장식은 전부 **보드 바깥 여백**(viewBox 기준 `x<55`, `x>661`, `y>676`)에만 둔다.
  안쪽에 두면 반투명 프레임 너머로 비쳐 셀 가독성을 해친다.
- 범례는 섬 위가 아니라 **mapbox 밖 바다 위**에 둔다. 섬 위에 두면 배·바위와 겹쳐 안 읽힌다.
- 마음에 들면 02(학생 화면)에도 같은 방식으로 적용하면 된다.
