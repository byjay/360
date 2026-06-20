  const Designers = {
    _tab: "designers",
    _reqStatus: "pending",
    _reqCache: [],
    init() {
      const $ = (id) => document.getElementById(id);
      $("designers-close") && $("designers-close").addEventListener("click", () => this.close());
      const bd = document.querySelector('#designers-modal .admin-gate-backdrop');
      bd && bd.addEventListener("click", () => this.close());
      $("designer-add-btn") && $("designer-add-btn").addEventListener("click", () => this.add());
      const inp = $("designer-email-input");
      if (inp) inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); this.add(); } });
      // 탭 전환
      $("adm-tab-designers") && $("adm-tab-designers").addEventListener("click", () => this.switchTab("designers"));
      $("adm-tab-requests") && $("adm-tab-requests").addEventListener("click", () => this.switchTab("requests"));
      $("adm-tab-domains") && $("adm-tab-domains").addEventListener("click", () => this.switchTab("domains"));
      $("adm-tab-members") && $("adm-tab-members").addEventListener("click", () => this.switchTab("members"));
      $("adm-tab-logs") && $("adm-tab-logs").addEventListener("click", () => this.switchTab("logs"));
      // 도메인 관리
      $("domain-add-btn") && $("domain-add-btn").addEventListener("click", () => this.addDomain());
      const dinp = $("domain-input");
      if (dinp) dinp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); this.addDomain(); } });
      // 멤버
      $("members-refresh") && $("members-refresh").addEventListener("click", () => this.loadMembers());
      // 사전 등록(초대)
      $("invite-add-btn") && $("invite-add-btn").addEventListener("click", () => this.addInvite());
      const iinp = $("invite-email-input");
      if (iinp) iinp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); this.addInvite(); } });
      // 로그 도구
      $("log-refresh") && $("log-refresh").addEventListener("click", () => this.loadLogs(true));
      $("log-more") && $("log-more").addEventListener("click", () => this.loadLogs(false));
      $("log-purge") && $("log-purge").addEventListener("click", () => this.purgeLogs());
      const _ls = $("log-search");
      if (_ls) _ls.addEventListener("input", () => { clearTimeout(this._logT); this._logT = setTimeout(() => this.loadLogs(true), 280); });
      const _lf = $("log-action-filter");
      if (_lf) _lf.addEventListener("change", () => this.loadLogs(true));
      // 상태 필터
      document.querySelectorAll("#adm-panel-requests .adm-filter-item").forEach((b) => {
        b.addEventListener("click", () => {
          this._reqStatus = b.dataset.status;
          document.querySelectorAll("#adm-panel-requests .adm-filter-item").forEach((x) => x.classList.toggle("active", x === b));
          this.renderRequests();
        });
      });
    },
    switchTab(tab) {
      this._tab = tab;
      const tabs = { designers: "adm-tab-designers", requests: "adm-tab-requests", domains: "adm-tab-domains", members: "adm-tab-members", logs: "adm-tab-logs" };
      const panels = { designers: "adm-panel-designers", requests: "adm-panel-requests", domains: "adm-panel-domains", members: "adm-panel-members", logs: "adm-panel-logs" };
      Object.keys(tabs).forEach((k) => {
        const tEl = document.getElementById(tabs[k]);
        const pEl = document.getElementById(panels[k]);
        if (tEl) tEl.classList.toggle("active", k === tab);
        if (pEl) pEl.classList.toggle("hidden", k !== tab);
      });
      if (tab === "requests") this.loadRequests();
      if (tab === "domains") this.loadDomains();
      if (tab === "members") this.loadMembers();
      if (tab === "logs") { this.loadLogActions(); this.loadLogs(true); }
    },

    /* ── 회사 도메인(프로젝트별 허용) 관리 ── */
    async _fillProjectSelect() {
      const sel = document.getElementById("domain-project-select");
      if (!sel) return;
      const cur = sel.value || "*";
      let projects = [];
      try {
        const r = await fetch("/api/projects", { headers: Auth.headers() });
        const j = await r.json();
        projects = j.data || j.results || j || [];
      } catch (e) {}
      sel.innerHTML = '<option value="*">전체 공통 (모든 프로젝트)</option>';
      (projects || []).forEach((p) => {
        const o = document.createElement("option");
        o.value = p.id; o.textContent = p.name || p.id;
        sel.appendChild(o);
      });
      sel.value = cur;
    },
    async loadDomains() {
      await this._fillProjectSelect();
      const listEl = document.getElementById("domains-list");
      if (!listEl) return;
      listEl.innerHTML = '<div class="designers-loading">불러오는 중...</div>';
      try {
        const r = await fetch("/api/allowed-domains", { headers: Auth.headers() });
        if (!r.ok) throw new Error("forbidden");
        const { data } = await r.json();
        if (!data || !data.length) {
          listEl.innerHTML = '<div class="designers-empty">등록된 회사 도메인이 없습니다. (개인 무료메일 제외 모든 회사메일 허용)</div>';
          return;
        }
        // 프로젝트 id→이름 매핑
        let pmap = {};
        try {
          const rp = await fetch("/api/projects", { headers: Auth.headers() });
          const jp = await rp.json();
          (jp.data || jp.results || jp || []).forEach((p) => { pmap[p.id] = p.name || p.id; });
        } catch (e) {}
        listEl.innerHTML = "";
        data.forEach((d) => {
          const scope = d.project_id === "*" ? "전체 공통" : ("프로젝트: " + (pmap[d.project_id] || d.project_id));
          const row = document.createElement("div");
          row.className = "domain-row";
          row.innerHTML = `<span class="domain-name">@${d.domain}</span>
            <span class="domain-scope">${scope}</span>
            <button class="designer-del" data-id="${encodeURIComponent(d.id)}" title="삭제">✕</button>`;
          row.querySelector(".designer-del").addEventListener("click", () => this.removeDomain(d.id));
          listEl.appendChild(row);
        });
      } catch (e) {
        listEl.innerHTML = '<div class="designers-empty">목록을 불러올 수 없습니다(권한 필요).</div>';
      }
    },
    async addDomain() {
      const inp = document.getElementById("domain-input");
      const sel = document.getElementById("domain-project-select");
      const err = document.getElementById("domain-add-error");
      err.classList.add("hidden");
      const domain = (inp.value || "").trim().toLowerCase().replace(/^@/, "");
      const projectId = sel ? (sel.value || "*") : "*";
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) { err.textContent = "올바른 도메인을 입력하세요. (예: company.com)"; err.classList.remove("hidden"); return; }
      try {
        const r = await fetch("/api/allowed-domains", { method: "POST", headers: Auth.headers(), body: JSON.stringify({ domain, project_id: projectId }) });
        const j = await r.json();
        if (!r.ok) { err.textContent = j.error || "추가 실패"; err.classList.remove("hidden"); return; }
        inp.value = "";
        await this.loadDomains();
      } catch (e) { err.textContent = "네트워크 오류"; err.classList.remove("hidden"); }
    },
    async removeDomain(id) {
      try {
        await fetch("/api/allowed-domains/" + encodeURIComponent(id), { method: "DELETE", headers: Auth.headers() });
        await this.loadDomains();
      } catch (e) {}
    },

    /* ── 가입 사용자(회사 이메일 자체가입) + 로그인 기록 ── */
    async loadMembers() {
      this.loadInvites();  // 사전 등록(초대) 목록도 함께 갱신
      const listEl = document.getElementById("members-list");
      if (!listEl) return;
      listEl.innerHTML = '<div class="designers-loading">불러오는 중...</div>';
      try {
        const r = await fetch("/api/local-users", { headers: Auth.headers() });
        if (!r.ok) throw new Error("forbidden");
        const { data } = await r.json();
        const totalEl = document.getElementById("members-total");
        if (totalEl) totalEl.textContent = (data ? data.length : 0) + "명";
        if (!data || !data.length) { listEl.innerHTML = '<div class="designers-empty">아직 회사 이메일로 가입한 사용자가 없습니다.</div>'; return; }
        const fmt = (ts) => { if (!ts) return "—"; const d = new Date(ts); return d.toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" }); };
        listEl.innerHTML = "";
        data.forEach((u) => {
          const row = document.createElement("div");
          row.className = "member-row";
          row.innerHTML = `<span class="mem-col-email" title="${u.email}">${u.email}</span>
            <span class="mem-col-name">${u.name || "—"}</span>
            <span class="mem-col-company" title="${u.company || ""}">${u.company || "—"}</span>
            <span class="mem-col-login">${fmt(u.last_login_at)}</span>
            <span class="mem-col-act"><button class="designer-del" title="가입 취소(삭제)">✕</button></span>`;
          row.querySelector(".designer-del").addEventListener("click", () => this.removeMember(u.email));
          listEl.appendChild(row);
        });
      } catch (e) {
        listEl.innerHTML = '<div class="designers-empty">목록을 불러올 수 없습니다(권한 필요).</div>';
      }
    },
    async removeMember(email) {
      if (typeof Prompt !== "undefined" && Prompt.confirm) {
        const ok = await Prompt.confirm("가입 취소", email + " 사용자의 가입을 취소(삭제)하시겠습니까?");
        if (!ok) return;
      }
      try {
        await fetch("/api/local-users/" + encodeURIComponent(email), { method: "DELETE", headers: Auth.headers() });
        await this.loadMembers();
      } catch (e) {}
    },

    /* ── 사전 등록(초대) 관리 ── */
    async loadInvites() {
      const listEl = document.getElementById("invites-list");
      if (!listEl) return;
      try {
        const r = await fetch("/api/invites", { headers: Auth.headers() });
        if (!r.ok) throw new Error("forbidden");
        const { data } = await r.json();
        if (!data || !data.length) { listEl.innerHTML = '<div class="invites-empty">사전 등록된 이메일이 없습니다.</div>'; return; }
        listEl.innerHTML = "";
        data.forEach((iv) => {
          const row = document.createElement("div");
          row.className = "invite-row" + (iv.used ? " used" : "");
          const roleLabel = iv.role === "designer" ? "디자이너" : "뷰어";
          const status = iv.used ? '<span class="invite-status used">가입완료</span>' : '<span class="invite-status pending">대기</span>';
          row.innerHTML = `<span class="invite-mail" title="${iv.email}">${iv.email}</span>
            <span class="invite-role-badge role-${iv.role}">${roleLabel}</span>
            ${status}
            <button class="designer-del" title="사전등록 삭제">✕</button>`;
          row.querySelector(".designer-del").addEventListener("click", () => this.removeInvite(iv.email));
          listEl.appendChild(row);
        });
      } catch (e) {
        listEl.innerHTML = '<div class="invites-empty">목록을 불러올 수 없습니다(권한 필요).</div>';
      }
    },
    async addInvite() {
      const inp = document.getElementById("invite-email-input");
      const sel = document.getElementById("invite-role-select");
      const err = document.getElementById("invite-add-error");
      if (err) err.classList.add("hidden");
      const email = (inp.value || "").trim().toLowerCase();
      const role = sel ? sel.value : "viewer";
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { if (err) { err.textContent = "올바른 이메일을 입력하세요."; err.classList.remove("hidden"); } return; }
      try {
        const r = await fetch("/api/invites", { method: "POST", headers: Auth.headers(), body: JSON.stringify({ email, role }) });
        const j = await r.json();
        if (!r.ok) { if (err) { err.textContent = j.error || "등록 실패"; err.classList.remove("hidden"); } return; }
        inp.value = "";
        if (j.already_registered && typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("이미 가입된 사용자입니다. 권한만 갱신됩니다.");
        await this.loadInvites();
      } catch (e) { if (err) { err.textContent = "네트워크 오류"; err.classList.remove("hidden"); } }
    },
    async removeInvite(email) {
      try {
        await fetch("/api/invites/" + encodeURIComponent(email), { method: "DELETE", headers: Auth.headers() });
        await this.loadInvites();
      } catch (e) {}
    },

    async open() {
      if (!Auth.isSuper) return;
      const sa = document.getElementById("super-admin-email");
      if (sa) sa.textContent = Auth.user ? Auth.user.email : (Auth.superAdmin || "designssir@gmail.com");
      document.getElementById("designers-modal").classList.remove("hidden");
      requestAnimationFrame(() => document.getElementById("designers-modal").classList.add("on"));
      this.switchTab(this._tab);
      await this.render();
      this.loadRequests(); // 배지 갱신용 선로딩
    },
    close() {
      const m = document.getElementById("designers-modal");
      m.classList.remove("on");
      setTimeout(() => m.classList.add("hidden"), 200);
    },
    async render() {
      const listEl = document.getElementById("designers-list");
      listEl.innerHTML = '<div class="designers-loading">불러오는 중...</div>';
      try {
        const r = await fetch("/api/designers", { headers: Auth.headers() });
        if (!r.ok) throw new Error("forbidden");
        const { data } = await r.json();
        if (!data || !data.length) { listEl.innerHTML = '<div class="designers-empty">지정된 디자이너가 없습니다.</div>'; return; }
        listEl.innerHTML = "";
        data.forEach((d) => {
          const row = document.createElement("div");
          row.className = "designer-row";
          row.innerHTML = `<span class="designer-email">${d.email}</span>
            <button class="designer-del" data-email="${encodeURIComponent(d.email)}" title="삭제">✕</button>`;
          row.querySelector(".designer-del").addEventListener("click", () => this.remove(d.email));
          listEl.appendChild(row);
        });
      } catch (e) {
        listEl.innerHTML = '<div class="designers-empty">목록을 불러올 수 없습니다(권한 필요).</div>';
      }
    },
    async add() {
      const inp = document.getElementById("designer-email-input");
      const err = document.getElementById("designer-add-error");
      err.classList.add("hidden");
      const email = (inp.value || "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { err.textContent = "올바른 이메일을 입력하세요."; err.classList.remove("hidden"); return; }
      try {
        const r = await fetch("/api/designers", { method: "POST", headers: Auth.headers(), body: JSON.stringify({ email }) });
        const j = await r.json();
        if (!r.ok) { err.textContent = j.error || "추가 실패"; err.classList.remove("hidden"); return; }
        inp.value = "";
        await this.render();
      } catch (e) { err.textContent = "네트워크 오류"; err.classList.remove("hidden"); }
    },
    async remove(email) {
      if (!confirm(email + " 의 디자이너 권한을 해제할까요?")) return;
      try {
        await fetch("/api/designers/" + encodeURIComponent(email), { method: "DELETE", headers: Auth.headers() });
        await this.render();
      } catch (e) {}
    },

    /* ── 사용 신청(access requests) 관리 ── */
    async loadRequests() {
      try {
        const r = await fetch("/api/access-requests", { headers: Auth.headers() });
        if (!r.ok) { this._reqCache = []; }
        else { const j = await r.json(); this._reqCache = (j && j.data) || []; }
      } catch (e) { this._reqCache = []; }
      this._updateCounts();
      if (this._tab === "requests") this.renderRequests();
    },
    _updateCounts() {
      const c = { pending: 0, approved: 0, rejected: 0, all: this._reqCache.length };
      this._reqCache.forEach((q) => { if (c[q.status] != null) c[q.status]++; });
      const set = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = n; };
      set("adm-cnt-pending", c.pending); set("adm-cnt-approved", c.approved);
      set("adm-cnt-rejected", c.rejected); set("adm-cnt-all", c.all);
      const badge = document.getElementById("adm-req-badge");
      if (badge) { badge.textContent = c.pending; badge.classList.toggle("hidden", c.pending === 0); }
    },
    _statusLabel(s) {
      return s === "approved" ? "승인됨" : s === "rejected" ? "거절됨" : "대기 중";
    },
    renderRequests() {
      const listEl = document.getElementById("adm-req-list");
      if (!listEl) return;
      const rows = this._reqStatus === "all"
        ? this._reqCache
        : this._reqCache.filter((q) => q.status === this._reqStatus);
      if (!rows.length) {
        listEl.innerHTML = '<div class="adm-req-empty"><i class="fa-regular fa-folder-open"></i><span>해당 상태의 신청이 없습니다.</span></div>';
        return;
      }
      listEl.innerHTML = "";
      rows.forEach((q) => {
        const row = document.createElement("div");
        row.className = "adm-req-row st-" + q.status;
        const initials = (q.name || q.email || "?").trim().charAt(0).toUpperCase();
        row.innerHTML = `
          <div class="adm-col-name">
            <span class="adm-avatar">${UI.escapeHtml(initials)}</span>
            <span class="adm-name-block">
              <span class="adm-name">${UI.escapeHtml(q.name || "(이름 없음)")}</span>
              <span class="adm-email">${UI.escapeHtml(q.email)}</span>
            </span>
          </div>
          <div class="adm-col-company">
            <span class="adm-company">${UI.escapeHtml(q.company || "—")}</span>
            <span class="adm-country">${UI.escapeHtml(q.country || "")}</span>
          </div>
          <div class="adm-col-contact">${UI.escapeHtml(q.phone || "—")}</div>
          <div class="adm-col-status"><span class="adm-badge ${q.status}">${this._statusLabel(q.status)}</span></div>
          <div class="adm-col-act"></div>
        `;
        const act = row.querySelector(".adm-col-act");
        if (q.status === "pending") {
          act.innerHTML = `<button class="adm-act-btn approve" title="승인"><i class="fa-solid fa-check"></i></button>
            <button class="adm-act-btn reject" title="거절"><i class="fa-solid fa-xmark"></i></button>`;
          act.querySelector(".approve").addEventListener("click", () => this.approve(q));
          act.querySelector(".reject").addEventListener("click", () => this.reject(q));
        } else if (q.status === "rejected") {
          act.innerHTML = `<button class="adm-act-btn approve" title="승인으로 변경"><i class="fa-solid fa-rotate-left"></i></button>`;
          act.querySelector(".approve").addEventListener("click", () => this.approve(q));
        } else {
          act.innerHTML = `<button class="adm-act-btn reject" title="권한 회수"><i class="fa-solid fa-ban"></i></button>`;
          act.querySelector(".reject").addEventListener("click", () => this.reject(q));
        }
        listEl.appendChild(row);
      });
    },
    async approve(q) {
      try {
        const r = await fetch("/api/access-requests/" + encodeURIComponent(q.id) + "/approve", { method: "POST", headers: Auth.headers() });
        if (!r.ok) { Prompt.toast("승인 실패"); return; }
        Prompt.toast(q.name + " 님을 디자이너로 승인했습니다");
        await this.loadRequests();
        await this.render();
      } catch (e) { Prompt.toast("네트워크 오류"); }
    },
    async reject(q) {
      if (!confirm((q.name || q.email) + " 의 신청을 거절/회수할까요?")) return;
      try {
        const r = await fetch("/api/access-requests/" + encodeURIComponent(q.id) + "/reject", { method: "POST", headers: Auth.headers() });
        if (!r.ok) { Prompt.toast("처리 실패"); return; }
        Prompt.toast("처리되었습니다");
        await this.loadRequests();
        await this.render();
      } catch (e) { Prompt.toast("네트워크 오류"); }
    },

    /* ── 활동 로그(슈퍼관리자 전용) ── */
    _logOffset: 0,
    _logActionLabel(a) {
      const m = {
        "auth.login": "로그인", "access.approve": "신청 승인", "access.reject": "신청 거절/회수",
        "project.create": "프로젝트 생성", "project.delete": "프로젝트 삭제",
        "deployment.create": "배포(저장)",
      };
      return m[a] || a;
    },
    _fmtTime(ts) {
      try {
        const d = new Date(ts);
        const p = (n) => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
      } catch (e) { return String(ts); }
    },
    async loadLogActions() {
      const sel = document.getElementById("log-action-filter");
      if (!sel) return;
      try {
        const r = await fetch("/api/activity-logs/actions", { headers: Auth.headers() });
        if (!r.ok) return;
        const { data } = await r.json();
        const cur = sel.value;
        sel.innerHTML = '<option value="">모든 액션</option>';
        (data || []).forEach((row) => {
          const o = document.createElement("option");
          o.value = row.action;
          o.textContent = `${this._logActionLabel(row.action)} (${row.n})`;
          sel.appendChild(o);
        });
        sel.value = cur;
      } catch (e) {}
    },
    async loadLogs(reset) {
      const listEl = document.getElementById("log-list");
      if (!listEl) return;
      if (reset) { this._logOffset = 0; listEl.innerHTML = '<div class="log-empty">불러오는 중…</div>'; }
      const q = (document.getElementById("log-search") || {}).value || "";
      const action = (document.getElementById("log-action-filter") || {}).value || "";
      const limit = 80;
      const params = new URLSearchParams({ limit: String(limit), offset: String(this._logOffset) });
      if (q) params.set("q", q);
      if (action) params.set("action", action);
      try {
        const r = await fetch("/api/activity-logs?" + params.toString(), { headers: Auth.headers() });
        if (!r.ok) { listEl.innerHTML = '<div class="log-empty">로그를 불러올 수 없습니다(권한 필요).</div>'; return; }
        const j = await r.json();
        const rows = j.data || [];
        const totalEl = document.getElementById("log-total");
        if (totalEl) totalEl.textContent = (j.total || 0) + "건";
        if (reset) listEl.innerHTML = "";
        if (!rows.length && reset) {
          listEl.innerHTML = '<div class="log-empty"><i class="fa-regular fa-folder-open"></i><span>기록이 없습니다.</span></div>';
        } else {
          rows.forEach((it) => listEl.appendChild(this._logRow(it)));
        }
        this._logOffset += rows.length;
        const moreWrap = document.getElementById("log-more-wrap");
        if (moreWrap) moreWrap.classList.toggle("hidden", this._logOffset >= (j.total || 0));
      } catch (e) {
        listEl.innerHTML = '<div class="log-empty">네트워크 오류</div>';
      }
    },
    _logRow(it) {
      const row = document.createElement("div");
      row.className = "log-row role-" + (it.actor_role || "guest");
      const actor = it.actor_email || "(게스트)";
      const target = [it.target_type, it.target_id].filter(Boolean).join(" · ") || "—";
      let detail = "";
      if (it.detail) { try { detail = JSON.stringify(JSON.parse(it.detail)); } catch (e) { detail = it.detail; } }
      row.innerHTML = `
        <span class="log-col-time">${UI.escapeHtml(this._fmtTime(it.ts))}</span>
        <span class="log-col-actor">
          <span class="log-role-badge ${UI.escapeHtml(it.actor_role || "guest")}">${UI.escapeHtml(it.actor_role || "guest")}</span>
          <span class="log-actor-email">${UI.escapeHtml(actor)}</span>
        </span>
        <span class="log-col-action"><span class="log-action-badge">${UI.escapeHtml(this._logActionLabel(it.action))}</span></span>
        <span class="log-col-target" title="${UI.escapeHtml(detail)}">${UI.escapeHtml(target)}</span>
        <span class="log-col-act"><button class="log-del-btn" title="이 기록 삭제"><i class="fa-solid fa-xmark"></i></button></span>
      `;
      row.querySelector(".log-del-btn").addEventListener("click", () => this.deleteLog(it.id, row));
      return row;
    },
    async deleteLog(id, rowEl) {
      try {
        const r = await fetch("/api/activity-logs/" + encodeURIComponent(id), { method: "DELETE", headers: Auth.headers() });
        if (r.ok && rowEl) rowEl.remove();
      } catch (e) {}
    },
    async purgeLogs() {
      if (!confirm("모든 활동 로그를 비울까요? (되돌릴 수 없습니다)")) return;
      try {
        const r = await fetch("/api/activity-logs?all=1", { method: "DELETE", headers: Auth.headers() });
        if (r.ok) { Prompt.toast("로그를 정리했습니다"); this.loadLogActions(); this.loadLogs(true); }
        else Prompt.toast("정리 실패");
      } catch (e) { Prompt.toast("네트워크 오류"); }
    }
  };

  /* ══════════════════════════════════════════
     PDF ANNO — 최소 PDF 주석(ezPDF) : 형광펜/사각형/자유선/텍스트메모
     주석은 State.annotations[]에 % 좌표(0~1000)로 저장, 페이지별 렌더.
  ══════════════════════════════════════════ */