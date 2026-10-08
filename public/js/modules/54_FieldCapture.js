  /* ══════════════════════════════════════════════════════════════
     FIELD CAPTURE — 현장 촬영 (WO 20261008-fieldcap)
     ────────────────────────────────────────────────────────────────
     마스터 결정(2026-10-08) ②: "간단한 현장 촬영 화면 vs 안드로이드 앱" → "사용자가 선택".
     🔴 새 등록 로직 0 — "어디에 등록? → 포인트 탭 → 등록" 은 전부 ThetaIntake(33_ThetaIntake.js)의
        showWhereSheet()/_awaitTap()/_register() 를 그대로 재사용한다(기존 핀 탭=이력 적립,
        빈 곳 탭=360 핀 생성, 둘 다 ThetaIntake 내부 로직 — 이 파일은 손대지 않는다).
        이 모듈이 하는 일은 두 가지뿐:
        ① 사진을 "어떻게" 받을지(방식) 고르고 localStorage 에 기억한다.
        ② 받은 파일 1장을 PhotoBatch.buildAutoRows([file]) 로 THETA 와 같은 "row" 형식으로 만들어
           ThetaIntake.showWhereSheet(row, 1) 에 그대로 넘긴다. 등록 완료는 row.onDone 훅
           (33_ThetaIntake.js _register, 1줄 추가)으로 받아 [다음 사진] 시트를 띄운다.
     방식 (d) 안드로이드 전용 앱은 아직 없다 — 숨기지 않고 "준비 중 + 사유"로 노출한다(§5 숨김 금지).
     진입점: 360 모드 모바일 도크(#mdock-field-capture) + 전체 기능 메뉴(45_FeatureMenu "pano" 그룹).
  ══════════════════════════════════════════════════════════════ */
  const FieldCapture = {
    LS_METHOD: "field_capture_method_v1",
    METHODS: [
      { id: "theta-share", icon: "📡", label: "THETA 앱에서 공유로 받기", hint: "THETA 앱 사진 → 공유 → SEASTAR" },
      { id: "gallery", icon: "🖼", label: "갤러리에서 고르기", accept: "image/*" },
      { id: "camera", icon: "📷", label: "휴대폰 카메라로 바로 찍기", accept: "image/*", capture: "environment" },
      { id: "android-app", icon: "📱", label: "안드로이드 전용 앱(완전 자동)", disabled: true, reason: "별도 앱 개발 필요 — 현재 미제공" }
    ],

    init() {
      this._ensureInput();
      this.mountDockButton();
    },

    /** 숨겨진 파일 입력 — index.html 수정 없이 동적으로 만든다(다른 팀이 index.html 을 고치는 중). */
    _ensureInput() {
      if (typeof document === "undefined" || document.getElementById("input-field-capture")) return;
      const inp = document.createElement("input");
      inp.type = "file";
      inp.id = "input-field-capture";
      inp.style.display = "none";
      inp.addEventListener("change", (e) => {
        const f = (e.target.files || [])[0] || null;
        e.target.value = "";
        if (f) this._onFile(f);
      });
      document.body.appendChild(inp);
    },

    /** 360 모드(디자이너)에서만 도크에 노출 — 렌더 지점 SoT = App._syncRegModeButtons(ThetaIntake.syncAppButtons 와 동일 판정). */
    mountDockButton() {
      if (typeof document === "undefined" || !document.querySelector) return;
      const bar = document.querySelector("#mobile-dock .mdock-bar");
      if (!bar || document.getElementById("mdock-field-capture")) return;
      const b = document.createElement("button");
      b.type = "button";
      b.id = "mdock-field-capture";
      b.className = "mdock-chip mdock-fieldcap hidden";
      b.innerHTML = '<span class="theta-app-label"><span aria-hidden="true">📷</span> 현장 촬영</span>';
      b.title = "현장 촬영 — 사진을 바로 찍어 도면에 위치 등록";
      b.addEventListener("click", (e) => { if (e && e.stopPropagation) e.stopPropagation(); this.open(); });
      const more = document.getElementById("mdock-more-toggle");
      if (more && more.parentNode === bar) bar.insertBefore(b, more); else bar.appendChild(b);
      this.syncDockButton();
    },
    syncDockButton() {
      const d = document.getElementById("mdock-field-capture");
      const on = typeof State !== "undefined" && State.mode === "designer" && State.regMode === "photo";
      if (d && d.classList) d.classList.toggle("hidden", !on);
    },

    _getMethod() { try { return localStorage.getItem(this.LS_METHOD) || null; } catch (e) { return null; } },
    _setMethod(id) { try { localStorage.setItem(this.LS_METHOD, id); } catch (e) {} },
    _methodOf(id) { return this.METHODS.find((m) => m.id === id) || null; },

    /** 진입점(도크·전체 기능 메뉴 공용). force=true 면 기억된 방식을 무시하고 항상 선택 시트를 띄운다
     *  (전체 기능 메뉴 [현장 촬영 방식 변경]이 이 경로로 들어온다). */
    open(force) {
      if (typeof ThetaIntake === "undefined" || !ThetaIntake._sheet) { this._toast("현장 촬영 모듈을 불러오지 못했습니다"); return; }
      if (typeof State === "undefined" || !State.fileType) { this._toast("도면을 먼저 연 뒤 현장 촬영을 사용하세요"); return; }
      const remembered = !force && this._getMethod();
      if (remembered && this._methodOf(remembered)) { this._run(remembered); return; }
      this._openMethodPicker();
    },

    _openMethodPicker() {
      const actions = this.METHODS.map((m) => ({
        label: m.icon + " " + m.label,
        hint: m.disabled ? m.reason : m.hint,
        disabled: !!m.disabled,
        run: () => { this._setMethod(m.id); this._run(m.id); }
      }));
      actions.push({ label: "취소", run: () => {} });
      ThetaIntake._sheet({
        id: "fieldcap-method-sheet",
        title: "현장 촬영 — 사진을 어떻게 받을까요?",
        body: "처음 고른 방식은 기억됩니다 — 전체 기능 메뉴 [현장 촬영 방식 변경]에서 다시 고를 수 있습니다.",
        actions
      });
    },

    _run(methodId) {
      const m = this._methodOf(methodId);
      if (!m) { this._openMethodPicker(); return; }
      if (m.disabled) { this._toast(m.reason); return; }
      if (m.id === "theta-share") { this._showThetaShareSheet(); return; }
      const inp = document.getElementById("input-field-capture");
      if (!inp) return;
      inp.accept = m.accept || "image/*";
      if (m.capture) inp.setAttribute("capture", m.capture); else inp.removeAttribute("capture");
      inp.click();
    },

    /** (a) THETA 공유 — 앱 열기(ThetaIntake.openApp 재사용)만 안내. 실제 수신은 기존 share_target(sw.js)
     *  → ThetaIntake.handleShared() 경로(5ce5232)가 그대로 처리 — 이 모듈은 새 수신 로직 0. */
    _showThetaShareSheet() {
      const why = ThetaIntake.appDisabledReason();
      ThetaIntake._sheet({
        id: "fieldcap-theta-sheet",
        title: "THETA 앱에서 공유로 받기",
        body: "THETA 앱 사진 → 공유 → SEASTAR 를 선택하세요. 받은 사진은 자동으로 이 화면에 들어옵니다.",
        actions: [
          { label: (why ? "THETA 앱 설치 안내" : "📷 THETA 앱 열기"), hint: why || undefined, primary: true, run: () => ThetaIntake.openApp({}) },
          { label: "닫기", run: () => {} }
        ]
      });
    },

    /** 받은 파일 1장 → THETA 와 같은 "row" 형식(요구 ②: 썸네일 + 촬영시각) → 기존
     *  '어디에 등록?' 흐름(요구 ③: 기존 핀=이력 적립 · 빈 곳=360 핀 생성, 전부 ThetaIntake 재사용). */
    async _onFile(file) {
      this._toast("사진을 처리하는 중…");
      let row = null;
      try {
        const rows = (typeof PhotoBatch !== "undefined" && PhotoBatch.buildAutoRows) ? await PhotoBatch.buildAutoRows([file]) : [];
        row = rows[0] || null;
      } catch (e) { row = null; }
      if (!row) row = { file, name: file.name, is360: null, timeLabel: "촬영시각 정보 없음" };
      row.onDone = (r) => this._afterRegister(r);
      ThetaIntake.showWhereSheet(row, 1);
    },

    /** 요구 ④: 완료 토스트(ThetaIntake._register 가 이미 띄움) + [다음 사진] 반복. */
    _afterRegister(r) {
      const ok = !!(r && r.status === "done");
      ThetaIntake._sheet({
        id: "fieldcap-next-sheet",
        title: ok ? "등록 완료" : "등록되지 않았습니다",
        body: ok ? "다음 사진을 바로 등록할까요?" : "다시 시도하거나 종료하세요.",
        actions: [
          { label: "다음 사진", primary: true, run: () => this._run(this._getMethod() || this.METHODS[0].id) },
          { label: "방식 바꾸기", run: () => this._openMethodPicker() },
          { label: "끝내기", run: () => {} }
        ]
      });
    },

    _toast(m, ms) { try { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast(m, ms); } catch (e) {} }
  };
