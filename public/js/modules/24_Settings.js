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