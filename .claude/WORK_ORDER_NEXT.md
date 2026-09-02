# 작업지시서 — 다음 턴 Opus 실행자용 (2026-08-31 작성)

> 지휘자(Fable) 검증 완료분. 정찰·근거 전부 확보됨 — **재조사 없이 바로 구현하라.**
> 공통 규율: `CLAUDE.md §공통 작업 규율` 준수(경로 한정 커밋 · 증거 없는 PASS 금지 · 뮤테이션 증명).
> 빌드 체인: `python build-tools/assemble.py` → MIRROR(`cp public/js/main.js js/main.js && cp public/index.html index.html && cp public/css/style.css css/style.css`) → `node --check public/js/main.js` → `pm2 stop webapp 2>/dev/null; NODE_OPTIONS="--max-old-space-size=896" npx vite build` → `npx wrangler pages deploy dist --project-name scan360 --commit-dirty=true`.

## 배경(검증 결과 요약 — scout 실측, 2026-08-31)
- 최근 5커밋(f8d198e 데이터손실 4건 / cc293f2 z-index / 50a0310 미니맵 클릭보정 / 1c46395 구역→파일창 / aec4fbf 핀스케일) **전부 정상 구현·회귀 0** 확인.
- `node --check public/js/main.js` EXIT=0.
- 마스터 요구와 갭 1건 + 개선 2건이 남음(아래 P1~P3).

---

## P1 (필수) — "구역 등록 시 반드시 PDF 등록" 강제
**마스터 원문**: "구역별로 페이지 단위로 구분하게 하라니까 구역을 등록하면 반드시 PDF가 등록되어야 해"

**현재 갭**: `public/js/modules/31_Projects.js` `createDeck()` 92~141줄 — 구역 생성 직후 파일창을 띄우지만(136줄 `btn-upload-drawing.click()`), **사용자가 취소하면 구역이 "도면없음"으로 남는다**(구역은 120줄에서 이미 생성됨).

**구현 방침 (b안 — 취소 시 롤백)**:
1. `createDeck()`의 파일창 호출부를 개선: 파일 input의 `change` 이벤트가 일정 시간 내 발생하는지 추적하거나, 더 확실하게는 **순서를 뒤집어라** — 사용자가 직접 "+생성"한 경우(`opts.askDrawing !== false`) 이름 입력 후 **파일을 먼저 선택**하게 하고(input change 확인), 파일이 확정된 뒤에 구역 POST → 도면 로드로 이어지게. 파일 선택을 취소하면 구역 POST 자체를 하지 않는다(롤백 필요 없는 구조가 롤백보다 안전).
   - 파일 먼저 방식이 기존 `_loadDrawing` 흐름(구역 선택 필수 가드)과 충돌하면: 구역 POST → 파일창 → 취소 감지 시(`window focus 복귀 후 input.files 비어있음` 체크 또는 명시적 취소 버튼) `DELETE /api/decks/:id` 로 롤백하는 (b)안으로.
   - 두 방식 중 코드 구조상 더 단순한 쪽 선택. **어느 쪽이든 "구역만 있고 도면 없는 상태"가 사용자 취소로 만들어지지 않아야 한다.**
2. `ensureDeck()` 자동생성 경로(`askDrawing:false`)는 기존대로 파일창 없이 동작(무한루프 방지 유지 — 138줄).
3. 기존 "도면없음" 구역(이미 존재하는 MAINDECK/A/ETR 등)은 그대로 두고 P2로 처리.

**검증**: ①정상 흐름(생성→파일선택→도면로드→저장→deployment_id 연결) 코드경로 추적 ②취소 흐름(구역 잔존 0 또는 롤백 성공) ③ensureDeck 무한루프 없음 grep ④뮤테이션: 강제 로직 무력화 시 기존 갭 재현 확인 후 복원.

## P2 (권장·난이도 낮음) — "도면없음" 구역 경고 강화
**현재**: 사이드바 트리에서 "도면없음" 태그(회색, `tree-tag`)가 약해서 지나치기 쉬움. 구역 클릭 시 `offerDeckDrawingLink` 모달이 뜨긴 함(31_Projects.js:162 → 20_App.js:2778 — 이 경로는 정상 확인됨).

**구현**:
1. `public/css/style.css`의 `.tree-tag`(도면없음) 스타일을 경고 톤으로 강화 — 앰버/주황 계열, 단 「미저장」 배지(`tree-tag-unsaved`, 4657-4674줄 근처, 앰버 펄스)와 **시각적으로 구분**되게(예: 도면없음=주황 외곽선, 미저장=앰버 채움). 대비 규율(3:1↑) 준수, 다크·라이트 배경 모두 확인.
2. 렌더 위치: `public/js/modules/11_UI.js` `renderTree()` 185-189줄 근처(deck.deployment_id 없을 때 태그 붙이는 곳).

**검증**: 대비비 실측 첨부, 미저장 배지와 나란히 있을 때 구분되는지.

## P3 (권장·난이도 낮음) — 저장 완료 피드백 보강
**현재**: 저장 완료 시 토스트(20_App.js:3276 근처 "저장 완료")뿐 — 모바일에서 놓치기 쉬움(CLAUDE.md에 과거 "저장 확인이 안 됨" 마스터 지적 이력 있음).

**구현**: 저장 성공 시 ①상단 `autosave-indicator`를 "저장됨" 상태로 수 초 강조(기존 `_setSaveIndicator("saved")` 경로 확인 — 이미 있으면 시각 강화만) ②트리의 「미저장」 배지가 즉시 사라지는지 확인(f8d198e의 `_markDeckUnsaved(deckId, false)` 경로 — 20_App.js:3104에서 서버 반영 후 false 처리됨, 렌더 갱신 누락만 점검) ③저장 버튼 앰버 펄스 해제 확인. 과설계 금지 — 기존 상태 표시 체계 재사용.

**검증**: 저장 전→후 상태 전이(dirty→saved) 코드경로 추적, 배지 제거 렌더 호출 확인.

---

## 참고 — 손대지 말 것
- 마스터 "자동저장 OFF" 정책(도면 등록 즉시 서버저장 금지) 유지.
- `TEMP_OPEN_ALL_TENANTS` / `AUTO_DESIGNER_ENTRY` / `AUTO_DESIGNER_TOKEN_ENABLED` / `ASK_ENTRY_MODE` 스위치 4종 건드리지 않기(임시 개방 체제 — memory/temp-open-access-switches.md 참조).
- `demo-super` 등 데모 토큰 봉인(DEMO_LOGIN=0) 유지.
- 완료 후: 경로 한정 커밋 + 배포 URL 보고 + 이 파일(WORK_ORDER_NEXT.md)에 처리 결과 추기.

---

## 처리 결과 (2026-09-02 · Opus 실행자)

- 커밋: `5ae6eaa` (경로 한정: `public/js/modules/{11_UI,20_App,31_Projects}.js` · `public/css/style.css` · `public/js/main.js` · 미러 `js/main.js`,`css/style.css` · 신규 `tests/p1-deck-drawing.test.mjs`)
- 배포: https://1e5a7848.scan360.pages.dev (wrangler EXIT=0, 66 files)
- 빌드 체인: assemble EXIT=0(38모듈→12544줄) · MIRROR EXIT=0 · `node --check` EXIT=0 · `vite build` EXIT=0(dist/_worker.js 98.05 kB) · `node --check dist/js/main.js` EXIT=0
- 회귀/뮤테이션: `node tests/p1-deck-drawing.test.mjs` → **12/12 PASS, EXIT=0** (P1 취소가드 무력화 시 갭 재현 / P0-2 dirty블록 복원 시 false-dirty 재현 = 뮤테이션 증명 2건 성립)

| 항목 | 상태 | 채택 방식 |
|---|---|---|
| P1 구역 생성 시 도면 강제 | ✅ | a안(순서 뒤집기). 이름→**도면 파일 확정**→구역 POST→도면 로드. 취소 시 POST 자체를 안 함 → DELETE 롤백 불필요(실데이터 삭제 0). `ensureDeck`/`_loadDrawing` 내부 자동생성은 `askDrawing:false` 로 파일창 없이 유지(무한루프 방지). 업로드 버튼의 구역 0개 분기도 `createDeck()` 전체 흐름으로 위임해 형제 갭 제거 |
| P2 '도면없음' 경고 강화 | ✅ | 밝은 주황 채움+주황 외곽선+진한 주황 글자(7.57:1). '미저장'(진한 채움+흰 글자)과 채움 밝기로 구분(칩 간 4.06:1). 기존 2.82:1 → UI 최소 3:1 미달이었음 |
| P3 저장 완료 피드백 | ✅ | 표시기 다크테마 잔재 제거(저장됨 **1.26:1 → 5.13:1**), 라벨 '자동 저장됨'→'저장됨'(자동저장 OFF 정책과 일치), 저장 직후 2.6초 링+팝 강조(색 대비 불변). 미저장 배지 해제·저장버튼 펄스 해제는 기존 경로 정상 확인 |
| P0 미니맵 헤더 히트테스트 | ✅ | `.pano-radar-head{position:relative;z-index:20}` + `.pano-radar-stage{z-index:1}`. transform 걸린 stage 가 static 헤더를 덮던 스태킹 순서 확정. 헤더 배경 부여 + 페이지 텍스트 1.01:1 → 12.42:1 |
| P0-2 false-dirty / 고아 배포본 | ✅ | 근본원인 = `_showMapViewport()`(순수 표시 함수)가 dirty 를 세움 → 제거. 실제 업로드는 `_afterDrawingLoaded()`가 try 밖에서 dirty 확정(스냅샷 실패해도 미저장 표시 보존). 구역 컨텍스트 없는 **신규** 배포본 생성은 `_saveNow`·`_flushDirtyDrafts` 양쪽 차단(기존 PATCH 는 영향 없음) |

### 잔여 리스크(미수정 · 정직 보고)
- `_deploy` 경로(20_App.js ~3415 `뷰어로 배포`)는 구역이 없어도 `POST /tables/deployments` 를 그대로 실행한다 → 이론상 고아 배포본 1건 생성 가능. 발주 범위 밖이고 명시적 배포 동작이라 이번엔 손대지 않음. 필요 시 동일 컨텍스트 가드 적용 권장.
- 기존에 이미 생긴 '도면없음' 구역·중복 배포본(D1)은 데이터 정리 대상 — 코드 수정으로 제거되지 않음(실데이터 삭제는 수행하지 않았다).
