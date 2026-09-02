# RESUME_LEDGER — 자동 재개 원장 (5시간 간격 자동 실행이 이 파일을 기준으로 이어받는다)

> 갱신 규칙: 매 턴 끝 + 항목 상태가 바뀔 때마다 즉시 갱신. ✅ 는 검증 증거가 있을 때만.
> 이 파일이 비면(미완료 0) 자동 재개는 아무것도 하지 않고 종료한다.

## 미완료 (자동 재개가 이어서 처리)

- [x] **A. 배포 경로 고아/중복 배포본 근본수정** (커밋 bb0813f · 배포 = 저장 경로 재사용 · 22/22 PASS)
  - ~~아래 원문 보존~~ — `public/js/modules/20_App.js:3361 _deployToViewer()`
  - 결함: 배포 클릭마다 `POST /tables/deployments` 로 새 배포본 생성 + `State.autoSaveDepId` 를 새 ID로 교체.
    구역 재연결은 `deployment_id` 가 비어있을 때만 → 구역은 옛 배포본을 계속 가리키고 이후 저장(PATCH)은 새 배포본으로 감.
  - 불변식: 배포 후 `deck.deployment_id === State.autoSaveDepId`.
  - 상태: 2026-09-02 실행자 발주됨(진행 중일 수 있음). git log 로 반영 여부 먼저 확인할 것.
- [x] **B. 미니맵 제목 대비** (#e9b949, prod 실측 10.05:1)
  - ~~아래 원문 보존~~ — `public/css/style.css:1396 .pano-radar-title`
  - `var(--gold)` 가 rgb(27,117,187) 로 풀려 헤더 배경 rgba(10,16,32,.92) 위 **3.9:1** (10px 본문, 4.5 미달).
  - 고정 밝은색으로 교체 후 대비비 실측 첨부.
- [x] **C. 배포 후 라이브 재검증** (prod 실클릭 완료: 미니맵 헤더 3버튼 히트테스트 OK · 방향보정 fan rotate+토스트 · 편집모드 전환 후 btn-save 비-dirty · 콘솔 오류 0 · 조작 바 10버튼 전부 클릭 가능 · 제목 대비 10.05:1)
  - ~~원문 보존~~  — A/B 반영본을 prod 에서 실제 클릭으로 확인.
  - 확인 항목: 미니맵 헤더 3버튼 히트테스트 / 방향보정 커밋(fan rotate + 토스트) / 뷰어→편집모드 전환 시 `#btn-save` 가 dirty 아님 / 콘솔 오류 0.
- [ ] **D. P1 라이브 검증 — 보류(사유 기록)**: 네이티브 파일창은 자동화 불가. `DataTransfer` 로 file input 에 가짜 File 을 주입하는 우회가 가능하나 ① OS 파일창이 열린 채 남을 위험 ② prod TEST1 에 검증용 구역·배포본이 실제로 생성됨(고아 데이터 13건 이미 존재). 근거는 `tests/p1-deck-drawing.test.mjs` 22/22 + 뮤테이션 2건으로 유지하고, **로컬 dev 서버가 뜨는 시점에 그 환경에서 수행**한다.
  - ~~원문 보존~~  — 네이티브 파일창은 브라우저 자동화로 못 누름.
  - 현재 근거는 `node tests/p1-deck-drawing.test.mjs` 12/12 뿐. 파일 input 에 `DataTransfer` 로 가짜 File 을 주입해 change 를 발화시키는 방식으로 라이브 경로 검증을 시도할 것.

- [ ] **F. 파노라마 마커(숫자 표식) 드래그 이동** — 마스터 2026-09-02: "마크때문에 가려지는 경우가 있으니 ... 드래그로 가능하게해"
  - 현황: `06_PanoViewer.js:326 renderSpots()` 가 spot(lon/lat)을 Sprite 로 그림. `hitSpotAt`(354줄)·`screenToLonLat`(346줄) 존재.
    포인터 바인딩은 `20_App.js:1396~1436`(mouse/touch → `PanoViewer.onPointerDown/Move/Up`), 탭 처리 `_onPanoTap`(2148줄).
  - 요구: 마커를 눌러 끌면 그 위치가 이동하고 놓으면 저장(`_saveSpots`). 탭(이동 없음)은 기존대로 노트 열기.
    카메라 회전과 충돌 없어야 하고 터치도 동작. 편집 권한 없는 뷰어는 이동 불가.
  - 성능: 드래그 중 `renderSpots` 전체 재생성 금지 → 해당 Sprite 위치만 갱신하는 경로 추가.
- [x] **G. 미니맵 기본 확대 + 점 번호 표시** — 커밋 `e6bc704`. 기본=확대(localStorage `wm-radar-large` 로 사용자 선택 유지), 점 번호는 `11_UI.js` dispNo 로직 재사용. 13/13 PASS·뮤테이션 2건. **빌드/배포는 F 와 합쳐서 1회 예정.**

- [ ] **H. 사진 폴더 일괄 매칭(핀 번호 ↔ 촬영시각 1:1)** — 마스터 2026-09-03
  - 요구 원문: "핀을 순서대로 받고 나서 사진이 들어있는 폴더를 선택하면 사진 생성 시간 순서대로 핀 번호대로 1번부터 몇 번까지 설정한 후 업로드하면 핀 번호 순서 ↔ 사진 시간 순서로 1:1 매칭돼서 그 위치에 사진이 등록"
  - 재사용할 기존 배선(정찰 완료 · 재조사 금지):
    `Cloud.resizeImage(file)` → {dataURL,width,height} / `Cloud.uploadImage(name,dataURL,w,h)` → imageId
    핀 필드: `pin.imageId`,`pin.imageName` · 오프라인 폴백은 `20_App.js:1920~` `_confirmPin` 이미지 분기와 동일 경로
    360 판별: `App._detect360(file,cb)`(2:1 ±8%) · 번호 정본: 항목 I 의 핀 번호 정본 함수(도면·미니맵 공용)
  - 사양(확정):
    ① 범위 입력: 시작~끝 핀 번호(기본=현재 페이지 전체) ② 폴더 선택(`webkitdirectory`) + 다중 파일 선택 폴백(모바일)
    ③ 정렬: EXIF DateTimeOriginal → 없으면 파일 lastModified → 없으면 파일명 자연정렬. **각 행에 정렬 근거를 표시**(추측을 사실처럼 보이게 하지 말 것)
    ④ 매칭 미리보기 표: 핀번호 ↔ 파일명 ↔ 촬영시각 ↔ 360여부 ↔ 기존사진 유무. 개수 불일치 시 남는 쪽을 명확히 경고. 행 제외 체크박스.
    ⑤ 실행: 순차 업로드(동시 2~3), 진행률, 실패 건 표시 + 오프라인이면 기존 큐로 폴백
    ⑥ 이미 사진 있는 핀은 **기본 건너뛰기**(덮어쓰기는 사용자가 명시 선택)
    ⑦ 자동저장 OFF 정책 유지 — 일괄 등록 후 미저장 표시만, 저장은 사용자가
  - 주의: EXIF 파서는 의존성 없이 최소 구현(APP1/TIFF IFD 에서 DateTimeOriginal 만).
- [x] **I. 핀 색상·번호 계열 분리 + 필터 칩** — **완료(2026-09-03)**. 커밋 `e34d06d`+`b2f53ad`, 배포 https://b1a21464.scan360.pages.dev
  - 정본 신설 `public/js/modules/01b_PinSeries.js` (manifest 01_State 다음). `numbers()/kindOf()/colorsOf()/isVisible()/renderChips()/nextCheckboardNo()`.
  - 소비처 3곳이 정본만 호출: `11_UI.renderPinsOnMap`(자체 pageIdx 제거) · `07_Radar.update`(자체 radarIdx 제거) · `20_App._placeCheckboardPin`(전체 핀 수 → 체크보드 수).
  - 계열 분리: 콘텐츠 계열/체크보드 계열 각각 1부터. 체크보드는 저장 label 숫자 우선(데이터 불변).
  - 색: 체크보드를 팔레트 블루(#2f6db5)와 겹치지 않는 인디고 `#1d4ed8` 로 분리 + 색맹 대비 링 패턴(실선/점선/파선).
  - 필터 칩 `#pin-filter-bar`(전체/콘텐츠/미배치/체크보드 + 개수 배지), 도면·미니맵 동시 적용, localStorage `wm-pin-filter`.
  - 검증: `tests/p4-pin-series.test.mjs` 신설 21건 + p1/p2/p3 전부 ALL PASS(EXIT=0), 뮤테이션 2건 성립. 대비 실측 전부 4.5:1 초과.
  - 잔여: 팔레트를 "블루"로 바꾸면 콘텐츠 핀과 체크보드 핀의 **명도차가 1.27:1**(링 패턴·번호 계열로만 구분). UI 육안 4단계 미수행.
- [ ] **J. E57 브라우저 파서** — 발주됨(진행 중). `09_FLS.js` 가 E57 을 직접 열도록. 지휘자가 실파일로 파싱 가능함을 이미 증명(build-tools/e57-probe.mjs · e57-decode-sample.mjs).

## 마스터 승인 대기 (자동 재개가 임의로 실행 금지 — 실데이터 변경)

- [ ] **E. D1 데이터 정리** (2026-09-02 실측: deployments 13 / decks 4 / projects 2)
  - 고아 배포본 **13/13**(구역이 참조하는 배포본 0), 도면없음 구역 **4/4**(TEST1: MAINDECK·A·ETR·SDF), 중복 file_name 4그룹.
  - 제안: `dep_mqokv6ys_a2h5m9ov`(137K FSRU, 17핀)을 TEST1 구역 하나에 연결 → 나머지 12건 soft-delete(`deleted=1`).
  - 🔴 마스터가 명시 승인하기 전까지 UPDATE/DELETE 금지. SELECT 집계만 갱신 가능.

## 완료 (증거 있음)

- [x] P0 미니맵 헤더 히트테스트 — prod 실클릭 통과(버튼 자체가 `elementFromPoint` 반환).
- [x] 방향보정 — 스테이지 클릭 시 fan `rotate(89.76deg)` + "시야 방향이 조정되었습니다" + 모드 자동 해제.
- [x] P0-2 false-dirty — 뷰어→편집모드 전환 후 `btn-save hidden`, 미저장 표시 없음.
- [x] P2 '도면없음' 태그 대비 — `#7C2D12` on `#FBE3CD` = 7.58:1 (prod 실측).

## 환경 메모 (재조사 금지)

- node: `C:\Users\FREE\AppData\Roaming\fnm\node-versions\v20.17.0\installation\node.exe` (PowerShell 에 `npx` PATH 없음).
- D1 조회: `& $node node_modules\wrangler\bin\wrangler.js d1 execute webapp-production --remote --json --command "<SELECT>"`.
- 빌드 체인: `python build-tools/assemble.py` → MIRROR → `node --check public/js/main.js` → `pm2 stop webapp 2>/dev/null; NODE_OPTIONS="--max-old-space-size=896" npx vite build` → `npx wrangler pages deploy dist --project-name scan360 --commit-dirty=true`.
- prod: https://scan360.pages.dev · 뷰어 샘플: `/?mode=viewer&d=dep_mqokv6ys_a2h5m9ov`
