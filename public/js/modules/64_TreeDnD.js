/** [WO 20261016-treednd] 트리 구역 "끌어서 순서·위치 바꾸기" — Windows/VS Code 탐색기와 같은 방식.
 *  🔴 네이티브 HTML5 draggable 이 아니라 포인터(pointerdown/move/up + touch) 기반 커스텀 드래그다 —
 *  이유: 길게누르기(터치 0.5초)·삽입선·접힌 노드 자동펼침(0.6초)·가장자리 자동스크롤을 마우스/터치
 *  양쪽에서 하나의 로직으로 통일해야 하고, 네이티브 DnD 는 터치를 지원하지 않는다.
 *  순수 계산(zoneFor/selfAndDescendants/wouldCycle/siblingsOf/computeMove/computeStep)과 DOM 배선
 *  (attach/_beginDrag/...)을 분리한다 — 순수 함수는 테스트(tests/p158-tree-dnd.test.mjs)가 vm 으로
 *  그대로 평가해 I/O 없이 검증한다.
 *  서버가 최종 판정(순환·mode·원본고정 — src/index.tsx PATCH /api/decks/:id/move, SoT)이고, 여기
 *  순수 함수들은 "미리보기"만 한다(§10 신뢰 경계) — 서버와 같은 알고리즘을 쓰지만 결과가 달라도
 *  서버 응답(400)이 최종이다. */
(function () {
  const TreeDnD = {
    EDGE_PX: 36,          // 자동 스크롤 발동 가장자리 폭(px)
    HOVER_EXPAND_MS: 600, // 접힌 노드 위 머무름 → 자동 펼침
    LONGPRESS_MS: 500,    // 터치 길게 누르기 → 드래그 시작
    MOVE_THRESH_PX: 6,    // 마우스 — 눌린 뒤 이 거리 이상 움직여야 드래그로 간주(클릭 오탐 방지)

    /* ══ 순수 함수 — 서버(deckSelfAndDescendantIds/deckSiblingIds, src/index.tsx)와 같은 알고리즘 ══ */

    /** rect 안에서 clientY 위치로 before(위 1/4)/after(아래 1/4)/into(가운데) 판정. */
    zoneFor(rect, clientY) {
      if (!rect || !rect.height) return "into";
      const rel = (clientY - rect.top) / rect.height;
      if (rel < 0.25) return "before";
      if (rel > 0.75) return "after";
      return "into";
    },

    /** rootId 자신 + 모든 후손(parent_id 체인, 임의 깊이)의 id 문자열 집합 — 순환 금지 판정용. */
    selfAndDescendants(decks, rootId) {
      const childrenOf = new Map();
      (decks || []).forEach((d) => {
        if (!d) return;
        const p = d.parent_id != null ? String(d.parent_id) : "";
        if (!childrenOf.has(p)) childrenOf.set(p, []);
        childrenOf.get(p).push(String(d.id));
      });
      const out = new Set([String(rootId)]);
      const stack = [String(rootId)];
      let guard = 0;
      while (stack.length && guard++ < 5000) {
        const cur = stack.pop();
        (childrenOf.get(cur) || []).forEach((ch) => { if (!out.has(ch)) { out.add(ch); stack.push(ch); } });
      }
      return out;
    },

    /** movingId 를 targetParentId 아래로 옮기면 순환(자기 자신·자기 후손 아래)인지. */
    wouldCycle(decks, movingId, targetParentId) {
      if (targetParentId == null) return false;
      if (String(targetParentId) === String(movingId)) return true;
      return this.selfAndDescendants(decks, movingId).has(String(targetParentId));
    },

    /** [WO 20261106-outline] 🔴 공유 지점(SoT) — 형제 정렬 공식(sort_order→level_no→created_at)을
     *  한 곳에만 둔다. siblingsOf(아래)와 11_UI.js outlineNumbers(트리 계층 번호 1/1.1/1.1.1…)가
     *  함께 쓴다 — 각자 계산하면 번호와 실제 트리 순서가 갈라진다(§SoT). 순수 비교자(decks 2개 → 숫자). */
    compareSiblings(a, b) {
      const ord = (d) => { const so = d.sort_order; if (so != null) return so; const ln = d.level_no; return ln != null ? ln : 999999; };
      const diff = ord(a) - ord(b);
      if (diff) return diff;
      return (a.created_at || 0) - (b.created_at || 0);
    },

    /** 같은 부모(parentId)를 둔, excludeId 를 뺀 형제 id 목록 — 서버 GET 정렬과 같은 기준
     *  (COALESCE(sort_order, level_no, 999999), created_at). 미리보기 전용. */
    siblingsOf(decks, parentId, excludeId) {
      const norm = (v) => (v != null ? String(v) : null);
      const pid = norm(parentId);
      const exId = excludeId != null ? String(excludeId) : null;
      return (decks || [])
        .filter((d) => d && norm(d.parent_id) === pid && (exId == null || String(d.id) !== exId))
        .slice()
        .sort((a, b) => this.compareSiblings(a, b))
        .map((d) => String(d.id));
    },

    /** 드래그 결과를 서버 PATCH 바디({parent_id, index})로 환산. zone: before/after/into.
     *  "가운데(into)" 는 그 구역의 맨 끝(마지막 하위)으로 넣는다. 실패 시 {error}. */
    computeMove(decks, movingId, targetId, zone) {
      const byId = new Map((decks || []).map((d) => [String(d.id), d]));
      const moving = byId.get(String(movingId));
      const target = byId.get(String(targetId));
      if (!moving || !target) return { error: "invalid" };
      if (String(targetId) === String(movingId)) return { error: "self" };
      if (zone === "into") {
        if (this.wouldCycle(decks, movingId, targetId)) return { error: "cycle" };
        const siblings = this.siblingsOf(decks, targetId, movingId);
        return { parent_id: String(targetId), index: siblings.length };
      }
      const parentId = target.parent_id != null ? String(target.parent_id) : null;
      if (parentId != null && this.wouldCycle(decks, movingId, parentId)) return { error: "cycle" };
      const siblings = this.siblingsOf(decks, parentId, movingId);
      let idx = siblings.indexOf(String(targetId));
      if (idx < 0) idx = siblings.length;
      if (zone === "after") idx += 1;
      return { parent_id: parentId, index: idx };
    },

    /** 키보드 대체([위로 이동]/[아래로 이동]) — 한 칸 위/아래. 이미 끝이면 null(이동 없음). */
    computeStep(decks, deckId, dir) {
      const byId = new Map((decks || []).map((d) => [String(d.id), d]));
      const deck = byId.get(String(deckId));
      if (!deck) return null;
      const parentId = deck.parent_id != null ? String(deck.parent_id) : null;
      const full = this.siblingsOf(decks, parentId, null); // 자기 포함 — 현재 순서
      const i = full.indexOf(String(deckId));
      if (i < 0) return null;
      const j = dir === "down" ? i + 1 : i - 1;
      if (j < 0 || j >= full.length) return null;
      return { parent_id: parentId, index: j };
    },

    /** ⋯ 메뉴 비활성 판정(숨김 금지, 비활성+사유) — 열람자는 0(호출부가 애초에 메뉴를 안 그린다),
     *  원본은 고정, 오프라인은 비활성+사유. */
    canDrag(ctx) {
      ctx = ctx || {};
      if (ctx.isReadonly) return { ok: false, reason: null };
      if (ctx.isOrigin) return { ok: false, reason: "원본 도면은 최상위에 고정되어 있어 이동할 수 없습니다" };
      if (ctx.online === false) return { ok: false, reason: "오프라인이라 지금은 구역 순서를 바꿀 수 없습니다 — 연결 후 다시 시도하세요" };
      return { ok: true, reason: null };
    },

    /* ══ 서버 호출 + 토스트[되돌리기] — 드래그·키보드 양쪽이 공유 ══ */

    /** @returns {Promise<boolean>} 성공 여부. opts.silent 면 토스트를 띄우지 않는다(되돌리기 자기호출용). */
    async _applyMove(deck, decksSnapshot, target, opts) {
      opts = opts || {};
      const prevParentId = deck.parent_id != null ? String(deck.parent_id) : null;
      const fullBefore = this.siblingsOf(decksSnapshot, prevParentId, null);
      const prevIndex = fullBefore.indexOf(String(deck.id));
      let res;
      try {
        res = await fetch("/api/decks/" + deck.id + "/move", {
          method: "PATCH",
          headers: Object.assign({ "Content-Type": "application/json" }, (typeof Auth !== "undefined" && Auth.headers) ? Auth.headers() : {}),
          body: JSON.stringify({ parent_id: target.parent_id, index: target.index })
        });
      } catch (e) {
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("네트워크 오류 — 이동하지 못했습니다");
        return false;
      }
      let body = null;
      try { body = await res.json(); } catch (e) {}
      if (!res.ok) {
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast((body && body.error) || "이동 실패");
        return false;
      }
      if (typeof Projects !== "undefined" && Projects.loadDecks) await Projects.loadDecks();
      if (!opts.silent && typeof Prompt !== "undefined" && Prompt.toast) {
        Prompt.toast("'" + (deck.name || "구역") + "' 이동됨", 5000, {
          action: {
            label: "되돌리기",
            onClick: () => this._applyMove(deck, decksSnapshot, { parent_id: prevParentId, index: prevIndex }, { silent: true })
          }
        });
      }
      return true;
    },

    /** 키보드 — 위/아래 한 칸. */
    async applyStep(deck, decks, dir) {
      const target = this.computeStep(decks, deck.id, dir);
      if (!target) {
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast(dir === "down" ? "이미 맨 아래입니다" : "이미 맨 위입니다");
        return;
      }
      await this._applyMove(deck, decks, target);
    },

    /** 키보드 — 다른 구역 아래로(가운데 drop 과 동일 — 맨 끝에 삽입). */
    async applyInto(deck, decks, targetId) {
      const target = this.computeMove(decks, deck.id, targetId, "into");
      if (target.error) {
        if (typeof Prompt !== "undefined" && Prompt.toast) {
          Prompt.toast(target.error === "cycle" ? "그 구역 자신이나 하위로는 이동할 수 없습니다" : "이동할 수 없습니다");
        }
        return;
      }
      await this._applyMove(deck, decks, target);
    },

    /** [위로 이동]/[아래로 이동]/[다른 구역 아래로 이동…] — 11_UI.deckMenuItems()가 호출. */
    moveUnderPrompt(deck, decks) {
      if (typeof UI === "undefined" || !UI.openTreeMenu) return;
      const exclude = this.selfAndDescendants(decks, deck.id);
      const candidates = (decks || []).filter((d) => d && !exclude.has(String(d.id)));
      if (!candidates.length) {
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("이동할 수 있는 다른 구역이 없습니다");
        return;
      }
      const items = candidates.map((d) => ({
        label: d.name || "(이름 없음)",
        run: () => this.applyInto(deck, decks, d.id)
      }));
      const fakeAnchor = {
        getBoundingClientRect: () => {
          const w = (typeof window !== "undefined" && window.innerWidth) || 800;
          const h = (typeof window !== "undefined" && window.innerHeight) || 600;
          const cx = w / 2, cy = h / 2;
          return { left: cx - 140, right: cx + 140, top: cy - 20, bottom: cy + 20, width: 280, height: 0 };
        }
      };
      UI.openTreeMenu(fakeAnchor, "'" + (deck.name || "구역") + "' 을 다음 구역 아래로 이동", items);
    },

    /* ══ DOM 배선 — 포인터 기반 커스텀 드래그(마우스 즉시 / 터치 0.5초 길게누르기) ══ */

    /** 11_UI.deckNode()가 각 구역/영역 head 버튼마다 호출.
     *  @param {HTMLElement} head  .tree-node-deck/.tree-node-region 버튼
     *  @param {object} deck
     *  @param {Array} decks   렌더 시점 전체 decks(미리보기 계산용)
     *  @param {{isReadonly:boolean, isOrigin:boolean, online:boolean, collapsedSet:Set, groupEl:HTMLElement}} ctx */
    attach(head, deck, decks, ctx) {
      if (!head) return;
      ctx = ctx || {};
      if (ctx.isReadonly) return; // [열람자는 0] 리스너 자체를 붙이지 않는다(어포던스 없음).
      head.classList.toggle("tree-dnd-pinned", !!ctx.isOrigin);
      let downX = 0, downY = 0, pending = false, longPressTimer = null;
      const clear = () => {
        pending = false;
        clearTimeout(longPressTimer);
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("touchmove", onMove);
        document.removeEventListener("touchend", onUp);
      };
      const start = () => {
        const canGo = this.canDrag(ctx);
        if (!canGo.ok) { if (canGo.reason && typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast(canGo.reason); clear(); return; }
        this._beginDrag(deck, decks, downX, downY, head, ctx);
      };
      const onMove = (ev) => {
        const p = ev.touches ? ev.touches[0] : ev;
        if (!p) return;
        if (pending) {
          const dx = p.clientX - downX, dy = p.clientY - downY;
          const isTouchEv = !!ev.touches;
          if (Math.hypot(dx, dy) > this.MOVE_THRESH_PX) {
            if (isTouchEv) { clear(); return; } // 터치: 길게누르기 전 움직임 = 스크롤 의도, 드래그 취소
            pending = false; clearTimeout(longPressTimer); start();
          } else { return; }
        }
        if (this._session) { if (ev.preventDefault) ev.preventDefault(); this._onDragMove(p.clientX, p.clientY); }
      };
      const onUp = () => {
        const wasDragging = !!this._session;
        clear();
        if (wasDragging) this._onDrop();
      };
      const onDown = (ev) => {
        if (ev.button != null && ev.button !== 0) return;
        const isTouch = !!ev.touches || ev.pointerType === "touch";
        const p = ev.touches ? ev.touches[0] : ev;
        downX = p.clientX; downY = p.clientY; pending = true;
        if (isTouch) {
          longPressTimer = setTimeout(() => { if (pending) { pending = false; start(); } }, this.LONGPRESS_MS);
        }
        document.addEventListener("pointermove", onMove, { passive: false });
        document.addEventListener("pointerup", onUp);
        document.addEventListener("touchmove", onMove, { passive: false });
        document.addEventListener("touchend", onUp);
      };
      head.addEventListener("pointerdown", onDown);
    },

    _makeIndicator() {
      const el = document.createElement("div");
      el.className = "tree-dnd-indicator";
      document.body.appendChild(el);
      return el;
    },

    _beginDrag(deck, decks, x, y, headEl) {
      const host = document.getElementById("side-tree");
      this._session = {
        deck, decks, host,
        indicator: this._makeIndicator(),
        hoverKey: null, hoverTimer: null,
        scrollDir: 0
      };
      document.body.classList.add("tree-dnd-active");
      headEl.classList.add("tree-dnd-dragging");
      this._onKeyEsc = (e) => { if (e.key === "Escape") this._cancelDrag(); };
      document.addEventListener("keydown", this._onKeyEsc);
      this._armAutoScroll();
    },

    _armAutoScroll() {
      const step = () => {
        const s = this._session;
        if (!s) return;
        if (s.scrollDir && s.host) s.host.scrollTop += s.scrollDir * 10;
        this._scrollRAF = requestAnimationFrame(step);
      };
      this._scrollRAF = requestAnimationFrame(step);
    },

    _nodeUnder(x, y) {
      const els = (document.elementsFromPoint ? document.elementsFromPoint(x, y) : []);
      for (const el of els) {
        const head = el.closest ? el.closest(".tree-node-deck, .tree-node-region") : null;
        if (head) return head;
      }
      return null;
    },

    _onDragMove(x, y) {
      const s = this._session;
      if (!s) return;
      // 가장자리 자동 스크롤
      if (s.host) {
        const r = s.host.getBoundingClientRect();
        s.scrollDir = (y < r.top + this.EDGE_PX) ? -1 : (y > r.bottom - this.EDGE_PX) ? 1 : 0;
      }
      const head = this._nodeUnder(x, y);
      if (!head) { this._showIndicator(null); return; }
      const targetId = head.dataset ? head.dataset.deckId : null;
      if (!targetId) { this._showIndicator(null); return; }
      const rect = head.getBoundingClientRect();
      const zone = this.zoneFor(rect, y);
      const result = this.computeMove(s.decks, s.deck.id, targetId, zone);
      this._showIndicator({ head, rect, zone, valid: !result.error, result, targetId });
      // 접힌 노드 위 0.6초 머물면 펼침(가운데 drop 판정일 때만 의미가 있다)
      const key = targetId + ":" + zone;
      if (zone === "into" && key !== s.hoverKey) {
        clearTimeout(s.hoverTimer);
        s.hoverKey = key;
        const g = head.closest(".tree-deck, .tree-region");
        s.hoverTimer = setTimeout(() => { if (g && !g.classList.contains("open")) g.classList.add("open"); }, this.HOVER_EXPAND_MS);
      } else if (zone !== "into") {
        clearTimeout(s.hoverTimer);
        s.hoverKey = null;
      }
    },

    _showIndicator(info) {
      const s = this._session;
      if (!s || !s.indicator) return;
      if (!info) { s.indicator.style.display = "none"; s.pending = null; return; }
      s.pending = info.valid ? { targetId: info.targetId, zone: info.zone, result: info.result } : null;
      const el = s.indicator;
      el.classList.toggle("tree-dnd-invalid", !info.valid);
      el.style.display = "block";
      if (info.zone === "into") {
        el.className = "tree-dnd-indicator tree-dnd-indicator-into" + (info.valid ? "" : " tree-dnd-invalid");
        el.style.left = info.rect.left + "px"; el.style.top = info.rect.top + "px";
        el.style.width = info.rect.width + "px"; el.style.height = info.rect.height + "px";
      } else {
        const y = info.zone === "before" ? info.rect.top : info.rect.bottom;
        el.className = "tree-dnd-indicator tree-dnd-indicator-line" + (info.valid ? "" : " tree-dnd-invalid");
        el.style.left = info.rect.left + "px"; el.style.top = (y - 1) + "px";
        el.style.width = info.rect.width + "px"; el.style.height = "2px";
      }
    },

    async _onDrop() {
      const s = this._session;
      this._endSession();
      if (!s || !s.pending) return;
      await this._applyMove(s.deck, s.decks, s.pending.result);
    },

    _cancelDrag() {
      this._endSession();
      if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("이동 취소됨");
    },

    _endSession() {
      const s = this._session;
      this._session = null;
      if (this._scrollRAF) cancelAnimationFrame(this._scrollRAF);
      if (this._onKeyEsc) document.removeEventListener("keydown", this._onKeyEsc);
      document.body.classList.remove("tree-dnd-active");
      document.querySelectorAll(".tree-dnd-dragging").forEach((el) => el.classList.remove("tree-dnd-dragging"));
      if (s && s.indicator && s.indicator.parentNode) s.indicator.parentNode.removeChild(s.indicator);
      if (s) clearTimeout(s.hoverTimer);
    }
  };

  if (typeof window !== "undefined") window.TreeDnD = TreeDnD;
  if (typeof module !== "undefined" && module.exports) module.exports = TreeDnD;
})();
