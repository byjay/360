  const Notes = {
    _pin: null,          // 현재 패널의 핀 객체
    _list: [],           // 현재 핀의 노트 배열
    _filter: "all",
    _busy: false,
    STATUS: { open: "미해결", progress: "진행중", done: "완료" },

    init() {
      const $ = (id) => document.getElementById(id);
      $("btn-pano-notes") && $("btn-pano-notes").addEventListener("click", () => this.toggle());
      $("pnp-close") && $("pnp-close").addEventListener("click", () => this.closePanel());
      // 필터
      document.querySelectorAll("#pnp-filter .pnp-fbtn").forEach((b) => {
        b.addEventListener("click", () => {
          this._filter = b.dataset.f;
          document.querySelectorAll("#pnp-filter .pnp-fbtn").forEach((x) => x.classList.toggle("active", x === b));
          this.render();
        });
      });
      // 작성 폼
      const form = $("pnp-form");
      form && form.addEventListener("submit", (e) => { e.preventDefault(); this.submit(); });
    },

    /** 현재 배포의 핀별 노트 요약 로드 → 도면/리스트 뱃지 */
    async loadSummary() {
      const dep = State.currentDeploymentId;
      if (!dep) { State.noteSummary = {}; return; }
      try {
        const r = await fetch("/api/notes/summary?deployment_id=" + encodeURIComponent(dep));
        if (!r.ok) return;
        const j = await r.json();
        State.noteSummary = j.data || {};
      } catch (e) { State.noteSummary = {}; }
      // 뱃지 갱신
      if (typeof UI !== "undefined") { UI.renderPinList(); UI.renderPinsOnMap(); }
      this._syncHeaderCount();
    },

    /** 특정 핀의 미해결 카운트 (뱃지용) */
    openCountFor(pinId) {
      const s = State.noteSummary && State.noteSummary[pinId];
      if (!s) return 0;
      return (s.open || 0) + (s.progress || 0);
    },
    totalCountFor(pinId) {
      const s = State.noteSummary && State.noteSummary[pinId];
      return s ? (s.total || 0) : 0;
    },

    /** 파노라마 헤더 이슈 버튼의 현재 핀 카운트 */
    _syncHeaderCount() {
      const el = document.getElementById("pano-notes-count");
      if (!el) return;
      const pin = this._pin;
      const n = pin ? this.totalCountFor(pin.id) : 0;
      if (n > 0) { el.textContent = n; el.classList.remove("hidden"); }
      else el.classList.add("hidden");
    },

    /** 파노라마 열릴 때 현재 핀 지정 */
    setPin(pin) {
      this._pin = pin || null;
      const lbl = document.getElementById("pnp-pin-label");
      if (lbl) lbl.textContent = pin ? (pin.label || "이름 없는 위치") : "—";
      this._syncHeaderCount();
      // 패널이 열려 있으면 즉시 다시 로드
      if (!document.getElementById("pano-notes-panel").classList.contains("hidden")) this.loadForPin();
    },

    toggle() {
      const p = document.getElementById("pano-notes-panel");
      if (!p) return;
      if (p.classList.contains("hidden")) this.openPanel();
      else this.closePanel();
    },
    openPanel() {
      const p = document.getElementById("pano-notes-panel");
      if (!p || !this._pin) return;
      p.classList.remove("hidden");
      requestAnimationFrame(() => p.classList.add("on"));
      // 미로그인 작성자 입력 표시
      const ar = document.getElementById("pnp-author-row");
      if (ar) ar.classList.toggle("hidden", !!(Auth && Auth.user));
      this.loadForPin();
    },
    closePanel() {
      const p = document.getElementById("pano-notes-panel");
      if (!p) return;
      p.classList.remove("on");
      setTimeout(() => p.classList.add("hidden"), 200);
    },

    async loadForPin() {
      const dep = State.currentDeploymentId;
      const pin = this._pin;
      const listEl = document.getElementById("pnp-list");
      if (!dep || !pin) { if (listEl) listEl.innerHTML = ""; return; }
      if (listEl) listEl.innerHTML = '<div class="pnp-loading">불러오는 중…</div>';
      try {
        const r = await fetch("/api/notes?deployment_id=" + encodeURIComponent(dep) + "&pin_id=" + encodeURIComponent(pin.id));
        const j = await r.json();
        this._list = j.data || [];
      } catch (e) { this._list = []; }
      this.render();
    },

    render() {
      const listEl = document.getElementById("pnp-list");
      const emptyEl = document.getElementById("pnp-empty");
      if (!listEl) return;
      let items = this._list;
      if (this._filter !== "all") items = items.filter((n) => n.status === this._filter);
      if (items.length === 0) {
        listEl.innerHTML = "";
        emptyEl && emptyEl.classList.remove("hidden");
        this._syncHeaderCount();
        return;
      }
      emptyEl && emptyEl.classList.add("hidden");
      const canEdit = (n) => {
        if (!Auth) return false;
        if (Auth.isDesigner) return true;
        return n.author_email && Auth.user && n.author_email === Auth.user.email;
      };
      listEl.innerHTML = items.map((n) => {
        const st = n.status || "open";
        const stLabel = this.STATUS[st] || st;
        const assignee = n.assignee ? `<span class="pnp-assignee-tag">👤 ${UI.escapeHtml(n.assignee)}</span>` : "";
        const editable = canEdit(n);
        const stBtns = editable ? `
          <div class="pnp-status-actions">
            ${["open","progress","done"].map((s) =>
              `<button class="pnp-st-btn ${s} ${s===st?'active':''}" data-act="status" data-id="${n.id}" data-status="${s}">${this.STATUS[s]}</button>`
            ).join("")}
            <button class="pnp-del" data-act="del" data-id="${n.id}" title="삭제">✕</button>
          </div>` : "";
        return `
          <article class="pnp-item st-${st}" data-id="${n.id}">
            <div class="pnp-item-head">
              <span class="pnp-badge st-${st}">${stLabel}</span>
              <span class="pnp-author">${UI.escapeHtml(n.author || "익명")}</span>
              ${assignee}
              <span class="pnp-time">${this._timeAgo(n.created_at)}</span>
            </div>
            <div class="pnp-body">${UI.escapeHtml(n.body)}</div>
            ${stBtns}
          </article>`;
      }).join("");
      // 이벤트 위임
      listEl.querySelectorAll('[data-act="status"]').forEach((b) => {
        b.addEventListener("click", () => this.updateStatus(b.dataset.id, b.dataset.status));
      });
      listEl.querySelectorAll('[data-act="del"]').forEach((b) => {
        b.addEventListener("click", () => this.remove(b.dataset.id));
      });
      this._syncHeaderCount();
    },

    async submit() {
      if (this._busy) return;
      const dep = State.currentDeploymentId;
      const pin = this._pin;
      if (!dep || !pin) return;
      const input = document.getElementById("pnp-input");
      const body = (input.value || "").trim();
      if (!body) { input.focus(); return; }
      const status = (document.getElementById("pnp-status-sel") || {}).value || "open";
      const assignee = (document.getElementById("pnp-assignee") || {}).value || "";
      const author = (document.getElementById("pnp-author") || {}).value || "";
      this._busy = true;
      const submitBtn = document.getElementById("pnp-submit");
      if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "등록 중…"; }
      try {
        const r = await fetch("/api/notes", {
          method: "POST",
          headers: Auth.headers(),
          body: JSON.stringify({
            deployment_id: dep, pin_id: pin.id, pin_label: pin.label || "",
            body, status, assignee, author,
          }),
        });
        if (r.ok) {
          input.value = "";
          if (document.getElementById("pnp-assignee")) document.getElementById("pnp-assignee").value = "";
          await this.loadForPin();
          await this.loadSummary();
        }
      } catch (e) {}
      this._busy = false;
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "등록"; }
    },

    async updateStatus(id, status) {
      try {
        const r = await fetch("/api/notes/" + encodeURIComponent(id), {
          method: "PATCH", headers: Auth.headers(),
          body: JSON.stringify({ status }),
        });
        if (r.ok) { await this.loadForPin(); await this.loadSummary(); }
      } catch (e) {}
    },

    async remove(id) {
      if (!confirm("이 이슈/노트를 삭제할까요?")) return;
      try {
        const r = await fetch("/api/notes/" + encodeURIComponent(id), {
          method: "DELETE", headers: Auth.headers(),
        });
        if (r.ok) { await this.loadForPin(); await this.loadSummary(); }
      } catch (e) {}
    },

    _timeAgo(v) {
      const n = (typeof v === "number") ? v : Date.parse(v);
      if (!Number.isFinite(n)) return "";
      const diff = Date.now() - n;
      const m = Math.floor(diff / 60000);
      if (m < 1) return "방금";
      if (m < 60) return m + "분 전";
      const h = Math.floor(m / 60);
      if (h < 24) return h + "시간 전";
      const d = new Date(n);
      const p = (x) => String(x).padStart(2, "0");
      return (d.getMonth() + 1) + "." + p(d.getDate());
    },
  };

  /* ══════════════════════════════════════════
     TIMELAPSE ── 같은 위치의 시점별(전/후) 파노라마 비교
        · 핀.timeline[] = [{id,label,imageId|imageUrl,isVideo,capturedAt}]
        · timeline 없으면 현재 단일 파노라마를 1개 시점으로 취급
        · 시점 전환 시 카메라 각도(lon/lat/fov) 유지 → 정확한 전/후 비교
        · 분할비교: 좌=선택 시점, 우=최신, 슬라이더로 경계 이동
  ══════════════════════════════════════════ */