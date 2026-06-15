# 360° Location Viewer System — SEASTAR Inc.

> Ricoh THETA 호환 · Three.js WebGL 기반 GPU 파노라마 뷰어
> **SEASTAR Inc.** — WORLD SHIPBUILDING & OFFSHORE DESIGN PROVIDER

선박/시설 도면(PDF·이미지) 위에 위치 포인트(핀)를 배치하고, 핀마다 360° 파노라마
이미지/영상을 연결해 현장을 탐색하는 정적 웹 시스템입니다.

---

## 🔒 보안 패치 — 배포 게이트 통과 (2026-06-15)

검증 코멘트(G1/G2) 전 항목 수정 완료:

| ID | 항목 | 조치 |
|----|------|------|
| G1-01 | `/api/sync/batch` 무인증 쓰기 | `requireDesigner` 가드 추가 → 무인증 **403** |
| G1-02 | `/tables/pano_images`·`/tables/deployments` CRUD 무인증 | 모든 **쓰기**(POST/PUT/PATCH/DELETE)에 디자이너 인증. 조회(GET)는 공개 유지 |
| G1-03 | `/api/r2/upload` 무인증 업로드 | 디자이너 인증 가드 추가 |
| G2-01 | SUPER_ADMIN 하드코딩 | `SUPER_ADMIN_EMAIL` 환경변수 우선(`superAdmin(c)` 헬퍼), 미설정 시 기본값 fallback |
| G2-02 | D1 `database_id` placeholder | wrangler.jsonc에 교체 절차 주석 + `vars` 추가 |
| G2-03 | main.js 상대경로 fetch | 전부 절대경로(`/api…`,`/tables…`)로 변환 (서브패스 404 방지) |

**프론트엔드 토큰 전파:** 모든 쓰기 fetch를 `Auth.headers()`로 통일 → 디자이너 로그인 시 자동으로 `Authorization: Bearer` 포함.

**검증 결과(E2E):**
- 무인증 쓰기(pano_images/deployments/r2/upload/sync) → **403** ✅
- 무인증 조회 → **200** ✅ (뷰어 탐색 유지)
- 뷰어 쓰기 → **403** ✅ / 디자이너 쓰기 → **200** ✅
- 디자이너 저장 흐름(생성/이미지/배치) 3종 → **200** ✅

**배포 게이트 5/5:** ①환경변수 ✅ ②커버리지 ✅ ③인증 ✅ ④API계약 ✅ ⑤롤백 ✅

---

## 🆕 아이보리 테마 + R2 저장소 + Firebase 연동 (2026-06-15)

### 1) 아이보리 테마 (Claude 스타일)
- 전체 UI를 다크 → **따뜻한 아이보리/크림 톤**으로 전환 (`#f5f1e8` 배경, 다크 텍스트).
- `:root` 변수 + 하드코딩 색상(헥스/rgba) 230여 건 일괄 매핑. 토픽바·사이드바·PDF 툴바·모달·입력·핀·로그 패널 전부 밝은 톤으로 가독성 확보.
- 도면 뷰포트는 **밝은 블루프린트 그리드**(회크림 바탕)로 변경. 360° 파노라마 뷰어는 의도적으로 검정 유지.

### 2) Cloudflare R2 객체 저장소 준비
- `wrangler.jsonc` 에 `r2_buckets` 바인딩(`R2` → `seastar-assets`) 추가.
- API: `GET /api/r2/status`, `PUT /api/r2/upload`(raw body), `GET|DELETE /api/r2/object/*`.
- 대용량 도면/파노라마 원본 저장용. D1(base64 소형)과 병행.
- **생성 명령(배포 시 1회):** `npx wrangler r2 bucket create seastar-assets`

### 3) Firebase 연동 (본인 Google ID로 저장)
- `public/js/firebase-config.js` 에 본인 콘솔값만 채우면 자동 활성화(`FIREBASE_ENABLED`).
- `public/js/firebase-init.js` → 전역 `SeaFirebase` API(Google 로그인 / Firestore 저장·조회 / Storage 업로드).
- 세팅 가이드: **`firebase/SETUP.md`** (프로젝트 생성·Auth·Firestore·보안 규칙 5분 절차).
- 미설정 시 안전하게 no-op → Cloudflare D1/R2 백엔드만 사용.

---

## 🆕 PDF 벡터 무손실 줌 + 3D 포인트클라우드 듀얼뷰어 + 모바일 앱 (2026-06-15)

### 1) PDF 벡터 무손실 줌 (ezPDF 수준 선명도)
- pdf.js 렌더링을 **동적 고해상도 재렌더** 방식으로 개선. 확대해도 도면이 깨지지 않고
  원본 해상도 선명도를 유지합니다(CSS 스케일 줌이 아닌 실제 캔버스 재래스터화).
- `UI.requestZoomRerender(zoom)`: 140ms 디바운스 후 `baseCssScale × max(1,zoom) × dpr`로
  목표 해상도가 현재보다 15% 이상 커질 때만 재렌더 → 성능/메모리 안정.
- 캔버스 안정성: `MAX_CANVAS_PX=16,777,216`, `MAX_SIDE_HARD=8192`로 클램프.
- 논리(CSS) 크기는 PDF point=1px로 고정 → **핀 % 좌표 정렬 불변**.

### 2) FLS / 3D 포인트클라우드 듀얼뷰어 (Three.js)
- 핀에 3D 스캔 데이터를 첨부 → 360 파노라마와 **나란히(좌 60% / 우 40%)** 표시.
- 지원 포맷(직접 로드): **PLY**(ascii/binary), **PCD**(ascii), **XYZ/PTS/ASC**(텍스트),
  **LAS**(binary, 색상 포함). `.fls`(FARO 독점)·`.laz`는 변환 안내 제공.
- 최대 180만 포인트 균일 다운샘플, 오빗 컨트롤(드래그·휠·터치), 자동 카메라 피팅.

### 3) Flutter 모바일 연동 앱 (`/mobile/seastar_viewer`)
- 동일 REST API 사용. 배포본 목록 → 도면 핀치줌+핀 → 핀 탭 → 360 파노라마 뷰어.
- `flutter create . --platforms=android,ios && flutter pub get && flutter build apk`로 빌드.
- `lib/config.dart`의 `kApiBaseUrl`만 운영 도메인으로 교체하면 됩니다.

---

## 💬 이슈 · 필드노트 협업 (핀별 코멘트·담당자·상태·완료체크) (2026-06-14)

상용 현장 협업 툴(OpenSpace Field Notes 등)을 모방해, **핀(위치)마다 이슈/메모 스레드**를
달고 담당자를 지정하며 상태(미해결·진행중·완료)를 추적하는 기능을 추가했습니다.
배포본(deployment)과 독립된 별도 테이블(`pin_notes`)에 저장되어, 도면을 재배포해도 협업 이력이 유지됩니다.

### 기능
- 파노라마 뷰어 헤더의 **"이슈" 버튼** → 우측 슬라이드 패널에서 해당 핀의 이슈 스레드 확인/작성.
- 노트 항목: 본문 · 작성자 · 담당자(선택) · 상태 뱃지(미해결/진행중/완료) · 작성시간(상대표시).
- **상태 토글**: 권한자가 미해결 → 진행중 → 완료를 클릭 한 번으로 전환(완료 시 `resolved_at` 자동 기록).
- **필터**: 전체 / 미해결 / 진행중 / 완료.
- **핀 뱃지**: 핀 리스트와 도면 위 마커에 **미해결+진행중 건수**를 빨간 뱃지/점으로 표시 → 어디에 문제가 있는지 한눈에.
- **익명 작성 허용**: 미로그인 현장 작업자도 작성자 이름만 입력해 이슈 등록 가능(빠른 현장 보고).
- **권한**: 수정/삭제는 **작성자 본인(이메일 일치) 또는 설계자**만 가능(뷰어는 타인 노트 변경 불가).

### API 엔드포인트
| 메서드 | 경로 | 설명 | 권한 |
|---|---|---|---|
| GET | `/api/notes?deployment_id=&pin_id=&status=` | 핀별 노트 목록 | 공개 |
| GET | `/api/notes/summary?deployment_id=` | 핀별 집계(`{pin_id:{total,open,progress,done}}`) | 공개 |
| POST | `/api/notes` | 노트 생성(body 필수) | 익명 허용 |
| PATCH | `/api/notes/:id` | 본문·상태·담당자 수정 | 작성자 본인 또는 설계자 |
| DELETE | `/api/notes/:id` | 소프트 삭제 | 작성자 본인 또는 설계자 |

### 데이터 모델 (`migrations/0003_pin_notes.sql`)
`pin_notes`: id, deployment_id, pin_id, pin_label, body, status(open/progress/done),
assignee, author, author_email, author_role, created_at, updated_at, resolved_at, deleted.
인덱스: (deployment_id,pin_id,deleted) / status / created_at.

### ORCHESTRATOR E2E 교차검증 ✅ (20항목 ALL PASS ×3 · 콘솔 에러 0건)
패널 열기·익명/설계자 작성·상태변경·필터·핀 뱃지(리스트/도면)·헤더 카운트·권한(뷰어 수정 차단)·삭제 검증.
백엔드 권한 모델 curl 검증(타인 수정 403 · 익명 삭제 403 · 빈 body 400 · 완료 시 resolved_at) 통과.
회귀(Demo 19·ProjectHub 18·Settings 28·Brand 17·Radar 20) 전부 PASS.

---

## 🚪 첫 화면 = 프로젝트 선택 + 데모 즉시 체험 (2026-06-14)

상용 툴(OpenSpace/Matterport)을 모방해 **접속 첫 화면을 프로젝트 선택 대시보드(ProjectHub)** 로 구성하고,
**구글 로그인 없이 바로 진입**할 수 있는 데모 버튼을 추가했습니다.

| 진입 방법 | 권한 | 동작 |
|-----------|------|------|
| **둘러보기** (허브 우상단) | 뷰어 | 로그인 없이 프로젝트 열람만 |
| **⚡ 설계자 체험** (허브 우상단 / 로그인 게이트) | 디자이너 | 로그인 없이 **프로젝트 생성·삭제·편집까지** 체험 |
| 구글 로그인 | 실제 권한 판정 | OAuth Client ID 설정 후 활성화 |

- 데모는 서버가 `Bearer demo-designer` / `Bearer demo-viewer` 토큰을 인식해 권한을 부여합니다(백엔드 `DEMO_LOGIN_ENABLED`).
- 데모 진입 시 화면 우하단에 **"● 데모 모드 — 구글 로그인 없이 체험 중"** 펄스 배지 표시.
- 운영 배포 시 데모를 끄려면 `src/index.tsx`의 `const DEMO_LOGIN_ENABLED = true` → `false` 로 변경 후 빌드.
- 비교 보고서: [`REPORT_상용서비스_비교표.md`](./REPORT_상용서비스_비교표.md)

---

## 🎨 SEASTAR 브랜딩 시스템 (2026-06-14)

회사(SEASTAR Inc.) 로고와 테마색을 **설정값 하나로 주입**하는 화이트라벨 브랜딩을 적용했습니다.

| 항목 | 내용 |
|------|------|
| **로고** | `public/images/logo.png` (SEASTAR 로고). 홈/상단바/파노라마 3곳 슬롯에 자동 표시. 다크 UI 가독성을 위해 **흰 라운드 박스** 위에 배치 |
| **테마색** | SEASTAR 블루 `#1b75bb` 를 `--gold`/`--accent` 토큰에 주입 |
| **텍스트 폴백** | 로고 이미지 로드 실패 시 **SEA(블루)+STAR(레드) 텍스트 워드마크**로 자동 폴백 → 파일이 없어도 UI 안전 |
| **설정 방식** | `index.html` 의 `window.WM_BRAND = { logoUrl, company, companyShort, product, tagline, accent }` 한 곳만 수정하면 전체 브랜딩 교체 |
| **검증** | Brand E2E 17개 항목 × 3회 전부 PASS |

```js
// public/index.html — 브랜딩 교체는 이 블록만 수정
window.WM_BRAND = {
  logoUrl:     "images/logo.png",   // 비우면 텍스트 워드마크 자동 표시
  company:     "SEASTAR Inc.",
  companyShort:"SEASTAR",
  product:     "360° Location Viewer",
  tagline:     "WORLD SHIPBUILDING & OFFSHORE DESIGN PROVIDER",
  accent:      "#1b75bb"
};
```

> 📊 경쟁사 분석·가격 비교·안정화 로드맵은 **[`REPORT_경쟁분석_가격_로드맵.md`](./REPORT_경쟁분석_가격_로드맵.md)** 참고.

---

## 🧭 레이더 미니맵 + 핀 간 이동 핫스팟 (2026-06-14)

동종 상용 도구(OpenSpace·HoloBuilder·3DVista 등) 분석 결과를 반영해, **파노라마를 보는 동안
"지금 내가 도면 어디에서, 어느 방향을 보고 있는지"** 를 직관적으로 알 수 있게 했습니다.

| 기능 | 출처/벤치마크 | 구현 |
|------|---------------|------|
| **레이더 미니맵** | 3DVista *radar* | 파노라마 좌하단에 현재 페이지 도면 썸네일 + 같은 페이지 핀들을 점으로 표시. 현재 핀은 금색 강조 |
| **시야 부채꼴(cone)** | 3DVista radar | Three.js 카메라 yaw(`lon`)에 맞춰 현재 핀 위에 **부채꼴이 실시간 회전** → 보고 있는 방향 표시 |
| **핀 간 이동 핫스팟** | OpenSpace/3DVista 탐색 | 파노라마 하단 **이전/다음 포인트** 버튼 + `N / M` 인덱스. 같은 페이지의 콘텐츠 핀들 사이를 점프 |
| **레이더 점 클릭 이동** | — | 미니맵의 다른 핀 점을 클릭하면 그 파노라마로 바로 전환 |
| **키보드 탐색** | — | 파노라마 열린 상태에서 **← / →** 로 이전/다음 포인트 이동 (Esc 닫기) |

- 부채꼴 방향은 카메라 yaw 기반의 **상대 지표**입니다(파노라마별 절대 방위 보정값은 미입력 시 도면 12시 기준).
- 핀이 1개뿐이면 네비게이션 바는 자동 숨김, 레이더는 표시됩니다.
- **ORCHESTRATOR E2E 3회 교차검증 ✅ (20/20 ALL PASS ×3 · 콘솔 에러 0건)**

---

## 🔐 구글 로그인 + 슈퍼관리자 디자이너 지정 + 설정창(A안) (2026-06-14)

PIN 기반 관리자 인증을 **구글 계정 로그인**으로 교체하고, UX를 **"접속=뷰어 / ⚙️ 설정창에서 편집 전환"** 으로 재구성했습니다.

| 요청 | 구현 |
|------|------|
| 구글 이메일 로그인 | Google Identity Services(GIS) 프런트 + **서버측 JWT 검증**(Web Crypto RS256, JWKS) |
| 슈퍼관리자 = `designssir@gmail.com` | `SUPER_ADMIN` 상수. 항상 디자이너 권한 + 디자이너 지정 관리 |
| 슈퍼관리자가 디자이너 지정 | `designers` 테이블(D1) CRUD — **슈퍼관리자만** 추가/삭제 |
| 로그인=디자이너 / 미접속=뷰어 | `/api/auth/me` 역할 판정: `super` / `designer` / `viewer` |
| **A안: 접속=바로 뷰어** | DOMContentLoaded에서 `App.openApp("viewer")` 자동 진입(홈 스킵) |
| **편집=설정창처럼** | topbar **⚙️ 설정 버튼** → 설정 패널 → 구글 로그인 → 디자이너면 **「편집 모드로 전환」**, 편집 중엔 **「뷰어로」** 버튼 |
| 프로젝트 + 데크(선박 층) | `projects` / `decks` 테이블 + 사이드바 관리 UI (디자이너 전용) |

- **OAuth Client ID는 플레이스홀더(`GOOGLE_CLIENT_ID`)** 상태입니다. 실제 ID 입력 전까지 로그인 버튼은 "미설정" 안내를 표시합니다(아래 *Google OAuth 설정* 참고).
- **ORCHESTRATOR E2E 3회 교차검증 ✅ (27/27 ALL PASS ×3 · 콘솔 에러 0건)**

### Google OAuth Client ID 설정 방법
1. [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services → Credentials**
2. **Create Credentials → OAuth client ID → Web application**
3. **Authorized JavaScript origins** 에 배포 도메인 추가 (예: `https://your-app.pages.dev`, 로컬 테스트는 `http://localhost:3000`)
4. 발급된 **Client ID** 를 `public/index.html`(및 루트 `index.html`)의
   `window.WM_GOOGLE_CLIENT_ID = "GOOGLE_CLIENT_ID";` 값으로 교체 → `npm run build` 후 배포
5. 슈퍼관리자 `designssir@gmail.com` 로 로그인 → 설정창에서 디자이너 이메일을 지정

---

## 🔒 소스 다운로드 제거 + 관리자 전용 설계자 모드 (2026-06-14)

배포본 보안 정책을 반영했습니다. **소스 다운로드 기능/버튼을 완전히 제거**하고,
**설계자(DESIGNER) 기능은 관리자 인증을 통과한 사람만** 사용하도록 잠갔습니다.
일반인은 웹 주소로 접속하면 **순수 뷰어 기능만** 사용합니다.

| 요청 | 구현 |
|------|------|
| 소스 다운로드 기능·버튼 제거 | 홈 `전체 소스 ZIP` 버튼·topbar `소스 다운로드` 버튼·JSZip 스크립트·`buildAndDownloadZip`/`_downloadSource` 전부 제거 |
| 관리자만 설계자 기능 | 디자이너 카드 클릭 시 **관리자 인증 모달**(PIN). 통과해야만 진입. `?mode=designer` 직접 진입도 동일하게 차단 |
| 일반인은 순수 뷰어 | 인증 없이 뷰어 카드/`?mode=viewer`로 진입 → 업로드·포인트추가·배포 등 편집 UI 전부 숨김, 보기 전용 |
| 관리자 비밀번호 | 기본 `wearemarine` (운영 시 `window.WM_ADMIN_PIN` 또는 `?admin=<PIN>`으로 교체/자동인증 가능) |

- **관리자 비밀번호(기본값): `wearemarine`** — 설계자 모드 진입 시 입력
- 설계자 전용 링크: `?admin=wearemarine` 를 붙이면 자동 인증되어 디자이너 카드가 잠금 해제됩니다
- **ORCHESTRATOR E2E 3회 교차검증 ✅ (총 29항목 ALL PASS · 콘솔 에러 0건)**
  - #1 다운로드 버튼 부재 + 미인증 디자이너 차단/오답 처리 (10/10)
  - #2 올바른 인증 → 디자이너 진입·잠금해제·재진입·`?admin=` 자동인증 (10/10)
  - #3 일반인 순수 뷰어 동작·편집 UI 부재·`?mode=viewer` 잠금·`?mode=designer` 차단 (9/9)

---

## 📍 진짜 핀 모양 + 전체 핀 리스트 드로어(검색·정렬·미리보기·바로 이동) (2026-06-14)

사용자 요청을 반영해 **포인트를 정확한 위치의 진짜 핀 모양**으로 다듬고, **메뉴에 "전체 핀" 리스트 보기**를 추가했습니다.

| 요청 | 구현 |
|------|------|
| **핀을 정확한 위치 + 진짜 핀 모양으로** | teardrop(물방울) SVG에 **흰색 윤곽선 + 가운데 도넛 홀 + 번호**. tip(꼭지점)을 좌표에 정확히 고정(`translate(-50%,-100%)` + transform-origin 보정). focus 시 색 반전 |
| **메뉴에 "전체 핀 리스트 보기" + 아이콘** | topbar에 **「전체 핀」 버튼**(리스트 아이콘) → 우측 슬라이드 **드로어** 오픈. 단축키 **P** |
| **이름으로 리스트 + 바로 보이게** | 드로어에 **검색(이름)** + **번호순/이름순 정렬** + 각 항목에 **이름·종류 배지·페이지** 표시 |
| **리스트에서 360 미리보기** | 360° 그림이 있는 핀은 **썸네일(클라우드 이미지) 미리보기**, 그 외엔 종류 아이콘(🌐파노라마/🎬영상/📎첨부/📝노트) |
| **클릭 시 PDF 페이지 구분 없이 그 포인트로 줌인 이동** | 항목 클릭 → **다른 페이지면 자동 전환** 후 해당 좌표로 플라이투 줌인 |
| **뷰어도 같이 보는 기능 + 아이콘** | 콘텐츠(360°/노트/첨부) 있는 핀은 이동과 동시에 **360° 뷰어/정보 패널 함께 오픈**(항목의 👁 아이콘) |

### ORCHESTRATOR E2E 교차검증 ✅ (17항목 PASS · 콘솔 에러 0건)
- **진짜 핀 모양**: teardrop SVG + 도넛 홀 렌더, 좌표 정확(30%,30%) ✅
- **전체 핀 드로어**: 버튼 노출·열림·3핀 리스팅·카운트 배지·종류 배지(pano+note) ✅
- **정렬**: 이름순(Alpha→Bravo→Charlie)·번호(페이지)순(P1→P2→P3) ✅
- **검색**: "valve"→1건(Alpha Valve) ✅
- **바로 이동**: 페이지 구분 없이 P1→P3 자동 전환 + 마커 표시 + 드로어 닫힘 ✅

---

## 🧭 전문 PDF/360 뷰어화 — PDF.js 활용도 검토 · 회전 · 썸네일 · 노트/첨부 (2026-06-14)

ORCHESTRATOR_v2 방법론(A 현황분석·B 벤치마크·C 판정·D 역검증·E 서명)으로 **"PDF.js 오픈소스 기능을 제대로 쓰고 있나, 너무 어렵게 가는 건 아닌가"** 를 구성 검토하고, 진짜 전문 뷰어처럼 비주얼/프레임을 정돈했습니다.

### A. PDF.js 활용도 ORCHESTRATOR 판정
| PDF.js 내장 레이어 | 본 시스템(도면+핀 오버레이) 적합성 | 결론 |
|------|------|------|
| **core display layer**(getDocument→getPage→render) | 현재 사용. 핀을 도면 위 절대좌표로 올리는 데 정확·경량 | ✅ 정답 아키텍처 (과설계 아님) |
| 텍스트 레이어(선택/검색) | DOM 텍스트 레이어가 **핀 오버레이와 충돌**, 도면은 텍스트 추출 가치 낮음 | ❌ 미채택(정당) |
| 주석(annotation) 레이어 | **핀 시스템이 곧 주석 시스템** — 이중화 | ❌ 미채택(정당) |
| **회전** `getViewport({rotation})` | 두 줄짜리 내장. 도면 가로/세로 보정에 유용 | ✅ **채택** |
| **썸네일 스트립** | 멀티페이지 도면 탐색의 전문 뷰어 필수 UX | ✅ **채택** |
| 내장 viewer.html | 핀/360 연동 불가(별도 iframe) | ❌ 비양립(정당) |

> **판정:** "core display layer만 사용"은 핀-오버레이 도면 뷰어에 **올바른 설계**이며 과하게 어렵게 간 것이 아니다. 다만 전문 뷰어 체감을 위해 **내장 회전 + 썸네일 스트립**을 추가하는 것이 정확한 방향.

### 추가된 기능
| 기능 | 구현 |
|------|------|
| **PDF 페이지 회전** | PDF.js 내장 `getViewport({ rotation })` 으로 캔버스 재렌더(디자이너 PDF) / 이미지·뷰어 스냅샷은 CSS `rotate`. 90° 단위, nav-toolbar 회전 버튼 + 각도 라벨(클릭 시 0° 리셋) + **단축키 Shift+←/→**. 페이지 자체 회전값(`page.rotate`)과 합산 처리 |
| **멀티페이지 썸네일 스트립** | 좌측 플로팅 패널에 전 페이지 120px 썸네일 렌더, **클릭 점프 + 현재 페이지 골드 하이라이트 + 자동 스크롤**. 2페이지 이상 디자이너 PDF에서만 노출, 1회 캐시 |
| **핀 노트(텍스트) 편집** | 핀 폼에 노트 textarea. 저장 시 `pin.note` 보존, 뷰어 정보 패널에 표시 |
| **핀 첨부 문서**(PDF/Word/Excel/PPT/TXT) | `pano_images` 저장소를 dataURL 범용 문서 스토어로 재사용(`"[doc] "` 프리픽스). 핀당 다중 첨부, 종류별 배지, 뷰어에서 다운로드/새 탭 미리보기 |

### ORCHESTRATOR E2E 교차검증 ✅ (15항목 ALL PASS, 콘솔 에러 0건)
- **페이지 컨트롤**: 3페이지 색채움 PDF → P1 빨강·P3 파랑 **픽셀 검증**, 썸네일 클릭 점프·1페이지 복귀 ✅
- **썸네일 스트립**: 노출(3개)·활성 하이라이트(active=3) ✅
- **회전**: 라벨 90°·캔버스 w/h 스왑(918×1188→1188×918)·360° 원복 0°·치수 원복·라벨 클릭 리셋 ✅
- **회귀**: 노트/첨부 함수(`_confirmPin`/`_renderPanoInfoPanel`/`_openAttachment`/`uploadDoc`/`_addPendingDoc`) 빌드 정상 포함, 콘솔 에러 0 ✅

---

## ⚡ 인터랙션·속도·PDF 안정성 개선 (2026-06-13)

사용자 요청 3건을 반영했습니다.

| 요청 | 개선 내용 |
|------|-----------|
| **① 등록하면 핀 클릭 시 바로 뷰어가 열려야** | 미디어(360° 사진/영상/URL)가 **등록된 핀은 모드 무관 클릭 즉시 360° 뷰어 오픈**. 디자이너 모드에서도 등록된 핀 클릭 = 바로 보기, 미등록(작성 중) 핀만 편집. `App.pinHasMedia()` 판별 도입. 리스트 클릭도 동일하게 동작(이동 후 360° 오픈, 지연 800ms→250ms) |
| **② 속도가 너무 느림** | (a) **PDF.js worker 활성화**(메인스레드 파싱 → 백그라운드 파싱, UI 멈춤 해소) (b) PDF **적응형 렌더 스케일**(캔버스 최대 변 2400px 제한 → 큰 도면도 빠름) (c) 지도 transform **GPU 가속**(`translate3d`+`will-change`) (d) 360° 뷰어 **온디맨드 렌더링**(정지 시 렌더 중단, Vector3 재사용 → CPU/GPU/배터리 절약) |
| **③ PDF 구현이 불안정** | 로컬 번들 worker(버전 3.11.174 일치 확인)를 **절대경로 `/vendor/...`** 로 로드해 뷰어 서브경로에서도 안정 동작. worker 로드/실행 실패 시 **자동으로 메인스레드 파싱(disableWorker)으로 폴백** → 어떤 환경에서도 PDF가 그려짐 |

### 교차검증 결과 ✅ (에러 0건)
- **PDF worker 렌더(Playwright)**: 실제 1.2MB 도면 → **867ms** 렌더, 캔버스 1787×1263(2400px 제한 내) ✅
- **요청1 핀 클릭(Playwright)**: 디자이너 모드 도면 로드 → URL 미디어 핀 등록 → **마커 클릭 즉시 360° 오버레이 오픈** ✅

---

## 🆕 v3 핵심 변경 (요청 반영)

| # | 요청 내용 | 구현 |
|---|-----------|------|
| 1 | 360° 뷰어 성능 (CPU 픽셀루프 버벅임) | ✅ **Three.js SphereGeometry GPU 렌더링**으로 전면 교체 (60fps·모바일 터치) |
| 2 | Ricoh THETA 파일 연동 | ✅ Equirectangular **.jpg/.png** + **.mp4 360° 영상**(VideoTexture) 지원 |
| 3 | 포인트 지정 시 정확한 위치로 이동 | ✅ 클릭 좌표로 **플라이투(flyTo) 줌인 애니메이션** |
| 4 | 핀 형식(드롭 모션) | ✅ 핀 생성 시 **drop 애니메이션** + 포커스 하이라이트 |
| 5 | 그림 파일 저장 + 이름 지정 | ✅ 파일 선택 → **저장 이름 입력** → 리사이즈 |
| 6 | 클라우드 서버 업로드/저장 | ✅ **테이블 API(`tables/pano_images`)에 영구 저장** |
| 7 | 다음 포인트 연속 지정 | ✅ 저장 직후 **"＋ 다음 포인트 지정"** 버튼으로 연속 배치 |
| 8 | 사용자 뷰: 핀 클릭 → 팝업 뷰어 | ✅ 핀 클릭 → 플라이투 → 360° 팝업 자동 오픈 |
| 9 | 뷰어 컨트롤 | ✅ 자동회전·줌±·초기시점·전체화면 컨트롤 바 |

---

## ⚠️ Ricoh THETA 파일 형식별 지원 범위 (정직한 한계)

| 형식 | 지원 | 비고 |
|------|------|------|
| `.jpg` / `.png` (Equirectangular) | ✅ 완전 지원 | GPU 텍스처 매핑, 클라우드 영구 저장 |
| `.mp4` / `.webm` (360° 영상) | ✅ 지원 | `THREE.VideoTexture`. **로컬 파일은 미리보기 전용**(테이블 용량 한계) → 배포용은 **영상 URL 직접 입력** 권장 |
| `.dng` (RAW) | ❌ 불가 | 브라우저에서 RAW 디코딩 불가(서버/네이티브 필요 = 정적 사이트 범위 밖). THETA 앱에서 JPG/MP4로 내보낸 파일 사용 |

---

## 360° 뷰어 구현 방식 (Three.js 표준)

```js
const geometry = new THREE.SphereGeometry(500, 60, 40);
geometry.scale(-1, 1, 1);                       // 구 내부에서 바라보기
const texture  = new THREE.Texture(img);        // 이미지
// const texture = new THREE.VideoTexture(video); // 360° 영상
const material = new THREE.MeshBasicMaterial({ map: texture });
const mesh     = new THREE.Mesh(geometry, material);
// 카메라 lon/lat → 구면 좌표로 lookAt, FOV로 줌
```
→ GPU 가속 + 실시간 60fps + 모바일 터치 전부 해결.

---

## 진입점 (URI)

| 경로 | 설명 |
|------|------|
| `/` → `index.html` | 홈(모드 선택) + 소스 ZIP 다운로드 버튼 |
| `/?mode=viewer` | **일반인 뷰어 전용**(업로드/배포 잠금). `&d` 없으면 **최신** 배포본 자동 로드 |
| `/?mode=viewer&d=<배포ID>` | **특정 배포본 고정 공유 링크**(배포 시 자동 발급). 새 도면을 배포해도 이 링크는 항상 같은 배포본을 표시 |
| `/?demo360=<이미지URL>` | 파노라마 직접 오픈(테스트 훅) |

---

## 워크플로우 (설계자)

1. **도면 업로드** (PDF 멀티페이지 / PNG / JPG)
2. **＋ 위치 포인트 추가** → 도면 클릭 → 클릭 위치로 줌인(플라이투)
3. 폼에서: 위치명 입력 + **그림(.jpg)/영상(.mp4) 파일 선택** + **저장 이름 지정**
   - 또는 **URL 직접 입력**(이미지/영상 자동 판별)
4. **☁ 저장 & 업로드** → 이미지가 클라우드(`pano_images`)에 영구 저장, 핀 드롭
5. **＋ 다음 포인트 지정** → 2~4 반복(연속 배치)
6. **🚀 뷰어로 배포** → 전 페이지 스냅샷 + 핀이 `deployments`에 저장 → 뷰어 링크 발급

## 워크플로우 (일반인 뷰어)

1. `?mode=viewer` 링크 접속 → 최신 배포 도면 자동 로드
2. 핀 클릭(또는 리스트 클릭) → 해당 페이지·위치로 이동 → **360° 팝업**
3. 드래그(시점)·휠(줌)·자동회전·전체화면 컨트롤

---

## 🔧 백엔드 구현 (저장·배포 실동작) — 2026-06-10 추가

> **중요**: 기존 코드는 `tables/*` RESTful 테이블 API에 의존하지만 **백엔드가 없어** 도면 저장·배포·뷰어 로드가 모두 실패했습니다(정적 서버가 존재하지 않는 경로에 HTML을 반환 → JSON 파싱 실패). 이를 해결하기 위해 **Hono + Cloudflare D1(SQLite)** 백엔드를 직접 구현했습니다.

| 구성 | 내용 |
|------|------|
| 프레임워크 | **Hono** (Cloudflare Pages Functions) — `src/index.tsx` |
| 데이터베이스 | **Cloudflare D1** (SQLite) — `migrations/0001_initial_schema.sql` |
| 정적 서빙 | `public/`(index.html·css·js·images)을 Pages 자산으로 자동 서빙, 루트는 워커가 `ASSETS.fetch`로 폴백 |

### 구현된 API 엔드포인트
| 메서드 | 경로 | 설명 |
|--------|------|------|
| `POST` | `/tables/pano_images` | 360° 그림 업로드 → `{id,...}` 반환 |
| `GET`  | `/tables/pano_images/:id` | 단건 조회(`image_data` 포함) |
| `GET`  | `/tables/pano_images` | 목록(`?limit=`) |
| `DELETE` | `/tables/pano_images/:id` | soft delete |
| `POST` | `/tables/deployments` | 배포 생성 → `{id,...}` 반환 (**B1: 이 id가 공유 링크에 박힘**) |
| `GET`  | `/tables/deployments/:id` | 특정 배포본 단건(B1 고정 공유) |
| `GET`  | `/tables/deployments?limit=100` | 목록(`{data:[...]}`, `created_at DESC` 정렬) |
| `DELETE` | `/tables/deployments/:id` | soft delete |

### 로컬 실행 (D1 --local)
```bash
npm run build                       # vite build → dist/
npm run db:migrate:local            # 로컬 SQLite에 스키마 적용
pm2 start ecosystem.config.cjs      # wrangler pages dev dist --d1=webapp-production --local --port 3000
# 또는: npm run dev:sandbox
```
> `npm run db:reset` — 로컬 DB 초기화 후 재마이그레이션

### 전체 동작 흐름 (실제 검증 완료 ✅)
1. **설계자**: 도면 업로드 → 핀 클릭 배치(핀에 위치 이름 풍선 표시) → 360° 그림 파일 선택 → **☁ 저장 & 업로드**(`pano_images`에 영구 저장) → **🚀 뷰어로 배포**(`deployments`에 스냅샷+핀 저장, `?mode=viewer&d=<id>` 링크 발급)
2. **뷰어**: 링크 접속 → 배포 도면 자동 로드 → 도면 위 **핀 + 위치 이름 풍선** 표시 → 핀 클릭 → **360° 팝업 뷰어**(Ricoh THETA 방식 equirectangular, Three.js WebGL)에서 해당 위치 파노라마 재생

---

## 🔁 기능 정합성 2중 검증 루프 (2026-06-13) — "특성상 필요 기능" 토론·교차검증

ORCHESTRATOR_v2 방법론(A작성·B반박·C판정·D역검증·E서명)으로 **이 시스템의 특성상 정말 필요한 기능**을 2중 에이전트가 토론하고 완성될 때까지 루프했습니다.

### 핵심 필요 기능 7가지 (합의·검증 완료)
1. 도면 로드(PDF/PNG/JPG) · 2. 도면 위 핀 좌표 배치 · 3. 핀에 360° 사진/영상 업로드→D1 저장 · 4. 배포(공유 URL 발급) · 5. 뷰어 보기전용 로드 · 6. 핀 클릭→360° 팝업 · 7. 360° 드래그/줌/자동회전/닫기

### 토론에서 발견·수정한 결함 (공유 시스템의 본질 보강)
| 결함 | 내용 | 수정 |
|------|------|------|
| **결함1 (🔴)** | 배포 후 뷰어 링크를 손으로 드래그 복사해야 함 — *공유가 목적*인 시스템에서 치명적 UX 누락 | 배포 완료 메시지에 **"📋 링크 복사" 버튼** 추가 + `App._copyToClipboard()`(Clipboard API → `execCommand` 폴백) |
| **결함2 (🟡)** | 뷰어 첫 진입 시 "핀을 클릭하면 360°가 열린다"는 안내 부재 → 비전문가 혼란 | 배포본 로드 후 **"📍 도면 위 번호 핀을 클릭하면 360° 파노라마가 열립니다"** 안내 표시 |

### 교차검증 결과 ✅ (에러 0건)
- **API 체인(curl)**: 이미지 업로드→`image_data` 복원→배포 생성→**핀 `imageId` 보존** 전부 통과
- **뷰어 UI(Playwright)**: 배포본 로드✅ · 핀 클릭 안내문구✅ · 핀 마커 표시✅ · 편집 UI 전부 숨김(보기전용)✅ · 클립보드 동작✅
- **360° 뷰어(Playwright)**: WebGL 렌더✅ · 줌✅ · 자동회전 ON/OFF✅ · 닫기✅ (픽셀 분석: 수평선 5010px + 구체 1550px)
- B 재공격(XSS/폴백/리스너 누수) 전부 코드상 방어 확인 → **수렴 완료, 추가 유효 결함 없음**

---

## 🩹 안정화 패치 (2026-06-11) — 실파일 E2E 검증 완료

업로드 실패·PDF 무한로딩·뷰어 편집 UI 노출 문제를 모두 수정하고 **실제 파일로 E2E 검증**했습니다.

| 증상 | 원인 | 수정 |
|------|------|------|
| **PDF 무한 로딩 / "Rendering cancelled"** | 외부 CDN worker 차단 + `Promise.race`의 `task.destroy()`가 진행 중 task를 끊음 + 일부 환경에서 `render().promise`가 화면은 그려진 뒤에도 resolve 안 됨 | `PDF.load()`를 **`disableWorker:true`(메인스레드 파싱)** 로 단순화. `renderPage()`는 정상 resolve를 우선 기다리되 **task를 끊지 않는 4초 타임아웃**으로 hang 방지 (이미 캔버스에 그려졌으므로 화면 유지) |
| **3MB+ THETA 업로드 실패/탭 크래시** | `createImageBitmap(file)`로 **원본 풀해상도**(6720×3360 ≈ 90MB 버퍼)를 디코딩하다 메모리 한계로 크래시 | `_decode()`에서 풀해상도 probe 제거 → 처음부터 **`resizeWidth` 지정 축소 디코딩**. `resizeImage()`는 목표 용량(≈1.4MB) 초과 시 품질→해상도 단계 축소 + canvas 면적(2400만 px) 제한 |
| **뷰어에 업로드/편집 UI 노출** ("뷰어는 업로드가 왜 필요하지") | viewer 모드에서 디자이너 전용 섹션 일부만 숨김 | `openApp()`에서 viewer 모드 시 **도면 업로드·위치 포인트 추가·핀 폼·뷰어로 배포·JSON 가져오기 전부 숨김**. 뷰어는 완전 **보기 전용**(핀 클릭 → 360°만) |

### 실파일 E2E 검증 결과 ✅
- **PDF 렌더링**: 실제 1.17MB 도면 PDF → 캔버스 1786×1263 렌더 + 화면 표시 확인
- **디자이너 플로우**: 도면 로드 → 포인트 배치(임시 핀 표시) → THETA 첨부 → `POST tables/pano_images` 업로드 → `🚀 배포`(`?mode=viewer&d=<id>` 발급) **전부 통과**
- **뷰어 플로우**: VIEWER MODE 진입 → **편집 UI 전부 숨김(보기 전용)** → 도면+핀 표시 → 핀 클릭 → `pano-overlay` 오픈 + 저장 이미지 `GET tables/pano_images/<id>` fetch **전부 통과**

> 참고: 헤드리스 샌드박스(총 985MB)에서는 Three.js WebGL 풀 렌더가 GPU/메모리 한계로 크래시할 수 있으나, **핀 클릭→openPano→이미지 fetch→팝업 오픈 로직은 검증 완료**. 실제 데스크톱 브라우저(GPU)에서는 360° 렌더까지 정상 동작합니다.

---

## 데이터 모델 (RESTful Table API)

### `pano_images` — 360° 그림 클라우드 저장
| 필드 | 타입 | 설명 |
|------|------|------|
| id | text | 고유 ID |
| name | text | 사용자 지정 저장 이름 |
| image_data | rich_text | 리사이즈 JPEG dataURL (장변 ≤4096px) |
| width / height | number | 이미지 크기 |

### `deployments` — 배포 스냅샷
| 필드 | 타입 | 설명 |
|------|------|------|
| id | text | 고유 ID |
| title / file_name | text | 도면 제목/원본 파일명 |
| drawing_data | text | 1페이지 스냅샷(레거시 호환) |
| pages_data | rich_text | 전 페이지 스냅샷 dataURL 배열(JSON) |
| pins | text | 핀 배열 JSON `[{id,x,y,page,label,imageId?,imageUrl?,isVideo?,localOnly?,note?,attachments?}]` (배포 시 로컬 영상 `videoUrl`은 제거되고 `localOnly:true`로 마킹). `note`=텍스트 메모, `attachments`=`[{id,name,size,type,docId}]`(첨부 바이너리는 `pano_images`에 docId로 저장) |

---

## 파일 구조
```
index.html      — 메인 HTML (홈/앱/360° 오버레이)
css/style.css   — 전체 스타일
js/main.js      — 앱 로직 (State / PDF / Cloud / PanoViewer(Three.js) / MapCtrl / UI / App)
README.md       — 이 파일
```

## 의존 라이브러리 (CDN)
- **Three.js 0.147.0** — 360° WebGL 파노라마
- PDF.js 3.11.174 — PDF 도면 렌더 (worker 동일 버전 고정)
- JSZip 3.10.1 — 소스 ZIP 다운로드
- Google Fonts (Share Tech Mono / Inter)

---

## 소스 코드 다운로드
- 홈 화면 **「전체 소스 ZIP 다운로드」** 버튼 → `wemare-360-viewer.zip`
- 앱 상단 **「소스 다운로드」** 버튼도 동일

## 배포(라이브 주소)
> 라이브 URL 발행은 **Publish 탭**에서 한 번의 클릭으로 진행됩니다(에이전트가 대신 수행 불가).

---

## 미구현 / 향후
- ⬜ `.dng` RAW (브라우저 한계 — 미지원 확정)
- ⬜ 360° 영상의 클라우드 영구 저장 (현재 영상은 URL 입력 권장)
- ⬜ 핀 드래그로 위치 재조정
- ⬜ 멀티 배포본 갤러리/버전 관리

## 🛠 저장·공유 기능 검토 보고서 반영 (2026-06-10)

`360viewer_저장공유_검토보고서.md`에서 지적된 공유 시나리오 결함을 모두 수정했습니다.

| ID | 등급 | 증상 | 수정 |
|----|------|------|------|
| **B1** | 🟠 G2 | `?mode=viewer` 단일 링크가 항상 "최신" 배포만 로드 → 새 도면 배포 시 기존 공유 링크가 바뀜 | 배포 성공 시 발급 레코드 `id`를 받아 **`?mode=viewer&d=<id>`** 링크 발급. 뷰어는 `d` 우선 로드 후 없을 때만 최신 폴백 (`_deployToViewer` / `loadLatestDeployment`) |
| **B2** | 🟠 G2 | 로컬 영상 핀의 `videoUrl(blob:)`이 배포 JSON에 직렬화 → 다른 세션에서 죽은 URL | 배포 본문 생성 시 `videoUrl` 제거 + `localOnly:true` 마킹 (원본 `State.pins`는 보존) |
| **B3** | 🟠 G2 | 미디어 식별자가 없는 핀 → `loadMedia(undefined)` 호출로 모호한 오류 | `openPano`에 `imageUrl` 분기 + **미디어 없음 명확 안내** 분기 추가 |
| **B4** | 🟡 G3 | `created_at` 정렬이 ISO 문자열이면 `문자열-문자열=NaN`으로 정렬 무효 | 숫자(epoch)/ISO 문자열/이상치 모두 안전 변환하는 `ts()` 정렬 |
| **B5** | 🟡 G3 | 영상 핀 blob URL이 어디서도 `revoke`되지 않아 메모리 누수 | `_videoBlobs` 추적 → `reset()` 일괄 해제 / 핀 삭제 시 즉시 해제 |

> B7(MB 표기 오차)·B8(`Date.now()` ID 충돌)은 표시값/저위험 항목으로, 보고서 권고대로 이번 범위에서는 보류했습니다.

### 검증 시나리오 (보고서 6장 대응)
1. **B1**: 도면 A 배포 → 링크1, 도면 B 배포 → 링크2. 링크1 재접속 시 **여전히 A** 표시 (`&d=<A의 id>` 고정).
2. **B2/B3**: 영상 핀 포함 배포 → 다른 브라우저 접속 → 영상 핀 클릭 시 **"로컬 전용" 안내 메시지**(CORS/로드 실패 대신).
3. **B4**: 배포 N건 후 뷰어(`d` 없이) 접속 → **마지막 배포본**과 일치.
4. **회귀**: 이미지 클라우드 핀 클릭 → 정상 360° 표시(기존 기능 무영향).

---

## 검증
- Three.js GPU 파노라마 / 영상 / 클라우드 업로드 / 플라이투 / 연속 배치 구현
- 수정 로직 단위 테스트(B1/B2/B4 URL·정렬·blob 제거) **전 케이스 통과**
- 정적 서버 구동 + PlaywrightConsoleCapture(홈 / `?mode=viewer&d=...`) — **콘솔 에러 0건**

---

## 🆕 2026-06-15 업데이트 — ezPDF 툴바 · 메뉴 슬림화 · 슈퍼관리자 로그

### ① ezPDF 스타일 상단 PDF 툴바 (`#pdf-toolbar`)
도면 작업뷰 진입 시 상용 PDF 뷰어(ezPDF)와 동일한 **상단 가로 툴바**가 표시됩니다.
- 페이지 썸네일 · 처음/이전/다음/마지막 · 페이지 직접 입력
- 줌 아웃/줌 레벨(클릭=1:1)/줌 인 · 맞춤 · 1:1 · 회전(±90°) · 3D(아이소) 토글
- 우측: **포인트** 마킹 버튼(디자이너 전용)
- 기존 플로팅 `nav-toolbar`는 비활성화하고 상단 툴바로 일원화

### ② 디자이너 메뉴 슬림/심플화
- 사이드바 폭 240→212px, 등록/리스트/영역도구 버튼·행을 컴팩트화
- 점선 업로드 버튼 → 실선(심플), 핀/영역/데크 목록 행 높이 축소

### ③ 슈퍼관리자 활동 로그 관리 ⭐
모든 주요 액션을 기록하고 슈퍼관리자가 검색·필터·삭제·정리합니다.

**기록 대상**: `auth.login`, `access.approve`, `access.reject`, `project.create`, `project.delete`, `deployment.create` (IP·User-Agent 포함)

**API (슈퍼관리자 전용, 미인증 403)**
| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/activity-logs?q=&action=&limit=&offset=` | 로그 목록(검색·필터·페이지네이션) |
| GET | `/api/activity-logs/actions` | 액션 종류별 카운트(필터 UI용) |
| DELETE | `/api/activity-logs/:id` | 단건 삭제(soft delete) |
| DELETE | `/api/activity-logs?all=1` 또는 `?before=<ms>` | 일괄 정리 |

**UI**: 설정 → "접근 권한 관리" 모달의 **활동 로그** 탭 (검색창·액션 드롭다운·정리·더보기·역할 배지·한글 액션 라벨)

**데이터 모델** (`migrations/0006_activity_log.sql`)
```
activity_log(id, ts, actor_email, actor_role, action, target_type, target_id, detail, ip, ua, deleted)
```

### ④ 포인트 생성/이동/삭제 (검증 완료)
드래그 이동(클릭/이동 5px 임계 구분) · 확인 다이얼로그 삭제 · 자동저장 · 토스트.
E2E: 생성 3개→마커/목록 3, 이동 좌표 반영, 삭제 후 2개 — **전 케이스 통과**.

### 데모 토큰
- `demo-designer` / `demo-viewer` / **`demo-super`**(신규, 로그 관리 시연용)

### 향후 (사용자 요청 "나중에")
- ⬜ 전 사용자 Google 로그인 (현재 데모 토큰 + Google OAuth 병행)

## 🆕 엑셀형 포인트 리스트 + 슈퍼관리자 변경 (2026-06-15)
- **슈퍼관리자 이메일**: `designssir@gmail.com` (src/index.tsx, main.js, firebase-config.js, wrangler.jsonc, SETUP.md, index.html 전체 반영)
- **오른쪽 엑셀형 포인트 리스트 패널 (PinGrid)**:
  - 현재 PDF 페이지의 포인터(핀)를 표 형식(# / 이름 / 페이지 / 좌표 / 360°)으로 표시
  - **행 클릭 → 해당 PDF 페이지로 이동 + 핀 포커스(flyTo) + 360° 뷰어 자동 실행** (`App.focusPin(pin, true)`)
  - 포인트 이름 검색, CSV 내보내기, 패널 접기/펴기 지원
  - 페이지 전환 시 자동 갱신(현재 페이지 핀만 표시), 아이보리 테마 일관
- **ORCHESTRATOR_v3 검증 통과 (게이트 5/5)**: 모듈 존재 / 패널 표시 / 행클릭→360 자동실행 / 검색필터 / 접기·펴기 — 콘솔 에러 0
