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
      $("btn-settings-checkboard-apply") && $("btn-settings-checkboard-apply").addEventListener("click", () => {
        const input = $("settings-checkboard-start");
        if (!input || input.disabled) return;
        const series = this._currentSeries();
        const n = App._setCheckboardStart(State.pdfPage || 1, input.value, series);
        // [WO 20260929 topbar-cleanup] 세팅 모달 ↔ 상단바 인라인 입력 양방향 동기화 —
        // 값 자체는 App._setCheckboardStart()가 유일한 SoT, 여기선 두 표시를 함께 새로고침만 한다.
        this._renderCheckboardStart();
        Prompt.toast && Prompt.toast((typeof PinSeries !== "undefined" ? PinSeries.LABELS[series] : series) + " 다음 번호부터 " + n + "번으로 시작합니다");
      });
      $("btn-settings-checkboard-renumber") && $("btn-settings-checkboard-renumber").addEventListener("click", () => {
        const btn = $("btn-settings-checkboard-renumber");
        if (btn && btn.disabled) return;
        App._renumberCheckboard(this._currentSeries()); // 기존 Prompt.ask(시작번호 입력)+Prompt.confirm 흐름 그대로
      });
      // [WO 20260929 topbar-cleanup] 상단바 인라인 시작번호(#input-regmode-start) — 세팅 모달과
      // 같은 SoT(App._setCheckboardStart())를 호출하고 렌더는 _renderCheckboardStart() 한 곳에서만.
      const inlineStart = $("input-regmode-start");
      if (inlineStart) {
        const applyInline = () => {
          if (inlineStart.disabled || inlineStart.value === "") return;
          const series = this._currentSeries();
          const n = App._setCheckboardStart(State.pdfPage || 1, inlineStart.value, series);
          this._renderCheckboardStart();
          Prompt.toast && Prompt.toast((typeof PinSeries !== "undefined" ? PinSeries.LABELS[series] : series) + " 다음 번호부터 " + n + "번으로 시작합니다");
        };
        inlineStart.addEventListener("blur", applyInline);
        inlineStart.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { e.preventDefault(); inlineStart.blur(); }
        });
      }
      // [WO 20260929 topbar-cleanup] 20_App.js가 이미 바인딩한 3모드 세그먼트 버튼에 추가(가법) 리스너로
      // 편승 — 20_App.js는 수정하지 않는다(다른 팀 점유). _bindTopbar()가 App.init() 초반(Settings.init()
      // 이전)에 먼저 실행되므로, 여기서 나중에 등록되는 이 리스너는 State.regMode가 이미 갱신된 뒤
      // 실행된다(등록 순서=실행 순서, addEventListener 다중 리스너 허용).
      ["checkboard", "photo"].forEach((m) => {
        const b = $("btn-regmode-" + m);
        if (b) b.addEventListener("click", () => this._renderCheckboardStart());
      });
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
    _currentSeries() {
      return (typeof State !== "undefined" && State.regMode === "photo") ? "content" : "checkboard";
    },

    /** [WO 20260928] 설정 패널의 "OO 시작 번호" 항목 렌더 — 현재 구역(도면)·현재 모드 값을 채우고,
     *  도면이 로드 안 됐으면 비활성 + 이유를 표시한다(조용히 무시 금지).
     *  [WO 20260929 topbar-cleanup] 상단바 인라인 입력(#input-regmode-start)도 같은 값/비활성
     *  상태로 함께 렌더한다 — 렌더 지점 하나(SoT는 App._checkboardStart/_setCheckboardStart),
     *  세팅 모달·상단바 인라인 두 표시가 항상 동일한 값을 보이게 한다(양방향 동기화).
     *  [WO 20260929 addendum, 지휘자 정정] 마스터: "세팅도 각 모드에서 가능하게 해" — 라벨·값
     *  모두 _currentSeries()(현재 모드)를 따라 CHECKER/360 로 갈린다. */
    _renderCheckboardStart() {
      const $ = (id) => document.getElementById(id);
      const input = $("settings-checkboard-start");
      const hint  = $("settings-checkboard-hint");
      const applyBtn = $("btn-settings-checkboard-apply");
      const renumberBtn = $("btn-settings-checkboard-renumber");
      const inline = $("input-regmode-start");
      const label = $("settings-checkboard-start-label");
      const series = this._currentSeries();
      const seriesLabel = (typeof PinSeries !== "undefined" && PinSeries.LABELS && PinSeries.LABELS[series]) || series;
      if (label) label.textContent = seriesLabel + " 시작 번호";
      const hasDrawing = (typeof State !== "undefined") && (State.pdfDoc || (State.viewerPages && State.viewerPages.length));
      if (input) input.disabled = !hasDrawing;
      if (applyBtn) applyBtn.disabled = !hasDrawing;
      if (renumberBtn) renumberBtn.disabled = !hasDrawing;
      if (inline) inline.disabled = !hasDrawing;
      if (!hasDrawing) {
        if (input) input.value = "";
        if (inline) inline.value = "";
        if (hint) hint.textContent = "도면(구역)을 먼저 불러와야 시작 번호를 설정할 수 있습니다.";
        return;
      }
      const n = (typeof App !== "undefined" && App._checkboardStart) ? String(App._checkboardStart(State.pdfPage || 1, series)) : "1";
      if (input) input.value = n;
      if (inline) inline.value = n;
      if (hint) hint.textContent = "개별 핀 번호는 핀을 눌러 '번호' 칸에서 바로 바꿀 수 있습니다.";
    },

    open() {
      const m = document.getElementById("settings-modal");
      if (!m) return;
      this._isOpen = true;
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
        $("settings-viewer-note")      && $("settings-viewer-note").classList.toggle("hidden", Auth.isDesigner);
        $("settings-super-actions")    && $("settings-super-actions").classList.toggle("hidden", !Auth.isSuper);
        if (Auth.isDesigner) this._renderCheckboardStart();
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