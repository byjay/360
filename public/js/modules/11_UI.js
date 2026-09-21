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

    /** [항목3] 포인트 목록 펼침/접힘 토글 (아이콘 헤더/닫기 버튼 공용) */
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
      // [버그수정] 도면 미로드 화면(허브 등)에서 Notes.loadSummary→renderPinList 호출 시 요소 부재 → 가드
      if (!list) return;
      list.innerHTML = "";

      if (!State.pins || State.pins.length === 0) {
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
      // 🔴 [2026-09-17] 번호 중복 탐지 전용(표시만) — 자동 재채번 금지(마스터 명시).
      //   정본 = PinSeries.duplicateCheckboardIds (11_UI 도면 마커도 같은 함수를 쓴다).
      const dupPinIds = (typeof PinSeries !== "undefined") ? PinSeries.duplicateCheckboardIds(State.pins, curPage) : new Set();

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
        const cloudTag = pin.imageId ? ' <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12" aria-hidden="true" style="vertical-align:-1px;opacity:.7"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>' : "";
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
        // 🔴 [2026-09-17] 번호 중복 경고(표시만 — 자동 재채번 금지, 마스터 명시)
        const dupBadge = dupPinIds.has(pin.id)
          ? `<span class="pin-dup-badge" title="번호 중복 — 현장 확인 후 직접 수정하세요">중복</span>` : "";

        if (State.mode === "designer") {
          item.innerHTML = `
            <div class="pin-num">${idx + 1}</div>
            <div class="pin-info">
              <div class="pin-name">${this.escapeHtml(pin.label)}${cloudTag}${metaIcons}${issueBadge}${dupBadge}</div>
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
            <span class="pin-arrow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg></span>`;
          item.addEventListener("click", () => App.focusPin(pin, true));
        }
        list.appendChild(item);
      });
      if (typeof AllPins !== "undefined") { AllPins.syncButton(); if (AllPins.open) AllPins.render(); }
      if (typeof PinGrid !== "undefined") PinGrid.render();
      this.renderTree();
    },

    /* [사이드바 재구성] 구역 > 도면 > 영역 > 포인트 통합 트리.
       데이터(Projects.decks / State.zones / State.pins)를 읽어 렌더, 이벤트는 기존 함수에 위임.
       [WO 20260917-pin] 마스터 지시("항상 리스트가 보이게, 모든 항목에 대해") — 조건부 숨김 제거:
         · 구역: 항상 전체 표시(과거에도 이미 그랬음 — decks.forEach 는 필터 없음, 유지).
         · 영역/핀: 과거엔 State.pdfPage 와 일치하는 것만 표시했다 → 다른 페이지 항목이 안 보였다.
           이제 로드된 구역(=State.currentDeploymentId 와 일치)의 전체 페이지 영역/핀을 항상 표시하고,
           현재 페이지 항목만 .active 로 "구분"한다(숨기지 않는다).
         · 로드되지 않은 구역(다른 배포본)은 클라이언트에 zone/pin 데이터 자체가 없으므로
           개수 배지를 붙이지 않는다(하드코딩 금지 — 없는 값을 0으로 지어내지 않는다). */
    renderTree() {
      const host = this.$("side-tree");
      if (!host) return;
      const esc = (s) => this.escapeHtml(s);
      const C = '<svg class="tree-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';
      const ICO = {
        deck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
        doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
        pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>'
      };
      const decks = (typeof Projects !== "undefined" && Projects.decks) || [];
      host.innerHTML = "";
      if (!decks.length) { host.innerHTML = '<p class="tree-empty">구역이 없습니다.<br>위 도구의 ‘구역 생성’으로 추가하세요.</p>'; return; }
      const curPage = State.pdfPage || 1;
      const totalPages = State.mode === "viewer"
        ? (State.viewerPages ? State.viewerPages.length : 1)
        : (State.pdfPages || 1);
      const showPageTag = totalPages > 1;
      const pageTag = (pg) => showPageTag ? ' <span class="tree-label-sub">P' + (pg || 1) + '</span>' : "";
      const pinNode = (p) => {
        const n = document.createElement("button");
        n.className = "tree-node tree-node-pin" + (State.activePin === p.id ? " active" : "");
        const noteIco = p.note ? '<svg class="tree-note" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>' : "";
        n.innerHTML = ICO.pin + '<span class="tree-label">' + esc(p.label || "포인트") + '</span>' + pageTag(p.page) + noteIco;
        if (p.note) n.title = "" + p.note;
        n.addEventListener("click", () => { if (typeof App !== "undefined") { if (App.focusPin) App.focusPin(p, true); else if (App.onPinTap) App.onPinTap(p); } });
        return n;
      };
      decks.forEach((deck) => {
        const isCur = typeof Projects !== "undefined" && Projects.currentDeck && Projects.currentDeck.id === deck.id;
        // [WO 20260917-pin] 이 구역의 도면이 '실제로 로드된 도면'인지(=State 에 zone/pin 데이터가 실존)
        //   isCur(선택됨)와는 별개 — 선택 직후 비동기 로딩 중엔 isLoaded 가 false 인 게 정상(가짜 데이터 금지).
        const isLoaded = !!(deck.deployment_id && deck.deployment_id === State.currentDeploymentId);
        const g = document.createElement("div");
        g.className = "tree-deck" + (isLoaded ? " open" : ""); // [항목2] 기본 펼침(로드된 구역)
        const head = document.createElement("button");
        head.className = "tree-node tree-node-deck" + (isCur ? " active" : "");
        // [B4] '도면없음'(구역에 도면 미등록) 과 '미저장'(로컬에만 있고 서버 미반영)을 구분 표시
        const _unsaved = (typeof App !== "undefined" && App.isDeckUnsaved) ? App.isDeckUnsaved(deck.id) : false;
        const _tag = _unsaved
          ? '<span class="tree-tag tree-tag-unsaved" title="로컬에만 있음 — ‘저장’을 눌러 서버에 반영하세요">미저장</span>'
          : (deck.deployment_id ? "" : '<span class="tree-tag" title="이 구역에 등록된 도면이 없습니다 — 구역을 눌러 도면을 등록하세요">도면없음</span>');
        // [항목4] 구역별 영역 수 배지 — 로드된 구역만(미로드 구역은 실제 개수를 모른다·0 날조 금지)
        const zoneCntTag = isLoaded ? '<span class="tree-cnt" title="영역 수">' + (State.zones || []).length + '</span>' : "";
        head.innerHTML = C + ICO.deck + '<span class="tree-label">' + esc(deck.name || "구역") + '</span>' + _tag + zoneCntTag;
        head.addEventListener("click", () => {
          if (isCur) { g.classList.toggle("open"); }
          else if (typeof Projects !== "undefined" && Projects.selectDeck) Projects.selectDeck(deck);
        });
        g.appendChild(head);
        // [WO 20260917-pin] 로드된 구역이면 전체 페이지의 영역/핀을 항상 표시(과거: 현재 페이지만).
        //   State(도면/영역/핀)는 전역이라 다른 구역엔 데이터가 없으므로 isLoaded 구역에서만 하위 렌더.
        if (isLoaded) {
          const kids = document.createElement("div");
          kids.className = "tree-children";
          const fname = State.fileName || (deck.deployment_id ? "등록 도면" : null);
          if (fname) {
            const dn = document.createElement("div");
            dn.className = "tree-node tree-node-doc";
            dn.innerHTML = ICO.doc + '<span class="tree-label">' + esc(fname) + '</span>';
            kids.appendChild(dn);
          }
          const zones = State.zones || []; // 전체 페이지(필터 없음)
          const pins = State.pins || [];   // 전체 페이지(필터 없음)
          const used = new Set();
          zones.forEach((zone) => {
            const zpage = zone.page || 1;
            const isCurZonePage = zpage === curPage;
            const zpins = pins.filter((p) => (p.page || 1) === zpage &&
              ((typeof Zones !== "undefined" && Zones._contains) ? Zones._contains(zone, p.x, p.y) : false));
            zpins.forEach((p) => used.add(p.id));
            const zn = document.createElement("div");
            zn.className = "tree-zone open"; // [항목2] 기본 펼침
            const zh = document.createElement("button");
            // [항목3][항목5] 현재 페이지 영역 = .active 로 "구분"(숨기지 않음). 클릭 동작은 기존 그대로.
            zh.className = "tree-node tree-node-zone" + (isCurZonePage ? " active" : "");
            zh.innerHTML = C + '<span class="tree-dot" style="background:' + (zone.color || "#888") + '"></span><span class="tree-label">' + esc(zone.label || "영역") + '</span>' + pageTag(zpage) + '<span class="tree-cnt" title="핀 수">' + zpins.length + '</span>';
            zh.addEventListener("click", (e) => {
              if (e.target.closest(".tree-caret")) { zn.classList.toggle("open"); return; }
              if (typeof Zones !== "undefined" && Zones.focus) Zones.focus(zone.id);
            });
            zn.appendChild(zh);
            const zc = document.createElement("div");
            zc.className = "tree-children";
            zpins.forEach((p) => zc.appendChild(pinNode(p)));
            zn.appendChild(zc);
            kids.appendChild(zn);
          });
          pins.filter((p) => !used.has(p.id)).forEach((p) => kids.appendChild(pinNode(p)));
          g.appendChild(kids);
        }
        host.appendChild(g);
      });
    },

    renderPinsOnMap(dropPinId) {
      const layer = this.$("pins-layer");
      layer.innerHTML = "";
      const curPage = State.pdfPage;
      // 🔴 번호/부류/색상 정본 = PinSeries (01b_PinSeries.js). 여기서 따로 세지 않는다.
      //    미니맵(07_Radar)도 같은 함수를 호출하므로 두 화면의 번호가 항상 일치한다.
      const numMap = PinSeries.numbers(State.pins, curPage);
      PinSeries.renderChips();
      let svgIdx = 0; // SVG gradient id 유일화용(필터로 건너뛰어도 충돌 없게 별도 카운터)
      State.pins.forEach((pin) => {
        if ((pin.page || 1) !== curPage) return; // 현재 페이지 핀만
        // 표시 필터: 숨김은 "표시만" 감춘다 — 번호(numMap)는 이미 전체 기준으로 계산됨
        if (!PinSeries.isVisible(pin)) return;
        svgIdx++;
        const pageIdx = svgIdx;
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
        const meta = numMap.get(pin.id) || { no: pageIdx, kind: PinSeries.kindOf(pin) };
        // 🔴 색·형태 정본 = PinSeries.markerStyle (미니맵 07_Radar 도 같은 함수를 쓴다).
        //    체크보드 핀은 kind 가 늘 "checkboard" 라 kind 만으로는 사진 유무를 알 수 없다
        //    → filled 축을 따로 받아 등록/미등록을 색·링 패턴으로 구분한다.
        const _st = PinSeries.markerStyle(pin);
        const hasContent = _st.filled;
        // 🔴 [2026-09-21 WO] 위성 배지 3종(이슈·중복·작성자) 제거 — 마스터 지시("거추장스런 거 지워").
        //   이슈/중복 정보는 버리지 않는다: PinActionPop(27_PinActionPop.js open())과
        //   #pin-list(renderPinList, 위 pin-issue-badge/pin-dup-badge)에서 계속 보인다.
        //   작성자 대역 정보도 PinActionPop meta 줄로 이관(PinSeries.userMark 그대로 재사용).
        if (hasContent) marker.classList.add("has-content");
        if (pin.checkboard) marker.classList.add("checkboard"); // [체크보드 핀 색상구분] 일반 핀과 다른 색으로 표시
        marker.classList.add("pin-marker-teardrop"); // 진짜 핀(물방울) 모양 + 중앙 번호
        marker.classList.add("pin-kind-" + meta.kind); // 색맹 대비: 색 외 식별 훅
        // ── 번호: 콘텐츠 계열 / 체크보드 계열이 각각 1부터 독립 채번(PinSeries 정본) ──
        const dispNo = meta.no;
        marker.dataset.no = dispNo;
        marker.dataset.kind = meta.kind;
        marker.dataset.filled = _st.filled ? "1" : "0"; // 사진 등록 여부(미니맵과 동일 판정 검증용)
        marker.classList.add(_st.filled ? "pin-filled" : "pin-hollow");
        // [WO 20260917 콘텐츠 3상태] photo(사진/영상) / content(노트·첨부만) / empty — filled 축은
        // 안 건드리고 그 안(filled=true)을 세분. 색 없이도(흑백) 구분되게 속 원판 실루엣(pin-tier-disc) 사용.
        const tier = _st.tier || (typeof PinSeries !== "undefined" ? PinSeries.contentTier(pin) : (hasContent ? "content" : "empty"));
        marker.dataset.tier = tier;
        marker.classList.add("pin-tier-" + tier);
        // ── 바늘형 핀(영역=골드와 색상 완전 분리):
        //    미배치(콘텐츠 없음)=선명한 코랄레드(#ef4444),
        //    콘텐츠 있음=사용자 설정 색상(기본 그린). 설정에서 변경 가능.
        //    바늘을 길고 가늘게 → "찌르는" 느낌. tip(18,62)으로 수렴.
        // 🔴 색상도 PinSeries 정본에서 파생 — 미니맵 점과 같은 색을 쓴다.
        const _col = _st.colors;
        const headFill  = _col.head;
        const headFill2 = _col.head2;
        const needleTip = _col.needle;
        const txtFill   = _col.text;
        // 색만으로 구분 금지(색맹 8%) → 외곽 링 패턴으로도 구분:
        // 실선=콘텐츠 등록 / 파선=체크보드(사진 등록됨) / 점선=미등록
        const ringDash  = _st.dash;
        // [WO 20260917 형태단서 재설계] 21px 실크기에서 작은 점(지름 2.2px)은 안 보인다(마스터 실측).
        // → 속 원판(inner disc)의 실루엣 자체를 티어별로 바꾼다: photo/empty=원, content=둥근사각형.
        // 흑백(색 제거)에서도 면적 차이로 구분되도록 인라인 fill 유지(CSS 소비자에 의존 금지).
        // [WO 2026-09-21] 마스터 직접 제안("동그라미를 겹친다든가") — photo(사진/영상)만
        // 원 2개를 겹쳐 그린다. empty 는 원 1개만 유지해 photo/empty 가 더는 "완전히 같은 원"이
        // 아니게 된다(이전엔 둘 다 단일 원이라 filled/hollow 머리색만으로 구분해야 했다).
        // 🔴 p9 discTag 판정은 class="pin-tier-disc" 가 붙은 첫 번째 요소의 태그만 본다(circle
        // 그대로) → 회귀 없음. 겹치는 두 번째 원은 표식용(클래스 없음)이라 판정에 관여하지 않는다.
        const tierDisc = (tier === "content")
          ? `<rect class="pin-tier-disc" x="9.8" y="6.8" width="16.4" height="16.4" rx="3" fill="#ffffff" opacity="0.99"/>`
          : (tier === "photo")
            ? `<circle class="pin-tier-disc" cx="18" cy="15" r="8.6" fill="#ffffff" opacity="0.99"/><circle cx="22.6" cy="10.4" r="4.2" fill="#ffffff" opacity="0.99" stroke="#1a1a1a" stroke-width="0.8"/>`
            : `<circle class="pin-tier-disc" cx="18" cy="15" r="8.6" fill="#ffffff" opacity="0.99"/>`;
        marker.innerHTML = `
          ${hasContent ? '<div class="pin-pulse"></div>' : ''}
          <div class="pin-pin">
            <svg viewBox="0 0 36 64" xmlns="http://www.w3.org/2000/svg">
              <defs>
                <radialGradient id="pgbody${pageIdx}" cx="38%" cy="30%" r="78%">
                  <stop offset="0%" stop-color="${headFill}"/>
                  <stop offset="100%" stop-color="${headFill2}"/>
                </radialGradient>
                <linearGradient id="pgstem${pageIdx}" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color="${headFill2}"/>
                  <stop offset="100%" stop-color="${needleTip}"/>
                </linearGradient>
                <filter id="pgshadow${pageIdx}" x="-60%" y="-20%" width="220%" height="180%">
                  <feDropShadow dx="0" dy="2.2" stdDeviation="1.7" flood-color="rgba(0,0,0,.5)"/>
                </filter>
              </defs>
              <!-- ISO 접지 그림자(바닥 타원) → 360 뷰포인트가 도면 위에 '서 있는' 입체감 -->
              <ellipse cx="18" cy="60.5" rx="6.2" ry="2.3" fill="#000" opacity="0.22"/>
              <!-- 받침대 줄기: 머리에서 접지점(18,60)으로 수렴 -->
              <path d="M14.2 22 L18 60 L21.8 22 Z" fill="url(#pgstem${pageIdx})" filter="url(#pgshadow${pageIdx})"/>
              <!-- [대비강화] 도면(촘촘한 선) 위에서도 또렷하게: 진한 외곽 링 -->
              <circle cx="18" cy="15" r="12.4" fill="none" stroke="#1a1a1a" stroke-width="3.2" opacity="0.5"${ringDash ? ` stroke-dasharray="${ringDash}" stroke-linecap="round"` : ""}/>
              <!-- 메달리온 머리 -->
              <circle cx="18" cy="15" r="11.8" fill="${_st.filled ? `url(#pgbody${pageIdx})` : "none"}" stroke="${_st.filled ? "#ffffff" : headFill2}" stroke-width="${_st.filled ? 2.4 : 3.2}"/>
              <!-- [마스터 요청 N10] 오빗 링 제거 — 숫자만 크고 또렷하게. 흰 디스크 확대 + 번호 확대 -->
              <!-- [WO 20260917 형태단서] 속 원판 실루엣으로 티어 구분(원=photo/empty, 둥근사각형=content) -->
              ${tierDisc}
              ${(typeof PinIcons !== "undefined" && pin.icon && pin.icon !== "number" && PinIcons.headMarkup(pin.icon, txtFill, 15)) || `<text x="18" y="15.4" text-anchor="middle" dominant-baseline="central"
                    font-family="'Segoe UI',sans-serif" font-size="13" font-weight="900"
                    fill="${txtFill}">${dispNo}</text>`}
              <!-- 머리 하이라이트(광택) -->
              <ellipse cx="14" cy="10.5" rx="3.4" ry="2.1" fill="#ffffff" opacity="0.5"/>
            </svg>
          </div>`;
          /* [마스터 요청] 핀 위 hover 액션버튼(.pin-actions) 제거 — 상단 "포인트 수정" 모드로 일원화.
             수정/이동/삭제/보기는 포인트수정 모드에서 핀 클릭 → PinActionPop 으로. */
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
              Prompt.toast("'" + pin.label + "' 위치 이동됨 · 자동저장");
              App._autoSave();
            }
          };
          const onDown = (ev) => {
            if (State.placing) return; // 배치 모드에서는 드래그 비활성
            if (State.isoView) { Prompt.toast("ISO 3D 뷰에서는 위치 이동이 불가합니다. 평면 뷰로 전환하세요."); return; }
            // ── 요청사항 #6: '수정' 버튼으로 잠금 해제한 핀만 드래그 이동 가능 ──
            if (State.pinEditUnlocked !== pin.id) {
              // 잠긴 상태 → 클릭으로만 동작(보기). 이동하려면 수정 버튼을 눌러야 함.
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
            // ── 포인트 수정 모드: 핀 클릭 → 수정/이동/삭제/보기 팝업(기존 유지) ──
            if (State.editMode && typeof PinActionPop !== "undefined") {
              App.setActivePin(pin.id);
              PinActionPop.open(pin.id);
            } else {
              // ── [마스터 요청] 핀 선택 → ISO 전환 + 구역 확대(첫 탭), 같은 핀 둘째 탭 → 360° ──
              App.onPinTap(pin);
            }
          });
          // ── 길게 누르기(롱프레스) → 사진 있는 핀도 작업 팝업(수정/이동/삭제) 진입 ──
          //   (모바일에서 사진 핀의 편집 경로 확보 · 데스크톱은 우클릭으로도 진입)
          let _lpTimer = null;
          const _openMenu = () => {
            if (State.pinEditUnlocked === pin.id) return;
            App.setActivePin(pin.id);
            if (typeof PinActionPop !== "undefined") PinActionPop.open(pin.id);
          };
          marker.addEventListener("pointerdown", () => {
            clearTimeout(_lpTimer);
            _lpTimer = setTimeout(_openMenu, 550);
          });
          ["pointerup", "pointerleave", "pointercancel"].forEach(ev =>
            marker.addEventListener(ev, () => clearTimeout(_lpTimer)));
          marker.addEventListener("contextmenu", (e) => { e.preventDefault(); _openMenu(); });
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
                Prompt.toast("'" + pin.label + "' 이동 잠금 해제 — 핀을 드래그하세요");
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
            // [마스터 요청] 뷰어도 동일: 첫 탭 → ISO+구역 확대, 둘째 탭 → 360°
            App.onPinTap(pin);
          });
        }
        layer.appendChild(marker);
      });
      if (typeof Zones !== "undefined") Zones.render();
      if (typeof PdfAnno !== "undefined") PdfAnno.refresh();
      // ── [마스터 요청] 렌더 직후에도 ISO면 핀을 즉시 수직(빌보드)으로 세움 ──
      if (typeof MapCtrl !== "undefined" && MapCtrl._applyPinBillboard) MapCtrl._applyPinBillboard();
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
      // 모바일 도크 '페이지' 칩에 현재 n/N 배지 (멀티페이지만)
      const pageBadge = this.$("mdock-page-badge");
      if (pageBadge) {
        if ((total || 1) > 1) { pageBadge.textContent = State.pdfPage + "/" + total; pageBadge.classList.remove("hidden"); }
        else pageBadge.classList.add("hidden");
      }
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
        const docRef = State.pdfDoc;
        strip.innerHTML = "";
        // 1) 버튼(틀)은 전부 즉시 생성 — 클릭/번호는 곧바로 동작
        const items = [];
        for (let p = 1; p <= State.pdfPages; p++) {
          const item = document.createElement("button");
          item.className = "pdf-thumb-item";
          item.dataset.page = p;
          item.title = p + " 페이지";
          item.innerHTML =
            `<canvas class="pdf-thumb-canvas"></canvas><span class="pdf-thumb-no">${p}</span>`;
          item.addEventListener("click", () => App._gotoPage(p));
          strip.appendChild(item);
          items.push(item);
        }
        // 2) [성능] 모든 페이지를 한꺼번에 순차 렌더하면 1~3초 지연 → 처음 보이는 8장만 즉시,
        //    나머지는 유휴 시간에 한 장씩(도면이 바뀌면 즉시 중단). 첫 표시 체감 즉각.
        const FIRST = 8;
        const head = Math.min(FIRST, State.pdfPages);
        for (let p = 1; p <= head; p++) this._renderThumbInto(items[p - 1].querySelector("canvas"), p);
        if (State.pdfPages > FIRST) {
          const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 200));
          const step = (p) => {
            if (this._thumbDocId !== docRef || p > State.pdfPages) return; // 도면 전환/끝 → 중단
            this._renderThumbInto(items[p - 1].querySelector("canvas"), p);
            idle(() => step(p + 1));
          };
          idle(() => step(FIRST + 1));
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