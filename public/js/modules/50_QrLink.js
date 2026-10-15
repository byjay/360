  /* ══════════════════════════════════════════════════════════════
     QR LINK — QR 위치 태그(딥링크 + QR 인쇄) (WO 20261007-qrcov 요구 A, 경쟁조사 후보 4 · OpenSpace QuickCodes)
     ────────────────────────────────────────────────────────────────
     딥링크 = <origin>/?qp=<프로젝트ID>&qk=<구역ID>&qpin=<핀ID>   (qk·qpin 생략 가능)
       파라미터 이름은 기존 d(열람 링크)·akey·shared·invite·mode·demo360 과 겹치지 않게 q 접두.
     🔴 권한 게이트 = 기존 그대로(새 우회로 0):
       · d(열람 링크)·공유 토큰(/srview)·초대(invite)가 같이 있으면 딥링크는 무시한다 — 그 경로의 게이트가 정본.
         Auth._isViewLink() 는 qp 를 보지 않으므로 딥링크만으로는 열람 자동입장(_autoDesignerEntry)이 일어나지 않는다.
       · 비로그인 → Auth.init 이 띄운 로그인 게이트. 로그인하면 Auth.refresh() 단일 지점이 resumePending() 을 불러
         원래 딥링크로 복귀한다(Invite.resumePending 과 같은 패턴).
       · 목록에 없는 프로젝트 = 권한 없음/삭제 → 사유 안내. 비멤버(is_member=false, 잠금 카드) → 기존 접근 신청 창.
       · 진입 = 기존 ProjectHub.openProjectAtDeck(→ openProject → _enterAsDesigner → Auth.requireDesigner) 그대로.
       · 서버 API(401/403)가 최종 판정 — 이 모듈은 아무 토큰도 만들지 않는다.
     오프라인 = ProjectHub.load / Projects.loadDecks / App.loadDeckDrawing 의 기존 번들 폴백을 그대로 탄다.
     QR 생성 = public/js/vendor/qrcode.js (qrcode-generator 1.5.2, MIT, 무수정 사본) — 필요할 때만 지연 로드.
     인쇄 = 47_Report 의 인쇄 창 방식(Report.openPrintWindow/writePrint) 재사용. 앱 안 스캐너 없음(YAGNI — 폰 기본 카메라).
  ══════════════════════════════════════════════════════════════ */
  const DeepLink = {
    PARAMS: { project: "qp", deck: "qk", pin: "qpin" },
    /** 🔴 함께 오면 딥링크를 무시하는 파라미터 — 각자 자기 게이트가 있다(열람 링크·초대·공유 수신) */
    YIELD_TO: ["d", "invite", "shared", "akey"],
    ID_RE: /^[A-Za-z0-9_.:\-]{1,120}$/,
    PENDING_KEY: "wm_pending_deeplink",
    PENDING_TTL_MS: 30 * 60 * 1000,
    PIN_WAIT_MS: 8000,     // 구역 도면 로드 후 핀이 State.pins 에 들어올 때까지 기다리는 상한
    _pending: null,
    _running: false,

    /** 순수 함수 — 쿼리 문자열 → {project, deck, pin} 또는 null(딥링크 아님/무효/다른 게이트 우선). */
    parse(search) {
      let q;
      try { q = new URLSearchParams(search || ""); } catch (e) { return null; }
      for (const k of this.YIELD_TO) { if (q.get(k)) return null; }
      const P = this.PARAMS;
      const project = q.get(P.project);
      if (!project || !this.ID_RE.test(project)) return null;
      const deck = q.get(P.deck) || null;
      const pin = q.get(P.pin) || null;
      if (deck && !this.ID_RE.test(deck)) return null;
      if (pin && !this.ID_RE.test(pin)) return null;
      return { project, deck, pin };
    },

    /** 순수 함수 — 딥링크 URL. origin 은 호출부가 준다(하드코딩 금지: 지금 접속한 주소 = location.origin). */
    build(origin, link) {
      if (!link || !link.project) return null;
      const P = this.PARAMS;
      const q = new URLSearchParams();
      q.set(P.project, String(link.project));
      if (link.deck) q.set(P.deck, String(link.deck));
      if (link.pin) q.set(P.pin, String(link.pin));
      return String(origin || "").replace(/\/+$/, "") + "/?" + q.toString();
    },
    urlFor(link) {
      const origin = (typeof location !== "undefined" && location.origin) ? location.origin : "";
      return this.build(origin, link);
    },

    /** 순수 함수 — 서버가 준 프로젝트 목록(/api/projects, 멤버십 판정 포함)으로 진입 가부 판정.
     *  missing = 목록에 없음(권한 없음·삭제) / locked = 비멤버 잠금 카드 / ok. */
    resolve(list, link) {
      const p = (list || []).find((x) => x && String(x.id) === String(link && link.project));
      if (!p) return { kind: "missing", project: null };
      if (p.is_member === false) return { kind: "locked", project: p };
      return { kind: "ok", project: p };
    },

    _save(link) {
      this._pending = { link, ts: Date.now() };
      try { sessionStorage.setItem(this.PENDING_KEY, JSON.stringify(this._pending)); } catch (e) {}
    },
    _take() {
      let rec = this._pending;
      if (!rec) { try { rec = JSON.parse(sessionStorage.getItem(this.PENDING_KEY) || "null"); } catch (e) { rec = null; } }
      return rec && rec.link && (Date.now() - (rec.ts || 0)) <= this.PENDING_TTL_MS ? rec.link : null;
    },
    _clearPending() {
      this._pending = null;
      try { sessionStorage.removeItem(this.PENDING_KEY); } catch (e) {}
    },
    /** 주소창에서 딥링크 파라미터만 지운다 — 열 수 없는 경우(missing·locked)에만. 다른 파라미터는 보존.
     *  🔴 성공 시에는 지우지 않는다: 첫 방문·배포 직후엔 SW 가 제어권을 잡으며 페이지를 1회 새로고침한다
     *  (index.html controllerchange → reload, CDP 실측). 그때 주소가 비어 있으면 QR 로 연 핀 대신 허브로 떨어진다.
     *  주소 = 지금 보는 위치(일반 딥링크 의미)라 새로고침해도 같은 핀으로 돌아온다. */
    _cleanUrl() {
      try {
        const u = new URL(location.href);
        let changed = false;
        Object.values(this.PARAMS).forEach((k) => { if (u.searchParams.has(k)) { u.searchParams.delete(k); changed = true; } });
        if (changed) history.replaceState(history.state, "", u.pathname + (u.searchParams.toString() ? "?" + u.searchParams.toString() : "") + u.hash);
      } catch (e) {}
    },
    _toast(msg, ms) { try { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast(msg, ms || 3600); } catch (e) {} },
    _loggedIn() { return typeof Auth !== "undefined" && !!(Auth.user || (Auth._hasLocalToken && Auth._hasLocalToken())); },

    /** 99_footer 진입 분기(열람 링크·공유 링크가 아닐 때만 호출됨). 딥링크가 아니면 false — 호출부가 기존 허브로 간다. */
    async boot() {
      const link = this.parse(typeof location !== "undefined" ? location.search : "");
      if (!link) return false;
      if (typeof ShareLink !== "undefined" && ShareLink.token && ShareLink.token()) return false;   // 공유 링크 게이트 우선
      this._save(link);
      if (typeof ProjectHub !== "undefined") await ProjectHub.open();
      if (this._loggedIn()) await this.resumePending();
      else this._toast("로그인하면 QR 의 위치로 바로 이동합니다", 4200);   // 로그인 게이트는 Auth.init 이 이미 띄웠다
      return true;
    },

    /** Auth.refresh() 가 실계정 로그인 확인 직후 부른다(로그인 → 원래 딥링크 복귀). 보관된 딥링크가 없으면 아무것도 안 한다. */
    async resumePending() {
      if (this._running || !this._loggedIn()) return null;
      const link = this._take();
      if (!link) return null;
      this._clearPending();
      return this.run(link);
    },

    /** 딥링크 실행 — 반환: "missing" | "locked" | "gated" | "opened" | "pin-missing" */
    async run(link) {
      this._running = true;
      try {
        const H = ProjectHub;
        if (!H._loaded || !(H.list || []).some((p) => p && String(p.id) === String(link.project))) await H.load();
        const v = this.resolve(H.list, link);
        if (v.kind === "missing") {
          this._cleanUrl();
          this._toast("이 QR 의 프로젝트를 열 수 없습니다 — 접근 권한이 없거나 삭제되었습니다", 4600);
          return "missing";
        }
        if (v.kind === "locked") {
          this._cleanUrl();
          if (H.openAccessReq) H.openAccessReq(v.project);   // 기존 비멤버 처리(접근 신청)
          return "locked";
        }
        await H.openProjectAtDeck(v.project, link.deck, null);
        if (!(typeof Auth !== "undefined" && Auth.isDesigner)) return "gated";   // requireDesigner 가 기존 게이트를 띄웠다
        if (link.deck && !(Projects.currentDeck && String(Projects.currentDeck.id) === String(link.deck))) {
          this._toast("QR 의 구역을 찾을 수 없습니다 — 삭제되었을 수 있어 프로젝트 원본을 엽니다", 4200);
        }
        if (!link.pin) return "opened";
        return (await this.focusPin(link.pin)) ? "opened" : "pin-missing";
      } finally { this._running = false; }
    },

    async _waitPin(pinId, ms) {
      const until = Date.now() + (ms || this.PIN_WAIT_MS);
      for (;;) {
        const pin = (State.pins || []).find((p) => p && String(p.id) === String(pinId));
        if (pin || Date.now() > until) return pin || null;
        await new Promise((r) => setTimeout(r, 100));
      }
    },

    /** 핀을 중앙에 두고 강조한 뒤 팝업 — 기존 App.focusPin / PinActionPop.open 재사용. */
    async focusPin(pinId) {
      const pin = await this._waitPin(pinId);
      if (!pin) { this._toast("QR 의 포인트를 이 도면에서 찾을 수 없습니다 — 삭제되었을 수 있습니다", 4600); return false; }
      // [WO 20261015-numunify] 종전 "핀 계열과 다른 모드면 그 모드로 전환" 폐기 — 모드는 더 이상 가시성을 잠그지 않는다
      //   (PinSeries.filter/inMode). 모드를 바꾸지 않으니 배치 상태도 그대로다.
      await App.focusPin(pin, false);
      this._pulse(pin.id);
      if (State.mode === "designer" && typeof PinActionPop !== "undefined" && PinActionPop.open) PinActionPop.open(pin.id);
      else if (typeof Inspector !== "undefined" && Inspector.showPin) Inspector.showPin(pin);
      return true;
    },

    /** 강조 — CSS 파일을 건드리지 않고 Web Animations 로 3회 맥동(숨김·이동 없음). */
    _pulse(pinId) {
      try {
        const m = document.querySelector('.pin-marker[data-id="' + String(pinId).replace(/"/g, "") + '"]');
        if (m && m.animate) m.animate([{ filter: "drop-shadow(0 0 0 #2563eb)" }, { filter: "drop-shadow(0 0 10px #2563eb)" }, { filter: "drop-shadow(0 0 0 #2563eb)" }], { duration: 700, iterations: 3 });
      } catch (e) {}
    }
  };

  const QrPrint = {
    COLS: 3,
    ROWS: 4,
    get PER_PAGE() { return this.COLS * this.ROWS; },
    LIB_SRC: "/js/vendor/qrcode.js",
    _libP: null,

    /** 순수 — A4 한 장 칸 수 기준 페이지 수 */
    pageCount(n) { return n > 0 ? Math.ceil(n / this.PER_PAGE) : 0; },

    /** 순수 — 인쇄 칸 목록. 구역 일괄이면 첫 칸 = 구역 자체 QR, 다음 = 그 구역 핀(Projects.pinsForDeck 결과, 번호순).
     *  numOf(pin) → 표시 번호 문자열(PinSeries.formatNo 정본을 호출부가 준다). */
    cells(opts) {
      const o = opts || {};
      const proj = o.project || {};
      const deck = o.deck || null;
      const out = [];
      const base = { project: proj.id, deck: deck && deck.id ? deck.id : null };
      const deckName = deck ? (deck.name || "(이름 없음)") : "원본 도면";
      if (o.includeDeck && deck && deck.id) {
        out.push({ kind: "deck", url: DeepLink.build(o.origin, base), no: "구역", label: deckName, deckName, projectName: proj.name || "" });
      }
      (o.pins || []).forEach((pin) => {
        if (!pin || !pin.id) return;
        out.push({ kind: "pin", url: DeepLink.build(o.origin, Object.assign({ pin: pin.id }, base)),
          no: o.numOf ? o.numOf(pin) : "", label: (pin.label || "").trim() || "(위치명 없음)", deckName, projectName: proj.name || "" });
      });
      return out;
    },

    _esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); },

    /** 순수 — 인쇄 문서. svgOf(url) → QR SVG 문자열. 페이지마다 COLS×ROWS 칸. 흑백(#000/#fff) 대비 21:1. */
    sheetHtml(cells, title, svgOf) {
      const esc = this._esc;
      const pages = [];
      for (let i = 0; i < cells.length; i += this.PER_PAGE) pages.push(cells.slice(i, i + this.PER_PAGE));
      const cellHtml = (c) => '<div class="qr-cell" data-kind="' + c.kind + '">' +
        '<div class="qr-svg">' + svgOf(c.url) + '</div>' +
        '<div class="qr-no">' + esc(c.no) + '</div>' +
        '<div class="qr-label">' + esc(c.label) + '</div>' +
        '<div class="qr-deck">' + esc(c.projectName ? c.projectName + " · " : "") + esc(c.deckName) + '</div></div>';
      return "<!doctype html><html><head><meta charset=\"utf-8\"><title>" + esc(title) + "</title><style>" +
        "body{font-family:'Malgun Gothic',sans-serif;color:#000;background:#fff;margin:0;padding:12px}" +
        ".qr-bar{display:flex;gap:10px;align-items:center;margin:0 0 10px}" +
        ".qr-bar button{padding:8px 16px;font-size:14px;font-weight:700;border:0;border-radius:6px;background:#1d4ed8;color:#fff;cursor:pointer}" +
        ".qr-page{display:grid;grid-template-columns:repeat(" + this.COLS + ",1fr);grid-auto-rows:66mm;gap:3mm;width:186mm;margin:0 auto 6mm;page-break-after:always;break-after:page}" +
        ".qr-page:last-child{page-break-after:auto;break-after:auto}" +
        ".qr-cell{border:1px dashed #555;padding:3mm;display:flex;flex-direction:column;align-items:center;overflow:hidden;box-sizing:border-box}" +
        ".qr-svg{width:40mm;height:40mm}.qr-svg svg{width:100%;height:100%}" +
        ".qr-no{font-size:16px;font-weight:800;margin-top:1mm}" +
        ".qr-label{font-size:12px;text-align:center;word-break:break-all;max-height:2.6em;overflow:hidden}" +
        ".qr-deck{font-size:10px;color:#333;text-align:center;word-break:break-all}" +
        "@media print{@page{size:A4 portrait;margin:12mm} body{padding:0} .qr-bar{display:none}}" +
        "</style></head><body>" +
        '<div class="qr-bar"><button type="button" onclick="window.print()">인쇄</button><span>' + esc(title) + " — " + cells.length + "칸 · A4 " + pages.length + "장</span></div>" +
        pages.map((pg) => '<div class="qr-page">' + pg.map(cellHtml).join("") + "</div>").join("") +
        "</body></html>";
    },

    /** vendor QR 라이브러리 지연 로드(1회). 실패(오프라인에서 한 번도 받은 적 없음 등) → reject. */
    _lib() {
      if (typeof window !== "undefined" && typeof window.qrcode === "function") return Promise.resolve(window.qrcode);
      if (this._libP) return this._libP;
      this._libP = new Promise((res, rej) => {
        const s = document.createElement("script");
        s.src = this.LIB_SRC;
        s.onload = () => (typeof window.qrcode === "function" ? res(window.qrcode) : rej(new Error("qrcode 없음")));
        s.onerror = () => rej(new Error("QR 라이브러리를 불러오지 못했습니다"));
        document.head.appendChild(s);
      }).catch((e) => { this._libP = null; throw e; });
      return this._libP;
    },
    svgFor(lib, text) {
      const q = lib(0, "M");
      q.addData(text);
      q.make();
      return q.createSvgTag({ cellSize: 4, margin: 8, scalable: true, alt: text });
    },

    _numOf(pin) {
      try {
        const info = PinSeries.numbers(State.pins, pin.page || 1).get(pin.id);
        return info ? PinSeries.formatNo(info.no, info.series) : "";
      } catch (e) { return ""; }
    },

    /** 🔴 인쇄 창은 클릭 제스처 안에서 **동기로** 먼저 연다(await 뒤에 열면 팝업 차단). */
    async _print(cells, title) {
      const w = (typeof Report !== "undefined" && Report.openPrintWindow) ? Report.openPrintWindow() : null;
      if (!w) return false;
      let lib;
      try { lib = await this._lib(); }
      catch (e) {
        try { w.close(); } catch (er) {}
        DeepLink._toast("QR 을 만들 수 없습니다 — " + (e && e.message ? e.message : "라이브러리 로드 실패") + "(온라인에서 한 번 열면 오프라인에서도 됩니다)", 4800);
        return false;
      }
      Report.writePrint(w, this.sheetHtml(cells, title, (url) => this.svgFor(lib, url)));
      return true;
    },

    /** 핀 팝업 [QR] — 그 핀 1칸. */
    printPin(pin) {
      const proj = (typeof Projects !== "undefined" && Projects.currentProject) || null;
      if (!pin || !proj) { DeepLink._toast("프로젝트를 먼저 여세요"); return Promise.resolve(false); }
      const deck = Projects.currentDeck || null;
      const cells = this.cells({ origin: location.origin, project: proj, deck, pins: [pin], numOf: (p) => this._numOf(p) });
      return this._print(cells, "QR 위치 태그 — " + (proj.name || "") + " " + (cells[0] ? cells[0].no : ""));
    },

    /** 구역 일괄 — 그 구역이 지금 로드된 도면에 있어야 핀을 안다(미로드 구역은 0 날조 금지). */
    deckReason(deck) {
      if (!deck || !deck.id) return "구역·영역을 먼저 여세요(트리에서 선택)";
      if (!deck.deployment_id || String(deck.deployment_id) !== String(State.currentDeploymentId || "")) return "이 구역을 먼저 여세요(포인트 목록이 필요합니다)";
      return "";
    },
    deckPins(deck) {
      const pins = (Projects.pinsForDeck ? Projects.pinsForDeck(State.pins || [], deck) : (State.pins || [])).filter((p) => p && !p._deleted);
      return pins.slice().sort((a, b) => ((a.page || 1) - (b.page || 1)) || String(this._numOf(a)).localeCompare(String(this._numOf(b)), "ko", { numeric: true }));
    },
    printDeck(deck) {
      const why = this.deckReason(deck);
      if (why) { DeepLink._toast(why); return Promise.resolve(false); }
      const proj = Projects.currentProject || {};
      const cells = this.cells({ origin: location.origin, project: proj, deck, pins: this.deckPins(deck), includeDeck: true, numOf: (p) => this._numOf(p) });
      return this._print(cells, "QR 위치 태그 — " + (proj.name || "") + " · " + (deck.name || ""));
    },

    /** 핀 팝업에 [QR] 버튼 주입(index.html 무변경 — Report.init 과 같은 런타임 주입). */
    init() {
      const row = document.querySelector("#pin-action-pop .pap-actions");
      if (!row || document.getElementById("pap-qr")) return;
      const b = document.createElement("button");
      b.id = "pap-qr";
      b.type = "button";
      b.className = "pap-btn pap-qr";
      b.title = "이 포인트의 QR 위치 태그 인쇄 — 폰 카메라로 찍으면 이 포인트가 열립니다";
      b.setAttribute("aria-label", "QR 위치 태그 인쇄");
      b.setAttribute("data-help", "qr-tag");
      b.innerHTML = '<i class="fa-solid fa-qrcode"></i><span>QR</span>';
      b.addEventListener("click", () => {
        const pin = (typeof PinActionPop !== "undefined" && PinActionPop._pin) ? PinActionPop._pin() : null;
        this.printPin(pin);
      });
      row.appendChild(b);
    }
  };
