  const ASK_ENTRY_MODE = false; // 2026-08 마스터 지시: 지금은 묻지 말고 무조건 편집모드. 뷰어 배포 후 true 로 바꾸면 다시 선택 모달이 뜬다.

  const ProjectHub = {
    list: [],
    _loaded: false,
    // [WO 20260921 publish-fix] subdomain 없는 배포 프로젝트의 뷰어 딥링크(?d=) 캐시.
    //   project_id → deployment_id(string) | null(도면 없음, 조회 완료) — SoT: /api/projects/:id/decks.
    _deployLinkCache: {},

    init() {
      const $ = (id) => document.getElementById(id);
      $("hub-btn-new") && $("hub-btn-new").addEventListener("click", () => this.createProject());
      // hub 인증바 버튼들 (홈 인증바와 동일 동작)
      $("hub-btn-signout") && $("hub-btn-signout").addEventListener("click", () => Auth.signOut());
      $("hub-btn-manage-designers") && $("hub-btn-manage-designers").addEventListener("click", () => Designers.open());
      // 접근 신청 모달
      $("par-cancel") && $("par-cancel").addEventListener("click", () => this.closeAccessReq());
      $("par-backdrop") && $("par-backdrop").addEventListener("click", () => this.closeAccessReq());
      $("par-submit") && $("par-submit").addEventListener("click", () => this.submitAccessReq());
      // [P3] 프로젝트별 멤버 배정 모달
      $("pm-close") && $("pm-close").addEventListener("click", () => this.closeMembers());
      const pmBd = document.querySelector("#proj-members-modal .admin-gate-backdrop");
      if (pmBd) pmBd.addEventListener("click", () => this.closeMembers());
      $("pm-add-btn") && $("pm-add-btn").addEventListener("click", () => this.addMember());
      const pmEmail = $("pm-email");
      if (pmEmail) pmEmail.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); this.addMember(); } });
      // [P40] 초대 링크 복사
      $("pm-invite-copy") && $("pm-invite-copy").addEventListener("click", () => this._copyInviteLink());
      // [P63] 뷰어 초대코드 — 발급·복사·공유(폐기는 목록 행에서 위임)
      $("pm-code-add") && $("pm-code-add").addEventListener("click", () => this.createShareCode());
      $("pm-code-copy") && $("pm-code-copy").addEventListener("click", () => {
        const el = $("pm-code-new"); if (el) this._copyDeployUrl(el.value);
      });
      $("pm-code-share") && $("pm-code-share").addEventListener("click", () => {
        const el = $("pm-code-new");
        if (el) this._shareDeployUrl(el.value, "뷰어 초대코드");
      });
      // [P53] 초대 링크 공유 — navigator.share() 는 사용자 제스처 안에서 동기 호출해야 하므로
      //   이 핸들러 자체를 async 로 만들지 않는다(await 를 앞세우면 제스처가 끊겨 브라우저가 거부한다).
      $("pm-invite-share") && $("pm-invite-share").addEventListener("click", () => this._shareInviteLink());
      // [멀티테넌트] 서브도메인 부여
      $("pm-subdomain-btn") && $("pm-subdomain-btn").addEventListener("click", () => this.setSubdomain());
      // [마스터 요청] 디자이너/뷰어 선택 모달
      $("pms-cancel") && $("pms-cancel").addEventListener("click", () => this.closeModeSelect());
      $("pms-backdrop") && $("pms-backdrop").addEventListener("click", () => this.closeModeSelect());
      $("pms-btn-designer") && $("pms-btn-designer").addEventListener("click", () => this._enterAsDesigner());
      $("pms-btn-viewer") && $("pms-btn-viewer").addEventListener("click", () => this._enterAsViewer());
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
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast(j.subdomain ? ("전용 도메인 설정: " + (j.url || j.subdomain)) : "도메인 해제됨");
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
      // [P63] 직전 발급물은 모달을 열 때마다 감춘다 — 원문은 발급 순간에만 존재한다.
      const codeBox = document.getElementById("pm-code-new-box"); if (codeBox) codeBox.classList.add("hidden");
      const codeErr = document.getElementById("pm-code-error"); if (codeErr) codeErr.classList.add("hidden");
      const codeLbl = document.getElementById("pm-code-label"); if (codeLbl) codeLbl.value = "";
      m.classList.remove("hidden"); requestAnimationFrame(() => m.classList.add("on"));
      await Promise.all([this.loadMembers(), this.loadAccessReqs(), this.loadPendingInvites(), this.loadShareCodes()]);
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
    async loadAccessReqs() {
      const p = this._memProject; if (!p) return;
      const sec = document.getElementById("pm-access-reqs");
      const list = document.getElementById("pm-access-reqs-list");
      if (!sec || !list) return;
      try {
        const r = await fetch("/api/projects/" + encodeURIComponent(p.id) + "/access-requests?status=pending", { headers: Auth.headers() });
        if (!r.ok) { sec.classList.add("hidden"); return; }
        const { data } = await r.json();
        if (!data || !data.length) { sec.classList.add("hidden"); return; }
        sec.classList.remove("hidden");
        const esc = (s) => (typeof UI !== "undefined" && UI.escapeHtml) ? UI.escapeHtml(s) : s;
        list.innerHTML = "";
        data.forEach((req) => {
          const d = new Date(req.created_at);
          const dateStr = d.getFullYear() + "." + String(d.getMonth()+1).padStart(2,"0") + "." + String(d.getDate()).padStart(2,"0");
          const row = document.createElement("div");
          row.className = "par-row";
          row.innerHTML = '<span class="par-email" title="' + esc(req.email) + '">' + esc(req.email) + '</span>' +
            (req.message ? '<span class="par-msg">' + esc(req.message) + '</span>' : '') +
            '<span class="par-date">' + dateStr + '</span>' +
            '<button class="admin-gate-btn primary par-btn-approve" data-rid="' + esc(req.id) + '" type="button">승인</button>' +
            '<button class="admin-gate-btn danger par-btn-reject" data-rid="' + esc(req.id) + '" type="button">거절</button>';
          row.querySelector(".par-btn-approve").addEventListener("click", () => this._handleAccessReq(req.id, "approve"));
          row.querySelector(".par-btn-reject").addEventListener("click", () => this._handleAccessReq(req.id, "reject"));
          list.appendChild(row);
        });
      } catch (e) { sec.classList.add("hidden"); }
    },
    async _handleAccessReq(rid, action) {
      const p = this._memProject; if (!p) return;
      try {
        const r = await fetch("/api/projects/" + encodeURIComponent(p.id) + "/access-requests/" + encodeURIComponent(rid) + "/" + action,
          { method: "POST", headers: Auth.headers() });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const label = action === "approve" ? "승인" : "거절";
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("" + label + " 처리됨");
        await this.loadAccessReqs();
        if (action === "approve") await this.loadMembers();
      } catch (e) { alert("처리 실패: " + (e && e.message ? e.message : "오류")); }
    },

    // 접근 신청 모달 (비멤버 사용자)
    openAccessReq(p) {
      this._reqProject = p;
      const m = document.getElementById("proj-access-req-modal"); if (!m) return;
      const nm = document.getElementById("par-proj-name"); if (nm) nm.textContent = p.name || p.id;
      const msg = document.getElementById("par-message"); if (msg) msg.value = "";
      const err = document.getElementById("par-error"); if (err) err.classList.add("hidden");
      const sub = document.getElementById("par-submit");
      const pendingMsg = document.getElementById("par-pending-msg");
      if (p.my_request === "pending") {
        if (pendingMsg) pendingMsg.classList.remove("hidden");
        if (msg) msg.classList.add("hidden");
        if (sub) { sub.textContent = "다시 신청"; sub.disabled = false; }
      } else {
        if (pendingMsg) pendingMsg.classList.add("hidden");
        if (msg) msg.classList.remove("hidden");
        if (sub) { sub.textContent = "신청하기"; sub.disabled = false; }
      }
      m.classList.remove("hidden"); requestAnimationFrame(() => m.classList.add("on"));
    },
    closeAccessReq() {
      const m = document.getElementById("proj-access-req-modal"); if (!m) return;
      m.classList.remove("on"); setTimeout(() => m.classList.add("hidden"), 200);
    },
    async submitAccessReq() {
      const p = this._reqProject; if (!p) return;
      const sub = document.getElementById("par-submit");
      const err = document.getElementById("par-error"); if (err) err.classList.add("hidden");
      const message = (document.getElementById("par-message") || {}).value || "";
      if (sub) { sub.disabled = true; sub.textContent = "신청 중…"; }
      try {
        const r = await fetch("/api/projects/" + encodeURIComponent(p.id) + "/request-access",
          { method: "POST", headers: Auth.headers(), body: JSON.stringify({ message }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok && r.status !== 409) {
          if (err) { err.textContent = j.error || "신청 실패"; err.classList.remove("hidden"); }
          if (sub) { sub.disabled = false; sub.textContent = "신청하기"; }
          return;
        }
        // 성공 또는 409(already member)
        p.my_request = "pending";
        this.closeAccessReq();
        const label = r.status === 409 ? "이미 멤버입니다." : "접근 신청이 접수되었습니다. 관리자 승인을 기다려 주세요.";
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("" + label, 3000);
        // 카드 상태 갱신
        this.render();
      } catch (e) {
        if (err) { err.textContent = "네트워크 오류"; err.classList.remove("hidden"); }
        if (sub) { sub.disabled = false; sub.textContent = "신청하기"; }
      }
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
        const roleLabel = role === "designer" ? "디자이너(모든 구역 세팅)" : "뷰어(열람)";
        if (j.invited && j.invite_url) {
          // [P40] 계정은 만들어지지 않았다. 링크를 받은 본인이 이름·비번을 설정해야 계정이 생긴다.
          this._showInviteLink(email, roleLabel, j.invite_url, j.expires_at);
        } else if (typeof Prompt !== "undefined" && Prompt.toast) {
          Prompt.toast("" + email + " 배정(" + roleLabel + ") — 기존 계정이라 바로 접근할 수 있습니다.", 4000);
        }
      } catch (e) { if (err) { err.textContent = "네트워크 오류"; err.classList.remove("hidden"); } }
    },
    /* ── [P40] 초대 링크 ── */
    /** 발급된 1회용 초대 링크를 관리자에게 보여준다(토큰 원문은 이 순간에만 존재 — DB 엔 해시만). */
    _showInviteLink(email, roleLabel, url, expiresAt) {
      const box = document.getElementById("pm-invite-link-box");
      const inp = document.getElementById("pm-invite-link");
      if (!box || !inp) {
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("초대 링크: " + url, 8000);
        return;
      }
      inp.value = url;
      const note = document.getElementById("pm-invite-link-note");
      if (note) {
        const d = expiresAt ? new Date(Number(expiresAt)) : null;
        const ds = d ? (d.getFullYear() + "." + String(d.getMonth() + 1).padStart(2, "0") + "." + String(d.getDate()).padStart(2, "0")) : "";
        note.textContent = email + " (" + roleLabel + ") — 이 링크를 본인에게 전달하세요. 1회용" + (ds ? (" · " + ds + " 까지") : "") + ". 계정은 본인이 이름·비밀번호를 설정할 때 생성됩니다.";
      }
      box.classList.remove("hidden");
      try { inp.select(); } catch (e) {}
      this._copyInviteLink();
    },
    _copyInviteLink() {
      const inp = document.getElementById("pm-invite-link");
      if (!inp || !inp.value) return;
      const done = () => { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("초대 링크를 복사했습니다."); };
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(inp.value).then(done).catch(() => {}); return; }
        inp.select(); document.execCommand("copy"); done();
      } catch (e) {}
    },
    /** [P53] 초대 링크 공유 — 폰에서 누르면 공유시트(카톡 등)가 뜬다.
     *  navigator.share 미지원 환경(데스크톱 크롬 등)은 기존 복사 동작(_copyInviteLink, SoT)으로 대체한다.
     *  🔴 navigator.share 는 사용자 제스처 컨텍스트 안에서만 호출되므로 이 함수는 async 가 아니고,
     *  호출도 클릭 핸들러에서 await 없이 동기적으로 이뤄진다. */
    _shareInviteLink() {
      const inp = document.getElementById("pm-invite-link");
      const url = inp && inp.value;
      if (!url) return;
      if (!navigator.share) { this._copyInviteLink(); return; }
      const p = this._memProject;
      const projectName = (p && (p.name || p.id)) || "프로젝트"; // SoT: 실제 프로젝트 값에서만 가져온다(하드코딩 금지)
      navigator.share({ title: "SEASTAR 360 초대", text: '"' + projectName + '" 프로젝트 초대 링크', url: url })
        .catch((e) => {
          if (e && e.name === "AbortError") return; // 사용자가 공유시트를 취소 — 정상 동작, 오류 알림 금지
          if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("공유 실패: " + (e && e.message ? e.message : "알 수 없는 오류"));
        });
    },
    /** 아직 수락되지 않은 초대 목록(토큰 원문은 서버가 절대 돌려주지 않는다) */
    async loadPendingInvites() {
      const p = this._memProject; if (!p) return;
      const sec = document.getElementById("pm-pending-invites");
      const list = document.getElementById("pm-pending-invites-list");
      if (!sec || !list) return;
      try {
        const r = await fetch("/api/projects/" + encodeURIComponent(p.id) + "/invites", { headers: Auth.headers() });
        if (!r.ok) { sec.classList.add("hidden"); return; }
        const { data } = await r.json();
        if (!data || !data.length) { sec.classList.add("hidden"); return; }
        sec.classList.remove("hidden");
        const esc = (s) => (typeof UI !== "undefined" && UI.escapeHtml) ? UI.escapeHtml(s) : s;
        list.innerHTML = "";
        data.forEach((iv) => {
          const d = new Date(Number(iv.expires_at));
          const ds = d.getFullYear() + "." + String(d.getMonth() + 1).padStart(2, "0") + "." + String(d.getDate()).padStart(2, "0");
          const roleLabel = (typeof Auth !== "undefined" && Auth._ROLE_LABELS && Auth._ROLE_LABELS[iv.role]) || iv.role;
          const row = document.createElement("div");
          row.className = "member-row";
          row.innerHTML = '<span class="mem-col-email" title="' + esc(iv.email) + '">' + esc(iv.email) + '</span>' +
            '<span class="pm-role-badge role-' + esc(iv.role) + '">' + esc(roleLabel) + '</span>' +
            '<span class="par-date">~' + ds + '</span>' +
            '<button class="designer-del" title="초대 취소">✕</button>';
          row.querySelector(".designer-del").addEventListener("click", () => this.revokeInvite(iv.id));
          list.appendChild(row);
        });
      } catch (e) { sec.classList.add("hidden"); }
    },
    async revokeInvite(iid) {
      const p = this._memProject; if (!p) return;
      try {
        await fetch("/api/projects/" + encodeURIComponent(p.id) + "/invites/" + encodeURIComponent(iid),
          { method: "DELETE", headers: Auth.headers() });
        await this.loadPendingInvites();
      } catch (e) {}
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
      // [마스터 2026-09-17] "첫 화면은 무조건 프로젝트 선택이 나오게 해" — 최근 프로젝트로
      //   건너뛰는 자동입장(옛 AUTO_DESIGNER_ENTRY 연장 블록)을 제거했다. 배포 링크(?d=)가 아닌
      //   모든 진입은 여기서 항상 카드 목록(프로젝트 허브)을 보여준다.
    },

    async load() {
      // [P63] 공유·배포 링크 세션은 프로젝트 목록을 아예 불러오지도·그리지도 않는다.
      if (this._isShareEntry()) {
        this.list = []; this._loaded = true;
        const grid = document.getElementById("hub-grid"); if (grid) grid.innerHTML = "";
        const empty = document.getElementById("hub-empty"); if (empty) empty.classList.add("hidden");
        return;
      }
      // [마스터 핵심 워크플로 — 오프라인] 끊긴 상태면 서버 대신 다운로드한 번들(IndexedDB)에서
      //   프로젝트 목록을 복원한다. (폰에서 오프라인으로 앱을 열어도 받아둔 프로젝트가 보임)
      if (!navigator.onLine && typeof OfflineLoad !== "undefined") {
        try {
          this.list = (await OfflineLoad.projects()).filter(Boolean);
          this._offline = true;
          if (typeof Prompt !== "undefined" && Prompt.toast && this.list.length)
            Prompt.toast("오프라인 — 다운로드한 프로젝트 " + this.list.length + "개 표시");
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
        await this._resolveDeployLinks();
      } catch (e) {
        // 네트워크 실패/타임아웃 → 오프라인 번들로 폴백(있으면)
        try { this.list = (typeof OfflineLoad !== "undefined") ? (await OfflineLoad.projects()).filter(Boolean) : []; this._offline = true; }
        catch (e2) { this.list = []; }
      }
      this._loaded = true;
      this.render();
    },

    /** [WO 20260921 publish-fix] subdomain 없는 배포 프로젝트의 딥링크(?d=)를 미리 조회해 캐시.
     *  실패해도 카드 렌더 자체는 정상 진행 — 주소 행만 조용히 생략(카드 붕괴 금지). */
    async _resolveDeployLinks() {
      // [P61] share_path 가 있으면 그것이 정본 주소다 → 레거시 `?d=` 조회를 할 이유가 없다(요청 절약).
      const targets = (this.list || []).filter((p) => p.published && !p.share_path && !p.subdomain && this._deployLinkCache[p.id] === undefined);
      if (!targets.length) return;
      await Promise.all(targets.map(async (p) => {
        try {
          const r = await fetch("/api/projects/" + encodeURIComponent(p.id) + "/decks", { headers: Auth.headers() });
          if (!r.ok) { this._deployLinkCache[p.id] = null; return; }
          const { data } = await r.json();
          const withDep = (data || []).find((d) => d.deployment_id);
          this._deployLinkCache[p.id] = withDep ? withDep.deployment_id : null;
        } catch (e) { this._deployLinkCache[p.id] = null; }
      }));
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
        // is_member: 명시적으로 false = 비멤버(잠금), undefined/true = 멤버(정상)
        const isLocked = Auth.idToken && p.is_member === false;
        const isPending = isLocked && p.my_request === "pending";
        const card = document.createElement("div");
        card.className = "hub-card" + (isLocked ? " hub-card-locked" : "");
        card.setAttribute("role", "listitem");
        card.tabIndex = 0;
        const deckTxt = (p.deck_count != null) ? (p.deck_count + " DECKS") : "";
        const dateTxt = this._fmtDate(p.created_at);
        const code = "SS-" + String(Math.abs(this._hash(p.id || p.name)) % 9000 + 1000);
        // [WO 20260921 deploy-url] 배포된 프로젝트만 주소 노출 — SoT: p.published(배지와 동일 소스)
        const deployUrl = p.published ? this._deployUrl(p) : "";
        const lockOverlay = isLocked
          ? '<div class="hub-card-lock" aria-hidden="true">' +
              '<svg class="hub-lock-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="28" height="28"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>' +
              '<span class="hub-lock-txt">' + (isPending ? "⏳ 심사 중" : "접근 신청") + '</span>' +
            '</div>'
          : '';
        card.innerHTML =
          '<div class="hub-card-thumb">' +
            '<div class="hub-thumb-grid"></div>' +
            '<div class="hub-thumb-scan"></div>' +
            this._iconSvg(p) +
            '<span class="hub-thumb-code">' + code + '</span>' +
            lockOverlay +
          '</div>' +
          '<div class="hub-card-body">' +
            '<div class="hub-card-name">' + UI.escapeHtml(p.name) +
              (p.published ? ' <span class="hub-pub-badge" title="뷰어에게 배포됨">● 배포됨</span>' : '') +
            '</div>' +
            '<div class="hub-card-meta">' +
              (deckTxt ? '<span class="hub-card-decks">' + deckTxt + '</span>' : '') +
              (dateTxt ? '<span class="hub-card-date">' + dateTxt + '</span>' : '') +
              (isPending ? '<span class="hub-card-req-badge">⏳ 신청 접수됨</span>' : '') +
            '</div>' +
            (deployUrl
              ? '<div class="hub-card-url">' +
                  '<span class="hub-card-url-text" title="' + UI.escapeHtml(deployUrl) + '" data-act="url-toggle">' + UI.escapeHtml(deployUrl) + '</span>' +
                  '<button class="hub-card-url-copy" type="button" title="주소 복사" aria-label="주소 복사" data-act="url-copy">' +
                    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' +
                  '</button>' +
                  '<button class="hub-card-url-share" type="button" title="주소 공유" aria-label="주소 공유" data-act="url-share">' +
                    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>' +
                  '</button>' +
                '</div>'
              : (p.published
                  // [WO 20260921 publish-guard] 배포됨인데 링크가 없는 경우(도면 미등록 — 서버가 신규
                  // 배포는 막지만, 이 안내는 그 가드 이전에 이미 배포된 레거시 프로젝트도 함께 구제한다)
                  // → 조용히 비워두지 않고 이유를 표시(CLAUDE.md §5: 값이 없으면 없다고 정직하게 표시).
                  ? '<div class="hub-card-url-empty">⚠ 공유 링크 없음 — 도면(구역)을 등록해야 뷰어 주소가 생성됩니다.</div>'
                  : '')) +
          '</div>' +
          (isDesigner && !isLocked
            ? '<div class="hub-card-actions">' +
                '<button class="hub-card-act hub-card-pub' + (p.published ? ' is-pub' : '') + '" title="' + (p.published ? '배포됨 — 클릭 시 배포취소(뷰어 비공개)' : '뷰어에게 배포(공개)') + '" data-act="pub" aria-label="배포">' +
                  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>' +
                  '<span class="hub-card-act-label">배포</span>' +
                '</button>' +
                '<button class="hub-card-act hub-card-dl" title="오프라인 다운로드" data-act="dl" data-help="offline-download" aria-label="오프라인 다운로드">' +
                  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>' +
                  '<span class="hub-card-act-label" data-dl-label>다운로드</span>' +
                '</button>' +
                '<button class="hub-card-act hub-card-members" title="멤버 관리 — 이 프로젝트에 접근할 사용자 배정" data-act="members" aria-label="멤버 관리">' +
                  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>' +
                  '<span class="hub-card-act-label">멤버</span>' +
                '</button>' +
                '<button class="hub-card-act hub-card-del" title="삭제" data-act="del" aria-label="삭제">' +
                  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>' +
                  '<span class="hub-card-act-label">삭제</span>' +
                '</button>' +
              '</div>'
            : '');

        // 카드 클릭
        card.addEventListener("click", (e) => {
          if (e.target.closest("[data-act]")) return;
          if (isLocked) { this.openAccessReq(p); return; }
          this.openProject(p);
        });
        card.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (isLocked) { this.openAccessReq(p); return; }
            this.openProject(p);
          }
        });
        // 삭제 버튼
        const del = card.querySelector('[data-act="del"]');
        if (del) del.addEventListener("click", (e) => { e.stopPropagation(); this.deleteProject(p); });

        // [오프라인 작업지시서 ] 오프라인 다운로드 버튼 — 실 로직은 downloadProject() 정본(SoT)
        const dl = card.querySelector('[data-act="dl"]');
        if (dl) dl.addEventListener("click", (e) => { e.stopPropagation(); this.downloadProject(p, dl); });
        // 카드가 화면에 그려질 때마다 "이미 오프라인 저장돼 있는지" 표시 —
        // 눌러봐야 아는 게 아니라 항상 보이게(마스터 지시: 상태는 보여야 한다)
        if (dl) this._refreshDlState(dl, p.id);

        // 배포(Publish) 버튼 — 설계자가 프로젝트를 뷰어에게 공개/비공개 토글
        const pub = card.querySelector('[data-act="pub"]');
        if (pub) pub.addEventListener("click", (e) => { e.stopPropagation(); this.togglePublish(p, pub); });

        // [P3] 멤버 관리 버튼 — 이 프로젝트에 접근할 사용자 배정
        const mem = card.querySelector('[data-act="members"]');
        if (mem) mem.addEventListener("click", (e) => { e.stopPropagation(); this.openMembers(p); });

        // [WO 20260921 deploy-url] 배포 주소 — 복사/공유/탭하면 펼침
        const urlCopy = card.querySelector('[data-act="url-copy"]');
        if (urlCopy) urlCopy.addEventListener("click", (e) => { e.stopPropagation(); this._copyDeployUrl(deployUrl); });
        const urlShare = card.querySelector('[data-act="url-share"]');
        if (urlShare) urlShare.addEventListener("click", (e) => { e.stopPropagation(); this._shareDeployUrl(deployUrl, p.name); });
        const urlText = card.querySelector('[data-act="url-toggle"]');
        if (urlText) urlText.addEventListener("click", (e) => { e.stopPropagation(); urlText.classList.toggle("is-expanded"); });

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

    /** 프로젝트 진입: Auth.isDesigner 자동판정으로 조용히 결정하지 않고,
     *  항상 "디자이너로 열기"/"뷰어로 열기" 선택 모달을 띄워 사용자가 직접 고른다.
     *  (AUTO_DESIGNER_ENTRY로 자동입장한 경우에도 이 선택 단계는 건너뛰지 않는다.) */
    async openProject(p) {
      // 선택 프로젝트를 Projects 모듈과 공유 (작업화면 사이드바 동기화용)
      Projects.list = this.list;
      Projects.currentProject = p;
      State.currentProjectId = p.id;
      State.currentProjectName = p.name;
      // [P40] 우상단 배지를 "이 프로젝트에서의 내 역할"로 — 고정 '디자이너' 표기 제거
      if (typeof Auth !== "undefined" && Auth.setProjectContext) Auth.setProjectContext(p);
      this._modeSelectProject = p;
      if (!ASK_ENTRY_MODE) { // 스위치 OFF: 묻지 않고 무조건 편집모드로 바로 진입
        await this._enterAsDesigner();
        return;
      }
      const m = document.getElementById("proj-mode-select-modal");
      if (!m) { // 모달 마크업이 없으면(구버전) 안전 폴백 — 기존 자동판정 동작 유지
        if (Auth.isDesigner) App.openApp(PinSeries.preferredMode(), { project: p });
        else App.openApp("viewer", { project: p });
        return;
      }
      const nm = document.getElementById("pms-proj-name"); if (nm) nm.textContent = p.name || p.id;
      m.classList.remove("hidden"); requestAnimationFrame(() => m.classList.add("on"));
    },
    closeModeSelect() {
      const m = document.getElementById("proj-mode-select-modal");
      if (!m) return; m.classList.remove("on"); setTimeout(() => m.classList.add("hidden"), 200);
    },
    async _enterAsDesigner() {
      const p = this._modeSelectProject; if (!p) return;
      this.closeModeSelect();
      // 회귀 방지: 설계자 토큰이 있는데 권한 확인(refresh)이 아직 끝나지 않아
      //   isDesigner가 false인 채로 진입하면 "PDF 업로드가 안 된다"는 회귀 느낌을 준다.
      //   토큰이 있으면 권한 재확인을 한 번 await 한 뒤 게이트를 판단한다.
      if (!Auth.isDesigner && Auth.idToken) {
        try { await Auth.refresh(); } catch (e) {}
      }
      // AUTO_DESIGNER_ENTRY 등으로 이미 디자이너 권한이 있으면 게이트 없이 바로 진입,
      //   없으면 기존 로그인 게이트 경로(Auth.requireDesigner) 유지.
      // [마스터 요청 2026-09-18] 편집 진입 기본 모드 = 체크보드(사용자 전환 시 유지)
      if (Auth.isDesigner) App.openApp(PinSeries.preferredMode(), { project: p });
      else Auth.requireDesigner(() => App.openApp(PinSeries.preferredMode(), { project: p }));
    },
    _enterAsViewer() {
      const p = this._modeSelectProject; if (!p) return;
      this.closeModeSelect();
      // 뷰어는 로그인 불필요 — 기존 동작 유지
      App.openApp("viewer", { project: p });
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

    /** [WO 20260918] 🔴 오프라인 다운로드 실행 정본(SoT) — 허브 카드 버튼과 프로젝트 안
     *  진입점(#btn-project-download, 31_Projects.js)이 이 함수 하나만 호출한다(새 함수 금지,
     *  로직 복제 금지). btnEl 은 선택적 — 넘기면 진행 중 disabled/라벨/제목을 갱신한다.
     *  @param {object} p 프로젝트({id,name})
     *  @param {HTMLElement} [btnEl] 눌린 버튼(진행 표시용, 없어도 동작) */
    async downloadProject(p, btnEl) {
      if (!p || !p.id) return;
      if (typeof OfflineBundle === "undefined") { Prompt.toast("오프라인 모듈 미로드"); return; }
      const orig = btnEl ? btnEl.innerHTML : null;
      if (btnEl) { btnEl.disabled = true; btnEl.classList.add("busy"); }
      try {
        const m = await OfflineBundle.download(p.id, (done, total, label) => {
          if (btnEl) btnEl.setAttribute("title", "다운로드 " + done + "/" + total + " · " + label);
        });
        const v = await OfflineBundle.verify(p.id);
        if (v.ok) Prompt.toast("오프라인 준비 완료 — 도면 " + m.deployments + "개 · 3D " + m.panos + "개");
        else Prompt.toast("일부 누락: " + (v.missing || []).length + "건 — 다시 시도하세요");
      } catch (err) { Prompt.toast("" + (err && err.message ? err.message : "다운로드 실패")); }
      finally {
        if (btnEl) { btnEl.disabled = false; btnEl.classList.remove("busy"); if (orig != null) btnEl.innerHTML = orig; }
        if (btnEl) this._refreshDlState(btnEl, p.id);
      }
    },

    /** 오프라인 다운로드 버튼 상태 갱신 — 기존 OfflineBundle.verify() 재사용(SoT).
     *  눌러야만 알 수 있는 상태를 없애기 위해 카드 렌더 시점 + 다운로드 직후 모두 호출한다. */
    async _refreshDlState(dl, projectId) {
      if (!dl || typeof OfflineBundle === "undefined" || !OfflineBundle.verify) return;
      try {
        const v = await OfflineBundle.verify(projectId);
        const label = dl.querySelector("[data-dl-label]");
        if (v && v.ok) {
          dl.classList.add("is-dl-done");
          if (label) label.textContent = "저장됨";
          dl.setAttribute("title", "오프라인 저장됨 — 다시 눌러 최신화");
        } else {
          dl.classList.remove("is-dl-done");
          if (label) label.textContent = "다운로드";
          dl.setAttribute("title", "오프라인 다운로드");
        }
      } catch (e) {}
    },

    /** 프로젝트 배포(Publish) 토글 — 배포하면 권한받은 뷰어가 열람 가능, 배포취소하면 뷰어에게 숨김 */
    async togglePublish(p, btn) {
      if (!Auth.isDesigner) { Auth.requireDesigner(() => this.togglePublish(p)); return; }
      const willPublish = !p.published;
      // [WO 20260921 publish-fix] window.confirm() → Prompt.confirm() (SoT: 30_Prompt.js).
      //  근본원인: PWA 독립실행모드에서 window.confirm()이 무음으로 false를 반환해 배포 버튼이
      //  아무 요청도 보내지 않았다(재현: 네트워크 0건·토스트 0건·콘솔오류 없음). 커스텀 DOM 모달은
      //  이 제약이 없다.
      const proceed = willPublish
        ? await Prompt.confirm("배포", "'" + p.name + "' 프로젝트를 뷰어에게 배포할까요?\n\n배포하면 이 프로젝트에 권한이 부여된 뷰어가 열람할 수 있습니다.")
        : await Prompt.confirm("배포 취소", "'" + p.name + "' 배포를 취소할까요?\n\n뷰어에게 더 이상 보이지 않게 됩니다.");
      if (!proceed) return;
      if (btn) { btn.disabled = true; btn.classList.add("busy"); }
      try {
        const r = await fetch("/api/projects/" + p.id + "/" + (willPublish ? "publish" : "unpublish"), { method: "POST", headers: Auth.headers() });
        if (!r.ok) {
          // [WO 20260921 publish-guard] 서버가 거부 사유(예: 도면 미등록)를 error 필드로 보낸다 —
          // 그대로 사용자에게 노출한다("HTTP 400" 같은 무의미한 코드로 뭉개지 않는다, 조용한 실패 금지).
          let msg = "HTTP " + r.status;
          try { const j = await r.json(); if (j && j.error) msg = j.error; } catch (e) {}
          throw new Error(msg);
        }
        p.published = willPublish;
        Prompt && Prompt.toast && Prompt.toast(willPublish ? "'" + p.name + "' 배포 완료 — 뷰어가 열람할 수 있습니다." : "'" + p.name + "' 배포 취소 — 뷰어에게 비공개.", 2800);
        await this.load();
      } catch (e) {
        Prompt && Prompt.toast && Prompt.toast("배포 처리 실패: " + (e && e.message ? e.message : "네트워크 오류"), 3200);
      } finally { if (btn) { btn.disabled = false; btn.classList.remove("busy"); } }
    },

    /** [WO 20260921 deploy-url, 수정 publish-fix] 배포된 프로젝트를 "식별하는" 뷰어 주소 —
     *  SoT: p.subdomain(실 DB 값) 우선, 없으면 _deployLinkCache(실 deployment_id, /api/projects/:id/decks
     *  에서 조회)로 만든 뷰어 딥링크(?d=). 현재 접속 호스트에서만 파생한다(도메인 하드코딩 금지).
     *  🔴 사이트 루트 폴백 금지 — 루트 주소는 프로젝트를 식별하지 못해 공유해도 쓸모가 없다.
     *  둘 다 없으면(도면 미등록) 빈 문자열 반환 → 카드에 주소 행 자체가 생기지 않는다(거짓 주소보다 낫다). */
    /** [P63] 공유·배포 링크로 들어온 진입인가 — 허브를 그리면 안 되는 상황의 단일 판정원.
     *  🔴 라이브에서 실측: 초대코드 모달 뒤로 **다른 프로젝트 이름들이 그대로 비쳤다.**
     *  그러면 "다른 프로젝트를 유추할 수 없도록"(마스터 2026-09-18) 요구가 깨진다.
     *  ⚠️ 이 헬퍼를 open() 과 load() **사이**에 두지 마라 — p24 가 그 두 함수의 인접성을 기준으로
     *     open() 본문을 잘라낸다(실제로 한 번 깨뜨렸다). URL 파생이라 _deployUrl 옆이 제자리다. */
    _isShareEntry() {
      try {
        if (typeof ShareLink !== "undefined" && ShareLink.token()) return true;
        return !!new URLSearchParams(location.search).get("d");
      } catch (e) { return false; }
    },

    _deployUrl(p) {
      if (!p) return "";
      const loc = (typeof location !== "undefined") ? location : { hostname: "", protocol: "https:", origin: "" };
      const host = loc.hostname || "";
      const parts = host.split(".");
      const base = parts.length >= 2 ? parts.slice(-2).join(".") : host;
      const origin0 = loc.origin || (loc.protocol + "//" + host);
      // [P61] 🔴 1순위 = 공유 주소 `/srview/<프로젝트명>-<토큰>`.
      //   경로 문자열은 **서버가** projects.name 에서 파생해 내려준다(share_path) — 클라가 슬러그 규칙을
      //   다시 구현하면 SoT 가 둘로 갈라진다. 여기서는 접속 origin 만 붙인다(도메인 하드코딩 0).
      if (p.share_path) {
        // 화면/복사는 **사람이 읽는 형태**로. 서버는 퍼센트인코딩된 정본을 주지만, 마스터 요구는
        // "고객이 봐도 알 수 있게" 다 → 한글을 디코드해 보여준다(브라우저·메신저가 붙여넣기 시 재인코딩).
        // 슬러그 문자집합에 공백·`/`·`?` 가 없으므로 디코드해도 링크가 끊기지 않는다.
        let sp = p.share_path;
        try { sp = decodeURIComponent(sp); } catch (e) {}
        return origin0 + sp;
      }
      if (p.subdomain) return loc.protocol + "//" + p.subdomain + "." + base;
      const depId = this._deployLinkCache[p.id];
      if (depId) {
        const origin = loc.origin || (loc.protocol + "//" + host);
        return origin + "/?d=" + encodeURIComponent(depId);
      }
      return "";
    },
    /* ══ [P63] 뷰어 초대코드 관리 — 유출 대응 3종(폐기·만료·기록)의 UI 측 ══
     * 마스터 "그런데 그 링크가 유출된다면?" → 링크만 샐다면 코드에서 막히고,
     * 코드까지 샐다면 **즉시 폐기**한다. 그래서 폐기 버튼은 목록 모든 행에 있다. */
    async loadShareCodes() {
      const box = document.getElementById("pm-code-list");
      if (!box || !this._memProject) return;
      box.innerHTML = "";
      try {
        const r = await fetch("/api/projects/" + encodeURIComponent(this._memProject.id) + "/share-codes", { headers: Auth.headers() });
        if (!r.ok) { box.innerHTML = '<div class="pm-sub-hint">코드 목록을 불러오지 못했습니다.</div>'; return; }
        const { data } = await r.json();
        this._renderShareCodes(data || []);
      } catch (e) {
        box.innerHTML = '<div class="pm-sub-hint">코드 목록을 불러오지 못했습니다(오프라인).</div>';
      }
    },
    _renderShareCodes(list) {
      const box = document.getElementById("pm-code-list");
      if (!box) return;
      if (!list.length) {
        // 🔴 코드가 하나도 없으면 게이트가 꺼져 있다 — 그 사실을 숨기지 않는다.
        box.innerHTML = '<div class="pm-sub-hint">⚠ 발급된 코드가 없습니다 — 지금은 <b>링크를 가진 누구나</b> 열람합니다. 코드를 1개 발급하면 즉시 잠꺑니다.</div>';
        return;
      }
      box.innerHTML = "";
      list.forEach((c) => {
        const row = document.createElement("div");
        row.className = "member-row";
        const state = c.revoked ? "🚫 폐기됨" : (c.active ? "● 사용가능" : "⏱ 만료됨");
        const exp = c.expires_at ? this._fmtDate(c.expires_at) + " 만료" : "무기한";
        const used = (c.use_count || 0) + "회" + (c.last_used_at ? (" · 최근 " + this._fmtDate(c.last_used_at)) : "");
        row.innerHTML =
          '<div class="member-info"><span class="member-email">' + UI.escapeHtml(c.label) + '</span>' +
          '<span class="member-role">' + state + ' · ' + UI.escapeHtml(String(c.code_hint || "")) + '… · ' + exp + ' · ' + used + '</span></div>';
        if (!c.revoked) {
          const btn = document.createElement("button");
          btn.className = "member-del"; btn.type = "button"; btn.title = "코드 폐기(즉시 차단)";
          btn.textContent = "폐기";
          btn.addEventListener("click", () => this.revokeShareCode(c.id, c.label));
          row.appendChild(btn);
        }
        box.appendChild(row);
      });
    },
    async createShareCode() {
      const errEl = document.getElementById("pm-code-error");
      const show = (m) => { if (errEl) { errEl.textContent = m; errEl.classList.remove("hidden"); } };
      if (errEl) errEl.classList.add("hidden");
      if (!this._memProject) return;
      const label = (document.getElementById("pm-code-label") || {}).value || "";
      const ttl = (document.getElementById("pm-code-ttl") || {}).value || "";
      if (!label.trim()) { show("발급 단위 이름을 적으세요 — 유출 시 이 단위로 폐기합니다."); return; }
      try {
        const r = await fetch("/api/projects/" + encodeURIComponent(this._memProject.id) + "/share-codes", {
          method: "POST", headers: Auth.headers(),
          body: JSON.stringify({ label: label.trim(), ttl_days: ttl ? Number(ttl) : undefined })
        });
        const j = await r.json().catch(() => null);
        if (!r.ok || !j || !j.code) { show((j && j.error) || "코드 발급에 실패했습니다."); return; }
        const box = document.getElementById("pm-code-new-box");
        const out = document.getElementById("pm-code-new");
        if (out) out.value = j.code;            // 🔴 원문은 이 순간에만 존재한다(DB 는 해시만 보관)
        if (box) box.classList.remove("hidden");
        const lbl = document.getElementById("pm-code-label"); if (lbl) lbl.value = "";
        Prompt && Prompt.toast && Prompt.toast("초대코드를 발급했습니다 — 지금 복사해 전달하세요.", 3200);
        await this.loadShareCodes();
      } catch (e) { show("네트워크 오류입니다."); }
    },
    async revokeShareCode(id, label) {
      const ok = await Prompt.confirm("코드 폐기", "'" + label + "' 코드를 폐기할까요?\n\n이 코드로 들어오던 사람은 즉시 막힘니다(이미 통과한 세션도 만료 시 재입력 필요).");
      if (!ok) return;
      try {
        const r = await fetch("/api/share-codes/" + encodeURIComponent(id) + "/revoke", { method: "POST", headers: Auth.headers(), body: "{}" });
        if (!r.ok) { Prompt && Prompt.toast && Prompt.toast("폐기에 실패했습니다."); return; }
        Prompt && Prompt.toast && Prompt.toast("코드를 폐기했습니다.");
        await this.loadShareCodes();
      } catch (e) { Prompt && Prompt.toast && Prompt.toast("네트워크 오류입니다."); }
    },

    /** 배포 주소 복사 — _copyInviteLink 와 동일한 클립보드 우선순위(SoT), 복사 후 알림 필수(조용한 실패 금지). */
    _copyDeployUrl(url) {
      if (!url) return;
      const done = () => { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("주소를 복사했습니다."); };
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(url).then(done).catch(() => this._copyDeployUrlFallback(url, done)); return; }
      } catch (e) {}
      this._copyDeployUrlFallback(url, done);
    },
    _copyDeployUrlFallback(url, done) {
      try {
        const ta = document.createElement("textarea");
        ta.value = url; ta.setAttribute("readonly", "");
        ta.style.position = "fixed"; ta.style.top = "-9999px"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.focus(); ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        done();
      } catch (e) {}
    },
    /** 배포 주소 공유 — _shareInviteLink 와 동일한 패턴(navigator.share + 복사 폴백).
     *  AbortError(사용자가 공유시트를 취소) 는 정상 동작 — 오류 알림 금지. */
    _shareDeployUrl(url, projectName) {
      if (!url) return;
      if (!navigator.share) { this._copyDeployUrl(url); return; }
      const name = projectName || "프로젝트"; // SoT: 실제 프로젝트 값에서만 가져온다(하드코딩 금지)
      navigator.share({ title: "SEASTAR 360 뷰어 주소", text: '"' + name + '" 프로젝트 뷰어 주소', url: url })
        .catch((e) => {
          if (e && e.name === "AbortError") return; // 사용자가 공유시트를 취소 — 정상 동작, 오류 알림 금지
          if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("공유 실패: " + (e && e.message ? e.message : "알 수 없는 오류"));
        });
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