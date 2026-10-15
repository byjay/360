/** [WO 20261016-multisheet] 구역 안 여러 낱장 도면(시트) 일괄 등록 — 설계 정본 `.tmp/design-multisheet.md` §1/4-1 P1.
 *  마스터: "엔진룸 구역에 A데크가 있다고 쳤을 때 그 A데크 안에는 도면을 낱장 기준으로 여러 장을
 *  동시에 등록할 수 있게끔 해줘."
 *
 *  🔴 스키마 변경 0 — 시트 1장 = 그 구역(parent)의 자식 deck 1개(`decks.page` 는 0022 에서 이미 있다).
 *  🔴 새 업로드 경로 0 — PDF 는 App._createRegionCopyDeployment(기존, 영역 복사와 같은 함수)로 전체
 *  페이지를 그대로 복사해 R2 에 **1회만** 올린다. 이미지는 App._uploadPagesToR2 + App._deploymentBody
 *  (기존 저장 SoT)를 그대로 재사용한다. 여러 페이지를 쪼개 올리지 않는다(원본 PDF 재업로드 0).
 *  🔴 조용한 실패 금지 — createSheets/createSheets 는 파일·페이지 단위 성공/실패를 전부 기록해 돌려주고,
 *  실패분은 retrySheets 로 재시도한다(배포본이 이미 있으면 재업로드하지 않는다).
 */
(function () {
  const Sheets = {
    /** 시트 종류 판정(§1-4) — 손목록 금지, 매칭 안 되면 null(지어내지 않음). */
    kindOf(name) {
      const s = String(name || "");
      if (/\b(plan|p\/?l)\b|평면/i.test(s)) return "plan";
      if (/\bsect(ion)?\b|\bsec\b|단면/i.test(s)) return "section";
      if (/\bel(ev(ation)?)?\b|입면|측면/i.test(s)) return "elevation";
      if (/\bdet(ail)?\b|상세/i.test(s)) return "detail";
      return null;
    },

    KIND_BADGE: { plan: "PLAN", section: "SECTION", elevation: "ELEV", detail: "상세" },

    /** 텍스트에서 kindOf 가 걸리는 ≤40자 줄 중 가장 짧은 것 — 없으면 null. */
    _shortKindLine(text) {
      if (!text) return null;
      const lines = String(text).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      let best = null;
      for (const l of lines) {
        if (l.length > 40) continue;
        if (this.kindOf(l) && (!best || l.length < best.length)) best = l;
      }
      return best;
    },

    /** 확장자 제거 + 구분자([-_]) 공백화 — §1-4 2단. */
    _cleanFileName(fileName) {
      if (!fileName) return "";
      return String(fileName).replace(/\.[^./\\]+$/, "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
    },

    /** 이름 제안 SoT(§1-4 3단, 왕복) — PDF 페이지 텍스트 → 파일명(종류 매칭 시) → "<파일명> p<n>".
     *  꾸며낸 값 금지 — 1·2단 모두 실패하면 사실(파일명+페이지)만 돌려준다. */
    suggestName(pageText, fileName, pageNum) {
      const fromText = this._shortKindLine(pageText);
      if (fromText) return fromText;
      const cleaned = this._cleanFileName(fileName);
      if (cleaned && this.kindOf(cleaned)) return cleaned;
      const base = cleaned || "도면";
      return base + " p" + (pageNum || 1);
    },

    /** 파일이 PDF 인지(확장자/MIME) — 순수 판정, SoT. */
    isPdfFile(file) {
      return !!(file && (file.type === "application/pdf" || String(file.name || "").toLowerCase().endsWith(".pdf")));
    },

    /** PDF/이미지 파일의 페이지 수 + 페이지별 텍스트(PDF 전용, 실패 시 null) — DOM 0, 순수 비동기.
     *  이미지 파일은 항상 { total:1, texts:[null] }(지어낸 텍스트 0).
     *  @returns {Promise<{total:number, texts:Array<string|null>}>} */
    async peekPages(file) {
      if (!this.isPdfFile(file) || typeof PDF === "undefined" || !PDF.load) return { total: 1, texts: [null] };
      let doc = null;
      try {
        const ab = await file.arrayBuffer();
        doc = await PDF.load(ab);
        const n = (doc && doc.numPages) ? doc.numPages : 1;
        const texts = [];
        for (let i = 1; i <= n; i++) {
          try {
            const page = await doc.getPage(i);
            const content = await page.getTextContent();
            texts.push((content.items || []).map((it) => it.str || "").join("\n"));
          } catch (e) { texts.push(null); }
        }
        return { total: n, texts };
      } catch (e) { return { total: 1, texts: [null] }; }
      finally { try { doc && doc.destroy && doc.destroy(); } catch (e) {} }
    },

    /** 자식 시트(deck) 생성 본문 — 순수 함수. §4-2 공유 지점(한 곳만 고친다). */
    planBody(opts) {
      const body = { name: opts.name, page: opts.page || 1, crop: null, deployment_id: opts.deploymentId, parent_id: opts.parentId != null ? opts.parentId : null };
      if (opts.levelNo != null) body.level_no = opts.levelNo;
      return body;
    },

    /** 파일 1개(PDF 전체 또는 이미지 1장) → 새 배포본 — R2 업로드 1회.
     *  🔴 새 업로드 경로 0 — PDF: App._createRegionCopyDeployment(기존 SoT, bytes 전체를 그대로 다중 페이지 배포본으로).
     *      이미지: App._uploadPagesToR2 + App._deploymentBody(기존 저장 본문 SoT) 재사용.
     *  @returns {Promise<string|null>} 배포본 id(실패 시 null — 조용한 성공 위장 금지) */
    async ensureDeploymentForFile(file, name) {
      if (this.isPdfFile(file)) {
        if (typeof App === "undefined" || !App._createRegionCopyDeployment) return null;
        let ab = null;
        try { ab = await file.arrayBuffer(); } catch (e) { return null; }
        return await App._createRegionCopyDeployment(name, ab);
      }
      if (typeof App === "undefined" || !App._uploadPagesToR2 || !App._deploymentBody || !App._blobToDataUrl) return null;
      let dataUrl = null;
      try { dataUrl = await App._blobToDataUrl(file); } catch (e) { return null; }
      let r2pages = null;
      try { r2pages = await App._uploadPagesToR2([dataUrl]); } catch (e) { return null; }
      const body = App._deploymentBody({ title: name, fileName: (file && file.name) || "" }, r2pages, null);
      try {
        const res = await fetch("/tables/deployments", { method: "POST", headers: Auth.headers(), body: JSON.stringify(body) });
        if (!res.ok) return null;
        const rec = await res.json();
        return (rec && rec.id) || null;
      } catch (e) { return null; }
    },

    /** 구역(parentId) 아래 시트 자식 deck 1개 POST — createDeck/extractRegionAsDeck 과 같은 엔드포인트(SoT, 스키마 변경 0).
     *  @returns {Promise<object|null>} 생성된 deck 또는 null */
    async postSheet(projectId, body) {
      try {
        const r = await fetch("/api/projects/" + projectId + "/decks", { method: "POST", headers: Auth.headers(), body: JSON.stringify(body) });
        const d = await r.json();
        if (!r.ok) return null;
        return d;
      } catch (e) { return null; }
    },

    /** 여러 파일 → 각 파일에서 선택한 페이지들을 parentId 아래 자식 시트로 등록.
     *  plans: [{ file, name(배포본 제목), pages: [{page, name, selected}] }]
     *  🔴 선택 0 → POST 0건(부분 생성 금지). 파일/페이지 단위로 성공·실패를 전부 기록해 반환(조용한 실패 금지).
     *  @returns {Promise<{created:Array, failed:Array}>} failed=[{file,page,name,deploymentId?,reason}](재시도용 원자료 보존) */
    async createSheets(projectId, parentId, plans) {
      const created = [], failed = [];
      const list = Array.isArray(plans) ? plans : [];
      for (const plan of list) {
        const pages = (plan.pages || []).filter((p) => p && p.selected);
        if (!pages.length) continue;   // 이 파일은 선택 없음 — 건너뜀(부분 선택 허용)
        const depId = await this.ensureDeploymentForFile(plan.file, plan.name || (plan.file && plan.file.name) || "도면");
        if (!depId) {
          for (const p of pages) failed.push({ file: plan.file, page: p.page, name: p.name, reason: "업로드 실패" });
          continue;
        }
        for (const p of pages) {
          const body = this.planBody({ name: p.name, page: p.page, deploymentId: depId, parentId });
          const d = await this.postSheet(projectId, body);
          if (d && d.id) created.push(d);
          else failed.push({ file: plan.file, page: p.page, name: p.name, deploymentId: depId, reason: "등록 실패" });
        }
      }
      return { created, failed };
    },

    /** 실패분 재시도 — createSheets 와 같은 경로 재사용(§G-2-5). 배포본이 이미 있던 항목(deploymentId)은
     *  재업로드하지 않고 deck POST 만 다시 시도한다 — R2 재업로드 0. */
    async retrySheets(projectId, parentId, failedItems) {
      const created = [], failed = [];
      for (const f of (failedItems || [])) {
        let depId = f.deploymentId || null;
        if (!depId) depId = await this.ensureDeploymentForFile(f.file, f.name);
        if (!depId) { failed.push({ file: f.file, page: f.page, name: f.name, reason: "업로드 실패" }); continue; }
        const body = this.planBody({ name: f.name, page: f.page, deploymentId: depId, parentId });
        const d = await this.postSheet(projectId, body);
        if (d && d.id) created.push(d);
        else failed.push({ file: f.file, page: f.page, name: f.name, deploymentId: depId, reason: "등록 실패" });
      }
      return { created, failed };
    },

    /* ══════════════════════════════════════════════════════════════════
       아래는 DOM 배선(UI) — 구역 ⋯ 메뉴 [도면 여러 장 등록]의 진입점.
       🔴 새 CSS 0 — 기존 .admin-gate/.admin-gate-card/.admin-gate-btn(이미 대비 검증됨, deck-source-modal
       과 동일 패턴)만 재사용. 체크리스트 행은 인라인 스타일만(_syncSourceLinkBar 와 같은 선례).
       ══════════════════════════════════════════════════════════════════ */

    /** 여러 파일 선택(PDF/PNG/JPG, multiple) — 취소 시 null. */
    _pickMultipleFiles() {
      return new Promise((resolve) => {
        const inp = document.createElement("input");
        inp.type = "file"; inp.multiple = true; inp.accept = ".pdf,.png,.jpg,.jpeg"; inp.style.display = "none";
        let settled = false;
        const finish = (files) => { if (settled) return; settled = true; try { inp.remove(); } catch (e) {} resolve(files); };
        inp.addEventListener("change", () => finish(inp.files && inp.files.length ? Array.from(inp.files) : null));
        inp.addEventListener("cancel", () => finish(null));
        document.body.appendChild(inp);
        inp.click();
        setTimeout(() => finish(null), 60000);   // [WO 20260918 선례] 파일창 무응답 상한
      });
    },

    /** 체크리스트 바텀시트 — 파일마다 페이지 행(체크박스+이름 입력+종류 배지). 취소 시 null,
     *  확인 시 [{file,name,pages:[{page,name,selected}]}](사용자가 고친 최종값). */
    _confirmSheetChecklist(plans) {
      return new Promise((resolve) => {
        const overlay = document.createElement("div");
        overlay.className = "admin-gate on";
        overlay.setAttribute("role", "dialog"); overlay.setAttribute("aria-modal", "true");
        const backdrop = document.createElement("div"); backdrop.className = "admin-gate-backdrop";
        const card = document.createElement("div"); card.className = "admin-gate-card";
        card.style.cssText = "max-height:80vh;overflow-y:auto;text-align:left";
        const h = document.createElement("h2"); h.className = "admin-gate-title"; h.textContent = "도면 여러 장 등록";
        const sub = document.createElement("p"); sub.className = "admin-gate-sub"; sub.textContent = "등록할 페이지를 고르고 이름을 확인·수정하세요";
        card.append(h, sub);
        const state = (plans || []).map((p) => ({ file: p.file, name: p.name, pages: (p.pages || []).map((pg) => Object.assign({}, pg)) }));
        const refresh = () => { const t = state.reduce((s, p) => s + p.pages.filter((x) => x.selected).length, 0); okBtn.textContent = (t > 0 ? t : 0) + "장 등록"; okBtn.disabled = t <= 0; };
        state.forEach((plan) => {
          const fh = document.createElement("div");
          fh.style.cssText = "margin:12px 0 4px;font-weight:700;color:#0B1F33;font-size:13.5px";
          fh.textContent = (plan.file && plan.file.name) || plan.name;
          card.appendChild(fh);
          plan.pages.forEach((pg) => {
            const row = document.createElement("div");
            row.style.cssText = "display:flex;align-items:center;gap:8px;margin:4px 0";
            const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = pg.selected !== false;
            cb.addEventListener("change", () => { pg.selected = cb.checked; refresh(); });
            const pageLabel = document.createElement("span");
            pageLabel.style.cssText = "min-width:34px;color:#334155;font-size:12px"; pageLabel.textContent = "p" + pg.page;
            const input = document.createElement("input"); input.type = "text"; input.value = pg.name;
            input.style.cssText = "flex:1;min-width:0;padding:6px 8px;border:1px solid #94A3B8;border-radius:6px;color:#0B1F33;background:#FFFFFF;font-size:13px";
            input.addEventListener("input", () => { pg.name = input.value; });
            const kind = Sheets.kindOf(pg.name);
            const badge = document.createElement("span");
            badge.style.cssText = "font-size:11px;color:#334155;min-width:50px;text-align:right";
            badge.textContent = kind ? ("[" + Sheets.KIND_BADGE[kind] + "]") : "";
            row.append(cb, pageLabel, input, badge);
            card.appendChild(row);
          });
        });
        const actions = document.createElement("div");
        actions.className = "admin-gate-actions"; actions.style.cssText = "flex-direction:column;gap:10px;margin-top:14px";
        const okBtn = document.createElement("button"); okBtn.type = "button"; okBtn.className = "admin-gate-btn primary full";
        const cancelBtn = document.createElement("button"); cancelBtn.type = "button"; cancelBtn.className = "admin-gate-btn ghost full"; cancelBtn.textContent = "취소";
        actions.append(okBtn, cancelBtn);
        card.appendChild(actions);
        overlay.append(backdrop, card);
        document.body.appendChild(overlay);
        refresh();
        const close = (val) => { try { overlay.remove(); } catch (e) {} resolve(val); };
        okBtn.addEventListener("click", () => close(state));
        cancelBtn.addEventListener("click", () => close(null));
        backdrop.addEventListener("click", () => close(null));
      });
    },

    /** 등록 결과 보고 + 실패분 1회 자동 재시도 — 조용한 실패 금지(§5). */
    async _reportSheetResult(result, parentDeck, projectId) {
      const n = (result.created || []).length, f = (result.failed || []).length;
      if (!f) { Prompt.toast && Prompt.toast(n + "개 시트가 '" + ((parentDeck && parentDeck.name) || "") + "' 아래 등록됐습니다", 4200); return; }
      Prompt.toast && Prompt.toast(n + "개 등록, " + f + "개 실패 — 다시 시도합니다", 4000);
      const r2 = await this.retrySheets(projectId, parentDeck.id, result.failed);
      if (r2.created.length && typeof Projects !== "undefined" && Projects.loadDecks) await Projects.loadDecks();
      const f2 = (r2.failed || []).length;
      if (f2) {
        const names = r2.failed.map((x) => x.name).join(", ");
        Prompt.toast && Prompt.toast("최종: 등록 " + (n + r2.created.length) + "개, 실패 " + f2 + "개(" + names + ") — 구역 ⋯ → [도면 여러 장 등록]에서 다시 시도하세요", 6200);
      } else {
        Prompt.toast && Prompt.toast("재시도 성공 — 총 " + (n + r2.created.length) + "개 시트가 등록됐습니다", 4200);
      }
    },

    /** 구역 ⋯ 메뉴 [도면 여러 장 등록] 유일 진입점. */
    async openRegisterSheets(parentDeck) {
      if (typeof Projects === "undefined" || !Projects.currentProject || !parentDeck) return;
      if (typeof Auth !== "undefined" && !Auth.isDesigner) { Prompt.toast && Prompt.toast("설계자만 도면을 등록할 수 있습니다"); return; }
      if (!navigator.onLine) { Prompt.toast && Prompt.toast("오프라인이라 지금은 도면을 등록할 수 없습니다 — 연결 후 다시 시도하세요"); return; }
      const files = await this._pickMultipleFiles();
      if (!files || !files.length) { Prompt.toast && Prompt.toast("도면 등록을 취소했습니다"); return; }
      const plans = [];
      for (const file of files) {
        const peek = await this.peekPages(file);
        const pages = [];
        for (let i = 1; i <= peek.total; i++) pages.push({ page: i, name: this.suggestName(peek.texts[i - 1], file.name, i), selected: true });
        plans.push({ file, name: this._cleanFileName(file.name) || file.name, pages });
      }
      const confirmed = await this._confirmSheetChecklist(plans);
      if (!confirmed) { Prompt.toast && Prompt.toast("도면 등록을 취소했습니다"); return; }
      const totalSelected = confirmed.reduce((s, p) => s + p.pages.filter((x) => x.selected).length, 0);
      if (!totalSelected) { Prompt.toast && Prompt.toast("선택한 페이지가 없어 등록하지 않았습니다"); return; }
      Prompt.toast && Prompt.toast(totalSelected + "개 시트 등록 중…", 3000);
      const result = await this.createSheets(Projects.currentProject.id, parentDeck.id, confirmed);
      if (result.created.length) await Projects.loadDecks();
      await this._reportSheetResult(result, parentDeck, Projects.currentProject.id);
    },

    /* ══════════════════════════════════════════════════════════════════
       [WO 20261016-multiregion] 원본에서 여러 영역 일괄 지정 — 구역 ⋯ 메뉴의
       "원본에서 여러 영역 지정해 이 구역 아래로" 진입점. 복사 로직은 Projects.extractRegionsAsDecks
       (SoT, extractRegionAsDeck 과 공유)에 전부 있다 — 여기는 드래그 반복 + 부모 선택 UI 만.
       ══════════════════════════════════════════════════════════════════ */

    /** 부모 구역 선택 — 기존 트리 ⋯ 팝오버(UI.openTreeMenu, TreeDnD.moveUnderPrompt 와 같은 패턴, 새 위젯 0)
     *  재사용. 취소(팝오버 바깥 클릭)하면 null. */
    _pickParentDeck(decks, defaultDeck) {
      return new Promise((resolve) => {
        if (typeof UI === "undefined" || !UI.openTreeMenu) { resolve(defaultDeck || (decks && decks[0]) || null); return; }
        let settled = false;
        const items = (decks || []).map((d) => ({
          label: (d.name || "(이름 없음)") + (defaultDeck && d.id === defaultDeck.id ? " (이 구역)" : ""),
          run: () => { settled = true; resolve(d); }
        }));
        const fakeAnchor = {
          getBoundingClientRect: () => {
            const w = (typeof window !== "undefined" && window.innerWidth) || 800;
            const h = (typeof window !== "undefined" && window.innerHeight) || 600;
            const cx = w / 2, cy = h / 2;
            return { left: cx - 140, right: cx + 140, top: cy - 20, bottom: cy + 20, width: 280, height: 0 };
          }
        };
        UI.openTreeMenu(fakeAnchor, "영역을 등록할 부모 구역 선택", items);
      });
    },

    /** 등록 결과 보고 + 실패분 1회 자동 재시도(§5 조용한 실패 금지) — createSheets 쪽과 같은 패턴. */
    async _reportRegionResult(result, parentDeck) {
      const n = (result.created || []).length, f = (result.failed || []).length;
      if (!f) { Prompt.toast && Prompt.toast(n + "개 영역이 '" + ((parentDeck && parentDeck.name) || "") + "' 아래 등록됐습니다", 4200); return; }
      Prompt.toast && Prompt.toast(n + "개 등록, " + f + "개 실패 — 다시 시도합니다", 4000);
      const r2 = await Projects.extractRegionsAsDecks(parentDeck.id, result.failed);
      const f2 = (r2.failed || []).length;
      if (f2) {
        const names = r2.failed.map((x) => x.name).join(", ");
        Prompt.toast && Prompt.toast("최종: 등록 " + (n + r2.created.length) + "개, 실패 " + f2 + "개(" + names + ") — 다시 시도하세요", 6200);
      } else {
        Prompt.toast && Prompt.toast("재시도 성공 — 총 " + (n + r2.created.length) + "개 영역이 등록됐습니다", 4200);
      }
    },

    /** 구역 ⋯ 메뉴 [원본에서 여러 영역 지정해 이 구역 아래로] 유일 진입점.
     *  defaultParentDeck = 클릭한 그 구역(기본 부모로 미리 선택되지만, 목록에서 다른 구역으로 바꿀 수 있다). */
    async openMultiRegion(defaultParentDeck) {
      if (typeof Projects === "undefined" || !Projects.currentProject) return;
      const decks = Projects.decks || [];
      if (!decks.length) { Prompt.toast && Prompt.toast("구역이 없습니다 — 먼저 구역을 만드세요"); return; }
      const parent = await this._pickParentDeck(decks, defaultParentDeck);
      if (!parent) { Prompt.toast && Prompt.toast("영역 일괄 지정을 취소했습니다"); return; }
      const regions = [];
      let n = 0;
      while (true) {
        const crop = await Projects._pickDeckCrop("'" + (parent.name || "") + "' 아래 영역 " + (n + 1) + " 을 드래그하세요 — Esc 를 누르면 지정을 마칩니다");
        if (!crop || !(crop.w > 0) || !(crop.h > 0)) break;
        n++;
        const res = (typeof Prompt !== "undefined" && Prompt.ask) ? await Prompt.ask({
          title: "영역 " + n + " 이름", sub: "긁어낸 영역의 이름을 정하세요",
          placeholder: "예: A DK PLAN", value: (parent.name || "영역") + "-" + n
        }) : null;
        const name = (res && String(res.value || "").trim()) || ((parent.name || "영역") + "-" + n);
        regions.push({ crop, name });
      }
      if (!regions.length) { Prompt.toast && Prompt.toast("지정한 영역이 없습니다"); return; }
      Prompt.toast && Prompt.toast(regions.length + "개 영역 등록 중…", 3000);
      const result = await Projects.extractRegionsAsDecks(parent.id, regions);
      await this._reportRegionResult(result, parent);
    }
  };

  if (typeof window !== "undefined") window.Sheets = Sheets;
  if (typeof module !== "undefined" && module.exports) module.exports = Sheets;
})();
