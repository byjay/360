  /* ══════════════════════════════════════════════════════════════════
     [WO 20261016-viewmail] ViewerAuth — 열람 링크 이메일 인증(열람자) + 열람자 이메일 관리·기록(디자이너)

     마스터 2026-10-16: "본인 이메일로 보안코드 받고 그 사람, 즉 메일 주소별 사용자 사용 로그를 구현하자"
                        "메일로 받은 링크가 진짜인 거지" — 고른 사람만 열람 · 링크를 재전달해도 무효.

     🔴 차단의 정본은 서버다(src/index.tsx viewEmailGate — 요청마다 수신자·세대 검증). 이 모듈은
        "통행증을 받아온다"(ShareGate 와 같은 역할)와 "디자이너 관리 화면"만 맡는다.
     흐름(열람자): Auth._mintAutoEntryToken 이 401 email_auth_required 를 받으면 ensure() →
        ① 주소에 메일 링크 표식(#va= 서버 매직링크 · ?mode=signIn&oobCode= Firebase 이메일 링크)이 있으면 완료 → 통행증
        ② 이 브라우저에 저장된 이 링크의 통행증이 아직 유효하면 그대로
        ③ 아니면 "초대받은 이메일 입력" 화면 — 통과할 때까지 열람으로 진행하지 않는다(다른 탭에서 메일 링크를 열면 storage 이벤트로 이어받음).
     Firebase 어댑터는 주입 가능(window.WM_VIEWER_AUTH_FB) — 테스트 스텁·대체 구현용. 기본 구현은 **별도 앱 인스턴스**
        ('wm-viewer-auth', 메모리 보관)라 디자이너 로그인(SeaFirebase 기본 앱) 상태를 건드리지 않는다.
     색 대비(인라인 — 테마 변수 미사용): 본문 #e6edf7/#111a2e 14.6:1 · 보조 #9fb0c9/#111a2e 7.7:1 · 버튼 #04121f/#38bdf8 9.9:1 · 오류 #fca5a5/#111a2e 8.9:1
  ══════════════════════════════════════════════════════════════════ */
  const ViewerAuth = {
    EMAIL_LS: "wm_vauth_email",
    FB_VER: "10.12.2",
    email: null,
    _tracking: false,
    _fbState: null,
    _pendingErr: "",

    _linkId(params) { return params ? String(params.v || params.t || params.lk || params.d || "") : ""; },
    _passKey(params) { return "wm_vpass_" + this._linkId(params); },
    _esc(s) { return (typeof UI !== "undefined" && UI.escapeHtml) ? UI.escapeHtml(s) : String(s == null ? "" : s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])); },

    /** Firebase 이메일 링크 어댑터 { projectId, isLink(href), send(email,url), complete(email,href) → ID 토큰 }. */
    async fb() {
      if (window.WM_VIEWER_AUTH_FB) return window.WM_VIEWER_AUTH_FB;
      if (this._fbState) return this._fbState;
      const cfg = window.FIREBASE_CONFIG;
      if (!cfg || !cfg.apiKey) throw new Error("Firebase 설정이 없습니다");
      const base = "https://www.gstatic.com/firebasejs/" + this.FB_VER + "/";
      const appMod = await import(base + "firebase-app.js");
      const authMod = await import(base + "firebase-auth.js");
      const app = appMod.getApps().find((a) => a.name === "wm-viewer-auth") || appMod.initializeApp(cfg, "wm-viewer-auth");
      let auth;
      try { auth = authMod.initializeAuth(app, { persistence: authMod.inMemoryPersistence }); } catch (e) { auth = authMod.getAuth(app); }
      this._fbState = {
        projectId: cfg.projectId || "",
        isLink: (href) => authMod.isSignInWithEmailLink(auth, href),
        send: (email, url) => authMod.sendSignInLinkToEmail(auth, email, { url, handleCodeInApp: true }),
        complete: async (email, href) => {
          const cred = await authMod.signInWithEmailLink(auth, email, href);
          const t = await cred.user.getIdToken();
          try { await authMod.signOut(auth); } catch (e) {}
          return t;
        },
      };
      return this._fbState;
    },

    /** 🔴 진입 지점 — 이메일 통행증을 확보한다. 반환 = 통행증 토큰(성공할 때까지 반환하지 않는다). */
    async ensure(params) {
      if (!params || !this._linkId(params)) return null;
      const done = await this._completeFromUrl(params);
      if (done) return done;
      const saved = this._stored(params);
      if (saved && await this._passOk(saved)) return saved;
      return await this._prompt(params);
    },

    _stored(params) {
      try {
        const j = JSON.parse(localStorage.getItem(this._passKey(params)) || "null");
        if (!j || !j.token || (j.exp && j.exp < Date.now())) { localStorage.removeItem(this._passKey(params)); return null; }
        return j.token;
      } catch (e) { return null; }
    },
    _save(params, token, exp) { try { localStorage.setItem(this._passKey(params), JSON.stringify({ token, exp })); } catch (e) {} },
    async _passOk(tok) {
      try { const r = await fetch("/api/auth/me", { headers: { Authorization: "Bearer " + tok } }); const j = await r.json(); return !!(j && j.authenticated); }
      catch (e) { return false; }
    },

    /** 메일 링크 표식 제거(주소창·기록에 1회용 비밀을 남기지 않는다). */
    _cleanUrl() {
      try {
        const u = new URL(location.href);
        ["apiKey", "oobCode", "mode", "lang", "continueUrl", "tenantId"].forEach((k) => u.searchParams.delete(k));
        let h = u.hash.replace(/(^#|&)va=[^&]*/, "").replace(/^#&/, "#");
        if (h === "#") h = "";
        history.replaceState(history.state, "", u.pathname + (u.searchParams.toString() ? "?" + u.searchParams.toString() : "") + h);
      } catch (e) {}
    },
    _continueUrl() {
      try {
        const u = new URL(location.href);
        ["apiKey", "oobCode", "mode", "lang", "continueUrl", "tenantId"].forEach((k) => u.searchParams.delete(k));
        return u.origin + u.pathname + (u.searchParams.toString() ? "?" + u.searchParams.toString() : "");
      } catch (e) { return location.origin + location.pathname; }
    },

    async _completeFromUrl(params) {
      const m = (location.hash || "").match(/(?:^#|&)va=([A-Za-z0-9_]+\.[a-f0-9]+)/);
      if (m) { this._cleanUrl(); return await this._complete(params, { challenge: m[1] }); }
      let q; try { q = new URLSearchParams(location.search); } catch (e) { return null; }
      if (q.get("mode") !== "signIn" || !q.get("oobCode")) return null;
      const href = location.href;
      let fb;
      try { fb = await this.fb(); } catch (e) { this._cleanUrl(); this._pendingErr = "인증 모듈을 불러오지 못했습니다: " + (e && e.message || e); return null; }
      let isLink = false;
      try { isLink = !!(await fb.isLink(href)); } catch (e) {}
      if (!isLink) { this._cleanUrl(); return null; }
      let email = "";
      try { email = localStorage.getItem(this.EMAIL_LS) || ""; } catch (e) {}
      if (!email) email = await this._askEmail("메일을 받은 이메일 주소를 입력해 주세요(요청한 기기와 다른 기기에서 열었을 때 1회).");
      let idToken = null;
      try { idToken = await fb.complete(email, href); }
      catch (e) { this._cleanUrl(); this._pendingErr = "메일 링크가 만료되었거나 이미 사용되었습니다. 이메일을 다시 입력해 새 링크를 받으세요."; return null; }
      this._cleanUrl();
      return await this._complete(params, { firebase_id_token: idToken });
    },

    async _complete(params, extra) {
      try {
        const r = await fetch("/api/view-auth/complete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.assign({}, params, extra)) });
        const j = await r.json().catch(() => ({}));
        if (r.ok && j && j.token) {
          this._save(params, j.token, j.exp);
          try { localStorage.removeItem(this.EMAIL_LS); } catch (e) {}
          this._closeModal();
          return j.token;
        }
        if (r.status === 410 && typeof ShareGate !== "undefined" && ShareGate.showWithdrawn) { ShareGate.showWithdrawn(); return new Promise(() => {}); }
        this._pendingErr = (j && j.error) || ("인증에 실패했습니다(HTTP " + r.status + ").");
      } catch (e) { this._pendingErr = "네트워크 오류로 인증을 마치지 못했습니다. 잠시 후 다시 시도하세요."; }
      return null;
    },

    /* ── 열람자 화면(인라인 스타일 — 테마·외부 CSS 와 무관하게 대비 고정) ── */
    _modal() {
      let el = document.getElementById("va-modal");
      if (el) return el;
      el = document.createElement("div");
      el.id = "va-modal";
      el.setAttribute("role", "dialog");
      el.setAttribute("aria-modal", "true");
      el.setAttribute("aria-labelledby", "va-title");
      el.style.cssText = "position:fixed;inset:0;z-index:2147482000;background:#0b1220;display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;font-family:Pretendard,system-ui,-apple-system,'Segoe UI',sans-serif";
      el.innerHTML =
        '<div style="max-width:420px;width:100%;background:#111a2e;border:1px solid #2b3b5c;border-radius:14px;padding:22px;box-sizing:border-box;color:#e6edf7">' +
        '<h2 id="va-title" style="font-size:18px;line-height:1.4;margin:0 0 8px;color:#e6edf7">초대받은 이메일로 열람</h2>' +
        '<p id="va-sub" style="font-size:13px;line-height:1.6;margin:0 0 14px;color:#9fb0c9">이 링크는 초대받은 사람만 열 수 있습니다. 초대받은 이메일을 입력하면 그 주소로 열람 링크를 보냅니다. 메일의 링크를 누르면 열립니다.</p>' +
        '<label for="va-email" style="display:block;font-size:12px;margin:0 0 6px;color:#9fb0c9">이메일</label>' +
        '<input id="va-email" type="email" autocomplete="email" inputmode="email" placeholder="name@company.com" style="display:block;width:100%;box-sizing:border-box;padding:11px 12px;border-radius:10px;border:1px solid #3b4d72;background:#0b1220;color:#e6edf7;font-size:15px">' +
        '<button id="va-send" type="button" style="display:block;margin-top:12px;width:100%;padding:11px;border-radius:10px;border:0;background:#38bdf8;color:#04121f;font-weight:700;font-size:15px;cursor:pointer">열람 링크 받기</button>' +
        '<p id="va-msg" role="status" aria-live="polite" style="font-size:13px;line-height:1.6;margin:12px 0 0;color:#e6edf7"></p>' +
        '<p style="font-size:12px;line-height:1.6;margin:12px 0 0;color:#9fb0c9">메일이 오지 않으면 스팸함을 확인하거나, 링크를 보내 준 담당자에게 문의하세요.</p>' +
        "</div>";
      document.body.appendChild(el);
      return el;
    },
    _msg(text, isErr) { const m = document.getElementById("va-msg"); if (m) { m.textContent = text || ""; m.style.color = isErr ? "#fca5a5" : "#e6edf7"; } },
    _closeModal() { const el = document.getElementById("va-modal"); if (el) el.remove(); },

    /** 다른 기기에서 Firebase 메일 링크를 연 경우 — 이메일 1회 재입력. */
    _askEmail(text) {
      const el = this._modal();
      const t = el.querySelector("#va-title"), sub = el.querySelector("#va-sub"), btn = el.querySelector("#va-send"), inp = el.querySelector("#va-email");
      if (t) t.textContent = "이메일 확인";
      if (sub) sub.textContent = text;
      if (btn) btn.textContent = "확인";
      return new Promise((resolve) => {
        const go = () => {
          const v = String(inp.value || "").trim().toLowerCase();
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) { this._msg("이메일 형식이 올바르지 않습니다.", true); return; }
          btn.removeEventListener("click", go);
          this._msg("확인 중…");
          resolve(v);
        };
        btn.addEventListener("click", go);
        inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go(); } });
        try { inp.focus(); } catch (e) {}
      });
    },

    /** 이메일 입력 → 메일 요청. 통행증이 생길 때까지(이 탭의 완료 또는 다른 탭의 storage 이벤트) 반환하지 않는다. */
    _prompt(params) {
      const el = this._modal();
      const inp = el.querySelector("#va-email"), btn = el.querySelector("#va-send");
      if (this._pendingErr) { this._msg(this._pendingErr, true); this._pendingErr = ""; }
      try { inp.focus(); } catch (e) {}
      return new Promise((resolve) => {
        const key = this._passKey(params);
        const onStorage = async (ev) => {
          if (ev.key !== key || !ev.newValue) return;
          const tok = this._stored(params);
          if (tok && await this._passOk(tok)) { window.removeEventListener("storage", onStorage); this._closeModal(); resolve(tok); }
        };
        window.addEventListener("storage", onStorage);
        const send = async () => {
          const email = String(inp.value || "").trim().toLowerCase();
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { this._msg("이메일 형식이 올바르지 않습니다.", true); return; }
          btn.disabled = true; btn.style.opacity = "0.7";
          this._msg("요청 중…");
          try {
            const r = await fetch("/api/view-auth/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.assign({}, params, { email })) });
            const j = await r.json().catch(() => ({}));
            if (!r.ok) { this._msg((j && j.error) || ("요청 실패(HTTP " + r.status + ")"), true); return; }
            if (j.method === "firebase") {
              const fb = await this.fb();
              if (j.firebase_project && fb.projectId && fb.projectId !== j.firebase_project) { this._msg("인증 설정이 서버와 다릅니다. 담당자에게 문의하세요.", true); return; }
              try { localStorage.setItem(this.EMAIL_LS, email); } catch (e) {}
              await fb.send(email, this._continueUrl());
            }
            this._msg((j.message || "메일을 보냈습니다.") + " 이 창은 열어 두어도 되고 닫아도 됩니다.");
          } catch (e) {
            this._msg("메일을 보내지 못했습니다: " + ((e && (e.code || e.message)) || e), true);
          } finally { btn.disabled = false; btn.style.opacity = ""; }
        };
        btn.addEventListener("click", send);
        inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); send(); } });
      });
    },

    /* ── 열람 기록(클라 측: 시작·종료·핀) — 구역·사진·동영상은 서버가 읽기 요청에서 직접 남긴다 ── */
    _tokEmail(tok) {
      try { return JSON.parse(atob(String(tok).slice(4).split(".")[0].replace(/-/g, "+").replace(/_/g, "/"))).e || null; } catch (e) { return null; }
    },
    event(kind, pin, keepalive) {
      const tok = (typeof Auth !== "undefined" && Auth.idToken) || "";
      if (!this._tracking || !tok) return;
      try {
        fetch("/api/view-auth/event", { method: "POST", keepalive: !!keepalive, headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok },
          body: JSON.stringify({ kind, target_id: pin && pin.id != null ? String(pin.id) : undefined, label: pin ? String(pin.label || pin.no || "") : undefined }) }).catch(() => {});
      } catch (e) {}
    },
    track() {
      if (this._tracking) return true;
      const tok = (typeof Auth !== "undefined" && Auth.idToken) || "";
      if (!/^ae1\./.test(tok) || !(typeof Auth !== "undefined" && Auth.user)) return false;
      const e = this._tokEmail(tok);
      if (!e) return false;
      this._tracking = true; this.email = e;
      this.event("open");
      window.addEventListener("pagehide", () => this.event("close", null, true));
      // 핀 열람 — App.openPano(pin) 은 모든 핀 진입점의 공유 지점(06_PanoViewer). 감싸서 기록만 더한다(동작 불변).
      if (typeof App !== "undefined" && typeof App.openPano === "function" && !App.openPano.__vaWrapped) {
        const orig = App.openPano;
        const wrapped = function (pin) { try { if (pin && pin.id != null) ViewerAuth.event("pin", pin); } catch (x) {} return orig.apply(this, arguments); };
        wrapped.__vaWrapped = true;
        App.openPano = wrapped;
      }
      return true;
    },
    bootTracking() {
      let n = 0;
      const tick = () => { if (this.track() || ++n > 120) return; setTimeout(tick, 1000); };
      setTimeout(tick, 500);
    },

    /* ══ 디자이너 — [열람자 기록] 관리 화면 ══ */
    async _api(method, url, body) {
      const r = await fetch(url, { method, headers: Object.assign({ "Content-Type": "application/json" }, (typeof Auth !== "undefined" && Auth.headers) ? Auth.headers() : {}), body: body == null ? undefined : JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, j };
    },
    _fmt(ts) { return ts ? new Date(ts).toLocaleString("ko-KR") : "-"; },
    METHOD_LABEL: { server: "서버 메일(1회용 링크)", firebase: "Firebase 이메일 링크(무료)" },
    KIND_LABEL: { auth_request: "링크 요청", auth: "인증 완료", open: "열람 시작", close: "열람 종료", zone: "구역", pin: "핀", photo: "사진", video: "동영상", invite: "초대 발송", blocked: "차단", removed: "삭제", mail_failed: "메일 실패" },

    /** 배포 결과 패널의 상태 줄(#deploy-viewer-auth) — 이메일 인증 상태·열람자 수. */
    async decorateDeployStatus(project) {
      const el = document.getElementById("deploy-viewer-auth");
      if (!el || !project || !project.id) return;
      const r = await this._api("GET", "/api/projects/" + encodeURIComponent(project.id) + "/viewer-access");
      if (!r.ok) { el.textContent = "열람자 설정을 불러오지 못했습니다(HTTP " + r.status + ")"; return; }
      const act = (r.j.recipients || []).filter((x) => x.status === "active").length;
      el.textContent = r.j.email_auth
        ? ("이메일 인증 켜짐 — 초대받은 이메일만 열람(열람자 " + act + "명)" + (act ? "" : " · [열람자 기록] 에서 이메일을 추가하세요") + (r.j.method ? "" : " · ⚠ 메일 발송 수단 없음"))
        : "이메일 인증 꺼짐 — 링크만 있으면 누구나 열람(기존 방식)";
    },

    async openManager(project) {
      if (!project || !project.id) return;
      const pid = project.id;
      let ov = document.getElementById("va-mgr");
      if (ov) ov.remove();
      ov = document.createElement("div");
      ov.id = "va-mgr";
      ov.setAttribute("role", "dialog");
      ov.setAttribute("aria-modal", "true");
      ov.setAttribute("aria-labelledby", "va-mgr-title");
      ov.style.cssText = "position:fixed;inset:0;z-index:2147481000;background:rgba(2,6,23,.72);display:flex;align-items:flex-start;justify-content:center;padding:4vh 12px;box-sizing:border-box;overflow:auto;font-family:Pretendard,system-ui,-apple-system,'Segoe UI',sans-serif";
      const btn = (id, label, color) => "<button type='button' data-va='" + id + "' style='padding:6px 12px;border-radius:8px;border:1px solid " + color + ";background:transparent;color:" + color + ";cursor:pointer;font-size:13px'>" + label + "</button>";
      ov.innerHTML =
        "<div style='max-width:760px;width:100%;background:#111a2e;border:1px solid #2b3b5c;border-radius:14px;padding:20px;box-sizing:border-box;color:#e6edf7'>" +
        "<div style='display:flex;align-items:center;gap:8px'><h2 id='va-mgr-title' style='font-size:18px;margin:0;flex:1;color:#e6edf7'>열람자 기록 · 이메일 인증</h2>" + btn("close", "닫기", "#cbd5e1") + "</div>" +
        "<label style='display:flex;gap:8px;align-items:center;margin:14px 0 4px;font-size:14px;color:#e6edf7'><input type='checkbox' id='va-mgr-on' style='width:18px;height:18px'> 이메일 인증 필요(초대받은 사람만 열람)</label>" +
        "<div id='va-mgr-method' style='font-size:12px;color:#9fb0c9;margin:0 0 12px'></div>" +
        "<div style='display:flex;gap:8px;align-items:flex-start'><textarea id='va-mgr-add' rows='2' placeholder='이메일(여러 개는 쉼표·줄바꿈)' style='flex:1;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid #3b4d72;background:#0b1220;color:#e6edf7;font-size:14px'></textarea>" +
        btn("add", "추가", "#34d399") + btn("invite", "초대 메일 보내기", "#38bdf8") + "</div>" +
        "<p id='va-mgr-msg' role='status' aria-live='polite' style='font-size:13px;margin:8px 0;color:#e6edf7'></p>" +
        "<div id='va-mgr-list' style='margin-top:6px'></div>" +
        "<div id='va-mgr-tl' style='margin-top:14px'></div>" +
        "</div>";
      document.body.appendChild(ov);
      const $ = (s) => ov.querySelector(s);
      const say = (t, err) => { const m = $("#va-mgr-msg"); m.textContent = t || ""; m.style.color = err ? "#fca5a5" : "#e6edf7"; };
      const base = "/api/projects/" + encodeURIComponent(pid) + "/viewer-access";
      const sendFirebase = async (res) => {
        if (!res || res.method !== "firebase" || !(res.sent || []).length) return [];
        const fb = await this.fb();
        const fails = [];
        for (const e of res.sent) { try { await fb.send(e, res.link); } catch (x) { fails.push(e + "(" + ((x && (x.code || x.message)) || x) + ")"); } }
        return fails;
      };
      const reportInvite = async (r) => {
        if (!r.ok) { say((r.j && r.j.error) || ("초대 실패(HTTP " + r.status + ")"), true); return; }
        let fbFails = [];
        try { fbFails = await sendFirebase(r.j); } catch (x) { fbFails = ["Firebase: " + ((x && x.message) || x)]; }
        const failed = (r.j.failed || []).map((f) => f.email + "(" + f.error + ")").concat(fbFails);
        say("초대 메일 " + ((r.j.sent || []).length - fbFails.length) + "건 발송" + (failed.length ? " · 실패: " + failed.join(", ") : "") + ((r.j.skipped || []).length ? " · 제외(차단·미등록): " + r.j.skipped.join(", ") : ""), failed.length > 0);
      };
      const showLog = async (email) => {
        const r = await this._api("GET", base + "/log?email=" + encodeURIComponent(email));
        const box = $("#va-mgr-tl");
        if (!r.ok) { box.textContent = "기록을 불러오지 못했습니다(HTTP " + r.status + ")"; return; }
        const rows = (r.j.data || []).map((x) => "<tr><td style='padding:4px 8px;white-space:nowrap'>" + this._esc(this._fmt(x.ts)) + "</td><td style='padding:4px 8px'>" + this._esc(this.KIND_LABEL[x.kind] || x.kind) +
          "</td><td style='padding:4px 8px;word-break:break-all'>" + this._esc(x.target_id || (x.detail && (x.detail.label || x.detail.method || x.detail.by)) || "") + "</td><td style='padding:4px 8px'>" + this._esc((x.device || "") + (x.country ? " · " + x.country : "")) + "</td></tr>").join("");
        box.innerHTML = "<h3 style='font-size:14px;margin:0 0 6px;color:#e6edf7'>" + this._esc(email) + " — 타임라인(최근 500건)</h3>" +
          (rows ? "<table style='width:100%;border-collapse:collapse;font-size:12px;color:#cbd5e1'>" + rows + "</table>" : "<p style='font-size:13px;color:#9fb0c9'>기록 없음</p>");
      };
      const render = async () => {
        const r = await this._api("GET", base);
        if (!r.ok) { say((r.j && r.j.error) || ("불러오기 실패(HTTP " + r.status + ")"), true); return; }
        $("#va-mgr-on").checked = !!r.j.email_auth;
        // [20261018-p164] 보관 기간 표시 — 서버 PERSONAL_LOG_RETENTION_DAYS(열람 기록)·인증 요청(짧은 토큰) SoT 그대로
        const rdays = Number.isFinite(r.j.retention_days) ? r.j.retention_days : null;
        const adays = Number.isFinite(r.j.auth_challenge_retention_days) ? r.j.auth_challenge_retention_days : null;
        $("#va-mgr-method").textContent = "메일 발송 수단: " + (this.METHOD_LABEL[r.j.method] || "⚠ 설정 없음 — 초대·인증 메일을 보낼 수 없습니다") + (r.j.published ? "" : " · 아직 배포 전") +
          (rdays ? (" · 열람 기록 보관 " + rdays + "일(자동 삭제)") : "") + (adays ? " · 인증 요청 기록 " + adays + "일" : "");
        const recs = r.j.recipients || [];
        $("#va-mgr-list").innerHTML = recs.length
          ? "<table style='width:100%;border-collapse:collapse;font-size:13px;color:#e6edf7'><tr style='color:#9fb0c9;text-align:left'><th style='padding:4px 8px'>이메일</th><th style='padding:4px 8px'>상태</th><th style='padding:4px 8px'>최근 접속</th><th style='padding:4px 8px'>열람</th><th></th></tr>" +
            recs.map((x) => "<tr style='border-top:1px solid #23314f'><td style='padding:6px 8px;word-break:break-all'>" + this._esc(x.email) + "</td><td style='padding:6px 8px;color:" + (x.status === "active" ? "#86efac" : "#fca5a5") + "'>" + (x.status === "active" ? "허용" : "차단") +
              "</td><td style='padding:6px 8px;white-space:nowrap'>" + this._esc(this._fmt(x.last_seen)) + "</td><td style='padding:6px 8px'>" + x.opens + "회</td><td style='padding:6px 8px;white-space:nowrap;display:flex;gap:4px'>" +
              "<button type='button' data-log='" + this._esc(x.email) + "' style='padding:3px 8px;border-radius:6px;border:1px solid #93c5fd;background:transparent;color:#93c5fd;cursor:pointer;font-size:12px'>기록</button>" +
              (x.status === "active"
                ? "<button type='button' data-block='" + this._esc(x.email) + "' style='padding:3px 8px;border-radius:6px;border:1px solid #f87171;background:transparent;color:#fca5a5;cursor:pointer;font-size:12px'>차단</button>"
                : "<button type='button' data-reinvite='" + this._esc(x.email) + "' style='padding:3px 8px;border-radius:6px;border:1px solid #fbbf24;background:transparent;color:#fcd34d;cursor:pointer;font-size:12px'>재초대</button>") +
              "<button type='button' data-del='" + this._esc(x.email) + "' style='padding:3px 8px;border-radius:6px;border:1px solid #64748b;background:transparent;color:#cbd5e1;cursor:pointer;font-size:12px'>삭제</button></td></tr>").join("") + "</table>"
          : "<p style='font-size:13px;color:#9fb0c9'>등록된 열람자가 없습니다. 이메일 인증이 켜져 있으면 아무도 열람할 수 없습니다.</p>";
      };
      ov.addEventListener("click", async (ev) => {
        const t = ev.target.closest ? ev.target.closest("button,[data-va]") : null;
        if (ev.target === ov) { ov.remove(); return; }
        if (!t) return;
        const va = t.getAttribute("data-va");
        if (va === "close") { ov.remove(); return; }
        if (va === "add") {
          const r = await this._api("POST", base + "/recipients", { emails: $("#va-mgr-add").value });
          if (!r.ok) { say((r.j && r.j.error) || ("추가 실패(HTTP " + r.status + ")"), true); return; }
          $("#va-mgr-add").value = "";
          say("추가 " + r.j.added.length + "명" + (r.j.exists.length ? " · 이미 있음 " + r.j.exists.length : "") + (r.j.invalid.length ? " · 형식 오류: " + r.j.invalid.join(", ") : ""), r.j.invalid.length > 0);
          await render(); return;
        }
        if (va === "invite") { say("초대 메일 보내는 중…"); await reportInvite(await this._api("POST", base + "/invite", {})); await render(); return; }
        const em = t.getAttribute("data-log") || t.getAttribute("data-block") || t.getAttribute("data-reinvite") || t.getAttribute("data-del");
        if (!em) return;
        const enc = encodeURIComponent(em);
        if (t.hasAttribute("data-log")) { await showLog(em); return; }
        if (t.hasAttribute("data-block")) {
          if (typeof Prompt !== "undefined" && Prompt.confirm && !(await Prompt.confirm("열람자 차단", em + " 을(를) 차단할까요?\n\n지금 열람 중이어도 다음 요청부터 즉시 막힙니다."))) return;
          const r = await this._api("POST", base + "/recipients/" + enc + "/block");
          say(r.ok ? em + " 차단됨" : ("차단 실패(HTTP " + r.status + ")"), !r.ok); await render(); return;
        }
        if (t.hasAttribute("data-reinvite")) { await reportInvite(await this._api("POST", base + "/recipients/" + enc + "/reinvite")); await render(); return; }
        if (t.hasAttribute("data-del")) {
          if (typeof Prompt !== "undefined" && Prompt.confirm && !(await Prompt.confirm("열람자 삭제", em + " 을(를) 목록에서 지울까요? (기록은 남습니다)"))) return;
          const r = await this._api("DELETE", base + "/recipients/" + enc);
          say(r.ok ? em + " 삭제됨" : ("삭제 실패(HTTP " + r.status + ")"), !r.ok); await render(); return;
        }
      });
      $("#va-mgr-on").addEventListener("change", async (ev) => {
        const on = !!ev.target.checked;
        const r = await this._api("PUT", base, { email_auth: on });
        say(r.ok ? (on ? "이메일 인증을 켰습니다 — 목록의 이메일만 열람합니다." : "이메일 인증을 껐습니다 — 링크만 있으면 누구나 열람합니다.") : ("변경 실패(HTTP " + r.status + ")"), !r.ok);
        await render();
        this.decorateDeployStatus(project);
      });
      await render();
    },
  };
  ViewerAuth.bootTracking();
