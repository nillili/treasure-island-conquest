# 보물섬 점령전 배포 가이드

## 운영 구조

```text
학생·교사 브라우저
  → Cloudflare Worker 정적 웹앱 및 /api
  → Apps Script JSON API
  → Google Spreadsheet
```

Cloudflare가 화면과 공개 API를 운영합니다. Apps Script는 스프레드시트에 접근하는 비공개 백엔드 역할만 담당합니다. 브라우저에는 Apps Script 주소와 백엔드 공유 비밀이 노출되지 않습니다.

## 1. 스프레드시트 준비

1. Google 스프레드시트를 만들고 이름을 `보물섬점령전_DB`로 지정합니다.
2. 첫 탭 이름을 `퀴즈`로 바꿉니다.
3. `sample/퀴즈_샘플.csv`를 가져오거나 붙여넣습니다.
4. 학생에게 스프레드시트를 공유하지 않습니다. 자동 생성되는 `_상태`, `_퀴즈스냅샷` 탭에는 문제 배치와 정답이 들어 있습니다.

퀴즈 열은 `질문 | 정답 | 예제1 | 예제2 | ...`입니다. 정답에는 1부터 시작하는 보기 번호 또는 보기 텍스트를 입력할 수 있습니다.

## 2. Apps Script 백엔드 배포

스프레드시트에서 `확장 프로그램 → Apps Script`를 엽니다. 이제 Apps Script에 넣을 파일은 아래 **2개뿐**입니다.

- `appsscript.json`
- `Backend.gs` — API, 설정, 상태, 퀴즈, 게임 로직이 모두 들어 있는 단일 파일

### 2-1. Backend.gs 붙여넣기

1. Apps Script 편집기에 처음부터 있는 `Code.gs`를 엽니다.
2. 내용을 전부 지우고 로컬의 `apps-script/Backend.gs` 내용을 전부 붙여넣습니다.
3. 파일 이름은 `Code.gs` 그대로 사용해도 되고 `Backend.gs`로 바꿔도 됩니다. 동작에는 차이가 없습니다.

### 2-2. appsscript.json 적용

1. 왼쪽 `프로젝트 설정(톱니바퀴)`을 엽니다.
2. `편집기에 appsscript.json 매니페스트 파일 표시`를 켭니다.
3. 편집기로 돌아와 `appsscript.json`을 선택합니다.
4. 내용을 지우고 로컬의 `apps-script/appsscript.json` 내용을 붙여넣습니다.

이전 6개 `.gs` 파일을 이미 올린 프로젝트라면 모두 삭제하고, 합쳐진 `Backend.gs` 내용이 들어간 파일 하나만 남겨야 합니다. 그렇지 않으면 같은 함수가 중복 선언될 수 있습니다.

Apps Script 프로젝트 설정의 스크립트 속성에 다음 값을 추가합니다.

| 속성 | 값 |
|---|---|
| `BACKEND_SECRET` | 충분히 긴 무작위 문자열 |

이 값은 이후 Cloudflare의 `APPS_SCRIPT_SECRET`과 정확히 같아야 합니다. 소스 코드나 `wrangler.jsonc`에 비밀값을 넣지 않습니다.

### 2-3. 초기 설정과 웹 앱 배포

편집기 상단의 함수 목록에서 `setupDefaults`를 선택해 한 번 실행하고 권한을 승인합니다. 그다음:

1. `배포 → 새 배포 → 웹 앱`
2. 실행 계정: `나`
3. 액세스 권한: `모든 사용자`
4. 배포 후 `/exec`로 끝나는 URL을 기록

브라우저에서 URL을 열어 다음과 같은 상태 응답이 보이면 백엔드가 실행 중입니다.

```json
{"ok":true,"service":"보물섬점령전 API","version":1}
```

코드를 수정한 후에는 `배포 관리 → 기존 배포 편집 → 새 버전`을 사용해야 URL이 유지됩니다.

## 3. Cloudflare 설정

```bash
cd 보물섬점령전/cloudflare
npm install
```

`wrangler.jsonc`의 `APPS_SCRIPT_URL`을 앞에서 기록한 `/exec` URL로 바꿉니다.

로컬 개발용 비밀을 설정합니다.

```bash
cp .dev.vars.example .dev.vars
```

`.dev.vars`의 `APPS_SCRIPT_SECRET`을 Apps Script의 `BACKEND_SECRET`과 같게 바꿉니다. `.dev.vars`는 Git에 포함되지 않습니다.

Cloudflare 운영 비밀은 대화형 명령으로 등록합니다. 명령줄 인자로 값을 넣지 않습니다.

```bash
npx wrangler secret put APPS_SCRIPT_SECRET
```

프롬프트가 뜨면 Apps Script와 같은 값을 붙여넣습니다.

## 4. 로컬 실행과 배포

```bash
npm run check
npm run dev
```

로컬 주소에서 학생·교사 로그인과 새 게임을 확인합니다. 완료 후:

```bash
npm run deploy
```

배포 결과의 `workers.dev` 주소가 학생과 교사가 사용할 주소입니다. 원본 `img/보물섬배경화면.png`를 복사한 `public/assets/treasure-island-bg.png`가 Cloudflare 정적 자산으로 함께 배포됩니다.

## 5. 수업 전 필수 확인

- Cloudflare 주소에서 학생과 관리자 로그인이 되는지 확인합니다.
- 브라우저 Network 탭의 요청이 `/api/*`로만 나가고 Apps Script URL과 비밀값이 보이지 않는지 확인합니다.
- 학생 상태 응답에 정답 `ans`와 보드 문제 번호 `q`가 없는지 확인합니다.
- 새 게임 후 `_상태`, `_퀴즈스냅샷` 탭이 숨겨지는지 확인합니다.
- 폭풍 다음 턴 휴식, 공격 영토 이전, Q/T 팀별 1회 보너스를 확인합니다.
- 실제 수업 인원과 같은 수의 창으로 동시 제출과 턴 전환을 시험합니다.

## 문제 해결

- `데이터베이스 서버에 연결할 수 없습니다`: `APPS_SCRIPT_URL`, Apps Script 배포 버전과 액세스 권한을 확인합니다.
- `백엔드 인증에 실패했습니다`: Apps Script `BACKEND_SECRET`, 로컬 또는 Cloudflare `APPS_SCRIPT_SECRET`이 같은지 확인합니다.
- `시트를 열 수 없습니다`: 스프레드시트 ID와 Apps Script 실행 계정 권한을 확인합니다.
- 배경이 안 보임: `cloudflare/public/assets/treasure-island-bg.png`가 존재하는지 확인합니다.
- Worker 코드가 반영되지 않음: `npm run deploy` 후 출력된 배포 주소와 버전을 확인합니다.
