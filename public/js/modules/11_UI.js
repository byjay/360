  const UI = {
    $:  id  => document.getElementById(id),

    show(id)  { this.$(id).classList.remove("hidden"); },
    hide(id)  { this.$(id).classList.add("hidden");    },
    toggle(id, force) {
      const el = this.$(id);
      if (force === undefined) el.classList.toggle("hidden");
      else force ? el.classList.remove("hidden") : el.classList.add("hidden");
    },
    text(id, val)  { const el = this.$(id); if (el) el.textContent = val; },
    val(id)        { return this.$(id).value; },
    clearVal(id)   { this.$(id).value = ""; },
    enable(id)     { this.$(id).disabled = false; },
    disable(id)    { this.$(id).disabled = true; },

    showScreen(name) {
      document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
      this.$(name).classList.add("active");
    },

    escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, c =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    },

    /** ★ [항목3] 포인트 목록 펼침/접힘 토글 (아이콘 헤더/닫기 버튼 공용) */
    togglePinList(force) {
      const wrap = this.$("section-pin-list");
      const toggle = this.$("pin-list-toggle");
      if (!wrap) return;
      const willOpen = (force === undefined) ? wrap.classList.contains("collapsed") : !!force;
      wrap.classList.toggle("collapsed", !willOpen);
      if (toggle) toggle.setAttribute("aria-expanded", willOpen ? "true" : "false");
    },

    /** 헤더 옆 카운트 배지 갱신 */
    _updatePinListCount(n) {
      const c = this.$("pin-list-count");
      if (!c) return;
      c.textContent = n;
      c.classList.toggle("hidden", !n);
    },

    renderPinList() {
      const list  = this.$("pin-list");
      const empty = this.$("pin-empty");
      const badge = this.$("pin-count-badge");
      this._updatePinListCount(State.pins ? State.pins.length : 0);
      list.innerHTML = "";

      if (State.pins.length === 0) {
        empty.classList.remove("hidden");
        badge.classList.add("hidden");
        this.hide("section-export");
        if (typeof AllPins !== "undefined") { AllPins.syncButton(); if (AllPins.open) AllPins.render(); }
        if (typeof PinGrid !== "undefined") PinGrid.render();
        return;
      }
      empty.classList.add("hidden");
      badge.textContent = State.pins.length + " PINS";
      badge.classList.remove("hidden");
      if (State.mode === "designer") this.show("section-export");

      const totalPages = State.mode === "viewer"
        ? (State.viewerPages ? State.viewerPages.length : 1)
        : State.pdfPages;

      // 다중 페이지 도면: 현재 페이지의 핀만 목록에 표시(페이지별 완벽 구분)
      const curPage = State.pdfPage || 1;
      const isMulti = totalPages > 1;
      const visiblePins = isMulti
        ? State.pins.filter(p => (p.page || 1) === curPage)
        : State.pins;

      // 현재 페이지에 핀이 없으면 안내(다른 페이지에 핀이 있을 수 있음)
      if (isMulti && visiblePins.length === 0) {
        const other = State.pins.length;
        empty.classList.remove("hidden");
        const et = empty.querySelector(".pin-empty-sub") || empty;
        list.innerHTML = `<p class="pin-empty-page">현재 페이지(P${curPage})에 등록된 포인트가 없습니다.${other ? ` 다른 페이지에 ${other}개의 포인트가 있습니다.` : ""}</p>`;
        badge.textContent = State.pins.length + " PINS";
        badge.classList.remove("hidden");
        if (State.mode === "designer") this.show("section-export");
        if (typeof AllPins !== "undefined") { AllPins.syncButton(); if (AllPins.open) AllPins.render(); }
        if (typeof PinGrid !== "undefined") PinGrid.render();
        return;
      }

      visiblePins.forEach((pin, idx) => {
        const item = document.createElement("div");
        item.className = "pin-item" + (State.activePin === pin.id ? " active" : "");
        item.dataset.id = pin.id;
        const pageTag = (totalPages > 1) ? ` · P${pin.page || 1}` : "";
        const cloudTag = pin.imageId ? " ☁" : "";
        // 노트/첨부 메타 아이콘
        const noteIco = pin.note ? `<svg viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>` : "";
        const attCount = pin.attachments ? pin.attachments.length : 0;
        const attIco = attCount ? `<svg viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>` : "";
        const metaIcons = (noteIco || attIco)
          ? `<span class="pin-meta-icons">${noteIco}${attIco}${attCount > 1 ? attCount : ""}</span>` : "";
        // 미해결 이슈 카운트 뱃지(이슈/필드노트)
        const openIssues = (typeof Notes !== "undefined") ? Notes.openCountFor(pin.id) : 0;
        const issueBadge = openIssues > 0
          ? `<span class="pin-issue-badge" title="미해결 이슈 ${openIssues}건">${openIssues}</span>` : "";

        if (State.mode === "designer") {
          item.innerHTML = `
            <div class="pin-num">${idx + 1}</div>
            <div class="pin-info">
              <div class="pin-name">${this.escapeHtml(pin.label)}${cloudTag}${metaIcons}${issueBadge}</div>
              <div class="pin-coords">${pin.x.toFixed(1)}%, ${pin.y.toFixed(1)}%${pageTag}</div>
            </div>
            <div class="pin-acts">
              <button class="pin-act pin-edit" data-id="${pin.id}" title="수정" aria-label="수정">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
              </button>
              <button class="pin-act pin-del" data-id="${pin.id}" title="삭제" aria-label="삭제">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
              </button>
            </div>`;
          item.querySelector(".pin-edit").addEventListener("click", e => {
            e.stopPropagation();
            App.editPin(pin.id);
          });
          item.querySelector(".pin-del").addEventListener("click", e => {
            e.stopPropagation();
            App.deletePin(pin.id);
          });
          // 디자이너 모드: 콘텐츠 있는 핀은 이동+오픈, 없는 핀은 CAD 인스펙터 상세 표시
          item.addEventListener("click", () => {
            if (App.pinHasContent(pin)) App.focusPin(pin, true);
            else if (typeof Inspector !== "undefined") { App.focusPin(pin, false); Inspector.showPin(pin); }
            else App.focusPin(pin, false);
          });
        } else {
          item.innerHTML = `
            <div class="pin-num">${idx + 1}</div>
            <div class="pin-info">
              <div class="pin-name">${this.escapeHtml(pin.label)}${cloudTag}${metaIcons}${issueBadge}</div>
              <div class="pin-coords">${pin.x.toFixed(1)}%, ${pin.y.toFixed(1)}%${pageTag}</div>
            </div>
            <span class="pin-arrow">▶</span>`;
          item.addEventListener("click", () => App.focusPin(pin, true));
        }
        list.appendChild(item);
      });
      if (typeof AllPins !== "undefined") { AllPins.syncButton(); if (AllPins.open) AllPins.render(); }
      if (typeof PinGrid !== "undefined") PinGrid.render();
    },

    renderPinsOnMap(dropPinId) {
      const layer = this.$("pins-layer");
      layer.innerHTML = "";
      const curPage = State.pdfPage;
      let pageIdx = 0; // 페이지별 1부터 시작하는 번호
      State.pins.forEach((pin) => {
        if ((pin.page || 1) !== curPage) return; // 현재 페이지 핀만
        pageIdx++;
        const marker = document.createElement("div");
        marker.className = "pin-marker" + (pin.id === dropPinId ? " drop" : "")
          + (State.activePin === pin.id ? " focused" : "");
        marker.style.left = pin.x + "%";
        marker.style.top  = pin.y + "%";
        marker.dataset.id = pin.id;
        // 구역 페이지(crop-view) 진입 중이면, 해당 구역 밖 핀은 흐리게(dim)
        if (State.zoneView) {
          const _zv = (State.zones || []).find(z => z.id === State.zoneView);
          if (_zv && typeof Zones !== "undefined" && Zones._contains && !Zones._contains(_zv, pin.x, pin.y)) {
            marker.classList.add("zone-dim");
          }
        }
        const hasContent = App.pinHasContent(pin);
        const openIssues = (typeof Notes !== "undefined") ? Notes.openCountFor(pin.id) : 0;
        const issueDot = openIssues > 0
          ? `<span class="pin-marker-issue" title="미해결 이슈 ${openIssues}건">${openIssues}</span>` : "";
        if (hasContent) marker.classList.add("has-content");
        marker.classList.add("pin-marker-teardrop"); // 진짜 핀(물방울) 모양 + 중앙 번호
        marker.dataset.no = pageIdx;
        // ── 바늘형 핀(영역=골드와 색상 완전 분리):
        //    미배치(콘텐츠 없음)=선명한 코랄레드(#ef4444),
        //    콘텐츠 있음=사용자 설정 색상(기본 그린). 설정에서 변경 가능.
        //    바늘을 길고 가늘게 → "찌르는" 느낌. tip(18,62)으로 수렴.
        const _pc = (typeof PinPrefs !== "undefined") ? PinPrefs.color() : { head:'#10b981', head2:'#047857', needle:'#064e3b', text:'#065f46' };
        const headFill  = hasContent ? _pc.head   : '#ef4444';
        const headFill2 = hasContent ? _pc.head2  : '#b91c1c';
        const needleTip = hasContent ? _pc.needle : '#7f1d1d';
        const txtFill   = hasContent ? _pc.text   : '#991b1b';
        marker.innerHTML = `
          ${hasContent ? '<div class="pin-pulse"></div>' : ''}
          <div class="pin-pin">
            <svg viewBox="0 0 36 64" xmlns="http://www.w3.org/2000/svg">
              <defs>
                <radialGradient id="pgbody${pageIdx}" cx="38%" cy="32%" r="74%">
                  <stop offset="0%" stop-color="${headFill}"/>
                  <stop offset="100%" stop-color="${headFill2}"/>
                </radialGradient>
                <linearGradient id="pgneedle${pageIdx}" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color="${headFill2}"/>
                  <stop offset="55%" stop-color="${needleTip}"/>
                  <stop offset="100%" stop-color="#1a1a1a"/>
                </linearGradient>
                <filter id="pgshadow${pageIdx}" x="-60%" y="-20%" width="220%" height="180%">
                  <feDropShadow dx="0" dy="2" stdDeviation="1.6" flood-color="rgba(0,0,0,.5)"/>
                </filter>
              </defs>
              <!-- 길고 날카로운 바늘: 머리 하단(13.6/22.4)에서 한 점(18,62)으로 수렴 -->
              <path d="M13.6 15 L18 62 L22.4 15 Z" fill="url(#pgneedle${pageIdx})" filter="url(#pgshadow${pageIdx})"/>
              <!-- 둥근 머리 -->
              <circle cx="18" cy="12" r="11" fill="url(#pgbody${pageIdx})" stroke="#ffffff" stroke-width="2.2"/>
              <circle cx="18" cy="12" r="7.3" fill="#ffffff" opacity="0.96"/>
              <text x="18" y="12.3" text-anchor="middle" dominant-baseline="central"
                    font-family="'Segoe UI',sans-serif" font-size="9.5" font-weight="800"
                    fill="${txtFill}">${pageIdx}</text>
              <!-- 머리 하이라이트(광택) -->
              <ellipse cx="14.5" cy="8" rx="3.6" ry="2.3" fill="#ffffff" opacity="0.5"/>
            </svg>
            ${issueDot}
          </div>
          <div class="pin-actions">
            ${hasContent ? '<button class="pin-act pin-act-view" data-act="view" title="360° 보기"><i class="fa-solid fa-panorama"></i></button>' : ''}
            <button class="pin-act pin-act-move" data-act="move" title="이동(드래그)"><i class="fa-solid fa-up-down-left-right"></i></button>
            <button class="pin-act pin-act-edit" data-act="edit" title="수정"><i class="fa-solid fa-pen"></i></button>
            <button class="pin-act pin-act-del" data-act="del" title="삭제"><i class="fa-solid fa-trash"></i></button>
          </div>`;
        // ── 디자이너: 포인터 드래그로 핀 위치 이동 (click 과 구분: 이동 임계값) ──
        if (State.mode === "designer") {
          marker.classList.add("draggable");
          let dragging = false, moved = false, startX = 0, startY = 0;
          const onMove = (ev) => {
            const cx = ev.touches ? ev.touches[0].clientX : ev.clientX;
            const cy = ev.touches ? ev.touches[0].clientY : ev.clientY;
            if (!dragging) return;
            if (!moved && Math.hypot(cx - startX, cy - startY) < 5) return; // 임계값 미만은 클릭으로 취급
            moved = true;
            State.movingPinId = pin.id;
            marker.classList.add("moving");
            const pct = MapCtrl.viewportToPercent(cx, cy);
            if (pct) {
              pin.x = Math.max(0, Math.min(100, pct.x));
              pin.y = Math.max(0, Math.min(100, pct.y));
              marker.style.left = pin.x + "%";
              marker.style.top  = pin.y + "%";
              const lbl = marker.querySelector(".pin-marker-label");
              // 좌표 라이브 갱신은 리스트 쪽에서 (성능 위해 드래그 끝에 한 번)
            }
            if (ev.cancelable) ev.preventDefault();
          };
          const onUp = () => {
            document.removeEventListener("pointermove", onMove);
            document.removeEventListener("pointerup", onUp);
            document.removeEventListener("touchmove", onMove);
            document.removeEventListener("touchend", onUp);
            dragging = false;
            marker.classList.remove("moving");
            if (moved) {
              State.movingPinId = null;
              State.pinEditUnlocked = null; // 이동 끝나면 다시 잠금
              if (typeof Zones !== "undefined" && Zones.refreshPinLinks) Zones.refreshPinLinks();
              UI.renderPinList();
              if (typeof Zones !== "undefined") Zones.render();
              Prompt.toast("📍 '" + pin.label + "' 위치 이동됨 · 자동저장");
              App._autoSave();
            }
          };
          const onDown = (ev) => {
            if (State.placing) return; // 배치 모드에서는 드래그 비활성
            if (State.isoView) { Prompt.toast("ISO 3D 뷰에서는 위치 이동이 불가합니다. 평면 뷰로 전환하세요."); return; }
            // ── 요청사항 #6: '수정' 버튼으로 잠금 해제한 핀만 드래그 이동 가능 ──
            if (State.pinEditUnlocked !== pin.id) {
              // 잠긴 상태 → 클릭으로만 동작(보기). 이동하려면 ✏ 수정 버튼을 눌러야 함.
              return;
            }
            startX = ev.touches ? ev.touches[0].clientX : ev.clientX;
            startY = ev.touches ? ev.touches[0].clientY : ev.clientY;
            dragging = true; moved = false;
            document.addEventListener("pointermove", onMove, { passive: false });
            document.addEventListener("pointerup", onUp);
            document.addEventListener("touchmove", onMove, { passive: false });
            document.addEventListener("touchend", onUp);
          };
          marker.addEventListener("pointerdown", onDown);
          marker.addEventListener("click", e => {
            e.stopPropagation();
            if (moved) { moved = false; return; } // 드래그 직후 클릭 무시
            if (State.pinEditUnlocked === pin.id) return; // 이동 잠금해제 상태에서는 클릭 무시(드래그 대기)
            App.setActivePin(pin.id);
            // 디자이너: 핀 클릭 → 전용 작업 팝업(이동/수정/사진추가/삭제/보기)
            if (typeof PinActionPop !== "undefined") PinActionPop.open(pin.id);
            else if (App.pinHasContent(pin)) App.openPano(pin);
          });
          // 액션 아이콘 바인딩 (보기/이동/수정/삭제)
          marker.querySelectorAll(".pin-act").forEach(btn => {
            btn.addEventListener("click", ev => {
              ev.stopPropagation();
              const act = btn.dataset.act;
              if (act === "view") App.openPano(pin);
              else if (act === "move") {
                // ── #6: 이동 잠금 해제 후 드래그 안내 ──
                State.pinEditUnlocked = pin.id;
                marker.classList.add("edit-unlocked");
                Prompt.toast("🔓 '" + pin.label + "' 이동 잠금 해제 — 핀을 드래그하세요");
              }
              else if (act === "edit") {
                // ── #6: 수정 버튼 → 편집 폼 + 이동 잠금 해제(사진추가/위치이동 가능) ──
                State.pinEditUnlocked = pin.id;
                App.editPin(pin.id);
              }
              else if (act === "del") App.deletePin(pin.id);
            });
          });
        } else {
          marker.addEventListener("click", e => {
            e.stopPropagation();
            App.openPano(pin); // 뷰어: 미디어 없으면 openPano가 안내 표시
          });
        }
        layer.appendChild(marker);
      });
      if (typeof Zones !== "undefined") Zones.render();
      if (typeof PdfAnno !== "undefined") PdfAnno.refresh();
    },

    updatePdfPagination() {
      const total = State.mode === "viewer" && State.viewerPages
        ? State.viewerPages.length : State.pdfPages;
      if (total > 1) {
        this.$("pdf-pagination").classList.remove("hidden");
        const jump = this.$("input-page-jump");
        if (jump && document.activeElement !== jump) jump.value = State.pdfPage;
        this.text("page-total", "/ " + total);
        this.$("btn-first-page").disabled = State.pdfPage <= 1;
        this.$("btn-prev-page").disabled  = State.pdfPage <= 1;
        this.$("btn-next-page").disabled  = State.pdfPage >= total;
        this.$("btn-last-page").disabled  = State.pdfPage >= total;
      } else {
        this.$("pdf-pagination").classList.add("hidden");
      }
      // 새 ezPDF 툴바 페이지 동기화 (단일 페이지도 1/1 표시)
      const tbInput = this.$("tb-page-input");
      if (tbInput && document.activeElement !== tbInput) tbInput.value = State.pdfPage;
      this.text("tb-page-total", "/ " + (total || 1));
      const setDis = (id, v) => { const el = this.$(id); if (el) el.disabled = v; };
      setDis("tb-first", State.pdfPage <= 1);
      setDis("tb-prev",  State.pdfPage <= 1);
      setDis("tb-next",  State.pdfPage >= (total || 1));
      setDis("tb-last",  State.pdfPage >= (total || 1));
    },

    /** 좌측 썸네일 도킹 패널 토글 (ezPDF 스타일) */
    toggleThumbPanel(force) {
      const strip = this.$("pdf-thumb-strip");
      const btn = this.$("tb-thumbs");
      if (!strip) return;
      const willHide = (typeof force === "boolean") ? !force : !strip.classList.contains("hidden");
      strip.classList.toggle("hidden", willHide);
      strip.classList.toggle("docked", !willHide);
      document.body.classList.toggle("thumbs-open", !willHide);
      if (btn) btn.classList.toggle("active", !willHide);
      if (!willHide && typeof this.renderPdfThumbs === "function") this.renderPdfThumbs();
    },

    /** 회전 각도 라벨 + 버튼 노출 (도면 로드 시에만 표시) */
    updateRotationLabel() {
      const grp = this.$("rotate-group");
      if (!grp) return;
      const hasDoc = !!(State.fileType && (State.pdfDoc || State.imageUrl || State.viewerPages));
      grp.classList.toggle("hidden", !hasDoc);
      const lbl = this.$("rotate-level");
      if (lbl) lbl.textContent = (State.pdfRotation || 0) + "°";
    },

    /** 멀티페이지 PDF 썸네일 스트립 (디자이너 PDF 전용) */
    async renderPdfThumbs() {
      const strip = this.$("pdf-thumb-strip");
      if (!strip) return;
      // 디자이너 PDF + 2페이지 이상에서만 표시
      const show = State.mode === "designer" && State.fileType === "pdf"
        && State.pdfDoc && State.pdfPages > 1;
      strip.classList.toggle("hidden", !show);
      if (!show) { strip.innerHTML = ""; return; }

      // 최초 1회만 썸네일 캐시 생성 (페이지 전환 시 재생성 방지)
      if (this._thumbDocId !== State.pdfDoc || strip.childElementCount !== State.pdfPages) {
        this._thumbDocId = State.pdfDoc;
        strip.innerHTML = "";
        for (let p = 1; p <= State.pdfPages; p++) {
          const item = document.createElement("button");
          item.className = "pdf-thumb-item";
          item.dataset.page = p;
          item.title = p + " 페이지";
          item.innerHTML =
            `<canvas class="pdf-thumb-canvas"></canvas><span class="pdf-thumb-no">${p}</span>`;
          item.addEventListener("click", () => App._gotoPage(p));
          strip.appendChild(item);
          // 작은 썸네일 렌더 (비차단, 순차)
          this._renderThumbInto(item.querySelector("canvas"), p);
        }
      }
      // 현재 페이지 하이라이트
      Array.from(strip.children).forEach((el) => {
        const active = Number(el.dataset.page) === State.pdfPage;
        el.classList.toggle("active", active);
        if (active) el.scrollIntoView({ block: "nearest", inline: "nearest" });
      });
    },

    async _renderThumbInto(canvas, pageNum) {
      try {
        const page = await State.pdfDoc.getPage(pageNum);
        const rot = ((page.rotate || 0) + (State.pdfRotation || 0)) % 360;
        const base = page.getViewport({ scale: 1, rotation: rot });
        const scale = 120 / Math.max(base.width, base.height); // 최대 변 120px
        const vp = page.getViewport({ scale, rotation: rot });
        canvas.width = Math.round(vp.width);
        canvas.height = Math.round(vp.height);
        await page.render({ canvasContext: canvas.getContext("2d", { alpha: false }), viewport: vp }).promise;
      } catch (e) { /* 썸네일 실패는 무시 */ }
    }
  };

  /* ══════════════════════════════════════════
     PROJECT HUB  ── 첫 화면 = 프로젝트 선택 대시보드 (상용툴 모방)
       · 로그인 안 함/뷰어: 카드 클릭 → 뷰어로 해당 프로젝트 열람
       · 디자이너/슈퍼: "+새 프로젝트" + 카드 편집/삭제, 카드 클릭 → 디자이너 작업
  ══════════════════════════════════════════ */