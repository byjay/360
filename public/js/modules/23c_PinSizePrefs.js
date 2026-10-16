  /* ══════════════════════════════════════════
     PinSizePrefs — 핀 크기(도면 대비 기준 배율) 환경설정
     [WO 20261016-pinscale §3 / pinscale2] "핀 크기도 도면 배율에 맞게 완벽하게" — 기본 배율은
     전역 상수(MapCtrl.PIN_SCALE=0.75, zoom=1 에서 화면 약 30px)지만, 슬라이더로 프로젝트별로
     조절한다(60_PhotoFolder._prefKey 패턴: localStorage 키에 projectId 를 섞어 프로젝트마다
     다른 값을 저장). 슬라이더가 이 값을 아무리 올려도 MapCtrl.PIN_MAX_PX(48px) 상한이 최종
     화면 크기를 가둔다(마스터 "핀이 너무 커지는 거 아니니") — 슬라이더 MAX 는 그 상한에
     가깝게 재조정(아래).
     저장값은 "배율"이 아니라 0~100 슬라이더 값 → MapCtrl.PIN_SCALE_MIN~MAX 사이로 선형 환산해
     UI 는 직관적인 0~100, 실제 배율은 pinScreenScale() 의 base 로 쓴다.
  ══════════════════════════════════════════ */
  const PinSizePrefs = {
    DEFAULT: 0.75,   // MapCtrl.PIN_SCALE 과 동일(zoom=1 화면 약 30px — 기존 80px 대비 축소)
    MIN: 0.2,        // 너무 작아 설정값 자체가 무의미해지지 않는 하한(최종 화면 바닥은 MapCtrl 이 또 보장)
    MAX: 2.25,       // zoom>1 구간에서 MapCtrl.PIN_MAX_PX(48px) 상한에 바로 닿는 실질 상한(강제 상한은 MapCtrl 쪽)
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
    /** 설정 패널 슬라이더 런타임 주입 — index.html(타 팀 점유 가능성)을 건드리지 않고, 있는
     *  #chk-leader360 행(48_GPS.initToggle 과 같은 자리) 바로 뒤에 추가한다. */
    initSlider() {
      const base = document.getElementById("chk-leader360");
      const row = base && base.closest ? base.closest(".settings-leader-toggle-row") : null;
      if (!row || !row.parentNode || document.getElementById("pinsize-slider")) return;
      const wrap = document.createElement("div");
      wrap.style.cssText = "display:flex;flex-direction:column;gap:4px;margin-top:10px;";
      const labelRow = document.createElement("div");
      labelRow.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;";
      const label = document.createElement("span");
      label.textContent = "핀 크기(도면 대비)";
      const val = document.createElement("span");
      val.id = "pinsize-val";
      val.style.cssText = "font-size:12px;opacity:.7;min-width:2.4em;text-align:right;";
      labelRow.appendChild(label); labelRow.appendChild(val);
      const slider = document.createElement("input");
      slider.type = "range"; slider.id = "pinsize-slider";
      slider.min = String(this.MIN); slider.max = String(this.MAX); slider.step = "0.1";
      slider.value = String(this.get());
      val.textContent = Number(slider.value).toFixed(1) + "x";
      wrap.appendChild(labelRow); wrap.appendChild(slider);
      row.parentNode.insertBefore(wrap, row.nextSibling);
      slider.addEventListener("input", () => {
        val.textContent = Number(slider.value).toFixed(1) + "x";
        this.set(slider.value);
      });
    }
  };
