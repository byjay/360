# HANDOFF — 360° Location Viewer (SEASTAR)

## 마지막 커밋
- `9b2269e` feat: 최상위관리자 기능/메뉴 관장+AI설정+코드맵, 사전초대 가입+회사명, 사용자 액션로그, 모바일 바텀네비/핀치줌, IRON RULE

## 이번 턴 완료 (4단계 검증 ALL PASS)
- [T3] AdminPanels 모듈 wiring: App.init에서 init()+applyFeaturesToUI(), window.__wm export, feat-off CSS 10규칙
- [T3] 기능 7종 토글(annotations/zones/pin360/fls3d/ai/timelapse/export) → body.feat-off-* → 메뉴 숨김
- [T3] AI 설정 모달(base_url/model+연결테스트), 코드맵 대시보드(5그룹/12파일+검색)
- [T4] /api/client-log(화이트리스트) + 프론트 Log 헬퍼 6지점(app.open/viewer.open/pin.add/edit/pdf.register/deploy.click/pano.open/settings.open)
- [T2] 사전초대 가입(회사명 필수)+invites CRUD — 기존 curl PASS 재확인
- [모바일] 핀치줌/더블탭/하단네비/바텀시트(메뉴 안가림 sidebarTop=246/844, map padBottom 58px) E2E PASS

## 검증 결과
- BUILD: dist/_worker.js 69.81 kB, exit 0
- curl: client-log(401/200/400), app-settings(super 200/viewer 403), invites(POST/GET/send-code invited:true) 전부 PASS
- E2E: AdminPanels 3모달 오픈, feat-off-ai/timelapse body반영, 코드맵 검색필터, 모바일 바텀시트 PASS

## 빌드/운영 메모
- BUILD: `pm2 stop webapp; sleep 1; NODE_OPTIONS="--max-old-space-size=640" npx vite build` (plain build = OOM 137)
- MIRROR: cp public/{js/main.js,index.html,css/style.css} → 루트, 그 후 빌드
- AI 키: Cloudflare secret `AI_API_KEY` (`npx wrangler pages secret put AI_API_KEY`). base_url/model은 app-settings 저장
- SUPER_ADMIN = designssir@gmail.com

## 남은 후순위
- 오프라인 SyncQueue flush 실측, 360 배치/레이아웃 보강 리뷰
