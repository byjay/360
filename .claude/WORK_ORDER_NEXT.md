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

---

## 처리 결과 (2026-09-02 · Opus 실행자 · 2차) — 잔여 리스크 `_deployToViewer` 해소 + 미니맵 타이틀 대비

**근본원인**: `_deployToViewer()` 가 '저장'과 별개로 `POST /tables/deployments` 를 **항상** 실행했다.
그래서 (a) 프로젝트/구역 컨텍스트가 없으면 어디에도 연결 안 되는 고아 배포본이 생기고,
(b) 구역에 이미 `deployment_id` 가 있으면 배포 클릭마다 배포본이 하나 더 생기는데 **구역은 옛 ID 를 계속 가리키고**
작업본(`State.autoSaveDepId`)만 새 ID 로 갈아타 이후 저장(PATCH)이 구역이 여는 배포본과 갈라졌다
→ "저장했는데 구역에 반영 안 됨" 의 근본 후보.

**채택 방식(Ponytail 사다리 ②: 기존 재사용)** — "배포 = 저장 경로 재사용".
배포 전용 POST 를 **삭제**하고 `_saveNow()` 를 호출한다(신규면 생성+구역연결, 기존이면 그 배포본 PATCH).
뷰어 링크는 `State.autoSaveDepId` 로 만든다. 배포본은 언제나 **1구역 1개**.
`_saveNow` 는 성공 여부를 `boolean` 으로 반환하도록 바꿔 배포가 결과를 알 수 있게 했다(가드 차단·중복호출·실패 = false).
불변식 **`구역.deployment_id === State.autoSaveDepId`** 는 배포 직후 재연결 블록이 강제한다(PATCH 경로의 stale 링크 교정).
부수 효과: 배포 전용 중복 스냅샷 제거(R2 업로드 경로로 일원화 — 기존 배포 POST 는 base64 를 D1 에 직접 넣고 있었다).

| 항목 | 파일:라인 | 변경 |
|---|---|---|
| 저장 결과 반환 | `public/js/modules/20_App.js:3277~3345` | `_saveNow` → `Promise<boolean>` (가드/중복/실패 false, 성공 true) |
| 배포 정합 | `public/js/modules/20_App.js:3401~3438` | 배포 전용 POST 제거 → `_saveNow` 재사용 + 불변식 재연결 + `pageCount` 를 State 에서 파생 |
| 미니맵 타이틀 대비 | `public/css/style.css:1396~1399` | `var(--gold)` → `#e9b949` 고정 |

**대비 실측**: `--gold` 는 `18_Brand.js:19` 이 런타임에 테넌트 accent(`#1b75bb`)로 덮어쓴다.
헤더 배경 `rgba(10,16,32,.92)` 합성값(백드롭 밝기 양극단) `rgb(14,20,36)`~`rgb(10,16,31)` 기준
**옛 `#1b75bb` = 3.76:1 / 3.90:1 (10px 본문 4.5:1 미달)** → **새 `#e9b949` = 10.03:1 / 10.40:1 (AAA)**.
기존 주석 기준색 `#242835` 대비도 8.04:1.

**검증 증거**
- `node tests/p1-deck-drawing.test.mjs` → **22/22 PASS, EXIT=0** (기존 12 + P4 신규 10)
- 뮤테이션 2건 성립: ① 배포 전용 POST 경로 복원 → 컨텍스트 없는 고아 배포본 POST 재현 ② 재연결 가드를 옛 `!cd.deployment_id` 로 되돌림 → stale 링크(`deck=dep_stale` vs `autoSave=dep_old`) 재현
- `python build-tools/assemble.py` EXIT=0 (38모듈 → 12513줄) · MIRROR EXIT=0 · `node --check public/js/main.js` EXIT=0 · `npx vite build` EXIT=0 (`dist/_worker.js` 98.05 kB) · `wrangler pages deploy` EXIT=0 (66 files)
- 배포 URL: https://37a73b2b.scan360.pages.dev · 프로덕션 실측 `curl https://scan360.pages.dev/css/style.css` → `pano-radar-title … color: #e9b949` (200), `/js/main.js` 에 `배포 = 저장(_saveNow) 재사용` 1건 (200)

### 미완 / 잔여 리스크(정직 보고)
- **기존 D1 데이터의 고아·중복 배포본은 코드 수정으로 정리되지 않는다.** 실데이터 삭제는 수행하지 않았다(파괴적 행동 — 마스터 승인 필요).
- `_loadDeployment` 설계자 재진입 경로(`20_App.js:3617`)는 프로젝트의 **최신** 배포본을 `autoSaveDepId` 로 잡는다. 이때 `Projects.currentDeck` 와 어긋날 수 있으나, 그 상태에서 사용자가 '배포'를 누르면 위 재연결 블록이 구역을 현재 작업본으로 교정한다. '저장'만 누르는 경우의 교정은 이번 범위 밖(배포 시점 불변식만 강제).
- UI 4단계 육안 검증은 미수행(브라우저 세션 없음) — 위 검증은 정적·빌드·테스트·프로덕션 자산 실측까지.
