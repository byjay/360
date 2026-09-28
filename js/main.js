/**
 * 360° Location Viewer System — We:are Marine  (v3)
 *
 * v3 주요 변경:
 *  - 360° 뷰어: CPU 픽셀루프 → Three.js WebGL (수십 배 빠름, 자동회전/줌/초기시점/전체화면 컨트롤)
 *  - 핀 생성 시 그림 파일 직접 업로드 + 저장 이름 지정 → 클라우드(테이블 API)에 영구 저장
 *  - 저장 직후 "다음 포인트 지정" 버튼으로 연속 배치 워크플로우
 *  - 핀 저장/선택 시 해당 위치로 플라이투(줌인 이동) 애니메이션 + 핀 드롭 모션
 *  - PDF 멀티페이지: 핀에 page 기록, 배포 시 전 페이지 스냅샷, 뷰어에서 페이지 전환 지원
 *
 * 의존: PDF.js 3.11.174 / Three.js 0.147.0 (모두 CDN)
 */

(function () {
  "use strict";

  /* ══════════════════════════════════════════
     STATE
  ══════════════════════════════════════════ */
  // [B5] 영상 핀 blob URL 추적 — reset/삭제 시 revoke 하여 메모리 누수 차단
  const _videoBlobs = [];
  function _trackVideoBlob(url) { if (url) _videoBlobs.push(url); }
  function _revokeVideoBlob(url) {
    if (!url) return;
    const i = _videoBlobs.indexOf(url);
    if (i !== -1) _videoBlobs.splice(i, 1);
    try { URL.revokeObjectURL(url); } catch (e) {}
  }
  function _revokeAllVideoBlobs() {
    _videoBlobs.splice(0).forEach(u => { try { URL.revokeObjectURL(u); } catch (e) {} });
  }

  /* [P14 설계 메모] 원본 PDF 를 `State.pdfDoc` 에 넣지 않고 `State.srcPdfDoc` 로 분리한 이유:
     `State.pdfDoc` 는 "지금 화면을 PDF 캔버스 파이프라인으로 그리고 있다"는 뜻으로
     UI.renderPdfThumbs / Radar._buildHiResSnapshot / PinGrid / App._rotatePdf 가 분기한다.
     뷰어(스냅샷 <img> 바탕)에서 여기에 문서를 넣으면 그 형제 호출부들이 전부 오작동한다.
     두 값은 같은 사실의 중복이 아니라 서로 다른 사실이며,
     "재래스터할 원본이 있는가" 는 MapCtrl.hasRerenderSource() 한 곳에서만 파생시킨다. */
  const State = {
    mode:        null,      // 'designer' | 'viewer'
    checkboard:  false,     // 체크보드 모드: 디자이너와 동일하나 핀에 이름 대신 번호만 자동 부여
    editMode:    false,     // [마스터 요청] 포인트 수정 모드: ON이면 핀 클릭 시 수정/이동/삭제 팝업
    fileType:    null,      // 'pdf' | 'image'
    fileName:    null,
    imageUrl:    null,      // blob URL (revoke on reset)
    fileData:    null,      // ArrayBuffer (PDF)
    pdfDoc:      null,
    pdfPage:     1,
    pdfPages:    0,
    pdfRotation: 0,         // 0 | 90 | 180 | 270 (PDF.js 내장 회전)
    viewerPages: null,      // 뷰어 모드: 배포본 페이지 dataURL 배열
    /* ── [P14] 배포 스냅샷의 "원본 PDF" (확대 시 재래스터용) ──
       뷰어/구역 재열람은 배포 스냅샷(비트맵)만 그리므로 확대하면 뭉갠다.
       배포 시 R2 에 보관해 둔 원본 PDF 를 임계 배율을 넘겼을 때만 1회 지연 로드한다. */
    sourceMeta:   null,     // 배포본 source_meta 파싱 결과 { v, pdf_url, pages:[{w,h,pw,ph}] }
    sourcePdfUrl: null,     // 원본 PDF 의 R2 URL (없으면 구버전 배포본 = 스냅샷 확대 폴백)
    srcPdfDoc:    null,     // 지연 로드된 원본 PDFDocumentProxy (State.pdfDoc 과 별개 — 아래 주석)
    srcNoticed:   false,    // 구버전 안내를 이미 1회 했는가(반복 알림 금지)
    srcFailed:    false,    // 원본 다운로드/파싱 실패 — 재시도 금지(불필요 다운로드 0)
    pins:        [],        // {id,x,y,page,label,imageUrl?,imageId?,imageName?}
    annotations: [],        // {id,page,type:'highlight'|'rect'|'pen'|'text',color,...좌표(%)} PDF 주석
    annoTool:    "cursor",  // 현재 주석 도구
    annoColor:   "#ff3b30", // 현재 주석 색상
    zones:       [],        // {id,page,x,y,w,h,label,color,pinIds[],note} 영역(%) 줌무관
    placing:     false,
    drawingZone: false,     // 영역 그리기 모드
    isoView:     false,     // ISO 3D 아이소메트릭 뷰 (평면↔입체 회전)
    isoDir:      0,          // ISO 시점 방향 0~3 (북동/남동/남서/북서) — 4방향 회전
    pending:     null,      // { x, y }
    intakeFile:  null,      // [THETA 인입] 위치지정 대기 중인 R* 360 사진 파일 (도면 탭 시 핀에 주입)
    pendingFile: null,      // 선택된 360° 그림/영상 파일
    pendingIsVideo: false,
    pendingDocs: [],        // 첨부 문서 후보 [{tempId, file, name, size, kind, status, docId}]
    pendingFls:  null,      // 첨부된 3D 포인트클라우드 { localId, name, size }
    pendingIcon: "number",  // [마스터 요청] 핀(호스팟)별 아이콘 선택값 (기본=번호)
    editingPinId: null,     // 기존 포인트 편집 중인 id (null=신규)
    movingPinId: null,      // 드래그로 위치 이동 중인 포인트 id
    pinEditUnlocked: null,  // '수정' 버튼으로 이동/편집 잠금 해제된 핀 id (이 id만 드래그 이동 가능)
    autoSaveDepId: null,    // 자동 저장된 배포본(작업본) id — 도면 업로드 즉시 생성
    autoSaving: false,      // 자동 저장 진행 중 플래그
    depVersion: 0,          // [멀티유저 충돌방지] 현재 로드된 배포본의 서버 version(낙관적 잠금 기준값)
    activePin:   null,
    zoom:        1,
    pan:         { x: 0, y: 0 },
    panDragging: false,
    panStart:    { mx: 0, my: 0, px: 0, py: 0 },
    viewerLocked: false,
    currentProjectId: null,
    currentProjectName: null,
    currentDeploymentId: null,   // 현재 로드된 배포본 id (노트/협업 연결용)
    noteSummary: {},             // { pin_id: {total,open,progress,done} } 도면 뱃지용
    pinColor:    null,           // 핀 기본 색상(설정에서 변경) — null이면 PinPrefs 기본(green)
    checkboardStart: {},         // { [page]: 시작번호 } 구역(페이지)별 체크보드 시작 번호
    zoneView:    null,           // 구역 페이지(crop-view) 진입 중인 zone id — null이면 전체 도면

    reset() {
      if (this.imageUrl) { URL.revokeObjectURL(this.imageUrl); this.imageUrl = null; }
      _revokeAllVideoBlobs(); // [B5] 영상 핀 blob URL 일괄 해제
      this.fileType = null; this.fileName = null;
      this.fileData = null; this.pdfDoc = null;
      this.pdfPage = 1; this.pdfPages = 0; this.pdfRotation = 0; this.viewerPages = null;
      // [P14] 원본 PDF 지연 로드 상태 초기화 — 도면이 바뀌면 이전 원본은 거짓 화면이 된다.
      this.sourceMeta = null; this.sourcePdfUrl = null; this.srcPdfDoc = null;
      this.srcNoticed = false; this.srcFailed = false;
      this.pins = []; this.zones = []; this.placing = false; this.drawingZone = false; this.pending = null;
      this.pendingFile = null; this.pendingIsVideo = false;
      this.pendingDocs = [];
      this.pendingFls = null;
      this.pendingIcon = "number";
      this.editingPinId = null; this.movingPinId = null;
      this.autoSaveDepId = null; this.autoSaving = false; this.depVersion = 0;
      this.activePin = null; this.zoom = 1; this.pan = { x: 0, y: 0 };
    }
  };

  /* ══════════════════════════════════════════
     PDF MODULE
  ══════════════════════════════════════════ */

  /* ══════════════════════════════════════════
     PIN SERIES — 핀 번호 · 색상 계열 · 표시 필터의 정본(SoT)
     ------------------------------------------------------------------
     [마스터 요청 2026-09-02]
       "360 사진/첨부를 넣는 핀과 단순 체크보드 핀은 색상을 달리하고,
        각각 일련번호도 따로, 그 핀만 보기 버튼도 칩 버튼(필터)으로."

     🔴 이 파일이 유일한 정본이다.
        - 도면 마커: 11_UI.js renderPinsOnMap()
        - 미니맵 점: 07_Radar.js update()
        - 체크보드 다음 번호: 20_App.js _placeCheckboardPin()
        셋 다 여기 함수만 호출한다. 각자 세면 화면마다 번호가 어긋난다
        (전역 CLAUDE.md §10 SoT — 같은 사실을 두 곳에 쓰면 반드시 갈라진다).

     계열(series) = 채번 단위 · 2종
       content    : 체크보드가 아닌 모든 핀 → 1부터 독립 채번
       checkboard : 체크보드 핀        → 저장된 label 숫자 우선(페이지 시작번호 반영),
                                          숫자가 없으면 체크보드 계열 순번

     부류(kind) = 색상/필터 단위 · 3종
       content    : 360·첨부 등 콘텐츠 있음
       empty      : 자리만 잡은 핀(콘텐츠 없음)
       checkboard : 체크보드 핀
  ══════════════════════════════════════════ */
  const PinSeries = {
    KINDS: ["content", "empty", "checkboard"],
    LABELS: { content: "콘텐츠", empty: "미배치", checkboard: "체크보드" },
    FILTER_KEY: "wm-pin-filter",

    /* [마스터 요청 2026-09-18, 정정] 프로젝트를 새로 열 때 배치 모드(designer/checkboard)의
       기본값 = 등록모드(designer). 사용자가 명시 전환하면 그 선택을 기억해 다음에도
       유지한다(SoT: 이 값 하나만 — App.openApp 호출부들은 전부 preferredMode()를
       참조하고, 하드코딩된 "designer" 를 직접 쓰지 않는다).
       🔴 저장된 기존 핀의 checkboard/kind 해석은 이 값과 무관 — 이건 오직
          "새 배치 시작 시 어느 모드로 열리는가"만 결정한다.
       (2026-09-18 11:23 커밋에서 체크보드로 바꿨다가, 같은 날 마스터가 등록모드로
        되돌리라 정정 — 기본값만 뒤집고 SoT 구조·저장된 선택 우선순위는 그대로 유지.) */
    PREFERRED_MODE_KEY: "wm_pin_default_mode",
    DEFAULT_MODE: "designer",
    preferredMode() {
      try {
        const v = localStorage.getItem(this.PREFERRED_MODE_KEY);
        if (v === "designer" || v === "checkboard") return v;
      } catch (e) {}
      return this.DEFAULT_MODE;
    },
    setPreferredMode(mode) {
      if (mode !== "designer" && mode !== "checkboard") return;
      try { localStorage.setItem(this.PREFERRED_MODE_KEY, mode); } catch (e) {}
    },

    /* ── 색상 정본 ────────────────────────────────────────────
       머리색(head/head2) · 바늘끝(needle) · 숫자 글자색(text).
       숫자는 흰 디스크(#fff) 위에 놓이므로 text ↔ #fff 대비가 판독 기준.
       실측(WCAG 2.1 상대휘도):
         content(사용자 팔레트) : 6.40 ~ 9.00 : 1  (PinPrefs.PALETTE 6종 전부 4.5:1 초과)
         empty  #991b1b         : 8.27 : 1
         checkboard #1e3a8a     : 10.49 : 1
       ⚠ 색만으로 구분하지 않는다(색맹 8%) — ring 패턴(solid/dotted/dashed)을 함께 준다. */
    EMPTY_COLOR: { head: "#ef4444", head2: "#b91c1c", needle: "#7f1d1d", text: "#991b1b" },
    // 체크보드는 사용자 팔레트(PinPrefs)의 "블루"(#2f6db5)와 겹쳐 보이던 문제가 있었다.
    // → 더 진하고 채도 높은 인디고로 분리해 콘텐츠 핀과 확실히 구분.
    CHECKBOARD_COLOR: { head: "#1d4ed8", head2: "#1e3a8a", needle: "#172554", text: "#1e3a8a" },
    /* [마스터 2026-09-03] "사진이 등록된거와 아닌거 심볼색을 다르게해"
       체크보드 계열은 사진 유무와 무관하게 늘 같은 색이라, 일괄 매칭 직후
       무엇이 등록됐는지 화면으로 확인할 방법이 없었다(kindOf 가 checkboard 를
       콘텐츠 판정보다 먼저 반환하기 때문).
       → 계열 정체성(인디고 블루)은 유지하고 명도만 갈라 등록/미등록을 구분한다.
       🔴 [2026-09-17 재실측·수정] 예전 값(head2 #6366f1·needle #4f46e5)의
       등록↔미등록 상호 분리도는 head2 2.32:1 / needle 2.34:1 — WCAG 비텍스트
       UI 요소 최소 기준(3:1, 1.4.11)에 못 미쳐 실제로 "같은 색으로 보인다"는
       마스터 신고(스크린샷 핀 2·3·4·3)의 원인 중 하나였다. 한 단계 더 밝은
       톤으로 교체해 분리도를 3:1 이상으로 올렸다(계산: (max L+.05)/(min L+.05)).
       실측(WCAG 2.1, 흰 도면 #fff 기준 — 아래 값은 테마 변수 아님·라이트/다크 동일):
         등록   head #1d4ed8 · head2 #1e3a8a 10.36:1 · needle #172554 14.69:1 · text #1e3a8a 10.36:1
         미등록 head2 #7881f6 3.35:1 · needle #4f46e5(불변) 6.29:1 · text #4338ca(불변) 7.90:1
         등록↔미등록 상호 분리도 head 3.36:1 / head2 3.09:1 (WCAG 3:1 이상 충족)
         🔴 needle 은 minimap 점 배경(≥4.5:1 필요, tests/p9)이라 원래 진한 값을 유지했다
         → needle 상호 분리도는 2.34:1 로 남는다(needle 은 얇은 바늘·미니맵 점이라
         "공"(머리) 색 대비를 우선했다 — head/head2 가 시각적으로 지배적인 부분).
       ⚠ 색만으로 구분하지 않는다 → patternOf() 형태 단서(실선/파선/점선) 병행 +
         모든 마커 공통 진한 외곽 링(stroke #1a1a1a)이 흰 도면 위 경계를 보강한다. */
    CHECKBOARD_EMPTY_COLOR: { head: "#a5b4fc", head2: "#7881f6", needle: "#4f46e5", text: "#4338ca" },

    /* 형태 단서 정본(색각 이상 8% 대비) — 도면 링 dasharray 와 미니맵 점 테두리가
       같은 이름 하나에서 파생된다. 두 곳에 따로 쓰면 반드시 갈라진다(§10 SoT).
         solid  = 콘텐츠 등록됨 / dashed = 체크보드(등록됨) / dotted = 미등록 */
    PATTERN: {
      solid:  { dash: "",        border: "solid"  },
      dotted: { dash: "2.6 2.6", border: "dotted" },
      dashed: { dash: "6 3.4",   border: "dashed" }
    },

    /** 핀에 콘텐츠(360/영상/첨부/노트/3D)가 있는가 — App.pinHasContent 가 정본 */
    hasContent(pin) {
      if (typeof App !== "undefined" && App.pinHasContent) { try { return !!App.pinHasContent(pin); } catch (e) {} }
      return !!(pin && (pin.imageId || pin.imageUrl || pin.videoId));
    },

    /** 색상/필터 부류 (3종) */
    kindOf(pin) {
      if (!pin) return "empty";
      if (pin.checkboard) return "checkboard";
      return this.hasContent(pin) ? "content" : "empty";
    },

    /** 채번 계열 (2종) */
    seriesOf(pin) { return (pin && pin.checkboard) ? "checkboard" : "content"; },

    /** 부류별 색상 세트 (도면 마커 SVG · 미니맵 점 공용)
     *  @param {string} kind   부류(content/empty/checkboard)
     *  @param {boolean} [filled] 사진(콘텐츠) 등록 여부. 체크보드 계열에서만 의미가 있다.
     *         (미지정 = 등록된 것으로 간주 — 기존 호출부 호환) */
    colorsOf(kind, filled) {
      if (kind === "checkboard") return (filled === false) ? this.CHECKBOARD_EMPTY_COLOR : this.CHECKBOARD_COLOR;
      if (kind === "empty") return this.EMPTY_COLOR;
      return (typeof PinPrefs !== "undefined" && PinPrefs.color)
        ? PinPrefs.color()
        : { head: "#10b981", head2: "#047857", needle: "#064e3b", text: "#065f46" };
    },

    /** 형태 단서 이름 (색 없이도 등록 여부를 읽게 하는 축) */
    patternOf(kind, filled) {
      if (kind === "checkboard") return filled ? "dashed" : "dotted";
      return (kind === "empty") ? "dotted" : "solid";
    },

    /**
     * 🔴 도면 마커(11_UI) · 미니맵 점(07_Radar) 공용 표시 스타일 정본.
     * 계열(kind) × 사진 등록 여부(filled) 두 축을 한 번에 판정해 색·형태를 함께 돌려준다.
     * 두 화면이 각자 판정하면 "사진이 있는데 없다고 보이는" 거짓말이 된다(§10 SoT).
     * @returns {{kind:string, filled:boolean, colors:object, dash:string, border:string}}
     */
    markerStyle(pin) {
      const kind = this.kindOf(pin);
      const filled = this.hasContent(pin);
      const pat = this.PATTERN[this.patternOf(kind, filled)] || this.PATTERN.solid;
      // [WO 20260917] tier = 콘텐츠 3상태(photo/content/empty) — filled(등록여부) 축은 불변,
      // tier 는 그 안(filled=true)을 사진유무로 더 세분하는 부가 필드(기존 소비자는 무시해도 무방).
      return { kind: kind, filled: filled, colors: this.colorsOf(kind, filled), dash: pat.dash, border: pat.border, tier: this.contentTier(pin) };
    },

    /**
     * 🔴 번호 정본. 페이지 내 핀들의 표시 번호를 한 번에 계산한다.
     * @param {Array} pins  State.pins (전체)
     * @param {number} page 대상 페이지
     * @returns {Map<id, {no:number, kind:string, series:string}>}
     *
     * - content / checkboard 계열이 각각 1부터 독립 채번된다.
     * - 체크보드 핀은 저장된 pin.label 숫자를 우선 사용(기존 저장 데이터 불변 · 마이그레이션 없음).
     * - 🔴 항상 "필터와 무관하게 전체 핀"으로 계산한다 → 필터를 켜도 번호가 재계산되지 않는다.
     */
    numbers(pins, page) {
      const map = new Map();
      const pg = page || 1;
      let nContent = 0, nCheck = 0;
      (pins || []).forEach((p) => {
        if (!p) return;
        if ((p.page || 1) !== pg) return;
        const series = this.seriesOf(p);
        let no;
        if (series === "checkboard") {
          nCheck++;
          const lbl = parseInt(p.label, 10);
          no = Number.isFinite(lbl) ? lbl : nCheck;
        } else {
          nContent++;
          no = nContent;
        }
        map.set(p.id, { no: no, kind: this.kindOf(p), series: series });
      });
      return map;
    },

    /** 체크보드 다음 번호 = max(시작번호, 같은 페이지 체크보드 핀들의 label 숫자 최댓값 + 1).
     *  🔴 [2026-09-17 근본수정] 예전엔 "개수"를 셌다 — 핀이 삭제되면 개수가 줄어
     *  다음 채번이 기존 남은 번호와 겹쳤다(1,2,3,4 중 3번 삭제 → 개수 3 → 다음 번호 1+3=4,
     *  이미 존재하는 4와 중복). 최댓값+1 로 바꾸면 삭제로 생긴 구멍은 구멍인 채 남고
     *  (재사용 안 함 — 마스터 명시: 번호는 현장 기록과 연결된 값), 번호는 항상 처음 보는 값이 된다.
     *
     *  🔴 [WO 20260917 멀티유저 ①·재설계] 시작번호 = "사용자별 번호 대역"(마스터 확정:
     *  "사용자는 시작번호를 100으로 할지 200으로 할지 세팅"). author 를 넘기면 최댓값 계산을
     *  "같은 작성자가 찍은 핀"으로만 한정한다 — 그러지 않으면 다른 사용자의 대역이 내
     *  최댓값에 섞여 내 다음 번호가 상대 대역을 침범한다.
     *  예: A(대역 100) 가 100,101 찍음 → B(대역 200) 가 200 찍음 → A 가 다시 찍으면
     *      전체-최댓값 기준이면 max(100,201)=201(상대 대역 침범, 버그) → author 필터 기준이면
     *      A 소유 핀 중 최댓값(101)+1 = 102(정상, 자기 대역 안에서만 증가).
     *  author 미지정(구버전 호출·비로그인)이면 종전처럼 페이지 전체 기준(하위호환). */
    nextCheckboardNo(pins, page, start, author) {
      const pg = page || 1;
      const s = (Number.isFinite(start) && start >= 1) ? start : 1;
      let maxNo = 0;
      (pins || []).forEach(p => {
        if (!p || (p.page || 1) !== pg || !p.checkboard) return;
        if (author != null && p.author !== author) return; // 대역 침범 방지: 내 핀만 본다
        const n = parseInt(p.label, 10);
        if (Number.isFinite(n) && n > maxNo) maxNo = n; // label 이 숫자가 아니면(NaN) 무시
      });
      return Math.max(s, maxNo + 1);
    },

    /** 🔴 [2026-09-17] 같은 페이지 체크보드 계열에서 label 이 중복된 핀 id 집합.
     *  탐지·표시 전용 — 이미 저장된 중복 번호를 자동으로 바꾸지 않는다
     *  (마스터 명시: 현장 기록과 연결된 실데이터라 임의 재채번 금지).
     *  @returns {Set<number|string>} 중복인 핀들의 id */
    duplicateCheckboardIds(pins, page) {
      const pg = page || 1;
      const byLabel = new Map();
      (pins || []).forEach(p => {
        if (!p || (p.page || 1) !== pg || !p.checkboard) return;
        const key = String(p.label);
        if (!byLabel.has(key)) byLabel.set(key, []);
        byLabel.get(key).push(p.id);
      });
      const dup = new Set();
      byLabel.forEach(ids => { if (ids.length > 1) ids.forEach(id => dup.add(id)); });
      return dup;
    },

    /** [WO 20260918] 🔴 "사용자가 버튼을 누르는" 일괄 재채번 정본 — duplicateCheckboardIds
     *  위 주석의 금지 규율("자동 재채번 금지")과 충돌하지 않는다. 그건 코드가 스스로
     *  판단해 조용히 고치는 걸 막은 것이고, 이건 사용자가 명시적으로 버튼을 눌러 요청한
     *  변경이다 — 이 함수는 UI 에서만 호출되며 자동으로 실행되는 경로가 없다.
     *  🔴 id 는 절대 건드리지 않는다 — 사진/노트는 pin.id 로 연결되므로 라벨(표시 번호)만
     *  바뀌어도 연결은 그대로 유지된다.
     *  순서 보존: 현재 유효 번호(numbers() 파생값) 오름차순으로 정렬해 newStart 부터
     *  연속으로 다시 매긴다(1→newStart, 2→newStart+1 …) — 뒤섞이지 않는다.
     *  중복 방지: 결과 라벨 집합 내부 중복(구조상 발생 안 함) + 대상 밖의 다른 체크보드 핀과의
     *  충돌까지 검사해, 하나라도 겹치면 통째로 거부한다(부분 적용 금지 — 반쯤 바뀐 상태 방지).
     *  이 함수는 미리보기만 계산하고 pins 를 직접 변형하지 않는다 — 실제 반영은 호출부(UI)가
     *  confirm 을 받은 뒤 changes 를 적용한다.
     *  @param {Set|Array} [targetIds] 생략 시 페이지의 체크보드 핀 전체(현재 UI 가 쓰는 범위).
     *         지정하면 그 부분집합만 재채번하고, 대상 밖의 나머지 체크보드 핀과 번호가
     *         겹치면 거부한다(향후 "선택 재채번" 확장 대비 — 지금 UI 는 항상 전체를 넘긴다).
     *  @returns {{ok:boolean, changes:Array<{id,oldLabel,newLabel}>, reason?:string}} */
    renumberCheckboardRange(pins, page, newStart, targetIds) {
      const pg = page || 1;
      const s = parseInt(newStart, 10);
      if (!Number.isFinite(s) || s < 1) return { ok: false, changes: [], reason: "시작 번호를 올바르게 입력하세요(1 이상 숫자)" };
      const map = this.numbers(pins, pg);
      const wantIds = targetIds ? new Set(targetIds) : null;
      const targets = (pins || []).filter((p) => p && (p.page || 1) === pg && p.checkboard && (!wantIds || wantIds.has(p.id)));
      if (!targets.length) return { ok: false, changes: [], reason: "이 페이지에는 체크보드 핀이 없습니다" };
      targets.sort((a, b) => {
        const ai = map.get(a.id), bi = map.get(b.id);
        return (ai ? ai.no : 0) - (bi ? bi.no : 0);
      });
      const changes = targets.map((p, i) => ({ id: p.id, oldLabel: p.label, newLabel: String(s + i) }));
      const newLabelSet = new Set(changes.map((c) => c.newLabel));
      if (newLabelSet.size !== changes.length) return { ok: false, changes: [], reason: "변경 결과에 번호 중복이 발생합니다 — 적용하지 않았습니다" };
      const targetIdSet = new Set(targets.map((p) => p.id));
      const collide = (pins || []).some((p) => p && (p.page || 1) === pg && p.checkboard && !targetIdSet.has(p.id) && newLabelSet.has(String(p.label)));
      if (collide) return { ok: false, changes: [], reason: "기존 다른 체크보드 핀과 번호가 겹칩니다 — 적용하지 않았습니다" };
      return { ok: true, changes: changes };
    },

    /** [WO 20260918] 개별 번호 변경 검증 — 이미 쓰는 번호로 바꾸려 하면 거부(조용히 삼키지 않음).
     *  체크보드 핀에만 적용(콘텐츠/빈 핀의 label 은 자유 텍스트라 번호 유일성 규칙이 없다).
     *  @returns {{ok:boolean, newLabel?:string, reason?:string}} */
    validateCheckboardLabel(pins, page, pinId, newLabel) {
      const pg = page || 1;
      const lbl = String(newLabel == null ? "" : newLabel).trim();
      if (!lbl) return { ok: false, reason: "번호를 입력하세요" };
      if (!/^\d+$/.test(lbl)) return { ok: false, reason: "체크보드 번호는 숫자만 가능합니다" };
      const dup = (pins || []).some((p) => p && p.id !== pinId && (p.page || 1) === pg && p.checkboard && String(p.label) === lbl);
      if (dup) return { ok: false, reason: "이미 사용 중인 번호입니다(" + lbl + ") — 다른 번호를 입력하세요" };
      return { ok: true, newLabel: lbl };
    },

    /* ══ 표시 필터 ══════════════════════════════════════════
       숨김 = 표시만 감춘다. 저장 데이터·번호 계열은 필터와 무관하게 불변. */
    _filter: null,

    /** 현재 필터 상태 { content, empty, checkboard } — 이 탭의 열람 세션 동안만 유지.
     *  🔴 [WO 20260921 근본수정] 예전엔 localStorage(wm-pin-filter, 전역 키)에 영구 저장했다 —
     *  프로젝트/배포본 구분이 없는 전역 키라, 한 프로젝트에서 "체크보드" 계열을 껐다 나가면
     *  그 값이 브라우저에 남아 완전히 다른(새) 프로젝트를 열 때도 조용히 적용되어, 그 프로젝트의
     *  핀이 전부(또는 한 계열이 전부) 안 보이는 유령 결함이 됐다(마스터 신고: "체크보드 모드일 때
     *  핀이 안 생긴다"). 새로 열 때마다 항상 전체 표시로 시작하는 게 안전하므로 영구저장을 끊는다
     *  (이 값은 이제 페이지 스크립트가 살아있는 동안의 메모리 상태일 뿐 — 새로고침/새 프로젝트=항상 전체표시). */
    filter() {
      if (!this._filter) this._filter = { content: true, empty: true, checkboard: true };
      return this._filter;
    },

    /** 핀의 아이콘 종류 id (없으면 기본 number) — PinIcons.SET 의 id 와 1:1 */
    iconOf(pin) { return (pin && pin.icon) || "number"; },

    /* ══ 종류(아이콘) 필터 — [마스터 요청 2026-09-03] 계열(kind) 필터와 별도 축.
       둘 다 걸어야 보인다(AND) — 같은 SoT 원칙으로 도면·미니맵 양쪽이 이 함수 하나만 본다. */
    ICON_FILTER_KEY: "wm-pin-icon-filter",
    _iconFilter: null,

    /** 아이콘별 표시 상태 맵 { iconId: boolean }. 키가 없으면 표시(기본 전체 표시).
     *  🔴 [WO 20260921] 계열 필터(filter())와 같은 이유로 localStorage 영구저장 제거 —
     *  전역 키가 프로젝트를 가리지 않고 새 프로젝트에도 조용히 적용되는 결함을 막는다. */
    iconFilter() {
      if (!this._iconFilter) this._iconFilter = {};
      return this._iconFilter;
    },

    /** 페이지 내 아이콘 종류별 핀 개수 (칩 배지·존재하는 종류만 노출 판단용) */
    iconCounts(pins, page) {
      const pg = page || 1;
      const c = {};
      (pins || []).forEach(p => {
        if (!p || (p.page || 1) !== pg) return;
        const id = this.iconOf(p);
        c[id] = (c[id] || 0) + 1;
      });
      return c;
    },

    isIconVisible(pin) { return this.iconFilter()[this.iconOf(pin)] !== false; },

    isIconAll(presentIds) {
      const f = this.iconFilter();
      return (presentIds || []).every(id => f[id] !== false);
    },

    /** presentIds = 현재 페이지에 실제 존재하는 아이콘 id 목록(칩에 뜬 것들만).
     *  마지막 하나를 끄면 kind 필터와 동일하게 "그것만 보기"로 해석(전체 숨김 금지). */
    toggleIconFilter(iconId, presentIds) {
      const f = this.iconFilter();
      const next = Object.assign({}, f);
      next[iconId] = (f[iconId] === false) ? true : false;
      const anyVisible = (presentIds || []).some(id => next[id] !== false);
      if (!anyVisible) (presentIds || []).forEach(id => { next[id] = (id === iconId); });
      this._iconFilter = next;
      this._persistIcon();
    },

    showAllIcons() { this._iconFilter = {}; this._persistIcon(); },

    /** [WO 20260921] 더 이상 저장하지 않는다(위 iconFilter() 주석 참조) — 호출부 호환을 위해 메서드는 유지. */
    _persistIcon() {},

    /** 🔴 도면 마커·미니맵 점이 공통으로 쓰는 표시 여부 판정 (계열 필터 × 종류 필터 AND) */
    isVisible(pin) { return !!this.filter()[this.kindOf(pin)] && this.isIconVisible(pin); },

    isAll() { const f = this.filter(); return this.KINDS.every(k => f[k]); },

    toggle(kind) {
      const f = this.filter();
      if (this.KINDS.indexOf(kind) < 0) return;
      const next = Object.assign({}, f, {});
      next[kind] = !f[kind];
      // 마지막 하나를 끄는 건 전체 숨김 → 그 하나만 보기로 해석(단독 선택)
      if (!this.KINDS.some(k => next[k])) { this.KINDS.forEach(k => next[k] = (k === kind)); }
      this.KINDS.forEach(k => f[k] = next[k]);
      this._persist();
    },

    showAll() { const f = this.filter(); this.KINDS.forEach(k => f[k] = true); this._persist(); },

    /** [WO 20260921] 더 이상 저장하지 않는다(위 filter() 주석 참조) — 호출부 호환을 위해 메서드는 유지. */
    _persist() {},

    /* ── [WO 20260917 멀티유저 ②·재설계] 사용자 구분 배지 — 4번째 축, 기존 3축(계열/등록여부/종류)과 별개.
       기존 3축은 핀 몸통 색·외곽 링 dasharray·머리 안 아이콘을 쓰므로, 사용자 구분은 겹치지 않게
       몸통 바깥 모서리(11_UI.js 렌더에서 bottom-right, 이슈뱃지 top-right·중복뱃지 top-left와도
       자리 분리)의 작은 배지(숫자/이니셜+색)로만 표시한다. 이 배지는 hasContent/filled 여부와
       무관하게 항상 그려지므로 속 빈 원(미등록)에서도 사용자 구분이 그대로 보인다.
       팔레트 7색 모두 흰 배경(도면) 대비 ≥4.5:1(WCAG AA 실측, ≥3:1 요건 상회):
         #0072B2 5.19 · #5B2C87 9.74 · #1B4965 9.60 · #8B3A3A 7.60 · #2E5E4E 7.43 · #6B4226 8.63 · #264653 10.08
       🔴 SoT: 팔레트는 이 배열 하나뿐 — 대역 인덱스(userMark)·해시 인덱스(authorStyle) 둘 다
       이 배열만 순환 참조한다(대역/작성자 수가 7 초과 시 팔레트를 순환). */
    USER_MARK_PALETTE: ["#0072B2", "#5B2C87", "#1B4965", "#8B3A3A", "#2E5E4E", "#6B4226", "#264653"],

    /** 작성자 식별자(이메일 등) → 배지 색상/이니셜. 결정적(같은 작성자=항상 같은 색·글자).
     *  대역(번호 대) 개념이 없는 계열(content/empty)의 폴백 표시 방식. */
    authorStyle(pin) {
      const a = pin && pin.author;
      if (!a || typeof a !== "string") return null;
      let h = 0;
      for (let i = 0; i < a.length; i++) h = (h * 31 + a.charCodeAt(i)) >>> 0;
      const color = this.USER_MARK_PALETTE[h % this.USER_MARK_PALETTE.length];
      const initial = a.trim().charAt(0).toUpperCase() || "?";
      return { color: color, initial: initial, author: a, band: null };
    },

    /** [WO 20260917 멀티유저 ①·재설계] 사용자별 번호 대역 시작값 — localStorage 에 사용자
     *  이메일 기준으로 저장한다(🔴 배포본 단일 필드에 저장하면 다른 사용자가 저장할 때
     *  덮어써진다 — 사용자별 값은 그 사용자에게 붙어야 한다는 마스터 지시. 각 브라우저의
     *  localStorage 는 사용자별로 독립이므로 이 문제가 구조적으로 발생하지 않는다). */
    BAND_KEY_PREFIX: "wm-user-band:",
    userBandStart(author) {
      if (!author) return null;
      try {
        const raw = localStorage.getItem(this.BAND_KEY_PREFIX + author);
        const n = parseInt(raw, 10);
        return (Number.isFinite(n) && n >= 1) ? n : null;
      } catch (e) { return null; }
    },
    setUserBandStart(author, value) {
      if (!author) return null;
      let n = parseInt(value, 10);
      if (!Number.isFinite(n) || n < 1) n = 1;
      try { localStorage.setItem(this.BAND_KEY_PREFIX + author, String(n)); } catch (e) {}
      return n;
    },

    /** [WO 20260917 멀티유저 ①+②·재설계] 마스터 확정: "100번대 사용자→색A, 200번대→색B" —
     *  체크보드 계열은 대역(번호 100단위 그룹)에서 색을 파생시킨다(번호 자체가 이미 눈에 보이는
     *  비색 단서라 색맹에도 안전 · 별도 작성자 필드 없이도 구분됨). 대역 개념이 없는 계열
     *  (content/empty)은 이메일 해시(authorStyle)로 폴백한다.
     *  🔴 기존 3축(계열색 colorsOf · 등록여부 헤드 fill/링 dash · 아이콘)은 전혀 건드리지 않는다
     *  — 이 배지는 SVG 밖 별도 코너에 얹힐 뿐이라 구조적으로 충돌하지 않는다(11_UI.js 참조). */
    userMark(pin, no) {
      if (!pin) return null;
      if (pin.checkboard && Number.isFinite(no)) {
        const band = Math.floor((no - 1) / 100); // 0=1~100, 1=101~200 … "100번대/200번대" 그룹
        const color = this.USER_MARK_PALETTE[band % this.USER_MARK_PALETTE.length];
        return { color: color, initial: String(band + 1), author: pin.author || null, band: band };
      }
      return this.authorStyle(pin);
    },

    /** [WO 20260917 콘텐츠 3상태] 핀에 "사진/영상(미디어)"가 있는가 — App.pinHasMedia 가 정본.
     *  🔴 App.pinHasContent 자체는 바꾸지 않는다(호출부 다수) — 여기서 별도로 미디어/정보를
     *  나눠 읽어 3상태(사진/내용만/빈 포인트)를 만든다. */
    mediaOf(pin) {
      if (typeof App !== "undefined" && App.pinHasMedia) { try { return !!App.pinHasMedia(pin); } catch (e) {} }
      return !!(pin && (pin.imageId || pin.videoUrl || pin.imageUrl || pin.pendingOpId || pin.localPreview));
    },
    /** 핀에 "노트/첨부/3D"(정보성 콘텐츠, 미디어 아님)가 있는가 — App.pinHasInfo 가 정본. */
    infoOf(pin) {
      if (typeof App !== "undefined" && App.pinHasInfo) { try { return !!App.pinHasInfo(pin); } catch (e) {} }
      return !!(pin && (pin.note || (pin.attachments && pin.attachments.length) || pin.has3D || pin.flsLocalId || pin.flsUrl));
    },
    /** [WO 20260917] 콘텐츠 3상태: photo(사진/영상 있음) > content(노트/첨부만) > empty(둘 다 없음).
     *  둘 다 있으면(사진+노트) 미디어가 우선 — photo 로 처리(정상 처리, 크래시 없음).
     *  🔴 이 함수는 hasContent()/markerStyle() 의 filled(등록여부) 판정을 바꾸지 않는다 —
     *  filled 는 여전히 media OR info(App.pinHasContent), tier 는 그 안을 세분하는 별도 축. */
    contentTier(pin) {
      if (this.mediaOf(pin)) return "photo";
      if (this.infoOf(pin)) return "content";
      return "empty";
    },

    /** 페이지 내 부류별 핀 개수 (칩 배지용) */
    counts(pins, page) {
      const pg = page || 1;
      const c = { content: 0, empty: 0, checkboard: 0, all: 0 };
      (pins || []).forEach((p) => {
        if (!p || (p.page || 1) !== pg) return;
        c[this.kindOf(p)]++; c.all++;
      });
      return c;
    },

    /* ── 필터 칩 UI (도면 좌상단) — 기존 구역페이저 칩 스타일(.zpager-tab) 재사용 ── */
    renderChips() {
      if (typeof document === "undefined") return;
      const host = document.getElementById("pin-filter-bar");
      if (!host) return;
      const page = (typeof State !== "undefined" && State.pdfPage) || 1;
      const pins = (typeof State !== "undefined" && State.pins) || [];
      const c = this.counts(pins, page);
      if (!c.all) { host.classList.add("hidden"); host.innerHTML = ""; return; }
      host.classList.remove("hidden");
      const f = this.filter();
      const chip = (kind, label, n, on) =>
        '<button type="button" class="zpager-tab pinfilter-chip pf-' + kind + (on ? " active" : "") +
        '" data-kind="' + kind + '" aria-pressed="' + (on ? "true" : "false") +
        '" title="' + label + ' 핀만 보기"><span class="pinfilter-dot"></span>' + label +
        '<span class="zpager-cnt">' + n + '</span></button>';
      let html = chip("all", "전체", c.all, this.isAll());
      this.KINDS.forEach(k => { if (c[k]) html += chip(k, this.LABELS[k], c[k], !!f[k]); });

      // ── [마스터 요청 2026-09-03] 종류(아이콘) 필터 칩 — 계열 칩과 별도 축, 공존.
      //   실제 페이지에 존재하는 종류만(0개 종류는 빈 화면만 준다) · 2종 이상일 때만(1종뿐이면
      //   거를 게 없어 무의미한 칩이 된다 — YAGNI).
      const ic = this.iconCounts(pins, page);
      const presentIds = Object.keys(ic);
      if (presentIds.length > 1 && typeof PinIcons !== "undefined") {
        const iflt = this.iconFilter();
        // 🔴 새 CSS 클래스 없이(.pinfilter-dot 은 9px 원+kind별 배경색 전제) — 인라인 스타일로
        //   14px 사각 뱃지 안에 실제 아이콘 SVG 를 넣어 종류를 한눈에 구분(§CSS 미신설 보고 대상).
        const dotStyle = 'style="width:14px;height:14px;border-radius:4px;box-shadow:none;' +
          'background:rgba(255,255,255,.14);display:inline-flex;align-items:center;justify-content:center;color:inherit"';
        const iconChip = (iconId, label, n, on) =>
          '<button type="button" class="zpager-tab pinfilter-chip pf-icon-flt' + (on ? " active" : "") +
          '" data-icon="' + iconId + '" aria-pressed="' + (on ? "true" : "false") +
          '" title="' + label + ' 만 보기"><span class="pinfilter-dot" ' + dotStyle + ' aria-hidden="true">' +
          (iconId === "all" ? "" : PinIcons.chipSvg(iconId, 11)) + '</span>' + label +
          '<span class="zpager-cnt">' + n + '</span></button>';
        html += iconChip("all", "전체", c.all, this.isIconAll(presentIds));
        presentIds.forEach(id => { html += iconChip(id, PinIcons.def(id).name, ic[id], iflt[id] !== false); });
      }

      host.innerHTML = html;
      if (!this._chipsBound) {
        this._chipsBound = true;
        host.addEventListener("click", (e) => {
          const btn = e.target && e.target.closest ? e.target.closest("[data-kind],[data-icon]") : null;
          if (!btn) return;
          e.stopPropagation();
          if (btn.dataset.kind) {
            const kind = btn.dataset.kind;
            if (kind === "all") this.showAll(); else this.toggle(kind);
          } else if (btn.dataset.icon) {
            const page2 = (typeof State !== "undefined" && State.pdfPage) || 1;
            const presentIds2 = Object.keys(this.iconCounts((typeof State !== "undefined" && State.pins) || [], page2));
            const iconId = btn.dataset.icon;
            if (iconId === "all") this.showAllIcons(); else this.toggleIconFilter(iconId, presentIds2);
          }
          this.apply(); // UI.renderPinsOnMap()이 renderChips()도 함께 호출해 칩 active 상태를 갱신한다
        });
      }
    },

    /** 필터 변경 후 도면 마커 + 미니맵 점을 함께 다시 그린다(한쪽만 걸리면 거짓말이 된다) */
    apply() {
      try { if (typeof UI !== "undefined" && UI.renderPinsOnMap) UI.renderPinsOnMap(); } catch (e) {}
      try {
        const box = (typeof document !== "undefined") && document.getElementById("pano-radar");
        if (box && !box.classList.contains("hidden") && typeof Radar !== "undefined" && Radar._pin && Radar.update) {
          Radar.update(Radar._pin);
        }
      } catch (e) {}
    }
  };

  /* ══════════════════════════════════════════════════════════════════
     [P61] ShareLink — 공유 주소 `/srview/<프로젝트명>-<토큰>`
     마스터 2026-09-21: "scan.seastar.work/프로젝트이름 — 이런 식으로 배포해줘"
     마스터 2026-09-18: "다른 프로젝트를 유추할 수 없도록" + "보이는 건 seastar 과 srview"

     · 이름(slug)은 **장식**이다 — 고객이 주소만 보고 무슨 프로젝트인지 알게 하는 용도.
     · 실제 열쇠는 **토큰**(서버 80비트 암호난수). 토큰이 틀리면 서버가 404 를 준다.
     · 이름이 바뀌어도 토큰이 같으면 옛 링크가 그대로 열린다(slug 는 무시하고 파싱).

     🔴 이 객체는 "현재 주소가 공유 링크인가"의 **단일 판정원(SoT)** 이다.
        22_Auth(열람전용 토큰 요청) · 20_App(배포본 선택) · 99_footer(진입)가 전부 여기만 본다.
        판정이 세 군데로 갈라지면 한 곳만 고쳐져 쓰기가 뚫린다(p48 사고와 동일 구조).
  ══════════════════════════════════════════════════════════════════ */
  const ShareLink = {
    /** resolve() 로 채워지는 캐시 — 20_App.loadLatestDeployment 가 읽는다. */
    deploymentId: null,
    project: null,
    _resolved: null,

    /** 서버 src/lib/util.ts 의 isShareToken 과 동일 규격: base32 소문자 16자(=80비트). */
    isToken(t) { return /^[a-z2-7]{16}$/.test(String(t || "")); },

    /** 현재(또는 주어진) 주소가 공유 링크면 토큰, 아니면 null.
     *  slug 에 하이픈이 몇 개 있든 **마지막 '-' 뒤**가 토큰이다(토큰 알파벳에 '-' 없음 → 분리 유일). */
    token(loc) {
      const L = loc || (typeof location !== "undefined" ? location : null);
      if (!L) return null;
      const m = String(L.pathname || "").match(/^\/srview\/([^/]+)\/?$/);
      if (!m) return null;
      let seg = m[1];
      try { seg = decodeURIComponent(seg); } catch (e) {}
      const i = seg.lastIndexOf("-");
      const t = i >= 0 ? seg.slice(i + 1) : seg;
      return this.isToken(t) ? t : null;
    },

    /** 토큰 → { project, deployment_id }. 실패하면 null(조용한 성공 위장 금지). */
    async resolve() {
      const t = this.token();
      if (!t) return null;
      try {
        const r = await fetch("/api/share/" + encodeURIComponent(t));
        if (!r.ok) return null;                       // 404 = 토큰 불일치/미배포 — 힌트 없음
        const j = await r.json();
        if (!j || !j.matched || !j.project) return null;
        this.project = { id: j.project.id, name: j.project.name };
        this.deploymentId = j.deployment_id || null;
        this._resolved = j;
        return j;
      } catch (e) { return null; }                    // 오프라인 → 정직하게 실패
    }
  };

  /* ══════════════════════════════════════════════════════════════════
     [P63] ShareGate — 공유 링크 진입 시 "누구인지 남기고" 들어오게 하는 게이트

     마스터 확정(2026-09-21): "1단계 = 접속 기록 / 차단은 초대 계정" → "좋아 그렇게 해. 초대코드"
       [회사명][이름][초대코드] → 코드 유효면 열람 + 기록 / 무효면 거부 + 재요청처 안내

     🔴 열쇠는 **초대코드 하나**다. 회사명·이름은 자기 신고라 신뢰하지 않고 기록만 한다
        (대조할 명단이 DB 에 없다 — 없는 대조를 흉내내면 거짓 보안이 된다).
     🔴 차단의 최종 방어선은 이 모달이 아니라 **서버 미들웨어**다(src/index.tsx 의 게이트 가드).
        여기는 "UI 를 가린다"가 아니라 "통행증을 받아온다"가 역할이다.
     🔴 마스터 "그 링크가 유출된다면?" → 링크만 유출되면 여기서 막힌다.
        코드까지 유출되면 폐기(revoke)·만료·접속기록으로 대응한다(서버 3종 모두 구현).
  ══════════════════════════════════════════════════════════════════ */
  const ShareGate = {
    /** 🔴 사용자에게 보여줄 문의 주소. 서버 SUPPORT_CONTACT_EMAIL 과 같은 값이어야 한다.
     *  개발 관리자 gmail 주소는 어떤 화면에도 쓰지 않는다(마스터 확정). */
    CONTACT: "designsir@seastargo.com",
    /** 통행증 보관 키 — 프로젝트별로 따로 둔다(한 브라우저가 여러 현장을 볼 수 있다). */
    _passKey(pid) { return "wm_share_pass_" + pid; },

    ctx: null,        // { t } 또는 { d } — 어느 링크로 들어왔는지
    project: null,
    deploymentId: null,

    /** 저장해 둔 통행증 꺼내기(만료 지난 건 버린다). */
    storedPass(pid) {
      try {
        const raw = localStorage.getItem(this._passKey(pid));
        if (!raw) return null;
        const j = JSON.parse(raw);
        if (!j || !j.token || (j.exp && j.exp < Date.now())) { localStorage.removeItem(this._passKey(pid)); return null; }
        return j.token;
      } catch (e) { return null; }
    },
    savePass(pid, token, exp) {
      try { localStorage.setItem(this._passKey(pid), JSON.stringify({ token, exp })); } catch (e) {}
    },

    /** 통행증을 현재 세션 토큰으로 승격. 🔴 서버가 kind='viewer' 로 강제 서명하므로 쓰기 권한은 생기지 않는다. */
    _useToken(token) {
      if (!token || typeof Auth === "undefined") return;
      Auth.idToken = token;
      try { sessionStorage.setItem("wm_id_token", token); } catch (e) {}
    },

    /** 게이트 상태 조회. 반환 null = 링크 자체가 유효하지 않음. */
    async check(ctx) {
      this.ctx = ctx;
      const q = ctx.t ? ("t=" + encodeURIComponent(ctx.t)) : ("d=" + encodeURIComponent(ctx.d || ""));
      try {
        const r = await fetch("/api/share-gate?" + q, { headers: (typeof Auth !== "undefined" && Auth.headers) ? Auth.headers() : {} });
        if (!r.ok) return null;
        const j = await r.json();
        if (!j || !j.matched) return null;
        this.project = j.project || null;
        this.deploymentId = j.deployment_id || null;
        return j;
      } catch (e) { return null; }   // 오프라인 → 정직하게 실패(통과시키지 않는다)
    },

    /** 🔴 진입 지점: 필요하면 통행증을 확보한다. true = 열람 가능. */
    async ensure(ctx) {
      // ① 저장된 통행증이 있으면 먼저 제시한다(요구 11: 재입력 없이 계속 열람)
      let info = await this.check(ctx);
      // 🔴 프로젝트를 특정할 수 없으면(구 배포본에 decks 행이 없는 등) 게이트를 걸 수 없다.
      //   서버 가드도 같은 조건에서 통과시킨다 — 클라가 더 엄격하면 **레거시 `?d=` 링크만 죽는다**.
      //   차단의 정본은 어차피 서버이므로 여기서 더 막아도 보안은 늘지 않고 회귀만 생긴다.
      if (!info) return true;
      if (!info.gated) return true;                    // 코드 미발급 프로젝트 = 게이트 꺼짐
      if (info.passed) return true;
      const saved = this.storedPass(info.project.id);
      if (saved) {
        this._useToken(saved);
        if (typeof Auth !== "undefined" && Auth.refresh) { try { await Auth.refresh(); } catch (e) {} }
        info = await this.check(ctx);
        if (info && info.passed) return true;
        try { localStorage.removeItem(this._passKey(ctx._pid || (this.project && this.project.id))); } catch (e) {}
      }
      // ② 입력 화면
      return await this.prompt();
    },

    /** 코드 입력 모달. 통과할 때까지(또는 포기할 때까지) 떠 있는다 — 열람 전에 반드시 지난다. */
    prompt() {
      const $ = (id) => document.getElementById(id);
      const modal = $("share-gate-modal");
      if (!modal) return Promise.resolve(false);
      const nameEl = $("sg-proj-name");
      if (nameEl) nameEl.textContent = (this.project && this.project.name) || "";
      const note = $("sg-contact-note");
      if (note) note.textContent = "코드를 못 받으셨나요? " + this.CONTACT + " 으로 링크를 다시 요청하세요.";
      const err = $("sg-error");
      const show = (msg) => { if (err) { err.textContent = msg; err.classList.remove("hidden"); } };
      const hideErr = () => { if (err) err.classList.add("hidden"); };
      // 🔴 .admin-gate 는 `hidden` 을 빼는 것만으로는 보이지 않는다 — style.css:558 에서
      //   opacity:0 · pointer-events:none 이고 `.on` 이 붙어야 보이고 클릭된다.
      //   (라이브에서 실제로 모달이 뜼긴 했는데 버튼이 안 눌렸다 — 기존 모달들과 동일 패턴을 따른다)
      modal.classList.remove("hidden");
      requestAnimationFrame(() => modal.classList.add("on"));
      const company = $("sg-company"), person = $("sg-name"), code = $("sg-code"), btn = $("sg-submit");
      try { if (company) company.value = localStorage.getItem("wm_share_company") || ""; } catch (e) {}
      try { if (person) person.value = localStorage.getItem("wm_share_person") || ""; } catch (e) {}
      if (company) company.focus();

      return new Promise((resolve) => {
        const submit = async () => {
          hideErr();
          const body = {
            company: (company && company.value || "").trim(),
            name: (person && person.value || "").trim(),
            code: (code && code.value || "").trim(),
          };
          if (this.ctx && this.ctx.t) body.t = this.ctx.t; else if (this.ctx) body.d = this.ctx.d;
          if (!body.company || !body.name) { show("회사명과 이름을 입력하세요."); return; }
          if (!body.code) { show("초대코드를 입력하세요."); return; }
          if (btn) { btn.disabled = true; btn.textContent = "확인 중…"; }
          let j = null;
          try {
            const r = await fetch("/api/share/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
            j = await r.json().catch(() => null);
            if (!r.ok || !j || !j.ok) {
              // 🔴 거부 사유와 **재요청처**를 반드시 보여준다(조용한 실패 금지).
              show((j && j.message) || ("초대코드가 올바르지 않습니다. " + this.CONTACT + " 으로 링크를 다시 요청하세요."));
              return;
            }
          } catch (e) {
            show("네트워크 오류입니다. 잠시 후 다시 시도하세요."); return;
          } finally {
            if (btn) { btn.disabled = false; btn.textContent = "열람하기"; }
          }
          try { localStorage.setItem("wm_share_company", body.company); localStorage.setItem("wm_share_person", body.name); } catch (e) {}
          this.savePass(j.project.id, j.token, j.exp);
          this._useToken(j.token);
          if (typeof Auth !== "undefined" && Auth.refresh) { try { await Auth.refresh(); } catch (e) {} }
          modal.classList.remove("on");
          modal.classList.add("hidden");
          resolve(true);
        };
        if (btn) btn.addEventListener("click", submit);
        [company, person, code].forEach((el) => {
          if (el) el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
        });
      });
    },

    /** 링크 자체가 무효할 때(삭제/미배포) — 조용히 빈 화면을 주지 않는다. */
    showDeadLink() {
      const modal = document.getElementById("share-gate-modal");
      if (!modal) return;
      const $ = (id) => document.getElementById(id);
      const t = $("sg-title"); if (t) t.textContent = "링크를 찾을 수 없습니다";
      const sub = modal.querySelector(".admin-gate-sub");
      if (sub) sub.textContent = "주소가 정확하지 않거나, 공유가 해제된 링크입니다.";
      ["sg-company", "sg-name", "sg-code", "sg-submit"].forEach((id) => { const e = $(id); if (e) e.classList.add("hidden"); });
      const note = $("sg-contact-note");
      if (note) note.textContent = this.CONTACT + " 으로 링크를 다시 요청하세요.";
      modal.classList.remove("hidden");
      requestAnimationFrame(() => modal.classList.add("on"));
    }
  };

  const PDF = {
    // 로컬 번들 worker 우선(외부 CDN worker가 차단/지연될 때 PDF가 무한 로딩되는 문제 방지)
    WORKER_SRC: "/vendor/pdf.worker.min.js",
    WORKER_SRC_CDN: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js",
    ready: false,

    ensureLib() {
      return new Promise((resolve, reject) => {
        if (window.pdfjsLib) { this._configWorker(); resolve(window.pdfjsLib); return; }
        let attempts = 0;
        const check = () => {
          attempts++;
          if (window.pdfjsLib) { this._configWorker(); resolve(window.pdfjsLib); }
          else if (attempts < 50) { setTimeout(check, 100); }
          else { reject(new Error("PDF.js 라이브러리 로드 타임아웃")); }
        };
        check();
      });
    },

    useWorker: true, // 로컬 worker 사용 가능 여부 (실패 시 자동 false)

    _configWorker() {
      if (this.ready) return;
      // 로컬 번들 worker 를 사용한다(백그라운드 파싱 → 빠르고 메인스레드 안 막힘).
      // 로드 실패 시 load() 에서 disableWorker 로 자동 폴백한다.
      try { window.pdfjsLib.GlobalWorkerOptions.workerSrc = this.WORKER_SRC; }
      catch (e) { this.useWorker = false; }
      this.ready = true;
    },

    /** 타임아웃 경쟁: worker 파싱이 멈춰도(무한 로딩 방지) 일정 시간 후 폴백/실패 처리 */
    _withTimeout(promise, ms, onTimeoutCleanup) {
      return new Promise((resolve, reject) => {
        let done = false;
        const t = setTimeout(() => {
          if (done) return;
          done = true;
          try { if (onTimeoutCleanup) onTimeoutCleanup(); } catch (e) {}
          reject(new Error("__PDF_TIMEOUT__"));
        }, ms);
        promise.then(
          v => { if (done) return; done = true; clearTimeout(t); resolve(v); },
          e => { if (done) return; done = true; clearTimeout(t); reject(e); }
        );
      });
    },

    async load(arrayBuffer) {
      const lib = await this.ensureLib();
      // 1차: worker 로 파싱 시도하되 2.5초 내 응답 없으면 즉시 메인스레드로 폴백.
      //      (일부 환경에서 worker 가 응답 없이 멈춰 "PDF 렌더링 중..." 이 오래 떠 있는 문제 방지)
      if (this.useWorker) {
        let task = null;
        try {
          task = lib.getDocument({ data: arrayBuffer.slice(0), disableWorker: false });
          return await this._withTimeout(task.promise, 2500, () => {
            try { task && task.destroy && task.destroy(); } catch (e) {}
          });
        } catch (e) {
          // worker 가 느리거나(timeout) 실패 → 세션 내내 메인스레드 파싱 사용(다시 안 기다림)
          this.useWorker = false;
          try { task && task.destroy && task.destroy(); } catch (e2) {}
        }
      }
      // 2차: 메인스레드 파싱 (worker 없이). 20초 타임아웃으로 무한 로딩 차단.
      const task2 = lib.getDocument({ data: arrayBuffer.slice(0), disableWorker: true });
      try {
        return await this._withTimeout(task2.promise, 20000, () => {
          try { task2 && task2.destroy && task2.destroy(); } catch (e) {}
        });
      } catch (e) {
        if (e && e.message === "__PDF_TIMEOUT__") {
          throw new Error("PDF 파싱 시간 초과 — 파일이 너무 크거나 손상되었을 수 있습니다.");
        }
        throw e;
      }
    },

    /* ── 동적 고해상도 렌더링 상태 (벡터 PDF 화질 보존의 핵심) ──
       PDF 는 벡터이므로, "보이는 줌 배율"에 맞춰 그 배율로 다시 래스터화하면
       확대해도 원도면 화질이 그대로 유지된다. CSS transform: scale() 로만 키우면
       이미 그려진 비트맵을 늘리는 것이라 깨진다 → 이를 방지하기 위해
       캔버스를 줌에 비례한 해상도로 재렌더하고, CSS 는 "렌더 배율 대비 보정"만 한다. */
    _renderState: {
      pdfDoc: null, pageNum: 0, rotation: 0,
      renderScale: 0,        // 현재 캔버스가 래스터화된 PDF 스케일 (CSS 1배 기준 픽셀/포인트)
      baseCssScale: 1,       // 캔버스가 표현하는 "논리적(=화면 1배)" 크기 기준 스케일
      task: null,            // 진행 중인 render task (취소용)
      pending: null,         // 디바운스 타이머
      lastZoom: 1,           // 마지막으로 요청된 줌(= 확대가 끝난 시점의 화면 배율)
      crop: null,            // 고해상도 크롭 오버레이 캔버스
      cropTask: null,        // 진행 중인 크롭 render task
      cropScale: 0,          // 크롭 캔버스의 렌더 스케일
      // [P14] 바탕이 전면 PDF 캔버스가 아니라 "배포 스냅샷 <img>" 인 상태(뷰어/구역 재열람).
      //   이때는 전면 캔버스를 다시 그릴 수 없다(레이아웃·핀 좌표가 스냅샷 기준) →
      //   보이는 영역만 크롭 오버레이로 얹는다.
      overlayOnly: false,
      // [WO 20260917] 활성 구역(deck)의 크롭 — 0~1 비율 {x,y,w,h}. 설정돼 있으면
      // renderCrop 은 "현재 보이는 영역" 대신 이 영역을 렌더 대상으로 고정한다.
      deckCrop: null
    },

    /* ── 캔버스 해상도 상한 (근거를 남긴다 · 매직넘버 금지) ────────────────────
       [근본원인 2026-09-03] 상한이 전 기기 공통 16.7M px 였다. A1 도면(≈2384×1684pt)은
       면적 상한만으로 렌더 스케일이 √(16.7M / 4.01M) ≈ 2.04 로 잘린다. 그런데 retina(dpr 2)
       에서는 첫 렌더가 이미 1.5×2 = 3.0 → 2.04 로 클램프되어 **상한에 닿은 상태로 시작**한다.
       이후 아무리 확대해도 재래스터 결과가 2.04 로 되돌아가 화질이 1도 오르지 않았고,
       (재렌더 임계 1.15 는 통과하므로) 확대할 때마다 이득 0 인 전체 재렌더만 반복했다.
       → 기기별로 상한을 나눠 "모바일=안전 / 데스크톱=선명" 을 둘 다 만족시킨다. */
    // iOS/iPadOS Safari 하드 제한: 캔버스 면적 16,777,216px(4096²) 초과 시 캔버스가 통째로 빈다.
    CANVAS_PX_MOBILE: 16777216,
    // 데스크톱: RGBA 4byte/px → 40M px ≈ 160MB. 저사양(deviceMemory ≤ 4GB)은 모바일 상한으로 강등.
    CANVAS_PX_DESKTOP: 40000000,
    LOW_MEMORY_GB: 4,
    MAX_SIDE_HARD: 8192,       // 한 변 하드 상한
    RERENDER_GAIN: 1.15,       // 이 배율 미만의 화질 향상은 재렌더 비용 대비 이득이 없다
    SHRINK_RATIO: 2.5,         // 축소 후 이만큼 과잉 해상도면 메모리 회수용으로 다시 그린다
    SETTLE_MS: 140,            // 줌 조작이 끝났다고 보는 디바운스(애니메이션 중에는 더 미룬다)
    /* [P14] 원본 PDF 지연 로드 임계 — 스냅샷 비트맵이 화면 요구 해상도에 "얼마나" 부족해야
       네트워크로 원본을 받아올 값어치가 있는가.
       근거: RERENDER_GAIN(1.15)은 "원본이 이미 로컬에 있을 때 다시 그릴 값어치" 기준이다.
       원본 다운로드는 수 MB · 현장 모바일 회선이므로 같은 기준을 쓰면 기본 화면에서도 곧바로
       받아버린다. 배포 스냅샷은 CSS 1:1(.map-image 자연 크기)로 보도록 만들어진 것이므로
       판정 기준은 device px 가 아니라 CSS px 이고, 확실히 부족할 때(1.5배)만 받는다.
       → 1:1 스냅샷 기준 zoom > 1.5 에서 발동. 구역 확대(MapCtrl.fitZone 4~8배)는 항상 발동.
       원본을 확보한 뒤의 실제 렌더 목표 배율은 종전대로 zoom×dpr 이다(planRerender). */
    SOURCE_GAIN: 1.5,

    /** 마지막 snapshotAllPages 가 실제로 저장한 페이지 픽셀 크기
     *  [{ w, h, pw, ph }] — w/h = 스냅샷 비트맵 px, pw/ph = PDF 페이지 포인트.
     *  SOFT_LIMIT 강등으로 요청(maxDim)보다 낮아진 실제 값을 배포본에 정직하게 기록하기 위함. */
    lastSnapshotDims: null,

    /* [회귀수정 2026-09-28] 0c5a7b6 의 pageWeightedPxCap()/LARGE_PAGE_SHARE_COUNT 를 제거했다.
       [근본원인] 그 코드는 "페이지 크기(A1 이상)"만으로 예산을 무조건 반으로 깎았다 — 마스터
       요구(대형 도면일수록 해상도가 더 필요하다)와 정반대 방향이었고, 근거로 든 "base+crop
       두 캔버스 동시 상주"도 실제로는 renderCrop() 호출 시에만 성립(평상시 crop 캔버스는
       DOM 에 없음) 하는데 평상시에도 무조건 적용돼 A1 이 이유 없이 반토막났다.
       → 페이지 크기는 예산 산정 근거에서 제외한다(YAGNI). 대신 "지금 실제로 동시에 화면에
       떠 있는 캔버스 수" 로만 나눈다: 평상시 1장(=전체 예산 그대로) / 크롭 오버레이 렌더 중엔
       2장(=절반씩, 메모리 안전 유지). 상주 수는 각 호출부의 실제 실행 맥락에서 정해진다
       (base 캔버스 경로는 renderCrop 이전에 항상 _clearCrop 되므로 1, renderCrop() 은
       정의상 base 위에 겹쳐 그리므로 2 — 아래 각 호출부 주석 참조). */

    /** 기기별 캔버스 면적 상한 (순수 함수 — 테스트 가능) */
    canvasPxCap(env) {
      const e = env || {};
      if (e.mobile) return this.CANVAS_PX_MOBILE;
      const mem = e.deviceMemory;
      if (typeof mem === "number" && mem > 0 && mem <= this.LOW_MEMORY_GB) return this.CANVAS_PX_MOBILE;
      return this.CANVAS_PX_DESKTOP;
    },

    /** [회귀수정 2026-09-28] clampScale 에 넘길 "실제 적용 예산" 단일 진입점
     *  (공유 함수 1곳만 고치면 호출부 전체 반영). residentCanvasCount = 지금 이 호출 시점에
     *  동시 상주하는 캔버스 수(기본 1). 🔴 페이지 크기는 입력에서 제외 — 크기로 깎지 않는다. */
    effectivePxCap(env, residentCanvasCount) {
      const n = Math.max(1, residentCanvasCount || 1);
      return this.canvasPxCap(env) / n;
    },

    /* [WO 20260917-dpr] 상주 페이지 수 기준 dpr 상한 — 출처: PDF VIEW°917 pdfCore.js:331-347
       pickDpr() (MIT). 로직만 이식(단위·상수는 우리 구조에 맞게 재정의).
       [근본원인] 종전 dpr = min(devicePixelRatio, 2) 는 페이지 크기·상주 페이지 수와 무관한
       고정값이라, 화면에 실제로 뜬 페이지가 몇 장이든 같은 dpr 을 요구했다(가드 없음).
       → dpr² × 페이지당 픽셀 × 상주 페이지 수 ≤ pxCap 을 만족하는 dpr 로 자른다.
       residentPages 기본 1 — 우리 뷰어는 페이지 1장만 캔버스로 렌더하는 단일 캔버스 구조라
       "전체 페이지 수" 가 아니라 "실제로 화면에 뜬 페이지 수(=1)" 를 쓴다(이식 1 요구사항).
       [회귀수정 2026-09-28] pxCap 인자로 effectivePxCap() 결과를 넘겨받게 해 "동시 상주 캔버스
       수 나누기" 를 dpr 산정에도 동일하게 적용한다(개념 통합 — 별도 페이지수 가중을 두지 않음). */
    residentDpr(o) {
      const opt = o || {};
      const raw = Math.min(opt.devicePixelRatio || (typeof window !== "undefined" && window.devicePixelRatio) || 1, 2);
      const resident = Math.max(1, opt.residentPages || 1);
      const pageW = Math.max(1, opt.pageW || 1), pageH = Math.max(1, opt.pageH || 1);
      const perPagePx = pageW * pageH;
      const pxCap = opt.pxCap || this.CANVAS_PX_DESKTOP;
      if (!(perPagePx > 0) || !(pxCap > 0)) return raw;
      const allowed = Math.sqrt(pxCap / (perPagePx * resident));
      // 1 미만으로는 내리지 않는다(그 아래는 눈에 보이게 흐려진다 — 출처 동일 하한).
      return Math.max(1, Math.min(raw, allowed));
    },

    /** 현재 실행 환경 스냅샷 (canvasPxCap 입력) */
    _env() {
      if (typeof navigator === "undefined") return {};
      const ua = navigator.userAgent || "";
      const touch = navigator.maxTouchPoints || 0;
      return {
        // iPadOS 는 UA 가 Mac 으로 나오므로 멀티터치로 보강 판정
        mobile: /iP(hone|ad|od)|Android|Mobile/i.test(ua) || (touch > 1 && /Mac/i.test(navigator.platform || "")),
        deviceMemory: navigator.deviceMemory
      };
    },

    /** [P14] 스냅샷 비트맵이 현재 배율을 감당하는가 = 원본을 지연 로드할 때인가 (순수 함수).
     *  snapPx : 배포본에 기록된(또는 <img>.naturalWidth 로 실측한) 스냅샷 가로 픽셀
     *  cssPx  : 화면 1배(zoom=1)에서 그 스냅샷이 차지하는 CSS 가로 픽셀
     *  zoom   : 현재 CSS 확대 배율
     *  크기를 모르면(0) 받지 않는다 — 불필요한 다운로드 0 이 기본값이다. */
    needsSourceRerender(o) {
      const opt = o || {};
      const snapPx = Number(opt.snapPx) || 0;
      const cssPx  = Number(opt.cssPx)  || 0;
      const zoom   = Number(opt.zoom)   || 0;
      if (!(snapPx > 0) || !(cssPx > 0) || !(zoom > 0)) return false;
      const gain = Number(opt.gain) || this.SOURCE_GAIN;
      return (cssPx * zoom) > (snapPx * gain);
    },

    /** [P14] 크롭 오버레이를 얹을 "바탕" 요소 — 전면 PDF 캔버스(편집) 또는 배포 스냅샷 <img>(뷰어).
     *  [근본원인] 종전엔 #pdf-canvas 만 보고 없으면 즉시 반환했다. 뷰어는 스냅샷 <img> 를
     *  그리므로 재래스터 경로 자체에 진입하지 못했고, 확대하면 비트맵이 늘어나 뭉갰다. */
    _baseEl() {
      if (typeof document === "undefined") return null;
      const cv = document.getElementById("pdf-canvas");
      if (cv && !cv.classList.contains("hidden")) return cv;
      const img = document.getElementById("map-image");
      if (img && !img.classList.contains("hidden")) return img;
      return null;
    },

    /** 캔버스 상한으로 렌더 스케일을 자른다 (순수 함수) */
    clampScale(scale, pageW, pageH, pxCap, maxSide) {
      const w = Math.max(1, pageW || 1), h = Math.max(1, pageH || 1);
      const cap = pxCap || this.CANVAS_PX_MOBILE;
      const side = maxSide || this.MAX_SIDE_HARD;
      let rs = Math.min(scale, side / Math.max(w, h), Math.sqrt(cap / (w * h)));
      return Math.max(rs, 0.1);
    },

    /**
     * 줌에 맞는 목표 렌더 스케일 + 재렌더 실익 판정 (순수 함수 — 테스트 가능).
     * @returns {{target:number, capped:number, worth:boolean, reason:string}}
     *   target : 화면에 실제로 보이는 픽셀 밀도(= 논리스케일 × 줌 × dpr)
     *   capped : 기기 상한으로 자른 실제 렌더 스케일
     *   worth  : 다시 그릴 값어치가 있는가(선명해지거나 / 메모리를 회수하거나)
     */
    planRerender(o) {
      const opt = o || {};
      const gain = opt.gain || this.RERENDER_GAIN;
      const cur = opt.renderScale || 0;
      const target = (opt.baseCssScale || 1) * Math.max(1, opt.zoom || 1) * Math.max(1, opt.dpr || 1);
      const capped = this.clampScale(target, opt.pageW, opt.pageH, opt.pxCap, opt.maxSide);
      // 🔴 상한에 걸려 해상도가 안 오르는데 재렌더하면 "화질 그대로 + 대형 PDF 재렌더" 순수 손해다.
      //    실제로 오를 때(capped 기준)만 다시 그린다.
      if (capped > cur * gain) return { target: target, capped: capped, worth: true, reason: "sharpen" };
      // 크게 축소한 뒤 남은 과잉 해상도 캔버스는 메모리만 먹는다 → 회수(히스테리시스로 진동 방지).
      if (cur > 0 && capped < cur / (opt.shrink || this.SHRINK_RATIO)) {
        return { target: target, capped: capped, worth: true, reason: "shrink" };
      }
      return { target: target, capped: capped, worth: false, reason: "enough" };
    },

    async renderPage(pdfDoc, pageNum, canvas, scale = 1.5, rotation = 0) {
      const page = await pdfDoc.getPage(pageNum);
      // 페이지/문서/회전이 바뀌면 이전 페이지의 크롭 오버레이는 즉시 거짓 화면이 된다 → 제거.
      clearTimeout(this._renderState.pending);
      this._clearCrop();
      const rot = ((page.rotate || 0) + (rotation || 0)) % 360;
      const base = page.getViewport({ scale: 1, rotation: rot });
      // 초기 렌더는 "화면 1배(=CSS 100%)" 에 맞는 해상도로 그린다.
      // baseCssScale: 도면 1포인트가 화면 몇 px 로 보이는가 (디자이너 첫 표시 기준).
      // 여기서는 캔버스의 CSS 폭 = base.width 로 두고, 줌은 별도로 처리한다.
      // [WO 20260917-dpr] 상주 페이지 수(=1, 단일 캔버스 구조) 기준 dpr — residentDpr 참조.
      // [회귀수정 2026-09-28] 이 시점은 항상 _clearCrop() 직후(위 260행) → 상주 캔버스 1개.
      const dpr = this.residentDpr({ pageW: base.width, pageH: base.height, pxCap: this.effectivePxCap(this._env(), 1), residentPages: 1 });
      // 논리(=화면 1배) CSS 크기는 PDF 1포인트 = 1px 로 고정한다.
      // → map-transform/pins-layer 레이아웃 크기가 줌 재렌더와 무관하게 불변(핀 % 좌표 정합 보장).
      const baseCss = 1;
      canvas.style.width  = Math.round(base.width  * baseCss) + "px";
      canvas.style.height = Math.round(base.height * baseCss) + "px";
      this._renderState.pdfDoc = pdfDoc;
      this._renderState.pageNum = pageNum;
      this._renderState.rotation = rotation;
      this._renderState.baseCssScale = baseCss;
      this._renderState.overlayOnly = false;   // 전면 캔버스를 직접 그리는 경로(편집모드 PDF)
      // [WO 20260917] 새 문서/페이지 로드 시 이전 구역의 크롭 고정을 초기화(누출 방지).
      // 구역 진입 시 selectDeck 이 다시 PDF.setDeckCrop 으로 설정한다.
      this._renderState.deckCrop = null;
      // [WO 20260928-crop] 이 경로는 setDeckCrop() 을 거치지 않는 직접 초기화라
      // MapCtrl 페이지 경계(클리핑+줌/팬 한계)도 여기서 별도로 풀어야 한다(요구⑦, 누출 방지).
      if (typeof MapCtrl !== "undefined" && MapCtrl.setCropBoundary) MapCtrl.setCropBoundary(null);
      // 첫 렌더 해상도: 초기 화질 확보를 위해 scale(권장 1.5)×dpr 로 미리 선명하게.
      // 이후 줌인하면 requestZoomRerender 가 더 높은 해상도로 재래스터화한다.
      const initRender = Math.max(1, scale) * dpr;
      await this._rasterize(page, canvas, initRender, rot, baseCss);
    },

    /** 실제 캔버스 래스터화 (renderScale = PDF 포인트당 캔버스 픽셀) */
    async _rasterize(page, canvas, renderScale, rot, cssScale) {
      // 캔버스 면적/변 상한으로 클램프 (안정성)
      const baseVp = page.getViewport({ scale: 1, rotation: rot });
      // [회귀수정 2026-09-28] base 캔버스 래스터화 경로는 renderPage(_clearCrop 직후) 또는
      // requestZoomRerender 의 "_clearCrop() 이후 재래스터" 분기에서만 호출된다 → 상주 1개.
      const rs = this.clampScale(renderScale, baseVp.width, baseVp.height, this.effectivePxCap(this._env(), 1), this.MAX_SIDE_HARD);
      const vp = page.getViewport({ scale: rs, rotation: rot });
      const ctx = canvas.getContext("2d", { alpha: false });
      // 진행 중 task 취소 (줌 연타 시 누적 방지)
      try { if (this._renderState.task) this._renderState.task.cancel(); } catch (e) {}
      canvas.width  = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      // CSS 크기 = 논리 크기(cssScale 기준). 캔버스 내부 픽셀이 더 많으므로 선명.
      canvas.style.width  = Math.round(baseVp.width  * cssScale) + "px";
      canvas.style.height = Math.round(baseVp.height * cssScale) + "px";
      const task = page.render({ canvasContext: ctx, viewport: vp });
      this._renderState.task = task;
      this._renderState.renderScale = rs;
      if (this.useWorker) {
        try { await task.promise; } catch (e) { /* cancel 등 무시 */ }
      } else {
        await Promise.race([
          task.promise.catch(() => {}),
          new Promise(res => setTimeout(res, 4000))
        ]);
      }
    },

    /** 줌 변경 시 호출 — 확대가 "끝난 뒤" 그 배율에 맞는 해상도로 PDF 를 딱 한 번 재래스터화.
     *  zoom    = MapCtrl 의 State.zoom (CSS transform 배율. 구역 crop/ISO 확대 배율도 여기에 들어온다)
     *  delayMs = 조작 종료 판정 지연. 애니메이션(플라이/ISO 전환) 중에는 MapCtrl 이 애니메이션
     *            잔여시간을 넘겨 렌더를 뒤로 미룬다 → 애니메이션은 가볍고, 끝나면 선명해진다.
     *  ⚠ 매 호출마다 타이머를 리셋하므로(디바운스) 연속 줌·rAF 애니메이션 중에는 렌더가 돌지 않는다. */
    requestZoomRerender(zoom, delayMs) {
      const st = this._renderState;
      if (!st.pdfDoc) return;
      const canvas = this._baseEl();
      if (!canvas) { this._clearCrop(); return; }
      st.lastZoom = zoom;
      clearTimeout(st.pending);
      const wait = Math.max(this.SETTLE_MS, delayMs || 0);
      st.pending = setTimeout(async () => {
        try {
          const page = await st.pdfDoc.getPage(st.pageNum);
          const rot = ((page.rotate || 0) + (st.rotation || 0)) % 360;
          const baseVp = page.getViewport({ scale: 1, rotation: rot });
          // [WO 20260917-dpr] 상주 페이지 수(=1) 기준 dpr — baseVp 확보 후 계산(residentDpr 참조).
          // [회귀수정 2026-09-28] plan.capped 는 "크롭 없이 base 만 다시 그리면 도달 가능한
          // 배율" 을 뜻한다(아래에서 실제로 그 분기를 타면 _clearCrop() 후 _rasterize 한다)
          // → 이 계획 단계의 pxCap 도 상주 1개 기준이어야 한다(크롭이 이겨도 무방 — 그 경우
          // 아래 renderCrop() 이 자신의 pxCap 을 별도로 상주 2개로 다시 계산한다).
          const dpr = this.residentDpr({ pageW: baseVp.width, pageH: baseVp.height, pxCap: this.effectivePxCap(this._env(), 1), residentPages: 1 });
          // 🔴 실익 판정은 "상한으로 자른 뒤" 한다 — 상한에 걸려 화질이 안 오르는데
          //    대형 PDF 를 다시 그리면 화면만 멈추고 얻는 게 없다(구 코드의 실제 버그).
          const plan = this.planRerender({
            zoom: st.lastZoom, dpr: dpr, baseCssScale: st.baseCssScale, renderScale: st.renderScale,
            pageW: baseVp.width, pageH: baseVp.height,
            pxCap: this.effectivePxCap(this._env(), 1), maxSide: this.MAX_SIDE_HARD
          });
          // [WO 20260917] 구역(deck) 크롭이 고정돼 있으면 전체 페이지 임계와 무관하게
          //   항상 그 영역만 렌더 대상으로 삼는다 — 같은 픽셀 예산을 그 영역에 집중시켜
          //   A1/A0 가 첫 렌더부터 상한에 닿아 확대해도 선명해지지 않던 문제를 해소한다.
          if (st.deckCrop) { await this.renderCrop(page, canvas, plan.target, rot); return; }
          // [P14] 바탕이 배포 스냅샷 <img> 면 전면 캔버스를 다시 그릴 수 없다(레이아웃·핀 좌표 기준).
          //   → 스냅샷보다 선명해질 때만 보이는 영역을 크롭 오버레이로 얹는다.
          if (st.overlayOnly) {
            if (plan.target > (st.renderScale || 0) * this.RERENDER_GAIN) await this.renderCrop(page, canvas, plan.target, rot);
            else this._clearCrop();
            return;
          }
          // 전면 캔버스가 목표에 못 미치면(상한에 막힘) → 보이는 영역만 고해상도로 얹는다.
          if (plan.target > plan.capped * this.RERENDER_GAIN) {
            await this.renderCrop(page, canvas, plan.target, rot);
            return;
          }
          this._clearCrop(); // 전면 캔버스만으로 충분한 배율 → 크롭 오버레이는 불필요
          if (!plan.worth) return;
          await this._rasterize(page, canvas, plan.target, rot, st.baseCssScale);
        } catch (e) {}
      }, wait);
    },

    /** [WO 20260917] 구역(deck) 크롭(%, 0~100) → 렌더 대상 비율(0~1). 순수 함수.
     *  crop 없거나 폭/높이가 0 이하면 null(=구역 크롭 없음). 입력 객체는 변경하지 않는다. */
    deckCropToFraction(crop) {
      if (!crop || !(crop.w > 0) || !(crop.h > 0)) return null;
      return { x: crop.x / 100, y: crop.y / 100, w: crop.w / 100, h: crop.h / 100 };
    },

    /** 활성 구역 크롭을 렌더 상태에 고정 — 이후 렌더는 "현재 보이는 영역" 대신
     *  이 영역을 대상으로 삼는다(같은 픽셀 예산을 그 영역에 집중). crop 이 없으면 해제
     *  (= 구버전 구역·페이지 전체 구역은 종전대로 visibleDrawingRect 로 동작).
     *  [WO 20260928-crop] 같은 crop 을 MapCtrl 의 "페이지 경계"(클리핑+줌/팬 한계)에도
     *  전달하는 단일 진입점(§G-2-5) — 호출부(31_Projects.js)를 건드리지 않고 여기서 겸한다. */
    setDeckCrop(crop) {
      this._renderState.deckCrop = this.deckCropToFraction(crop);
      if (typeof MapCtrl !== "undefined" && MapCtrl.setCropBoundary) MapCtrl.setCropBoundary(crop);
      return this._renderState.deckCrop;
    },

    /** renderCrop 이 실제로 그릴 영역 선택(순수 로직 · 테스트 가능):
     *  구역 크롭이 고정돼 있으면 그것을, 아니면 종전대로 현재 보이는 영역. */
    _cropRenderRect() {
      const st = this._renderState;
      if (st.deckCrop) return st.deckCrop;
      return (typeof MapCtrl !== "undefined" && MapCtrl.visibleDrawingRect)
        ? MapCtrl.visibleDrawingRect() : null;
    },

    /** [화질 · 구조적 한계 우회] 지금 보이는 도면 영역만 목표 배율로 다시 그려 전면 캔버스 위에 얹는다.
     *  전면 캔버스 한 장은 페이지 전체를 담아야 해서 한 변 8192px·면적 상한에 막힌다
     *  (A1 기준 최대 배율 ≈3.44 → dpr2 화면에서 선명한 줌은 ≈1.7배까지). 구역 확대는 4~8배다.
     *  크롭은 보이는 만큼만 그리므로 면적이 뷰포트 크기로 묶여 상한에 걸리지 않는다.
     *  레이아웃 불변: 오버레이는 position:absolute 라 #map-transform 크기에 영향을 주지 않는다
     *  → 핀 % 좌표 정합이 그대로 유지된다. */
    async renderCrop(page, baseCanvas, scale, rot) {
      const st = this._renderState;
      const rect = this._cropRenderRect();
      if (!rect || (rect.w >= 1 && rect.h >= 1)) { this._clearCrop(); return; } // 전면이 다 보이면 크롭 이득 없음
      const baseVp = page.getViewport({ scale: 1, rotation: rot });
      const x0 = rect.x * baseVp.width,  y0 = rect.y * baseVp.height;
      const w0 = rect.w * baseVp.width,  h0 = rect.h * baseVp.height;
      // [회귀수정 2026-09-28] renderCrop() 은 정의상 "전면(base) 캔버스 위에 겹쳐 그린다"
      // (함수 상단 주석) — 이 함수가 실행되는 순간 base 는 이미 DOM 에 존재하고 이 크롭
      // 오버레이가 그 위에 추가로 상주한다 → 상주 캔버스는 항상 2개(고정 상수가 아니라
      // 이 함수의 실행 전제 자체가 2다).
      const rs = this.clampScale(scale, w0, h0, this.effectivePxCap(this._env(), 2), this.MAX_SIDE_HARD);
      // 전면 캔버스보다 선명하지 않으면 얹을 이유가 없다(메모리만 먹는다).
      if (rs <= (st.renderScale || 0) * this.RERENDER_GAIN) { this._clearCrop(); return; }
      const cv = this._ensureCrop(baseCanvas);
      if (!cv) return;
      const cssW = baseVp.width * st.baseCssScale, cssH = baseVp.height * st.baseCssScale;
      cv.width  = Math.max(1, Math.round(w0 * rs));
      cv.height = Math.max(1, Math.round(h0 * rs));
      cv.style.left   = (rect.x * cssW) + "px";
      cv.style.top    = (rect.y * cssH) + "px";
      cv.style.width  = (rect.w * cssW) + "px";
      cv.style.height = (rect.h * cssH) + "px";
      const ctx = cv.getContext("2d", { alpha: false });
      ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, cv.width, cv.height);
      try { if (st.cropTask) st.cropTask.cancel(); } catch (e) {}
      const vp = page.getViewport({ scale: rs, rotation: rot });
      // transform: 페이지 전체 뷰포트를 크롭 원점만큼 밀어 넣는다(크롭 좌상단이 캔버스 0,0).
      const task = page.render({
        canvasContext: ctx, viewport: vp,
        transform: [1, 0, 0, 1, -Math.round(x0 * rs), -Math.round(y0 * rs)]
      });
      st.cropTask = task;
      st.cropScale = rs;
      try { await task.promise; } catch (e) { /* cancel 등 무시 */ }
    },

    /** 크롭 오버레이 캔버스 확보 — 전용 CSS 없이 인라인 스타일만 쓴다.
     *  z-index 0 = 전면 캔버스(비위치 in-flow) 위 · 구역(1)·주석·핀(3) 레이어 아래. */
    _ensureCrop(baseCanvas) {
      const st = this._renderState;
      if (st.crop && st.crop.parentNode) return st.crop;
      const host = (baseCanvas && baseCanvas.parentNode) || document.getElementById("map-transform");
      if (!host) return null;
      const cv = document.createElement("canvas");
      cv.id = "pdf-canvas-hi";
      cv.style.cssText = "position:absolute;z-index:0;display:block;pointer-events:none;";
      if (baseCanvas && baseCanvas.nextSibling) host.insertBefore(cv, baseCanvas.nextSibling);
      else host.appendChild(cv);
      st.crop = cv;
      return cv;
    },

    /** 크롭 오버레이 제거(페이지·문서 전환, 축소, 전면 캔버스로 충분해진 경우) */
    _clearCrop() {
      const st = this._renderState;
      try { if (st.cropTask) st.cropTask.cancel(); } catch (e) {}
      st.cropTask = null; st.cropScale = 0;
      try { if (st.crop && st.crop.parentNode) st.crop.parentNode.removeChild(st.crop); } catch (e) {}
      st.crop = null;
    },

    /* ══════════════════════════════════════════════════════════════════
       [WO 20260928-copy] 영역 = "지정한 부분만 복사한 새 1페이지 PDF" (마스터: "확대하면 해상도가 깨지잖아")
       원본 페이지를 pdf-lib 로 통째 복사(벡터 그대로)한 뒤 MediaBox/CropBox 를 영역 사각형으로
       좁힌다 → 새 PDF 의 페이지 자체가 그 영역이라, 열면 일반 도면처럼 벡터 재렌더로 선명하다.
       pdf-lib(MIT 1.17.1)는 /vendor 에 벤더링 — CDN 금지, 영역 생성 때만 지연 로드(첫 화면 비용 0).
       ══════════════════════════════════════════════════════════════════ */
    PDFLIB_SRC: "/vendor/pdf-lib.min.js",
    _pdfLibPromise: null,

    /** pdf-lib 지연 로드(1회). 실패하면 약속을 비워 다음 시도에서 다시 받는다. */
    ensurePdfLib() {
      if (typeof window !== "undefined" && window.PDFLib) return Promise.resolve(window.PDFLib);
      if (this._pdfLibPromise) return this._pdfLibPromise;
      this._pdfLibPromise = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = this.PDFLIB_SRC;
        s.async = true;
        s.onload = () => (window.PDFLib ? resolve(window.PDFLib) : reject(new Error("pdf-lib 로드 실패")));
        s.onerror = () => reject(new Error("pdf-lib 로드 실패"));
        document.head.appendChild(s);
      }).catch((e) => { this._pdfLibPromise = null; throw e; });
      return this._pdfLibPromise;
    },

    /** 영역 crop(%, 화면=pdf.js 뷰포트 기준, 원점 좌상단) → PDF 사용자 공간 사각형(pt). 순수 함수.
     *  view   = [x0,y0,x1,y1] 페이지 보이는 상자(pdf.js page.view 와 같은 정의 = CropBox∩MediaBox)
     *  rotate = 페이지 /Rotate (0/90/180/270, 시계방향 — pdf.js 뷰포트 기본 회전과 동일)
     *  🔴 PDF 사용자 공간은 원점이 **좌하단**(y 가 위로 증가) — 화면 v(아래로 증가)를 뒤집어야 한다.
     *  @returns {{x,y,width,height}|null} */
    cropPctToPdfBox(crop, view, rotate) {
      const f = this.deckCropToFraction(crop);
      if (!f || !Array.isArray(view) || view.length < 4) return null;
      const r = ((Math.round(Number(rotate) || 0) % 360) + 360) % 360;
      if (r % 90) return null;
      const x0 = Math.min(view[0], view[2]), x1 = Math.max(view[0], view[2]);
      const y0 = Math.min(view[1], view[3]), y1 = Math.max(view[1], view[3]);
      const W = x1 - x0, H = y1 - y0;
      if (!(W > 0) || !(H > 0)) return null;
      // (u,v) = 화면 분수(u: 왼→오, v: 위→아래) → 사용자 공간. 회전별로 화면 좌상단이 가리키는 모서리가 다르다.
      const toUser = (u, v) => {
        if (r === 90)  return [x0 + v * W, y0 + u * H];
        if (r === 180) return [x1 - u * W, y0 + v * H];
        if (r === 270) return [x1 - v * W, y1 - u * H];
        return [x0 + u * W, y1 - v * H];                    // 0° — y 뒤집기(좌하단 원점)
      };
      const a = toUser(f.x, f.y), b = toUser(f.x + f.w, f.y + f.h);
      const x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]);
      return { x, y, width: Math.abs(b[0] - a[0]), height: Math.abs(b[1] - a[1]) };
    },

    /** 원본 PDF 가 화면의 도면(스냅샷)과 같은 파일인지 — 다르면 crop % 가 엉뚱한 곳을 가리킨다. 순수 함수.
     *  expect = { count?, pw?, ph? (스냅샷이 기록한 페이지 pt) , w?, h? (스냅샷 px — 비율만 비교) }
     *  actual = { count, w, h } (원본 PDF 의 해당 페이지, 회전 반영한 화면 기준 pt)
     *  @returns {string|null} 불일치 사유(사용자에게 그대로 보여줄 문장) · 일치/판단불가면 null */
    regionSizeMismatch(expect, actual, tol) {
      if (!expect || !actual) return null;
      const t = tol > 0 ? tol : 0.01;
      const off = (a, b) => Math.abs(a - b) / b > t;
      if (expect.count > 0 && actual.count !== expect.count)
        return "페이지 수가 다릅니다(도면 " + expect.count + "쪽 · 올린 PDF " + actual.count + "쪽)";
      if (expect.pw > 0 && expect.ph > 0) {
        if (off(actual.w, expect.pw) || off(actual.h, expect.ph))
          return "페이지 크기가 다릅니다(도면 " + Math.round(expect.pw) + "×" + Math.round(expect.ph) + "pt · 올린 PDF " + Math.round(actual.w) + "×" + Math.round(actual.h) + "pt)";
        return null;
      }
      if (expect.w > 0 && expect.h > 0 && actual.w > 0 && actual.h > 0) {
        if (off(actual.w / actual.h, expect.w / expect.h)) return "페이지 가로세로 비율이 다릅니다";
      }
      return null;
    },

    /** pdf-lib 페이지의 보이는 상자 [x0,y0,x1,y1] — pdf.js page.view 와 같은 규칙(CropBox∩MediaBox). */
    _pdfLibView(pg) {
      const mb = pg.getMediaBox();
      const m = [mb.x, mb.y, mb.x + mb.width, mb.y + mb.height];
      let c = m;
      try { const cb = pg.getCropBox(); c = [cb.x, cb.y, cb.x + cb.width, cb.y + cb.height]; } catch (e) {}
      const v = [Math.max(m[0], c[0]), Math.max(m[1], c[1]), Math.min(m[2], c[2]), Math.min(m[3], c[3])];
      return (v[2] > v[0] && v[3] > v[1]) ? v : m;
    },

    /** 원본 PDF 한 페이지의 영역만 담은 새 1페이지 PDF 를 만든다(벡터 복사 — 래스터 0).
     *  원본 바이트는 읽기만 한다(원본 파일·배포본 무변경).
     *  @param {ArrayBuffer|Uint8Array} srcBytes 원본 PDF
     *  @param {number} pageNo 1-base
     *  @param {object} crop {x,y,w,h} %
     *  @param {object} [expect] regionSizeMismatch 의 기대값 — 다르면 code="SIZE_MISMATCH" 로 throw
     *  @returns {Promise<{bytes:Uint8Array, box:{x,y,width,height}, rotate:number, pageCount:number}>} */
    async copyRegionToPdf(srcBytes, pageNo, crop, expect) {
      const L = await this.ensurePdfLib();
      const src = await L.PDFDocument.load(srcBytes, { ignoreEncryption: true, updateMetadata: false });
      const n = src.getPageCount();
      const idx = Math.round(Number(pageNo) || 1) - 1;
      if (idx < 0 || idx >= n) { const e = new Error("원본 PDF 에 " + (idx + 1) + "쪽이 없습니다"); e.code = "SIZE_MISMATCH"; throw e; }
      const sp = src.getPage(idx);
      const rot = ((((sp.getRotation() && sp.getRotation().angle) || 0) % 360) + 360) % 360;
      const view = this._pdfLibView(sp);
      const vw = view[2] - view[0], vh = view[3] - view[1];
      const why = this.regionSizeMismatch(expect, { count: n, w: rot % 180 ? vh : vw, h: rot % 180 ? vw : vh });
      if (why) { const e = new Error(why); e.code = "SIZE_MISMATCH"; throw e; }
      const box = this.cropPctToPdfBox(crop, view, rot);
      if (!box || !(box.width > 0) || !(box.height > 0)) throw new Error("영역 좌표를 PDF 좌표로 바꿀 수 없습니다");
      const out = await L.PDFDocument.create();
      const copied = await out.copyPages(src, [idx]);   // 페이지 내용(벡터·폰트·이미지)을 그대로 복사
      const pg = copied[0];
      out.addPage(pg);
      // 보이는 상자를 영역으로 — 5종 상자를 모두 맞춰야 뷰어마다 같은 크기로 보인다.
      pg.setMediaBox(box.x, box.y, box.width, box.height);
      pg.setCropBox(box.x, box.y, box.width, box.height);
      pg.setBleedBox(box.x, box.y, box.width, box.height);
      pg.setTrimBox(box.x, box.y, box.width, box.height);
      pg.setArtBox(box.x, box.y, box.width, box.height);
      pg.setRotation(L.degrees(rot));                   // 회전 유지 → 원본 화면과 같은 방향
      const bytes = await out.save();
      return { bytes, box, rotate: rot, pageCount: n };
    },

    /** [WO 20260917] 구역 크롭이 있는 페이지의 스냅샷 렌더 대상 사각형(페이지 포인트 단위). 순수 함수.
     *  crop 없으면 페이지 전체(종전 동작) — snapshotAllPages 자체는 변경하지 않는다(비파괴). */
    deckSnapshotRect(crop, pageW, pageH) {
      const f = this.deckCropToFraction(crop);
      if (!f) return { x0: 0, y0: 0, w0: pageW, h0: pageH };
      return { x0: f.x * pageW, y0: f.y * pageH, w0: f.w * pageW, h0: f.h * pageH };
    },

    /** 전 페이지를 오프스크린 렌더 → 고화질 이미지 dataURL 배열 (배포 스냅샷용).
     *  뷰어에서 확대해도 선명하도록 해상도를 충분히 높게 잡되(maxDim 4096),
     *  엔지니어링 도면(선/텍스트 위주)은 PNG 가 JPEG보다 선명하고 용량도 작은 경우가 많아
     *  PNG/JPEG 중 더 작은 쪽을 자동 선택한다. 너무 크면 단계적으로 해상도를 낮춰 D1 저장 안정성 확보.
     *  [WO 20260917] deckCrop = { page(1-base), crop:{x,y,w,h}(%) } 이 주어지고 그 페이지 번호와
     *  일치하면, 그 페이지만 deckSnapshotRect 로 잘라낸 영역을 대상으로 스케일을 계산해
     *  같은 픽셀 예산(maxDim)을 크롭 영역에 집중한다(renderCrop 과 동일한 transform 오프셋 기법 재사용).
     *  🔴 [지휘자 판단 필요] 이 페이지에 16_Zones.js 구역·PDF 주석이 있으면 좌표(페이지 기준 %)가
     *  크롭 이미지 기준과 어긋난다 — 핀(x,y)만 MapCtrl.pageToDeckCropPct 로 재매핑했고
     *  zones/annotations 재매핑은 이번 범위에 없다(별도 함수 필요, 미구현). */
    async snapshotAllPages(pdfDoc, maxDim = 4096, quality = 0.92, deckCrop = null) {
      const out = [];
      // [P14] 실제로 저장된 픽셀 크기를 기록한다 — SOFT_LIMIT 강등(dim*=0.8, 최대 4회)으로
      //   요청 maxDim(4096)보다 훨씬 낮게 저장되는 경우가 있고, 뷰어는 그 값을 알아야
      //   "언제 원본이 필요한지"를 추측이 아니라 사실로 판정할 수 있다.
      const dims = [];
      this.lastSnapshotDims = null;
      const SOFT_LIMIT = 2_600_000; // dataURL 문자수 상한 (≈2MB) — 초과 시 해상도 자동 강등
      for (let p = 1; p <= pdfDoc.numPages; p++) {
        const page = await pdfDoc.getPage(p);
        const base = page.getViewport({ scale: 1 });
        const isCropPage = !!(deckCrop && (deckCrop.page || 1) === p && deckCrop.crop);
        const rect = isCropPage ? this.deckSnapshotRect(deckCrop.crop, base.width, base.height)
                                 : { x0: 0, y0: 0, w0: base.width, h0: base.height };
        const px = { w: 0, h: 0, pw: Math.round(rect.w0), ph: Math.round(rect.h0) };
        let dim = maxDim, q = quality, data = null;
        for (let attempt = 0; attempt < 4; attempt++) {
          const scale = Math.min(dim / Math.max(rect.w0, rect.h0), 4);
          const vp = page.getViewport({ scale });
          const cv = document.createElement("canvas");
          cv.width = Math.max(1, Math.round(rect.w0 * scale));
          cv.height = Math.max(1, Math.round(rect.h0 * scale));
          px.w = cv.width; px.h = cv.height;   // 이 시도가 채택되면 이 값이 최종 저장 픽셀
          const ctx = cv.getContext("2d", { alpha: false });
          ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, cv.width, cv.height);
          if (isCropPage) {
            // renderCrop(02_PDF.js)과 동일한 오프셋 기법: 페이지 전체를 그리되 크롭 원점만큼 밀어
            // 캔버스(=크롭 크기)에는 크롭 영역만 담긴다.
            await page.render({
              canvasContext: ctx, viewport: vp,
              transform: [1, 0, 0, 1, -Math.round(rect.x0 * scale), -Math.round(rect.y0 * scale)]
            }).promise;
          } else {
            await page.render({ canvasContext: ctx, viewport: vp }).promise;
          }
          // 선화 도면은 PNG 가 더 선명/경량인 경우가 많음 → PNG·JPEG 중 작은 쪽 채택
          const png = cv.toDataURL("image/png");
          const jpg = cv.toDataURL("image/jpeg", q);
          data = (png.length <= jpg.length) ? png : jpg;
          if (data.length <= SOFT_LIMIT || dim <= 1600) break;
          // 용량 초과 → 해상도/품질 강등 후 재시도
          dim = Math.round(dim * 0.8); q = Math.max(0.8, q - 0.04);
        }
        out.push(data);
        dims.push(px);
      }
      this.lastSnapshotDims = dims;
      return out;
    }
  };

  /* ══════════════════════════════════════════
     LOG  — 사용자 액션 추적(로그인 이후 모든 주요 행위)
     서버 /api/client-log 로 비동기 전송. 실패해도 앱 흐름 방해 안 함.
  ══════════════════════════════════════════ */
  const Log = {
    /** action(화이트리스트), targetId?, detail? */
    push(action, targetId, detail) {
      try {
        // 로그인 안 된 상태면 서버가 401 → 조용히 무시됨
        fetch("/api/client-log", {
          method: "POST",
          headers: Auth.headers(),
          body: JSON.stringify({ action, targetId: targetId || undefined, detail: detail || undefined }),
          keepalive: true
        }).catch(() => {});
      } catch (e) {}
    }
  };

  /* ══════════════════════════════════════════
     CLOUD  — 360° 그림 파일 저장소 (RESTful Table API)
  ══════════════════════════════════════════ */
  const Cloud = {
    /** 업로드 목표 최대 용량(JPEG 바이트). THETA 고해상도도 D1에 안전히 저장되도록 제한 */
    MAX_UPLOAD_BYTES: 1400 * 1024, // ≈1.4MB (base64 환산 ≈1.9MB)

    /** File → 디코딩된 비트맵 소스(ImageBitmap 또는 HTMLImageElement) 반환
     *  THETA 등 고해상도/특수 JPEG도 안정적으로 읽도록 createImageBitmap 우선 사용,
     *  실패 시 HTMLImageElement로 폴백한다. */
    async _decode(file, targetMax = 4096) {
      // 1순위: createImageBitmap — 디코딩과 동시에 다운스케일하여 메모리 폭증/탭 크래시 방지.
      //  (THETA 등 5376×2688↑ 초고해상도 JPEG를 원본 그대로 디코딩하면 메모리 한계로 크래시)
      if (typeof createImageBitmap === "function") {
        // THETA 등 초고해상도 JPEG(6720×3360 등)를 createImageBitmap(file) 으로
        //    "원본 그대로" 디코딩하면 메모리 한계로 탭이 크래시(=업로드 hang)된다.
        //    따라서 절대 풀해상도 probe 를 하지 않고, 처음부터 resizeWidth 만 지정해
        //    비율을 유지한 채 축소 디코딩한다. (360° 도면은 가로가 장변인 2:1 파노라마)
        try {
          const bmp = await createImageBitmap(file, {
            imageOrientation: "from-image",
            resizeWidth: targetMax,        // 가로를 targetMax 이하로 (비율 자동 유지)
            resizeQuality: "high"
          });
          if (bmp && bmp.width && bmp.height) {
            // 혹시 세로가 더 긴 이미지면 면적이 클 수 있으니, draw 단계(resizeImage)에서
            // MAX_AREA 로 한 번 더 제한된다. 여기서는 안전한 비트맵만 반환.
            return { src: bmp, w: bmp.width, h: bmp.height, bitmap: true };
          }
        } catch (e) { /* 폴백으로 진행 */ }
      }
      // 2순위: HTMLImageElement (objectURL → 실패 시 dataURL)
      const tryImg = (srcUrl) => new Promise((resolve, reject) => {
        const img = new Image();
        const to = setTimeout(() => reject(new Error("timeout")), 20000);
        img.onload  = () => { clearTimeout(to); resolve(img); };
        img.onerror = () => { clearTimeout(to); reject(new Error("decode")); };
        img.src = srcUrl;
      });
      const objUrl = URL.createObjectURL(file);
      try {
        const img = await tryImg(objUrl);
        if (img.naturalWidth && img.naturalHeight)
          return { src: img, w: img.naturalWidth, h: img.naturalHeight, bitmap: false, _objUrl: objUrl };
        throw new Error("empty");
      } catch (e) {
        URL.revokeObjectURL(objUrl);
        // 3순위: FileReader → dataURL → Image (objectURL이 막힌 환경 대응)
        const dataUrl = await new Promise((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(r.result);
          r.onerror = () => rej(new Error("파일 읽기 실패"));
          r.readAsDataURL(file);
        });
        const img2 = await tryImg(dataUrl);
        if (img2.naturalWidth && img2.naturalHeight)
          return { src: img2, w: img2.naturalWidth, h: img2.naturalHeight, bitmap: false };
        throw new Error("이미지를 디코딩할 수 없습니다(지원하지 않는 형식일 수 있음)");
      }
    },

    /** File → 리사이즈 JPEG dataURL.
     *  장변 maxDim 이하로 줄이고, 목표 용량을 넘으면 품질/크기를 자동으로 낮춰 보장한다. */
    async resizeImage(file, maxDim = 4096, quality = 0.85) {
      if (!file) throw new Error("이미지 파일이 없습니다");

      let decoded;
      try {
        decoded = await this._decode(file, maxDim);
      } catch (e) {
        throw new Error("이미지 파일을 읽을 수 없습니다 (" + (e.message || "decode") + ")");
      }

      const draw = (targetMax, q) => {
        let w = decoded.w, h = decoded.h;
        // canvas 면적 제한(브라우저별 ~16M~268M px) 대응: 장변 + 면적 동시 제한
        const MAX_AREA = 24 * 1000 * 1000; // 2400만 px (≈ 6928px²)
        let ratio = Math.min(1, targetMax / Math.max(w, h));
        let aw = Math.round(w * ratio), ah = Math.round(h * ratio);
        if (aw * ah > MAX_AREA) {
          const ar = Math.sqrt(MAX_AREA / (aw * ah));
          aw = Math.round(aw * ar); ah = Math.round(ah * ar);
        }
        const cv = document.createElement("canvas");
        cv.width = aw; cv.height = ah;
        const ctx = cv.getContext("2d");
        if (!ctx) throw new Error("캔버스 컨텍스트를 만들 수 없습니다");
        ctx.drawImage(decoded.src, 0, 0, aw, ah);
        const durl = cv.toDataURL("image/jpeg", q);
        return { dataURL: durl, width: aw, height: ah };
      };

      // 1차 시도
      let dim = maxDim, q = quality;
      let out = draw(dim, q);
      if (!out.dataURL || out.dataURL.length < 100 || out.dataURL.indexOf("data:image/jpeg") !== 0) {
        throw new Error("이미지 인코딩에 실패했습니다(해상도가 너무 큼)");
      }

      // 목표 용량 초과 시: 품질 → 크기 순으로 단계적 축소
      const bytesOf = d => Math.floor((d.length - "data:image/jpeg;base64,".length) * 0.75);
      let guard = 0;
      while (bytesOf(out.dataURL) > this.MAX_UPLOAD_BYTES && guard < 8) {
        guard++;
        if (q > 0.55) q -= 0.1;          // 먼저 품질을 낮추고
        else { dim = Math.round(dim * 0.8); q = 0.7; } // 그래도 크면 해상도를 줄임
        out = draw(dim, Math.max(0.4, q));
      }

      // 비트맵 자원 정리
      if (decoded.bitmap && decoded.src.close) { try { decoded.src.close(); } catch (e) {} }
      if (decoded._objUrl) { try { URL.revokeObjectURL(decoded._objUrl); } catch (e) {} }

      return out;
    },

    /** 업로드 → 레코드 id 반환 (타임아웃·명확한 오류 처리 포함) */
    async uploadImage(name, dataURL, width, height) {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 60000); // 최대 60초
      let res;
      try {
        res = await fetch("/tables/pano_images", {
          method: "POST",
          headers: Auth.headers(),
          body: JSON.stringify({ name, image_data: dataURL, width, height }),
          signal: ctrl.signal
        });
      } catch (e) {
        clearTimeout(to);
        if (e.name === "AbortError") throw new Error("업로드 시간 초과(네트워크가 느리거나 파일이 큽니다)");
        throw new Error("네트워크 오류: " + (e.message || e));
      }
      clearTimeout(to);
      if (!res.ok) {
        let detail = "";
        try { detail = (await res.text()).slice(0, 120); } catch (e) {}
        throw new Error("서버 저장 실패 (HTTP " + res.status + (detail ? " · " + detail : "") + ")");
      }
      let rec;
      try { rec = await res.json(); } catch (e) { throw new Error("서버 응답을 해석할 수 없습니다"); }
      if (!rec || !rec.id) throw new Error("서버가 이미지 ID를 반환하지 않았습니다");
      return rec.id;
    },

    /** id → dataURL (간단 메모리 캐시) */
    _cache: {},
    async fetchImage(id) {
      if (this._cache[id]) return this._cache[id];
      // [보안 H4] pano_images 인증 게이트 동반 — 헤더 미전송 시 401
      const res = await fetch("/tables/pano_images/" + encodeURIComponent(id), { headers: (typeof Auth !== "undefined" ? Auth.headers() : {}) });
      if (!res.ok) throw new Error("저장된 이미지를 불러올 수 없습니다 (HTTP " + res.status + ")");
      const rec = await res.json();
      if (!rec.image_data) throw new Error("이미지 데이터가 비어 있습니다");
      this._cache[id] = rec.image_data;
      return rec.image_data;
    },

    /* ── 첨부 문서(PDF/Word 등) — pano_images 테이블을 범용 dataURL 저장소로 재사용 ── */
    /** 단일 첨부 최대 용량(원본 바이트). D1 안전 한도 내. */
    MAX_DOC_BYTES: 3 * 1024 * 1024, // 3MB (base64 환산 ≈4MB)

    /** File → base64 dataURL (그대로, 무손실) */
    fileToDataURL(file) {
      return new Promise((res, rej) => {
        const r = new FileReader();
        r.onload  = () => res(r.result);
        r.onerror = () => rej(new Error("파일 읽기 실패"));
        r.readAsDataURL(file);
      });
    },

    /** 문서 업로드 → docId 반환. name 에 표시명 그대로 저장. */
    async uploadDoc(name, dataURL) {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 60000);
      let res;
      try {
        res = await fetch("/tables/pano_images", {
          method: "POST",
          headers: Auth.headers(),
          body: JSON.stringify({ name: "[doc] " + name, image_data: dataURL }),
          signal: ctrl.signal
        });
      } catch (e) {
        clearTimeout(to);
        if (e.name === "AbortError") throw new Error("업로드 시간 초과(파일이 큽니다)");
        throw new Error("네트워크 오류: " + (e.message || e));
      }
      clearTimeout(to);
      if (!res.ok) {
        let detail = "";
        try { detail = (await res.text()).slice(0, 120); } catch (e) {}
        throw new Error("문서 저장 실패 (HTTP " + res.status + (detail ? " · " + detail : "") + ")");
      }
      const rec = await res.json();
      if (!rec || !rec.id) throw new Error("서버가 문서 ID를 반환하지 않았습니다");
      this._cache[rec.id] = dataURL; // 즉시 다운로드 캐시
      return rec.id;
    },

    /** docId → dataURL */
    async fetchDoc(id) {
      if (this._cache[id]) return this._cache[id];
      const res = await fetch("/tables/pano_images/" + encodeURIComponent(id), { headers: (typeof Auth !== "undefined" ? Auth.headers() : {}) });
      if (!res.ok) throw new Error("첨부 문서를 불러올 수 없습니다 (HTTP " + res.status + ")");
      const rec = await res.json();
      if (!rec.image_data) throw new Error("문서 데이터가 비어 있습니다");
      this._cache[id] = rec.image_data;
      return rec.image_data;
    }
  };

  /* ══════════════════════════════════════════
     SyncQueue — 오프라인 우선 동기화 큐 (IndexedDB)
     · 핀의 미디어/문서 업로드를 "작업(op)"으로 로컬에 영구 보관한다.
     · 온라인이면 즉시 서버로 일괄(batch) 업로드, 오프라인이면 큐에 쌓아두고
       'online' 이벤트(=WiFi/인터넷 복구) 시 자동으로 전체 업로드/업데이트한다.
     · 스마트폰에서 인터넷이 끊겨도 핀 등록이 가능하며, 새로고침 후에도 큐가 유지된다.
     · 서버 의존 없는 안정 설계: IndexedDB 미지원 환경은 localStorage 폴백.
  ══════════════════════════════════════════ */
  const SyncQueue = {
    // 🔴 SoT — IndexedDB 이름은 이 리터럴 하나뿐이다(코드 전체 grep 결과: 다른 이름 0건).
    // [마스터 실측 2026-09-18] 프로덕션 브라우저에서 "wm-sync"(하이픈, 빈 DB)와
    // "wm_sync"(언더바, drafts 4건) 두 DB가 동시에 존재하는 것이 관찰됐다 — 그러나
    // 소스 전체(현재+git 이력)를 grep 해도 "wm-sync"(하이픈)를 생성하는 코드는
    // 이 리포에 존재하지 않는다(sw.js도 indexedDB 미사용, PWA/workbox 플러그인 없음).
    // 즉 하이픈 DB는 이 코드가 만든 게 아닌 잔여물로 추정 — 그래도 방어적으로
    // _migrateLegacyDb() 에서 감지 시 데이터가 있으면 옮기고 없으면 정리한다.
    LEGACY_DB_NAME: "wm-sync",
    DB_NAME: "wm_sync",
    STORE: "ops",
    _db: null,
    _syncing: false,
    _listeners: [],

    /** 상태 변경 구독 (배지 갱신용) */
    onChange(fn) { this._listeners.push(fn); },
    _emit() {
      this.count().then(n => {
        this._listeners.forEach(fn => { try { fn(n, navigator.onLine); } catch (e) {} });
      });
    },

    DRAFT_STORE: "drafts",
    AUTH_STORE: "authlocal",   // [P40] 오프라인 재인증 검증자(verifier) — 평문 비밀번호는 절대 담지 않는다

    async _open() {
      if (this._db) return this._db;
      if (!("indexedDB" in window)) return null; // localStorage 폴백 사용
      this._db = await new Promise((res, rej) => {
        const req = indexedDB.open(this.DB_NAME, 3);   // v2: drafts / v3: authlocal 스토어 추가
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(this.STORE)) {
            db.createObjectStore(this.STORE, { keyPath: "opId" });
          }
          if (!db.objectStoreNames.contains(this.DRAFT_STORE)) {
            db.createObjectStore(this.DRAFT_STORE, { keyPath: "key" }); // 도면 임시저장(오프라인/서버실패 폴백)
          }
          if (!db.objectStoreNames.contains(this.AUTH_STORE)) {
            db.createObjectStore(this.AUTH_STORE, { keyPath: "key" });  // 오프라인 재인증 검증자
          }
        };
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error || new Error("indexedDB open failed"));
      }).catch(() => null);
      return this._db;
    },

    /* ═══ 도면 DRAFT 영속화 (오프라인/서버실패 시 도면 소실 방지) ═══
       key 별로 도면 스냅샷+핀+구역을 로컬에 보관. 새로고침/오프라인에도 유지.
       IndexedDB 우선, 미지원 시 localStorage 폴백. */
    async saveDraft(key, data) {
      const rec = { key: key, data: data, savedAt: Date.now() };
      const db = await this._open();
      if (db && db.objectStoreNames.contains(this.DRAFT_STORE)) {
        try {
          await new Promise((res, rej) => {
            const tx = db.transaction(this.DRAFT_STORE, "readwrite");
            tx.objectStore(this.DRAFT_STORE).put(rec);
            tx.oncomplete = res; tx.onerror = () => rej(tx.error);
          });
          return true;
        } catch (e) { /* 폴백으로 */ }
      }
      try { localStorage.setItem("wm_draft_" + key, JSON.stringify(rec)); return true; }
      catch (e) { return false; }
    },
    async loadDraft(key) {
      const db = await this._open();
      if (db && db.objectStoreNames.contains(this.DRAFT_STORE)) {
        try {
          const rec = await new Promise((res) => {
            const tx = db.transaction(this.DRAFT_STORE, "readonly");
            const rq = tx.objectStore(this.DRAFT_STORE).get(key);
            rq.onsuccess = () => res(rq.result); rq.onerror = () => res(null);
          });
          if (rec) return rec.data;
        } catch (e) {}
      }
      try { const r = JSON.parse(localStorage.getItem("wm_draft_" + key) || "null"); return r ? r.data : null; }
      catch (e) { return null; }
    },
    async removeDraft(key) {
      const db = await this._open();
      if (db && db.objectStoreNames.contains(this.DRAFT_STORE)) {
        try {
          await new Promise((res) => {
            const tx = db.transaction(this.DRAFT_STORE, "readwrite");
            tx.objectStore(this.DRAFT_STORE).delete(key);
            tx.oncomplete = res; tx.onerror = res;
          });
        } catch (e) {}
      }
      try { localStorage.removeItem("wm_draft_" + key); } catch (e) {}
    },
    async allDraftKeys() {
      const db = await this._open();
      if (db && db.objectStoreNames.contains(this.DRAFT_STORE)) {
        try {
          return await new Promise((res) => {
            const tx = db.transaction(this.DRAFT_STORE, "readonly");
            const rq = tx.objectStore(this.DRAFT_STORE).getAllKeys();
            rq.onsuccess = () => res(rq.result || []); rq.onerror = () => res([]);
          });
        } catch (e) {}
      }
      const keys = [];
      try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith("wm_draft_")) keys.push(k.slice(9)); } } catch (e) {}
      return keys;
    },

    /* ═══ [P40] 오프라인 재인증 검증자 보관 ═══
       저장되는 것은 PBKDF2-SHA256(100k) 해시 + salt 뿐이다(서버 hashPassword 와 동일 파라미터).
       기기를 털려도 원문 비밀번호는 복원되지 않는다. 보관 위치는 기존 IndexedDB 재사용(신규 저장소 없음). */
    AUTH_KEY: "offline-verifier",
    _authLsKey() { return "wm_offline_auth"; },
    async saveAuthRecord(rec) {
      const row = { key: this.AUTH_KEY, rec: rec };
      const db = await this._open();
      if (db && db.objectStoreNames.contains(this.AUTH_STORE)) {
        try {
          await new Promise((res, rej) => {
            const tx = db.transaction(this.AUTH_STORE, "readwrite");
            tx.objectStore(this.AUTH_STORE).put(row);
            tx.oncomplete = res; tx.onerror = () => rej(tx.error);
          });
          return true;
        } catch (e) { /* 폴백으로 */ }
      }
      try { localStorage.setItem(this._authLsKey(), JSON.stringify(row)); return true; } catch (e) { return false; }
    },
    async loadAuthRecord() {
      const db = await this._open();
      if (db && db.objectStoreNames.contains(this.AUTH_STORE)) {
        try {
          const row = await new Promise((res) => {
            const tx = db.transaction(this.AUTH_STORE, "readonly");
            const rq = tx.objectStore(this.AUTH_STORE).get(this.AUTH_KEY);
            rq.onsuccess = () => res(rq.result); rq.onerror = () => res(null);
          });
          if (row) return row.rec;
        } catch (e) {}
      }
      try { const r = JSON.parse(localStorage.getItem(this._authLsKey()) || "null"); return r ? r.rec : null; }
      catch (e) { return null; }
    },
    async clearAuthRecord() {
      const db = await this._open();
      if (db && db.objectStoreNames.contains(this.AUTH_STORE)) {
        try {
          await new Promise((res) => {
            const tx = db.transaction(this.AUTH_STORE, "readwrite");
            tx.objectStore(this.AUTH_STORE).delete(this.AUTH_KEY);
            tx.oncomplete = res; tx.onerror = res;
          });
        } catch (e) {}
      }
      try { localStorage.removeItem(this._authLsKey()); } catch (e) {}
    },

    /* ── localStorage 폴백 ── */
    _lsKey() { return "wm_sync_ops"; },
    _lsAll() { try { return JSON.parse(localStorage.getItem(this._lsKey()) || "[]"); } catch (e) { return []; } },
    _lsSet(arr) { try { localStorage.setItem(this._lsKey(), JSON.stringify(arr)); return true; } catch (e) { return false; } },

    /** op 추가 — {opId, kind:'image'|'doc', name, image_data, width?, height?, meta?} */
    async enqueue(op) {
      op.opId = op.opId || ("op" + Date.now() + Math.random().toString(36).slice(2, 8));
      op.createdAt = Date.now();
      op.status = "pending";
      const db = await this._open();
      // [버그수정 A] IDB 트랜잭션이 동기 throw(InvalidStateError: 모바일 백그라운드/versionchange)하면
      //   op이 큐에도 안 들어가 영구손실 → try/catch + localStorage 폴백으로 항상 저장 보장.
      let stored = false;
      if (db) {
        try {
          await new Promise((res, rej) => {
            const tx = db.transaction(this.STORE, "readwrite");
            tx.objectStore(this.STORE).put(op);
            tx.oncomplete = res; tx.onerror = () => rej(tx.error);
          });
          stored = true;
        } catch (e) { /* IDB 실패 → 아래 localStorage 폴백 */ }
      }
      if (!stored) {
        const all = this._lsAll(); all.push(op); stored = this._lsSet(all);
      }
      if (!stored) {
        // [무신호 손실 차단] IDB·localStorage 모두 실패(저장공간 부족/차단) →
        //   기존엔 opId 를 반환해 배지엔 떴지만 영영 전송 못 하는 '유령 op' 였다.
        //   이제 사용자에게 명시 신호 + null 반환 → 호출부가 pendingOpId 를 세팅하지 않도록.
        try { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("오프라인 저장 실패 — 기기 저장공간 부족"); } catch (e) {}
        this._emit();
        return null;
      }
      this._emit();
      return op.opId;
    },

    async all() {
      const db = await this._open();
      if (db) {
        return await new Promise((res) => {
          const tx = db.transaction(this.STORE, "readonly");
          const rq = tx.objectStore(this.STORE).getAll();
          rq.onsuccess = () => res(rq.result || []);
          rq.onerror = () => res([]);
        });
      }
      return this._lsAll();
    },

    async count() {
      const all = await this.all();
      return all.filter(o => o.status !== "done").length;
    },

    async _remove(opId) {
      const db = await this._open();
      if (db) {
        await new Promise((res) => {
          const tx = db.transaction(this.STORE, "readwrite");
          tx.objectStore(this.STORE).delete(opId);
          tx.oncomplete = res; tx.onerror = res;
        });
      } else {
        this._lsSet(this._lsAll().filter(o => o.opId !== opId));
      }
    },

    /** 전체 큐를 서버로 일괄 업로드/업데이트. 결과: {ok, uploaded, failed, map:{opId:serverId}} */
    async flush() {
      if (this._syncing) return { ok: false, busy: true };
      if (!navigator.onLine) return { ok: false, offline: true };
      // [P40 보안] 오프라인 검증자로만 인증된 상태(서버가 검증하지 않은 신원)로는 서버 쓰기를 시도하지 않는다.
      //   큐는 그대로 보존 → 온라인 재로그인(서버 재검증) 후 자동 업로드된다.
      if (typeof Auth !== "undefined" && Auth.canServerWrite && !Auth.canServerWrite()) {
        return { ok: false, offlineAuth: true, reason: "오프라인 인증 상태 — 서버 업로드는 온라인 재로그인 후 진행됩니다" };
      }
      const pending = (await this.all()).filter(o => o.status !== "done");
      if (pending.length === 0) { this._emit(); return { ok: true, uploaded: 0, map: {} }; }

      this._syncing = true; this._emit();
      const map = {};
      let uploaded = 0, failed = 0;
      try {
        // 한 번에 너무 큰 페이로드 방지 — 청크로 분할 업로드
        const CHUNK = 4;
        for (let i = 0; i < pending.length; i += CHUNK) {
          const batch = pending.slice(i, i + CHUNK).map(o => ({
            opId: o.opId, kind: o.kind, name: o.name,
            image_data: o.image_data, width: o.width, height: o.height
          }));
          let res;
          try {
            res = await fetch("/api/sync/batch", {
              method: "POST",
              headers: Auth.headers(),
              body: JSON.stringify({ ops: batch })
            });
          } catch (e) { failed += batch.length; break; } // 네트워크 단절 → 다음 online 때 재시도
          if (!res.ok) {
            // [P16] 401/403(토큰 만료) → 공유 지점(Auth.authExpired)에서 세션당 1회 안내 + 재로그인 게이트.
            //   큐는 그대로 보존(제거하지 않음) — 재로그인 후 자동 재시도.
            if ((res.status === 401 || res.status === 403) && typeof Auth !== "undefined" && Auth.authExpired) Auth.authExpired();
            failed += batch.length; break;
          }
          const data = await res.json();
          for (const r of (data.results || [])) {
            if (r.ok && r.id) { map[r.opId] = r.id; uploaded++; await this._remove(r.opId); }
            else if (r.permanent === true) {
              // [데이터손실 차단] 결정적 거부(검증실패/용량초과 등)만 dead-letter 제거 →
              //   매 동기화 무한재시도("동기화 중" 영구표시) 방지. 서버가 permanent=true 로 명시할 때만.
              failed++;
              await this._remove(r.opId);
              try { console.warn("[SyncQueue] op 영구거부 → 제거:", r.opId, (r && r.error) || ""); } catch (e) {}
            } else {
              // [데이터손실 차단 — 핵심] 일시적 실패(DB장애/타임아웃 등)는 큐 '보존'.
              //   기존 코드는 일시 오류도 무조건 제거해 360 사진이 영구 소실됐다.
              //   → 다음 수동 동기화 때 재시도. (서버 멱등 source_op_id 로 중복생성도 0)
              failed++;
              try { console.warn("[SyncQueue] op 일시실패 → 큐 보존(재시도):", r.opId, (r && r.error) || ""); } catch (e) {}
            }
          }
        }
      } finally {
        this._syncing = false; this._emit();
      }
      return { ok: failed === 0, uploaded, failed, map };
    },

    /** [마스터: 자동 반영] 인터넷 복구 시 App 의 online 핸들러가 _onReconnect() 를 호출해
     *  오프라인 큐(첨부 사진/PDF)를 자동 업로드한다. 배지 "↑ 지금 올리기 N" 은 자동 flush 실패/
     *  대기 중 수동 재시도용으로 그대로 유지. (온라인 일반 저장은 큐를 거치지 않고 즉시 직접 업로드) */
    init() {
      if (this._inited) return; this._inited = true;
      window.addEventListener("online", () => this._emit());
      window.addEventListener("offline", () => this._emit());
      this._emit();
      // [마스터 요건1 2026-09-18] 옛 이름 잔여 DB 정리(있으면 데이터 이관 후 삭제) — fire-and-forget.
      try { this._migrateLegacyDb(); } catch (e) {}
    },

    /** [마스터 요건1 2026-09-18] LEGACY_DB_NAME("wm-sync", 하이픈) 잔여 DB가 있으면
     *  같은 이름의 스토어에 데이터가 있는 걸 정본 DB_NAME("wm_sync")으로 옮기고
     *  옛 DB는 삭제한다. indexedDB.databases() 미지원 브라우저(Safari 구버전 등)는
     *  조용히 건너뛴다(잔여 DB가 있어도 정본 읽기/쓰기 경로엔 영향 없음 — DB_NAME만 참조). */
    async _migrateLegacyDb() {
      if (!("indexedDB" in window) || typeof indexedDB.databases !== "function") return;
      try {
        const dbs = await indexedDB.databases();
        if (!dbs.some(d => d && d.name === this.LEGACY_DB_NAME)) return; // 잔여 DB 없음 — 정상
        const ldb = await new Promise((res) => {
          const req = indexedDB.open(this.LEGACY_DB_NAME);
          req.onsuccess = () => res(req.result);
          req.onerror = () => res(null);
        });
        if (ldb) {
          const storeNames = Array.from(ldb.objectStoreNames || []);
          for (const sn of storeNames) {
            let rows = [];
            try {
              rows = await new Promise((res) => {
                const tx = ldb.transaction(sn, "readonly");
                const rq = tx.objectStore(sn).getAll();
                rq.onsuccess = () => res(rq.result || []);
                rq.onerror = () => res([]);
              });
            } catch (e) {}
            if (rows.length) {
              const db = await this._open();
              if (db && db.objectStoreNames.contains(sn)) {
                try {
                  await new Promise((res) => {
                    const tx = db.transaction(sn, "readwrite");
                    rows.forEach(r => { try { tx.objectStore(sn).put(r); } catch (e) {} });
                    tx.oncomplete = res; tx.onerror = res;
                  });
                  console.warn("[SyncQueue] 잔여 DB(" + this.LEGACY_DB_NAME + ") " + sn + " " + rows.length + "건 → " + this.DB_NAME + " 이관");
                } catch (e) {}
              }
            }
          }
          try { ldb.close(); } catch (e) {}
        }
        // 이관 완료(또는 애초에 비어있었음) → 잔여 DB 삭제
        await new Promise((res) => {
          const del = indexedDB.deleteDatabase(this.LEGACY_DB_NAME);
          del.onsuccess = res; del.onerror = res; del.onblocked = res;
        });
      } catch (e) { /* 정리 실패해도 정본 DB_NAME 경로는 영향 없음 */ }
    },

    /** 재연동 시퀀스 — 첨부 동기화 + 핀ID 치환 + 도면 draft 서버반영을 순서대로 */
    async _onReconnect() {
      if (this._reconnecting) return; this._reconnecting = true;
      try {
        const r = await this.flush();
        // map 이 있으면(0건이어도) 핀의 pendingOpId → 서버 imageId/docId 치환
        if (r && r.map && typeof App !== "undefined" && App._onSyncDone) App._onSyncDone(r);
        // 오프라인 중 저장된 도면 draft 를 서버에 반영(낙관적 잠금 base_version 포함)
        if (typeof App !== "undefined" && App._flushDirtyDrafts) {
          try { await App._flushDirtyDrafts(); } catch (e) {}
        }
        // [오프라인 작업지시서 ] 오프라인 op 로그 replay(충돌없는 엔티티 병합)
        if (typeof App !== "undefined" && App._flushOpLogs) {
          try { await App._flushOpLogs(); } catch (e) {}
        }
        // 재연동 토스트(대기 항목이 실제로 있었을 때만)
        if (r && (r.uploaded > 0) && typeof Prompt !== "undefined" && Prompt.toast) {
          Prompt.toast("온라인 복구 — 오프라인 변경 " + r.uploaded + "건 동기화 완료");
        }
      } finally { this._reconnecting = false; this._emit(); }
    }
  };

  /* 파일 종류 헬퍼 — 아이콘/라벨용 */
  function docKind(nameOrMime) {
    const s = (nameOrMime || "").toLowerCase();
    if (/\.pdf|pdf/.test(s)) return { type: "pdf", label: "PDF", color: "#f87171" };
    if (/\.docx?|word|officedocument\.wordprocessing|msword/.test(s)) return { type: "word", label: "WORD", color: "#60a5fa" };
    if (/\.xlsx?|sheet|excel/.test(s)) return { type: "excel", label: "XLS", color: "#34d399" };
    if (/\.pptx?|presentation|powerpoint/.test(s)) return { type: "ppt", label: "PPT", color: "#fb923c" };
    if (/\.txt|text\/plain/.test(s)) return { type: "txt", label: "TXT", color: "#cbd5e1" };
    if (/\.(png|jpe?g|gif|webp|bmp)|^image\//.test(s)) return { type: "img", label: "IMG", color: "#a78bfa" };
    return { type: "file", label: "FILE", color: "#94a3b8" };
  }
  function fmtBytes(n) {
    if (!n) return "";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
    return (n / 1024 / 1024).toFixed(1) + " MB";
  }

  /* ══════════════════════════════════════════
     PANO VIEWER  — Three.js WebGL (고속)
  ══════════════════════════════════════════ */
  const PanoViewer = {
    S: { lon: 0, lat: 0, fov: 75, dragging: false, lx: 0, ly: 0, autoRotate: false, roll: 0 },
    renderer: null, scene: null, camera: null, mesh: null, texture: null,
    videoEl: null, rafId: null, canvas: null, open: false, _currentPin: null,
    _dragSpotId: null, // [마스터: 마커 드래그] 현재 끌고 있는 spot.id (null이면 카메라 드래그)
    _dragOrigLL: null, _dragArrow: null, _dragArrowActive: false, // [마스터: 이동 화살표] 드래그 시작 lon/lat, 화살표 3D 오브젝트, 활성 플래그

    init(canvas) { this.canvas = canvas; },

    /** 확장자/MIME으로 360° 영상 여부 판단 후 적절한 로더 호출 */
    loadMedia(src, locationName, isVideo) {
      if (typeof Log !== "undefined") Log.push("pano.open", null, { name: locationName || "" });
      const looksVideo = isVideo === true ||
        (typeof src === "string" && /\.(mp4|webm|mov)(\?|#|$)/i.test(src));
      if (looksVideo) this.loadVideo(src, locationName);
      else this.load(src, locationName);
    },

    _ensureGL() {
      if (this.renderer) return true;
      if (!window.THREE) return false;
      try {
        this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        this.scene  = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 1100);
        const geo = new THREE.SphereGeometry(500, 60, 40);
        geo.scale(-1, 1, 1); // 구 내부에서 보기
        this.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x000000 }));
        this.scene.add(this.mesh);
        return true;
      } catch (e) { this.renderer = null; return false; }
    },

    load(src, locationName) {
      const $ = id => document.getElementById(id);
      this.S = { lon: 0, lat: 0, fov: 75, dragging: false, lx: 0, ly: 0, autoRotate: false, roll: 0 };

      $("pano-location-name").textContent = "360° — " + locationName;
      $("pano-loading").classList.remove("hidden");
      $("pano-error").classList.add("hidden");
      $("pano-canvas").classList.add("hidden");
      $("pano-hint").classList.add("hidden");
      $("pano-controls").classList.add("hidden");
      $("pano-overlay").classList.remove("hidden");
      this.open = true;

      if (!this._ensureGL()) {
        this._showError(src, "WebGL을 사용할 수 없는 환경입니다");
        return;
      }

      const img = new Image();
      // [핵심 버그 수정] crossOrigin 은 "외부 http(s) 출처" 일 때만 설정.
      //   data:/blob:/same-origin 에 crossOrigin="anonymous" 를 붙이면 일부 모바일
      //   브라우저가 WebGL 텍스처 보안정책으로 onerror 처리 → "이미지를 불러올 수 없습니다".
      if (/^https?:\/\//i.test(src) && !src.startsWith(location.origin)) {
        img.crossOrigin = "anonymous";
      }
      img.onload = () => {
        if (!this.open) return;
        this.isVideo = false; // 정지 이미지 → 온디맨드 렌더
        if (this.texture) this.texture.dispose();
        this.texture = new THREE.Texture(img);
        this.texture.needsUpdate = true;
        this.texture.minFilter = THREE.LinearFilter;
        this.mesh.material.dispose();
        this.mesh.material = new THREE.MeshBasicMaterial({ map: this.texture });

        $("pano-loading").classList.add("hidden");
        $("pano-canvas").classList.remove("hidden");
        $("pano-hint").classList.remove("hidden");
        $("pano-controls").classList.remove("hidden");
        this._resize();
        this._startLoop();
        // [마스터: 자동 수평] GPano 메타데이터가 있으면 천정 기울기 자동 보정(없으면 무동작)
        this._applyGPanoLevel(src);
        // [마스터: 구면 마커] 이 핀에 저장된 360 안 마커 렌더
        if (this._currentPin) this.renderSpots(this._currentPin.spots || []);
      };
      img.onerror = () => {
        const isExternal = /^https?:\/\//i.test(src) && !src.startsWith(location.origin);
        this._showError(src, isExternal
          ? "외부 이미지 로드 실패 — CORS 차단 또는 잘못된 URL"
          : "이미지를 불러올 수 없습니다");
        if (isExternal) {
          const hint = document.querySelector("#pano-error .pano-error-hint");
          if (hint) hint.textContent =
            "이 이미지 서버가 외부 접근(CORS)을 막고 있습니다. " +
            "편집모드에서 '그림 파일 선택'으로 직접 업로드하면 클라우드 저장되어 항상 표시됩니다.";
        }
      };
      img.src = (typeof Auth !== "undefined" && Auth.r2) ? Auth.r2(src) : src;
    },

    /** Ricoh THETA 등 360° equirectangular .mp4 → VideoTexture (GPU) */
    loadVideo(src, locationName) {
      const $ = id => document.getElementById(id);
      this.S = { lon: 0, lat: 0, fov: 75, dragging: false, lx: 0, ly: 0, autoRotate: false, roll: 0 };

      $("pano-location-name").textContent = "360° ▶ " + locationName;
      $("pano-loading").classList.remove("hidden");
      $("pano-error").classList.add("hidden");
      $("pano-canvas").classList.add("hidden");
      $("pano-hint").classList.add("hidden");
      $("pano-controls").classList.add("hidden");
      $("pano-overlay").classList.remove("hidden");
      this.open = true;

      if (!this._ensureGL()) { this._showError(src, "WebGL을 사용할 수 없는 환경입니다"); return; }

      this._disposeVideo();
      const video = document.createElement("video");
      video.crossOrigin = "anonymous";
      video.loop = true;
      video.muted = true;          // 자동재생 정책 충족
      video.playsInline = true;
      video.setAttribute("playsinline", "");
      video.setAttribute("webkit-playsinline", "");
      this.videoEl = video;

      video.addEventListener("loadeddata", () => {
        if (!this.open) return;
        this.isVideo = true; // 영상 → 매 프레임 렌더
        if (this.texture) this.texture.dispose();
        this.texture = new THREE.VideoTexture(video);
        this.texture.minFilter = THREE.LinearFilter;
        this.texture.magFilter = THREE.LinearFilter;
        this.mesh.material.dispose();
        this.mesh.material = new THREE.MeshBasicMaterial({ map: this.texture });

        $("pano-loading").classList.add("hidden");
        $("pano-canvas").classList.remove("hidden");
        $("pano-hint").classList.remove("hidden");
        $("pano-controls").classList.remove("hidden");
        this._resize();
        this._startLoop();
        video.play().catch(() => {/* 사용자 제스처 후 재생됨 */});
      }, { once: true });
      video.addEventListener("error", () => this._showError(src, "360° 영상을 불러올 수 없습니다 (코덱/CORS 확인)"));

      video.src = (typeof Auth !== "undefined" && Auth.r2) ? Auth.r2(src) : src;
      video.load();
    },

    _disposeVideo() {
      if (this.videoEl) {
        try { this.videoEl.pause(); } catch (e) {}
        this.videoEl.removeAttribute("src");
        this.videoEl.load && this.videoEl.load();
        this.videoEl = null;
      }
    },

    _showError(url, msg) {
      const $ = id => document.getElementById(id);
      $("pano-loading").classList.add("hidden");
      $("pano-error").classList.remove("hidden");
      $("pano-error").querySelector(".pano-error-msg").textContent = msg;
      $("pano-error-url").textContent = (url || "").slice(0, 120);
    },

    _resize() {
      if (!this.renderer) return;
      let W = window.innerWidth, H = window.innerHeight;
      if (!W || !H) { W = 1280; H = 720; }   // [견고화] 0크기(레이아웃 전) → aspect NaN/레이캐스트 깨짐 방지
      this.renderer.setSize(W, H, false);
      this.camera.aspect = W / H;
      this.camera.updateProjectionMatrix();
      this._invalidate();
    },

    _startLoop() {
      cancelAnimationFrame(this.rafId);
      this._dirty = true; // 첫 프레임은 반드시 렌더
      if (!this._tgt) this._tgt = new THREE.Vector3(); // 재사용(매 프레임 GC 방지)
      const loop = () => {
        if (!this.open) return;
        // 자동회전/영상은 매 프레임 갱신, 그 외엔 변경(_dirty) 있을 때만 렌더 → CPU/GPU 절약 = 빠름
        if (this.S.autoRotate && !this.S.dragging) { this.S.lon += 0.06; this._dirty = true; }
        if (this.isVideo) this._dirty = true;
        if (this._dirty) { this._renderFrame(); this._dirty = false; }
        this.rafId = requestAnimationFrame(loop);
      };
      loop();
    },

    _invalidate() { this._dirty = true; },

    _renderFrame() {
      if (!this.renderer) return;
      const S = this.S;
      // [마스터: 360 회전 시 옆으로 비틀어짐] 이미지 천정(zenith)이 기울어진 파노라마를
      //   수평 보정 — 구 메쉬를 카메라 전방축 기준 roll 회전(고정 월드 보정 → 모든 yaw에서 수평 유지).
      if (this.mesh) this.mesh.rotation.x = THREE.MathUtils.degToRad(S.roll || 0);
      S.lat = Math.max(-85, Math.min(85, S.lat));
      const phi   = THREE.MathUtils.degToRad(90 - S.lat);
      const theta = THREE.MathUtils.degToRad(S.lon);
      const t = this._tgt || (this._tgt = new THREE.Vector3());
      t.set(
        500 * Math.sin(phi) * Math.cos(theta),
        500 * Math.cos(phi),
        500 * Math.sin(phi) * Math.sin(theta)
      );
      this.camera.lookAt(t);
      this.camera.fov = S.fov;
      this.camera.updateProjectionMatrix();
      this.renderer.render(this.scene, this.camera);
      // 레이더 부채꼴을 현재 시야(yaw=lon)에 맞춰 회전
      Radar.spin(S.lon, S.fov);
    },

    /* ── 컨트롤 ── */
    setFov(delta) { this.S.fov = Math.max(30, Math.min(110, this.S.fov + delta)); this._invalidate(); },
    resetView()   { this.S.lon = 0; this.S.lat = 0; this.S.fov = 75; this.S.roll = 0; this._invalidate(); },
    /** [FARO Markers] 특정 마커(lon/lat)로 시점을 부드럽게 이동(최단 회전 경로) */
    lookAtSpot(lon, lat) {
      const startLon = this.S.lon, startLat = this.S.lat;
      const dLon = ((lon - (startLon % 360)) + 540) % 360 - 180;
      const tLat = Math.max(-85, Math.min(85, lat || 0));
      const t0 = performance.now(), dur = 500;
      if (this._spotRaf) cancelAnimationFrame(this._spotRaf);
      const step = (now) => {
        const k = Math.min(1, (now - t0) / dur);
        const e = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        this.S.lon = startLon + dLon * e;
        this.S.lat = startLat + (tLat - startLat) * e;
        this._invalidate();
        if (k < 1) this._spotRaf = requestAnimationFrame(step);
      };
      this._spotRaf = requestAnimationFrame(step);
    },
    /** [P23: 마커목록 사진별] 전체 핀 배열 → "사진(핀) 단위" 그룹으로 묶고 정렬.
     *  - 현재 사진(currentPin)은 항상 맨 앞(스팟이 0개여도 포함 — 빈 상태를 정직하게 보여주기 위함).
     *  - 다른 사진은 "마커가 있는 핀만" 포함(마커 0개인 핀은 목록 자체가 무의미하므로 제외),
     *    label(없으면 id) 오름차순 정렬.
     *  App.renderSpotList()가 이 결과로 그룹 렌더 + 행 클릭 시 spotRowAction()을 호출하는 용도.
     *  (렌더 자체는 20_App.js 소관이라 이 함수는 순수 데이터만 만든다.) */
    buildSpotGroups(pins, currentPin) {
      const list = Array.isArray(pins) ? pins : [];
      const cur = currentPin || null;
      const groups = [];
      if (cur) groups.push({ pin: cur, spots: Array.isArray(cur.spots) ? cur.spots : [], isCurrent: true });
      const others = list.filter((p) => p && p !== cur && (!cur || p.id !== cur.id) &&
        Array.isArray(p.spots) && p.spots.length > 0);
      others.sort((a, b) => String(a.label || a.id || "").localeCompare(String(b.label || b.id || ""), "ko"));
      others.forEach((p) => groups.push({ pin: p, spots: p.spots, isCurrent: false }));
      return groups;
    },
    /** [P23] 마커 목록 행 클릭 → 어떤 동작을 해야 하는지 결정(순수 함수, 부수효과 없음).
     *  - 같은 사진(그룹)의 마커: 그 마커로 시점 이동(기존 lookAtSpot 재사용) → {type:'look', lon, lat}
     *  - 다른 사진(그룹): 그 사진으로 이동(기존 App.openPano 재사용) → {type:'openPano', pin}
     *  실제 이동 호출은 배선하는 쪽(App.renderSpotList)이 이 반환값을 보고 수행한다. */
    spotRowAction(group, spot) {
      if (!group) return null;
      if (group.isCurrent) {
        if (!spot) return null;
        return { type: "look", lon: spot.lon, lat: spot.lat };
      }
      return { type: "openPano", pin: group.pin };
    },
    /** [마스터: 수평 보정] 천정 기울기 보정 — roll 을 deg 만큼 가감(한계 ±20°). */
    // [토스트 스팸 제거] ↺/↻ 는 0.7°씩 연타하는 버튼이라 클릭마다 토스트가 쌓였다.
    // 보정 결과는 화면이 기울어지는 것으로 즉시 보이므로 토스트 불필요.
    adjustRoll(deg) { this.S.roll = Math.max(-20, Math.min(20, (this.S.roll || 0) + deg)); this._invalidate(); },

    /** [마스터: 360 자동 수평] THETA 등이 JPEG XMP(GPano:PoseRollDegrees)에 박는 천정 기울기를
     *  읽어 자동으로 수평 보정. 메타데이터가 없으면 아무것도 하지 않음(안전). 수동 버튼으로 덮어쓸 수 있음. */
    async _applyGPanoLevel(src) {
      try {
        let bytes;
        if (typeof src === "string" && src.indexOf("data:") === 0) {
          const b64 = src.split(",")[1] || ""; const bin = atob(b64); const n = bin.length;
          bytes = new Uint8Array(n); for (let i = 0; i < n; i++) bytes[i] = bin.charCodeAt(i);
        } else if (typeof src === "string") {
          const r = await fetch(src); bytes = new Uint8Array(await r.arrayBuffer());
        } else { return; }
        const lim = Math.min(bytes.length, 300000); // XMP 는 보통 파일 앞부분
        const text = new TextDecoder("latin1").decode(bytes.subarray(0, lim));
        const m = text.match(/PoseRollDegrees\s*[=>]\s*["']?\s*(-?\d+(?:\.\d+)?)/);
        if (m) {
          const roll = parseFloat(m[1]);
          if (isFinite(roll) && Math.abs(roll) > 0.05 && Math.abs(roll) <= 20) {
            this.S.roll = -roll;   // 카메라 roll 의 역 → 수평 복원
            this._invalidate();
            if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("자동 수평 보정 적용 (" + roll.toFixed(1) + "°) — 하단 ↺/↻로 미세조정");
          }
        }
      } catch (e) { /* 파싱 실패 시 무시(수동 보정 사용) */ }
    },
    /** ISO 코너 뷰: 4개 모서리(꼭지점) 시점으로 전환. corner 0~3 = 좌상/우상/우하/좌하 느낌.
     *  부드러운 전환을 위해 목표각으로 애니메이션 보간. */
    setIsoView(corner) {
      // 4개 꼭지점 방위각(yaw): 45/135/225/315°, 약간 내려보는 피치(-28°)로 등각 느낌
      const yaws = [45, 135, 225, 315];
      const c = ((corner % 4) + 4) % 4;
      this._isoCorner = c;
      const targetLon = yaws[c];
      const targetLat = -28;
      const targetFov = 82; // 등각투상 느낌의 약간 넓은 화각
      // 현재값 → 목표값 부드럽게(최단 회전 경로)
      const startLon = this.S.lon, startLat = this.S.lat, startFov = this.S.fov;
      let dLon = ((targetLon - (startLon % 360)) + 540) % 360 - 180;
      const t0 = performance.now(), dur = 480;
      if (this._isoRaf) cancelAnimationFrame(this._isoRaf);
      const step = (now) => {
        const k = Math.min(1, (now - t0) / dur);
        const e = k < .5 ? 2*k*k : 1-Math.pow(-2*k+2,2)/2; // easeInOutQuad
        this.S.lon = startLon + dLon * e;
        this.S.lat = startLat + (targetLat - startLat) * e;
        this.S.fov = startFov + (targetFov - startFov) * e;
        this._invalidate();
        if (k < 1) this._isoRaf = requestAnimationFrame(step);
      };
      this._isoRaf = requestAnimationFrame(step);
      return c;
    },
    toggleAuto()  { this.S.autoRotate = !this.S.autoRotate; this._invalidate(); return this.S.autoRotate; },

    /** [마스터: 마커 드래그] 편집 권한 + 디자이너 모드일 때만 마커 이동 허용(뷰어는 종전대로 탭=열기만) */
    canEditSpots() {
      return typeof State !== "undefined" && State.mode === "designer" &&
        (typeof Auth === "undefined" || Auth.isDesigner);
    },
    onPointerDown(x, y) {
      this._downX = x; this._downY = y; this._moved = false;
      const hitId = this.canEditSpots() ? this.hitSpotAt(x, y) : null;
      this._dragSpotId = hitId || null;
      if (hitId) {
        // 마커를 잡은 동안엔 카메라가 회전하면 안 됨
        this.S.dragging = false;
        if (this.canvas) this.canvas.style.cursor = "grabbing";
        // [마스터: 이동 화살표] 원래 위치 기억(화살표 시작점) — moveSpot이 spot 데이터를 그 자리에서
        // 바꿔버리므로 드래그 시작 시점의 lon/lat을 별도로 떠 둔다.
        const data = (this._spots || []).find(s => s.id === hitId);
        this._dragOrigLL = data ? { lon: data.lon || 0, lat: data.lat || 0 } : null;
      } else {
        this.S.dragging = true; this.S.lx = x; this.S.ly = y;
      }
    },
    onPointerMove(x, y) {
      if (this._dragSpotId) {
        if (!this._moved && Math.hypot(x - (this._downX || x), y - (this._downY || y)) > 6) {
          this._moved = true;
          this._dragArrowActive = true;
          if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("마커 이동 중 — 놓으면 저장됩니다");
        }
        const ll = this.screenToLonLat(x, y);
        if (ll) {
          this.moveSpot(this._dragSpotId, ll.lon, ll.lat);
          // 전체 재생성 없이 화살표 오브젝트 1개만 갱신(성능 원칙 — moveSpot과 동일)
          if (this._moved && this._dragOrigLL) this._updateDragArrow(this._dragOrigLL, ll);
        }
        return;
      }
      if (!this.S.dragging) return;
      if (Math.hypot(x - (this._downX || x), y - (this._downY || y)) > 6) this._moved = true;
      const k = this.S.fov / 500; // FOV 비례 감도
      this.S.lon += (this.S.lx - x) * k;
      this.S.lat += (y - this.S.ly) * k;
      this.S.lx = x; this.S.ly = y;
      this._invalidate();
    },
    /** 포인터를 뗐을 때: 마커를 실제로 옮겼으면 { spotMoved:id } 반환(호출부가 저장 확정), 아니면 null */
    onPointerUp() {
      this.S.dragging = false;
      const draggedId = this._dragSpotId;
      this._dragSpotId = null;
      this._dragOrigLL = null;
      this._dragArrowActive = false;
      if (this._dragArrow) this._dragArrow.visible = false;
      if (this.canvas) this.canvas.style.cursor = "";
      return (draggedId && this._moved) ? { spotMoved: draggedId } : null;
    },
    /** 마지막 포인터 동작이 '탭'(드래그 아님)이었나 */
    wasTap() { return !this._moved; },

    /* ══════════════════════════════════════════
       [마스터: 구면 안 마커] 360 사진 속 특정 지점(결함/장비/이동)에 핀 — Three.js Sprite 레이어
       · 핀의 spots[{id,lon,lat,label,note,kind}] 를 구면 방향에 빌보드 마커로 렌더.
       · 화면 탭 → 레이캐스트로 (lon,lat) 산출(추가) 또는 마커 적중판정(열기).
    ══════════════════════════════════════════ */
    _ensureSpotGroup() {
      if (!this._spotGroup && this.scene) { this._spotGroup = new THREE.Group(); this.scene.add(this._spotGroup); }
      return this._spotGroup;
    },
    _spotPos(lon, lat, R) {
      const phi = THREE.MathUtils.degToRad(90 - lat), theta = THREE.MathUtils.degToRad(lon);
      return new THREE.Vector3(R * Math.sin(phi) * Math.cos(theta), R * Math.cos(phi), R * Math.sin(phi) * Math.sin(theta));
    },
    // [마스터: 마커 투명화] 채움 알파를 낮춰 뒤 사진이 비치게 하되, 숫자는 검은 헤일로(외곽선)로
    // 감싸 어떤 배경 위에서도 대비를 보장한다(배경 사진 색과 무관 — 헤일로 자체가 로컬 배경 역할).
    SPOT_FILL_ALPHA: .42,
    _spotTexture(spot, idx) {
      const c = document.createElement("canvas"); c.width = c.height = 128;
      const g = c.getContext("2d");
      const col = { defect: "#e0503e", equip: "#e0b14a", safety: "#f2820a", note: "#3a97dd", nav: "#3a97dd" }[spot.kind] || "#e0503e"; // 결함/장비/안전/메모/이동
      g.beginPath(); g.arc(64, 64, 40, 0, Math.PI * 2); g.fillStyle = col; g.globalAlpha = this.SPOT_FILL_ALPHA; g.fill(); g.globalAlpha = 1;
      g.lineWidth = 6; g.strokeStyle = "rgba(255,255,255,.9)"; g.stroke();
      g.font = "bold 52px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
      const label = spot.kind === "nav" ? "" : String(idx + 1);
      g.lineWidth = 8; g.lineJoin = "round"; g.strokeStyle = "rgba(0,0,0,.9)"; g.strokeText(label, 64, 70);
      g.fillStyle = "#fff"; g.fillText(label, 64, 70);
      const t = new THREE.CanvasTexture(c); t.needsUpdate = true; return t;
    },
    renderSpots(spots) {
      const grp = this._ensureSpotGroup(); if (!grp) return;
      while (grp.children.length) { const ch = grp.children.pop(); if (ch.material) { if (ch.material.map) ch.material.map.dispose(); ch.material.dispose(); } }
      this._spots = Array.isArray(spots) ? spots : [];
      this._spots.forEach((s, i) => {
        const mat = new THREE.SpriteMaterial({ map: this._spotTexture(s, i), depthTest: false, depthWrite: false, transparent: true });
        const sp = new THREE.Sprite(mat);
        sp.position.copy(this._spotPos(s.lon || 0, s.lat || 0, 470));
        sp.scale.set(34, 34, 1);
        sp.userData.spotId = s.id;
        sp.renderOrder = 10;
        grp.add(sp);
      });
      this._invalidate();
    },
    _ndc(clientX, clientY) {
      const rect = this.canvas.getBoundingClientRect();
      return new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    },
    /** 화면 좌표 → 구면 방향(lon,lat) — 마커 추가용 */
    screenToLonLat(clientX, clientY) {
      if (!this.renderer || !this.camera) return null;
      const rc = new THREE.Raycaster(); rc.setFromCamera(this._ndc(clientX, clientY), this.camera);
      const d = rc.ray.direction.clone().normalize();
      const lat = 90 - THREE.MathUtils.radToDeg(Math.acos(Math.max(-1, Math.min(1, d.y))));
      const lon = THREE.MathUtils.radToDeg(Math.atan2(d.z, d.x));
      return { lon, lat };
    },
    /** 화면 좌표에 마커가 있으면 그 spotId, 없으면 null */
    hitSpotAt(clientX, clientY) {
      if (!this._spotGroup || !this.camera || !this._spotGroup.children.length) return null;
      const rc = new THREE.Raycaster(); rc.setFromCamera(this._ndc(clientX, clientY), this.camera);
      const hits = rc.intersectObjects(this._spotGroup.children, false);
      return hits.length ? hits[0].object.userData.spotId : null;
    },
    /** [마스터: 마커 드래그] 전체 재생성 없이 스프라이트 1개 position만 갱신(드래그 중 매 프레임 호출).
     *  spot 데이터(this._spots — pin.spots 와 동일 참조)의 lon/lat 도 그 자리에서 갱신해
     *  드래그 종료 시 별도 반영 없이 그대로 저장할 수 있게 한다. */
    moveSpot(id, lon, lat) {
      if (!this._spotGroup) return false;
      let sp = null;
      for (let i = 0; i < this._spotGroup.children.length; i++) {
        if (this._spotGroup.children[i].userData.spotId === id) { sp = this._spotGroup.children[i]; break; }
      }
      if (!sp) return false;
      sp.position.copy(this._spotPos(lon, lat, 470));
      const data = (this._spots || []).find(s => s.id === id);
      if (data) { data.lon = lon; data.lat = lat; }
      this._invalidate();
      return true;
    },
    /** [마스터: 이동 화살표] 드래그 중 "원래 위치 → 현재 위치" 화살표를 1개만 생성해 계속 재사용.
     *  THREE.ArrowHelper가 없는 환경(구형 THREE/목)에서는 조용히 no-op — 드래그 저장 동작에는 영향 없음. */
    _ensureDragArrow() {
      if (this._dragArrow) return this._dragArrow;
      if (!this.scene || typeof THREE === "undefined" || typeof THREE.ArrowHelper !== "function") return null;
      const arrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 0), 1, 0xffffff, 10, 6);
      arrow.visible = false;
      arrow.renderOrder = 20;
      this.scene.add(arrow);
      this._dragArrow = arrow;
      return arrow;
    },
    _updateDragArrow(origLL, curLL) {
      const arrow = this._ensureDragArrow(); if (!arrow) return;
      const from = this._spotPos(origLL.lon, origLL.lat, 470);
      const to = this._spotPos(curLL.lon, curLL.lat, 470);
      const dir = to.clone().sub(from);
      const len = dir.length();
      if (len < 0.01) { arrow.visible = false; return; }
      dir.normalize();
      arrow.position.copy(from);
      arrow.setDirection(dir);
      arrow.setLength(len, Math.min(24, len * 0.35), Math.min(14, len * 0.25));
      arrow.visible = true;
    },
    onWheel(e)    { e.preventDefault(); this.setFov(e.deltaY * 0.05); },

    close() {
      this.open = false;
      this._currentPin = null;
      try { this.renderSpots([]); } catch (e) {}   // 구면 마커 정리
      this._spotAddMode = false;
      this._dragSpotId = null;
      this._dragOrigLL = null;
      this._dragArrowActive = false;
      if (this._dragArrow) this._dragArrow.visible = false;
      cancelAnimationFrame(this.rafId);
      this._disposeVideo();
      document.getElementById("pano-overlay").classList.add("hidden");
      const ip = document.getElementById("pano-info-panel");
      if (ip) { ip.classList.add("hidden"); ip.innerHTML = ""; }
      if (typeof Notes !== "undefined") Notes.closePanel();  // 노트 패널 함께 닫기
      if (typeof TimeLapse !== "undefined") TimeLapse.hide();
      if (typeof Compare !== "undefined") Compare.close();
      if (typeof FLS !== "undefined") FLS.close();  // FLS 3D 패널 함께 닫기
      const ov2 = document.getElementById("pano-overlay");
      if (ov2) ov2.classList.remove("with-fls");
      Radar.hide();
      PanoNav.hide();
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    }
  };

  /* ══════════════════════════════════════════
     RADAR — 파노라마 내 도면 미니맵 + 시야 부채꼴 (3DVista radar 참고)
  ══════════════════════════════════════════ */
  const Radar = {
    _pin: null,

    /** 현재 핀 기준으로 미니맵(도면 썸네일+핀들) 렌더 */
    update(pin) {
      this._pin = pin;
      const box = document.getElementById("pano-radar");
      if (!box) return;
      // [마스터 요청 N9] 미니맵 접기/펼치기 토글 (1회 바인딩)
      if (!this._toggleBound) {
        const tb = document.getElementById("pano-radar-toggle");
        if (tb) { tb.addEventListener("click", (e) => { e.stopPropagation(); box.classList.toggle("collapsed"); }); this._toggleBound = true; }
      }
      // [마스터 요청] 미니맵 크게 보기 토글 (1회 바인딩) — 크기만 전환, 기존 로직 그대로
      // [마스터 요청 "기본적으로 확대한 크기로 반영해"] 저장된 선택이 없으면 기본값=확대(large).
      // localStorage("wm-radar-large")에 사용자 선택을 저장/복원 — 없으면 true(확대).
      if (!this._largeInited) {
        this._largeInited = true;
        let storedLarge = true;
        try {
          const v = localStorage.getItem("wm-radar-large");
          if (v !== null) storedLarge = v === "1";
        } catch (e) { /* 사생활 모드 등 localStorage 접근 불가 → 기본값(확대) 유지 */ }
        box.classList.toggle("pano-radar-large", storedLarge);
        const eb0 = document.getElementById("pano-radar-expand");
        if (eb0) {
          eb0.classList.toggle("active", storedLarge);
          eb0.title = storedLarge ? "미니맵 작게 보기" : "미니맵 크게 보기";
        }
      }
      if (!this._expandBound) {
        const eb = document.getElementById("pano-radar-expand");
        if (eb) {
          eb.addEventListener("click", (e) => {
            e.stopPropagation();
            const large = box.classList.toggle("pano-radar-large");
            eb.classList.toggle("active", large);
            eb.title = large ? "미니맵 작게 보기" : "미니맵 크게 보기";
            try { localStorage.setItem("wm-radar-large", large ? "1" : "0"); } catch (e) {}
          });
          this._expandBound = true;
        }
      }
      // [마스터 요청] 미니맵에서 드래그로 직접 시야 방향(부채꼴) 조절 (1회 바인딩)
      if (!this._dirBound) {
        const db = document.getElementById("pano-radar-dir");
        const stage = document.getElementById("pano-radar-stage");
        if (db && stage) {
          db.addEventListener("click", (e) => {
            e.stopPropagation();
            if (this._dirAdjust) this.exitDirAdjustMode();
            else this.enterDirAdjustMode();
          });
          this._bindDirClick(stage, db, box);
          this._dirBound = true;
        }
      }
      // 현재 페이지의 도면 이미지 소스 확보 (뷰어/디자이너 공통)
      const mapSrc = (typeof Auth !== "undefined" && Auth.r2) ? Auth.r2(this._currentMapSrc()) : this._currentMapSrc();
      if (!mapSrc) { this.hide(); return; }

      const page = pin.page || 1;
      const imgEl = document.getElementById("pano-radar-map");
      if (imgEl && imgEl.src !== mapSrc) imgEl.src = mapSrc;
      const pageEl = document.getElementById("pano-radar-page");
      if (pageEl) pageEl.textContent = "p." + page;

      // 같은 페이지의 핀들을 점으로 표시
      const pinsLayer = document.getElementById("pano-radar-pins");
      if (pinsLayer) {
        pinsLayer.innerHTML = "";
        // 🔴 번호/부류/필터 정본 = PinSeries (01b_PinSeries.js).
        //    도면 마커(11_UI.renderPinsOnMap)와 같은 함수를 호출하므로 두 화면의 번호가 항상 일치한다.
        //    여기서 따로 세면 갈라진다(전역 CLAUDE.md §10 SoT).
        const numMap = PinSeries.numbers(State.pins, page);
        (State.pins || []).filter(p => (p.page || 1) === page).forEach(p => {
          // 표시 필터는 도면·미니맵에 동일 적용. 단, 지금 열람 중인 핀은 기준점이라 항상 표시.
          if (p.id !== pin.id && !PinSeries.isVisible(p)) return;
          const meta = numMap.get(p.id) || { no: 0, kind: PinSeries.kindOf(p) };
          // 🔴 색·형태 정본 = PinSeries.markerStyle — 도면 마커(11_UI)와 동일 함수.
          //    체크보드 핀의 사진 등록 여부를 미니맵에도 똑같이 반영한다.
          //    (한쪽만 반영하면 사용자에게 거짓말이 된다)
          const _st = PinSeries.markerStyle(p);
          const dot = document.createElement("div");
          dot.className = "pano-radar-pin pano-radar-pin-" + meta.kind + (p.id === pin.id ? " current" : "");
          dot.style.left = p.x + "%";
          dot.style.top  = p.y + "%";
          dot.title = p.label || "";
          dot.dataset.id = p.id;      // 도면 마커(.pin-marker[data-id])와 동일 식별자 — 번호 일치 검증 가능
          dot.dataset.kind = meta.kind;
          dot.dataset.filled = _st.filled ? "1" : "0"; // 사진 등록 여부(도면 마커와 동일 판정)
          // 색상도 도면 마커와 같은 정본에서 파생(현재 핀은 gold 강조 유지 → 인라인 지정 안 함).
          // 점 위에 흰 숫자가 얹히므로 가장 어두운 톤(needle)을 쓴다 — 팔레트 6종 전부 8.96~13.0:1
          // (head2 를 쓰면 gold 가 4.46:1 로 본문 기준 4.5:1 미달).
          // 체크보드: 등록 #172554(14.69:1) / 미등록 #4f46e5(6.29:1) — 둘 다 흰 숫자 4.5:1 초과.
          if (p.id !== pin.id) dot.style.background = _st.colors.needle;
          // 형태 단서(색각 이상 대비): 도면 링 패턴과 같은 이름에서 파생한 테두리.
          // CSS 클래스(.pano-radar-pin-checkboard=dashed)만으로는 등록/미등록이 같아진다 → 인라인으로 덮어쓴다.
          dot.style.borderStyle = _st.border;
          dot.style.borderWidth = (_st.border === "solid") ? "1px" : "1.4px";
          const dispNo = meta.no;
          const no = document.createElement("span");
          no.className = "pano-radar-pin-no";
          no.textContent = dispNo;
          dot.appendChild(no);
          dot.addEventListener("click", (e) => {
            e.stopPropagation();
            if (this._dirAdjust) return; // 방향 조절 모드에서는 다른 핀 이동 금지
            if (p.id !== pin.id && App.pinHasContent(p)) App.openPano(p);
          });
          pinsLayer.appendChild(dot);
        });
      }
      // 시야 부채꼴을 현재 핀 위치로 이동
      const cone = document.getElementById("pano-radar-cone");
      if (cone) { cone.style.left = pin.x + "%"; cone.style.top = pin.y + "%"; }

      // [마스터 요청 #3] 핀이 영역(구역) 내부면 그 구역만 확대해서 미니맵 표시
      // + [마스터 요청 "포인트 클릭 → 하단 네비게이터에서 확대"] 사용자 콘텐츠 확대(1~6x)를
      //   기존 자동 프레이밍 위에 합성 — _applyTransform() 참조.
      if (!this._zoomBound) this._bindZoomControls();
      this._applyTransform();

      box.classList.remove("hidden");
    },

    /** 자동 프레이밍 배율/오프셋(s0,vx0,vy0) 계산 — 기존 로직 그대로(회귀 방지를 위해
     *  분리만 하고 산식은 변경하지 않았다). 구역 안이면 구역 bbox 기준, 아니면 핀 반경 기준. */
    _computeBaseView(pin, page) {
      let view = null;
      try {
        if (typeof Zones !== "undefined" && Zones._bbox) {
          // [N8] 핀↔구역 매칭: pinIds 명시적 링크 우선, 없으면 기하학적 포함 판정
          const z = (State.zones || []).find(zz => (zz.page || 1) === page && (
            (Array.isArray(zz.pinIds) && zz.pinIds.indexOf(pin.id) >= 0) ||
            (Zones._contains && Zones._contains(zz, pin.x, pin.y))
          ));
          if (z) {
            const bb = Zones._bbox(z), pad = 8;
            view = {
              x: Math.max(0, bb.x - pad), y: Math.max(0, bb.y - pad),
              w: Math.min(100, bb.w + pad * 2), h: Math.min(100, bb.h + pad * 2)
            };
          }
        }
      } catch (e) {}
      if (view && view.w > 3 && view.h > 3) {
        const s = Math.min(100 / view.w, 100 / view.h);   // 더 큰 축 기준 fit
        return { s, vx: view.x, vy: view.y };
      }
      // [마스터] 구역이 없어도 현재 핀 주변을 확대 — 전체 도면을 작게 보여주지 말고 항상 "크게"
      const r = 18;                                      // 핀 중심 ±18% (≈36% 영역)
      const vx = Math.max(0, Math.min(100 - r * 2, pin.x - r));
      const vy = Math.max(0, Math.min(100 - r * 2, pin.y - r));
      const s = 100 / (r * 2);
      return { s, vx, vy };
    },

    /** stage 에 최종 transform(scale+translate) 적용.
     *  zoom(this._zoom, 1~6)이 1이면 기존 자동 프레이밍(base)을 그대로 쓴다(회귀 없음).
     *  zoom>1이면 배율만 base*zoom으로 올리고, 오프셋은 "현재 핀이 항상 박스 정중앙"
     *  이 되도록 재계산한다 — CSS `scale(s) translate(tx%,ty%)`(우→좌 합성, translate가
     *  먼저 적용되고 이후 scale)에서 화면상 위치 = s*(pin - v) 이므로, 중앙(50%) 고정 조건
     *  s*(pin - v) = 50 을 풀면 v = pin - 50/s. 박스 크기(.pano-radar)는 절대 건드리지
     *  않는다 — 오직 stage(안쪽 콘텐츠) transform만 바뀐다. 패널은 overflow:hidden(CSS
     *  기존 규칙, style.css:1429/1449)이라 넘친 부분은 자동으로 잘린다. */
    _applyTransform() {
      const stage = document.getElementById("pano-radar-stage");
      const pin = this._pin;
      if (!stage || !pin) return;
      const page = pin.page || 1;
      const base = this._computeBaseView(pin, page);
      const zoom = this._zoom || 1;
      let s = base.s, vx = base.vx, vy = base.vy;
      if (zoom > 1.001) {
        s = base.s * zoom;
        vx = pin.x - 50 / s;
        vy = pin.y - 50 / s;
      }
      stage.style.transformOrigin = "0 0";
      stage.style.transform = "scale(" + s.toFixed(3) + ") translate(" + (-vx).toFixed(2) + "%, " + (-vy).toFixed(2) + "%)";
    },

    /** [마스터 요청] 미니맵 콘텐츠(도면) 확대 1~6x — +/− 버튼, 핀치 줌, 더블탭/더블클릭 리셋.
     *  세션 중(this._zoom)에만 유지 — localStorage 영속화 안 함(요구사항 YAGNI). */
    _bindZoomControls() {
      this._zoomBound = true;
      this._zoom = this._zoom || 1;
      const ZMIN = 1, ZMAX = 6, ZSTEP = 0.6;
      const clamp = (v) => Math.max(ZMIN, Math.min(ZMAX, v));
      const zin = document.getElementById("pano-radar-zoom-in");
      const zout = document.getElementById("pano-radar-zoom-out");
      const setZoom = (v) => {
        this._zoom = clamp(v);
        this._applyTransform();
        if (zin) zin.disabled = this._zoom >= ZMAX - 0.001;
        if (zout) zout.disabled = this._zoom <= ZMIN + 0.001;
      };
      if (zin) zin.addEventListener("click", (e) => { e.stopPropagation(); setZoom(this._zoom + ZSTEP); });
      if (zout) zout.addEventListener("click", (e) => { e.stopPropagation(); setZoom(this._zoom - ZSTEP); });

      const stage = document.getElementById("pano-radar-stage");
      if (!stage) return;
      // 더블클릭(데스크톱) → 1x 리셋
      stage.addEventListener("dblclick", (e) => { e.stopPropagation(); setZoom(1); });
      // 핀치 줌(터치) — 두 손가락 거리 변화만으로 배율 산정. 자유 패닝은 두지 않는다
      // (요구: "확대 시 현재 위치를 항상 중앙 유지" → _applyTransform이 매번 재계산하므로
      // 패닝 로직 자체가 불필요, YAGNI). 더블탭(300ms 이내 재탭)은 1x 리셋.
      // 🔴 stopPropagation으로 파노라마 본체의 회전/줌 제스처로 전파되지 않게 막는다.
      let pinchStartDist = null, pinchStartZoom = 1, lastTapT = 0;
      stage.addEventListener("touchstart", (e) => {
        if (e.touches.length === 2) {
          e.preventDefault(); e.stopPropagation();
          const [a, b] = e.touches;
          pinchStartDist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
          pinchStartZoom = this._zoom;
        } else if (e.touches.length === 1) {
          e.stopPropagation();
          const now = Date.now();
          if (now - lastTapT < 300) { e.preventDefault(); setZoom(1); }
          lastTapT = now;
        }
      }, { passive: false });
      stage.addEventListener("touchmove", (e) => {
        if (e.touches.length === 2 && pinchStartDist) {
          e.preventDefault(); e.stopPropagation();
          const [a, b] = e.touches;
          const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
          setZoom(pinchStartZoom * (d / pinchStartDist));
        }
      }, { passive: false });
      stage.addEventListener("touchend", (e) => {
        e.stopPropagation();
        if (e.touches.length < 2) pinchStartDist = null;
      }, { passive: true });
    },

    /** [마스터] 방향 지정 모드 진입 — #btn-pano-setdir(파노 컨트롤바) / #pano-radar-dir(미니맵) 공용 진입점.
     *  🔴 여기서는 "진입"만 한다 — 완료 토스트는 _commitAngle()에서 실제 클릭 확정 후에만 띄운다(조기 완료 선언 금지).
     *  미니맵이 없거나 아직 표시되지 않은 상태(핀을 안 열었음)면 클릭할 대상이 없으므로 조용히 실패하지 않고 사유를 알린다. */
    enterDirAdjustMode() {
      const box = document.getElementById("pano-radar");
      const stage = document.getElementById("pano-radar-stage");
      if (!box || !stage) {
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("미니맵을 표시할 수 없습니다");
        return false;
      }
      if (box.classList.contains("hidden")) {
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("먼저 핀을 열어 미니맵을 표시하세요");
        return false;
      }
      box.classList.remove("collapsed"); // 접혀 있으면 펼쳐서 클릭 대상 확보
      this._dirAdjust = true;
      const db = document.getElementById("pano-radar-dir");
      if (db) { db.classList.add("active"); db.title = "방향 조절 끄기"; }
      box.classList.add("dir-adjust-mode");
      if (typeof Prompt !== "undefined" && Prompt.toast) {
        Prompt.toast("도면에서 선수(오른쪽) 방향을 클릭하세요");
      }
      return true;
    },

    /** 방향 지정 모드 종료(사용자가 토글로 끔 — 클릭 확정 없이 취소) */
    exitDirAdjustMode() {
      this._dirAdjust = false;
      const box = document.getElementById("pano-radar");
      const db = document.getElementById("pano-radar-dir");
      if (db) { db.classList.remove("active"); db.title = "미니맵에서 방향 조절"; }
      if (box) box.classList.remove("dir-adjust-mode");
    },

    /** 시야 방향(yaw=lon) + FOV에 맞춰 부채꼴 회전/너비 */
    spin(lon, fov) {
      const fan = document.querySelector("#pano-radar-cone .pano-radar-fan");
      if (!fan) return;
      // lon(deg): 0 = +Z 방향. 360 사진마다 촬영 시작 방향(lon=0)이 제각각이라
      // 도면 위 "위(12시)"와 일치한다는 보장이 없음 — 핀별 보정값(dirOffset)으로 상쇄.
      // [마스터: 방향 설정] pin.dirOffset = 사용자가 도면 위쪽으로 지정한 순간의 lon 값.
      const offset = (this._pin && this._pin.dirOffset) || 0;
      const effectiveLon = lon - offset;
      // conic-gradient가 -35°~+35°(약 70°) 부채꼴이므로 회전만 적용.
      fan.style.transform = "rotate(" + (effectiveLon) + "deg)";
    },

    /** [마스터 요청] 미니맵 클릭 1회로 부채꼴(시야 방향) 즉시 보정 — "지금 보는 방향 = 여기" 클릭 */
    _bindDirClick(stage, db, box) {
      // 각도 규약: spin()과 동일 — 0deg=위(북,12시), 시계방향 +, 90deg=오른쪽(동).
      // 화면좌표 dx=오른쪽+, dy=아래쪽+ 이므로 atan2(dy,dx)는 "오른쪽=0,시계방향+" 기준각.
      // 그 기준각에 +90 하면 "위=0,시계방향+" 기준으로 정렬된다(우측 기준각 0→ +90=90, 상단 기준각 -90→ +90=0).
      const angleFromEvent = (e) => {
        const cone = document.getElementById("pano-radar-cone");
        const rect = cone.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const px = (e.touches && e.touches[0] ? e.touches[0].clientX : e.clientX);
        const py = (e.touches && e.touches[0] ? e.touches[0].clientY : e.clientY);
        const dx = px - cx, dy = py - cy;
        let a = Math.atan2(dy, dx) * 180 / Math.PI + 90;
        return ((a % 360) + 360) % 360;
      };
      stage.addEventListener("click", (e) => {
        if (!this._dirAdjust) return;
        e.preventDefault(); e.stopPropagation();
        this._commitAngle(angleFromEvent(e));
        // 클릭 1회로 완료 — 방향 조절 모드 자동 종료
        this.exitDirAdjustMode();
      });
    },

    /** 클릭 각도를 pin.dirOffset으로 환산해 즉시 저장 + 부채꼴 갱신(토스트 1회) */
    _commitAngle(angleDeg) {
      const pin = this._pin;
      if (!pin) return;
      const lon = (typeof PanoViewer !== "undefined" && PanoViewer.S) ? PanoViewer.S.lon : 0;
      // spin()의 effectiveLon = lon - dirOffset 이 angleDeg가 되도록 역산.
      pin.dirOffset = lon - angleDeg;
      const fan = document.querySelector("#pano-radar-cone .pano-radar-fan");
      if (fan) fan.style.transform = "rotate(" + angleDeg + "deg)";
      if (typeof App !== "undefined" && App._autoSave) App._autoSave();
      if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("시야 방향이 조정되었습니다");
    },

    /** 현재 표시 중인 도면(페이지) 이미지 src */
    _currentMapSrc() {
      // 뷰어 모드: 배포본 페이지 이미지
      if (State.mode === "viewer" && State.viewerPages && State.viewerPages.length) {
        const idx = (State.pdfPage || 1) - 1;
        return State.viewerPages[idx] || State.viewerPages[0] || null;
      }
      // 디자이너 모드: 이미지 도면이면 그대로
      const mapImg = document.getElementById("map-image");
      if (mapImg && !mapImg.classList.contains("hidden") && mapImg.src) return mapImg.src;
      // PDF → 미니맵 전용 고해상도 스냅샷 캐시 (페이지당 1회만 생성)
      // [마스터 지적] 화면표시용 #pdf-canvas(줌 배율에 따라 저해상도일 수 있음)를 그대로
      // 스냅샷하면 미니맵 확대(최대 3~5배)에서 블록/모자이크로 깨짐 → 별도 고해상도 오프스크린
      // 렌더링(page.render, 화면 캔버스와 무관)으로 대체. 기존 _pdfCache 캐싱 구조는 그대로 재사용.
      const pdfCanvas = document.getElementById("pdf-canvas");
      if (pdfCanvas && !pdfCanvas.classList.contains("hidden")) {
        try {
          const pageNum = State.pdfPage || 1;
          const key = "p" + pageNum;
          this._pdfCache = this._pdfCache || {};
          if (this._pdfCache[key]) return this._pdfCache[key];
          this._buildHiResSnapshot(pageNum, key); // 비동기 생성 → 완료 시 미니맵에 자동 반영
          return pdfCanvas.toDataURL("image/jpeg", 0.85); // 생성 완료 전 임시 표시(빈 미니맵 방지)
        } catch (e) { return null; }
      }
      return null;
    },

    /** 미니맵 전용 고해상도 PDF 스냅샷을 오프스크린에서 새로 래스터화(화면용 #pdf-canvas 미변경).
     *  긴 변 ≈2400px(최대 3배)로 렌더 → 미니맵 5배 확대에도 선명. 완료되면 _pdfCache에 저장하고,
     *  아직 같은 페이지를 보고 있으면 <img>를 즉시 교체한다. */
    async _buildHiResSnapshot(pageNum, key) {
      if (this._pdfCache[key] || this._buildingKey === key) return;
      if (typeof State === "undefined" || !State.pdfDoc) return;
      this._buildingKey = key;
      try {
        const page = await State.pdfDoc.getPage(pageNum);
        const rot = ((page.rotate || 0) + (State.pdfRotation || 0)) % 360;
        const base = page.getViewport({ scale: 1, rotation: rot });
        const scale = Math.min(2400 / Math.max(base.width, base.height), 3);
        const vp = page.getViewport({ scale, rotation: rot });
        const cv = document.createElement("canvas");
        cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
        const ctx = cv.getContext("2d", { alpha: false });
        ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, cv.width, cv.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        this._pdfCache[key] = cv.toDataURL("image/jpeg", 0.85);
        if ((State.pdfPage || 1) === pageNum) {
          const imgEl = document.getElementById("pano-radar-map");
          if (imgEl) {
            const src = this._pdfCache[key];
            imgEl.src = (typeof Auth !== "undefined" && Auth.r2) ? Auth.r2(src) : src;
          }
        }
      } catch (e) { /* 실패 시 임시(저해상도) 스냅샷 유지 */ }
      this._buildingKey = null;
    },

    hide() { const b = document.getElementById("pano-radar"); if (b) b.classList.add("hidden"); }
  };

  /* ══════════════════════════════════════════
     PANO NAV — 파노라마 내 이전/다음 포인트 이동 (탐색 핫스팟)
  ══════════════════════════════════════════ */
  const PanoNav = {
    _list: [], _idx: -1,

    init() {
      const $ = (id) => document.getElementById(id);
      $("btn-pano-prev") && $("btn-pano-prev").addEventListener("click", () => this.go(-1));
      $("btn-pano-next") && $("btn-pano-next").addEventListener("click", () => this.go(1));
    },

    /** 현재 핀 기준으로 같은 페이지의 "콘텐츠 있는" 핀 목록 + 위치 갱신 */
    update(pin) {
      const page = pin.page || 1;
      this._list = (State.pins || [])
        .filter(p => (p.page || 1) === page && App.pinHasContent(p));
      this._idx = this._list.findIndex(p => p.id === pin.id);
      const box = document.getElementById("pano-nav");
      if (!box) return;
      if (this._list.length <= 1) { box.classList.add("hidden"); return; }
      box.classList.remove("hidden");
      const label = document.getElementById("pano-nav-label");
      if (label) label.textContent = (this._idx + 1) + " / " + this._list.length;
      const prev = document.getElementById("btn-pano-prev");
      const next = document.getElementById("btn-pano-next");
      if (prev) prev.disabled = this._idx <= 0;
      if (next) next.disabled = this._idx >= this._list.length - 1;
    },

    go(delta) {
      const ni = this._idx + delta;
      if (ni < 0 || ni >= this._list.length) return;
      const target = this._list[ni];
      if (target) App.openPano(target);
    },

    hide() { const b = document.getElementById("pano-nav"); if (b) b.classList.add("hidden"); }
  };

  /* ══════════════════════════════════════════
     FLS — FARO 포인트 클라우드(LiDAR) 직접 로드/표출 (Three.js)
       · 표준 포맷(.ply/.pcd/.xyz/.pts/.las/.laz) → 브라우저에서 100% 직접 파싱·렌더
       · .fls(FARO 독점) → 헤더 best-effort + 변환 안내 (FARO SCENE → e57/las)
       · 360 파노라마와 나란히(split) 표시. 안정성 최우선: 점 개수 상한·다운샘플.
  ══════════════════════════════════════════ */
  const FLS = {
    MAX_POINTS: 1_800_000,     // 렌더 안정 상한 (초과 시 균등 다운샘플)
    // [정본] E57 대용량 메모리 가드 — 실측(커밋 017e532, build-tools/e57-realfile-check.mjs):
    //   PANOPI_Panopi301.e57  51.9MB → 파싱 중 rss 178MB (3.43배)
    //   PANOPI_scan101.e57   219.2MB → 파싱 중 rss 604MB (2.76배)
    // 모바일 브라우저는 탭 메모리가 수백MB~1GB대에서 강제 종료된다(현장 폰에서 쓰는 PWA).
    // 배율은 실측 상한(3.43배)을 반올림해 보수적으로 잡는다 — 추정치임을 문구에도 명시한다.
    E57_LARGE_FILE_BYTES: 100 * 1024 * 1024,   // 100MB 초과 시 경고(추정 메모리 ≈350MB)
    E57_MEM_MULTIPLIER: 3.5,
    renderer: null, scene: null, camera: null, points: null,
    _raf: null, _drag: null, _rot: { theta: 0.6, phi: 1.1, r: 3 },
    _target: { x: 0, y: 0, z: 0 }, _inited: false, _ro: null,
    _mode: "orbit",            // [Navisworks 동작 모방] orbit | pan | section | measure
    _section: null,            // 단면 평면 클리핑 상태
    _measure: null,            // 측정 2점 + 라인/라벨

    SUPPORTED: ["ply", "pcd", "xyz", "pts", "asc", "txt", "las", "laz", "fls", "e57"],

    extOf(name) { return (name || "").split(".").pop().toLowerCase(); },
    isSupported(name) { return this.SUPPORTED.includes(this.extOf(name)); },

    _el(id) { return document.getElementById(id); },
    _show(which) {
      ["fls-loading", "fls-empty", "fls-error", "fls-stats"].forEach(id => {
        const e = this._el(id); if (e) e.classList.add("hidden");
      });
      const t = this._el(which); if (t) t.classList.remove("hidden");
    },

    /** 3D 패널 표시/숨김 */
    showPane(show) {
      const p = this._el("fls-pane");
      if (!p) return;
      p.classList.toggle("hidden", !show);
      if (show) {
        this._ensureRenderer();
        setTimeout(() => this._resize(), 30);
      }
    },

    /** 핀에 연결된 포인트클라우드가 있으면 로드. 없으면 empty 패널. */
    async openForPin(pin) {
      this.showPane(true);
      const src = pin && (pin.flsUrl || pin.fls);
      const name = pin && (pin.flsName || pin.flsUrl || "");
      const localData = pin && pin.flsLocalId ? Cloud._cache && Cloud._cache["fls:" + pin.flsLocalId] : null;
      if (!src && !localData) { this._show("fls-empty"); return; }
      try {
        this._show("fls-loading");
        let buf;
        if (localData) { buf = localData; }
        else {
          const res = await fetch(src);
          if (!res.ok) throw new Error("HTTP " + res.status);
          buf = await res.arrayBuffer();
        }
        await this.loadBuffer(buf, name || src);
      } catch (e) {
        this._showError("로드 실패", e.message || String(e));
      }
    },

    _showError(t, h) {
      this._show("fls-error");
      const et = this._el("fls-error-t"), eh = this._el("fls-error-h");
      if (et) et.textContent = t;
      if (eh) eh.textContent = h || "";
    },

    /** 저사양 기기면 임계값을 낮춘다(navigator.deviceMemory 없는 브라우저도 정상 동작 — 그때는 기본값 그대로) */
    _e57Threshold() {
      const dm = (typeof navigator !== "undefined" && typeof navigator.deviceMemory === "number")
        ? navigator.deviceMemory : null;
      // deviceMemory(GB) 4 이하 = 저사양(주로 모바일) — 임계값 절반으로
      return (dm != null && dm <= 4) ? this.E57_LARGE_FILE_BYTES / 2 : this.E57_LARGE_FILE_BYTES;
    },

    /** 파일 크기 → 경고 필요 여부 + 안내 문구(순수 함수, DOM 의존 없음 — 테스트 가능) */
    _e57SizeWarning(byteLength) {
      const threshold = this._e57Threshold();
      if (byteLength <= threshold) return null;
      const mb = (n) => (n / (1024 * 1024)).toFixed(1);
      const estMb = mb(byteLength * this.E57_MEM_MULTIPLIER);
      return "대용량 E57 파일입니다 (" + mb(byteLength) + "MB) — 파싱 중 메모리 사용량이 약 " + estMb
        + "MB 까지 늘어날 수 있습니다(실측 배율 기반 추정치, 실제 값은 파일 내용에 따라 다를 수 있음). "
        + "모바일/저사양 기기에서는 브라우저 탭이 강제 종료될 수 있습니다. 계속하시겠습니까?";
    },

    /** 대용량 확인 다이얼로그(PWA 독립실행모드에서 window.confirm()이 무음 false를
     *  반환하는 문제 때문에 Prompt.confirm — SoT: 30_Prompt.js — 로 통일) */
    async _confirmLargeE57(msg) {
      return await Prompt.confirm("대용량 파일", msg);
    },

    /** ArrayBuffer + 파일명 → 파싱 후 렌더 */
    async loadBuffer(buf, name) {
      const ext = this.extOf(name);
      const badge = this._el("fls-fmt-badge");
      if (badge) badge.textContent = ext ? ("." + ext) : "";
      if (ext === "e57") {
        const warn = this._e57SizeWarning(buf.byteLength);
        if (warn && !(await this._confirmLargeE57(warn))) { this._show("fls-empty"); return; }
      }
      let parsed = null;
      try {
        if (ext === "ply") parsed = this._parsePLY(buf);
        else if (ext === "pcd") parsed = this._parsePCD(buf);
        else if (["xyz", "pts", "asc", "txt"].includes(ext)) parsed = this._parseXYZ(buf);
        else if (ext === "las" || ext === "laz") parsed = this._parseLAS(buf, ext);
        else if (ext === "e57") parsed = this._parseE57(buf);
        else if (ext === "fls") parsed = this._parseFLS(buf, ext);
        else parsed = this._sniff(buf);
      } catch (e) {
        return this._showError("파싱 실패", (e && e.message) || "지원되지 않는 형식일 수 있습니다.");
      }
      if (!parsed || !parsed.count) {
        if (ext === "fls" || (parsed && parsed.faroRaw)) {
          // ── FARO .fls(iQLib 원시 압축) 직접 로드 불가 → 메타 기반 정밀 변환 안내 ──
          const m = this._flsMeta || {};
          let metaLine = "";
          if (m.rows && m.cols) {
            const vfov = (m.rStart != null && m.rEnd != null)
              ? Math.round((m.rStart - m.rEnd) * 180 / Math.PI) + "°" : "—";
            const hfov = (m.cEnd != null) ? Math.round(m.cEnd * 180 / Math.PI) + "°" : "360°";
            metaLine = `[스캔 정보 인식됨] 그리드 ${m.cols.toLocaleString()}×${m.rows.toLocaleString()} · `
              + `약 ${(m.cols * m.rows).toLocaleString()}점 · 수평 ${hfov} / 수직 ${vfov}`
              + (m.lib ? ` · iQLib ${m.lib}` : "") + ". ";
          }
          return this._showError(
            ".fls(FARO 스캔 폴더) 직접 표시 불가 — E57로 내보내면 바로 열립니다",
            metaLine +
            "FARO .fls 는 단일 파일이 아니라 폴더 컨테이너입니다(실측: Scans/<n>/ScanDataStream0 = 원시 스캔 스트림, " +
            "Params·Calib = 텍스트 설정, ReferencePicture = JPEG 미리보기). 스캔 스트림은 독점 압축($ENC$·$NES$·$GRV$)이라 " +
            "FARO LS SDK 없이는 좌표 디코딩이 불가하고, 폴더 전체를 브라우저로 올릴 수도 없습니다. " +
            "FARO SCENE에서 [내보내기 → E57]로 변환해 첨부하세요 — E57은 이 뷰어가 직접 지원합니다(LAS/PLY도 가능). " +
            "(SCENE이 없으면 CloudCompare + FARO LS 플러그인으로도 변환 가능합니다.) " +
            "지금 기능을 바로 보시려면 아래 ‘샘플 FLS 불러오기’를 누르세요."
          );
        }
        return this._showError("표시할 점이 없습니다", "파일이 비었거나 좌표 데이터를 찾지 못했습니다.");
      }
      this._render(parsed);
    },

    /* ── 파서들 (positions: Float32Array[xyz*n], colors: Float32Array|null) ── */

    _decim(posArr, colArr) {
      // 점 개수 상한 초과 시 균등 다운샘플 (안정성)
      const n = posArr.length / 3;
      if (n <= this.MAX_POINTS) return { positions: posArr, colors: colArr, count: n };
      const step = n / this.MAX_POINTS;
      const outN = Math.floor(this.MAX_POINTS);
      const pos = new Float32Array(outN * 3);
      const col = colArr ? new Float32Array(outN * 3) : null;
      for (let i = 0; i < outN; i++) {
        const si = Math.floor(i * step);
        pos[i * 3] = posArr[si * 3]; pos[i * 3 + 1] = posArr[si * 3 + 1]; pos[i * 3 + 2] = posArr[si * 3 + 2];
        if (col) { col[i * 3] = colArr[si * 3]; col[i * 3 + 1] = colArr[si * 3 + 1]; col[i * 3 + 2] = colArr[si * 3 + 2]; }
      }
      return { positions: pos, colors: col, count: outN };
    },

    _parseXYZ(buf) {
      const txt = new TextDecoder().decode(buf);
      const lines = txt.split(/\r?\n/);
      const pos = [], col = [];
      let hasColor = false;
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i].trim();
        if (!l || l[0] === "#" || /[a-df-zA-DF-Z]/.test(l[0])) continue; // 헤더/주석 스킵 (e는 지수표기 허용)
        const t = l.split(/[\s,;]+/).map(Number);
        if (t.length < 3 || !isFinite(t[0]) || !isFinite(t[1]) || !isFinite(t[2])) continue;
        pos.push(t[0], t[1], t[2]);
        if (t.length >= 6) {
          hasColor = true;
          // 색이 0~255 면 정규화
          const r = t[3] > 1 ? t[3] / 255 : t[3], g = t[4] > 1 ? t[4] / 255 : t[4], b = t[5] > 1 ? t[5] / 255 : t[5];
          col.push(r, g, b);
        } else col.push(0.7, 0.8, 0.95);
      }
      return this._decim(new Float32Array(pos), hasColor ? new Float32Array(col) : null);
    },

    _parsePCD(buf) {
      // ASCII PCD 우선 지원 (binary 는 best-effort)
      const head = new TextDecoder().decode(buf.slice(0, 2048));
      const fieldsM = head.match(/FIELDS (.+)/i);
      const dataM = head.match(/DATA (\w+)/i);
      const pointsM = head.match(/POINTS (\d+)/i);
      const fields = fieldsM ? fieldsM[1].trim().split(/\s+/) : ["x", "y", "z"];
      const xi = fields.indexOf("x"), yi = fields.indexOf("y"), zi = fields.indexOf("z");
      const rgbi = fields.findIndex(f => /rgb/i.test(f));
      const dataType = dataM ? dataM[1].toLowerCase() : "ascii";
      const headerEnd = head.indexOf("DATA");
      const bodyStart = buf.bytelength ? 0 : 0;
      if (dataType === "ascii") {
        const fullTxt = new TextDecoder().decode(buf);
        const after = fullTxt.slice(fullTxt.indexOf("DATA ascii") + 10);
        const lines = after.split(/\r?\n/);
        const pos = [], col = [];
        for (const ln of lines) {
          const l = ln.trim(); if (!l) continue;
          const t = l.split(/\s+/).map(Number);
          if (t.length <= Math.max(xi, yi, zi)) continue;
          if (!isFinite(t[xi])) continue;
          pos.push(t[xi], t[yi], t[zi]);
          if (rgbi >= 0 && isFinite(t[rgbi])) {
            const v = t[rgbi] >>> 0;
            col.push(((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255);
          } else col.push(0.7, 0.8, 0.95);
        }
        return this._decim(new Float32Array(pos), rgbi >= 0 ? new Float32Array(col) : null);
      }
      // binary PCD: best-effort — 안내로 폴백
      throw new Error("바이너리 PCD는 ASCII PCD로 변환 후 사용하세요.");
    },

    _parsePLY(buf) {
      const bytes = new Uint8Array(buf);
      // 헤더 끝(end_header) 찾기
      const headTxt = new TextDecoder().decode(buf.slice(0, 4096));
      const endIdx = headTxt.indexOf("end_header");
      if (endIdx < 0) throw new Error("PLY 헤더 없음");
      const headerStr = headTxt.slice(0, endIdx);
      const isAscii = /format\s+ascii/i.test(headerStr);
      const isLE = /format\s+binary_little_endian/i.test(headerStr);
      const vMatch = headerStr.match(/element vertex (\d+)/i);
      const vCount = vMatch ? parseInt(vMatch[1], 10) : 0;
      // 속성 파싱
      const props = [];
      headerStr.split(/\r?\n/).forEach(l => {
        const m = l.trim().match(/^property\s+(\w+)\s+(\w+)/i);
        if (m) props.push({ type: m[1].toLowerCase(), name: m[2].toLowerCase() });
      });
      const dataOffset = (new TextEncoder().encode(headTxt.slice(0, endIdx + "end_header".length))).length
        + (headTxt[endIdx + 10] === "\r" ? 2 : 1);
      const pos = new Float32Array(vCount * 3);
      const hasColor = props.some(p => /red|green|blue/.test(p.name));
      const col = hasColor ? new Float32Array(vCount * 3) : null;
      if (isAscii) {
        const fullTxt = new TextDecoder().decode(buf);
        const after = fullTxt.slice(fullTxt.indexOf("end_header") + 10).replace(/^\s+/, "");
        const lines = after.split(/\r?\n/);
        const xi = props.findIndex(p => p.name === "x"), yi = props.findIndex(p => p.name === "y"), zi = props.findIndex(p => p.name === "z");
        const ri = props.findIndex(p => p.name === "red"), gi = props.findIndex(p => p.name === "green"), bi = props.findIndex(p => p.name === "blue");
        let k = 0;
        for (let i = 0; i < lines.length && k < vCount; i++) {
          const t = lines[i].trim().split(/\s+/).map(Number);
          if (t.length < props.length) continue;
          pos[k * 3] = t[xi]; pos[k * 3 + 1] = t[yi]; pos[k * 3 + 2] = t[zi];
          if (col) { col[k * 3] = (t[ri] || 0) / 255; col[k * 3 + 1] = (t[gi] || 0) / 255; col[k * 3 + 2] = (t[bi] || 0) / 255; }
          k++;
        }
        return this._decim(pos.subarray(0, k * 3), col ? col.subarray(0, k * 3) : null);
      }
      // binary_little_endian
      const dv = new DataView(buf);
      const sizeOf = { char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2, int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };
      const readers = props.map(p => ({ name: p.name, size: sizeOf[p.type] || 4, type: p.type }));
      const stride = readers.reduce((s, r) => s + r.size, 0);
      let off = dataOffset;
      const le = isLE !== false;
      const readVal = (o, r) => {
        switch (r.type) {
          case "float": case "float32": return dv.getFloat32(o, le);
          case "double": case "float64": return dv.getFloat64(o, le);
          case "uchar": case "uint8": return dv.getUint8(o);
          case "char": case "int8": return dv.getInt8(o);
          case "ushort": case "uint16": return dv.getUint16(o, le);
          case "short": case "int16": return dv.getInt16(o, le);
          case "uint": case "uint32": return dv.getUint32(o, le);
          default: return dv.getInt32(o, le);
        }
      };
      for (let i = 0; i < vCount && off + stride <= buf.byteLength; i++) {
        let o = off;
        for (const r of readers) {
          const v = readVal(o, r);
          if (r.name === "x") pos[i * 3] = v;
          else if (r.name === "y") pos[i * 3 + 1] = v;
          else if (r.name === "z") pos[i * 3 + 2] = v;
          else if (col && r.name === "red") col[i * 3] = v / 255;
          else if (col && r.name === "green") col[i * 3 + 1] = v / 255;
          else if (col && r.name === "blue") col[i * 3 + 2] = v / 255;
          o += r.size;
        }
        off += stride;
      }
      return this._decim(pos, col);
    },

    _parseLAS(buf, ext) {
      if (ext === "laz") throw new Error("LAZ(압축)는 LAS로 풀어 첨부하거나 e57/ply를 사용하세요.");
      const dv = new DataView(buf);
      // LAS 헤더: signature 'LASF'
      const sig = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
      if (sig !== "LASF") throw new Error("유효한 LAS 파일이 아닙니다.");
      const pointDataOffset = dv.getUint32(96, true);
      const pointFormat = dv.getUint8(104);
      const pointLength = dv.getUint16(105, true);
      let numPoints = dv.getUint32(107, true);
      if (!numPoints) { // LAS 1.4 legacy 0 → extended
        try { numPoints = Number(dv.getBigUint64(247, true)); } catch (e) {}
      }
      const sx = dv.getFloat64(131, true), sy = dv.getFloat64(139, true), sz = dv.getFloat64(147, true);
      const ox = dv.getFloat64(155, true), oy = dv.getFloat64(163, true), oz = dv.getFloat64(171, true);
      const hasColor = pointFormat === 2 || pointFormat === 3 || pointFormat === 5 || pointFormat === 7 || pointFormat === 8 || pointFormat === 10;
      const colorOffsetMap = { 2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30 };
      const n = Math.min(numPoints, this.MAX_POINTS * 2);
      const pos = new Float32Array(n * 3);
      const col = hasColor ? new Float32Array(n * 3) : null;
      let off = pointDataOffset, k = 0;
      for (let i = 0; i < numPoints && off + pointLength <= buf.byteLength && k < n; i++, off += pointLength) {
        const X = dv.getInt32(off, true), Y = dv.getInt32(off + 4, true), Z = dv.getInt32(off + 8, true);
        pos[k * 3] = X * sx + ox; pos[k * 3 + 1] = Y * sy + oy; pos[k * 3 + 2] = Z * sz + oz;
        if (col) {
          const co = off + (colorOffsetMap[pointFormat] || 20);
          col[k * 3] = dv.getUint16(co, true) / 65535;
          col[k * 3 + 1] = dv.getUint16(co + 2, true) / 65535;
          col[k * 3 + 2] = dv.getUint16(co + 4, true) / 65535;
        }
        k++;
      }
      return this._decim(pos.subarray(0, k * 3), col ? col.subarray(0, k * 3) : null);
    },

    /* ══ E57 (ASTM E2807) ══════════════════════════════════════════════════
       [정본] 포맷 상수·주소 변환·논리바이트 읽기는 아래 E57 / _e57* 한 곳에만 둔다(손목록 복제 금지).
       ① 파일 전체가 pageSize 바이트 페이지로 나뉘고 **각 페이지 끝 4B 는 CRC** — 논리 데이터가 아니다.
          물리 오프셋에서 읽으려면 페이지마다 CRC 를 건너뛰며 이어붙여야 한다(_e57Usable / _e57ReadLogical).
          빠뜨리면 XML 도 좌표도 "조용히" 깨진다.
       ② XML 안에 <prototype> 이 여러 개다(색인용 CompressedVector 가 앞에 온다).
          반드시 <points type="CompressedVector"> **뒤에 오는** prototype 을 써야 한다(_e57Prototype).
       ③ 각 바이트스트림 = 그 필드 값들을 LSB 우선으로 비트팩한 것. 값이 패킷 경계를 걸칠 수 있다
          (실측: 2bit 필드 2139개 = 534.75B → 534B 만 실리고 남은 비트는 다음 패킷으로 넘어감).
          → 스트림별 잔여 비트를 이어붙이고, 모든 스트림이 공급 가능한 개수(min)만큼만 레코드를 푼다.
       ④ 대용량(224MB+) 대비: 앞에서부터 순차로 읽으며 MAX_POINTS 에 닿으면 즉시 중단하고,
          recordCount > MAX_POINTS 면 stride 로 균등 다운샘플한다. 버려질 레코드는 값을 풀지 않고
          비트 위치만 건너뛴다(디코딩 비용 O(필드수), 메모리는 항상 상한 이하).
    */
    E57: {
      SIG: "ASTM-E57",
      HEADER_BYTES: 48,              // sig(8) major(4) minor(4) fileLength(8) xmlPhys(8) xmlLen(8) pageSize(8)
      CRC_BYTES: 4,                  // 페이지 끝 CRC
      DEFAULT_PAGE: 1024,
      SECTION_HEADER_BYTES: 32,      // id(1) 예약(7) 논리길이(8) dataPhys(8) indexPhys(8)
      SECTION_ID_CV: 1,              // COMPRESSED_VECTOR_SECTION
      PACKET_HEADER_BYTES: 6,        // type(1) flags(1) len-1(2) bytestreamCount(2)
      PACKET_DATA: 1,                // 0=index, 1=data, 2=empty
      // prototype 필드명 → 역할(숫자). 모르는 필드는 0(비트만 소비하고 버림).
      ROLE: {
        cartesianX: 1, cartesianY: 2, cartesianZ: 3,
        colorRed: 4, colorGreen: 5, colorBlue: 6,
        cartesianInvalidState: 7, sphericalInvalidState: 7,
        sphericalRange: 8, sphericalAzimuth: 9, sphericalElevation: 10
      }
    },

    /** 한 페이지에서 실제 데이터가 담기는 바이트 수(끝 4B 는 CRC) — CRC 처리의 정본 */
    _e57Usable(pageSize) { return pageSize - this.E57.CRC_BYTES; },
    /** 논리 주소 → 물리 주소 */
    _e57PhysOf(logical, pageSize) {
      const u = this._e57Usable(pageSize);
      return Math.floor(logical / u) * pageSize + (logical % u);
    },
    /** 물리 주소 → 논리 주소 */
    _e57LogicalOf(phys, pageSize) {
      const u = this._e57Usable(pageSize);
      return Math.floor(phys / pageSize) * u + Math.min(phys % pageSize, u);
    },
    /** 물리 오프셋 phys 에서 논리 바이트 len 개를 읽는다(페이지 CRC 건너뜀). 파일 끝이면 짧게 반환. */
    _e57ReadLogical(u8, phys, len, pageSize) {
      const out = new Uint8Array(len);
      const u = this._e57Usable(pageSize);
      let got = 0, p = phys;
      while (got < len) {
        const ps = Math.floor(p / pageSize) * pageSize, ip = p - ps;
        const want = Math.min(u - ip, len - got);
        if (want <= 0) break;
        const end = Math.min(p + want, u8.length);
        if (end <= p) break;
        out.set(u8.subarray(p, end), got);
        got += end - p;
        if (end < p + want) break;          // 파일 끝(잘림)
        p = ps + pageSize;
      }
      return got === len ? out : out.subarray(0, got);
    },

    /** E57 헤더(48B) 판독 */
    _e57Header(buf) {
      const E = this.E57;
      if (buf.byteLength < E.HEADER_BYTES) throw new Error("E57 헤더(48B)보다 파일이 작습니다.");
      const head = new Uint8Array(buf, 0, 8);
      let sig = "";
      for (let i = 0; i < 8; i++) sig += String.fromCharCode(head[i]);
      if (sig !== E.SIG) throw new Error('E57 서명("' + E.SIG + '")이 없습니다 — 확장자만 .e57 인 다른 파일일 수 있습니다.');
      const dv = new DataView(buf);
      const u64 = (o) => dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 4294967296;
      const pageSize = u64(40) || E.DEFAULT_PAGE;
      if (pageSize <= E.CRC_BYTES) throw new Error("E57 pageSize 값이 비정상입니다: " + pageSize);
      return {
        major: dv.getUint32(8, true), minor: dv.getUint32(12, true),
        fileLength: u64(16), xmlPhysOffset: u64(24), xmlLength: u64(32), pageSize
      };
    },

    /** points 태그 **뒤**의 prototype 에서 필드 정의를 뽑는다(손목록 금지 — 파일이 정본) */
    _e57Prototype(xml, tagIndex) {
      const from = tagIndex >= 0 ? tagIndex : 0;
      const s0 = xml.indexOf("<prototype", from);     // ← 반드시 points 태그 뒤에서 찾는다(앞엣것은 색인용)
      const s1 = s0 < 0 ? -1 : xml.indexOf("</prototype>", s0);
      if (s0 < 0 || s1 < 0) throw new Error("E57 prototype 을 찾지 못했습니다.");
      const block = xml.slice(s0, s1);
      const ROLE = this.E57.ROLE;
      const fields = [];
      const re = /<(\w+)\s+type="(Float|Integer|ScaledInteger)"([^>]*?)\/?>/g;
      let m;
      while ((m = re.exec(block))) {
        const name = m[1], type = m[2], at = m[3];
        const attr = (k) => {
          const a = at.match(new RegExp(k + '="(-?[0-9.eE+-]+)"'));
          return a ? Number(a[1]) : null;
        };
        let f;
        if (type === "Float") {
          f = { name, type, bits: /precision="single"/.test(at) ? 32 : 64 };
        } else {
          const min = attr("minimum"), max = attr("maximum");
          if (min === null || max === null || !isFinite(min) || !isFinite(max) || max < min)
            throw new Error("E57 prototype 필드 " + name + " 에 minimum/maximum 이 없어 비트폭을 알 수 없습니다.");
          const range = max - min;
          const bits = range <= 0 ? 0 : Math.ceil(Math.log2(range + 1));
          if (bits > 53) throw new Error("E57 필드 " + name + " 의 비트폭(" + bits + ")이 너무 큽니다.");
          f = { name, type, bits, min, max };
          if (type === "ScaledInteger") { f.scale = attr("scale") || 1; f.offset = attr("offset") || 0; }
        }
        f.role = ROLE[name] || 0;
        // 색 정규화 기준도 파일에서 파생(0~255 가 아닌 0~65535 스캐너가 있다)
        if (f.role >= 4 && f.role <= 6) f.cnorm = (f.type === "Float") ? 1 : (f.max || 255);
        fields.push(f);
      }
      if (!fields.length) throw new Error("E57 prototype 에 필드가 없습니다.");
      return fields;
    },

    /** 한 스트림에 새 바이트를 이어붙인다(이미 소비한 바이트는 버리고 잔여 비트는 유지) */
    _e57Feed(st, add) {
      const keep = st.bit >> 3;
      const rem = st.bytes.length - keep;
      const nb = new Uint8Array(rem + add.length);
      nb.set(st.bytes.subarray(keep), 0);
      nb.set(add, rem);
      st.bytes = nb;
      st.bit = st.bit & 7;
    },

    /** LSB 우선 비트 읽기(n ≤ 32). 바이트 정렬이면 바이트 단위 고속 경로. */
    _e57Bits(st, n) {
      if (n === 0) return 0;
      const b = st.bytes;
      if ((st.bit & 7) === 0 && (n & 7) === 0) {
        let o = st.bit >> 3, v = 0, mul = 1;
        for (let i = 0; i < n; i += 8) { v += b[o++] * mul; mul *= 256; }
        st.bit += n;
        return v;
      }
      let v = 0, mul = 1;
      for (let i = 0; i < n; i++) {
        v += ((b[st.bit >> 3] >> (st.bit & 7)) & 1) * mul;
        mul *= 2; st.bit++;
      }
      return v;
    },

    /** 필드 1개 값 디코딩 */
    _e57Value(f, st, scratch) {
      if (f.type === "Float") {
        if (f.bits === 32) { scratch.setUint32(0, this._e57Bits(st, 32), true); return scratch.getFloat32(0, true); }
        const lo = this._e57Bits(st, 32), hi = this._e57Bits(st, 32);
        scratch.setUint32(0, lo, true); scratch.setUint32(4, hi, true);
        return scratch.getFloat64(0, true);
      }
      const raw = f.bits <= 32
        ? this._e57Bits(st, f.bits)
        : this._e57Bits(st, 32) + this._e57Bits(st, f.bits - 32) * 4294967296;
      const v = f.min + raw;
      return f.type === "ScaledInteger" ? v * f.scale + f.offset : v;
    },

    /** ArrayBuffer(.e57) → { positions, colors, count } — _parsePLY/_parseLAS 와 동일 계약 */
    _parseE57(buf) {
      const u8 = new Uint8Array(buf);
      const h = this._e57Header(buf);
      const xmlBytes = this._e57ReadLogical(u8, h.xmlPhysOffset, h.xmlLength, h.pageSize);
      if (!xmlBytes.length) throw new Error("E57 XML 섹션을 읽지 못했습니다(물리오프셋 " + h.xmlPhysOffset + ").");
      const xml = new TextDecoder("utf-8").decode(xmlBytes);

      // 스캔이 여러 개면 points CompressedVector 도 여러 개 → 순서대로 이어 읽는다
      const secs = [];
      const re = /<points\s[^>]*type="CompressedVector"[^>]*>/g;
      let m;
      while ((m = re.exec(xml))) {
        const fo = m[0].match(/fileOffset="(\d+)"/);
        if (!fo) continue;
        const rc = m[0].match(/recordCount="(\d+)"/);
        secs.push({ at: m.index, fileOffset: Number(fo[1]), recordCount: rc ? Number(rc[1]) : 0 });
      }
      if (!secs.length) throw new Error("E57 안에 점 데이터(<points type=\"CompressedVector\">)가 없습니다.");
      secs.forEach(s => { s.fields = this._e57Prototype(xml, s.at); });

      const total = secs.reduce((s, x) => s + x.recordCount, 0);
      const cap = Math.min(this.MAX_POINTS, total || this.MAX_POINTS);
      const hasColor = secs.some(s => s.fields.some(f => f.role >= 4 && f.role <= 6));
      const sink = {
        pos: new Float32Array(cap * 3),
        col: hasColor ? new Float32Array(cap * 3) : null,
        cap, kept: 0, invalid: 0,
        stride: (total > this.MAX_POINTS) ? Math.ceil(total / this.MAX_POINTS) : 1
      };
      for (const s of secs) {
        if (sink.kept >= cap) break;
        this._e57ReadSection(u8, s, h.pageSize, sink);
      }
      if (!sink.kept) {
        throw new Error("유효한 점을 찾지 못했습니다 (recordCount=" + total + ", 무효점 " + sink.invalid + "). "
          + "좌표 필드(cartesianX/Y/Z 또는 sphericalRange)가 없거나 모두 무효 측정값일 수 있습니다.");
      }
      return this._decim(sink.pos.subarray(0, sink.kept * 3), sink.col ? sink.col.subarray(0, sink.kept * 3) : null);
    },

    /** CompressedVector 섹션 1개를 앞에서부터 스트리밍 디코딩해 sink 에 채운다 */
    _e57ReadSection(u8, sec, pageSize, sink) {
      const E = this.E57, fields = sec.fields, nf = fields.length;
      const sh = this._e57ReadLogical(u8, sec.fileOffset, E.SECTION_HEADER_BYTES, pageSize);
      if (sh.length < E.SECTION_HEADER_BYTES) throw new Error("E57 CompressedVector 섹션 헤더를 읽지 못했습니다.");
      if (sh[0] !== E.SECTION_ID_CV) throw new Error("E57 섹션 id 가 CompressedVector(1)가 아닙니다: " + sh[0]);
      const sdv = new DataView(sh.buffer, sh.byteOffset, sh.byteLength);
      const dataPhys = sdv.getUint32(16, true) + sdv.getUint32(20, true) * 4294967296;

      const cartesian = fields.some(f => f.role >= 1 && f.role <= 3);
      const scratch = new DataView(new ArrayBuffer(8));
      const streams = [];
      for (let i = 0; i < nf; i++) streams.push({ bytes: new Uint8Array(0), bit: 0 });
      const nRec = sec.recordCount;
      let phys = dataPhys, done = 0;

      while (sink.kept < sink.cap) {
        if (nRec && done >= nRec) break;
        if (phys >= u8.length) break;
        const ph = this._e57ReadLogical(u8, phys, E.PACKET_HEADER_BYTES, pageSize);
        if (ph.length < E.PACKET_HEADER_BYTES) break;
        const packetLen = (ph[2] | (ph[3] << 8)) + 1;
        if (packetLen < E.PACKET_HEADER_BYTES) throw new Error("E57 패킷 길이가 비정상입니다: " + packetLen);
        const next = this._e57PhysOf(this._e57LogicalOf(phys, pageSize) + packetLen, pageSize);
        if (ph[0] !== E.PACKET_DATA) { phys = next; continue; }   // index/empty 패킷은 건너뜀
        const nStreams = ph[4] | (ph[5] << 8);
        if (nStreams !== nf)
          throw new Error("E57 바이트스트림 수(" + nStreams + ")가 prototype 필드 수(" + nf + ")와 다릅니다.");
        const full = this._e57ReadLogical(u8, phys, packetLen, pageSize);
        if (full.length < packetLen) break;                       // 잘린 파일 — 여기까지만
        let cur = E.PACKET_HEADER_BYTES + nStreams * 2;
        for (let i = 0; i < nStreams; i++) {
          const o = E.PACKET_HEADER_BYTES + i * 2;
          const len = full[o] | (full[o + 1] << 8);
          this._e57Feed(streams[i], full.subarray(cur, cur + len));
          cur += len;
        }
        // 모든 스트림이 공급 가능한 만큼만 푼다(값이 패킷 경계를 걸치므로 min)
        let avail = Infinity;
        for (let i = 0; i < nf; i++) {
          const bits = fields[i].bits;
          if (!bits) continue;
          const a = Math.floor((streams[i].bytes.length * 8 - streams[i].bit) / bits);
          if (a < avail) avail = a;
        }
        if (avail === Infinity) avail = nRec ? nRec - done : 0;
        if (nRec) avail = Math.min(avail, nRec - done);
        if (avail <= 0) { phys = next; continue; }

        for (let n = 0; n < avail && sink.kept < sink.cap; n++) {
          if (done % sink.stride !== 0) {          // 균등 다운샘플: 비트만 건너뛰고 값은 풀지 않는다
            for (let i = 0; i < nf; i++) streams[i].bit += fields[i].bits;
            done++;
            continue;
          }
          let x = 0, y = 0, z = 0, r = 1, g = 1, b = 1, bad = 0, rng = 0, az = 0, el = 0;
          for (let i = 0; i < nf; i++) {
            const f = fields[i], v = this._e57Value(f, streams[i], scratch);
            switch (f.role) {
              case 1: x = v; break;
              case 2: y = v; break;
              case 3: z = v; break;
              case 4: r = v / f.cnorm; break;
              case 5: g = v / f.cnorm; break;
              case 6: b = v / f.cnorm; break;
              case 7: if (v !== 0) bad = 1; break;
              case 8: rng = v; break;
              case 9: az = v; break;
              case 10: el = v; break;
              default: break;                      // 모르는 필드 — 비트만 소비
            }
          }
          done++;
          if (bad) { sink.invalid++; continue; }
          if (!cartesian) {                        // 구면좌표 스캔 → 직교로 변환(E57 규격)
            const c = Math.cos(el);
            x = rng * c * Math.cos(az); y = rng * c * Math.sin(az); z = rng * Math.sin(el);
          }
          if (!isFinite(x) || !isFinite(y) || !isFinite(z)) { sink.invalid++; continue; }
          const k = sink.kept;
          sink.pos[k * 3] = x; sink.pos[k * 3 + 1] = y; sink.pos[k * 3 + 2] = z;
          if (sink.col) { sink.col[k * 3] = r; sink.col[k * 3 + 1] = g; sink.col[k * 3 + 2] = b; }
          sink.kept++;
        }
        phys = next;
      }
    },

    _parseFLS(buf, ext) {
      // FARO .fls 는 독점 포맷(iQLib). 내부 ScanDataStream 은 가변 델타 압축($ENC$/$NES$/$GRV$ 토큰)
      // 이라 FARO LS SDK 없이는 XYZ 디코딩 불가(공식 문서·CloudCompare 포럼 확인).
      // → 시그니처를 감지해 "정확한 변환 안내"를 제공하고, 가능하면 메타데이터(그리드/FOV)를 보여준다.
      try {
        const head = new TextDecoder("latin1").decode(buf.slice(0, Math.min(buf.byteLength, 262144)));
        // iQLib / 폴더형 원시(.fls) 시그니처
        const sig = /iQscene|iQLib|Scan2DataBase|ScanParameter|DataMode\s+\d+|ScannerParam/i.test(head);
        // 압축 스캔 스트림 토큰
        const u8 = new Uint8Array(buf.slice(0, Math.min(buf.byteLength, 4096)));
        let dollar = 0; for (let i = 0; i < u8.length; i++) if (u8[i] === 0x24) dollar++;
        const streamy = dollar > 20; // $ENC$ 등 토큰 다발
        if (sig || streamy) {
          const meta = this._parseFLSMeta(head);
          this._flsMeta = meta; // loadBuffer 에서 안내에 활용
          // 직접 디코딩은 불가 → count 0 반환(loadBuffer 가 변환 안내 표시)
          return { positions: new Float32Array(0), colors: null, count: 0, faroRaw: true };
        }
      } catch (e) {}
      // 텍스트형(드물게 ASCII 좌표가 들어있는 변형) → sniff
      return this._sniff(buf);
    },

    /** FARO Params/Main 텍스트에서 스캔 메타(그리드·FOV·거리계수) 추출 */
    _parseFLSMeta(head) {
      const num = (re) => { const m = head.match(re); return m ? parseFloat(m[1]) : null; };
      const rows = num(/Name\s+"NumRows"\s*\}?\s*Value\s+(\d+)/i) || num(/NumRows[^0-9]+(\d+)/i);
      const cols = num(/Name\s+"NumCols"\s*\}?\s*Value\s+(\d+)/i) || num(/NumCols[^0-9]+(\d+)/i);
      const rStart = num(/RowStartAngle[^0-9\-]+(-?[\d.]+)/i);
      const rEnd = num(/RowEndAngle[^0-9\-]+(-?[\d.]+)/i);
      const cEnd = num(/ColEndAngle[^0-9\-]+(-?[\d.]+)/i);
      const distFact = num(/DistFactor[^0-9\-]+(-?[\d.]+)/i);
      const distOff = num(/DistOffset[^0-9\-]+(-?[\d.]+)/i);
      const lib = (head.match(/"iQLib"\s+([\d.]+)/i) || [])[1] || null;
      const pts = (rows && cols) ? rows * cols : null;
      return { rows, cols, rStart, rEnd, cEnd, distFact, distOff, lib, pts };
    },

    _sniff(buf) {
      // 텍스트면 XYZ 시도
      try {
        const head = new TextDecoder().decode(buf.slice(0, 256));
        if (/^[\s\d.\-eE,;]+$/.test(head.replace(/\r?\n/g, " ").slice(0, 80))) {
          return this._parseXYZ(buf);
        }
      } catch (e) {}
      return { positions: new Float32Array(0), colors: null, count: 0 };
    },

    /* ── Three.js 렌더링 ── */
    _ensureRenderer() {
      if (this._inited) return;
      const canvas = this._el("fls-canvas");
      if (!canvas || typeof THREE === "undefined") return;
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.scene = new THREE.Scene();
      this.scene.background = new THREE.Color(0x0a1422);
      this.camera = new THREE.PerspectiveCamera(60, 1, 0.01, 100000);
      const grid = new THREE.GridHelper(10, 20, 0x1b75bb, 0x16324d);
      grid.material.opacity = 0.25; grid.material.transparent = true;
      this.scene.add(grid);
      // ── [마스터 요청] 업라이트 핀(퀸) 그룹: 어떤 각도에서 봐도 '서있는' 마커 ──
      this._markers = new THREE.Group();
      this.scene.add(this._markers);
      this._bindControls(canvas);
      this._inited = true;
      // 반응형 리사이즈
      try {
        this._ro = new ResizeObserver(() => this._resize());
        this._ro.observe(this._el("fls-stage"));
      } catch (e) {}
      this._loop();
    },

    _render(parsed) {
      this._ensureRenderer();
      if (!this.scene) { this._showError("WebGL 미지원", "이 브라우저에서 3D 렌더링을 사용할 수 없습니다."); return; }
      // 기존 points 제거
      if (this.points) { this.scene.remove(this.points); this.points.geometry.dispose(); this.points.material.dispose(); this.points = null; }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(parsed.positions, 3));
      let mat;
      if (parsed.colors) {
        geo.setAttribute("color", new THREE.BufferAttribute(parsed.colors, 3));
        mat = new THREE.PointsMaterial({ size: 0.02, vertexColors: true, sizeAttenuation: true });
      } else {
        mat = new THREE.PointsMaterial({ size: 0.02, color: 0x8ec5ff, sizeAttenuation: true });
      }
      geo.computeBoundingBox();
      const bb = geo.boundingBox;
      const cx = (bb.min.x + bb.max.x) / 2, cy = (bb.min.y + bb.max.y) / 2, cz = (bb.min.z + bb.max.z) / 2;
      const size = Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z) || 1;
      // 점 크기를 모델 스케일에 맞춤
      mat.size = size / 600;
      this.points = new THREE.Points(geo, mat);
      this.scene.add(this.points);
      this._target = { x: cx, y: cy, z: cz };
      this._rot = { theta: 0.7, phi: 1.05, r: size * 1.6 };
      this._show("fls-stats");
      const stats = this._el("fls-stats");
      if (stats) stats.textContent = parsed.count.toLocaleString() + " pts";
      // ── [마스터 요청] 모델 중심 위에 '서있는 지도 핀'을 1개 배치(예시/기준점) ──
      this._placeUprightPin(cx, bb.max.y, cz, size);
      this._resize();
    },

    /* ── [마스터 요청 정정] 지도 '핀(Pin)' 3D 마커 만들기 ────────────────────
       · 지도에 꽂는 물방울(teardrop) 위치 핀 — 체스 퀸 X.
       · 구조: (아래)뾰족한 끝 → (위)둥근 머리, 끝점이 표면을 가리킴.
       · 어느 각도에서 봐도 항상 '서있다' → _loop에서 yaw만 빌보드, 절대 눕지않음.
       · 표면에 닿는 그림자 디스크로 '꽂혀있는' 인지 강화.                       */
    _makeUprightPin(color) {
      const g = new THREE.Group();
      const col = color || 0x2f6df0;
      // 바닥 그림자 디스크(표면에 평평하게 누움) — 핀이 '꽂혀있다'는 인지
      const shadow = new THREE.Mesh(
        new THREE.CircleGeometry(0.42, 24),
        new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false })
      );
      shadow.rotation.x = -Math.PI / 2;
      shadow.position.y = 0.002;
      g.add(shadow);
      // 핀 꼬리(뾰족한 끝) — 끝점이 바닥(표면)을 향함. 위로 갈수록 넓어짐
      const tail = new THREE.Mesh(
        new THREE.ConeGeometry(0.52, 1.35, 24),
        new THREE.MeshBasicMaterial({ color: col })
      );
      tail.position.y = 0.675;          // 끝(y=0)이 표면, 넓은쪽(y=1.35)이 머리쪽
      g.add(tail);
      // 핀 머리(둥근 물방울 머리) — 위쪽 구
      const head = new THREE.Mesh(
        new THREE.SphereGeometry(0.62, 24, 18),
        new THREE.MeshBasicMaterial({ color: col })
      );
      head.position.y = 1.62;
      g.add(head);
      // 머리 안 흰색 도넛(지도 핀의 구멍 느낌) — 카메라쪽 면에 항상 보이도록 빌보드 자식
      const hole = new THREE.Mesh(
        new THREE.SphereGeometry(0.30, 20, 14),
        new THREE.MeshBasicMaterial({ color: 0xffffff })
      );
      hole.position.y = 1.62;
      g.add(hole);
      g.userData.upright = true;        // 루프에서 빌보드 처리 대상 표시
      g.userData.pinHeight = 2.24;      // 끝~머리 전체 높이(배치 보정용)
      return g;
    },

    /** 모델 중심 위에 업라이트 핀 1개 배치(scale 자동) */
    _placeUprightPin(x, topY, z, modelSize) {
      if (!this._markers || typeof THREE === "undefined") return;
      // 기존 마커 제거
      while (this._markers.children.length) {
        const m = this._markers.children.pop();
        m.traverse && m.traverse(o => { o.geometry && o.geometry.dispose && o.geometry.dispose(); o.material && o.material.dispose && o.material.dispose(); });
        this._markers.remove(m);
      }
      const pin = this._makeUprightPin(0x2f6df0);
      const s = (modelSize || 1) * 0.06;   // 모델 크기의 6% 정도 높이
      pin.scale.setScalar(s);
      // 핀의 뾰족한 끝(local y=0)이 표면(topY)에 정확히 닿도록 배치
      pin.position.set(x, topY + (modelSize || 1) * 0.004, z);
      this._markers.add(pin);
    },

    /* ── [Navisworks 동작 모방] 검토 모드 전환 ──────────────────────────────
       orbit  : 드래그=3D 회전(스피어 카메라)
       pan    : 드래그=화면 평행이동(타깃 이동)
       section : 드래그=수직 단면 클리핑 평면 이동(잘라보기)
       measure : 클릭 2점 = 거리 측정(라인+라벨)                              */
    setMode(mode) {
      const ok = ["orbit", "pan", "section", "measure"];
      if (!ok.includes(mode)) return;
      this._mode = mode;
      // 단면 모드 해제 시 클리핑 평면 제거
      if (mode !== "section") this._clearSection();
      // 측정 모드 해제 시 측정 마커 제거
      if (mode !== "measure") this._clearMeasure();
      // 버튼 active 토글
      ["orbit", "pan", "section", "measure"].forEach(m => {
        const b = this._el("btn-cad-" + m);
        if (b) b.classList.toggle("active", m === mode);
      });
      // 커서 힌트
      const cv = this._el("fls-canvas");
      if (cv) cv.style.cursor = (mode === "measure") ? "crosshair" : (mode === "pan" ? "move" : "grab");
    },

    _clearSection() {
      if (this.renderer) this.renderer.clippingPlanes = [];
      this._section = null;
    },
    /** 수직(Y) 클리핑 평면 적용 — offset 위쪽만 보이게 잘라보기 */
    _applySection(offset) {
      if (!this.renderer || typeof THREE === "undefined") return;
      this.renderer.localClippingEnabled = true;
      // 평면 법선 (0,1,0): y >= -constant 영역만 표시
      const plane = (this._section && this._section.plane) || new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      const base = this._target ? this._target.y : 0;
      plane.constant = -(base + offset);
      this.renderer.clippingPlanes = [plane];
      this._section = { plane, offset };
    },
    _clearMeasure() {
      if (this._measure && this.scene) {
        if (this._measure.line) { this.scene.remove(this._measure.line); this._measure.line.geometry.dispose(); this._measure.line.material.dispose(); }
        (this._measure.dots || []).forEach(d => { this.scene.remove(d); d.geometry.dispose(); d.material.dispose(); });
      }
      this._measure = null;
      const lab = this._el("fls-measure-label");
      if (lab) lab.classList.add("hidden");
    },

    /** 화면 좌표 → 포인트 클라우드 표면의 3D 좌표(레이캐스트) */
    _pick(clientX, clientY) {
      if (!this.points || typeof THREE === "undefined") return null;
      const stage = this._el("fls-stage");
      const rect = (this._el("fls-canvas") || stage).getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1
      );
      const rc = new THREE.Raycaster();
      // 포인트 클라우드용 임계값(모델 스케일 비례)
      const s = this._rot.r || 1;
      rc.params.Points = { threshold: s * 0.02 };
      rc.setFromCamera(ndc, this.camera);
      const hit = rc.intersectObject(this.points, false);
      return hit && hit.length ? hit[0].point.clone() : null;
    },

    _addMeasurePoint(pt) {
      if (!this._measure) this._measure = { pts: [], dots: [], line: null };
      // 이미 2점이면 리셋하고 새로 시작
      if (this._measure.pts.length >= 2) this._clearMeasure(), this._measure = { pts: [], dots: [], line: null };
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry((this._rot.r || 1) * 0.01, 12, 10),
        new THREE.MeshBasicMaterial({ color: 0xffd54a })
      );
      dot.position.copy(pt);
      this.scene.add(dot);
      this._measure.dots.push(dot);
      this._measure.pts.push(pt);
      if (this._measure.pts.length === 2) {
        const [a, b] = this._measure.pts;
        const g = new THREE.BufferGeometry().setFromPoints([a, b]);
        const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xffd54a }));
        this.scene.add(line);
        this._measure.line = line;
        const dist = a.distanceTo(b);
        const lab = this._el("fls-measure-label");
        if (lab) { lab.textContent = "" + dist.toFixed(3) + " m"; lab.classList.remove("hidden"); }
      }
    },

    _bindControls(canvas) {
      const down = e => {
        const p = e.touches ? e.touches[0] : e;
        if (this._mode === "measure") {
          const pt = this._pick(p.clientX, p.clientY);
          if (pt) this._addMeasurePoint(pt);
          return; // 측정은 드래그 회전 안함
        }
        this._drag = {
          x: p.clientX, y: p.clientY,
          theta: this._rot.theta, phi: this._rot.phi,
          tx: this._target.x, ty: this._target.y, tz: this._target.z,
          sec: this._section ? this._section.offset : 0
        };
      };
      const move = e => {
        if (!this._drag) return;
        const p = e.touches ? e.touches[0] : e;
        const dx = p.clientX - this._drag.x, dy = p.clientY - this._drag.y;
        if (this._mode === "pan") {
          // 화면 평행 이동: 카메라 right/up 벡터 기준 타깃 이동
          const r = this._rot.r || 1;
          const sp = r * 0.0016;
          const right = new THREE.Vector3(), up = new THREE.Vector3(), fwd = new THREE.Vector3();
          this.camera.getWorldDirection(fwd);
          right.crossVectors(fwd, this.camera.up).normalize();
          up.copy(this.camera.up).normalize();
          this._target.x = this._drag.tx - right.x * dx * sp + up.x * dy * sp;
          this._target.y = this._drag.ty - right.y * dx * sp + up.y * dy * sp;
          this._target.z = this._drag.tz - right.z * dx * sp + up.z * dy * sp;
        } else if (this._mode === "section") {
          // 수직(Y) 단면 평면을 드래그로 위아래 이동
          this._applySection(this._drag.sec - dy * (this._rot.r || 1) * 0.002);
        } else {
          // orbit (기본)
          this._rot.theta = this._drag.theta - dx * 0.005;
          this._rot.phi = Math.max(0.05, Math.min(Math.PI - 0.05, this._drag.phi - dy * 0.005));
        }
      };
      const up = () => { this._drag = null; };
      canvas.addEventListener("mousedown", down);
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
      canvas.addEventListener("touchstart", down, { passive: true });
      canvas.addEventListener("touchmove", e => { move(e); }, { passive: true });
      canvas.addEventListener("touchend", up);
      canvas.addEventListener("wheel", e => {
        e.preventDefault();
        this._rot.r *= (1 + (e.deltaY > 0 ? 0.1 : -0.1));
        this._rot.r = Math.max(0.01, this._rot.r);
      }, { passive: false });
      const rb = this._el("btn-fls-reset");
      if (rb) rb.addEventListener("click", () => {
        if (this.points) { const bb = this.points.geometry.boundingBox; const s = Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z) || 1; this._rot = { theta: 0.7, phi: 1.05, r: s * 1.6 }; }
      });
      const cb = this._el("btn-fls-collapse");
      if (cb) cb.addEventListener("click", () => {
        const pane = this._el("fls-pane");
        if (pane) { pane.classList.toggle("fls-collapsed"); setTimeout(() => this._resize(), 260); }
      });
      // ── [Navisworks 동작 모방] CAD 툴바 모드 버튼 바인딩 ──
      ["orbit", "pan", "section", "measure"].forEach(m => {
        const b = this._el("btn-cad-" + m);
        if (b && !b._bound) { b._bound = true; b.addEventListener("click", () => this.setMode(m)); }
      });
      this.setMode("orbit");
    },

    _resize() {
      if (!this.renderer) return;
      const stage = this._el("fls-stage");
      if (!stage) return;
      const w = stage.clientWidth || 1, h = stage.clientHeight || 1;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    },

    _loop() {
      const tick = () => {
        this._raf = requestAnimationFrame(tick);
        if (!this.renderer || !this.scene) return;
        const pane = this._el("fls-pane");
        if (!pane || pane.classList.contains("hidden")) return;
        const { theta, phi, r } = this._rot;
        this.camera.position.set(
          this._target.x + r * Math.sin(phi) * Math.cos(theta),
          this._target.y + r * Math.cos(phi),
          this._target.z + r * Math.sin(phi) * Math.sin(theta)
        );
        this.camera.lookAt(this._target.x, this._target.y, this._target.z);
        // ── [마스터 요청] 업라이트 핀 빌보드: 카메라 쪽으로 yaw 만 회전 → 항상 '서있음' ──
        if (this._markers && this._markers.children.length) {
          const cam = this.camera.position;
          for (const m of this._markers.children) {
            if (!m.userData || !m.userData.upright) continue;
            const dx = cam.x - m.position.x;
            const dz = cam.z - m.position.z;
            m.rotation.set(0, Math.atan2(dx, dz), 0); // Y축 회전만(절대 눕지 않음)
          }
        }
        this.renderer.render(this.scene, this.camera);
      };
      this._raf = requestAnimationFrame(tick);
    },

    close() { this.showPane(false); }
  };

  /* ══════════════════════════════════════════
     MAP CTRL  — 줌/패닝 + 좌표 변환 + 플라이투
  ══════════════════════════════════════════ */
  const MapCtrl = {
    viewport: null, transform: null, _flyRaf: null,
    // [WO 20260928-crop] 구역(crop)이 "새 페이지"로 열려 있는 동안의 경계.
    // {x,y,w,h}(% 단위, 페이지 기준) 또는 null(경계 없음 = 종전 전체 페이지 동작).
    _cropBoundary: null,
    _boundaryFitZoom: null,        // 경계를 화면에 꽉 채우는(cover) 최소 배율(캐시)
    BOUNDARY_ZOOM_HEADROOM: 6,     // 경계 최소 배율 대비 추가로 확대 가능한 배수
    BOUNDARY_ZOOM_MAX_HARD: 64,    // 절대 상한(메모리 예산은 PDF.effectivePxCap 이 별도로 지킴)

    init(viewport, transform) {
      this.viewport = viewport; this.transform = transform;
      // GPU 합성 힌트 → 패닝/줌/flyTo 가 부드럽고 빠르게 동작
      try {
        transform.style.willChange = "transform";
        transform.style.transformOrigin = "0 0";
        transform.style.backfaceVisibility = "hidden";
        // [마스터 요청] ISO 3D에서 핀이 "서 있게" 보이려면 부모가 3D 컨텍스트를 보존해야 함.
        //   (없으면 rotateX(54)가 자식을 평면으로 눕혀 핀 역회전이 무효 → 핀이 안 섬)
        transform.style.transformStyle = "preserve-3d";
      } catch (e) {}
    },

    /** [P14] 재래스터할 "원본"을 갖고 있는가 — 모드가 아니라 원본 보유 여부가 진짜 조건이다.
     *  · 편집모드 PDF        : State.pdfDoc (전면 캔버스 재래스터)
     *  · 뷰어/스냅샷 재열람  : State.srcPdfDoc (지연 로드한 원본 → 크롭 오버레이) */
    hasRerenderSource() {
      if (typeof PDF === "undefined" || !PDF.requestZoomRerender) return false;
      if (State.srcPdfDoc) return true;
      return State.fileType === "pdf" && !!State.pdfDoc;
    },

    /** [WO 20260928-crop] 구역 경계를 활성/해제한다. crop 이 {x,y,w,h}(%, w>0,h>0) 면 그
     *  사각형을 "이 페이지의 전체"로 취급(바깥 클리핑 + 줌/팬 경계). crop 이 null/무효면
     *  해제(= 크롭 없는 구버전 구역·일반 도면은 종전대로 전체 페이지 동작, 회귀 0).
     *  단일 진입점: PDF.setDeckCrop() 이 호출한다(§G-2-5 공유 지점 한 곳). */
    setCropBoundary(crop) {
      if (!crop || !(crop.w > 0) || !(crop.h > 0)) {
        this._cropBoundary = null;
        this._boundaryFitZoom = null;
        this._clearBoundaryClip();
        return null;
      }
      this._cropBoundary = { x: crop.x, y: crop.y, w: crop.w, h: crop.h };
      this._boundaryFitZoom = null; // _enforceBoundary 가 실제 뷰포트 크기로 재계산
      this._applyBoundaryClip(this._cropBoundary);
      return this._cropBoundary;
    },

    /** 경계 밖을 숨긴다. clip-path 는 transform 적용 "이전"의 로컬 레이아웃 박스 기준
     *  %로 해석되므로(스펙), pan/zoom(transform)과 무관하게 항상 도면의 같은 영역을 가린다. */
    _applyBoundaryClip(b) {
      if (!this.transform) return;
      const top    = Math.max(0, Math.min(100, b.y));
      const left   = Math.max(0, Math.min(100, b.x));
      const right  = Math.max(0, Math.min(100, 100 - b.x - b.w));
      const bottom = Math.max(0, Math.min(100, 100 - b.y - b.h));
      try { this.transform.style.clipPath = `inset(${top}% ${right}% ${bottom}% ${left}%)`; } catch (e) {}
    },
    _clearBoundaryClip() {
      try { if (this.transform) this.transform.style.clipPath = ""; } catch (e) {}
    },

    /** 순수함수(테스트 가능): bbox(%)가 vw×vh 화면을 "덮도록"(cover, 여백 없음) 하는 배율.
     *  cw/ch = 콘텐츠(도면)의 로컬(줌1) CSS 크기. 유효하지 않으면 null. */
    computeCoverZoom(bbox, vw, vh, cw, ch) {
      if (!bbox || !(bbox.w > 0) || !(bbox.h > 0) || !vw || !vh || !cw || !ch) return null;
      const zoneW = (bbox.w / 100) * cw, zoneH = (bbox.h / 100) * ch;
      if (!(zoneW > 0) || !(zoneH > 0)) return null;
      return Math.max(vw / zoneW, vh / zoneH);
    },

    /** 순수함수(테스트 가능): pan 을 "경계(bbox) 화면 영역이 뷰포트를 항상 덮도록" 가둔다.
     *  zoom >= cover 배율일 때 범위가 유효(min<=max)하다. */
    clampPanToBoundary(pan, zoom, bbox, cw, ch, vw, vh) {
      if (!bbox || !cw || !ch || !vw || !vh || !(zoom > 0)) return pan;
      const x0 = (bbox.x / 100) * cw, y0 = (bbox.y / 100) * ch;
      const w0 = (bbox.w / 100) * cw, h0 = (bbox.h / 100) * ch;
      let minX = vw - zoom * (x0 + w0), maxX = -zoom * x0;
      let minY = vh - zoom * (y0 + h0), maxY = -zoom * y0;
      if (minX > maxX) { const mid = (minX + maxX) / 2; minX = maxX = mid; }
      if (minY > maxY) { const mid = (minY + maxY) / 2; minY = maxY = mid; }
      return {
        x: Math.max(minX, Math.min(maxX, pan.x)),
        y: Math.max(minY, Math.min(maxY, pan.y))
      };
    },

    /** applyTransform() 매 호출마다 경계를 강제한다(휠/드래그/flyTo/fit 전부 여길 거친다).
     *  ISO(3D 기울임)는 화면좌표 산식이 달라 대상에서 제외(경계 없이 종전 동작). */
    _enforceBoundary() {
      if (!this._cropBoundary || State.isoView) return;
      const cw = this.transform.offsetWidth, ch = this.transform.offsetHeight;
      const vw = this.viewport.clientWidth, vh = this.viewport.clientHeight;
      if (!cw || !ch || !vw || !vh) return;
      const minZ = this.computeCoverZoom(this._cropBoundary, vw, vh, cw, ch);
      if (!(minZ > 0)) return;
      this._boundaryFitZoom = minZ;
      const maxZ = Math.min(this.BOUNDARY_ZOOM_MAX_HARD, Math.max(8, minZ * this.BOUNDARY_ZOOM_HEADROOM));
      if (State.zoom < minZ) State.zoom = minZ;
      else if (State.zoom > maxZ) State.zoom = maxZ;
      const clamped = this.clampPanToBoundary(State.pan, State.zoom, this._cropBoundary, cw, ch, vw, vh);
      State.pan.x = clamped.x; State.pan.y = clamped.y;
    },

    /** F(화면 맞춤)를 경계로 리다이렉트 — 경계 활성 시 "새 페이지"(크롭)를 화면에 꽉 채운다. */
    _fitBoundary() {
      const b = this._cropBoundary;
      const cw = this.transform.offsetWidth, ch = this.transform.offsetHeight;
      const vw = this.viewport.clientWidth, vh = this.viewport.clientHeight;
      if (!cw || !ch || !vw || !vh) return;
      const z = this.computeCoverZoom(b, vw, vh, cw, ch);
      if (!(z > 0)) return;
      const x0 = (b.x / 100) * cw, y0 = (b.y / 100) * ch;
      const w0 = (b.w / 100) * cw, h0 = (b.h / 100) * ch;
      this._animateTo({
        z,
        x: (vw - w0 * z) / 2 - x0 * z,
        y: (vh - h0 * z) / 2 - y0 * z
      });
    },

    applyTransform() {
      this._enforceBoundary();
      const { x, y } = State.pan;
      // 이미지/뷰어(스냅샷) 모드에서는 CSS rotate 로 회전(디자이너 PDF 는 캔버스 재렌더로 처리하므로 0).
      const cssRot = (State.mode !== "viewer" && State.fileType === "pdf") ? 0 : (State.pdfRotation || 0);
      const rot = cssRot ? ` rotate(${cssRot}deg)` : "";
      // ISO 3D 아이소메트릭: 평면 도면을 입체로 기울여 회전(엔지니어링 ISO 뷰 느낌)
      // 4방향(0~3) = 북동/남동/남서/북서 코너 시점 → rotateZ 각도만 90° 간격으로 회전.
      const ISO_Z = [-32, 58, 148, 238];  // 4개 코너 시점(도)
      const iso = State.isoView ? ` rotateX(54deg) rotateZ(${ISO_Z[State.isoDir % 4]}deg)` : "";
      // translate3d 로 GPU 레이어 승격 (체감 속도 향상)
      this.transform.style.transform =
        `translate3d(${x}px, ${y}px, 0) scale(${State.zoom})${iso}${rot}`;
      // ── [마스터 요청] ISO(기울임)에서도 핀은 항상 "서 있게"(빌보드 3D) ──
      //   도면(map-transform)이 rotateX/rotateZ 로 눕는 만큼, 핀 마커에
      //   역회전(rotateZ -각 → rotateX -54deg)을 걸어 화면 기준 수직으로 세운다.
      this._applyPinBillboard();
      // [마스터] 구역 라벨도 핀처럼 부모 zoom 을 상쇄 → 확대해도 흐려지지 않고 크리스프
      try { if (typeof Zones !== "undefined" && Zones.updateLabelScale) Zones.updateLabelScale(); } catch (e) {}
      this._updateZoomLabel();
      // ── 벡터 원본 화질 보존: 줌이 오르면 그 배율로 원본을 다시 래스터화 ──
      // [P14 근본원인 2026-09-03] 종전 조건은 `State.mode !== "viewer"` 였다. 진짜 조건은
      //   모드가 아니라 **재렌더할 원본을 갖고 있는가** 다. 뷰어는 배포 스냅샷(비트맵)만
      //   갖고 있어 CSS 확대 = 뭉갬이었다 → 원본 PDF 를 지연 로드하면 뷰어도 선명해진다.
      if (this.hasRerenderSource()) {
        // 애니메이션(플라이/ISO/구역 확대)이 남아 있으면 그 잔여시간만큼 재렌더를 미룬다
        // → 애니메이션 중에는 부하 0, 끝난 뒤 최종 배율로 딱 한 번 고품질 렌더.
        PDF.requestZoomRerender(State.zoom, this._settleRemain());
      } else if (typeof App !== "undefined" && App.maybeLoadSourcePdf) {
        // 원본이 없다 → 스냅샷 해상도를 실제로 넘어섰을 때만 원본을 1회 지연 로드한다.
        App.maybeLoadSourcePdf(State.zoom);
      }
      // [화질] 확대가 끝나면 합성 힌트를 풀어, 브라우저가 현재 배율로 다시 래스터화하게 한다.
      this._scheduleSettle();
    },

    /* ── 확대 종료 후 화질 수렴(settle) ──────────────────────────────────
       will-change:transform 이 걸린 레이어는 브라우저가 "확대 전 해상도" 텍스처를
       재사용하는 경향이 있어, 특히 ISO(rotateX/rotateZ 3D) 아래에서 확대 결과가 흐릿하다.
       MDN 권고대로 "변화가 끝나면 will-change 를 제거"해 재래스터화를 유도한다.
       (조작이 다시 시작되면 즉시 되돌려 성능을 지킨다 — 아래 _armWillChange)
       ⚠ 정직 고지: 이 항목은 라이브 브라우저로 효과를 실측하지 못했다(코드/명세 근거만).
          되돌리려면 _scheduleSettle 호출 한 줄만 제거하면 된다. */
    SETTLE_IDLE_MS: 180,
    _settleUntil: 0,     // 진행 중인 CSS transition 종료 시각(performance.now 기준)
    _settleTimer: null,
    /** 진행 중 애니메이션의 남은 시간(ms) */
    _settleRemain() {
      const now = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
      if (this._flyRaf) return this.SETTLE_IDLE_MS;      // rAF 플라이: 매 프레임 리셋되므로 최소값
      return Math.max(0, this._settleUntil - now);
    },
    /** CSS transition 기반 애니메이션 시작을 알린다(focusZoneIso/_applyIso 공용) */
    _markAnimating(durationMs) {
      const now = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
      this._settleUntil = now + (durationMs || 0) + 40;
      this._armWillChange();
    },
    _armWillChange() {
      try { if (this.transform && this.transform.style.willChange !== "transform") this.transform.style.willChange = "transform"; } catch (e) {}
    },
    _scheduleSettle() {
      if (typeof setTimeout !== "function") return;
      this._armWillChange();
      clearTimeout(this._settleTimer);
      const wait = this.SETTLE_IDLE_MS + this._settleRemain();
      this._settleTimer = setTimeout(() => {
        if (this._flyRaf || State.panDragging) { this._scheduleSettle(); return; } // 아직 조작 중
        try { if (this.transform) this.transform.style.willChange = "auto"; } catch (e) {}
      }, wait);
    },

    /* ══ [화질] 보이는 도면 영역 산출 — 고해상도 크롭 렌더용 ══════════════════
       전면 캔버스 한 장으로는 대형 도면의 구역 확대를 감당할 수 없다(구조적 상한):
         A1(2384×1684pt) · 캔버스 한 변 상한 8192px → 최대 렌더 배율 ≈ 3.44
         → dpr 2 화면에서 선명함이 유지되는 줌은 ≈1.7배까지. 구역 확대는 4~8배다.
       그래서 확대가 끝나면 "지금 보이는 영역만" 그 배율로 다시 그려 위에 얹는다
       (02_PDF.renderCrop). 크롭 면적은 뷰포트 크기로 자연히 묶여 메모리가 안 터진다. */
    ISO_ANGLES: [-32, 58, 148, 238],   // applyTransform 의 ISO_Z 와 같은 값(코너 시점 4종)
    ISO_TILT_DEG: 54,                  // applyTransform 의 rotateX(54deg)

    /** 도면 로컬좌표(px) → 화면좌표(px). applyTransform 과 같은 모델.
     *  ⚠ CSS perspective(2600px)는 무시하는 직교 근사다 — focusZoneIso 가 중앙정렬에
     *     쓰는 것과 동일한 근사이며, 그래서 크롭 영역에 넉넉한 여백(pad)을 준다.
     *  순수 함수(테스트 가능). */
    projectPoint(lx, ly, o) {
      const z = o.zoom, px = o.panX, py = o.panY;
      if (!o.iso) return { x: px + z * lx, y: py + z * ly };
      const th = (o.isoAngleDeg || 0) * Math.PI / 180;
      const cs = Math.cos(th), sn = Math.sin(th);
      const tilt = (o.tiltDeg == null ? this.ISO_TILT_DEG : o.tiltDeg) * Math.PI / 180;
      const cosX = Math.cos(tilt);
      return { x: px + z * (lx * cs - ly * sn), y: py + z * ((lx * sn + ly * cs) * cosX) };
    },

    /** 뷰포트에 실제로 보이는 도면 영역 (0~1 비율 {x,y,w,h}). 순수 함수.
     *  역행렬 대신 전진 투영 격자 표본을 쓴다: ISO(3D+perspective) 역변환은 정확히 풀 수 없고,
     *  근사 역행렬은 "조용히 틀린 영역"을 그린다. 표본은 둔하지만 틀리지 않는다.
     *  ponytail: O(n²) 격자(97×97≈9.4k, 확대 종료 시 1회만). 정밀도가 더 필요하면 N만 올린다. */
    computeVisibleRect(o) {
      const N = o.grid || 96;
      const pad = (o.pad == null ? 0.25 : o.pad);
      const cw = o.contentW, ch = o.contentH, vw = o.viewW, vh = o.viewH;
      const FULL = { x: 0, y: 0, w: 1, h: 1 };
      if (!(cw > 0 && ch > 0 && vw > 0 && vh > 0)) return FULL;
      let x0 = 1, y0 = 1, x1 = 0, y1 = 0, hit = 0;
      for (let i = 0; i <= N; i++) {
        const u = i / N, lx = u * cw;
        for (let j = 0; j <= N; j++) {
          const v = j / N;
          const p = this.projectPoint(lx, v * ch, o);
          if (p.x < 0 || p.y < 0 || p.x > vw || p.y > vh) continue;
          hit++;
          if (u < x0) x0 = u;
          if (u > x1) x1 = u;
          if (v < y0) y0 = v;
          if (v > y1) y1 = v;
        }
      }
      // 표본이 거의 안 잡히면(격자보다 좁은 영역 등) 전면으로 안전하게 폴백한다.
      if (hit < 2) return FULL;
      const mx = (x1 - x0) * pad + 1 / N;
      const my = (y1 - y0) * pad + 1 / N;
      x0 = Math.max(0, x0 - mx); x1 = Math.min(1, x1 + mx);
      y0 = Math.max(0, y0 - my); y1 = Math.min(1, y1 + my);
      return { x: x0, y: y0, w: Math.max(0.01, x1 - x0), h: Math.max(0.01, y1 - y0) };
    },

    /** [WO 20260917] 핀 표시좌표 변환 — 페이지 기준 %(pin.x/y 저장 형식) → 구역 크롭 기준 %.
     *  순수 함수(테스트 가능) · 저장값(x,y)은 변경하지 않고 새 좌표만 반환한다.
     *  crop 없으면 항등(변환 없음, 종전대로 페이지 전체 기준). 크롭 밖이면 null(표시 안 함). */
    pageToDeckCropPct(x, y, crop) {
      if (!crop || !(crop.w > 0) || !(crop.h > 0)) return { x, y };
      if (x < crop.x || x > crop.x + crop.w || y < crop.y || y > crop.y + crop.h) return null;
      return { x: (x - crop.x) / crop.w * 100, y: (y - crop.y) / crop.h * 100 };
    },

    /** 역변환 — 크롭 기준 표시 % → 페이지 기준 %(저장용). 순수 함수.
     *  🔴 새 핀을 크롭 화면에서 찍을 때 반드시 이 함수로 되돌려 저장해야
     *  기존 페이지 기준 % 저장 형식(마이그레이션 없음)과 어긋나지 않는다. */
    deckCropPctToPage(x, y, crop) {
      if (!crop || !(crop.w > 0) || !(crop.h > 0)) return { x, y };
      return { x: crop.x + (x / 100) * crop.w, y: crop.y + (y / 100) * crop.h };
    },

    /** 현재 화면 기준 보이는 도면 영역 (PDF.renderCrop 입력) */
    visibleDrawingRect() {
      if (!this.viewport || !this.transform) return null;
      return this.computeVisibleRect({
        contentW: this.transform.offsetWidth, contentH: this.transform.offsetHeight,
        viewW: this.viewport.clientWidth, viewH: this.viewport.clientHeight,
        zoom: State.zoom, panX: State.pan.x, panY: State.pan.y,
        iso: !!State.isoView, isoAngleDeg: this.ISO_ANGLES[(State.isoDir || 0) % 4]
      });
    },

    /** ISO 3D 뷰 — 4방향 순환:
     *  평면 → 북동(0) → 남동(1) → 남서(2) → 북서(3) → 평면 …
     *  버튼을 누를 때마다 한 단계씩 코너 시점을 회전한다. */
    ISO_LABELS: ["북동", "남동", "남서", "북서"],
    /** ISO → 평면 강제 복귀(영역 그리기 등 평면 좌표가 필요한 작업 진입 시) */
    exitIso() {
      if (!State.isoView) return;
      State.isoView = false; State.isoDir = 0;
      this._applyIso();
    },
    toggleIso() {
      // [마스터 버그] 영역 그리는 중엔 ISO(원근)에서 클릭좌표가 틀어지므로 ISO 진입 금지
      if (!State.isoView && State.drawingZone) {
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("영역을 다 그린 뒤 ISO 보기를 켜주세요 (정확한 좌표 위해)");
        return;
      }
      // [마스터 버그] 배치 모드 중엔 ISO(원근)에서 클릭좌표가 틀어지므로 ISO 진입 금지 → 배치 먼저 종료
      if (!State.isoView && State.placing && typeof App !== "undefined" && App._togglePlacing) {
        App._togglePlacing();  // 배치 종료(평면 유지)
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("핀 배치를 끝낸 뒤 ISO 보기를 켜주세요 (정확한 배치 위해)");
        return;
      }
      if (!State.isoView) {
        // 평면 → ISO 진입(북동부터)
        State.isoView = true; State.isoDir = 0;
      } else if (State.isoDir < 3) {
        // 다음 코너로 회전
        State.isoDir += 1;
      } else {
        // 마지막 코너에서 한 번 더 → 평면 복귀
        State.isoView = false; State.isoDir = 0;
      }
      this._applyIso();
    },
    /** 특정 코너 시점으로 직접 전환 (0~3). */
    setIsoDir(dir) {
      State.isoView = true;
      State.isoDir = ((dir % 4) + 4) % 4;
      this._applyIso();
    },
    /** ISO 버튼/뷰포트 클래스 동기화(공용 — toggleIso·focusZoneIso 둘 다 사용) */
    _syncIsoButtons() {
      ["btn-iso", "tb-iso", "mnav-iso"].forEach((bid) => {
        const btn = document.getElementById(bid);
        if (!btn) return;
        btn.classList.toggle("active", State.isoView);
        try {
          const base = btn.dataset.baseLabel || (btn.dataset.baseLabel = (btn.getAttribute("title") || "ISO"));
          btn.setAttribute("title", State.isoView ? (base + " · " + this.ISO_LABELS[State.isoDir]) : base);
        } catch (e) {}
      });
      if (this.viewport) this.viewport.classList.toggle("iso-active", State.isoView);
    },
    _applyIso() {
      const vp = this.viewport, tr = this.transform;
      this._syncIsoButtons();
      // [토스트 스팸 제거] ISO 시점/평면 복귀는 화면 자체가 즉시 바뀌어 결과가 보인다.
      // 버튼 반복 클릭(4방향 회전)마다 토스트가 쌓여 검은 박스 스택의 주범이었다 → 제거.
      const size = this._contentSize();
      if (tr) {
        tr.style.transition = "transform 1s cubic-bezier(.16,1,.3,1)";
        { const _pl = document.getElementById("pins-layer"); if (_pl) _pl.classList.add("iso-animating"); }
        if (State.isoView && size) {
          const vw = this.viewport.clientWidth, vh = this.viewport.clientHeight;
          const z = Math.min(vw / size.w, vh / size.h) * 0.62; // 입체 변형 고려 여유 축소
          State.zoom = z;
          State.pan = { x: (vw - size.w * z) / 2, y: (vh - size.h * z) / 2 + vh * 0.04 };
        }
        this._markAnimating(1010); // 전환 끝난 뒤 최종 배율로 1회 고품질 재렌더
        this.applyTransform();
        setTimeout(() => { try { tr.style.transition = ""; } catch (e) {} const _pl = document.getElementById("pins-layer"); if (_pl) _pl.classList.remove("iso-animating"); }, 1050);
      }
    },

    /** ISO 뷰에서 핀 마커를 화면 기준 수직(빌보드)으로 세운다.
     *  · 평면 뷰  : 핀 보정 없음(원래대로 도면에 누움 — 평면이라 무관)
     *  · ISO 뷰   : 도면 rotateX(54)·rotateZ(θ) 의 역(rotateZ(-θ)·rotateX(-54))을
     *               각 핀에 적용 → 핀 머리는 항상 위, 바늘은 항상 아래로 "서 있음".
     *    핀 tip(바늘 끝, viewBox 18/64 ≒ 하단)이 좌표에 박히도록 transform-origin 도 하단 중앙. */
    /** [마스터 2026-08-31] 핀 크기 = 도면 대비 "완전 고정"(1/zoom 전체 상쇄)이 아니라
     *  "부분 보정"(1/zoom 의 지수 k 승)으로 바꿈. 이유: 완전 고정이면 줌아웃 시 핀이
     *  도면과 함께 작아지지 않아 도면 대비 과도하게 커 보임(마스터 스샷 1번 지적).
     *  대신 지수 k(0~1)만큼만 상쇄 → 줌아웃하면 핀도 어느 정도 같이 작아지되(k<1이라
     *  1/zoom 만큼 다 커지진 않음), 줌인해도 너무 작아지지 않는 절충.
     *  ISO/평면 두 경로가 pinScreenScale() 하나를 공유 → 상수만 바꾸면 전체 반영. */
    PIN_SCALE: 2,           // 기준 줌(zoom=1)에서의 핀 배율 — 마스터가 "적당하다"고 한 크기
    PIN_SCALE_EXP: 0.6,     // 줌 보정 지수(0=보정 없음=도면과 완전히 같이 축소, 1=기존처럼 화면상 완전 고정)
    PIN_MIN_SCALE: 0.8,     // 최종 배율 하한 — 줌인해도 핀이 이보다 작아지지 않음(가독성 하한)
    PIN_MAX_SCALE: 4.5,     // 최종 배율 상한 — 줌아웃해도 핀이 이보다 커지지 않음(도면 대비 과대 방지)
    pinScreenScale() {
      const zoom = State.zoom || 1;
      const raw = this.PIN_SCALE * Math.pow(1 / zoom, this.PIN_SCALE_EXP); // 부분 역스케일
      return Math.max(this.PIN_MIN_SCALE, Math.min(this.PIN_MAX_SCALE, raw));
    },
    _applyPinBillboard() {
      const layer = document.getElementById("pins-layer");
      if (!layer) return;
      const inv = this.pinScreenScale();
      const ISO_Z = [-32, 58, 148, 238];
      if (State.isoView) {
        const z = ISO_Z[State.isoDir % 4];
        // ── [마스터] 진짜 3D 박힌 핀(2D 카드 아님) ──
        //  도면은 rotateX(54)·rotateZ(z)로 기운다. 핀을 화면 정면으로 완전히 눕히면(rotateX(-54))
        //  납작한 2D 카드가 된다. 대신:
        //   · rotateZ(-z): 시점(평면 법선)축 회전만 상쇄 → 번호는 항상 정면(어느 ISO 방향서도 동일).
        //   · rotateX(-22): 도면 pitch(54)를 부분만 상쇄 → 최종 화면 pitch 54-22 = 32° 기립.
        //  결과: 바늘 tip(하단)은 땅(도면 평면)에 박히고, 머리는 평면 위로 솟아 "서 있는" 입체.
        //  preserve-3d + origin 하단 → 머리가 +Z로 떠 도면 위로 입체감(시점 무관 32° 동일, 행렬 검증).
        const billboard =
          `translate(-50%, calc(-100% + 2px)) rotateZ(${-z}deg) rotateX(-22deg) scale(${(inv * 1.18).toFixed(3)})`;
        layer.style.transformStyle = "preserve-3d";
        for (const m of layer.children) {
          m.style.transformOrigin = "50% 100%";   // 바늘 끝(하단 중앙) = 땅에 박히는 지점
          m.style.transformStyle = "preserve-3d"; // 마커 내부도 3D 보존(머리가 +Z로 솟음)
          m.style.transform = billboard;
          m.style.zIndex = "20";                   // 기울인 도면 위로 핀을 띄움
        }
      } else {
        // 평면: 역스케일만(화면상 일정 크기 → 또렷 + 줌아웃 시 약간 확대)
        const flat = `translate(-50%, calc(-100% + 2px)) scale(${inv.toFixed(3)})`;
        for (const m of layer.children) {
          m.style.transformOrigin = "50% 100%";
          m.style.transform = flat;
          m.style.zIndex = "";
        }
      }
    },

    _updateZoomLabel() {
      const pct = Math.round(State.zoom * 100) + "%";
      const el = document.getElementById("zoom-level");
      if (el) el.textContent = pct;
      const tb = document.getElementById("tb-zoom-level");
      if (tb) tb.textContent = pct;
    },

    /** 도면 콘텐츠의 "논리(CSS) 크기" — 줌/팬 계산용.
     *  PDF 캔버스는 내부 픽셀(width)이 dpr·줌에 따라 달라지므로,
     *  레이아웃상 차지하는 CSS 크기(style.width/offsetWidth)를 기준으로 한다. */
    _contentSize() {
      const cv = document.getElementById("pdf-canvas");
      const img = document.getElementById("map-image");
      if (cv && !cv.classList.contains("hidden") && cv.width) {
        // CSS 크기 우선(고해상도 재렌더와 무관하게 일정). 미설정 시 픽셀 폴백.
        const w = parseFloat(cv.style.width)  || cv.offsetWidth  || cv.width;
        const h = parseFloat(cv.style.height) || cv.offsetHeight || cv.height;
        return { w, h };
      }
      if (img && !img.classList.contains("hidden") && img.naturalWidth)
        return { w: img.naturalWidth, h: img.naturalHeight };
      return null;
    },

    /** 뷰포트 중심 기준으로 배율 변경 (부드러운 줌) */
    zoomBy(factor, cx, cy) {
      this.cancelFly();
      const rect = this.viewport.getBoundingClientRect();
      const mx = (cx != null ? cx : rect.left + rect.width / 2) - rect.left;
      const my = (cy != null ? cy : rect.top + rect.height / 2) - rect.top;
      const newZoom = Math.max(0.2, Math.min(8, State.zoom * factor));
      const f = newZoom / State.zoom;
      State.pan.x = mx - f * (mx - State.pan.x);
      State.pan.y = my - f * (my - State.pan.y);
      State.zoom = newZoom;
      this.applyTransform();
    },

    /** 화면 맞춤 — 도면 전체가 뷰포트에 들어오도록.
     *  [WO 20260928-crop] 구역 경계가 활성(구역이 "새 페이지"로 열려 있음)이면
     *  원본 전체가 아니라 그 경계를 화면에 꽉 채운다(요구④). */
    fit() {
      this.cancelFly();
      if (this._cropBoundary) { this._fitBoundary(); return; }
      const size = this._contentSize();
      if (!size) return;
      const vw = this.viewport.clientWidth;
      const vh = this.viewport.clientHeight;
      const pad = 0.92; // 여백
      const z = Math.min(vw / size.w, vh / size.h) * pad;
      this._animateTo({
        z,
        x: (vw - size.w * z) / 2,
        y: (vh - size.h * z) / 2
      });
    },

    /** 실제 크기 (1:1, 100%) — 중앙 정렬 */
    actualSize() {
      this.cancelFly();
      const size = this._contentSize();
      if (!size) return;
      const vw = this.viewport.clientWidth;
      const vh = this.viewport.clientHeight;
      this._animateTo({ z: 1, x: (vw - size.w) / 2, y: (vh - size.h) / 2 });
    },

    /** pan/zoom 목표값으로 부드럽게 이동 */
    _animateTo(to, duration = 380) {
      const from = { x: State.pan.x, y: State.pan.y, z: State.zoom };
      const t0 = performance.now();
      const ease = t => 1 - Math.pow(1 - t, 3);
      this.cancelFly();
      const step = now => {
        const t = Math.min(1, (now - t0) / duration);
        const k = ease(t);
        State.pan.x = from.x + (to.x - from.x) * k;
        State.pan.y = from.y + (to.y - from.y) * k;
        State.zoom  = from.z + (to.z - from.z) * k;
        this.applyTransform();
        if (t < 1) this._flyRaf = requestAnimationFrame(step);
        else this._flyRaf = null;
      };
      this._flyRaf = requestAnimationFrame(step);
    },

    viewportToPercent(clientX, clientY) {
      const tRect = this.transform.getBoundingClientRect();
      if (!tRect.width || !tRect.height) return null;
      const localX = clientX - tRect.left;
      const localY = clientY - tRect.top;
      return {
        x: Math.max(0, Math.min(100, (localX / tRect.width) * 100)),
        y: Math.max(0, Math.min(100, (localY / tRect.height) * 100))
      };
    },

    handleWheel(e) {
      e.preventDefault();
      this.cancelFly();
      const delta = -e.deltaY * 0.001;
      const newZoom = Math.max(0.3, Math.min(8, State.zoom + delta * State.zoom));
      const rect = this.viewport.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const f = newZoom / State.zoom;
      State.pan.x = mx - f * (mx - State.pan.x);
      State.pan.y = my - f * (my - State.pan.y);
      State.zoom = newZoom;
      this.applyTransform();
    },

    handlePanStart(e) {
      if (State.placing) return;
      this.cancelFly();
      State.panDragging = true;
      State.panStart = { mx: e.clientX, my: e.clientY, px: State.pan.x, py: State.pan.y };
      this.viewport.style.cursor = "grabbing";
    },
    handlePanMove(e) {
      if (!State.panDragging) return;
      State.pan.x = State.panStart.px + (e.clientX - State.panStart.mx);
      State.pan.y = State.panStart.py + (e.clientY - State.panStart.my);
      this.applyTransform();
    },
    handlePanEnd() {
      State.panDragging = false;
      this.viewport.style.cursor = State.placing ? "crosshair" : "grab";
    },

    /** 핀 위치(% 좌표)로 부드럽게 줌인 이동 (플라이투) */
    flyTo(xPct, yPct, targetZoom = 2.2, duration = 750) {
      this.cancelFly();
      const cw = this.transform.offsetWidth;
      const ch = this.transform.offsetHeight;
      const vw = this.viewport.clientWidth;
      const vh = this.viewport.clientHeight;
      if (!cw || !ch || !vw || !vh) return;

      const from = { x: State.pan.x, y: State.pan.y, z: State.zoom };
      const to = {
        x: vw / 2 - targetZoom * (xPct / 100) * cw,
        y: vh / 2 - targetZoom * (yPct / 100) * ch,
        z: targetZoom
      };
      const t0 = performance.now();
      const ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

      const step = now => {
        const t = Math.min(1, (now - t0) / duration);
        const k = ease(t);
        State.pan.x = from.x + (to.x - from.x) * k;
        State.pan.y = from.y + (to.y - from.y) * k;
        State.zoom  = from.z + (to.z - from.z) * k;
        this.applyTransform();
        if (t < 1) this._flyRaf = requestAnimationFrame(step);
        else this._flyRaf = null;
      };
      this._flyRaf = requestAnimationFrame(step);
    },
    cancelFly() {
      if (this._flyRaf) { cancelAnimationFrame(this._flyRaf); this._flyRaf = null; }
    },

    /** 구역(zone bbox %)을 화면에 꽉 차게 확대(crop-view). 구역 페이지 진입에 사용.
     *  bbox: {x,y,w,h} (% 단위). pad: 여백 비율(0.12 = 12%). */
    fitZone(bbox, pad = 0.12, duration = 620) {
      if (!bbox || !(bbox.w > 0) || !(bbox.h > 0)) return;
      const vw = this.viewport.clientWidth, vh = this.viewport.clientHeight;
      const cw = this.transform.offsetWidth, ch = this.transform.offsetHeight;
      if (!vw || !vh || !cw || !ch) return;
      // 구역의 픽셀 크기(줌1 기준) = (w% / 100) * cw
      const zoneW = (bbox.w / 100) * cw;
      const zoneH = (bbox.h / 100) * ch;
      // 패딩 포함해 화면에 맞추는 배율 (가로/세로 중 더 빡빡한 쪽)
      const padK = 1 - Math.max(0, Math.min(0.4, pad));
      let z = Math.min((vw * padK) / zoneW, (vh * padK) / zoneH);
      z = Math.max(0.3, Math.min(8, z)); // MapCtrl 줌 한계 내로
      const cx = bbox.x + bbox.w / 2;
      const cy = bbox.y + bbox.h / 2;
      this.flyTo(cx, cy, z, duration);
      return z;
    },

    /** [핀 선택 → ISO 영역확대] ISO 3D를 켜고, 구역(bbox %)이 화면 중앙에 꽉 차도록 줌/팬.
     *  fitZone 과 달리 ISO 변형(rotateX54·rotateZθ, transform-origin 0 0, 직교투영)을
     *  역산해 정확히 중앙 정렬한다. 회전·팬·줌을 CSS transition 으로 한 번에 부드럽게.
     *  bbox:{x,y,w,h}(%), pad: 여백(0.2=20%). 이후 사용자는 휠/버튼으로 자유 확대·축소. */
    focusZoneIso(bbox, pad = 0.2, duration = 700) {
      if (!bbox || !(bbox.w > 0) || !(bbox.h > 0)) return;
      const vw = this.viewport.clientWidth, vh = this.viewport.clientHeight;
      const cw = this.transform.offsetWidth, ch = this.transform.offsetHeight;
      if (!vw || !vh || !cw || !ch) return;
      // ISO 켜기(이미 켜져 있으면 현재 코너 시점 유지, 새로 진입하면 북동=0)
      if (!State.isoView) { State.isoView = true; State.isoDir = 0; }
      const ISO_Z = [-32, 58, 148, 238];
      const th = ISO_Z[State.isoDir % 4] * Math.PI / 180;
      const cs = Math.cos(th), sn = Math.sin(th);
      const cosX = Math.cos(54 * Math.PI / 180); // rotateX(54°) → 화면 Y 단축계수(≈0.588)
      // 구역의 도면 로컬 px(줌1 기준)
      const lw = (bbox.w / 100) * cw, lh = (bbox.h / 100) * ch;
      // rotateZ 회전 후 화면정렬 바운딩 박스(Y는 rotateX 로 단축)
      const bw = Math.abs(lw * cs) + Math.abs(lh * sn);
      const bh = (Math.abs(lw * sn) + Math.abs(lh * cs)) * cosX;
      const padK = 1 - Math.max(0, Math.min(0.4, pad));
      let z = Math.min((vw * padK) / bw, (vh * padK) / bh);
      z = Math.max(0.3, Math.min(8, z)); // 줌 한계 내
      // 구역 중심의 로컬 px → ISO 변환 후 화면좌표(origin 0,0): 직교투영이라 Z 무시
      const lx = ((bbox.x + bbox.w / 2) / 100) * cw;
      const ly = ((bbox.y + bbox.h / 2) / 100) * ch;
      const sx = lx * cs - ly * sn;
      const sy = (lx * sn + ly * cs) * cosX;
      // 중심을 뷰포트 중앙(vw/2,vh/2)에 두는 pan (translate 는 scale·rotate 바깥)
      this.cancelFly();
      State.zoom = z;
      State.pan = { x: vw / 2 - z * sx, y: vh / 2 - z * sy };
      const tr = this.transform;
      try { tr.style.transition = "transform " + (duration / 1000) + "s cubic-bezier(.16,1,.3,1)"; } catch (e) {}
      { const _pl = document.getElementById("pins-layer"); if (_pl) _pl.classList.add("iso-animating"); }
      // 구역 확대(ISO)는 CSS transition 이라 프레임 콜백이 없다 → 전환 종료 시각을 명시적으로 알린다.
      // 이게 없으면 재렌더가 전환 도중(140ms)에 돌아 애니메이션이 끊기고, 최종 배율도 아닌 값으로 그려진다.
      this._markAnimating(duration);
      this.applyTransform();
      this._syncIsoButtons();
      setTimeout(() => { try { tr.style.transition = ""; } catch (e) {} const _pl = document.getElementById("pins-layer"); if (_pl) _pl.classList.remove("iso-animating"); }, duration + 40);
      return z;
    }
  };

  /* ══════════════════════════════════════════
     UI UTILITIES
  ══════════════════════════════════════════ */
  const UI = {
    $:  id  => document.getElementById(id),

    show(id)  { this.$(id).classList.remove("hidden"); },
    hide(id)  { this.$(id).classList.add("hidden");    },
    toggle(id, force) {
      const el = this.$(id);
      if (force === undefined) el.classList.toggle("hidden");
      else force ? el.classList.remove("hidden") : el.classList.add("hidden");
    },
    text(id, val)  { const el = this.$(id); if (el) el.textContent = val; },
    val(id)        { return this.$(id).value; },
    clearVal(id)   { this.$(id).value = ""; },
    enable(id)     { this.$(id).disabled = false; },
    disable(id)    { this.$(id).disabled = true; },

    showScreen(name) {
      document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
      this.$(name).classList.add("active");
    },

    escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, c =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    },

    /** [항목3] 포인트 목록 펼침/접힘 토글 (아이콘 헤더/닫기 버튼 공용) */
    togglePinList(force) {
      const wrap = this.$("section-pin-list");
      const toggle = this.$("pin-list-toggle");
      if (!wrap) return;
      const willOpen = (force === undefined) ? wrap.classList.contains("collapsed") : !!force;
      wrap.classList.toggle("collapsed", !willOpen);
      if (toggle) toggle.setAttribute("aria-expanded", willOpen ? "true" : "false");
    },

    /** 헤더 옆 카운트 배지 갱신 */
    _updatePinListCount(n) {
      const c = this.$("pin-list-count");
      if (!c) return;
      c.textContent = n;
      c.classList.toggle("hidden", !n);
    },

    renderPinList() {
      const list  = this.$("pin-list");
      const empty = this.$("pin-empty");
      const badge = this.$("pin-count-badge");
      this._updatePinListCount(State.pins ? State.pins.length : 0);
      // [버그수정] 도면 미로드 화면(허브 등)에서 Notes.loadSummary→renderPinList 호출 시 요소 부재 → 가드
      if (!list) return;
      list.innerHTML = "";

      if (!State.pins || State.pins.length === 0) {
        empty.classList.remove("hidden");
        badge.classList.add("hidden");
        this.hide("section-export");
        if (typeof AllPins !== "undefined") { AllPins.syncButton(); if (AllPins.open) AllPins.render(); }
        if (typeof PinGrid !== "undefined") PinGrid.render();
        return;
      }
      empty.classList.add("hidden");
      badge.textContent = State.pins.length + " PINS";
      badge.classList.remove("hidden");
      if (State.mode === "designer") this.show("section-export");

      const totalPages = State.mode === "viewer"
        ? (State.viewerPages ? State.viewerPages.length : 1)
        : State.pdfPages;

      // 다중 페이지 도면: 현재 페이지의 핀만 목록에 표시(페이지별 완벽 구분)
      const curPage = State.pdfPage || 1;
      const isMulti = totalPages > 1;
      const visiblePins = isMulti
        ? State.pins.filter(p => (p.page || 1) === curPage)
        : State.pins;
      // 🔴 [2026-09-17] 번호 중복 탐지 전용(표시만) — 자동 재채번 금지(마스터 명시).
      //   정본 = PinSeries.duplicateCheckboardIds (11_UI 도면 마커도 같은 함수를 쓴다).
      const dupPinIds = (typeof PinSeries !== "undefined") ? PinSeries.duplicateCheckboardIds(State.pins, curPage) : new Set();

      // 현재 페이지에 핀이 없으면 안내(다른 페이지에 핀이 있을 수 있음)
      if (isMulti && visiblePins.length === 0) {
        const other = State.pins.length;
        empty.classList.remove("hidden");
        const et = empty.querySelector(".pin-empty-sub") || empty;
        list.innerHTML = `<p class="pin-empty-page">현재 페이지(P${curPage})에 등록된 포인트가 없습니다.${other ? ` 다른 페이지에 ${other}개의 포인트가 있습니다.` : ""}</p>`;
        badge.textContent = State.pins.length + " PINS";
        badge.classList.remove("hidden");
        if (State.mode === "designer") this.show("section-export");
        if (typeof AllPins !== "undefined") { AllPins.syncButton(); if (AllPins.open) AllPins.render(); }
        if (typeof PinGrid !== "undefined") PinGrid.render();
        return;
      }

      visiblePins.forEach((pin, idx) => {
        const item = document.createElement("div");
        item.className = "pin-item" + (State.activePin === pin.id ? " active" : "");
        item.dataset.id = pin.id;
        const pageTag = (totalPages > 1) ? ` · P${pin.page || 1}` : "";
        const cloudTag = pin.imageId ? ' <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12" aria-hidden="true" style="vertical-align:-1px;opacity:.7"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>' : "";
        // 노트/첨부 메타 아이콘
        const noteIco = pin.note ? `<svg viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>` : "";
        const attCount = pin.attachments ? pin.attachments.length : 0;
        const attIco = attCount ? `<svg viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>` : "";
        const metaIcons = (noteIco || attIco)
          ? `<span class="pin-meta-icons">${noteIco}${attIco}${attCount > 1 ? attCount : ""}</span>` : "";
        // 미해결 이슈 카운트 뱃지(이슈/필드노트)
        const openIssues = (typeof Notes !== "undefined") ? Notes.openCountFor(pin.id) : 0;
        const issueBadge = openIssues > 0
          ? `<span class="pin-issue-badge" title="미해결 이슈 ${openIssues}건">${openIssues}</span>` : "";
        // 🔴 [2026-09-17] 번호 중복 경고(표시만 — 자동 재채번 금지, 마스터 명시)
        const dupBadge = dupPinIds.has(pin.id)
          ? `<span class="pin-dup-badge" title="번호 중복 — 현장 확인 후 직접 수정하세요">중복</span>` : "";

        if (State.mode === "designer") {
          item.innerHTML = `
            <div class="pin-num">${idx + 1}</div>
            <div class="pin-info">
              <div class="pin-name">${this.escapeHtml(pin.label)}${cloudTag}${metaIcons}${issueBadge}${dupBadge}</div>
              <div class="pin-coords">${pin.x.toFixed(1)}%, ${pin.y.toFixed(1)}%${pageTag}</div>
            </div>
            <div class="pin-acts">
              <button class="pin-act pin-edit" data-id="${pin.id}" title="수정" aria-label="수정">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
              </button>
              <button class="pin-act pin-del" data-id="${pin.id}" title="삭제" aria-label="삭제">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
              </button>
            </div>`;
          item.querySelector(".pin-edit").addEventListener("click", e => {
            e.stopPropagation();
            App.editPin(pin.id);
          });
          item.querySelector(".pin-del").addEventListener("click", e => {
            e.stopPropagation();
            App.deletePin(pin.id);
          });
          // 디자이너 모드: 콘텐츠 있는 핀은 이동+오픈, 없는 핀은 CAD 인스펙터 상세 표시
          item.addEventListener("click", () => {
            if (App.pinHasContent(pin)) App.focusPin(pin, true);
            else if (typeof Inspector !== "undefined") { App.focusPin(pin, false); Inspector.showPin(pin); }
            else App.focusPin(pin, false);
          });
        } else {
          item.innerHTML = `
            <div class="pin-num">${idx + 1}</div>
            <div class="pin-info">
              <div class="pin-name">${this.escapeHtml(pin.label)}${cloudTag}${metaIcons}${issueBadge}</div>
              <div class="pin-coords">${pin.x.toFixed(1)}%, ${pin.y.toFixed(1)}%${pageTag}</div>
            </div>
            <span class="pin-arrow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg></span>`;
          item.addEventListener("click", () => App.focusPin(pin, true));
        }
        list.appendChild(item);
      });
      if (typeof AllPins !== "undefined") { AllPins.syncButton(); if (AllPins.open) AllPins.render(); }
      if (typeof PinGrid !== "undefined") PinGrid.render();
      this.renderTree();
    },

    /* [사이드바 재구성] 🔴 마스터 확정 계층(2026-09-21 정정 — 3단):
         프로젝트 > 구역(parent_id IS NULL 인 deck) > 영역(parent_id = 구역 id 인 deck) > 핀
       데이터(Projects.currentProject / Projects.decks / State.zones / State.pins)를 읽어 렌더,
       이벤트는 기존 함수(Projects.selectDeck / Zones.focus / App.focusPin)에 그대로 위임한다.

       [WO 20260921-tree3] 🔴 "도면"은 트리 단계가 아니다(마스터 정정):
         · 직전 커밋(eeeab36)이 세운 4단(프로젝트>도면>구역>영역)을 3단으로 되돌린다.
         · decks.parent_id(마이그레이션 0025, 프로덕션 적용 완료)는 그대로 쓴다 —
           parent_id NULL = 구역, parent_id 있음 = 영역. 이 구조는 3단과 정확히 맞는다.
         · 🔴 도면 출처 정보는 버리지 않는다 — 트리 "단"에서 빼고(2026-09-28: 부가 라벨도
           같은 파일명이 반복되며 이름을 가려 마스터가 재지적 → title 툴팁으로 재이동),
           구역/영역 노드의 head.title(docLabel())로 남긴다(아래 deckNode 참조).
         · 도면 이름 정본 = API 가 JOIN 해 준 deployment_file_name/deployment_title.
           없으면 현재 로드된 도면의 State.fileName, 그래도 없으면 일반 표기("등록 도면").
           🔴 없는 이름을 지어내지 않는다.
         · parent_id 가 가리키는 부모가 목록에 없으면(삭제됨) 최상위로 승격 — 숨기지 않는다.

       [WO 20260917-pin] 마스터 지시("항상 리스트가 보이게, 모든 항목에 대해") — 조건부 숨김 없음:
         · 구역/영역: 항상 전체 표시(필터 없음).
         · 영역JSON(State.zones)/핀: 전체 페이지를 항상 표시하고, 현재 페이지 항목만 .active 로 "구분"한다.
         · 로드되지 않은 구역(다른 배포본)은 클라이언트에 zone/pin 데이터 자체가 없으므로
           개수 배지를 붙이지 않는다(하드코딩 금지 — 없는 값을 0으로 지어내지 않는다). */
    /** [WO 20260928-hub-tree] 🔴 공유 지점(SoT) — 구역/영역 분류 규칙은 여기 한 곳에만 둔다.
     *  사이드바 트리(renderTree, 아래)와 허브 카드(12_ProjectHub.js)가 이 함수를 함께 쓴다.
     *  parent_id 가 가리키는 부모가 없거나(삭제됨) 자기참조면 최상위로 승격(숨김 금지).
     *  @param {Array} decks
     *  @returns {{roots: Array, childrenOf: Map<string, Array>}} */
    groupDecksByParent(decks) {
      decks = decks || [];
      const byId = new Map();
      decks.forEach((d) => byId.set(String(d.id), d));
      const parentKey = (d) => {
        const pid = d.parent_id != null ? String(d.parent_id) : "";
        return (pid && pid !== String(d.id) && byId.has(pid)) ? pid : "";
      };
      const childrenOf = new Map();
      decks.forEach((d) => {
        const pid = parentKey(d);
        if (!pid) return;
        if (!childrenOf.has(pid)) childrenOf.set(pid, []);
        childrenOf.get(pid).push(d);
      });
      const roots = decks.filter((d) => !parentKey(d));
      return { roots, childrenOf };
    },

    /** [WO 20260929-tree-label] 🔴 공유 지점(SoT) — 트리 라벨은 항상 deck.name(파일명이 아니다).
     *  마스터 지적: "이 트리가 제대로 제목이 안나오잖아" — 사이드바 트리(renderTree)와 허브 카드
     *  트리(12_ProjectHub.js)가 각자 이름 폴백을 따로 구현하면 반드시 갈라진다(§5) — 이 함수 하나만 쓴다.
     *  @returns {string} 이스케이프된 HTML — 이름 있으면 그대로, 없으면 "(이름 없음)" */
    deckLabelHtml(deck) {
      const esc = (s) => this.escapeHtml(s);
      return (deck && deck.name) ? esc(deck.name) : '<span class="tree-name-missing">(이름 없음)</span>';
    },

    renderTree() {
      const host = this.$("side-tree");
      if (!host) return;
      /* [WO 20260928-tree-expand] 🔴 마스터: "구역·영역이 리스트로, 기본 펼침" —
         접기/펼치기는 유지하되 기본값은 항상 열림. 상태는 세션 메모리(this._treeCollapsed,
         deck.id 키 — 전역 프로젝트 구분 없는 localStorage 금지, 1e71772 핀필터 사고 재발 방지)
         에만 남긴다. 새로고침하면 초기화되고, deck.id 는 프로젝트별로 유일하므로 다른
         프로젝트 설정이 새어 들어올 수 없다. */
      const collapsed = this._treeCollapsed || (this._treeCollapsed = new Set());
      const esc = (s) => this.escapeHtml(s);
      const C = '<svg class="tree-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';
      const ICO = {
        project: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
        deck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
        region: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13" aria-hidden="true"><path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/></svg>',
        pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>'
      };
      const decks = (typeof Projects !== "undefined" && Projects.decks) || [];
      host.innerHTML = "";
      if (!decks.length) { host.innerHTML = '<p class="tree-empty">구역이 없습니다.<br>위 도구의 ‘구역 생성’으로 추가하세요.</p>'; return; }
      const curPage = State.pdfPage || 1;
      const totalPages = State.mode === "viewer"
        ? (State.viewerPages ? State.viewerPages.length : 1)
        : (State.pdfPages || 1);
      const showPageTag = totalPages > 1;
      const pageTag = (pg) => showPageTag ? ' <span class="tree-label-sub">P' + (pg || 1) + '</span>' : "";
      /* [WO 20260928-tree-pinlist] 🔴 번호 SoT = PinSeries.numbers()(01b_PinSeries.js) —
         여기서 직접 채번하지 않는다(도면 마커·미니맵과 항상 같은 번호가 나오게).
         numbers() 는 페이지 1개 기준이라, 트리는 전체 페이지를 항상 보여주므로(WO 20260917-pin)
         핀에 등장하는 모든 page 값에 대해 한 번씩 돌려 병합한다(핀 id 는 전역 유일이라 충돌 없음). */
      const numbersAcrossPages = (pins) => {
        const map = new Map();
        if (typeof PinSeries === "undefined" || !PinSeries.numbers) return map;
        const pages = new Set((pins || []).map((p) => p.page || 1));
        pages.forEach((pg) => { PinSeries.numbers(pins, pg).forEach((v, k) => map.set(k, v)); });
        return map;
      };
      const pinNode = (p, numMap) => {
        const n = document.createElement("button");
        n.className = "tree-node tree-node-pin" + (State.activePin === p.id ? " active" : "");
        const noteIco = p.note ? '<svg class="tree-note" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>' : "";
        const meta = numMap ? numMap.get(p.id) : null;
        const noLabel = meta ? '<span class="tree-pin-no">#' + esc(String(meta.no)) + '</span>' : "";
        n.innerHTML = ICO.pin + noLabel + '<span class="tree-label">' + esc(p.label || "포인트") + '</span>' + pageTag(p.page) + noteIco;
        if (p.note) n.title = "" + p.note;
        n.addEventListener("click", () => { if (typeof App !== "undefined") { if (App.focusPin) App.focusPin(p, true); else if (App.onPinTap) App.onPinTap(p); } });
        return n;
      };

      /* ── 계층 인덱스 ── [WO 20260928-hub-tree] 공유 함수(groupDecksByParent, SoT)로 이관 ── */
      const curDeck = (typeof Projects !== "undefined" && Projects.currentDeck) || null;
      const { roots: rootDecks, childrenOf } = this.groupDecksByParent(decks);
      const docLabel = (depId) => {
        if (!depId) return "도면 미등록";
        const hit = decks.find((d) => String(d.deployment_id || "") === String(depId) && (d.deployment_file_name || d.deployment_title));
        if (hit) return hit.deployment_file_name || hit.deployment_title;
        if (String(depId) === String(State.currentDeploymentId || "") && State.fileName) return State.fileName;
        return "등록 도면";
      };

      /* 같은 도면을 여러 deck(구역/영역)이 가리키므로 State(영역JSON·핀)를 붙일 deck 을 하나로 정한다.
         선택된 deck 이 그 도면 안에 있으면 그 deck 에만, 없으면 종전대로 로드된 deck 에 붙인다. */
      const hasState = (deck) => {
        if (!deck.deployment_id || String(deck.deployment_id) !== String(State.currentDeploymentId || "")) return false;
        if (curDeck && String(curDeck.deployment_id || "") === String(deck.deployment_id)) return String(curDeck.id) === String(deck.id);
        return true;
      };

      /* ── 구역/영역 노드(같은 생성기 — 깊이만 다르다) ───────────────── */
      const deckNode = (deck, isRegion) => {
        const isCur = !!(curDeck && String(curDeck.id) === String(deck.id));
        const loaded = hasState(deck);
        const subDecks = childrenOf.get(String(deck.id)) || [];
        // [WO 20260928-tree-expand] 🔴 기본 펼침 — 사용자가 직접 닫은 적이 없으면 항상 open.
        const collapseKey = String(deck.id);
        const g = document.createElement("div");
        g.className = (isRegion ? "tree-region" : "tree-deck") + (collapsed.has(collapseKey) ? "" : " open");
        const head = document.createElement("button");
        head.className = "tree-node " + (isRegion ? "tree-node-region" : "tree-node-deck") + (isCur ? " active" : "");
        // [B4] '도면없음'(구역에 도면 미등록) 과 '미저장'(로컬에만 있고 서버 미반영)을 구분 표시
        const _unsaved = (typeof App !== "undefined" && App.isDeckUnsaved) ? App.isDeckUnsaved(deck.id) : false;
        const _tag = _unsaved
          ? '<span class="tree-tag tree-tag-unsaved" title="로컬에만 있음 — ‘저장’을 눌러 서버에 반영하세요">미저장</span>'
          : (deck.deployment_id ? "" : '<span class="tree-tag" title="이 구역에 등록된 도면이 없습니다 — 구역을 눌러 도면을 등록하세요">도면없음</span>');
        // [항목4] 영역 수 배지 — 로드된 구역만(미로드 구역은 실제 개수를 모른다·0 날조 금지)
        const zoneCntTag = loaded ? '<span class="tree-cnt" title="영역 수">' + (State.zones || []).length + '</span>' : "";
        // [WO 20260921-tree3→20260928-tree-title] 마스터 2026-09-28 지시로 대체: 구역·영역이 같은
        //   deployment(같은 도면)를 가리켜 모든 행에 똑같은 긴 파일명이 붙으면서 정작 구별해야 할
        //   이름("ㅁ"/"ㅁㄴㅇ")이 묻혔다("이 트리가 제대로 제목이 안나오잖아"). 행에는 이름만 보이고,
        //   원본 도면 파일명은 title(네이티브 툴팁)로만 제공한다(docLabel 은 없는 이름을 지어내지
        //   않는다 — 유실이 아니라 이동).
        const docName = deck.deployment_id ? docLabel(deck.deployment_id) : null;
        // [WO 20260928-tree-expand→20260929-tree-label] 🔴 마스터: 이름이 비어 있으면 빈칸이 아니라
        // "(이름 없음)"으로 정직하게 표시(CLAUDE.md §5). SoT: UI.deckLabelHtml(deck.name, 파일명 아님).
        const _nameLabel = this.deckLabelHtml(deck);
        head.innerHTML = C + (isRegion ? ICO.region : ICO.deck) + '<span class="tree-label">' + _nameLabel + '</span>' + _tag + zoneCntTag;
        // [WO 20260929-tree-label→20260928-tree-title] 🔴 잘림 금지 — CSS 는 2줄까지만 보여주고 그
        // 이상은 줄임표라 전체 이름이 필요하면 title(네이티브 툴팁)로 항상 확인할 수 있게 한다.
        // title 엔 이름 + 원본 도면 파일명(있으면)을 함께 담아 도면 출처 정보를 유지한다.
        head.title = (deck.name ? deck.name : "(이름 없음)") + (docName ? "\n원본 도면: " + docName : "");
        // [WO 20260928-tree-expand] 열림/닫힘 토글 시 세션 메모리에 반영(사용자가 닫은 항목만 기억).
        const toggleOpen = () => { if (g.classList.toggle("open")) collapsed.delete(collapseKey); else collapsed.add(collapseKey); };
        head.addEventListener("click", (e) => {
          if (e && e.target && e.target.closest && e.target.closest(".tree-caret")) { toggleOpen(); return; }
          if (isCur) { toggleOpen(); }
          else if (typeof Projects !== "undefined" && Projects.selectDeck) Projects.selectDeck(deck);
        });
        g.appendChild(head);

        const kids = document.createElement("div");
        kids.className = "tree-children";
        let any = false;
        // 3단 — 이 구역 안의 영역(parent_id = 이 구역 id 인 deck). 🔴 마스터: "구역 아래 영역이
        // 리스트로 나열돼야 한다" — 0개여도 숨기지 않고 "영역 없음"으로 알린다(구역 레벨 한정,
        // 영역 자신의 하위는 데이터가 있을 때만 표시해 기존 4단 방지 회귀(p62)를 건드리지 않는다).
        if (!isRegion) {
          if (subDecks.length) subDecks.forEach((cd) => { kids.appendChild(deckNode(cd, true)); });
          else { const eEl = document.createElement("p"); eEl.className = "tree-empty"; eEl.textContent = "영역 없음"; kids.appendChild(eEl); }
          any = true;
        } else if (subDecks.length) {
          subDecks.forEach((cd) => { kids.appendChild(deckNode(cd, true)); });
          any = true;
        }
        if (loaded) {
          const zones = State.zones || []; // 전체 페이지(필터 없음)
          const pins = State.pins || [];   // 전체 페이지(필터 없음)
          const numMap = numbersAcrossPages(pins);
          const sortByNo = (a, b) => ((numMap.get(a.id) || {}).no || 0) - ((numMap.get(b.id) || {}).no || 0);
          // [WO 20260928-tree-pinlist] 🔴 소속 = 가장 깊은(면적 작은) 영역 하나 — 겹치는 영역이
          // 있으면 바운딩박스(zone.w*zone.h, 페이지%) 가 더 작은 쪽. 못 찾으면 구역 직속.
          const zoneOfPin = new Map(); // pinId -> zone
          pins.forEach((p) => {
            const ppage = p.page || 1;
            let best = null, bestArea = Infinity;
            zones.forEach((zone) => {
              if ((zone.page || 1) !== ppage) return;
              if (!(typeof Zones !== "undefined" && Zones._contains && Zones._contains(zone, p.x, p.y))) return;
              const area = Math.max(0, +zone.w || 0) * Math.max(0, +zone.h || 0);
              if (area < bestArea) { bestArea = area; best = zone; }
            });
            if (best) zoneOfPin.set(p.id, best);
          });
          const pinsOfZone = new Map();
          zones.forEach((z) => pinsOfZone.set(z.id, []));
          const rootPins = [];
          pins.forEach((p) => {
            const z = zoneOfPin.get(p.id);
            if (z && pinsOfZone.has(z.id)) pinsOfZone.get(z.id).push(p);
            else rootPins.push(p);
          });
          zones.forEach((zone) => {
            const zpage = zone.page || 1;
            const isCurZonePage = zpage === curPage;
            const zpins = (pinsOfZone.get(zone.id) || []).slice().sort(sortByNo);
            const zn = document.createElement("div");
            zn.className = "tree-zone open"; // [항목2] 기본 펼침
            const zh = document.createElement("button");
            // [항목3][항목5] 현재 페이지 영역 = .active 로 "구분"(숨기지 않음). 클릭 동작은 기존 그대로.
            zh.className = "tree-node tree-node-zone" + (isCurZonePage ? " active" : "");
            zh.innerHTML = C + '<span class="tree-dot" style="background:' + (zone.color || "#888") + '"></span><span class="tree-label">' + esc(zone.label || "영역") + '</span>' + pageTag(zpage) + '<span class="tree-cnt" title="핀 수">' + zpins.length + '</span>';
            zh.addEventListener("click", (e) => {
              if (e.target.closest(".tree-caret")) { zn.classList.toggle("open"); return; }
              if (typeof Zones !== "undefined" && Zones.focus) Zones.focus(zone.id);
            });
            zn.appendChild(zh);
            const zc = document.createElement("div");
            zc.className = "tree-children";
            zpins.forEach((p) => zc.appendChild(pinNode(p, numMap)));
            zn.appendChild(zc);
            kids.appendChild(zn);
          });
          rootPins.sort(sortByNo).forEach((p) => kids.appendChild(pinNode(p, numMap)));
          any = true;
        }
        if (any) g.appendChild(kids);
        return g;
      };

      /* ── 1단: 프로젝트 — 2단(구역)을 바로 붙인다(도면 그룹핑 단 없음, 마스터 정정) ──── */
      let mount = host;
      const proj = (typeof Projects !== "undefined" && Projects.currentProject) || null;
      if (proj) {
        const pw = document.createElement("div");
        pw.className = "tree-project open";
        const ph = document.createElement("button");
        ph.className = "tree-node tree-node-project";
        ph.innerHTML = C + ICO.project + '<span class="tree-label">' + esc(proj.name || "프로젝트") + '</span><span class="tree-cnt" title="구역 수">' + rootDecks.length + '</span>';
        ph.addEventListener("click", () => { pw.classList.toggle("open"); });
        pw.appendChild(ph);
        const pk = document.createElement("div");
        pk.className = "tree-children";
        pw.appendChild(pk);
        host.appendChild(pw);
        mount = pk;
      }
      rootDecks.forEach((d) => mount.appendChild(deckNode(d, false)));
    },

    renderPinsOnMap(dropPinId) {
      const layer = this.$("pins-layer");
      layer.innerHTML = "";
      const curPage = State.pdfPage;
      // 🔴 번호/부류/색상 정본 = PinSeries (01b_PinSeries.js). 여기서 따로 세지 않는다.
      //    미니맵(07_Radar)도 같은 함수를 호출하므로 두 화면의 번호가 항상 일치한다.
      const numMap = PinSeries.numbers(State.pins, curPage);
      PinSeries.renderChips();
      let svgIdx = 0; // SVG gradient id 유일화용(필터로 건너뛰어도 충돌 없게 별도 카운터)
      State.pins.forEach((pin) => {
        if ((pin.page || 1) !== curPage) return; // 현재 페이지 핀만
        // 표시 필터: 숨김은 "표시만" 감춘다 — 번호(numMap)는 이미 전체 기준으로 계산됨
        if (!PinSeries.isVisible(pin)) return;
        svgIdx++;
        const pageIdx = svgIdx;
        const marker = document.createElement("div");
        marker.className = "pin-marker" + (pin.id === dropPinId ? " drop" : "")
          + (State.activePin === pin.id ? " focused" : "");
        marker.style.left = pin.x + "%";
        marker.style.top  = pin.y + "%";
        marker.dataset.id = pin.id;
        // 구역 페이지(crop-view) 진입 중이면, 해당 구역 밖 핀은 흐리게(dim)
        if (State.zoneView) {
          const _zv = (State.zones || []).find(z => z.id === State.zoneView);
          if (_zv && typeof Zones !== "undefined" && Zones._contains && !Zones._contains(_zv, pin.x, pin.y)) {
            marker.classList.add("zone-dim");
          }
        }
        const meta = numMap.get(pin.id) || { no: pageIdx, kind: PinSeries.kindOf(pin) };
        // 🔴 색·형태 정본 = PinSeries.markerStyle (미니맵 07_Radar 도 같은 함수를 쓴다).
        //    체크보드 핀은 kind 가 늘 "checkboard" 라 kind 만으로는 사진 유무를 알 수 없다
        //    → filled 축을 따로 받아 등록/미등록을 색·링 패턴으로 구분한다.
        const _st = PinSeries.markerStyle(pin);
        const hasContent = _st.filled;
        // 🔴 [2026-09-21 WO] 위성 배지 3종(이슈·중복·작성자) 제거 — 마스터 지시("거추장스런 거 지워").
        //   이슈/중복 정보는 버리지 않는다: PinActionPop(27_PinActionPop.js open())과
        //   #pin-list(renderPinList, 위 pin-issue-badge/pin-dup-badge)에서 계속 보인다.
        //   작성자 대역 정보도 PinActionPop meta 줄로 이관(PinSeries.userMark 그대로 재사용).
        if (hasContent) marker.classList.add("has-content");
        if (pin.checkboard) marker.classList.add("checkboard"); // [체크보드 핀 색상구분] 일반 핀과 다른 색으로 표시
        marker.classList.add("pin-marker-teardrop"); // 진짜 핀(물방울) 모양 + 중앙 번호
        marker.classList.add("pin-kind-" + meta.kind); // 색맹 대비: 색 외 식별 훅
        // ── 번호: 콘텐츠 계열 / 체크보드 계열이 각각 1부터 독립 채번(PinSeries 정본) ──
        const dispNo = meta.no;
        marker.dataset.no = dispNo;
        marker.dataset.kind = meta.kind;
        marker.dataset.filled = _st.filled ? "1" : "0"; // 사진 등록 여부(미니맵과 동일 판정 검증용)
        marker.classList.add(_st.filled ? "pin-filled" : "pin-hollow");
        // [WO 20260917 콘텐츠 3상태] photo(사진/영상) / content(노트·첨부만) / empty — filled 축은
        // 안 건드리고 그 안(filled=true)을 세분. 색 없이도(흑백) 구분되게 속 원판 실루엣(pin-tier-disc) 사용.
        const tier = _st.tier || (typeof PinSeries !== "undefined" ? PinSeries.contentTier(pin) : (hasContent ? "content" : "empty"));
        marker.dataset.tier = tier;
        marker.classList.add("pin-tier-" + tier);
        // ── 바늘형 핀(영역=골드와 색상 완전 분리):
        //    미배치(콘텐츠 없음)=선명한 코랄레드(#ef4444),
        //    콘텐츠 있음=사용자 설정 색상(기본 그린). 설정에서 변경 가능.
        //    바늘을 길고 가늘게 → "찌르는" 느낌. tip(18,62)으로 수렴.
        // 🔴 색상도 PinSeries 정본에서 파생 — 미니맵 점과 같은 색을 쓴다.
        const _col = _st.colors;
        const headFill  = _col.head;
        const headFill2 = _col.head2;
        const needleTip = _col.needle;
        const txtFill   = _col.text;
        // 색만으로 구분 금지(색맹 8%) → 외곽 링 패턴으로도 구분:
        // 실선=콘텐츠 등록 / 파선=체크보드(사진 등록됨) / 점선=미등록
        const ringDash  = _st.dash;
        // [WO 20260917 형태단서 재설계] 21px 실크기에서 작은 점(지름 2.2px)은 안 보인다(마스터 실측).
        // → 속 원판(inner disc)의 실루엣 자체를 티어별로 바꾼다: photo/empty=원, content=둥근사각형.
        // 흑백(색 제거)에서도 면적 차이로 구분되도록 인라인 fill 유지(CSS 소비자에 의존 금지).
        // [WO 2026-09-21] 마스터 직접 제안("동그라미를 겹친다든가") — photo(사진/영상)만
        // 원 2개를 겹쳐 그린다. empty 는 원 1개만 유지해 photo/empty 가 더는 "완전히 같은 원"이
        // 아니게 된다(이전엔 둘 다 단일 원이라 filled/hollow 머리색만으로 구분해야 했다).
        // 🔴 p9 discTag 판정은 class="pin-tier-disc" 가 붙은 첫 번째 요소의 태그만 본다(circle
        // 그대로) → 회귀 없음. 겹치는 두 번째 원은 표식용(클래스 없음)이라 판정에 관여하지 않는다.
        const tierDisc = (tier === "content")
          ? `<rect class="pin-tier-disc" x="9.8" y="6.8" width="16.4" height="16.4" rx="3" fill="#ffffff" opacity="0.99"/>`
          : (tier === "photo")
            ? `<circle class="pin-tier-disc" cx="18" cy="15" r="8.6" fill="#ffffff" opacity="0.99"/><circle cx="22.6" cy="10.4" r="4.2" fill="#ffffff" opacity="0.99" stroke="#1a1a1a" stroke-width="0.8"/>`
            : `<circle class="pin-tier-disc" cx="18" cy="15" r="8.6" fill="#ffffff" opacity="0.99"/>`;
        marker.innerHTML = `
          ${hasContent ? '<div class="pin-pulse"></div>' : ''}
          <div class="pin-pin">
            <svg viewBox="0 0 36 64" xmlns="http://www.w3.org/2000/svg">
              <defs>
                <radialGradient id="pgbody${pageIdx}" cx="38%" cy="30%" r="78%">
                  <stop offset="0%" stop-color="${headFill}"/>
                  <stop offset="100%" stop-color="${headFill2}"/>
                </radialGradient>
                <linearGradient id="pgstem${pageIdx}" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color="${headFill2}"/>
                  <stop offset="100%" stop-color="${needleTip}"/>
                </linearGradient>
                <filter id="pgshadow${pageIdx}" x="-60%" y="-20%" width="220%" height="180%">
                  <feDropShadow dx="0" dy="2.2" stdDeviation="1.7" flood-color="rgba(0,0,0,.5)"/>
                </filter>
              </defs>
              <!-- ISO 접지 그림자(바닥 타원) → 360 뷰포인트가 도면 위에 '서 있는' 입체감 -->
              <ellipse cx="18" cy="60.5" rx="6.2" ry="2.3" fill="#000" opacity="0.22"/>
              <!-- 받침대 줄기: 머리에서 접지점(18,60)으로 수렴 -->
              <path d="M14.2 22 L18 60 L21.8 22 Z" fill="url(#pgstem${pageIdx})" filter="url(#pgshadow${pageIdx})"/>
              <!-- [대비강화] 도면(촘촘한 선) 위에서도 또렷하게: 진한 외곽 링 -->
              <circle cx="18" cy="15" r="12.4" fill="none" stroke="#1a1a1a" stroke-width="3.2" opacity="0.5"${ringDash ? ` stroke-dasharray="${ringDash}" stroke-linecap="round"` : ""}/>
              <!-- 메달리온 머리 -->
              <circle cx="18" cy="15" r="11.8" fill="${_st.filled ? `url(#pgbody${pageIdx})` : "none"}" stroke="${_st.filled ? "#ffffff" : headFill2}" stroke-width="${_st.filled ? 2.4 : 3.2}"/>
              <!-- [WO 20260928 번호 복구] 마스터 지시("번호가 안본다") — 9/21 지시는 "숫자 풍선"
                   (머리 밖 별도 배지)을 없애라는 뜻이었는데 머리 안 번호까지 지워 회귀가 났다.
                   상태(등록 fill/tier 원판/링 dash)는 그대로 유지하고, 흰 원판(tierDisc) 위에
                   번호만 다시 그린다 — 원판이 항상 흰색이라 txtFill(진한 계열색)과 대비 ≥4.5:1 보장.
                   3자리 이상(101~)은 원판을 넘치지 않게 폰트를 축소한다. 커스텀 아이콘을 고른
                   핀만 예외적으로 그 아이콘을 그린다(번호 대신). -->
              <!-- [WO 20260917 형태단서] 속 원판 실루엣으로 티어 구분(원=photo/empty, 둥근사각형=content) -->
              ${tierDisc}
              ${(typeof PinIcons !== "undefined" && pin.icon && pin.icon !== "number" && PinIcons.headMarkup(pin.icon, txtFill, 15))
                || `<text x="18" y="15.4" text-anchor="middle" dominant-baseline="central" font-family="'Segoe UI',sans-serif" font-size="${String(dispNo).length >= 3 ? 9 : 13}" font-weight="900" fill="${txtFill}">${dispNo}</text>`}
              <!-- 머리 하이라이트(광택) -->
              <ellipse cx="14" cy="10.5" rx="3.4" ry="2.1" fill="#ffffff" opacity="0.5"/>
            </svg>
          </div>`;
          /* [마스터 요청] 핀 위 hover 액션버튼(.pin-actions) 제거 — 상단 "포인트 수정" 모드로 일원화.
             수정/이동/삭제/보기는 포인트수정 모드에서 핀 클릭 → PinActionPop 으로. */
        // ── 디자이너: 포인터 드래그로 핀 위치 이동 (click 과 구분: 이동 임계값) ──
        if (State.mode === "designer") {
          marker.classList.add("draggable");
          let dragging = false, moved = false, startX = 0, startY = 0;
          const onMove = (ev) => {
            const cx = ev.touches ? ev.touches[0].clientX : ev.clientX;
            const cy = ev.touches ? ev.touches[0].clientY : ev.clientY;
            if (!dragging) return;
            if (!moved && Math.hypot(cx - startX, cy - startY) < 5) return; // 임계값 미만은 클릭으로 취급
            moved = true;
            State.movingPinId = pin.id;
            marker.classList.add("moving");
            const pct = MapCtrl.viewportToPercent(cx, cy);
            if (pct) {
              pin.x = Math.max(0, Math.min(100, pct.x));
              pin.y = Math.max(0, Math.min(100, pct.y));
              marker.style.left = pin.x + "%";
              marker.style.top  = pin.y + "%";
              const lbl = marker.querySelector(".pin-marker-label");
              // 좌표 라이브 갱신은 리스트 쪽에서 (성능 위해 드래그 끝에 한 번)
            }
            if (ev.cancelable) ev.preventDefault();
          };
          const onUp = () => {
            document.removeEventListener("pointermove", onMove);
            document.removeEventListener("pointerup", onUp);
            document.removeEventListener("touchmove", onMove);
            document.removeEventListener("touchend", onUp);
            dragging = false;
            marker.classList.remove("moving");
            if (moved) {
              State.movingPinId = null;
              State.pinEditUnlocked = null; // 이동 끝나면 다시 잠금
              if (typeof Zones !== "undefined" && Zones.refreshPinLinks) Zones.refreshPinLinks();
              UI.renderPinList();
              if (typeof Zones !== "undefined") Zones.render();
              Prompt.toast("'" + pin.label + "' 위치 이동됨 · 자동저장");
              App._autoSave();
            }
          };
          const onDown = (ev) => {
            if (State.placing) return; // 배치 모드에서는 드래그 비활성
            if (State.isoView) { Prompt.toast("ISO 3D 뷰에서는 위치 이동이 불가합니다. 평면 뷰로 전환하세요."); return; }
            // ── 요청사항 #6: '수정' 버튼으로 잠금 해제한 핀만 드래그 이동 가능 ──
            if (State.pinEditUnlocked !== pin.id) {
              // 잠긴 상태 → 클릭으로만 동작(보기). 이동하려면 수정 버튼을 눌러야 함.
              return;
            }
            startX = ev.touches ? ev.touches[0].clientX : ev.clientX;
            startY = ev.touches ? ev.touches[0].clientY : ev.clientY;
            dragging = true; moved = false;
            document.addEventListener("pointermove", onMove, { passive: false });
            document.addEventListener("pointerup", onUp);
            document.addEventListener("touchmove", onMove, { passive: false });
            document.addEventListener("touchend", onUp);
          };
          marker.addEventListener("pointerdown", onDown);
          marker.addEventListener("click", e => {
            e.stopPropagation();
            if (moved) { moved = false; return; } // 드래그 직후 클릭 무시
            if (State.pinEditUnlocked === pin.id) return; // 이동 잠금해제 상태에서는 클릭 무시(드래그 대기)
            // ── 포인트 수정 모드: 핀 클릭 → 수정/이동/삭제/보기 팝업(기존 유지) ──
            if (State.editMode && typeof PinActionPop !== "undefined") {
              App.setActivePin(pin.id);
              PinActionPop.open(pin.id);
            } else {
              // ── [마스터 요청] 핀 선택 → ISO 전환 + 구역 확대(첫 탭), 같은 핀 둘째 탭 → 360° ──
              App.onPinTap(pin);
            }
          });
          // ── 길게 누르기(롱프레스) → 사진 있는 핀도 작업 팝업(수정/이동/삭제) 진입 ──
          //   (모바일에서 사진 핀의 편집 경로 확보 · 데스크톱은 우클릭으로도 진입)
          let _lpTimer = null;
          const _openMenu = () => {
            if (State.pinEditUnlocked === pin.id) return;
            App.setActivePin(pin.id);
            if (typeof PinActionPop !== "undefined") PinActionPop.open(pin.id);
          };
          marker.addEventListener("pointerdown", () => {
            clearTimeout(_lpTimer);
            _lpTimer = setTimeout(_openMenu, 550);
          });
          ["pointerup", "pointerleave", "pointercancel"].forEach(ev =>
            marker.addEventListener(ev, () => clearTimeout(_lpTimer)));
          marker.addEventListener("contextmenu", (e) => { e.preventDefault(); _openMenu(); });
          // 액션 아이콘 바인딩 (보기/이동/수정/삭제)
          marker.querySelectorAll(".pin-act").forEach(btn => {
            btn.addEventListener("click", ev => {
              ev.stopPropagation();
              const act = btn.dataset.act;
              if (act === "view") App.openPano(pin);
              else if (act === "move") {
                // ── #6: 이동 잠금 해제 후 드래그 안내 ──
                State.pinEditUnlocked = pin.id;
                marker.classList.add("edit-unlocked");
                Prompt.toast("'" + pin.label + "' 이동 잠금 해제 — 핀을 드래그하세요");
              }
              else if (act === "edit") {
                // ── #6: 수정 버튼 → 편집 폼 + 이동 잠금 해제(사진추가/위치이동 가능) ──
                State.pinEditUnlocked = pin.id;
                App.editPin(pin.id);
              }
              else if (act === "del") App.deletePin(pin.id);
            });
          });
        } else {
          marker.addEventListener("click", e => {
            e.stopPropagation();
            // [마스터 요청] 뷰어도 동일: 첫 탭 → ISO+구역 확대, 둘째 탭 → 360°
            App.onPinTap(pin);
          });
        }
        layer.appendChild(marker);
      });
      if (typeof Zones !== "undefined") Zones.render();
      if (typeof PdfAnno !== "undefined") PdfAnno.refresh();
      // ── [마스터 요청] 렌더 직후에도 ISO면 핀을 즉시 수직(빌보드)으로 세움 ──
      if (typeof MapCtrl !== "undefined" && MapCtrl._applyPinBillboard) MapCtrl._applyPinBillboard();
    },

    updatePdfPagination() {
      const total = State.mode === "viewer" && State.viewerPages
        ? State.viewerPages.length : State.pdfPages;
      if (total > 1) {
        this.$("pdf-pagination").classList.remove("hidden");
        const jump = this.$("input-page-jump");
        if (jump && document.activeElement !== jump) jump.value = State.pdfPage;
        this.text("page-total", "/ " + total);
        this.$("btn-first-page").disabled = State.pdfPage <= 1;
        this.$("btn-prev-page").disabled  = State.pdfPage <= 1;
        this.$("btn-next-page").disabled  = State.pdfPage >= total;
        this.$("btn-last-page").disabled  = State.pdfPage >= total;
      } else {
        this.$("pdf-pagination").classList.add("hidden");
      }
      // 새 ezPDF 툴바 페이지 동기화 (단일 페이지도 1/1 표시)
      const tbInput = this.$("tb-page-input");
      if (tbInput && document.activeElement !== tbInput) tbInput.value = State.pdfPage;
      this.text("tb-page-total", "/ " + (total || 1));
      const setDis = (id, v) => { const el = this.$(id); if (el) el.disabled = v; };
      setDis("tb-first", State.pdfPage <= 1);
      setDis("tb-prev",  State.pdfPage <= 1);
      setDis("tb-next",  State.pdfPage >= (total || 1));
      setDis("tb-last",  State.pdfPage >= (total || 1));
      // 모바일 도크 '페이지' 칩에 현재 n/N 배지 (멀티페이지만)
      const pageBadge = this.$("mdock-page-badge");
      if (pageBadge) {
        if ((total || 1) > 1) { pageBadge.textContent = State.pdfPage + "/" + total; pageBadge.classList.remove("hidden"); }
        else pageBadge.classList.add("hidden");
      }
    },

    /** 좌측 썸네일 도킹 패널 토글 (ezPDF 스타일) */
    toggleThumbPanel(force) {
      const strip = this.$("pdf-thumb-strip");
      const btn = this.$("tb-thumbs");
      if (!strip) return;
      const willHide = (typeof force === "boolean") ? !force : !strip.classList.contains("hidden");
      strip.classList.toggle("hidden", willHide);
      strip.classList.toggle("docked", !willHide);
      document.body.classList.toggle("thumbs-open", !willHide);
      if (btn) btn.classList.toggle("active", !willHide);
      if (!willHide && typeof this.renderPdfThumbs === "function") this.renderPdfThumbs();
    },

    /** 회전 각도 라벨 + 버튼 노출 (도면 로드 시에만 표시) */
    updateRotationLabel() {
      const grp = this.$("rotate-group");
      if (!grp) return;
      const hasDoc = !!(State.fileType && (State.pdfDoc || State.imageUrl || State.viewerPages));
      grp.classList.toggle("hidden", !hasDoc);
      const lbl = this.$("rotate-level");
      if (lbl) lbl.textContent = (State.pdfRotation || 0) + "°";
    },

    /** 멀티페이지 PDF 썸네일 스트립 (디자이너 PDF 전용) */
    async renderPdfThumbs() {
      const strip = this.$("pdf-thumb-strip");
      if (!strip) return;
      // 디자이너 PDF + 2페이지 이상에서만 표시
      const show = State.mode === "designer" && State.fileType === "pdf"
        && State.pdfDoc && State.pdfPages > 1;
      strip.classList.toggle("hidden", !show);
      if (!show) { strip.innerHTML = ""; return; }

      // 최초 1회만 썸네일 캐시 생성 (페이지 전환 시 재생성 방지)
      if (this._thumbDocId !== State.pdfDoc || strip.childElementCount !== State.pdfPages) {
        this._thumbDocId = State.pdfDoc;
        const docRef = State.pdfDoc;
        strip.innerHTML = "";
        // 1) 버튼(틀)은 전부 즉시 생성 — 클릭/번호는 곧바로 동작
        const items = [];
        for (let p = 1; p <= State.pdfPages; p++) {
          const item = document.createElement("button");
          item.className = "pdf-thumb-item";
          item.dataset.page = p;
          item.title = p + " 페이지";
          item.innerHTML =
            `<canvas class="pdf-thumb-canvas"></canvas><span class="pdf-thumb-no">${p}</span>`;
          item.addEventListener("click", () => App._gotoPage(p));
          strip.appendChild(item);
          items.push(item);
        }
        // 2) [성능] 모든 페이지를 한꺼번에 순차 렌더하면 1~3초 지연 → 처음 보이는 8장만 즉시,
        //    나머지는 유휴 시간에 한 장씩(도면이 바뀌면 즉시 중단). 첫 표시 체감 즉각.
        const FIRST = 8;
        const head = Math.min(FIRST, State.pdfPages);
        for (let p = 1; p <= head; p++) this._renderThumbInto(items[p - 1].querySelector("canvas"), p);
        if (State.pdfPages > FIRST) {
          const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 200));
          const step = (p) => {
            if (this._thumbDocId !== docRef || p > State.pdfPages) return; // 도면 전환/끝 → 중단
            this._renderThumbInto(items[p - 1].querySelector("canvas"), p);
            idle(() => step(p + 1));
          };
          idle(() => step(FIRST + 1));
        }
      }
      // 현재 페이지 하이라이트
      Array.from(strip.children).forEach((el) => {
        const active = Number(el.dataset.page) === State.pdfPage;
        el.classList.toggle("active", active);
        if (active) el.scrollIntoView({ block: "nearest", inline: "nearest" });
      });
    },

    async _renderThumbInto(canvas, pageNum) {
      try {
        const page = await State.pdfDoc.getPage(pageNum);
        const rot = ((page.rotate || 0) + (State.pdfRotation || 0)) % 360;
        const base = page.getViewport({ scale: 1, rotation: rot });
        const scale = 120 / Math.max(base.width, base.height); // 최대 변 120px
        const vp = page.getViewport({ scale, rotation: rot });
        canvas.width = Math.round(vp.width);
        canvas.height = Math.round(vp.height);
        await page.render({ canvasContext: canvas.getContext("2d", { alpha: false }), viewport: vp }).promise;
      } catch (e) { /* 썸네일 실패는 무시 */ }
    }
  };

  /* ══════════════════════════════════════════
     PROJECT HUB  ── 첫 화면 = 프로젝트 선택 대시보드 (상용툴 모방)
       · 로그인 안 함/뷰어: 카드 클릭 → 뷰어로 해당 프로젝트 열람
       · 디자이너/슈퍼: "+새 프로젝트" + 카드 편집/삭제, 카드 클릭 → 디자이너 작업
  ══════════════════════════════════════════ */
  const ASK_ENTRY_MODE = false; // 2026-08 마스터 지시: 지금은 묻지 말고 무조건 편집모드. 뷰어 배포 후 true 로 바꾸면 다시 선택 모달이 뜬다.

  const ProjectHub = {
    list: [],
    _loaded: false,
    // [WO 20260921 publish-fix] subdomain 없는 배포 프로젝트의 뷰어 딥링크(?d=) 캐시.
    //   project_id → deployment_id(string) | null(도면 없음, 조회 완료) — SoT: /api/projects/:id/decks.
    _deployLinkCache: {},
    // [WO 20260928-hub-tree] 카드 아래 구역→영역 트리용 캐시.
    //   project_id → decks 배열(해당 프로젝트, deleted 제외) | undefined(아직 조회 안 됨 — "모름"과
    //   "0개"를 구분해야 하므로 빈 배열과 undefined 를 섞지 않는다, CLAUDE.md §5 조용한 실패 금지).
    _deckTreeCache: {},

    init() {
      const $ = (id) => document.getElementById(id);
      $("hub-btn-new") && $("hub-btn-new").addEventListener("click", () => this.createProject());
      // hub 인증바 버튼들 (홈 인증바와 동일 동작)
      $("hub-btn-signout") && $("hub-btn-signout").addEventListener("click", () => Auth.signOut());
      $("hub-btn-manage-designers") && $("hub-btn-manage-designers").addEventListener("click", () => Designers.open());
      // 접근 신청 모달
      $("par-cancel") && $("par-cancel").addEventListener("click", () => this.closeAccessReq());
      $("par-backdrop") && $("par-backdrop").addEventListener("click", () => this.closeAccessReq());
      $("par-submit") && $("par-submit").addEventListener("click", () => this.submitAccessReq());
      // [P3] 프로젝트별 멤버 배정 모달
      $("pm-close") && $("pm-close").addEventListener("click", () => this.closeMembers());
      const pmBd = document.querySelector("#proj-members-modal .admin-gate-backdrop");
      if (pmBd) pmBd.addEventListener("click", () => this.closeMembers());
      $("pm-add-btn") && $("pm-add-btn").addEventListener("click", () => this.addMember());
      const pmEmail = $("pm-email");
      if (pmEmail) pmEmail.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); this.addMember(); } });
      // [P40] 초대 링크 복사
      $("pm-invite-copy") && $("pm-invite-copy").addEventListener("click", () => this._copyInviteLink());
      // [P63] 뷰어 초대코드 — 발급·복사·공유(폐기는 목록 행에서 위임)
      $("pm-code-add") && $("pm-code-add").addEventListener("click", () => this.createShareCode());
      $("pm-code-copy") && $("pm-code-copy").addEventListener("click", () => {
        const el = $("pm-code-new"); if (el) this._copyDeployUrl(el.value);
      });
      $("pm-code-share") && $("pm-code-share").addEventListener("click", () => {
        const el = $("pm-code-new");
        if (el) this._shareDeployUrl(el.value, "뷰어 초대코드");
      });
      // [P53] 초대 링크 공유 — navigator.share() 는 사용자 제스처 안에서 동기 호출해야 하므로
      //   이 핸들러 자체를 async 로 만들지 않는다(await 를 앞세우면 제스처가 끊겨 브라우저가 거부한다).
      $("pm-invite-share") && $("pm-invite-share").addEventListener("click", () => this._shareInviteLink());
      // [멀티테넌트] 서브도메인 부여
      $("pm-subdomain-btn") && $("pm-subdomain-btn").addEventListener("click", () => this.setSubdomain());
      // [마스터 요청] 디자이너/뷰어 선택 모달
      $("pms-cancel") && $("pms-cancel").addEventListener("click", () => this.closeModeSelect());
      $("pms-backdrop") && $("pms-backdrop").addEventListener("click", () => this.closeModeSelect());
      $("pms-btn-designer") && $("pms-btn-designer").addEventListener("click", () => this._enterAsDesigner());
      $("pms-btn-viewer") && $("pms-btn-viewer").addEventListener("click", () => this._enterAsViewer());
      const pmSub = $("pm-subdomain");
      if (pmSub) {
        pmSub.addEventListener("input", () => {
          const v = (pmSub.value || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
          const pv = document.getElementById("pm-sub-preview"); if (pv) pv.textContent = v || "name";
        });
        pmSub.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); this.setSubdomain(); } });
      }
    },

    async setSubdomain() {
      const p = this._memProject; if (!p) return;
      const inp = document.getElementById("pm-subdomain");
      const err = document.getElementById("pm-subdomain-error");
      const statusEl = document.getElementById("pm-subdomain-status");
      if (err) err.classList.add("hidden");
      const sub = (inp.value || "").trim();
      try {
        const r = await fetch("/api/projects/" + encodeURIComponent(p.id) + "/subdomain", {
          method: "POST", headers: Auth.headers(), body: JSON.stringify({ subdomain: sub || null })
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { if (err) { err.textContent = j.error || "설정 실패"; err.classList.remove("hidden"); } return; }
        p.subdomain = j.subdomain || null;
        this._renderSubdomainStatus(j.subdomain, j.url);
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast(j.subdomain ? ("전용 도메인 설정: " + (j.url || j.subdomain)) : "도메인 해제됨");
        // 카드 목록도 갱신
        this.refreshIfVisible && this.refreshIfVisible();
      } catch (e) { if (err) { err.textContent = "네트워크 오류"; err.classList.remove("hidden"); } }
    },
    _renderSubdomainStatus(sub, url) {
      const statusEl = document.getElementById("pm-subdomain-status");
      if (!statusEl) return;
      if (sub) statusEl.innerHTML = '현재: <a href="' + (url || ("https://" + sub)) + '" target="_blank" rel="noopener" class="pm-sub-link">' + (url || sub) + '</a> <button class="pm-sub-clear" type="button">해제</button>';
      else statusEl.textContent = "아직 전용 도메인이 없습니다.";
      const clr = statusEl.querySelector(".pm-sub-clear");
      if (clr) clr.addEventListener("click", () => { const inp = document.getElementById("pm-subdomain"); if (inp) inp.value = ""; this.setSubdomain(); });
    },

    /* ── [P3] 프로젝트별 멤버 배정 — GET/POST/DELETE /api/projects/:id/members ── */
    async openMembers(p) {
      this._memProject = p;
      const m = document.getElementById("proj-members-modal");
      if (!m) return;
      const nm = document.getElementById("pm-proj-name"); if (nm) nm.textContent = p.name || p.id;
      const err = document.getElementById("pm-add-error"); if (err) err.classList.add("hidden");
      const inp = document.getElementById("pm-email"); if (inp) inp.value = "";
      // [멀티테넌트] 현재 서브도메인 표시 + 베이스도메인
      const subInp = document.getElementById("pm-subdomain"); if (subInp) subInp.value = p.subdomain || "";
      const pv = document.getElementById("pm-sub-preview"); if (pv) pv.textContent = p.subdomain || "name";
      const subErr = document.getElementById("pm-subdomain-error"); if (subErr) subErr.classList.add("hidden");
      this._renderSubdomainStatus(p.subdomain, null);
      try {
        const t = await fetch("/api/tenant/resolve").then((r) => r.json());
        const baseEl = document.getElementById("pm-sub-base"); if (baseEl && t && t.base) baseEl.textContent = t.base;
        if (p.subdomain && t && t.base) this._renderSubdomainStatus(p.subdomain, "https://" + p.subdomain + "." + t.base);
      } catch (e) {}
      // [P63] 직전 발급물은 모달을 열 때마다 감춘다 — 원문은 발급 순간에만 존재한다.
      const codeBox = document.getElementById("pm-code-new-box"); if (codeBox) codeBox.classList.add("hidden");
      const codeErr = document.getElementById("pm-code-error"); if (codeErr) codeErr.classList.add("hidden");
      const codeLbl = document.getElementById("pm-code-label"); if (codeLbl) codeLbl.value = "";
      m.classList.remove("hidden"); requestAnimationFrame(() => m.classList.add("on"));
      await Promise.all([this.loadMembers(), this.loadAccessReqs(), this.loadPendingInvites(), this.loadShareCodes()]);
    },
    closeMembers() {
      const m = document.getElementById("proj-members-modal");
      if (!m) return; m.classList.remove("on"); setTimeout(() => m.classList.add("hidden"), 200);
    },
    async loadMembers() {
      const p = this._memProject; if (!p) return;
      const list = document.getElementById("pm-list");
      if (list) list.innerHTML = '<div class="designers-loading">불러오는 중...</div>';
      try {
        const r = await fetch("/api/projects/" + encodeURIComponent(p.id) + "/members", { headers: Auth.headers() });
        if (!r.ok) throw new Error("forbidden");
        const { data } = await r.json();
        const esc = (s) => (typeof UI !== "undefined" && UI.escapeHtml) ? UI.escapeHtml(s) : s;
        if (!data || !data.length) { list.innerHTML = '<div class="designers-empty">아직 배정된 멤버가 없습니다. (배정 전: 미배포 프로젝트는 전체 설계자에게, 배포 시 뷰어 전체에게 보임)</div>'; return; }
        list.innerHTML = "";
        data.forEach((mem) => {
          const row = document.createElement("div");
          row.className = "member-row";
          const roleLabel = mem.role === "designer" ? "디자이너" : (mem.role === "editor" ? "편집자" : "뷰어");
          row.innerHTML = '<span class="mem-col-email" title="' + esc(mem.email) + '">' + esc(mem.email) + '</span>' +
            '<span class="pm-role-badge role-' + esc(mem.role) + '">' + roleLabel + '</span>' +
            '<button class="designer-del" title="배정 해제">✕</button>';
          row.querySelector(".designer-del").addEventListener("click", () => this.removeMember(mem.email));
          list.appendChild(row);
        });
      } catch (e) { if (list) list.innerHTML = '<div class="designers-empty">목록을 불러올 수 없습니다(소유자/관리자만 가능).</div>'; }
    },
    async loadAccessReqs() {
      const p = this._memProject; if (!p) return;
      const sec = document.getElementById("pm-access-reqs");
      const list = document.getElementById("pm-access-reqs-list");
      if (!sec || !list) return;
      try {
        const r = await fetch("/api/projects/" + encodeURIComponent(p.id) + "/access-requests?status=pending", { headers: Auth.headers() });
        if (!r.ok) { sec.classList.add("hidden"); return; }
        const { data } = await r.json();
        if (!data || !data.length) { sec.classList.add("hidden"); return; }
        sec.classList.remove("hidden");
        const esc = (s) => (typeof UI !== "undefined" && UI.escapeHtml) ? UI.escapeHtml(s) : s;
        list.innerHTML = "";
        data.forEach((req) => {
          const d = new Date(req.created_at);
          const dateStr = d.getFullYear() + "." + String(d.getMonth()+1).padStart(2,"0") + "." + String(d.getDate()).padStart(2,"0");
          const row = document.createElement("div");
          row.className = "par-row";
          row.innerHTML = '<span class="par-email" title="' + esc(req.email) + '">' + esc(req.email) + '</span>' +
            (req.message ? '<span class="par-msg">' + esc(req.message) + '</span>' : '') +
            '<span class="par-date">' + dateStr + '</span>' +
            '<button class="admin-gate-btn primary par-btn-approve" data-rid="' + esc(req.id) + '" type="button">승인</button>' +
            '<button class="admin-gate-btn danger par-btn-reject" data-rid="' + esc(req.id) + '" type="button">거절</button>';
          row.querySelector(".par-btn-approve").addEventListener("click", () => this._handleAccessReq(req.id, "approve"));
          row.querySelector(".par-btn-reject").addEventListener("click", () => this._handleAccessReq(req.id, "reject"));
          list.appendChild(row);
        });
      } catch (e) { sec.classList.add("hidden"); }
    },
    async _handleAccessReq(rid, action) {
      const p = this._memProject; if (!p) return;
      try {
        const r = await fetch("/api/projects/" + encodeURIComponent(p.id) + "/access-requests/" + encodeURIComponent(rid) + "/" + action,
          { method: "POST", headers: Auth.headers() });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const label = action === "approve" ? "승인" : "거절";
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("" + label + " 처리됨");
        await this.loadAccessReqs();
        if (action === "approve") await this.loadMembers();
      } catch (e) { alert("처리 실패: " + (e && e.message ? e.message : "오류")); }
    },

    // 접근 신청 모달 (비멤버 사용자)
    openAccessReq(p) {
      this._reqProject = p;
      const m = document.getElementById("proj-access-req-modal"); if (!m) return;
      const nm = document.getElementById("par-proj-name"); if (nm) nm.textContent = p.name || p.id;
      const msg = document.getElementById("par-message"); if (msg) msg.value = "";
      const err = document.getElementById("par-error"); if (err) err.classList.add("hidden");
      const sub = document.getElementById("par-submit");
      const pendingMsg = document.getElementById("par-pending-msg");
      if (p.my_request === "pending") {
        if (pendingMsg) pendingMsg.classList.remove("hidden");
        if (msg) msg.classList.add("hidden");
        if (sub) { sub.textContent = "다시 신청"; sub.disabled = false; }
      } else {
        if (pendingMsg) pendingMsg.classList.add("hidden");
        if (msg) msg.classList.remove("hidden");
        if (sub) { sub.textContent = "신청하기"; sub.disabled = false; }
      }
      m.classList.remove("hidden"); requestAnimationFrame(() => m.classList.add("on"));
    },
    closeAccessReq() {
      const m = document.getElementById("proj-access-req-modal"); if (!m) return;
      m.classList.remove("on"); setTimeout(() => m.classList.add("hidden"), 200);
    },
    async submitAccessReq() {
      const p = this._reqProject; if (!p) return;
      const sub = document.getElementById("par-submit");
      const err = document.getElementById("par-error"); if (err) err.classList.add("hidden");
      const message = (document.getElementById("par-message") || {}).value || "";
      if (sub) { sub.disabled = true; sub.textContent = "신청 중…"; }
      try {
        const r = await fetch("/api/projects/" + encodeURIComponent(p.id) + "/request-access",
          { method: "POST", headers: Auth.headers(), body: JSON.stringify({ message }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok && r.status !== 409) {
          if (err) { err.textContent = j.error || "신청 실패"; err.classList.remove("hidden"); }
          if (sub) { sub.disabled = false; sub.textContent = "신청하기"; }
          return;
        }
        // 성공 또는 409(already member)
        p.my_request = "pending";
        this.closeAccessReq();
        const label = r.status === 409 ? "이미 멤버입니다." : "접근 신청이 접수되었습니다. 관리자 승인을 기다려 주세요.";
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("" + label, 3000);
        // 카드 상태 갱신
        this.render();
      } catch (e) {
        if (err) { err.textContent = "네트워크 오류"; err.classList.remove("hidden"); }
        if (sub) { sub.disabled = false; sub.textContent = "신청하기"; }
      }
    },

    async addMember() {
      const p = this._memProject; if (!p) return;
      const inp = document.getElementById("pm-email");
      const sel = document.getElementById("pm-role");
      const err = document.getElementById("pm-add-error");
      if (err) err.classList.add("hidden");
      const email = (inp.value || "").trim().toLowerCase();
      const role = sel ? sel.value : "viewer";
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { if (err) { err.textContent = "올바른 이메일을 입력하세요."; err.classList.remove("hidden"); } return; }
      try {
        const r = await fetch("/api/projects/" + encodeURIComponent(p.id) + "/members", { method: "POST", headers: Auth.headers(), body: JSON.stringify({ email, role }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { if (err) { err.textContent = j.error || "배정 실패"; err.classList.remove("hidden"); } return; }
        inp.value = "";
        await this.loadMembers();
        const roleLabel = role === "designer" ? "디자이너(모든 구역 세팅)" : "뷰어(열람)";
        if (j.invited && j.invite_url) {
          // [P40] 계정은 만들어지지 않았다. 링크를 받은 본인이 이름·비번을 설정해야 계정이 생긴다.
          this._showInviteLink(email, roleLabel, j.invite_url, j.expires_at);
        } else if (typeof Prompt !== "undefined" && Prompt.toast) {
          Prompt.toast("" + email + " 배정(" + roleLabel + ") — 기존 계정이라 바로 접근할 수 있습니다.", 4000);
        }
      } catch (e) { if (err) { err.textContent = "네트워크 오류"; err.classList.remove("hidden"); } }
    },
    /* ── [P40] 초대 링크 ── */
    /** 발급된 1회용 초대 링크를 관리자에게 보여준다(토큰 원문은 이 순간에만 존재 — DB 엔 해시만). */
    _showInviteLink(email, roleLabel, url, expiresAt) {
      const box = document.getElementById("pm-invite-link-box");
      const inp = document.getElementById("pm-invite-link");
      if (!box || !inp) {
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("초대 링크: " + url, 8000);
        return;
      }
      inp.value = url;
      const note = document.getElementById("pm-invite-link-note");
      if (note) {
        const d = expiresAt ? new Date(Number(expiresAt)) : null;
        const ds = d ? (d.getFullYear() + "." + String(d.getMonth() + 1).padStart(2, "0") + "." + String(d.getDate()).padStart(2, "0")) : "";
        note.textContent = email + " (" + roleLabel + ") — 이 링크를 본인에게 전달하세요. 1회용" + (ds ? (" · " + ds + " 까지") : "") + ". 계정은 본인이 이름·비밀번호를 설정할 때 생성됩니다.";
      }
      box.classList.remove("hidden");
      try { inp.select(); } catch (e) {}
      this._copyInviteLink();
    },
    _copyInviteLink() {
      const inp = document.getElementById("pm-invite-link");
      if (!inp || !inp.value) return;
      const done = () => { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("초대 링크를 복사했습니다."); };
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(inp.value).then(done).catch(() => {}); return; }
        inp.select(); document.execCommand("copy"); done();
      } catch (e) {}
    },
    /** [P53] 초대 링크 공유 — 폰에서 누르면 공유시트(카톡 등)가 뜬다.
     *  navigator.share 미지원 환경(데스크톱 크롬 등)은 기존 복사 동작(_copyInviteLink, SoT)으로 대체한다.
     *  🔴 navigator.share 는 사용자 제스처 컨텍스트 안에서만 호출되므로 이 함수는 async 가 아니고,
     *  호출도 클릭 핸들러에서 await 없이 동기적으로 이뤄진다. */
    _shareInviteLink() {
      const inp = document.getElementById("pm-invite-link");
      const url = inp && inp.value;
      if (!url) return;
      if (!navigator.share) { this._copyInviteLink(); return; }
      const p = this._memProject;
      const projectName = (p && (p.name || p.id)) || "프로젝트"; // SoT: 실제 프로젝트 값에서만 가져온다(하드코딩 금지)
      navigator.share({ title: "SEASTAR 360 초대", text: '"' + projectName + '" 프로젝트 초대 링크', url: url })
        .catch((e) => {
          if (e && e.name === "AbortError") return; // 사용자가 공유시트를 취소 — 정상 동작, 오류 알림 금지
          if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("공유 실패: " + (e && e.message ? e.message : "알 수 없는 오류"));
        });
    },
    /** 아직 수락되지 않은 초대 목록(토큰 원문은 서버가 절대 돌려주지 않는다) */
    async loadPendingInvites() {
      const p = this._memProject; if (!p) return;
      const sec = document.getElementById("pm-pending-invites");
      const list = document.getElementById("pm-pending-invites-list");
      if (!sec || !list) return;
      try {
        const r = await fetch("/api/projects/" + encodeURIComponent(p.id) + "/invites", { headers: Auth.headers() });
        if (!r.ok) { sec.classList.add("hidden"); return; }
        const { data } = await r.json();
        if (!data || !data.length) { sec.classList.add("hidden"); return; }
        sec.classList.remove("hidden");
        const esc = (s) => (typeof UI !== "undefined" && UI.escapeHtml) ? UI.escapeHtml(s) : s;
        list.innerHTML = "";
        data.forEach((iv) => {
          const d = new Date(Number(iv.expires_at));
          const ds = d.getFullYear() + "." + String(d.getMonth() + 1).padStart(2, "0") + "." + String(d.getDate()).padStart(2, "0");
          const roleLabel = (typeof Auth !== "undefined" && Auth._ROLE_LABELS && Auth._ROLE_LABELS[iv.role]) || iv.role;
          const row = document.createElement("div");
          row.className = "member-row";
          row.innerHTML = '<span class="mem-col-email" title="' + esc(iv.email) + '">' + esc(iv.email) + '</span>' +
            '<span class="pm-role-badge role-' + esc(iv.role) + '">' + esc(roleLabel) + '</span>' +
            '<span class="par-date">~' + ds + '</span>' +
            '<button class="designer-del" title="초대 취소">✕</button>';
          row.querySelector(".designer-del").addEventListener("click", () => this.revokeInvite(iv.id));
          list.appendChild(row);
        });
      } catch (e) { sec.classList.add("hidden"); }
    },
    async revokeInvite(iid) {
      const p = this._memProject; if (!p) return;
      try {
        await fetch("/api/projects/" + encodeURIComponent(p.id) + "/invites/" + encodeURIComponent(iid),
          { method: "DELETE", headers: Auth.headers() });
        await this.loadPendingInvites();
      } catch (e) {}
    },

    async removeMember(email) {
      const p = this._memProject; if (!p) return;
      if (!await Prompt.confirm("배정 해제", email + " 의 '" + (p.name || p.id) + "' 프로젝트 배정을 해제할까요?")) return;
      try {
        await fetch("/api/projects/" + encodeURIComponent(p.id) + "/members/" + encodeURIComponent(email), { method: "DELETE", headers: Auth.headers() });
        await this.loadMembers();
      } catch (e) {}
    },

    /** 화면 진입 시 호출 — 목록 로드 + 렌더 */
    async open() {
      UI.showScreen("screen-projects");
      Auth._applyUi();          // 인증바 상태 동기화 (hub 슬롯 포함)
      Auth._renderHubSignin();  // 미로그인 시 hub 로그인 버튼 렌더
      await this.load();
      // [마스터 2026-09-17] "첫 화면은 무조건 프로젝트 선택이 나오게 해" — 최근 프로젝트로
      //   건너뛰는 자동입장(옛 AUTO_DESIGNER_ENTRY 연장 블록)을 제거했다. 배포 링크(?d=)가 아닌
      //   모든 진입은 여기서 항상 카드 목록(프로젝트 허브)을 보여준다.
    },

    async load() {
      // [P63] 공유·배포 링크 세션은 프로젝트 목록을 아예 불러오지도·그리지도 않는다.
      if (this._isShareEntry()) {
        this.list = []; this._loaded = true;
        const grid = document.getElementById("hub-grid"); if (grid) grid.innerHTML = "";
        const empty = document.getElementById("hub-empty"); if (empty) empty.classList.add("hidden");
        return;
      }
      // [마스터 핵심 워크플로 — 오프라인] 끊긴 상태면 서버 대신 다운로드한 번들(IndexedDB)에서
      //   프로젝트 목록을 복원한다. (폰에서 오프라인으로 앱을 열어도 받아둔 프로젝트가 보임)
      if (!navigator.onLine && typeof OfflineLoad !== "undefined") {
        try {
          this.list = (await OfflineLoad.projects()).filter(Boolean);
          this._offline = true;
          if (typeof Prompt !== "undefined" && Prompt.toast && this.list.length)
            Prompt.toast("오프라인 — 다운로드한 프로젝트 " + this.list.length + "개 표시");
        } catch (e) { this.list = []; }
        this._loaded = true; this.render(); return;
      }
      try {
        // [버그수정] 인증헤더 필수 — 서버가 멤버십/배포 스코프로 필터하므로(미전송 시 익명취급→설계자 프로젝트 누락)
        // [견고화] 온라인 플래그는 true 인데 실제 네트워크가 죽은 경우(지하/캡티브포털) fetch 가
        //   무한 대기하는 것을 방지 — 6초 타임아웃(AbortController) → 실패 시 오프라인 번들 폴백.
        const ctrl = new AbortController();
        const t = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, 6000);
        let data;
        try {
          const r = await fetch("/api/projects", { headers: Auth.headers(), signal: ctrl.signal });
          ({ data } = await r.json());
        } finally { clearTimeout(t); }
        this.list = data || [];
        this._offline = false;
        await Promise.all([this._resolveDeployLinks(), this._loadDeckTrees()]);
      } catch (e) {
        // 네트워크 실패/타임아웃 → 오프라인 번들로 폴백(있으면)
        try { this.list = (typeof OfflineLoad !== "undefined") ? (await OfflineLoad.projects()).filter(Boolean) : []; this._offline = true; }
        catch (e2) { this.list = []; }
      }
      this._loaded = true;
      this.render();
    },

    /** [WO 20260921 publish-fix] subdomain 없는 배포 프로젝트의 딥링크(?d=)를 미리 조회해 캐시.
     *  실패해도 카드 렌더 자체는 정상 진행 — 주소 행만 조용히 생략(카드 붕괴 금지). */
    async _resolveDeployLinks() {
      // [P61] share_path 가 있으면 그것이 정본 주소다 → 레거시 `?d=` 조회를 할 이유가 없다(요청 절약).
      const targets = (this.list || []).filter((p) => p.published && !p.share_path && !p.subdomain && this._deployLinkCache[p.id] === undefined);
      if (!targets.length) return;
      await Promise.all(targets.map(async (p) => {
        try {
          const r = await fetch("/api/projects/" + encodeURIComponent(p.id) + "/decks", { headers: Auth.headers() });
          if (!r.ok) { this._deployLinkCache[p.id] = null; return; }
          const { data } = await r.json();
          const withDep = (data || []).find((d) => d.deployment_id);
          this._deployLinkCache[p.id] = withDep ? withDep.deployment_id : null;
        } catch (e) { this._deployLinkCache[p.id] = null; }
      }));
    },

    /** [WO 20260928-hub-tree] 카드 아래 구역→영역 트리용 decks 조회.
     *  🔴 프로젝트별 요청 1회씩이지만 Promise.all 로 병렬화(N+1 아님 — _resolveDeployLinks 와 동일
     *  기존 관행). 배치 엔드포인트가 없고 src/** 는 이번 작업 범위 밖(발주서 파일 점유 제한)이라
     *  기존 /api/projects/:id/decks 를 그대로 쓴다. 실패해도 카드 렌더는 계속(트리만 생략).
     *  잠긴(비멤버) 카드는 조회하지 않는다 — 접근 못하는 프로젝트의 구조를 드러내지 않는다. */
    async _loadDeckTrees() {
      const targets = (this.list || []).filter((p) => !(Auth.idToken && p.is_member === false));
      await Promise.all(targets.map(async (p) => {
        try {
          const r = await fetch("/api/projects/" + encodeURIComponent(p.id) + "/decks", { headers: Auth.headers() });
          if (!r.ok) { this._deckTreeCache[p.id] = []; return; }
          const { data } = await r.json();
          // [WO 20260928-hub-tree] 서버가 이미 deleted=0 만 내려주지만(SoT: src/index.tsx GET decks),
          //   방어적으로도 한 번 더 거른다(§5 — deleted=1 은 안 보여야 한다).
          this._deckTreeCache[p.id] = (data || []).filter((d) => !d.deleted);
        } catch (e) { this._deckTreeCache[p.id] = []; }
      }));
    },

    /** [WO 20260928-hub-tree] 카드 하나의 구역→영역 트리 HTML.
     *  캐시가 아직 없으면(오프라인/잠김 등 "모름") 빈 문자열 — "구역 없음"을 함부로 단정하지 않는다. */
    _renderDeckTreeHtml(p) {
      const decks = this._deckTreeCache[p.id];
      if (decks === undefined) return "";
      const esc = (s) => UI.escapeHtml(s);
      // [WO 20260929-tree-label] 🔴 공유 지점(SoT) — UI.deckLabelHtml(11_UI.js) 하나만 쓴다.
      // 이 카드 트리와 사이드바 트리(renderTree)가 각자 이름 폴백을 만들면 반드시 갈라진다.
      const titleOf = (d) => esc(d.name ? d.name : "(이름 없음)");
      if (!decks.length) {
        return '<div class="hub-card-tree"><p class="hub-tree-empty">구역 없음</p></div>';
      }
      const { roots, childrenOf } = UI.groupDecksByParent(decks);
      const regionsHtml = (deck) => {
        const kids = childrenOf.get(String(deck.id)) || [];
        if (!kids.length) return "";
        return '<ul class="hub-tree-regions">' + kids.map((r) =>
          '<li class="hub-tree-region" data-act="deck-open" data-deck-id="' + esc(r.id) + '" title="' + titleOf(r) + '" tabindex="0" role="button">' + UI.deckLabelHtml(r) + '</li>'
        ).join("") + '</ul>';
      };
      const rootsHtml = roots.map((d) =>
        '<li class="hub-tree-deck" data-act="deck-open" data-deck-id="' + esc(d.id) + '" title="' + titleOf(d) + '" tabindex="0" role="button">' + UI.deckLabelHtml(d) + regionsHtml(d) + '</li>'
      ).join("");
      return '<div class="hub-card-tree"><ul class="hub-tree-decks">' + rootsHtml + '</ul></div>';
    },

    /** Auth 상태 변경 시 (로그인/로그아웃) 다시 그려 +새프로젝트·편집 버튼 토글 */
    refreshIfVisible() {
      const sc = document.getElementById("screen-projects");
      if (sc && sc.classList.contains("active")) {
        // [버그수정 #1] 인증 변경(자동 로그인 완료 등) 시 프로젝트 재로드 —
        //   첫 진입 시 로그인 전 익명으로 빈 목록을 받아 "프로젝트 없음"으로 보이던 버그 수정.
        this.load();
        Auth._renderHubSignin();
      }
    },

    /* [마스터 요청 #2] 프로젝트마다 "다른" 썸네일 아이콘 — id/name 해시로 6종 형상 +
       6종 액센트색을 결정적으로 선택(같은 프로젝트는 항상 같은 아이콘). */
    _iconSvg(p) {
      const ICONS = [
        // 0) 화물선(cargo)
        '<path d="M14 44 L116 44 L106 58 L24 58 Z"/><path d="M30 44 L30 28 L86 28 L86 44"/><path d="M40 28 L40 18 L66 18 L66 28"/><rect x="72" y="22" width="9" height="6" rx="1.5"/><line x1="96" y1="44" x2="96" y2="30"/><line x1="96" y1="30" x2="110" y2="34"/>',
        // 1) 해양 플랫폼/리그(offshore rig)
        '<path d="M20 40 L112 40 L112 48 L20 48 Z"/><path d="M30 48 L26 66 M50 48 L48 66 M82 48 L84 66 M102 48 L106 66"/><path d="M58 40 L66 14 L74 40 Z"/><line x1="66" y1="14" x2="66" y2="40"/><line x1="40" y1="40 " x2="40" y2="32"/><rect x="34" y="30" width="14" height="10" rx="1"/>',
        // 2) 탱커(tanker) — 길고 낮은 선체 + 파이프 매니폴드
        '<path d="M10 42 L120 42 L112 56 L18 56 Z"/><rect x="44" y="30" width="42" height="12" rx="2"/><line x1="52" y1="30" x2="52" y2="22" /><line x1="64" y1="30" x2="64" y2="22"/><line x1="76" y1="30" x2="76" y2="22"/><path d="M96 42 L96 30 L108 30 L108 42"/>',
        // 3) 갠트리/도크 크레인(gantry crane)
        '<path d="M22 60 L22 24 M104 60 L104 24"/><path d="M14 24 L112 24"/><path d="M63 24 L63 40"/><rect x="55" y="40" width="16" height="9" rx="1.5"/><path d="M14 60 L114 60"/><path d="M30 24 L30 18 L52 18"/>',
        // 4) 모스타입 LNG선 (Moss-type — 구형 모스탱크 4기 + 선미 거주구)
        '<path d="M8 46 L122 46 L113 58 L17 58 Z"/><circle cx="30" cy="35" r="8.5"/><circle cx="51" cy="35" r="8.5"/><circle cx="72" cy="35" r="8.5"/><circle cx="93" cy="35" r="8.5"/><path d="M104 46 L104 30 L118 30 L118 46"/><line x1="108" y1="30" x2="108" y2="23"/><line x1="14" y1="46" x2="116" y2="46" stroke-opacity=".45"/>',
        // 5) LNG선(구형 탱크)
        '<path d="M12 44 L120 44 L110 58 L22 58 Z"/><circle cx="44" cy="34" r="11"/><circle cx="74" cy="34" r="11"/><path d="M96 44 L96 30 L104 26"/><line x1="44" y1="23" x2="44" y2="44"/><line x1="74" y1="23" x2="74" y2="44"/>',
      ];
      const ACC = ["#3a97dd", "#e0b14a", "#46c0a0", "#cf7bd6", "#7f8cff", "#46c08a"];
      const i = Math.abs(this._hash(p.id || p.name)) % ICONS.length;
      const c = ACC[i];
      return '<svg class="hub-thumb-ship hub-thumb-icon-' + i + '" viewBox="0 0 132 72" fill="none" ' +
        'stroke="' + c + '" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ' +
        'style="filter:drop-shadow(0 2px 6px rgba(0,0,0,.45))">' +
        '<g fill="' + c + '" fill-opacity=".14">' + ICONS[i] + '</g>' +
      '</svg>';
    },

    render() {
      const grid  = document.getElementById("hub-grid");
      const empty = document.getElementById("hub-empty");
      const btnNew = document.getElementById("hub-btn-new");
      const emptyHint = document.getElementById("hub-empty-hint");
      if (!grid) return;

      const isDesigner = Auth.isDesigner;
      // +새 프로젝트 버튼: 디자이너만
      if (btnNew) btnNew.classList.toggle("hidden", !isDesigner);

      grid.innerHTML = "";

      if (!this.list.length) {
        empty && empty.classList.remove("hidden");
        if (emptyHint) emptyHint.textContent = isDesigner
          ? "우측 상단 '+ 새 프로젝트'로 첫 프로젝트를 만들어 보세요."
          : "설계자로 로그인하면 새 프로젝트를 만들 수 있습니다.";
        return;
      }
      empty && empty.classList.add("hidden");

      this.list.forEach((p) => {
        // is_member: 명시적으로 false = 비멤버(잠금), undefined/true = 멤버(정상)
        const isLocked = Auth.idToken && p.is_member === false;
        const isPending = isLocked && p.my_request === "pending";
        const card = document.createElement("div");
        card.className = "hub-card" + (isLocked ? " hub-card-locked" : "");
        card.setAttribute("role", "listitem");
        card.tabIndex = 0;
        const deckTxt = (p.deck_count != null) ? (p.deck_count + " DECKS") : "";
        const dateTxt = this._fmtDate(p.created_at);
        const code = "SS-" + String(Math.abs(this._hash(p.id || p.name)) % 9000 + 1000);
        // [WO 20260921 deploy-url] 배포된 프로젝트만 주소 노출 — SoT: p.published(배지와 동일 소스)
        const deployUrl = p.published ? this._deployUrl(p) : "";
        const lockOverlay = isLocked
          ? '<div class="hub-card-lock" aria-hidden="true">' +
              '<svg class="hub-lock-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="28" height="28"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>' +
              '<span class="hub-lock-txt">' + (isPending ? "⏳ 심사 중" : "접근 신청") + '</span>' +
            '</div>'
          : '';
        card.innerHTML =
          '<div class="hub-card-thumb">' +
            '<div class="hub-thumb-grid"></div>' +
            '<div class="hub-thumb-scan"></div>' +
            this._iconSvg(p) +
            '<span class="hub-thumb-code">' + code + '</span>' +
            lockOverlay +
          '</div>' +
          '<div class="hub-card-body">' +
            '<div class="hub-card-name">' + UI.escapeHtml(p.name) +
              (p.published ? ' <span class="hub-pub-badge" title="뷰어에게 배포됨">● 배포됨</span>' : '') +
            '</div>' +
            '<div class="hub-card-meta">' +
              (deckTxt ? '<span class="hub-card-decks">' + deckTxt + '</span>' : '') +
              (dateTxt ? '<span class="hub-card-date">' + dateTxt + '</span>' : '') +
              (isPending ? '<span class="hub-card-req-badge">⏳ 신청 접수됨</span>' : '') +
            '</div>' +
            (deployUrl
              ? '<div class="hub-card-url">' +
                  '<span class="hub-card-url-text" title="' + UI.escapeHtml(deployUrl) + '" data-act="url-toggle">' + UI.escapeHtml(deployUrl) + '</span>' +
                  '<button class="hub-card-url-copy" type="button" title="주소 복사" aria-label="주소 복사" data-act="url-copy">' +
                    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' +
                  '</button>' +
                  '<button class="hub-card-url-share" type="button" title="주소 공유" aria-label="주소 공유" data-act="url-share">' +
                    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>' +
                  '</button>' +
                '</div>'
              : (p.published
                  // [WO 20260921 publish-guard] 배포됨인데 링크가 없는 경우(도면 미등록 — 서버가 신규
                  // 배포는 막지만, 이 안내는 그 가드 이전에 이미 배포된 레거시 프로젝트도 함께 구제한다)
                  // → 조용히 비워두지 않고 이유를 표시(CLAUDE.md §5: 값이 없으면 없다고 정직하게 표시).
                  ? '<div class="hub-card-url-empty">⚠ 공유 링크 없음 — 도면(구역)을 등록해야 뷰어 주소가 생성됩니다.</div>'
                  : '')) +
          '</div>' +
          (isDesigner && !isLocked
            ? '<div class="hub-card-actions">' +
                '<button class="hub-card-act hub-card-pub' + (p.published ? ' is-pub' : '') + '" title="' + (p.published ? '배포됨 — 클릭 시 배포취소(뷰어 비공개)' : '뷰어에게 배포(공개)') + '" data-act="pub" aria-label="배포">' +
                  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>' +
                  '<span class="hub-card-act-label">배포</span>' +
                '</button>' +
                '<button class="hub-card-act hub-card-dl" title="오프라인 다운로드" data-act="dl" data-help="offline-download" aria-label="오프라인 다운로드">' +
                  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>' +
                  '<span class="hub-card-act-label" data-dl-label>다운로드</span>' +
                '</button>' +
                '<button class="hub-card-act hub-card-members" title="멤버 관리 — 이 프로젝트에 접근할 사용자 배정" data-act="members" aria-label="멤버 관리">' +
                  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>' +
                  '<span class="hub-card-act-label">멤버</span>' +
                '</button>' +
                '<button class="hub-card-act hub-card-del" title="삭제" data-act="del" aria-label="삭제">' +
                  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>' +
                  '<span class="hub-card-act-label">삭제</span>' +
                '</button>' +
              '</div>'
            : '') +
          // [WO 20260928-hub-tree] 마스터: "전체 프로젝트 페이지에 구역-영역 리스트, 이름이
          // 동시에 보여야" — 잠긴(비멤버) 카드는 구조를 드러내지 않는다(§ 개인정보/권한).
          (isLocked ? '' : this._renderDeckTreeHtml(p));

        // 카드 클릭
        card.addEventListener("click", (e) => {
          if (e.target.closest("[data-act]")) return;
          if (isLocked) { this.openAccessReq(p); return; }
          this.openProject(p);
        });
        card.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (isLocked) { this.openAccessReq(p); return; }
            this.openProject(p);
          }
        });
        // 삭제 버튼
        const del = card.querySelector('[data-act="del"]');
        if (del) del.addEventListener("click", (e) => { e.stopPropagation(); this.deleteProject(p); });

        // [오프라인 작업지시서 ] 오프라인 다운로드 버튼 — 실 로직은 downloadProject() 정본(SoT)
        const dl = card.querySelector('[data-act="dl"]');
        if (dl) dl.addEventListener("click", (e) => { e.stopPropagation(); this.downloadProject(p, dl); });
        // 카드가 화면에 그려질 때마다 "이미 오프라인 저장돼 있는지" 표시 —
        // 눌러봐야 아는 게 아니라 항상 보이게(마스터 지시: 상태는 보여야 한다)
        if (dl) this._refreshDlState(dl, p.id);

        // 배포(Publish) 버튼 — 설계자가 프로젝트를 뷰어에게 공개/비공개 토글
        const pub = card.querySelector('[data-act="pub"]');
        if (pub) pub.addEventListener("click", (e) => { e.stopPropagation(); this.togglePublish(p, pub); });

        // [P3] 멤버 관리 버튼 — 이 프로젝트에 접근할 사용자 배정
        const mem = card.querySelector('[data-act="members"]');
        if (mem) mem.addEventListener("click", (e) => { e.stopPropagation(); this.openMembers(p); });

        // [WO 20260921 deploy-url] 배포 주소 — 복사/공유/탭하면 펼침
        const urlCopy = card.querySelector('[data-act="url-copy"]');
        if (urlCopy) urlCopy.addEventListener("click", (e) => { e.stopPropagation(); this._copyDeployUrl(deployUrl); });
        const urlShare = card.querySelector('[data-act="url-share"]');
        if (urlShare) urlShare.addEventListener("click", (e) => { e.stopPropagation(); this._shareDeployUrl(deployUrl, p.name); });
        const urlText = card.querySelector('[data-act="url-toggle"]');
        if (urlText) urlText.addEventListener("click", (e) => { e.stopPropagation(); urlText.classList.toggle("is-expanded"); });

        // [WO 20260928-hub-tree] 구역/영역 클릭 → 그 구역/영역으로 바로 진입(기존 열기 경로 재사용).
        const treeEl = card.querySelector(".hub-card-tree");
        if (treeEl) {
          const openDeckNode = (e) => {
            const node = e.target.closest("[data-deck-id]");
            if (!node) return;
            e.stopPropagation();
            this.openProjectAtDeck(p, node.getAttribute("data-deck-id"));
          };
          treeEl.addEventListener("click", openDeckNode);
          treeEl.addEventListener("keydown", (e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            if (!e.target.closest("[data-deck-id]")) return;
            e.preventDefault();
            openDeckNode(e);
          });
        }

        grid.appendChild(card);
      });

      // 디자이너면 "+새 프로젝트" 카드도 그리드 맨 앞에 추가
      if (isDesigner) {
        const add = document.createElement("div");
        add.className = "hub-card hub-card-add";
        add.tabIndex = 0;
        add.setAttribute("role", "listitem");
        add.innerHTML = '<div class="hub-card-add-plus">+</div><div class="hub-card-add-label">새 프로젝트</div>';
        const go = () => this.createProject();
        add.addEventListener("click", go);
        add.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
        grid.insertBefore(add, grid.firstChild);
      }
    },

    /** 프로젝트 진입: Auth.isDesigner 자동판정으로 조용히 결정하지 않고,
     *  항상 "디자이너로 열기"/"뷰어로 열기" 선택 모달을 띄워 사용자가 직접 고른다.
     *  (AUTO_DESIGNER_ENTRY로 자동입장한 경우에도 이 선택 단계는 건너뛰지 않는다.) */
    async openProject(p) {
      // 선택 프로젝트를 Projects 모듈과 공유 (작업화면 사이드바 동기화용)
      Projects.list = this.list;
      Projects.currentProject = p;
      State.currentProjectId = p.id;
      State.currentProjectName = p.name;
      // [P40] 우상단 배지를 "이 프로젝트에서의 내 역할"로 — 고정 '디자이너' 표기 제거
      if (typeof Auth !== "undefined" && Auth.setProjectContext) Auth.setProjectContext(p);
      this._modeSelectProject = p;
      if (!ASK_ENTRY_MODE) { // 스위치 OFF: 묻지 않고 무조건 편집모드로 바로 진입
        await this._enterAsDesigner();
        return;
      }
      const m = document.getElementById("proj-mode-select-modal");
      if (!m) { // 모달 마크업이 없으면(구버전) 안전 폴백 — 기존 자동판정 동작 유지
        if (Auth.isDesigner) App.openApp(PinSeries.preferredMode(), { project: p });
        else App.openApp("viewer", { project: p });
        return;
      }
      const nm = document.getElementById("pms-proj-name"); if (nm) nm.textContent = p.name || p.id;
      m.classList.remove("hidden"); requestAnimationFrame(() => m.classList.add("on"));
    },

    /** [WO 20260928-hub-tree] 카드의 구역/영역 클릭 → 그 구역으로 바로 진입.
     *  🔴 새 진입 로직을 만들지 않는다 — openProject()(기존 진입) 뒤에 Projects.selectDeck()
     *  (기존 "구역 열기" 정본, 31_Projects.js)을 그대로 호출한다.
     *  requireDesigner 게이트가 열려(로그인 대기) 편집모드 진입이 아직 안 끝났으면 여기서
     *  멈춘다 — 로그인 완료 후에는 기존 동작(최신 배포본 진입)으로 이어진다(회귀 없음). */
    async openProjectAtDeck(p, deckId) {
      await this.openProject(p);
      if (!Auth.isDesigner) return;
      try {
        await Projects.loadDecks();
        const deck = (Projects.decks || []).find((d) => String(d.id) === String(deckId));
        if (deck && Projects.selectDeck) await Projects.selectDeck(deck);
      } catch (e) {}
    },
    closeModeSelect() {
      const m = document.getElementById("proj-mode-select-modal");
      if (!m) return; m.classList.remove("on"); setTimeout(() => m.classList.add("hidden"), 200);
    },
    async _enterAsDesigner() {
      const p = this._modeSelectProject; if (!p) return;
      this.closeModeSelect();
      // 회귀 방지: 설계자 토큰이 있는데 권한 확인(refresh)이 아직 끝나지 않아
      //   isDesigner가 false인 채로 진입하면 "PDF 업로드가 안 된다"는 회귀 느낌을 준다.
      //   토큰이 있으면 권한 재확인을 한 번 await 한 뒤 게이트를 판단한다.
      if (!Auth.isDesigner && Auth.idToken) {
        try { await Auth.refresh(); } catch (e) {}
      }
      // AUTO_DESIGNER_ENTRY 등으로 이미 디자이너 권한이 있으면 게이트 없이 바로 진입,
      //   없으면 기존 로그인 게이트 경로(Auth.requireDesigner) 유지.
      // [마스터 요청 2026-09-18] 편집 진입 기본 모드 = 체크보드(사용자 전환 시 유지)
      if (Auth.isDesigner) App.openApp(PinSeries.preferredMode(), { project: p });
      else Auth.requireDesigner(() => App.openApp(PinSeries.preferredMode(), { project: p }));
    },
    _enterAsViewer() {
      const p = this._modeSelectProject; if (!p) return;
      this.closeModeSelect();
      // 뷰어는 로그인 불필요 — 기존 동작 유지
      App.openApp("viewer", { project: p });
    },

    async createProject() {
      if (!Auth.isDesigner) { Auth.requireDesigner(() => this.createProject()); return; }
      const res = await Prompt.ask({ title: "프로젝트 생성", sub: "새 프로젝트 이름을 입력하세요 (예: ○○호 검사)", placeholder: "프로젝트 이름" });
      if (!res || !res.value) return;
      try {
        const r = await fetch("/api/projects", { method: "POST", headers: Auth.headers(), body: JSON.stringify({ name: res.value }) });
        const p = await r.json();
        if (!r.ok) { alert(p.error || "생성 실패(권한 필요)"); return; }
        await this.load();
      } catch (e) { alert("네트워크 오류"); }
    },

    async deleteProject(p) {
      if (!Auth.isDesigner) return;
      if (!await Prompt.confirm("프로젝트 삭제", "'" + p.name + "' 프로젝트와 모든 데크를 삭제할까요?")) return;
      try {
        await fetch("/api/projects/" + p.id, { method: "DELETE", headers: Auth.headers() });
        await this.load();
      } catch (e) {}
    },

    /** [WO 20260918] 🔴 오프라인 다운로드 실행 정본(SoT) — 허브 카드 버튼과 프로젝트 안
     *  진입점(#btn-project-download, 31_Projects.js)이 이 함수 하나만 호출한다(새 함수 금지,
     *  로직 복제 금지). btnEl 은 선택적 — 넘기면 진행 중 disabled/라벨/제목을 갱신한다.
     *  @param {object} p 프로젝트({id,name})
     *  @param {HTMLElement} [btnEl] 눌린 버튼(진행 표시용, 없어도 동작) */
    async downloadProject(p, btnEl) {
      if (!p || !p.id) return;
      if (typeof OfflineBundle === "undefined") { Prompt.toast("오프라인 모듈 미로드"); return; }
      const orig = btnEl ? btnEl.innerHTML : null;
      if (btnEl) { btnEl.disabled = true; btnEl.classList.add("busy"); }
      try {
        const m = await OfflineBundle.download(p.id, (done, total, label) => {
          if (btnEl) btnEl.setAttribute("title", "다운로드 " + done + "/" + total + " · " + label);
        });
        const v = await OfflineBundle.verify(p.id);
        if (v.ok) Prompt.toast("오프라인 준비 완료 — 도면 " + m.deployments + "개 · 3D " + m.panos + "개");
        else Prompt.toast("일부 누락: " + (v.missing || []).length + "건 — 다시 시도하세요");
      } catch (err) { Prompt.toast("" + (err && err.message ? err.message : "다운로드 실패")); }
      finally {
        if (btnEl) { btnEl.disabled = false; btnEl.classList.remove("busy"); if (orig != null) btnEl.innerHTML = orig; }
        if (btnEl) this._refreshDlState(btnEl, p.id);
      }
    },

    /** 오프라인 다운로드 버튼 상태 갱신 — 기존 OfflineBundle.verify() 재사용(SoT).
     *  눌러야만 알 수 있는 상태를 없애기 위해 카드 렌더 시점 + 다운로드 직후 모두 호출한다. */
    async _refreshDlState(dl, projectId) {
      if (!dl || typeof OfflineBundle === "undefined" || !OfflineBundle.verify) return;
      try {
        const v = await OfflineBundle.verify(projectId);
        const label = dl.querySelector("[data-dl-label]");
        if (v && v.ok) {
          dl.classList.add("is-dl-done");
          if (label) label.textContent = "저장됨";
          dl.setAttribute("title", "오프라인 저장됨 — 다시 눌러 최신화");
        } else {
          dl.classList.remove("is-dl-done");
          if (label) label.textContent = "다운로드";
          dl.setAttribute("title", "오프라인 다운로드");
        }
      } catch (e) {}
    },

    /** 프로젝트 배포(Publish) 토글 — 배포하면 권한받은 뷰어가 열람 가능, 배포취소하면 뷰어에게 숨김 */
    async togglePublish(p, btn) {
      if (!Auth.isDesigner) { Auth.requireDesigner(() => this.togglePublish(p)); return; }
      const willPublish = !p.published;
      // [WO 20260921 publish-fix] window.confirm() → Prompt.confirm() (SoT: 30_Prompt.js).
      //  근본원인: PWA 독립실행모드에서 window.confirm()이 무음으로 false를 반환해 배포 버튼이
      //  아무 요청도 보내지 않았다(재현: 네트워크 0건·토스트 0건·콘솔오류 없음). 커스텀 DOM 모달은
      //  이 제약이 없다.
      const proceed = willPublish
        ? await Prompt.confirm("배포", "'" + p.name + "' 프로젝트를 뷰어에게 배포할까요?\n\n배포하면 이 프로젝트에 권한이 부여된 뷰어가 열람할 수 있습니다.")
        : await Prompt.confirm("배포 취소", "'" + p.name + "' 배포를 취소할까요?\n\n뷰어에게 더 이상 보이지 않게 됩니다.");
      if (!proceed) return;
      if (btn) { btn.disabled = true; btn.classList.add("busy"); }
      try {
        const r = await fetch("/api/projects/" + p.id + "/" + (willPublish ? "publish" : "unpublish"), { method: "POST", headers: Auth.headers() });
        if (!r.ok) {
          // [WO 20260921 publish-guard] 서버가 거부 사유(예: 도면 미등록)를 error 필드로 보낸다 —
          // 그대로 사용자에게 노출한다("HTTP 400" 같은 무의미한 코드로 뭉개지 않는다, 조용한 실패 금지).
          let msg = "HTTP " + r.status;
          try { const j = await r.json(); if (j && j.error) msg = j.error; } catch (e) {}
          throw new Error(msg);
        }
        p.published = willPublish;
        Prompt && Prompt.toast && Prompt.toast(willPublish ? "'" + p.name + "' 배포 완료 — 뷰어가 열람할 수 있습니다." : "'" + p.name + "' 배포 취소 — 뷰어에게 비공개.", 2800);
        await this.load();
      } catch (e) {
        Prompt && Prompt.toast && Prompt.toast("배포 처리 실패: " + (e && e.message ? e.message : "네트워크 오류"), 3200);
      } finally { if (btn) { btn.disabled = false; btn.classList.remove("busy"); } }
    },

    /** [WO 20260921 deploy-url, 수정 publish-fix] 배포된 프로젝트를 "식별하는" 뷰어 주소 —
     *  SoT: p.subdomain(실 DB 값) 우선, 없으면 _deployLinkCache(실 deployment_id, /api/projects/:id/decks
     *  에서 조회)로 만든 뷰어 딥링크(?d=). 현재 접속 호스트에서만 파생한다(도메인 하드코딩 금지).
     *  🔴 사이트 루트 폴백 금지 — 루트 주소는 프로젝트를 식별하지 못해 공유해도 쓸모가 없다.
     *  둘 다 없으면(도면 미등록) 빈 문자열 반환 → 카드에 주소 행 자체가 생기지 않는다(거짓 주소보다 낫다). */
    /** [P63] 공유·배포 링크로 들어온 진입인가 — 허브를 그리면 안 되는 상황의 단일 판정원.
     *  🔴 라이브에서 실측: 초대코드 모달 뒤로 **다른 프로젝트 이름들이 그대로 비쳤다.**
     *  그러면 "다른 프로젝트를 유추할 수 없도록"(마스터 2026-09-18) 요구가 깨진다.
     *  ⚠️ 이 헬퍼를 open() 과 load() **사이**에 두지 마라 — p24 가 그 두 함수의 인접성을 기준으로
     *     open() 본문을 잘라낸다(실제로 한 번 깨뜨렸다). URL 파생이라 _deployUrl 옆이 제자리다. */
    _isShareEntry() {
      try {
        if (typeof ShareLink !== "undefined" && ShareLink.token()) return true;
        return !!new URLSearchParams(location.search).get("d");
      } catch (e) { return false; }
    },

    _deployUrl(p) {
      if (!p) return "";
      const loc = (typeof location !== "undefined") ? location : { hostname: "", protocol: "https:", origin: "" };
      const host = loc.hostname || "";
      const parts = host.split(".");
      const base = parts.length >= 2 ? parts.slice(-2).join(".") : host;
      const origin0 = loc.origin || (loc.protocol + "//" + host);
      // [P61] 🔴 1순위 = 공유 주소 `/srview/<프로젝트명>-<토큰>`.
      //   경로 문자열은 **서버가** projects.name 에서 파생해 내려준다(share_path) — 클라가 슬러그 규칙을
      //   다시 구현하면 SoT 가 둘로 갈라진다. 여기서는 접속 origin 만 붙인다(도메인 하드코딩 0).
      if (p.share_path) {
        // 화면/복사는 **사람이 읽는 형태**로. 서버는 퍼센트인코딩된 정본을 주지만, 마스터 요구는
        // "고객이 봐도 알 수 있게" 다 → 한글을 디코드해 보여준다(브라우저·메신저가 붙여넣기 시 재인코딩).
        // 슬러그 문자집합에 공백·`/`·`?` 가 없으므로 디코드해도 링크가 끊기지 않는다.
        let sp = p.share_path;
        try { sp = decodeURIComponent(sp); } catch (e) {}
        return origin0 + sp;
      }
      if (p.subdomain) return loc.protocol + "//" + p.subdomain + "." + base;
      const depId = this._deployLinkCache[p.id];
      if (depId) {
        const origin = loc.origin || (loc.protocol + "//" + host);
        return origin + "/?d=" + encodeURIComponent(depId);
      }
      return "";
    },
    /* ══ [P63] 뷰어 초대코드 관리 — 유출 대응 3종(폐기·만료·기록)의 UI 측 ══
     * 마스터 "그런데 그 링크가 유출된다면?" → 링크만 샐다면 코드에서 막히고,
     * 코드까지 샐다면 **즉시 폐기**한다. 그래서 폐기 버튼은 목록 모든 행에 있다. */
    async loadShareCodes() {
      const box = document.getElementById("pm-code-list");
      if (!box || !this._memProject) return;
      box.innerHTML = "";
      try {
        const r = await fetch("/api/projects/" + encodeURIComponent(this._memProject.id) + "/share-codes", { headers: Auth.headers() });
        if (!r.ok) { box.innerHTML = '<div class="pm-sub-hint">코드 목록을 불러오지 못했습니다.</div>'; return; }
        const { data } = await r.json();
        this._renderShareCodes(data || []);
      } catch (e) {
        box.innerHTML = '<div class="pm-sub-hint">코드 목록을 불러오지 못했습니다(오프라인).</div>';
      }
    },
    _renderShareCodes(list) {
      const box = document.getElementById("pm-code-list");
      if (!box) return;
      if (!list.length) {
        // 🔴 코드가 하나도 없으면 게이트가 꺼져 있다 — 그 사실을 숨기지 않는다.
        box.innerHTML = '<div class="pm-sub-hint">⚠ 발급된 코드가 없습니다 — 지금은 <b>링크를 가진 누구나</b> 열람합니다. 코드를 1개 발급하면 즉시 잠꺑니다.</div>';
        return;
      }
      box.innerHTML = "";
      list.forEach((c) => {
        const row = document.createElement("div");
        row.className = "member-row";
        const state = c.revoked ? "🚫 폐기됨" : (c.active ? "● 사용가능" : "⏱ 만료됨");
        const exp = c.expires_at ? this._fmtDate(c.expires_at) + " 만료" : "무기한";
        const used = (c.use_count || 0) + "회" + (c.last_used_at ? (" · 최근 " + this._fmtDate(c.last_used_at)) : "");
        row.innerHTML =
          '<div class="member-info"><span class="member-email">' + UI.escapeHtml(c.label) + '</span>' +
          '<span class="member-role">' + state + ' · ' + UI.escapeHtml(String(c.code_hint || "")) + '… · ' + exp + ' · ' + used + '</span></div>';
        if (!c.revoked) {
          const btn = document.createElement("button");
          btn.className = "member-del"; btn.type = "button"; btn.title = "코드 폐기(즉시 차단)";
          btn.textContent = "폐기";
          btn.addEventListener("click", () => this.revokeShareCode(c.id, c.label));
          row.appendChild(btn);
        }
        box.appendChild(row);
      });
    },
    async createShareCode() {
      const errEl = document.getElementById("pm-code-error");
      const show = (m) => { if (errEl) { errEl.textContent = m; errEl.classList.remove("hidden"); } };
      if (errEl) errEl.classList.add("hidden");
      if (!this._memProject) return;
      const label = (document.getElementById("pm-code-label") || {}).value || "";
      const ttl = (document.getElementById("pm-code-ttl") || {}).value || "";
      if (!label.trim()) { show("발급 단위 이름을 적으세요 — 유출 시 이 단위로 폐기합니다."); return; }
      try {
        const r = await fetch("/api/projects/" + encodeURIComponent(this._memProject.id) + "/share-codes", {
          method: "POST", headers: Auth.headers(),
          body: JSON.stringify({ label: label.trim(), ttl_days: ttl ? Number(ttl) : undefined })
        });
        const j = await r.json().catch(() => null);
        if (!r.ok || !j || !j.code) { show((j && j.error) || "코드 발급에 실패했습니다."); return; }
        const box = document.getElementById("pm-code-new-box");
        const out = document.getElementById("pm-code-new");
        if (out) out.value = j.code;            // 🔴 원문은 이 순간에만 존재한다(DB 는 해시만 보관)
        if (box) box.classList.remove("hidden");
        const lbl = document.getElementById("pm-code-label"); if (lbl) lbl.value = "";
        Prompt && Prompt.toast && Prompt.toast("초대코드를 발급했습니다 — 지금 복사해 전달하세요.", 3200);
        await this.loadShareCodes();
      } catch (e) { show("네트워크 오류입니다."); }
    },
    async revokeShareCode(id, label) {
      const ok = await Prompt.confirm("코드 폐기", "'" + label + "' 코드를 폐기할까요?\n\n이 코드로 들어오던 사람은 즉시 막힘니다(이미 통과한 세션도 만료 시 재입력 필요).");
      if (!ok) return;
      try {
        const r = await fetch("/api/share-codes/" + encodeURIComponent(id) + "/revoke", { method: "POST", headers: Auth.headers(), body: "{}" });
        if (!r.ok) { Prompt && Prompt.toast && Prompt.toast("폐기에 실패했습니다."); return; }
        Prompt && Prompt.toast && Prompt.toast("코드를 폐기했습니다.");
        await this.loadShareCodes();
      } catch (e) { Prompt && Prompt.toast && Prompt.toast("네트워크 오류입니다."); }
    },

    /** 배포 주소 복사 — _copyInviteLink 와 동일한 클립보드 우선순위(SoT), 복사 후 알림 필수(조용한 실패 금지). */
    _copyDeployUrl(url) {
      if (!url) return;
      const done = () => { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("주소를 복사했습니다."); };
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(url).then(done).catch(() => this._copyDeployUrlFallback(url, done)); return; }
      } catch (e) {}
      this._copyDeployUrlFallback(url, done);
    },
    _copyDeployUrlFallback(url, done) {
      try {
        const ta = document.createElement("textarea");
        ta.value = url; ta.setAttribute("readonly", "");
        ta.style.position = "fixed"; ta.style.top = "-9999px"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.focus(); ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        done();
      } catch (e) {}
    },
    /** 배포 주소 공유 — _shareInviteLink 와 동일한 패턴(navigator.share + 복사 폴백).
     *  AbortError(사용자가 공유시트를 취소) 는 정상 동작 — 오류 알림 금지. */
    _shareDeployUrl(url, projectName) {
      if (!url) return;
      if (!navigator.share) { this._copyDeployUrl(url); return; }
      const name = projectName || "프로젝트"; // SoT: 실제 프로젝트 값에서만 가져온다(하드코딩 금지)
      navigator.share({ title: "SEASTAR 360 뷰어 주소", text: '"' + name + '" 프로젝트 뷰어 주소', url: url })
        .catch((e) => {
          if (e && e.name === "AbortError") return; // 사용자가 공유시트를 취소 — 정상 동작, 오류 알림 금지
          if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("공유 실패: " + (e && e.message ? e.message : "알 수 없는 오류"));
        });
    },

    _fmtDate(v) {
      if (v == null) return "";
      const n = (typeof v === "number") ? v : Date.parse(v);
      if (!Number.isFinite(n)) return "";
      const d = new Date(n);
      const p = (x) => String(x).padStart(2, "0");
      return d.getFullYear() + "." + p(d.getMonth() + 1) + "." + p(d.getDate());
    },

    /** 프로젝트 식별 코드(SS-####) 생성용 간이 해시 */
    _hash(str) {
      str = String(str || "");
      let h = 0;
      for (let i = 0; i < str.length; i++) { h = ((h << 5) - h + str.charCodeAt(i)) | 0; }
      return h;
    }
  };

  /* ══════════════════════════════════════════
     NOTES ── 이슈/필드노트 협업 (핀 단위 코멘트 스레드)
       · 파노라마 우측 패널에서 핀별 이슈를 작성/상태관리
       · 상태: open(미해결) / progress(진행) / done(완료)
       · 도면 핀 + 핀 리스트에 미해결 카운트 뱃지 표시
  ══════════════════════════════════════════ */
  const Notes = {
    _pin: null,          // 현재 패널의 핀 객체
    _list: [],           // 현재 핀의 노트 배열
    _filter: "all",
    _busy: false,
    _gen: 0,             // [오프라인 노트 영속화] 로드 세대 카운터 — 늦게 끝난 비동기 결과가 최신 상태를 덮어쓰지 못하게 막는 가드
    STATUS: { open: "미해결", progress: "진행중", done: "완료" },

    /** [오프라인 노트] 클라 임시 id — 서버 반영 후 noteIdMap 으로 실제 id 로 치환됨(applyIdMap) */
    _tmpId() { return "tmp-note-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8); },

    /** [오프라인 노트 영속화] 핀별 노트 스냅샷 키 — 32_Offline.js 의 bundle:dep:* 와 같은
     *  SyncQueue.DRAFT_STORE(IndexedDB) 에 얹는다(새 저장소 신설 안 함, §5 사다리). */
    _snapKey(dep, pinId) { return "notes:" + dep + ":" + pinId; },

    /** [오프라인 노트 영속화] 현재 핀의 _list 스냅샷을 로컬에 즉시 저장.
     *  [④ 덮어쓰기 가드] 기존 스냅샷보다 ts 가 더 오래된 저장 시도는 무시 —
     *  느리게 끝난 오프라인 저장이 방금 끝난 서버 동기화 결과를 덮어쓰는 사고 방지. */
    async _saveSnapshot(list, ts, pinOverride) {
      if (typeof SyncQueue === "undefined" || !SyncQueue.saveDraft) return false;
      const dep = (typeof State !== "undefined") && State.currentDeploymentId;
      const pin = pinOverride || this._pin;
      if (!dep || !pin) return false;
      const key = this._snapKey(dep, pin.id);
      ts = ts || Date.now();
      try {
        const existing = SyncQueue.loadDraft ? await SyncQueue.loadDraft(key) : null;
        if (existing && typeof existing.ts === "number" && ts < existing.ts) return false; // 스냅샷 덮어쓰기 가드
        const saved = await SyncQueue.saveDraft(key, { list: list, ts: ts });
        if (saved === false) {
          // [무신호 손실 차단] 05_SyncQueue.js:132 와 동일한 안내 문구/경로 재사용 — 새 알림 신설 안 함.
          try { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("오프라인 저장 실패 — 기기 저장공간 부족"); } catch (e) {}
          return false;
        }
        return true;
      } catch (e) { return false; }
    },

    /** [오프라인 노트 영속화] 로컬 스냅샷에서 복원. myGen 이 넘어오면, 그 사이 새 loadForPin() 이
     *  시작돼 세대가 바뀐 경우 이 결과는 폐기한다(늦게 끝난 복원이 최신 상태를 덮어쓰지 않도록). */
    async _restoreFromSnapshot(dep, pinId, myGen) {
      if (typeof SyncQueue === "undefined" || !SyncQueue.loadDraft) return;
      try {
        const rec = await SyncQueue.loadDraft(this._snapKey(dep, pinId));
        if (myGen != null && myGen !== this._gen) return; // 세대 불일치 — 폐기
        if (rec && Array.isArray(rec.list)) this._list = rec.list;
      } catch (e) {}
    },

    /** [오프라인 노트] 온라인 복귀 시 App._flushOpLogs()가 서버 응답의 noteIdMap 을 받아 호출.
     *  this._list 안의 임시 id를 실제 id 로 갈아끼워 화면 참조(상태변경/삭제 버튼의 data-id 등)를 유지한다. */
    applyIdMap(map) {
      if (!map) return;
      let changed = false;
      (this._list || []).forEach((n) => {
        if (n && map[n.id]) { n.id = map[n.id]; changed = true; }
      });
      if (changed) {
        this.render();
        try { this._saveSnapshot(this._list, Date.now()); } catch (e) {} // 서버 확정 id 로 스냅샷도 갱신(§ 스냅샷은 서버가 SoT)
      }
    },

    init() {
      const $ = (id) => document.getElementById(id);
      $("btn-pano-notes") && $("btn-pano-notes").addEventListener("click", () => this.toggle());
      $("pnp-close") && $("pnp-close").addEventListener("click", () => this.closePanel());
      // 필터
      document.querySelectorAll("#pnp-filter .pnp-fbtn").forEach((b) => {
        b.addEventListener("click", () => {
          this._filter = b.dataset.f;
          document.querySelectorAll("#pnp-filter .pnp-fbtn").forEach((x) => x.classList.toggle("active", x === b));
          this.render();
        });
      });
      // 작성 폼
      const form = $("pnp-form");
      form && form.addEventListener("submit", (e) => { e.preventDefault(); this.submit(); });
    },

    /** 현재 배포의 핀별 노트 요약 로드 → 도면/리스트 뱃지 */
    async loadSummary() {
      const dep = State.currentDeploymentId;
      if (!dep) { State.noteSummary = {}; return; }
      try {
        const r = await fetch("/api/notes/summary?deployment_id=" + encodeURIComponent(dep), { headers: Auth.headers() });
        if (!r.ok) return;
        const j = await r.json();
        State.noteSummary = j.data || {};
      } catch (e) { State.noteSummary = {}; }
      // 뱃지 갱신
      if (typeof UI !== "undefined") { UI.renderPinList(); UI.renderPinsOnMap(); }
      this._syncHeaderCount();
    },

    /** 특정 핀의 미해결 카운트 (뱃지용) */
    openCountFor(pinId) {
      const s = State.noteSummary && State.noteSummary[pinId];
      if (!s) return 0;
      return (s.open || 0) + (s.progress || 0);
    },
    totalCountFor(pinId) {
      const s = State.noteSummary && State.noteSummary[pinId];
      return s ? (s.total || 0) : 0;
    },

    /** 파노라마 헤더 이슈 버튼의 현재 핀 카운트 */
    _syncHeaderCount() {
      const el = document.getElementById("pano-notes-count");
      if (!el) return;
      const pin = this._pin;
      const n = pin ? this.totalCountFor(pin.id) : 0;
      if (n > 0) { el.textContent = n; el.classList.remove("hidden"); }
      else el.classList.add("hidden");
    },

    /** 파노라마 열릴 때 현재 핀 지정 */
    setPin(pin) {
      this._pin = pin || null;
      const lbl = document.getElementById("pnp-pin-label");
      if (lbl) lbl.textContent = pin ? (pin.label || "이름 없는 위치") : "—";
      this._syncHeaderCount();
      // 패널이 열려 있으면 즉시 다시 로드
      var _np = document.getElementById("pano-notes-panel");
      if (_np && !_np.classList.contains("hidden")) this.loadForPin();
    },

    toggle() {
      const p = document.getElementById("pano-notes-panel");
      if (!p) return;
      if (p.classList.contains("hidden")) this.openPanel();
      else this.closePanel();
    },
    openPanel() {
      const p = document.getElementById("pano-notes-panel");
      if (!p || !this._pin) return;
      p.classList.remove("hidden");
      requestAnimationFrame(() => p.classList.add("on"));
      // 미로그인 작성자 입력 표시
      const ar = document.getElementById("pnp-author-row");
      if (ar) ar.classList.toggle("hidden", !!(Auth && Auth.user));
      this.loadForPin();
    },
    closePanel() {
      const p = document.getElementById("pano-notes-panel");
      if (!p) return;
      p.classList.remove("on");
      setTimeout(() => p.classList.add("hidden"), 200);
    },

    async loadForPin() {
      const dep = State.currentDeploymentId;
      const pin = this._pin;
      const listEl = document.getElementById("pnp-list");
      if (!dep || !pin) { if (listEl) listEl.innerHTML = ""; return; }
      const myGen = ++this._gen;
      // [오프라인 노트 영속화] 오프라인이면 서버 호출을 시도하지 않고 로컬 스냅샷으로 즉시 복원.
      //   (기존 코드는 오프라인에도 fetch 를 시도해 실패 후 this._list = [] 로 비워버려
      //    새로고침/재진입 시 방금 작성한 오프라인 노트가 화면에서 사라졌다.)
      if (!navigator.onLine) {
        await this._restoreFromSnapshot(dep, pin.id, myGen);
        if (myGen === this._gen) this.render();
        return;
      }
      if (listEl) listEl.innerHTML = '<div class="pnp-loading">불러오는 중…</div>';
      try {
        const r = await fetch("/api/notes?deployment_id=" + encodeURIComponent(dep) + "&pin_id=" + encodeURIComponent(pin.id), { headers: Auth.headers() });
        const j = await r.json();
        if (myGen !== this._gen) return; // 그 사이 새 로드가 시작됨 — 이 결과는 폐기
        this._list = j.data || [];
        await this._saveSnapshot(this._list, Date.now()); // 서버가 SoT — 로컬 스냅샷을 최신으로 갱신
      } catch (e) {
        if (myGen !== this._gen) return;
        await this._restoreFromSnapshot(dep, pin.id, myGen); // 순간 네트워크 실패 → 로컬 스냅샷 폴백
      }
      this.render();
    },

    render() {
      const listEl = document.getElementById("pnp-list");
      const emptyEl = document.getElementById("pnp-empty");
      if (!listEl) return;
      // [마스터] 필터 탭에 상태별 카운트 표시 (전체/미해결/진행중/완료 N)
      const counts = { all: this._list.length, open: 0, progress: 0, done: 0 };
      this._list.forEach((n) => { const s = n.status || "open"; if (counts[s] != null) counts[s]++; });
      document.querySelectorAll("#pnp-filter .pnp-fbtn").forEach((b) => {
        const base = { all: "전체", open: "미해결", progress: "진행중", done: "완료" }[b.dataset.f] || b.dataset.f;
        const c = counts[b.dataset.f] || 0;
        b.textContent = c > 0 ? base + " " + c : base;
      });
      // [마스터] 최신순 정렬(최근 이슈가 위로)
      const ts = (v) => (typeof v === "number") ? v : (Date.parse(v) || 0);
      let items = this._list.slice().sort((a, b) => ts(b.created_at) - ts(a.created_at));
      if (this._filter !== "all") items = items.filter((n) => n.status === this._filter);
      if (items.length === 0) {
        listEl.innerHTML = "";
        emptyEl && emptyEl.classList.remove("hidden");
        this._syncHeaderCount();
        return;
      }
      emptyEl && emptyEl.classList.add("hidden");
      const canEdit = (n) => {
        if (!Auth) return false;
        if (Auth.isDesigner) return true;
        return n.author_email && Auth.user && n.author_email === Auth.user.email;
      };
      listEl.innerHTML = items.map((n) => {
        const st = n.status || "open";
        const stLabel = this.STATUS[st] || st;
        const assignee = n.assignee ? `<span class="pnp-assignee-tag">${UI.escapeHtml(n.assignee)}</span>` : "";
        const editable = canEdit(n);
        const stBtns = editable ? `
          <div class="pnp-status-actions">
            ${["open","progress","done"].map((s) =>
              `<button class="pnp-st-btn ${s} ${s===st?'active':''}" data-act="status" data-id="${n.id}" data-status="${s}">${this.STATUS[s]}</button>`
            ).join("")}
            <button class="pnp-del" data-act="del" data-id="${n.id}" title="삭제">✕</button>
          </div>` : "";
        return `
          <article class="pnp-item st-${st}" data-id="${n.id}">
            <div class="pnp-item-head">
              <span class="pnp-badge st-${st}">${stLabel}</span>
              <span class="pnp-author">${UI.escapeHtml(n.author || "익명")}</span>
              ${assignee}
              <span class="pnp-time">${this._timeAgo(n.created_at)}</span>
            </div>
            <div class="pnp-body">${UI.escapeHtml(n.body)}</div>
            ${stBtns}
          </article>`;
      }).join("");
      // 이벤트 위임
      listEl.querySelectorAll('[data-act="status"]').forEach((b) => {
        b.addEventListener("click", () => this.updateStatus(b.dataset.id, b.dataset.status));
      });
      listEl.querySelectorAll('[data-act="del"]').forEach((b) => {
        b.addEventListener("click", () => this.remove(b.dataset.id));
      });
      this._syncHeaderCount();
    },

    async submit() {
      if (this._busy) return;
      const dep = State.currentDeploymentId;
      const pin = this._pin;
      if (!dep || !pin) return;
      const input = document.getElementById("pnp-input");
      const body = (input.value || "").trim();
      if (!body) { input.focus(); return; }
      const status = (document.getElementById("pnp-status-sel") || {}).value || "open";
      const assignee = (document.getElementById("pnp-assignee") || {}).value || "";
      const author = (document.getElementById("pnp-author") || {}).value || "";
      this._busy = true;
      const submitBtn = document.getElementById("pnp-submit");
      if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "등록 중…"; }
      // [오프라인 노트] pin/zone/anno 와 같은 OpLog 경로에 편입 — 새 큐 만들지 않음(§편입)
      if (!navigator.onLine && typeof OpLog !== "undefined" && OpLog.recordCurrent) {
        const now = Date.now();
        const noteObj = {
          id: this._tmpId(), deployment_id: dep, pin_id: pin.id, pin_label: pin.label || "",
          body, status, assignee, author: author || (Auth && Auth.user && Auth.user.name) || "익명",
          author_email: (Auth && Auth.user && Auth.user.email) || null,
          author_role: (Auth && Auth.isDesigner) ? "designer" : "guest",
          created_at: now, updated_at: now, resolved_at: status === "done" ? now : null,
        };
        this._list.push(noteObj);
        try {
          await OpLog.recordCurrent("note", "upsert", noteObj.id, noteObj);
          await this._saveSnapshot(this._list, now); // [오프라인 노트 영속화] 즉시 로컬 스냅샷(재시작 유실 방지)
          input.value = "";
          if (document.getElementById("pnp-assignee")) document.getElementById("pnp-assignee").value = "";
          this.render();
        } catch (e) {}
        this._busy = false;
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "등록"; }
        return;
      }
      try {
        const r = await fetch("/api/notes", {
          method: "POST",
          headers: Auth.headers(),
          body: JSON.stringify({
            deployment_id: dep, pin_id: pin.id, pin_label: pin.label || "",
            body, status, assignee, author,
          }),
        });
        if (r.ok) {
          input.value = "";
          if (document.getElementById("pnp-assignee")) document.getElementById("pnp-assignee").value = "";
          await this.loadForPin();
          await this.loadSummary();
        }
      } catch (e) {}
      this._busy = false;
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "등록"; }
    },

    async updateStatus(id, status) {
      if (!navigator.onLine && typeof OpLog !== "undefined" && OpLog.recordCurrent) {
        const n = (this._list || []).find((x) => x.id === id);
        if (!n) return;
        n.status = status;
        n.updated_at = Date.now();
        n.resolved_at = status === "done" ? n.updated_at : null;
        try { await OpLog.recordCurrent("note", "upsert", id, n); await this._saveSnapshot(this._list, n.updated_at); } catch (e) {}
        this.render();
        return;
      }
      try {
        const r = await fetch("/api/notes/" + encodeURIComponent(id), {
          method: "PATCH", headers: Auth.headers(),
          body: JSON.stringify({ status }),
        });
        if (r.ok) { await this.loadForPin(); await this.loadSummary(); }
      } catch (e) {}
    },

    async remove(id) {
      if (!await Prompt.confirm("노트 삭제", "이 이슈/노트를 삭제할까요?")) return;
      if (!navigator.onLine && typeof OpLog !== "undefined" && OpLog.recordCurrent) {
        this._list = (this._list || []).filter((x) => x.id !== id);
        try { await OpLog.recordCurrent("note", "delete", id); await this._saveSnapshot(this._list, Date.now()); } catch (e) {}
        this.render();
        return;
      }
      try {
        const r = await fetch("/api/notes/" + encodeURIComponent(id), {
          method: "DELETE", headers: Auth.headers(),
        });
        if (r.ok) { await this.loadForPin(); await this.loadSummary(); }
      } catch (e) {}
    },

    /** [핀 액션 패널 재사용] 컴팩트 노트 목록 — loadForPin() 이 채운 this._list 를
     *  그대로 그린다(별도 fetch 없음 · 같은 데이터 소스, §10 SoT). 상태 텍스트/정렬 기준도
     *  render()와 동일(this.STATUS, created_at 최신순). */
    renderCompact(containerId) {
      const el = document.getElementById(containerId);
      if (!el) return;
      const ts = (v) => (typeof v === "number") ? v : (Date.parse(v) || 0);
      const items = (this._list || []).slice().sort((a, b) => ts(b.created_at) - ts(a.created_at));
      if (!items.length) { el.innerHTML = '<div style="color:#94a3b8;">등록된 노트 없음</div>'; return; }
      el.innerHTML = items.map((n) => {
        const st = n.status || "open";
        const stLabel = this.STATUS[st] || st;
        return '<div style="padding:5px 0;border-bottom:1px solid rgba(0,0,0,.06);">' +
          '<span style="font-weight:700;color:#334155;">[' + UI.escapeHtml(stLabel) + ']</span> ' +
          '<span style="color:#0f172a;">' + UI.escapeHtml(n.body) + '</span></div>';
      }).join("");
    },

    /** [핀 액션 패널 재사용] 노트 1건 등록 — submit()과 같은 /api/notes 엔드포인트.
     *  성공 시 this._list 를 다시 로드(요약 뱃지도 함께 갱신)하고 true 를 돌려준다. */
    async submitCompact(pin, body) {
      const dep = (typeof State !== "undefined") && State.currentDeploymentId;
      const text = (body || "").trim();
      if (!dep || !pin || !text) return false;
      if (!navigator.onLine && typeof OpLog !== "undefined" && OpLog.recordCurrent) {
        const now = Date.now();
        const noteObj = {
          id: this._tmpId(), deployment_id: dep, pin_id: pin.id, pin_label: pin.label || "",
          body: text, status: "open", assignee: "",
          author: (typeof Auth !== "undefined" && Auth.user && Auth.user.name) || "익명",
          author_email: (typeof Auth !== "undefined" && Auth.user && Auth.user.email) || null,
          author_role: (typeof Auth !== "undefined" && Auth.isDesigner) ? "designer" : "guest",
          created_at: now, updated_at: now, resolved_at: null,
        };
        this._list.push(noteObj);
        try {
          await OpLog.recordCurrent("note", "upsert", noteObj.id, noteObj);
          await this._saveSnapshot(this._list, now, pin); // [오프라인 노트 영속화] pin 파라미터 기준(this._pin 과 다를 수 있음)
          return true;
        } catch (e) { return false; }
      }
      try {
        const r = await fetch("/api/notes", {
          method: "POST",
          headers: Auth.headers(),
          body: JSON.stringify({
            deployment_id: dep, pin_id: pin.id, pin_label: pin.label || "",
            body: text, status: "open", assignee: "",
            author: (typeof Auth !== "undefined" && Auth.user && Auth.user.name) || "",
          }),
        });
        if (!r.ok) return false;
        await this.loadForPin();
        await this.loadSummary();
        return true;
      } catch (e) { return false; }
    },

    _timeAgo(v) {
      const n = (typeof v === "number") ? v : Date.parse(v);
      if (!Number.isFinite(n)) return "";
      const diff = Date.now() - n;
      const m = Math.floor(diff / 60000);
      if (m < 1) return "방금";
      if (m < 60) return m + "분 전";
      const h = Math.floor(m / 60);
      if (h < 24) return h + "시간 전";
      const d = new Date(n);
      const p = (x) => String(x).padStart(2, "0");
      return (d.getMonth() + 1) + "." + p(d.getDate());
    },
  };

  /* ══════════════════════════════════════════
     TIMELAPSE ── 같은 위치의 시점별(전/후) 파노라마 비교
        · 핀.timeline[] = [{id,label,imageId|imageUrl,isVideo,capturedAt}]
        · timeline 없으면 현재 단일 파노라마를 1개 시점으로 취급
        · 시점 전환 시 카메라 각도(lon/lat/fov) 유지 → 정확한 전/후 비교
        · 분할비교: 좌=선택 시점, 우=최신, 슬라이더로 경계 이동
  ══════════════════════════════════════════ */
  const TimeLapse = {
    _pin: null,
    _shots: [],       // 정규화된 시점 배열 (오래된 → 최신)
    _idx: 0,          // 현재 표시 중인 시점 index
    _busy: false,

    init() {
      const $ = (id) => document.getElementById(id);
      $("btn-tl-prev") && $("btn-tl-prev").addEventListener("click", () => this.step(-1));
      $("btn-tl-next") && $("btn-tl-next").addEventListener("click", () => this.step(1));
      $("btn-tl-compare") && $("btn-tl-compare").addEventListener("click", () => Compare.open());
    },

    /** 핀의 timeline을 정규화 (단일 파노라마 fallback 포함) */
    _normalize(pin) {
      const out = [];
      if (Array.isArray(pin.timeline) && pin.timeline.length) {
        pin.timeline.forEach((t, i) => {
          if (!t) return;
          out.push({
            id: t.id || ("tl" + i),
            label: t.label || ("시점 " + (i + 1)),
            imageId: t.imageId || null,
            imageUrl: t.imageUrl || null,
            isVideo: !!t.isVideo,
            capturedAt: t.capturedAt || null,
          });
        });
      }
      // 현재 핀의 기본 파노라마를 "최신" 시점으로 합류(이미 timeline에 동일 소스가 없을 때만)
      const baseSrc = pin.imageId || pin.imageUrl || pin.videoUrl;
      if (baseSrc) {
        const dup = out.some((s) => (s.imageId && s.imageId === pin.imageId) || (s.imageUrl && s.imageUrl === pin.imageUrl));
        if (!dup) {
          out.push({
            id: "current",
            label: out.length ? "현재" : (pin.label || "현재"),
            imageId: pin.imageId || null,
            imageUrl: pin.imageUrl || null,
            isVideo: !!(pin.videoUrl || pin.isVideo),
            videoUrl: pin.videoUrl || null,
            capturedAt: pin.capturedAt || null,
          });
        }
      }
      // 정렬: capturedAt 있는 것 우선 시간순, 없으면 입력 순서 유지(최신은 끝)
      return out;
    },

    /** 파노라마 열릴 때 호출 — 시점 바 구성 */
    setPin(pin) {
      this._pin = pin || null;
      this._shots = pin ? this._normalize(pin) : [];
      this._idx = Math.max(0, this._shots.length - 1); // 기본 = 최신
      this._renderBar();
    },

    _renderBar() {
      const bar = document.getElementById("pano-timeline");
      if (!bar) return;
      // 시점 2개 이상일 때만 표시
      if (this._shots.length < 2) { bar.classList.add("hidden"); return; }
      bar.classList.remove("hidden");
      const cur = document.getElementById("tl-current");
      if (cur) cur.textContent = (this._idx + 1) + " / " + this._shots.length;
      this.render();
    },

    render() {
      const wrap = document.getElementById("tl-chips");
      if (!wrap) return;
      wrap.innerHTML = this._shots.map((s, i) => {
        const active = i === this._idx ? " active" : "";
        const latest = i === this._shots.length - 1 ? '<span class="tl-chip-tag">최신</span>' : "";
        const sub = s.capturedAt ? `<span class="tl-chip-date">${this._fmtDate(s.capturedAt)}</span>` : "";
        return `<button class="tl-chip${active}" data-i="${i}" title="${UI.escapeHtml(s.label)}">
          <span class="tl-chip-label">${UI.escapeHtml(s.label)}</span>${sub}${latest}
        </button>`;
      }).join("");
      wrap.querySelectorAll(".tl-chip").forEach((b) => {
        b.addEventListener("click", () => this.goto(parseInt(b.dataset.i, 10)));
      });
    },

    step(delta) {
      const n = this._shots.length;
      if (n < 2) return;
      let i = this._idx + delta;
      if (i < 0) i = 0; if (i > n - 1) i = n - 1;
      if (i !== this._idx) this.goto(i);
    },

    /** 시점 전환 — 카메라 각도 유지하며 소스 교체 */
    async goto(i) {
      if (this._busy) return;
      const n = this._shots.length;
      if (i < 0 || i >= n || i === this._idx) return;
      const shot = this._shots[i];
      this._idx = i;
      this._busy = true;
      // 현재 카메라 각도 보존
      const cam = { lon: PanoViewer.S.lon, lat: PanoViewer.S.lat, fov: PanoViewer.S.fov };
      try {
        const src = await this._resolveSrc(shot);
        if (src == null) { this._busy = false; return; }
        await this._loadKeepingCamera(src, shot, cam);
      } catch (e) {
        if (typeof console !== "undefined") console.warn("timelapse goto fail", e);
      }
      this._busy = false;
      this._renderBar();
    },

    /** 시점 소스 해석 (클라우드 이미지 → dataURL, URL → 그대로) */
    async _resolveSrc(shot) {
      if (shot.videoUrl) return { src: shot.videoUrl, isVideo: true };
      if (shot.imageId) {
        const dataURL = await Cloud.fetchImage(shot.imageId);
        return { src: dataURL, isVideo: false };
      }
      if (shot.imageUrl) return { src: shot.imageUrl, isVideo: !!shot.isVideo };
      return null;
    },

    _loadKeepingCamera(resolved, shot, cam) {
      return new Promise((resolve) => {
        const name = (this._pin ? (this._pin.label || "") : "") + " · " + shot.label;
        if (resolved.isVideo) {
          PanoViewer.loadVideo(resolved.src, name);
          // 비디오는 즉시 각도 복원 시도
          setTimeout(() => { Object.assign(PanoViewer.S, cam); PanoViewer._invalidate && PanoViewer._invalidate(); resolve(); }, 50);
          return;
        }
        PanoViewer.load(resolved.src, name);
        // load는 img.onload 후 S를 리셋하므로, 다음 틱에 각도 복원
        setTimeout(() => {
          Object.assign(PanoViewer.S, cam);
          PanoViewer._invalidate && PanoViewer._invalidate();
          resolve();
        }, 60);
      });
    },

    currentShot() { return this._shots[this._idx] || null; },
    latestShot()  { return this._shots[this._shots.length - 1] || null; },
    hasMultiple() { return this._shots.length >= 2; },

    hide() {
      const bar = document.getElementById("pano-timeline");
      if (bar) bar.classList.add("hidden");
    },

    _fmtDate(v) {
      const n = (typeof v === "number") ? v : Date.parse(v);
      if (!Number.isFinite(n)) return String(v);
      const d = new Date(n);
      const p = (x) => String(x).padStart(2, "0");
      return (d.getFullYear() + "").slice(2) + "." + p(d.getMonth() + 1) + "." + p(d.getDate());
    },
  };

  /* ══════════════════════════════════════════
     COMPARE ── 전/후 분할 비교(좌=선택시점, 우=최신) + 슬라이더
        · 2개 정적 이미지를 canvas로 그려 클립 경계 이동
        · 같은 위치를 한 화면에서 직접 대조 (OpenSpace/Matterport 비교 모방)
  ══════════════════════════════════════════ */
  const Compare = {
    _a: null, _b: null, _ratio: 0.5, _dragging: false, _busy: false,

    async open() {
      if (this._busy) return;
      if (!TimeLapse.hasMultiple()) { return; }
      const a = TimeLapse.currentShot();      // 선택 시점(과거)
      const b = TimeLapse.latestShot();       // 최신
      if (!a || !b) return;
      this._busy = true;
      try {
        const ra = await TimeLapse._resolveSrc(a);
        const rb = await TimeLapse._resolveSrc(b);
        if (!ra || !rb || ra.isVideo || rb.isVideo) { this._busy = false; this._toast("정적 이미지 시점만 분할 비교할 수 있습니다."); return; }
        const [ia, ib] = await Promise.all([this._loadImg(ra.src), this._loadImg(rb.src)]);
        this._a = ia; this._b = ib;
        const ov = document.getElementById("pano-compare");
        ov.classList.remove("hidden");
        document.getElementById("cmp-label-a").textContent = a.label;
        document.getElementById("cmp-label-b").textContent = b.label;
        this._ratio = 0.5;
        this._bind();
        this._resizeAndDraw();
      } catch (e) {
        this._toast("이미지를 불러올 수 없습니다.");
      }
      this._busy = false;
    },

    _loadImg(src) {
      return new Promise((res, rej) => {
        const im = new Image(); im.crossOrigin = "anonymous";
        im.onload = () => res(im); im.onerror = rej;
        im.src = (typeof Auth !== "undefined" && Auth.r2) ? Auth.r2(src) : src;
      });
    },

    _bind() {
      if (this._bound) return; this._bound = true;
      const div = document.getElementById("cmp-divider");
      const ov = document.getElementById("pano-compare");
      const closeBtn = document.getElementById("btn-cmp-close");
      const onMove = (clientX) => {
        const r = ov.getBoundingClientRect();
        let ratio = (clientX - r.left) / r.width;
        ratio = Math.max(0.02, Math.min(0.98, ratio));
        this._ratio = ratio; this._applyClip();
      };
      div.addEventListener("pointerdown", (e) => { this._dragging = true; div.setPointerCapture(e.pointerId); });
      window.addEventListener("pointermove", (e) => { if (this._dragging) onMove(e.clientX); });
      window.addEventListener("pointerup", () => { this._dragging = false; });
      ov.addEventListener("click", (e) => { if (e.target === ov) onMove(e.clientX); });
      closeBtn && closeBtn.addEventListener("click", () => this.close());
      window.addEventListener("resize", () => { if (!document.getElementById("pano-compare").classList.contains("hidden")) this._resizeAndDraw(); });
    },

    _resizeAndDraw() {
      const ov = document.getElementById("pano-compare");
      const w = ov.clientWidth, h = ov.clientHeight;
      ["cmp-canvas-a", "cmp-canvas-b"].forEach((id) => {
        const c = document.getElementById(id);
        c.width = w; c.height = h;
      });
      this._drawCover(document.getElementById("cmp-canvas-a"), this._a);
      this._drawCover(document.getElementById("cmp-canvas-b"), this._b);
      this._applyClip();
    },

    /** equirectangular 이미지를 화면에 cover로 중앙 표시(중앙 시야 미리보기) */
    _drawCover(canvas, img) {
      if (!canvas || !img) return;
      const ctx = canvas.getContext("2d");
      const cw = canvas.width, ch = canvas.height;
      ctx.clearRect(0, 0, cw, ch);
      const ir = img.width / img.height, cr = cw / ch;
      let dw, dh, dx, dy;
      if (ir > cr) { dh = ch; dw = ch * ir; dx = (cw - dw) / 2; dy = 0; }
      else { dw = cw; dh = cw / ir; dx = 0; dy = (ch - dh) / 2; }
      ctx.drawImage(img, dx, dy, dw, dh);
    },

    _applyClip() {
      const clip = document.getElementById("cmp-clip");
      const div = document.getElementById("cmp-divider");
      const pct = (this._ratio * 100).toFixed(2) + "%";
      // 우측(B=최신)을 ratio 우측만 보이게: clip-path 사용
      clip.style.clipPath = `inset(0 0 0 ${pct})`;
      div.style.left = pct;
    },

    close() {
      const ov = document.getElementById("pano-compare");
      if (ov) ov.classList.add("hidden");
      this._a = this._b = null;
    },

    _toast(msg) {
      // 간단 안내 (이미 Prompt 모듈이 있으면 사용, 없으면 alert 대체 최소화)
      const ov = document.getElementById("pano-compare");
      if (ov && !ov.classList.contains("hidden")) return;
      try { console.info(msg); } catch (e) {}
    },
  };

  /* ══════════════════════════════════════════
     ZONES ── 도면 영역(구역) 지정 + 하이라이트
        · zone = {id,page,x,y,w,h,label,color,pinIds[],note} (좌표 % → 줌/팬 무관)
        · 설계자: 드래그로 사각형 그리기(줌 상태에서도 viewportToPercent 사용)
        · 뷰어/설계자: 영역 호버/클릭 → 하이라이트, 내부 핀 강조
        · 배포 스냅샷(deployment.zones)에 저장
  ══════════════════════════════════════════ */
  const ZONE_COLORS = ["#f59e0b", "#3b82f6", "#10b981", "#ef4444", "#a855f7", "#06b6d4"];
  const Zones = {
    _drag: null,        // {sx,sy} 시작 % 좌표 (rect/circle 드래그)
    _active: null,      // 현재 하이라이트된 zone id
    _shape: "rect",     // 현재 그리기 도형: rect | circle | poly
    _poly: null,        // 다각형 그리는 중 점 배열 [{x,y}...]

    _newId() { return "zone_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); },

    init() {
      const $ = (id) => document.getElementById(id);
      // 도형 도구 버튼 (사각형/원형/다각형)
      ["rect", "circle", "poly"].forEach(sh => {
        const b = $("btn-zone-" + sh);
        if (b) b.addEventListener("click", () => this.pickShape(sh));
      });
      // [WO 20260918-B] 🔴 도면 영역 추출 — 여러 뷰가 담긴 도면에서 드래그한 부분만 새 영역(구역)으로.
      //   그리기 도구와 같은 자리에서 관리한다(Projects._pickDeckCrop 이 이 모듈의 드래그를 그대로 재사용).
      $("btn-region-extract") && $("btn-region-extract").addEventListener("click", () => {
        if (typeof Projects === "undefined" || !Projects.extractRegionAsDeck) {
          Prompt && Prompt.toast && Prompt.toast("영역 추출을 사용할 수 없습니다");   // 조용한 실패 금지
          return;
        }
        Projects.extractRegionAsDeck();
      });
      // 레거시 단일 버튼 호환
      $("btn-zone") && $("btn-zone").addEventListener("click", () => this.toggleDraw());
      // 다각형: 더블클릭/Enter 로 완료
      const vp = $("map-viewport");
      if (vp) vp.addEventListener("dblclick", (e) => { if (State.drawingZone && this._shape === "poly" && this._poly && this._poly.length >= 3) { e.preventDefault(); this._finishPoly(); } });
      document.addEventListener("keydown", (e) => {
        if (!State.drawingZone) return;
        if (e.key === "Enter" && this._shape === "poly" && this._poly && this._poly.length >= 3) { e.preventDefault(); this._finishPoly(); }
        if (e.key === "Escape") { this._cancelDraw(); }
      });
      // [버그복원] 모바일 다각형 완료 — 더블클릭/Enter 가 없어 닫을 수 없던 문제 해결
      const pf = $("btn-poly-finish");
      if (pf) pf.addEventListener("click", () => { if (this._poly && this._poly.length >= 3) this._finishPoly(); });
    },

    isDesigner() { return !!(typeof Auth !== "undefined" && Auth.isDesigner); },

    /** 도형 선택 → 그리기 모드 토글 */
    pickShape(shape) {
      if (!this.isDesigner()) return;
      // [마스터 버그] ISO 3D 에서는 영역 그리기 좌표가 회전 때문에 왜곡(commit 실패/도형 깨짐) →
      //   영역 도구를 켤 때 평면으로 강제 전환. (핀 선택 자동 ISO 의 부작용 차단)
      if (State.isoView && typeof MapCtrl !== "undefined" && MapCtrl.exitIso) {
        MapCtrl.exitIso();
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("평면 뷰로 전환 — 영역을 그린 뒤 ISO 로 돌아가세요");
      }
      // 같은 도형 다시 누르면 끄기
      if (State.drawingZone && this._shape === shape) { this._cancelDraw(); return; }
      this._shape = shape;
      this._poly = null;
      if (!State.drawingZone) State.drawingZone = true;
      // 핀 배치 모드와 상호 배타
      if (State.placing) {
        State.placing = false;
        UI.$("btn-place") && UI.$("btn-place").classList.remove("active");
        UI.$("place-hint") && UI.$("place-hint").classList.add("hidden");
        UI.$("crosshair-overlay") && UI.$("crosshair-overlay").classList.add("hidden");
      }
      this._syncToolUi();
    },

    /** 레거시 toggle (뷰어 차단/기본 rect) */
    toggleDraw() {
      if (!this.isDesigner()) { State.drawingZone = false; return; }
      State.drawingZone = !State.drawingZone;
      this._poly = null;
      if (State.drawingZone && State.placing) {
        State.placing = false;
        UI.$("btn-place") && UI.$("btn-place").classList.remove("active");
        UI.$("place-hint") && UI.$("place-hint").classList.add("hidden");
        UI.$("crosshair-overlay") && UI.$("crosshair-overlay").classList.add("hidden");
      }
      this._syncToolUi();
    },

    _cancelDraw() {
      State.drawingZone = false;
      this._poly = null; this._drag = null;
      this._clearDraft();
      this._syncToolUi();
    },

    _syncToolUi() {
      // [WO 20260917 색음영] 영역 그리기 중엔 기존 영역들이 도면을 덮지 않도록 옅게 표시
      // (da479bf 의 body.deck-view-active 패턴 재사용). 완성 영역 기본 스타일(.zone-shape)은 불변.
      try { document.body.classList.toggle("zone-drawing-active", !!State.drawingZone); } catch (e) {}
      ["rect", "circle", "poly"].forEach(sh => {
        const b = UI.$("btn-zone-" + sh);
        if (b) b.classList.toggle("active", State.drawingZone && this._shape === sh);
      });
      const btn = UI.$("btn-zone");
      if (btn) btn.classList.toggle("active", State.drawingZone);
      const hint = UI.$("zone-hint");
      if (hint) hint.classList.toggle("hidden", !(State.drawingZone && this._shape !== "poly"));
      const ph = UI.$("zone-poly-hint");
      if (ph) ph.classList.toggle("hidden", !(State.drawingZone && this._shape === "poly"));
      const vp = UI.$("map-viewport");
      if (vp) vp.style.cursor = State.drawingZone ? "crosshair" : "grab";
      this._renderDraft();
    },

    /* ── 드래그 그리기 (rect/circle) ── */
    onDrawStart(clientX, clientY) {
      if (!State.drawingZone) return false;
      const pct = MapCtrl.viewportToPercent(clientX, clientY);
      if (!pct) return false;
      if (this._shape === "poly") {
        // 다각형: 클릭마다 점 추가 (시작점 근처 클릭 시 닫기)
        this._poly = this._poly || [];
        if (this._poly.length >= 3) {
          const s = this._poly[0];
          if (Math.hypot(pct.x - s.x, pct.y - s.y) < 4.5) { this._finishPoly(); return true; }
        }
        this._poly.push({ x: +pct.x.toFixed(3), y: +pct.y.toFixed(3) });
        this._renderDraft();
        return true;
      }
      this._drag = { sx: pct.x, sy: pct.y, cx: pct.x, cy: pct.y };
      this._renderDraft();
      return true;
    },
    onDrawMove(clientX, clientY) {
      const pct = MapCtrl.viewportToPercent(clientX, clientY);
      if (!pct) return;
      if (this._shape === "poly") { this._polyCursor = { x: pct.x, y: pct.y }; this._renderDraft(); return; }
      if (!this._drag) return;
      this._drag.cx = pct.x; this._drag.cy = pct.y;
      this._renderDraft();
    },
    async onDrawEnd(clientX, clientY) {
      if (this._shape === "poly") return; // 다각형은 클릭 누적 방식
      if (!this._drag) return;
      const pct = MapCtrl.viewportToPercent(clientX, clientY);
      const start = this._drag; this._drag = null;
      this._clearDraft();
      if (!pct) return;
      const x = Math.min(start.sx, pct.x), y = Math.min(start.sy, pct.y);
      const w = Math.abs(pct.x - start.sx), h = Math.abs(pct.y - start.sy);
      if (w < 0.8 || h < 0.8) { this._cancelDraw(); return; } // 너무 작은 영역만 무시(모바일 드래그 완화)
      let geom;
      if (this._shape === "circle") {
        const cx = (start.sx + pct.x) / 2, cy = (start.sy + pct.y) / 2;
        const r = Math.max(w, h) / 2;
        geom = { shape: "circle", cx: +cx.toFixed(3), cy: +cy.toFixed(3), r: +r.toFixed(3) };
      } else {
        geom = { shape: "rect", x: +x.toFixed(3), y: +y.toFixed(3), w: +w.toFixed(3), h: +h.toFixed(3) };
      }
      await this._commitZone(geom);
    },

    /** 다각형 완료 → 닫힌 구역으로 저장 */
    async _finishPoly() {
      const pts = (this._poly || []).map(p => ({ x: +p.x.toFixed(3), y: +p.y.toFixed(3) }));
      this._poly = null; this._polyCursor = null;
      this._clearDraft();
      if (pts.length < 3) { this._cancelDraw(); return; }
      await this._commitZone({ shape: "poly", points: pts });
    },

    /** 도형 → 라벨 입력 → zone 객체 생성/저장 (공통) */
    async _commitZone(geom) {
      let label = "";
      const defLabel = "구역 " + (State.zones.filter(z => (z.page||1)===(State.pdfPage||1)).length + 1);
      if (typeof Prompt !== "undefined" && Prompt.ask) {
        try { const r = await Prompt.ask({ title: "영역 이름", placeholder: "예: 1번 화물창 / 엔진룸 구역" }); if (r && r.value != null && r.value !== "") label = r.value; else if (r && r.value === "") label = defLabel; else { this._cancelDraw(); return; } }
        catch (e) { this._cancelDraw(); return; }
      } else {
        label = prompt("영역 이름", defLabel) || "";
        if (!label) { this._cancelDraw(); return; }
      }
      // [버그수정] 라벨은 현재 페이지 기준인데 색상이 전체 기준이라 페이지별 색이 불일치 → 페이지 기준으로 통일
      const _pgZones = State.zones.filter(z => (z.page||1)===(State.pdfPage||1)).length;
      const color = ZONE_COLORS[_pgZones % ZONE_COLORS.length];
      const bb = this._bbox(geom);
      const zone = Object.assign({
        id: this._newId(), page: State.pdfPage || 1,
        label: label || defLabel, color, pinIds: [], note: "",
        x: bb.x, y: bb.y, w: bb.w, h: bb.h, // 항상 바운딩 박스 보관(검색/플라이 호환)
      }, geom);
      zone.pinIds = (State.pins || []).filter(p => (p.page||1) === zone.page && this._contains(zone, p.x, p.y)).map(p => p.id);
      State.zones.push(zone);
      this._cancelDraw();
      this.render();
      this.renderList();
      // [오프라인 작업지시서 ] 오프라인이면 구역 upsert op 기록 + 로컬 스냅샷
      if (!navigator.onLine && typeof OpLog !== "undefined") {
        OpLog.recordCurrent("zone", "upsert", zone.id, zone).then(() => persistLocalDeployment()).catch(() => {});
      }
      if (typeof App !== "undefined" && App._autoSave) App._autoSave();
    },

    /** 도형의 바운딩 박스(%) 계산 */
    _bbox(g) {
      if (g.shape === "circle") return { x: +(g.cx - g.r).toFixed(3), y: +(g.cy - g.r).toFixed(3), w: +(g.r * 2).toFixed(3), h: +(g.r * 2).toFixed(3) };
      if (g.shape === "poly") {
        const xs = g.points.map(p => p.x), ys = g.points.map(p => p.y);
        const minX = Math.min(...xs), minY = Math.min(...ys);
        return { x: +minX.toFixed(3), y: +minY.toFixed(3), w: +(Math.max(...xs) - minX).toFixed(3), h: +(Math.max(...ys) - minY).toFixed(3) };
      }
      return { x: g.x, y: g.y, w: g.w, h: g.h };
    },

    /** 점(x,y%)이 영역(도형) 내부인지 — rect/circle/poly 각각 정확 판정 */
    _contains(z, x, y) {
      if (z.shape === "circle") return Math.hypot(x - z.cx, y - z.cy) <= z.r;
      if (z.shape === "poly" && Array.isArray(z.points)) {
        let inside = false; const pts = z.points;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
          if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-9) + xi)) inside = !inside;
        }
        return inside;
      }
      return x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h;
    },

    /* ── 그리기 미리보기(SVG draft) ── */
    _clearDraft() {
      this._polyCursor = null;
      const svg = document.getElementById("zones-svg");
      if (svg) { const d = svg.querySelector(".zone-draft-svg"); if (d) d.remove(); }
      const legacy = document.getElementById("zone-draft");
      if (legacy) { legacy.classList.add("hidden"); }
      const pf = document.getElementById("btn-poly-finish");
      if (pf) pf.classList.add("hidden");
    },
    _renderDraft() {
      const svg = document.getElementById("zones-svg");
      if (!svg) return;
      let d = svg.querySelector(".zone-draft-svg");
      if (d) d.remove();
      if (!State.drawingZone) return;
      d = document.createElementNS("http://www.w3.org/2000/svg", "g");
      d.setAttribute("class", "zone-draft-svg");
      let inner = "";
      if (this._shape === "rect" && this._drag) {
        const x = Math.min(this._drag.sx, this._drag.cx), y = Math.min(this._drag.sy, this._drag.cy);
        const w = Math.abs(this._drag.cx - this._drag.sx), h = Math.abs(this._drag.cy - this._drag.sy);
        inner = `<rect x="${x}" y="${y}" width="${w}" height="${h}" class="zd-shape"/>`;
      } else if (this._shape === "circle" && this._drag) {
        const cx = (this._drag.sx + this._drag.cx) / 2, cy = (this._drag.sy + this._drag.cy) / 2;
        const r = Math.max(Math.abs(this._drag.cx - this._drag.sx), Math.abs(this._drag.cy - this._drag.sy)) / 2;
        inner = `<ellipse cx="${cx}" cy="${cy}" rx="${r}" ry="${r}" class="zd-shape"/>`;
      } else if (this._shape === "poly" && this._poly && this._poly.length) {
        const live = this._polyCursor ? this._poly.concat([this._polyCursor]) : this._poly;
        const pts = live.map(p => `${p.x},${p.y}`).join(" ");
        inner = `<polyline points="${pts}" class="zd-line"/>` +
          this._poly.map((p, i) => `<circle cx="${p.x}" cy="${p.y}" r="${i === 0 ? 1.3 : 0.9}" class="zd-dot${i === 0 ? " first" : ""}"/>`).join("");
      }
      d.innerHTML = inner;
      svg.appendChild(d);
      // 다각형 완료 버튼: 점 3개 이상일 때만 노출
      const pf = document.getElementById("btn-poly-finish");
      if (pf) pf.classList.toggle("hidden", !(State.drawingZone && this._shape === "poly" && this._poly && this._poly.length >= 3));
    },

    _shapeLabel(z) { return z.shape === "circle" ? "원형" : z.shape === "poly" ? "다각형" : "사각형"; },
    _shapeIcon(z) {
      const c = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
      if (z.shape === "circle") return `<svg viewBox="0 0 24 24" ${c}><circle cx="12" cy="12" r="8.5"/></svg>`;
      if (z.shape === "poly") return `<svg viewBox="0 0 24 24" ${c}><polygon points="12,3 21,9 17.5,20 6.5,20 3,9"/></svg>`;
      return `<svg viewBox="0 0 24 24" ${c}><rect x="3.5" y="5.5" width="17" height="13" rx="1.5"/></svg>`;
    },

    /* ── 렌더: 도면 위 영역 (SVG 도형 + HTML 라벨/삭제) ── */
    render() {
      const page = State.pdfPage || 1;
      const zones = (State.zones || []).filter(z => (z.page || 1) === page);
      const svg = document.getElementById("zones-svg");
      const layer = document.getElementById("zones-layer");
      if (!svg || !layer) return;

      // 1) SVG 도형(채움+테두리). 구역뷰 진입 중이면 현재 구역 외 도형 dim
      const draft = svg.querySelector(".zone-draft-svg");
      const zv = State.zoneView;
      svg.innerHTML = zones.map(z => {
        const a = z.id === this._active ? " active" : "";
        const d = (zv && z.id !== zv) ? " zone-dim" : "";
        if (z.shape === "circle") return `<ellipse data-zone="${z.id}" class="zone-shape${a}${d}" cx="${z.cx}" cy="${z.cy}" rx="${z.r}" ry="${z.r}" style="--zc:${z.color}"/>`;
        if (z.shape === "poly") return `<polygon data-zone="${z.id}" class="zone-shape${a}${d}" points="${(z.points||[]).map(p=>p.x+","+p.y).join(" ")}" style="--zc:${z.color}"/>`;
        return `<rect data-zone="${z.id}" class="zone-shape${a}${d}" x="${z.x}" y="${z.y}" width="${z.w}" height="${z.h}" rx="0.6" style="--zc:${z.color}"/>`;
      }).join("");
      if (draft) svg.appendChild(draft);

      // 2) HTML 라벨/삭제 버튼 (바운딩 박스 좌상단)
      layer.innerHTML = zones.map(z => {
        const isActive = z.id === this._active;
        const cnt = (z.pinIds || []).length;
        return `<div class="zone-box${isActive ? " active" : ""}" data-zone="${z.id}"
            style="left:${z.x}%;top:${z.y}%;width:${z.w}%;height:${z.h}%;--zc:${z.color}">
            <div class="zone-box-label">${UI.escapeHtml(z.label)}${cnt ? ` <span class="zone-box-cnt">${cnt}</span>` : ""}</div>
            ${this.isDesigner() ? `<button class="zone-box-del" data-zdel="${z.id}" title="영역 삭제" aria-label="영역 삭제"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></button>` : ""}
          </div>`;
      }).join("");

      // 이벤트 — SVG 도형 + HTML 박스
      svg.querySelectorAll(".zone-shape").forEach(el => {
        const id = el.getAttribute("data-zone");
        el.addEventListener("mouseenter", () => this.highlight(id));
        el.addEventListener("mouseleave", () => this.highlight(null));
        el.addEventListener("click", () => this.focus(id));
      });
      layer.querySelectorAll(".zone-box").forEach(el => {
        const id = el.dataset.zone;
        el.addEventListener("mouseenter", () => this.highlight(id));
        el.addEventListener("mouseleave", () => this.highlight(null));
        el.addEventListener("click", (e) => { if (e.target.closest("[data-zdel]")) return; this.inspect(id); });
      });
      layer.querySelectorAll("[data-zdel]").forEach(b => {
        b.addEventListener("click", (e) => { e.stopPropagation(); this.remove(b.dataset.zdel); });
      });
      // 구역 페이저(전체+구역 탭) 갱신
      try { if (typeof App !== "undefined" && App._renderZonePager) App._renderZonePager(); } catch (e) {}
      if (typeof UI !== "undefined" && UI.renderTree) UI.renderTree();
      this.updateLabelScale();
    },

    /** [마스터] 확대해도 흐려지지 않게: 부모 #map-transform 의 scale(zoom) 을
     *  라벨마다 역스케일(1/zoom) 로 상쇄 → 라벨은 항상 "화면상 일정 크기"로
     *  자연 해상도 렌더(업스케일 없음 → 크리스프). 핀 마커의 pinScreenScale()과 동일 원리. */
    updateLabelScale() {
      const layer = document.getElementById("zones-layer");
      if (!layer) return;
      const zoom = (typeof State !== "undefined" && State.zoom) || 1;
      const inv = (1 / zoom).toFixed(3);
      layer.querySelectorAll(".zone-box-label").forEach(el => {
        el.style.transform = `scale(${inv})`;
      });
    },

    /* ── 사이드바 목록 ── */
    renderList() {
      const sec = document.getElementById("section-zones");
      const list = document.getElementById("zone-list");
      const cntEl = document.getElementById("zone-count");
      if (!list) return;
      const zones = State.zones || [];
      if (cntEl) cntEl.textContent = zones.length;
      if (sec) sec.classList.toggle("hidden", zones.length === 0 && !this.isDesigner());
      if (zones.length === 0) {
        list.innerHTML = `<p class="zone-empty">${this.isDesigner() ? "위 ‘영역 지정 도구’(사각형·원형·선)로 구역을 그려보세요." : "지정된 영역이 없습니다."}</p>`;
        return;
      }
      list.innerHTML = zones.map(z => {
        const cnt = (z.pinIds || []).length;
        return `<div class="zone-item" data-zone="${z.id}">
            <span class="zone-item-color" style="background:${z.color}"></span>
            <span class="zone-item-shape" title="${this._shapeLabel(z)}">${this._shapeIcon(z)}</span>
            <span class="zone-item-label">${UI.escapeHtml(z.label)}</span>
            <span class="zone-item-page">p.${z.page || 1}</span>
            <span class="zone-item-cnt" title="연결된 핀"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>${cnt}</span>
            <span class="zone-item-arrow" title="상세 정보"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg></span>
          </div>`;
      }).join("");
      list.querySelectorAll(".zone-item").forEach(el => {
        const id = el.dataset.zone;
        el.addEventListener("mouseenter", () => this.highlight(id));
        el.addEventListener("mouseleave", () => this.highlight(null));
        el.addEventListener("click", () => this.inspect(id));
      });
    },

    /** 영역 + 내부 핀 하이라이트 */
    highlight(id) {
      this._active = id;
      // SVG 도형
      document.querySelectorAll("#zones-svg .zone-shape").forEach(el => {
        el.classList.toggle("active", el.getAttribute("data-zone") === id);
      });
      // 영역 박스(라벨)
      document.querySelectorAll("#zones-layer .zone-box").forEach(el => {
        el.classList.toggle("active", el.dataset.zone === id);
      });
      // 사이드바 항목
      document.querySelectorAll("#zone-list .zone-item").forEach(el => {
        el.classList.toggle("active", el.dataset.zone === id);
      });
      // 내부 핀 강조
      const zone = id ? (State.zones || []).find(z => z.id === id) : null;
      const ids = zone ? new Set(zone.pinIds || []) : new Set();
      document.querySelectorAll("#pins-layer .pin-marker").forEach(el => {
        const pid = el.dataset.pinId || el.dataset.id;
        el.classList.toggle("zone-dim", !!id && !ids.has(pid));
        el.classList.toggle("zone-hot", !!id && ids.has(pid));
      });
    },

    /** 영역으로 화면 이동(플라이) + 일시 하이라이트 */
    focus(id) {
      const zone = (State.zones || []).find(z => z.id === id);
      if (!zone) return;
      // 다른 페이지면 페이지 전환 후 이동
      if ((zone.page || 1) !== (State.pdfPage || 1) && typeof App !== "undefined" && App._gotoPage) {
        Promise.resolve(App._gotoPage(zone.page)).then(() => {
          this.render();
          setTimeout(() => { this._flyToZone(zone); this.highlight(id); }, 60);
        });
        return;
      }
      this._flyToZone(zone);
      this.highlight(id);
    },
    _flyToZone(zone) {
      const bb = this._bbox(zone);   // rect/circle/poly 모두 {x,y,w,h}
      // [WO 20260917 ISO 제거] 영역 클릭은 항상 평면으로 확대한다(강제 ISO 전환 금지 — 마스터 지시).
      //   되돌리려면 아래 주석 해제:
      //   if (State.isoView && MapCtrl.focusZoneIso) { MapCtrl.focusZoneIso(bb); return; }
      const cx = bb.x + bb.w / 2, cy = bb.y + bb.h / 2;
      // 영역 크기에 맞춰 줌 (작은 영역일수록 더 확대)
      const span = Math.max(bb.w, bb.h);
      const z = Math.max(1, Math.min(4.5, 60 / Math.max(span, 8)));
      if (MapCtrl.flyTo) MapCtrl.flyTo(cx, cy, z, 650);
    },

    async remove(id) {
      if (!this.isDesigner()) return false;
      const z = (State.zones || []).find(x => x.id === id);
      if (!z) return false;
      if (!await Prompt.confirm("영역 삭제", `영역 "${z.label}"을(를) 삭제할까요?`)) return false;
      State.zones = (State.zones || []).filter(x => x.id !== id);
      if (this._active === id) this._active = null;
      this.render();
      this.renderList();
      // [오프라인 작업지시서 ] 오프라인이면 구역 삭제 op 기록 + 로컬 스냅샷
      if (!navigator.onLine && typeof OpLog !== "undefined") {
        OpLog.recordCurrent("zone", "delete", id).then(() => persistLocalDeployment()).catch(() => {});
      }
      if (typeof App !== "undefined" && App._autoSave) App._autoSave();
      return true;
    },

    /** 핀 추가/이동 후 영역-핀 연결 갱신 */
    refreshPinLinks() {
      (State.zones || []).forEach(z => {
        z.pinIds = (State.pins || []).filter(p => (p.page||1) === (z.page||1) && this._contains(z, p.x, p.y)).map(p => p.id);
      });
    },

    /* ── CAD 인스펙터: 구역 상세 ── */
    inspect(id) {
      const z = (State.zones || []).find(x => x.id === id);
      if (!z) return;
      this.focus(id);
      Inspector.showZone(z);
    },

    serialize() { return JSON.stringify(State.zones || []); },
    load(arr) {
      State.zones = Array.isArray(arr) ? arr : [];
      this.render();
      this.renderList();
    },
  };

  /* ══════════════════════════════════════════
     INSPECTOR — CAD/3D 스타일 우측 상세 패널(구역/포인트)
  ══════════════════════════════════════════ */
  const Inspector = {
    _kind: null, _id: null,

    _open() {
      const el = document.getElementById("inspector");
      if (!el) return;
      el.classList.remove("hidden");
      requestAnimationFrame(() => el.classList.add("on"));
    },
    close() {
      const el = document.getElementById("inspector");
      if (!el) return;
      el.classList.remove("on");
      setTimeout(() => el.classList.add("hidden"), 220);
      this._kind = null; this._id = null;
      if (typeof Zones !== "undefined") Zones.highlight(null);
    },
    init() {
      const c = document.getElementById("inspector-close");
      if (c) c.addEventListener("click", () => this.close());
    },

    _fmt(n) { return (Math.round((n || 0) * 10) / 10).toFixed(1); },
    _shapeName(z) {
      if (z.shape === "circle") return "원형 (CIRCLE)";
      if (z.shape === "poly") return "다각형 (POLYGON)";
      return "사각형 (RECT)";
    },
    _area(z) {
      // % 기준 근사 면적
      if (z.shape === "circle") {
        const r = Math.max(z.w, z.h) / 2;
        return Math.PI * r * r;
      }
      if (z.shape === "poly" && Array.isArray(z.points) && z.points.length > 2) {
        let a = 0; const p = z.points;
        for (let i = 0, n = p.length; i < n; i++) {
          const j = (i + 1) % n;
          a += p[i].x * p[j].y - p[j].x * p[i].y;
        }
        return Math.abs(a) / 2;
      }
      return (z.w || 0) * (z.h || 0);
    },

    showZone(z) {
      this._kind = "zone"; this._id = z.id;
      const kindEl = document.getElementById("inspector-kind");
      const titleEl = document.getElementById("inspector-title");
      const body = document.getElementById("inspector-body");
      if (kindEl) { kindEl.textContent = "ZONE"; kindEl.className = "inspector-kind kind-zone"; }
      if (titleEl) titleEl.textContent = z.label || "(이름 없음)";

      const pins = (State.pins || []).filter(p => (z.pinIds || []).includes(p.id));
      const cx = z.x + (z.w || 0) / 2, cy = z.y + (z.h || 0) / 2;
      const designer = (typeof Auth !== "undefined" && Auth.isDesigner);

      const pinRows = pins.length
        ? pins.map((p, i) => `<button class="insp-pinrow" data-pin="${p.id}">
              <span class="insp-pinrow-no">${i + 1}</span>
              <span class="insp-pinrow-label">${UI.escapeHtml(p.label || "포인트")}</span>
              ${p.imageId || p.url || (p.attachments && p.attachments.length) ? '<span class="insp-pinrow-tag">360°</span>' : ''}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 18l6-6-6-6"/></svg>
           </button>`).join("")
        : `<div class="insp-empty">이 구역에 연결된 포인트가 없습니다.</div>`;

      body.innerHTML = `
        <div class="insp-swatch-row">
          <span class="insp-swatch" style="background:${z.color}"></span>
          <span class="insp-shape-name">${this._shapeName(z)}</span>
          <span class="insp-page-badge">PAGE ${z.page || 1}</span>
        </div>

        <div class="insp-section">
          <div class="insp-section-h">좌표 · 치수 <span class="insp-unit">(도면 % 기준)</span></div>
          <div class="insp-metrics">
            <div class="insp-metric"><span class="m-k">X</span><span class="m-v">${this._fmt(z.x)}%</span></div>
            <div class="insp-metric"><span class="m-k">Y</span><span class="m-v">${this._fmt(z.y)}%</span></div>
            <div class="insp-metric"><span class="m-k">W</span><span class="m-v">${this._fmt(z.w)}%</span></div>
            <div class="insp-metric"><span class="m-k">H</span><span class="m-v">${this._fmt(z.h)}%</span></div>
            <div class="insp-metric"><span class="m-k">중심</span><span class="m-v">${this._fmt(cx)} , ${this._fmt(cy)}</span></div>
            <div class="insp-metric"><span class="m-k">면적</span><span class="m-v">${this._fmt(this._area(z))}%²</span></div>
          </div>
        </div>

        <div class="insp-section">
          <div class="insp-section-h">연결 포인트 <span class="insp-count">${pins.length}</span></div>
          <div class="insp-pinlist">${pinRows}</div>
        </div>

        ${z.note ? `<div class="insp-section"><div class="insp-section-h">메모</div><div class="insp-note">${UI.escapeHtml(z.note)}</div></div>` : ""}

        <div class="insp-actions">
          <button class="insp-btn primary" data-act="zoom">구역 페이지 열기</button>
          <button class="insp-btn ghost" data-act="fly">화면 이동</button>
          ${designer ? `<button class="insp-btn ghost" data-act="rename">이름 변경</button>
          <button class="insp-btn danger" data-act="del">구역 삭제</button>` : ""}
        </div>
      `;

      // 핀 행 클릭 → 핀 인스펙터
      body.querySelectorAll(".insp-pinrow").forEach(b => {
        b.addEventListener("click", () => {
          const p = (State.pins || []).find(x => x.id === b.dataset.pin);
          if (p) this.showPin(p);
        });
      });
      // 액션
      body.querySelectorAll(".insp-btn").forEach(b => {
        b.addEventListener("click", async () => {
          const act = b.dataset.act;
          if (act === "zoom") { if (typeof App !== "undefined" && App.enterZoneView) App.enterZoneView(z.id); }
          else if (act === "fly") Zones.focus(z.id);
          else if (act === "del") { if (await Zones.remove(z.id)) this.close(); }
          else if (act === "rename") {
            const nv = prompt("구역 이름", z.label || "");
            if (nv != null) { z.label = nv.trim() || z.label; Zones.render(); Zones.renderList(); this.showZone(z); if (App._autoSave) App._autoSave(); }
          }
        });
      });
      this._open();
    },

    showPin(p) {
      this._kind = "pin"; this._id = p.id;
      const kindEl = document.getElementById("inspector-kind");
      const titleEl = document.getElementById("inspector-title");
      const body = document.getElementById("inspector-body");
      if (kindEl) { kindEl.textContent = "POINT"; kindEl.className = "inspector-kind kind-pin"; }
      if (titleEl) titleEl.textContent = p.label || "포인트";

      const designer = (typeof Auth !== "undefined" && Auth.isDesigner);
      const has360 = !!(p.imageId || (p.attachments && p.attachments.length));
      const inZone = (State.zones || []).find(z => (z.pinIds || []).includes(p.id));
      const docs = (p.attachments || []).filter(a => a && a.type !== "pano");

      body.innerHTML = `
        <div class="insp-swatch-row">
          <span class="insp-pin-ico ${has360 ? 'ok' : ''}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/><circle cx="12" cy="9" r="2.4"/></svg>
          </span>
          <span class="insp-shape-name">${has360 ? "360° 파노라마 등록됨" : "파노라마 미등록"}</span>
          <span class="insp-page-badge">PAGE ${p.page || 1}</span>
        </div>

        <div class="insp-section">
          <div class="insp-section-h">위치 <span class="insp-unit">(도면 % 기준)</span></div>
          <div class="insp-metrics">
            <div class="insp-metric"><span class="m-k">X</span><span class="m-v">${this._fmt(p.x)}%</span></div>
            <div class="insp-metric"><span class="m-k">Y</span><span class="m-v">${this._fmt(p.y)}%</span></div>
            <div class="insp-metric wide"><span class="m-k">소속 구역</span><span class="m-v">${inZone ? UI.escapeHtml(inZone.label) : "—"}</span></div>
          </div>
        </div>

        ${p.note ? `<div class="insp-section"><div class="insp-section-h">메모</div><div class="insp-note">${UI.escapeHtml(p.note)}</div></div>` : ""}
        ${docs.length ? `<div class="insp-section"><div class="insp-section-h">첨부 자료 <span class="insp-count">${docs.length}</span></div><div class="insp-docs">${docs.map(d => `<span class="insp-doc">${UI.escapeHtml(d.name || "자료")}</span>`).join("")}</div></div>` : ""}

        <div class="insp-actions">
          ${has360 ? `<button class="insp-btn primary" data-act="open">360° 열기</button>` : ""}
          <button class="insp-btn ghost" data-act="fly">화면 이동</button>
          ${designer ? `<button class="insp-btn ghost" data-act="edit">수정</button>
          <button class="insp-btn danger" data-act="del">삭제</button>` : ""}
        </div>
      `;
      body.querySelectorAll(".insp-btn").forEach(b => {
        b.addEventListener("click", async () => {
          const act = b.dataset.act;
          if (act === "open" && typeof PanoViewer !== "undefined") PanoViewer.open(p);
          else if (act === "fly" && MapCtrl.flyTo) MapCtrl.flyTo(p.x, p.y, 2.4, 600);
          else if (act === "edit" && App.editPin) { App.editPin(p.id); this.close(); }
          else if (act === "del" && App.deletePin) { if (await App.deletePin(p.id)) this.close(); }
        });
      });
      this._open();
    },
  };

  /* ══════════════════════════════════════════
     BRAND  ── 회사 로고·테마 주입 (window.WM_BRAND)
  ══════════════════════════════════════════ */
  const Brand = {
    cfg: null,

    apply() {
      const b = (typeof window !== "undefined" && window.WM_BRAND) || {};
      this.cfg = {
        logoUrl:      b.logoUrl || "",
        company:      b.company || "We:are Engineering",
        companyShort: b.companyShort || (b.company || "We:are").split(" ")[0],
        product:      b.product || "360° Location Viewer",
        tagline:      b.tagline || "GA DRAWING · PANORAMIC INSPECTION",
        accent:       b.accent  || ""
      };

      // 1) 테마색(accent) 주입 — 지정 시 --gold / --accent 덮어쓰기
      if (this.cfg.accent) {
        try {
          const root = document.documentElement;
          root.style.setProperty("--gold", this.cfg.accent);
          root.style.setProperty("--accent", this.cfg.accent);
        } catch (e) { /* noop */ }
      }

      // 2) 로고 슬롯 채우기 (home / topbar / pano / hub)
      this._fillLogo("brand-logo-home", "home");
      this._fillLogo("brand-logo-top",  "top");
      this._fillLogo("brand-logo-pano", "pano");
      this._fillLogo("hub-brand-logo",  "top");

      // 3) 텍스트 슬롯
      this._setText("home-badge",  this.cfg.company);
      this._setText("home-title",  this.cfg.product);
      this._setText("home-sub",    this.cfg.tagline);
      this._setText("home-footer", "POWERED BY " + this.cfg.company.toUpperCase());

      // 4) 문서 제목
      try { document.title = this.cfg.product + " · " + this.cfg.company; } catch (e) {}
    },

    _wordmark() {
      // 우선 companyShort(예: "SEASTAR")로 워드마크 생성
      const cs = (this.cfg.companyShort || "").trim();
      // "SEASTAR" → SEA(accent) + STAR(red) 2색 분할
      if (/^SEASTAR$/i.test(cs)) {
        return '<span class="brand-wm-1">SEA</span>'
             + '<span class="brand-wm-3">STAR</span>';
      }
      const c = (cs || this.cfg.company).trim();
      const sp = c.indexOf(" ");
      if (sp > 0) {
        const head = c.slice(0, sp), tail = c.slice(sp + 1);
        return '<span class="brand-wm-1">' + this._esc(head) + '</span>'
             + '<span class="brand-wm-2">' + this._esc(tail) + '</span>';
      }
      return '<span class="brand-wm-1">' + this._esc(c) + '</span>';
    },

    _fillLogo(id, variant) {
      const el = document.getElementById(id);
      if (!el) return;
      el.innerHTML = "";
      el.classList.remove("brand-logo--img", "brand-logo--text");

      const url = this.cfg.logoUrl;
      if (url) {
        const img = document.createElement("img");
        img.alt = this.cfg.company;
        img.className = "brand-logo-img";
        // 로드 실패 시 텍스트 워드마크로 폴백
        img.onerror = () => {
          el.classList.remove("brand-logo--img");
          el.classList.add("brand-logo--text");
          el.innerHTML = this._wordmark();
        };
        img.onload = () => {
          el.classList.add("brand-logo--img");
        };
        img.src = (typeof Auth !== "undefined" && Auth.r2) ? Auth.r2(url) : url;
        el.appendChild(img);
      } else {
        el.classList.add("brand-logo--text");
        el.innerHTML = this._wordmark();
      }
    },

    _setText(id, txt) {
      const el = document.getElementById(id);
      if (el && txt != null) el.textContent = txt;
    },

    _esc(s) {
      return String(s).replace(/[&<>"']/g, m => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]
      ));
    }
  };

  /* ══════════════════════════════════════════
     PIN GRID — 오른쪽 엑셀형 포인트 리스트
     현재 PDF 페이지의 핀을 표로 표시. 행 클릭 → 페이지 이동 + 핀 포커스 + 360° 자동 실행.
  ══════════════════════════════════════════ */
  const PinGrid = {
    collapsed: true,        // 기본 접힘 — 버튼(리스트 열기)을 눌러야만 표시(마스터 요청)
    query: "",

    /** 모바일/태블릿(터치) 또는 좁은 화면이면 true → 화면 가리지 않는 바텀시트(드롭다운) 모드.
     *  폭이 640px보다 큰 큰 갤럭시/폴더블/태블릿도 터치 기기는 모두 포함한다. */
    isMobileSheet() {
      if (typeof window === "undefined" || !window.matchMedia) return false;
      try {
        return window.matchMedia("(max-width: 640px), (pointer: coarse)").matches;
      } catch (e) {
        return window.matchMedia("(max-width: 640px)").matches;
      }
    },

    init() {
      const toggle = document.getElementById("pin-grid-toggle");
      const reopen = document.getElementById("pin-grid-reopen");
      const csvBtn = document.getElementById("pin-grid-csv");
      const search = document.getElementById("pin-grid-search");
      if (toggle) toggle.addEventListener("click", () => this.setCollapsed(true));
      if (reopen) reopen.addEventListener("click", () => this.setCollapsed(false));
      if (csvBtn) csvBtn.addEventListener("click", () => this.exportCsv());
      if (search) search.addEventListener("input", (e) => { this.query = (e.target.value || "").trim().toLowerCase(); this.render(); });
    },

    setCollapsed(v) {
      this.collapsed = !!v;
      const panel  = document.getElementById("pin-grid-panel");
      const reopen = document.getElementById("pin-grid-reopen");
      if (!panel) return;
      const hasDrawing = (typeof State !== "undefined") && (State.pdfDoc || (State.viewerPages && State.viewerPages.length));
      if (this.collapsed) {
        panel.classList.add("collapsed");
        if (reopen && hasDrawing) reopen.classList.remove("hidden");
      } else {
        panel.classList.remove("collapsed");
        if (reopen) reopen.classList.add("hidden");
      }
    },

    /** 현재 페이지 핀 목록(번호는 renderPinsOnMap 과 동일 규칙: 페이지 내 순번) */
    _currentPins() {
      if (typeof State === "undefined" || !State.pins) return [];
      const totalPages = State.mode === "viewer"
        ? (State.viewerPages ? State.viewerPages.length : 1)
        : State.pdfPages;
      const curPage = State.pdfPage || 1;
      const isMulti = totalPages > 1;
      const base = isMulti ? State.pins.filter(p => (p.page || 1) === curPage) : State.pins.slice();
      return base.map((p, i) => ({ pin: p, no: i + 1 }));
    },

    render() {
      const panel = document.getElementById("pin-grid-panel");
      const body  = document.getElementById("pin-grid-body");
      const empty = document.getElementById("pin-grid-empty");
      const cnt   = document.getElementById("pin-grid-count");
      const pgB   = document.getElementById("pin-grid-page-badge");
      const reopen= document.getElementById("pin-grid-reopen");
      if (!panel || !body) return;

      const hasDrawing = (typeof State !== "undefined") && (State.pdfDoc || (State.viewerPages && State.viewerPages.length));
      if (!hasDrawing) {
        panel.classList.add("hidden");
        if (reopen) reopen.classList.add("hidden");
        return;
      }
      // 데스크톱·모바일 모두: 기본 접힘. 사용자가 '포인트 리스트 열기' 버튼을 눌러야만 펼쳐짐.
      panel.classList.remove("hidden");
      // 접힌 상태면 패널은 숨고 리오픈 탭만
      if (this.collapsed) {
        panel.classList.add("collapsed");
        if (reopen) reopen.classList.remove("hidden");
      } else {
        panel.classList.remove("collapsed");
        if (reopen) reopen.classList.add("hidden");
      }

      if (pgB) pgB.textContent = "P" + (State.pdfPage || 1);

      let rows = this._currentPins();
      const totalOnPage = rows.length;
      if (this.query) {
        rows = rows.filter(r => (r.pin.label || "").toLowerCase().includes(this.query));
      }
      if (cnt) cnt.textContent = this.query ? (rows.length + "/" + totalOnPage) : String(totalOnPage);

      body.innerHTML = "";
      if (rows.length === 0) {
        if (empty) {
          empty.classList.remove("hidden");
          empty.textContent = this.query
            ? "검색 결과가 없습니다."
            : "현재 페이지(P" + (State.pdfPage || 1) + ")에 등록된 포인트가 없습니다.";
        }
        return;
      }
      if (empty) empty.classList.add("hidden");

      const esc = (typeof UI !== "undefined" && UI.escapeHtml) ? UI.escapeHtml.bind(UI) : (s => String(s == null ? "" : s));
      rows.forEach(({ pin, no }) => {
        const hasContent = (typeof App !== "undefined" && App.pinHasContent) ? App.pinHasContent(pin) : !!pin.imageId;
        const active = (typeof State !== "undefined" && State.activePin === pin.id) ? " active" : "";
        const noteTag = pin.note ? `<span class="pin-grid-tag has" title="노트"><i class="fa-solid fa-note-sticky"></i></span>` : "";
        const attN = pin.attachments ? pin.attachments.length : 0;
        const attTag = attN ? `<span class="pin-grid-tag has" title="첨부 ${attN}"><i class="fa-solid fa-paperclip"></i>${attN}</span>` : "";
        const cloudTag = pin.imageId ? `<span class="pin-grid-tag has" title="클라우드 동기화"><i class="fa-solid fa-cloud"></i></span>` : "";
        const goBtn = hasContent
          ? `<button class="pin-grid-go" title="360° 뷰어 실행"><i class="fa-solid fa-panorama"></i></button>`
          : `<span class="pin-grid-go no-content" title="등록된 360° 미디어 없음"><i class="fa-solid fa-minus"></i></span>`;
        const tr = document.createElement("tr");
        tr.className = "pin-grid-row" + active;
        tr.dataset.id = pin.id;
        tr.innerHTML =
          `<td class="pgt-no">${no}</td>` +
          `<td class="pgt-name"><div class="pin-grid-name-cell">` +
            `<span class="pin-grid-name-txt" title="${esc(pin.label)}">${esc(pin.label)}</span>` +
            `<span class="pin-grid-name-tags">${cloudTag}${noteTag}${attTag}</span>` +
          `</div></td>` +
          `<td class="pgt-page">${pin.page || 1}</td>` +
          `<td class="pgt-coord">${(pin.x).toFixed(1)}, ${(pin.y).toFixed(1)}</td>` +
          `<td class="pgt-360">${goBtn}</td>`;
        // 행 전체 클릭 → 포커스 + (콘텐츠 있으면) 360° 자동 실행
        tr.addEventListener("click", () => this._go(pin, hasContent));
        body.appendChild(tr);
      });
    },

    /** 핵심 동작: PDF 페이지 이동 + 핀 포커스(flyTo) + 360° 뷰어 자동 실행 */
    _go(pin, hasContent) {
      if (typeof App === "undefined" || !App.focusPin) return;
      // focusPin(pin, true): 페이지 전환 → flyTo → openPano(360°) 까지 일괄 처리
      App.focusPin(pin, !!hasContent);
      if (!hasContent && typeof Prompt !== "undefined" && Prompt.toast) {
        Prompt.toast("ℹ 이 포인트에는 등록된 360° 미디어가 없습니다.");
      }
    },

    exportCsv() {
      const rows = this._currentPins();
      if (!rows.length) { if (typeof Prompt !== "undefined") Prompt.toast("내보낼 포인트가 없습니다."); return; }
      const head = ["No", "Name", "Page", "X(%)", "Y(%)", "Has360"];
      const csvEsc = (v) => {
        const s = String(v == null ? "" : v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      const lines = [head.join(",")];
      rows.forEach(({ pin, no }) => {
        const has = (typeof App !== "undefined" && App.pinHasContent) ? (App.pinHasContent(pin) ? "Y" : "N") : (pin.imageId ? "Y" : "N");
        lines.push([no, csvEsc(pin.label), pin.page || 1, pin.x.toFixed(2), pin.y.toFixed(2), has].join(","));
      });
      const blob = new Blob(["\ufeff" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "seastar_points_P" + (State.pdfPage || 1) + ".csv";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      if (typeof Prompt !== "undefined") Prompt.toast("CSV 내보내기 완료");
    }
  };

  /* ══════════════════════════════════════════
     APP
  ══════════════════════════════════════════ */
  const App = {

    async init() {
      Brand.apply();
      this._bindHome();
      this._bindTopbar();
      this._bindSidebar();
      // 모바일: 영역 지정 도구를 기본 접힘으로 시작(화면 가림 방지)
      try {
        const ztw = document.getElementById("zone-tools-wrap");
        const narrowOrTouch = window.matchMedia && (window.matchMedia("(max-width: 640px)").matches || window.matchMedia("(pointer: coarse)").matches);
        if (ztw && narrowOrTouch) {
          ztw.removeAttribute("open");
        }
      } catch (e) {}
      this._bindMap();
      this._bindPano();
      MapCtrl.init(UI.$("map-viewport"), UI.$("map-transform"));
      PanoViewer.init(UI.$("pano-canvas"));
      AllPins.init();
      try { State.pinColor = PinPrefs.get(); } catch (e) {}  // 저장된 핀 색상 복원(기본 그린)
      // [버그①수정 2026-08-31] Auth.init()이 async(데모 자동로그인 refresh 포함)로 바뀌어 await 필요 —
      // ProjectHub가 프로젝트 목록을 불러오기 전에 로그인 토큰 세팅이 반드시 끝나 있어야 한다.
      await Auth.init();
      Settings.init();
      Designers.init();
      if (typeof UserMgmt !== "undefined") UserMgmt.init();
      if (typeof ThetaIntake !== "undefined") ThetaIntake.init();
      if (typeof PdfPopup !== "undefined") PdfPopup.init();
      // [고아 방지] 35_PhotoBatch 는 자체 init() 안에서만 버튼을 바인딩한다 —
      //   여기서 부르지 않으면 번들에는 있는데 버튼이 죽는다(전역 CLAUDE.md §5 렌더 고아).
      if (typeof PhotoBatch !== "undefined") PhotoBatch.init();
      // [고아 방지] 36_Help 도 자체 init() 안에서만 토글 버튼/배지를 바인딩한다 —
      //   여기서 부르지 않으면 번들에는 있는데 도움말이 뜨지 않는다(전역 CLAUDE.md §5 렌더 고아).
      if (typeof Help !== "undefined") Help.init();
      Prompt.init();
      Projects.init();
      ProjectHub.init();
      PanoNav.init();
      Notes.init();
      TimeLapse.init();
      Zones.init();
      Inspector.init();
      PinGrid.init();
      PinActionPop.init();
      CompanyAuth.init();
      PdfAnno.init();
      this._bindMobileNav();
      // 최상위 관리자 패널(기능관장·AI·코드맵) 초기화 + 기능 온오프 UI 반영
      if (typeof AdminPanels !== "undefined") { AdminPanels.init(); AdminPanels.applyFeaturesToUI(); }
      // 오프라인 우선 동기화 큐 — 배지 갱신 구독 + 자동 동기화 시작
      SyncQueue.onChange(() => this._updateSyncBadge());
      SyncQueue.init();
      this._updateSyncBadge();
      // 온라인 복귀 시 로컬에 보관된(dirty) 도면 draft + 오프라인 첨부(사진/PDF) 큐를 서버로 자동 업로드
      //   + [마스터 요청] 미연결 도면↔구역 연결도 함께 재시도(중지/새로고침 복구)
      //   SyncQueue._onReconnect() 가 첨부 flush(_syncing 가드)+도면 draft+OpLog 를 순서대로 처리(기존 가드 재사용).
      window.addEventListener("online", () => {
        setTimeout(() => SyncQueue._onReconnect(), 600);
        setTimeout(() => this._flushDeckLinkQueue(), 800);
      });
      if (navigator.onLine) {
        setTimeout(() => SyncQueue._onReconnect(), 1500);
        setTimeout(() => this._flushDeckLinkQueue(), 1800);
      }
    },

    /* ── Home ── */
    _bindHome() {
      document.querySelectorAll(".mode-card").forEach(card => {
        const open = () => {
          const mode = card.dataset.mode;
          // 설계자(디자이너) 모드는 구글 로그인 + 디자이너 권한 필요. 일반인은 뷰어만.
          if (mode === "designer") {
            // [마스터 요청 2026-09-18] 편집 진입 기본 모드 = 체크보드(사용자가 전환하면 그 선택을 기억)
            Auth.requireDesigner(() => this.openApp(PinSeries.preferredMode()));
            return;
          }
          this.openApp(mode);
        };
        card.addEventListener("click", open);
        card.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") open(); });
      });
    },

    openApp(mode, opts) {
      // 체크보드 모드: 내부적으로 디자이너와 동일하게 동작(도면등록/핀 추가/이동/삭제),
      // 차이는 ① 핀에 이름 대신 번호만 자동 부여 ② 상단 라벨/색상이 'CHECKBOARD'.
      const isCheckboard = mode === "checkboard";
      State.checkboard = isCheckboard;
      State.mode = isCheckboard ? "designer" : mode;   // 도구 분기(mode==='designer')를 그대로 재사용
      opts = opts || {};
      const isDesigner = State.mode === "designer";
      if (typeof Log !== "undefined") Log.push(mode === "viewer" ? "viewer.open" : "app.open", null, { mode });
      // 모바일 하단 네비 designer-only 버튼 표시/숨김용 body 클래스
      document.body.classList.toggle("role-designer", isDesigner);
      document.body.classList.toggle("role-viewer", !isDesigner);
      document.body.classList.toggle("mode-checkboard", isCheckboard);
      const accentVar = isCheckboard ? "var(--blue)" : (isDesigner ? "var(--gold)" : "var(--green)");
      document.documentElement.style.setProperty("--accent", accentVar);
      UI.$("topbar").style.borderBottomColor = isCheckboard ? "rgba(47,109,181,.28)" : (isDesigner ? "rgba(245,158,11,.2)" : "rgba(16,185,129,.2)");
      const dot = UI.$("topbar-dot");
      if (dot) dot.style.background = accentVar;
      // [마스터 요청 N5] "DESIGNER MODE" 글자 → 아이콘화 (글자 안어울림)
      const _modeIcon = isCheckboard
        ? '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>'
        : isDesigner
        ? '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>'
        : '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';
      const _ml = UI.$("mode-label");
      if (_ml) {
        _ml.innerHTML = _modeIcon;
        _ml.style.color = accentVar;
        _ml.title = isCheckboard ? "체크보드 모드" : (isDesigner ? "편집모드" : "뷰어 모드");
        _ml.style.display = "inline-flex"; _ml.style.alignItems = "center";
      }

      // ── 뷰어는 "보기 전용". 업로드/편집/배포 관련 UI는 모두 숨긴다. ──
      //  (사용자 요청: "뷰어는 업로드가 왜 필요하지. 뷰어만 완벽하게 되게 만들어")
      UI.toggle("section-projects",  isDesigner);   // 프로젝트/데크 관리
      UI.toggle("section-upload",    isDesigner);   // 도면 업로드
      UI.toggle("section-place",     isDesigner);   // 위치 포인트 추가 (도구 패널 — 항상 유지)
      UI.toggle("section-checkboard", isDesigner);  // 체크보드 상설 메뉴 (디자이너 전용)
      // 체크보드 메뉴 카드의 진입 버튼 라벨/활성 상태 동기화
      try {
        const cbEnter = UI.$("btn-checkboard-enter");
        const cbEnterLbl = UI.$("btn-checkboard-enter-label");
        if (cbEnter) cbEnter.classList.toggle("active", isCheckboard);
        if (cbEnterLbl) cbEnterLbl.textContent = isCheckboard ? "편집모드로 복귀" : "체크보드 모드 시작";
        const startInput = UI.$("input-checkboard-start");
        if (startInput) startInput.value = String(App._checkboardStart(State.pdfPage || 1));
        if (isCheckboard) App._updateCheckboardQuickStatus(State.pdfPage || 1);
        // [마스터 요청 2026-09-03] 배치 전 종류 선택 그리드 — 체크보드 상설 메뉴가 보일 때 렌더
        //   (isDesigner 이면 항상, quickpoint/checkboard-enter 진입 전에도 미리 준비되게).
        if (isDesigner) App._renderIconPicker("cb-icon-grid", "cb-icon-label");
      } catch (e) {}
      if (typeof Zones !== "undefined") Zones.renderList(); // 영역 목록(디자이너=항상, 뷰어=영역 있을 때)
      UI.toggle("section-export",    isDesigner);   // 뷰어로 배포
      // 핀 편집 폼은 사이드바가 아닌 도면 위 플로팅 패널 — 시작 시 닫힘
      this._closePinForm();
      UI.toggle("section-next-point", false);
      UI.toggle("btn-import-json",   false);        // JSON 가져오기 — 뷰어/디자이너 모두 숨김
      UI.toggle("section-viewer-load", !isDesigner); // 뷰어 로드 상태 표시

      // ── [마스터 규칙·G1 버그수정] 도면 빈화면(drop-hint) 문구를 모드별로 분기 ──
      //  디자이너: "도면을 업로드하세요 / ＋탭하여 도면 등록"(CTA 노출)
      //  뷰어    : "디자이너가 배포한 도면을 기다리는 중" — 등록 CTA는 절대 노출하지 않음
      try {
        const dIcon = UI.$("drop-icon"), dText = UI.$("drop-text");
        const dSub  = UI.$("drop-sub"),  dCta  = UI.$("drop-tap-cta");
        if (dCta) { dCta.classList.toggle("hidden", !isDesigner); dCta.style.display = isDesigner ? "" : "none"; }
        if (isDesigner) {
          if (dIcon) dIcon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="30" height="30" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
          if (dText) dText.textContent = "도면을 업로드하세요";
          if (dSub)  dSub.textContent  = "PDF · PNG · JPG 지원";
        } else {
          if (dIcon) dIcon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="30" height="30" aria-hidden="true"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>';
          if (dText) dText.textContent = "배포된 도면을 기다리는 중";
          if (dSub)  dSub.textContent  = "설계자가 도면을 배포하면 자동으로 표시됩니다";
        }
      } catch (e) {}

      if (isDesigner) {
        // [버그수정] 프로젝트 진입 시 구역(deck) 목록을 '즉시' 로드.
        //   기존엔 list만 로드하고 loadDecks 를 안 불러 → 처음 들어가면 구역이 안 보이고,
        //   새 구역을 만들어야(createDeck→loadDecks) 그제서야 전체가 보이는 회귀였다.
        Promise.resolve(Projects.load()).then(() => {
          if (Projects.currentProject && Projects.loadDecks) return Projects.loadDecks();
        }).catch(() => {});
        // [마스터 요청] 디자이너 진입 시 미연결 도면↔구역 연결 재시도(복구)
        setTimeout(() => this._flushDeckLinkQueue(), 1200);
      }

      if (!isDesigner) {
        // 뷰어 전용 링크(?mode=viewer)로 진입한 경우 홈 버튼도 숨긴다.
        if (State.viewerLocked) UI.$("btn-back").style.display = "none";
      } else {
        UI.$("btn-back").style.display = "";
      }

      UI.$("pin-empty").textContent = isDesigner
        ? "포인트를 추가하세요"
        : "배포된 포인트를 불러오는 중...";

      // ── A안 topbar 버튼 ──
      // 설정 버튼은 항상 노출(로그인·편집 전환 진입점)
      const btnSettings = UI.$("btn-settings");
      if (btnSettings) btnSettings.classList.remove("hidden");
      // [마스터 2026-09-13] 뷰어는 배포 링크 전용 — 앱 안에서 뷰어로 나가는 문을 닫는다(항상 숨김, exitEdit()은 남겨둠).
      const btnExit = UI.$("btn-exit-edit");
      if (btnExit) btnExit.classList.add("hidden");
      // "설계자 모드" 버튼: 설계자 권한이 있는데 지금 뷰어 모드일 때만 노출(회귀 방지)
      const btnEnter = UI.$("btn-enter-edit");
      if (btnEnter) btnEnter.classList.toggle("hidden", isDesigner || !Auth.isDesigner);
      // ←(뒤로) 버튼: 프로젝트 허브로 돌아가기 (뷰어 전용 잠금 링크에서는 숨김)
      const btnBack = UI.$("btn-back");
      if (btnBack) btnBack.style.display = State.viewerLocked ? "none" : "";

      // 진입한 프로젝트명을 topbar에 표시 (있을 때)
      if (opts.project && opts.project.name) {
        UI.text("file-name-label", opts.project.name);
        State.currentProjectId = opts.project.id;
        State.currentProjectName = opts.project.name;
      }

      // 체크보드 모드 UI 반영: 토글 버튼 활성 + 배치 버튼 라벨 변경
      const cbBtn = UI.$("btn-checkboard-enter");
      if (cbBtn) cbBtn.classList.toggle("active", isCheckboard);
      const cbLabel = UI.$("btn-checkboard-enter-label");
      if (cbLabel) cbLabel.textContent = isCheckboard ? "편집모드로 복귀" : "체크보드 모드";
      const placeBtn = UI.$("btn-place");
      if (placeBtn) placeBtn.textContent = isCheckboard ? "+ 번호 핀 찍기" : "+ 위치 포인트 추가";
      const placeHint = UI.$("place-hint");
      if (placeHint) placeHint.textContent = isCheckboard
        ? "도면 위를 클릭하면 번호가 자동으로 매겨집니다"
        : "도면 위 원하는 위치를 클릭하세요";

      UI.showScreen("screen-app");
      // 🔴 [WO 20260928-pinloss] 모드 전환(편집 ↔ 체크보드)은 **같은 도면 위에서 도구만 바꾸는 것**이다.
      //   종전엔 전환마다 아래 loadLatestDeployment 가 돌아 "프로젝트의 첫 구역" 서버본으로 화면을 갈아엎었다 —
      //   보던 구역이 바뀌고(제목이 다른 도면 파일명으로) 방금 찍은 핀이 사라졌다(라이브 재현).
      //   도면이 이미 떠 있으면 다시 불러오지 않고 현재 State 를 그대로 다시 그린다.
      if (opts.keepDrawing && State.fileType) {
        UI.renderPinList(); UI.renderPinsOnMap();
        return;
      }
      // [마스터 요청 N4 + 멀티테넌트] 작업 사라짐 수정 + 서브도메인/카드로 특정 프로젝트 지정 시 그 프로젝트 스코프.
      //   프로젝트가 지정되면(설계자 재진입·서브도메인·카드클릭) 그 프로젝트 배포본, 없으면 최신(일반 뷰어).
      this.loadLatestDeployment(opts.project || null);
    },

    /** 편집(designer) 모드 → 뷰어 모드로 전환 (A안: 홈으로 안 가고 뷰어 화면 유지) */
    exitEdit() {
      // 디자이너 편집 UI 정리 후 뷰어로 재진입
      PanoViewer.close();
      this.openApp("viewer");
    },

    /** 뷰어 모드 → 설계자 편집 모드로 전환 (설계자 권한 필요).
     *  회귀 방지: 권한 확인이 늦어 뷰어로 진입한 설계자가 즉시 편집 모드로 올라올 수 있게 한다. */
    async enterEdit() {
      if (!Auth.isDesigner && Auth.idToken) { try { await Auth.refresh(); } catch (e) {} }
      if (!Auth.isDesigner) {
        if (Auth.requireDesigner) { Auth.requireDesigner(() => this.openApp(PinSeries.preferredMode(), { project: Projects.currentProject })); }
        return;
      }
      PanoViewer.close();
      this.openApp(PinSeries.preferredMode(), { project: Projects.currentProject });
    },

    /* ── Topbar ── */
    _bindTopbar() {
      UI.$("btn-back").addEventListener("click", () => {
        State.reset();
        PanoViewer.close();
        // 첫 화면 = 프로젝트 허브로 복귀
        ProjectHub.open();
        UI.$("map-viewport").classList.add("hidden");
        UI.$("drop-hint").classList.remove("hidden");
        UI.$("pdf-error").classList.add("hidden");
        UI.$("pdf-pagination").classList.add("hidden");
        { const tb = UI.$("pdf-toolbar"); if (tb) tb.classList.add("hidden"); UI.toggleThumbPanel(false); }
        UI.$("pin-count-badge").classList.add("hidden");
        UI.$("pins-layer").innerHTML = "";
        UI.$("pin-list").innerHTML = "";
        UI.$("pin-empty").classList.remove("hidden");
        this._closePinForm();
        UI.$("section-next-point").classList.add("hidden");
        UI.$("section-export").classList.add("hidden");
        UI.$("pdf-canvas").classList.add("hidden");
        UI.$("map-image").classList.add("hidden");
        UI.text("file-name-label", "도면 없음");
        State.pan = { x: 0, y: 0 }; State.zoom = 1;
        MapCtrl.applyTransform();
      });

      UI.$("btn-prev-page").addEventListener("click", () => this._changePage(-1));
      UI.$("btn-next-page").addEventListener("click", () => this._changePage(1));
      UI.$("btn-first-page").addEventListener("click", () => this._gotoPage(1));
      UI.$("btn-last-page").addEventListener("click", () => this._gotoPage(this._totalPages()));

      // 페이지 직접 입력 (점프)
      const jump = UI.$("input-page-jump");
      const doJump = () => {
        const n = parseInt(jump.value, 10);
        if (!isNaN(n)) this._gotoPage(n);
        else jump.value = State.pdfPage;
      };
      jump.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); jump.blur(); } });
      jump.addEventListener("blur", doJump);
      jump.addEventListener("focus", () => jump.select());
    },

    _totalPages() {
      return State.mode === "viewer" && State.viewerPages
        ? State.viewerPages.length : State.pdfPages;
    },

    _changePage(dir) { return this._gotoPage(State.pdfPage + dir); },

    /** 도면 90° 회전 (PDF: 내장 getViewport 재렌더 / 이미지·뷰어: CSS transform) */
    async _rotatePdf(deg) {
      State.pdfRotation = (((State.pdfRotation + deg) % 360) + 360) % 360;
      if (State.mode !== "viewer" && State.fileType === "pdf" && State.pdfDoc) {
        // 디자이너 PDF: 캔버스를 회전값으로 다시 렌더 (핀 좌표는 비율 기준이라 그대로 유지)
        if (this._pageRendering) { this._pendingRotate = true; return; }
        this._pageRendering = true;
        try { await this._renderPdfPage(); }
        finally {
          this._pageRendering = false;
          if (this._pendingRotate) { this._pendingRotate = false; this._renderPdfPage(); }
        }
      } else {
        // 이미지 또는 뷰어(스냅샷 이미지): map-image 를 CSS 로 회전
        MapCtrl.applyTransform();
      }
      UI.updateRotationLabel();
    },

    /** 절대 페이지로 이동 (범위 클램프 + 렌더 중복 가드) */
    async _gotoPage(target) {
      const total = this._totalPages();
      if (total <= 1) return;
      const next = Math.max(1, Math.min(total, target | 0));
      if (next === State.pdfPage) { UI.updatePdfPagination(); return; }
      if (this._pageRendering) { this._pendingPage = next; return; } // 중복 렌더 방지
      State.pdfPage = next;
      UI.updatePdfPagination(); // 페이지 번호/버튼 상태 즉시 반영 (렌더 완료 전에도)
      if (State.checkboard) this._updateCheckboardQuickStatus(next); // 페이지 전환 시 "사진 폴더 연동" 버튼·안내문 갱신
      this._pageRendering = true;
      try {
        if (State.mode === "viewer" && State.viewerPages) {
          const imgEl = UI.$("map-image");
          await new Promise((res) => {
            imgEl.onload = () => res();
            imgEl.onerror = () => res();
            imgEl.src = Auth.r2(State.viewerPages[next - 1]);
          });
          this._showMapViewport();
          // [P14] 페이지가 바뀌면 이전 페이지의 고해상도 오버레이는 즉시 거짓 화면이 된다.
          //   원본을 갖고 있으면 새 페이지 기준으로 렌더 상태를 다시 잡는다.
          try { PDF._clearCrop(); } catch (e) {}
          if (State.srcPdfDoc) { await this._primeSourceRender(); MapCtrl.applyTransform(); }
        } else {
          await this._renderPdfPage();
        }
      } catch (e) {
        console.warn("페이지 전환 실패:", e);
      } finally {
        this._pageRendering = false;
        // 전환 중 들어온 마지막 요청 처리
        if (this._pendingPage != null && this._pendingPage !== State.pdfPage) {
          const p = this._pendingPage; this._pendingPage = null;
          this._gotoPage(p);
        } else {
          this._pendingPage = null;
        }
      }
    },

    /* ══════════════════════════════════════════
       구역 페이지(crop-view) 시스템
       — 물리 페이지를 늘리지 않고 "가상 페이지"로 처리.
       — 1페이지(전체)는 모든 핀 표시 + 통합관리.
       — 구역 진입 시 해당 구역만 화면에 꽉 차게 확대(crop-view),
         구역 밖 핀/구역은 흐리게 처리해 상세 작업에 집중.
       — viewportToPercent는 줌/팬 보정된 전체 도면 %를 반환하므로
         확대 상태에서 클릭해도 전역 좌표가 정확히 등록됨(중복 좌표 없음).
       ══════════════════════════════════════════ */

    /** 현재 페이지의 구역 목록(페이저 탭용) */
    _zonesOnPage() {
      const pg = State.pdfPage || 1;
      return (State.zones || []).filter(z => (z.page || 1) === pg);
    },

    /** 구역 페이지 진입 — crop-view 확대 + 비활성 핀/구역 dim */
    enterZoneView(zoneId, _retry) {
      const z = (State.zones || []).find(x => x.id === zoneId);
      if (!z) return;
      // 다른 PDF 페이지면 먼저 전환 (재시도 1회 가드 — 무한루프 방지)
      if ((z.page || 1) !== (State.pdfPage || 1) && this._gotoPage && !_retry) {
        Promise.resolve(this._gotoPage(z.page)).then(() => {
          setTimeout(() => this.enterZoneView(zoneId, true), 80);
        });
        return;
      }
      State.zoneView = zoneId;
      const bb = (typeof Zones !== "undefined" && Zones._bbox) ? Zones._bbox(z) : { x: z.x, y: z.y, w: z.w, h: z.h };
      if (MapCtrl.fitZone) MapCtrl.fitZone(bb, 0.14, 640);
      try { document.body.classList.add("zone-view-active"); } catch (e) {}
      if (typeof UI !== "undefined" && UI.renderPinsOnMap) UI.renderPinsOnMap();
      if (typeof Zones !== "undefined" && Zones.render) Zones.render();
      this._renderZonePager();
      // [토스트 스팸 제거·마스터 지시] 구역 선택 결과는 페이저 탭 활성 + 도면 필터로 이미 화면에 보인다.
    },

    /** 전체 도면 복귀 — 모든 핀/구역 표시 */
    exitZoneView() {
      State.zoneView = null;
      try { document.body.classList.remove("zone-view-active"); } catch (e) {}
      if (MapCtrl.flyTo) MapCtrl.flyTo(50, 50, 1, 560);
      if (typeof UI !== "undefined" && UI.renderPinsOnMap) UI.renderPinsOnMap();
      if (typeof Zones !== "undefined" && Zones.render) Zones.render();
      this._renderZonePager();
    },

    /** 구역 페이저 탭 strip 렌더 (전체 + zone1..zoneN) */
    _renderZonePager() {
      const bar = UI.$("zone-pager");
      if (!bar) return;
      const zones = this._zonesOnPage();
      // 구역이 없으면 페이저 숨김
      if (!zones.length) { bar.classList.add("hidden"); bar.innerHTML = ""; return; }
      bar.classList.remove("hidden");
      const cur = State.zoneView;
      let html = `<button class="zpager-tab ${!cur ? "active" : ""}" data-zone="__all__">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
          전체 도면</button>`;
      zones.forEach((z, i) => {
        const active = cur === z.id;
        const cnt = (z.pinIds || []).length;
        html += `<button class="zpager-tab ${active ? "active" : ""}" data-zone="${z.id}" title="${UI.escapeHtml(z.label || "구역 " + (i + 1))}">
            <span class="zpager-dot" style="background:${z.color || "#2f6db5"}"></span>
            <span class="zpager-name">${UI.escapeHtml(z.label || "구역 " + (i + 1))}</span>
            ${cnt ? `<span class="zpager-cnt">${cnt}</span>` : ""}
          </button>`;
      });
      bar.innerHTML = html;
      bar.querySelectorAll(".zpager-tab").forEach(b => {
        b.addEventListener("click", () => {
          const zid = b.getAttribute("data-zone");
          if (zid === "__all__") this.exitZoneView();
          else this.enterZoneView(zid);
        });
      });
      // [마스터] 상단 항상고정 대신 활성 구역 근처에 팝업 + 자동소멸(2.8초)
      this._positionZonePager(bar, cur);
      this._showZonePagerThenFade(bar);
    },

    /** 구역 페이저를 활성 구역 도형(zone-shape) 바로 아래에 배치. 없으면 상단 중앙 기본값 */
    _positionZonePager(bar, activeZoneId) {
      const area = UI.$("map-area");
      if (!area) return;
      const shape = activeZoneId ? document.querySelector('.zone-shape[data-zone="' + activeZoneId + '"]') : null;
      if (!shape) {
        // 활성 구역 없음(전체 도면) — 기본 상단 중앙
        bar.style.top = "10px"; bar.style.left = "50%"; bar.style.right = ""; bar.style.transform = "translateX(-50%)";
        return;
      }
      const areaRect = area.getBoundingClientRect();
      const sRect = shape.getBoundingClientRect();
      let top = (sRect.bottom - areaRect.top) + 8;
      let left = (sRect.left + sRect.width / 2) - areaRect.left;
      // 화면 하단을 벗어나면 구역 위쪽에 배치
      const barH = bar.offsetHeight || 40;
      if (top + barH > areaRect.height - 8) top = Math.max(8, (sRect.top - areaRect.top) - barH - 8);
      // 좌우 클램프(대략 절반 너비 확보)
      const halfW = (bar.offsetWidth || 200) / 2;
      left = Math.min(Math.max(left, halfW + 8), areaRect.width - halfW - 8);
      bar.style.top = top + "px"; bar.style.left = left + "px"; bar.style.right = ""; bar.style.transform = "translateX(-50%)";
    },

    /** 페이저를 잠깐 보여준 뒤 자동 fade-out. 호버 중엔 타이머 정지, 벗어나면 재시작 */
    _showZonePagerThenFade(bar) {
      bar.classList.add("pager-visible");
      const clearTimer = () => { if (this._zonePagerTimer) { clearTimeout(this._zonePagerTimer); this._zonePagerTimer = null; } };
      const startTimer = () => {
        clearTimer();
        this._zonePagerTimer = setTimeout(() => bar.classList.remove("pager-visible"), 2800);
      };
      if (!bar._pagerHoverBound) {
        bar._pagerHoverBound = true;
        bar.addEventListener("mouseenter", clearTimer);
        bar.addEventListener("mouseleave", startTimer);
      }
      startTimer();
    },

    /* ── Sidebar ── */
    _bindSidebar() {
      // [항목3] 포인트 목록 아이콘 토글 + 닫기 버튼
      const plToggle = document.getElementById("pin-list-toggle");
      const plClose  = document.getElementById("pin-list-close");
      if (plToggle) plToggle.addEventListener("click", () => UI.togglePinList());
      if (plClose)  plClose.addEventListener("click", (e) => { e.stopPropagation(); UI.togglePinList(false); });

      UI.$("btn-upload-drawing").addEventListener("click", async () => {
        // ── [WO 20260928·마스터 확정] 🔴 "프로젝트에 처음 도면 등록 시에는 그냥 등록만 해" ──
        //  계층은 **프로젝트 > 구역 > 영역** 이고, 도면은 트리 단계가 아니라 **구역을 잘라낼 원본 파일**이다.
        //  그래서 도면 등록은 구역을 전제하지 않는다 → 옛 "구역 0개면 업로드 차단 + createDeck() 강제"
        //  게이트를 제거한다(이름 모달 0 · 자동 이름 0 · 자동 구역 생성 0).
        //  구역은 이 도면 위에서 **첫 영역을 지정할 때** 비로소 생긴다(Projects.createDeckFromLoadedDrawing).
        //  구역이 **이미 있을 때만** "어느 구역에 붙일지"를 정한다(기존 동작 유지 — 회귀 방지).
        if (typeof Projects !== "undefined" && Projects.currentProject) {
          const decks = Projects.decks || [];
          if (decks.length > 0 && !Projects.currentDeck) {
            if (decks.length === 1) {
              Projects.currentDeck = decks[0];
              if (Projects._renderDecks) Projects._renderDecks();
            } else {
              Prompt.toast && Prompt.toast("도면을 등록할 ‘구역’을 먼저 선택하세요.");
              const db = document.getElementById("decks-block");
              if (db) { db.classList.add("zone-required-flash"); setTimeout(() => db.classList.remove("zone-required-flash"), 1800); }
              return;
            }
          }
        }
        UI.$("input-drawing").click();
      });
      UI.$("input-drawing").addEventListener("change", e => {
        const f = e.target.files[0]; if (!f) return;
        e.target.value = "";
        this._loadDrawing(f);
      });

      // ── 드래그 앤 드롭 업로드: 도면 영역에 PDF/이미지를 끌어다 놓으면 즉시 로드 ──
      this._bindDragDrop();

      UI.$("btn-import-json").addEventListener("click", () => UI.$("input-json").click());
      UI.$("input-json").addEventListener("change", e => {
        const f = e.target.files[0]; if (!f) return;
        e.target.value = "";
        const reader = new FileReader();
        reader.onload = ev => {
          try {
            const data = JSON.parse(ev.target.result);
            if (Array.isArray(data.pins)) {
              State.pins = data.pins;
              if (data.fileName) UI.text("file-name-label", data.fileName);
              UI.renderPinList();
              UI.renderPinsOnMap();
            }
          } catch { alert("JSON 파싱 실패: 올바른 포인트 파일인지 확인하세요."); }
        };
        reader.readAsText(f);
      });

      // 포인트 배치 모드 토글
      UI.$("btn-place").addEventListener("click", () => this._togglePlacing());

      // 체크보드 모드 토글 (디자이너 ↔ 체크보드) — 두 버튼 공용 핸들러
      const toggleCheckboard = () => {
        if (State.placing) this._togglePlacing();
        const next = State.checkboard ? "designer" : "checkboard";
        // [마스터 요청 2026-09-18] 사용자가 명시 전환한 모드는 다음 진입 때도 유지
        if (typeof PinSeries !== "undefined") PinSeries.setPreferredMode(next);
        App.openApp(next, { project: (typeof Projects !== "undefined" && Projects.currentProject) || null, keepDrawing: true });
        // [토스트 스팸 감소] 편집모드 복귀는 화면 전환으로 보인다 → 체크보드 진입 사용법만 안내.
        if (next === "checkboard") Prompt && Prompt.toast && Prompt.toast("체크보드 모드 — 도면을 클릭하면 번호 핀이 1씩 증가하며 찍힙니다");
        if (next === "checkboard") setTimeout(() => { if (!State.placing) this._togglePlacing(); }, 60);
      };
      const cbBtn = UI.$("btn-checkboard-toggle");
      if (cbBtn) cbBtn.addEventListener("click", toggleCheckboard);
      const cbEnter = UI.$("btn-checkboard-enter");
      if (cbEnter) cbEnter.addEventListener("click", toggleCheckboard);

      // [WO 20260918] 체크보드 번호 일괄 변경 진입점 — App._renumberCheckboard() 재사용.
      const cbRenumber = UI.$("btn-checkboard-renumber");
      if (cbRenumber) cbRenumber.addEventListener("click", () => this._renumberCheckboard());

      // [마스터 요청 2026-09-03] 사이드바 툴레일 "포인트" 버튼 — 클릭 한 번으로
      //   체크보드 순차 배치 모드 진입(기존 btn-checkboard-enter 재사용, 새 로직 없음).
      //   기존 #btn-place(이름/사진 폼)·#btn-checkboard-enter·#btn-photobatch 단독 진입은
      //   그대로 유지된다 — 이 버튼은 지름길일 뿐 기존 길을 없애지 않는다.
      const quickPoint = UI.$("btn-quickpoint");
      if (quickPoint) quickPoint.addEventListener("click", () => this._quickCheckboardEntry());

      // [WO 20260918 제거] 구 "사진 폴더 연동" 지름길(#btn-checkboard-photobatch)은 렌더 고아라
      // 삭제했다. #btn-photobatch(사이드 툴바 "사진" 그룹)가 현재 모드 계열로 자동 매칭해
      // 동일 기능을 커버한다(35_PhotoBatch.js _defaultRange).

      // 체크보드 구역별 시작 번호 입력
      const cbStart = UI.$("input-checkboard-start");
      if (cbStart) {
        const applyStart = () => {
          const n = this._setCheckboardStart(State.pdfPage || 1, cbStart.value);
          cbStart.value = String(n);
          // [토스트 스팸 제거] change+blur 두 이벤트에 물려 있어 한 번 입력에 2회 발화했다.
          // 적용된 값은 입력창에 그대로 보인다 → 토스트 불필요.
        };
        cbStart.addEventListener("change", applyStart);
        cbStart.addEventListener("blur", applyStart);
      }

      // "다음 포인트 지정" — 연속 배치
      UI.$("btn-next-point").addEventListener("click", () => {
        UI.hide("section-next-point");
        if (!State.placing) this._togglePlacing();
      });

      // 핀 폼: 그림 파일 선택
      UI.$("btn-pin-file").addEventListener("click", () => UI.$("input-pin-file").click());
      UI.$("input-pin-file").addEventListener("change", e => {
        const f = e.target.files[0];
        e.target.value = "";
        if (!f) return;
        const isImg = f.type.startsWith("image/");
        const isVid = f.type.startsWith("video/") || /\.(mp4|webm|mov)$/i.test(f.name);
        if (!isImg && !isVid) { alert("이미지(.jpg/.png) 또는 360° 영상(.mp4) 파일을 선택하세요."); return; }
        this._acceptPinMediaFile(f, isVid, false);
      });

      // ── [마스터 요청] RICOH THETA 360° 전용 버튼 (삼성폰) ──
      //   THETA 앱이 폰 갤러리에 저장한 360 JPG를 고르거나, 카메라로 바로 촬영.
      //   THETA 사진은 표준 equirectangular(가로:세로 = 2:1) → 360 뷰어로 자동 표시.
      const btnTheta = UI.$("btn-pin-theta");
      if (btnTheta) btnTheta.addEventListener("click", () => {
        if (Prompt && Prompt.toast)
          Prompt.toast("RICOH THETA 360 — 삼성폰 갤러리에서 360 사진을 고르거나 촬영하세요");
        UI.$("input-pin-theta").click();
      });
      const inputTheta = UI.$("input-pin-theta");
      if (inputTheta) inputTheta.addEventListener("change", e => {
        const f = e.target.files[0];
        e.target.value = "";
        if (!f) return;
        if (!f.type.startsWith("image/")) { alert("360° 사진(JPG/PNG)을 선택하세요."); return; }
        // THETA 경로로 들어온 이미지는 360 후보로 표시(실제 2:1 검사는 _acceptPinMediaFile 내부)
        this._acceptPinMediaFile(f, false, true);
      });

      // 핀 폼: 첨부 문서 선택 (PDF/Word 등 — 다중)
      UI.$("btn-pin-doc").addEventListener("click", () => UI.$("input-pin-doc").click());
      UI.$("input-pin-doc").addEventListener("change", e => {
        const files = Array.from(e.target.files || []);
        e.target.value = "";
        files.forEach(f => this._addPendingDoc(f));
      });

      // 핀 폼: 동영상 첨부 (3D 포인트클라우드는 E57 등 웹에서 못 읽어 동영상으로 대체).
      //   기존 영상 파이프라인(_acceptPinMediaFile → pendingIsVideo)을 재사용한다.
      const flsBtn = UI.$("btn-pin-fls");
      if (flsBtn) flsBtn.addEventListener("click", () => UI.$("input-pin-fls").click());
      const flsInput = UI.$("input-pin-fls");
      if (flsInput) flsInput.addEventListener("change", e => {
        const f = e.target.files[0];
        e.target.value = "";
        if (!f) return;
        const isVid = (f.type && f.type.startsWith("video/")) || /\.(mp4|webm|mov)$/i.test(f.name);
        if (!isVid) { Prompt.toast && Prompt.toast("동영상 파일(mp4·webm·mov)을 선택하세요"); return; }
        this._acceptPinMediaFile(f, true, false);
      });

      UI.$("input-pin-url").addEventListener("input", () => this._updateConfirmEnabled());
      UI.$("input-pin-note").addEventListener("input", () => this._updateConfirmEnabled());
      UI.$("btn-confirm-pin").addEventListener("click", () => this._confirmPin());
      UI.$("btn-cancel-pin").addEventListener("click", () => this._resetPinForm(true));

      // 컴팩트 폼: 노트/URL 접이식 토글
      const tog = (fieldId, btnId, focusId) => {
        const field = UI.$(fieldId), b = UI.$(btnId);
        if (!field || !b) return;
        const open = field.classList.toggle("hidden") === false;
        b.classList.toggle("active", open);
        if (open && focusId) { const el = UI.$(focusId); if (el) el.focus(); }
      };
      const nt = UI.$("btn-pin-note-toggle");
      if (nt) nt.addEventListener("click", () => tog("field-pin-note", "btn-pin-note-toggle", "input-pin-note"));
      const ut = UI.$("btn-pin-url-toggle");
      if (ut) ut.addEventListener("click", () => tog("field-pin-url", "btn-pin-url-toggle", "input-pin-url"));

      // [마스터: 수동 반영] 동기화 배지 클릭 → 지금 즉시 "전체" 동기화(업로드)
      const sb = UI.$("sync-badge");
      if (sb) sb.addEventListener("click", () => this.syncNow());
      // [WO 20260918] 모바일 독의 "항상 보이는" 업로드 칩 — 같은 syncNow() 재사용(새 경로 금지).
      const mUp = UI.$("mdock-upload");
      if (mUp) mUp.addEventListener("click", () => this.syncNow());

      UI.$("btn-export-json").addEventListener("click", () => this._exportJson());
      UI.$("btn-deploy").addEventListener("click", () => this._deployToViewer());
      UI.$("btn-reload-deploy").addEventListener("click", () => this.loadLatestDeployment());
      // [마스터: 수동 저장] '저장' 버튼 → 서버 반영. 미저장 변경 시 이탈 경고.
      const sbtn = UI.$("btn-save");
      if (sbtn) sbtn.addEventListener("click", () => this._saveNow({ now: true, withPages: true }));
      window.addEventListener("beforeunload", (e) => {
        if (this._dirty && State.mode === "designer") { e.preventDefault(); e.returnValue = ""; }
      });
    },

    _togglePlacing() {
      // ── [마스터 요청 #6] 배치 모드를 켜기 전, 진행 중이던 다른 명령(영역그리기·
      //   핀이동잠금·편집폼·팝업)을 먼저 조용히 종료한다. (placing 자신은 토글에 맡김)
      if (!State.placing) {
        const wasPlacing = State.placing;
        State.placing = true;              // cancel 이 placing 을 끄지 않도록 잠깐 플래그
        this.cancelActiveOperation({ silent: true });
        State.placing = wasPlacing;        // 토글 직전 원복
      }
      State.placing = !State.placing;
      if (State.placing) {
        State.pending = null;
        State.editingPinId = null;
        this._closePinForm();         // 편집 폼이 떠 있으면 닫고 새 배치 모드
        UI.hide("section-next-point");
        // [마스터 버그] ISO(원근 3D) 보기에서는 클릭→도면좌표 변환이 틀어져 핀이 엉뚱한 곳에
        //   찍힌다(perspective 역산 부정확). 정확한 배치를 위해 배치 모드 진입 시 평면 보기로 전환.
        if (State.isoView && typeof MapCtrl !== "undefined" && MapCtrl._applyIso) {
          State.isoView = false; State.isoDir = 0; MapCtrl._applyIso();
          if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("정확한 핀 배치를 위해 평면 보기로 전환했습니다 (배치 후 ISO 다시 켜기 가능)");
        }
      }
      UI.$("btn-place").classList.toggle("active", State.placing);
      UI.$("place-hint").classList.toggle("hidden", !State.placing);
      UI.$("crosshair-overlay").classList.toggle("hidden", !State.placing);
      UI.$("map-viewport").style.cursor = State.placing ? "crosshair" : "grab";
    },

    /** ── [마스터 요청 #5·#6] 현재 실행 중인 "도구/명령"을 모두 즉시 종료 ──
     *  ESC 키 또는 다른 기능 버튼 진입 시 호출 → 직전 명령이 깔끔히 중지되고
     *  새 명령만 진행되게 한다. (배치/영역그리기/핀이동잠금해제/편집폼/팝업)
     *  @returns {boolean} 실제로 무언가 취소했으면 true. */
    cancelActiveOperation(opts) {
      opts = opts || {};
      let did = false;
      // 1) 영역(존) 그리기 중 → 취소
      try {
        if (typeof Zones !== "undefined" && (State.drawingZone || (Zones._poly && Zones._poly.length))) {
          if (Zones._cancelDraw) Zones._cancelDraw(); did = true;
        }
      } catch (e) {}
      // 2) 핀 배치(placing) 모드 → 종료
      if (State.placing) {
        State.placing = false;
        const bp = UI.$("btn-place"); if (bp) bp.classList.remove("active");
        UI.hide && UI.hide("place-hint");
        const ch = UI.$("crosshair-overlay"); if (ch) ch.classList.add("hidden");
        const mv = UI.$("map-viewport"); if (mv) mv.style.cursor = "grab";
        did = true;
      }
      // 3) 핀 이동 잠금해제 상태 → 다시 잠금
      if (State.pinEditUnlocked) {
        State.pinEditUnlocked = null; State.movingPinId = null;
        document.querySelectorAll(".pin-marker.edit-unlocked,.pin-marker.moving")
          .forEach(m => m.classList.remove("edit-unlocked", "moving"));
        did = true;
      }
      // 4) 핀 편집 폼이 떠 있으면 닫기
      const pf = UI.$("section-pin-form");
      if (pf && !pf.classList.contains("hidden")) { this._closePinForm(); State.editingPinId = null; did = true; }
      // 5) 핀 작업 팝업(PinActionPop) 열려 있으면 닫기
      try {
        if (typeof PinActionPop !== "undefined" && PinActionPop.close) {
          const pap = UI.$("pin-action-pop");
          if (pap && !pap.classList.contains("hidden")) { PinActionPop.close(); did = true; }
        }
      } catch (e) {}
      // 6) pending(미확정 핀) 정리
      if (State.pending) {
        State.pending = null;
        const pp = UI.$("pending-pin"); if (pp) pp.classList.add("hidden");
        UI.hide && UI.hide("section-next-point");
        did = true;
      }
      if (did && !opts.silent && typeof Prompt !== "undefined" && Prompt.toast) {
        Prompt.toast("⎋ 진행 중이던 작업을 종료했습니다");
      }
      return did;
    },

    /** 플로팅 핀 편집 패널 열기 (새 포인트 or 기존 포인트 편집) */
    _openPinForm(opts) {
      opts = opts || {};
      const panel = UI.$("section-pin-form");
      if (!panel) return;
      panel.classList.remove("hidden");
      // 헤더 타이틀: 신규 vs 수정
      const tt = UI.$("pf-title-text");
      if (tt) tt.textContent = opts.editing ? "포인트 수정" : "새 포인트";
      const saveLbl = UI.$("pf-save-label");
      if (saveLbl) saveLbl.textContent = opts.editing ? "변경 저장" : "저장하기";
      // ── #7: 구역이 선택돼 있고 신규 포인트면 위치명 입력 숨김(번호 자동부여).
      //   편집이거나 구역이 없으면 위치명 입력 표시.
      const addr = UI.$("pf-addr");
      if (addr) {
        const zoneSelected = (typeof Projects !== "undefined" && Projects.currentDeck);
        const hideAddr = !opts.editing && !!zoneSelected;
        addr.classList.toggle("hidden", hideAddr);
      }
      // [마스터 요청] 아이콘 선택 그리드 렌더(현재 State.pendingIcon 반영)
      this._renderIconPicker();
      // 진입 애니메이션 트리거
      panel.classList.remove("pf-in");
      void panel.offsetWidth;
      panel.classList.add("pf-in");
    },

    /** [마스터 요청] 핀 아이콘 선택 그리드 렌더 + 선택 상태 동기화.
     *  [마스터 요청 2026-09-03] 배치 모드(체크보드 연속 배치)에서도 재사용하도록 일반화:
     *  gridId(기본 pf-icon-grid) + labelId(있으면 "현재: OO" 로 갱신)를 받는다.
     *  두 그리드 모두 같은 State.pendingIcon 을 공유 — 한 번 고르면 다음 배치까지 유지된다. */
    _renderIconPicker(gridId, labelId) {
      gridId = gridId || "pf-icon-grid";
      const grid = UI.$(gridId);
      if (!grid || typeof PinIcons === "undefined") return;
      const cur = State.pendingIcon || "number";
      grid._labelId = labelId || grid._labelId;
      grid.innerHTML = PinIcons.SET.map(it =>
        `<button type="button" class="pf-icon-chip${it.id === cur ? " active" : ""}" ` +
        `data-icon="${it.id}" title="${it.name}" aria-label="${it.name}" ` +
        `aria-pressed="${it.id === cur ? "true" : "false"}">${PinIcons.chipSvg(it.id)}</button>`
      ).join("");
      if (grid._labelId) {
        const lbl = UI.$(grid._labelId);
        if (lbl) lbl.textContent = "아이콘 종류 (현재: " + PinIcons.def(cur).name + ")";
      }
      // 위임 바인딩(중복 방지)
      if (!grid._iconBound) {
        grid.addEventListener("click", (e) => {
          const chip = e.target.closest(".pf-icon-chip");
          if (!chip) return;
          State.pendingIcon = chip.dataset.icon || "number";
          grid.querySelectorAll(".pf-icon-chip").forEach(c => {
            const on = c === chip;
            c.classList.toggle("active", on);
            c.setAttribute("aria-pressed", on ? "true" : "false");
          });
          if (grid._labelId) {
            const lbl = UI.$(grid._labelId);
            if (lbl) lbl.textContent = "아이콘 종류 (현재: " + PinIcons.def(State.pendingIcon).name + ")";
          }
        });
        grid._iconBound = true;
      }
    },

    /** 플로팅 핀 편집 패널 닫기 */
    _closePinForm() {
      const panel = UI.$("section-pin-form");
      if (panel) { panel.classList.add("hidden"); panel.classList.remove("pf-in"); }
    },

    _updateConfirmEnabled() {
      const hasFile = !!State.pendingFile;
      const hasUrl  = !!UI.val("input-pin-url").trim();
      const hasNote = !!UI.val("input-pin-note").trim();
      const hasDoc  = State.pendingDocs.length > 0;
      const hasFls  = !!State.pendingFls;
      // 360° 미디어가 없어도 노트/문서/3D 데이터만 있어도 저장 가능 (정보 포인트)
      UI.$("btn-confirm-pin").disabled = !(hasFile || hasUrl || hasNote || hasDoc || hasFls);
    },

    /** 첨부 문서 후보 추가 + 검증 */
    _addPendingDoc(file) {
      if (!file) return;
      if (file.size > Cloud.MAX_DOC_BYTES) {
        alert(`"${file.name}" 은 너무 큽니다 (${fmtBytes(file.size)}). 최대 ${fmtBytes(Cloud.MAX_DOC_BYTES)} 까지 첨부할 수 있습니다.`);
        return;
      }
      // 중복(같은 이름+크기) 방지
      if (State.pendingDocs.some(d => d.name === file.name && d.size === file.size)) return;
      const kind = docKind(file.type || file.name);
      State.pendingDocs.push({
        tempId: "d" + Date.now() + Math.random().toString(36).slice(2, 6),
        file, name: file.name, size: file.size, kind, status: "ready"
      });
      this._renderPendingDocs();
      this._updateConfirmEnabled();
    },

    _removePendingDoc(tempId) {
      State.pendingDocs = State.pendingDocs.filter(d => d.tempId !== tempId);
      this._renderPendingDocs();
      this._updateConfirmEnabled();
    },

    _renderPendingDocs() {
      const wrap = UI.$("pin-doc-list");
      wrap.innerHTML = "";
      State.pendingDocs.forEach(d => {
        const chip = document.createElement("div");
        chip.className = "pin-doc-chip";
        chip.innerHTML = `
          <span class="pin-doc-badge" style="background:${d.kind.color}">${d.kind.label}</span>
          <div class="pin-doc-meta">
            <div class="pin-doc-name">${UI.escapeHtml(d.name)}</div>
            <div class="pin-doc-size">${fmtBytes(d.size)}</div>
          </div>
          <button class="pin-doc-remove" title="제거" aria-label="제거">✕</button>`;
        chip.querySelector(".pin-doc-remove").addEventListener("click", () => this._removePendingDoc(d.tempId));
        wrap.appendChild(chip);
      });
    },

    _resetPinForm(hideForm) {
      State.pending = null;
      State.pendingFile = null;
      State.pendingIsVideo = false;
      State.pendingIs360 = false;
      State.pendingDocs = [];
      State.pendingFls = null;
      State.pendingIcon = "number"; // [마스터 요청] 아이콘 선택 초기화(기본 번호)
      UI.$("pending-pin").classList.add("hidden");
      UI.clearVal("input-pin-label");
      UI.clearVal("input-pin-url");
      UI.clearVal("input-pin-imgname");
      UI.clearVal("input-pin-note");
      UI.$("pin-doc-list").innerHTML = "";
      UI.$("pin-file-info").classList.add("hidden");
      UI.$("pin-file-info").textContent = "";
      UI.hide("field-pin-imgname");
      UI.hide("pin-upload-status");
      // 접이식 필드/토글 초기화
      ["field-pin-url", "field-pin-note"].forEach(id => { const el = UI.$(id); if (el) el.classList.add("hidden"); });
      ["btn-pin-note-toggle", "btn-pin-url-toggle"].forEach(id => { const b = UI.$(id); if (b) b.classList.remove("active"); });
      UI.disable("btn-confirm-pin");
      if (hideForm) { State.editingPinId = null; this._closePinForm(); UI.$("pending-pin").classList.add("hidden"); }
    },

    /* ── 모바일 하단 네비 바인딩 (메뉴=바텀시트, 콘텐츠 안 가림) ── */
    _bindMobileNav() {
      const $ = (id) => UI.$(id);
      const closeSheet = () => document.body.classList.remove("sidebar-open");
      const toggleSheet = () => document.body.classList.toggle("sidebar-open");

      // [마스터] 모바일 도구 드롭다운 토글 — 접이식으로 화면 30% 이내 유지
      const stbT = $("stb-toggle");
      if (stbT) stbT.addEventListener("click", () => {
        const open = document.body.classList.toggle("tools-open");
        stbT.setAttribute("aria-expanded", open ? "true" : "false");
      });

      const menu = $("mnav-menu");
      if (menu) menu.addEventListener("click", () => {
        toggleSheet();
        menu.classList.toggle("active", document.body.classList.contains("sidebar-open"));
      });

      const bd = $("sidebar-backdrop");
      if (bd) bd.addEventListener("click", closeSheet);

      // 도면 등록 → 기존 업로드 버튼 위임
      const up = $("mnav-upload");
      if (up) up.addEventListener("click", () => {
        closeSheet();
        const b = $("btn-upload-drawing"); if (b) b.click();
      });

      // 포인트 추가 → 기존 마킹 토글
      const place = $("mnav-place");
      if (place) place.addEventListener("click", () => {
        closeSheet();
        const b = $("btn-place"); if (b) b.click();
      });

      // 포인트 목록 → 전체 핀 드로어
      const pins = $("mnav-pins");
      if (pins) pins.addEventListener("click", () => {
        closeSheet();
        // 모바일: 화면을 가리지 않는 바텀시트(PinGrid) 토글. 도면이 있을 때만 의미.
        const hasDrawing = (typeof State !== "undefined") && (State.pdfDoc || (State.viewerPages && State.viewerPages.length));
        if (hasDrawing && typeof PinGrid !== "undefined") {
          PinGrid.render();
          PinGrid.setCollapsed(!PinGrid.collapsed ? true : false);
        } else if (typeof AllPins !== "undefined" && AllPins.show) {
          AllPins.show();
        }
      });

      // ISO 3D 토글 (공통) — 메뉴/툴바에 묻혀 있던 ISO 를 하단 아이콘으로 직접 노출
      const iso = $("mnav-iso");
      if (iso) iso.addEventListener("click", () => { closeSheet(); MapCtrl.toggleIso(); });

      // 포인트 수정 모드 토글 (디자이너) — 기존 tb-pin-edit 동작 위임
      const edit = $("mnav-edit");
      if (edit) edit.addEventListener("click", () => {
        closeSheet();
        const b = $("tb-pin-edit"); if (b) b.click();
        edit.classList.toggle("active", document.body.classList.contains("pin-edit-mode"));
      });

      // 화면 맞춤
      const fit = $("mnav-fit");
      if (fit) fit.addEventListener("click", () => { closeSheet(); MapCtrl.fit(); });

      // 상단 빠른 도구(데스크톱) — 모바일 nav 와 동일 액션 위임
      const tqMenu = $("tq-menu");
      if (tqMenu) tqMenu.addEventListener("click", () => {
        toggleSheet();
        tqMenu.classList.toggle("active", document.body.classList.contains("sidebar-open"));
      });
      const tqUp = $("tq-upload");
      if (tqUp) tqUp.addEventListener("click", () => { const b = $("btn-upload-drawing"); if (b) b.click(); });
      const tqPlace = $("tq-place");
      if (tqPlace) tqPlace.addEventListener("click", () => { const b = $("btn-place"); if (b) b.click(); });
      const tqPins = $("tq-pins");
      if (tqPins) tqPins.addEventListener("click", () => {
        const hasDrawing = (typeof State !== "undefined") && (State.pdfDoc || (State.viewerPages && State.viewerPages.length));
        if (hasDrawing && typeof PinGrid !== "undefined") {
          PinGrid.render();
          PinGrid.setCollapsed(!PinGrid.collapsed);   // 토글: 열림↔접힘
        } else if (typeof AllPins !== "undefined" && AllPins.show) {
          AllPins.show();
        }
      });
      const tqFit = $("tq-fit");
      if (tqFit) tqFit.addEventListener("click", () => MapCtrl.fit());

      // 시트 열렸을 때 사이드바 내 버튼 클릭 시 자동 닫기(업로드/배포 등 액션성)
      const sb = $("sidebar");
      if (sb) sb.addEventListener("click", (e) => {
        if (!document.body.classList.contains("sidebar-open")) return;
        const t = e.target.closest("button");
        if (t && (t.id === "btn-upload-drawing" || t.id === "btn-deploy" || t.classList.contains("deck-name"))) {
          setTimeout(closeSheet, 120);
        }
      });

      // ═══ [마스터] 모바일 그룹 도크 — 칩으로 도구 그룹 전환, 펼치면 도면을 위로 밀어 절대 가리지 않음 ═══
      const dock = $("mobile-dock");
      if (dock) {
        const rows = dock.querySelectorAll(".mdock-row");
        const grpChips = dock.querySelectorAll("[data-grp]");
        let curGrp = null;
        // 도면 영역 하단 패딩 = 도크 실제 높이 → 트레이를 펼쳐도 도면이 위로 밀려 절대 가려지지 않음(오버레이 아님).
        const setPad = () => {
          const ma = $("map-area"); if (!ma) return;
          if (window.matchMedia && window.matchMedia("(max-width:760px)").matches) ma.style.paddingBottom = dock.offsetHeight + "px";
          else ma.style.paddingBottom = ""; // 데스크톱: CSS 기본 복원
        };
        const closeTray = () => {
          dock.classList.remove("tray-open");
          rows.forEach((r) => r.classList.remove("active"));
          grpChips.forEach((c) => c.classList.remove("active"));
          curGrp = null;
          setPad(); setTimeout(setPad, 300);
        };
        // 그룹 칩 → 그 그룹 도구 한 줄만 펼침(다른 그룹은 숨김), 같은 칩 재탭 → 접힘
        grpChips.forEach((chip) => {
          chip.addEventListener("click", () => {
            const g = chip.dataset.grp;
            if (curGrp === g) { closeTray(); return; }
            closeSheet();
            curGrp = g;
            rows.forEach((r) => r.classList.toggle("active", r.dataset.group === g));
            grpChips.forEach((c) => c.classList.toggle("active", c === chip));
            dock.classList.add("tray-open");
            setPad(); setTimeout(setPad, 300);
          });
        });
        // 메뉴 칩 → 사이드바 시트(프로젝트/구역/체크보드/360 등)
        const menuChip = dock.querySelector('[data-act="menu"]');
        if (menuChip) menuChip.addEventListener("click", () => {
          closeTray();
          toggleSheet();
          menuChip.classList.toggle("active", document.body.classList.contains("sidebar-open"));
        });
        // 포인트 FAB(1탭) → 기존 배치 토글에 위임 + State.placing 동기화
        const placeChip = dock.querySelector('[data-act="place"]');
        if (placeChip) placeChip.addEventListener("click", () => {
          closeTray();
          const b = $("btn-place"); if (b) b.click();
          requestAnimationFrame(() => placeChip.classList.toggle("active", !!(typeof State !== "undefined" && State.placing)));
        });
        // 목록 칩 → 포인트 그리드(화면 가리지 않는 바텀시트)
        const listChip = dock.querySelector('[data-act="list"]');
        if (listChip) listChip.addEventListener("click", () => {
          closeTray();
          const hasDrawing = (typeof State !== "undefined") && (State.pdfDoc || (State.viewerPages && State.viewerPages.length));
          if (hasDrawing && typeof PinGrid !== "undefined") { PinGrid.render(); PinGrid.setCollapsed(!PinGrid.collapsed ? true : false); }
          else if (typeof AllPins !== "undefined" && AllPins.show) AllPins.show();
        });
        // 도구 → 기존 핸들러에 click 위임(재구현 0). 토글형은 원본 active 상태 동기화.
        dock.querySelectorAll(".mdock-tool").forEach((tool) => {
          tool.addEventListener("click", () => {
            const t = $(tool.dataset.deleg);
            if (t) t.click();
            const sync = tool.dataset.sync;
            if (sync) { const src = $(sync); if (src) requestAnimationFrame(() => tool.classList.toggle("active", src.classList.contains("active"))); }
          });
        });
        requestAnimationFrame(setPad);
        window.addEventListener("resize", setPad);
      }

      // [사이드바 재구성] 컴팩트 도구바 — 기존 버튼에 click 위임(재구현 0), 토글형 active 동기화
      document.querySelectorAll("#side-toolbar .stb-btn").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var t = UI.$(btn.dataset.deleg); if (t) t.click();
          var sync = btn.dataset.sync;
          if (sync) { var src = UI.$(sync); if (src) requestAnimationFrame(function () { btn.classList.toggle("active", src.classList.contains("active")); }); }
        });
      });
    },

    /* ── Map ── */
    _bindMap() {
      const vp = UI.$("map-viewport");

      vp.addEventListener("wheel", e => { e.preventDefault(); MapCtrl.handleWheel(e); }, { passive: false });

      vp.addEventListener("mousedown", e => {
        // ── [마스터 요청 #7] 핀(또는 액션버튼) 위를 눌렀으면 배치/그리기보다 핀 클릭을 우선.
        //   (체크보드는 항상 placing 상태라, 양보 없으면 핀 위 클릭 시 새 핀이 찍혀 '핀클릭 안됨'이 됨)
        if (e.target && e.target.closest(".pin-marker")) { return; }
        if (State.placing) { this._handlePlaceClick(e); return; }
        if (State.drawingZone) { if (Zones.onDrawStart(e.clientX, e.clientY)) { e.preventDefault(); return; } }
        MapCtrl.handlePanStart(e);
      });
      window.addEventListener("mousemove", e => {
        if (State.drawingZone && (Zones._drag || Zones._shape === "poly")) { Zones.onDrawMove(e.clientX, e.clientY); return; }
        MapCtrl.handlePanMove(e);
      });
      window.addEventListener("mouseup",   e => {
        if (State.drawingZone && Zones._drag) { Zones.onDrawEnd(e.clientX, e.clientY); return; }
        MapCtrl.handlePanEnd();
      });

      // ═══ 터치 제스처: 1손가락 팬 + 2손가락 핀치 줌 + 더블탭 줌 ═══
      // 딥리서치 결과: 모바일 PDF/도면 뷰어에서 핀치 줌은 필수(미지원 시 이탈)
      let lastTouch = null;          // 1손가락 팬 추적
      let pinch = null;              // 2손가락 핀치 상태 {dist, cx, cy}
      let lastTapTime = 0;           // 더블탭 추적
      let lastTapXY = null;

      const touchDist = (t0, t1) => Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
      const touchMid  = (t0, t1) => ({ x: (t0.clientX + t1.clientX) / 2, y: (t0.clientY + t1.clientY) / 2 });

      vp.addEventListener("touchstart", e => {
        MapCtrl.cancelFly();
        if (e.touches.length === 2) {
          // 핀치 시작 — 팬 종료, 두 손가락 거리/중점 기록
          lastTouch = null;
          const mid = touchMid(e.touches[0], e.touches[1]);
          pinch = { dist: touchDist(e.touches[0], e.touches[1]), cx: mid.x, cy: mid.y };
          e.preventDefault();
          return;
        }
        if (e.touches.length === 1) {
          // 핀(또는 액션버튼) 위 터치는 배치보다 핀 클릭을 우선 (체크보드 핀 클릭 보장)
          if (e.target && e.target.closest(".pin-marker")) { return; }
          if (State.placing) { this._handlePlaceTouch(e); return; }
          // [버그복원] 모바일 영역 그리기 — 데스크톱 mousedown 과 동일하게 터치에서도 onDrawStart
          if (State.drawingZone && typeof Zones !== "undefined") {
            if (Zones.onDrawStart(e.touches[0].clientX, e.touches[0].clientY)) { e.preventDefault(); return; }
          }
          lastTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        }
      }, { passive: false });

      vp.addEventListener("touchmove", e => {
        if (e.touches.length === 2 && pinch) {
          // 핀치 줌: 거리 비율만큼 확대/축소, 두 손가락 중점을 기준점으로
          const newDist = touchDist(e.touches[0], e.touches[1]);
          const mid = touchMid(e.touches[0], e.touches[1]);
          if (pinch.dist > 0) {
            const ratio = newDist / pinch.dist;
            if (ratio && isFinite(ratio)) MapCtrl.zoomBy(ratio, mid.x, mid.y);
          }
          // 두 손가락 중점 이동분만큼 팬도 함께(자연스러운 동작)
          State.pan.x += mid.x - pinch.cx;
          State.pan.y += mid.y - pinch.cy;
          MapCtrl.applyTransform();
          pinch = { dist: newDist, cx: mid.x, cy: mid.y };
          e.preventDefault();
          return;
        }
        // [버그복원] 영역 그리는 중엔 팬 대신 onDrawMove
        if (e.touches.length === 1 && State.drawingZone && typeof Zones !== "undefined" && (Zones._drag || Zones._shape === "poly")) {
          Zones.onDrawMove(e.touches[0].clientX, e.touches[0].clientY);
          e.preventDefault();
          return;
        }
        if (e.touches.length === 1 && lastTouch) {
          State.pan.x += e.touches[0].clientX - lastTouch.x;
          State.pan.y += e.touches[0].clientY - lastTouch.y;
          lastTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
          MapCtrl.applyTransform();
        }
        e.preventDefault();
      }, { passive: false });

      vp.addEventListener("touchend", e => {
        // 핀치 종료(손가락이 2개 미만이 되면)
        if (pinch && (!e.touches || e.touches.length < 2)) pinch = null;
        // 손가락이 0개면 팬도 종료
        if (!e.touches || e.touches.length === 0) {
          // [버그복원] 영역 그리기(rect/circle) 종료 우선 — poly 는 onDrawStart 탭 누적이라 제외
          if (State.drawingZone && typeof Zones !== "undefined" && Zones._drag) {
            const dt = (e.changedTouches && e.changedTouches[0]);
            if (dt) Zones.onDrawEnd(dt.clientX, dt.clientY);
            lastTouch = null;
            return;
          }
          // 더블탭 줌 감지 (touchend 시점, 직전 탭과 시간·위치 근접)
          const t = (e.changedTouches && e.changedTouches[0]) || null;
          if (t && !State.placing) {
            const now = Date.now();
            const x = t.clientX, y = t.clientY;
            if (now - lastTapTime < 300 && lastTapXY &&
                Math.hypot(x - lastTapXY.x, y - lastTapXY.y) < 30) {
              // 더블탭: 현재 줌 기준 토글식 확대(이미 크면 fit)
              if (State.zoom >= 2.4) MapCtrl.fit();
              else MapCtrl.zoomBy(1.8, x, y);
              lastTapTime = 0; lastTapXY = null;
            } else {
              lastTapTime = now; lastTapXY = { x, y };
            }
          }
          lastTouch = null;
        }
      });

      // 더블클릭으로 클릭 지점 중심 줌인 (데스크톱)
      vp.addEventListener("dblclick", e => {
        if (State.placing) return;
        MapCtrl.zoomBy(1.6, e.clientX, e.clientY);
      });

      // 플로팅 네비게이션 툴바 (Bluebeam 스타일 — 확대/축소/맞춤/실제크기)
      const bind = (id, fn) => { const el = UI.$(id); if (el) el.addEventListener("click", fn); };
      bind("btn-zoom-in",  () => MapCtrl.zoomBy(1.25));
      bind("btn-zoom-out", () => MapCtrl.zoomBy(0.8));
      bind("btn-fit",      () => MapCtrl.fit());
      bind("btn-actual",   () => MapCtrl.actualSize());
      bind("zoom-level",   () => MapCtrl.actualSize());
      bind("btn-iso",      () => MapCtrl.toggleIso());
      // 회전 (PDF.js 내장 getViewport({rotation}) 활용)
      bind("btn-rotate-cw",  () => this._rotatePdf(90));
      bind("btn-rotate-ccw", () => this._rotatePdf(-90));
      bind("rotate-level",   () => { State.pdfRotation = 0; this._rotatePdf(0); });

      // ═══ ezPDF 스타일 상단 도구 툴바 (동일 핸들러 재사용) ═══
      bind("tb-zoom-in",   () => MapCtrl.zoomBy(1.25));
      bind("tb-zoom-out",  () => MapCtrl.zoomBy(0.8));
      bind("tb-zoom-level",() => MapCtrl.actualSize());
      bind("tb-fit",       () => MapCtrl.fit());
      bind("tb-actual",    () => MapCtrl.actualSize());
      bind("tb-iso",       () => MapCtrl.toggleIso());
      // [마스터 요청] 포인트 수정 모드 토글 — 켠 뒤 핀 클릭 시 수정/이동/삭제 팝업
      bind("tb-pin-edit",  () => {
        State.editMode = !State.editMode;
        const b = UI.$("tb-pin-edit");
        if (b) b.classList.toggle("active", State.editMode);
        document.body.classList.toggle("pin-edit-mode", State.editMode);
        // [토스트 스팸 제거] 버튼 active 상태 + body.pin-edit-mode 스타일로 결과가 이미 보인다.
      });
      bind("tb-rotate-cw", () => this._rotatePdf(90));
      bind("tb-rotate-ccw",() => this._rotatePdf(-90));
      // [마스터: "pdf뷰 방향 보정 기능이 사라졌네"] 도면 화면 진입구 — 파노라마 전용 버튼(#btn-pano-setdir)과
      //   동일한 경로(openPano→Radar.enterDirAdjustMode)를 공유한다(로직 복제 금지). 선행조건 미충족 시
      //   조용히 무반응하지 않고 토스트로 사유를 알린다.
      bind("tb-setdir", () => {
        const pin = (State.pins || []).find(p => p.id === State.activePin);
        if (!pin) {
          if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("먼저 도면에서 핀을 선택하세요");
          return;
        }
        if (!this.pinHasMedia(pin)) {
          if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("이 핀에는 360 사진이 없어 방향을 지정할 수 없습니다");
          return;
        }
        this.openPano(pin);   // 동기 구간에서 Radar.update(pin)까지 실행되어 미니맵이 즉시 표시됨
        // [p13 회귀주의] 아래 호출은 #btn-pano-setdir 핸들러와 "동일 로직을 공유"하되, 완전히 동일한
        // 문자열로 두면 tests/p13-setdir-flow.test.mjs 의 String.replace(needle) 뮤테이션이 먼저
        // 나오는 이 블록을 대신 맞혀 원본 검증을 무력화한다 — 괄호 표현만 구분해 회피(동작은 동일).
        if (typeof Radar !== "undefined" && Radar.enterDirAdjustMode) { Radar.enterDirAdjustMode(); }
      });
      // 페이지 이동
      bind("tb-first", () => this._gotoPage(1));
      bind("tb-prev",  () => this._changePage(-1));
      bind("tb-next",  () => this._changePage(1));
      bind("tb-last",  () => this._gotoPage(this._totalPages()));
      // 썸네일 패널 토글
      bind("tb-thumbs", () => UI.toggleThumbPanel());
      // 포인트 마킹 — 기존 마킹 버튼(btn-place) 위임
      bind("tb-mark", () => { const b = UI.$("btn-place"); if (b) b.click(); });
      // 페이지 직접 입력
      const tbJump = UI.$("tb-page-input");
      if (tbJump) {
        const doTbJump = () => {
          const n = parseInt(tbJump.value, 10);
          if (!isNaN(n)) this._gotoPage(n);
          else tbJump.value = State.pdfPage;
        };
        tbJump.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); tbJump.blur(); } });
        tbJump.addEventListener("blur", doTbJump);
        tbJump.addEventListener("focus", () => tbJump.select());
      }
    },

    /** 선택된 구역명 기반 자동 사진 파일명: '구역명_번호'. 구역 없으면 null. */
    _zoneImageName() {
      const deck = (typeof Projects !== "undefined") ? Projects.currentDeck : null;
      if (!deck || !deck.name) return null;
      const base = String(deck.name).trim().replace(/\s+/g, "_").replace(/[^\w가-힣\-]/g, "");
      const page = State.pdfPage || 1;
      let n = 0;
      (State.pins || []).forEach((p) => {
        if ((p.page || 1) !== page) return;
        if (p.imageId || p.pendingOpId || p.imageName) n++;
      });
      const next = State.editingPinId ? Math.max(n, 1) : (n + 1);
      return base + "_" + next;
    },

    /** ── [마스터 요청] 핀 사진/영상 파일 공통 처리 + RICOH THETA 360 자동 판별 ──
     *  @param f         선택된 File
     *  @param isVid     동영상 여부
     *  @param viaTheta  THETA 360 버튼 경로 여부(360 후보 우선)
     *  THETA 사진은 equirectangular(가로:세로 ≈ 2:1) → 비율 검사로 360 자동 태깅. */
    _acceptPinMediaFile(f, isVid, viaTheta) {
      State.pendingFile = f;
      State.pendingIsVideo = !!isVid;
      State.pendingIs360 = false; // 검사 후 갱신
      const info = UI.$("pin-file-info");
      const sizeMB = (f.size / 1024 / 1024).toFixed(1);
      info.textContent = (isVid ? "" : "") + f.name + " (" + sizeMB + " MB)";
      info.classList.remove("hidden");
      UI.show("field-pin-imgname");
      const autoName = this._zoneImageName();
      UI.$("input-pin-imgname").value = autoName || f.name.replace(/\.[^.]+$/, "");
      this._updateConfirmEnabled();

      // 이미지면 실제 픽셀 비율로 360(2:1) 판별 → 뱃지 표시 + 360 태깅
      if (!isVid && f.type.startsWith("image/")) {
        this._detect360(f, (is360, w, h) => {
          State.pendingIs360 = is360;
          const badge = is360 ? "  360° 파노라마" : (viaTheta ? "  360 비율 아님(일반 사진)" : "");
          if (badge) {
            info.textContent = (is360 ? "" : "") + f.name + " (" + sizeMB + " MB)" + badge;
          }
          if (is360 && !autoName) {
            // 360이면 이름 끝에 _360 힌트
            const cur = UI.$("input-pin-imgname").value;
            if (cur && !/_360$/i.test(cur)) UI.$("input-pin-imgname").value = cur + "_360";
          }
          if (is360 && Prompt && Prompt.toast)
            Prompt.toast("360° 사진 감지(" + w + "×" + h + ") — 둘러보기 뷰어로 표시됩니다");
        });
      }

      // 새 포인트 + 이미지 → 즉시 저장(편집 모드는 명시적 저장 버튼)
      if (!State.editingPinId) {
        setTimeout(() => this._confirmPin(), viaTheta ? 260 : 120);
      }
    },

    /** 이미지 파일이 360 equirectangular(가로:세로 ≈ 2:1)인지 비동기 판별 */
    _detect360(file, cb) {
      try {
        const url = URL.createObjectURL(file);
        const im = new Image();
        im.onload = () => {
          const w = im.naturalWidth, h = im.naturalHeight;
          const ratio = h > 0 ? w / h : 0;
          // THETA/equirectangular는 정확히 2:1. 허용오차 ±8%.
          const is360 = ratio >= 1.85 && ratio <= 2.15 && w >= 1024;
          URL.revokeObjectURL(url);
          cb(is360, w, h);
        };
        im.onerror = () => { URL.revokeObjectURL(url); cb(false, 0, 0); };
        im.src = url;
      } catch (e) { cb(false, 0, 0); }
    },

    /** 체크보드 모드: 클릭 즉시 번호 핀 생성(이름/사진 폼 없음).
     *  번호는 현재 페이지 내 순번(렌더 규칙과 동일)으로 자동 부여. */
    /** 현재 구역(페이지)의 체크보드 시작 번호 (미설정 시 1).
     *  🔴 [WO 20260917 멀티유저 ①·재설계] 마스터 확정: "시작번호 = 사용자별 번호 대역"
     *  (예: 사용자A=100, 사용자B=200 — 번호만 봐도 누가 찍었는지 알고, 충돌이 구조적으로 없다).
     *  로그인 사용자의 대역(PinSeries.userBandStart, localStorage 영속)이 있으면 최우선이고,
     *  없으면 기존 페이지별 값(State.checkboardStart, 구버전/비로그인 폴백)을 쓴다. */
    _checkboardStart(page) {
      const p = page || State.pdfPage || 1;
      const author = this._pinAuthor();
      const band = (author && typeof PinSeries !== "undefined" && PinSeries.userBandStart) ? PinSeries.userBandStart(author) : null;
      if (band != null) return band;
      const v = State.checkboardStart && State.checkboardStart[p];
      const n = parseInt(v, 10);
      return (Number.isFinite(n) && n >= 1) ? n : 1;
    },
    /** 시작 번호 설정. 로그인 사용자는 "내 대역"(사용자에게 귀속 — localStorage, 배포본
     *  단일 필드에 저장하면 다른 사용자가 저장할 때 덮어써진다)을 최우선으로 저장한다.
     *  비로그인/데모(author 없음)는 종전처럼 페이지별 값만 저장(하위호환). */
    _setCheckboardStart(page, value) {
      const p = page || State.pdfPage || 1;
      let n = parseInt(value, 10);
      if (!Number.isFinite(n) || n < 1) n = 1;
      const author = this._pinAuthor();
      if (author && typeof PinSeries !== "undefined" && PinSeries.setUserBandStart) {
        PinSeries.setUserBandStart(author, n);
      }
      State.checkboardStart = State.checkboardStart || {};
      State.checkboardStart[p] = n;
      this._autoSave && this._autoSave();
      return n;
    },

    /** [WO 20260918] 🔴 사용자가 버튼을 눌러서만 실행되는 일괄 재채번(자동 재채번 아님 —
     *  duplicateCheckboardIds() 위 주석의 금지 규율과 충돌하지 않는다, 01b_PinSeries.js 참조).
     *  버튼 클릭 → 새 시작번호 입력(Prompt.ask, 새 UI 없음) → 미리보기/확인(confirm) →
     *  적용. 계산·검증은 PinSeries.renumberCheckboardRange() 정본에 전부 있고, 여기선
     *  호출·확인·반영만 한다. */
    async _renumberCheckboard() {
      const page = State.pdfPage || 1;
      const cur = PinSeries.numbers(State.pins, page);
      const curTargets = (State.pins || []).filter((p) => p && (p.page || 1) === page && p.checkboard);
      if (!curTargets.length) { Prompt.toast && Prompt.toast("이 페이지에는 체크보드 핀이 없습니다"); return; }
      let curMin = Infinity, curMax = -Infinity;
      curTargets.forEach((p) => { const info = cur.get(p.id); if (info) { curMin = Math.min(curMin, info.no); curMax = Math.max(curMax, info.no); } });
      const res = await Prompt.ask({
        title: "번호 일괄 변경",
        sub: "현재 " + curTargets.length + "개(" + curMin + "~" + curMax + "번) — 새 시작 번호를 입력하세요",
        placeholder: "새 시작 번호", value: String(curMax + 1)
      });
      if (!res) return;
      const result = PinSeries.renumberCheckboardRange(State.pins, page, res.value);
      if (!result.ok) { Prompt.toast && Prompt.toast(result.reason || "변경할 수 없습니다"); return; }
      const first = result.changes[0].newLabel, last = result.changes[result.changes.length - 1].newLabel;
      if (!await Prompt.confirm("번호 일괄 변경", "체크보드 핀 " + result.changes.length + "개를 " + first + "~" + last + "번으로 변경합니다. 되돌리기 어렵습니다 — 계속할까요?")) return;
      const byId = new Map((State.pins || []).map((p) => [p.id, p]));
      result.changes.forEach((c) => {
        const pin = byId.get(c.id);
        if (!pin) return;
        pin.label = c.newLabel;
        // [WO 20260918] 🔴 id 는 절대 건드리지 않는다 — 사진/노트는 pin.id 로 연결되므로
        // 라벨(표시 번호)만 바뀌어도 연결 불변. 아래 로그는 그 사실을 재확인용으로 남긴다.
        if (typeof Log !== "undefined") Log.push("pin.renumber", pin.id, { oldLabel: c.oldLabel, newLabel: c.newLabel, page: page });
        if (!navigator.onLine && typeof OpLog !== "undefined" && OpLog.recordCurrent) { try { OpLog.recordCurrent("pin", "upsert", pin.id, pin); } catch (e) {} }
      });
      this._markDirty && this._markDirty();
      this._autoSave && this._autoSave();
      if (typeof UI !== "undefined") { UI.renderPinsOnMap && UI.renderPinsOnMap(); UI.renderPinList && UI.renderPinList(); }
      this._updateCheckboardQuickStatus && this._updateCheckboardQuickStatus(page);
      Prompt.toast && Prompt.toast(result.changes.length + "개 번호를 " + first + "~" + last + "번으로 변경했습니다" + (navigator.onLine ? "" : "(오프라인 — 연결 후 동기화)"));
    },

    /** [WO 20260917 멀티유저 ②] 핀 생성 시점의 작성자 식별자(이메일 우선) — 없으면 null.
     *  🔴 신규 핀에만 부여(편집 시 기존 pin.author 는 건드리지 않는다 — 편집자≠원작성자).
     *  기존 13_Notes.js/32_Offline.js 와 동일 관례(author=email)를 재사용(SoT 필드명 통일). */
    _pinAuthor() {
      try {
        if (typeof Auth !== "undefined" && Auth.user) return Auth.user.email || Auth.user.name || null;
      } catch (e) {}
      return null;
    },

    _placeCheckboardPin(pct) {
      const curPage = State.pdfPage || 1;
      // 🔴 채번 정본 = PinSeries. 체크보드 계열은 콘텐츠 핀과 독립이므로
      //   "페이지 내 전체 핀 수"가 아니라 "페이지 내 체크보드 핀 수"로 증가한다.
      const start = this._checkboardStart(curPage);
      const _auth0 = this._pinAuthor();
      // 🔴 [WO 20260917 멀티유저 ①·재설계] author 를 넘겨 "내 대역"만으로 다음 번호를 계산한다
      //   — 안 그러면 다른 사용자가 찍은 더 큰 번호(다른 대역)가 내 다음 번호에 섞여 침범한다.
      const no = PinSeries.nextCheckboardNo(State.pins, curPage, start, _auth0);
      const pin = { id: Date.now(), x: pct.x, y: pct.y, page: curPage, label: String(no), checkboard: true };
      if (_auth0) pin.author = _auth0; // [WO 20260917 멀티유저 ②]
      // [마스터 요청 2026-09-03] 배치 전 고른 종류(State.pendingIcon)로 연속 배치.
      //   폼(20_App.js:1846/1972)과 동일 규칙 — 기본값(number)이면 필드 자체를 생략(하위호환).
      if (State.pendingIcon && State.pendingIcon !== "number") pin.icon = State.pendingIcon;
      State.pins.push(pin);
      if (typeof Log !== "undefined") Log.push("pin.add", pin.id, { label: pin.label, page: pin.page, checkboard: true });
      State.activePin = pin.id;
      if (typeof Zones !== "undefined") Zones.refreshPinLinks();
      UI.renderPinList();
      UI.renderPinsOnMap(pin.id);
      if (typeof PinGrid !== "undefined") PinGrid.render();
      this._updateSyncBadge && this._updateSyncBadge();
      this._autoSave && this._autoSave();
      this._updateCheckboardQuickStatus(curPage);
      Prompt && Prompt.toast && Prompt.toast("체크 포인트 #" + no + " 추가 · 자동저장");
    },

    /** [마스터 요청 2026-09-03] 사이드바 툴레일 "포인트" 버튼의 진입점 — 클릭 한 번으로
     *  체크보드 순차 배치 모드로 들어간다(기존 로직 재사용, 새 진입 로직 없음).
     *  이미 체크보드 모드면 배치 토글(#btn-place)만 위임한다. */
    _quickCheckboardEntry() {
      if (!State.checkboard) {
        const cb = UI.$("btn-checkboard-enter");
        if (cb) cb.click(); // 기존 toggleCheckboard 재사용 — 체크보드 진입 + 배치 자동 시작
      } else {
        const bp = UI.$("btn-place");
        if (bp) bp.click();
      }
    },

    /** 현재 페이지에서 방금 찍은 체크보드 계열 핀의 번호 범위(시작~마지막).
     *  🔴 번호는 PinSeries 정본에서만 파생(자체 채번 금지). 찍은 핀이 없으면 시작번호로 폴백.
     *  [마스터 요청 2026-09-03] series:"checkboard" 를 함께 반환해 PhotoBatch.open() 이
     *  콘텐츠 계열과 혼동하지 않게 한다(번호는 계열마다 독립 채번이라 계열 지정 필수). */
    _checkboardQuickRange(page) {
      const pg = page || State.pdfPage || 1;
      const map = PinSeries.numbers(State.pins, pg);
      let start = null, end = null;
      (State.pins || []).forEach((p) => {
        if (!p || (p.page || 1) !== pg || !p.checkboard) return;
        const info = map.get(p.id);
        if (!info) return;
        if (start === null || info.no < start) start = info.no;
        if (end === null || info.no > end) end = info.no;
      });
      const fallback = this._checkboardStart(pg);
      return { start: start === null ? fallback : start, end: end === null ? fallback : end, series: "checkboard" };
    },

    /** [마스터 요청 2026-09-03, WO 20260918 갱신] "지금 몇 번부터 / 몇 개 찍었는지"를 기존
     *  place-hint 문구에 반영한다. (구 "사진 폴더 연동" 퀵버튼 노출 토글은 그 버튼이 렌더
     *  고아라 삭제되며 함께 제거 — #btn-photobatch 로 통합.) */
    _updateCheckboardQuickStatus(page) {
      const pg = page || State.pdfPage || 1;
      const cnt = (State.pins || []).filter((p) => p && (p.page || 1) === pg && p.checkboard).length;
      const range = this._checkboardQuickRange(pg);
      const hint = UI.$("place-hint");
      if (hint && State.checkboard) {
        hint.textContent = cnt
          ? ("시작 " + this._checkboardStart(pg) + "번부터 · " + cnt + "개 찍음 · 다음 " + (range.end + 1) + "번 (계속 클릭)")
          : "도면 위를 클릭하면 번호가 자동으로 매겨집니다";
      }
    },

    _handlePlaceClick(e) {
      if (!State.placing) return;
      const pct = MapCtrl.viewportToPercent(e.clientX, e.clientY);
      if (!pct) return;

      // 체크보드 모드: 이름/사진 입력 없이 즉시 번호 핀만 찍는다.
      // 연속 배치 — placing 을 유지해 클릭마다 번호가 1씩 증가하며 계속 찍힌다.
      if (State.checkboard) {
        this._placeCheckboardPin(pct);
        return; // placing 유지(다음 클릭도 번호 핀). 종료는 '＋ 번호 핀 찍기' 토글로.
      }

      State.pending = pct;
      State.placing = false;
      UI.$("btn-place").classList.remove("active");
      UI.$("place-hint").classList.add("hidden");
      UI.$("crosshair-overlay").classList.add("hidden");
      UI.$("map-viewport").style.cursor = "grab";

      // _resetPinForm이 pending-pin을 hidden 처리 + State.pending=null 로 만들므로
      //    반드시 먼저 폼을 리셋한 뒤, 그 다음에 임시 핀을 표시/좌표 설정한다.
      State.editingPinId = null;
      this._resetPinForm(false);
      State.pending = pct; // resetPinForm이 지우므로 재설정

      const pp = UI.$("pending-pin");
      pp.style.left = pct.x + "%";
      pp.style.top  = pct.y + "%";
      pp.classList.remove("hidden");

      // 지정한 위치로 줌인 (플라이투) — 정확한 위치 확인
      MapCtrl.flyTo(pct.x, pct.y, Math.max(State.zoom, 2.2));

      this._openPinForm({ editing: false });
      // [THETA 인입] 위치지정 대기 중인 R* 360 사진이 있으면, 파일 선택 없이 그 사진을
      //   바로 첨부·등록한다(사진-우선 워크플로). 없으면 기존대로 사진 선택 다이얼로그.
      if (State.intakeFile) {
        const f = State.intakeFile; State.intakeFile = null;
        setTimeout(() => {
          this._acceptPinMediaFile(f, false, true);  // 360 판별 + 자동 _confirmPin → 핀 등록(오프라인 큐잉)
          if (typeof ThetaIntake !== "undefined") ThetaIntake._afterPlaced();
        }, 280);
      } else {
        // 포인트를 추가하면 바로 사진 업로드 다이얼로그를 띄운다 (요청사항)
        setTimeout(() => { const fi = UI.$("input-pin-file"); if (fi) fi.click(); }, 280);
      }
      // 위치명 입력이 표시돼 있을 때만 포커스 (구역 선택 시엔 숨겨짐)
      const addr = UI.$("pf-addr");
      if (addr && !addr.classList.contains("hidden")) UI.$("input-pin-label").focus();
    },

    _handlePlaceTouch(e) {
      e.preventDefault();
      const t = e.touches[0];
      this._handlePlaceClick({ clientX: t.clientX, clientY: t.clientY });
    },

    /* ── Pano ── */
    _bindPano() {
      UI.$("btn-pano-close").addEventListener("click", () => PanoViewer.close());

      const canvas = UI.$("pano-canvas");
      canvas.addEventListener("mousedown", e => PanoViewer.onPointerDown(e.clientX, e.clientY));
      window.addEventListener("mousemove", e => PanoViewer.onPointerMove(e.clientX, e.clientY));
      window.addEventListener("mouseup",   () => {
        const r = PanoViewer.onPointerUp();
        if (r && r.spotMoved) this._finalizeSpotDrag(r.spotMoved);
      });
      // [FARO Markers] 마커 위 마우스오버 → 내용 툴팁
      canvas.addEventListener("mousemove", e => this._panoHover(e.clientX, e.clientY));
      canvas.addEventListener("mouseleave", () => this._hideSpotTip());
      canvas.addEventListener("wheel", e => PanoViewer.onWheel(e), { passive: false });
      // ═══ 360 뷰어 터치: 1손가락 회전 + 2손가락 핀치 줌(FOV) ═══
      let panoPinchDist = null;
      const pDist = (t0, t1) => Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
      canvas.addEventListener("touchstart", e => {
        if (e.touches.length === 2) {
          panoPinchDist = pDist(e.touches[0], e.touches[1]);
          e.preventDefault();
        } else if (e.touches.length === 1) {
          PanoViewer.onPointerDown(e.touches[0].clientX, e.touches[0].clientY);
        }
      }, { passive: false });
      canvas.addEventListener("touchmove", e => {
        e.preventDefault();
        if (e.touches.length === 2 && panoPinchDist != null) {
          const d = pDist(e.touches[0], e.touches[1]);
          const delta = panoPinchDist - d;        // 벌리면 줌인(FOV↓), 모으면 줌아웃(FOV↑)
          if (Math.abs(delta) > 1) { PanoViewer.setFov(delta * 0.18); panoPinchDist = d; }
        } else if (e.touches.length === 1) {
          PanoViewer.onPointerMove(e.touches[0].clientX, e.touches[0].clientY);
        }
      }, { passive: false });
      canvas.addEventListener("touchend", e => {
        if (!e.touches || e.touches.length < 2) panoPinchDist = null;
        const wasTap = PanoViewer.wasTap && PanoViewer.wasTap();
        const r = PanoViewer.onPointerUp();
        if (r && r.spotMoved) { this._finalizeSpotDrag(r.spotMoved); return; }
        // [구면 마커] 탭이면 마커 추가/열기 (changedTouches 좌표 사용)
        if (wasTap && e.changedTouches && e.changedTouches[0]) {
          const t = e.changedTouches[0];
          this._onPanoTap(t.clientX, t.clientY);
        }
      });
      // [구면 마커] 마우스 탭(클릭)으로 마커 추가/열기
      canvas.addEventListener("click", e => { if (PanoViewer.wasTap && PanoViewer.wasTap()) this._onPanoTap(e.clientX, e.clientY); });

      // 파노라마 컨트롤 버튼
      UI.$("btn-pano-rotate").addEventListener("click", e => {
        const on = PanoViewer.toggleAuto();
        e.currentTarget.classList.toggle("on", on);
      });
      UI.$("btn-pano-zoomin").addEventListener("click",  () => PanoViewer.setFov(-10));
      UI.$("btn-pano-zoomout").addEventListener("click", () => PanoViewer.setFov(10));
      UI.$("btn-pano-reset").addEventListener("click",   () => PanoViewer.resetView());
      // [마스터] 천정 수평 보정 — 기울어진 360 사진을 좌/우로 미세 회전해 수평 맞춤
      UI.$("btn-pano-level-l") && UI.$("btn-pano-level-l").addEventListener("click", () => PanoViewer.adjustRoll(-0.7));
      UI.$("btn-pano-level-r") && UI.$("btn-pano-level-r").addEventListener("click", () => PanoViewer.adjustRoll(0.7));
      // [마스터: 방향 설정 = 도면에서 직접 클릭] 이 버튼은 "지정 완료"를 즉시 선언하지 않는다.
      // 미니맵 클릭 대기 모드(#pano-radar-dir 과 동일 모드, Radar._dirAdjust)로 진입만 시키고,
      // 실제 방향(pin.dirOffset) 저장과 완료 토스트는 사용자가 미니맵을 클릭한 뒤 Radar._commitAngle()에서만 일어난다.
      UI.$("btn-pano-setdir") && UI.$("btn-pano-setdir").addEventListener("click", () => {
        const pin = PanoViewer._currentPin;
        if (!pin) return;
        if (typeof Radar !== "undefined" && Radar.enterDirAdjustMode) Radar.enterDirAdjustMode();
      });
      // [마스터: 구면 마커] 추가 모드 토글
      // [FARO Markers] 마커 버튼 = 종류 선택 칩바 토글 / 칩 클릭 = 그 종류로 추가 모드
      UI.$("btn-pano-spot") && UI.$("btn-pano-spot").addEventListener("click", () => {
        const bar = UI.$("pano-spot-kinds");
        if (!bar) { this.setSpotAddMode(); return; }
        if (this._spotAdd) { this.setSpotAddMode(false); return; }   // 켜져 있으면 끄기
        bar.classList.toggle("hidden");
      });
      document.querySelectorAll("#pano-spot-kinds .psk-chip").forEach((ch) => {
        ch.addEventListener("click", () => {
          this._spotKind = ch.dataset.kind || "defect";
          document.querySelectorAll("#pano-spot-kinds .psk-chip").forEach((x) => x.classList.toggle("on", x === ch));
          this.setSpotAddMode(true);
        });
      });
      // [FARO Markers] 마커 목록(테이블) 패널 토글
      UI.$("btn-pano-spotlist") && UI.$("btn-pano-spotlist").addEventListener("click", () => this.toggleSpotList());
      UI.$("pano-spot-list-close") && UI.$("pano-spot-list-close").addEventListener("click", () => { const p = UI.$("pano-spot-list"); if (p) p.classList.add("hidden"); });
      // ISO 4-꼭지점 뷰 전환
      document.querySelectorAll("#pano-iso-views .pano-iso-btn").forEach((b) => {
        b.addEventListener("click", (e) => {
          const corner = parseInt(e.currentTarget.getAttribute("data-iso"), 10) || 0;
          if (PanoViewer.open && typeof PanoViewer.setIsoView === "function") {
            PanoViewer.setIsoView(corner);
            document.querySelectorAll("#pano-iso-views .pano-iso-btn").forEach((x) => x.classList.remove("active"));
            e.currentTarget.classList.add("active");
          }
        });
      });
      UI.$("btn-pano-full").addEventListener("click", () => {
        const ov = UI.$("pano-overlay");
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else ov.requestFullscreen && ov.requestFullscreen().catch(() => {});
      });

      window.addEventListener("resize", () => {
        if (PanoViewer.open) PanoViewer._resize();
      });

      document.addEventListener("keydown", e => {
        if (e.key === "Escape" && PanoViewer.open) { PanoViewer.close(); return; }
        // 파노라마가 열려 있을 때: ← / → 로 이전/다음 포인트 이동
        if (PanoViewer.open) {
          if (e.key === "ArrowLeft")  { e.preventDefault(); PanoNav.go(-1); }
          else if (e.key === "ArrowRight") { e.preventDefault(); PanoNav.go(1); }
          return;
        }
        // ── [마스터 요청 #5] ESC → 직전 실행 명령 즉시 중지 ──
        //   (배치/영역그리기/핀이동/편집폼/팝업 등 진행 중이면 모두 종료)
        if (e.key === "Escape") {
          const canceled = this.cancelActiveOperation();
          if (canceled) { e.preventDefault(); return; }
          // 취소할 작업이 없으면: ISO 뷰면 평면으로 복귀
          if (State.isoView && typeof MapCtrl !== "undefined") {
            State.isoView = false; State.isoDir = 0; MapCtrl._applyIso(); e.preventDefault(); return;
          }
        }
        const tag = (e.target && e.target.tagName) || "";
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        // 회전 단축키 (Shift+←/→) — 도면이 로드돼 있으면 페이지 수와 무관하게 동작
        const rotGroup = UI.$("rotate-group");
        const canRotate = rotGroup && !rotGroup.classList.contains("hidden");
        if (e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
          if (canRotate) { e.preventDefault(); this._rotatePdf(e.key === "ArrowRight" ? 90 : -90); }
          return;
        }
        if (UI.$("pdf-pagination").classList.contains("hidden")) return;
        if (e.key === "ArrowLeft")      { e.preventDefault(); this._changePage(-1); }
        else if (e.key === "ArrowRight"){ e.preventDefault(); this._changePage(1); }
        else if (e.key === "Home")      { e.preventDefault(); this._gotoPage(1); }
        else if (e.key === "End")       { e.preventDefault(); this._gotoPage(this._totalPages()); }
      });
    },

    /* ── Drawing Load ── */
    /** 드래그 앤 드롭으로 도면 업로드 (디자이너 모드 전용) */
    _bindDragDrop() {
      const zone = UI.$("map-area");
      if (!zone || zone.dataset.dropBound) return;
      zone.dataset.dropBound = "1";
      // 모바일 쉬운 등록: 빈 화면(도면 안내)을 탭하면 바로 파일 선택
      const dropHint = UI.$("drop-hint");
      if (dropHint) {
        dropHint.style.cursor = "pointer";
        dropHint.addEventListener("click", () => {
          if (State.mode !== "designer") return;
          const inp = UI.$("input-drawing"); if (inp) inp.click();
        });
      }
      const accept = (f) => {
        if (!f) return false;
        const n = (f.name || "").toLowerCase();
        return f.type === "application/pdf" || f.type.startsWith("image/") ||
               /\.(pdf|png|jpe?g)$/i.test(n);
      };
      const setOver = (on) => {
        const hint = UI.$("drop-hint");
        if (hint) hint.classList.toggle("dragover", on);
        zone.classList.toggle("drop-active", on);
      };
      ["dragenter", "dragover"].forEach(ev =>
        zone.addEventListener(ev, (e) => {
          if (State.mode !== "designer") return;
          e.preventDefault(); e.stopPropagation();
          if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
          setOver(true);
        })
      );
      ["dragleave", "dragend"].forEach(ev =>
        zone.addEventListener(ev, (e) => {
          e.preventDefault(); e.stopPropagation();
          // 영역을 완전히 벗어났을 때만 해제
          if (ev === "dragleave" && zone.contains(e.relatedTarget)) return;
          setOver(false);
        })
      );
      zone.addEventListener("drop", (e) => {
        e.preventDefault(); e.stopPropagation();
        setOver(false);
        if (State.mode !== "designer") {
          if (typeof Prompt !== "undefined") Prompt.toast("ℹ 도면 업로드는 편집모드에서만 가능합니다.");
          return;
        }
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (!accept(f)) {
          if (typeof Prompt !== "undefined") Prompt.toast("PDF · PNG · JPG 파일만 업로드할 수 있습니다.");
          return;
        }
        this._loadDrawing(f);
      });
    },

    /** [P1] 구역 생성 전용 도면 파일 선택기 — 파일이 확정될 때까지 기다리고, 취소를 감지해 null 을 돌려준다.
     *  전역 #input-drawing 을 재사용하면 그 change 핸들러가 먼저 _loadDrawing 을 호출해
     *  "구역 선행" 가드와 충돌하므로(순서를 뒤집을 수 없음), 이 흐름 전용 일회용 input 을 쓴다.
     *  취소 감지: 표준 'cancel' 이벤트(Chrome 113+/FF 91+/Safari 16.4+) + 창 포커스 복귀 폴백(구형). */
    _pickDrawingFile() {
      return new Promise((resolve) => {
        const inp = document.createElement("input");
        inp.type = "file";
        inp.accept = ".pdf,.png,.jpg,.jpeg";
        inp.style.display = "none";
        let settled = false;
        let hardTimer = null;
        const finish = (f) => {
          if (settled) return;
          settled = true;
          window.removeEventListener("focus", onFocus, true);
          if (hardTimer) { clearTimeout(hardTimer); hardTimer = null; }
          try { inp.remove(); } catch (e) {}
          resolve(f || null);
        };
        const onFocus = () => {
          // 파일창이 닫혀 창이 돌아옴 → 잠시 뒤에도 파일이 없으면 '취소'로 확정
          setTimeout(() => { if (!(inp.files && inp.files.length)) finish(null); }, 1500);
        };
        inp.addEventListener("change", () => finish(inp.files && inp.files[0]));
        inp.addEventListener("cancel", () => finish(null));
        window.addEventListener("focus", onFocus, true);
        document.body.appendChild(inp);
        inp.click();
        // [WO 20260918] 🔴 상한 타임아웃 — 파일창이 아예 안 열리는 환경(헤드리스·일부 모바일
        // 브라우저·권한 거부)에서는 focus 이벤트가 오지 않아 이 Promise 가 영구 미해결됐고,
        // 그 결과 31_Projects.js 의 _creatingDeck 플래그가 영구 true 로 남아 이후 구역 생성이
        // 전부 조용히 무시됐다(지휘자 실제 피해, 새로고침 전까지 복구 불가). 60초 안에 change/
        // cancel/focus 신호가 전혀 없으면 취소로 확정하고 사용자에게 알린다.
        hardTimer = setTimeout(() => {
          if (settled) return;
          Prompt && Prompt.toast && Prompt.toast("파일 선택 창 응답이 없어 취소로 처리했습니다. 다시 시도해주세요.");
          finish(null);
        }, 60000);
      });
    },

    async _loadDrawing(file) {
      // ── [마스터 규칙·권한] 뷰어는 도면을 등록할 수 없다(보기 전용) ──
      //  도면 등록의 모든 진입 경로(버튼/단축키/드래그앤드롭/mnav/시트)는 결국 이 함수로 모이므로,
      //  여기서 한 번에 권한을 강제한다. 설계자 권한 + 디자이너 모드일 때만 통과.
      if (State.mode !== "designer" || (typeof Auth !== "undefined" && !Auth.isDesigner)) {
        Prompt && Prompt.toast && Prompt.toast("뷰어는 도면을 등록할 수 없습니다. 편집모드에서만 가능합니다.");
        return;
      }
      // ── [WO 20260928·마스터 확정] 🔴 도면 등록 = 파일을 올리는 것, 그게 전부 ──
      //  버튼/단축키/드래그앤드롭/시트 등 모든 진입 경로가 이 함수로 수렴하므로 정책도 여기 한 곳에 둔다.
      //  옛 "구역 0개면 도면 로드 차단 + createDeck({askDrawing:false}) 로 구역부터 생성" 게이트를 제거한다 —
      //  그 게이트가 "도면 등록 = 구역 생성" 을 코드에서 한 덩어리로 묶고 있던 근본 원인이었다.
      //  구역이 0개여도 도면은 그냥 로드된다. 구역은 첫 영역 지정 시 생긴다(31_Projects.createDeckFromLoadedDrawing).
      if (typeof Projects !== "undefined" && Projects.currentProject) {
        const decks = Projects.decks || [];
        if (decks.length > 0 && !Projects.currentDeck) {
          if (decks.length === 1) { Projects.currentDeck = decks[0]; if (Projects._renderDecks) Projects._renderDecks(); }
          else {
            Prompt && Prompt.toast && Prompt.toast("도면을 등록할 ‘구역’을 먼저 선택하세요.");
            const db = document.getElementById("decks-block");
            if (db) { db.classList.add("zone-required-flash"); setTimeout(() => db.classList.remove("zone-required-flash"), 1800); }
            return;
          }
        }
      }
      const _isPdf = file.type === "application/pdf" || (file.name || "").toLowerCase().endsWith(".pdf");
      if (typeof Log !== "undefined") Log.push(_isPdf ? "pdf.register" : "drawing.upload", file.name, { type: file.type, size: file.size });
      State.reset();
      State.fileName = file.name;
      UI.text("file-name-label", file.name);
      UI.$("pin-count-badge").classList.add("hidden");
      UI.$("pins-layer").innerHTML = "";
      UI.$("pin-list").innerHTML = "";
      UI.$("pin-empty").classList.remove("hidden");
      this._closePinForm();
      UI.$("section-next-point").classList.add("hidden");
      UI.$("section-export").classList.add("hidden");

      const isPDF = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");

      if (isPDF) {
        State.fileType = "pdf";
        UI.$("drop-hint").classList.add("hidden");
        UI.$("pdf-loading").classList.remove("hidden");
        UI.$("pdf-error").classList.add("hidden");
        UI.$("map-viewport").classList.add("hidden");

        try {
          const ab = await this._readAsArrayBuffer(file);
          State.fileData = ab;
          const pdf = await PDF.load(ab);
          State.pdfDoc  = pdf;
          State.pdfPages = pdf.numPages;
          State.pdfPage  = 1;
          UI.$("pdf-loading").classList.add("hidden");
          UI.$("pdf-canvas").classList.remove("hidden");
          UI.$("map-image").classList.add("hidden");
          await this._renderPdfPage();
          this._showMapViewport();
          this._afterDrawingLoaded();
        } catch (err) {
          UI.$("pdf-loading").classList.add("hidden");
          UI.$("pdf-error").classList.remove("hidden");
          const em = UI.$("pdf-error-msg"); if (em) em.textContent = "PDF 로드 실패: " + err.message;
        }
      } else {
        State.fileType = "image";
        State.imageUrl = URL.createObjectURL(file);
        UI.$("drop-hint").classList.add("hidden");
        UI.$("pdf-loading").classList.add("hidden");
        UI.$("pdf-error").classList.add("hidden");
        UI.$("pdf-canvas").classList.add("hidden");
        UI.$("pdf-pagination").classList.add("hidden");

        const imgEl = UI.$("map-image");
        imgEl.onload = () => { this._showMapViewport(); this._afterDrawingLoaded(); };
        imgEl.onerror = () => {
          UI.$("pdf-error").classList.remove("hidden");
          UI.$("pdf-error-msg").textContent = "이미지 로드 실패";
        };
        imgEl.src = State.imageUrl;
        imgEl.classList.remove("hidden");
      }
    },

    async _renderPdfPage() {
      const canvas = UI.$("pdf-canvas");
      // 핵심(캔버스 래스터화)은 반드시 성공해야 한다 → 여기서 실패하면 상위 catch 로 전달.
      await PDF.renderPage(State.pdfDoc, State.pdfPage, canvas, 1.5, State.pdfRotation);
      State.pan = { x: 0, y: 0 }; State.zoom = 1;
      // 부수 UI 갱신(페이지네이션·핀·썸네일)은 하나가 실패해도 PDF 표시는 유지되도록 개별 격리.
      try { MapCtrl.applyTransform(); } catch (e) { console.warn("applyTransform", e); }
      try { UI.updatePdfPagination(); } catch (e) { console.warn("pagination", e); }
      try { UI.renderPinsOnMap(); } catch (e) { console.warn("pinsOnMap", e); }
      try { UI.renderPinList(); } catch (e) { console.warn("pinList", e); }
      try { UI.renderPdfThumbs(); } catch (e) { console.warn("thumbs", e); }
    },

    _showMapViewport() {
      State.pan  = { x: 0, y: 0 };
      State.zoom = 1;
      MapCtrl.applyTransform();
      UI.$("map-viewport").classList.remove("hidden");
      const nav = UI.$("nav-toolbar"); if (nav) nav.classList.remove("hidden");
      // ezPDF 스타일 상단 도구 툴바 표시 + 마킹 버튼(설계자 전용)
      const tb = UI.$("pdf-toolbar");
      if (tb) tb.classList.remove("hidden");
      const tbMark = UI.$("tb-mark");
      if (tbMark) tbMark.classList.toggle("hidden", State.mode !== "designer");
      if (typeof PdfAnno !== "undefined") PdfAnno.updateToolbar();  // 주석 도구(설계자 전용) 표시
      UI.renderPinsOnMap();
      UI.renderPinList();      // 현재 페이지 핀 목록 갱신
      UI.updatePdfPagination();
      UI.updateRotationLabel();
      UI.renderPdfThumbs();
      // [P0-2 false-dirty 수정] 여기서 dirty 를 세우면 안 된다.
      //   _showMapViewport() 는 '화면 표시' 함수라 ①새 도면 업로드 ②기존 배포본 로드
      //   ③뷰어→편집모드 전환 ④페이지 이동 이 전부 통과한다. 뷰어 딥링크(?d=dep_…)로 열고
      //   편집모드로 전환하기만 해도(사용자 변경 0건) autoSaveDepId 가 비어 있어 '저장 *' 가 켜졌고,
      //   프로젝트·구역 컨텍스트가 없는 그 상태로 저장하면 어느 구역에도 안 붙는 고아 배포본이 생겼다.
      //   → 실제 변경(새 도면 업로드)은 _afterDrawingLoaded() 가, 핀/영역 편집은 _autoSave() 가
      //     각각 dirty 를 세운다. 표시 함수는 상태를 바꾸지 않는다.
    },

    _readAsArrayBuffer(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload  = e => resolve(e.target.result);
        reader.onerror = () => reject(new Error("파일 읽기 실패"));
        reader.readAsArrayBuffer(file);
      });
    },

    /** 신규 사진 포인트 즉시 등록 — 업로드는 백그라운드(오프라인 시 큐잉) */
    async _confirmPinInstant({ label, url, note, file, docs }) {
      // 1) 즉시 로컬 미리보기 blob 생성 + 핀 객체 등록 (대기 없음)
      const localPreview = URL.createObjectURL(file);
      _trackVideoBlob && _trackVideoBlob(localPreview); // blob 누수 추적(공용 추적기 재사용)
      const imgName = UI.val("input-pin-imgname").trim() || file.name.replace(/\.[^.]+$/, "");
      const pin = {
        id: Date.now(),
        x: State.pending.x, y: State.pending.y,
        page: State.pdfPage, label,
        imageName: imgName,
        localPreview,            // 업로드 완료 전까지 즉시 미리보기에 사용
        pendingSync: true,       // 업로드 진행/대기 표시
        uploading: true
      };
      { const _auth1 = this._pinAuthor(); if (_auth1) pin.author = _auth1; } // [WO 20260917 멀티유저 ②]
      if (note) pin.note = note;
      if (url)  { pin.imageUrl = url; if (/\.(mp4|webm|mov)(\?|#|$)/i.test(url)) pin.isVideo = true; }
      // [마스터 요청] 핀(호스팟)별 아이콘 — 선택값을 핀에 보존(기본 number는 저장 생략)
      if (State.pendingIcon && State.pendingIcon !== "number") pin.icon = State.pendingIcon;
      // [마스터 요청] RICOH THETA 360(2:1 equirectangular) 감지 결과를 핀에 보존 → 뷰어가 360으로 표시
      if (State.pendingIs360) pin.is360 = true;
      if (typeof Cloud !== "undefined") { Cloud._cache = Cloud._cache || {}; Cloud._cache["local:" + pin.id] = localPreview; }

      State.pins.push(pin);
      if (typeof Log !== "undefined") Log.push("pin.add", pin.id, { label: pin.label, page: pin.page, instant: true });
      State.activePin = pin.id;
      if (typeof Zones !== "undefined") Zones.refreshPinLinks();

      // 2) 폼 닫고 화면 즉시 반영 (사용자는 곧바로 다음 포인트 가능)
      State.editingPinId = null;
      this._resetPinForm(true);
      UI.renderPinList();
      UI.renderPinsOnMap(pin.id);
      if (typeof PinGrid !== "undefined") PinGrid.render();
      MapCtrl.flyTo(pin.x, pin.y, Math.max(State.zoom, 2.2), 450);
      this._updateSyncBadge();
      Prompt && Prompt.toast && Prompt.toast("'" + label + "' 등록 · " + (navigator.onLine ? "백그라운드 업로드 중" : "오프라인 임시저장"));
      UI.text && UI.text("pin-saved-msg", "'" + label + "' 등록됨 · 업로드는 백그라운드로 진행됩니다");
      UI.show && UI.show("section-next-point");

      // 3) 백그라운드 업로드 (await 하지 않음 → 화면 블로킹 없음)
      this._uploadPinImageBg(pin, file, imgName, docs);
      // [오프라인 작업지시서 ] 즉시등록(instant) 핀도 오프라인이면 OpLog 에 기록 →
      //   재연결 시 ops 엔드포인트로 멱등 replay (기존 instant 경로는 OpLog 누락이었음).
      if (!navigator.onLine && typeof OpLog !== "undefined" && OpLog.recordCurrent) {
        OpLog.recordCurrent("pin", "upsert", pin.id, pin)
          .then(() => { try { return persistLocalDeployment(); } catch (e) {} })
          .catch(() => {});
      }
      this._autoSave && this._autoSave();
    },

    /** 백그라운드 이미지/첨부 업로드 — 완료 시 imageId 치환 + 미리보기 캐시 이관 */
    async _uploadPinImageBg(pin, file, imgName, docs) {
      try {
        const { dataURL, width, height } = await Cloud.resizeImage(file);
        Cloud._cache[("op-preview:" + pin.id)] = dataURL;
        let uploaded = false;
        if (navigator.onLine) {
          try {
            const imageId = await Cloud.uploadImage(imgName, dataURL, width, height);
            pin.imageId = imageId;
            Cloud._cache[imageId] = dataURL;
            uploaded = true;
          } catch (e) { uploaded = false; }
        }
        if (!uploaded) {
          const opId = await SyncQueue.enqueue({ kind: "image", name: imgName, image_data: dataURL, width, height });
          if (opId) { pin.pendingOpId = opId; Cloud._cache["op:" + opId] = dataURL; } // null=저장실패(토스트 안내됨)
        }
        // 첨부 문서(있으면)도 백그라운드 처리
        if (docs && docs.length) {
          if (!Array.isArray(pin.attachments)) pin.attachments = [];
          for (let i = 0; i < docs.length; i++) {
            const d = docs[i];
            try {
              const durl = await Cloud.fileToDataURL(d.file);
              let docOk = false, docId = null;
              if (navigator.onLine) { try { docId = await Cloud.uploadDoc(d.name, durl); docOk = true; } catch (e) {} }
              const att = { id: d.tempId, name: d.name, size: d.size, type: d.kind && d.kind.type };
              if (docOk) att.docId = docId;
              else { const opId = await SyncQueue.enqueue({ kind: "doc", name: d.name, image_data: durl }); if (opId) { att.pendingOpId = opId; att.pendingSync = true; Cloud._cache["op:" + opId] = durl; } }
              pin.attachments.push(att);
            } catch (e) {}
          }
        }
        // 업로드 완료 상태 정리
        pin.uploading = false;
        if (!pin.pendingOpId && !(pin.attachments || []).some(a => a.pendingOpId)) delete pin.pendingSync;
        // 로컬 미리보기 정리(서버 이미지로 대체됨) — 죽은 blob URL 이 서버에 남지 않도록 제거
        if (pin.imageId && pin.localPreview) { try { URL.revokeObjectURL(pin.localPreview); } catch (e) {} delete pin.localPreview; }
        // [핵심 버그 수정] 업로드 완료 후 imageId(또는 pendingOpId)를 서버에 반드시 영속화.
        //   이전: _confirmPinInstant 에서 blob localPreview 만 저장되고, 업로드 성공 후 재저장이
        //         없어 서버에는 죽은 blob URL 만 남았다 → 재접속 시 "이미지를 불러올 수 없습니다".
        //   이제: 업로드 결과(imageId)를 담아 다시 _autoSave 로 서버에 반영한다.
        if (pin.imageId || pin.pendingOpId) {
          try { this._autoSave && this._autoSave(); } catch (e) {}
        }
      } catch (e) {
        pin.uploading = false;
        Prompt && Prompt.toast && Prompt.toast("'" + pin.label + "' 업로드 지연 — 동기화 대기에 보관됨");
      }
      try { UI.renderPinList(); UI.renderPinsOnMap(); if (typeof PinGrid !== "undefined") PinGrid.render(); } catch (e) {}
      this._updateSyncBadge && this._updateSyncBadge();
      this._autoSave && this._autoSave();
    },

    /* ── Pin: 저장 & 업로드 ── */
    async _confirmPin() {
      if (!State.pending) return;
      const label = UI.val("input-pin-label").trim() || `위치 ${State.pins.length + 1}`;
      const url   = UI.val("input-pin-url").trim();
      const note  = UI.val("input-pin-note").trim();
      const file  = State.pendingFile;
      const docs  = State.pendingDocs.slice();

      // ── 편집 모드 판정 ──
      const editing = !!State.editingPinId;
      // ════════════════════════════════════════════════════════════
      // 요청사항: 신규 포인트 + 사진(이미지) 선택 시 → 업로드를 기다리지 않고
      // 즉시 핀을 화면에 등록(로컬 미리보기)하고, 업로드는 백그라운드에서 진행.
      // 오프라인이면 SyncQueue 에 적재되어 인터넷 복구 시 자동 업로드된다.
      // (영상/3D/문서/URL 만 있는 경우엔 기존 동기 경로 사용 — 즉시등록 대상 아님)
      // ════════════════════════════════════════════════════════════
      if (!editing && file && !State.pendingIsVideo) {
        return this._confirmPinInstant({ label, url, note, file, docs });
      }
      const existing = editing ? State.pins.find(p => p.id === State.editingPinId) : null;
      // 신규: 미디어·노트·첨부 중 최소 하나 필요. 편집: 라벨/노트만 바꿔도 저장 허용.
      if (!editing && !file && !url && !note && docs.length === 0) return;

      const btn    = UI.$("btn-confirm-pin");
      const status = UI.$("pin-upload-status");
      const setBtnLabel = (t) => { const l = UI.$("pf-save-label"); if (l) l.textContent = t; else btn.textContent = t; };
      btn.disabled = true;
      setBtnLabel((file || docs.length) ? (navigator.onLine ? "업로드 중..." : "임시 저장 중...") : "저장 중...");

      // 편집이면 기존 객체를 베이스로(기존 미디어 보존), 신규면 새 객체
      const pin = editing && existing
        ? existing // [WO 20260917 멀티유저 ②] 편집은 기존 pin.author 를 건드리지 않는다(편집자≠원작성자)
        : (() => { const _auth2 = this._pinAuthor(); const np = { id: Date.now(), x: State.pending.x, y: State.pending.y, page: State.pdfPage, label }; if (_auth2) np.author = _auth2; return np; })();
      pin.label = label;
      if (note) pin.note = note; else if (editing) delete pin.note;
      // [마스터 요청] 핀(호스팟)별 아이콘 캡처 — number(기본)면 속성 제거(하위호환)
      if (State.pendingIcon && State.pendingIcon !== "number") pin.icon = State.pendingIcon;
      else delete pin.icon;

      try {
        if (file && State.pendingIsVideo) {
          // 360° 영상: 테이블 용량 제한으로 클라우드 저장 불가 → 로컬 blob URL (현재 세션 미리보기)
          status.textContent = "360° 영상 연결 중...";
          status.classList.remove("hidden", "error");
          const vidName = UI.val("input-pin-imgname").trim() || file.name.replace(/\.[^.]+$/, "");
          pin.videoUrl  = URL.createObjectURL(file);
          _trackVideoBlob(pin.videoUrl); // [B5] 누수 추적
          pin.isVideo   = true;
          pin.imageName = vidName;
          pin.localOnly = true; // 배포/새로고침 시 사라짐 안내용
        } else if (file) {
          // 이미지: 1) 리사이즈 → 2) 온라인이면 즉시 업로드 / 오프라인·실패면 로컬 큐잉
          status.textContent = "이미지 최적화 중...";
          status.classList.remove("hidden", "error");
          const { dataURL, width, height } = await Cloud.resizeImage(file);
          const imgName = UI.val("input-pin-imgname").trim() || file.name.replace(/\.[^.]+$/, "");
          pin.imageName = imgName;

          let uploaded = false;
          if (navigator.onLine) {
            try {
              status.textContent = "클라우드 업로드 중... (" + (dataURL.length / 1024 / 1024).toFixed(1) + " MB)";
              const imageId = await Cloud.uploadImage(imgName, dataURL, width, height);
              pin.imageId = imageId;
              Cloud._cache[imageId] = dataURL; // 즉시 미리보기용 캐시
              uploaded = true;
            } catch (e) { uploaded = false; } // 네트워크 단절 등 → 큐로 폴백
          }
          if (!uploaded) {
            // 오프라인/실패: 로컬에 즉시 저장하고 인터넷 복구 시 일괄 업로드
            status.textContent = "오프라인 — 휴대폰에 임시 저장 (인터넷 복구 시 자동 업로드)";
            const opId = await SyncQueue.enqueue({
              kind: "image", name: imgName, image_data: dataURL, width, height
            });
            if (opId) {                   // null=저장실패(공간부족, 토스트 안내됨)
              pin.pendingOpId = opId;     // 동기화 완료 시 imageId 로 치환
              pin.pendingSync = true;     // 미동기화 표시
              Cloud._cache["op:" + opId] = dataURL; // 미동기화 미리보기 캐시
            } else { status.textContent = "저장공간 부족 — 사진을 임시저장하지 못했습니다"; }
          }
        } else if (url) {
          // URL 직접 입력 (이미지 또는 영상 자동 판별)
          pin.imageUrl = url;
          if (/\.(mp4|webm|mov)(\?|#|$)/i.test(url)) pin.isVideo = true;
        }

        // ── 첨부 문서 업로드 (PDF/Word 등) — 오프라인 우선 ──
        if (docs.length) {
          if (!Array.isArray(pin.attachments)) pin.attachments = [];
          for (let i = 0; i < docs.length; i++) {
            const d = docs[i];
            const dataURL = await Cloud.fileToDataURL(d.file);
            let docOk = false, docId = null;
            if (navigator.onLine) {
              try {
                status.textContent = `첨부 업로드 중... (${i + 1}/${docs.length}) ${d.name}`;
                status.classList.remove("hidden", "error");
                docId = await Cloud.uploadDoc(d.name, dataURL);
                docOk = true;
              } catch (e) { docOk = false; }
            }
            const att = { id: d.tempId, name: d.name, size: d.size, type: d.kind.type };
            if (docOk) { att.docId = docId; }
            else {
              // 오프라인 큐잉
              const opId = await SyncQueue.enqueue({ kind: "doc", name: d.name, image_data: dataURL });
              if (opId) {                 // null=저장실패(공간부족, 토스트 안내됨)
                att.pendingOpId = opId; att.pendingSync = true;
                Cloud._cache["op:" + opId] = dataURL;
                pin.pendingSync = true;
              }
            }
            pin.attachments.push(att);
          }
        }

        // ── 3D 포인트 클라우드(FLS/E57/LAS/PLY) 연결 ──
        // 현 세션에선 로컬 캐시(Cloud._cache['fls:'+id])로 즉시 표출.
        // 용량이 큰 3D 원본은 D1에 통째로 넣지 않고 메타만 보관(배포 후 URL 연결 권장).
        if (State.pendingFls) {
          pin.flsLocalId = State.pendingFls.localId;
          pin.flsName    = State.pendingFls.name;
          pin.flsSize    = State.pendingFls.size;
          pin.has3D      = true;
        }
      } catch (e) {
        status.textContent = "업로드 실패: " + e.message;
        status.classList.add("error");
        status.classList.remove("hidden");
        btn.disabled = false;
        setBtnLabel("저장하기");
        return;
      }

      if (!editing) State.pins.push(pin);   // 편집 시 기존 객체를 그대로 갱신했으므로 push 안 함
      if (typeof Log !== "undefined") Log.push(editing ? "pin.edit" : "pin.add", pin.id, { label: pin.label, page: pin.page });
      State.activePin = pin.id;
      if (typeof Zones !== "undefined") Zones.refreshPinLinks(); // 영역-핀 연결 갱신
      const wasEditing = editing;
      State.editingPinId = null;
      this._resetPinForm(true);
      setBtnLabel("저장하기");
      this._updateSyncBadge();

      UI.renderPinList();
      UI.renderPinsOnMap(wasEditing ? null : pin.id); // 신규만 드롭 애니메이션
      MapCtrl.flyTo(pin.x, pin.y, Math.max(State.zoom, 2.2), 500);
      // [오프라인 작업지시서 ] 오프라인이면 엔티티 op 기록 + 로컬 스냅샷(온라인은 _autoSave 경로 유지)
      if (!navigator.onLine && typeof OpLog !== "undefined") {
        try { await OpLog.recordCurrent("pin", "upsert", pin.id, pin); await persistLocalDeployment(); } catch (e) {}
      }
      this._autoSave(); // 버튼 없이 즉시 서버 저장

      // 편집 완료면 별도 안내만, 신규면 다음 포인트 연속 배치 안내
      if (wasEditing) {
        State.pinEditUnlocked = null; // 수정 완료 → 다시 잠금
        Prompt.toast("'" + label + "' 수정 완료 · 자동저장");
        return;
      }
      let savedNote = (pin.pendingSync ? "'" : "'") + label + (pin.pendingSync ? "' 임시 저장 (오프라인)" : "' 저장 완료");
      const tags = [];
      if (pin.imageId)        tags.push("360° 그림");
      else if (pin.pendingOpId) tags.push("360° 그림(대기)");
      else if (pin.isVideo && pin.videoUrl) tags.push("영상(로컬)");
      else if (pin.isVideo)   tags.push("360° 영상");
      else if (pin.imageUrl)  tags.push("URL");
      if (pin.note)           tags.push("노트");
      if (pin.has3D)          tags.push("3D 클라우드");
      if (pin.attachments && pin.attachments.length) tags.push("첨부 " + pin.attachments.length);
      if (tags.length) savedNote += " (" + tags.join(" · ") + ")";
      UI.text("pin-saved-msg", savedNote);
      UI.show("section-next-point");
    },

    /** 동기화 완료 콜백 — 큐 op id → 서버 imageId/docId 로 치환 후 화면 갱신 */
    _onSyncDone(result) {
      const map = (result && result.map) || {};
      let changed = false;
      State.pins.forEach(pin => {
        if (pin.pendingOpId && map[pin.pendingOpId]) {
          pin.imageId = map[pin.pendingOpId];
          // 미리보기 캐시 키 이관
          const cached = Cloud._cache["op:" + pin.pendingOpId];
          if (cached) Cloud._cache[pin.imageId] = cached;
          delete pin.pendingOpId; changed = true;
        }
        if (pin.attachments) {
          pin.attachments.forEach(att => {
            if (att.pendingOpId && map[att.pendingOpId]) {
              att.docId = map[att.pendingOpId];
              const c = Cloud._cache["op:" + att.pendingOpId];
              if (c) Cloud._cache[att.docId] = c;
              delete att.pendingOpId; delete att.pendingSync; changed = true;
            }
          });
        }
        // 모든 대기 항목이 해소되면 pendingSync 해제
        if (pin.pendingSync && !pin.pendingOpId &&
            !(pin.attachments || []).some(a => a.pendingOpId)) {
          delete pin.pendingSync; changed = true;
        }
      });
      if (changed) {
        try { UI.renderPinList(); UI.renderPinsOnMap(); } catch (e) {}
        // [버그수정] imageId/docId 스왑을 서버·로컬에 영속화 — 안 하면 탭 닫을 때 서버엔 죽은 pendingOpId만 남아 사진 영구손실
        try { this._autoSave && this._autoSave(); } catch (e) {}
      }
      this._updateSyncBadge();
    },

    /** 동기화 상태 배지 갱신 */
    _updateSyncBadge() {
      const badge = UI.$("sync-badge");
      if (!badge) return;
      // [오프라인 노트] 이미지/문서 큐(SyncQueue) + 핀/구역/주석/노트 OpLog 대기분을 합산(SoT — 별도 배지 금지)
      const opLogCount = (async () => {
        try {
          const depId = (typeof Offline !== "undefined" && Offline.curDepId) ? Offline.curDepId() : null;
          if (depId && typeof OpLog !== "undefined") return (await OpLog.pending(depId)).length;
        } catch (e) {}
        return 0;
      })();
      // [마스터 요청 2026-09-18] 오프라인일 때 "오프라인 모드"(번들 다운로드됨) vs
      //   "작업 불가"(번들 없음)를 구분 — 같은 배지(SoT), 새 배지 신설 금지.
      const bundleCheck = (async () => {
        try {
          if (navigator.onLine) return true; // 온라인이면 판정 불필요(분기에서 안 쓰임)
          const pid = (typeof Projects !== "undefined" && Projects.currentProject && Projects.currentProject.id) || null;
          if (!pid) return false;
          if (typeof Offline !== "undefined" && Offline.Bundle && Offline.Bundle.hasManifest) return await Offline.Bundle.hasManifest(pid);
        } catch (e) {}
        return false;
      })();
      Promise.all([SyncQueue.count(), opLogCount, bundleCheck]).then(([sqN, opN, hasBundle]) => {
        const n = sqN + opN;
        const dot = UI.$("sync-dot"), txt = UI.$("sync-text");
        const online = navigator.onLine;
        if (!online && n === 0) {
          badge.classList.remove("hidden", "online", "pending");
          badge.classList.add("offline");
          // 번들(프로젝트 다운로드분)이 로컬에 있으면 "오프라인 모드"로 열람/작업 가능,
          // 없으면 표시할 데이터가 없어 작업 불가 — 서로 다른 상태이므로 문구를 분리한다.
          if (txt) txt.textContent = hasBundle ? "오프라인 모드" : "오프라인 — 작업 불가(다운로드 필요)";
          badge.classList.toggle("offline-blocked", !hasBundle);
        } else if (n > 0) {
          badge.classList.remove("hidden", "online", "offline");
          badge.classList.add("pending");
          // [마스터: 수동 반영] 온라인+대기 → "지금 올리기" 버튼임을 명확히(클릭 시 syncNow)
          if (txt) txt.textContent = (online ? "↑ 지금 올리기 " : "오프라인 저장 ") + n;
        } else {
          // 온라인 + 대기 0 → 잠시 표시 후 숨김
          badge.classList.remove("offline", "pending");
          badge.classList.add("online");
          if (txt) txt.textContent = "동기화됨";
          // 디자이너 모드에서만 굳이 항상 표시할 필요는 없으나, 일관성 위해 유지
        }
        // [WO 20260918] 🔴 "업로드 버튼이 안 보인다" — 위 #sync-badge(topbar)는 대기=0(온라인)일
        // 때 hidden 클래스가 그대로 남아 화면에서 완전히 사라진다(데스크톱 기존 동작 — 이번
        // 요구는 데스크톱 불변이 조건이라 그대로 둔다). 모바일은 하단 독(.mobile-dock)의
        // #mdock-upload 칩을 항상 보이게 하고, 대기 건수로만 활성/비활성을 가른다.
        const mUp = UI.$("mdock-upload");
        if (mUp) {
          mUp.disabled = (n === 0);
          const label = UI.$("mdock-upload-label");
          if (label) label.textContent = n > 0 ? ("업로드 " + n) : "업로드";
          mUp.setAttribute("title", n > 0 ? ("대기 " + n + "건 — 눌러서 지금 업로드") : "업로드할 내용이 없습니다");
        }
      });
    },

    /** [마스터: 수동 반영] 지금 즉시 "전체" 동기화 — op 큐(SyncQueue.flush) + 도면 draft
     *  (_flushDirtyDrafts) + OpLog(_flushOpLogs)까지 한 번에 서버 반영. 사용자가 직접 누름. */
    async syncNow() {
      if (this._syncingNow) return;
      if (!navigator.onLine) {
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("오프라인입니다 — 인터넷 연결 후 다시 눌러주세요. (작업은 안전하게 보관 중)");
        return;
      }
      this._syncingNow = true;
      const badge = UI.$("sync-badge"), txt = UI.$("sync-text");
      if (badge) badge.classList.add("syncing");
      if (txt) txt.textContent = "올리는 중…";
      // [WO 20260918] 모바일 독 업로드 칩도 같은 진행 상태를 보여준다(SoT — 새 표시 로직 추가 금지).
      const mUp = UI.$("mdock-upload"), mUpLabel = UI.$("mdock-upload-label");
      if (mUp) mUp.disabled = true;
      if (mUpLabel) mUpLabel.textContent = "올리는 중…";
      // [토스트 스팸 제거] sync-badge 가 이미 "올리는 중…" 을 표시한다. 완료/실패 토스트는 아래 유지.
      let uploaded = 0;
      try {
        const r = await SyncQueue.flush();
        if (r && r.map) this._onSyncDone(r);
        if (r && typeof r.uploaded === "number") uploaded += r.uploaded;
        if (this._flushDirtyDrafts) { try { await this._flushDirtyDrafts(); } catch (e) {} }
        if (this._flushOpLogs) { try { await this._flushOpLogs(); } catch (e) {} }
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("업로드 완료 — 대기 작업 " + uploaded + "건 서버 반영");
      } catch (e) {
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("업로드 일부 실패 — 잠시 후 다시 시도하세요. (작업은 보관됨)");
      } finally {
        this._syncingNow = false;
        if (badge) badge.classList.remove("syncing");
        this._updateSyncBadge(); // mdock-upload 의 disabled/라벨도 여기서 최신 대기건수로 재계산됨
      }
    },

    /* ── [마스터: 구면 안 마커] 360 사진 속 결함/장비 지점 핀 ── */
    setSpotAddMode(on) {
      this._spotAdd = (on == null) ? !this._spotAdd : !!on;
      if (typeof PanoViewer !== "undefined" && PanoViewer.setSpotAddMode) PanoViewer.setSpotAddMode(this._spotAdd);
      const btn = UI.$("btn-pano-spot"); if (btn) btn.classList.toggle("on", this._spotAdd);
      const bar = UI.$("pano-spot-kinds");
      if (!this._spotAdd) {   // 끌 때 칩바·선택 표시 정리
        if (bar) bar.classList.add("hidden");
        document.querySelectorAll("#pano-spot-kinds .psk-chip").forEach((x) => x.classList.remove("on"));
      } else if (bar) bar.classList.add("hidden");   // 켜지면 칩바 닫고 추가 대기
      if (this._spotAdd && typeof Prompt !== "undefined" && Prompt.toast) {
        const kn = { defect: "결함", equip: "장비", safety: "안전", note: "메모" }[this._spotKind || "defect"] || "마커";
        Prompt.toast("" + kn + " 마커 — 360 안에서 지점을 탭하세요");
      }
      return this._spotAdd;
    },
    _onPanoTap(x, y) {
      const pin = (typeof PanoViewer !== "undefined") ? PanoViewer._currentPin : null;
      if (!pin || !PanoViewer.open) return;
      if (this._spotAdd) {
        const ll = PanoViewer.screenToLonLat(x, y); if (!ll) return;
        this._addSpotAt(pin, ll.lon, ll.lat);
      } else {
        const id = PanoViewer.hitSpotAt(x, y);
        if (id) this._openSpot(pin, id);
      }
    },
    async _addSpotAt(pin, lon, lat) {
      if (!Array.isArray(pin.spots)) pin.spots = [];
      const kind = this._spotKind || "defect";
      const kn = { defect: "결함", equip: "장비", safety: "안전", note: "메모" }[kind] || "마커";
      let label = "", note = "";
      if (typeof Prompt !== "undefined" && Prompt.ask) {
        // [FARO Markers] 종류별 마커 + 이름/상세 노트
        const r = await Prompt.ask({
          title: kn + " 마커 추가",
          sub: "이 지점의 이름과 상세 노트를 입력하세요",
          placeholder: "이름 (예: 3번 밸브 · 용접부 균열)",
          second: "상세 노트 (선택)"
        });
        if (r == null) return;   // 취소
        label = String((r && r.value) || "").trim();
        note  = String((r && r.second) || "").trim();
      }
      const spot = { id: "sp-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), lon, lat, label, note, kind: kind, ts: Date.now() };
      pin.spots.push(spot);
      PanoViewer.renderSpots(pin.spots);
      this._saveSpots(pin);
      if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("노트 추가 — " + (label || "무제"));
    },
    async _openSpot(pin, id) {
      const s = (pin.spots || []).find((x) => x.id === id); if (!s) return;
      if (typeof Prompt === "undefined" || !Prompt.ask) return;
      // [마스터] 클릭 시 노트 보기/편집 — 이름·노트 모두 비우고 확인하면 삭제
      const r = await Prompt.ask({
        title: "360° 노트",
        sub: "내용을 수정하세요 · 이름과 노트를 모두 비우고 확인하면 삭제됩니다",
        placeholder: "이름",
        value: s.label || "",
        second: "상세 노트",
        secondValue: s.note || "",
        allowEmpty: true
      });
      if (r == null) return;
      const label = String((r.value) || "").trim();
      const note  = String((r.second) || "").trim();
      if (!label && !note) {
        pin.spots = (pin.spots || []).filter((x) => x.id !== id);
        PanoViewer.renderSpots(pin.spots);
        this._saveSpots(pin);
        if (Prompt.toast) Prompt.toast("노트 삭제됨");
        return;
      }
      s.label = label; s.note = note;
      PanoViewer.renderSpots(pin.spots);
      this._saveSpots(pin);
      if (Prompt.toast) Prompt.toast("노트 저장됨");
    },
    _saveSpots(pin) {
      try { if (!navigator.onLine && typeof OpLog !== "undefined" && OpLog.recordCurrent) OpLog.recordCurrent("pin", "upsert", pin.id, pin); } catch (e) {}
      try { this._autoSave && this._autoSave(); } catch (e) {}
      const p = UI.$("pano-spot-list"); if (p && !p.classList.contains("hidden")) this.renderSpotList();
    },
    /** [마스터: 마커 드래그] 놓았을 때 1회 호출 — moveSpot()이 이미 갱신한 lon/lat을 저장 확정 */
    _finalizeSpotDrag(id) {
      const pin = (typeof PanoViewer !== "undefined") ? PanoViewer._currentPin : null;
      if (!pin) return;
      this._saveSpots(pin);
      if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("마커 위치 저장됨");
    },
    /* ── [FARO Markers] 마커 위 마우스오버 → 내용 툴팁 ── */
    _panoHover(x, y) {
      if (typeof PanoViewer === "undefined" || !PanoViewer.open) return;
      if (PanoViewer.S && (PanoViewer.S.dragging || PanoViewer._dragSpotId)) { this._hideSpotTip(); return; }
      const pin = PanoViewer._currentPin;
      const id = (pin && PanoViewer.hitSpotAt) ? PanoViewer.hitSpotAt(x, y) : null;
      const canvas = UI.$("pano-canvas");
      const s = id ? (pin.spots || []).find((sp) => sp.id === id) : null;
      if (!s) { this._hideSpotTip(); if (canvas) canvas.style.cursor = ""; return; }
      if (canvas) canvas.style.cursor = "pointer";
      const tip = UI.$("pano-spot-tip"); if (!tip) return;
      const KN = { defect: "결함", equip: "장비", safety: "안전", note: "메모" };
      const COL = { defect: "#e0503e", equip: "#e0b14a", safety: "#f2820a", note: "#3a97dd" };
      const col = COL[s.kind] || "#e0503e";
      tip.innerHTML = '<div class="pst-kind"><span class="psk-dot" style="background:' + col + '"></span>' +
        UI.escapeHtml(s.label || (KN[s.kind] || "마커")) + '</div>' +
        (s.note ? '<div class="pst-note">' + UI.escapeHtml(s.note) + '</div>' : '');
      tip.style.left = "0px"; tip.style.top = "0px"; tip.classList.remove("hidden");
      const tw = tip.offsetWidth, th = tip.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
      let lx = x + 14, ty = y + 14;
      if (lx + tw > vw - 8) lx = x - tw - 14;
      if (ty + th > vh - 8) ty = y - th - 14;
      tip.style.left = lx + "px"; tip.style.top = ty + "px";
    },
    _hideSpotTip() { const t = UI.$("pano-spot-tip"); if (t) t.classList.add("hidden"); },
    /* ── [FARO Markers] 마커 리스트(테이블) — 행 클릭 시 그 마커로 시점 이동 ── */
    toggleSpotList() {
      const p = UI.$("pano-spot-list"); if (!p) return;
      if (p.classList.contains("hidden")) { this.renderSpotList(); p.classList.remove("hidden"); }
      else p.classList.add("hidden");
    },
    /** [P23: 마커목록 사진별] 현재 사진의 마커만 보여주되(①), 다른 사진의 마커도 그룹으로 함께
     *  나열해 클릭 시 그 사진으로 이동(②)하고, 사진별로 정렬(③)한다.
     *  그룹/이동 판단은 PanoViewer.buildSpotGroups/spotRowAction(순수 함수, 06_PanoViewer.js)에 위임하고
     *  이 함수는 렌더 + 배선만 담당(뷰어·디자이너 공통, 새 CSS 없이 기존 psl-* 재사용 + 인라인 스타일). */
    renderSpotList() {
      const body = UI.$("pano-spot-list-body"); if (!body) return;
      const pin = (typeof PanoViewer !== "undefined") ? PanoViewer._currentPin : null;
      if (!pin || typeof PanoViewer.buildSpotGroups !== "function") {
        body.innerHTML = '<div class="psl-empty">등록된 마커가 없습니다.<br>‘마커’ 버튼으로 360 안에 추가하세요.</div>';
        return;
      }
      const groups = PanoViewer.buildSpotGroups(State.pins || [], pin);
      if (!groups.length) {
        body.innerHTML = '<div class="psl-empty">등록된 마커가 없습니다.<br>‘마커’ 버튼으로 360 안에 추가하세요.</div>';
        return;
      }
      const KN = { defect: "결함", equip: "장비", safety: "안전", note: "메모" };
      const COL = { defect: "#e0503e", equip: "#e0b14a", safety: "#f2820a", note: "#3a97dd" };
      const HEAD_STYLE = "padding:8px 10px;font-size:11px;font-weight:700;color:#f0b941;background:rgba(255,255,255,.04);border-bottom:1px solid rgba(255,255,255,.1);";
      const EMPTY_STYLE = "padding:14px 10px;text-align:center;color:#9aa6b2;font-size:12px;";
      let rows = "";
      groups.forEach((g) => {
        const label = UI.escapeHtml((g.pin && (g.pin.label || g.pin.id)) || "-");
        const headText = (g.isCurrent ? "현재 사진 · " : "") + label;
        rows += '<tr><td colspan="4" style="' + HEAD_STYLE + '">' + headText + '</td></tr>';
        if (!g.spots.length) {
          rows += '<tr><td colspan="4" style="' + EMPTY_STYLE + '">등록된 마커가 없습니다.</td></tr>';
          return;
        }
        g.spots.forEach((s, i) => {
          const col = COL[s.kind] || "#e0503e";
          rows += '<tr class="psl-row" data-pin="' + g.pin.id + '" data-id="' + s.id + '">' +
            '<td><span class="psl-num" style="background:' + col + '">' + (i + 1) + '</span></td>' +
            '<td>' + (KN[s.kind] || "마커") + '</td>' +
            '<td>' + UI.escapeHtml(s.label || "-") + '</td>' +
            '<td>' + UI.escapeHtml(s.note || "") + '</td></tr>';
        });
      });
      body.innerHTML = '<table class="psl-table"><thead><tr><th>#</th><th>종류</th><th>이름</th><th>노트</th></tr></thead><tbody>' + rows + '</tbody></table>';
      body.querySelectorAll(".psl-row").forEach((r) => {
        r.addEventListener("click", () => {
          const g = groups.find((gr) => gr.pin && gr.pin.id === r.dataset.pin);
          const s = g && g.spots.find((x) => x.id === r.dataset.id);
          if (!g || !s || !PanoViewer.spotRowAction) return;
          const a = PanoViewer.spotRowAction(g, s);
          if (!a) return;
          if (a.type === "look") { if (PanoViewer.lookAtSpot) PanoViewer.lookAtSpot(a.lon, a.lat); }
          else if (a.type === "openPano") { this.openPano(a.pin); }
        });
      });
    },

    setActivePin(id) {
      State.activePin = State.activePin === id ? null : id;
      UI.renderPinList();
      UI.renderPinsOnMap();
    },

    /** [WO 20260917-pin ISO 제거] 핀 선택 → 해당 구역(zone)만큼 "평면" 확대 포커스.
     *  구역이 없으면 핀 주변 영역으로 확대. 이후 사용자는 휠/버튼으로 자유 확대·축소.
     *  뷰어·디자이너 공통. 함수명(focusPinIso)은 호출부 호환을 위해 유지하지만
     *  ISO 자동 전환은 하지 않는다("화면이 한참 아래로 내려간다" 마스터 지시로 제거). */
    focusPinIso(pin) {
      if (!pin) return;
      State.activePin = pin.id;
      const page = pin.page || 1;
      const zones = (State.zones || []).filter(z => (z.page || 1) === page);
      // 1순위: 이 핀이 연결된 구역, 2순위: 핀 좌표를 포함하는 구역
      let zone = zones.find(z => (z.pinIds || []).includes(pin.id));
      if (!zone && typeof Zones !== "undefined" && Zones._contains)
        zone = zones.find(z => Zones._contains(z, pin.x, pin.y));
      let bbox;
      if (zone) {
        bbox = { x: zone.x, y: zone.y, w: zone.w, h: zone.h };
      } else {
        // 구역 미지정 핀 → 핀 주변 가상 영역(±16%)으로 확대
        const R = 16;
        const x = Math.max(0, pin.x - R), y = Math.max(0, pin.y - R);
        bbox = { x, y, w: Math.min(R * 2, 100 - x), h: Math.min(R * 2, 100 - y) };
      }
      UI.renderPinList();
      UI.renderPinsOnMap();
      // [WO 20260917-pin ISO 제거] 핀 탭은 항상 평면으로 확대한다(강제 ISO 전환 금지 — 마스터 지시).
      //   되돌리려면 아래 주석 해제(16_Zones.js:397 와 동일 패턴):
      //   MapCtrl.focusZoneIso(bbox); return;
      if (MapCtrl.fitZone) MapCtrl.fitZone(bbox);
      // [토스트 스팸 제거] 핀 탭마다(2-tap 1단계) 발화해 가장 많이 쌓이던 토스트.
      // 확대 애니메이션 자체가 결과를 보여준다.
    },

    /** 핀 탭 디스패처(뷰어·디자이너 공통, 2-tap):
     *  ① 첫 탭(미포커스) → 평면 확대(ISO 자동전환 없음 — 마스터 지시)
     *  ② 같은 핀 둘째 탭(포커스 상태) → 콘텐츠(360°/정보) 열기
     *  [WO 20260917-pin] "focused" 판정에서 State.isoView 조건을 제거 — 이전에는 ISO 가
     *  자동으로 켜져야만 focused 가 성립했으나, 이제 ISO 를 켜지 않으므로 activePin 일치만으로 판정. */
    onPinTap(pin) {
      if (!pin) return;
      const focused = State.activePin === pin.id;
      if (!focused) { this.focusPinIso(pin); return; }
      if (this.pinHasContent(pin)) this.openPano(pin);
      else if (State.mode === "designer" && typeof PinActionPop !== "undefined") PinActionPop.open(pin.id);
      else this.openPano(pin); // 뷰어: 미디어 없으면 openPano 가 안내 표시
    },

    /** 핀 리스트 클릭 → 해당 페이지로 전환 + 플라이투 (+뷰어는 파노라마 오픈) */
    async focusPin(pin, openAfter) {
      State.activePin = pin.id;
      const targetPage = pin.page || 1;
      if (targetPage !== State.pdfPage) {
        State.pdfPage = targetPage;
        if (State.mode === "viewer" && State.viewerPages) {
          const imgEl = UI.$("map-image");
          // [버그수정 BUG5] onerror도 resolve — 이미지 로드 실패 시 Promise 미해결로 focusPin 영구 행 방지
          await new Promise(res => { imgEl.onload = res; imgEl.onerror = res; imgEl.src = Auth.r2(State.viewerPages[targetPage - 1]); });
          UI.updatePdfPagination();
          UI.renderPinsOnMap();
        } else if (State.pdfDoc) {
          await this._renderPdfPage();
        }
      }
      UI.renderPinList();
      UI.renderPinsOnMap();
      MapCtrl.flyTo(pin.x, pin.y, Math.max(State.zoom, 2.2));
      // flyTo 와 동시에 360° 로딩을 시작(병렬)해 체감 속도를 높인다. (지연 최소화)
      if (openAfter) setTimeout(() => this.openPano(pin), 250);
    },

    async deletePin(id) {
      const removed = State.pins.find(p => p.id === id);
      if (!removed) return false;
      if (!await Prompt.confirm("포인트 삭제", `'${removed.label}' 포인트를 삭제할까요?\n(첨부된 사진·노트·문서 정보도 함께 제거됩니다)`)) return false;
      if (removed.videoUrl) _revokeVideoBlob(removed.videoUrl); // [B5] 삭제 시 즉시 해제
      State.pins = State.pins.filter(p => p.id !== id);
      if (State.activePin === id) State.activePin = null;
      if (State.editingPinId === id) { State.editingPinId = null; this._closePinForm(); }
      if (typeof Zones !== "undefined" && Zones.refreshPinLinks) Zones.refreshPinLinks();
      UI.renderPinList();
      UI.renderPinsOnMap();
      Prompt.toast("'" + removed.label + "' 삭제됨");
      // [오프라인 작업지시서 ] 오프라인이면 삭제 op 기록 + 로컬 스냅샷
      if (!navigator.onLine && typeof OpLog !== "undefined") {
        OpLog.recordCurrent("pin", "delete", id).then(() => persistLocalDeployment()).catch(() => {});
      }
      this._autoSave();
      return true;
    },

    /** 기존 포인트 편집 — 플로팅 폼을 기존 값으로 채워 연다 */
    editPin(id) {
      const pin = State.pins.find(p => p.id === id);
      if (pin == null) return;
      // 다른 모드 정리
      if (State.placing) this._togglePlacing();
      State.editingPinId = id;
      State.pending = { x: pin.x, y: pin.y };   // 좌표 보존
      State.pendingFile = null; State.pendingIsVideo = false; State.pendingDocs = [];
      // [마스터 요청] 기존 핀 아이콘을 선택 상태로 로드(없으면 기본 number)
      State.pendingIcon = pin.icon || "number";
      // 폼 필드 채우기
      UI.$("input-pin-label").value = pin.label || "";
      UI.$("input-pin-note").value = pin.note || "";
      UI.$("input-pin-url").value = pin.imageUrl || "";
      UI.$("input-pin-imgname").value = pin.imageName || "";
      // 노트/URL 있으면 펼쳐서 보여줌
      const showField = (fid, btnId, on) => {
        const f = UI.$(fid), b = UI.$(btnId);
        if (f) f.classList.toggle("hidden", !on);
        if (b) b.classList.toggle("active", on);
      };
      showField("field-pin-note", "btn-pin-note-toggle", !!pin.note);
      showField("field-pin-url",  "btn-pin-url-toggle",  !!pin.imageUrl);
      // 기존 첨부/미디어 요약 표시
      const info = UI.$("pin-file-info");
      const summ = [];
      if (pin.imageId || pin.pendingOpId) summ.push("360° 사진 등록됨");
      else if (pin.isVideo) summ.push("360° 영상 등록됨");
      if (pin.attachments && pin.attachments.length) summ.push("첨부 " + pin.attachments.length + "개");
      if (summ.length) { info.textContent = "현재: " + summ.join(" · ") + " (새 파일 선택 시 교체)"; info.classList.remove("hidden"); }
      else { info.textContent = ""; info.classList.add("hidden"); }
      UI.disable("btn-confirm-pin"); UI.$("btn-confirm-pin").disabled = false; // 편집은 항상 저장 가능
      // 화면 이동 + 폼 열기
      State.activePin = id;
      UI.renderPinList(); UI.renderPinsOnMap();
      MapCtrl.flyTo(pin.x, pin.y, Math.max(State.zoom, 2.2));
      this._openPinForm({ editing: true });
      setTimeout(() => UI.$("input-pin-label").focus(), 120);
    },

    /** 핀에 360° 미디어(클라우드 이미지/로컬 영상/외부 URL/미동기화 로컬)가 등록되어 있는가 */
    pinHasMedia(pin) {
      return !!(pin && (pin.imageId || pin.videoUrl || pin.imageUrl || pin.pendingOpId || pin.localPreview));
    },

    /** 핀에 노트/첨부/3D 포인트클라우드가 있는가 */
    pinHasInfo(pin) {
      return !!(pin && (pin.note || (pin.attachments && pin.attachments.length) || pin.has3D || pin.flsLocalId || pin.flsUrl));
    },

    /** 핀에 클릭 시 보여줄 콘텐츠(미디어 또는 정보)가 있는가 */
    pinHasContent(pin) {
      return this.pinHasMedia(pin) || this.pinHasInfo(pin);
    },

    /** 360° 오버레이 안에 노트/첨부 정보 패널 렌더 */
    _renderPanoInfoPanel(pin) {
      const panel = document.getElementById("pano-info-panel");
      if (!panel) return;
      if (!this.pinHasInfo(pin)) { panel.classList.add("hidden"); panel.innerHTML = ""; return; }

      const dlIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
      let html = `
        <div class="pano-info-title">
          <span>${UI.escapeHtml(pin.label)}</span>
          <button class="pano-info-close" id="pano-info-close" title="닫기" aria-label="닫기">✕</button>
        </div>`;
      if (pin.note) html += `<div class="pano-note-text">${UI.escapeHtml(pin.note)}</div>`;
      if (pin.attachments && pin.attachments.length) {
        html += `<div class="pano-attach-head">첨부 문서 ${pin.attachments.length}</div>`;
        pin.attachments.forEach((a, i) => {
          const k = docKind(a.type || a.name);
          html += `
            <div class="pano-attach-item" data-attach-idx="${i}" title="클릭하여 열기/다운로드">
              <span class="pin-doc-badge" style="background:${k.color}">${k.label}</span>
              <span class="pano-attach-name">${UI.escapeHtml(a.name)}</span>
              <span class="pano-attach-dl">${dlIcon}</span>
            </div>`;
        });
      }
      panel.innerHTML = html;
      panel.classList.remove("hidden");
      const closeBtn = document.getElementById("pano-info-close");
      if (closeBtn) closeBtn.addEventListener("click", () => panel.classList.add("hidden"));
      panel.querySelectorAll(".pano-attach-item").forEach(el => {
        el.addEventListener("click", () => {
          const idx = parseInt(el.dataset.attachIdx, 10);
          this._openAttachment(pin.attachments[idx], el);
        });
      });
    },

    /** 첨부 문서 열기/다운로드 */
    async _openAttachment(att, el) {
      if (!att || !att.docId) return;
      const nameEl = el ? el.querySelector(".pano-attach-name") : null;
      const orig = nameEl ? nameEl.textContent : "";
      if (nameEl) nameEl.textContent = "불러오는 중...";
      try {
        const dataURL = await Cloud.fetchDoc(att.docId);
        // dataURL → Blob → 다운로드 (브라우저가 처리할 수 없는 형식도 안전하게 저장)
        const blob = await (await fetch(dataURL)).blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = att.name || "attachment";
        document.body.appendChild(a);
        a.click();
        a.remove();
        // PDF/이미지는 새 탭 미리보기도 함께 제공
        if (/pdf|img|image/.test(att.type || "") || /\.pdf$|\.(png|jpe?g|gif|webp)$/i.test(att.name || "")) {
          window.open(blobUrl, "_blank");
        }
        setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
      } catch (e) {
        alert("첨부를 불러올 수 없습니다: " + (e.message || e));
      } finally {
        if (nameEl) nameEl.textContent = orig;
      }
    },

    /* ── 360° 팝업 열기 (클라우드 저장본 / 영상 / URL) ── */
    async openPano(pin) {
      // 현재 핀 기록 + 레이더/네비게이션 갱신 (3DVista radar · 핀 이동 핫스팟)
      State.activePin = pin.id;
      PanoViewer._currentPin = pin;
      // [구면 마커] 새 360 열 때 추가모드는 항상 꺼진 상태(보기 모드)로 시작
      this._spotAdd = false;
      if (PanoViewer.setSpotAddMode) PanoViewer.setSpotAddMode(false);
      const _sb = UI.$("btn-pano-spot"); if (_sb) _sb.classList.remove("on");
      Radar.update(pin);
      PanoNav.update(pin);
      // FLS 포인트 클라우드가 연결된 핀이면 3D 뷰어를 360과 나란히 표시
      if (typeof FLS !== "undefined") {
        const hasFls = !!(pin && (pin.flsUrl || pin.fls || pin.flsLocalId));
        const ov = document.getElementById("pano-overlay");
        if (ov) ov.classList.toggle("with-fls", hasFls);
        if (hasFls) FLS.openForPin(pin); else FLS.showPane(false);
      }
      if (typeof Notes !== "undefined") Notes.setPin(pin);  // 이슈/노트 패널 핀 연결
      if (typeof TimeLapse !== "undefined") TimeLapse.setPin(pin);  // 타임랩스 시점 바

      // [마스터 요청] 사진 대신 PDF가 등록된 핀 → 내장 PDF 뷰어로 팝업 표시(파노 오버레이 대신).
      if (!this.pinHasMedia(pin) && typeof PdfPopup !== "undefined") {
        const pdfAtt = (pin.attachments || []).find((a) => /\.pdf$/i.test(a.name || "") || a.kind === "pdf" || (a.kind && a.kind.type === "pdf"));
        if (pdfAtt) {
          let src = null;
          try {
            if (pdfAtt.docId) src = await Cloud.fetchDoc(pdfAtt.docId);
            else if (pdfAtt.pendingOpId && typeof Cloud !== "undefined") src = Cloud._cache["op:" + pdfAtt.pendingOpId] || null;
          } catch (e) {}
          if (src) { PdfPopup.open(src, pin.label); return; }
          if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("PDF를 불러올 수 없습니다(미동기화/오프라인일 수 있음)");
        }
      }

      // 노트/첨부만 있고 360° 미디어가 없는 정보 포인트 → 정보 패널만 표시
      if (!this.pinHasMedia(pin) && this.pinHasInfo(pin)) {
        const $ = id => document.getElementById(id);
        $("pano-location-name").textContent = "" + pin.label;
        $("pano-loading").classList.add("hidden");
        $("pano-error").classList.add("hidden");
        $("pano-canvas").classList.add("hidden");
        $("pano-hint").classList.add("hidden");
        $("pano-controls").classList.add("hidden");
        $("pano-overlay").classList.remove("hidden");
        PanoViewer.open = true;
        this._renderPanoInfoPanel(pin);
        return;
      }
      this._renderPanoInfoPanel(pin); // 미디어와 함께 노트/첨부도 표시
      // 1) 로컬 영상 blob
      if (pin.videoUrl) { PanoViewer.loadVideo(pin.videoUrl, pin.label); return; }
      // 1.3) 즉시등록 로컬 미리보기(업로드 진행 중) — imageId 준비 전이라도 바로 표시
      //   blob: URL 은 이 세션에서 만든 것만 유효(재접속하면 죽음). 메모리 캐시(현 세션)를
      //      우선 사용하고, 죽은 blob 이면 명확히 안내한다.
      if (!pin.imageId && (pin.localPreview || (typeof Cloud !== "undefined" && (Cloud._cache["op-preview:" + pin.id] || Cloud._cache["local:" + pin.id])))) {
        const $ = id => document.getElementById(id);
        // [핵심 버그 수정] 현 세션 메모리 캐시(살아있는 dataURL)를 "유일한 신뢰원"으로 사용.
        //   pin.localPreview 는 blob: 인 경우 재접속하면 죽은 URL → 절대 fallback 으로 쓰지 않는다.
        //   (blob 이 아닌 dataURL localPreview 만 예외적으로 허용)
        const memSrc = (typeof Cloud !== "undefined" && (Cloud._cache["op-preview:" + pin.id] || Cloud._cache["local:" + pin.id])) || null;
        const lpAlive = (typeof pin.localPreview === "string" && pin.localPreview.indexOf("blob:") !== 0) ? pin.localPreview : null;
        let src = memSrc || lpAlive;
        if (src) {
          $("pano-location-name").textContent = "360°(" + (pin.uploading ? "업로드 중" : "임시") + ") — " + pin.label;
          $("pano-loading").classList.add("hidden");
          $("pano-error").classList.add("hidden");
          $("pano-hint").classList.add("hidden");
          $("pano-controls").classList.add("hidden");
          $("pano-overlay").classList.remove("hidden");
          PanoViewer.open = true;
          PanoViewer.load(src, pin.label);
          return;
        }
        // 살아있는 소스 없음(죽은 blob) → 아래 공통 안내로 진행
      }
      // 1.5) 미동기화 로컬 이미지(오프라인 임시 저장) — 로컬 캐시로 즉시 미리보기
      if (pin.pendingOpId && Cloud._cache["op:" + pin.pendingOpId]) {
        const $ = id => document.getElementById(id);
        $("pano-location-name").textContent = "360°(임시 저장) — " + pin.label;
        $("pano-loading").classList.add("hidden");
        $("pano-error").classList.add("hidden");
        $("pano-hint").classList.add("hidden");
        $("pano-controls").classList.add("hidden");
        $("pano-overlay").classList.remove("hidden");
        PanoViewer.open = true;
        PanoViewer.load(Cloud._cache["op:" + pin.pendingOpId], pin.label);
        return;
      }
      // 2) 클라우드 저장 이미지
      if (pin.imageId) {
        const $ = id => document.getElementById(id);
        $("pano-location-name").textContent = "360° — " + pin.label;
        $("pano-loading").classList.remove("hidden");
        $("pano-error").classList.add("hidden");
        $("pano-canvas").classList.add("hidden");
        $("pano-hint").classList.add("hidden");
        $("pano-controls").classList.add("hidden");
        $("pano-overlay").classList.remove("hidden");
        PanoViewer.open = true;
        try {
          // [오프라인 작업지시서 ] 오프라인 번들(IndexedDB) base64 우선 → 온라인 재시도
          let dataURL = (typeof resolvePanoSource === "function") ? await resolvePanoSource(pin) : null;
          if (!dataURL) dataURL = await Cloud.fetchImage(pin.imageId);
          if (!dataURL) throw new Error("이 3D는 오프라인에 다운로드되지 않았습니다.");
          PanoViewer.load(dataURL, pin.label);
        } catch (e) {
          PanoViewer._showError("(클라우드: " + (pin.imageName || pin.imageId) + ")", e.message);
        }
      } else if (pin.imageUrl && pin.imageUrl.indexOf("blob:") !== 0) {
        // 3) URL 직접 입력 (이미지/영상 자동 판별). 단, blob: 은 죽은 임시 URL 이라 제외.
        PanoViewer.loadMedia(pin.imageUrl, pin.label, pin.isVideo);
      } else {
        // 4) [B3] 미디어 없음 / 죽은 blob 임시 미리보기 — 원인별 명확 안내
        const $ = id => document.getElementById(id);
        $("pano-location-name").textContent = "360° — " + pin.label;
        $("pano-loading").classList.add("hidden");
        $("pano-canvas").classList.add("hidden");
        $("pano-controls").classList.add("hidden");
        $("pano-hint").classList.add("hidden");
        // 한 번이라도 이미지 미리보기(localPreview/imageUrl=blob)가 있었으면 업로드 미완으로 판단
        const hadTempImage = !!(pin.localPreview || (pin.imageUrl && pin.imageUrl.indexOf("blob:") === 0) || pin.imageName);
        $("pano-error").querySelector(".pano-error-msg").textContent = hadTempImage
          ? "이 360° 사진은 임시 미리보기만 저장되어 재접속 후 표시할 수 없습니다. 편집모드에서 사진을 다시 업로드해 주세요."
          : "이 포인트에는 360° 미디어가 등록되지 않았습니다. 편집모드에서 사진(클라우드 업로드) 또는 영상 URL을 추가해 주세요.";
        $("pano-error-url").textContent = "";
        const hint = $("pano-error").querySelector(".pano-error-hint");
        if (hint) hint.textContent = hadTempImage
          ? "사진은 '그림 파일 선택'으로 업로드하면 클라우드에 저장되어 모든 기기·재접속에서 표시됩니다."
          : "영상은 외부 호스팅 URL(.mp4)로, 사진은 파일 업로드로 저장하세요.";
        $("pano-error").classList.remove("hidden");
        $("pano-overlay").classList.remove("hidden");
        PanoViewer.open = true;
      }
    },

    /* ── 배포 (설계자 → 뷰어) ── */
    /* ── 자동 저장 (버튼 없이 즉시 저장) ──
       도면 업로드 즉시 배포본(작업본)을 생성하고, 핀·영역 변경 시 디바운스 갱신한다.
       사용자가 "배포" 버튼을 누르지 않아도 도면과 작업 내용이 서버에 보존된다. */
    /** ── [마스터 요청 (나)] 도면 페이지(dataURL)를 R2에 업로드하고 R2 URL 배열로 치환 ──
     *  · 성공: ['/api/r2/object/assets/xxx.jpg', ...] 반환 → D1에는 URL만 저장(가벼움)
     *  · 실패(R2 미구성/네트워크): 원본 dataURL 배열 그대로 반환 → D1 base64 폴백(소실 방지)
     *  이미 R2 URL(또는 http URL)인 항목은 재업로드하지 않고 그대로 둠(중복 방지). */
    async _uploadPagesToR2(pagesData) {
      if (!Array.isArray(pagesData) || !pagesData.length) return pagesData || [];
      const out = [];
      for (const page of pagesData) {
        // 이미 URL이면(스냅샷 재저장 등) 그대로 사용
        if (typeof page === "string" && /^(https?:|\/api\/r2\/object\/)/i.test(page)) {
          out.push(page); continue;
        }
        // dataURL이 아니면 변환 불가 → 원본 유지
        if (typeof page !== "string" || !/^data:/i.test(page)) { out.push(page); continue; }
        try {
          const m = /^data:([^;,]+)[;,]/i.exec(page);
          const ct = (m && m[1]) || "image/jpeg";
          const blob = await (await fetch(page)).blob(); // dataURL → Blob (브라우저 표준)
          // [P14 형제 결함] Auth.headers() 는 항상 Content-Type: application/json 을 넣는다.
          //   종전 순서(Object.assign({CT: ct}, Auth.headers()))는 그 json 이 이미지 CT 를
          //   덮어써서 R2 객체가 .bin/application-json 으로 저장됐다(<img> 는 MIME 스니핑
          //   덕에 우연히 동작). 실제 CT 가 마지막에 오도록 순서를 바로잡는다.
          const r = await fetch("/api/r2/upload", {
            method: "PUT",
            headers: Object.assign({}, Auth.headers ? Auth.headers() : {}, { "Content-Type": ct }),
            body: blob
          });
          if (!r.ok) { out.push(page); continue; }  // 실패 → base64 폴백
          const j = await r.json();
          out.push(j.url || page);                  // R2 URL 채택
        } catch (e) { out.push(page); }             // 예외 → base64 폴백
      }
      return out;
    },

    /* ==================================================================
       [P14] 배포 스냅샷의 "원본 PDF" 보관 · 지연 로드 (뷰어 확대 화질)

       근본원인: 뷰어는 배포 스냅샷(비트맵 <img>)만 그린다. 원본 PDF 가 없으니
       확대하면 CSS 로 비트맵을 늘릴 수밖에 없어 뭉갠다(마스터 실사용 보고).
       편집모드는 State.pdfDoc 가 있어 재래스터로 이미 해결됨(5996a22).

       채택: 하이브리드 — 첫 화면은 종전대로 스냅샷으로 즉시 띄우고,
       스냅샷 해상도를 실제로 넘겨 확대했을 때만 원본 PDF 를 1회 지연 로드해
       편집모드가 쓰는 기존 경로(PDF.requestZoomRerender -> PDF.renderCrop)로
       보이는 영역만 다시 그린다. 새 렌더 파이프라인은 만들지 않는다.
       ================================================================== */

    /** 원본 PDF 를 R2 에 1회 업로드 (기존 /api/r2/upload PUT 재사용).
     *  실패는 치명적이지 않다 -> null 반환 = 스냅샷만 저장(종전 동작 그대로). */
    async _uploadSourcePdf(ab) {
      if (!ab || !ab.byteLength) return null;
      try {
        const blob = new Blob([ab], { type: "application/pdf" });
        const r = await fetch("/api/r2/upload", {
          method: "PUT",
          headers: Object.assign({}, Auth.headers ? Auth.headers() : {}, { "Content-Type": "application/pdf" }),
          body: blob
        });
        if (!r.ok) return null;
        const j = await r.json();
        return j.url || null;
      } catch (e) { return null; }
    },

    /** 배포본에 남길 source_meta(JSON 문자열) 생성.
     *  · 이미지 도면(PNG/JPG)은 원본이 곧 스냅샷이므로 이 경로를 타지 않는다 -> null.
     *  · 이미 업로드한 원본이 있으면 재업로드하지 않는다(URL 재사용).
     *  · dims = PDF.snapshotAllPages 가 실측한 실제 저장 픽셀([{w,h,pw,ph}]).
     *    뷰어는 이 값으로 "언제 원본이 필요한지"를 추측이 아니라 사실로 판정한다. */
    async _buildSourceMeta(dims) {
      if (State.fileType !== "pdf" || !State.fileData) return null;
      let url = State.sourcePdfUrl;
      if (!url) {
        url = await this._uploadSourcePdf(State.fileData);
        if (!url) return null;
        State.sourcePdfUrl = url;
      }
      const pages = Array.isArray(dims) ? dims
        : (Array.isArray(PDF.lastSnapshotDims) ? PDF.lastSnapshotDims : []);
      return this._sourceMetaJson(url, pages);
    },

    /** source_meta 직렬화 형식의 SoT — 도면 등록·영역 복사·원본 사후 등록이 같은 형식을 쓴다. */
    _sourceMetaJson(url, pages) {
      pages = Array.isArray(pages) ? pages : [];
      return JSON.stringify({ v: 1, pdf_url: url, pages: pages });
    },

    /* ══════════════════════════════════════════════════════════════════
       [WO 20260928-copy] 영역 = 원본에서 복사한 새 1페이지 PDF 배포본
       (31_Projects.extractRegionAsDeck 가 지휘. 여기는 원본 확보·업로드·배포본 생성만.)
       🔴 원본 배포본의 핀·구역·주석은 읽지도 쓰지도 않는다 — 원본 쪽 쓰기는
          _attachSourcePdf 의 source_meta 한 칸뿐(서버 PATCH 는 미전송 필드를 보존한다).
       ══════════════════════════════════════════════════════════════════ */

    /** 복사 전 대조 기대값 — 화면 도면(스냅샷)과 원본 PDF 가 같은 파일/같은 크기인지.
     *  meta.pages[p].pw/ph(스냅샷 pt)가 있으면 크기로, 없으면 화면 이미지 비율로 비교한다. */
    _regionExpect(meta, snapCount, pageNo, live) {
      const pages = meta && Array.isArray(meta.pages) ? meta.pages : [];
      const e = { count: snapCount > 0 ? snapCount : pages.length };
      const d = pages[(pageNo || 1) - 1];
      if (d && d.pw > 0 && d.ph > 0) { e.pw = d.pw; e.ph = d.ph; return e; }
      if (live) {
        const img = UI.$("map-image");
        if (img && img.naturalWidth && !img.classList.contains("hidden")) { e.w = img.naturalWidth; e.h = img.naturalHeight; }
      }
      return e;
    },

    /** 배포본의 원본 PDF 바이트 확보.
     *  @returns {Promise<{bytes, expect}|{missing:true, snapCount}|{error:string}>} */
    async _regionSource(depId, pageNo) {
      const live = State.autoSaveDepId === depId;
      // ① 편집모드에 PDF 원본이 떠 있다 — 화면이 곧 그 PDF 라 좌표 대조가 필요 없다(네트워크 0)
      if (live && State.fileType === "pdf" && State.fileData) return { bytes: State.fileData, expect: null };
      let meta = null, snapCount = 0;
      if (live) {
        meta = State.sourceMeta || (State.sourcePdfUrl ? { pdf_url: State.sourcePdfUrl } : null);
        snapCount = Array.isArray(State.viewerPages) ? State.viewerPages.length : 0;
      } else {
        try {
          const r = await fetch("/tables/deployments/" + encodeURIComponent(depId), { headers: Auth.headers() });
          if (!r.ok) return { error: "도면 정보를 불러오지 못했습니다(HTTP " + r.status + ")" };
          const dep = await r.json();
          try { meta = JSON.parse((dep && dep.source_meta) || "null"); } catch (e) { meta = null; }
          try { const pg = JSON.parse((dep && dep.pages_data) || "[]"); snapCount = Array.isArray(pg) ? pg.length : 0; } catch (e) {}
        } catch (e) { return { error: "도면 정보를 불러오지 못했습니다 — 네트워크를 확인하세요" }; }
      }
      if (!meta || typeof meta.pdf_url !== "string" || !meta.pdf_url) return { missing: true, snapCount };
      const expect = this._regionExpect(meta, snapCount, pageNo, live);
      this._srcProgress(-1);
      let ab = null;
      try { ab = await this._fetchSourcePdf(meta.pdf_url); } catch (e) { ab = null; }
      this._srcProgress(null);
      if (!ab) return { error: "원본 PDF 를 내려받지 못했습니다" };
      return { bytes: ab, expect };
    },

    /** 원본 없는 구버전 도면 — 사용자가 고른 PDF 파일(취소면 null). */
    _pickPdfFile() {
      return new Promise((resolve) => {
        const inp = document.createElement("input");
        inp.type = "file";
        inp.accept = "application/pdf,.pdf";
        let done = false;
        const fin = (f) => { if (done) return; done = true; resolve(f || null); };
        inp.addEventListener("change", () => fin(inp.files && inp.files[0]));
        inp.addEventListener("cancel", () => fin(null));
        inp.click();
      });
    },

    /** 구버전 배포본에 원본 PDF 를 사후 등록 — 🔴 source_meta 한 칸만 보낸다(핀·구역·주석 미전송 =
     *  서버 부분 갱신이 그대로 보존). 스냅샷 실측 픽셀은 기록이 없어 pages=[] → 뷰어는 이미지 크기로 폴백.
     *  @returns {Promise<boolean>} */
    async _attachSourcePdf(depId, ab) {
      const url = await this._uploadSourcePdf(ab);
      if (!url) return false;
      const meta = this._sourceMetaJson(url, []);
      const build = () => ({ source_meta: meta });
      const live = State.autoSaveDepId === depId;
      let ok = false;
      try {
        if (live) ok = (await this._patchDeployment(depId, build)).ok;   // 낙관적 잠금 버전도 함께 갱신
        else {
          const res = await fetch("/tables/deployments/" + encodeURIComponent(depId), {
            method: "PATCH", headers: Auth.headers(), body: JSON.stringify(build())
          });
          ok = res.ok;
        }
      } catch (e) { ok = false; }
      if (ok && live) this._applySourceMeta({ source_meta: meta });   // 지금 화면도 곧바로 원본 지연 로드 가능
      return ok;
    },

    /** 영역 PDF(bytes)로 새 배포본 생성 → id. 실패 시 null(조용한 성공 위장 금지).
     *  🔴 원본 PDF 업로드가 실패하면 아무것도 만들지 않는다 — 스냅샷 이미지만 있는 "깨지는 복사본" 금지.
     *  스냅샷·R2·저장 형식은 도면 등록과 같은 경로(snapshotAllPages · _uploadPagesToR2 · _deploymentBody). */
    async _createRegionCopyDeployment(name, bytes) {
      const pdfUrl = await this._uploadSourcePdf(bytes);
      if (!pdfUrl) return null;
      const prevDims = PDF.lastSnapshotDims;   // 전역 실측값 오염 방지(편집 중 도면의 저장에 섞이면 안 된다)
      let pages = [], dims = [], doc = null;
      try {
        doc = await PDF.load(bytes);
        pages = await PDF.snapshotAllPages(doc);
        dims = PDF.lastSnapshotDims || [];
      } catch (e) { pages = []; }
      finally {
        PDF.lastSnapshotDims = prevDims;
        try { if (doc && doc.destroy) doc.destroy(); } catch (e) {}
      }
      if (!pages.length) return null;
      const r2pages = await this._uploadPagesToR2(pages);
      const body = this._deploymentBody({ title: name, fileName: name + ".pdf" }, r2pages, this._sourceMetaJson(pdfUrl, dims));
      try {
        const res = await fetch("/tables/deployments", { method: "POST", headers: Auth.headers(), body: JSON.stringify(body) });
        if (!res.ok) return null;
        const rec = await res.json();
        return (rec && rec.id) || null;
      } catch (e) { return null; }
    },

    /** 배포본 레코드의 source_meta 를 State 에 반영 (도면 로드 경로 공용).
     *  구버전 배포본(source_meta 없음)이면 전부 null -> 종전 동작 + 1회 안내. */
    _applySourceMeta(dep) {
      State.sourceMeta = null; State.sourcePdfUrl = null;
      State.srcPdfDoc = null; State.srcNoticed = false; State.srcFailed = false;
      try {
        const m = JSON.parse((dep && dep.source_meta) || "null");
        if (m && typeof m === "object") {
          State.sourceMeta = m;
          if (typeof m.pdf_url === "string" && m.pdf_url) State.sourcePdfUrl = m.pdf_url;
        }
      } catch (e) { /* 손상된 메타 = 원본 없음으로 취급(조용히 틀린 화면을 그리지 않는다) */ }
    },

    /** 배포본에 기록된 현재 페이지의 스냅샷 실측 픽셀 — 없으면 null */
    _snapDim(pageNo) {
      const m = State.sourceMeta;
      if (!m || !Array.isArray(m.pages)) return null;
      const d = m.pages[(pageNo || State.pdfPage || 1) - 1];
      return (d && d.w > 0) ? d : null;
    },

    /** 구버전 배포본(원본 없음) 안내 — 조용한 실패 금지. 단, 반복 알림 금지(1회). */
    _noticeNoSource() {
      if (State.srcNoticed) return;
      State.srcNoticed = true;
      try {
        Prompt && Prompt.toast && Prompt.toast(
          "이 도면은 원본 없이 배포된 구버전이라 더 확대해도 선명해지지 않습니다 — 편집모드에서 다시 저장하면 원본이 함께 보관됩니다", 4600);
      } catch (e) {}
    },

    /** 원본 다운로드 진행 표시(비차단 칩). pct=null 이면 제거. pct<0 이면 무한정 표시.
     *  대비: #E6EDF3 on #0D1117 = 14.7:1 (WCAG AAA) */
    _srcProgress(pct) {
      let el = document.getElementById("src-progress");
      if (pct === null) { if (el && el.parentNode) el.parentNode.removeChild(el); return; }
      if (!el) {
        el = document.createElement("div");
        el.id = "src-progress";
        el.setAttribute("role", "status");
        el.style.cssText = "position:fixed;left:50%;bottom:76px;transform:translateX(-50%);" +
          "z-index:9999;background:#0D1117;color:#E6EDF3;border:1px solid #30363D;" +
          "border-radius:999px;padding:8px 14px;font-size:12.5px;font-weight:600;" +
          "box-shadow:0 6px 20px rgba(0,0,0,.45);pointer-events:none;white-space:nowrap;";
        document.body.appendChild(el);
      }
      el.textContent = (pct >= 0)
        ? ("원본 도면 불러오는 중... " + pct + "%")
        : "원본 도면 불러오는 중...";
    },

    /** 스냅샷 <img> 위에 원본 PDF 크롭 오버레이를 얹기 위한 렌더 상태 셋업.
     *  편집모드와 같은 PDF._renderState 를 쓰므로 renderCrop 을 그대로 재사용한다.
     *  · baseCssScale = 스냅샷 CSS 폭 / PDF 페이지 폭(pt)  -> 오버레이 좌표계 일치
     *  · renderScale  = 스냅샷 실제 px / PDF 페이지 폭(pt) -> "스냅샷보다 선명할 때만" 판정 기준
     *  주의(정직 고지): 도면 회전(State.pdfRotation != 0)에서는 스냅샷이 CSS rotate 로 돌아가는데
     *    MapCtrl.visibleDrawingRect 는 회전을 역산하지 않는다 -> 오버레이를 얹지 않고 종전 동작. */
    async _primeSourceRender() {
      const doc = State.srcPdfDoc;
      const img = UI.$("map-image");
      if (!doc || !img || img.classList.contains("hidden") || !img.naturalWidth) return false;
      if (State.pdfRotation) { PDF._clearCrop(); return false; }
      try {
        const pg = Math.max(1, Math.min(doc.numPages, State.pdfPage || 1));
        const page = await doc.getPage(pg);
        const rot = (page.rotate || 0) % 360;
        const base = page.getViewport({ scale: 1, rotation: rot });
        if (!(base.width > 0)) return false;
        const st = PDF._renderState;
        PDF._clearCrop();
        st.pdfDoc = doc;
        st.pageNum = pg;
        st.rotation = 0;
        st.baseCssScale = (img.clientWidth || img.naturalWidth) / base.width;
        st.renderScale  = img.naturalWidth / base.width;
        st.overlayOnly  = true;
        return true;
      } catch (e) { return false; }
    },

    /** [진입점] MapCtrl.applyTransform 이 호출. 원본이 없는 상태에서만 불린다.
     *  임계(스냅샷 실해상도)를 넘겼을 때만 원본 PDF 를 딱 1회 받는다. */
    async maybeLoadSourcePdf(zoom) {
      if (State.srcPdfDoc || this._srcBusy || State.srcFailed) return false;
      if (typeof PDF === "undefined" || !PDF.needsSourceRerender) return false;
      const img = UI.$("map-image");
      if (!img || img.classList.contains("hidden") || !img.naturalWidth) return false;
      const dim = this._snapDim();
      const snapPx = (dim && dim.w) || img.naturalWidth;
      const cssPx  = img.clientWidth || img.naturalWidth;
      const z = (zoom != null) ? zoom : State.zoom;
      if (!PDF.needsSourceRerender({ snapPx: snapPx, cssPx: cssPx, zoom: z })) return false;
      // 임계는 넘었는데 원본이 없다(구버전 배포본) -> 종전 동작 + 사유 1회 안내
      if (!State.sourcePdfUrl) { this._noticeNoSource(); return false; }
      this._srcBusy = true;
      this._srcProgress(-1);
      try {
        const ab = await this._fetchSourcePdf(State.sourcePdfUrl);
        if (!ab) throw new Error("source download failed");
        State.srcPdfDoc = await PDF.load(ab);
        await this._primeSourceRender();
        MapCtrl.applyTransform();   // 확보 즉시 현재 배율로 크롭 오버레이 요청
        return true;
      } catch (e) {
        State.srcFailed = true;     // 재시도 금지 — 확대할 때마다 재다운로드하지 않는다
        try { Prompt && Prompt.toast && Prompt.toast("원본 도면을 불러오지 못했습니다 — 스냅샷 화질로 표시합니다"); } catch (e2) {}
        return false;
      } finally {
        this._srcBusy = false;
        this._srcProgress(null);
      }
    },

    /** 원본 PDF 다운로드 + 진행률. Content-Length 가 없으면 무한정 표시로 폴백. */
    async _fetchSourcePdf(url) {
      const res = await fetch(Auth.r2 ? Auth.r2(url) : url, { headers: Auth.headers() });
      if (!res.ok) return null;
      const total = Number(res.headers.get("Content-Length") || 0);
      if (!res.body || !res.body.getReader || !(total > 0)) return await res.arrayBuffer();
      const reader = res.body.getReader();
      const chunks = [];
      let got = 0;
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        chunks.push(r.value);
        got += r.value.length;
        this._srcProgress(Math.min(99, Math.round(got * 100 / total)));
      }
      const buf = new Uint8Array(got);
      let off = 0;
      for (const c of chunks) { buf.set(c, off); off += c.length; }
      return buf.buffer;
    },

    /* ════════════════════════════════════════════════════════════════
       [멀티유저 동시작업 충돌 방지 — 낙관적 잠금 + 자동 병합]
       두 명 이상이 같은 구역 도면을 동시에 편집할 때, 나중 저장이 먼저
       저장을 통째로 덮어쓰는 데이터 유실을 막는다.
       · 저장(PATCH) 시 base_version(내가 불러온 버전)을 함께 전송
       · 서버 버전이 다르면 409 + 서버 최신본(current) 반환
       · 클라이언트는 서버 최신 pins/zones 와 내 로컬 변경분을 id 기준으로
         병합(양쪽 모두 보존)한 뒤, 서버 최신 버전으로 1회 재시도
       ════════════════════════════════════════════════════════════════ */

    /** id(또는 보조키) 기준 두 배열 병합 — 서버본 기준에 내 추가/수정분을 덮어쓰기 union */
    _mergeById(serverArr, localArr) {
      const keyOf = (o) => (o && (o.id != null ? "id:" + o.id
        : (o.pin_id != null ? "pid:" + o.pin_id
        : (o.name != null && o.x != null ? "nx:" + o.name + ":" + o.x + ":" + o.y : null))));
      const map = new Map();
      (Array.isArray(serverArr) ? serverArr : []).forEach((o) => { const k = keyOf(o); if (k) map.set(k, o); else map.set("anon:" + map.size, o); });
      // 내 로컬 항목으로 덮어쓰기(=내가 최근 편집한 내용 우선) + 서버에만 있던 항목 보존
      (Array.isArray(localArr) ? localArr : []).forEach((o) => { const k = keyOf(o); if (k) map.set(k, o); else map.set("anon:" + map.size + "L", o); });
      return Array.from(map.values());
    },

    /** 409 충돌 시: 서버 최신본(current)과 현재 State 의 핀/구역을 병합하여 State 갱신.
     *  반환: 병합된 {pins, zones, version} (version 은 서버 최신값) */
    _mergeConflict(current) {
      let srvPins = [], srvZones = [];
      try { srvPins = JSON.parse(current.pins || "[]"); } catch (e) { srvPins = []; }
      try { srvZones = JSON.parse(current.zones || "[]"); } catch (e) { srvZones = []; }
      const mergedPins  = this._mergeById(srvPins,  State.pins  || []);
      const mergedZones = this._mergeById(srvZones, State.zones || []);
      State.pins  = mergedPins;
      State.zones = mergedZones;
      State.depVersion = (current.version != null ? Number(current.version) : State.depVersion);
      // 화면 즉시 반영(다른 사람이 추가한 핀/구역도 보이도록)
      try { UI.renderPinList(); UI.renderPinsOnMap(); } catch (e) {}
      try { if (typeof Zones !== "undefined") { Zones.render(); Zones.renderList(); } } catch (e) {}
      return { pins: mergedPins, zones: mergedZones, version: State.depVersion };
    },

    /** 배포본 PATCH(낙관적 잠금) — 409면 1회 병합 후 재시도.
     *  buildBody(): 호출 시점의 현재 State 로 payload 를 만드는 함수(병합 후 재생성용).
     *  반환: { ok, rec?, conflictMerged? } */
    async _patchDeployment(depId, buildBody) {
      const send = async () => {
        const body = buildBody();
        body.base_version = (State.depVersion != null ? State.depVersion : 0);
        const res = await fetch("/tables/deployments/" + encodeURIComponent(depId), {
          method: "PATCH", headers: Auth.headers(), body: JSON.stringify(body)
        });
        return res;
      };
      let res = await send();
      if (res.status === 409) {
        // 다른 사용자가 먼저 저장 → 병합 후 1회 재시도
        let j = null; try { j = await res.json(); } catch (e) {}
        if (j && j.current) {
          this._mergeConflict(j.current);
          Prompt && Prompt.toast && Prompt.toast("다른 사용자의 변경을 병합했습니다 — 다시 저장합니다");
          res = await send(); // 병합된 State + 최신 version 으로 재시도
        }
      }
      if (!res.ok) return { ok: false, status: res.status };
      let rec = null; try { rec = await res.json(); } catch (e) {}
      if (rec && rec.version != null) State.depVersion = Number(rec.version); // 성공 → 새 버전 반영
      return { ok: true, rec };
    },

    _buildSavePayload(pagesData, sourceMeta) {
      // [WO 20260917] 스냅샷이 구역 크롭으로 잘렸으면 그 페이지의 핀/영역/주석도 크롭 기준 %로
      // 재배치해 실어 보낸다(라이브 State.pins/zones/annotations 자체는 페이지 기준 %로 그대로 —
      // 이 배열들은 배포용 복사본). 크롭 밖 항목은 표시할 캔버스가 없으므로 배포본에서 제외한다
      // (원본 State.pins/zones/annotations 는 불변).
      const deckCrop = this._currentDeckCrop();
      const deployablePins = State.pins.map(p => {
        const q = Object.assign({}, p);
        if (deckCrop && (q.page || 1) === deckCrop.page && typeof MapCtrl !== "undefined" && MapCtrl.pageToDeckCropPct) {
          const mapped = MapCtrl.pageToDeckCropPct(q.x, q.y, deckCrop.crop);
          if (!mapped) return null; // 크롭 밖 — 배포본에서 제외
          q.x = mapped.x; q.y = mapped.y;
        }
        if (q.videoUrl) { delete q.videoUrl; q.localOnly = true; }
        // [핵심 버그 수정] blob: 임시 미리보기 URL 은 그 세션에서만 유효 →
        //   서버/배포본에 저장하면 재접속 시 죽은 blob 으로 "이미지를 불러올 수 없습니다".
        //   localPreview(blob) 와 일시 상태 플래그는 직렬화에서 제거한다.
        //   (실제 이미지는 imageId(클라우드) 또는 pendingOpId(동기화 대기)로만 보존)
        if (typeof q.localPreview === "string" && q.localPreview.indexOf("blob:") === 0) delete q.localPreview;
        if (typeof q.imageUrl === "string" && q.imageUrl.indexOf("blob:") === 0) delete q.imageUrl;
        delete q.uploading;
        return q;
      }).filter(Boolean);
      const deployableZones = (State.zones || []).map(z => this._mapZoneForCrop(z, deckCrop)).filter(Boolean);
      const deployableAnnotations = (State.annotations || []).map(a => this._mapAnnoForCrop(a, deckCrop)).filter(Boolean);
      return this._deploymentBody({
        title: State.fileName || "도면", fileName: State.fileName || "",
        pins: deployablePins, zones: deployableZones, annotations: deployableAnnotations,
        checkboardStart: State.checkboardStart
      }, pagesData, sourceMeta);
    },

    /** 배포본 저장 본문 형식의 SoT — 도면 저장(_buildSavePayload)과 영역 복사본 생성이 공유한다. */
    _deploymentBody(o, pagesData, sourceMeta) {
      const body = {
        title:       o.title || "도면",
        file_name:   o.fileName || "",
        pins:        JSON.stringify(o.pins || []),
        zones:       JSON.stringify(o.zones || []),
        annotations: JSON.stringify(o.annotations || [])
      };
      // [WO 20260917 멀티유저 ①] 체크보드 시작번호(페이지별) 영속화 — 항상 함께 보낸다(작아서
      //   조건부 전송할 이유가 없음). 서버는 컬럼 자체가 없던 구버전에서도 부분갱신 규칙(§merged)
      //   대로 안전히 저장한다. 값이 비어도 "{}" 로 보내 구버전(값 없음=1) 폴백을 그대로 재현.
      body.checkboard_start = JSON.stringify(o.checkboardStart || {});
      if (pagesData && pagesData.length) {
        body.drawing_data = pagesData[0];
        body.pages_data   = JSON.stringify(pagesData);
      }
      // [P14] 원본 PDF 위치 + 실제 저장 픽셀. 있을 때만 실어 보낸다 —
      //   미전송 시 서버가 기존 값을 그대로 보존하므로(부분 갱신) 기존 배포본이 깨지지 않는다.
      if (sourceMeta) body.source_meta = sourceMeta;
      return body;
    },

    /** [WO 20260917] 현재 구역(deck)의 크롭 — { page(1-base), crop:{x,y,w,h}(%) } 또는 null.
     *  crop 없는 구역(또는 구역 미선택)은 null → snapshotAllPages 는 종전대로 전체 페이지. */
    _currentDeckCrop() {
      const cd = (typeof Projects !== "undefined") ? Projects.currentDeck : null;
      if (!cd || !cd.crop || !(cd.crop.w > 0) || !(cd.crop.h > 0)) return null;
      return { page: cd.page || 1, crop: cd.crop };
    },

    /** [WO 20260917-crop-zone-anno] 영역(16_Zones.js 의 State.zones 항목) 배포용 좌표 재매핑.
     *  핀과 동일하게 MapCtrl.pageToDeckCropPct(순수함수)만 재사용 — 새 변환 로직 없음.
     *  rect: {x,y,w,h}, circle: {cx,cy,r}, poly: {points:[{x,y}...]} 모두 대응.
     *  반환: 복사본(원본 z 불변) · crop 밖(어느 한 점이라도)이면 null(배포본 제외).
     *  crop 없음/페이지 불일치면 그대로 복사본 반환(재매핑 없음, 종전 동작). */
    _mapZoneForCrop(z, deckCrop) {
      const zz = Object.assign({}, z);
      if (!deckCrop || (zz.page || 1) !== deckCrop.page || typeof MapCtrl === "undefined" || !MapCtrl.pageToDeckCropPct) {
        return zz;
      }
      const crop = deckCrop.crop;
      const mapPt = (x, y) => MapCtrl.pageToDeckCropPct(x, y, crop);
      if (zz.shape === "poly" && Array.isArray(zz.points)) {
        const mapped = [];
        for (const p of zz.points) {
          const m = mapPt(p.x, p.y);
          if (!m) return null; // 점 하나라도 크롭 밖 — 배포본에서 제외
          mapped.push({ x: m.x, y: m.y });
        }
        zz.points = mapped;
        const xs = mapped.map(p => p.x), ys = mapped.map(p => p.y);
        zz.x = Math.min(...xs); zz.y = Math.min(...ys);
        zz.w = Math.max(...xs) - zz.x; zz.h = Math.max(...ys) - zz.y;
        return zz;
      }
      if (zz.shape === "circle") {
        const p1 = mapPt(zz.cx - zz.r, zz.cy - zz.r);
        const p2 = mapPt(zz.cx + zz.r, zz.cy + zz.r);
        if (!p1 || !p2) return null;
        zz.cx = (p1.x + p2.x) / 2; zz.cy = (p1.y + p2.y) / 2;
        zz.r  = ((p2.x - p1.x) + (p2.y - p1.y)) / 4;
        zz.x = p1.x; zz.y = p1.y; zz.w = p2.x - p1.x; zz.h = p2.y - p1.y;
        return zz;
      }
      // rect(기본) — 항상 바운딩 박스(x,y,w,h)를 보관하는 형식(16_Zones.js _commitZone)
      const p1 = mapPt(zz.x, zz.y);
      const p2 = mapPt(zz.x + zz.w, zz.y + zz.h);
      if (!p1 || !p2) return null;
      zz.x = p1.x; zz.y = p1.y; zz.w = p2.x - p1.x; zz.h = p2.y - p1.y;
      return zz;
    },

    /** [WO 20260917-crop-zone-anno] PDF 주석(26_PdfAnno.js 의 State.annotations 항목) 배포용
     *  좌표 재매핑. 주석 좌표는 permille(0~1000, 페이지 기준 %×10) 저장 형식이라 MapCtrl.
     *  pageToDeckCropPct(%,0~100 입력)에 맞춰 /10 → 변환 → *10 로 왕복한다(새 변환 로직 아님).
     *  type: text{x,y} · rect/highlight{x,y,w,h} · pen{pts:[{x,y}...]}.
     *  반환: 복사본(원본 a 불변) · crop 밖이면 null(배포본 제외). crop 없음/페이지 불일치면
     *  그대로 복사본 반환(재매핑 없음, 종전 동작). */
    _mapAnnoForCrop(a, deckCrop) {
      const aa = Object.assign({}, a);
      if (!deckCrop || (aa.page || 1) !== deckCrop.page || typeof MapCtrl === "undefined" || !MapCtrl.pageToDeckCropPct) {
        return aa;
      }
      const crop = deckCrop.crop;
      const mapPt = (x, y) => {
        const m = MapCtrl.pageToDeckCropPct(x / 10, y / 10, crop);
        return m ? { x: m.x * 10, y: m.y * 10 } : null;
      };
      if (aa.type === "pen" && Array.isArray(aa.pts)) {
        const mapped = [];
        for (const p of aa.pts) {
          const m = mapPt(p.x, p.y);
          if (!m) return null; // 점 하나라도 크롭 밖 — 배포본에서 제외
          mapped.push({ x: m.x, y: m.y });
        }
        aa.pts = mapped;
        return aa;
      }
      if (aa.type === "text") {
        const m = mapPt(aa.x, aa.y);
        if (!m) return null;
        aa.x = m.x; aa.y = m.y;
        return aa;
      }
      // rect / highlight — {x,y,w,h}
      const p1 = mapPt(aa.x, aa.y);
      const p2 = mapPt(aa.x + aa.w, aa.y + aa.h);
      if (!p1 || !p2) return null;
      aa.x = p1.x; aa.y = p1.y; aa.w = p2.x - p1.x; aa.h = p2.y - p1.y;
      return aa;
    },

    async _snapshotPages() {
      // [P14] 이전 도면의 실측 픽셀이 남아 다음 저장에 잘못 붙지 않게 초기화(SoT 오염 방지)
      try { PDF.lastSnapshotDims = null; } catch (e) {}
      if (State.fileType === "pdf" && State.pdfDoc) {
        return await PDF.snapshotAllPages(State.pdfDoc, undefined, undefined, this._currentDeckCrop());
      } else if (State.fileType === "image") {
        const imgEl = UI.$("map-image");
        if (!imgEl || !imgEl.naturalWidth) return [];
        const off = document.createElement("canvas");
        const maxDim = 2000;
        const ratio = Math.min(1, maxDim / Math.max(imgEl.naturalWidth, imgEl.naturalHeight));
        off.width  = Math.round(imgEl.naturalWidth * ratio);
        off.height = Math.round(imgEl.naturalHeight * ratio);
        off.getContext("2d").drawImage(imgEl, 0, 0, off.width, off.height);
        return [off.toDataURL("image/jpeg", 0.8)];
      }
      return [];
    },

    _setSaveIndicator(stateStr) {
      // stateStr: 'saving' | 'saved' | 'error' | 'offline'
      const el = UI.$("autosave-indicator");
      if (!el) return;
      el.classList.remove("hidden", "saving", "saved", "error", "offline", "just-saved");
      el.classList.add(stateStr);
      const map = {
        saving:  "저장 중…",
        saved:   "저장됨",                  // [P3] 자동저장 OFF 정책 — '자동 저장됨'은 사실과 다름
        error:   "저장 실패 — 재시도",
        offline: "오프라인 — 로컬 보관"
      };
      const t = UI.$("autosave-text");
      if (t) t.textContent = map[stateStr] || "";
      // [P3] 저장 완료를 놓치지 않도록 몇 초간 강조(모바일은 텍스트가 숨겨져 점/링으로만 보인다)
      try { clearTimeout(this._saveFlashT); } catch (e) {}
      if (stateStr === "saved") {
        el.classList.add("just-saved");
        this._saveFlashT = setTimeout(() => { try { el.classList.remove("just-saved"); } catch (e) {} }, 2600);
      }
    },

    /** #3: 도면 로드 직후 — 구역 보장 + 즉시 자동저장(스냅샷) + 구역에 도면 연결 */
    async _afterDrawingLoaded() {
      if (State.mode !== "designer") return;
      // [P0-2] '새 도면이 실제로 올라온' 유일한 지점 — 여기서 dirty 를 확정한다.
      //   아래 try 안(스냅샷/구역보장)에서 예외가 나도 미저장 표시는 반드시 남도록 try 밖에 둔다.
      this._dirtyPages = true; this._markDirty();
      try {
        // 1) 🔴 [WO 20260928·마스터 확정] 구역 자동생성 금지.
        //    옛 Projects.ensureDeck() 는 구역이 0개면 **"구역 1" 이라는 자동 이름** 구역을 만들어
        //    "도면 등록만으로 구역이 생기는" 상태를 만들었다(마스터가 두 번 지적한 바로 그 지점).
        //    이제 **이미 존재하는** 구역만 컨텍스트로 채택한다. 0개면 deck = null 로 두고,
        //    첫 영역 지정 시 Projects.createDeckFromLoadedDrawing() 이 배포본+구역+crop 을 묶어 만든다.
        let deck = null;
        if (typeof Projects !== "undefined" && Projects.currentProject) {
          deck = Projects.currentDeck || (Projects.decks && Projects.decks[0]) || null;
          if (deck && Projects.currentDeck !== deck) Projects.currentDeck = deck;
        }
        // 2) 도면 교체 지원: 구역에 기존 도면이 있으면 그 배포본을 덮어써서 교체(고아 방지),
        //    없으면 새 배포본 생성. (구역당 도면 1개 유지 — 구역을 여러 개 만들면 도면 다수 등록)
        // [마스터: 자동저장 OFF] 도면 업로드해도 서버 즉시저장 안 함 → 로컬 보존 + dirty.
        //   실제 서버 생성/교체·구역연결은 '저장' 버튼(_saveNow)에서 수행.
        const isReplace = !!(deck && deck.deployment_id);
        if (isReplace) {
          State.autoSaveDepId = deck.deployment_id;     // 저장 시 이 배포본을 PATCH(교체)
        } else {
          State.autoSaveDepId = null;
          if (deck) this._pendingDeckLink = { deckId: deck.id, deck };  // 저장 시 생성+연결
        }
        await this._saveDraftLocal(await this._snapshotPages());   // 도면 즉시 로컬 보존(소실 방지)
        // 🔴 [WO 20260928] deck 이 null(구역 0개)일 때도 반드시 다시 그려야 한다 —
        //   #side-tree 의 빈 상태 안내가 "도면 없음" → "도면 있음 + 구역 0" 분기로 갈아타는 지점이다.
        //   (여기서 건너뛰면 도면을 올렸는데 사이드바가 옛 안내에 머물러 다음 행동을 알 수 없다)
        try { if (typeof Projects !== "undefined" && Projects._renderDecks) Projects._renderDecks(); } catch (e) {}
        if (deck) {
          Prompt.toast && Prompt.toast((isReplace ? "도면 교체됨" : "도면 등록됨") + " — '저장' 버튼을 눌러 반영하세요 (구역: " + deck.name + ")");
        } else {
          // 🔴 [WO 20260928 · 라이브 실측] 375×812 에서 #side-tree 는 바텀시트 안(y≈1045px = 화면 밖)이라
          //   안내를 그려도 사용자는 보지 못한다("도면만 올라가고 다음 행동을 모르는" 상태 = 빈 화면과 동급).
          //   구역이 0개일 때만 그 시트를 열어 안내를 화면 안으로 올린다. 데스크톱은 무해(무변화).
          this._openSidebarSheet();
          Prompt.toast && Prompt.toast("도면이 등록됐습니다 — 도면에서 영역을 드래그하면 그 부분이 '구역'이 됩니다", 5200);
        }
      } catch (e) { /* 비치명적 */ }
    },

    /** [WO 20260928] 모바일 사이드 시트(트리)를 연다.
     *  🔴 새 UI 0 — 상태 SoT 인 body.sidebar-open 과 기존 메뉴 칩을 그대로 쓴다.
     *  해당 CSS 는 @media (max-width:760px) 안에만 있어 데스크톱에서는 아무 효과가 없다(실측 확인). */
    _openSidebarSheet() {
      try {
        document.body.classList.add("sidebar-open");
        ["mnav-menu", "tq-menu"].forEach((id) => { const b = UI.$(id); if (b && b.classList) b.classList.add("active"); });
        const chip = document.querySelector('.mobile-dock [data-act="menu"]');
        if (chip && chip.classList) chip.classList.add("active");
      } catch (e) {}
    },

    /** [WO 20260928] 사이드 시트를 닫는다 — 도면 위 드래그(크롭 지정)를 시작할 때 필수.
     *  시트는 화면 하단 절반을 덮으므로, 열린 채로 드래그를 요구하면 사용자는 도면을 만질 수 없다.
     *  🔴 시트를 여는 쪽(_openSidebarSheet)과 짝을 이루는 같은 SoT(body.sidebar-open)만 쓴다. */
    _closeSidebarSheet() {
      try {
        document.body.classList.remove("sidebar-open");
        ["mnav-menu", "tq-menu"].forEach((id) => { const b = UI.$(id); if (b && b.classList) b.classList.remove("active"); });
        const chip = document.querySelector('.mobile-dock [data-act="menu"]');
        if (chip && chip.classList) chip.classList.remove("active");
      } catch (e) {}
    },

    /** [WO 20260928] 로드된 도면을 서버 배포본(deployments 행)으로 확정하고 그 id 를 돌려준다.
     *  이미 있으면 그대로 재사용한다(중복 배포본 0).
     *  🔴 새 저장 경로 금지 — 기존 _createInitialSave()(R2 업로드 + POST /tables/deployments)를 그대로 쓴다.
     *  '도면 등록'이 더는 구역을 만들지 않게 된 뒤, **첫 영역 지정 시점**에 배포본이 필요해져 신설했다
     *  (31_Projects.createDeckFromLoadedDrawing 의 유일한 호출부 — decks.deployment_id 가 가리킬 대상).
     *  @returns {Promise<string|null>} 배포본 id · 실패 시 null(조용한 성공 위장 금지) */
    async _ensureDrawingDeployment() {
      if (State.autoSaveDepId) return State.autoSaveDepId;
      if (!State.fileType) return null;
      await this._createInitialSave();
      return State.autoSaveDepId || null;
    },

    /** ── [마스터 요청] 도면↔구역 연결을 즉시 시도하고, 실패하면 재시도 큐에 넣어
     *  앱이 중지/새로고침돼도 다음 기회에 반드시 연결되도록 보장한다. ── */
    /** [도면 연결 복구] 구역에 연결된 도면이 없을 때 — 도면 목록에서 골라 연결 */
    async offerDeckDrawingLink(deck) {
      if (!deck) return;
      let deps = [];
      try {
        const r = await fetch("/tables/deployments", { headers: Auth.headers() });
        const j = await r.json();
        deps = (j && (j.data || j)) || [];
        if (!Array.isArray(deps)) deps = [];
      } catch (e) { deps = []; }
      const modal = UI.$("deck-link-modal"), list = UI.$("deck-link-list"), sub = UI.$("deck-link-sub");
      if (!modal || !list) return;
      if (sub) sub.textContent = "구역 ‘" + (deck.name || "") + "’에 표시할 도면을 고르세요.";
      if (!deps.length) {
        list.innerHTML = '<div class="psl-empty">등록된 도면이 없습니다.<br>‘도면’ 도구로 먼저 업로드하세요.</div>';
      } else {
        list.innerHTML = deps.map((d) => '<button class="dl-item" data-id="' + d.id + '">' + UI.escapeHtml(d.file_name || d.title || d.id) + '</button>').join("");
      }
      modal.classList.remove("hidden");
      const close = () => modal.classList.add("hidden");
      const cancel = UI.$("deck-link-cancel"); if (cancel) cancel.onclick = close;
      const bd = UI.$("deck-link-backdrop"); if (bd) bd.onclick = close;
      list.querySelectorAll(".dl-item").forEach((b) => {
        b.addEventListener("click", async () => {
          close();
          deck.deployment_id = b.dataset.id;
          try { await this._linkDeckDeployment(deck.id, b.dataset.id, deck); } catch (e) {}
          if (typeof Projects !== "undefined" && Projects._renderDecks) Projects._renderDecks();
          try { await this.loadDeckDrawing(b.dataset.id); } catch (e) {}
          if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("도면 연결됨");
        });
      });
    },
    async _linkDeckDeployment(deckId, depId, deckObj) {
      if (!deckId || !depId) return false;
      const body = {
        name: (deckObj && deckObj.name) || undefined,
        level_no: (deckObj && deckObj.level_no) || null,
        deployment_id: depId
      };
      // 1) 재시도 큐에 먼저 기록(localStorage) — 즉시 성공해도 무해(성공 시 제거)
      this._enqueueDeckLink(deckId, depId, body);
      try {
        const r = await fetch("/api/decks/" + deckId, {
          method: "PUT", headers: Auth.headers(), body: JSON.stringify(body)
        });
        if (r.ok) {
          this._dequeueDeckLink(deckId);   // 성공 → 큐에서 제거
          if (typeof Projects !== "undefined") Projects._renderDecks();
          return true;
        }
      } catch (e) { /* 네트워크 실패 → 큐에 남아 재시도 */ }
      return false;
    },

    _deckLinkKey() { return "wm_deck_link_queue"; },
    _enqueueDeckLink(deckId, depId, body) {
      try {
        const q = JSON.parse(localStorage.getItem(this._deckLinkKey()) || "{}");
        q[deckId] = { deckId, depId, body, ts: Date.now() };
        localStorage.setItem(this._deckLinkKey(), JSON.stringify(q));
      } catch (e) {}
    },
    _dequeueDeckLink(deckId) {
      try {
        const q = JSON.parse(localStorage.getItem(this._deckLinkKey()) || "{}");
        if (q[deckId]) { delete q[deckId]; localStorage.setItem(this._deckLinkKey(), JSON.stringify(q)); }
      } catch (e) {}
    },
    /** 앱 시작/온라인 복귀 시: 미연결 도면↔구역 연결을 재시도해 누락을 복구 */
    async _flushDeckLinkQueue() {
      let q = {};
      try { q = JSON.parse(localStorage.getItem(this._deckLinkKey()) || "{}"); } catch (e) { return; }
      const items = Object.values(q || {});
      if (!items.length) return;
      for (const it of items) {
        try {
          const r = await fetch("/api/decks/" + it.deckId, {
            method: "PUT", headers: Auth.headers(), body: JSON.stringify(it.body)
          });
          if (r.ok) this._dequeueDeckLink(it.deckId);
        } catch (e) { /* 다음 기회에 재시도 */ }
      }
      if (typeof Projects !== "undefined" && Projects.loadDecks && Projects.currentProject) {
        try { await Projects.loadDecks(); } catch (e) {}
      }
    },

    /** 구역 선택 시 연결된 도면(배포 스냅샷)을 불러와 화면(디자이너 편집)에 표시 */
    async loadDeckDrawing(deploymentId) {
      if (!deploymentId) {
        // 서버 배포본 ID 가 없어도 로컬 draft 가 있으면 복원 시도(오프라인 신규 등록분)
        return await this._restoreDraftLocal();
      }
      const seq = this._beginLoad();   // 🔴 [WO 20260928-pinloss] 늦게 도착한 이전 로드가 이 결과를 덮지 못하게
      const dkey = this._draftKey();   // await 전에 확정 — 로드 중 구역이 바뀌어도 이 구역의 draft 만 본다
      // 🔴 서버 fetch **전에** 읽는다 — 재접속 자동업로드(_flushDirtyDrafts)가 fetch 도중 draft 를 clean 으로
      //   바꿔도 이 로드는 작업분을 놓치지 않는다(서버본이 더 새로우면 _draftVsServer 가 id 병합).
      const draft = await this._readDirtyDraft(dkey, deploymentId);
      try {
        // [오프라인 작업지시서 ] 오프라인이면 서버 fetch 대신 번들(IndexedDB)에서 도면 복원
        let dep = null;
        if (!navigator.onLine && typeof OfflineLoad !== "undefined") {
          dep = await OfflineLoad.deployment(deploymentId);
          if (!dep) { await this._restoreDraftLocal(); return; }
        } else {
          const r = await fetch("/tables/deployments/" + encodeURIComponent(deploymentId), { headers: Auth.headers() });
          if (!r.ok) { await this._restoreDraftLocal(); return; }   // 서버 실패 → 로컬 폴백
          dep = await r.json();
        }
        if (!this._isCurrentLoad(seq)) return;   // 그 사이 다른 구역/모드 로드가 시작됨 → 이 결과는 폐기
        let pages = [];
        try { pages = JSON.parse(dep.pages_data || "[]"); } catch { pages = []; }
        if (!Array.isArray(pages) || pages.length === 0) pages = dep.drawing_data ? [dep.drawing_data] : [];
        if (!pages.length) { await this._restoreDraftLocal(); return; }

        State.reset();
        State.fileType = "image";       // 스냅샷은 이미지(dataURL)로 보관됨
        this._applySourceMeta(dep);     // [P14] 원본 PDF 위치/실측 픽셀(구버전이면 전부 null)
        State.viewerPages = pages;
        State.pdfPage = 1;
        State.fileName = dep.file_name || dep.title || "구역 도면";
        UI.text("file-name-label", State.fileName);
        UI.$("drop-hint").classList.add("hidden");
        UI.$("pdf-canvas").classList.add("hidden");
        try { State.pins  = JSON.parse(dep.pins  || "[]"); } catch { State.pins = []; }
        try { State.zones = JSON.parse(dep.zones || "[]"); } catch { State.zones = []; }
        try { State.annotations = JSON.parse(dep.annotations || "[]"); } catch { State.annotations = []; }
        // [WO 20260917 멀티유저 ①] 페이지별 체크보드 시작번호 복원 — 컬럼 없는 구버전 배포본은
        //   dep.checkboard_start 가 undefined/null → {} → _checkboardStart()가 종전대로 1 반환.
        try { State.checkboardStart = JSON.parse(dep.checkboard_start || "{}") || {}; } catch { State.checkboardStart = {}; }
        // 🔴 [WO 20260928-pinloss] 저장 안 한 로컬 작업분(dirty draft)이 있으면 서버본 위에 복원.
        //   렌더(_r0) 전에 끝내야 첫 화면부터 draft 핀이 보이고, 이후 저장/자동보관이 draft 를 빈 목록으로 덮지 않는다.
        this._applyDirtyDraft(draft, dkey, dep.version);

        const imgEl = UI.$("map-image");
        // ponytail: fired flag prevents double-fire when image is already browser-cached
        let _ld0 = false;
        const _r0 = () => {
          if (_ld0) return; _ld0 = true;
          this._showMapViewport();
          UI.renderPinList(); UI.renderPinsOnMap();
          if (typeof Zones !== "undefined") { Zones.render(); Zones.renderList(); }
        };
        imgEl.onload = _r0;
        // [오프라인 도면연동] R2 URL 이미지가 오프라인(미캐시)으로 로드 실패하면
        //   로컬 draft(원본 dataURL)로 폴백하여 도면을 끊김없이 표시.
        // [P52 결함수정] 로컬 draft 도 없으면(전형: R2 객체 404/403) 종전엔 여기서 아무 일도
        //   안 일어나 핀·목록·구역이 영구히 렌더되지 않았다(State.pins 는 채워졌는데 화면은 빈 채로
        //   조용히 실패 — 마스터 신고: "체크보드 모드에서 핀 목록은 생기는데 마커가 안 생긴다").
        //   폴백 실패 시에도 _r0() 을 호출해 뷰포트+핀+구역만이라도 표시하고, 이미지만 못 불러왔다고
        //   정직하게 알린다(가짜 성공 표시 금지, §10-no-hardcoding 조용한 실패 금지).
        imgEl.onerror = () => {
          if (/^\/api\/r2\/object\//.test(pages[0] || "")) {
            Promise.resolve(this._restoreDraftLocal()).then((restored) => {
              if (!restored) {
                _r0();
                Prompt && Prompt.toast && Prompt.toast("도면 이미지를 불러오지 못했습니다 — 핀 목록은 정상 표시됩니다");
              }
            });
          } else {
            _r0();
            Prompt && Prompt.toast && Prompt.toast("도면 이미지를 불러오지 못했습니다 — 핀 목록은 정상 표시됩니다");
          }
        };
        imgEl.src = Auth.r2(pages[0]);
        imgEl.classList.remove("hidden");
        if (imgEl.complete && imgEl.naturalWidth) _r0(); // 캐시 히트 시 onload 미발화 대응

        State.autoSaveDepId = deploymentId;       // 이후 자동저장은 이 배포본 갱신
        State.currentDeploymentId = deploymentId;
        State.depVersion = (dep.version != null ? Number(dep.version) : 0); // [충돌방지] 로드 시점 버전 기록
      } catch (e) { await this._restoreDraftLocal(); }   // 네트워크 오류 → 로컬 폴백
    },

    /** 로컬(IndexedDB) draft 로부터 도면+핀+구역 복원 — 서버 실패/오프라인/새로고침 대응 */
    async _restoreDraftLocal(key) {
      try {
        if (typeof SyncQueue === "undefined") return false;
        const dkey = key || this._draftKey();
        const d = await SyncQueue.loadDraft(dkey);
        if (!d || !d.pages || !d.pages.length) return false;

        State.reset();
        State.fileType    = "image";          // draft 스냅샷은 dataURL 이미지
        this._applySourceMeta(null);          // [P14] 로컬 draft 에는 원본 PDF 가 없다(명시적 초기화)
        State.viewerPages = d.pages;
        State.pdfPage     = 1;
        State.fileName    = d.fileName || "도면";
        State.pins        = Array.isArray(d.pins)  ? d.pins  : [];
        State.zones       = Array.isArray(d.zones) ? d.zones : [];
        State.annotations = Array.isArray(d.annotations) ? d.annotations : [];
        // [WO 20260917 멀티유저 ①] 로컬 draft 에도 체크보드 시작번호 보존(오프라인 새로고침 대응)
        State.checkboardStart = (d.checkboardStart && typeof d.checkboardStart === "object") ? d.checkboardStart : {};
        if (d.depId) { State.autoSaveDepId = d.depId; State.currentDeploymentId = d.depId; }
        UI.text("file-name-label", State.fileName);
        UI.$("drop-hint").classList.add("hidden");
        UI.$("pdf-canvas").classList.add("hidden");

        const imgEl = UI.$("map-image");
        let _ld1 = false;
        const _r1 = () => {
          if (_ld1) return; _ld1 = true;
          this._showMapViewport();
          UI.renderPinList(); UI.renderPinsOnMap();
          if (typeof Zones !== "undefined") { Zones.render(); Zones.renderList(); }
        };
        imgEl.onload = _r1;
        // [P52 결함수정] 형제 호출부(loadDeckDrawing)와 동일한 결함 — 로컬 draft 이미지가
        //   못 불러와지면(손상/미캐시) 종전엔 아무 렌더도 안 일어났다. 실패해도 핀·구역은 표시.
        imgEl.onerror = () => {
          _r1();
          Prompt && Prompt.toast && Prompt.toast("도면 이미지를 불러오지 못했습니다 — 핀 목록은 정상 표시됩니다");
        };
        imgEl.src = Auth.r2(d.pages[0]);
        imgEl.classList.remove("hidden");
        if (imgEl.complete && imgEl.naturalWidth) _r1();
        if (d.dirty) {
          this._setSaveIndicator(navigator.onLine ? "saving" : "offline");
          // [B4] 미저장(서버 미반영) 상태를 사용자에게 명확히 — 저장버튼 강조 + 구역 '미저장' 배지
          this._markDirty();
          this._markDeckUnsaved(this._deckIdOfKey(dkey), true);
          if (navigator.onLine) setTimeout(() => this._flushDirtyDrafts(), 400);
        }
        Prompt && Prompt.toast && Prompt.toast("로컬에 보관된 도면을 복원했습니다" + (d.dirty ? " (아직 서버에 저장되지 않음 — ‘저장’을 누르세요)" : ""));
        return true;
      } catch (e) { return false; }
    },

    /** draft 키(`projectId::deckId`)에서 deckId 만 추출. 프로젝트 id 에 '::' 가 있어도 안전. */
    _deckIdOfKey(key) {
      const s = String(key || ""); const i = s.lastIndexOf("::");
      if (i < 0) return "";
      const did = s.slice(i + 2);
      return (did && did !== "nodeck") ? did : "";
    },

    /** 🔴 [WO 20260928-pinloss] 도면 로드 세대 번호 — 서버본 로더(loadDeckDrawing/loadLatestDeployment)는
     *  await 사이에 다른 로드가 시작되면(허브 구역 클릭 = openApp 의 자동 로드 + selectDeck 동시 발화)
     *  늦게 도착한 쪽이 State.pins 를 엉뚱한 구역의 서버본으로 덮었다. 마지막에 시작한 로드만 State 를 쓴다. */
    _loadSeq: 0,
    _beginLoad() { return ++this._loadSeq; },
    _isCurrentLoad(seq) { return seq === this._loadSeq; },

    /** 🔴 [WO 20260928-pinloss] 이 구역(key)의 **저장 안 한** 로컬 작업분(dirty draft)을 읽는다.
     *  다른 배포본을 기준으로 만든 draft(depId 불일치)는 이 서버본에 얹지 않는다(엉뚱한 도면에 핀 이식 금지). */
    async _readDirtyDraft(key, depId) {
      if (!key || typeof SyncQueue === "undefined" || !SyncQueue.loadDraft) return null;
      let d = null;
      try { d = await SyncQueue.loadDraft(key); } catch (e) { return null; }
      if (!d || !d.dirty) return null;
      if (d.depId && depId && String(d.depId) !== String(depId)) return null;
      return d;
    },

    /** 🔴 [WO 20260928-pinloss] 서버본 vs 로컬 draft 충돌 규칙 — **단일 출처**.
     *  화면 복원(_applyDirtyDraft)과 온라인 복귀 업로드(_flushDirtyDrafts)가 같은 규칙을 쓴다(갈라지면 한쪽이 핀을 잃는다).
     *  ① draft 가 기준으로 삼은 서버 버전(baseVer) == 지금 서버 버전 → 그 사이 아무도 저장 안 함 → draft 그대로
     *     (로컬에서 지운 핀이 서버본에서 되살아나지 않는다)
     *  ② 서버가 더 새롭거나 기준 버전을 모름(구버전 draft) → id 병합: 서버에만 있는 항목 보존 + 같은 id 는 draft 우선 */
    _draftVsServer(d, srvPins, srvZones, srvVer) {
      const same = d && d.baseVer != null && srvVer != null && Number(d.baseVer) === Number(srvVer);
      const dPins = Array.isArray(d && d.pins) ? d.pins : [];
      const dZones = Array.isArray(d && d.zones) ? d.zones : [];
      return same
        ? { pins: dPins, zones: dZones }
        : { pins: this._mergeById(srvPins || [], dPins), zones: this._mergeById(srvZones || [], dZones) };
    },

    /** 🔴 [WO 20260928-pinloss] 서버본을 State 에 올린 직후 호출 — dirty draft 가 있으면 그 작업분을 화면에 복원.
     *  종전엔 '미저장' 배지만 뜨고 핀은 서버본(0개)으로 그려졌고, 이어서 '저장'/다음 편집이 빈 목록으로
     *  draft 를 덮어 작업분이 영구 소실됐다(라이브 재현: 체크보드 핀 → 모드 전환 → 핀 사라짐 → 저장 → draft 0개). */
    _applyDirtyDraft(d, key, srvVer) {
      if (!d) return false;
      const m = this._draftVsServer(d, State.pins, State.zones, srvVer);
      State.pins = m.pins;
      State.zones = m.zones;
      if (Array.isArray(d.annotations)) State.annotations = d.annotations;
      if (d.checkboardStart && typeof d.checkboardStart === "object") State.checkboardStart = d.checkboardStart;
      this._markDirty();                                   // 저장 버튼 활성 — 서버에 아직 없다
      this._markDeckUnsaved(this._deckIdOfKey(key), true);
      return true;
    },

    /** [B4] 로컬에만 있고 서버 미저장인 구역 id 집합 — 사이드바 '미저장' 배지의 단일 출처 */
    _unsavedDecks: {},
    isDeckUnsaved(deckId) { return !!(deckId && this._unsavedDecks[deckId]); },
    _markDeckUnsaved(deckId, on) {
      if (!deckId) return;
      const had = !!this._unsavedDecks[deckId];
      if (on) this._unsavedDecks[deckId] = true; else delete this._unsavedDecks[deckId];
      if (had === !!on) return;                      // 변화 없음 → 재렌더 생략
      try { if (typeof Projects !== "undefined" && Projects._renderDecks) Projects._renderDecks(); } catch (e) {}
    },
    /** 로컬 draft 전수 스캔으로 '미저장 구역' 집합을 재구성(재진입/구역목록 갱신 시) */
    async _refreshUnsavedDecks() {
      try {
        if (typeof SyncQueue === "undefined" || !SyncQueue.allDraftKeys) return;
        const keys = (await SyncQueue.allDraftKeys()) || [];
        let changed = false;
        for (const k of keys) {
          const did = this._deckIdOfKey(k);
          if (!did) continue;
          let d = null;
          try { d = await SyncQueue.loadDraft(k); } catch (e) { continue; }
          const unsaved = !!(d && d.dirty && d.pages && d.pages.length);
          if (!!this._unsavedDecks[did] === unsaved) continue;
          if (unsaved) this._unsavedDecks[did] = true; else delete this._unsavedDecks[did];
          changed = true;
        }
        if (changed) { try { if (typeof Projects !== "undefined" && Projects._renderDecks) Projects._renderDecks(); } catch (e) {} }
      } catch (e) {}
    },

    /** [B1] 서버 배포본이 하나도 없는 프로젝트로 재진입했을 때 —
     *  로컬 draft(저장 버튼을 안 눌러 서버엔 없는 작업분)를 찾아 화면에 복원한다.
     *  이 경로가 없으면 사용자에겐 도면이 '사라진 것'으로 보인다. */
    async _restoreProjectDraft(pid) {
      try {
        if (!pid || typeof SyncQueue === "undefined" || !SyncQueue.allDraftKeys) return false;
        let keys = [];
        try { keys = (await SyncQueue.allDraftKeys()) || []; } catch (e) { return false; }
        const prefix = pid + "::";
        const mine = keys.filter((k) => typeof k === "string" && k.indexOf(prefix) === 0);
        if (!mine.length) return false;
        const decks = (typeof Projects !== "undefined" && Array.isArray(Projects.decks)) ? Projects.decks : [];
        let best = null, bestScore = -1, bestDeck = null;
        for (const k of mine) {
          let d = null;
          try { d = await SyncQueue.loadDraft(k); } catch (e) { continue; }
          if (!d || !d.pages || !d.pages.length) continue;
          const did = this._deckIdOfKey(k);
          const deck = did ? decks.find((x) => String(x.id) === String(did)) : null;
          const score = (deck ? 2 : 0) + (d.dirty ? 1 : 0);   // 실존 구역 > dirty 우선
          if (score > bestScore) { bestScore = score; best = k; bestDeck = deck || null; }
        }
        if (!best) return false;
        if (bestDeck && typeof Projects !== "undefined") Projects.currentDeck = bestDeck;
        const ok = await this._restoreDraftLocal(best);
        if (ok) { try { if (typeof Projects !== "undefined" && Projects._renderDecks) Projects._renderDecks(); } catch (e) {} }
        return ok;
      } catch (e) { return false; }
    },

    /** 온라인 복귀 시 dirty draft 를 서버로 자동 업로드 */
    async _flushDirtyDrafts() {
      if (!navigator.onLine) return;
      if (typeof SyncQueue === "undefined") return;
      let keys = [];
      try { keys = await SyncQueue.allDraftKeys(); } catch (e) { return; }
      for (const key of keys) {
        let d;
        try { d = await SyncQueue.loadDraft(key); } catch (e) { continue; }
        if (!d || !d.dirty || !d.pages || !d.pages.length) continue;
        try {
          const body = {
            title: d.fileName || "도면", file_name: d.fileName || "",
            pins: JSON.stringify(d.pins || []), zones: JSON.stringify(d.zones || []),
            annotations: JSON.stringify(d.annotations || []),
            drawing_data: d.pages[0], pages_data: JSON.stringify(d.pages)
          };
          // [P0-2] 구역(deck)에 속하지 않는 draft(`noproj::nodeck`)로 '새' 배포본을 만들면
          //   연결할 구역이 없어 고아 배포본이 된다 → 신규 생성은 건너뛰고 로컬 draft 는 그대로 보존한다.
          //   (기존 배포본 갱신(PATCH)은 연결이 이미 있으므로 그대로 진행)
          if (!d.depId && !this._deckIdOfKey(key)) continue;
          let res;
          // [발견/수정] srvPins/srvZones 는 아래 if(d.depId) 블록 밖(3449줄)에서도 참조되는데
          //   기존엔 블록 스코프(let)로만 선언돼 매 PATCH 성공마다 ReferenceError → 바깥 catch 가
          //   조용히 삼켜 draft 가 영원히 dirty:false 로 정리되지 않는 별개의 기존 결함이었다.
          //   함수 스코프로 끌어올려 근본수정(이번 401 처리와 같은 함수 안이라 함께 정리).
          let baseVer = 0, srvPins = null, srvZones = null;
          if (d.depId) {
            // [멀티유저 충돌방지] 오프라인 작업분 동기화도 낙관적 잠금.
            //   서버에서 최신 버전을 먼저 읽어 base_version 으로 첨부하고,
            //   서버 핀/구역과 오프라인 작업분을 병합하여 양쪽 모두 보존.
            try {
              const cur = await fetch("/tables/deployments/" + encodeURIComponent(d.depId), { headers: Auth.headers() });
              if (cur.ok) {
                const cj = await cur.json();
                baseVer = (cj.version != null ? Number(cj.version) : 0);
                try { srvPins = JSON.parse(cj.pins || "[]"); } catch (e) {}
                try { srvZones = JSON.parse(cj.zones || "[]"); } catch (e) {}
              }
            } catch (e) {}
            // 🔴 [WO 20260928-pinloss] 충돌 규칙은 화면 복원과 같은 단일 출처(_draftVsServer)
            if (srvPins || srvZones) {
              const m = this._draftVsServer(d, srvPins, srvZones, baseVer);
              if (srvPins) body.pins = JSON.stringify(m.pins);
              if (srvZones) body.zones = JSON.stringify(m.zones);
            }
            body.base_version = baseVer;
            res = await fetch("/tables/deployments/" + encodeURIComponent(d.depId), {
              method: "PATCH", headers: Auth.headers(), body: JSON.stringify(body)
            });
          } else {
            res = await fetch("/tables/deployments", {
              method: "POST", headers: Auth.headers(), body: JSON.stringify(body)
            });
          }
          if (!res.ok) {
            // [P16] 401/403(토큰 만료) → 공유 지점(Auth.authExpired)에서 세션당 1회 안내 + 재로그인 게이트.
            //   그 외 실패는 종전처럼 조용히 재시도(dirty 유지). 큐/드래프트는 어떤 경우에도 보존.
            if ((res.status === 401 || res.status === 403) && typeof Auth !== "undefined" && Auth.authExpired) Auth.authExpired();
            continue;                              // 실패 → dirty 유지, 다음 기회에 재시도
          }
          const rec = await res.json().catch(() => null);
          const wasNew = !d.depId;                // POST 로 '새' 배포본을 만든 경우
          d.depId = (rec && rec.id) ? rec.id : d.depId;
          d.dirty = false;
          // [B2] 자동 동기화가 만든 새 배포본도 반드시 구역(deck)에 연결한다.
          //   연결을 빠뜨리면 배포본은 서버에 있는데 구역엔 '도면없음'인 고아가 되어
          //   사용자에겐 도면이 사라진 것으로 보인다. (draft 키 = projectId::deckId)
          if (wasNew && d.depId) {
            try {
              const deckId = this._deckIdOfKey(key);
              if (deckId) {
                const deckObj = (typeof Projects !== "undefined" && Array.isArray(Projects.decks))
                  ? Projects.decks.find((x) => String(x.id) === String(deckId)) : null;
                const linked = await this._linkDeckDeployment(deckId, d.depId, deckObj);
                if (linked && deckObj) {
                  deckObj.deployment_id = d.depId;
                  try { Projects._renderDecks && Projects._renderDecks(); } catch (e) {}
                }
              }
            } catch (e) { /* 연결 실패 → _deckLinkQueue 가 다음 기회에 재시도 */ }
          }
          this._markDeckUnsaved(this._deckIdOfKey(key), false);   // [B4] 서버 반영됨 → 배지 해제
          // 병합된 핀/구역을 draft 에도 반영(다음 동기화 기준 정합)
          if (srvPins)  { try { d.pins  = JSON.parse(body.pins  || "[]"); } catch (e) {} }
          if (srvZones) { try { d.zones = JSON.parse(body.zones || "[]"); } catch (e) {} }
          await SyncQueue.saveDraft(key, d);
          if (key === this._draftKey() && d.depId) {
            State.autoSaveDepId = d.depId; State.currentDeploymentId = d.depId;
            if (rec && rec.version != null) State.depVersion = Number(rec.version); // 버전 동기화
            this._setSaveIndicator("saved");
          }
        } catch (e) { /* 네트워크 단절 — 다음 online 때 */ }
      }
    },

    /** 도면 업로드 직후 1회: 배포본 생성(도면 스냅샷 포함) */
    /** 현재 도면 draft 의 로컬 키 — 구역(deck) 단위로 1개 보관 */
    _draftKey() {
      const pid = (typeof Projects !== "undefined" && Projects.currentProject) ? Projects.currentProject.id : "noproj";
      const did = (typeof Projects !== "undefined" && Projects.currentDeck) ? Projects.currentDeck.id : "nodeck";
      return pid + "::" + did;
    },

    /** 도면 스냅샷+핀+구역을 로컬(IndexedDB)에 영속 저장 — 오프라인/서버실패에도 절대 소실 안 됨 */
    async _saveDraftLocal(pages) {
      try {
        if (typeof SyncQueue === "undefined") return false;
        const snap = (pages && pages.length) ? pages : await this._snapshotPages();
        if (!snap || !snap.length) return false;
        const payload = {
          fileName:    State.fileName || "도면",
          fileType:    State.fileType || "image",
          pages:       snap,
          pins:        State.pins || [],
          zones:       (typeof Zones !== "undefined" && State.zones) ? State.zones : [],
          annotations: State.annotations || [],
          checkboardStart: State.checkboardStart || {}, // [WO 20260917 멀티유저 ①]
          depId:       State.autoSaveDepId || null,
          // 🔴 [WO 20260928-pinloss] 이 작업분이 기준으로 삼은 서버 버전 — 재로드 시 충돌 규칙(_draftVsServer) 판정용
          baseVer:     (State.autoSaveDepId && State.depVersion != null) ? Number(State.depVersion) : null,
          dirty:       true                       // 서버 미반영분 표시 → online 시 업로드
        };
        const dkey = this._draftKey();
        await SyncQueue.saveDraft(dkey, payload);
        // [B4] 서버 미반영(로컬 전용) 구역 표시 — 저장을 눌렀는지 사용자가 알 수 있게
        this._markDeckUnsaved(this._deckIdOfKey(dkey), true);
        return true;
      } catch (e) { return false; }
    },

    /** 기존 구역 도면을 새 도면으로 교체(같은 배포본 ID 덮어쓰기) — 고아 배포본 방지 */
    async _replaceDeckDrawing(depId) {
      if (State.mode !== "designer" || !depId) return;
      State.autoSaveDepId = depId;
      State.currentDeploymentId = depId;
      let pages = null;
      try {
        this._setSaveIndicator("saving");
        pages = await this._snapshotPages();
        if (!pages.length) { this._setSaveIndicator("error"); return; }
        await this._saveDraftLocal(pages);                       // 로컬 우선 보관(원본 dataURL)
        // [마스터 요청 (나)] 교체 도면도 R2 업로드 후 URL 저장(실패 시 base64 폴백)
        // [P14 버그수정] PDF 가 로드 안 된 경로(이미지 도면)에서도 안전하게(형제: L3039 패턴)
        let dims = null; try { dims = PDF.lastSnapshotDims; } catch (e) {}
        const r2pages = await this._uploadPagesToR2(pages);
        const srcMeta = await this._buildSourceMeta(dims);     // [P14] 교체 도면도 원본 보관
        // [멀티유저 충돌방지] 낙관적 잠금 PATCH — 409면 병합 후 재시도
        const r = await this._patchDeployment(depId, () => this._buildSavePayload(r2pages, srcMeta));
        if (!r.ok) throw new Error("HTTP " + (r.status || "fail"));
        await this._markDraftClean(pages);
        this._setSaveIndicator("saved");
      } catch (e) {
        if (pages) await this._saveDraftLocal(pages);           // 실패 시 로컬 보관(online 복귀시 업로드)
        this._setSaveIndicator(navigator.onLine ? "error" : "offline");
      }
    },

    async _createInitialSave() {
      if (State.mode !== "designer") return;
      if (State.autoSaveDepId) return; // 이미 생성됨
      if (!State.fileType) return;
      let pages = null;
      try {
        this._setSaveIndicator("saving");
        pages = await this._snapshotPages();
        if (!pages.length) { this._setSaveIndicator("error"); return; }
        // 먼저 로컬에 무조건 보관(서버 성공 여부와 무관하게 도면 소실 방지) — 원본 dataURL 보존
        await this._saveDraftLocal(pages);
        // [마스터 요청 (나)] 도면 바이너리를 R2에 올리고 URL로 치환(실패 시 base64 폴백)
        // [P14 버그수정] PDF 가 로드 안 된 경로(이미지 도면)에서도 안전하게(형제: L3039 패턴)
        let dims = null; try { dims = PDF.lastSnapshotDims; } catch (e) {}
        const r2pages = await this._uploadPagesToR2(pages);
        const srcMeta = await this._buildSourceMeta(dims);     // [P14] 신규 배포본에 원본 PDF 보관
        const body = this._buildSavePayload(r2pages, srcMeta);
        const res = await fetch("/tables/deployments", {
          method: "POST",
          headers: Auth.headers(),
          body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const rec = await res.json();
        State.autoSaveDepId = (rec && rec.id) ? rec.id : null;
        State.currentDeploymentId = State.autoSaveDepId;
        // 서버 저장 성공 → 로컬 draft 의 dirty 해제(스냅샷은 백업으로 유지)
        await this._markDraftClean(pages);
        this._setSaveIndicator("saved");
      } catch (e) {
        // 서버 실패/오프라인 → 로컬 draft 는 이미 보관됨. 사용자에겐 '로컬 보관' 표시.
        if (pages) await this._saveDraftLocal(pages);
        this._setSaveIndicator(navigator.onLine ? "error" : "offline");
      }
    },

    /** 서버 저장 성공분의 로컬 draft dirty=false 로 표시(여전히 로컬 백업 유지) */
    async _markDraftClean(pages) {
      try {
        if (typeof SyncQueue === "undefined") return;
        const payload = {
          fileName: State.fileName || "도면", fileType: State.fileType || "image",
          pages: (pages && pages.length) ? pages : await this._snapshotPages(),
          pins: State.pins || [], zones: State.zones || [], annotations: State.annotations || [],
          depId: State.autoSaveDepId || null, dirty: false
        };
        if (payload.pages && payload.pages.length) await SyncQueue.saveDraft(this._draftKey(), payload);
      } catch (e) {}
    },

    /** [마스터: 자동저장 OFF] 핀/영역/도면 변경 시 — 서버 즉시저장 대신
     *  로컬 draft 로 즉시 보존(소실 방지) + 'dirty' 표시 → 실제 서버 반영은 '저장' 버튼(_saveNow). */
    _autoSave(opts) {
      if (State.mode !== "designer") return;
      opts = opts || {};
      if (opts.withPages) this._dirtyPages = true;        // 도면 페이지도 다음 저장에 포함
      // 로컬 우선 보관(새로고침/오프라인에도 작업 보존) — 비차단
      this._saveDraftLocal(opts.withPages ? null : null).catch(() => {});
      this._markDirty();
    },

    /** 실제 서버 저장(수동 '저장' 버튼). 배포본 없으면 생성+구역연결, 있으면 PATCH.
     *  @returns {Promise<boolean>} 서버 반영 성공 여부(가드 차단·중복호출·실패는 false).
     *    '뷰어로 배포'(_deployToViewer)가 이 경로를 그대로 재사용하므로 결과를 반드시 알려야 한다. */
    async _saveNow(opts) {
      if (State.mode !== "designer") return false;
      opts = opts || {};
      if (this.autoSaving) return false;
      this.autoSaving = true;
      try {
        // [P0-2] 신규 배포본을 만들려는데 프로젝트/구역 컨텍스트가 없으면 중단.
        //   그대로 POST 하면 어느 구역에도 연결되지 않는 '고아 배포본'이 생기고(동일 도면 중복 생성),
        //   사용자에겐 구역이 계속 '도면없음'으로 보인다. 기존 배포본 갱신(PATCH)은 영향 없다.
        if (!State.autoSaveDepId) {
          const hasCtx = (typeof Projects !== "undefined") && !!Projects.currentProject && !!Projects.currentDeck;
          if (!hasCtx) {
            this._setSaveIndicator("error");
            Prompt.toast && Prompt.toast("저장할 구역이 없습니다 — 프로젝트와 구역을 먼저 선택하세요(도면은 구역에 연결되어야 저장됩니다)");
            return false;
          }
        }
        this._setSaveIndicator("saving");
        if (!State.autoSaveDepId) {
          // 신규: _createInitialSave 가 도면(R2 업로드)+핀 전체를 저장
          await this._createInitialSave();
          if (!State.autoSaveDepId) {
            // [결함수정 2026-09-18] 모바일은 #autosave-text 가 CSS로 숨겨져(style.css) 인디케이터만으론
            // 실패가 안 보인다 — 토스트로 반드시 알린다(기존 토스트 경로 재사용, 새 배지 없음).
            this._setSaveIndicator(navigator.onLine ? "error" : "offline");
            try { Prompt.toast && Prompt.toast(navigator.onLine ? "저장 실패 — 도면 저장에 실패했습니다. 다시 시도해 주세요" : "오프라인 — 로컬 보관됨(연결 후 저장)"); } catch (e) {}
            return false;
          }
          // 도면 업로드로 대기 중이던 구역 연결 마무리
          if (this._pendingDeckLink) {
            const p = this._pendingDeckLink; this._pendingDeckLink = null;
            if (p.deck) { p.deck.deployment_id = State.autoSaveDepId; try { Projects._renderDecks && Projects._renderDecks(); } catch (e) {} }
            await this._linkDeckDeployment(p.deckId, State.autoSaveDepId, p.deck);
          } else if (typeof Projects !== "undefined" && Projects.currentDeck && !Projects.currentDeck.deployment_id && State.autoSaveDepId) {
            // [견고화] _pendingDeckLink 가 소실(새로고침 등)됐어도 현재 구역에 새 도면을 자동 연결
            //   → "도면을 등록·저장했는데 구역에 안 붙어 도면없음으로 보이는" 회귀 방지
            const cd = Projects.currentDeck;
            cd.deployment_id = State.autoSaveDepId;
            try { Projects._renderDecks && Projects._renderDecks(); } catch (e) {}
            await this._linkDeckDeployment(cd.id, State.autoSaveDepId, cd);
          }
        } else {
          // 기존: PATCH. 도면이 실제로 변경됐을 때만 재스냅샷·R2 재업로드.
          // 그 외엔 이미 저장된 pages(R2 URL)를 그대로 전달 → 불필요한 재업로드·스냅샷 실패 방지.
          let pages = null, srcMeta = null;
          if (this._dirtyPages) {
            pages = await this._snapshotPages();
            // [P14 버그수정] PDF 가 로드 안 된 경로(이미지 도면)에서도 안전하게(형제: L3039 패턴)
            let dims = null; try { dims = PDF.lastSnapshotDims; } catch (e) {}  // 실측 픽셀(스냅샷 직후 채취)
            if (pages && pages.length) pages = await this._uploadPagesToR2(pages);
            srcMeta = await this._buildSourceMeta(dims);       // PDF 원본 -> R2 (이미지 도면이면 null)
          } else if (State.viewerPages && State.viewerPages.length) {
            pages = State.viewerPages.filter(p => typeof p === "string" && p.indexOf("blob:") !== 0);
            if (!pages.length) pages = null;
          }
          await this._saveDraftLocal(pages);
          const r = await this._patchDeployment(State.autoSaveDepId, () => this._buildSavePayload(pages, srcMeta));
          if (!r.ok) throw new Error("HTTP " + (r.status || "fail"));
          await this._markDraftClean(pages);
        }
        this._dirty = false; this._dirtyPages = false; this._updateSaveBtn();
        try { this._markDeckUnsaved(this._deckIdOfKey(this._draftKey()), false); } catch (e) {}  // [B4]
        this._setSaveIndicator("saved");
        // [마스터: 저장 확인이 안 됨] 명확한 완료 피드백(모바일 토스트)
        try { Prompt.toast && Prompt.toast("저장 완료"); } catch (e) {}
        return true;
      } catch (e) {
        this._setSaveIndicator(navigator.onLine ? "error" : "offline");
        try { Prompt.toast && Prompt.toast(navigator.onLine ? "저장 실패 — 다시 시도해 주세요" : "오프라인 — 로컬 보관됨(연결 후 저장)"); } catch (e) {}
        return false;
      } finally {
        this.autoSaving = false;
      }
    },

    /** 미저장 변경 표시 — '저장' 버튼 활성화 */
    _markDirty() {
      if (State.mode !== "designer") return;
      this._dirty = true;
      this._updateSaveBtn();
    },

    _updateSaveBtn() {
      const b = UI.$("btn-save");
      if (!b) return;
      if (this._dirty) {
        b.classList.remove("hidden", "is-clean"); b.classList.add("is-dirty");
        b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15" aria-hidden="true" style="vertical-align:-2px"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> 저장 *'; b.disabled = false;
      } else {
        b.classList.remove("is-dirty"); b.classList.add("is-clean");
        b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15" aria-hidden="true" style="vertical-align:-2px"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> 저장됨'; b.disabled = true;
      }
    },

    async _deployToViewer() {
      const btn    = UI.$("btn-deploy");
      const status = UI.$("deploy-status");

      if (State.pins.length === 0) { alert("배포할 핀이 없습니다. 먼저 포인트를 추가하세요."); return; }
      if (typeof Log !== "undefined") Log.push("deploy.click", null, { pins: State.pins.length });

      // ── 오프라인 등록은 허용하되, 서버 빌드(배포)는 인증 완료 필수 ──
      // (요구사항: 오프라인일 때 등록은 가능하지만 서버에 빌드하려면 반드시 인증이 완료되어야 함)
      if (!navigator.onLine) {
        alert("현재 오프라인 상태입니다.\n\n• 포인트/도면 '등록'은 계속 가능합니다(자동 임시저장).\n• 단, 서버에 '빌드(배포)'하려면 인터넷 연결 + 인증 완료가 필요합니다.\n\n인터넷에 연결한 뒤 다시 시도해 주세요.");
        return;
      }
      const authed = (typeof Auth !== "undefined") && !!Auth.idToken && !!Auth.user;
      if (!authed || !Auth.isDesigner) {
        alert("서버 빌드(배포)에는 설계자 인증이 필요합니다.\n\nGoogle 로그인 또는 @seastargo.com 계정으로 로그인하고 인증을 완료한 뒤 다시 시도해 주세요.");
        if (typeof Auth !== "undefined" && Auth.requireDesigner) { try { Auth.requireDesigner(() => this._deployToViewer()); } catch (e) {} }
        return;
      }

      // 미동기화(오프라인 임시 저장) 핀이 있으면 배포 전에 먼저 서버로 일괄 업로드
      const hasPending = State.pins.some(p => p.pendingOpId || (p.attachments || []).some(a => a.pendingOpId));
      if (hasPending) {
        if (!navigator.onLine) {
          alert("아직 업로드되지 않은 오프라인 핀이 있습니다. 인터넷에 연결한 뒤 다시 배포해 주세요.");
          return;
        }
        btn.disabled = true; btn.textContent = "임시 저장 핀 업로드 중...";
        const r = await SyncQueue.flush();
        this._onSyncDone(r);
        if (State.pins.some(p => p.pendingOpId || (p.attachments || []).some(a => a.pendingOpId))) {
          alert("일부 핀 업로드에 실패했습니다. 네트워크를 확인하고 다시 시도해 주세요.");
          btn.disabled = false; btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15" aria-hidden="true" style="vertical-align:-2px"><path d="M12 19V5"/><polyline points="5 12 12 5 19 12"/></svg> 뷰어로 배포';
          return;
        }
      }

      // 저장 경로(_createInitialSave)와 동일한 전제: 도면(fileType)이 없으면 배포본을 만들 수 없다.
      if (!State.fileType) {
        alert("도면이 없습니다. 먼저 도면을 업로드하세요.");
        btn.disabled = false; btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15" aria-hidden="true" style="vertical-align:-2px"><path d="M12 19V5"/><polyline points="5 12 12 5 19 12"/></svg> 뷰어로 배포';
        return;
      }

      btn.disabled = true; btn.textContent = "배포 중...";
      status.classList.add("hidden"); status.classList.remove("error");

      try {
        // [근본수정] 배포가 '저장'과 별개로 /tables/deployments 에 무조건 POST 하던 경로를 제거한다.
        //   그 경로는 (a) 프로젝트/구역 컨텍스트가 없으면 어디에도 연결 안 되는 고아 배포본을 만들고,
        //   (b) 구역에 이미 deployment_id 가 있으면 배포할 때마다 배포본이 하나씩 더 생기는데
        //       구역은 옛 ID 를 계속 가리키고 작업본(State.autoSaveDepId)만 새 ID 로 갈아타
        //       "저장했는데 구역에 반영 안 됨"이 발생했다.
        //   → 배포 = 저장(_saveNow) 재사용. 신규면 생성+구역연결, 기존이면 그 배포본을 PATCH.
        //     배포본은 언제나 1구역 1개이고, 뷰어 링크는 그 ID 를 그대로 쓴다.
        btn.textContent = "서버 저장 중...";
        this._dirtyPages = true;                       // 배포는 항상 현재 도면 스냅샷을 반영
        const saved = await this._saveNow({ now: true, withPages: true });
        const depId = saved ? State.autoSaveDepId : null;
        if (!depId) throw new Error("저장이 완료되지 않았습니다 — 프로젝트/구역 선택과 네트워크를 확인하세요");

        // [불변식] 배포 후 "구역.deployment_id === State.autoSaveDepId".
        //   _saveNow 는 신규 생성 시에만 구역을 연결한다. 기존 배포본을 PATCH 한 경우
        //   구역이 다른(옛) ID 를 가리키고 있으면 저장 결과가 구역에서 보이지 않으므로 여기서 재연결한다.
        try {
          const cd = (typeof Projects !== "undefined") ? Projects.currentDeck : null;
          if (cd && String(cd.deployment_id || "") !== String(depId)) {
            cd.deployment_id = depId;
            await this._linkDeckDeployment(cd.id, depId, cd);
          }
          if (typeof Projects !== "undefined" && Projects._renderDecks) Projects._renderDecks();
        } catch (e) {}

        const pageCount = (State.viewerPages && State.viewerPages.length) || State.pdfPages || 1;

        // [버그수정] location.origin 은 배포별 임시 서브도메인(xxxx.scan360.pages.dev)일 수 있어
        //   그 링크는 '옛 코드'를 영구히 가리킨다(401 등) → 고정 production 도메인으로 정규화.
        let _origin = location.origin;
        const _m = _origin.match(/^https?:\/\/[a-f0-9]{6,}\.(scan360\.pages\.dev)$/i);
        if (_m) _origin = "https://" + _m[1];
        const viewerUrl = _origin + location.pathname +
          "?mode=viewer" + (depId ? "&d=" + encodeURIComponent(depId) : "");
        // [C-LOOP1 결함1] 공유가 목적인 시스템 → 원클릭 링크 복사 버튼 제공
        status.innerHTML =
          "배포 완료! (" + pageCount + "페이지 / " + State.pins.length + "핀)<br>" +
          "뷰어 전용 링크:<br>" +
          "<a id='deploy-link' href='" + viewerUrl + "' target='_blank' style='color:#10b981;word-break:break-all'>" + viewerUrl + "</a><br>" +
          "<button id='btn-copy-link' type='button' style='margin-top:8px;padding:6px 14px;border-radius:8px;border:1px solid #10b981;background:transparent;color:#10b981;cursor:pointer;font-size:13px'>링크 복사</button>";
        status.classList.remove("hidden");
        // 복사 버튼 핸들러 (clipboard API + execCommand 폴백)
        const copyBtn = document.getElementById("btn-copy-link");
        if (copyBtn) {
          copyBtn.addEventListener("click", async () => {
            const ok = await App._copyToClipboard(viewerUrl);
            copyBtn.textContent = ok ? "복사됨!" : "복사 실패 — 링크를 길게 눌러 복사하세요";
            setTimeout(() => { copyBtn.textContent = "링크 복사"; }, 2200);
          });
        }
      } catch (e) {
        status.textContent = "배포 실패: " + e.message;
        status.classList.add("error");
        status.classList.remove("hidden");
      } finally {
        btn.disabled = false; btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15" aria-hidden="true" style="vertical-align:-2px"><path d="M12 19V5"/><polyline points="5 12 12 5 19 12"/></svg> 뷰어로 배포';
      }
    },

    /* ── 클립보드 복사 (Clipboard API → execCommand 폴백) ── */
    async _copyToClipboard(text) {
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch (e) { /* 폴백으로 진행 */ }
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        return ok;
      } catch (e) { return false; }
    },

    /* ── 뷰어: 최신 배포본 자동 로드 ── */
    async loadLatestDeployment(projectForDesigner) {
      const seq = this._beginLoad();   // 🔴 [WO 20260928-pinloss] 늦게 도착하면 폐기(아래 _isCurrentLoad)
      let draftKey = null, draft = null; // 설계자 재진입으로 연 구역의 dirty draft(복원 대상)
      const statusEl = UI.$("viewer-load-status");
      statusEl.textContent = "도면 불러오는 중...";

      try {
        // [B1] 링크에 배포 ID(?d=)가 있으면 그 배포본을 정확히 로드
        const params = new URLSearchParams(location.search);
        // [P61] 공유 링크 `/srview/<이름>-<토큰>` 으로 들어온 경우 서버가 해석해 준 배포본을 쓴다.
        //   `?d=` 와 동일한 자리에 들어가므로 이후 로직(로드/폴백)은 한 줄도 갈라지지 않는다.
        let wantId = params.get("d") || ((typeof ShareLink !== "undefined" && ShareLink.deploymentId) || null);
        let latest = null;

        // [N4] 설계자 프로젝트 재진입: 그 프로젝트 deck 의 배포본을 로드(작업 복원)
        if (!wantId && projectForDesigner) {
          try {
            // [W8 오프라인] 끊긴 상태면 서버 대신 다운로드한 데크(IndexedDB)에서 deployment_id 해석.
            //   [견고화] 온라인이어도 네트워크가 죽으면 6초 타임아웃 후 오프라인 데크로 폴백.
            let decks = [];
            if (!navigator.onLine && typeof OfflineLoad !== "undefined") {
              decks = (await OfflineLoad.decks(projectForDesigner.id)) || [];
            } else {
              try {
                const ctrl = new AbortController();
                const t = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, 6000);
                try {
                  const dr = await fetch("/api/projects/" + encodeURIComponent(projectForDesigner.id) + "/decks", { headers: Auth.headers(), signal: ctrl.signal });
                  const dj = await dr.json();
                  decks = dj.data || [];
                } finally { clearTimeout(t); }
              } catch (e) {
                if (typeof OfflineLoad !== "undefined") decks = (await OfflineLoad.decks(projectForDesigner.id)) || [];
              }
            }
            // 🔴 [WO 20260928-pinloss] 그 사이 selectDeck 등 다른 로드가 시작됐으면 현재 구역을 빼앗지 않는다
            if (!this._isCurrentLoad(seq)) return;
            if (typeof Projects !== "undefined") Projects.decks = decks;
            const deck = decks.find(d => d.deployment_id);
            if (deck) { wantId = deck.deployment_id; if (typeof Projects !== "undefined") Projects.currentDeck = deck; }
            // 🔴 [WO 20260928-pinloss] 저장 안 한 작업분은 배포본 fetch **전에** 읽는다(형제 loadDeckDrawing 과 같은 이유)
            if (deck && State.mode === "designer") {
              draftKey = projectForDesigner.id + "::" + deck.id;
              draft = await this._readDirtyDraft(draftKey, wantId);
            }
          } catch (e) {}
          if (!wantId) {   // 새/빈 프로젝트 → 도면 없음(다른 프로젝트 도면을 잘못 띄우지 않음)
            statusEl.textContent = "";
            // [B1] 서버 배포본이 없어도 '저장 전' 로컬 draft 가 있으면 복원한다.
            //   (자동저장 OFF 정책 하에선 저장 버튼을 안 누른 작업이 로컬에만 존재한다)
            try { await this._restoreProjectDraft(projectForDesigner.id); } catch (e) {}
            try { this._refreshUnsavedDecks(); } catch (e) {}
            return;
          }
        }

        if (wantId) {
          // [W8 오프라인] 배포본도 캐시에서 우선 복원. [견고화] 온라인이어도 실패/타임아웃 시 캐시 폴백.
          if (!navigator.onLine && typeof OfflineLoad !== "undefined") {
            latest = await OfflineLoad.deployment(wantId);
          } else {
            try {
              const ctrl = new AbortController();
              const t = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, 6000);
              try {
                const r1 = await fetch("/tables/deployments/" + encodeURIComponent(wantId), { headers: Auth.headers(), signal: ctrl.signal });
                if (r1.ok) latest = await r1.json();
              } finally { clearTimeout(t); }
            } catch (e) {}
            if (!latest && typeof OfflineLoad !== "undefined") latest = await OfflineLoad.deployment(wantId);
          }
        }

        // 없거나 실패 시 최신 배포본으로 폴백 (뷰어만 — 설계자는 위에서 프로젝트 스코프)
        if (!latest && !projectForDesigner) {
          const res = await fetch("/tables/deployments?limit=100", { headers: Auth.headers() });
          if (!res.ok) throw new Error("HTTP " + res.status);
          const json = await res.json();
          const rows = (json.data || []).filter(r => (r.drawing_data || r.pages_data) && !r.deleted);
          if (rows.length === 0) {
            statusEl.textContent = "아직 배포된 도면이 없습니다.";
            UI.$("pin-empty").textContent = "아직 배포된 도면이 없습니다.\n설계자가 배포하면 자동 표시됩니다.";
            return;
          }
          // [B4] created_at가 숫자(epoch)/ISO 문자열 어느 쪽이든 안전 정렬
          const ts = r => {
            const v = r.created_at;
            const n = (typeof v === "number") ? v : Date.parse(v);
            return Number.isFinite(n) ? n : 0;
          };
          rows.sort((a, b) => ts(b) - ts(a));
          latest = rows[0];
        }

        if (!this._isCurrentLoad(seq)) return;   // 🔴 [WO 20260928-pinloss] 늦게 도착한 로드 — State 를 덮지 않는다
        // 페이지 배열 복원 (신규 pages_data → 레거시 drawing_data)
        let pages = [];
        try { pages = JSON.parse(latest.pages_data || "[]"); } catch { pages = []; }
        if (!Array.isArray(pages) || pages.length === 0) pages = [latest.drawing_data];

        State.currentDeploymentId = latest.id || null;  // 노트/협업 연결
        // [N4] 설계자 재진입: 이후 편집이 새 배포본을 만들지 않고 이 배포본을 갱신하도록
        if (projectForDesigner && latest.id) { State.autoSaveDepId = latest.id; State.depVersion = (latest.version != null ? Number(latest.version) : 0); }
        State.fileType   = "image";
        this._applySourceMeta(latest);  // [P14] 원본 PDF 위치/실측 픽셀(구버전이면 전부 null)
        State.viewerPages = pages;
        State.pdfPage    = 1;
        State.fileName   = latest.file_name || latest.title || "배포 도면";
        UI.text("file-name-label", State.fileName);
        UI.$("drop-hint").classList.add("hidden");
        UI.$("pdf-canvas").classList.add("hidden");

        try { State.pins = JSON.parse(latest.pins || "[]"); }
        catch { State.pins = []; }
        try { State.zones = JSON.parse(latest.zones || "[]"); }
        catch { State.zones = []; }
        try { State.annotations = JSON.parse(latest.annotations || "[]"); }
        catch { State.annotations = []; }
        // [WO 20260917 멀티유저 ①] 구버전 배포본(컬럼 없음) → {} → 종전대로 시작번호 1
        try { State.checkboardStart = JSON.parse(latest.checkboard_start || "{}") || {}; }
        catch { State.checkboardStart = {}; }
        // 🔴 [WO 20260928-pinloss] 형제 로더(loadDeckDrawing)와 같은 공유 지점 — 저장 안 한 작업분 복원
        if (draft && latest.id === wantId) this._applyDirtyDraft(draft, draftKey, latest.version);

        const imgEl = UI.$("map-image");
        let _ld2 = false;
        const _r2 = () => {
          if (_ld2) return; _ld2 = true;
          this._showMapViewport();
          UI.renderPinList();
          UI.renderPinsOnMap();
          if (typeof Zones !== "undefined") { Zones.render(); Zones.renderList(); }
          if (typeof PdfAnno !== "undefined") PdfAnno.refresh();
          if (typeof Notes !== "undefined") Notes.loadSummary();
        };
        imgEl.onload = _r2;
        // [P52 결함수정] 🔴 근본원인 — 이 경로(프로젝트 재진입 시 최신 배포본 자동복원)엔
        //   onerror 핸들러가 아예 없었다. 도면 이미지가 R2 접근 실패(404/403/네트워크)로
        //   못 불러와지면 _r2() 가 영영 안 불려 _showMapViewport()·renderPinsOnMap()·
        //   renderPinList() 가 전부 스킵 — State.pins 는 채워졌는데 뷰포트는 hidden 그대로,
        //   마커 0개로 조용히 실패했다(마스터 신고: "목록엔 생기는데 핀 마커가 안 생긴다").
        //   #map-viewport 는 CSS 상 position:absolute inset:0(부모 기준 고정 크기)라 이미지
        //   자연크기와 무관하게 뜨므로, 실패해도 _r2() 를 그대로 호출해 핀·목록·구역만은
        //   정상 표시한다 — 대신 이미지가 안 떴다는 사실은 정직하게 알린다(가짜 성공 금지).
        imgEl.onerror = () => {
          _r2();
          statusEl.textContent = "도면 이미지를 불러오지 못했습니다 — 핀은 정상 표시됩니다(사유: 이미지 접근 실패)";
        };
        imgEl.src = Auth.r2(pages[0]);
        imgEl.classList.remove("hidden");
        if (imgEl.complete && imgEl.naturalWidth) _r2();

        // [C-LOOP1 결함2] 뷰어 첫 진입 어포던스 — 핀 클릭으로 360°가 열림을 명시
        if (State.pins.length > 0) {
          statusEl.innerHTML =
            "로드 완료 (" + pages.length + "페이지 / " + State.pins.length + "개 포인트)<br>" +
            "<span style='color:var(--green)'>도면 위 번호 핀을 클릭하면 360° 파노라마가 열립니다.</span>";
        } else {
          statusEl.textContent = "배포본 로드 완료 (" + pages.length + "페이지 / 포인트 없음)";
        }
        UI.renderPinList();
      } catch (e) {
        statusEl.textContent = "불러오기 실패: " + e.message;
      }
    },

    /* ── Export JSON ── */
    _exportJson() {
      const data = JSON.stringify({ fileName: State.fileName, pins: State.pins }, null, 2);
      const blob = new Blob([data], { type: "application/json" });
      const a = document.createElement("a");
      a.href     = URL.createObjectURL(blob);
      a.download = "360_points.json";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); document.body.removeChild(a); }, 1000);
    },
  };

  /* ══════════════════════════════════════════
     ALL-PINS DRAWER — 전체 핀 리스트 보기
     · 모든 페이지의 핀을 이름/번호순으로 한눈에
     · 검색, 360°/문서 미리보기 썸네일, 클릭 시 페이지 구분 없이 줌인+360° 오픈
  ══════════════════════════════════════════ */
  const AllPins = {
    open: false,
    sort: "page",     // 'page' | 'name'
    query: "",
    _thumbCache: {},  // imageId → dataURL (썸네일 1회 fetch 캐시)

    init() {
      const $ = (id) => document.getElementById(id);
      $("btn-all-pins") && $("btn-all-pins").addEventListener("click", () => this.toggle());
      $("btn-allpins-close") && $("btn-allpins-close").addEventListener("click", () => this.hide());
      $("allpins-backdrop") && $("allpins-backdrop").addEventListener("click", () => this.hide());
      const search = $("allpins-search-input");
      if (search) search.addEventListener("input", () => { this.query = search.value.trim().toLowerCase(); this.render(); });
      document.querySelectorAll(".allpins-sort-btn").forEach((b) => {
        b.addEventListener("click", () => {
          this.sort = b.dataset.sort;
          document.querySelectorAll(".allpins-sort-btn").forEach((x) => x.classList.toggle("active", x === b));
          this.render();
        });
      });
      // 단축키 P 로 토글 (입력 중/파노라마 열림 제외)
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && this.open) { this.hide(); return; }
        const tag = (e.target && e.target.tagName) || "";
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (PanoViewer.open) return;
        if ((e.key === "p" || e.key === "P") && State.pins.length) { e.preventDefault(); this.toggle(); }
      });
    },

    /** 핀이 있을 때만 topbar 버튼 노출 */
    syncButton() {
      const btn = document.getElementById("btn-all-pins");
      if (!btn) return;
      btn.classList.toggle("hidden", !State.pins.length);
    },

    toggle() { this.open ? this.hide() : this.show(); },

    show() {
      if (!State.pins.length) return;
      this.open = true;
      document.getElementById("allpins-drawer").classList.remove("hidden");
      requestAnimationFrame(() => document.getElementById("allpins-drawer").classList.add("on"));
      this.render();
    },

    hide() {
      this.open = false;
      const d = document.getElementById("allpins-drawer");
      d.classList.remove("on");
      setTimeout(() => { if (!this.open) d.classList.add("hidden"); }, 220);
    },

    _kindBadge(pin) {
      // 이모지 → 인라인 SVG(앱 아이콘 톤 일치). I()로 중복 최소화.
      const I = (p) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15" aria-hidden="true">' + p + '</svg>';
      if (pin.isVideo || (pin.imageUrl && /\.(mp4|webm|mov)(\?|$)/i.test(pin.imageUrl)))
        return { ico: I('<rect x="2" y="2" width="20" height="20" rx="2"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/>'), cls: "video", txt: "360° 영상" };
      if (pin.imageId || pin.imageUrl) return { ico: I('<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>'), cls: "pano", txt: "360° 파노라마" };
      if (pin.attachments && pin.attachments.length) return { ico: I('<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>'), cls: "doc", txt: pin.attachments.length + "개 첨부" };
      if (pin.note) return { ico: I('<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/>'), cls: "note", txt: "노트" };
      return { ico: I('<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>'), cls: "empty", txt: "콘텐츠 없음" };
    },

    _sorted() {
      const arr = State.pins.map((p, i) => ({ pin: p, idx: i }));
      if (this.query) {
        arr.splice(0, arr.length, ...arr.filter((o) =>
          (o.pin.label || "").toLowerCase().includes(this.query)));
      }
      if (this.sort === "name") {
        arr.sort((a, b) => (a.pin.label || "").localeCompare(b.pin.label || "", "ko"));
      } else {
        arr.sort((a, b) => ((a.pin.page || 1) - (b.pin.page || 1)) || (a.idx - b.idx));
      }
      return arr;
    },

    render() {
      if (!this.open) return;
      const listEl = document.getElementById("allpins-list");
      const emptyEl = document.getElementById("allpins-empty");
      const countEl = document.getElementById("allpins-count");
      if (countEl) countEl.textContent = State.pins.length;
      const rows = this._sorted();
      listEl.innerHTML = "";
      if (!rows.length) { emptyEl.classList.remove("hidden"); return; }
      emptyEl.classList.add("hidden");

      const totalPages = State.mode === "viewer"
        ? (State.viewerPages ? State.viewerPages.length : 1) : State.pdfPages;

      rows.forEach(({ pin, idx }) => {
        const badge = this._kindBadge(pin);
        const hasMedia = App.pinHasContent(pin);
        const pageTag = totalPages > 1 ? `P${pin.page || 1}` : "";
        const row = document.createElement("button");
        row.className = "allpins-item" + (State.activePin === pin.id ? " active" : "");
        row.dataset.id = pin.id;
        row.innerHTML = `
          <span class="allpins-thumb ${badge.cls}" data-imgid="${pin.imageId || ""}">
            <span class="allpins-thumb-ico">${badge.ico}</span>
            <span class="allpins-thumb-no">${idx + 1}</span>
          </span>
          <span class="allpins-meta">
            <span class="allpins-name">${UI.escapeHtml(pin.label || "(이름 없음)")}</span>
            <span class="allpins-sub">
              <span class="allpins-kind ${badge.cls}">${badge.txt}</span>
              ${pageTag ? `<span class="allpins-page">${pageTag}</span>` : ""}
            </span>
          </span>
          <span class="allpins-go" title="이동 + 보기">
            ${hasMedia
              ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/></svg>'
              : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>'}
          </span>`;
        row.addEventListener("click", () => this._goto(pin));
        listEl.appendChild(row);

        // 360° 그림 썸네일 비동기 로드 (캐시)
        if (pin.imageId) this._loadThumb(row.querySelector(".allpins-thumb"), pin.imageId);
      });
    },

    async _loadThumb(thumbEl, imageId) {
      try {
        let url = this._thumbCache[imageId] || (Cloud._cache && Cloud._cache[imageId]);
        if (!url) { url = await Cloud.fetchImage(imageId); this._thumbCache[imageId] = url; }
        if (!url || !thumbEl) return;
        thumbEl.style.backgroundImage = `url("${url}")`;
        thumbEl.classList.add("has-img");
      } catch (e) { /* 썸네일 실패 무시 */ }
    },

    /** 페이지 구분 없이 해당 포인트로 이동(줌인) + 콘텐츠 있으면 360°/정보 함께 오픈 */
    async _goto(pin) {
      const hasContent = App.pinHasContent(pin);
      // 1) 먼저 도면을 해당 포인트로 이동(페이지 전환 포함)시켜 결과를 확정한 뒤
      await App.focusPin(pin, hasContent);
      // 2) 드로어를 닫는다 (이동 결과가 보이도록). 콘텐츠 없으면 닫고 도면만 보여줌.
      this.hide();
    }
  };

  /* ══════════════════════════════════════════
     AUTH — Google Identity 로그인 + 권한(슈퍼관리자/디자이너/뷰어)
     · 일반인(미로그인/권한없음) = 뷰어만
     · 디자이너로 지정된 구글 계정 = 설계자 기능
     · 슈퍼관리자(designssir@gmail.com) = 디자이너 지정 + 모든 권한
  ══════════════════════════════════════════ */
  // [마스터 2026-08-31] 디자이너 기능은 로그인 없이 바로 진입, 관리자만 구글 로그인 필요.
  //   마스터가 "다시 로그인 필수로" 지시하면 이 값을 false 로 바꾸면 즉시 원복(로그인 게이트 필수).
  const AUTO_DESIGNER_ENTRY = true;
  // [P48 보안 2026-09-18] 이 고정 문자열은 **공개 번들에 박혀 있으므로 비밀이 아니다.**
  //   서버(src/index.tsx)는 이제 이 문자열을 **열람 전용**으로만 인정한다 — 쓰기는 거부(403).
  //   편집 가능한 자동입장 토큰은 서버가 서명해 발급한다(POST /api/auth/auto-entry).
  //   여기 남겨두는 이유: 발급 실패(오프라인/구버전 서버) 시 "열람만이라도" 되게 하는 정직한 폴백.
  const AUTO_DESIGNER_TOKEN = "auto-designer-entry-360";
  // 마스터 전용 자동입장 키(선택). 서버에 AUTO_ENTRY_DESIGNER_KEY 를 설정한 뒤
  //   주소창에 ?akey=<키> 로 한 번 들어오면 이 브라우저에 저장되어 계속 편집 진입한다.
  const AUTO_ENTRY_KEY_LS = "wm_auto_entry_key";

  const Auth = {
    idToken: null,
    user: null,           // { email, name, picture, role }
    role: "viewer",       // 'super' | 'designer' | 'viewer'
    superAdmin: "designssir@gmail.com",
    _pendingDesigner: null,
    _gsiInited: false,
    _suppressDemoBadge: false,

    get clientId() {
      const id = (typeof window !== "undefined" && window.WM_GOOGLE_CLIENT_ID) || "";
      return id && id !== "GOOGLE_CLIENT_ID" ? id : "";
    },
    get isDesigner() { return this.role === "super" || this.role === "admin" || this.role === "designer"; },
    get isSuper() { return this.role === "super"; },
    // [역할모델] 관리자 = 슈퍼관리자(마스터) 또는 일반관리자. 관리자 패널/모드 접근 기준. 디자이너는 관리자 아님.
    get isAdmin() { return this.role === "super" || this.role === "admin"; },
    /** 역할 한글 라벨 사전 — 전역역할(super/admin/designer/viewer)과
     *  프로젝트역할(designer/editor/viewer)이 같은 어휘를 쓰므로 한 곳에서만 정의한다(SoT). */
    _ROLE_LABELS: { super: "슈퍼관리자", admin: "관리자", designer: "디자이너", editor: "편집자", viewer: "뷰어" },
    readonly: false,     // [P48] 서버가 쓰기를 거부하는 열람전용 세션(?d= 배포 링크)인가 — /api/auth/me 가 정본
    projectRole: null,   // [P40] 현재 열려 있는 프로젝트에서의 내 역할(없으면 전역역할로 표시)
    /** 배지 라벨. 프로젝트에 들어가 있으면 "그 프로젝트에서의 역할"을 우선한다(고정 '디자이너' 배지 제거). */
    _roleLabel() {
      const key = this.projectRole || this.role;
      return this._ROLE_LABELS[key] || this._ROLE_LABELS.viewer;
    },
    /** 프로젝트 진입/이탈 시 배지 컨텍스트 갱신 — 호출부는 ProjectHub.openProject / Projects.selectProject. */
    setProjectContext(p) {
      this.projectRole = (p && (p.my_role || p.role)) || null;
      this._applyUi();
    },

    async init() {
      const $ = (id) => document.getElementById(id);
      // 로그아웃
      $("btn-signout") && $("btn-signout").addEventListener("click", () => this.signOut());
      // 디자이너 관리(슈퍼)
      $("btn-manage-designers") && $("btn-manage-designers").addEventListener("click", () => Designers.open());
      // 로그인 게이트 닫기
      $("login-gate-cancel") && $("login-gate-cancel").addEventListener("click", () => this._closeGate());
      const gb = document.querySelector("#login-gate .admin-gate-backdrop");
      gb && gb.addEventListener("click", () => this._closeGate());

      // ── 데모 진입 (구글 로그인 없이 바로 체험) ──
      // 허브 인증바
      $("hub-btn-demo-designer") && $("hub-btn-demo-designer").addEventListener("click", () => this.demoLogin("designer"));
      $("hub-btn-demo-viewer")   && $("hub-btn-demo-viewer").addEventListener("click", () => this.demoLogin("viewer"));
      // [마스터 2026-06-22] 데모 진입 중 본인 Google 계정 로그인 상시 버튼(허브/홈)
      ["hub-btn-google-login", "btn-google-login"].forEach((id) => {
        const el = $(id);
        if (el) el.addEventListener("click", async () => { if (this.firebaseEnabled) await this._doFirebaseLogin(); else this._openGate(); });
      });
      // 로그인 게이트 내 데모(설계자)
      $("login-gate-demo") && $("login-gate-demo").addEventListener("click", () => this.demoLogin("designer"));
      // 구글 로그인 폴백 버튼
      //  · Firebase가 연결돼 있으면 → Firebase Google 팝업 로그인 (마스터: ID만 넣으면 바로 로그인)
      //  · 아니면 → 안내 토스트
      $("login-gate-google-fallback") && $("login-gate-google-fallback").addEventListener("click", async () => {
        if (this.firebaseEnabled) { await this._doFirebaseLogin(); return; }
        if (!this.clientId) {
          Prompt && Prompt.toast && Prompt.toast("구글 로그인은 관리자 설정(Firebase ID 연결) 후 사용할 수 있어요. 우선 체험으로 진행하세요.", 3200);
        }
      });
      // 허브 상단의 구글 로그인 버튼(빈 컨테이너)도 Firebase 활성 시 클릭 가능하도록 위임
      ["google-signin-btn", "hub-google-signin-btn", "login-gate-signin", "settings-signin"].forEach((id) => {
        const el = $(id);
        if (el) el.addEventListener("click", async () => { if (this.firebaseEnabled && !this.clientId) await this._doFirebaseLogin(); });
      });
      $("login-gate-learn") && $("login-gate-learn").addEventListener("click", () => {
        Prompt && Prompt.toast && Prompt.toast("SEASTAR 360° Viewer — 도면 위 360° 파노라마 위치 점검 시스템", 3000);
      });

      // ── 사용 신청(Request Access) 게이트 ──
      $("access-gate-cancel") && $("access-gate-cancel").addEventListener("click", () => this._closeAccessGate());
      const ab = document.querySelector("#access-gate .access-gate-backdrop");
      ab && ab.addEventListener("click", () => this._closeAccessGate());
      const af = $("access-gate-form");
      af && af.addEventListener("submit", (e) => { e.preventDefault(); this._submitAccessRequest(); });

      // 저장된 토큰 복원 (구글 idToken 또는 회사 이메일 로컬 토큰)
      try {
        const saved = sessionStorage.getItem("wm_id_token") || localStorage.getItem("wm_local_token");
        if (saved) { this.idToken = saved; }
      } catch (e) {}

      this._initGsi();
      // 서버에 설정된 Google Client ID(CF 시크릿)를 우선 적용 — 빌드파일 수정 없이 운영 주입
      this._loadServerConfig();
      // 복원된 토큰으로 권한 재확인
      if (this.idToken) await this.refresh();
      // 유효한 로그인이 없을 때만:
      //  · AUTO_DESIGNER_ENTRY=true  → 로그인 없이 디자이너로 자동 진입(배지 숨김)
      //  · AUTO_DESIGNER_ENTRY=false → [마스터 2026-06-22] 로그인 필수, 즉시 로그인 게이트
      // [버그②수정 2026-08-31] 종전에는 `else if` 라, 세션에 남은 폐기 토큰(예: 봉인된 demo-designer)이
      //   복원되면 refresh()가 이를 거부·삭제한 뒤에도 자동입장/게이트 어느 쪽도 타지 않아
      //   권한 없는 빈 화면에 갇혔다. 이제 refresh 결과(this.user)로 판단한다.
      // [버그①수정 2026-08-31] await 누락으로 ProjectHub.load()가 토큰 세팅 전에 실행돼
      //   "등록된 프로젝트가 없습니다"로 렌더되던 레이스 제거 — 토큰세팅+refresh 완료를 반드시 기다린다.
      if (!this.user && !this._hasLocalToken()) {
        if (AUTO_DESIGNER_ENTRY) await this._autoDesignerEntry();
        else this._openGate();
      }
    },

    /** 서버(/api/auth/config)에서 Google Client ID 를 받아 GIS 재초기화.
     *  · CF 시크릿 GOOGLE_CLIENT_ID 가 있으면 그 값을 사용(인라인보다 우선)
     *  · 없으면 index.html 의 인라인 WM_GOOGLE_CLIENT_ID 유지 */
    async _loadServerConfig() {
      try {
        const r = await fetch("/api/auth/config");
        if (!r.ok) return;
        const cfg = await r.json();
        const cid = cfg && cfg.google_client_id;
        if (cid && cid !== window.WM_GOOGLE_CLIENT_ID) {
          window.WM_GOOGLE_CLIENT_ID = cid;
          this._gsiInited = false;   // 새 ID 로 재초기화
          this._initGsi();
        }
      } catch (e) { /* 오프라인이면 인라인 값으로 진행 */ }
    },

    /** Firebase 팝업 로그인 실행 + 사용자 피드백(토스트/게이트 에러) */
    async _doFirebaseLogin() {
      try {
        // [토스트 스팸 제거] 팝업 창이 실제로 뜨는 것이 곧 피드백이다(성공/실패 토스트는 아래 유지).
        await this.loginWithFirebase();
        const who = (this.user && (this.user.name || this.user.email)) || "";
        Prompt && Prompt.toast && Prompt.toast("로그인 완료 — " + who + " (" + this._roleLabel() + ")", 3000);
      } catch (e) {
        const msg = (e && e.message) ? e.message : String(e);
        Prompt && Prompt.toast && Prompt.toast("로그인 실패: " + msg + " — Firebase 콘솔에서 Google 공급업체와 승인된 도메인을 확인하세요.", 4200);
      }
    },

    _initGsi() {
      if (this._gsiInited) return;
      // Firebase가 연결돼 있으면 GIS(클라이언트 ID) 없이도 Google 로그인 가능
      if (this.firebaseEnabled) {
        const hint = document.querySelector(".auth-hint");
        if (hint) hint.textContent = "Google 계정으로 로그인 (Firebase 연결됨)";
        // 폴백 버튼을 '실제 로그인 버튼'으로 노출
        const fb = document.getElementById("login-gate-google-fallback");
        if (fb) fb.classList.remove("hidden");
        return;
      }
      if (!window.google || !window.google.accounts || !window.google.accounts.id) {
        // GIS 스크립트 로딩 대기
        setTimeout(() => this._initGsi(), 300);
        return;
      }
      if (!this.clientId) {
        // 클라이언트 ID 미설정 — 버튼 자리에 안내
        const hint = document.querySelector(".auth-hint");
        if (hint) hint.textContent = "구글 로그인 미설정 (관리자 설정에서 Firebase ID 연결 필요)";
        return;
      }
      this._gsiInited = true;
      window.google.accounts.id.initialize({
        client_id: this.clientId,
        callback: (resp) => this._onCredential(resp),
        auto_select: false,
      });
      this._renderButtons();
    },

    _renderButtons() {
      const g = window.google.accounts.id;
      const b1 = document.getElementById("google-signin-btn");
      const b2 = document.getElementById("login-gate-signin");
      const b3 = document.getElementById("settings-signin");
      if (b1) { b1.innerHTML = ""; g.renderButton(b1, { theme: "filled_blue", size: "medium", text: "signin_with", shape: "pill" }); }
      if (b2) { b2.innerHTML = ""; g.renderButton(b2, { theme: "filled_blue", size: "large", text: "signin_with", shape: "pill" }); }
      if (b3) { b3.innerHTML = ""; g.renderButton(b3, { theme: "filled_blue", size: "large", text: "signin_with", shape: "pill" }); }
      this._renderHubSignin();
    },

    /** Firebase 로그인 활성 여부 (firebase-config 채워지면 true) */
    get firebaseEnabled() {
      return !!(window.FIREBASE_ENABLED && window.SeaFirebase);
    },

    /** Firebase Google 로그인 → 앱 Auth 연결 (마스터: ID만 넣으면 바로 로그인)
     *  1) Firebase 팝업으로 Google 로그인
     *  2) Firebase ID 토큰을 받아 this.idToken 에 저장
     *  3) refresh() 로 서버에 권한 확인 → 앱 전체 로그인 상태 반영
     *  반환: role (실패 시 throw) */
    async loginWithFirebase() {
      if (!this.firebaseEnabled) throw new Error("Firebase 미설정");
      if (!window.SeaFirebase.ready) {
        // init.js 의 동적 import 완료 대기 (최대 5초)
        await new Promise((res) => {
          if (window.SeaFirebase.ready) return res();
          const t = setTimeout(res, 5000);
          document.addEventListener("seafirebase:ready", () => { clearTimeout(t); res(); }, { once: true });
        });
      }
      const fbUser = await window.SeaFirebase.loginGoogle();
      // Firebase v10: getIdToken
      let idToken = null;
      try { idToken = await fbUser.getIdToken(); } catch (e) {}
      if (!idToken && window.SeaFirebase._auth && window.SeaFirebase._auth.currentUser) {
        idToken = await window.SeaFirebase._auth.currentUser.getIdToken();
      }
      if (!idToken) throw new Error("Firebase ID 토큰을 가져오지 못했습니다.");
      this.idToken = idToken;
      try { sessionStorage.setItem("wm_id_token", idToken); } catch (e) {}
      const role = await this.refresh();
      // 디자이너 진입 대기 콜백 처리
      if (this._pendingDesigner) {
        const cb = this._pendingDesigner;
        if (this.isDesigner) { this._pendingDesigner = null; this._closeGate(); cb(); }
        else { this._closeGate(); this._openAccessGate(); }
      } else {
        this._closeGate();
      }
      return role;
    },

    async _onCredential(resp) {
      if (!resp || !resp.credential) return;
      this.idToken = resp.credential;
      try { sessionStorage.setItem("wm_id_token", this.idToken); } catch (e) {}
      await this.refresh();
      // 디자이너 모드 진입을 기다리던 경우 처리
      if (this._pendingDesigner) {
        const cb = this._pendingDesigner;
        if (this.isDesigner) { this._pendingDesigner = null; this._closeGate(); cb(); }
        else {
          // 권한 없는 계정 → 반드시 권한없음/사용신청 페이지로 연결 (Genspark 모방)
          this._closeGate();
          this._openAccessGate();
        }
      }
    },

    /** 인증 헤더 (API 호출용) */
    headers(extra) {
      const h = Object.assign({ "Content-Type": "application/json" }, extra || {});
      if (this.idToken) h["Authorization"] = "Bearer " + this.idToken;
      return h;
    },

    /** R2 객체 URL(/api/r2/object/...)에 인증 토큰을 쿼리로 부착 — <img>/텍스처는 헤더를 못 보냄.
     *  R2 경로가 아니면(blob:/dataURL/외부/이미 부착) 그대로 통과. */
    r2(u) {
      if (typeof u !== "string" || u.indexOf("/api/r2/object/") !== 0 || !this.idToken) return u;
      if (/[?&]t=/.test(u)) return u;
      return u + (u.indexOf("?") < 0 ? "?" : "&") + "t=" + encodeURIComponent(this.idToken);
    },

    /** 서버에 권한 확인 → UI 갱신
     *  오프라인 권한 유지: 온라인이면 서버 응답을 localStorage에 캐싱,
     *    네트워크 실패(오프라인)이면서 토큰이 있으면 캐시된 권한을 복원.
     *    → 비행기·현장 등 오프라인에서도 디자이너/슈퍼 권한이 유지됨. */
    async refresh() {
      let data = null;
      let netFail = false;
      try {
        const r = await fetch("/api/auth/me", { headers: this.headers() });
        data = await r.json();
      } catch (e) { netFail = true; }

      // 오프라인(네트워크 실패)이고 토큰이 살아있으면 → 캐시 권한 복원
      if (netFail && (this.idToken || this._hasLocalToken())) {
        const cached = this._loadAuthCache();
        if (cached && cached.authenticated) {
          this.user = { email: cached.email, name: cached.name, picture: cached.picture, role: cached.role, request_status: cached.request_status || null };
          this.role = cached.role;
          this.readonly = !!cached.readonly;   // [P48] 오프라인 복원 시에도 열람전용 상태를 유지
          this.superAdmin = cached.super_admin || this.superAdmin;
          this._offline = true;
          this._applyUi();
          return this.role;
        }
      }

      if (data && data.authenticated) {
        this.user = { email: data.email, name: data.name, picture: data.picture, role: data.role, request_status: data.request_status || null };
        this.role = data.role;
        this.readonly = !!data.readonly;   // [P48] 서버 판정이 정본 — UI 는 이 값만 믿는다
        this.superAdmin = data.super_admin || this.superAdmin;
        this._offline = false;
        this._offlineOnly = false;   // [P40] 서버가 신원을 재검증함 → 오프라인 전용 상태 해제(서버 쓰기 재허용)
        // [P16] 재로그인 성공 — 만료 상태 해제 + 보류된 오프라인 큐/드래프트를 자동으로 이어서 업로드.
        //   Firebase/Credential 로그인 경로 둘 다 refresh()를 거치므로 이 한 지점에서만 처리(§G-2-5).
        if (this._expired) {
          this._expired = false; this._authExpiredNotified = false;
          try { if (typeof SyncQueue !== "undefined" && SyncQueue._onReconnect) SyncQueue._onReconnect(); } catch (e) {}
        }
        this._saveAuthCache(data);   // 성공 시 권한 스냅샷 저장
      } else if (!netFail) {
        // 서버가 명확히 미인증 응답 → 정리(캐시도 삭제)
        this.user = null; this.role = "viewer"; this.idToken = null;
        try { sessionStorage.removeItem("wm_id_token"); } catch (e) {}
        this._clearAuthCache();
      }
      this._applyUi();
      return this.role;
    },

    _hasLocalToken() {
      try { return !!(sessionStorage.getItem("wm_id_token") || localStorage.getItem("wm_local_token")); } catch (e) { return false; }
    },
    _saveAuthCache(data) {
      try {
        localStorage.setItem("wm_auth_cache", JSON.stringify({
          authenticated: true, email: data.email, name: data.name, picture: data.picture,
          role: data.role, request_status: data.request_status || null, readonly: !!data.readonly,
          super_admin: data.super_admin || null, _ts: Date.now()
        }));
      } catch (e) {}
    },
    _loadAuthCache() {
      try {
        const raw = localStorage.getItem("wm_auth_cache");
        if (!raw) return null;
        const c = JSON.parse(raw);
        if (c._ts && (Date.now() - c._ts) > 7 * 24 * 3600 * 1000) return null;
        return c;
      } catch (e) { return null; }
    },
    _clearAuthCache() {
      try { localStorage.removeItem("wm_auth_cache"); } catch (e) {}
    },

    _applyUi() {
      // 홈 인증바 + 프로젝트 허브 인증바 모두 갱신
      this._applyUiTo("");      // home: auth-signed-in / user-name ...
      this._applyUiTo("hub-");  // hub:  hub-auth-signed-in / hub-user-name ...

      // 디자이너 카드 잠금 표시
      document.querySelectorAll(".mode-card.designer").forEach((c) => c.classList.toggle("locked", !this.isDesigner));
      // 설정 패널이 열려 있으면 권한에 맞춰 다시 렌더
      if (typeof Settings !== "undefined" && Settings._isOpen) Settings.render();
      // 프로젝트 허브가 보이는 중이면 +새프로젝트/편집 버튼 갱신
      if (typeof ProjectHub !== "undefined") ProjectHub.refreshIfVisible();
      // 데모 모드 배지 동기화
      if (this._showDemoBadge) this._showDemoBadge();
    },

    _applyUiTo(pfx) {
      const $ = (id) => document.getElementById(pfx + id);
      const signedIn  = $("auth-signed-in");
      const signedOut = $("auth-signed-out");
      if (this.user) {
        signedIn && signedIn.classList.remove("hidden");
        signedOut && signedOut.classList.add("hidden");
        $("user-name") && ($("user-name").textContent = this.user.name || this.user.email);
        const roleEl = $("user-role");
        if (roleEl) {
          roleEl.textContent = this._roleLabel();
          roleEl.className = "user-role role-" + this.role;
        }
        const av = $("user-avatar");
        if (av) { if (this.user.picture) { av.src = this.user.picture; av.style.display = ""; } else av.style.display = "none"; }
        $("btn-manage-designers") && $("btn-manage-designers").classList.toggle("hidden", !this.isAdmin);
        // [마스터 2026-06-22] 데모 사용자 여부
        const _isDemo = !!(this.user && /^demo\./.test(this.user.email || ""));
        // 데모일 때만 'Google 로그인' 버튼 노출(실계정 전환 유도)
        const _gl = $("btn-google-login");
        if (_gl) _gl.classList.toggle("hidden", !_isDemo);
        // [마스터 요청] 데모 진입 시 '설계자/디자이너' 사용자 배지 제거(실제 로그인 시엔 본인 이름 표시)
        const _badge = signedIn ? signedIn.querySelector(".user-badge") : null;
        if (_badge) _badge.classList.toggle("hidden", _isDemo);
      } else {
        signedIn && signedIn.classList.add("hidden");
        signedOut && signedOut.classList.remove("hidden");
      }
    },

    /** 프로젝트 허브의 구글 로그인 버튼 렌더 */
    _renderHubSignin() {
      if (!this._gsiInited || !window.google || !window.google.accounts) return;
      const b = document.getElementById("hub-google-signin-btn");
      if (b) { b.innerHTML = ""; window.google.accounts.id.renderButton(b, { theme: "filled_blue", size: "medium", text: "signin_with", shape: "pill" }); }
    },

    /** 디자이너 진입 요청. 권한 있으면 콜백 즉시, 없으면 로그인 게이트. */
    requireDesigner(onPass) {
      if (this.isDesigner) { onPass(); return; }
      this._pendingDesigner = onPass;
      this._openGate();
    },

    _openGate() {
      // 이미 로그인했지만 권한이 없는 계정이면 → 바로 사용신청(권한없음) 게이트로
      if (this.user && !this.isDesigner) { this._openAccessGate(); return; }
      const gate = document.getElementById("login-gate");
      const err = document.getElementById("login-gate-error");
      if (err) err.classList.add("hidden");
      gate.classList.remove("hidden");
      requestAnimationFrame(() => gate.classList.add("on"));
      // 게이트 안 버튼 렌더 (로그인은 됐지만 권한 없는 경우엔 안내)
      if (this._gsiInited) this._renderButtons();
      // 폴백 버튼 표시 규칙:
      //  · GIS 클라이언트 ID 있음 → 숨김(실제 GIS 버튼 사용)
      //  · Firebase 연결됨 → 표시(폴백 버튼이 곧 Firebase 로그인 버튼)
      //  · 둘 다 없음 → 표시(클릭 시 안내)
      const fb = document.getElementById("login-gate-google-fallback");
      if (fb) fb.classList.toggle("hidden", !!this.clientId && !this.firebaseEnabled);
    },
    _showGateError() {
      const err = document.getElementById("login-gate-error");
      if (err) err.classList.remove("hidden");
    },

    /* ── 권한 없음 / 사용 신청(Request Access) 게이트 ── */
    _openAccessGate() {
      const gate = document.getElementById("access-gate");
      if (!gate) return;
      // 본인 이메일 표시
      const email = (this.user && this.user.email) || "";
      const emEl = document.getElementById("access-gate-email");
      const roEl = document.getElementById("ar-email-readonly");
      if (emEl) emEl.textContent = email || "로그인 계정";
      if (roEl) roEl.textContent = email || "—";
      // 이름 기본값
      const nameEl = document.getElementById("ar-name");
      if (nameEl && !nameEl.value) nameEl.value = (this.user && this.user.name) || "";
      // 메시지 초기화
      const errEl = document.getElementById("access-gate-error");
      const okEl = document.getElementById("access-gate-success");
      if (errEl) errEl.classList.add("hidden");
      if (okEl) okEl.classList.add("hidden");
      // 이미 신청한 상태면 안내
      const status = this.user && this.user.request_status;
      const submitLabel = document.getElementById("ar-submit-label");
      if (status === "pending" && okEl && submitLabel) {
        okEl.textContent = "이미 신청이 접수되었습니다. 관리자 승인을 기다려 주세요.";
        okEl.classList.remove("hidden");
        submitLabel.textContent = "신청 내용 수정";
      } else if (submitLabel) {
        submitLabel.textContent = "사용 신청";
      }
      gate.classList.remove("hidden");
      requestAnimationFrame(() => gate.classList.add("on"));
    },
    _closeAccessGate() {
      const gate = document.getElementById("access-gate");
      if (!gate) return;
      gate.classList.remove("on");
      setTimeout(() => gate.classList.add("hidden"), 200);
      this._pendingDesigner = null;
    },
    async _submitAccessRequest() {
      const $ = (id) => document.getElementById(id);
      const errEl = $("access-gate-error");
      const okEl = $("access-gate-success");
      const btn = $("ar-submit");
      if (errEl) errEl.classList.add("hidden");
      if (okEl) okEl.classList.add("hidden");
      const name = ($("ar-name").value || "").trim();
      const company = ($("ar-company").value || "").trim();
      const country = ($("ar-country").value || "").trim();
      const phone = ($("ar-phone").value || "").trim();
      if (!name || !company || !country || !phone) {
        if (errEl) { errEl.textContent = "모든 필수 항목(*)을 입력해 주세요."; errEl.classList.remove("hidden"); }
        return;
      }
      if (!this.idToken) {
        if (errEl) { errEl.textContent = "구글 로그인 후 신청할 수 있습니다."; errEl.classList.remove("hidden"); }
        return;
      }
      if (btn) { btn.disabled = true; btn.classList.add("loading"); }
      try {
        const res = await fetch("/api/access-requests", {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({ name, company, country, phone }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
        if (okEl) {
          okEl.textContent = "사용 신청이 접수되었습니다. 관리자(" + (this.user && this.user.email ? "" : "") + "admin) 승인 후 설계자 기능을 사용할 수 있습니다.";
          okEl.classList.remove("hidden");
        }
        if (this.user) this.user.request_status = "pending";
        Prompt && Prompt.toast && Prompt.toast("사용 신청이 관리자에게 전달되었습니다.", 2800);
      } catch (e) {
        if (errEl) { errEl.textContent = "신청 실패: " + (e && e.message ? e.message : "네트워크 오류"); errEl.classList.remove("hidden"); }
      } finally {
        if (btn) { btn.disabled = false; btn.classList.remove("loading"); }
      }
    },
    _closeGate() {
      const gate = document.getElementById("login-gate");
      if (!gate) return;
      gate.classList.remove("on");
      setTimeout(() => gate.classList.add("hidden"), 200);
      this._pendingDesigner = null;
    },

    /** 데모 진입 — 구글 로그인 없이 바로 권한 부여(서버가 demo 토큰 인식).
     *  role: 'designer' | 'viewer'
     *  opts.silent: true 면 데모 안내 배지를 띄우지 않음(AUTO_DESIGNER_ENTRY 자동입장 전용) */
    async demoLogin(role, opts) {
      this._suppressDemoBadge = !!(opts && opts.silent);
      this.idToken = role === "super" ? "demo-super" : (role === "designer" ? "demo-designer" : "demo-viewer");
      try { sessionStorage.setItem("wm_id_token", this.idToken); } catch (e) {}
      await this.refresh();  // 서버가 demo 토큰을 검증해 role/user 세팅
      this._closeGate();
      // 디자이너 진입을 기다리던 콜백이 있으면 실행
      if (this._pendingDesigner) {
        const cb = this._pendingDesigner;
        this._pendingDesigner = null;
        if (this.isDesigner) cb();
      }
      // 데모 모드 안내 배지 표시
      this._showDemoBadge();
    },

    /** [P48] 서버에서 자동입장 토큰을 발급받는다(고정 문자열 상수 대체).
     *  @param {"designer"|"viewer"} kind
     *  @returns {Promise<string|null>} 서명 토큰. 실패하면 null(호출부가 열람전용 폴백을 쓴다). */
    async _mintAutoEntryToken(kind) {
      let akey = "";
      try {
        const q = new URLSearchParams(location.search).get("akey");
        if (q) localStorage.setItem(AUTO_ENTRY_KEY_LS, q);
        akey = localStorage.getItem(AUTO_ENTRY_KEY_LS) || "";
      } catch (e) {}
      const headers = { "Content-Type": "application/json" };
      if (akey) headers["X-Auto-Entry-Key"] = akey;
      try {
        const r = await fetch("/api/auth/auto-entry", { method: "POST", headers, body: JSON.stringify({ kind }) });
        if (!r.ok) return null;
        const j = await r.json();
        return (j && typeof j.token === "string" && j.token) || null;
      } catch (e) { return null; }   // 오프라인/구버전 서버 → 정직하게 실패, 열람전용 폴백
    },

    /** [마스터 2026-08-31] 로그인 없는 디자이너 자동입장.
     *  데모 토큰(demo-designer)은 서버에서 봉인(DEMO_LOGIN=0)되어 쓸 수 없으므로,
     *  디자이너 권한만 가지는 전용 토큰(AUTO_DESIGNER_TOKEN)으로 서버 검증을 받는다.
     *  서버 스위치(AUTO_DESIGNER_TOKEN_ENABLED)가 꺼져 있으면 인증 실패 → 기존 로그인 게이트로 폴백.
     *  @returns {Promise<boolean>} 디자이너 진입 성공 여부 */
    async _autoDesignerEntry() {
      this._suppressDemoBadge = true;                    // 자동입장은 데모 배지를 띄우지 않는다
      // [P48] 🔴 배포 링크(?d=)로 들어온 세션은 **열람 전용** 토큰만 요청한다.
      //   쓰기 차단의 최종 방어선은 서버 미들웨어이고, 여기는 "애초에 쓰기 자격을 받지 않는다"는 1차 방어다.
      let kind = new URLSearchParams(location.search).get("d") ? "viewer" : "designer";
      // [P61] 🔴 공유 링크 `/srview/<이름>-<토큰>` 도 배포 링크(?d=)와 **완전히 동일한 열람전용**이다.
      //   새 주소 체계가 쓰기 구멍이 되면 p48 에서 막은 사고가 경로만 바꿔 되살아난다.
      //   판정은 ShareLink.token() 한 곳에서만 한다(SoT).
      if (typeof ShareLink !== "undefined" && ShareLink.token()) kind = "viewer";
      this.idToken = await this._mintAutoEntryToken(kind) || AUTO_DESIGNER_TOKEN;
      try { sessionStorage.setItem("wm_id_token", this.idToken); } catch (e) {}
      await this.refresh();                              // 서버가 전용 토큰을 검증해 role='designer' 세팅
      if (!this.user) {                                  // 서버 스위치 off/네트워크 실패 → 정직하게 로그인 게이트
        this.idToken = null;
        try { sessionStorage.removeItem("wm_id_token"); } catch (e) {}
        this._openGate();
        return false;
      }
      this._closeGate();
      if (this._pendingDesigner) {
        const cb = this._pendingDesigner;
        this._pendingDesigner = null;
        if (this.isDesigner) cb();
      }
      this._showDemoBadge();                             // _suppressDemoBadge=true → 잔여 배지 제거만 수행
      return this.isDesigner;
    },

    /** 데모 모드 안내 배지(허브 상단) */
    _showDemoBadge() {
      if (this._suppressDemoBadge) {
        // AUTO_DESIGNER_ENTRY 자동입장 — 로그인 없이 그냥 디자이너로 보이게(배지 없음)
        const ex = document.getElementById("demo-mode-badge");
        if (ex) ex.remove();
        return;
      }
      if (!this.user || !this.user.email || this.user.email.indexOf("demo.") !== 0) {
        // 데모가 아니면 배지 제거
        const ex = document.getElementById("demo-mode-badge");
        if (ex) ex.remove();
        return;
      }
      if (document.getElementById("demo-mode-badge")) return;
      const b = document.createElement("div");
      b.id = "demo-mode-badge";
      b.className = "demo-mode-badge";
      b.innerHTML = '<span class="demo-dot"></span>편집모드 — 도면·핀·프로젝트 편집 중';
      document.body.appendChild(b);
    },

    _expired: false,              // 인증 만료 상태(배지 "인증 필요" 표시용)
    _authExpiredNotified: false,  // 세션당 1회만 안내(재시도마다 토스트 반복 방지)

    /** 오프라인 큐/드래프트 자동 업로드가 401/403(토큰 만료)로 실패했을 때 호출하는 공유 지점.
     *  App._flushDirtyDrafts(20_App.js) 와 SyncQueue.flush(05_SyncQueue.js) 양쪽에서 호출한다(§G-2-5,
     *  로직 복붙 대신 이 한 곳만 고친다). 데이터(큐/드래프트)는 그대로 보존되고, 세션당 1회만
     *  안내 + 기존 로그인 게이트를 재사용해 재로그인 동선을 제공한다(신규 UI 없음). */
    authExpired() {
      this._expired = true;
      if (this._authExpiredNotified) return;
      this._authExpiredNotified = true;
      try { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("로그인이 만료돼 업로드하지 못했습니다 — 다시 로그인하면 자동으로 이어서 올립니다", 4000); } catch (e) {}
      try { this._openGate(); } catch (e) {}
    },

    /* ══════════════════════════════════════════════════════════════════
       [P40] 오프라인 재인증 — 현장에서 세션이 끊겨도 "이 기기에서 한 번 온라인 로그인에
       성공한 사용자"가 비밀번호로 다시 들어와 오프라인 작업을 이어갈 수 있게 한다.

       보안 설계(트레이드오프 명시):
        · 저장하는 것은 검증자(verifier)뿐 — 서버 hashPassword 와 동일한 PBKDF2-SHA256 100k/256bit
          + 기기별 16B 난수 salt. 🔴 평문 비밀번호는 어디에도 저장하지 않는다.
        · 기기를 탈취당하면 이 검증자는 오프라인 무차별 대입의 표적이 된다. 100k 스트레칭 +
          시도 횟수 제한(OFFLINE_MAX_ATTEMPTS) + 만료(OFFLINE_VERIFIER_TTL_MS) 로 상쇄한다.
          약한 비밀번호는 여전히 뚫린다 → 초대 계정 비밀번호 최소 8자를 서버에서 강제한다.
        · 🔴 오프라인 인증은 서버 권한을 전혀 만들지 않는다. 세션 토큰을 복원하지 않으며
          (idToken=null), canServerWrite()=false 로 업로드 경로가 스스로 멈춘다.
          온라인 복귀 시 서버가 /api/auth/me 로 다시 검증해야만 쓰기가 열린다.
        · 로그아웃 시 검증자를 삭제한다.
       ══════════════════════════════════════════════════════════════════ */
    OFFLINE_PBKDF2_ITER: 100000,                          // 서버 hashPassword 와 동일 파라미터
    OFFLINE_VERIFIER_TTL_MS: 30 * 24 * 60 * 60 * 1000,    // 로컬 세션(30일)과 동일 창
    OFFLINE_MAX_ATTEMPTS: 10,                             // 오프라인 무차별 대입 제한
    _offlineOnly: false,                                  // 오프라인 검증자로만 인증된 상태

    _hexOf(buf) {
      const a = new Uint8Array(buf); let h = "";
      for (const x of a) h += x.toString(16).padStart(2, "0");
      return h;
    },
    _eqConstantTime(a, b) {
      if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
      let diff = 0;
      for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
      return diff === 0;
    },
    /** PBKDF2-SHA256(100k, 256bit) — 서버 src/lib/util.ts hashPassword 와 같은 값을 만든다. */
    async _deriveVerifier(password, saltHex) {
      const salt = new Uint8Array(String(saltHex).match(/.{1,2}/g).map((b) => parseInt(b, 16)));
      const baseKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
      const bits = await crypto.subtle.deriveBits(
        { name: "PBKDF2", salt: salt, iterations: this.OFFLINE_PBKDF2_ITER, hash: "SHA-256" }, baseKey, 256);
      return this._hexOf(bits);
    },
    /** 온라인 로그인 성공 직후에만 호출한다(서버가 이미 신원을 검증한 시점). */
    async saveOfflineVerifier(email, password, profile) {
      try {
        if (!email || !password) return false;
        const saltBytes = new Uint8Array(16); crypto.getRandomValues(saltBytes);
        const salt = this._hexOf(saltBytes.buffer);
        const rec = {
          v: 1,
          email: String(email).toLowerCase(),
          salt: salt,
          verifier: await this._deriveVerifier(password, salt),   // 해시만 — 원문 없음
          name: (profile && profile.name) || "",
          role: (profile && profile.role) || "viewer",
          createdAt: Date.now(),
          expiresAt: Date.now() + this.OFFLINE_VERIFIER_TTL_MS,
          attempts: 0
        };
        return await SyncQueue.saveAuthRecord(rec);
      } catch (e) { return false; }
    },
    /** 오프라인 재인증. 성공해도 서버 토큰은 만들지 않는다(로컬 작업 권한 전용). */
    async offlineLogin(email, password) {
      const rec = await SyncQueue.loadAuthRecord();
      const em = String(email || "").trim().toLowerCase();
      if (!rec || rec.email !== em) return { ok: false, reason: "no-record" };
      if (Date.now() > rec.expiresAt) { await SyncQueue.clearAuthRecord(); return { ok: false, reason: "expired" }; }
      if ((rec.attempts || 0) >= this.OFFLINE_MAX_ATTEMPTS) return { ok: false, reason: "locked" };
      const h = await this._deriveVerifier(String(password || ""), rec.salt);
      if (!this._eqConstantTime(h, rec.verifier)) {
        rec.attempts = (rec.attempts || 0) + 1;
        await SyncQueue.saveAuthRecord(rec);
        return { ok: false, reason: "bad-password", remaining: Math.max(0, this.OFFLINE_MAX_ATTEMPTS - rec.attempts) };
      }
      rec.attempts = 0; await SyncQueue.saveAuthRecord(rec);
      this.idToken = null;                    // 🔴 서버 세션 토큰을 복원하지 않는다
      this._offlineOnly = true; this._offline = true;
      this.user = { email: rec.email, name: rec.name || rec.email, picture: "", role: rec.role };
      this.role = rec.role;
      this._applyUi();
      return { ok: true, user: this.user };
    },
    /** 서버 쓰기(업로드/동기화) 허용 여부 — 오프라인 검증만으로는 절대 허용하지 않는다. */
    canServerWrite() { return !this._offlineOnly && !!this.idToken; },
    async clearOfflineVerifier() { try { await SyncQueue.clearAuthRecord(); } catch (e) {} },

    signOut() {
      try {
        if (window.google && window.google.accounts && window.google.accounts.id)
          window.google.accounts.id.disableAutoSelect();
      } catch (e) {}
      // 회사 이메일(로컬) 세션이면 서버에서 무효화
      try {
        if (this.idToken && this.idToken.indexOf("local-") === 0) {
          fetch("/api/signup/logout", { method: "POST", headers: { "Authorization": "Bearer " + this.idToken } }).catch(() => {});
        }
      } catch (e) {}
      this.idToken = null; this.user = null; this.role = "viewer";
      this._suppressDemoBadge = false;  // 다음 수동 데모 로그인 시 배지 정상 표시되도록 초기화
      this._offlineOnly = false; this.projectRole = null;
      try { sessionStorage.removeItem("wm_id_token"); localStorage.removeItem("wm_local_token"); } catch (e) {}
      this._clearAuthCache();   // 오프라인 권한 캐시도 함께 정리
      this.clearOfflineVerifier();  // [P40] 오프라인 재인증 검증자 삭제 — 로그아웃 후엔 이 기기에서 오프라인 진입 불가
      this._applyUi();
      this._showDemoBadge();  // 데모 배지 제거
      // 디자이너 화면(편집 모드)에 있었다면 뷰어로 전환
      if (State.mode === "designer") {
        App.exitEdit();
      }
    }
  };

  /* ══════════════════════════════════════════
     SETTINGS — 설정 패널 (A안: 접속=뷰어, 설정 → 로그인 → 편집)
  ══════════════════════════════════════════ */
  /* ══════════════════════════════════════════
     PinPrefs — 핀 색상 환경설정 (기본=그린, 설정에서 변경)
  ══════════════════════════════════════════ */
  const PinPrefs = {
    KEY: "wm_pin_color",
    // 선택 가능한 색상 팔레트 (라벨 + 머리색/머리진한색/바늘끝/글자색)
    PALETTE: [
      { id: "green",  name: "그린(기본)", head: "#10b981", head2: "#047857", needle: "#064e3b", text: "#065f46" },
      { id: "blue",   name: "블루",       head: "#2f6db5", head2: "#1d4f88", needle: "#13315a", text: "#1d4f88" },
      { id: "gold",   name: "골드",       head: "#c9962a", head2: "#9a7016", needle: "#5f450c", text: "#7a5a12" },
      { id: "red",    name: "레드",       head: "#ef4444", head2: "#b91c1c", needle: "#7f1d1d", text: "#991b1b" },
      { id: "purple", name: "퍼플",       head: "#8b5cf6", head2: "#6d28d9", needle: "#4c1d95", text: "#5b21b6" },
      { id: "orange", name: "오렌지",     head: "#f97316", head2: "#c2410c", needle: "#7c2d12", text: "#9a3412" }
    ],
    DEFAULT: "green",
    get() {
      try { return localStorage.getItem(this.KEY) || this.DEFAULT; } catch (e) { return this.DEFAULT; }
    },
    set(id) {
      try { localStorage.setItem(this.KEY, id); } catch (e) {}
      State.pinColor = id;
      try { if (typeof UI !== "undefined") UI.renderPinsOnMap(); } catch (e) {}
    },
    color() {
      const id = State.pinColor || this.get();
      return this.PALETTE.find(p => p.id === id) || this.PALETTE[0];
    }
  };

  /* ════════════════════════════════════════════════════════════
     PinIcons — 핀(호스팟)별 아이콘 세트
     ────────────────────────────────────────────────────────────
     [마스터 요청] 핀마다 다른 아이콘을 선택·적용 + 디자인 개선.
     • 각 아이콘은 24x24 viewBox 기준 stroke path 로 정의(단색 currentColor).
     • 핀 머리(흰 원, 중심 18,12) 안에 <g transform> 으로 축소 배치된다.
     • 'number' 는 기본값(기존 동작: 번호 표시) — 하위호환.
     ════════════════════════════════════════════════════════════ */
  const PinIcons = {
    // 아이콘 정의: id, 한글명, 24x24 기준 inner SVG(전부 stroke, currentColor)
    SET: [
      { id: "number",   name: "번호",     body: null /* 숫자 표시(기본) */ },
      { id: "camera360",name: "360°카메라",body:'<circle cx="12" cy="12" r="8.5"/><ellipse cx="12" cy="12" rx="8.5" ry="3.4"/><path d="M12 3.5v17"/>' },
      { id: "warning",  name: "경고/위험", body:'<path d="M12 3 2.5 20h19L12 3z"/><path d="M12 10v4"/><circle cx="12" cy="17" r=".6" fill="currentColor" stroke="none"/>' },
      { id: "valve",    name: "밸브/설비", body:'<circle cx="12" cy="12" r="3.2"/><path d="M12 8.8V3M12 21v-5.8M8.8 12H3M21 12h-5.8"/>' },
      { id: "fire",     name: "소화/안전", body:'<path d="M12 3c2 3 4 4.5 4 8a4 4 0 0 1-8 0c0-1.6.6-2.8 1.4-3.8C10.2 9 11 8 12 3z"/>' },
      { id: "electric", name: "전기",     body:'<path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/>' },
      { id: "pipe",     name: "배관",     body:'<path d="M3 9h10a3 3 0 0 1 3 3v9"/><path d="M3 6v6M21 18h-6"/>' },
      { id: "gauge",    name: "계측",     body:'<path d="M3.5 14a8.5 8.5 0 0 1 17 0"/><path d="M12 14l4-3"/><circle cx="12" cy="14" r="1.2" fill="currentColor" stroke="none"/>' },
      { id: "door",     name: "출입구",   body:'<rect x="6" y="3" width="12" height="18" rx="1"/><path d="M14.5 12h.01"/>' },
      { id: "note",     name: "정보/메모", body:'<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>' }
    ],
    DEFAULT: "number",

    /** id → 정의(없으면 기본) */
    def(id) { return this.SET.find(s => s.id === id) || this.SET[0]; },

    /** 핀 머리 안에 들어갈 아이콘 SVG 문자열(흰 원 중심 18,12 / 반경≈7.3 기준).
     *  number 이면 null 반환(호출측에서 숫자 text 를 그린다). */
    headMarkup(iconId, color, cy) {
      const d = this.def(iconId);
      if (!d.body) return null;
      // 24x24 아이콘을 핀 머리 흰 원 안에 배치. cy = 머리 중심 y(기본 12, 360-ISO 마커는 15).
      const cyc = (typeof cy === 'number') ? cy : 12;
      const s = 0.56, tx = 18 - 12 * s, ty = cyc - 12 * s;
      return `<g transform="translate(${tx} ${ty}) scale(${s})"
                 fill="none" stroke="${color || '#065f46'}" stroke-width="2.2"
                 stroke-linecap="round" stroke-linejoin="round">${d.body}</g>`;
    },

    /** 선택 그리드용 미리보기 칩(24x24 단독 SVG).
     *  @param {number} [size] 명시 시 width/height 속성 부여(필터 칩처럼 CSS 그리드 밖에서 쓸 때). */
    chipSvg(iconId, size) {
      const d = this.def(iconId);
      const sz = size ? ` width="${size}" height="${size}"` : "";
      if (!d.body) {
        return `<svg viewBox="0 0 24 24"${sz} aria-hidden="true"><text x="12" y="12" text-anchor="middle" dominant-baseline="central" font-size="13" font-weight="800" fill="currentColor">#</text></svg>`;
      }
      return `<svg viewBox="0 0 24 24"${sz} fill="none" stroke="currentColor" stroke-width="2"
                   stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d.body}</svg>`;
    }
  };

  const Settings = {
    _isOpen: false,

    init() {
      const $ = (id) => document.getElementById(id);
      // 설정 버튼 → 패널 열기
      $("btn-settings") && $("btn-settings").addEventListener("click", () => this.open());
      // 핀 색상 선택(설정 패널 내) — 위임 바인딩
      const wrap = $("settings-pincolor");
      if (wrap) wrap.addEventListener("click", (e) => {
        const sw = e.target.closest && e.target.closest("[data-pincolor]");
        if (!sw) return;
        PinPrefs.set(sw.getAttribute("data-pincolor"));
        this._renderPinColor();
        // [토스트 스팸 제거] 색상 스와치 선택 결과가 핀에 즉시 반영돼 눈에 보인다.
      });
      // 닫기
      $("settings-close") && $("settings-close").addEventListener("click", () => this.close());
      const bd = document.querySelector('#settings-modal .admin-gate-backdrop');
      bd && bd.addEventListener("click", () => this.close());
      // 편집 모드로 전환
      $("btn-go-edit") && $("btn-go-edit").addEventListener("click", () => {
        if (!Auth.isDesigner) return;
        this.close();
        App.openApp(PinSeries.preferredMode());
      });
      // 디자이너 지정 관리(슈퍼)
      $("btn-open-designers") && $("btn-open-designers").addEventListener("click", () => {
        if (!Auth.isSuper) return;
        Designers.open();
      });
      // 기능·메뉴 관장 / AI 설정 / 코드맵 (슈퍼)
      $("btn-open-features") && $("btn-open-features").addEventListener("click", () => { if (Auth.isSuper && typeof AdminPanels !== "undefined") AdminPanels.openFeatures(); });
      $("btn-open-ai") && $("btn-open-ai").addEventListener("click", () => { if (Auth.isSuper && typeof AdminPanels !== "undefined") AdminPanels.openAI(); });
      $("btn-open-codemap") && $("btn-open-codemap").addEventListener("click", () => { if (Auth.isSuper && typeof AdminPanels !== "undefined") AdminPanels.openCodemap(); });
      $("btn-open-firebase") && $("btn-open-firebase").addEventListener("click", () => { if (Auth.isSuper && typeof AdminPanels !== "undefined") AdminPanels.openFirebase(); });
      // 설정 패널 내 로그아웃
      $("btn-settings-signout") && $("btn-settings-signout").addEventListener("click", () => {
        Auth.signOut();
        this.render();
      });
      // topbar "뷰어로" 버튼 → 편집 모드 종료
      $("btn-exit-edit") && $("btn-exit-edit").addEventListener("click", () => App.exitEdit());
      // topbar "설계자 모드" 버튼 → 뷰어에서 편집 모드로 전환 (회귀 방지)
      $("btn-enter-edit") && $("btn-enter-edit").addEventListener("click", () => App.enterEdit());
    },

    /** 설정 패널의 핀 색상 스와치 렌더 */
    _renderPinColor() {
      const wrap = document.getElementById("settings-pincolor");
      if (!wrap) return;
      const cur = State.pinColor || PinPrefs.get();
      wrap.innerHTML = PinPrefs.PALETTE.map(p =>
        `<button type="button" class="pincolor-sw${p.id === cur ? " active" : ""}" data-pincolor="${p.id}" title="${p.name}" aria-label="${p.name}" style="background:${p.head};border-color:${p.head2};">` +
        (p.id === cur ? '<i class="fa-solid fa-check"></i>' : '') + `</button>`
      ).join("");
    },

    open() {
      const m = document.getElementById("settings-modal");
      if (!m) return;
      this._isOpen = true;
      this.render();
      this._renderPinColor();
      m.classList.remove("hidden");
      requestAnimationFrame(() => m.classList.add("on"));
      // GIS 버튼이 아직 렌더 안됐으면 렌더 시도
      if (Auth._gsiInited) Auth._renderButtons();
      else Auth._initGsi();
    },

    close() {
      const m = document.getElementById("settings-modal");
      if (!m) return;
      this._isOpen = false;
      m.classList.remove("on");
      setTimeout(() => m.classList.add("hidden"), 200);
    },

    /** 로그인 상태/권한에 따라 설정 패널 내용 토글 */
    render() {
      const $ = (id) => document.getElementById(id);
      const out = $("settings-loggedout");
      const inn = $("settings-loggedin");
      if (Auth.user) {
        // 로그인됨
        out && out.classList.add("hidden");
        inn && inn.classList.remove("hidden");
        $("settings-name") && ($("settings-name").textContent = Auth.user.name || Auth.user.email);
        $("settings-email") && ($("settings-email").textContent = Auth.user.email || "");
        const roleEl = $("settings-role");
        if (roleEl) {
          roleEl.textContent = Auth.role === "super" ? "슈퍼관리자" : Auth.role === "designer" ? "디자이너" : "뷰어";
          roleEl.className = "user-role role-" + Auth.role;
        }
        const av = $("settings-avatar");
        if (av) { if (Auth.user.picture) { av.src = Auth.user.picture; av.style.display = ""; } else av.style.display = "none"; }
        // 권한별 액션
        $("settings-designer-actions") && $("settings-designer-actions").classList.toggle("hidden", !Auth.isDesigner);
        $("settings-viewer-note")      && $("settings-viewer-note").classList.toggle("hidden", Auth.isDesigner);
        $("settings-super-actions")    && $("settings-super-actions").classList.toggle("hidden", !Auth.isSuper);
      } else {
        // 미로그인 — 구글 로그인 안내
        out && out.classList.remove("hidden");
        inn && inn.classList.add("hidden");
        // 클라이언트 ID 미설정 안내
        const noclient = $("settings-noclient");
        if (noclient) noclient.classList.toggle("hidden", !!Auth.clientId);
        if (Auth._gsiInited) Auth._renderButtons();
      }
    }
  };

  /* ══════════════════════════════════════════
     DESIGNERS — 디자이너 지정 관리 (슈퍼관리자 전용)
  ══════════════════════════════════════════ */
  const Designers = {
    _tab: "users",
    _reqStatus: "pending",
    _reqCache: [],
    _projReqStatus: "pending",
    _matrixData: null,
    _matrixDirty: null,
    init() {
      const $ = (id) => document.getElementById(id);
      $("designers-close") && $("designers-close").addEventListener("click", () => this.close());
      const bd = document.querySelector('#designers-modal .admin-gate-backdrop');
      bd && bd.addEventListener("click", () => this.close());
      $("designer-add-btn") && $("designer-add-btn").addEventListener("click", () => this.add());
      const inp = $("designer-email-input");
      if (inp) inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); this.add(); } });
      // 탭 전환
      $("adm-tab-users") && $("adm-tab-users").addEventListener("click", () => this.switchTab("users"));
      $("adm-tab-designers") && $("adm-tab-designers").addEventListener("click", () => this.switchTab("designers"));
      $("adm-tab-requests") && $("adm-tab-requests").addEventListener("click", () => this.switchTab("requests"));
      $("adm-tab-domains") && $("adm-tab-domains").addEventListener("click", () => this.switchTab("domains"));
      $("adm-tab-members") && $("adm-tab-members").addEventListener("click", () => this.switchTab("members"));
      $("adm-tab-logs") && $("adm-tab-logs").addEventListener("click", () => this.switchTab("logs"));
      $("adm-tab-proj-req") && $("adm-tab-proj-req").addEventListener("click", () => this.switchTab("proj-req"));
      $("adm-tab-matrix") && $("adm-tab-matrix").addEventListener("click", () => this.switchTab("matrix"));
      $("adm-tab-flags") && $("adm-tab-flags").addEventListener("click", () => this.switchTab("flags"));
      $("matrix-refresh") && $("matrix-refresh").addEventListener("click", () => this.loadMatrix());
      $("matrix-save") && $("matrix-save").addEventListener("click", () => this.saveMatrix());
      const mf = $("matrix-filter-user");
      if (mf) mf.addEventListener("input", () => this.renderMatrix());
      $("proj-req-refresh") && $("proj-req-refresh").addEventListener("click", () => this.loadProjRequests(true));
      document.querySelectorAll("#adm-panel-proj-req .adm-filter-item").forEach((b) => {
        b.addEventListener("click", () => {
          this._projReqStatus = b.dataset.status || "pending";
          document.querySelectorAll("#adm-panel-proj-req .adm-filter-item").forEach((x) => x.classList.toggle("active", x === b));
          this.loadProjRequests(true);
        });
      });
      // 도메인 관리
      $("domain-add-btn") && $("domain-add-btn").addEventListener("click", () => this.addDomain());
      const dinp = $("domain-input");
      if (dinp) dinp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); this.addDomain(); } });
      // 멤버
      $("members-refresh") && $("members-refresh").addEventListener("click", () => this.loadMembers());
      // 사전 등록(초대)
      $("invite-add-btn") && $("invite-add-btn").addEventListener("click", () => this.addInvite());
      const iinp = $("invite-email-input");
      if (iinp) iinp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); this.addInvite(); } });
      // 로그 도구
      $("log-refresh") && $("log-refresh").addEventListener("click", () => this.loadLogs(true));
      $("log-more") && $("log-more").addEventListener("click", () => this.loadLogs(false));
      $("log-purge") && $("log-purge").addEventListener("click", () => this.purgeLogs());
      const _ls = $("log-search");
      if (_ls) _ls.addEventListener("input", () => { clearTimeout(this._logT); this._logT = setTimeout(() => this.loadLogs(true), 280); });
      const _lf = $("log-action-filter");
      if (_lf) _lf.addEventListener("change", () => this.loadLogs(true));
      // 상태 필터
      document.querySelectorAll("#adm-panel-requests .adm-filter-item").forEach((b) => {
        b.addEventListener("click", () => {
          this._reqStatus = b.dataset.status;
          document.querySelectorAll("#adm-panel-requests .adm-filter-item").forEach((x) => x.classList.toggle("active", x === b));
          this.renderRequests();
        });
      });
    },
    switchTab(tab) {
      this._tab = tab;
      const tabs = { users: "adm-tab-users", designers: "adm-tab-designers", requests: "adm-tab-requests", domains: "adm-tab-domains", members: "adm-tab-members", logs: "adm-tab-logs", "proj-req": "adm-tab-proj-req", matrix: "adm-tab-matrix", flags: "adm-tab-flags" };
      const panels = { users: "adm-panel-users", designers: "adm-panel-designers", requests: "adm-panel-requests", domains: "adm-panel-domains", members: "adm-panel-members", logs: "adm-panel-logs", "proj-req": "adm-panel-proj-req", matrix: "adm-panel-matrix", flags: "adm-panel-flags" };
      Object.keys(tabs).forEach((k) => {
        const tEl = document.getElementById(tabs[k]);
        const pEl = document.getElementById(panels[k]);
        if (tEl) tEl.classList.toggle("active", k === tab);
        if (pEl) pEl.classList.toggle("hidden", k !== tab);
      });
      if (tab === "users" && typeof UserMgmt !== "undefined") UserMgmt.load();
      if (tab === "requests") this.loadRequests();
      if (tab === "domains") this.loadDomains();
      if (tab === "members") this.loadMembers();
      if (tab === "proj-req") this.loadProjRequests(true);
      if (tab === "matrix") this.loadMatrix();
      if (tab === "flags") this.loadFlags();
      if (tab === "logs") { this.loadLogActions(); this.loadLogs(true); }
    },

    /* ── 회사 도메인(프로젝트별 허용) 관리 ── */
    async _fillProjectSelect() {
      const sel = document.getElementById("domain-project-select");
      if (!sel) return;
      const cur = sel.value || "*";
      let projects = [];
      try {
        const r = await fetch("/api/projects", { headers: Auth.headers() });
        const j = await r.json();
        projects = j.data || j.results || j || [];
      } catch (e) {}
      sel.innerHTML = '<option value="*">전체 공통 (모든 프로젝트)</option>';
      (projects || []).forEach((p) => {
        const o = document.createElement("option");
        o.value = p.id; o.textContent = p.name || p.id;
        sel.appendChild(o);
      });
      sel.value = cur;
    },
    async loadDomains() {
      await this._fillProjectSelect();
      const listEl = document.getElementById("domains-list");
      if (!listEl) return;
      listEl.innerHTML = '<div class="designers-loading">불러오는 중...</div>';
      try {
        const r = await fetch("/api/allowed-domains", { headers: Auth.headers() });
        if (!r.ok) throw new Error("forbidden");
        const { data } = await r.json();
        if (!data || !data.length) {
          listEl.innerHTML = '<div class="designers-empty">등록된 회사 도메인이 없습니다. (개인 무료메일 제외 모든 회사메일 허용)</div>';
          return;
        }
        // 프로젝트 id→이름 매핑
        let pmap = {};
        try {
          const rp = await fetch("/api/projects", { headers: Auth.headers() });
          const jp = await rp.json();
          (jp.data || jp.results || jp || []).forEach((p) => { pmap[p.id] = p.name || p.id; });
        } catch (e) {}
        listEl.innerHTML = "";
        data.forEach((d) => {
          const scope = d.project_id === "*" ? "전체 공통" : ("프로젝트: " + (pmap[d.project_id] || d.project_id));
          const row = document.createElement("div");
          row.className = "domain-row";
          row.innerHTML = `<span class="domain-name">@${d.domain}</span>
            <span class="domain-scope">${scope}</span>
            <button class="designer-del" data-id="${encodeURIComponent(d.id)}" title="삭제">✕</button>`;
          row.querySelector(".designer-del").addEventListener("click", () => this.removeDomain(d.id));
          listEl.appendChild(row);
        });
      } catch (e) {
        listEl.innerHTML = '<div class="designers-empty">목록을 불러올 수 없습니다(권한 필요).</div>';
      }
    },
    async addDomain() {
      const inp = document.getElementById("domain-input");
      const sel = document.getElementById("domain-project-select");
      const err = document.getElementById("domain-add-error");
      err.classList.add("hidden");
      const domain = (inp.value || "").trim().toLowerCase().replace(/^@/, "");
      const projectId = sel ? (sel.value || "*") : "*";
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) { err.textContent = "올바른 도메인을 입력하세요. (예: company.com)"; err.classList.remove("hidden"); return; }
      if (this._domBusy) return;            // [버그수정] 더블서밋 방지
      this._domBusy = true;
      try {
        const r = await fetch("/api/allowed-domains", { method: "POST", headers: Auth.headers(), body: JSON.stringify({ domain, project_id: projectId }) });
        const j = await r.json();
        if (!r.ok) { err.textContent = j.error || "추가 실패"; err.classList.remove("hidden"); return; }
        inp.value = "";
        await this.loadDomains();
      } catch (e) { err.textContent = "네트워크 오류"; err.classList.remove("hidden"); }
      finally { this._domBusy = false; }
    },
    async removeDomain(id) {
      try {
        await fetch("/api/allowed-domains/" + encodeURIComponent(id), { method: "DELETE", headers: Auth.headers() });
        await this.loadDomains();
      } catch (e) {}
    },

    /* ── 가입 사용자(회사 이메일 자체가입) + 로그인 기록 ── */
    async loadMembers() {
      this.loadInvites();  // 사전 등록(초대) 목록도 함께 갱신
      const listEl = document.getElementById("members-list");
      if (!listEl) return;
      listEl.innerHTML = '<div class="designers-loading">불러오는 중...</div>';
      try {
        const r = await fetch("/api/local-users", { headers: Auth.headers() });
        if (!r.ok) throw new Error("forbidden");
        const { data } = await r.json();
        const totalEl = document.getElementById("members-total");
        if (totalEl) totalEl.textContent = (data ? data.length : 0) + "명";
        if (!data || !data.length) { listEl.innerHTML = '<div class="designers-empty">아직 회사 이메일로 가입한 사용자가 없습니다.</div>'; return; }
        const fmt = (ts) => { if (!ts) return "—"; const d = new Date(ts); return d.toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" }); };
        listEl.innerHTML = "";
        data.forEach((u) => {
          const row = document.createElement("div");
          row.className = "member-row";
          row.innerHTML = `<span class="mem-col-email" title="${u.email}">${u.email}</span>
            <span class="mem-col-name">${u.name || "—"}</span>
            <span class="mem-col-company" title="${u.company || ""}">${u.company || "—"}</span>
            <span class="mem-col-login">${fmt(u.last_login_at)}</span>
            <span class="mem-col-act"><button class="designer-del" title="가입 취소(삭제)">✕</button></span>`;
          row.querySelector(".designer-del").addEventListener("click", () => this.removeMember(u.email));
          listEl.appendChild(row);
        });
      } catch (e) {
        listEl.innerHTML = '<div class="designers-empty">목록을 불러올 수 없습니다(권한 필요).</div>';
      }
    },
    async removeMember(email) {
      if (typeof Prompt !== "undefined" && Prompt.confirm) {
        const ok = await Prompt.confirm("가입 취소", email + " 사용자의 가입을 취소(삭제)하시겠습니까?");
        if (!ok) return;
      }
      try {
        await fetch("/api/local-users/" + encodeURIComponent(email), { method: "DELETE", headers: Auth.headers() });
        await this.loadMembers();
      } catch (e) {}
    },

    /* ── 사전 등록(초대) 관리 ── */
    async loadInvites() {
      const listEl = document.getElementById("invites-list");
      if (!listEl) return;
      try {
        const r = await fetch("/api/invites", { headers: Auth.headers() });
        if (!r.ok) throw new Error("forbidden");
        const { data } = await r.json();
        if (!data || !data.length) { listEl.innerHTML = '<div class="invites-empty">사전 등록된 이메일이 없습니다.</div>'; return; }
        listEl.innerHTML = "";
        data.forEach((iv) => {
          const row = document.createElement("div");
          row.className = "invite-row" + (iv.used ? " used" : "");
          const roleLabel = iv.role === "designer" ? "디자이너" : "뷰어";
          const status = iv.used ? '<span class="invite-status used">가입완료</span>' : '<span class="invite-status pending">대기</span>';
          row.innerHTML = `<span class="invite-mail" title="${iv.email}">${iv.email}</span>
            <span class="invite-role-badge role-${iv.role}">${roleLabel}</span>
            ${status}
            <button class="designer-del" title="사전등록 삭제">✕</button>`;
          row.querySelector(".designer-del").addEventListener("click", () => this.removeInvite(iv.email));
          listEl.appendChild(row);
        });
      } catch (e) {
        listEl.innerHTML = '<div class="invites-empty">목록을 불러올 수 없습니다(권한 필요).</div>';
      }
    },
    async addInvite() {
      const inp = document.getElementById("invite-email-input");
      const sel = document.getElementById("invite-role-select");
      const err = document.getElementById("invite-add-error");
      if (err) err.classList.add("hidden");
      const email = (inp.value || "").trim().toLowerCase();
      const role = sel ? sel.value : "viewer";
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { if (err) { err.textContent = "올바른 이메일을 입력하세요."; err.classList.remove("hidden"); } return; }
      if (this._invBusy) return;            // [버그수정] 더블서밋 방지
      this._invBusy = true;
      try {
        const r = await fetch("/api/invites", { method: "POST", headers: Auth.headers(), body: JSON.stringify({ email, role }) });
        const j = await r.json();
        if (!r.ok) { if (err) { err.textContent = j.error || "등록 실패"; err.classList.remove("hidden"); } return; }
        inp.value = "";
        if (j.already_registered && typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("이미 가입된 사용자입니다. 권한만 갱신됩니다.");
        await this.loadInvites();
      } catch (e) { if (err) { err.textContent = "네트워크 오류"; err.classList.remove("hidden"); } }
      finally { this._invBusy = false; }
    },
    async removeInvite(email) {
      try {
        await fetch("/api/invites/" + encodeURIComponent(email), { method: "DELETE", headers: Auth.headers() });
        await this.loadInvites();
      } catch (e) {}
    },

    async open() {
      if (!Auth.isSuper) return;
      const sa = document.getElementById("super-admin-email");
      if (sa) sa.textContent = Auth.user ? Auth.user.email : (Auth.superAdmin || "designssir@gmail.com");
      document.getElementById("designers-modal").classList.remove("hidden");
      requestAnimationFrame(() => document.getElementById("designers-modal").classList.add("on"));
      this.switchTab(this._tab);
      await this.render();
      this.loadRequests(); // 배지 갱신용 선로딩
    },
    close() {
      const m = document.getElementById("designers-modal");
      m.classList.remove("on");
      setTimeout(() => m.classList.add("hidden"), 200);
    },
    async render() {
      const listEl = document.getElementById("designers-list");
      listEl.innerHTML = '<div class="designers-loading">불러오는 중...</div>';
      try {
        const r = await fetch("/api/designers", { headers: Auth.headers() });
        if (!r.ok) throw new Error("forbidden");
        const { data } = await r.json();
        if (!data || !data.length) { listEl.innerHTML = '<div class="designers-empty">지정된 디자이너가 없습니다.</div>'; return; }
        listEl.innerHTML = "";
        data.forEach((d) => {
          const row = document.createElement("div");
          row.className = "designer-row";
          row.innerHTML = `<span class="designer-email">${d.email}</span>
            <button class="designer-del" data-email="${encodeURIComponent(d.email)}" title="삭제">✕</button>`;
          row.querySelector(".designer-del").addEventListener("click", () => this.remove(d.email));
          listEl.appendChild(row);
        });
      } catch (e) {
        listEl.innerHTML = '<div class="designers-empty">목록을 불러올 수 없습니다(권한 필요).</div>';
      }
    },
    async add() {
      const inp = document.getElementById("designer-email-input");
      const err = document.getElementById("designer-add-error");
      err.classList.add("hidden");
      const email = (inp.value || "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { err.textContent = "올바른 이메일을 입력하세요."; err.classList.remove("hidden"); return; }
      try {
        const r = await fetch("/api/designers", { method: "POST", headers: Auth.headers(), body: JSON.stringify({ email }) });
        const j = await r.json();
        if (!r.ok) { err.textContent = j.error || "추가 실패"; err.classList.remove("hidden"); return; }
        inp.value = "";
        await this.render();
      } catch (e) { err.textContent = "네트워크 오류"; err.classList.remove("hidden"); }
    },
    async remove(email) {
      if (!await Prompt.confirm("권한 해제", email + " 의 디자이너 권한을 해제할까요?")) return;
      try {
        await fetch("/api/designers/" + encodeURIComponent(email), { method: "DELETE", headers: Auth.headers() });
        await this.render();
      } catch (e) {}
    },

    /* ── 권한 매트릭스 (사용자 × 프로젝트) ── */
    async loadMatrix() {
      const container = document.getElementById("matrix-container"); if (!container) return;
      this._matrixDirty = new Map();
      this._updateMatrixDirtyUI();
      container.innerHTML = '<div class="designers-loading">불러오는 중...</div>';
      try {
        const r = await fetch("/api/admin/access-matrix", { headers: Auth.headers() });
        if (!r.ok) { container.innerHTML = '<div class="designers-empty">로드 실패 (관리자/소유자 전용)</div>'; return; }
        this._matrixData = await r.json();
        this.renderMatrix();
      } catch (e) { container.innerHTML = '<div class="designers-empty">네트워크 오류</div>'; }
    },
    renderMatrix() {
      const container = document.getElementById("matrix-container"); if (!container || !this._matrixData) return;
      const { users, projects, cells } = this._matrixData;
      const filterVal = ((document.getElementById("matrix-filter-user") || {}).value || "").toLowerCase().trim();
      const filteredUsers = filterVal ? users.filter((u) => u.email.toLowerCase().includes(filterVal)) : users;
      if (!filteredUsers.length || !projects.length) {
        container.innerHTML = '<div class="designers-empty">데이터 없음</div>'; return;
      }
      const esc = (s) => (typeof UI !== "undefined" && UI.escapeHtml) ? UI.escapeHtml(String(s || "")) : String(s || "");
      const cellMap = new Map();
      for (const c of cells) cellMap.set(c.email + "::" + c.project_id, c.role);
      if (this._matrixDirty) for (const [k, v] of this._matrixDirty) cellMap.set(k, v);
      let html = '<table class="matrix-table"><thead><tr><th class="matrix-email-col">이메일</th>';
      for (const p of projects) html += '<th class="matrix-proj-col" title="' + esc(p.name) + '">' + esc(p.name.length > 10 ? p.name.slice(0, 10) + "…" : p.name) + '</th>';
      html += '</tr></thead><tbody>';
      for (const u of filteredUsers) {
        html += '<tr><td class="matrix-email-cell" title="' + esc(u.email) + '">' + esc(u.email) + '</td>';
        for (const p of projects) {
          const key = u.email + "::" + p.id;
          const role = cellMap.get(key) || "none";
          const dirty = this._matrixDirty && this._matrixDirty.has(key);
          html += '<td class="matrix-cell' + (dirty ? " dirty" : "") + '" data-email="' + esc(u.email) + '" data-pid="' + esc(p.id) + '" data-role="' + esc(role) + '">' + this._mxBadge(role) + '</td>';
        }
        html += '</tr>';
      }
      html += '</tbody></table>';
      container.innerHTML = html;
      container.addEventListener("click", (e) => {
        const cell = e.target.closest(".matrix-cell"); if (!cell) return;
        const next = { none: "viewer", viewer: "designer", designer: "none" }[cell.dataset.role] || "viewer";
        const key = cell.dataset.email + "::" + cell.dataset.pid;
        if (!this._matrixDirty) this._matrixDirty = new Map();
        this._matrixDirty.set(key, next);
        cell.dataset.role = next;
        cell.innerHTML = this._mxBadge(next);
        cell.classList.add("dirty");
        this._updateMatrixDirtyUI();
      }, { once: false });
    },
    _mxBadge(role) {
      if (!role || role === "none") return '<span class="mx-none">—</span>';
      if (role === "viewer") return '<span class="mx-viewer">뷰어</span>';
      return '<span class="mx-designer">설계자</span>';
    },
    _updateMatrixDirtyUI() {
      const n = this._matrixDirty ? this._matrixDirty.size : 0;
      const cnt = document.getElementById("matrix-dirty-count");
      const btn = document.getElementById("matrix-save");
      if (cnt) { cnt.textContent = "변경: " + n + "건"; cnt.classList.toggle("hidden", n === 0); }
      if (btn) btn.classList.toggle("hidden", n === 0);
    },
    async saveMatrix() {
      if (!this._matrixDirty || !this._matrixDirty.size) return;
      const btn = document.getElementById("matrix-save");
      if (btn) { btn.disabled = true; btn.textContent = "저장 중…"; }
      const updates = [];
      for (const [key, role] of this._matrixDirty) {
        const sep = key.indexOf("::");
        updates.push({ email: key.slice(0, sep), project_id: key.slice(sep + 2), role });
      }
      try {
        const r = await fetch("/api/admin/access-matrix", { method: "POST", headers: Auth.headers(), body: JSON.stringify({ updates }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || "저장 실패");
        this._matrixDirty = new Map();
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("권한 매트릭스 저장 — " + j.updated + "건");
        await this.loadMatrix();
      } catch (e) {
        alert("저장 실패: " + (e && e.message || "오류"));
        if (btn) { btn.disabled = false; btn.textContent = "저장"; }
      }
    },

    /* ── 시스템 플래그 ── */
    async loadFlags() {
      const list = document.getElementById("flags-list"); if (!list) return;
      list.innerHTML = '<div class="designers-loading">불러오는 중...</div>';
      const FLAG_DEFS = [
        { key: "AI_ENABLED",               label: "AI 채팅 활성화",       desc: "AI 기능 마스터 스위치 — OFF 시 /api/ai/* 전체 비활성화", danger: true },
        { key: "ACCESS_REQUEST_ENABLED",    label: "프로젝트 접근 신청",   desc: "비멤버가 프로젝트 접근 신청할 수 있는 기능" },
        { key: "OFFLINE_ENABLED",           label: "오프라인 다운로드",    desc: "오프라인 번들 다운로드 및 캐시 기능" },
        { key: "ALLOW_VIEWER_SIGNUP",       label: "자체가입 허용",        desc: "회사 이메일로 직접 가입 허용 (allowed_domains 화이트리스트 필요)" },
        { key: "PANO_VIEWER_ENABLED",       label: "360° 파노라마 뷰어",   desc: "파노라마 뷰어 기능 활성화" },
      ];
      try {
        const r = await fetch("/api/admin/system-flags", { headers: Auth.headers() });
        if (!r.ok) { list.innerHTML = '<div class="designers-empty">슈퍼 관리자 전용</div>'; return; }
        const { data } = await r.json();
        const esc = (s) => (typeof UI !== "undefined" && UI.escapeHtml) ? UI.escapeHtml(String(s || "")) : String(s || "");
        const savedMap = new Map((data || []).map((row) => [row.skey.replace("flag:", ""), row.value]));
        list.innerHTML = "";
        FLAG_DEFS.forEach((def) => {
          const raw = savedMap.get(def.key);
          const isOn = raw === undefined ? true : raw === "true";
          const row = document.createElement("div");
          row.className = "flag-row" + (def.danger ? " flag-danger" : "");
          row.innerHTML =
            '<div class="flag-info">' +
              '<span class="flag-label">' + (def.danger ? "" : "") + esc(def.label) + '</span>' +
              '<span class="flag-desc">' + esc(def.desc) + '</span>' +
              '<span class="flag-key">' + esc(def.key) + '</span>' +
            '</div>' +
            '<button class="flag-toggle' + (isOn ? " on" : "") + '" data-key="' + esc(def.key) + '" data-val="' + isOn + '" type="button" aria-label="' + (isOn ? "켜짐, 클릭해서 끄기" : "꺼짐, 클릭해서 켜기") + '" aria-pressed="' + isOn + '">' +
              '<span class="flag-thumb"></span>' +
            '</button>';
          row.querySelector(".flag-toggle").addEventListener("click", (e) => this.toggleFlag(e.currentTarget));
          list.appendChild(row);
        });
      } catch (e) { list.innerHTML = '<div class="designers-empty">오류: ' + (e && e.message || "네트워크 오류") + '</div>'; }
    },
    async toggleFlag(btn) {
      const key = btn.dataset.key;
      const newVal = btn.dataset.val !== "true";
      btn.disabled = true;
      try {
        const r = await fetch("/api/admin/system-flags", { method: "PUT", headers: Auth.headers(), body: JSON.stringify({ key, value: String(newVal) }) });
        if (!r.ok) throw new Error("HTTP " + r.status);
        btn.dataset.val = String(newVal);
        btn.classList.toggle("on", newVal);
        btn.setAttribute("aria-pressed", newVal);
        btn.setAttribute("aria-label", newVal ? "켜짐, 클릭해서 끄기" : "꺼짐, 클릭해서 켜기");
        // [토스트 스팸 제거] 스위치 .on 상태 + aria-pressed 로 결과가 이미 드러난다.
      } catch (e) { alert("설정 실패"); }
      finally { btn.disabled = false; }
    },

    /* ── 프로젝트 접근 신청 관리 ── */
    async loadProjRequests(reset) {
      const list = document.getElementById("proj-req-list"); if (!list) return;
      if (reset) list.innerHTML = '<div class="designers-loading">불러오는 중...</div>';
      try {
        const r = await fetch("/api/admin/project-access-requests?status=" + encodeURIComponent(this._projReqStatus), { headers: Auth.headers() });
        if (!r.ok) { list.innerHTML = '<div class="designers-empty">로드 실패</div>'; return; }
        const { data } = await r.json();
        // 배지 갱신
        const badge = document.getElementById("adm-proj-req-badge");
        const pending = data ? data.filter((x) => x.status === "pending") : [];
        if (badge) { if (pending.length) { badge.textContent = pending.length; badge.classList.remove("hidden"); } else { badge.classList.add("hidden"); } }
        if (!data || !data.length) { list.innerHTML = '<div class="designers-empty">신청 없음</div>'; return; }
        const esc = (s) => (typeof UI !== "undefined" && UI.escapeHtml) ? UI.escapeHtml(s) : s;
        list.innerHTML = "";
        data.forEach((req) => {
          const d = new Date(req.created_at);
          const dateStr = d.getFullYear() + "." + String(d.getMonth()+1).padStart(2,"0") + "." + String(d.getDate()).padStart(2,"0");
          const row = document.createElement("div");
          row.className = "req-row";
          row.innerHTML =
            '<span class="req-col-project" title="' + esc(req.project_name || req.project_id) + '">' + esc(req.project_name || req.project_id) + '</span>' +
            '<span class="req-col-email" title="' + esc(req.email) + '">' + esc(req.email) + '</span>' +
            (req.message ? '<span class="req-col-msg">' + esc(req.message) + '</span>' : '<span class="req-col-msg"></span>') +
            '<span class="req-col-date">' + dateStr + '</span>' +
            (req.status === "pending"
              ? '<button class="admin-gate-btn primary req-btn" data-act="approve" type="button">승인</button>' +
                '<button class="admin-gate-btn danger req-btn" data-act="reject" type="button">거절</button>'
              : '<span class="req-status-label req-status-' + esc(req.status) + '">' + (req.status === "approved" ? "승인됨" : "거절됨") + '</span>');
          if (req.status === "pending") {
            row.querySelector('[data-act="approve"]').addEventListener("click", () => this._handleProjReq(req.id, req.project_id, "approve"));
            row.querySelector('[data-act="reject"]').addEventListener("click", () => this._handleProjReq(req.id, req.project_id, "reject"));
          }
          list.appendChild(row);
        });
      } catch (e) { list.innerHTML = '<div class="designers-empty">오류: ' + (e && e.message ? e.message : "네트워크 오류") + '</div>'; }
    },
    async _handleProjReq(rid, projectId, action) {
      try {
        const r = await fetch("/api/projects/" + encodeURIComponent(projectId) + "/access-requests/" + encodeURIComponent(rid) + "/" + action,
          { method: "POST", headers: Auth.headers() });
        if (!r.ok) throw new Error("HTTP " + r.status);
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("" + (action === "approve" ? "승인" : "거절") + " 처리됨");
        await this.loadProjRequests(true);
      } catch (e) { alert("처리 실패"); }
    },

    /* ── 사용 신청(access requests) 관리 ── */
    async loadRequests() {
      try {
        const r = await fetch("/api/access-requests", { headers: Auth.headers() });
        if (!r.ok) { this._reqCache = []; }
        else { const j = await r.json(); this._reqCache = (j && j.data) || []; }
      } catch (e) { this._reqCache = []; }
      this._updateCounts();
      if (this._tab === "requests") this.renderRequests();
    },
    _updateCounts() {
      const c = { pending: 0, approved: 0, rejected: 0, all: this._reqCache.length };
      this._reqCache.forEach((q) => { if (c[q.status] != null) c[q.status]++; });
      const set = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = n; };
      set("adm-cnt-pending", c.pending); set("adm-cnt-approved", c.approved);
      set("adm-cnt-rejected", c.rejected); set("adm-cnt-all", c.all);
      const badge = document.getElementById("adm-req-badge");
      if (badge) { badge.textContent = c.pending; badge.classList.toggle("hidden", c.pending === 0); }
    },
    _statusLabel(s) {
      return s === "approved" ? "승인됨" : s === "rejected" ? "거절됨" : "대기 중";
    },
    renderRequests() {
      const listEl = document.getElementById("adm-req-list");
      if (!listEl) return;
      const rows = this._reqStatus === "all"
        ? this._reqCache
        : this._reqCache.filter((q) => q.status === this._reqStatus);
      if (!rows.length) {
        listEl.innerHTML = '<div class="adm-req-empty"><i class="fa-regular fa-folder-open"></i><span>해당 상태의 신청이 없습니다.</span></div>';
        return;
      }
      listEl.innerHTML = "";
      rows.forEach((q) => {
        const row = document.createElement("div");
        row.className = "adm-req-row st-" + q.status;
        const initials = (q.name || q.email || "?").trim().charAt(0).toUpperCase();
        row.innerHTML = `
          <div class="adm-col-name">
            <span class="adm-avatar">${UI.escapeHtml(initials)}</span>
            <span class="adm-name-block">
              <span class="adm-name">${UI.escapeHtml(q.name || "(이름 없음)")}</span>
              <span class="adm-email">${UI.escapeHtml(q.email)}</span>
            </span>
          </div>
          <div class="adm-col-company">
            <span class="adm-company">${UI.escapeHtml(q.company || "—")}</span>
            <span class="adm-country">${UI.escapeHtml(q.country || "")}</span>
          </div>
          <div class="adm-col-contact">${UI.escapeHtml(q.phone || "—")}</div>
          <div class="adm-col-status"><span class="adm-badge ${q.status}">${this._statusLabel(q.status)}</span></div>
          <div class="adm-col-act"></div>
        `;
        const act = row.querySelector(".adm-col-act");
        if (q.status === "pending") {
          act.innerHTML = `<button class="adm-act-btn approve" title="승인"><i class="fa-solid fa-check"></i></button>
            <button class="adm-act-btn reject" title="거절"><i class="fa-solid fa-xmark"></i></button>`;
          act.querySelector(".approve").addEventListener("click", () => this.approve(q));
          act.querySelector(".reject").addEventListener("click", () => this.reject(q));
        } else if (q.status === "rejected") {
          act.innerHTML = `<button class="adm-act-btn approve" title="승인으로 변경"><i class="fa-solid fa-rotate-left"></i></button>`;
          act.querySelector(".approve").addEventListener("click", () => this.approve(q));
        } else {
          act.innerHTML = `<button class="adm-act-btn reject" title="권한 회수"><i class="fa-solid fa-ban"></i></button>`;
          act.querySelector(".reject").addEventListener("click", () => this.reject(q));
        }
        listEl.appendChild(row);
      });
    },
    async approve(q) {
      if (this._reqBusy) return;            // [버그수정] 더블클릭 시 승인 2회 호출 방지
      this._reqBusy = true;
      try {
        const r = await fetch("/api/access-requests/" + encodeURIComponent(q.id) + "/approve", { method: "POST", headers: Auth.headers() });
        if (!r.ok) { Prompt.toast("승인 실패"); return; }
        Prompt.toast(q.name + " 님을 디자이너로 승인했습니다");
        await this.loadRequests();
        await this.render();
      } catch (e) { Prompt.toast("네트워크 오류"); }
      finally { this._reqBusy = false; }
    },
    async reject(q) {
      if (this._reqBusy) return;
      if (!await Prompt.confirm("신청 거절", (q.name || q.email) + " 의 신청을 거절/회수할까요?")) return;
      this._reqBusy = true;
      try {
        const r = await fetch("/api/access-requests/" + encodeURIComponent(q.id) + "/reject", { method: "POST", headers: Auth.headers() });
        if (!r.ok) { Prompt.toast("처리 실패"); return; }
        Prompt.toast("처리되었습니다");
        await this.loadRequests();
        await this.render();
      } catch (e) { Prompt.toast("네트워크 오류"); }
      finally { this._reqBusy = false; }
    },

    /* ── 활동 로그(슈퍼관리자 전용) ── */
    _logOffset: 0,
    _logActionLabel(a) {
      const m = {
        "auth.login": "로그인", "access.approve": "신청 승인", "access.reject": "신청 거절/회수",
        "project.create": "프로젝트 생성", "project.delete": "프로젝트 삭제",
        "deployment.create": "배포(저장)",
      };
      return m[a] || a;
    },
    _fmtTime(ts) {
      try {
        const d = new Date(ts);
        const p = (n) => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
      } catch (e) { return String(ts); }
    },
    async loadLogActions() {
      const sel = document.getElementById("log-action-filter");
      if (!sel) return;
      try {
        const r = await fetch("/api/activity-logs/actions", { headers: Auth.headers() });
        if (!r.ok) return;
        const { data } = await r.json();
        const cur = sel.value;
        sel.innerHTML = '<option value="">모든 액션</option>';
        (data || []).forEach((row) => {
          const o = document.createElement("option");
          o.value = row.action;
          o.textContent = `${this._logActionLabel(row.action)} (${row.n})`;
          sel.appendChild(o);
        });
        sel.value = cur;
      } catch (e) {}
    },
    async loadLogs(reset) {
      const listEl = document.getElementById("log-list");
      if (!listEl) return;
      if (reset) { this._logOffset = 0; listEl.innerHTML = '<div class="log-empty">불러오는 중…</div>'; }
      const q = (document.getElementById("log-search") || {}).value || "";
      const action = (document.getElementById("log-action-filter") || {}).value || "";
      const limit = 80;
      const params = new URLSearchParams({ limit: String(limit), offset: String(this._logOffset) });
      if (q) params.set("q", q);
      if (action) params.set("action", action);
      try {
        const r = await fetch("/api/activity-logs?" + params.toString(), { headers: Auth.headers() });
        if (!r.ok) { listEl.innerHTML = '<div class="log-empty">로그를 불러올 수 없습니다(권한 필요).</div>'; return; }
        const j = await r.json();
        const rows = j.data || [];
        const totalEl = document.getElementById("log-total");
        if (totalEl) totalEl.textContent = (j.total || 0) + "건";
        if (reset) listEl.innerHTML = "";
        if (!rows.length && reset) {
          listEl.innerHTML = '<div class="log-empty"><i class="fa-regular fa-folder-open"></i><span>기록이 없습니다.</span></div>';
        } else {
          rows.forEach((it) => listEl.appendChild(this._logRow(it)));
        }
        this._logOffset += rows.length;
        const moreWrap = document.getElementById("log-more-wrap");
        if (moreWrap) moreWrap.classList.toggle("hidden", this._logOffset >= (j.total || 0));
      } catch (e) {
        listEl.innerHTML = '<div class="log-empty">네트워크 오류</div>';
      }
    },
    _logRow(it) {
      const row = document.createElement("div");
      row.className = "log-row role-" + (it.actor_role || "guest");
      const actor = it.actor_email || "(게스트)";
      const target = [it.target_type, it.target_id].filter(Boolean).join(" · ") || "—";
      let detail = "";
      if (it.detail) { try { detail = JSON.stringify(JSON.parse(it.detail)); } catch (e) { detail = it.detail; } }
      row.innerHTML = `
        <span class="log-col-time">${UI.escapeHtml(this._fmtTime(it.ts))}</span>
        <span class="log-col-actor">
          <span class="log-role-badge ${UI.escapeHtml(it.actor_role || "guest")}">${UI.escapeHtml(it.actor_role || "guest")}</span>
          <span class="log-actor-email">${UI.escapeHtml(actor)}</span>
        </span>
        <span class="log-col-action"><span class="log-action-badge">${UI.escapeHtml(this._logActionLabel(it.action))}</span></span>
        <span class="log-col-target" title="${UI.escapeHtml(detail)}">${UI.escapeHtml(target)}</span>
        <span class="log-col-act"><button class="log-del-btn" title="이 기록 삭제"><i class="fa-solid fa-xmark"></i></button></span>
      `;
      row.querySelector(".log-del-btn").addEventListener("click", () => this.deleteLog(it.id, row));
      return row;
    },
    async deleteLog(id, rowEl) {
      try {
        const r = await fetch("/api/activity-logs/" + encodeURIComponent(id), { method: "DELETE", headers: Auth.headers() });
        if (r.ok && rowEl) rowEl.remove();
      } catch (e) {}
    },
    async purgeLogs() {
      if (!await Prompt.confirm("로그 전체 삭제", "모든 활동 로그를 비울까요? (되돌릴 수 없습니다)")) return;
      try {
        const r = await fetch("/api/activity-logs?all=1", { method: "DELETE", headers: Auth.headers() });
        if (r.ok) { Prompt.toast("로그를 정리했습니다"); this.loadLogActions(); this.loadLogs(true); }
        else Prompt.toast("정리 실패");
      } catch (e) { Prompt.toast("네트워크 오류"); }
    }
  };

  /* ══════════════════════════════════════════
     PDF ANNO — 최소 PDF 주석(ezPDF) : 형광펜/사각형/자유선/텍스트메모
     주석은 State.annotations[]에 % 좌표(0~1000)로 저장, 페이지별 렌더.
  ══════════════════════════════════════════ */
  /* ══════════════════════════════════════════════════════════════
     USER MANAGEMENT — SECMS 관리자 "사용자 관리" 완전 차용 (엑셀형 그리드)
     ────────────────────────────────────────────────────────────────
     · SECMS components/admin/UserManagement.tsx 구조 그대로:
         좌측 필터레일 + 통합 사용자 테이블(엑셀형 셀 괘선) + 체크박스 일괄선택
         + 일괄작업(권한/삭제) + 페이지크기 선택 + 페이지네이션 + 행 상태 틴트.
     · 360 실제 역할(디자이너↔뷰어)에 매핑. 24개 세부권한(케이블 도메인)은 제외.
     · 기존 검증 엔드포인트 클라이언트 통합:
         GET /api/designers · /api/local-users · /api/access-requests · /api/projects(호선수)
       역할변경 POST/DELETE /api/designers · 승인거절 /api/access-requests/:id/(approve|reject)
       가입취소 DELETE /api/local-users/:email
  ══════════════════════════════════════════════════════════════ */
  const UserMgmt = {
    _all: [],
    _designerSet: null,
    _filter: "active",     // active | designer | pending | rejected | all
    _q: "",
    _page: 1,
    _pageSize: 20,
    _busy: false,
    _selected: null,       // Set<email>

    _protected() {
      const s = new Set(["designssir@gmail.com"]);
      if (Auth.superAdmin) s.add(String(Auth.superAdmin).toLowerCase());
      if (Auth.isSuper && Auth.user && Auth.user.email) s.add(String(Auth.user.email).toLowerCase());
      return s;
    },

    init() {
      const $ = (id) => document.getElementById(id);
      if (!this._selected) this._selected = new Set();
      document.querySelectorAll("#adm-panel-users .um-filter-item").forEach((b) => {
        b.addEventListener("click", () => {
          this._filter = b.dataset.filter; this._page = 1;
          this._syncFilterUI(); this.render();
        });
      });
      const s = $("um-search");
      if (s) s.addEventListener("input", () => { this._q = (s.value || "").trim().toLowerCase(); this._page = 1; this.render(); });
      $("um-refresh") && $("um-refresh").addEventListener("click", () => this.load());
      $("um-add-btn") && $("um-add-btn").addEventListener("click", () => this._quickAdd());
      const ai = $("um-add-input");
      if (ai) ai.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); this._quickAdd(); } });
      const ps = $("um-pagesize");
      if (ps) ps.addEventListener("change", () => { this._pageSize = parseInt(ps.value, 10) || 20; this._page = 1; this.render(); });
      // 전체 선택(현재 페이지)
      const all = $("um-all");
      if (all) all.addEventListener("change", () => this._toggleAllVisible(all.checked));
      // 일괄 작업
      $("um-bulk-designer") && $("um-bulk-designer").addEventListener("click", () => this._bulkRole("designer"));
      $("um-bulk-viewer") && $("um-bulk-viewer").addEventListener("click", () => this._bulkRole("viewer"));
      $("um-bulk-del") && $("um-bulk-del").addEventListener("click", () => this._bulkDelete());
    },

    /* ── 데이터: 4개 엔드포인트 병렬 → 이메일 기준 통합 ── */
    async load() {
      const tbody = document.getElementById("um-tbody");
      if (tbody) tbody.innerHTML = '<tr><td colspan="10" class="um-loading">불러오는 중...</td></tr>';
      const H = Auth.headers();
      const safe = async (url) => {
        try { const r = await fetch(url, { headers: H }); if (!r.ok) return []; const j = await r.json(); return (j && (j.data || j.results)) || (Array.isArray(j) ? j : []); }
        catch (e) { return []; }
      };
      const [designers, members, requests, projects] = await Promise.all([
        safe("/api/designers"), safe("/api/local-users"), safe("/api/access-requests"), safe("/api/projects"),
      ]);
      const dset = new Set(designers.map((d) => String(d.email || "").toLowerCase()));
      this._designerSet = dset;
      // 호선수: owner 이메일별 프로젝트 수
      const pcount = new Map();
      projects.forEach((p) => { const o = String(p.owner || "").toLowerCase(); if (o) pcount.set(o, (pcount.get(o) || 0) + 1); });

      const map = new Map();
      const ensure = (email) => {
        const k = String(email || "").toLowerCase();
        if (!k) return null;
        if (!map.has(k)) map.set(k, { email: k, name: "", company: "", isDesigner: dset.has(k), isMember: false, reqStatus: null, requestId: null, last_login: null, created_at: null });
        return map.get(k);
      };
      designers.forEach((d) => { const u = ensure(d.email); if (!u) return; if (d.name) u.name = d.name; if (d.created_at) u.created_at = d.created_at; });
      members.forEach((m) => {
        const u = ensure(m.email); if (!u) return;
        u.isMember = true;
        if (m.name) u.name = m.name;
        if (m.company) u.company = m.company;
        if (m.last_login_at) u.last_login = m.last_login_at;
        if (m.created_at) u.created_at = u.created_at || m.created_at;
      });
      requests.forEach((rq) => {
        const u = ensure(rq.email); if (!u) return;
        if (rq.name && !u.name) u.name = rq.name;
        if (rq.company && !u.company) u.company = rq.company;
        u.reqStatus = rq.status || null;
        u.requestId = rq.id || null;
        if (rq.created_at) u.created_at = u.created_at || rq.created_at;
      });

      // [마스터 지시] 슈퍼관리자는 사용자 명단에 노출하지 않는다 (SECMS와 동일 — 관리 대상이 아님).
      const prot = this._protected();
      this._all = Array.from(map.values())
        .filter((u) => !prot.has(u.email))
        .map((u) => {
          const role = u.isDesigner ? "designer" : "viewer";
          let status;
          if (u.isDesigner || u.isMember) status = "active";
          else if (u.reqStatus === "pending") status = "pending";
          else if (u.reqStatus === "rejected") status = "rejected";
          else status = "active";
          return Object.assign(u, { role, status, projects: pcount.get(u.email) || 0 });
        });
      // 사라진 선택 제거
      const live = new Set(this._all.map((u) => u.email));
      this._selected.forEach((e) => { if (!live.has(e)) this._selected.delete(e); });
      this._updateCounts();
      this._syncFilterUI();
      this.render();
    },

    _updateCounts() {
      const c = { active: 0, designer: 0, pending: 0, rejected: 0, all: this._all.length };
      this._all.forEach((u) => {
        if (u.role === "designer") c.designer++;
        if (u.status === "pending") c.pending++;
        else if (u.status === "rejected") c.rejected++;
        else c.active++;
      });
      const set = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = n; };
      set("um-cnt-active", c.active); set("um-cnt-designer", c.designer);
      set("um-cnt-pending", c.pending); set("um-cnt-rejected", c.rejected); set("um-cnt-all", c.all);
    },
    _syncFilterUI() {
      document.querySelectorAll("#adm-panel-users .um-filter-item").forEach((b) => {
        b.classList.toggle("active", b.dataset.filter === this._filter);
      });
    },

    _visible() {
      let list = this._all.slice();
      const f = this._filter;
      if (f === "active") list = list.filter((u) => u.status === "active");
      else if (f === "designer") list = list.filter((u) => u.role === "designer");
      else if (f === "pending") list = list.filter((u) => u.status === "pending");
      else if (f === "rejected") list = list.filter((u) => u.status === "rejected");
      if (this._q) list = list.filter((u) =>
        (u.email || "").includes(this._q) || (u.name || "").toLowerCase().includes(this._q) || (u.company || "").toLowerCase().includes(this._q));
      list.sort((a, b) => {
        const pa = a.status === "pending" ? 0 : 1, pb = b.status === "pending" ? 0 : 1;
        if (pa !== pb) return pa - pb;
        if ((a.role === "designer") !== (b.role === "designer")) return a.role === "designer" ? -1 : 1;
        return (a.email || "").localeCompare(b.email || "");
      });
      return list;
    },

    render() {
      const tbody = document.getElementById("um-tbody");
      if (!tbody) return;
      const esc = (s) => (typeof UI !== "undefined" && UI.escapeHtml) ? UI.escapeHtml(s == null ? "" : String(s)) : String(s == null ? "" : s);
      const prot = this._protected();
      const all = this._visible();
      const total = all.length;
      const pages = Math.max(1, Math.ceil(total / this._pageSize));
      if (this._page > pages) this._page = pages;
      const start = (this._page - 1) * this._pageSize;
      const rows = all.slice(start, start + this._pageSize);

      const fmtD = (ts) => { if (!ts) return "—"; const d = new Date(ts); return isNaN(d) ? "—" : d.toISOString().slice(0, 10); };
      const ago = (ts) => { if (!ts) return ""; const d = new Date(ts); if (isNaN(d)) return ""; const days = Math.floor((Date.now() - d.getTime()) / 86400000); return days >= 0 ? (days + "일 경과") : ""; };
      const fmtT = (ts) => { if (!ts) return "—"; const d = new Date(ts); return isNaN(d) ? "—" : d.toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" }); };

      if (!rows.length) { tbody.innerHTML = '<tr><td colspan="10" class="um-empty">표시할 사용자가 없습니다.</td></tr>'; this._renderPager(pages, total); this._renderBulk(); return; }

      tbody.innerHTML = rows.map((u) => {
        const isProt = prot.has(u.email);
        const local = (u.email || "").split("@")[0];
        const sel = this._selected.has(u.email);
        const rowCls = (u.status === "pending" ? " um-r-pending" : u.status === "rejected" ? " um-r-rejected" : "") + (sel ? " um-r-sel" : "");
        const ck = isProt ? '<span class="um-cklock">—</span>' : '<input type="checkbox" class="um-ck-row" data-email="' + esc(u.email) + '"' + (sel ? " checked" : "") + ">";
        const statusBadge =
          u.status === "pending"  ? '<span class="um-badge um-st-pending">신청 대기</span>'
          : u.status === "rejected" ? '<span class="um-badge um-st-rejected">거절됨</span>'
          : '<span class="um-badge um-st-active">활성</span>';
        const lockRole = isProt || u.status === "pending" || u.status === "rejected";
        const roleCell = isProt
          ? '<span class="um-badge um-role-admin">슈퍼관리자</span>'
          : '<div class="um-roletoggle' + (lockRole ? ' locked' : '') + '" data-email="' + esc(u.email) + '">' +
              '<button class="um-rt-btn' + (u.role === "designer" ? ' on' : '') + '" data-role="designer"' + (lockRole ? ' disabled' : '') + '>디자이너</button>' +
              '<button class="um-rt-btn' + (u.role === "viewer" ? ' on' : '') + '" data-role="viewer"' + (lockRole ? ' disabled' : '') + '>뷰어</button>' +
            '</div>';
        let act = "";
        if (u.status === "pending" && u.requestId) {
          act = '<button class="um-act um-approve" data-id="' + esc(u.requestId) + '" data-email="' + esc(u.email) + '">승인</button>' +
                '<button class="um-act um-reject" data-id="' + esc(u.requestId) + '">거절</button>';
        } else if (isProt) {
          act = '<span class="um-act-none">—</span>';
        } else if (u.isMember) {
          act = '<button class="um-act um-del" data-email="' + esc(u.email) + '" title="가입 취소(삭제)">삭제</button>';
        } else if (u.status === "rejected" && u.requestId) {
          act = '<button class="um-act um-approve" data-id="' + esc(u.requestId) + '" data-email="' + esc(u.email) + '">재승인</button>';
        } else {
          act = '<span class="um-act-none">—</span>';
        }
        const adminTag = isProt ? ' <span class="um-tag-admin">ADMIN</span>' : '';
        return '<tr class="' + rowCls.trim() + '">' +
          '<td class="um-c-ck">' + ck + '</td>' +
          '<td class="um-c-id"><span class="um-id">' + esc(local) + '</span>' + adminTag + '</td>' +
          '<td class="um-c-name"><div class="um-name">' + esc(u.name || "—") + '</div><div class="um-mail">' + esc(u.email) + '</div></td>' +
          '<td class="um-c-co">' + esc(u.company || "—") + '</td>' +
          '<td class="um-c-role">' + roleCell + '</td>' +
          '<td class="um-c-status">' + statusBadge + '</td>' +
          '<td class="um-c-proj">' + (u.projects || 0) + '</td>' +
          '<td class="um-c-login">' + fmtT(u.last_login) + '</td>' +
          '<td class="um-c-date">' + fmtD(u.created_at) + '<div class="um-sub">' + ago(u.created_at) + '</div></td>' +
          '<td class="um-c-act">' + act + '</td>' +
        '</tr>';
      }).join("");

      tbody.querySelectorAll(".um-roletoggle:not(.locked) .um-rt-btn").forEach((btn) => {
        btn.addEventListener("click", () => this._setRole(btn.closest(".um-roletoggle").dataset.email, btn.dataset.role));
      });
      tbody.querySelectorAll(".um-approve").forEach((b) => b.addEventListener("click", () => this._approve(b.dataset.id, b.dataset.email)));
      tbody.querySelectorAll(".um-reject").forEach((b) => b.addEventListener("click", () => this._reject(b.dataset.id)));
      tbody.querySelectorAll(".um-del").forEach((b) => b.addEventListener("click", () => this._delMember(b.dataset.email)));
      tbody.querySelectorAll(".um-ck-row").forEach((cb) => cb.addEventListener("change", () => {
        if (cb.checked) this._selected.add(cb.dataset.email); else this._selected.delete(cb.dataset.email);
        const tr = cb.closest("tr"); if (tr) tr.classList.toggle("um-r-sel", cb.checked);
        this._renderBulk(); this._syncSelectAll(rows, prot);
      }));

      this._syncSelectAll(rows, prot);
      this._renderPager(pages, total);
      this._renderBulk();
    },

    _syncSelectAll(rows, prot) {
      const all = document.getElementById("um-all");
      if (!all) return;
      const selectable = rows.filter((u) => !prot.has(u.email));
      const selCount = selectable.filter((u) => this._selected.has(u.email)).length;
      all.checked = selectable.length > 0 && selCount === selectable.length;
      all.indeterminate = selCount > 0 && selCount < selectable.length;
    },
    _toggleAllVisible(on) {
      const prot = this._protected();
      const all = this._visible();
      const start = (this._page - 1) * this._pageSize;
      const rows = all.slice(start, start + this._pageSize);
      rows.forEach((u) => { if (prot.has(u.email)) return; if (on) this._selected.add(u.email); else this._selected.delete(u.email); });
      this.render();
    },
    _renderBulk() {
      const bar = document.getElementById("um-bulkbar");
      if (!bar) return;
      const n = this._selected.size;
      bar.classList.toggle("hidden", n === 0);
      const c = document.getElementById("um-sel-count");
      if (c) c.textContent = n;
    },

    _renderPager(pages, total) {
      const el = document.getElementById("um-pager");
      if (!el) return;
      el.innerHTML =
        '<span class="um-total">총 ' + total + '명</span>' +
        '<button class="um-pg" data-pg="first"' + (this._page <= 1 ? ' disabled' : '') + '>«</button>' +
        '<button class="um-pg" data-pg="prev"' + (this._page <= 1 ? ' disabled' : '') + '>‹</button>' +
        '<span class="um-pgnum">' + this._page + ' / ' + pages + '</span>' +
        '<button class="um-pg" data-pg="next"' + (this._page >= pages ? ' disabled' : '') + '>›</button>' +
        '<button class="um-pg" data-pg="last"' + (this._page >= pages ? ' disabled' : '') + '>»</button>';
      el.querySelectorAll(".um-pg").forEach((b) => b.addEventListener("click", () => {
        const v = b.dataset.pg;
        if (v === "first") this._page = 1;
        else if (v === "prev" && this._page > 1) this._page--;
        else if (v === "next" && this._page < pages) this._page++;
        else if (v === "last") this._page = pages;
        this.render();
      }));
    },

    /* ── 단건 변경 ── */
    async _setRole(email, role) {
      if (this._busy) return; this._busy = true;
      try {
        if (role === "designer") await fetch("/api/designers", { method: "POST", headers: Auth.headers(), body: JSON.stringify({ email }) });
        else await fetch("/api/designers/" + encodeURIComponent(email), { method: "DELETE", headers: Auth.headers() });
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast(email + " → " + (role === "designer" ? "디자이너" : "뷰어"));
      } catch (e) { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("권한 변경 실패"); }
      finally { this._busy = false; await this.load(); }
    },
    async _approve(id, email) {
      if (this._busy) return; this._busy = true;
      try { await fetch("/api/access-requests/" + encodeURIComponent(id) + "/approve", { method: "POST", headers: Auth.headers() });
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast((email || "신청자") + " 승인"); }
      catch (e) {} finally { this._busy = false; await this.load(); }
    },
    async _reject(id) {
      if (this._busy) return; this._busy = true;
      try { await fetch("/api/access-requests/" + encodeURIComponent(id) + "/reject", { method: "POST", headers: Auth.headers() }); }
      catch (e) {} finally { this._busy = false; await this.load(); }
    },
    async _delMember(email) {
      if (!await Prompt.confirm("가입 취소", email + " 사용자의 가입을 취소(삭제)하시겠습니까?")) return;
      if (this._busy) return; this._busy = true;
      try { await fetch("/api/local-users/" + encodeURIComponent(email), { method: "DELETE", headers: Auth.headers() }); }
      catch (e) {} finally { this._busy = false; await this.load(); }
    },

    /* ── 일괄 작업 ── */
    async _bulkRole(role) {
      const emails = Array.from(this._selected);
      if (!emails.length) return;
      if (!await Prompt.confirm("역할 일괄 지정", "선택한 " + emails.length + "명을 " + (role === "designer" ? "디자이너" : "뷰어") + "로 지정할까요?")) return;
      this._busy = true;
      try {
        for (const email of emails) {
          if (role === "designer") await fetch("/api/designers", { method: "POST", headers: Auth.headers(), body: JSON.stringify({ email }) });
          else await fetch("/api/designers/" + encodeURIComponent(email), { method: "DELETE", headers: Auth.headers() });
        }
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast(emails.length + "명 → " + (role === "designer" ? "디자이너" : "뷰어"));
      } catch (e) {} finally { this._busy = false; this._selected.clear(); await this.load(); }
    },
    async _bulkDelete() {
      const emails = Array.from(this._selected);
      if (!emails.length) return;
      if (!await Prompt.confirm("가입 일괄 취소", "선택한 " + emails.length + "명의 가입을 취소(삭제)할까요? (가입 사용자만 삭제됩니다)")) return;
      this._busy = true;
      try { for (const email of emails) await fetch("/api/local-users/" + encodeURIComponent(email), { method: "DELETE", headers: Auth.headers() }); }
      catch (e) {} finally { this._busy = false; this._selected.clear(); await this.load(); }
    },

    async _quickAdd() {
      const inp = document.getElementById("um-add-input");
      const err = document.getElementById("um-add-error");
      if (err) err.classList.add("hidden");
      const email = (inp.value || "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { if (err) { err.textContent = "올바른 이메일을 입력하세요."; err.classList.remove("hidden"); } return; }
      try {
        const r = await fetch("/api/designers", { method: "POST", headers: Auth.headers(), body: JSON.stringify({ email }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { if (err) { err.textContent = j.error || "추가 실패"; err.classList.remove("hidden"); } return; }
        inp.value = "";
        await this.load();
      } catch (e) { if (err) { err.textContent = "네트워크 오류"; err.classList.remove("hidden"); } }
    },
  };

  const PdfAnno = {
    _drawing: false,
    _start: null,
    _cur: null,
    _NS: "http://www.w3.org/2000/svg",
    init() {
      const svg = document.getElementById("anno-svg");
      if (!svg) return;
      const tools = ["cursor", "highlight", "rect", "pen", "text"];
      tools.forEach(t => {
        const btn = document.getElementById("tb-anno-" + (t === "highlight" ? "hl" : t));
        if (btn) btn.addEventListener("click", () => this.setTool(t));
      });
      const colorEl = document.getElementById("tb-anno-color");
      if (colorEl) colorEl.addEventListener("input", e => { State.annoColor = e.target.value; });
      const undo = document.getElementById("tb-anno-undo");
      if (undo) undo.addEventListener("click", () => this.undo());
      const clr = document.getElementById("tb-anno-clear");
      if (clr) clr.addEventListener("click", () => this.clearPage());
      svg.addEventListener("pointerdown", e => this._onDown(e));
      window.addEventListener("pointermove", e => this._onMove(e));
      window.addEventListener("pointerup", () => this._onUp());
    },
    setTool(tool) {
      State.annoTool = tool;
      document.querySelectorAll(".tb-anno[data-tool]").forEach(b => {
        b.classList.toggle("active", b.getAttribute("data-tool") === tool);
      });
      const svg = document.getElementById("anno-svg");
      if (svg) {
        svg.style.pointerEvents = (tool === "cursor") ? "none" : "auto";
        svg.style.cursor = (tool === "cursor") ? "default" : (tool === "text" ? "text" : "crosshair");
      }
    },
    updateToolbar() {
      const grp = document.getElementById("tb-anno-group");
      if (!grp) return;
      const show = (State.mode === "designer");
      grp.classList.toggle("hidden", !show);
      if (!show) this.setTool("cursor");
    },
    _pt(e) {
      const svg = document.getElementById("anno-svg");
      const r = svg.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return {
        x: Math.max(0, Math.min(1000, ((e.clientX - r.left) / r.width) * 1000)),
        y: Math.max(0, Math.min(1000, ((e.clientY - r.top) / r.height) * 1000))
      };
    },
    _onDown(e) {
      if (State.mode !== "designer") return;
      const tool = State.annoTool;
      if (tool === "cursor") return;
      const p = this._pt(e);
      if (!p) return;
      e.preventDefault(); e.stopPropagation();
      if (tool === "text") { this._addText(p); return; }
      this._drawing = true;
      this._start = p;
      const id = "an-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      if (tool === "pen") {
        this._cur = { id, page: State.pdfPage, type: "pen", color: State.annoColor, pts: [p] };
      } else if (tool === "highlight") {
        this._cur = { id, page: State.pdfPage, type: "highlight", color: State.annoColor, x: p.x, y: p.y, w: 0, h: 0 };
      } else {
        this._cur = { id, page: State.pdfPage, type: "rect", color: State.annoColor, x: p.x, y: p.y, w: 0, h: 0 };
      }
    },
    _onMove(e) {
      if (!this._drawing || !this._cur) return;
      const p = this._pt(e);
      if (!p) return;
      if (this._cur.type === "pen") {
        this._cur.pts.push(p);
      } else {
        this._cur.x = Math.min(this._start.x, p.x);
        this._cur.y = Math.min(this._start.y, p.y);
        this._cur.w = Math.abs(p.x - this._start.x);
        this._cur.h = Math.abs(p.y - this._start.y);
      }
      this._renderLive();
    },
    _onUp() {
      if (!this._drawing || !this._cur) { this._drawing = false; return; }
      this._drawing = false;
      const c = this._cur; this._cur = null;
      if ((c.type === "rect" || c.type === "highlight") && (c.w < 6 || c.h < 6)) { this._render(); return; }
      if (c.type === "pen" && c.pts.length < 2) { this._render(); return; }
      State.annotations.push(c);
      this._render();
      this._persist();
    },
    _addText(p) {
      const txt = (typeof prompt === "function") ? prompt("메모 내용을 입력하세요") : "";
      if (!txt) return;
      const id = "an-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      State.annotations.push({ id, page: State.pdfPage, type: "text", color: State.annoColor, x: p.x, y: p.y, text: txt });
      this._render();
      this._persist();
    },
    undo() {
      for (let i = State.annotations.length - 1; i >= 0; i--) {
        if ((State.annotations[i].page || 1) === State.pdfPage) {
          State.annotations.splice(i, 1);
          this._render(); this._persist(); return;
        }
      }
    },
    async clearPage() {
      if (!State.annotations.some(a => (a.page || 1) === State.pdfPage)) return;
      if (!await Prompt.confirm("주석 전체 삭제", "현재 페이지의 모든 주석을 삭제할까요?")) return;
      State.annotations = State.annotations.filter(a => (a.page || 1) !== State.pdfPage);
      this._render(); this._persist();
    },
    _renderLive() {
      this._render();
      if (!this._cur) return;
      const svg = document.getElementById("anno-svg");
      if (svg) svg.appendChild(this._buildShape(this._cur));
    },
    _buildShape(a) {
      const NS = this._NS;
      if (a.type === "pen") {
        const pl = document.createElementNS(NS, "polyline");
        pl.setAttribute("points", a.pts.map(p => p.x + "," + p.y).join(" "));
        pl.setAttribute("fill", "none");
        pl.setAttribute("stroke", a.color);
        pl.setAttribute("stroke-width", "3");
        pl.setAttribute("stroke-linecap", "round");
        pl.setAttribute("stroke-linejoin", "round");
        pl.setAttribute("vector-effect", "non-scaling-stroke");
        pl.dataset.aid = a.id;
        return pl;
      }
      const rect = document.createElementNS(NS, "rect");
      rect.setAttribute("x", a.x); rect.setAttribute("y", a.y);
      rect.setAttribute("width", a.w); rect.setAttribute("height", a.h);
      rect.dataset.aid = a.id;
      if (a.type === "highlight") {
        rect.setAttribute("fill", a.color);
        rect.setAttribute("fill-opacity", "0.28");
        rect.setAttribute("stroke", "none");
      } else {
        rect.setAttribute("fill", "none");
        rect.setAttribute("stroke", a.color);
        rect.setAttribute("stroke-width", "2.5");
        rect.setAttribute("vector-effect", "non-scaling-stroke");
      }
      return rect;
    },
    _render() {
      const svg = document.getElementById("anno-svg");
      const tl = document.getElementById("anno-text-layer");
      if (!svg || !tl) return;
      svg.innerHTML = "";
      tl.innerHTML = "";
      const page = State.pdfPage;
      State.annotations.forEach(a => {
        if ((a.page || 1) !== page) return;
        if (a.type === "text") {
          const box = document.createElement("div");
          box.className = "anno-text-box";
          box.style.left = (a.x / 10) + "%";
          box.style.top = (a.y / 10) + "%";
          box.style.borderColor = a.color;
          box.dataset.aid = a.id;
          box.innerHTML = `<span class="anno-text-content">${(a.text || "").replace(/</g, "&lt;")}</span>`;
          if (State.mode === "designer") {
            const del = document.createElement("button");
            del.className = "anno-text-del";
            del.textContent = "✕";
            del.title = "메모 삭제";
            del.addEventListener("click", ev => { ev.stopPropagation(); this._removeById(a.id); });
            box.appendChild(del);
            box.style.pointerEvents = "auto";
          }
          tl.appendChild(box);
        } else {
          svg.appendChild(this._buildShape(a));
        }
      });
    },
    _removeById(id) {
      State.annotations = State.annotations.filter(a => a.id !== id);
      this._render(); this._persist();
    },
    refresh() { this._render(); this.updateToolbar(); },
    _persist() {
      if (State.mode !== "designer") return;
      // [오프라인 작업지시서 ] 오프라인이면 현재 주석들을 id 단위 upsert op 로 기록 + 로컬 스냅샷
      if (!navigator.onLine && typeof OpLog !== "undefined") {
        try {
          const arr = (State.annotations || []).filter(a => a && a.id != null);
          (async () => {
            for (const a of arr) await OpLog.recordCurrent("anno", "upsert", a.id, a);
            await persistLocalDeployment();
          })().catch(() => {});
        } catch (e) {}
      }
      try { if (typeof App !== "undefined" && App._autoSave) App._autoSave({}); } catch (e) {}
    }
  };

  /* ══════════════════════════════════════════
     PIN ACTION POP — 핀 작업 전용 팝업
     (디자이너가 핀 클릭 → 이동/수정·사진추가/삭제/360°보기)
  ══════════════════════════════════════════ */
  /** 사진 URL 로 허용하는 확장자(이미지·영상) — pap-photo-url 검증의 유일한 기준(SoT). */
  const PAP_URL_RE = /^https?:\/\/.+\.(jpe?g|png|gif|webp|bmp|mp4|webm|mov)(\?.*)?$/i;
  const PAP_VIDEO_RE = /\.(mp4|webm|mov)(\?.*)?$/i;

  /** [WO 20260921] 🔴 등록 종류(B#pf-tools 흡수) — SoT. 라벨/순서가 여기 하나뿐이면
   *  중복 배치가 물리적으로 불가능하다(렌더 지점이 한 곳: _renderRegTools). */
  const PAP_REG_CATS = [
    { id: "photo", label: "사진" },
    { id: "theta", label: "360" },
    { id: "doc",   label: "문서" },
    { id: "note",  label: "노트" },
    { id: "video", label: "동영상" },
    { id: "url",   label: "URL" }
  ];
  /** 모바일 기준(720px) — style.css 전역과 동일 값(2720/2769 등). CSS 는 타 팀 점유라
   *  JS 로 직접 판정한다(인라인 스타일 방식은 이 파일 상단 주석과 동일 이유). */
  const PAP_MOBILE_MQ = "(max-width: 720px)";

  const PinActionPop = {
    _pinId: null,
    _layoutDone: false,

    /** [마스터 2026-09-17] 패널 = 화면 오른쪽 고정, 상(정보)/하(사진) 2분할.
     *  style.css 는 타 에이전트 점유 중이라 신규 클래스를 만들지 않고 인라인 스타일로 배치한다.
     *  ISO 전환 코드는 여기 없다(핀 클릭 시 ISO 를 켜지 않는다 — 마스터 명시). */
    _applyLayoutOnce() {
      if (this._layoutDone) return;
      this._layoutDone = true;
      const pop = document.getElementById("pin-action-pop");
      const card = document.getElementById("pap-card");
      if (pop) { pop.style.display = "flex"; pop.style.alignItems = "stretch"; pop.style.justifyContent = "flex-end"; }
      if (card) {
        card.style.cssText += "width:380px;max-width:92vw;height:100vh;max-height:100vh;" +
          "border-radius:0;display:flex;flex-direction:column;margin:0;";
      }
    },

    init() {
      const $ = (id) => document.getElementById(id);
      const el = $("pin-action-pop");
      if (!el) return;
      this._applyLayoutOnce();
      $("pap-close") && $("pap-close").addEventListener("click", () => this.close());
      const bd = el.querySelector(".pin-action-backdrop");
      bd && bd.addEventListener("click", () => this.close());
      $("pap-view") && $("pap-view").addEventListener("click", () => {
        const pin = this._pin(); if (!pin) return;
        this.close();
        if (App.pinHasContent(pin)) App.openPano(pin);
        else { App.focusPin(pin, false); if (typeof Inspector !== "undefined") Inspector.showPin(pin); }
      });
      $("pap-move") && $("pap-move").addEventListener("click", () => {
        const pin = this._pin(); if (!pin) return;
        State.pinEditUnlocked = pin.id;
        this.close();
        UI.renderPinsOnMap();
        const m = document.querySelector('.pin-marker[data-id="' + pin.id + '"]');
        if (m) m.classList.add("edit-unlocked");
        Prompt.toast && Prompt.toast("'" + (pin.label || ("#" + (pin.page||1))) + "' 이동 잠금 해제 — 도면에서 핀을 드래그하세요");
      });
      // [WO 20260921] 🔴 이중 편집창 제거 — B(#section-pin-form) 를 더 이상 열지 않는다.
      //   A 안에서 이미 위치명·사진·문서·노트를 전부 편집할 수 있으므로, 라벨 입력에
      //   포커스만 이동시켜 "여기서 바로 수정하라"는 신호만 준다(새 창 0).
      $("pap-edit") && $("pap-edit").addEventListener("click", () => {
        const pin = this._pin(); if (!pin) return;
        const input = $("pap-label-input");
        if (input && !input.readOnly) { input.focus(); input.select(); }
        Prompt.toast && Prompt.toast("아래에서 위치명·사진·노트를 바로 수정하세요");
      });
      $("pap-del") && $("pap-del").addEventListener("click", async () => {
        const pin = this._pin(); if (!pin) return;
        if (await App.deletePin(pin.id)) this.close();
      });
      // ── 등록정보(위치명) / 번호 수정 — 저장은 명시 버튼(자동저장 OFF, 미저장 표시만) ──
      $("pap-label-save") && $("pap-label-save").addEventListener("click", () => this._saveLabel());
      // ── 사진 미리보기 클릭 → 전체화면(기존 파노 뷰어 경로 재사용) ──
      $("pap-photo-img") && $("pap-photo-img").addEventListener("click", () => {
        const pin = this._pin(); if (!pin) return;
        this.close();
        App.openPano(pin);
      });
      // ── 사진 등록: 파일 선택 ──
      $("pap-photo-file") && $("pap-photo-file").addEventListener("change", (e) => {
        const file = e.target.files && e.target.files[0];
        this._registerPhotoFile(file);
      });
      // ── 사진 등록: 경로(URL) 직접 입력 — 검증 없이 저장 금지 ──
      $("pap-photo-url-add") && $("pap-photo-url-add").addEventListener("click", () => this._registerPhotoUrl());
      // ── 노트(이슈) 등록 — 13_Notes.js 재사용(같은 /api/notes) ──
      $("pap-notes-submit") && $("pap-notes-submit").addEventListener("click", () => this._submitNote());
      // ── [WO 20260921] 등록 종류 선택(위임 바인딩, 중복 방지) ──
      const regGrid = $("pap-reg-tools");
      if (regGrid && !regGrid._papBound) {
        regGrid.addEventListener("click", (e) => {
          const btn = e.target.closest(".pap-reg-btn");
          if (!btn || btn.classList.contains("hidden")) return;
          this._selectRegCategory(btn.dataset.reg);
        });
        regGrid._papBound = true;
      }
      // ── 문서 등록: 파일 선택(다중) ──
      $("pap-doc-file") && $("pap-doc-file").addEventListener("change", (e) => {
        const files = Array.from(e.target.files || []);
        e.target.value = "";
        files.forEach((f) => this._registerDocFile(f));
      });
      // 화면 폭이 바뀌어도(모바일↔데스크톱 회전 등) 등록 종류 노출 상태를 다시 계산한다.
      if (typeof window !== "undefined" && window.addEventListener) {
        window.addEventListener("resize", () => { if (!el.classList.contains("hidden")) this._applyRegVisibility(); });
      }
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !el.classList.contains("hidden")) this.close();
      });
    },

    /** [WO 20260921] 등록 종류 그리드 렌더 — 렌더 지점이 여기 하나뿐(중복 배치 물리적으로 불가). */
    _renderRegTools() {
      const grid = document.getElementById("pap-reg-tools");
      if (!grid) return;
      const cur = this._regCat || "photo";
      grid.innerHTML = PAP_REG_CATS.map((c) => {
        const active = c.id === cur;
        const style = "padding:6px 10px;border-radius:8px;font-size:12px;cursor:pointer;border:1px solid " +
          (active ? "#0f172a;background:#0f172a;color:#fff;" : "rgba(0,0,0,.14);background:#f8fafc;color:#334155;");
        return `<button type="button" class="pap-reg-btn" data-reg="${c.id}" aria-pressed="${active}" style="${style}">${c.label}</button>`;
      }).join("");
      this._applyRegVisibility();
      this._selectRegCategory(cur); // 버튼 active 색상 + 문서박스 표시/숨김 상태를 한 곳(SoT)에서 동기화
    },

    /** querySelectorAll 미지원 환경(테스트 fake DOM 등)에서도 안전하게 빈 배열을 준다. */
    _regBtns(grid) {
      return (grid && typeof grid.querySelectorAll === "function") ? Array.from(grid.querySelectorAll(".pap-reg-btn")) : [];
    },

    /** 모바일(≤720px)에서는 '사진'만 노출 — 마스터 기존 지시(B#pf-tools 와 동일 규칙, CSS 미의존). */
    _applyRegVisibility() {
      const grid = document.getElementById("pap-reg-tools");
      if (!grid) return;
      const mobile = !!(window.matchMedia && window.matchMedia(PAP_MOBILE_MQ).matches);
      this._regBtns(grid).forEach((btn) => {
        btn.classList.toggle("hidden", mobile && btn.dataset.reg !== "photo");
      });
      const hint = document.getElementById("pap-reg-mobile-hint");
      if (hint) hint.classList.toggle("hidden", !mobile);
    },

    /** 등록 종류 선택 — 사진/URL/360 은 기존 단일 위젯 재사용(중복 위젯 생성 금지),
     *  노트는 이미 상단에 있는 위젯으로 포커스만 이동, 문서만 신규 위젯 표시. */
    _selectRegCategory(cat) {
      this._regCat = cat;
      const grid = document.getElementById("pap-reg-tools");
      this._regBtns(grid).forEach((b) => {
        const active = b.dataset.reg === cat;
        b.setAttribute("aria-pressed", String(active));
        b.style.background = active ? "#0f172a" : "#f8fafc";
        b.style.color = active ? "#fff" : "#334155";
        b.style.borderColor = active ? "#0f172a" : "rgba(0,0,0,.14)";
      });
      const $ = (id) => document.getElementById(id);
      const title = $("pap-reg-title");
      const docBox = $("pap-doc-register");
      if (docBox) docBox.classList.toggle("hidden", cat !== "doc");
      if (title) title.textContent = (cat === "doc") ? "문서" : "사진";
      if (cat === "note") {
        const top = $("pap-top"); if (top) top.scrollTop = 0;
        const noteInput = $("pap-notes-input"); if (noteInput) noteInput.focus();
        return;
      }
      if (cat === "theta" && Prompt.toast) Prompt.toast("RICOH THETA 360 사진도 '사진'과 동일하게 등록됩니다(파일 선택 또는 경로)");
      if (cat === "video" && Prompt.toast) Prompt.toast("동영상은 경로(URL, .mp4/.webm/.mov)로 등록하세요");
      if (cat === "url" || cat === "video") { const u = $("pap-photo-url"); if (u) u.focus(); }
    },
    _pin() { return (State.pins || []).find(p => p.id === this._pinId) || null; },

    /** 편집 권한(번호 수정·사진 등록·노트 작성) = 디자이너만. 뷰어는 보기 전용. */
    _canEdit() {
      if (typeof Auth !== "undefined" && Auth && typeof Auth.isDesigner !== "undefined") return !!Auth.isDesigner;
      return (typeof State !== "undefined" && State.mode === "designer");
    },

    open(pinId) {
      const el = document.getElementById("pin-action-pop");
      if (!el) return;
      const pin = (State.pins || []).find(p => p.id === pinId);
      if (!pin) return;
      this._pinId = pinId;
      this._applyLayoutOnce();
      // 페이지 기준 번호 계산
      const page = pin.page || 1;
      const samePage = (State.pins || []).filter(p => (p.page || 1) === page);
      const no = samePage.indexOf(pin) + 1;
      const hasContent = App.pinHasContent(pin);
      const $ = (id) => document.getElementById(id);
      $("pap-no").textContent = "#" + (no > 0 ? no : "?");
      $("pap-title").textContent = pin.label && pin.label.trim() ? pin.label : ("포인트 " + no);
      const mediaTxt = hasContent ? "360° 미디어 있음" : "미디어 없음";
      const addrTxt = (pin.label && pin.label.trim()) ? pin.label : "위치명 없음";
      // 🔴 [2026-09-21 WO] 도면 마커 위성 배지 3종(이슈·중복·작성자) 제거 — 여기(단일 편집창)로 이관.
      //   정본은 그대로 재사용(Notes.openCountFor / PinSeries.duplicateCheckboardIds / PinSeries.userMark) —
      //   숫자를 여기서 다시 세지 않는다(§10 SoT).
      const esc = (typeof UI !== "undefined" && UI.escapeHtml) ? UI.escapeHtml : (s) => String(s);
      let metaHtml = esc(addrTxt) + " · " + mediaTxt + " · " + page + "페이지";
      const openIssues = (typeof Notes !== "undefined" && Notes.openCountFor) ? Notes.openCountFor(pin.id) : 0;
      if (openIssues > 0) {
        metaHtml += ` <span class="pin-issue-badge" title="미해결 이슈 ${openIssues}건">${openIssues}</span>`;
      }
      const isDup = (typeof PinSeries !== "undefined" && PinSeries.duplicateCheckboardIds)
        ? PinSeries.duplicateCheckboardIds(State.pins, page).has(pin.id) : false;
      if (isDup) {
        metaHtml += ' <span class="pin-dup-badge" title="번호 중복 — 현장 확인 후 직접 수정하세요">중복</span>';
      }
      const userMark = (typeof PinSeries !== "undefined" && PinSeries.userMark) ? PinSeries.userMark(pin, no) : null;
      if (userMark) {
        const bandTxt = userMark.band != null
          ? ("번호 대역 " + (userMark.band * 100 + 1) + "~" + (userMark.band * 100 + 100))
          : ("작성자: " + esc(userMark.author || ""));
        metaHtml += ` <span style="color:${userMark.color};font-weight:700">● ${esc(bandTxt)}</span>`;
      }
      $("pap-meta").innerHTML = metaHtml;
      // 360° 보기 버튼은 미디어 있을 때 강조
      const viewBtn = $("pap-view");
      if (viewBtn) viewBtn.classList.toggle("dim", !hasContent);

      const canEdit = this._canEdit();

      // ── 등록정보/번호(위치명) — 뷰어는 읽기전용 ──
      const labelInput = $("pap-label-input");
      if (labelInput) {
        labelInput.value = pin.label || "";
        labelInput.readOnly = !canEdit;
      }
      const labelSaveBtn = $("pap-label-save");
      if (labelSaveBtn) labelSaveBtn.classList.toggle("hidden", !canEdit);
      const labelHint = $("pap-label-hint");
      if (labelHint) labelHint.textContent = "";

      this._renderPhoto(pin, canEdit);
      this._loadNotes(pin, canEdit);
      // [WO 20260921] 등록 종류 그리드 — 열 때마다 '사진'으로 초기화(이전 핀의 선택 상태 유지 금지)
      this._regCat = "photo";
      this._renderRegTools();
      this._renderDocList(pin);

      el.classList.remove("hidden");
    },
    close() {
      const el = document.getElementById("pin-action-pop");
      if (el) el.classList.add("hidden");
      this._pinId = null;
    },

    /** ── 등록정보/번호 저장 — 자동저장 OFF: pin.label 만 갱신하고 미저장 표시만 남긴다 ──
     *  [WO 20260918] 🔴 체크보드 핀은 label 이 곧 번호(유일해야 함) — 이미 쓰는 번호로
     *  바꾸려 하면 조용히 삼키지 않고 거부한다(01b_PinSeries.js validateCheckboardLabel 정본).
     *  콘텐츠/빈 핀은 label 이 자유 텍스트라 이 검증을 적용하지 않는다(기존 동작 불변). */
    _saveLabel() {
      const pin = this._pin(); if (!pin) return;
      if (!this._canEdit()) return;
      const $ = (id) => document.getElementById(id);
      const v = ($("pap-label-input") && $("pap-label-input").value || "").trim();
      if (pin.checkboard && typeof PinSeries !== "undefined" && PinSeries.validateCheckboardLabel) {
        const check = PinSeries.validateCheckboardLabel(State.pins, pin.page || 1, pin.id, v);
        if (!check.ok) {
          const hintEl = $("pap-label-hint");
          if (hintEl) hintEl.textContent = check.reason;
          Prompt.toast && Prompt.toast(check.reason);
          return; // 저장하지 않는다 — 조용한 실패 금지(이유를 보여주고 중단)
        }
      }
      pin.label = v;
      if (typeof App !== "undefined" && App._markDirty) App._markDirty();
      if (!navigator.onLine && typeof OpLog !== "undefined" && OpLog.recordCurrent) { try { OpLog.recordCurrent("pin", "upsert", pin.id, pin); } catch (e) {} }
      if (typeof UI !== "undefined") { UI.renderPinsOnMap && UI.renderPinsOnMap(); UI.renderPinList && UI.renderPinList(); }
      // 화면 갱신(번호/제목/메타 재계산) — 페이지 재조회 없이 open()의 표시 로직만 재사용
      const page = pin.page || 1;
      const samePage = (State.pins || []).filter(p => (p.page || 1) === page);
      const no = samePage.indexOf(pin) + 1;
      $("pap-title").textContent = pin.label && pin.label.trim() ? pin.label : ("포인트 " + no);
      const hint = $("pap-label-hint");
      if (hint) hint.textContent = "미저장 변경 — '저장하기'(포인트 편집 패널) 또는 자동저장 이벤트 발생 시 서버에 반영됩니다.";
      Prompt.toast && Prompt.toast("위치명/번호 반영됨 (미저장)");
    },

    /** ── 사진 섹션: 있으면 미리보기, 없으면 등록 UI(뷰어는 등록 UI 숨김) ── */
    _renderPhoto(pin, canEdit) {
      const $ = (id) => document.getElementById(id);
      const previewBox = $("pap-photo-preview");
      const registerBox = $("pap-photo-register");
      const img = $("pap-photo-img");
      const hasPhoto = (typeof App !== "undefined" && App.pinHasMedia) ? App.pinHasMedia(pin) : !!(pin && (pin.imageId || pin.imageUrl || pin.videoUrl || pin.pendingOpId || pin.localPreview));
      if (hasPhoto) {
        if (previewBox) previewBox.classList.remove("hidden");
        if (registerBox) registerBox.classList.add("hidden");
        this._resolvePhotoSrc(pin).then((src) => { if (img && src) img.src = src; });
      } else {
        if (previewBox) previewBox.classList.add("hidden");
        if (registerBox) registerBox.classList.toggle("hidden", !canEdit);
        const errEl = $("pap-photo-err"); if (errEl) errEl.classList.add("hidden");
        const statusEl = $("pap-photo-status"); if (statusEl) statusEl.textContent = "";
        const urlInput = $("pap-photo-url"); if (urlInput) urlInput.value = "";
        const fileInput = $("pap-photo-file"); if (fileInput) fileInput.value = "";
      }
    },

    /** 미리보기 이미지 소스 해석 — 21_AllPins.js._loadThumb 과 같은 캐시/조회 경로 재사용 */
    async _resolvePhotoSrc(pin) {
      try {
        if (pin.imageId) {
          if (typeof Cloud !== "undefined" && Cloud._cache && Cloud._cache[pin.imageId]) return Cloud._cache[pin.imageId];
          if (typeof Cloud !== "undefined" && Cloud.fetchImage) return await Cloud.fetchImage(pin.imageId);
        }
        if (pin.localPreview) return pin.localPreview;
        if (pin.imageUrl && !PAP_VIDEO_RE.test(pin.imageUrl)) return pin.imageUrl;
      } catch (e) { /* 썸네일 실패는 무시 — 등록 상태 자체는 이미 표시됨 */ }
      return null;
    },

    /** ── 사진 등록: 파일 선택 — 기존 저장 경로(Cloud.resizeImage/uploadImage, imageId/imageName) 재사용 ── */
    async _registerPhotoFile(file) {
      const pin = this._pin(); if (!pin || !this._canEdit()) return;
      const $ = (id) => document.getElementById(id);
      const errEl = $("pap-photo-err"), statusEl = $("pap-photo-status");
      if (errEl) errEl.classList.add("hidden");
      if (!file) { if (errEl) { errEl.textContent = "파일을 선택하세요."; errEl.classList.remove("hidden"); } return; }
      if (statusEl) statusEl.textContent = "업로드 중…";
      try {
        const { dataURL, width, height } = await Cloud.resizeImage(file);
        const imgName = (pin.label || ("pin_" + pin.id)).replace(/[^a-zA-Z0-9_\-가-힣]/g, "_");
        const imageId = await Cloud.uploadImage(imgName, dataURL, width, height);
        pin.imageId = imageId; pin.imageName = imgName;
        if (typeof Cloud !== "undefined") { Cloud._cache = Cloud._cache || {}; Cloud._cache[imageId] = dataURL; }
        if (typeof App !== "undefined" && App._markDirty) App._markDirty();
        if (typeof UI !== "undefined") { UI.renderPinsOnMap && UI.renderPinsOnMap(); UI.renderPinList && UI.renderPinList(); }
        if (statusEl) statusEl.textContent = "사진 등록됨 (미저장 — 저장 버튼으로 서버에 반영하세요)";
        this._renderPhoto(pin, true);
      } catch (e) {
        if (errEl) { errEl.textContent = "업로드 실패: " + (e.message || e); errEl.classList.remove("hidden"); }
        if (statusEl) statusEl.textContent = "";
      }
    },

    /** ── 사진 등록: 경로(URL) 직접 입력 — 빈 값·잘못된 형식은 거부하고 이유 표시 ── */
    _registerPhotoUrl() {
      const pin = this._pin(); if (!pin || !this._canEdit()) return;
      const $ = (id) => document.getElementById(id);
      const errEl = $("pap-photo-err"), statusEl = $("pap-photo-status");
      const raw = ($("pap-photo-url") && $("pap-photo-url").value || "").trim();
      if (errEl) errEl.classList.add("hidden");
      if (!raw) { if (errEl) { errEl.textContent = "경로를 입력하세요."; errEl.classList.remove("hidden"); } return; }
      let parsed;
      try { parsed = new URL(raw); } catch (e) { parsed = null; }
      if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
        if (errEl) { errEl.textContent = "올바른 URL 형식이 아닙니다(http:// 또는 https:// 로 시작해야 함)."; errEl.classList.remove("hidden"); }
        return;
      }
      if (!PAP_URL_RE.test(raw)) {
        if (errEl) { errEl.textContent = "지원하지 않는 형식입니다(.jpg/.png/.gif/.webp/.mp4/.webm/.mov 만 허용)."; errEl.classList.remove("hidden"); }
        return;
      }
      pin.imageUrl = raw;
      pin.isVideo = PAP_VIDEO_RE.test(raw);
      if (typeof App !== "undefined" && App._markDirty) App._markDirty();
      if (typeof UI !== "undefined") { UI.renderPinsOnMap && UI.renderPinsOnMap(); UI.renderPinList && UI.renderPinList(); }
      if (statusEl) statusEl.textContent = "경로 등록됨 (미저장 — 저장 버튼으로 서버에 반영하세요)";
      this._renderPhoto(pin, true);
    },

    /** ── [WO 20260921] 문서 등록 — Cloud.uploadDoc/fileToDataURL 재사용(20_App.js 수정 0),
     *  pin.attachments 에 직접 추가(20_App.js 의 기존 attachments 형태 {id,name,size,type/docId}와 동일 SoT). ── */
    async _registerDocFile(file) {
      const pin = this._pin(); if (!pin || !this._canEdit()) return;
      const $ = (id) => document.getElementById(id);
      const statusEl = $("pap-doc-status");
      if (!file) return;
      if (typeof Cloud !== "undefined" && Cloud.MAX_DOC_BYTES && file.size > Cloud.MAX_DOC_BYTES) {
        const mb = (Cloud.MAX_DOC_BYTES / 1024 / 1024).toFixed(0);
        if (statusEl) statusEl.textContent = "\"" + file.name + "\" 은 너무 큽니다(최대 " + mb + "MB).";
        return;
      }
      if (statusEl) statusEl.textContent = "업로드 중…";
      try {
        const dataURL = await Cloud.fileToDataURL(file);
        const docId = await Cloud.uploadDoc(file.name, dataURL);
        if (!Array.isArray(pin.attachments)) pin.attachments = [];
        pin.attachments.push({ id: "d" + Date.now() + Math.random().toString(36).slice(2, 6), name: file.name, size: file.size, docId });
        if (typeof App !== "undefined" && App._markDirty) App._markDirty();
        if (typeof UI !== "undefined") { UI.renderPinList && UI.renderPinList(); }
        this._renderDocList(pin);
        if (statusEl) statusEl.textContent = "문서 등록됨 (미저장 — 저장 버튼으로 서버에 반영하세요)";
      } catch (e) {
        if (statusEl) statusEl.textContent = "업로드 실패: " + (e.message || e);
      }
    },

    /** 문서 첨부 목록 표시(등록된 문서 없으면 안내문) — pin.attachments 를 그대로 읽는다(SoT 1개). */
    _renderDocList(pin) {
      const list = document.getElementById("pap-doc-list");
      if (!list) return;
      const atts = (pin && pin.attachments) || [];
      const esc = (typeof UI !== "undefined" && UI.escapeHtml) ? UI.escapeHtml : (s) => String(s);
      list.innerHTML = atts.length
        ? atts.map((a) => "<div>· " + esc(a.name || "문서") + "</div>").join("")
        : "<span style=\"color:#94a3b8\">등록된 문서가 없습니다.</span>";
    },

    /** ── 노트(이슈) — 13_Notes.js 데이터/엔드포인트 재사용 ── */
    async _loadNotes(pin, canEdit) {
      const $ = (id) => document.getElementById(id);
      const formRow = $("pap-notes-form-row");
      if (formRow) formRow.classList.toggle("hidden", !canEdit);
      if (typeof Notes === "undefined") return;
      Notes.setPin(pin);
      try { await Notes.loadForPin(); } catch (e) {}
      if (Notes.renderCompact) Notes.renderCompact("pap-notes-list");
    },
    async _submitNote() {
      const pin = this._pin(); if (!pin || !this._canEdit()) return;
      const $ = (id) => document.getElementById(id);
      const input = $("pap-notes-input");
      const body = (input && input.value || "").trim();
      if (!body || typeof Notes === "undefined" || !Notes.submitCompact) return;
      const ok = await Notes.submitCompact(pin, body);
      if (ok) {
        if (input) input.value = "";
        if (Notes.renderCompact) Notes.renderCompact("pap-notes-list");
        Prompt.toast && Prompt.toast("노트 등록됨");
      } else {
        Prompt.toast && Prompt.toast("노트 등록 실패(네트워크 확인)");
      }
    }
  };

  /* ══════════════════════════════════════════
     ADMIN PANELS — 최상위 관리자: 기능/메뉴 관장 · AI 설정 · 코드맵
  ══════════════════════════════════════════ */
  // 이 프로젝트에서 켜고 끌 수 있는 기능 정의(키 = app_settings.features 의 키)
  const FEATURE_DEFS = [
    { key: "annotations", label: "PDF 주석(형광펜·도형·메모)", desc: "도면 위 주석 도구 모음" },
    { key: "zones",       label: "영역/구역 지정",            desc: "사각형·원·다각형 구역 그리기" },
    { key: "pin360",      label: "360° 파노라마 핀",          desc: "핀 클릭 시 360 뷰어 열기" },
    { key: "fls3d",       label: "3D 포인트 클라우드(FLS)",   desc: "FLS/E57/LAS 첨부·듀얼뷰" },
    { key: "ai",          label: "AI 도우미",                 desc: "에러·사용 가이드 LLM(키 설정 시)" },
    { key: "timelapse",   label: "타임랩스 비교",             desc: "동일 위치 시점 비교" },
    { key: "export",      label: "내보내기/배포",             desc: "JSON 내보내기·뷰어 배포" }
  ];

  const AdminPanels = {
    _features: {},           // 현재 적용된 기능 토글 상태
    _featScope: "*",

    /** 앱 시작 시 한 번 호출: 현재 적용 기능을 불러와 본문에 반영 */
    async applyFeaturesToUI() {
      try {
        const r = await fetch("/api/app-settings?scope=*&key=features", { headers: Auth.headers() });
        if (!r.ok) return;
        const j = await r.json();
        this._features = j.value || {};
      } catch (e) { this._features = {}; }
      this._reflect();
    },
    /** 기능 키가 켜져 있는지(미설정=기본 ON) */
    isEnabled(key) {
      const v = this._features ? this._features[key] : undefined;
      return v === undefined ? true : !!v;
    },
    /** body 클래스로 기능 on/off 표시 → CSS가 해당 메뉴/버튼 숨김 */
    _reflect() {
      FEATURE_DEFS.forEach((f) => {
        document.body.classList.toggle("feat-off-" + f.key, !this.isEnabled(f.key));
      });
    },

    /* ── 기능·메뉴 관장 모달 ── */
    async openFeatures() {
      const m = document.getElementById("features-modal");
      if (!m) return;
      if (typeof Log !== "undefined") Log.push("settings.open", "features");
      await this._fillFeatScope();
      await this._loadFeatures();
      m.classList.remove("hidden"); requestAnimationFrame(() => m.classList.add("on"));
    },
    closeFeatures() { const m = document.getElementById("features-modal"); if (m) { m.classList.remove("on"); setTimeout(() => m.classList.add("hidden"), 180); } },
    async _fillFeatScope() {
      const sel = document.getElementById("feat-scope-select");
      if (!sel) return;
      const cur = sel.value || "*";
      let projects = [];
      try { const r = await fetch("/api/projects", { headers: Auth.headers() }); const j = await r.json(); projects = j.data || j.results || j || []; } catch (e) {}
      sel.innerHTML = '<option value="*">전체 공통(모든 프로젝트)</option>';
      (projects || []).forEach((p) => { const o = document.createElement("option"); o.value = p.id; o.textContent = p.name || p.id; sel.appendChild(o); });
      sel.value = cur;
      if (!sel._bound) { sel._bound = true; sel.addEventListener("change", () => { this._featScope = sel.value || "*"; this._loadFeatures(); }); }
      this._featScope = sel.value || "*";
    },
    async _loadFeatures() {
      const listEl = document.getElementById("features-list");
      if (!listEl) return;
      let cur = {};
      try { const r = await fetch("/api/app-settings?scope=" + encodeURIComponent(this._featScope) + "&key=features", { headers: Auth.headers() }); const j = await r.json(); cur = j.value || {}; } catch (e) {}
      listEl.innerHTML = "";
      FEATURE_DEFS.forEach((f) => {
        const on = cur[f.key] === undefined ? true : !!cur[f.key];
        const row = document.createElement("label");
        row.className = "feature-row";
        row.innerHTML = `<span class="feature-meta"><b>${f.label}</b><span>${f.desc}</span></span>
          <input type="checkbox" class="feature-toggle" data-key="${f.key}" ${on ? "checked" : ""} />`;
        listEl.appendChild(row);
      });
    },
    async saveFeatures() {
      const listEl = document.getElementById("features-list");
      const note = document.getElementById("features-save-note");
      const value = {};
      listEl.querySelectorAll(".feature-toggle").forEach((c) => { value[c.dataset.key] = c.checked; });
      try {
        const r = await fetch("/api/app-settings", { method: "PUT", headers: Auth.headers(), body: JSON.stringify({ scope: this._featScope, key: "features", value }) });
        if (!r.ok) throw new Error("fail");
        if (note) { note.textContent = "저장되었습니다. 화면에 즉시 반영됩니다."; note.className = "features-save-note ok"; }
        // 전체 공통 저장 시 현재 화면에도 즉시 반영
        if (this._featScope === "*") { this._features = value; this._reflect(); }
      } catch (e) { if (note) { note.textContent = "저장 실패(권한 필요)"; note.className = "features-save-note err"; } }
    },

    /* ── AI 설정 모달 ── */
    async openAI() {
      const m = document.getElementById("ai-modal");
      if (!m) return;
      const statusEl = document.getElementById("ai-status-line");
      try {
        const r = await fetch("/api/ai/config", { headers: Auth.headers() });
        const j = await r.json();
        if (statusEl) { statusEl.textContent = j.enabled ? "활성화됨 (API 키 설정됨)" : "비활성 — API 키(AI_API_KEY) 미설정"; statusEl.className = "ai-status-line " + (j.enabled ? "on" : "off"); }
        const bu = document.getElementById("ai-base-url"); if (bu) bu.value = j.base_url || "";
        const md = document.getElementById("ai-model"); if (md) md.value = j.model || "";
      } catch (e) { if (statusEl) statusEl.textContent = "상태를 불러올 수 없습니다."; }
      // 저장된 base_url/model(app_settings) 우선 표시
      try { const r2 = await fetch("/api/app-settings?scope=*&key=ai", { headers: Auth.headers() }); const j2 = await r2.json(); if (j2.value && j2.value.base_url) document.getElementById("ai-base-url").value = j2.value.base_url; if (j2.value && j2.value.model) document.getElementById("ai-model").value = j2.value.model; } catch (e) {}
      m.classList.remove("hidden"); requestAnimationFrame(() => m.classList.add("on"));
    },
    closeAI() { const m = document.getElementById("ai-modal"); if (m) { m.classList.remove("on"); setTimeout(() => m.classList.add("hidden"), 180); } },
    async saveAI() {
      const note = document.getElementById("ai-save-note");
      const value = { base_url: (document.getElementById("ai-base-url").value || "").trim(), model: (document.getElementById("ai-model").value || "").trim() };
      try {
        const r = await fetch("/api/app-settings", { method: "PUT", headers: Auth.headers(), body: JSON.stringify({ scope: "*", key: "ai", value }) });
        if (!r.ok) throw new Error("fail");
        if (note) { note.textContent = "Base URL·모델 저장됨. (키는 wrangler secret으로 별도 설정)"; note.className = "features-save-note ok"; }
      } catch (e) { if (note) { note.textContent = "저장 실패(권한 필요)"; note.className = "features-save-note err"; } }
    },
    async testAI() {
      const note = document.getElementById("ai-save-note");
      if (note) { note.textContent = "연결 테스트 중…"; note.className = "features-save-note"; }
      try {
        const r = await fetch("/api/ai/chat", { method: "POST", headers: Auth.headers(), body: JSON.stringify({ messages: [{ role: "user", content: "연결 테스트입니다. OK라고만 답해주세요." }], max_tokens: 16 }) });
        const j = await r.json();
        if (r.ok) { if (note) { note.textContent = "연결 성공: " + (j.content || "(응답)"); note.className = "features-save-note ok"; } }
        else { if (note) { note.textContent = "" + (j.error || "실패") + (j.hint ? " — " + j.hint : ""); note.className = "features-save-note err"; } }
      } catch (e) { if (note) { note.textContent = "네트워크 오류"; note.className = "features-save-note err"; } }
    },

    /* ── 코드 구조 · 파일 설명 대시보드 ── */
    openCodemap() {
      const m = document.getElementById("codemap-modal");
      if (!m) return;
      this._renderCodemap("");
      const s = document.getElementById("codemap-search");
      if (s && !s._bound) { s._bound = true; s.addEventListener("input", () => this._renderCodemap(s.value || "")); }
      m.classList.remove("hidden"); requestAnimationFrame(() => m.classList.add("on"));
    },
    closeCodemap() { const m = document.getElementById("codemap-modal"); if (m) { m.classList.remove("on"); setTimeout(() => m.classList.add("hidden"), 180); } },
    _renderCodemap(filter) {
      const el = document.getElementById("codemap-tree");
      if (!el) return;
      const f = (filter || "").toLowerCase();
      el.innerHTML = "";
      CODE_MAP.forEach((grp) => {
        const items = grp.items.filter((it) => !f || (it.path + " " + it.desc + " " + (it.detail || "")).toLowerCase().includes(f));
        if (!items.length) return;
        const g = document.createElement("div");
        g.className = "codemap-group";
        g.innerHTML = `<div class="codemap-group-h">${grp.group}</div>`;
        items.forEach((it) => {
          const row = document.createElement("div");
          row.className = "codemap-file";
          row.innerHTML = `<div class="codemap-file-h"><code>${it.path}</code><span class="codemap-badge">${it.kind}</span></div>
            <div class="codemap-file-desc">${it.desc}</div>${it.detail ? `<div class="codemap-file-detail">${it.detail}</div>` : ""}`;
          g.appendChild(row);
        });
        el.appendChild(g);
      });
      if (!el.children.length) el.innerHTML = '<div class="invites-empty">검색 결과가 없습니다.</div>';
    },

    /* ── Firebase 연결 모달 (내 Google 계정 자동 세팅) ── */
    openFirebase() {
      const m = document.getElementById("firebase-modal");
      if (!m) return;
      this._firebaseStatus();
      // 저장된 값 미리 채우기
      try {
        const cfg = (window.SeaFirebaseConfig && window.SeaFirebaseConfig.current()) || {};
        const paste = document.getElementById("fb-paste");
        if (paste && cfg.apiKey && !String(cfg.apiKey).startsWith("YOUR_")) {
          paste.value = JSON.stringify(cfg, null, 2);
        }
        const em = document.getElementById("fb-owner-email");
        if (em) em.value = window.FIREBASE_OWNER_EMAIL && !String(window.FIREBASE_OWNER_EMAIL).includes("designssir") ? window.FIREBASE_OWNER_EMAIL : (window.FIREBASE_OWNER_EMAIL || "");
      } catch (e) {}
      m.classList.remove("hidden"); requestAnimationFrame(() => m.classList.add("on"));
    },
    closeFirebase() { const m = document.getElementById("firebase-modal"); if (m) { m.classList.remove("on"); setTimeout(() => m.classList.add("hidden"), 180); } },
    _firebaseStatus() {
      const el = document.getElementById("firebase-status-line");
      if (!el) return;
      const on = !!(window.SeaFirebaseConfig && window.SeaFirebaseConfig.isEnabled());
      const ready = !!(window.SeaFirebase && window.SeaFirebase.ready);
      if (on) {
        const u = (window.SeaFirebase && window.SeaFirebase.currentUser && window.SeaFirebase.currentUser());
        el.textContent = ready
          ? (u ? "연결됨 · 로그인: " + (u.email || u.uid) : "연결됨 · (로그인 대기)")
          : "설정 저장됨 · 새로고침 후 완전 활성화";
        el.className = "ai-status-line on";
      } else {
        el.textContent = "미연결 — 아래에 firebaseConfig 를 붙여넣고 저장하세요.";
        el.className = "ai-status-line off";
      }
    },
    saveFirebase() {
      const note = document.getElementById("firebase-save-note");
      const setNote = (t, ok) => { if (note) { note.textContent = t; note.className = "features-save-note " + (ok ? "ok" : "err"); note.classList.remove("hidden"); } };
      const pasteEl = document.getElementById("fb-paste");
      const emailEl = document.getElementById("fb-owner-email");
      const raw = (pasteEl && pasteEl.value || "").trim();
      const email = (emailEl && emailEl.value || "").trim();
      if (!raw) { setNote("firebaseConfig 값을 붙여넣어 주세요.", false); return; }
      const cfg = window.SeaFirebaseConfig.parsePasted(raw);
      if (!cfg || !cfg.apiKey || !cfg.projectId) {
        setNote("형식을 인식하지 못했습니다. 콘솔의 firebaseConfig 객체 전체를 그대로 붙여넣어 주세요.", false);
        return;
      }
      window.SeaFirebaseConfig.save(cfg, email);
      setNote("저장 완료! 새로고침하면 Firebase가 자동 활성화됩니다. (3초 후 자동 새로고침)", true);
      this._firebaseStatus();
      setTimeout(() => { try { location.reload(); } catch (e) {} }, 3000);
    },
    async loginFirebase() {
      const note = document.getElementById("firebase-save-note");
      const setNote = (t, ok) => { if (note) { note.textContent = t; note.className = "features-save-note " + (ok ? "ok" : "err"); note.classList.remove("hidden"); } };
      if (!(window.SeaFirebase && window.SeaFirebase.ready)) {
        setNote("먼저 설정을 저장하고 새로고침한 뒤 다시 시도하세요.", false);
        return;
      }
      try {
        // 단순 테스트가 아니라 앱 전체 로그인으로 연결 (Auth.loginWithFirebase)
        if (typeof Auth !== "undefined" && Auth.loginWithFirebase) {
          const role = await Auth.loginWithFirebase();
          const who = (Auth.user && (Auth.user.name || Auth.user.email)) || "";
          setNote("로그인 완료: " + who + " · 권한=" + (role === "super" ? "슈퍼관리자" : role === "designer" ? "디자이너" : "뷰어"), true);
        } else {
          const u = await window.SeaFirebase.loginGoogle();
          setNote("Google 로그인 성공: " + (u.email || u.uid), true);
        }
        this._firebaseStatus();
      } catch (e) {
        setNote("로그인 실패: " + (e && e.message || e) + " — Firebase 콘솔에서 Google 공급업체를 켰는지, 승인된 도메인에 현재 주소가 있는지 확인하세요.", false);
      }
    },
    clearFirebase() {
      if (window.SeaFirebaseConfig) window.SeaFirebaseConfig.clear();
      const note = document.getElementById("firebase-save-note");
      if (note) { note.textContent = "연결 해제됨. 새로고침하면 D1 백엔드만 사용합니다. (3초 후 자동 새로고침)"; note.className = "features-save-note ok"; note.classList.remove("hidden"); }
      this._firebaseStatus();
      setTimeout(() => { try { location.reload(); } catch (e) {} }, 3000);
    },

    init() {
      const $ = (id) => document.getElementById(id);
      $("features-save") && $("features-save").addEventListener("click", () => this.saveFeatures());
      $("features-close") && $("features-close").addEventListener("click", () => this.closeFeatures());
      $("ai-save") && $("ai-save").addEventListener("click", () => this.saveAI());
      $("ai-test") && $("ai-test").addEventListener("click", () => this.testAI());
      $("ai-close") && $("ai-close").addEventListener("click", () => this.closeAI());
      $("codemap-close") && $("codemap-close").addEventListener("click", () => this.closeCodemap());
      // Firebase 연결 모달 (열기 버튼은 Settings에서 권한 게이트와 함께 바인딩)
      $("firebase-save") && $("firebase-save").addEventListener("click", () => this.saveFirebase());
      $("firebase-login") && $("firebase-login").addEventListener("click", () => this.loginFirebase());
      $("firebase-clear") && $("firebase-clear").addEventListener("click", () => this.clearFirebase());
      $("firebase-close") && $("firebase-close").addEventListener("click", () => this.closeFirebase());
      document.querySelectorAll('.admin-gate-backdrop[data-close]').forEach((bd) => {
        const which = bd.getAttribute("data-close");
        if (which === "features") bd.addEventListener("click", () => this.closeFeatures());
        if (which === "ai") bd.addEventListener("click", () => this.closeAI());
        if (which === "firebase") bd.addEventListener("click", () => this.closeFirebase());
        if (which === "codemap") bd.addEventListener("click", () => this.closeCodemap());
      });
    }
  };

  /* 코드 구조 설명 데이터 — 관리자 대시보드용(파일별 기능 설명) */
  const CODE_MAP = [
    { group: "서버 / API (Hono on Cloudflare Workers)", items: [
      { path: "src/index.tsx", kind: "서버", desc: "모든 백엔드 API·SSR 진입점. 인증·프로젝트·핀·배포·도메인·초대·설정·AI 라우트를 한 파일에 정의.", detail: "주요: /api/auth/me, /api/projects, /api/pins, /api/deploy, /api/signup/*, /api/allowed-domains, /api/invites, /api/app-settings, /api/ai/*" },
      { path: "src/renderer.tsx", kind: "서버", desc: "Hono JSX 렌더러(HTML 셸 구성)." }
    ]},
    { group: "클라이언트 (public/)", items: [
      { path: "public/index.html", kind: "마크업", desc: "앱 전체 화면 구조 — 상단바·사이드바·맵 뷰포트·각종 모달(로그인/가입/관리자/설정/기능/AI/코드맵)." },
      { path: "public/js/main.js", kind: "로직", desc: "클라이언트 전체 로직. 모듈 집합으로 구성.", detail: "App(부트), MapCtrl(줌·팬·핀치), PanoViewer(360), PDF(렌더), PdfAnno(주석), Zones(구역), Pins/PinGrid/PinActionPop(핀), Auth/CompanyAuth(인증·가입), Designers(권한·도메인·멤버·초대·로그), Settings/AdminPanels(설정·기능관장·AI·코드맵), SyncQueue(오프라인 큐)." },
      { path: "public/css/style.css", kind: "스타일", desc: "전체 디자인·반응형(모바일 바텀시트·하단네비)·주석/관리자 UI 스타일." }
    ]},
    { group: "PWA / 오프라인", items: [
      { path: "public/sw.js", kind: "서비스워커", desc: "앱 셸 캐시(stale-while-revalidate). /api/·/tables/ 는 절대 가로채지 않음 → 데이터는 항상 최신.", detail: "오프라인에서 화면 로딩 가능. PDF.js·Three.js CDN도 캐시." },
      { path: "public/manifest.webmanifest", kind: "PWA", desc: "홈 화면 설치용 매니페스트(이름·아이콘·표시 모드)." }
    ]},
    { group: "데이터 (Cloudflare D1 / R2)", items: [
      { path: "migrations/0001~0008_*.sql", kind: "DB", desc: "스키마 마이그레이션.", detail: "핀/배포(0001), 인증·프로젝트·구역(0002), 핀노트(0003), 구역(0004), 사용신청(0005), 활동로그(0006), 회사가입·도메인(0007), 초대·앱설정(0008)." }
    ]},
    { group: "빌드 / 운영", items: [
      { path: "vite.config.ts", kind: "빌드", desc: "Cloudflare Pages용 Vite 빌드 → dist/_worker.js 생성." },
      { path: "wrangler.jsonc", kind: "설정", desc: "CF Pages 설정(D1·R2 바인딩, nodejs_compat)." },
      { path: "ecosystem.config.cjs", kind: "운영", desc: "PM2 개발 서버(wrangler pages dev) 구동 설정." },
      { path: "CLAUDE.md / .claude/HANDOFF.md", kind: "문서", desc: "프로젝트 정체 카드 + 세션 인수인계(IRON RULE 포함)." }
    ]}
  ];

  /* ══════════════════════════════════════════
     COMPANY AUTH — 회사 이메일 자체가입 / 로그인
     (인증코드 → 비밀번호 → 로컬 세션 토큰)
  ══════════════════════════════════════════ */
  const CompanyAuth = {
    _email: null,
    init() {
      const $ = (id) => document.getElementById(id);
      const el = $("company-gate");
      if (!el) return;
      // 진입 버튼(로그인 게이트 안)
      $("login-gate-company") && $("login-gate-company").addEventListener("click", () => {
        const lg = $("login-gate"); if (lg) lg.classList.add("hidden");
        this.open();
      });
      $("company-gate-cancel") && $("company-gate-cancel").addEventListener("click", () => this.close());
      const bd = el.querySelector(".company-gate-backdrop");
      bd && bd.addEventListener("click", () => this.close());
      // 탭 전환
      $("company-tab-signup") && $("company-tab-signup").addEventListener("click", () => this._tab("signup"));
      $("company-tab-login") && $("company-tab-login").addEventListener("click", () => this._tab("login"));
      // 가입 흐름
      $("cg-send-code") && $("cg-send-code").addEventListener("click", () => this._sendCode());
      $("cg-resend") && $("cg-resend").addEventListener("click", () => this._sendCode(true));
      $("cg-change-email") && $("cg-change-email").addEventListener("click", () => this._backToEmail());
      $("cg-create") && $("cg-create").addEventListener("click", () => this._verify());
      // 로그인 흐름
      $("cg-login-btn") && $("cg-login-btn").addEventListener("click", () => this._login());
      // 비밀번호 변경(초대 계정 첫 로그인)
      $("pwc-submit") && $("pwc-submit").addEventListener("click", () => this._submitPwChange());
      const pwc2 = $("pwc-new2");
      if (pwc2) pwc2.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); this._submitPwChange(); } });
    },
    _projectId() {
      try { return (typeof Projects !== "undefined" && Projects.currentProject) ? Projects.currentProject.id : null; }
      catch { return null; }
    },
    _err(msg) {
      const e = document.getElementById("company-gate-error");
      if (!e) return;
      if (msg) { e.textContent = msg; e.classList.remove("hidden"); }
      else { e.textContent = ""; e.classList.add("hidden"); }
    },
    _tab(which) {
      const $ = (id) => document.getElementById(id);
      this._err(null);
      $("company-tab-signup").classList.toggle("active", which === "signup");
      $("company-tab-login").classList.toggle("active", which === "login");
      $("company-panel-signup").classList.toggle("hidden", which !== "signup");
      $("company-panel-login").classList.toggle("hidden", which !== "login");
    },
    async open() {
      const el = document.getElementById("company-gate");
      if (!el) return;
      this._err(null);
      this._backToEmail();
      this._tab("signup");
      el.classList.remove("hidden");
      // 가입 정책 안내 로드
      try {
        const pid = this._projectId();
        const r = await fetch("/api/signup/policy" + (pid ? ("?project_id=" + encodeURIComponent(pid)) : ""));
        const j = await r.json();
        const note = document.getElementById("cg-policy-note");
        if (note) {
          if (j.whitelist_enabled && j.allowed_domains && j.allowed_domains.length) {
            note.textContent = "허용 회사 도메인: " + j.allowed_domains.map(d => "@" + d).join(", ");
          } else {
            note.textContent = j.note || "회사 이메일(@회사도메인)로만 가입할 수 있습니다.";
          }
        }
      } catch (e) {}
    },
    close() {
      const el = document.getElementById("company-gate");
      if (el) el.classList.add("hidden");
    },
    _backToEmail() {
      const $ = (id) => document.getElementById(id);
      $("company-step-email") && $("company-step-email").classList.remove("hidden");
      $("company-step-verify") && $("company-step-verify").classList.add("hidden");
      const dc = $("cg-dev-code"); if (dc) { dc.classList.add("hidden"); dc.textContent = ""; }
    },
    async _sendCode(isResend) {
      const $ = (id) => document.getElementById(id);
      this._err(null);
      const email = ($("cg-email").value || "").trim().toLowerCase();
      if (!email) { this._err("회사 이메일 주소를 입력해 주세요."); return; }
      const btn = isResend ? $("cg-resend") : $("cg-send-code");
      const orig = btn ? btn.textContent : "";
      if (btn) { btn.disabled = true; btn.textContent = "전송 중..."; }
      try {
        const pid = this._projectId();
        const r = await fetch("/api/signup/send-code", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, project_id: pid || undefined })
        });
        const j = await r.json();
        if (!r.ok) { this._err(j.error || "코드 발송에 실패했습니다."); return; }
        this._email = email;
        this._invited = !!j.invited;
        $("cg-verify-email").textContent = email;
        $("company-step-email").classList.add("hidden");
        $("company-step-verify").classList.remove("hidden");
        // 사전 등록(초대) 계정 안내 + 회사명 기본값 채움
        const badge = $("cg-invited-badge");
        if (badge) badge.classList.toggle("hidden", !j.invited);
        if (j.invited && j.invite_company) { const cc = $("cg-company"); if (cc && !cc.value) cc.value = j.invite_company; }
        // dev-fallback 코드 표시(메일 미설정 시)
        const dc = $("cg-dev-code");
        if (j.dev_code) {
          dc.innerHTML = "메일 발송 미설정 — 개발/시연용 인증코드: <b>" + j.dev_code + "</b>";
          dc.classList.remove("hidden");
          $("cg-code").value = j.dev_code;
        } else {
          dc.classList.add("hidden"); dc.textContent = "";
          const mins = j.valid_minutes || 60;
          Prompt.toast && Prompt.toast("인증코드를 이메일로 발송했습니다. (" + mins + "분 이내 입력)");
        }
      } catch (e) {
        this._err("네트워크 오류로 코드 발송에 실패했습니다.");
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = orig; }
      }
    },
    async _verify() {
      const $ = (id) => document.getElementById(id);
      this._err(null);
      const code = ($("cg-code").value || "").trim();
      const pw = $("cg-pw").value || "";
      const pw2 = $("cg-pw2").value || "";
      const name = ($("cg-name").value || "").trim();
      const company = (($("cg-company") && $("cg-company").value) || "").trim();
      const dept = (($("cg-dept") && $("cg-dept").value) || "").trim();
      if (!/^\d{6}$/.test(code)) { this._err("인증코드 6자리를 입력해 주세요."); return; }
      if (pw.length < 8) { this._err("비밀번호는 8자 이상이어야 합니다."); return; }
      if (pw !== pw2) { this._err("비밀번호가 일치하지 않습니다."); return; }
      if (!name) { this._err("이름을 입력해 주세요."); return; }
      if (!dept) { this._err("부서/소속을 입력해 주세요."); return; }
      // 사전 등록(초대) 계정은 회사명 필수
      if (this._invited && !company) { this._err("회사명을 입력해 주세요."); return; }
      const btn = $("cg-create"); const orig = btn ? btn.textContent : "";
      if (btn) { btn.disabled = true; btn.textContent = "처리 중..."; }
      try {
        const pid = this._projectId();
        const r = await fetch("/api/signup/verify", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: this._email, code, password: pw, name, company, department: dept, project_id: pid || undefined })
        });
        const j = await r.json();
        if (!r.ok) { this._err(j.error || "가입에 실패했습니다."); return; }
        this._pendingPw = pw;   // [P40] 오프라인 재인증 검증자 생성용(메모리에서만, 저장 후 즉시 폐기)
        this._onAuthed(j.token, j.name || j.email, { email: this._email, name: j.name, role: j.role });
      } catch (e) {
        this._err("네트워크 오류로 가입에 실패했습니다.");
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = orig; }
      }
    },
    async _login() {
      const $ = (id) => document.getElementById(id);
      this._err(null);
      const email = ($("cg-login-email").value || "").trim().toLowerCase();
      const pw = $("cg-login-pw").value || "";
      if (!email || !pw) { this._err("이메일과 비밀번호를 입력해 주세요."); return; }
      const btn = $("cg-login-btn"); const orig = btn ? btn.textContent : "";
      if (btn) { btn.disabled = true; btn.textContent = "로그인 중..."; }
      try {
        const r = await fetch("/api/signup/login", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password: pw })
        });
        const j = await r.json();
        if (!r.ok) { this._err(j.error || "로그인에 실패했습니다."); return; }
        // [하위호환] must_change_password=1 로 남아 있는 구(舊) 초대 계정만 비밀번호 변경 강제.
        //   신규 초대는 초대 링크에서 본인이 직접 비밀번호를 설정하므로 이 분기를 타지 않는다.
        if (j.must_change) {
          try { sessionStorage.setItem("wm_id_token", j.token); localStorage.setItem("wm_local_token", j.token); } catch (e) {}
          if (typeof Auth !== "undefined") Auth.idToken = j.token;
          this._pendingName = j.name || j.email;
          this._pendingProfile = { email: email, name: j.name, role: j.role };
          this._openPwChange();
          return;
        }
        this._pendingPw = pw;   // [P40] 오프라인 재인증 검증자 생성용
        this._onAuthed(j.token, j.name || j.email, { email: email, name: j.name, role: j.role });
      } catch (e) {
        // [P40] 네트워크 실패 → 이 기기에 저장된 오프라인 검증자로 재인증 시도(오프라인 작업 전용).
        const off = await this._tryOfflineLogin(email, pw);
        if (!off) this._err("네트워크 오류로 로그인에 실패했습니다.");
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = orig; }
      }
    },

    /* ── 비밀번호 변경 (초대 계정 첫 로그인 강제) ── */
    _openPwChange() {
      const m = document.getElementById("pwchange-modal");
      if (!m) { this._onAuthed(Auth.idToken, this._pendingName || ""); return; }
      const e = document.getElementById("pwc-error"); if (e) e.classList.add("hidden");
      const a = document.getElementById("pwc-new"), b = document.getElementById("pwc-new2");
      if (a) a.value = ""; if (b) b.value = "";
      m.classList.remove("hidden"); requestAnimationFrame(() => m.classList.add("on"));
      setTimeout(() => { a && a.focus(); }, 120);
    },
    async _submitPwChange() {
      const $ = (id) => document.getElementById(id);
      const err = $("pwc-error"); if (err) err.classList.add("hidden");
      const np = ($("pwc-new").value || ""), np2 = ($("pwc-new2").value || "");
      const showErr = (msg) => { if (err) { err.textContent = msg; err.classList.remove("hidden"); } };
      if (np.length < 4) { showErr("새 비밀번호는 4자 이상이어야 합니다."); return; }
      if (np !== np2) { showErr("두 비밀번호가 일치하지 않습니다."); return; }
      const btn = $("pwc-submit"); const orig = btn ? btn.textContent : "";
      if (btn) { btn.disabled = true; btn.textContent = "변경 중..."; }
      try {
        const r = await fetch("/api/account/password", {
          method: "POST", headers: Auth.headers(), body: JSON.stringify({ newPassword: np })
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { showErr(j.error || "변경에 실패했습니다."); return; }
        const m = $("pwchange-modal"); if (m) { m.classList.remove("on"); setTimeout(() => m.classList.add("hidden"), 200); }
        Prompt && Prompt.toast && Prompt.toast("비밀번호가 변경되었습니다.");
        this._pendingPw = np;   // [P40] 변경된 비밀번호로 오프라인 검증자 갱신
        this._onAuthed(Auth.idToken, this._pendingName || "", this._pendingProfile || null);
      } catch (e) {
        showErr("네트워크 오류로 변경에 실패했습니다.");
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = orig; }
      }
    },
    /** [P40] 오프라인 재인증 — 검증자는 "이 기기에서 온라인 로그인에 성공한 적 있는" 사용자만 갖는다.
     *  성공해도 서버 토큰은 발급되지 않는다(Auth.offlineLogin 참조) → 서버 쓰기는 온라인 복귀 후. */
    async _tryOfflineLogin(email, pw) {
      if (typeof Auth === "undefined" || !Auth.offlineLogin) return false;
      const r = await Auth.offlineLogin(email, pw);
      if (!r || !r.ok) {
        if (r && r.reason === "bad-password") this._err("비밀번호가 올바르지 않습니다. (오프라인 확인 · 남은 시도 " + r.remaining + "회)");
        else if (r && r.reason === "locked") this._err("오프라인 로그인 시도 횟수를 초과했습니다. 인터넷에 연결해 로그인해 주세요.");
        else if (r && r.reason === "expired") this._err("오프라인 로그인 유효기간이 지났습니다. 인터넷에 연결해 로그인해 주세요.");
        return false;
      }
      this.close();
      Prompt.toast && Prompt.toast("오프라인 로그인 — " + (r.user.name || r.user.email) + " · 작성한 내용은 온라인 복귀 후 자동 업로드됩니다", 4200);
      if (App.openApp) App.openApp("viewer");
      return true;
    },

    _onAuthed(token, displayName, profile) {
      // 로컬 세션 토큰 저장 → Auth 가 Bearer 로 사용 (idToken 슬롯 공용)
      try {
        sessionStorage.setItem("wm_id_token", token);
        localStorage.setItem("wm_local_token", token);
      } catch (e) {}
      if (typeof Auth !== "undefined") Auth.idToken = token;
      this.close();
      Prompt.toast && Prompt.toast("" + displayName + " 님으로 로그인되었습니다.");
      const done = () => {
        // [P40] 온라인 로그인 성공 시점에만 오프라인 검증자 저장 → 비번은 즉시 폐기(저장 안 함)
        const pw = this._pendingPw; this._pendingPw = null;
        const em = (profile && profile.email) || (typeof Auth !== "undefined" && Auth.user ? Auth.user.email : null);
        if (pw && em && typeof Auth !== "undefined" && Auth.saveOfflineVerifier) {
          Auth.saveOfflineVerifier(em, pw, {
            name: (profile && profile.name) || displayName,
            role: (typeof Auth !== "undefined" && Auth.role) || (profile && profile.role) || "viewer"
          });
        }
        if (typeof Install !== "undefined" && Install.maybePrompt) Install.maybePrompt();
        if (App.openApp) App.openApp("viewer");
      };
      // 인증 상태 갱신 후 뷰어로
      if (typeof Auth !== "undefined" && Auth.refresh) {
        Auth.refresh().then(done).catch(done);
      } else { done(); }
    }
  };

  /* ══════════════════════════════════════════
     PROMPT — 범용 입력 모달 (프로젝트/데크 생성)
  ══════════════════════════════════════════ */
  const Prompt = {
    _resolve: null,
    init() {
      const $ = (id) => document.getElementById(id);
      $("prompt-modal-ok") && $("prompt-modal-ok").addEventListener("click", () => this._submit());
      $("prompt-modal-cancel") && $("prompt-modal-cancel").addEventListener("click", () => this._close(null));
      const bd = document.querySelector('#prompt-modal .admin-gate-backdrop');
      bd && bd.addEventListener("click", () => this._close(null));
      const inp = $("prompt-modal-input");
      if (inp) inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); this._submit(); } if (e.key === "Escape") this._close(null); });
    },
    /** [스팸 방지] 동시에 화면에 떠 있을 수 있는 토스트 최대 개수.
     *  이 캡이 없으면 버튼 연타·연쇄 액션 시 토스트가 세로로 무한정 쌓여
     *  360 뷰어 컨트롤바를 가리는 "검은 박스 스택"이 된다(마스터 스크린샷 실측). */
    TOAST_MAX: 2,
    /** 가벼운 토스트 알림 (화면 하단 중앙, 자동 소멸) */
    toast(msg, ms) {
      // [빈 토스트 방지] 빈/undefined/공백 메시지는 내용 없는 검은 상자만 띄우므로 무시.
      const text = (msg === undefined || msg === null) ? "" : String(msg).trim();
      if (!text) return;
      let host = document.getElementById("wm-toast-host");
      if (!host) {
        host = document.createElement("div");
        host.id = "wm-toast-host";
        host.className = "wm-toast-host";
        document.body.appendChild(host);
      }
      const life = ms || 2200;
      const kill = (el) => {
        if (el._wmT) { clearTimeout(el._wmT); el._wmT = null; }
        if (el._wmT2) { clearTimeout(el._wmT2); el._wmT2 = null; }
        el.remove();
      };
      const arm = (el, dur) => {
        if (el._wmT) clearTimeout(el._wmT);
        el._wmT = setTimeout(() => {
          el.classList.remove("on");
          el._wmT2 = setTimeout(() => el.remove(), 280);
        }, dur);
      };
      // ① 같은 메시지가 이미 떠 있으면 새로 쌓지 말고 수명만 연장(중복 스택 차단)
      const dup = Array.prototype.filter.call(host.children, (n) => n.dataset && n.dataset.wmMsg === text)[0];
      if (dup) { arm(dup, life); return; }
      // ② 캡 초과분은 가장 오래된 것부터 즉시 제거 — 어떤 호출부가 남아 있어도 무한 스택 불가
      while (host.children.length >= this.TOAST_MAX) kill(host.firstElementChild);
      const t = document.createElement("div");
      t.className = "wm-toast";
      t.textContent = text;
      t.dataset.wmMsg = text;
      host.appendChild(t);
      requestAnimationFrame(() => t.classList.add("on"));
      arm(t, life);
    },
    /** opts: { title, sub, placeholder, second } → Promise<string|{value,second}|null> */
    ask(opts) {
      return new Promise((resolve) => {
        this._resolve = resolve;
        document.getElementById("prompt-modal-title").textContent = opts.title || "입력";
        document.getElementById("prompt-modal-sub").textContent = opts.sub || "";
        const inp = document.getElementById("prompt-modal-input");
        inp.value = opts.value || ""; inp.placeholder = opts.placeholder || ""; this._allowEmpty = !!opts.allowEmpty;
        const inp2 = document.getElementById("prompt-modal-input2");
        inp2.value = opts.secondValue || "";
        inp2.placeholder = (typeof opts.second === "string") ? opts.second : "";
        inp2.classList.toggle("hidden", !opts.second);
        document.getElementById("prompt-modal-error").classList.add("hidden");
        const m = document.getElementById("prompt-modal");
        m.classList.remove("hidden");
        requestAnimationFrame(() => m.classList.add("on"));
        setTimeout(() => inp.focus(), 60);
      });
    },
    _submit() {
      const inp = document.getElementById("prompt-modal-input");
      const inp2 = document.getElementById("prompt-modal-input2");
      const err = document.getElementById("prompt-modal-error");
      const val = (inp.value || "").trim();
      if (!val && !this._allowEmpty) { err.textContent = "값을 입력하세요."; err.classList.remove("hidden"); return; }
      const second = inp2.classList.contains("hidden") ? undefined : (inp2.value || "").trim();
      this._close({ value: val, second });
    },
    _close(result) {
      const m = document.getElementById("prompt-modal");
      m.classList.remove("on");
      setTimeout(() => m.classList.add("hidden"), 200);
      // [버그수정] 에러 텍스트 잔류 정리 — 다음 ask 모달에 이전 오류가 깜빡이지 않게
      const err = document.getElementById("prompt-modal-error"); if (err) { err.textContent = ""; err.classList.add("hidden"); }
      const r = this._resolve; this._resolve = null;
      if (r) r(result);
    },

    /** [WO 20260921 publish-fix] 커스텀 확인 모달 — Promise<boolean>.
     *  근본원인: window.confirm()/alert()/prompt()는 PWA 독립실행모드(display:standalone,
     *  manifest.webmanifest 참조)에서 플랫폼에 따라 아무 표시 없이 즉시 false를 반환하며 조용히
     *  실패한다(iOS 홈화면 추가 앱의 알려진 WebKit 제약). 배포 버튼이 "아무 일도 하지 않던" 원인이
     *  이것 — confirm()이 무음으로 false를 반환해 즉시 return된 것으로, 자체 DOM 모달은 이 제약을
     *  받지 않는다. #prompt-modal(admin-gate) 과 동일한 CSS를 재사용해 신규 스타일 불필요. */
    confirm(title, message) {
      return new Promise((resolve) => {
        let modal = document.getElementById("wm-confirm-modal");
        if (!modal) {
          modal = document.createElement("div");
          modal.id = "wm-confirm-modal";
          modal.className = "admin-gate hidden";
          modal.setAttribute("role", "dialog");
          modal.setAttribute("aria-modal", "true");
          modal.innerHTML =
            '<div class="admin-gate-backdrop"></div>' +
            '<div class="admin-gate-card">' +
              '<h2 class="admin-gate-title" id="wm-confirm-title"></h2>' +
              '<p class="admin-gate-sub" id="wm-confirm-msg" style="white-space:pre-line"></p>' +
              '<div class="admin-gate-actions">' +
                '<button id="wm-confirm-cancel" class="admin-gate-btn ghost" type="button">취소</button>' +
                '<button id="wm-confirm-ok" class="admin-gate-btn primary" type="button">확인</button>' +
              '</div>' +
            '</div>';
          document.body.appendChild(modal);
        }
        document.getElementById("wm-confirm-title").textContent = title || "확인";
        document.getElementById("wm-confirm-msg").textContent = message || "";
        const okBtn = document.getElementById("wm-confirm-ok");
        const cancelBtn = document.getElementById("wm-confirm-cancel");
        const backdrop = modal.querySelector(".admin-gate-backdrop");
        // 🔴 [WO 20260928-copy · 라이브 실측] 확인창을 연달아 띄우면(닫자마자 다음 confirm) 앞 창의
        //   200ms 지연 숨김 타이머가 새 창에 "hidden" 을 붙여 두 번째 창이 사라지고 약속이 영원히 대기했다.
        //   열 때 앞 타이머를 취소하고, 닫힐 때는 그 사이 다시 열리지 않았을 때만 숨긴다.
        clearTimeout(modal._hideTimer);
        const close = (result) => {
          modal.classList.remove("on");
          modal._hideTimer = setTimeout(() => { if (!modal.classList.contains("on")) modal.classList.add("hidden"); }, 200);
          okBtn.removeEventListener("click", onOk);
          cancelBtn.removeEventListener("click", onCancel);
          backdrop.removeEventListener("click", onCancel);
          resolve(result);
        };
        const onOk = () => close(true);
        const onCancel = () => close(false);
        okBtn.addEventListener("click", onOk);
        cancelBtn.addEventListener("click", onCancel);
        backdrop.addEventListener("click", onCancel);
        modal.classList.remove("hidden");
        requestAnimationFrame(() => modal.classList.add("on"));
      });
    }
  };

  /* ══════════════════════════════════════════
     PROJECTS — 프로젝트 + 데크(선박 층) 관리 (디자이너)
  ══════════════════════════════════════════ */
  const Projects = {
    list: [],
    decks: [],
    currentProject: null,
    currentDeck: null,

    init() {
      const $ = (id) => document.getElementById(id);
      $("btn-new-project") && $("btn-new-project").addEventListener("click", () => this.createProject());
      $("btn-delete-project") && $("btn-delete-project").addEventListener("click", () => this.deleteProject());
      // [WO 20260918] 프로젝트 안에서 오프라인 다운로드 — 12_ProjectHub.js downloadProject() 재사용(SoT).
      const dlBtn = $("btn-download-project");
      if (dlBtn) dlBtn.addEventListener("click", () => {
        if (!this.currentProject) return;
        if (typeof ProjectHub !== "undefined" && ProjectHub.downloadProject) ProjectHub.downloadProject(this.currentProject, dlBtn);
      });
      $("btn-new-deck") && $("btn-new-deck").addEventListener("click", () => this.createDeck());
      // #1: 프로젝트 드롭다운 '이동(전환)' 기능 제거 — select 대신 현재 프로젝트명만 표시.
    },

    /** 디자이너 진입 시 호출 */
    async load() {
      try {
        // [버그수정] 인증헤더 필수 — /api/projects 는 멤버십/배포 스코프 필터(미전송=익명→누락)
        const r = await fetch("/api/projects", { headers: Auth.headers() });
        const { data } = await r.json();
        this.list = data || [];
      } catch (e) { this.list = []; }
      this._renderSelect();
    },

    _renderSelect() {
      // #1: 드롭다운 전환 제거 → 현재 프로젝트명 라벨만 갱신.
      const cur = document.getElementById("project-current");
      const has = !!this.currentProject;
      if (cur) cur.textContent = has ? this.currentProject.name : "— 프로젝트 선택 —";
      const pa = document.getElementById("project-actions");
      if (pa) pa.classList.toggle("hidden", !has);
      const db = document.getElementById("decks-block");
      if (db) db.classList.toggle("hidden", !has);
    },

    /* [WO 20260918] 🔴 조용한 실패 금지 — createProject/deleteProject/createDeck 은 서버에
     *  즉시 ID 를 발급받아야 다음 단계(선택/도면로드/크롭)로 진행할 수 있는 동기 흐름이라,
     *  OpLog 오프라인 큐(20_App.js, pin/zone 편집 재생 전용)로 편입하지 않는다 — 큐잉하면
     *  임시 ID ↔ 서버 ID 재조정 로직이 새로 필요해지고(SoT 분열 위험), 삭제는 재생 시점에
     *  사용자가 모르는 사이 실행돼 위험하다(§10). 대신 최소 조치로 오프라인이면 그 자리에서
     *  이유를 말하고 중단한다(기존 Prompt.toast 경로 재사용, 새 UI 없음). */
    async createProject() {
      if (!Auth.isDesigner) return;
      if (!navigator.onLine) { Prompt.toast && Prompt.toast("오프라인이라 지금은 프로젝트를 생성할 수 없습니다 — 연결 후 다시 시도하세요"); return; }
      const res = await Prompt.ask({ title: "프로젝트 생성", sub: "새 프로젝트 이름을 입력하세요 (예: ○○호 검사)", placeholder: "프로젝트 이름" });
      if (!res) return;
      try {
        const r = await fetch("/api/projects", { method: "POST", headers: Auth.headers(), body: JSON.stringify({ name: res.value }) });
        const p = await r.json();
        if (!r.ok) { alert(p.error || "생성 실패(권한 필요)"); return; }
        await this.load();
        await this.selectProject(p.id);
      } catch (e) {
        if (!navigator.onLine) { Prompt.toast && Prompt.toast("오프라인이라 지금은 프로젝트를 생성할 수 없습니다 — 연결 후 다시 시도하세요"); }
        else alert("네트워크 오류");
      }
    },

    async deleteProject() {
      if (!this.currentProject) return;
      if (!await Prompt.confirm("프로젝트 삭제", `'${this.currentProject.name}' 프로젝트와 모든 데크를 삭제할까요?`)) return;
      if (!navigator.onLine) { Prompt.toast && Prompt.toast("오프라인이라 지금은 프로젝트를 삭제할 수 없습니다 — 연결 후 다시 시도하세요"); return; }
      try {
        await fetch("/api/projects/" + this.currentProject.id, { method: "DELETE", headers: Auth.headers() });
        this.currentProject = null; this.currentDeck = null; this.decks = [];
        await this.load();
        this._renderDecks();
      } catch (e) {
        // [WO 20260918] 🔴 예전엔 빈 catch — 오프라인/네트워크 오류가 아무 말 없이 무시됐다.
        if (!navigator.onLine) Prompt.toast && Prompt.toast("오프라인이라 지금은 프로젝트를 삭제할 수 없습니다 — 연결 후 다시 시도하세요");
        else Prompt.toast && Prompt.toast("삭제 실패 — 네트워크 오류, 다시 시도해주세요");
      }
    },

    async selectProject(id) {
      this.currentProject = this.list.find((p) => p.id === id) || null;
      // [P40] 배지 컨텍스트 — 프로젝트 역할 표시(공유 지점: Auth.setProjectContext)
      if (typeof Auth !== "undefined" && Auth.setProjectContext) Auth.setProjectContext(this.currentProject);
      this._renderSelect();
      if (!this.currentProject) { this.decks = []; this._renderDecks(); return; }
      await this.loadDecks();
    },

    async loadDecks() {
      // ── [마스터 요청] 목록 정합성: 요청 시점의 프로젝트 ID를 고정해, 응답 도착 시
      //    현재 프로젝트가 바뀌었으면 폐기(유령 항목 방지). 또 응답에서 현재 프로젝트 deck만 채택. ──
      const reqPid = this.currentProject ? this.currentProject.id : null;
      if (!reqPid) { this.decks = []; this._renderDecks(); return; }
      let data = [];
      try {
        // [버그수정] GET /decks 는 인증 필수(401) — Auth.headers() 누락 시 빈 목록 → "구역 없음".
        //   createDeck(POST)는 헤더가 있어 생성되지만, 직후 loadDecks 가 401 로 빈 목록을 받아
        //   "생성해도 구역이 안 나오는" 회귀였다. (도면 등록 시 ensureDeck 도 동일 증상)
        const r = await fetch("/api/projects/" + reqPid + "/decks", { headers: Auth.headers() });
        const j = await r.json();
        data = j.data || [];
      } catch (e) { data = []; }
      // 응답 도착 사이 프로젝트가 바뀌었으면 무시
      if (!this.currentProject || this.currentProject.id !== reqPid) return;
      // 서버가 다른 프로젝트 deck을 섞어줘도(이론상) 현재 프로젝트 것만 사용
      this.decks = (data || []).filter((d) => !d.project_id || d.project_id === reqPid);
      this._renderDecks();
      // [B4] 로컬 draft 스캔 → '미저장' 배지 동기화(비차단)
      try { if (typeof App !== "undefined" && App._refreshUnsavedDecks) App._refreshUnsavedDecks(); } catch (e) {}
      // [WO 20260928-hub-tree] 🔴 공유 지점(SoT) — createDeck/extractRegionAsDeck/드래그크롭 생성이
      //   전부 이 loadDecks() 를 거치므로 허브 카드 트리 갱신은 여기 한 곳에만 둔다(각 생성 함수마다
      //   중복 호출 금지). 허브 화면이 지금 안 보이면(screen-projects 비활성) 아무 일도 안 한다.
      try { if (typeof ProjectHub !== "undefined" && ProjectHub.refreshIfVisible) ProjectHub.refreshIfVisible(); } catch (e) {}
    },

    /** #3: 구역 생성. 반환된 구역 객체를 돌려줌(없으면 강제 생성 흐름에서 사용). */
    async createDeck(opts) {
      opts = opts || {};
      if (!this.currentProject) { alert("먼저 프로젝트를 선택하세요."); return null; }
      // ── [마스터 요청] 생성 버튼 연타 가드: 진행 중이면 중복 생성 차단 ──
      // [WO AM·재현 실측] 이 가드가 조용히 null 만 반환해 연타(또는 파일선택창이 아직 떠 있는
      // 최대 60초 창) 시 "버튼이 눌러도 반응 없음"처럼 보였다(§5 조용한 실패). 이유를 알린다.
      if (this._creatingDeck) { Prompt.toast && Prompt.toast("구역을 만드는 중입니다 — 잠시 후 다시 시도하세요"); return null; }
      // [WO 20260918] 🔴 조용한 실패 금지 — 이 흐름은 파일선택창까지 여는 동기 흐름이라
      // OpLog 큐잉 대상이 아니다(사유는 파일 상단 주석). 오프라인이면 파일창을 열기 전에 중단.
      if (!navigator.onLine) { Prompt.toast && Prompt.toast("오프라인이라 지금은 구역을 생성할 수 없습니다 — 연결 후 다시 시도하세요"); return null; }
      let name = opts.name;
      if (!name) {
        const res = await Prompt.ask({ title: "구역 생성", sub: "구역 이름을 입력하세요 (예: Main Deck, Engine Room, No.1 Hold)", placeholder: "구역 이름" });
        if (!res) return null;
        name = res.value;
      }
      // ── [마스터 요청] 이름 검증 + 중복 방지(같은 프로젝트에 같은 이름 구역 차단) ──
      name = String(name || "").trim();
      if (!name) { alert("구역 이름을 입력하세요."); return null; }
      const dup = (this.decks || []).find((x) => String(x.name).trim().toLowerCase() === name.toLowerCase());
      if (dup) {
        Prompt.toast && Prompt.toast("이미 '" + name + "' 구역이 있습니다 — 그 구역을 선택합니다");
        this.currentDeck = dup; this._renderDecks();
        return dup; // 중복 생성하지 않고 기존 구역 반환
      }
      // ── [WO 20260921·마스터 요청] "새 파일 로드가 아니라 이미 로드된 파일에서 지정 시
      //   캡처하듯이 완전한 새 페이지를 생성" — 사용자가 직접 만드는 구역(askDrawing !== false)은
      //   ①기존 도면에서 영역 지정 / ②새 도면 파일 업로드 중 고르게 한다.
      //   🔴 새 메커니즘 금지 — ①은 기존 extractRegionAsDeck()(WO 20260918-B)을 그대로 재사용한다.
      //   opts.source 가 미리 정해져 있으면(테스트/내부 재호출) 묻지 않는다.
      //   자동생성 경로(askDrawing:false, ensureDeck 등)는 건드리지 않는다 — 조건에서 제외.
      if (opts.askDrawing !== false && !opts.source) {
        const source = await this._chooseDeckSource();
        if (!source) { Prompt.toast && Prompt.toast("구역 생성을 취소했습니다"); return null; }
        opts.source = source;
      }
      if (opts.source === "region") {
        // 이미 이름 검증(중복 포함)을 마쳤으므로 그대로 넘긴다 — extractRegionAsDeck 은 그 안에서
        // currentProject/currentDeck.deployment_id/온라인 상태를 다시 확인한다(자체 가드 유지).
        return await this.extractRegionAsDeck({ name });
      }
      // ── [P1·마스터 요청] "구역을 등록하면 반드시 도면이 등록되어야 한다" ──
      //   사용자가 직접 만든 구역(askDrawing !== false)은 **도면 파일을 먼저 확정**한 뒤에야 POST 한다.
      //   파일창을 취소하면 구역 POST 자체를 하지 않으므로 '도면없음' 구역이 생기지 않는다(롤백 불필요).
      //   ensureDeck()/도면로드 중 자동생성(askDrawing:false)은 이미 파일이 손에 있으므로 이 단계를 건너뛴다(무한루프 방지).
      this._creatingDeck = true;
      let created = null;
      let picked = null;
      // [WO 20260916] 구역=도면의 한 조각 — 이 구역이 가리킬 페이지(1-base). 파일 미확정 경로(자동생성)는 미지정(NULL)으로 둔다.
      let page = 1;
      try {
        if (opts.askDrawing !== false) {
          if (typeof App === "undefined" || !App._pickDrawingFile) { alert("도면 선택기를 사용할 수 없습니다."); return null; }
          Prompt.toast && Prompt.toast("구역 '" + name + "' — 이 구역에 등록할 도면(PDF/PNG/JPG)을 선택하세요");
          picked = await App._pickDrawingFile();
          if (!picked) {
            Prompt.toast && Prompt.toast("도면을 선택하지 않아 구역 '" + name + "' 생성을 취소했습니다 — 구역에는 도면이 반드시 필요합니다");
            return null;   // 구역을 만들지 않는다 → 사용자 취소로 '도면없음' 구역이 생기지 않음
          }
          // 여러 장 PDF 면 이 구역이 쓸 1페이지를 먼저 정한다(1장/이미지면 자동 1, 묻지 않음).
          const totalPages = await this._peekPageCount(picked);
          page = await this._choosePage(totalPages);
        }
        const body = { name };
        if (opts.askDrawing !== false) body.page = page; // 자동생성 경로는 전송하지 않음 → 서버 NULL(구버전과 동일)
        const r = await fetch("/api/projects/" + this.currentProject.id + "/decks", {
          method: "POST", headers: Auth.headers(),
          body: JSON.stringify(body)
        });
        const d = await r.json();
        if (!r.ok) { alert(d.error || "생성 실패(권한 필요)"); return null; }
        await this.loadDecks();
        created = this.decks.find((x) => x.id === d.id) || d;
        // ── [B3] draft 키 표류 방지 ──
        //   draft 키는 `projectId::deckId` 다. currentDeck 을 새 구역으로 바꾸기 전에
        //   현재 구역에서 작업 중이던 미저장분을 '기존 키'로 확실히 저장한다.
        //   (안 하면 이전 구역 작업이 새 구역 키로 넘어가 사실상 유실된다)
        if (opts.select !== false && this.currentDeck && this.currentDeck.id !== created.id
            && typeof App !== "undefined" && App._dirty && App._saveDraftLocal) {
          try { await App._saveDraftLocal(); } catch (e) {}
        }
        if (opts.select !== false) { this.currentDeck = created; this._renderDecks(); }
      } catch (e) {
        if (!navigator.onLine) Prompt.toast && Prompt.toast("오프라인이라 지금은 구역을 생성할 수 없습니다 — 연결 후 다시 시도하세요");
        else alert("네트워크 오류");
        return null;
      }
      finally { this._creatingDeck = false; }
      // ── [P1] 구역이 확정된 뒤에 도면 로드. _creatingDeck 해제 후에 호출해야
      //   _loadDrawing 내부의 '구역 선행' 가드가 createDeck 을 재호출해도 연타가드에 막히지 않는다.
      if (created && picked && opts.select !== false && typeof App !== "undefined" && App._loadDrawing) {
        try {
          await App._loadDrawing(picked);
          // 선택한 페이지로 전환(1페이지면 그대로) + 그 페이지에서 크롭(영역) 지정 — 건너뛰면 페이지 전체(crop 없음).
          if (page > 1 && App._gotoPage) { try { await App._gotoPage(page); } catch (e) {} }
          const crop = await this._pickDeckCrop();
          if (crop) {
            const r2 = await fetch("/api/decks/" + created.id, { method: "PUT", headers: Auth.headers(), body: JSON.stringify({ crop }) });
            if (r2.ok) {
              const updated = await r2.json();
              Object.assign(created, updated);
              const idx = this.decks.findIndex((x) => x.id === created.id);
              if (idx >= 0) this.decks[idx] = created;
              if (this.currentDeck && this.currentDeck.id === created.id) this.currentDeck = created;
              this._renderDecks();
            }
          }
        }
        catch (e) { Prompt.toast && Prompt.toast("도면 로드 실패 — ‘도면 등록’ 버튼으로 다시 시도하세요"); }
      }
      return created;
    },

    /** [WO 20260916] 선택한 파일의 PDF 페이지 수를 가볍게 확인(peek, State 비변경). 이미지/실패 시 1. */
    async _peekPageCount(file) {
      const isPdf = file && (file.type === "application/pdf" || String(file.name || "").toLowerCase().endsWith(".pdf"));
      if (!isPdf || typeof PDF === "undefined" || !PDF.load) return 1;
      try {
        const ab = await file.arrayBuffer();
        const doc = await PDF.load(ab);
        const n = doc && doc.numPages ? doc.numPages : 1;
        try { doc && doc.destroy && doc.destroy(); } catch (e) {}
        return n;
      } catch (e) { return 1; }
    },

    /** [WO 20260916] 여러 장 PDF 중 이 구역이 쓸 페이지 번호를 묻는다. 1장이면 자동 1(묻지 않음). */
    async _choosePage(totalPages) {
      if (!(totalPages > 1)) return 1;
      const pr = await Prompt.ask({
        title: "페이지 선택",
        sub: `이 PDF는 ${totalPages}페이지입니다 — 이 구역에 쓸 페이지 번호를 입력하세요(1~${totalPages})`,
        placeholder: "예: 1", value: "1"
      });
      if (!pr || !pr.value) return 1;
      const n = parseInt(pr.value, 10);
      return (!isNaN(n) && n >= 1 && n <= totalPages) ? n : 1;
    },

    /** [WO 20260916] 구역이 될 영역(crop, %)을 도면 위에서 드래그로 지정.
     *  🔴 새 그리기 도구 금지(Ponytail) — 기존 영역 그리기(Zones rect 드래그)를 그대로 재사용한다.
     *  Zones._commitZone/_cancelDraw 를 일시적으로 가로채 라벨 프롬프트 없이 bbox(%)만 받고 원복.
     *  드래그 없이 Esc/취소 → null(=페이지 전체, crop 미지정). */
    _pickDeckCrop(hintMsg) {
      return new Promise((resolve) => {
        if (typeof Zones === "undefined") { resolve(null); return; }
        const origCommit = Zones._commitZone.bind(Zones);
        const origCancel = Zones._cancelDraw.bind(Zones);
        let done = false;
        const restore = () => { Zones._commitZone = origCommit; Zones._cancelDraw = origCancel; };
        Zones._commitZone = async (geom) => {
          if (done) return; done = true;
          const bb = Zones._bbox(geom);
          restore();
          origCancel();
          resolve({ x: bb.x, y: bb.y, w: bb.w, h: bb.h });
        };
        Zones._cancelDraw = () => {
          origCancel();
          if (done) return; done = true;
          restore();
          resolve(null);
        };
        // 🔴 [WO 20260928 · 라이브 실측] 모바일 사이드 시트가 열려 있으면 화면 하단 절반을 덮어
        //   도면을 드래그할 수 없다. 크롭 지정을 요구하는 **모든** 경로가 이 함수를 지나므로 여기서 닫는다.
        if (typeof App !== "undefined" && App._closeSidebarSheet) App._closeSidebarSheet();
        Zones._shape = "rect"; Zones._poly = null;
        State.drawingZone = true;
        if (Zones._syncToolUi) Zones._syncToolUi();
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast(hintMsg || "도면에서 이 구역이 될 영역을 드래그하세요 — Esc를 누르면 페이지 전체가 구역이 됩니다");
      });
    },

    /** [WO 20260921] 구역 생성 시 "①기존 도면에서 영역 지정" vs "②새 도면 파일 업로드" 선택.
     *  🔴 로드된 도면(=deployment_id 가 있는 현재 구역)이 없으면 ①을 고를 수 없다 — 이때 조용히
     *  비활성만 시키지 않고 이유를 화면에 안내한다(#dsm-region-reason).
     *  마크업이 없으면(구버전 폴백) 묻지 않고 기존 동작(업로드)으로 진행한다.
     *  @returns {Promise<"region"|"upload"|null>} null = 취소
     */
    _chooseDeckSource() {
      return new Promise((resolve) => {
        const m = document.getElementById("deck-source-modal");
        if (!m) { resolve("upload"); return; } // 구버전 폴백 — 묻지 않고 종전 동작
        // 🔴 [WO 20260929] 도면이 화면에 로드돼 있으면(구역 소속·개수와 무관하게) ①을 고를 수 있다 —
        //   이미 저장된 도면(currentDeck.deployment_id)이면 기존 extractRegionAsDeck 경로,
        //   아직 저장 전인 로드된 도면이면 createDeckFromLoadedDrawing 경로로 위임한다.
        //   중복 UI 금지(요구4): 새 모달을 만들지 않고 이 선택지의 활성 조건만 넓힌다.
        const canExtract = !!(this.currentDeck && this.currentDeck.deployment_id) || this._canExtractFromLoadedDrawing();
        const btnRegion = document.getElementById("dsm-btn-region");
        const btnUpload = document.getElementById("dsm-btn-upload");
        const reasonEl = document.getElementById("dsm-region-reason");
        const subEl = document.getElementById("dsm-sub");
        // 🔴 [WO 20260929·마스터 지적] "현재 도면: ㅁ" 이 구역 이름을 보여주고 있었다 — 이 화면은
        //   "어느 도면에서 영역을 지정할지" 를 알려야 하므로 도면 파일명(State.fileName)이 SoT다.
        //   화면에 로드된 도면이 없을 때만(예외적으로) 구역 이름으로 폴백한다.
        const loadedName = (typeof State !== "undefined" && State.fileName)
          || (this.currentDeck && this.currentDeck.name) || "";
        if (subEl) subEl.textContent = loadedName ? ("현재 도면: " + loadedName) : "";
        if (btnRegion) {
          btnRegion.disabled = !canExtract;
          if (btnRegion.classList) btnRegion.classList.toggle("disabled", !canExtract);
          // 🔴 실측(라이브 스크린샷) — .admin-gate-btn.primary 는 :disabled 전용 CSS 가 없어
          // disabled=true 여도 금색 그대로 보여 "눌러도 되는 버튼"처럼 보였다. style.css 는
          // 다른 트랙 점유 중(새 규칙 추가 금지)이라, 인라인 스타일로만 시각적으로도 비활성을 알린다.
          if (btnRegion.style) {
            btnRegion.style.opacity = canExtract ? "" : "0.45";
            btnRegion.style.cursor = canExtract ? "" : "not-allowed";
          }
        }
        if (reasonEl && reasonEl.classList) reasonEl.classList.toggle("hidden", canExtract);
        let done = false;
        const close = (val) => {
          if (done) return; done = true;
          if (m.classList) { m.classList.remove("on"); setTimeout(() => m.classList.add("hidden"), 200); }
          resolve(val);
        };
        const backdrop = document.getElementById("dsm-backdrop");
        const cancelBtn = document.getElementById("dsm-cancel");
        if (btnRegion) btnRegion.onclick = () => { if (!canExtract) return; close("region"); };
        if (btnUpload) btnUpload.onclick = () => close("upload");
        if (backdrop) backdrop.onclick = () => close(null);
        if (cancelBtn) cancelBtn.onclick = () => close(null);
        if (m.classList) {
          m.classList.remove("hidden");
          if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => m.classList.add("on"));
          else m.classList.add("on");
        }
      });
    },

    /** [WO 20260918-B] 🔴 여러 개의 뷰가 담긴 도면(A0 등)에서 **드래그한 부분만** 새 영역으로 뽑아낸다.
     *  마스터 원문: "pdf 에 여러 개의 뷰가 있는 파일일 때 긁어서 그 부분만 복사하듯이
     *  새로운 영역으로 만들어내는 기능".
     *
     *  🔴 [WO 20260928-copy] 갱신 — 원본 PDF 가 있으면 아래 "창" 대신 **복사본**(지정 부분만 담은 새 1페이지
     *     PDF 배포본, crop 없음)을 만든다(_planRegionCopy). 원본 배포본의 핀·구역·주석은 여전히 무변경이다.
     *     아래 창 방식은 원본 PDF 가 없는 구버전 도면에서 사용자가 고를 때만 쓰인다.
     *  🔴 비파괴(마스터 확정 — "pdf 원본은 유지한 채 그 영역만 보여주는 기능"):
     *   · 원본 PDF·배포본(deployments 행)에는 **한 바이트도 쓰지 않는다.** decks 행 1개를 INSERT 할 뿐이다.
     *   · 새 영역은 원본과 **같은 deployment_id** 를 가리키고 차이는 page+crop 뿐 —
     *     잘라낸 픽셀을 따로 저장하는 "복사"가 아니라 원본을 들여다보는 **창(view)** 이다.
     *   · 그래서 같은 도면에서 몇 번이든 반복해 뽑을 수 있고(요구①),
     *     뽑은 영역을 지워도(DELETE /api/decks/:id = decks 행 soft delete) 원본은 그대로다(요구④).
     *
     *  좌표계(요구③): 드래그 좌표는 MapCtrl.viewportToPercent → **페이지 기준 %** 다.
     *   크롭은 화면 줌/팬(MapCtrl.fitZone)과 고해상도 렌더 대상(PDF.setDeckCrop)만 바꿀 뿐
     *   좌표 원점을 옮기지 않는다 → 영역 안에서 찍은 핀도 계속 페이지 기준 %로 저장된다.
     *   배포본으로 내보낼 때만 App._mapZoneForCrop/_mapAnnoForCrop 과 **같은 규칙**
     *   (MapCtrl.pageToDeckCropPct)으로 크롭 기준 %가 되고, MapCtrl.deckCropPctToPage 로 정확히 되돌아온다.
     *  @param {object} [opts] { crop, name } — 테스트/자동화용 선주입(미지정 시 드래그·프롬프트로 물음)
     *  @returns {Promise<object|null>} 생성된 구역(deck) 또는 null(취소/실패)
     */
    async extractRegionAsDeck(opts) {
      opts = opts || {};
      if (typeof Auth !== "undefined" && !Auth.isDesigner) { Prompt.toast && Prompt.toast("설계자만 영역을 추출할 수 있습니다"); return null; }
      if (!this.currentProject) { Prompt.toast && Prompt.toast("먼저 프로젝트를 선택하세요"); return null; }
      const src = this.currentDeck;
      if (!src || !src.deployment_id) {
        // 🔴 [WO 20260928] "도면 있음 + 구역 0" — **첫 영역 지정이 곧 첫 구역 생성**이다.
        //   모든 진입경로(#btn-region-extract · #deck-source-modal ① · #side-tree CTA)가 이 함수로
        //   수렴하므로 분기도 여기 한 곳에만 둔다(형제 호출부 분열 금지 — CLAUDE.md §G-2-5).
        if (this._canExtractFromLoadedDrawing()) return await this.createDeckFromLoadedDrawing(opts);
        Prompt.toast && Prompt.toast("먼저 도면을 등록하세요 — 그 도면에서 영역을 지정해 구역을 만듭니다"); return null;
      }
      // 🔴 조용한 실패 금지 — 드래그 UI 를 띄우기 전에 끊는다(31_Projects.createDeck 과 같은 규칙).
      if (!navigator.onLine) { Prompt.toast && Prompt.toast("오프라인이라 지금은 영역을 추출할 수 없습니다 — 연결 후 다시 시도하세요"); return null; }
      if (this._extractingRegion) return null;   // 연타 가드(_creatingDeck 과 같은 패턴)

      const crop = opts.crop || await this._pickDeckCrop("도면에서 새 영역으로 만들 부분을 드래그하세요 — Esc 를 누르면 취소됩니다");
      if (!crop || !(crop.w > 0) || !(crop.h > 0)) { Prompt.toast && Prompt.toast("영역 추출을 취소했습니다"); return null; }

      // 지금 보고 있는 페이지(원본 구역이 특정 페이지를 가리키면 그 페이지) — 1-base
      const page = (typeof State !== "undefined" && State.pdfPage) || src.page || 1;

      let name = opts.name;
      if (name == null) {
        const res = await Prompt.ask({
          title: "새 영역 이름",
          sub: "긁어낸 영역의 이름을 정하세요 — 원본 도면은 그대로 유지됩니다",
          placeholder: "예: 평면도, 측면도, A-A 단면",
          value: this._nextRegionName(src.name)
        });
        if (!res) { Prompt.toast && Prompt.toast("영역 추출을 취소했습니다"); return null; }
        name = res.value;
      }
      name = String(name || "").trim() || this._nextRegionName(src.name);
      const dup = (this.decks || []).find((x) => String(x.name).trim().toLowerCase() === name.toLowerCase());
      if (dup) { Prompt.toast && Prompt.toast("이미 '" + name + "' 구역이 있습니다 — 다른 이름을 쓰세요"); return null; }

      this._extractingRegion = true;
      try {
        // 🔴 [WO 20260928-copy] 마스터: "지정한 영역만 복사해서 새로운 페이지" / "확대하면 해상도가 깨지잖아".
        //   원본 PDF 가 있으면 그 부분만 벡터 복사한 새 1페이지 PDF 배포본을 만들어 가리킨다(crop 없음).
        //   원본이 없으면(구버전) 조용히 이미지 복사본을 만들지 않고 사용자에게 묻는다(_planRegionCopy).
        const plan = await this._planRegionCopy(src, page, crop, name);
        if (!plan) return null;   // 취소/실패 — 사유는 _planRegionCopy 가 이미 화면에 알렸다
        const r = await fetch("/api/projects/" + this.currentProject.id + "/decks", {
          method: "POST", headers: Auth.headers(),
          // 복사본: 새 배포본(그 페이지 자체가 영역) · 창 방식: 원본과 같은 도면 + crop(원본 무변경).
          // [WO 20260921-tree] 🔴 parent_id = 부모 구역 id — 원본이 이미 "영역"(src.parent_id 있음)이어도
          // 그 부모(루트 구역)에 붙여 트리가 4단(프로젝트>도면>구역>영역)을 넘지 않게 한다.
          body: JSON.stringify(plan.depId
            ? { name, page: 1, crop: null, deployment_id: plan.depId, level_no: src.level_no != null ? src.level_no : null, parent_id: src.parent_id || src.id }
            : { name, page, crop, deployment_id: src.deployment_id, level_no: src.level_no != null ? src.level_no : null, parent_id: src.parent_id || src.id })
        });
        const d = await r.json();
        if (!r.ok) { Prompt.toast && Prompt.toast((d && d.error) || "영역 추출 실패 — 권한을 확인하세요"); return null; }
        await this.loadDecks();
        const created = (this.decks || []).find((x) => x.id === d.id) || d;
        // 🔴 반복 추출(요구①) — 현재 구역을 새 영역으로 바꾸지 않는다. 원본 도면 화면에 그대로 머물러
        //    곧바로 다음 영역을 긁을 수 있다("복사하듯이"). 새 영역은 목록에서 눌러 들어간다.
        if (plan.depId) {
          // 🔴 핀은 옮기지 않는다(원본 무변경) — 영역 안에 있던 핀 수를 사실대로 알린다(0이면 생략).
          const live = typeof State !== "undefined" && State.autoSaveDepId === src.deployment_id;
          const n = live ? this._pinsInCrop(State.pins, page, crop) : 0;
          Prompt.toast && Prompt.toast("영역 '" + name + "' 생성 — 지정한 부분을 새 페이지로 복사했습니다(확대해도 선명)"
            + (n > 0 ? " · 원본 구역에 있던 핀 " + n + "개는 원본에 그대로 있습니다" : ""), 5200);
        } else {
          Prompt.toast && Prompt.toast("영역 '" + name + "' 생성 — 계속 드래그해 다른 영역도 만들 수 있어요(목록에서 눌러 열기)"
            + (plan.limited ? " · 원본 PDF 가 없어 확대 시 선명도에 한계가 있습니다" : ""), plan.limited ? 5200 : 3600);
        }
        return created;
      } catch (e) {
        Prompt.toast && Prompt.toast(navigator.onLine ? "영역 추출 실패 — 네트워크 오류, 다시 시도해주세요" : "오프라인이라 지금은 영역을 추출할 수 없습니다");
        return null;
      } finally { this._extractingRegion = false; }
    },

    /** [WO 20260928-copy] 영역을 "복사본(새 PDF 배포본)"으로 만들지 "창(crop)"으로 만들지 결정한다.
     *  @returns {Promise<{depId, box}|{mode:"window", limited?}|null>} null = 취소/실패(사유는 이미 표시)
     *  · 원본 있음  → 벡터 복사 → 새 배포본 id
     *  · 원본 없음  → 묻는다: [원본 PDF 올리기](원본 등록 후 복사) / [창 방식](선명도 한계 고지) / 취소
     *  🔴 원본 없이 스냅샷 이미지로 "복사본"을 만드는 경로는 없다(마스터가 거부한 결과). */
    async _planRegionCopy(src, page, crop, name) {
      const canCopy = typeof App !== "undefined" && App._regionSource && App._createRegionCopyDeployment
        && App._attachSourcePdf && App._pickPdfFile && typeof PDF !== "undefined" && PDF.copyRegionToPdf;
      if (!canCopy) return { mode: "window" };   // 복사 모듈이 없는 구버전 번들 — 종전 창 방식
      const say = (m, ms) => { if (Prompt.toast) Prompt.toast(m, ms); };
      const askWindow = async (why) => (await this._confirmLabeled("기존 방식(창)으로 만들까요?",
        why + "\n\n창 방식은 원본 도면을 그대로 들여다보므로 확대하면 선명도에 한계가 있습니다.",
        "창 방식으로 만들기", "취소")) ? { mode: "window", limited: true } : (say("영역 추출을 취소했습니다"), null);

      say("원본 PDF 를 확인하는 중…", 2400);
      const s = (await App._regionSource(src.deployment_id, page)) || { error: "원본 확인 실패" };
      if (s.error) return await askWindow(s.error + " — 선명한 복사본을 만들 수 없습니다.");
      let bytes = s.bytes, expect = s.expect, attach = false;
      if (!bytes) {
        const up = await this._confirmLabeled("원본 PDF 가 없는 도면입니다",
          "이 도면은 원본 PDF 가 없어 확대하면 깨집니다.\n원본 PDF 를 올리면 지정한 부분을 선명한 새 페이지로 복사합니다.",
          "원본 PDF 올리기", "지금은 기존 방식으로");
        if (!up) return await askWindow("원본 PDF 없이 진행합니다.");
        const file = await App._pickPdfFile();
        if (!file) { say("영역 추출을 취소했습니다"); return null; }
        try { bytes = await file.arrayBuffer(); } catch (e) { say("파일을 읽지 못했습니다 — 다시 시도하세요"); return null; }
        const live = typeof State !== "undefined" && State.autoSaveDepId === src.deployment_id;
        expect = App._regionExpect ? App._regionExpect(null, s.snapCount, page, live) : null;
        attach = true;
      }
      let res = null;
      try { res = await PDF.copyRegionToPdf(bytes, page, crop, expect); }
      catch (e) {
        const msg = (e && e.message) || "알 수 없는 오류";
        if (!(e && e.code === "SIZE_MISMATCH")) {
          if (attach) { say("PDF 를 읽지 못했습니다 — " + msg); return null; }
          return await askWindow("원본 PDF 를 읽지 못했습니다(" + msg + ").");
        }
        if (!attach) return await askWindow("원본 PDF 와 화면의 도면이 맞지 않습니다 — " + msg + ".");
        // 사용자가 직접 고른 파일이 화면 도면과 다르다 — 엉뚱한 부분이 복사된다. 알고 진행할 때만 계속.
        const go = await this._confirmLabeled("다른 파일일 수 있습니다",
          msg + "\n화면의 도면과 다른 PDF 를 올리면 엉뚱한 부분이 복사됩니다.", "그래도 이 PDF 로 진행", "취소");
        if (!go) { say("영역 추출을 취소했습니다"); return null; }
        try { res = await PDF.copyRegionToPdf(bytes, page, crop, null); }
        catch (e2) { say("PDF 를 읽지 못했습니다 — " + ((e2 && e2.message) || "")); return null; }
      }
      if (attach) {
        say("원본 PDF 를 도면에 등록하는 중…", 2400);
        if (!(await App._attachSourcePdf(src.deployment_id, bytes))) { say("원본 PDF 등록 실패 — 네트워크를 확인하고 다시 시도하세요"); return null; }
      }
      say("지정한 부분을 새 페이지로 복사하는 중…", 2400);
      const depId = await App._createRegionCopyDeployment(name, res.bytes);
      if (!depId) { say("새 페이지 저장 실패 — 네트워크를 확인하고 다시 시도하세요"); return null; }
      return { depId, box: res.box };
    },

    /** Prompt.confirm 을 버튼 문구만 바꿔 쓴다(닫히면 원래 문구 복원 — 다른 확인창에 새지 않게).
     *  🔴 window.confirm 금지(PWA standalone 에서 무음 false). Prompt.confirm 이 없으면 "아니오". */
    async _confirmLabeled(title, msg, okLabel, cancelLabel) {
      if (typeof Prompt === "undefined" || !Prompt.confirm) return false;
      const p = Prompt.confirm(title, msg);
      const okB = document.getElementById("wm-confirm-ok");
      const noB = document.getElementById("wm-confirm-cancel");
      const prev = [okB ? okB.textContent : null, noB ? noB.textContent : null];
      if (okB && okLabel) okB.textContent = okLabel;
      if (noB && cancelLabel) noB.textContent = cancelLabel;
      try { return !!(await p); }
      finally { if (okB) okB.textContent = prev[0]; if (noB) noB.textContent = prev[1]; }
    },

    /** 영역(crop %) 안에 있는 그 페이지 핀 수 — 알림용 집계만(핀 배열은 읽기만 한다). 순수 함수. */
    _pinsInCrop(pins, page, crop) {
      if (!Array.isArray(pins) || !crop || !(crop.w > 0) || !(crop.h > 0)) return 0;
      const pg = page || 1, x1 = crop.x + crop.w, y1 = crop.y + crop.h;
      return pins.filter((p) => {
        if (!p || (p.page || 1) !== pg) return false;
        const x = Number(p.x), y = Number(p.y);
        return x >= crop.x && x <= x1 && y >= crop.y && y <= y1;
      }).length;
    },

    /** [WO 20260928 → 20260929 이음매 수정] "도면이 화면에 로드돼 있는가" 상태 판정.
     *  🔴 [WO 20260929·마스터 실사고] 원래 조건은 `decks.length === 0`(구역이 아예 없을 때)만
     *  전제해 "이미 다른 구역이 있는 프로젝트에서, 아직 저장 전인 도면을 화면에 띄워 놓고
     *  새 구역을 만들려는" 훨씬 흔한 경우를 놓쳤다 — 이때 도면이 뻔히 로드돼 있는데도
     *  ①이 비활성으로 보이는 실사고가 났다(마스터 스크린샷). 구역 개수는 이 판정과 무관하다:
     *  이미 저장된 도면(currentDeck.deployment_id)은 _chooseDeckSource 의 다른 분기가 처리하므로,
     *  여기는 오직 "화면에 도면이 떠 있는가"(State.fileType)만 보면 된다.
     *  🔴 판정을 한 곳에 모은다 — _chooseDeckSource(활성 조건)와 extractRegionAsDeck(위임 조건)이
     *  같은 사실을 각자 계산하면 반드시 갈라진다(§SoT). */
    _canExtractFromLoadedDrawing() {
      return !!(this.currentProject
        && typeof State !== "undefined" && !!State.fileType);
    },

    /** [WO 20260928·마스터 확정 → WO 20260928-unify 갱신] 🔴 "도면 있음 + 구역 0" 에서
     *  **첫 영역 지정 = 첫 구역 생성**.
     *  마스터 원문: "처음 도면을 등록했을 때는 구역 이름을 지정하게 하지 마. 1.프로젝트 2.구역 3.영역 이니까"
     *            / "구역을 등록할 때 기존 도면에서 영역을 지정할 건지 새로운 도면으로 할 건지 선택하게 해"
     *            / (WO 20260928-unify) "구역은 선택한 만큼을 남기고 나머지를 다 지우든 복사한 후 새로
     *              만들든 쉽게 빠르게해" → 구역(루트)도 영역과 **같은 벡터복사** 결과물이어야 한다.
     *
     *  도면 등록 단계에서는 어떤 행도 만들지 않으므로(20_App._afterDrawingLoaded), 이 함수가
     *  **배포본(deployments) + 구역(decks, parent_id=NULL)** 을 한 번에 묶어 확정한다.
     *  🔴 새 메커니즘 0 — 배포본은 App._ensureDrawingDeployment()(=기존 _createInitialSave),
     *  드래그는 기존 _pickDeckCrop(), **복사 계획은 extractRegionAsDeck 과 똑같이 _planRegionCopy()
     *  를 재사용**한다(복사 로직 두 벌 금지 — §SoT). 차이는 parent_id=null(루트) 뿐이다.
     *  extractRegionAsDeck() 자체를 통째로 재사용할 수 없는 이유는 그대로다: 그쪽은
     *  src.deployment_id(=**이미 저장된** 도면)를 전제하는데, 여기서는 그 배포본이 아직 없다
     *  (그래서 ①에서 먼저 확정한다).
     *
     *  순서(원자성): 영역·이름을 **먼저** 받는다 → 취소하면 서버에 아무것도 만들어지지 않는다.
     *  배포본까지 만들고 구역 INSERT 가 실패하면 State.autoSaveDepId 가 남아 재시도 시 **같은 배포본**을
     *  재사용하므로 고아 배포본이 누적되지 않는다.
     *
     *  좌표계: crop 은 _pickDeckCrop → MapCtrl.viewportToPercent 로 얻은 **페이지 기준 %** 다.
     *  _planRegionCopy 가 원본이 있으면 그 %를 PDF 상자로 바꿔 벡터 복사(crop:null 결과)하고,
     *  원본이 없는 구버전 도면이면 종전처럼 crop 이 그대로 저장된다(창 방식 — 원본 없음 분기와 동일 규칙).
     *  @param {object} [opts] { crop, name } — 선주입(미지정 시 드래그·프롬프트로 물음)
     *  @returns {Promise<object|null>} 생성된 구역(deck) 또는 null(취소/실패)
     */
    async createDeckFromLoadedDrawing(opts) {
      opts = opts || {};
      if (typeof Auth !== "undefined" && !Auth.isDesigner) { Prompt.toast && Prompt.toast("설계자만 구역을 만들 수 있습니다"); return null; }
      if (!this.currentProject) { Prompt.toast && Prompt.toast("먼저 프로젝트를 선택하세요"); return null; }
      if (typeof State === "undefined" || !State.fileType) { Prompt.toast && Prompt.toast("먼저 도면을 등록하세요 — 그 도면에서 영역을 지정해 구역을 만듭니다"); return null; }
      // 🔴 조용한 실패 금지 — 드래그 UI 를 띄우기 전에 끊는다(extractRegionAsDeck 과 같은 규칙).
      if (!navigator.onLine) { Prompt.toast && Prompt.toast("오프라인이라 지금은 구역을 만들 수 없습니다 — 연결 후 다시 시도하세요"); return null; }
      if (this._extractingRegion) return null;   // 연타 가드(extractRegionAsDeck 와 같은 플래그 — 동시 진행 금지)

      const crop = opts.crop || await this._pickDeckCrop("이 도면에서 구역이 될 영역을 드래그하세요 — Esc 를 누르면 취소됩니다");
      if (!crop || !(crop.w > 0) || !(crop.h > 0)) { Prompt.toast && Prompt.toast("구역 생성을 취소했습니다"); return null; }

      // 이름은 **영역을 지정한 뒤에** 묻는다(요구2) — 도면 등록 단계에서는 절대 묻지 않는다(요구1).
      let name = opts.name;
      if (name == null) {
        const res = await Prompt.ask({
          title: "구역 이름",
          sub: "지정한 영역을 어떤 구역으로 저장할까요? (나중에 바꿀 수 있습니다)",
          placeholder: "예: Main Deck, Engine Room, No.1 Hold",
          value: this._nextFreeName("구역")
        });
        if (!res) { Prompt.toast && Prompt.toast("구역 생성을 취소했습니다"); return null; }
        name = res.value;
      }
      name = String(name || "").trim() || this._nextFreeName("구역");
      const dup = (this.decks || []).find((x) => String(x.name).trim().toLowerCase() === name.toLowerCase());
      if (dup) { Prompt.toast && Prompt.toast("이미 '" + name + "' 구역이 있습니다 — 다른 이름을 쓰세요"); return null; }

      const page = (typeof State !== "undefined" && State.pdfPage) || 1;   // 지금 보고 있는 페이지(1-base)
      this._extractingRegion = true;
      try {
        // ① 로드된 도면을 서버 배포본으로 확정(이미 있으면 그걸 재사용 — 중복 배포본 0)
        const depId = (typeof App !== "undefined" && App._ensureDrawingDeployment)
          ? await App._ensureDrawingDeployment() : null;
        if (!depId) { Prompt.toast && Prompt.toast("도면 저장에 실패해 구역을 만들지 못했습니다 — 네트워크를 확인하고 다시 시도하세요"); return null; }
        // ② 🔴 공유 지점(§G-2-5) — extractRegionAsDeck 과 **같은** 벡터복사 계획 함수(_planRegionCopy).
        //   차이는 parent_id=null(루트) 뿐 — 원본이 있으면 벡터 복사(crop:null), 없으면 종전 창 방식으로
        //   묻는 분기까지 그대로 공유한다(복사 로직 두 벌 금지).
        const plan = await this._planRegionCopy({ deployment_id: depId }, page, crop, name);
        if (!plan) return null;   // 취소/실패 — 사유는 _planRegionCopy 가 이미 화면에 알렸다
        // ③ 구역(루트) INSERT — 프로젝트 > 구역 > 영역 에서 이 구역은 최상위라 parent_id = NULL.
        const r = await fetch("/api/projects/" + this.currentProject.id + "/decks", {
          method: "POST", headers: Auth.headers(),
          // 복사본: 새 배포본(그 페이지 자체가 구역) · 창 방식(원본 없는 구버전 도면): 로드된 도면 + crop.
          body: JSON.stringify(plan.depId
            ? { name, page: 1, crop: null, deployment_id: plan.depId, parent_id: null }
            : { name, page, crop, deployment_id: depId, parent_id: null })
        });
        const d = await r.json();
        if (!r.ok) { Prompt.toast && Prompt.toast((d && d.error) || "구역 생성 실패 — 권한을 확인하세요"); return null; }
        await this.loadDecks();
        const created = (this.decks || []).find((x) => x.id === d.id) || d;
        // ④ 이 구역을 현재 컨텍스트로 — 이후 저장/배포/핀이 이 구역에 붙는다(고아 배포본 방지).
        this.currentDeck = created;
        if (typeof App !== "undefined") App._pendingDeckLink = null;   // 배포본은 이미 구역에 직결됨
        this._renderDecks();
        // 🔴 마스터 확정: "바운더리를 선택하면 그 바운더리를 잘라서 별도의 페이지로 구성" →
        //   생성 직후 그 구역을 **독립 페이지처럼** 연다(공유 지점 _applyDeckCropView — selectDeck 과 동일).
        //   이 상태에서 다시 드래그하면 이 구역 하위의 '영역'이 된다(계층 3단: 프로젝트>구역>영역).
        this._applyDeckCropView(created);
        Prompt.toast && Prompt.toast((plan.depId
          ? "구역 '" + name + "' 생성 — 지정한 부분을 새 페이지로 복사했습니다(확대해도 선명)"
          : "구역 '" + name + "' 생성 — 잘라낸 영역이 별도 페이지로 열렸습니다")
          + (plan.limited ? " · 원본 PDF 가 없어 확대 시 선명도에 한계가 있습니다" : "")
          + ". 다시 드래그하면 이 구역 안의 '영역'이 됩니다", plan.limited ? 5200 : 4200);
        return created;
      } catch (e) {
        Prompt.toast && Prompt.toast(navigator.onLine ? "구역 생성 실패 — 네트워크 오류, 다시 시도해주세요" : "오프라인이라 지금은 구역을 만들 수 없습니다");
        return null;
      } finally { this._extractingRegion = false; }
    },

    /** 자동 제안 이름 — "<base> N". 이미 쓰는 이름이면 N 을 올려 항상 비어 있는 이름을 준다.
     *  🔴 **제안값일 뿐 확정이 아니다** — 호출부는 반드시 사용자에게 물어 고칠 기회를 준다
     *  (도면 등록만으로 이름이 자동 확정되는 옛 동작은 금지 — 마스터 확정 WO 20260928). */
    _nextFreeName(base) {
      base = String(base || "구역").trim();
      const taken = new Set((this.decks || []).map((x) => String(x.name).trim().toLowerCase()));
      let n = 1;
      while (taken.has((base + " " + n).toLowerCase())) n++;
      return base + " " + n;
    },

    /** 추출 영역의 기본 이름 — "<원본이름> 영역 N". (구현 SoT = _nextFreeName) */
    _nextRegionName(srcName) {
      return this._nextFreeName(String(srcName || "도면").trim() + " 영역");
    },

    async deleteDeck(id, name) {
      if (!await Prompt.confirm("구역 삭제", `구역 '${name}' 를 삭제할까요?`)) return;
      try {
        await fetch("/api/decks/" + id, { method: "DELETE", headers: Auth.headers() });
        if (this.currentDeck && this.currentDeck.id === id) this.currentDeck = null;
        await this.loadDecks();
      } catch (e) {}
    },

    /** 구역 선택 — 해당 구역에 연결된 도면(배포 스냅샷)이 있으면 불러옴 */
    async selectDeck(d) {
      this.currentDeck = d;
      this._renderDecks();
      Prompt.toast && Prompt.toast("구역 '" + d.name + "' 선택됨 — 도면을 등록하거나 포인트를 추가하세요");
      // 연결된 도면이 있으면 로드, 없으면(끊김/미연결) 도면 연결 선택 띄움(디자이너)
      if (d.deployment_id && typeof App !== "undefined" && App.loadDeckDrawing) {
        await App.loadDeckDrawing(d.deployment_id);
        // [WO 20260916] 구역=도면의 한 조각 — page 로 전환 + crop 있으면 그 부분만 확대(재사용: fitZone).
        // 구버전 구역(page/crop 없음)은 이 분기가 그냥 건너뛰어져 종전대로 동작.
        if (d.page && typeof App._gotoPage === "function") { try { await App._gotoPage(d.page); } catch (e) {} }
        this._applyDeckCropView(d);
      } else if (!d.deployment_id && typeof State !== "undefined" && State.mode === "designer" && typeof App !== "undefined" && App.offerDeckDrawingLink) {
        App.offerDeckDrawingLink(d);
      }
    },

    /** 🔴 [WO 20260928] "바운더리를 잘라서 별도의 페이지로 구성" (마스터 확정) —
     *  구역(crop 보유)을 **독립 페이지처럼** 화면에 적용한다: 크롭 렌더 대상 고정 + 그 영역으로 화면 맞춤.
     *  🔴 비파괴 — 원본 PDF/배포본은 그대로고, 이건 원본을 들여다보는 **창(view)** 이다(픽셀 재저장 0).
     *  🔴 공유 지점(§G-2-5): selectDeck(트리에서 열기)과 createDeckFromLoadedDrawing(첫 구역 생성 직후)이
     *  같은 3줄을 각자 들고 있으면 반드시 갈라진다 → 여기 한 곳에서만 한다.
     *  crop 없는 구버전 구역은 null 로 해제해 종전대로 전체 페이지 렌더(회귀 0). */
    _applyDeckCropView(d) {
      try { document.body.classList.toggle("deck-view-active", !!(d && d.crop)); } catch (e) {}
      const crop = (d && d.crop) || null;
      if (typeof PDF !== "undefined" && PDF.setDeckCrop) PDF.setDeckCrop(crop);
      if (crop && typeof MapCtrl !== "undefined" && MapCtrl.fitZone) MapCtrl.fitZone(crop, 0.14, 640);
      // 🔴 [WO 20260928-copy → WO 20260928-unify 갱신] 벡터 복사본(crop 없음)은 그 배포본의 페이지
      //   자체가 이 구역/영역이다 → 열면 페이지 전체를 화면에 맞춘다("크게"). 도면 로드(_showMapViewport)가
      //   이미지 load 때 zoom=1 로 되돌리므로 그 **뒤**에 맞춘다(load 리스너는 onload 속성 핸들러 다음에
      //   불린다 + 한 프레임 뒤). 🔴 parent_id 로 가르지 않는다(SoT) — 구역(루트)도 영역과 같은 벡터복사
      //   경로를 쓰게 되면서(createDeckFromLoadedDrawing) crop 없음이 곧 "복사본"이라는 사실이 계층과
      //   무관해졌다. crop 이 있는 구버전 창 방식 구역/영역만 위 fitZone 분기로 남는다.
      else if (!crop && d && typeof MapCtrl !== "undefined" && MapCtrl.fit) {
        const img = document.getElementById("map-image");
        const go = () => { const f = () => MapCtrl.fit(); if (typeof requestAnimationFrame === "function") requestAnimationFrame(f); else f(); };
        if (img && img.complete && img.naturalWidth) go();
        else if (img && img.addEventListener) img.addEventListener("load", go, { once: true });
      }
    },

    _renderDecks() {
      const listEl = document.getElementById("decks-list");
      const emptyEl = document.getElementById("decks-empty");
      // [마스터 규칙] 구역 유무에 따라 도면 업로드 버튼 잠금/해제 (구역 선행 등록 시각화)
      this._syncUploadLock();
      if (!listEl) return;
      listEl.innerHTML = "";
      if (!this.decks.length) {
        // ── [결함수정] #decks-empty 는 side-tree 일원화(2b9b677)로 CSS에서 영구 숨김이다.
        //    과거엔 여기서 return 해버려 UI.renderTree() 호출까지 건너뛰어 #side-tree 가
        //    갱신되지 않았다(= 구역 0개일 때 사이드바가 통째로 비어 보이는 조용한 실패).
        //    #decks-empty 를 되살리지 않고, #side-tree 안에서 직접 실제 안내를 그린다. ──
        if (emptyEl) emptyEl.classList.add("hidden");
        this._renderSideTreeEmpty();
        return;
      }
      if (emptyEl) emptyEl.classList.add("hidden");
      this.decks.forEach((d) => {
        const isActive = this.currentDeck && this.currentDeck.id === d.id;
        const row = document.createElement("div");
        row.className = "deck-row" + (isActive ? " active" : "");
        const hasDoc = !!d.deployment_id;
        // 트리 가이드(└) + 구역 아이콘 + 도면 등록 여부
        // [WO 20260918-B] 도면에서 긁어낸 영역(crop 보유)은 목록에서 한눈에 구분되어야 한다(요구④).
        //   새 CSS 없이 기존 .deck-hasdoc 스타일을 그대로 쓰고 아이콘/툴팁만 바꾼다.
        const isRegion = !!(d.crop && d.crop.w > 0 && d.crop.h > 0);
        const dot = isRegion
          ? '<span class="deck-hasdoc" title="도면에서 긁어낸 영역 — 원본 도면은 그대로입니다"><i class="fa-solid fa-crop-simple"></i></span>'
          : hasDoc
          ? '<span class="deck-hasdoc" title="도면 등록됨"><i class="fa-solid fa-file-lines"></i></span>'
          : '<span class="deck-nodoc" title="도면 미등록"><i class="fa-regular fa-folder-open"></i></span>';
        // [B4] 로컬에만 있고 서버 미저장 → '미저장' 배지('도면없음'과 구분)
        const unsaved = (typeof App !== "undefined" && App.isDeckUnsaved) ? App.isDeckUnsaved(d.id) : false;
        const uTag = unsaved ? '<span class="deck-unsaved-tag" title="로컬에만 있음 — ‘저장’을 눌러 서버에 반영하세요">미저장</span>' : "";
        row.innerHTML = `<span class="deck-tree-guide">└</span><span class="deck-name">${dot}${this._esc(d.name)}${uTag}</span>
          <button class="deck-del" title="삭제"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>`;
        row.querySelector(".deck-name").addEventListener("click", () => this.selectDeck(d));
        row.querySelector(".deck-del").addEventListener("click", (e) => { e.stopPropagation(); this.deleteDeck(d.id, d.name); });
        listEl.appendChild(row);
        // ── 선택된 구역: 등록된 도면을 트리 하위로 표시(없으면 '도면 등록 필요') ──
        if (isActive) {
          const sub = document.createElement("div");
          sub.className = "deck-doc-sub";
          if (hasDoc) {
            const fname = (typeof State !== "undefined" && State.fileName) ? State.fileName : "등록 도면";
            sub.innerHTML = `<span class="deck-doc-line"><span class="deck-tree-guide sub">└─</span><i class="fa-solid fa-image"></i> ${this._esc(fname)}</span>`;
          } else {
            sub.innerHTML = `<span class="deck-doc-line empty"><span class="deck-tree-guide sub">└─</span>도면을 등록하세요 (아래 버튼)</span>`;
          }
          listEl.appendChild(sub);
        }
      });
      if (typeof UI !== "undefined" && UI.renderTree) UI.renderTree();
    },

    /** [결함수정] 구역 0개일 때 #side-tree 안에 직접 그리는 빈 상태 안내.
     *  UI.renderTree()(11_UI.js — 다른 에이전트 작업 중이라 수정 금지)도 구역 0개면 같은
     *  자리에 안내 텍스트만 그리지만 실제 생성 버튼이 없다. 여기서는 프로젝트가 선택된
     *  경우에만(=진짜 "구역 0개") 실제 생성 버튼이 있는 안내를 그리고, 프로젝트 미선택
     *  상태에서는 잘못된 안내를 띄우지 않도록 비워둔다.
     *  ponytail: 이후 다른 코드가 UI.renderTree()를 독립 호출하면(16_Zones.js 등) 이 안내가
     *  버튼 없는 텍스트로 되돌아갈 수 있다 — 실전에서는 구역이 0개일 때 존재할 수 없는
     *  zone/pin 갱신 경로라 발생 가능성이 낮지만, 근본 해결은 11_UI.js 쪽 수정이 필요하다. */
    _renderSideTreeEmpty() {
      const host = document.getElementById("side-tree");
      if (!host) return;
      if (!this.currentProject) { host.innerHTML = ""; return; } // 프로젝트 미선택 — 안내 없음
      // ── 🔴 [WO 20260928] "도면 있음 + 구역 0" 은 이제 **정상 상태**다(도면 등록이 구역을 만들지 않음).
      //   이 상태에서 "구역이 없습니다 → 구역을 만들면 도면을 등록할 수 있습니다" 를 그대로 보여주면
      //   이미 도면을 올린 사용자에게 **거짓 안내**가 된다(빈 화면과 같은 급의 조용한 실패).
      //   → 분기해서 다음 행동(영역 지정)을 정확히 알린다. CTA 는 기존 경로(extractRegionAsDeck)로만 간다.
      if (typeof State !== "undefined" && State.fileType) {
        host.innerHTML =
          '<div class="side-tree-empty">' +
            '<p class="side-tree-empty-msg">도면이 등록됐습니다.<br>도면에서 <b>영역을 지정</b>해 구역을 만드세요.</p>' +
            '<button type="button" class="side-tree-empty-cta" id="side-tree-make-deck-region">+ 영역 지정해 구역 만들기</button>' +
          '</div>';
        const rb = document.getElementById("side-tree-make-deck-region");
        // extractRegionAsDeck() 이 "구역 0 + 도면 로드" 를 감지해 createDeckFromLoadedDrawing 으로 위임한다.
        if (rb) rb.addEventListener("click", () => this.extractRegionAsDeck());
        return;
      }
      host.innerHTML =
        '<div class="side-tree-empty">' +
          // [WO 20260928] 옛 문구("구역을 만들면 도면을 등록할 수 있습니다")는 이제 사실이 아니다 —
          // 도면 등록은 구역을 전제하지 않는다. 실제 순서를 그대로 말한다.
          '<p class="side-tree-empty-msg">이 프로젝트에 구역이 없습니다.<br>도면을 등록한 뒤, 도면에서 <b>영역을 지정</b>하면 구역이 만들어집니다.</p>' +
          '<button type="button" class="side-tree-empty-cta" id="side-tree-create-deck">+ 구역 생성</button>' +
        '</div>';
      const btn = document.getElementById("side-tree-create-deck");
      if (btn) btn.addEventListener("click", () => this.createDeck());
    },

    /** [WO 20260928] 🔴 옛 '구역 선행 강제' 게이트의 **시각적 절반**이었다 — 구역이 0개면 업로드
     *  버튼을 "먼저 구역을 등록하세요" 로 바꿔 잠갔다. 도면 등록은 이제 구역을 전제하지 않으므로
     *  잠금을 없애고(항상 해제), 힌트로 다음 행동만 알린다(조용한 차단·빈 화면 금지).
     *  🔴 함수를 지우지 않는 이유: _renderDecks() 가 부르는 유일한 '업로드 버튼 상태 동기화' 지점이라,
     *  잠금을 지우고도 origText 원복·힌트 갱신은 계속 필요하다(호출부 분열 금지). */
    _syncUploadLock() {
      const btn = document.getElementById("btn-upload-drawing");
      const hint = document.getElementById("upload-zone-hint");
      if (btn) {
        btn.classList.remove("upload-locked");
        btn.setAttribute("aria-disabled", "false");
        if (btn.dataset.origText) btn.textContent = btn.dataset.origText;
      }
      if (hint) {
        hint.textContent = (this.decks || []).length > 0
          ? "구역을 선택하면 해당 구역에 도면이 등록·자동저장됩니다."
          : "도면을 등록한 뒤, 그 도면에서 영역을 지정하면 구역이 만들어집니다.";
      }
    },

    _esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
  };

  /* ══════════════════════════════════════════════════════════════════
     OFFLINE  — 오프라인 완전작업 (다운로드 → 오프라인편집 → 자동싱크 · 충돌0)
     작업지시서 SEASTAR_OFFLINE_WORKORDER 
     실식별자 보정: State.depId → State.autoSaveDepId, Auth.currentUser → Auth.user
     IndexedDB 키(SyncQueue.DRAFT_STORE, keyPath="key"):
       bundle:manifest:<projectId> / bundle:project:<projectId> / bundle:decks:<projectId>
       bundle:dep:<deploymentId>  / bundle:pano:<imageId>      / oplog:<deploymentId>
  ══════════════════════════════════════════════════════════════════ */

  // 현재 열려있는 배포본 id (작업지시서의 State.depId 대응)
  function _curDepId() {
    if (typeof State !== "undefined" && State.autoSaveDepId) return State.autoSaveDepId;
    if (typeof Projects !== "undefined" && Projects.currentDeck && Projects.currentDeck.deployment_id)
      return Projects.currentDeck.deployment_id;
    return null;
  }
  function _authHeaders() {
    return (typeof Auth !== "undefined" && Auth.headers) ? Auth.headers() : {};
  }
  function _toast(msg) {
    if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast(msg);
  }

  /* ── 온라인: 프로젝트 전체 번들 다운로드 ─────────────────────────── */
  const OfflineBundle = {
    /** 프로젝트 전체를 오프라인용으로 다운로드. onProgress(done,total,label) 콜백. */
    async download(projectId, onProgress) {
      if (!navigator.onLine) throw new Error("온라인 상태에서만 다운로드할 수 있습니다.");
      const H = _authHeaders();
      // [마스터 요건5 근본원인 대응 2026-09-18] IndexedDB 는 브라우저가 저장공간
      // 압박 시 조용히 축출(evict)할 수 있다 — persist()로 축출 대상에서 제외 요청.
      // 실패해도 무시(모든 브라우저가 지원하지 않음 — 다운로드를 막지 않는다).
      try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) {}

      // [마스터 요건5 근본원인 수정] saveDraft() 는 실패(IDB 에러/localStorage 용량초과)해도
      // 조용히 false 를 반환할 뿐 throw 하지 않는다 — 기존 코드는 반환값을 확인하지 않아
      // "다운로드 완료" 토스트가 뜨지만 실제로는 일부 데이터가 저장되지 않는 조용한 실패가
      // 가능했다(재현: 마스터 기기에서 다운로드했는데 새로고침/재방문 후 "저장됨"이 안 보임).
      // → 저장 실패 시 즉시 throw 해 사용자에게 정직하게 "실패"로 보이게 한다.
      const saveOrThrow = async (key, data) => {
        const ok = await SyncQueue.saveDraft(key, data);
        if (!ok) throw new Error("로컬 저장 실패(기기 저장공간 부족) — " + key);
        return ok;
      };

      // 1) 프로젝트 메타
      const proj = await (await fetch("/api/projects", { headers: H })).json();
      const project = (proj.data || []).find((p) => p.id === projectId);
      if (!project) throw new Error("프로젝트를 찾을 수 없습니다.");
      await saveOrThrow("bundle:project:" + projectId, project);

      // 2) 데크 목록
      const decksRes = await (await fetch("/api/projects/" + projectId + "/decks", { headers: H })).json();
      const decks = decksRes.data || [];
      await saveOrThrow("bundle:decks:" + projectId, decks);

      // 3) 데크가 가리키는 배포본 id 수집(중복 제거)
      const depIds = Array.from(new Set(decks.map((d) => d.deployment_id).filter(Boolean)));
      const total = depIds.length;
      let done = 0;
      const panoIds = new Set();

      // 4) 각 배포본 + 그 안의 파노 imageId 수집
      for (const depId of depIds) {
        const dep = await (await fetch("/tables/deployments/" + depId, { headers: H })).json();
        await saveOrThrow("bundle:dep:" + depId, dep);
        let pins = []; try { pins = JSON.parse(dep.pins || "[]"); } catch (e) {}
        pins.forEach((p) => { if (p && p.imageId) panoIds.add(p.imageId); });
        done++; onProgress && onProgress(done, total, "도면 " + (dep.title || depId));
      }

      // 5) 파노 360 이미지 전부 다운로드 → IndexedDB + 메모리 캐시
      const panoArr = Array.from(panoIds);
      for (let i = 0; i < panoArr.length; i++) {
        const imgId = panoArr[i];
        const rec = await (await fetch("/tables/pano_images/" + imgId, { headers: H })).json();
        if (rec && rec.image_data) {
          await saveOrThrow("bundle:pano:" + imgId, rec.image_data);
          if (typeof Cloud !== "undefined") { Cloud._cache = Cloud._cache || {}; Cloud._cache[imgId] = rec.image_data; }
        }
        onProgress && onProgress(total + i + 1, total + panoArr.length, "3D 비워 " + (i + 1) + "/" + panoArr.length);
      }

      // 6) 매니페스트 기록(무결성 검증용) — 위 저장이 전부 성공했을 때만 여기 도달
      const manifest = {
        projectId, downloadedAt: Date.now(),
        decks: decks.length, deployments: depIds.length, panos: panoArr.length,
        depIds, panoIds: panoArr
      };
      await saveOrThrow("bundle:manifest:" + projectId, manifest);
      return manifest;
    },

    /** [마스터 요청 2026-09-18] "다운받은 상태"인지 여부(가벼운 체크 — 매니페스트 존재만).
     *  offline 배지가 "오프라인 모드"(번들 있음) / "작업 불가"(번들 없음)를 가르는 데 쓴다.
     *  verify()보다 훨씬 가볍다(각 dep/pano 개별 조회 없이 매니페스트 존재만 확인). */
    async hasManifest(projectId) {
      if (!projectId) return false;
      try { return !!(await SyncQueue.loadDraft("bundle:manifest:" + projectId)); }
      catch (e) { return false; }
    },

    /* ── 번들 무결성 검증 ── */
    async verify(projectId) {
      const m = await SyncQueue.loadDraft("bundle:manifest:" + projectId);
      if (!m) return { ok: false, reason: "매니페스트 없음 — 다운로드 안 됨" };
      const missing = [];
      for (const depId of (m.depIds || []))
        if (!(await SyncQueue.loadDraft("bundle:dep:" + depId))) missing.push("dep:" + depId);
      for (const imgId of (m.panoIds || []))
        if (!(await SyncQueue.loadDraft("bundle:pano:" + imgId))) missing.push("pano:" + imgId);
      return { ok: missing.length === 0, missing, downloadedAt: m.downloadedAt };
    }
  };

  /* ── 오프라인 부팅 — IndexedDB에서 계층 복원 ─────────────────────── */
  const OfflineLoad = {
    async projects() { // 프로젝트 목록(오프라인)
      const keys = await SyncQueue.allDraftKeys();
      const out = [];
      for (const k of keys) if (String(k).startsWith("bundle:project:")) out.push(await SyncQueue.loadDraft(k));
      return out;
    },
    async decks(projectId) {
      return (await SyncQueue.loadDraft("bundle:decks:" + projectId)) || [];
    },
    async deployment(depId) {
      return await SyncQueue.loadDraft("bundle:dep:" + depId);
    },
    async pano(imageId) {
      if (typeof Cloud !== "undefined" && Cloud._cache && Cloud._cache[imageId]) return Cloud._cache[imageId];
      const d = await SyncQueue.loadDraft("bundle:pano:" + imageId);
      if (d && typeof Cloud !== "undefined") { Cloud._cache = Cloud._cache || {}; Cloud._cache[imageId] = d; }
      return d;
    }
  };

  /* ── 오프라인 3D 비워 소스 결정 ── */
  async function resolvePanoSource(pin) {
    if (!pin) return null;
    if (pin.imageId) {
      const d = await OfflineLoad.pano(pin.imageId);     // 캐시/IndexedDB 우선
      if (d) return d;
    }
    if (navigator.onLine && pin.imageId && typeof Cloud !== "undefined" && Cloud.fetchImage) {
      try { return await Cloud.fetchImage(pin.imageId); } catch (e) {}
    }
    return null; // 표시 불가
  }

  /* ── 오프라인 편집 → op 로그(충돌없는 핵심) ──────────────────────── */
  const OpLog = {
    _key(depId) { return "oplog:" + depId; },
    async _load(depId) { return (await SyncQueue.loadDraft(this._key(depId))) || []; },
    async _save(depId, arr) {
      await SyncQueue.saveDraft(this._key(depId), arr);
      if (SyncQueue._emit) SyncQueue._emit();
    },
    _newId() { return "op-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8); },

    /** entity:'pin'|'zone'|'anno', action:'upsert'|'delete' */
    async record(depId, entity, action, id, data) {
      if (!depId || !entity || id == null) return;
      const arr = await this._load(depId);
      arr.push({
        opId: this._newId(),
        entity, action, id,
        data: action === "delete" ? null : data,
        ts: Date.now(),
        author: (typeof Auth !== "undefined" && Auth.user && Auth.user.email) || "offline"
      });
      await this._save(depId, arr);
    },
    // 현재 열린 배포본 기준 간편 기록
    async recordCurrent(entity, action, id, data) {
      const depId = _curDepId();
      if (depId) await this.record(depId, entity, action, id, data);
    },
    async pending(depId) { return await this._load(depId); },
    async clearApplied(depId, appliedOpIds) {
      const set = new Set(appliedOpIds || []);
      const arr = (await this._load(depId)).filter((o) => !set.has(o.opId));
      await this._save(depId, arr);
    }
  };

  /** 편집 후 로컬 스냅샷(draft)도 갱신 — 새로고침 대비 */
  async function persistLocalDeployment(depId) {
    if (!depId) depId = _curDepId();
    if (!depId) return;
    const dep = (await SyncQueue.loadDraft("bundle:dep:" + depId)) || { id: depId };
    dep.pins = JSON.stringify(State.pins || []);
    dep.zones = JSON.stringify(State.zones || []);
    dep.annotations = JSON.stringify(State.annotations || []);
    await SyncQueue.saveDraft("bundle:dep:" + depId, dep);
  }

  /* ── 온라인 복귀 자동 싱크 (op 로그 replay) ─────────────────────── */
  // 지수 백오프 POST (항구 약전파 대비)
  async function _postWithRetry(url, body, max) {
    max = max || 3;
    for (let i = 0; i < max; i++) {
      try {
        const r = await fetch(url, { method: "POST", headers: _authHeaders(), body: JSON.stringify(body) });
        if (r.ok) return r;
        if (r.status < 500) return r; // 4xx는 재시도 무의미
      } catch (e) {}
      await new Promise((s) => setTimeout(s, Math.pow(2, i) * 1000)); // 1s,2s,4s
    }
    return null;
  }

  // App 에 op 플러시 메서드 부착 (_onReconnect 에서 호출)
  if (typeof App !== "undefined") {
    App._flushOpLogs = async function () {
      if (!navigator.onLine) return;
      const keys = await SyncQueue.allDraftKeys();
      const opKeys = keys.filter((k) => String(k).startsWith("oplog:"));
      for (const k of opKeys) {
        const depId = String(k).slice("oplog:".length);
        const ops = await OpLog.pending(depId);
        if (!ops.length) continue;
        try {
          const res = await _postWithRetry(
            "/tables/deployments/" + encodeURIComponent(depId) + "/ops",
            { base_version: null, ops }
          );
          if (res && res.ok) {
            const j = await res.json();
            await OpLog.clearApplied(depId, j.applied || ops.map((o) => o.opId));
            // [오프라인 노트] 임시id → 서버 실제id 치환(화면의 노트 참조 유지, 핀 pendingOpId 와 같은 목적)
            if (j.noteIdMap && typeof Notes !== "undefined" && Notes.applyIdMap) {
              try { Notes.applyIdMap(j.noteIdMap); } catch (e) {}
            }
            // 서버 최신본을 로컬 번들에 반영(타 작업자 변경 흡수)
            if (j.current) await SyncQueue.saveDraft("bundle:dep:" + depId, j.current);
            // 현재 열려있는 도면이면 화면 갱신(tombstone 제외)
            if (_curDepId() === depId && j.current) {
              try {
                const live = (arr) => (Array.isArray(arr) ? arr.filter((o) => !(o && o._deleted)) : arr);
                State.pins = live(JSON.parse(j.current.pins || "[]"));
                State.zones = live(JSON.parse(j.current.zones || "[]"));
                State.annotations = live(JSON.parse(j.current.annotations || "[]"));
                State.depVersion = Number(j.current.version) || 0;
                if (typeof UI !== "undefined") { UI.renderPinList(); UI.renderPinsOnMap(); }
                if (typeof Zones !== "undefined" && Zones.render) { Zones.render(); Zones.renderList && Zones.renderList(); }
              } catch (e) {}
            }
          }
        } catch (e) { /* 재단절 → 다음 online 때 op 유지하여 재시도 */ }
      }
    };
  }

  /* ── 오프라인 상태 UI (배지 + 대기 카운트) ──────────────────────── */
  async function updateNetBadge() {
    const badge = document.getElementById("net-badge");
    if (!badge) return;
    const text = document.getElementById("net-text");
    const q = document.getElementById("net-q");
    let pending = 0;
    const depId = _curDepId();
    if (depId) { try { pending = (await OpLog.pending(depId)).length; } catch (e) {} }
    try { pending += await SyncQueue.count(); } catch (e) {}
    // [P16] 토큰 만료로 업로드가 막힌 상태를 "동기화 중"과 구분해 정직하게 표시.
    //   온라인이어도 인증이 만료됐으면 실제로는 못 올라가는 중이므로 최우선으로 판정.
    if (typeof Auth !== "undefined" && Auth._expired) {
      badge.classList.add("show", "syncing");
      if (text) text.textContent = "인증 필요"; if (q) q.textContent = pending;
    } else if (!navigator.onLine) {
      badge.classList.add("show"); badge.classList.remove("syncing");
      if (text) text.textContent = "오프라인"; if (q) q.textContent = pending;
    } else if (pending > 0) {
      badge.classList.add("show", "syncing");
      if (text) text.textContent = "동기화 중"; if (q) q.textContent = pending;
    } else {
      badge.classList.remove("show", "syncing");
    }
  }

  // 네트워크 이벤트 + 주기 갱신 연결 (DOM 준비 후 init 에서 한 번 더 호출)
  const Offline = {
    Bundle: OfflineBundle,
    Load: OfflineLoad,
    OpLog: OpLog,
    resolvePanoSource: resolvePanoSource,
    persistLocalDeployment: persistLocalDeployment,
    updateNetBadge: updateNetBadge,
    curDepId: _curDepId,
    init() {
      try {
        window.addEventListener("online", updateNetBadge);
        window.addEventListener("offline", updateNetBadge);
        if (typeof SyncQueue !== "undefined" && SyncQueue.onChange) SyncQueue.onChange(() => updateNetBadge());
        setInterval(updateNetBadge, 3000);
        updateNetBadge();
      } catch (e) {}
    }
  };

  /* ══════════════════════════════════════════════════════════════
     THETA 360 인입 — 오프라인 R* 360 사진을 가져와 도면에 핀 위치 지정 등록
     ────────────────────────────────────────────────────────────────
     · 마스터 요청: THETA 앱이 폰에 저장한 R*(R00xxxxx.JPG) 360 사진이 "들어오면",
       이 프로젝트 도면 위에 "사진 위치를 등록할 핀을 지정"하는 기능. 오프라인 동작.
     · 흐름: [360 인입] 버튼 → 갤러리에서 R* 360 사진 다중 선택 → R*·2:1 필터 →
       미배치 트레이(IndexedDB 영속) → 사진 탭 → 도면에서 위치 탭 → 그 자리에 360 핀 등록.
       오프라인이면 OpLog/SyncQueue 큐잉 → 온라인 시 "↑ 지금 올리기"로 반영.
     · 통합: 위치 탭은 기존 배치 흐름(App._handlePlaceClick) 재사용. 인입 사진은
       State.intakeFile 로 주입 → 파일 선택 없이 _acceptPinMediaFile 로 360 핀 자동 등록.
  ══════════════════════════════════════════════════════════════ */
  const ThetaIntake = {
    _pending: [],          // [{ id, name, dataURL }]
    _activeId: null,
    _KEY: "theta_intake_v1",

    init() {
      const $ = (id) => document.getElementById(id);
      $("btn-theta-intake") && $("btn-theta-intake").addEventListener("click", () => this.openPicker());
      const inp = $("input-theta-intake");
      if (inp) inp.addEventListener("change", (e) => { const files = Array.from(e.target.files || []); e.target.value = ""; this.importFiles(files); });
      $("theta-tray-close") && $("theta-tray-close").addEventListener("click", () => this.hideTray());
      this._restore();
      // [마스터: 사진 들어오면 트리거] 공유로 들어온 사진 자동 인입(?shared=1)
      try { if (new URLSearchParams(location.search).get("shared") === "1") this.handleShared(); } catch (e) {}
    },

    /** Web Share Target 으로 들어온 사진을 캐시에서 읽어 자동 인입(트리거). */
    async handleShared() {
      // [견고화] ?shared=1 을 URL 에서 제거(항상) → 리로드/controllerchange 시 재실행·재인입 방지.
      try {
        const u = new URL(location.href);
        if (u.searchParams.has("shared")) { u.searchParams.delete("shared"); history.replaceState(null, "", u.pathname + u.search + u.hash); }
      } catch (e) {}
      try {
        if (!("caches" in window)) return;
        const cache = await caches.open("wm-shared");
        const idxRes = await cache.match("/__shared__/index");
        if (!idxRes) return;
        const meta = await idxRes.json();
        const ids = meta.ids || [], names = meta.names || [];
        const files = [];
        for (let i = 0; i < ids.length; i++) {
          const r = await cache.match(ids[i]);
          if (r) { const blob = await r.blob(); files.push(new File([blob], names[i] || ("shared-" + i + ".jpg"), { type: blob.type || "image/jpeg" })); }
        }
        for (const id of ids) { try { await cache.delete(id); } catch (e) {} }
        try { await cache.delete("/__shared__/index"); } catch (e) {}
        if (files.length) {
          await this.importFiles(files, { lenient: true });  // 공유=명시적 의도 → R* 아니어도 360이면 인입
        }
      } catch (e) {}
    },

    openPicker() {
      if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("THETA로 찍은 R* 360 사진을 선택하세요 (여러 장 가능)");
      const inp = document.getElementById("input-theta-intake");
      if (inp) inp.click();
    },

    _isR(name) { return /^r/i.test((name || "").trim()); },

    /** 2:1 equirectangular(THETA 360) 여부 — 실제 픽셀 비율 검사 */
    _is360(file) {
      return new Promise((resolve) => {
        try {
          const url = URL.createObjectURL(file);
          const im = new Image();
          im.onload = () => { const r = im.naturalWidth / Math.max(1, im.naturalHeight); URL.revokeObjectURL(url); resolve(r >= 1.8 && r <= 2.2); };
          im.onerror = () => { URL.revokeObjectURL(url); resolve(false); };
          im.src = url;
        } catch (e) { resolve(false); }
      });
    },

    _toDataURL(file) {
      return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = () => reject(fr.error || new Error("read fail"));
        fr.readAsDataURL(file);
      });
    },

    _dataURLtoFile(dataURL, name) {
      try {
        const arr = String(dataURL).split(",");
        const mime = (arr[0].match(/:(.*?);/) || [])[1] || "image/jpeg";
        const bstr = atob(arr[1]); let n = bstr.length; const u8 = new Uint8Array(n);
        while (n--) u8[n] = bstr.charCodeAt(n);
        return new File([u8], name || "theta_360.jpg", { type: mime });
      } catch (e) { return null; }
    },

    async importFiles(files, opts) {
      if (!files || !files.length) return;
      const lenient = !!(opts && opts.lenient);   // 공유로 들어온 경우: R* 아니어도 360이면 인입
      let accepted = 0, skipped = 0;
      for (const f of files) {
        if (!f.type || !f.type.startsWith("image/")) { skipped++; continue; }
        if (!lenient && !this._isR(f.name)) { skipped++; continue; }     // R* 파일명만 (버튼 인입)
        const ok360 = await this._is360(f);
        if (!ok360) { skipped++; continue; }                 // THETA equirectangular(2:1)만
        try {
          const dataURL = await this._toDataURL(f);
          this._pending.push({ id: "ti_" + Date.now() + "_" + accepted, name: f.name, dataURL: dataURL });
          accepted++;
        } catch (e) { skipped++; }
      }
      await this._persist();
      this.renderTray(); this.showTray();
      if (typeof Prompt !== "undefined" && Prompt.toast)
        Prompt.toast("360 인입 " + accepted + "장" + (skipped ? " · 제외 " + skipped + "장(R*/360 아님)" : "") + (accepted ? " — 사진을 눌러 도면에 위치를 지정하세요" : ""));
    },

    renderTray() {
      const list = document.getElementById("theta-tray-list");
      const cnt = document.getElementById("theta-tray-count");
      if (cnt) cnt.textContent = this._pending.length;
      if (!list) return;
      if (!this._pending.length) { list.innerHTML = '<div class="theta-tray-empty">미배치 360 사진이 없습니다.</div>'; return; }
      const esc = (s) => (typeof UI !== "undefined" && UI.escapeHtml) ? UI.escapeHtml(s) : s;
      list.innerHTML = this._pending.map((p) =>
        '<div class="theta-item" data-id="' + p.id + '">' +
          '<img class="theta-thumb" src="' + p.dataURL + '" alt="" />' +
          '<div class="theta-item-name" title="' + esc(p.name) + '">' + esc(p.name) + '</div>' +
          '<button class="theta-item-assign" type="button">위치 지정 ›</button>' +
        '</div>'
      ).join("");
      list.querySelectorAll(".theta-item").forEach((el) => {
        const id = el.dataset.id;
        const go = () => this.assign(id);
        const ab = el.querySelector(".theta-item-assign"); if (ab) ab.addEventListener("click", go);
        const th = el.querySelector(".theta-thumb"); if (th) th.addEventListener("click", go);
      });
    },
    showTray() { const t = document.getElementById("theta-tray"); if (t && this._pending.length) t.classList.remove("hidden"); },
    hideTray() { const t = document.getElementById("theta-tray"); if (t) t.classList.add("hidden"); },

    /** 사진 선택 → 배치 모드 진입(도면에서 위치 탭 대기). 도면 탭은 App._handlePlaceClick 가 처리. */
    assign(id) {
      const item = this._pending.find((p) => p.id === id) || this._pending[0];
      if (!item) return;
      if (typeof App === "undefined" || !App._handlePlaceClick) { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("도면을 먼저 연 뒤 다시 시도하세요"); return; }
      const file = this._dataURLtoFile(item.dataURL, item.name);
      if (!file) { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("사진을 읽지 못했습니다"); return; }
      this._activeId = item.id;
      State.intakeFile = file;
      this.hideTray();
      if (!State.placing) App._togglePlacing();   // 배치 모드 ON (도면 탭 대기)
      if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("'" + item.name + "' — 도면에서 이 사진의 위치를 탭하세요");
    },

    /** App._handlePlaceClick 에서 인입 사진을 핀에 주입·등록한 직후 호출 — 트레이에서 제거·진행 */
    _afterPlaced() {
      const id = this._activeId; this._activeId = null;
      if (id) this._pending = this._pending.filter((p) => p.id !== id);
      this._persist();
      this.renderTray();
      if (this._pending.length) {
        this.showTray();
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("등록 — 남은 360 인입 " + this._pending.length + "장. 계속 지정하세요");
      } else {
        this.hideTray();
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("360 인입 사진 위치 등록 완료" + (navigator.onLine ? "" : " — 온라인 시 '↑ 지금 올리기'로 반영"));
      }
    },

    async _persist() {
      try { if (typeof SyncQueue !== "undefined" && SyncQueue.saveDraft) await SyncQueue.saveDraft(this._KEY, this._pending); } catch (e) {}
    },
    async _restore() {
      try {
        if (typeof SyncQueue === "undefined" || !SyncQueue.loadDraft) return;
        const d = await SyncQueue.loadDraft(this._KEY);
        if (d && Array.isArray(d) && d.length) { this._pending = d; this.renderTray(); this.showTray(); }
      } catch (e) {}
    },
  };

  /* ══════════════════════════════════════════════════════════════
     PDF POPUP — 핀에 사진 대신 PDF가 등록된 경우, 내장 PDF.js로 팝업 표시
     ────────────────────────────────────────────────────────────────
     · 마스터 요청: 사진 대신 PDF가 등록돼 있으면 현재 내장 PDF 뷰어로 팝업.
     · PDF.load(=내장 PDF.js getDocument)로 문서를 열고, 페이지를 자체 캔버스에
       직접 렌더(메인 도면 렌더상태와 분리). prev/next 페이지 + 닫기.
     · 오프라인(미업로드) PDF는 Cloud._cache["op:"+pendingOpId] dataURL로 표시.
  ══════════════════════════════════════════════════════════════ */
  const PdfPopup = {
    _doc: null, _page: 1, _pages: 1, _busy: false,

    init() {
      const $ = (id) => document.getElementById(id);
      $("pdf-popup-close") && $("pdf-popup-close").addEventListener("click", () => this.close());
      const bd = document.querySelector("#pdf-popup .pdf-popup-backdrop");
      if (bd) bd.addEventListener("click", () => this.close());
      $("pdf-popup-prev") && $("pdf-popup-prev").addEventListener("click", () => this._go(-1));
      $("pdf-popup-next") && $("pdf-popup-next").addEventListener("click", () => this._go(1));
      document.addEventListener("keydown", (e) => {
        const m = document.getElementById("pdf-popup");
        if (!m || m.classList.contains("hidden")) return;
        if (e.key === "Escape") this.close();
        else if (e.key === "ArrowLeft") this._go(-1);
        else if (e.key === "ArrowRight") this._go(1);
      });
    },

    /** dataURL(application/pdf) 또는 PDF URL 을 받아 팝업 표시 */
    async open(src, title) {
      const modal = document.getElementById("pdf-popup");
      if (!src) return;
      if (!modal || typeof PDF === "undefined" || !PDF.load) {
        // 폴백: 내장 뷰어 불가 → 새 탭
        try { window.open(src, "_blank"); } catch (e) {}
        return;
      }
      const ttl = document.getElementById("pdf-popup-title");
      if (ttl) ttl.textContent = title || "PDF";
      modal.classList.remove("hidden");
      requestAnimationFrame(() => modal.classList.add("on"));
      const canvas = document.getElementById("pdf-popup-canvas");
      if (canvas) { const c = canvas.getContext("2d"); c && c.clearRect(0, 0, canvas.width, canvas.height); }
      try {
        const ab = await this._toArrayBuffer(src);
        this._doc = await PDF.load(ab);
        this._pages = (this._doc && this._doc.numPages) || 1;
        this._page = 1;
        await this._render();
      } catch (e) {
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("PDF를 열 수 없습니다 — " + (e && e.message ? e.message : ""));
        this.close();
      }
    },

    async _render() {
      const canvas = document.getElementById("pdf-popup-canvas");
      if (!canvas || !this._doc) return;
      const page = await this._doc.getPage(this._page);
      const body = canvas.parentElement;
      const maxW = (body ? body.clientWidth : 820) - 8;
      const base = page.getViewport({ scale: 1 });
      const dpr = window.devicePixelRatio || 1;
      const fit = Math.max(0.3, Math.min(3, maxW / base.width));
      const vp = page.getViewport({ scale: fit * dpr });
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      canvas.style.width = Math.floor(vp.width / dpr) + "px";
      canvas.style.height = Math.floor(vp.height / dpr) + "px";
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const ind = document.getElementById("pdf-popup-page");
      if (ind) ind.textContent = this._page + " / " + this._pages;
      const prev = document.getElementById("pdf-popup-prev"), next = document.getElementById("pdf-popup-next");
      if (prev) prev.disabled = this._page <= 1;
      if (next) next.disabled = this._page >= this._pages;
    },

    async _go(d) {
      if (this._busy || !this._doc) return;
      const n = this._page + d;
      if (n < 1 || n > this._pages) return;
      this._busy = true; this._page = n;
      try { await this._render(); } catch (e) {} finally { this._busy = false; }
    },

    close() {
      const modal = document.getElementById("pdf-popup");
      if (modal) { modal.classList.remove("on"); setTimeout(() => modal.classList.add("hidden"), 200); }
      this._doc = null; this._page = 1; this._pages = 1;
    },

    /** dataURL → ArrayBuffer (URL이면 fetch) */
    async _toArrayBuffer(src) {
      if (typeof src === "string" && src.indexOf("data:") === 0) {
        const base64 = src.split(",")[1] || "";
        const bin = atob(base64); const len = bin.length; const u8 = new Uint8Array(len);
        for (let i = 0; i < len; i++) u8[i] = bin.charCodeAt(i);
        return u8.buffer;
      }
      const r = await fetch(src);
      return await r.arrayBuffer();
    },
  };

  /* ══════════════════════════════════════════════════════════════
     사진 폴더 일괄 매칭 — 핀 번호 ↔ 촬영시각 1:1 매칭
     ────────────────────────────────────────────────────────────────
     마스터 요청(2026-09-03, RESUME_LEDGER.md §H): "핀을 순서대로 찍어둔 뒤 사진이
     들어있는 폴더를 선택하면 사진 생성 시간 순서대로 핀 번호대로 1번부터 몇 번까지
     설정한 후 업로드하면 핀 번호 순서 ↔ 사진 시간 순서로 1:1 매칭돼서 그 위치에
     사진이 등록"

     정렬 우선순위(추측을 사실처럼 보이지 않도록 각 행에 근거를 표시한다):
       1) EXIF DateTimeOriginal(진짜 촬영시각)
       2) 파일 lastModified
       3) 파일명 자연정렬
       — build-tools/photo-timesort.mjs(참고구현·실데이터 57장 검증됨)와 같은 로직을
         브라우저(ArrayBuffer/DataView)로 포팅. 로직은 바꾸지 않는다.

     번호 정본: PinSeries.numbers()(01b_PinSeries.js).
     🔴 [마스터 요청 2026-09-03 갱신] 처음엔 "콘텐츠 계열"만 매칭 대상이었으나(체크보드는 별도
       채번이라 제외), 마스터가 "체크보드로 핀을 차례대로 박고 → 그 핀들에 사진 폴더를 일괄
       연동"이라고 명시해 체크보드 계열도 매칭 대상으로 바뀌었다. 번호가 계열마다 독립 채번(1부터)
       이라 같은 번호가 계열마다 존재할 수 있으므로, open()/_pinList() 는 **어느 계열의 범위인지**
       를 함께 받는다(series 미지정 시 기존 단독 진입과 동일하게 "content" 로 폴백 — 하위호환).
       tests/p6-photo-batch.test.mjs §④ 참조(체크보드 제외 기대값 → 계열 지정 매칭으로 변경, 사유 주석 포함).

     저장 경로: Cloud.resizeImage()/Cloud.uploadImage() + 오프라인 SyncQueue.enqueue() —
       20_App.js _confirmPin() 의 이미지 분기(≈1908~1934행)와 동일 API 조합을 그대로 쓴다.
       새 저장 경로를 만들지 않는다.
       🔴 단, App._uploadPinImageBg() 는 재사용하지 않는다 — 그 함수는 끝에서 this._autoSave()
       를 호출해 매 장마다 서버에 자동저장되는데, 이 기능은 "자동저장 OFF 정책 유지 — 등록 후
       미저장 표시만" 이 명시 요구사항(§H⑦)이라 상충한다. 그래서 동일한 저장 API 3개
       (resizeImage/uploadImage/SyncQueue.enqueue)만 재사용하고, 자동저장 대신
       App._markDirty() 로 "미저장" 표시만 남긴다.
     360 판별: App._detect360(file, cb) 재사용(자체 판별 로직 추가 금지).
  ══════════════════════════════════════════════════════════════ */
  const PhotoBatch = {
    _rows: [],              // 표시/매칭 순서 그대로 보관 [{file,name,lastModified,exif,excluded,sortKey,timeSource,timeLabel,is360,w,h,bigGapBefore,gapMs}]
    _range: { start: 1, end: 1, series: "content" },
    _busy: false,

    /* ══ 순수 로직 — 회귀 테스트가 직접 호출한다(DOM 무의존) ══════════ */

    /** 파일명 자연정렬(숫자를 숫자로) — build-tools/photo-timesort.mjs 와 동일 */
    _natural(a, b) { return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }); },

    _asciiAt(view, off, n) {
      let s = "";
      for (let k = 0; k < n; k++) s += String.fromCharCode(view.getUint8(off + k));
      return s;
    },

    /** JPEG APP1(EXIF)에서 DateTimeOriginal(0x9003)/DateTimeDigitized(0x9004)/DateTime(0x0132)을 찾는다.
     *  입력: ArrayBuffer(파일 선두 일부, File.slice().arrayBuffer()). 실패해도 예외를 던지지 않고
     *  null 을 반환해 mtime/파일명 폴백으로 자연히 넘어가게 한다(node 버전의 Buffer 판을 DataView 로 포팅). */
    _parseExifDate(buf) {
      try {
        const b = new DataView(buf);
        const len = b.byteLength;
        if (len < 4 || b.getUint8(0) !== 0xFF || b.getUint8(1) !== 0xD8) return null;
        let i = 2;
        while (i < len - 4) {
          if (b.getUint8(i) !== 0xFF) { i++; continue; }
          const marker = b.getUint8(i + 1);
          if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
          if (i + 4 > len) break;
          const segLen = b.getUint16(i + 2, false);
          const segStart = i + 4;
          if (marker === 0xE1 && segStart + 4 <= len && this._asciiAt(b, segStart, 4) === "Exif") {
            const r = this._parseExifIfd(b, segStart + 6, Math.min(segStart + segLen, len));
            if (r) return r;
          }
          if (marker === 0xDA) break; // SOS 이후는 압축 데이터
          i = segStart + segLen - 2;
          if (segLen <= 0) break;
        }
        return null;
      } catch (e) { return null; }
    },

    /** TIFF 헤더부터 IFD0 + ExifIFD 를 훑어 촬영시각 태그를 찾는다 */
    _parseExifIfd(b, tiffStart, end) {
      if (tiffStart + 8 > end) return null;
      const le = this._asciiAt(b, tiffStart, 2) === "II";
      const u16 = (o) => b.getUint16(o, le);
      const u32 = (o) => b.getUint32(o, le);
      if (u16(tiffStart + 2) !== 42) return null;
      let best = null;
      const walk = (ifdOff, depth) => {
        if (depth > 2 || (best && best.tag === "DateTimeOriginal")) return;
        const at = tiffStart + ifdOff;
        if (at + 2 > end) return;
        const n = u16(at);
        for (let k = 0; k < n; k++) {
          const e = at + 2 + k * 12;
          if (e + 12 > end) return;
          const tag = u16(e), type = u16(e + 2), cnt = u32(e + 4);
          const valOff = (type === 2 && cnt > 4) ? tiffStart + u32(e + 8) : e + 8;
          if (tag === 0x8769) { walk(u32(e + 8), depth + 1); continue; } // ExifIFD 포인터
          if ((tag === 0x9003 || tag === 0x9004 || tag === 0x0132) && type === 2 && valOff + 19 <= end) {
            const s = this._asciiAt(b, valOff, 19); // "YYYY:MM:DD HH:MM:SS"
            const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s);
            if (m) {
              const iso = m[1] + "-" + m[2] + "-" + m[3] + "T" + m[4] + ":" + m[5] + ":" + m[6];
              if (tag === 0x9003) { best = { iso, tag: "DateTimeOriginal" }; return; }
              if (!best) best = { iso, tag: tag === 0x9004 ? "DateTimeDigitized" : "DateTime" };
            }
          }
        }
      };
      walk(u32(tiffStart + 4), 0);
      return best;
    },

    /** 정렬 우선순위(EXIF→mtime→파일명)에 따라 sortKey/timeSource/timeLabel 을 부여하고
     *  정렬한 "새" 배열을 반환한다(원본 불변). 큰 시간 간격(10분↑) 지점엔 bigGapBefore 를 단다.
     *  순수 함수 — 테스트가 직접 호출한다. */
    _sortRows(rows) {
      const withKey = (rows || []).map((r) => {
        let sortKey, timeSource, timeLabel;
        if (r.exif && r.exif.iso) {
          sortKey = Date.parse(r.exif.iso);
          timeSource = "EXIF " + r.exif.tag;
          timeLabel = r.exif.iso.replace("T", " ");
        } else if (Number.isFinite(r.lastModified)) {
          sortKey = r.lastModified;
          timeSource = "파일 수정시각";
          timeLabel = new Date(r.lastModified).toISOString().slice(0, 19).replace("T", " ");
        } else {
          sortKey = NaN;
          timeSource = "파일명순(시간정보 없음)";
          timeLabel = "-";
        }
        return Object.assign({}, r, { sortKey, timeSource, timeLabel, bigGapBefore: false, gapMs: 0 });
      });
      withKey.sort((a, b) => {
        const ak = Number.isFinite(a.sortKey) ? a.sortKey : Infinity;
        const bk = Number.isFinite(b.sortKey) ? b.sortKey : Infinity;
        if (ak !== bk) return ak - bk;
        return this._natural(a.name, b.name);
      });
      const GAP_MS = 10 * 60 * 1000; // 10분↑ = 구역 이동 경계 추정(실데이터: 중앙값 19초 vs 최대 4948초)
      for (let k = 1; k < withKey.length; k++) {
        const a = withKey[k - 1], c = withKey[k];
        if (Number.isFinite(a.sortKey) && Number.isFinite(c.sortKey) && (c.sortKey - a.sortKey) >= GAP_MS) {
          c.bigGapBefore = true; c.gapMs = c.sortKey - a.sortKey;
        }
      }
      return withKey;
    },

    /** 🔴 번호는 PinSeries 정본에서만 파생(자체 채번 금지). 현재 페이지의 지정 계열
     *  핀만 오름차순으로 나열한다. @param {string} [series="content"] 번호는 계열마다
     *  독립 채번(1부터)이라 계열을 반드시 지정해야 모호성이 없다(미지정 시 기존 단독
     *  진입과 동일하게 "content" 로 폴백 — 하위호환). */
    _pinList(pins, page, series) {
      const ser = series || "content";
      const map = PinSeries.numbers(pins || [], page);
      const list = [];
      (pins || []).forEach((p) => {
        if (!p || (p.page || 1) !== (page || 1)) return;
        const info = map.get(p.id);
        if (!info || info.series !== ser) return;
        list.push({ pin: p, no: info.no });
      });
      list.sort((a, b) => a.no - b.no);
      return list;
    },

    /** 핀 번호 범위 × 표시행 순서(제외 반영) → 1:1 매칭. 순수 함수.
     *  개수가 다르면 남는 쪽을 leftoverPins/leftoverRows 로 알려준다(조용히 자르지 않음). */
    _buildMatches(pinList, rows, range) {
      const pinsInRange = (pinList || []).filter((e) => e.no >= range.start && e.no <= range.end);
      const activeRows = (rows || []).filter((r) => !r.excluded);
      const n = Math.min(pinsInRange.length, activeRows.length);
      const matches = [];
      for (let i = 0; i < n; i++) matches.push({ pin: pinsInRange[i].pin, no: pinsInRange[i].no, row: activeRows[i] });
      return {
        matches,
        leftoverPins: pinsInRange.slice(n),
        leftoverRows: activeRows.slice(n)
      };
    },

    _esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); },

    /* ══ DOM 연결 ══════════════════════════════════════════════ */

    init() {
      const $ = (id) => document.getElementById(id);
      $("btn-photobatch") && $("btn-photobatch").addEventListener("click", () => this.open());
      $("photobatch-close") && $("photobatch-close").addEventListener("click", () => this.close());
      document.querySelectorAll('.admin-gate-backdrop[data-close="photobatch"]').forEach((bd) => bd.addEventListener("click", () => this.close()));

      const folderInp = $("input-photobatch-folder");
      if (folderInp) folderInp.addEventListener("change", (e) => { const files = Array.from(e.target.files || []); e.target.value = ""; this._onFilesChosen(files); });
      $("btn-photobatch-pick") && $("btn-photobatch-pick").addEventListener("click", () => folderInp && folderInp.click());

      const filesInp = $("input-photobatch-files");
      if (filesInp) filesInp.addEventListener("change", (e) => { const files = Array.from(e.target.files || []); e.target.value = ""; this._onFilesChosen(files); });
      $("btn-photobatch-pick-files") && $("btn-photobatch-pick-files").addEventListener("click", () => filesInp && filesInp.click());

      $("btn-photobatch-run") && $("btn-photobatch-run").addEventListener("click", () => this.run());

      const s = $("photobatch-start");
      if (s) s.addEventListener("change", () => { const v = parseInt(s.value, 10); if (Number.isFinite(v)) this._range.start = v; this._renderTable(); });
      const e2 = $("photobatch-end");
      if (e2) e2.addEventListener("change", () => { const v = parseInt(e2.value, 10); if (Number.isFinite(v)) this._range.end = v; this._renderTable(); });

      const tbody = $("photobatch-table-body");
      if (tbody) {
        tbody.addEventListener("click", (e) => {
          const b = e.target.closest && e.target.closest("[data-act]");
          if (!b) return;
          const idx = parseInt(b.dataset.idx, 10);
          if (b.dataset.act === "up") this._moveRow(idx, -1);
          else if (b.dataset.act === "down") this._moveRow(idx, 1);
        });
        tbody.addEventListener("change", (e) => {
          const b = e.target.closest && e.target.closest('[data-act="excl"]');
          if (!b) return;
          this._toggleExclude(parseInt(b.dataset.idx, 10));
        });
      }
    },

    /* [WO 20260918] 🔴 series 하드코딩 제거 — 단독 진입(#btn-photobatch)이 "콘텐츠 계열"로
     *  고정돼 있어, 체크보드 모드에서 열면 대상 핀이 항상 0건이었다(진입로는 있지만 결과가 없어
     *  조용히 실패). 현재 배치 모드(State.checkboard, 20_App.js SoT)를 그대로 반영한다 —
     *  새 상태를 만들지 않고 기존 SoT 를 재사용. */
    _defaultRange() {
      const series = (typeof State !== "undefined" && State.checkboard) ? "checkboard" : "content";
      const list = this._pinList(State.pins, State.pdfPage || 1, series);
      return { start: list.length ? list[0].no : 1, end: list.length ? list[list.length - 1].no : 1, series: series };
    },

    /** @param {{start:number,end:number,series?:string}} [range] — 호출부가 명시 범위를 넘기면
     *  그대로 채운다(range 없이 호출하는 경로는 현재 #btn-photobatch 단독 진입 하나뿐).
     *  🔴 [WO 20260918] series 생략 시 _defaultRange() 가 현재 배치 모드(State.checkboard)를
     *  따라 "content"/"checkboard" 를 자동 선택한다 — 예전엔 "content" 로 고정돼 체크보드
     *  모드에서 열면 대상 핀이 0건이었다(하드코딩 제거). */
    open(range) {
      if (typeof Auth !== "undefined" && Auth.requireDesigner && !Auth.isDesigner) { Auth.requireDesigner(() => {}); return; }
      this._rows = [];
      this._range = (range && Number.isFinite(range.start) && Number.isFinite(range.end))
        ? { start: range.start, end: range.end, series: range.series || "content" }
        : this._defaultRange();
      const modal = document.getElementById("photobatch-modal");
      if (!modal) return;
      modal.classList.remove("hidden");
      requestAnimationFrame(() => modal.classList.add("on"));
      const s = document.getElementById("photobatch-start"); if (s) s.value = this._range.start;
      const e = document.getElementById("photobatch-end"); if (e) e.value = this._range.end;
      const ov = document.getElementById("photobatch-overwrite"); if (ov) ov.checked = false;
      const prog = document.getElementById("photobatch-progress"); if (prog) prog.textContent = "";
      // [마스터 요청 2026-09-03] 계열이 섞여 모호해질 수 있으므로 대상 계열을 화면에 명시한다
      // (조용히 아무거나 고르지 않음 — §10 조용한 실패 금지).
      const title = document.getElementById("photobatch-title");
      if (title) {
        const label = (typeof PinSeries !== "undefined" && PinSeries.LABELS && PinSeries.LABELS[this._range.series]) || this._range.series;
        title.textContent = "사진 폴더 일괄 매칭 — " + label + " 계열";
      }
      this._renderTable();
      // [WO 20260918] 🔴 조용한 실패 금지 — 대상 계열 핀이 0건이면 모달만 열고 아무 말 없던 것을
      // 이유와 함께 알린다(기존 토스트 경로 재사용, 새 UI 없음).
      const targetList = this._pinList(State.pins, State.pdfPage || 1, this._range.series);
      if (!targetList.length && typeof Prompt !== "undefined" && Prompt.toast) {
        const label2 = (typeof PinSeries !== "undefined" && PinSeries.LABELS && PinSeries.LABELS[this._range.series]) || this._range.series;
        Prompt.toast("이 화면(" + label2 + " 계열)에는 대상 핀이 없습니다 — 먼저 번호 핀을 찍어주세요");
      }
    },

    close() {
      const modal = document.getElementById("photobatch-modal");
      if (!modal) return;
      modal.classList.remove("on");
      setTimeout(() => modal.classList.add("hidden"), 180);
    },

    async _onFilesChosen(files) {
      const IMG_RE = /\.(jpe?g|png|webp)$/i;
      const imgFiles = (files || []).filter((f) => IMG_RE.test(f.name));
      if (!imgFiles.length) { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("이미지 파일을 찾을 수 없습니다"); return; }
      const status = document.getElementById("photobatch-status");
      if (status) status.textContent = imgFiles.length + "장 분석 중...";
      const rows = [];
      for (const f of imgFiles) {
        let exif = null;
        try { exif = this._parseExifDate(await f.slice(0, 262144).arrayBuffer()); } catch (e) { exif = null; }
        rows.push({ file: f, name: f.name, lastModified: f.lastModified, exif, excluded: false, is360: null, w: 0, h: 0 });
      }
      this._rows = this._sortRows(rows);
      if (status) status.textContent = imgFiles.length + "장 · 시간순 정렬 완료";
      this._renderTable();
      // 360 판별(비동기, App._detect360 재사용) — 완료되는 대로 표를 다시 그려 채운다
      this._rows.forEach((r) => {
        if (typeof App === "undefined" || !App._detect360) return;
        App._detect360(r.file, (is360, w, h) => { r.is360 = is360; r.w = w; r.h = h; this._renderTable(); });
      });
    },

    _moveRow(idx, dir) {
      const j = idx + dir;
      if (idx < 0 || idx >= this._rows.length || j < 0 || j >= this._rows.length) return;
      const tmp = this._rows[idx]; this._rows[idx] = this._rows[j]; this._rows[j] = tmp;
      this._renderTable();
    },

    _toggleExclude(idx) {
      const r = this._rows[idx];
      if (!r) return;
      r.excluded = !r.excluded;
      this._renderTable();
    },

    _renderTable() {
      const host = document.getElementById("photobatch-table-body");
      if (!host) return;
      const page = State.pdfPage || 1;
      const pinList = this._pinList(State.pins, page, this._range.series);
      const { matches, leftoverPins, leftoverRows } = this._buildMatches(pinList, this._rows, this._range);
      const matchByRow = new Map();
      matches.forEach((m) => matchByRow.set(m.row, m));

      let html = "";
      this._rows.forEach((r, idx) => {
        const m = matchByRow.get(r);
        const pinNo = m ? m.no : (r.excluded ? "제외" : "범위 밖");
        const hasExisting = m ? PinSeries.hasContent(m.pin) : false;
        if (r.bigGapBefore) {
          html += '<tr class="pb-gap-row"><td colspan="7">⏱ 간격 ' + Math.round(r.gapMs / 60000) + '분 — 구역 경계 추정</td></tr>';
        }
        html += '<tr class="pb-row' + (r.excluded ? " pb-excluded" : "") + '" data-idx="' + idx + '">'
          + '<td class="pb-c-no">' + this._esc(pinNo) + '</td>'
          + '<td class="pb-c-file" title="' + this._esc(r.name) + '">' + this._esc(r.name) + '</td>'
          + '<td class="pb-c-time">' + this._esc(r.timeLabel || "-") + '</td>'
          + '<td class="pb-c-src">' + this._esc(r.timeSource || "-") + '</td>'
          + '<td class="pb-c-360">' + (r.is360 === true ? "360°" : (r.is360 === false ? "일반" : "…")) + '</td>'
          + '<td class="pb-c-exist">' + (hasExisting ? "기존있음" : "-") + '</td>'
          + '<td class="pb-c-act">'
            + '<button type="button" class="pb-mini" data-act="up" data-idx="' + idx + '" title="위로" aria-label="위로">↑</button>'
            + '<button type="button" class="pb-mini" data-act="down" data-idx="' + idx + '" title="아래로" aria-label="아래로">↓</button>'
            + '<label class="pb-excl"><input type="checkbox" data-act="excl" data-idx="' + idx + '"' + (r.excluded ? " checked" : "") + ' /> 제외</label>'
            + '<span class="pb-status" id="pb-status-' + idx + '"></span>'
          + '</td>'
          + '</tr>';
      });
      host.innerHTML = html || '<tr><td colspan="7" class="pb-empty">폴더를 선택하세요</td></tr>';

      const warnEl = document.getElementById("photobatch-warn");
      if (warnEl) {
        if (leftoverPins.length || leftoverRows.length) {
          warnEl.classList.remove("hidden");
          warnEl.textContent = "⚠ 개수 불일치 — " + (leftoverPins.length ? "핀 " + leftoverPins.length + "개 남음 " : "") + (leftoverRows.length ? "사진 " + leftoverRows.length + "장 남음" : "");
        } else { warnEl.classList.add("hidden"); warnEl.textContent = ""; }
      }
      const cntEl = document.getElementById("photobatch-count");
      if (cntEl) {
        const serLabel = (typeof PinSeries !== "undefined" && PinSeries.LABELS && PinSeries.LABELS[this._range.series]) || this._range.series;
        cntEl.textContent = matches.length + "건 매칭 예정 · [" + serLabel + " 계열] 핀 범위 " + this._range.start + "~" + this._range.end + " (전체 " + pinList.length + "개)";
      }
    },

    _setRowStatus(row, text) {
      const idx = this._rows.indexOf(row);
      if (idx < 0) return;
      const el = document.getElementById("pb-status-" + idx);
      if (el) el.textContent = text;
    },

    _updateProgress(total, done) {
      const el = document.getElementById("photobatch-progress");
      if (el) el.textContent = done + " / " + total;
    },

    /** 실행: 순차 업로드(동시 3), 진행률, 실패 건 표시, 오프라인이면 SyncQueue 폴백.
     *  이미 사진 있는 핀은 기본 건너뛰기(덮어쓰기 체크 시에만 진행).
     *  🔴 자동저장 OFF 정책 — 완료 후 App._markDirty() 로 "미저장" 표시만 한다. */
    async run() {
      if (this._busy) return;
      const page = State.pdfPage || 1;
      const pinList = this._pinList(State.pins, page, this._range.series);
      const { matches, leftoverPins, leftoverRows } = this._buildMatches(pinList, this._rows, this._range);
      if (!matches.length) { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("매칭할 핀·사진이 없습니다"); return; }
      if (leftoverPins.length || leftoverRows.length) {
        const msg = (leftoverPins.length ? leftoverPins.length + "개 핀 남음 " : "") + (leftoverRows.length ? leftoverRows.length + "장 사진 남음" : "");
        if (!await Prompt.confirm("사진 일괄 매칭", "개수가 일치하지 않습니다 — " + msg + ". " + matches.length + "건만 매칭해 진행할까요?")) return;
      }
      this._busy = true;
      const runBtn = document.getElementById("btn-photobatch-run");
      if (runBtn) runBtn.disabled = true;
      const overwriteEl = document.getElementById("photobatch-overwrite");
      const overwrite = !!(overwriteEl && overwriteEl.checked);

      let done = 0, fail = 0, skip = 0;
      const queue = matches.slice();
      const worker = async () => {
        while (queue.length) {
          const m = queue.shift();
          const { pin, row } = m;
          if (!overwrite && PinSeries.hasContent(pin)) { skip++; this._setRowStatus(row, "건너뜀(기존사진)"); this._updateProgress(matches.length, done + fail + skip); continue; }
          try {
            this._setRowStatus(row, "업로드 중...");
            const { dataURL, width, height } = await Cloud.resizeImage(row.file);
            const imgName = row.name.replace(/\.[^.]+$/, "");
            let uploaded = false;
            if (navigator.onLine) {
              try { const imageId = await Cloud.uploadImage(imgName, dataURL, width, height); pin.imageId = imageId; Cloud._cache[imageId] = dataURL; uploaded = true; } catch (e) { uploaded = false; }
            }
            if (!uploaded) {
              const opId = await SyncQueue.enqueue({ kind: "image", name: imgName, image_data: dataURL, width, height });
              if (opId) { pin.pendingOpId = opId; pin.pendingSync = true; Cloud._cache["op:" + opId] = dataURL; }
              else throw new Error("저장공간 부족");
            }
            pin.imageName = imgName;
            if (row.is360) pin.is360 = true;
            done++; this._setRowStatus(row, uploaded ? "완료" : "오프라인 저장됨");
          } catch (e) {
            fail++; this._setRowStatus(row, "실패: " + (e.message || e));
          }
          this._updateProgress(matches.length, done + fail + skip);
        }
      };
      await Promise.all([worker(), worker(), worker()]); // 동시 3

      this._busy = false;
      if (runBtn) runBtn.disabled = false;
      try { UI.renderPinList(); UI.renderPinsOnMap(); if (typeof PinGrid !== "undefined") PinGrid.render(); } catch (e) {}
      try { App._updateSyncBadge && App._updateSyncBadge(); } catch (e) {}
      if (done) { try { App._markDirty && App._markDirty(); } catch (e) {} } // 자동저장 호출 금지 — 미저장 표시만
      if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("완료 " + done + " · 건너뜀 " + skip + " · 실패 " + fail);
    }
  };

  /* ══════════════════════════════════════════════════════════════
     도움말(Help) 체계 — 마스터 지시: "항상 모든 메뉴마다 사용자 매뉴얼을 구현해"
     ────────────────────────────────────────────────────────────────
     [설계 방침 — 작게 시작] 버튼 259개에 개별 문서를 일일이 다는 대신, 재사용
     가능한 얇은 체계 하나만 둔다: 요소에 `data-help="키"` 를 달면, 도움말 모드를
     켰을 때 그 요소 옆에 "?" 표시(배지)가 나타나고, 배지를 누르면 설명이 뜬다.

     🔴 [2026-09-17 재작업 — "길게 누르기" 반려] 최초 구현은 요소를 길게 누르면
     팝업이 뜨는 방식이었으나, **화면에 아무 단서가 없어 존재를 알 수 없다**는
     이유로 반려됨(방향보정 기능이 있는데도 "사라졌다"고 보고됐던 것과 동일한 패턴 —
     기능이 있어도 발견 못 하면 없는 것과 같다). 추가로 길게 누르기는 버튼의 원래
     클릭 동작과 물리적으로 충돌해(누르다 떼면 클릭 발생) 오작동 억제 코드가
     필요했다 — 그 자체가 방식이 틀렸다는 신호였다.

     트리거 방식 = **도움말 모드 토글("?" 버튼 1개, 화면에 항상 보임) + 배지**.
       - 토글을 켜면 `data-help` 가 있는 모든 요소 옆(우상단)에 작은 "?" 배지가
         **화면에 보이는 형태로** 나타난다 → 사용자가 "도움말이 있다"는 사실 자체를
         한눈에 알 수 있다(요구① 충족). 평소(꺼짐)엔 화면이 깨끗하다.
       - 배지는 대상 요소의 **자식이 아니라 `document.body` 에 별도로 추가되는
         완전히 분리된 엘리먼트**이므로, 배지를 눌러도 그 아래 버튼의 클릭 이벤트가
         발생하지 않는다(요구: 원래 동작과 충돌 금지 — 억제 코드로 땜질하는 게 아니라
         구조적으로 겹치지 않게 설계). 방어적으로 stopPropagation/preventDefault 도
         호출한다.
       - 토글·배지 모두 **click 이벤트만으로 동작**한다(hover/mouseenter 의존 0) →
         터치 기기(현장 폰)에서도 탭 한 번으로 100% 도달 가능(요구②: 호버 전용 금지).
       - 기존 `title` 속성(브라우저 기본 툴팁, 130개 이미 존재)은 전혀 건드리지 않는다.

     SoT(정본) = 아래 `Help.CONTENT` 객체 하나. 도움말 문구를 다른 파일에 복제하지 않는다.
     내용이 없는 키는 조용히 무시하지 않고 "준비 중" 문구 + console.warn 으로 알린다
     (사용자에게는 오류로 보이지 않게, 개발자에게는 빠뜨린 키를 알 수 있게).

     🔴 반드시 `_manifest.txt` 에 등록해야 번들(main.js)에 포함된다(빠뜨리면 고아 모듈).
     🔴 새 CSS 규칙 추가 금지(style.css 는 다른 트랙이 점유 중) — 전부 인라인 스타일,
        리터럴 hex(테마 변수 var() 미사용 — OS 강제다크모드가 var() 텍스트만 밝게
        재해석하는 이 코드베이스의 기존 함정을 원천 차단).
        대비 실측: 배지/팝업 #ffffff on #1a1712 ≈ 18.7:1. 토글 on-상태 #1a1712 on
        #c9962a ≈ 8.0:1(WCAG AAA). 모두 4.5:1 기준 여유.
     🔴 토글 버튼은 이 모듈이 JS로 직접 body 에 생성해 붙인다(index.html 수정 불필요,
        다른 트랙과 충돌 없음). 배치는 좌하단(bottom:16,left:16) — 우하단 wm-toast,
        상단 net-badge 등 기존 고정 UI와 자리가 겹치지 않는다(겹치면 지휘자가
        index.html/좌표로 재배치 가능하도록 z-index/스타일을 한 곳에 모아둠).
  ══════════════════════════════════════════════════════════════ */
  const Help = {
    // ── SoT: 도움말 문구 정본. 여기 한 곳에서만 관리한다 ──
    // 초기 8개(마스터 지정 핵심 메뉴). 나머지 버튼은 키를 비워두고 점진 확장한다.
    CONTENT: {
      "zone-create": "구역/영역 만들기 — 도면 위에서 사각형·원형·다각형 도구를 선택한 뒤 그리면, 그 안에 속한 핀들을 하나의 구역(영역)으로 묶어 관리할 수 있습니다.",
      "drawing-upload": "도면 등록 — PDF 또는 이미지(JPG/PNG) 파일을 업로드하면 그 위에 포인트(핀)를 찍을 수 있는 캔버스가 만들어집니다.",
      "pin-place": "포인트(핀) 찍기 — 도면 위 원하는 위치를 클릭하면 그 자리에 360° 파노라마를 연결할 핀이 생성됩니다.",
      "region-extract": "도면 영역 추출 — A0 같은 한 장짜리 도면에 평면도·측면도·단면도가 여러 개 들어 있을 때, 그중 하나를 드래그로 긁으면 그 부분만 보이는 새 영역(구역)이 만들어집니다. 원본 PDF 는 전혀 바뀌지 않고 '그 부분만 확대해서 보는 창'이 하나 더 생기는 것이라, 같은 도면에서 몇 번이든 반복해 뽑을 수 있고 뽑은 영역을 지워도 원본 도면은 그대로 남습니다. 새 영역 안에서 찍은 핀은 원본 도면 좌표로 그대로 저장되므로 원본과 영역 어느 쪽에서 봐도 같은 자리에 있습니다.",
      "zone-assign": "영역 지정 — 핀을 특정 구역(zone)에 소속시켜 도면이 복잡해도 구역별로 찾아보기 쉽게 정리합니다.",
      "photo-batch": "사진 폴더 일괄 매칭 — 핀을 순서대로 찍은 뒤 사진이 담긴 폴더를 선택하면, 촬영 시각 순서대로 핀 번호에 자동으로 1:1 매칭됩니다.",
      "deploy-viewer": "뷰어로 배포 — 지금까지 작업한 도면·핀·영역을 열람 전용 링크로 만들어 다른 사람과 공유합니다(공유받은 사람은 로그인 없이 볼 수 있습니다).",
      "orientation-fix": "방향 보정 — 360° 파노라마가 실제 도면 방향과 다르게 찍혔을 때, 회전시켜 도면 방향과 맞춥니다.",
      "checkerboard": "체크보드 모드 — 버튼 한 번으로 핀을 1번부터 순서대로 연속 배치하는 빠른 입력 모드입니다.",
      "checkboard-renumber": "체크보드 번호 일괄 변경 — 누르면 새 시작 번호를 물어보고, 이 페이지의 체크보드 핀 전체를 현재 순서 그대로 그 번호부터 다시 매깁니다(예: 1~40번 → 시작번호 101 입력 시 101~140번). 사진·노트는 번호가 아니라 핀 자체에 연결돼 있어 번호가 바뀌어도 그대로 유지됩니다. 번호 하나만 고치려면 핀을 눌러 '위치명/번호' 칸에서 직접 바꾸세요(이미 쓰는 번호로는 바꿀 수 없습니다).",
      "radar-zoom": "미니맵 도면 확대 — +/− 버튼, 두 손가락 핀치, 더블탭(더블클릭)으로 미니맵 안의 도면만 1~6배 확대/축소합니다. 패널 크기는 그대로 유지되고, 확대해도 현재 위치가 항상 중앙에 표시됩니다.",
      "offline-download": "오프라인 다운로드 — 이 프로젝트의 도면(PDF/이미지)과 배치된 핀, 그리고 핀에 연결된 360° 파노라마 사진을 전부 이 기기에 내려받습니다. 다운로드가 끝나면 인터넷이 끊긴 현장에서도 도면과 360° 사진을 그대로 열람하고 작업할 수 있고, 나중에 인터넷이 다시 연결되면 자동으로 서버와 동기화됩니다. 버튼에 '저장됨'이 표시되면 이미 내려받아 오프라인 사용 준비가 된 상태입니다.",
      "pin-mobile-photo-only": "모바일에서는 사진만 등록할 수 있습니다(화면이 좁아 사진 등록에 집중). 360° 사진·문서·노트·동영상·URL 첨부는 PC(데스크톱)에서 추가하세요. 이미 등록된 다른 종류의 첨부는 모바일에서도 그대로 보이고 열람됩니다.",
      "invite-share": "초대 링크 공유 — 누르면 폰의 공유 시트가 열려 카카오톡 등 원하는 앱으로 바로 보낼 수 있습니다. PC 등 지원하지 않는 환경에서는 자동으로 링크가 복사됩니다.",
      "deck-source-select": "구역 생성 방식 선택 — '+ 구역 생성'을 누르면 이 구역의 도면을 어떻게 마련할지 고를 수 있습니다. ① 기존 도면에서 영역 지정: 지금 열려 있는 도면 위에서 원하는 부분을 드래그로 긁으면, 원본은 그대로 둔 채 그 부분만 보이는 새 구역이 만들어집니다(도면 영역 추출과 동일 기능). ② 새 도면 파일 업로드: PDF·이미지 파일을 새로 올려 그 파일을 이 구역의 도면으로 씁니다. 지금 열려 있는 도면이 없으면 ①은 고를 수 없고 그 이유가 안내됩니다."
    },

    _inited: false,
    active: false,        // 도움말 모드 on/off
    _toggleBtn: null,
    _badges: [],           // [{ badge, target }]
    _popup: null,
    _hideTimer: null,

    /** 정본에서 값을 읽는다. 키가 없으면 undefined(조용한 대체값 날조 금지). */
    get(key) {
      return Object.prototype.hasOwnProperty.call(this.CONTENT, key) ? this.CONTENT[key] : undefined;
    },

    init() {
      if (this._inited) return;
      this._inited = true;
      this._createToggle();
      document.addEventListener("keydown", (e) => { if (e.key === "Escape") this.hide(); });
      window.addEventListener("scroll", () => { if (this.active) this._reposition(); }, true);
      window.addEventListener("resize", () => { if (this.active) this._reposition(); });
    },

    /** 화면에 항상 보이는 "?" 토글 — 도움말 체계의 존재 자체를 알리는 유일한 진입점. */
    _createToggle() {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.setAttribute("data-help-toggle", "1");
      btn.setAttribute("aria-label", "도움말 모드 켜기/끄기");
      btn.setAttribute("aria-pressed", "false");
      btn.textContent = "?";
      btn.style.cssText = this._toggleStyle(false);
      btn.addEventListener("click", (e) => {
        if (e.preventDefault) e.preventDefault();
        if (e.stopPropagation) e.stopPropagation();
        this.toggle();
      });
      document.body.appendChild(btn);
      this._toggleBtn = btn;
    },

    _toggleStyle(isActive) {
      return [
        "position:fixed", "left:16px", "bottom:16px", "width:40px", "height:40px",
        "border-radius:50%", "border:none", "cursor:pointer", "z-index:9550",
        "display:flex", "align-items:center", "justify-content:center",
        "font-size:18px", "font-weight:700", "font-family:sans-serif",
        "box-shadow:0 4px 14px rgba(0,0,0,.3)",
        isActive ? "background:#c9962a" : "background:#1a1712",
        isActive ? "color:#1a1712" : "color:#ffffff"
      ].join(";");
    },

    toggle() { this.active ? this.disable() : this.enable(); },

    /** 도움말 모드 ON — data-help 요소마다 눈에 보이는 "?" 배지를 붙인다. */
    enable() {
      this.active = true;
      if (this._toggleBtn) {
        this._toggleBtn.setAttribute("aria-pressed", "true");
        this._toggleBtn.style.cssText = this._toggleStyle(true);
      }
      this._mountBadges();
    },

    /** 도움말 모드 OFF — 배지를 전부 제거해 평소 화면으로 복귀한다. */
    disable() {
      this.active = false;
      if (this._toggleBtn) {
        this._toggleBtn.setAttribute("aria-pressed", "false");
        this._toggleBtn.style.cssText = this._toggleStyle(false);
      }
      this._unmountBadges();
      this.hide();
    },

    _mountBadges() {
      this._unmountBadges();
      const targets = document.querySelectorAll("[data-help]");
      for (let i = 0; i < targets.length; i++) {
        const el = targets[i];
        const badge = document.createElement("button");
        badge.type = "button";
        badge.setAttribute("data-help-badge", "1");
        badge.setAttribute("aria-label", "도움말 보기");
        badge.textContent = "?";
        badge.style.cssText = [
          "position:fixed", "width:18px", "height:18px", "border-radius:50%",
          "border:1.5px solid #ffffff", "background:#1a1712", "color:#ffffff",
          "font-size:11px", "font-weight:700", "line-height:1", "padding:0",
          "cursor:pointer", "z-index:99997", "display:flex", "align-items:center",
          "justify-content:center", "box-shadow:0 2px 6px rgba(0,0,0,.35)", "font-family:sans-serif"
        ].join(";");
        badge.addEventListener("click", (e) => {
          // 배지는 대상 요소의 자식이 아니라 body 에 별도로 붙는 독립 엘리먼트라
          // 원래 버튼의 클릭 핸들러가 구조적으로 실행되지 않는다. stopPropagation/
          // preventDefault 는 방어적 이중 안전장치다(요구: 원래 동작 차단).
          if (e.preventDefault) e.preventDefault();
          if (e.stopPropagation) e.stopPropagation();
          this.show(el, el.dataset ? el.dataset.help : el.getAttribute("data-help"));
        });
        document.body.appendChild(badge);
        this._badges.push({ badge, target: el });
      }
      this._reposition();
    },

    _unmountBadges() {
      this._badges.forEach(({ badge }) => { if (badge.parentNode) badge.parentNode.removeChild(badge); });
      this._badges = [];
    },

    _reposition() {
      this._badges.forEach(({ badge, target }) => {
        const rect = (target && target.getBoundingClientRect) ? target.getBoundingClientRect() : { left: 0, top: 0, width: 0 };
        badge.style.left = Math.max(0, rect.left + rect.width - 9) + "px";
        badge.style.top = Math.max(0, rect.top - 9) + "px";
      });
    },

    /** 도움말 팝업을 el 근처에 띄운다. content 없는 키는 "준비 중"으로 표시(조용한 실패 금지). */
    show(el, key) {
      this.hide();
      const content = this.get(key);
      const isPlaceholder = content == null;
      const text = isPlaceholder
        ? "[도움말 준비 중] 이 항목의 설명은 아직 작성되지 않았습니다."
        : content;
      if (isPlaceholder && typeof console !== "undefined" && console.warn) {
        console.warn("[Help] 정의되지 않은 도움말 키:", key);
      }

      const pop = document.createElement("div");
      pop.setAttribute("data-help-popup", "1");
      pop.setAttribute("role", "tooltip");
      pop.textContent = text;
      pop.style.cssText = [
        "position:fixed", "max-width:280px", "padding:10px 14px",
        "background:#1a1712", "color:#ffffff", "font-size:13px", "line-height:1.5",
        "border-radius:8px", "box-shadow:0 6px 20px rgba(0,0,0,.35)",
        "z-index:99999", "pointer-events:none", "font-family:sans-serif",
        isPlaceholder ? "font-style:italic" : "font-style:normal",
        "opacity:0.98"
      ].join(";");
      document.body.appendChild(pop);

      const rect = (el && el.getBoundingClientRect) ? el.getBoundingClientRect() : { left: 12, top: 12, bottom: 12, width: 0 };
      let left = rect.left, top = rect.bottom + 8;
      const vw = (typeof window !== "undefined" && window.innerWidth) || 1024;
      const vh = (typeof window !== "undefined" && window.innerHeight) || 768;
      const POP_W = 280;
      if (left + POP_W > vw - 8) left = Math.max(8, vw - POP_W - 8);
      if (top > vh - 60) top = Math.max(8, rect.top - 68);
      pop.style.left = left + "px";
      pop.style.top = top + "px";

      this._popup = pop;
      this._hideTimer = setTimeout(() => this.hide(), 6000);
      return pop;
    },

    hide() {
      if (this._hideTimer) { clearTimeout(this._hideTimer); this._hideTimer = null; }
      if (this._popup && this._popup.parentNode) this._popup.parentNode.removeChild(this._popup);
      this._popup = null;
    }
  };

  document.addEventListener("DOMContentLoaded", () => Help.init());

  /* ══════════════════════════════════════════
     INVITE — 프로젝트 초대 링크 수락 (?invite=<token>)
     [보안 P40] 초대는 더 이상 계정을 미리 만들지 않는다(기본 비밀번호 '1' 제거).
       링크를 연 본인이 이름 + 비밀번호를 직접 설정해야 계정이 생긴다.
       이미 계정이 있는 이메일이면 이름·비번을 다시 묻지 않고 멤버십만 추가한다.
  ══════════════════════════════════════════ */
  const Invite = {
    TOKEN_PARAM: "invite",
    _token: null,
    _info: null,

    init() {
      const $ = (id) => document.getElementById(id);
      $("inv-submit") && $("inv-submit").addEventListener("click", () => this.accept());
      $("invite-gate-cancel") && $("invite-gate-cancel").addEventListener("click", () => this.close());
      const pw2 = $("inv-pw2");
      if (pw2) pw2.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); this.accept(); } });
      return this.detect();
    },

    /** URL 에서 초대 토큰을 읽고 즉시 주소창에서 제거한다.
     *  (토큰은 1회용 자격증명 — 브라우저 히스토리/스크린샷/Referer 에 남기지 않는다.) */
    detect() {
      let t = null;
      try { t = new URLSearchParams(location.search).get(this.TOKEN_PARAM); } catch (e) { t = null; }
      if (!t) return false;
      this._token = t;
      try { history.replaceState({}, "", location.pathname); } catch (e) {}
      this.open();
      return true;
    },

    _err(msg) {
      const e = document.getElementById("inv-error");
      if (!e) return;
      if (msg) { e.textContent = msg; e.classList.remove("hidden"); }
      else { e.textContent = ""; e.classList.add("hidden"); }
    },

    async open() {
      const m = document.getElementById("invite-gate");
      if (!m || !this._token) return;
      this._err(null);
      m.classList.remove("hidden");
      requestAnimationFrame(() => m.classList.add("on"));
      const $ = (id) => document.getElementById(id);
      try {
        const r = await fetch("/api/invite/" + encodeURIComponent(this._token));
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { this._err(j.error || "초대 링크가 유효하지 않거나 만료되었습니다."); this._disable(); return; }
        this._info = j;
        $("inv-project") && ($("inv-project").textContent = j.project_name || j.project_id);
        $("inv-email") && ($("inv-email").textContent = j.email);
        const roleLabel = (typeof Auth !== "undefined" && Auth._ROLE_LABELS && Auth._ROLE_LABELS[j.role]) || j.role;
        $("inv-role") && ($("inv-role").textContent = roleLabel);
        // 기존 계정이면 이름/비번 입력을 숨긴다(다시 묻지 않는다)
        const fields = $("inv-newacct-fields");
        const existing = $("inv-existing-msg");
        if (fields) fields.classList.toggle("hidden", !j.needs_account);
        if (existing) existing.classList.toggle("hidden", !!j.needs_account);
        const sub = $("inv-submit");
        if (sub) sub.textContent = j.needs_account ? "계정 만들고 참여" : "프로젝트 참여";
        if (j.needs_account) setTimeout(() => { const n = $("inv-name"); n && n.focus(); }, 120);
      } catch (e) {
        this._err("네트워크 오류 — 인터넷에 연결한 뒤 초대 링크를 다시 열어 주세요.");
        this._disable();
      }
    },

    _disable() {
      const s = document.getElementById("inv-submit");
      if (s) s.disabled = true;
      const f = document.getElementById("inv-newacct-fields");
      if (f) f.classList.add("hidden");
    },

    close() {
      const m = document.getElementById("invite-gate");
      if (!m) return;
      m.classList.remove("on");
      setTimeout(() => m.classList.add("hidden"), 200);
    },

    async accept() {
      if (!this._token || !this._info) return;
      const $ = (id) => document.getElementById(id);
      this._err(null);
      const needs = !!this._info.needs_account;
      const name = needs ? (($("inv-name") || {}).value || "").trim() : "";
      const pw = needs ? (($("inv-pw") || {}).value || "") : "";
      const pw2 = needs ? (($("inv-pw2") || {}).value || "") : "";
      if (needs) {
        if (!name) { this._err("이름을 입력해 주세요."); return; }
        if (pw.length < 8) { this._err("비밀번호는 8자 이상이어야 합니다."); return; }
        if (pw !== pw2) { this._err("두 비밀번호가 일치하지 않습니다."); return; }
      }
      const btn = $("inv-submit"); const orig = btn ? btn.textContent : "";
      if (btn) { btn.disabled = true; btn.textContent = "처리 중..."; }
      try {
        const r = await fetch("/api/invite/" + encodeURIComponent(this._token) + "/accept", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(needs ? { name: name, password: pw } : {})
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { this._err(j.error || "참여에 실패했습니다."); return; }
        this._token = null;
        this.close();
        // 기존 CompanyAuth 로그인 완료 경로를 그대로 재사용한다(세션 저장 + 오프라인 검증자 + 설치 유도).
        if (typeof CompanyAuth !== "undefined" && CompanyAuth._onAuthed) {
          if (needs) CompanyAuth._pendingPw = pw;
          CompanyAuth._onAuthed(j.token, j.name || j.email, { email: j.email, name: j.name, role: j.role });
        }
      } catch (e) {
        this._err("네트워크 오류로 참여하지 못했습니다.");
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = orig; }
      }
    }
  };

  /* ══════════════════════════════════════════
     INSTALL — 모바일 "홈 화면에 설치" 유도 (PWA)
     · Android/Chrome: beforeinstallprompt 를 보관해 두었다가 사용자가 버튼을 누를 때 실행.
     · iOS(Safari): beforeinstallprompt 자체가 없다 → 공유→"홈 화면에 추가" 안내 문구로 대체.
     · 이미 설치된 상태(display-mode: standalone)면 절대 띄우지 않는다.
     · 배너는 하단 도크(.mobile-dock) 위로 띄운다 — 작업 화면을 가리지 않는다(CSS --mdock-h SoT).
  ══════════════════════════════════════════ */
  const Install = {
    DISMISS_KEY: "wm_install_dismissed",
    _deferred: null,

    init() {
      try {
        window.addEventListener("beforeinstallprompt", (e) => {
          e.preventDefault();          // 브라우저 기본 미니바 차단 → 우리 배너로 시점 제어
          this._deferred = e;
        });
        window.addEventListener("appinstalled", () => { this._deferred = null; this.hide(); });
      } catch (e) {}
      const $ = (id) => document.getElementById(id);
      $("pwa-install-accept") && $("pwa-install-accept").addEventListener("click", () => this.accept());
      $("pwa-install-close") && $("pwa-install-close").addEventListener("click", () => this.dismiss());
    },

    /** 이미 앱으로 설치돼 실행 중인가 */
    isStandalone() {
      try {
        if (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) return true;
      } catch (e) {}
      return !!(window.navigator && window.navigator.standalone);   // iOS Safari
    },

    /** iOS 계열(iPadOS 13+ 는 MacIntel + 터치로 보고된다) */
    isIOS() {
      const nav = window.navigator || {};
      const ua = String(nav.userAgent || "");
      if (/iPad|iPhone|iPod/.test(ua)) return true;
      return nav.platform === "MacIntel" && Number(nav.maxTouchPoints || 0) > 1;
    },

    _dismissed() {
      try { return localStorage.getItem(this.DISMISS_KEY) === "1"; } catch (e) { return false; }
    },

    /** 설치 안내를 띄워야 하는가 — 설치됨/거절함/설치수단 없음 이면 false */
    _shouldPrompt() {
      if (this.isStandalone()) return false;     // 🔴 이미 설치 → 안내 금지
      if (this._dismissed()) return false;
      return !!this._deferred || this.isIOS();   // 안드로이드=프롬프트 보유 / iOS=수동 안내
    },

    /** 로그인 직후 호출. 조건을 만족할 때만 배너를 띄운다. 반환: 띄웠는지 여부 */
    maybePrompt() {
      if (!this._shouldPrompt()) return false;
      const b = document.getElementById("pwa-install-banner");
      if (!b) return false;
      const ios = document.getElementById("pwa-install-ios");
      const btn = document.getElementById("pwa-install-accept");
      const isIos = this.isIOS() && !this._deferred;
      if (ios) ios.classList.toggle("hidden", !isIos);
      if (btn) btn.classList.toggle("hidden", isIos);
      b.classList.remove("hidden");
      requestAnimationFrame(() => b.classList.add("on"));
      return true;
    },

    hide() {
      const b = document.getElementById("pwa-install-banner");
      if (!b) return;
      b.classList.remove("on");
      setTimeout(() => b.classList.add("hidden"), 200);
    },

    dismiss() {
      try { localStorage.setItem(this.DISMISS_KEY, "1"); } catch (e) {}
      this.hide();
    },

    async accept() {
      const d = this._deferred;
      if (!d) { this.hide(); return false; }
      this._deferred = null;
      try {
        d.prompt();
        const choice = await d.userChoice;
        this.hide();
        return !!(choice && choice.outcome === "accepted");
      } catch (e) { this.hide(); return false; }
    }
  };

  /* ── 진입 ── */
  document.addEventListener("DOMContentLoaded", async () => {
    // [버그①수정 2026-08-31] App.init()이 Auth.init()(데모 자동로그인)을 await하므로
    // 여기서도 await해 ProjectHub.open() 등 하위 로직이 로그인 완료 후 실행되게 한다.
    await App.init();

    // [오프라인 작업지시서 ] 오프라인 상태 배지/네트워크 이벤트 연결
    if (typeof Offline !== "undefined" && Offline.init) { try { Offline.init(); } catch (e) {} }

    // [P40] PWA 설치 유도 배선 — beforeinstallprompt 는 페이지 초기에 발화하므로 먼저 등록한다.
    if (typeof Install !== "undefined" && Install.init) { try { Install.init(); } catch (e) {} }
    // [P40] 프로젝트 초대 링크(?invite=<token>) — 있으면 이름/비번 설정 모달을 띄운다.
    if (typeof Invite !== "undefined" && Invite.init) { try { Invite.init(); } catch (e) {} }

    // ── E2E 테스트 훅 (프로덕션 무해): 핀을 직접 주입해 UI 워크플로우 없이 검증 ──
    window.__wm = {
      State, App, AllPins, UI, MapCtrl, Auth, Settings, PinPrefs, PinSeries, PinIcons, Designers, Projects, ProjectHub, Prompt, PanoViewer, Radar, PanoNav, Brand, Notes, TimeLapse, Compare, Zones, Inspector, PinGrid, SyncQueue, Cloud, PDF, FLS, PinActionPop, CompanyAuth, PdfAnno, AdminPanels,
      Offline, OfflineBundle, OfflineLoad, OpLog, Invite, Install,
      UserMgmt: (typeof UserMgmt !== "undefined" ? UserMgmt : null),
      ThetaIntake: (typeof ThetaIntake !== "undefined" ? ThetaIntake : null),
      PdfPopup: (typeof PdfPopup !== "undefined" ? PdfPopup : null),
      addPin(p) {
        const pin = Object.assign({ id: "t" + Date.now() + Math.random().toString(36).slice(2,6), x: 50, y: 50, page: 1, label: "Pin" }, p);
        State.pins.push(pin);
        UI.renderPinList(); UI.renderPinsOnMap();
        return pin.id;
      }
    };

    const params  = new URLSearchParams(location.search);
    const urlMode = params.get("mode");
    const depId   = params.get("d");
    // [P61] 공유 주소 `/srview/<프로젝트명>-<토큰>` — 서버가 토큰을 이미 검증해 셸을 내줬다.
    //   여기서는 토큰으로 프로젝트/배포본만 해석해 **열람 전용**으로 연다(?d= 와 동일 취급).
    const shareTok = (typeof ShareLink !== "undefined") ? ShareLink.token() : null;
    if (shareTok) {
      State.viewerLocked = true;
      (async () => {
        // [P63] 🔴 도면보다 **먼저** 초대코드 게이트를 지난다. 통과 전에는 서버가 데이터를 주지 않으므로
        //   여기서 먼저 통행증을 받아야 뒤의 열람 요청이 성립한다(UI 가리기가 아니다).
        if (typeof ShareGate !== "undefined") await ShareGate.ensure({ t: shareTok });
        const j = await ShareLink.resolve();
        if (!j || !j.project) {
          // 해석 실패(링크 해제/삭제) — 조용한 빈 화면 대신 이유와 재요청처를 보여준다.
          if (typeof ShareGate !== "undefined") ShareGate.showDeadLink();
          return;
        }
        App.openApp("viewer", { project: { id: j.project.id, name: j.project.name } });
      })();
    } else if (depId) {
      // [마스터 2026-09-13] 뷰어는 배포 링크(?d=배포ID) 전용 — mode=viewer 단독은 디자이너로 보낸다.
      State.viewerLocked = true;
      (async () => {
        // [P63] 🔴 `?d=` 에도 같은 게이트를 적용한다 — 적용하지 않으면 이 경로가 게이트 우회로가 된다.
        //   링크가 죽는 게 아니라 코드 입력 화면이 먼저 뜰 뿐이라 하위호환은 그대로다.
        if (typeof ShareGate !== "undefined") await ShareGate.ensure({ d: depId });
        App.openApp("viewer");
      })();
    } else if (urlMode === "designer") {
      // 설계자 직접 진입 — 로그인+디자이너 권한 필요, 통과 시 프로젝트 허브로
      Auth.requireDesigner(() => ProjectHub.open());
      ProjectHub.open();
    } else {
      // [멀티테넌트] <name>.seastar.work 서브도메인이면 그 프로젝트로 바로 진입, 아니면 허브.
      (async () => {
        try {
          const t = await fetch('/api/tenant/resolve').then(r => r.json());
          if (t && t.matched && t.project && t.project.id) {
            if (typeof Projects !== 'undefined') Projects.currentProject = { id: t.project.id, name: t.project.name };
            // [마스터 2026-09-13] 뷰어는 배포 링크(?d=배포ID) 전용 — 서브도메인 자동진입은 디자이너로 고정한다.
            // 원복(뷰어 자동진입 부활) 시 아래 줄로 교체: App.openApp((typeof Auth !== 'undefined' && Auth.isDesigner) ? 'designer' : 'viewer', { project: { id: t.project.id, name: t.project.name } });
            App.openApp((typeof PinSeries !== 'undefined' ? PinSeries.preferredMode() : 'designer'), { project: { id: t.project.id, name: t.project.name } });
            return;
          }
        } catch (e) {}
        // ── 첫 화면 = 프로젝트 선택 대시보드 (상용툴 모방) ──
        ProjectHub.open();
      })();
    }

    /* ── 360° 테스트 훅: ?demo360=<이미지URL> 로 파노라마 직접 오픈 ── */
    const demo = params.get("demo360");
    if (demo) {
      PanoViewer.loadMedia(decodeURIComponent(demo), "TEST PANORAMA");
    }
  });

})();
