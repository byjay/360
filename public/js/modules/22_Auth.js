  // [마스터 2026-08-31] 디자이너 기능은 로그인 없이 바로 진입, 관리자만 구글 로그인 필요.
  //   마스터가 "다시 로그인 필수로" 지시하면 이 값을 false 로 바꾸면 즉시 원복(로그인 게이트 필수).
  // [WO 20261001-invite · 마스터 확정 ④] 공용석 종료 → false. 로그인 없는 사용자는 로그인/가입 게이트.
  //   단, 열람 링크(?d= · /srview)는 종전대로 **열람 전용** 토큰으로 진입한다(_isViewLink — 쓰기 자격 아님).
  //   짝 스위치: src/index.tsx AUTO_DESIGNER_TOKEN_ENABLED · TEMP_OPEN_ALL_TENANTS.
  const AUTO_DESIGNER_ENTRY = false;
  // [P48 보안 2026-09-18] 이 고정 문자열은 **공개 번들에 박혀 있으므로 비밀이 아니다.**
  //   서버(src/index.tsx)는 이제 이 문자열을 **열람 전용**으로만 인정한다 — 쓰기는 거부(403).
  //   편집 가능한 자동입장 토큰은 서버가 서명해 발급한다(POST /api/auth/auto-entry).
  //   여기 남겨두는 이유: 발급 실패(오프라인/구버전 서버) 시 "열람만이라도" 되게 하는 정직한 폴백.
  const AUTO_DESIGNER_TOKEN = "auto-designer-entry-360";
  // 마스터 전용 자동입장 키(선택). 서버에 AUTO_ENTRY_DESIGNER_KEY 를 설정한 뒤
  //   주소창에 ?akey=<키> 로 한 번 들어오면 이 브라우저에 저장되어 계속 편집 진입한다.
  const AUTO_ENTRY_KEY_LS = "wm_auto_entry_key";
  // [p113 토큰만료 수정] Firebase ID 토큰 TTL(1시간) 만료 5분 전에 선제 갱신한다.
  //   JWT exp 디코드가 실패하면(형식 변경 등) 50분 주기 안전망으로 폴백한다.
  const ID_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
  const ID_TOKEN_REFRESH_FALLBACK_MS = 50 * 60 * 1000;

  const Auth = {
    idToken: null,
    user: null,           // { email, name, picture, role }
    role: "viewer",       // 'super' | 'designer' | 'viewer'
    superAdmin: null,     // [R1] 서버가 super 본인에게만 내려준다(/api/auth/me super_admin) — 하드코딩 금지
    _pendingDesigner: null,
    _gsiInited: false,
    _suppressDemoBadge: false,
    // [p113] Firebase(Google) 세션에서만 토큰 자동갱신을 돈다 — 로컬/데모/자동입장 세션은 영향 없음.
    _usingFirebase: false,
    _idTokenTimer: null,
    _idTokenListenerAttached: false,

    get clientId() {
      const id = (typeof window !== "undefined" && window.WM_GOOGLE_CLIENT_ID) || "";
      return id && id !== "GOOGLE_CLIENT_ID" ? id : "";
    },
    /** 편집 권한 SoT. [WO 20261008-pinstyle R7] 🔴 근본원인(0b4d262 CDP 재현): 전역 role 만 봤다 — 전역 viewer 인데
     *  이 프로젝트의 designer 멤버(서버 deploymentWriteDenied 는 쓰기 허용: 소유자·super·멤버 designer)는 편집 화면에
     *  못 들어가고(State.mode null) 전체 기능·트리·핀 메뉴 51개가 "디자이너(편집) 전용"으로 막혔다. 열려 있는 프로젝트의
     *  실효 역할(/api/projects my_role — 서버가 멤버행 > 소유자·전역디자이너·super 로 계산)이 designer 면 편집 가능.
     *  허브(프로젝트 밖)에서는 projectRole 이 null 로 돌아가 전역 판정만 남는다(ProjectHub.open). */
    get isDesigner() { return this.role === "super" || this.role === "admin" || this.role === "designer" || this.projectRole === "designer"; },
    get isSuper() { return this.role === "super"; },
    // [역할모델] 관리자 = 슈퍼관리자(마스터) 또는 일반관리자. 관리자 패널/모드 접근 기준. 디자이너는 관리자 아님.
    get isAdmin() { return this.role === "super" || this.role === "admin"; },
    /** 역할 한글 라벨 사전 — 전역역할(super/admin/designer/viewer)과
     *  프로젝트역할(designer/editor/viewer)이 같은 어휘를 쓰므로 한 곳에서만 정의한다(SoT). */
    _ROLE_LABELS: { super: "슈퍼관리자", admin: "관리자", designer: "디자이너", editor: "편집자", viewer: "뷰어" },
    readonly: false,     // [P48] 서버가 쓰기를 거부하는 열람전용 세션(?d= 배포 링크)인가 — /api/auth/me 가 정본
    projectRole: null,   // [P40] 현재 열려 있는 프로젝트에서의 내 역할(없으면 전역역할로 표시)
    /** 배지 라벨. 프로젝트에 들어가 있으면 "그 프로젝트에서의 역할"을 우선한다(고정 '디자이너' 배지 제거). */
    _roleLabel() {
      const key = this.projectRole || this.role;
      return this._ROLE_LABELS[key] || this._ROLE_LABELS.viewer;
    },
    /** 프로젝트 진입/이탈 시 배지 컨텍스트 갱신 — 호출부는 ProjectHub.openProject / Projects.selectProject. */
    setProjectContext(p) {
      this.projectRole = (p && (p.my_role || p.role)) || null;
      // [WO 20261001-bulkreauth] 서버 판정(canManageMembersOf = 소유자·super)을 그대로 받는다 — 클라 재판정 금지.
      this.projectCanManage = !!(p && p.can_manage_members);
      this._applyUi();
    },
    projectCanManage: false,   // 현재 프로젝트의 멤버관리·핀 일괄삭제 자격(/api/projects can_manage_members)

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
        // [WO 20261009-readacl] 🔴 열람 토큰(ae1.)은 발급받은 **그 링크**에만 유효하다(서버가 범위를 서명).
        //   같은 탭에서 다른 링크로 들어오면 옛 토큰을 버리고 새 링크로 다시 받는다(그대로 쓰면 403).
        const vk = this._viewLinkKey();
        if (vk && this.idToken && /^ae1./.test(this.idToken) && sessionStorage.getItem("wm_view_link") !== vk) {
          this.idToken = null;
          sessionStorage.removeItem("wm_id_token");
        }
      } catch (e) {}

      this._initGsi();
      // 서버에 설정된 Google Client ID(CF 시크릿)를 우선 적용 — 빌드파일 수정 없이 운영 주입
      this._loadServerConfig();
      // 복원된 토큰으로 권한 재확인
      if (this.idToken) await this.refresh();
      // [WO 20261001-bulkreauth] 팝업 차단으로 redirect 재인증을 다녀왔으면 결과를 단기 토큰으로(비차단)
      Promise.resolve().then(() => this._resumeReauthRedirect()).catch(() => {});
      // 유효한 로그인이 없을 때만:
      //  · AUTO_DESIGNER_ENTRY=true  → 로그인 없이 디자이너로 자동 진입(배지 숨김)
      //  · AUTO_DESIGNER_ENTRY=false → [마스터 2026-06-22] 로그인 필수, 즉시 로그인 게이트
      // [버그②수정 2026-08-31] 종전에는 `else if` 라, 세션에 남은 폐기 토큰(예: 봉인된 demo-designer)이
      //   복원되면 refresh()가 이를 거부·삭제한 뒤에도 자동입장/게이트 어느 쪽도 타지 않아
      //   권한 없는 빈 화면에 갇혔다. 이제 refresh 결과(this.user)로 판단한다.
      // [버그①수정 2026-08-31] await 누락으로 ProjectHub.load()가 토큰 세팅 전에 실행돼
      //   "등록된 프로젝트가 없습니다"로 렌더되던 레이스 제거 — 토큰세팅+refresh 완료를 반드시 기다린다.
      if (!this.user && !this._hasLocalToken()) {
        if (AUTO_DESIGNER_ENTRY || this._isViewLink()) await this._autoDesignerEntry();
        else this._openGate();
      }
    },

    /** 열람 링크(배포 `?d=` · 공유 `/srview/...`)로 들어왔는가 — 공용석 종료 후 자동입장 허용 조건.
     *  🔴 _autoDesignerEntry 의 kind='viewer' 조건과 **같은 두 가지**여야 한다(p48·p61 계약 문구를 보존하려고 거기는 원형 유지).
     *  여기에 없는 링크 유형은 로그인 게이트로 간다(안전한 쪽으로 실패). */
    _isViewLink() {
      // [WO 20261012-viewlink] 판정 SoT = ShareLink.isViewEntry(`/v/` · `/srview/` · `?d=` · `?lk=`)
      if (typeof ShareLink !== "undefined" && ShareLink.isViewEntry) return ShareLink.isViewEntry();
      try { const q = new URLSearchParams(location.search); if (q.get("d") || q.get("lk")) return true; } catch (e) {}
      return false;
    },

    /** [WO 20261009-readacl] 현재 열람 링크의 식별자 — 서버 auto-entry 에 보내는 값({d}|{t}|{lk})과 토큰-링크 짝 기록의 단일 소스.
     *  링크가 아니면 null. 판정 기준은 _isViewLink 와 같다(?d= · ?lk= · /srview 토큰).
     *  [WO 20261011-viewmode] lk(모드별 발급 링크 id) 가 있으면 d 보다 우선 — 서버가 lk 로 dep_id·mode 를 정한다. */
    _viewLinkParams() {
      try {
        const q = new URLSearchParams(location.search);
        const lk = q.get("lk"); if (lk) return { lk };
        const d = q.get("d"); if (d) return { d };
      } catch (e) {}
      const t = (typeof ShareLink !== "undefined") ? ShareLink.token() : null;
      if (!t) return null;
      // [WO 20261012-viewlink] 새 주소 `/v/<토큰>` = 공유 토큰 또는 뷰어 링크 id → 서버가 판별(v). 구 `/srview/` = 공유 토큰(t).
      return /^\/v\//.test(location.pathname) ? { v: t } : { t };
    },
    _viewLinkKey() {
      const p = this._viewLinkParams();
      return p ? (p.lk ? "lk:" + p.lk : p.d ? "d:" + p.d : p.v ? "v:" + p.v : "t:" + p.t) : null;
    },
    /** 열람 토큰을 이 링크와 짝지어 기록(다음 진입 때 다른 링크면 버린다). */
    _bindViewToken() {
      try { sessionStorage.setItem("wm_view_link", this._viewLinkKey() || ""); } catch (e) {}
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

    /** firebase-init.js 의 동적 import 완료 대기(최대 5초) — 로그인·재인증 공용 */
    async _waitFirebase() {
      if (!window.SeaFirebase || window.SeaFirebase.ready) return;
      await new Promise((res) => {
        if (window.SeaFirebase.ready) return res();
        const t = setTimeout(res, 5000);
        document.addEventListener("seafirebase:ready", () => { clearTimeout(t); res(); }, { once: true });
      });
    },

    /** Firebase Google 로그인 → 앱 Auth 연결 (마스터: ID만 넣으면 바로 로그인)
     *  1) Firebase 팝업으로 Google 로그인
     *  2) Firebase ID 토큰을 받아 this.idToken 에 저장
     *  3) refresh() 로 서버에 권한 확인 → 앱 전체 로그인 상태 반영
     *  반환: role (실패 시 throw) */
    async loginWithFirebase() {
      if (!this.firebaseEnabled) throw new Error("Firebase 미설정");
      await this._waitFirebase();
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

    /** JWT(.header.payload.signature)의 payload.exp(초단위)를 밀리초로 디코드. 실패하면 null. */
    _decodeJwtExpMs(token) {
      try {
        const part = String(token).split(".")[1];
        if (!part) return null;
        const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
        const pad = b64 + "===".slice((b64.length + 3) % 4);
        const payload = JSON.parse(atob(pad));
        return payload && payload.exp ? payload.exp * 1000 : null;
      } catch (e) { return null; }
    },

    /** [p113] Firebase 세션 중에만 — 만료 임박 시 강제 갱신을 예약한다(선제 갱신 + 안전망 주기).
     *  onIdTokenChanged 가 SDK 자체 갱신을 받아 이 타이머를 매번 재설정하므로 중복 호출은 무해하다. */
    _scheduleIdTokenRefresh() {
      if (this._idTokenTimer) { clearTimeout(this._idTokenTimer); this._idTokenTimer = null; }
      if (!this._usingFirebase) return;
      const expMs = this._decodeJwtExpMs(this.idToken);
      const delay = expMs
        ? Math.max(5000, expMs - Date.now() - ID_TOKEN_REFRESH_MARGIN_MS)
        : ID_TOKEN_REFRESH_FALLBACK_MS;
      this._idTokenTimer = setTimeout(() => this._forceRefreshIdToken(), delay);
    },

    /** 현재 Firebase 사용자의 ID 토큰을 강제 갱신 — 결과는 onIdTokenChanged 리스너가 this.idToken 에 반영한다. */
    async _forceRefreshIdToken() {
      if (!this._usingFirebase || !this.firebaseEnabled) return;
      try {
        const cur = window.SeaFirebase && window.SeaFirebase._auth && window.SeaFirebase._auth.currentUser;
        if (cur) await cur.getIdToken(true);
      } catch (e) {}
      this._scheduleIdTokenRefresh();
    },

    /** 숨김 탭에서 타이머가 늦게 돌 수 있으므로, 탭이 다시 보일 때 만료 임박이면 즉시 갱신. */
    _onVisibilityRefreshCheck() {
      if (typeof document === "undefined" || document.visibilityState !== "visible" || !this._usingFirebase) return;
      const expMs = this._decodeJwtExpMs(this.idToken);
      if (expMs && (expMs - Date.now()) < ID_TOKEN_REFRESH_MARGIN_MS) this._forceRefreshIdToken();
    },

    /** [p113] onIdTokenChanged 구독을 1회만 건다(세션당 1개). 이메일 가드로 로컬/데모 세션을 보호한다 —
     *  CompanyAuth(29_CompanyAuth.js)가 Auth.idToken 을 직접 바꿔도 Firebase currentUser 의 이메일과
     *  다르면(통상 그렇다) 이 콜백은 아무것도 하지 않는다(§G-2-5 — 공유 지점 1곳에서만 고친다). */
    _attachIdTokenListener() {
      if (this._idTokenListenerAttached) return;
      if (!this.firebaseEnabled || !window.SeaFirebase || !window.SeaFirebase.onIdTokenChanged) return;
      this._idTokenListenerAttached = true;
      window.SeaFirebase.onIdTokenChanged(async (fbUser) => {
        if (!fbUser || !this._usingFirebase || !this.user || !this.user.email) return;
        if (String(fbUser.email || "").toLowerCase() !== String(this.user.email).toLowerCase()) return;
        try {
          const t = await fbUser.getIdToken();
          if (t) {
            this.idToken = t;
            try { sessionStorage.setItem("wm_id_token", t); } catch (e) {}
            this._scheduleIdTokenRefresh();
          }
        } catch (e) {}
      });
      if (typeof document !== "undefined") {
        document.addEventListener("visibilitychange", () => this._onVisibilityRefreshCheck());
      }
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
          this.readonly = !!cached.readonly;   // [P48] 오프라인 복원 시에도 열람전용 상태를 유지
          this.superAdmin = cached.super_admin || this.superAdmin;
          this._offline = true;
          this._applyUi();
          return this.role;
        }
      }

      if (data && data.authenticated) {
        this.user = { email: data.email, name: data.name, picture: data.picture, role: data.role, request_status: data.request_status || null };
        this.role = data.role;
        this.readonly = !!data.readonly;   // [P48] 서버 판정이 정본 — UI 는 이 값만 믿는다
        this.superAdmin = data.super_admin || this.superAdmin;
        this._offline = false;
        this._offlineOnly = false;   // [P40] 서버가 신원을 재검증함 → 오프라인 전용 상태 해제(서버 쓰기 재허용)
        // [P16] 재로그인 성공 — 만료 상태 해제 + 보류된 오프라인 큐/드래프트를 자동으로 이어서 업로드.
        //   Firebase/Credential 로그인 경로 둘 다 refresh()를 거치므로 이 한 지점에서만 처리(§G-2-5).
        if (this._expired) {
          this._expired = false; this._authExpiredNotified = false;
          try { if (typeof SyncQueue !== "undefined" && SyncQueue._onReconnect) SyncQueue._onReconnect(); } catch (e) {}
        }
        this._saveAuthCache(data);   // 성공 시 권한 스냅샷 저장
        // [WO 20261001-invite ①] 로그인 완료 → 보류된 초대 링크를 같은 토큰으로 자동 수락 재시도.
        //   Firebase·GIS·회사이메일 로그인이 모두 refresh() 를 지나므로 이 한 지점에서만 건다(§G-2-5).
        //   공용석/열람 토큰(auto)은 실계정이 아니므로 제외.
        if (!data.auto && !data.demo) { try { if (typeof Invite !== "undefined" && Invite.resumePending) Promise.resolve(Invite.resumePending()).catch(() => {}); } catch (e) {} }
        // [WO 20261007-qrcov] 로그인 완료 → 보류된 QR 딥링크로 복귀(같은 단일 지점). setTimeout 0 = 로그인 경로의
        //   후속 처리(회사 이메일 로그인 done() 의 openApp 등)가 끝난 **뒤** 실행돼 딥링크 화면이 덮이지 않게 한다.
        if (!data.auto && !data.demo) { try { if (typeof DeepLink !== "undefined" && DeepLink.resumePending) setTimeout(() => { Promise.resolve(DeepLink.resumePending()).catch(() => {}); }, 0); } catch (e) {} }
        // [p113] 이 세션이 Firebase(Google) 로그인인지 판별 — 로컬(local-)·데모·자동입장 토큰은 제외.
        //   § refresh() 는 로그인·복원 경로가 모두 거치는 한 지점이라 여기서만 판정한다.
        const looksFirebase = !data.auto && !data.demo && this.firebaseEnabled &&
          window.SeaFirebase && window.SeaFirebase._auth && window.SeaFirebase._auth.currentUser &&
          String(this.idToken || "").indexOf("local-") !== 0;
        if (looksFirebase) {
          this._usingFirebase = true;
          this._attachIdTokenListener();
          this._scheduleIdTokenRefresh();
        } else if (this._usingFirebase) {
          this._usingFirebase = false;
          if (this._idTokenTimer) { clearTimeout(this._idTokenTimer); this._idTokenTimer = null; }
        }
      } else if (!netFail) {
        // 서버가 명확히 미인증 응답 → 정리(캐시도 삭제)
        this.user = null; this.role = "viewer"; this.idToken = null;
        this._usingFirebase = false;
        if (this._idTokenTimer) { clearTimeout(this._idTokenTimer); this._idTokenTimer = null; }
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
          role: data.role, request_status: data.request_status || null, readonly: !!data.readonly,
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
      // [WO 20261012-viewlink] 🔴 열람 링크 통행증 세션(readonly)은 로그인·사용 신청 게이트를 **절대** 보지 않는다.
      //   종전: 오프라인 draft 자동 업로드 403 → authExpired → 여기 → (user 있음·디자이너 아님) → Request Access 에
      //   예약 계정 이메일까지 노출(마스터 스크린샷 2026-10-12). requireDesigner·authExpired·Invite 등 모든 호출부의 공유 관문.
      if (this.readonly) return;
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
      if (this.readonly) return;   // [WO 20261012-viewlink] 열람 링크 세션 = 사용 신청 대상 아님(_openGate 와 같은 관문)
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

    /** [P48] 서버에서 자동입장 토큰을 발급받는다(고정 문자열 상수 대체).
     *  @param {"designer"|"viewer"} kind
     *  @returns {Promise<string|null>} 서명 토큰. 실패하면 null(호출부가 열람전용 폴백을 쓴다). */
    async _mintAutoEntryToken(kind) {
      let akey = "";
      try {
        const q = new URLSearchParams(location.search).get("akey");
        if (q) localStorage.setItem(AUTO_ENTRY_KEY_LS, q);
        akey = localStorage.getItem(AUTO_ENTRY_KEY_LS) || "";
      } catch (e) {}
      const headers = { "Content-Type": "application/json" };
      if (akey) headers["X-Auto-Entry-Key"] = akey;
      try {
        // [WO 20261009-readacl] 열람 토큰은 링크가 있어야 발급된다 — 서버가 링크로 범위(프로젝트)를 정해 서명한다.
        const r = await fetch("/api/auth/auto-entry", { method: "POST", headers, body: JSON.stringify(Object.assign({ kind }, this._viewLinkParams() || {})) });
        if (!r.ok) {
          // [WO 20261016-viewmail] 이메일 인증 링크 — 링크 토큰만으로는 통행증이 없다(서버 401) → 초대받은 이메일 인증(통과할 때까지 대기)
          if (r.status === 401 && kind === "viewer" && typeof ViewerAuth !== "undefined") {
            const j401 = await r.json().catch(() => null);
            if (j401 && j401.email_auth_required) return await ViewerAuth.ensure(this._viewLinkParams());
          }
          return null;
        }
        const j = await r.json();
        return (j && typeof j.token === "string" && j.token) || null;
      } catch (e) { return null; }   // 오프라인/구버전 서버 → 정직하게 실패, 열람전용 폴백
    },

    /** [마스터 2026-08-31] 로그인 없는 디자이너 자동입장.
     *  데모 토큰(demo-designer)은 서버에서 봉인(DEMO_LOGIN=0)되어 쓸 수 없으므로,
     *  디자이너 권한만 가지는 전용 토큰(AUTO_DESIGNER_TOKEN)으로 서버 검증을 받는다.
     *  서버 스위치(AUTO_DESIGNER_TOKEN_ENABLED)가 꺼져 있으면 인증 실패 → 기존 로그인 게이트로 폴백.
     *  @returns {Promise<boolean>} 디자이너 진입 성공 여부 */
    async _autoDesignerEntry() {
      this._suppressDemoBadge = true;                    // 자동입장은 데모 배지를 띄우지 않는다
      // [P48] 🔴 배포 링크(?d=)로 들어온 세션은 **열람 전용** 토큰만 요청한다.
      //   쓰기 차단의 최종 방어선은 서버 미들웨어이고, 여기는 "애초에 쓰기 자격을 받지 않는다"는 1차 방어다.
      let kind = new URLSearchParams(location.search).get("d") ? "viewer" : "designer";
      // [P61] 🔴 공유 링크 `/srview/<이름>-<토큰>` 도 배포 링크(?d=)와 **완전히 동일한 열람전용**이다.
      //   새 주소 체계가 쓰기 구멍이 되면 p48 에서 막은 사고가 경로만 바꿔 되살아난다.
      //   판정은 ShareLink.token() 한 곳에서만 한다(SoT).
      if (typeof ShareLink !== "undefined" && ShareLink.token()) kind = "viewer";
      this.idToken = await this._mintAutoEntryToken(kind) || AUTO_DESIGNER_TOKEN;
      try { sessionStorage.setItem("wm_id_token", this.idToken); } catch (e) {}
      this._bindViewToken();
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
      // [WO 20261010-offmatrix] 배지(32_Offline.updateNetBadge — SyncQueue 구독)를 즉시 "인증 필요"로 — 3초 주기를 기다리는 동안 "업로드 중"으로 보이지 않게
      try { if (typeof SyncQueue !== "undefined" && SyncQueue._emit) SyncQueue._emit(); } catch (e) {}
      if (this._authExpiredNotified) return;
      this._authExpiredNotified = true;
      try { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("로그인이 만료돼 업로드하지 못했습니다 — 다시 로그인하면 자동으로 이어서 올립니다", 4000); } catch (e) {}
      try { this._openGate(); } catch (e) {}
    },

    /** [WO 20260930-403] 오프라인 업로드 실패(401/403/409) 판정의 단일 지점(§G-2-5).
     *  App._flushDirtyDrafts(20_App.js), App._flushOpLogs(32_Offline.js), SyncQueue.flush(05_SyncQueue.js)
     *  가 모두 이 함수로 분류한다 — 서버 에러 문구가 바뀌면 여기 한 곳만 고친다.
     *  근본원인: WP3 B5 가 /tables/deployments* 에 프로젝트 스코프 403(deploymentWriteDenied)을
     *  새로 추가하자, 기존 "401/403 = 토큰 만료" 판정이 정상 권한거부를 오인해 불필요한
     *  재로그인 창을 띄웠다(프로젝트 비멤버 designer의 오프라인 배포본 저장 시).
     *  반환: 'expired'(진짜 재로그인 필요) | 'denied'(이 프로젝트 권한 없음) | 'conflict'(409, 삭제된 프로젝트)
     *        | 'stale'(409, 낙관적 잠금 버전 경합 — 최신본 병합 후 재시도하면 된다) | null
     *  🔴 [WO 20261001-offline · p102 A4] 409 는 두 가지다: deploymentWriteDenied 의 '프로젝트 삭제'(영구)와
     *     updateDeployment 의 base_version 불일치 'conflict'(일시). 종전엔 둘 다 'conflict' 로 봐서, 복귀 업로드의
     *     GET→PATCH 사이에 남이 저장하기만 해도 draft 가 writeDenied(영구 보류)+"프로젝트가 삭제되어" 토스트가 됐다. */
    async classifyWriteFailure(res) {
      if (!res) return null;
      if (res.status === 401) return "expired";
      if (res.status === 409) {
        let msg409 = "";
        try { const j = await res.clone().json(); msg409 = String((j && j.error) || ""); } catch (e) {}
        return msg409.indexOf("project deleted") >= 0 ? "conflict" : "stale";
      }
      if (res.status === 403) {
        let msg = "";
        try { const j = await res.clone().json(); msg = String((j && j.error) || ""); } catch (e) {}
        // deploymentWriteDenied(src/index.tsx)의 정확한 문구만 '권한없음'으로 분류.
        // 그 외(예: requireDesigner 의 'forbidden — designer login required', 파싱 실패)는
        // 종전처럼 '만료'로 본다 — 프로젝트 스코프가 없는 엔드포인트(/api/sync/batch 등)의 403은
        // 항상 requireDesigner 발(發), 즉 진짜 로그인 필요이므로 이 기본값이 안전하다.
        if (msg.indexOf("not a designer of this project") >= 0) return "denied";
        if (msg === "forbidden") return "denied";
        return "expired";
      }
      return null;
    },

    _writeDeniedNotified: false,  // 세션당 1회만 안내(재시도마다 토스트 반복 방지)

    /** 오프라인 큐/드래프트가 권한없음(403) 또는 대상삭제(409)로 실패했을 때 호출하는 공유 지점.
     *  authExpired()와 달리 재로그인 게이트를 열지 않는다 — 토큰은 멀쩡하고 이 항목만 권한이 없다.
     *  데이터(큐/드래프트/op로그)는 그대로 보존하고, 호출부가 해당 항목의 재시도를 멈춰야 한다. */
    writeDenied(kind) {
      if (this._writeDeniedNotified) return;
      this._writeDeniedNotified = true;
      const msg = kind === "conflict"
        ? "프로젝트가 삭제되어 일부 변경사항을 동기화하지 못했습니다 — 로컬에는 보존됩니다"
        : "이 프로젝트에 쓰기 권한이 없어 일부 변경사항을 동기화하지 못했습니다";
      try { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast(msg, 4000); } catch (e) {}
    },

    /* ══ [WO 20261001-bulkreauth] 본인 재인증(핀 일괄삭제) ══════════════════════════════════
       🔴 앱은 구글 비밀번호를 받지 않는다. Google 계정 = 구글 공식 창(Firebase reauthenticateWithPopup,
       팝업 차단 시 redirect 폴백), 회사 이메일(local-) 계정 = 앱 비밀번호. 어느 쪽이든 서버(/api/auth/reauth)가
       검증하고 단기 토큰(rx1.*)과 만료시각(exp)을 준다. 유효시간 SoT = 서버 REAUTH_TTL_MS(5분) — 클라는 exp 만 믿는다.
       토큰은 sessionStorage(탭 한정)에 둔다 — redirect 복귀 후에도 이어지도록. 🔴 콘솔·로그 출력 금지. */
    REAUTH_STORE_KEY: "wm_reauth",
    _reauth: null,
    _reauthLoad() {
      if (this._reauth) return this._reauth;
      try { const r = JSON.parse(sessionStorage.getItem(this.REAUTH_STORE_KEY) || "null"); if (r && r.token && r.exp) this._reauth = r; } catch (e) {}
      return this._reauth;
    },
    /** 이 사용자의 재인증이 아직 유효한가(서버가 준 exp 기준) */
    hasValidReauth() {
      const r = this._reauthLoad();
      return !!(r && this.user && r.email === this.user.email && Number(r.exp) > Date.now());
    },
    /** 일괄삭제 저장 요청에 실을 헤더 — 유효한 재인증이 없으면 빈 객체 */
    reauthHeader() { return this.hasValidReauth() ? { "X-Reauth": this._reauth.token } : {}; },
    clearReauth() { this._reauth = null; try { sessionStorage.removeItem(this.REAUTH_STORE_KEY); } catch (e) {} },
    /** 재인증 증거(비밀번호 또는 새 ID 토큰) → 서버 검증 → 단기 토큰 보관. 반환 {ok, msg?} */
    async _exchangeReauth(body) {
      let r;
      try { r = await fetch("/api/auth/reauth", { method: "POST", headers: this.headers(), body: JSON.stringify(body) }); }
      catch (e) { return { ok: false, msg: "네트워크 오류 — 온라인에서 다시 시도하세요" }; }
      let j = null; try { j = await r.json(); } catch (e) {}
      if (!r.ok || !j || !j.token || !j.exp) return { ok: false, msg: (j && j.error) || ("본인 확인 실패(" + r.status + ")") };
      this._reauth = { token: j.token, exp: Number(j.exp), email: (this.user && this.user.email) || "" };
      try { sessionStorage.setItem(this.REAUTH_STORE_KEY, JSON.stringify(this._reauth)); } catch (e) {}
      return { ok: true };
    },
    /** 유효한 재인증이 있으면 즉시 true(5분 내 재사용). 없으면 재인증 창 → 성공 true / 실패·취소 false. */
    async ensureReauth() {
      if (this.hasValidReauth()) return true;
      if (!this.user || !this.idToken || this.readonly) return false;
      const toast = (m) => { try { Prompt.toast(m, 3600); } catch (e) {} };
      if (String(this.idToken).indexOf("local-") === 0) {
        const res = await Prompt.ask({ title: "본인 확인", sub: "핀 일괄삭제 전 이 계정(" + this.user.email + ")의 앱 비밀번호를 다시 입력하세요.", placeholder: "비밀번호", password: true });
        if (!res || !res.value) return false;
        const x = await this._exchangeReauth({ password: res.value });
        if (!x.ok) toast(x.msg);
        return x.ok;
      }
      if (!this.firebaseEnabled) { toast("이 계정은 구글 본인 확인을 할 수 없어 일괄삭제를 진행할 수 없습니다"); return false; }
      await this._waitFirebase();
      if (!window.SeaFirebase.reauthGoogle) { toast("구글 본인 확인을 준비하지 못했습니다 — 잠시 후 다시 시도하세요"); return false; }
      let idt = null;
      try { idt = await window.SeaFirebase.reauthGoogle(this.user.email); }
      catch (e) {
        const code = String((e && e.code) || "");
        if (code !== "auth/popup-closed-by-user" && code !== "auth/cancelled-popup-request") toast("구글 본인 확인 실패 — " + (code || "다시 시도하세요"));
        return false;
      }
      if (!idt) return false;
      const x = await this._exchangeReauth({ id_token: idt });
      if (!x.ok) toast(x.msg);
      return x.ok;
    },
    /** redirect 재인증 복귀(팝업 차단 환경) — 표시가 있을 때만 결과를 받아 단기 토큰으로 바꾼다. */
    async _resumeReauthRedirect() {
      if (!this.user || !this.firebaseEnabled) return;
      await this._waitFirebase();
      if (!window.SeaFirebase.reauthRedirectResult) return;
      const idt = await window.SeaFirebase.reauthRedirectResult();
      if (!idt) return;
      const x = await this._exchangeReauth({ id_token: idt });
      const mins = x.ok ? Math.max(1, Math.round((Number(this._reauth.exp) - Date.now()) / 60000)) : 0;
      try { Prompt.toast(x.ok ? "본인 확인 완료 — " + mins + "분 안에 일괄삭제를 다시 실행하세요" : x.msg, 4000); } catch (e) {}
    },

    /* ══════════════════════════════════════════════════════════════════
       [P40] 오프라인 재인증 — 현장에서 세션이 끊겨도 "이 기기에서 한 번 온라인 로그인에
       성공한 사용자"가 비밀번호로 다시 들어와 오프라인 작업을 이어갈 수 있게 한다.

       보안 설계(트레이드오프 명시):
        · 저장하는 것은 검증자(verifier)뿐 — 서버 hashPassword 와 동일한 PBKDF2-SHA256 100k/256bit
          + 기기별 16B 난수 salt. 🔴 평문 비밀번호는 어디에도 저장하지 않는다.
        · 기기를 탈취당하면 이 검증자는 오프라인 무차별 대입의 표적이 된다. 100k 스트레칭 +
          시도 횟수 제한(OFFLINE_MAX_ATTEMPTS) + 만료(OFFLINE_VERIFIER_TTL_MS) 로 상쇄한다.
          약한 비밀번호는 여전히 뚫린다 → 초대 계정 비밀번호 최소 8자를 서버에서 강제한다.
        · 🔴 오프라인 인증은 서버 권한을 전혀 만들지 않는다. 세션 토큰을 복원하지 않으며
          (idToken=null), canServerWrite()=false 로 업로드 경로가 스스로 멈춘다.
          온라인 복귀 시 서버가 /api/auth/me 로 다시 검증해야만 쓰기가 열린다.
        · 로그아웃 시 검증자를 삭제한다.
       ══════════════════════════════════════════════════════════════════ */
    OFFLINE_PBKDF2_ITER: 100000,                          // 서버 hashPassword 와 동일 파라미터
    OFFLINE_VERIFIER_TTL_MS: 30 * 24 * 60 * 60 * 1000,    // 로컬 세션(30일)과 동일 창
    OFFLINE_MAX_ATTEMPTS: 10,                             // 오프라인 무차별 대입 제한
    _offlineOnly: false,                                  // 오프라인 검증자로만 인증된 상태

    _hexOf(buf) {
      const a = new Uint8Array(buf); let h = "";
      for (const x of a) h += x.toString(16).padStart(2, "0");
      return h;
    },
    _eqConstantTime(a, b) {
      if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
      let diff = 0;
      for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
      return diff === 0;
    },
    /** PBKDF2-SHA256(100k, 256bit) — 서버 src/lib/util.ts hashPassword 와 같은 값을 만든다. */
    async _deriveVerifier(password, saltHex) {
      const salt = new Uint8Array(String(saltHex).match(/.{1,2}/g).map((b) => parseInt(b, 16)));
      const baseKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
      const bits = await crypto.subtle.deriveBits(
        { name: "PBKDF2", salt: salt, iterations: this.OFFLINE_PBKDF2_ITER, hash: "SHA-256" }, baseKey, 256);
      return this._hexOf(bits);
    },
    /** 온라인 로그인 성공 직후에만 호출한다(서버가 이미 신원을 검증한 시점). */
    async saveOfflineVerifier(email, password, profile) {
      try {
        if (!email || !password) return false;
        const saltBytes = new Uint8Array(16); crypto.getRandomValues(saltBytes);
        const salt = this._hexOf(saltBytes.buffer);
        const rec = {
          v: 1,
          email: String(email).toLowerCase(),
          salt: salt,
          verifier: await this._deriveVerifier(password, salt),   // 해시만 — 원문 없음
          name: (profile && profile.name) || "",
          role: (profile && profile.role) || "viewer",
          createdAt: Date.now(),
          expiresAt: Date.now() + this.OFFLINE_VERIFIER_TTL_MS,
          attempts: 0
        };
        return await SyncQueue.saveAuthRecord(rec);
      } catch (e) { return false; }
    },
    /** 오프라인 재인증. 성공해도 서버 토큰은 만들지 않는다(로컬 작업 권한 전용). */
    async offlineLogin(email, password) {
      const rec = await SyncQueue.loadAuthRecord();
      const em = String(email || "").trim().toLowerCase();
      if (!rec || rec.email !== em) return { ok: false, reason: "no-record" };
      if (Date.now() > rec.expiresAt) { await SyncQueue.clearAuthRecord(); return { ok: false, reason: "expired" }; }
      if ((rec.attempts || 0) >= this.OFFLINE_MAX_ATTEMPTS) return { ok: false, reason: "locked" };
      const h = await this._deriveVerifier(String(password || ""), rec.salt);
      if (!this._eqConstantTime(h, rec.verifier)) {
        rec.attempts = (rec.attempts || 0) + 1;
        await SyncQueue.saveAuthRecord(rec);
        return { ok: false, reason: "bad-password", remaining: Math.max(0, this.OFFLINE_MAX_ATTEMPTS - rec.attempts) };
      }
      rec.attempts = 0; await SyncQueue.saveAuthRecord(rec);
      this.idToken = null;                    // 🔴 서버 세션 토큰을 복원하지 않는다
      this._offlineOnly = true; this._offline = true;
      this.user = { email: rec.email, name: rec.name || rec.email, picture: "", role: rec.role };
      this.role = rec.role;
      this._applyUi();
      return { ok: true, user: this.user };
    },
    /** 서버 쓰기(업로드/동기화) 허용 여부 — 오프라인 검증만으로는 절대 허용하지 않는다. */
    // [WO 20261012-viewlink] 열람 링크 통행증(readonly)은 서버 쓰기 자격이 없다 — 자동 업로드·대기열 flush 가 스스로 멈춘다.
    canServerWrite() { return !this._offlineOnly && !!this.idToken && !this.readonly; },
    async clearOfflineVerifier() { try { await SyncQueue.clearAuthRecord(); } catch (e) {} },

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
      // [p113] 로그아웃 → 토큰 자동갱신 타이머 해제(리스너 자체는 재바인딩 가드가 있어 그대로 둬도 무해).
      this._usingFirebase = false;
      if (this._idTokenTimer) { clearTimeout(this._idTokenTimer); this._idTokenTimer = null; }
      this._suppressDemoBadge = false;  // 다음 수동 데모 로그인 시 배지 정상 표시되도록 초기화
      this._offlineOnly = false; this.projectRole = null; this.projectCanManage = false;
      this.clearReauth();   // [WO 20261001-bulkreauth] 재인증 토큰도 로그아웃과 함께 폐기
      try { sessionStorage.removeItem("wm_id_token"); localStorage.removeItem("wm_local_token"); } catch (e) {}
      this._clearAuthCache();   // 오프라인 권한 캐시도 함께 정리
      this.clearOfflineVerifier();  // [P40] 오프라인 재인증 검증자 삭제 — 로그아웃 후엔 이 기기에서 오프라인 진입 불가
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