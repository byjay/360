  const AllPins = {
    open: false,
    sort: "page",     // 'page' | 'name'
    query: "",
    scope: "deck",    // [WO 20261023-pointlist] 'deck'(이 구역만, 기존) | 'zone'(구역별 전체 — 트리 SoT 순서로 그룹)
    selected: new Set(),  // [WO 20261001-allpins] 선택된 pin id
    _thumbCache: {},  // imageId → dataURL (썸네일 1회 fetch 캐시)
    _numMaps: {},     // [WO 20261001-allpins] page → PinSeries.numbers() 캐시(render() 1회마다 초기화)

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
      // [WO 20261019-unifymode] 탭 = [전체/사진 있음/사진 없음] 필터(PinSeries.photoFilter — 도면 칩·트리와 같은 상태 하나). 모드 전환 없음.
      const tabsHost = $("allpins-tabs");
      if (tabsHost) tabsHost.addEventListener("click", (e) => {
        const b = e.target && e.target.closest ? e.target.closest("[data-pfilter]") : null;
        if (b) this._switchTab(b.dataset.pfilter);
      });
      const bandBtn = $("allpins-band-btn");
      if (bandBtn) bandBtn.addEventListener("click", () => { if (typeof NumBand !== "undefined" && NumBand.open) NumBand.open(bandBtn); });
      // [WO 20261023-pointlist] 범위 전환 — 이 구역만 / 구역별(전체, 트리 SoT 그룹).
      const scopeHost = $("allpins-scope");
      if (scopeHost) scopeHost.addEventListener("click", (e) => {
        const b = e.target && e.target.closest ? e.target.closest("[data-scope]") : null;
        if (!b || b.dataset.scope === this.scope) return;
        this.scope = b.dataset.scope;
        scopeHost.querySelectorAll(".allpins-scope-btn").forEach((x) => x.classList.toggle("active", x.dataset.scope === this.scope));
        this.render();
      });
      // [WO 20261023-pointlist] 내보내기 — 지금 보이는 목록(범위·필터·정렬·검색 반영) 그대로.
      const expCsv = $("allpins-export-csv");
      if (expCsv) expCsv.addEventListener("click", () => this._exportCsv());
      const expXlsx = $("allpins-export-xlsx");
      if (expXlsx) expXlsx.addEventListener("click", () => this._exportXlsx());
      // 선택 — 전체선택(보이는 것만)/선택해제, 카드 체크박스는 목록에 위임 바인딩
      const selAll = $("allpins-select-all");
      if (selAll) selAll.addEventListener("click", () => this._selectAllVisible());
      const selClear = $("allpins-select-clear");
      if (selClear) selClear.addEventListener("click", () => this._clearSelection());
      const listEl = $("allpins-list");
      if (listEl) listEl.addEventListener("change", (e) => {
        const cb = e.target && e.target.closest ? e.target.closest(".allpins-sel") : null;
        if (!cb) return;
        const pin = (State.pins || []).find((p) => String(p.id) === String(cb.dataset.id));
        if (!pin) return;
        if (cb.checked) this.selected.add(pin.id); else this.selected.delete(pin.id);
        const row = cb.closest(".allpins-item");
        if (row) row.classList.toggle("selected", cb.checked);
        this._renderSelectBar();
        this._renderActions();
      });
      // 선택 삭제 / 번호 다시 매기기
      const delBtn = $("allpins-btn-delete");
      if (delBtn) delBtn.addEventListener("click", () => this._onDelete());
      const renBtn = $("allpins-btn-renumber");
      if (renBtn) renBtn.addEventListener("click", () => this._openRenumberSheet());
      // 단축키 P 로 토글 (입력 중/파노라마 열림 제외)
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && this.open) { this.hide(); return; }
        const tag = (e.target && e.target.tagName) || "";
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (PanoViewer.open) return;
        if ((e.key === "p" || e.key === "P") && State.pins.length) { e.preventDefault(); this.toggle(); }
      });
    },

    /** [WO 20261001-allpins] 선택 가능(체크박스·전체선택·선택해제) — 디자이너 세션(뷰어/열람전용 제외). */
    _canSelect() { return typeof State !== "undefined" && State.mode === "designer" && !(typeof Auth !== "undefined" && Auth.readonly); },
    /** 번호 다시 매기기 권한 — 선택과 동일(디자이너 이상, 열람자 불가). */
    _canRenumber() { return this._canSelect(); },
    /** 선택 삭제 권한 — 기존 일괄삭제 정본(App.canBulkDeletePins: 소유자·super) 그대로 재사용. */
    _canDelete() { return typeof App !== "undefined" && !!App.canBulkDeletePins && App.canBulkDeletePins(); },

    /** [WO 20261019-unifymode] 대상 계열 = 항상 "all"(핀은 하나 — 구 CHECKER/360 탭 폐기). 재채번·번호 대역이 이 값을 쓴다. */
    _currentSeries() { return "all"; },
    /** 지금 필터(PinSeries.photoFilter SoT) */
    _currentFilter() { return (typeof PinSeries !== "undefined" && PinSeries.photoFilter) ? PinSeries.photoFilter() : "all"; },
    /** 확인창·시트 문구용 범위 이름(전체 / 사진 있음 / 사진 없음) */
    _scopeLabel() {
      const k = this._currentFilter();
      const f = (typeof PinSeries !== "undefined" && PinSeries.PHOTO_FILTERS) ? PinSeries.PHOTO_FILTERS.find((x) => x.key === k) : null;
      return (f && f.label) || "전체";
    },
    /** 필터 탭 클릭 — 도면 칩·트리와 같은 필터를 바꾼다(PinSeries.apply 가 지도·트리·이 패널을 함께 다시 그린다). */
    _switchTab(key) {
      if (typeof PinSeries === "undefined" || !PinSeries.setPhotoFilter) return;
      if (key === this._currentFilter()) return;
      PinSeries.setPhotoFilter(key);
      this.selected.clear();
      if (PinSeries.apply) PinSeries.apply(); else this.render();
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
      this.selected.clear();
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

    /** [WO 46_DeckOutline 수정] 지금 로드된 구역(Projects.currentDeck)이 창(crop) 구역이면 그 크롭
     *  안의 핀만 — SoT: Projects.pinsForDeck(§31_Projects.js, 트리·필터칩과 같은 함수, §G-2-5). */
    _scopedPins() {
      const all = State.pins || [];
      const deck = (typeof Projects !== "undefined") ? Projects.currentDeck : null;
      const scoped = (typeof Projects !== "undefined" && Projects.pinsForDeck) ? Projects.pinsForDeck(all, deck) : all;
      // [WO 20261016-multisheet P4] 도면 간 연결 핀 = 논리 핀 1개(대표 1행) — 개수·목록·촬영현황이 이중 집계되지 않게
      return (typeof PinLink !== "undefined" && PinLink.dedupe) ? PinLink.dedupe(scoped) : scoped;
    },

    /** [WO 20261019-unifymode] 현재 필터(사진 유무)에 맞는 핀 — 페이지 구분 없이 전체.
     *  [WO 20261023-pointlist] 임의의 핀 배열을 받는 _modePinsFrom 으로 일반화 — "이 구역"(_scopedPins)과
     *  "구역별" 그룹(각 구역의 핀 부분집합)이 같은 탭 필터 로직 한 곳을 쓴다(§G-2-5). */
    _modePinsFrom(pins) {
      const arr = (pins || []).filter(Boolean);
      return (typeof PinSeries !== "undefined" && PinSeries.filterByPhoto) ? PinSeries.filterByPhoto(arr) : arr;
    },
    _modePins() { return this._modePinsFrom(this._scopedPins()); },

    /** 검색 필터 적용 전, 현재 정렬 기준(this.sort) 그대로 둔 전체 목록 — 재채번 "목록 순서" 기준이
     *  검색 중에도 흔들리지 않도록 _sorted()(검색 필터 포함)와 분리했다.
     *  [WO 20261023-pointlist] _sortedAllFrom 으로 일반화(구역별 그룹과 공유). */
    _sortedAllFrom(pins) {
      const arr = this._modePinsFrom(pins).map((p, i) => ({ pin: p, idx: i }));
      if (this.sort === "name") {
        arr.sort((a, b) => (a.pin.label || "").localeCompare(b.pin.label || "", "ko"));
      } else {
        arr.sort((a, b) => ((a.pin.page || 1) - (b.pin.page || 1)) || (a.idx - b.idx));
      }
      return arr;
    },
    _sortedAll() { return this._sortedAllFrom(this._scopedPins()); },

    _sortedFrom(pins) {
      // [WO 20261019-unifymode] 필터 탭에 맞는 핀만(SoT: PinSeries.photoFilter)
      const all = this._sortedAllFrom(pins);
      if (!this.query) return all;
      return all.filter((o) => (o.pin.label || "").toLowerCase().includes(this.query));
    },
    _sorted() { return this._sortedFrom(this._scopedPins()); },

    /** [WO 20261001-allpins] 핀의 페이지별 표시 번호(PinSeries.numbers/formatNo 정본) — render() 1회마다 캐시. */
    _numFor(pin) {
      const pg = (pin && pin.page) || 1;
      if (!this._numMaps[pg]) this._numMaps[pg] = PinSeries.numbers(State.pins, pg);
      return this._numMaps[pg].get(pin.id);
    },

    /** [WO 20261019-unifymode] 필터 탭 [전체 N][사진 있음 N][사진 없음 N] 렌더(이 구역 범위 — _scopedPins). */
    _renderTabs() {
      const host = document.getElementById("allpins-tabs");
      if (!host || typeof PinSeries === "undefined" || !PinSeries.PHOTO_FILTERS) return;
      const cur = this._currentFilter();
      const counts = PinSeries.photoCounts(this._scopedPins());
      host.innerHTML = PinSeries.PHOTO_FILTERS.map((f) => {
        const active = f.key === cur;
        return '<button type="button" class="allpins-tab allpins-tab-' + f.key + (active ? " active" : "") +
          '" data-pfilter="' + f.key + '" role="tab" aria-selected="' + (active ? "true" : "false") + '">' +
          f.label + ' <span class="allpins-tab-cnt">' + (counts[f.key] || 0) + '</span></button>';
      }).join("");
    },

    /** 패널 상단 번호 대역 버튼 — "시작번호 세팅"은 번호 대역 메뉴(NumBand) SoT 하나로 일원화. */
    _renderBand() {
      const btn = document.getElementById("allpins-band-btn");
      if (!btn) return;
      const show = typeof State !== "undefined" && State.mode === "designer" && typeof App !== "undefined" && App._numBand && typeof PinSeries !== "undefined";
      btn.classList.toggle("hidden", !show);
      if (!show) return;
      const ser = this._currentSeries();
      const band = App._numBand();
      const start = App._checkboardStart ? App._checkboardStart(State.pdfPage || 1, ser) : PinSeries.bandRange(band).lo;
      const nx = PinSeries.nextInBand(State.pins, State.pdfPage || 1, ser, band, start);
      btn.textContent = "대역 " + PinSeries.bandLabel(band) + (nx.full ? " · 가득" : " · 다음 " + (nx.label != null ? nx.label : PinSeries.formatNo(nx.no, ser)));
    },

    /** 전체선택/선택해제/"N개 선택됨" — 검색 중이면 "보이는 항목만" 명시. */
    _renderSelectBar() {
      const bar = document.getElementById("allpins-selectbar");
      if (!bar) return;
      if (!this._canSelect()) { bar.classList.add("hidden"); return; }
      bar.classList.remove("hidden");
      const selAll = document.getElementById("allpins-select-all");
      if (selAll) selAll.textContent = this.query ? "보이는 항목 전체 선택" : "전체 선택";
      const cnt = document.getElementById("allpins-select-count");
      if (cnt) cnt.textContent = this.selected.size + "개 선택됨";
    },

    /** 하단 액션(선택 삭제 · 번호 다시 매기기) — 권한 없으면 버튼째 숨김. */
    _renderActions() {
      const bar = document.getElementById("allpins-actions");
      if (!bar) return;
      const canDel = this._canDelete();
      const canRen = this._canRenumber();
      bar.classList.toggle("hidden", !canDel && !canRen);
      const n = this.selected.size;
      const delBtn = document.getElementById("allpins-btn-delete");
      if (delBtn) {
        delBtn.classList.toggle("hidden", !canDel);
        delBtn.disabled = n === 0;
        delBtn.textContent = n ? ("선택 삭제 " + n + "개") : "선택 삭제";
      }
      const renBtn = document.getElementById("allpins-btn-renumber");
      if (renBtn) {
        renBtn.classList.toggle("hidden", !canRen);
        renBtn.textContent = "번호 다시 매기기" + (n ? " (" + n + "개)" : "");
        // [WO 20261016-bulkedit] 형제 버튼 [번호 일괄 편집] — 선택한 핀(없으면 지금 구역) · index.html 비점유(JS 생성, 같은 클래스)
        let edBtn = document.getElementById("allpins-btn-bulkedit");
        if (!edBtn && renBtn.parentNode && typeof document.createElement === "function") {
          edBtn = document.createElement("button");
          edBtn.id = "allpins-btn-bulkedit"; edBtn.type = "button"; edBtn.className = "allpins-action-btn";
          edBtn.addEventListener("click", () => {
            const sel = (State.pins || []).filter((p) => this.selected.has(p.id));
            if (typeof NumReset !== "undefined" && NumReset.openEdit) NumReset.openEdit(sel.length ? sel : null);
          });
          renBtn.parentNode.insertBefore(edBtn, renBtn.nextSibling);
        }
        if (edBtn) {
          edBtn.classList.toggle("hidden", !canRen || typeof NumReset === "undefined");
          edBtn.textContent = "번호 일괄 편집" + (n ? " (" + n + "개)" : "");
        }
      }
    },

    render() {
      if (!this.open) return;
      this._numMaps = {};
      this._renderTabs();
      this._renderBand();
      this._renderSelectBar();
      this._renderActions();
      const listEl = document.getElementById("allpins-list");
      const emptyEl = document.getElementById("allpins-empty");
      const countEl = document.getElementById("allpins-count");
      // 탭 전환 등으로 현재 목록 밖에 남은 선택은 정리(교차 탭 유령 선택 방지)
      const inTab = new Set(this._modePins().map((p) => p.id));
      Array.from(this.selected).forEach((id) => { if (!inTab.has(id)) this.selected.delete(id); });
      // [WO 20261007-qrcov] 촬영 현황 요약 한 줄(켜졌을 때만) — 이 구역 범위(_scopedPins = Projects.pinsForDeck SoT)
      if (typeof Coverage !== "undefined" && Coverage.renderAllPinsSummary) { try { Coverage.renderAllPinsSummary(this._scopedPins()); } catch (e) {} }
      // [WO 20261023-pointlist] 범위 = 구역별(전체) — 트리 SoT 순서로 그룹 렌더(별도 분기).
      if (this.scope === "zone") { this._renderGroupedList(listEl, emptyEl, countEl); return; }
      // ── 범위 = 이 구역만(기존 그대로) ──
      if (countEl) countEl.textContent = this._modePins().length;
      const rows = this._sorted();
      listEl.innerHTML = "";
      if (!rows.length) { emptyEl.classList.remove("hidden"); return; }
      emptyEl.classList.add("hidden");
      rows.forEach(({ pin, idx }) => { listEl.appendChild(this._buildRow(pin, idx, null)); });
    },

    /** [WO 20261023-pointlist] 구역별(전체) — 프로젝트 트리 SoT(UI.groupDecksByParent) 순서로 구역·영역을
     *  순회하며 그룹 헤더(이름·핀 수·사진 있음 수) + 행을 그린다. 탭(사진 필터)·정렬·검색은 기존 함수
     *  (_modePinsFrom/_sortedFrom)를 그룹별 핀 부분집합에 그대로 적용 — 새 필터 로직 0. */
    _renderGroupedList(listEl, emptyEl, countEl) {
      const groups = this._zoneGroups();
      const zc = this._zoneCollapsedSet();
      listEl.innerHTML = "";
      let totalInTab = 0, shownRows = 0;
      groups.forEach(({ deck, depth, pins }) => {
        totalInTab += this._modePinsFrom(pins).length;
        const rows = this._sortedFrom(pins);
        if (!rows.length) return; // 탭/검색으로 걸러져 빈 그룹은 숨김(날조 금지 — 0인 그룹을 억지로 보여주지 않음)
        shownRows += rows.length;
        const hasPhotoCnt = rows.filter((o) => typeof PinSeries !== "undefined" && PinSeries.hasPhoto && PinSeries.hasPhoto(o.pin)).length;
        const key = String(deck.id);
        const collapsed = zc.has(key);
        const group = document.createElement("div");
        group.className = "allpins-group" + (collapsed ? "" : " open");
        group.style.marginLeft = (Math.max(0, depth - 1) * 14) + "px";
        const head = document.createElement("button");
        head.type = "button";
        head.className = "allpins-group-head";
        head.innerHTML =
          '<svg class="allpins-group-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>' +
          '<span class="allpins-group-name">' + UI.escapeHtml(deck.name || "(이름 없음)") + '</span>' +
          '<span class="allpins-group-cnt">핀 ' + rows.length + '</span>' +
          '<span class="allpins-group-cnt">사진 ' + hasPhotoCnt + '</span>';
        const body = document.createElement("div");
        body.className = "allpins-group-body" + (collapsed ? " hidden" : "");
        head.addEventListener("click", () => {
          const zc2 = this._zoneCollapsedSet();
          const nowOpen = group.classList.toggle("open");
          if (nowOpen) zc2.delete(key); else zc2.add(key);
          this._saveZoneCollapsed(zc2);
          body.classList.toggle("hidden", !nowOpen);
        });
        group.appendChild(head);
        rows.forEach(({ pin, idx }) => { body.appendChild(this._buildRow(pin, idx, deck)); });
        group.appendChild(body);
        listEl.appendChild(group);
      });
      if (countEl) countEl.textContent = totalInTab;
      if (!shownRows) emptyEl.classList.remove("hidden"); else emptyEl.classList.add("hidden");
    },

    /** [WO 20261023-pointlist] 프로젝트 트리 SoT 순서(UI.groupDecksByParent, DFS)로 구역·영역을
     *  나열하고, 각 구역의 핀 부분집합을 계산한다 — 새 트리/정렬 로직 0(기존 함수 재사용).
     *  핀 배정 규칙(크롭 있는 영역 우선, 겹치면 더 작은 영역이 가져간다)은 11_UI.renderTree 의
     *  zoneOfPin(가장 작은 면적 우선) 원칙을 구역(deck) 단위로 그대로 옮긴 것 — 겹치지 않는 크롭이면
     *  결과가 Projects.pinsForDeck(SoT) 와 완전히 같다. 로드되지 않은(다른 배포본) 구역은 핀을
     *  알 수 없어 빈 배열(0 날조 금지) — 트리의 Coverage.deckSummary "모름" 규칙과 동일. */
    _zoneGroups() {
      const decks = (typeof Projects !== "undefined" && Array.isArray(Projects.decks)) ? Projects.decks : [];
      const { roots, childrenOf } = (typeof UI !== "undefined" && UI.groupDecksByParent) ? UI.groupDecksByParent(decks) : { roots: decks, childrenOf: new Map() };
      const order = [];
      const walk = (list, depth) => { (list || []).forEach((d) => { order.push({ deck: d, depth }); walk(childrenOf.get(String(d.id)) || [], depth + 1); }); };
      walk(roots, 1);

      const basePins = (typeof PinLink !== "undefined" && PinLink.dedupe) ? PinLink.dedupe(State.pins || []) : (State.pins || []).slice();
      const hasCrop = (deck) => !!(deck && deck.crop && deck.crop.w > 0 && deck.crop.h > 0);

      // 1) 크롭이 있는(영역) 구역 — 지오메트리로 바로 분리(선택 상태와 무관). 겹치면 더 작은 영역이 가져간다.
      const claimedBy = new Map(); // pinId -> { deck, area }
      order.forEach(({ deck }) => {
        const loaded = deck.deployment_id && typeof State !== "undefined" && String(deck.deployment_id) === String(State.currentDeploymentId || "");
        if (!loaded || !hasCrop(deck)) return;
        const pins = (typeof Projects !== "undefined" && Projects.pinsForDeck) ? Projects.pinsForDeck(basePins, deck) : [];
        const area = Math.max(0, deck.crop.w) * Math.max(0, deck.crop.h);
        pins.forEach((p) => {
          const cur = claimedBy.get(p.id);
          if (!cur || area < cur.area) claimedBy.set(p.id, { deck, area });
        });
      });

      // [WO 20261023-followups3 F2] 크롭 없는(구역) 루트가 2개 이상 같은 page 를 가리키면, 아래
      // forEach 가 순서(order = 트리 SoT, walk() 가 roots 를 선언 순서대로 push)대로 돌며 leftover
      // 핀을 "처음 만난 구역" 1곳에만 귀속시킨다(claimedLeftover) — 이후 같은 page 의 다른 구역은
      // 이미 귀속된 핀을 제외해 중복 집계를 막는다.
      const claimedLeftover = new Set();
      return order.map(({ deck, depth }) => {
        const loaded = deck.deployment_id && typeof State !== "undefined" && String(deck.deployment_id) === String(State.currentDeploymentId || "");
        if (!loaded) return { deck, depth, loaded: false, pins: [] };
        let pins;
        if (hasCrop(deck)) {
          pins = basePins.filter((p) => { const c = claimedBy.get(p.id); return c && c.deck === deck; });
        } else {
          // 크롭 없는(구역) — 자기 페이지의 핀 중, 하위 영역(크롭)이 이미 가져간 핀은 뺀다(중복 0).
          // deck.page == null = 모든 페이지(기존 pinsForDeck "크롭 없으면 전체" 규칙과 같은 와일드카드).
          pins = basePins.filter((p) => (deck.page == null || (p.page || 1) === deck.page) && !claimedBy.has(p.id) && !claimedLeftover.has(p.id));
          pins.forEach((p) => claimedLeftover.add(p.id));
        }
        return { deck, depth, loaded: true, pins };
      });
    },

    /** [WO 20261023-pointlist] 접기 상태 — 프로젝트별 로컬스토리지(다른 프로젝트로 새지 않게 키에 project id 포함). */
    _zcKey() {
      const pid = (typeof Projects !== "undefined" && Projects.currentProject && Projects.currentProject.id) || "x";
      return "wm_allpins_zc:" + pid;
    },
    _zoneCollapsedSet() {
      let arr = [];
      try { arr = JSON.parse(localStorage.getItem(this._zcKey()) || "[]"); } catch (e) {}
      return new Set(Array.isArray(arr) ? arr.map(String) : []);
    },
    _saveZoneCollapsed(set) {
      try { localStorage.setItem(this._zcKey(), JSON.stringify(Array.from(set))); } catch (e) {}
    },

    /** [WO 20261023-pointlist] 핀의 코멘트/요청 요약 — 정본 1순위 = 42_Requests(요청·질문·결함노트,
     *  디자이너 세션 캐시 Requests._live, 네트워크 재요청 0 — 이미 받아온 캐시만 읽는다). 없으면
     *  (열람 세션·캐시 비어있음) pin.note 로 정직하게 폴백. 둘 다 없으면 빈 요약(지어내지 않음). */
    _commentSummary(pin) {
      if (typeof Requests !== "undefined" && Requests._live) {
        const items = Requests._live().filter((n) => n && n.kind !== "reply" && String(n.pin_id || "") === String(pin.id));
        if (items.length) {
          const latest = items.slice().sort((a, b) => (Number(b.updated_at || b.created_at || 0)) - (Number(a.updated_at || a.created_at || 0)))[0];
          return { text: String((latest && latest.body) || "").slice(0, 40), count: items.length };
        }
      }
      if (pin.note) return { text: String(pin.note).slice(0, 40), count: 1 };
      return { text: "", count: 0 };
    },

    /** [WO 20261023-pointlist] 그 구역으로 전환(네트워크 재로드 없음 — 같은 배포본 안의 다른 구역/영역
     *  선택일 뿐) + 기존 _goto(focusPin+보기). 플랫 모드(deck=null)는 전환 없이 기존 그대로. */
    async _activatePin(pin, deck) {
      if (deck && typeof Projects !== "undefined" && Projects.currentDeck !== deck) {
        Projects.currentDeck = deck;
        if (Projects._renderDecks) { try { Projects._renderDecks(); } catch (e) {} }
      }
      await this._goto(pin);
    },

    /** [WO 20261023-pointlist] 행 1개 DOM — 기존 render() 인라인 코드를 그대로 옮기고(마크업 변경 0),
     *  코멘트/요청 요약 + [360] 버튼(사진 있는 핀만)만 추가했다. flat/grouped 두 호출부가 공유(SoT). */
    _buildRow(pin, idx, deck) {
      const badge = this._kindBadge(pin);
      const hasMedia = App.pinHasContent(pin);
      const totalPages = (typeof App !== "undefined" && App._totalPages ? App._totalPages() : 0);   // [WO 20261016-multisheet] 페이지 수 SoT
      const pageTag = totalPages > 1 ? `P${pin.page || 1}` : "";
      const info = this._numFor(pin);
      const noText = info ? (PinSeries.textOf ? PinSeries.textOf(info) : PinSeries.formatNo(info.no, info.series)) : String((idx || 0) + 1);   // [WO 20261016-multisheet P6] 접두 포함
      const linkTag = (typeof PinLink !== "undefined" && PinLink.isLinked(pin) && PinLink.members(State.pins, pin).length > 1) ? " · 연결 " + PinLink.members(State.pins, pin).length + "도면" : "";
      const isSel = this.selected.has(pin.id);
      const canSelect = this._canSelect();
      const cs = this._commentSummary(pin);
      const row = document.createElement("div");
      row.className = "allpins-item allpins-" + (PinSeries.hasPhoto && PinSeries.hasPhoto(pin) ? "photo" : "nophoto") + (State.activePin === pin.id ? " active" : "") + (isSel ? " selected" : "");
      row.dataset.id = pin.id;
      row.setAttribute("role", "button");
      row.tabIndex = 0;
      row.innerHTML = `
        ${canSelect ? `<label class="allpins-sel-wrap" title="선택"><input type="checkbox" class="allpins-sel" data-id="${pin.id}" ${isSel ? "checked" : ""} aria-label="포인트 선택"/></label>` : ""}
        <span class="allpins-thumb ${badge.cls}" data-imgid="${pin.imageId || ""}">
          <span class="allpins-thumb-ico">${badge.ico}</span>
          <span class="allpins-thumb-no">${UI.escapeHtml(noText)}</span>
        </span>
        <span class="allpins-meta">
          <span class="allpins-name">${UI.escapeHtml(pin.label || "(이름 없음)")}</span>
          <span class="allpins-sub">
            <span class="allpins-kind ${badge.cls}">${badge.txt}</span>
            ${pageTag ? `<span class="allpins-page">${pageTag}</span>` : ""}${linkTag ? `<span class="allpins-page">${UI.escapeHtml(linkTag.replace(/^ · /, ""))}</span>` : ""}
          </span>
          ${cs.count ? `<span class="allpins-row-comment" title="${UI.escapeHtml(cs.text)}">${UI.escapeHtml(cs.text)}${cs.count > 1 ? ' <span class="allpins-row-comment-cnt">+' + (cs.count - 1) + '</span>' : ""}</span>` : ""}
        </span>
        <span class="allpins-go" title="이동 + 보기">
          ${hasMedia
            ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/></svg>'
            : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>'}
        </span>
        ${hasMedia ? `<button type="button" class="allpins-row-360" title="이 포인트 360° 보기">360°</button>` : ""}`;
      row.addEventListener("click", (e) => {
        if (e.target && e.target.closest && e.target.closest(".allpins-sel-wrap")) return;
        this._activatePin(pin, deck);
      });
      row.addEventListener("keydown", (e) => { if (e.key === "Enter") this._activatePin(pin, deck); });

      // 360° 그림 썸네일 비동기 로드 (캐시)
      if (pin.imageId) this._loadThumb(row.querySelector(".allpins-thumb"), pin.imageId);
      return row;
    },

    /** [WO 20261023-pointlist] 지금 보이는 목록(범위·필터·정렬·검색 반영) → 내보내기용 {pins, decks}.
     *  pins 는 원본 핀을 건드리지 않게 복사해 deckId 만 얹는다(Report._rows 의 _deckOf 가 읽는 필드 —
     *  State.pins 의 실 객체를 직접 mutate 하면 이후 다른 내보내기(47_Report)가 잘못된 deckId 를 보게
     *  된다, §10 SoT 위반 금지). decks 는 Report._rows 가 바로 읽는 {id,name,page,zones} 모양. */
    _visibleRowsForExport() {
      const zones = (typeof State !== "undefined" && Array.isArray(State.zones)) ? State.zones : [];
      if (this.scope === "zone") {
        const pins = [], decks = [];
        this._zoneGroups().forEach((g) => {
          const rows = this._sortedFrom(g.pins);
          if (!rows.length) return;
          decks.push({ id: g.deck.id, name: g.deck.name || "(이름 없음)", page: null, zones });
          rows.forEach((o) => pins.push(Object.assign({}, o.pin, { deckId: g.deck.id })));
        });
        return { pins, decks };
      }
      const deck = (typeof Projects !== "undefined" && Projects.currentDeck) || null;
      const pins = this._sorted().map((o) => Object.assign({}, o.pin, { deckId: deck ? deck.id : null }));
      const decks = [{ id: deck ? deck.id : null, name: (deck && deck.name) || "", page: null, zones }];
      return { pins, decks };
    },

    /** [WO 20261023-pointlist] CSV — 47_Report._rows/_toCsv(직렬화 SoT) 재사용, 새 직렬화 0.
     *  notes=[]  — 노트수/미해결수 열은 네트워크 재요청 없이 "모름"이 아니라 0으로 비게 된다(열 자체는
     *  47_Report 의 기존 계약 그대로 유지하기 위함 — 이 패널에서 노트 전수를 다시 fetch 하지 않는다). */
    _exportCsv() {
      if (typeof Report === "undefined") { Prompt.toast && Prompt.toast("내보내기 모듈을 불러오지 못했습니다."); return; }
      const { pins, decks } = this._visibleRowsForExport();
      if (!pins.length) { Prompt.toast && Prompt.toast("내보낼 포인트가 없습니다."); return; }
      const role = (typeof Auth !== "undefined" && Auth.role) || "viewer";
      const rows = Report._rows(pins, [], decks, role);
      const csvStr = Report._toCsv(rows);
      const blob = new Blob([csvStr], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "seastar_points_" + (this.scope === "zone" ? "전체" : "구역") + ".csv";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      Prompt.toast && Prompt.toast("CSV 내보내기 완료");
    },

    /** [WO 20261023-pointlist] XLSX — 71_XlsxExport.download + 47_Report.COLUMNS/_rows 재사용. */
    _exportXlsx() {
      if (typeof Report === "undefined" || typeof XlsxExport === "undefined") { Prompt.toast && Prompt.toast("내보내기 모듈을 불러오지 못했습니다."); return; }
      const { pins, decks } = this._visibleRowsForExport();
      if (!pins.length) { Prompt.toast && Prompt.toast("내보낼 포인트가 없습니다."); return; }
      const role = (typeof Auth !== "undefined" && Auth.role) || "viewer";
      const rows = Report._rows(pins, [], decks, role);
      XlsxExport.download("seastar_points_" + (this.scope === "zone" ? "전체" : "구역"), "포인트 리스트", Report.COLUMNS, rows);
      Prompt.toast && Prompt.toast("XLSX 내보내기 완료");
    },

    /** 검색 결과(보이는 항목)만 선택에 추가 — 전체(숨은 항목)는 건드리지 않는다. */
    _selectAllVisible() {
      this._sorted().forEach((o) => this.selected.add(o.pin.id));
      this._renderSelectBar();
      this._renderActions();
      this.render();
    },
    _clearSelection() {
      this.selected.clear();
      this.render();
    },

    /** [WO 20261001-allpins] 선택 삭제 — 기존 일괄삭제 정본(App.deletePins: 확인→재인증→_removePins) 재사용. */
    async _onDelete() {
      if (!this._canDelete()) return;
      const ids = Array.from(this.selected);
      if (!ids.length) return;
      const n = await App.deletePins(ids, { scopeLabel: this._scopeLabel() });
      if (n) { this.selected.clear(); this.render(); }
    },

    /* ══ [WO 20261001-allpins] 번호 다시 매기기 시트 ══════════════════════════════
       대상 = 선택한 핀(없으면 현재 탭 전체). 순서 기준(목록순/위치순) → 시작번호 →
       미리보기(PinSeries.renumberSelection, 대역/중복 경고) → 적용(labelManual=true) →
       토스트 [되돌리기] 1회. 24b_NumBand.js 의 동적 시트 생성 패턴을 그대로 재사용한다. */
    _renumberTargets: null,
    _renumberResult: null,
    _renumberMyBand: null,

    _ensureRenumberSheet() {
      let m = document.getElementById("allpins-renumber-sheet");
      if (m) return m;
      m = document.createElement("div");
      m.id = "allpins-renumber-sheet";
      m.className = "numband-sheet hidden";
      m.innerHTML =
        '<div class="numband-backdrop" data-arn-close></div>' +
        '<div class="numband-panel" role="dialog" aria-modal="true" aria-labelledby="arn-title">' +
          '<div class="numband-head"><h3 id="arn-title" class="numband-title">번호 다시 매기기</h3>' +
          '<button type="button" class="numband-x" data-arn-close aria-label="닫기">&times;</button></div>' +
          '<p id="arn-sub" class="numband-sub"></p>' +
          '<div class="allpins-arn-row"><label for="arn-start" class="numband-adv-label">시작 번호</label>' +
            '<input id="arn-start" class="numband-start" type="number" min="1" step="1" inputmode="numeric" /></div>' +
          '<div class="allpins-arn-row" role="radiogroup" aria-label="순서 기준">' +
            '<label><input type="radio" name="arn-order" value="list" checked /> 현재 목록 순서</label>' +
            '<label><input type="radio" name="arn-order" value="pos" /> 도면 위치순(위→아래, 왼→오)</label>' +
          '</div>' +
          '<p id="arn-band-warn" class="numband-status hidden"></p>' +
          '<div id="arn-preview" class="allpins-arn-preview" aria-live="polite"></div>' +
          '<p id="arn-dup-warn" class="numband-status hidden"></p>' +
          '<div class="allpins-arn-actions"><button id="arn-cancel" type="button" class="numband-apply">취소</button>' +
          '<button id="arn-apply" type="button" class="numband-apply">적용</button></div>' +
        '</div>';
      document.body.appendChild(m);
      m.addEventListener("click", (e) => {
        if (e.target && e.target.closest && (e.target.closest("[data-arn-close]") || e.target.id === "arn-cancel")) this._closeRenumberSheet();
      });
      m.querySelector("#arn-start").addEventListener("input", () => this._updateRenumberPreview());
      m.querySelectorAll('input[name="arn-order"]').forEach((r) => r.addEventListener("change", () => this._updateRenumberPreview()));
      m.querySelector("#arn-apply").addEventListener("click", () => this._confirmRenumber());
      m.addEventListener("keydown", (e) => { if (e.key === "Escape") this._closeRenumberSheet(); });
      return m;
    },

    _closeRenumberSheet() {
      const m = document.getElementById("allpins-renumber-sheet");
      if (m) m.classList.add("hidden");
    },

    async _openRenumberSheet() {
      if (!this._canRenumber()) return;
      const selectedPins = this._modePins().filter((p) => this.selected.has(p.id));
      this._renumberTargets = selectedPins.length ? selectedPins : this._modePins();
      if (!this._renumberTargets.length) { Prompt.toast && Prompt.toast("대상 핀이 없습니다"); return; }
      const author = (typeof App !== "undefined" && App._pinAuthor) ? App._pinAuthor() : null;
      const myBand = (typeof App !== "undefined" && App._numBand) ? App._numBand() : (PinSeries.myBand(author) || 1);
      this._renumberMyBand = myBand;
      const m = this._ensureRenumberSheet();
      m.querySelector("#arn-sub").textContent = this._scopeLabel() + " " + this._renumberTargets.length + "개 — 새 시작 번호를 입력하세요";
      m.querySelector("#arn-start").value = String(PinSeries.bandRange(myBand).lo);
      m.querySelectorAll('input[name="arn-order"]').forEach((r) => { r.checked = r.value === "list"; });
      m.classList.remove("hidden");
      this._updateRenumberPreview();
      const first = m.querySelector("#arn-start");
      if (first && first.focus) first.focus();
    },

    /** 목록순(현재 정렬) 또는 도면 위치순(페이지→y→x)으로 대상을 정렬. */
    _orderTargets(targets, order) {
      const arr = (targets || []).slice();
      if (order === "pos") {
        arr.sort((a, b) => PinSeries.byPosition(a, b));   // [WO 20261015-numunify] 위치순 SoT(번호 리셋과 같은 규칙)
        return arr;
      }
      const pos = new Map(this._sortedAll().map((o, i) => [o.pin.id, i]));
      arr.sort((a, b) => (pos.has(a.id) ? pos.get(a.id) : 1e9) - (pos.has(b.id) ? pos.get(b.id) : 1e9));
      return arr;
    },

    _updateRenumberPreview() {
      const m = document.getElementById("allpins-renumber-sheet");
      if (!m) return;
      const ser = this._currentSeries();
      const startVal = parseInt(m.querySelector("#arn-start").value, 10);
      const orderInput = m.querySelector('input[name="arn-order"]:checked');
      const order = orderInput ? orderInput.value : "list";
      const ordered = this._orderTargets(this._renumberTargets, order);
      const result = PinSeries.renumberSelection(State.pins, ordered, startVal, ser);
      this._renumberResult = result;
      const prev = document.getElementById("arn-preview");
      const bandWarn = document.getElementById("arn-band-warn");
      const dupWarn = document.getElementById("arn-dup-warn");
      const applyBtn = document.getElementById("arn-apply");
      if (!result.ok) {
        if (prev) prev.innerHTML = "";
        if (bandWarn) bandWarn.classList.add("hidden");
        if (dupWarn) { dupWarn.classList.remove("hidden"); dupWarn.textContent = result.reason || "번호를 확인하세요"; }
        if (applyBtn) applyBtn.disabled = true;
        return;
      }
      if (applyBtn) applyBtn.disabled = false;
      if (prev) {
        const head = result.changes.slice(0, 6).map((c) =>
          '<span class="allpins-arn-pair' + (result.duplicateIds.has(c.id) ? " is-dup" : "") + '">' +
          UI.escapeHtml(c.oldLabel == null || c.oldLabel === "" ? "(없음)" : String(c.oldLabel)) + ' → ' +
          UI.escapeHtml(PinSeries.formatNo(c.newLabel, ser)) + '</span>'
        ).join("");
        const more = result.changes.length > 6 ? '<span class="allpins-arn-more">외 ' + (result.changes.length - 6) + '개</span>' : "";
        prev.innerHTML = head + more;
      }
      if (bandWarn) {
        const outOfBand = this._renumberMyBand && Number.isFinite(startVal) && PinSeries.bandOf(startVal) !== this._renumberMyBand;
        bandWarn.classList.toggle("hidden", !outOfBand);
        if (outOfBand) bandWarn.textContent = "⚠ 내 번호 대역(" + PinSeries.bandLabel(this._renumberMyBand) + ") 밖입니다 — 적용하면 다른 대역에 번호가 매겨집니다";
      }
      if (dupWarn) {
        dupWarn.classList.toggle("hidden", !result.duplicateIds.size);
        if (result.duplicateIds.size) dupWarn.textContent = "⚠ " + result.duplicateIds.size + "개 번호가 기존 다른 핀과 겹칩니다 — 적용하면 중복으로 표시됩니다";
      }
    },

    async _confirmRenumber() {
      const result = this._renumberResult;
      if (!result || !result.ok || !result.changes.length) return;
      const m = document.getElementById("allpins-renumber-sheet");
      const startVal = parseInt(m.querySelector("#arn-start").value, 10);
      const outOfBand = this._renumberMyBand && Number.isFinite(startVal) && PinSeries.bandOf(startVal) !== this._renumberMyBand;
      if (outOfBand) {
        const ok = await Prompt.confirm("번호 대역 밖", "내 대역(" + PinSeries.bandLabel(this._renumberMyBand) + ") 밖의 번호입니다 — 계속할까요?");
        if (!ok) return;
      }
      if (result.duplicateIds.size) {
        const ok = await Prompt.confirm("번호 중복 경고", result.duplicateIds.size + "개 번호가 기존 핀과 겹칩니다 — 그래도 적용할까요?");
        if (!ok) return;
      }
      const byId = new Map((State.pins || []).map((p) => [p.id, p]));
      const snapshot = [];
      result.changes.forEach((c) => {
        const pin = byId.get(c.id);
        if (!pin) return;
        snapshot.push({ id: pin.id, label: pin.label, labelManual: !!pin.labelManual });
        // [WO 20261016-multisheet P3] label 쓰기 = PinLink.setLabel(연결 묶음 전원) — 수동 번호(동시 생성 재채번 대상 아님)
        if (typeof PinLink !== "undefined" && PinLink.setLabel) PinLink.setLabel(State.pins, pin, c.newLabel, { manual: true });
        else {   // PinLink 미로드(단독 테스트) — 종전 그대로
        pin.label = c.newLabel;
        pin.labelManual = true;   // [WO 20260930-numdup] 수동 번호 — 동시 생성 재채번 대상 아님
        }
        if (typeof Log !== "undefined") Log.push("pin.renumber", pin.id, { oldLabel: c.oldLabel, newLabel: c.newLabel, page: pin.page || 1 });
        if (!navigator.onLine && typeof OpLog !== "undefined" && OpLog.recordCurrent) { try { OpLog.recordCurrent("pin", "upsert", pin.id, pin); } catch (e) {} }
      });
      App._markDirty && App._markDirty();
      App._autoSave && App._autoSave();
      if (typeof UI !== "undefined") { UI.renderPinsOnMap && UI.renderPinsOnMap(); UI.renderPinList && UI.renderPinList(); }
      this._closeRenumberSheet();
      this.selected.clear();
      this.render();
      Prompt.toast && Prompt.toast(result.changes.length + "개 번호 변경됨", 4000, { action: { label: "되돌리기", onClick: () => this._undoRenumber(snapshot) } });
    },

    _undoRenumber(snapshot) {
      const byId = new Map((State.pins || []).map((p) => [p.id, p]));
      (snapshot || []).forEach((s) => {
        const pin = byId.get(s.id);
        if (!pin) return;
        if (typeof PinLink !== "undefined" && PinLink.setLabel) PinLink.setLabel(State.pins, pin, s.label);   // [WO 20261016-multisheet] 연결 묶음 전원
        else pin.label = s.label;
        pin.labelManual = s.labelManual;
      });
      App._markDirty && App._markDirty();
      App._autoSave && App._autoSave();
      if (typeof UI !== "undefined") { UI.renderPinsOnMap && UI.renderPinsOnMap(); UI.renderPinList && UI.renderPinList(); }
      this.render();
      Prompt.toast && Prompt.toast("되돌렸습니다");
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
     · 슈퍼관리자(서버 SUPER_ADMIN_EMAIL · role=super) = 디자이너 지정 + 모든 권한
  ══════════════════════════════════════════ */