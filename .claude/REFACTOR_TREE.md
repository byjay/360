# SEASTAR 360 — 트리 구조 / 파일 분할 설계 (한 파일 = 한 기능)

> 원칙: 500줄 초과 → 분할 권장, 1000줄 초과 → 분할 필수. 한 파일 한 책임. 분할 전 백업.
> 백업: `_archive/pre-refactor-20260621/` (41파일, 2026-06-21).

## 현황 (줄수)
- 클라 모듈 35개 중 **32개 이미 ✅**(단일책임, <500줄). 트리 이미 양호.
- 🔴 분할필수: `src/index.tsx`(2073), `public/js/modules/20_App.js`(2909)
- 🟡 분할권장: `public/js/modules/09_FLS.js`(662)

---

## A. src/index.tsx (2073줄) → 서버 모듈 분할 [Hono app.route]
```
src/
├─ index.tsx              # 엔트리: Hono app 생성 + 미들웨어 + 라우트 마운트(슬림)
├─ lib/
│  ├─ auth.ts             # verifyGoogleToken·verifyFirebaseToken·getUser·isDesigner·roleOf·isSuperAdmin·superAdminList·데모토큰
│  ├─ tenant.ts           # tenantOf·visibleProjectFilter·canManageProject·DEFAULT_TENANT
│  ├─ crypto.ts           # b64url·decodeJwt·hashPassword(PBKDF2)·importX509·getGoogleKeys·getFirebaseCerts
│  └─ activity.ts         # logActivity + mapProject·mapDeck·mapDeployment
├─ routes/
│  ├─ auth.ts             # /api/auth/me·/api/auth/config
│  ├─ signup.ts           # /api/signup/* (회사 자체가입)
│  ├─ projects.ts         # /api/projects/* (CRUD·members·publish·decks)
│  ├─ deployments.ts      # /tables/deployments/* + /ops (오프라인 멱등)
│  ├─ pano.ts             # /tables/pano_images + R2 media
│  ├─ notes.ts            # 핀 노트(이슈)
│  ├─ admin.ts            # /api/designers·allowed-domains·invites·local-users·activity-logs·access-requests
│  └─ ai.ts               # /api/ai/config·chat
```
> Hono: 각 routes/*.ts가 `const r = new Hono()` 후 핸들러 등록 → index.tsx에서 `app.route('/', authRoutes)` 마운트. lib/*는 순수함수 export.

## B. 20_App.js (2909줄) → App 오케스트레이터 분할 [Object.assign 청크]
> 조립방식(assemble.py가 _manifest.txt 순서로 concat, 단일 IIFE scope)이라
> `const App = {코어}` 후 후속파일은 `Object.assign(App, {청크})` 로 분할.
```
public/js/modules/
├─ 20_App.js             # App 코어: init·_applyMode·showScreen·라우팅·생명주기 (~400줄)
├─ 20a_AppDrawing.js     # 도면 로드/렌더/스냅샷·_loadDrawing·PDF/이미지 (~400줄)
├─ 20b_AppPin.js         # 핀 등록/편집·_confirmPin·_confirmPinInstant·_uploadPinImageBg (~500줄)
├─ 20c_AppDeploy.js      # 배포·_deployToViewer·loadLatestDeployment·뷰어로드 (~400줄)
├─ 20d_AppSync.js        # 오프라인 동기화·_flushDirtyDrafts·_onSyncDone·_saveDraftLocal (~400줄)
└─ 20e_AppPano.js        # 파노 진입·openPano·resolvePanoSource (~300줄)
```
→ `_manifest.txt`에 20a~20e를 20_App.js 직후 순서로 등록.

## C. 09_FLS.js (662줄) → 🟡 경계. 기능 응집 높으면 보류, 분리 가능하면 09_FLS.js + 09a_FLSxxx.js.

---

## 실행 순서 (하나씩 백업·검증)
각 단계: ① 대상 백업 → ② 분할 → ③ assemble/build → ④ 정적+런타임 검증 → ⑤ 무회귀 확인 후 다음.
1. **src/index.tsx → lib/* 추출**(순수함수 먼저, 저위험) → build 검증
2. **src/index.tsx → routes/* 분할**(app.route 마운트) → E2E 검증
3. **20_App.js → 20a~20e 분할**(Object.assign 청크) → assemble/build/런타임 검증
4. 09_FLS.js 검토
> ⚠️ 각 단계는 작동본을 깨지 않게 빌드/E2E 통과 후에만 다음. 실패 시 백업 복원.
