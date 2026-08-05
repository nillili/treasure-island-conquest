# 보물섬 점령전

Cloudflare Workers에서 운영하고 Google Spreadsheet를 데이터베이스로 사용하는 교실용 팀 대전 퀴즈 웹앱입니다.

## 구조

- `cloudflare/`: 학생·관리자 웹앱, `/api` 프록시, Cloudflare 배포 설정
- `apps-script/Backend.gs`: 스프레드시트 DB에 접근하는 전체 JSON API 백엔드 단일 파일
- `apps-script/appsscript.json`: Apps Script 실행 설정 파일
- `sample/퀴즈_샘플_v3.csv`: 50개 예시 문제 (4지선다, 정답은 번호)
- `docs/PROJECT_SPEC.md`: 코드를 정본으로 삼는 설계도 — 기능 요구사항·데이터 모델·데이터 흐름
- `docs/DEPLOY.md`: Apps Script와 Cloudflare 배포 방법
- `tools/`: 배포 확인(`check-state.py`)·수업 후 로그 분석(`fetch-log.py`)
- `img/보물섬배경화면.png`: 원본 배경 이미지

## 게임 규칙

- 홍팀·청팀으로 나뉘어 12×12 지도의 칸을 점령한다. 칸마다 다른 문제가 숨어 있다.
- 학생은 자기 말 **둘레 8칸(대각선 포함)** 중 아군 칸이 아닌 곳에 도전한다.
- 한 턴에 한 문제. 맞히면 그 칸을 점령하고 말이 이동한다.
- 특수칸: 📦 보물(+2) · ⛈️ 폭풍(다음 턴 쉼) · 💥 공격(상대 칸 1개 빼앗음)
- 점수 = 점령한 칸 수 + 보너스

## 수업 진행

```
0. ⚙ 환경설정 → 🩺 시스템 점검     문제가 없는지 먼저 확인
1. 학생 입장                       명단에서 인원 확인, 중복은 × 로 정리
2. 🆕 새 게임                      보드에 인원수만큼 색이 칠해진다
3. ▶ 시작  →  다음 턴              시간이 지나면 자동으로도 넘어간다
4. 종료                            승패 확정 + 스프레드시트에 기록
```

`🧹 초기화`는 학생 명단까지 비우고 새 판을 깐다. 다음 반 수업을 시작할 때 쓴다.

## 버전

`Backend.gs`의 `BACKEND_VERSION`과 `app.js`의 `APP_VERSION`은 **항상 같아야 한다.**
다르면 배포가 어긋난 것이고, [시스템 점검]이 이것부터 잡아낸다.

```bash
python3 tools/check-state.py           # 배포된 서버 버전 확인
python3 tools/check-state.py <비번>     # 학생 배치까지 확인
```

Cloudflare 배포본은 원본 이미지를 복사한 `cloudflare/public/assets/treasure-island-bg.png`를 실제 화면 배경으로 사용합니다.

## 개발

```bash
cd cloudflare
npm install
npm run check
npm run dev
```

상세 설정과 배포 순서는 [docs/DEPLOY.md](docs/DEPLOY.md)를 따릅니다.

## 보안 경계

- 브라우저는 같은 출처 `/api/*`만 호출합니다.
- Cloudflare Worker만 Apps Script URL과 공유 비밀을 사용합니다.
- Apps Script만 스프레드시트에 접근합니다.
- `_상태`와 `_퀴즈스냅샷`에는 문제 배치와 정답이 있으므로 스프레드시트를 학생에게 공유하지 않습니다.

삼각형 자동 점령은 현재 구현 범위에 포함되지 않습니다.
