  /* ══════════════════════════════════════════
     REQUESTS — [WO 20261001-viewreq] 열람자 요청·질문 + 디자이너 구역별 요청함
     마스터: "열람자는 보기만 할 거다. 단 요청을 할 수 있다. 노트를 하듯이 디자이너에게 요청이나 질문은 가능하게 해"
             "그걸 디자이너는 구역별로 리스트해서 볼 수 있게 해"

     저장소 = 기존 pin_notes(새 테이블 0) · kind request|question|reply · parent_id · deck_id (마이그레이션 0034)
     · 열람자(viewer 멤버·공유/배포 링크 익명): 보기 + 요청/질문 작성 · 자기 글만 수정/삭제(익명은 수정키 X-Note-Key)
     · 핀 없는 요청 = pin_id ''(도면/구역 단위) — 링크 열람 세션은 deck 목록을 받지 않아(20_App loadLatestDeployment)
       'deck:<id>' 규약으로는 바로 그 흐름에서 키를 채울 수 없다 → 서버가 deck_id 를 확정한다(resolveNoteDeck).
     · 디자이너 요청함: 프로젝트 → 구역 → 영역 → (구역 단위 / 핀 번호). 트리 SoT = UI.groupDecksByParent.
       새 폴링 없음 — 20초 틱(App._liveTick)이 refresh() 를 부른다.
     🔴 스타일은 전부 인라인 리터럴 hex(36_Help 와 같은 규칙 — CSS 3파일·테마 변수 재해석 함정 회피).
        대비: #ffffff/#1a1712 18.7:1 · #f2ede1/#1a1712 15.6:1 · #1a1712/#c9962a 8.0:1 · 상태배지 진한 글자/연한 바탕 ≥ 7:1 ·
        #ffffff/#b91c1c 6.5:1 · #cbbfa0/#1a1712 10.4:1 · #ff8a8a/#1a1712 8.1:1
  ══════════════════════════════════════════ */
  const Requests = {
    KIND: { request: "요청", question: "질문" },
    STATUS: { open: "접수", progress: "처리중", done: "완료" },
    ROLE: { super: "관리자", designer: "디자이너", viewer: "열람자", guest: "익명" },
    STATUS_STYLE: {
      open: "background:#fecaca;color:#450a0a",
      progress: "background:#fde68a;color:#422006",
      done: "background:#bbf7d0;color:#052e16",
    },
    KIND_STYLE: {
      request: "background:#c9962a;color:#1a1712",
      question: "background:#bfdbfe;color:#0b1f44",
    },
    KEYS_LS: "wm_note_keys",       // { noteId: 수정키 } — 익명 작성자 본인 확인(서버엔 해시만)
    NAME_LS: "wm_req_author",      // 익명 이름 기억(다음 작성 편의)
    _items: [],                    // 디자이너 요청함 캐시(서버 /api/projects/:id/requests)
    _sig: "",
    _pid: null,
    _busy: false,
    _available: false,
    _inited: false,
    _inboxBtn: null,
    _viewerBtn: null,
    _panelEl: null,
    _filterOpen: true,

    /* ── 공통 ── */
    _el(tag, style, text) {
      const e = document.createElement(tag);
      if (style) e.style.cssText = style;
      if (text != null) e.textContent = String(text);
      return e;
    },
    _btn(label, style, onClick) {
      const b = this._el("button", style || "padding:7px 12px;border-radius:8px;border:1px solid #665;background:#2a2518;color:#ffffff;font-size:12.5px;cursor:pointer;font-family:sans-serif", label);
      b.type = "button";
      if (onClick) b.addEventListener("click", (e) => { if (e.stopPropagation) e.stopPropagation(); onClick(e); });
      return b;
    },
    _badge(text, style) {
      return this._el("span", "display:inline-block;padding:2px 7px;border-radius:999px;font-size:11px;font-weight:700;line-height:1.5;" + style, text);
    },
    _timeTxt(v) {
      if (typeof Notes !== "undefined" && Notes._timeAgo) return Notes._timeAgo(v);
      const d = new Date(Number(v) || Date.parse(v));
      return isNaN(d) ? "" : (d.getMonth() + 1) + "." + d.getDate();
    },
    _keys() { try { return JSON.parse(localStorage.getItem(this.KEYS_LS) || "{}") || {}; } catch (e) { return {}; } },
    _saveKey(id, key) {
      if (!id || !key) return;
      const k = this._keys(); k[id] = key;
      try { localStorage.setItem(this.KEYS_LS, JSON.stringify(k)); } catch (e) {}
    },
    _isGuest() { return typeof Auth === "undefined" || !Auth.user || !!Auth.readonly; },
    _isMine(n) {
      if (!n) return false;
      if (this._keys()[n.id]) return true;
      return !this._isGuest() && !!n.author_email && String(n.author_email).toLowerCase() === String(Auth.user.email || "").toLowerCase();
    },
    _headers(extra) {
      return (typeof Auth !== "undefined" && Auth.headers) ? Auth.headers(extra) : Object.assign({ "Content-Type": "application/json" }, extra || {});
    },
    _isDesignerView() {
      return typeof State !== "undefined" && State.mode === "designer" && !(typeof Auth !== "undefined" && Auth.readonly);
    },
    _isViewerRole() {
      try { return !!document.body.classList.contains("role-viewer"); } catch (e) { return false; }
    },

    init() {
      if (this._inited) return;
      this._inited = true;
      this._createViewerBtn();
      this._createInboxBtn();
      this.syncChrome();
    },

    /** 진입 버튼 표시 — 뷰어 = [요청·질문] 플로팅, 디자이너 = 상단 [요청함 N](프로젝트 열림 + 요청함 권한 확인됨) */
    syncChrome() {
      if (this._viewerBtn) this._viewerBtn.style.display = this._isViewerRole() ? "flex" : "none";
      if (this._inboxBtn) {
        const proj = (typeof Projects !== "undefined") ? Projects.currentProject : null;
        const show = this._isDesignerView() && this._available && !!proj && this._pid === proj.id;
        this._inboxBtn.style.display = show ? "inline-flex" : "none";
      }
    },

    _createViewerBtn() {
      const b = this._el("button", [
        "position:fixed", "left:112px", "bottom:16px", "height:40px", "padding:0 14px", "border-radius:20px", "border:none",
        "cursor:pointer", "z-index:9550", "display:none", "align-items:center", "gap:6px", "font-size:13.5px", "font-weight:700",
        "font-family:sans-serif", "box-shadow:0 4px 14px rgba(0,0,0,.3)", "background:#c9962a", "color:#1a1712",
      ].join(";"), "요청·질문");
      b.type = "button";
      b.setAttribute("data-req-viewer-entry", "1");
      b.setAttribute("aria-label", "디자이너에게 요청·질문 남기기(이 도면 전체)");
      b.title = "디자이너에게 요청·질문 남기기 — 특정 포인트에 대한 요청은 포인트를 눌러 남기세요";
      b.addEventListener("click", (e) => { if (e.stopPropagation) e.stopPropagation(); this.openViewer({}); });
      document.body.appendChild(b);
      this._viewerBtn = b;
    },

    _createInboxBtn() {
      const bar = document.getElementById("topbar");
      if (!bar) return;
      const b = this._el("button", [
        "display:none", "align-items:center", "gap:6px", "flex-shrink:0", "height:32px", "padding:0 12px", "margin:0 4px",
        "border-radius:8px", "border:none", "cursor:pointer", "font-size:13px", "font-weight:700", "font-family:sans-serif",
        "background:#c9962a", "color:#1a1712",
      ].join(";"));
      b.type = "button";
      b.id = "btn-req-inbox";
      b.setAttribute("aria-haspopup", "dialog");
      b.title = "요청함 — 열람자가 남긴 요청·질문을 구역별로 봅니다";
      b.appendChild(this._el("span", "", "요청함"));
      const cnt = this._el("span", "display:none;min-width:18px;padding:0 6px;border-radius:9px;background:#b91c1c;color:#ffffff;font-size:11.5px;line-height:18px;text-align:center");
      cnt.setAttribute("data-req-inbox-count", "1");
      b.appendChild(cnt);
      b.addEventListener("click", () => this.openInbox());
      const anchor = document.getElementById("pin-count-badge");
      if (anchor && anchor.parentNode === bar) bar.insertBefore(b, anchor); else bar.appendChild(b);
      this._inboxBtn = b;
    },

    /* ══ 디자이너 요청함 ══ */
    /** 지금 열린 프로젝트의 캐시만(프로젝트를 바꾼 직후 이전 프로젝트 배지·목록 잔류 0 — 다음 refresh 가 채운다). */
    _live() {
      const proj = (typeof Projects !== "undefined") ? Projects.currentProject : null;
      return (proj && this._pid === proj.id) ? this._items : [];
    },

    /** 서버에서 요청함을 다시 읽는다. 반환(진단용): idle|busy|offline|error|stale|same|changed */
    async refresh() {
      this.syncChrome();
      const proj = (typeof Projects !== "undefined") ? Projects.currentProject : null;
      if (!this._isDesignerView() || !proj || !proj.id) return "idle";
      if (this._busy) return "busy";
      if (typeof navigator !== "undefined" && navigator.onLine === false) return "offline";
      const pid = proj.id;
      this._busy = true;
      try {
        const r = await fetch("/api/projects/" + encodeURIComponent(pid) + "/requests", { headers: this._headers() });
        if (!Projects.currentProject || Projects.currentProject.id !== pid) return "stale";
        if (!r.ok) { this._available = false; this._items = []; this._pid = pid; this.syncChrome(); return "error"; }
        const j = await r.json();
        this._available = true;
        if (this._pid !== pid) this._sig = "";   // 프로젝트가 바뀜 — 같은 목록이어도 배지·트리를 다시 그린다
        this._pid = pid;
        this._items = Array.isArray(j.data) ? j.data : [];
        const sig = this._items.map((n) => n.id + ":" + n.status + ":" + n.updated_at).join("|");
        const changed = sig !== this._sig;
        this._sig = sig;
        this._renderInboxBtn();
        this.syncChrome();
        if (changed) {
          if (this._panelEl) this._renderInbox();
          if (typeof UI !== "undefined" && UI.renderTree) { try { UI.renderTree(); } catch (e) {} }
        }
        return changed ? "changed" : "same";
      } catch (e) {
        return "error";
      } finally {
        this._busy = false;
      }
    },

    /** 미처리(접수·처리중) 요청 수 — 답변 행 제외 */
    openCount(items) { return (items || this._live()).filter((n) => n.kind !== "reply" && n.status !== "done").length; },

    _renderInboxBtn() {
      if (!this._inboxBtn) return;
      const cnt = this._inboxBtn.querySelector("[data-req-inbox-count]");
      const n = this.openCount();
      if (cnt) { cnt.textContent = String(n); cnt.style.display = n > 0 ? "inline-block" : "none"; }
      this._inboxBtn.setAttribute("aria-label", "요청함 — 미처리 " + n + "건");
    },

    /** 요청이 속한 deck — 서버가 확정한 deck_id 우선, 없거나 이 프로젝트 deck 이 아니면 같은 배포본의 최상위 구역. 못 찾으면 null. */
    deckIdOf(n, decks) {
      decks = decks || [];
      if (n.deck_id && decks.some((d) => String(d.id) === String(n.deck_id))) return String(n.deck_id);
      const same = decks.filter((d) => d.deployment_id && String(d.deployment_id) === String(n.deployment_id));
      const root = same.find((d) => !d.parent_id) || same[0];
      return root ? String(root.id) : null;
    },

    /** 🔴 요청함 그룹핑(순수 함수) — 트리와 같은 구조: 프로젝트 → 구역 → 영역 → (구역 단위 / 핀 번호).
     *  구역/영역 분류는 UI.groupDecksByParent(SoT) 그대로. 답변(reply)은 원 요청의 replies 로 붙는다.
     *  반환: { nodes:[{deck, depth, items}], unassigned:[...], open } — nodes 는 트리 순서(구역 다음 그 영역들). */
    groupByTree(items, decks, onlyOpen) {
      decks = decks || [];
      const tops = [], repliesOf = new Map();
      (items || []).forEach((n) => {
        if (n.kind === "reply") { const k = String(n.parent_id); if (!repliesOf.has(k)) repliesOf.set(k, []); repliesOf.get(k).push(n); }
        else tops.push(n);
      });
      const ts = (v) => (typeof v === "number") ? v : (Date.parse(v) || 0);
      const withReplies = tops
        .filter((n) => !onlyOpen || n.status !== "done")
        .map((n) => Object.assign({}, n, { replies: (repliesOf.get(String(n.id)) || []).slice().sort((a, b) => ts(a.created_at) - ts(b.created_at)) }));
      const byDeck = new Map(), unassigned = [];
      withReplies.forEach((n) => {
        const did = this.deckIdOf(n, decks);
        if (!did) { unassigned.push(n); return; }
        if (!byDeck.has(did)) byDeck.set(did, []);
        byDeck.get(did).push(n);
      });
      const pinNo = (n) => { const v = parseInt(String(n.pin_label || "").replace(/^P/i, ""), 10); return Number.isFinite(v) ? v : Infinity; };
      const order = (a, b) => {
        const ap = a.pin_id ? 1 : 0, bp = b.pin_id ? 1 : 0;
        if (ap !== bp) return ap - bp;                                  // 구역 단위(핀 없음) 먼저
        if (ap && pinNo(a) !== pinNo(b)) return pinNo(a) - pinNo(b);    // 핀 번호 순
        if (ap && String(a.pin_id) !== String(b.pin_id)) return String(a.pin_id) < String(b.pin_id) ? -1 : 1;
        return ts(a.created_at) - ts(b.created_at);
      };
      const G = (typeof UI !== "undefined" && UI.groupDecksByParent) ? UI.groupDecksByParent(decks) : { roots: decks, childrenOf: new Map() };
      const nodes = [];
      const walk = (d, depth) => {
        nodes.push({ deck: d, depth, items: (byDeck.get(String(d.id)) || []).sort(order) });
        (G.childrenOf.get(String(d.id)) || []).forEach((c) => walk(c, depth + 1));
      };
      G.roots.forEach((d) => walk(d, 0));
      return { nodes, unassigned: unassigned.sort(order), open: this.openCount(items) };
    },

    /** 트리 구역/영역 노드 배지용 — 그 deck 에 직접 속한 미처리 요청 수(하위 영역 분은 그 영역 노드에). */
    openCountForDeck(deckId) {
      const items = this._live();
      if (!items.length || deckId == null) return 0;
      const decks = (typeof Projects !== "undefined" && Projects.decks) || [];
      return items.filter((n) => n.kind !== "reply" && n.status !== "done" && this.deckIdOf(n, decks) === String(deckId)).length;
    },

    openInbox() {
      this.closePanel();
      const { backdrop, panel } = this._shell("요청함", "right");
      panel.setAttribute("data-req-inbox", "1");
      const bar = this._el("div", "display:flex;gap:6px;margin:0 0 12px;flex-wrap:wrap");
      const fOpen = this._btn("미처리만", null, () => { this._filterOpen = true; this._renderInbox(); });
      const fAll = this._btn("전체", null, () => { this._filterOpen = false; this._renderInbox(); });
      fOpen.setAttribute("data-req-filter", "open"); fAll.setAttribute("data-req-filter", "all");
      bar.appendChild(fOpen); bar.appendChild(fAll);
      panel.appendChild(bar);
      const list = this._el("div", "");
      list.setAttribute("data-req-inbox-list", "1");
      panel.appendChild(list);
      this._panelEl = backdrop;
      this._renderInbox();
      this.refresh();
    },

    _renderInbox() {
      if (!this._panelEl) return;
      const panel = this._panelEl.querySelector("[data-req-inbox]");
      const list = panel && panel.querySelector("[data-req-inbox-list]");
      if (!list) return;
      panel.querySelectorAll("[data-req-filter]").forEach((b) => {
        const on = (b.getAttribute("data-req-filter") === "open") === this._filterOpen;
        b.style.background = on ? "#c9962a" : "#2a2518"; b.style.color = on ? "#1a1712" : "#ffffff";
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
      const decks = (typeof Projects !== "undefined" && Projects.decks) || [];
      const g = this.groupByTree(this._live(), decks, this._filterOpen);
      const h = panel.querySelector("[data-req-title]");
      if (h) h.textContent = "요청함 — 미처리 " + g.open + "건";
      list.innerHTML = "";
      const proj = (typeof Projects !== "undefined" && Projects.currentProject) || null;
      list.appendChild(this._el("div", "font-size:12px;color:#cbbfa0;margin:0 0 8px", "프로젝트 · " + ((proj && proj.name) || "")));
      let shown = 0;
      const section = (title, depth, items, deck) => {
        const wrap = this._el("div", "margin:0 0 12px " + (depth * 14) + "px");
        wrap.setAttribute("data-req-group", deck ? String(deck.id) : "unassigned");
        const head = this._el("div", "font-weight:700;color:#c9962a;font-size:13.5px;margin:0 0 6px", title + " (" + items.length + ")");
        wrap.appendChild(head);
        if (!items.length) wrap.appendChild(this._el("div", "font-size:12px;color:#cbbfa0", this._filterOpen ? "미처리 요청 없음" : "요청 없음"));
        items.forEach((n) => { wrap.appendChild(this._itemCard(n, deck)); shown++; });
        list.appendChild(wrap);
      };
      g.nodes.forEach((nd) => {
        const name = (nd.deck && nd.deck.name) ? nd.deck.name : "(이름 없음)";
        section((nd.depth ? "영역 · " : "구역 · ") + name, nd.depth, nd.items, nd.deck);
      });
      if (g.unassigned.length) section("구역 미지정", 0, g.unassigned, null);
      if (!g.nodes.length && !g.unassigned.length) list.appendChild(this._el("div", "font-size:13px;color:#f2ede1", "이 프로젝트에 구역이 없습니다."));
      list.setAttribute("data-req-shown", String(shown));
    },

    _itemCard(n, deck) {
      const card = this._el("div", "border:1px solid #3d3626;border-radius:10px;padding:10px;margin:0 0 8px;background:#221e16");
      card.setAttribute("data-req-item", String(n.id));
      const head = this._el("div", "display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:0 0 6px");
      head.appendChild(this._badge(this.KIND[n.kind] || n.kind, this.KIND_STYLE[n.kind] || this.KIND_STYLE.request));
      head.appendChild(this._badge(this.STATUS[n.status] || n.status, this.STATUS_STYLE[n.status] || this.STATUS_STYLE.open));
      const target = this._btn(n.pin_id ? ("#" + (n.pin_label || "포인트")) : "구역 단위",
        "padding:2px 8px;border-radius:6px;border:1px solid #c9962a;background:transparent;color:#f7d98a;font-size:12px;font-weight:700;cursor:pointer",
        () => this.goTo(n));
      target.title = "이 위치로 이동";
      target.setAttribute("data-req-goto", "1");
      head.appendChild(target);
      card.appendChild(head);
      const meta = this._el("div", "font-size:11.5px;color:#cbbfa0;margin:0 0 4px");
      meta.textContent = (n.author || "익명") + " · " + (this.ROLE[n.author_role] || n.author_role || "") + " · " + this._timeTxt(n.created_at)
        + (n.author_contact ? " · 회신 " + n.author_contact : "");
      card.appendChild(meta);
      const body = this._el("div", "font-size:13.5px;line-height:1.55;color:#ffffff;white-space:pre-wrap;word-break:break-word;cursor:pointer", n.body);
      body.addEventListener("click", () => this.goTo(n));
      card.appendChild(body);
      (n.replies || []).forEach((r) => {
        const rp = this._el("div", "margin:8px 0 0 10px;padding:6px 8px;border-left:3px solid #c9962a;background:#2a2518;border-radius:0 6px 6px 0");
        rp.setAttribute("data-req-reply", String(r.id));
        rp.appendChild(this._el("div", "font-size:11px;color:#cbbfa0", "↳ 답변 · " + (r.author || "") + " · " + this._timeTxt(r.created_at)));
        rp.appendChild(this._el("div", "font-size:13px;color:#f2ede1;white-space:pre-wrap;word-break:break-word", r.body));
        card.appendChild(rp);
      });
      const acts = this._el("div", "display:flex;gap:6px;flex-wrap:wrap;margin:8px 0 0");
      const replyBox = this._el("div", "display:none;margin:8px 0 0");
      const ta = this._el("textarea", "width:100%;box-sizing:border-box;min-height:60px;padding:8px;border-radius:8px;border:1px solid #554;background:#2a2518;color:#ffffff;font-size:13px;font-family:sans-serif");
      ta.maxLength = 4000; ta.placeholder = "답변을 입력하세요"; ta.setAttribute("data-req-reply-input", "1");
      const send = this._btn("답변 보내기", "margin-top:6px;padding:7px 12px;border-radius:8px;border:none;background:#c9962a;color:#1a1712;font-weight:700;font-size:12.5px;cursor:pointer", () => this.reply(n, ta.value));
      send.setAttribute("data-req-reply-send", "1");
      replyBox.appendChild(ta); replyBox.appendChild(send);
      const rb = this._btn("답변", null, () => { replyBox.style.display = replyBox.style.display === "none" ? "block" : "none"; if (replyBox.style.display === "block") ta.focus(); });
      rb.setAttribute("data-req-act", "reply");
      acts.appendChild(rb);
      [["progress", "처리중"], ["done", "완료"], ["open", "접수로"]].forEach(([st, label]) => {
        if (st === n.status) return;
        const b = this._btn(label, null, () => this.setStatus(n, st));
        b.setAttribute("data-req-act", st);
        acts.appendChild(b);
      });
      card.appendChild(acts);
      card.appendChild(replyBox);
      return card;
    },

    async reply(n, text) {
      const body = String(text || "").trim();
      if (!body) return false;
      try {
        const r = await fetch("/api/notes", { method: "POST", headers: this._headers(), body: JSON.stringify({ kind: "reply", parent_id: n.id, body }) });
        if (!r.ok) { Prompt.toast && Prompt.toast("답변 등록 실패(" + r.status + ")"); return false; }
        Prompt.toast && Prompt.toast("답변을 등록했습니다");
        await this.refresh();
        return true;
      } catch (e) { Prompt.toast && Prompt.toast("답변 등록 실패(네트워크)"); return false; }
    },

    async setStatus(n, status) {
      try {
        const r = await fetch("/api/notes/" + encodeURIComponent(n.id), { method: "PATCH", headers: this._headers(), body: JSON.stringify({ status }) });
        if (!r.ok) { Prompt.toast && Prompt.toast("상태 변경 실패(" + r.status + ")"); return false; }
        await this.refresh();
        return true;
      } catch (e) { Prompt.toast && Prompt.toast("상태 변경 실패(네트워크)"); return false; }
    },

    /** 요청 항목 → 그 구역/영역을 열고(이미 열려 있으면 그대로) 핀으로 이동·강조(App.focusPin = 트리 핀 클릭과 같은 경로). */
    async goTo(n) {
      const decks = (typeof Projects !== "undefined" && Projects.decks) || [];
      const did = this.deckIdOf(n, decks);
      const deck = did ? decks.find((d) => String(d.id) === did) : null;
      this.closePanel();
      if (deck && typeof Projects !== "undefined" && Projects.selectDeck && !(Projects.currentDeck && String(Projects.currentDeck.id) === did)) {
        try { await Projects.selectDeck(deck); } catch (e) {}
      }
      if (!n.pin_id) return true;
      const pin = ((typeof State !== "undefined" && State.pins) || []).find((p) => String(p.id) === String(n.pin_id));
      if (!pin) { Prompt.toast && Prompt.toast("이 포인트를 찾을 수 없습니다(삭제되었거나 다른 도면)"); return false; }
      if (typeof App !== "undefined" && App.focusPin) await App.focusPin(pin, false);
      return true;
    },

    /* ══ 열람자 요청·질문 ══ */
    /** opts: { pin?, noMedia? } — pin 없으면 도면/구역 단위 요청 */
    async openViewer(opts) {
      opts = opts || {};
      const dep = (typeof State !== "undefined") && State.currentDeploymentId;
      if (!dep) { Prompt.toast && Prompt.toast("도면을 불러온 뒤 요청을 남길 수 있습니다"); return; }
      this.closePanel();
      const pin = opts.pin || null;
      const ttl = pin ? ("포인트 #" + (pin.label || "") + " — 요청·질문") : "이 도면 — 요청·질문";
      const { backdrop, panel } = this._shell(ttl, "bottom");
      panel.setAttribute("data-req-viewer", "1");
      this._panelEl = backdrop;
      this._vctx = { dep, pin };
      if (pin && opts.noMedia) panel.appendChild(this._el("div", "font-size:12.5px;color:#cbbfa0;margin:0 0 10px", "이 지점에는 등록된 360° 사진이 없습니다. 필요한 내용을 디자이너에게 요청할 수 있습니다."));
      if (!pin) panel.appendChild(this._el("div", "font-size:12.5px;color:#cbbfa0;margin:0 0 10px", "특정 포인트에 대한 요청은 도면에서 포인트를 눌러 남기세요."));
      const list = this._el("div", "margin:0 0 12px");
      list.setAttribute("data-req-viewer-list", "1");
      list.appendChild(this._el("div", "font-size:12.5px;color:#cbbfa0", "불러오는 중…"));
      panel.appendChild(list);
      panel.appendChild(this._viewerForm());
      await this._loadViewerList();
    },

    async _loadViewerList() {
      const ctx = this._vctx;
      if (!ctx || !this._panelEl) return;
      const list = this._panelEl.querySelector("[data-req-viewer-list]");
      if (!list) return;
      let rows = [];
      try {
        const q = "/api/notes?deployment_id=" + encodeURIComponent(ctx.dep) + (ctx.pin ? "&pin_id=" + encodeURIComponent(ctx.pin.id) : "");
        const r = await fetch(q, { headers: this._headers() });
        if (r.ok) rows = ((await r.json()).data || []);
      } catch (e) {}
      if (this._vctx !== ctx) return;   // 그 사이 다른 대상으로 열림
      if (!ctx.pin) rows = rows.filter((n) => !n.pin_id);
      this.renderViewerList(list, rows);
    },

    /** 열람자 목록(순수 렌더) — 요청·질문만, 상태 배지 + 디자이너 답변 + 내 글이면 [수정][삭제]. 반환: 표시 건수 */
    renderViewerList(list, rows) {
      const tops = rows.filter((n) => n.kind === "request" || n.kind === "question");
      const repliesOf = new Map();
      rows.filter((n) => n.kind === "reply").forEach((n) => { const k = String(n.parent_id); if (!repliesOf.has(k)) repliesOf.set(k, []); repliesOf.get(k).push(n); });
      const ts = (v) => (typeof v === "number") ? v : (Date.parse(v) || 0);
      tops.sort((a, b) => ts(b.created_at) - ts(a.created_at));
      list.innerHTML = "";
      if (!tops.length) { list.appendChild(this._el("div", "font-size:12.5px;color:#cbbfa0", "아직 남긴 요청이 없습니다.")); return 0; }
      tops.forEach((n) => {
        const card = this._el("div", "border:1px solid #3d3626;border-radius:10px;padding:10px;margin:0 0 8px;background:#221e16");
        card.setAttribute("data-req-item", String(n.id));
        const head = this._el("div", "display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:0 0 6px");
        head.appendChild(this._badge(this.KIND[n.kind] || n.kind, this.KIND_STYLE[n.kind] || this.KIND_STYLE.request));
        const sb = this._badge(this.STATUS[n.status] || n.status, this.STATUS_STYLE[n.status] || this.STATUS_STYLE.open);
        sb.setAttribute("data-req-status", n.status);
        head.appendChild(sb);
        const mine = this._isMine(n);
        head.appendChild(this._el("span", "font-size:11.5px;color:#cbbfa0", (n.author || "익명") + (mine ? " (나)" : "") + " · " + this._timeTxt(n.created_at)));
        card.appendChild(head);
        const body = this._el("div", "font-size:13.5px;line-height:1.55;color:#ffffff;white-space:pre-wrap;word-break:break-word", n.body);
        card.appendChild(body);
        (repliesOf.get(String(n.id)) || []).sort((a, b) => ts(a.created_at) - ts(b.created_at)).forEach((r) => {
          const rp = this._el("div", "margin:8px 0 0 10px;padding:6px 8px;border-left:3px solid #c9962a;background:#2a2518;border-radius:0 6px 6px 0");
          rp.setAttribute("data-req-reply", String(r.id));
          rp.appendChild(this._el("div", "font-size:11px;color:#cbbfa0", "↳ 디자이너 답변 · " + (r.author || "") + " · " + this._timeTxt(r.created_at)));
          rp.appendChild(this._el("div", "font-size:13px;color:#f2ede1;white-space:pre-wrap;word-break:break-word", r.body));
          card.appendChild(rp);
        });
        if (mine) {
          const acts = this._el("div", "display:flex;gap:6px;margin:8px 0 0");
          const eb = this._btn("수정", null, () => this._editMine(n, card, body));
          eb.setAttribute("data-req-act", "edit");
          const db = this._btn("삭제", null, () => this._deleteMine(n));
          db.setAttribute("data-req-act", "delete");
          acts.appendChild(eb); acts.appendChild(db);
          card.appendChild(acts);
        }
        list.appendChild(card);
      });
      return tops.length;
    },

    _viewerForm() {
      const f = this._el("div", "border-top:1px solid rgba(255,255,255,.15);padding-top:12px");
      f.setAttribute("data-req-form", "1");
      const kindRow = this._el("div", "display:flex;gap:6px;margin:0 0 8px");
      let kind = "request";
      const kb = {};
      const paint = () => Object.keys(kb).forEach((k) => {
        const on = k === kind;
        kb[k].style.background = on ? "#c9962a" : "#2a2518"; kb[k].style.color = on ? "#1a1712" : "#ffffff";
        kb[k].setAttribute("aria-pressed", on ? "true" : "false");
      });
      Object.keys(this.KIND).forEach((k) => {
        kb[k] = this._btn(this.KIND[k], "flex:1;padding:9px;border-radius:8px;border:1px solid #665;font-weight:700;font-size:13px;cursor:pointer;font-family:sans-serif", () => { kind = k; paint(); });
        kb[k].setAttribute("data-req-kind", k);
        kindRow.appendChild(kb[k]);
      });
      paint();
      f.appendChild(kindRow);
      const field = "width:100%;box-sizing:border-box;padding:10px;margin:0 0 8px;border-radius:8px;border:1px solid #554;background:#2a2518;color:#ffffff;font-size:13.5px;font-family:sans-serif";
      const ta = this._el("textarea", field + ";min-height:84px;resize:vertical");
      ta.maxLength = 4000; ta.placeholder = "디자이너에게 요청하거나 묻고 싶은 내용을 적어주세요"; ta.setAttribute("data-req-body", "1");
      ta.setAttribute("aria-label", "요청·질문 내용");
      f.appendChild(ta);
      let nameIn = null, mailIn = null;
      if (this._isGuest()) {
        f.appendChild(this._el("div", "font-size:11.5px;color:#cbbfa0;margin:0 0 4px", "이름(필수)"));
        nameIn = this._el("input", field);
        nameIn.type = "text"; nameIn.maxLength = 60; nameIn.placeholder = "예: 홍길동 / 현장 감독"; nameIn.setAttribute("data-req-name", "1");
        nameIn.setAttribute("aria-label", "이름");
        try { nameIn.value = localStorage.getItem(this.NAME_LS) || ""; } catch (e) {}
        f.appendChild(nameIn);
        f.appendChild(this._el("div", "font-size:11.5px;color:#cbbfa0;margin:0 0 4px", "회신 받을 이메일(선택)"));
        mailIn = this._el("input", field);
        mailIn.type = "email"; mailIn.maxLength = 200; mailIn.placeholder = "example@company.com"; mailIn.setAttribute("data-req-contact", "1");
        mailIn.setAttribute("aria-label", "회신 받을 이메일");
        f.appendChild(mailIn);
      }
      const err = this._el("div", "display:none;font-size:12.5px;color:#ff8a8a;margin:0 0 8px");
      err.setAttribute("data-req-error", "1");
      f.appendChild(err);
      const send = this._btn("보내기", "width:100%;padding:12px;border-radius:10px;border:none;background:#c9962a;color:#1a1712;font-weight:700;font-size:14px;cursor:pointer;font-family:sans-serif",
        () => this.submitViewer({ kind, body: ta.value, author: nameIn ? nameIn.value : "", contact: mailIn ? mailIn.value : "" }, { ta, err, send }));
      send.setAttribute("data-req-send", "1");
      f.appendChild(send);
      return f;
    },

    /** 열람자 요청 전송 — 성공 시 익명 수정키 보관 + 목록 갱신. 반환: 서버 응답 status(0 = 네트워크/입력 오류) */
    async submitViewer(v, ui) {
      const ctx = this._vctx;
      const showErr = (m) => { if (ui && ui.err) { ui.err.textContent = m; ui.err.style.display = "block"; } };
      if (!ctx) return 0;
      const body = String(v.body || "").trim();
      if (!body) { showErr("내용을 입력하세요."); return 0; }
      const guest = this._isGuest();
      const author = String(v.author || "").trim();
      if (guest && !author) { showErr("이름을 입력하세요."); return 0; }
      const deck = (typeof Projects !== "undefined" && Projects.currentDeck) || null;
      const payload = {
        deployment_id: ctx.dep, pin_id: ctx.pin ? String(ctx.pin.id) : "", pin_label: ctx.pin ? (ctx.pin.label || "") : "",
        kind: v.kind === "question" ? "question" : "request", body,
        deck_id: (deck && String(deck.deployment_id || "") === String(ctx.dep)) ? deck.id : "",
      };
      if (guest) { payload.author = author; payload.contact = String(v.contact || "").trim(); try { localStorage.setItem(this.NAME_LS, author); } catch (e) {} }
      if (ui && ui.send) ui.send.disabled = true;
      try {
        const r = await fetch("/api/notes", { method: "POST", headers: this._headers(), body: JSON.stringify(payload) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { showErr(j.error || ("전송 실패(" + r.status + ")")); return r.status; }
        if (j.edit_key) this._saveKey(j.id, j.edit_key);
        if (ui && ui.ta) ui.ta.value = "";
        if (ui && ui.err) ui.err.style.display = "none";
        Prompt.toast && Prompt.toast((payload.kind === "question" ? "질문" : "요청") + "이 디자이너에게 전달되었습니다");
        await this._loadViewerList();
        return r.status;
      } catch (e) {
        showErr("네트워크 오류로 보내지 못했습니다. 잠시 후 다시 시도하세요.");
        return 0;
      } finally {
        if (ui && ui.send) ui.send.disabled = false;
      }
    },

    _mineHeaders(n) {
      const k = this._keys()[n.id];
      return this._headers(k ? { "X-Note-Key": k } : null);
    },

    _editMine(n, card, bodyEl) {
      if (card.querySelector("[data-req-edit-input]")) return;
      const ta = this._el("textarea", "width:100%;box-sizing:border-box;min-height:60px;margin:6px 0 0;padding:8px;border-radius:8px;border:1px solid #554;background:#2a2518;color:#ffffff;font-size:13px;font-family:sans-serif");
      ta.value = n.body || ""; ta.maxLength = 4000; ta.setAttribute("data-req-edit-input", "1");
      const save = this._btn("저장", "margin:6px 6px 0 0;padding:7px 12px;border-radius:8px;border:none;background:#c9962a;color:#1a1712;font-weight:700;font-size:12.5px;cursor:pointer", async () => {
        const t = ta.value.trim(); if (!t) return;
        const r = await fetch("/api/notes/" + encodeURIComponent(n.id), { method: "PATCH", headers: this._mineHeaders(n), body: JSON.stringify({ body: t }) }).catch(() => null);
        if (!r || !r.ok) { Prompt.toast && Prompt.toast("수정하지 못했습니다" + (r ? "(" + r.status + ")" : "")); return; }
        await this._loadViewerList();
      });
      bodyEl.insertAdjacentElement("afterend", ta);
      ta.insertAdjacentElement("afterend", save);
    },

    async _deleteMine(n) {
      if (typeof Prompt !== "undefined" && Prompt.confirm && !(await Prompt.confirm("요청 삭제", "이 요청을 삭제할까요?"))) return;
      const r = await fetch("/api/notes/" + encodeURIComponent(n.id), { method: "DELETE", headers: this._mineHeaders(n) }).catch(() => null);
      if (!r || !r.ok) { Prompt.toast && Prompt.toast("삭제하지 못했습니다" + (r ? "(" + r.status + ")" : "")); return; }
      await this._loadViewerList();
    },

    /* ── 패널 껍데기(뷰어 = 하단 시트, 디자이너 = 우측 패널) ── */
    _shell(title, side) {
      const backdrop = this._el("div", [
        "position:fixed", "inset:0", "background:rgba(0,0,0,.55)", "z-index:99980", "display:flex",
        side === "right" ? "justify-content:flex-end" : "justify-content:center",
        side === "right" ? "align-items:stretch" : "align-items:flex-end",
      ].join(";"));
      backdrop.setAttribute("data-req-backdrop", "1");
      backdrop.addEventListener("click", (e) => { if (e.target === backdrop) this.closePanel(); });
      const panel = this._el("div", [
        "position:relative", "width:100%", side === "right" ? "max-width:520px" : "max-width:520px",
        side === "right" ? "height:100%" : "max-height:86vh", "overflow-y:auto", "background:#1a1712", "color:#ffffff",
        side === "right" ? "border-radius:0" : "border-radius:16px 16px 0 0", "padding:18px", "box-sizing:border-box", "font-family:sans-serif",
      ].join(";"));
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-label", title);
      const close = this._btn("닫기", "position:absolute;top:12px;right:12px;background:transparent;border:1px solid #665;color:#ffffff;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px", () => this.closePanel());
      close.setAttribute("aria-label", "닫기");
      panel.appendChild(close);
      const h = this._el("h3", "margin:0 0 12px;font-size:16px;color:#ffffff;padding-right:60px", title);
      h.setAttribute("data-req-title", "1");
      panel.appendChild(h);
      backdrop.appendChild(panel);
      document.body.appendChild(backdrop);
      if (!this._escBound) {
        this._escBound = true;
        document.addEventListener("keydown", (e) => { if (e.key === "Escape" && this._panelEl) this.closePanel(); });
      }
      return { backdrop, panel };
    },

    closePanel() {
      if (this._panelEl && this._panelEl.parentNode) this._panelEl.parentNode.removeChild(this._panelEl);
      this._panelEl = null;
      this._vctx = null;
    },
  };
