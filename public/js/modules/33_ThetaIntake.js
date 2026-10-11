  /* ══════════════════════════════════════════════════════════════
     THETA 360 인입 — 오프라인 R* 360 사진을 가져와 도면에 핀 위치 지정 등록
     ────────────────────────────────────────────────────────────────
     · 마스터 요청: THETA 앱이 폰에 저장한 R*(R00xxxxx.JPG) 360 사진이 "들어오면",
       이 프로젝트 도면 위에 "사진 위치를 등록할 핀을 지정"하는 기능. 오프라인 동작.
     · 흐름: [360 인입] 버튼 → 갤러리에서 R* 360 사진 다중 선택 → R*·2:1 필터 →
       미배치 트레이(IndexedDB 영속) → 사진 탭 → 도면에서 위치 탭 → 그 자리에 360 핀 등록.
       오프라인이면 OpLog/SyncQueue 큐잉 → 온라인 시 "↑ 지금 올리기"로 반영.
     · 통합: 위치 탭은 기존 배치 흐름(App._handlePlaceClick) 재사용. 인입 사진은
       State.intakeFile 로 주입 → 파일 선택 없이 _acceptPinMediaFile 로 360 핀 자동 등록.
  ══════════════════════════════════════════════════════════════ */
  /* [WO 20261002-allmenu §7] 🔴 RICOH THETA 앱 진입 URL — SoT(이 한 곳). 지휘자 실측 출처:
     Android 패키지 com.theta360(Play), iOS App Store id1023254741. iOS 공식 URL 스킴은 확인되지 않아
     App Store 링크로 연다(설치돼 있으면 스토어에 [열기]가 뜬다) — 스킴을 추측해 쓰지 않는다. */
  const THETA_APP = Object.freeze({
    PACKAGE: "com.theta360",
    PLAY_URL: "https://play.google.com/store/apps/details?id=com.theta360",
    APPSTORE_URL: "https://apps.apple.com/app/ricoh-theta/id1023254741",
    WAIT_KEY: "theta_app_wait_v1",
    WAIT_MS: 10 * 60 * 1000,              // THETA 대기 플래그 유효 10분(WO §8 ②)
    LABEL: "RICOH THETA 앱 열기",
    HINT: "THETA 앱에서 촬영 → 돌아와 사진 선택"
  });

  const ThetaIntake = {
    _pending: [],          // [{ id, name, dataURL }]
    _activeId: null,
    _KEY: "theta_intake_v1",
    APP: THETA_APP,

    init() {
      const $ = (id) => document.getElementById(id);
      $("btn-theta-intake") && $("btn-theta-intake").addEventListener("click", () => this.openPicker());
      const inp = $("input-theta-intake");
      if (inp) inp.addEventListener("change", (e) => { const files = Array.from(e.target.files || []); e.target.value = ""; this.importFiles(files); });
      $("theta-tray-close") && $("theta-tray-close").addEventListener("click", () => this.hideTray());
      this._restore();
      // [마스터: 사진 들어오면 트리거] 공유로 들어온 사진 자동 인입(?shared=1)
      try { if (new URLSearchParams(location.search).get("shared") === "1") this.handleShared(); } catch (e) {}
      // [WO 20261002-allmenu §8 ①] 이미 떠 있는 창 — SW 가 공유 사진을 캐시에 넣고 postMessage 로 알린다(리로드 없음).
      try {
        if (navigator.serviceWorker && navigator.serviceWorker.addEventListener) {
          navigator.serviceWorker.addEventListener("message", (e) => { if (e && e.data && e.data.type === "theta-shared") this.handleShared(); });
        }
      } catch (e) {}
      // [WO 20261002-allmenu §7·§8 ②] THETA 앱에서 돌아옴(visible) → 대기 플래그가 유효하면 복귀 시트.
      try { document.addEventListener("visibilitychange", () => this.onVisibility()); } catch (e) {}
      this.mountAppButtons();
    },

    /* ── [WO 20261002-allmenu §7] RICOH THETA 앱 바로 열기 ─────────────────────────── */
    /** 플랫폼 판정(순수) — iOS 규칙은 38_Install.isIOS 와 같다(iPadOS 13+ = MacIntel + 터치). */
    platformOf(nav) {
      nav = nav || {};
      const ua = String(nav.userAgent || "");
      if (/iPad|iPhone|iPod/.test(ua) || (nav.platform === "MacIntel" && Number(nav.maxTouchPoints || 0) > 1)) return "ios";
      if (/Android/i.test(ua)) return "android";
      return "desktop";
    },
    /** 플랫폼별 THETA 앱 진입 URL. desktop = null(휴대폰 전용). */
    appUrl(platform) {
      if (platform === "android") {
        return "intent://#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package="
          + THETA_APP.PACKAGE + ";S.browser_fallback_url=" + encodeURIComponent(THETA_APP.PLAY_URL) + ";end";
      }
      if (platform === "ios") return THETA_APP.APPSTORE_URL;
      return null;
    },
    /** 전체 기능 메뉴·도크·사진 시트가 같이 쓰는 비활성 사유(숨김 금지) — "" = 사용 가능. */
    appDisabledReason(nav) {
      return this.platformOf(nav || (typeof navigator !== "undefined" ? navigator : {})) === "desktop" ? "휴대폰에서 사용" : "";
    },
    /** 앱 열기 — 대기 플래그(시각·대상 핀)를 켠 뒤 이동. 돌아오면 onVisibility 가 복귀 시트를 띄운다. */
    openApp(opts) {
      const nav = (typeof navigator !== "undefined") ? navigator : {};
      const url = this.appUrl(this.platformOf(nav));
      if (!url) { this._toast("휴대폰에서 사용 — RICOH THETA 앱은 휴대폰에서 열 수 있습니다"); return false; }
      this._armWait(opts && opts.pinId != null ? opts.pinId : null);
      this._go(url);
      return true;
    },
    _go(url) { try { window.location.href = url; } catch (e) {} },
    _armWait(pinId) {
      try { localStorage.setItem(THETA_APP.WAIT_KEY, JSON.stringify({ at: Date.now(), pinId: pinId == null ? null : pinId })); } catch (e) {}
    },
    /** 대기 플래그를 꺼내며 항상 지운다(1회성). 10분 지났으면 null. */
    _takeWait(now) {
      let w = null;
      try { w = JSON.parse(localStorage.getItem(THETA_APP.WAIT_KEY) || "null"); localStorage.removeItem(THETA_APP.WAIT_KEY); } catch (e) { w = null; }
      if (!w || !Number.isFinite(w.at)) return null;
      return ((now != null ? now : Date.now()) - w.at) <= THETA_APP.WAIT_MS ? w : null;
    },
    onVisibility() {
      if (typeof document !== "undefined" && document.visibilityState && document.visibilityState !== "visible") return;
      const w = this._takeWait();
      if (w) this.showReturnSheet(w);
    },
    /** 복귀 시트 — 브라우저 보안상 갤러리를 자동으로 읽을 수 없어 탭 1회로 파일창을 연다.
     *  핀 시트에서 열었으면(pinId) 기존 "최근 360 추천"(PhotoBatch.autoConnectPin, 828b780)을 그대로 부른다. */
    showReturnSheet(w) {
      const pin = (w && w.pinId != null && typeof State !== "undefined") ? (State.pins || []).find((p) => String(p.id) === String(w.pinId)) : null;
      return this._sheet({
        id: "theta-return-sheet",
        title: "THETA에서 찍은 사진 등록",
        body: pin ? ("포인트 " + (pin.label || "") + " 에 가장 최근 360 사진을 등록합니다.") : "사진을 고르면 가장 최근 360 사진부터 어디에 등록할지 묻습니다.",
        actions: [
          { label: "사진 선택", primary: true, run: () => {
            if (pin && typeof PhotoBatch !== "undefined" && PhotoBatch.autoConnectPin) { PhotoBatch.autoConnectPin(pin); return; }
            this._pickFiles((files) => this.receive(files, { source: "return" }));
          } },
          { label: "닫기", run: () => {} }
        ]
      });
    },
    _pickFiles(cb) {
      const inp = document.createElement("input");
      inp.type = "file"; inp.accept = "image/*"; inp.multiple = true; inp.style.display = "none";
      inp.addEventListener("change", () => { const f = Array.from(inp.files || []); try { inp.remove(); } catch (e) {} if (f.length) cb(f); });
      document.body.appendChild(inp);
      inp.click();
    },
    /** 앱 열기 버튼(공유 생성기) — 모바일 도크(360 모드)와 핀 사진 시트(#pap-reg-mobile-hint 아래)에 같은 버튼. */
    makeAppButton(cls, pinIdFn) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = cls + " theta-app-btn";
      const why = this.appDisabledReason();
      b.innerHTML = '<span class="theta-app-label"><span aria-hidden="true">📷</span> ' + THETA_APP.LABEL + '</span><span class="theta-app-hint">' + (why || THETA_APP.HINT) + '</span>';
      b.title = why ? (THETA_APP.LABEL + " — " + why) : (THETA_APP.LABEL + " — " + THETA_APP.HINT);
      if (why) b.setAttribute("aria-disabled", "true");
      b.addEventListener("click", (e) => {
        if (e && e.stopPropagation) e.stopPropagation();
        if (why) { this._toast(why); return; }
        this.openApp({ pinId: pinIdFn ? pinIdFn() : null });
      });
      return b;
    },
    mountAppButtons() {
      const bar = document.querySelector ? document.querySelector("#mobile-dock .mdock-bar") : null;
      if (bar && !document.getElementById("mdock-theta-app")) {
        const b = this.makeAppButton("mdock-chip mdock-theta", null);
        b.id = "mdock-theta-app";
        const more = document.getElementById("mdock-more-toggle");
        if (more && more.parentNode === bar) bar.insertBefore(b, more); else bar.appendChild(b);
      }
      const hint = document.getElementById("pap-reg-mobile-hint");
      if (hint && hint.parentNode && !document.getElementById("pap-theta-app")) {
        const b = this.makeAppButton("pap-theta-app", () => (typeof PinActionPop !== "undefined" ? PinActionPop._pinId : null));
        b.id = "pap-theta-app";
        hint.parentNode.insertBefore(b, hint.nextSibling);
      }
      this.syncAppButtons();
    },
    /** 360 모드(디자이너)에서 도크에 표시 — 렌더 지점 SoT = App._syncRegModeButtons 가 모드 전환마다 부른다. */
    syncAppButtons() {
      const d = document.getElementById("mdock-theta-app");
      const on = typeof State !== "undefined" && State.mode === "designer" && State.regMode === "photo";
      if (d && d.classList) d.classList.toggle("hidden", !on);
    },

    /* ── [WO 20261002-allmenu §8] THETA → SEASTAR: "어디에 등록?" → 포인트 탭 → 등록 ───────────
       🔴 "두 앱이 다 실행 중일 때만" — 자동 흐름은 isLive()(편집 화면 + 프로젝트 + 열린 도면)일 때만 시작한다.
       아니면 사진을 받은 사진 트레이(_pending, IndexedDB 영속)에 보관하고 안내만 한다(조용히 버리지 않는다).
       받은 사진은 흐름 시작 전 항상 먼저 트레이에 영속한다 — 창이 바뀌거나 닫혀도 유실 0. */
    isLive() {
      if (typeof State === "undefined" || State.mode !== "designer" || !State.fileType) return false;
      return !!(typeof Projects !== "undefined" && Projects.currentProject);
    },
    async receive(files, opts) {
      const ids = await this.importFiles(files, { lenient: true, silent: true });
      if (!ids.length) { this._toast("받은 사진 중 360 사진이 없습니다"); return { started: false, stored: 0 }; }
      if (!this.isLive()) {
        this.showTray();
        this._toast("받은 360 사진 " + ids.length + "장을 보관했습니다 — 도면을 연 뒤 [받은 사진 등록]으로 등록하세요", 5200);
        return { started: false, stored: ids.length };
      }
      this.hideTray();
      await this.startFlow(ids);
      return { started: true, stored: ids.length };
    },
    /** 보관된(트레이) 사진으로 흐름 시작 — 전체 기능 메뉴 [받은 사진 등록] 의 진입점. */
    async startFromPending() {
      if (!this._pending.length) { this._toast("받은 사진이 없습니다"); return false; }
      if (!this.isLive()) { this._toast("도면을 먼저 연 뒤 등록하세요(편집 화면)"); this.showTray(); return false; }
      await this.startFlow(this._pending.map((p) => p.id));
      return true;
    },
    /** ids(트레이 항목) → 촬영시각 최신순(PhotoBatch.buildAutoRows/recentFirst360 정본)으로 한 장씩. */
    async startFlow(ids) {
      const items = ids.map((id) => this._pending.find((p) => p.id === id)).filter(Boolean);
      const files = items.map((it) => { const f = this._dataURLtoFile(it.dataURL, it.name); if (f) f._tiId = it.id; return f; }).filter(Boolean);
      let rows = (typeof PhotoBatch !== "undefined" && PhotoBatch.buildAutoRows) ? await PhotoBatch.buildAutoRows(files) : files.map((f) => ({ file: f, name: f.name, is360: true }));
      rows.forEach((r) => { r.tiId = r.file && r.file._tiId; if (r.is360 == null) r.is360 = true; });
      rows = (typeof PhotoBatch !== "undefined" && PhotoBatch.recentFirst360) ? PhotoBatch.recentFirst360(rows) : rows;
      this._flow = { queue: rows, total: rows.length };
      return this._flowNext();
    },
    _flowNext() {
      const fl = this._flow;
      if (!fl || !fl.queue.length) { this._flow = null; this._endTap(); this.renderTray(); if (this._pending.length) this.showTray(); return null; }
      const row = fl.queue[0];
      return this.showWhereSheet(row, fl.queue.length);
    },
    cancelFlow() {
      this._flow = null; this._endTap(); this._closeSheet();
      this.renderTray(); if (this._pending.length) this.showTray();
      this._toast("등록을 취소했습니다 — 받은 사진은 트레이에 남아 있습니다");
    },
    showWhereSheet(row, remaining) {
      const deck = (typeof Projects !== "undefined" && Projects.currentDeck) || null;
      const here = deck ? (deck.name || "(이름 없음)") : "지금 열린 도면";
      const when = row.timeLabel ? row.timeLabel : (row.exif && row.exif.date ? String(row.exif.date) : "촬영시각 정보 없음");
      return this._sheet({
        id: "theta-where-sheet",
        title: "어디에 등록할까요?" + (remaining > 1 ? " (남은 " + remaining + "장)" : ""),
        thumb: row.file,
        body: row.name + " · " + when,
        actions: [
          { label: "현재 구역·영역에 등록 — " + here, primary: true, run: () => this._awaitTap(row) },
          { label: "다른 구역 선택", run: () => this._pickDeck(row) },
          { label: "취소", run: () => this.cancelFlow() }
        ]
      });
    },
    _pickDeck(row) {
      const decks = (typeof Projects !== "undefined" && Projects.decks) || [];
      const acts = decks.map((d) => ({ label: (d.parent_id ? "영역 · " : "구역 · ") + (d.name || "(이름 없음)"), run: async () => {
        if (Projects.selectDeck) await Projects.selectDeck(d);
        this._awaitTap(row);
      } }));
      acts.push({ label: "뒤로", run: () => this.showWhereSheet(row, (this._flow && this._flow.queue.length) || 1) });
      return this._sheet({ id: "theta-where-sheet", title: "등록할 구역·영역", body: decks.length ? "" : "구역이 없습니다 — 지금 열린 도면에 등록하세요", actions: acts });
    },
    /** "등록할 포인트를 탭하세요" — 지도 클릭 1회를 캡처 단계에서 가로챈다(UI._startAlign 과 같은 방식, 기존 클릭 처리 무간섭).
     *  기존 핀 탭 = 그 핀에 등록(이미 사진 있으면 이력 적립 — PhotoNaming.pushHistory 경로) · 빈 곳 = 360 핀 생성 후 등록. */
    _awaitTap(row) {
      this._closeSheet();
      this._endTap();
      if (typeof State !== "undefined" && State.regMode !== "photo" && typeof App !== "undefined" && App._setRegMode) App._setRegMode("photo");
      const vp = document.getElementById("map-viewport");
      if (!vp) { this._toast("도면이 열려 있지 않습니다"); return; }
      const banner = document.createElement("div");
      banner.id = "theta-tap-banner";
      banner.className = "theta-tap-banner";
      banner.setAttribute("role", "status");
      banner.innerHTML = '<span class="theta-tap-text">등록할 포인트를 탭하세요 — 기존 포인트 = 사진 이력에 추가 · 빈 곳 = 새 360 포인트</span>';
      const cancel = document.createElement("button");
      cancel.type = "button"; cancel.className = "theta-tap-cancel"; cancel.textContent = "취소";
      cancel.addEventListener("click", (e) => { if (e && e.stopPropagation) e.stopPropagation(); this.cancelFlow(); });
      banner.appendChild(cancel);
      document.body.appendChild(banner);
      const onClick = (e) => {
        if (e.stopPropagation) e.stopPropagation();
        if (e.preventDefault) e.preventDefault();
        this._tapAt(e.clientX, e.clientY, e.target);
      };
      vp.addEventListener("click", onClick, true);
      this._tap = { vp, onClick, banner, row };
    },
    /** 탭 1회 처리(SoT) — 클릭 캡처(데스크톱)와 배치 터치(App._handlePlaceClick → takeTap, 모바일)가 공유. */
    _tapAt(clientX, clientY, target) {
      const t = this._tap;
      if (!t) return false;
      const hit = target && target.closest ? target.closest("[data-id]") : null;
      let pin = hit ? (State.pins || []).find((p) => String(p.id) === String(hit.dataset ? hit.dataset.id : hit.getAttribute("data-id"))) : null;
      if (!pin) {
        const pct = (typeof MapCtrl !== "undefined" && MapCtrl.viewportToPercent) ? MapCtrl.viewportToPercent(clientX, clientY) : null;
        if (!pct) return true;
        pin = (typeof App !== "undefined" && App._placeCheckboardPin) ? App._placeCheckboardPin(pct) : null;
        if (!pin) return true;   // 대역 가득 등 — App 이 이미 알렸다
      }
      this._endTap();
      this._register(pin, t.row);
      return true;
    },
    /** 🔴 [WO 20261010-offmatrix] 모바일 근본원인(실 Chrome CDP 재현 p146): "등록할 포인트를 탭하세요" 대기 중에도
     *  _awaitTap 이 켠 360 모드가 배치를 자동 시작해, 배치 터치(App._placeTouchStart 의 preventDefault)가 합성 click 을
     *  없앴다 → 위 클릭 캡처는 영영 안 불리고 배치가 새 핀 + 다른 사진 선택창을 열었다(현장 촬영 사진 등록 0건, 조용한 실패).
     *  배치 진입점(App._handlePlaceClick — 터치·클릭 공유)이 먼저 여기에 묻는다. 대기 중이 아니면 false. */
    takeTap(e) {
      if (!this._tap || !e) return false;
      const target = (typeof document !== "undefined" && document.elementFromPoint) ? document.elementFromPoint(e.clientX, e.clientY) : null;
      return this._tapAt(e.clientX, e.clientY, target);
    },
    _endTap() {
      const t = this._tap;
      if (!t) return;
      this._tap = null;
      try { t.vp.removeEventListener("click", t.onClick, true); } catch (e) {}
      if (t.banner && t.banner.parentNode) t.banner.parentNode.removeChild(t.banner);
    },
    /** 등록 = PhotoBatch._uploadOneRow(정본: 온라인 업로드 / 오프라인 SyncQueue · 덮어쓰기 전 이력 적립). */
    async _register(pin, row) {
      if (typeof PhotoBatch === "undefined" || !PhotoBatch._uploadOneRow) { this._toast("사진 등록 모듈이 없습니다"); return null; }
      const used = PhotoBatch._usedPhotoNames ? PhotoBatch._usedPhotoNames() : new Set();
      const r = await PhotoBatch._uploadOneRow(pin, row, true, used, "THETA");
      if (r.status === "done") {
        if (row.tiId) { this._pending = this._pending.filter((p) => p.id !== row.tiId); await this._persist(); }
        try { UI.renderPinList(); UI.renderPinsOnMap(); } catch (e) {}
        try { if (PhotoBatch._markUnsaved) PhotoBatch._markUnsaved(); } catch (e) {}
        this._toast("포인트 " + (pin.label || "") + " ← " + row.name + " 등록" + (r.offline ? " (오프라인 저장됨 — 연결되면 동기화)" : ""));
      } else {
        this._toast("등록 실패: " + (r.reason || "알 수 없음") + " — 사진은 트레이에 남아 있습니다");
      }
      // [WO 20261008-fieldcap] 🔴 선택적 훅(새 상태 0) — 44_FieldCapture 가 단일 사진 등록 뒤
      //   "다음 사진" 시트를 띄우는 데 쓴다. row.onDone 이 없으면(기존 THETA 흐름) 동작 변화 0.
      if (typeof row.onDone === "function") { try { row.onDone(r); } catch (e) {} }
      if (this._flow) this._flow.queue.shift();
      this._flowNext();
      return r;
    },
    /** 하단 시트(공유 생성기) — 버튼 ≥40px, 고정 색쌍(CSS .theta-sheet*).
     *  action.disabled = 누를 수 없음(사유는 action.hint, 숨기지 않는다) · action.hint = 보조 1줄. */
    _sheet(spec) {
      this._closeSheet();
      const s = document.createElement("div");
      s.id = spec.id;
      s.className = "theta-sheet";
      s.setAttribute("role", "dialog");
      s.setAttribute("aria-label", spec.title);
      const h = document.createElement("div"); h.className = "theta-sheet-title"; h.textContent = spec.title; s.appendChild(h);
      if (spec.thumb) {
        try { const im = document.createElement("img"); im.className = "theta-sheet-thumb"; im.alt = ""; im.src = URL.createObjectURL(spec.thumb); s.appendChild(im); } catch (e) {}
      }
      if (spec.body) { const p = document.createElement("div"); p.className = "theta-sheet-body"; p.textContent = spec.body; s.appendChild(p); }
      (spec.actions || []).forEach((a) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "theta-sheet-btn" + (a.primary ? " primary" : "") + (a.disabled ? " is-disabled" : "");
        // 🔴 기존 호환 — b.textContent = a.label 그대로(기존 호출부가 버튼을 .textContent 로 찾는다).
        //   hint 는 별도 자식 span 으로만 덧붙인다(innerHTML 치환 금지 — 기존 동작 변화 0).
        b.textContent = a.label;
        if (a.hint) {
          const hintEl = document.createElement("span");
          hintEl.className = "theta-sheet-btn-hint";
          hintEl.textContent = a.hint;
          b.appendChild(hintEl);
        }
        if (a.disabled) b.setAttribute("aria-disabled", "true");
        b.addEventListener("click", (e) => {
          if (e && e.stopPropagation) e.stopPropagation();
          if (a.disabled) { this._toast(a.hint || (a.label + " — 사용할 수 없습니다")); return; }
          this._closeSheet(); a.run && a.run();
        });
        s.appendChild(b);
      });
      document.body.appendChild(s);
      this._sheetEl = s;
      return s;
    },
    _closeSheet() { const s = this._sheetEl; this._sheetEl = null; if (s && s.parentNode) s.parentNode.removeChild(s); },
    _toast(m, ms) { try { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast(m, ms); } catch (e) {} },

    /** Web Share Target 으로 들어온 사진을 캐시에서 읽어 자동 인입(트리거). */
    async handleShared() {
      // [견고화] ?shared=1 을 URL 에서 제거(항상) → 리로드/controllerchange 시 재실행·재인입 방지.
      try {
        const u = new URL(location.href);
        if (u.searchParams.has("shared")) { u.searchParams.delete("shared"); history.replaceState(null, "", u.pathname + u.search + u.hash); }
      } catch (e) {}
      try {
        if (!("caches" in window)) return;
        const cache = await caches.open("wm-shared");
        const idxRes = await cache.match("/__shared__/index");
        if (!idxRes) return;
        const meta = await idxRes.json();
        const ids = meta.ids || [], names = meta.names || [];
        const files = [];
        for (let i = 0; i < ids.length; i++) {
          const r = await cache.match(ids[i]);
          if (r) { const blob = await r.blob(); files.push(new File([blob], names[i] || ("shared-" + i + ".jpg"), { type: blob.type || "image/jpeg" })); }
        }
        for (const id of ids) { try { await cache.delete(id); } catch (e) {} }
        try { await cache.delete("/__shared__/index"); } catch (e) {}
        if (files.length) {
          // 공유=명시적 의도 → R* 아니어도 360이면 인입. [WO 20261002-allmenu §8] 열린 도면이 있으면(isLive)
          //   "어디에 등록?" 흐름, 아니면 보관 + 안내(receive 가 판정 — 앱 새로 띄운 부팅 직후는 도면이 없어 보관만).
          await this.receive(files, { source: "share" });
        }
      } catch (e) {}
    },

    openPicker() {
      if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("THETA로 찍은 R* 360 사진을 선택하세요 (여러 장 가능)");
      const inp = document.getElementById("input-theta-intake");
      if (inp) inp.click();
    },

    _isR(name) { return /^r/i.test((name || "").trim()); },

    /** 2:1 equirectangular(THETA 360) 여부 — 실제 픽셀 비율 검사 */
    _is360(file) {
      return new Promise((resolve) => {
        try {
          const url = URL.createObjectURL(file);
          const im = new Image();
          im.onload = () => { const r = im.naturalWidth / Math.max(1, im.naturalHeight); URL.revokeObjectURL(url); resolve(r >= 1.8 && r <= 2.2); };
          im.onerror = () => { URL.revokeObjectURL(url); resolve(false); };
          im.src = url;
        } catch (e) { resolve(false); }
      });
    },

    _toDataURL(file) {
      return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = () => reject(fr.error || new Error("read fail"));
        fr.readAsDataURL(file);
      });
    },

    _dataURLtoFile(dataURL, name) {
      try {
        const arr = String(dataURL).split(",");
        const mime = (arr[0].match(/:(.*?);/) || [])[1] || "image/jpeg";
        const bstr = atob(arr[1]); let n = bstr.length; const u8 = new Uint8Array(n);
        while (n--) u8[n] = bstr.charCodeAt(n);
        return new File([u8], name || "theta_360.jpg", { type: mime });
      } catch (e) { return null; }
    },

    /** @returns {Promise<string[]>} 이번에 트레이에 들어간 항목 id 들. opts.silent = 트레이 표시·토스트 생략(호출부가 안내). */
    async importFiles(files, opts) {
      if (!files || !files.length) return [];
      const lenient = !!(opts && opts.lenient);   // 공유로 들어온 경우: R* 아니어도 360이면 인입
      const silent = !!(opts && opts.silent);
      let accepted = 0, skipped = 0;
      const ids = [];
      for (const f of files) {
        if (!f.type || !f.type.startsWith("image/")) { skipped++; continue; }
        if (!lenient && !this._isR(f.name)) { skipped++; continue; }     // R* 파일명만 (버튼 인입)
        const ok360 = await this._is360(f);
        if (!ok360) { skipped++; continue; }                 // THETA equirectangular(2:1)만
        try {
          const dataURL = await this._toDataURL(f);
          const id = "ti_" + Date.now() + "_" + accepted;
          this._pending.push({ id, name: f.name, dataURL: dataURL });
          ids.push(id);
          accepted++;
        } catch (e) { skipped++; }
      }
      await this._persist();
      this.renderTray();
      if (silent) return ids;
      this.showTray();
      if (typeof Prompt !== "undefined" && Prompt.toast)
        Prompt.toast("360 인입 " + accepted + "장" + (skipped ? " · 제외 " + skipped + "장(R*/360 아님)" : "") + (accepted ? " — 사진을 눌러 도면에 위치를 지정하세요" : ""));
      return ids;
    },

    renderTray() {
      const list = document.getElementById("theta-tray-list");
      const cnt = document.getElementById("theta-tray-count");
      if (cnt) cnt.textContent = this._pending.length;
      if (!list) return;
      if (!this._pending.length) { list.innerHTML = '<div class="theta-tray-empty">미배치 360 사진이 없습니다.</div>'; return; }
      const esc = (s) => (typeof UI !== "undefined" && UI.escapeHtml) ? UI.escapeHtml(s) : s;
      list.innerHTML = this._pending.map((p) =>
        '<div class="theta-item" data-id="' + p.id + '">' +
          '<img class="theta-thumb" src="' + p.dataURL + '" alt="" />' +
          '<div class="theta-item-name" title="' + esc(p.name) + '">' + esc(p.name) + '</div>' +
          '<button class="theta-item-assign" type="button">위치 지정 ›</button>' +
        '</div>'
      ).join("");
      list.querySelectorAll(".theta-item").forEach((el) => {
        const id = el.dataset.id;
        const go = () => this.assign(id);
        const ab = el.querySelector(".theta-item-assign"); if (ab) ab.addEventListener("click", go);
        const th = el.querySelector(".theta-thumb"); if (th) th.addEventListener("click", go);
      });
    },
    showTray() { const t = document.getElementById("theta-tray"); if (t && this._pending.length) t.classList.remove("hidden"); },
    hideTray() { const t = document.getElementById("theta-tray"); if (t) t.classList.add("hidden"); },

    /** 사진 선택 → 배치 모드 진입(도면에서 위치 탭 대기). 도면 탭은 App._handlePlaceClick 가 처리. */
    assign(id) {
      const item = this._pending.find((p) => p.id === id) || this._pending[0];
      if (!item) return;
      if (typeof App === "undefined" || !App._handlePlaceClick) { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("도면을 먼저 연 뒤 다시 시도하세요"); return; }
      const file = this._dataURLtoFile(item.dataURL, item.name);
      if (!file) { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("사진을 읽지 못했습니다"); return; }
      this._activeId = item.id;
      State.intakeFile = file;
      this.hideTray();
      if (!State.placing) App._togglePlacing();   // 배치 모드 ON (도면 탭 대기)
      if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("'" + item.name + "' — 도면에서 이 사진의 위치를 탭하세요");
    },

    /** App._handlePlaceClick 에서 인입 사진을 핀에 주입·등록한 직후 호출 — 트레이에서 제거·진행 */
    _afterPlaced() {
      const id = this._activeId; this._activeId = null;
      if (id) this._pending = this._pending.filter((p) => p.id !== id);
      this._persist();
      this.renderTray();
      if (this._pending.length) {
        this.showTray();
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("등록 — 남은 360 인입 " + this._pending.length + "장. 계속 지정하세요");
      } else {
        this.hideTray();
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("360 인입 사진 위치 등록 완료" + (navigator.onLine ? "" : " — 온라인 시 '↑ 지금 올리기'로 반영"));
      }
    },

    async _persist() {
      try { if (typeof SyncQueue !== "undefined" && SyncQueue.saveDraft) await SyncQueue.saveDraft(this._KEY, this._pending); } catch (e) {}
    },
    async _restore() {
      try {
        if (typeof SyncQueue === "undefined" || !SyncQueue.loadDraft) return;
        const d = await SyncQueue.loadDraft(this._KEY);
        if (d && Array.isArray(d) && d.length) { this._pending = d; this.renderTray(); this.showTray(); }
      } catch (e) {}
    },
  };
