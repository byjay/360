  /* ══════════════════════════════════════════
     [WO 20261008-comparesync] 360 동기 비교 — 두 파노라마를 나란히 띄우고
     한쪽을 돌리면(드래그/휠/핀치) 다른 쪽도 같은 yaw/pitch/fov로 따라온다.
     (OpenSpace 방식 — 마스터 결정 2026-10-08 "(가)")
     · 뷰어 2개는 06_PanoViewer.createViewerCore()로 각각 생성한 완전 독립 인스턴스
       (씬/카메라/렌더러/텍스처 전부 분리 — 메인 싱글턴 PanoViewer 는 건드리지 않음).
     · [동기화 끄기] 중에는 서로 독립 — 다시 켤 때 "그 순간의 yaw 차이"를 오프셋으로 고정해
       이후 드래그에서도 그 정렬을 유지한다(요구사항 그대로).
     · 평면 클립 비교(15_Compare.js의 openFlat)는 보조 모드 — 이 오버레이의
       [평면 슬라이더] 버튼으로 전환, 기존 기능은 숨기지 않고 그대로 둔다.
  ══════════════════════════════════════════ */
  const CompareSync = {
    _left: null, _right: null,
    _shots: [], _idxA: 0, _idxB: 0,
    _sync: true, _offsetLon: 0,
    _dragSide: null, _lx: 0, _ly: 0,
    _pinch: { left: null, right: null },
    _busy: false, _bound: false,
    _designMode: false, _designPin: null, _designOverlayOn: false,

    /** 열기 — TimeLapse의 시점(사진 이력)이 2개 이상이고 양쪽 다 정적 이미지일 때만 성공.
     *  반환 true = 360 동기 비교로 열림, false = 호출측(Compare.open)이 평면 모드로 대체해야 함. */
    async open() {
      if (this._busy) return false;
      if (typeof window === "undefined" || !window.THREE) return false;
      if (typeof TimeLapse === "undefined" || !TimeLapse.hasMultiple()) return false;
      const shots = TimeLapse._shots;
      const n = shots.length;
      this._shots = shots;
      this._idxA = n - 2; this._idxB = n - 1; // 기본값 = 최신 대 직전
      this._busy = true;
      try {
        const loaded = await this._loadBoth();
        if (!loaded) { this._busy = false; return false; }
        const ov = document.getElementById("pano-compare-360");
        if (!ov) { this._busy = false; return false; }
        ov.classList.remove("hidden");
        this._sync = true; this._offsetLon = 0;
        this._renderSelects();
        this._bind();
        this._left.resize(); this._right.resize();
        this._left.start(); this._right.start();
        this._busy = false;
        return true;
      } catch (e) {
        this._busy = false;
        return false;
      }
    },

    /** idxA/idxB 가 가리키는 두 시점을 해석해 두 코어에 로드. 영상이 섞여 있으면 false. */
    async _loadBoth() {
      const a = this._shots[this._idxA], b = this._shots[this._idxB];
      if (!a || !b) return false;
      const [ra, rb] = await Promise.all([TimeLapse._resolveSrc(a), TimeLapse._resolveSrc(b)]);
      if (!ra || !rb || ra.isVideo || rb.isVideo) return false;
      if (!this._left) this._left = PanoViewer.createViewerCore(document.getElementById("cmp360-canvas-a"));
      if (!this._right) this._right = PanoViewer.createViewerCore(document.getElementById("cmp360-canvas-b"));
      if (!this._left || !this._right) return false;
      await Promise.all([this._left.loadImage(ra.src), this._right.loadImage(rb.src)]);
      this._left.setState({ lon: 0, lat: 0, fov: 75 });
      this._right.setState({ lon: 0, lat: 0, fov: 75 });
      const labelA = document.getElementById("cmp360-label-a"), labelB = document.getElementById("cmp360-label-b");
      if (labelA) labelA.textContent = a.label;
      if (labelB) labelB.textContent = b.label;
      return true;
    },

    /* ══════════════════════════════════════════
       [WO 20261019-gap1 R1] 설계 360 비교 — TimeLapse 시점 대신 핀의 현장 사진(imageId)과
       설계 360(designImageId, 72_DesignCompare.js 가 등록)을 좌우에 띄운다. 위의 open()과
       같은 뷰어 코어·캔버스·드래그/동기화 로직을 그대로 재사용(새 수식 0) — 여기서 다른 점은
       "시점 두 개를 어디서 가져오는가"와 요(yaw) 오프셋을 핀에 저장하는 것뿐이다.
       열람자는 비교만(오프셋 저장은 _canEdit 체크, 등록은 PinActionPop 쪽에서 이미 막는다). ══════ */
    async openDesign(pin) {
      if (this._busy) return false;
      if (typeof window === "undefined" || !window.THREE) return false;
      if (!pin || !pin.imageId || !pin.designImageId) {
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("현장 사진과 설계 360 이 모두 등록돼야 비교할 수 있습니다.");
        return false;
      }
      this._busy = true;
      try {
        const [fieldSrc, designSrc] = await Promise.all([
          (typeof Cloud !== "undefined" && Cloud.fetchImage) ? Cloud.fetchImage(pin.imageId) : null,
          (typeof Cloud !== "undefined" && Cloud.fetchImage) ? Cloud.fetchImage(pin.designImageId) : null
        ]);
        if (!fieldSrc || !designSrc) {
          this._busy = false;
          if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("이미지를 불러오지 못했습니다.");
          return false;
        }
        const ov = document.getElementById("pano-compare-360");
        if (!ov) { this._busy = false; return false; }
        if (!this._left) this._left = PanoViewer.createViewerCore(document.getElementById("cmp360-canvas-a"));
        if (!this._right) this._right = PanoViewer.createViewerCore(document.getElementById("cmp360-canvas-b"));
        if (!this._left || !this._right) { this._busy = false; return false; }
        await Promise.all([this._left.loadImage(fieldSrc), this._right.loadImage(designSrc)]);
        this._designMode = true; this._designPin = pin; this._shots = [];
        this._offsetLon = Number.isFinite(pin.designYawOffset) ? pin.designYawOffset : 0;
        this._left.setState({ lon: 0, lat: 0, fov: 75 });
        this._right.setState({ lon: this._offsetLon, lat: 0, fov: 75 });
        const labelA = document.getElementById("cmp360-label-a"), labelB = document.getElementById("cmp360-label-b");
        if (labelA) labelA.textContent = "현장 최신";
        if (labelB) labelB.textContent = "설계 360";
        ov.classList.remove("hidden");
        this._sync = true;
        this._ensureDesignControls();
        this._applyDesignUI(true);
        this._bind();
        this._left.resize(); this._right.resize();
        this._left.start(); this._right.start();
        this._busy = false;
        return true;
      } catch (e) {
        this._busy = false;
        return false;
      }
    },

    /** 비교 바(.cmp360-bar) 안에 요 오프셋 슬라이더 + 겹쳐보기 투명도 + 저장 버튼을 1회 런타임 주입
     *  (index.html 미수정 — 19_PinGrid/47_Report 와 같은 관례). */
    _ensureDesignControls() {
      if (document.getElementById("cmp360-design-bar")) return;
      const bar = document.querySelector(".cmp360-bar");
      if (!bar) return;
      const wrap = document.createElement("div");
      wrap.id = "cmp360-design-bar";
      wrap.setAttribute("style", "display:none;align-items:center;gap:10px;flex-wrap:wrap;width:100%;color:#fff;font-size:12px;padding-top:6px;");
      const mkLabel = (text) => { const l = document.createElement("label"); l.textContent = text; l.setAttribute("style", "display:flex;align-items:center;gap:6px;"); return l; };
      const yawLabel = mkLabel("방향 비슷기걸(단급) 이로달이");
      const yaw = document.createElement("input"); yaw.type = "range"; yaw.id = "cmp360-yaw"; yaw.min = "-180"; yaw.max = "180"; yaw.step = "1"; yaw.value = "0";
      yawLabel.appendChild(yaw);
      const toggleBtn = document.createElement("button"); toggleBtn.type = "button"; toggleBtn.id = "cmp360-overlay-toggle"; toggleBtn.className = "cmp360-btn"; toggleBtn.textContent = "🪄 겹쳐보기";
      const opLabel = mkLabel("겹쳐보기 파끼름");
      const op = document.createElement("input"); op.type = "range"; op.id = "cmp360-opacity"; op.min = "0"; op.max = "100"; op.step = "1"; op.value = "50"; op.disabled = true;
      opLabel.appendChild(op);
      const saveBtn = document.createElement("button"); saveBtn.type = "button"; saveBtn.id = "cmp360-yaw-save"; saveBtn.className = "cmp360-btn"; saveBtn.textContent = "방향 보정 저장";
      wrap.appendChild(yawLabel); wrap.appendChild(toggleBtn); wrap.appendChild(opLabel); wrap.appendChild(saveBtn);
      bar.appendChild(wrap);
      yaw.addEventListener("input", (e) => {
        const deg = parseFloat(e.target.value) || 0;
        this._offsetLon = deg;
        if (this._right) this._right.setState({ lon: (this._left ? this._left.S.lon : 0) + deg, lat: this._right.S.lat, fov: this._right.S.fov });
      });
      toggleBtn.addEventListener("click", () => this._toggleDesignOverlay());
      op.addEventListener("input", (e) => {
        const b = document.getElementById("cmp360-canvas-b");
        if (b) b.style.opacity = String((parseFloat(e.target.value) || 0) / 100);
      });
      saveBtn.addEventListener("click", () => this._saveDesignYaw());
    },

    /** 비교 모드 전환 — 설계 모드면 시점 선택/평면 전환 UI를 숨기고 보정 바를 보인다. */
    _applyDesignUI(on) {
      ["cmp360-sel-a", "cmp360-sel-b", "btn-cmp360-flat"].forEach((id) => { const el = document.getElementById(id); if (el) el.classList.toggle("hidden", on); });
      const bar = document.getElementById("cmp360-design-bar");
      if (bar) bar.style.display = on ? "flex" : "none";
      const yaw = document.getElementById("cmp360-yaw"); if (yaw) yaw.value = String(this._offsetLon || 0);
      if (!on) this._toggleDesignOverlay(false);
    },

    /** [겹쳐보기] — 두 캔버스를 같은 위치에 겹치고 위(설계)쪽 투명도를 슬라이더로 조절(Three.js 변경 0, CSS만). */
    _toggleDesignOverlay(force) {
      const paneB = document.getElementById("cmp360-canvas-b");
      const op = document.getElementById("cmp360-opacity");
      this._designOverlayOn = (force != null) ? !!force : !this._designOverlayOn;
      if (!paneB) return;
      if (this._designOverlayOn) {
        paneB.style.position = "absolute"; paneB.style.left = "0"; paneB.style.top = "0"; paneB.style.zIndex = "5";
        paneB.style.opacity = String((parseFloat(op && op.value) || 50) / 100);
        if (op) op.disabled = false;
      } else {
        paneB.style.position = ""; paneB.style.left = ""; paneB.style.top = ""; paneB.style.zIndex = ""; paneB.style.opacity = "";
        if (op) op.disabled = true;
      }
      if (this._right) this._right.resize();
    },

    /** 요 오프셋을 핀에 저장(미저장 상태 — 기존 "저장" 버튼으로 서버 반영, PinActionPop._commitLocal 과 동일 경로). */
    _saveDesignYaw() {
      if (!this._designPin) return;
      this._designPin.designYawOffset = this._offsetLon || 0;
      if (typeof PinActionPop !== "undefined" && PinActionPop._commitLocal) PinActionPop._commitLocal();
      else if (typeof App !== "undefined" && App._autoSave) App._autoSave({});
      if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("방향 보정이 저장됐습니다(저장 버튼으로 서비에 반영하세요).");
    },

    /** 시점 선택 드롭다운 — 모든 시점 목록, 날짜 라벨(TimeLapse._fmtDate 재사용 = SoT 1개). */
    _renderSelects() {
      const opts = this._shots.map((s, i) => {
        const date = s.capturedAt ? " (" + TimeLapse._fmtDate(s.capturedAt) + ")" : "";
        return '<option value="' + i + '">' + UI.escapeHtml(s.label) + date + "</option>";
      }).join("");
      const selA = document.getElementById("cmp360-sel-a"), selB = document.getElementById("cmp360-sel-b");
      if (selA) { selA.innerHTML = opts; selA.value = String(this._idxA); }
      if (selB) { selB.innerHTML = opts; selB.value = String(this._idxB); }
    },

    _bind() {
      if (this._bound) return; this._bound = true;
      const a = document.getElementById("cmp360-canvas-a"), b = document.getElementById("cmp360-canvas-b");
      this._wire(a, "left");
      this._wire(b, "right");
      const closeBtn = document.getElementById("btn-cmp360-close");
      closeBtn && closeBtn.addEventListener("click", () => { if (typeof Compare !== "undefined") Compare.close(); });
      const syncBtn = document.getElementById("btn-cmp360-sync");
      syncBtn && syncBtn.addEventListener("click", () => this.toggleSync());
      const flatBtn = document.getElementById("btn-cmp360-flat");
      flatBtn && flatBtn.addEventListener("click", () => this._toFlat());
      const selA = document.getElementById("cmp360-sel-a"), selB = document.getElementById("cmp360-sel-b");
      selA && selA.addEventListener("change", (e) => this._switchShot("left", parseInt(e.target.value, 10)));
      selB && selB.addEventListener("change", (e) => this._switchShot("right", parseInt(e.target.value, 10)));
      window.addEventListener("resize", () => {
        if (document.getElementById("pano-compare-360").classList.contains("hidden")) return;
        if (this._left) this._left.resize();
        if (this._right) this._right.resize();
      });
    },

    /** 마우스 드래그 + 1손가락 터치 회전 + 2손가락 핀치(fov) — 06_PanoViewer의 기존 바인딩 패턴(20_App.js
     *  _bindPano)과 동일한 공식을 이 오버레이 전용으로 배선(메인 뷰어 캔버스는 건드리지 않음). */
    _wire(canvas, side) {
      if (!canvas) return;
      const pDist = (t0, t1) => Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
      canvas.addEventListener("mousedown", (e) => { this._dragSide = side; this._lx = e.clientX; this._ly = e.clientY; });
      window.addEventListener("mousemove", (e) => { if (this._dragSide === side) this._onDrag(side, e.clientX, e.clientY); });
      window.addEventListener("mouseup", () => { if (this._dragSide === side) this._dragSide = null; });
      canvas.addEventListener("wheel", (e) => { e.preventDefault(); this._onFov(side, e.deltaY * 0.05); }, { passive: false });
      canvas.addEventListener("touchstart", (e) => {
        if (e.touches.length === 2) { this._pinch[side] = pDist(e.touches[0], e.touches[1]); e.preventDefault(); }
        else if (e.touches.length === 1) { this._dragSide = side; this._lx = e.touches[0].clientX; this._ly = e.touches[0].clientY; }
      }, { passive: false });
      canvas.addEventListener("touchmove", (e) => {
        e.preventDefault();
        if (e.touches.length === 2 && this._pinch[side] != null) {
          const d = pDist(e.touches[0], e.touches[1]);
          const delta = this._pinch[side] - d;
          if (Math.abs(delta) > 1) { this._onFov(side, delta * 0.18); this._pinch[side] = d; }
        } else if (e.touches.length === 1 && this._dragSide === side) {
          this._onDrag(side, e.touches[0].clientX, e.touches[0].clientY);
        }
      }, { passive: false });
      canvas.addEventListener("touchend", (e) => {
        if (!e.touches || e.touches.length < 2) this._pinch[side] = null;
        if (!e.touches || e.touches.length === 0) this._dragSide = null;
      });
    },

    _core(side) { return side === "left" ? this._left : this._right; },
    _other(side) { return side === "left" ? this._right : this._left; },

    _onDrag(side, x, y) {
      const core = this._core(side);
      if (!core) return;
      core.applyDrag(this._lx, this._ly, x, y);
      this._lx = x; this._ly = y;
      if (this._sync) this._follow(side);
    },

    _onFov(side, delta) {
      const core = this._core(side);
      if (!core) return;
      core.setFov(delta);
      if (this._sync) { const other = this._other(side); if (other) other.setState({ fov: core.S.fov }); }
    },

    /** side 를 방금 바꿨으니 반대쪽을 같은 yaw(오프셋 유지)·같은 pitch/fov로 맞춘다.
     *  오프셋은 right.lon - left.lon 으로 고정 저장 — 어느 쪽을 드래그해도 같은 차이를 유지(대칭). */
    _follow(side) {
      const core = this._core(side), other = this._other(side);
      if (!core || !other) return;
      const lon = side === "left" ? core.S.lon + this._offsetLon : core.S.lon - this._offsetLon;
      other.setState({ lon, lat: core.S.lat, fov: core.S.fov });
    },

    /** [동기화 끄기/켜기] 끌 때는 그대로 독립. 켤 때는 "지금" 두 뷰어의 yaw 차이를 새 오프셋으로
     *  고정한다 — 꺼진 동안 사용자가 한쪽을 북쪽에 맞춰 돌려놨다면 그 정렬을 그대로 유지. */
    toggleSync() {
      this._sync = !this._sync;
      if (this._sync && this._left && this._right) {
        this._offsetLon = this._right.S.lon - this._left.S.lon;
      }
      const btn = document.getElementById("btn-cmp360-sync");
      if (btn) { btn.classList.toggle("on", this._sync); btn.textContent = this._sync ? "🔗 동기화 끄기" : "🔓 동기화 켜기"; }
      return this._sync;
    },

    /** 드롭다운에서 다른 시점을 고르면 그 쪽 코어만 새 텍스처로 교체(카메라 각도는 유지). */
    async _switchShot(side, idx) {
      if (this._busy || !this._shots[idx]) return;
      const core = this._core(side);
      if (!core) return;
      this._busy = true;
      try {
        const shot = this._shots[idx];
        const resolved = await TimeLapse._resolveSrc(shot);
        if (!resolved || resolved.isVideo) { this._busy = false; return; }
        await core.loadImage(resolved.src);
        if (side === "left") this._idxA = idx; else this._idxB = idx;
        const label = document.getElementById(side === "left" ? "cmp360-label-a" : "cmp360-label-b");
        if (label) label.textContent = shot.label;
      } finally { this._busy = false; }
    },

    /** [평면 슬라이더] 보조 모드로 전환 — 지금 선택된 두 시점 그대로 openFlat에 넘긴다. */
    _toFlat() {
      const a = this._shots[this._idxA], b = this._shots[this._idxB];
      this.close();
      if (typeof Compare !== "undefined") Compare.openFlat(a, b);
    },

    /** WebGL 컨텍스트 2개 전부 해제(모바일 메모리 — dispose 누수 0 요건). */
    close() {
      const ov = document.getElementById("pano-compare-360");
      if (ov) ov.classList.add("hidden");
      if (this._designMode) { try { this._applyDesignUI(false); } catch (e) {} }
      if (this._left) { this._left.dispose(); this._left = null; }
      if (this._right) { this._right.dispose(); this._right = null; }
      this._shots = []; this._dragSide = null; this._busy = false;
      this._designMode = false; this._designPin = null; this._designOverlayOn = false;
    },
  };
