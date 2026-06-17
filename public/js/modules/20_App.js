  const App = {

    init() {
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
      try { State.pinColor = PinPrefs.get(); } catch (e) {}  // 저장된 핀 색상 복원(기본 그린)
      Auth.init();
      Settings.init();
      Designers.init();
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
    },

    /* ── Home ── */
    _bindHome() {
      document.querySelectorAll(".mode-card").forEach(card => {
        const open = () => {
          const mode = card.dataset.mode;
          // 설계자(디자이너) 모드는 구글 로그인 + 디자이너 권한 필요. 일반인은 뷰어만.
          if (mode === "designer") {
            Auth.requireDesigner(() => this.openApp("designer"));
            return;
          }
          this.openApp(mode);
        };
        card.addEventListener("click", open);
        card.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") open(); });
      });
    },

    openApp(mode, opts) {
      // 체크보드 모드: 내부적으로 디자이너와 동일하게 동작(도면등록/핀 추가/이동/삭제),
      // 차이는 ① 핀에 이름 대신 번호만 자동 부여 ② 상단 라벨/색상이 'CHECKBOARD'.
      const isCheckboard = mode === "checkboard";
      State.checkboard = isCheckboard;
      State.mode = isCheckboard ? "designer" : mode;   // 도구 분기(mode==='designer')를 그대로 재사용
      opts = opts || {};
      const isDesigner = State.mode === "designer";
      if (typeof Log !== "undefined") Log.push(mode === "viewer" ? "viewer.open" : "app.open", null, { mode });
      // 모바일 하단 네비 designer-only 버튼 표시/숨김용 body 클래스
      document.body.classList.toggle("role-designer", isDesigner);
      document.body.classList.toggle("role-viewer", !isDesigner);
      document.body.classList.toggle("mode-checkboard", isCheckboard);
      const accentVar = isCheckboard ? "var(--blue)" : (isDesigner ? "var(--gold)" : "var(--green)");
      document.documentElement.style.setProperty("--accent", accentVar);
      UI.$("topbar").style.borderBottomColor = isCheckboard ? "rgba(47,109,181,.28)" : (isDesigner ? "rgba(245,158,11,.2)" : "rgba(16,185,129,.2)");
      const dot = UI.$("topbar-dot");
      if (dot) dot.style.background = accentVar;
      UI.text("mode-label", isCheckboard ? "CHECKBOARD MODE" : (isDesigner ? "DESIGNER MODE" : "VIEWER MODE"));
      UI.$("mode-label").style.color = accentVar;

      // ── 뷰어는 "보기 전용". 업로드/편집/배포 관련 UI는 모두 숨긴다. ──
      //  (사용자 요청: "뷰어는 업로드가 왜 필요하지. 뷰어만 완벽하게 되게 만들어")
      UI.toggle("section-projects",  isDesigner);   // 프로젝트/데크 관리
      UI.toggle("section-upload",    isDesigner);   // 도면 업로드
      UI.toggle("section-place",     isDesigner);   // 위치 포인트 추가 (도구 패널 — 항상 유지)
      UI.toggle("section-checkboard", isDesigner);  // 체크보드 상설 메뉴 (디자이너 전용)
      // 체크보드 메뉴 카드의 진입 버튼 라벨/활성 상태 동기화
      try {
        const cbEnter = UI.$("btn-checkboard-enter");
        const cbEnterLbl = UI.$("btn-checkboard-enter-label");
        if (cbEnter) cbEnter.classList.toggle("active", isCheckboard);
        if (cbEnterLbl) cbEnterLbl.textContent = isCheckboard ? "디자이너 모드로 복귀" : "체크보드 모드 시작";
        const startInput = UI.$("input-checkboard-start");
        if (startInput) startInput.value = String(App._checkboardStart(State.pdfPage || 1));
      } catch (e) {}
      if (typeof Zones !== "undefined") Zones.renderList(); // 영역 목록(디자이너=항상, 뷰어=영역 있을 때)
      UI.toggle("section-export",    isDesigner);   // 뷰어로 배포
      // 핀 편집 폼은 사이드바가 아닌 도면 위 플로팅 패널 — 시작 시 닫힘
      this._closePinForm();
      UI.toggle("section-next-point", false);
      UI.toggle("btn-import-json",   false);        // JSON 가져오기 — 뷰어/디자이너 모두 숨김
      UI.toggle("section-viewer-load", !isDesigner); // 뷰어 로드 상태 표시

      if (isDesigner) Projects.load();              // 프로젝트 목록 로드

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
      // ⚙️ 설정 버튼은 항상 노출(로그인·편집 전환 진입점)
      const btnSettings = UI.$("btn-settings");
      if (btnSettings) btnSettings.classList.remove("hidden");
      // "뷰어로" 버튼은 편집(designer) 모드에서만
      const btnExit = UI.$("btn-exit-edit");
      if (btnExit) btnExit.classList.toggle("hidden", !isDesigner);
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
      const cbBtn = UI.$("btn-checkboard-toggle");
      if (cbBtn) cbBtn.classList.toggle("active", isCheckboard);
      const cbLabel = UI.$("btn-checkboard-label");
      if (cbLabel) cbLabel.textContent = isCheckboard ? "디자이너 모드로 복귀" : "체크보드 모드";
      const placeBtn = UI.$("btn-place");
      if (placeBtn) placeBtn.textContent = isCheckboard ? "+ 번호 핀 찍기" : "+ 위치 포인트 추가";
      const placeHint = UI.$("place-hint");
      if (placeHint) placeHint.textContent = isCheckboard
        ? "도면 위를 클릭하면 번호가 자동으로 매겨집니다"
        : "도면 위 원하는 위치를 클릭하세요";

      UI.showScreen("screen-app");
      if (!isDesigner) this.loadLatestDeployment();
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
        if (Auth.requireDesigner) { Auth.requireDesigner(() => this.openApp("designer", { project: Projects.currentProject })); }
        return;
      }
      PanoViewer.close();
      this.openApp("designer", { project: Projects.currentProject });
    },

    /* ── Topbar ── */
    _bindTopbar() {
      // 샘플 FLS 로드 버튼 — document 위임(패널이 어떤 경로로 열려도 항상 동작)
      if (!document._flsSampleBound) {
        document._flsSampleBound = true;
        document.addEventListener("click", (e) => {
          const b = e.target && e.target.closest && e.target.closest("#btn-fls-sample, #btn-fls-sample-err");
          if (b && typeof FLS !== "undefined") { e.preventDefault(); FLS.loadSample(); }
        });
      }
      UI.$("btn-back").addEventListener("click", () => {
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
      this._pageRendering = true;
      try {
        if (State.mode === "viewer" && State.viewerPages) {
          const imgEl = UI.$("map-image");
          await new Promise((res) => {
            imgEl.onload = () => res();
            imgEl.onerror = () => res();
            imgEl.src = State.viewerPages[next - 1];
          });
          this._showMapViewport();
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
    enterZoneView(zoneId) {
      const z = (State.zones || []).find(x => x.id === zoneId);
      if (!z) return;
      // 다른 PDF 페이지면 먼저 전환
      if ((z.page || 1) !== (State.pdfPage || 1) && this._gotoPage) {
        Promise.resolve(this._gotoPage(z.page)).then(() => {
          setTimeout(() => this.enterZoneView(zoneId), 80);
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
      try {
        Prompt && Prompt.toast && Prompt.toast("🔍 구역 페이지: " + (z.label || "구역") + " — 이 안에서 상세 등록·수정. ‘전체’ 탭으로 복귀");
      } catch (e) {}
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
    },

    /* ── Sidebar ── */
    _bindSidebar() {
      UI.$("btn-upload-drawing").addEventListener("click", async () => {
        // ── 요청사항: 도면 등록 시 '구역'을 먼저 보장한다 ──
        // (구역이 없으면 자동으로 기본 구역을 만들고, 여러 구역이 있는데 미선택이면 선택을 유도하되
        //  업로드 자체는 막지 않는다 — 과거 "업로드가 아무 반응 없이 막힘" 회귀 방지)
        if (typeof Projects !== "undefined" && Projects.currentProject) {
          if (!Projects.currentDeck) {
            if (Projects.decks && Projects.decks.length > 1) {
              // 구역이 여러 개인데 선택 안 됨 → 선택 유도(차단하지 않음, 안내만)
              Prompt.toast("⚠️ 여러 구역이 있습니다. 위쪽 '구역'에서 등록할 구역을 먼저 선택하세요.");
              const db = document.getElementById("decks-block");
              if (db) { db.classList.add("zone-required-flash"); setTimeout(() => db.classList.remove("zone-required-flash"), 1600); }
              return;
            }
            // 구역이 0개 또는 1개 → 자동 보장(없으면 '구역 1' 생성, 1개면 그걸 선택)
            try { await Projects.ensureDeck(); } catch (e) {}
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
              State.pins = data.pins;
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

      // 체크보드 모드 토글 (디자이너 ↔ 체크보드) — 두 버튼 공용 핸들러
      const toggleCheckboard = () => {
        if (State.placing) this._togglePlacing();
        const next = State.checkboard ? "designer" : "checkboard";
        App.openApp(next, { project: (typeof Projects !== "undefined" && Projects.currentProject) || null });
        Prompt && Prompt.toast && Prompt.toast(
          next === "checkboard"
            ? "🔢 체크보드 모드 — 도면을 클릭하면 번호 핀이 1씩 증가하며 찍힙니다"
            : "🎨 디자이너 모드로 복귀"
        );
        if (next === "checkboard") setTimeout(() => { if (!State.placing) this._togglePlacing(); }, 60);
      };
      const cbBtn = UI.$("btn-checkboard-toggle");
      if (cbBtn) cbBtn.addEventListener("click", toggleCheckboard);
      const cbEnter = UI.$("btn-checkboard-enter");
      if (cbEnter) cbEnter.addEventListener("click", toggleCheckboard);

      // 체크보드 구역별 시작 번호 입력
      const cbStart = UI.$("input-checkboard-start");
      if (cbStart) {
        const applyStart = () => {
          const n = this._setCheckboardStart(State.pdfPage || 1, cbStart.value);
          cbStart.value = String(n);
          Prompt && Prompt.toast && Prompt.toast("🔢 이 구역 시작 번호: " + n);
        };
        cbStart.addEventListener("change", applyStart);
        cbStart.addEventListener("blur", applyStart);
      }

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
        if (!f) return;
        const isImg = f.type.startsWith("image/");
        const isVid = f.type.startsWith("video/") || /\.(mp4|webm|mov)$/i.test(f.name);
        if (!isImg && !isVid) { alert("이미지(.jpg/.png) 또는 360° 영상(.mp4) 파일을 선택하세요."); return; }
        State.pendingFile = f;
        State.pendingIsVideo = isVid;
        const info = UI.$("pin-file-info");
        info.textContent = (isVid ? "🎬 " : "🖼 ") + f.name + " (" + (f.size / 1024 / 1024).toFixed(1) + " MB)";
        info.classList.remove("hidden");
        UI.show("field-pin-imgname");
        // ── 요청사항: 구역이 선택돼 있으면 파일명을 '구역명_번호'(예: ER1_1, ER1_2)로 자동 지정 ──
        const autoName = this._zoneImageName();
        UI.$("input-pin-imgname").value = autoName || f.name.replace(/\.[^.]+$/, "");
        this._updateConfirmEnabled();
        // ── 요청사항: 새 포인트 + 사진 등록 시 별도 저장 버튼 없이 즉시 저장 ──
        //    (편집 모드는 '변경 저장' 버튼을 명시적으로 눌러야 반영)
        if (!State.editingPinId) {
          setTimeout(() => this._confirmPin(), 120);
        }
      });

      // 핀 폼: 첨부 문서 선택 (PDF/Word 등 — 다중)
      UI.$("btn-pin-doc").addEventListener("click", () => UI.$("input-pin-doc").click());
      UI.$("input-pin-doc").addEventListener("change", e => {
        const files = Array.from(e.target.files || []);
        e.target.value = "";
        files.forEach(f => this._addPendingDoc(f));
      });

      // 핀 폼: 3D 포인트 클라우드(FLS/E57/LAS/PLY 등) 첨부
      const flsBtn = UI.$("btn-pin-fls");
      if (flsBtn) flsBtn.addEventListener("click", () => UI.$("input-pin-fls").click());
      const flsInput = UI.$("input-pin-fls");
      if (flsInput) flsInput.addEventListener("change", async e => {
        const f = e.target.files[0];
        e.target.value = "";
        if (!f) return;
        if (typeof FLS !== "undefined" && !FLS.isSupported(f.name)) {
          Prompt.toast && Prompt.toast("지원 형식: .fls .e57 .las .laz .ply .pcd .xyz .pts");
        }
        try {
          const ab = await this._readAsArrayBuffer(f);
          // 로컬 캐시에 보관(즉시 미리보기/저장은 배포 시 처리)
          const lid = "f" + Date.now() + Math.random().toString(36).slice(2, 6);
          Cloud._cache = Cloud._cache || {};
          Cloud._cache["fls:" + lid] = ab;
          State.pendingFls = { localId: lid, name: f.name, size: f.size };
          const info = UI.$("pin-file-info");
          if (info) {
            const prev = info.classList.contains("hidden") ? "" : info.textContent + "  ·  ";
            info.textContent = prev + "🧊 " + f.name + " (" + (f.size / 1024 / 1024).toFixed(1) + " MB)";
            info.classList.remove("hidden");
          }
          this._updateConfirmEnabled();
        } catch (err) {
          Prompt.toast && Prompt.toast("3D 파일 읽기 실패: " + (err.message || err));
        }
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

      // 동기화 배지 클릭 → 지금 즉시 동기화
      const sb = UI.$("sync-badge");
      if (sb) sb.addEventListener("click", async () => {
        if (!navigator.onLine) { alert("현재 오프라인입니다. 인터넷 연결 시 자동으로 업로드됩니다."); return; }
        const r = await SyncQueue.flush();
        if (r && r.map) this._onSyncDone(r);
      });

      UI.$("btn-export-json").addEventListener("click", () => this._exportJson());
      UI.$("btn-deploy").addEventListener("click", () => this._deployToViewer());
      UI.$("btn-reload-deploy").addEventListener("click", () => this.loadLatestDeployment());
    },

    _togglePlacing() {
      State.placing = !State.placing;
      if (State.placing) {
        State.pending = null;
        State.editingPinId = null;
        this._closePinForm();         // 편집 폼이 떠 있으면 닫고 새 배치 모드
        UI.hide("section-next-point");
      }
      UI.$("btn-place").classList.toggle("active", State.placing);
      UI.$("place-hint").classList.toggle("hidden", !State.placing);
      UI.$("crosshair-overlay").classList.toggle("hidden", !State.placing);
      UI.$("map-viewport").style.cursor = State.placing ? "crosshair" : "grab";
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
      // 진입 애니메이션 트리거
      panel.classList.remove("pf-in");
      void panel.offsetWidth;
      panel.classList.add("pf-in");
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
      State.pendingDocs = [];
      State.pendingFls = null;
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

      // 화면 맞춤
      const fit = $("mnav-fit");
      if (fit) fit.addEventListener("click", () => { closeSheet(); MapCtrl.fit(); });

      // 시트 열렸을 때 사이드바 내 버튼 클릭 시 자동 닫기(업로드/배포 등 액션성)
      const sb = $("sidebar");
      if (sb) sb.addEventListener("click", (e) => {
        if (!document.body.classList.contains("sidebar-open")) return;
        const t = e.target.closest("button");
        if (t && (t.id === "btn-upload-drawing" || t.id === "btn-deploy" || t.classList.contains("deck-name"))) {
          setTimeout(closeSheet, 120);
        }
      });
    },

    /* ── Map ── */
    _bindMap() {
      const vp = UI.$("map-viewport");

      vp.addEventListener("wheel", e => { e.preventDefault(); MapCtrl.handleWheel(e); }, { passive: false });

      vp.addEventListener("mousedown", e => {
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
          if (State.placing) { this._handlePlaceTouch(e); return; }
          lastTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        }
      }, { passive: false });

      vp.addEventListener("touchmove", e => {
        if (e.touches.length === 2 && pinch) {
          // 핀치 줌: 거리 비율만큼 확대/축소, 두 손가락 중점을 기준점으로
          const newDist = touchDist(e.touches[0], e.touches[1]);
          const mid = touchMid(e.touches[0], e.touches[1]);
          if (pinch.dist > 0) {
            const ratio = newDist / pinch.dist;
            if (ratio && isFinite(ratio)) MapCtrl.zoomBy(ratio, mid.x, mid.y);
          }
          // 두 손가락 중점 이동분만큼 팬도 함께(자연스러운 동작)
          State.pan.x += mid.x - pinch.cx;
          State.pan.y += mid.y - pinch.cy;
          MapCtrl.applyTransform();
          pinch = { dist: newDist, cx: mid.x, cy: mid.y };
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
        if (pinch && (!e.touches || e.touches.length < 2)) pinch = null;
        // 손가락이 0개면 팬도 종료
        if (!e.touches || e.touches.length === 0) {
          // 더블탭 줌 감지 (touchend 시점, 직전 탭과 시간·위치 근접)
          const t = (e.changedTouches && e.changedTouches[0]) || null;
          if (t && !State.placing) {
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
      bind("tb-rotate-cw", () => this._rotatePdf(90));
      bind("tb-rotate-ccw",() => this._rotatePdf(-90));
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

    /** 체크보드 모드: 클릭 즉시 번호 핀 생성(이름/사진 폼 없음).
     *  번호는 현재 페이지 내 순번(렌더 규칙과 동일)으로 자동 부여. */
    /** 현재 구역(페이지)의 체크보드 시작 번호 (미설정 시 1) */
    _checkboardStart(page) {
      const p = page || State.pdfPage || 1;
      const v = State.checkboardStart && State.checkboardStart[p];
      const n = parseInt(v, 10);
      return (Number.isFinite(n) && n >= 1) ? n : 1;
    },
    /** 현재 구역(페이지)의 체크보드 시작 번호 설정 */
    _setCheckboardStart(page, value) {
      const p = page || State.pdfPage || 1;
      let n = parseInt(value, 10);
      if (!Number.isFinite(n) || n < 1) n = 1;
      State.checkboardStart = State.checkboardStart || {};
      State.checkboardStart[p] = n;
      this._autoSave && this._autoSave();
      return n;
    },

    _placeCheckboardPin(pct) {
      const totalPages = State.mode === "viewer"
        ? (State.viewerPages ? State.viewerPages.length : 1)
        : State.pdfPages;
      const curPage = State.pdfPage || 1;
      const isMulti = (totalPages || 1) > 1;
      const onPage = isMulti ? State.pins.filter(p => (p.page || 1) === curPage) : State.pins;
      // 구역별 시작 번호부터 1씩 자동 증가: no = 시작번호 + (현재 페이지 핀 수)
      const start = this._checkboardStart(curPage);
      const no = start + onPage.length;
      const pin = { id: Date.now(), x: pct.x, y: pct.y, page: curPage, label: String(no), checkboard: true };
      State.pins.push(pin);
      if (typeof Log !== "undefined") Log.push("pin.add", pin.id, { label: pin.label, page: pin.page, checkboard: true });
      State.activePin = pin.id;
      if (typeof Zones !== "undefined") Zones.refreshPinLinks();
      UI.renderPinList();
      UI.renderPinsOnMap(pin.id);
      if (typeof PinGrid !== "undefined") PinGrid.render();
      this._updateSyncBadge && this._updateSyncBadge();
      this._autoSave && this._autoSave();
      Prompt && Prompt.toast && Prompt.toast("📍 체크 포인트 #" + no + " 추가 · 자동저장");
    },

    _handlePlaceClick(e) {
      if (!State.placing) return;
      const pct = MapCtrl.viewportToPercent(e.clientX, e.clientY);
      if (!pct) return;

      // 체크보드 모드: 이름/사진 입력 없이 즉시 번호 핀만 찍는다.
      // 연속 배치 — placing 을 유지해 클릭마다 번호가 1씩 증가하며 계속 찍힌다.
      if (State.checkboard) {
        this._placeCheckboardPin(pct);
        return; // placing 유지(다음 클릭도 번호 핀). 종료는 '＋ 번호 핀 찍기' 토글로.
      }

      State.pending = pct;
      State.placing = false;
      UI.$("btn-place").classList.remove("active");
      UI.$("place-hint").classList.add("hidden");
      UI.$("crosshair-overlay").classList.add("hidden");
      UI.$("map-viewport").style.cursor = "grab";

      // ⚠️ _resetPinForm이 pending-pin을 hidden 처리 + State.pending=null 로 만들므로
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
      // 포인트를 추가하면 바로 사진 업로드 다이얼로그를 띄운다 (요청사항)
      setTimeout(() => { const fi = UI.$("input-pin-file"); if (fi) fi.click(); }, 280);
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
      window.addEventListener("mouseup",   () => PanoViewer.onPointerUp());
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
        PanoViewer.onPointerUp();
      });

      // 파노라마 컨트롤 버튼
      UI.$("btn-pano-rotate").addEventListener("click", e => {
        const on = PanoViewer.toggleAuto();
        e.currentTarget.classList.toggle("on", on);
      });
      UI.$("btn-pano-zoomin").addEventListener("click",  () => PanoViewer.setFov(-10));
      UI.$("btn-pano-zoomout").addEventListener("click", () => PanoViewer.setFov(10));
      UI.$("btn-pano-reset").addEventListener("click",   () => PanoViewer.resetView());
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
          if (typeof Prompt !== "undefined") Prompt.toast("ℹ️ 도면 업로드는 디자이너 모드에서만 가능합니다.");
          return;
        }
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (!accept(f)) {
          if (typeof Prompt !== "undefined") Prompt.toast("⚠️ PDF · PNG · JPG 파일만 업로드할 수 있습니다.");
          return;
        }
        this._loadDrawing(f);
      });
    },

    async _loadDrawing(file) {
      const _isPdf = file.type === "application/pdf" || (file.name || "").toLowerCase().endsWith(".pdf");
      if (typeof Log !== "undefined") Log.push(_isPdf ? "pdf.register" : "drawing.upload", file.name, { type: file.type, size: file.size });
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
      // 도면이 화면에 표시되면 버튼 없이 즉시 자동 저장(배포본 생성)
      if (State.mode === "designer" && !State.autoSaveDepId) {
        // 이미지의 경우 naturalWidth 가 확정된 직후이므로 약간 지연 후 스냅샷
        setTimeout(() => this._createInitialSave(), 150);
      }
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
      const pin = {
        id: Date.now(),
        x: State.pending.x, y: State.pending.y,
        page: State.pdfPage, label,
        imageName: imgName,
        localPreview,            // 업로드 완료 전까지 즉시 미리보기에 사용
        pendingSync: true,       // 업로드 진행/대기 표시
        uploading: true
      };
      if (note) pin.note = note;
      if (url)  { pin.imageUrl = url; if (/\.(mp4|webm|mov)(\?|#|$)/i.test(url)) pin.isVideo = true; }
      if (typeof Cloud !== "undefined") { Cloud._cache = Cloud._cache || {}; Cloud._cache["local:" + pin.id] = localPreview; }

      State.pins.push(pin);
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
      Prompt && Prompt.toast && Prompt.toast("📍 '" + label + "' 등록 · " + (navigator.onLine ? "백그라운드 업로드 중" : "오프라인 임시저장"));
      UI.text && UI.text("pin-saved-msg", "📍 '" + label + "' 등록됨 · 업로드는 백그라운드로 진행됩니다");
      UI.show && UI.show("section-next-point");

      // 3) 백그라운드 업로드 (await 하지 않음 → 화면 블로킹 없음)
      this._uploadPinImageBg(pin, file, imgName, docs);
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
          pin.pendingOpId = opId;
          Cloud._cache["op:" + opId] = dataURL;
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
              else { const opId = await SyncQueue.enqueue({ kind: "doc", name: d.name, image_data: durl }); att.pendingOpId = opId; att.pendingSync = true; Cloud._cache["op:" + opId] = durl; }
              pin.attachments.push(att);
            } catch (e) {}
          }
        }
        // 업로드 완료 상태 정리
        pin.uploading = false;
        if (!pin.pendingOpId && !(pin.attachments || []).some(a => a.pendingOpId)) delete pin.pendingSync;
        // 로컬 미리보기 정리(서버 이미지로 대체됨)
        if (pin.imageId && pin.localPreview) { try { URL.revokeObjectURL(pin.localPreview); } catch (e) {} delete pin.localPreview; }
      } catch (e) {
        pin.uploading = false;
        Prompt && Prompt.toast && Prompt.toast("⚠ '" + pin.label + "' 업로드 지연 — 동기화 대기에 보관됨");
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
        ? existing
        : { id: Date.now(), x: State.pending.x, y: State.pending.y, page: State.pdfPage, label };
      pin.label = label;
      if (note) pin.note = note; else if (editing) delete pin.note;

      try {
        if (file && State.pendingIsVideo) {
          // 360° 영상: 테이블 용량 제한으로 클라우드 저장 불가 → 로컬 blob URL (현재 세션 미리보기)
          status.textContent = "🎬 360° 영상 연결 중...";
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
              status.textContent = "☁ 클라우드 업로드 중... (" + (dataURL.length / 1024 / 1024).toFixed(1) + " MB)";
              const imageId = await Cloud.uploadImage(imgName, dataURL, width, height);
              pin.imageId = imageId;
              Cloud._cache[imageId] = dataURL; // 즉시 미리보기용 캐시
              uploaded = true;
            } catch (e) { uploaded = false; } // 네트워크 단절 등 → 큐로 폴백
          }
          if (!uploaded) {
            // 오프라인/실패: 로컬에 즉시 저장하고 인터넷 복구 시 일괄 업로드
            status.textContent = "📥 오프라인 — 휴대폰에 임시 저장 (인터넷 복구 시 자동 업로드)";
            const opId = await SyncQueue.enqueue({
              kind: "image", name: imgName, image_data: dataURL, width, height
            });
            pin.pendingOpId = opId;     // 동기화 완료 시 imageId 로 치환
            pin.pendingSync = true;     // 미동기화 표시
            Cloud._cache["op:" + opId] = dataURL; // 미동기화 미리보기 캐시
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
                status.textContent = `📎 첨부 업로드 중... (${i + 1}/${docs.length}) ${d.name}`;
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
              att.pendingOpId = opId; att.pendingSync = true;
              Cloud._cache["op:" + opId] = dataURL;
              pin.pendingSync = true;
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
        status.textContent = "❌ 업로드 실패: " + e.message;
        status.classList.add("error");
        status.classList.remove("hidden");
        btn.disabled = false;
        setBtnLabel("저장하기");
        return;
      }

      if (!editing) State.pins.push(pin);   // 편집 시 기존 객체를 그대로 갱신했으므로 push 안 함
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
      this._autoSave(); // 버튼 없이 즉시 서버 저장

      // 편집 완료면 별도 안내만, 신규면 다음 포인트 연속 배치 안내
      if (wasEditing) {
        State.pinEditUnlocked = null; // 수정 완료 → 다시 잠금
        Prompt.toast("✅ '" + label + "' 수정 완료 · 자동저장");
        return;
      }
      let savedNote = (pin.pendingSync ? "📥 '" : "✅ '") + label + (pin.pendingSync ? "' 임시 저장 (오프라인)" : "' 저장 완료");
      const tags = [];
      if (pin.imageId)        tags.push("☁ 360° 그림");
      else if (pin.pendingOpId) tags.push("📥 360° 그림(대기)");
      else if (pin.isVideo && pin.videoUrl) tags.push("🎬 영상(로컬)");
      else if (pin.isVideo)   tags.push("🎬 360° 영상");
      else if (pin.imageUrl)  tags.push("🔗 URL");
      if (pin.note)           tags.push("📝 노트");
      if (pin.has3D)          tags.push("🧊 3D 클라우드");
      if (pin.attachments && pin.attachments.length) tags.push("📎 첨부 " + pin.attachments.length);
      if (tags.length) savedNote += " (" + tags.join(" · ") + ")";
      UI.text("pin-saved-msg", savedNote);
      UI.show("section-next-point");
    },

    /** 동기화 완료 콜백 — 큐 op id → 서버 imageId/docId 로 치환 후 화면 갱신 */
    _onSyncDone(result) {
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
      if (changed) { try { UI.renderPinList(); UI.renderPinsOnMap(); } catch (e) {} }
      this._updateSyncBadge();
    },

    /** 동기화 상태 배지 갱신 */
    _updateSyncBadge() {
      const badge = UI.$("sync-badge");
      if (!badge) return;
      SyncQueue.count().then(n => {
        const dot = UI.$("sync-dot"), txt = UI.$("sync-text");
        const online = navigator.onLine;
        if (!online && n === 0) {
          badge.classList.remove("hidden", "online", "pending");
          badge.classList.add("offline");
          if (txt) txt.textContent = "오프라인";
        } else if (n > 0) {
          badge.classList.remove("hidden", "online", "offline");
          badge.classList.add("pending");
          if (txt) txt.textContent = (online ? "동기화 대기 " : "오프라인 저장 ") + n;
        } else {
          // 온라인 + 대기 0 → 잠시 표시 후 숨김
          badge.classList.remove("offline", "pending");
          badge.classList.add("online");
          if (txt) txt.textContent = "동기화됨";
          // 디자이너 모드에서만 굳이 항상 표시할 필요는 없으나, 일관성 위해 유지
        }
      });
    },

    setActivePin(id) {
      State.activePin = State.activePin === id ? null : id;
      UI.renderPinList();
      UI.renderPinsOnMap();
    },

    /** 핀 리스트 클릭 → 해당 페이지로 전환 + 플라이투 (+뷰어는 파노라마 오픈) */
    async focusPin(pin, openAfter) {
      State.activePin = pin.id;
      const targetPage = pin.page || 1;
      if (targetPage !== State.pdfPage) {
        State.pdfPage = targetPage;
        if (State.mode === "viewer" && State.viewerPages) {
          const imgEl = UI.$("map-image");
          await new Promise(res => { imgEl.onload = res; imgEl.src = State.viewerPages[targetPage - 1]; });
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

    deletePin(id) {
      const removed = State.pins.find(p => p.id === id);
      if (!removed) return;
      if (!confirm(`'${removed.label}' 포인트를 삭제할까요?\n(첨부된 사진·노트·문서 정보도 함께 제거됩니다)`)) return;
      if (removed.videoUrl) _revokeVideoBlob(removed.videoUrl); // [B5] 삭제 시 즉시 해제
      State.pins = State.pins.filter(p => p.id !== id);
      if (State.activePin === id) State.activePin = null;
      if (State.editingPinId === id) { State.editingPinId = null; this._closePinForm(); }
      if (typeof Zones !== "undefined" && Zones.refreshPinLinks) Zones.refreshPinLinks();
      UI.renderPinList();
      UI.renderPinsOnMap();
      Prompt.toast("🗑️ '" + removed.label + "' 삭제됨");
      this._autoSave();
    },

    /** 기존 포인트 편집 — 플로팅 폼을 기존 값으로 채워 연다 */
    editPin(id) {
      const pin = State.pins.find(p => p.id === id);
      if (pin == null) return;
      // 다른 모드 정리
      if (State.placing) this._togglePlacing();
      State.editingPinId = id;
      State.pending = { x: pin.x, y: pin.y };   // 좌표 보존
      State.pendingFile = null; State.pendingIsVideo = false; State.pendingDocs = [];
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
          <span>📋 ${UI.escapeHtml(pin.label)}</span>
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

      // 노트/첨부만 있고 360° 미디어가 없는 정보 포인트 → 정보 패널만 표시
      if (!this.pinHasMedia(pin) && this.pinHasInfo(pin)) {
        const $ = id => document.getElementById(id);
        $("pano-location-name").textContent = "📋 " + pin.label;
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
      if (!pin.imageId && pin.localPreview) {
        const $ = id => document.getElementById(id);
        $("pano-location-name").textContent = "360°(" + (pin.uploading ? "업로드 중" : "임시") + ") — " + pin.label;
        $("pano-loading").classList.add("hidden");
        $("pano-error").classList.add("hidden");
        $("pano-hint").classList.add("hidden");
        $("pano-controls").classList.add("hidden");
        $("pano-overlay").classList.remove("hidden");
        PanoViewer.open = true;
        PanoViewer.load(pin.localPreview, pin.label);
        return;
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
          const dataURL = await Cloud.fetchImage(pin.imageId);
          PanoViewer.load(dataURL, pin.label);
        } catch (e) {
          PanoViewer._showError("(클라우드: " + (pin.imageName || pin.imageId) + ")", e.message);
        }
      } else if (pin.imageUrl) {
        // 3) URL 직접 입력 (이미지/영상 자동 판별)
        PanoViewer.loadMedia(pin.imageUrl, pin.label, pin.isVideo);
      } else {
        // 4) [B3] 미디어 없음 (로컬 영상이 배포 과정에서 제거된 경우 등) — 명확히 안내
        const $ = id => document.getElementById(id);
        $("pano-location-name").textContent = "360° — " + pin.label;
        $("pano-loading").classList.add("hidden");
        $("pano-canvas").classList.add("hidden");
        $("pano-controls").classList.add("hidden");
        $("pano-hint").classList.add("hidden");
        $("pano-error").querySelector(".pano-error-msg").textContent =
          "이 포인트의 360° 영상은 로컬 전용이라 배포본에 포함되지 않았습니다. 설계자 모드에서 영상 URL로 다시 저장해 주세요.";
        $("pano-error-url").textContent = "";
        const hint = $("pano-error").querySelector(".pano-error-hint");
        if (hint) hint.textContent = "영상은 외부에 호스팅된 URL(.mp4) 형태로 저장하면 모든 환경에서 재생됩니다.";
        $("pano-error").classList.remove("hidden");
        $("pano-overlay").classList.remove("hidden");
        PanoViewer.open = true;
      }
    },

    /* ── 배포 (설계자 → 뷰어) ── */
    /* ── 자동 저장 (버튼 없이 즉시 저장) ──
       도면 업로드 즉시 배포본(작업본)을 생성하고, 핀·영역 변경 시 디바운스 갱신한다.
       사용자가 "배포" 버튼을 누르지 않아도 도면과 작업 내용이 서버에 보존된다. */
    _buildSavePayload(pagesData) {
      const deployablePins = State.pins.map(p => {
        const q = Object.assign({}, p);
        if (q.videoUrl) { delete q.videoUrl; q.localOnly = true; }
        return q;
      });
      const body = {
        title:       State.fileName || "도면",
        file_name:   State.fileName || "",
        pins:        JSON.stringify(deployablePins),
        zones:       (typeof Zones !== "undefined") ? Zones.serialize() : "[]",
        annotations: JSON.stringify(State.annotations || [])
      };
      if (pagesData && pagesData.length) {
        body.drawing_data = pagesData[0];
        body.pages_data   = JSON.stringify(pagesData);
      }
      return body;
    },

    async _snapshotPages() {
      if (State.fileType === "pdf" && State.pdfDoc) {
        return await PDF.snapshotAllPages(State.pdfDoc);
      } else if (State.fileType === "image") {
        const imgEl = UI.$("map-image");
        if (!imgEl || !imgEl.naturalWidth) return [];
        const off = document.createElement("canvas");
        const maxDim = 2000;
        const ratio = Math.min(1, maxDim / Math.max(imgEl.naturalWidth, imgEl.naturalHeight));
        off.width  = Math.round(imgEl.naturalWidth * ratio);
        off.height = Math.round(imgEl.naturalHeight * ratio);
        off.getContext("2d").drawImage(imgEl, 0, 0, off.width, off.height);
        return [off.toDataURL("image/jpeg", 0.8)];
      }
      return [];
    },

    _setSaveIndicator(stateStr) {
      // stateStr: 'saving' | 'saved' | 'error' | 'offline'
      const el = UI.$("autosave-indicator");
      if (!el) return;
      el.classList.remove("hidden", "saving", "saved", "error", "offline");
      el.classList.add(stateStr);
      const map = {
        saving:  "저장 중…",
        saved:   "자동 저장됨",
        error:   "저장 실패 — 재시도",
        offline: "오프라인 — 로컬 보관"
      };
      const t = UI.$("autosave-text");
      if (t) t.textContent = map[stateStr] || "";
    },

    /** #3: 도면 로드 직후 — 구역 보장 + 즉시 자동저장(스냅샷) + 구역에 도면 연결 */
    async _afterDrawingLoaded() {
      if (State.mode !== "designer") return;
      try {
        // 1) 구역이 없으면 강제 생성(현재 구역 보장)
        let deck = null;
        if (typeof Projects !== "undefined" && Projects.currentProject) {
          deck = await Projects.ensureDeck();
        }
        // 2) 도면 스냅샷 즉시 저장 (배포본 생성)
        State.autoSaveDepId = null; // 새 도면이므로 새 스냅샷
        await this._createInitialSave();
        // 3) 생성된 도면 배포본을 현재 구역에 연결
        if (deck && State.autoSaveDepId) {
          deck.deployment_id = State.autoSaveDepId;
          try {
            await fetch("/api/decks/" + deck.id, {
              method: "PUT", headers: Auth.headers(),
              body: JSON.stringify({ name: deck.name, level_no: deck.level_no || null, deployment_id: State.autoSaveDepId })
            });
            Projects._renderDecks();
          } catch (e) { /* 연결 실패해도 도면/스냅샷은 저장됨 */ }
        }
        Prompt.toast && Prompt.toast("📄 도면 등록 · 자동저장 완료" + (deck ? " (구역: " + deck.name + ")" : ""));
      } catch (e) { /* 비치명적 */ }
    },

    /** 구역 선택 시 연결된 도면(배포 스냅샷)을 불러와 화면(디자이너 편집)에 표시 */
    async loadDeckDrawing(deploymentId) {
      if (!deploymentId) return;
      try {
        const r = await fetch("/tables/deployments/" + encodeURIComponent(deploymentId));
        if (!r.ok) return;
        const dep = await r.json();
        let pages = [];
        try { pages = JSON.parse(dep.pages_data || "[]"); } catch { pages = []; }
        if (!Array.isArray(pages) || pages.length === 0) pages = dep.drawing_data ? [dep.drawing_data] : [];
        if (!pages.length) return;

        State.reset();
        State.fileType = "image";       // 스냅샷은 이미지(dataURL)로 보관됨
        State.viewerPages = pages;
        State.pdfPage = 1;
        State.fileName = dep.file_name || dep.title || "구역 도면";
        UI.text("file-name-label", State.fileName);
        UI.$("drop-hint").classList.add("hidden");
        UI.$("pdf-canvas").classList.add("hidden");
        try { State.pins  = JSON.parse(dep.pins  || "[]"); } catch { State.pins = []; }
        try { State.zones = JSON.parse(dep.zones || "[]"); } catch { State.zones = []; }
        try { State.annotations = JSON.parse(dep.annotations || "[]"); } catch { State.annotations = []; }

        const imgEl = UI.$("map-image");
        imgEl.onload = () => {
          this._showMapViewport();
          UI.renderPinList(); UI.renderPinsOnMap();
          if (typeof Zones !== "undefined") { Zones.render(); Zones.renderList(); }
        };
        imgEl.src = pages[0];
        imgEl.classList.remove("hidden");

        State.autoSaveDepId = deploymentId;       // 이후 자동저장은 이 배포본 갱신
        State.currentDeploymentId = deploymentId;
      } catch (e) { /* 무시 */ }
    },

    /** 도면 업로드 직후 1회: 배포본 생성(도면 스냅샷 포함) */
    async _createInitialSave() {
      if (State.mode !== "designer") return;
      if (State.autoSaveDepId) return; // 이미 생성됨
      if (!State.fileType) return;
      try {
        this._setSaveIndicator("saving");
        const pages = await this._snapshotPages();
        if (!pages.length) { this._setSaveIndicator("error"); return; }
        const body = this._buildSavePayload(pages);
        const res = await fetch("/tables/deployments", {
          method: "POST",
          headers: Auth.headers(),
          body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const rec = await res.json();
        State.autoSaveDepId = (rec && rec.id) ? rec.id : null;
        State.currentDeploymentId = State.autoSaveDepId;
        this._setSaveIndicator("saved");
      } catch (e) {
        this._setSaveIndicator(navigator.onLine ? "error" : "offline");
      }
    },

    /** 핀/영역 변경 시 디바운스 자동 저장 (도면 스냅샷은 보통 변경 안 되므로 생략) */
    _autoSave(opts) {
      if (State.mode !== "designer") return;
      opts = opts || {};
      clearTimeout(this._autoSaveTimer);
      this._autoSaveTimer = setTimeout(async () => {
        if (this.autoSaving) { this._autoSave(opts); return; } // 진행 중이면 잠시 후 재시도
        // 배포본이 아직 없으면 먼저 생성
        if (!State.autoSaveDepId) { await this._createInitialSave(); if (!State.autoSaveDepId) return; }
        this.autoSaving = true;
        try {
          this._setSaveIndicator("saving");
          const includePages = !!opts.withPages;
          const pages = includePages ? await this._snapshotPages() : null;
          const body = this._buildSavePayload(pages);
          const res = await fetch("/tables/deployments/" + encodeURIComponent(State.autoSaveDepId), {
            method: "PATCH",
            headers: Auth.headers(),
            body: JSON.stringify(body)
          });
          if (!res.ok) throw new Error("HTTP " + res.status);
          this._setSaveIndicator("saved");
        } catch (e) {
          this._setSaveIndicator(navigator.onLine ? "error" : "offline");
        } finally {
          this.autoSaving = false;
        }
      }, opts.now ? 0 : 700);
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
        this._onSyncDone(r);
        if (State.pins.some(p => p.pendingOpId || (p.attachments || []).some(a => a.pendingOpId))) {
          alert("일부 핀 업로드에 실패했습니다. 네트워크를 확인하고 다시 시도해 주세요.");
          btn.disabled = false; btn.textContent = "🚀 뷰어로 배포";
          return;
        }
      }

      btn.disabled = true; btn.textContent = "배포 중...";
      status.classList.add("hidden"); status.classList.remove("error");

      let pagesData = [];
      try {
        if (State.fileType === "pdf" && State.pdfDoc) {
          btn.textContent = "도면 전 페이지 스냅샷 중...";
          pagesData = await PDF.snapshotAllPages(State.pdfDoc);
        } else if (State.fileType === "image") {
          const imgEl = UI.$("map-image");
          const off = document.createElement("canvas");
          const maxDim = 2000;
          const ratio = Math.min(1, maxDim / Math.max(imgEl.naturalWidth, imgEl.naturalHeight));
          off.width  = Math.round(imgEl.naturalWidth * ratio);
          off.height = Math.round(imgEl.naturalHeight * ratio);
          off.getContext("2d").drawImage(imgEl, 0, 0, off.width, off.height);
          pagesData = [off.toDataURL("image/jpeg", 0.8)];
        }
      } catch (e) {
        alert("도면 스냅샷 생성 실패: " + e.message);
        btn.disabled = false; btn.textContent = "🚀 뷰어로 배포";
        return;
      }
      if (pagesData.length === 0) {
        alert("도면이 없습니다. 먼저 도면을 업로드하세요.");
        btn.disabled = false; btn.textContent = "🚀 뷰어로 배포";
        return;
      }

      btn.textContent = "서버 저장 중...";
      // [B2] 로컬 전용 영상 blob URL은 다른 세션에서 무효 → 배포본에서 제거
      const deployablePins = State.pins.map(p => {
        const q = Object.assign({}, p);
        if (q.videoUrl) { delete q.videoUrl; q.localOnly = true; }
        return q;
      });
      try {
        const res = await fetch("/tables/deployments", {
          method: "POST",
          headers: Auth.headers(),
          body: JSON.stringify({
            title:        State.fileName || "도면",
            file_name:    State.fileName || "",
            drawing_data: pagesData[0],
            pages_data:   JSON.stringify(pagesData),
            pins:         JSON.stringify(deployablePins),
            zones:        (typeof Zones !== "undefined") ? Zones.serialize() : "[]"
          })
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        // [B1] 발급된 배포 레코드의 id를 뷰어 링크에 부여 → 특정 배포본 고정 공유
        const rec = await res.json();
        const depId = (rec && rec.id) ? rec.id : null;

        const viewerUrl = location.origin + location.pathname +
          "?mode=viewer" + (depId ? "&d=" + encodeURIComponent(depId) : "");
        // [C-LOOP1 결함1] 공유가 목적인 시스템 → 원클릭 링크 복사 버튼 제공
        status.innerHTML =
          "✅ 배포 완료! (" + pagesData.length + "페이지 / " + State.pins.length + "핀)<br>" +
          "뷰어 전용 링크:<br>" +
          "<a id='deploy-link' href='" + viewerUrl + "' target='_blank' style='color:#10b981;word-break:break-all'>" + viewerUrl + "</a><br>" +
          "<button id='btn-copy-link' type='button' style='margin-top:8px;padding:6px 14px;border-radius:8px;border:1px solid #10b981;background:transparent;color:#10b981;cursor:pointer;font-size:13px'>📋 링크 복사</button>";
        status.classList.remove("hidden");
        // 복사 버튼 핸들러 (clipboard API + execCommand 폴백)
        const copyBtn = document.getElementById("btn-copy-link");
        if (copyBtn) {
          copyBtn.addEventListener("click", async () => {
            const ok = await App._copyToClipboard(viewerUrl);
            copyBtn.textContent = ok ? "✅ 복사됨!" : "⚠ 복사 실패 — 링크를 길게 눌러 복사하세요";
            setTimeout(() => { copyBtn.textContent = "📋 링크 복사"; }, 2200);
          });
        }
      } catch (e) {
        status.textContent = "❌ 배포 실패: " + e.message;
        status.classList.add("error");
        status.classList.remove("hidden");
      } finally {
        btn.disabled = false; btn.textContent = "🚀 뷰어로 배포";
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
    async loadLatestDeployment() {
      const statusEl = UI.$("viewer-load-status");
      statusEl.textContent = "배포된 도면 불러오는 중...";

      try {
        // [B1] 링크에 배포 ID(?d=)가 있으면 그 배포본을 정확히 로드
        const params = new URLSearchParams(location.search);
        const wantId = params.get("d");
        let latest = null;

        if (wantId) {
          const r1 = await fetch("/tables/deployments/" + encodeURIComponent(wantId));
          if (r1.ok) latest = await r1.json();
        }

        // 없거나 실패 시 최신 배포본으로 폴백
        if (!latest) {
          const res = await fetch("/tables/deployments?limit=100");
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

        // 페이지 배열 복원 (신규 pages_data → 레거시 drawing_data)
        let pages = [];
        try { pages = JSON.parse(latest.pages_data || "[]"); } catch { pages = []; }
        if (!Array.isArray(pages) || pages.length === 0) pages = [latest.drawing_data];

        State.currentDeploymentId = latest.id || null;  // 노트/협업 연결
        State.fileType   = "image";
        State.viewerPages = pages;
        State.pdfPage    = 1;
        State.fileName   = latest.file_name || latest.title || "배포 도면";
        UI.text("file-name-label", State.fileName);
        UI.$("drop-hint").classList.add("hidden");
        UI.$("pdf-canvas").classList.add("hidden");

        try { State.pins = JSON.parse(latest.pins || "[]"); }
        catch { State.pins = []; }
        try { State.zones = JSON.parse(latest.zones || "[]"); }
        catch { State.zones = []; }
        try { State.annotations = JSON.parse(latest.annotations || "[]"); }
        catch { State.annotations = []; }

        const imgEl = UI.$("map-image");
        imgEl.onload = () => {
          this._showMapViewport();
          UI.renderPinList();
          UI.renderPinsOnMap();
          if (typeof Zones !== "undefined") { Zones.render(); Zones.renderList(); }  // 영역 표시
          if (typeof PdfAnno !== "undefined") PdfAnno.refresh();  // PDF 주석 복원
          if (typeof Notes !== "undefined") Notes.loadSummary();  // 핀별 이슈 카운트
        };
        imgEl.src = pages[0];
        imgEl.classList.remove("hidden");

        // [C-LOOP1 결함2] 뷰어 첫 진입 어포던스 — 핀 클릭으로 360°가 열림을 명시
        if (State.pins.length > 0) {
          statusEl.innerHTML =
            "✅ 로드 완료 (" + pages.length + "페이지 / " + State.pins.length + "개 포인트)<br>" +
            "<span style='color:var(--green)'>📍 도면 위 번호 핀을 클릭하면 360° 파노라마가 열립니다.</span>";
        } else {
          statusEl.textContent = "✅ 배포본 로드 완료 (" + pages.length + "페이지 / 포인트 없음)";
        }
        UI.renderPinList();
      } catch (e) {
        statusEl.textContent = "❌ 불러오기 실패: " + e.message;
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