  /* ══════════════════════════════════════════════════════════════
     Report — 점검 보고서 내보내기 (WO 20261002-gap ★1, 지휘자 발주 2026-10-02)
     마스터 결정: "인쇄 PDF + CSV".
     - CSV: 19_PinGrid.exportCsv() 를 일반화(열 14개, 범위=페이지/구역/프로젝트).
     - 인쇄: window.open() + @media print 인라인 — 새 라이브러리 0개(한글 폰트 임베딩 회피,
       사용자가 브라우저 "PDF로 저장"으로 완성).
     🔴 Report._rows(pins, notes, decks, role) 는 순수 함수(테스트 대상) — DOM·fetch 없음.
       decks 항목 모양: { id, name, page, zones: [{ label, pinIds[] }] }
       - page 스코프/구역(деck) 스코프: decks=[{ name:<현재 구역명>, page:<해당 페이지 또는 null=전체>, zones:State.zones }]
       - 프로젝트 스코프: 구역(deck)마다 하나씩, pin.deckId 로 매칭(캐셔가 병합 시 태그, 저장 안 함).
     "구역"(코드상 deck, Projects.decks) → "영역"(코드상 zone, State.zones) 네이밍은 31_Projects.js/16_Zones.js
     의 기존 사용자 문구(구역 생성=deck, zone-box-del title="영역 삭제")를 그대로 따른다. ══════════════════════════════════════════════════════════════ */
  const Report = {
    COLUMNS: ["구역", "영역", "모드", "번호", "라벨", "촬영시각", "시각출처", "사진명", "첨부수", "노트수", "미해결수", "작성자", "X%", "Y%"],
    ACC_WARN_M: 50, // (GPS 모듈과 같은 의미의 상수를 여기선 쓰지 않음 — 참조용 주석만)

    _blank(v) { return (v == null || v === "") ? "" : v; },

    /** UTC 고정 포맷(로케일/타임존 환경에 흔들리지 않는 순수 함수) "YYYY-MM-DD HH:MM:SS" */
    _fmtTs(ts) {
      if (!Number.isFinite(ts)) return "";
      try { return new Date(ts).toISOString().replace("T", " ").slice(0, 19); } catch (e) { return ""; }
    },

    /** pin이 속한 구역(deck) 탐색 — deckId 우선, 없으면 페이지 일치, 없으면 전체 와일드카드(page==null) 구역. */
    _deckOf(pin, decks) {
      if (!Array.isArray(decks) || !decks.length || !pin) return null;
      if (pin.deckId != null) {
        const byId = decks.find((d) => d && d.id === pin.deckId);
        if (byId) return byId;
      }
      const page = pin.page || 1;
      const exact = decks.find((d) => d && d.page != null && d.page === page);
      if (exact) return exact;
      return decks.find((d) => d && d.page == null) || null;
    },

    /** 구역 안에서 이 pin을 포함하는 영역(zone) — pinIds 포함 여부로 판정(기존 Zones._commitZone SoT 재사용 규칙과 동일). */
    _zoneOf(pin, deck) {
      if (!deck || !Array.isArray(deck.zones) || !pin) return null;
      return deck.zones.find((z) => z && Array.isArray(z.pinIds) && z.pinIds.indexOf(pin.id) !== -1) || null;
    },

    _notesOf(pin, notes) {
      if (!pin) return [];
      return (notes || []).filter((n) => n && n.pin_id === pin.id);
    },

    /** 순수 함수 — pins/notes/decks 로 14열 행 배열(각 행 = 14개 값 배열)을 만든다.
     *  값이 없으면 "" (지어내지 않음). role==='viewer' 면 작성자 열을 비운다. */
    _rows(pins, notes, decks, role) {
      const list = Array.isArray(pins) ? pins : [];
      return list.map((pin, i) => {
        const deck = this._deckOf(pin, decks);
        const zone = this._zoneOf(pin, deck);
        const pinNotes = this._notesOf(pin, notes);
        const unresolved = pinNotes.filter((n) => n && n.status !== "done").length;
        const isChecker = !!pin.checkboard;
        let author = "";
        if (role !== "viewer") {
          author = this._blank(pin.author) || this._blank(pinNotes[0] && (pinNotes[0].author || pinNotes[0].author_email));
        }
        return [
          this._blank(deck && deck.name),
          this._blank(zone && zone.label),
          isChecker ? "CHECKER" : "360",
          pin && pin._no != null ? pin._no : (i + 1),
          this._blank(pin && pin.label),
          this._fmtTs(pin && pin.shotAt),
          this._blank(pin && pin.shotSrc),
          this._blank(pin && (pin.imageName || pin.origName)),
          (pin && pin.attachments && pin.attachments.length) || 0,
          pinNotes.length,
          unresolved,
          author,
          (pin && pin.x != null) ? Number(pin.x).toFixed(2) : "",
          (pin && pin.y != null) ? Number(pin.y).toFixed(2) : ""
        ];
      });
    },

    _csvEsc(v) {
      const s = String(v == null ? "" : v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    },

    /** 행 배열 → CSV 문자열(UTF-8 BOM 포함 — 엑셀 한글 깨짐 방지) */
    _toCsv(rows) {
      const lines = [this.COLUMNS.map((c) => this._csvEsc(c)).join(",")];
      rows.forEach((r) => lines.push(r.map((v) => this._csvEsc(v)).join(",")));
      return "﻿" + lines.join("\n");
    },

    /* ────────────────────────────────────────────────────────────
       아래부터 비순수(DOM·fetch 의존) — 테스트는 위 순수 함수만 대상.
    ──────────────────────────────────────────────────────────── */

    /** 현재 로드된 구역(deck) 하나의 zones 를 Report 용 decks 엔트리로 변환. page=null → 전체 페이지 와일드카드. */
    _localDeckEntry(pageOnly) {
      const name = (typeof Projects !== "undefined" && Projects.currentDeck && Projects.currentDeck.name) || "";
      const zones = (typeof State !== "undefined" && Array.isArray(State.zones)) ? State.zones : [];
      return { id: (typeof Projects !== "undefined" && Projects.currentDeck && Projects.currentDeck.id) || null, name, page: pageOnly || null, zones };
    },

    async _fetchNotes(depId) {
      if (!depId) return [];
      try {
        const r = await fetch("/api/notes?deployment_id=" + encodeURIComponent(depId), { headers: Auth.headers() });
        const j = await r.json();
        return (j && j.data) || [];
      } catch (e) { return []; }
    },

    /** 프로젝트 전체 구역을 서버에서 받아 pins/notes/decks 를 병합(프로젝트 스코프 전용, 네트워크 필요). */
    async _gatherProjectScope() {
      const decks = (typeof Projects !== "undefined" && Array.isArray(Projects.decks)) ? Projects.decks : [];
      const allPins = [], allNotes = [], deckEntries = [];
      for (const d of decks) {
        if (!d || !d.deployment_id) continue;
        let dep = null;
        try {
          const r = await fetch("/tables/deployments/" + encodeURIComponent(d.deployment_id), { headers: Auth.headers() });
          if (r.ok) dep = await r.json();
        } catch (e) { dep = null; }
        if (!dep) continue;
        let pins = [], zones = [];
        try { pins = JSON.parse(dep.pins || "[]") || []; } catch (e) { pins = []; }
        try { zones = JSON.parse(dep.zones || "[]") || []; } catch (e) { zones = []; }
        pins.forEach((p) => { p.deckId = d.id; });
        allPins.push(...pins);
        const notes = await this._fetchNotes(d.deployment_id);
        allNotes.push(...notes);
        deckEntries.push({ id: d.id, name: d.name || "", page: null, zones });
      }
      return { pins: allPins, notes: allNotes, decks: deckEntries };
    },

    /** scope: 'page' | 'deck' | 'project'. 반환: { pins, notes, decks, role } (비동기, 네트워크 가능) */
    async _gather(scope) {
      const role = (typeof Auth !== "undefined" && Auth.role) || "viewer";
      if (scope === "project") {
        const g = await this._gatherProjectScope();
        return Object.assign(g, { role });
      }
      const allPins = (typeof State !== "undefined" && Array.isArray(State.pins)) ? State.pins : [];
      const curPage = (typeof State !== "undefined" && State.pdfPage) || 1;
      const pins = (scope === "page") ? allPins.filter((p) => (p.page || 1) === curPage) : allPins.slice();
      const notes = await this._fetchNotes(typeof State !== "undefined" ? State.autoSaveDepId : null);
      const decks = [this._localDeckEntry(scope === "page" ? curPage : null)];
      return { pins, notes, decks, role };
    },

    async csv(scope) {
      scope = scope || "page";
      const { pins, notes, decks, role } = await this._gather(scope);
      if (!pins.length) { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("내보낼 포인트가 없습니다."); return; }
      const rows = this._rows(pins, notes, decks, role);
      const csvStr = this._toCsv(rows);
      const blob = new Blob([csvStr], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const scopeTag = scope === "project" ? "전체" : (scope === "deck" ? "구역" : ("P" + ((typeof State !== "undefined" && State.pdfPage) || 1)));
      a.download = "seastar_report_" + scopeTag + ".csv";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("CSV 보고서 내보내기 완료");
    },

    _esc(s) { return (typeof UI !== "undefined" && UI.escapeHtml) ? UI.escapeHtml(s) : String(s == null ? "" : s); },

    /** 인쇄용 HTML 문서 전체(새 창에 그대로 씀) — 사진은 Auth.r2()를 거쳐 <img>. */
    _printHtml(rows, pins, title) {
      const esc = this._esc.bind(this);
      const theadCells = this.COLUMNS.map((c) => "<th>" + esc(c) + "</th>").join("");
      const bodyRows = rows.map((r, i) => {
        const pin = pins[i];
        const photoUrl = (pin && pin.imageId) ? ((typeof Auth !== "undefined" && Auth.r2) ? Auth.r2(pin.imageId) : pin.imageId) : null;
        const photoCell = photoUrl ? '<img class="rpt-thumb" src="' + esc(photoUrl) + '" />' : "";
        return "<tr><td>" + r.map((v) => esc(v)).join("</td><td>") + "</td><td>" + photoCell + "</td></tr>";
      }).join("");
      return "<!doctype html><html><head><meta charset=\"utf-8\"><title>" + esc(title) + "</title><style>" +
        "body{font-family:'Malgun Gothic',sans-serif;font-size:12px;color:#111;padding:16px}" +
        "h1{font-size:16px;margin:0 0 8px}" +
        "table{width:100%;border-collapse:collapse}" +
        "th,td{border:1px solid #999;padding:4px 6px;text-align:left;vertical-align:top;word-break:break-all}" +
        "th{background:#eee}" +
        ".rpt-thumb{width:120px;max-height:90px;object-fit:cover}" +
        "@media print{@page{size:A4 landscape;margin:10mm} body{padding:0}}" +
        "</style></head><body>" +
        "<h1>" + esc(title) + "</h1>" +
        "<table><thead><tr>" + theadCells + "<th>사진</th></tr></thead><tbody>" + bodyRows + "</tbody></table>" +
        "</body></html>";
    },

    async print(scope) {
      scope = scope || "page";
      const { pins, notes, decks, role } = await this._gather(scope);
      if (!pins.length) { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("내보낼 포인트가 없습니다."); return; }
      const rows = this._rows(pins, notes, decks, role);
      const title = "SEASTAR 점검 보고서 — " + new Date().toISOString().slice(0, 10);
      const html = this._printHtml(rows, pins, title);
      const w = window.open("", "_blank");
      if (!w) { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("팝업이 차단되었습니다 — 팝업 허용 후 다시 시도하세요."); return; }
      w.document.open(); w.document.write(html); w.document.close();
    },

    /** 진입점 버튼 주입 — public/index.html(타 팀 점유)을 건드리지 않고, 이미 있는
     *  #pin-grid-csv(엑셀 CSV 버튼) 옆에 범위 선택 + 인쇄 버튼을 런타임에 추가한다. */
    init() {
      const csvBtn = document.getElementById("pin-grid-csv");
      if (!csvBtn || document.getElementById("rpt-scope")) return;
      const sel = document.createElement("select");
      sel.id = "rpt-scope";
      sel.title = "보고서 범위";
      sel.style.cssText = "margin:0 4px;font-size:11px;";
      [["page", "현재 페이지"], ["deck", "구역 전체"], ["project", "프로젝트 전체"]].forEach(([v, label]) => {
        const op = document.createElement("option"); op.value = v; op.textContent = label; sel.appendChild(op);
      });
      const printBtn = document.createElement("button");
      printBtn.id = "rpt-print-btn";
      printBtn.type = "button";
      printBtn.className = csvBtn.className;
      printBtn.title = "인쇄 보고서";
      printBtn.setAttribute("aria-label", "인쇄 보고서");
      printBtn.innerHTML = '<i class="fa-solid fa-print"></i>';
      csvBtn.insertAdjacentElement("afterend", sel);
      sel.insertAdjacentElement("afterend", printBtn);
      printBtn.addEventListener("click", () => this.print(sel.value));
      // 🔴 csvBtn 자체 클릭 바인딩은 19_PinGrid.init()이 이미 가지고 있다(SoT 1곳) —
      //   여기서 또 bind 하면 클릭 1번에 CSV 2개가 나온다. PinGrid.exportCsv()가
      //   이 select(#rpt-scope)의 값을 읽어 Report.csv(scope)로 위임한다.
    },

    /** PinGrid.exportCsv()가 읽는 현재 선택된 CSV 범위(주입 전이면 "page" 기본값). */
    currentScope() {
      const sel = document.getElementById("rpt-scope");
      return (sel && sel.value) || "page";
    }
  };
