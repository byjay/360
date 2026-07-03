  const Projects = {
    list: [],
    decks: [],
    currentProject: null,
    currentDeck: null,

    init() {
      const $ = (id) => document.getElementById(id);
      $("btn-new-project") && $("btn-new-project").addEventListener("click", () => this.createProject());
      $("btn-delete-project") && $("btn-delete-project").addEventListener("click", () => this.deleteProject());
      $("btn-new-deck") && $("btn-new-deck").addEventListener("click", () => this.createDeck());
      // #1: 프로젝트 드롭다운 '이동(전환)' 기능 제거 — select 대신 현재 프로젝트명만 표시.
    },

    /** 디자이너 진입 시 호출 */
    async load() {
      try {
        // [버그수정] 인증헤더 필수 — /api/projects 는 멤버십/배포 스코프 필터(미전송=익명→누락)
        const r = await fetch("/api/projects", { headers: Auth.headers() });
        const { data } = await r.json();
        this.list = data || [];
      } catch (e) { this.list = []; }
      this._renderSelect();
    },

    _renderSelect() {
      // #1: 드롭다운 전환 제거 → 현재 프로젝트명 라벨만 갱신.
      const cur = document.getElementById("project-current");
      const has = !!this.currentProject;
      if (cur) cur.textContent = has ? this.currentProject.name : "— 프로젝트 선택 —";
      const pa = document.getElementById("project-actions");
      if (pa) pa.classList.toggle("hidden", !has);
      const db = document.getElementById("decks-block");
      if (db) db.classList.toggle("hidden", !has);
    },

    async createProject() {
      if (!Auth.isDesigner) return;
      const res = await Prompt.ask({ title: "프로젝트 생성", sub: "새 프로젝트 이름을 입력하세요 (예: ○○호 검사)", placeholder: "프로젝트 이름" });
      if (!res) return;
      try {
        const r = await fetch("/api/projects", { method: "POST", headers: Auth.headers(), body: JSON.stringify({ name: res.value }) });
        const p = await r.json();
        if (!r.ok) { alert(p.error || "생성 실패(권한 필요)"); return; }
        await this.load();
        await this.selectProject(p.id);
      } catch (e) { alert("네트워크 오류"); }
    },

    async deleteProject() {
      if (!this.currentProject) return;
      if (!confirm(`'${this.currentProject.name}' 프로젝트와 모든 데크를 삭제할까요?`)) return;
      try {
        await fetch("/api/projects/" + this.currentProject.id, { method: "DELETE", headers: Auth.headers() });
        this.currentProject = null; this.currentDeck = null; this.decks = [];
        await this.load();
        this._renderDecks();
      } catch (e) {}
    },

    async selectProject(id) {
      this.currentProject = this.list.find((p) => p.id === id) || null;
      this._renderSelect();
      if (!this.currentProject) { this.decks = []; this._renderDecks(); return; }
      await this.loadDecks();
    },

    async loadDecks() {
      // ── [마스터 요청] 목록 정합성: 요청 시점의 프로젝트 ID를 고정해, 응답 도착 시
      //    현재 프로젝트가 바뀌었으면 폐기(유령 항목 방지). 또 응답에서 현재 프로젝트 deck만 채택. ──
      const reqPid = this.currentProject ? this.currentProject.id : null;
      if (!reqPid) { this.decks = []; this._renderDecks(); return; }
      let data = [];
      try {
        // [버그수정] GET /decks 는 인증 필수(401) — Auth.headers() 누락 시 빈 목록 → "구역 없음".
        //   createDeck(POST)는 헤더가 있어 생성되지만, 직후 loadDecks 가 401 로 빈 목록을 받아
        //   "생성해도 구역이 안 나오는" 회귀였다. (도면 등록 시 ensureDeck 도 동일 증상)
        const r = await fetch("/api/projects/" + reqPid + "/decks", { headers: Auth.headers() });
        const j = await r.json();
        data = j.data || [];
      } catch (e) { data = []; }
      // 응답 도착 사이 프로젝트가 바뀌었으면 무시
      if (!this.currentProject || this.currentProject.id !== reqPid) return;
      // 서버가 다른 프로젝트 deck을 섞어줘도(이론상) 현재 프로젝트 것만 사용
      this.decks = (data || []).filter((d) => !d.project_id || d.project_id === reqPid);
      this._renderDecks();
    },

    /** #3: 구역 생성. 반환된 구역 객체를 돌려줌(없으면 강제 생성 흐름에서 사용). */
    async createDeck(opts) {
      opts = opts || {};
      if (!this.currentProject) { alert("먼저 프로젝트를 선택하세요."); return null; }
      // ── [마스터 요청] 생성 버튼 연타 가드: 진행 중이면 중복 생성 차단 ──
      if (this._creatingDeck) { return null; }
      let name = opts.name;
      if (!name) {
        const res = await Prompt.ask({ title: "구역 생성", sub: "구역 이름을 입력하세요 (예: Main Deck, Engine Room, No.1 Hold)", placeholder: "구역 이름" });
        if (!res) return null;
        name = res.value;
      }
      // ── [마스터 요청] 이름 검증 + 중복 방지(같은 프로젝트에 같은 이름 구역 차단) ──
      name = String(name || "").trim();
      if (!name) { alert("구역 이름을 입력하세요."); return null; }
      const dup = (this.decks || []).find((x) => String(x.name).trim().toLowerCase() === name.toLowerCase());
      if (dup) {
        Prompt.toast && Prompt.toast("이미 '" + name + "' 구역이 있습니다 — 그 구역을 선택합니다");
        this.currentDeck = dup; this._renderDecks();
        return dup; // 중복 생성하지 않고 기존 구역 반환
      }
      this._creatingDeck = true;
      try {
        const r = await fetch("/api/projects/" + this.currentProject.id + "/decks", {
          method: "POST", headers: Auth.headers(),
          body: JSON.stringify({ name })
        });
        const d = await r.json();
        if (!r.ok) { alert(d.error || "생성 실패(권한 필요)"); return null; }
        await this.loadDecks();
        const created = this.decks.find((x) => x.id === d.id) || d;
        if (opts.select !== false) { this.currentDeck = created; this._renderDecks(); }
        return created;
      } catch (e) { alert("네트워크 오류"); return null; }
      finally { this._creatingDeck = false; }
    },

    /** #3: 구역이 하나도 없으면 자동으로 기본 구역을 만들어 반환(도면 등록 전 보장). */
    async ensureDeck() {
      if (this.currentDeck) return this.currentDeck;
      if (this.decks.length) { this.currentDeck = this.decks[0]; this._renderDecks(); return this.currentDeck; }
      // 구역이 전혀 없음 → 강제 생성
      const created = await this.createDeck({ name: "구역 1", select: true });
      return created;
    },

    async deleteDeck(id, name) {
      if (!confirm(`구역 '${name}' 를 삭제할까요?`)) return;
      try {
        await fetch("/api/decks/" + id, { method: "DELETE", headers: Auth.headers() });
        if (this.currentDeck && this.currentDeck.id === id) this.currentDeck = null;
        await this.loadDecks();
      } catch (e) {}
    },

    /** 구역 선택 — 해당 구역에 연결된 도면(배포 스냅샷)이 있으면 불러옴 */
    async selectDeck(d) {
      this.currentDeck = d;
      this._renderDecks();
      Prompt.toast && Prompt.toast("구역 '" + d.name + "' 선택됨 — 도면을 등록하거나 포인트를 추가하세요");
      // 연결된 도면이 있으면 로드, 없으면(끊김/미연결) 도면 연결 선택 띄움(디자이너)
      if (d.deployment_id && typeof App !== "undefined" && App.loadDeckDrawing) {
        await App.loadDeckDrawing(d.deployment_id);
      } else if (!d.deployment_id && typeof State !== "undefined" && State.mode === "designer" && typeof App !== "undefined" && App.offerDeckDrawingLink) {
        App.offerDeckDrawingLink(d);
      }
    },

    _renderDecks() {
      const listEl = document.getElementById("decks-list");
      const emptyEl = document.getElementById("decks-empty");
      // [마스터 규칙] 구역 유무에 따라 도면 업로드 버튼 잠금/해제 (구역 선행 등록 시각화)
      this._syncUploadLock();
      if (!listEl) return;
      listEl.innerHTML = "";
      if (!this.decks.length) { emptyEl.classList.remove("hidden"); return; }
      emptyEl.classList.add("hidden");
      this.decks.forEach((d) => {
        const isActive = this.currentDeck && this.currentDeck.id === d.id;
        const row = document.createElement("div");
        row.className = "deck-row" + (isActive ? " active" : "");
        const hasDoc = !!d.deployment_id;
        // 트리 가이드(└) + 구역 아이콘 + 도면 등록 여부
        const dot = hasDoc
          ? '<span class="deck-hasdoc" title="도면 등록됨"><i class="fa-solid fa-file-lines"></i></span>'
          : '<span class="deck-nodoc" title="도면 미등록"><i class="fa-regular fa-folder-open"></i></span>';
        row.innerHTML = `<span class="deck-tree-guide">└</span><span class="deck-name">${dot}${this._esc(d.name)}</span>
          <button class="deck-del" title="삭제"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>`;
        row.querySelector(".deck-name").addEventListener("click", () => this.selectDeck(d));
        row.querySelector(".deck-del").addEventListener("click", (e) => { e.stopPropagation(); this.deleteDeck(d.id, d.name); });
        listEl.appendChild(row);
        // ── 선택된 구역: 등록된 도면을 트리 하위로 표시(없으면 '도면 등록 필요') ──
        if (isActive) {
          const sub = document.createElement("div");
          sub.className = "deck-doc-sub";
          if (hasDoc) {
            const fname = (typeof State !== "undefined" && State.fileName) ? State.fileName : "등록 도면";
            sub.innerHTML = `<span class="deck-doc-line"><span class="deck-tree-guide sub">└─</span><i class="fa-solid fa-image"></i> ${this._esc(fname)}</span>`;
          } else {
            sub.innerHTML = `<span class="deck-doc-line empty"><span class="deck-tree-guide sub">└─</span>도면을 등록하세요 (아래 버튼)</span>`;
          }
          listEl.appendChild(sub);
        }
      });
      if (typeof UI !== "undefined" && UI.renderTree) UI.renderTree();
    },

    /** [마스터 규칙] 구역이 없으면 도면 업로드 버튼을 잠그고 안내, 있으면 해제 */
    _syncUploadLock() {
      const btn = document.getElementById("btn-upload-drawing");
      const hint = document.getElementById("upload-zone-hint");
      if (!btn) return;
      // 프로젝트가 선택된 디자이너 동선에서만 잠금 적용
      const hasProject = !!this.currentProject;
      const hasDeck = (this.decks || []).length > 0;
      const locked = hasProject && !hasDeck;
      btn.classList.toggle("upload-locked", locked);
      btn.setAttribute("aria-disabled", locked ? "true" : "false");
      if (locked) {
        btn.dataset.origText = btn.dataset.origText || btn.textContent;
        btn.textContent = "먼저 구역을 등록하세요";
        if (hint) hint.textContent = "도면을 올리려면 위 ‘구역’에서 + 생성으로 구역을 먼저 만드세요.";
      } else {
        if (btn.dataset.origText) btn.textContent = btn.dataset.origText;
        if (hint) hint.textContent = "구역을 선택하면 해당 구역에 도면이 등록·자동저장됩니다.";
      }
    },

    _esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
  };
