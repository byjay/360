  /* ══════════════════════════════════════════
     PinSizePrefs — 핀 크기(도면 대비 기준 배율) 환경설정
     [WO 20261016-pinscale §3 / pinscale2] "핀 크기도 도면 배율에 맞게 완벽하게" — 기본 배율은
     전역 상수(MapCtrl.PIN_SCALE=0.75)지만, 슬라이더로 프로젝트별로 조절한다(60_PhotoFolder._prefKey
     패턴: localStorage 키에 projectId 를 섞어 프로젝트마다 다른 값을 저장).
     [WO 20261019-pinscale3] 기준이 "zoom=1"에서 "화면 맞춤 배율"(MapCtrl.computeFitZoom())로 바뀌어
     PIN_SCALE=0.75 는 이제 "맞춤 상태에서 화면 약 30px"를 뜻한다 — 슬라이더도 그 기준px(20~48,
     기본 30)를 직접 조절하도록 라벨만 바꾼다(저장 형식은 그대로 "배율" 숫자라 마이그레이션 불필요 —
     get() 의 clamp(MIN~MAX)가 구 범위(0.2~2.25)로 저장된 값을 자동으로 새 범위로 눌러준다).
     슬라이더가 이 값을 아무리 올려도 MapCtrl.PIN_MAX_PX(56px) 상한이 최종 화면 크기를 가둔다
     (마스터 "핀이 너무 커지는 거 아니니") — 슬라이더 MAX 는 그 상한보다 낮게 유지(아래).
  ══════════════════════════════════════════ */
  const PinSizePrefs = {
    DEFAULT: 0.75,   // MapCtrl.PIN_SCALE 과 동일(맞춤 상태 화면 약 30px)
    MIN: 0.5,        // [WO 20261019-pinscale3] 기준px 20(=20/40) — 너무 작아 무의미해지지 않는 하한
    MAX: 1.2,        // 기준px 48(=48/40) — MapCtrl.PIN_MAX_PX(56px) 상한보다 낮게(강제 상한은 MapCtrl 쪽)
    PX_NATIVE: 40,   // MapCtrl.PIN_NATIVE_PX 와 동일(배율 ↔ px 환산, 슬라이더 표시용)
    _projectId() { return (typeof Projects !== "undefined" && Projects.currentProject && Projects.currentProject.id) || "default"; },
    _key() { return "wm_pinsize_" + this._projectId(); },
    /** 저장된 배율(없으면 DEFAULT). 범위 밖/비정상 값은 조용히 버리지 않고 DEFAULT 로 — 깨진 핀 크기로 멈추지 않게. */
    get() {
      try {
        const raw = localStorage.getItem(this._key());
        if (raw == null) return this.DEFAULT;
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) return this.DEFAULT;
        return Math.max(this.MIN, Math.min(this.MAX, n));
      } catch (e) { return this.DEFAULT; }
    },
    /** MapCtrl.pinScreenScale() 이 읽는 현재 기준 배율. */
    scale() { return this.get(); },
    set(v) {
      const n = Math.max(this.MIN, Math.min(this.MAX, Number(v) || this.DEFAULT));
      try { localStorage.setItem(this._key(), String(n)); } catch (e) {}
      // 즉시 반영 — 마커 재생성 없이 CSS 변수만 바뀜(MapCtrl._applyPinBillboard).
      try { if (typeof MapCtrl !== "undefined" && MapCtrl.applyTransform) MapCtrl.applyTransform(); } catch (e) {}
      return n;
    },
    reset() {
      try { localStorage.removeItem(this._key()); } catch (e) {}
      try { if (typeof MapCtrl !== "undefined" && MapCtrl.applyTransform) MapCtrl.applyTransform(); } catch (e) {}
    },
    /** 배율(MIN~MAX) ↔ 기준px(PX_NATIVE 곱) 환산 — 슬라이더는 px 로 보여주고 저장은 배율 그대로. */
    _toPx(ratio) { return Math.round(ratio * this.PX_NATIVE); },
    _fromPx(px) { return Number(px) / this.PX_NATIVE; },
    /** 설정 패널 슬라이더 런타임 주입 — index.html(타 팀 점유 가능성)을 건드리지 않고, 있는
     *  #chk-leader360 행(48_GPS.initToggle 과 같은 자리) 바로 뒤에 추가한다.
     *  [WO 20261019-pinscale3] 슬라이더 단위를 "배율×"에서 "기준px"(맞춤 상태 화면 핀 높이)로 — 저장은
     *  그대로 배율(마이그레이션 불필요, _toPx/_fromPx 로 표시만 환산). */
    initSlider() {
      const base = document.getElementById("chk-leader360");
      const row = base && base.closest ? base.closest(".settings-leader-toggle-row") : null;
      if (!row || !row.parentNode || document.getElementById("pinsize-slider")) return;
      const wrap = document.createElement("div");
      wrap.style.cssText = "display:flex;flex-direction:column;gap:4px;margin-top:10px;";
      const labelRow = document.createElement("div");
      labelRow.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;";
      const label = document.createElement("span");
      label.textContent = "핀 크기(맞춤 상태 기준px)";
      const val = document.createElement("span");
      val.id = "pinsize-val";
      val.style.cssText = "font-size:12px;opacity:.7;min-width:2.4em;text-align:right;";
      labelRow.appendChild(label); labelRow.appendChild(val);
      const slider = document.createElement("input");
      slider.type = "range"; slider.id = "pinsize-slider";
      slider.min = String(this._toPx(this.MIN)); slider.max = String(this._toPx(this.MAX)); slider.step = "1";
      slider.value = String(this._toPx(this.get()));
      val.textContent = slider.value + "px";
      wrap.appendChild(labelRow); wrap.appendChild(slider);
      row.parentNode.insertBefore(wrap, row.nextSibling);
      slider.addEventListener("input", () => {
        val.textContent = slider.value + "px";
        this.set(this._fromPx(slider.value));
      });
    }
  };
