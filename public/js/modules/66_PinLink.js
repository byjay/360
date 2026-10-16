/** [WO 20261016-multisheet P3] 도면 간 핀 번호 연결 — 설계 정본 `.tmp/design-multisheet.md` §2 / §4-3.
 *  마스터: "플랜 섹션 엘리베이션이 있을 때 똑같은 핀 번호를 플랜 상에도 표기하고 엘리베이션 상에도 같이 매칭할 수 있는
 *  그런 옵션 체크 기능으로 구현해."
 *
 *  저장 모델(2-2) — pin.linkId = 대표 핀 id(문자열).
 *    대표(head)   : pin.linkId === String(pin.id) — 사진·파노·노트·상태·아이콘·GPS 는 여기에만.
 *    멤버(member) : pin.linkId === <대표 id>      — 좌표(x,y,page)만 자기 것, 내용은 0. 읽을 때 headOf().
 *    label        : 멤버마다 같은 값 — 🔴 쓰기는 setLabel() 1곳(그룹 전원 동시). 정적 테스트(p161 T5)가 강제한다.
 *  🔴 제약(2-3): 같은 배포본(= 같은 PDF 의 다른 페이지)끼리만. State.pins 는 배포본 1개라 다른 파일 핀은 애초에 고를 수 없다.
 *  🔴 D1 마이그레이션 0 — linkId 는 pins JSON 블롭 안 필드(스냅샷·개정·오프라인 큐가 통째로 실어 나른다).
 *  연결 없는 핀 = headOf 자기 자신 · members [자기] · dedupe 항등 → 모든 경로가 종전과 같다.
 */
(function () {
  const S = (v) => String(v == null ? "" : v);
  const PinLink = {
    /* ══ 순수 로직(DOM 0) — p161 이 직접 호출 ══════════════════════════════════════ */
    isLinked(p) { return !!(p && p.linkId != null && p.linkId !== ""); },
    isHead(p) { return this.isLinked(p) && S(p.linkId) === S(p.id); },
    isMember(p) { return this.isLinked(p) && S(p.linkId) !== S(p.id); },

    /** 대표 핀 — 연결 없음/대표 유실이면 자기 자신(지어내지 않음). */
    headOf(pins, p) {
      if (!this.isLinked(p) || this.isHead(p)) return p;
      const k = S(p.linkId);
      const h = (pins || []).find((q) => q && !q._deleted && S(q.id) === k);
      return h || p;
    },
    /** 같은 연결 묶음의 살아있는 핀 전원(자기 포함). 연결 없음 = [p]. */
    members(pins, p) {
      if (!this.isLinked(p)) return p ? [p] : [];
      const k = S(p.linkId);
      const out = (pins || []).filter((q) => q && !q._deleted && S(q.linkId) === k);
      if (out.indexOf(p) < 0 && !p._deleted) out.push(p);
      return out;
    },
    groupIds(pins, p) { return this.members(pins, p).map((q) => q.id); },
    /** 🔴 삭제 범위 — 대표를 지우면 묶음 전체(종속만 남으면 내용 없는 유령 핀 = 조용한 실패), 멤버만 지우면 그 멤버만. */
    deleteIds(pins, p) {
      if (this.isHead(p)) return this.groupIds(pins, p);
      return [p.id];
    },
    /** 논리 핀 1개 = 1행 — 대표 우선, 대표가 목록에 없으면 처음 만난 멤버. 순서는 처음 나온 자리. 연결 없음 = 항등. */
    dedupe(pins) {
      const arr = Array.isArray(pins) ? pins : [];
      const slot = new Map(), out = [];
      arr.forEach((p) => {
        if (!p) return;
        if (!this.isLinked(p)) { out.push(p); return; }
        const k = S(p.linkId);
        if (!slot.has(k)) { slot.set(k, out.length); out.push(p); return; }
        if (this.isHead(p)) out[slot.get(k)] = p;
      });
      return out;
    },
    /** 🔴 label 쓰기 정본 — 묶음 전원에 같은 값. opts.manual = 사용자가 정한 번호(동시 생성 재채번 제외). @returns 바뀐 핀들 */
    setLabel(pins, p, label, opts) {
      const ms = this.members(pins, p);
      const manual = !!(opts && opts.manual);
      ms.forEach((m) => { m.label = label; if (manual) m.labelManual = true; });
      return ms;
    },
    /** 연결 — member 를 head 의 묶음에 넣는다. label·계열(checkboard)은 대표를 따른다. */
    link(pins, head, member) {
      if (!head || !member || head === member) return null;
      const h = this.headOf(pins, head);
      if (!this.isLinked(h)) h.linkId = S(h.id);
      member.linkId = S(h.linkId);
      member.label = h.label;
      if (h.checkboard) member.checkboard = true; else delete member.checkboard;
      return member;
    },
    /** 연결 해제 — 멤버를 묶음에서 뺀다(newLabel 로 새 번호). 대표는 다른 멤버가 남아 있으면 거부(사진·노트가 대표에 있다).
     *  @returns {{ok:boolean, reason?:string}} */
    unlink(pins, p, newLabel) {
      if (!this.isLinked(p)) return { ok: false, reason: "연결된 핀이 아닙니다" };
      const others = this.members(pins, p).filter((q) => q !== p);
      if (this.isHead(p)) {
        if (others.length) return { ok: false, reason: "대표 핀(사진·노트가 있는 도면)은 해제할 수 없습니다 — 다른 도면의 연결 핀을 해제하거나 삭제하세요" };
        delete p.linkId;
        return { ok: true };
      }
      delete p.linkId;
      if (newLabel != null) p.label = newLabel;
      const left = others.filter((q) => !q._deleted);
      if (left.length === 1 && this.isHead(left[0])) delete left[0].linkId;   // 대표 혼자 남으면 묶음 해체(표시 깔끔 · 데이터 동일)
      return { ok: true };
    },
    /** 🔴 병합 직후 정합화(결정적 — 같은 입력이면 몇 번을 돌려도 같은 결과).
     *   · 대표 핀 자체가 없는(삭제됨) 묶음의 멤버: 내용이 없으면 제거(대표 삭제 = 묶음 삭제), 내용이 있으면 연결만 풀어 보존(유실 0).
     *   · 대표 핀은 있는데 대표 표식(linkId=자기 id)만 빠진 경우(남의 동시 편집이 LWW 로 이겨 표식이 사라짐): 표식을 되살린다
     *     — 멤버를 지우지 않는다(실측: p161 S 오프라인 병합에서 멤버 유실 재현 후 이 규칙으로 고정).
     *   · 대표와 label 이 다른 멤버: 대표 label 로 맞춘다(LWW 가 멤버별로 갈라 놓은 번호).
     *  @returns {{pins:Array, removed:Array, released:Array, relabeled:Array, reheaded:Array}} */
    repair(pins) {
      const arr = Array.isArray(pins) ? pins : [];
      const live = new Map();
      arr.forEach((p) => { if (p && !p._deleted && p.id != null) live.set(S(p.id), p); });
      const removed = [], released = [], relabeled = [], reheaded = [];
      const hasContent = (p) => (typeof PinSeries !== "undefined" && PinSeries.hasContent) ? PinSeries.hasContent(p) : !!(p.imageId || p.imageUrl || p.videoId || p.note);
      arr.forEach((p) => {
        if (!p || p._deleted || !this.isMember(p)) return;
        const h = live.get(S(p.linkId));
        if (h && !this.isLinked(h)) { h.linkId = S(h.id); reheaded.push(h.id); }
      });
      const kept = arr.filter((p) => {
        if (!p || p._deleted || !this.isMember(p)) return true;
        const h = live.get(S(p.linkId));
        if (!h || !this.isHead(h)) {
          if (hasContent(p)) { delete p.linkId; released.push(p.id); return true; }
          removed.push(p.id);
          return false;
        }
        if (S(p.label) !== S(h.label)) { p.label = h.label; relabeled.push(p.id); }
        return true;
      });
      return { pins: kept, removed, released, relabeled, reheaded };
    },
    /** 연결 유실 복구 후보(자동 결합 금지 — 사용자 확인용 목록만): 묶음 안 다른 시트에 같은 번호가 있는데 연결이 없는 쌍. */
    repairCandidates(pins, scopePages) {
      const sp = new Set(scopePages || []);
      const by = new Map();
      (pins || []).forEach((p) => {
        if (!p || p._deleted || !sp.has(p.page || 1)) return;
        const k = (typeof PinSeries !== "undefined" && PinSeries.noKeyOf) ? PinSeries.noKeyOf(p.label) : null;
        if (!k) return;
        const key = k.key + "|" + k.no;
        if (!by.has(key)) by.set(key, []);
        by.get(key).push(p);
      });
      const out = [];
      by.forEach((list, key) => {
        const pages = new Set(list.map((p) => p.page || 1));
        const units = new Set(list.map((p) => this.isLinked(p) ? "L" + S(p.linkId) : "I" + S(p.id)));
        if (pages.size > 1 && units.size > 1) out.push({ key, pins: list });
      });
      return out;
    },
    /** 이 시트(page)에 아직 멤버가 없는 논리 핀(다른 시트의 번호) — 번호순. [기존 번호 연결] 칩 목록 · 첫 항목 = 다음 미연결 번호 제안. */
    candidates(pins, scopePages, page) {
      const sp = new Set(scopePages || []);
      const pg = page || 1;
      const units = new Map();
      (pins || []).forEach((p) => {
        if (!p || p._deleted || !sp.has(p.page || 1)) return;
        const k = this.isLinked(p) ? "L" + S(p.linkId) : "I" + S(p.id);
        if (!units.has(k)) units.set(k, []);
        units.get(k).push(p);
      });
      const out = [];
      units.forEach((ms) => {
        if (ms.some((p) => (p.page || 1) === pg)) return;   // 이미 이 시트에 있다
        const head = ms.find((p) => this.isHead(p)) || ms[0];
        out.push(head);
      });
      const PS = (typeof PinSeries !== "undefined") ? PinSeries : null;
      if (PS && PS.byNumber) out.sort((a, b) => PS.byNumber(a, b) || ((a.page || 1) - (b.page || 1)));
      return out;
    },

    /* ══ 배치(연결 모드) 상태 — 20_App._placeCheckboardPin 이 takePending 1회 호출 ════════════ */
    _pending: null,      // 연결 대상 대표 id(문자열) — null = [새 번호]
    _mode: "new",        // "new" | "link"
    /** 지금 시트가 연결 묶음 안인가(scopePages 2장 이상). */
    active(page) {
      if (typeof PinSeries === "undefined" || !PinSeries.scopePages || typeof State === "undefined") return false;
      return PinSeries.scopePages(page || State.pdfPage || 1).length > 1;
    },
    _scope(page) { return PinSeries.scopePages(page || (State && State.pdfPage) || 1); },
    setMode(mode) {
      this._mode = mode === "link" ? "link" : "new";
      if (this._mode === "link") {
        const c = this.candidates(State.pins, this._scope(), State.pdfPage || 1);
        this._pending = c.length ? S(c[0].id) : null;
        if (!c.length) { this._mode = "new"; if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("연결할 번호가 없습니다 — 다른 도면의 번호가 이미 이 도면에 모두 있습니다"); }
      } else this._pending = null;
      this.renderBar();
    },
    choose(id) { this._mode = "link"; this._pending = S(id); this.renderBar(); },
    /** 다음 배치가 연결 멤버면 그 대표(유효성 재확인), 아니면 null. 소비 후 다음 미연결 번호로 자동 진행. */
    takePending(pins, page) {
      if (this._mode !== "link" || this._pending == null || !this.active(page)) return null;
      const head = (pins || []).find((p) => p && !p._deleted && S(p.id) === this._pending);
      const cand = this.candidates(pins, this._scope(page), page);
      if (!head || !cand.some((c) => S(c.id) === S(head.id))) { this._pending = null; this._mode = "new"; this.renderBar(); return null; }
      return head;
    },
    /** 연결 배치 직후 — 다음 미연결 번호로 진행(없으면 [새 번호]로). */
    advance(page) {
      const c = this.candidates(State.pins, this._scope(page), page);
      this._pending = c.length ? S(c[0].id) : null;
      if (!c.length) this._mode = "new";
      this.renderBar();
    },

    /* ══ DOM — 새 CSS 0(인라인, 흰 바탕 #FFFFFF 위 #0B1F33 = 16.1:1 · 선택 칩 #0B1F33 위 #FFFFFF 동일) ══════ */
    _esc(s) { return S(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); },
    _textOf(p) {
      try { const m = PinSeries.numbers(State.pins, p.page || 1).get(p.id); if (m) return PinSeries.textOf(m); } catch (e) {}
      return S(p.label);
    },
    _sheetName(page) {
      try {
        const d = (typeof Projects !== "undefined" && Projects.sheetDeckForPage) ? Projects.sheetDeckForPage(page) : null;
        if (d && d.name) return d.name;
      } catch (e) {}
      return page + "쪽";
    },
    _canEdit() { return typeof State !== "undefined" && State.mode === "designer" && !(typeof Auth !== "undefined" && Auth.readonly); },

    /** 배치 바 — 배치 중(State.placing) + 연결 묶음 안 + 편집 가능일 때만. 상단 고정(하단 도크·연속 탭 위치 가림 회피 — 60_PhotoFolder 실측 교훈). */
    renderBar() {
      if (typeof document === "undefined" || !document.body) return;
      let bar = document.getElementById("pinlink-bar");
      const page = (typeof State !== "undefined" && State.pdfPage) || 1;
      const show = this._canEdit() && !!(State && State.placing) && this.active(page);
      if (!show) { if (bar) { bar.classList.add("hidden"); bar.style.display = "none"; } return; }
      if (!bar) {
        bar = document.createElement("div");
        bar.id = "pinlink-bar";
        bar.setAttribute("role", "toolbar");
        bar.setAttribute("aria-label", "핀 번호 연결");
        bar.style.cssText = "position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:60;max-width:min(96vw,720px);display:flex;align-items:center;gap:6px;padding:6px 8px;background:#FFFFFF;color:#0B1F33;border:1px solid #94A3B8;border-radius:10px;box-shadow:0 4px 14px rgba(0,0,0,.18);font-size:12.5px;overflow-x:auto;white-space:nowrap";
        bar.addEventListener("click", (e) => {
          const b = e.target && e.target.closest ? e.target.closest("button[data-pl]") : null;
          if (!b) return;
          e.stopPropagation();
          const act = b.getAttribute("data-pl");
          if (act === "new") this.setMode("new");
          else if (act === "link") this.setMode("link");
          else if (act === "pick") this.choose(b.getAttribute("data-id"));
        });
        document.body.appendChild(bar);
      }
      bar.classList.remove("hidden"); bar.style.display = "flex";
      const btn = (on) => "padding:5px 10px;border-radius:7px;cursor:pointer;font-size:12.5px;border:1px solid " + (on ? "#0B1F33;background:#0B1F33;color:#FFFFFF" : "#94A3B8;background:#FFFFFF;color:#0B1F33");
      const link = this._mode === "link";
      let html = '<span style="font-weight:700;color:#0B1F33">번호</span>' +
        '<button type="button" data-pl="new" aria-pressed="' + !link + '" style="' + btn(!link) + '">새 번호</button>' +
        '<button type="button" data-pl="link" aria-pressed="' + link + '" style="' + btn(link) + '">기존 번호에 연결</button>';
      if (link) {
        const c = this.candidates(State.pins, this._scope(page), page);
        html += c.map((h, i) => {
          const on = S(h.id) === this._pending;
          return '<button type="button" data-pl="pick" data-id="' + this._esc(h.id) + '" aria-pressed="' + on + '" title="' + this._esc(this._sheetName(h.page || 1)) + '" style="' + btn(on) + '">' +
            this._esc(this._textOf(h)) + (i === 0 ? " (다음)" : "") + "</button>";
        }).join("");
      }
      bar.innerHTML = html;
    },

    /** 핀 팝업 한 줄 — "연결됨: [PLAN ●] [SECTION] [ELEV]" + (편집 가능·멤버면) [연결 해제]. 열람자 = 보기·이동만. */
    renderPopRow(host, clicked) {
      if (!host || typeof document === "undefined") return;
      let row = document.getElementById("pap-link-row");
      const ms = this.isLinked(clicked) ? this.members(State.pins, clicked) : [];
      if (ms.length < 2) { if (row) { row.innerHTML = ""; row.style.display = "none"; } return; }
      if (!row) {
        row = document.createElement("div");
        row.id = "pap-link-row";
        row.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:6px 0 2px;font-size:12px;color:#0B1F33";
        if (host.parentNode && host.parentNode.insertBefore) host.parentNode.insertBefore(row, host.nextSibling);
        else if (host.appendChild) host.appendChild(row);
        row.addEventListener("click", (e) => {
          const b = e.target && e.target.closest ? e.target.closest("button[data-plr]") : null;
          if (!b) return;
          const id = b.getAttribute("data-id");
          const pin = (State.pins || []).find((p) => p && S(p.id) === S(id));
          if (!pin) return;
          if (b.getAttribute("data-plr") === "go") this.goTo(pin);
          else if (b.getAttribute("data-plr") === "unlink") this.unlinkUI(pin);
        });
      }
      row.style.display = "flex";
      const cur = (State && State.pdfPage) || 1;
      const sorted = ms.slice().sort((a, b) => (a.page || 1) - (b.page || 1));
      const chip = (on) => "padding:4px 9px;border-radius:7px;cursor:pointer;font-size:12px;border:1px solid " + (on ? "#0B1F33;background:#0B1F33;color:#FFFFFF" : "#94A3B8;background:#FFFFFF;color:#0B1F33");
      let html = '<span style="font-weight:700">다른 도면에서 보기</span>' + sorted.map((m) => {
        const on = (m.page || 1) === cur;
        return '<button type="button" data-plr="go" data-id="' + this._esc(m.id) + '" aria-pressed="' + on + '" style="' + chip(on) + '">' + this._esc(this._sheetName(m.page || 1)) + (on ? " ●" : "") + "</button>";
      }).join("");
      if (this._canEdit() && this.isMember(clicked)) {
        html += '<button type="button" data-plr="unlink" data-id="' + this._esc(clicked.id) + '" style="padding:4px 9px;border-radius:7px;cursor:pointer;font-size:12px;border:1px solid #B91C1C;background:#FFFFFF;color:#B91C1C">이 도면 연결 해제</button>';
      }
      row.innerHTML = html;
    },

    /** 시트 간 이동 — 같은 배포본이면 다시 불러오지 않고 구역 표시 + 페이지 이동(미저장 편집 보존), 그 멤버로 포커스. */
    async goTo(pin) {
      if (!pin) return;
      try {
        const deck = (typeof Projects !== "undefined" && Projects.sheetDeckForPage) ? Projects.sheetDeckForPage(pin.page || 1) : null;
        if (typeof PinActionPop !== "undefined" && PinActionPop.close) PinActionPop.close();
        if (deck && typeof Projects !== "undefined") {
          Projects.currentDeck = deck;
          if (Projects._renderDecks) Projects._renderDecks();
        }
        if (typeof App !== "undefined" && App._gotoPage && (State.pdfPage || 1) !== (pin.page || 1)) await App._gotoPage(pin.page || 1);
        if (deck && typeof Projects !== "undefined" && Projects._applyDeckCropView) { try { Projects._applyDeckCropView(deck); } catch (e) {} }
        const live = (State.pins || []).find((p) => p && S(p.id) === S(pin.id)) || pin;
        State.activePin = live.id;
        if (typeof UI !== "undefined" && UI.renderPinsOnMap) UI.renderPinsOnMap(live.id);
        if (typeof MapCtrl !== "undefined" && MapCtrl.flyTo) MapCtrl.flyTo(live.x, live.y, Math.max(State.zoom || 1, 2.2));
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast(this._textOf(live) + " — " + this._sheetName(live.page || 1));
      } catch (e) {}
    },

    /** [연결 해제] — 새 번호(묶음 다음 번호) 부여 · 저장(미저장 표시 + 로컬 보관). */
    unlinkUI(pin) {
      if (!this._canEdit()) return;
      const nx = (typeof PinSeries !== "undefined" && App && App._numBand) ? PinSeries.nextInBand(State.pins, pin.page || 1, PinSeries.seriesOf(pin), App._numBand(), App._checkboardStart ? App._checkboardStart(pin.page || 1, PinSeries.seriesOf(pin)) : 1) : null;
      const r = this.unlink(State.pins, pin, nx && nx.label ? nx.label : undefined);
      if (!r.ok) { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast(r.reason); return; }
      if (typeof App !== "undefined") { App._markDirty && App._markDirty(); App._autoSave && App._autoSave(); }
      if (typeof UI !== "undefined") { UI.renderPinsOnMap && UI.renderPinsOnMap(); UI.renderPinList && UI.renderPinList(); }
      if (typeof PinActionPop !== "undefined" && PinActionPop.close) PinActionPop.close();
      if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("연결을 해제했습니다 — 새 번호 " + this._textOf(pin));
    },

    /* ══ 구역 ⋯ 메뉴 — ☐ 도면 간 핀 번호 연결 · 번호 접두사 ══════════════════════════════ */
    /** 이 구역 아래 같은 배포본 시트 묶음(배포본별 page 목록) — 순수. */
    sheetGroups(deck, decks) {
      const all = Array.isArray(decks) ? decks : [];
      const kids = new Map();
      all.forEach((d) => { if (d && d.parent_id != null) { const k = S(d.parent_id); if (!kids.has(k)) kids.set(k, []); kids.get(k).push(d); } });
      const groups = new Map();
      const walk = (d, guard) => {
        if (!d || guard > 50) return;
        if (d.deployment_id) {
          const k = S(d.deployment_id);
          if (!groups.has(k)) groups.set(k, new Set());
          groups.get(k).add(d.page || 1);
        }
        (kids.get(S(d.id)) || []).forEach((c) => walk(c, guard + 1));
      };
      walk(deck, 0);
      return groups;
    },
    deckMenuItems(deck, why) {
      const decks = (typeof Projects !== "undefined" && Projects.decks) || [];
      const groups = this.sheetGroups(deck, decks);
      const multi = Array.from(groups.values()).some((s) => s.size > 1);
      const on = Number(deck && deck.sheet_link) === 1;
      const mixed = groups.size > 1;
      const linkWhy = why || (multi ? "" : (mixed
        ? "다른 파일로 등록된 도면끼리는 번호를 연결할 수 없습니다 — 같은 PDF 의 페이지끼리만 가능합니다"
        : "이 구역 아래 같은 PDF 의 도면이 2장 이상 있어야 합니다 — [도면 여러 장 등록]으로 시트를 먼저 등록하세요"));
      const pre = (typeof Projects !== "undefined" && Projects.numPrefixOf) ? Projects.numPrefixOf(deck) : "";
      return [
        { label: (on ? "☑" : "☐") + " 도면 간 핀 번호 연결", desc: (on ? "켜짐 — " : "") + "번호를 이 구역 도면 전체에서 한 줄로 매기고, PLAN 에 찍은 번호를 SECTION·ELEVATION 에서 같은 번호로 연결합니다" + (mixed && multi ? " (다른 파일로 등록된 도면끼리는 연결되지 않습니다)" : ""),
          reason: on ? (why || "") : linkWhy, run: () => this.toggleSheetLink(deck) },
        { label: "번호 접두사" + (pre ? " (현재 " + pre + ")" : " (없음 — 순수 숫자)"), desc: "자동 번호 앞에 붙일 알파벳(예: A → A1, A2 · ER- → ER-1)",
          reason: why || "", run: () => this.setPrefixUI(deck) }
      ];
    },
    async _putDeck(deck, body) {
      try {
        const r = await fetch("/api/decks/" + encodeURIComponent(deck.id), { method: "PUT", headers: Auth.headers(), body: JSON.stringify(body) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("저장하지 않았습니다 — " + ((d && d.error) || r.status)); return null; }
        if (typeof Projects !== "undefined" && Projects.loadDecks) await Projects.loadDecks();
        return d;
      } catch (e) { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("네트워크 오류 — 저장하지 않았습니다"); return null; }
    },
    /** 켜기 = 중복될 번호 목록을 먼저 보여주고 2단 확인(조용히 바꾸지 않는다 — 번호 자동 변경 0). */
    async toggleSheetLink(deck) {
      if (!deck) return null;
      const on = Number(deck.sheet_link) === 1;
      if (on) {
        if (!await Prompt.confirm("도면 간 번호 연결 끄기", "끄면 번호가 다시 도면(페이지)별로 매겨집니다.\n이미 연결된 핀은 연결 정보를 그대로 갖고 있어 다시 켜면 복원됩니다.")) return null;
        const d = await this._putDeck(deck, { sheet_link: 0 });
        if (d && typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("도면 간 번호 연결을 껐습니다");
        this._refresh();
        return d;
      }
      const dups = this.previewDuplicates(deck);
      const msg1 = "이 구역 아래 같은 PDF 도면들의 번호를 하나로 묶습니다.\n" +
        (dups.length ? ("⚠ 지금 서로 다른 도면에 같은 번호가 있습니다: " + dups.slice(0, 20).join(", ") + (dups.length > 20 ? " 외 " + (dups.length - 20) + "개" : "") + "\n켜면 이 번호들이 '중복'으로 표시됩니다(자동으로 바꾸지 않습니다).") : "지금 겹치는 번호는 없습니다.");
      if (!await Prompt.confirm("도면 간 번호 연결 (1/2)", msg1, { okText: "다음", cancelText: "취소" })) return null;
      if (!await Prompt.confirm("도면 간 번호 연결 (2/2)", (dups.length ? "같은 위치를 뜻하는 번호라면 그 도면 핀을 지우고 [기존 번호에 연결]로 다시 찍거나, [번호 리셋]으로 정리하세요.\n" : "") + "켤까요?", { okText: "켜기", cancelText: "취소" })) return null;
      const d = await this._putDeck(deck, { sheet_link: 1 });
      if (d && typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("도면 간 번호 연결을 켰습니다 — 다른 도면에서 핀을 찍을 때 [기존 번호에 연결]을 고를 수 있습니다", 5200);
      this._refresh();
      return d;
    },
    /** 켜면 중복이 될 번호(지금 로드된 배포본 기준 — 로드 안 된 파일은 계산하지 않는다, 지어내지 않음). */
    previewDuplicates(deck) {
      const groups = this.sheetGroups(deck, (typeof Projects !== "undefined" && Projects.decks) || []);
      const dep = S((State && (State.currentDeploymentId || State.autoSaveDepId)) || "");
      const pages = groups.get(dep);
      if (!pages || pages.size < 2) return [];
      const by = new Map();
      (State.pins || []).forEach((p) => {
        if (!p || p._deleted || !pages.has(p.page || 1)) return;
        const k = PinSeries.noKeyOf(p.label);
        if (!k) return;
        const key = k.key + "|" + k.no;
        if (!by.has(key)) by.set(key, { text: S(p.label).trim(), units: new Set() });
        by.get(key).units.add(this.isLinked(p) ? "L" + S(p.linkId) : "I" + S(p.id));
      });
      const out = [];
      by.forEach((v) => { if (v.units.size > 1) out.push(v.text); });
      return out.sort((a, b) => PinSeries.byNumber({ label: a }, { label: b }));
    },
    PREFIX_RX: /^(?:[A-Za-z]{1,6}[-_]?|[A-Za-z][A-Za-z0-9]{0,5}[-_])$/,
    async setPrefixUI(deck) {
      if (!deck) return null;
      const res = await Prompt.ask({ title: "번호 접두사", sub: "자동 번호 앞에 붙일 알파벳(예: A → A1, A2 / ER- → ER-1 / B2- → B2-1). 비우면 순수 숫자.", placeholder: "예: A", value: deck.num_prefix || "" });
      if (!res) return null;
      const v = S(res.value).trim();
      if (v && !this.PREFIX_RX.test(v)) { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("알파벳 1~6자(뒤에 - 또는 _ 선택), 숫자를 섞으려면 구분자 필수(예: B2-)"); return null; }
      const d = await this._putDeck(deck, { num_prefix: v || null });
      if (d && typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast(v ? ("번호 접두사 '" + v + "' — 다음 핀부터 " + v + "1, " + v + "2 …") : "번호 접두사를 지웠습니다 — 순수 숫자");
      this._refresh();
      return d;
    },
    _refresh() {
      try { if (typeof UI !== "undefined") { UI.renderPinsOnMap && UI.renderPinsOnMap(); UI.renderPinList && UI.renderPinList(); } } catch (e) {}
      try { if (typeof NumBand !== "undefined" && NumBand.render) NumBand.render(); } catch (e) {}
      try { if (typeof App !== "undefined" && App._updateCheckboardQuickStatus) App._updateCheckboardQuickStatus(); } catch (e) {}
      this.renderBar();
    }
  };

  if (typeof window !== "undefined") window.PinLink = PinLink;
  if (typeof module !== "undefined" && module.exports) module.exports = PinLink;
})();
