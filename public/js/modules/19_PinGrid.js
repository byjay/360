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
      // [WO 20261002-gap ★1] 보고서 범위 선택 + 인쇄 버튼을 CSV 버튼 옆에 런타임 주입(index.html 미수정).
      if (typeof Report !== "undefined" && Report.init) Report.init();
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
      // [WO 20260930-fixmode] 모드 = 작업공간 — 활성 모드 핀만(SoT: PinSeries.modePins)
      const all = (typeof PinSeries !== "undefined" && PinSeries.modePins) ? PinSeries.modePins(State.pins) : State.pins.slice();
      const base = isMulti ? all.filter(p => (p.page || 1) === curPage) : all;
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

    /** [WO 20261002-gap ★1] 6열/현재페이지뿐이던 내보내기를 Report(14열, 범위선택)로 위임.
     *  Report 모듈이 없으면(구버전 번들) 예전 6열 CSV로 폴백 — 조용한 실패 금지. */
    exportCsv() {
      if (typeof Report !== "undefined" && Report.csv) {
        Report.csv(Report.currentScope ? Report.currentScope() : "page");
        return;
      }
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