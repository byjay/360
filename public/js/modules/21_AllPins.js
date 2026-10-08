  const AllPins = {
    open: false,
    sort: "page",     // 'page' | 'name'
    query: "",
    tab: null,         // [WO 20261001-allpins] 'checkboard' | 'content' — 선택된 모드 탭(기본 = 활성 모드)
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
      // [WO 20261001-allpins] 모드 탭(CHECKER/360) — 탭 = 모드 전환(App._setRegMode SoT 재사용)
      const tabsHost = $("allpins-tabs");
      if (tabsHost) tabsHost.addEventListener("click", (e) => {
        const b = e.target && e.target.closest ? e.target.closest("[data-series]") : null;
        if (b) this._switchTab(b.dataset.series);
      });
      const bandBtn = $("allpins-band-btn");
      if (bandBtn) bandBtn.addEventListener("click", () => { if (typeof NumBand !== "undefined" && NumBand.open) NumBand.open(bandBtn); });
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

    /** 현재 패널이 보여줄 계열 — 탭이 있으면 탭 우선, 없으면 활성 모드(PinSeries.activeSeries), 기본 checkboard. */
    _currentSeries() {
      if (this.tab === "checkboard" || this.tab === "content") return this.tab;
      const act = (typeof PinSeries !== "undefined" && PinSeries.activeSeries) ? PinSeries.activeSeries() : null;
      return act || "checkboard";
    },

    /** [WO 20261001-allpins] 모드 탭 클릭 — 탭 = 모드 전환(SoT: App._setRegMode). 디자이너 화면이
     *  아니면(뷰어 등 regMode 개념 없음) 전역 모드는 바꾸지 않고 패널 안 필터만 바꾼다. */
    _switchTab(ser) {
      if (ser !== "checkboard" && ser !== "content") return;
      if (ser === this._currentSeries()) return;
      this.tab = ser;
      this.selected.clear();
      if (typeof State !== "undefined" && State.mode === "designer" && typeof App !== "undefined" && App._setRegMode) {
        App._setRegMode(ser === "checkboard" ? "checkboard" : "photo");
      }
      this.render();
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
      // [WO 20261001-allpins] 열 때마다 "기본은 현재 활성 모드"로 맞춘다(지휘자 확정).
      this.tab = (typeof PinSeries !== "undefined" && PinSeries.activeSeries && PinSeries.activeSeries()) || this.tab || "checkboard";
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
      return (typeof Projects !== "undefined" && Projects.pinsForDeck) ? Projects.pinsForDeck(all, deck) : all;
    },

    /** [WO 20261001-allpins] 현재 탭(계열)의 핀만 — 페이지 구분 없이 전체(탭 = 작업공간). */
    _modePins() {
      const ser = this._currentSeries();
      return this._scopedPins().filter((p) => p && (typeof PinSeries === "undefined" || PinSeries.seriesOf(p) === ser));
    },

    /** 검색 필터 적용 전, 현재 정렬 기준(this.sort) 그대로 둔 전체 목록 — 재채번 "목록 순서" 기준이
     *  검색 중에도 흔들리지 않도록 _sorted()(검색 필터 포함)와 분리했다. */
    _sortedAll() {
      const arr = this._modePins().map((p, i) => ({ pin: p, idx: i }));
      if (this.sort === "name") {
        arr.sort((a, b) => (a.pin.label || "").localeCompare(b.pin.label || "", "ko"));
      } else {
        arr.sort((a, b) => ((a.pin.page || 1) - (b.pin.page || 1)) || (a.idx - b.idx));
      }
      return arr;
    },

    _sorted() {
      // [WO 20260930-fixmode] 모드 = 작업공간 — 활성 탭 핀만(SoT: _currentSeries)
      const all = this._sortedAll();
      if (!this.query) return all;
      return all.filter((o) => (o.pin.label || "").toLowerCase().includes(this.query));
    },

    /** [WO 20261001-allpins] 핀의 페이지별 표시 번호(PinSeries.numbers/formatNo 정본) — render() 1회마다 캐시. */
    _numFor(pin) {
      const pg = (pin && pin.page) || 1;
      if (!this._numMaps[pg]) this._numMaps[pg] = PinSeries.numbers(State.pins, pg);
      return this._numMaps[pg].get(pin.id);
    },

    /** [WO 20261001-allpins] 모드 탭 [CHECKER N][360 N] 렌더. */
    _renderTabs() {
      const host = document.getElementById("allpins-tabs");
      if (!host || typeof PinSeries === "undefined") return;
      const cur = this._currentSeries();
      const counts = { checkboard: 0, content: 0 };
      this._scopedPins().forEach((p) => { if (p) counts[PinSeries.seriesOf(p)]++; });
      host.innerHTML = PinSeries.SERIES.map((ser) => {
        const active = ser === cur;
        return '<button type="button" class="allpins-tab allpins-tab-' + ser + (active ? " active" : "") +
          '" data-series="' + ser + '" role="tab" aria-selected="' + (active ? "true" : "false") + '">' +
          PinSeries.LABELS[ser] + ' <span class="allpins-tab-cnt">' + counts[ser] + '</span></button>';
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
      btn.textContent = "대역 " + PinSeries.bandLabel(band) + (nx.full ? " · 가득" : " · 다음 " + PinSeries.formatNo(nx.no, ser));
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
      const ser = this._currentSeries();
      // 탭 전환 등으로 현재 목록 밖에 남은 선택은 정리(교차 탭 유령 선택 방지)
      const inTab = new Set(this._modePins().map((p) => p.id));
      Array.from(this.selected).forEach((id) => { if (!inTab.has(id)) this.selected.delete(id); });
      if (countEl) countEl.textContent = this._modePins().length;
      // [WO 20261007-qrcov] 촬영 현황 요약 한 줄(켜졌을 때만) — 이 구역 범위(_scopedPins = Projects.pinsForDeck SoT)
      if (typeof Coverage !== "undefined" && Coverage.renderAllPinsSummary) { try { Coverage.renderAllPinsSummary(this._scopedPins()); } catch (e) {} }
      const rows = this._sorted();
      listEl.innerHTML = "";
      if (!rows.length) { emptyEl.classList.remove("hidden"); return; }
      emptyEl.classList.add("hidden");

      const totalPages = State.mode === "viewer"
        ? (State.viewerPages ? State.viewerPages.length : 1) : State.pdfPages;
      const canSelect = this._canSelect();

      rows.forEach(({ pin, idx }) => {
        const badge = this._kindBadge(pin);
        const hasMedia = App.pinHasContent(pin);
        const pageTag = totalPages > 1 ? `P${pin.page || 1}` : "";
        const info = this._numFor(pin);
        const noText = info ? PinSeries.formatNo(info.no, info.series) : String(idx + 1);
        const isSel = this.selected.has(pin.id);
        const row = document.createElement("div");
        row.className = "allpins-item allpins-mode-" + ser + (State.activePin === pin.id ? " active" : "") + (isSel ? " selected" : "");
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
              ${pageTag ? `<span class="allpins-page">${pageTag}</span>` : ""}
            </span>
          </span>
          <span class="allpins-go" title="이동 + 보기">
            ${hasMedia
              ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/></svg>'
              : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>'}
          </span>`;
        row.addEventListener("click", (e) => {
          if (e.target && e.target.closest && e.target.closest(".allpins-sel-wrap")) return;
          this._goto(pin);
        });
        row.addEventListener("keydown", (e) => { if (e.key === "Enter") this._goto(pin); });
        listEl.appendChild(row);

        // 360° 그림 썸네일 비동기 로드 (캐시)
        if (pin.imageId) this._loadThumb(row.querySelector(".allpins-thumb"), pin.imageId);
      });
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
      const ser = this._currentSeries();
      const n = await App.deletePins(ids, { scopeLabel: PinSeries.LABELS[ser] });
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
      const ser = this._currentSeries();
      const selectedPins = this._modePins().filter((p) => this.selected.has(p.id));
      this._renumberTargets = selectedPins.length ? selectedPins : this._modePins();
      if (!this._renumberTargets.length) { Prompt.toast && Prompt.toast("대상 핀이 없습니다"); return; }
      const author = (typeof App !== "undefined" && App._pinAuthor) ? App._pinAuthor() : null;
      const myBand = (typeof App !== "undefined" && App._numBand) ? App._numBand() : (PinSeries.myBand(author) || 1);
      this._renumberMyBand = myBand;
      const m = this._ensureRenumberSheet();
      m.querySelector("#arn-sub").textContent = PinSeries.LABELS[ser] + " " + this._renumberTargets.length + "개 — 새 시작 번호를 입력하세요";
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
        arr.sort((a, b) => ((a.page || 1) - (b.page || 1)) || ((a.y || 0) - (b.y || 0)) || ((a.x || 0) - (b.x || 0)));
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
        pin.label = c.newLabel;
        pin.labelManual = true;   // [WO 20260930-numdup] 수동 번호 — 동시 생성 재채번 대상 아님
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
        pin.label = s.label;
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
     · 슈퍼관리자(designssir@gmail.com) = 디자이너 지정 + 모든 권한
  ══════════════════════════════════════════ */