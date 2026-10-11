  const UI = {
    $:  id  => document.getElementById(id),

    show(id)  { this.$(id).classList.remove("hidden"); },
    hide(id)  { this.$(id).classList.add("hidden");    },
    toggle(id, force) {
      const el = this.$(id);
      if (force === undefined) el.classList.toggle("hidden");
      else force ? el.classList.remove("hidden") : el.classList.add("hidden");
    },
    text(id, val)  { const el = this.$(id); if (el) el.textContent = val; },
    val(id)        { return this.$(id).value; },
    clearVal(id)   { this.$(id).value = ""; },
    enable(id)     { this.$(id).disabled = false; },
    disable(id)    { this.$(id).disabled = true; },

    /** [WO 20261011-viewmode] 모드별 열람 링크 — data-vmode="checker"|"360" 를 단 요소를 모드에 안 맞으면 숨긴다.
     *  🔴 보조 방어일 뿐이다 — 데이터(핀) 필터는 서버(mapDeploymentFor)가 이미 한다(화면만 숨기면 데이터가
     *  그대로 내려가는 결함을 반복하지 않는다). mode=null(둘다·비링크)이면 전부 보인다. */
    applyViewMode(mode) {
      try {
        document.querySelectorAll("[data-vmode]").forEach((el) => {
          const want = el.getAttribute("data-vmode");
          const show = !mode || want === mode;
          el.classList.toggle("hidden", !show);
        });
      } catch (e) {}
    },

    showScreen(name) {
      // [지휘자 2026-10-08 재현] 화면 전환 = 모든 라우트 변경의 공유 지점 — 열린 Prompt 모달을
      // 여기 한 곳에서 취소로 닫는다(다른 화면/프로젝트까지 떠 있던 결함, §G-2-5 공유 함수 1곳).
      if (typeof Prompt !== "undefined" && Prompt.closeAll) Prompt.closeAll();
      document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
      this.$(name).classList.add("active");
    },

    escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, c =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    },

    /** [WO 20261008-layout] 사이드바 폭 조절(드래그)+접기/펼치기. 데스크톱(≥761px)에서만
     *  동작 — 모바일은 .sidebar{width:100%!important}(style.css:3988)가 인라인 width 를 항상
     *  이기므로 가드 없이도 안전하지만, 드래그 리스너 자체는 모바일에서 불필요해 데스크톱일 때만
     *  건다. 폭/접힘 상태는 localStorage(try/catch, §공통 작업 규율 준수 — 환경값 없으면
     *  조용히 기본값으로). 호출부: 99_footer.js DOMContentLoaded(다른 모듈 init 과 동일 패턴). */
    initSidebarResize() {
      try {
        const sidebar = this.$("sidebar");
        const resizer = this.$("sidebar-resizer");
        const collapseBtn = this.$("btn-sidebar-collapse");
        if (!sidebar) return;
        const MIN_W = 200, MAX_W = 480, DEFAULT_W = 300, COLLAPSED_W = 46;
        const LS_W = "sidebar-w", LS_C = "sidebar-collapsed";
        const isDesktop = () => window.matchMedia("(min-width: 761px)").matches;

        const loadWidth = () => {
          try {
            const v = parseInt(localStorage.getItem(LS_W), 10);
            return (v >= MIN_W && v <= MAX_W) ? v : DEFAULT_W;
          } catch (e) { return DEFAULT_W; }
        };
        const saveWidth = (w) => { try { localStorage.setItem(LS_W, String(w)); } catch (e) {} };
        const loadCollapsed = () => { try { return localStorage.getItem(LS_C) === "1"; } catch (e) { return false; } };
        const saveCollapsed = (c) => { try { localStorage.setItem(LS_C, c ? "1" : "0"); } catch (e) {} };

        let savedWidth = loadWidth();
        const collapsed0 = loadCollapsed();
        if (isDesktop()) {
          sidebar.classList.toggle("collapsed", collapsed0);
          if (!collapsed0) sidebar.style.width = savedWidth + "px";
        }
        if (collapseBtn) collapseBtn.setAttribute("aria-expanded", collapsed0 ? "false" : "true");

        if (collapseBtn) {
          collapseBtn.addEventListener("click", () => {
            const nowCollapsed = sidebar.classList.toggle("collapsed");
            saveCollapsed(nowCollapsed);
            collapseBtn.setAttribute("aria-expanded", nowCollapsed ? "false" : "true");
            if (!nowCollapsed) sidebar.style.width = loadWidth() + "px";
          });
        }

        if (!resizer) return;
        let dragging = false, startX = 0, startW = DEFAULT_W;
        const applyW = (w) => { sidebar.style.width = Math.max(MIN_W, Math.min(MAX_W, w)) + "px"; };
        const beginDrag = (clientX) => {
          if (!isDesktop() || sidebar.classList.contains("collapsed")) return;
          dragging = true; startX = clientX; startW = sidebar.getBoundingClientRect().width;
          document.body.classList.add("sidebar-resizing");
        };
        const moveDrag = (clientX) => { if (dragging) applyW(startW + (clientX - startX)); };
        const endDrag = () => {
          if (!dragging) return;
          dragging = false;
          document.body.classList.remove("sidebar-resizing");
          saveWidth(Math.round(sidebar.getBoundingClientRect().width));
        };
        resizer.addEventListener("mousedown", (e) => { beginDrag(e.clientX); e.preventDefault(); });
        window.addEventListener("mousemove", (e) => moveDrag(e.clientX));
        window.addEventListener("mouseup", endDrag);
        resizer.addEventListener("touchstart", (e) => { if (e.touches[0]) beginDrag(e.touches[0].clientX); }, { passive: true });
        window.addEventListener("touchmove", (e) => { if (dragging && e.touches[0]) moveDrag(e.touches[0].clientX); }, { passive: true });
        window.addEventListener("touchend", endDrag);
        resizer.addEventListener("dblclick", () => { applyW(DEFAULT_W); saveWidth(DEFAULT_W); });
        resizer.addEventListener("keydown", (e) => {
          if (!isDesktop() || sidebar.classList.contains("collapsed")) return;
          const cur = sidebar.getBoundingClientRect().width;
          if (e.key === "ArrowLeft") { applyW(cur - 10); saveWidth(Math.round(cur - 10)); }
          else if (e.key === "ArrowRight") { applyW(cur + 10); saveWidth(Math.round(cur + 10)); }
        });
      } catch (e) { /* 실패해도 기본 CSS 폭(240px)으로 정상 동작 — 조용한 실패 허용 범위(레이아웃 보조기능) */ }
    },

    /** [항목3] 포인트 목록 펼침/접힘 토글 (아이콘 헤더/닫기 버튼 공용) */
    togglePinList(force) {
      const wrap = this.$("section-pin-list");
      const toggle = this.$("pin-list-toggle");
      if (!wrap) return;
      const willOpen = (force === undefined) ? wrap.classList.contains("collapsed") : !!force;
      wrap.classList.toggle("collapsed", !willOpen);
      if (toggle) toggle.setAttribute("aria-expanded", willOpen ? "true" : "false");
    },

    /** 헤더 옆 카운트 배지 갱신 */
    _updatePinListCount(n) {
      const c = this.$("pin-list-count");
      if (!c) return;
      c.textContent = n;
      c.classList.toggle("hidden", !n);
    },

    /* ══ [WO 20261001-leader] CAD 스타일 화살표 리더선 + 번호 풍선(callout) ═══════════════════
       데이터: pin.callout = {x,y}(페이지 % 절대좌표, 선택적). 없으면 defaultCallout()이 대상
       오른쪽 위로 고정 오프셋을 계산한다(레거시 핀도 유실 0으로 정상 표시). 저장·병합은 기존
       pin 객체 LWW 경로(App._markDirty → PinSeries.stampChanged, 전체 핀 비교)를 그대로 탄다
       — callout 은 pin 의 평범한 필드라 PinSeries._sigOf(JSON.stringify)에 자동 포함된다.
       순수함수(Leader.defaultCallout/calloutOf/align)로 분리 — DOM 없이 단위테스트 가능. */
    Leader: {
      DEFAULT_DX: 7, DEFAULT_DY: -9,     // 기본 콜아웃 오프셋(%, 대상에서 오른쪽 위)
      BUBBLE_DIAM_PX: 22,                 // 풍선 화면 지름(px, 줌 무관 고정)
      SPACING_FACTOR: 1.6,                // 정렬 간격 = 풍선 지름 × 1.6(이름 있는 상수)
      /** 레거시 핀(callout 없음) 기본 위치 — 대상에서 오른쪽 위 고정 오프셋, 0~100 클램프. */
      defaultCallout(pin) {
        const px = (pin && Number.isFinite(pin.x)) ? pin.x : 0;
        const py = (pin && Number.isFinite(pin.y)) ? pin.y : 0;
        return {
          x: Math.max(0, Math.min(100, px + this.DEFAULT_DX)),
          y: Math.max(0, Math.min(100, py + this.DEFAULT_DY))
        };
      },
      /** [WO 20261008-pinstyle §1] 🔴 핀 표현 1종 SoT — 이 핀을 리더선(풍선+사선+화살촉)으로 그릴지.
       *  pin.leader === true/false 가 있으면 그 값(핀별 선택). 없으면(이행 전 레거시) "사용자가 풍선을
       *  옮긴 기록" = 저장된 callout 이 있을 때만 true. 근거: callout 을 저장하는 곳은 이 파일의 정렬
       *  (_commitAlign)·풍선 드래그 두 곳뿐이다(전 모듈 grep) — 기본 위치(defaultCallout)는 저장하지 않는다.
       *  그래서 callout 이 저장된 핀 = 사용자가 정렬·드래그로 리더선을 직접 다룬 핀. 나머지는 핀으로 표시.
       *  마이그레이션 0 — 렌더 시점 판정이라 데이터는 바뀌지 않는다(사용자가 켜고 끌 때만 pin.leader 기록). */
      wants(pin) {
        if (!pin) return false;
        if (pin.leader === true) return true;
        if (pin.leader === false) return false;
        return !!(pin.callout && Number.isFinite(pin.callout.x) && Number.isFinite(pin.callout.y));
      },
      /** [WO 20261008-pinstyle §2] 화살촉 화면 크기(풍선 지름 22px 기준 단위) — 풍선과 같은 역스케일을 받는다. */
      ARROW_LEN_PX: 9, ARROW_HALF_PX: 3.6, LINE_PX: 1.2, LINE_MIN_PX: 1,
      /** 리더 기하(순수함수) — 페이지 % 좌표계(SVG viewBox 0..100, preserveAspectRatio=none)에서
       *  x·y 축 배율이 다르므로(natW≠natH) 화살촉을 px 공간에서 계산해 각 축으로 따로 % 환산한다.
       *  inv = MapCtrl.pinScreenScale()(풍선과 같은 값) → 화살촉 화면 크기 = ARROW_LEN_PX·inv·zoom,
       *  풍선 화면 지름 = BUBBLE_DIAM_PX·inv·zoom → 두 비율이 줌과 무관하게 일정하다.
       *  @returns { d, points, strokePx } */
      geometry(pin, co, natW, natH, inv, zoom) {
        const W = natW > 0 ? natW : 1000, H = natH > 0 ? natH : 1000;
        const dir = (co.x >= pin.x) ? 1 : -1;
        const landX = co.x - dir * 2.2; // % — 풍선 바로 앞 수평 랜딩
        const d = `M ${pin.x} ${pin.y} L ${landX} ${co.y} L ${co.x} ${co.y}`;
        // 화살촉 방향 = 첫 선분(대상 → 랜딩 시작점)의 화면 방향(px 공간) — 선 끝 방향과 일치
        let vx = (landX - pin.x) * W / 100, vy = (co.y - pin.y) * H / 100;
        if (!vx && !vy) { vx = dir; vy = 0; }
        const ang = Math.atan2(vy, vx);
        const k = (inv > 0 ? inv : 1);
        const alen = this.ARROW_LEN_PX * k, awid = this.ARROW_HALF_PX * k; // 자연(px) 크기 — 부모 scale(zoom)이 곱해진다
        const tx = pin.x * W / 100, ty = pin.y * H / 100;
        const bx = tx + alen * Math.cos(ang), by = ty + alen * Math.sin(ang); // 촉은 대상, 밑변은 선 쪽
        const px = -Math.sin(ang) * awid, py = Math.cos(ang) * awid;
        const P = (x, y) => (x / W * 100) + "," + (y / H * 100);
        const points = P(tx, ty) + " " + P(bx + px, by + py) + " " + P(bx - px, by - py);
        // non-scaling-stroke 는 SVG 내부(viewBox) 배율만 상쇄하고 조상 CSS scale(zoom)은 그대로 곱해진다(1280 400% 실측:
        //   1.2·inv·zoom 으로 주면 화면 17px — zoom 이 두 번 곱해짐). 그래서 자연 px = LINE_PX·inv → 화면 = LINE_PX·inv·zoom
        //   (풍선과 같은 비율). 화면 1px 하한은 1/zoom 으로 환산.
        const z = (zoom > 0 ? zoom : 1);
        const strokePx = Math.max(this.LINE_MIN_PX / z, this.LINE_PX * k);
        return { d, points, strokePx };
      },
      /** 핀의 실제 콜아웃(저장값 우선, 없으면 기본값). */
      calloutOf(pin) {
        if (pin && pin.callout && Number.isFinite(pin.callout.x) && Number.isFinite(pin.callout.y)) {
          return { x: pin.callout.x, y: pin.callout.y };
        }
        return this.defaultCallout(pin);
      },
      /** 세로/가로 등간격 정렬 — 순수함수(DOM 無). pinsOrdered = [{id}], axis 'v'|'h'.
       *  clickX/clickY = 클릭 지점(%), stepPct = 화면기준 간격을 호출부가 줌 역보정해 넘긴 %.
       *  @returns [{id,x,y}] 번호(=배열) 순서대로 등간격 배치, 첫 항목 = 클릭 지점 그대로. */
      align(pinsOrdered, axis, clickX, clickY, stepPct) {
        return (pinsOrdered || []).map((p, i) => (
          axis === "v"
            ? { id: p.id, x: clickX, y: clickY + i * stepPct }
            : { id: p.id, x: clickX + i * stepPct, y: clickY }
        ));
      }
    },

    /* ── [WO 20260929-bulkdel] 관리자 핀 일괄삭제 — 선택 상태 SoT(트리 핀 노드 · 핀 목록 패널 공유) ──
       권한 판정 = App.canBulkDeletePins()(프로젝트 소유자·super — 서버 can_manage_members). 삭제 = App.deletePins(본인 재인증) → 단건과 같은 _removePins. */
    _pinSel: { on: false, ids: new Set() },
    _pinBulkOk() { return typeof App !== "undefined" && !!App.canBulkDeletePins && App.canBulkDeletePins(); },
    /** [WO 20261002-allmenu §2] 🔴 [선택] 모드 진입 권한 = 디자이너 이상 누구나(편집 화면 + 쓰기 가능 세션).
     *  선택은 정렬(리더선)·삭제가 공유하는 도구라, 삭제 권한(_pinBulkOk: 소유자·super)으로 선택 자체를
     *  막으면 정렬이 소유자 밖에서는 숨어 버린다(R1 근본원인). 삭제 버튼만 _pinBulkOk 로 가른다. */
    _pinSelOk() {
      return typeof State !== "undefined" && State.mode === "designer" && !(typeof Auth !== "undefined" && Auth.readonly);
    },
    /** 렌더 직전 정리 — 권한이 없으면 선택 모드 해제, 이미 사라진 핀 id 는 선택에서 제거 */
    _syncPinSel() {
      const s = this._pinSel;
      if (!this._pinSelOk()) { s.on = false; s.ids.clear(); return s; }
      const live = new Set((State.pins || []).map(p => String(p.id)));
      Array.from(s.ids).forEach(k => { if (!live.has(k)) s.ids.delete(k); });
      return s;
    },
    setPinSelectMode(on) {
      this._pinSel.on = !!on && this._pinSelOk();
      this._pinSel.ids.clear();
      this.renderPinList();
    },
    togglePinSelected(id) {
      const k = String(id), ids = this._pinSel.ids;
      if (ids.has(k)) ids.delete(k); else ids.add(k);
      this.renderPinList();
    },
    /** 일괄삭제 버튼 묶음(공유 생성기) — opts.scopePins/scopeLabel 이 있으면 "범위 전체 삭제" 버튼도 만든다. */
    _pinBulkButtons(opts) {
      opts = opts || {};
      const s = this._pinSel;
      const out = [];
      const mk = (label, cls, fn, title) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "btn-mini" + (cls ? " " + cls : "");
        b.textContent = label;
        if (title) b.title = title;
        b.addEventListener("click", (e) => { if (e && e.stopPropagation) e.stopPropagation(); fn(b); });
        return b;
      };
      const finish = (n) => { if (n > 0) { s.on = false; s.ids.clear(); this.renderPinList(); } };
      const canDel = this._pinBulkOk();
      out.push(mk(s.on ? "선택 종료" : "선택", "pin-bulk-toggle", () => this.setPinSelectMode(!s.on), "여러 포인트를 골라 풍선 정렬(디자이너) 또는 한꺼번에 삭제(프로젝트 소유자·슈퍼관리자, 본인 확인 필요)"));
      if (s.on) {
        const n = s.ids.size;
        const del = mk("선택 삭제 " + n + "개", "danger pin-bulk-del", async () => {
          finish(await App.deletePins(Array.from(s.ids)));
        });
        // [WO 20261002-allmenu §2] 🔴 숨김 금지 — 소유자·super 가 아니면 비활성 + 사유(title/aria).
        del.disabled = n === 0 || !canDel;
        if (!canDel) { del.title = "소유자·관리자 전용 — 프로젝트 소유자·슈퍼관리자만 일괄 삭제할 수 있습니다"; del.setAttribute("aria-disabled", "true"); }
        out.push(del);
      }
      const scope = Array.isArray(opts.scopePins) ? opts.scopePins : null;
      if (canDel && scope && scope.length) {
        out.push(mk((opts.scopeLabel || "이 구역") + " 핀 전체 삭제 (" + scope.length + ")", "danger pin-bulk-scope", async () => {
          finish(await App.deletePins(scope.map(p => p.id), { scopeLabel: opts.scopeLabel || "이 구역" }));
        }));
      }
      // [WO 20261001-leader §5] 마스터 2차 지시 — 리더선 풍선 정렬. 같은 선택 UI 재사용.
      if (s.on) {
        out.push(mk("정렬 ↕", "pin-align-v", () => this._startAlign("v"), "선택한 포인트의 풍선을 세로 등간격으로 정렬"));
        out.push(mk("정렬 ↔", "pin-align-h", () => this._startAlign("h"), "선택한 포인트의 풍선을 가로 등간격으로 정렬"));
      }
      return out;
    },

    /* ── [WO 20261002-allmenu §2] 🔴 리더선 정렬 상시 노출 — CHECKER 툴바(데스크톱 #pdf-toolbar ·
       모바일 도크 .mdock-bar)에 [정렬 ↕][정렬 ↔] 를 항상 둔다. R1 근본원인: 정렬 버튼이 트리 핀 목록의
       [선택] 모드(소유자·super 전용) 안에서만 생성됐다. 새 정렬 로직 0 — 같은 _startAlign 을 부른다
       (선택 0 → _alignCandidatePins 가 현재 구역·영역의 CHECKER 핀 전체). 표시 SoT = syncCheckerAlignTools
       (App._syncRegModeButtons 가 모드 전환마다 부른다). */
    ALIGN_TOOLS: [
      { axis: "v", label: "정렬 ↕", title: "리더선 풍선 세로 정렬 — 선택한 리더선 포인트(없으면 이 구역·영역의 리더선 포인트 전체)를 클릭 위치 기준 등간격으로" },
      { axis: "h", label: "정렬 ↔", title: "리더선 풍선 가로 정렬 — 선택한 리더선 포인트(없으면 이 구역·영역의 리더선 포인트 전체)를 클릭 위치 기준 등간격으로" }
    ],
    ALIGN_NO_LEADER_MSG: "리더선 핀이 없습니다 — 핀 우클릭 > 리더선으로 표시",
    mountCheckerAlignTools() {
      if (typeof document === "undefined") return;
      const mkBtn = (t, cls) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = cls + " checker-align-btn";
        b.dataset.alignAxis = t.axis;
        b.title = t.title;
        b.setAttribute("aria-label", t.title);
        b.innerHTML = '<span class="checker-align-label">' + this.escapeHtml(t.label) + '</span>';
        b.addEventListener("click", (e) => { if (e && e.stopPropagation) e.stopPropagation(); this._startAlign(t.axis); });
        return b;
      };
      const tb = this.$("pdf-toolbar");
      if (tb && !this.$("checker-align-tools")) {
        const grp = document.createElement("span");
        grp.id = "checker-align-tools";
        grp.className = "checker-align-tools hidden";
        grp.setAttribute("role", "group");
        grp.setAttribute("aria-label", "리더선 정렬");
        const sep = document.createElement("span"); sep.className = "tb-sep";
        grp.appendChild(sep);
        this.ALIGN_TOOLS.forEach((t) => grp.appendChild(mkBtn(t, "tb-btn tb-btn-wide")));
        tb.appendChild(grp);
      }
      const bar = document.querySelector ? document.querySelector("#mobile-dock .mdock-bar") : null;
      if (bar && !this.$("mdock-align-v")) {
        const more = this.$("mdock-more-toggle");
        this.ALIGN_TOOLS.forEach((t) => {
          const b = mkBtn(t, "mdock-chip mdock-align hidden");
          b.id = "mdock-align-" + t.axis;
          if (more && more.parentNode === bar) bar.insertBefore(b, more); else bar.appendChild(b);
        });
      }
      this.syncCheckerAlignTools();
    },
    /** CHECKER 모드(디자이너 편집 화면)일 때 툴바에 보인다(전체 기능 메뉴에는 모드와 무관하게 항상 있다 —
     *  다른 모드에서 누르면 CHECKER 로 전환 후 실행). */
    syncCheckerAlignTools() {
      const on = typeof State !== "undefined" && State.mode === "designer" && State.regMode === "checkboard";
      [this.$("checker-align-tools"), this.$("mdock-align-v"), this.$("mdock-align-h")]
        .forEach((el) => { if (el && el.classList) el.classList.toggle("hidden", !on); });
    },

    /** 정렬 대기중 핀 집합(선택 없으면 현재 구역·영역·페이지의 활성 모드 핀 전체), 번호순 정렬.
     *  [WO 20261002-allmenu §2] 창(crop) 구역·영역을 보고 있으면 그 창 안의 핀만 — 같은 도면을 공유하는
     *  다른 구역의 핀까지 끌려오지 않게 한다(판정 = 지금 보는 deck 의 crop, 페이지 % 상자). */
    /** [WO 20261008-pinstyle §1] 정렬 대상 = 범위(_alignScopePins) 중 리더선 핀만 — 핀 표현 핀은 풍선이 없다. */
    _alignCandidatePins() {
      return this._alignScopePins().filter((p) => this.Leader.wants(p));
    },
    _alignScopePins() {
      const s = this._pinSel;
      const curPage = State.pdfPage || 1;
      const curSeries = (State.regMode === "checkboard") ? "checkboard" : "content";
      let pins;
      if (s.ids.size) {
        pins = Array.from(s.ids).map(k => (State.pins || []).find(p => p && String(p.id) === k)).filter(Boolean);
      } else {
        const deck = (typeof Projects !== "undefined" && Projects.currentDeck) || null;
        const c = (deck && deck.crop && deck.crop.w > 0 && deck.crop.h > 0
          && String(deck.deployment_id || "") === String(State.currentDeploymentId || "")) ? deck.crop : null;
        const inCrop = (p) => !c || (p.x >= c.x && p.x <= c.x + c.w && p.y >= c.y && p.y <= c.y + c.h);
        pins = (State.pins || []).filter(p => p && (p.page || 1) === curPage
          && (typeof PinSeries === "undefined" || PinSeries.seriesOf(p) === curSeries) && inCrop(p));
      }
      const numMap = (typeof PinSeries !== "undefined") ? PinSeries.numbers(State.pins, curPage) : new Map();
      pins.sort((a, b) => ((numMap.get(a.id) || {}).no || 0) - ((numMap.get(b.id) || {}).no || 0));
      return pins;
    },

    /** 정렬 흐름 시작 — "도면에서 정렬할 위치를 클릭" 안내 후, 도면 클릭 1회를 캡처한다.
     *  캡처 단계(capture:true)+stopPropagation 으로 20_App.js 의 기존 클릭 핸들러(배치/핀탭 등)에
     *  영향을 주지 않는다(공유 파일 미수정). Esc 취소. */
    _startAlign(axis) {
      const pins = this._alignCandidatePins();
      if (!pins.length) { Prompt.toast(this.ALIGN_NO_LEADER_MSG, 5000); return; }
      if (pins.length < 2) { Prompt.toast("정렬할 리더선 포인트가 2개 이상 필요합니다"); return; }
      this._cancelAlign(); // 중복 대기 방지
      const vp = this.$("map-viewport") || this.$("map-transform");
      if (!vp) return;
      Prompt.toast("도면에서 정렬할 위치를 클릭하세요 (Esc=취소)", 5000);
      const onClick = (e) => {
        e.stopPropagation();
        if (e.preventDefault) e.preventDefault();
        this._endAlignCapture();
        const pct = (typeof MapCtrl !== "undefined" && MapCtrl.viewportToPercent)
          ? MapCtrl.viewportToPercent(e.clientX, e.clientY) : null;
        if (pct) this._commitAlign(axis, pins, pct.x, pct.y);
      };
      const onKey = (e) => { if (e.key === "Escape") this._cancelAlign(); };
      vp.addEventListener("click", onClick, true);
      document.addEventListener("keydown", onKey);
      this._alignCapture = { vp, onClick, onKey };
    },
    _endAlignCapture() {
      const c = this._alignCapture;
      if (!c) return;
      c.vp.removeEventListener("click", c.onClick, true);
      document.removeEventListener("keydown", c.onKey);
      this._alignCapture = null;
    },
    _cancelAlign() {
      if (!this._alignCapture) return;
      this._endAlignCapture();
      Prompt.toast("정렬 취소됨");
    },
    /** 정렬 확정 — stepPct 는 화면기준 간격(풍선지름×1.6px)을 현재 줌으로 역보정해 % 환산.
     *  화살촉(대상 x,y)은 절대 건드리지 않고 callout 만 바꾼다. 되돌리기용 스냅샷 보관. */
    _commitAlign(axis, pins, clickX, clickY) {
      const transformEl = this.$("map-transform");
      const natW = (transformEl && transformEl.offsetWidth) || 1000;
      const natH = (transformEl && transformEl.offsetHeight) || 1000;
      const zoom = (State.zoom || 1);
      const spacingPx = this.Leader.BUBBLE_DIAM_PX * this.Leader.SPACING_FACTOR;
      const stepPct = axis === "v"
        ? (spacingPx / zoom) / natH * 100
        : (spacingPx / zoom) / natW * 100;
      const snapshot = pins.map(p => ({ id: p.id, callout: p.callout ? { x: p.callout.x, y: p.callout.y } : null }));
      const placed = this.Leader.align(pins.map(p => ({ id: p.id })), axis, clickX, clickY, stepPct);
      placed.forEach(r => {
        const p = (State.pins || []).find(pp => pp.id === r.id);
        if (p) p.callout = { x: Math.max(0, Math.min(100, r.x)), y: Math.max(0, Math.min(100, r.y)) };
      });
      if (typeof App !== "undefined" && App._markDirty) App._markDirty();
      this.renderPinsOnMap();
      this._lastAlignUndo = snapshot;
      Prompt.toast(pins.length + "개 풍선 정렬됨", 4000, {
        action: { label: "되돌리기", onClick: () => this.undoAlign() }
      });
    },
    /** 직전 정렬 1회 되돌리기(스냅샷 복원). 대상(x,y)은 애초에 안 건드렸으므로 복원 불필요. */
    undoAlign() {
      const snap = this._lastAlignUndo;
      if (!snap || !snap.length) return;
      snap.forEach(s => {
        const p = (State.pins || []).find(pp => pp.id === s.id);
        if (p) { if (s.callout) p.callout = s.callout; else delete p.callout; }
      });
      this._lastAlignUndo = null;
      if (typeof App !== "undefined" && App._markDirty) App._markDirty();
      this.renderPinsOnMap();
      Prompt.toast("정렬 되돌림");
    },

    renderPinList() {
      const list  = this.$("pin-list");
      const empty = this.$("pin-empty");
      const badge = this.$("pin-count-badge");
      // [WO 20260930-fixmode] 모드 = 작업공간 — 목록·카운트·"N PINS" 는 활성 모드 핀만(SoT: PinSeries.modePins).
      const modePins = (typeof PinSeries !== "undefined" && PinSeries.modePins) ? PinSeries.modePins(State.pins) : (State.pins || []);
      this._updatePinListCount(modePins.length);
      // [버그수정] 도면 미로드 화면(허브 등)에서 Notes.loadSummary→renderPinList 호출 시 요소 부재 → 가드
      if (!list) return;
      list.innerHTML = "";
      const sel = this._syncPinSel();
      const selecting = sel.on && this._pinSelOk();

      if (!modePins.length) {
        empty.classList.remove("hidden");
        badge.classList.add("hidden");
        this.hide("section-export");
        if (typeof AllPins !== "undefined") { AllPins.syncButton(); if (AllPins.open) AllPins.render(); }
        if (typeof PinGrid !== "undefined") PinGrid.render();
        this.renderTree();   // [WO 20260929-bulkdel] 마지막 핀까지 지워도 트리가 옛 핀을 남기지 않게(종전 조기 return 이 건너뜀)
        return;
      }
      // [WO 20260929-bulkdel → 20261002-allmenu §2] 선택 도구줄(목록 맨 위) — 디자이너 이상(선택·정렬).
      //   삭제 버튼만 소유자·super(_pinBulkButtons 안에서 비활성 + 사유). 열람 화면엔 만들지 않는다.
      const mountBulkBar = () => {
        if (!this._pinSelOk()) return;
        const bar = document.createElement("div");
        bar.className = "pin-bulk-bar";
        this._pinBulkButtons().forEach(b => bar.appendChild(b));
        list.insertBefore(bar, list.firstChild);
      };
      empty.classList.add("hidden");
      badge.textContent = modePins.length + " PINS";
      badge.classList.remove("hidden");
      if (State.mode === "designer") this.show("section-export");

      const totalPages = State.mode === "viewer"
        ? (State.viewerPages ? State.viewerPages.length : 1)
        : State.pdfPages;

      // 다중 페이지 도면: 현재 페이지의 핀만 목록에 표시(페이지별 완벽 구분)
      const curPage = State.pdfPage || 1;
      const isMulti = totalPages > 1;
      const visiblePins = isMulti
        ? modePins.filter(p => (p.page || 1) === curPage)
        : modePins;
      // 🔴 [2026-09-17] 번호 중복 탐지 전용(표시만) — 자동 재채번 금지(마스터 명시).
      //   정본 = PinSeries.duplicateCheckboardIds (11_UI 도면 마커도 같은 함수를 쓴다).
      const dupPinIds = (typeof PinSeries !== "undefined") ? PinSeries.duplicateCheckboardIds(State.pins, curPage) : new Set();

      // 현재 페이지에 핀이 없으면 안내(다른 페이지에 핀이 있을 수 있음)
      if (isMulti && visiblePins.length === 0) {
        const other = modePins.length;
        empty.classList.remove("hidden");
        const et = empty.querySelector(".pin-empty-sub") || empty;
        list.innerHTML = `<p class="pin-empty-page">현재 페이지(P${curPage})에 등록된 포인트가 없습니다.${other ? ` 다른 페이지에 ${other}개의 포인트가 있습니다.` : ""}</p>`;
        badge.textContent = modePins.length + " PINS";
        badge.classList.remove("hidden");
        if (State.mode === "designer") this.show("section-export");
        if (typeof AllPins !== "undefined") { AllPins.syncButton(); if (AllPins.open) AllPins.render(); }
        if (typeof PinGrid !== "undefined") PinGrid.render();
        mountBulkBar();      // 트리에서 다른 페이지 핀을 골랐어도 [선택 삭제]는 여기서도 보인다
        this.renderTree();   // [WO 20260929-bulkdel] 종전 조기 return 이 트리 갱신을 건너뛰었다
        return;
      }

      mountBulkBar();
      visiblePins.forEach((pin, idx) => {
        const item = document.createElement("div");
        item.className = "pin-item" + (State.activePin === pin.id ? " active" : "");
        item.dataset.id = pin.id;
        const pageTag = (totalPages > 1) ? ` · P${pin.page || 1}` : "";
        const cloudTag = pin.imageId ? ' <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12" aria-hidden="true" style="vertical-align:-1px;opacity:.7"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>' : "";
        // 노트/첨부 메타 아이콘
        const noteIco = pin.note ? `<svg viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>` : "";
        const attCount = pin.attachments ? pin.attachments.length : 0;
        const attIco = attCount ? `<svg viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>` : "";
        const metaIcons = (noteIco || attIco)
          ? `<span class="pin-meta-icons">${noteIco}${attIco}${attCount > 1 ? attCount : ""}</span>` : "";
        // 미해결 이슈 카운트 뱃지(이슈/필드노트)
        const openIssues = (typeof Notes !== "undefined") ? Notes.openCountFor(pin.id) : 0;
        const issueBadge = openIssues > 0
          ? `<span class="pin-issue-badge" title="미해결 이슈 ${openIssues}건">${openIssues}</span>` : "";
        // 🔴 [2026-09-17] 번호 중복 경고(표시만 — 자동 재채번 금지, 마스터 명시)
        const dupBadge = dupPinIds.has(pin.id)
          ? `<span class="pin-dup-badge" title="번호 중복 — 현장 확인 후 직접 수정하세요">중복</span>` : "";

        if (State.mode === "designer") {
          item.innerHTML = `
            <div class="pin-num">${idx + 1}</div>
            <div class="pin-info">
              <div class="pin-name">${this.escapeHtml(pin.label)}${cloudTag}${metaIcons}${issueBadge}${dupBadge}</div>
              <div class="pin-coords">${pin.x.toFixed(1)}%, ${pin.y.toFixed(1)}%${pageTag}</div>
            </div>
            <div class="pin-acts">
              <button class="pin-act pin-edit" data-id="${pin.id}" title="수정" aria-label="수정">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
              </button>
              <button class="pin-act pin-del" data-id="${pin.id}" title="삭제" aria-label="삭제">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
              </button>
            </div>`;
          item.querySelector(".pin-edit").addEventListener("click", e => {
            e.stopPropagation();
            App.editPin(pin.id);
          });
          item.querySelector(".pin-del").addEventListener("click", e => {
            e.stopPropagation();
            App.deletePin(pin.id);
          });
          // [WO 20260929-bulkdel] 선택 모드(관리자): 체크박스 + 행 클릭 = 선택 토글(이동/오픈 대신)
          if (selecting) {
            const picked = sel.ids.has(String(pin.id));
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.className = "pin-sel";
            cb.checked = picked;
            cb.setAttribute("aria-label", "'" + (pin.label || "포인트") + "' 선택");
            cb.addEventListener("click", e => { e.stopPropagation(); this.togglePinSelected(pin.id); });
            item.insertBefore(cb, item.firstChild);
            item.classList.toggle("selected", picked);
            item.addEventListener("click", () => this.togglePinSelected(pin.id));
            list.appendChild(item);
            return;
          }
          // 디자이너 모드: 콘텐츠 있는 핀은 이동+오픈, 없는 핀은 CAD 인스펙터 상세 표시
          item.addEventListener("click", () => {
            if (App.pinHasContent(pin)) App.focusPin(pin, true);
            else if (typeof Inspector !== "undefined") { App.focusPin(pin, false); Inspector.showPin(pin); }
            else App.focusPin(pin, false);
          });
        } else {
          item.innerHTML = `
            <div class="pin-num">${idx + 1}</div>
            <div class="pin-info">
              <div class="pin-name">${this.escapeHtml(pin.label)}${cloudTag}${metaIcons}${issueBadge}</div>
              <div class="pin-coords">${pin.x.toFixed(1)}%, ${pin.y.toFixed(1)}%${pageTag}</div>
            </div>
            <span class="pin-arrow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg></span>`;
          item.addEventListener("click", () => App.focusPin(pin, true));
        }
        list.appendChild(item);
      });
      if (typeof AllPins !== "undefined") { AllPins.syncButton(); if (AllPins.open) AllPins.render(); }
      if (typeof PinGrid !== "undefined") PinGrid.render();
      this.renderTree();
    },

    /* [사이드바 재구성] 🔴 마스터 확정 계층(2026-09-21 정정 — 3단):
         프로젝트 > 구역(parent_id IS NULL 인 deck) > 영역(parent_id = 구역 id 인 deck) > 핀
       데이터(Projects.currentProject / Projects.decks / State.zones / State.pins)를 읽어 렌더,
       이벤트는 기존 함수(Projects.selectDeck / Zones.focus / App.focusPin)에 그대로 위임한다.

       [WO 20260921-tree3] 🔴 "도면"은 트리 단계가 아니다(마스터 정정):
         · 직전 커밋(eeeab36)이 세운 4단(프로젝트>도면>구역>영역)을 3단으로 되돌린다.
         · decks.parent_id(마이그레이션 0025, 프로덕션 적용 완료)는 그대로 쓴다 —
           parent_id NULL = 구역, parent_id 있음 = 영역. 이 구조는 3단과 정확히 맞는다.
         · 🔴 도면 출처 정보는 버리지 않는다 — 트리 "단"에서 빼고(2026-09-28: 부가 라벨도
           같은 파일명이 반복되며 이름을 가려 마스터가 재지적 → title 툴팁으로 재이동),
           구역/영역 노드의 head.title(docLabel())로 남긴다(아래 deckNode 참조).
         · 도면 이름 정본 = API 가 JOIN 해 준 deployment_file_name/deployment_title.
           없으면 현재 로드된 도면의 State.fileName, 그래도 없으면 일반 표기("등록 도면").
           🔴 없는 이름을 지어내지 않는다.
         · parent_id 가 가리키는 부모가 목록에 없으면(삭제됨) 최상위로 승격 — 숨기지 않는다.

       [WO 20260917-pin] 마스터 지시("항상 리스트가 보이게, 모든 항목에 대해") — 조건부 숨김 없음:
         · 구역/영역: 항상 전체 표시(필터 없음).
         · 영역JSON(State.zones)/핀: 전체 페이지를 항상 표시하고, 현재 페이지 항목만 .active 로 "구분"한다.
         · 로드되지 않은 구역(다른 배포본)은 클라이언트에 zone/pin 데이터 자체가 없으므로
           개수 배지를 붙이지 않는다(하드코딩 금지 — 없는 값을 0으로 지어내지 않는다). */
    /** [WO 20260928-hub-tree] 🔴 공유 지점(SoT) — 구역/영역 분류 규칙은 여기 한 곳에만 둔다.
     *  사이드바 트리(renderTree, 아래)와 허브 카드(12_ProjectHub.js)가 이 함수를 함께 쓴다.
     *  parent_id 가 가리키는 부모가 없거나(삭제됨) 자기참조면 최상위로 승격(숨김 금지).
     *  @param {Array} decks
     *  @returns {{roots: Array, childrenOf: Map<string, Array>}} */
    groupDecksByParent(decks) {
      decks = decks || [];
      const byId = new Map();
      decks.forEach((d) => byId.set(String(d.id), d));
      const parentKey = (d) => {
        const pid = d.parent_id != null ? String(d.parent_id) : "";
        return (pid && pid !== String(d.id) && byId.has(pid)) ? pid : "";
      };
      const childrenOf = new Map();
      decks.forEach((d) => {
        const pid = parentKey(d);
        if (!pid) return;
        if (!childrenOf.has(pid)) childrenOf.set(pid, []);
        childrenOf.get(pid).push(d);
      });
      const roots = decks.filter((d) => !parentKey(d));
      return { roots, childrenOf };
    },

    /** [WO 20260929-tree-label] 🔴 공유 지점(SoT) — 트리 라벨은 항상 deck.name(파일명이 아니다).
     *  마스터 지적: "이 트리가 제대로 제목이 안나오잖아" — 사이드바 트리(renderTree)와 허브 카드
     *  트리(12_ProjectHub.js)가 각자 이름 폴백을 따로 구현하면 반드시 갈라진다(§5) — 이 함수 하나만 쓴다.
     *  @returns {string} 이스케이프된 HTML — 이름 있으면 그대로, 없으면 "(이름 없음)" */
    deckLabelHtml(deck) {
      const esc = (s) => this.escapeHtml(s);
      return (deck && deck.name) ? esc(deck.name) : '<span class="tree-name-missing">(이름 없음)</span>';
    },

    /* ══ [WO 20261002-allmenu] 권한·출처·트리 ⋯ 메뉴 — 공유 지점(SoT) ══════════════════════════════
       permCheck 는 트리 ⋯ 메뉴와 전체 기능 메뉴(45_FeatureMenu)가 함께 쓴다 — 🔴 숨김 금지 원칙의 사유 문구가
       화면마다 갈라지지 않게 한 곳에서만 만든다. 반환 = "" (가능) 또는 사유 문자열(비활성 표시용). */
    permCheck(perm) {
      const A = (typeof Auth !== "undefined") ? Auth : null;
      const designer = typeof State !== "undefined" && State.mode === "designer" && !!(A && A.isDesigner) && !(A && A.readonly);
      const P = (typeof Projects !== "undefined") ? Projects : null;
      switch (perm) {
        case "designer": return designer ? "" : "디자이너(편집) 전용 — 열람 화면에서는 사용할 수 없습니다";
        case "owner":
          if (!designer) return "디자이너(편집) 전용 — 열람 화면에서는 사용할 수 없습니다";
          return ((P && P.currentProject && P.currentProject.can_manage_members) || (A && A.isSuper)) ? "" : "소유자·관리자 전용";
        case "admin": return (A && A.isAdmin) ? "" : "관리자 전용";
        case "super": return (A && A.isSuper) ? "" : "슈퍼관리자 전용";
        case "login": return (A && (A.user || A.role)) ? "" : "로그인 후 사용";
        default: return "";
      }
    },
    /** 트리용 프로젝트 서술자 — Projects.currentProject → 목록에서 State.currentProjectId → {id,name}. 없으면 null. */
    _treeProject() {
      const P = (typeof Projects !== "undefined") ? Projects : null;
      if (P && P.currentProject) return P.currentProject;
      const pid = (typeof State !== "undefined") ? State.currentProjectId : null;
      if (!pid) return null;
      const lists = [(P && P.list) || [], (typeof ProjectHub !== "undefined" && ProjectHub.list) || []];
      for (const l of lists) { const hit = l.find((p) => p && String(p.id) === String(pid)); if (hit) return hit; }
      return { id: pid, name: State.currentProjectName || "프로젝트" };
    },
    /** 구역 도면 출처 — {kind:"none"|"main"|"crop"|"own", label}. crop = 메인(또는 다른 도면)을 잘라 쓰는 창/벡터 복사,
     *  own = 이 구역에 따로 등록한 도면. 데이터 SoT = deck.crop · deck.src_dep_id · deployment_id(새 컬럼 0). */
    deckSourceOf(deck, mainDepId, decks) {
      if (!deck || !deck.deployment_id) return { kind: "none", label: "도면 미등록" };
      const isCrop = !!(deck.crop && deck.crop.w > 0 && deck.crop.h > 0);
      if (!isCrop && mainDepId && String(deck.deployment_id) === String(mainDepId)) return { kind: "main", label: "메인 도면" };
      // 다른 구역과 같은 배포본을 보는 구역(창·레거시 영역)도 "잘라옴" — 자기 도면이 아니다(App._deckOwnsDrawing 과 같은 규칙).
      const shared = (decks || []).some((d) => d && String(d.id) !== String(deck.id) && String(d.deployment_id || "") === String(deck.deployment_id));
      if (isCrop || deck.src_dep_id || shared) return { kind: "crop", label: "잘라옴" };
      return { kind: "own", label: "별도 등록 · " + (deck.deployment_file_name || deck.deployment_title || "도면 파일") };
    },
    originMenuItems(proj, pick) {
      const items = [];
      items.push({ label: "원본 전체 도면 열기", reason: pick ? "" : "메인(원본) 도면이 아직 없습니다",
        run: () => { if (typeof Projects !== "undefined" && Projects.openOriginal) Projects.openOriginal(); } });
      const ownerWhy = this.permCheck("owner");
      items.push({ label: "메인 도면 교체", danger: true, reason: ownerWhy || (pick ? "" : "메인(원본) 도면이 아직 없습니다 — 도면을 먼저 등록하세요"),
        desc: "프로젝트 메인 PDF 를 새 파일로(확인창)",
        run: () => { if (typeof App !== "undefined" && App.registerDrawingFor) App.registerDrawingFor({ kind: "main" }); } });
      // [WO 20261010-revision] 도면 개정 — 숨김 금지: 비활성 사유 SoT = Revision.reason()
      if (typeof Revision !== "undefined") {
        items.push({ label: "새 개정 올리기", desc: "이전 도면 보관 + 기준점 정렬로 핀·영역·주석 좌표 이월(10분 되돌리기)",
          reason: Revision.reason({ kind: "main" }, "upload"), run: () => Revision.start({ kind: "main" }) });
        items.push({ label: "개정 이력·비교", desc: "번호·일자·작성자·메모 · 이전 개정 보기 · 겹쳐 비교",
          reason: Revision.reason({ kind: "main" }, "history"), run: () => Revision.openHistory({ kind: "main" }) });
      }
      if (!pick) {
        items.push({ label: "지금 열린 도면을 원본으로 지정", reason: ownerWhy || ((typeof State !== "undefined" && State.currentDeploymentId) ? "" : "먼저 도면을 열어야 합니다"),
          run: () => { if (typeof Projects !== "undefined" && Projects.setOriginalToCurrent) Projects.setOriginalToCurrent(); } });
      }
      // [WO 20261008-pinpurge] 프로젝트 모든 핀 삭제 — 숨김 금지: 비활성 사유 SoT = PinPurge.reason()
      if (typeof PinPurge !== "undefined") {
        items.push({ label: "모든 핀 삭제", danger: true, desc: "프로젝트 전체 구역·도면의 핀(미리보기 → 이름 입력 → 본인 확인, 10분 되돌리기)",
          reason: PinPurge.reason(), run: () => PinPurge.start() });
      }
      return items;
    },
    deckMenuItems(deck, mainDepId) {
      const src = this.deckSourceOf(deck, mainDepId, (typeof Projects !== "undefined" && Projects.decks) || []);
      const why = this.permCheck("designer");
      const label = src.kind === "none" ? "도면 등록" : src.kind === "own" ? "도면 교체" : src.kind === "crop" ? "이 구역 도면 따로 등록" : "도면 등록/교체";
      const items = [{ label: "출처: " + src.label, info: true }];
      items.push({ label, desc: "PDF·이미지 — 메인 PDF 는 바뀌지 않습니다",
        reason: why || (src.kind === "main" ? "메인 도면 — 원본 ⋯ → [메인 도면 교체](소유자·관리자)" : ""),
        run: () => { if (typeof App !== "undefined" && App.registerDrawingFor) App.registerDrawingFor({ kind: "deck", deck }); } });
      // [WO 20261010-revision] 이 구역 자기 도면의 개정 — 창·벡터 복사 구역은 비활성 + "메인 도면의 개정으로"(Revision.reason SoT)
      if (typeof Revision !== "undefined" && src.kind !== "none") {
        items.push({ label: "이 구역 새 개정 올리기", desc: "구역 도면 개정 — 이전 도면 보관 + 좌표 이월",
          reason: Revision.reason({ kind: "deck", deck }, "upload"), run: () => Revision.start({ kind: "deck", deck }) });
        items.push({ label: "이 구역 개정 이력·비교", reason: Revision.reason({ kind: "deck", deck }, "history"), run: () => Revision.openHistory({ kind: "deck", deck }) });
      }
      // [WO 20261007-qrcov] QR 위치 태그 일괄 인쇄 — 숨김 금지: 미로드 구역은 비활성 + 사유(QrPrint.deckReason SoT)
      if (typeof QrPrint !== "undefined") {
        items.push({ label: "이 구역 QR 일괄 인쇄", desc: "구역·포인트마다 QR — A4 한 장에 " + QrPrint.PER_PAGE + "칸",
          reason: QrPrint.deckReason(deck), run: () => QrPrint.printDeck(deck) });
      }
      return items;
    },
    /** [WO 20261008-pinstyle] 팝업 위치 SoT — 트리 ⋯ 메뉴 · 우클릭 앱 메뉴 공용.
     *  🔴 375 실측(0b4d262): 트리 ⋯ 메뉴(z 520)의 첫 항목을 고정 ?·✉ 버튼(z 9550, 좌하단)이 덮었다.
     *  버튼을 숨기지 않고 메뉴 위치만 옮긴다 — 아래 → 위 → (둘 다 겹치면) 버튼 윗선까지로 줄여 스크롤.
     *  화면 밖(상하좌우 8px 여백)도 같은 판정으로 막는다. rect = {left, top, bottom}(앵커 또는 포인터 점). */
    FLOAT_AVOID_SEL: "[data-help-toggle],[data-help-inquiry-toggle]",
    placePopup(pop, rect) {
      // 모바일(≤760px)은 style.css 의 .tree-pop 바텀시트(도크 위·60vh·!important)가 위치 SoT — 여기서 top/max-height 를
      //   만지면 시트가 줄어 항목이 스크롤 밖으로 숨는다(375 CDP 실측). FAB 는 같은 CSS 의 body:has(.tree-pop) 규칙이 올린다.
      if (typeof window !== "undefined" && window.matchMedia && window.matchMedia("(max-width: 760px)").matches) return null;
      const vw = (typeof window !== "undefined" && window.innerWidth) || 1024;
      const vh = (typeof window !== "undefined" && window.innerHeight) || 768;
      const M = 8;
      const w = pop.offsetWidth || 280, h = pop.offsetHeight || 0;
      const left = Math.max(M, Math.min(rect.left, vw - w - M));
      const avoid = (document.querySelectorAll ? Array.from(document.querySelectorAll(this.FLOAT_AVOID_SEL)) : [])
        .map((e) => e.getBoundingClientRect()).filter((a) => a && a.width > 0 && a.height > 0)
        .filter((a) => a.left < left + w && a.right > left); // 가로로 겹치는 것만
      const bad = (top) => top < M || top + h > vh - M || avoid.some((a) => a.top < top + h && a.bottom > top);
      const below = rect.bottom + 4, above = rect.top - 4 - h;
      let top;
      if (!bad(below)) top = below;
      else if (!bad(above)) top = above;
      else {
        const floor = Math.min(vh - M, ...avoid.map((a) => a.top - 4));
        top = Math.max(M, Math.min(below, floor - h));
        if (top + h > floor) { pop.style.maxHeight = Math.max(80, floor - top) + "px"; pop.style.overflowY = "auto"; }
      }
      pop.style.left = Math.round(left) + "px";
      pop.style.top = Math.round(top) + "px";
      return { left, top };
    },
    /** 트리 ⋯ 팝오버(공유 생성기) — items: [{label, run, reason?, desc?, info?, danger?}].
     *  🔴 숨김 금지: reason 이 있으면 비활성(aria-disabled) + 사유를 항목 안에 글자로 보인다. 바깥 클릭·Esc 로 닫힘. */
    openTreeMenu(anchor, title, items, opts) {
      this.closeTreeMenu();
      if (typeof document === "undefined" || !document.body) return null;
      const pop = document.createElement("div");
      pop.className = "tree-pop";
      pop.setAttribute("role", "menu");
      pop.setAttribute("aria-label", title || "메뉴");
      const h = document.createElement("div");
      h.className = "tree-pop-title";
      h.textContent = title || "";
      pop.appendChild(h);
      (items || []).forEach((it) => {
        if (it.info) { const p = document.createElement("div"); p.className = "tree-pop-info"; p.textContent = it.label; pop.appendChild(p); return; }
        const b = document.createElement("button");
        b.type = "button";
        b.className = "tree-pop-item" + (it.danger ? " danger" : "") + (it.reason ? " is-disabled" : "");
        b.setAttribute("role", "menuitem");
        if (it.reason) b.setAttribute("aria-disabled", "true");
        b.innerHTML = '<span class="tree-pop-label">' + this.escapeHtml(it.label) + '</span>'
          + (it.reason ? '<span class="tree-pop-why">' + this.escapeHtml(it.reason) + '</span>'
            : (it.desc ? '<span class="tree-pop-desc">' + this.escapeHtml(it.desc) + '</span>' : ""));
        b.addEventListener("click", (e) => {
          if (e && e.stopPropagation) e.stopPropagation();
          if (it.reason) { try { Prompt.toast && Prompt.toast(it.reason); } catch (er) {} return; }
          this.closeTreeMenu();
          if (it.run) it.run();
        });
        pop.appendChild(b);
      });
      document.body.appendChild(pop);
      try {
        const r = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
        if (r) this.placePopup(pop, r);
      } catch (e) {}
      const onDoc = (e) => { if (!pop.contains || !pop.contains(e.target)) this.closeTreeMenu(); };
      // [WO 20261008-pinstyle §3] 키보드 — ↑↓ 로 항목 이동(Home/End), Enter/Space 는 버튼 기본 동작, Esc 닫기.
      const onKey = (e) => {
        if (e.key === "Escape") { this.closeTreeMenu(); return; }
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
        const list = pop.querySelectorAll ? Array.from(pop.querySelectorAll(".tree-pop-item")) : [];
        if (!list.length) return;
        if (e.preventDefault) e.preventDefault();
        const i = list.indexOf(document.activeElement);
        const j = e.key === "Home" ? 0 : e.key === "End" ? list.length - 1
          : e.key === "ArrowDown" ? (i + 1) % list.length : (i <= 0 ? list.length - 1 : i - 1);
        try { list[j].focus(); } catch (er) {}
      };
      if (opts && opts.focus) { try { const f = pop.querySelector && pop.querySelector(".tree-pop-item"); if (f && f.focus) f.focus(); } catch (e) {} }
      setTimeout(() => { document.addEventListener("click", onDoc, true); }, 0);
      document.addEventListener("keydown", onKey);
      this._treePop = { pop, onDoc, onKey };
      return pop;
    },
    closeTreeMenu() {
      const t = this._treePop;
      if (!t) return;
      this._treePop = null;
      document.removeEventListener("click", t.onDoc, true);
      document.removeEventListener("keydown", t.onKey);
      if (t.pop && t.pop.parentNode) t.pop.parentNode.removeChild(t.pop);
    },

    /* ══ [WO 20261008-pinstyle §3] 우클릭 = 앱 메뉴(브라우저 메뉴 대체) ═══════════════════════════════
       렌더·위치·키보드·닫기 = 트리 ⋯ 팝오버(openTreeMenu/placePopup) 그대로 재사용 — 새 메뉴 위젯 0.
       항목 정의 재사용: 전체 기능 메뉴(45_FeatureMenu.FEATURES — reasonOf/run) · 트리 ⋯(deckMenuItems/originMenuItems).
       🔴 숨김 금지: 권한·조건이 안 맞으면 비활성 + 사유. 입력창(input·textarea·contenteditable)은 브라우저 메뉴 유지.
       대상 판정 SoT = ctxTargetOf(target, x, y) → {kind:"pin"|"tree"|"outline"|"map", ...}. */
    CTX_LONGPRESS_MS: 600,
    _fmItem(id, label) {
      try {
        if (typeof FeatureMenu === "undefined" || !FeatureMenu._f) return null;
        const f = FeatureMenu._f(id);
        if (!f) return null;
        return { label: label || f.label, reason: FeatureMenu.reasonOf(f), desc: FeatureMenu.modeHint(f) || "", run: () => FeatureMenu.run(f) };
      } catch (e) { return null; }
    },
    _isEditable(t) {
      return !!(t && t.closest && t.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']"));
    },
    ctxTargetOf(target, x, y) {
      if (!target || !target.closest) return null;
      const pinEl = target.closest(".pin-marker[data-id], .pin-leader-bubble[data-id], .tree-node-pin[data-pin-id]");
      if (pinEl) {
        const id = pinEl.dataset.id || pinEl.dataset.pinId;
        const pin = (State.pins || []).find((p) => String(p.id) === String(id));
        if (pin) return { kind: "pin", pin };
      }
      const treeNode = target.closest("#side-tree .tree-node, #side-tree .tree-project");
      if (treeNode) {
        const more = treeNode.querySelector ? treeNode.querySelector(".tree-more") : null;
        return more ? { kind: "tree", more } : { kind: "page" };
      }
      // [WO 20261010-backctx] 마스터 "오른쪽 마우스는 브라우저 속성이 아니라 앱 자체 기능이" — 도면 밖도 전부 앱 메뉴.
      const hubCard = target.closest("#hub-grid .hub-card");
      if (hubCard) return { kind: "hubcard", card: hubCard };
      const reqItem = target.closest("[data-req-item]");
      if (reqItem) return { kind: "request", item: reqItem };
      if (target.closest("#pano-overlay")) return { kind: "pano" };
      const vp = this.$("map-viewport");
      if (!vp || !vp.contains(target)) return { kind: "page" };
      if (target.closest("button, a, [role=toolbar], [role=dialog]") && !target.closest(".deck-outline-label")) return { kind: "page" };
      try {
        if (typeof DeckOutline !== "undefined" && DeckOutline._hitAt) {
          const lbl = target.closest(".deck-outline-label");
          const hit = lbl ? { id: lbl.getAttribute("data-deck-outline-label") } : DeckOutline._hitAt(x, y);
          const deck = hit && (Projects.decks || []).find((d) => String(d.id) === String(hit.id));
          if (deck) return { kind: "outline", deck };
        }
      } catch (e) {}
      return { kind: "map" };
    },
    /** 열람자 허용 = 보기·요청·질문만. 그 외 편집 항목은 같은 사유 문구(permCheck SoT)로 비활성. */
    pinCtxItems(pin) {
      const edit = this.permCheck("designer");
      const isChecker = (typeof PinSeries !== "undefined" && PinSeries.seriesOf) ? PinSeries.seriesOf(pin) === "checkboard" : !!pin.checkboard;
      const leader = this.Leader.wants(pin);
      const items = [];
      items.push({ label: "열기", desc: isChecker ? "번호·위치" : "360·사진·노트", run: () => {
        if (State.mode === "designer" && typeof PinActionPop !== "undefined") { App.setActivePin(pin.id); PinActionPop.open(pin.id); }
        else if (typeof App !== "undefined" && App.onPinTap) App.onPinTap(pin);
      } });
      items.push({ label: "수정(라벨·번호)", reason: edit, run: () => {
        App.setActivePin(pin.id); PinActionPop.open(pin.id);
        setTimeout(() => { const i = document.getElementById("pap-label-input"); if (i && i.focus) { i.focus(); if (i.select) i.select(); } }, 60);
      } });
      items.push({ label: leader ? "핀으로 표시" : "리더선으로 표시", desc: leader ? "풍선·화살표 대신 핀 하나로" : "좁은 곳 — 번호 풍선 + 화살표로", reason: edit,
        run: () => { this.setPinsLeader([pin], !leader); Prompt.toast(leader ? "핀으로 표시" : "리더선으로 표시 — 풍선은 [위치 이동] 후 드래그·정렬"); } });
      const selOk = this._pinSelOk();
      const sel = this._pinSel.on && this._pinSel.ids.has(String(pin.id));
      items.push({ label: sel ? "선택에서 빼기" : "선택에 추가(정렬·삭제용)", reason: selOk ? "" : (edit || "편집 화면에서 사용"),
        run: () => { if (!this._pinSel.on) this.setPinSelectMode(true); this.togglePinSelected(pin.id); } });
      ["align-v", "align-h"].forEach((id) => {
        const it = this._fmItem(id);
        if (!it) return;
        if (!it.reason && !this._alignCandidatePins().length) it.reason = this.ALIGN_NO_LEADER_MSG;
        items.push(it);
      });
      items.push({ label: "복사(좌표)", desc: "x " + (+pin.x).toFixed(2) + "% · y " + (+pin.y).toFixed(2) + "% · " + (pin.page || 1) + "p", run: () => this.copyPin(pin) });
      items.push({ label: "QR 위치 태그", reason: (typeof QrPrint === "undefined") ? "준비 중" : "", run: () => QrPrint.printPin(pin) });
      let aiWhy = "준비 중";
      try {
        if (isChecker) aiWhy = "CHECKER 는 사진을 등록하지 않습니다 — 360 포인트에서";
        else if (typeof AiVision !== "undefined") aiWhy = AiVision.buttonState({ canEdit: AiVision.canEdit(), online: AiVision._online(), pin, status: AiVision._status }).reason;
      } catch (e) {}
      items.push({ label: "AI 분석", reason: aiWhy, run: () => {
        App.setActivePin(pin.id); PinActionPop.open(pin.id);
        setTimeout(() => { const b = document.querySelector("#pap-ai button:not([disabled])"); if (b) b.click(); }, 120);
      } });
      items.push({ label: "삭제", danger: true, reason: edit, run: () => App.deletePin(pin.id) });
      return items;
    },
    mapCtxItems(pct, at) {
      const edit = this.permCheck("designer");
      const mode = State.regMode === "photo" ? "360" : "CHECKER";
      const items = [];
      items.push({ label: "여기에 핀 추가(" + mode + ")", desc: mode === "360" ? "번호 핀 + 사진 선택" : "번호 핀(사진 없음)",
        reason: edit || (pct ? "" : "도면 밖입니다"), run: () => this._ctxAddPinAt(at) });
      const clip = this._pinClip;
      const clipSeries = clip ? (clip.checkboard ? "checkboard" : "content") : null;
      const curSeries = State.regMode === "checkboard" ? "checkboard" : "content";
      items.push({ label: "붙여넣기" + (clip ? " (" + (clip.no || "") + ")" : ""), desc: clip ? "복사한 포인트 모양으로 새 번호 핀" : "",
        reason: edit || (!clip ? "복사한 포인트가 없습니다 — 핀 우클릭 > 복사" : (clipSeries !== curSeries ? "복사한 포인트는 " + (clipSeries === "checkboard" ? "CHECKER" : "360") + " — 그 모드에서 붙여넣기" : (pct ? "" : "도면 밖입니다"))),
        run: () => this._ctxAddPinAt(at, clip) });
      ["align-v", "align-h", "zoom-fit", "coverage"].forEach((id) => {
        const it = this._fmItem(id, id === "align-v" ? "정렬 시작 ↕" : id === "align-h" ? "정렬 시작 ↔" : null);
        if (!it) return;
        if ((id === "align-v" || id === "align-h") && !it.reason && !this._alignCandidatePins().length) it.reason = this.ALIGN_NO_LEADER_MSG;
        items.push(it);
      });
      const req = this._fmItem("request-send");
      if (req && State.mode !== "designer") items.push(req);
      items.push({ label: "전체 기능 메뉴 열기", reason: (typeof FeatureMenu === "undefined") ? "준비 중" : "", run: () => FeatureMenu.open() });
      return items;
    },
    /** [WO 20261010-backctx] 컨텍스트별 항목 = 45_FeatureMenu.CTX(SoT)에서 거른 부분집합 + 끝에 [전체 기능 메뉴 열기]. */
    _fmCtx(kind) {
      const items = (typeof FeatureMenu !== "undefined" && FeatureMenu.ctxItems) ? FeatureMenu.ctxItems(kind) : [];
      items.push({ label: "전체 기능 메뉴 열기", reason: (typeof FeatureMenu === "undefined") ? "준비 중" : "", run: () => FeatureMenu.open() });
      return items;
    },
    /** 허브 카드 — 카드 자신의 버튼(12_ProjectHub 배선 = 정본)에 위임. 버튼이 없으면(권한·상태) 비활성 + 사유(숨김 금지). */
    hubCardCtxItems(card) {
      const q = (s) => (card && card.querySelector) ? card.querySelector(s) : null;
      const act = (a) => q('[data-act="' + a + '"]');
      const locked = !!(card && card.classList && card.classList.contains("hub-card-locked"));
      const lab = (id, fb) => { try { const f = FeatureMenu._f(id); return f ? f.label : fb; } catch (e) { return fb; } };
      const owner = "이 프로젝트의 소유자·관리자 전용";
      const it = (label, a, why, danger) => ({ label, danger: !!danger, reason: locked ? "멤버가 아닙니다 — [접근 신청]으로 요청하세요" : (act(a) ? "" : why),
        run: () => { const b = act(a); if (b) b.click(); } });
      return [
        { label: locked ? "접근 신청" : "열기", desc: locked ? "" : "이 프로젝트로 들어갑니다", run: () => { if (card && card.click) card.click(); } },
        it(lab("project-info", "프로젝트 정보"), "info", "이 카드에서는 사용할 수 없습니다"),
        it(lab("project-rename", "프로젝트 이름 변경"), "rename", owner),
        it(lab("project-members", "멤버 관리"), "members", owner),
        it(lab("offline-download", "오프라인 보관(다운로드)"), "dl", "디자이너 전용"),
        it("배포 / 배포 취소", "pub", "디자이너 전용"),
        it("공유 주소 복사", "url-copy", "배포되지 않아 공유 주소가 없습니다"),
        { label: "QR 위치 태그", reason: "구역을 연 뒤 [이 구역 QR 위치 태그 일괄 인쇄](전체 기능)에서", run() {} },
        it(lab("project-delete", "프로젝트 삭제"), "del", owner, true)
      ];
    },
    /** 요청함·결함 목록 행 — 행 자신의 버튼(42_Requests._itemCard 배선 = 정본)에 위임. */
    requestCtxItems(item) {
      const q = (s) => (item && item.querySelector) ? item.querySelector(s) : null;
      const it = (label, sel, why) => ({ label, reason: q(sel) ? "" : why, run: () => { const b = q(sel); if (b) b.click(); } });
      return [
        it("열기(위치로 이동)", "[data-req-goto]", "이동할 위치가 없습니다"),
        it("답변", '[data-req-act="reply"]', "답변할 수 없습니다"),
        it("상태 → 처리중", '[data-req-act="progress"]', "이미 처리중입니다"),
        it("상태 → 완료", '[data-req-act="done"]', "이미 완료입니다"),
        it("상태 → 접수로", '[data-req-act="open"]', "이미 접수 상태입니다"),
        it("확인(검수)", '[data-req-act="verified"]', "완료된 결함 노트만 · 소유자·관리자 전용"),
        { label: "담당자 변경", reason: "담당자는 결함 노트를 만들 때 지정합니다(변경 기능 없음)", run() {} }
      ];
    },
    /** 브라우저 기본 메뉴를 남기는 경우 — 입력창(붙여넣기) · 선택한 글자(복사) · Shift+우클릭(개발·접근성 탈출구). */
    _ctxNative(e) {
      if (!e || e.shiftKey || this._isEditable(e.target)) return true;
      try {
        const sel = (typeof window !== "undefined" && window.getSelection) ? window.getSelection() : null;
        if (sel && !sel.isCollapsed && String(sel).trim()) return true;
      } catch (er) {}
      return false;
    },
    CTX_FOOTER: "브라우저 메뉴는 Shift+우클릭",
    _ctxFooter() {
      const t = this._treePop;
      if (!t || !t.pop || typeof document === "undefined" || !document.createElement) return;
      const p = document.createElement("div");
      p.className = "tree-pop-info tree-pop-foot";
      p.textContent = this.CTX_FOOTER;
      t.pop.appendChild(p);
    },
    copyPin(pin) {
      const meta = (typeof PinSeries !== "undefined") ? PinSeries.numbers(State.pins, pin.page || 1).get(pin.id) : null;
      const no = meta ? PinSeries.formatNo(meta.no, meta.series) : (pin.label || "");
      this._pinClip = { checkboard: !!pin.checkboard, icon: pin.icon || null, leader: this.Leader.wants(pin), no };
      const txt = "#" + no + " x=" + (+pin.x).toFixed(3) + "% y=" + (+pin.y).toFixed(3) + "% page=" + (pin.page || 1);
      let done = false;
      try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(txt).catch(() => {}); done = true; } } catch (e) {}
      Prompt.toast((done ? "복사됨 — " : "복사(앱 안) — ") + txt);
      return txt;
    },
    /** 우클릭 위치(화면 좌표 at)에 핀 — 기존 배치 경로(App._handlePlaceClick) 그대로(채번·360 사진 선택창·자동저장).
     *  메뉴 항목 클릭(사용자 활성화) 안에서 동기 호출이라 360 선택창도 막히지 않는다. */
    _ctxAddPinAt(at, clip) {
      if (!at || typeof App === "undefined" || !App._handlePlaceClick) return;
      const before = (State.pins || []).length;
      const was = State.placing;
      State.placing = true; // _handlePlaceClick 은 배치 중일 때만 동작 — 한 번만 빌리고 원래대로
      try { App._handlePlaceClick({ clientX: at.x, clientY: at.y }); }
      finally { if (!was) State.placing = false; }
      const pin = (State.pins || []).length > before ? State.pins[State.pins.length - 1] : null;
      if (pin && clip) {
        if (clip.icon) pin.icon = clip.icon;
        if (clip.leader) pin.leader = true;
        if (App._markDirty) App._markDirty();
        this.renderPinsOnMap();
      }
    },
    openCtxMenu(e) {
      if (this._ctxNative(e)) return false; // 입력창·선택 글자·Shift = 브라우저 메뉴
      const x = e.clientX, y = e.clientY;
      const tg = this.ctxTargetOf(e.target, x, y);
      if (!tg) return false;
      if (e.preventDefault) e.preventDefault();
      this._ctxOpenedAt = Date.now();
      if (tg.kind === "tree") { tg.more.click(); this._ctxFooter(); return true; } // 트리 = 그 노드의 ⋯ 메뉴 그대로
      const at = { getBoundingClientRect: () => ({ left: x, top: y, bottom: y, right: x, width: 0, height: 0 }) };
      if (tg.kind === "hubcard") {
        const nm = tg.card.querySelector ? tg.card.querySelector(".hub-card-name") : null;
        if (tg.card.classList && tg.card.classList.contains("hub-card-add")) this.openTreeMenu(at, "새 프로젝트", this._fmCtx("hub"), { focus: true });
        else this.openTreeMenu(at, "프로젝트 " + ((nm && nm.textContent) || "").replace(/✎/g, "").trim(), this.hubCardCtxItems(tg.card), { focus: true });
      } else if (tg.kind === "request") {
        this.openTreeMenu(at, "요청·결함", this.requestCtxItems(tg.item), { focus: true });
      } else if (tg.kind === "pano") {
        this.openTreeMenu(at, "360 뷰어", this._fmCtx("pano"), { focus: true });
      } else if (tg.kind === "page") {
        const hub = this.$("screen-projects");
        const onHub = !!(hub && hub.classList && hub.classList.contains("active"));
        this.openTreeMenu(at, onHub ? "프로젝트 목록" : "SEASTAR 360", this._fmCtx(onHub ? "hub" : "page"), { focus: true });
      } else if (tg.kind === "pin") {
        const meta = PinSeries.numbers(State.pins, tg.pin.page || 1).get(tg.pin.id);
        this.openTreeMenu(at, "포인트 " + (meta ? PinSeries.formatNo(meta.no, meta.series) : (tg.pin.label || "")), this.pinCtxItems(tg.pin), { focus: true });
      } else if (tg.kind === "outline") {
        const proj = this._treeProject ? this._treeProject() : null;
        const pick = (Projects.pickOriginalDeck) ? Projects.pickOriginalDeck(Projects.decks || [], proj) : null;
        this.openTreeMenu(at, "구역 " + (tg.deck.name || ""), this.deckMenuItems(tg.deck, (pick && pick.deployment_id) || null), { focus: true });
      } else {
        const pct = (typeof MapCtrl !== "undefined" && MapCtrl.viewportToPercent) ? MapCtrl.viewportToPercent(x, y) : null;
        const inPage = pct && pct.x >= 0 && pct.x <= 100 && pct.y >= 0 && pct.y <= 100 ? pct : null;
        this.openTreeMenu(at, "도면", this.mapCtxItems(inPage, { x, y }), { focus: true });
      }
      this._ctxFooter();
      return true;
    },
    /** 한 번만 — document 캡처 단계 contextmenu + 지도 길게 누르기(터치). 설계자·관리자·열람자 모두(항목만 다름). */
    bindCtxMenu() {
      if (this._ctxBound || typeof document === "undefined" || !document.addEventListener) return;
      this._ctxBound = true;
      document.addEventListener("contextmenu", (e) => {
        if (this._ctxSuppressNative && Date.now() - this._ctxSuppressNative < 1500 && !this._isEditable(e.target)) {
          if (e.preventDefault) e.preventDefault(); this._ctxSuppressNative = 0; return;
        }
        this._ctxSuppressNative = 0;
        this.openCtxMenu(e);
      }, true);
      // [WO 20261010-backctx] 도면 밖 길게 누르기(터치) — 안드로이드는 위 contextmenu 가 같은 규칙으로 처리하지만 iOS 는
      //   contextmenu 를 보내지 않는다 → 같은 메뉴를 직접 연다(입력창·선택 글자 제외 = _ctxNative). 이미지·링크의 기본 길게누르기
      //   메뉴(저장·공유)는 CSS -webkit-touch-callout:none(style.css) 으로 끈다. 도면 안은 아래 지도 전용 배선이 맡는다.
      {
        let gp = null;
        const gCancel = () => { if (gp) { clearTimeout(gp.t); gp = null; } };
        const vpEl = () => this.$("map-viewport");
        document.addEventListener("touchstart", (e) => {
          gCancel();
          const v = vpEl();
          if (!e.touches || e.touches.length !== 1 || (v && v.contains(e.target))) return;
          const t0 = e.touches[0], target = e.target;
          if (this._ctxNative({ target })) return;
          gp = { x: t0.clientX, y: t0.clientY, t: setTimeout(() => {
            const p = gp; gp = null;
            if (!p) return;
            if (this._treePop && Date.now() - (this._ctxOpenedAt || 0) < 800) return; // 브라우저 contextmenu 가 이미 열었다
            this._ctxSuppressNative = Date.now();
            if (this.openCtxMenu({ target, clientX: p.x, clientY: p.y, preventDefault() {} })) this._ctxLongFired = Date.now();
          }, this.CTX_LONGPRESS_MS) };
        }, { passive: true, capture: true });
        document.addEventListener("touchmove", (e) => {
          if (!gp) return;
          const t = e.touches && e.touches[0];
          if (!t || e.touches.length > 1 || Math.hypot(t.clientX - gp.x, t.clientY - gp.y) > 10) gCancel();
        }, { passive: true, capture: true });
        document.addEventListener("touchend", (e) => {
          gCancel();
          const v = vpEl();
          if (v && v.contains(e.target)) return;   // 도면 안 = 아래 지도 배선
          if (this._ctxLongFired && Date.now() - this._ctxLongFired < 3000) { this._ctxLongFired = 0; if (e.cancelable) e.preventDefault(); }
        }, { passive: false, capture: true });
        document.addEventListener("touchcancel", gCancel, { passive: true, capture: true });
      }
      const vp = this.$("map-viewport");
      if (!vp) return;
      // 모바일 길게 누르기(빈 도면) — 핀은 기존 길게 누르기(마커 pointerdown 550ms)가 같은 메뉴를 연다.
      //   손가락이 10px 넘게 움직이거나 두 손가락(핀치)이 되면 취소 — 팬·핀치와 충돌 없음.
      let lp = null;
      const cancel = () => { if (lp) { clearTimeout(lp.t); lp = null; } };
      vp.addEventListener("touchstart", (e) => {
        cancel();
        if (!e.touches || e.touches.length !== 1 || State.placing || State.drawingZone) return;
        const t0 = e.touches[0], target = e.target;
        if (State.pinEditUnlocked && target && target.closest && target.closest(".pin-marker, .pin-leader-bubble")) return; // 이동 중
        lp = { x: t0.clientX, y: t0.clientY, t: setTimeout(() => {
          const p = lp; lp = null;
          if (!p) return;
          if (this._treePop && Date.now() - (this._ctxOpenedAt || 0) < 800) return; // 브라우저 contextmenu 가 이미 열었다
          this._ctxSuppressNative = Date.now(); // 같은 길게 누르기로 뒤늦게 오는 브라우저 contextmenu 는 삼킨다(중복 방지)
          if (this.openCtxMenu({ target, clientX: p.x, clientY: p.y, preventDefault() {} })) this._ctxLongFired = Date.now();
        }, this.CTX_LONGPRESS_MS) };
      }, { passive: true });
      // 길게 누르기로 메뉴를 연 직후 손을 떼면 브라우저가 합성 click 을 보내 ① 풍선/핀 클릭(작업 팝업) ② 메뉴 바깥 클릭
      //   (닫힘)이 연달아 일어난다(375 CDP 실측: 메뉴 0). 그 touchend 의 기본 동작을 막아 합성 click 을 없앤다.
      vp.addEventListener("touchend", (e) => {
        if (this._ctxLongFired && Date.now() - this._ctxLongFired < 3000) { this._ctxLongFired = 0; if (e.cancelable) e.preventDefault(); }
      }, { passive: false, capture: true });
      vp.addEventListener("touchmove", (e) => {
        if (!lp) return;
        const t = e.touches && e.touches[0];
        if (!t || e.touches.length > 1 || Math.hypot(t.clientX - lp.x, t.clientY - lp.y) > 10) cancel();
      }, { passive: true });
      vp.addEventListener("touchend", cancel, { passive: true });
      vp.addEventListener("touchcancel", cancel, { passive: true });
    },

    renderTree() {
      const host = this.$("side-tree");
      if (!host) return;
      /* [WO 20260928-tree-expand] 🔴 마스터: "구역·영역이 리스트로, 기본 펼침" —
         접기/펼치기는 유지하되 기본값은 항상 열림. 상태는 세션 메모리(this._treeCollapsed,
         deck.id 키 — 전역 프로젝트 구분 없는 localStorage 금지, 1e71772 핀필터 사고 재발 방지)
         에만 남긴다. 새로고침하면 초기화되고, deck.id 는 프로젝트별로 유일하므로 다른
         프로젝트 설정이 새어 들어올 수 없다. */
      const collapsed = this._treeCollapsed || (this._treeCollapsed = new Set());
      const esc = (s) => this.escapeHtml(s);
      const C = '<svg class="tree-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';
      // [WO 20261001-projectinfo·tree-hierarchy] 🔴 아이콘 SoT — 단계별 1종, 같은 선 굵기(2)·
      //   같은 크기(16px)·같은 색 규칙(currentColor, .tree-node 색 상속 ≥3:1 기존 감사 그대로).
      //   프로젝트(폴더) → 원본 PDF(문서, 신규) → 구역(갈래 노드) → 영역(크롭 프레임) → 핀(모드별 형태).
      //   이모지·혼재 아이콘 금지 — 전부 이 한 곳에서 파생(기존 ✎과거 📁/이모지 흔적 제거).
      const ICO = {
        project: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
        // [WO 20261001-projectinfo] 원본 PDF 전용 — 문서 아이콘(접힌 모서리). 구역(갈래 노드)과
        // 혼동 금지(과거엔 ICO.deck 재사용 + 📄 이모지를 겹쳐 썼다 — 중복/혼재 제거).
        origin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
        deck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" aria-hidden="true"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
        // 영역(crop) — 구역 내부를 잘라낸 프레임 모양(구역의 갈래 아이콘과 실루엣부터 다르다).
        region: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" aria-hidden="true"><path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/></svg>',
        pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>',
        // [WO 20260930-pinstyle] CHECKER 핀 트리 아이콘 = 둥근사각 번호 배지(도면 마커와 같은 형태
        // 언어). 360(티어드롭)과 실루엣부터 다르게 — 색맹 대비 1차 단서.
        pinChecker: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>'
      };
      const decks = (typeof Projects !== "undefined" && Projects.decks) || [];
      host.innerHTML = "";
      // [WO 20261001-projectinfo] 🔴 docLabel 을 여기로 끌어올린다(원래 위치는 이 함수 뒤쪽) —
      //   아래 originNode()와 "구역 0개" 분기(이 함수 더 아래, early return)가 둘 다 이 함수를 쓴다.
      //   decks/State 에만 의존하므로 끌어올려도 동작은 그대로다(순수 함수 이동, 로직 변경 0).
      const docLabel = (depId) => {
        if (!depId) return "도면 미등록";
        const hit = decks.find((d) => String(d.deployment_id || "") === String(depId) && (d.deployment_file_name || d.deployment_title));
        if (hit) return hit.deployment_file_name || hit.deployment_title;
        if (String(depId) === String(State.currentDeploymentId || "") && State.fileName) return State.fileName;
        return "등록 도면";
      };
      /* [WO 20261001-projectinfo] 🔴 공유 지점(SoT) — "원본 PDF" 트리 노드 한 벌.
       *  마스터: "원 프로젝트 최상위 PDF는 항상 최상단 트리에서 보이게 해야지" — 구역 0개 분기와
       *  구역 보유 분기가 이 함수 하나를 호출한다(각자 만들면 §10 SoT 위반). 판정은
       *  Projects.pickOriginalDeck(기존 SoT, 31_Projects.js) 그대로 — 새 판정 로직 금지. */
      /* [WO 20261002-allmenu §5] 🔴 "메인은 항상 보이게" — 프로젝트 객체가 아직 없어도(허브 진입 직후·
       *  decks 로딩 전·오프라인·열람자 링크) 원본 노드는 그린다(R2: 종전 `if (!proj) return null`).
       *  표시 근거가 없으면 지어내지 않고 지금 열린 도면 이름 또는 "미지정"으로 정직하게 표시한다.
       *  ⋯ 메뉴: [원본 열기] · [메인 도면 교체](소유자·super, 확인창) · [원본으로 지정]. */
      const originNode = () => {
        const pick = (typeof Projects !== "undefined" && Projects.pickOriginalDeck) ? Projects.pickOriginalDeck(decks, proj) : null;
        const n = document.createElement("button");
        n.className = "tree-node tree-node-origin";
        const moreHtml = ' <span class="tree-more" role="button" tabindex="0" aria-label="원본 도면 메뉴" title="원본 도면 메뉴 — 열기·메인 도면 교체">⋯</span>';
        const canSet = !!(proj && proj.can_manage_members);
        if (pick) {
          const label = (pick.deployment_id ? docLabel(pick.deployment_id) : null) || pick.name || "원본 도면";
          n.innerHTML = ICO.origin + '<span class="tree-kind-tag">원본</span><span class="tree-label">' + esc(label) + '</span>' + moreHtml;
          n.title = "원본 전체 도면 열기";
        } else if (!proj && State.currentDeploymentId) {
          n.innerHTML = ICO.origin + '<span class="tree-kind-tag">원본</span><span class="tree-label">' + esc(State.fileName || "지금 열린 도면") + '</span>' + moreHtml;
          n.title = "프로젝트 정보를 아직 불러오지 못했습니다 — 지금 열린 도면";
        } else {
          n.innerHTML = ICO.origin + '<span class="tree-kind-tag">원본</span><span class="tree-label">미지정</span>'
            + (canSet ? ' <span class="btn-mini tree-origin-set" data-origin-set="1" role="button" tabindex="0">지정</span>' : "") + moreHtml;
          n.title = canSet ? "현재 열린 도면을 원본으로 지정할 수 있습니다" : "원본 전체 도면이 아직 지정되지 않았습니다";
        }
        n.addEventListener("click", (e) => {
          if (e && e.stopPropagation) e.stopPropagation();
          const more = e && e.target && e.target.closest ? e.target.closest(".tree-more") : null;
          if (more) { this.openTreeMenu(more, "원본 도면", this.originMenuItems(proj, pick)); return; }
          if (pick) { if (typeof Projects !== "undefined" && Projects.openOriginal) Projects.openOriginal(); return; }
          if (canSet && typeof Projects !== "undefined" && Projects.setOriginalToCurrent) Projects.setOriginalToCurrent();
        });
        return n;
      };
      /* [WO 20260929-tree1] 🔴 공유 지점 — 프로젝트 트리 노드(이름 + 다운로드/삭제 버튼 흡수)를
       *  만드는 코드 한 벌. 구역이 0개라도(빈 프로젝트) 이 노드는 그대로 있어야 한다 — 예전엔
       *  별도 박스(#section-projects)라 구역 수와 무관하게 항상 보였다. 흡수하면서 그 보장까지
       *  깨면 안 된다(§10 SoT — 아래 두 호출부가 각자 만들면 반드시 갈라진다). */
      // [WO 20261002-allmenu §5] R2 근본원인 — 허브 카드 진입 직후 등 Projects.currentProject 가 아직 비어 있는
      //   창(타이밍)에 그려지면 프로젝트·원본 노드가 통째로 사라졌다. 타이밍과 무관하게 막는다: 열린 프로젝트 id
      //   (State.currentProjectId — openProject/openApp 이 동기로 세팅)로 목록에서 찾고, 그래도 없으면 id·이름만 담은
      //   서술자로 그린다(권한 필드 없음 = 권한 버튼 없음, 지어내지 않음).
      const proj = this._treeProject();
      const _mainPick = (typeof Projects !== "undefined" && Projects.pickOriginalDeck) ? Projects.pickOriginalDeck(decks, proj) : null;
      const mainDepId = (_mainPick && _mainPick.deployment_id) || null;
      const mountProjectNode = (rootCount) => {
        const pw = document.createElement("div");
        pw.className = "tree-project open";
        const ph = document.createElement("button");
        ph.className = "tree-node tree-node-project";
        ph.innerHTML = C + ICO.project + '<span class="tree-label">' + esc(proj.name || "프로젝트") + '</span>'
          + (rootCount != null ? '<span class="tree-cnt" title="구역 수">' + rootCount + '</span>' : "");
        ph.addEventListener("click", (e) => {
          if (e && e.target && e.target.closest && e.target.closest(".tree-caret")) { pw.classList.toggle("open"); return; }
          pw.classList.add("open");
          if (typeof Projects !== "undefined" && Projects.openOriginal) Projects.openOriginal();
        });
        pw.appendChild(ph);
        // [WO 20261001-projectinfo] 🔴 원본 노드는 "프로젝트 바로 아래 첫 줄"이어야 한다(마스터 지시)
        // — 액션 버튼 행보다 먼저 붙인다(둘 다 이 함수 안이라 호출부 2곳이 각자 순서를 정할 일이 없다).
        const on = originNode();
        if (on) pw.appendChild(on);
        /* [WO 20260929-tree1] 🔴 근본수정(2차, CDP 실측) — #project-actions(실 DOM)를 트리 안으로
         *  "이동"시키면(appendChild) 다음 renderTree() 호출의 `host.innerHTML=""` 가 그 노드를
         *  통째로 파괴한다(2번째 렌더부터 getElementById('project-actions') 가 null — 영구 소실,
         *  재생성 불가). 트리는 매 렌더 새로 그려지는 1회성 DOM이라 안에 "살아있는 원본"을
         *  두면 안 된다(이 함수의 다른 모든 노드도 매번 새로 만든다 — 같은 규칙을 따른다).
         *  대신 대리 버튼을 매번 새로 만들어, 원래 자리(#section-projects, CSS로 항상 숨김)에
         *  그대로 남은 진짜 버튼을 .click() 으로 호출한다 — 리스너 재구현 0(31_Projects.init()
         *  이 원래 버튼에 붙인 로직 그대로 실행), 새 버튼 DOM만 매 렌더 재생성(다른 트리 노드와
         *  동일 패턴). */
        const actions = document.createElement("div");
        actions.className = "tree-project-actions";
        const proxyBtn = (label, targetId, extraCls) => {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "btn-mini" + (extraCls ? " " + extraCls : "");
          b.textContent = label;
          b.addEventListener("click", (e) => {
            if (e && e.stopPropagation) e.stopPropagation();
            const t = document.getElementById(targetId);
            if (t) t.click();
          });
          return b;
        };
        // [WO 20261001-projectinfo] 이름 변경(소유자·super) · 프로젝트 정보(디자이너 이상 — 서버가 최종 판정).
        if (proj.can_manage_members) {
          const renameBtn = document.createElement("button");
          renameBtn.type = "button"; renameBtn.className = "btn-mini"; renameBtn.textContent = "이름변경";
          renameBtn.addEventListener("click", (e) => { if (e && e.stopPropagation) e.stopPropagation(); if (typeof Projects !== "undefined" && Projects.renameProject) Projects.renameProject(); });
          actions.appendChild(renameBtn);
        }
        const infoBtn = document.createElement("button");
        infoBtn.type = "button"; infoBtn.className = "btn-mini"; infoBtn.textContent = "ⓘ 정보";
        infoBtn.title = "프로젝트 정보 — 메모·일정";
        infoBtn.addEventListener("click", (e) => { if (e && e.stopPropagation) e.stopPropagation(); if (typeof ProjectInfo !== "undefined" && ProjectInfo.open) ProjectInfo.open(proj); });
        actions.appendChild(infoBtn);
        actions.appendChild(proxyBtn("다운로드", "btn-download-project"));
        actions.appendChild(proxyBtn("프로젝트 삭제", "btn-delete-project", "danger"));
        pw.appendChild(actions);
        host.appendChild(pw);
        return pw;
      };
      if (!decks.length) {
        // [WO 20261002-allmenu §5] 🔴 early return 경로에서도 원본 노드를 **먼저** 그린다(R2).
        if (!proj) {
          host.innerHTML = '<p class="tree-empty">구역이 없습니다.<br>위 도구의 ‘구역 생성’으로 추가하세요.</p>';
          const on0 = originNode();
          if (host.insertBefore && host.firstChild !== undefined) host.insertBefore(on0, host.firstChild); else host.appendChild(on0);
          return;
        }
        const pw = mountProjectNode(0);
        /* [WO 20260929-tree1] 🔴 근본수정 — 31_Projects._renderSideTreeEmpty() 가 #side-tree.innerHTML
         *  을 직접 덮어써 renderTree() 가 방금 여기 붙인 #project-actions(실 DOM, 리스너 보유)를
         *  통째로 파괴하는 결함을 실측(CDP)으로 발견했다: appendChild 로 옮긴 노드가 다른 함수의
         *  innerHTML 대입에 지워지면 영영 사라진다(getElementById 도 못 찾음 — 재생성 불가).
         *  근본 원인은 "#side-tree 를 두 함수가 각자 그린다"였다(§10 SoT 위반) → 그 CTA 안내를
         *  여기 한 곳으로 합친다. _renderSideTreeEmpty() 는 이제 이 함수로 위임만 한다(아래 정의). */
        const empty = document.createElement("div");
        empty.className = "side-tree-empty";
        if (typeof State !== "undefined" && State.fileType) {
          empty.innerHTML = '<p class="side-tree-empty-msg">도면이 등록됐습니다.<br>도면에서 <b>영역을 지정</b>해 구역을 만드세요.</p>'
            + '<button type="button" class="side-tree-empty-cta" id="side-tree-make-deck-region">+ 영역 지정해 구역 만들기</button>';
        } else {
          empty.innerHTML = '<p class="side-tree-empty-msg">이 프로젝트에 구역이 없습니다.<br>도면을 등록한 뒤, 도면에서 <b>영역을 지정</b>하면 구역이 만들어집니다.</p>'
            + '<button type="button" class="side-tree-empty-cta" id="side-tree-create-deck">+ 구역 생성</button>';
        }
        pw.appendChild(empty);
        const rb = document.getElementById("side-tree-make-deck-region");
        if (rb) rb.addEventListener("click", () => { if (typeof Projects !== "undefined" && Projects.extractRegionAsDeck) Projects.extractRegionAsDeck(); });
        const cb = document.getElementById("side-tree-create-deck");
        if (cb) cb.addEventListener("click", () => { if (typeof Projects !== "undefined" && Projects.createDeck) Projects.createDeck(); });
        return;
      }
      const curPage = State.pdfPage || 1;
      const totalPages = State.mode === "viewer"
        ? (State.viewerPages ? State.viewerPages.length : 1)
        : (State.pdfPages || 1);
      const showPageTag = totalPages > 1;
      const pageTag = (pg) => showPageTag ? ' <span class="tree-label-sub">P' + (pg || 1) + '</span>' : "";
      /* [WO 20260928-tree-pinlist] 🔴 번호 SoT = PinSeries.numbers()(01b_PinSeries.js) —
         여기서 직접 채번하지 않는다(도면 마커·미니맵과 항상 같은 번호가 나오게).
         numbers() 는 페이지 1개 기준이라, 트리는 전체 페이지를 항상 보여주므로(WO 20260917-pin)
         핀에 등장하는 모든 page 값에 대해 한 번씩 돌려 병합한다(핀 id 는 전역 유일이라 충돌 없음). */
      const numbersAcrossPages = (pins) => {
        const map = new Map();
        if (typeof PinSeries === "undefined" || !PinSeries.numbers) return map;
        const pages = new Set((pins || []).map((p) => p.page || 1));
        pages.forEach((pg) => { PinSeries.numbers(pins, pg).forEach((v, k) => map.set(k, v)); });
        return map;
      };
      const pinNode = (p, numMap) => {
        const n = document.createElement("button");
        const isCheckerPin = !!p.checkboard;
        n.className = "tree-node tree-node-pin tree-node-pin-mode-" + (isCheckerPin ? "checker" : "360") + (State.activePin === p.id ? " active" : "");
        n.dataset.pinId = String(p.id); // [WO 20261008-pinstyle §3] 우클릭 앱 메뉴 대상 판정(UI.ctxTargetOf)
        const noteIco = p.note ? '<svg class="tree-note" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>' : "";
        const meta = numMap ? numMap.get(p.id) : null;
        // [WO 20260930-fixmode] 표시 번호 포맷 SoT = PinSeries.formatNo(CHECKER "1" / 360 "P1") — 핀 패널 헤더(27_PinActionPop)와 같은 표기.
        const noTxt = meta ? ((PinSeries.formatNo ? PinSeries.formatNo(meta.no, meta.series) : String(meta.no))) : "";
        const noLabel = meta ? '<span class="tree-pin-no">#' + esc(noTxt) + '</span>' : "";
        // [WO 20260930-pinstyle] 모드별 아이콘(형태 단서) — 판정 SoT = pin.checkboard(PinSeries.seriesOf 와 동일 기준).
        n.innerHTML = (isCheckerPin ? ICO.pinChecker : ICO.pin) + noLabel + '<span class="tree-label">' + esc(p.label || "포인트") + '</span>' + pageTag(p.page) + noteIco;
        if (p.note) n.title = "" + p.note;
        // [WO 20260929-bulkdel] 선택 모드(관리자): 버튼 안에 input 을 둘 수 없어 aria-pressed + 표시 기호로 선택 상태를 나타낸다
        if (selecting) {
          const picked = pinSel.ids.has(String(p.id));
          n.setAttribute("aria-pressed", picked ? "true" : "false");
          n.classList.toggle("selected", picked);
          n.insertAdjacentHTML("afterbegin", '<span class="tree-sel-box" aria-hidden="true">' + (picked ? "☑" : "☐") + '</span>');
          n.addEventListener("click", () => this.togglePinSelected(p.id));
          return n;
        }
        n.addEventListener("click", () => { if (typeof App !== "undefined") { if (App.focusPin) App.focusPin(p, true); else if (App.onPinTap) App.onPinTap(p); } });
        return n;
      };
      const pinSel = this._syncPinSel();
      const selecting = pinSel.on && this._pinSelOk();

      /* ── 계층 인덱스 ── [WO 20260928-hub-tree] 공유 함수(groupDecksByParent, SoT)로 이관 ── */
      const curDeck = (typeof Projects !== "undefined" && Projects.currentDeck) || null;
      const { roots: rootDecks, childrenOf: allChildrenOf } = this.groupDecksByParent(decks);
      // [WO 20261001-projectinfo] docLabel 은 이 함수 위쪽(decks 선언 직후)으로 이동했다 — 중복 정의 제거.

      /* 같은 도면을 여러 deck(구역/영역)이 가리키므로 State(영역JSON·핀)를 붙일 deck 을 하나로 정한다.
         선택된 deck 이 그 도면 안에 있으면 그 deck 에만, 없으면 종전대로 로드된 deck 에 붙인다. */
      const hasState = (deck) => {
        if (!deck.deployment_id || String(deck.deployment_id) !== String(State.currentDeploymentId || "")) return false;
        if (curDeck && String(curDeck.deployment_id || "") === String(deck.deployment_id)) return String(curDeck.id) === String(deck.id);
        return true;
      };

      /* ── 구역/영역 노드(같은 생성기 — 깊이만 다르다) ───────────────── */
      /* [WO 20260930-moderole] 🔴 마스터 2차 지시로 88e52ff(프로젝트→모드→구역) 구조를 뒤집는다 —
         "영역이나 구역 역시도 공유해야 돼. 프로젝트-구역-영역은 동시에 공유하고, 하단에 체크와 360을
         별개로 구분하자는 거다". 구역·영역은 모드와 무관하게 한 벌만 렌더한다(중복 0). 모드 분리는
         이 노드가 로드된(hasState) 지점의 맨 안쪽에 CHECKER N / 360 N 두 잎 그룹으로만 존재한다 —
         핀 목록·번호대·일괄삭제 범위는 그 잎 그룹 안에서 계열별로 가른다(SoT: PinSeries.DECK_MODES). */
      const deckNode = (deck, isRegion) => {
        const isCur = !!(curDeck && String(curDeck.id) === String(deck.id));
        const loaded = hasState(deck);
        const subDecks = allChildrenOf.get(String(deck.id)) || [];
        // [WO 20260928-tree-expand] 🔴 기본 펼침 — 사용자가 직접 닫은 적이 없으면 항상 open.
        const collapseKey = String(deck.id);
        const g = document.createElement("div");
        g.className = (isRegion ? "tree-region" : "tree-deck") + (collapsed.has(collapseKey) ? "" : " open");
        const head = document.createElement("button");
        head.className = "tree-node " + (isRegion ? "tree-node-region" : "tree-node-deck") + (isCur ? " active" : "");
        // [B4] '도면없음'(구역에 도면 미등록) 과 '미저장'(로컬에만 있고 서버 미반영)을 구분 표시
        const _unsaved = (typeof App !== "undefined" && App.isDeckUnsaved) ? App.isDeckUnsaved(deck.id) : false;
        const _tag = _unsaved
          ? '<span class="tree-tag tree-tag-unsaved" title="로컬에만 있음 — ‘저장’을 눌러 서버에 반영하세요">미저장</span>'
          : (deck.deployment_id ? "" : '<span class="tree-tag" title="이 구역에 등록된 도면이 없습니다 — 구역을 눌러 도면을 등록하세요">도면없음</span>');
        // [항목4] 영역 수 배지 — 로드된 구역만(미로드 구역은 실제 개수를 모른다·0 날조 금지)
        const zoneCntTag = loaded ? '<span class="tree-cnt" title="영역 수">' + (State.zones || []).length + '</span>' : "";
        // [WO 20260921-tree3→20260928-tree-title] 마스터 2026-09-28 지시로 대체: 구역·영역이 같은
        //   deployment(같은 도면)를 가리켜 모든 행에 똑같은 긴 파일명이 붙으면서 정작 구별해야 할
        //   이름("ㅁ"/"ㅁㄴㅇ")이 묻혔다("이 트리가 제대로 제목이 안나오잖아"). 행에는 이름만 보이고,
        //   원본 도면 파일명은 title(네이티브 툴팁)로만 제공한다(docLabel 은 없는 이름을 지어내지
        //   않는다 — 유실이 아니라 이동).
        const docName = deck.deployment_id ? docLabel(deck.deployment_id) : null;
        // [WO 20260928-tree-expand→20260929-tree-label] 🔴 마스터: 이름이 비어 있으면 빈칸이 아니라
        // "(이름 없음)"으로 정직하게 표시(CLAUDE.md §5). SoT: UI.deckLabelHtml(deck.name, 파일명 아님).
        const _nameLabel = this.deckLabelHtml(deck);
        // [WO 20261001-viewreq] 미처리 요청 배지 — 정본 = Requests 캐시(서버 요청함). 0 이면 그리지 않는다(지어내지 않음).
        //   인라인 리터럴 색(#ffffff/#b91c1c 6.5:1) — 트리 테마 변수와 무관하게 대비 고정.
        const _reqN = (State.mode === "designer" && typeof Requests !== "undefined" && Requests.openCountForDeck) ? Requests.openCountForDeck(deck.id) : 0;
        const reqTag = _reqN > 0 ? '<span class="tree-req-badge" data-req-deck="' + esc(String(deck.id)) + '" title="미처리 요청 ' + _reqN + '건" style="margin-left:4px;min-width:16px;padding:0 5px;border-radius:8px;background:#b91c1c;color:#ffffff;font-size:10.5px;font-weight:700;line-height:16px;text-align:center">' + _reqN + '</span>' : "";
        // [WO 20261001-projectinfo·tree-hierarchy] 🔴 마스터: "단계마다 라벨 접두나 툴팁을 둬서
        // 이름만으로 헷갈리지 않게" — 아이콘(형태)만으로는 약하므로 작은 텍스트 꼬리표를 더한다.
        const kindTag = '<span class="tree-kind-tag">' + (isRegion ? "영역" : "구역") + '</span>';
        // [WO 20261002-allmenu §5] 구역 도면 출처(잘라옴 / 별도 등록 · 파일명) — SoT = UI.deckSourceOf.
        const _src = this.deckSourceOf(deck, mainDepId, decks);
        const srcTag = (_src.kind === "crop" || _src.kind === "own")
          ? '<span class="tree-src-tag tree-src-' + _src.kind + '" title="구역 도면 출처: ' + esc(_src.label) + '">' + esc(_src.label) + '</span>' : "";
        head.innerHTML = C + (isRegion ? ICO.region : ICO.deck) + kindTag + '<span class="tree-label">' + _nameLabel + '</span>' + _tag + srcTag + zoneCntTag
          + '<span class="tree-more" role="button" tabindex="0" aria-label="' + (isRegion ? "영역" : "구역") + ' 메뉴" title="' + (isRegion ? "영역" : "구역") + ' 메뉴 — 도면 등록/교체">⋯</span>';
        if (reqTag) head.insertAdjacentHTML("beforeend", reqTag);
        // [WO 20261007-qrcov] 촬영 현황 배지(미촬영·오래됨) — 켜졌고 이 구역 도면이 로드됐을 때만(SoT: Coverage.deckSummary → Projects.pinsForDeck)
        const covTag = (typeof Coverage !== "undefined" && Coverage.treeBadgeHtml) ? Coverage.treeBadgeHtml(deck) : "";
        if (covTag) head.insertAdjacentHTML("beforeend", covTag);
        // [WO 20260929-tree-label→20260928-tree-title] 🔴 잘림 금지 — CSS 는 2줄까지만 보여주고 그
        // 이상은 줄임표라 전체 이름이 필요하면 title(네이티브 툴팁)로 항상 확인할 수 있게 한다.
        // title 엔 이름 + 원본 도면 파일명(있으면)을 함께 담아 도면 출처 정보를 유지한다.
        head.title = (deck.name ? deck.name : "(이름 없음)") + (docName ? "\n원본 도면: " + docName : "");
        // [WO 20260928-tree-expand] 열림/닫힘 토글 시 세션 메모리에 반영(사용자가 닫은 항목만 기억).
        const toggleOpen = () => { if (g.classList.toggle("open")) collapsed.delete(collapseKey); else collapsed.add(collapseKey); };
        head.addEventListener("click", (e) => {
          const more = e && e.target && e.target.closest ? e.target.closest(".tree-more") : null;
          if (more) { if (e.stopPropagation) e.stopPropagation(); this.openTreeMenu(more, (isRegion ? "영역 " : "구역 ") + (deck.name || "(이름 없음)"), this.deckMenuItems(deck, mainDepId)); return; }
          if (e && e.target && e.target.closest && e.target.closest(".tree-caret")) { toggleOpen(); return; }
          if (isCur) { toggleOpen(); return; }
          if (typeof Projects !== "undefined" && Projects.selectDeck) Projects.selectDeck(deck);
        });
        g.appendChild(head);
        // [WO 20260930-merge] 지금 열린 구역/영역에만 — 다른 구역 포인트 가져오기(41_RegionMerge.js). 조건 미달이면 null.
        if (loaded && typeof RegionMerge !== "undefined") { const rmB = RegionMerge.treeButton(deck, isCur); if (rmB) g.appendChild(rmB); }

        const kids = document.createElement("div");
        kids.className = "tree-children";
        let any = false;
        // 3단 — 이 구역 안의 영역(parent_id = 이 구역 id 인 deck). 🔴 마스터: "구역 아래 영역이
        // 리스트로 나열돼야 한다" — 0개여도 숨기지 않고 "영역 없음"으로 알린다(구역 레벨 한정,
        // 영역 자신의 하위는 데이터가 있을 때만 표시해 기존 4단 방지 회귀(p62)를 건드리지 않는다).
        if (!isRegion) {
          if (subDecks.length) subDecks.forEach((cd) => { kids.appendChild(deckNode(cd, true)); });
          else { const eEl = document.createElement("p"); eEl.className = "tree-empty"; eEl.textContent = "영역 없음"; kids.appendChild(eEl); }
          any = true;
        } else if (subDecks.length) {
          subDecks.forEach((cd) => { kids.appendChild(deckNode(cd, true)); });
          any = true;
        }
        if (loaded) {
          const zones = State.zones || []; // 전체 페이지(필터 없음)
          const pins = State.pins || [];   // 전체 페이지(필터 없음)
          const numMap = numbersAcrossPages(pins);
          const sortByNo = (a, b) => ((numMap.get(a.id) || {}).no || 0) - ((numMap.get(b.id) || {}).no || 0);
          // [WO 20260928-tree-pinlist] 🔴 소속 = 가장 깊은(면적 작은) 영역 하나 — 겹치는 영역이
          // 있으면 바운딩박스(zone.w*zone.h, 페이지%) 가 더 작은 쪽. 못 찾으면 구역 직속.
          const zoneOfPin = new Map(); // pinId -> zone
          pins.forEach((p) => {
            const ppage = p.page || 1;
            let best = null, bestArea = Infinity;
            zones.forEach((zone) => {
              if ((zone.page || 1) !== ppage) return;
              if (!(typeof Zones !== "undefined" && Zones._contains && Zones._contains(zone, p.x, p.y))) return;
              const area = Math.max(0, +zone.w || 0) * Math.max(0, +zone.h || 0);
              if (area < bestArea) { bestArea = area; best = zone; }
            });
            if (best) zoneOfPin.set(p.id, best);
          });
          // 공유 렌더러 — 주어진 핀 부분집합(scopePins)을 영역별로 묶어 target 아래에 그린다.
          // 모드 잎 안(계열별)과, PinSeries 미로드 하네스의 전체-핀 폴백(아래) 둘 다 이 함수 하나로 그린다.
          const renderScopedPins = (target, scopePins) => {
            const pinsOfZone = new Map();
            zones.forEach((z) => pinsOfZone.set(z.id, []));
            const rootPins = [];
            scopePins.forEach((p) => {
              const z = zoneOfPin.get(p.id);
              if (z && pinsOfZone.has(z.id)) pinsOfZone.get(z.id).push(p);
              else rootPins.push(p);
            });
            zones.forEach((zone) => {
              const zpins = (pinsOfZone.get(zone.id) || []).slice().sort(sortByNo);
              if (!zpins.length) return; // 이 범위에 핀이 없는 영역은 그리지 않는다(빈 중복 방지)
              const zpage = zone.page || 1;
              const isCurZonePage = zpage === curPage;
              const zn = document.createElement("div");
              zn.className = "tree-zone open"; // [항목2] 기본 펼침
              const zh = document.createElement("button");
              // [항목3][항목5] 현재 페이지 영역 = .active 로 "구분"(숨기지 않음). 클릭 동작은 기존 그대로.
              zh.className = "tree-node tree-node-zone" + (isCurZonePage ? " active" : "");
              zh.innerHTML = C + '<span class="tree-dot" style="background:' + (zone.color || "#888") + '"></span><span class="tree-label">' + esc(zone.label || "영역") + '</span>' + pageTag(zpage) + '<span class="tree-cnt" title="핀 수">' + zpins.length + '</span>';
              zh.addEventListener("click", (e) => {
                if (e.target.closest(".tree-caret")) { zn.classList.toggle("open"); return; }
                if (typeof Zones !== "undefined" && Zones.focus) Zones.focus(zone.id);
              });
              zn.appendChild(zh);
              const zc = document.createElement("div");
              zc.className = "tree-children";
              zpins.forEach((p) => zc.appendChild(pinNode(p, numMap)));
              zn.appendChild(zc);
              target.appendChild(zn);
            });
            rootPins.sort(sortByNo).forEach((p) => target.appendChild(pinNode(p, numMap)));
          };
          // [WO 20260930-moderole] 🔴 잎 — 프로젝트→구역→영역(공유) 다음, 이 노드가 로드된 곳에서만
          //   CHECKER N / 360 N 두 그룹을 그린다. 핀 목록·번호대·일괄삭제 범위는 그룹 안에서만
          //   계열별로 가른다(SoT: PinSeries.DECK_MODES). 클릭 = App._setRegMode(상단 세그먼트와 동일).
          const MODES = (typeof PinSeries !== "undefined" && PinSeries.DECK_MODES) || [];
          if (!MODES.length) {
            // 모드 정본 미로드(단독 모듈 하네스) — 모드 잎 없이 전체 핀을 그대로(종전 구조, 회귀 없음).
            renderScopedPins(kids, pins);
          } else {
            const actMode = (typeof PinSeries !== "undefined" && PinSeries.activeMode) ? PinSeries.activeMode() : null;
            const leafOpen = this._treeModeLeafOpen || (this._treeModeLeafOpen = new Set());
            MODES.forEach((m) => {
              const modeAll = pins.filter((p) => p && PinSeries.inMode(p, m.series));
              // [WO 46_DeckOutline 수정] 이 노드가 창(crop) 구역이면 그 크롭 안의 핀만 — SoT:
              // Projects.pinsForDeck(§31_Projects.js). 번호(numMap)·영역 소속(zoneOfPin)은 전체
              // 핀 기준 그대로 둔다(전역 채번이 깨지지 않게, 이 잎의 표시·집계 범위만 좁힌다).
              const modePinsHere = (typeof Projects !== "undefined" && Projects.pinsForDeck) ? Projects.pinsForDeck(modeAll, deck) : modeAll;
              const isAct = !!(actMode && actMode.tag === m.tag);
              const leafKey = collapseKey + ":" + m.tag;
              const mw = document.createElement("div");
              mw.className = "tree-mode-leaf tree-mode-leaf-" + m.tag + ((isAct || leafOpen.has(leafKey)) ? " open" : "");
              mw.dataset.mode = m.tag;
              const mh = document.createElement("button");
              mh.type = "button";
              mh.className = "tree-node tree-node-mode-leaf" + (isAct ? " active" : "");
              mh.setAttribute("aria-pressed", String(isAct));
              mh.title = m.label + " 작업공간" + (isAct ? " (현재 모드)" : " — 누르면 이 모드로 전환하고 이 구역/영역을 엽니다");
              mh.innerHTML = C + '<span class="tree-label">' + esc(m.label) + '</span><span class="tree-cnt" title="핀 수">' + modePinsHere.length + '</span>';
              mh.addEventListener("click", (e) => {
                const onCaret = !!(e && e.target && e.target.closest && e.target.closest(".tree-caret"));
                if (onCaret || isAct) {
                  if (mw.classList.toggle("open")) leafOpen.add(leafKey); else leafOpen.delete(leafKey);
                  return;
                }
                if (typeof App !== "undefined" && App._setRegMode) App._setRegMode(m.regMode);
                mw.classList.add("open"); leafOpen.add(leafKey);
              });
              mw.appendChild(mh);
              // [WO 20260929-bulkdel] 관리자 전용 — 범위 = 이 모드 그룹의 핀만(다른 모드 핀은 지우지 않는다).
              if (this._pinSelOk() && modePinsHere.length) {
                const acts = document.createElement("div");
                acts.className = "tree-project-actions tree-pin-bulk";
                this._pinBulkButtons({ scopePins: modePinsHere.slice(), scopeLabel: (isRegion ? "이 영역" : "이 구역") + " " + m.label })
                  .forEach(b => acts.appendChild(b));
                mw.appendChild(acts);
              }
              const mk = document.createElement("div");
              mk.className = "tree-children";
              renderScopedPins(mk, modePinsHere);
              mw.appendChild(mk);
              kids.appendChild(mw);
            });
          }
          any = true;
        }
        if (any) g.appendChild(kids);
        return g;
      };

      /* ── 1단: 프로젝트 — 2단(구역)을 바로 붙인다(도면 그룹핑 단 없음, 마스터 정정) ──── */
      let mount = host;
      if (proj) {
        const pw = mountProjectNode(rootDecks.length);
        const pk = document.createElement("div");
        pk.className = "tree-children";
        pw.appendChild(pk);
        mount = pk;
      } else {
        host.appendChild(originNode());   // [WO 20261002-allmenu §5] 프로젝트 서술자가 없어도 원본은 최상단에
      }
      /* ── 2단: 구역(두 모드 공유) — [WO 20260930-moderole] 마스터 2차 지시로 모드 가지(88e52ff)를
         제거하고 구역·영역을 프로젝트 바로 아래 한 벌만 렌더한다(중복 0). 모드 분리는 deckNode()
         안의 잎(CHECKER N/360 N)에서만 일어난다. ─────────────────────────────────────── */
      rootDecks.forEach((d) => mount.appendChild(deckNode(d, false)));
    },

    renderPinsOnMap(dropPinId) {
      const layer = this.$("pins-layer");
      layer.innerHTML = "";
      const leaderLayer = this.$("leader-layer"); // [WO 20261001-leader] 리더선 전용 SVG(핀 레이어와 형제)
      if (leaderLayer) leaderLayer.innerHTML = "";
      const curPage = State.pdfPage;
      // 🔴 번호/부류/색상 정본 = PinSeries (01b_PinSeries.js). 여기서 따로 세지 않는다.
      //    미니맵(07_Radar)도 같은 함수를 호출하므로 두 화면의 번호가 항상 일치한다.
      const numMap = PinSeries.numbers(State.pins, curPage);
      PinSeries.renderChips();
      let svgIdx = 0; // SVG gradient id 유일화용(필터로 건너뛰어도 충돌 없게 별도 카운터)
      State.pins.forEach((pin) => {
        if ((pin.page || 1) !== curPage) return; // 현재 페이지 핀만
        // 표시 필터: 숨김은 "표시만" 감춘다 — 번호(numMap)는 이미 전체 기준으로 계산됨
        if (!PinSeries.isVisible(pin)) return;
        svgIdx++;
        const pageIdx = svgIdx;
        const marker = document.createElement("div");
        marker.className = "pin-marker" + (pin.id === dropPinId ? " drop" : "")
          + (State.activePin === pin.id ? " focused" : "");
        marker.style.left = pin.x + "%";
        marker.style.top  = pin.y + "%";
        marker.dataset.id = pin.id;
        // 구역 페이지(crop-view) 진입 중이면, 해당 구역 밖 핀은 흐리게(dim)
        if (State.zoneView) {
          const _zv = (State.zones || []).find(z => z.id === State.zoneView);
          if (_zv && typeof Zones !== "undefined" && Zones._contains && !Zones._contains(_zv, pin.x, pin.y)) {
            marker.classList.add("zone-dim");
          }
        }
        const meta = numMap.get(pin.id) || { no: pageIdx, kind: PinSeries.kindOf(pin), series: PinSeries.seriesOf(pin) };
        // 🔴 색·형태 정본 = PinSeries.markerStyle (미니맵 07_Radar 도 같은 함수를 쓴다).
        //    체크보드 핀은 kind 가 늘 "checkboard" 라 kind 만으로는 사진 유무를 알 수 없다
        //    → filled 축을 따로 받아 등록/미등록을 색·링 패턴으로 구분한다.
        const _st = PinSeries.markerStyle(pin);
        const hasContent = _st.filled;
        // 🔴 [2026-09-21 WO] 위성 배지 3종(이슈·중복·작성자) 제거 — 마스터 지시("거추장스런 거 지워").
        //   이슈/중복 정보는 버리지 않는다: PinActionPop(27_PinActionPop.js open())과
        //   #pin-list(renderPinList, 위 pin-issue-badge/pin-dup-badge)에서 계속 보인다.
        //   작성자 대역 정보도 PinActionPop meta 줄로 이관(PinSeries.userMark 그대로 재사용).
        if (hasContent) marker.classList.add("has-content");
        if (pin.checkboard) marker.classList.add("checkboard"); // [체크보드 핀 색상구분] 일반 핀과 다른 색으로 표시
        marker.classList.add("pin-marker-teardrop"); // 진짜 핀(물방울) 모양 + 중앙 번호
        marker.classList.add("pin-kind-" + meta.kind); // 색맹 대비: 색 외 식별 훅
        // [WO 20260930-pinstyle] 🔴 모드별 형태·색 구분 SoT = PinSeries.seriesOf/meta.series.
        //   CHECKER 는 아래 SVG 에서 둥근사각 배지 프레임을 추가로 그리고(형태), 색은 PinSeries
        //   CHECKBOARD_COLOR/EMPTY_COLOR(주황 계열)로 이미 360(블루/그린 계열)과 갈린다.
        //   미니맵(07_Radar)·트리(pinNode)·필터칩(pinfilter-chip)·허브카드 잎이 전부 이 판정을 따른다.
        const isChecker = meta.series === "checkboard";
        marker.classList.add(isChecker ? "pin-mode-checker" : "pin-mode-360");
        // ── 번호: 콘텐츠 계열 / 체크보드 계열이 각각 1부터 독립 채번(PinSeries 정본) ──
        const dispNo = meta.no;
        // [WO 20260930-marker-no] 표시 라벨 포맷 SoT = PinSeries.formatNo(트리/핀패널과 동일:
        //   CHECKER "1" / 360 "P1"). dataset.no 는 채번 원본값 그대로 유지(회귀테스트 p4/p12 가 숫자로 비교).
        const dispLabel = (typeof PinSeries !== "undefined" && PinSeries.formatNo) ? PinSeries.formatNo(meta.no, meta.series) : String(dispNo);
        marker.dataset.no = dispNo;
        marker.dataset.kind = meta.kind;
        marker.dataset.filled = _st.filled ? "1" : "0"; // 사진 등록 여부(미니맵과 동일 판정 검증용)
        marker.classList.add(_st.filled ? "pin-filled" : "pin-hollow");
        // [WO 20260917 콘텐츠 3상태] photo(사진/영상) / content(노트·첨부만) / empty — filled 축은
        // 안 건드리고 그 안(filled=true)을 세분. 색 없이도(흑백) 구분되게 속 원판 실루엣(pin-tier-disc) 사용.
        const tier = _st.tier || (typeof PinSeries !== "undefined" ? PinSeries.contentTier(pin) : (hasContent ? "content" : "empty"));
        marker.dataset.tier = tier;
        marker.classList.add("pin-tier-" + tier);
        // ── 바늘형 핀(영역=골드와 색상 완전 분리):
        //    미배치(콘텐츠 없음)=선명한 코랄레드(#ef4444),
        //    콘텐츠 있음=사용자 설정 색상(기본 그린). 설정에서 변경 가능.
        //    바늘을 길고 가늘게 → "찌르는" 느낌. tip(18,62)으로 수렴.
        // 🔴 색상도 PinSeries 정본에서 파생 — 미니맵 점과 같은 색을 쓴다.
        const _col = _st.colors;
        const headFill  = _col.head;
        const headFill2 = _col.head2;
        const needleTip = _col.needle;
        const txtFill   = _col.text;
        // 색만으로 구분 금지(색맹 8%) → 외곽 링 패턴으로도 구분:
        // 실선=콘텐츠 등록 / 파선=체크보드(사진 등록됨) / 점선=미등록
        const ringDash  = _st.dash;
        // [WO 20260917 형태단서 재설계] 21px 실크기에서 작은 점(지름 2.2px)은 안 보인다(마스터 실측).
        // → 속 원판(inner disc)의 실루엣 자체를 티어별로 바꾼다: photo/empty=원, content=둥근사각형.
        // 흑백(색 제거)에서도 면적 차이로 구분되도록 인라인 fill 유지(CSS 소비자에 의존 금지).
        // [WO 2026-09-21] 마스터 직접 제안("동그라미를 겹친다든가") — photo(사진/영상)만
        // 원 2개를 겹쳐 그린다. empty 는 원 1개만 유지해 photo/empty 가 더는 "완전히 같은 원"이
        // 아니게 된다(이전엔 둘 다 단일 원이라 filled/hollow 머리색만으로 구분해야 했다).
        // 🔴 p9 discTag 판정은 class="pin-tier-disc" 가 붙은 첫 번째 요소의 태그만 본다(circle
        // 그대로) → 회귀 없음. 겹치는 두 번째 원은 표식용(클래스 없음)이라 판정에 관여하지 않는다.
        const tierDisc = (tier === "content")
          ? `<rect class="pin-tier-disc" x="9.8" y="6.8" width="16.4" height="16.4" rx="3" fill="#ffffff" opacity="0.99"/>`
          : (tier === "photo")
            ? `<circle class="pin-tier-disc" cx="18" cy="15" r="8.6" fill="#ffffff" opacity="0.99"/><circle cx="22.6" cy="10.4" r="4.2" fill="#ffffff" opacity="0.99" stroke="#1a1a1a" stroke-width="0.8"/>`
            : `<circle class="pin-tier-disc" cx="18" cy="15" r="8.6" fill="#ffffff" opacity="0.99"/>`;
        // [WO 20260929] 체크보드 모드에서는 체크보드 핀의 번호만 보이게 — 장식(펄스·그라디언트·
        // 그림자·티어 원판 모양 구분·아이콘 오버라이드) 최소화. 앵커(tip 18,60)는 원본과 동일
        // 유지해 좌표 위치가 어긋나지 않는다. 대비 쌍(흰 원판+txtFill)도 기존 검증값 그대로 재사용.
        const simplifiedCheckboard = (State.regMode === "checkboard" && pin.checkboard === true);
        marker.innerHTML = simplifiedCheckboard ? `
          <div class="pin-pin">
            <svg viewBox="0 0 36 64" xmlns="http://www.w3.org/2000/svg">
              <!-- [WO 20260930-pinstyle] CHECKER 간소화 배지 = 둥근 사각(rounded-square) — 360(원형
                   메달리온)과 형태부터 다르게. 앵커(tip 18,60)는 원본과 동일(회귀 없음). -->
              <path d="M15.3 27 L18 60 L20.7 27 Z" fill="${headFill2}"/>
              <rect x="5.6" y="2.6" width="24.8" height="24.8" rx="6" fill="${_st.filled ? headFill : "none"}" stroke="#ffffff" stroke-width="2"/>
              <rect x="9.4" y="6.4" width="17.2" height="17.2" rx="3.4" fill="#ffffff"/>
              <text x="18" y="15.4" text-anchor="middle" dominant-baseline="central" font-family="'Segoe UI',sans-serif" font-size="${String(dispLabel).length >= 3 ? 9 : 13}" font-weight="900" fill="${txtFill}">${dispLabel}</text>
            </svg>
          </div>` : `
          ${hasContent ? '<div class="pin-pulse"></div>' : ''}
          <div class="pin-pin">
            <svg viewBox="0 0 36 64" xmlns="http://www.w3.org/2000/svg">
              <defs>
                <radialGradient id="pgbody${pageIdx}" cx="38%" cy="30%" r="78%">
                  <stop offset="0%" stop-color="${headFill}"/>
                  <stop offset="100%" stop-color="${headFill2}"/>
                </radialGradient>
                <linearGradient id="pgstem${pageIdx}" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color="${headFill2}"/>
                  <stop offset="100%" stop-color="${needleTip}"/>
                </linearGradient>
                <filter id="pgshadow${pageIdx}" x="-60%" y="-20%" width="220%" height="180%">
                  <feDropShadow dx="0" dy="2.2" stdDeviation="1.7" flood-color="rgba(0,0,0,.5)"/>
                </filter>
              </defs>
              <!-- ISO 접지 그림자(바닥 타원) → 360 뷰포인트가 도면 위에 '서 있는' 입체감 -->
              <ellipse cx="18" cy="60.5" rx="6.2" ry="2.3" fill="#000" opacity="0.22"/>
              <!-- 받침대 줄기: 머리에서 접지점(18,60)으로 수렴 -->
              <path d="M14.2 22 L18 60 L21.8 22 Z" fill="url(#pgstem${pageIdx})" filter="url(#pgshadow${pageIdx})"/>
              <!-- [WO 20260930-pinstyle] CHECKER 전용 배지 프레임(둥근 사각) — 원 머리 뒤에 깔아
                   모서리가 보이게 해 360(원형 메달리온)과 실루엣이 다르게 보인다. 원의 등록/미등록
                   fill 토글(테스트 p9 대상)은 그대로 유지 — 프레임은 장식용 배경일 뿐 원을 대체하지 않는다. -->
              ${isChecker ? `<rect x="3.6" y="2" width="28.8" height="27" rx="7.5" fill="${_st.filled ? "#fff7ed" : "#ffffff"}" opacity="0.95" stroke="#1a1a1a" stroke-width="1.6" stroke-opacity="0.45"/>` : ""}
              <!-- [대비강화] 도면(촘촘한 선) 위에서도 또렷하게: 진한 외곽 링 -->
              <circle cx="18" cy="15" r="12.4" fill="none" stroke="#1a1a1a" stroke-width="3.2" opacity="0.5"${ringDash ? ` stroke-dasharray="${ringDash}" stroke-linecap="round"` : ""}/>
              <!-- 메달리온 머리 -->
              <circle cx="18" cy="15" r="11.8" fill="${_st.filled ? `url(#pgbody${pageIdx})` : "none"}" stroke="${_st.filled ? "#ffffff" : headFill2}" stroke-width="${_st.filled ? 2.4 : 3.2}"/>
              <!-- [WO 20260928 번호 복구] 마스터 지시("번호가 안본다") — 9/21 지시는 "숫자 풍선"
                   (머리 밖 별도 배지)을 없애라는 뜻이었는데 머리 안 번호까지 지워 회귀가 났다.
                   상태(등록 fill/tier 원판/링 dash)는 그대로 유지하고, 흰 원판(tierDisc) 위에
                   번호만 다시 그린다 — 원판이 항상 흰색이라 txtFill(진한 계열색)과 대비 ≥4.5:1 보장.
                   3자리 이상(101~)은 원판을 넘치지 않게 폰트를 축소한다.
                   [WO 20260929 재회귀 수정] 마스터: "번호가 왜 사라졌는지" — 커스텀 아이콘을
                   고른 핀은 번호 텍스트 대신 아이콘만 그려서 여전히 번호가 안 보였다. 이제
                   아이콘 유무와 무관하게 번호는 항상 그리고, 아이콘은 버리지 않고 머리 우상단
                   모서리의 작은 보조 배지(중심은 머리 원 반경 12.4 위 45° 지점 — 표준 "아바타
                   코너 배지" 위치)로 옮긴다. 배지 아이콘 색도 txtFill 재사용(원판과 동일하게
                   대비 ≥4.5:1 이미 보장된 값이라 별도 실측 불필요 — ≥3:1 요구보다 넉넉함). -->
              <!-- [WO 20260917 형태단서] 속 원판 실루엣으로 티어 구분(원=photo/empty, 둥근사각형=content) -->
              ${tierDisc}
              <text x="18" y="15.4" text-anchor="middle" dominant-baseline="central" font-family="'Segoe UI',sans-serif" font-size="${String(dispLabel).length >= 3 ? 9 : 13}" font-weight="900" fill="${txtFill}">${dispLabel}</text>
              ${(typeof PinIcons !== "undefined" && pin.icon && pin.icon !== "number")
                ? `<circle class="pin-icon-badge" cx="26.8" cy="6.3" r="5.4" fill="#ffffff" stroke="${headFill2}" stroke-width="1.3"/>${PinIcons.headMarkup(pin.icon, txtFill, 6.3, 26.8, 0.32)}`
                : ""}
              <!-- 머리 하이라이트(광택) -->
              <ellipse cx="14" cy="10.5" rx="3.4" ry="2.1" fill="#ffffff" opacity="0.5"/>
            </svg>
          </div>`;
        // [WO 20261010-revision] 개정 이월된 핀 = "검토 필요" 배지(사람이 확정·이동하면 revReview=null 로 사라짐).
        //   색은 인라인 리터럴 #111827 on #fde68a = 14.2:1(테마 변수 재해석 함정 회피). 도면 밖으로 나간 핀은 "도면 밖".
        if (pin.revReview) {
          marker.classList.add("pin-rev-review");
          const rb = document.createElement("span");
          rb.className = "pin-rev-badge";
          rb.textContent = pin.revReview.out ? "도면 밖" : "검토";
          rb.title = "도면 개정으로 좌표가 이월된 핀 — 위치를 확인하고 [개정 이력]에서 확정하세요";
          rb.style.cssText = "position:absolute;left:50%;top:-16px;transform:translateX(-50%);background:#fde68a;color:#111827;border:1px solid #111827;"
            + "border-radius:6px;font-size:11px;font-weight:800;line-height:1;padding:2px 4px;white-space:nowrap;pointer-events:none;z-index:3;";
          marker.appendChild(rb);
        }
          /* [마스터 요청] 핀 위 hover 액션버튼(.pin-actions) 제거 — 상단 "포인트 수정" 모드로 일원화.
             수정/이동/삭제/보기는 포인트수정 모드에서 핀 클릭 → PinActionPop 으로. */
        // ── 디자이너: 포인터 드래그로 핀 위치 이동 (click 과 구분: 이동 임계값) ──
        if (State.mode === "designer") {
          marker.classList.add("draggable");
          let dragging = false, moved = false, startX = 0, startY = 0;
          const onMove = (ev) => {
            const cx = ev.touches ? ev.touches[0].clientX : ev.clientX;
            const cy = ev.touches ? ev.touches[0].clientY : ev.clientY;
            if (!dragging) return;
            if (!moved && Math.hypot(cx - startX, cy - startY) < 5) return; // 임계값 미만은 클릭으로 취급
            moved = true;
            State.movingPinId = pin.id;
            marker.classList.add("moving");
            const pct = MapCtrl.viewportToPercent(cx, cy);
            if (pct) {
              pin.x = Math.max(0, Math.min(100, pct.x));
              pin.y = Math.max(0, Math.min(100, pct.y));
              marker.style.left = pin.x + "%";
              marker.style.top  = pin.y + "%";
              const lbl = marker.querySelector(".pin-marker-label");
              // 좌표 라이브 갱신은 리스트 쪽에서 (성능 위해 드래그 끝에 한 번)
            }
            if (ev.cancelable) ev.preventDefault();
          };
          const onUp = () => {
            document.removeEventListener("pointermove", onMove);
            document.removeEventListener("pointerup", onUp);
            document.removeEventListener("touchmove", onMove);
            document.removeEventListener("touchend", onUp);
            dragging = false;
            marker.classList.remove("moving");
            if (moved) {
              State.movingPinId = null;
              State.pinEditUnlocked = null; // 이동 끝나면 다시 잠금
              if (pin.revReview) {   // [WO 20261010-revision] 사람이 직접 옮김 = 위치 확정(검토 배지 해제)
                pin.revReview = null;
                marker.classList.remove("pin-rev-review");
                const _rb = marker.querySelector(".pin-rev-badge"); if (_rb) _rb.remove();
              }
              if (typeof Zones !== "undefined" && Zones.refreshPinLinks) Zones.refreshPinLinks();
              UI.renderPinList();
              if (typeof Zones !== "undefined") Zones.render();
              Prompt.toast("'" + pin.label + "' 위치 이동됨 · 자동저장");
              App._autoSave();
            }
          };
          const onDown = (ev) => {
            if (State.placing) return; // 배치 모드에서는 드래그 비활성
            if (State.isoView) { Prompt.toast("ISO 3D 뷰에서는 위치 이동이 불가합니다. 평면 뷰로 전환하세요."); return; }
            // ── 요청사항 #6: '수정' 버튼으로 잠금 해제한 핀만 드래그 이동 가능 ──
            if (State.pinEditUnlocked !== pin.id) {
              // 잠긴 상태 → 클릭으로만 동작(보기). 이동하려면 수정 버튼을 눌러야 함.
              return;
            }
            startX = ev.touches ? ev.touches[0].clientX : ev.clientX;
            startY = ev.touches ? ev.touches[0].clientY : ev.clientY;
            dragging = true; moved = false;
            document.addEventListener("pointermove", onMove, { passive: false });
            document.addEventListener("pointerup", onUp);
            document.addEventListener("touchmove", onMove, { passive: false });
            document.addEventListener("touchend", onUp);
          };
          marker.addEventListener("pointerdown", onDown);
          marker.addEventListener("click", e => {
            e.stopPropagation();
            if (moved) { moved = false; return; } // 드래그 직후 클릭 무시
            if (State.pinEditUnlocked === pin.id) return; // 이동 잠금해제 상태에서는 클릭 무시(드래그 대기)
            // ── [WO 20260929 마스터 정정] 체크보드·사진등록 모드에서 기존 핀 클릭 = 항상 패널
            //   (번호수정·사진/노트 등록 가능). ISO 전환/줌(onPinTap)이 화면을 되돌리던 결함을
            //   막는다 — 핀 클릭이 배치 클릭보다 우선한다(지휘자 정정 원문, 새 핀 겹쳐 생기지 않음).
            const wantsPanel = State.editMode || State.regMode === "checkboard" || State.regMode === "photo";
            if (wantsPanel && typeof PinActionPop !== "undefined") {
              App.setActivePin(pin.id);
              PinActionPop.open(pin.id);
            } else {
              // ── [마스터 요청] 핀 선택 → ISO 전환 + 구역 확대(첫 탭), 같은 핀 둘째 탭 → 360° ──
              App.onPinTap(pin);
            }
          });
          // [WO 20261008-pinstyle §3] 우클릭·길게 누르기 = 앱 메뉴(UI.openCtxMenu — 첫 항목 [열기] = 종전 작업 팝업).
          //   배선은 한 곳(UI.bindCtxMenu: document contextmenu 캡처 + 지도 길게 누르기)이다 — 여기 따로 걸면 두 번 열린다.
          // 액션 아이콘 바인딩 (보기/이동/수정/삭제)
          marker.querySelectorAll(".pin-act").forEach(btn => {
            btn.addEventListener("click", ev => {
              ev.stopPropagation();
              const act = btn.dataset.act;
              if (act === "view") App.openPano(pin);
              else if (act === "move") {
                // ── #6: 이동 잠금 해제 후 드래그 안내 ──
                State.pinEditUnlocked = pin.id;
                marker.classList.add("edit-unlocked");
                Prompt.toast("'" + pin.label + "' 이동 잠금 해제 — 핀을 드래그하세요");
              }
              else if (act === "edit") {
                // ── #6: 수정 버튼 → 편집 폼 + 이동 잠금 해제(사진추가/위치이동 가능) ──
                State.pinEditUnlocked = pin.id;
                App.editPin(pin.id);
              }
              else if (act === "del") App.deletePin(pin.id);
            });
          });
        } else {
          marker.addEventListener("click", e => {
            e.stopPropagation();
            // [마스터 요청] 뷰어도 동일: 첫 탭 → ISO+구역 확대, 둘째 탭 → 360°
            App.onPinTap(pin);
          });
        }
        layer.appendChild(marker);
        // [WO 20261008-pinstyle §1] 🔴 핀 표현 1종 — 기본은 마커(핀)만. 리더선은 핀별 선택(Leader.wants SoT)일
        //   때만 그리고, 그때는 마커를 감춘다(두 표현 동시 금지). 마커는 DOM 에 남겨 클릭 배선(풍선 → marker.click)
        //   과 번호 메타를 그대로 쓴다. 리더를 실제로 그렸을 때만 감춘다(그릴 수 없는 환경에서 핀이 사라지지 않게).
        if (this.Leader.wants(pin) && leaderLayer
            && this._renderLeader(leaderLayer, layer, pin, marker, dispLabel, headFill2, txtFill, isChecker)) {
          marker.classList.add("pin-as-leader");
          marker.style.display = "none";
        }
      });
      if (typeof Zones !== "undefined") Zones.render();
      if (typeof PdfAnno !== "undefined") PdfAnno.refresh();
      // [WO 20261007-qrcov] 촬영 현황 — 필터 바 토글·범례 + (켜졌을 때) 핀 링·배지. 숨김 0.
      if (typeof Coverage !== "undefined" && Coverage.decorate) { try { Coverage.decorate(); } catch (e) {} }
      // ── [마스터 요청] 렌더 직후에도 ISO면 핀을 즉시 수직(빌보드)으로 세움 ──
      if (typeof MapCtrl !== "undefined" && MapCtrl._applyPinBillboard) MapCtrl._applyPinBillboard();
    },

    /** [WO 20261001-leader §3] 핀 1개의 리더선(SVG: 사선+랜딩+화살촉)과 번호 풍선(HTML div)을 그린다.
     *  구성: 화살촉(빨강 채움 삼각형, 대상 쪽) → 사선 리더 → 풍선 쪽 짧은 수평 랜딩 → 원형 풍선(번호).
     *  풍선이 대상의 왼쪽이면 랜딩도 반대 방향(좌측)으로 그린다.
     *  선 두께는 vector-effect="non-scaling-stroke"로 줌과 무관하게 화면상 고정.
     *  풍선 크기·글자는 MapCtrl.pinScreenScale()과 동일한 역스케일(._applyPinBillboard, pin-leader-bubble
     *  분기)로 화면 기준 고정 — 풍선을 pins-layer 의 자식으로 두어 그 반복문을 그대로 공유한다. */
    _renderLeader(leaderLayer, pinsLayer, pin, marker, dispLabel, lineColor, txtFill, isChecker) {
      // 🔴 [형제 호출부 보호] 기존 회귀테스트(p4/p9/p12/p50/p54/p55/p79/p91/p101 등 10여 개)는
      // 경량 가짜 document(SVG 네임스페이스 API 無)로 renderPinsOnMap()을 구동한다. 실 브라우저는
      // 항상 createElementNS 를 지원하므로 운영 동작엔 영향 없이, 이 환경에서만 리더(장식)를
      // 생략하고 마커 렌더(이미 검증된 회귀 대상)는 그대로 유지한다.
      if (typeof document.createElementNS !== "function") return false;
      const co = this.Leader.calloutOf(pin);
      const svgNS = "http://www.w3.org/2000/svg";
      const g = document.createElementNS(svgNS, "g");
      g.setAttribute("class", "pin-leader-g");
      g.dataset.id = pin.id;
      const path = document.createElementNS(svgNS, "path");
      path.setAttribute("class", "pin-leader-line");
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", "#dc2626");
      path.setAttribute("vector-effect", "non-scaling-stroke");
      g.appendChild(path);
      // 화살촉(대상 쪽 = 촉, 밑변은 선 쪽) — 기하는 Leader.geometry 한 곳(풍선과 같은 역스케일)
      const arrow = document.createElementNS(svgNS, "polygon");
      arrow.setAttribute("class", "pin-leader-arrow");
      arrow.setAttribute("fill", "#dc2626");
      g.appendChild(arrow);
      this._renderLeaderLineOnly(leaderLayer, pin, g, path, arrow);
      leaderLayer.appendChild(g);

      // 풍선(HTML, 고정 px — pin-marker 와 같은 줌 역스케일 반복문(_applyPinBillboard)을 공유)
      const bubble = document.createElement("div");
      bubble.className = "pin-leader-bubble" + (isChecker ? " pin-leader-checker" : " pin-leader-360");
      bubble.style.left = co.x + "%";
      bubble.style.top  = co.y + "%";
      bubble.dataset.id = pin.id;
      bubble.dataset.calloutX = String(co.x);
      bubble.dataset.calloutY = String(co.y);
      const fs = String(dispLabel).length >= 3 ? 8 : 11;
      bubble.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" xmlns="http://www.w3.org/2000/svg">
        <circle cx="12" cy="12" r="10.4" fill="#ffffff" stroke="${lineColor || "#b91c1c"}" stroke-width="2"/>
        <text x="12" y="12.6" text-anchor="middle" dominant-baseline="central" font-family="'Segoe UI',sans-serif" font-size="${fs}" font-weight="800" fill="${txtFill || "#1a1a1a"}">${dispLabel}</text>
      </svg>`;
      // 클릭 = 기존 마커 클릭과 동일 동작(핀 패널 열기 등) — SoT 중복 없이 그대로 전달
      bubble.addEventListener("click", (e) => { e.stopPropagation(); marker.click(); });
      // 드래그 = 콜아웃만 이동(대상/화살촉은 불변). 마커 이동과 동일한 잠금 규칙(pinEditUnlocked) 재사용.
      if (State.mode === "designer") {
        bubble.classList.add("draggable");
        let dragging = false, moved = false, startX = 0, startY = 0;
        const onMove = (ev) => {
          const cx = ev.touches ? ev.touches[0].clientX : ev.clientX;
          const cy = ev.touches ? ev.touches[0].clientY : ev.clientY;
          if (!dragging) return;
          if (!moved && Math.hypot(cx - startX, cy - startY) < 5) return;
          moved = true;
          bubble.classList.add("moving");
          const pct = MapCtrl.viewportToPercent(cx, cy);
          if (pct) {
            pin.callout = { x: pct.x, y: pct.y };
            bubble.style.left = pct.x + "%";
            bubble.style.top  = pct.y + "%";
            this._renderLeaderLineOnly(leaderLayer, pin, g, path, arrow);
          }
          if (ev.cancelable) ev.preventDefault();
        };
        const onUp = () => {
          document.removeEventListener("pointermove", onMove);
          document.removeEventListener("pointerup", onUp);
          document.removeEventListener("touchmove", onMove);
          document.removeEventListener("touchend", onUp);
          dragging = false;
          bubble.classList.remove("moving");
          if (moved) {
            if (typeof App !== "undefined" && App._markDirty) App._markDirty();
            Prompt.toast && Prompt.toast("풍선 위치 이동됨 · 자동저장");
            if (typeof App !== "undefined" && App._autoSave) App._autoSave();
          }
        };
        bubble.addEventListener("pointerdown", (ev) => {
          if (State.pinEditUnlocked !== pin.id) return; // 마커와 동일한 잠금 규칙
          startX = ev.touches ? ev.touches[0].clientX : ev.clientX;
          startY = ev.touches ? ev.touches[0].clientY : ev.clientY;
          dragging = true; moved = false;
          document.addEventListener("pointermove", onMove, { passive: false });
          document.addEventListener("pointerup", onUp);
          document.addEventListener("touchmove", onMove, { passive: false });
          document.addEventListener("touchend", onUp);
        });
      }
      pinsLayer.appendChild(bubble);
      return true;
    },
    /** 선/화살촉만 갱신 — 드래그 중(리페인트 없이)·줌 변경(MapCtrl._applyPinBillboard → refreshLeaders)이 공유.
     *  기하 SoT = Leader.geometry(풍선과 같은 역스케일 MapCtrl.pinScreenScale). */
    _renderLeaderLineOnly(leaderLayer, pin, g, path, arrow) {
      const co = this.Leader.calloutOf(pin);
      const t = this.$("map-transform");
      const inv = (typeof MapCtrl !== "undefined" && MapCtrl.pinScreenScale) ? MapCtrl.pinScreenScale() : 1;
      const geo = this.Leader.geometry(pin, co, t && t.offsetWidth, t && t.offsetHeight, inv, State.zoom || 1);
      path.setAttribute("d", geo.d);
      path.setAttribute("stroke-width", geo.strokePx.toFixed(2));
      arrow.setAttribute("points", geo.points);
    },
    /** [WO 20261008-pinstyle §2] 줌이 바뀌면 화살촉·선 굵기를 풍선과 같은 역스케일로 다시 계산한다
     *  (풍선은 _applyPinBillboard 가 CSS scale 로, 화살촉은 SVG 좌표라 여기서). DOM 재생성 없음. */
    refreshLeaders() {
      const ll = this.$("leader-layer");
      if (!ll || !ll.children) return;
      Array.from(ll.children).forEach((g) => {
        const id = g.dataset && g.dataset.id;
        const pin = (State.pins || []).find((p) => String(p.id) === String(id));
        const path = g.querySelector && g.querySelector(".pin-leader-line");
        const arrow = g.querySelector && g.querySelector(".pin-leader-arrow");
        if (pin && path && arrow) this._renderLeaderLineOnly(ll, pin, g, path, arrow);
      });
    },
    /** [WO 20261008-pinstyle §1] 핀별 리더선 켜기/끄기 — 데이터는 pin.leader(boolean)만. 저장은 기존 LWW 경로
     *  (App._markDirty → PinSeries.stampChanged 전체 JSON 비교). 일괄(설정·전체 기능 메뉴)·우클릭 메뉴가 공유.
     *  @returns 바뀐 핀 수 */
    setPinsLeader(pins, on) {
      let n = 0;
      (pins || []).forEach((p) => { if (p && this.Leader.wants(p) !== !!on) n++; if (p) p.leader = !!on; });
      if (typeof App !== "undefined" && App._markDirty) App._markDirty();
      if (typeof App !== "undefined" && App._keepLocal) { try { App._keepLocal(); } catch (e) {} }
      this.renderPinsOnMap();
      return n;
    },
    /** 일괄 대상 = 정렬과 같은 범위(선택한 핀 · 없으면 지금 보는 구역·영역의 현재 모드 핀) — _alignScopePins SoT. */
    bulkLeader(on) {
      const pins = this._alignScopePins();
      if (!pins.length) { Prompt.toast("대상 포인트가 없습니다 — 포인트를 선택하거나 구역을 여세요"); return 0; }
      const n = this.setPinsLeader(pins, on);
      Prompt.toast(pins.length + "개 포인트 " + (on ? "리더선으로 표시" : "핀으로 표시") + (n !== pins.length ? " (변경 " + n + "개)" : ""));
      return n;
    },

    updatePdfPagination() {
      const total = State.mode === "viewer" && State.viewerPages
        ? State.viewerPages.length : State.pdfPages;
      if (total > 1) {
        this.$("pdf-pagination").classList.remove("hidden");
        const jump = this.$("input-page-jump");
        if (jump && document.activeElement !== jump) jump.value = State.pdfPage;
        this.text("page-total", "/ " + total);
        this.$("btn-first-page").disabled = State.pdfPage <= 1;
        this.$("btn-prev-page").disabled  = State.pdfPage <= 1;
        this.$("btn-next-page").disabled  = State.pdfPage >= total;
        this.$("btn-last-page").disabled  = State.pdfPage >= total;
      } else {
        this.$("pdf-pagination").classList.add("hidden");
      }
      // 새 ezPDF 툴바 페이지 동기화 (단일 페이지도 1/1 표시)
      const tbInput = this.$("tb-page-input");
      if (tbInput && document.activeElement !== tbInput) tbInput.value = State.pdfPage;
      this.text("tb-page-total", "/ " + (total || 1));
      const setDis = (id, v) => { const el = this.$(id); if (el) el.disabled = v; };
      setDis("tb-first", State.pdfPage <= 1);
      setDis("tb-prev",  State.pdfPage <= 1);
      setDis("tb-next",  State.pdfPage >= (total || 1));
      setDis("tb-last",  State.pdfPage >= (total || 1));
      // 모바일 도크 '페이지' 칩에 현재 n/N 배지 (멀티페이지만)
      const pageBadge = this.$("mdock-page-badge");
      if (pageBadge) {
        if ((total || 1) > 1) { pageBadge.textContent = State.pdfPage + "/" + total; pageBadge.classList.remove("hidden"); }
        else pageBadge.classList.add("hidden");
      }
    },

    /** 좌측 썸네일 도킹 패널 토글 (ezPDF 스타일) */
    toggleThumbPanel(force) {
      const strip = this.$("pdf-thumb-strip");
      const btn = this.$("tb-thumbs");
      if (!strip) return;
      const willHide = (typeof force === "boolean") ? !force : !strip.classList.contains("hidden");
      strip.classList.toggle("hidden", willHide);
      strip.classList.toggle("docked", !willHide);
      document.body.classList.toggle("thumbs-open", !willHide);
      if (btn) btn.classList.toggle("active", !willHide);
      if (!willHide && typeof this.renderPdfThumbs === "function") this.renderPdfThumbs();
    },

    /** 회전 각도 라벨 + 버튼 노출 (도면 로드 시에만 표시) */
    updateRotationLabel() {
      const grp = this.$("rotate-group");
      if (!grp) return;
      const hasDoc = !!(State.fileType && (State.pdfDoc || State.imageUrl || State.viewerPages));
      grp.classList.toggle("hidden", !hasDoc);
      const lbl = this.$("rotate-level");
      if (lbl) lbl.textContent = (State.pdfRotation || 0) + "°";
    },

    /** 멀티페이지 PDF 썸네일 스트립 (디자이너 PDF 전용) */
    async renderPdfThumbs() {
      const strip = this.$("pdf-thumb-strip");
      if (!strip) return;
      // 디자이너 PDF + 2페이지 이상에서만 표시
      const show = State.mode === "designer" && State.fileType === "pdf"
        && State.pdfDoc && State.pdfPages > 1;
      strip.classList.toggle("hidden", !show);
      if (!show) { strip.innerHTML = ""; return; }

      // 최초 1회만 썸네일 캐시 생성 (페이지 전환 시 재생성 방지)
      if (this._thumbDocId !== State.pdfDoc || strip.childElementCount !== State.pdfPages) {
        this._thumbDocId = State.pdfDoc;
        const docRef = State.pdfDoc;
        strip.innerHTML = "";
        // 1) 버튼(틀)은 전부 즉시 생성 — 클릭/번호는 곧바로 동작
        const items = [];
        for (let p = 1; p <= State.pdfPages; p++) {
          const item = document.createElement("button");
          item.className = "pdf-thumb-item";
          item.dataset.page = p;
          item.title = p + " 페이지";
          item.innerHTML =
            `<canvas class="pdf-thumb-canvas"></canvas><span class="pdf-thumb-no">${p}</span>`;
          item.addEventListener("click", () => App._gotoPage(p));
          strip.appendChild(item);
          items.push(item);
        }
        // 2) [성능] 모든 페이지를 한꺼번에 순차 렌더하면 1~3초 지연 → 처음 보이는 8장만 즉시,
        //    나머지는 유휴 시간에 한 장씩(도면이 바뀌면 즉시 중단). 첫 표시 체감 즉각.
        const FIRST = 8;
        const head = Math.min(FIRST, State.pdfPages);
        for (let p = 1; p <= head; p++) this._renderThumbInto(items[p - 1].querySelector("canvas"), p);
        if (State.pdfPages > FIRST) {
          const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 200));
          const step = (p) => {
            if (this._thumbDocId !== docRef || p > State.pdfPages) return; // 도면 전환/끝 → 중단
            this._renderThumbInto(items[p - 1].querySelector("canvas"), p);
            idle(() => step(p + 1));
          };
          idle(() => step(FIRST + 1));
        }
      }
      // 현재 페이지 하이라이트
      Array.from(strip.children).forEach((el) => {
        const active = Number(el.dataset.page) === State.pdfPage;
        el.classList.toggle("active", active);
        if (active) el.scrollIntoView({ block: "nearest", inline: "nearest" });
      });
    },

    async _renderThumbInto(canvas, pageNum) {
      try {
        const page = await State.pdfDoc.getPage(pageNum);
        const rot = ((page.rotate || 0) + (State.pdfRotation || 0)) % 360;
        const base = page.getViewport({ scale: 1, rotation: rot });
        const scale = 120 / Math.max(base.width, base.height); // 최대 변 120px
        const vp = page.getViewport({ scale, rotation: rot });
        canvas.width = Math.round(vp.width);
        canvas.height = Math.round(vp.height);
        await page.render({ canvasContext: canvas.getContext("2d", { alpha: false }), viewport: vp }).promise;
      } catch (e) { /* 썸네일 실패는 무시 */ }
    }
  };

  /* ══════════════════════════════════════════
     PROJECT HUB  ── 첫 화면 = 프로젝트 선택 대시보드 (상용툴 모방)
       · 로그인 안 함/뷰어: 카드 클릭 → 뷰어로 해당 프로젝트 열람
       · 디자이너/슈퍼: "+새 프로젝트" + 카드 편집/삭제, 카드 클릭 → 디자이너 작업
  ══════════════════════════════════════════ */