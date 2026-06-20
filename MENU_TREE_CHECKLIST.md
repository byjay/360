# SEASTAR 360 Location Viewer — 메뉴 트리 & 파일별 역할 & 테스트 체크리스트

> 이 문서는 **향후 프로젝트 업데이트 시 회귀 테스트(체크리스트)**로 사용합니다.
> 각 버튼/메뉴는 `[ ]` 미확인 / `[x]` 통과 / `[!]` 실패 로 표기합니다.
> 최종 갱신: 2026-06-20 · 빌드: dist/_worker.js 71.47kB

---

## 1. 파일별 역할 (public/js/modules/ — 33개 모듈, assemble.py로 main.js 조립)

| 파일 | 담당 역할 |
|------|-----------|
| `00_header.js` | IIFE 헤더 — 전역 네임스페이스 열기 |
| `01_State.js` | 전역 상태(State): 핀/구역/도면/버전/오토세이브 플래그 |
| `02_PDF.js` | PDF 렌더링(pdf.js) — 로컬 워커 우선, 도면 PDF 표시 |
| `03_Log.js` | 사용자 행동 로그(화이트리스트 action 서버 전송) |
| `04_Cloud.js` | 이미지 업로드/디코딩/압축(D1·R2), 캐시 |
| `05_SyncQueue.js` | **오프라인 동기화 큐(IndexedDB)** + 도면 draft 영속 + **재연동 시퀀스** |
| `06_PanoViewer.js` | 360° 파노라마 WebGL 뷰어(Three.js) |
| `07_Radar.js` | 미니맵(도면 썸네일+핀) 레이더 |
| `08_PanoNav.js` | 파노라마 내 핀 간 이동 네비 |
| `09_FLS.js` | **3D 포인트클라우드 뷰어** + CAD 툴바(orbit/pan/section/measure) + **지도핀 마커(수직)** |
| `10_MapCtrl.js` | 도면 2D 지도 컨트롤(팬/줌/flyTo) |
| `11_UI.js` | 핀 렌더링(지도/리스트), 공통 UI 헬퍼 |
| `12_ProjectHub.js` | 프로젝트 허브 화면(카드, 호선 아이콘) |
| `13_Notes.js` | 핀 메모/노트 |
| `14_TimeLapse.js` | 동일 핀 시간순 사진 타임랩스 |
| `15_Compare.js` | 두 사진 비교(슬라이더) |
| `16_Zones.js` | 구역 지정 도구(사각/원/다각형) |
| `17_Inspector.js` | 핀 상세 인스펙터 |
| `18_Brand.js` | 브랜딩(로고/색상) |
| `19_PinGrid.js` | 핀 그리드/바텀시트(모바일) |
| `20_App.js` | **메인 오케스트레이터** — 초기화, 저장, draft flush, 동기화 완료 처리 |
| `21_AllPins.js` | 전체 핀 목록 패널 |
| `22_Auth.js` | 인증(토큰, headers, 역할) |
| `23_PinPrefs.js` | 핀 색상/스타일 선호 |
| `24_Settings.js` | 설정 패널 |
| `25_Designers.js` | 디자이너(설계자) 관리 |
| `26_PdfAnno.js` | PDF 주석 |
| `27_PinActionPop.js` | 핀 액션 팝오버(보기/이동/편집/삭제) |
| `28_AdminPanels.js` | 관리자 패널(기능 토글, 코드맵 등) |
| `29_CompanyAuth.js` | 회사 로그인 게이트 |
| `30_Prompt.js` | 토스트/프롬프트/확인창 |
| `31_Projects.js` | 프로젝트/덱(구역) CRUD |
| `99_footer.js` | 진입점 + `window.__wm` 디버그 훅 |

> **서버:** `src/index.tsx` (Hono) — D1(deployments/pins 등) + R2(이미지/도면) + 낙관적 잠금(version) + 데모 인증.

---

## 2. 메뉴 트리 (화면 → 영역 → 버튼)

### 2-1. 로그인 게이트 (CompanyAuth)
- `btn-checkboard-enter` — 회사 인증 후 진입

### 2-2. 프로젝트 허브 (ProjectHub / Projects)
- `btn-new-project` — 새 프로젝트 생성
- (카드 클릭) — 프로젝트 열기
- `btn-settings` — 설정 패널
- `btn-signout` / `btn-settings-signout` — 로그아웃
- `btn-manage-designers` / `btn-open-designers` — 디자이너 관리

### 2-3. 뷰어/에디터 메인 (App / UI / MapCtrl)
- **상단바**
  - `btn-back` — 허브로 복귀
  - `btn-enter-edit` / `btn-exit-edit` — 디자이너 편집 모드 토글
  - `btn-upload-drawing` — 도면 업로드(PDF/PNG/JPG)
  - `btn-all-pins` → `btn-allpins-close` — 전체 핀 목록
  - `mnav-menu` / `tq-menu` — 모바일/빠른 메뉴
- **지도 컨트롤**
  - `btn-zoom-in` / `btn-zoom-out` / `btn-fit` / `btn-actual` — 줌/맞춤
  - `btn-rotate-cw` / `btn-rotate-ccw` — 회전
  - `btn-iso` — 등각 뷰
- **페이지 네비(다중 도면)**
  - `btn-first-page` / `btn-prev-page` / `btn-next-page` / `btn-last-page`
- **구역 도구 (Zones)**
  - `btn-zone-rect` / `btn-zone-circle` / `btn-zone-poly`
- **핀 배치/편집**
  - `btn-place` — 핀 배치 모드
  - `btn-confirm-pin` / `btn-cancel-pin` — 핀 확정/취소
  - `btn-next-point` — 다음 핀
  - `btn-pin-theta` — THETA 360 사진 첨부
  - `btn-pin-file` / `btn-pin-doc` — 파일/문서 첨부
  - `btn-pin-fls` — 3D 포인트클라우드 첨부
  - `btn-pin-note-toggle` / `btn-pin-url-toggle` — 노트/URL 토글

### 2-4. 360° 파노라마 뷰어 (PanoViewer / PanoNav)
- `btn-pano-close` / `btn-pano-full` — 닫기/전체화면
- `btn-pano-zoomin` / `btn-pano-zoomout` / `btn-pano-reset` — 줌/리셋
- `btn-pano-rotate` / `btn-pano-gyro` — 자동회전/자이로
- `btn-pano-prev` / `btn-pano-next` — 핀 간 이동
- `btn-pano-notes` — 노트

### 2-5. 3D 포인트클라우드 뷰어 (FLS) ★ 이번 업데이트
- **CAD 툴바**
  - `btn-cad-orbit` — 오비트(3D 회전)
  - `btn-cad-pan` — 팬(평행이동)
  - `btn-cad-section` — 단면(클리핑)
  - `btn-cad-measure` — 측정(2점 거리)
- `btn-fls-reset` — 시점 초기화
- `btn-fls-collapse` — 패널 접기/펼치기
- (제거됨) ~~샘플 FLS 불러오기~~ → 핀 첨부 360/3D로만 동작

### 2-6. 타임랩스 / 비교 (TimeLapse / Compare)
- `btn-tl-prev` / `btn-tl-next` / `btn-tl-compare`
- `btn-cmp-close`

### 2-7. 설정 / 관리 (Settings / AdminPanels / Designers)
- `btn-deploy` / `btn-reload-deploy` — 배포/재로드
- `btn-export-json` / `btn-import-json` — 데이터 내보내기/가져오기
- `btn-new-deck` — 새 덱(구역)
- `btn-delete-project` — 프로젝트 삭제
- `btn-open-ai` / `btn-open-codemap` / `btn-open-features` / `btn-open-firebase` — 관리자 도구

---

## 3. 오프라인 → 온라인 재연동 동기화 (핵심 로직)

| 단계 | 동작 | 담당 |
|------|------|------|
| 오프라인 감지 | `navigator.onLine=false` → 배지 "오프라인" | `App._updateSyncBadge` |
| 오프라인 첨부 | 이미지/문서 → `SyncQueue.enqueue` (IndexedDB) | `05_SyncQueue` |
| 오프라인 도면 | 도면+핀+구역 → `SyncQueue.saveDraft` (dirty) | `20_App._saveDraftLocal` |
| **온라인 복구** | `online` 이벤트 → `_onReconnect()` | `05_SyncQueue` |
| ① 첨부 업로드 | `flush()` → `/api/sync/batch` (4개씩 청크) | `SyncQueue.flush` |
| ② 핀 ID 치환 | `pendingOpId` → 서버 `imageId/docId` | `App._onSyncDone` |
| ③ 도면 반영 | draft → PATCH (base_version 낙관적잠금 + 병합) | `App._flushDirtyDrafts` |
| 충돌 처리 | 409 → 서버 핀/구역과 id기반 병합 후 재시도 | `App._mergeById` |

---

## 4. 회귀 테스트 체크리스트 (3중 검증)

> **3중 검증 = ① 코드/함수 레벨(바인딩 존재) + ② E2E 런타임(클릭 fired) + ③ 시각/데이터(스크린샷·상태값)**

### 4-A. 아이콘/버튼 클릭 (E2E)
- [ ] 모든 `btn-*`가 DOM에 존재하고 클릭 핸들러가 바인딩됨
- [ ] 클릭 시 `pageerror` 0건
- [ ] 구역 도구(rect/circle/poly) 클릭 → 도구 활성
- [ ] CAD 툴바(orbit/pan/section/measure) 클릭 → 모드 전환

### 4-B. 360° 사진 워크플로우 (pano-sample.jpg)
- [ ] 핀에 360 사진 첨부 → 파노라마 뷰어 표시
- [ ] 줌/회전/자이로 동작
- [ ] FLS 지도핀이 어느 각도에서도 수직

### 4-C. 오프라인 → 온라인 동기화
- [ ] 오프라인에서 핀/도면 작업 → IndexedDB 저장
- [ ] 온라인 복구 → 첨부 업로드 + 핀ID 치환 + 도면 PATCH
- [ ] 충돌(409) → 병합 후 재시도, 데이터 무손실

### 4-D. 폰트/스타일
- [ ] Pretendard(본문) + JetBrains Mono(좌표) 적용
- [ ] 버튼 글자 또렷(weight 600)

### 4-E. 색상 대비 (검은바탕 검은글씨 방지)
- [ ] 사용자 인증 배지(다크 pill) 안 이름 = 흰글씨
- [ ] 360 노트 패널 / 타임라인 / FLS 헤더(다크 배경) 텍스트 = 흰글씨
- [ ] 데모 모드 배지(다크 pill) = 흰글씨
- [ ] 컬러 배경 버튼(데모/배포 등) = 흰글씨 유지 (정상)
- [ ] 자동 대비 감사(`/tmp/contrast_audit.mjs`)에서 다크배경+다크글씨 0건

### 4-F. Google 로그인 (Firebase 연동)
| 파일 | 역할 |
|---|---|
| `public/js/firebase-config.js` | 마스터가 콘솔에서 복사한 `firebaseConfig` 저장(localStorage) → `FIREBASE_ENABLED` 자동 판정 |
| `public/js/firebase-init.js` | Firebase SDK v10 동적 로드 → `SeaFirebase.loginGoogle()` 등 노출 |
| `22_Auth.js` › `loginWithFirebase()` | Firebase 팝업 로그인 → ID토큰 → `refresh()`로 앱 전체 로그인 반영 |
| `22_Auth.js` › `_doFirebaseLogin()` | 로그인 실행 + 토스트 피드백(성공/실패) |
| `28_AdminPanels.js` › `loginFirebase()` | 설정 모달의 "Google 로그인 테스트" → 실제 앱 로그인으로 연결 |
| `src/index.tsx` › `verifyFirebaseToken()` | 서버: Firebase ID토큰 서명(RS256/X.509) 검증 → email 추출 |

**마스터용 5분 세팅 순서:**
1. console.firebase.google.com → 본인 Google ID로 로그인 → 프로젝트 생성
2. 프로젝트 설정 → 웹앱(</>) 추가 → 표시되는 `firebaseConfig` 전체 복사
3. 앱 → 설정(⚙️) → 🔥 Firebase 연결 → 붙여넣기 → 저장 (자동 새로고침)
4. Authentication → Google 공급업체 사용 설정 / 승인된 도메인에 현재 주소 추가
5. 로그인 게이트의 "Google 로그인" 클릭 → 바로 로그인됨

- [ ] firebaseConfig 저장 → `FIREBASE_ENABLED:true`
- [ ] Google 로그인 클릭 → 팝업 → 앱에 로그인 반영(이름/권한 표시)
- [ ] 서버가 Firebase ID토큰 서명 검증 통과(SPKI import OK)
- [ ] 미설정 시 "Firebase 미설정" 안전 안내(에러 없음)

---
*이 체크리스트는 매 업데이트마다 갱신하여 회귀를 방지합니다.*
