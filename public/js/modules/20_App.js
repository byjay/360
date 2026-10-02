  const App = {

    async init() {
      Brand.apply();
      this._bindHome();
      this._bindTopbar();
      this._bindSidebar();
      // 모바일: 영역 지정 도구를 기본 접힘으로 시작(화면 가림 방지)
      try {
        const ztw = document.getElementById("zone-tools-wrap");
        const narrowOrTouch = window.matchMedia && (window.matchMedia("(max-width: 640px)").matches || window.matchMedia("(pointer: coarse)").matches);
        if (ztw && narrowOrTouch) {
          ztw.removeAttribute("open");
        }
      } catch (e) {}
      this._bindMap();
      this._bindPano();
      MapCtrl.init(UI.$("map-viewport"), UI.$("map-transform"));
      PanoViewer.init(UI.$("pano-canvas"));
      AllPins.init();
      try { if (UI.mountCheckerAlignTools) UI.mountCheckerAlignTools(); } catch (e) {}   // [WO 20261002-allmenu §2] 정렬 상시 노출
      try { State.pinColor = PinPrefs.get(); } catch (e) {}  // 저장된 핀 색상 복원(기본 그린)
      // [버그①수정 2026-08-31] Auth.init()이 async(데모 자동로그인 refresh 포함)로 바뀌어 await 필요 —
      // ProjectHub가 프로젝트 목록을 불러오기 전에 로그인 토큰 세팅이 반드시 끝나 있어야 한다.
      await Auth.init();
      Settings.init();
      if (typeof NumBand !== "undefined") NumBand.init();   // [WO 20261001-startno] 번호 대역 메뉴
      Designers.init();
      if (typeof UserMgmt !== "undefined") UserMgmt.init();
      if (typeof ThetaIntake !== "undefined") ThetaIntake.init();
      if (typeof PdfPopup !== "undefined") PdfPopup.init();
      // [고아 방지] 35_PhotoBatch 는 자체 init() 안에서만 버튼을 바인딩한다 —
      //   여기서 부르지 않으면 번들에는 있는데 버튼이 죽는다(전역 CLAUDE.md §5 렌더 고아).
      if (typeof PhotoBatch !== "undefined") PhotoBatch.init();
      // [고아 방지] 36_Help 도 자체 init() 안에서만 토글 버튼/배지를 바인딩한다 —
      //   여기서 부르지 않으면 번들에는 있는데 도움말이 뜨지 않는다(전역 CLAUDE.md §5 렌더 고아).
      if (typeof Help !== "undefined") Help.init();
      // [WO 20261001-viewreq] 열람자 요청·질문 + 디자이너 요청함 — 진입 버튼은 이 init 이 만든다(고아 방지).
      if (typeof Requests !== "undefined") Requests.init();
      Prompt.init();
      Projects.init();
      ProjectHub.init();
      PanoNav.init();
      Notes.init();
      TimeLapse.init();
      Zones.init();
      Inspector.init();
      PinGrid.init();
      PinActionPop.init();
      CompanyAuth.init();
      PdfAnno.init();
      this._bindMobileNav();
      // 최상위 관리자 패널(기능관장·AI·코드맵) 초기화 + 기능 온오프 UI 반영
      if (typeof AdminPanels !== "undefined") { AdminPanels.init(); AdminPanels.applyFeaturesToUI(); }
      // 오프라인 우선 동기화 큐 — 배지 갱신 구독 + 자동 동기화 시작
      SyncQueue.onChange(() => this._updateSyncBadge());
      SyncQueue.init();
      this._updateSyncBadge();
      // 온라인 복귀 시 로컬에 보관된(dirty) 도면 draft + 오프라인 첨부(사진/PDF) 큐를 서버로 자동 업로드
      //   + [마스터 요청] 미연결 도면↔구역 연결도 함께 재시도(중지/새로고침 복구)
      //   SyncQueue._onReconnect() 가 첨부 flush(_syncing 가드)+도면 draft+OpLog 를 순서대로 처리(기존 가드 재사용).
      window.addEventListener("online", () => {
        setTimeout(() => SyncQueue._onReconnect(), 600);
        setTimeout(() => this._flushDeckLinkQueue(), 800);
      });
      if (navigator.onLine) {
        setTimeout(() => SyncQueue._onReconnect(), 1500);
        setTimeout(() => this._flushDeckLinkQueue(), 1800);
      }
      // [설계서 D4] 다른 사용자 변경 자동 반영(20초 버전 폴링 — 보임·온라인·편집 화면일 때만)
      this._livePollInit();
    },

    /* ── Home ── */
    _bindHome() {
      document.querySelectorAll(".mode-card").forEach(card => {
        const open = () => {
          const mode = card.dataset.mode;
          // 설계자(디자이너) 모드는 구글 로그인 + 디자이너 권한 필요. 일반인은 뷰어만.
          if (mode === "designer") {
            // [마스터 요청 2026-09-18] 편집 진입 기본 모드 = 체크보드(사용자가 전환하면 그 선택을 기억)
            Auth.requireDesigner(() => this.openApp(PinSeries.preferredMode()));
            return;
          }
          this.openApp(mode);
        };
        card.addEventListener("click", open);
        card.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") open(); });
      });
    },

    openApp(mode, opts) {
      // 체크보드/사진등록 모드: 내부적으로 디자이너와 동일하게 동작(도면등록/핀 추가/이동/삭제).
      // 🔴 [WO 20260929 3모드 재설계] 편집화면 SoT = State.regMode('view'|'checkboard'|'photo').
      //   State.checkboard(번호핀 계열 여부)는 이 값에서만 파생한다(전역 CLAUDE.md §10 SoT —
      //   여러 곳에서 따로 세팅하면 반드시 갈라진다).
      const isCheckboard = mode === "checkboard";
      const isPhoto = mode === "photo";
      const isQuickTool = isCheckboard || isPhoto; // 번호핀 계열 공용(시각 강조색도 공유)
      State.checkboard = isQuickTool;
      State.mode = isQuickTool ? "designer" : mode;   // 도구 분기(mode==='designer')를 그대로 재사용
      if (mode === "designer" || isQuickTool) {
        State.regMode = isCheckboard ? "checkboard" : (isPhoto ? "photo" : "view");
      }
      opts = opts || {};
      const isDesigner = State.mode === "designer";
      if (typeof Log !== "undefined") Log.push(mode === "viewer" ? "viewer.open" : "app.open", null, { mode });
      // 모바일 하단 네비 designer-only 버튼 표시/숨김용 body 클래스
      document.body.classList.toggle("role-designer", isDesigner);
      document.body.classList.toggle("role-viewer", !isDesigner);
      document.body.classList.toggle("mode-checkboard", isCheckboard);
      // [WO 20261001-viewreq] 역할 클래스가 바뀌는 유일한 지점 — 요청 진입 버튼(뷰어 [요청·질문] / 디자이너 [요청함]) 동기화
      if (typeof Requests !== "undefined" && Requests.refresh) Requests.refresh();
      const accentVar = isQuickTool ? "var(--blue)" : (isDesigner ? "var(--gold)" : "var(--green)");
      document.documentElement.style.setProperty("--accent", accentVar);
      UI.$("topbar").style.borderBottomColor = isQuickTool ? "rgba(47,109,181,.28)" : (isDesigner ? "rgba(245,158,11,.2)" : "rgba(16,185,129,.2)");
      const dot = UI.$("topbar-dot");
      if (dot) dot.style.background = accentVar;
      // [마스터 요청 N5] "DESIGNER MODE" 글자 → 아이콘화 (글자 안어울림)
      const _modeIcon = isQuickTool
        ? '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>'
        : isDesigner
        ? '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>'
        : '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';
      const _ml = UI.$("mode-label");
      if (_ml) {
        _ml.innerHTML = _modeIcon;
        _ml.style.color = accentVar;
        _ml.title = isCheckboard ? "CHECKER 모드" : isPhoto ? "360 모드" : (isDesigner ? "편집모드" : "뷰어 모드");
        _ml.style.display = "inline-flex"; _ml.style.alignItems = "center";
      }

      // ── 뷰어는 "보기 전용". 업로드/편집/배포 관련 UI는 모두 숨긴다. ──
      //  (사용자 요청: "뷰어는 업로드가 왜 필요하지. 뷰어만 완벽하게 되게 만들어")
      UI.toggle("section-projects",  isDesigner);   // 프로젝트/데크 관리
      UI.toggle("section-upload",    isDesigner);   // 도면 업로드
      // [WO 20260929] 보기(view) 모드는 "생성 없음" — 배치 진입 UI 자체를 숨긴다(단일 SoT는
      // _togglePlacing() 가드가 진짜 관문이고, 여기는 그 상태를 화면에 반영만 한다).
      UI.toggle("section-place",     isDesigner && State.regMode !== "view");   // 위치 포인트 추가
      UI.toggle("section-checkboard", isDesigner);  // 체크보드 상설 메뉴 (디자이너 전용)
      // 체크보드 메뉴 카드의 진입 버튼 라벨/활성 상태 동기화
      try {
        const cbEnter = UI.$("btn-checkboard-enter");
        const cbEnterLbl = UI.$("btn-checkboard-enter-label");
        if (cbEnter) cbEnter.classList.toggle("active", isCheckboard);
        if (cbEnterLbl) cbEnterLbl.textContent = isCheckboard ? "CHECKER 모드 사용 중" : "CHECKER 모드 시작";
        if (isCheckboard) App._updateCheckboardQuickStatus(State.pdfPage || 1);
        // [마스터 요청 2026-09-03] 배치 전 종류 선택 그리드 — 체크보드 상설 메뉴가 보일 때 렌더
        //   (isDesigner 이면 항상, quickpoint/checkboard-enter 진입 전에도 미리 준비되게).
        if (isDesigner) App._renderIconPicker("cb-icon-grid", "cb-icon-label");
      } catch (e) {}
      if (typeof Zones !== "undefined") Zones.renderList(); // 영역 목록(디자이너=항상, 뷰어=영역 있을 때)
      UI.toggle("section-export",    isDesigner);   // 뷰어로 배포
      // 핀 편집 폼은 사이드바가 아닌 도면 위 플로팅 패널 — 시작 시 닫힘
      this._closePinForm();
      UI.toggle("section-next-point", false);
      UI.toggle("btn-import-json",   false);        // JSON 가져오기 — 뷰어/디자이너 모두 숨김
      UI.toggle("section-viewer-load", !isDesigner); // 뷰어 로드 상태 표시

      // ── [마스터 규칙·G1 버그수정] 도면 빈화면(drop-hint) 문구를 모드별로 분기 ──
      //  디자이너: "도면을 업로드하세요 / ＋탭하여 도면 등록"(CTA 노출)
      //  뷰어    : "디자이너가 배포한 도면을 기다리는 중" — 등록 CTA는 절대 노출하지 않음
      try {
        const dIcon = UI.$("drop-icon"), dText = UI.$("drop-text");
        const dSub  = UI.$("drop-sub"),  dCta  = UI.$("drop-tap-cta");
        if (dCta) { dCta.classList.toggle("hidden", !isDesigner); dCta.style.display = isDesigner ? "" : "none"; }
        if (isDesigner) {
          if (dIcon) dIcon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="30" height="30" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
          if (dText) dText.textContent = "도면을 업로드하세요";
          if (dSub)  dSub.textContent  = "PDF · PNG · JPG 지원";
        } else {
          if (dIcon) dIcon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="30" height="30" aria-hidden="true"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>';
          if (dText) dText.textContent = "배포된 도면을 기다리는 중";
          if (dSub)  dSub.textContent  = "설계자가 도면을 배포하면 자동으로 표시됩니다";
        }
      } catch (e) {}

      if (isDesigner) {
        // [버그수정] 프로젝트 진입 시 구역(deck) 목록을 '즉시' 로드.
        //   기존엔 list만 로드하고 loadDecks 를 안 불러 → 처음 들어가면 구역이 안 보이고,
        //   새 구역을 만들어야(createDeck→loadDecks) 그제서야 전체가 보이는 회귀였다.
        Promise.resolve(Projects.load()).then(() => {
          if (Projects.currentProject && Projects.loadDecks) return Projects.loadDecks();
        }).catch(() => {});
        // [마스터 요청] 디자이너 진입 시 미연결 도면↔구역 연결 재시도(복구)
        setTimeout(() => this._flushDeckLinkQueue(), 1200);
      }

      if (!isDesigner) {
        // 뷰어 전용 링크(?mode=viewer)로 진입한 경우 홈 버튼도 숨긴다.
        if (State.viewerLocked) UI.$("btn-back").style.display = "none";
      } else {
        UI.$("btn-back").style.display = "";
      }

      UI.$("pin-empty").textContent = isDesigner
        ? "포인트를 추가하세요"
        : "배포된 포인트를 불러오는 중...";

      // ── A안 topbar 버튼 ──
      // 설정 버튼은 항상 노출(로그인·편집 전환 진입점)
      const btnSettings = UI.$("btn-settings");
      if (btnSettings) btnSettings.classList.remove("hidden");
      // [마스터 2026-09-13] 뷰어는 배포 링크 전용 — 앱 안에서 뷰어로 나가는 문을 닫는다(항상 숨김, exitEdit()은 남겨둠).
      const btnExit = UI.$("btn-exit-edit");
      if (btnExit) btnExit.classList.add("hidden");
      // "설계자 모드" 버튼: 설계자 권한이 있는데 지금 뷰어 모드일 때만 노출(회귀 방지)
      const btnEnter = UI.$("btn-enter-edit");
      if (btnEnter) btnEnter.classList.toggle("hidden", isDesigner || !Auth.isDesigner);
      // ←(뒤로) 버튼: 프로젝트 허브로 돌아가기 (뷰어 전용 잠금 링크에서는 숨김)
      const btnBack = UI.$("btn-back");
      if (btnBack) btnBack.style.display = State.viewerLocked ? "none" : "";

      // 진입한 프로젝트명을 topbar에 표시 (있을 때)
      if (opts.project && opts.project.name) {
        UI.text("file-name-label", opts.project.name);
        State.currentProjectId = opts.project.id;
        State.currentProjectName = opts.project.name;
      }

      // 체크보드 모드 UI 반영: 토글 버튼 활성 + 배치 버튼 라벨 변경
      const cbBtn = UI.$("btn-checkboard-enter");
      if (cbBtn) cbBtn.classList.toggle("active", isCheckboard);
      const cbLabel = UI.$("btn-checkboard-enter-label");
      if (cbLabel) cbLabel.textContent = isCheckboard ? "CHECKER 모드 사용 중" : "CHECKER 모드 시작";
      const placeBtn = UI.$("btn-place");
      if (placeBtn) placeBtn.textContent = isPhoto ? "+ 번호 핀 + 사진" : isCheckboard ? "+ 번호 핀 찍기" : "+ 위치 포인트 추가";
      const placeHint = UI.$("place-hint");
      if (placeHint) placeHint.textContent = isPhoto
        ? "도면 위를 클릭하면 번호 핀과 함께 사진 선택창이 열립니다"
        : isCheckboard
        ? "도면 위를 클릭하면 번호가 자동으로 매겨집니다"
        : "도면 위 원하는 위치를 클릭하세요";
      // [WO 20260929] 3모드 세그먼트(보기/체크보드/사진등록) 활성 표시 동기화 — 신규 진입점.
      this._syncRegModeButtons();

      UI.showScreen("screen-app");
      // 🔴 [WO 20260928-pinloss] 모드 전환(편집 ↔ 체크보드)은 **같은 도면 위에서 도구만 바꾸는 것**이다.
      //   종전엔 전환마다 아래 loadLatestDeployment 가 돌아 "프로젝트의 첫 구역" 서버본으로 화면을 갈아엎었다 —
      //   보던 구역이 바뀌고(제목이 다른 도면 파일명으로) 방금 찍은 핀이 사라졌다(라이브 재현).
      //   도면이 이미 떠 있으면 다시 불러오지 않고 현재 State 를 그대로 다시 그린다.
      if (opts.keepDrawing && State.fileType) {
        UI.renderPinList(); UI.renderPinsOnMap();
        return;
      }
      // [마스터 요청 N4 + 멀티테넌트] 작업 사라짐 수정 + 서브도메인/카드로 특정 프로젝트 지정 시 그 프로젝트 스코프.
      //   프로젝트가 지정되면(설계자 재진입·서브도메인·카드클릭) 그 프로젝트 배포본, 없으면 최신(일반 뷰어).
      this.loadLatestDeployment(opts.project || null);
    },

    /** 편집(designer) 모드 → 뷰어 모드로 전환 (A안: 홈으로 안 가고 뷰어 화면 유지) */
    exitEdit() {
      // 디자이너 편집 UI 정리 후 뷰어로 재진입
      PanoViewer.close();
      this.openApp("viewer");
    },

    /** 뷰어 모드 → 설계자 편집 모드로 전환 (설계자 권한 필요).
     *  회귀 방지: 권한 확인이 늦어 뷰어로 진입한 설계자가 즉시 편집 모드로 올라올 수 있게 한다. */
    async enterEdit() {
      if (!Auth.isDesigner && Auth.idToken) { try { await Auth.refresh(); } catch (e) {} }
      if (!Auth.isDesigner) {
        if (Auth.requireDesigner) { Auth.requireDesigner(() => this.openApp(PinSeries.preferredMode(), { project: Projects.currentProject })); }
        return;
      }
      PanoViewer.close();
      this.openApp(PinSeries.preferredMode(), { project: Projects.currentProject });
    },

    /* ── Topbar ── */
    _bindTopbar() {
      UI.$("btn-back").addEventListener("click", () => {
        this._releasePdfDocs();
        State.reset();
        PanoViewer.close();
        // 첫 화면 = 프로젝트 허브로 복귀
        ProjectHub.open();
        UI.$("map-viewport").classList.add("hidden");
        UI.$("drop-hint").classList.remove("hidden");
        UI.$("pdf-error").classList.add("hidden");
        UI.$("pdf-pagination").classList.add("hidden");
        { const tb = UI.$("pdf-toolbar"); if (tb) tb.classList.add("hidden"); UI.toggleThumbPanel(false); }
        UI.$("pin-count-badge").classList.add("hidden");
        UI.$("pins-layer").innerHTML = "";
        UI.$("pin-list").innerHTML = "";
        UI.$("pin-empty").classList.remove("hidden");
        this._closePinForm();
        UI.$("section-next-point").classList.add("hidden");
        UI.$("section-export").classList.add("hidden");
        UI.$("pdf-canvas").classList.add("hidden");
        UI.$("map-image").classList.add("hidden");
        UI.text("file-name-label", "도면 없음");
        State.pan = { x: 0, y: 0 }; State.zoom = 1;
        MapCtrl.applyTransform();
      });

      UI.$("btn-prev-page").addEventListener("click", () => this._changePage(-1));
      UI.$("btn-next-page").addEventListener("click", () => this._changePage(1));
      UI.$("btn-first-page").addEventListener("click", () => this._gotoPage(1));
      UI.$("btn-last-page").addEventListener("click", () => this._gotoPage(this._totalPages()));

      // 페이지 직접 입력 (점프)
      const jump = UI.$("input-page-jump");
      const doJump = () => {
        const n = parseInt(jump.value, 10);
        if (!isNaN(n)) this._gotoPage(n);
        else jump.value = State.pdfPage;
      };
      jump.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); jump.blur(); } });
      jump.addEventListener("blur", doJump);
      jump.addEventListener("focus", () => jump.select());
    },

    _totalPages() {
      return State.mode === "viewer" && State.viewerPages
        ? State.viewerPages.length : State.pdfPages;
    },

    _changePage(dir) { return this._gotoPage(State.pdfPage + dir); },

    /** 도면 90° 회전 (PDF: 내장 getViewport 재렌더 / 이미지·뷰어: CSS transform) */
    async _rotatePdf(deg) {
      State.pdfRotation = (((State.pdfRotation + deg) % 360) + 360) % 360;
      if (State.mode !== "viewer" && State.fileType === "pdf" && State.pdfDoc) {
        // 디자이너 PDF: 캔버스를 회전값으로 다시 렌더 (핀 좌표는 비율 기준이라 그대로 유지)
        if (this._pageRendering) { this._pendingRotate = true; return; }
        this._pageRendering = true;
        try { await this._renderPdfPage(); }
        finally {
          this._pageRendering = false;
          if (this._pendingRotate) { this._pendingRotate = false; this._renderPdfPage(); }
        }
      } else {
        // 이미지 또는 뷰어(스냅샷 이미지): map-image 를 CSS 로 회전
        MapCtrl.applyTransform();
      }
      UI.updateRotationLabel();
    },

    /** 절대 페이지로 이동 (범위 클램프 + 렌더 중복 가드) */
    async _gotoPage(target) {
      const total = this._totalPages();
      if (total <= 1) return;
      const next = Math.max(1, Math.min(total, target | 0));
      if (next === State.pdfPage) { UI.updatePdfPagination(); return; }
      if (this._pageRendering) { this._pendingPage = next; return; } // 중복 렌더 방지
      State.pdfPage = next;
      UI.updatePdfPagination(); // 페이지 번호/버튼 상태 즉시 반영 (렌더 완료 전에도)
      if (State.checkboard) this._updateCheckboardQuickStatus(next); // 페이지 전환 시 "사진 폴더 연동" 버튼·안내문 갱신
      this._pageRendering = true;
      try {
        if (State.mode === "viewer" && State.viewerPages) {
          const imgEl = UI.$("map-image");
          await new Promise((res) => {
            imgEl.onload = () => res();
            imgEl.onerror = () => res();
            imgEl.src = Auth.r2(State.viewerPages[next - 1]);
          });
          this._showMapViewport();
          // [P14] 페이지가 바뀌면 이전 페이지의 고해상도 오버레이는 즉시 거짓 화면이 된다.
          //   원본을 갖고 있으면 새 페이지 기준으로 렌더 상태를 다시 잡는다.
          try { PDF._clearCrop(); } catch (e) {}
          if (State.srcPdfDoc) { await this._primeSourceRender(); MapCtrl.applyTransform(); }
        } else {
          await this._renderPdfPage();
        }
      } catch (e) {
        console.warn("페이지 전환 실패:", e);
      } finally {
        this._pageRendering = false;
        // 전환 중 들어온 마지막 요청 처리
        if (this._pendingPage != null && this._pendingPage !== State.pdfPage) {
          const p = this._pendingPage; this._pendingPage = null;
          this._gotoPage(p);
        } else {
          this._pendingPage = null;
        }
      }
    },

    /* ══════════════════════════════════════════
       구역 페이지(crop-view) 시스템
       — 물리 페이지를 늘리지 않고 "가상 페이지"로 처리.
       — 1페이지(전체)는 모든 핀 표시 + 통합관리.
       — 구역 진입 시 해당 구역만 화면에 꽉 차게 확대(crop-view),
         구역 밖 핀/구역은 흐리게 처리해 상세 작업에 집중.
       — viewportToPercent는 줌/팬 보정된 전체 도면 %를 반환하므로
         확대 상태에서 클릭해도 전역 좌표가 정확히 등록됨(중복 좌표 없음).
       ══════════════════════════════════════════ */

    /** 현재 페이지의 구역 목록(페이저 탭용) */
    _zonesOnPage() {
      const pg = State.pdfPage || 1;
      return (State.zones || []).filter(z => (z.page || 1) === pg);
    },

    /** 구역 페이지 진입 — crop-view 확대 + 비활성 핀/구역 dim */
    enterZoneView(zoneId, _retry) {
      const z = (State.zones || []).find(x => x.id === zoneId);
      if (!z) return;
      // 다른 PDF 페이지면 먼저 전환 (재시도 1회 가드 — 무한루프 방지)
      if ((z.page || 1) !== (State.pdfPage || 1) && this._gotoPage && !_retry) {
        Promise.resolve(this._gotoPage(z.page)).then(() => {
          setTimeout(() => this.enterZoneView(zoneId, true), 80);
        });
        return;
      }
      State.zoneView = zoneId;
      const bb = (typeof Zones !== "undefined" && Zones._bbox) ? Zones._bbox(z) : { x: z.x, y: z.y, w: z.w, h: z.h };
      if (MapCtrl.fitZone) MapCtrl.fitZone(bb, 0.14, 640);
      try { document.body.classList.add("zone-view-active"); } catch (e) {}
      if (typeof UI !== "undefined" && UI.renderPinsOnMap) UI.renderPinsOnMap();
      if (typeof Zones !== "undefined" && Zones.render) Zones.render();
      this._renderZonePager();
      // [토스트 스팸 제거·마스터 지시] 구역 선택 결과는 페이저 탭 활성 + 도면 필터로 이미 화면에 보인다.
    },

    /** 전체 도면 복귀 — 모든 핀/구역 표시 */
    exitZoneView() {
      State.zoneView = null;
      try { document.body.classList.remove("zone-view-active"); } catch (e) {}
      if (MapCtrl.flyTo) MapCtrl.flyTo(50, 50, 1, 560);
      if (typeof UI !== "undefined" && UI.renderPinsOnMap) UI.renderPinsOnMap();
      if (typeof Zones !== "undefined" && Zones.render) Zones.render();
      this._renderZonePager();
    },

    /** 구역 페이저 탭 strip 렌더 (전체 + zone1..zoneN) */
    _renderZonePager() {
      const bar = UI.$("zone-pager");
      if (!bar) return;
      const zones = this._zonesOnPage();
      // 구역이 없으면 페이저 숨김
      if (!zones.length) { bar.classList.add("hidden"); bar.innerHTML = ""; return; }
      bar.classList.remove("hidden");
      const cur = State.zoneView;
      let html = `<button class="zpager-tab ${!cur ? "active" : ""}" data-zone="__all__">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
          전체 도면</button>`;
      zones.forEach((z, i) => {
        const active = cur === z.id;
        const cnt = (z.pinIds || []).length;
        html += `<button class="zpager-tab ${active ? "active" : ""}" data-zone="${z.id}" title="${UI.escapeHtml(z.label || "구역 " + (i + 1))}">
            <span class="zpager-dot" style="background:${z.color || "#2f6db5"}"></span>
            <span class="zpager-name">${UI.escapeHtml(z.label || "구역 " + (i + 1))}</span>
            ${cnt ? `<span class="zpager-cnt">${cnt}</span>` : ""}
          </button>`;
      });
      bar.innerHTML = html;
      bar.querySelectorAll(".zpager-tab").forEach(b => {
        b.addEventListener("click", () => {
          const zid = b.getAttribute("data-zone");
          if (zid === "__all__") this.exitZoneView();
          else this.enterZoneView(zid);
        });
      });
      // [마스터] 상단 항상고정 대신 활성 구역 근처에 팝업 + 자동소멸(2.8초)
      this._positionZonePager(bar, cur);
      this._showZonePagerThenFade(bar);
    },

    /** 구역 페이저를 활성 구역 도형(zone-shape) 바로 아래에 배치. 없으면 상단 중앙 기본값.
     *  [WO 20261002-gap] 🔴 근본수정 — 모바일 CHECKER/360 모드에선 topbar 바로 아래
     *  '번호 대역' 띠(#regmode-start-wrap)가 position:fixed로 추가 행(실측 68~98px)을
     *  차지한다. #map-area는 그 사실을 모르고 topbar 바로 밑에서 시작하므로, 페이저의
     *  기본 top(10px/8px)이 그 띠와 겹쳤다(실측 3850px² — 띠가 가려져 대역 메뉴가 안 열림).
     *  두 분기(전체 도면/활성 구역) 모두 이 공유 하한(minTop)을 쓴다(SoT, 한쪽만 고치면
     *  나머지가 깨진다 — CLAUDE.md §G-2-5). */
    _zonePagerMinTop(area) {
      let minTop = 10;
      const bandEl = document.getElementById("regmode-start-wrap");
      if (bandEl) {
        const cs = getComputedStyle(bandEl);
        if (cs.display !== "none" && cs.position === "fixed") {
          const bandRect = bandEl.getBoundingClientRect();
          const areaTop = area.getBoundingClientRect().top;
          if (bandRect.height > 0) minTop = Math.max(minTop, (bandRect.bottom - areaTop) + 6);
        }
      }
      return minTop;
    },
    _positionZonePager(bar, activeZoneId) {
      const area = UI.$("map-area");
      if (!area) return;
      const minTop = this._zonePagerMinTop(area);
      const shape = activeZoneId ? document.querySelector('.zone-shape[data-zone="' + activeZoneId + '"]') : null;
      if (!shape) {
        // 활성 구역 없음(전체 도면) — 기본 상단 중앙
        bar.style.top = minTop + "px"; bar.style.left = "50%"; bar.style.right = ""; bar.style.transform = "translateX(-50%)";
        return;
      }
      const areaRect = area.getBoundingClientRect();
      const sRect = shape.getBoundingClientRect();
      let top = Math.max(minTop, (sRect.bottom - areaRect.top) + 8);
      let left = (sRect.left + sRect.width / 2) - areaRect.left;
      // 화면 하단을 벗어나면 구역 위쪽에 배치
      const barH = bar.offsetHeight || 40;
      if (top + barH > areaRect.height - 8) top = Math.max(minTop, (sRect.top - areaRect.top) - barH - 8);
      // 좌우 클램프(대략 절반 너비 확보)
      const halfW = (bar.offsetWidth || 200) / 2;
      left = Math.min(Math.max(left, halfW + 8), areaRect.width - halfW - 8);
      bar.style.top = top + "px"; bar.style.left = left + "px"; bar.style.right = ""; bar.style.transform = "translateX(-50%)";
    },

    /** 페이저를 잠깐 보여준 뒤 자동 fade-out. 호버 중엔 타이머 정지, 벗어나면 재시작 */
    _showZonePagerThenFade(bar) {
      bar.classList.add("pager-visible");
      const clearTimer = () => { if (this._zonePagerTimer) { clearTimeout(this._zonePagerTimer); this._zonePagerTimer = null; } };
      const startTimer = () => {
        clearTimer();
        this._zonePagerTimer = setTimeout(() => bar.classList.remove("pager-visible"), 2800);
      };
      if (!bar._pagerHoverBound) {
        bar._pagerHoverBound = true;
        bar.addEventListener("mouseenter", clearTimer);
        bar.addEventListener("mouseleave", startTimer);
      }
      startTimer();
    },

    /* ── Sidebar ── */
    _bindSidebar() {
      // [항목3] 포인트 목록 아이콘 토글 + 닫기 버튼
      const plToggle = document.getElementById("pin-list-toggle");
      const plClose  = document.getElementById("pin-list-close");
      if (plToggle) plToggle.addEventListener("click", () => UI.togglePinList());
      if (plClose)  plClose.addEventListener("click", (e) => { e.stopPropagation(); UI.togglePinList(false); });

      UI.$("btn-upload-drawing").addEventListener("click", async () => {
        // ── [WO 20260928·마스터 확정] 🔴 "프로젝트에 처음 도면 등록 시에는 그냥 등록만 해" ──
        //  계층은 **프로젝트 > 구역 > 영역** 이고, 도면은 트리 단계가 아니라 **구역을 잘라낼 원본 파일**이다.
        //  그래서 도면 등록은 구역을 전제하지 않는다 → 옛 "구역 0개면 업로드 차단 + createDeck() 강제"
        //  게이트를 제거한다(이름 모달 0 · 자동 이름 0 · 자동 구역 생성 0).
        //  구역은 이 도면 위에서 **첫 영역을 지정할 때** 비로소 생긴다(Projects.createDeckFromLoadedDrawing).
        //  구역이 **이미 있을 때만** "어느 구역에 붙일지"를 정한다(기존 동작 유지 — 회귀 방지).
        if (typeof Projects !== "undefined" && Projects.currentProject) {
          const decks = Projects.decks || [];
          if (decks.length > 0 && !Projects.currentDeck) {
            if (decks.length === 1) {
              Projects.currentDeck = decks[0];
              if (Projects._renderDecks) Projects._renderDecks();
            } else {
              Prompt.toast && Prompt.toast("도면을 등록할 ‘구역’을 먼저 선택하세요.");
              const db = document.getElementById("decks-block");
              if (db) { db.classList.add("zone-required-flash"); setTimeout(() => db.classList.remove("zone-required-flash"), 1800); }
              return;
            }
          }
        }
        UI.$("input-drawing").click();
      });
      UI.$("input-drawing").addEventListener("change", e => {
        const f = e.target.files[0]; if (!f) return;
        e.target.value = "";
        this._loadDrawing(f);
      });

      // ── 드래그 앤 드롭 업로드: 도면 영역에 PDF/이미지를 끌어다 놓으면 즉시 로드 ──
      this._bindDragDrop();

      UI.$("btn-import-json").addEventListener("click", () => UI.$("input-json").click());
      UI.$("input-json").addEventListener("change", e => {
        const f = e.target.files[0]; if (!f) return;
        e.target.value = "";
        const reader = new FileReader();
        reader.onload = ev => {
          try {
            const data = JSON.parse(ev.target.result);
            if (Array.isArray(data.pins)) {
              State.pins = this._pinsSeen(data.pins);
              if (data.fileName) UI.text("file-name-label", data.fileName);
              UI.renderPinList();
              UI.renderPinsOnMap();
            }
          } catch { alert("JSON 파싱 실패: 올바른 포인트 파일인지 확인하세요."); }
        };
        reader.readAsText(f);
      });

      // 포인트 배치 모드 토글
      UI.$("btn-place").addEventListener("click", () => this._togglePlacing());

      // [WO 20260929 2모드 전환] CHECKER 진입 — 두 버튼 공용 핸들러. 과거엔 이미 체크보드일 때
      // "view"(보기)로 되돌리는 토글이었으나, [보기] 세그먼트 제거로 그 경로는 디자이너 UI에서
      // 도달 불가해야 한다(WO 원문). 이제 이 버튼은 CHECKER 진입 전용 — 이미 체크보드면 무동작.
      const enterCheckboard = () => { this._setRegMode("checkboard"); };
      const cbBtn = UI.$("btn-checkboard-toggle");
      if (cbBtn) cbBtn.addEventListener("click", enterCheckboard);
      const cbEnter = UI.$("btn-checkboard-enter");
      if (cbEnter) cbEnter.addEventListener("click", enterCheckboard);
      // [WO 20260929 2모드 전환] 편집화면 2모드 세그먼트(CHECKER/360) — 신규 진입점, 같은 SoT로 귀결.
      ["checkboard", "photo"].forEach((m) => {
        const b = UI.$("btn-regmode-" + m);
        if (b) b.addEventListener("click", () => this._setRegMode(m));
      });

      // [WO 20260918] 체크보드 번호 일괄 변경 진입점 — App._renumberCheckboard() 재사용.
      const cbRenumber = UI.$("btn-checkboard-renumber");
      if (cbRenumber) cbRenumber.addEventListener("click", () => this._renumberCheckboard());

      // [마스터 요청 2026-09-03] 사이드바 툴레일 "포인트" 버튼 — 클릭 한 번으로
      //   체크보드 순차 배치 모드 진입(기존 btn-checkboard-enter 재사용, 새 로직 없음).
      //   기존 #btn-place(이름/사진 폼)·#btn-checkboard-enter·#btn-photobatch 단독 진입은
      //   그대로 유지된다 — 이 버튼은 지름길일 뿐 기존 길을 없애지 않는다.
      const quickPoint = UI.$("btn-quickpoint");
      if (quickPoint) quickPoint.addEventListener("click", () => this._quickCheckboardEntry());

      // [WO 20260918 제거] 구 "사진 폴더 연동" 지름길(#btn-checkboard-photobatch)은 렌더 고아라
      // 삭제했다. #btn-photobatch(사이드 툴바 "사진" 그룹)가 현재 모드 계열로 자동 매칭해
      // 동일 기능을 커버한다(35_PhotoBatch.js _defaultRange).

      // [WO 20260928 이관] 구 체크보드 시작 번호 입력(#input-checkboard-start)은
      // #section-checkboard 가 영구 hidden(style.css)이라 렌더 고아였다 — 설정 패널
      // (#settings-checkboard-start, 24_Settings.js)로 옮겼다. 정본 _setCheckboardStart()는 그대로 재사용.

      // "다음 포인트 지정" — 연속 배치
      UI.$("btn-next-point").addEventListener("click", () => {
        UI.hide("section-next-point");
        if (!State.placing) this._togglePlacing();
      });

      // 핀 폼: 그림 파일 선택
      UI.$("btn-pin-file").addEventListener("click", () => UI.$("input-pin-file").click());
      UI.$("input-pin-file").addEventListener("change", e => {
        const f = e.target.files[0];
        e.target.value = "";
        // [WO 20260928] 체크보드 자동첨부 진행 여부를 먼저 뗀다(아래 어느 경로로 리턴하든
        //   깜빡이는 대기 상태(State.editingPinId/pending)가 남지 않게).
        const wasCheckboardAuto = State._checkboardAutoConfirm;
        if (wasCheckboardAuto) State._checkboardAutoConfirm = false;
        if (!f) {
          // 체크보드에서 사진 선택을 취소해도 핀(번호)은 그대로 남는다(조용히 삭제 금지).
          if (wasCheckboardAuto) { State.editingPinId = null; State.pending = null; }
          return;
        }
        const isImg = f.type.startsWith("image/");
        const isVid = f.type.startsWith("video/") || /\.(mp4|webm|mov)$/i.test(f.name);
        if (!isImg && !isVid) {
          alert("이미지(.jpg/.png) 또는 360° 영상(.mp4) 파일을 선택하세요.");
          if (wasCheckboardAuto) { State.editingPinId = null; State.pending = null; }
          return;
        }
        this._acceptPinMediaFile(f, isVid, false);
        if (wasCheckboardAuto) {
          // [WO 20260928] 체크보드 자동첨부 — 기존 핀 편집 저장 경로(_confirmPin)를 그대로
          //   재사용한다. 폼(#section-pin-form)이 열려있지 않아도 State.editingPinId/pending
          //   이 채워져 있으면 동일하게 저장된다(새 "등록창"은 뜨지 않는다).
          setTimeout(() => this._confirmPin(), 120);
        }
      });

      // ── [마스터 요청] RICOH THETA 360° 전용 버튼 (삼성폰) ──
      //   THETA 앱이 폰 갤러리에 저장한 360 JPG를 고르거나, 카메라로 바로 촬영.
      //   THETA 사진은 표준 equirectangular(가로:세로 = 2:1) → 360 뷰어로 자동 표시.
      const btnTheta = UI.$("btn-pin-theta");
      if (btnTheta) btnTheta.addEventListener("click", () => {
        if (Prompt && Prompt.toast)
          Prompt.toast("RICOH THETA 360 — 삼성폰 갤러리에서 360 사진을 고르거나 촬영하세요");
        UI.$("input-pin-theta").click();
      });
      const inputTheta = UI.$("input-pin-theta");
      if (inputTheta) inputTheta.addEventListener("change", e => {
        const f = e.target.files[0];
        e.target.value = "";
        if (!f) return;
        if (!f.type.startsWith("image/")) { alert("360° 사진(JPG/PNG)을 선택하세요."); return; }
        // THETA 경로로 들어온 이미지는 360 후보로 표시(실제 2:1 검사는 _acceptPinMediaFile 내부)
        this._acceptPinMediaFile(f, false, true);
      });

      // 핀 폼: 첨부 문서 선택 (PDF/Word 등 — 다중)
      UI.$("btn-pin-doc").addEventListener("click", () => UI.$("input-pin-doc").click());
      UI.$("input-pin-doc").addEventListener("change", e => {
        const files = Array.from(e.target.files || []);
        e.target.value = "";
        files.forEach(f => this._addPendingDoc(f));
      });

      // 핀 폼: 동영상 첨부 (3D 포인트클라우드는 E57 등 웹에서 못 읽어 동영상으로 대체).
      //   기존 영상 파이프라인(_acceptPinMediaFile → pendingIsVideo)을 재사용한다.
      const flsBtn = UI.$("btn-pin-fls");
      if (flsBtn) flsBtn.addEventListener("click", () => UI.$("input-pin-fls").click());
      const flsInput = UI.$("input-pin-fls");
      if (flsInput) flsInput.addEventListener("change", e => {
        const f = e.target.files[0];
        e.target.value = "";
        if (!f) return;
        const isVid = (f.type && f.type.startsWith("video/")) || /\.(mp4|webm|mov)$/i.test(f.name);
        if (!isVid) { Prompt.toast && Prompt.toast("동영상 파일(mp4·webm·mov)을 선택하세요"); return; }
        this._acceptPinMediaFile(f, true, false);
      });

      UI.$("input-pin-url").addEventListener("input", () => this._updateConfirmEnabled());
      UI.$("input-pin-note").addEventListener("input", () => this._updateConfirmEnabled());
      UI.$("btn-confirm-pin").addEventListener("click", () => this._confirmPin());
      UI.$("btn-cancel-pin").addEventListener("click", () => this._resetPinForm(true));

      // 컴팩트 폼: 노트/URL 접이식 토글
      const tog = (fieldId, btnId, focusId) => {
        const field = UI.$(fieldId), b = UI.$(btnId);
        if (!field || !b) return;
        const open = field.classList.toggle("hidden") === false;
        b.classList.toggle("active", open);
        if (open && focusId) { const el = UI.$(focusId); if (el) el.focus(); }
      };
      const nt = UI.$("btn-pin-note-toggle");
      if (nt) nt.addEventListener("click", () => tog("field-pin-note", "btn-pin-note-toggle", "input-pin-note"));
      const ut = UI.$("btn-pin-url-toggle");
      if (ut) ut.addEventListener("click", () => tog("field-pin-url", "btn-pin-url-toggle", "input-pin-url"));

      // [마스터: 수동 반영] 동기화 배지 클릭 → 지금 즉시 "전체" 동기화(업로드)
      const sb = UI.$("sync-badge");
      if (sb) sb.addEventListener("click", () => this.syncNow());
      // [WO 20260918] 모바일 독의 "항상 보이는" 업로드 칩 — 같은 syncNow() 재사용(새 경로 금지).
      const mUp = UI.$("mdock-upload");
      if (mUp) mUp.addEventListener("click", () => this.syncNow());

      UI.$("btn-export-json").addEventListener("click", () => this._exportJson());
      UI.$("btn-deploy").addEventListener("click", () => this._deployToViewer());
      UI.$("btn-reload-deploy").addEventListener("click", () => this.loadLatestDeployment());
      // [마스터: 수동 저장] '저장' 버튼 → 서버 반영. 미저장 변경 시 이탈 경고.
      const sbtn = UI.$("btn-save");
      if (sbtn) sbtn.addEventListener("click", () => this._saveNow({ now: true, withPages: true }));
      window.addEventListener("beforeunload", (e) => {
        if (this._dirty && State.mode === "designer") { e.preventDefault(); e.returnValue = ""; }
      });
    },

    /** [WO 20260929 2모드 전환] 편집화면 SoT — CHECKER(checkboard)/360(photo) 2모드.
     *  🔴 "view"(구 [보기])는 세그먼트·모든 UI 진입점에서 제거됐다 — 디자이너 UI로는
     *  도달 불가해야 한다(WO 원문). State.regMode 내부 값으로는 여전히 남아 있을 수 있어
     *  이 함수는 방어적으로 "view"도 받아들이지만, 어떤 버튼도 더 이상 "view"를 호출하지 않는다.
     *  🔴 기존 진입점(btn-checkboard-enter/btn-checkboard-toggle·포인트 추가 버튼들)도
     *  모두 이 함수로 귀결된다 — 상태를 여러 곳에서 따로 세팅하면 반드시 갈라진다
     *  (전역 CLAUDE.md §10 SoT). openApp(keepDrawing:true) 재사용 — 도면 재로드 없음
     *  (WO 20260928-pinloss 교훈, 모드 전환 시 핀 소실 재발 방지). */
    _setRegMode(next) {
      if (next !== "view" && next !== "checkboard" && next !== "photo") return;
      if (State.mode !== "designer") return; // 편집 화면 전용(뷰어 앱에는 세그먼트가 없음)
      if (State.placing) this._togglePlacing();
      if (typeof PinSeries !== "undefined" && PinSeries.setPreferredMode) {
        PinSeries.setPreferredMode(next === "checkboard" ? "checkboard" : "designer");
      }
      this.openApp(next === "view" ? "designer" : next,
        { project: (typeof Projects !== "undefined" && Projects.currentProject) || null, keepDrawing: true });
      if (next !== "view") {
        // [WO 20260929 마스터 정정] 체크보드/사진등록은 클릭 즉시 동작하는 도구 — 진입과 동시에
        //   배치모드를 자동 시작한다(기존 체크보드 진입 패턴 그대로 재사용).
        setTimeout(() => { if (!State.placing) this._togglePlacing(); }, 60);
      }
    },

    /** 2모드 세그먼트 버튼(#btn-regmode-checkboard/photo) 활성 표시 동기화.
     *  렌더 지점 하나(§10 SoT) — openApp()·_setRegMode() 어디서 전환되든 여기만 부른다. */
    _syncRegModeButtons() {
      ["checkboard", "photo"].forEach((m) => {
        const b = UI.$("btn-regmode-" + m);
        if (!b) return;
        const active = State.regMode === m;
        b.classList.toggle("active", active);
        b.setAttribute && b.setAttribute("aria-pressed", String(active));
      });
      // [WO 20260930-moderole] 🔴 마스터: "체커는 번호만 매기는 기능" — 사진 등록 계열 도구(사진
      // 폴더 일괄 매칭·THETA 360 인입·모바일 도크 사진등록)는 CHECKER 모드에서 숨긴다. 렌더 지점
      // 하나(§10 SoT) — 모드 전환은 전부 openApp()/_setRegMode() 를 거쳐 이 함수를 부른다.
      const isChecker = State.regMode === "checkboard";
      ["btn-photobatch", "btn-theta-intake", "mdock-photobatch"].forEach((id) => {
        const b = UI.$(id);
        if (b) b.classList.toggle("hidden", isChecker);
      });
      // #btn-theta-intake 는 side-toolbar 컴팩트 칩(.stb-btn[data-deleg="btn-theta-intake"])의
      // 위임 대상이다 — 대상만 숨기면 그 칩은 .click()으로 여전히 눌린다(delegate 는 hidden 을
      // 안 본다). 칩 자체도 함께 숨긴다(index.html id 추가 없이 셀렉터로 — 타 화면 신규 id 회피).
      try {
        if (typeof document !== "undefined" && document.querySelector) {
          const thetaChip = document.querySelector('[data-deleg="btn-theta-intake"]');
          if (thetaChip && thetaChip.classList) thetaChip.classList.toggle("hidden", isChecker);
        }
      } catch (e) {}
      // [WO 20261001-startno] 모드 전환·편집 진입 = 상단 [번호 대역] 표시(현재 모드 계열의 다음 번호) 갱신 지점
      if (typeof NumBand !== "undefined" && NumBand.render) { try { NumBand.render(); } catch (e) {} }
      // [WO 20261002-allmenu §2] CHECKER 툴바 [정렬 ↕][정렬 ↔] 표시 — 같은 렌더 지점(모드 전환 SoT)에서 동기화.
      if (UI.syncCheckerAlignTools) { try { UI.syncCheckerAlignTools(); } catch (e) {} }
    },

    _togglePlacing() {
      // [WO 20260929] 보기(view) 모드는 "생성 없음" — 배치 진입 자체를 막는다.
      //   🔴 단일 관문: quickpoint·mobile dock·btn-place 등 모든 진입로가 이 함수를 거치므로
      //   여기 한 곳만 막으면 어느 버튼으로 들어와도 view 모드에서 생성이 불가능하다.
      if (!State.placing && State.regMode === "view") {
        if (typeof Prompt !== "undefined" && Prompt.toast) {
          Prompt.toast("보기 모드에서는 포인트를 생성할 수 없습니다 — CHECKER/360 모드로 전환하세요");
        }
        return;
      }
      // ── [마스터 요청 #6] 배치 모드를 켜기 전, 진행 중이던 다른 명령(영역그리기·
      //   핀이동잠금·편집폼·팝업)을 먼저 조용히 종료한다. (placing 자신은 토글에 맡김)
      if (!State.placing) {
        const wasPlacing = State.placing;
        State.placing = true;              // cancel 이 placing 을 끄지 않도록 잠깐 플래그
        this.cancelActiveOperation({ silent: true });
        State.placing = wasPlacing;        // 토글 직전 원복
      }
      State.placing = !State.placing;
      if (State.placing) {
        State.pending = null;
        State.editingPinId = null;
        this._closePinForm();         // 편집 폼이 떠 있으면 닫고 새 배치 모드
        UI.hide("section-next-point");
        // [마스터 버그] ISO(원근 3D) 보기에서는 클릭→도면좌표 변환이 틀어져 핀이 엉뚱한 곳에
        //   찍힌다(perspective 역산 부정확). 정확한 배치를 위해 배치 모드 진입 시 평면 보기로 전환.
        if (State.isoView && typeof MapCtrl !== "undefined" && MapCtrl._applyIso) {
          State.isoView = false; State.isoDir = 0; MapCtrl._applyIso();
          if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("정확한 핀 배치를 위해 평면 보기로 전환했습니다 (배치 후 ISO 다시 켜기 가능)");
        }
      }
      UI.$("btn-place").classList.toggle("active", State.placing);
      UI.$("place-hint").classList.toggle("hidden", !State.placing);
      UI.$("crosshair-overlay").classList.toggle("hidden", !State.placing);
      UI.$("map-viewport").style.cursor = State.placing ? "crosshair" : "grab";
    },

    /** ── [마스터 요청 #5·#6] 현재 실행 중인 "도구/명령"을 모두 즉시 종료 ──
     *  ESC 키 또는 다른 기능 버튼 진입 시 호출 → 직전 명령이 깔끔히 중지되고
     *  새 명령만 진행되게 한다. (배치/영역그리기/핀이동잠금해제/편집폼/팝업)
     *  @returns {boolean} 실제로 무언가 취소했으면 true. */
    cancelActiveOperation(opts) {
      opts = opts || {};
      let did = false;
      // 1) 영역(존) 그리기 중 → 취소
      try {
        if (typeof Zones !== "undefined" && (State.drawingZone || (Zones._poly && Zones._poly.length))) {
          if (Zones._cancelDraw) Zones._cancelDraw(); did = true;
        }
      } catch (e) {}
      // 2) 핀 배치(placing) 모드 → 종료
      if (State.placing) {
        State.placing = false;
        const bp = UI.$("btn-place"); if (bp) bp.classList.remove("active");
        UI.hide && UI.hide("place-hint");
        const ch = UI.$("crosshair-overlay"); if (ch) ch.classList.add("hidden");
        const mv = UI.$("map-viewport"); if (mv) mv.style.cursor = "grab";
        did = true;
      }
      // 3) 핀 이동 잠금해제 상태 → 다시 잠금
      if (State.pinEditUnlocked) {
        State.pinEditUnlocked = null; State.movingPinId = null;
        document.querySelectorAll(".pin-marker.edit-unlocked,.pin-marker.moving")
          .forEach(m => m.classList.remove("edit-unlocked", "moving"));
        did = true;
      }
      // 4) 핀 편집 폼이 떠 있으면 닫기
      const pf = UI.$("section-pin-form");
      if (pf && !pf.classList.contains("hidden")) { this._closePinForm(); State.editingPinId = null; did = true; }
      // 5) 핀 작업 팝업(PinActionPop) 열려 있으면 닫기
      try {
        if (typeof PinActionPop !== "undefined" && PinActionPop.close) {
          const pap = UI.$("pin-action-pop");
          if (pap && !pap.classList.contains("hidden")) { PinActionPop.close(); did = true; }
        }
      } catch (e) {}
      // 6) pending(미확정 핀) 정리
      if (State.pending) {
        State.pending = null;
        const pp = UI.$("pending-pin"); if (pp) pp.classList.add("hidden");
        UI.hide && UI.hide("section-next-point");
        did = true;
      }
      if (did && !opts.silent && typeof Prompt !== "undefined" && Prompt.toast) {
        Prompt.toast("⎋ 진행 중이던 작업을 종료했습니다");
      }
      return did;
    },

    /** 플로팅 핀 편집 패널 열기 (새 포인트 or 기존 포인트 편집) */
    _openPinForm(opts) {
      opts = opts || {};
      const panel = UI.$("section-pin-form");
      if (!panel) return;
      panel.classList.remove("hidden");
      // 헤더 타이틀: 신규 vs 수정
      const tt = UI.$("pf-title-text");
      if (tt) tt.textContent = opts.editing ? "포인트 수정" : "새 포인트";
      const saveLbl = UI.$("pf-save-label");
      if (saveLbl) saveLbl.textContent = opts.editing ? "변경 저장" : "저장하기";
      // ── #7: 구역이 선택돼 있고 신규 포인트면 위치명 입력 숨김(번호 자동부여).
      //   편집이거나 구역이 없으면 위치명 입력 표시.
      const addr = UI.$("pf-addr");
      if (addr) {
        const zoneSelected = (typeof Projects !== "undefined" && Projects.currentDeck);
        const hideAddr = !opts.editing && !!zoneSelected;
        addr.classList.toggle("hidden", hideAddr);
      }
      // [마스터 요청] 아이콘 선택 그리드 렌더(현재 State.pendingIcon 반영)
      this._renderIconPicker();
      // 진입 애니메이션 트리거
      panel.classList.remove("pf-in");
      void panel.offsetWidth;
      panel.classList.add("pf-in");
    },

    /** [마스터 요청] 핀 아이콘 선택 그리드 렌더 + 선택 상태 동기화.
     *  [마스터 요청 2026-09-03] 배치 모드(체크보드 연속 배치)에서도 재사용하도록 일반화:
     *  gridId(기본 pf-icon-grid) + labelId(있으면 "현재: OO" 로 갱신)를 받는다.
     *  두 그리드 모두 같은 State.pendingIcon 을 공유 — 한 번 고르면 다음 배치까지 유지된다. */
    _renderIconPicker(gridId, labelId) {
      gridId = gridId || "pf-icon-grid";
      const grid = UI.$(gridId);
      if (!grid || typeof PinIcons === "undefined") return;
      const cur = State.pendingIcon || "number";
      grid._labelId = labelId || grid._labelId;
      grid.innerHTML = PinIcons.SET.map(it =>
        `<button type="button" class="pf-icon-chip${it.id === cur ? " active" : ""}" ` +
        `data-icon="${it.id}" title="${it.name}" aria-label="${it.name}" ` +
        `aria-pressed="${it.id === cur ? "true" : "false"}">${PinIcons.chipSvg(it.id)}</button>`
      ).join("");
      if (grid._labelId) {
        const lbl = UI.$(grid._labelId);
        if (lbl) lbl.textContent = "아이콘 종류 (현재: " + PinIcons.def(cur).name + ")";
      }
      // 위임 바인딩(중복 방지)
      if (!grid._iconBound) {
        grid.addEventListener("click", (e) => {
          const chip = e.target.closest(".pf-icon-chip");
          if (!chip) return;
          State.pendingIcon = chip.dataset.icon || "number";
          grid.querySelectorAll(".pf-icon-chip").forEach(c => {
            const on = c === chip;
            c.classList.toggle("active", on);
            c.setAttribute("aria-pressed", on ? "true" : "false");
          });
          if (grid._labelId) {
            const lbl = UI.$(grid._labelId);
            if (lbl) lbl.textContent = "아이콘 종류 (현재: " + PinIcons.def(State.pendingIcon).name + ")";
          }
        });
        grid._iconBound = true;
      }
    },

    /** 플로팅 핀 편집 패널 닫기 */
    _closePinForm() {
      const panel = UI.$("section-pin-form");
      if (panel) { panel.classList.add("hidden"); panel.classList.remove("pf-in"); }
    },

    _updateConfirmEnabled() {
      const hasFile = !!State.pendingFile;
      const hasUrl  = !!UI.val("input-pin-url").trim();
      const hasNote = !!UI.val("input-pin-note").trim();
      const hasDoc  = State.pendingDocs.length > 0;
      const hasFls  = !!State.pendingFls;
      // 360° 미디어가 없어도 노트/문서/3D 데이터만 있어도 저장 가능 (정보 포인트)
      UI.$("btn-confirm-pin").disabled = !(hasFile || hasUrl || hasNote || hasDoc || hasFls);
    },

    /** 첨부 문서 후보 추가 + 검증 */
    _addPendingDoc(file) {
      if (!file) return;
      if (file.size > Cloud.MAX_DOC_BYTES) {
        alert(`"${file.name}" 은 너무 큽니다 (${fmtBytes(file.size)}). 최대 ${fmtBytes(Cloud.MAX_DOC_BYTES)} 까지 첨부할 수 있습니다.`);
        return;
      }
      // 중복(같은 이름+크기) 방지
      if (State.pendingDocs.some(d => d.name === file.name && d.size === file.size)) return;
      const kind = docKind(file.type || file.name);
      State.pendingDocs.push({
        tempId: "d" + Date.now() + Math.random().toString(36).slice(2, 6),
        file, name: file.name, size: file.size, kind, status: "ready"
      });
      this._renderPendingDocs();
      this._updateConfirmEnabled();
    },

    _removePendingDoc(tempId) {
      State.pendingDocs = State.pendingDocs.filter(d => d.tempId !== tempId);
      this._renderPendingDocs();
      this._updateConfirmEnabled();
    },

    _renderPendingDocs() {
      const wrap = UI.$("pin-doc-list");
      wrap.innerHTML = "";
      State.pendingDocs.forEach(d => {
        const chip = document.createElement("div");
        chip.className = "pin-doc-chip";
        chip.innerHTML = `
          <span class="pin-doc-badge" style="background:${d.kind.color}">${d.kind.label}</span>
          <div class="pin-doc-meta">
            <div class="pin-doc-name">${UI.escapeHtml(d.name)}</div>
            <div class="pin-doc-size">${fmtBytes(d.size)}</div>
          </div>
          <button class="pin-doc-remove" title="제거" aria-label="제거">✕</button>`;
        chip.querySelector(".pin-doc-remove").addEventListener("click", () => this._removePendingDoc(d.tempId));
        wrap.appendChild(chip);
      });
    },

    _resetPinForm(hideForm) {
      State.pending = null;
      State.pendingFile = null;
      State.pendingIsVideo = false;
      State.pendingIs360 = false;
      State.pendingDocs = [];
      State.pendingFls = null;
      State.pendingIcon = "number"; // [마스터 요청] 아이콘 선택 초기화(기본 번호)
      UI.$("pending-pin").classList.add("hidden");
      UI.clearVal("input-pin-label");
      UI.clearVal("input-pin-url");
      UI.clearVal("input-pin-imgname");
      UI.clearVal("input-pin-note");
      UI.$("pin-doc-list").innerHTML = "";
      UI.$("pin-file-info").classList.add("hidden");
      UI.$("pin-file-info").textContent = "";
      UI.hide("field-pin-imgname");
      UI.hide("pin-upload-status");
      // 접이식 필드/토글 초기화
      ["field-pin-url", "field-pin-note"].forEach(id => { const el = UI.$(id); if (el) el.classList.add("hidden"); });
      ["btn-pin-note-toggle", "btn-pin-url-toggle"].forEach(id => { const b = UI.$(id); if (b) b.classList.remove("active"); });
      UI.disable("btn-confirm-pin");
      if (hideForm) { State.editingPinId = null; this._closePinForm(); UI.$("pending-pin").classList.add("hidden"); }
    },

    /* ── 모바일 하단 네비 바인딩 (메뉴=바텀시트, 콘텐츠 안 가림) ── */
    _bindMobileNav() {
      const $ = (id) => UI.$(id);
      const closeSheet = () => document.body.classList.remove("sidebar-open");
      const toggleSheet = () => document.body.classList.toggle("sidebar-open");

      // [마스터] 모바일 도구 드롭다운 토글 — 접이식으로 화면 30% 이내 유지
      const stbT = $("stb-toggle");
      if (stbT) stbT.addEventListener("click", () => {
        const open = document.body.classList.toggle("tools-open");
        stbT.setAttribute("aria-expanded", open ? "true" : "false");
      });

      const menu = $("mnav-menu");
      if (menu) menu.addEventListener("click", () => {
        toggleSheet();
        menu.classList.toggle("active", document.body.classList.contains("sidebar-open"));
      });

      const bd = $("sidebar-backdrop");
      if (bd) bd.addEventListener("click", closeSheet);

      // 도면 등록 → 기존 업로드 버튼 위임
      const up = $("mnav-upload");
      if (up) up.addEventListener("click", () => {
        closeSheet();
        const b = $("btn-upload-drawing"); if (b) b.click();
      });

      // 포인트 추가 → 기존 마킹 토글
      const place = $("mnav-place");
      if (place) place.addEventListener("click", () => {
        closeSheet();
        const b = $("btn-place"); if (b) b.click();
      });

      // 포인트 목록 → 전체 핀 드로어
      const pins = $("mnav-pins");
      if (pins) pins.addEventListener("click", () => {
        closeSheet();
        // 모바일: 화면을 가리지 않는 바텀시트(PinGrid) 토글. 도면이 있을 때만 의미.
        const hasDrawing = (typeof State !== "undefined") && (State.pdfDoc || (State.viewerPages && State.viewerPages.length));
        if (hasDrawing && typeof PinGrid !== "undefined") {
          PinGrid.render();
          PinGrid.setCollapsed(!PinGrid.collapsed ? true : false);
        } else if (typeof AllPins !== "undefined" && AllPins.show) {
          AllPins.show();
        }
      });

      // ISO 3D 토글 (공통) — 메뉴/툴바에 묻혀 있던 ISO 를 하단 아이콘으로 직접 노출
      const iso = $("mnav-iso");
      if (iso) iso.addEventListener("click", () => { closeSheet(); MapCtrl.toggleIso(); });

      // 포인트 수정 모드 토글 (디자이너) — 기존 tb-pin-edit 동작 위임
      const edit = $("mnav-edit");
      if (edit) edit.addEventListener("click", () => {
        closeSheet();
        const b = $("tb-pin-edit"); if (b) b.click();
        edit.classList.toggle("active", document.body.classList.contains("pin-edit-mode"));
      });

      // 화면 맞춤
      const fit = $("mnav-fit");
      if (fit) fit.addEventListener("click", () => { closeSheet(); MapCtrl.fit(); });

      // 상단 빠른 도구(데스크톱) — 모바일 nav 와 동일 액션 위임
      const tqMenu = $("tq-menu");
      if (tqMenu) tqMenu.addEventListener("click", () => {
        toggleSheet();
        tqMenu.classList.toggle("active", document.body.classList.contains("sidebar-open"));
      });
      const tqUp = $("tq-upload");
      if (tqUp) tqUp.addEventListener("click", () => { const b = $("btn-upload-drawing"); if (b) b.click(); });
      const tqPlace = $("tq-place");
      if (tqPlace) tqPlace.addEventListener("click", () => { const b = $("btn-place"); if (b) b.click(); });
      const tqPins = $("tq-pins");
      if (tqPins) tqPins.addEventListener("click", () => {
        const hasDrawing = (typeof State !== "undefined") && (State.pdfDoc || (State.viewerPages && State.viewerPages.length));
        if (hasDrawing && typeof PinGrid !== "undefined") {
          PinGrid.render();
          PinGrid.setCollapsed(!PinGrid.collapsed);   // 토글: 열림↔접힘
        } else if (typeof AllPins !== "undefined" && AllPins.show) {
          AllPins.show();
        }
      });
      const tqFit = $("tq-fit");
      if (tqFit) tqFit.addEventListener("click", () => MapCtrl.fit());

      // 시트 열렸을 때 사이드바 내 버튼 클릭 시 자동 닫기(업로드/배포 등 액션성)
      const sb = $("sidebar");
      if (sb) sb.addEventListener("click", (e) => {
        if (!document.body.classList.contains("sidebar-open")) return;
        const t = e.target.closest("button");
        if (t && (t.id === "btn-upload-drawing" || t.id === "btn-deploy" || t.classList.contains("deck-name"))) {
          setTimeout(closeSheet, 120);
        }
      });

      // ═══ [마스터] 모바일 그룹 도크 — 칩으로 도구 그룹 전환, 펼치면 도면을 위로 밀어 절대 가리지 않음 ═══
      const dock = $("mobile-dock");
      if (dock) {
        const rows = dock.querySelectorAll(".mdock-row");
        const grpChips = dock.querySelectorAll("[data-grp]");
        let curGrp = null;
        // 도면 영역 하단 패딩 = 도크 실제 높이 → 트레이를 펼쳐도 도면이 위로 밀려 절대 가려지지 않음(오버레이 아님).
        const setPad = () => {
          const ma = $("map-area"); if (!ma) return;
          if (window.matchMedia && window.matchMedia("(max-width:760px)").matches) ma.style.paddingBottom = dock.offsetHeight + "px";
          else ma.style.paddingBottom = ""; // 데스크톱: CSS 기본 복원
        };
        const closeTray = () => {
          dock.classList.remove("tray-open");
          rows.forEach((r) => r.classList.remove("active"));
          grpChips.forEach((c) => c.classList.remove("active"));
          curGrp = null;
          setPad(); setTimeout(setPad, 300);
        };
        // 그룹 칩 → 그 그룹 도구 한 줄만 펼침(다른 그룹은 숨김), 같은 칩 재탭 → 접힘
        grpChips.forEach((chip) => {
          chip.addEventListener("click", () => {
            const g = chip.dataset.grp;
            if (curGrp === g) { closeTray(); return; }
            closeSheet();
            curGrp = g;
            rows.forEach((r) => r.classList.toggle("active", r.dataset.group === g));
            grpChips.forEach((c) => c.classList.toggle("active", c === chip));
            dock.classList.add("tray-open");
            setPad(); setTimeout(setPad, 300);
          });
        });
        // 메뉴 칩 → 사이드바 시트(프로젝트/구역/체크보드/360 등)
        const menuChip = dock.querySelector('[data-act="menu"]');
        if (menuChip) menuChip.addEventListener("click", () => {
          closeTray();
          toggleSheet();
          menuChip.classList.toggle("active", document.body.classList.contains("sidebar-open"));
        });
        // 포인트 FAB(1탭) → 기존 배치 토글에 위임 + State.placing 동기화
        const placeChip = dock.querySelector('[data-act="place"]');
        if (placeChip) placeChip.addEventListener("click", () => {
          closeTray();
          const b = $("btn-place"); if (b) b.click();
          requestAnimationFrame(() => placeChip.classList.toggle("active", !!(typeof State !== "undefined" && State.placing)));
        });
        // 목록 칩 → 포인트 그리드(화면 가리지 않는 바텀시트)
        const listChip = dock.querySelector('[data-act="list"]');
        if (listChip) listChip.addEventListener("click", () => {
          closeTray();
          const hasDrawing = (typeof State !== "undefined") && (State.pdfDoc || (State.viewerPages && State.viewerPages.length));
          if (hasDrawing && typeof PinGrid !== "undefined") { PinGrid.render(); PinGrid.setCollapsed(!PinGrid.collapsed ? true : false); }
          else if (typeof AllPins !== "undefined" && AllPins.show) AllPins.show();
        });
        // 도구 → 기존 핸들러에 click 위임(재구현 0). 토글형은 원본 active 상태 동기화.
        dock.querySelectorAll(".mdock-tool").forEach((tool) => {
          tool.addEventListener("click", () => {
            const t = $(tool.dataset.deleg);
            if (t) t.click();
            const sync = tool.dataset.sync;
            if (sync) { const src = $(sync); if (src) requestAnimationFrame(() => tool.classList.toggle("active", src.classList.contains("active"))); }
          });
        });
        requestAnimationFrame(setPad);
        window.addEventListener("resize", setPad);
      }

      // [사이드바 재구성] 컴팩트 도구바 — 기존 버튼에 click 위임(재구현 0), 토글형 active 동기화
      document.querySelectorAll("#side-toolbar .stb-btn").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var t = UI.$(btn.dataset.deleg); if (t) t.click();
          var sync = btn.dataset.sync;
          if (sync) { var src = UI.$(sync); if (src) requestAnimationFrame(function () { btn.classList.toggle("active", src.classList.contains("active")); }); }
        });
      });
    },

    /* ── Map ── */
    _bindMap() {
      const vp = UI.$("map-viewport");

      vp.addEventListener("wheel", e => { e.preventDefault(); MapCtrl.handleWheel(e); }, { passive: false });

      vp.addEventListener("mousedown", e => {
        // ── [마스터 요청 #7] 핀(또는 액션버튼) 위를 눌렀으면 배치/그리기보다 핀 클릭을 우선.
        //   (체크보드는 항상 placing 상태라, 양보 없으면 핀 위 클릭 시 새 핀이 찍혀 '핀클릭 안됨'이 됨)
        if (e.target && e.target.closest(".pin-marker")) { return; }
        if (State.placing) { this._handlePlaceClick(e); return; }
        if (State.drawingZone) { if (Zones.onDrawStart(e.clientX, e.clientY)) { e.preventDefault(); return; } }
        MapCtrl.handlePanStart(e);
      });
      window.addEventListener("mousemove", e => {
        if (State.drawingZone && (Zones._drag || Zones._shape === "poly")) { Zones.onDrawMove(e.clientX, e.clientY); return; }
        MapCtrl.handlePanMove(e);
      });
      window.addEventListener("mouseup",   e => {
        if (State.drawingZone && Zones._drag) { Zones.onDrawEnd(e.clientX, e.clientY); return; }
        MapCtrl.handlePanEnd();
      });

      // ═══ 터치 제스처: 1손가락 팬 + 2손가락 핀치 줌 + 더블탭 줌 ═══
      // 딥리서치 결과: 모바일 PDF/도면 뷰어에서 핀치 줌은 필수(미지원 시 이탈)
      let lastTouch = null;          // 1손가락 팬 추적
      let pinch = null;              // 2손가락 핀치 상태 {dist, cx, cy}
      let lastTapTime = 0;           // 더블탭 추적
      let lastTapXY = null;
      // [WO 20261001-mobilefast] 핀치 해제 직후 손가락이 거의 동시에 떨어지며 생기는
      // touchend 를 "탭"으로 오인하지 않도록 쿨다운(요구사항 §1: "손을 뗀 뒤 250ms 탭 무시").
      let pinchEndedAt = 0;
      const PINCH_TAP_COOLDOWN_MS = 250;

      const touchDist = (t0, t1) => Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
      const touchMid  = (t0, t1) => ({ x: (t0.clientX + t1.clientX) / 2, y: (t0.clientY + t1.clientY) / 2 });

      vp.addEventListener("touchstart", e => {
        MapCtrl.cancelFly();
        if (e.touches.length === 2) {
          // 핀치 시작 — 팬 종료, 두 손가락 거리/중점 기록
          lastTouch = null;
          const mid = touchMid(e.touches[0], e.touches[1]);
          pinch = { dist: touchDist(e.touches[0], e.touches[1]), cx: mid.x, cy: mid.y };
          e.preventDefault();
          return;
        }
        if (e.touches.length === 1) {
          // [WO 20261001-mobilefast] 핀치 해제 직후 250ms — 잔여 터치를 배치/그리기로 처리하지 않는다
          // (여전히 손가락은 화면에 있을 수 있으므로 팬 추적은 유지, 탭 계열 동작만 차단).
          const inPinchCooldown = (Date.now() - pinchEndedAt) < PINCH_TAP_COOLDOWN_MS;
          // 핀(또는 액션버튼) 위 터치는 배치보다 핀 클릭을 우선 (체크보드 핀 클릭 보장)
          if (e.target && e.target.closest(".pin-marker")) { return; }
          if (State.placing) { if (!inPinchCooldown) this._handlePlaceTouch(e); return; }
          // [버그복원] 모바일 영역 그리기 — 데스크톱 mousedown 과 동일하게 터치에서도 onDrawStart
          if (!inPinchCooldown && State.drawingZone && typeof Zones !== "undefined") {
            if (Zones.onDrawStart(e.touches[0].clientX, e.touches[0].clientY)) { e.preventDefault(); return; }
          }
          lastTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        }
      }, { passive: false });

      vp.addEventListener("touchmove", e => {
        if (e.touches.length === 2 && pinch) {
          // [WO 20261001-mobilefast] 중심점 고정 핀치 줌+팬을 한 수식으로(MapCtrl.pinchTransform) —
          // 종전 2단계 합성(zoomBy 뒤 중점이동 보정 추가)은 ratio≠1 매 프레임 드리프트가 났다.
          const newDist = touchDist(e.touches[0], e.touches[1]);
          const mid = touchMid(e.touches[0], e.touches[1]);
          if (pinch.dist > 0) {
            const ratio = newDist / pinch.dist;
            const rect = MapCtrl.viewport.getBoundingClientRect();
            const r = MapCtrl.pinchTransform(State.pan, State.zoom, rect.left, rect.top, pinch.cx, pinch.cy, mid.x, mid.y, ratio);
            State.pan = r.pan; State.zoom = r.zoom;
            MapCtrl.applyTransform();
          }
          pinch = { dist: newDist, cx: mid.x, cy: mid.y };
          e.preventDefault();
          return;
        }
        // [버그복원] 영역 그리는 중엔 팬 대신 onDrawMove
        if (e.touches.length === 1 && State.drawingZone && typeof Zones !== "undefined" && (Zones._drag || Zones._shape === "poly")) {
          Zones.onDrawMove(e.touches[0].clientX, e.touches[0].clientY);
          e.preventDefault();
          return;
        }
        if (e.touches.length === 1 && lastTouch) {
          State.pan.x += e.touches[0].clientX - lastTouch.x;
          State.pan.y += e.touches[0].clientY - lastTouch.y;
          lastTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
          MapCtrl.applyTransform();
        }
        e.preventDefault();
      }, { passive: false });

      vp.addEventListener("touchend", e => {
        // 핀치 종료(손가락이 2개 미만이 되면)
        const wasPinching = !!pinch;
        if (pinch && (!e.touches || e.touches.length < 2)) pinch = null;
        // 손가락이 0개면 팬도 종료
        if (!e.touches || e.touches.length === 0) {
          // [WO 20261001-mobilefast] 핀치 중이었다면 이 해제는 탭이 아니다 — 더블탭/배치 추적에
          // 섞이지 않도록 쿨다운만 찍고 즉시 종료(요구사항 §1: "멀티터치 → 탭 무효").
          if (wasPinching) {
            pinchEndedAt = Date.now();
            lastTouch = null; lastTapTime = 0; lastTapXY = null;
            return;
          }
          // [버그복원] 영역 그리기(rect/circle) 종료 우선 — poly 는 onDrawStart 탭 누적이라 제외
          if (State.drawingZone && typeof Zones !== "undefined" && Zones._drag) {
            const dt = (e.changedTouches && e.changedTouches[0]);
            if (dt) Zones.onDrawEnd(dt.clientX, dt.clientY);
            lastTouch = null;
            return;
          }
          // 더블탭 줌 감지 (touchend 시점, 직전 탭과 시간·위치 근접)
          const t = (e.changedTouches && e.changedTouches[0]) || null;
          if (t && !State.placing && (Date.now() - pinchEndedAt) >= PINCH_TAP_COOLDOWN_MS) {
            const now = Date.now();
            const x = t.clientX, y = t.clientY;
            if (now - lastTapTime < 300 && lastTapXY &&
                Math.hypot(x - lastTapXY.x, y - lastTapXY.y) < 30) {
              // 더블탭: 현재 줌 기준 토글식 확대(이미 크면 fit)
              if (State.zoom >= 2.4) MapCtrl.fit();
              else MapCtrl.zoomBy(1.8, x, y);
              lastTapTime = 0; lastTapXY = null;
            } else {
              lastTapTime = now; lastTapXY = { x, y };
            }
          }
          lastTouch = null;
        }
      });

      // 더블클릭으로 클릭 지점 중심 줌인 (데스크톱)
      vp.addEventListener("dblclick", e => {
        if (State.placing) return;
        MapCtrl.zoomBy(1.6, e.clientX, e.clientY);
      });

      // 플로팅 네비게이션 툴바 (Bluebeam 스타일 — 확대/축소/맞춤/실제크기)
      const bind = (id, fn) => { const el = UI.$(id); if (el) el.addEventListener("click", fn); };
      bind("btn-zoom-in",  () => MapCtrl.zoomBy(1.25));
      bind("btn-zoom-out", () => MapCtrl.zoomBy(0.8));
      bind("btn-fit",      () => MapCtrl.fit());
      bind("btn-actual",   () => MapCtrl.actualSize());
      bind("zoom-level",   () => MapCtrl.actualSize());
      bind("btn-iso",      () => MapCtrl.toggleIso());
      // 회전 (PDF.js 내장 getViewport({rotation}) 활용)
      bind("btn-rotate-cw",  () => this._rotatePdf(90));
      bind("btn-rotate-ccw", () => this._rotatePdf(-90));
      bind("rotate-level",   () => { State.pdfRotation = 0; this._rotatePdf(0); });

      // ═══ ezPDF 스타일 상단 도구 툴바 (동일 핸들러 재사용) ═══
      bind("tb-zoom-in",   () => MapCtrl.zoomBy(1.25));
      bind("tb-zoom-out",  () => MapCtrl.zoomBy(0.8));
      bind("tb-zoom-level",() => MapCtrl.actualSize());
      bind("tb-fit",       () => MapCtrl.fit());
      bind("tb-actual",    () => MapCtrl.actualSize());
      bind("tb-iso",       () => MapCtrl.toggleIso());
      // [마스터 요청] 포인트 수정 모드 토글 — 켠 뒤 핀 클릭 시 수정/이동/삭제 팝업
      bind("tb-pin-edit",  () => {
        State.editMode = !State.editMode;
        const b = UI.$("tb-pin-edit");
        if (b) b.classList.toggle("active", State.editMode);
        document.body.classList.toggle("pin-edit-mode", State.editMode);
        // [토스트 스팸 제거] 버튼 active 상태 + body.pin-edit-mode 스타일로 결과가 이미 보인다.
      });
      bind("tb-rotate-cw", () => this._rotatePdf(90));
      bind("tb-rotate-ccw",() => this._rotatePdf(-90));
      // [마스터: "pdf뷰 방향 보정 기능이 사라졌네"] 도면 화면 진입구 — 파노라마 전용 버튼(#btn-pano-setdir)과
      //   동일한 경로(openPano→Radar.enterDirAdjustMode)를 공유한다(로직 복제 금지). 선행조건 미충족 시
      //   조용히 무반응하지 않고 토스트로 사유를 알린다.
      bind("tb-setdir", () => {
        const pin = (State.pins || []).find(p => p.id === State.activePin);
        if (!pin) {
          if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("먼저 도면에서 핀을 선택하세요");
          return;
        }
        if (!this.pinHasMedia(pin)) {
          if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("이 핀에는 360 사진이 없어 방향을 지정할 수 없습니다");
          return;
        }
        this.openPano(pin);   // 동기 구간에서 Radar.update(pin)까지 실행되어 미니맵이 즉시 표시됨
        // [p13 회귀주의] 아래 호출은 #btn-pano-setdir 핸들러와 "동일 로직을 공유"하되, 완전히 동일한
        // 문자열로 두면 tests/p13-setdir-flow.test.mjs 의 String.replace(needle) 뮤테이션이 먼저
        // 나오는 이 블록을 대신 맞혀 원본 검증을 무력화한다 — 괄호 표현만 구분해 회피(동작은 동일).
        if (typeof Radar !== "undefined" && Radar.enterDirAdjustMode) { Radar.enterDirAdjustMode(); }
      });
      // 페이지 이동
      bind("tb-first", () => this._gotoPage(1));
      bind("tb-prev",  () => this._changePage(-1));
      bind("tb-next",  () => this._changePage(1));
      bind("tb-last",  () => this._gotoPage(this._totalPages()));
      // 썸네일 패널 토글
      bind("tb-thumbs", () => UI.toggleThumbPanel());
      // 포인트 마킹 — 기존 마킹 버튼(btn-place) 위임
      bind("tb-mark", () => { const b = UI.$("btn-place"); if (b) b.click(); });
      // 페이지 직접 입력
      const tbJump = UI.$("tb-page-input");
      if (tbJump) {
        const doTbJump = () => {
          const n = parseInt(tbJump.value, 10);
          if (!isNaN(n)) this._gotoPage(n);
          else tbJump.value = State.pdfPage;
        };
        tbJump.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); tbJump.blur(); } });
        tbJump.addEventListener("blur", doTbJump);
        tbJump.addEventListener("focus", () => tbJump.select());
      }
    },

    /** 선택된 구역명 기반 자동 사진 파일명: '구역명_번호'. 구역 없으면 null. */
    _zoneImageName() {
      const deck = (typeof Projects !== "undefined") ? Projects.currentDeck : null;
      if (!deck || !deck.name) return null;
      const base = String(deck.name).trim().replace(/\s+/g, "_").replace(/[^\w가-힣\-]/g, "");
      const page = State.pdfPage || 1;
      let n = 0;
      (State.pins || []).forEach((p) => {
        if ((p.page || 1) !== page) return;
        if (p.imageId || p.pendingOpId || p.imageName) n++;
      });
      const next = State.editingPinId ? Math.max(n, 1) : (n + 1);
      return base + "_" + next;
    },

    /** ── [마스터 요청] 핀 사진/영상 파일 공통 처리 + RICOH THETA 360 자동 판별 ──
     *  @param f         선택된 File
     *  @param isVid     동영상 여부
     *  @param viaTheta  THETA 360 버튼 경로 여부(360 후보 우선)
     *  THETA 사진은 equirectangular(가로:세로 ≈ 2:1) → 비율 검사로 360 자동 태깅. */
    _acceptPinMediaFile(f, isVid, viaTheta) {
      State.pendingFile = f;
      State.pendingIsVideo = !!isVid;
      State.pendingIs360 = false; // 검사 후 갱신
      const info = UI.$("pin-file-info");
      const sizeMB = (f.size / 1024 / 1024).toFixed(1);
      info.textContent = (isVid ? "" : "") + f.name + " (" + sizeMB + " MB)";
      info.classList.remove("hidden");
      UI.show("field-pin-imgname");
      const autoName = this._zoneImageName();
      UI.$("input-pin-imgname").value = autoName || f.name.replace(/\.[^.]+$/, "");
      this._updateConfirmEnabled();

      // 이미지면 실제 픽셀 비율로 360(2:1) 판별 → 뱃지 표시 + 360 태깅
      if (!isVid && f.type.startsWith("image/")) {
        this._detect360(f, (is360, w, h) => {
          State.pendingIs360 = is360;
          const badge = is360 ? "  360° 파노라마" : (viaTheta ? "  360 비율 아님(일반 사진)" : "");
          if (badge) {
            info.textContent = (is360 ? "" : "") + f.name + " (" + sizeMB + " MB)" + badge;
          }
          if (is360 && !autoName) {
            // 360이면 이름 끝에 _360 힌트
            const cur = UI.$("input-pin-imgname").value;
            if (cur && !/_360$/i.test(cur)) UI.$("input-pin-imgname").value = cur + "_360";
          }
          if (is360 && Prompt && Prompt.toast)
            Prompt.toast("360° 사진 감지(" + w + "×" + h + ") — 둘러보기 뷰어로 표시됩니다");
        });
      }

      // 새 포인트 + 이미지 → 즉시 저장(편집 모드는 명시적 저장 버튼)
      if (!State.editingPinId) {
        setTimeout(() => this._confirmPin(), viaTheta ? 260 : 120);
      }
    },

    /** 이미지 파일이 360 equirectangular(가로:세로 ≈ 2:1)인지 비동기 판별 */
    _detect360(file, cb) {
      try {
        const url = URL.createObjectURL(file);
        const im = new Image();
        im.onload = () => {
          const w = im.naturalWidth, h = im.naturalHeight;
          const ratio = h > 0 ? w / h : 0;
          // THETA/equirectangular는 정확히 2:1. 허용오차 ±8%.
          const is360 = ratio >= 1.85 && ratio <= 2.15 && w >= 1024;
          URL.revokeObjectURL(url);
          cb(is360, w, h);
        };
        im.onerror = () => { URL.revokeObjectURL(url); cb(false, 0, 0); };
        im.src = url;
      } catch (e) { cb(false, 0, 0); }
    },

    /** 체크보드 모드: 클릭 즉시 번호 핀 생성(이름/사진 폼 없음).
     *  번호는 현재 페이지 내 순번(렌더 규칙과 동일)으로 자동 부여. */
    /** [WO 20260929 addendum, 지휘자 정정] 🔴 시작번호 저장 SoT — State.checkboardStart 형식을
     *  계열별 중첩({checkboard:{page:n}, content:{page:n}})으로 바꾼다(마스터: "세팅도 각 모드에서
     *  가능하게 해" — CHECKER 시작번호와 360 시작번호는 서로 다른 값이어야 한다).
     *  마이그레이션 없이: 서버 컬럼(deployments.checkboard_start)은 그대로 JSON TEXT 라 스키마
     *  변경이 없다 — 구버전 평면 형식({page:n, ...})은 로드 시 이 함수가 "전부 checkboard 계열"
     *  로 해석해 감싼다(과거엔 번호핀이 전부 checkboard:true 였으므로 사실과 일치 — content(360)는
     *  새로 시작, 기본 1). 네 군데 로드 지점(_loadLatestDeployment 등)이 전부 이 함수 하나만
     *  거친다(§10 SoT — 각자 파싱하면 형식이 갈라진다). */
    _normalizeCheckboardStart(raw) {
      const o = (raw && typeof raw === "object") ? raw : {};
      const hasSeriesShape = ("checkboard" in o) || ("content" in o);
      const looksNested = hasSeriesShape && ["checkboard", "content"].every((k) => !(k in o) || (o[k] && typeof o[k] === "object"));
      if (looksNested) {
        return {
          checkboard: (o.checkboard && typeof o.checkboard === "object") ? o.checkboard : {},
          content: (o.content && typeof o.content === "object") ? o.content : {}
        };
      }
      return { checkboard: o, content: {} }; // 구버전 평면 형식 → 전부 checkboard 계열로 승계
    },
    /** 현재 구역(페이지)의 시작 번호 (미설정 시 1). series 생략 시 "checkboard"(하위호환).
     *  🔴 [WO 20260917 멀티유저 ①·재설계] 마스터 확정: "시작번호 = 사용자별 번호 대역"
     *  (예: 사용자A=100, 사용자B=200 — 번호만 봐도 누가 찍었는지 알고, 충돌이 구조적으로 없다).
     *  로그인 사용자의 대역(PinSeries.userBandStart, localStorage 영속, 계열별 키)이 있으면
     *  최우선이고, 없으면 계열별 페이지값(State.checkboardStart[series], 구버전/비로그인 폴백)을 쓴다. */
    /*  🔴 [WO 20261001-startno] 시작번호 = **내 대역의 시작값**(대역 안의 직접 입력 하한이 있으면 그 값).
     *  대역 k 는 서버(project_members.num_band — 24b_NumBand.js 가 받아 PinSeries 캐시에 둔다) SoT.
     *  배포본 checkboardStart(페이지별·전원 공유 — 사용자 대역과 섞이면 서로 덮어쓴다)는 더 이상 채번에 쓰지 않는다
     *  (prod 실측: deployments.checkboard_start 는 NULL 25 · "{}" 5 — 값이 있는 행 0, 영향 0). page 인자는 시그니처 호환. */
    _checkboardStart(page, series) {
      const ser = series === "content" ? "content" : "checkboard";
      const r = PinSeries.bandRange(this._numBand());
      const f = PinSeries.userStart(this._pinAuthor(), ser);
      return (f != null && f >= r.lo && f <= r.hi) ? f : r.lo;
    },
    /** 내 번호 대역 k (서버 배정 캐시 → 없으면 1). */
    _numBand() {
      const k = PinSeries.myBand(this._pinAuthor());
      return (Number.isFinite(k) && k >= 1) ? k : 1;
    },
    /** 대역 변경 — 캐시 즉시 반영 + 서버 저장(24b_NumBand.persistBand, 로드돼 있을 때). */
    _setNumBand(k) {
      const b = PinSeries.bandRange(k).band;
      PinSeries.setMyBand(this._pinAuthor(), b);
      if (typeof NumBand !== "undefined" && NumBand.persistBand) NumBand.persistBand(b);
      if (typeof NumBand !== "undefined" && NumBand.render) NumBand.render();
      return b;
    },
    /** 직접 입력(고급) — 입력값이 속한 대역으로 귀속 + 그 대역 안 하한으로 기억(사용자·프로젝트·계열별). */
    _setCheckboardStart(page, value, series) {
      const ser = series === "content" ? "content" : "checkboard";
      let n = parseInt(value, 10);
      if (!Number.isFinite(n) || n < 1) n = 1;
      PinSeries.setUserStart(this._pinAuthor(), ser, n);
      this._setNumBand(PinSeries.bandOf(n));
      return n;
    },
    /** 대역이 가득 찼을 때 — 넘쳐 들어가지 않고 확인창으로 다음 빈 대역 제안(동시에 하나만). */
    async _bandFull(nx) {
      if (this._bandFullAsking) return;
      this._bandFullAsking = true;
      try {
        const next = (typeof NumBand !== "undefined" && NumBand.nextFreeBand) ? NumBand.nextFreeBand(nx.band) : nx.band + 1;
        const ok = (typeof Prompt !== "undefined" && Prompt.confirm)
          ? await Prompt.confirm("번호 대역", "대역이 가득 찼습니다 — 다음 대역(" + PinSeries.bandLabel(next) + ")으로 바꿀까요?")
          : false;
        if (ok) {
          this._setNumBand(next);
          Prompt.toast && Prompt.toast("번호 대역 " + PinSeries.bandLabel(next) + " — 도면을 다시 누르면 이어서 찍힙니다");
        }
      } finally { this._bandFullAsking = false; }
    },

    /** [WO 20260918] 🔴 사용자가 버튼을 눌러서만 실행되는 일괄 재채번(자동 재채번 아님 —
     *  duplicateCheckboardIds() 위 주석의 금지 규율과 충돌하지 않는다, 01b_PinSeries.js 참조).
     *  버튼 클릭 → 새 시작번호 입력(Prompt.ask, 새 UI 없음) → 미리보기/확인(confirm) →
     *  적용. 계산·검증은 PinSeries.renumberCheckboardRange() 정본에 전부 있고, 여기선
     *  호출·확인·반영만 한다.
     *  [WO 20260929 addendum, 지휘자 정정] series 생략 시 "checkboard"(하위호환, 기존
     *  #btn-checkboard-renumber 무인자 호출 그대로 동작) — 마스터: "번호 일괄 변경도 현재
     *  모드 핀만 대상"이라 24_Settings.js 가 현재 모드(State.regMode)를 넘겨 호출한다. */
    async _renumberCheckboard(series) {
      const ser = series === "content" ? "content" : "checkboard";
      const seriesLabel = (typeof PinSeries !== "undefined" && PinSeries.LABELS && PinSeries.LABELS[ser]) || ser;
      const page = State.pdfPage || 1;
      const cur = PinSeries.numbers(State.pins, page);
      const curTargets = (State.pins || []).filter((p) => p && (p.page || 1) === page && PinSeries.seriesOf(p) === ser);
      if (!curTargets.length) { Prompt.toast && Prompt.toast("이 페이지에는 " + seriesLabel + " 핀이 없습니다"); return; }
      let curMin = Infinity, curMax = -Infinity;
      curTargets.forEach((p) => { const info = cur.get(p.id); if (info) { curMin = Math.min(curMin, info.no); curMax = Math.max(curMax, info.no); } });
      const res = await Prompt.ask({
        title: seriesLabel + " 번호 일괄 변경",
        sub: "현재 " + curTargets.length + "개(" + curMin + "~" + curMax + "번) — 새 시작 번호를 입력하세요",
        placeholder: "새 시작 번호", value: String(curMax + 1)
      });
      if (!res) return;
      const result = PinSeries.renumberCheckboardRange(State.pins, page, res.value, null, ser);
      if (!result.ok) { Prompt.toast && Prompt.toast(result.reason || "변경할 수 없습니다"); return; }
      const first = result.changes[0].newLabel, last = result.changes[result.changes.length - 1].newLabel;
      if (!await Prompt.confirm(seriesLabel + " 번호 일괄 변경", seriesLabel + " 핀 " + result.changes.length + "개를 " + first + "~" + last + "번으로 변경합니다. 되돌리기 어렵습니다 — 계속할까요?")) return;
      const byId = new Map((State.pins || []).map((p) => [p.id, p]));
      result.changes.forEach((c) => {
        const pin = byId.get(c.id);
        if (!pin) return;
        pin.label = c.newLabel;
        pin.labelManual = true;   // [WO 20260930-numdup] 사용자가 정한 번호 — 동시 생성 재채번(resolveConcurrentNos) 대상 아님
        // [WO 20260918] 🔴 id 는 절대 건드리지 않는다 — 사진/노트는 pin.id 로 연결되므로
        // 라벨(표시 번호)만 바뀌어도 연결 불변. 아래 로그는 그 사실을 재확인용으로 남긴다.
        if (typeof Log !== "undefined") Log.push("pin.renumber", pin.id, { oldLabel: c.oldLabel, newLabel: c.newLabel, page: page });
        if (!navigator.onLine && typeof OpLog !== "undefined" && OpLog.recordCurrent) { try { OpLog.recordCurrent("pin", "upsert", pin.id, pin); } catch (e) {} }
      });
      this._markDirty && this._markDirty();
      this._autoSave && this._autoSave();
      if (typeof UI !== "undefined") { UI.renderPinsOnMap && UI.renderPinsOnMap(); UI.renderPinList && UI.renderPinList(); }
      this._updateCheckboardQuickStatus && this._updateCheckboardQuickStatus(page);
      Prompt.toast && Prompt.toast(result.changes.length + "개 번호를 " + first + "~" + last + "번으로 변경했습니다" + (navigator.onLine ? "" : "(오프라인 — 연결 후 동기화)"));
    },

    /** [WO 20260917 멀티유저 ②] 핀 생성 시점의 작성자 식별자(이메일 우선) — 없으면 null.
     *  🔴 신규 핀에만 부여(편집 시 기존 pin.author 는 건드리지 않는다 — 편집자≠원작성자).
     *  기존 13_Notes.js/32_Offline.js 와 동일 관례(author=email)를 재사용(SoT 필드명 통일). */
    _pinAuthor() {
      try {
        if (typeof Auth !== "undefined" && Auth.user) return Auth.user.email || Auth.user.name || null;
      } catch (e) {}
      return null;
    },

    /** [WO 20260929 addendum, 지휘자 정정] 🔴 유일한 생성 지점 — CHECKER(checkboard)와 360(photo)
     *  둘 다 여기서 만들어진다. 마스터: "번호체계도 다르게 해" — State.regMode 로 계열을 갈라
     *  각 계열끼리만 채번한다(nextSeriesNo, §10 SoT). photo(360) 핀은 pin.checkboard 필드
     *  자체를 생략한다(마스터: "기존 데이터: checkboard 플래그 없는 핀 = 360 계열로 간주" —
     *  이 표현과 정확히 일치시킨다, 거짓 false 를 쓰지 않는다). */
    _placeCheckboardPin(pct) {
      const curPage = State.pdfPage || 1;
      const series = (State.regMode === "photo") ? "content" : "checkboard";
      // 🔴 채번 정본 = PinSeries. 계열마다 독립으로 "페이지 내 그 계열 핀 수"로 증가한다.
      const start = this._checkboardStart(curPage, series);
      const _auth0 = this._pinAuthor();
      // 🔴 [WO 20260930-numdup] 다음 번호 = 로드된 전원 핀 최댓값+1 — 작성자별로 보면 남의 번호와 겹쳤다(p93 B4).
      // 🔴 [WO 20261001-startno] 단, 내 대역 안에서만(다른 대역 핀 무시). 가득 차면 핀을 만들지 않고 확인창.
      const nx = PinSeries.nextInBand(State.pins, curPage, series, this._numBand(), start);
      if (nx.full) { this._bandFull(nx); return null; }
      const no = nx.no;
      // [WO 20260929-createdAt] 생성시각 명시 저장(PinSeries.createdAt 이 우선 사용 — id 파생은 구버전 폴백)
      const _now0 = Date.now();
      const pin = { id: _now0, createdAt: _now0, x: pct.x, y: pct.y, page: curPage, label: String(no) };
      if (series === "checkboard") pin.checkboard = true;
      if (_auth0) pin.author = _auth0; // [WO 20260917 멀티유저 ②]
      // [마스터 요청 2026-09-03] 배치 전 고른 종류(State.pendingIcon)로 연속 배치.
      //   폼(20_App.js:1846/1972)과 동일 규칙 — 기본값(number)이면 필드 자체를 생략(하위호환).
      if (State.pendingIcon && State.pendingIcon !== "number") pin.icon = State.pendingIcon;
      State.pins.push(pin);
      if (typeof GPS !== "undefined" && GPS.attachToPin) GPS.attachToPin(pin); // [WO 20261001-gps] 자동 위치 기록(비동기·저장 안 막음)
      if (typeof Log !== "undefined") Log.push("pin.add", pin.id, { label: pin.label, page: pin.page, checkboard: series === "checkboard" });
      State.activePin = pin.id;
      if (typeof Zones !== "undefined") Zones.refreshPinLinks();
      UI.renderPinList();
      UI.renderPinsOnMap(pin.id);
      if (typeof PinGrid !== "undefined") PinGrid.render();
      this._updateSyncBadge && this._updateSyncBadge();
      this._autoSave && this._autoSave();
      this._updateCheckboardQuickStatus(curPage);
      if (typeof NumBand !== "undefined" && NumBand.render) NumBand.render(); // 상단 "다음 N" 갱신
      // 🔴 [WO 20260929 마스터 정정] 이 함수는 항상 "번호 핀만" 만든다 — 폼·팝업·파일창·확인창·
      //   토스트 스팸 없음("체크보드 빈 곳 클릭 = 다른 반응 없음"). 사진 즉시등록(photo 모드)은
      //   호출부(_handlePlaceClick)가 반환된 pin 으로 별도 _openPinMediaPicker() 를 부른다.
      return pin;
    },

    /** 핀에 사진(360/일반) 선택창을 연다 — 체크보드 계열 핀 생성 직후(사진등록 모드, 마스터
     *  2026-09-29 요청)에 재사용. 🔴 iOS Safari 는 파일 선택창을 "사용자 클릭 활성화" 동기
     *  흐름 안에서 열어야 막히지 않는다 — 호출부(_handlePlaceClick)가 지도 클릭 핸들러에서
     *  동기 호출하므로 여기서도 setTimeout 없이 즉시 .click() 한다(지연 없음 = 활성화 유지).
     *  취소하면(파일 미선택) 핀은 번호만 가진 채 그대로 남는다(조용히 삭제 금지). */
    _openPinMediaPicker(pin) {
      const fi = UI.$("input-pin-file");
      if (!fi) return;
      // 기존 editPin()과 동일한 "편집 대상" 상태만 세팅(재사용) — 폼(_openPinForm)은 열지 않는다.
      State.editingPinId = pin.id;
      State.pending = { x: pin.x, y: pin.y };
      State.pendingFile = null; State.pendingIsVideo = false; State.pendingDocs = [];
      State.pendingIcon = pin.icon || "number";
      UI.$("input-pin-label").value = pin.label || "";
      UI.clearVal("input-pin-note");
      UI.clearVal("input-pin-url");
      UI.clearVal("input-pin-imgname");
      State._checkboardAutoConfirm = true; // input-pin-file 의 change 핸들러가 소비하고 끈다
      // [방어적 폴백] 파일 선택창을 "취소"하면 change 이벤트가 아예 안 오는 브라우저가 있다
      //   (change 는 선택 완료 시에만 보장). window 포커스 복귀 후 일정 시간 안에 change 가
      //   안 왔으면 취소로 간주해 대기 상태만 정리한다(핀 자체는 이미 저장돼 있어 영향 없음).
      window.addEventListener("focus", () => {
        setTimeout(() => {
          if (State._checkboardAutoConfirm) {
            State._checkboardAutoConfirm = false;
            State.editingPinId = null;
            State.pending = null;
          }
        }, 400);
      }, { once: true });
      fi.click();
    },

    /** [마스터 요청 2026-09-03] 사이드바 툴레일 "포인트" 버튼의 진입점 — 클릭 한 번으로
     *  체크보드 순차 배치 모드로 들어간다(기존 로직 재사용, 새 진입 로직 없음).
     *  이미 체크보드 모드면 배치 토글(#btn-place)만 위임한다. */
    _quickCheckboardEntry() {
      if (!State.checkboard) {
        const cb = UI.$("btn-checkboard-enter");
        if (cb) cb.click(); // 기존 toggleCheckboard 재사용 — 체크보드 진입 + 배치 자동 시작
      } else {
        const bp = UI.$("btn-place");
        if (bp) bp.click();
      }
    },

    /* [WO 20261001-startno] 구 _checkboardQuickRange()(페이지 전체 최소~최대) 삭제 — 유일 호출부였던 아래 상태문구가
       대역 안 다음 번호(PinSeries.nextInBand)로 바뀌어 고아가 됐다(남의 대역 번호까지 범위에 섞였다). */

    /** [마스터 요청 2026-09-03, WO 20260918 갱신] "지금 몇 번부터 / 몇 개 찍었는지"를 기존
     *  place-hint 문구에 반영한다. (구 "사진 폴더 연동" 퀵버튼 노출 토글은 그 버튼이 렌더
     *  고아라 삭제되며 함께 제거 — #btn-photobatch 로 통합.)
     *  [WO 20260929 addendum] State.regMode 로 계열을 판정해 CHECKER/360 각각의 시작번호·
     *  개수·다음번호를 보여준다(마스터: "번호체계도 다르게 해"). */
    _updateCheckboardQuickStatus(page) {
      const pg = page || State.pdfPage || 1;
      const series = (State.regMode === "photo") ? "content" : "checkboard";
      const cnt = (State.pins || []).filter((p) => p && (p.page || 1) === pg && PinSeries.seriesOf(p) === series).length;
      const hint = UI.$("place-hint");
      // [WO 20260930-autophoto] 남은 360 후보 사진 수를 함께 보여준다(PhotoBatch 세션 SoT).
      const avail = (series === "content" && typeof PhotoBatch !== "undefined" && PhotoBatch._autoRowsRemaining) ? PhotoBatch._autoRowsRemaining() : 0;
      const emptyHint = series === "content"
        ? (avail
            ? ("도면 위를 클릭하면 번호 핀과 함께 대기 중인 360 사진 " + avail + "장 중 가장 가까운 시각이 자동 연결됩니다")
            : "도면 위를 클릭하면 번호 핀과 함께 사진 선택창이 열립니다")
        : "도면 위를 클릭하면 번호가 자동으로 매겨집니다";
      // [WO 20261001-startno] "다음" = 내 대역 안 다음 번호(정본 nextInBand) — 페이지 전체 최댓값+1 은 남의 대역일 수 있다.
      const nx = PinSeries.nextInBand(State.pins, pg, series, this._numBand(), this._checkboardStart(pg, series));
      if (hint && State.checkboard) {
        hint.textContent = cnt
          ? ("대역 " + PinSeries.bandLabel(nx.band) + " · " + cnt + "개 찍음 · " + (nx.full ? "대역 가득" : ("다음 " + PinSeries.formatNo(nx.no, series) + "번")) + " (계속 클릭)" + (series === "content" && avail ? (" · 사진 " + avail + "장 대기") : ""))
          : emptyHint;
      }
      // [WO 20260930-autophoto] "사진 다시 선택" 버튼 — 360 모드에서 대기 사진이 있을 때만 노출.
      const reselect = UI.$("btn-photo-reselect");
      if (reselect) reselect.classList.toggle("hidden", !(series === "content" && avail && State.checkboard));
    },

    _handlePlaceClick(e) {
      if (!State.placing) return;
      const pct = MapCtrl.viewportToPercent(e.clientX, e.clientY);
      if (!pct) return;

      // [WO 20260929 마스터 정정] 체크보드 모드: 번호 핀만 — 폼·팝업·파일창·확인창 없음.
      // 연속 배치 — placing 을 유지해 클릭마다 번호가 1씩 증가하며 계속 찍힌다.
      if (State.regMode === "checkboard") {
        this._placeCheckboardPin(pct);
        return; // placing 유지(다음 클릭도 번호 핀). 종료는 '＋ 번호 핀 찍기' 토글로.
      }
      // [WO 20261001-autophoto2] 360(photo) 모드: 핀 생성 직후 곧바로 사진 선택창을 연다
      //   (PhotoBatch.autoConnectPin, 기존 _uploadOneRow/PhotoNaming 재사용). 마스터 재지시
      //   ("매번 연다") — 세션 후보 재사용으로 스킵하지 않고 클릭마다 항상 연다. 고른 파일 중
      //   가장 최근(이미 다른 핀에 쓴 건 제외) 1장을 허용오차 없이 바로 등록한다. 핀 생성(동기)과
      //   선택창 호출(.click()) 사이에 await 없음 — 모바일 user-activation 유지. 첨부/미첨부
      //   어느 쪽이든 핀은 유지된다(조용히 삭제 금지).
      if (State.regMode === "photo") {
        const pin = this._placeCheckboardPin(pct);
        if (pin) {
          if (typeof PhotoBatch !== "undefined" && PhotoBatch.autoConnectPin) PhotoBatch.autoConnectPin(pin);
          else this._openPinMediaPicker(pin); // PhotoBatch 미로드 시 기존 단일선택 폴백(조용한 실패 금지)
        }
        return; // placing 유지 — 계속 클릭하면 다음 번호 핀 + 자동매칭.
      }

      State.pending = pct;
      State.placing = false;
      UI.$("btn-place").classList.remove("active");
      UI.$("place-hint").classList.add("hidden");
      UI.$("crosshair-overlay").classList.add("hidden");
      UI.$("map-viewport").style.cursor = "grab";

      // _resetPinForm이 pending-pin을 hidden 처리 + State.pending=null 로 만들므로
      //    반드시 먼저 폼을 리셋한 뒤, 그 다음에 임시 핀을 표시/좌표 설정한다.
      State.editingPinId = null;
      this._resetPinForm(false);
      State.pending = pct; // resetPinForm이 지우므로 재설정

      const pp = UI.$("pending-pin");
      pp.style.left = pct.x + "%";
      pp.style.top  = pct.y + "%";
      pp.classList.remove("hidden");

      // 지정한 위치로 줌인 (플라이투) — 정확한 위치 확인
      MapCtrl.flyTo(pct.x, pct.y, Math.max(State.zoom, 2.2));

      this._openPinForm({ editing: false });
      // [THETA 인입] 위치지정 대기 중인 R* 360 사진이 있으면, 파일 선택 없이 그 사진을
      //   바로 첨부·등록한다(사진-우선 워크플로). 없으면 기존대로 사진 선택 다이얼로그.
      if (State.intakeFile) {
        const f = State.intakeFile; State.intakeFile = null;
        setTimeout(() => {
          this._acceptPinMediaFile(f, false, true);  // 360 판별 + 자동 _confirmPin → 핀 등록(오프라인 큐잉)
          if (typeof ThetaIntake !== "undefined") ThetaIntake._afterPlaced();
        }, 280);
      } else {
        // 포인트를 추가하면 바로 사진 업로드 다이얼로그를 띄운다 (요청사항)
        setTimeout(() => { const fi = UI.$("input-pin-file"); if (fi) fi.click(); }, 280);
      }
      // 위치명 입력이 표시돼 있을 때만 포커스 (구역 선택 시엔 숨겨짐)
      const addr = UI.$("pf-addr");
      if (addr && !addr.classList.contains("hidden")) UI.$("input-pin-label").focus();
    },

    _handlePlaceTouch(e) {
      e.preventDefault();
      const t = e.touches[0];
      this._handlePlaceClick({ clientX: t.clientX, clientY: t.clientY });
    },

    /* ── Pano ── */
    _bindPano() {
      UI.$("btn-pano-close").addEventListener("click", () => PanoViewer.close());

      const canvas = UI.$("pano-canvas");
      canvas.addEventListener("mousedown", e => PanoViewer.onPointerDown(e.clientX, e.clientY));
      window.addEventListener("mousemove", e => PanoViewer.onPointerMove(e.clientX, e.clientY));
      window.addEventListener("mouseup",   () => {
        const r = PanoViewer.onPointerUp();
        if (r && r.spotMoved) this._finalizeSpotDrag(r.spotMoved);
        else if (r && r.shapeDraft) this._finishShapeDraft(r.shapeDraft);
      });
      // [FARO Markers] 마커 위 마우스오버 → 내용 툴팁
      canvas.addEventListener("mousemove", e => this._panoHover(e.clientX, e.clientY));
      canvas.addEventListener("mouseleave", () => this._hideSpotTip());
      canvas.addEventListener("wheel", e => PanoViewer.onWheel(e), { passive: false });
      // ═══ 360 뷰어 터치: 1손가락 회전 + 2손가락 핀치 줌(FOV) ═══
      let panoPinchDist = null;
      const pDist = (t0, t1) => Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
      canvas.addEventListener("touchstart", e => {
        if (e.touches.length === 2) {
          panoPinchDist = pDist(e.touches[0], e.touches[1]);
          e.preventDefault();
        } else if (e.touches.length === 1) {
          PanoViewer.onPointerDown(e.touches[0].clientX, e.touches[0].clientY);
        }
      }, { passive: false });
      canvas.addEventListener("touchmove", e => {
        e.preventDefault();
        if (e.touches.length === 2 && panoPinchDist != null) {
          const d = pDist(e.touches[0], e.touches[1]);
          const delta = panoPinchDist - d;        // 벌리면 줌인(FOV↓), 모으면 줌아웃(FOV↑)
          if (Math.abs(delta) > 1) { PanoViewer.setFov(delta * 0.18); panoPinchDist = d; }
        } else if (e.touches.length === 1) {
          PanoViewer.onPointerMove(e.touches[0].clientX, e.touches[0].clientY);
        }
      }, { passive: false });
      canvas.addEventListener("touchend", e => {
        if (!e.touches || e.touches.length < 2) panoPinchDist = null;
        const wasTap = PanoViewer.wasTap && PanoViewer.wasTap();
        const r = PanoViewer.onPointerUp();
        if (r && r.spotMoved) { this._finalizeSpotDrag(r.spotMoved); return; }
        if (r && r.shapeDraft) { this._finishShapeDraft(r.shapeDraft); return; }
        if (r && r.shapeDraftCancelled) return; // [WO panoshapes] 그리기모드 중 탭만 하면 아무것도 안 함(점 마커 생성 방지)
        // [구면 마커] 탭이면 마커 추가/열기 (changedTouches 좌표 사용)
        if (wasTap && e.changedTouches && e.changedTouches[0]) {
          const t = e.changedTouches[0];
          this._onPanoTap(t.clientX, t.clientY);
        }
      });
      // [구면 마커] 마우스 탭(클릭)으로 마커 추가/열기
      canvas.addEventListener("click", e => { if (PanoViewer.wasTap && PanoViewer.wasTap()) this._onPanoTap(e.clientX, e.clientY); });

      // 파노라마 컨트롤 버튼
      UI.$("btn-pano-rotate").addEventListener("click", e => {
        const on = PanoViewer.toggleAuto();
        e.currentTarget.classList.toggle("on", on);
      });
      UI.$("btn-pano-zoomin").addEventListener("click",  () => PanoViewer.setFov(-10));
      UI.$("btn-pano-zoomout").addEventListener("click", () => PanoViewer.setFov(10));
      UI.$("btn-pano-reset").addEventListener("click",   () => PanoViewer.resetView());
      // [마스터] 천정 수평 보정 — 기울어진 360 사진을 좌/우로 미세 회전해 수평 맞춤
      UI.$("btn-pano-level-l") && UI.$("btn-pano-level-l").addEventListener("click", () => PanoViewer.adjustRoll(-0.7));
      UI.$("btn-pano-level-r") && UI.$("btn-pano-level-r").addEventListener("click", () => PanoViewer.adjustRoll(0.7));
      // [마스터: 방향 설정 = 도면에서 직접 클릭] 이 버튼은 "지정 완료"를 즉시 선언하지 않는다.
      // 미니맵 클릭 대기 모드(#pano-radar-dir 과 동일 모드, Radar._dirAdjust)로 진입만 시키고,
      // 실제 방향(pin.dirOffset) 저장과 완료 토스트는 사용자가 미니맵을 클릭한 뒤 Radar._commitAngle()에서만 일어난다.
      UI.$("btn-pano-setdir") && UI.$("btn-pano-setdir").addEventListener("click", () => {
        const pin = PanoViewer._currentPin;
        if (!pin) return;
        if (typeof Radar !== "undefined" && Radar.enterDirAdjustMode) Radar.enterDirAdjustMode();
      });
      // [마스터: 구면 마커] 추가 모드 토글
      // [FARO Markers] 마커 버튼 = 종류 선택 칩바 토글 / 칩 클릭 = 그 종류로 추가 모드
      UI.$("btn-pano-spot") && UI.$("btn-pano-spot").addEventListener("click", () => {
        const bar = UI.$("pano-spot-kinds");
        if (!bar) { this.setSpotAddMode(); return; }
        if (this._spotAdd) { this.setSpotAddMode(false); return; }   // 켜져 있으면 끄기
        bar.classList.toggle("hidden");
      });
      document.querySelectorAll("#pano-spot-kinds .psk-chip").forEach((ch) => {
        ch.addEventListener("click", () => {
          this._spotKind = ch.dataset.kind || "defect";
          document.querySelectorAll("#pano-spot-kinds .psk-chip").forEach((x) => x.classList.toggle("on", x === ch));
          this.setSpotAddMode(true);
        });
      });
      // [WO 20261001-panoshapes] 사각형/원 도형 그리기 모드 — 디자이너만, 점 추가 모드와 상호배타.
      const shapeBtns = { rect: UI.$("btn-pano-shape-rect"), circle: UI.$("btn-pano-shape-circle") };
      Object.keys(shapeBtns).forEach((type) => {
        const btn = shapeBtns[type]; if (!btn) return;
        btn.addEventListener("click", () => {
          if (!PanoViewer.canEditSpots()) { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("디자이너만 도형을 그릴 수 있습니다"); return; }
          const turningOn = PanoViewer._shapeDraw !== type;
          this.setSpotAddMode(false); // 점 추가 모드와 상호배타(동시에 두 모드가 캔버스 제스처를 가로채지 않게)
          PanoViewer.setShapeDrawMode(turningOn ? type : null);
          Object.keys(shapeBtns).forEach((t) => shapeBtns[t] && shapeBtns[t].classList.toggle("on", turningOn && t === type));
          if (turningOn && typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast((type === "rect" ? "사각형" : "원") + " 도형 — 360 안에서 드래그해 그리세요");
        });
      });
      this._shapeBtns = shapeBtns;
      // [FARO Markers] 마커 목록(테이블) 패널 토글
      UI.$("btn-pano-spotlist") && UI.$("btn-pano-spotlist").addEventListener("click", () => this.toggleSpotList());
      UI.$("pano-spot-list-close") && UI.$("pano-spot-list-close").addEventListener("click", () => { const p = UI.$("pano-spot-list"); if (p) p.classList.add("hidden"); });
      // [WO 20261001-panoshapes] 장비 설치 위치만 걸러보기
      UI.$("pano-spot-list-equip-filter") && UI.$("pano-spot-list-equip-filter").addEventListener("change", (e) => {
        this._spotListEquipOnly = !!e.target.checked;
        this.renderSpotList();
      });
      // ISO 4-꼭지점 뷰 전환
      document.querySelectorAll("#pano-iso-views .pano-iso-btn").forEach((b) => {
        b.addEventListener("click", (e) => {
          const corner = parseInt(e.currentTarget.getAttribute("data-iso"), 10) || 0;
          if (PanoViewer.open && typeof PanoViewer.setIsoView === "function") {
            PanoViewer.setIsoView(corner);
            document.querySelectorAll("#pano-iso-views .pano-iso-btn").forEach((x) => x.classList.remove("active"));
            e.currentTarget.classList.add("active");
          }
        });
      });
      UI.$("btn-pano-full").addEventListener("click", () => {
        const ov = UI.$("pano-overlay");
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else ov.requestFullscreen && ov.requestFullscreen().catch(() => {});
      });

      window.addEventListener("resize", () => {
        if (PanoViewer.open) PanoViewer._resize();
      });

      document.addEventListener("keydown", e => {
        if (e.key === "Escape" && PanoViewer.open) { PanoViewer.close(); return; }
        // 파노라마가 열려 있을 때: ← / → 로 이전/다음 포인트 이동
        if (PanoViewer.open) {
          if (e.key === "ArrowLeft")  { e.preventDefault(); PanoNav.go(-1); }
          else if (e.key === "ArrowRight") { e.preventDefault(); PanoNav.go(1); }
          return;
        }
        // ── [마스터 요청 #5] ESC → 직전 실행 명령 즉시 중지 ──
        //   (배치/영역그리기/핀이동/편집폼/팝업 등 진행 중이면 모두 종료)
        if (e.key === "Escape") {
          const canceled = this.cancelActiveOperation();
          if (canceled) { e.preventDefault(); return; }
          // 취소할 작업이 없으면: ISO 뷰면 평면으로 복귀
          if (State.isoView && typeof MapCtrl !== "undefined") {
            State.isoView = false; State.isoDir = 0; MapCtrl._applyIso(); e.preventDefault(); return;
          }
        }
        const tag = (e.target && e.target.tagName) || "";
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        // 회전 단축키 (Shift+←/→) — 도면이 로드돼 있으면 페이지 수와 무관하게 동작
        const rotGroup = UI.$("rotate-group");
        const canRotate = rotGroup && !rotGroup.classList.contains("hidden");
        if (e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
          if (canRotate) { e.preventDefault(); this._rotatePdf(e.key === "ArrowRight" ? 90 : -90); }
          return;
        }
        if (UI.$("pdf-pagination").classList.contains("hidden")) return;
        if (e.key === "ArrowLeft")      { e.preventDefault(); this._changePage(-1); }
        else if (e.key === "ArrowRight"){ e.preventDefault(); this._changePage(1); }
        else if (e.key === "Home")      { e.preventDefault(); this._gotoPage(1); }
        else if (e.key === "End")       { e.preventDefault(); this._gotoPage(this._totalPages()); }
      });
    },

    /* ── Drawing Load ── */
    /** 드래그 앤 드롭으로 도면 업로드 (디자이너 모드 전용) */
    _bindDragDrop() {
      const zone = UI.$("map-area");
      if (!zone || zone.dataset.dropBound) return;
      zone.dataset.dropBound = "1";
      // 모바일 쉬운 등록: 빈 화면(도면 안내)을 탭하면 바로 파일 선택
      const dropHint = UI.$("drop-hint");
      if (dropHint) {
        dropHint.style.cursor = "pointer";
        dropHint.addEventListener("click", () => {
          if (State.mode !== "designer") return;
          const inp = UI.$("input-drawing"); if (inp) inp.click();
        });
      }
      const accept = (f) => {
        if (!f) return false;
        const n = (f.name || "").toLowerCase();
        return f.type === "application/pdf" || f.type.startsWith("image/") ||
               /\.(pdf|png|jpe?g)$/i.test(n);
      };
      const setOver = (on) => {
        const hint = UI.$("drop-hint");
        if (hint) hint.classList.toggle("dragover", on);
        zone.classList.toggle("drop-active", on);
      };
      ["dragenter", "dragover"].forEach(ev =>
        zone.addEventListener(ev, (e) => {
          if (State.mode !== "designer") return;
          e.preventDefault(); e.stopPropagation();
          if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
          setOver(true);
        })
      );
      ["dragleave", "dragend"].forEach(ev =>
        zone.addEventListener(ev, (e) => {
          e.preventDefault(); e.stopPropagation();
          // 영역을 완전히 벗어났을 때만 해제
          if (ev === "dragleave" && zone.contains(e.relatedTarget)) return;
          setOver(false);
        })
      );
      zone.addEventListener("drop", (e) => {
        e.preventDefault(); e.stopPropagation();
        setOver(false);
        if (State.mode !== "designer") {
          if (typeof Prompt !== "undefined") Prompt.toast("ℹ 도면 업로드는 편집모드에서만 가능합니다.");
          return;
        }
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (!accept(f)) {
          if (typeof Prompt !== "undefined") Prompt.toast("PDF · PNG · JPG 파일만 업로드할 수 있습니다.");
          return;
        }
        this._loadDrawing(f);
      });
    },

    /** [P1] 구역 생성 전용 도면 파일 선택기 — 파일이 확정될 때까지 기다리고, 취소를 감지해 null 을 돌려준다.
     *  전역 #input-drawing 을 재사용하면 그 change 핸들러가 먼저 _loadDrawing 을 호출해
     *  "구역 선행" 가드와 충돌하므로(순서를 뒤집을 수 없음), 이 흐름 전용 일회용 input 을 쓴다.
     *  취소 감지: 표준 'cancel' 이벤트(Chrome 113+/FF 91+/Safari 16.4+) + 창 포커스 복귀 폴백(구형). */
    _pickDrawingFile() {
      return new Promise((resolve) => {
        const inp = document.createElement("input");
        inp.type = "file";
        inp.accept = ".pdf,.png,.jpg,.jpeg";
        inp.style.display = "none";
        let settled = false;
        let hardTimer = null;
        const finish = (f) => {
          if (settled) return;
          settled = true;
          window.removeEventListener("focus", onFocus, true);
          if (hardTimer) { clearTimeout(hardTimer); hardTimer = null; }
          try { inp.remove(); } catch (e) {}
          resolve(f || null);
        };
        const onFocus = () => {
          // 파일창이 닫혀 창이 돌아옴 → 잠시 뒤에도 파일이 없으면 '취소'로 확정
          setTimeout(() => { if (!(inp.files && inp.files.length)) finish(null); }, 1500);
        };
        inp.addEventListener("change", () => finish(inp.files && inp.files[0]));
        inp.addEventListener("cancel", () => finish(null));
        window.addEventListener("focus", onFocus, true);
        document.body.appendChild(inp);
        inp.click();
        // [WO 20260918] 🔴 상한 타임아웃 — 파일창이 아예 안 열리는 환경(헤드리스·일부 모바일
        // 브라우저·권한 거부)에서는 focus 이벤트가 오지 않아 이 Promise 가 영구 미해결됐고,
        // 그 결과 31_Projects.js 의 _creatingDeck 플래그가 영구 true 로 남아 이후 구역 생성이
        // 전부 조용히 무시됐다(지휘자 실제 피해, 새로고침 전까지 복구 불가). 60초 안에 change/
        // cancel/focus 신호가 전혀 없으면 취소로 확정하고 사용자에게 알린다.
        hardTimer = setTimeout(() => {
          if (settled) return;
          Prompt && Prompt.toast && Prompt.toast("파일 선택 창 응답이 없어 취소로 처리했습니다. 다시 시도해주세요.");
          finish(null);
        }, 60000);
      });
    },

    async _loadDrawing(file) {
      // ── [마스터 규칙·권한] 뷰어는 도면을 등록할 수 없다(보기 전용) ──
      //  도면 등록의 모든 진입 경로(버튼/단축키/드래그앤드롭/mnav/시트)는 결국 이 함수로 모이므로,
      //  여기서 한 번에 권한을 강제한다. 설계자 권한 + 디자이너 모드일 때만 통과.
      if (State.mode !== "designer" || (typeof Auth !== "undefined" && !Auth.isDesigner)) {
        Prompt && Prompt.toast && Prompt.toast("뷰어는 도면을 등록할 수 없습니다. 편집모드에서만 가능합니다.");
        return;
      }
      // ── [WO 20260928·마스터 확정] 🔴 도면 등록 = 파일을 올리는 것, 그게 전부 ──
      //  버튼/단축키/드래그앤드롭/시트 등 모든 진입 경로가 이 함수로 수렴하므로 정책도 여기 한 곳에 둔다.
      //  옛 "구역 0개면 도면 로드 차단 + createDeck({askDrawing:false}) 로 구역부터 생성" 게이트를 제거한다 —
      //  그 게이트가 "도면 등록 = 구역 생성" 을 코드에서 한 덩어리로 묶고 있던 근본 원인이었다.
      //  구역이 0개여도 도면은 그냥 로드된다. 구역은 첫 영역 지정 시 생긴다(31_Projects.createDeckFromLoadedDrawing).
      if (typeof Projects !== "undefined" && Projects.currentProject) {
        const decks = Projects.decks || [];
        if (decks.length > 0 && !Projects.currentDeck) {
          if (decks.length === 1) { Projects.currentDeck = decks[0]; if (Projects._renderDecks) Projects._renderDecks(); }
          else {
            Prompt && Prompt.toast && Prompt.toast("도면을 등록할 ‘구역’을 먼저 선택하세요.");
            const db = document.getElementById("decks-block");
            if (db) { db.classList.add("zone-required-flash"); setTimeout(() => db.classList.remove("zone-required-flash"), 1800); }
            return;
          }
        }
      }
      const _isPdf = file.type === "application/pdf" || (file.name || "").toLowerCase().endsWith(".pdf");
      if (typeof Log !== "undefined") Log.push(_isPdf ? "pdf.register" : "drawing.upload", file.name, { type: file.type, size: file.size });
      this._releasePdfDocs();
      State.reset();
      State.fileName = file.name;
      UI.text("file-name-label", file.name);
      UI.$("pin-count-badge").classList.add("hidden");
      UI.$("pins-layer").innerHTML = "";
      UI.$("pin-list").innerHTML = "";
      UI.$("pin-empty").classList.remove("hidden");
      this._closePinForm();
      UI.$("section-next-point").classList.add("hidden");
      UI.$("section-export").classList.add("hidden");

      const isPDF = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");

      if (isPDF) {
        State.fileType = "pdf";
        UI.$("drop-hint").classList.add("hidden");
        UI.$("pdf-loading").classList.remove("hidden");
        UI.$("pdf-error").classList.add("hidden");
        UI.$("map-viewport").classList.add("hidden");

        try {
          const ab = await this._readAsArrayBuffer(file);
          State.fileData = ab;
          const pdf = await PDF.load(ab);
          State.pdfDoc  = pdf;
          State.pdfPages = pdf.numPages;
          State.pdfPage  = 1;
          UI.$("pdf-loading").classList.add("hidden");
          UI.$("pdf-canvas").classList.remove("hidden");
          UI.$("map-image").classList.add("hidden");
          await this._renderPdfPage();
          this._showMapViewport();
          this._afterDrawingLoaded();
        } catch (err) {
          UI.$("pdf-loading").classList.add("hidden");
          UI.$("pdf-error").classList.remove("hidden");
          const em = UI.$("pdf-error-msg"); if (em) em.textContent = "PDF 로드 실패: " + err.message;
        }
      } else {
        State.fileType = "image";
        // [WO 20260929-lossless] 원본 이미지 파일(Blob)을 그대로 쥔다 — 스냅샷은 이 바이트를 재압축 없이 싣는다.
        //   (State.fileData = "지금 도면의 원본 바이트". PDF 는 ArrayBuffer, 이미지는 Blob — fileType 으로 구분)
        State.fileData = file;
        State.imageUrl = URL.createObjectURL(file);
        UI.$("drop-hint").classList.add("hidden");
        UI.$("pdf-loading").classList.add("hidden");
        UI.$("pdf-error").classList.add("hidden");
        UI.$("pdf-canvas").classList.add("hidden");
        UI.$("pdf-pagination").classList.add("hidden");

        const imgEl = UI.$("map-image");
        imgEl.onload = () => { this._showMapViewport(); this._afterDrawingLoaded(); };
        imgEl.onerror = () => {
          UI.$("pdf-error").classList.remove("hidden");
          UI.$("pdf-error-msg").textContent = "이미지 로드 실패";
        };
        imgEl.src = State.imageUrl;
        imgEl.classList.remove("hidden");
      }
    },

    async _renderPdfPage() {
      const canvas = UI.$("pdf-canvas");
      // 핵심(캔버스 래스터화)은 반드시 성공해야 한다 → 여기서 실패하면 상위 catch 로 전달.
      await PDF.renderPage(State.pdfDoc, State.pdfPage, canvas, 1.5, State.pdfRotation);
      State.pan = { x: 0, y: 0 }; State.zoom = 1;
      // 부수 UI 갱신(페이지네이션·핀·썸네일)은 하나가 실패해도 PDF 표시는 유지되도록 개별 격리.
      try { MapCtrl.applyTransform(); } catch (e) { console.warn("applyTransform", e); }
      try { UI.updatePdfPagination(); } catch (e) { console.warn("pagination", e); }
      try { UI.renderPinsOnMap(); } catch (e) { console.warn("pinsOnMap", e); }
      try { UI.renderPinList(); } catch (e) { console.warn("pinList", e); }
      try { UI.renderPdfThumbs(); } catch (e) { console.warn("thumbs", e); }
    },

    _showMapViewport() {
      State.pan  = { x: 0, y: 0 };
      State.zoom = 1;
      MapCtrl.applyTransform();
      UI.$("map-viewport").classList.remove("hidden");
      const nav = UI.$("nav-toolbar"); if (nav) nav.classList.remove("hidden");
      // ezPDF 스타일 상단 도구 툴바 표시 + 마킹 버튼(설계자 전용)
      const tb = UI.$("pdf-toolbar");
      if (tb) tb.classList.remove("hidden");
      const tbMark = UI.$("tb-mark");
      if (tbMark) tbMark.classList.toggle("hidden", State.mode !== "designer");
      if (typeof PdfAnno !== "undefined") PdfAnno.updateToolbar();  // 주석 도구(설계자 전용) 표시
      UI.renderPinsOnMap();
      UI.renderPinList();      // 현재 페이지 핀 목록 갱신
      UI.updatePdfPagination();
      UI.updateRotationLabel();
      UI.renderPdfThumbs();
      // [P0-2 false-dirty 수정] 여기서 dirty 를 세우면 안 된다.
      //   _showMapViewport() 는 '화면 표시' 함수라 ①새 도면 업로드 ②기존 배포본 로드
      //   ③뷰어→편집모드 전환 ④페이지 이동 이 전부 통과한다. 뷰어 딥링크(?d=dep_…)로 열고
      //   편집모드로 전환하기만 해도(사용자 변경 0건) autoSaveDepId 가 비어 있어 '저장 *' 가 켜졌고,
      //   프로젝트·구역 컨텍스트가 없는 그 상태로 저장하면 어느 구역에도 안 붙는 고아 배포본이 생겼다.
      //   → 실제 변경(새 도면 업로드)은 _afterDrawingLoaded() 가, 핀/영역 편집은 _autoSave() 가
      //     각각 dirty 를 세운다. 표시 함수는 상태를 바꾸지 않는다.
      // 🔴 [WO 20260929-fitrace2] 리셋+표시 완료 — 이 뒤에야 뷰포트 크기가 실재한다(whenDisplayed 대기자 해제).
      this._settleDisplay(true);
      // [WO 20260929-lossless ⑤] 원본 없는 PDF 배포본이면 [원본 PDF 연결] — 로더가 autoSaveDepId 를 채운 뒤 판정
      setTimeout(() => { try { this._syncSourceLinkBar(); } catch (e) {} }, 0);
    },

    _readAsArrayBuffer(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload  = e => resolve(e.target.result);
        reader.onerror = () => reject(new Error("파일 읽기 실패"));
        reader.readAsArrayBuffer(file);
      });
    },

    /** 신규 사진 포인트 즉시 등록 — 업로드는 백그라운드(오프라인 시 큐잉) */
    async _confirmPinInstant({ label, url, note, file, docs }) {
      // 1) 즉시 로컬 미리보기 blob 생성 + 핀 객체 등록 (대기 없음)
      const localPreview = URL.createObjectURL(file);
      _trackVideoBlob && _trackVideoBlob(localPreview); // blob 누수 추적(공용 추적기 재사용)
      const imgName = UI.val("input-pin-imgname").trim() || file.name.replace(/\.[^.]+$/, "");
      const _now1 = Date.now();   // [WO 20260929-createdAt] 생성시각 명시 저장
      const pin = {
        id: _now1, createdAt: _now1,
        x: State.pending.x, y: State.pending.y,
        page: State.pdfPage, label,
        imageName: imgName,
        localPreview,            // 업로드 완료 전까지 즉시 미리보기에 사용
        pendingSync: true,       // 업로드 진행/대기 표시
        uploading: true
      };
      { const _auth1 = this._pinAuthor(); if (_auth1) pin.author = _auth1; } // [WO 20260917 멀티유저 ②]
      if (note) pin.note = note;
      if (url)  { pin.imageUrl = url; if (/\.(mp4|webm|mov)(\?|#|$)/i.test(url)) pin.isVideo = true; }
      // [마스터 요청] 핀(호스팟)별 아이콘 — 선택값을 핀에 보존(기본 number는 저장 생략)
      if (State.pendingIcon && State.pendingIcon !== "number") pin.icon = State.pendingIcon;
      // [마스터 요청] RICOH THETA 360(2:1 equirectangular) 감지 결과를 핀에 보존 → 뷰어가 360으로 표시
      if (State.pendingIs360) pin.is360 = true;
      if (typeof Cloud !== "undefined") { Cloud._cache = Cloud._cache || {}; Cloud._cache["local:" + pin.id] = localPreview; }

      State.pins.push(pin);
      if (typeof GPS !== "undefined" && GPS.attachToPin) GPS.attachToPin(pin); // [WO 20261001-gps] 자동 위치 기록(비동기·저장 안 막음)
      if (typeof Log !== "undefined") Log.push("pin.add", pin.id, { label: pin.label, page: pin.page, instant: true });
      State.activePin = pin.id;
      if (typeof Zones !== "undefined") Zones.refreshPinLinks();

      // 2) 폼 닫고 화면 즉시 반영 (사용자는 곧바로 다음 포인트 가능)
      State.editingPinId = null;
      this._resetPinForm(true);
      UI.renderPinList();
      UI.renderPinsOnMap(pin.id);
      if (typeof PinGrid !== "undefined") PinGrid.render();
      MapCtrl.flyTo(pin.x, pin.y, Math.max(State.zoom, 2.2), 450);
      this._updateSyncBadge();
      Prompt && Prompt.toast && Prompt.toast("'" + label + "' 등록 · " + (navigator.onLine ? "백그라운드 업로드 중" : "오프라인 임시저장"));
      UI.text && UI.text("pin-saved-msg", "'" + label + "' 등록됨 · 업로드는 백그라운드로 진행됩니다");
      UI.show && UI.show("section-next-point");

      // 3) 백그라운드 업로드 (await 하지 않음 → 화면 블로킹 없음)
      this._uploadPinImageBg(pin, file, imgName, docs);
      // [오프라인 작업지시서 ] 즉시등록(instant) 핀도 오프라인이면 OpLog 에 기록 →
      //   재연결 시 ops 엔드포인트로 멱등 replay (기존 instant 경로는 OpLog 누락이었음).
      if (!navigator.onLine && typeof OpLog !== "undefined" && OpLog.recordCurrent) {
        OpLog.recordCurrent("pin", "upsert", pin.id, pin)
          .then(() => { try { return persistLocalDeployment(); } catch (e) {} })
          .catch(() => {});
      }
      this._autoSave && this._autoSave();
    },

    /** 백그라운드 이미지/첨부 업로드 — 완료 시 imageId 치환 + 미리보기 캐시 이관 */
    async _uploadPinImageBg(pin, file, imgName, docs) {
      try {
        const { dataURL, width, height } = await Cloud.resizeImage(file);
        Cloud._cache[("op-preview:" + pin.id)] = dataURL;
        let uploaded = false;
        if (navigator.onLine) {
          try {
            const imageId = await Cloud.uploadImage(imgName, dataURL, width, height);
            pin.imageId = imageId;
            Cloud._cache[imageId] = dataURL;
            uploaded = true;
          } catch (e) { uploaded = false; }
        }
        if (!uploaded) {
          const opId = await SyncQueue.enqueue({ kind: "image", name: imgName, image_data: dataURL, width, height });
          if (opId) { pin.pendingOpId = opId; Cloud._cache["op:" + opId] = dataURL; } // null=저장실패(토스트 안내됨)
        }
        // 첨부 문서(있으면)도 백그라운드 처리
        if (docs && docs.length) {
          if (!Array.isArray(pin.attachments)) pin.attachments = [];
          for (let i = 0; i < docs.length; i++) {
            const d = docs[i];
            try {
              const durl = await Cloud.fileToDataURL(d.file);
              let docOk = false, docId = null;
              if (navigator.onLine) { try { docId = await Cloud.uploadDoc(d.name, durl); docOk = true; } catch (e) {} }
              const att = { id: d.tempId, name: d.name, size: d.size, type: d.kind && d.kind.type };
              if (docOk) att.docId = docId;
              else { const opId = await SyncQueue.enqueue({ kind: "doc", name: d.name, image_data: durl }); if (opId) { att.pendingOpId = opId; att.pendingSync = true; Cloud._cache["op:" + opId] = durl; } }
              pin.attachments.push(att);
            } catch (e) {}
          }
        }
        // 업로드 완료 상태 정리
        pin.uploading = false;
        if (!pin.pendingOpId && !(pin.attachments || []).some(a => a.pendingOpId)) delete pin.pendingSync;
        // 로컬 미리보기 정리(서버 이미지로 대체됨) — 죽은 blob URL 이 서버에 남지 않도록 제거
        if (pin.imageId && pin.localPreview) { try { URL.revokeObjectURL(pin.localPreview); } catch (e) {} delete pin.localPreview; }
        // [핵심 버그 수정] 업로드 완료 후 imageId(또는 pendingOpId)를 서버에 반드시 영속화.
        //   이전: _confirmPinInstant 에서 blob localPreview 만 저장되고, 업로드 성공 후 재저장이
        //         없어 서버에는 죽은 blob URL 만 남았다 → 재접속 시 "이미지를 불러올 수 없습니다".
        //   이제: 업로드 결과(imageId)를 담아 다시 _autoSave 로 서버에 반영한다.
        if (pin.imageId || pin.pendingOpId) {
          try { this._autoSave && this._autoSave(); } catch (e) {}
        }
      } catch (e) {
        pin.uploading = false;
        Prompt && Prompt.toast && Prompt.toast("'" + pin.label + "' 업로드 지연 — 동기화 대기에 보관됨");
      }
      try { UI.renderPinList(); UI.renderPinsOnMap(); if (typeof PinGrid !== "undefined") PinGrid.render(); } catch (e) {}
      this._updateSyncBadge && this._updateSyncBadge();
      this._autoSave && this._autoSave();
    },

    /* ── Pin: 저장 & 업로드 ── */
    async _confirmPin() {
      if (!State.pending) return;
      const label = UI.val("input-pin-label").trim() || `위치 ${State.pins.length + 1}`;
      const url   = UI.val("input-pin-url").trim();
      const note  = UI.val("input-pin-note").trim();
      const file  = State.pendingFile;
      const docs  = State.pendingDocs.slice();

      // ── 편집 모드 판정 ──
      const editing = !!State.editingPinId;
      // ════════════════════════════════════════════════════════════
      // 요청사항: 신규 포인트 + 사진(이미지) 선택 시 → 업로드를 기다리지 않고
      // 즉시 핀을 화면에 등록(로컬 미리보기)하고, 업로드는 백그라운드에서 진행.
      // 오프라인이면 SyncQueue 에 적재되어 인터넷 복구 시 자동 업로드된다.
      // (영상/3D/문서/URL 만 있는 경우엔 기존 동기 경로 사용 — 즉시등록 대상 아님)
      // ════════════════════════════════════════════════════════════
      if (!editing && file && !State.pendingIsVideo) {
        return this._confirmPinInstant({ label, url, note, file, docs });
      }
      const existing = editing ? State.pins.find(p => p.id === State.editingPinId) : null;
      // 신규: 미디어·노트·첨부 중 최소 하나 필요. 편집: 라벨/노트만 바꿔도 저장 허용.
      if (!editing && !file && !url && !note && docs.length === 0) return;

      const btn    = UI.$("btn-confirm-pin");
      const status = UI.$("pin-upload-status");
      const setBtnLabel = (t) => { const l = UI.$("pf-save-label"); if (l) l.textContent = t; else btn.textContent = t; };
      btn.disabled = true;
      setBtnLabel((file || docs.length) ? (navigator.onLine ? "업로드 중..." : "임시 저장 중...") : "저장 중...");

      // 편집이면 기존 객체를 베이스로(기존 미디어 보존), 신규면 새 객체
      const pin = editing && existing
        ? existing // [WO 20260917 멀티유저 ②] 편집은 기존 pin.author 를 건드리지 않는다(편집자≠원작성자)
        : (() => { const _auth2 = this._pinAuthor(); const _now2 = Date.now(); const np = { id: _now2, createdAt: _now2, x: State.pending.x, y: State.pending.y, page: State.pdfPage, label }; if (_auth2) np.author = _auth2; return np; })();
      pin.label = label;
      if (note) pin.note = note; else if (editing) delete pin.note;
      // [마스터 요청] 핀(호스팟)별 아이콘 캡처 — number(기본)면 속성 제거(하위호환)
      if (State.pendingIcon && State.pendingIcon !== "number") pin.icon = State.pendingIcon;
      else delete pin.icon;

      try {
        if (file && State.pendingIsVideo) {
          // 360° 영상: 테이블 용량 제한으로 클라우드 저장 불가 → 로컬 blob URL (현재 세션 미리보기)
          status.textContent = "360° 영상 연결 중...";
          status.classList.remove("hidden", "error");
          const vidName = UI.val("input-pin-imgname").trim() || file.name.replace(/\.[^.]+$/, "");
          pin.videoUrl  = URL.createObjectURL(file);
          _trackVideoBlob(pin.videoUrl); // [B5] 누수 추적
          pin.isVideo   = true;
          pin.imageName = vidName;
          pin.localOnly = true; // 배포/새로고침 시 사라짐 안내용
        } else if (file) {
          // 이미지: 1) 리사이즈 → 2) 온라인이면 즉시 업로드 / 오프라인·실패면 로컬 큐잉
          status.textContent = "이미지 최적화 중...";
          status.classList.remove("hidden", "error");
          const { dataURL, width, height } = await Cloud.resizeImage(file);
          const imgName = UI.val("input-pin-imgname").trim() || file.name.replace(/\.[^.]+$/, "");
          pin.imageName = imgName;

          let uploaded = false;
          if (navigator.onLine) {
            try {
              status.textContent = "클라우드 업로드 중... (" + (dataURL.length / 1024 / 1024).toFixed(1) + " MB)";
              const imageId = await Cloud.uploadImage(imgName, dataURL, width, height);
              pin.imageId = imageId;
              Cloud._cache[imageId] = dataURL; // 즉시 미리보기용 캐시
              uploaded = true;
            } catch (e) { uploaded = false; } // 네트워크 단절 등 → 큐로 폴백
          }
          if (!uploaded) {
            // 오프라인/실패: 로컬에 즉시 저장하고 인터넷 복구 시 일괄 업로드
            status.textContent = "오프라인 — 휴대폰에 임시 저장 (인터넷 복구 시 자동 업로드)";
            const opId = await SyncQueue.enqueue({
              kind: "image", name: imgName, image_data: dataURL, width, height
            });
            if (opId) {                   // null=저장실패(공간부족, 토스트 안내됨)
              pin.pendingOpId = opId;     // 동기화 완료 시 imageId 로 치환
              pin.pendingSync = true;     // 미동기화 표시
              Cloud._cache["op:" + opId] = dataURL; // 미동기화 미리보기 캐시
            } else { status.textContent = "저장공간 부족 — 사진을 임시저장하지 못했습니다"; }
          }
        } else if (url) {
          // URL 직접 입력 (이미지 또는 영상 자동 판별)
          pin.imageUrl = url;
          if (/\.(mp4|webm|mov)(\?|#|$)/i.test(url)) pin.isVideo = true;
        }

        // ── 첨부 문서 업로드 (PDF/Word 등) — 오프라인 우선 ──
        if (docs.length) {
          if (!Array.isArray(pin.attachments)) pin.attachments = [];
          for (let i = 0; i < docs.length; i++) {
            const d = docs[i];
            const dataURL = await Cloud.fileToDataURL(d.file);
            let docOk = false, docId = null;
            if (navigator.onLine) {
              try {
                status.textContent = `첨부 업로드 중... (${i + 1}/${docs.length}) ${d.name}`;
                status.classList.remove("hidden", "error");
                docId = await Cloud.uploadDoc(d.name, dataURL);
                docOk = true;
              } catch (e) { docOk = false; }
            }
            const att = { id: d.tempId, name: d.name, size: d.size, type: d.kind.type };
            if (docOk) { att.docId = docId; }
            else {
              // 오프라인 큐잉
              const opId = await SyncQueue.enqueue({ kind: "doc", name: d.name, image_data: dataURL });
              if (opId) {                 // null=저장실패(공간부족, 토스트 안내됨)
                att.pendingOpId = opId; att.pendingSync = true;
                Cloud._cache["op:" + opId] = dataURL;
                pin.pendingSync = true;
              }
            }
            pin.attachments.push(att);
          }
        }

        // ── 3D 포인트 클라우드(FLS/E57/LAS/PLY) 연결 ──
        // 현 세션에선 로컬 캐시(Cloud._cache['fls:'+id])로 즉시 표출.
        // 용량이 큰 3D 원본은 D1에 통째로 넣지 않고 메타만 보관(배포 후 URL 연결 권장).
        if (State.pendingFls) {
          pin.flsLocalId = State.pendingFls.localId;
          pin.flsName    = State.pendingFls.name;
          pin.flsSize    = State.pendingFls.size;
          pin.has3D      = true;
        }
      } catch (e) {
        status.textContent = "업로드 실패: " + e.message;
        status.classList.add("error");
        status.classList.remove("hidden");
        btn.disabled = false;
        setBtnLabel("저장하기");
        return;
      }

      if (!editing) State.pins.push(pin);   // 편집 시 기존 객체를 그대로 갱신했으므로 push 안 함
      if (!editing && typeof GPS !== "undefined" && GPS.attachToPin) GPS.attachToPin(pin); // [WO 20261001-gps] 자동 위치 기록(신규만·비동기·저장 안 막음)
      if (typeof Log !== "undefined") Log.push(editing ? "pin.edit" : "pin.add", pin.id, { label: pin.label, page: pin.page });
      State.activePin = pin.id;
      if (typeof Zones !== "undefined") Zones.refreshPinLinks(); // 영역-핀 연결 갱신
      const wasEditing = editing;
      State.editingPinId = null;
      this._resetPinForm(true);
      setBtnLabel("저장하기");
      this._updateSyncBadge();

      UI.renderPinList();
      UI.renderPinsOnMap(wasEditing ? null : pin.id); // 신규만 드롭 애니메이션
      MapCtrl.flyTo(pin.x, pin.y, Math.max(State.zoom, 2.2), 500);
      // [오프라인 작업지시서 ] 오프라인이면 엔티티 op 기록 + 로컬 스냅샷(온라인은 _autoSave 경로 유지)
      if (!navigator.onLine && typeof OpLog !== "undefined") {
        try { await OpLog.recordCurrent("pin", "upsert", pin.id, pin); await persistLocalDeployment(); } catch (e) {}
      }
      this._autoSave(); // 버튼 없이 즉시 서버 저장

      // 편집 완료면 별도 안내만, 신규면 다음 포인트 연속 배치 안내
      if (wasEditing) {
        State.pinEditUnlocked = null; // 수정 완료 → 다시 잠금
        Prompt.toast("'" + label + "' 수정 완료 · 자동저장");
        return;
      }
      let savedNote = (pin.pendingSync ? "'" : "'") + label + (pin.pendingSync ? "' 임시 저장 (오프라인)" : "' 저장 완료");
      const tags = [];
      if (pin.imageId)        tags.push("360° 그림");
      else if (pin.pendingOpId) tags.push("360° 그림(대기)");
      else if (pin.isVideo && pin.videoUrl) tags.push("영상(로컬)");
      else if (pin.isVideo)   tags.push("360° 영상");
      else if (pin.imageUrl)  tags.push("URL");
      if (pin.note)           tags.push("노트");
      if (pin.has3D)          tags.push("3D 클라우드");
      if (pin.attachments && pin.attachments.length) tags.push("첨부 " + pin.attachments.length);
      if (tags.length) savedNote += " (" + tags.join(" · ") + ")";
      UI.text("pin-saved-msg", savedNote);
      UI.show("section-next-point");
    },

    /** 🔴 [WO 20261001-offline · p102 A2] op id → 서버 id 치환을 **로컬에 보관된 draft 전부**에도 적용한다.
     *  근본원인: 치환이 화면(State.pins)에만 됐다 — ① 열려 있지 않은 도면(새로고침 후 허브 등)의 draft 는
     *  pendingOpId 그대로 남고, 큐는 업로드 성공으로 비워져 매핑이 영영 사라졌다(사진 고아).
     *  ② 열린 도면도 바로 뒤 _flushDirtyDrafts 가 치환 전 draft 를 올려 서버 핀에 imageId 가 빠졌다.
     *  바뀐 draft 는 dirty=true — 서버에 아직 죽은 pendingOpId 만 있을 수 있으므로 다음 업로드 대상이다. */
    async _applySyncMapToDrafts(map) {
      if (!map || !Object.keys(map).length || typeof SyncQueue === "undefined" || !SyncQueue.allDraftKeys) return 0;
      let n = 0, keys = [];
      try { keys = (await SyncQueue.allDraftKeys()) || []; } catch (e) { return 0; }
      for (const k of keys) {
        let d = null;
        try { d = await SyncQueue.loadDraft(k); } catch (e) { continue; }
        if (!d || !Array.isArray(d.pins)) continue;
        let changed = false;
        d.pins.forEach((pin) => {
          if (!pin) return;
          if (pin.pendingOpId && map[pin.pendingOpId]) { pin.imageId = map[pin.pendingOpId]; delete pin.pendingOpId; changed = true; }
          (pin.attachments || []).forEach((att) => {
            if (att && att.pendingOpId && map[att.pendingOpId]) { att.docId = map[att.pendingOpId]; delete att.pendingOpId; delete att.pendingSync; changed = true; }
          });
          if (pin.pendingSync && !pin.pendingOpId && !(pin.attachments || []).some((a) => a && a.pendingOpId)) { delete pin.pendingSync; changed = true; }
        });
        if (!changed) continue;
        d.dirty = true;
        try { await SyncQueue.saveDraft(k, d); n++; } catch (e) {}
      }
      return n;
    },

    /** 동기화 완료 콜백 — 큐 op id → 서버 imageId/docId 로 치환 후 화면 갱신.
     *  보관 draft 치환(_applySyncMapToDrafts)까지 끝나야 resolve — 호출부는 draft 업로드 **전에** await 한다. */
    async _onSyncDone(result) {
      const map = (result && result.map) || {};
      let changed = false;
      State.pins.forEach(pin => {
        if (pin.pendingOpId && map[pin.pendingOpId]) {
          pin.imageId = map[pin.pendingOpId];
          // 미리보기 캐시 키 이관
          const cached = Cloud._cache["op:" + pin.pendingOpId];
          if (cached) Cloud._cache[pin.imageId] = cached;
          delete pin.pendingOpId; changed = true;
        }
        if (pin.attachments) {
          pin.attachments.forEach(att => {
            if (att.pendingOpId && map[att.pendingOpId]) {
              att.docId = map[att.pendingOpId];
              const c = Cloud._cache["op:" + att.pendingOpId];
              if (c) Cloud._cache[att.docId] = c;
              delete att.pendingOpId; delete att.pendingSync; changed = true;
            }
          });
        }
        // 모든 대기 항목이 해소되면 pendingSync 해제
        if (pin.pendingSync && !pin.pendingOpId &&
            !(pin.attachments || []).some(a => a.pendingOpId)) {
          delete pin.pendingSync; changed = true;
        }
      });
      // 보관 draft 치환을 화면 draft 재보관(_autoSave)보다 **먼저** — 늦게 끝난 쪽이 최신 화면 상태를 덮지 않게
      try { await this._applySyncMapToDrafts(map); } catch (e) {}
      if (changed) {
        try { UI.renderPinList(); UI.renderPinsOnMap(); } catch (e) {}
        // [버그수정] imageId/docId 스왑을 서버·로컬에 영속화 — 안 하면 탭 닫을 때 서버엔 죽은 pendingOpId만 남아 사진 영구손실
        try { this._autoSave && this._autoSave(); } catch (e) {}
      }
      this._updateSyncBadge();
    },

    /** 동기화 상태 배지 갱신 */
    _updateSyncBadge() {
      const badge = UI.$("sync-badge");
      if (!badge) return;
      // [오프라인 노트] 이미지/문서 큐(SyncQueue) + 핀/구역/주석/노트 OpLog 대기분을 합산(SoT — 별도 배지 금지)
      const opLogCount = (async () => {
        try {
          const depId = (typeof Offline !== "undefined" && Offline.curDepId) ? Offline.curDepId() : null;
          if (depId && typeof OpLog !== "undefined") return (await OpLog.pending(depId)).length;
        } catch (e) {}
        return 0;
      })();
      // [마스터 요청 2026-09-18] 오프라인일 때 "오프라인 모드"(번들 다운로드됨) vs
      //   "작업 불가"(번들 없음)를 구분 — 같은 배지(SoT), 새 배지 신설 금지.
      const bundleCheck = (async () => {
        try {
          if (navigator.onLine) return true; // 온라인이면 판정 불필요(분기에서 안 쓰임)
          const pid = (typeof Projects !== "undefined" && Projects.currentProject && Projects.currentProject.id) || null;
          if (!pid) return false;
          if (typeof Offline !== "undefined" && Offline.Bundle && Offline.Bundle.hasManifest) return await Offline.Bundle.hasManifest(pid);
        } catch (e) {}
        return false;
      })();
      Promise.all([SyncQueue.count(), opLogCount, bundleCheck]).then(([sqN, opN, hasBundle]) => {
        const n = sqN + opN;
        const dot = UI.$("sync-dot"), txt = UI.$("sync-text");
        const online = navigator.onLine;
        if (!online && n === 0) {
          badge.classList.remove("hidden", "online", "pending");
          badge.classList.add("offline");
          // 번들(프로젝트 다운로드분)이 로컬에 있으면 "오프라인 모드"로 열람/작업 가능,
          // 없으면 표시할 데이터가 없어 작업 불가 — 서로 다른 상태이므로 문구를 분리한다.
          if (txt) txt.textContent = hasBundle ? "오프라인 모드" : "오프라인 — 작업 불가(다운로드 필요)";
          badge.classList.toggle("offline-blocked", !hasBundle);
        } else if (n > 0) {
          badge.classList.remove("hidden", "online", "offline");
          badge.classList.add("pending");
          // [마스터: 수동 반영] 온라인+대기 → "지금 올리기" 버튼임을 명확히(클릭 시 syncNow)
          if (txt) txt.textContent = (online ? "↑ 지금 올리기 " : "오프라인 저장 ") + n;
        } else {
          // 온라인 + 대기 0 → 잠시 표시 후 숨김
          badge.classList.remove("offline", "pending");
          badge.classList.add("online");
          if (txt) txt.textContent = "동기화됨";
          // 디자이너 모드에서만 굳이 항상 표시할 필요는 없으나, 일관성 위해 유지
        }
        // [WO 20260918] 🔴 "업로드 버튼이 안 보인다" — 위 #sync-badge(topbar)는 대기=0(온라인)일
        // 때 hidden 클래스가 그대로 남아 화면에서 완전히 사라진다(데스크톱 기존 동작 — 이번
        // 요구는 데스크톱 불변이 조건이라 그대로 둔다). 모바일은 하단 독(.mobile-dock)의
        // #mdock-upload 칩을 항상 보이게 하고, 대기 건수로만 활성/비활성을 가른다.
        const mUp = UI.$("mdock-upload");
        if (mUp) {
          mUp.disabled = (n === 0);
          const label = UI.$("mdock-upload-label");
          if (label) label.textContent = n > 0 ? ("업로드 " + n) : "업로드";
          mUp.setAttribute("title", n > 0 ? ("대기 " + n + "건 — 눌러서 지금 업로드") : "업로드할 내용이 없습니다");
        }
      });
    },

    /** [마스터: 수동 반영] 지금 즉시 "전체" 동기화 — op 큐(SyncQueue.flush) + 도면 draft
     *  (_flushDirtyDrafts) + OpLog(_flushOpLogs)까지 한 번에 서버 반영. 사용자가 직접 누름. */
    async syncNow() {
      if (this._syncingNow) return;
      if (!navigator.onLine) {
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("오프라인입니다 — 인터넷 연결 후 다시 눌러주세요. (작업은 안전하게 보관 중)");
        return;
      }
      this._syncingNow = true;
      const badge = UI.$("sync-badge"), txt = UI.$("sync-text");
      if (badge) badge.classList.add("syncing");
      if (txt) txt.textContent = "올리는 중…";
      // [WO 20260918] 모바일 독 업로드 칩도 같은 진행 상태를 보여준다(SoT — 새 표시 로직 추가 금지).
      const mUp = UI.$("mdock-upload"), mUpLabel = UI.$("mdock-upload-label");
      if (mUp) mUp.disabled = true;
      if (mUpLabel) mUpLabel.textContent = "올리는 중…";
      // [토스트 스팸 제거] sync-badge 가 이미 "올리는 중…" 을 표시한다. 완료/실패 토스트는 아래 유지.
      let uploaded = 0;
      try {
        const r = await SyncQueue.flush();
        if (r && r.map) await this._onSyncDone(r);   // [p102 A2] draft 치환 완료 후 draft 업로드
        if (r && typeof r.uploaded === "number") uploaded += r.uploaded;
        if (this._flushDirtyDrafts) { try { await this._flushDirtyDrafts(); } catch (e) {} }
        if (this._flushOpLogs) { try { await this._flushOpLogs(); } catch (e) {} }
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("업로드 완료 — 대기 작업 " + uploaded + "건 서버 반영");
      } catch (e) {
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("업로드 일부 실패 — 잠시 후 다시 시도하세요. (작업은 보관됨)");
      } finally {
        this._syncingNow = false;
        if (badge) badge.classList.remove("syncing");
        this._updateSyncBadge(); // mdock-upload 의 disabled/라벨도 여기서 최신 대기건수로 재계산됨
      }
    },

    /* ── [마스터: 구면 안 마커] 360 사진 속 결함/장비 지점 핀 ── */
    setSpotAddMode(on) {
      this._spotAdd = (on == null) ? !this._spotAdd : !!on;
      // [WO 20261001-panoshapes] 점 추가 모드와 도형 그리기 모드는 상호배타(동시에 캔버스 제스처를 가로채지 않게)
      if (this._spotAdd && typeof PanoViewer !== "undefined" && PanoViewer.setShapeDrawMode) {
        PanoViewer.setShapeDrawMode(null);
        if (this._shapeBtns) Object.keys(this._shapeBtns).forEach((t) => this._shapeBtns[t] && this._shapeBtns[t].classList.remove("on"));
      }
      if (typeof PanoViewer !== "undefined" && PanoViewer.setSpotAddMode) PanoViewer.setSpotAddMode(this._spotAdd);
      const btn = UI.$("btn-pano-spot"); if (btn) btn.classList.toggle("on", this._spotAdd);
      const bar = UI.$("pano-spot-kinds");
      if (!this._spotAdd) {   // 끌 때 칩바·선택 표시 정리
        if (bar) bar.classList.add("hidden");
        document.querySelectorAll("#pano-spot-kinds .psk-chip").forEach((x) => x.classList.remove("on"));
      } else if (bar) bar.classList.add("hidden");   // 켜지면 칩바 닫고 추가 대기
      if (this._spotAdd && typeof Prompt !== "undefined" && Prompt.toast) {
        const kn = { defect: "결함", equip: "장비", safety: "안전", note: "메모" }[this._spotKind || "defect"] || "마커";
        Prompt.toast("" + kn + " 마커 — 360 안에서 지점을 탭하세요");
      }
      return this._spotAdd;
    },
    _onPanoTap(x, y) {
      const pin = (typeof PanoViewer !== "undefined") ? PanoViewer._currentPin : null;
      if (!pin || !PanoViewer.open) return;
      if (PanoViewer._shapeDraw) return; // [WO panoshapes] 도형 그리기 모드 중 단순 탭은 무시(드래그만 유효)
      if (this._spotAdd) {
        const ll = PanoViewer.screenToLonLat(x, y); if (!ll) return;
        this._addSpotAt(pin, ll.lon, ll.lat);
      } else {
        const id = PanoViewer.hitSpotAt(x, y);
        if (id) this._openSpot(pin, id);
      }
    },
    async _addSpotAt(pin, lon, lat) {
      if (!Array.isArray(pin.spots)) pin.spots = [];
      const kind = this._spotKind || "defect";
      const kn = { defect: "결함", equip: "장비", safety: "안전", note: "메모" }[kind] || "마커";
      let label = "", note = "";
      if (typeof Prompt !== "undefined" && Prompt.ask) {
        // [FARO Markers] 종류별 마커 + 이름/상세 노트
        const r = await Prompt.ask({
          title: kn + " 마커 추가",
          sub: "이 지점의 이름과 상세 노트를 입력하세요",
          placeholder: "이름 (예: 3번 밸브 · 용접부 균열)",
          second: "상세 노트 (선택)"
        });
        if (r == null) return;   // 취소
        label = String((r && r.value) || "").trim();
        note  = String((r && r.second) || "").trim();
      }
      const spot = { id: "sp-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), lon, lat, label, note, kind: kind, ts: Date.now() };
      pin.spots.push(spot);
      PanoViewer.renderSpots(pin.spots);
      this._saveSpots(pin);
      if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("노트 추가 — " + (label || "무제"));
    },
    async _openSpot(pin, id) {
      const s = (pin.spots || []).find((x) => x.id === id); if (!s) return;
      if (typeof Prompt === "undefined" || !Prompt.ask) return;
      // [마스터] 클릭 시 노트 보기/편집 — 이름·노트 모두 비우고 확인하면 삭제
      const r = await Prompt.ask({
        title: "360° 노트",
        sub: "내용을 수정하세요 · 이름과 노트를 모두 비우고 확인하면 삭제됩니다",
        placeholder: "이름",
        value: s.label || "",
        second: "상세 노트",
        secondValue: s.note || "",
        allowEmpty: true
      });
      if (r == null) return;
      const label = String((r.value) || "").trim();
      const note  = String((r.second) || "").trim();
      if (!label && !note) {
        pin.spots = (pin.spots || []).filter((x) => x.id !== id);
        PanoViewer.renderSpots(pin.spots);
        this._saveSpots(pin);
        if (Prompt.toast) Prompt.toast("노트 삭제됨");
        return;
      }
      s.label = label; s.note = note;
      PanoViewer.renderSpots(pin.spots);
      this._saveSpots(pin);
      if (Prompt.toast) Prompt.toast("노트 저장됨");
    },
    _saveSpots(pin) {
      try { if (!navigator.onLine && typeof OpLog !== "undefined" && OpLog.recordCurrent) OpLog.recordCurrent("pin", "upsert", pin.id, pin); } catch (e) {}
      try { this._autoSave && this._autoSave(); } catch (e) {}
      const p = UI.$("pano-spot-list"); if (p && !p.classList.contains("hidden")) this.renderSpotList();
    },
    /** [마스터: 마커 드래그] 놓았을 때 1회 호출 — moveSpot()이 이미 갱신한 lon/lat을 저장 확정 */
    _finalizeSpotDrag(id) {
      const pin = (typeof PanoViewer !== "undefined") ? PanoViewer._currentPin : null;
      if (!pin) return;
      this._saveSpots(pin);
      if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("마커 위치 저장됨");
    },

    /* ── [WO 20261001-panoshapes] 360 사진 안 도형(사각형·원) + 리더선 + 라벨 + 첨부 ── */
    /** 그리기 종료(onPointerUp의 shapeDraft) → 너무 작으면 취소, 아니면 이름(필수)·노트·장비표기 폼. */
    async _finishShapeDraft(draft) {
      const pin = (typeof PanoViewer !== "undefined") ? PanoViewer._currentPin : null;
      if (!pin || !draft) return;
      const tooSmall = draft.type === "circle"
        ? (draft.radiusDeg || 0) < 0.6
        : (Math.abs((draft.lon2 || 0) - (draft.lon1 || 0)) < 0.6 && Math.abs((draft.lat2 || 0) - (draft.lat1 || 0)) < 0.6);
      if (tooSmall) { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("너무 작습니다 — 더 크게 드래그하세요"); return; }
      const kind = this._spotKind || "defect";
      const kn = { defect: "결함", equip: "장비", safety: "안전", note: "메모" }[kind] || "마커";
      if (typeof Prompt === "undefined" || !Prompt.ask) return;
      const r = await Prompt.ask({
        title: (draft.type === "rect" ? "사각형" : "원") + " 도형 추가",
        sub: "이름(필수)과 노트를 입력하세요 · 종류: " + kn,
        placeholder: "이름 (예: FW PUMP NO.1)",
        second: "상세 노트 (선택)",
        checkbox: "장비 설치 위치로 표기"
      });
      if (r == null) return; // 취소 — draft 버림(저장하지 않음)
      const label = String((r.value) || "").trim();
      if (!PanoViewer.Shapes.validate({ label })) { if (Prompt.toast) Prompt.toast("이름을 입력해야 합니다"); return; }
      const shape = Object.assign({
        id: "sh-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        kind, label, note: String((r.second) || "").trim(), equipMark: !!r.checked,
        ts: Date.now(), attachments: []
      }, draft);
      if (!Array.isArray(pin.spots)) pin.spots = [];
      pin.spots.push(shape);
      PanoViewer.renderSpots(pin.spots);
      this._saveSpots(pin);
      if (Prompt.toast) Prompt.toast((draft.type === "rect" ? "사각형" : "원") + " 추가됨 — " + label);
    },
    /** 도형 라벨 탭 → 디자이너: 수정/삭제 폼(이름을 비우면 삭제) · 열람자: 읽기전용 보기. */
    async _openShape(id) {
      const pin = (typeof PanoViewer !== "undefined") ? PanoViewer._currentPin : null;
      if (!pin) return;
      const s = (pin.spots || []).find((x) => x.id === id); if (!s) return;
      if (!PanoViewer.canEditSpots()) { this._viewShapeReadOnly(s); return; }
      if (typeof Prompt === "undefined" || !Prompt.ask) return;
      const r = await Prompt.ask({
        title: (s.type === "rect" ? "사각형" : "원") + " 도형",
        sub: "내용을 수정하세요 · 이름을 비우고 확인하면 삭제됩니다",
        placeholder: "이름", value: s.label || "",
        second: "상세 노트", secondValue: s.note || "",
        checkbox: "장비 설치 위치로 표기", checkboxValue: !!s.equipMark,
        allowEmpty: true
      });
      if (r == null) return;
      const label = String((r.value) || "").trim();
      if (!label) {
        pin.spots = (pin.spots || []).filter((x) => x.id !== id);
        PanoViewer.renderSpots(pin.spots); this._saveSpots(pin);
        if (Prompt.toast) Prompt.toast("도형 삭제됨");
        return;
      }
      s.label = label; s.note = String((r.second) || "").trim(); s.equipMark = !!r.checked;
      PanoViewer.renderSpots(pin.spots); this._saveSpots(pin);
      if (Prompt.toast) Prompt.toast("도형 저장됨");
    },
    /** 열람자용 읽기전용 — 이름·노트·첨부만 토스트/안내로 보여주고 첨부는 라이트박스로 연다(요청은 열람자 요청 경로). */
    _viewShapeReadOnly(s) {
      if (typeof Prompt !== "undefined" && Prompt.toast) {
        Prompt.toast((s.label || "무제") + (s.note ? " — " + s.note : ""), 3200);
      }
    },
    /** [첨부] 사진/도면 올리기 — 기존 /api/r2/upload(=_uploadToR2) + Auth.r2 토큰 규칙 재사용. 디자이너만. */
    _pickAttachment(id) {
      const pin = (typeof PanoViewer !== "undefined") ? PanoViewer._currentPin : null;
      if (!pin || !PanoViewer.canEditSpots()) return;
      const s = (pin.spots || []).find((x) => x.id === id); if (!s) return;
      let inp = document.getElementById("pano-shape-attach-input");
      if (!inp) {
        inp = document.createElement("input");
        inp.type = "file"; inp.id = "pano-shape-attach-input";
        inp.accept = "image/png,image/jpeg,image/webp,application/pdf";
        inp.style.display = "none";
        document.body.appendChild(inp);
      }
      inp.value = "";
      inp.onchange = async () => {
        const file = inp.files && inp.files[0]; if (!file) return;
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("올리는 중…");
        const ab = await file.arrayBuffer();
        const ct = file.type || "application/octet-stream";
        const url = await this._uploadAttachment(ab, ct);
        if (!url) { if (Prompt.toast) Prompt.toast("첨부 업로드 실패 — 다시 시도하세요"); return; }
        if (!Array.isArray(s.attachments)) s.attachments = [];
        s.attachments.push({ id: "at-" + Date.now().toString(36), url, name: file.name || "", kind: /pdf/i.test(ct) ? "pdf" : "image" });
        PanoViewer.renderSpots(pin.spots);
        this._saveSpots(pin);
        if (Prompt.toast) Prompt.toast("첨부 추가됨 — " + (file.name || ""));
      };
      inp.click();
    },
    /** 첨부 탭 → 라이트박스(사진=확대 img, PDF=기존 pdf-popup-canvas 팝업 재사용). 보기 전용(열람자 포함 누구나 열람). */
    _openAttachment(att) {
      if (!att || !att.url) return;
      const src = (typeof Auth !== "undefined" && Auth.r2) ? Auth.r2(att.url) : att.url;
      if (att.kind === "pdf") {
        if (typeof PdfPopup !== "undefined" && PdfPopup.open) { PdfPopup.open(src); return; }
      }
      let box = document.getElementById("pano-shape-lightbox");
      if (!box) {
        box = document.createElement("div");
        box.id = "pano-shape-lightbox";
        box.className = "pano-shape-lightbox hidden";
        box.innerHTML = '<img id="pano-shape-lightbox-img" alt="">' +
          '<button id="pano-shape-lightbox-close" type="button" aria-label="닫기">×</button>';
        document.body.appendChild(box);
        box.addEventListener("click", (e) => { if (e.target === box || e.target.id === "pano-shape-lightbox-close") box.classList.add("hidden"); });
      }
      document.getElementById("pano-shape-lightbox-img").src = src;
      box.classList.remove("hidden");
    },
    /* ── [FARO Markers] 마커 위 마우스오버 → 내용 툴팁 ── */
    _panoHover(x, y) {
      if (typeof PanoViewer === "undefined" || !PanoViewer.open) return;
      if (PanoViewer.S && (PanoViewer.S.dragging || PanoViewer._dragSpotId)) { this._hideSpotTip(); return; }
      const pin = PanoViewer._currentPin;
      const id = (pin && PanoViewer.hitSpotAt) ? PanoViewer.hitSpotAt(x, y) : null;
      const canvas = UI.$("pano-canvas");
      const s = id ? (pin.spots || []).find((sp) => sp.id === id) : null;
      if (!s) { this._hideSpotTip(); if (canvas) canvas.style.cursor = ""; return; }
      if (canvas) canvas.style.cursor = "pointer";
      const tip = UI.$("pano-spot-tip"); if (!tip) return;
      const KN = { defect: "결함", equip: "장비", safety: "안전", note: "메모" };
      const COL = { defect: "#e0503e", equip: "#e0b14a", safety: "#f2820a", note: "#3a97dd" };
      const col = COL[s.kind] || "#e0503e";
      tip.innerHTML = '<div class="pst-kind"><span class="psk-dot" style="background:' + col + '"></span>' +
        UI.escapeHtml(s.label || (KN[s.kind] || "마커")) + '</div>' +
        (s.note ? '<div class="pst-note">' + UI.escapeHtml(s.note) + '</div>' : '');
      tip.style.left = "0px"; tip.style.top = "0px"; tip.classList.remove("hidden");
      const tw = tip.offsetWidth, th = tip.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
      let lx = x + 14, ty = y + 14;
      if (lx + tw > vw - 8) lx = x - tw - 14;
      if (ty + th > vh - 8) ty = y - th - 14;
      tip.style.left = lx + "px"; tip.style.top = ty + "px";
    },
    _hideSpotTip() { const t = UI.$("pano-spot-tip"); if (t) t.classList.add("hidden"); },
    /* ── [FARO Markers] 마커 리스트(테이블) — 행 클릭 시 그 마커로 시점 이동 ── */
    toggleSpotList() {
      const p = UI.$("pano-spot-list"); if (!p) return;
      if (p.classList.contains("hidden")) { this.renderSpotList(); p.classList.remove("hidden"); }
      else p.classList.add("hidden");
    },
    /** [P23: 마커목록 사진별] 현재 사진의 마커만 보여주되(①), 다른 사진의 마커도 그룹으로 함께
     *  나열해 클릭 시 그 사진으로 이동(②)하고, 사진별로 정렬(③)한다.
     *  그룹/이동 판단은 PanoViewer.buildSpotGroups/spotRowAction(순수 함수, 06_PanoViewer.js)에 위임하고
     *  이 함수는 렌더 + 배선만 담당(뷰어·디자이너 공통, 새 CSS 없이 기존 psl-* 재사용 + 인라인 스타일). */
    renderSpotList() {
      const body = UI.$("pano-spot-list-body"); if (!body) return;
      const pin = (typeof PanoViewer !== "undefined") ? PanoViewer._currentPin : null;
      if (!pin || typeof PanoViewer.buildSpotGroups !== "function") {
        body.innerHTML = '<div class="psl-empty">등록된 마커가 없습니다.<br>‘마커’ 버튼으로 360 안에 추가하세요.</div>';
        return;
      }
      const groups = PanoViewer.buildSpotGroups(State.pins || [], pin);
      if (!groups.length) {
        body.innerHTML = '<div class="psl-empty">등록된 마커가 없습니다.<br>‘마커’ 버튼으로 360 안에 추가하세요.</div>';
        return;
      }
      const KN = { defect: "결함", equip: "장비", safety: "안전", note: "메모" };
      const COL = { defect: "#e0503e", equip: "#e0b14a", safety: "#f2820a", note: "#3a97dd" };
      const HEAD_STYLE = "padding:8px 10px;font-size:11px;font-weight:700;color:#f0b941;background:rgba(255,255,255,.04);border-bottom:1px solid rgba(255,255,255,.1);";
      const EMPTY_STYLE = "padding:14px 10px;text-align:center;color:#9aa6b2;font-size:12px;";
      // [WO 20261001-panoshapes] 도형 타입 아이콘(●점/▭사각/◯원) + 첨부 수 + 장비 설치 위치만 필터
      const TYPE_ICON = { rect: "▭", circle: "◯" };
      const equipOnly = !!this._spotListEquipOnly;
      let rows = "";
      groups.forEach((g) => {
        const label = UI.escapeHtml((g.pin && (g.pin.label || g.pin.id)) || "-");
        const headText = (g.isCurrent ? "현재 사진 · " : "") + label;
        const visSpots = equipOnly ? g.spots.filter((s) => s.equipMark) : g.spots;
        rows += '<tr><td colspan="5" style="' + HEAD_STYLE + '">' + headText + '</td></tr>';
        if (!visSpots.length) {
          rows += '<tr><td colspan="5" style="' + EMPTY_STYLE + '">' + (g.spots.length ? "장비 설치 위치가 없습니다." : "등록된 마커가 없습니다.") + '</td></tr>';
          return;
        }
        visSpots.forEach((s, i) => {
          const col = COL[s.kind] || "#e0503e";
          const icon = TYPE_ICON[s.type] || (i + 1);
          const attCount = Array.isArray(s.attachments) ? s.attachments.length : 0;
          rows += '<tr class="psl-row" data-pin="' + g.pin.id + '" data-id="' + s.id + '">' +
            '<td><span class="psl-num" style="background:' + col + '">' + icon + '</span></td>' +
            '<td>' + (KN[s.kind] || "마커") + (s.equipMark ? ' <span class="psl-equip-tag" title="설치 위치">⚙</span>' : '') + '</td>' +
            '<td>' + UI.escapeHtml(s.label || "-") + '</td>' +
            '<td>' + UI.escapeHtml(s.note || "") + '</td>' +
            '<td>' + (attCount ? "📎" + attCount : "") + '</td></tr>';
        });
      });
      body.innerHTML = '<table class="psl-table"><thead><tr><th>#</th><th>종류</th><th>이름</th><th>노트</th><th>첨부</th></tr></thead><tbody>' + rows + '</tbody></table>';
      body.querySelectorAll(".psl-row").forEach((r) => {
        r.addEventListener("click", () => {
          const g = groups.find((gr) => gr.pin && gr.pin.id === r.dataset.pin);
          const s = g && g.spots.find((x) => x.id === r.dataset.id);
          if (!g || !s || !PanoViewer.spotRowAction) return;
          const a = PanoViewer.spotRowAction(g, s);
          if (!a) return;
          if (a.type === "look") { if (PanoViewer.lookAtSpot) PanoViewer.lookAtSpot(a.lon, a.lat); }
          else if (a.type === "openPano") { this.openPano(a.pin); }
        });
      });
    },

    setActivePin(id) {
      State.activePin = State.activePin === id ? null : id;
      UI.renderPinList();
      UI.renderPinsOnMap();
    },

    /** [WO 20260917-pin ISO 제거] 핀 선택 → 해당 구역(zone)만큼 "평면" 확대 포커스.
     *  구역이 없으면 핀 주변 영역으로 확대. 이후 사용자는 휠/버튼으로 자유 확대·축소.
     *  뷰어·디자이너 공통. 함수명(focusPinIso)은 호출부 호환을 위해 유지하지만
     *  ISO 자동 전환은 하지 않는다("화면이 한참 아래로 내려간다" 마스터 지시로 제거). */
    focusPinIso(pin) {
      if (!pin) return;
      State.activePin = pin.id;
      const page = pin.page || 1;
      const zones = (State.zones || []).filter(z => (z.page || 1) === page);
      // 1순위: 이 핀이 연결된 구역, 2순위: 핀 좌표를 포함하는 구역
      let zone = zones.find(z => (z.pinIds || []).includes(pin.id));
      if (!zone && typeof Zones !== "undefined" && Zones._contains)
        zone = zones.find(z => Zones._contains(z, pin.x, pin.y));
      let bbox;
      if (zone) {
        bbox = { x: zone.x, y: zone.y, w: zone.w, h: zone.h };
      } else {
        // 구역 미지정 핀 → 핀 주변 가상 영역(±16%)으로 확대
        const R = 16;
        const x = Math.max(0, pin.x - R), y = Math.max(0, pin.y - R);
        bbox = { x, y, w: Math.min(R * 2, 100 - x), h: Math.min(R * 2, 100 - y) };
      }
      UI.renderPinList();
      UI.renderPinsOnMap();
      // [WO 20260917-pin ISO 제거] 핀 탭은 항상 평면으로 확대한다(강제 ISO 전환 금지 — 마스터 지시).
      //   되돌리려면 아래 주석 해제(16_Zones.js:397 와 동일 패턴):
      //   MapCtrl.focusZoneIso(bbox); return;
      if (MapCtrl.fitZone) MapCtrl.fitZone(bbox);
      // [토스트 스팸 제거] 핀 탭마다(2-tap 1단계) 발화해 가장 많이 쌓이던 토스트.
      // 확대 애니메이션 자체가 결과를 보여준다.
    },

    /** 핀 탭 디스패처(뷰어·디자이너 공통, 2-tap):
     *  ① 첫 탭(미포커스) → 평면 확대(ISO 자동전환 없음 — 마스터 지시)
     *  ② 같은 핀 둘째 탭(포커스 상태) → 콘텐츠(360°/정보) 열기
     *  [WO 20260917-pin] "focused" 판정에서 State.isoView 조건을 제거 — 이전에는 ISO 가
     *  자동으로 켜져야만 focused 가 성립했으나, 이제 ISO 를 켜지 않으므로 activePin 일치만으로 판정. */
    onPinTap(pin) {
      if (!pin) return;
      const focused = State.activePin === pin.id;
      if (!focused) { this.focusPinIso(pin); return; }
      if (this.pinHasContent(pin)) this.openPano(pin);
      else if (State.mode === "designer" && typeof PinActionPop !== "undefined") PinActionPop.open(pin.id);
      // [WO 20261001-viewreq] 뷰어: 미디어 없는 포인트(CHECKER 등) = 볼 것이 없으니 그 포인트 요청·질문 창(안내 문구 포함)
      else if (typeof Requests !== "undefined" && Requests.openViewer) Requests.openViewer({ pin, noMedia: true });
      else this.openPano(pin); // 뷰어: 미디어 없으면 openPano 가 안내 표시
    },

    /** 핀 리스트 클릭 → 해당 페이지로 전환 + 플라이투 (+뷰어는 파노라마 오픈) */
    async focusPin(pin, openAfter) {
      State.activePin = pin.id;
      const targetPage = pin.page || 1;
      if (targetPage !== State.pdfPage) {
        State.pdfPage = targetPage;
        if (State.mode === "viewer" && State.viewerPages) {
          const imgEl = UI.$("map-image");
          // [버그수정 BUG5] onerror도 resolve — 이미지 로드 실패 시 Promise 미해결로 focusPin 영구 행 방지
          await new Promise(res => { imgEl.onload = res; imgEl.onerror = res; imgEl.src = Auth.r2(State.viewerPages[targetPage - 1]); });
          UI.updatePdfPagination();
          UI.renderPinsOnMap();
        } else if (State.pdfDoc) {
          await this._renderPdfPage();
        }
      }
      UI.renderPinList();
      UI.renderPinsOnMap();
      MapCtrl.flyTo(pin.x, pin.y, Math.max(State.zoom, 2.2));
      // flyTo 와 동시에 360° 로딩을 시작(병렬)해 체감 속도를 높인다. (지연 최소화)
      if (openAfter) setTimeout(() => this.openPano(pin), 250);
    },

    async deletePin(id) {
      const removed = State.pins.find(p => p.id === id);
      if (!removed) return false;
      if (!await Prompt.confirm("포인트 삭제", `'${removed.label}' 포인트를 삭제할까요?\n(첨부된 사진·노트·문서 정보도 함께 제거됩니다)`)) return false;
      this._removePins([id]);
      Prompt.toast("'" + removed.label + "' 삭제됨");
      return true;
    },

    /** [WO 20261001-bulkreauth] 핀 일괄삭제 권한 = 프로젝트 소유자·super(서버 can_manage_members → Auth.projectCanManage).
     *  저장(_autoSave)이 디자이너 모드에서만 동작하므로 모드도 함께 본다. 열람전용 세션(Auth.readonly)은 제외. */
    canBulkDeletePins() {
      return State.mode === "designer" && typeof Auth !== "undefined" && !!Auth.projectCanManage && !Auth.readonly;
    },

    /** [WO 20260929-bulkdel → 20261001-bulkreauth] 핀 일괄삭제 — 확인(Prompt.confirm, 개수 명시) → 본인 재인증(Auth.ensureReauth,
     *  5분 내 재사용) → 단건과 같은 _removePins 경로. 재인증 실패·취소면 0건. 이 배포본의 다음 저장에 X-Reauth 를 싣는다.
     *  번호는 자동 재채번하지 않는다(기존 번호 리셋 기능이 따로 있다). 반환: 삭제된 개수. */
    async deletePins(ids, opts) {
      if (!this.canBulkDeletePins()) { Prompt.toast("프로젝트 소유자·슈퍼관리자만 핀을 일괄 삭제할 수 있습니다"); return 0; }
      const want = new Set((ids || []).map(String));
      const targets = (State.pins || []).filter(p => want.has(String(p.id)));
      if (!targets.length) return 0;
      const scope = (opts && opts.scopeLabel) ? `${opts.scopeLabel}의 ` : "";
      if (!await Prompt.confirm("포인트 일괄 삭제", `${scope}포인트 ${targets.length}개를 삭제할까요?\n(첨부된 사진·노트·문서 정보도 함께 제거되며, 번호는 자동으로 다시 매기지 않습니다)`)) return 0;
      if (!Auth.ensureReauth || !(await Auth.ensureReauth())) { Prompt.toast("본인 확인이 끝나지 않아 삭제하지 않았습니다"); return 0; }
      const removed = this._removePins(targets.map(p => p.id));
      if (removed.length) this._bulkReauthDep = State.autoSaveDepId || null;
      Prompt.toast(`포인트 ${removed.length}개 삭제됨`);
      return removed.length;
    },
    _bulkReauthDep: null,   // [WO 20261001-bulkreauth] 일괄삭제가 아직 서버에 안 올라간 배포본 id — 그 PATCH 에만 X-Reauth

    /** 🔴 [WO 20260929-bulkdel] 핀 제거 공유 지점 — 단건(deletePin)·일괄(deletePins)이 같은 경로를 탄다.
     *  tombstone 기록(병합 부활 방지, _mergePins) → State 제거 → 렌더 → 오프라인 OpLog → _autoSave(draft+dirty).
     *  확인 대화상자는 호출부 몫. 반환: 실제 제거된 핀 배열. */
    _removePins(ids) {
      const want = new Set((ids || []).map(String));
      const removed = (State.pins || []).filter(p => want.has(String(p.id)));
      if (!removed.length) return [];
      const tomb = this._pinTombstones();
      const now = Date.now();
      removed.forEach(p => {
        tomb[String(p.id)] = now;
        if (p.videoUrl) _revokeVideoBlob(p.videoUrl); // [B5] 삭제 시 즉시 해제
      });
      State.pins = State.pins.filter(p => !want.has(String(p.id)));
      if (State.activePin != null && want.has(String(State.activePin))) State.activePin = null;
      if (State.editingPinId != null && want.has(String(State.editingPinId))) { State.editingPinId = null; this._closePinForm(); }
      if (typeof Zones !== "undefined" && Zones.refreshPinLinks) Zones.refreshPinLinks();
      UI.renderPinList();
      UI.renderPinsOnMap();
      // [오프라인 작업지시서 ] 오프라인이면 삭제 op 기록(핀마다, 순서 보존) + 로컬 스냅샷
      if (!navigator.onLine && typeof OpLog !== "undefined") {
        removed.reduce((pr, p) => pr.then(() => OpLog.recordCurrent("pin", "delete", p.id)), Promise.resolve())
          .then(() => persistLocalDeployment()).catch(() => {});
      }
      this._autoSave();
      return removed;
    },

    /* ── [WO 20260929-bulkdel] 🔴 핀 삭제 부활 방지 — 병합의 단일 출처 ─────────────────────────
       _mergeById(서버본, 내 로컬) 는 "서버에만 있는 항목 보존" 규칙이라 두 경로로 지운 핀을 되살렸다:
         ① 내가 지운 핀: 서버가 더 새로우면(409 충돌 / draft 기준 버전 다름) 서버본의 그 핀이 복귀
         ② 남이 지운 핀: 내 로컬에 남은 옛 핀이 서버본에 덮여 복귀(3-way 기준 = 내가 아는 서버 버전의 id)
       규칙: 병합 결과에서 (a) 내 tombstone 에 있는 id, (b) 기준 id 목록엔 있었는데 지금 서버본엔 없는 id 를 뺀다.
       (b) 는 기준(baseIds)을 모르면(null) 적용하지 않는다 — 추정으로 지우지 않는다(유실 0 쪽). 삭제 우선(delete-wins). */
    _pinTombstones() {
      if (!State.pinTombstones || typeof State.pinTombstones !== "object") State.pinTombstones = {};
      return State.pinTombstones;
    },
    _pinIds(arr) {
      return (Array.isArray(arr) ? arr : []).filter(p => p && p.id != null).map(p => String(p.id));
    },
    /** [WP1 · H8] tombstone({id,_deleted:true,ts} — 서버 /ops 가 남김) 을 뺀 "살아있는" 항목만 — 필터 SoT.
     *  서버본을 State.pins/zones/annotations 에 올리는 모든 로더와 병합(_mergePins/_mergeConflict/_draftVsServer),
     *  32_Offline 의 ops 반영이 이 함수 하나를 쓴다. 비배열은 그대로 돌려준다(호출부의 null 판정 보존). */
    _live(arr) {
      return Array.isArray(arr) ? arr.filter(o => !(o && o._deleted)) : arr;
    },
    /** draft 에 실어 둘 핀 병합 메타 — _saveDraftLocal / _markDraftClean 공유(SoT). */
    _draftPinMeta() {
      return {
        deletedPins: Object.keys(this._pinTombstones()),
        basePinIds:  Array.isArray(State.pinBaseIds) ? State.pinBaseIds.slice() : null
      };
    },
    /** draft 의 tombstone 을 현재 도면 tombstone 에 합친다(복원 경로 공유). */
    _adoptDraftTombstones(d) {
      if (!d || !Array.isArray(d.deletedPins)) return;
      const tomb = this._pinTombstones();
      d.deletedPins.forEach(id => { if (id != null && !tomb[String(id)]) tomb[String(id)] = 1; });
    },
    _mergePins(srvPins, localPins, baseIds, tombIds) {
      // [WP1 · H5] 서버본의 tombstone 은 "누군가 지운 핀" — 내 로컬의 같은 id 가 병합으로 되살리지 못하게 tomb 에 합친다.
      const srvTomb = (Array.isArray(srvPins) ? srvPins : []).filter(p => p && p._deleted && p.id != null).map(p => String(p.id));
      // [WO 20260930-lww] 같은 id = 핀 단위 LWW(updatedAt 큰 쪽, 같거나 없으면 서버) — 종전 "로컬 통째 우선" 은
      //   A 가 옮기거나 라벨을 바꾼 핀을 B 화면에 못 보이게 했고 B 저장이 A 의 수정을 되돌렸다(설계서 H2).
      const newer = (typeof PinSeries !== "undefined" && PinSeries.newer) ? (s, l) => PinSeries.newer(s, l) : null;
      const merged = this._mergeById(this._live(srvPins), localPins, newer);
      const tomb = new Set((tombIds || []).map(String).concat(srvTomb));
      // 서버본을 실제로 받지 못했으면(비배열) (b) 판정 불가 — 기준 핀 전부를 "남이 지웠다"로 오판하지 않는다.
      const base = (Array.isArray(baseIds) && Array.isArray(srvPins)) ? new Set(baseIds.map(String)) : null;
      const srv = new Set(this._pinIds(srvPins));
      const out = merged.filter(p => {
        if (!p || p.id == null) return true;
        const k = String(p.id);
        if (tomb.has(k)) return false;                       // (a) 내가 지운 핀
        if (base && base.has(k) && !srv.has(k)) return false; // (b) 남이 지운 핀
        return true;
      });
      // [WO 20260930-numdup] 🔴 병합 = 동시 생성 번호 충돌이 생기는 유일한 지점 — 409 재시도(_mergeConflict)와
      //   오프라인 복귀(_draftVsServer: 화면 복원·flush) 둘 다 여기를 지나므로 한 번만 고친다(§G-2-5).
      this._renumberConcurrent(out, base ? baseIds : null, srvPins);
      return this._pinsSeen(out);   // [WO 20260930-lww] 병합 결과(재채번 포함)가 새 기준 — 재채번은 수정으로 찍지 않는다
    },
    /** [WO 20260930-lww] 서버본·draft·병합 결과를 State 에 올릴 때 — 이 내용이 수정 감지 기준(PinSeries.baseline). */
    _pinsSeen(arr) {
      if (typeof PinSeries !== "undefined" && PinSeries.baseline) PinSeries.baseline(arr);
      return arr;
    },
    /** [WO 20260930-lww] 편집 관찰 지점(_markDirty — _autoSave 도 경유 · 병합 직전 _mergeConflict) — 기준 이후 바뀐 핀에 updatedAt(PinSeries.stampChanged). */
    _pinsStamp() {
      if (typeof PinSeries !== "undefined" && PinSeries.stampChanged) PinSeries.stampChanged(State.pins);
    },
    /** 병합 결과의 동시 생성 번호 충돌을 재채번(정본 PinSeries.resolveConcurrentNos)하고 1회 알린다.
     *  같은 변경을 화면 복원과 flush 가 두 번 계산해도 토스트는 한 번만(_numdupSeen). */
    _renumberConcurrent(pins, baseIds, srvPins) {
      if (typeof PinSeries === "undefined" || !PinSeries.resolveConcurrentNos) return [];
      const changes = PinSeries.resolveConcurrentNos(pins, baseIds, srvPins);
      if (!changes.length) return changes;
      const seen = this._numdupSeen || (this._numdupSeen = new Set());
      const fresh = changes.filter(c => { const k = c.id + ":" + c.from + ">" + c.to; if (seen.has(k)) return false; seen.add(k); return true; });
      fresh.forEach(c => { if (typeof Log !== "undefined" && Log.push) Log.push("pin.renumber", c.id, { oldLabel: c.from, newLabel: c.to, page: c.page, reason: "concurrent" }); });
      if (fresh.length && typeof Prompt !== "undefined" && Prompt.toast) {
        const fmt = (n, s) => (s && PinSeries.formatNo) ? PinSeries.formatNo(n, s) : n;   // 360 은 P접두(대역 계열 공통)
        Prompt.toast("번호 " + fresh.map(c => fmt(c.from, c.series) + " → " + fmt(c.to, c.series)).join(", ") + " 조정(동시 생성)");
      }
      return changes;
    },

    /** 기존 포인트 편집 — 플로팅 폼을 기존 값으로 채워 연다 */
    editPin(id) {
      const pin = State.pins.find(p => p.id === id);
      if (pin == null) return;
      // [WO 20260930-moderole] 🔴 마스터: "체커는 사진을 등록하지 않을 거야" — 이 구식 첨부 폼
      // (.pf-tools: 사진/360/문서/동영상/URL, #section-pin-form)은 계열 게이트가 없다. CHECKER
      // 계열 핀(SoT: PinSeries.seriesOf)은 이미 계열 게이트가 있는 PinActionPop(27_PinActionPop.js
      // open() — #pap-bottom 등록 섹션 숨김)으로 위임해 사진 등록 경로를 원천 차단한다(유실 0 —
      // 번호·위치명 수정은 PinActionPop 에도 있다).
      const isChecker = (typeof PinSeries !== "undefined" && PinSeries.seriesOf) ? PinSeries.seriesOf(pin) === "checkboard" : false;
      if (isChecker) {
        if (typeof PinActionPop !== "undefined" && PinActionPop.open) PinActionPop.open(id);
        return;
      }
      // 다른 모드 정리
      if (State.placing) this._togglePlacing();
      State.editingPinId = id;
      State.pending = { x: pin.x, y: pin.y };   // 좌표 보존
      State.pendingFile = null; State.pendingIsVideo = false; State.pendingDocs = [];
      // [마스터 요청] 기존 핀 아이콘을 선택 상태로 로드(없으면 기본 number)
      State.pendingIcon = pin.icon || "number";
      // 폼 필드 채우기
      UI.$("input-pin-label").value = pin.label || "";
      UI.$("input-pin-note").value = pin.note || "";
      UI.$("input-pin-url").value = pin.imageUrl || "";
      UI.$("input-pin-imgname").value = pin.imageName || "";
      // 노트/URL 있으면 펼쳐서 보여줌
      const showField = (fid, btnId, on) => {
        const f = UI.$(fid), b = UI.$(btnId);
        if (f) f.classList.toggle("hidden", !on);
        if (b) b.classList.toggle("active", on);
      };
      showField("field-pin-note", "btn-pin-note-toggle", !!pin.note);
      showField("field-pin-url",  "btn-pin-url-toggle",  !!pin.imageUrl);
      // 기존 첨부/미디어 요약 표시
      const info = UI.$("pin-file-info");
      const summ = [];
      if (pin.imageId || pin.pendingOpId) summ.push("360° 사진 등록됨");
      else if (pin.isVideo) summ.push("360° 영상 등록됨");
      if (pin.attachments && pin.attachments.length) summ.push("첨부 " + pin.attachments.length + "개");
      if (summ.length) { info.textContent = "현재: " + summ.join(" · ") + " (새 파일 선택 시 교체)"; info.classList.remove("hidden"); }
      else { info.textContent = ""; info.classList.add("hidden"); }
      UI.disable("btn-confirm-pin"); UI.$("btn-confirm-pin").disabled = false; // 편집은 항상 저장 가능
      // 화면 이동 + 폼 열기
      State.activePin = id;
      UI.renderPinList(); UI.renderPinsOnMap();
      MapCtrl.flyTo(pin.x, pin.y, Math.max(State.zoom, 2.2));
      this._openPinForm({ editing: true });
      setTimeout(() => UI.$("input-pin-label").focus(), 120);
    },

    /** 핀에 360° 미디어(클라우드 이미지/로컬 영상/외부 URL/미동기화 로컬)가 등록되어 있는가 */
    pinHasMedia(pin) {
      return !!(pin && (pin.imageId || pin.videoUrl || pin.imageUrl || pin.pendingOpId || pin.localPreview));
    },

    /** 핀에 노트/첨부/3D 포인트클라우드가 있는가 */
    pinHasInfo(pin) {
      return !!(pin && (pin.note || (pin.attachments && pin.attachments.length) || pin.has3D || pin.flsLocalId || pin.flsUrl));
    },

    /** 핀에 클릭 시 보여줄 콘텐츠(미디어 또는 정보)가 있는가 */
    pinHasContent(pin) {
      return this.pinHasMedia(pin) || this.pinHasInfo(pin);
    },

    /** 360° 오버레이 안에 노트/첨부 정보 패널 렌더 */
    _renderPanoInfoPanel(pin) {
      const panel = document.getElementById("pano-info-panel");
      if (!panel) return;
      if (!this.pinHasInfo(pin)) { panel.classList.add("hidden"); panel.innerHTML = ""; return; }

      const dlIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
      let html = `
        <div class="pano-info-title">
          <span>${UI.escapeHtml(pin.label)}</span>
          <button class="pano-info-close" id="pano-info-close" title="닫기" aria-label="닫기">✕</button>
        </div>`;
      if (pin.note) html += `<div class="pano-note-text">${UI.escapeHtml(pin.note)}</div>`;
      if (pin.attachments && pin.attachments.length) {
        html += `<div class="pano-attach-head">첨부 문서 ${pin.attachments.length}</div>`;
        pin.attachments.forEach((a, i) => {
          const k = docKind(a.type || a.name);
          html += `
            <div class="pano-attach-item" data-attach-idx="${i}" title="클릭하여 열기/다운로드">
              <span class="pin-doc-badge" style="background:${k.color}">${k.label}</span>
              <span class="pano-attach-name">${UI.escapeHtml(a.name)}</span>
              <span class="pano-attach-dl">${dlIcon}</span>
            </div>`;
        });
      }
      panel.innerHTML = html;
      panel.classList.remove("hidden");
      const closeBtn = document.getElementById("pano-info-close");
      if (closeBtn) closeBtn.addEventListener("click", () => panel.classList.add("hidden"));
      panel.querySelectorAll(".pano-attach-item").forEach(el => {
        el.addEventListener("click", () => {
          const idx = parseInt(el.dataset.attachIdx, 10);
          this._openAttachment(pin.attachments[idx], el);
        });
      });
    },

    /** 첨부 문서 열기/다운로드 */
    async _openAttachment(att, el) {
      if (!att || !att.docId) return;
      const nameEl = el ? el.querySelector(".pano-attach-name") : null;
      const orig = nameEl ? nameEl.textContent : "";
      if (nameEl) nameEl.textContent = "불러오는 중...";
      try {
        const dataURL = await Cloud.fetchDoc(att.docId);
        // dataURL → Blob → 다운로드 (브라우저가 처리할 수 없는 형식도 안전하게 저장)
        const blob = await (await fetch(dataURL)).blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = att.name || "attachment";
        document.body.appendChild(a);
        a.click();
        a.remove();
        // PDF/이미지는 새 탭 미리보기도 함께 제공
        if (/pdf|img|image/.test(att.type || "") || /\.pdf$|\.(png|jpe?g|gif|webp)$/i.test(att.name || "")) {
          window.open(blobUrl, "_blank");
        }
        setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
      } catch (e) {
        alert("첨부를 불러올 수 없습니다: " + (e.message || e));
      } finally {
        if (nameEl) nameEl.textContent = orig;
      }
    },

    /* ── 360° 팝업 열기 (클라우드 저장본 / 영상 / URL) ── */
    async openPano(pin) {
      // 현재 핀 기록 + 레이더/네비게이션 갱신 (3DVista radar · 핀 이동 핫스팟)
      State.activePin = pin.id;
      PanoViewer._currentPin = pin;
      // [구면 마커] 새 360 열 때 추가모드는 항상 꺼진 상태(보기 모드)로 시작
      this._spotAdd = false;
      if (PanoViewer.setSpotAddMode) PanoViewer.setSpotAddMode(false);
      const _sb = UI.$("btn-pano-spot"); if (_sb) _sb.classList.remove("on");
      Radar.update(pin);
      PanoNav.update(pin);
      // FLS 포인트 클라우드가 연결된 핀이면 3D 뷰어를 360과 나란히 표시
      if (typeof FLS !== "undefined") {
        const hasFls = !!(pin && (pin.flsUrl || pin.fls || pin.flsLocalId));
        const ov = document.getElementById("pano-overlay");
        if (ov) ov.classList.toggle("with-fls", hasFls);
        if (hasFls) FLS.openForPin(pin); else FLS.showPane(false);
      }
      if (typeof Notes !== "undefined") Notes.setPin(pin);  // 이슈/노트 패널 핀 연결
      if (typeof TimeLapse !== "undefined") TimeLapse.setPin(pin);  // 타임랩스 시점 바

      // [마스터 요청] 사진 대신 PDF가 등록된 핀 → 내장 PDF 뷰어로 팝업 표시(파노 오버레이 대신).
      if (!this.pinHasMedia(pin) && typeof PdfPopup !== "undefined") {
        const pdfAtt = (pin.attachments || []).find((a) => /\.pdf$/i.test(a.name || "") || a.kind === "pdf" || (a.kind && a.kind.type === "pdf"));
        if (pdfAtt) {
          let src = null;
          try {
            if (pdfAtt.docId) src = await Cloud.fetchDoc(pdfAtt.docId);
            else if (pdfAtt.pendingOpId && typeof Cloud !== "undefined") src = Cloud._cache["op:" + pdfAtt.pendingOpId] || null;
          } catch (e) {}
          if (src) { PdfPopup.open(src, pin.label); return; }
          if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("PDF를 불러올 수 없습니다(미동기화/오프라인일 수 있음)");
        }
      }

      // 노트/첨부만 있고 360° 미디어가 없는 정보 포인트 → 정보 패널만 표시
      if (!this.pinHasMedia(pin) && this.pinHasInfo(pin)) {
        const $ = id => document.getElementById(id);
        $("pano-location-name").textContent = "" + pin.label;
        $("pano-loading").classList.add("hidden");
        $("pano-error").classList.add("hidden");
        $("pano-canvas").classList.add("hidden");
        $("pano-hint").classList.add("hidden");
        $("pano-controls").classList.add("hidden");
        $("pano-overlay").classList.remove("hidden");
        PanoViewer.open = true;
        this._renderPanoInfoPanel(pin);
        return;
      }
      this._renderPanoInfoPanel(pin); // 미디어와 함께 노트/첨부도 표시
      // 1) 로컬 영상 blob
      if (pin.videoUrl) { PanoViewer.loadVideo(pin.videoUrl, pin.label); return; }
      // 1.3) 즉시등록 로컬 미리보기(업로드 진행 중) — imageId 준비 전이라도 바로 표시
      //   blob: URL 은 이 세션에서 만든 것만 유효(재접속하면 죽음). 메모리 캐시(현 세션)를
      //      우선 사용하고, 죽은 blob 이면 명확히 안내한다.
      if (!pin.imageId && (pin.localPreview || (typeof Cloud !== "undefined" && (Cloud._cache["op-preview:" + pin.id] || Cloud._cache["local:" + pin.id])))) {
        const $ = id => document.getElementById(id);
        // [핵심 버그 수정] 현 세션 메모리 캐시(살아있는 dataURL)를 "유일한 신뢰원"으로 사용.
        //   pin.localPreview 는 blob: 인 경우 재접속하면 죽은 URL → 절대 fallback 으로 쓰지 않는다.
        //   (blob 이 아닌 dataURL localPreview 만 예외적으로 허용)
        const memSrc = (typeof Cloud !== "undefined" && (Cloud._cache["op-preview:" + pin.id] || Cloud._cache["local:" + pin.id])) || null;
        const lpAlive = (typeof pin.localPreview === "string" && pin.localPreview.indexOf("blob:") !== 0) ? pin.localPreview : null;
        let src = memSrc || lpAlive;
        if (src) {
          $("pano-location-name").textContent = "360°(" + (pin.uploading ? "업로드 중" : "임시") + ") — " + pin.label;
          $("pano-loading").classList.add("hidden");
          $("pano-error").classList.add("hidden");
          $("pano-hint").classList.add("hidden");
          $("pano-controls").classList.add("hidden");
          $("pano-overlay").classList.remove("hidden");
          PanoViewer.open = true;
          PanoViewer.load(src, pin.label);
          return;
        }
        // 살아있는 소스 없음(죽은 blob) → 아래 공통 안내로 진행
      }
      // 1.5) 미동기화 로컬 이미지(오프라인 임시 저장) — 로컬 캐시로 즉시 미리보기
      if (pin.pendingOpId && Cloud._cache["op:" + pin.pendingOpId]) {
        const $ = id => document.getElementById(id);
        $("pano-location-name").textContent = "360°(임시 저장) — " + pin.label;
        $("pano-loading").classList.add("hidden");
        $("pano-error").classList.add("hidden");
        $("pano-hint").classList.add("hidden");
        $("pano-controls").classList.add("hidden");
        $("pano-overlay").classList.remove("hidden");
        PanoViewer.open = true;
        PanoViewer.load(Cloud._cache["op:" + pin.pendingOpId], pin.label);
        return;
      }
      // 2) 클라우드 저장 이미지
      if (pin.imageId) {
        const $ = id => document.getElementById(id);
        $("pano-location-name").textContent = "360° — " + pin.label;
        $("pano-loading").classList.remove("hidden");
        $("pano-error").classList.add("hidden");
        $("pano-canvas").classList.add("hidden");
        $("pano-hint").classList.add("hidden");
        $("pano-controls").classList.add("hidden");
        $("pano-overlay").classList.remove("hidden");
        PanoViewer.open = true;
        try {
          // [오프라인 작업지시서 ] 오프라인 번들(IndexedDB) base64 우선 → 온라인 재시도
          let dataURL = (typeof resolvePanoSource === "function") ? await resolvePanoSource(pin) : null;
          if (!dataURL) dataURL = await Cloud.fetchImage(pin.imageId);
          if (!dataURL) throw new Error("이 3D는 오프라인에 다운로드되지 않았습니다.");
          PanoViewer.load(dataURL, pin.label);
        } catch (e) {
          PanoViewer._showError("(클라우드: " + (pin.imageName || pin.imageId) + ")", e.message);
        }
      } else if (pin.imageUrl && pin.imageUrl.indexOf("blob:") !== 0) {
        // 3) URL 직접 입력 (이미지/영상 자동 판별). 단, blob: 은 죽은 임시 URL 이라 제외.
        PanoViewer.loadMedia(pin.imageUrl, pin.label, pin.isVideo);
      } else {
        // 4) [B3] 미디어 없음 / 죽은 blob 임시 미리보기 — 원인별 명확 안내
        const $ = id => document.getElementById(id);
        $("pano-location-name").textContent = "360° — " + pin.label;
        $("pano-loading").classList.add("hidden");
        $("pano-canvas").classList.add("hidden");
        $("pano-controls").classList.add("hidden");
        $("pano-hint").classList.add("hidden");
        // 한 번이라도 이미지 미리보기(localPreview/imageUrl=blob)가 있었으면 업로드 미완으로 판단
        const hadTempImage = !!(pin.localPreview || (pin.imageUrl && pin.imageUrl.indexOf("blob:") === 0) || pin.imageName);
        $("pano-error").querySelector(".pano-error-msg").textContent = hadTempImage
          ? "이 360° 사진은 임시 미리보기만 저장되어 재접속 후 표시할 수 없습니다. 편집모드에서 사진을 다시 업로드해 주세요."
          : "이 포인트에는 360° 미디어가 등록되지 않았습니다. 편집모드에서 사진(클라우드 업로드) 또는 영상 URL을 추가해 주세요.";
        $("pano-error-url").textContent = "";
        const hint = $("pano-error").querySelector(".pano-error-hint");
        if (hint) hint.textContent = hadTempImage
          ? "사진은 '그림 파일 선택'으로 업로드하면 클라우드에 저장되어 모든 기기·재접속에서 표시됩니다."
          : "영상은 외부 호스팅 URL(.mp4)로, 사진은 파일 업로드로 저장하세요.";
        $("pano-error").classList.remove("hidden");
        $("pano-overlay").classList.remove("hidden");
        PanoViewer.open = true;
      }
    },

    /* ── 배포 (설계자 → 뷰어) ── */
    /* ── 자동 저장 (버튼 없이 즉시 저장) ──
       도면 업로드 즉시 배포본(작업본)을 생성하고, 핀·영역 변경 시 디바운스 갱신한다.
       사용자가 "배포" 버튼을 누르지 않아도 도면과 작업 내용이 서버에 보존된다. */
    /** ── [마스터 요청 (나)] 도면 페이지(dataURL)를 R2에 업로드하고 R2 URL 배열로 치환 ──
     *  · 성공: ['/api/r2/object/assets/xxx.jpg', ...] 반환 → D1에는 URL만 저장(가벼움)
     *  · 실패(R2 미구성/네트워크): 원본 dataURL 배열 그대로 반환 → D1 base64 폴백(소실 방지)
     *  이미 R2 URL(또는 http URL)인 항목은 재업로드하지 않고 그대로 둠(중복 방지). */
    async _uploadPagesToR2(pagesData) {
      if (!Array.isArray(pagesData) || !pagesData.length) return pagesData || [];
      const out = [];
      for (const page of pagesData) {
        // 이미 URL이면(스냅샷 재저장 등) 그대로 사용
        if (typeof page === "string" && /^(https?:|\/api\/r2\/object\/)/i.test(page)) {
          out.push(page); continue;
        }
        // dataURL이 아니면 변환 불가 → 원본 유지
        if (typeof page !== "string" || !/^data:/i.test(page)) { out.push(page); continue; }
        try {
          const m = /^data:([^;,]+)[;,]/i.exec(page);
          const ct = (m && m[1]) || "image/jpeg";
          const blob = await (await fetch(page)).blob(); // dataURL → Blob (브라우저 표준)
          // [P14 형제 결함] Auth.headers() 는 항상 Content-Type: application/json 을 넣는다.
          //   종전 순서(Object.assign({CT: ct}, Auth.headers()))는 그 json 이 이미지 CT 를
          //   덮어써서 R2 객체가 .bin/application-json 으로 저장됐다(<img> 는 MIME 스니핑
          //   덕에 우연히 동작). 실제 CT 가 마지막에 오도록 순서를 바로잡는다.
          const r = await fetch("/api/r2/upload", {
            method: "PUT",
            headers: Object.assign({}, Auth.headers ? Auth.headers() : {}, { "Content-Type": ct }),
            body: blob
          });
          if (!r.ok) { out.push(page); continue; }  // 실패 → base64 폴백
          const j = await r.json();
          out.push(j.url || page);                  // R2 URL 채택
        } catch (e) { out.push(page); }             // 예외 → base64 폴백
      }
      return out;
    },

    /* ==================================================================
       [P14] 배포 스냅샷의 "원본 PDF" 보관 · 지연 로드 (뷰어 확대 화질)

       근본원인: 뷰어는 배포 스냅샷(비트맵 <img>)만 그린다. 원본 PDF 가 없으니
       확대하면 CSS 로 비트맵을 늘릴 수밖에 없어 뭉갠다(마스터 실사용 보고).
       편집모드는 State.pdfDoc 가 있어 재래스터로 이미 해결됨(5996a22).

       채택: 하이브리드 — 첫 화면은 종전대로 스냅샷으로 즉시 띄우고,
       스냅샷 해상도를 실제로 넘겨 확대했을 때만 원본 PDF 를 1회 지연 로드해
       편집모드가 쓰는 기존 경로(PDF.requestZoomRerender -> PDF.renderCrop)로
       보이는 영역만 다시 그린다. 새 렌더 파이프라인은 만들지 않는다.
       ================================================================== */

    /** [SoT] /api/r2/upload PUT 공통 경로 — 원본 PDF 보관(_uploadSourcePdf)과 360 도형 첨부
     *  (_uploadAttachment, WO 20261001-panoshapes)가 함께 쓴다. 실패 -> null(호출부가 각자 처리). */
    async _uploadToR2(ab, contentType) {
      if (!ab || !ab.byteLength) return null;
      try {
        const blob = new Blob([ab], { type: contentType || "application/octet-stream" });
        const r = await fetch("/api/r2/upload", {
          method: "PUT",
          headers: Object.assign({}, Auth.headers ? Auth.headers() : {}, { "Content-Type": contentType || "application/octet-stream" }),
          body: blob
        });
        if (!r.ok) return null;
        const j = await r.json();
        return j.url || null;
      } catch (e) { return null; }
    },
    /** 원본 PDF 를 R2 에 1회 업로드 (기존 /api/r2/upload PUT 재사용).
     *  실패는 치명적이지 않다 -> null 반환 = 스냅샷만 저장(종전 동작 그대로). */
    async _uploadSourcePdf(ab) { return this._uploadToR2(ab, "application/pdf"); },
    /** [WO 20261001-panoshapes] 360 도형(사각형/원) 첨부 사진/도면 업로드 — Auth.r2 토큰 규칙은
     *  다운로드 측(Auth.r2(url))에서 적용되므로 여기선 업로드만. */
    async _uploadAttachment(ab, contentType) { return this._uploadToR2(ab, contentType); },

    /** 배포본에 남길 source_meta(JSON 문자열) 생성.
     *  · 이미지 도면(PNG/JPG)은 원본이 곧 스냅샷이므로 이 경로를 타지 않는다 -> null.
     *  · 이미 업로드한 원본이 있으면 재업로드하지 않는다(URL 재사용).
     *  · dims = PDF.snapshotAllPages 가 실측한 실제 저장 픽셀([{w,h,pw,ph}]).
     *    뷰어는 이 값으로 "언제 원본이 필요한지"를 추측이 아니라 사실로 판정한다. */
    async _buildSourceMeta(dims) {
      if (State.fileType !== "pdf" || !State.fileData) return null;
      let url = State.sourcePdfUrl;
      if (!url) {
        url = await this._uploadSourcePdf(State.fileData);
        // 🔴 [WO 20260929-lossless] 종전엔 여기서 조용히 null → 원본 없는 배포본이 "저장 완료"로 만들어졌다
        //   (확대하면 깨지는 도면이 영구 확정 = 데이터 유실). 원본 보관 실패 = 저장 실패로 올린다.
        //   공유 지점 1곳: 신규(_createInitialSave)·교체(_replaceDeckDrawing)·갱신(_saveNow PATCH) 전부 여기를 탄다.
        if (!url) throw this._sourceKeepFailed();
        State.sourcePdfUrl = url;
      }
      const pages = Array.isArray(dims) ? dims
        : (Array.isArray(PDF.lastSnapshotDims) ? PDF.lastSnapshotDims : []);
      this._clearSourceKeepFail();
      return this._sourceMetaJson(url, pages);
    },

    /** 원본 PDF 보관 실패 — 조용한 실패 금지. 온라인이면 [재시도] 배너(닫을 때까지 유지), 오프라인이면
     *  "이 기기에 보관 → 연결되면 자동 업로드" 안내(_flushDirtyDrafts 가 원본까지 올린다).
     *  대비(실측 계산): #FDE8E8 on #5B1111 = 11.7:1 · 버튼 #111827 on #FCA5A5 = 9.3:1 (WCAG AAA)
     *  @returns {Error} code="SOURCE_KEEP_FAILED" — 호출부가 throw 해 저장을 중단한다. */
    _sourceKeepFailed() {
      const err = new Error("원본 PDF 보관 실패");
      err.code = "SOURCE_KEEP_FAILED";
      this._lastSaveErr = err.code;
      const offline = !navigator.onLine;
      const msg = offline
        ? "오프라인 — 원본 PDF 는 이 기기에 보관했습니다. 연결되면 원본과 함께 저장됩니다"
        : "원본 PDF 보관 실패 — 저장을 중단했습니다(도면은 이 기기에 보관됨). 재시도하세요";
      try { Prompt && Prompt.toast && Prompt.toast(msg, 6000); } catch (e) {}
      if (offline) return err;
      try {
        let bar = document.getElementById("src-keep-fail");
        if (!bar) {
          bar = document.createElement("div");
          bar.id = "src-keep-fail";
          bar.setAttribute("role", "alert");
          bar.style.cssText = "position:fixed;left:50%;top:64px;transform:translateX(-50%);z-index:10000;" +
            "display:flex;gap:10px;align-items:center;max-width:calc(100vw - 24px);background:#5B1111;color:#FDE8E8;" +
            "border:1px solid #F87171;border-radius:10px;padding:9px 12px;font-size:13px;font-weight:600;" +
            "box-shadow:0 8px 24px rgba(0,0,0,.45);";
          const t = document.createElement("span");
          t.textContent = "원본 PDF 보관 실패 — 저장이 중단됐습니다. 도면은 이 기기에 보관됨";
          const retry = document.createElement("button");
          retry.type = "button"; retry.dataset.act = "retry"; retry.textContent = "재시도";
          retry.style.cssText = "background:#FCA5A5;color:#111827;border:0;border-radius:7px;padding:6px 12px;font-weight:700;cursor:pointer;";
          retry.addEventListener("click", () => { retry.disabled = true; Promise.resolve(this._retryAfterSourceFail()).finally(() => { retry.disabled = false; }); });
          const close = document.createElement("button");
          close.type = "button"; close.dataset.act = "close"; close.setAttribute("aria-label", "닫기"); close.textContent = "×";
          close.style.cssText = "background:transparent;color:#FDE8E8;border:0;font-size:18px;line-height:1;cursor:pointer;padding:0 4px;";
          close.addEventListener("click", () => this._clearSourceKeepFail());
          bar.append(t, retry, close);
          document.body.appendChild(bar);
        }
      } catch (e) {}
      return err;
    },
    _clearSourceKeepFail() {
      const b = document.getElementById("src-keep-fail");
      if (b && b.parentNode) b.parentNode.removeChild(b);
    },
    /** [재시도] — 화면의 미저장 도면은 수동 저장 경로로, 다른 구역의 보류 draft 는 자동 업로드 경로로 다시 보낸다.
     *  (실패하면 두 경로 모두 _sourceKeepFailed 로 배너를 다시 띄운다) */
    async _retryAfterSourceFail() {
      this._clearSourceKeepFail();
      let ok = true;
      if (State.mode === "designer" && State.fileType && (this._dirty || !State.autoSaveDepId)) ok = await this._saveNow();
      if (ok) await this._flushDirtyDrafts();   // 같은 실패를 두 번 알리지 않는다
    },

    /** source_meta 직렬화 형식의 SoT — 도면 등록·영역 복사·원본 사후 등록이 같은 형식을 쓴다. */
    _sourceMetaJson(url, pages) {
      pages = Array.isArray(pages) ? pages : [];
      return JSON.stringify({ v: 1, pdf_url: url, pages: pages });
    },

    /* ══════════════════════════════════════════════════════════════════
       [WO 20260928-copy] 영역 = 원본에서 복사한 새 1페이지 PDF 배포본
       (31_Projects.extractRegionAsDeck 가 지휘. 여기는 원본 확보·업로드·배포본 생성만.)
       🔴 원본 배포본의 핀·구역·주석은 읽지도 쓰지도 않는다 — 원본 쪽 쓰기는
          _attachSourcePdf 의 source_meta 한 칸뿐(서버 PATCH 는 미전송 필드를 보존한다).
       ══════════════════════════════════════════════════════════════════ */

    /** 복사 전 대조 기대값 — 화면 도면(스냅샷)과 원본 PDF 가 같은 파일/같은 크기인지.
     *  meta.pages[p].pw/ph(스냅샷 pt)가 있으면 크기로, 없으면 화면 이미지 비율로 비교한다. */
    _regionExpect(meta, snapCount, pageNo, live) {
      const pages = meta && Array.isArray(meta.pages) ? meta.pages : [];
      const e = { count: snapCount > 0 ? snapCount : pages.length };
      const d = pages[(pageNo || 1) - 1];
      if (d && d.pw > 0 && d.ph > 0) { e.pw = d.pw; e.ph = d.ph; return e; }
      if (live) {
        const img = UI.$("map-image");
        if (img && img.naturalWidth && !img.classList.contains("hidden")) { e.w = img.naturalWidth; e.h = img.naturalHeight; }
      }
      return e;
    },

    /** 배포본의 원본 PDF 바이트 확보.
     *  @returns {Promise<{bytes, expect}|{missing:true, snapCount}|{error:string}>} */
    async _regionSource(depId, pageNo) {
      const live = State.autoSaveDepId === depId;
      // ① 편집모드에 PDF 원본이 떠 있다 — 화면이 곧 그 PDF 라 좌표 대조가 필요 없다(네트워크 0)
      if (live && State.fileType === "pdf" && State.fileData) return { bytes: State.fileData, expect: null };
      let meta = null, snapCount = 0;
      if (live) {
        meta = State.sourceMeta || (State.sourcePdfUrl ? { pdf_url: State.sourcePdfUrl } : null);
        snapCount = Array.isArray(State.viewerPages) ? State.viewerPages.length : 0;
      } else {
        try {
          const r = await fetch("/tables/deployments/" + encodeURIComponent(depId), { headers: Auth.headers() });
          if (!r.ok) return { error: "도면 정보를 불러오지 못했습니다(HTTP " + r.status + ")" };
          const dep = await r.json();
          try { meta = JSON.parse((dep && dep.source_meta) || "null"); } catch (e) { meta = null; }
          try { const pg = JSON.parse((dep && dep.pages_data) || "[]"); snapCount = Array.isArray(pg) ? pg.length : 0; } catch (e) {}
        } catch (e) { return { error: "도면 정보를 불러오지 못했습니다 — 네트워크를 확인하세요" }; }
      }
      if (!meta || typeof meta.pdf_url !== "string" || !meta.pdf_url) return { missing: true, snapCount };
      const expect = this._regionExpect(meta, snapCount, pageNo, live);
      this._srcProgress(-1);
      let ab = null;
      try { ab = await this._fetchSourcePdf(meta.pdf_url); } catch (e) { ab = null; }
      this._srcProgress(null);
      if (!ab) return { error: "원본 PDF 를 내려받지 못했습니다" };
      return { bytes: ab, expect };
    },

    /** 원본 없는 구버전 도면 — 사용자가 고른 PDF 파일(취소면 null). */
    _pickPdfFile() {
      return new Promise((resolve) => {
        const inp = document.createElement("input");
        inp.type = "file";
        inp.accept = "application/pdf,.pdf";
        let done = false;
        const fin = (f) => { if (done) return; done = true; resolve(f || null); };
        inp.addEventListener("change", () => fin(inp.files && inp.files[0]));
        inp.addEventListener("cancel", () => fin(null));
        inp.click();
      });
    },

    /** 구버전 배포본에 원본 PDF 를 사후 등록 — 🔴 source_meta 한 칸만 보낸다(핀·구역·주석 미전송 =
     *  서버 부분 갱신이 그대로 보존). 스냅샷 실측 픽셀은 기록이 없어 pages=[] → 뷰어는 이미지 크기로 폴백.
     *  @returns {Promise<boolean>} */
    async _attachSourcePdf(depId, ab) {
      const url = await this._uploadSourcePdf(ab);
      if (!url) return false;
      const meta = this._sourceMetaJson(url, []);
      const build = () => ({ source_meta: meta });
      const live = State.autoSaveDepId === depId;
      let ok = false;
      try {
        if (live) ok = (await this._patchDeployment(depId, build)).ok;   // 낙관적 잠금 버전도 함께 갱신
        else {
          const res = await fetch("/tables/deployments/" + encodeURIComponent(depId), {
            method: "PATCH", headers: Auth.headers(), body: JSON.stringify(build())
          });
          ok = res.ok;
        }
      } catch (e) { ok = false; }
      if (ok && live) this._applySourceMeta({ source_meta: meta });   // 지금 화면도 곧바로 원본 지연 로드 가능
      return ok;
    },

    /** 영역 PDF(bytes)로 새 배포본 생성 → id. 실패 시 null(조용한 성공 위장 금지).
     *  🔴 원본 PDF 업로드가 실패하면 아무것도 만들지 않는다 — 스냅샷 이미지만 있는 "깨지는 복사본" 금지.
     *  스냅샷·R2·저장 형식은 도면 등록과 같은 경로(snapshotAllPages · _uploadPagesToR2 · _deploymentBody). */
    async _createRegionCopyDeployment(name, bytes) {
      const pdfUrl = await this._uploadSourcePdf(bytes);
      if (!pdfUrl) return null;
      const prevDims = PDF.lastSnapshotDims;   // 전역 실측값 오염 방지(편집 중 도면의 저장에 섞이면 안 된다)
      let pages = [], dims = [], doc = null;
      try {
        doc = await PDF.load(bytes);
        pages = await PDF.snapshotAllPages(doc);
        dims = PDF.lastSnapshotDims || [];
      } catch (e) { pages = []; }
      finally {
        PDF.lastSnapshotDims = prevDims;
        try { if (doc && doc.destroy) doc.destroy(); } catch (e) {}
      }
      if (!pages.length) return null;
      const r2pages = await this._uploadPagesToR2(pages);
      const body = this._deploymentBody({ title: name, fileName: name + ".pdf" }, r2pages, this._sourceMetaJson(pdfUrl, dims));
      try {
        const res = await fetch("/tables/deployments", { method: "POST", headers: Auth.headers(), body: JSON.stringify(body) });
        if (!res.ok) return null;
        const rec = await res.json();
        return (rec && rec.id) || null;
      } catch (e) { return null; }
    },

    /** [WO 20260929-lossless ⑥] 문서 교체 시 이전 PDF 문서 해제.
     *  🔴 근본원인: State.reset()(01_State.js)은 pdfDoc/srcPdfDoc 참조만 null 로 끊고 destroy() 를 부르지 않았다 —
     *  pdf.js 문서는 전용 워커·파싱 캐시(수십~수백 MB)를 붙들고 있어 도면을 바꿀 때마다 누적됐다.
     *  State.reset() 을 부르는 20_App 의 모든 지점(업로드·구역 로드·draft 복원·허브 복귀)이 먼저 이것을 부른다. */
    _destroyDoc(doc) {
      if (!doc) return;
      try {
        const st = PDF._renderState;
        if (st && st.pdfDoc === doc) { clearTimeout(st.pending); PDF._clearCrop(); st.pdfDoc = null; }
      } catch (e) {}
      try { if (doc.destroy) doc.destroy(); } catch (e) {}
    },
    _releasePdfDocs() {
      const a = State.pdfDoc, b = State.srcPdfDoc;
      this._destroyDoc(a);
      if (b !== a) this._destroyDoc(b);
    },

    /** 배포본 레코드의 source_meta 를 State 에 반영 (도면 로드 경로 공용).
     *  구버전 배포본(source_meta 없음)이면 전부 null -> 종전 동작 + 1회 안내. */
    _applySourceMeta(dep) {
      State.sourceMeta = null; State.sourcePdfUrl = null;
      this._destroyDoc(State.srcPdfDoc);   // [WO 20260929-lossless ⑥] 버리는 원본 문서의 워커·메모리 회수
      State.srcPdfDoc = null; State.srcNoticed = false; State.srcFailed = false;
      try {
        const m = JSON.parse((dep && dep.source_meta) || "null");
        if (m && typeof m === "object") {
          State.sourceMeta = m;
          if (typeof m.pdf_url === "string" && m.pdf_url) State.sourcePdfUrl = m.pdf_url;
        }
      } catch (e) { /* 손상된 메타 = 원본 없음으로 취급(조용히 틀린 화면을 그리지 않는다) */ }
    },

    /** 배포본에 기록된 현재 페이지의 스냅샷 실측 픽셀 — 없으면 null */
    _snapDim(pageNo) {
      const m = State.sourceMeta;
      if (!m || !Array.isArray(m.pages)) return null;
      const d = m.pages[(pageNo || State.pdfPage || 1) - 1];
      return (d && d.w > 0) ? d : null;
    },

    /** 구버전 배포본(원본 없음) 안내 — 조용한 실패 금지. 단, 반복 알림 금지(1회). */
    _noticeNoSource() {
      if (State.srcNoticed) return;
      State.srcNoticed = true;
      try {
        // 종전 문구("편집모드에서 다시 저장하면 원본이 함께 보관")는 사실이 아니었다 — 배포본을 열면 원본 바이트가
        //   없으므로 다시 저장해도 원본은 생기지 않는다. 실제로 원본을 붙이는 길(원본 PDF 연결)을 안내한다.
        //   (문구 분기는 "연결할 권한이 있는가"만 본다 — 로더가 배포본 id 를 채우기 전에 불릴 수 있다)
        Prompt && Prompt.toast && Prompt.toast((State.mode === "designer" && (typeof Auth === "undefined" || !!Auth.isDesigner))
          ? "이 도면은 원본 PDF 없이 저장돼 더 확대해도 선명해지지 않습니다 — 상단 [원본 PDF 연결] 로 원본을 붙이면 선명해집니다"
          : "이 도면은 원본 PDF 없이 배포돼 더 확대해도 선명해지지 않습니다 — 설계자에게 원본 PDF 연결을 요청하세요", 5200);
      } catch (e) {}
    },

    /* ── [WO 20260929-lossless ⑤] [원본 PDF 연결] — 원본 없는 배포본에 원본을 붙여 즉시 벡터 재렌더 ──
       prod 29건 중 24건이 원본 없음(지휘자 실측). 다시 등록하지 않고 원본 파일만 골라 붙인다.
       🔴 새 저장 경로 0: 업로드·PATCH 는 _attachSourcePdf(source_meta 한 칸만 — 핀·구역·주석 보존) 재사용.
       배포본에 붙으므로 이 배포본을 쓰는 모든 구역·영역(창 방식 crop)이 다음 열람부터 원본으로 확대된다.
       UI 는 전용 CSS 없이 JS 인라인(index.html/CSS 미변경) · 대비(실측 계산): #0B1F33 on #FDE68A = 13.4:1 / 버튼 #FFFFFF on #1D4ED8 = 6.7:1 */
    _canLinkSource() {
      return State.mode === "designer" && (typeof Auth === "undefined" || !!Auth.isDesigner)
        && State.fileType === "image" && Array.isArray(State.viewerPages) && State.viewerPages.length > 0
        && !!State.autoSaveDepId && !State.sourcePdfUrl && !State.srcPdfDoc
        && /\.pdf$/i.test(String(State.fileName || ""));   // PNG/JPG 도면은 원본 PDF 라는 게 없다
    },
    /** 표시 완료(_showMapViewport)마다 조건을 다시 본다 — 조건이 사라지면(원본 연결·다른 도면·뷰어) 제거. */
    _syncSourceLinkBar() {
      const vp = UI.$("map-viewport");
      let bar = document.getElementById("src-link-bar");
      if (!this._canLinkSource() || !vp) { if (bar && bar.parentNode) bar.parentNode.removeChild(bar); return; }
      if (bar && bar.dataset.dep === String(State.autoSaveDepId)) return;
      if (!bar) {
        bar = document.createElement("div");
        bar.id = "src-link-bar";
        bar.setAttribute("role", "status");
        bar.style.cssText = "position:absolute;left:50%;top:58px;transform:translateX(-50%);z-index:30;display:flex;" +
          "gap:10px;align-items:center;max-width:calc(100% - 24px);background:#FDE68A;color:#0B1F33;border:1px solid #B45309;" +
          "border-radius:10px;padding:7px 8px 7px 12px;font-size:12.5px;font-weight:600;box-shadow:0 6px 18px rgba(0,0,0,.35);";
        const t = document.createElement("span");
        t.textContent = "원본 PDF 없이 저장된 도면 — 확대하면 깨집니다";
        const b = document.createElement("button");
        b.type = "button"; b.dataset.act = "link"; b.textContent = "원본 PDF 연결 — 확대 시 선명";
        b.style.cssText = "background:#1D4ED8;color:#FFFFFF;border:0;border-radius:7px;padding:6px 11px;font-weight:700;cursor:pointer;white-space:nowrap;";
        b.addEventListener("click", () => { b.disabled = true; Promise.resolve(this._linkSourcePdf()).finally(() => { b.disabled = false; }); });
        bar.append(t, b);
        vp.appendChild(bar);
      }
      bar.dataset.dep = String(State.autoSaveDepId);
    },
    /** 원본 PDF 선택 → 같은 도면인지 검사(페이지 수·가로세로비) → 연결 → 그 자리에서 원본으로 재렌더. */
    async _linkSourcePdf() {
      const depId = State.autoSaveDepId;
      if (!this._canLinkSource()) return false;
      const f = await this._pickPdfFile();
      if (!f) return false;
      let ab = null;
      try { ab = await this._readAsArrayBuffer(f); } catch (e) { ab = null; }
      if (!ab || !this._isPdfBytes(ab)) { Prompt.toast && Prompt.toast("PDF 파일이 아닙니다 — 원본 PDF 를 고르세요"); return false; }
      let doc = null;
      try { doc = await PDF.load(ab); } catch (e) { doc = null; }
      if (!doc) { Prompt.toast && Prompt.toast("PDF 를 열 수 없습니다 — 파일이 손상됐을 수 있습니다"); return false; }
      const why = await this._sourceMismatch(doc);
      if (why && !(await Prompt.confirm("원본 PDF 확인", why + " — 다른 파일이면 확대 화면이 어긋납니다. 그래도 연결할까요?"))) {
        this._destroyDoc(doc); return false;
      }
      if (State.autoSaveDepId !== depId) { this._destroyDoc(doc); return false; }   // 고르는 사이 다른 도면으로 이동
      this._srcProgress(-1);
      let ok = false;
      try { ok = await this._attachSourcePdf(depId, ab); } finally { this._srcProgress(null); }
      if (!ok) {
        this._destroyDoc(doc);
        Prompt.toast && Prompt.toast("원본 PDF 연결 실패 — 네트워크를 확인하고 다시 시도하세요");
        return false;
      }
      // _attachSourcePdf 가 source_meta 를 반영했다 → 이미 파싱한 문서를 그대로 원본으로 쓴다(재다운로드 0)
      State.srcPdfDoc = doc;
      await this._primeSourceRender();
      this._syncSourceLinkBar();
      try { MapCtrl.applyTransform(); } catch (e) {}
      Prompt.toast && Prompt.toast("원본 PDF 연결됨 — 이제 확대해도 벡터로 선명하게 그립니다(이 도면을 쓰는 모든 구역·영역)");
      return true;
    },
    /** 고른 PDF 가 화면 도면과 같은지 — 불일치 사유(문장) 또는 null. 스냅샷 쪽 기준 = 저장된 페이지 수 + 표시 이미지 비율. */
    async _sourceMismatch(doc) {
      try {
        const pg = await doc.getPage(Math.max(1, Math.min(doc.numPages, State.pdfPage || 1)));
        const vp = pg.getViewport({ scale: 1, rotation: (pg.rotate || 0) % 360 });
        const img = UI.$("map-image");
        const expect = { count: Array.isArray(State.viewerPages) ? State.viewerPages.length : 0 };
        if (img && img.naturalWidth) { expect.w = img.naturalWidth; expect.h = img.naturalHeight; }
        return PDF.regionSizeMismatch(expect, { count: doc.numPages, w: vp.width, h: vp.height }, 0.02);
      } catch (e) { return null; }
    },

    /** 원본 다운로드 진행 표시(비차단 칩). pct=null 이면 제거. pct<0 이면 무한정 표시.
     *  대비: #E6EDF3 on #0D1117 = 14.7:1 (WCAG AAA) */
    _srcProgress(pct) {
      let el = document.getElementById("src-progress");
      if (pct === null) { if (el && el.parentNode) el.parentNode.removeChild(el); return; }
      if (!el) {
        el = document.createElement("div");
        el.id = "src-progress";
        el.setAttribute("role", "status");
        el.style.cssText = "position:fixed;left:50%;bottom:76px;transform:translateX(-50%);" +
          "z-index:9999;background:#0D1117;color:#E6EDF3;border:1px solid #30363D;" +
          "border-radius:999px;padding:8px 14px;font-size:12.5px;font-weight:600;" +
          "box-shadow:0 6px 20px rgba(0,0,0,.45);pointer-events:none;white-space:nowrap;";
        document.body.appendChild(el);
      }
      el.textContent = (pct >= 0)
        ? ("원본 도면 불러오는 중... " + pct + "%")
        : "원본 도면 불러오는 중...";
    },

    /** 스냅샷 <img> 위에 원본 PDF 크롭 오버레이를 얹기 위한 렌더 상태 셋업.
     *  편집모드와 같은 PDF._renderState 를 쓰므로 renderCrop 을 그대로 재사용한다.
     *  · baseCssScale = 스냅샷 CSS 폭 / PDF 페이지 폭(pt)  -> 오버레이 좌표계 일치
     *  · renderScale  = 스냅샷 실제 px / PDF 페이지 폭(pt) -> "스냅샷보다 선명할 때만" 판정 기준
     *  주의(정직 고지): 도면 회전(State.pdfRotation != 0)에서는 스냅샷이 CSS rotate 로 돌아가는데
     *    MapCtrl.visibleDrawingRect 는 회전을 역산하지 않는다 -> 오버레이를 얹지 않고 종전 동작. */
    async _primeSourceRender() {
      const doc = State.srcPdfDoc;
      const img = UI.$("map-image");
      if (!doc || !img || img.classList.contains("hidden") || !img.naturalWidth) return false;
      if (State.pdfRotation) { PDF._clearCrop(); return false; }
      try {
        const pg = Math.max(1, Math.min(doc.numPages, State.pdfPage || 1));
        const page = await doc.getPage(pg);
        const rot = (page.rotate || 0) % 360;
        const base = page.getViewport({ scale: 1, rotation: rot });
        if (!(base.width > 0)) return false;
        const st = PDF._renderState;
        PDF._clearCrop();
        st.pdfDoc = doc;
        st.pageNum = pg;
        st.rotation = 0;
        st.baseCssScale = (img.clientWidth || img.naturalWidth) / base.width;
        st.renderScale  = img.naturalWidth / base.width;
        st.overlayOnly  = true;
        return true;
      } catch (e) { return false; }
    },

    /** [진입점] MapCtrl.applyTransform 이 호출. 원본이 없는 상태에서만 불린다.
     *  임계(스냅샷 실해상도)를 넘겼을 때만 원본 PDF 를 딱 1회 받는다. */
    async maybeLoadSourcePdf(zoom) {
      if (State.srcPdfDoc || this._srcBusy || State.srcFailed) return false;
      if (typeof PDF === "undefined" || !PDF.needsSourceRerender) return false;
      const img = UI.$("map-image");
      if (!img || img.classList.contains("hidden") || !img.naturalWidth) return false;
      const dim = this._snapDim();
      const snapPx = (dim && dim.w) || img.naturalWidth;
      const cssPx  = img.clientWidth || img.naturalWidth;
      const z = (zoom != null) ? zoom : State.zoom;
      // [WO 20260929-lossless] device px 기준(렌더러와 같은 dpr) — 화면 픽셀×DPR 보다 스냅샷이 모자라면 원본
      const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
      if (!PDF.needsSourceRerender({ snapPx: snapPx, cssPx: cssPx, zoom: z, dpr: dpr })) return false;
      // 임계는 넘었는데 원본이 없다(구버전 배포본) -> 종전 동작 + 사유 1회 안내
      if (!State.sourcePdfUrl) { this._noticeNoSource(); return false; }
      this._srcBusy = true;
      this._srcProgress(-1);
      try {
        const ab = await this._fetchSourcePdf(State.sourcePdfUrl);
        if (!ab) throw new Error("source download failed");
        State.srcPdfDoc = await PDF.load(ab);
        await this._primeSourceRender();
        MapCtrl.applyTransform();   // 확보 즉시 현재 배율로 크롭 오버레이 요청
        return true;
      } catch (e) {
        State.srcFailed = true;     // 재시도 금지 — 확대할 때마다 재다운로드하지 않는다
        try { Prompt && Prompt.toast && Prompt.toast("원본 도면을 불러오지 못했습니다 — 스냅샷 화질로 표시합니다"); } catch (e2) {}
        return false;
      } finally {
        this._srcBusy = false;
        this._srcProgress(null);
      }
    },

    /** 원본 PDF 다운로드 + 진행률. Content-Length 가 없으면 무한정 표시로 폴백. */
    async _fetchSourcePdf(url) {
      const res = await fetch(Auth.r2 ? Auth.r2(url) : url, { headers: Auth.headers() });
      if (!res.ok) return null;
      const total = Number(res.headers.get("Content-Length") || 0);
      if (!res.body || !res.body.getReader || !(total > 0)) return await res.arrayBuffer();
      const reader = res.body.getReader();
      const chunks = [];
      let got = 0;
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        chunks.push(r.value);
        got += r.value.length;
        this._srcProgress(Math.min(99, Math.round(got * 100 / total)));
      }
      const buf = new Uint8Array(got);
      let off = 0;
      for (const c of chunks) { buf.set(c, off); off += c.length; }
      return buf.buffer;
    },

    /* ════════════════════════════════════════════════════════════════
       [멀티유저 동시작업 충돌 방지 — 낙관적 잠금 + 자동 병합]
       두 명 이상이 같은 구역 도면을 동시에 편집할 때, 나중 저장이 먼저
       저장을 통째로 덮어쓰는 데이터 유실을 막는다.
       · 저장(PATCH) 시 base_version(내가 불러온 버전)을 함께 전송
       · 서버 버전이 다르면 409 + 서버 최신본(current) 반환
       · 클라이언트는 서버 최신 pins/zones 와 내 로컬 변경분을 id 기준으로
         병합(양쪽 모두 보존)한 뒤, 서버 최신 버전으로 1회 재시도
       ════════════════════════════════════════════════════════════════ */

    /** id(또는 보조키) 기준 두 배열 병합 — 서버본 기준에 내 추가/수정분을 덮어쓰기 union */
    _mergeById(serverArr, localArr, pick) {
      const keyOf = (o) => (o && (o.id != null ? "id:" + o.id
        : (o.pin_id != null ? "pid:" + o.pin_id
        : (o.name != null && o.x != null ? "nx:" + o.name + ":" + o.x + ":" + o.y : null))));
      const map = new Map();
      (Array.isArray(serverArr) ? serverArr : []).forEach((o) => { const k = keyOf(o); if (k) map.set(k, o); else map.set("anon:" + map.size, o); });
      // 내 로컬 항목으로 덮어쓰기(=내가 최근 편집한 내용 우선) + 서버에만 있던 항목 보존
      //   pick(서버본, 로컬) 이 있으면 같은 키의 승자를 그 함수가 정한다(핀 = PinSeries.newer LWW, _mergePins).
      (Array.isArray(localArr) ? localArr : []).forEach((o) => { const k = keyOf(o); if (k) map.set(k, (pick && map.has(k)) ? pick(map.get(k), o) : o); else map.set("anon:" + map.size + "L", o); });
      return Array.from(map.values());
    },

    /** 409 충돌 시: 서버 최신본(current)과 현재 State 의 핀/구역을 병합하여 State 갱신.
     *  반환: 병합된 {pins, zones, version} (version 은 서버 최신값) */
    _mergeConflict(current) {
      let srvPins = [], srvZones = [];
      try { srvPins = JSON.parse(current.pins || "[]"); } catch (e) { srvPins = []; }
      try { srvZones = JSON.parse(current.zones || "[]"); } catch (e) { srvZones = []; }
      this._pinsStamp();   // [WO 20260930-lww] 병합 직전 — _markDirty 를 아직 안 부른 편집(일괄 사진 등록 도중 등)도 로컬 수정으로 찍는다
      // [WO 20260929-bulkdel] 핀은 _mergePins(삭제 부활 방지) — 기준은 내가 알던 서버 버전, 병합 후엔 방금 받은 서버본
      const mergedPins  = this._mergePins(srvPins, State.pins || [], State.pinBaseIds, Object.keys(this._pinTombstones()));
      const mergedZones = this._mergeById(this._live(srvZones), State.zones || []);
      State.pins  = mergedPins;
      State.zones = mergedZones;
      State.pinBaseIds = this._pinIds(srvPins);
      State.depVersion = (current.version != null ? Number(current.version) : State.depVersion);
      // 화면 즉시 반영(다른 사람이 추가한 핀/구역도 보이도록)
      try { UI.renderPinList(); UI.renderPinsOnMap(); } catch (e) {}
      try { if (typeof Zones !== "undefined") { Zones.render(); Zones.renderList(); } } catch (e) {}
      return { pins: mergedPins, zones: mergedZones, version: State.depVersion };
    },

    /* ── [설계서 D4 · H6] 다른 사람 변경 보기 — 경량 버전 폴링 ─────────────────────────────
       종전: 배포본 재조회는 수동 #btn-reload-deploy 뿐 → A 의 추가·삭제를 B 가 모른 채 같은 자리에 중복 배치.
       편집 화면(designer + 배포본 열림) · 탭 보임 · 온라인일 때만 서버 버전(?fields=version)을 보고,
       내 버전보다 크면 배포본을 받아 409 병합과 **같은 SoT(_mergeConflict → _mergePins)** 로 합친다
       (내 미저장분 보존 · 남의 삭제 반영(tombstone/pinBaseIds) · 동시 번호 재채번). 도면은 다시 싣지 않는다.
       타이머는 앱 전체에 1개(도면별 타이머 없음 → 전환 누수 0). 전환 중 늦게 온 응답은 depId·로드세대로 폐기. */
    // 20초: 설계서 D4 산식 — 3인×8h×(3600/20)=4,320 req/일(CF Workers 무료 100k/일의 4.3%),
    //   "1시간 방치 후 같은 자리 배치"를 막기에 충분히 짧고, 편집 흐름을 방해하지 않을 만큼 길다.
    LIVE_POLL_MS: 20000,
    _livePollTimer: null,
    _livePollBusy: false,
    _livePollActive() {
      return document.visibilityState !== "hidden" && navigator.onLine !== false;
    },
    /** 지금 반영하면 사용자의 손을 끊는 순간 — 이 틱은 건너뛴다(다음 틱에 반영). */
    _liveEditingNow() {
      if (this.autoSaving) return true;                                        // 저장 중
      if (State.movingPinId != null || State.pinEditUnlocked != null) return true; // 드래그·이동 대기
      if (State.editingPinId != null) return true;                             // 핀 폼 편집 중
      const a = document.activeElement;
      if (a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/i.test(String(a.tagName || "")))) return true; // 패널 입력 포커스
      return false;
    },
    _livePollStart() {
      if (this._livePollTimer != null || !this._livePollActive()) return;
      this._livePollTimer = setInterval(() => { this._liveTick(); }, this.LIVE_POLL_MS);
    },
    _livePollStop() {
      if (this._livePollTimer == null) return;
      clearInterval(this._livePollTimer);
      this._livePollTimer = null;
    },
    /** visibilitychange · online · offline 공용 — 숨김/오프라인이면 정지, 다시 보이면 즉시 1회 확인 후 재개. */
    async _onLiveVisibility() {
      if (!this._livePollActive()) { this._livePollStop(); return; }
      this._livePollStart();
      await this._liveTick();
    },
    _livePollInit() {
      if (this._livePollBound) return;
      this._livePollBound = true;
      const h = () => { this._onLiveVisibility(); };
      document.addEventListener("visibilitychange", h);
      window.addEventListener("online", h);
      window.addEventListener("offline", h);
      this._livePollStart();
    },
    /** 틱 1회. 반환(진단용): hidden|idle|busy|editing|same|stale|error|merged:N */
    async _liveTick() {
      if (!this._livePollActive()) { this._livePollStop(); return "hidden"; }
      // [WO 20261001-viewreq] 요청함 배지 — 새 폴링 없이 이 틱에 얹는다(도면 미로드·편집 중이어도 배지는 갱신)
      if (typeof Requests !== "undefined" && Requests.refresh) Requests.refresh();
      if (State.mode !== "designer" || !State.autoSaveDepId) return "idle";
      if (this._livePollBusy) return "busy";
      if (this._liveEditingNow()) return "editing";
      const depId = State.autoSaveDepId, seq = this._loadSeq;
      const url = "/tables/deployments/" + encodeURIComponent(depId);
      const newer = (v) => v != null && Number(v) > Number(State.depVersion != null ? State.depVersion : 0);
      this._livePollBusy = true;
      try {
        const r = await fetch(url + "?fields=version", { headers: Auth.headers() });
        if (!r.ok) return "error";
        const head = await r.json();
        if (!head || head.deleted || !newer(head.version)) return "same";
        const r2 = await fetch(url, { headers: Auth.headers() });
        if (!r2.ok) return "error";
        const dep = await r2.json();
        // await 사이에 도면 전환·새 로드·저장·편집이 시작됐으면 이 응답은 버린다(다음 틱이 다시 본다)
        if (State.autoSaveDepId !== depId || !this._isCurrentLoad(seq) || this._liveEditingNow()) return "stale";
        if (!dep || dep.deleted || !newer(dep.version)) return "same";
        const before = new Set(this._pinIds(State.pins));
        this._mergeConflict(dep);
        const after = new Set(this._pinIds(State.pins));
        let n = 0;
        after.forEach((k) => { if (!before.has(k)) n++; });
        before.forEach((k) => { if (!after.has(k)) n++; });
        // 스팸 방지: 틱당 최대 1회 · 실제로 보이는 변화(핀 추가/삭제)가 있을 때만
        if (n && typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("다른 사용자 변경 " + n + "건 반영");
        return "merged:" + n;
      } catch (e) {
        return "error";
      } finally {
        this._livePollBusy = false;
      }
    },

    /** 배포본 PATCH(낙관적 잠금) — 409면 1회 병합 후 재시도.
     *  buildBody(): 호출 시점의 현재 State 로 payload 를 만드는 함수(병합 후 재생성용).
     *  반환: { ok, rec?, conflictMerged? } */
    async _patchDeployment(depId, buildBody) {
      let sentPins = null;   // [WO 20260929-bulkdel] 성공 시 이 목록이 곧 서버의 새 기준(State.pinBaseIds)
      // [WO 20261001-bulkreauth] 이 배포본에 아직 안 올라간 일괄삭제가 있으면 X-Reauth 를 싣는다.
      //   재인증이 만료됐으면 저장 전에 다시 묻고, 실패·취소면 보내지 않는다(서버 403 도 1회 재인증 후 재시도).
      const bulk = this._bulkReauthDep != null && this._bulkReauthDep === depId && typeof Auth !== "undefined" && !!Auth.ensureReauth;
      if (bulk && !(await Auth.ensureReauth())) {
        try { Prompt.toast && Prompt.toast("일괄삭제 저장에는 본인 확인이 필요합니다 — 다시 저장을 눌러 확인하세요", 3600); } catch (e) {}
        return { ok: false, status: 403, reauth: true };
      }
      const send = async () => {
        const body = buildBody();
        sentPins = null;
        if (typeof body.pins === "string") { try { sentPins = JSON.parse(body.pins); } catch (e) { sentPins = null; } }
        body.base_version = (State.depVersion != null ? State.depVersion : 0);
        const res = await fetch("/tables/deployments/" + encodeURIComponent(depId), {
          method: "PATCH", headers: Auth.headers(bulk ? Auth.reauthHeader() : undefined), body: JSON.stringify(body)
        });
        return res;
      };
      let res = await send();
      if (bulk && res.status === 403) {
        let j = null; try { j = await res.clone().json(); } catch (e) {}
        if (j && j.reauth_required) { Auth.clearReauth(); if (await Auth.ensureReauth()) res = await send(); }
      }
      if (res.status === 409) {
        // 다른 사용자가 먼저 저장 → 병합 후 1회 재시도
        let j = null; try { j = await res.json(); } catch (e) {}
        if (j && j.current) {
          this._mergeConflict(j.current);
          Prompt && Prompt.toast && Prompt.toast("다른 사용자의 변경을 병합했습니다 — 다시 저장합니다");
          res = await send(); // 병합된 State + 최신 version 으로 재시도
        }
      }
      if (!res.ok) return { ok: false, status: res.status };
      let rec = null; try { rec = await res.json(); } catch (e) {}
      if (rec && rec.version != null) State.depVersion = Number(rec.version); // 성공 → 새 버전 반영
      if (Array.isArray(sentPins)) State.pinBaseIds = this._pinIds(sentPins);
      if (bulk) this._bulkReauthDep = null;   // 일괄삭제가 서버에 반영됨
      return { ok: true, rec };
    },

    _buildSavePayload(pagesData, sourceMeta) {
      // 🔴 [WP1 · H7] 저장 = 항상 원본(페이지 기준 %) 좌표 그대로. 구역 crop 은 "보기 창"일 뿐 저장 좌표계가 아니다.
      //   종전: 창(crop) 구역에서 저장하면 핀/영역/주석을 크롭 기준 %로 바꾸고 크롭 밖 항목을 빼서 보냈다 —
      //   창 구역은 원본과 **같은 deployment_id** 라 그 PATCH 가 원본 행을 덮어 크롭 밖 핀을 영구 삭제했고,
      //   재로드 시 crop 이 한 번 더 적용돼 좌표가 이중 변환됐다(역변환 호출부 0). 스냅샷도 전체 페이지(_snapshotPages).
      const deployablePins = State.pins.map(p => {
        const q = Object.assign({}, p);
        if (q.videoUrl) { delete q.videoUrl; q.localOnly = true; }
        // [핵심 버그 수정] blob: 임시 미리보기 URL 은 그 세션에서만 유효 →
        //   서버/배포본에 저장하면 재접속 시 죽은 blob 으로 "이미지를 불러올 수 없습니다".
        //   localPreview(blob) 와 일시 상태 플래그는 직렬화에서 제거한다.
        //   (실제 이미지는 imageId(클라우드) 또는 pendingOpId(동기화 대기)로만 보존)
        if (typeof q.localPreview === "string" && q.localPreview.indexOf("blob:") === 0) delete q.localPreview;
        if (typeof q.imageUrl === "string" && q.imageUrl.indexOf("blob:") === 0) delete q.imageUrl;
        delete q.uploading;
        return q;
      });
      return this._deploymentBody({
        title: State.fileName || "도면", fileName: State.fileName || "",
        pins: deployablePins, zones: State.zones || [], annotations: State.annotations || [],
        checkboardStart: State.checkboardStart
      }, pagesData, sourceMeta);
    },

    /** 배포본 저장 본문 형식의 SoT — 도면 저장(_buildSavePayload)과 영역 복사본 생성이 공유한다. */
    _deploymentBody(o, pagesData, sourceMeta) {
      const body = {
        title:       o.title || "도면",
        file_name:   o.fileName || "",
        pins:        JSON.stringify(o.pins || []),
        zones:       JSON.stringify(o.zones || []),
        annotations: JSON.stringify(o.annotations || [])
      };
      // [WO 20260917 멀티유저 ①] 체크보드 시작번호(페이지별) 영속화 — 항상 함께 보낸다(작아서
      //   조건부 전송할 이유가 없음). 서버는 컬럼 자체가 없던 구버전에서도 부분갱신 규칙(§merged)
      //   대로 안전히 저장한다. 값이 비어도 "{}" 로 보내 구버전(값 없음=1) 폴백을 그대로 재현.
      body.checkboard_start = JSON.stringify(o.checkboardStart || {});
      if (pagesData && pagesData.length) {
        body.drawing_data = pagesData[0];
        body.pages_data   = JSON.stringify(pagesData);
      }
      // [P14] 원본 PDF 위치 + 실제 저장 픽셀. 있을 때만 실어 보낸다 —
      //   미전송 시 서버가 기존 값을 그대로 보존하므로(부분 갱신) 기존 배포본이 깨지지 않는다.
      if (sourceMeta) body.source_meta = sourceMeta;
      // [WO 20260930-WP3] 소속 프로젝트 — 서버가 POST 시 기록해 프로젝트 단위 쓰기 권한의 기준으로 쓴다
      //   (PATCH 에 실려도 서버는 무시 — 귀속은 생성 시 1회). o.projectId 로 명시(flush 의 draft 키 등) 가능.
      const pid = (o.projectId !== undefined) ? o.projectId
        : ((typeof Projects !== "undefined" && Projects.currentProject) ? Projects.currentProject.id : null);
      if (pid) body.project_id = String(pid);
      return body;
    },

    async _snapshotPages() {
      // [P14] 이전 도면의 실측 픽셀이 남아 다음 저장에 잘못 붙지 않게 초기화(SoT 오염 방지)
      try { PDF.lastSnapshotDims = null; } catch (e) {}
      if (State.fileType === "pdf" && State.pdfDoc) {
        // [WP1 · H7] 구역 crop 과 무관하게 항상 전체 페이지 — 창 구역은 원본과 같은 배포본 행을 공유한다.
        return await PDF.snapshotAllPages(State.pdfDoc);
      } else if (State.fileType === "image") {
        // 🔴 [WO 20260929-lossless] 종전: 화면 <img> 를 긴 변 2000px·JPEG 0.8 로 다시 그려 저장했다 →
        //   ① PNG/JPG 원본 업로드가 매 저장마다 축소·재압축됐고 ② 배포본/복원 draft(이미 스냅샷)도 편집할 때마다
        //   2000px JPEG 로 한 번 더 뭉개졌으며(prod dep_muksj6py = 2000×667) ③ 여러 페이지 도면은 1쪽만 남았다.
        //   → 원본 바이트를 그대로 싣는다(재압축 0). 순서: 방금 올린 원본 파일 → 이미 저장된 페이지 전부.
        if (State.fileData && typeof Blob !== "undefined" && State.fileData instanceof Blob) {
          return [await this._blobToDataUrl(State.fileData)];
        }
        if (Array.isArray(State.viewerPages) && State.viewerPages.length) {
          const out = [];
          for (const p of State.viewerPages) {
            if (typeof p !== "string" || p.indexOf("blob:") === 0) continue;
            out.push(await this._pageAsDataUrl(p));
          }
          if (out.length) return out;
        }
        // 최후 폴백(원본 참조가 전혀 없는 화면): 자연 크기 그대로 무손실 PNG — 축소·JPEG 금지
        const imgEl = UI.$("map-image");
        if (!imgEl || !imgEl.naturalWidth) return [];
        const off = document.createElement("canvas");
        off.width = imgEl.naturalWidth; off.height = imgEl.naturalHeight;
        off.getContext("2d").drawImage(imgEl, 0, 0);
        return [off.toDataURL("image/png")];
      }
      return [];
    },

    _blobToDataUrl(blob) {
      return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(r.error || new Error("read failed"));
        r.readAsDataURL(blob);
      });
    },
    /** 저장된 페이지(dataURL 또는 R2 URL) → 원본 바이트 그대로의 dataURL. draft 는 오프라인 표시용이라
     *  URL 이 아니라 바이트를 담아야 한다(미캐시 R2 URL 은 오프라인에서 안 뜬다). 한 번 받은 것은 재사용.
     *  못 받으면 URL 그대로 — 재압축으로 대체하지 않는다(_uploadPagesToR2 는 URL 을 재업로드하지 않는다). */
    _pageDataCache: null,
    async _pageAsDataUrl(p) {
      if (/^data:/i.test(p)) return p;
      this._pageDataCache = this._pageDataCache || new Map();
      if (this._pageDataCache.has(p)) return this._pageDataCache.get(p);
      try {
        const r = await fetch(Auth.r2 ? Auth.r2(p) : p, { headers: Auth.headers ? Auth.headers() : {} });
        if (!r.ok) return p;
        const d = await this._blobToDataUrl(await r.blob());
        if (this._pageDataCache.size > 8) this._pageDataCache.clear();
        this._pageDataCache.set(p, d);
        return d;
      } catch (e) { return p; }
    },

    _setSaveIndicator(stateStr) {
      // stateStr: 'saving' | 'saved' | 'error' | 'offline'
      const el = UI.$("autosave-indicator");
      if (!el) return;
      el.classList.remove("hidden", "saving", "saved", "error", "offline", "just-saved");
      el.classList.add(stateStr);
      const map = {
        saving:  "저장 중…",
        saved:   "저장됨",                  // [P3] 자동저장 OFF 정책 — '자동 저장됨'은 사실과 다름
        error:   "저장 실패 — 재시도",
        offline: "오프라인 — 로컬 보관"
      };
      const t = UI.$("autosave-text");
      if (t) t.textContent = map[stateStr] || "";
      // [P3] 저장 완료를 놓치지 않도록 몇 초간 강조(모바일은 텍스트가 숨겨져 점/링으로만 보인다)
      try { clearTimeout(this._saveFlashT); } catch (e) {}
      if (stateStr === "saved") {
        el.classList.add("just-saved");
        this._saveFlashT = setTimeout(() => { try { el.classList.remove("just-saved"); } catch (e) {} }, 2600);
      }
    },

    /** #3: 도면 로드 직후 — 구역 보장 + 즉시 자동저장(스냅샷) + 구역에 도면 연결 */
    async _afterDrawingLoaded() {
      if (State.mode !== "designer") return;
      // [P0-2] '새 도면이 실제로 올라온' 유일한 지점 — 여기서 dirty 를 확정한다.
      //   아래 try 안(스냅샷/구역보장)에서 예외가 나도 미저장 표시는 반드시 남도록 try 밖에 둔다.
      this._dirtyPages = true; this._markDirty();
      try {
        // 1) 🔴 [WO 20260928·마스터 확정] 구역 자동생성 금지.
        //    옛 Projects.ensureDeck() 는 구역이 0개면 **"구역 1" 이라는 자동 이름** 구역을 만들어
        //    "도면 등록만으로 구역이 생기는" 상태를 만들었다(마스터가 두 번 지적한 바로 그 지점).
        //    이제 **이미 존재하는** 구역만 컨텍스트로 채택한다. 0개면 deck = null 로 두고,
        //    첫 영역 지정 시 Projects.createDeckFromLoadedDrawing() 이 배포본+구역+crop 을 묶어 만든다.
        let deck = null;
        if (typeof Projects !== "undefined" && Projects.currentProject) {
          deck = Projects.currentDeck || (Projects.decks && Projects.decks[0]) || null;
          if (deck && Projects.currentDeck !== deck) Projects.currentDeck = deck;
        }
        // 2) 도면 교체 지원: 구역에 기존 도면이 있으면 그 배포본을 덮어써서 교체(고아 방지),
        //    없으면 새 배포본 생성. (구역당 도면 1개 유지 — 구역을 여러 개 만들면 도면 다수 등록)
        // [마스터: 자동저장 OFF] 도면 업로드해도 서버 즉시저장 안 함 → 로컬 보존 + dirty.
        //   실제 서버 생성/교체·구역연결은 '저장' 버튼(_saveNow)에서 수행.
        const isReplace = !!(deck && deck.deployment_id);
        if (isReplace) {
          State.autoSaveDepId = deck.deployment_id;     // 저장 시 이 배포본을 PATCH(교체)
        } else {
          State.autoSaveDepId = null;
          if (deck) this._pendingDeckLink = { deckId: deck.id, deck };  // 저장 시 생성+연결
        }
        await this._saveDraftLocal(await this._snapshotPages());   // 도면 즉시 로컬 보존(소실 방지) — 원본 PDF 도 함께(_draftSrcFields)
        this._pruneDraftSources();                                 // 이전 도면의 원본 중 더는 안 쓰는 것 정리(비차단)
        // 🔴 [WO 20260928] deck 이 null(구역 0개)일 때도 반드시 다시 그려야 한다 —
        //   #side-tree 의 빈 상태 안내가 "도면 없음" → "도면 있음 + 구역 0" 분기로 갈아타는 지점이다.
        //   (여기서 건너뛰면 도면을 올렸는데 사이드바가 옛 안내에 머물러 다음 행동을 알 수 없다)
        try { if (typeof Projects !== "undefined" && Projects._renderDecks) Projects._renderDecks(); } catch (e) {}
        if (deck) {
          Prompt.toast && Prompt.toast((isReplace ? "도면 교체됨" : "도면 등록됨") + " — '저장' 버튼을 눌러 반영하세요 (구역: " + deck.name + ")");
        } else {
          // 🔴 [WO 20260928 · 라이브 실측] 375×812 에서 #side-tree 는 바텀시트 안(y≈1045px = 화면 밖)이라
          //   안내를 그려도 사용자는 보지 못한다("도면만 올라가고 다음 행동을 모르는" 상태 = 빈 화면과 동급).
          //   구역이 0개일 때만 그 시트를 열어 안내를 화면 안으로 올린다. 데스크톱은 무해(무변화).
          this._openSidebarSheet();
          Prompt.toast && Prompt.toast("도면이 등록됐습니다 — 도면에서 영역을 드래그하면 그 부분이 '구역'이 됩니다", 5200);
        }
      } catch (e) { /* 비치명적 */ }
    },

    /** [WO 20260928] 모바일 사이드 시트(트리)를 연다.
     *  🔴 새 UI 0 — 상태 SoT 인 body.sidebar-open 과 기존 메뉴 칩을 그대로 쓴다.
     *  해당 CSS 는 @media (max-width:760px) 안에만 있어 데스크톱에서는 아무 효과가 없다(실측 확인). */
    _openSidebarSheet() {
      try {
        document.body.classList.add("sidebar-open");
        ["mnav-menu", "tq-menu"].forEach((id) => { const b = UI.$(id); if (b && b.classList) b.classList.add("active"); });
        const chip = document.querySelector('.mobile-dock [data-act="menu"]');
        if (chip && chip.classList) chip.classList.add("active");
      } catch (e) {}
    },

    /** [WO 20260928] 사이드 시트를 닫는다 — 도면 위 드래그(크롭 지정)를 시작할 때 필수.
     *  시트는 화면 하단 절반을 덮으므로, 열린 채로 드래그를 요구하면 사용자는 도면을 만질 수 없다.
     *  🔴 시트를 여는 쪽(_openSidebarSheet)과 짝을 이루는 같은 SoT(body.sidebar-open)만 쓴다. */
    _closeSidebarSheet() {
      try {
        document.body.classList.remove("sidebar-open");
        ["mnav-menu", "tq-menu"].forEach((id) => { const b = UI.$(id); if (b && b.classList) b.classList.remove("active"); });
        const chip = document.querySelector('.mobile-dock [data-act="menu"]');
        if (chip && chip.classList) chip.classList.remove("active");
      } catch (e) {}
    },

    /** [WO 20260928] 로드된 도면을 서버 배포본(deployments 행)으로 확정하고 그 id 를 돌려준다.
     *  이미 있으면 그대로 재사용한다(중복 배포본 0).
     *  🔴 새 저장 경로 금지 — 기존 _createInitialSave()(R2 업로드 + POST /tables/deployments)를 그대로 쓴다.
     *  '도면 등록'이 더는 구역을 만들지 않게 된 뒤, **첫 영역 지정 시점**에 배포본이 필요해져 신설했다
     *  (31_Projects.createDeckFromLoadedDrawing 의 유일한 호출부 — decks.deployment_id 가 가리킬 대상).
     *  @returns {Promise<string|null>} 배포본 id · 실패 시 null(조용한 성공 위장 금지) */
    async _ensureDrawingDeployment() {
      if (State.autoSaveDepId) return State.autoSaveDepId;
      if (!State.fileType) return null;
      await this._createInitialSave();
      return State.autoSaveDepId || null;
    },

    /** ── [마스터 요청] 도면↔구역 연결을 즉시 시도하고, 실패하면 재시도 큐에 넣어
     *  앱이 중지/새로고침돼도 다음 기회에 반드시 연결되도록 보장한다. ── */
    /** [도면 연결 복구] 구역에 연결된 도면이 없을 때 — 도면 목록에서 골라 연결 */
    async offerDeckDrawingLink(deck) {
      if (!deck) return;
      let deps = [];
      try {
        const r = await fetch("/tables/deployments", { headers: Auth.headers() });
        const j = await r.json();
        deps = (j && (j.data || j)) || [];
        if (!Array.isArray(deps)) deps = [];
      } catch (e) { deps = []; }
      const modal = UI.$("deck-link-modal"), list = UI.$("deck-link-list"), sub = UI.$("deck-link-sub");
      if (!modal || !list) return;
      if (sub) sub.textContent = "구역 ‘" + (deck.name || "") + "’에 표시할 도면을 고르세요.";
      if (!deps.length) {
        list.innerHTML = '<div class="psl-empty">등록된 도면이 없습니다.<br>‘도면’ 도구로 먼저 업로드하세요.</div>';
      } else {
        list.innerHTML = deps.map((d) => '<button class="dl-item" data-id="' + d.id + '">' + UI.escapeHtml(d.file_name || d.title || d.id) + '</button>').join("");
      }
      modal.classList.remove("hidden");
      const close = () => modal.classList.add("hidden");
      const cancel = UI.$("deck-link-cancel"); if (cancel) cancel.onclick = close;
      const bd = UI.$("deck-link-backdrop"); if (bd) bd.onclick = close;
      list.querySelectorAll(".dl-item").forEach((b) => {
        b.addEventListener("click", async () => {
          close();
          deck.deployment_id = b.dataset.id;
          try { await this._linkDeckDeployment(deck.id, b.dataset.id, deck); } catch (e) {}
          if (typeof Projects !== "undefined" && Projects._renderDecks) Projects._renderDecks();
          try { await this.loadDeckDrawing(b.dataset.id); } catch (e) {}
          if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("도면 연결됨");
        });
      });
    },
    async _linkDeckDeployment(deckId, depId, deckObj) {
      if (!deckId || !depId) return false;
      const body = {
        name: (deckObj && deckObj.name) || undefined,
        level_no: (deckObj && deckObj.level_no) || null,
        deployment_id: depId
      };
      // 1) 재시도 큐에 먼저 기록(localStorage) — 즉시 성공해도 무해(성공 시 제거)
      this._enqueueDeckLink(deckId, depId, body);
      try {
        const r = await fetch("/api/decks/" + deckId, {
          method: "PUT", headers: Auth.headers(), body: JSON.stringify(body)
        });
        if (r.ok) {
          this._dequeueDeckLink(deckId);   // 성공 → 큐에서 제거
          if (typeof Projects !== "undefined") Projects._renderDecks();
          return true;
        }
      } catch (e) { /* 네트워크 실패 → 큐에 남아 재시도 */ }
      return false;
    },

    _deckLinkKey() { return "wm_deck_link_queue"; },
    _enqueueDeckLink(deckId, depId, body) {
      try {
        const q = JSON.parse(localStorage.getItem(this._deckLinkKey()) || "{}");
        q[deckId] = { deckId, depId, body, ts: Date.now() };
        localStorage.setItem(this._deckLinkKey(), JSON.stringify(q));
      } catch (e) {}
    },
    _dequeueDeckLink(deckId) {
      try {
        const q = JSON.parse(localStorage.getItem(this._deckLinkKey()) || "{}");
        if (q[deckId]) { delete q[deckId]; localStorage.setItem(this._deckLinkKey(), JSON.stringify(q)); }
      } catch (e) {}
    },
    /** 앱 시작/온라인 복귀 시: 미연결 도면↔구역 연결을 재시도해 누락을 복구 */
    async _flushDeckLinkQueue() {
      let q = {};
      try { q = JSON.parse(localStorage.getItem(this._deckLinkKey()) || "{}"); } catch (e) { return; }
      const items = Object.values(q || {});
      if (!items.length) return;
      for (const it of items) {
        try {
          const r = await fetch("/api/decks/" + it.deckId, {
            method: "PUT", headers: Auth.headers(), body: JSON.stringify(it.body)
          });
          if (r.ok) this._dequeueDeckLink(it.deckId);
        } catch (e) { /* 다음 기회에 재시도 */ }
      }
      if (typeof Projects !== "undefined" && Projects.loadDecks && Projects.currentProject) {
        try { await Projects.loadDecks(); } catch (e) {}
      }
    },

    /** 구역 선택 시 연결된 도면(배포 스냅샷)을 불러와 화면(디자이너 편집)에 표시 */
    async loadDeckDrawing(deploymentId) {
      if (!deploymentId) {
        // 서버 배포본 ID 가 없어도 로컬 draft 가 있으면 복원 시도(오프라인 신규 등록분)
        return await this._restoreDraftLocal();
      }
      const seq = this._beginLoad();   // 🔴 [WO 20260928-pinloss] 늦게 도착한 이전 로드가 이 결과를 덮지 못하게
      const dkey = this._draftKey();   // await 전에 확정 — 로드 중 구역이 바뀌어도 이 구역의 draft 만 본다
      // 🔴 서버 fetch **전에** 읽는다 — 재접속 자동업로드(_flushDirtyDrafts)가 fetch 도중 draft 를 clean 으로
      //   바꿔도 이 로드는 작업분을 놓치지 않는다(서버본이 더 새로우면 _draftVsServer 가 id 병합).
      const draft = await this._readDirtyDraft(dkey, deploymentId);
      try {
        // [오프라인 작업지시서 ] 오프라인이면 서버 fetch 대신 번들(IndexedDB)에서 도면 복원
        let dep = null;
        if (!navigator.onLine && typeof OfflineLoad !== "undefined") {
          dep = await OfflineLoad.deployment(deploymentId);
          if (!dep) { await this._restoreDraftLocal(); return; }
        } else {
          const r = await fetch("/tables/deployments/" + encodeURIComponent(deploymentId), { headers: Auth.headers() });
          if (!r.ok) { await this._restoreDraftLocal(); return; }   // 서버 실패 → 로컬 폴백
          dep = await r.json();
        }
        if (!this._isCurrentLoad(seq)) return;   // 그 사이 다른 구역/모드 로드가 시작됨 → 이 결과는 폐기
        let pages = [];
        try { pages = JSON.parse(dep.pages_data || "[]"); } catch { pages = []; }
        if (!Array.isArray(pages) || pages.length === 0) pages = dep.drawing_data ? [dep.drawing_data] : [];
        if (!pages.length) { await this._restoreDraftLocal(); return; }

        this._releasePdfDocs();
        State.reset();
        State.fileType = "image";       // 스냅샷은 이미지(dataURL)로 보관됨
        this._applySourceMeta(dep);     // [P14] 원본 PDF 위치/실측 픽셀(구버전이면 전부 null)
        State.viewerPages = pages;
        State.pdfPage = 1;
        State.fileName = dep.file_name || dep.title || "구역 도면";
        UI.text("file-name-label", State.fileName);
        UI.$("drop-hint").classList.add("hidden");
        UI.$("pdf-canvas").classList.add("hidden");
        try { State.pins  = this._pinsSeen(this._live(JSON.parse(dep.pins  || "[]"))); } catch { State.pins = []; }
        State.pinTombstones = {}; State.pinBaseIds = this._pinIds(State.pins);   // [WO 20260929-bulkdel] 이 서버 버전이 병합 기준
        try { State.zones = this._live(JSON.parse(dep.zones || "[]")); } catch { State.zones = []; }
        try { State.annotations = this._live(JSON.parse(dep.annotations || "[]")); } catch { State.annotations = []; }
        // [WO 20260917 멀티유저 ①] 페이지별 체크보드 시작번호 복원 — 컬럼 없는 구버전 배포본은
        //   dep.checkboard_start 가 undefined/null → {} → _checkboardStart()가 종전대로 1 반환.
        // [WO 20260929 addendum] _normalizeCheckboardStart() 로 계열별 중첩 형식({checkboard,content})
        //   으로 정규화(§10 SoT — 네 로드 지점이 각자 파싱하면 형식이 갈라진다).
        try { State.checkboardStart = this._normalizeCheckboardStart(JSON.parse(dep.checkboard_start || "{}")); } catch { State.checkboardStart = this._normalizeCheckboardStart(null); }
        // 🔴 [WO 20260928-pinloss] 저장 안 한 로컬 작업분(dirty draft)이 있으면 서버본 위에 복원.
        //   렌더(_r0) 전에 끝내야 첫 화면부터 draft 핀이 보이고, 이후 저장/자동보관이 draft 를 빈 목록으로 덮지 않는다.
        this._applyDirtyDraft(draft, dkey, dep.version);

        const imgEl = UI.$("map-image");
        // ponytail: fired flag prevents double-fire when image is already browser-cached
        let _ld0 = false;
        const _r0 = () => {
          if (_ld0) return; _ld0 = true;
          this._showMapViewport();
          UI.renderPinList(); UI.renderPinsOnMap();
          if (typeof Zones !== "undefined") { Zones.render(); Zones.renderList(); }
        };
        this._armDisplay();   // [WO 20260929-fitrace2] _r0→_showMapViewport 가 settle
        imgEl.onload = _r0;
        // [오프라인 도면연동] R2 URL 이미지가 오프라인(미캐시)으로 로드 실패하면
        //   로컬 draft(원본 dataURL)로 폴백하여 도면을 끊김없이 표시.
        // [P52 결함수정] 로컬 draft 도 없으면(전형: R2 객체 404/403) 종전엔 여기서 아무 일도
        //   안 일어나 핀·목록·구역이 영구히 렌더되지 않았다(State.pins 는 채워졌는데 화면은 빈 채로
        //   조용히 실패 — 마스터 신고: "체크보드 모드에서 핀 목록은 생기는데 마커가 안 생긴다").
        //   폴백 실패 시에도 _r0() 을 호출해 뷰포트+핀+구역만이라도 표시하고, 이미지만 못 불러왔다고
        //   정직하게 알린다(가짜 성공 표시 금지, §10-no-hardcoding 조용한 실패 금지).
        imgEl.onerror = () => {
          if (/^\/api\/r2\/object\//.test(pages[0] || "")) {
            Promise.resolve(this._restoreDraftLocal()).then((restored) => {
              if (!restored) {
                _r0();
                Prompt && Prompt.toast && Prompt.toast("도면 이미지를 불러오지 못했습니다 — 핀 목록은 정상 표시됩니다");
              }
            });
          } else {
            _r0();
            Prompt && Prompt.toast && Prompt.toast("도면 이미지를 불러오지 못했습니다 — 핀 목록은 정상 표시됩니다");
          }
        };
        imgEl.src = Auth.r2(pages[0]);
        imgEl.classList.remove("hidden");
        if (imgEl.complete && imgEl.naturalWidth) _r0(); // 캐시 히트 시 onload 미발화 대응

        State.autoSaveDepId = deploymentId;       // 이후 자동저장은 이 배포본 갱신
        State.currentDeploymentId = deploymentId;
        State.depVersion = (dep.version != null ? Number(dep.version) : 0); // [충돌방지] 로드 시점 버전 기록
      } catch (e) { await this._restoreDraftLocal(); }   // 네트워크 오류 → 로컬 폴백
    },

    /** 로컬(IndexedDB) draft 로부터 도면+핀+구역 복원 — 서버 실패/오프라인/새로고침 대응 */
    async _restoreDraftLocal(key) {
      try {
        if (typeof SyncQueue === "undefined") return false;
        const dkey = key || this._draftKey();
        const d = await SyncQueue.loadDraft(dkey);
        if (!d || !d.pages || !d.pages.length) return false;
        // 🔴 [WO 20260929-lossless] draft 에 원본 PDF 가 딸려 있으면 스냅샷(이미지)이 아니라 **원본 PDF 로** 복원한다.
        //   종전엔 항상 이미지로 복원(fileData 소실) → 이후 저장이 원본 없이 나가고 스냅샷은 재압축됐다(prod 재현).
        //   await 는 State.reset() 전에 끝낸다(리셋~표시 사이 비동기 틈 0 — 종전 흐름과 같은 구조).
        const srcAb = await this._draftSource(d);
        let srcDoc = null;
        if (srcAb) { try { srcDoc = await PDF.load(srcAb); } catch (e) { srcDoc = null; } }

        this._releasePdfDocs();
        State.reset();
        State.fileType    = "image";          // draft 스냅샷은 dataURL 이미지
        this._applySourceMeta(null);          // [P14] 로컬 draft 에는 원본 PDF 가 없다(명시적 초기화)
        State.viewerPages = d.pages;
        State.pdfPage     = 1;
        State.fileName    = d.fileName || "도면";
        State.pins        = this._pinsSeen(Array.isArray(d.pins)  ? d.pins  : []);
        State.zones       = Array.isArray(d.zones) ? d.zones : [];
        // [WO 20260929-bulkdel] draft 가 기억한 병합 기준·삭제 기록 복원(구버전 draft = 기준 모름 → null)
        State.pinTombstones = {}; this._adoptDraftTombstones(d);
        State.pinBaseIds = Array.isArray(d.basePinIds) ? d.basePinIds.map(String) : null;
        State.annotations = Array.isArray(d.annotations) ? d.annotations : [];
        // [WO 20260917 멀티유저 ①] 로컬 draft 에도 체크보드 시작번호 보존(오프라인 새로고침 대응)
        State.checkboardStart = this._normalizeCheckboardStart(d.checkboardStart); // [WO 20260929 addendum]
        if (d.depId) { State.autoSaveDepId = d.depId; State.currentDeploymentId = d.depId; }
        UI.text("file-name-label", State.fileName);
        UI.$("drop-hint").classList.add("hidden");
        UI.$("pdf-canvas").classList.add("hidden");

        const imgEl = UI.$("map-image");
        let _ld1 = false;
        const _r1 = () => {
          if (_ld1) return; _ld1 = true;
          this._showMapViewport();
          UI.renderPinList(); UI.renderPinsOnMap();
          if (typeof Zones !== "undefined") { Zones.render(); Zones.renderList(); }
        };
        this._armDisplay();   // [WO 20260929-fitrace2] _r1→_showMapViewport 가 settle
        if (srcDoc) {
          // 원본 PDF 복원 — _loadDrawing 의 PDF 표시 경로와 같은 순서(래스터 → 뷰포트 표시)
          State.fileType = "pdf";
          State.fileData = srcAb;
          State.viewerPages = null;
          if (this._srcKeys) this._srcKeys.set(srcAb, { key: d.srcKey, saved: Promise.resolve(true), dims: Array.isArray(d.srcDims) ? d.srcDims : null });
          if (d.srcUrl) State.sourcePdfUrl = d.srcUrl;   // 이미 R2 에 올라간 원본이면 재업로드하지 않는다
          State.pdfDoc = srcDoc; State.pdfPages = srcDoc.numPages; State.pdfPage = 1;
          imgEl.classList.add("hidden");
          UI.$("pdf-canvas").classList.remove("hidden");
          try { await this._renderPdfPage(); } catch (e) {}
          _r1();
        } else {
        imgEl.onload = _r1;
        // [P52 결함수정] 형제 호출부(loadDeckDrawing)와 동일한 결함 — 로컬 draft 이미지가
        //   못 불러와지면(손상/미캐시) 종전엔 아무 렌더도 안 일어났다. 실패해도 핀·구역은 표시.
        imgEl.onerror = () => {
          _r1();
          Prompt && Prompt.toast && Prompt.toast("도면 이미지를 불러오지 못했습니다 — 핀 목록은 정상 표시됩니다");
        };
        imgEl.src = Auth.r2(d.pages[0]);
        imgEl.classList.remove("hidden");
        if (imgEl.complete && imgEl.naturalWidth) _r1();
        }
        if (d.dirty) {
          this._setSaveIndicator(navigator.onLine ? "saving" : "offline");
          // [B4] 미저장(서버 미반영) 상태를 사용자에게 명확히 — 저장버튼 강조 + 구역 '미저장' 배지
          this._markDirty();
          this._markDeckUnsaved(this._deckIdOfKey(dkey), true);
          if (navigator.onLine) setTimeout(() => this._flushDirtyDrafts(), 400);
        }
        Prompt && Prompt.toast && Prompt.toast("로컬에 보관된 도면을 복원했습니다" + (d.dirty ? " (아직 서버에 저장되지 않음 — ‘저장’을 누르세요)" : ""));
        return true;
      } catch (e) { return false; }
    },

    /** draft 키(`projectId::deckId`)에서 deckId 만 추출. 프로젝트 id 에 '::' 가 있어도 안전. */
    _deckIdOfKey(key) {
      const s = String(key || ""); const i = s.lastIndexOf("::");
      if (i < 0) return "";
      const did = s.slice(i + 2);
      return (did && did !== "nodeck") ? did : "";
    },
    /** [WO 20260930-WP3] draft 키(`pid::did`, _draftKey 형식)의 프로젝트 id — 없으면 "" (_deckIdOfKey 의 짝) */
    _projectIdOfKey(key) {
      const s = String(key || ""); const i = s.lastIndexOf("::");
      const pid = i < 0 ? "" : s.slice(0, i);
      return (pid && pid !== "noproj") ? pid : "";
    },

    /** 🔴 [WO 20260928-pinloss] 도면 로드 세대 번호 — 서버본 로더(loadDeckDrawing/loadLatestDeployment)는
     *  await 사이에 다른 로드가 시작되면(허브 구역 클릭 = openApp 의 자동 로드 + selectDeck 동시 발화)
     *  늦게 도착한 쪽이 State.pins 를 엉뚱한 구역의 서버본으로 덮었다. 마지막에 시작한 로드만 State 를 쓴다. */
    _loadSeq: 0,
    _beginLoad() { this._settleDisplay(false); return ++this._loadSeq; },
    _isCurrentLoad(seq) { return seq === this._loadSeq; },

    /** 🔴 [WO 20260929-fitrace2] "도면이 화면에 표시됐다" 신호(SoT) — 로더가 이미지를 걸 때 arm,
     *  _showMapViewport()(zoom=1/pan=0 리셋 + 뷰포트 표시)가 끝나면 true 로 settle, 새 로드가 시작되면
     *  (_beginLoad) 이전 대기를 false 로 settle 한다. 표시 후 줌을 잡아야 하는 호출부(구역 크롭 맞춤)는
     *  img.complete 가 아니라 이 신호를 기다린다 — 실브라우저 실측: data: URL 도면은 img.complete 가
     *  load 이벤트(_r0→_showMapViewport)보다 **먼저** true 가 되어, 숨은 뷰포트(0×0)에서 fitZone 이
     *  조용히 무시되고 직후 _showMapViewport 가 identity 로 덮었다(prod dep_muksj6py 재현).
     *  대기 중인 표시가 없으면 즉시 true(이미 화면에 있는 도면). */
    _displayWait: null,
    _displayResolve: null,
    _armDisplay() {
      if (this._displayResolve) return;   // 같은 로드의 폴백 경로(_restoreDraftLocal)는 기존 대기를 이어 쓴다
      this._displayWait = new Promise((res) => { this._displayResolve = res; });
    },
    _settleDisplay(ok) {
      const res = this._displayResolve;
      this._displayResolve = null; this._displayWait = null;
      if (res) res(!!ok);
    },
    whenDisplayed() { return this._displayWait || Promise.resolve(true); },

    /** 🔴 [WO 20260928-pinloss] 이 구역(key)의 **저장 안 한** 로컬 작업분(dirty draft)을 읽는다.
     *  다른 배포본을 기준으로 만든 draft(depId 불일치)는 이 서버본에 얹지 않는다(엉뚱한 도면에 핀 이식 금지). */
    async _readDirtyDraft(key, depId) {
      if (!key || typeof SyncQueue === "undefined" || !SyncQueue.loadDraft) return null;
      let d = null;
      try { d = await SyncQueue.loadDraft(key); } catch (e) { return null; }
      if (!d || !d.dirty) return null;
      if (d.depId && depId && String(d.depId) !== String(depId)) return null;
      return d;
    },

    /** 🔴 [WO 20260928-pinloss] 서버본 vs 로컬 draft 충돌 규칙 — **단일 출처**.
     *  화면 복원(_applyDirtyDraft)과 온라인 복귀 업로드(_flushDirtyDrafts)가 같은 규칙을 쓴다(갈라지면 한쪽이 핀을 잃는다).
     *  ① draft 가 기준으로 삼은 서버 버전(baseVer) == 지금 서버 버전 → 그 사이 아무도 저장 안 함 → draft 그대로
     *     (로컬에서 지운 핀이 서버본에서 되살아나지 않는다)
     *  ② 서버가 더 새롭거나 기준 버전을 모름(구버전 draft) → id 병합: 서버에만 있는 항목 보존 + 같은 id 는 draft 우선 */
    _draftVsServer(d, srvPins, srvZones, srvVer) {
      const same = d && d.baseVer != null && srvVer != null && Number(d.baseVer) === Number(srvVer);
      const dPins = Array.isArray(d && d.pins) ? d.pins : [];
      const dZones = Array.isArray(d && d.zones) ? d.zones : [];
      return same
        ? { pins: dPins, zones: dZones }
        // [WO 20260929-bulkdel] 핀은 _mergePins — draft 의 tombstone(deletedPins)·기준 id(basePinIds)로 삭제 부활 차단
        : { pins: this._mergePins(srvPins, dPins, d && d.basePinIds, d && d.deletedPins), zones: this._mergeById(this._live(srvZones || []), dZones) };
    },

    /** 🔴 [WO 20260928-pinloss] 서버본을 State 에 올린 직후 호출 — dirty draft 가 있으면 그 작업분을 화면에 복원.
     *  종전엔 '미저장' 배지만 뜨고 핀은 서버본(0개)으로 그려졌고, 이어서 '저장'/다음 편집이 빈 목록으로
     *  draft 를 덮어 작업분이 영구 소실됐다(라이브 재현: 체크보드 핀 → 모드 전환 → 핀 사라짐 → 저장 → draft 0개). */
    _applyDirtyDraft(d, key, srvVer) {
      if (!d) return false;
      const m = this._draftVsServer(d, State.pins, State.zones, srvVer);
      State.pins = m.pins;
      State.zones = m.zones;
      this._adoptDraftTombstones(d);   // [WO 20260929-bulkdel] 저장 전 지운 핀 기록 유지(다음 409 병합에서도 부활 금지)
      if (Array.isArray(d.annotations)) State.annotations = d.annotations;
      if (d.checkboardStart && typeof d.checkboardStart === "object") State.checkboardStart = this._normalizeCheckboardStart(d.checkboardStart); // [WO 20260929 addendum]
      this._markDirty();                                   // 저장 버튼 활성 — 서버에 아직 없다
      this._markDeckUnsaved(this._deckIdOfKey(key), true);
      return true;
    },

    /** [B4] 로컬에만 있고 서버 미저장인 구역 id 집합 — 사이드바 '미저장' 배지의 단일 출처 */
    _unsavedDecks: {},
    isDeckUnsaved(deckId) { return !!(deckId && this._unsavedDecks[deckId]); },
    _markDeckUnsaved(deckId, on) {
      if (!deckId) return;
      const had = !!this._unsavedDecks[deckId];
      if (on) this._unsavedDecks[deckId] = true; else delete this._unsavedDecks[deckId];
      if (had === !!on) return;                      // 변화 없음 → 재렌더 생략
      try { if (typeof Projects !== "undefined" && Projects._renderDecks) Projects._renderDecks(); } catch (e) {}
    },
    /** 로컬 draft 전수 스캔으로 '미저장 구역' 집합을 재구성(재진입/구역목록 갱신 시) */
    async _refreshUnsavedDecks() {
      try {
        if (typeof SyncQueue === "undefined" || !SyncQueue.allDraftKeys) return;
        const keys = (await SyncQueue.allDraftKeys()) || [];
        let changed = false;
        for (const k of keys) {
          const did = this._deckIdOfKey(k);
          if (!did) continue;
          let d = null;
          try { d = await SyncQueue.loadDraft(k); } catch (e) { continue; }
          const unsaved = !!(d && d.dirty && d.pages && d.pages.length);
          if (!!this._unsavedDecks[did] === unsaved) continue;
          if (unsaved) this._unsavedDecks[did] = true; else delete this._unsavedDecks[did];
          changed = true;
        }
        if (changed) { try { if (typeof Projects !== "undefined" && Projects._renderDecks) Projects._renderDecks(); } catch (e) {} }
      } catch (e) {}
    },

    /** [B1] 서버 배포본이 하나도 없는 프로젝트로 재진입했을 때 —
     *  로컬 draft(저장 버튼을 안 눌러 서버엔 없는 작업분)를 찾아 화면에 복원한다.
     *  이 경로가 없으면 사용자에겐 도면이 '사라진 것'으로 보인다. */
    async _restoreProjectDraft(pid) {
      try {
        if (!pid || typeof SyncQueue === "undefined" || !SyncQueue.allDraftKeys) return false;
        let keys = [];
        try { keys = (await SyncQueue.allDraftKeys()) || []; } catch (e) { return false; }
        const prefix = pid + "::";
        const mine = keys.filter((k) => typeof k === "string" && k.indexOf(prefix) === 0);
        if (!mine.length) return false;
        const decks = (typeof Projects !== "undefined" && Array.isArray(Projects.decks)) ? Projects.decks : [];
        let best = null, bestScore = -1, bestDeck = null;
        for (const k of mine) {
          let d = null;
          try { d = await SyncQueue.loadDraft(k); } catch (e) { continue; }
          if (!d || !d.pages || !d.pages.length) continue;
          const did = this._deckIdOfKey(k);
          const deck = did ? decks.find((x) => String(x.id) === String(did)) : null;
          // [WO 20260929-parent-guard] 🔴 재현 2026-09-29(지휘자 실측) — 키에 프로젝트 접두는 맞지만
          // (currentDeck 이 프로젝트 전환 중 새어 이 draft 자체가 잘못 생성됐을 수 있다) deck id 가
          // 이 프로젝트의 살아있는 decks 에 없으면(다른/삭제된 프로젝트 deck) 복원하지 않고 버린다
          // — 화면에 잘못된 deck 에 속한 작업분을 올리지 않는다(조용히 고르는 대신 후보에서 제외).
          if (did && !deck) continue;
          const score = (deck ? 2 : 0) + (d.dirty ? 1 : 0);   // 실존 구역 > dirty 우선
          if (score > bestScore) { bestScore = score; best = k; bestDeck = deck || null; }
        }
        if (!best) return false;
        if (bestDeck && typeof Projects !== "undefined") Projects.currentDeck = bestDeck;
        const ok = await this._restoreDraftLocal(best);
        if (ok) {
          try { if (typeof Projects !== "undefined" && Projects._renderDecks) Projects._renderDecks(); } catch (e) {}
          // 🔴 [WO 20260930-fitopen] 로컬 draft 복원(프로젝트 재진입, 서버 배포본 없음)도
          //   화면 맞춤이 빠진 진입점이었다 — _restoreDraftLocal 은 다른 호출부(loadDeckDrawing
          //   의 폴백)와 공유하므로 그쪽에서 직접 고치지 않고, whenDisplayed() 로 표시 정착을
          //   기다린 뒤 여기서만 맞춘다(loadDeckDrawing 폴백은 selectDeck/openOriginal 이 이어서
          //   _applyDeckCropView 로 다시 맞추므로 영향 없음).
          try {
            const shown = (typeof this.whenDisplayed === "function") ? await this.whenDisplayed() : true;
            if (shown) {
              try { if (typeof PDF !== "undefined" && PDF.setDeckCrop) PDF.setDeckCrop(null); } catch (e) {}
              try { if (typeof MapCtrl !== "undefined" && MapCtrl.fit) MapCtrl.fit(); } catch (e) {}
            }
          } catch (e) {}
        }
        return ok;
      } catch (e) { return false; }
    },

    /** [WO 20261001-mobilefast R3] 대기 배지(32_Offline.updateNetBadge)용 — 서버 미반영 dirty draft
     *  개수. _flushDirtyDrafts 와 **같은 판정**(d.dirty && d.pages.length && !writeDenied)을 쓴다
     *  (§G-2-5 공유 판정 — 갈라지면 한쪽은 세는데 한쪽은 안 올리는 불일치가 난다).
     *  종전엔 배지가 OpLog(ops 로그)+SyncQueue(이미지 큐)만 세어, CHECKER 핀처럼 draft 로만
     *  남는 오프라인 편집은 대기 0건으로 잘못 표시됐다(R3 재현: 오프라인 핀 5개 → "오프라인 0"). */
    async _countDirtyDrafts() {
      if (typeof SyncQueue === "undefined" || !SyncQueue.allDraftKeys) return 0;
      let keys = [];
      try { keys = await SyncQueue.allDraftKeys(); } catch (e) { return 0; }
      let n = 0;
      for (const key of keys) {
        let d;
        try { d = await SyncQueue.loadDraft(key); } catch (e) { continue; }
        if (d && d.dirty && d.pages && d.pages.length && !d.writeDenied) n++;
      }
      return n;
    },

    /** 온라인 복귀 시 dirty draft 를 서버로 자동 업로드 */
    async _flushDirtyDrafts() {
      if (!navigator.onLine) return;
      if (typeof SyncQueue === "undefined") return;
      let keys = [];
      try { keys = await SyncQueue.allDraftKeys(); } catch (e) { return; }
      for (const key of keys) {
        let d;
        try { d = await SyncQueue.loadDraft(key); } catch (e) { continue; }
        if (!d || !d.dirty || !d.pages || !d.pages.length) continue;
        // [WO 20260930-403] 이 draft 는 이전에 권한없음/대상삭제로 거부 확인됨 — 재시도 안 함(무한루프 방지).
        //   draft 자체는 삭제하지 않고 그대로 보존(권한이 나중에 열리면 사용자가 다시 저장하면 된다).
        if (d.writeDenied) continue;
        try {
          const body = {
            title: d.fileName || "도면", file_name: d.fileName || "",
            pins: JSON.stringify(d.pins || []), zones: JSON.stringify(d.zones || []),
            annotations: JSON.stringify(d.annotations || []),
            drawing_data: d.pages[0], pages_data: JSON.stringify(d.pages)
          };
          // [WO 20260930-WP3] 소속 프로젝트 = 이 draft 의 키(현재 열린 프로젝트가 아닐 수 있다)
          const keyPid = this._projectIdOfKey(key);
          if (keyPid) body.project_id = keyPid;
          // [P0-2] 구역(deck)에 속하지 않는 draft(`noproj::nodeck`)로 '새' 배포본을 만들면
          //   연결할 구역이 없어 고아 배포본이 된다 → 신규 생성은 건너뛰고 로컬 draft 는 그대로 보존한다.
          //   (기존 배포본 갱신(PATCH)은 연결이 이미 있으므로 그대로 진행)
          if (!d.depId && !this._deckIdOfKey(key)) continue;
          // 🔴 [WO 20260929-lossless] 이 경로가 prod dep_muksj6py 를 만들었다: draft 스냅샷을 base64 그대로 D1 에,
          //   원본 PDF 는 빼고 보냈다(source_meta null). 수동 저장(_createInitialSave)과 같은 규칙으로 맞춘다 —
          //   ① 페이지는 R2(실패 시 base64 폴백 = 종전) ② draft 에 원본이 있으면 원본을 먼저 R2 에 올리고
          //   source_meta 를 싣는다. 원본 업로드가 실패하면 **보내지 않는다**(dirty 유지 → 다음 기회 재시도).
          const srcAb = await this._draftSource(d);
          if (srcAb) {
            let url = d.srcUrl || null;
            if (!url) url = await this._uploadSourcePdf(srcAb);
            if (!url) { this._sourceKeepFailed(); continue; }
            if (!d.srcUrl) { d.srcUrl = url; try { await SyncQueue.saveDraft(key, d); } catch (e) {} }
            body.source_meta = this._sourceMetaJson(url, Array.isArray(d.srcDims) ? d.srcDims : []);
          }
          const r2pages = await this._uploadPagesToR2(d.pages);
          if (Array.isArray(r2pages) && r2pages.length) { body.drawing_data = r2pages[0]; body.pages_data = JSON.stringify(r2pages); }
          let res;
          // [발견/수정] srvPins/srvZones 는 아래 if(d.depId) 블록 밖(3449줄)에서도 참조되는데
          //   기존엔 블록 스코프(let)로만 선언돼 매 PATCH 성공마다 ReferenceError → 바깥 catch 가
          //   조용히 삼켜 draft 가 영원히 dirty:false 로 정리되지 않는 별개의 기존 결함이었다.
          //   함수 스코프로 끌어올려 근본수정(이번 401 처리와 같은 함수 안이라 함께 정리).
          let baseVer = 0, srvPins = null, srvZones = null;
          if (d.depId) {
            // [멀티유저 충돌방지] 오프라인 작업분 동기화도 낙관적 잠금.
            //   서버에서 최신 버전을 먼저 읽어 base_version 으로 첨부하고,
            //   서버 핀/구역과 오프라인 작업분을 병합하여 양쪽 모두 보존.
            // 🔴 [WO 20261001-offline · p102 A4] GET 과 PATCH 사이에 남이 저장하면 409(버전 경합, 'stale').
            //   최신본을 다시 읽어 같은 규칙으로 병합 후 재시도한다(최대 3회) — 경합은 권한/삭제가 아니다.
            for (let attempt = 0; attempt < 3; attempt++) {
              baseVer = 0; srvPins = null; srvZones = null;
              body.pins = JSON.stringify(d.pins || []); body.zones = JSON.stringify(d.zones || []);
              try {
                const cur = await fetch("/tables/deployments/" + encodeURIComponent(d.depId), { headers: Auth.headers() });
                if (cur.ok) {
                  const cj = await cur.json();
                  baseVer = (cj.version != null ? Number(cj.version) : 0);
                  try { srvPins = JSON.parse(cj.pins || "[]"); } catch (e) {}
                  try { srvZones = JSON.parse(cj.zones || "[]"); } catch (e) {}
                }
              } catch (e) {}
              // 🔴 [WO 20260928-pinloss] 충돌 규칙은 화면 복원과 같은 단일 출처(_draftVsServer)
              if (srvPins || srvZones) {
                const m = this._draftVsServer(d, srvPins, srvZones, baseVer);
                if (srvPins) body.pins = JSON.stringify(m.pins);
                if (srvZones) body.zones = JSON.stringify(m.zones);
              }
              body.base_version = baseVer;
              res = await fetch("/tables/deployments/" + encodeURIComponent(d.depId), {
                method: "PATCH", headers: Auth.headers(), body: JSON.stringify(body)
              });
              const stale = res.status === 409 && typeof Auth !== "undefined" && Auth.classifyWriteFailure
                && (await Auth.classifyWriteFailure(res)) === "stale";
              if (!stale) break;
            }
          } else {
            res = await fetch("/tables/deployments", {
              method: "POST", headers: Auth.headers(), body: JSON.stringify(body)
            });
          }
          if (!res.ok) {
            // [WO 20260930-403] 401(진짜 만료) / 403·409(권한없음·대상삭제) 를 공유 지점(Auth.classifyWriteFailure)
            //   에서 판정한다. 만료만 재로그인 게이트를 연다 — 권한없음/삭제는 토큰이 멀쩡하므로
            //   draft 를 writeDenied 로 표시해 재시도를 멈추고(보존은 유지) 세션당 1회만 안내한다.
            const kind = (typeof Auth !== "undefined" && Auth.classifyWriteFailure) ? await Auth.classifyWriteFailure(res) : null;
            if (kind === "expired") {
              if (typeof Auth !== "undefined" && Auth.authExpired) Auth.authExpired();
            } else if (kind === "denied" || kind === "conflict") {
              d.writeDenied = true;
              try { await SyncQueue.saveDraft(key, d); } catch (e) {}
              if (typeof Auth !== "undefined" && Auth.writeDenied) Auth.writeDenied(kind);
            }
            continue;                              // 실패 → dirty 유지, 다음 기회에 재시도(writeDenied 는 예외)
          }
          const rec = await res.json().catch(() => null);
          const wasNew = !d.depId;                // POST 로 '새' 배포본을 만든 경우
          d.depId = (rec && rec.id) ? rec.id : d.depId;
          d.dirty = false;
          // [B2] 자동 동기화가 만든 새 배포본도 반드시 구역(deck)에 연결한다.
          //   연결을 빠뜨리면 배포본은 서버에 있는데 구역엔 '도면없음'인 고아가 되어
          //   사용자에겐 도면이 사라진 것으로 보인다. (draft 키 = projectId::deckId)
          if (wasNew && d.depId) {
            try {
              const deckId = this._deckIdOfKey(key);
              if (deckId) {
                const deckObj = (typeof Projects !== "undefined" && Array.isArray(Projects.decks))
                  ? Projects.decks.find((x) => String(x.id) === String(deckId)) : null;
                const linked = await this._linkDeckDeployment(deckId, d.depId, deckObj);
                if (linked && deckObj) {
                  deckObj.deployment_id = d.depId;
                  try { Projects._renderDecks && Projects._renderDecks(); } catch (e) {}
                }
              }
            } catch (e) { /* 연결 실패 → _deckLinkQueue 가 다음 기회에 재시도 */ }
          }
          this._markDeckUnsaved(this._deckIdOfKey(key), false);   // [B4] 서버 반영됨 → 배지 해제
          // 병합된 핀/구역을 draft 에도 반영(다음 동기화 기준 정합)
          if (srvPins)  { try { d.pins  = JSON.parse(body.pins  || "[]"); } catch (e) {} }
          d.basePinIds = this._pinIds(Array.isArray(d.pins) ? d.pins : []);   // [WO 20260929-bulkdel] 서버 = 방금 보낸 핀 = 새 기준
          if (srvZones) { try { d.zones = JSON.parse(body.zones || "[]"); } catch (e) {} }
          await SyncQueue.saveDraft(key, d);
          if (key === this._draftKey() && d.depId) {
            State.autoSaveDepId = d.depId; State.currentDeploymentId = d.depId;
            // 화면의 원본이 방금 올린 그 원본이면 URL 재사용(다음 저장에서 재업로드 0)
            const ent = (State.fileType === "pdf" && State.fileData && this._srcKeys) ? this._srcKeys.get(State.fileData) : null;
            if (d.srcUrl && ent && ent.key === d.srcKey) State.sourcePdfUrl = d.srcUrl;
            if (rec && rec.version != null) State.depVersion = Number(rec.version); // 버전 동기화
            State.pinBaseIds = d.basePinIds.slice();   // [WO 20260929-bulkdel] 버전과 함께 병합 기준도 동기화
            this._setSaveIndicator("saved");
          }
        } catch (e) { /* 네트워크 단절 — 다음 online 때 */ }
      }
    },

    /** 도면 업로드 직후 1회: 배포본 생성(도면 스냅샷 포함) */
    /** 현재 도면 draft 의 로컬 키 — 구역(deck) 단위로 1개 보관 */
    _draftKey() {
      const pid = (typeof Projects !== "undefined" && Projects.currentProject) ? Projects.currentProject.id : "noproj";
      const did = (typeof Projects !== "undefined" && Projects.currentDeck) ? Projects.currentDeck.id : "nodeck";
      return pid + "::" + did;
    },

    /** 도면 스냅샷+핀+구역을 로컬(IndexedDB)에 영속 저장 — 오프라인/서버실패에도 절대 소실 안 됨 */
    async _saveDraftLocal(pages) {
      try {
        if (typeof SyncQueue === "undefined") return false;
        const snap = (pages && pages.length) ? pages : await this._snapshotPages();
        if (!snap || !snap.length) return false;
        const payload = {
          fileName:    State.fileName || "도면",
          fileType:    State.fileType || "image",
          pages:       snap,
          pins:        State.pins || [],
          zones:       (typeof Zones !== "undefined" && State.zones) ? State.zones : [],
          annotations: State.annotations || [],
          checkboardStart: State.checkboardStart || {}, // [WO 20260917 멀티유저 ①]
          depId:       State.autoSaveDepId || null,
          // 🔴 [WO 20260928-pinloss] 이 작업분이 기준으로 삼은 서버 버전 — 재로드 시 충돌 규칙(_draftVsServer) 판정용
          baseVer:     (State.autoSaveDepId && State.depVersion != null) ? Number(State.depVersion) : null,
          dirty:       true                       // 서버 미반영분 표시 → online 시 업로드
        };
        Object.assign(payload, this._draftPinMeta());           // [WO 20260929-bulkdel] 삭제 부활 방지(_draftVsServer)
        Object.assign(payload, await this._draftSrcFields());   // [WO 20260929-lossless] 원본 PDF 연결고리
        const dkey = this._draftKey();
        await SyncQueue.saveDraft(dkey, payload);
        // [B4] 서버 미반영(로컬 전용) 구역 표시 — 저장을 눌렀는지 사용자가 알 수 있게
        this._markDeckUnsaved(this._deckIdOfKey(dkey), true);
        return true;
      } catch (e) { return false; }
    },

    /** 기존 구역 도면을 새 도면으로 교체(같은 배포본 ID 덮어쓰기) — 고아 배포본 방지 */
    async _replaceDeckDrawing(depId) {
      if (State.mode !== "designer" || !depId) return;
      State.autoSaveDepId = depId;
      State.currentDeploymentId = depId;
      let pages = null;
      try {
        this._setSaveIndicator("saving");
        pages = await this._snapshotPages();
        if (!pages.length) { this._setSaveIndicator("error"); return; }
        await this._saveDraftLocal(pages);                       // 로컬 우선 보관(원본 dataURL)
        // [마스터 요청 (나)] 교체 도면도 R2 업로드 후 URL 저장(실패 시 base64 폴백)
        // [P14 버그수정] PDF 가 로드 안 된 경로(이미지 도면)에서도 안전하게(형제: L3039 패턴)
        let dims = null; try { dims = PDF.lastSnapshotDims; } catch (e) {}
        const r2pages = await this._uploadPagesToR2(pages);
        const srcMeta = await this._buildSourceMeta(dims);     // [P14] 교체 도면도 원본 보관
        // [멀티유저 충돌방지] 낙관적 잠금 PATCH — 409면 병합 후 재시도
        const r = await this._patchDeployment(depId, () => this._buildSavePayload(r2pages, srcMeta));
        if (!r.ok) throw new Error("HTTP " + (r.status || "fail"));
        await this._markDraftClean(pages);
        this._setSaveIndicator("saved");
      } catch (e) {
        if (pages) await this._saveDraftLocal(pages);           // 실패 시 로컬 보관(online 복귀시 업로드)
        this._setSaveIndicator(navigator.onLine ? "error" : "offline");
      }
    },

    async _createInitialSave() {
      if (State.mode !== "designer") return;
      if (State.autoSaveDepId) return; // 이미 생성됨
      if (!State.fileType) return;
      let pages = null;
      try {
        this._setSaveIndicator("saving");
        pages = await this._snapshotPages();
        if (!pages.length) { this._setSaveIndicator("error"); return; }
        // 먼저 로컬에 무조건 보관(서버 성공 여부와 무관하게 도면 소실 방지) — 원본 dataURL 보존
        await this._saveDraftLocal(pages);
        // [마스터 요청 (나)] 도면 바이너리를 R2에 올리고 URL로 치환(실패 시 base64 폴백)
        // [P14 버그수정] PDF 가 로드 안 된 경로(이미지 도면)에서도 안전하게(형제: L3039 패턴)
        let dims = null; try { dims = PDF.lastSnapshotDims; } catch (e) {}
        const r2pages = await this._uploadPagesToR2(pages);
        const srcMeta = await this._buildSourceMeta(dims);     // [P14] 신규 배포본에 원본 PDF 보관
        const body = this._buildSavePayload(r2pages, srcMeta);
        // [WO 20260930-WP3 · C3] 구역 밖(프로젝트 단위)에서 처음 등록한 도면 = 프로젝트 원본 후보.
        //   서버는 그 프로젝트 원본이 비어 있을 때만 기록한다(first-wins). 구역 안 저장·구역 복사본은 원본 아님.
        const asOriginal = !!body.project_id && !(typeof Projects !== "undefined" && Projects.currentDeck);
        if (asOriginal) body.original = true;
        const res = await fetch("/tables/deployments", {
          method: "POST",
          headers: Auth.headers(),
          body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const rec = await res.json();
        if (rec && rec.is_project_original && typeof Projects !== "undefined" && Projects.markOriginal) Projects.markOriginal(body.project_id, rec.id);
        State.autoSaveDepId = (rec && rec.id) ? rec.id : null;
        State.currentDeploymentId = State.autoSaveDepId;
        try { State.pinBaseIds = this._pinIds(JSON.parse(body.pins || "[]")); } catch (e) {}   // [WO 20260929-bulkdel] 새 서버 기준
        // 서버 저장 성공 → 로컬 draft 의 dirty 해제(스냅샷은 백업으로 유지)
        await this._markDraftClean(pages);
        this._setSaveIndicator("saved");
      } catch (e) {
        // 서버 실패/오프라인 → 로컬 draft 는 이미 보관됨. 사용자에겐 '로컬 보관' 표시.
        if (pages) await this._saveDraftLocal(pages);
        this._setSaveIndicator(navigator.onLine ? "error" : "offline");
      }
    },

    /* ── [WO 20260929-lossless] draft ↔ 원본 PDF 연결 ─────────────────────────────
       🔴 근본원인(prod dep_muksj6py 재현): draft 에는 화면 스냅샷만 있고 원본 PDF 가 없었다.
         도면 등록 → (저장 전) 새로고침/재진입 → _restoreDraftLocal 이 fileType="image"·fileData=null 로 복원 →
         ① 자동 업로드(_flushDirtyDrafts)가 base64 스냅샷 + source_meta 없이 배포본을 만들고
         ② 이후 편집마다 _snapshotPages() 가 그 스냅샷을 2000px JPEG 0.8 로 재압축해 덮어썼다(prod = 2000×667 JPEG, version 1).
       → 원본 바이트를 IndexedDB(SyncQueue.sources)에 1회 보관하고 draft 에는 그 key 만 싣는다.
         key 는 State.fileData(원본 ArrayBuffer) 객체 동일성으로 묶는다 — 도면이 바뀌면(State.reset) 자동으로 끊긴다. */
    _srcKeys: (typeof WeakMap !== "undefined") ? new WeakMap() : null,
    /** @returns {Promise<{srcKey?:string, srcDims?:Array}>} 원본 PDF 가 있을 때만 필드를 채운다. */
    async _draftSrcFields() {
      const ab = State.fileData;
      if (State.fileType !== "pdf" || !ab || !this._srcKeys || typeof SyncQueue === "undefined" || !SyncQueue.saveSource) return {};
      let ent = this._srcKeys.get(ab);
      if (!ent) {
        const key = "src_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
        ent = { key: key, saved: SyncQueue.saveSource(key, { bytes: ab, name: State.fileName || "", type: "application/pdf" }) };
        this._srcKeys.set(ab, ent);
      }
      const saved = await ent.saved;
      if (!saved) return {};   // IndexedDB 불가(사생활 모드 등) — 연결고리를 거짓으로 남기지 않는다
      const dims = Array.isArray(PDF.lastSnapshotDims) ? PDF.lastSnapshotDims : null;
      if (dims && dims.length) ent.dims = dims;   // 마지막 실측 스냅샷 픽셀(source_meta.pages)
      return { srcKey: ent.key, srcDims: ent.dims || [], srcUrl: State.sourcePdfUrl || null };
    },
    /** draft 의 원본 PDF 바이트(없으면 null) */
    async _draftSource(d) {
      if (!d || !d.srcKey || typeof SyncQueue === "undefined" || !SyncQueue.loadSource) return null;
      const r = await SyncQueue.loadSource(d.srcKey);
      const ab = r && r.bytes;
      return (ab && this._isPdfBytes(ab)) ? ab : null;
    },
    /** 원본 바이트가 PDF 인가(파일 헤더 "%PDF-" — 선두 1KB 안, 명세상 앞에 쓰레기 바이트 허용) */
    _isPdfBytes(ab) {
      try {
        const u = new Uint8Array(ab, 0, Math.min(1024, ab.byteLength || 0));
        for (let i = 0; i + 4 < u.length; i++) {
          if (u[i] === 0x25 && u[i + 1] === 0x50 && u[i + 2] === 0x44 && u[i + 3] === 0x46 && u[i + 4] === 0x2D) return true;
        }
      } catch (e) {}
      return false;
    },
    /** 사용하지 않는 원본 정리 — 어떤 draft 도 가리키지 않는 source 삭제(저장소 누적 방지). */
    async _pruneDraftSources() {
      try {
        if (typeof SyncQueue === "undefined" || !SyncQueue.pruneSources) return;
        const keep = new Set();
        for (const k of (await SyncQueue.allDraftKeys()) || []) {
          const d = await SyncQueue.loadDraft(k);
          if (d && d.srcKey) keep.add(d.srcKey);
        }
        const cur = State.fileData && this._srcKeys && this._srcKeys.get(State.fileData);
        if (cur) keep.add(cur.key);
        await SyncQueue.pruneSources(keep);
      } catch (e) {}
    },

    /** 서버 저장 성공분의 로컬 draft dirty=false 로 표시(여전히 로컬 백업 유지) */
    async _markDraftClean(pages) {
      try {
        if (typeof SyncQueue === "undefined") return;
        const payload = {
          fileName: State.fileName || "도면", fileType: State.fileType || "image",
          pages: (pages && pages.length) ? pages : await this._snapshotPages(),
          pins: State.pins || [], zones: State.zones || [], annotations: State.annotations || [],
          depId: State.autoSaveDepId || null, dirty: false
        };
        Object.assign(payload, this._draftPinMeta());           // [WO 20260929-bulkdel] 복원 후 병합에도 삭제 기록 유지
        Object.assign(payload, await this._draftSrcFields());   // clean draft 도 원본 연결고리 유지(서버 실패 폴백 복원용)
        if (payload.pages && payload.pages.length) await SyncQueue.saveDraft(this._draftKey(), payload);
      } catch (e) {}
    },

    /** [WO 20261001-mobilefast 갱신] 핀/영역/도면 변경 시 — 로컬 draft 로 즉시 보존(소실 방지) +
     *  'dirty' 표시는 그대로 두고, **온라인이면** 추가로 서버 자동 반영을 디바운스 예약한다
     *  (_scheduleAutoSync). [수동 저장] 버튼은 남아 있고 언제든 즉시 반영에 쓸 수 있다. */
    _autoSave(opts) {
      if (State.mode !== "designer") return;
      opts = opts || {};
      if (opts.withPages) this._dirtyPages = true;        // 도면 페이지도 다음 저장에 포함
      // 로컬 우선 보관(새로고침/오프라인에도 작업 보존) — 비차단
      this._saveDraftLocal(opts.withPages ? null : null).catch(() => {});
      this._markDirty();
      this._scheduleAutoSync();
    },

    /** [WO 20261001-mobilefast R5] 온라인 편집 중 "[저장]을 눌러야만 서버에 반영"되던 지연을 없앤다.
     *  순수 디바운스(매 편집마다 타이머 리셋, 조용해진 뒤 1.5s 후 1회 반영) — "연속 편집 중 과도한
     *  요청을 막는다(최대 1요청/1.5s)" 요구는 이걸로 충분(개별 핀 배치·삭제·이동은 각각 끊어진
     *  이산 동작이라 1.5s 안에 여러 번 겹쳐도 디바운스가 1건으로 합친다 — 결과는 동일).
     *  🔴 Date.now() 산술로 "경과시간" 을 계산하지 않는다 — 시계를 모킹하는 테스트(예: 재인증
     *  5분 경과 시뮬레이션으로 Date.now() 가 시각을 건너뛰는 p107)에서 타이머가 조기 점화돼
     *  의도치 않은 네트워크 저장이 다른 테스트 흐름과 경합했다(실측 회귀 — 고정 ms만 사용해 제거). */
    AUTO_SYNC_DEBOUNCE_MS: 1500,
    _autoSyncTimer: null,
    _scheduleAutoSync() {
      // [방어] 일부 단위테스트 sandbox(vm)는 타이머 전역을 주지 않는다 — 10_MapCtrl.js._scheduleSettle
      // 과 같은 패턴(§G-2-5)으로 조용히 건너뛴다(실 브라우저는 항상 존재, 동작 불변).
      if (typeof setTimeout !== "function") return;
      if (typeof navigator === "undefined" || !navigator.onLine) return;  // 오프라인 복귀는 _flushDirtyDrafts 가 별도 처리
      if (typeof clearTimeout === "function") clearTimeout(this._autoSyncTimer);
      this._autoSyncTimer = setTimeout(() => this._runAutoSync(), this.AUTO_SYNC_DEBOUNCE_MS);
    },
    async _runAutoSync() {
      this._autoSyncTimer = null;
      if (!navigator.onLine || !this._dirty) return;
      if (this.autoSaving) { this._scheduleAutoSync(); return; }
      // 신규 배포본(아직 서버에 없음)인데 프로젝트/구역 컨텍스트가 없으면 _saveNow 가 매번
      // "저장할 구역이 없습니다" 토스트를 띄운다 — 조용히 건너뛰고 다음 편집 때 다시 시도한다
      // (로컬 draft 는 이미 _autoSave 에서 저장됐으므로 데이터 유실은 없다).
      const hasCtx = State.autoSaveDepId || ((typeof Projects !== "undefined") && Projects.currentProject && Projects.currentDeck);
      if (!hasCtx) return;
      try { await this._saveNow({ silent: true }); } catch (e) {}
    },

    /** 실제 서버 저장(수동 '저장' 버튼). 배포본 없으면 생성+구역연결, 있으면 PATCH.
     *  @returns {Promise<boolean>} 서버 반영 성공 여부(가드 차단·중복호출·실패는 false).
     *    '뷰어로 배포'(_deployToViewer)가 이 경로를 그대로 재사용하므로 결과를 반드시 알려야 한다. */
    async _saveNow(opts) {
      if (State.mode !== "designer") return false;
      opts = opts || {};
      if (this.autoSaving) return false;
      this.autoSaving = true;
      this._lastSaveErr = null;   // 이번 저장의 실패 사유(원본 보관 실패는 _sourceKeepFailed 가 이미 명시 표시)
      try {
        // [P0-2] 신규 배포본을 만들려는데 프로젝트/구역 컨텍스트가 없으면 중단.
        //   그대로 POST 하면 어느 구역에도 연결되지 않는 '고아 배포본'이 생기고(동일 도면 중복 생성),
        //   사용자에겐 구역이 계속 '도면없음'으로 보인다. 기존 배포본 갱신(PATCH)은 영향 없다.
        if (!State.autoSaveDepId) {
          const hasCtx = (typeof Projects !== "undefined") && !!Projects.currentProject && !!Projects.currentDeck;
          if (!hasCtx) {
            this._setSaveIndicator("error");
            Prompt.toast && Prompt.toast("저장할 구역이 없습니다 — 프로젝트와 구역을 먼저 선택하세요(도면은 구역에 연결되어야 저장됩니다)");
            return false;
          }
        }
        this._setSaveIndicator("saving");
        if (!State.autoSaveDepId) {
          // 신규: _createInitialSave 가 도면(R2 업로드)+핀 전체를 저장
          await this._createInitialSave();
          if (!State.autoSaveDepId) {
            // [결함수정 2026-09-18] 모바일은 #autosave-text 가 CSS로 숨겨져(style.css) 인디케이터만으론
            // 실패가 안 보인다 — 토스트로 반드시 알린다(기존 토스트 경로 재사용, 새 배지 없음).
            this._setSaveIndicator(navigator.onLine ? "error" : "offline");
            if (this._lastSaveErr !== "SOURCE_KEEP_FAILED") {   // 원본 보관 실패 안내를 일반 문구로 덮지 않는다
              try { Prompt.toast && Prompt.toast(navigator.onLine ? "저장 실패 — 도면 저장에 실패했습니다. 다시 시도해 주세요" : "오프라인 — 로컬 보관됨(연결 후 저장)"); } catch (e) {}
            }
            return false;
          }
          // 도면 업로드로 대기 중이던 구역 연결 마무리
          if (this._pendingDeckLink) {
            const p = this._pendingDeckLink; this._pendingDeckLink = null;
            if (p.deck) { p.deck.deployment_id = State.autoSaveDepId; try { Projects._renderDecks && Projects._renderDecks(); } catch (e) {} }
            await this._linkDeckDeployment(p.deckId, State.autoSaveDepId, p.deck);
          } else if (typeof Projects !== "undefined" && Projects.currentDeck && !Projects.currentDeck.deployment_id && State.autoSaveDepId) {
            // [견고화] _pendingDeckLink 가 소실(새로고침 등)됐어도 현재 구역에 새 도면을 자동 연결
            //   → "도면을 등록·저장했는데 구역에 안 붙어 도면없음으로 보이는" 회귀 방지
            const cd = Projects.currentDeck;
            cd.deployment_id = State.autoSaveDepId;
            try { Projects._renderDecks && Projects._renderDecks(); } catch (e) {}
            await this._linkDeckDeployment(cd.id, State.autoSaveDepId, cd);
          }
        } else {
          // 기존: PATCH. 도면이 실제로 변경됐을 때만 재스냅샷·R2 재업로드.
          // 그 외엔 이미 저장된 pages(R2 URL)를 그대로 전달 → 불필요한 재업로드·스냅샷 실패 방지.
          let pages = null, srcMeta = null;
          if (this._dirtyPages) {
            pages = await this._snapshotPages();
            // [P14 버그수정] PDF 가 로드 안 된 경로(이미지 도면)에서도 안전하게(형제: L3039 패턴)
            let dims = null; try { dims = PDF.lastSnapshotDims; } catch (e) {}  // 실측 픽셀(스냅샷 직후 채취)
            if (pages && pages.length) pages = await this._uploadPagesToR2(pages);
            srcMeta = await this._buildSourceMeta(dims);       // PDF 원본 -> R2 (이미지 도면이면 null)
          } else if (State.viewerPages && State.viewerPages.length) {
            pages = State.viewerPages.filter(p => typeof p === "string" && p.indexOf("blob:") !== 0);
            if (!pages.length) pages = null;
          }
          await this._saveDraftLocal(pages);
          const r = await this._patchDeployment(State.autoSaveDepId, () => this._buildSavePayload(pages, srcMeta));
          if (!r.ok) throw new Error("HTTP " + (r.status || "fail"));
          await this._markDraftClean(pages);
        }
        this._dirty = false; this._dirtyPages = false; this._updateSaveBtn();
        try { this._markDeckUnsaved(this._deckIdOfKey(this._draftKey()), false); } catch (e) {}  // [B4]
        this._setSaveIndicator("saved");
        // [마스터: 저장 확인이 안 됨] 명확한 완료 피드백(모바일 토스트).
        // [WO 20261001-mobilefast] 자동저장(opts.silent)은 상단 #autosave-indicator로 충분히
        // 보이므로 토스트는 생략 — 1.5s 주기 자동저장마다 토스트가 쌓이는 스팸 방지.
        if (!opts.silent) { try { Prompt.toast && Prompt.toast("저장 완료"); } catch (e) {} }
        return true;
      } catch (e) {
        this._setSaveIndicator(navigator.onLine ? "error" : "offline");
        if (!(e && e.code === "SOURCE_KEEP_FAILED")) {
          try { Prompt.toast && Prompt.toast(navigator.onLine ? "저장 실패 — 다시 시도해 주세요" : "오프라인 — 로컬 보관됨(연결 후 저장)"); } catch (e2) {}
        }
        return false;
      } finally {
        this.autoSaving = false;
      }
    },

    /** 미저장 변경 표시 — '저장' 버튼 활성화 */
    _markDirty() {
      if (State.mode !== "designer") return;
      this._pinsStamp();   // [WO 20260930-lww] 모든 편집 경로의 공통 관문 — 바뀐 핀에 updatedAt
      this._dirty = true;
      this._updateSaveBtn();
    },

    _updateSaveBtn() {
      const b = UI.$("btn-save");
      if (!b) return;
      if (this._dirty) {
        b.classList.remove("hidden", "is-clean"); b.classList.add("is-dirty");
        b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15" aria-hidden="true" style="vertical-align:-2px"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> 저장 *'; b.disabled = false;
      } else {
        b.classList.remove("is-dirty"); b.classList.add("is-clean");
        b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15" aria-hidden="true" style="vertical-align:-2px"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> 저장됨'; b.disabled = true;
      }
    },

    async _deployToViewer() {
      const btn    = UI.$("btn-deploy");
      const status = UI.$("deploy-status");

      if (State.pins.length === 0) { alert("배포할 핀이 없습니다. 먼저 포인트를 추가하세요."); return; }
      if (typeof Log !== "undefined") Log.push("deploy.click", null, { pins: State.pins.length });

      // ── 오프라인 등록은 허용하되, 서버 빌드(배포)는 인증 완료 필수 ──
      // (요구사항: 오프라인일 때 등록은 가능하지만 서버에 빌드하려면 반드시 인증이 완료되어야 함)
      if (!navigator.onLine) {
        alert("현재 오프라인 상태입니다.\n\n• 포인트/도면 '등록'은 계속 가능합니다(자동 임시저장).\n• 단, 서버에 '빌드(배포)'하려면 인터넷 연결 + 인증 완료가 필요합니다.\n\n인터넷에 연결한 뒤 다시 시도해 주세요.");
        return;
      }
      const authed = (typeof Auth !== "undefined") && !!Auth.idToken && !!Auth.user;
      if (!authed || !Auth.isDesigner) {
        alert("서버 빌드(배포)에는 설계자 인증이 필요합니다.\n\nGoogle 로그인 또는 @seastargo.com 계정으로 로그인하고 인증을 완료한 뒤 다시 시도해 주세요.");
        if (typeof Auth !== "undefined" && Auth.requireDesigner) { try { Auth.requireDesigner(() => this._deployToViewer()); } catch (e) {} }
        return;
      }

      // 미동기화(오프라인 임시 저장) 핀이 있으면 배포 전에 먼저 서버로 일괄 업로드
      const hasPending = State.pins.some(p => p.pendingOpId || (p.attachments || []).some(a => a.pendingOpId));
      if (hasPending) {
        if (!navigator.onLine) {
          alert("아직 업로드되지 않은 오프라인 핀이 있습니다. 인터넷에 연결한 뒤 다시 배포해 주세요.");
          return;
        }
        btn.disabled = true; btn.textContent = "임시 저장 핀 업로드 중...";
        const r = await SyncQueue.flush();
        await this._onSyncDone(r);
        if (State.pins.some(p => p.pendingOpId || (p.attachments || []).some(a => a.pendingOpId))) {
          alert("일부 핀 업로드에 실패했습니다. 네트워크를 확인하고 다시 시도해 주세요.");
          btn.disabled = false; btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15" aria-hidden="true" style="vertical-align:-2px"><path d="M12 19V5"/><polyline points="5 12 12 5 19 12"/></svg> 뷰어로 배포';
          return;
        }
      }

      // 저장 경로(_createInitialSave)와 동일한 전제: 도면(fileType)이 없으면 배포본을 만들 수 없다.
      if (!State.fileType) {
        alert("도면이 없습니다. 먼저 도면을 업로드하세요.");
        btn.disabled = false; btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15" aria-hidden="true" style="vertical-align:-2px"><path d="M12 19V5"/><polyline points="5 12 12 5 19 12"/></svg> 뷰어로 배포';
        return;
      }

      btn.disabled = true; btn.textContent = "배포 중...";
      status.classList.add("hidden"); status.classList.remove("error");

      try {
        // [근본수정] 배포가 '저장'과 별개로 /tables/deployments 에 무조건 POST 하던 경로를 제거한다.
        //   그 경로는 (a) 프로젝트/구역 컨텍스트가 없으면 어디에도 연결 안 되는 고아 배포본을 만들고,
        //   (b) 구역에 이미 deployment_id 가 있으면 배포할 때마다 배포본이 하나씩 더 생기는데
        //       구역은 옛 ID 를 계속 가리키고 작업본(State.autoSaveDepId)만 새 ID 로 갈아타
        //       "저장했는데 구역에 반영 안 됨"이 발생했다.
        //   → 배포 = 저장(_saveNow) 재사용. 신규면 생성+구역연결, 기존이면 그 배포본을 PATCH.
        //     배포본은 언제나 1구역 1개이고, 뷰어 링크는 그 ID 를 그대로 쓴다.
        btn.textContent = "서버 저장 중...";
        this._dirtyPages = true;                       // 배포는 항상 현재 도면 스냅샷을 반영
        const saved = await this._saveNow({ now: true, withPages: true });
        const depId = saved ? State.autoSaveDepId : null;
        if (!depId) throw new Error("저장이 완료되지 않았습니다 — 프로젝트/구역 선택과 네트워크를 확인하세요");

        // [불변식] 배포 후 "구역.deployment_id === State.autoSaveDepId".
        //   _saveNow 는 신규 생성 시에만 구역을 연결한다. 기존 배포본을 PATCH 한 경우
        //   구역이 다른(옛) ID 를 가리키고 있으면 저장 결과가 구역에서 보이지 않으므로 여기서 재연결한다.
        try {
          const cd = (typeof Projects !== "undefined") ? Projects.currentDeck : null;
          if (cd && String(cd.deployment_id || "") !== String(depId)) {
            cd.deployment_id = depId;
            await this._linkDeckDeployment(cd.id, depId, cd);
          }
          if (typeof Projects !== "undefined" && Projects._renderDecks) Projects._renderDecks();
        } catch (e) {}

        const pageCount = (State.viewerPages && State.viewerPages.length) || State.pdfPages || 1;

        // [버그수정] location.origin 은 배포별 임시 서브도메인(xxxx.scan360.pages.dev)일 수 있어
        //   그 링크는 '옛 코드'를 영구히 가리킨다(401 등) → 고정 production 도메인으로 정규화.
        let _origin = location.origin;
        const _m = _origin.match(/^https?:\/\/[a-f0-9]{6,}\.(scan360\.pages\.dev)$/i);
        if (_m) _origin = "https://" + _m[1];
        const viewerUrl = _origin + location.pathname +
          "?mode=viewer" + (depId ? "&d=" + encodeURIComponent(depId) : "");
        // [C-LOOP1 결함1] 공유가 목적인 시스템 → 원클릭 링크 복사 버튼 제공
        status.innerHTML =
          "배포 완료! (" + pageCount + "페이지 / " + State.pins.length + "핀)<br>" +
          "뷰어 전용 링크:<br>" +
          "<a id='deploy-link' href='" + viewerUrl + "' target='_blank' style='color:#10b981;word-break:break-all'>" + viewerUrl + "</a><br>" +
          "<button id='btn-copy-link' type='button' style='margin-top:8px;padding:6px 14px;border-radius:8px;border:1px solid #10b981;background:transparent;color:#10b981;cursor:pointer;font-size:13px'>링크 복사</button>";
        status.classList.remove("hidden");
        // 복사 버튼 핸들러 (clipboard API + execCommand 폴백)
        const copyBtn = document.getElementById("btn-copy-link");
        if (copyBtn) {
          copyBtn.addEventListener("click", async () => {
            const ok = await App._copyToClipboard(viewerUrl);
            copyBtn.textContent = ok ? "복사됨!" : "복사 실패 — 링크를 길게 눌러 복사하세요";
            setTimeout(() => { copyBtn.textContent = "링크 복사"; }, 2200);
          });
        }
      } catch (e) {
        status.textContent = "배포 실패: " + e.message;
        status.classList.add("error");
        status.classList.remove("hidden");
      } finally {
        btn.disabled = false; btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15" aria-hidden="true" style="vertical-align:-2px"><path d="M12 19V5"/><polyline points="5 12 12 5 19 12"/></svg> 뷰어로 배포';
      }
    },

    /* ── 클립보드 복사 (Clipboard API → execCommand 폴백) ── */
    async _copyToClipboard(text) {
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch (e) { /* 폴백으로 진행 */ }
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        return ok;
      } catch (e) { return false; }
    },

    /* ── 뷰어: 최신 배포본 자동 로드 ── */
    async loadLatestDeployment(projectForDesigner) {
      const seq = this._beginLoad();   // 🔴 [WO 20260928-pinloss] 늦게 도착하면 폐기(아래 _isCurrentLoad)
      let draftKey = null, draft = null; // 설계자 재진입으로 연 구역의 dirty draft(복원 대상)
      const statusEl = UI.$("viewer-load-status");
      statusEl.textContent = "도면 불러오는 중...";

      try {
        // [B1] 링크에 배포 ID(?d=)가 있으면 그 배포본을 정확히 로드
        const params = new URLSearchParams(location.search);
        // [P61] 공유 링크 `/srview/<이름>-<토큰>` 으로 들어온 경우 서버가 해석해 준 배포본을 쓴다.
        //   `?d=` 와 동일한 자리에 들어가므로 이후 로직(로드/폴백)은 한 줄도 갈라지지 않는다.
        let wantId = params.get("d") || ((typeof ShareLink !== "undefined" && ShareLink.deploymentId) || null);
        let latest = null;

        // [N4] 설계자 프로젝트 재진입: 그 프로젝트 deck 의 배포본을 로드(작업 복원)
        if (!wantId && projectForDesigner) {
          try {
            // [W8 오프라인] 끊긴 상태면 서버 대신 다운로드한 데크(IndexedDB)에서 deployment_id 해석.
            //   [견고화] 온라인이어도 네트워크가 죽으면 6초 타임아웃 후 오프라인 데크로 폴백.
            let decks = [];
            if (!navigator.onLine && typeof OfflineLoad !== "undefined") {
              decks = (await OfflineLoad.decks(projectForDesigner.id)) || [];
            } else {
              try {
                const ctrl = new AbortController();
                const t = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, 6000);
                try {
                  const dr = await fetch("/api/projects/" + encodeURIComponent(projectForDesigner.id) + "/decks", { headers: Auth.headers(), signal: ctrl.signal });
                  const dj = await dr.json();
                  decks = dj.data || [];
                } finally { clearTimeout(t); }
              } catch (e) {
                if (typeof OfflineLoad !== "undefined") decks = (await OfflineLoad.decks(projectForDesigner.id)) || [];
              }
            }
            // 🔴 [WO 20260928-pinloss] 그 사이 selectDeck 등 다른 로드가 시작됐으면 현재 구역을 빼앗지 않는다
            if (!this._isCurrentLoad(seq)) return;
            if (typeof Projects !== "undefined") Projects.decks = decks;
            // [WO 20260929-tree1] 🔴 마스터: "프로젝트를 클릭하면 원본 전체 도면이 나오게" —
            //   예전엔 decks 배열의 첫 deployment_id(서버 정렬 순서 — 영역/자식 구역도 섞임)를
            //   그냥 집었다. 자식 "영역"(크롭)이 먼저 오면 프로젝트 재진입 시 잘린 화면이 뜬다.
            //   공유 지점(§10 SoT) Projects.pickOriginalDeck 으로 루트 구역(parent_id NULL) 중
            //   최신 1개만 고른다 — 사이드바 트리 프로젝트 노드 클릭(openOriginal)과 동일 규칙.
            const deck = (typeof Projects !== "undefined" && Projects.pickOriginalDeck)
              ? Projects.pickOriginalDeck(decks, projectForDesigner) : decks.find(d => d.deployment_id);
            // [WO 20260930-WP3 · C3] 구역 없는 원본(id 없음) = 프로젝트 단위 도면 → currentDeck 없음(_draftKey 의 nodeck 과 같은 규칙)
            if (deck) { wantId = deck.deployment_id; if (typeof Projects !== "undefined") Projects.currentDeck = deck.id ? deck : null; }
            // 🔴 [WO 20260928-pinloss] 저장 안 한 작업분은 배포본 fetch **전에** 읽는다(형제 loadDeckDrawing 과 같은 이유)
            if (deck && State.mode === "designer") {
              draftKey = projectForDesigner.id + "::" + (deck.id || "nodeck");
              draft = await this._readDirtyDraft(draftKey, wantId);
            }
          } catch (e) {}
          if (!wantId) {   // 새/빈 프로젝트 → 도면 없음(다른 프로젝트 도면을 잘못 띄우지 않음)
            statusEl.textContent = "";
            // [B1] 서버 배포본이 없어도 '저장 전' 로컬 draft 가 있으면 복원한다.
            //   (자동저장 OFF 정책 하에선 저장 버튼을 안 누른 작업이 로컬에만 존재한다)
            try { await this._restoreProjectDraft(projectForDesigner.id); } catch (e) {}
            try { this._refreshUnsavedDecks(); } catch (e) {}
            return;
          }
        }

        if (wantId) {
          // [W8 오프라인] 배포본도 캐시에서 우선 복원. [견고화] 온라인이어도 실패/타임아웃 시 캐시 폴백.
          if (!navigator.onLine && typeof OfflineLoad !== "undefined") {
            latest = await OfflineLoad.deployment(wantId);
          } else {
            try {
              const ctrl = new AbortController();
              const t = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, 6000);
              try {
                const r1 = await fetch("/tables/deployments/" + encodeURIComponent(wantId), { headers: Auth.headers(), signal: ctrl.signal });
                if (r1.ok) latest = await r1.json();
              } finally { clearTimeout(t); }
            } catch (e) {}
            if (!latest && typeof OfflineLoad !== "undefined") latest = await OfflineLoad.deployment(wantId);
          }
        }

        // 없거나 실패 시 최신 배포본으로 폴백 (뷰어만 — 설계자는 위에서 프로젝트 스코프)
        if (!latest && !projectForDesigner) {
          const res = await fetch("/tables/deployments?limit=100", { headers: Auth.headers() });
          if (!res.ok) throw new Error("HTTP " + res.status);
          const json = await res.json();
          const rows = (json.data || []).filter(r => (r.drawing_data || r.pages_data) && !r.deleted);
          if (rows.length === 0) {
            statusEl.textContent = "아직 배포된 도면이 없습니다.";
            UI.$("pin-empty").textContent = "아직 배포된 도면이 없습니다.\n설계자가 배포하면 자동 표시됩니다.";
            return;
          }
          // [B4] created_at가 숫자(epoch)/ISO 문자열 어느 쪽이든 안전 정렬
          const ts = r => {
            const v = r.created_at;
            const n = (typeof v === "number") ? v : Date.parse(v);
            return Number.isFinite(n) ? n : 0;
          };
          rows.sort((a, b) => ts(b) - ts(a));
          latest = rows[0];
        }

        if (!this._isCurrentLoad(seq)) return;   // 🔴 [WO 20260928-pinloss] 늦게 도착한 로드 — State 를 덮지 않는다
        // 페이지 배열 복원 (신규 pages_data → 레거시 drawing_data)
        let pages = [];
        try { pages = JSON.parse(latest.pages_data || "[]"); } catch { pages = []; }
        if (!Array.isArray(pages) || pages.length === 0) pages = [latest.drawing_data];

        State.currentDeploymentId = latest.id || null;  // 노트/협업 연결
        // [N4] 설계자 재진입: 이후 편집이 새 배포본을 만들지 않고 이 배포본을 갱신하도록
        if (projectForDesigner && latest.id) { State.autoSaveDepId = latest.id; State.depVersion = (latest.version != null ? Number(latest.version) : 0); }
        State.fileType   = "image";
        this._applySourceMeta(latest);  // [P14] 원본 PDF 위치/실측 픽셀(구버전이면 전부 null)
        State.viewerPages = pages;
        State.pdfPage    = 1;
        State.fileName   = latest.file_name || latest.title || "배포 도면";
        UI.text("file-name-label", State.fileName);
        UI.$("drop-hint").classList.add("hidden");
        UI.$("pdf-canvas").classList.add("hidden");

        try { State.pins = this._pinsSeen(this._live(JSON.parse(latest.pins || "[]"))); }
        catch { State.pins = []; }
        State.pinTombstones = {}; State.pinBaseIds = this._pinIds(State.pins);   // [WO 20260929-bulkdel] 형제 로더와 같은 기준
        try { State.zones = this._live(JSON.parse(latest.zones || "[]")); }
        catch { State.zones = []; }
        try { State.annotations = this._live(JSON.parse(latest.annotations || "[]")); }
        catch { State.annotations = []; }
        // [WO 20260917 멀티유저 ①] 구버전 배포본(컬럼 없음) → {} → 종전대로 시작번호 1
        // [WO 20260929 addendum] _normalizeCheckboardStart() 로 계열별 중첩 형식 정규화(§10 SoT).
        try { State.checkboardStart = this._normalizeCheckboardStart(JSON.parse(latest.checkboard_start || "{}")); }
        catch { State.checkboardStart = this._normalizeCheckboardStart(null); }
        // 🔴 [WO 20260928-pinloss] 형제 로더(loadDeckDrawing)와 같은 공유 지점 — 저장 안 한 작업분 복원
        if (draft && latest.id === wantId) this._applyDirtyDraft(draft, draftKey, latest.version);

        const imgEl = UI.$("map-image");
        let _ld2 = false;
        const _r2 = () => {
          if (_ld2) return; _ld2 = true;
          this._showMapViewport();
          UI.renderPinList();
          UI.renderPinsOnMap();
          if (typeof Zones !== "undefined") { Zones.render(); Zones.renderList(); }
          if (typeof PdfAnno !== "undefined") PdfAnno.refresh();
          if (typeof Notes !== "undefined") Notes.loadSummary();
          // 🔴 [WO 20260930-fitopen · 지휘자 실측] 허브 카드/프로젝트 재진입은 트리(selectDeck)·
          //   openOriginal(31_Projects.js _applyDeckCropView)을 거치지 않는 유일한 진입점이라
          //   화면 맞춤이 빠져 있었다 — zoom=1/pan=0(_showMapViewport)가 그대로 남아 도면
          //   왼쪽 위 여백부터 보였다(재현: sunbo floor.pdf). 이 로드는 항상 "전체(크롭 없음)"
          //   보기이므로 이전 세션의 구역 크롭이 남아 있으면 먼저 해제(PDF.setDeckCrop SoT)한다.
          try { if (typeof PDF !== "undefined" && PDF.setDeckCrop) PDF.setDeckCrop(null); } catch (e) {}
          try { if (typeof MapCtrl !== "undefined" && MapCtrl.fit) MapCtrl.fit(); } catch (e) {}
        };
        this._armDisplay();   // [WO 20260929-fitrace2] _r2→_showMapViewport 가 settle
        imgEl.onload = _r2;
        // [P52 결함수정] 🔴 근본원인 — 이 경로(프로젝트 재진입 시 최신 배포본 자동복원)엔
        //   onerror 핸들러가 아예 없었다. 도면 이미지가 R2 접근 실패(404/403/네트워크)로
        //   못 불러와지면 _r2() 가 영영 안 불려 _showMapViewport()·renderPinsOnMap()·
        //   renderPinList() 가 전부 스킵 — State.pins 는 채워졌는데 뷰포트는 hidden 그대로,
        //   마커 0개로 조용히 실패했다(마스터 신고: "목록엔 생기는데 핀 마커가 안 생긴다").
        //   #map-viewport 는 CSS 상 position:absolute inset:0(부모 기준 고정 크기)라 이미지
        //   자연크기와 무관하게 뜨므로, 실패해도 _r2() 를 그대로 호출해 핀·목록·구역만은
        //   정상 표시한다 — 대신 이미지가 안 떴다는 사실은 정직하게 알린다(가짜 성공 금지).
        imgEl.onerror = () => {
          _r2();
          statusEl.textContent = "도면 이미지를 불러오지 못했습니다 — 핀은 정상 표시됩니다(사유: 이미지 접근 실패)";
        };
        imgEl.src = Auth.r2(pages[0]);
        imgEl.classList.remove("hidden");
        if (imgEl.complete && imgEl.naturalWidth) _r2();

        // [C-LOOP1 결함2] 뷰어 첫 진입 어포던스 — 핀 클릭으로 360°가 열림을 명시
        if (State.pins.length > 0) {
          statusEl.innerHTML =
            "로드 완료 (" + pages.length + "페이지 / " + State.pins.length + "개 포인트)<br>" +
            "<span style='color:var(--green)'>도면 위 번호 핀을 클릭하면 360° 파노라마가 열립니다.</span>";
        } else {
          statusEl.textContent = "배포본 로드 완료 (" + pages.length + "페이지 / 포인트 없음)";
        }
        UI.renderPinList();
      } catch (e) {
        statusEl.textContent = "불러오기 실패: " + e.message;
      }
    },

    /* ── Export JSON ── */
    _exportJson() {
      const data = JSON.stringify({ fileName: State.fileName, pins: State.pins }, null, 2);
      const blob = new Blob([data], { type: "application/json" });
      const a = document.createElement("a");
      a.href     = URL.createObjectURL(blob);
      a.download = "360_points.json";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); document.body.removeChild(a); }, 1000);
    },
  };

  /* ══════════════════════════════════════════
     ALL-PINS DRAWER — 전체 핀 리스트 보기
     · 모든 페이지의 핀을 이름/번호순으로 한눈에
     · 검색, 360°/문서 미리보기 썸네일, 클릭 시 페이지 구분 없이 줌인+360° 오픈
  ══════════════════════════════════════════ */