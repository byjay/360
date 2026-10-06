
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
    LABELS: { content: "360", empty: "미배치", checkboard: "CHECKER" },
    FILTER_KEY: "wm-pin-filter",
    /* [WO 20260929 addendum, 지휘자 정정] "체크보드랑 360모드랑 2개 해" — 핀 필터 바는 KINDS
       (3종, 색상/marker용과 별개)이 아니라 이 2종(모드와 1:1)만 쓴다. seriesOf()가 이미
       정확히 이 2값을 반환하므로 그대로 재사용(§10 SoT — 별도 분류를 새로 만들지 않는다). */
    SERIES: ["checkboard", "content"],

    /* [WO 20260929 2모드 전환, 지휘자 정정] 편집화면 진입 기본 모드 = CHECKER(checkboard).
       구 3버튼(보기/체크보드/사진등록) 중 [보기]가 세그먼트에서 제거되며, 과거 이 값에
       저장되던 "designer"(=구 [보기]/등록모드)는 더 이상 선택 가능한 목적지가 아니다 —
       기존에 저장된 "designer" 값은 진입 시 "checkboard" 로 정규화한다(디자이너 UI에서
       도달 불가능한 값을 SoT가 계속 반환하면 안 됨). SoT: 이 값 하나만 — App.openApp
       호출부들은 전부 preferredMode()를 참조하고, 하드코딩된 값을 직접 쓰지 않는다.
       🔴 저장된 기존 핀의 checkboard/kind 해석은 이 값과 무관 — 이건 오직
          "새 배치 시작 시 어느 모드로 열리는가"만 결정한다. */
    PREFERRED_MODE_KEY: "wm_pin_default_mode",
    DEFAULT_MODE: "checkboard",
    preferredMode() {
      try {
        const v = localStorage.getItem(this.PREFERRED_MODE_KEY);
        // [WO 20260929] 구 "designer"(=[보기]) 저장값은 checkboard 로 정규화 — view 는
        // 디자이너 UI에서 더 이상 도달 가능한 목적지가 아니다.
        if (v === "checkboard") return v;
        if (v === "designer") return "checkboard";
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

    /** 색상/필터 부류 (3종) */
    kindOf(pin) {
      if (!pin) return "empty";
      if (pin.checkboard) return "checkboard";
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
    DECK_MODES: [
      { tag: "checker", regMode: "checkboard", series: "checkboard", label: "CHECKER" },
      { tag: "360",     regMode: "photo",      series: "content",    label: "360" }
    ],
    _modeBy(key, val) { return this.DECK_MODES.find((m) => m[key] === val) || null; },
    /** 현재 활성 모드(편집화면 CHECKER/360). 뷰어·구 view 모드는 null(=분리 없음, 전부 표시). */
    activeMode() {
      if (typeof State === "undefined" || State.mode !== "designer") return null;
      return this._modeBy("regMode", State.regMode);
    },
    /** 활성 모드의 핀 계열 — null 이면 모드 분리 없음 */
    activeSeries() { const m = this.activeMode(); return m ? m.series : null; },
    /** 새 구역·영역에 붙일 decks.mode 태그 — null 이면 태그 안 함(서버 NULL) */
    deckModeTag() { const m = this.activeMode(); return m ? m.tag : null; },
    /** 핀이 (지정 계열 또는) 활성 모드 작업공간에 속하는가 */
    inMode(pin, series) {
      const s = series !== undefined ? series : this.activeSeries();
      return !s || this.seriesOf(pin) === s;
    },
    /** 활성 모드 작업공간의 핀만 */
    modePins(pins) { return (pins || []).filter((p) => p && this.inMode(p)); },
    /** 구역이 모드 tag 작업공간에 보이는가 — NULL(기존 구역)은 양쪽 모두(유실 0) */
    deckInMode(deck, tag) { return !!deck && (deck.mode == null || deck.mode === "" || deck.mode === tag); },
    /** 구역 생성 요청 body 에 활성 모드 태그를 붙인다(31_Projects.js POST 3곳 공유 지점).
     *  영역은 부모 구역의 mode 를 상속 — 부모가 태그돼 있으면 그 값, NULL 이면 활성 모드. */
    withDeckMode(body, parentDeck) {
      const tag = (parentDeck && parentDeck.mode) || this.deckModeTag();
      if (tag) body.mode = tag;
      return body;
    },

    /** [WO 20260929 addendum] 🔴 표시 번호 포맷 정본 — CHECKER 계열은 숫자 그대로, 360 계열은
     *  "P" 접두(마스터: "번호체계도 다르게 해"). 마커 머리(11_UI)·미니맵(07_Radar)·트리 행(11_UI)
     *  등 번호를 보여주는 모든 곳이 이 함수 하나만 부른다 — 각자 접두를 붙이면 반드시 갈라진다
     *  (전역 CLAUDE.md §10 SoT). 27_PinActionPop.js 패널 헤더는 현재 이 정본을 쓰지 않는 별도
     *  버그(samePage.indexOf 자체 채번)가 있어 이관 대상이나, 그 파일은 다른 팀 점유라 이번 턴엔
     *  손대지 않는다(지휘자 보고 대상). */
    formatNo(no, series) { return series === "checkboard" ? String(no) : ("P" + no); },

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
          // [WO 20261001-startno] 360 도 대역 번호(P101…)를 보여야 한다 — label 이 순수 숫자면 그 값,
          //   아니면(자유 텍스트 이름·label 없음) 종전 페이지 내 순번. prod 360 핀 8개(label "1"~"8")는 실측상
          //   순번과 label 이 같아 표시 번호가 바뀌지 않는다(.tmp 조회 diff 0).
          const raw = String(p.label == null ? "" : p.label).trim();
          no = /^\d+$/.test(raw) ? parseInt(raw, 10) : nContent;
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
    nextSeriesNo(pins, page, start, author, series, band) {
      const s = (Number.isFinite(start) && start >= 1) ? start : 1;
      const k = (Number.isFinite(band) && band >= 1) ? band : this.bandOf(s);
      return this.nextInBand(pins, page, series, k, s).no;
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
    nextInBand(pins, page, series, band, floor) {
      const pg = page || 1;
      const ser = series === "content" ? "content" : "checkboard";
      const r = this.bandRange(band);
      let maxNo = 0;
      (pins || []).forEach(p => {
        if (!p || (p.page || 1) !== pg) return;               // 삭제 표식 핀도 센다 — 구멍 재사용 금지(종전 규칙)
        if (this.seriesOf(p) !== ser) return;
        const n = parseInt(p.label, 10);                       // label 이 숫자가 아니면(NaN) 무시
        if (Number.isFinite(n) && n >= r.lo && n <= r.hi && n > maxNo) maxNo = n; // 다른 대역 핀 무시
      });
      let no = maxNo ? maxNo + 1 : r.lo;
      const f = parseInt(floor, 10);
      if (Number.isFinite(f) && f >= r.lo && f <= r.hi && f > no) no = f;  // 하한은 대역 안일 때만
      const full = no > r.hi;
      return { no: full ? null : no, full: full, band: r.band, lo: r.lo, hi: r.hi };
    },
    /** 대역 사용 현황(칩 표시용) — 계열별 그 대역 안 핀 수와 작성자별 개수. */
    bandUsage(pins, page, series) {
      const pg = page || 1;
      const ser = series === "content" ? "content" : "checkboard";
      const out = new Map();   // band → { count, authors: Map<author, n> }
      (pins || []).forEach(p => {
        if (!p || p._deleted || (p.page || 1) !== pg || this.seriesOf(p) !== ser) return;
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

    /** 🔴 [WO 20260930-numdup] 동시 생성 번호 충돌 재채번 정본 — 저장 병합(20_App._mergePins) 직후에만 부른다.
     *  서로의 핀을 보기 전에 두 사람이 같은 번호를 만들면(각자 max+1) 409 병합 뒤 같은 페이지·CHECKER 계열에
     *  같은 번호가 둘 생긴다. 그 묶음에서 **먼저 만든 핀**(createdAt, 같으면 id)만 번호를 지키고, 나중 핀은
     *  페이지 최댓값+1 로 옮긴다 — 순서가 결정적이라 어느 클라이언트가 병합해도 같은 결과로 수렴한다.
     *  · 사용자가 직접 고친 번호(pin.labelManual)는 절대 바꾸지 않는다 — 수동 핀이 있으면 그 핀이 번호를
     *    지키고, 수동끼리 겹치면 그대로 둔다(duplicateCheckboardIds 가 표시).
     *  · 기존 데이터 불변: 묶음이 전부 기준 핀(baseIds = 내가 알던 서버본)이거나 기준 핀이 둘 이상이면
     *    이미 저장돼 있던 중복이라 건드리지 않는다(위 duplicateCheckboardIds 주석의 "자동 재채번 금지").
     *    baseIds 를 모르면(null) 동시 생성 여부를 판정할 수 없으니 아무것도 바꾸지 않는다.
     *  · [WO 20261001-startno] 360 계열도 대상 — numbers() 가 이제 숫자 label 을 그대로 표시(P101…)하므로 겹칠 수 있다.
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
      pins.forEach(p => {
        if (!p || p._deleted) return;
        const ser = this.seriesOf(p);
        const lbl = String(p.label == null ? "" : p.label).trim();
        if (!/^\d+$/.test(lbl)) return;
        const pg = p.page || 1, n = parseInt(lbl, 10);
        const bk = ser + "|" + pg + "|" + this.bandOf(n);
        maxByBand.set(bk, Math.max(maxByBand.get(bk) || 0, n));
        const k = ser + "|" + pg + "|" + n;
        if (!groups.has(k)) groups.set(k, { ser: ser, pg: pg, n: n, bk: bk, list: [] });
        groups.get(k).list.push(p);
      });
      const changes = [];
      Array.from(groups.values())
        .filter(g => g.list.length > 1)
        .sort((a, b) => (a.ser < b.ser ? -1 : (a.ser > b.ser ? 1 : 0)) || (a.pg - b.pg) || (a.n - b.n))
        .forEach(g => {
          const inBase = g.list.filter(p => base.has(String(p.id))).length;
          if (inBase === g.list.length || inBase > 1) return;   // 이미 저장돼 있던 중복 → 표시만
          g.list.sort(byAge);
          const keep = g.list.find(p => p.labelManual) || g.list[0];
          const hi = this.bandRange(this.bandOf(g.n)).hi;
          g.list.forEach(p => {
            if (p === keep || p.labelManual) return;
            const to = (maxByBand.get(g.bk) || 0) + 1;
            if (to > hi) return;                                  // 대역 가득 → 옮기지 않음(중복 표시만)
            maxByBand.set(g.bk, to);
            changes.push({ id: p.id, page: g.pg, series: g.ser, from: String(p.label), to: String(to) });
            p.renumberedFrom = String(p.label);
            p.label = String(to);
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
    _sigOf(p) {
      const q = Object.assign({}, p);
      delete q.updatedAt;
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
    baseline(pins) {
      (Array.isArray(pins) ? pins : []).forEach(p => { if (p && typeof p === "object") this._pinSig.set(p, this._sigOf(p)); });
      return pins;
    },
    /** 기준 이후 내용이 바뀐 핀만 touch. 기준이 없는 객체(새로 만든 핀)는 기준만 기록. @returns 찍은 개수 */
    stampChanged(pins, now) {
      let n = 0;
      (Array.isArray(pins) ? pins : []).forEach(p => {
        if (!p || typeof p !== "object") return;
        const s = this._sigOf(p), prev = this._pinSig.get(p);
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
      const ser = series === "content" ? "content" : "checkboard";
      const s = parseInt(newStart, 10);
      if (!Number.isFinite(s) || s < 1) return { ok: false, changes: [], reason: "시작 번호를 올바르게 입력하세요(1 이상 숫자)" };
      const map = this.numbers(pins, pg);
      const wantIds = targetIds ? new Set(targetIds) : null;
      const matches = (p) => this.seriesOf(p) === ser;
      const targets = (pins || []).filter((p) => p && (p.page || 1) === pg && matches(p) && (!wantIds || wantIds.has(p.id)));
      if (!targets.length) return { ok: false, changes: [], reason: ser === "checkboard" ? "이 페이지에는 체크보드 핀이 없습니다" : "이 페이지에는 360 핀이 없습니다" };
      targets.sort((a, b) => {
        const ai = map.get(a.id), bi = map.get(b.id);
        return (ai ? ai.no : 0) - (bi ? bi.no : 0);
      });
      const changes = targets.map((p, i) => ({ id: p.id, oldLabel: p.label, newLabel: String(s + i) }));
      const newLabelSet = new Set(changes.map((c) => c.newLabel));
      if (newLabelSet.size !== changes.length) return { ok: false, changes: [], reason: "변경 결과에 번호 중복이 발생합니다 — 적용하지 않았습니다" };
      const targetIdSet = new Set(targets.map((p) => p.id));
      const collide = (pins || []).some((p) => p && (p.page || 1) === pg && matches(p) && !targetIdSet.has(p.id) && newLabelSet.has(String(p.label)));
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
      const ser = series === "content" ? "content" : "checkboard";
      const s = parseInt(newStart, 10);
      if (!Number.isFinite(s) || s < 1) return { ok: false, changes: [], duplicateIds: new Set(), reason: "시작 번호를 올바르게 입력하세요(1 이상 숫자)" };
      const list = (targets || []).filter((p) => p && this.seriesOf(p) === ser);
      if (!list.length) return { ok: false, changes: [], duplicateIds: new Set(), reason: "대상 핀이 없습니다" };
      const targetIdSet = new Set(list.map((p) => p.id));
      const changes = list.map((p, i) => ({ id: p.id, page: p.page || 1, oldLabel: p.label, newLabel: String(s + i) }));
      // 중복 판정: (page, 새 라벨) 키별로 대상 밖 핀 + 이번에 바뀐 핀을 함께 세어 2개 이상이면 중복.
      const count = new Map();
      const bump = (pg, lbl) => { const k = pg + "|" + lbl; count.set(k, (count.get(k) || 0) + 1); };
      (allPins || []).forEach((p) => {
        if (!p || this.seriesOf(p) !== ser || targetIdSet.has(p.id)) return;
        const lbl = String(p.label == null ? "" : p.label).trim();
        if (lbl) bump(p.page || 1, lbl);
      });
      changes.forEach((c) => bump(c.page, c.newLabel));
      const duplicateIds = new Set();
      changes.forEach((c) => { if ((count.get(c.page + "|" + c.newLabel) || 0) > 1) duplicateIds.add(c.id); });
      return { ok: true, changes: changes, duplicateIds: duplicateIds };
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

    /** 현재 필터 상태 { checkboard, content } — 이 탭의 열람 세션 동안만 유지.
     *  🔴 [WO 20260921 근본수정] 예전엔 localStorage(wm-pin-filter, 전역 키)에 영구 저장했다 —
     *  프로젝트/배포본 구분이 없는 전역 키라, 한 프로젝트에서 "체크보드" 계열을 껐다 나가면
     *  그 값이 브라우저에 남아 완전히 다른(새) 프로젝트를 열 때도 조용히 적용되어, 그 프로젝트의
     *  핀이 전부(또는 한 계열이 전부) 안 보이는 유령 결함이 됐다(마스터 신고: "체크보드 모드일 때
     *  핀이 안 생긴다"). 새로 열 때마다 항상 전체 표시로 시작하는 게 안전하므로 영구저장을 끊는다
     *  (이 값은 이제 페이지 스크립트가 살아있는 동안의 메모리 상태일 뿐 — 새로고침/새 프로젝트=항상 전체표시).
     *  [WO 20260929 addendum] 키가 KINDS(3종) → SERIES(2종: checkboard/content)로 바뀌었다 —
     *  필터 바가 이제 모드(CHECKER/360)와 1:1인 2칩뿐이라 "미배치(empty)"는 별도 칩이 없다
     *  (content 칩 하나가 kindOf 상 content+empty 를 모두 포함 — seriesOf 기준이므로 자연히 그렇다). */
    filter() {
      // [WO 20260930-fixmode] 🔴 모드 = 작업공간 — 활성 모드(CHECKER/360)가 있으면 표시 계열은 그 모드
      // 하나로 고정된다(지도 마커·미니맵이 쓰는 isVisible() 이 이 값 하나만 본다 — 판정 지점 1곳).
      // 세션 칩 상태(_filter)는 건드리지 않는다 — 뷰어(모드 없음)로 돌아가면 종전 칩 필터 그대로.
      const act = this.activeSeries();
      if (act) return { checkboard: act === "checkboard", content: act === "content" };
      if (!this._filter) this._filter = { checkboard: true, content: true };
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

    /** 🔴 도면 마커·미니맵 점이 공통으로 쓰는 표시 여부 판정 (계열 필터 × 종류 필터 AND).
     *  [WO 20260929 addendum] kindOf(3종) 대신 seriesOf(2종)로 필터 판정 — 필터 바 칩이
     *  이제 CHECKER/360 2개뿐이라 필터 상태 키도 그 2종과 정확히 일치해야 한다. */
    isVisible(pin) { return !!this.filter()[this.seriesOf(pin)] && this.isIconVisible(pin); },

    isAll() { const f = this.filter(); return this.SERIES.every(k => f[k]); },

    toggle(series) {
      const f = this.filter();
      if (this.SERIES.indexOf(series) < 0) return;
      if (this.activeSeries()) return; // [WO 20260930-fixmode] 모드 작업공간에선 칩 1개 = 표시 전용
      const next = Object.assign({}, f, {});
      next[series] = !f[series];
      // 마지막 하나를 끄는 건 전체 숨김 → 그 하나만 보기로 해석(단독 선택)
      if (!this.SERIES.some(k => next[k])) { this.SERIES.forEach(k => next[k] = (k === series)); }
      this.SERIES.forEach(k => f[k] = next[k]);
      this._persist();
    },

    showAll() { const f = this.filter(); this.SERIES.forEach(k => f[k] = true); this._persist(); },

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
    userStart(author, series) { return this._lsNum(this.START_KEY_PREFIX + this._scope(author) + ":" + (series === "content" ? "content" : "checkboard")); },
    setUserStart(author, series, value) {
      let n = parseInt(value, 10);
      if (!Number.isFinite(n) || n < 1) n = 1;
      this._lsSet(this.START_KEY_PREFIX + this._scope(author) + ":" + (series === "content" ? "content" : "checkboard"), n);
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

    /** 페이지 내 부류별 핀 개수 (kindOf 3종 기준 — 이 함수 자체는 필터 바에서 더 쓰지 않지만
     *  하위호환을 위해 남겨둔다. 필터 바는 아래 seriesCounts()(2종)를 쓴다). */
    counts(pins, page) {
      const pg = page || 1;
      const c = { content: 0, empty: 0, checkboard: 0, all: 0 };
      (pins || []).forEach((p) => {
        if (!p || (p.page || 1) !== pg) return;
        c[this.kindOf(p)]++; c.all++;
      });
      return c;
    },

    /** [WO 20260929 addendum] 필터 바 칩 개수(2종: checkboard/content=360). */
    seriesCounts(pins, page) {
      const pg = page || 1;
      const c = { checkboard: 0, content: 0, all: 0 };
      (pins || []).forEach((p) => {
        if (!p || (p.page || 1) !== pg) return;
        c[this.seriesOf(p)]++; c.all++;
      });
      return c;
    },

    /* ── 필터 칩 UI (도면 좌상단) — 기존 구역페이저 칩 스타일(.zpager-tab) 재사용 ──
       [WO 20260929 addendum, 지휘자 정정] 마스터 원문: "그냥 체크보드랑 360모드랑 2개 해 —
       내가 시킨 것만 하고". 구 3종(콘텐츠/미배치/체크보드) kind 칩 + 별도 아이콘(종류) 필터
       칩 그룹 + 중복 "전체" 칩을 전부 없애고, 모드와 1:1인 [CHECKER][360] 2칩만 남긴다.
       두 칩은 독립 토글(기본 둘 다 on = 전부 보임) — 별도 "전체" 칩 불필요(SERIES.length===2
       라 하나만 꺼도 나머지 하나가 곧 "그것만 보기"가 된다). 상태는 세션 메모리에만
       (filter() 주석 참조 — 고스트 필터 재발 방지, 영구저장 금지 유지). */
    renderChips() {
      if (typeof document === "undefined") return;
      const host = document.getElementById("pin-filter-bar");
      if (!host) return;
      const page = (typeof State !== "undefined" && State.pdfPage) || 1;
      const allPins = (typeof State !== "undefined" && State.pins) || [];
      // [WO 46_DeckOutline 수정] 지금 로드된 구역이 창(crop) 구역이면 그 크롭 안의 핀만 센다 —
      // SoT: Projects.pinsForDeck(§31_Projects.js, §G-2-5 — 트리·AllPins 탭과 같은 함수 재사용).
      const curDeck = (typeof Projects !== "undefined") ? Projects.currentDeck : null;
      const pins = (typeof Projects !== "undefined" && Projects.pinsForDeck) ? Projects.pinsForDeck(allPins, curDeck) : allPins;
      // [WO 20260930-badge] 🔴 카운트는 페이지 전체(두 계열) 기준으로 센다 — modePins()로 먼저
      // 거르면 활성 모드가 아닌 계열은 항상 0으로 계산되고(칩 자체가 못 뜸), 활성 모드 핀이
      // 0개면 c.all 도 0이 되어 칩바 전체가 숨어버린다(재현: 360 모드에서 콘텐츠 핀 0개일 때
      // 칩 영역이 완전히 빈다 — 지휘자 라이브 보고). seriesCounts 는 항상 전체 기준으로 세고,
      // 아래에서 활성 모드일 때만 자기 계열 칩 하나로 좁힌다.
      const c = this.seriesCounts(pins, page);
      const active = this.activeSeries();   // 모드 작업공간 SoT — null 이면 분리 없음(뷰어/구 view)
      const f = this.filter();
      const chip = (series, label, n, on) =>
        '<button type="button" class="zpager-tab pinfilter-chip pf-' + series + (on ? " active" : "") +
        '" data-series="' + series + '" aria-pressed="' + (on ? "true" : "false") +
        '" title="' + label + ' 핀만 보기"><span class="pinfilter-dot"></span>' + label +
        '<span class="zpager-cnt">' + n + '</span></button>';
      let html = "";
      if (active) {
        // 모드 작업공간(CHECKER/360 분리 화면) — 그 모드 자신의 칩만, 0개여도 대칭 표시한다
        // (마스터 재현: CHECKER "CHECKER 11" 처럼 360 모드도 "360 0" 이 보여야 한다).
        host.classList.remove("hidden");
        html = chip(active, this.LABELS[active], c[active] || 0, !!f[active]);
      } else {
        // 모드 분리 없는 화면(뷰어/구 view) — 기존 2칩, 개수가 있는 계열만(회귀 없음).
        if (!c.all) { host.classList.add("hidden"); host.innerHTML = ""; return; }
        host.classList.remove("hidden");
        this.SERIES.forEach(s => { if (c[s]) html += chip(s, this.LABELS[s], c[s], !!f[s]); });
      }

      host.innerHTML = html;
      if (!this._chipsBound) {
        this._chipsBound = true;
        host.addEventListener("click", (e) => {
          const btn = e.target && e.target.closest ? e.target.closest("[data-series]") : null;
          if (!btn) return;
          e.stopPropagation();
          this.toggle(btn.dataset.series);
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
