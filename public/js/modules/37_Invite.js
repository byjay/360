  /* ══════════════════════════════════════════
     INVITE — 프로젝트 초대 링크 수락 (?invite=<token>)
     [보안 P40] 초대는 더 이상 계정을 미리 만들지 않는다(기본 비밀번호 '1' 제거).
       링크를 연 본인이 이름 + 비밀번호를 직접 설정해야 계정이 생긴다.
       이미 계정이 있는 이메일이면 이름·비번을 다시 묻지 않고 멤버십만 추가한다.
     [WO 20261001-invite] 🔴 링크는 신원 증명이 아니다 — 가입된 이메일은 **그 이메일로 로그인한 상태에서만** 수락.
       비로그인이면 로그인 게이트 → 로그인 후 같은 토큰으로 자동 재시도(resumePending). 다른 계정이면 403 안내.
  ══════════════════════════════════════════ */
  const Invite = {
    TOKEN_PARAM: "invite",
    _token: null,
    _info: null,

    init() {
      const $ = (id) => document.getElementById(id);
      $("inv-submit") && $("inv-submit").addEventListener("click", () => this.accept());
      $("invite-gate-cancel") && $("invite-gate-cancel").addEventListener("click", () => this.close());
      const pw2 = $("inv-pw2");
      if (pw2) pw2.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); this.accept(); } });
      // [WO 20261022-smallfixes R3] 비밀번호 입력을 각자 <form> 으로 감싸(DOM 경고 제거) — 제출해도
      //   페이지 이동 없이 기존 accept() 만 실행한다(preventDefault).
      const bindPwForm = (formId, onSubmit) => {
        const f = $(formId);
        if (f) f.addEventListener("submit", (e) => { e.preventDefault(); try { onSubmit(); } catch (err) {} });
      };
      bindPwForm("inv-pw-form", () => {});
      bindPwForm("inv-pw2-form", () => this.accept());
      return this.detect();
    },

    /** URL 에서 초대 토큰을 읽고 즉시 주소창에서 제거한다.
     *  (토큰은 1회용 자격증명 — 브라우저 히스토리/스크린샷/Referer 에 남기지 않는다.) */
    detect() {
      let t = null;
      try { t = new URLSearchParams(location.search).get(this.TOKEN_PARAM); } catch (e) { t = null; }
      if (!t) return false;
      this._token = t;
      try { history.replaceState({}, "", location.pathname); } catch (e) {}
      this.open();
      return true;
    },

    _err(msg) {
      const e = document.getElementById("inv-error");
      if (!e) return;
      if (msg) { e.textContent = msg; e.classList.remove("hidden"); }
      else { e.textContent = ""; e.classList.add("hidden"); }
    },

    async open() {
      const m = document.getElementById("invite-gate");
      if (!m || !this._token) return;
      this._err(null);
      m.classList.remove("hidden");
      requestAnimationFrame(() => m.classList.add("on"));
      const $ = (id) => document.getElementById(id);
      try {
        const r = await fetch("/api/invite/" + encodeURIComponent(this._token));
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { this._err(j.error || "초대 링크가 유효하지 않거나 만료되었습니다."); this._disable(); return; }
        this._info = j;
        $("inv-project") && ($("inv-project").textContent = j.project_name || j.project_id);
        $("inv-email") && ($("inv-email").textContent = j.email);
        const roleLabel = (typeof Auth !== "undefined" && Auth._ROLE_LABELS && Auth._ROLE_LABELS[j.role]) || j.role;
        $("inv-role") && ($("inv-role").textContent = roleLabel);
        // [WO 20261001-invite ①] 화면 모드 = 서버 수락 규칙과 같은 3분기(서버가 최종 판정 — 여기는 안내만)
        //   self  : 초대 이메일로 로그인한 상태 → 바로 참여
        //   wrong : 다른 계정으로 로그인한 상태 → "초대받은 이메일로 로그인하세요"
        //   login : 비로그인 + 이미 가입된 이메일 → 로그인하면 같은 링크로 자동 참여
        //   new   : 비로그인 + 신규 이메일 → 이름·비밀번호로 가입 + 참여(종전)
        const me = this._myEmail();
        const inv = String(j.email || "").toLowerCase();
        this._mode = me ? (me === inv ? "self" : "wrong") : (j.needs_account ? "new" : "login");
        const fields = $("inv-newacct-fields");
        const existing = $("inv-existing-msg");
        if (fields) fields.classList.toggle("hidden", this._mode !== "new");
        if (existing) {
          existing.textContent = this._mode === "self" ? "로그인된 계정으로 바로 참여합니다."
            : "이미 가입된 이메일입니다. " + j.email + " 로 로그인하면 자동으로 참여됩니다.";
          existing.classList.toggle("hidden", this._mode === "new" || this._mode === "wrong");
        }
        const sub = $("inv-submit");
        if (sub) sub.textContent = { self: "프로젝트 참여", login: "로그인하고 참여", new: "계정 만들고 참여", wrong: "프로젝트 참여" }[this._mode];
        if (sub) sub.disabled = this._mode === "wrong";
        if (this._mode === "wrong") this._err("초대받은 이메일(" + j.email + ")로 로그인하세요. 현재 로그인: " + me);
        if (this._mode === "new") setTimeout(() => { const n = $("inv-name"); n && n.focus(); }, 120);
      } catch (e) {
        this._err("네트워크 오류 — 인터넷에 연결한 뒤 초대 링크를 다시 열어 주세요.");
        this._disable();
      }
    },

    _disable() {
      const s = document.getElementById("inv-submit");
      if (s) s.disabled = true;
      const f = document.getElementById("inv-newacct-fields");
      if (f) f.classList.add("hidden");
    },

    close() {
      const m = document.getElementById("invite-gate");
      if (!m) return;
      m.classList.remove("on");
      setTimeout(() => m.classList.add("hidden"), 200);
    },

    /** 실계정으로 로그인한 이메일(없으면 ''). 열람 전용 토큰(공유 링크)은 실계정이 아니다. */
    _myEmail() {
      if (typeof Auth === "undefined" || !Auth.user || Auth.readonly) return "";
      return String(Auth.user.email || "").toLowerCase();
    },

    PENDING_KEY: "wm_pending_invite",
    /** 로그인 후 자동 수락할 토큰 보관(sessionStorage — 탭 한정, 1회용 자격증명이라 영구 저장 금지). */
    _savePending(t) { try { sessionStorage.setItem(this.PENDING_KEY, t); } catch (e) {} },

    /** 서버가 '이 이메일로 로그인' 을 요구 → 토큰 보관 + 초대 창 닫고 로그인 게이트. 로그인 후 resumePending 이 재시도한다. */
    _toLogin(msg) {
      this._savePending(this._token);
      this.close();
      try { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast(msg || "초대받은 이메일로 로그인하면 자동으로 참여됩니다.", 4000); } catch (e) {}
      try { if (typeof Auth !== "undefined" && Auth._openGate) Auth._openGate(); } catch (e) {}
    },

    /** [WO 20261001-invite ①] Auth.refresh() 가 실계정 로그인 확인 직후 호출 — 보관된 토큰으로 자동 수락 1회 재시도. */
    async resumePending() {
      let t = null;
      try { t = sessionStorage.getItem(this.PENDING_KEY); sessionStorage.removeItem(this.PENDING_KEY); } catch (e) { t = null; }
      if (!t) return false;
      let r, j = {};
      try {
        r = await fetch("/api/invite/" + encodeURIComponent(t) + "/accept", { method: "POST", headers: Auth.headers(), body: "{}" });
        j = await r.json().catch(() => ({}));
      } catch (e) { this._savePending(t); return false; }   // 오프라인 → 다음 로그인 확인 때 다시
      if (r.ok) {
        try { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("초대받은 프로젝트에 참여했습니다.", 3200); } catch (e) {}
        try { if (typeof ProjectHub !== "undefined" && ProjectHub.refreshIfVisible) ProjectHub.refreshIfVisible(); } catch (e) {}
        return true;
      }
      // 403(다른 계정) 등 → 초대 창을 다시 열어 사유를 보여준다(조용한 실패 금지)
      this._token = t;
      await this.open();
      if (j && j.error) this._err(j.error);
      return false;
    },

    async accept() {
      if (!this._token || !this._info) return;
      const $ = (id) => document.getElementById(id);
      this._err(null);
      if (this._mode === "login") { this._toLogin(); return; }
      const needs = this._mode === "new";
      const name = needs ? (($("inv-name") || {}).value || "").trim() : "";
      const pw = needs ? (($("inv-pw") || {}).value || "") : "";
      const pw2 = needs ? (($("inv-pw2") || {}).value || "") : "";
      if (needs) {
        if (!name) { this._err("이름을 입력해 주세요."); return; }
        if (pw.length < 8) { this._err("비밀번호는 8자 이상이어야 합니다."); return; }
        if (pw !== pw2) { this._err("두 비밀번호가 일치하지 않습니다."); return; }
      }
      const btn = $("inv-submit"); const orig = btn ? btn.textContent : "";
      if (btn) { btn.disabled = true; btn.textContent = "처리 중..."; }
      try {
        // 로그인 상태면 세션을 실어 보낸다 — 서버가 '로그인 이메일 = 초대 이메일' 을 검사한다
        const headers = (this._myEmail() && typeof Auth !== "undefined") ? Auth.headers() : { "Content-Type": "application/json" };
        const r = await fetch("/api/invite/" + encodeURIComponent(this._token) + "/accept", {
          method: "POST", headers: headers,
          body: JSON.stringify(needs ? { name: name, password: pw } : {})
        });
        const j = await r.json().catch(() => ({}));
        if (r.status === 401 && j.code === "login_required") { this._toLogin(j.error); return; }
        if (!r.ok) { this._err(j.error || "참여에 실패했습니다."); return; }
        this._token = null;
        this.close();
        if (!j.token) {
          // 본인 로그인 상태로 수락 — 새 세션 없음. 권한·허브만 갱신한다.
          try { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("초대받은 프로젝트에 참여했습니다.", 3200); } catch (e) {}
          if (typeof Auth !== "undefined" && Auth.refresh) await Auth.refresh();
          return;
        }
        // 기존 CompanyAuth 로그인 완료 경로를 그대로 재사용한다(세션 저장 + 오프라인 검증자 + 설치 유도).
        if (typeof CompanyAuth !== "undefined" && CompanyAuth._onAuthed) {
          if (needs) CompanyAuth._pendingPw = pw;
          CompanyAuth._onAuthed(j.token, j.name || j.email, { email: j.email, name: j.name, role: j.role });
        }
      } catch (e) {
        this._err("네트워크 오류로 참여하지 못했습니다.");
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = orig; }
      }
    }
  };
