# HANDOFF — 360° Location Viewer (SEASTAR)
> 이전 기록(69KB) → `.claude/_archive/HANDOFF_pre20260930.md` · 상세 작업 원장 → `.claude/RESUME_LEDGER.md` (tail/grep 만)
> 요구 체크리스트·지휘자 검증 판정 → `.claude/REQ_AUDIT_20260929.md`

## 라이브 (scan.seastar.work, CF Pages `scan360`)
| 배포 | 커밋 | 내용 | 라이브 검증 |
|---|---|---|---|
| 8b2f0177 | 7f53fa6 | 모바일 핀 패널 6건(토스트 겹침·?버튼·캡션·#2 2 중복·세로사진·뷰어 제목) | 375px 실측 PASS, main.js?v=13b1bdcdd2 |
| a9574a9e | 703ec94 | 교차 프로젝트 stale currentDeck 누수 + 서버 parent_id 400 + 고아 deck 루트 승격 | sunbo 프로젝트노드 → 원본 토스트 없음 |
| 8cd85d44 | 43d171f·505d177 | 트리 일원화(최상단 프로젝트 노드) | — |
기준선(2026-09-30): deployments 30 / decks 45 / projects 32

## 🔄 진행 중 (에이전트 재개됨 — 착지 시 HEAD 추출본 빌드·배포)
1. 관리자 핀 일괄삭제 + createdAt 명시 저장 + 트리 #1 (coder/opus) — WIP: 01_State, 01b_PinSeries, 11_UI, 20_App, seastar-family-tokens.css, tests/p92(신규), tests/p15(🔴 기존 테스트 수정 → G-4⑧ 대조·뮤테이션 확인 필수)
2. 모바일 메인2(핀등록·사진등록)+더보기, 뷰어 닫기 화면밖(x475/375) 수정, 뷰어 버튼 21개 PASS/FAIL (haiku-coder) — 발주서 `.claude/WORK_ORDER_20260929_mobile.md` — WIP: 06_PanoViewer, 07_Radar, style.css, index.html

## ❌ 미착수 (우선순위 순)
3. 🔴 WP1 데이터유실: H7 크롭뷰 저장 시 크롭 밖 핀 삭제, H5 tombstone 소멸, H8 로드 시 tombstone 미필터 (설계 `.tmp/design-multiuser.md`)
4. WP3 권한 H4: 초대받은 사람이 타 프로젝트 쓰기 가능 — 마이그레이션 0029 deployments.project_id + requireProjectWrite (삭제된 프로젝트 배포본 PATCH 차단도 이것으로)
5. WP4 번호 대역(H3 중복) · WP5 20초 폴링 · WP6 구역 단위 합치기(중복핀 판정 = Jev 후보)
6. deps_without_deck 27건 복구(project_id 필요) · [원본 PDF 연결] 버튼 존치 여부(마스터 결정 대기)
7. D6 THETA 와이파이: 브라우저는 SSID 불가 → 현재 offline→online 대체. 진짜 감지는 네이티브 앱

## 절차 메모
- 모든 발주 전 `jev_route.py` 실행·기록 (memory jev-every-order)
- 작업트리에 타 팀 WIP 있으면 `git archive HEAD` → `.tmp/headfull` 빌드. 테스트 TEMP 는 **추출본 안** `.tmp/headfull/.tmp` (밖이면 workerd '..' 오류)
- 로컬 dev: launch.json "360-viewer" autoPort (3000 은 Google Maps MCP 점유)
