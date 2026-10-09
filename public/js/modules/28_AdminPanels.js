  const AdminPanels = {
    _features: {},           // 현재 적용된 기능 토글 상태
    _featScope: "*",

    /** 앱 시작 시 한 번 호출: 현재 적용 기능을 불러와 본문에 반영 */
    async applyFeaturesToUI() {
      try {
        const r = await fetch("/api/app-settings?scope=*&key=features", { headers: Auth.headers() });
        if (!r.ok) return;
        const j = await r.json();
        this._features = j.value || {};
      } catch (e) { this._features = {}; }
      this._reflect();
    },
    /** 기능 키가 켜져 있는지(미설정=기본 ON) */
    isEnabled(key) {
      const v = this._features ? this._features[key] : undefined;
      return v === undefined ? true : !!v;
    },
    /** body 클래스로 기능 on/off 표시 → CSS가 해당 메뉴/버튼 숨김 */
    _reflect() {
      FEATURE_DEFS.forEach((f) => {
        document.body.classList.toggle("feat-off-" + f.key, !this.isEnabled(f.key));
      });
      // [WO 20261009-installgate] 기능 플래그가 켜진 뒤(최초 로드 fetch 완료) 또는 관리자가
      // 저장으로 끈 직후에도 게이트 상태를 즉시 재평가 — 새 관찰 지점을 만들지 않고 기존 SoT 재사용.
      if (typeof InstallGate !== "undefined" && InstallGate.recheck) { try { InstallGate.recheck(); } catch (e) {} }
    },

    /* ── 기능·메뉴 관장 모달 ── */
    async openFeatures() {
      const m = document.getElementById("features-modal");
      if (!m) return;
      if (typeof Log !== "undefined") Log.push("settings.open", "features");
      await this._fillFeatScope();
      await this._loadFeatures();
      m.classList.remove("hidden"); requestAnimationFrame(() => m.classList.add("on"));
    },
    closeFeatures() { const m = document.getElementById("features-modal"); if (m) { m.classList.remove("on"); setTimeout(() => m.classList.add("hidden"), 180); } },
    async _fillFeatScope() {
      const sel = document.getElementById("feat-scope-select");
      if (!sel) return;
      const cur = sel.value || "*";
      let projects = [];
      try { const r = await fetch("/api/projects", { headers: Auth.headers() }); const j = await r.json(); projects = j.data || j.results || j || []; } catch (e) {}
      sel.innerHTML = '<option value="*">전체 공통(모든 프로젝트)</option>';
      (projects || []).forEach((p) => { const o = document.createElement("option"); o.value = p.id; o.textContent = p.name || p.id; sel.appendChild(o); });
      sel.value = cur;
      if (!sel._bound) { sel._bound = true; sel.addEventListener("change", () => { this._featScope = sel.value || "*"; this._loadFeatures(); }); }
      this._featScope = sel.value || "*";
    },
    async _loadFeatures() {
      const listEl = document.getElementById("features-list");
      if (!listEl) return;
      let cur = {};
      try { const r = await fetch("/api/app-settings?scope=" + encodeURIComponent(this._featScope) + "&key=features", { headers: Auth.headers() }); const j = await r.json(); cur = j.value || {}; } catch (e) {}
      listEl.innerHTML = "";
      FEATURE_DEFS.forEach((f) => {
        const on = cur[f.key] === undefined ? true : !!cur[f.key];
        const row = document.createElement("label");
        row.className = "feature-row";
        row.innerHTML = `<span class="feature-meta"><b>${f.label}</b><span>${f.desc}</span></span>
          <input type="checkbox" class="feature-toggle" data-key="${f.key}" ${on ? "checked" : ""} />`;
        listEl.appendChild(row);
      });
    },
    async saveFeatures() {
      const listEl = document.getElementById("features-list");
      const note = document.getElementById("features-save-note");
      const value = {};
      listEl.querySelectorAll(".feature-toggle").forEach((c) => { value[c.dataset.key] = c.checked; });
      try {
        const r = await fetch("/api/app-settings", { method: "PUT", headers: Auth.headers(), body: JSON.stringify({ scope: this._featScope, key: "features", value }) });
        if (!r.ok) throw new Error("fail");
        if (note) { note.textContent = "저장되었습니다. 화면에 즉시 반영됩니다."; note.className = "features-save-note ok"; }
        // 전체 공통 저장 시 현재 화면에도 즉시 반영
        if (this._featScope === "*") { this._features = value; this._reflect(); }
      } catch (e) { if (note) { note.textContent = "저장 실패(권한 필요)"; note.className = "features-save-note err"; } }
    },

    /* ── AI 설정 모달 ── */
    async openAI() {
      const m = document.getElementById("ai-modal");
      if (!m) return;
      const statusEl = document.getElementById("ai-status-line");
      try {
        const r = await fetch("/api/ai/config", { headers: Auth.headers() });
        const j = await r.json();
        if (statusEl) { statusEl.textContent = j.enabled ? "활성화됨 (API 키 설정됨)" : "비활성 — API 키(AI_API_KEY) 미설정"; statusEl.className = "ai-status-line " + (j.enabled ? "on" : "off"); }
        const bu = document.getElementById("ai-base-url"); if (bu) bu.value = j.base_url || "";
        const md = document.getElementById("ai-model"); if (md) md.value = j.model || "";
      } catch (e) { if (statusEl) statusEl.textContent = "상태를 불러올 수 없습니다."; }
      // 저장된 base_url/model(app_settings) 우선 표시
      try { const r2 = await fetch("/api/app-settings?scope=*&key=ai", { headers: Auth.headers() }); const j2 = await r2.json(); if (j2.value && j2.value.base_url) document.getElementById("ai-base-url").value = j2.value.base_url; if (j2.value && j2.value.model) document.getElementById("ai-model").value = j2.value.model; } catch (e) {}
      m.classList.remove("hidden"); requestAnimationFrame(() => m.classList.add("on"));
    },
    closeAI() { const m = document.getElementById("ai-modal"); if (m) { m.classList.remove("on"); setTimeout(() => m.classList.add("hidden"), 180); } },
    async saveAI() {
      const note = document.getElementById("ai-save-note");
      const value = { base_url: (document.getElementById("ai-base-url").value || "").trim(), model: (document.getElementById("ai-model").value || "").trim() };
      try {
        const r = await fetch("/api/app-settings", { method: "PUT", headers: Auth.headers(), body: JSON.stringify({ scope: "*", key: "ai", value }) });
        if (!r.ok) throw new Error("fail");
        if (note) { note.textContent = "Base URL·모델 저장됨. (키는 wrangler secret으로 별도 설정)"; note.className = "features-save-note ok"; }
      } catch (e) { if (note) { note.textContent = "저장 실패(권한 필요)"; note.className = "features-save-note err"; } }
    },
    async testAI() {
      const note = document.getElementById("ai-save-note");
      if (note) { note.textContent = "연결 테스트 중…"; note.className = "features-save-note"; }
      try {
        const r = await fetch("/api/ai/chat", { method: "POST", headers: Auth.headers(), body: JSON.stringify({ messages: [{ role: "user", content: "연결 테스트입니다. OK라고만 답해주세요." }], max_tokens: 16 }) });
        const j = await r.json();
        if (r.ok) { if (note) { note.textContent = "연결 성공: " + (j.content || "(응답)"); note.className = "features-save-note ok"; } }
        else { if (note) { note.textContent = "" + (j.error || "실패") + (j.hint ? " — " + j.hint : ""); note.className = "features-save-note err"; } }
      } catch (e) { if (note) { note.textContent = "네트워크 오류"; note.className = "features-save-note err"; } }
    },

    /* ── 코드 구조 · 파일 설명 대시보드 ── */
    openCodemap() {
      const m = document.getElementById("codemap-modal");
      if (!m) return;
      this._renderCodemap("");
      const s = document.getElementById("codemap-search");
      if (s && !s._bound) { s._bound = true; s.addEventListener("input", () => this._renderCodemap(s.value || "")); }
      m.classList.remove("hidden"); requestAnimationFrame(() => m.classList.add("on"));
    },
    closeCodemap() { const m = document.getElementById("codemap-modal"); if (m) { m.classList.remove("on"); setTimeout(() => m.classList.add("hidden"), 180); } },
    _renderCodemap(filter) {
      const el = document.getElementById("codemap-tree");
      if (!el) return;
      const f = (filter || "").toLowerCase();
      el.innerHTML = "";
      CODE_MAP.forEach((grp) => {
        const items = grp.items.filter((it) => !f || (it.path + " " + it.desc + " " + (it.detail || "")).toLowerCase().includes(f));
        if (!items.length) return;
        const g = document.createElement("div");
        g.className = "codemap-group";
        g.innerHTML = `<div class="codemap-group-h">${grp.group}</div>`;
        items.forEach((it) => {
          const row = document.createElement("div");
          row.className = "codemap-file";
          row.innerHTML = `<div class="codemap-file-h"><code>${it.path}</code><span class="codemap-badge">${it.kind}</span></div>
            <div class="codemap-file-desc">${it.desc}</div>${it.detail ? `<div class="codemap-file-detail">${it.detail}</div>` : ""}`;
          g.appendChild(row);
        });
        el.appendChild(g);
      });
      if (!el.children.length) el.innerHTML = '<div class="invites-empty">검색 결과가 없습니다.</div>';
    },

    /* ── Firebase 연결 모달 (내 Google 계정 자동 세팅) ── */
    openFirebase() {
      const m = document.getElementById("firebase-modal");
      if (!m) return;
      this._firebaseStatus();
      // 저장된 값 미리 채우기
      try {
        const cfg = (window.SeaFirebaseConfig && window.SeaFirebaseConfig.current()) || {};
        const paste = document.getElementById("fb-paste");
        if (paste && cfg.apiKey && !String(cfg.apiKey).startsWith("YOUR_")) {
          paste.value = JSON.stringify(cfg, null, 2);
        }
        const em = document.getElementById("fb-owner-email");
        if (em) em.value = window.FIREBASE_OWNER_EMAIL && !String(window.FIREBASE_OWNER_EMAIL).includes("designssir") ? window.FIREBASE_OWNER_EMAIL : (window.FIREBASE_OWNER_EMAIL || "");
      } catch (e) {}
      m.classList.remove("hidden"); requestAnimationFrame(() => m.classList.add("on"));
    },
    closeFirebase() { const m = document.getElementById("firebase-modal"); if (m) { m.classList.remove("on"); setTimeout(() => m.classList.add("hidden"), 180); } },
    _firebaseStatus() {
      const el = document.getElementById("firebase-status-line");
      if (!el) return;
      const on = !!(window.SeaFirebaseConfig && window.SeaFirebaseConfig.isEnabled());
      const ready = !!(window.SeaFirebase && window.SeaFirebase.ready);
      if (on) {
        const u = (window.SeaFirebase && window.SeaFirebase.currentUser && window.SeaFirebase.currentUser());
        el.textContent = ready
          ? (u ? "연결됨 · 로그인: " + (u.email || u.uid) : "연결됨 · (로그인 대기)")
          : "설정 저장됨 · 새로고침 후 완전 활성화";
        el.className = "ai-status-line on";
      } else {
        el.textContent = "미연결 — 아래에 firebaseConfig 를 붙여넣고 저장하세요.";
        el.className = "ai-status-line off";
      }
    },
    saveFirebase() {
      const note = document.getElementById("firebase-save-note");
      const setNote = (t, ok) => { if (note) { note.textContent = t; note.className = "features-save-note " + (ok ? "ok" : "err"); note.classList.remove("hidden"); } };
      const pasteEl = document.getElementById("fb-paste");
      const emailEl = document.getElementById("fb-owner-email");
      const raw = (pasteEl && pasteEl.value || "").trim();
      const email = (emailEl && emailEl.value || "").trim();
      if (!raw) { setNote("firebaseConfig 값을 붙여넣어 주세요.", false); return; }
      const cfg = window.SeaFirebaseConfig.parsePasted(raw);
      if (!cfg || !cfg.apiKey || !cfg.projectId) {
        setNote("형식을 인식하지 못했습니다. 콘솔의 firebaseConfig 객체 전체를 그대로 붙여넣어 주세요.", false);
        return;
      }
      window.SeaFirebaseConfig.save(cfg, email);
      setNote("저장 완료! 새로고침하면 Firebase가 자동 활성화됩니다. (3초 후 자동 새로고침)", true);
      this._firebaseStatus();
      setTimeout(() => { try { location.reload(); } catch (e) {} }, 3000);
    },
    async loginFirebase() {
      const note = document.getElementById("firebase-save-note");
      const setNote = (t, ok) => { if (note) { note.textContent = t; note.className = "features-save-note " + (ok ? "ok" : "err"); note.classList.remove("hidden"); } };
      if (!(window.SeaFirebase && window.SeaFirebase.ready)) {
        setNote("먼저 설정을 저장하고 새로고침한 뒤 다시 시도하세요.", false);
        return;
      }
      try {
        // 단순 테스트가 아니라 앱 전체 로그인으로 연결 (Auth.loginWithFirebase)
        if (typeof Auth !== "undefined" && Auth.loginWithFirebase) {
          const role = await Auth.loginWithFirebase();
          const who = (Auth.user && (Auth.user.name || Auth.user.email)) || "";
          setNote("로그인 완료: " + who + " · 권한=" + (role === "super" ? "슈퍼관리자" : role === "designer" ? "디자이너" : "뷰어"), true);
        } else {
          const u = await window.SeaFirebase.loginGoogle();
          setNote("Google 로그인 성공: " + (u.email || u.uid), true);
        }
        this._firebaseStatus();
      } catch (e) {
        setNote("로그인 실패: " + (e && e.message || e) + " — Firebase 콘솔에서 Google 공급업체를 켰는지, 승인된 도메인에 현재 주소가 있는지 확인하세요.", false);
      }
    },
    clearFirebase() {
      if (window.SeaFirebaseConfig) window.SeaFirebaseConfig.clear();
      const note = document.getElementById("firebase-save-note");
      if (note) { note.textContent = "연결 해제됨. 새로고침하면 D1 백엔드만 사용합니다. (3초 후 자동 새로고침)"; note.className = "features-save-note ok"; note.classList.remove("hidden"); }
      this._firebaseStatus();
      setTimeout(() => { try { location.reload(); } catch (e) {} }, 3000);
    },

    init() {
      const $ = (id) => document.getElementById(id);
      $("features-save") && $("features-save").addEventListener("click", () => this.saveFeatures());
      $("features-close") && $("features-close").addEventListener("click", () => this.closeFeatures());
      $("ai-save") && $("ai-save").addEventListener("click", () => this.saveAI());
      $("ai-test") && $("ai-test").addEventListener("click", () => this.testAI());
      $("ai-close") && $("ai-close").addEventListener("click", () => this.closeAI());
      $("codemap-close") && $("codemap-close").addEventListener("click", () => this.closeCodemap());
      // Firebase 연결 모달 (열기 버튼은 Settings에서 권한 게이트와 함께 바인딩)
      $("firebase-save") && $("firebase-save").addEventListener("click", () => this.saveFirebase());
      $("firebase-login") && $("firebase-login").addEventListener("click", () => this.loginFirebase());
      $("firebase-clear") && $("firebase-clear").addEventListener("click", () => this.clearFirebase());
      $("firebase-close") && $("firebase-close").addEventListener("click", () => this.closeFirebase());
      document.querySelectorAll('.admin-gate-backdrop[data-close]').forEach((bd) => {
        const which = bd.getAttribute("data-close");
        if (which === "features") bd.addEventListener("click", () => this.closeFeatures());
        if (which === "ai") bd.addEventListener("click", () => this.closeAI());
        if (which === "firebase") bd.addEventListener("click", () => this.closeFirebase());
        if (which === "codemap") bd.addEventListener("click", () => this.closeCodemap());
      });
    }
  };

  /* 코드 구조 설명 데이터 — 관리자 대시보드용(파일별 기능 설명) */
  const CODE_MAP = [
    { group: "서버 / API (Hono on Cloudflare Workers)", items: [
      { path: "src/index.tsx", kind: "서버", desc: "모든 백엔드 API·SSR 진입점. 인증·프로젝트·핀·배포·도메인·초대·설정·AI 라우트를 한 파일에 정의.", detail: "주요: /api/auth/me, /api/projects, /api/pins, /api/deploy, /api/signup/*, /api/allowed-domains, /api/invites, /api/app-settings, /api/ai/*" },
      { path: "src/renderer.tsx", kind: "서버", desc: "Hono JSX 렌더러(HTML 셸 구성)." }
    ]},
    { group: "클라이언트 (public/)", items: [
      { path: "public/index.html", kind: "마크업", desc: "앱 전체 화면 구조 — 상단바·사이드바·맵 뷰포트·각종 모달(로그인/가입/관리자/설정/기능/AI/코드맵)." },
      { path: "public/js/main.js", kind: "로직", desc: "클라이언트 전체 로직. 모듈 집합으로 구성.", detail: "App(부트), MapCtrl(줌·팬·핀치), PanoViewer(360), PDF(렌더), PdfAnno(주석), Zones(구역), Pins/PinGrid/PinActionPop(핀), Auth/CompanyAuth(인증·가입), Designers(권한·도메인·멤버·초대·로그), Settings/AdminPanels(설정·기능관장·AI·코드맵), SyncQueue(오프라인 큐)." },
      { path: "public/css/style.css", kind: "스타일", desc: "전체 디자인·반응형(모바일 바텀시트·하단네비)·주석/관리자 UI 스타일." }
    ]},
    { group: "PWA / 오프라인", items: [
      { path: "public/sw.js", kind: "서비스워커", desc: "앱 셸 캐시(stale-while-revalidate). /api/·/tables/ 는 절대 가로채지 않음 → 데이터는 항상 최신.", detail: "오프라인에서 화면 로딩 가능. PDF.js·Three.js CDN도 캐시." },
      { path: "public/manifest.webmanifest", kind: "PWA", desc: "홈 화면 설치용 매니페스트(이름·아이콘·표시 모드)." }
    ]},
    { group: "데이터 (Cloudflare D1 / R2)", items: [
      { path: "migrations/0001~0008_*.sql", kind: "DB", desc: "스키마 마이그레이션.", detail: "핀/배포(0001), 인증·프로젝트·구역(0002), 핀노트(0003), 구역(0004), 사용신청(0005), 활동로그(0006), 회사가입·도메인(0007), 초대·앱설정(0008)." }
    ]},
    { group: "빌드 / 운영", items: [
      { path: "vite.config.ts", kind: "빌드", desc: "Cloudflare Pages용 Vite 빌드 → dist/_worker.js 생성." },
      { path: "wrangler.jsonc", kind: "설정", desc: "CF Pages 설정(D1·R2 바인딩, nodejs_compat)." },
      { path: "ecosystem.config.cjs", kind: "운영", desc: "PM2 개발 서버(wrangler pages dev) 구동 설정." },
      { path: "CLAUDE.md / .claude/HANDOFF.md", kind: "문서", desc: "프로젝트 정체 카드 + 세션 인수인계(IRON RULE 포함)." }
    ]}
  ];

  /* ══════════════════════════════════════════
     COMPANY AUTH — 회사 이메일 자체가입 / 로그인
     (인증코드 → 비밀번호 → 로컬 세션 토큰)
  ══════════════════════════════════════════ */