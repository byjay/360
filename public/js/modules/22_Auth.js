  // [마스터 2026-08-31] 디자이너 기능은 로그인 없이 바로 진입, 관리자만 구글 로그인 필요.
  //   마스터가 "다시 로그인 필수로" 지시하면 이 값을 false 로 바꾸면 즉시 원복(로그인 게이트 필수).
  const AUTO_DESIGNER_ENTRY = true;
  // 자동입장 전용 토큰 — 데모 토큰(demo-*)과 완전히 별개 경로다.
  //   데모 토큰은 P0 보안조치(CF 시크릿 DEMO_LOGIN=0)로 서버에서 영구 거부되므로 자동입장에 쓸 수 없다.
  //   이 문자열은 서버 src/index.tsx 의 AUTO_DESIGNER_TOKEN 과 반드시 정확히 일치해야 한다.
  //   서버는 이 토큰에 'designer' 역할만 부여하며 관리자/슈퍼로는 절대 승격되지 않는다.
  const AUTO_DESIGNER_TOKEN = "auto-designer-entry-360";

  const Auth = {
    idToken: null,
    user: null,           // { email, name, picture, role }
    role: "viewer",       // 'super' | 'designer' | 'viewer'
    superAdmin: "designssir@gmail.com",
    _pendingDesigner: null,
    _gsiInited: false,
    _suppressDemoBadge: false,

    get clientId() {
      const id = (typeof window !== "undefined" && window.WM_GOOGLE_CLIENT_ID) || "";
      return id && id !== "GOOGLE_CLIENT_ID" ? id : "";
    },
    get isDesigner() { return this.role === "super" || this.role === "admin" || this.role === "designer"; },
    get isSuper() { return this.role === "super"; },
    // [역할모델] 관리자 = 슈퍼관리자(마스터) 또는 일반관리자. 관리자 패널/모드 접근 기준. 디자이너는 관리자 아님.
    get isAdmin() { return this.role === "super" || this.role === "admin"; },
    /** 4티어 역할 한글 라벨 */
    _roleLabel() {
      return this.role === "super" ? "슈퍼관리자"
           : this.role === "admin" ? "관리자"
           : this.role === "designer" ? "디자이너" : "뷰어";
    },

    async init() {
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
      // [마스터 2026-06-22] 데모 진입 중 본인 Google 계정 로그인 상시 버튼(허브/홈)
      ["hub-btn-google-login", "btn-google-login"].forEach((id) => {
        const el = $(id);
        if (el) el.addEventListener("click", async () => { if (this.firebaseEnabled) await this._doFirebaseLogin(); else this._openGate(); });
      });
      // 로그인 게이트 내 데모(설계자)
      $("login-gate-demo") && $("login-gate-demo").addEventListener("click", () => this.demoLogin("designer"));
      // 구글 로그인 폴백 버튼
      //  · Firebase가 연결돼 있으면 → Firebase Google 팝업 로그인 (마스터: ID만 넣으면 바로 로그인)
      //  · 아니면 → 안내 토스트
      $("login-gate-google-fallback") && $("login-gate-google-fallback").addEventListener("click", async () => {
        if (this.firebaseEnabled) { await this._doFirebaseLogin(); return; }
        if (!this.clientId) {
          Prompt && Prompt.toast && Prompt.toast("구글 로그인은 관리자 설정(Firebase ID 연결) 후 사용할 수 있어요. 우선 체험으로 진행하세요.", 3200);
        }
      });
      // 허브 상단의 구글 로그인 버튼(빈 컨테이너)도 Firebase 활성 시 클릭 가능하도록 위임
      ["google-signin-btn", "hub-google-signin-btn", "login-gate-signin", "settings-signin"].forEach((id) => {
        const el = $(id);
        if (el) el.addEventListener("click", async () => { if (this.firebaseEnabled && !this.clientId) await this._doFirebaseLogin(); });
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
      // 서버에 설정된 Google Client ID(CF 시크릿)를 우선 적용 — 빌드파일 수정 없이 운영 주입
      this._loadServerConfig();
      // 복원된 토큰으로 권한 재확인
      if (this.idToken) await this.refresh();
      // 유효한 로그인이 없을 때만:
      //  · AUTO_DESIGNER_ENTRY=true  → 로그인 없이 디자이너로 자동 진입(배지 숨김)
      //  · AUTO_DESIGNER_ENTRY=false → [마스터 2026-06-22] 로그인 필수, 즉시 로그인 게이트
      // [버그②수정 2026-08-31] 종전에는 `else if` 라, 세션에 남은 폐기 토큰(예: 봉인된 demo-designer)이
      //   복원되면 refresh()가 이를 거부·삭제한 뒤에도 자동입장/게이트 어느 쪽도 타지 않아
      //   권한 없는 빈 화면에 갇혔다. 이제 refresh 결과(this.user)로 판단한다.
      // [버그①수정 2026-08-31] await 누락으로 ProjectHub.load()가 토큰 세팅 전에 실행돼
      //   "등록된 프로젝트가 없습니다"로 렌더되던 레이스 제거 — 토큰세팅+refresh 완료를 반드시 기다린다.
      if (!this.user && !this._hasLocalToken()) {
        if (AUTO_DESIGNER_ENTRY) await this._autoDesignerEntry();
        else this._openGate();
      }
    },

    /** 서버(/api/auth/config)에서 Google Client ID 를 받아 GIS 재초기화.
     *  · CF 시크릿 GOOGLE_CLIENT_ID 가 있으면 그 값을 사용(인라인보다 우선)
     *  · 없으면 index.html 의 인라인 WM_GOOGLE_CLIENT_ID 유지 */
    async _loadServerConfig() {
      try {
        const r = await fetch("/api/auth/config");
        if (!r.ok) return;
        const cfg = await r.json();
        const cid = cfg && cfg.google_client_id;
        if (cid && cid !== window.WM_GOOGLE_CLIENT_ID) {
          window.WM_GOOGLE_CLIENT_ID = cid;
          this._gsiInited = false;   // 새 ID 로 재초기화
          this._initGsi();
        }
      } catch (e) { /* 오프라인이면 인라인 값으로 진행 */ }
    },

    /** Firebase 팝업 로그인 실행 + 사용자 피드백(토스트/게이트 에러) */
    async _doFirebaseLogin() {
      try {
        // [토스트 스팸 제거] 팝업 창이 실제로 뜨는 것이 곧 피드백이다(성공/실패 토스트는 아래 유지).
        await this.loginWithFirebase();
        const who = (this.user && (this.user.name || this.user.email)) || "";
        Prompt && Prompt.toast && Prompt.toast("로그인 완료 — " + who + " (" + this._roleLabel() + ")", 3000);
      } catch (e) {
        const msg = (e && e.message) ? e.message : String(e);
        Prompt && Prompt.toast && Prompt.toast("로그인 실패: " + msg + " — Firebase 콘솔에서 Google 공급업체와 승인된 도메인을 확인하세요.", 4200);
      }
    },

    _initGsi() {
      if (this._gsiInited) return;
      // Firebase가 연결돼 있으면 GIS(클라이언트 ID) 없이도 Google 로그인 가능
      if (this.firebaseEnabled) {
        const hint = document.querySelector(".auth-hint");
        if (hint) hint.textContent = "Google 계정으로 로그인 (Firebase 연결됨)";
        // 폴백 버튼을 '실제 로그인 버튼'으로 노출
        const fb = document.getElementById("login-gate-google-fallback");
        if (fb) fb.classList.remove("hidden");
        return;
      }
      if (!window.google || !window.google.accounts || !window.google.accounts.id) {
        // GIS 스크립트 로딩 대기
        setTimeout(() => this._initGsi(), 300);
        return;
      }
      if (!this.clientId) {
        // 클라이언트 ID 미설정 — 버튼 자리에 안내
        const hint = document.querySelector(".auth-hint");
        if (hint) hint.textContent = "구글 로그인 미설정 (관리자 설정에서 Firebase ID 연결 필요)";
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

    /** Firebase 로그인 활성 여부 (firebase-config 채워지면 true) */
    get firebaseEnabled() {
      return !!(window.FIREBASE_ENABLED && window.SeaFirebase);
    },

    /** Firebase Google 로그인 → 앱 Auth 연결 (마스터: ID만 넣으면 바로 로그인)
     *  1) Firebase 팝업으로 Google 로그인
     *  2) Firebase ID 토큰을 받아 this.idToken 에 저장
     *  3) refresh() 로 서버에 권한 확인 → 앱 전체 로그인 상태 반영
     *  반환: role (실패 시 throw) */
    async loginWithFirebase() {
      if (!this.firebaseEnabled) throw new Error("Firebase 미설정");
      if (!window.SeaFirebase.ready) {
        // init.js 의 동적 import 완료 대기 (최대 5초)
        await new Promise((res) => {
          if (window.SeaFirebase.ready) return res();
          const t = setTimeout(res, 5000);
          document.addEventListener("seafirebase:ready", () => { clearTimeout(t); res(); }, { once: true });
        });
      }
      const fbUser = await window.SeaFirebase.loginGoogle();
      // Firebase v10: getIdToken
      let idToken = null;
      try { idToken = await fbUser.getIdToken(); } catch (e) {}
      if (!idToken && window.SeaFirebase._auth && window.SeaFirebase._auth.currentUser) {
        idToken = await window.SeaFirebase._auth.currentUser.getIdToken();
      }
      if (!idToken) throw new Error("Firebase ID 토큰을 가져오지 못했습니다.");
      this.idToken = idToken;
      try { sessionStorage.setItem("wm_id_token", idToken); } catch (e) {}
      const role = await this.refresh();
      // 디자이너 진입 대기 콜백 처리
      if (this._pendingDesigner) {
        const cb = this._pendingDesigner;
        if (this.isDesigner) { this._pendingDesigner = null; this._closeGate(); cb(); }
        else { this._closeGate(); this._openAccessGate(); }
      } else {
        this._closeGate();
      }
      return role;
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

    /** R2 객체 URL(/api/r2/object/...)에 인증 토큰을 쿼리로 부착 — <img>/텍스처는 헤더를 못 보냄.
     *  R2 경로가 아니면(blob:/dataURL/외부/이미 부착) 그대로 통과. */
    r2(u) {
      if (typeof u !== "string" || u.indexOf("/api/r2/object/") !== 0 || !this.idToken) return u;
      if (/[?&]t=/.test(u)) return u;
      return u + (u.indexOf("?") < 0 ? "?" : "&") + "t=" + encodeURIComponent(this.idToken);
    },

    /** 서버에 권한 확인 → UI 갱신
     *  오프라인 권한 유지: 온라인이면 서버 응답을 localStorage에 캐싱,
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
        // [P16] 재로그인 성공 — 만료 상태 해제 + 보류된 오프라인 큐/드래프트를 자동으로 이어서 업로드.
        //   Firebase/Credential 로그인 경로 둘 다 refresh()를 거치므로 이 한 지점에서만 처리(§G-2-5).
        if (this._expired) {
          this._expired = false; this._authExpiredNotified = false;
          try { if (typeof SyncQueue !== "undefined" && SyncQueue._onReconnect) SyncQueue._onReconnect(); } catch (e) {}
        }
        this._saveAuthCache(data);   // 성공 시 권한 스냅샷 저장
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
          roleEl.textContent = this._roleLabel();
          roleEl.className = "user-role role-" + this.role;
        }
        const av = $("user-avatar");
        if (av) { if (this.user.picture) { av.src = this.user.picture; av.style.display = ""; } else av.style.display = "none"; }
        $("btn-manage-designers") && $("btn-manage-designers").classList.toggle("hidden", !this.isAdmin);
        // [마스터 2026-06-22] 데모 사용자 여부
        const _isDemo = !!(this.user && /^demo\./.test(this.user.email || ""));
        // 데모일 때만 'Google 로그인' 버튼 노출(실계정 전환 유도)
        const _gl = $("btn-google-login");
        if (_gl) _gl.classList.toggle("hidden", !_isDemo);
        // [마스터 요청] 데모 진입 시 '설계자/디자이너' 사용자 배지 제거(실제 로그인 시엔 본인 이름 표시)
        const _badge = signedIn ? signedIn.querySelector(".user-badge") : null;
        if (_badge) _badge.classList.toggle("hidden", _isDemo);
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
      // 폴백 버튼 표시 규칙:
      //  · GIS 클라이언트 ID 있음 → 숨김(실제 GIS 버튼 사용)
      //  · Firebase 연결됨 → 표시(폴백 버튼이 곧 Firebase 로그인 버튼)
      //  · 둘 다 없음 → 표시(클릭 시 안내)
      const fb = document.getElementById("login-gate-google-fallback");
      if (fb) fb.classList.toggle("hidden", !!this.clientId && !this.firebaseEnabled);
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
        submitLabel.textContent = "사용 신청";
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
          okEl.textContent = "사용 신청이 접수되었습니다. 관리자(" + (this.user && this.user.email ? "" : "") + "admin) 승인 후 설계자 기능을 사용할 수 있습니다.";
          okEl.classList.remove("hidden");
        }
        if (this.user) this.user.request_status = "pending";
        Prompt && Prompt.toast && Prompt.toast("사용 신청이 관리자에게 전달되었습니다.", 2800);
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
     *  role: 'designer' | 'viewer'
     *  opts.silent: true 면 데모 안내 배지를 띄우지 않음(AUTO_DESIGNER_ENTRY 자동입장 전용) */
    async demoLogin(role, opts) {
      this._suppressDemoBadge = !!(opts && opts.silent);
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

    /** [마스터 2026-08-31] 로그인 없는 디자이너 자동입장.
     *  데모 토큰(demo-designer)은 서버에서 봉인(DEMO_LOGIN=0)되어 쓸 수 없으므로,
     *  디자이너 권한만 가지는 전용 토큰(AUTO_DESIGNER_TOKEN)으로 서버 검증을 받는다.
     *  서버 스위치(AUTO_DESIGNER_TOKEN_ENABLED)가 꺼져 있으면 인증 실패 → 기존 로그인 게이트로 폴백.
     *  @returns {Promise<boolean>} 디자이너 진입 성공 여부 */
    async _autoDesignerEntry() {
      this._suppressDemoBadge = true;                    // 자동입장은 데모 배지를 띄우지 않는다
      this.idToken = AUTO_DESIGNER_TOKEN;
      try { sessionStorage.setItem("wm_id_token", this.idToken); } catch (e) {}
      await this.refresh();                              // 서버가 전용 토큰을 검증해 role='designer' 세팅
      if (!this.user) {                                  // 서버 스위치 off/네트워크 실패 → 정직하게 로그인 게이트
        this.idToken = null;
        try { sessionStorage.removeItem("wm_id_token"); } catch (e) {}
        this._openGate();
        return false;
      }
      this._closeGate();
      if (this._pendingDesigner) {
        const cb = this._pendingDesigner;
        this._pendingDesigner = null;
        if (this.isDesigner) cb();
      }
      this._showDemoBadge();                             // _suppressDemoBadge=true → 잔여 배지 제거만 수행
      return this.isDesigner;
    },

    /** 데모 모드 안내 배지(허브 상단) */
    _showDemoBadge() {
      if (this._suppressDemoBadge) {
        // AUTO_DESIGNER_ENTRY 자동입장 — 로그인 없이 그냥 디자이너로 보이게(배지 없음)
        const ex = document.getElementById("demo-mode-badge");
        if (ex) ex.remove();
        return;
      }
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
      b.innerHTML = '<span class="demo-dot"></span>편집모드 — 도면·핀·프로젝트 편집 중';
      document.body.appendChild(b);
    },

    _expired: false,              // 인증 만료 상태(배지 "인증 필요" 표시용)
    _authExpiredNotified: false,  // 세션당 1회만 안내(재시도마다 토스트 반복 방지)

    /** 오프라인 큐/드래프트 자동 업로드가 401/403(토큰 만료)로 실패했을 때 호출하는 공유 지점.
     *  App._flushDirtyDrafts(20_App.js) 와 SyncQueue.flush(05_SyncQueue.js) 양쪽에서 호출한다(§G-2-5,
     *  로직 복붙 대신 이 한 곳만 고친다). 데이터(큐/드래프트)는 그대로 보존되고, 세션당 1회만
     *  안내 + 기존 로그인 게이트를 재사용해 재로그인 동선을 제공한다(신규 UI 없음). */
    authExpired() {
      this._expired = true;
      if (this._authExpiredNotified) return;
      this._authExpiredNotified = true;
      try { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("로그인이 만료돼 업로드하지 못했습니다 — 다시 로그인하면 자동으로 이어서 올립니다", 4000); } catch (e) {}
      try { this._openGate(); } catch (e) {}
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
      this._suppressDemoBadge = false;  // 다음 수동 데모 로그인 시 배지 정상 표시되도록 초기화
      try { sessionStorage.removeItem("wm_id_token"); localStorage.removeItem("wm_local_token"); } catch (e) {}
      this._clearAuthCache();   // 오프라인 권한 캐시도 함께 정리
      this._applyUi();
      this._showDemoBadge();  // 데모 배지 제거
      // 디자이너 화면(편집 모드)에 있었다면 뷰어로 전환
      if (State.mode === "designer") {
        App.exitEdit();
      }
    }
  };

  /* ══════════════════════════════════════════
     SETTINGS — 설정 패널 (A안: 접속=뷰어, 설정 → 로그인 → 편집)
  ══════════════════════════════════════════ */
  /* ══════════════════════════════════════════
     PinPrefs — 핀 색상 환경설정 (기본=그린, 설정에서 변경)
  ══════════════════════════════════════════ */