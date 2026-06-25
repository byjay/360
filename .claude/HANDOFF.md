# HANDOFF — 360° Location Viewer (SEASTAR)

## 마지막 커밋
- HEAD `4053b05` feat(invite): 멤버 초대 — 계정 자동생성(비번1)+역할+편집권한+비번변경 (2026-06-25)
- `7286232` fix(hub): 프로젝트 카드 액션 아이콘 축소
- `7488c31` feat(design): 골드 잉크 토큰(--gold-ink) + 모바일 active 인디케이터
- `4206776` fix(mobile): 하단 네비 active 대비/FAB 겹침
- `d28635f` fix(mobile): 메뉴/팝업 화면 가림 결함 + 핵심 도구 하단 아이콘화
- `3fcce81` feat(viewer): 핀 진짜 3D 박힌 핀(ISO 32° 기립)
- `dbd1029` feat(viewer): 핀 선택 자동 ISO + 구역 확대
- `cfa34cc` feat(access): 프로젝트별 접근 신청 흐름 (SEcMS 패턴)
- `1e0dead` feat(ui): 모바일 아이콘/버튼 개선

## ⚠️ 배포 전 D1 마이그레이션 적용 필요 (마스터 직접)
```
npx wrangler d1 execute webapp-production --file=migrations/0019_project_access_requests.sql
npx wrangler d1 execute webapp-production --file=migrations/0020_must_change_password.sql
```
미적용 시: 0019→접근신청 API 오류, 0020→비번변경 강제 미작동(코드는 SELECT * 라 로그인 자체는 안전).

## 이번 턴 ⑱: 멤버 초대(계정 자동생성+비번1+역할+편집권한) (2026-06-25)
> 마스터: "초대하면 그 메일로 바로 로그인(비번 처음 1, 사용자 변경), 뷰어/디자이너 선택, 로그인만으로 프로젝트 접근, 디자이너=모든 구역 세팅, designssir만 최고관리자"
- ✅ POST /api/projects/:id/members 확장: 로컬계정 없으면 비번 '1' 자동생성(must_change=1) + role
- ✅ migration 0020: local_users.must_change_password
- ✅ POST /api/account/password: 본인 비번 변경(로컬계정) → must_change=0
- ✅ login/세션 응답 must_change 노출 → 첫 로그인 시 비번변경 모달 강제(#pwchange-modal, 닫기 없음)
- ✅ designer 초대 → designers 테이블 등록(requireDesigner 통과 = 모든 구역 편집). viewer 재배정 시 project-invite designer 회수. (deployment 는 project_id 없이 tenant 단위라 전역 designer 부여로 해결)
- ✅ designssir 최고관리자 불변(isSuperAdmin)
- 검증: tsc(src 클린, _code-export/_archive 무관), vite build EXIT 0(99kB). 라이브(로그인+초대 흐름)는 D1 migration 후 마스터 확인 필요.
- `a1463c2` fix(load): 저장된 구역·도면 로딩 3건 + 설치 버튼 터치 수정
- `192dcbf` feat(pin): 핀(호스팟)별 아이콘 선택 + 디자인 스킬 아이콘 10종

## 이번 턴 ⑰: 프로젝트별 접근 신청 흐름 구현 (2026-06-24)
> 마스터: "swcms같이 프로젝트공별로 구글 로그인시 사용신청하게하고 관리자가 미리등록했다면 바로입장"
- ✅ `migrations/0019_project_access_requests.sql` — `project_access_requests` 테이블 + 인덱스
- ✅ `GET /api/projects` 교체: 배포 프로젝트는 비멤버도 보임(잠금 상태), `is_member` + `my_request` 필드 추가
- ✅ `POST /api/projects/:id/request-access` — 비멤버 접근 신청 (upsert, 중복 신청 → pending 재활성화)
- ✅ `GET /api/projects/:id/access-requests` — 관리자용 신청 목록
- ✅ `POST /api/projects/:id/access-requests/:rid/approve|reject` — 승인(viewer 자동배정) / 거절
- ✅ `GET /api/admin/project-access-requests` — 관리자 전체 신청 뷰(슈퍼=전체, 일반=내 프로젝트)
- ✅ `12_ProjectHub.js`: 비멤버 카드에 잠금 오버레이 + hover 시 CTA, `openAccessReq()` 모달
- ✅ `proj-members-modal` 안에 접근 신청 대기 섹션 (관리자가 바로 승인/거절)
- ✅ Designers 모달에 "프로젝트 신청" 탭 추가 + `loadProjRequests()`
- ✅ CSS: 잠금 오버레이, 신청 모달, 관리 패널 스타일
- ✅ assemble + vite build EXIT:0 + MIRROR 완료
- **배포 주의**: D1에 `migrations/0019_project_access_requests.sql` 를 마스터가 직접 wrangler로 실행 필요
  ```
  npx wrangler d1 execute webapp-production --file=migrations/0019_project_access_requests.sql
  ```

## 이번 턴 ⑯: 전수 병렬 버그헌트(4에이전트) + 수술수정 3건 (2026-06-21)
> 마스터: "한 파일 하나하나 다 검증하고 버그 찾아." 4에이전트(서버+마이그/20_App/클라모듈/HTML·CSS) 전수 헌트. (4번째 레이트리밋.)
- **수정·검증(3건)**:
  - 🔴 **H3 프로젝트삭제 소유권**: `DELETE /api/projects/:id`가 requireDesigner만 → **아무 디자이너나 남의 프로젝트(+데크) 삭제 가능**. canManageProject 추가. E2E: 비소유403/소유200.
  - 🔴 **A SyncQueue.enqueue 손실**: IDB 트랜잭션 동기 throw(모바일 백그라운드) 시 op 영구손실 → try/catch + localStorage 폴백.
  - 🟠 **UI null-deref**: renderPinList가 도면 미로드 화면(Notes.loadSummary 경유)에서 list/State.pins null 크래시 → 가드.
- **확인된 양호**: 인증헤더 누락 클래스 전부 수정됨(잔존0). util.ts import 정상. 4티어 역할모델 일관. PinIcons 3-arg 일관. SQL injection 0(전부 bound). 스키마-코드 컬럼 일치(phantom 0).
- **🟡 마스터 결정/추가수정 필요(플래그)**:
  1. **C1 관리자 티어 정책**: /api/designers POST/DELETE·access-requests/approve가 requireAdmin → 일반관리자가 디자이너 지정·escalation 가능(ADMIN_EMAILS 빈값이라 현재 잠재). super 전용으로 할지 결정.
  2. **H4 pano_images 무인증 공개**: GET /tables/pano_images(+:id) 인증·테넌트 없음 → 360 이미지 전체 열람가능(deployments over-share와 동급). 게이팅하려면 클라 Cloud.fetchImage 헤더 동반 필요(신중).
  3. **H1 local_users 테넌트 미격리**: 자체가입이 tenant_members 미삽입 → 전부 tnt_default.
  4. **M4 allowed-domains DELETE `OR domain`**: 도메인명 매칭 시 전 프로젝트 일괄삭제.
  5. **20_App BUG3**: 409 머지가 배열 교체 → 백그라운드 업로드중 핀 객체 orphan→사진손실. BUG5 focusPin onerror 없음→행. BUG B SyncQueue poison-op 무한재시도.
  6. 저위험 null-deref 군집(13_Notes:68·17_Inspector·27/21/29/25/28) — DOM 드리프트시 throw.

## 이번 턴 ⑮: 리팩토링 1단계 실행(lib 추출 패턴 검증) (2026-06-21)
> 마스터: SEcMS 패밀리룩 30%도 안 됨. 순서=트리구조 완벽세팅 먼저→비주얼 패밀리화→전기능 클릭테스트.
- **리팩토링 패턴 검증 완료**: `src/lib/util.ts` 신설(normEmail·emailDomain·isValidEmail·gen6·randToken·bufToHex·hashPassword·verifyPassword 8개 순수함수 추출) + index.tsx 상단 import. **@hono/vite-build가 ./lib import 정상 번들** → 빌드 EXIT:0, worker static OK, 런타임 무회귀(ROOT200·auth super·signup policy200). src/index.tsx 2073→2062.
- → 이제 동일 패턴으로 crypto/auth/tenant lib + routes 8분할 + 20_App.js 청크분할 안전 진행 가능(REFACTOR_TREE.md 순서).
- **남은 트리작업**: lib/crypto·auth·tenant·activity 추출 → routes/ 8파일 분할(app.route 마운트) → 20_App.js 20a~20e 청크. 각 단계 빌드/E2E 검증.
- **남은 비주얼(트리 후)**: SEcMS 패밀리룩 본격 적용 — 상단 리본 TopNavBar(2행)·메뉴스타일·고밀도 리스트(.fl-table 실적용)·전체 레이아웃. 현재 버튼/관리자행만 적용됨(30%).
- **남은 검증**: 전 기능 클릭 테스트(메뉴↔핸들러 1:1).

## 이번 턴 ⑭: 4티어 역할모델(super/admin/designer/viewer) + 리팩토링 기반 (2026-06-21)
> 마스터 명확화: 슈퍼관리자=마스터 전용 / 일반관리자=별도 티어 / 디자이너=관리자 아님(설계만) / 뷰어. + 한파일=한기능 트리 리팩토링.
- **4티어 역할모델 구현·검증**:
  - 서버: `adminList(c)`(env ADMIN_EMAILS 쉼표) + `isAdmin(c,email)`(슈퍼∪일반관리자) + `requireAdmin(c)`. `roleOf` 4티어(super>admin>designer>viewer). `isDesigner`에 isAdmin 포함(관리자≥디자이너). 관리자 18개 엔드포인트 `requireSuper`→`requireAdmin`(기본 ADMIN_EMAILS 빈값=슈퍼/마스터만="오직 나만", 마스터가 일반관리자 지정 시 확장).
  - 클라: Auth `isAdmin` getter + `_roleLabel()`(슈퍼관리자/관리자/디자이너/뷰어) + 관리자패널 버튼 게이트 isSuper→isAdmin. role-admin 배지 CSS(네이비).
  - **E2E PASS**: super→super / designer→designer / viewer→viewer. **관리자패널 super200·디자이너403**(디자이너≠관리자) / **디자이너 설계 POST 200**(설계는 가능). 빌드 EXIT:0.
- **리팩토링 기반(턴⑬ 이어)**: 전체 백업 `_archive/pre-refactor-20260621/`(41파일) + 트리설계 `.claude/REFACTOR_TREE.md`. 분할대상=src/index.tsx(2073)·20_App.js(2909)만(클라 32/35 이미 단일책임). 실행순서: lib추출→routes분할→App청크. 다음 집중세션 권장(작동본 정밀수술).

## 이번 턴 ⑬: 병렬 버그헌트(3에이전트) + 치명버그 3건 수정 (2026-06-21)
> 마스터: "점검해보자 버그 더 천천히 병렬 검증." 3개 병렬 에이전트(auth·contract·offline) 버그헌트.
- **🔴 FIX1 (CRITICAL) 뷰어 도면로드 불가**: `20_App.js` `/tables/deployments` GET **4곳(2396·2500·2817·2823) 인증헤더 누락** → 서버 auth-게이트 후 401 → 뷰어 공유링크 완전 작동불가. `headers:Auth.headers()` 추가. E2E: 미인증401→뷰어토큰200.
- **🔴 FIX2 (CRITICAL) 오프라인 사진 영구손실**: `_onSyncDone`이 pendingOpId→imageId 스왑을 메모리만 갱신, 영속화 안 함 → 탭 닫으면 서버엔 죽은 pendingOpId만 남음. `_autoSave()` 추가.
- **🟠 FIX3 (HIGH) tombstone 부활**: ops 머지 upsert 분기가 ts 비교 없이 삭제된 핀 재생성 → 늦게 온 옛 upsert가 삭제 무효화. `cur._deleted && opTs<cur.ts` 가드 추가. E2E: 삭제(300)후 옛upsert(250)→삭제유지✅.
- 빌드 EXIT:0, 무회귀(카드4 로드, 콘솔에러0).
- **🟡 마스터 확인필요(미수정·플래그)**:
  1. **deployments 목록 over-share**: `GET /tables/deployments`가 tenant까진 막지만 project-publish/membership 미적용 → 같은 회사(tenant) 뷰어가 미배포 프로젝트 도면도 목록열거 가능. (회사간=tenant로 차단됨. 회사내 over-share. deployment→deck→project→published 스코핑 필요 = 신중한 설계변경.)
  2. **demo-super 운영리스크**: 프로덕션에 `DEMO_LOGIN=0` 필수 — 안 하면 `Bearer demo-super`=즉시 슈퍼관리자. (배포 체크리스트.)
  3. project-designer 멤버가 designer 역할 재부여 가능(프로젝트 내 lateral). 저위험.
  4. 저위험: equal-ts 비결정성, applied_ops per-deployment 키잉, tombstone GC 없음.

## 이번 턴 ⑫: SEcMS 슈퍼관리자 차용 + scan.seastar.work + 배포기능 테스트 (2026-06-21)
> 마스터: "scan.seastar.work로 해라. 슈퍼관리자모드 SEcMS에서 차용. 프로젝트 생성후 배포기능 점검 테스트."
- **SEcMS 슈퍼관리자 패턴 차용**: SEcMS `functions/lib/superAdmin.ts isSuperAdminEmail` 멀티이메일 allowlist를 360에 이식 — `superAdminList(c)`+`isSuperAdmin(c,email)`(env SUPER_ADMIN_EMAILS 쉼표구분 + SUPER_ADMIN_EMAIL 합산). 기존 단일비교 10곳(roleOf/isDesigner/requireSuper/visibleProjectFilter/canManageProject 등) 전부 isSuperAdmin으로 교체. 검증: super 200/designer 403, demo-super role super.
- **scan.seastar.work 설정**: wrangler.jsonc vars `PRIMARY_DOMAIN=scan.seastar.work`·`SUPER_ADMIN_EMAILS`. `/api/auth/config`에 primary_domain·firebase_project_id 노출. ⚠️ Firebase Console(sedmsys) 승인도메인 + CF Pages 커스텀도메인 연결은 마스터 콘솔.
- **배포(Publish) 기능 E2E PASS**: 설계자 로그인→프로젝트 생성("ER1 기관실 360 배포점검")→배포버튼 클릭(togglePublish)→published false→true→"● 배포됨" 배지+버튼 골드활성. **뷰어=배포된 1개만 / 미배포3개 숨김 / 설계자=4개 전부**. 마스터 워크플로 완전 작동.
- 빌드 EXIT:0. (SEcMS Control Tower 풀대시보드는 ~1,200줄 큰빌드 — 다음 집중세션 권장. 슈퍼관리자 게이트/Designers패널은 작동.)

## 이번 턴 ⑪: SEcMS 패밀리룩 실적용(버튼·리스트) + 회귀수정 (2026-06-21)
> 마스터 질책: 패밀리토큰 만들고 실제 적용 안 함 + 버튼/리스트 "구리". SEcMS처럼 구현 + 슈퍼관리자/관리자등록/권한관리.
- **🔴 회귀 수정(턴④ 부작용)**: `ProjectHub.load()`·`Projects.load()`가 `/api/projects`를 **인증헤더 없이** fetch → 턴④의 멤버십/배포 스코프 필터가 익명취급 → **설계자 카드 0개**(프로젝트 안 보임). `headers:Auth.headers()` 추가로 수정. 검증: 카드 4개+배포버튼 정상 렌더.
- **SEcMS 품질 버튼 실적용**(family-tokens.css, !important override 안전): `.btn-demo-designer`·`.hub-btn-new`·`.signin-invite-btn`·`.access-submit`·`.btn-deploy` → **골드 그라데이션(#d8a83e→#b8851f) + 샤프 2px + 인셋 하이라이트 + weight800**. 고스트(둘러보기/취소/로그아웃) → 크림+골드hover. 카드 액션 샤프2px. 검증: "설계자 모드"·"새 프로젝트" 골드 그라데이션 렌더(스샷).
- **SEcMS 품질 리스트행**: `.designer-row`·`.member-row`·`.domain-row`·`.invite-row`·`.adm-req-row`·`.log-row` → 회색바 → **흰 면 + 골드 좌측 액센트 3px + 샤프 + hover**(SEcMS path-item). 신청 상태별 좌측색(blue/teal/red). 탭 active 골드 언더라인. 검증 스샷.
- **관리자 기능 현황**: Designers 패널 5탭 이미 존재 — 디자이너관리(등록/해제)·사용신청승인·회사도메인(프로젝트별)·가입사용자·활동로그. 슈퍼관리자 designssir@gmail.com. project_members 백엔드(턴④) 준비됨.
- 빌드 EXIT:0. 정크 프로젝트 정리.
- **남은(다음)**: ①핀리스트/AllPins에 .fl-table 적용 ②**프로젝트별 멤버 배정 UI**(project_members 백엔드 준비됨, 화면만) — 관리자가 "어느 프로젝트에 누구를" 시각 배정.

## 이번 턴 ⑩: 모바일 + 오프라인→동기화 집중점검 (2026-06-21)
> 마스터: "모바일버전 + 오프라인 작업후 연동이 핵심 — 집중점검."
- **모바일 레이아웃 무결**(375px): 가로 오버플로 없음(scrollW=clientW=375), authbar flex, +새프로젝트 풀폭버튼, 텍스트 줄바꿈 정상. 360 뷰어 모바일 정상(텍스처 5376×2688, ISO4뷰·자이로·줌 컨트롤, 자이로=폰기울임 둘러보기).
- **오프라인→재연결 동기화 E2E PASS**(킬러기능): 오프라인 전환→net-badge "오프라인" 표시→OpLog.record(핀)→IndexedDB→온라인 전환→_onReconnect→_flushOpLogs→**서버 version 0→1, 핀 동기화 성공, applied_ops 멱등원장 기록**. (배지: 온라인 시 display:none 정상 — false alarm 아님.)
- **동기화 체인 견고성 확인**: online이벤트→_onReconnect→SyncQueue.flush→App._flushDirtyDrafts→App._flushOpLogs + 30s 안전망 + App 자체 online리스너.
- **모바일 폴리시 수정**: 파노 헤더 위치명이 좁은폭 줄바꿈되던 것 → seastar-family-tokens.css에 `@media(max-width:640px){.pano-location{nowrap+ellipsis+12px+max44vw}}` 가산(안전 override). 검증: 긴 위치명도 single-line(높이18px) ellipsis.
- 빌드 EXIT:0. 전 점검 ALL PASS.

## 이번 턴 ⑨: Firebase(sedmsys) 등록 → Google 로그인 활성 + 360파일 테스트 (2026-06-20)
> 마스터: "Firebase까지 등록. scan.seastar.work로 배포." + "내가 준 파일로 테스트해봐".
- **360 파일 테스트 PASS**: 마스터 360사진(pano-test-1~5.jpg) = 5376×2688 ratio2.00 완벽 equirectangular(THETA Z1). PanoViewer.load 구동 → WebGL 구체 텍스처 5376×2688 매핑, 캔버스표시·로딩종료·에러없음. **스크린샷=기관실 ER1 360 정상 렌더**(ISO4뷰·자이로·줌 컨트롤 전부). 테스트 PDF 생성(public/samples/test-drawing.pdf 696B).
- **Firebase 등록 완료(패밀리 공유 sedmsys)**: `public/js/firebase-config.js __FB_DEFAULT`에 sedmsys 실값 주입(apiKey AIza…hDO4 / authDomain sedmsys.firebaseapp.com / projectId sedmsys / sender 791527222293 / appId …8ff21c, 출처 sedms_G/.env.local). 웹 apiKey=공개식별자.
- **서버 하드닝**: `verifyFirebaseToken(token, expectedProjectId)` — iss=securetoken.google.com/sedmsys + aud=sedmsys 강제(타 프로젝트 토큰 차단). wrangler.jsonc vars `FIREBASE_PROJECT_ID=sedmsys`.
- **검증**: 빌드 EXIT:0. 런타임 `FIREBASE_ENABLED=true`·`Auth.firebaseEnabled=true`·projectId sedmsys·SeaFirebase 로드. auth-hint "Google 계정으로 로그인 (Firebase 연결됨)". CSS 정상.
- 🔴 **마스터 액션(Firebase Console sedmsys)**: 현 승인도메인 = localhost/sedmsys.firebaseapp.com/seastar.work/secms.tech/sedms.app/sedms.pages.dev/dms-3r0.pages.dev. **`scan.seastar.work` 미등록** → Authentication→설정→승인된 도메인에 **추가해야** 그 도메인에서 Google 로그인 작동(미등록 시 auth/unauthorized-domain). localhost는 됨(테스트 가능).
- **배포 도메인 = scan.seastar.work**(설계자/스캔 대시보드). CF Pages 커스텀도메인 연결 + 실제 D1 database_id 필요(마스터).

## 이번 턴 ⑧: 창고규율 + 기능안정화 전수E2E + 빌드 (2026-06-20)
> 마스터 질책: `_warehouse` 규율 2-0(새 기능 전 창고검색)을 안 지킴. + "기능안정화·빌드완료·구글인증 완료".
- **창고 검색 수행**(반출토큰 보유 확인): 관련부품 = `auth/sdk/auth-client.js`(OAuth클라 PURE), `auth/functions/_lib/rbac.js`(RBAC PURE)·`rate-limit.js`(PURE)·`totp.js`(MFA), `SEDMS_G/.../tenant.ts`·`lockoutGuard.ts`, `06-state-config/uiTokens.ts`. **대부분 SSO-Hub 모델용** → 360 GIS(독립) 방식엔 드롭인 아님. RBAC·rate-limit·lockout은 다음 인증-하드닝 패스에 적용 예정(안정화 우선이라 지금 주입 보류).
- **기능안정화 전수 E2E ALL PASS**: ROOT/family-css 200, 역할 super/designer/viewer, S1 미인증401, 권한게이트 designer200/viewer403, 배포게이트 배포전0→배포후1, 멤버1, ops멱등 v1=1 v2=1, annotations 왕복보존.
- **빌드**: 클린 재조립+MIRROR+migrate(no-op)+build EXIT:0, main.js·worker static OK.
- **🔴 구글인증 완료 — 코드 완성, 자격증명만 잔여**: getUser→verifyGoogleToken(aud)→isDesigner→roleOf 전부 검증됨(GIS+Firebase). 라이브 차단요소 = 실제 Google Client ID(마스터 콘솔에서만 생성). 2경로: (A)마스터가 Client ID 제공→`/api/auth/config` 또는 index.html:32 (독립 유지), (B)auth-hub(auth-hub-bk3.pages.dev, 이미 Google 작동) SSO 연동 — 창고 `auth-client.js` 드롭인, 즉시 라이브하나 hub 결합(독립 결정과 상충). → 마스터 결정 대기.

## 이번 턴 ⑦: 패밀리룩 기반(SEcMS 구조패턴) + 경로정정 (2026-06-20)
> 마스터: "secms처럼 패밀리룩 — 아이콘 스타일·리스트 구현방식 등 모든 걸". 경로 정정: sedms(소문자)=없음, 실체는 `E:\code-project\SEcMS`(디자인기준, React) + `E:\code-project\sedms_G`(Hono). 메모리 저장(family-project-paths, secms-family-look-spec).
- **마스터 결정**: SEcMS의 **구조패턴만 채택**(샤프 2px·고밀도 리스트·대문자헤더·tabular-nums·일관 아이콘), **360 아이보리/골드 브랜드는 유지**(풀 컬러플립 X).
- **패밀리 토큰 파일 신설**: `public/css/seastar-family-tokens.css` — SEcMS 기하/밀도(uiTokens 추출) + 360 골드 매핑. `.fl-table`(고밀도 그리드: 대문자헤더·zebra·hover·골드언더라인), `.fl-num`(tabular-nums 우정렬), `.fl-head`·`.fl-chip`·`.fl-icon`(24x24 stroke2)·`.fl-btn`. **ADDITIVE**(style.css 위, 덮어쓰기 X) → index.html 가산 import.
- 검증: 빌드 EXIT:0, dist 포함·서빙200, **가산 무회귀**(bg ivory 유지, --fl-radius=2px·.fl-chip 골드 radius2px 해석, CSS룰 1491). 
- **남은 작업(다음 세션 집중 권장 — 현 컨텍스트 깊음)**:
  1. 패밀리룩 **컴포넌트 opt-in 적용**: 핀 리스트·AllPins·Designers/AdminPanels 테이블 → `.fl-table`, 배지 → `.fl-chip`, 섹션헤더 → `.fl-head`. (style.css 직접수정 아닌 클래스 부여 → 저위험)
  2. **관리자 모드**: 프로젝트별 도메인/이메일 접근설정 UI + 멤버배정 UI(서버 준비됨: project_members, allowed_domains.project_id).
  3. **배포 도메인**(projects.domain) + Cloudflare 배포/APEX(마스터 CF 자격증명·real D1 id 필요).

## 이번 턴 ⑥: 프로젝트 배포(Publish)→뷰어 공개 워크플로 (2026-06-20)
> 마스터 워크플로: 설계자 모드에서 설계·핀·등록 완료 → 배포(Publish) → 권한받은 뷰어가 그 프로젝트 열람.
- **서버(완성·E2E검증)**: 마이그 `0015_project_publish.sql`(published/published_at/published_by). `POST /api/projects/:id/publish|unpublish`(canManageProject 게이트). `visibleProjectFilter`에 published 게이트: 설계자(전역/소유자/designer·editor멤버)는 미배포 포함 전체, 순수 뷰어는 배포된 것만. mapProject published 노출.
  - E2E PASS: 배포前 뷰어0 / 배포 published=true / 배포後 뷰어1 / 배포취소後 뷰어0 / 소유설계자 자기미배포 1.
- **클라(구현)**: ProjectHub 카드에 배포버튼(`data-act=pub`, 골드 강조)+`● 배포됨` 배지 + `togglePublish()`(publish/unpublish 토글, 확인다이얼로그, 토스트). CSS `.hub-card-pub/.is-pub/.hub-pub-badge`. 빌드 EXIT:0 / 콘솔에러0. (시각 스크린샷은 preview 캡처 간헐 타임아웃 — 코드·서버E2E로 검증됨)
- **🔴 마스터 신규 대형 배치(다음, 미착수)**:
  1. **관리자 모드** — 프로젝트별 "어느 회사도메인/이메일이 로그인 가능" 설정 UI. (기반: `allowed_domains.project_id`·`invited_users.project_id` 이미 존재, project_members 턴④. 관리자 화면+적용만)
  2. **배포 도메인 설정** — 프로젝트별 어느 도메인으로 배포할지(projects.domain 컬럼 + UI).
  3. **Cloudflare 프로덕션 배포 + APEX** — ⚠️ 마스터 CF 대시보드 필요(apex DNS·real D1 database_id). 앱측 설정필드는 빌드 가능, 실제 DNS/배포는 마스터 자격증명.
  4. **SEcMS 패밀리룩** — SEcMS 프로젝트 디자인 참조해 아이콘스타일·리스트구현방식 통일.
  → 컨텍스트 한계로 위 배치는 다음 세션 집중 권장(품질). 우선순위: 관리자모드 도메인접근 UI → 배포도메인 → 패밀리룩 → (배포는 마스터 트리거).

## 이번 턴 ⑤: 설계자모드 직접진입 + Cloudflare 프로덕션 빌드 (2026-06-20)
> 마스터: "클라우드(Cloudflare) 빌드부터 하고 보고. 설계자 체험이 아니라 설계자 모드로 바로 진입. 뷰어가 설계자 프로젝트로 진입하는 부분은 별도 분리(예정)."
- **"설계자 체험" → "설계자 모드" 직접진입**: 허브버튼(`설계자 모드`)·게이트버튼(`설계자 모드로 진입`)·데모배지(`설계자 모드 — 도면·핀·프로젝트 편집 중`)·표시명(DEMO_DESIGNER name `데모 설계자`→`설계자`) 전부 "데모/체험" 프레이밍 제거. 클릭→role:designer 즉시 진입 + "+새 프로젝트" 노출 E2E 검증(mcp Preview).
- **Cloudflare 프로덕션 빌드**: BUILD_EXIT:0, `dist/_worker.js` **79.33 kB**, css 209KB·index 114KB·main.js 508KB. dist 무결성: 설계자모드8/체험0, project.member, 핀360ISO, 오프라인OpLog, PWA, auth config 전부 반영.
- CSS 정상 재확인(ivory 1471룰, 콘솔0) — 빌드 후에도 무회귀.
- **다음(마스터 명시 방향)**: 뷰어 진입(설계자가 만든 프로젝트를 뷰어가 접근)을 **별도 분리** — project_members 서버 준비됨(턴④). 뷰어 전용 진입 경로/화면 분리 + 관리자 멤버배정 UI.
- 배포: 빌드 산출물 준비완료. 실제 CF Pages 배포는 wrangler.jsonc database_id 실값 필요(현 placeholder) + 마스터 트리거.

## 이번 턴 ④: CSS검증 + 오프라인#1 + 프로젝트별접근(서버) (2026-06-20)
> 마스터 3대 우선순위: ①오프라인폰 등록→온라인 자동연동 ②프로젝트별 접근관리(회사별 N프로젝트, 관리자가 누구를 어느 프로젝트에) ③THETA 자동연동. + "CSS 깨짐" 긴급 + "오케스트라 제대로".
- **🟢 CSS 깨짐 = 실제앱 정상(오진)**: localhost:3000 실측 — 배경 ivory rgb(245,241,232), CSS룰 1471개, Pretendard, 콘솔에러 0(데스크탑·모바일375). 빌드 리로드 후에도 동일. 마스터가 본 깨진화면 = Launch 미리보기 패널(정적 index.html이 상대경로 css/CDN폰트 못 불러옴) — 코드 문제 아님. (.claude/launch.json 추가, mcp Preview로 검증)
- **📷 THETA = 이미 100% 와이어드**(병렬조사 결론): btn-pin-theta→파일선택→_detect360(2:1 equirect 자동감지)→pano_images 업로드→pin.is360→PanoViewer 구체렌더→자이로(안드로이드). 누락은 OSC Wi-Fi 직결뿐(범위외/deferred). 테스트: public/samples/pano-test-1~5.jpg.
- **📱 오프라인 #1 갭 수정**: `_confirmPinInstant`(즉시등록 핀)가 `OpLog.recordCurrent` 미호출 → 오프라인 instant핀이 재연결 replay 누락이던 것 보강(`_confirmPin` 패턴 미러). (_onSyncDone은 이미 존재 — 조사 오판 정정). 빌드 OK.
- **🔐 프로젝트별 접근관리(서버 완성·E2E검증)**:
  - 마이그 `0014_project_members.sql`(project_id+email+role+granted_by) 적용.
  - 헬퍼 `visibleProjectFilter`(하위호환: 멤버0=공개, 배정되면 제한) + `canManageProject`(super/소유자/designer멤버).
  - 엔드포인트: GET/POST/DELETE `/api/projects/:id/members` + `GET /api/projects` 멤버십 스코프.
  - E2E PASS: 멤버배정→비멤버 디자이너 격리(0) / super·멤버0프로젝트 공개(하위호환 1).
- **남은 작업**: ①프로젝트 멤버 관리 **관리자 UI**(25_Designers/28_AdminPanels에 members 탭 — 프로젝트별 사용자+역할 배정 화면) — 서버는 준비됨, 클라 UI만. ②오프라인 잔여 갭(번들 다운로드 버튼·오프라인 파노뷰). ③deployments도 project 필터(현재 tenant까지).

## 이번 턴 ③: 디자인 개선 1차 — 핀 360ISO + 호선 3D (2026-06-20)
> 마스터 지시: Claude 디자인기능으로 전체 스타일/아이콘(호선) 개선, 핀=360 ISO형식, 360테스트사진 배치, scan360 영어로 CF배포, 루프검증까지. (이번 턴 = 디자인 1차 이터레이션)
- **핀 마커 360° ISO 재설계**(`11_UI.js:199`): 바늘형 → 360 오빗(가로+세로 타원=회전 구체) 메달리온 + ISO 접지그림자/받침대. 색/아이콘/번호 바인딩 보존. `PinIcons.headMarkup(id,color,cy)` cy파라미터 추가(머리중심 12→15).
- **호선 아이콘 3D**(`12_ProjectHub.js:89`): 선체 하부 keel depth 면 추가로 입체감.
- **360 테스트사진 배치**: 루트 `2ND (5~9).JPG` 5장 → `public/samples/pano-test-1~5.jpg`(각 ~4MB THETA). 테스트: 아무 PDF + 이 파노.
- 검증: 정적 PARSE:OK / 빌드 EXIT:0 / 런타임 200 / 파노 200 / dist 동기화 OK.
- ⚠️ **백업 정직보고**: 지난 턴 `360.gz`(49MB) 정크판단 삭제 → git bash rm이라 휴지통 미경유(완전삭제). 단 휴지통에 `seastar_360viewer_2026-06-20` 백업 스냅샷 생존(복구가능).
- **마스터 정정(중요)**: "한국어 전용, 영어 불필요" — 음성전사 "scan360 영어로"는 오해. **i18n/영어화 전부 폐기**.
- **필드텍스트 완성(한국어)**: 전 모듈 영문스텁 스캔 → 접근신청게이트 "Submit Request"→"사용 신청", "Cancel"→"취소"(index.html + 22_Auth.js 기본값) 교정. 그 외 사용자노출 영문 0건(클린). dist 검증: 영문스텁 0.
- **남은 루프**: ①전체 아이콘/스타일 breadth 폴리시(한국어 유지) ②CF 배포 — wrangler.jsonc database_id가 'local-dev-placeholder'라 운영 배포 전 실제 D1 id 필요 + CLAUDE.md상 마스터 직접배포 정책 → 마스터 트리거/확인 필요. ③매 회 4단계 검증.

## 이번 턴 ②: 디자이너모드(구글로그인+PWA) 우선완료 + 빌드 (2026-06-20)
> 마스터 지시: auth 참조 → 구글로그인 → PWA설치 → 디자이너모드 우선완료 후 빌드. 방향 결정 = "동작 먼저, 구조 나중" + "360 전용 자체완결로 직접 구현".
- **Google 로그인(자체완결)**: 코드는 이미 end-to-end 완성(GIS+Firebase+verifyGoogleToken+isDesigner). 보강:
  - 서버 `verifyGoogleToken(token, expectedAud)` — env.GOOGLE_CLIENT_ID 설정 시 audience 강제(토큰 오용 차단).
  - 신규 `GET /api/auth/config` → `{google_client_id, demo_login}`. CF시크릿 `GOOGLE_CLIENT_ID` 주입경로(빌드파일 수정 불필요) + index.html 인라인 폴백.
  - 클라 `Auth._loadServerConfig()` — 서버 client_id 받아 GIS 재초기화.
  - ⚠️ 유일 잔여: **실제 Google OAuth Client ID 값**(마스터 Google콘솔에서만 생성 가능). 주입지점 2곳: CF시크릿 `GOOGLE_CLIENT_ID` 또는 `public/index.html:32`.
  - 디자이너모드는 Google 없이도 동작: **데모버튼 / 회사이메일 자체가입(@seastargo.com→designer)** 경로 생존.
- **PWA 설치**: `public/index.html` SW블록에 `beforeinstallprompt` 캡처 + 우하단 "앱 설치" 버튼 + `appinstalled` 처리 + standalone 감지 추가(기존엔 SW등록만 있고 설치프롬프트 부재였음).
- **부수결함 수정**: `DEMO_VIEWER` 이메일이 `@seastargo.com`(디자이너도메인)이라 viewer가 designer로 승격되던 버그 → `demo.viewer@example.com`으로 교정. 재검증: demo-viewer POST→403, demo-designer POST→200.
- **빌드툴 수정**: `package.json` js:assemble/js:split `python3`→`python`(이 머신엔 python3 부재로 npm run build 실패하던 것 해소).
- **정크 정리**: `core`(903MB 덤프)·`360.gz`(49MB 백업) 삭제 → 워크스페이스 대폭 경량화.
- 검증: 정적 main.js·worker PARSE:OK / 빌드 EXIT:0 76.72kB / 런타임 200 / API: auth/config 200·deployments 미인증 401·역할게이트(viewer403/designer200) ALL PASS.
- 남은 작업(구조-나중): 20_App.js 2898줄·index.tsx 1912줄 기능별 분리(마스터 승인 "동작 먼저"라 보류), 루트 미러 중복 정책 정리, 뷰어모드 프로젝트별/고객별 도메인 라우팅.

## 이번 턴 ①: HEAD 기준 4단계 클린 검증 ALL PASS (2026-06-20)
> 마스터 지시 "검증부터". node_modules가 비어 있어(count:0) `npm install`(55패키지) 후 진행.
- ① 정적: `node --check` main.js(9845줄)·dist/_worker.js 둘 다 PARSE:OK. MIRROR md5 3쌍 일치.
- ② 빌드: `NODE_OPTIONS=--max-old-space-size=640 npx vite build` → BUILD_EXIT:0, dist/_worker.js **76.55 kB**, 27 modules.
- ③ 런타임: 스테일 Express 프로세스(PID 30356)가 3000 점유→제거. 마이그 0001~0013 ALL ✅. wrangler pages dev READY, ROOT 200.
- ④ API/DB 증거:
  - S1: `GET /tables/deployments` 미인증 → **401** (무인증 결함 봉인 확인)
  - AI: `/api/ai/config` → enabled:false, **키 미노출**(model/base_url만)
  - D1(annotations): POST→GET 왕복에서 annotations 보존(`[{id:a1,...}]`), DB anno_len=39
  - Tenant: 새 배포본 DB행 `tenant_id="tnt_default"` 자동귀속(super→DEFAULT_TENANT)
  - Pin icon: `icon:"valve"` 영속 확인
  - Ops 멱등: 동일 opId 2회 → version 0→1→1(중복증가 없음), pin upsert 1회만
  - 검증 후 테스트 행 DELETE로 정리(DB 클린)

## 직전 턴 완료 기록

## 이번 턴 완료 (4단계 검증 ALL PASS)
- [치명적] "파일이 없습니다" 원인 = 서버 다운(이전 Playwright core dump). 재기동 후 pano_images POST/GET 정상 — 디자이너 토큰 POST → `img_*` 정상 저장 재확인.
- [핀 디자인] 핀=바늘형(viewBox 36x64, 뾰족 needle) + 색 분리(미배치 코랄레드 #ef4444 / 사진있음 에메랄드 #10b981), pulse 에메랄드. 영역(구역) 골드와 색 충돌 제거.
- [구역 트리] 도면 등록 전 구역 강제 선택(btn-upload-drawing 가드 + zoneReqFlash), _renderDecks 트리(└ 가이드 + 하위 도면 라인).
- [자동로드] _zoneImageName() → `구역명_번호`(ER1_1, ER1_2…) 자동 파일명, 핀 배치 시 사진 선택기 자동 오픈(280ms 기존).
- [ISO뷰] PanoViewer.setIsoView(0~3) 4꼭지점(yaw 45/135/225/315, lat -28, fov 82, easeInOutQuad 480ms) + pano-header에 ISO 버튼 4개(◤◥◢◣) + 바인딩 + CSS + 모바일 대응.
- [모바일 영역메뉴] zone-tools를 details/summary 드롭다운(#zone-tools-wrap)으로 — 모바일 기본 접힘(화면 가림 방지), 데스크탑 펼침.
- [인증] 회원가입에 부서(#cg-dept) 필드 추가(이름/회사/부서 필수). 인증코드 만료 10분 → **60분(1시간)**. **@seastargo.com 가입 = designer 자동 부여**(designers 테이블 auto:seastargo-domain). local_users.department 컬럼(마이그 0009).
- [오프라인] _deployToViewer 게이트: 오프라인이면 배포 차단(등록은 허용), 미인증/비디자이너면 배포 차단 + requireDesigner 유도.

## 검증 결과 (4-step)
- 정적: JS_OK (new Function)
- 빌드: dist/_worker.js **70.53 kB**, BUILD_EXIT:0
- 런타임: ROOT:200, 콘솔 치명적 에러 없음(401은 비로그인 /auth/me 정상)
- API/DB: send-code valid_minutes:60 / verify role:designer+department:설계1팀 / pano_images POST 디자이너 토큰 img_* 저장 / DB department=설계1팀 + designers auto:seastargo-domain 확인

## 빌드/운영 메모
- BUILD: `pm2 stop webapp; sleep 1; NODE_OPTIONS="--max-old-space-size=640" npx vite build` (plain build = OOM 137)
- MIRROR: cp public/{js/main.js,index.html,css/style.css} → 루트, 그 후 빌드
- D1 마이그: `npx wrangler d1 migrations apply webapp-production --local`
- 서버 다운 시: kill workerd / fuser -k 3000/tcp / pm2 delete+start. 루트 `core` 덤프 주의.
- SUPER_ADMIN = designssir@gmail.com

## 턴 2026-06-22 (핀 줌 해상도/스케일 + ISO 재검증)
- E 핀 깨짐: 핀이 부모 #map-transform scale(zoom)과 함께 커져 고배율 업스케일→래스터깨짐·저배율 너무작음. `10_MapCtrl.pinScreenScale()`(zoom<1이면 1+(1-zoom)*0.65 boost, clamp 0.85~1.7, /zoom) + `_applyPinBillboard` 평면/ISO 모두 inline scale(inv) 적용(ISO는 ×1.25). renderPinsOnMap 끝(11_UI:356)+applyTransform(32)에서 호출. `.pin-marker` transform-transition 없음(끊김X).
- F ISO 배치버그 재검증: 직전턴 _togglePlacing 평면전환 + toggleIso 가드 — 라이브 ×3 교차 ALL PASS(placingOn·isoOff·guardFlat 전부 true). 실마커 transform zoom2→scale(0.5)·zoom0.3→scale(4.85) 확인.
- Google 로그인: 마스터 라이브검증 완료 반영(원장 #2). 양도메인 sedmsys·Firebase 승인도메인 둘다 등록.
- 360 틀어짐 근본원인 답변: 뷰어 수평정확(camera.up 월드Y)·이미지 천정기울기(촬영시 카메라 기울기)·회전축(월드수직)≠사진천정축 불일치. GPano 자동수평+수동 대응.
- 빌드EXIT0·배포 0e505e05·콘솔0.

## 턴 2026-06-22 (스크린샷 4건: 전체포인트 글자·ISO배치버그·모스아이콘·360수평)
- A 전체포인트 패널: `.allpins-panel` 밝은크림 그라데이션 위 var(--text)(밝음)=안보임 → 밝은패널(#f4f1ea)+검정글자(#16181d) 고정. seastar-family-tokens.css. 라이브 휘도241/24.
- B 🔴ISO 클릭좌표 버그: viewportToPercent가 getBoundingClientRect(3D AABB) 사용 + .map-viewport perspective:2600px(원근) → 클릭→도면좌표 틀어짐. 원근역산 위험 → `20_App._togglePlacing`에서 배치 진입 시 평면 자동전환(State.isoView=false+MapCtrl._applyIso), `10_MapCtrl.toggleIso`에 배치중 ISO진입 가드. 라이브 isoView→false.
- C 아이콘: `12_ProjectHub._iconSvg` idx4 잠수함→모스타입 LNG(구형탱크4+선미거주구). 라이브 검증.
- D 360 수평: 진단=뷰어 수평정확(camera.up 월드Y·mesh무회전·lat0)·이미지 천정기울기가 원인. PanoViewer.S.roll(3곳) + _renderFrame `mesh.rotation.x=degToRad(roll)` + resetView 초기화 + adjustRoll(±0.7,한계±20) + pano-controls ↺/↻ 버튼 + _bindPano 배선. 라이브 _renderFrame 적용 검증(5°→0.0873). GPano XMP 자동수평은 미구현(수동대응).
- 빌드EXIT0·배포 46b25d0e·콘솔0.

## 턴 2026-06-22 (사진 대신 PDF 등록 시 내장 PDF 뷰어 팝업)
- 마스터 "PDF가 사진 대신 등록돼 있으면 내장 PDF뷰어로 팝업". 신규 `34_PdfPopup.js` — PDF.load(내장 pdf.js)로 문서 열고 page.render로 자체 캔버스 렌더(메인 도면 렌더상태와 분리), prev/next·닫기·키보드(←→Esc). dataURL/URL 모두 지원, 폴백=새탭.
- `20_App.js openPano`: pinHasMedia=false 且 .pdf 첨부 있으면 Cloud.fetchDoc(docId)→PdfPopup.open(return) (오프라인 미동기화는 Cloud._cache["op:"+pendingOpId]). HTML #pdf-popup, CSS .pdf-popup(다크), manifest 38블록, App.init+__wm 테스트훅(PdfPopup/ThetaIntake/UserMgmt) 추가.
- 검증(라이브): __wm.PdfPopup.open('/samples/test-drawing.pdf')→모달 open·캔버스 763×539 렌더·페이지 1/1·닫기 정상. 구문 PASS·빌드EXIT0·배포 51674d29.
- 🔻미완료(직전 턴 중단): ① 프로젝트 아이콘 '잠수함'→모스타입 LNG선 교체, ② 360 회전 시 중심 틀어짐(롤/틸트) 수정+THETA 이미지 테스트. 다음 처리.

## 턴 2026-06-22 (첫 진입 = 프로젝트 바로 보이기 + 상시 Google 로그인 버튼)
- 마스터 "처음 들어갔을때 프로젝트가 보이게" → 게이트우선(직전턴) 탓에 로그인 전 프로젝트0(라이브 확인). 프로젝트는 인증필요라 자동진입해야 보임 → **자동 데모 설계자 진입 복원**(22_Auth.js:79) + **허브 상단 상시 'Google 로그인' 버튼**(데모일 때만 노출, _applyUiTo, _doFirebaseLogin)으로 두 요청(프로젝트 보이기+구글 로그인) 동시 충족.
- HTML hub-btn-google-login(G로고, signed-in 슬롯), CSS .btn-google-login(흰바탕+검정, 대비규칙). 
- 검증(라이브): 첫 진입 screen-projects·프로젝트2건 표시·게이트블로킹 없음·Google버튼 노출·role designer·isDemo true. 콘솔0·빌드EXIT0·배포 007cd7ba.
- 직전턴 '게이트 우선'은 이 턴에서 '자동진입+상시 Google버튼'으로 대체.

## 턴 2026-06-22 (구버전: 게이트 우선 — 이후 대체됨)
- 마스터 "왜 처음에 구글로그인창이 안 나오지?" → 진단: N1 자동 데모 설계자 로그인(22_Auth.js:79, 250ms)이 게이트보다 먼저 진입시켜 구글 로그인창이 안 떴음(라이브 확인: gate hidden·autoDemo true).
- 마스터 선택(AskUserQuestion)="구글 로그인창 먼저". 수정: 250ms 자동 `demoLogin("designer")` → **`_openGate()`**(로그인 게이트 표시)로 교체. 게이트엔 'Sign in with Google' + '설계자 모드로 진입(데모 1탭)' + 회사이메일 모두 존재.
- 검증(라이브): 첫 로드 게이트 visible·구글버튼·데모버튼 노출·autoLoggedIn=false / 데모버튼 클릭→게이트닫힘·role designer·허브 진입. 콘솔0. 빌드 EXIT:0·배포 c82aa7ab.
- ⚠️ N1(자동 설계자진입) 정책은 이로써 '게이트 우선'으로 대체됨(데모는 1탭 유지).

## 턴 2026-06-22 (이전 미완료 일괄 반영)
- **T3/N11 커스텀도메인**: `wrangler pages project list` 로 scan360 도메인에 `scan.seastar.work` **이미 매핑** 확인 + `curl` HTTP 200 서빙 검증 + **Firebase 승인도메인에 scan.seastar.work 가산**(GET→append→PATCH, 기존9개 보존) → 구글로그인 작동. ✅
- **P3 프로젝트별 멤버배정 UI**: 카드에 멤버버튼(data-act=members) + `#proj-members-modal`(ProjectHub.openMembers/loadMembers/addMember/removeMember) → 기존 백엔드 `GET/POST/DELETE /api/projects/:id/members` 연결. `.pm-*` CSS. 라이브 E2E: 모달오픈·멤버추가(field.viewer/viewer)·UI렌더·서버영속(granted_by) PASS·콘솔0. 배포 5ee7aea0. ✅
- **N6**: B4(이름 17px/800)로 충족 → ✅ 표기.
- 잔여(개방형·기능결손 아님): P1 패밀리룩 폴리시·P2 내부 트리리팩토링·P4 일부 오프라인 부가(번들UI는 존재)·T4 Control Tower 대시보드. 별도 지시 시 착수.

## 턴 2026-06-22 (THETA R* 360 인입 → 도면 위치지정 등록)
- 조사: THETA 360 첨부(btn-pin-theta, 핀-우선 2:1판별)는 존재했으나 **R* 파일명 인입 + 사진-우선 위치지정 워크플로는 없음** → 신규 구현.
- 신규 `33_ThetaIntake.js`: [360 인입] 버튼 → 갤러리 다중선택 → **R* 파일명(/^r/i) + 2:1 equirect 필터** → 미배치 트레이(IndexedDB `SyncQueue.saveDraft/loadDraft` 영속) → 사진 탭 → `State.intakeFile` 주입 + 배치모드 → 도면 탭 시 그 자리에 360 핀 등록.
- 통합: `20_App.js _handlePlaceClick` 에 훅 — intakeFile 있으면 파일선택 대신 `_acceptPinMediaFile(f,false,true)` 로 360 자동첨부·`_confirmPin`(오프라인이면 OpLog/SyncQueue 큐잉) 후 `ThetaIntake._afterPlaced()`(트레이 제거·진행). 온라인 반영은 직전 턴의 수동 "↑ 지금 올리기".
- `01_State.js intakeFile`, `index.html` 인입버튼+다중input+트레이(section-place), `.theta-*` CSS(다크), manifest 37블록, App.init 등록.
- 검증: 구문 PASS·빌드 EXIT:0·배포 874ab056. 라이브: DOM 전요소·input multiple·R*필터(R0010001/r0029999 수락, IMG/screenshot 제외)·콘솔에러0·배포마커 전건. ⚠️ 실제 도면 위 탭→핀등록 풀 E2E는 로드된 도면+실 THETA 사진 필요 → 기존 검증된 배치경로 재사용(코드 검증). 온디바이스 최종확인은 마스터.

## 턴 2026-06-22 (오프라인 수동 업로드 + 드롭다운 대비)
- 드롭다운(흰바탕=검정): 모든 `<select> option` 흰배경+검정글자 강제, `.log-action-filter` 닫힘셀렉트 다크화. css 라이브검증(option 휘도20 black-on-white).
- **수동 반영**(마스터 "수동으로 반영되게해줘"): `SyncQueue.init()` 에서 **자동 업로드(online 리스너+30s 인터벌 _onReconnect) 제거**. 오프라인 큐는 영속 보관, 배지 `↑ 지금 올리기 N` 으로 안내 → 사용자가 눌러야 반영. 신규 `App.syncNow()`=완전동기화(flush+_flushDirtyDrafts+_flushOpLogs+토스트). sync-badge 클릭→syncNow.
- 안전성 근거: 온라인 일반 저장은 큐 미경유 즉시 직접 업로드(20_App.js:1591), SyncQueue/OpLog는 오프라인 작업만 → 자동 끄기 무위험.
- 검증: 구문 PASS·빌드 EXIT:0·배포 5d3c53f4. 배포본 마커(syncNow4·지금올리기3·자동제거0)·콘솔에러0.

## 턴 2026-06-22 (SECMS 엑셀형 그리드 업그레이드)
- 마스터 "완벽하게 SECMS처럼 엑셀형 리스트" → `25c_UserMgmt.js` 전면 재작성 + HTML/CSS 엑셀화.
- 추가: ☑체크박스 열 + 전체선택(현재페이지·보호계정 제외) + **일괄작업바**(디자이너/뷰어 일괄지정·가입취소), 셀 괘선(`.um-xls` td/th 1px border), 지브라, 행 상태틴트(pending/rejected/selected), **호선수**(/api/projects owner별 카운트), 최근접속, 가입일+경과일, 페이지크기 셀렉터(10/20/50/100), «‹›» 페이저, ADMIN 태그.
- 검증: 어셈블 36블록·구문 PASS·빌드 EXIT:0·MIRROR·배포 145e4fd3. 라이브 E2E(super세션+사용자4종+프로젝트2): 10열 그리드·셀괘선1px·호선수(lead.designer=2)·전체선택→일괄바(선택2·슈퍼제외)·경과일 ALL PASS.

## 턴 2026-06-22 (SECMS 사용자관리 차용 — 관리자 사용자관리 페이지)
- **신규 모듈** `public/js/modules/25c_UserMgmt.js`: SECMS `components/admin/UserManagement.tsx` 구조 차용 — 좌측 필터레일(현황/디자이너/대기/거절/전체+카운트) + 통합 사용자 테이블(아이디/이름/소속/역할/상태/가입·접속/관리) + 페이지네이션. 기존 검증 엔드포인트 3종(`/api/designers`·`/api/local-users`·`/api/access-requests`) 병렬 fetch → 이메일 기준 클라 통합(새 서버집계 X). 역할토글=디자이너↔뷰어(POST/DELETE /api/designers), 승인/거절(access-requests/:id/approve|reject), 멤버삭제(local-users), 슈퍼관리자 보호(잠금).
- **배선**: `_manifest.txt`에 25c 추가(25_Designers 다음), `20_App.js`에 `UserMgmt.init()`, `25_Designers.js` switchTab/init에 'users' 탭 + 기본탭=users.
- **HTML**: `#designers-modal`에 `adm-tab-users`(첫·기본 탭) + `adm-panel-users`(필터레일+검색+테이블+페이저).
- **CSS**: `seastar-family-tokens.css`에 `.um-*`(SECMS룩, 360 다크스킨 토큰 var 사용 → 일관). 모바일 레일=가로칩.
- 정직: SECMS 24개 세부권한(케이블 도메인)은 360 무의미 → 제외. 화면·UX·룩만 그대로.
- 검증: 어셈블 36블록 → 구문 PASS → 빌드 EXIT:0 → MIRROR → scan360 배포(b6ec8bec). **로컬 E2E**(local-session으로 super 인증 + 사용자4종 시드): 통합테이블 렌더·카운트(활성3/디자이너1/대기1/전체4)·역할토글 영속(viewer.kim 뷰어→디자이너, 디자이너수 1→2)·신청대기 승인/거절·보호계정 잠금 ALL PASS, 콘솔에러 0. 테스트데이터 정리.
- ⚠️ 주의: 루트 `/`(워커 SSR)는 신규HTML 정상 서빙(=1). 정적 `/index.html`은 엣지캐시 잔재(사용자 비접속 경로) — 시간경과 시 해소.
- ⚠️ 역할 데모토큰 주의: sessionStorage `wm_id_token`(데모)이 localStorage `wm_local_token`보다 **우선**(22_Auth.js:68). 로컬에서 super 테스트 시 데모토큰 먼저 제거.

## 턴 2026-06-22 (신규배치2: 스크린샷+CSS 6건 + Firebase 도메인 직접추가)
- **B1 레이스버그**: `12_ProjectHub.refreshIfVisible()` 가 `render()` 대신 `this.load()` 호출 → 자동로그인(250ms) 완료 후 프로젝트 재로드. 라이브 0→3건 자동표시(새로고침 불필요).
- **B2 프로젝트별 아이콘**: `12_ProjectHub._iconSvg(p)` 신설 — id/name 해시로 6형상(화물선/플랫폼/탱커/갠트리크레인/잠수정/LNG)+6액센트색 결정적 선택. render의 인라인 호선SVG 대체.
- **B3·B5 모달다크+대비**: `seastar-family-tokens.css` 끝에 `.admin-gate-card/.admin-gate-*` 를 **마스터 스킨 토큰(var(--panel)/--text/--m3d-*)만으로** 다크화(새 색 도입 0). 라이브 패널 휘도32+글자 휘도234 대비OK.
- **B4 이름크게**: `.hub-card-name` 17px/800, `.hub-card-date` 11px.
- **B6 Firebase 도메인 직접추가**: firebase CLI configstore(`~/.config/configstore/firebase-tools.json`) refresh_token → firebase-tools 공개 OAuth client 로 access_token 교환 → **Identity Toolkit Admin API** `PATCH /admin/v2/projects/sedmsys/config` 로 authorizedDomains 에 `scan360.pages.dev` **가산**(기존 secms.tech·sedms.app 등 8개 GET 후 보존). 비파괴, 재GET 검증.
- 빌드 EXIT:0 → MIRROR → scan360.pages.dev 배포(8516e9a8) → 라이브 마커 전건 확인 → 로컬 E2E(migrations apply+시드3) ALL PASS → 시드 정리.
- ⚠️ 공유 프로덕션 sedmsys 의 Auth config 를 코드로 수정함(가산만). 향후 도메인 추가도 동일 스크립트 패턴 재사용 가능.

## 남은 후순위 (다음 턴)
- [APK] 최종 파일과 완벽 일치 + 모바일 오프라인(인터넷 없이) 최적화 — 미착수(별도 빌드 파이프라인 필요).
- 디자이너 Google 로그인 + 인증코드 강제(현재 Google은 즉시, @seastargo.com은 코드 경유) 정책 정합성 리뷰.
- 오프라인 SyncQueue flush 실측, 360 배치/레이아웃 보강 리뷰.

---
## 2026-06-23 — 모바일 CSS/아이콘 개선 (완료·검증)
- `public/css/seastar-family-tokens.css`: 터치 타깃 블록 `@media (max-width:640px),(pointer:coarse)` 로 변경(헤드리스 프리뷰=fine pointer라 폭기반 OR 추가 → 폰에서 확실 적용+검증 가능).
- 검증(프리뷰 375px, computed): pano-iso 44×44 · btn-pano-ctrl/btn-icon minH=44 · 아이콘 svg=20px · #pano-controls flex-wrap=wrap · login-card padding=24px 18px 18px. touchOK=true.
- 빌드 EXIT 0 → MIRROR(css/) → `wrangler pages deploy dist` → https://e4080580.scan360.pages.dev
- 라이브 검증: deploy URL + prod alias 둘 다 새 미디어쿼리 present(grep=1), Cache-Control: no-cache.

## 2026-06-23 — scan360 로고 리디자인 (완료·라이브)
- `public/index.html` .login-logo-top SVG 교체: 렌즈+파노라마 자오선(360사진) + 레이더 스캔 스윕(scan) + 골드 360° 캡처 궤도/카메라 노드 + 초점 노드. 워드마크 weight 대비(scan600 / 360 골드800). 마크는 정사각 배지 → PWA 아이콘 재사용 가능.
- MIRROR(index.html) → build EXIT0 → deploy https://029c411b.scan360.pages.dev
- 라이브: prod alias에 s360-lens present(2), 구 wireframe(translate(30,30)) 0.

## 2026-06-23 — 로고 → 파비콘/PWA 아이콘 통일 (완료·라이브)
- `build-tools/gen-icons.mjs` 신규: 새 마크를 dark 정사각 배지로 합성 → sharp 래스터화.
- 생성/교체: public/images/{icon-64,icon-192,icon-512,icon-maskable-192,icon-maskable-512}.png + favicon.svg. (logo.png=하단 씨스타 로고, 미변경)
- any=둥근 다크배지(scale7), maskable=풀블리드+세이프존(scale6), favicon=굵게·단순(scale7.4). Read로 512 any/maskable 육안 확인 — 전문적.
- `public/index.html`: `<link rel="icon" type="image/svg+xml" href="images/favicon.svg">` 추가. root images/ 미러.
- build EXIT0 → deploy https://b1617a8c.scan360.pages.dev
- 라이브: favicon.svg(새 그래디언트3), icon-512 image/png, index favicon.svg링크1, manifest maskable1.

## 2026-06-23 — 빌드 + 오프라인 런타임 실측 (완료·증거)
- sw.js: CACHE v14→v15, SHELL에 images/favicon.svg 추가. MIRROR(sw.js) → build EXIT0 → deploy https://75f63a81.scan360.pages.dev
- 프리뷰 런타임 실측(preview_eval): SW active+controller(scope localhost:3000), wm-shell-v15 적재(구 v14 정리), 셸5종(index/main.js/style.css/favicon.svg/pdf.worker) 전부 cache hit.
- SyncQueue 왕복: enqueue(0→1, status pending)→all에서 found→_remove(1→0) roundtrip_ok=true. 백엔드 IndexedDB 실사용(localStorage 폴백 불필요).
- saveDraft/loadDraft 왕복 match=true. 오프라인 부팅: 캐시 index.html status200·114KB·login-gate 포함.
- 미검증(정직): 실기기 비행기모드 완전차단→재연결 flush E2E는 헤드리스 불가 → 실폰 1회 필요.

## 2026-06-23 — 오프라인 전체 사이클 E2E (PASS·자동검증)
- preview_eval로 fetch+navigator.onLine 가로채 실폰 비행기모드 불변식 재현:
  ① OFFLINE: enqueue 큐+1, flush가 offline가드 차단(flushBlocked), op보존(손실0)
  ② ONLINE: flush→/api/sync/batch POST, 페이로드=그 핀과 일치(sentCorrectOp), 서버ID매핑(op→srv-), uploaded:1, 큐드레인.
  VERDICT=PASS. (코드변경 없음 — 검증만)
- 여전히 권장: 실폰 1회(실제 네트워크 스택·THETA 공유타깃 실제 인입)는 환경상 헤드리스 불가.

## 2026-06-23 — 심층검토 + 오프라인 데이터손실 P0 수정 (코드완료·로컬검증, 프로덕션반영 대기)
- 4영역 병렬 정밀검토. 이번세션 프론트(로고/아이콘/CSS/SW)=P0·P1 없음(깨끗). deployments/로컬세션토큰192bit/RS256/관리자 enforce/SQL인젝션0 견고.
- [수정·검증완료] 오프라인 데이터손실:
  · src/index.tsx /api/sync/batch: 영구거부(permanent:true=검증실패) vs 일시오류(permanent:false=DB장애) 구분 + source_op_id 멱등(같은 opId 재전송→기존 id 반환).
  · 05_SyncQueue.js flush: permanent만 dead-letter 제거, 일시오류는 큐 보존(재시도). _lsSet 성공반환. enqueue 양쪽 저장실패시 null+토스트.
  · 20_App.js enqueue 호출 4곳 null 가드(유령 op:null 방지).
  · migrations/0018_sync_idempotency.sql: pano_images.source_op_id + 인덱스. 로컬 적용✅.
  · 로컬 E2E(preview_eval): A일시보존/B영구제거/C성공/D무저장신호 = ALL PASS. build EXIT0.
- [프로덕션 반영 대기] 리모트 D1 0018(ADD COLUMN 비파괴) + 코드배포는 원자적으로 함께 — 마스터 승인 후.
- [보안 P0 — 마스터 결정 필요] S1 /api/r2/object/* 무인증(도면/파노 공개) → 서명URL 설계변경 필요(img/three loader라 헤더인증 회귀). S2 pano_images tenant 격리 무시(읽기/쓰기) → deployments 패턴 미러+NULL백필. S3 DEMO_LOGIN=0 프로덕션 시크릿 미설정(=Bearer demo-super 슈퍼관리자) → 즉시 봉인 가장시급.
- [P1 잔여] /api/projects/:id/decks 무인증, /api/notes tenant체크, CORS*, 루트 js/modules 스테일중복(git rm 대상).

## 2026-06-23 — [추천1 실행] S3 봉인 + 데이터손실 프로덕션 반영 (완료·라이브검증)
- 리모트 D1 0018 적용(ADD COLUMN source_op_id + idx). 프로덕션 pragma 확인: source_op_id TEXT + idx_pano_source_op 존재✅.
- DEMO_LOGIN=0 프로덕션 시크릿 봉인(wrangler pages secret put). 코드 배포 https://62cf7ba9.scan360.pages.dev
- 라이브 검증: Bearer demo-super → /api/allowed-domains·local-users·designers 전부 403 {"error":"forbidden"}(무토큰과 동일). 외부인 슈퍼관리자 탈취 경로 차단✅.
- 데이터손실 수정(permanent구분/멱등/무신호신호/null가드) 코드 프로덕션 반영. (로컬 E2E ALL PASS 기검증)
- COMPLETION_CHECKLIST S2(DEMO_LOGIN 봉인) → 이제 완료.
- 잔여(마스터 우선순위 대기): 보안 S1 R2 서명URL, S2 pano_images tenant격리+백필. P1: decks무인증/notes tenant/CORS*/루트 js/modules 스테일 git rm.

## 2026-06-23 — S1·S2·P1 순차 완료 (ponytail full, 라이브검증)
- S1 R2 보안: getUser에 ?t= 쿼리토큰 폴백(루트, <img>/텍스처용) + /api/r2/object/* 로그인필수 + Cache-Control private. 클라 Auth.r2(u) 헬퍼(R2경로만 토큰부착, blob/data/외부 no-op, 멱등) → PanoViewer load/loadVideo + Compare 적용. 검증: 무토큰403/garbage403/?t=demo-super→404(local, 인증통과). 헬퍼 E2E PASS.
- S2 pano_images 테넌트격리: list/single/create/sync-batch 전부 tenantOf 필터+태깅(deployments 패턴 동일, NULL구행=기본테넌트). 마이그레이션 불필요(0013 tenant_id 기존).
- P1: decks GET 로그인필수(401), CORS 와이드오픈→앱도메인(localhost/*.pages.dev/*.seastar.work)만 반사, 루트 js/modules 스테일35개 git rm(assemble는 public/js/modules만 읽음). notes 익명작성=마스터설계 유지(deployment_id가 테넌트격리 읽기에서만 노출돼 실질위험 낮음).
- build EXIT0, MIRROR(main.js), deploy https://3afa89ad.scan360.pages.dev
- 라이브: R2 403/403, decks 401, CORS evil차단·seastar반사 ALL PASS.
- 잔여(미수정·기록): B3 이미지업로드+핀remap 비원자성(P1, reload틈 dangling — _remove를 remap 영속화 후로 미루면 해소). notes 설계유지.

## 2026-06-23 — 도면 R2 보안화 완성 (S1 회귀 차단, 라이브)
- 발견: 도면은 이미 _uploadPagesToR2 로 R2 저장중(base64 폴백)이나, 표시 지점이 토큰 미부착 → S1(R2 인증)으로 R2-도면이 403 회귀 직전이었음.
- 수정: 모든 도면 표시 지점에 Auth.r2() 래핑 — 20_App(viewerPages next/target, pages[0]×2, d.pages[0]), 07_Radar(mapSrc), 18_Brand(logo). +기존 PanoViewer2·Compare1 = 번들 Auth.r2 10곳.
- 레거시 D1 base64 도면은 Auth.r2 no-op으로 그대로 동작(혼재 안전). 신규 도면=R2+토큰보안.
- build EXIT0, MIRROR, deploy https://09278ab7.scan360.pages.dev. 헬퍼 E2E PASS(도면 토큰화/레거시 무변경). 라이브 R2 무토큰 403 유지.
- 결론: 업로드된 그림(파노)·도면 모두 R2 저장 + ?t= 토큰 보안 일원화 완료.

## 2026-06-23 — R2 토큰 작업 마무리 (전수 감사·완결)
- 전 모듈 .src/Image/Texture 지점 전수 스캔. R2 URL 렌더 경로 10곳 모두 Auth.r2() 래핑 확인.
- 잔여 미래핑은 전부 비R2: createObjectURL(로컬 blob), fetchImage→image_data(D1 base64), Google 아바타(외부), 첨부문서(D1 base64). → 403 회귀 가능성 0.
- 코드변경 없음(검증만). 최종 라이브 = 09278ab7. 결론: R2 바이너리(그림/도면/로고) 100% 토큰 보안, 미래 신규 img/texture는 /api/r2/object URL이면 반드시 Auth.r2() 경유 필요.

## 2026-06-23 — 수동 저장 버튼 (자동저장 OFF, 마스터 요청·검증)
- 마스터: "사진/도면 업로드하면 저장버튼, 자동저장 아니라". 기존 저장함수 전부 재사용, 트리거만 수동 전환(새 저장로직 0).
- _autoSave: 서버 즉시저장 제거 → 로컬 draft 즉시보존(소실0) + _markDirty(저장버튼 활성). 9개 호출부 그대로(동작만 변경).
- _saveNow(신규): '저장' 버튼 핸들러. 미생성→_createInitialSave(도면 R2업로드+핀)+대기 구역연결, 기존→PATCH(도면 변경분 R2업로드 후). 버그픽스: PATCH 경로도 _uploadPagesToR2 거치게(기존 _autoSave는 base64로 저장하던 것).
- _afterDrawingLoaded/1551: 도면 업로드 시 서버 자동생성 제거 → 로컬보존+dirty+_pendingDeckLink(저장 시 생성·연결).
- UI: index.html #btn-save(💾 저장) + family-tokens.css(골드 dirty pulse/clean disabled). init에서 클릭→_saveNow, beforeunload 미저장 경고.
- _deployToViewer는 자체 스냅샷 독립배포라 영향 없음. _replaceDeckDrawing은 이제 미사용(dead, 무해).
- 검증(preview_eval): _autoSave 서버호출 0(스테이징만), 저장버튼 dirty표시/clean disabled, 함수 전부 존재 = PASS. build EXIT0.
- deploy https://bcfdd43e.scan360.pages.dev

## 2026-06-23 — 모바일 저장확인 + 아이콘 간결화 (마스터 요청·검증)
- 원인: 저장버튼이 topbar에 묻혀 모바일에서 안 보임 → "저장됐는지 확인 안 됨".
- ① _saveNow 성공/실패 Prompt.toast("✅ 저장 완료" / "⚠️ 저장 실패" / "📥 오프라인 로컬보관") — 명확 피드백.
- ② 모바일 CSS(family-tokens): #btn-save 플로팅 알약(fixed 우하단, z1300, 항상 보임). .btn-pano-ctrl span 숨김+아이콘 23px(아이콘만 간결·명확). #mode-label·topbar-sep 숨김(상단바 간결).
- 검증(preview_eval 375px): save_floating/zindex1300/radius26, pano_label_hidden, icon23px, modelabel_hidden, toast_exists = PASS. build EXIT0.
