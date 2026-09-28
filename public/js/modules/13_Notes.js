  const Notes = {
    _pin: null,          // 현재 패널의 핀 객체
    _list: [],           // 현재 핀의 노트 배열
    _filter: "all",
    _busy: false,
    _gen: 0,             // [오프라인 노트 영속화] 로드 세대 카운터 — 늦게 끝난 비동기 결과가 최신 상태를 덮어쓰지 못하게 막는 가드
    STATUS: { open: "미해결", progress: "진행중", done: "완료" },

    /** [오프라인 노트] 클라 임시 id — 서버 반영 후 noteIdMap 으로 실제 id 로 치환됨(applyIdMap) */
    _tmpId() { return "tmp-note-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8); },

    /** [오프라인 노트 영속화] 핀별 노트 스냅샷 키 — 32_Offline.js 의 bundle:dep:* 와 같은
     *  SyncQueue.DRAFT_STORE(IndexedDB) 에 얹는다(새 저장소 신설 안 함, §5 사다리). */
    _snapKey(dep, pinId) { return "notes:" + dep + ":" + pinId; },

    /** [오프라인 노트 영속화] 현재 핀의 _list 스냅샷을 로컬에 즉시 저장.
     *  [④ 덮어쓰기 가드] 기존 스냅샷보다 ts 가 더 오래된 저장 시도는 무시 —
     *  느리게 끝난 오프라인 저장이 방금 끝난 서버 동기화 결과를 덮어쓰는 사고 방지. */
    async _saveSnapshot(list, ts, pinOverride) {
      if (typeof SyncQueue === "undefined" || !SyncQueue.saveDraft) return false;
      const dep = (typeof State !== "undefined") && State.currentDeploymentId;
      const pin = pinOverride || this._pin;
      if (!dep || !pin) return false;
      const key = this._snapKey(dep, pin.id);
      ts = ts || Date.now();
      try {
        const existing = SyncQueue.loadDraft ? await SyncQueue.loadDraft(key) : null;
        if (existing && typeof existing.ts === "number" && ts < existing.ts) return false; // 스냅샷 덮어쓰기 가드
        const saved = await SyncQueue.saveDraft(key, { list: list, ts: ts });
        if (saved === false) {
          // [무신호 손실 차단] 05_SyncQueue.js:132 와 동일한 안내 문구/경로 재사용 — 새 알림 신설 안 함.
          try { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("오프라인 저장 실패 — 기기 저장공간 부족"); } catch (e) {}
          return false;
        }
        return true;
      } catch (e) { return false; }
    },

    /** [오프라인 노트 영속화] 로컬 스냅샷에서 복원. myGen 이 넘어오면, 그 사이 새 loadForPin() 이
     *  시작돼 세대가 바뀐 경우 이 결과는 폐기한다(늦게 끝난 복원이 최신 상태를 덮어쓰지 않도록). */
    async _restoreFromSnapshot(dep, pinId, myGen) {
      if (typeof SyncQueue === "undefined" || !SyncQueue.loadDraft) return;
      try {
        const rec = await SyncQueue.loadDraft(this._snapKey(dep, pinId));
        if (myGen != null && myGen !== this._gen) return; // 세대 불일치 — 폐기
        if (rec && Array.isArray(rec.list)) this._list = rec.list;
      } catch (e) {}
    },

    /** [오프라인 노트] 온라인 복귀 시 App._flushOpLogs()가 서버 응답의 noteIdMap 을 받아 호출.
     *  this._list 안의 임시 id를 실제 id 로 갈아끼워 화면 참조(상태변경/삭제 버튼의 data-id 등)를 유지한다. */
    applyIdMap(map) {
      if (!map) return;
      let changed = false;
      (this._list || []).forEach((n) => {
        if (n && map[n.id]) { n.id = map[n.id]; changed = true; }
      });
      if (changed) {
        this.render();
        try { this._saveSnapshot(this._list, Date.now()); } catch (e) {} // 서버 확정 id 로 스냅샷도 갱신(§ 스냅샷은 서버가 SoT)
      }
    },

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
        const r = await fetch("/api/notes/summary?deployment_id=" + encodeURIComponent(dep), { headers: Auth.headers() });
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
      var _np = document.getElementById("pano-notes-panel");
      if (_np && !_np.classList.contains("hidden")) this.loadForPin();
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
      const myGen = ++this._gen;
      // [오프라인 노트 영속화] 오프라인이면 서버 호출을 시도하지 않고 로컬 스냅샷으로 즉시 복원.
      //   (기존 코드는 오프라인에도 fetch 를 시도해 실패 후 this._list = [] 로 비워버려
      //    새로고침/재진입 시 방금 작성한 오프라인 노트가 화면에서 사라졌다.)
      if (!navigator.onLine) {
        await this._restoreFromSnapshot(dep, pin.id, myGen);
        if (myGen === this._gen) this.render();
        return;
      }
      if (listEl) listEl.innerHTML = '<div class="pnp-loading">불러오는 중…</div>';
      try {
        const r = await fetch("/api/notes?deployment_id=" + encodeURIComponent(dep) + "&pin_id=" + encodeURIComponent(pin.id), { headers: Auth.headers() });
        const j = await r.json();
        if (myGen !== this._gen) return; // 그 사이 새 로드가 시작됨 — 이 결과는 폐기
        this._list = j.data || [];
        await this._saveSnapshot(this._list, Date.now()); // 서버가 SoT — 로컬 스냅샷을 최신으로 갱신
      } catch (e) {
        if (myGen !== this._gen) return;
        await this._restoreFromSnapshot(dep, pin.id, myGen); // 순간 네트워크 실패 → 로컬 스냅샷 폴백
      }
      this.render();
    },

    render() {
      const listEl = document.getElementById("pnp-list");
      const emptyEl = document.getElementById("pnp-empty");
      if (!listEl) return;
      // [마스터] 필터 탭에 상태별 카운트 표시 (전체/미해결/진행중/완료 N)
      const counts = { all: this._list.length, open: 0, progress: 0, done: 0 };
      this._list.forEach((n) => { const s = n.status || "open"; if (counts[s] != null) counts[s]++; });
      document.querySelectorAll("#pnp-filter .pnp-fbtn").forEach((b) => {
        const base = { all: "전체", open: "미해결", progress: "진행중", done: "완료" }[b.dataset.f] || b.dataset.f;
        const c = counts[b.dataset.f] || 0;
        b.textContent = c > 0 ? base + " " + c : base;
      });
      // [마스터] 최신순 정렬(최근 이슈가 위로)
      const ts = (v) => (typeof v === "number") ? v : (Date.parse(v) || 0);
      let items = this._list.slice().sort((a, b) => ts(b.created_at) - ts(a.created_at));
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
        const assignee = n.assignee ? `<span class="pnp-assignee-tag">${UI.escapeHtml(n.assignee)}</span>` : "";
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
      // [오프라인 노트] pin/zone/anno 와 같은 OpLog 경로에 편입 — 새 큐 만들지 않음(§편입)
      if (!navigator.onLine && typeof OpLog !== "undefined" && OpLog.recordCurrent) {
        const now = Date.now();
        const noteObj = {
          id: this._tmpId(), deployment_id: dep, pin_id: pin.id, pin_label: pin.label || "",
          body, status, assignee, author: author || (Auth && Auth.user && Auth.user.name) || "익명",
          author_email: (Auth && Auth.user && Auth.user.email) || null,
          author_role: (Auth && Auth.isDesigner) ? "designer" : "guest",
          created_at: now, updated_at: now, resolved_at: status === "done" ? now : null,
        };
        this._list.push(noteObj);
        try {
          await OpLog.recordCurrent("note", "upsert", noteObj.id, noteObj);
          await this._saveSnapshot(this._list, now); // [오프라인 노트 영속화] 즉시 로컬 스냅샷(재시작 유실 방지)
          input.value = "";
          if (document.getElementById("pnp-assignee")) document.getElementById("pnp-assignee").value = "";
          this.render();
        } catch (e) {}
        this._busy = false;
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "등록"; }
        return;
      }
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
      if (!navigator.onLine && typeof OpLog !== "undefined" && OpLog.recordCurrent) {
        const n = (this._list || []).find((x) => x.id === id);
        if (!n) return;
        n.status = status;
        n.updated_at = Date.now();
        n.resolved_at = status === "done" ? n.updated_at : null;
        try { await OpLog.recordCurrent("note", "upsert", id, n); await this._saveSnapshot(this._list, n.updated_at); } catch (e) {}
        this.render();
        return;
      }
      try {
        const r = await fetch("/api/notes/" + encodeURIComponent(id), {
          method: "PATCH", headers: Auth.headers(),
          body: JSON.stringify({ status }),
        });
        if (r.ok) { await this.loadForPin(); await this.loadSummary(); }
      } catch (e) {}
    },

    async remove(id) {
      if (!await Prompt.confirm("노트 삭제", "이 이슈/노트를 삭제할까요?")) return;
      if (!navigator.onLine && typeof OpLog !== "undefined" && OpLog.recordCurrent) {
        this._list = (this._list || []).filter((x) => x.id !== id);
        try { await OpLog.recordCurrent("note", "delete", id); await this._saveSnapshot(this._list, Date.now()); } catch (e) {}
        this.render();
        return;
      }
      try {
        const r = await fetch("/api/notes/" + encodeURIComponent(id), {
          method: "DELETE", headers: Auth.headers(),
        });
        if (r.ok) { await this.loadForPin(); await this.loadSummary(); }
      } catch (e) {}
    },

    /** [핀 액션 패널 재사용] 컴팩트 노트 목록 — loadForPin() 이 채운 this._list 를
     *  그대로 그린다(별도 fetch 없음 · 같은 데이터 소스, §10 SoT). 상태 텍스트/정렬 기준도
     *  render()와 동일(this.STATUS, created_at 최신순). */
    renderCompact(containerId) {
      const el = document.getElementById(containerId);
      if (!el) return;
      const ts = (v) => (typeof v === "number") ? v : (Date.parse(v) || 0);
      const items = (this._list || []).slice().sort((a, b) => ts(b.created_at) - ts(a.created_at));
      if (!items.length) { el.innerHTML = '<div style="color:#94a3b8;">등록된 노트 없음</div>'; return; }
      el.innerHTML = items.map((n) => {
        const st = n.status || "open";
        const stLabel = this.STATUS[st] || st;
        return '<div style="padding:5px 0;border-bottom:1px solid rgba(0,0,0,.06);">' +
          '<span style="font-weight:700;color:#334155;">[' + UI.escapeHtml(stLabel) + ']</span> ' +
          '<span style="color:#0f172a;">' + UI.escapeHtml(n.body) + '</span></div>';
      }).join("");
    },

    /** [핀 액션 패널 재사용] 노트 1건 등록 — submit()과 같은 /api/notes 엔드포인트.
     *  성공 시 this._list 를 다시 로드(요약 뱃지도 함께 갱신)하고 true 를 돌려준다. */
    async submitCompact(pin, body) {
      const dep = (typeof State !== "undefined") && State.currentDeploymentId;
      const text = (body || "").trim();
      if (!dep || !pin || !text) return false;
      if (!navigator.onLine && typeof OpLog !== "undefined" && OpLog.recordCurrent) {
        const now = Date.now();
        const noteObj = {
          id: this._tmpId(), deployment_id: dep, pin_id: pin.id, pin_label: pin.label || "",
          body: text, status: "open", assignee: "",
          author: (typeof Auth !== "undefined" && Auth.user && Auth.user.name) || "익명",
          author_email: (typeof Auth !== "undefined" && Auth.user && Auth.user.email) || null,
          author_role: (typeof Auth !== "undefined" && Auth.isDesigner) ? "designer" : "guest",
          created_at: now, updated_at: now, resolved_at: null,
        };
        this._list.push(noteObj);
        try {
          await OpLog.recordCurrent("note", "upsert", noteObj.id, noteObj);
          await this._saveSnapshot(this._list, now, pin); // [오프라인 노트 영속화] pin 파라미터 기준(this._pin 과 다를 수 있음)
          return true;
        } catch (e) { return false; }
      }
      try {
        const r = await fetch("/api/notes", {
          method: "POST",
          headers: Auth.headers(),
          body: JSON.stringify({
            deployment_id: dep, pin_id: pin.id, pin_label: pin.label || "",
            body: text, status: "open", assignee: "",
            author: (typeof Auth !== "undefined" && Auth.user && Auth.user.name) || "",
          }),
        });
        if (!r.ok) return false;
        await this.loadForPin();
        await this.loadSummary();
        return true;
      } catch (e) { return false; }
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