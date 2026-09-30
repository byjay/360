# HANDOFF — 360° Location Viewer (SEASTAR)
> 이전 기록(69KB) → `.claude/_archive/HANDOFF_pre20260930.md` · 상세 작업 원장 → `.claude/RESUME_LEDGER.md` (tail/grep 만)
> 요구 체크리스트·지휘자 검증 판정 → `.claude/REQ_AUDIT_20260929.md`

## 라이브 (scan.seastar.work, CF Pages `scan360`)
| 배포 | 커밋 | 내용 | 라이브 검증 |
|---|---|---|---|
| 4756c36d | 2431671 | 핀 모드별 모양·색: CHECKER 주황 둥근사각 배지 / 360 블루 물방울(미니맵·트리·칩 일관) | 번들 동일·클래스 포함, 시각 미확인(핀 0) |
| 2d221c1c | 69836f5 | H2 동시 수정 — 핀 단위 updatedAt, 나중 수정 승(남의 수정 되돌림 방지) | 번들 포함 확인 |
| e2414bb8 | 3cfceb1 | 다른 사용자 변경 20초 폴링 자동 반영(편집 중 보류·숨김/오프라인 중지) | 번들 포함 확인 |
| 41a907e4 | 25f022d | 글자 대비 미달 506→0(p100 헤드리스 감사) | css 스탬프 갱신 |
| ec105cf3 | 603f9b9 | 동시 생성 번호중복 0(전원 기준 다음번호 + 병합 재채번, 수동번호 보호) — 사용자별 대역 보장 X | 번들 포함 확인 |
| 26ecfc3f | 23c0680 | 360 핀 생성 시 최근접 360 사진 자동연결(세션 후보·10분·영역_시간) | 번들 포함 확인, 실제 파일선택은 휴대폰 확인 필요 |
| 2ffc99dc | 516913b | 트리 프로젝트→구역→영역 공유 + 하단 CHECKER/360 잎, CHECKER 사진 경로 차단 | 잎 클릭 모드 전환·칩 실측 |
| dcceca22 | ec22ada | 합치기+Jev, 권한(비멤버 403)·원본 기록, 403≠401, 360 P 마커, 칩·배지 모드분리, 도면 열 때 맞춤, 힌트바 | 칩 CHECKER 0/360 0, 해시 d9e961124f (fit 은 패널 비표시로 미확인) |
| ab4aefec | 88e52ff | 모드 분리(1차 구조) + prod 0029 | CHECKER/360 전환 실측 |
| 61462178 | 2adbb9e | H7 크롭저장 핀삭제 + H5/H8 | |
| 8aa2c162 | e84e967 | 모바일 도크 메인(포인트·사진등록)+더보기, 뷰어 닫기 화면 안, 도구·미니맵 접힘 | 375px 화면밖 버튼 0 (❌ 하단 힌트바 중복·잘림 잔여) |
| 103a60fc | 8da7ed3 | 관리자 핀 일괄삭제(선택·구역 전체), 단건·일괄 삭제 부활 결함 수정(_mergePins+tombstone), createdAt 3곳 | 디자이너 계정 버튼 숨김·핀 11 유지 (관리자 화면 미확인), main.js?v=220ca35822 |
| 8b2f0177 | 7f53fa6 | 모바일 핀 패널 6건(토스트 겹침·?버튼·캡션·#2 2 중복·세로사진·뷰어 제목) | 375px 실측 PASS, main.js?v=13b1bdcdd2 |
| a9574a9e | 703ec94 | 교차 프로젝트 stale currentDeck 누수 + 서버 parent_id 400 + 고아 deck 루트 승격 | sunbo 프로젝트노드 → 원본 토스트 없음 |
| 8cd85d44 | 43d171f·505d177 | 트리 일원화(최상단 프로젝트 노드) | — |
기준선(2026-09-30 19:5x): deployments 30 / decks 45 / projects 32 · 핀 0(마스터 지시로 전부 삭제, 백업 .artifacts/backup-pins-20260930.json) · prod 0029·0030·0031 적용, 백필 19

## 🔄 진행 중
- 없음 (2026-09-30 21시대 기준, 루프 대기열 전부 착지·배포)

## ❌ 미착수 / 결정 대기
- M1 [원본 PDF 연결] 버튼 존치 여부 — 마스터 결정 대기
- M2 사용자별 번호 대역(2026-09-17) 폐기 여부 — 603f9b9 가 '중복 0' 우선(대역은 하한만). 마스터 확인 대기
- M3 360 사진 자동연결 휴대폰 실기 확인 — 마스터 확인 대기 (지휘자는 실제 THETA 파일 선택 불가)
- M4 관리자 일괄삭제 화면 — 관리자 계정 로그인 필요, 지휘자 미확인
- M5 도면 열 때 화면맞춤(efbd6ec) — 브라우저 패널 비표시로 지휘자 미확인
- R1 LWW 기기 시계 차이 역전 가능[Uncertain] · 폴링 토스트 수정건 미집계
- R2 deps_without_deck 11건(구역 미연결 배포본, 백필 제외) — 앱에서 보이지 않음, 정리 여부 미정
- R3 D6 THETA 와이파이: 브라우저 SSID 불가 → offline→online 대체. 진짜 감지는 네이티브 앱
- X1 .tmp 추출본(hfA~hfG, headfull*, hf15, mine, fm3, fm4, base) 정션 정리 — cmd //c rmdir 먼저

## 절차 메모
- 모든 발주 전 `jev_route.py` 실행·기록 (memory jev-every-order)
- 작업트리에 타 팀 WIP 있으면 `git archive HEAD` → `.tmp/headfull` 빌드. 테스트 TEMP 는 **추출본 안** `.tmp/headfull/.tmp` (밖이면 workerd '..' 오류)
- 로컬 dev: launch.json "360-viewer" autoPort (3000 은 Google Maps MCP 점유)
