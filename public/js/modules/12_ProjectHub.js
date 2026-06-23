  const ProjectHub = {
    list: [],
    _loaded: false,

    init() {
      const $ = (id) => document.getElementById(id);
      $("hub-btn-new") && $("hub-btn-new").addEventListener("click", () => this.createProject());
      // hub 인증바 버튼들 (홈 인증바와 동일 동작)
      $("hub-btn-signout") && $("hub-btn-signout").addEventListener("click", () => Auth.signOut());
      $("hub-btn-manage-designers") && $("hub-btn-manage-designers").addEventListener("click", () => Designers.open());
      // [P3] 프로젝트별 멤버 배정 모달
      $("pm-close") && $("pm-close").addEventListener("click", () => this.closeMembers());
      const pmBd = document.querySelector("#proj-members-modal .admin-gate-backdrop");
      if (pmBd) pmBd.addEventListener("click", () => this.closeMembers());
      $("pm-add-btn") && $("pm-add-btn").addEventListener("click", () => this.addMember());
      const pmEmail = $("pm-email");
      if (pmEmail) pmEmail.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); this.addMember(); } });
      // [멀티테넌트] 서브도메인 부여
      $("pm-subdomain-btn") && $("pm-subdomain-btn").addEventListener("click", () => this.setSubdomain());
      const pmSub = $("pm-subdomain");
      if (pmSub) {
        pmSub.addEventListener("input", () => {
          const v = (pmSub.value || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
          const pv = document.getElementById("pm-sub-preview"); if (pv) pv.textContent = v || "name";
        });
        pmSub.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); this.setSubdomain(); } });
      }
    },

    async setSubdomain() {
      const p = this._memProject; if (!p) return;
      const inp = document.getElementById("pm-subdomain");
      const err = document.getElementById("pm-subdomain-error");
      const statusEl = document.getElementById("pm-subdomain-status");
      if (err) err.classList.add("hidden");
      const sub = (inp.value || "").trim();
      try {
        const r = await fetch("/api/projects/" + encodeURIComponent(p.id) + "/subdomain", {
          method: "POST", headers: Auth.headers(), body: JSON.stringify({ subdomain: sub || null })
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { if (err) { err.textContent = j.error || "설정 실패"; err.classList.remove("hidden"); } return; }
        p.subdomain = j.subdomain || null;
        this._renderSubdomainStatus(j.subdomain, j.url);
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast(j.subdomain ? ("✅ 전용 도메인 설정: " + (j.url || j.subdomain)) : "도메인 해제됨");
        // 카드 목록도 갱신
        this.refreshIfVisible && this.refreshIfVisible();
      } catch (e) { if (err) { err.textContent = "네트워크 오류"; err.classList.remove("hidden"); } }
    },
    _renderSubdomainStatus(sub, url) {
      const statusEl = document.getElementById("pm-subdomain-status");
      if (!statusEl) return;
      if (sub) statusEl.innerHTML = '현재: <a href="' + (url || ("https://" + sub)) + '" target="_blank" rel="noopener" class="pm-sub-link">' + (url || sub) + '</a> <button class="pm-sub-clear" type="button">해제</button>';
      else statusEl.textContent = "아직 전용 도메인이 없습니다.";
      const clr = statusEl.querySelector(".pm-sub-clear");
      if (clr) clr.addEventListener("click", () => { const inp = document.getElementById("pm-subdomain"); if (inp) inp.value = ""; this.setSubdomain(); });
    },

    /* ── [P3] 프로젝트별 멤버 배정 — GET/POST/DELETE /api/projects/:id/members ── */
    async openMembers(p) {
      this._memProject = p;
      const m = document.getElementById("proj-members-modal");
      if (!m) return;
      const nm = document.getElementById("pm-proj-name"); if (nm) nm.textContent = p.name || p.id;
      const err = document.getElementById("pm-add-error"); if (err) err.classList.add("hidden");
      const inp = document.getElementById("pm-email"); if (inp) inp.value = "";
      // [멀티테넌트] 현재 서브도메인 표시 + 베이스도메인
      const subInp = document.getElementById("pm-subdomain"); if (subInp) subInp.value = p.subdomain || "";
      const pv = document.getElementById("pm-sub-preview"); if (pv) pv.textContent = p.subdomain || "name";
      const subErr = document.getElementById("pm-subdomain-error"); if (subErr) subErr.classList.add("hidden");
      this._renderSubdomainStatus(p.subdomain, null);
      try {
        const t = await fetch("/api/tenant/resolve").then((r) => r.json());
        const baseEl = document.getElementById("pm-sub-base"); if (baseEl && t && t.base) baseEl.textContent = t.base;
        if (p.subdomain && t && t.base) this._renderSubdomainStatus(p.subdomain, "https://" + p.subdomain + "." + t.base);
      } catch (e) {}
      m.classList.remove("hidden"); requestAnimationFrame(() => m.classList.add("on"));
      await this.loadMembers();
    },
    closeMembers() {
      const m = document.getElementById("proj-members-modal");
      if (!m) return; m.classList.remove("on"); setTimeout(() => m.classList.add("hidden"), 200);
    },
    async loadMembers() {
      const p = this._memProject; if (!p) return;
      const list = document.getElementById("pm-list");
      if (list) list.innerHTML = '<div class="designers-loading">불러오는 중...</div>';
      try {
        const r = await fetch("/api/projects/" + encodeURIComponent(p.id) + "/members", { headers: Auth.headers() });
        if (!r.ok) throw new Error("forbidden");
        const { data } = await r.json();
        const esc = (s) => (typeof UI !== "undefined" && UI.escapeHtml) ? UI.escapeHtml(s) : s;
        if (!data || !data.length) { list.innerHTML = '<div class="designers-empty">아직 배정된 멤버가 없습니다. (배정 전: 미배포 프로젝트는 전체 설계자에게, 배포 시 뷰어 전체에게 보임)</div>'; return; }
        list.innerHTML = "";
        data.forEach((mem) => {
          const row = document.createElement("div");
          row.className = "member-row";
          const roleLabel = mem.role === "designer" ? "디자이너" : (mem.role === "editor" ? "편집자" : "뷰어");
          row.innerHTML = '<span class="mem-col-email" title="' + esc(mem.email) + '">' + esc(mem.email) + '</span>' +
            '<span class="pm-role-badge role-' + esc(mem.role) + '">' + roleLabel + '</span>' +
            '<button class="designer-del" title="배정 해제">✕</button>';
          row.querySelector(".designer-del").addEventListener("click", () => this.removeMember(mem.email));
          list.appendChild(row);
        });
      } catch (e) { if (list) list.innerHTML = '<div class="designers-empty">목록을 불러올 수 없습니다(소유자/관리자만 가능).</div>'; }
    },
    async addMember() {
      const p = this._memProject; if (!p) return;
      const inp = document.getElementById("pm-email");
      const sel = document.getElementById("pm-role");
      const err = document.getElementById("pm-add-error");
      if (err) err.classList.add("hidden");
      const email = (inp.value || "").trim().toLowerCase();
      const role = sel ? sel.value : "viewer";
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { if (err) { err.textContent = "올바른 이메일을 입력하세요."; err.classList.remove("hidden"); } return; }
      try {
        const r = await fetch("/api/projects/" + encodeURIComponent(p.id) + "/members", { method: "POST", headers: Auth.headers(), body: JSON.stringify({ email, role }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { if (err) { err.textContent = j.error || "배정 실패"; err.classList.remove("hidden"); } return; }
        inp.value = "";
        await this.loadMembers();
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("✅ " + email + " 배정(" + (role === "designer" ? "디자이너" : "뷰어") + ")");
      } catch (e) { if (err) { err.textContent = "네트워크 오류"; err.classList.remove("hidden"); } }
    },
    async removeMember(email) {
      const p = this._memProject; if (!p) return;
      if (!window.confirm(email + " 의 '" + (p.name || p.id) + "' 프로젝트 배정을 해제할까요?")) return;
      try {
        await fetch("/api/projects/" + encodeURIComponent(p.id) + "/members/" + encodeURIComponent(email), { method: "DELETE", headers: Auth.headers() });
        await this.loadMembers();
      } catch (e) {}
    },

    /** 화면 진입 시 호출 — 목록 로드 + 렌더 */
    async open() {
      UI.showScreen("screen-projects");
      Auth._applyUi();          // 인증바 상태 동기화 (hub 슬롯 포함)
      Auth._renderHubSignin();  // 미로그인 시 hub 로그인 버튼 렌더
      await this.load();
    },

    async load() {
      // [마스터 핵심 워크플로 — 오프라인] 끊긴 상태면 서버 대신 다운로드한 번들(IndexedDB)에서
      //   프로젝트 목록을 복원한다. (폰에서 오프라인으로 앱을 열어도 받아둔 프로젝트가 보임)
      if (!navigator.onLine && typeof OfflineLoad !== "undefined") {
        try {
          this.list = (await OfflineLoad.projects()).filter(Boolean);
          this._offline = true;
          if (typeof Prompt !== "undefined" && Prompt.toast && this.list.length)
            Prompt.toast("📴 오프라인 — 다운로드한 프로젝트 " + this.list.length + "개 표시");
        } catch (e) { this.list = []; }
        this._loaded = true; this.render(); return;
      }
      try {
        // [버그수정] 인증헤더 필수 — 서버가 멤버십/배포 스코프로 필터하므로(미전송 시 익명취급→설계자 프로젝트 누락)
        // [견고화] 온라인 플래그는 true 인데 실제 네트워크가 죽은 경우(지하/캡티브포털) fetch 가
        //   무한 대기하는 것을 방지 — 6초 타임아웃(AbortController) → 실패 시 오프라인 번들 폴백.
        const ctrl = new AbortController();
        const t = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, 6000);
        let data;
        try {
          const r = await fetch("/api/projects", { headers: Auth.headers(), signal: ctrl.signal });
          ({ data } = await r.json());
        } finally { clearTimeout(t); }
        this.list = data || [];
        this._offline = false;
      } catch (e) {
        // 네트워크 실패/타임아웃 → 오프라인 번들로 폴백(있으면)
        try { this.list = (typeof OfflineLoad !== "undefined") ? (await OfflineLoad.projects()).filter(Boolean) : []; this._offline = true; }
        catch (e2) { this.list = []; }
      }
      this._loaded = true;
      this.render();
    },

    /** Auth 상태 변경 시 (로그인/로그아웃) 다시 그려 +새프로젝트·편집 버튼 토글 */
    refreshIfVisible() {
      const sc = document.getElementById("screen-projects");
      if (sc && sc.classList.contains("active")) {
        // [버그수정 #1] 인증 변경(자동 로그인 완료 등) 시 프로젝트 재로드 —
        //   첫 진입 시 로그인 전 익명으로 빈 목록을 받아 "프로젝트 없음"으로 보이던 버그 수정.
        this.load();
        Auth._renderHubSignin();
      }
    },

    /* [마스터 요청 #2] 프로젝트마다 "다른" 썸네일 아이콘 — id/name 해시로 6종 형상 +
       6종 액센트색을 결정적으로 선택(같은 프로젝트는 항상 같은 아이콘). */
    _iconSvg(p) {
      const ICONS = [
        // 0) 화물선(cargo)
        '<path d="M14 44 L116 44 L106 58 L24 58 Z"/><path d="M30 44 L30 28 L86 28 L86 44"/><path d="M40 28 L40 18 L66 18 L66 28"/><rect x="72" y="22" width="9" height="6" rx="1.5"/><line x1="96" y1="44" x2="96" y2="30"/><line x1="96" y1="30" x2="110" y2="34"/>',
        // 1) 해양 플랫폼/리그(offshore rig)
        '<path d="M20 40 L112 40 L112 48 L20 48 Z"/><path d="M30 48 L26 66 M50 48 L48 66 M82 48 L84 66 M102 48 L106 66"/><path d="M58 40 L66 14 L74 40 Z"/><line x1="66" y1="14" x2="66" y2="40"/><line x1="40" y1="40 " x2="40" y2="32"/><rect x="34" y="30" width="14" height="10" rx="1"/>',
        // 2) 탱커(tanker) — 길고 낮은 선체 + 파이프 매니폴드
        '<path d="M10 42 L120 42 L112 56 L18 56 Z"/><rect x="44" y="30" width="42" height="12" rx="2"/><line x1="52" y1="30" x2="52" y2="22" /><line x1="64" y1="30" x2="64" y2="22"/><line x1="76" y1="30" x2="76" y2="22"/><path d="M96 42 L96 30 L108 30 L108 42"/>',
        // 3) 갠트리/도크 크레인(gantry crane)
        '<path d="M22 60 L22 24 M104 60 L104 24"/><path d="M14 24 L112 24"/><path d="M63 24 L63 40"/><rect x="55" y="40" width="16" height="9" rx="1.5"/><path d="M14 60 L114 60"/><path d="M30 24 L30 18 L52 18"/>',
        // 4) 모스타입 LNG선 (Moss-type — 구형 모스탱크 4기 + 선미 거주구)
        '<path d="M8 46 L122 46 L113 58 L17 58 Z"/><circle cx="30" cy="35" r="8.5"/><circle cx="51" cy="35" r="8.5"/><circle cx="72" cy="35" r="8.5"/><circle cx="93" cy="35" r="8.5"/><path d="M104 46 L104 30 L118 30 L118 46"/><line x1="108" y1="30" x2="108" y2="23"/><line x1="14" y1="46" x2="116" y2="46" stroke-opacity=".45"/>',
        // 5) LNG선(구형 탱크)
        '<path d="M12 44 L120 44 L110 58 L22 58 Z"/><circle cx="44" cy="34" r="11"/><circle cx="74" cy="34" r="11"/><path d="M96 44 L96 30 L104 26"/><line x1="44" y1="23" x2="44" y2="44"/><line x1="74" y1="23" x2="74" y2="44"/>',
      ];
      const ACC = ["#3a97dd", "#e0b14a", "#46c0a0", "#cf7bd6", "#7f8cff", "#46c08a"];
      const i = Math.abs(this._hash(p.id || p.name)) % ICONS.length;
      const c = ACC[i];
      return '<svg class="hub-thumb-ship hub-thumb-icon-' + i + '" viewBox="0 0 132 72" fill="none" ' +
        'stroke="' + c + '" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ' +
        'style="filter:drop-shadow(0 2px 6px rgba(0,0,0,.45))">' +
        '<g fill="' + c + '" fill-opacity=".14">' + ICONS[i] + '</g>' +
      '</svg>';
    },

    render() {
      const grid  = document.getElementById("hub-grid");
      const empty = document.getElementById("hub-empty");
      const btnNew = document.getElementById("hub-btn-new");
      const emptyHint = document.getElementById("hub-empty-hint");
      if (!grid) return;

      const isDesigner = Auth.isDesigner;
      // +새 프로젝트 버튼: 디자이너만
      if (btnNew) btnNew.classList.toggle("hidden", !isDesigner);

      grid.innerHTML = "";

      if (!this.list.length) {
        empty && empty.classList.remove("hidden");
        if (emptyHint) emptyHint.textContent = isDesigner
          ? "우측 상단 '+ 새 프로젝트'로 첫 프로젝트를 만들어 보세요."
          : "설계자로 로그인하면 새 프로젝트를 만들 수 있습니다.";
        return;
      }
      empty && empty.classList.add("hidden");

      this.list.forEach((p) => {
        const card = document.createElement("div");
        card.className = "hub-card";
        card.setAttribute("role", "listitem");
        card.tabIndex = 0;
        const deckTxt = (p.deck_count != null) ? (p.deck_count + " DECKS") : "";
        const dateTxt = this._fmtDate(p.created_at);
        const code = "SS-" + String(Math.abs(this._hash(p.id || p.name)) % 9000 + 1000);
        card.innerHTML =
          '<div class="hub-card-thumb">' +
            '<div class="hub-thumb-grid"></div>' +
            '<div class="hub-thumb-scan"></div>' +
            this._iconSvg(p) +
            '<span class="hub-thumb-code">' + code + '</span>' +
          '</div>' +
          '<div class="hub-card-body">' +
            '<div class="hub-card-name">' + UI.escapeHtml(p.name) +
              (p.published ? ' <span class="hub-pub-badge" title="뷰어에게 배포됨">● 배포됨</span>' : '') +
            '</div>' +
            '<div class="hub-card-meta">' +
              (deckTxt ? '<span class="hub-card-decks">' + deckTxt + '</span>' : '') +
              (dateTxt ? '<span class="hub-card-date">' + dateTxt + '</span>' : '') +
            '</div>' +
          '</div>' +
          (isDesigner
            ? '<div class="hub-card-actions">' +
                '<button class="hub-card-act hub-card-pub' + (p.published ? ' is-pub' : '') + '" title="' + (p.published ? '배포됨 — 클릭 시 배포취소(뷰어 비공개)' : '뷰어에게 배포(공개)') + '" data-act="pub" aria-label="배포">' +
                  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>' +
                '</button>' +
                '<button class="hub-card-act hub-card-dl" title="오프라인 다운로드" data-act="dl" aria-label="오프라인 다운로드">' +
                  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>' +
                '</button>' +
                '<button class="hub-card-act hub-card-members" title="멤버 관리 — 이 프로젝트에 접근할 사용자 배정" data-act="members" aria-label="멤버 관리">' +
                  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>' +
                '</button>' +
                '<button class="hub-card-act hub-card-del" title="삭제" data-act="del" aria-label="삭제">' +
                  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>' +
                '</button>' +
              '</div>'
            : '');

        // 카드 클릭 → 진입
        card.addEventListener("click", (e) => {
          if (e.target.closest("[data-act]")) return; // 액션 버튼은 제외
          this.openProject(p);
        });
        card.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.openProject(p); }
        });
        // 삭제 버튼
        const del = card.querySelector('[data-act="del"]');
        if (del) del.addEventListener("click", (e) => { e.stopPropagation(); this.deleteProject(p); });

        // [오프라인 작업지시서 ❷] 오프라인 다운로드 버튼
        const dl = card.querySelector('[data-act="dl"]');
        if (dl) dl.addEventListener("click", async (e) => {
          e.stopPropagation();
          if (typeof OfflineBundle === "undefined") { Prompt.toast("오프라인 모듈 미로드"); return; }
          const orig = dl.innerHTML;
          dl.disabled = true; dl.classList.add("busy");
          try {
            const m = await OfflineBundle.download(p.id, (done, total, label) => {
              dl.setAttribute("title", "다운로드 " + done + "/" + total + " · " + label);
            });
            const v = await OfflineBundle.verify(p.id);
            if (v.ok) Prompt.toast("✅ 오프라인 준비 완료 — 도면 " + m.deployments + "개 · 3D " + m.panos + "개");
            else Prompt.toast("⚠️ 일부 누락: " + (v.missing || []).length + "건 — 다시 시도하세요");
          } catch (err) { Prompt.toast("❌ " + (err && err.message ? err.message : "다운로드 실패")); }
          finally { dl.disabled = false; dl.classList.remove("busy"); dl.innerHTML = orig; dl.setAttribute("title", "오프라인 다운로드"); }
        });

        // 배포(Publish) 버튼 — 설계자가 프로젝트를 뷰어에게 공개/비공개 토글
        const pub = card.querySelector('[data-act="pub"]');
        if (pub) pub.addEventListener("click", (e) => { e.stopPropagation(); this.togglePublish(p, pub); });

        // [P3] 멤버 관리 버튼 — 이 프로젝트에 접근할 사용자 배정
        const mem = card.querySelector('[data-act="members"]');
        if (mem) mem.addEventListener("click", (e) => { e.stopPropagation(); this.openMembers(p); });

        grid.appendChild(card);
      });

      // 디자이너면 "+새 프로젝트" 카드도 그리드 맨 앞에 추가
      if (isDesigner) {
        const add = document.createElement("div");
        add.className = "hub-card hub-card-add";
        add.tabIndex = 0;
        add.setAttribute("role", "listitem");
        add.innerHTML = '<div class="hub-card-add-plus">+</div><div class="hub-card-add-label">새 프로젝트</div>';
        const go = () => this.createProject();
        add.addEventListener("click", go);
        add.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
        grid.insertBefore(add, grid.firstChild);
      }
    },

    /** 프로젝트 진입: 디자이너면 편집, 아니면 뷰어 */
    async openProject(p) {
      // 선택 프로젝트를 Projects 모듈과 공유 (작업화면 사이드바 동기화용)
      Projects.list = this.list;
      Projects.currentProject = p;
      State.currentProjectId = p.id;
      State.currentProjectName = p.name;
      // ★ 회귀 방지: 설계자 토큰이 있는데 권한 확인(refresh)이 아직 끝나지 않아
      //   isDesigner가 false인 채로 카드를 누르면 뷰어로 진입 → "PDF 업로드가 안 된다"는
      //   회귀 느낌을 준다. 토큰이 있으면 권한 재확인을 한 번 await 한 뒤 모드를 결정한다.
      if (!Auth.isDesigner && Auth.idToken) {
        try { await Auth.refresh(); } catch (e) {}
      }
      if (Auth.isDesigner) {
        App.openApp("designer", { project: p });
      } else {
        App.openApp("viewer", { project: p });
      }
    },

    async createProject() {
      if (!Auth.isDesigner) { Auth.requireDesigner(() => this.createProject()); return; }
      const res = await Prompt.ask({ title: "프로젝트 생성", sub: "새 프로젝트 이름을 입력하세요 (예: ○○호 검사)", placeholder: "프로젝트 이름" });
      if (!res || !res.value) return;
      try {
        const r = await fetch("/api/projects", { method: "POST", headers: Auth.headers(), body: JSON.stringify({ name: res.value }) });
        const p = await r.json();
        if (!r.ok) { alert(p.error || "생성 실패(권한 필요)"); return; }
        await this.load();
      } catch (e) { alert("네트워크 오류"); }
    },

    async deleteProject(p) {
      if (!Auth.isDesigner) return;
      if (!confirm("'" + p.name + "' 프로젝트와 모든 데크를 삭제할까요?")) return;
      try {
        await fetch("/api/projects/" + p.id, { method: "DELETE", headers: Auth.headers() });
        await this.load();
      } catch (e) {}
    },

    /** 프로젝트 배포(Publish) 토글 — 배포하면 권한받은 뷰어가 열람 가능, 배포취소하면 뷰어에게 숨김 */
    async togglePublish(p, btn) {
      if (!Auth.isDesigner) { Auth.requireDesigner(() => this.togglePublish(p)); return; }
      const willPublish = !p.published;
      if (willPublish && !confirm("'" + p.name + "' 프로젝트를 뷰어에게 배포할까요?\n\n배포하면 이 프로젝트에 권한이 부여된 뷰어가 열람할 수 있습니다.")) return;
      if (!willPublish && !confirm("'" + p.name + "' 배포를 취소할까요?\n\n뷰어에게 더 이상 보이지 않게 됩니다.")) return;
      if (btn) { btn.disabled = true; btn.classList.add("busy"); }
      try {
        const r = await fetch("/api/projects/" + p.id + "/" + (willPublish ? "publish" : "unpublish"), { method: "POST", headers: Auth.headers() });
        if (!r.ok) throw new Error("HTTP " + r.status);
        p.published = willPublish;
        Prompt && Prompt.toast && Prompt.toast(willPublish ? "🚀 '" + p.name + "' 배포 완료 — 뷰어가 열람할 수 있습니다." : "🔒 '" + p.name + "' 배포 취소 — 뷰어에게 비공개.", 2800);
        await this.load();
      } catch (e) {
        Prompt && Prompt.toast && Prompt.toast("배포 처리 실패: " + (e && e.message ? e.message : "네트워크 오류"), 3200);
      } finally { if (btn) { btn.disabled = false; btn.classList.remove("busy"); } }
    },

    _fmtDate(v) {
      if (v == null) return "";
      const n = (typeof v === "number") ? v : Date.parse(v);
      if (!Number.isFinite(n)) return "";
      const d = new Date(n);
      const p = (x) => String(x).padStart(2, "0");
      return d.getFullYear() + "." + p(d.getMonth() + 1) + "." + p(d.getDate());
    },

    /** 프로젝트 식별 코드(SS-####) 생성용 간이 해시 */
    _hash(str) {
      str = String(str || "");
      let h = 0;
      for (let i = 0; i < str.length; i++) { h = ((h << 5) - h + str.charCodeAt(i)) | 0; }
      return h;
    }
  };

  /* ══════════════════════════════════════════
     NOTES ── 이슈/필드노트 협업 (핀 단위 코멘트 스레드)
       · 파노라마 우측 패널에서 핀별 이슈를 작성/상태관리
       · 상태: open(미해결) / progress(진행) / done(완료)
       · 도면 핀 + 핀 리스트에 미해결 카운트 뱃지 표시
  ══════════════════════════════════════════ */