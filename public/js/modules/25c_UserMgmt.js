  /* ══════════════════════════════════════════════════════════════
     USER MANAGEMENT — SECMS 관리자 "사용자 관리" 완전 차용 (엑셀형 그리드)
     ────────────────────────────────────────────────────────────────
     · SECMS components/admin/UserManagement.tsx 구조 그대로:
         좌측 필터레일 + 통합 사용자 테이블(엑셀형 셀 괘선) + 체크박스 일괄선택
         + 일괄작업(권한/삭제) + 페이지크기 선택 + 페이지네이션 + 행 상태 틴트.
     · 360 실제 역할(디자이너↔뷰어)에 매핑. 24개 세부권한(케이블 도메인)은 제외.
     · 기존 검증 엔드포인트 클라이언트 통합:
         GET /api/designers · /api/local-users · /api/access-requests · /api/projects(호선수)
       역할변경 POST/DELETE /api/designers · 승인거절 /api/access-requests/:id/(approve|reject)
       가입취소 DELETE /api/local-users/:email
  ══════════════════════════════════════════════════════════════ */
  const UserMgmt = {
    _all: [],
    _designerSet: null,
    _filter: "active",     // active | designer | pending | rejected | all
    _q: "",
    _page: 1,
    _pageSize: 20,
    _busy: false,
    _selected: null,       // Set<email>

    /** 보호(명단 비노출·선택 불가) = 서버가 판정한 슈퍼관리자 행(is_super) + 내가 super 면 나 자신.
     *  [R1 2026-10-10] 이메일 하드코딩·이메일 비교 금지 — 서버 판정(행 is_super · Auth.role)만 쓴다. */
    _protected() {
      const s = new Set(this._superSet || []);
      if (Auth.isSuper && Auth.user && Auth.user.email) s.add(String(Auth.user.email).toLowerCase());
      return s;
    },

    init() {
      const $ = (id) => document.getElementById(id);
      if (!this._selected) this._selected = new Set();
      document.querySelectorAll("#adm-panel-users .um-filter-item").forEach((b) => {
        b.addEventListener("click", () => {
          this._filter = b.dataset.filter; this._page = 1;
          this._syncFilterUI(); this.render();
        });
      });
      const s = $("um-search");
      if (s) s.addEventListener("input", () => { this._q = (s.value || "").trim().toLowerCase(); this._page = 1; this.render(); });
      $("um-refresh") && $("um-refresh").addEventListener("click", () => this.load());
      $("um-add-btn") && $("um-add-btn").addEventListener("click", () => this._quickAdd());
      const ai = $("um-add-input");
      if (ai) ai.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); this._quickAdd(); } });
      const ps = $("um-pagesize");
      if (ps) ps.addEventListener("change", () => { this._pageSize = parseInt(ps.value, 10) || 20; this._page = 1; this.render(); });
      // 전체 선택(현재 페이지)
      const all = $("um-all");
      if (all) all.addEventListener("change", () => this._toggleAllVisible(all.checked));
      // 일괄 작업
      $("um-bulk-designer") && $("um-bulk-designer").addEventListener("click", () => this._bulkRole("designer"));
      $("um-bulk-viewer") && $("um-bulk-viewer").addEventListener("click", () => this._bulkRole("viewer"));
      $("um-bulk-del") && $("um-bulk-del").addEventListener("click", () => this._bulkDelete());
    },

    /* ── 데이터: 4개 엔드포인트 병렬 → 이메일 기준 통합 ── */
    async load() {
      const tbody = document.getElementById("um-tbody");
      if (tbody) tbody.innerHTML = '<tr><td colspan="10" class="um-loading">불러오는 중...</td></tr>';
      const H = Auth.headers();
      const safe = async (url) => {
        try { const r = await fetch(url, { headers: H }); if (!r.ok) return []; const j = await r.json(); return (j && (j.data || j.results)) || (Array.isArray(j) ? j : []); }
        catch (e) { return []; }
      };
      const [designers, members, requests, projects] = await Promise.all([
        safe("/api/designers"), safe("/api/local-users"), safe("/api/access-requests"), safe("/api/projects"),
      ]);
      const dset = new Set(designers.map((d) => String(d.email || "").toLowerCase()));
      this._superSet = new Set([].concat(designers, members, requests).filter((r) => r && r.is_super).map((r) => String(r.email || "").toLowerCase()));
      this._designerSet = dset;
      // 호선수: owner 이메일별 프로젝트 수
      const pcount = new Map();
      projects.forEach((p) => { const o = String(p.owner || "").toLowerCase(); if (o) pcount.set(o, (pcount.get(o) || 0) + 1); });

      const map = new Map();
      const ensure = (email) => {
        const k = String(email || "").toLowerCase();
        if (!k) return null;
        if (!map.has(k)) map.set(k, { email: k, name: "", company: "", isDesigner: dset.has(k), isMember: false, reqStatus: null, requestId: null, last_login: null, created_at: null });
        return map.get(k);
      };
      designers.forEach((d) => { const u = ensure(d.email); if (!u) return; if (d.name) u.name = d.name; if (d.created_at) u.created_at = d.created_at; });
      members.forEach((m) => {
        const u = ensure(m.email); if (!u) return;
        u.isMember = true;
        if (m.name) u.name = m.name;
        if (m.company) u.company = m.company;
        if (m.last_login_at) u.last_login = m.last_login_at;
        if (m.created_at) u.created_at = u.created_at || m.created_at;
      });
      requests.forEach((rq) => {
        const u = ensure(rq.email); if (!u) return;
        if (rq.name && !u.name) u.name = rq.name;
        if (rq.company && !u.company) u.company = rq.company;
        u.reqStatus = rq.status || null;
        u.requestId = rq.id || null;
        if (rq.created_at) u.created_at = u.created_at || rq.created_at;
      });

      // [마스터 지시] 슈퍼관리자는 사용자 명단에 노출하지 않는다 (SECMS와 동일 — 관리 대상이 아님).
      const prot = this._protected();
      this._all = Array.from(map.values())
        .filter((u) => !prot.has(u.email))
        .map((u) => {
          const role = u.isDesigner ? "designer" : "viewer";
          let status;
          if (u.isDesigner || u.isMember) status = "active";
          else if (u.reqStatus === "pending") status = "pending";
          else if (u.reqStatus === "rejected") status = "rejected";
          else status = "active";
          return Object.assign(u, { role, status, projects: pcount.get(u.email) || 0 });
        });
      // 사라진 선택 제거
      const live = new Set(this._all.map((u) => u.email));
      this._selected.forEach((e) => { if (!live.has(e)) this._selected.delete(e); });
      this._updateCounts();
      this._syncFilterUI();
      this.render();
    },

    _updateCounts() {
      const c = { active: 0, designer: 0, pending: 0, rejected: 0, all: this._all.length };
      this._all.forEach((u) => {
        if (u.role === "designer") c.designer++;
        if (u.status === "pending") c.pending++;
        else if (u.status === "rejected") c.rejected++;
        else c.active++;
      });
      const set = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = n; };
      set("um-cnt-active", c.active); set("um-cnt-designer", c.designer);
      set("um-cnt-pending", c.pending); set("um-cnt-rejected", c.rejected); set("um-cnt-all", c.all);
    },
    _syncFilterUI() {
      document.querySelectorAll("#adm-panel-users .um-filter-item").forEach((b) => {
        b.classList.toggle("active", b.dataset.filter === this._filter);
      });
    },

    _visible() {
      let list = this._all.slice();
      const f = this._filter;
      if (f === "active") list = list.filter((u) => u.status === "active");
      else if (f === "designer") list = list.filter((u) => u.role === "designer");
      else if (f === "pending") list = list.filter((u) => u.status === "pending");
      else if (f === "rejected") list = list.filter((u) => u.status === "rejected");
      if (this._q) list = list.filter((u) =>
        (u.email || "").includes(this._q) || (u.name || "").toLowerCase().includes(this._q) || (u.company || "").toLowerCase().includes(this._q));
      list.sort((a, b) => {
        const pa = a.status === "pending" ? 0 : 1, pb = b.status === "pending" ? 0 : 1;
        if (pa !== pb) return pa - pb;
        if ((a.role === "designer") !== (b.role === "designer")) return a.role === "designer" ? -1 : 1;
        return (a.email || "").localeCompare(b.email || "");
      });
      return list;
    },

    render() {
      const tbody = document.getElementById("um-tbody");
      if (!tbody) return;
      const esc = (s) => (typeof UI !== "undefined" && UI.escapeHtml) ? UI.escapeHtml(s == null ? "" : String(s)) : String(s == null ? "" : s);
      const prot = this._protected();
      const all = this._visible();
      const total = all.length;
      const pages = Math.max(1, Math.ceil(total / this._pageSize));
      if (this._page > pages) this._page = pages;
      const start = (this._page - 1) * this._pageSize;
      const rows = all.slice(start, start + this._pageSize);

      const fmtD = (ts) => { if (!ts) return "—"; const d = new Date(ts); return isNaN(d) ? "—" : d.toISOString().slice(0, 10); };
      const ago = (ts) => { if (!ts) return ""; const d = new Date(ts); if (isNaN(d)) return ""; const days = Math.floor((Date.now() - d.getTime()) / 86400000); return days >= 0 ? (days + "일 경과") : ""; };
      const fmtT = (ts) => { if (!ts) return "—"; const d = new Date(ts); return isNaN(d) ? "—" : d.toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" }); };

      if (!rows.length) { tbody.innerHTML = '<tr><td colspan="10" class="um-empty">표시할 사용자가 없습니다.</td></tr>'; this._renderPager(pages, total); this._renderBulk(); return; }

      tbody.innerHTML = rows.map((u) => {
        const isProt = prot.has(u.email);
        const local = (u.email || "").split("@")[0];
        const sel = this._selected.has(u.email);
        const rowCls = (u.status === "pending" ? " um-r-pending" : u.status === "rejected" ? " um-r-rejected" : "") + (sel ? " um-r-sel" : "");
        const ck = isProt ? '<span class="um-cklock">—</span>' : '<input type="checkbox" class="um-ck-row" data-email="' + esc(u.email) + '"' + (sel ? " checked" : "") + ">";
        const statusBadge =
          u.status === "pending"  ? '<span class="um-badge um-st-pending">신청 대기</span>'
          : u.status === "rejected" ? '<span class="um-badge um-st-rejected">거절됨</span>'
          : '<span class="um-badge um-st-active">활성</span>';
        const lockRole = isProt || u.status === "pending" || u.status === "rejected";
        const roleCell = isProt
          ? '<span class="um-badge um-role-admin">슈퍼관리자</span>'
          : '<div class="um-roletoggle' + (lockRole ? ' locked' : '') + '" data-email="' + esc(u.email) + '">' +
              '<button class="um-rt-btn' + (u.role === "designer" ? ' on' : '') + '" data-role="designer"' + (lockRole ? ' disabled' : '') + '>디자이너</button>' +
              '<button class="um-rt-btn' + (u.role === "viewer" ? ' on' : '') + '" data-role="viewer"' + (lockRole ? ' disabled' : '') + '>뷰어</button>' +
            '</div>';
        let act = "";
        if (u.status === "pending" && u.requestId) {
          act = '<button class="um-act um-approve" data-id="' + esc(u.requestId) + '" data-email="' + esc(u.email) + '">승인</button>' +
                '<button class="um-act um-reject" data-id="' + esc(u.requestId) + '">거절</button>';
        } else if (isProt) {
          act = '<span class="um-act-none">—</span>';
        } else if (u.isMember) {
          act = '<button class="um-act um-del" data-email="' + esc(u.email) + '" title="가입 취소(삭제)">삭제</button>';
        } else if (u.status === "rejected" && u.requestId) {
          act = '<button class="um-act um-approve" data-id="' + esc(u.requestId) + '" data-email="' + esc(u.email) + '">재승인</button>';
        } else {
          act = '<span class="um-act-none">—</span>';
        }
        const adminTag = isProt ? ' <span class="um-tag-admin">ADMIN</span>' : '';
        return '<tr class="' + rowCls.trim() + '">' +
          '<td class="um-c-ck">' + ck + '</td>' +
          '<td class="um-c-id"><span class="um-id">' + esc(local) + '</span>' + adminTag + '</td>' +
          '<td class="um-c-name"><div class="um-name">' + esc(u.name || "—") + '</div><div class="um-mail">' + esc(u.email) + '</div></td>' +
          '<td class="um-c-co">' + esc(u.company || "—") + '</td>' +
          '<td class="um-c-role">' + roleCell + '</td>' +
          '<td class="um-c-status">' + statusBadge + '</td>' +
          '<td class="um-c-proj">' + (u.projects || 0) + '</td>' +
          '<td class="um-c-login">' + fmtT(u.last_login) + '</td>' +
          '<td class="um-c-date">' + fmtD(u.created_at) + '<div class="um-sub">' + ago(u.created_at) + '</div></td>' +
          '<td class="um-c-act">' + act + '</td>' +
        '</tr>';
      }).join("");

      tbody.querySelectorAll(".um-roletoggle:not(.locked) .um-rt-btn").forEach((btn) => {
        btn.addEventListener("click", () => this._setRole(btn.closest(".um-roletoggle").dataset.email, btn.dataset.role));
      });
      tbody.querySelectorAll(".um-approve").forEach((b) => b.addEventListener("click", () => this._approve(b.dataset.id, b.dataset.email)));
      tbody.querySelectorAll(".um-reject").forEach((b) => b.addEventListener("click", () => this._reject(b.dataset.id)));
      tbody.querySelectorAll(".um-del").forEach((b) => b.addEventListener("click", () => this._delMember(b.dataset.email)));
      tbody.querySelectorAll(".um-ck-row").forEach((cb) => cb.addEventListener("change", () => {
        if (cb.checked) this._selected.add(cb.dataset.email); else this._selected.delete(cb.dataset.email);
        const tr = cb.closest("tr"); if (tr) tr.classList.toggle("um-r-sel", cb.checked);
        this._renderBulk(); this._syncSelectAll(rows, prot);
      }));

      this._syncSelectAll(rows, prot);
      this._renderPager(pages, total);
      this._renderBulk();
    },

    _syncSelectAll(rows, prot) {
      const all = document.getElementById("um-all");
      if (!all) return;
      const selectable = rows.filter((u) => !prot.has(u.email));
      const selCount = selectable.filter((u) => this._selected.has(u.email)).length;
      all.checked = selectable.length > 0 && selCount === selectable.length;
      all.indeterminate = selCount > 0 && selCount < selectable.length;
    },
    _toggleAllVisible(on) {
      const prot = this._protected();
      const all = this._visible();
      const start = (this._page - 1) * this._pageSize;
      const rows = all.slice(start, start + this._pageSize);
      rows.forEach((u) => { if (prot.has(u.email)) return; if (on) this._selected.add(u.email); else this._selected.delete(u.email); });
      this.render();
    },
    _renderBulk() {
      const bar = document.getElementById("um-bulkbar");
      if (!bar) return;
      const n = this._selected.size;
      bar.classList.toggle("hidden", n === 0);
      const c = document.getElementById("um-sel-count");
      if (c) c.textContent = n;
    },

    _renderPager(pages, total) {
      const el = document.getElementById("um-pager");
      if (!el) return;
      el.innerHTML =
        '<span class="um-total">총 ' + total + '명</span>' +
        '<button class="um-pg" data-pg="first"' + (this._page <= 1 ? ' disabled' : '') + '>«</button>' +
        '<button class="um-pg" data-pg="prev"' + (this._page <= 1 ? ' disabled' : '') + '>‹</button>' +
        '<span class="um-pgnum">' + this._page + ' / ' + pages + '</span>' +
        '<button class="um-pg" data-pg="next"' + (this._page >= pages ? ' disabled' : '') + '>›</button>' +
        '<button class="um-pg" data-pg="last"' + (this._page >= pages ? ' disabled' : '') + '>»</button>';
      el.querySelectorAll(".um-pg").forEach((b) => b.addEventListener("click", () => {
        const v = b.dataset.pg;
        if (v === "first") this._page = 1;
        else if (v === "prev" && this._page > 1) this._page--;
        else if (v === "next" && this._page < pages) this._page++;
        else if (v === "last") this._page = pages;
        this.render();
      }));
    },

    /* ── 단건 변경 ── */
    async _setRole(email, role) {
      if (this._busy) return; this._busy = true;
      try {
        if (role === "designer") await fetch("/api/designers", { method: "POST", headers: Auth.headers(), body: JSON.stringify({ email }) });
        else await fetch("/api/designers/" + encodeURIComponent(email), { method: "DELETE", headers: Auth.headers() });
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast(email + " → " + (role === "designer" ? "디자이너" : "뷰어"));
      } catch (e) { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("권한 변경 실패"); }
      finally { this._busy = false; await this.load(); }
    },
    async _approve(id, email) {
      if (this._busy) return; this._busy = true;
      try { await fetch("/api/access-requests/" + encodeURIComponent(id) + "/approve", { method: "POST", headers: Auth.headers() });
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast((email || "신청자") + " 승인"); }
      catch (e) {} finally { this._busy = false; await this.load(); }
    },
    async _reject(id) {
      if (this._busy) return; this._busy = true;
      try { await fetch("/api/access-requests/" + encodeURIComponent(id) + "/reject", { method: "POST", headers: Auth.headers() }); }
      catch (e) {} finally { this._busy = false; await this.load(); }
    },
    async _delMember(email) {
      if (!await Prompt.confirm("가입 취소", email + " 사용자의 가입을 취소(삭제)하시겠습니까?")) return;
      if (this._busy) return; this._busy = true;
      try { await fetch("/api/local-users/" + encodeURIComponent(email), { method: "DELETE", headers: Auth.headers() }); }
      catch (e) {} finally { this._busy = false; await this.load(); }
    },

    /* ── 일괄 작업 ── */
    async _bulkRole(role) {
      const emails = Array.from(this._selected);
      if (!emails.length) return;
      if (!await Prompt.confirm("역할 일괄 지정", "선택한 " + emails.length + "명을 " + (role === "designer" ? "디자이너" : "뷰어") + "로 지정할까요?")) return;
      this._busy = true;
      try {
        for (const email of emails) {
          if (role === "designer") await fetch("/api/designers", { method: "POST", headers: Auth.headers(), body: JSON.stringify({ email }) });
          else await fetch("/api/designers/" + encodeURIComponent(email), { method: "DELETE", headers: Auth.headers() });
        }
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast(emails.length + "명 → " + (role === "designer" ? "디자이너" : "뷰어"));
      } catch (e) {} finally { this._busy = false; this._selected.clear(); await this.load(); }
    },
    async _bulkDelete() {
      const emails = Array.from(this._selected);
      if (!emails.length) return;
      if (!await Prompt.confirm("가입 일괄 취소", "선택한 " + emails.length + "명의 가입을 취소(삭제)할까요? (가입 사용자만 삭제됩니다)")) return;
      this._busy = true;
      try { for (const email of emails) await fetch("/api/local-users/" + encodeURIComponent(email), { method: "DELETE", headers: Auth.headers() }); }
      catch (e) {} finally { this._busy = false; this._selected.clear(); await this.load(); }
    },

    async _quickAdd() {
      const inp = document.getElementById("um-add-input");
      const err = document.getElementById("um-add-error");
      if (err) err.classList.add("hidden");
      const email = (inp.value || "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { if (err) { err.textContent = "올바른 이메일을 입력하세요."; err.classList.remove("hidden"); } return; }
      try {
        const r = await fetch("/api/designers", { method: "POST", headers: Auth.headers(), body: JSON.stringify({ email }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { if (err) { err.textContent = j.error || "추가 실패"; err.classList.remove("hidden"); } return; }
        inp.value = "";
        await this.load();
      } catch (e) { if (err) { err.textContent = "네트워크 오류"; err.classList.remove("hidden"); } }
    },
  };
