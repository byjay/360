  const Projects = {
    list: [],
    decks: [],
    currentProject: null,
    currentDeck: null,

    init() {
      const $ = (id) => document.getElementById(id);
      $("btn-new-project") && $("btn-new-project").addEventListener("click", () => this.createProject());
      $("btn-delete-project") && $("btn-delete-project").addEventListener("click", () => this.deleteProject());
      // [WO 20260918] 프로젝트 안에서 오프라인 다운로드 — 12_ProjectHub.js downloadProject() 재사용(SoT).
      const dlBtn = $("btn-download-project");
      if (dlBtn) dlBtn.addEventListener("click", () => {
        if (!this.currentProject) return;
        if (typeof ProjectHub !== "undefined" && ProjectHub.downloadProject) ProjectHub.downloadProject(this.currentProject, dlBtn);
      });
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
      if (!await Prompt.confirm("프로젝트 삭제", `'${this.currentProject.name}' 프로젝트와 모든 데크를 삭제할까요?`)) return;
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

    /** [WO 20260929-parent-guard] 🔴 SoT — 프로젝트를 바꾸는 **모든** 진입점(드롭다운 selectProject,
     *  허브 카드 클릭 ProjectHub.openProject, 서브도메인 자동진입 99_footer.js)이 반드시 이 함수를
     *  거쳐야 한다. `Projects.currentProject = p` 직접 대입 금지(형제 호출부 전수 확인 —
     *  CLAUDE.md §G-2-5). 근본원인(재현 2026-09-29, 지휘자 실측 2건):
     *   ① currentDeck 을 초기화하지 않으면 이전(삭제됐거나 다른) 프로젝트의 구역 참조가 새
     *      프로젝트로 새어 들어가 extractRegionAsDeck(src=this.currentDeck)이 그 참조를 그대로
     *      parent_id 로 써서 "다른 프로젝트의 deck 을 부모로 둔 고아 deck"을 만든다.
     *   ② ProjectHub.openProject 는 `currentProject = p` 를 **동기로** 바꾼 뒤 deck 목록을
     *      비동기로 새로 받아오는데(N4, 20_App.js), 그 사이(await) 창에서 _draftKey()(pid::did)가
     *      아직 초기화 전인 stale currentDeck.id 를 그대로 써 "새 프로젝트 pid + 옛 프로젝트 deck id"
     *      조합의 draft 키가 IndexedDB 에 영구 저장되고, 나중에 _flushDirtyDrafts 가 그 draft 의
     *      depId(옛 프로젝트 배포본)로 PATCH 를 보낸다 — currentProject 대입과 **같은 동기 틱**에서
     *      currentDeck 을 null 로 만들어야 이 경쟁 창을 없앤다. */
    setCurrentProject(p) {
      this.currentProject = p || null;
      this.currentDeck = null;
    },

    async selectProject(id) {
      this.setCurrentProject(this.list.find((p) => p.id === id) || null);
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
        // [WO 20261002-gap] 🔴 오프라인이면 네트워크를 시도조차 하지 않고 바로 캐시 폴백(아래
        //   catch 분기와 같은 경로 — fetch 가 끊긴 소켓에서 수십 초씩 멈추는 걸 막는다).
        if (!navigator.onLine) throw new Error("offline");
        // [버그수정] GET /decks 는 인증 필수(401) — Auth.headers() 누락 시 빈 목록 → "구역 없음".
        //   createDeck(POST)는 헤더가 있어 생성되지만, 직후 loadDecks 가 401 로 빈 목록을 받아
        //   "생성해도 구역이 안 나오는" 회귀였다. (도면 로드 시 ensureDeck 도 동일 증상)
        const r = await fetch("/api/projects/" + reqPid + "/decks", { headers: Auth.headers() });
        const j = await r.json();
        data = j.data || [];
        // [WO 20261002-gap] 🔴 write-through — 온라인에서 받은 구역 목록을 오프라인 캐시에도
        //   남긴다(OfflineBundle.download() 이 쓰는 같은 키 bundle:decks:<pid> 재사용 — SoT,
        //   새 키 금지). [다운로드]를 누르지 않고 열어본 프로젝트도 오프라인 트리가 비지 않는다.
        try { if (typeof SyncQueue !== "undefined" && SyncQueue.saveDraft) await SyncQueue.saveDraft("bundle:decks:" + reqPid, data); } catch (e) {}
      } catch (e) {
        // [WO 20261002-gap] 🔴 근본수정 — 오프라인/네트워크 실패 시 빈 배열로 "구역이 없습니다"를
        //   보이던 조용한 실패(§5) 대신, IndexedDB 캐시(직전 온라인 방문 또는 [다운로드] 번들)로
        //   폴백한다. 20_App.js loadLatestDeployment() 의 같은 폴백과 동일 규칙(공유, 신규 메커니즘 아님).
        try { data = (typeof OfflineLoad !== "undefined") ? await OfflineLoad.decks(reqPid) : []; } catch (e2) { data = []; }
      }
      // 응답 도착 사이 프로젝트가 바뀌었으면 무시
      if (!this.currentProject || this.currentProject.id !== reqPid) return;
      // 서버가 다른 프로젝트 deck을 섞어줘도(이론상) 현재 프로젝트 것만 사용
      this.decks = (data || []).filter((d) => !d.project_id || d.project_id === reqPid);
      this._renderDecks();
      // [B4] 로컬 draft 스캔 → '미저장' 배지 동기화(비차단)
      try { if (typeof App !== "undefined" && App._refreshUnsavedDecks) App._refreshUnsavedDecks(); } catch (e) {}
      // [WO 20260928-hub-tree] 🔴 공유 지점(SoT) — createDeck/extractRegionAsDeck/드래그크롭 생성이
      //   전부 이 loadDecks() 를 거치므로 허브 카드 트리 갱신은 여기 한 곳에만 둔다(각 생성 함수마다
      //   중복 호출 금지). 허브 화면이 지금 안 보이면(screen-projects 비활성) 아무 일도 안 한다.
      try { if (typeof ProjectHub !== "undefined" && ProjectHub.refreshIfVisible) ProjectHub.refreshIfVisible(); } catch (e) {}
    },

    /** [WO 20260930-moderole] 🔴 마스터 2차 지시로 88e52ff 모드 가지 구조를 제거 — 구역·영역은
     *  이제 두 모드가 공유하므로 새로 만드는 구역/영역에 decks.mode 태그를 붙이지 않는다(no-op).
     *  decks.mode 컬럼(0029)은 비파괴로 남겨 두되 클라이언트는 더 이상 쓰지 않는다. 서버의 mode
     *  검증·상속 400(src/index.tsx parseDeckMode/resolveDeckMode)은 body.mode 가 전송될 때만
     *  동작하므로, 여기서 보내지 않으면 무해하다(확인 완료). POST 3곳 공유 지점(SoT) 그대로 유지. */
    _withDeckMode(body, _parentDeck) {
      return body;
    },

    /** #3: 구역 생성. 반환된 구역 객체를 돌려줌(없으면 강제 생성 흐름에서 사용). */
    async createDeck(opts) {
      opts = opts || {};
      if (!this.currentProject) { alert("먼저 프로젝트를 선택하세요."); return null; }
      // ── [마스터 요청] 생성 버튼 연타 가드: 진행 중이면 중복 생성 차단 ──
      // [WO AM·재현 실측] 이 가드가 조용히 null 만 반환해 연타(또는 파일선택창이 아직 떠 있는
      // 최대 60초 창) 시 "버튼이 눌러도 반응 없음"처럼 보였다(§5 조용한 실패). 이유를 알린다.
      if (this._creatingDeck) { Prompt.toast && Prompt.toast("구역을 만드는 중입니다 — 잠시 후 다시 시도하세요"); return null; }
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
      // ── [WO 20260921·마스터 요청] "새 파일 로드가 아니라 이미 로드된 파일에서 지정 시
      //   캡처하듯이 완전한 새 페이지를 생성" — 사용자가 직접 만드는 구역(askDrawing !== false)은
      //   ①기존 도면에서 영역 지정 / ②새 도면 파일 업로드 중 고르게 한다.
      //   🔴 새 메커니즘 금지 — ①은 기존 extractRegionAsDeck()(WO 20260918-B)을 그대로 재사용한다.
      //   opts.source 가 미리 정해져 있으면(테스트/내부 재호출) 묻지 않는다.
      //   자동생성 경로(askDrawing:false, ensureDeck 등)는 건드리지 않는다 — 조건에서 제외.
      if (opts.askDrawing !== false && !opts.source) {
        const source = await this._chooseDeckSource();
        if (!source) { Prompt.toast && Prompt.toast("구역 생성을 취소했습니다"); return null; }
        opts.source = source;
      }
      if (opts.source === "region") {
        // 이미 이름 검증(중복 포함)을 마쳤으므로 그대로 넘긴다 — extractRegionAsDeck 은 그 안에서
        // currentProject/currentDeck.deployment_id/온라인 상태를 다시 확인한다(자체 가드 유지).
        return await this.extractRegionAsDeck({ name });
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
        this._withDeckMode(body); // [WO 20260930-fixmode] 활성 모드 태그
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
    _pickDeckCrop(hintMsg) {
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
        // 🔴 [WO 20260928 · 라이브 실측] 모바일 사이드 시트가 열려 있으면 화면 하단 절반을 덮어
        //   도면을 드래그할 수 없다. 크롭 지정을 요구하는 **모든** 경로가 이 함수를 지나므로 여기서 닫는다.
        if (typeof App !== "undefined" && App._closeSidebarSheet) App._closeSidebarSheet();
        Zones._shape = "rect"; Zones._poly = null;
        State.drawingZone = true;
        if (Zones._syncToolUi) Zones._syncToolUi();
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast(hintMsg || "도면에서 이 구역이 될 영역을 드래그하세요 — Esc를 누르면 페이지 전체가 구역이 됩니다");
      });
    },

    /** [WO 20260921] 구역 생성 시 "①기존 도면에서 영역 지정" vs "②새 도면 파일 업로드" 선택.
     *  🔴 로드된 도면(=deployment_id 가 있는 현재 구역)이 없으면 ①을 고를 수 없다 — 이때 조용히
     *  비활성만 시키지 않고 이유를 화면에 안내한다(#dsm-region-reason).
     *  마크업이 없으면(구버전 폴백) 묻지 않고 기존 동작(업로드)으로 진행한다.
     *  @returns {Promise<"region"|"upload"|null>} null = 취소
     */
    _chooseDeckSource() {
      return new Promise((resolve) => {
        const m = document.getElementById("deck-source-modal");
        if (!m) { resolve("upload"); return; } // 구버전 폴백 — 묻지 않고 종전 동작
        // 🔴 [WO 20260929] 도면이 화면에 로드돼 있으면(구역 소속·개수와 무관하게) ①을 고를 수 있다 —
        //   이미 저장된 도면(currentDeck.deployment_id)이면 기존 extractRegionAsDeck 경로,
        //   아직 저장 전인 로드된 도면이면 createDeckFromLoadedDrawing 경로로 위임한다.
        //   중복 UI 금지(요구4): 새 모달을 만들지 않고 이 선택지의 활성 조건만 넓힌다.
        const canExtract = !!(this.currentDeck && this.currentDeck.deployment_id) || this._canExtractFromLoadedDrawing();
        const btnRegion = document.getElementById("dsm-btn-region");
        const btnUpload = document.getElementById("dsm-btn-upload");
        const reasonEl = document.getElementById("dsm-region-reason");
        const subEl = document.getElementById("dsm-sub");
        // 🔴 [WO 20260929·마스터 지적] "현재 도면: ㅁ" 이 구역 이름을 보여주고 있었다 — 이 화면은
        //   "어느 도면에서 영역을 지정할지" 를 알려야 하므로 도면 파일명(State.fileName)이 SoT다.
        //   화면에 로드된 도면이 없을 때만(예외적으로) 구역 이름으로 폴백한다.
        const loadedName = (typeof State !== "undefined" && State.fileName)
          || (this.currentDeck && this.currentDeck.name) || "";
        if (subEl) subEl.textContent = loadedName ? ("현재 도면: " + loadedName) : "";
        if (btnRegion) {
          btnRegion.disabled = !canExtract;
          if (btnRegion.classList) btnRegion.classList.toggle("disabled", !canExtract);
          // 🔴 실측(라이브 스크린샷) — .admin-gate-btn.primary 는 :disabled 전용 CSS 가 없어
          // disabled=true 여도 금색 그대로 보여 "눌러도 되는 버튼"처럼 보였다. style.css 는
          // 다른 트랙 점유 중(새 규칙 추가 금지)이라, 인라인 스타일로만 시각적으로도 비활성을 알린다.
          if (btnRegion.style) {
            btnRegion.style.opacity = canExtract ? "" : "0.45";
            btnRegion.style.cursor = canExtract ? "" : "not-allowed";
          }
        }
        if (reasonEl && reasonEl.classList) reasonEl.classList.toggle("hidden", canExtract);
        let done = false;
        const close = (val) => {
          if (done) return; done = true;
          if (m.classList) { m.classList.remove("on"); setTimeout(() => m.classList.add("hidden"), 200); }
          resolve(val);
        };
        const backdrop = document.getElementById("dsm-backdrop");
        const cancelBtn = document.getElementById("dsm-cancel");
        if (btnRegion) btnRegion.onclick = () => { if (!canExtract) return; close("region"); };
        if (btnUpload) btnUpload.onclick = () => close("upload");
        if (backdrop) backdrop.onclick = () => close(null);
        if (cancelBtn) cancelBtn.onclick = () => close(null);
        if (m.classList) {
          m.classList.remove("hidden");
          if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => m.classList.add("on"));
          else m.classList.add("on");
        }
      });
    },

    /** [WO 20260918-B] 🔴 여러 개의 뷰가 담긴 도면(A0 등)에서 **드래그한 부분만** 새 영역으로 뽑아낸다.
     *  마스터 원문: "pdf 에 여러 개의 뷰가 있는 파일일 때 긁어서 그 부분만 복사하듯이
     *  새로운 영역으로 만들어내는 기능".
     *
     *  🔴 [WO 20260928-copy] 갱신 — 원본 PDF 가 있으면 아래 "창" 대신 **복사본**(지정 부분만 담은 새 1페이지
     *     PDF 배포본, crop 없음)을 만든다(_planRegionCopy). 원본 배포본의 핀·구역·주석은 여전히 무변경이다.
     *     아래 창 방식은 원본 PDF 가 없는 구버전 도면에서 사용자가 고를 때만 쓰인다.
     *  🔴 비파괴(마스터 확정 — "pdf 원본은 유지한 채 그 영역만 보여주는 기능"):
     *   · 원본 PDF·배포본(deployments 행)에는 **한 바이트도 쓰지 않는다.** decks 행 1개를 INSERT 할 뿐이다.
     *   · 새 영역은 원본과 **같은 deployment_id** 를 가리키고 차이는 page+crop 뿐 —
     *     잘라낸 픽셀을 따로 저장하는 "복사"가 아니라 원본을 들여다보는 **창(view)** 이다.
     *   · 그래서 같은 도면에서 몇 번이든 반복해 뽑을 수 있고(요구①),
     *     뽑은 영역을 지워도(DELETE /api/decks/:id = decks 행 soft delete) 원본은 그대로다(요구④).
     *
     *  좌표계(요구③): 드래그 좌표는 MapCtrl.viewportToPercent → **페이지 기준 %** 다.
     *   크롭은 화면 줌/팬(MapCtrl.fitZone)과 고해상도 렌더 대상(PDF.setDeckCrop)만 바꿀 뿐
     *   좌표 원점을 옮기지 않는다 → 영역 안에서 찍은 핀도 계속 페이지 기준 %로 저장된다.
     *   [WP1 · H7] 저장(=배포, 같은 행)도 페이지 기준 % 그대로다 — 크롭 기준 %로 바꿔 저장하던 경로는
     *   원본 행의 크롭 밖 핀을 지워 제거했다(App._buildSavePayload). 크롭은 오직 보기 창이다.
     *  @param {object} [opts] { crop, name } — 테스트/자동화용 선주입(미지정 시 드래그·프롬프트로 물음)
     *  @returns {Promise<object|null>} 생성된 구역(deck) 또는 null(취소/실패)
     */
    async extractRegionAsDeck(opts) {
      opts = opts || {};
      if (typeof Auth !== "undefined" && !Auth.isDesigner) { Prompt.toast && Prompt.toast("설계자만 영역을 추출할 수 있습니다"); return null; }
      if (!this.currentProject) { Prompt.toast && Prompt.toast("먼저 프로젝트를 선택하세요"); return null; }
      const src = this.currentDeck;
      if (!src || !src.deployment_id) {
        // 🔴 [WO 20260928] "도면 있음 + 구역 0" — **첫 영역 지정이 곧 첫 구역 생성**이다.
        //   모든 진입경로(#btn-region-extract · #deck-source-modal ① · #side-tree CTA)가 이 함수로
        //   수렴하므로 분기도 여기 한 곳에만 둔다(형제 호출부 분열 금지 — CLAUDE.md §G-2-5).
        if (this._canExtractFromLoadedDrawing()) return await this.createDeckFromLoadedDrawing(opts);
        Prompt.toast && Prompt.toast("먼저 도면을 등록하세요 — 그 도면에서 영역을 지정해 구역을 만듭니다"); return null;
      }
      // 🔴 조용한 실패 금지 — 드래그 UI 를 띄우기 전에 끊는다(31_Projects.createDeck 과 같은 규칙).
      if (!navigator.onLine) { Prompt.toast && Prompt.toast("오프라인이라 지금은 영역을 추출할 수 없습니다 — 연결 후 다시 시도하세요"); return null; }
      if (this._extractingRegion) return null;   // 연타 가드(_creatingDeck 과 같은 패턴)

      const crop = opts.crop || await this._pickDeckCrop("도면에서 새 영역으로 만들 부분을 드래그하세요 — Esc 를 누르면 취소됩니다");
      if (!crop || !(crop.w > 0) || !(crop.h > 0)) { Prompt.toast && Prompt.toast("영역 추출을 취소했습니다"); return null; }

      // 지금 보고 있는 페이지(원본 구역이 특정 페이지를 가리키면 그 페이지) — 1-base
      const page = (typeof State !== "undefined" && State.pdfPage) || src.page || 1;

      let name = opts.name;
      if (name == null) {
        const res = await Prompt.ask({
          title: "새 영역 이름",
          sub: "긁어낸 영역의 이름을 정하세요 — 원본 도면은 그대로 유지됩니다",
          placeholder: "예: 평면도, 측면도, A-A 단면",
          value: this._nextRegionName(src.name)
        });
        if (!res) { Prompt.toast && Prompt.toast("영역 추출을 취소했습니다"); return null; }
        name = res.value;
      }
      name = String(name || "").trim() || this._nextRegionName(src.name);
      const dup = (this.decks || []).find((x) => String(x.name).trim().toLowerCase() === name.toLowerCase());
      if (dup) { Prompt.toast && Prompt.toast("이미 '" + name + "' 구역이 있습니다 — 다른 이름을 쓰세요"); return null; }

      this._extractingRegion = true;
      try {
        // 🔴 [WO 20260928-copy] 마스터: "지정한 영역만 복사해서 새로운 페이지" / "확대하면 해상도가 깨지잖아".
        //   원본 PDF 가 있으면 그 부분만 벡터 복사한 새 1페이지 PDF 배포본을 만들어 가리킨다(crop 없음).
        //   원본이 없으면(구버전) 조용히 이미지 복사본을 만들지 않고 사용자에게 묻는다(_planRegionCopy).
        const plan = await this._planRegionCopy(src, page, crop, name);
        if (!plan) return null;   // 취소/실패 — 사유는 _planRegionCopy 가 이미 화면에 알렸다
        const r = await fetch("/api/projects/" + this.currentProject.id + "/decks", {
          method: "POST", headers: Auth.headers(),
          // 복사본: 새 배포본(그 페이지 자체가 영역) · 창 방식: 원본과 같은 도면 + crop(원본 무변경).
          // [WO 20260921-tree] 🔴 parent_id = 부모 구역 id — 원본이 이미 "영역"(src.parent_id 있음)이어도
          // 그 부모(루트 구역)에 붙여 트리가 4단(프로젝트>도면>구역>영역)을 넘지 않게 한다.
          // [WO 20260930-fixmode] 영역 = 부모 구역의 mode 상속(부모 NULL 이면 활성 모드) — PinSeries.withDeckMode SoT.
          body: JSON.stringify(this._withDeckMode(plan.depId
            // [WO 20260930-merge] 복사본은 원본 상자(src_*) 기록 — 합치기 좌표 변환의 전제(_srcBoxFields)
            ? Object.assign({ name, page: 1, crop: null, deployment_id: plan.depId, level_no: src.level_no != null ? src.level_no : null, parent_id: src.parent_id || src.id }, this._srcBoxFields(src, page, crop))
            : { name, page, crop, deployment_id: src.deployment_id, level_no: src.level_no != null ? src.level_no : null, parent_id: src.parent_id || src.id },
            (src.parent_id && (this.decks || []).find((x) => String(x.id) === String(src.parent_id))) || src))
        });
        const d = await r.json();
        if (!r.ok) { Prompt.toast && Prompt.toast((d && d.error) || "영역 추출 실패 — 권한을 확인하세요"); return null; }
        await this.loadDecks();
        const created = (this.decks || []).find((x) => x.id === d.id) || d;
        // 🔴 반복 추출(요구①) — 현재 구역을 새 영역으로 바꾸지 않는다. 원본 도면 화면에 그대로 머물러
        //    곧바로 다음 영역을 긁을 수 있다("복사하듯이"). 새 영역은 목록에서 눌러 들어간다.
        if (plan.depId) {
          // 🔴 핀은 옮기지 않는다(원본 무변경) — 영역 안에 있던 핀 수를 사실대로 알린다(0이면 생략).
          const live = typeof State !== "undefined" && State.autoSaveDepId === src.deployment_id;
          const n = live ? this._pinsInCrop(State.pins, page, crop) : 0;
          Prompt.toast && Prompt.toast("영역 '" + name + "' 생성 — 지정한 부분을 새 페이지로 복사했습니다(확대해도 선명)"
            + (n > 0 ? " · 원본 구역에 있던 핀 " + n + "개는 원본에 그대로 있습니다" : ""), 5200);
        } else {
          Prompt.toast && Prompt.toast("영역 '" + name + "' 생성 — 계속 드래그해 다른 영역도 만들 수 있어요(목록에서 눌러 열기)"
            + (plan.limited ? " · 원본 PDF 가 없어 확대 시 선명도에 한계가 있습니다" : ""), plan.limited ? 5200 : 3600);
        }
        return created;
      } catch (e) {
        Prompt.toast && Prompt.toast(navigator.onLine ? "영역 추출 실패 — 네트워크 오류, 다시 시도해주세요" : "오프라인이라 지금은 영역을 추출할 수 없습니다");
        return null;
      } finally { this._extractingRegion = false; }
    },

    /** [WO 20260928-copy] 영역을 "복사본(새 PDF 배포본)"으로 만들지 "창(crop)"으로 만들지 결정한다.
     *  @returns {Promise<{depId, box}|{mode:"window", limited?}|null>} null = 취소/실패(사유는 이미 표시)
     *  · 원본 있음  → 벡터 복사 → 새 배포본 id
     *  · 원본 없음  → 묻는다: [원본 PDF 올리기](원본 등록 후 복사) / [창 방식](선명도 한계 고지) / 취소
     *  🔴 원본 없이 스냅샷 이미지로 "복사본"을 만드는 경로는 없다(마스터가 거부한 결과). */
    async _planRegionCopy(src, page, crop, name) {
      const canCopy = typeof App !== "undefined" && App._regionSource && App._createRegionCopyDeployment
        && App._attachSourcePdf && App._pickPdfFile && typeof PDF !== "undefined" && PDF.copyRegionToPdf;
      if (!canCopy) return { mode: "window" };   // 복사 모듈이 없는 구버전 번들 — 종전 창 방식
      const say = (m, ms) => { if (Prompt.toast) Prompt.toast(m, ms); };
      const askWindow = async (why) => (await this._confirmLabeled("기존 방식(창)으로 만들까요?",
        why + "\n\n창 방식은 원본 도면을 그대로 들여다보므로 확대하면 선명도에 한계가 있습니다.",
        "창 방식으로 만들기", "취소")) ? { mode: "window", limited: true } : (say("영역 추출을 취소했습니다"), null);

      say("원본 PDF 를 확인하는 중…", 2400);
      const s = (await App._regionSource(src.deployment_id, page)) || { error: "원본 확인 실패" };
      if (s.error) return await askWindow(s.error + " — 선명한 복사본을 만들 수 없습니다.");
      let bytes = s.bytes, expect = s.expect, attach = false;
      if (!bytes) {
        const up = await this._confirmLabeled("원본 PDF 가 없는 도면입니다",
          "이 도면은 원본 PDF 가 없어 확대하면 깨집니다.\n원본 PDF 를 올리면 지정한 부분을 선명한 새 페이지로 복사합니다.",
          "원본 PDF 올리기", "지금은 기존 방식으로");
        if (!up) return await askWindow("원본 PDF 없이 진행합니다.");
        const file = await App._pickPdfFile();
        if (!file) { say("영역 추출을 취소했습니다"); return null; }
        try { bytes = await file.arrayBuffer(); } catch (e) { say("파일을 읽지 못했습니다 — 다시 시도하세요"); return null; }
        const live = typeof State !== "undefined" && State.autoSaveDepId === src.deployment_id;
        expect = App._regionExpect ? App._regionExpect(null, s.snapCount, page, live) : null;
        attach = true;
      }
      let res = null;
      try { res = await PDF.copyRegionToPdf(bytes, page, crop, expect); }
      catch (e) {
        const msg = (e && e.message) || "알 수 없는 오류";
        if (!(e && e.code === "SIZE_MISMATCH")) {
          if (attach) { say("PDF 를 읽지 못했습니다 — " + msg); return null; }
          return await askWindow("원본 PDF 를 읽지 못했습니다(" + msg + ").");
        }
        if (!attach) return await askWindow("원본 PDF 와 화면의 도면이 맞지 않습니다 — " + msg + ".");
        // 사용자가 직접 고른 파일이 화면 도면과 다르다 — 엉뚱한 부분이 복사된다. 알고 진행할 때만 계속.
        const go = await this._confirmLabeled("다른 파일일 수 있습니다",
          msg + "\n화면의 도면과 다른 PDF 를 올리면 엉뚱한 부분이 복사됩니다.", "그래도 이 PDF 로 진행", "취소");
        if (!go) { say("영역 추출을 취소했습니다"); return null; }
        try { res = await PDF.copyRegionToPdf(bytes, page, crop, null); }
        catch (e2) { say("PDF 를 읽지 못했습니다 — " + ((e2 && e2.message) || "")); return null; }
      }
      if (attach) {
        say("원본 PDF 를 도면에 등록하는 중…", 2400);
        if (!(await App._attachSourcePdf(src.deployment_id, bytes))) { say("원본 PDF 등록 실패 — 네트워크를 확인하고 다시 시도하세요"); return null; }
      }
      say("지정한 부분을 새 페이지로 복사하는 중…", 2400);
      const depId = await App._createRegionCopyDeployment(name, res.bytes);
      if (!depId) { say("새 페이지 저장 실패 — 네트워크를 확인하고 다시 시도하세요"); return null; }
      return { depId, box: res.box };
    },

    /** Prompt.confirm 을 버튼 문구만 바꿔 쓴다(닫히면 원래 문구 복원 — 다른 확인창에 새지 않게).
     *  🔴 window.confirm 금지(PWA standalone 에서 무음 false). Prompt.confirm 이 없으면 "아니오". */
    async _confirmLabeled(title, msg, okLabel, cancelLabel) {
      if (typeof Prompt === "undefined" || !Prompt.confirm) return false;
      const p = Prompt.confirm(title, msg);
      const okB = document.getElementById("wm-confirm-ok");
      const noB = document.getElementById("wm-confirm-cancel");
      const prev = [okB ? okB.textContent : null, noB ? noB.textContent : null];
      if (okB && okLabel) okB.textContent = okLabel;
      if (noB && cancelLabel) noB.textContent = cancelLabel;
      try { return !!(await p); }
      finally { if (okB) okB.textContent = prev[0]; if (noB) noB.textContent = prev[1]; }
    },

    /** [WO 20260930-merge] 벡터 복사 구역의 "원본 상자" 기록(마이그레이션 0031) — 구역 합치기(41_RegionMerge)의 좌표 변환 전제.
     *  복사본은 새 1페이지 배포본 + crop:null 이라 이 기록이 없으면 두 구역의 공통 좌표계를 알 수 없다.
     *  · 원본 상자가 이미 기록된 복사본(src.src_crop)에서 다시 잘랐으면 **그 원본까지 합성**해 기준 배포본을 하나로 맞춘다
     *    (구역→영역이 같은 src_dep_id 를 공유해야 영역↔형제 구역 사이 변환이 된다). 합성 = MapCtrl.deckCropPctToPage(새 수식 0).
     *  · 그 외(원본 도면·창 구역·기록 없는 레거시 복사본)는 src 자신의 배포본 페이지 % 가 곧 기준이다.
     *  순수 함수. crop 이 없으면 {}(기록 안 함 — 서버 NULL). */
    _srcBoxFields(src, page, crop) {
      if (!src || !src.deployment_id || !crop || !(crop.w > 0) || !(crop.h > 0)) return {};
      const sc = src.src_crop;
      if (src.src_dep_id && sc && sc.w > 0 && sc.h > 0 && typeof MapCtrl !== "undefined" && MapCtrl.deckCropPctToPage) {
        const tl = MapCtrl.deckCropPctToPage(crop.x, crop.y, sc);
        const br = MapCtrl.deckCropPctToPage(crop.x + crop.w, crop.y + crop.h, sc);
        return { src_dep_id: String(src.src_dep_id), src_page: Number(src.src_page) || 1, src_crop: { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y } };
      }
      return { src_dep_id: String(src.deployment_id), src_page: Number(page) || 1, src_crop: { x: crop.x, y: crop.y, w: crop.w, h: crop.h } };
    },

    /** 영역(crop %) 안에 있는 그 페이지 핀 수 — 알림용 집계만(핀 배열은 읽기만 한다). 순수 함수. */
    _pinsInCrop(pins, page, crop) {
      if (!Array.isArray(pins) || !crop || !(crop.w > 0) || !(crop.h > 0)) return 0;
      const pg = page || 1, x1 = crop.x + crop.w, y1 = crop.y + crop.h;
      return pins.filter((p) => {
        if (!p || (p.page || 1) !== pg) return false;
        const x = Number(p.x), y = Number(p.y);
        return x >= crop.x && x <= x1 && y >= crop.y && y <= y1;
      }).length;
    },

    /** [WO 20260928 → 20260929 이음매 수정] "도면이 화면에 로드돼 있는가" 상태 판정.
     *  🔴 [WO 20260929·마스터 실사고] 원래 조건은 `decks.length === 0`(구역이 아예 없을 때)만
     *  전제해 "이미 다른 구역이 있는 프로젝트에서, 아직 저장 전인 도면을 화면에 띄워 놓고
     *  새 구역을 만들려는" 훨씬 흔한 경우를 놓쳤다 — 이때 도면이 뻔히 로드돼 있는데도
     *  ①이 비활성으로 보이는 실사고가 났다(마스터 스크린샷). 구역 개수는 이 판정과 무관하다:
     *  이미 저장된 도면(currentDeck.deployment_id)은 _chooseDeckSource 의 다른 분기가 처리하므로,
     *  여기는 오직 "화면에 도면이 떠 있는가"(State.fileType)만 보면 된다.
     *  🔴 판정을 한 곳에 모은다 — _chooseDeckSource(활성 조건)와 extractRegionAsDeck(위임 조건)이
     *  같은 사실을 각자 계산하면 반드시 갈라진다(§SoT). */
    _canExtractFromLoadedDrawing() {
      return !!(this.currentProject
        && typeof State !== "undefined" && !!State.fileType);
    },

    /** [WO 20260928·마스터 확정 → WO 20260928-unify 갱신] 🔴 "도면 있음 + 구역 0" 에서
     *  **첫 영역 지정 = 첫 구역 생성**.
     *  마스터 원문: "처음 도면을 등록했을 때는 구역 이름을 지정하게 하지 마. 1.프로젝트 2.구역 3.영역 이니까"
     *            / "구역을 등록할 때 기존 도면에서 영역을 지정할 건지 새로운 도면으로 할 건지 선택하게 해"
     *            / (WO 20260928-unify) "구역은 선택한 만큼을 남기고 나머지를 다 지우든 복사한 후 새로
     *              만들든 쉽게 빠르게해" → 구역(루트)도 영역과 **같은 벡터복사** 결과물이어야 한다.
     *
     *  도면 등록 단계에서는 어떤 행도 만들지 않으므로(20_App._afterDrawingLoaded), 이 함수가
     *  **배포본(deployments) + 구역(decks, parent_id=NULL)** 을 한 번에 묶어 확정한다.
     *  🔴 새 메커니즘 0 — 배포본은 App._ensureDrawingDeployment()(=기존 _createInitialSave),
     *  드래그는 기존 _pickDeckCrop(), **복사 계획은 extractRegionAsDeck 과 똑같이 _planRegionCopy()
     *  를 재사용**한다(복사 로직 두 벌 금지 — §SoT). 차이는 parent_id=null(루트) 뿐이다.
     *  extractRegionAsDeck() 자체를 통째로 재사용할 수 없는 이유는 그대로다: 그쪽은
     *  src.deployment_id(=**이미 저장된** 도면)를 전제하는데, 여기서는 그 배포본이 아직 없다
     *  (그래서 ①에서 먼저 확정한다).
     *
     *  순서(원자성): 영역·이름을 **먼저** 받는다 → 취소하면 서버에 아무것도 만들어지지 않는다.
     *  배포본까지 만들고 구역 INSERT 가 실패하면 State.autoSaveDepId 가 남아 재시도 시 **같은 배포본**을
     *  재사용하므로 고아 배포본이 누적되지 않는다.
     *
     *  좌표계: crop 은 _pickDeckCrop → MapCtrl.viewportToPercent 로 얻은 **페이지 기준 %** 다.
     *  _planRegionCopy 가 원본이 있으면 그 %를 PDF 상자로 바꿔 벡터 복사(crop:null 결과)하고,
     *  원본이 없는 구버전 도면이면 종전처럼 crop 이 그대로 저장된다(창 방식 — 원본 없음 분기와 동일 규칙).
     *  @param {object} [opts] { crop, name } — 선주입(미지정 시 드래그·프롬프트로 물음)
     *  @returns {Promise<object|null>} 생성된 구역(deck) 또는 null(취소/실패)
     */
    async createDeckFromLoadedDrawing(opts) {
      opts = opts || {};
      if (typeof Auth !== "undefined" && !Auth.isDesigner) { Prompt.toast && Prompt.toast("설계자만 구역을 만들 수 있습니다"); return null; }
      if (!this.currentProject) { Prompt.toast && Prompt.toast("먼저 프로젝트를 선택하세요"); return null; }
      if (typeof State === "undefined" || !State.fileType) { Prompt.toast && Prompt.toast("먼저 도면을 등록하세요 — 그 도면에서 영역을 지정해 구역을 만듭니다"); return null; }
      // 🔴 조용한 실패 금지 — 드래그 UI 를 띄우기 전에 끊는다(extractRegionAsDeck 과 같은 규칙).
      if (!navigator.onLine) { Prompt.toast && Prompt.toast("오프라인이라 지금은 구역을 만들 수 없습니다 — 연결 후 다시 시도하세요"); return null; }
      if (this._extractingRegion) return null;   // 연타 가드(extractRegionAsDeck 와 같은 플래그 — 동시 진행 금지)

      const crop = opts.crop || await this._pickDeckCrop("이 도면에서 구역이 될 영역을 드래그하세요 — Esc 를 누르면 취소됩니다");
      if (!crop || !(crop.w > 0) || !(crop.h > 0)) { Prompt.toast && Prompt.toast("구역 생성을 취소했습니다"); return null; }

      // 이름은 **영역을 지정한 뒤에** 묻는다(요구2) — 도면 등록 단계에서는 절대 묻지 않는다(요구1).
      let name = opts.name;
      if (name == null) {
        const res = await Prompt.ask({
          title: "구역 이름",
          sub: "지정한 영역을 어떤 구역으로 저장할까요? (나중에 바꿀 수 있습니다)",
          placeholder: "예: Main Deck, Engine Room, No.1 Hold",
          value: this._nextFreeName("구역")
        });
        if (!res) { Prompt.toast && Prompt.toast("구역 생성을 취소했습니다"); return null; }
        name = res.value;
      }
      name = String(name || "").trim() || this._nextFreeName("구역");
      const dup = (this.decks || []).find((x) => String(x.name).trim().toLowerCase() === name.toLowerCase());
      if (dup) { Prompt.toast && Prompt.toast("이미 '" + name + "' 구역이 있습니다 — 다른 이름을 쓰세요"); return null; }

      const page = (typeof State !== "undefined" && State.pdfPage) || 1;   // 지금 보고 있는 페이지(1-base)
      this._extractingRegion = true;
      try {
        // ① 로드된 도면을 서버 배포본으로 확정(이미 있으면 그걸 재사용 — 중복 배포본 0)
        const depId = (typeof App !== "undefined" && App._ensureDrawingDeployment)
          ? await App._ensureDrawingDeployment() : null;
        if (!depId) { Prompt.toast && Prompt.toast("도면 저장에 실패해 구역을 만들지 못했습니다 — 네트워크를 확인하고 다시 시도하세요"); return null; }
        // ② 🔴 공유 지점(§G-2-5) — extractRegionAsDeck 과 **같은** 벡터복사 계획 함수(_planRegionCopy).
        //   차이는 parent_id=null(루트) 뿐 — 원본이 있으면 벡터 복사(crop:null), 없으면 종전 창 방식으로
        //   묻는 분기까지 그대로 공유한다(복사 로직 두 벌 금지).
        const plan = await this._planRegionCopy({ deployment_id: depId }, page, crop, name);
        if (!plan) return null;   // 취소/실패 — 사유는 _planRegionCopy 가 이미 화면에 알렸다
        // ③ 구역(루트) INSERT — 프로젝트 > 구역 > 영역 에서 이 구역은 최상위라 parent_id = NULL.
        const r = await fetch("/api/projects/" + this.currentProject.id + "/decks", {
          method: "POST", headers: Auth.headers(),
          // 복사본: 새 배포본(그 페이지 자체가 구역) · 창 방식(원본 없는 구버전 도면): 로드된 도면 + crop.
          body: JSON.stringify(this._withDeckMode(plan.depId   // [WO 20260930-fixmode] 활성 모드 태그
            // [WO 20260930-merge] 복사본은 원본 상자(src_*) 기록 — 합치기 좌표 변환의 전제(_srcBoxFields)
            ? Object.assign({ name, page: 1, crop: null, deployment_id: plan.depId, parent_id: null }, this._srcBoxFields({ deployment_id: depId }, page, crop))
            : { name, page, crop, deployment_id: depId, parent_id: null }))
        });
        const d = await r.json();
        if (!r.ok) { Prompt.toast && Prompt.toast((d && d.error) || "구역 생성 실패 — 권한을 확인하세요"); return null; }
        await this.loadDecks();
        const created = (this.decks || []).find((x) => x.id === d.id) || d;
        // ④ 이 구역을 현재 컨텍스트로 — 이후 저장/배포/핀이 이 구역에 붙는다(고아 배포본 방지).
        this.currentDeck = created;
        if (typeof App !== "undefined") App._pendingDeckLink = null;   // 배포본은 이미 구역에 직결됨
        this._renderDecks();
        // 🔴 마스터 확정: "바운더리를 선택하면 그 바운더리를 잘라서 별도의 페이지로 구성" →
        //   생성 직후 그 구역을 **독립 페이지처럼** 연다(공유 지점 _applyDeckCropView — selectDeck 과 동일).
        //   이 상태에서 다시 드래그하면 이 구역 하위의 '영역'이 된다(계층 3단: 프로젝트>구역>영역).
        this._applyDeckCropView(created);
        Prompt.toast && Prompt.toast((plan.depId
          ? "구역 '" + name + "' 생성 — 지정한 부분을 새 페이지로 복사했습니다(확대해도 선명)"
          : "구역 '" + name + "' 생성 — 잘라낸 영역이 별도 페이지로 열렸습니다")
          + (plan.limited ? " · 원본 PDF 가 없어 확대 시 선명도에 한계가 있습니다" : "")
          + ". 다시 드래그하면 이 구역 안의 '영역'이 됩니다", plan.limited ? 5200 : 4200);
        return created;
      } catch (e) {
        Prompt.toast && Prompt.toast(navigator.onLine ? "구역 생성 실패 — 네트워크 오류, 다시 시도해주세요" : "오프라인이라 지금은 구역을 만들 수 없습니다");
        return null;
      } finally { this._extractingRegion = false; }
    },

    /** 자동 제안 이름 — "<base> N". 이미 쓰는 이름이면 N 을 올려 항상 비어 있는 이름을 준다.
     *  🔴 **제안값일 뿐 확정이 아니다** — 호출부는 반드시 사용자에게 물어 고칠 기회를 준다
     *  (도면 등록만으로 이름이 자동 확정되는 옛 동작은 금지 — 마스터 확정 WO 20260928). */
    _nextFreeName(base) {
      base = String(base || "구역").trim();
      const taken = new Set((this.decks || []).map((x) => String(x.name).trim().toLowerCase()));
      let n = 1;
      while (taken.has((base + " " + n).toLowerCase())) n++;
      return base + " " + n;
    },

    /** 추출 영역의 기본 이름 — "<원본이름> 영역 N". (구현 SoT = _nextFreeName) */
    _nextRegionName(srcName) {
      return this._nextFreeName(String(srcName || "도면").trim() + " 영역");
    },

    async deleteDeck(id, name) {
      if (!await Prompt.confirm("구역 삭제", `구역 '${name}' 를 삭제할까요?`)) return;
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
        this._applyDeckCropView(d);
      } else if (!d.deployment_id && typeof State !== "undefined" && State.mode === "designer" && typeof App !== "undefined" && App.offerDeckDrawingLink) {
        App.offerDeckDrawingLink(d);
      }
    },

    /** [WO 20260929-tree1] 🔴 공유 지점(SoT) — "이 프로젝트의 원본 전체 도면"이 어느 구역인지
     *  판정하는 규칙 하나. 사이드바 트리(openOriginal, 아래)와 프로젝트 재진입/허브 카드 클릭
     *  (20_App.js loadLatestDeployment)이 각자 고르면 반드시 갈라진다(§10 SoT). 규칙: 루트 구역
     *  (parent_id NULL — "구역" 단, "영역" 아님) 중 가장 최근 생성분. 루트가 없으면 null(지어내지
     *  않음 — 아직 도면만 등록되고 구역이 하나도 없는 구간은 이 함수로도 찾을 수 없다: deployments
     *  테이블에 project_id 가 없어 client 에서 조회 불가 — RECON 2026-09-29, src/index.tsx 변경 필요). */
    /** [WO 20260930-WP3 · C3] 서버가 원본으로 기록했다고 응답한 배포본을 로컬 프로젝트 객체에 반영
     *  (App._createInitialSave 의 is_project_original 응답 → 재조회 없이 pickOriginalDeck 이 바로 쓴다). */
    markOriginal(projectId, depId) {
      if (!projectId || !depId) return;
      for (const p of [this.currentProject].concat(this.list || [])) {
        if (p && p.id === projectId && !p.original_deployment_id) p.original_deployment_id = depId;
      }
    },

    pickOriginalDeck(decks, project) {
      decks = decks || [];
      // [WO 20260930-WP3 · C3] 🔴 1순위 = 서버 기록(projects.original_deployment_id — 처음 등록한 전체 도면).
      //   종전 규칙(최신 루트 구역)은 구역 **복사본**을 골랐다(p93 C3 실측). 그 배포본을 가리키는 루트·전체(crop 없음)
      //   구역이 있으면 그 구역, 없으면 구역 없는 원본 서술자(id:null — 호출부는 currentDeck=null 로 연다).
      //   기록이 없는 레거시 프로젝트만 아래 종전 규칙으로 폴백한다(기존 데이터 호환).
      const proj = project !== undefined ? project : this.currentProject;
      const origId = proj && proj.original_deployment_id;
      if (origId) {
        const own = decks.find((d) => d && d.deployment_id === origId && d.parent_id == null && !d.crop);
        return own || { id: null, deployment_id: origId, parent_id: null, crop: null, page: null, name: (proj && proj.name) || "원본", original: true };
      }
      // [WO 20260929-parent-guard] 🔴 SoT — 고아 판정(부모가 없거나 목록에 없음)은
      // UI.groupDecksByParent(11_UI.js)와 공유한다. 예전엔 parent_id==null 만 루트로 쳐서,
      // 오염 데이터(부모가 다른/삭제된 프로젝트의 deck)를 가리키는 deck 이 영원히 "원본 없음"으로
      // 숨어버렸다(재현 2026-09-29: sunbo 프로젝트 floor 구역). groupDecksByParent 는 이미
      // "부모가 이 decks 목록에 없으면 최상위로 승격"을 하므로 같은 함수를 재사용한다(로직 두 벌 금지).
      const roots = (typeof UI !== "undefined" && UI.groupDecksByParent)
        ? UI.groupDecksByParent(decks).roots.filter((d) => d && d.deployment_id)
        : decks.filter((d) => d && d.deployment_id && d.parent_id == null);
      if (!roots.length) return null;
      const ts = (d) => { const v = d.created_at; const n = typeof v === "number" ? v : Date.parse(v); return Number.isFinite(n) ? n : 0; };
      return roots.slice().sort((a, b) => ts(b) - ts(a))[0];
    },

    /** [WO 20260929-tree1] 🔴 마스터: "상위 프로젝트를 클릭하면 [원본 전체 도면이] 나오게 해".
     *  🔴 정직한 한계(데이터 구조 확인 결과, RECON 2026-09-29): deployments 테이블엔 project_id 가
     *  없다(테넌트 단위) — 구역(decks)에 연결된 배포본만 프로젝트 소속으로 알 수 있다. 벡터복사로
     *  만든 구역(정착 PDF 있는 경우 다수)은 원본과 **다른** 새 배포본을 가리키므로 "구역이 하나도
     *  안 생긴 채" 등록만 된 도면은 이 함수로도 못 찾는다(서버에 project_id 컬럼 추가가 필요 —
     *  src/index.tsx 밖이라 이 발주 범위 아님, 지휘자 보고 대상).
     *  이 함수가 실제로 하는 일: **가장 단순한 선택** — 프로젝트의 루트 구역(parent_id NULL, 2단 중
     *  "구역") 가운데 가장 최근 생성분을 그 구역 **자신의 crop 을 무시하고** 전체 페이지로 연다.
     *  루트 구역은 항상 생성 시점에 crop:null(벡터복사) 이거나 그 구역 자체가 원본이므로
     *  이 선택이 "원본 전체 도면"에 가장 가깝다. 루트가 여럿이면(도면 여러 장 등록) 최신 1장을
     *  열고, 나머지는 트리에 이미 목록으로 나열돼 있다(추가 UI 0). */
    async openOriginal() {
      const latest = this.pickOriginalDeck(this.decks);
      if (!latest) { Prompt.toast && Prompt.toast("등록된 원본 도면이 없습니다 — '도면 등록'으로 먼저 올리세요"); return; }
      const rootCount = (this.decks || []).filter((d) => d && d.deployment_id && d.parent_id == null).length;
      this.currentDeck = latest.id ? latest : null;   // [WP3 · C3] 구역 없는 원본 = 프로젝트 단위(nodeck)
      this._renderDecks();
      if (typeof App !== "undefined" && App.loadDeckDrawing) {
        await App.loadDeckDrawing(latest.deployment_id);
        if (latest.page && typeof App._gotoPage === "function") { try { await App._gotoPage(latest.page); } catch (e) {} }
      }
      // 🔴 원본 전체 — 이 구역의 crop 은 무시(항상 null) — selectDeck 과 달리 여기는 "전체" 보장이 목적.
      // 🔴 [실측 발견] _applyDeckCropView 는 "낡은 구역 맞춤 방지" 가드로 this.currentDeck.id 와
      //   인자 d.id 를 비교한다(31_Projects.js _applyDeckCropView). {name,crop} 만 담은 새 객체를
      //   넘기면 d.id 가 undefined 라 가드가 항상 참이 되어 MapCtrl.fit() 이 스킵되고 캔버스가
      //   빈 화면으로 남는다(CDP 실측) — latest 를 얕은 복제해 id 를 보존한다.
      const label = (this.currentProject && this.currentProject.name)
        ? this.currentProject.name + (rootCount > 1 ? " · 원본" : "")
        : latest.name;
      this._applyDeckCropView(Object.assign({}, latest, { name: label, crop: null }));
    },

    /** [WO 20261001-projectinfo] 트리 "원본 미지정 — [지정]" 버튼의 유일한 진입점(SoT) —
     *  현재 열린 도면을 projects.original_deployment_id 로 서버에 기록한다. 권한은 서버가 최종
     *  판정(canManageMembersOf — 소유자·super)하고, 클라는 can_manage_members 로 버튼을 가린다. */
    async setOriginalToCurrent() {
      if (!this.currentProject) return;
      if (!this.currentProject.can_manage_members) { Prompt.toast && Prompt.toast("권한이 없습니다(소유자/관리자만)"); return; }
      const depId = (this.currentDeck && this.currentDeck.deployment_id) || (typeof State !== "undefined" && State.currentDeploymentId);
      if (!depId) { Prompt.toast && Prompt.toast("먼저 도면을 열어야 원본으로 지정할 수 있습니다"); return; }
      if (typeof Prompt !== "undefined" && Prompt.confirm && !(await Prompt.confirm("원본 지정", "현재 열린 도면을 이 프로젝트의 원본으로 지정할까요?"))) return;
      try {
        const r = await fetch("/api/projects/" + this.currentProject.id, {
          method: "PATCH", headers: Object.assign({ "Content-Type": "application/json" }, Auth.headers()),
          body: JSON.stringify({ original_deployment_id: depId }),
        });
        if (!r.ok) { Prompt.toast && Prompt.toast("지정 실패(" + r.status + ")"); return; }
        const j = await r.json().catch(() => ({}));
        if (j && j.data) Object.assign(this.currentProject, j.data);
        Prompt.toast && Prompt.toast("원본으로 지정했습니다");
        if (typeof UI !== "undefined" && UI.renderTree) UI.renderTree();
      } catch (e) { Prompt.toast && Prompt.toast("지정 실패(네트워크)"); }
    },

    /** [WO 20261001-projectinfo] 프로젝트 이름 변경 — 허브 카드 ✎ / 트리 프로젝트 노드 [이름변경] 가
     *  공유하는 유일한 진입점(SoT). proj 생략 시 currentProject(트리 호출부). 허브 카드는 목록의 임의
     *  프로젝트 객체를 넘긴다(편집 화면 상태를 건드리지 않는다). 권한은 서버 PATCH 가 최종 판정(소유자·super). */
    async renameProject(proj) {
      const target = proj || this.currentProject;
      if (!target) return;
      if (!target.can_manage_members) { Prompt.toast && Prompt.toast("권한이 없습니다(소유자/관리자만)"); return; }
      if (typeof Prompt === "undefined" || !Prompt.ask) return;
      const r0 = await Prompt.ask({ title: "프로젝트 이름 변경", value: target.name, placeholder: "프로젝트 이름(1~80자)" });
      if (!r0 || !r0.value) return;
      const name = r0.value.trim();
      if (!name || name.length > 80) { Prompt.toast && Prompt.toast("이름은 1~80자여야 합니다"); return; }
      try {
        const r = await fetch("/api/projects/" + target.id, {
          method: "PATCH", headers: Object.assign({ "Content-Type": "application/json" }, Auth.headers()),
          body: JSON.stringify({ name }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { Prompt.toast && Prompt.toast(j.error || ("변경 실패(" + r.status + ")")); return; }
        if (j && j.data) Object.assign(target, j.data);
        const li = (this.list || []).find((p) => p.id === target.id);
        if (li && li !== target) Object.assign(li, j.data || { name });
        if (this.currentProject && this.currentProject.id === target.id) {
          if (typeof State !== "undefined") State.currentProjectName = target.name;
          if (typeof UI !== "undefined" && UI.renderTree) UI.renderTree();
        }
        if (typeof ProjectHub !== "undefined") {
          const hli = (ProjectHub.list || []).find((p) => p.id === target.id);
          if (hli) Object.assign(hli, j.data || { name });
          if (ProjectHub.refreshIfVisible) ProjectHub.refreshIfVisible();
        }
        Prompt.toast && Prompt.toast("이름을 변경했습니다");
      } catch (e) { Prompt.toast && Prompt.toast("변경 실패(네트워크)"); }
    },

    /** 🔴 [WO 20260928] "바운더리를 잘라서 별도의 페이지로 구성" (마스터 확정) —
     *  구역(crop 보유)을 **독립 페이지처럼** 화면에 적용한다: 크롭 렌더 대상 고정 + 그 영역으로 화면 맞춤.
     *  🔴 비파괴 — 원본 PDF/배포본은 그대로고, 이건 원본을 들여다보는 **창(view)** 이다(픽셀 재저장 0).
     *  🔴 공유 지점(§G-2-5): selectDeck(트리에서 열기)과 createDeckFromLoadedDrawing(첫 구역 생성 직후)이
     *  같은 3줄을 각자 들고 있으면 반드시 갈라진다 → 여기 한 곳에서만 한다.
     *  crop 없는 구버전 구역은 null 로 해제해 종전대로 전체 페이지 렌더(회귀 0). */
    _applyDeckCropView(d) {
      try { document.body.classList.toggle("deck-view-active", !!(d && d.crop)); } catch (e) {}
      // [WO 20260929-title] 🔴 관찰: 구역/영역을 열어도(생성 직후 포함) 상단 헤더 제목
      // (#file-name-label)이 원본 도면 파일명에 그대로 머물렀다 — SoT 는 여기 하나
      // (selectDeck·createDeckFromLoadedDrawing 공유 지점)뿐, 다른 곳에서 또 갱신하지 않는다.
      try {
        if (typeof UI !== "undefined" && UI.text) {
          UI.text("file-name-label", (d && d.name) ? d.name : "도면 없음");
        }
      } catch (e) {}
      const crop = (d && d.crop) || null;
      if (typeof PDF !== "undefined" && PDF.setDeckCrop) PDF.setDeckCrop(crop);
      // 🔴 [WO 20260929-fitrace2] 근본원인(실브라우저 호출스택 확정) — 맞춤 시점을 img.complete 로
      //   판정했다. data: URL 도면은 img.complete 가 load 이벤트보다 **먼저** true 가 되므로, 여기서
      //   즉시 fitZone 을 불렀지만 그 순간 #map-viewport 는 아직 hidden(0×0) → fitZone 내부 가드로
      //   조용히 무시되고, 2ms 뒤 load 이벤트의 _r0→App._showMapViewport() 가 zoom=1/pan=0 으로
      //   identity 를 썼다(prod 재현: matrix(1,0,0,1,0,0) + 클립만 적용). 이미지 준비가 아니라
      //   "로더의 표시(리셋) 완료"가 진짜 전제조건이다 → App.whenDisplayed()(20_App.js, SoT)를 기다린다.
      //   두 분기(crop 창 방식 / crop 없는 벡터복사)가 같은 신호를 공유한다 — 따로 타이밍을 잡으면 갈라진다.
      //   🔴 parent_id 로 가르지 않는다(SoT) — crop 없음 = 복사본(페이지 전체 맞춤), crop 있음 = 구버전 창.
      const wantFit = crop ? (typeof MapCtrl !== "undefined" && MapCtrl.fitZone)
                           : (!!d && typeof MapCtrl !== "undefined" && MapCtrl.fit);
      if (wantFit) {
        const ready = (typeof App !== "undefined" && App.whenDisplayed) ? App.whenDisplayed() : Promise.resolve(true);
        ready.then((shown) => {
          if (!shown) return;   // 표시 전에 다른 로드가 시작됨 — 낡은 구역 맞춤 금지
          // 빠른 연속 전환 가드 — 그 사이 다른 구역으로 바뀌었으면 낡은 crop 을 적용하지 않는다.
          if (this.currentDeck && d && this.currentDeck.id !== d.id) return;
          if (crop) MapCtrl.fitZone(crop, 0.14, 640);
          else MapCtrl.fit();
        });
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
        // [WO 20260918-B] 도면에서 긁어낸 영역(crop 보유)은 목록에서 한눈에 구분되어야 한다(요구④).
        //   새 CSS 없이 기존 .deck-hasdoc 스타일을 그대로 쓰고 아이콘/툴팁만 바꾼다.
        const isRegion = !!(d.crop && d.crop.w > 0 && d.crop.h > 0);
        const dot = isRegion
          ? '<span class="deck-hasdoc" title="도면에서 긁어낸 영역 — 원본 도면은 그대로입니다"><i class="fa-solid fa-crop-simple"></i></span>'
          : hasDoc
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

    /** [WO 20260929-tree1] 🔴 근본수정 — 예전엔 여기서 #side-tree.innerHTML 을 직접 덮어써
     *  UI.renderTree() 가 방금 그 안에 옮겨 붙인 #project-actions(다운로드·삭제, 실 DOM)를
     *  통째로 파괴했다(CDP 실측 — getElementById('project-actions') 가 null 이 됨, 영구 소실).
     *  근본 원인은 "#side-tree 를 두 함수가 각자 그린다"였다(§10 SoT 위반) — CTA 안내
     *  두 갈래(도면 있음/없음)를 UI.renderTree() 안으로 옮겼다(11_UI.js, mountProjectNode 옆).
     *  이 함수는 이제 그 SoT 하나로 위임만 한다(호출부 0곳 변경 — _renderDecks() 그대로 호출). */
    _renderSideTreeEmpty() {
      if (typeof UI !== "undefined" && UI.renderTree) UI.renderTree();
    },

    /** [WO 20260928] 🔴 옛 '구역 선행 강제' 게이트의 **시각적 절반**이었다 — 구역이 0개면 업로드
     *  버튼을 "먼저 구역을 등록하세요" 로 바꿔 잠갔다. 도면 등록은 이제 구역을 전제하지 않으므로
     *  잠금을 없애고(항상 해제), 힌트로 다음 행동만 알린다(조용한 차단·빈 화면 금지).
     *  🔴 함수를 지우지 않는 이유: _renderDecks() 가 부르는 유일한 '업로드 버튼 상태 동기화' 지점이라,
     *  잠금을 지우고도 origText 원복·힌트 갱신은 계속 필요하다(호출부 분열 금지). */
    _syncUploadLock() {
      const btn = document.getElementById("btn-upload-drawing");
      const hint = document.getElementById("upload-zone-hint");
      if (btn) {
        btn.classList.remove("upload-locked");
        btn.setAttribute("aria-disabled", "false");
        if (btn.dataset.origText) btn.textContent = btn.dataset.origText;
      }
      if (hint) {
        hint.textContent = (this.decks || []).length > 0
          ? "구역을 선택하면 해당 구역에 도면이 등록·자동저장됩니다."
          : "도면을 등록한 뒤, 그 도면에서 영역을 지정하면 구역이 만들어집니다.";
      }
    },

    _esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
  };
