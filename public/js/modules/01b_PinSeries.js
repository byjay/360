
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
    LABELS: { content: "360", empty: "미배치", checkboard: "CHECKER", all: "전체" },   // all = [WO 20261019-unifymode] 통일 후 대상 범위
    FILTER_KEY: "wm-pin-filter",
    /* [WO 20261019-unifymode] 구 SERIES(필터 바 2칩 = CHECKER/360) 폐기 — 필터는 PHOTO_FILTERS(사진 유무 3종). */

    /* [WO 20260929 2모드 전환, 지휘자 정정] 편집화면 진입 기본 모드 = CHECKER(checkboard).
       구 3버튼(보기/체크보드/사진등록) 중 [보기]가 세그먼트에서 제거되며, 과거 이 값에
       저장되던 "designer"(=구 [보기]/등록모드)는 더 이상 선택 가능한 목적지가 아니다 —
       기존에 저장된 "designer" 값은 진입 시 "checkboard" 로 정규화한다(디자이너 UI에서
       도달 불가능한 값을 SoT가 계속 반환하면 안 됨). SoT: 이 값 하나만 — App.openApp
       호출부들은 전부 preferredMode()를 참조하고, 하드코딩된 값을 직접 쓰지 않는다.
       🔴 저장된 기존 핀의 checkboard/kind 해석은 이 값과 무관 — 이건 오직
          "새 배치 시작 시 어느 모드로 열리는가"만 결정한다. */
    /* 🔴 [WO 20261019-unifymode] 마스터: "360 과 체커 통일하고, 번호만 매긴 후 사진 일괄 등록할지, 현장에서 번호
       매기고 사진 등록할지를 결정하게 해. 옵션으로." — CHECKER/360 "모드(작업공간)" 구분을 폐기하고 핀은 하나로 합친다.
       남는 것은 **등록 방식** 하나(탭했을 때 사진 선택창을 여느냐)뿐이다. 내부 값 State.regMode('checkboard'|'photo')는
       이 방식의 인코딩으로만 남긴다(클릭 분기·도크 버튼 등 호출부 수십 곳 불변 — 이름만 옛것).
         batch : [번호 먼저 → 사진은 나중에 일괄] = regMode "checkboard" — 탭 = 번호 핀만(60 폴더·67 다중·69 촬영 세션으로 일괄)
         each  : [찍을 때마다 사진]              = regMode "photo"      — 탭 = 번호 핀 + 즉시 사진 선택(autoConnectPin·60 하나씩·THETA)
       저장 단위 = 구역(시트 묶음): 지금 구역의 sheet_link 묶음 → 없으면 최상위 구역(영역은 부모 구역을 따른다) → 구역이
       없으면 프로젝트. 기기별 localStorage(마이그레이션 0 — 현장 작업 습관은 사람·기기마다 달라 서버 공유 기본값이 오히려
       남의 흐름을 바꾼다). 기본값 = batch(근거: ① 종전 편집 진입 기본 = CHECKER(DEFAULT_MODE) ② 탭마다 파일창이 뜨지 않아
       오조작·모바일 user-activation 실패가 없다 ③ 사진은 언제든 일괄로 채울 수 있지만, 사진창이 먼저 뜨면 번호 배치가 끊긴다). */
    REG_METHODS: [
      { key: "batch", regMode: "checkboard", label: "번호 먼저", desc: "번호만 먼저 찍고 사진은 나중에 일괄 등록" },
      { key: "each",  regMode: "photo",      label: "바로 사진", desc: "찍을 때마다 그 자리에서 사진 등록" }
    ],
    DEFAULT_REG_METHOD: "batch",
    REG_METHOD_PREFIX: "wm-reg-method:",
    _regMethodBy(key, val) { return this.REG_METHODS.find((m) => m[key] === val) || null; },
    /** 저장 단위 키 = 프로젝트 + 구역(시트 묶음 → 최상위 구역). 구역 없음 = "-". */
    regScopeKey(deck) {
      const pid = (typeof State !== "undefined" && State && State.currentProjectId)
        || (typeof Projects !== "undefined" && Projects && Projects.currentProject && Projects.currentProject.id) || "-";
      let d = deck !== undefined ? deck : ((typeof Projects !== "undefined" && Projects) ? Projects.currentDeck : null);
      let sid = "-";
      try {
        if (d && typeof Projects !== "undefined" && Projects) {
          const bundle = Projects.sheetBundleOf ? Projects.sheetBundleOf(d) : null;
          const chain = Projects._deckChain ? Projects._deckChain(d) : [d];
          const top = bundle || chain[chain.length - 1] || d;
          if (top && top.id != null) sid = String(top.id);
        } else if (d && d.id != null) sid = String(d.id);
      } catch (e) { sid = (d && d.id != null) ? String(d.id) : "-"; }
      return String(pid) + ":" + sid;
    },
    /** 등록 방식 key("batch"|"each") — 저장값이 없거나 비정상이면 DEFAULT_REG_METHOD. */
    regMethod(scopeKey) {
      const k = this.REG_METHOD_PREFIX + (scopeKey || this.regScopeKey());
      let v = null;
      try { v = localStorage.getItem(k); } catch (e) { v = null; }
      if (v == null) v = this._mem[k];
      return this._regMethodBy("key", v) ? v : this.DEFAULT_REG_METHOD;
    },
    setRegMethod(method, scopeKey) {
      if (!this._regMethodBy("key", method)) return null;
      const k = this.REG_METHOD_PREFIX + (scopeKey || this.regScopeKey());
      this._mem[k] = method;
      try { localStorage.setItem(k, method); } catch (e) {}
      return method;
    },
    regModeOfMethod(method) { const m = this._regMethodBy("key", method); return m ? m.regMode : "checkboard"; },
    methodOfRegMode(regMode) { const m = this._regMethodBy("regMode", regMode); return m ? m.key : this.DEFAULT_REG_METHOD; },
    /** 편집 진입 시 열 regMode = 지금 구역에 저장된 등록 방식(App.openApp 호출부 전부가 이 값 하나만 쓴다). */
    preferredMode() { return this.regModeOfMethod(this.regMethod()); },
    /** 하위호환(구 호출부) — "checkboard"/"photo" 를 지금 구역의 등록 방식으로 저장. 구 "designer" 값은 무시. */
    setPreferredMode(mode) { if (mode === "checkboard" || mode === "photo") this.setRegMethod(this.methodOfRegMode(mode)); },

    /* ── 색상 정본 ────────────────────────────────────────────
       머리색(head/head2) · 바늘끝(needle) · 숫자 글자색(text).
       숫자는 흰 디스크(#fff) 위에 놓이므로 text ↔ #fff 대비가 판독 기준.
       실측(WCAG 2.1 상대휘도):
         content(사용자 팔레트) : 6.40 ~ 9.00 : 1  (PinPrefs.PALETTE 6종 전부 4.5:1 초과)
         empty  #991b1b         : 8.27 : 1
         checkboard #1e3a8a     : 10.49 : 1
       ⚠ 색만으로 구분하지 않는다(색맹 8%) — ring 패턴(solid/dotted/dashed)을 함께 준다. */
    /* [WO 20261019-unifymode] needle #7f1d1d → #dc2626 — 통일 후 "사진 없음" 핀이 구 체커 핀까지 맡는다(주황 쌍 폐기). 미니맵 점 배경 = needle 이라
       사진 있음(콘텐츠 팔레트 needle, 흰 숫자 8.96~13.0:1 → L 0.03~0.067)과 명도로도 갈려야 한다(p9 등록↔미등록 분리 ≥1.8 — 구 체커 쌍 요건 계승).
       실측(WCAG 2.1): #dc2626 ↔ 흰 숫자 4.83:1(≥4.5) · ↔ 흰 도면 4.83:1(≥3) · 팔레트 needle 6종과 분리 1.86~2.69:1(≥1.8). 종전 #7f1d1d 는 1.03:1(초록과 같은 명도). */
    EMPTY_COLOR: { head: "#ef4444", head2: "#b91c1c", needle: "#dc2626", text: "#991b1b" },
    /* [WO 20260930-pinstyle, 지휘자 발주] "핀 색이나 형태를 모드별로 구분" — CHECKER(체크보드)는
       360(콘텐츠)의 블루/그린 계열과 확실히 갈리도록 주황/앰버 계열로 재색상화(구 인디고 블루 폐기).
       도면 마커(11_UI)가 CHECKER 전용 둥근사각 배지 프레임도 함께 그려 형태도 같이 구분한다.
       실측(WCAG 2.1, 흰 배경 기준 — .tmp/contrast_calc4.mjs, p9·p18 두 테스트의 요건을 함께 충족):
         등록   head2 #431407 15.65:1 · needle #431407 15.65:1 · text #431407 15.65:1
         미등록 head2 #ea580c 3.56:1  · needle #9a3412 7.31:1  · text #9a3412 7.31:1
         등록↔미등록 needle 상호 분리도 2.14:1(p9 ≥1.8) · head 상호 분리도 3.83:1(p18 ≥3, WCAG 1.4.11)
         · head2 상호 분리도 4.40:1(p18 ≥3) */
    CHECKBOARD_COLOR: { head: "#c2410c", head2: "#431407", needle: "#431407", text: "#431407" },
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
    // [WO 20260930-pinstyle] 위 CHECKBOARD_COLOR 와 같은 주황 계열(명도만 갈라 등록/미등록 구분,
    // 구조는 불변 — 필터/판정 로직은 색상값과 무관하다). 실측 값은 위 CHECKBOARD_COLOR 주석 참조.
    CHECKBOARD_EMPTY_COLOR: { head: "#fed7aa", head2: "#ea580c", needle: "#9a3412", text: "#9a3412" },

    /* 형태 단서 정본(색각 이상 8% 대비) — 도면 링 dasharray 와 미니맵 점 테두리가
       같은 이름 하나에서 파생된다. 두 곳에 따로 쓰면 반드시 갈라진다(§10 SoT).
         solid  = 콘텐츠 등록됨 / dashed = 체크보드(등록됨) / dotted = 미등록 */
    PATTERN: {
      solid:  { dash: "",        border: "solid"  },
      dotted: { dash: "2.6 2.6", border: "dotted" },
      dashed: { dash: "6 3.4",   border: "dashed" }
    },

    /** [WO 20260929 photo-time-match] 핀 생성시각 SoT(ms, Date.now() 기준) — 명시 필드
     *  우선, 없으면 pin.id 가 Date.now() 로 채번된 숫자(20_App.js _placeCheckboardPin:1513,
     *  _confirmPinInstant:2068 — 둘 다 id=Date.now() 만 있고 별도 createdAt 필드가 없다)라고
     *  판단되면 그 값을 파생해 쓴다. 못 구하면 null(가짜 시각을 만들지 않는다 — §10 하드코딩 금지).
     *  [WO 20260929-createdAt] 20_App.js 생성 지점 3곳(_placeCheckboardPin · _confirmPinInstant ·
     *  폼 신규 np)이 이제 createdAt 을 명시 저장한다. id 파생은 그 이전에 만든 핀(필드 없음)용 폴백. */
    createdAt(pin) {
      if (!pin) return null;
      if (Number.isFinite(pin.createdAt)) return pin.createdAt;
      // Date.now() 는 1970-01-01 이후 ms — 2001-09-09 이후(1e12) 값이면 타임스탬프로 간주.
      if (Number.isFinite(pin.id) && pin.id > 1e12) return pin.id;
      return null;
    },

    /** 핀에 콘텐츠(360/영상/첨부/노트/3D)가 있는가 — App.pinHasContent 가 정본 */
    hasContent(pin) {
      if (typeof App !== "undefined" && App.pinHasContent) { try { return !!App.pinHasContent(pin); } catch (e) {} }
      return !!(pin && (pin.imageId || pin.imageUrl || pin.videoId));
    },

    /** 색상 부류 — [WO 20261019-unifymode] 🔴 핀 상태는 사진(콘텐츠) 유무 하나로만 보인다(content = 사진 있음 / empty =
     *  번호만). 구 pin.checkboard 는 읽기 전용 메타 — 색·형태·필터 판정에 쓰지 않는다(같은 핀이 생성 모드에 따라 달라 보이면
     *  "통일"이 아니다). colorsOf("checkboard") 는 구 호출부·테스트 호환으로만 남는다. */
    kindOf(pin) {
      if (!pin) return "empty";
      return this.hasContent(pin) ? "content" : "empty";
    },

    /** 채번 계열 (2종) */
    seriesOf(pin) { return (pin && pin.checkboard) ? "checkboard" : "content"; },

    /* ══ 모드 = 작업공간 [WO 20260930-fixmode] ══════════════════════════════
       마스터: "체커와 360을 완전히 다른 프로젝트처럼 구분 — 프로젝트 하위 최상단에 체커/360,
       그 하위로 구역-영역". 🔴 이 표 하나가 모드(regMode) ↔ 핀 계열(series) ↔ 구역 태그(decks.mode)
       ↔ 표시 이름의 유일한 대응표다. 지도 마커·미니맵·필터 칩·핀 목록·사이드바 트리·허브 카드 트리가
       전부 아래 함수만 부른다(각자 판정하면 반드시 갈라진다 — §10 SoT).
       decks.mode = NULL(마이그레이션 0029 이전 기존 구역)은 두 모드 모두에 보인다(유실 0). */
    /*  🔴 [WO 20261019-unifymode] 위 "모드 = 작업공간" 표(DECK_MODES)·activeMode/activeSeries/deckModeTag/withDeckMode/
        deckInMode 를 폐기했다 — 트리 모드 잎·허브 모드 잎·AllPins 모드 탭·RegionMerge 계열 거름이 그 유일한 소비자였고
        전부 [전체/사진 있음/사진 없음] 필터(PHOTO_FILTERS)로 대체됐다. 구역 생성 태그는 이미 moderole 에서 no-op
        (31_Projects._withDeckMode). decks.mode 컬럼(0029)·서버 검증은 비파괴로 남는다(클라이언트가 보내지 않음). */
    /** 핀이 지정 계열에 속하는가(구 메타 기준 — 묶음 표시용, 숨김 판정 아님).
     *  🔴 [WO 20261015-numunify] 활성 모드는 더 이상 가시성을 잠그지 않는다(설계 §1-1 — CHECKER 에서 찍은 핀이
     *  360 에서 안 보이면 사진 폴더 일괄 등록 대상이 0건이 된다). 모드 = "클릭 시 사진창 여부"만.
     *  series 를 **명시**하면(트리 모드 잎 묶음 등) 생성 계열로 가른다 — 숨김이 아니라 묶음 표시용. */
    inMode(pin, series) {
      if (series === undefined || series === null) return true;
      return this.seriesOf(pin) === series;
    },
    /** 활성 모드 작업공간의 핀만 */
    modePins(pins) { return (pins || []).filter((p) => p && this.inMode(p)); },

    /** [WO 20260929 addendum] 🔴 표시 번호 포맷 정본 — CHECKER 계열은 숫자 그대로, 360 계열은
     *  "P" 접두(마스터: "번호체계도 다르게 해"). 마커 머리(11_UI)·미니맵(07_Radar)·트리 행(11_UI)
     *  등 번호를 보여주는 모든 곳이 이 함수 하나만 부른다 — 각자 접두를 붙이면 반드시 갈라진다
     *  (전역 CLAUDE.md §10 SoT). 27_PinActionPop.js 패널 헤더는 현재 이 정본을 쓰지 않는 별도
     *  버그(samePage.indexOf 자체 채번)가 있어 이관 대상이나, 그 파일은 다른 팀 점유라 이번 턴엔
     *  손대지 않는다(지휘자 보고 대상). */
    //  🔴 [WO 20261015-numunify] "P" 접두 폐기 — 마스터: "체크 모드와 360 모드 번호를 하나로 합치고 … 번호는 공통적으로 하나로 관리".
    //  번호 공간이 (배포본, 페이지) 1개가 되어 계열 구분 접두가 필요 없다. 화면 = "1","2","3"(한 자리 그대로).
    //  시그니처(no, series)는 유지 — 호출부 20곳 수정 0. 🔴 매칭(사진 파일명)에는 쓰지 마라 — 정본 = PhotoFolder.matchKey(no).
    //  [WO 20261016-multisheet P5] 접두 표시는 _fmtText/textOf 가 맡는다 — formatNo 는 순수 숫자 표기 그대로(시그니처·값 불변).
    formatNo(no, series) { return String(no); },
    /** 접두(구분자 포함)·자릿수 반영 표시 — 접두 없으면 formatNo 그대로(= 종전과 바이트 동일). numbers() 의 meta.text 생성 1곳. */
    _fmtText(no, series, prefix, pad, suffix) {
      if (!prefix && !suffix) return this.formatNo(no, series);
      return String(prefix || "") + (pad ? String(no).padStart(pad, "0") : String(no)) + String(suffix || "");
    },
    /** numbers() 메타 → 표시 문자열(A12 / 12). 표시 호출부 12곳이 이 한 함수만 부른다(§3-4 SoT, T6 정적 검사). */
    textOf(meta) {
      if (!meta) return "";
      if (meta.text != null) return String(meta.text);
      return this.formatNo(meta.no, meta.series);
    },

    /* ══ [WO 20261016-multisheet P5] 영숫자 번호(A1 / A001 / ER-12 / B2-05) — label 이 전체 문자열(SoT), 접두는 파생 ══
       🔴 greedy 함정: 1갈래는 글자만([A-Za-z]{1,6}) — "A12" 가 "A1"+"2" 로 쪼개지지 않는다. 글자+숫자 접두는 구분자 필수(2갈래).
       왕복 무손실: parseLabel(s).text === s.trim() (설계 §3-1 실측 8/8). 순수 숫자는 prefix "" — 모든 경로가 종전과 같다. */
    //  [WO 20261016-bulkedit] 뒤 글자(접미) — 구분자 필수([-_] + 글자 시작, 예 1-F · 12_R2). "A1B2"·"2ND" 는 종전처럼 null(자유 텍스트).
    LABEL_RX: /^\s*(?:([A-Za-z]{1,6})([-_]?)|([A-Za-z][A-Za-z0-9]{0,5})([-_]))?(\d{1,6})([-_][A-Za-z][A-Za-z0-9]{0,5})?\s*$/,
    parseLabel(raw) {
      const m = this.LABEL_RX.exec(String(raw == null ? "" : raw));
      if (!m) return null;
      const prefix = m[1] != null ? m[1] : (m[3] != null ? m[3] : "");
      const sep = m[1] != null ? (m[2] || "") : (m[3] != null ? (m[4] || "") : "");
      const digits = m[5];
      const no = parseInt(digits, 10);
      const pad = (digits.length > 1 && digits.charAt(0) === "0") ? digits.length : 0;
      const suffix = m[6] || "";
      return { prefix: prefix, sep: sep, no: no, pad: pad, suffix: suffix, text: prefix + sep + (pad ? String(no).padStart(pad, "0") : String(no)) + suffix };
    },
    /** 접두 비교 키 — 대소문자·구분자 무시("ER-" = "er" = "ER"). 순수 숫자 = "". */
    prefixKey(prefix) { return String(prefix == null ? "" : prefix).replace(/[-_]$/, "").toUpperCase(); },
    /** 핀 label 의 (접두키, 번호) — 순수 숫자는 종전 판정(/^\d+$/) 그대로, 접두 있는 번호만 parseLabel. 번호가 아니면 null. */
    noKeyOf(label) {
      const raw = String(label == null ? "" : label).trim();
      if (/^\d+$/.test(raw)) return { key: "", no: parseInt(raw, 10), prefix: "", sep: "" };
      const pl = this.parseLabel(raw);
      if (!pl || !(pl.prefix || pl.suffix)) return null;
      // 접미가 있으면 키에 포함(1-F 와 1-R 은 다른 번호) — 접두만 있으면 종전 키 그대로
      return { key: this.prefixKey(pl.prefix) + (pl.suffix ? "~" + pl.suffix.slice(1).toUpperCase() : ""), no: pl.no, prefix: pl.prefix, sep: pl.sep, suffix: pl.suffix };
    },
    /** 접두(구분자 포함, 예 "A" / "ER-") + 번호 → label. 접두 없으면 String(no) = 종전. */
    labelOf(prefix, no, suffix) { return (prefix ? String(prefix) : "") + String(no) + (suffix ? String(suffix) : ""); },
    /** 정렬 SoT — 순수 숫자 먼저, 그다음 접두 사전순, 같은 접두 안에서는 번호 오름차순(A2 < A10 < B1). map = numbers() 결과(선택). */
    byNumber(a, b, map) {
      const m = (p) => {
        const i = map && p && map.get ? map.get(p.id) : null;
        if (i) return { k: this.prefixKey(i.prefix || ""), no: Number.isFinite(i.no) ? i.no : Infinity };
        const nk = p ? this.noKeyOf(p.label) : null;
        return nk ? { k: nk.key, no: nk.no } : { k: "￿", no: Infinity };
      };
      const x = m(a), y = m(b);
      if (x.k !== y.k) return x.k === "" ? -1 : (y.k === "" ? 1 : (x.k < y.k ? -1 : 1));
      return x.no - y.no;
    },

    /* ══ [WO 20261016-multisheet P2] 번호 공간 = 시트 묶음 — 단일 지점 ══════════════════════════════
       scopePages(page) 가 [page] 를 돌려주면 numbers·nextInBand·duplicateNoIds·resolveConcurrentNos·resetPlan 계산은
       종전과 바이트 단위로 같다(연결 OFF / 묶음 없음 / Projects 미정의 / 다른 배열 = 전부 [page]). 묶음 판정은
       어댑터 Projects.sheetPagesOf(page) 한 곳(31_Projects)에만 있다.
       pins 를 넘겼는데 그게 State.pins 가 아니면(납품·합치기 미리보기 등 다른 배포본 배열) 항상 [page] — 로드된 도면의 묶음을 섞지 않는다. */
    scopePages(page, pins) {
      const pg = page || 1;
      if (pins !== undefined && !(typeof State !== "undefined" && State && pins === State.pins)) return [pg];
      let s = null;
      try { if (typeof Projects !== "undefined" && Projects && Projects.sheetPagesOf) s = Projects.sheetPagesOf(pg); } catch (e) { s = null; }
      if (!Array.isArray(s) || !s.length || s.indexOf(pg) < 0) return [pg];
      return s;
    },
    /** 자동 채번 접두(구분자 포함, 예 "A" / "ER-") — 어댑터 Projects.numPrefixOf() 1곳. 없거나 다른 배열이면 ""(= 순수 숫자, 종전). */
    prefixFor(pins) {
      if (pins !== undefined && !(typeof State !== "undefined" && State && pins === State.pins)) return "";
      try { if (typeof Projects !== "undefined" && Projects && Projects.numPrefixOf) return Projects.numPrefixOf() || ""; } catch (e) {}
      return "";
    },
    /** 연결 묶음 키(같은 linkId = 같은 논리 핀) — PinLink 미로드 시에도 동작(순수). */
    _unitKey(p) { return (p && p.linkId != null && p.linkId !== "") ? "L" + String(p.linkId) : "I" + String(p && p.id); },

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
      // [WO 20261016-multisheet P3] 🔴 연결 멤버는 대표의 사진·내용으로 판정한다(사진은 대표에만 — "사진 없음"으로 보이면 결함).
      //   연결 없는 핀 = headOf 가 자기 자신을 돌려준다(종전 그대로).
      pin = (typeof PinLink !== "undefined" && PinLink && PinLink.headOf && typeof State !== "undefined" && State) ? PinLink.headOf(State.pins, pin) : pin;
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
     * - 🔴 [WO 20261015-numunify] 번호 공간 = 페이지 1개 — 계열(content/checkboard) 무관 단일 카운터.
     *   반환 shape {no, kind, series} 불변(series/kind 는 색·필터가 계속 쓴다).
     * - 체크보드 핀은 저장된 pin.label 숫자를 우선 사용(기존 저장 데이터 불변 · 마이그레이션 없음).
     * - 🔴 항상 "필터와 무관하게 전체 핀"으로 계산한다 → 필터를 켜도 번호가 재계산되지 않는다.
     */
    numbers(pins, page, base) {
      const map = new Map();
      const pg = page || 1;
      let n = 0;   // [WO 20261015-numunify] 단일 카운터(계열별 2카운터 폐기)
      // [WO 20261016-multisheet P2] 번호 공간 = 시트 묶음(scopePages) — 연결 OFF 면 [pg] 라 종전과 같다.
      //   묶음 전체로 세되 결과(map)에는 요청 페이지 핀만 싣는다(소비자 12곳의 "그 페이지 핀만" 가정 불변).
      const scope = this.scopePages(pg, pins);
      const inScope = scope.length === 1 ? null : new Set(scope);
      const onScope = (p) => inScope ? inScope.has(p.page || 1) : (p.page || 1) === pg;
      // [WO 20261012-pinsync] 구역(별칭) 화면 = 원본 그 페이지 핀 집합 기준으로 센다(같은 핀 = 같은 번호). 원본 화면은 base 없음 → 종전 그대로.
      const all = this._withBase(pins, pg, base);
      const mine = all === pins ? null : new Set((pins || []).filter((p) => p && p.id != null).map((p) => String(p.id)));
      const full = inScope ? new Map() : null;   // 묶음 안 전원(연결 멤버 정렬용) — 연결 OFF 면 만들지 않는다
      all.forEach((p) => {
        if (!p) return;
        if (!onScope(p)) return;
        const series = this.seriesOf(p);
        let no, pre = "", pad = 0, suf = "";
        const raw = String(p.label == null ? "" : p.label).trim();
        const pl0 = /^\d+$/.test(raw) ? null : this.parseLabel(raw);   // [P5] 접두·접미 번호(A12 · 1-F)만 — 순수 숫자는 종전 판정 그대로
        const pl = (pl0 && (pl0.prefix || pl0.suffix)) ? pl0 : null;
        if (pl) { pre = pl.prefix + pl.sep; pad = pl.pad; suf = pl.suffix; }
        n++;
        if (series === "checkboard") {
          const lbl = parseInt(p.label, 10);
          no = Number.isFinite(lbl) ? lbl : n;
          if (pl) no = pl.no;   // [P5] 접두 번호(A12) — parseInt 는 NaN 이라 위에서 순번이 됐다
        } else if (pl) { no = pl.no;
        } else {
          // [WO 20261001-startno] 360 도 대역 번호(P101…)를 보여야 한다 — label 이 순수 숫자면 그 값,
          //   아니면(자유 텍스트 이름·label 없음) 종전 페이지 내 순번. prod 360 핀 8개(label "1"~"8")는 실측상
          //   순번과 label 이 같아 표시 번호가 바뀌지 않는다(.tmp 조회 diff 0).
          no = /^\d+$/.test(raw) ? parseInt(raw, 10) : n;
        }
        const meta = { no: no, kind: this.kindOf(p), series: series, prefix: pl ? pl.prefix : "", sep: pl ? pl.sep : "", pad: pad, suffix: suf, text: this._fmtText(no, series, pre, pad, suf) };
        if (full) full.set(String(p.id), { p: p, meta: meta });
        if ((p.page || 1) !== pg) return;
        if (mine && !mine.has(String(p.id))) return;   // 원본에만 있는(구역 상자 밖) 핀은 결과에 싣지 않는다 — 순번 계산에만 쓴다
        map.set(p.id, meta);
      });
      // [P3] 연결 멤버 = 대표와 같은 번호(label 이 자유 텍스트여도 순번이 갈라지지 않게) — 대표가 묶음 안에 있을 때만.
      if (full) map.forEach((meta, id) => {
        const me = full.get(String(id));
        const lk = me && me.p.linkId != null && me.p.linkId !== "" ? String(me.p.linkId) : null;
        if (!lk || lk === String(id)) return;
        const head = full.get(lk);
        if (head && !head.p._deleted) map.set(id, Object.assign({}, head.meta, { kind: meta.kind, series: meta.series }));
      });
      return map;
    },

    /** [WO 20261012-pinsync] 번호 기준 집합(SoT) — 벡터 복사 구역은 핀 정본이 원본이라(서버 별칭) 화면 핀이 원본의 부분집합이다.
     *  그대로 세면 360 순번이 원본과 어긋나고, 다음 번호(최댓값+1)가 상자 밖 원본 핀 번호와 겹친다.
     *  base = 원본 그 페이지 핀 최소 사본 [{id,page,label,checkboard}](서버 base_pins_min → State.basePins, 구역 좌표계 page=1).
     *  합친 목록 = 원본 순서(번호 순번이 배열 순서에 묶임) · 화면 핀이 같은 id 를 덮음(편집 중 라벨 반영) · 원본에 아직 없는 새 핀은 뒤에.
     *  기본값: base 를 안 넘기고 pins 가 **바로 State.pins** 일 때만 State.basePins — 다른 배열(납품·합치기 미리보기 등)은 그대로.
     *  base 없음(원본 화면·구버전 서버) = pins 그대로(종전 동작 불변). */
    _withBase(pins, page, base) {
      if (base === undefined) base = (typeof State !== "undefined" && State && pins === State.pins) ? State.basePins : null;
      const arr = pins || [];
      if (!Array.isArray(base) || !base.length) return arr;
      const pg = page || 1;
      const local = new Map();
      arr.forEach((p) => { if (p && p.id != null && (p.page || 1) === pg) local.set(String(p.id), p); });
      const out = [], seen = new Set();
      base.forEach((b) => {
        if (!b || b.id == null || (b.page || 1) !== pg) return;
        const k = String(b.id);
        if (seen.has(k)) return;
        seen.add(k);
        out.push(local.has(k) ? local.get(k) : b);
      });
      arr.forEach((p) => { if (p && !(p.id != null && seen.has(String(p.id)))) out.push(p); });
      return out;
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
    nextCheckboardNo(pins, page, start, author) { return this.nextSeriesNo(pins, page, start, author, "checkboard"); },

    /** [WO 20260929 addendum] 🔴 위 nextCheckboardNo() 를 2계열(checkboard/content=360)로 일반화.
     *  마스터: "번호체계도 다르게 해" — 360(photo) 핀도 같은 페이지·같은 계열끼리만 최댓값+1
     *  로 다음 번호를 계산한다(계열이 섞이면 서로 번호를 침범한다). 기본값 series="checkboard"
     *  라 기존 nextCheckboardNo() 호출부·테스트는 전부 그대로 동작한다(하위호환, 시그니처 불변).
     *  🔴 [WO 20260930-numdup] author 인자는 **무시**한다(시그니처만 하위호환). 작성자별로 걸러
     *  보면 남의 번호를 못 봐서, B 가 A 의 1·2 를 로드한 상태에서도 B 의 다음 번호가 A 와 겹쳤다
     *  (p93 B4 실측: 서버 라벨 ["1","1"]). 이제 로드된 **전원 핀**의 최댓값+1 — 시작번호(사용자
     *  대역 포함)는 하한으로만 쓴다. 대가: 대역 A=100 이 B 의 200 을 본 뒤엔 201 로 이어진다
     *  (대역 침범 — 번호 유일성이 우선). 서로 보기 전에 동시에 만든 겹침은 저장 병합 때
     *  resolveConcurrentNos() 가 재채번한다.
     *  🔴 [WO 20261001-startno] 대역 우선 — 위 "대역 침범 허용"을 폐기한다(마스터 확정: 100 단위 대역).
     *  다음 번호 = 내 대역(band, 생략 시 start 가 속한 대역) 안의 전원 같은 계열 핀 최댓값+1, 대역 밖 핀은 무시.
     *  start 는 그 대역 안에서만 하한으로 쓴다. 대역이 가득 차면 null(넘쳐 들어가지 않는다 — 호출부가 확인창). */
    nextSeriesNo(pins, page, start, author, series, band, base) {
      const s = (Number.isFinite(start) && start >= 1) ? start : 1;
      const k = (Number.isFinite(band) && band >= 1) ? band : this.bandOf(s);
      return this.nextInBand(pins, page, series, k, s, base).no;
    },

    /* ══ [WO 20261001-startno] 100 단위 번호 대역 정본 ══════════════════════════════
       대역 k = (k-1)*BAND_SIZE+1 … k*BAND_SIZE (1–100, 101–200 …). CHECKER·360 이 같은 대역 번호 k 를 쓰되
       번호는 계열마다 독립 증가한다. 대역 배정은 서버(project_members.num_band) SoT — 이 객체는 계산만 한다. */
    BAND_SIZE: 100,
    bandOf(no) {
      const n = parseInt(no, 10);
      return (Number.isFinite(n) && n >= 1) ? Math.floor((n - 1) / this.BAND_SIZE) + 1 : 1;
    },
    bandRange(k) {
      const b = (Number.isFinite(k) && k >= 1) ? Math.floor(k) : 1;
      return { band: b, lo: (b - 1) * this.BAND_SIZE + 1, hi: b * this.BAND_SIZE };
    },
    bandLabel(k) { const r = this.bandRange(k); return r.lo + "–" + r.hi; },
    /** 대역 안 다음 번호. @returns {{no:number|null, full:boolean, band:number, lo:number, hi:number}} */
    nextInBand(pins, page, series, band, floor, base, prefix) {
      const pg = page || 1;
      // [WO 20261015-numunify] series 인자는 시그니처 하위호환용 — 번호 공간은 계열 무관 1개(체커 101 · 360 102 → 다음 103)
      const r = this.bandRange(band);
      // [WO 20261016-multisheet P2] 묶음 전체(scopePages) — 연결 OFF 면 [pg] 라 종전과 같다.
      const scope = this.scopePages(pg, pins);
      const inScope = scope.length === 1 ? null : new Set(scope);
      // [P5] 접두(구분자 포함) — 미지정이면 구역 설정(prefixFor). "" = 순수 숫자(아래 종전 분기 그대로).
      const pre = prefix === undefined ? this.prefixFor(pins) : String(prefix || "");
      const pk = this.prefixKey(pre);
      let maxNo = 0;
      // [WO 20261012-pinsync] 구역(별칭) 화면 = 원본 그 페이지 전체(상자 밖 포함) 최댓값 — 상자 밖 원본 번호와 겹치지 않게(_withBase)
      this._withBase(pins, pg, base).forEach(p => {
        if (!p || (inScope ? !inScope.has(p.page || 1) : (p.page || 1) !== pg)) return;   // 삭제 표식 핀도 센다 — 구멍 재사용 금지(종전 규칙)
        if (pk) { const k = this.noKeyOf(p.label); if (k && k.key === pk && k.no >= r.lo && k.no <= r.hi && k.no > maxNo) maxNo = k.no; return; }   // [P5] 같은 접두 안에서만
        const n = parseInt(p.label, 10);                       // label 이 숫자가 아니면(NaN) 무시
        if (Number.isFinite(n) && n >= r.lo && n <= r.hi && n > maxNo) maxNo = n; // 다른 대역 핀 무시
      });
      let no = maxNo ? maxNo + 1 : r.lo;
      const f = parseInt(floor, 10);
      if (Number.isFinite(f) && f >= r.lo && f <= r.hi && f > no) no = f;  // 하한은 대역 안일 때만
      const full = no > r.hi;
      return { no: full ? null : no, full: full, band: r.band, lo: r.lo, hi: r.hi, prefix: pre, label: full ? null : this.labelOf(pre, no) };
    },
    /** 대역 사용 현황(칩 표시용) — 그 대역 안 핀 수와 작성자별 개수.
     *  [WO 20261015-numunify] 계열 무관(번호 공간 1개) — series 인자는 시그니처 하위호환용. */
    bandUsage(pins, page, series) {
      const pg = page || 1;
      const out = new Map();   // band → { count, authors: Map<author, n> }
      (pins || []).forEach(p => {
        if (!p || p._deleted || (p.page || 1) !== pg) return;
        const raw = String(p.label == null ? "" : p.label).trim();
        if (!/^\d+$/.test(raw)) return;
        const k = this.bandOf(raw);
        if (!out.has(k)) out.set(k, { count: 0, authors: new Map() });
        const u = out.get(k);
        u.count++;
        const a = p.author || "";
        u.authors.set(a, (u.authors.get(a) || 0) + 1);
      });
      return out;
    },

    /** 🔴 [2026-09-17] 같은 페이지에서 번호(label)가 중복된 핀 id 집합.
     *  탐지·표시 전용 — 이미 저장된 중복 번호를 자동으로 바꾸지 않는다
     *  (마스터 명시: 현장 기록과 연결된 실데이터라 임의 재채번 금지 — 정리는 사용자가 누르는 [번호 리셋]).
     *  🔴 [WO 20261015-numunify] 계열 무관 — 체커 "1" 과 360 "1" 도 중복이다(종전 !p.checkboard 필터는 교차 중복을 못 잡았다).
     *  숫자 번호(공백 제외 /^\d+$/)만 본다 — 360 핀의 자유 텍스트 이름은 번호가 아니다. 삭제 표식(_deleted) 핀은 제외.
     *  @returns {Set<number|string>} 중복인 핀들의 id */
    duplicateNoIds(pins, page, base) {
      const pg = page || 1;
      // [WO 20261016-multisheet P2] 묶음 전체(scopePages) — 연결 OFF 면 [pg]. [P3] 같은 linkId = 논리 핀 1개(중복 아님).
      //   [P5] 키 = 접두키|번호 — A12 / B12 / 12 는 서로 중복이 아니다. 순수 숫자 키는 종전(String(parseInt)) 그대로.
      const scope = this.scopePages(pg, pins);
      const inScope = scope.length === 1 ? null : new Set(scope);
      const byLabel = new Map();
      const add = (p) => {
        const nk = this.noKeyOf(p.label);
        if (!nk) return;
        const key = nk.key ? (nk.key + "|" + nk.no) : String(nk.no);
        if (!byLabel.has(key)) byLabel.set(key, []);
        byLabel.get(key).push(p);
      };
      this._withBase(pins, pg, base).forEach(p => {   // [WO 20261012-pinsync] 구역 화면도 원본 기준 중복 판정
        if (!p || p._deleted || (p.page || 1) !== pg) return;
        add(p);
      });
      // 묶음의 다른 시트 핀(연결 OFF 면 inScope=null → 이 줄은 아무것도 하지 않는다)
      if (inScope) (pins || []).forEach(p => { if (p && !p._deleted && (p.page || 1) !== pg && inScope.has(p.page || 1)) add(p); });
      const dup = new Set();
      byLabel.forEach(list => {
        if (list.length < 2) return;
        const units = new Set(list.map(p => this._unitKey(p)));
        if (units.size > 1) list.forEach(p => { if ((p.page || 1) === pg) dup.add(p.id); });
      });
      return dup;
    },
    /** 구명 별칭(호출부 11_UI·27_PinActionPop·41_RegionMerge·테스트) — 정본 duplicateNoIds 하나만 둔다(§10 SoT). */
    duplicateCheckboardIds(pins, page, base) { return this.duplicateNoIds(pins, page, base); },

    /** 🔴 [WO 20260930-numdup] 동시 생성 번호 충돌 재채번 정본 — 저장 병합(20_App._mergePins) 직후에만 부른다.
     *  서로의 핀을 보기 전에 두 사람이 같은 번호를 만들면(각자 max+1) 409 병합 뒤 같은 페이지·CHECKER 계열에
     *  같은 번호가 둘 생긴다. 그 묶음에서 **먼저 만든 핀**(createdAt, 같으면 id)만 번호를 지키고, 나중 핀은
     *  페이지 최댓값+1 로 옮긴다 — 순서가 결정적이라 어느 클라이언트가 병합해도 같은 결과로 수렴한다.
     *  · 사용자가 직접 고친 번호(pin.labelManual)는 절대 바꾸지 않는다 — 수동 핀이 있으면 그 핀이 번호를
     *    지키고, 수동끼리 겹치면 그대로 둔다(duplicateCheckboardIds 가 표시).
     *  · 기존 데이터 불변: 묶음이 전부 기준 핀(baseIds = 내가 알던 서버본)이거나 기준 핀이 둘 이상이면
     *    이미 저장돼 있던 중복이라 건드리지 않는다(위 duplicateCheckboardIds 주석의 "자동 재채번 금지").
     *    baseIds 를 모르면(null) 동시 생성 여부를 판정할 수 없으니 아무것도 바꾸지 않는다.
     *  · [WO 20261001-startno] 360 계열도 대상 — numbers() 가 이제 숫자 label 을 그대로 표시하므로 겹칠 수 있다.
     *    묶음 키 = 계열|페이지|번호. 🔴 옮길 곳 = 그 번호가 속한 **대역 안** 최댓값+1 — 대역 밖으로 절대 옮기지 않고,
     *    대역이 가득 찼으면 옮기지 않는다(duplicateCheckboardIds 가 중복으로 표시).
     *  · 흔들림 방지: 재채번한 핀엔 renumberedFrom(옛 번호)을 남긴다. 낡은 화면(옛 번호를 든 클라이언트)이
     *    병합하면 로컬 우선 규칙 때문에 옛 번호로 되돌린 뒤 또 다른 번호로 옮기게 되는데, srvPins 를 넘기면
     *    "서버본이 내 옛 번호에서 옮겨 둔 핀"은 서버 번호를 먼저 채택한다(수동 번호 제외).
     *  pins 의 label 을 직접 바꾸고, 바꾼 목록을 돌려준다. id 는 불변(사진·노트 연결 유지).
     *  @returns {Array<{id, page:number, from:string, to:string}>} */
    resolveConcurrentNos(pins, baseIds, srvPins) {
      if (!Array.isArray(pins) || !baseIds) return [];
      const srvById = new Map((Array.isArray(srvPins) ? srvPins : []).filter(s => s && !s._deleted && s.id != null).map(s => [String(s.id), s]));
      pins.forEach(p => {
        const s = p && srvById.get(String(p.id));
        if (!s || s === p || p.labelManual || s.renumberedFrom == null) return;
        if (String(s.renumberedFrom) === String(p.label)) { p.label = s.label; p.renumberedFrom = s.renumberedFrom; }
      });
      const base = new Set(Array.from(baseIds, String));
      const at = (p) => { const t = this.createdAt(p); return Number.isFinite(t) ? t : Infinity; };
      const byAge = (a, b) => (at(a) - at(b)) || (String(a.id) < String(b.id) ? -1 : (String(a.id) > String(b.id) ? 1 : 0));
      const groups = new Map(), maxByBand = new Map();
      // [WO 20261016-multisheet P2] 페이지 축 = 묶음 키(scopePages) — 연결 OFF 면 페이지 번호 그대로(종전 키와 같은 값).
      const scopeKeyOf = new Map();
      const skOf = (pg) => { if (!scopeKeyOf.has(pg)) { const s = this.scopePages(pg); scopeKeyOf.set(pg, s.length === 1 ? String(pg) : s.join(",")); } return scopeKeyOf.get(pg); };
      pins.forEach(p => {
        if (!p || p._deleted) return;
        const ser = "n";   // [WO 20261015-numunify] 번호 공간 1개 — 묶음 키에서 계열 축 제거(체커 5 · 360 5 동시 생성도 충돌)
        const nk = this.noKeyOf(p.label);   // [P5] 순수 숫자 = 종전 /^\d+$/ 판정 그대로, 접두 번호는 접두키로 분리
        if (!nk) return;
        const n = nk.no;
        const pg = skOf(p.page || 1) + (nk.key ? "#" + nk.key : "");   // 묶음 키(연결 OFF = 페이지 번호 그대로) + 접두 — 순수 숫자 = 종전 키와 같은 문자열
        const bk = ser + "|" + pg + "|" + this.bandOf(n);
        maxByBand.set(bk, Math.max(maxByBand.get(bk) || 0, n));
        const k = ser + "|" + pg + "|" + n;
        if (!groups.has(k)) groups.set(k, { ser: ser, pg: pg, sk: pg, n: n, bk: bk, pfx: nk.prefix + nk.sep, list: [] });
        groups.get(k).list.push(p);
      });
      const changes = [];
      const PL = (typeof PinLink !== "undefined" && PinLink && PinLink.setLabel) ? PinLink : null;
      Array.from(groups.values())
        .filter(g => g.list.length > 1)
        .sort((a, b) => (a.ser < b.ser ? -1 : (a.ser > b.ser ? 1 : 0)) || (a.sk < b.sk ? -1 : (a.sk > b.sk ? 1 : 0)) || (a.n - b.n))
        .forEach(g => {
          // [P3] 같은 linkId = 논리 핀 1개 — 묶음 안 멤버끼리는 충돌이 아니다. 단위(unit) = 연결 묶음(없으면 핀 자신).
          const units = new Map();
          g.list.forEach(p => { const u = this._unitKey(p); if (!units.has(u)) units.set(u, []); units.get(u).push(p); });
          if (units.size < 2) return;
          const ulist = Array.from(units.values()).map(ms => {
            const rep = ms.find(p => p.linkId != null && String(p.linkId) === String(p.id)) || ms.slice().sort(byAge)[0];
            return { rep: rep, ms: ms, manual: ms.some(p => p.labelManual), inBase: ms.some(p => base.has(String(p.id))) };
          });
          const inBase = ulist.filter(u => u.inBase).length;
          if (inBase === ulist.length || inBase > 1) return;   // 이미 저장돼 있던 중복 → 표시만
          ulist.sort((a, b) => byAge(a.rep, b.rep));
          const keep = ulist.find(u => u.manual) || ulist[0];
          const hi = this.bandRange(this.bandOf(g.n)).hi;
          ulist.forEach(u => {
            if (u === keep || u.manual) return;
            const to = (maxByBand.get(g.bk) || 0) + 1;
            if (to > hi) return;                                  // 대역 가득 → 옮기지 않음(중복 표시만)
            maxByBand.set(g.bk, to);
            const toLabel = this.labelOf(g.pfx, to);
            const from = String(u.rep.label);
            // 🔴 label 쓰기 = PinLink.setLabel 1곳(연결 그룹 전원) — PinLink 미로드(단독 테스트)면 이 단위 멤버에 직접.
            const members = PL ? PL.setLabel(pins, u.rep, toLabel) : (u.ms.forEach(p => { p.label = toLabel; }), u.ms);
            members.forEach(p => { p.renumberedFrom = from; });
            changes.push({ id: u.rep.id, page: u.rep.page || 1, series: this.seriesOf(u.rep), from: from, to: toLabel });
          });
        });
      return changes;
    },

    /* ── [WO 20260930-lww] 🔴 핀 단위 수정 시각(pin.updatedAt, ms) — 병합(20_App._mergePins) LWW 기준 ──────────
       핀을 바꾸는 경로는 8개 모듈 40곳이 넘고(라벨·좌표·사진·아이콘·첨부·방향…) 앞으로도 늘어난다. 경로마다 touch 를
       박으면 하나만 빠져도 그 편집이 병합에서 서버본에 덮여 사라진다. 그래서 **관찰 지점에서 내용 변화를 감지**해
       찍는다: 모든 편집 경로가 반드시 지나는 App._markDirty(_autoSave 도 경유)와 병합 직전(_mergeConflict)이 stampChanged 를
       부르고, 서버본·draft 가 State 에 들어오는 지점은 baseline 으로 "이 내용이 기준" 을 기록한다(객체 단위 WeakMap —
       새로 파싱된 객체는 기준이 없으니 옛 기록이 새 객체를 오염시키지 못한다). updatedAt 은 비교 대상에서 뺀다. */
    _pinSig: new WeakMap(),
    //  [WO 20261011-offmerge] ignore = 비교에서 뺄 파생 필드(영역 pinIds — 핀을 옮기기만 해도 다시 계산된다). 핀·주석·영역이 같은 함수를 쓴다.
    _sigOf(p, ignore) {
      const q = Object.assign({}, p);
      delete q.updatedAt;
      if (ignore) ignore.forEach(k => { delete q[k]; });
      try { return JSON.stringify(q); } catch (e) { return null; }
    },
    /** 핀 1개의 수정 시각을 지금으로 — 단조 증가(같은 ms 두 번이어도 뒤가 크다). */
    touch(pin, now) {
      if (!pin || typeof pin !== "object") return pin;
      const t = Number.isFinite(now) ? now : Date.now();
      pin.updatedAt = Math.max(t, (Number(pin.updatedAt) || 0) + 1);
      return pin;
    },
    /** 서버본/draft 를 State 에 올린 직후·병합 직후 — 현재 내용을 기준으로 기록(찍지 않음). */
    baseline(pins, ignore) {
      (Array.isArray(pins) ? pins : []).forEach(p => { if (p && typeof p === "object") this._pinSig.set(p, this._sigOf(p, ignore)); });
      return pins;
    },
    /** 기준 이후 내용이 바뀐 핀만 touch. 기준이 없는 객체(새로 만든 핀)는 기준만 기록. @returns 찍은 개수 */
    stampChanged(pins, now, ignore) {
      let n = 0;
      (Array.isArray(pins) ? pins : []).forEach(p => {
        if (!p || typeof p !== "object") return;
        const s = this._sigOf(p, ignore), prev = this._pinSig.get(p);
        if (prev !== undefined && prev !== s) { this.touch(p, now); n++; }
        this._pinSig.set(p, s);
      });
      return n;
    },
    /** 같은 id 의 서버본 vs 로컬 — updatedAt 큰 쪽. 같거나 둘 다 없으면(레거시) 서버(결정론 · 남의 변경 유실 0). */
    newer(srv, loc) {
      return (Number(loc && loc.updatedAt) || 0) > (Number(srv && srv.updatedAt) || 0) ? loc : srv;
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
    /** [WO 20260929 addendum] series 기본값 "checkboard"(하위호환 — 기존 3/4-인자 호출부·테스트
     *  전부 그대로 동작). "content"(360)를 넘기면 현재 모드(360) 핀만 대상으로 일괄 재채번한다
     *  (마스터: "번호 일괄 변경도 현재 모드 핀만 대상"). */
    renumberCheckboardRange(pins, page, newStart, targetIds, series) {
      const pg = page || 1;
      // [WO 20261019-unifymode] "all" = 페이지 전 핀(통일 후 UI 는 항상 "all" — 모드별 대상 구분 없음). 생략 시 checkboard(하위호환).
      const ser = series === "all" ? "all" : (series === "content" ? "content" : "checkboard");
      const s = parseInt(newStart, 10);
      if (!Number.isFinite(s) || s < 1) return { ok: false, changes: [], reason: "시작 번호를 올바르게 입력하세요(1 이상 숫자)" };
      const map = this.numbers(pins, pg);
      const wantIds = targetIds ? new Set(targetIds) : null;
      const matches = (p) => ser === "all" || this.seriesOf(p) === ser;
      const targets = (pins || []).filter((p) => p && (p.page || 1) === pg && matches(p) && (!wantIds || wantIds.has(p.id)));
      if (!targets.length) return { ok: false, changes: [], reason: ser === "all" ? "이 페이지에는 핀이 없습니다" : (ser === "checkboard" ? "이 페이지에는 체크보드 핀이 없습니다" : "이 페이지에는 360 핀이 없습니다") };
      targets.sort((a, b) => {
        const ai = map.get(a.id), bi = map.get(b.id);
        return (ai ? ai.no : 0) - (bi ? bi.no : 0);
      });
      const changes = targets.map((p, i) => ({ id: p.id, oldLabel: p.label, newLabel: String(s + i) }));
      const newLabelSet = new Set(changes.map((c) => c.newLabel));
      if (newLabelSet.size !== changes.length) return { ok: false, changes: [], reason: "변경 결과에 번호 중복이 발생합니다 — 적용하지 않았습니다" };
      const targetIdSet = new Set(targets.map((p) => p.id));
      // [WO 20261015-numunify] 충돌 검사는 계열 무관(번호 공간 1개) — 대상 선택만 계열(호출부 범위)
      const collide = (pins || []).some((p) => p && !p._deleted && (p.page || 1) === pg && !targetIdSet.has(p.id) && newLabelSet.has(String(p.label == null ? "" : p.label).trim()));
      if (collide) return { ok: false, changes: [], reason: "기존 다른 핀과 번호가 겹칩니다 — 적용하지 않았습니다" };
      return { ok: true, changes: changes };
    },

    /** [WO 20261001-allpins] 🔴 전체 포인트 패널 전용 재채번 — renumberCheckboardRange() 와 달리
     *  단일 page 로 좁히지 않고, 호출부(21_AllPins.js)가 이미 정렬·선택한 pin 객체 배열을 그대로
     *  받아 여러 페이지에 걸친 대상도 한 번에 연속 재채번한다(마스터: "체크나 360 모두 … 번호 다시
     *  매기는 기능"). id 는 절대 건드리지 않는다. 결과 라벨이 대상 밖의 같은 페이지·같은 계열 핀과
     *  겹치면(또는 대상끼리 다른 페이지에서 같은 숫자를 받아도 페이지가 다르면 겹침 아님)
     *  renumberCheckboardRange 처럼 거부하지 않고 duplicateIds 로만 표시한다 — 호출부가 미리보기에서
     *  경고 후 사용자 확인을 받고 그래도 적용할지 결정한다(이 패널은 "선택"이 이미 명시적 의도이므로
     *  부분 반려보다 경고+확인이 맞다, 지휘자 확정).
     *  @param {Array} allPins   State.pins(전체) — 중복 판정 기준
     *  @param {Array} targets   이미 원하는 순서로 정렬된 대상 pin 객체 배열
     *  @param {number} newStart 시작 번호
     *  @param {string} series   'checkboard' | 'content'
     *  @returns {{ok:boolean, changes:Array<{id,page:number,oldLabel,newLabel:string}>, duplicateIds:Set, reason?:string}} */
    renumberSelection(allPins, targets, newStart, series) {
      const ser = series === "all" ? "all" : (series === "content" ? "content" : "checkboard");   // [WO 20261019-unifymode] "all" = 대상 전부
      const s = parseInt(newStart, 10);
      if (!Number.isFinite(s) || s < 1) return { ok: false, changes: [], duplicateIds: new Set(), reason: "시작 번호를 올바르게 입력하세요(1 이상 숫자)" };
      const list = (targets || []).filter((p) => p && (ser === "all" || this.seriesOf(p) === ser));
      if (!list.length) return { ok: false, changes: [], duplicateIds: new Set(), reason: "대상 핀이 없습니다" };
      const targetIdSet = new Set(list.map((p) => p.id));
      const changes = list.map((p, i) => ({ id: p.id, page: p.page || 1, oldLabel: p.label, newLabel: String(s + i) }));
      // 중복 판정: (page, 새 라벨) 키별로 대상 밖 핀 + 이번에 바뀐 핀을 함께 세어 2개 이상이면 중복.
      const count = new Map();
      const bump = (pg, lbl) => { const k = pg + "|" + lbl; count.set(k, (count.get(k) || 0) + 1); };
      (allPins || []).forEach((p) => {
        if (!p || p._deleted || targetIdSet.has(p.id)) return;   // [WO 20261015-numunify] 계열 무관 중복 판정
        const lbl = String(p.label == null ? "" : p.label).trim();
        if (lbl) bump(p.page || 1, lbl);
      });
      changes.forEach((c) => bump(c.page, c.newLabel));
      const duplicateIds = new Set();
      changes.forEach((c) => { if ((count.get(c.page + "|" + c.newLabel) || 0) > 1) duplicateIds.add(c.id); });
      return { ok: true, changes: changes, duplicateIds: duplicateIds };
    },

    /* ══ [WO 20261015-numunify] 번호 리셋(1부터 연속 재부여) 정본 — 순수 계산 + 적용 + 되돌리기 ══════════════
       마스터: "번호 리셋기능도 구현하고". UI(61_NumReset.js)는 호출·확인·저장만 한다.
       🔴 id 는 절대 건드리지 않는다(사진·노트는 pin.id 로 연결 — 라벨만 바뀐다).
       🔴 되돌리기 스냅샷 = 핀 자신에 pin.numReset = {batch, from, fromManual, to, at} 로 남긴다 — 일반 저장 경로(D1 pins JSON·
          오프라인 큐·LWW 병합)를 그대로 타서 새로고침·다른 기기에서도 되돌릴 수 있다(D1 스키마 변경 0 · 마이그레이션 0).
          6e2f408(일괄삭제 되돌리기)의 서버 기록 테이블 대신 이 방식을 고른 이유: 라벨 변경은 핀 내용 편집이라 같은
          저장 경로를 타야 병합 규칙(updatedAt LWW)이 한 곳에 남는다(별도 테이블이면 저장본과 기록이 갈라진다 — §SoT). */

    /** 도면 위치순 비교자 SoT — 페이지 → 위(y)→아래 → 왼(x)→오른쪽. 21_AllPins "도면 위치순" 과 같은 규칙. */
    byPosition(a, b) {
      return ((a.page || 1) - (b.page || 1)) || ((Number(a.y) || 0) - (Number(b.y) || 0)) || ((Number(a.x) || 0) - (Number(b.x) || 0));
    },

    /** 리셋 미리보기(pins 무변형).
     *  @param {Array} pins   State.pins(전체)
     *  @param {number} page  대상 페이지
     *  @param {{order?:"pos"|"no", targets?:Array, start?:number, base?:Array}} [opts]
     *         targets = 이미 고른 대상 pin 배열(구역 범위 — 생략 시 그 페이지 전 핀). order 기본 "pos".
     *  @returns {{ok:boolean, reason?:string, changes:Array<{id,oldLabel,oldNo,newLabel}>, changed:number, collisions:Set}} */
    resetPlan(pins, page, opts) {
      const o = opts || {};
      const pg = page || 1;
      const start = Number.isFinite(parseInt(o.start, 10)) && parseInt(o.start, 10) >= 1 ? parseInt(o.start, 10) : 1;
      const src = Array.isArray(o.targets) ? o.targets : (pins || []);
      // [WO 20261016-multisheet P2] 대상 = 묶음(scopePages) — 연결 OFF 면 [pg]. [P3] 연결 묶음 = 논리 핀 1개 = 변경 1행.
      const scope = this.scopePages(pg, pins);
      const inScope = scope.length === 1 ? null : new Set(scope);
      const onScope = (p) => inScope ? inScope.has(p.page || 1) : (p.page || 1) === pg;
      const seenUnit = new Set();
      const list = src.filter((p) => {
        if (!(p && !p._deleted && p.id != null && onScope(p))) return false;
        const u = this._unitKey(p);
        if (seenUnit.has(u)) return false;
        seenUnit.add(u);
        return true;
      });
      if (!list.length) return { ok: false, reason: "이 화면에는 번호를 다시 매길 핀이 없습니다", changes: [], changed: 0, collisions: new Set() };
      const metas = new Map();
      scope.forEach((sp) => this.numbers(pins, sp, o.base).forEach((v, k) => metas.set(k, v)));
      const noOf = (p) => { const i = metas.get(p.id); return i && Number.isFinite(i.no) ? i.no : Infinity; };
      const ordered = list.slice().sort(o.order === "no"
        ? (a, b) => (noOf(a) - noOf(b)) || this.byPosition(a, b)
        : (a, b) => this.byPosition(a, b));
      // [P5] 🔴 접두 유지 — 접두 그룹마다 독립으로 start 부터(A5,A9,B3 → A1,A2,B1). 순수 숫자 그룹 = 종전 String(start+i) 그대로.
      // [WO 20261016-bulkedit] 접미(1-F)도 그룹 키·유지 대상 — 접두·접미 없는 그룹 = 종전
      const pfxOf = (p) => { const i = metas.get(p.id); return (i && (i.prefix || i.suffix)) ? { key: this.prefixKey(i.prefix) + "~" + String(i.suffix || "").toUpperCase(), text: (i.prefix || "") + (i.sep || ""), sfx: i.suffix || "" } : { key: "", text: "", sfx: "" }; };
      const sfxText = new Map();
      const counters = new Map(), pfxText = new Map();
      const changes = ordered.map((p) => {
        const pf = pfxOf(p);
        if (!pfxText.has(pf.key)) { pfxText.set(pf.key, pf.text); sfxText.set(pf.key, pf.sfx); }
        const i = counters.get(pf.key) || 0;
        counters.set(pf.key, i + 1);
        const meta = metas.get(p.id);
        return { id: p.id, oldLabel: p.label == null ? "" : String(p.label), oldNo: noOf(p), oldText: meta ? this.textOf(meta) : "", prefix: pfxText.get(pf.key), newLabel: this.labelOf(pfxText.get(pf.key), start + i, sfxText.get(pf.key)) };
      });
      // 대상 밖 같은 페이지 핀(구역 화면이면 원본의 상자 밖 핀까지 — _withBase)과 겹치는 새 번호 → 표시(차단 아님)
      const keyOfLabel = (l) => { const k = this.noKeyOf(l); return k ? (k.key + "|" + k.no) : null; };
      const want = new Set(changes.map((c) => keyOfLabel(c.newLabel)));
      const tid = new Set();
      list.forEach((p) => { const u = this._unitKey(p); (pins || []).forEach((q) => { if (q && this._unitKey(q) === u) tid.add(String(q.id)); }); tid.add(String(p.id)); });
      const collisions = new Set();
      this._withBase(pins, pg, o.base).forEach((p) => {
        if (!p || p._deleted || p.id == null || !onScope(p) || tid.has(String(p.id))) return;
        const k = keyOfLabel(p.label);
        if (k && want.has(k)) collisions.add(p.id);
      });
      const changed = changes.filter((c) => c.oldLabel.trim() !== c.newLabel).length;
      return { ok: true, changes: changes, changed: changed, collisions: collisions };
    },

    /** [WO 20261016-bulkedit] 🔴 번호 일괄 편집 미리보기(pins 무변형) — 마스터: "핀 일괄 (수정) 순서대로 앞에 글자나 뒤에 글자 넣는 기능".
     *  범위·정렬·연결 묶음 규칙은 resetPlan 과 같다(묶음 = scopePages · 논리 핀 1개 = 1행 · order "no"(기본)|"pos").
     *  opts: { targets, order, addPrefix, addSuffix, stripPrefix, stripSuffix, renumber:{start, step}|null, base }
     *   · 앞 글자 = addPrefix + (stripPrefix ? "" : 기존 접두) · 뒤 글자 = (stripSuffix ? "" : 기존 접미) + addSuffix
     *   · 숫자 = renumber ? start + i*step : 기존 숫자(자릿수 그대로)
     *   · 번호가 아닌 자유 텍스트 핀은 renumber 가 없으면 건너뛴다(skipped — 지어내지 않는다).
     *  🔴 결과 label 이 parseLabel 로 같은 번호로 되읽히지 않으면 invalid, 같은 번호 공간에 중복이 생기면 conflict — 둘 중 하나라도 있으면 ok=false(적용 차단).
     *  ⚠ 뒤 글자에 숫자가 들어가면 사진 파일명(끝 숫자열) 매칭이 깨질 수 있다 → warnSuffixDigit.
     *  @returns {{ok, reason?, changes:Array<{id,oldLabel,oldText,newLabel,conflict,invalid}>, conflicts:Set, invalid:Array, skipped:Array, changed:number, warnSuffixDigit:boolean}} */
    bulkEditPlan(pins, page, opts) {
      const o = opts || {};
      const pg = page || 1;
      const RXP = /^(?:[A-Za-z]{1,6}[-_]?|[A-Za-z][A-Za-z0-9]{0,5}[-_])$/, RXS = /^[-_][A-Za-z][A-Za-z0-9]{0,5}$/;
      const addP = String(o.addPrefix || "").trim(), addS = String(o.addSuffix || "").trim();
      const empty = { ok: false, changes: [], conflicts: new Set(), invalid: [], skipped: [], changed: 0, warnSuffixDigit: false };
      if (addP && !/^[A-Za-z][A-Za-z0-9]*[-_]?$/.test(addP)) return Object.assign(empty, { reason: "앞 글자는 알파벳으로 시작해야 합니다(예: A, ER-, B2-)" });
      if (addS && !RXS.test(addS)) return Object.assign(empty, { reason: "뒤 글자는 - 또는 _ 로 시작하고 알파벳이 이어져야 합니다(예: -F, _R2)" });
      const rn = o.renumber ? { start: parseInt(o.renumber.start, 10), step: parseInt(o.renumber.step, 10) } : null;
      if (rn && (!Number.isFinite(rn.start) || rn.start < 0 || !Number.isFinite(rn.step) || rn.step < 1)) return Object.assign(empty, { reason: "시작 번호(0 이상)와 증가 폭(1 이상)을 숫자로 입력하세요" });
      if (!addP && !addS && !o.stripPrefix && !o.stripSuffix && !rn) return Object.assign(empty, { reason: "바꿀 내용을 하나 이상 고르세요(앞 글자 · 뒤 글자 · 제거 · 다시 매기기)" });
      const scope = this.scopePages(pg, pins);
      const inScope = scope.length === 1 ? null : new Set(scope);
      const onScope = (p) => inScope ? inScope.has(p.page || 1) : (p.page || 1) === pg;
      const src = Array.isArray(o.targets) ? o.targets : (pins || []);
      const seenUnit = new Set();
      const list = src.filter((p) => {
        if (!(p && !p._deleted && p.id != null && onScope(p))) return false;
        const u = this._unitKey(p);
        if (seenUnit.has(u)) return false;
        seenUnit.add(u);
        return true;
      });
      if (!list.length) return Object.assign(empty, { reason: "이 화면에는 번호를 바꿀 핀이 없습니다" });
      const metas = new Map();
      scope.forEach((sp) => this.numbers(pins, sp, o.base).forEach((v, k) => metas.set(k, v)));
      const noOf = (p) => { const i = metas.get(p.id); return i && Number.isFinite(i.no) ? i.no : Infinity; };
      const ordered = list.slice().sort(o.order === "pos" ? (a, b) => this.byPosition(a, b) : (a, b) => (noOf(a) - noOf(b)) || this.byPosition(a, b));
      const changes = [], skipped = [], invalid = [];
      let warn = false, i = 0;
      ordered.forEach((p) => {
        const oldLabel = p.label == null ? "" : String(p.label);
        const pl = this.parseLabel(oldLabel.trim());
        if (!pl && !rn) { skipped.push(p.id); return; }   // 번호 아님(자유 텍스트) — 다시 매기기 없이는 손대지 않는다
        const curP = pl ? pl.prefix + pl.sep : "", curS = pl ? pl.suffix : "";
        const numTxt = rn ? String(rn.start + (i++) * rn.step) : (pl.pad ? String(pl.no).padStart(pl.pad, "0") : String(pl.no));
        const newP = addP + (o.stripPrefix ? "" : curP), newS = (o.stripSuffix ? "" : curS) + addS;
        const newLabel = newP + numTxt + newS;
        const back = this.parseLabel(newLabel);
        const bad = !back || back.no !== parseInt(numTxt, 10) || (newP && !RXP.test(newP)) || (newS && !RXS.test(newS));
        if (/\d/.test(newS)) warn = true;
        const meta = metas.get(p.id);
        const c = { id: p.id, oldLabel: oldLabel, oldText: meta ? this.textOf(meta) : oldLabel, newLabel: newLabel, conflict: false, invalid: !!bad };
        if (bad) invalid.push(p.id);
        changes.push(c);
      });
      // 🔴 중복 검사 — 바뀐 결과끼리 + 대상 밖 같은 번호 공간 핀(연결 멤버는 그 묶음 1건)
      const keyOf = (l) => { const k = this.noKeyOf(l); return k ? (k.key + "|" + k.no) : null; };
      const tid = new Set();
      list.forEach((p) => { const u = this._unitKey(p); (pins || []).forEach((q) => { if (q && this._unitKey(q) === u) tid.add(String(q.id)); }); });
      skipped.forEach((id) => tid.delete(String(id)));
      const count = new Map();
      const bump = (k) => { if (k) count.set(k, (count.get(k) || 0) + 1); };
      const outUnits = new Set();
      (pins || []).forEach((q) => {
        if (!q || q._deleted || !onScope(q) || tid.has(String(q.id))) return;
        const u = this._unitKey(q);
        if (outUnits.has(u)) return;
        outUnits.add(u);
        bump(keyOf(q.label));
      });
      changes.forEach((c) => bump(keyOf(c.newLabel)));
      const conflicts = new Set();
      changes.forEach((c) => { const k = keyOf(c.newLabel); if (k && count.get(k) > 1) { c.conflict = true; conflicts.add(c.id); } });
      const changed = changes.filter((c) => c.oldLabel.trim() !== c.newLabel).length;
      const reason = invalid.length ? ("번호로 읽을 수 없는 결과 " + invalid.length + "개 — 앞·뒤 글자를 줄이거나 바꾸세요")
        : (conflicts.size ? ("같은 번호 공간에 중복 " + conflicts.size + "개 — 적용할 수 없습니다") : (!changes.length ? "바꿀 번호 핀이 없습니다(자유 텍스트만)" : ""));
      return { ok: !reason, reason: reason || undefined, changes: changes, conflicts: conflicts, invalid: invalid, skipped: skipped, changed: changed, warnSuffixDigit: warn };
    },

    /** 리셋 적용 — plan.changes 대로 라벨을 바꾸고 핀마다 되돌리기 스냅샷을 남긴다. @returns 바뀐 핀 배열 */
    applyReset(pins, plan, batch, now) {
      if (!plan || !plan.ok) return [];
      const t = Number.isFinite(now) ? now : Date.now();
      const byId = new Map((pins || []).filter((p) => p && p.id != null).map((p) => [String(p.id), p]));
      const out = [];
      const PL = (typeof PinLink !== "undefined" && PinLink && PinLink.members) ? PinLink : null;
      plan.changes.forEach((c) => {
        const head = byId.get(String(c.id));
        if (!head) return;
        // [WO 20261016-multisheet P3] 연결 묶음 전원 — 되돌리기 스냅샷은 멤버마다(각자 옛 label·수동 표시)
        const members = PL ? PL.members(pins, head) : [head];
        for (const pin of members) {   // (들여쓰기 고정 — p155 뮤테이션 대상 문자열)
        pin.numReset = { batch: String(batch), from: pin.label == null ? null : pin.label, fromManual: !!pin.labelManual, to: c.newLabel, at: t };
        }
        if (PL && PL.setLabel) PL.setLabel(pins, head, c.newLabel, { manual: true });
        else for (const pin of members) {   // PinLink 미로드(단독 테스트) — 종전 그대로
        pin.label = c.newLabel;
        pin.labelManual = true;   // [WO 20260930-numdup] 사용자가 정한 번호 — 동시 생성 재채번(resolveConcurrentNos) 대상 아님
        }
        members.forEach((m) => out.push(m));
      });
      return out;
    },

    /** 그 페이지에서 가장 최근 리셋 묶음(되돌리기 대상). 없으면 null. */
    lastResetBatch(pins, page) {
      const pg = page || 1;
      // [WO 20261016-multisheet P2] 리셋 대상이 묶음이면 되돌리기도 묶음 — 연결 OFF 면 [pg]
      const scope = this.scopePages(pg, pins);
      const on = (p) => scope.length === 1 ? (p.page || 1) === pg : scope.indexOf(p.page || 1) >= 0;
      let best = null;
      (pins || []).forEach((p) => {
        const r = p && !p._deleted && on(p) ? p.numReset : null;
        if (!r || r.batch == null) return;
        const at = Number(r.at) || 0;
        if (!best || at > best.at) best = { batch: String(r.batch), at: at, count: 0 };
      });
      if (!best) return null;
      (pins || []).forEach((p) => { if (p && !p._deleted && on(p) && p.numReset && String(p.numReset.batch) === best.batch) best.count++; });
      return best;
    },

    /** 되돌리기 계획 — 리셋 뒤 사용자가 다시 고친 핀(label ≠ to)은 건드리지 않는다(skipped). */
    undoResetPlan(pins, batch) {
      const restore = [], skipped = [];
      (pins || []).forEach((p) => {
        if (!p || !p.numReset || String(p.numReset.batch) !== String(batch)) return;
        if (String(p.label == null ? "" : p.label) === String(p.numReset.to)) restore.push({ id: p.id, from: p.numReset.from, fromManual: !!p.numReset.fromManual, to: p.numReset.to });
        else skipped.push(p.id);
      });
      return { batch: String(batch), restore: restore, skipped: skipped };
    },

    /** 되돌리기 적용 — 옛 라벨·수동 표시 복원 + 그 묶음 스냅샷 제거(건너뛴 핀도 스냅샷은 제거 — 다시 되돌리기 대상이 되지 않게). */
    applyUndoReset(pins, plan) {
      if (!plan) return [];
      const byId = new Map((pins || []).filter((p) => p && p.id != null).map((p) => [String(p.id), p]));
      const out = [];
      plan.restore.forEach((r) => {
        const pin = byId.get(String(r.id));
        if (!pin) return;
        pin.label = r.from;
        if (r.fromManual) pin.labelManual = true; else delete pin.labelManual;
        delete pin.numReset;
        out.push(pin);
      });
      plan.skipped.forEach((id) => { const pin = byId.get(String(id)); if (pin) { delete pin.numReset; out.push(pin); } });
      return out;
    },

    /** [WO 20260918] 개별 번호 변경 검증 — 이미 쓰는 번호로 바꾸려 하면 거부(조용히 삼키지 않음).
     *  체크보드 핀에만 적용(콘텐츠/빈 핀의 label 은 자유 텍스트라 번호 유일성 규칙이 없다).
     *  @returns {{ok:boolean, newLabel?:string, reason?:string}} */
    validateCheckboardLabel(pins, page, pinId, newLabel) {
      const pg = page || 1;
      const lbl = String(newLabel == null ? "" : newLabel).trim();
      if (!lbl) return { ok: false, reason: "번호를 입력하세요" };
      // [WO 20261016-multisheet P5] 숫자 또는 접두+숫자(A12 / ER-12 / B2-05 — parseLabel 정본)
      if (!/^\d+$/.test(lbl) && !(this.parseLabel(lbl) && (this.parseLabel(lbl).prefix || this.parseLabel(lbl).suffix))) return { ok: false, reason: "번호는 숫자 또는 알파벳+숫자(예: 12, A12, ER-12, 1-F)만 가능합니다" };
      // [P2] 묶음 전체(scopePages — 연결 OFF 면 [pg]) · [P3] 같은 연결 묶음(linkId) 멤버는 같은 번호가 정상 · [P5] A12 = A-12 = a12
      const scope = this.scopePages(pg, pins);
      const me = (pins || []).find((p) => p && p.id === pinId);
      const myUnit = me ? this._unitKey(me) : null;
      const nk = this.noKeyOf(lbl);
      const keyOf = (l) => { const k = this.noKeyOf(l); return k && k.key ? (k.key + "|" + k.no) : null; };
      const want = nk && nk.key ? (nk.key + "|" + nk.no) : null;
      // [WO 20261015-numunify] 계열 무관 — 360 핀이 쓰는 번호도 이미 사용 중이다
      const dup = (pins || []).some((p) => p && !p._deleted && p.id !== pinId && scope.indexOf(p.page || 1) >= 0 && !(myUnit && this._unitKey(p) === myUnit)
        && (String(p.label == null ? "" : p.label).trim() === lbl || (want != null && keyOf(p.label) === want)));
      if (dup) return { ok: false, reason: "이미 사용 중인 번호입니다(" + lbl + ") — 다른 번호를 입력하세요" };
      return { ok: true, newLabel: lbl };
    },

    /* ══ 표시 필터 ══════════════════════════════════════════
       숨김 = 표시만 감춘다. 저장 데이터·번호 계열은 필터와 무관하게 불변. */

    /** [WO 20261019-unifymode] 🔴 표시 필터 = [전체 / 사진 있음 / 사진 없음] 3종(배타 선택) — 구 [CHECKER][360] 계열 칩·트리 모드 잎·
     *  AllPins 모드 탭을 대체한다. 판정 = mediaOf(사진·영상 — 연결 멤버는 대표 기준), 열람 링크 360 필터(서버 pinHas360Media)와 같은 축.
     *  상태는 이 탭의 메모리에만(영구저장 금지 — WO 20260921 고스트 필터 재발 방지: 새로 열면 항상 "전체"). */
    PHOTO_FILTERS: [
      { key: "all",     label: "전체" },
      { key: "photo",   label: "사진 있음" },
      { key: "nophoto", label: "사진 없음" }
    ],
    _photoFilter: "all",
    photoFilter() { return this._photoFilter || "all"; },
    setPhotoFilter(key) {
      if (!this.PHOTO_FILTERS.some((f) => f.key === key)) return this.photoFilter();
      this._photoFilter = key;
      return key;
    },
    /** 핀에 사진(360/영상)이 있는가 — 연결 멤버는 대표의 사진으로(사진은 대표에만 둔다, multisheet P3). */
    hasPhoto(pin) {
      const h = (pin && typeof PinLink !== "undefined" && PinLink && PinLink.headOf && typeof State !== "undefined" && State) ? PinLink.headOf(State.pins, pin) : pin;
      return !!h && this.mediaOf(h);
    },
    /** 필터 key 에 맞는가(생략 = 현재 필터). */
    matchesPhotoFilter(pin, key) {
      const k = key || this.photoFilter();
      if (k === "photo") return this.hasPhoto(pin);
      if (k === "nophoto") return !this.hasPhoto(pin);
      return true;
    },
    /** 필터별 개수 { all, photo, nophoto } — 칩·트리·AllPins 공용. page 생략 = 전 페이지. */
    photoCounts(pins, page) {
      const c = { all: 0, photo: 0, nophoto: 0 };
      (pins || []).forEach((p) => {
        if (!p || p._deleted || (page && (p.page || 1) !== page)) return;
        c.all++; c[this.hasPhoto(p) ? "photo" : "nophoto"]++;
      });
      return c;
    },
    /** 사진 필터를 적용한 부분집합. */
    filterByPhoto(pins, key) { return (pins || []).filter((p) => p && this.matchesPhotoFilter(p, key)); },

    /** 등록 방식 판정 등에 쓰는 "번호 핀" — 구 체커 메타가 있거나 label 이 번호(12 · A12 · 1-F)면 번호 핀(번호 중복 검증 대상).
     *  자유 텍스트 이름 label(구 360 폼으로 만든 "기관실" 등)만 번호 검증에서 빠진다(종전 동작 유지). */
    isNumberPin(pin) { return !!pin && (!!pin.checkboard || this.noKeyOf(pin.label) != null); },

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

    /** 🔴 도면 마커·미니맵 점이 공통으로 쓰는 표시 여부 판정 (사진 필터 × 종류 필터 AND).
     *  [WO 20261019-unifymode] 계열(seriesOf) 칩 → 사진 유무 필터(matchesPhotoFilter). */
    isVisible(pin) { return this.matchesPhotoFilter(pin) && this.isIconVisible(pin); },

    isAll() { return this.photoFilter() === "all"; },

    showAll() { this._photoFilter = "all"; this._persist(); },

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

    /** 🔴 [WO 20261001-startno] 내 번호 대역 — 정본은 **서버**(project_members.num_band · 소유자는 projects.owner_num_band,
     *  마스터 확정: 다른 기기에서도 같은 대역). 여기 localStorage 는 그 값의 **캐시**(오프라인·서버 응답 전)일 뿐이고,
     *  24b_NumBand.refresh() 가 서버 값으로 덮어쓴다. 키 = 프로젝트 + 사용자(대역은 CHECKER·360 공통).
     *  직접 입력 하한(고급)만 계열별 키 — 대역 안에서만 의미가 있다(App._checkboardStart).
     *  구 키(wm-user-band:· wm-user-band-360: — 사용자 전역·계열별 시작값)는 더 이상 읽지 않는다. */
    BAND_CACHE_PREFIX: "wm-num-band:",
    START_KEY_PREFIX: "wm-num-start:",
    _scope(author) {
      const pid = (typeof State !== "undefined" && State.currentProjectId) || "-";
      return pid + ":" + (author || "-");
    },
    _mem: {},   // localStorage 가 막힌 환경(사생활 모드·저장소 차단)에서도 이 탭 동안은 유지
    _lsNum(key) {
      let v = null;
      try { v = localStorage.getItem(key); } catch (e) { v = null; }
      if (v == null) v = this._mem[key];
      const n = parseInt(v, 10);
      return (Number.isFinite(n) && n >= 1) ? n : null;
    },
    _lsSet(key, n) { this._mem[key] = String(n); try { localStorage.setItem(key, String(n)); } catch (e) {} },
    myBand(author) { return this._lsNum(this.BAND_CACHE_PREFIX + this._scope(author)); },
    setMyBand(author, k) { const b = this.bandRange(k).band; this._lsSet(this.BAND_CACHE_PREFIX + this._scope(author), b); return b; },
    /*  [WO 20261019-unifymode] 직접 입력 하한도 계열 무관 1개 — 핀이 하나로 합쳐져 "어느 계열의 시작값"이 더는 없다.
        키 접미는 구 기본 모드(CHECKER) 키 ":checkboard" 를 그대로 쓴다(이미 저장된 값 유지 · 마이그레이션 0). series 인자는 시그니처 호환. */
    _startKey(author) { return this.START_KEY_PREFIX + this._scope(author) + ":checkboard"; },
    userStart(author, series) { return this._lsNum(this._startKey(author)); },
    setUserStart(author, series, value) {
      let n = parseInt(value, 10);
      if (!Number.isFinite(n) || n < 1) n = 1;
      this._lsSet(this._startKey(author), n);
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
      if (this.isNumberPin(pin) && Number.isFinite(no)) {   // [WO 20261019-unifymode] 구 체커 메타 → 번호 핀(통일)
        const band = this.bandOf(no) - 1; // 0=1~100, 1=101~200 … "100번대/200번대" 그룹 (BAND_SIZE 정본)
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

    /* ── 필터 칩 UI (도면 좌상단) — 기존 구역페이저 칩 스타일(.zpager-tab) 재사용 ──
       [WO 20261019-unifymode] 🔴 구 [CHECKER][360] 2칩(생성 계열 독립 토글) → [전체][사진 있음][사진 없음] 3칩(배타 선택, aria-pressed).
       개수 = 지금 페이지(창 구역이면 그 크롭 안 — Projects.pinsForDeck SoT) 기준. 핀이 0개여도 편집 화면은 칩을 보인다(어디서
       찍었는지와 무관하게 같은 3칩 — 열람자도 같은 칩, 표시만 바꾸고 데이터는 건드리지 않는다). 뷰어는 핀이 있을 때만. */
    renderChips() {
      if (typeof document === "undefined") return;
      const host = document.getElementById("pin-filter-bar");
      if (!host) return;
      const page = (typeof State !== "undefined" && State.pdfPage) || 1;
      const allPins = (typeof State !== "undefined" && State.pins) || [];
      const curDeck = (typeof Projects !== "undefined") ? Projects.currentDeck : null;
      const pins = (typeof Projects !== "undefined" && Projects.pinsForDeck) ? Projects.pinsForDeck(allPins, curDeck) : allPins;
      const c = this.photoCounts(pins, page);
      const isDesigner = typeof State !== "undefined" && State.mode === "designer";
      if (!c.all && !isDesigner) { host.classList.add("hidden"); host.innerHTML = ""; return; }
      host.classList.remove("hidden");
      const cur = this.photoFilter();
      host.innerHTML = this.PHOTO_FILTERS.map((f) => {
        const on = f.key === cur;
        return '<button type="button" class="zpager-tab pinfilter-chip pf-' + f.key + (on ? " active" : "") +
          '" data-pfilter="' + f.key + '" aria-pressed="' + (on ? "true" : "false") +
          '" title="' + (f.key === "all" ? "모든 핀 보기" : f.label + " 핀만 보기") + '"><span class="pinfilter-dot"></span>' + f.label +
          '<span class="zpager-cnt">' + (c[f.key] || 0) + '</span></button>';
      }).join("");
      if (!this._chipsBound) {
        this._chipsBound = true;
        host.addEventListener("click", (e) => {
          const btn = e.target && e.target.closest ? e.target.closest("[data-pfilter]") : null;
          if (!btn) return;
          e.stopPropagation();
          this.setPhotoFilter(btn.dataset.pfilter);
          this.apply(); // UI.renderPinsOnMap()이 renderChips()도 함께 호출해 칩 active 상태를 갱신한다
        });
      }
    },

    /** 필터 변경 후 도면 마커 + 미니맵 점을 함께 다시 그린다(한쪽만 걸리면 거짓말이 된다) */
    apply() {
      try { if (typeof UI !== "undefined" && UI.renderPinsOnMap) UI.renderPinsOnMap(); } catch (e) {}
      // [WO 20261019-unifymode] 같은 필터를 트리(구역·영역 아래 핀)·전체 포인트 패널도 쓴다 — 한쪽만 바뀌면 거짓말이 된다.
      try { if (typeof UI !== "undefined" && UI.renderTree) UI.renderTree(); } catch (e) {}
      try { if (typeof AllPins !== "undefined" && AllPins.open && AllPins.render) AllPins.render(); } catch (e) {}
      try {
        const box = (typeof document !== "undefined") && document.getElementById("pano-radar");
        if (box && !box.classList.contains("hidden") && typeof Radar !== "undefined" && Radar._pin && Radar.update) {
          Radar.update(Radar._pin);
        }
      } catch (e) {}
    }
  };
