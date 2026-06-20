  const CompanyAuth = {
    _email: null,
    init() {
      const $ = (id) => document.getElementById(id);
      const el = $("company-gate");
      if (!el) return;
      // 진입 버튼(로그인 게이트 안)
      $("login-gate-company") && $("login-gate-company").addEventListener("click", () => {
        const lg = $("login-gate"); if (lg) lg.classList.add("hidden");
        this.open();
      });
      $("company-gate-cancel") && $("company-gate-cancel").addEventListener("click", () => this.close());
      const bd = el.querySelector(".company-gate-backdrop");
      bd && bd.addEventListener("click", () => this.close());
      // 탭 전환
      $("company-tab-signup") && $("company-tab-signup").addEventListener("click", () => this._tab("signup"));
      $("company-tab-login") && $("company-tab-login").addEventListener("click", () => this._tab("login"));
      // 가입 흐름
      $("cg-send-code") && $("cg-send-code").addEventListener("click", () => this._sendCode());
      $("cg-resend") && $("cg-resend").addEventListener("click", () => this._sendCode(true));
      $("cg-change-email") && $("cg-change-email").addEventListener("click", () => this._backToEmail());
      $("cg-create") && $("cg-create").addEventListener("click", () => this._verify());
      // 로그인 흐름
      $("cg-login-btn") && $("cg-login-btn").addEventListener("click", () => this._login());
    },
    _projectId() {
      try { return (typeof Projects !== "undefined" && Projects.currentProject) ? Projects.currentProject.id : null; }
      catch { return null; }
    },
    _err(msg) {
      const e = document.getElementById("company-gate-error");
      if (!e) return;
      if (msg) { e.textContent = msg; e.classList.remove("hidden"); }
      else { e.textContent = ""; e.classList.add("hidden"); }
    },
    _tab(which) {
      const $ = (id) => document.getElementById(id);
      this._err(null);
      $("company-tab-signup").classList.toggle("active", which === "signup");
      $("company-tab-login").classList.toggle("active", which === "login");
      $("company-panel-signup").classList.toggle("hidden", which !== "signup");
      $("company-panel-login").classList.toggle("hidden", which !== "login");
    },
    async open() {
      const el = document.getElementById("company-gate");
      if (!el) return;
      this._err(null);
      this._backToEmail();
      this._tab("signup");
      el.classList.remove("hidden");
      // 가입 정책 안내 로드
      try {
        const pid = this._projectId();
        const r = await fetch("/api/signup/policy" + (pid ? ("?project_id=" + encodeURIComponent(pid)) : ""));
        const j = await r.json();
        const note = document.getElementById("cg-policy-note");
        if (note) {
          if (j.whitelist_enabled && j.allowed_domains && j.allowed_domains.length) {
            note.textContent = "허용 회사 도메인: " + j.allowed_domains.map(d => "@" + d).join(", ");
          } else {
            note.textContent = j.note || "회사 이메일(@회사도메인)로만 가입할 수 있습니다.";
          }
        }
      } catch (e) {}
    },
    close() {
      const el = document.getElementById("company-gate");
      if (el) el.classList.add("hidden");
    },
    _backToEmail() {
      const $ = (id) => document.getElementById(id);
      $("company-step-email") && $("company-step-email").classList.remove("hidden");
      $("company-step-verify") && $("company-step-verify").classList.add("hidden");
      const dc = $("cg-dev-code"); if (dc) { dc.classList.add("hidden"); dc.textContent = ""; }
    },
    async _sendCode(isResend) {
      const $ = (id) => document.getElementById(id);
      this._err(null);
      const email = ($("cg-email").value || "").trim().toLowerCase();
      if (!email) { this._err("회사 이메일 주소를 입력해 주세요."); return; }
      const btn = isResend ? $("cg-resend") : $("cg-send-code");
      const orig = btn ? btn.textContent : "";
      if (btn) { btn.disabled = true; btn.textContent = "전송 중..."; }
      try {
        const pid = this._projectId();
        const r = await fetch("/api/signup/send-code", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, project_id: pid || undefined })
        });
        const j = await r.json();
        if (!r.ok) { this._err(j.error || "코드 발송에 실패했습니다."); return; }
        this._email = email;
        this._invited = !!j.invited;
        $("cg-verify-email").textContent = email;
        $("company-step-email").classList.add("hidden");
        $("company-step-verify").classList.remove("hidden");
        // 사전 등록(초대) 계정 안내 + 회사명 기본값 채움
        const badge = $("cg-invited-badge");
        if (badge) badge.classList.toggle("hidden", !j.invited);
        if (j.invited && j.invite_company) { const cc = $("cg-company"); if (cc && !cc.value) cc.value = j.invite_company; }
        // dev-fallback 코드 표시(메일 미설정 시)
        const dc = $("cg-dev-code");
        if (j.dev_code) {
          dc.innerHTML = "📧 메일 발송 미설정 — 개발/시연용 인증코드: <b>" + j.dev_code + "</b>";
          dc.classList.remove("hidden");
          $("cg-code").value = j.dev_code;
        } else {
          dc.classList.add("hidden"); dc.textContent = "";
          const mins = j.valid_minutes || 60;
          Prompt.toast && Prompt.toast("📧 인증코드를 이메일로 발송했습니다. (" + mins + "분 이내 입력)");
        }
      } catch (e) {
        this._err("네트워크 오류로 코드 발송에 실패했습니다.");
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = orig; }
      }
    },
    async _verify() {
      const $ = (id) => document.getElementById(id);
      this._err(null);
      const code = ($("cg-code").value || "").trim();
      const pw = $("cg-pw").value || "";
      const pw2 = $("cg-pw2").value || "";
      const name = ($("cg-name").value || "").trim();
      const company = (($("cg-company") && $("cg-company").value) || "").trim();
      const dept = (($("cg-dept") && $("cg-dept").value) || "").trim();
      if (!/^\d{6}$/.test(code)) { this._err("인증코드 6자리를 입력해 주세요."); return; }
      if (pw.length < 8) { this._err("비밀번호는 8자 이상이어야 합니다."); return; }
      if (pw !== pw2) { this._err("비밀번호가 일치하지 않습니다."); return; }
      if (!name) { this._err("이름을 입력해 주세요."); return; }
      if (!dept) { this._err("부서/소속을 입력해 주세요."); return; }
      // 사전 등록(초대) 계정은 회사명 필수
      if (this._invited && !company) { this._err("회사명을 입력해 주세요."); return; }
      const btn = $("cg-create"); const orig = btn ? btn.textContent : "";
      if (btn) { btn.disabled = true; btn.textContent = "처리 중..."; }
      try {
        const pid = this._projectId();
        const r = await fetch("/api/signup/verify", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: this._email, code, password: pw, name, company, department: dept, project_id: pid || undefined })
        });
        const j = await r.json();
        if (!r.ok) { this._err(j.error || "가입에 실패했습니다."); return; }
        this._onAuthed(j.token, j.name || j.email);
      } catch (e) {
        this._err("네트워크 오류로 가입에 실패했습니다.");
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = orig; }
      }
    },
    async _login() {
      const $ = (id) => document.getElementById(id);
      this._err(null);
      const email = ($("cg-login-email").value || "").trim().toLowerCase();
      const pw = $("cg-login-pw").value || "";
      if (!email || !pw) { this._err("이메일과 비밀번호를 입력해 주세요."); return; }
      const btn = $("cg-login-btn"); const orig = btn ? btn.textContent : "";
      if (btn) { btn.disabled = true; btn.textContent = "로그인 중..."; }
      try {
        const r = await fetch("/api/signup/login", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password: pw })
        });
        const j = await r.json();
        if (!r.ok) { this._err(j.error || "로그인에 실패했습니다."); return; }
        this._onAuthed(j.token, j.name || j.email);
      } catch (e) {
        this._err("네트워크 오류로 로그인에 실패했습니다.");
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = orig; }
      }
    },
    _onAuthed(token, displayName) {
      // 로컬 세션 토큰 저장 → Auth 가 Bearer 로 사용 (idToken 슬롯 공용)
      try {
        sessionStorage.setItem("wm_id_token", token);
        localStorage.setItem("wm_local_token", token);
      } catch (e) {}
      if (typeof Auth !== "undefined") Auth.idToken = token;
      this.close();
      Prompt.toast && Prompt.toast("✅ " + displayName + " 님으로 로그인되었습니다.");
      // 인증 상태 갱신 후 뷰어로
      if (typeof Auth !== "undefined" && Auth.refresh) {
        Auth.refresh().then(() => { if (App.openApp) App.openApp("viewer"); }).catch(() => { if (App.openApp) App.openApp("viewer"); });
      } else {
        if (App.openApp) App.openApp("viewer");
      }
    }
  };

  /* ══════════════════════════════════════════
     PROMPT — 범용 입력 모달 (프로젝트/데크 생성)
  ══════════════════════════════════════════ */