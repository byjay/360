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

    /* ── [WO 20260929-bulkdel] 관리자 핀 일괄삭제 — 선택 상태 SoT(트리 핀 노드 · 핀 목록 패널 공유) ──
       권한 판정 = App.canBulkDeletePins()(Auth.isAdmin 재사용). 삭제 = App.deletePins → 단건과 같은 _removePins. */
    _pinSel: { on: false, ids: new Set() },
    _pinBulkOk() { return typeof App !== "undefined" && !!App.canBulkDeletePins && App.canBulkDeletePins(); },
    /** 렌더 직전 정리 — 권한이 없으면 선택 모드 해제, 이미 사라진 핀 id 는 선택에서 제거 */
    _syncPinSel() {
      const s = this._pinSel;
      if (!this._pinBulkOk()) { s.on = false; s.ids.clear(); return s; }
      const live = new Set((State.pins || []).map(p => String(p.id)));
      Array.from(s.ids).forEach(k => { if (!live.has(k)) s.ids.delete(k); });
      return s;
    },
    setPinSelectMode(on) {
      this._pinSel.on = !!on && this._pinBulkOk();
      this._pinSel.ids.clear();
      this.renderPinList();
    },
    togglePinSelected(id) {
      const k = String(id), ids = this._pinSel.ids;
      if (ids.has(k)) ids.delete(k); else ids.add(k);
      this.renderPinList();
    },
    /** 일괄삭제 버튼 묶음(공유 생성기) — opts.scopePins/scopeLabel 이 있으면 "범위 전체 삭제" 버튼도 만든다. */
    _pinBulkButtons(opts) {
      opts = opts || {};
      const s = this._pinSel;
      const out = [];
      const mk = (label, cls, fn, title) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "btn-mini" + (cls ? " " + cls : "");
        b.textContent = label;
        if (title) b.title = title;
        b.addEventListener("click", (e) => { if (e && e.stopPropagation) e.stopPropagation(); fn(b); });
        return b;
      };
      const finish = (n) => { if (n > 0) { s.on = false; s.ids.clear(); this.renderPinList(); } };
      out.push(mk(s.on ? "선택 종료" : "선택", "pin-bulk-toggle", () => this.setPinSelectMode(!s.on), "여러 포인트를 골라 한꺼번에 삭제(관리자)"));
      if (s.on) {
        const n = s.ids.size;
        const del = mk("선택 삭제 " + n + "개", "danger pin-bulk-del", async () => {
          finish(await App.deletePins(Array.from(s.ids)));
        });
        del.disabled = n === 0;
        out.push(del);
      }
      const scope = Array.isArray(opts.scopePins) ? opts.scopePins : null;
      if (scope && scope.length) {
        out.push(mk((opts.scopeLabel || "이 구역") + " 핀 전체 삭제 (" + scope.length + ")", "danger pin-bulk-scope", async () => {
          finish(await App.deletePins(scope.map(p => p.id), { scopeLabel: opts.scopeLabel || "이 구역" }));
        }));
      }
      return out;
    },

    renderPinList() {
      const list  = this.$("pin-list");
      const empty = this.$("pin-empty");
      const badge = this.$("pin-count-badge");
      // [WO 20260930-fixmode] 모드 = 작업공간 — 목록·카운트·"N PINS" 는 활성 모드 핀만(SoT: PinSeries.modePins).
      const modePins = (typeof PinSeries !== "undefined" && PinSeries.modePins) ? PinSeries.modePins(State.pins) : (State.pins || []);
      this._updatePinListCount(modePins.length);
      // [버그수정] 도면 미로드 화면(허브 등)에서 Notes.loadSummary→renderPinList 호출 시 요소 부재 → 가드
      if (!list) return;
      list.innerHTML = "";
      const sel = this._syncPinSel();
      const selecting = sel.on && this._pinBulkOk();

      if (!modePins.length) {
        empty.classList.remove("hidden");
        badge.classList.add("hidden");
        this.hide("section-export");
        if (typeof AllPins !== "undefined") { AllPins.syncButton(); if (AllPins.open) AllPins.render(); }
        if (typeof PinGrid !== "undefined") PinGrid.render();
        this.renderTree();   // [WO 20260929-bulkdel] 마지막 핀까지 지워도 트리가 옛 핀을 남기지 않게(종전 조기 return 이 건너뜀)
        return;
      }
      // [WO 20260929-bulkdel] 관리자 일괄삭제 도구줄(목록 맨 위) — 비관리자에겐 DOM 자체를 만들지 않는다
      const mountBulkBar = () => {
        if (!this._pinBulkOk()) return;
        const bar = document.createElement("div");
        bar.className = "pin-bulk-bar";
        this._pinBulkButtons().forEach(b => bar.appendChild(b));
        list.insertBefore(bar, list.firstChild);
      };
      empty.classList.add("hidden");
      badge.textContent = modePins.length + " PINS";
      badge.classList.remove("hidden");
      if (State.mode === "designer") this.show("section-export");

      const totalPages = State.mode === "viewer"
        ? (State.viewerPages ? State.viewerPages.length : 1)
        : State.pdfPages;

      // 다중 페이지 도면: 현재 페이지의 핀만 목록에 표시(페이지별 완벽 구분)
      const curPage = State.pdfPage || 1;
      const isMulti = totalPages > 1;
      const visiblePins = isMulti
        ? modePins.filter(p => (p.page || 1) === curPage)
        : modePins;
      // 🔴 [2026-09-17] 번호 중복 탐지 전용(표시만) — 자동 재채번 금지(마스터 명시).
      //   정본 = PinSeries.duplicateCheckboardIds (11_UI 도면 마커도 같은 함수를 쓴다).
      const dupPinIds = (typeof PinSeries !== "undefined") ? PinSeries.duplicateCheckboardIds(State.pins, curPage) : new Set();

      // 현재 페이지에 핀이 없으면 안내(다른 페이지에 핀이 있을 수 있음)
      if (isMulti && visiblePins.length === 0) {
        const other = modePins.length;
        empty.classList.remove("hidden");
        const et = empty.querySelector(".pin-empty-sub") || empty;
        list.innerHTML = `<p class="pin-empty-page">현재 페이지(P${curPage})에 등록된 포인트가 없습니다.${other ? ` 다른 페이지에 ${other}개의 포인트가 있습니다.` : ""}</p>`;
        badge.textContent = modePins.length + " PINS";
        badge.classList.remove("hidden");
        if (State.mode === "designer") this.show("section-export");
        if (typeof AllPins !== "undefined") { AllPins.syncButton(); if (AllPins.open) AllPins.render(); }
        if (typeof PinGrid !== "undefined") PinGrid.render();
        mountBulkBar();      // 트리에서 다른 페이지 핀을 골랐어도 [선택 삭제]는 여기서도 보인다
        this.renderTree();   // [WO 20260929-bulkdel] 종전 조기 return 이 트리 갱신을 건너뛰었다
        return;
      }

      mountBulkBar();
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
          // [WO 20260929-bulkdel] 선택 모드(관리자): 체크박스 + 행 클릭 = 선택 토글(이동/오픈 대신)
          if (selecting) {
            const picked = sel.ids.has(String(pin.id));
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.className = "pin-sel";
            cb.checked = picked;
            cb.setAttribute("aria-label", "'" + (pin.label || "포인트") + "' 선택");
            cb.addEventListener("click", e => { e.stopPropagation(); this.togglePinSelected(pin.id); });
            item.insertBefore(cb, item.firstChild);
            item.classList.toggle("selected", picked);
            item.addEventListener("click", () => this.togglePinSelected(pin.id));
            list.appendChild(item);
            return;
          }
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

    /* [사이드바 재구성] 🔴 마스터 확정 계층(2026-09-21 정정 — 3단):
         프로젝트 > 구역(parent_id IS NULL 인 deck) > 영역(parent_id = 구역 id 인 deck) > 핀
       데이터(Projects.currentProject / Projects.decks / State.zones / State.pins)를 읽어 렌더,
       이벤트는 기존 함수(Projects.selectDeck / Zones.focus / App.focusPin)에 그대로 위임한다.

       [WO 20260921-tree3] 🔴 "도면"은 트리 단계가 아니다(마스터 정정):
         · 직전 커밋(eeeab36)이 세운 4단(프로젝트>도면>구역>영역)을 3단으로 되돌린다.
         · decks.parent_id(마이그레이션 0025, 프로덕션 적용 완료)는 그대로 쓴다 —
           parent_id NULL = 구역, parent_id 있음 = 영역. 이 구조는 3단과 정확히 맞는다.
         · 🔴 도면 출처 정보는 버리지 않는다 — 트리 "단"에서 빼고(2026-09-28: 부가 라벨도
           같은 파일명이 반복되며 이름을 가려 마스터가 재지적 → title 툴팁으로 재이동),
           구역/영역 노드의 head.title(docLabel())로 남긴다(아래 deckNode 참조).
         · 도면 이름 정본 = API 가 JOIN 해 준 deployment_file_name/deployment_title.
           없으면 현재 로드된 도면의 State.fileName, 그래도 없으면 일반 표기("등록 도면").
           🔴 없는 이름을 지어내지 않는다.
         · parent_id 가 가리키는 부모가 목록에 없으면(삭제됨) 최상위로 승격 — 숨기지 않는다.

       [WO 20260917-pin] 마스터 지시("항상 리스트가 보이게, 모든 항목에 대해") — 조건부 숨김 없음:
         · 구역/영역: 항상 전체 표시(필터 없음).
         · 영역JSON(State.zones)/핀: 전체 페이지를 항상 표시하고, 현재 페이지 항목만 .active 로 "구분"한다.
         · 로드되지 않은 구역(다른 배포본)은 클라이언트에 zone/pin 데이터 자체가 없으므로
           개수 배지를 붙이지 않는다(하드코딩 금지 — 없는 값을 0으로 지어내지 않는다). */
    /** [WO 20260928-hub-tree] 🔴 공유 지점(SoT) — 구역/영역 분류 규칙은 여기 한 곳에만 둔다.
     *  사이드바 트리(renderTree, 아래)와 허브 카드(12_ProjectHub.js)가 이 함수를 함께 쓴다.
     *  parent_id 가 가리키는 부모가 없거나(삭제됨) 자기참조면 최상위로 승격(숨김 금지).
     *  @param {Array} decks
     *  @returns {{roots: Array, childrenOf: Map<string, Array>}} */
    groupDecksByParent(decks) {
      decks = decks || [];
      const byId = new Map();
      decks.forEach((d) => byId.set(String(d.id), d));
      const parentKey = (d) => {
        const pid = d.parent_id != null ? String(d.parent_id) : "";
        return (pid && pid !== String(d.id) && byId.has(pid)) ? pid : "";
      };
      const childrenOf = new Map();
      decks.forEach((d) => {
        const pid = parentKey(d);
        if (!pid) return;
        if (!childrenOf.has(pid)) childrenOf.set(pid, []);
        childrenOf.get(pid).push(d);
      });
      const roots = decks.filter((d) => !parentKey(d));
      return { roots, childrenOf };
    },

    /** [WO 20260929-tree-label] 🔴 공유 지점(SoT) — 트리 라벨은 항상 deck.name(파일명이 아니다).
     *  마스터 지적: "이 트리가 제대로 제목이 안나오잖아" — 사이드바 트리(renderTree)와 허브 카드
     *  트리(12_ProjectHub.js)가 각자 이름 폴백을 따로 구현하면 반드시 갈라진다(§5) — 이 함수 하나만 쓴다.
     *  @returns {string} 이스케이프된 HTML — 이름 있으면 그대로, 없으면 "(이름 없음)" */
    deckLabelHtml(deck) {
      const esc = (s) => this.escapeHtml(s);
      return (deck && deck.name) ? esc(deck.name) : '<span class="tree-name-missing">(이름 없음)</span>';
    },

    renderTree() {
      const host = this.$("side-tree");
      if (!host) return;
      /* [WO 20260928-tree-expand] 🔴 마스터: "구역·영역이 리스트로, 기본 펼침" —
         접기/펼치기는 유지하되 기본값은 항상 열림. 상태는 세션 메모리(this._treeCollapsed,
         deck.id 키 — 전역 프로젝트 구분 없는 localStorage 금지, 1e71772 핀필터 사고 재발 방지)
         에만 남긴다. 새로고침하면 초기화되고, deck.id 는 프로젝트별로 유일하므로 다른
         프로젝트 설정이 새어 들어올 수 없다. */
      const collapsed = this._treeCollapsed || (this._treeCollapsed = new Set());
      const esc = (s) => this.escapeHtml(s);
      const C = '<svg class="tree-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';
      const ICO = {
        project: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
        deck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
        region: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13" aria-hidden="true"><path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/></svg>',
        pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>'
      };
      const decks = (typeof Projects !== "undefined" && Projects.decks) || [];
      host.innerHTML = "";
      /* [WO 20260929-tree1] 🔴 공유 지점 — 프로젝트 트리 노드(이름 + 다운로드/삭제 버튼 흡수)를
       *  만드는 코드 한 벌. 구역이 0개라도(빈 프로젝트) 이 노드는 그대로 있어야 한다 — 예전엔
       *  별도 박스(#section-projects)라 구역 수와 무관하게 항상 보였다. 흡수하면서 그 보장까지
       *  깨면 안 된다(§10 SoT — 아래 두 호출부가 각자 만들면 반드시 갈라진다). */
      const proj = (typeof Projects !== "undefined" && Projects.currentProject) || null;
      const mountProjectNode = (rootCount) => {
        const pw = document.createElement("div");
        pw.className = "tree-project open";
        const ph = document.createElement("button");
        ph.className = "tree-node tree-node-project";
        ph.innerHTML = C + ICO.project + '<span class="tree-label">' + esc(proj.name || "프로젝트") + '</span>'
          + (rootCount != null ? '<span class="tree-cnt" title="구역 수">' + rootCount + '</span>' : "");
        ph.addEventListener("click", (e) => {
          if (e && e.target && e.target.closest && e.target.closest(".tree-caret")) { pw.classList.toggle("open"); return; }
          pw.classList.add("open");
          if (typeof Projects !== "undefined" && Projects.openOriginal) Projects.openOriginal();
        });
        pw.appendChild(ph);
        /* [WO 20260929-tree1] 🔴 근본수정(2차, CDP 실측) — #project-actions(실 DOM)를 트리 안으로
         *  "이동"시키면(appendChild) 다음 renderTree() 호출의 `host.innerHTML=""` 가 그 노드를
         *  통째로 파괴한다(2번째 렌더부터 getElementById('project-actions') 가 null — 영구 소실,
         *  재생성 불가). 트리는 매 렌더 새로 그려지는 1회성 DOM이라 안에 "살아있는 원본"을
         *  두면 안 된다(이 함수의 다른 모든 노드도 매번 새로 만든다 — 같은 규칙을 따른다).
         *  대신 대리 버튼을 매번 새로 만들어, 원래 자리(#section-projects, CSS로 항상 숨김)에
         *  그대로 남은 진짜 버튼을 .click() 으로 호출한다 — 리스너 재구현 0(31_Projects.init()
         *  이 원래 버튼에 붙인 로직 그대로 실행), 새 버튼 DOM만 매 렌더 재생성(다른 트리 노드와
         *  동일 패턴). */
        const actions = document.createElement("div");
        actions.className = "tree-project-actions";
        const proxyBtn = (label, targetId, extraCls) => {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "btn-mini" + (extraCls ? " " + extraCls : "");
          b.textContent = label;
          b.addEventListener("click", (e) => {
            if (e && e.stopPropagation) e.stopPropagation();
            const t = document.getElementById(targetId);
            if (t) t.click();
          });
          return b;
        };
        actions.appendChild(proxyBtn("다운로드", "btn-download-project"));
        actions.appendChild(proxyBtn("프로젝트 삭제", "btn-delete-project", "danger"));
        pw.appendChild(actions);
        host.appendChild(pw);
        return pw;
      };
      if (!decks.length) {
        if (!proj) { host.innerHTML = '<p class="tree-empty">구역이 없습니다.<br>위 도구의 ‘구역 생성’으로 추가하세요.</p>'; return; }
        const pw = mountProjectNode(0);
        /* [WO 20260929-tree1] 🔴 근본수정 — 31_Projects._renderSideTreeEmpty() 가 #side-tree.innerHTML
         *  을 직접 덮어써 renderTree() 가 방금 여기 붙인 #project-actions(실 DOM, 리스너 보유)를
         *  통째로 파괴하는 결함을 실측(CDP)으로 발견했다: appendChild 로 옮긴 노드가 다른 함수의
         *  innerHTML 대입에 지워지면 영영 사라진다(getElementById 도 못 찾음 — 재생성 불가).
         *  근본 원인은 "#side-tree 를 두 함수가 각자 그린다"였다(§10 SoT 위반) → 그 CTA 안내를
         *  여기 한 곳으로 합친다. _renderSideTreeEmpty() 는 이제 이 함수로 위임만 한다(아래 정의). */
        const empty = document.createElement("div");
        empty.className = "side-tree-empty";
        if (typeof State !== "undefined" && State.fileType) {
          empty.innerHTML = '<p class="side-tree-empty-msg">도면이 등록됐습니다.<br>도면에서 <b>영역을 지정</b>해 구역을 만드세요.</p>'
            + '<button type="button" class="side-tree-empty-cta" id="side-tree-make-deck-region">+ 영역 지정해 구역 만들기</button>';
        } else {
          empty.innerHTML = '<p class="side-tree-empty-msg">이 프로젝트에 구역이 없습니다.<br>도면을 등록한 뒤, 도면에서 <b>영역을 지정</b>하면 구역이 만들어집니다.</p>'
            + '<button type="button" class="side-tree-empty-cta" id="side-tree-create-deck">+ 구역 생성</button>';
        }
        pw.appendChild(empty);
        const rb = document.getElementById("side-tree-make-deck-region");
        if (rb) rb.addEventListener("click", () => { if (typeof Projects !== "undefined" && Projects.extractRegionAsDeck) Projects.extractRegionAsDeck(); });
        const cb = document.getElementById("side-tree-create-deck");
        if (cb) cb.addEventListener("click", () => { if (typeof Projects !== "undefined" && Projects.createDeck) Projects.createDeck(); });
        return;
      }
      const curPage = State.pdfPage || 1;
      const totalPages = State.mode === "viewer"
        ? (State.viewerPages ? State.viewerPages.length : 1)
        : (State.pdfPages || 1);
      const showPageTag = totalPages > 1;
      const pageTag = (pg) => showPageTag ? ' <span class="tree-label-sub">P' + (pg || 1) + '</span>' : "";
      /* [WO 20260928-tree-pinlist] 🔴 번호 SoT = PinSeries.numbers()(01b_PinSeries.js) —
         여기서 직접 채번하지 않는다(도면 마커·미니맵과 항상 같은 번호가 나오게).
         numbers() 는 페이지 1개 기준이라, 트리는 전체 페이지를 항상 보여주므로(WO 20260917-pin)
         핀에 등장하는 모든 page 값에 대해 한 번씩 돌려 병합한다(핀 id 는 전역 유일이라 충돌 없음). */
      const numbersAcrossPages = (pins) => {
        const map = new Map();
        if (typeof PinSeries === "undefined" || !PinSeries.numbers) return map;
        const pages = new Set((pins || []).map((p) => p.page || 1));
        pages.forEach((pg) => { PinSeries.numbers(pins, pg).forEach((v, k) => map.set(k, v)); });
        return map;
      };
      const pinNode = (p, numMap) => {
        const n = document.createElement("button");
        n.className = "tree-node tree-node-pin" + (State.activePin === p.id ? " active" : "");
        const noteIco = p.note ? '<svg class="tree-note" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>' : "";
        const meta = numMap ? numMap.get(p.id) : null;
        // [WO 20260930-fixmode] 표시 번호 포맷 SoT = PinSeries.formatNo(CHECKER "1" / 360 "P1") — 핀 패널 헤더(27_PinActionPop)와 같은 표기.
        const noTxt = meta ? ((PinSeries.formatNo ? PinSeries.formatNo(meta.no, meta.series) : String(meta.no))) : "";
        const noLabel = meta ? '<span class="tree-pin-no">#' + esc(noTxt) + '</span>' : "";
        n.innerHTML = ICO.pin + noLabel + '<span class="tree-label">' + esc(p.label || "포인트") + '</span>' + pageTag(p.page) + noteIco;
        if (p.note) n.title = "" + p.note;
        // [WO 20260929-bulkdel] 선택 모드(관리자): 버튼 안에 input 을 둘 수 없어 aria-pressed + 표시 기호로 선택 상태를 나타낸다
        if (selecting) {
          const picked = pinSel.ids.has(String(p.id));
          n.setAttribute("aria-pressed", picked ? "true" : "false");
          n.classList.toggle("selected", picked);
          n.insertAdjacentHTML("afterbegin", '<span class="tree-sel-box" aria-hidden="true">' + (picked ? "☑" : "☐") + '</span>');
          n.addEventListener("click", () => this.togglePinSelected(p.id));
          return n;
        }
        n.addEventListener("click", () => { if (typeof App !== "undefined") { if (App.focusPin) App.focusPin(p, true); else if (App.onPinTap) App.onPinTap(p); } });
        return n;
      };
      const pinSel = this._syncPinSel();
      const selecting = pinSel.on && this._pinBulkOk();

      /* ── 계층 인덱스 ── [WO 20260928-hub-tree] 공유 함수(groupDecksByParent, SoT)로 이관 ── */
      const curDeck = (typeof Projects !== "undefined" && Projects.currentDeck) || null;
      const { roots: rootDecks, childrenOf: allChildrenOf } = this.groupDecksByParent(decks);
      const docLabel = (depId) => {
        if (!depId) return "도면 미등록";
        const hit = decks.find((d) => String(d.deployment_id || "") === String(depId) && (d.deployment_file_name || d.deployment_title));
        if (hit) return hit.deployment_file_name || hit.deployment_title;
        if (String(depId) === String(State.currentDeploymentId || "") && State.fileName) return State.fileName;
        return "등록 도면";
      };

      /* 같은 도면을 여러 deck(구역/영역)이 가리키므로 State(영역JSON·핀)를 붙일 deck 을 하나로 정한다.
         선택된 deck 이 그 도면 안에 있으면 그 deck 에만, 없으면 종전대로 로드된 deck 에 붙인다. */
      const hasState = (deck) => {
        if (!deck.deployment_id || String(deck.deployment_id) !== String(State.currentDeploymentId || "")) return false;
        if (curDeck && String(curDeck.deployment_id || "") === String(deck.deployment_id)) return String(curDeck.id) === String(deck.id);
        return true;
      };

      /* ── 구역/영역 노드(같은 생성기 — 깊이만 다르다) ───────────────── */
      /* [WO 20260930-fixmode] ctx = { mode(PinSeries.DECK_MODES 한 항목), childrenOf(그 모드의 구역만 묶은 계층) }.
         같은 구역(mode NULL)이 CHECKER·360 양쪽에 나오므로 강조·접힘 키·핀 목록은 모드별로 가른다. */
      const actMode = (typeof PinSeries !== "undefined" && PinSeries.activeMode) ? PinSeries.activeMode() : null;
      const deckNode = (deck, isRegion, ctx) => {
        ctx = ctx || { mode: { tag: "", series: null }, childrenOf: allChildrenOf }; // 모드 단 없음(종전 구조)
        const childrenOf = ctx.childrenOf;
        const modeActive = !actMode || actMode.tag === ctx.mode.tag;
        const isCur = modeActive && !!(curDeck && String(curDeck.id) === String(deck.id));
        const loaded = hasState(deck);
        const subDecks = childrenOf.get(String(deck.id)) || [];
        // 이 모드 작업공간의 핀만(계열 SoT = PinSeries.seriesOf). 일괄삭제 범위도 이 목록 — 다른 모드 핀을 지우지 않는다.
        const modePinsHere = (State.pins || []).filter((p) => p && (!ctx.mode.series || PinSeries.inMode(p, ctx.mode.series)));
        // [WO 20260928-tree-expand] 🔴 기본 펼침 — 사용자가 직접 닫은 적이 없으면 항상 open.
        const collapseKey = (ctx.mode.tag ? ctx.mode.tag + ":" : "") + String(deck.id);
        const g = document.createElement("div");
        g.className = (isRegion ? "tree-region" : "tree-deck") + (collapsed.has(collapseKey) ? "" : " open");
        const head = document.createElement("button");
        head.className = "tree-node " + (isRegion ? "tree-node-region" : "tree-node-deck") + (isCur ? " active" : "");
        // [B4] '도면없음'(구역에 도면 미등록) 과 '미저장'(로컬에만 있고 서버 미반영)을 구분 표시
        const _unsaved = (typeof App !== "undefined" && App.isDeckUnsaved) ? App.isDeckUnsaved(deck.id) : false;
        const _tag = _unsaved
          ? '<span class="tree-tag tree-tag-unsaved" title="로컬에만 있음 — ‘저장’을 눌러 서버에 반영하세요">미저장</span>'
          : (deck.deployment_id ? "" : '<span class="tree-tag" title="이 구역에 등록된 도면이 없습니다 — 구역을 눌러 도면을 등록하세요">도면없음</span>');
        // [항목4] 영역 수 배지 — 로드된 구역만(미로드 구역은 실제 개수를 모른다·0 날조 금지)
        const zoneCntTag = loaded ? '<span class="tree-cnt" title="영역 수">' + (State.zones || []).length + '</span>' : "";
        // [WO 20260921-tree3→20260928-tree-title] 마스터 2026-09-28 지시로 대체: 구역·영역이 같은
        //   deployment(같은 도면)를 가리켜 모든 행에 똑같은 긴 파일명이 붙으면서 정작 구별해야 할
        //   이름("ㅁ"/"ㅁㄴㅇ")이 묻혔다("이 트리가 제대로 제목이 안나오잖아"). 행에는 이름만 보이고,
        //   원본 도면 파일명은 title(네이티브 툴팁)로만 제공한다(docLabel 은 없는 이름을 지어내지
        //   않는다 — 유실이 아니라 이동).
        const docName = deck.deployment_id ? docLabel(deck.deployment_id) : null;
        // [WO 20260928-tree-expand→20260929-tree-label] 🔴 마스터: 이름이 비어 있으면 빈칸이 아니라
        // "(이름 없음)"으로 정직하게 표시(CLAUDE.md §5). SoT: UI.deckLabelHtml(deck.name, 파일명 아님).
        const _nameLabel = this.deckLabelHtml(deck);
        head.innerHTML = C + (isRegion ? ICO.region : ICO.deck) + '<span class="tree-label">' + _nameLabel + '</span>' + _tag + zoneCntTag;
        // [WO 20260929-tree-label→20260928-tree-title] 🔴 잘림 금지 — CSS 는 2줄까지만 보여주고 그
        // 이상은 줄임표라 전체 이름이 필요하면 title(네이티브 툴팁)로 항상 확인할 수 있게 한다.
        // title 엔 이름 + 원본 도면 파일명(있으면)을 함께 담아 도면 출처 정보를 유지한다.
        head.title = (deck.name ? deck.name : "(이름 없음)") + (docName ? "\n원본 도면: " + docName : "");
        // [WO 20260928-tree-expand] 열림/닫힘 토글 시 세션 메모리에 반영(사용자가 닫은 항목만 기억).
        const toggleOpen = () => { if (g.classList.toggle("open")) collapsed.delete(collapseKey); else collapsed.add(collapseKey); };
        head.addEventListener("click", (e) => {
          if (e && e.target && e.target.closest && e.target.closest(".tree-caret")) { toggleOpen(); return; }
          if (isCur) { toggleOpen(); return; }
          // 다른 모드 트리의 구역을 누르면 그 모드로 전환한 뒤 연다(모드 = 작업공간, 전환 SoT = App._setRegMode).
          if (!modeActive && typeof App !== "undefined" && App._setRegMode) App._setRegMode(ctx.mode.regMode);
          if (typeof Projects !== "undefined" && Projects.selectDeck) Projects.selectDeck(deck);
        });
        g.appendChild(head);
        // [WO 20260929-bulkdel] 관리자 전용 — 핀이 붙는(로드된) 노드에만: [선택]·[선택 삭제 N개]·[이 구역 핀 전체 삭제].
        //   범위 = 이 노드 아래 나열되는 핀 전부(State.pins — 아래 loaded 블록과 같은 목록).
        if (loaded && this._pinBulkOk() && modePinsHere.length) {
          const acts = document.createElement("div");
          acts.className = "tree-project-actions tree-pin-bulk";
          this._pinBulkButtons({ scopePins: modePinsHere.slice(), scopeLabel: isRegion ? "이 영역" : "이 구역" })
            .forEach(b => acts.appendChild(b));
          g.appendChild(acts);
        }

        const kids = document.createElement("div");
        kids.className = "tree-children";
        let any = false;
        // 3단 — 이 구역 안의 영역(parent_id = 이 구역 id 인 deck). 🔴 마스터: "구역 아래 영역이
        // 리스트로 나열돼야 한다" — 0개여도 숨기지 않고 "영역 없음"으로 알린다(구역 레벨 한정,
        // 영역 자신의 하위는 데이터가 있을 때만 표시해 기존 4단 방지 회귀(p62)를 건드리지 않는다).
        if (!isRegion) {
          if (subDecks.length) subDecks.forEach((cd) => { kids.appendChild(deckNode(cd, true, ctx)); });
          else { const eEl = document.createElement("p"); eEl.className = "tree-empty"; eEl.textContent = "영역 없음"; kids.appendChild(eEl); }
          any = true;
        } else if (subDecks.length) {
          subDecks.forEach((cd) => { kids.appendChild(deckNode(cd, true, ctx)); });
          any = true;
        }
        if (loaded) {
          const zones = State.zones || []; // 전체 페이지(필터 없음)
          const pins = State.pins || [];   // 전체 페이지(필터 없음)
          const numMap = numbersAcrossPages(pins);
          const sortByNo = (a, b) => ((numMap.get(a.id) || {}).no || 0) - ((numMap.get(b.id) || {}).no || 0);
          // [WO 20260928-tree-pinlist] 🔴 소속 = 가장 깊은(면적 작은) 영역 하나 — 겹치는 영역이
          // 있으면 바운딩박스(zone.w*zone.h, 페이지%) 가 더 작은 쪽. 못 찾으면 구역 직속.
          const zoneOfPin = new Map(); // pinId -> zone
          pins.forEach((p) => {
            const ppage = p.page || 1;
            let best = null, bestArea = Infinity;
            zones.forEach((zone) => {
              if ((zone.page || 1) !== ppage) return;
              if (!(typeof Zones !== "undefined" && Zones._contains && Zones._contains(zone, p.x, p.y))) return;
              const area = Math.max(0, +zone.w || 0) * Math.max(0, +zone.h || 0);
              if (area < bestArea) { bestArea = area; best = zone; }
            });
            if (best) zoneOfPin.set(p.id, best);
          });
          const pinsOfZone = new Map();
          zones.forEach((z) => pinsOfZone.set(z.id, []));
          const rootPins = [];
          modePinsHere.forEach((p) => {   // [WO 20260930-fixmode] 나열은 이 모드 계열 핀만(번호는 위 전체 기준)
            const z = zoneOfPin.get(p.id);
            if (z && pinsOfZone.has(z.id)) pinsOfZone.get(z.id).push(p);
            else rootPins.push(p);
          });
          zones.forEach((zone) => {
            const zpage = zone.page || 1;
            const isCurZonePage = zpage === curPage;
            const zpins = (pinsOfZone.get(zone.id) || []).slice().sort(sortByNo);
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
            zpins.forEach((p) => zc.appendChild(pinNode(p, numMap)));
            zn.appendChild(zc);
            kids.appendChild(zn);
          });
          rootPins.sort(sortByNo).forEach((p) => kids.appendChild(pinNode(p, numMap)));
          any = true;
        }
        if (any) g.appendChild(kids);
        return g;
      };

      /* ── 1단: 프로젝트 — 2단(구역)을 바로 붙인다(도면 그룹핑 단 없음, 마스터 정정) ──── */
      let mount = host;
      if (proj) {
        const pw = mountProjectNode(rootDecks.length);
        const pk = document.createElement("div");
        pk.className = "tree-children";
        pw.appendChild(pk);
        mount = pk;
      }
      /* ── 2단: 모드(CHECKER / 360) — [WO 20260930-fixmode] 마스터: "프로젝트 하단 최상단에 체커와 360으로
         구분하고 그 하위로 구역-영역". 모드 노드 클릭 = 그 모드 진입(App._setRegMode — 상단 세그먼트와 같은 SoT).
         구역은 decks.mode 로 소속(NULL = 기존 구역 → 양쪽 모두, 유실 0). ─────────────────── */
      const modeOpen = this._treeModeOpen || (this._treeModeOpen = new Set());
      const MODES = (typeof PinSeries !== "undefined" && PinSeries.DECK_MODES) || null;
      if (!MODES) { // 모드 정본 미로드(단독 모듈 하네스) — 모드 단 없이 구역부터(종전 구조)
        rootDecks.forEach((d) => mount.appendChild(deckNode(d, false)));
        return;
      }
      MODES.forEach((m) => {
        const mDecks = decks.filter((d) => PinSeries.deckInMode(d, m.tag));
        const grp = this.groupDecksByParent(mDecks);
        const isAct = !!(actMode && actMode.tag === m.tag);
        const mw = document.createElement("div");
        mw.className = "tree-mode tree-mode-" + (m.tag === "360" ? "360" : "checker") + ((!actMode || isAct || modeOpen.has(m.tag)) ? " open" : "");
        mw.dataset.mode = m.tag;
        const mh = document.createElement("button");
        mh.type = "button";
        mh.className = "tree-node tree-node-mode" + (isAct ? " active" : "");
        mh.setAttribute("aria-pressed", String(isAct));
        mh.title = m.label + " 작업공간" + (isAct ? " (현재 모드)" : " — 누르면 이 모드로 전환");
        mh.innerHTML = C + '<span class="tree-label">' + esc(m.label) + '</span><span class="tree-cnt" title="구역 수">' + grp.roots.length + '</span>';
        mh.addEventListener("click", (e) => {
          const onCaret = !!(e && e.target && e.target.closest && e.target.closest(".tree-caret"));
          if (onCaret || isAct || !actMode) {
            if (mw.classList.toggle("open")) modeOpen.add(m.tag); else modeOpen.delete(m.tag);
            return;
          }
          if (typeof App !== "undefined" && App._setRegMode) App._setRegMode(m.regMode);
        });
        mw.appendChild(mh);
        const mk = document.createElement("div");
        mk.className = "tree-children";
        if (grp.roots.length) grp.roots.forEach((d) => mk.appendChild(deckNode(d, false, { mode: m, childrenOf: grp.childrenOf })));
        else { const eEl = document.createElement("p"); eEl.className = "tree-empty"; eEl.textContent = "구역 없음"; mk.appendChild(eEl); }
        mw.appendChild(mk);
        mount.appendChild(mw);
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
        // [WO 20260929] 체크보드 모드에서는 체크보드 핀의 번호만 보이게 — 장식(펄스·그라디언트·
        // 그림자·티어 원판 모양 구분·아이콘 오버라이드) 최소화. 앵커(tip 18,60)는 원본과 동일
        // 유지해 좌표 위치가 어긋나지 않는다. 대비 쌍(흰 원판+txtFill)도 기존 검증값 그대로 재사용.
        const simplifiedCheckboard = (State.regMode === "checkboard" && pin.checkboard === true);
        marker.innerHTML = simplifiedCheckboard ? `
          <div class="pin-pin">
            <svg viewBox="0 0 36 64" xmlns="http://www.w3.org/2000/svg">
              <path d="M14.2 22 L18 60 L21.8 22 Z" fill="${headFill2}"/>
              <circle cx="18" cy="15" r="12.4" fill="${_st.filled ? headFill : "none"}" stroke="#ffffff" stroke-width="2"/>
              <circle cx="18" cy="15" r="8.6" fill="#ffffff"/>
              <text x="18" y="15.4" text-anchor="middle" dominant-baseline="central" font-family="'Segoe UI',sans-serif" font-size="${String(dispNo).length >= 3 ? 9 : 13}" font-weight="900" fill="${txtFill}">${dispNo}</text>
            </svg>
          </div>` : `
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
              <!-- [WO 20260928 번호 복구] 마스터 지시("번호가 안본다") — 9/21 지시는 "숫자 풍선"
                   (머리 밖 별도 배지)을 없애라는 뜻이었는데 머리 안 번호까지 지워 회귀가 났다.
                   상태(등록 fill/tier 원판/링 dash)는 그대로 유지하고, 흰 원판(tierDisc) 위에
                   번호만 다시 그린다 — 원판이 항상 흰색이라 txtFill(진한 계열색)과 대비 ≥4.5:1 보장.
                   3자리 이상(101~)은 원판을 넘치지 않게 폰트를 축소한다.
                   [WO 20260929 재회귀 수정] 마스터: "번호가 왜 사라졌는지" — 커스텀 아이콘을
                   고른 핀은 번호 텍스트 대신 아이콘만 그려서 여전히 번호가 안 보였다. 이제
                   아이콘 유무와 무관하게 번호는 항상 그리고, 아이콘은 버리지 않고 머리 우상단
                   모서리의 작은 보조 배지(중심은 머리 원 반경 12.4 위 45° 지점 — 표준 "아바타
                   코너 배지" 위치)로 옮긴다. 배지 아이콘 색도 txtFill 재사용(원판과 동일하게
                   대비 ≥4.5:1 이미 보장된 값이라 별도 실측 불필요 — ≥3:1 요구보다 넉넉함). -->
              <!-- [WO 20260917 형태단서] 속 원판 실루엣으로 티어 구분(원=photo/empty, 둥근사각형=content) -->
              ${tierDisc}
              <text x="18" y="15.4" text-anchor="middle" dominant-baseline="central" font-family="'Segoe UI',sans-serif" font-size="${String(dispNo).length >= 3 ? 9 : 13}" font-weight="900" fill="${txtFill}">${dispNo}</text>
              ${(typeof PinIcons !== "undefined" && pin.icon && pin.icon !== "number")
                ? `<circle class="pin-icon-badge" cx="26.8" cy="6.3" r="5.4" fill="#ffffff" stroke="${headFill2}" stroke-width="1.3"/>${PinIcons.headMarkup(pin.icon, txtFill, 6.3, 26.8, 0.32)}`
                : ""}
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
            // ── [WO 20260929 마스터 정정] 체크보드·사진등록 모드에서 기존 핀 클릭 = 항상 패널
            //   (번호수정·사진/노트 등록 가능). ISO 전환/줌(onPinTap)이 화면을 되돌리던 결함을
            //   막는다 — 핀 클릭이 배치 클릭보다 우선한다(지휘자 정정 원문, 새 핀 겹쳐 생기지 않음).
            const wantsPanel = State.editMode || State.regMode === "checkboard" || State.regMode === "photo";
            if (wantsPanel && typeof PinActionPop !== "undefined") {
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