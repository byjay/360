  /* ══════════════════════════════════════════
     PROJECT INFO — [WO 20261001-projectinfo] 프로젝트 정보(자유 메모 + 일정 목록)
     마스터: "방선 일정 정보 등도 노트나 메모로 프로젝트 정보에 저장하게 해"

     저장소 = projects.info_json(마이그레이션 0035, 단일 JSON 컬럼 — 가장 단순한 선택, §5 YAGNI).
     shape: { note: string, schedule: [{id,date,kind,content,done}], updatedAt: number, updatedBy: string }
     권한: 디자이너 이상(소유자 포함) 편집, 열람자는 보기만 — 서버 PATCH /api/projects/:id 가 최종 판정(SoT).
     동시편집: LWW + 충돌 경고 — base_updated_at 이 서버 값과 다르면 409 → 확인 후 강제 저장.
     🔴 스타일은 Requests(42_Requests.js)와 같은 인라인 리터럴 hex 규칙을 그대로 쓴다(테마 변수 재해석 함정 회피).
  ══════════════════════════════════════════ */
  const ProjectInfo = {
    _panelEl: null,
    _proj: null,
    _info: null,
    _baseUpdatedAt: null,
    _editable: false,

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
    _headers(extra) {
      return (typeof Auth !== "undefined" && Auth.headers) ? Auth.headers(Object.assign({ "Content-Type": "application/json" }, extra || {})) : Object.assign({ "Content-Type": "application/json" }, extra || {});
    },
    _blank() { return { note: "", schedule: [], updatedAt: null, updatedBy: null }; },
    _normalize(info) {
      const i = info || {};
      return { note: typeof i.note === "string" ? i.note : "", schedule: Array.isArray(i.schedule) ? i.schedule : [], updatedAt: i.updatedAt || null, updatedBy: i.updatedBy || null };
    },

    /** 오늘 이후(완료 제외) 가장 가까운 일정 1건 — 없으면 null. 허브 카드 "다음 일정" 줄과 패널이 공유(SoT). */
    nextSchedule(info) {
      const list = (info && Array.isArray(info.schedule)) ? info.schedule : [];
      const todayKey = new Date().toISOString().slice(0, 10);
      const upcoming = list.filter((s) => s && !s.done && s.date && s.date >= todayKey).sort((a, b) => (a.date < b.date ? -1 : 1));
      return upcoming[0] || null;
    },
    /** 허브 카드 1줄 표시 — "방선 10/08 · 3일 후" 형태. 일정이 없으면 null(지어내지 않음). */
    nextLine(info) {
      const s = this.nextSchedule(info);
      if (!s) return null;
      const d = new Date(s.date + "T00:00:00");
      if (isNaN(d.getTime())) return null;
      const days = Math.round((d.getTime() - new Date(new Date().toDateString()).getTime()) / 86400000);
      const when = days === 0 ? "오늘" : days === 1 ? "내일" : (days > 1 ? days + "일 후" : Math.abs(days) + "일 지남");
      return (s.kind || "일정") + " " + (d.getMonth() + 1) + "/" + String(d.getDate()).padStart(2, "0") + " · " + when;
    },

    open(proj) {
      if (!proj) return;
      this.closePanel();
      this._proj = proj;
      this._info = this._normalize(proj.info_json);
      this._baseUpdatedAt = this._info.updatedAt;
      const myRole = proj.my_role || (proj.can_manage_members ? "designer" : null);
      this._editable = !!(proj.can_manage_members || myRole === "designer");
      const { backdrop, panel } = this._shell("프로젝트 정보 · " + (proj.name || ""));
      this._panelEl = backdrop;
      this._render(panel);
    },

    _render(panel) {
      const list = panel.querySelector("[data-pinfo-body]") || (() => {
        const d = this._el("div", "");
        d.setAttribute("data-pinfo-body", "1");
        panel.appendChild(d);
        return d;
      })();
      list.innerHTML = "";
      const info = this._info;
      // ── 메모 ──
      list.appendChild(this._el("div", "font-weight:700;color:#c9962a;font-size:13.5px;margin:0 0 6px", "메모"));
      const ta = this._el("textarea", "width:100%;box-sizing:border-box;min-height:90px;padding:9px;border-radius:8px;border:1px solid #554;background:#2a2518;color:#ffffff;font-size:13.5px;font-family:sans-serif;resize:vertical");
      ta.value = info.note || "";
      ta.maxLength = 20000;
      ta.placeholder = "자유 메모(현장 특이사항, 연락처 등)";
      ta.setAttribute("data-pinfo-note", "1");
      if (!this._editable) ta.disabled = true;
      list.appendChild(ta);
      const lastLine = (info.updatedAt && info.updatedBy)
        ? "마지막 수정: " + info.updatedBy + " · " + this._timeTxt(info.updatedAt)
        : "아직 저장된 메모가 없습니다.";
      list.appendChild(this._el("div", "font-size:11.5px;color:#cbbfa0;margin:4px 0 16px", lastLine));

      // ── 일정 목록 ──
      const schHead = this._el("div", "display:flex;align-items:center;justify-content:space-between;margin:0 0 8px");
      schHead.appendChild(this._el("div", "font-weight:700;color:#c9962a;font-size:13.5px", "일정(방선·점검·회의 등)"));
      if (this._editable) {
        const addBtn = this._btn("+ 일정 추가", "padding:5px 10px;border-radius:6px;border:none;background:#c9962a;color:#1a1712;font-weight:700;font-size:12px;cursor:pointer", () => this._addRow());
        schHead.appendChild(addBtn);
      }
      list.appendChild(schHead);
      const rows = this._el("div", "");
      rows.setAttribute("data-pinfo-rows", "1");
      list.appendChild(rows);
      (info.schedule || []).slice().sort((a, b) => (a.date || "") < (b.date || "") ? -1 : 1).forEach((s) => rows.appendChild(this._row(s)));
      if (!info.schedule || !info.schedule.length) rows.appendChild(this._el("div", "font-size:12.5px;color:#cbbfa0", "등록된 일정이 없습니다."));

      if (this._editable) {
        const save = this._btn("저장", "width:100%;margin-top:16px;padding:11px;border-radius:10px;border:none;background:#c9962a;color:#1a1712;font-weight:700;font-size:14px;cursor:pointer;font-family:sans-serif", () => this.save());
        save.setAttribute("data-pinfo-save", "1");
        list.appendChild(save);
      } else {
        list.appendChild(this._el("div", "font-size:12px;color:#cbbfa0;margin-top:12px", "열람자는 보기만 가능합니다."));
      }
    },

    _row(s) {
      const row = this._el("div", "display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:8px;margin:0 0 6px;border:1px solid #3d3626;border-radius:8px;background:#221e16");
      row.setAttribute("data-pinfo-row", s.id);
      const field = "padding:7px 8px;border-radius:6px;border:1px solid #554;background:#2a2518;color:#ffffff;font-size:12.5px;font-family:sans-serif";
      const chk = this._el("input", "width:16px;height:16px;flex-shrink:0");
      chk.type = "checkbox"; chk.checked = !!s.done; chk.setAttribute("data-pinfo-done", "1");
      chk.title = "완료";
      const dateIn = this._el("input", field + ";width:134px");
      dateIn.type = "date"; dateIn.value = s.date || ""; dateIn.setAttribute("data-pinfo-date", "1");
      const kindIn = this._el("input", field + ";width:90px");
      kindIn.type = "text"; kindIn.maxLength = 40; kindIn.value = s.kind || ""; kindIn.placeholder = "구분(방선 등)"; kindIn.setAttribute("data-pinfo-kind", "1");
      const contentIn = this._el("input", field + ";flex:1;min-width:140px");
      contentIn.type = "text"; contentIn.maxLength = 500; contentIn.value = s.content || ""; contentIn.placeholder = "내용"; contentIn.setAttribute("data-pinfo-content", "1");
      row.appendChild(chk); row.appendChild(dateIn); row.appendChild(kindIn); row.appendChild(contentIn);
      if (this._editable) {
        const del = this._btn("삭제", "padding:5px 9px;border-radius:6px;border:1px solid #b91c1c;background:transparent;color:#ff8a8a;font-size:11.5px;cursor:pointer", () => { row.remove(); });
        row.appendChild(del);
      } else {
        [chk, dateIn, kindIn, contentIn].forEach((el) => { el.disabled = true; });
      }
      if (s.done) { dateIn.style.opacity = "0.55"; kindIn.style.opacity = "0.55"; contentIn.style.opacity = "0.55"; contentIn.style.textDecoration = "line-through"; }
      return row;
    },

    _addRow() {
      const panel = this._panelEl && this._panelEl.querySelector("[data-pinfo-rows]");
      if (!panel) return;
      if (!panel.querySelector("[data-pinfo-row]")) panel.innerHTML = "";
      panel.appendChild(this._row({ id: "sch_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), date: new Date().toISOString().slice(0, 10), kind: "", content: "", done: false }));
    },

    _collect() {
      const panel = this._panelEl;
      const note = panel.querySelector("[data-pinfo-note]").value;
      const schedule = Array.prototype.map.call(panel.querySelectorAll("[data-pinfo-row]"), (row) => ({
        id: row.getAttribute("data-pinfo-row"),
        date: row.querySelector("[data-pinfo-date]").value || "",
        kind: row.querySelector("[data-pinfo-kind]").value || "",
        content: row.querySelector("[data-pinfo-content]").value || "",
        done: !!row.querySelector("[data-pinfo-done]").checked,
      }));
      return { note, schedule };
    },

    async save(force) {
      if (!this._proj || !this._editable) return;
      const payload = this._collect();
      const saveBtn = this._panelEl && this._panelEl.querySelector("[data-pinfo-save]");
      if (saveBtn) saveBtn.disabled = true;
      try {
        const body = { info_json: payload };
        if (!force) body.base_updated_at = this._baseUpdatedAt;
        const r = await fetch("/api/projects/" + this._proj.id, { method: "PATCH", headers: this._headers(), body: JSON.stringify(body) });
        if (r.status === 409) {
          const j = await r.json().catch(() => ({}));
          const serverInfo = this._normalize(j.data);
          const msg = (serverInfo.updatedBy ? serverInfo.updatedBy + "님이 " : "다른 사용자가 ") + "먼저 수정했습니다. 내 변경으로 덮어쓸까요?";
          // [p76] 🔴 네이티브 confirm() 금지 — PWA 독립실행모드(iOS/WebKit)에서 조용히 false 를
          // 반환하는 과거 실사고(36_Help.js 등과 동일 근본원인). 30_Prompt.js 는 이 모듈보다
          // 먼저 로드되는 핵심 모듈(_manifest.txt)이라 폴백 없이 항상 Prompt.confirm 을 쓴다.
          const ok = await Prompt.confirm("충돌 — 덮어쓰기", msg);
          if (!ok) { this._info = serverInfo; this._baseUpdatedAt = serverInfo.updatedAt; this._render(this._panelEl.querySelector('[role="dialog"]') || this._panelEl); return; }
          this._baseUpdatedAt = serverInfo.updatedAt;
          return this.save(true);
        }
        if (!r.ok) { Prompt.toast && Prompt.toast("저장 실패(" + r.status + ")"); return; }
        const j = await r.json();
        if (j && j.data) {
          Object.assign(this._proj, j.data);
          this._info = this._normalize(j.data.info_json);
          this._baseUpdatedAt = this._info.updatedAt;
        }
        Prompt.toast && Prompt.toast("프로젝트 정보를 저장했습니다");
        if (typeof UI !== "undefined" && UI.renderTree) UI.renderTree();
        if (typeof ProjectHub !== "undefined" && ProjectHub.refreshIfVisible) ProjectHub.refreshIfVisible();
        this.closePanel();
      } catch (e) {
        Prompt.toast && Prompt.toast("저장 실패(네트워크)");
      } finally {
        if (saveBtn) saveBtn.disabled = false;
      }
    },

    _timeTxt(v) {
      if (typeof Notes !== "undefined" && Notes._timeAgo) return Notes._timeAgo(v);
      const d = new Date(Number(v) || Date.parse(v));
      return isNaN(d) ? "" : (d.getMonth() + 1) + "." + d.getDate() + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    },

    _shell(title) {
      const backdrop = this._el("div", "position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:99980;display:flex;justify-content:center;align-items:flex-end");
      backdrop.setAttribute("data-pinfo-backdrop", "1");
      backdrop.addEventListener("click", (e) => { if (e.target === backdrop) this.closePanel(); });
      const panel = this._el("div", "position:relative;width:100%;max-width:560px;max-height:86vh;overflow-y:auto;background:#1a1712;color:#ffffff;border-radius:16px 16px 0 0;padding:18px;box-sizing:border-box;font-family:sans-serif");
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-label", title);
      const close = this._btn("닫기", "position:absolute;top:12px;right:12px;background:transparent;border:1px solid #665;color:#ffffff;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px", () => this.closePanel());
      panel.appendChild(close);
      panel.appendChild(this._el("h3", "margin:0 0 12px;font-size:16px;color:#ffffff;padding-right:60px", title));
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
    },
  };
