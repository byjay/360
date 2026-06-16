# HANDOFF — 360° Location Viewer (SEASTAR)

## 마지막 커밋
- (직전) `c951715` docs: HANDOFF 갱신 / `9b2269e` feat: 최상위관리자+AI+코드맵+초대가입+로그+모바일+IRON RULE

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

## 남은 후순위 (다음 턴)
- [APK] 최종 파일과 완벽 일치 + 모바일 오프라인(인터넷 없이) 최적화 — 미착수(별도 빌드 파이프라인 필요).
- 디자이너 Google 로그인 + 인증코드 강제(현재 Google은 즉시, @seastargo.com은 코드 경유) 정책 정합성 리뷰.
- 오프라인 SyncQueue flush 실측, 360 배치/레이아웃 보강 리뷰.
