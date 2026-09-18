
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

    /* ══ 표시 필터 ══════════════════════════════════════════
       숨김 = 표시만 감춘다. 저장 데이터·번호 계열은 필터와 무관하게 불변. */
    _filter: null,

    /** 현재 필터 상태 { content, empty, checkboard } — 세션 유지 + localStorage 복원 */
    filter() {
      if (!this._filter) {
        this._filter = { content: true, empty: true, checkboard: true };
        try {
          const raw = localStorage.getItem(this.FILTER_KEY);
          if (raw) {
            const v = JSON.parse(raw);
            this.KINDS.forEach(k => { if (typeof v[k] === "boolean") this._filter[k] = v[k]; });
          }
        } catch (e) { /* 사생활 모드/파손값 → 기본값(전체 표시) 유지 */ }
        // 전부 꺼진 상태는 "핀이 하나도 없다"는 거짓말이 된다 → 전체 표시로 복구
        if (!this.KINDS.some(k => this._filter[k])) this._filter = { content: true, empty: true, checkboard: true };
      }
      return this._filter;
    },

    /** 핀의 아이콘 종류 id (없으면 기본 number) — PinIcons.SET 의 id 와 1:1 */
    iconOf(pin) { return (pin && pin.icon) || "number"; },

    /* ══ 종류(아이콘) 필터 — [마스터 요청 2026-09-03] 계열(kind) 필터와 별도 축.
       둘 다 걸어야 보인다(AND) — 같은 SoT 원칙으로 도면·미니맵 양쪽이 이 함수 하나만 본다. */
    ICON_FILTER_KEY: "wm-pin-icon-filter",
    _iconFilter: null,

    /** 아이콘별 표시 상태 맵 { iconId: boolean }. 키가 없으면 표시(기본 전체 표시). */
    iconFilter() {
      if (!this._iconFilter) {
        this._iconFilter = {};
        try {
          const raw = localStorage.getItem(this.ICON_FILTER_KEY);
          if (raw) { const v = JSON.parse(raw); if (v && typeof v === "object") this._iconFilter = v; }
        } catch (e) { /* 사생활 모드/파손값 → 기본값(전체 표시) 유지 */ }
      }
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

    _persistIcon() {
      try { localStorage.setItem(this.ICON_FILTER_KEY, JSON.stringify(this.iconFilter())); } catch (e) {}
    },

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

    _persist() {
      try { localStorage.setItem(this.FILTER_KEY, JSON.stringify(this.filter())); } catch (e) {}
    },

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
