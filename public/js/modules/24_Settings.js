  const Settings = {
    _isOpen: false,

    init() {
      const $ = (id) => document.getElementById(id);
      // 설정 버튼 → 패널 열기
      $("btn-settings") && $("btn-settings").addEventListener("click", () => this.open());
      // 핀 색상 선택(설정 패널 내) — 위임 바인딩
      const wrap = $("settings-pincolor");
      if (wrap) wrap.addEventListener("click", (e) => {
        const sw = e.target.closest && e.target.closest("[data-pincolor]");
        if (!sw) return;
        PinPrefs.set(sw.getAttribute("data-pincolor"));
        this._renderPinColor();
        // [토스트 스팸 제거] 색상 스와치 선택 결과가 핀에 즉시 반영돼 눈에 보인다.
      });
      // [WO 20261008-pinstyle §1] 구 전역 토글(State.leader360)을 핀별 선택으로 흡수 — 이 체크는 이제
      //   "선택한 포인트(없으면 이 구역·영역의 현재 모드 포인트) 모두 리더선 켜기/끄기" 일괄 동작이다.
      //   데이터 SoT = pin.leader(UI.setPinsLeader). 체크 상태는 열 때마다 대상 전부가 리더선인지로 다시 그린다.
      const chkLeader360 = $("chk-leader360");
      if (chkLeader360) {
        chkLeader360.addEventListener("change", () => {
          // 원하는 상태 = "지금 대상 전부가 리더선이 아니면 켜기" — 전체 기능 메뉴가 설정창을 안 연 채(체크 상태가
          //   오래된 채) .click() 해도 의도대로 동작하게, 체크 표시가 아니라 데이터(pin.leader)에서 판정한다.
          let pins = [];
          try { pins = (typeof UI !== "undefined" && UI._alignScopePins) ? UI._alignScopePins() : []; } catch (e) {}
          const allOn = pins.length > 0 && pins.every((p) => UI.Leader.wants(p));
          if (typeof UI !== "undefined" && UI.bulkLeader) UI.bulkLeader(!allOn);
          this._syncLeaderBulk();
        });
      }
      // [WO 20261001-gps] 위치 자동 기록 토글 — chk-leader360 행 옆에 런타임 주입(index.html 미수정).
      if (typeof GPS !== "undefined" && GPS.initToggle) GPS.initToggle();
      // [WO 20261023-pinviewopt] "보기 설정" 그룹 — 모양 → 번호 → 크기 → 리더선 표시(보기 전용) 순.
      // 전부 settingsDisplayPrefsHost() 공유 호스트(23c_PinSizePrefs.js)에 들어간다(같은 패턴 재사용).
      if (typeof PinShapePrefs !== "undefined" && PinShapePrefs.initToggle) PinShapePrefs.initToggle();
      // [WO 20261019-pinscale4] 핀 번호 표시 옵션(항상/자동/숨김) — 같은 런타임 주입 패턴.
      if (typeof PinLabelPrefs !== "undefined" && PinLabelPrefs.initToggle) PinLabelPrefs.initToggle();
      // [WO 20261016-pinscale §3] 핀 크기(도면 대비) 슬라이더.
      if (typeof PinSizePrefs !== "undefined" && PinSizePrefs.initSlider) PinSizePrefs.initSlider();
      // [WO 20261023-pinviewopt §4b] 리더선 "보기" 전용 토글(모든 사용자, 데이터 불변) — 아래
      // #chk-leader360(디자이너 전용 데이터 일괄변경)과는 다른 옵션(§23c_PinSizePrefs.js 헤더 주석).
      if (typeof PinLeaderViewPrefs !== "undefined" && PinLeaderViewPrefs.initToggle) PinLeaderViewPrefs.initToggle();
      // [WO 20261023-pinviewopt §4a] 디자이너 전용 리더선 일괄 켜기/끄기(#chk-leader360, 기존 DOM 그대로
      // 이동)를 같은 "보기 설정" 그룹 안으로 옮겨(설명문 함께) — 마스터 "리더선으로 끌어낼 수 있는 방법도
      // 이미 구현되어 있잖아. 그런 옵션들 정확하게". 데이터/이벤트 바인딩(위) 불변 — DOM 위치만 이동.
      this._moveLeaderDesignerRowIntoDisplayPrefs();
      // 닫기
      $("settings-close") && $("settings-close").addEventListener("click", () => this.close());
      const bd = document.querySelector('#settings-modal .admin-gate-backdrop');
      bd && bd.addEventListener("click", () => this.close());
      // 편집 모드로 전환
      $("btn-go-edit") && $("btn-go-edit").addEventListener("click", () => {
        if (!Auth.isDesigner) return;
        this.close();
        App.openApp(PinSeries.preferredMode());
      });
      // 디자이너 지정 관리(슈퍼)
      $("btn-open-designers") && $("btn-open-designers").addEventListener("click", () => {
        if (!Auth.isSuper) return;
        Designers.open();
      });
      // 기능·메뉴 관장 / AI 설정 / 코드맵 (슈퍼)
      $("btn-open-features") && $("btn-open-features").addEventListener("click", () => { if (Auth.isSuper && typeof AdminPanels !== "undefined") AdminPanels.openFeatures(); });
      $("btn-open-ai") && $("btn-open-ai").addEventListener("click", () => { if (Auth.isSuper && typeof AdminPanels !== "undefined") AdminPanels.openAI(); });
      $("btn-open-codemap") && $("btn-open-codemap").addEventListener("click", () => { if (Auth.isSuper && typeof AdminPanels !== "undefined") AdminPanels.openCodemap(); });
      $("btn-open-firebase") && $("btn-open-firebase").addEventListener("click", () => { if (Auth.isSuper && typeof AdminPanels !== "undefined") AdminPanels.openFirebase(); });
      // [WO 20260928] 체크보드 시작 번호 — 정본 App._setCheckboardStart()/_renumberCheckboard() 재사용.
      // [WO 20260929 addendum, 지휘자 정정] 마스터: "세팅도 각 모드에서 가능하게 해" — 인라인·모달
      // 둘 다 App._checkboardStart()/_setCheckboardStart() 에 "현재 모드(State.regMode)의 계열"을
      // 함께 넘긴다(_currentSeries() 한 곳에서만 판정 — §10 SoT).
      // [WO 20261001-startno] 시작 번호 [적용]·상단 인라인 입력 → 번호 대역 시트(24b_NumBand)로 일원화.
      //   #btn-settings-numband 바인딩·문구는 NumBand.init()/render() 가 맡는다(SoT 1개, 중복 UI 제거).
      $("btn-settings-checkboard-renumber") && $("btn-settings-checkboard-renumber").addEventListener("click", () => {
        const btn = $("btn-settings-checkboard-renumber");
        if (btn && btn.disabled) return;
        App._renumberCheckboard(this._currentSeries()); // 기존 Prompt.ask(시작번호 입력)+Prompt.confirm 흐름 그대로
      });
      // [WO 20261001-startno] 모드 전환 시 표시 갱신은 App._syncRegModeButtons() → NumBand.render() 한 곳.
      // [WO 20261019-unifymode] 등록 방식(이 구역) 토글 — 편집 화면이면 App._setRegMode(상단 토글과 같은 경로·저장),
      //   아니면(허브·뷰어에서 연 설정) 지금 구역 저장값만 바꾼다. 배치는 저절로 켜지 않는다(설정 패널 안의 조작).
      document.querySelectorAll("#settings-modal [data-regmethod]").forEach((b) => b.addEventListener("click", () => {
        if (!(typeof Auth !== "undefined" && Auth.isDesigner) || (typeof Auth !== "undefined" && Auth.readonly)) return;
        const m = b.getAttribute("data-regmethod");
        if (typeof State !== "undefined" && State.mode === "designer" && State.checkboard && typeof App !== "undefined" && App._setRegMode) {
          App._setRegMode(PinSeries.regModeOfMethod(m), { autoStart: false });
        } else if (typeof PinSeries !== "undefined" && PinSeries.setRegMethod) PinSeries.setRegMethod(m);
        this._renderRegMethod();
      }));
      // 설정 패널 내 로그아웃
      $("btn-settings-signout") && $("btn-settings-signout").addEventListener("click", () => {
        Auth.signOut();
        this.render();
      });
      // topbar "뷰어로" 버튼 → 편집 모드 종료
      $("btn-exit-edit") && $("btn-exit-edit").addEventListener("click", () => App.exitEdit());
      // topbar "설계자 모드" 버튼 → 뷰어에서 편집 모드로 전환 (회귀 방지)
      $("btn-enter-edit") && $("btn-enter-edit").addEventListener("click", () => App.enterEdit());
    },

    /** 설정 패널의 핀 색상 스와치 렌더 */
    _renderPinColor() {
      const wrap = document.getElementById("settings-pincolor");
      if (!wrap) return;
      const cur = State.pinColor || PinPrefs.get();
      wrap.innerHTML = PinPrefs.PALETTE.map(p =>
        `<button type="button" class="pincolor-sw${p.id === cur ? " active" : ""}" data-pincolor="${p.id}" title="${p.name}" aria-label="${p.name}" style="background:${p.head};border-color:${p.head2};">` +
        (p.id === cur ? '<i class="fa-solid fa-check"></i>' : '') + `</button>`
      ).join("");
    },

    /** [WO 20260929 addendum] 현재 편집화면 모드(State.regMode)에 대응하는 채번 계열.
     *  photo(360)면 "content", 그 외(checkboard 및 방어적 view 폴백)는 "checkboard".
     *  판정 지점 하나(§10 SoT) — apply/renumber/inline/렌더가 전부 이 함수만 부른다. */
    //  🔴 [WO 20261019-unifymode] 핀은 하나 — 일괄 변경 대상 = 페이지 전 핀("all"). 구 모드별 계열 판정 폐기.
    _currentSeries() { return "all"; },

    /** [WO 20260928] 설정 패널의 "OO 시작 번호" 항목 렌더 — 현재 구역(도면)·현재 모드 값을 채우고,
     *  도면이 로드 안 됐으면 비활성 + 이유를 표시한다(조용히 무시 금지).
     *  [WO 20260929 topbar-cleanup] 상단바 인라인 입력(#input-regmode-start)도 같은 값/비활성
     *  상태로 함께 렌더한다 — 렌더 지점 하나(SoT는 App._checkboardStart/_setCheckboardStart),
     *  세팅 모달·상단바 인라인 두 표시가 항상 동일한 값을 보이게 한다(양방향 동기화).
     *  [WO 20260929 addendum, 지휘자 정정] 마스터: "세팅도 각 모드에서 가능하게 해" — 라벨·값
     *  모두 _currentSeries()(현재 모드)를 따라 CHECKER/360 로 갈린다. */
    _renderCheckboardStart() {
      // [WO 20261001-startno] 시작 번호 입력은 번호 대역 시트로 일원화 — 여기선 대역 버튼 문구(NumBand.render)와
      // 일괄 변경 버튼의 도면 의존 비활성·이유 문구만 그린다.
      const $ = (id) => document.getElementById(id);
      const hint  = $("settings-checkboard-hint");
      const renumberBtn = $("btn-settings-checkboard-renumber");
      const hasDrawing = (typeof State !== "undefined") && (State.pdfDoc || (State.viewerPages && State.viewerPages.length));
      if (typeof NumBand !== "undefined" && NumBand.render) NumBand.render();
      if (renumberBtn) renumberBtn.disabled = !hasDrawing;
      if (hint) hint.textContent = hasDrawing
        ? "개별 핀 번호는 핀을 눌러 '번호' 칸에서 바로 바꿀 수 있습니다."
        : "도면(구역)을 먼저 불러와야 번호를 일괄 변경할 수 있습니다.";
    },

    /** [WO 20261019-unifymode] 등록 방식 버튼 표시 — 편집 중이면 지금 State.regMode, 아니면 지금 구역 저장값(PinSeries.regMethod).
     *  App._syncRegModeButtons()(상단 토글 렌더 지점)도 이 함수를 불러 두 표시가 갈라지지 않는다. */
    _renderRegMethod() {
      if (typeof document === "undefined" || typeof PinSeries === "undefined" || !PinSeries.regMethod) return;
      const editing = typeof State !== "undefined" && State.mode === "designer" && State.checkboard;
      const cur = editing ? PinSeries.methodOfRegMode(State.regMode) : PinSeries.regMethod();
      document.querySelectorAll("#settings-modal [data-regmethod]").forEach((b) => {
        const on = b.getAttribute("data-regmethod") === cur;
        b.classList.toggle("active", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
    },

    /** [WO 20261023-pinviewopt §4a] 기존 #chk-leader360 행(이벤트 바인딩은 init() 에서 이미 끝남,
     *  여기서는 DOM 위치만 옮김 — 같은 엘리먼트를 그대로 appendChild 하므로 리스너 유실 0)을
     *  "보기 설정" 공유 호스트(settingsDisplayPrefsHost, 23c_PinSizePrefs.js) 안, 설명문과 함께
     *  감싼 새 래퍼(#settings-leader-designer-row)로 옮긴다. 호스트 자체가 없으면(테스트 셸 등)
     *  조용히 건너뛴다(회귀 0 — 원래 자리에 그대로 남아 디자이너 전용으로 계속 동작). */
    _moveLeaderDesignerRowIntoDisplayPrefs() {
      if (typeof document === "undefined" || typeof settingsDisplayPrefsHost !== "function") return;
      if (document.getElementById("settings-leader-designer-row")) return; // 1회만
      const host = settingsDisplayPrefsHost();
      const row = document.querySelector('label.settings-leader-toggle-row[for="chk-leader360"]');
      if (!host || !row) return;
      const wrap = document.createElement("div");
      wrap.id = "settings-leader-designer-row";
      wrap.className = "hidden"; // render() 가 Auth.isDesigner 로 토글
      const desc = document.createElement("p");
      desc.className = "settings-note-sm";
      desc.textContent = "리더선(풍선+선으로 끌어내기) — 핀이 좁은 곳에 겹칠 때, 선택한 포인트(없으면 이 구역 현재 모드 전체)를 번호 풍선으로 끌어내 표시합니다. 기본은 핀.";
      row.style.marginTop = "0"; // 이동 전 자리(아래 간격)와의 이중 margin 제거
      wrap.appendChild(desc);
      wrap.appendChild(row);
      host.appendChild(wrap);
    },

    /** 일괄 리더선 체크 = 대상(UI._alignScopePins) 전부가 리더선이면 ON. 대상이 없으면 OFF. */
    _syncLeaderBulk() {
      const c = document.getElementById("chk-leader360");
      if (!c || typeof UI === "undefined" || !UI._alignScopePins) return;
      let pins = [];
      try { pins = UI._alignScopePins(); } catch (e) {}
      c.checked = pins.length > 0 && pins.every((p) => UI.Leader.wants(p));
    },

    open() {
      const m = document.getElementById("settings-modal");
      if (!m) return;
      this._isOpen = true;
      this._syncLeaderBulk();
      this.render();
      this._renderPinColor();
      m.classList.remove("hidden");
      requestAnimationFrame(() => m.classList.add("on"));
      // GIS 버튼이 아직 렌더 안됐으면 렌더 시도
      if (Auth._gsiInited) Auth._renderButtons();
      else Auth._initGsi();
    },

    close() {
      const m = document.getElementById("settings-modal");
      if (!m) return;
      this._isOpen = false;
      m.classList.remove("on");
      setTimeout(() => m.classList.add("hidden"), 200);
    },

    /** 로그인 상태/권한에 따라 설정 패널 내용 토글 */
    render() {
      const $ = (id) => document.getElementById(id);
      const out = $("settings-loggedout");
      const inn = $("settings-loggedin");
      if (Auth.user) {
        // 로그인됨
        out && out.classList.add("hidden");
        inn && inn.classList.remove("hidden");
        $("settings-name") && ($("settings-name").textContent = Auth.user.name || Auth.user.email);
        $("settings-email") && ($("settings-email").textContent = Auth.user.email || "");
        const roleEl = $("settings-role");
        if (roleEl) {
          roleEl.textContent = Auth.role === "super" ? "슈퍼관리자" : Auth.role === "designer" ? "디자이너" : "뷰어";
          roleEl.className = "user-role role-" + Auth.role;
        }
        const av = $("settings-avatar");
        if (av) { if (Auth.user.picture) { av.src = Auth.user.picture; av.style.display = ""; } else av.style.display = "none"; }
        // 권한별 액션
        $("settings-designer-actions") && $("settings-designer-actions").classList.toggle("hidden", !Auth.isDesigner);
        // [WO 20261023-pinviewopt §4a] "보기 설정" 그룹 안으로 옮긴 리더선 일괄 토글 행 — 원래
        // #settings-designer-actions 안에 있었을 때와 같은 권한(디자이너 전용)으로 가시성만 재현.
        $("settings-leader-designer-row") && $("settings-leader-designer-row").classList.toggle("hidden", !Auth.isDesigner);
        $("settings-viewer-note")      && $("settings-viewer-note").classList.toggle("hidden", Auth.isDesigner);
        $("settings-super-actions")    && $("settings-super-actions").classList.toggle("hidden", !Auth.isSuper);
        if (Auth.isDesigner) { this._renderCheckboardStart(); this._renderRegMethod(); }
      } else {
        // 미로그인 — 구글 로그인 안내
        out && out.classList.remove("hidden");
        inn && inn.classList.add("hidden");
        // 클라이언트 ID 미설정 안내
        const noclient = $("settings-noclient");
        if (noclient) noclient.classList.toggle("hidden", !!Auth.clientId);
        if (Auth._gsiInited) Auth._renderButtons();
      }
    }
  };

  /* ══════════════════════════════════════════
     DESIGNERS — 디자이너 지정 관리 (슈퍼관리자 전용)
  ══════════════════════════════════════════ */