  /* ══════════════════════════════════════════════════════════════
     BACKGUARD — 뒤로가기 이탈 방지 + 앱 안 화면 이동의 history SoT (WO 20261010-backctx)
     ────────────────────────────────────────────────────────────────
     마스터(2026-10-10): "뒤로를 눌러 이 프로젝트를 바로 빠져나가지 않게. 그런 일이 있으면
       '정말 페이지를 나가겠습니까'라고 물어보고 절대 바로 빠져나가지 않게."
     🔴 근본원인: 앱 안 화면 전환(허브→프로젝트→구역/영역→360→모달)이 history 에 0건이라 뒤로가기 = 사이트 이탈.
     설계 — 진입 함수를 하나씩 감싸지 않는다(20곳+ · 모듈마다 다른 팀). 대신 "지금 열린 레이어 목록"을
       한 함수(layers)에서 화면 상태로 판정하고, 그 깊이가 바뀔 때마다 history 를 맞춘다(sync = 공유 지점 1곳).
       · 깊이↑(사용자 조작 직후) → pushState  · 깊이↑(조작 없이) → replaceState(아래 Chrome 개입 참고)
       · 깊이↓(앱 버튼으로 닫음) → 남는 항목을 조용히 history.go(-n)
       · 뒤로(popstate) → 그 항목의 깊이까지 레이어를 기존 닫기 함수로 닫는다(새 닫기 로직 0)
       · 맨 아래(허브)에서 뒤로 → 앱 확인창 [머무르기][나가기](기본 포커스 머무르기). 나가기일 때만 실제 이탈.
     🔴 Chrome history manipulation intervention: 사용자 조작 없이 push 된 항목은 브라우저 뒤로 버튼이 건너뛴다
       (그 항목을 만든 문서에 조작이 없었으면 직전 항목이 skippable). → push 는 "마지막 history 이동 이후 사용자
       조작(_gesture)"이 있을 때만. 조작 전(페이지를 열고 아무것도 안 누른 상태)에는 가드를 걸 수 없다 — 이때 뒤로가기는
       브라우저 표준대로 이탈한다(beforeunload 도 브라우저가 "조작 없는 페이지"엔 띄우지 않는다). 브라우저 한계 — 정직 기록.
     탭 닫기·새로고침·주소창 이동 = 웹페이지가 자체 창을 띄울 수 없다(표준) → beforeunload(브라우저 기본 확인)를 항상.
       앱이 스스로 시작한 이동(로그아웃 새로고침·링크·location.*)은 Navigation API navigate 로 구분해 확인 없이 통과.
     Capacitor(안드로이드 앱): backButton → handleBack()(공개 API). 자동 배선 + APK 팀이 직접 불러도 250ms 중복 무시.
  ══════════════════════════════════════════════════════════════ */
  const BackGuard = {
    SID: Math.random().toString(36).slice(2, 10),
    SYNC_DELAY_MS: 220,       // 닫힘 페이드(200ms) 같은 과도 상태를 넘기고 판정한다
    RESTORE_MS: 2500,         // 뒤로 복원(닫기·구역 로드) 중 sync 정지 상한
    _stack: [],               // 이 문서가 쌓은 항목 [{seq,bg,r,pid,dk}] — [0] = 가드(Base 바로 위)
    _seq: 0,
    _gesture: false,          // 마지막 history 이동 이후 사용자 조작(활성화 이벤트)이 있었나
    _expectPop: 0,            // 우리가 일으킨 history.go 의 popstate 수
    _restoreUntil: 0,
    _restoreTarget: null,
    _leaveUntil: 0,           // leave()(사용자가 [나가기]) 진행 중
    _appNavUntil: 0,          // 앱이 시작한 문서 이동(로그아웃 등) — beforeunload 생략
    STRICT: false,            // true = push 는 "마지막 history 이동 이후 조작"이 있을 때만(아래 _canPush)
    _exitOpen: false,
    _left: false,
    _inited: false,
    _lastBack: 0,
    _timer: null,
    _origPush: null,
    _origReplace: null,

    /* ─── 상태 판정(SoT) ─── */
    _vis(el) {
      try {
        if (!el || !el.isConnected || (el.classList && el.classList.contains("hidden"))) return false;
        if (!el.getClientRects().length) return false;
        const cs = getComputedStyle(el);
        return cs.visibility !== "hidden" && cs.display !== "none";
      } catch (e) { return false; }
    },
    /** 열람 공유 링크(?d= · 공유 토큰) = 프로젝트 화면이 곧 최상위(허브로 갈 수 없다). */
    _isShareRoot() {
      try {
        if (typeof ProjectHub !== "undefined" && ProjectHub._isShareEntry && ProjectHub._isShareEntry()) return true;
        return typeof State !== "undefined" && !!State.viewerLocked;
      } catch (e) { return false; }
    },
    _projectOpen() {
      const a = document.getElementById("screen-app"), h = document.getElementById("screen-home");
      return !!((a && a.classList.contains("active")) || (h && h.classList.contains("active")));
    },
    _pid() {
      try { return this._projectOpen() && typeof Projects !== "undefined" && Projects.currentProject ? String(Projects.currentProject.id) : ""; } catch (e) { return ""; }
    },
    /** 구역 키 — "o" = 원본(메인) 전체 도면/구역 없음, 그 외 = 구역·영역 id. 원본 판정 SoT = Projects.pickOriginalDeck. */
    _deckKey() {
      try {
        if (!this._projectOpen() || typeof Projects === "undefined") return "o";
        const d = Projects.currentDeck;
        if (!d || d.id == null) return "o";
        const o = Projects.pickOriginalDeck ? Projects.pickOriginalDeck(Projects.decks || [], Projects.currentProject) : null;
        if (o && o.id != null && String(o.id) === String(d.id)) return "o";
        return String(d.id);
      } catch (e) { return "o"; }
    },
    /** 화면 위 오버레이(모달·패널·시트) — 닫기 = 그 모듈의 기존 닫기 함수. 아래 GENERIC 은 나머지 dialog 를 잡는다. */
    OVERLAYS: [
      { k: "confirm", el: () => document.querySelector("#wm-confirm-modal.on"), close: () => { const b = document.getElementById("wm-confirm-cancel"); if (b) b.click(); } },
      { k: "prompt", el: () => document.querySelector("#prompt-modal.on"), close: () => Prompt._close(null) },
      { k: "requests", el: () => (typeof Requests !== "undefined" ? Requests._panelEl : null), close: () => Requests.closePanel() },
      { k: "projectinfo", el: () => (typeof ProjectInfo !== "undefined" ? ProjectInfo._panelEl : null), close: () => ProjectInfo.closePanel() },
      { k: "features", el: () => document.getElementById("feature-menu"), close: () => FeatureMenu.close() },
      { k: "pdfpopup", el: () => document.getElementById("pdf-popup"), close: () => PdfPopup.close() },
      { k: "compare360", el: () => document.getElementById("pano-compare-360"), close: () => CompareSync.close() },
      { k: "compare", el: () => document.getElementById("pano-compare"), close: () => Compare.close() },
      { k: "allpins", el: () => (typeof AllPins !== "undefined" && AllPins.open ? document.getElementById("allpins-drawer") : null), close: () => AllPins.hide() },
      { k: "modeselect", el: () => document.getElementById("proj-mode-select-modal"), close: () => ProjectHub.closeModeSelect() },
      { k: "members", el: () => document.getElementById("proj-members-modal"), close: () => ProjectHub.closeMembers() },
      { k: "accessreq", el: () => document.getElementById("proj-access-req-modal"), close: () => ProjectHub.closeAccessReq() },
      { k: "moresheet", el: () => document.querySelector("#mdock-more-sheet.open"), close: () => { const b = document.getElementById("mdock-more-toggle"); if (b) b.click(); } }
    ],
    /** 게이트(로그인·공유 코드·설치 등) = 닫는 레이어가 아니다 — 그 위에서 뒤로 = 이탈 확인. */
    GATES: "#login-gate, #company-gate, #access-gate, #share-gate-modal, #invite-gate, #install-gate",
    GENERIC: '[role="dialog"], [aria-modal="true"], .admin-gate',
    _genericClose(el) {
      const btn = el.querySelector('[data-close], [id$="-close"], [id$="-cancel"], .fm-close, .modal-close, [aria-label="닫기"], [aria-label="Close"]');
      if (btn) { btn.click(); return; }
      const bd = el.querySelector(".admin-gate-backdrop");
      if (bd) { bd.click(); return; }
      try { el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); } catch (e) {}
    },
    _overlays() {
      const out = [], seen = [];
      const z = (el) => { try { const v = parseInt(getComputedStyle(el).zIndex, 10); return isNaN(v) ? 0 : v; } catch (e) { return 0; } };
      this.OVERLAYS.forEach((o) => {
        let el = null;
        try { el = o.el(); } catch (e) { el = null; }
        if (el && this._vis(el)) { out.push({ k: o.k, el, close: o.close }); seen.push(el); }
      });
      document.querySelectorAll(this.GENERIC).forEach((el) => {
        if (!this._vis(el) || el.closest("#pano-overlay") || el.closest(".tree-pop")) return;
        if (el.matches(this.GATES) || el.closest(this.GATES)) return;
        if (el.id === "wm-confirm-modal" || el.id === "prompt-modal") return;   // 위 OVERLAYS 가 "on"(닫힘 페이드 제외)으로 판정
        if (seen.some((s) => s === el || s.contains(el) || el.contains(s))) return;
        out.push({ k: "dialog:" + (el.id || String(el.className || "").split(" ")[0]), el, close: () => this._genericClose(el) });
        seen.push(el);
      });
      // 아래 → 위(쌓임 순서): z-index, 같으면 문서 순서
      return out.map((o, i) => ({ o, i, z: z(o.el) })).sort((a, b) => (a.z - b.z) || (a.o.el.compareDocumentPosition(b.o.el) & 2 ? 1 : -1)).map((x) => x.o);
    },
    /** 지금 열린 레이어(아래 → 위). route = 프로젝트·구역(뒤로 시 "어느 화면" 복원 대상). */
    layers() {
      const L = [];
      const proj = this._projectOpen();
      if (proj && !this._isShareRoot()) L.push({ k: "project", route: true, close: () => this._closeProject() });
      if (proj && this._deckKey() !== "o") L.push({ k: "deck", route: true, close: () => this._gotoDeck("o") });
      if (proj && typeof State !== "undefined" && State.zoneView) L.push({ k: "zone", close: () => App.exitZoneView() });
      if (typeof PanoViewer !== "undefined" && PanoViewer.open) L.push({ k: "pano", close: () => PanoViewer.close() });
      this._overlays().forEach((o) => L.push(o));
      return L;
    },
    snapshot() {
      const L = this.layers();
      return { bg: L.length, r: L.filter((l) => l.route).length, pid: this._pid(), dk: this._deckKey(), top: L.length ? L[L.length - 1].k : "" };
    },
    /** [프로젝트 목록] 버튼 그대로(정리 로직 SoT = 20_App _bindTopbar btn-back). */
    _closeProject() {
      const a = document.getElementById("screen-app");
      const b = document.getElementById("btn-back");
      if (a && a.classList.contains("active") && b) { b.click(); return; }
      if (typeof ProjectHub !== "undefined" && ProjectHub.open) ProjectHub.open();
    },
    _gotoDeck(dk) {
      try {
        if (typeof Projects === "undefined") return;
        const d = dk && dk !== "o" ? (Projects.decks || []).find((x) => String(x.id) === String(dk)) : null;
        if (d && Projects.selectDeck) Projects.selectDeck(d);
        else if (Projects.openOriginal) Projects.openOriginal();
      } catch (e) {}
    },
    _close(l) { try { if (l && l.close) l.close(); } catch (e) {} },

    /* ─── history ─── */
    _state(s) { return { __bg: this.SID, seq: s.seq, bg: s.bg, r: s.r, pid: s.pid, dk: s.dk }; },
    _push(s) {
      s.seq = ++this._seq;
      this._origPush(this._state(s), "");
      this._stack.push(s);
      this._gesture = false;   // push 도 history 이동 — 다음 push 는 새 조작 뒤에만
    },
    _replace(s) {
      const top = this._stack[this._stack.length - 1];
      s.seq = top ? top.seq : ++this._seq;
      this._origReplace(this._state(s), "");
      if (top) this._stack[this._stack.length - 1] = s; else this._stack.push(s);
    },
    /** push 허용 — 기본: 이 문서에 사용자 활성화가 한 번이라도 있었으면(sticky). STRICT: 마지막 history 이동 이후 조작.
     *  (Chrome 개입은 "조작 없는 문서"의 항목을 건너뛴다 — 실측 결과는 tests/p144 · 보고서 참조) */
    _canPush() {
      if (this.STRICT) return this._gesture;
      try { if (navigator.userActivation) return navigator.userActivation.hasBeenActive || this._gesture; } catch (e) {}
      return this._everGesture || this._gesture;
    },
    schedule(ms) {
      if (this._timer) clearTimeout(this._timer);
      this._timer = setTimeout(() => { this._timer = null; this.sync(); }, ms == null ? this.SYNC_DELAY_MS : ms);
    },
    /** 화면 상태 ↔ history 맞춤(공유 지점 1곳). */
    sync() {
      if (!this._inited || this._exitOpen || this._expectPop > 0) return;
      if (Date.now() < this._restoreUntil) {
        const t = this._restoreTarget, s = this.snapshot();
        if (t && s.bg <= t.bg && s.pid === t.pid && s.dk === t.dk) this._restoreUntil = 0; // 복원 끝
        else { this.schedule(300); return; }
      }
      const s = this.snapshot();
      if (!this._stack.length) {   // 가드 미설치 — 첫 조작 뒤에 Base 위로 1개
        if (this._canPush()) this._push(s);
        return;
      }
      const top = this._stack[this._stack.length - 1];
      if (s.bg > top.bg) { if (this._canPush()) this._push(s); else this._replace(s); return; }
      if (s.bg === top.bg) {
        // 같은 깊이에서 다른 구역으로(트리 클릭) = 새 화면 — 뒤로 시 직전 구역으로
        if (s.pid && s.pid === top.pid && s.dk !== top.dk && this._canPush()) this._push(s);
        else if (s.pid !== top.pid || s.dk !== top.dk || s.r !== top.r) this._replace(s);
        return;
      }
      // 앱 버튼으로 닫힘 — 지금 깊이 이하인 가장 위 항목까지 조용히 되돌린다
      let i = this._stack.length - 1;
      while (i > 0 && this._stack[i].bg > s.bg) i--;
      const n = this._stack.length - 1 - i;
      if (n > 0) { this._stack.length = i + 1; this._expectPop++; history.go(-n); }
      else this._replace(s);
    },
    _onPop(e) {
      this._gesture = false;
      if (Date.now() < this._leaveUntil) { try { history.back(); } catch (er) {} return; } // [나가기] 진행 중 — 앞 세션 항목도 넘는다
      if (this._expectPop > 0) {
        this._expectPop--;
        if (this._stack.length) this._replace(this.snapshot());
        return;
      }
      const st = e && e.state;
      if (st && st.__bg === this.SID) {
        const idx = this._stack.findIndex((x) => x.seq === st.seq);
        const top = this._stack[this._stack.length - 1];
        if (idx < 0 || (top && st.seq > top.seq)) {   // 앞으로 가기 — 닫힌 화면은 다시 열 수 없다: 지금 화면으로 맞춘다
          this._stack.push({ seq: st.seq });
          this._replace(this.snapshot());
          return;
        }
        this._stack.length = idx + 1;
        this._restore(this._stack[idx]);
        return;
      }
      // Base(가드 아래 = 이 사이트에 들어온 첫 항목) — 다음 뒤로는 사이트 이탈
      this._stack = [];
      const s = this.snapshot();
      if (s.bg > 0) { this._restore({ bg: 0, r: 0, pid: "", dk: "o" }); return; } // 레이어가 남아 있으면 먼저 닫는다(가드는 복원 뒤 sync 가 다시)
      this.confirmExit();
    },
    /** 뒤로 = 그 항목 상태까지 기존 닫기 함수로. */
    _restore(t) {
      this._restoreTarget = t;
      this._restoreUntil = Date.now() + this.RESTORE_MS;
      try { if (typeof UI !== "undefined" && UI.closeTreeMenu) UI.closeTreeMenu(); } catch (e) {}
      const L = this.layers();
      const extra = L.filter((l) => !l.route);
      const keep = Math.max(0, (t.bg || 0) - (t.r || 0));
      for (let i = extra.length - 1; i >= keep; i--) this._close(extra[i]);
      if (!t.pid && this._projectOpen() && !this._isShareRoot()) this._closeProject();
      else if (t.pid && t.pid === this._pid() && t.dk !== this._deckKey()) this._gotoDeck(t.dk);
      this.schedule(400);
    },

    /* ─── 이탈 ─── */
    unsavedInfo() {
      let dirty = false, pending = 0;
      try {
        // [WO offline2-R4 이관] 미저장(App._dirty) + 서버 반영 대기(App._pendingSyncCount — Offline.updateNetBadge 와 같은 합계)
        if (typeof State !== "undefined" && State.mode === "designer" && typeof App !== "undefined") {
          dirty = !!App._dirty;
          pending = App._pendingSyncCount || 0;
        }
      } catch (e) {}
      const parts = [];
      if (dirty) parts.push("저장하지 않은 변경");
      if (pending > 0) parts.push("서버 반영 대기 " + pending + "건");
      return { dirty, pending, text: parts.length ? parts.join(" · ") + "이 있습니다 — 지금 나가면 서버에 반영되지 않을 수 있습니다." : "" };
    },
    async confirmExit() {
      if (this._exitOpen) return false;
      this._exitOpen = true;
      const u = this.unsavedInfo();
      let leave = false;
      let lifted = null;
      try {
        if (typeof Prompt !== "undefined" && Prompt.confirm) {
          const pr = Prompt.confirm("정말 SEASTAR 360을 나가시겠습니까?",
            (u.text ? u.text + "\n" : "") + "[머무르기]를 누르면 지금 화면 그대로 계속합니다.",
            { okText: "나가기", cancelText: "머무르기", focus: "cancel", kind: "exit" });
          lifted = this._liftOverGate();
          leave = await pr;
        }
      } catch (e) { leave = false; }
      if (lifted) lifted();
      this._exitOpen = false;
      if (leave) { this.leave(); return true; }
      this.sync();   // 머무르기 클릭 = 사용자 조작 → 가드 재설치
      return false;
    },
    /** 모바일 설치 게이트(38b_InstallGate)는 body 의 다른 자식을 inert 로 막고 z-index 2147483000 으로 덮는다 — 그 위에서
     *  뒤로를 누르면 확인창이 게이트 밑에 숨어 조작이 안 됐다(375 CDP 실측). 이탈 확인창만 게이트의 허용 표식
     *  (data-installgate-allow — 게이트 정본 규칙)을 달고 그 위로 올린다. 닫히면 원래대로(게이트가 여전히 있으면 inert 복귀). */
    _liftOverGate() {
      const gate = document.getElementById("install-gate");
      const m = document.getElementById("wm-confirm-modal");
      if (!m || !gate || !this._vis(gate)) return null;
      const wasInert = m.hasAttribute("inert");
      m.removeAttribute("inert");
      m.setAttribute("data-installgate-allow", "1");
      m.style.zIndex = "2147483600";
      try { const c = document.getElementById("wm-confirm-cancel"); if (c) c.focus(); } catch (e) {}
      return () => {
        m.style.zIndex = "";
        m.removeAttribute("data-installgate-allow");
        if (wasInert && this._vis(gate)) m.setAttribute("inert", "");
      };
    },
    _cap() { try { const C = window.Capacitor; return C && C.Plugins ? C.Plugins : null; } catch (e) { return null; } },
    leave() {
      this._leaveUntil = Date.now() + 8000;
      const cap = this._cap();
      if (cap && cap.App && cap.App.exitApp) { try { cap.App.exitApp(); return; } catch (e) {} }
      const n = this._stack.length;
      this._stack = [];
      try { history.go(-(n + 1)); } catch (e) {}
      setTimeout(() => {
        if (this._left) return;
        try { window.close(); } catch (e) {}
        setTimeout(() => {
          if (this._left) return;
          this._leaveUntil = 0;   // 갈 곳이 없다(새 탭·독립 실행 첫 화면) — 가드는 다음 조작 때 다시
          try { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("더 돌아갈 페이지가 없습니다 — 브라우저 탭(앱)을 닫아 종료하세요", 4200); } catch (e) {}
        }, 400);
      }, 700);
    },
    /** 공개 API — 안드로이드 앱(Capacitor backButton)·우클릭 메뉴 [뒤로]가 부른다. 결과 문자열은 진단용. */
    handleBack() {
      const now = Date.now();
      if (now - this._lastBack < 250) return "debounced";
      this._lastBack = now;
      if (this._exitOpen) { const b = document.getElementById("wm-confirm-cancel"); if (b) b.click(); return "stay"; }
      if (this._stack.length > 1 && this._expectPop === 0) { history.back(); return "history"; }
      try { if (typeof UI !== "undefined" && UI.closeTreeMenu) UI.closeTreeMenu(); } catch (e) {}
      const L = this.layers();
      if (L.length) { const top = L[L.length - 1]; this._close(top); this.schedule(); return "closed:" + top.k; }
      this.confirmExit();
      return "confirm";
    },
    wireCapacitor() {
      const P = this._cap();
      if (this._capWired || !P || !P.App || !P.App.addListener) return false;
      this._capWired = true;
      try { P.App.addListener("backButton", () => this.handleBack()); } catch (e) { this._capWired = false; }
      return this._capWired;
    },
    /** 자동화 브라우저(navigator.webdriver)에선 beforeunload 를 걸지 않는다 — 기존 CDP 테스트 20여 개가 페이지 이동 때
     *  네이티브 확인창에 멈추지 않게. 이 모듈의 실측(p144)은 localStorage "bg-force-guard"="1" 로 강제한다. */
    _guardUnload() {
      try { if (navigator.webdriver && localStorage.getItem("bg-force-guard") !== "1") return false; } catch (e) {}
      return true;
    },
    _onBeforeUnload(e) {
      if (Date.now() < this._leaveUntil || Date.now() < this._appNavUntil || !this._guardUnload()) return undefined;
      const u = this.unsavedInfo();
      e.preventDefault();
      e.returnValue = u.text || "SEASTAR 360을 나가시겠습니까?";
      return e.returnValue;
    },

    init() {
      if (this._inited || typeof window === "undefined" || !window.history || !history.pushState) return;
      this._inited = true;
      this._origPush = history.pushState.bind(history);
      const origReplace = history.replaceState.bind(history);
      this._origReplace = origReplace;
      // 다른 모듈의 URL 정리(replaceState(null|{}, "", url)) 가 이 항목의 가드 표식을 지우지 않게 — 표식만 이어 붙인다.
      history.replaceState = function (s, t, u) {
        const cur = history.state;
        if (cur && cur.__bg && (s == null || (typeof s === "object" && !s.__bg))) {
          s = Object.assign({}, s || {}, { __bg: cur.__bg, seq: cur.seq, bg: cur.bg, r: cur.r, pid: cur.pid, dk: cur.dk });
        }
        return arguments.length >= 3 ? origReplace(s, t, u) : origReplace(s, t);
      };
      // 새로고침으로 앞 세션 항목 위에 섰다면 그 표식을 지운다 — 지금 항목 = 새 Base
      try { if (history.state && history.state.__bg) origReplace(null, ""); } catch (e) {}
      window.addEventListener("popstate", (e) => this._onPop(e));
      window.addEventListener("beforeunload", (e) => this._onBeforeUnload(e));
      window.addEventListener("pagehide", () => { this._left = true; });
      window.addEventListener("pageshow", () => { this._left = false; });
      // 앱이 스스로 시작한 문서 이동(로그아웃 새로고침·location.*·링크) = 명시적 이동 — 확인 없이 통과
      try {
        if (window.navigation && window.navigation.addEventListener) {
          window.navigation.addEventListener("navigate", (e) => {
            if (!e || (e.destination && e.destination.sameDocument) || e.navigationType === "traverse" || e.downloadRequest) return;
            this._appNavUntil = Date.now() + 3000;
          });
        }
      } catch (e) {}
      // 사용자 활성화 이벤트(HTML 표준 목록) — Esc·터치 시작은 활성화가 아니다
      const mark = (e) => {
        if (!e.isTrusted) return;
        if (e.type === "keydown" && (e.key === "Escape" || e.key === "Shift" || e.key === "Control" || e.key === "Alt" || e.key === "Meta")) return;
        if (e.type === "pointerdown" && e.pointerType && e.pointerType !== "mouse") return;
        if (e.type === "pointerup" && e.pointerType === "mouse") return;
        this._gesture = true; this._everGesture = true;
        // 첫 조작 = 가드 설치 — 이 조작이 여는 화면보다 먼저(동기) 허브 수준 항목을 깐다
        if (!this._stack.length && !this._exitOpen && this._expectPop === 0 && Date.now() >= this._restoreUntil) this.sync();
        this.schedule();
      };
      ["keydown", "mousedown", "pointerdown", "pointerup", "touchend"].forEach((t) => window.addEventListener(t, mark, { capture: true, passive: true }));
      window.addEventListener("click", () => this.schedule(), { capture: true, passive: true });
      const observe = () => {
        try { new MutationObserver(() => this.schedule()).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] }); } catch (e) {}
      };
      if (document.body) observe(); else document.addEventListener("DOMContentLoaded", observe);
      this.wireCapacitor();
    }
  };
  if (typeof window !== "undefined") {
    window.BackGuard = BackGuard;   // 공개 API — APK 팀(Capacitor backButton)·테스트
    BackGuard.init();
  }
