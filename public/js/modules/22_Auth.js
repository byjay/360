  const Auth = {
    idToken: null,
    user: null,           // { email, name, picture, role }
    role: "viewer",       // 'super' | 'designer' | 'viewer'
    superAdmin: "designssir@gmail.com",
    _pendingDesigner: null,
    _gsiInited: false,

    get clientId() {
      const id = (typeof window !== "undefined" && window.WM_GOOGLE_CLIENT_ID) || "";
      return id && id !== "GOOGLE_CLIENT_ID" ? id : "";
    },
    get isDesigner() { return this.role === "super" || this.role === "designer"; },
    get isSuper() { return this.role === "super"; },

    init() {
      const $ = (id) => document.getElementById(id);
      // 로그아웃
      $("btn-signout") && $("btn-signout").addEventListener("click", () => this.signOut());
      // 디자이너 관리(슈퍼)
      $("btn-manage-designers") && $("btn-manage-designers").addEventListener("click", () => Designers.open());
      // 로그인 게이트 닫기
      $("login-gate-cancel") && $("login-gate-cancel").addEventListener("click", () => this._closeGate());
      const gb = document.querySelector("#login-gate .admin-gate-backdrop");
      gb && gb.addEventListener("click", () => this._closeGate());

      // ── 데모 진입 (구글 로그인 없이 바로 체험) ──
      // 허브 인증바
      $("hub-btn-demo-designer") && $("hub-btn-demo-designer").addEventListener("click", () => this.demoLogin("designer"));
      $("hub-btn-demo-viewer")   && $("hub-btn-demo-viewer").addEventListener("click", () => this.demoLogin("viewer"));
      // 로그인 게이트 내 데모(설계자)
      $("login-gate-demo") && $("login-gate-demo").addEventListener("click", () => this.demoLogin("designer"));
      // 구글 로그인 폴백 버튼(클라이언트 ID 미설정 시 안내)
      $("login-gate-google-fallback") && $("login-gate-google-fallback").addEventListener("click", () => {
        if (!this.clientId) {
          Prompt && Prompt.toast && Prompt.toast("구글 로그인은 관리자 설정(클라이언트 ID) 후 사용할 수 있어요. 우선 체험으로 진행하세요.", 3200);
        }
      });
      $("login-gate-learn") && $("login-gate-learn").addEventListener("click", () => {
        Prompt && Prompt.toast && Prompt.toast("SEASTAR 360° Viewer — 도면 위 360° 파노라마 위치 점검 시스템", 3000);
      });

      // ── 사용 신청(Request Access) 게이트 ──
      $("access-gate-cancel") && $("access-gate-cancel").addEventListener("click", () => this._closeAccessGate());
      const ab = document.querySelector("#access-gate .access-gate-backdrop");
      ab && ab.addEventListener("click", () => this._closeAccessGate());
      const af = $("access-gate-form");
      af && af.addEventListener("submit", (e) => { e.preventDefault(); this._submitAccessRequest(); });

      // 저장된 토큰 복원 (구글 idToken 또는 회사 이메일 로컬 토큰)
      try {
        const saved = sessionStorage.getItem("wm_id_token") || localStorage.getItem("wm_local_token");
        if (saved) { this.idToken = saved; }
      } catch (e) {}

      this._initGsi();
      // 복원된 토큰으로 권한 재확인
      if (this.idToken) this.refresh();
    },

    _initGsi() {
      if (this._gsiInited) return;
      if (!window.google || !window.google.accounts || !window.google.accounts.id) {
        // GIS 스크립트 로딩 대기
        setTimeout(() => this._initGsi(), 300);
        return;
      }
      if (!this.clientId) {
        // 클라이언트 ID 미설정 — 버튼 자리에 안내
        const hint = document.querySelector(".auth-hint");
        if (hint) hint.textContent = "구글 로그인 미설정 (관리자가 클라이언트 ID 설정 필요)";
        return;
      }
      this._gsiInited = true;
      window.google.accounts.id.initialize({
        client_id: this.clientId,
        callback: (resp) => this._onCredential(resp),
        auto_select: false,
      });
      this._renderButtons();
    },

    _renderButtons() {
      const g = window.google.accounts.id;
      const b1 = document.getElementById("google-signin-btn");
      const b2 = document.getElementById("login-gate-signin");
      const b3 = document.getElementById("settings-signin");
      if (b1) { b1.innerHTML = ""; g.renderButton(b1, { theme: "filled_blue", size: "medium", text: "signin_with", shape: "pill" }); }
      if (b2) { b2.innerHTML = ""; g.renderButton(b2, { theme: "filled_blue", size: "large", text: "signin_with", shape: "pill" }); }
      if (b3) { b3.innerHTML = ""; g.renderButton(b3, { theme: "filled_blue", size: "large", text: "signin_with", shape: "pill" }); }
      this._renderHubSignin();
    },

    async _onCredential(resp) {
      if (!resp || !resp.credential) return;
      this.idToken = resp.credential;
      try { sessionStorage.setItem("wm_id_token", this.idToken); } catch (e) {}
      await this.refresh();
      // 디자이너 모드 진입을 기다리던 경우 처리
      if (this._pendingDesigner) {
        const cb = this._pendingDesigner;
        if (this.isDesigner) { this._pendingDesigner = null; this._closeGate(); cb(); }
        else {
          // 권한 없는 계정 → 반드시 권한없음/사용신청 페이지로 연결 (Genspark 모방)
          this._closeGate();
          this._openAccessGate();
        }
      }
    },

    /** 인증 헤더 (API 호출용) */
    headers(extra) {
      const h = Object.assign({ "Content-Type": "application/json" }, extra || {});
      if (this.idToken) h["Authorization"] = "Bearer " + this.idToken;
      return h;
    },

    /** 서버에 권한 확인 → UI 갱신
     *  ★ 오프라인 권한 유지: 온라인이면 서버 응답을 localStorage에 캐싱,
     *    네트워크 실패(오프라인)이면서 토큰이 있으면 캐시된 권한을 복원.
     *    → 비행기·현장 등 오프라인에서도 디자이너/슈퍼 권한이 유지됨. */
    async refresh() {
      let data = null;
      let netFail = false;
      try {
        const r = await fetch("/api/auth/me", { headers: this.headers() });
        data = await r.json();
      } catch (e) { netFail = true; }

      // 오프라인(네트워크 실패)이고 토큰이 살아있으면 → 캐시 권한 복원
      if (netFail && (this.idToken || this._hasLocalToken())) {
        const cached = this._loadAuthCache();
        if (cached && cached.authenticated) {
          this.user = { email: cached.email, name: cached.name, picture: cached.picture, role: cached.role, request_status: cached.request_status || null };
          this.role = cached.role;
          this.superAdmin = cached.super_admin || this.superAdmin;
          this._offline = true;
          this._applyUi();
          return this.role;
        }
      }

      if (data && data.authenticated) {
        this.user = { email: data.email, name: data.name, picture: data.picture, role: data.role, request_status: data.request_status || null };
        this.role = data.role;
        this.superAdmin = data.super_admin || this.superAdmin;
        this._offline = false;
        this._saveAuthCache(data);   // ★ 성공 시 권한 스냅샷 저장
      } else if (!netFail) {
        // 서버가 명확히 미인증 응답 → 정리(캐시도 삭제)
        this.user = null; this.role = "viewer"; this.idToken = null;
        try { sessionStorage.removeItem("wm_id_token"); } catch (e) {}
        this._clearAuthCache();
      }
      this._applyUi();
      return this.role;
    },

    _hasLocalToken() {
      try { return !!(sessionStorage.getItem("wm_id_token") || localStorage.getItem("wm_local_token")); } catch (e) { return false; }
    },
    _saveAuthCache(data) {
      try {
        localStorage.setItem("wm_auth_cache", JSON.stringify({
          authenticated: true, email: data.email, name: data.name, picture: data.picture,
          role: data.role, request_status: data.request_status || null,
          super_admin: data.super_admin || null, _ts: Date.now()
        }));
      } catch (e) {}
    },
    _loadAuthCache() {
      try {
        const raw = localStorage.getItem("wm_auth_cache");
        if (!raw) return null;
        const c = JSON.parse(raw);
        if (c._ts && (Date.now() - c._ts) > 7 * 24 * 3600 * 1000) return null;
        return c;
      } catch (e) { return null; }
    },
    _clearAuthCache() {
      try { localStorage.removeItem("wm_auth_cache"); } catch (e) {}
    },

    _applyUi() {
      // 홈 인증바 + 프로젝트 허브 인증바 모두 갱신
      this._applyUiTo("");      // home: auth-signed-in / user-name ...
      this._applyUiTo("hub-");  // hub:  hub-auth-signed-in / hub-user-name ...

      // 디자이너 카드 잠금 표시
      document.querySelectorAll(".mode-card.designer").forEach((c) => c.classList.toggle("locked", !this.isDesigner));
      // 설정 패널이 열려 있으면 권한에 맞춰 다시 렌더
      if (typeof Settings !== "undefined" && Settings._isOpen) Settings.render();
      // 프로젝트 허브가 보이는 중이면 +새프로젝트/편집 버튼 갱신
      if (typeof ProjectHub !== "undefined") ProjectHub.refreshIfVisible();
      // 데모 모드 배지 동기화
      if (this._showDemoBadge) this._showDemoBadge();
    },

    _applyUiTo(pfx) {
      const $ = (id) => document.getElementById(pfx + id);
      const signedIn  = $("auth-signed-in");
      const signedOut = $("auth-signed-out");
      if (this.user) {
        signedIn && signedIn.classList.remove("hidden");
        signedOut && signedOut.classList.add("hidden");
        $("user-name") && ($("user-name").textContent = this.user.name || this.user.email);
        const roleEl = $("user-role");
        if (roleEl) {
          roleEl.textContent = this.role === "super" ? "슈퍼관리자" : this.role === "designer" ? "디자이너" : "뷰어";
          roleEl.className = "user-role role-" + this.role;
        }
        const av = $("user-avatar");
        if (av) { if (this.user.picture) { av.src = this.user.picture; av.style.display = ""; } else av.style.display = "none"; }
        $("btn-manage-designers") && $("btn-manage-designers").classList.toggle("hidden", !this.isSuper);
      } else {
        signedIn && signedIn.classList.add("hidden");
        signedOut && signedOut.classList.remove("hidden");
      }
    },

    /** 프로젝트 허브의 구글 로그인 버튼 렌더 */
    _renderHubSignin() {
      if (!this._gsiInited || !window.google || !window.google.accounts) return;
      const b = document.getElementById("hub-google-signin-btn");
      if (b) { b.innerHTML = ""; window.google.accounts.id.renderButton(b, { theme: "filled_blue", size: "medium", text: "signin_with", shape: "pill" }); }
    },

    /** 디자이너 진입 요청. 권한 있으면 콜백 즉시, 없으면 로그인 게이트. */
    requireDesigner(onPass) {
      if (this.isDesigner) { onPass(); return; }
      this._pendingDesigner = onPass;
      this._openGate();
    },

    _openGate() {
      // 이미 로그인했지만 권한이 없는 계정이면 → 바로 사용신청(권한없음) 게이트로
      if (this.user && !this.isDesigner) { this._openAccessGate(); return; }
      const gate = document.getElementById("login-gate");
      const err = document.getElementById("login-gate-error");
      if (err) err.classList.add("hidden");
      gate.classList.remove("hidden");
      requestAnimationFrame(() => gate.classList.add("on"));
      // 게이트 안 버튼 렌더 (로그인은 됐지만 권한 없는 경우엔 안내)
      if (this._gsiInited) this._renderButtons();
      // 구글 클라이언트 ID가 있으면 폴백 버튼 숨김(실제 GIS 버튼 사용)
      const fb = document.getElementById("login-gate-google-fallback");
      if (fb) fb.classList.toggle("hidden", !!this.clientId);
    },
    _showGateError() {
      const err = document.getElementById("login-gate-error");
      if (err) err.classList.remove("hidden");
    },

    /* ── 권한 없음 / 사용 신청(Request Access) 게이트 ── */
    _openAccessGate() {
      const gate = document.getElementById("access-gate");
      if (!gate) return;
      // 본인 이메일 표시
      const email = (this.user && this.user.email) || "";
      const emEl = document.getElementById("access-gate-email");
      const roEl = document.getElementById("ar-email-readonly");
      if (emEl) emEl.textContent = email || "로그인 계정";
      if (roEl) roEl.textContent = email || "—";
      // 이름 기본값
      const nameEl = document.getElementById("ar-name");
      if (nameEl && !nameEl.value) nameEl.value = (this.user && this.user.name) || "";
      // 메시지 초기화
      const errEl = document.getElementById("access-gate-error");
      const okEl = document.getElementById("access-gate-success");
      if (errEl) errEl.classList.add("hidden");
      if (okEl) okEl.classList.add("hidden");
      // 이미 신청한 상태면 안내
      const status = this.user && this.user.request_status;
      const submitLabel = document.getElementById("ar-submit-label");
      if (status === "pending" && okEl && submitLabel) {
        okEl.textContent = "이미 신청이 접수되었습니다. 관리자 승인을 기다려 주세요.";
        okEl.classList.remove("hidden");
        submitLabel.textContent = "신청 내용 수정";
      } else if (submitLabel) {
        submitLabel.textContent = "Submit Request";
      }
      gate.classList.remove("hidden");
      requestAnimationFrame(() => gate.classList.add("on"));
    },
    _closeAccessGate() {
      const gate = document.getElementById("access-gate");
      if (!gate) return;
      gate.classList.remove("on");
      setTimeout(() => gate.classList.add("hidden"), 200);
      this._pendingDesigner = null;
    },
    async _submitAccessRequest() {
      const $ = (id) => document.getElementById(id);
      const errEl = $("access-gate-error");
      const okEl = $("access-gate-success");
      const btn = $("ar-submit");
      if (errEl) errEl.classList.add("hidden");
      if (okEl) okEl.classList.add("hidden");
      const name = ($("ar-name").value || "").trim();
      const company = ($("ar-company").value || "").trim();
      const country = ($("ar-country").value || "").trim();
      const phone = ($("ar-phone").value || "").trim();
      if (!name || !company || !country || !phone) {
        if (errEl) { errEl.textContent = "모든 필수 항목(*)을 입력해 주세요."; errEl.classList.remove("hidden"); }
        return;
      }
      if (!this.idToken) {
        if (errEl) { errEl.textContent = "구글 로그인 후 신청할 수 있습니다."; errEl.classList.remove("hidden"); }
        return;
      }
      if (btn) { btn.disabled = true; btn.classList.add("loading"); }
      try {
        const res = await fetch("/api/access-requests", {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({ name, company, country, phone }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
        if (okEl) {
          okEl.textContent = "✅ 사용 신청이 접수되었습니다. 관리자(" + (this.user && this.user.email ? "" : "") + "admin) 승인 후 설계자 기능을 사용할 수 있습니다.";
          okEl.classList.remove("hidden");
        }
        if (this.user) this.user.request_status = "pending";
        Prompt && Prompt.toast && Prompt.toast("📩 사용 신청이 관리자에게 전달되었습니다.", 2800);
      } catch (e) {
        if (errEl) { errEl.textContent = "신청 실패: " + (e && e.message ? e.message : "네트워크 오류"); errEl.classList.remove("hidden"); }
      } finally {
        if (btn) { btn.disabled = false; btn.classList.remove("loading"); }
      }
    },
    _closeGate() {
      const gate = document.getElementById("login-gate");
      if (!gate) return;
      gate.classList.remove("on");
      setTimeout(() => gate.classList.add("hidden"), 200);
      this._pendingDesigner = null;
    },

    /** 데모 진입 — 구글 로그인 없이 바로 권한 부여(서버가 demo 토큰 인식).
     *  role: 'designer' | 'viewer' */
    async demoLogin(role) {
      this.idToken = role === "super" ? "demo-super" : (role === "designer" ? "demo-designer" : "demo-viewer");
      try { sessionStorage.setItem("wm_id_token", this.idToken); } catch (e) {}
      await this.refresh();  // 서버가 demo 토큰을 검증해 role/user 세팅
      this._closeGate();
      // 디자이너 진입을 기다리던 콜백이 있으면 실행
      if (this._pendingDesigner) {
        const cb = this._pendingDesigner;
        this._pendingDesigner = null;
        if (this.isDesigner) cb();
      }
      // 데모 모드 안내 배지 표시
      this._showDemoBadge();
    },

    /** 데모 모드 안내 배지(허브 상단) */
    _showDemoBadge() {
      if (!this.user || !this.user.email || this.user.email.indexOf("demo.") !== 0) {
        // 데모가 아니면 배지 제거
        const ex = document.getElementById("demo-mode-badge");
        if (ex) ex.remove();
        return;
      }
      if (document.getElementById("demo-mode-badge")) return;
      const b = document.createElement("div");
      b.id = "demo-mode-badge";
      b.className = "demo-mode-badge";
      b.innerHTML = '<span class="demo-dot"></span>데모 모드 — 구글 로그인 없이 체험 중';
      document.body.appendChild(b);
    },

    signOut() {
      try {
        if (window.google && window.google.accounts && window.google.accounts.id)
          window.google.accounts.id.disableAutoSelect();
      } catch (e) {}
      // 회사 이메일(로컬) 세션이면 서버에서 무효화
      try {
        if (this.idToken && this.idToken.indexOf("local-") === 0) {
          fetch("/api/signup/logout", { method: "POST", headers: { "Authorization": "Bearer " + this.idToken } }).catch(() => {});
        }
      } catch (e) {}
      this.idToken = null; this.user = null; this.role = "viewer";
      try { sessionStorage.removeItem("wm_id_token"); localStorage.removeItem("wm_local_token"); } catch (e) {}
      this._clearAuthCache();   // ★ 오프라인 권한 캐시도 함께 정리
      this._applyUi();
      this._showDemoBadge();  // 데모 배지 제거
      // 디자이너 화면(편집 모드)에 있었다면 뷰어로 전환
      if (State.mode === "designer") {
        App.exitEdit();
      }
    }
  };

  /* ══════════════════════════════════════════
     SETTINGS — 설정 패널 (A안: 접속=뷰어, ⚙️ 설정 → 로그인 → 편집)
  ══════════════════════════════════════════ */
  /* ══════════════════════════════════════════
     PinPrefs — 핀 색상 환경설정 (기본=그린, 설정에서 변경)
  ══════════════════════════════════════════ */