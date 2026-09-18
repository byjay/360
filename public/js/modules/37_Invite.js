  /* ══════════════════════════════════════════
     INVITE — 프로젝트 초대 링크 수락 (?invite=<token>)
     [보안 P40] 초대는 더 이상 계정을 미리 만들지 않는다(기본 비밀번호 '1' 제거).
       링크를 연 본인이 이름 + 비밀번호를 직접 설정해야 계정이 생긴다.
       이미 계정이 있는 이메일이면 이름·비번을 다시 묻지 않고 멤버십만 추가한다.
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
        // 기존 계정이면 이름/비번 입력을 숨긴다(다시 묻지 않는다)
        const fields = $("inv-newacct-fields");
        const existing = $("inv-existing-msg");
        if (fields) fields.classList.toggle("hidden", !j.needs_account);
        if (existing) existing.classList.toggle("hidden", !!j.needs_account);
        const sub = $("inv-submit");
        if (sub) sub.textContent = j.needs_account ? "계정 만들고 참여" : "프로젝트 참여";
        if (j.needs_account) setTimeout(() => { const n = $("inv-name"); n && n.focus(); }, 120);
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

    async accept() {
      if (!this._token || !this._info) return;
      const $ = (id) => document.getElementById(id);
      this._err(null);
      const needs = !!this._info.needs_account;
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
        const r = await fetch("/api/invite/" + encodeURIComponent(this._token) + "/accept", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(needs ? { name: name, password: pw } : {})
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { this._err(j.error || "참여에 실패했습니다."); return; }
        this._token = null;
        this.close();
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
