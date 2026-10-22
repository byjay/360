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
      // 비밀번호 변경(초대 계정 첫 로그인)
      $("pwc-submit") && $("pwc-submit").addEventListener("click", () => this._submitPwChange());
      const pwc2 = $("pwc-new2");
      if (pwc2) pwc2.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); this._submitPwChange(); } });
      // [WO 20261022-smallfixes R3] 비밀번호 입력은 각자 <form> 으로 감싸(DOM 경고 제거) — 제출해도
      //   페이지 이동 없이 기존 버튼 핸들러와 동일한 동작만 실행한다(preventDefault, §G-2-5 한 지점).
      this._bindPwForm("cg-pw-form", () => {});
      this._bindPwForm("cg-pw2-form", () => this._verify());
      this._bindPwForm("cg-login-pw-form", () => this._login());
      this._bindPwForm("pwc-new-form", () => {});
      this._bindPwForm("pwc-new2-form", () => this._submitPwChange());
    },
    /** 비밀번호 <form> 제출 → 페이지 이동 금지 + 지정된 기존 동작만 실행(§G-2-5 공유 바인딩 지점). */
    _bindPwForm(formId, onSubmit) {
      const f = document.getElementById(formId);
      if (!f) return;
      f.addEventListener("submit", (e) => { e.preventDefault(); try { onSubmit(); } catch (err) {} });
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
          dc.innerHTML = "메일 발송 미설정 — 개발/시연용 인증코드: <b>" + j.dev_code + "</b>";
          dc.classList.remove("hidden");
          $("cg-code").value = j.dev_code;
        } else {
          dc.classList.add("hidden"); dc.textContent = "";
          const mins = j.valid_minutes || 60;
          Prompt.toast && Prompt.toast("인증코드를 이메일로 발송했습니다. (" + mins + "분 이내 입력)");
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
        this._pendingPw = pw;   // [P40] 오프라인 재인증 검증자 생성용(메모리에서만, 저장 후 즉시 폐기)
        this._onAuthed(j.token, j.name || j.email, { email: this._email, name: j.name, role: j.role });
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
        // [하위호환] must_change_password=1 로 남아 있는 구(舊) 초대 계정만 비밀번호 변경 강제.
        //   신규 초대는 초대 링크에서 본인이 직접 비밀번호를 설정하므로 이 분기를 타지 않는다.
        if (j.must_change) {
          try { sessionStorage.setItem("wm_id_token", j.token); localStorage.setItem("wm_local_token", j.token); } catch (e) {}
          if (typeof Auth !== "undefined") Auth.idToken = j.token;
          this._pendingName = j.name || j.email;
          this._pendingProfile = { email: email, name: j.name, role: j.role };
          this._openPwChange();
          return;
        }
        this._pendingPw = pw;   // [P40] 오프라인 재인증 검증자 생성용
        this._onAuthed(j.token, j.name || j.email, { email: email, name: j.name, role: j.role });
      } catch (e) {
        // [P40] 네트워크 실패 → 이 기기에 저장된 오프라인 검증자로 재인증 시도(오프라인 작업 전용).
        const off = await this._tryOfflineLogin(email, pw);
        if (!off) this._err("네트워크 오류로 로그인에 실패했습니다.");
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = orig; }
      }
    },

    /* ── 비밀번호 변경 (초대 계정 첫 로그인 강제) ── */
    _openPwChange() {
      const m = document.getElementById("pwchange-modal");
      if (!m) { this._onAuthed(Auth.idToken, this._pendingName || ""); return; }
      const e = document.getElementById("pwc-error"); if (e) e.classList.add("hidden");
      const a = document.getElementById("pwc-new"), b = document.getElementById("pwc-new2");
      if (a) a.value = ""; if (b) b.value = "";
      m.classList.remove("hidden"); requestAnimationFrame(() => m.classList.add("on"));
      setTimeout(() => { a && a.focus(); }, 120);
    },
    async _submitPwChange() {
      const $ = (id) => document.getElementById(id);
      const err = $("pwc-error"); if (err) err.classList.add("hidden");
      const np = ($("pwc-new").value || ""), np2 = ($("pwc-new2").value || "");
      const showErr = (msg) => { if (err) { err.textContent = msg; err.classList.remove("hidden"); } };
      if (np.length < 4) { showErr("새 비밀번호는 4자 이상이어야 합니다."); return; }
      if (np !== np2) { showErr("두 비밀번호가 일치하지 않습니다."); return; }
      const btn = $("pwc-submit"); const orig = btn ? btn.textContent : "";
      if (btn) { btn.disabled = true; btn.textContent = "변경 중..."; }
      try {
        const r = await fetch("/api/account/password", {
          method: "POST", headers: Auth.headers(), body: JSON.stringify({ newPassword: np })
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { showErr(j.error || "변경에 실패했습니다."); return; }
        const m = $("pwchange-modal"); if (m) { m.classList.remove("on"); setTimeout(() => m.classList.add("hidden"), 200); }
        Prompt && Prompt.toast && Prompt.toast("비밀번호가 변경되었습니다.");
        this._pendingPw = np;   // [P40] 변경된 비밀번호로 오프라인 검증자 갱신
        this._onAuthed(Auth.idToken, this._pendingName || "", this._pendingProfile || null);
      } catch (e) {
        showErr("네트워크 오류로 변경에 실패했습니다.");
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = orig; }
      }
    },
    /** [P40] 오프라인 재인증 — 검증자는 "이 기기에서 온라인 로그인에 성공한 적 있는" 사용자만 갖는다.
     *  성공해도 서버 토큰은 발급되지 않는다(Auth.offlineLogin 참조) → 서버 쓰기는 온라인 복귀 후. */
    async _tryOfflineLogin(email, pw) {
      if (typeof Auth === "undefined" || !Auth.offlineLogin) return false;
      const r = await Auth.offlineLogin(email, pw);
      if (!r || !r.ok) {
        if (r && r.reason === "bad-password") this._err("비밀번호가 올바르지 않습니다. (오프라인 확인 · 남은 시도 " + r.remaining + "회)");
        else if (r && r.reason === "locked") this._err("오프라인 로그인 시도 횟수를 초과했습니다. 인터넷에 연결해 로그인해 주세요.");
        else if (r && r.reason === "expired") this._err("오프라인 로그인 유효기간이 지났습니다. 인터넷에 연결해 로그인해 주세요.");
        return false;
      }
      this.close();
      Prompt.toast && Prompt.toast("오프라인 로그인 — " + (r.user.name || r.user.email) + " · 작성한 내용은 온라인 복귀 후 자동 업로드됩니다", 4200);
      if (App.openApp) App.openApp("viewer");
      return true;
    },

    _onAuthed(token, displayName, profile) {
      // 로컬 세션 토큰 저장 → Auth 가 Bearer 로 사용 (idToken 슬롯 공용)
      try {
        sessionStorage.setItem("wm_id_token", token);
        localStorage.setItem("wm_local_token", token);
      } catch (e) {}
      if (typeof Auth !== "undefined") Auth.idToken = token;
      this.close();
      Prompt.toast && Prompt.toast("" + displayName + " 님으로 로그인되었습니다.");
      const done = () => {
        // [P40] 온라인 로그인 성공 시점에만 오프라인 검증자 저장 → 비번은 즉시 폐기(저장 안 함)
        const pw = this._pendingPw; this._pendingPw = null;
        const em = (profile && profile.email) || (typeof Auth !== "undefined" && Auth.user ? Auth.user.email : null);
        if (pw && em && typeof Auth !== "undefined" && Auth.saveOfflineVerifier) {
          Auth.saveOfflineVerifier(em, pw, {
            name: (profile && profile.name) || displayName,
            role: (typeof Auth !== "undefined" && Auth.role) || (profile && profile.role) || "viewer"
          });
        }
        if (typeof Install !== "undefined" && Install.maybePrompt) Install.maybePrompt();
        if (App.openApp) App.openApp("viewer");
      };
      // 인증 상태 갱신 후 뷰어로
      if (typeof Auth !== "undefined" && Auth.refresh) {
        Auth.refresh().then(done).catch(done);
      } else { done(); }
    }
  };

  /* ══════════════════════════════════════════
     PROMPT — 범용 입력 모달 (프로젝트/데크 생성)
  ══════════════════════════════════════════ */