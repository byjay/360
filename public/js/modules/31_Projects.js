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

    /* [WO 20260918] 🔴 조용한 실패 금지 — createProject/deleteProject/createDeck 은 서버에
     *  즉시 ID 를 발급받아야 다음 단계(선택/도면로드/크롭)로 진행할 수 있는 동기 흐름이라,
     *  OpLog 오프라인 큐(20_App.js, pin/zone 편집 재생 전용)로 편입하지 않는다 — 큐잉하면
     *  임시 ID ↔ 서버 ID 재조정 로직이 새로 필요해지고(SoT 분열 위험), 삭제는 재생 시점에
     *  사용자가 모르는 사이 실행돼 위험하다(§10). 대신 최소 조치로 오프라인이면 그 자리에서
     *  이유를 말하고 중단한다(기존 Prompt.toast 경로 재사용, 새 UI 없음). */
    async createProject() {
      if (!Auth.isDesigner) return;
      if (!navigator.onLine) { Prompt.toast && Prompt.toast("오프라인이라 지금은 프로젝트를 생성할 수 없습니다 — 연결 후 다시 시도하세요"); return; }
      const res = await Prompt.ask({ title: "프로젝트 생성", sub: "새 프로젝트 이름을 입력하세요 (예: ○○호 검사)", placeholder: "프로젝트 이름" });
      if (!res) return;
      try {
        const r = await fetch("/api/projects", { method: "POST", headers: Auth.headers(), body: JSON.stringify({ name: res.value }) });
        const p = await r.json();
        if (!r.ok) { alert(p.error || "생성 실패(권한 필요)"); return; }
        await this.load();
        await this.selectProject(p.id);
      } catch (e) {
        if (!navigator.onLine) { Prompt.toast && Prompt.toast("오프라인이라 지금은 프로젝트를 생성할 수 없습니다 — 연결 후 다시 시도하세요"); }
        else alert("네트워크 오류");
      }
    },

    async deleteProject() {
      if (!this.currentProject) return;
      if (!confirm(`'${this.currentProject.name}' 프로젝트와 모든 데크를 삭제할까요?`)) return;
      if (!navigator.onLine) { Prompt.toast && Prompt.toast("오프라인이라 지금은 프로젝트를 삭제할 수 없습니다 — 연결 후 다시 시도하세요"); return; }
      try {
        await fetch("/api/projects/" + this.currentProject.id, { method: "DELETE", headers: Auth.headers() });
        this.currentProject = null; this.currentDeck = null; this.decks = [];
        await this.load();
        this._renderDecks();
      } catch (e) {
        // [WO 20260918] 🔴 예전엔 빈 catch — 오프라인/네트워크 오류가 아무 말 없이 무시됐다.
        if (!navigator.onLine) Prompt.toast && Prompt.toast("오프라인이라 지금은 프로젝트를 삭제할 수 없습니다 — 연결 후 다시 시도하세요");
        else Prompt.toast && Prompt.toast("삭제 실패 — 네트워크 오류, 다시 시도해주세요");
      }
    },

    async selectProject(id) {
      this.currentProject = this.list.find((p) => p.id === id) || null;
      // [P40] 배지 컨텍스트 — 프로젝트 역할 표시(공유 지점: Auth.setProjectContext)
      if (typeof Auth !== "undefined" && Auth.setProjectContext) Auth.setProjectContext(this.currentProject);
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
      // [B4] 로컬 draft 스캔 → '미저장' 배지 동기화(비차단)
      try { if (typeof App !== "undefined" && App._refreshUnsavedDecks) App._refreshUnsavedDecks(); } catch (e) {}
    },

    /** #3: 구역 생성. 반환된 구역 객체를 돌려줌(없으면 강제 생성 흐름에서 사용). */
    async createDeck(opts) {
      opts = opts || {};
      if (!this.currentProject) { alert("먼저 프로젝트를 선택하세요."); return null; }
      // ── [마스터 요청] 생성 버튼 연타 가드: 진행 중이면 중복 생성 차단 ──
      if (this._creatingDeck) { return null; }
      // [WO 20260918] 🔴 조용한 실패 금지 — 이 흐름은 파일선택창까지 여는 동기 흐름이라
      // OpLog 큐잉 대상이 아니다(사유는 파일 상단 주석). 오프라인이면 파일창을 열기 전에 중단.
      if (!navigator.onLine) { Prompt.toast && Prompt.toast("오프라인이라 지금은 구역을 생성할 수 없습니다 — 연결 후 다시 시도하세요"); return null; }
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
      // ── [P1·마스터 요청] "구역을 등록하면 반드시 도면이 등록되어야 한다" ──
      //   사용자가 직접 만든 구역(askDrawing !== false)은 **도면 파일을 먼저 확정**한 뒤에야 POST 한다.
      //   파일창을 취소하면 구역 POST 자체를 하지 않으므로 '도면없음' 구역이 생기지 않는다(롤백 불필요).
      //   ensureDeck()/도면로드 중 자동생성(askDrawing:false)은 이미 파일이 손에 있으므로 이 단계를 건너뛴다(무한루프 방지).
      this._creatingDeck = true;
      let created = null;
      let picked = null;
      // [WO 20260916] 구역=도면의 한 조각 — 이 구역이 가리킬 페이지(1-base). 파일 미확정 경로(자동생성)는 미지정(NULL)으로 둔다.
      let page = 1;
      try {
        if (opts.askDrawing !== false) {
          if (typeof App === "undefined" || !App._pickDrawingFile) { alert("도면 선택기를 사용할 수 없습니다."); return null; }
          Prompt.toast && Prompt.toast("구역 '" + name + "' — 이 구역에 등록할 도면(PDF/PNG/JPG)을 선택하세요");
          picked = await App._pickDrawingFile();
          if (!picked) {
            Prompt.toast && Prompt.toast("도면을 선택하지 않아 구역 '" + name + "' 생성을 취소했습니다 — 구역에는 도면이 반드시 필요합니다");
            return null;   // 구역을 만들지 않는다 → 사용자 취소로 '도면없음' 구역이 생기지 않음
          }
          // 여러 장 PDF 면 이 구역이 쓸 1페이지를 먼저 정한다(1장/이미지면 자동 1, 묻지 않음).
          const totalPages = await this._peekPageCount(picked);
          page = await this._choosePage(totalPages);
        }
        const body = { name };
        if (opts.askDrawing !== false) body.page = page; // 자동생성 경로는 전송하지 않음 → 서버 NULL(구버전과 동일)
        const r = await fetch("/api/projects/" + this.currentProject.id + "/decks", {
          method: "POST", headers: Auth.headers(),
          body: JSON.stringify(body)
        });
        const d = await r.json();
        if (!r.ok) { alert(d.error || "생성 실패(권한 필요)"); return null; }
        await this.loadDecks();
        created = this.decks.find((x) => x.id === d.id) || d;
        // ── [B3] draft 키 표류 방지 ──
        //   draft 키는 `projectId::deckId` 다. currentDeck 을 새 구역으로 바꾸기 전에
        //   현재 구역에서 작업 중이던 미저장분을 '기존 키'로 확실히 저장한다.
        //   (안 하면 이전 구역 작업이 새 구역 키로 넘어가 사실상 유실된다)
        if (opts.select !== false && this.currentDeck && this.currentDeck.id !== created.id
            && typeof App !== "undefined" && App._dirty && App._saveDraftLocal) {
          try { await App._saveDraftLocal(); } catch (e) {}
        }
        if (opts.select !== false) { this.currentDeck = created; this._renderDecks(); }
      } catch (e) {
        if (!navigator.onLine) Prompt.toast && Prompt.toast("오프라인이라 지금은 구역을 생성할 수 없습니다 — 연결 후 다시 시도하세요");
        else alert("네트워크 오류");
        return null;
      }
      finally { this._creatingDeck = false; }
      // ── [P1] 구역이 확정된 뒤에 도면 로드. _creatingDeck 해제 후에 호출해야
      //   _loadDrawing 내부의 '구역 선행' 가드가 createDeck 을 재호출해도 연타가드에 막히지 않는다.
      if (created && picked && opts.select !== false && typeof App !== "undefined" && App._loadDrawing) {
        try {
          await App._loadDrawing(picked);
          // 선택한 페이지로 전환(1페이지면 그대로) + 그 페이지에서 크롭(영역) 지정 — 건너뛰면 페이지 전체(crop 없음).
          if (page > 1 && App._gotoPage) { try { await App._gotoPage(page); } catch (e) {} }
          const crop = await this._pickDeckCrop();
          if (crop) {
            const r2 = await fetch("/api/decks/" + created.id, { method: "PUT", headers: Auth.headers(), body: JSON.stringify({ crop }) });
            if (r2.ok) {
              const updated = await r2.json();
              Object.assign(created, updated);
              const idx = this.decks.findIndex((x) => x.id === created.id);
              if (idx >= 0) this.decks[idx] = created;
              if (this.currentDeck && this.currentDeck.id === created.id) this.currentDeck = created;
              this._renderDecks();
            }
          }
        }
        catch (e) { Prompt.toast && Prompt.toast("도면 로드 실패 — ‘도면 등록’ 버튼으로 다시 시도하세요"); }
      }
      return created;
    },

    /** [WO 20260916] 선택한 파일의 PDF 페이지 수를 가볍게 확인(peek, State 비변경). 이미지/실패 시 1. */
    async _peekPageCount(file) {
      const isPdf = file && (file.type === "application/pdf" || String(file.name || "").toLowerCase().endsWith(".pdf"));
      if (!isPdf || typeof PDF === "undefined" || !PDF.load) return 1;
      try {
        const ab = await file.arrayBuffer();
        const doc = await PDF.load(ab);
        const n = doc && doc.numPages ? doc.numPages : 1;
        try { doc && doc.destroy && doc.destroy(); } catch (e) {}
        return n;
      } catch (e) { return 1; }
    },

    /** [WO 20260916] 여러 장 PDF 중 이 구역이 쓸 페이지 번호를 묻는다. 1장이면 자동 1(묻지 않음). */
    async _choosePage(totalPages) {
      if (!(totalPages > 1)) return 1;
      const pr = await Prompt.ask({
        title: "페이지 선택",
        sub: `이 PDF는 ${totalPages}페이지입니다 — 이 구역에 쓸 페이지 번호를 입력하세요(1~${totalPages})`,
        placeholder: "예: 1", value: "1"
      });
      if (!pr || !pr.value) return 1;
      const n = parseInt(pr.value, 10);
      return (!isNaN(n) && n >= 1 && n <= totalPages) ? n : 1;
    },

    /** [WO 20260916] 구역이 될 영역(crop, %)을 도면 위에서 드래그로 지정.
     *  🔴 새 그리기 도구 금지(Ponytail) — 기존 영역 그리기(Zones rect 드래그)를 그대로 재사용한다.
     *  Zones._commitZone/_cancelDraw 를 일시적으로 가로채 라벨 프롬프트 없이 bbox(%)만 받고 원복.
     *  드래그 없이 Esc/취소 → null(=페이지 전체, crop 미지정). */
    _pickDeckCrop() {
      return new Promise((resolve) => {
        if (typeof Zones === "undefined") { resolve(null); return; }
        const origCommit = Zones._commitZone.bind(Zones);
        const origCancel = Zones._cancelDraw.bind(Zones);
        let done = false;
        const restore = () => { Zones._commitZone = origCommit; Zones._cancelDraw = origCancel; };
        Zones._commitZone = async (geom) => {
          if (done) return; done = true;
          const bb = Zones._bbox(geom);
          restore();
          origCancel();
          resolve({ x: bb.x, y: bb.y, w: bb.w, h: bb.h });
        };
        Zones._cancelDraw = () => {
          origCancel();
          if (done) return; done = true;
          restore();
          resolve(null);
        };
        Zones._shape = "rect"; Zones._poly = null;
        State.drawingZone = true;
        if (Zones._syncToolUi) Zones._syncToolUi();
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("도면에서 이 구역이 될 영역을 드래그하세요 — Esc를 누르면 페이지 전체가 구역이 됩니다");
      });
    },

    /** #3: 구역이 하나도 없으면 자동으로 기본 구역을 만들어 반환(도면 등록 전 보장). */
    async ensureDeck() {
      if (this.currentDeck) return this.currentDeck;
      if (this.decks.length) { this.currentDeck = this.decks[0]; this._renderDecks(); return this.currentDeck; }
      // 구역이 전혀 없음 → 강제 생성 (도면 등록 흐름 중 자동생성 — 파일창을 또 띄우면 무한루프)
      const created = await this.createDeck({ name: "구역 1", select: true, askDrawing: false });
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
        // [WO 20260916] 구역=도면의 한 조각 — page 로 전환 + crop 있으면 그 부분만 확대(재사용: fitZone).
        // 구버전 구역(page/crop 없음)은 이 분기가 그냥 건너뛰어져 종전대로 동작.
        if (d.page && typeof App._gotoPage === "function") { try { await App._gotoPage(d.page); } catch (e) {} }
        try { document.body.classList.toggle("deck-view-active", !!d.crop); } catch (e) {}
        // [WO 20260917] 크롭 렌더 대상 고정 — 같은 픽셀 예산을 구역 영역에 집중(재사용: PDF.renderCrop).
        // crop 없으면 null 로 해제(구버전 구역은 종전대로 전체 페이지 렌더).
        if (typeof PDF !== "undefined" && PDF.setDeckCrop) PDF.setDeckCrop(d.crop || null);
        if (d.crop && typeof MapCtrl !== "undefined" && MapCtrl.fitZone) MapCtrl.fitZone(d.crop, 0.14, 640);
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
      if (!this.decks.length) {
        // ── [결함수정] #decks-empty 는 side-tree 일원화(2b9b677)로 CSS에서 영구 숨김이다.
        //    과거엔 여기서 return 해버려 UI.renderTree() 호출까지 건너뛰어 #side-tree 가
        //    갱신되지 않았다(= 구역 0개일 때 사이드바가 통째로 비어 보이는 조용한 실패).
        //    #decks-empty 를 되살리지 않고, #side-tree 안에서 직접 실제 안내를 그린다. ──
        if (emptyEl) emptyEl.classList.add("hidden");
        this._renderSideTreeEmpty();
        return;
      }
      if (emptyEl) emptyEl.classList.add("hidden");
      this.decks.forEach((d) => {
        const isActive = this.currentDeck && this.currentDeck.id === d.id;
        const row = document.createElement("div");
        row.className = "deck-row" + (isActive ? " active" : "");
        const hasDoc = !!d.deployment_id;
        // 트리 가이드(└) + 구역 아이콘 + 도면 등록 여부
        const dot = hasDoc
          ? '<span class="deck-hasdoc" title="도면 등록됨"><i class="fa-solid fa-file-lines"></i></span>'
          : '<span class="deck-nodoc" title="도면 미등록"><i class="fa-regular fa-folder-open"></i></span>';
        // [B4] 로컬에만 있고 서버 미저장 → '미저장' 배지('도면없음'과 구분)
        const unsaved = (typeof App !== "undefined" && App.isDeckUnsaved) ? App.isDeckUnsaved(d.id) : false;
        const uTag = unsaved ? '<span class="deck-unsaved-tag" title="로컬에만 있음 — ‘저장’을 눌러 서버에 반영하세요">미저장</span>' : "";
        row.innerHTML = `<span class="deck-tree-guide">└</span><span class="deck-name">${dot}${this._esc(d.name)}${uTag}</span>
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

    /** [결함수정] 구역 0개일 때 #side-tree 안에 직접 그리는 빈 상태 안내.
     *  UI.renderTree()(11_UI.js — 다른 에이전트 작업 중이라 수정 금지)도 구역 0개면 같은
     *  자리에 안내 텍스트만 그리지만 실제 생성 버튼이 없다. 여기서는 프로젝트가 선택된
     *  경우에만(=진짜 "구역 0개") 실제 생성 버튼이 있는 안내를 그리고, 프로젝트 미선택
     *  상태에서는 잘못된 안내를 띄우지 않도록 비워둔다.
     *  ponytail: 이후 다른 코드가 UI.renderTree()를 독립 호출하면(16_Zones.js 등) 이 안내가
     *  버튼 없는 텍스트로 되돌아갈 수 있다 — 실전에서는 구역이 0개일 때 존재할 수 없는
     *  zone/pin 갱신 경로라 발생 가능성이 낮지만, 근본 해결은 11_UI.js 쪽 수정이 필요하다. */
    _renderSideTreeEmpty() {
      const host = document.getElementById("side-tree");
      if (!host) return;
      if (!this.currentProject) { host.innerHTML = ""; return; } // 프로젝트 미선택 — 안내 없음
      host.innerHTML =
        '<div class="side-tree-empty">' +
          '<p class="side-tree-empty-msg">이 프로젝트에 구역이 없습니다.<br>구역을 만들면 도면을 등록할 수 있습니다.</p>' +
          '<button type="button" class="side-tree-empty-cta" id="side-tree-create-deck">+ 구역 생성</button>' +
        '</div>';
      const btn = document.getElementById("side-tree-create-deck");
      if (btn) btn.addEventListener("click", () => this.createDeck());
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
