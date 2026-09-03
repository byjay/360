
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
       실측(WCAG 2.1, 흰 도면 #fff 기준 — 아래 값은 테마 변수 아님·라이트/다크 동일):
         등록   head2 #1e3a8a 10.36:1 · needle #172554 14.69:1 · text #1e3a8a 10.36:1
         미등록 head2 #6366f1  4.47:1 · needle #4f46e5  6.29:1 · text #4338ca  7.90:1
         등록↔미등록 상호 분리도 head2 2.32:1 / needle 2.34:1 (눈에 띄게 다른 톤)
       ⚠ 색만으로 구분하지 않는다 → patternOf() 형태 단서(실선/파선/점선) 병행. */
    CHECKBOARD_EMPTY_COLOR: { head: "#818cf8", head2: "#6366f1", needle: "#4f46e5", text: "#4338ca" },

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
      return { kind: kind, filled: filled, colors: this.colorsOf(kind, filled), dash: pat.dash, border: pat.border };
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

    /** 체크보드 다음 번호 = 시작번호 + (같은 페이지 체크보드 핀 수). 계열 독립. */
    nextCheckboardNo(pins, page, start) {
      const pg = page || 1;
      const s = (Number.isFinite(start) && start >= 1) ? start : 1;
      const n = (pins || []).filter(p => p && (p.page || 1) === pg && p.checkboard).length;
      return s + n;
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
