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
    /** 설정 패널 슬라이더 런타임 주입 — index.html(타 팀 점유 가능성)을 건드리지 않고
     *  settingsDisplayPrefsHost()(이 파일 하단, PinLabelPrefs 와 공유)가 만든 "보기 설정" 구역에 넣는다.
     *  [WO 20261019-pinscale3] 슬라이더 단위를 "배율×"에서 "기준px"(맞춤 상태 화면 핀 높이)로 — 저장은
     *  그대로 배율(마이그레이션 불필요, _toPx/_fromPx 로 표시만 환산). */
    initSlider() {
      const host = settingsDisplayPrefsHost();
      if (!host || document.getElementById("pinsize-slider")) return;
      const wrap = document.createElement("div");
      wrap.style.cssText = "display:flex;flex-direction:column;gap:4px;";
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
      host.appendChild(wrap);
      slider.addEventListener("input", () => {
        val.textContent = slider.value + "px";
        this.set(this._fromPx(slider.value));
      });
    }
  };

  /** [WO 20261022-pinprefs 추가 §3] 핀 크기·번호 표시 — "보는 사람이 옵션으로 선택"(마스터 원문)해야
   *  하므로 권한 블록 밖에 둔다. 종전엔 #chk-leader360(디자이너 전용 #settings-designer-actions 안,
   *  index.html Auth.isDesigner 로 .hidden 토글, 24_Settings.js render()) 바로 뒤에 끼워 넣어, 비로그인
   *  공유 열람 링크(/v/<토큰>, readonly 세션)에서는 #btn-settings 는 보여도 이 컨트롤이 든 블록 전체가
   *  display:none 이라 DOM엔 있어도 폭 0(지휘자 실측 — tests/p179b "sliderVis:false"). #settings-loggedin
   *  (로그인 여부만 보는 블록, 디자이너 전용 아님 — auto-entry 열람 세션도 Auth.user 가 채워져 여기 든다)
   *  바로 아래, #settings-designer-actions 와 형제로 "보기 설정" 구역을 만들어 역할과 무관하게 보이게 한다.
   *  PinSizePrefs.initSlider()·PinLabelPrefs.initToggle() 공용 SoT(같은 호스트 element, 1회만 생성). */
  function settingsDisplayPrefsHost() {
    let host = document.getElementById("settings-display-prefs");
    if (host) return host;
    const inner = document.getElementById("settings-loggedin");
    if (!inner) return null; // 로그인 블록 자체가 없음(테스트 셸 등) — 회귀 0(기존처럼 주입 생략)
    host = document.createElement("div");
    host.id = "settings-display-prefs";
    host.style.cssText = "display:flex;flex-direction:column;gap:10px;margin-top:14px;padding-top:14px;border-top:1px solid rgba(0,0,0,.12);";
    const title = document.createElement("div");
    title.textContent = "보기 설정";
    title.style.cssText = "font-size:12px;font-weight:700;opacity:.65;";
    host.appendChild(title);
    const designerActions = document.getElementById("settings-designer-actions");
    if (designerActions && designerActions.parentNode === inner) inner.insertBefore(host, designerActions.nextSibling);
    else inner.appendChild(host);
    return host;
  }

  /* ══════════════════════════════════════════
     PinLabelPrefs — 핀 번호(지도 위 핀 머리 안 숫자) 표시 옵션
     [WO 20261019-pinscale4, 마스터 "핀 숫자가 보여도 되고 안 보여도 돼. 그것도 옵션으로 선택할
     수 있게끔 해. 보는 사람이 옵션으로 선택할 수 있게끔 해."] 3상태:
       always — 항상 표시 / hidden — 항상 숨김 / auto(기본) — 작을 때만 자동 숨김(MapCtrl.LABEL_HIDE_PX).
     PinSizePrefs 와 동일 패턴(프로젝트별 localStorage, _projectId 재사용 — SoT 중복 선언 금지:
     PinSizePrefs._projectId() 그대로 호출). 디자이너·열람자 모두 같은 화면 설정에서 바꾼다
     (24_Settings.js initToggle 호출, chk-leader360 행 바로 뒤 — 핀 크기 슬라이더와 같은 자리).
     🔴 서버 저장(디자이너가 "배포 시 열람자 기본값"을 정하는 것)은 이 WO 범위 밖(src/index.tsx·
     migrations 변경 필요, 담당 파일 목록 밖) — 지금은 기기별(localStorage) 선택만 지원한다. */
  const PinLabelPrefs = {
    ALWAYS: "always", HIDDEN: "hidden", AUTO: "auto",
    DEFAULT: "auto",
    _key() { return "wm_pinlabel_" + PinSizePrefs._projectId(); },
    /** 저장된 옵션(없거나 비정상 값이면 DEFAULT). */
    get() {
      try {
        const v = localStorage.getItem(this._key());
        if (v === this.ALWAYS || v === this.HIDDEN || v === this.AUTO) return v;
        return this.DEFAULT;
      } catch (e) { return this.DEFAULT; }
    },
    set(v) {
      const n = (v === this.ALWAYS || v === this.HIDDEN || v === this.AUTO) ? v : this.DEFAULT;
      try { localStorage.setItem(this._key(), n); } catch (e) {}
      try { if (typeof MapCtrl !== "undefined" && MapCtrl.applyTransform) MapCtrl.applyTransform(); } catch (e) {}
      return n;
    },
    /** MapCtrl._applyPinBillboard() 가 매 줌마다 호출 — px = 현재 화면 핀 높이(px). */
    shouldHide(px) {
      const v = this.get();
      if (v === this.ALWAYS) return false;
      if (v === this.HIDDEN) return true;
      return px < (typeof MapCtrl !== "undefined" ? MapCtrl.LABEL_HIDE_PX : 16); // auto
    },
    /** 설정 패널 3단 버튼(select 대신 — 터치 44px 보장이 쉽고 현재 선택이 한눈에 보인다).
     *  PinSizePrefs.initSlider() 와 같은 공유 호스트(settingsDisplayPrefsHost, 이 파일 상단) — 권한
     *  블록 밖이라 비로그인 공유 열람 링크(readonly)에서도 보인다. */
    initToggle() {
      const host = settingsDisplayPrefsHost();
      if (!host || document.getElementById("pinlabel-toggle")) return;
      const wrap = document.createElement("div");
      wrap.id = "pinlabel-toggle";
      wrap.style.cssText = "display:flex;flex-direction:column;gap:4px;";
      const label = document.createElement("span");
      label.textContent = "핀 번호 표시";
      label.style.cssText = "font-size:13px;";
      const btnRow = document.createElement("div");
      btnRow.style.cssText = "display:flex;gap:6px;";
      const OPTS = [[this.ALWAYS, "항상"], [this.AUTO, "자동"], [this.HIDDEN, "숨김"]];
      const buttons = OPTS.map(([val, text]) => {
        const b = document.createElement("button");
        b.type = "button"; b.textContent = text; b.dataset.pinlabelOpt = val;
        b.style.cssText = "flex:1;min-height:32px;border-radius:6px;border:1px solid rgba(0,0,0,.2);background:transparent;color:inherit;cursor:pointer;font-size:12px;";
        b.addEventListener("click", () => { this.set(val); paint(); });
        return b;
      });
      const paint = () => {
        const cur = this.get();
        buttons.forEach((b) => {
          const on = b.dataset.pinlabelOpt === cur;
          b.style.fontWeight = on ? "700" : "400";
          b.style.opacity = on ? "1" : ".6";
          b.setAttribute("aria-pressed", on ? "true" : "false");
        });
      };
      buttons.forEach((b) => btnRow.appendChild(b));
      wrap.appendChild(label); wrap.appendChild(btnRow);
      host.appendChild(wrap);
      paint();
    }
  };
