  /* ══════════════════════════════════════════════════════════════
     REVISION — 도면 개정(Rev) 관리 (WO 20261010-revision · 경쟁조사 후보 2: 리비전 동기화)
     ────────────────────────────────────────────────────────────────
     대상 = 메인(원본) 도면 또는 "자기 도면"을 가진 구역(App._deckOwnsDrawing — 창·벡터 복사는 메인 개정을 따른다).
     ① [새 개정 올리기] 파일 선택 → 이 기기에서 페이지 렌더(업로드 0) → 정렬 화면:
        이전/새 도면에 같은 지점을 2~3곳 찍으면 서버(/revisions/preview)가 아핀(2점=닮음, 3점↑=아핀)을 풀어 돌려준다.
        열자마자 [자동 맞춤](비율 같으면 그대로 · 다르면 비율 유지 가운데) 제안을 깔아 둔다.
        미리보기 = 새 도면 위에 이전 도면을 변환해 겹침(투명도 슬라이더) + 핀 이전 위치(흐림) → 새 위치(진함).
        [적용](소유자·super) = 확인창 → 그때 R2 업로드 → 서버가 스냅샷+이월+배포본 갱신을 한 batch 로(base_version 409).
        [제안 보내기](디자이너) = 배포본은 그대로, 이력에 제안으로 남김 → 소유자가 이력에서 [적용].
     ② 적용 뒤 하단 바 [되돌리기 m:ss](서버 REV_UNDO_MS = 10분) — 53_PinPurge 의 바와 같은 패턴·같은 색.
     ③ [개정 이력·비교] 번호·일자·작성자·메모 · [이전 개정 보기](읽기 전용) · [겹쳐 비교](투명도) · 핀 diff(이동/추가/삭제).
     ④ 이월된 핀 = revReview(검토 필요 배지, 11_UI.renderPinsOnMap) — 사람이 [확정]하거나 직접 옮기면 지워진다.
     🔴 계산은 전부 서버(src/lib/revCore.ts) — 여기엔 아핀 풀이·이월 규칙이 없다(두 벌 금지). 행렬 → CSS matrix 변환만 한다.
     🔴 숨김 금지: 오프라인·권한·대상 없음은 비활성 + 사유(reason()) — 트리 ⋯ · 전체 기능 메뉴가 같은 문구.
     🔴 색은 인라인 리터럴(테마 변수 재해석 함정 회피). 대비(계산): 본문 #f8fafc on #0f172a 17.9:1 · 보조 #cbd5e1 on #0f172a 12.0:1
        · 주 버튼 #111827 on #fde68a 14.2:1 · 보조 버튼 #111827 on #e5e7eb 14.3:1 · 비활성 #f1f5f9 on #475569 7.1:1
        · 입력 #111827 on #ffffff 17.7:1 · 경고 #fecaca on #0f172a 13.0:1 · 핀 배지 #111827 on #fde68a 14.2:1. 버튼 최소 36px.
  ══════════════════════════════════════════════════════════════ */
  const Revision = {
    _studio: null,
    _bar: null, _barTimer: null,
    _hist: null,
    _viewer: null,

    C: { bg: "#0f172a", panel: "#1e293b", text: "#f8fafc", sub: "#cbd5e1", warn: "#fecaca", pri: "#fde68a", sec: "#e5e7eb", ink: "#111827", dis: "#475569", disText: "#f1f5f9", oldPt: "#dc2626", newPt: "#2563eb" },

    _toast(m, ms) { try { Prompt.toast(m, ms || 3600); } catch (e) {} },
    _online() { return !(typeof navigator !== "undefined" && navigator.onLine === false); },
    _url(depId, tail) { return "/api/deployments/" + encodeURIComponent(depId) + "/revisions" + (tail || ""); },
    async _req(method, url, body) {
      try {
        const r = await fetch(url, { method, headers: Auth.headers(), body: body == null ? undefined : JSON.stringify(body) });
        let j = null; try { j = await r.json(); } catch (e) {}
        return { status: r.status, j: j || {} };
      } catch (e) { return { status: 0, j: { error: "네트워크 오류 — 서버에 닿지 못했습니다" } }; }
    },
    _r2(u) { return (typeof Auth !== "undefined" && Auth.r2) ? Auth.r2(u) : u; },

    /* ── 대상 ── */
    /** t = {kind:"main"} | {kind:"deck", deck}. 반환 {ok, depId, name, kind} 또는 {ok:false, why}. */
    resolve(t) {
      const P = (typeof Projects !== "undefined") ? Projects : null;
      if (!P || !P.currentProject) return { ok: false, why: "프로젝트를 먼저 여세요" };
      t = t || this.currentTarget();
      if (t.kind === "deck") {
        const d = t.deck;
        if (!d) return { ok: false, why: "구역을 먼저 여세요" };
        if (!d.deployment_id) return { ok: false, why: "이 구역에는 아직 도면이 없습니다 — [도면 등록] 먼저" };
        if (!(App._deckOwnsDrawing && App._deckOwnsDrawing(d))) return { ok: false, why: "이 구역은 메인 도면을 잘라 씁니다 — 메인 도면의 개정으로 올리세요" };
        return { ok: true, kind: "deck", depId: String(d.deployment_id), name: "구역 ‘" + (d.name || "") + "’", deck: d };
      }
      const depId = App._mainDepId ? App._mainDepId() : null;
      if (!depId) return { ok: false, why: "메인(원본) 도면이 아직 없습니다 — 도면을 먼저 등록하세요" };
      return { ok: true, kind: "main", depId: String(depId), name: "메인 도면" };
    },
    /** 지금 화면 기준 대상 — 자기 도면을 가진 구역을 보고 있으면 그 구역, 아니면 메인. */
    currentTarget() {
      const d = (typeof Projects !== "undefined") ? Projects.currentDeck : null;
      if (d && d.deployment_id && App._deckOwnsDrawing && App._deckOwnsDrawing(d)) return { kind: "deck", deck: d };
      return { kind: "main" };
    },
    /** "" = 사용 가능, 그 외 = 비활성 사유. need: "upload"(새 개정 — 디자이너, 온라인) | "history"(이력 — 로그인). */
    reason(t, need) {
      const r = this.resolve(t);
      if (!r.ok) return r.why;
      if (need === "upload") {
        if (!this._online()) return "온라인에서만 — 개정은 오프라인에서 적용·제안하지 않습니다";
        const why = (typeof UI !== "undefined" && UI.permCheck) ? UI.permCheck("designer") : "";
        if (why) return why;
        if (typeof Auth !== "undefined" && Auth.readonly) return "디자이너(편집) 전용";
      } else {
        if (!this._online()) return "온라인에서만 — 개정 이력은 서버에 있습니다";
        const why = (typeof UI !== "undefined" && UI.permCheck) ? UI.permCheck("login") : "";
        if (why) return why;
      }
      return "";
    },
    _isOpen(depId) {
      return String(State.currentDeploymentId || "") === String(depId) || String(State.autoSaveDepId || "") === String(depId);
    },

    /* ══ ① 새 개정 올리기 ══ */
    async start(t) {
      t = t || this.currentTarget();
      const why = this.reason(t, "upload");
      if (why) { this._toast("새 개정 — " + why); return { done: false, stage: "reason", why }; }
      const tg = this.resolve(t);
      if (this._isOpen(tg.depId) && App._dirty) { this._toast("저장하지 않은 변경이 있습니다 — 먼저 [저장]한 뒤 개정을 올리세요", 5200); return { done: false, stage: "dirty" }; }
      const info = await this._req("GET", this._url(tg.depId));
      if (info.status !== 200) { this._toast("개정 정보를 불러오지 못했습니다 — " + (info.j.error || info.status)); return { done: false, stage: "info" }; }
      if (!info.j.ready) { this._toast("서버 준비가 끝나지 않아(마이그레이션 0040) 개정을 올릴 수 없습니다", 5200); return { done: false, stage: "ready" }; }
      const file = App._pickDrawingFile ? await App._pickDrawingFile() : null;
      if (!file) return { done: false, stage: "file" };
      return this.openStudio(tg, info.j, file);
    },

    /** 파일 → 이 기기에서 페이지 이미지(dataURL) + 실측 픽셀. 업로드는 [적용] 때만. */
    async _renderFile(file) {
      const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name || "");
      if (!isPdf) return { isPdf: false, pages: [await App._blobToDataUrl(file)], dims: null, ab: null };
      const ab = await App._readAsArrayBuffer(file);
      const keepDims = PDF.lastSnapshotDims;
      const doc = await PDF.load(ab.slice(0));
      try {
        const pages = await PDF.snapshotAllPages(doc);
        const dims = PDF.lastSnapshotDims;
        return { isPdf: true, pages, dims, ab };
      } finally {
        PDF.lastSnapshotDims = keepDims;   // 지금 열린 도면의 실측값을 오염시키지 않는다
        try { doc.destroy && doc.destroy(); } catch (e) {}
      }
    },

    async openStudio(tg, info, file) {
      this.closeStudio();
      const s = { tg, info, file, page: 1, src: [], dst: [], pv: null, mode: "auto", busy: false, opacity: 0.5 };
      this._studio = s;
      this._buildStudio(s);
      this._status(s, "새 도면을 이 기기에서 그리는 중… (아직 업로드하지 않습니다)");
      try {
        const dep = await this._req("GET", "/tables/deployments/" + encodeURIComponent(tg.depId));
        let old = []; try { old = JSON.parse(dep.j.pages_data || "[]"); } catch (e) {}
        if ((!Array.isArray(old) || !old.length) && dep.j.drawing_data) old = [dep.j.drawing_data];
        s.oldPages = old;
        s.baseVersion = dep.j.version != null ? Number(dep.j.version) : info.deployment.version;
        const r = await this._renderFile(file);
        if (this._studio !== s) return { done: false, stage: "closed" };
        Object.assign(s, r);
        if (!s.pages || !s.pages.length) throw new Error("새 도면을 그리지 못했습니다");
        if (this._isOpen(tg.depId) && State.pdfPage && State.pdfPage <= Math.min(s.pages.length, s.oldPages.length)) s.page = State.pdfPage;
        this._fillPageSelect(s);
        await this._loadImages(s);
        await this._preview(s);
        return { done: true, stage: "studio" };
      } catch (e) {
        this._status(s, "새 도면을 열지 못했습니다 — " + (e && e.message || e), true);
        return { done: false, stage: "render" };
      }
    },

    _btn(label, kind, fn) {
      const C = this.C, b = document.createElement("button");
      b.type = "button"; b.textContent = label; b.dataset.kind = kind;
      b.style.cssText = "border:0;border-radius:8px;padding:8px 14px;font-size:14px;font-weight:700;cursor:pointer;min-height:36px;min-width:36px;"
        + "background:" + (kind === "pri" ? C.pri : C.sec) + ";color:" + C.ink + ";";
      if (fn) b.addEventListener("click", (e) => { e.stopPropagation(); if (!b.disabled) fn(b); });
      return b;
    },
    _setDisabled(b, dis, why) {
      const C = this.C;
      b.disabled = !!dis; b.setAttribute("aria-disabled", dis ? "true" : "false");
      b.style.background = dis ? C.dis : (b.dataset.kind === "pri" ? C.pri : C.sec);
      b.style.color = dis ? C.disText : C.ink;
      b.style.cursor = dis ? "not-allowed" : "pointer";
      b.title = why || "";
    },
    _overlay(id, title) {
      const C = this.C, ov = document.createElement("div");
      ov.id = id; ov.setAttribute("role", "dialog"); ov.setAttribute("aria-modal", "true"); ov.setAttribute("aria-label", title);
      ov.style.cssText = "position:fixed;inset:0;z-index:10040;background:" + C.bg + ";color:" + C.text + ";overflow:auto;-webkit-overflow-scrolling:touch;"
        + "font-size:14px;line-height:1.45;padding:12px;box-sizing:border-box;";
      const head = document.createElement("div");
      head.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px;";
      const h = document.createElement("h2");
      h.textContent = title; h.style.cssText = "margin:0;font-size:17px;font-weight:800;flex:1 1 200px;color:" + C.text + ";";
      head.appendChild(h);
      ov.appendChild(head);
      ov._head = head;
      return ov;
    },
    _field(labelText, input) {
      const C = this.C, w = document.createElement("label");
      w.style.cssText = "display:flex;flex-direction:column;gap:3px;font-size:12px;color:" + C.sub + ";flex:1 1 140px;min-width:120px;";
      w.appendChild(document.createTextNode(labelText));
      input.style.cssText = "background:#ffffff;color:" + C.ink + ";border:1px solid #94a3b8;border-radius:7px;padding:7px 9px;font-size:14px;min-height:36px;box-sizing:border-box;width:100%;";
      w.appendChild(input);
      return w;
    },

    _buildStudio(s) {
      const C = this.C, info = s.info;
      const ov = this._overlay("rev-studio", "새 개정 올리기 — " + s.tg.name);
      ov._head.appendChild(this._btn("닫기", "sec", () => this.closeStudio()));
      // 개정 정보
      const form = document.createElement("div");
      form.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;background:" + C.panel + ";border-radius:10px;padding:10px;margin-bottom:8px;";
      const mk = (type, val, ph) => { const i = document.createElement("input"); i.type = type; i.value = val || ""; if (ph) i.placeholder = ph; return i; };
      s.inLabel = mk("text", info.next_label || "Rev.1", "예: Rev.B · Rev.1"); s.inLabel.id = "rev-in-label";
      form.appendChild(this._field("새 개정 번호", s.inLabel));
      if (!info.current_label) {
        s.inBase = mk("text", "Rev.0", "예: Rev.A · Rev.0"); s.inBase.id = "rev-in-base";
        form.appendChild(this._field("지금 도면의 개정 번호(첫 개정)", s.inBase));
      }
      s.inDate = mk("date", new Date().toISOString().slice(0, 10)); s.inDate.id = "rev-in-date";
      form.appendChild(this._field("개정 일자", s.inDate));
      s.inMemo = mk("text", "", "변경 내용(예: B12 블록 격벽 위치 변경)"); s.inMemo.id = "rev-in-memo";
      const mw = this._field("메모", s.inMemo); mw.style.flex = "3 1 260px";
      form.appendChild(mw);
      const cur = document.createElement("div");
      cur.style.cssText = "flex:1 1 100%;font-size:13px;color:" + C.sub + ";";
      cur.textContent = "파일: " + (s.file.name || "") + " · 현재 개정: " + (info.current_label || "(이력 없음)") + " · 기준점은 이전/새 도면에서 같은 지점(기둥·격벽 모서리 등)을 같은 순서로 2~3곳";
      form.appendChild(cur);
      ov.appendChild(form);
      // 도구
      const tools = document.createElement("div");
      tools.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px;";
      tools.appendChild(this._btn("자동 맞춤", "sec", () => { s.src = []; s.dst = []; s.mode = "auto"; this._drawPoints(s); this._preview(s); }));
      tools.appendChild(this._btn("기준점 지우기", "sec", () => { s.src = []; s.dst = []; s.mode = "auto"; this._drawPoints(s); this._preview(s); }));
      s.selPage = document.createElement("select");
      s.selPage.setAttribute("aria-label", "정렬할 페이지");
      s.selPage.style.cssText = "background:#ffffff;color:" + C.ink + ";border-radius:7px;min-height:36px;padding:4px 8px;font-size:14px;";
      s.selPage.addEventListener("change", () => { s.page = Number(s.selPage.value) || 1; s.src = []; s.dst = []; s.mode = "auto"; this._loadImages(s).then(() => this._preview(s)); });
      tools.appendChild(s.selPage);
      ov.appendChild(tools);
      // 기준점 두 칸
      const panes = document.createElement("div");
      panes.className = "rev-panes";
      panes.style.cssText = "display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));gap:8px;margin-bottom:8px;";
      s.paneOld = this._pane(s, "old", "이전 개정 " + (info.current_label || "") + " — 기준점 찍기", C.oldPt);
      s.paneNew = this._pane(s, "new", "새 개정 — 같은 지점 찍기", C.newPt);
      panes.append(s.paneOld.wrap, s.paneNew.wrap);
      ov.appendChild(panes);
      // 미리보기
      const pvw = document.createElement("div");
      pvw.style.cssText = "background:" + C.panel + ";border-radius:10px;padding:10px;margin-bottom:8px;";
      const pvh = document.createElement("div");
      pvh.style.cssText = "display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:6px;";
      const pvt = document.createElement("strong"); pvt.textContent = "미리보기 — 새 도면 위에 이전 도면(변환) · 핀 이전 위치(흐림) → 새 위치";
      pvt.style.cssText = "flex:1 1 240px;color:" + C.text + ";";
      const sl = document.createElement("input"); sl.type = "range"; sl.min = "0"; sl.max = "100"; sl.value = String(Math.round(s.opacity * 100)); sl.id = "rev-opacity";
      sl.setAttribute("aria-label", "이전 도면 투명도"); sl.style.cssText = "min-height:32px;width:160px;";
      sl.addEventListener("input", () => { s.opacity = Number(sl.value) / 100; if (s.pvOld) s.pvOld.style.opacity = String(s.opacity); });
      const sll = document.createElement("span"); sll.textContent = "이전 도면 투명도"; sll.style.color = C.sub;
      pvh.append(pvt, sll, sl);
      pvw.appendChild(pvh);
      s.pvBox = document.createElement("div");
      s.pvBox.className = "rev-preview";
      s.pvBox.style.cssText = "position:relative;width:100%;max-width:1100px;margin:0 auto;background:#ffffff;overflow:hidden;";
      pvw.appendChild(s.pvBox);
      ov.appendChild(pvw);
      s.summary = document.createElement("div");
      s.summary.id = "rev-summary"; s.summary.setAttribute("aria-live", "polite");
      s.summary.style.cssText = "margin-bottom:8px;white-space:pre-line;color:" + C.text + ";";
      ov.appendChild(s.summary);
      // 하단
      const foot = document.createElement("div");
      foot.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;align-items:center;position:sticky;bottom:0;background:" + C.bg + ";padding:8px 0;";
      s.btnApply = this._btn(info.can_apply ? "적용" : "제안 보내기", "pri", () => this._commit(s, !info.can_apply));
      s.btnApply.id = "rev-apply"; s.btnApply.dataset.kind = "pri";
      s.whyApply = document.createElement("span"); s.whyApply.style.cssText = "color:" + C.sub + ";font-size:13px;flex:1 1 200px;";
      s.whyApply.textContent = info.can_apply ? "적용하면 10분 안에 되돌릴 수 있습니다" : "소유자·관리자 전용 적용 — 디자이너는 제안으로 보내고 소유자가 이력에서 적용합니다";
      foot.append(s.btnApply, this._btn("취소", "sec", () => this.closeStudio()), s.whyApply);
      ov.appendChild(foot);
      this._setDisabled(s.btnApply, true, "미리보기 준비 중");
      s.onKey = (e) => { if (e.key === "Escape") this.closeStudio(); };
      document.addEventListener("keydown", s.onKey);
      s.onResize = () => this._renderPreview(s);
      window.addEventListener("resize", s.onResize);
      document.body.appendChild(ov);
      s.ov = ov;
    },

    _pane(s, side, title, color) {
      const C = this.C, wrap = document.createElement("div");
      wrap.style.cssText = "background:" + C.panel + ";border-radius:10px;padding:8px;";
      const h = document.createElement("div"); h.textContent = title;
      h.style.cssText = "font-weight:700;margin-bottom:6px;color:" + C.text + ";border-left:5px solid " + color + ";padding-left:6px;";
      const box = document.createElement("div");
      box.className = "rev-pane"; box.dataset.side = side;
      box.style.cssText = "position:relative;width:100%;background:#ffffff;cursor:crosshair;touch-action:manipulation;";
      const img = document.createElement("img");
      img.alt = title; img.draggable = false;
      img.style.cssText = "display:block;width:100%;height:auto;user-select:none;-webkit-user-drag:none;";
      const layer = document.createElement("div");
      layer.style.cssText = "position:absolute;inset:0;pointer-events:none;";
      box.append(img, layer);
      box.addEventListener("click", (e) => {
        const r = img.getBoundingClientRect();
        if (!r.width || !r.height) return;
        const p = { x: Math.max(0, Math.min(100, (e.clientX - r.left) / r.width * 100)), y: Math.max(0, Math.min(100, (e.clientY - r.top) / r.height * 100)) };
        this.addPoint(side, p);
      });
      wrap.append(h, box);
      return { wrap, box, img, layer };
    },

    /** 기준점 추가(화면 클릭·테스트 공용). side = "old"|"new", p = {x,y} %. 최대 4쌍. */
    addPoint(side, p) {
      const s = this._studio;
      if (!s) return false;
      const arr = side === "old" ? s.src : s.dst;
      if (arr.length >= 4) { this._toast("기준점은 4개까지 — [기준점 지우기] 후 다시 찍으세요"); return false; }
      arr.push({ x: +p.x.toFixed(4), y: +p.y.toFixed(4) });
      this._drawPoints(s);
      const n = Math.min(s.src.length, s.dst.length);
      if (n >= 2 && s.src.length === s.dst.length) { s.mode = "points"; this._preview(s); }
      else this._status(s, "기준점 이전 " + s.src.length + " · 새 " + s.dst.length + " — 양쪽 같은 순서로 2쌍 이상 찍으면 미리보기가 갱신됩니다");
      return true;
    },

    _drawPoints(s) {
      const draw = (pane, pts, color) => {
        pane.layer.innerHTML = "";
        pts.forEach((p, i) => {
          const d = document.createElement("div");
          d.className = "rev-pt";
          d.textContent = String(i + 1);
          d.style.cssText = "position:absolute;left:" + p.x + "%;top:" + p.y + "%;transform:translate(-50%,-50%);width:24px;height:24px;border-radius:50%;"
            + "background:" + color + ";color:#ffffff;border:2px solid #ffffff;box-shadow:0 0 0 2px #111827;font-size:13px;font-weight:800;line-height:20px;text-align:center;";
          pane.layer.appendChild(d);
        });
      };
      draw(s.paneOld, s.src, this.C.oldPt);
      draw(s.paneNew, s.dst, this.C.newPt);
    },

    _fillPageSelect(s) {
      const n = Math.max(1, Math.min((s.pages || []).length, (s.oldPages || []).length || 1));
      s.selPage.innerHTML = "";
      for (let i = 1; i <= n; i++) { const o = document.createElement("option"); o.value = String(i); o.textContent = "페이지 " + i + " 기준"; s.selPage.appendChild(o); }
      s.selPage.value = String(Math.min(s.page, n));
      s.selPage.disabled = n <= 1;
      s.selPage.style.background = n <= 1 ? "#cbd5e1" : "#ffffff"; s.selPage.style.opacity = "1";   // 비활성도 #111827 on #cbd5e1 = 12.0:1
      if ((s.pages || []).length !== (s.oldPages || []).length) {
        this._status(s, "주의: 페이지 수가 다릅니다(이전 " + (s.oldPages || []).length + " · 새 " + (s.pages || []).length + ") — 없는 페이지의 핀은 표시되지 않을 수 있습니다", true);
      }
    },

    _imgReady(img, src) {
      return new Promise((res) => {
        img.onload = () => res(true); img.onerror = () => res(false);
        img.src = src;
        if (img.complete && img.naturalWidth) res(true);
      });
    },
    async _loadImages(s) {
      const o = s.oldPages[s.page - 1] || s.oldPages[0], n = s.pages[s.page - 1] || s.pages[0];
      const okO = await this._imgReady(s.paneOld.img, /^data:/i.test(o || "") ? o : this._r2(o));
      const okN = await this._imgReady(s.paneNew.img, n);
      if (!okO || !okN) throw new Error(!okO ? "이전 도면 이미지를 불러오지 못했습니다" : "새 도면 이미지를 불러오지 못했습니다");
      s.srcDims = { w: s.paneOld.img.naturalWidth, h: s.paneOld.img.naturalHeight };
      s.dstDims = { w: s.paneNew.img.naturalWidth, h: s.paneNew.img.naturalHeight };
      this._drawPoints(s);
    },

    async _preview(s) {
      if (!s.srcDims || !s.dstDims) return;
      const body = s.mode === "points" && Math.min(s.src.length, s.dst.length) >= 2
        ? { src_dims: s.srcDims, dst_dims: s.dstDims, src_pts: s.src.slice(0, Math.min(s.src.length, s.dst.length)), dst_pts: s.dst.slice(0, Math.min(s.src.length, s.dst.length)) }
        : { mode: "auto", src_dims: s.srcDims, dst_dims: s.dstDims };
      const seq = (s.pvSeq = (s.pvSeq || 0) + 1);
      this._setDisabled(s.btnApply, true, "미리보기 계산 중");
      const r = await this._req("POST", this._url(s.tg.depId, "/preview"), body);
      if (this._studio !== s || seq !== s.pvSeq) return;
      if (r.status !== 200) {
        s.pv = null;
        this._status(s, "변환을 계산하지 못했습니다 — " + (r.j.error || r.status), true);
        this._setDisabled(s.btnApply, true, r.j.error || "변환 없음");
        return;
      }
      s.pv = r.j;
      this._renderPreview(s);
      const sm = r.j.summary || {};
      const kindTxt = { identity: "자동 — 비율이 같아 좌표(%) 그대로", fit: "자동 — 비율 유지·가운데 맞춤", similarity: "기준점 2쌍 — 이동·회전·배율", affine: "기준점 " + Math.min(s.src.length, s.dst.length) + "쌍 — 아핀(기울임 포함)" }[r.j.kind] || r.j.kind;
      const lines = [kindTxt + (r.j.kind === "affine" ? " · 기준점 잔차 " + (r.j.rms || 0).toFixed(2) + "%" : ""),
        "이월: 핀 " + (sm.pins || 0) + "개(전부 '검토 필요' 표시) · 영역 " + (sm.zones || 0) + " · 주석 " + (sm.annotations || 0) + " · 구역 윤곽 " + (sm.decks || 0)];
      if (sm.out) lines.push("⚠ 새 도면 밖으로 나가는 핀 " + sm.out + "개 — 기준점을 다시 확인하세요(지우지 않고 '도면 밖' 배지로 남깁니다)");
      if (r.j.kind === "affine" && r.j.max_err > 1) lines.push("⚠ 기준점 하나가 " + r.j.max_err.toFixed(1) + "% 어긋납니다 — 같은 지점을 찍었는지 확인하세요");
      this._status(s, lines.join("\n"), !!sm.out);
      const why = this._online() ? "" : "오프라인 — 온라인에서만 적용합니다";
      this._setDisabled(s.btnApply, !!why, why);
    },

    /** % 아핀 → 상자(px) CSS matrix. 상자 = 새 도면 크기. 이전 도면을 상자에 늘려 그린 뒤 변환하면 % 좌표 대응과 같다. */
    _cssMatrix(t, W, H) {
      return "matrix(" + [t.a, t.b * H / W, t.c * W / H, t.d, t.e * W / 100, t.f * H / 100].map((v) => +v.toFixed(6)).join(",") + ")";
    },
    _renderPreview(s) {
      if (!s || !s.pvBox || !s.pv) return;
      const box = s.pvBox, t = s.pv.transform;
      box.innerHTML = "";
      const base = document.createElement("img");
      base.src = s.paneNew.img.src; base.alt = "새 개정"; base.style.cssText = "display:block;width:100%;height:auto;";
      box.appendChild(base);
      const place = () => {
        const W = box.clientWidth, H = base.clientHeight || (W * s.dstDims.h / s.dstDims.w);
        const old = document.createElement("img");
        old.src = s.paneOld.img.src; old.alt = "이전 개정(변환)";
        old.className = "rev-pv-old";
        old.style.cssText = "position:absolute;left:0;top:0;width:" + W + "px;height:" + H + "px;transform-origin:0 0;transform:" + this._cssMatrix(t, W, H) + ";opacity:" + s.opacity + ";pointer-events:none;mix-blend-mode:multiply;";
        box.appendChild(old);
        s.pvOld = old;
        const layer = document.createElement("div");
        layer.style.cssText = "position:absolute;inset:0;pointer-events:none;";
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 100 100"); svg.setAttribute("preserveAspectRatio", "none");
        svg.style.cssText = "position:absolute;inset:0;width:100%;height:100%;overflow:visible;";
        layer.appendChild(svg);
        (s.pv.pins || []).filter((p) => (p.page || 1) === s.page).forEach((p) => {
          const ln = document.createElementNS("http://www.w3.org/2000/svg", "line");
          ln.setAttribute("x1", p.x); ln.setAttribute("y1", p.y); ln.setAttribute("x2", p.nx); ln.setAttribute("y2", p.ny);
          ln.setAttribute("stroke", "#111827"); ln.setAttribute("stroke-width", "1.5"); ln.setAttribute("vector-effect", "non-scaling-stroke"); ln.setAttribute("stroke-dasharray", "3 2");
          svg.appendChild(ln);
          const dot = (x, y, cls, css, txt) => {
            const d = document.createElement("div"); d.className = cls;
            d.style.cssText = "position:absolute;left:" + x + "%;top:" + y + "%;transform:translate(-50%,-50%);" + css;
            if (txt != null) d.textContent = txt;
            layer.appendChild(d);
          };
          dot(p.x, p.y, "rev-pv-was", "width:12px;height:12px;border-radius:50%;background:#64748b;opacity:.45;border:1px solid #111827;");
          dot(Math.max(0, Math.min(100, p.nx)), Math.max(0, Math.min(100, p.ny)), "rev-pv-now" + (p.out ? " rev-pv-out" : ""),
            "min-width:22px;height:22px;padding:0 3px;box-sizing:border-box;border-radius:11px;background:" + (p.out ? "#fecaca" : "#fde68a") + ";color:#111827;border:2px solid #111827;font-size:11px;font-weight:800;line-height:18px;text-align:center;", p.label || "•");
        });
        box.appendChild(layer);
      };
      if (base.complete && base.naturalWidth) place(); else base.onload = place;
    },

    _status(s, msg, warn) {
      if (!s || !s.summary) return;
      s.summary.textContent = msg;
      s.summary.style.color = warn ? this.C.warn : this.C.text;
    },

    async _commit(s, propose) {
      if (!s || s.busy || !s.pv) return { done: false, stage: "busy" };
      if (!this._online()) { this._status(s, "오프라인 — 개정을 적용하지 않았습니다", true); return { done: false, stage: "offline" }; }
      const label = String(s.inLabel.value || "").trim();
      if (!label) { this._status(s, "새 개정 번호를 입력하세요", true); s.inLabel.focus(); return { done: false, stage: "label" }; }
      const base = s.inBase ? String(s.inBase.value || "").trim() : "";
      const sm = s.pv.summary || {};
      const msg = (propose ? "이 개정을 소유자에게 제안합니다(지금 도면은 바뀌지 않습니다).\n" : "")
        + (s.info.current_label || base || "현재") + " → " + label + "\n"
        + "· 핀 " + (sm.pins || 0) + "개 좌표 이월 — 전부 '검토 필요' 표시(확정하면 사라짐)\n"
        + "· 영역 " + (sm.zones || 0) + " · 주석 " + (sm.annotations || 0) + " · 구역 윤곽 " + (sm.decks || 0) + " 함께 이월\n"
        + (sm.out ? "· ⚠ 도면 밖으로 나가는 핀 " + sm.out + "개\n" : "")
        + "· 이전 도면 원본은 지우지 않고 이력에 보관합니다\n"
        + (propose ? "" : "· 적용 후 10분 안에 [되돌리기] 할 수 있습니다\n") + "계속할까요?";
      if (!(await Prompt.confirm(propose ? "개정 제안" : "개정 적용", msg))) return { done: false, stage: "confirm" };
      s.busy = true;
      this._setDisabled(s.btnApply, true, "업로드 중");
      try {
        this._status(s, "새 도면 업로드 중…");
        const r2pages = await App._uploadPagesToR2(s.pages);
        let meta = null;
        if (s.isPdf) {
          const url = await App._uploadSourcePdf(s.ab);
          if (!url) { this._status(s, "원본 PDF 보관(업로드) 실패 — 개정을 적용하지 않았습니다. 다시 시도하세요", true); return { done: false, stage: "upload" }; }
          meta = App._sourceMetaJson(url, Array.isArray(s.dims) ? s.dims : []);
        }
        const body = { rev_label: label, prev_label: base || undefined, rev_date: s.inDate.value, memo: s.inMemo.value, file_name: s.file.name || "",
          pages_data: JSON.stringify(r2pages), drawing_data: r2pages[0], source_meta: meta, transform: s.pv.transform, base_version: s.baseVersion, propose: !!propose };
        const res = await this._req("POST", this._url(s.tg.depId), body);
        if (res.status !== 200) {
          const why = res.j.duplicate_label ? res.j.error : res.status === 409 ? "다른 사용자가 먼저 저장했습니다 — 창을 닫고 다시 여세요(최신본 기준)" : (res.j.error || ("HTTP " + res.status));
          this._status(s, (propose ? "제안" : "적용") + "하지 않았습니다 — " + why, true);
          return { done: false, stage: "server", status: res.status };
        }
        const tg = s.tg;
        this.closeStudio();
        if (propose) { this._toast("개정 " + res.j.rev_label + " 제안을 보냈습니다 — 소유자가 [개정 이력]에서 적용하면 반영됩니다", 5200); return { done: true, proposed: true, id: res.j.id }; }
        await this._afterServerChange(tg);
        this._showBar(tg, res.j);
        return { done: true, id: res.j.id, carried: res.j.carried };
      } finally {
        s.busy = false;
        if (this._studio === s) this._setDisabled(s.btnApply, false, "");
      }
    },

    closeStudio() {
      const s = this._studio;
      this._studio = null;
      if (!s) return;
      if (s.onKey) document.removeEventListener("keydown", s.onKey);
      if (s.onResize) window.removeEventListener("resize", s.onResize);
      if (s.ov && s.ov.parentNode) s.ov.parentNode.removeChild(s.ov);
    },

    /** 서버본이 바뀌었다(도면·핀·구역 윤곽) — 구역 목록을 다시 받고, 그 도면이 열려 있으면 다시 연다. */
    async _afterServerChange(tg) {
      try {
        if (typeof Projects !== "undefined" && Projects.loadDecks) await Projects.loadDecks();
        if (!this._isOpen(tg.depId)) return;
        if (tg.kind === "main" && !Projects.currentDeck) { await Projects.openOriginal(); return; }
        const d = Projects.currentDeck && (Projects.decks || []).find((x) => String(x.id) === String(Projects.currentDeck.id));
        if (d) Projects.currentDeck = d;
        await App.loadDeckDrawing(tg.depId);
        if (Projects.currentDeck && Projects._applyDeckCropView) Projects._applyDeckCropView(Projects.currentDeck);
      } catch (e) {}
    },

    /* ── ② 하단 결과·되돌리기 바(53_PinPurge 와 같은 패턴·색) ── */
    _showBar(tg, j) {
      this.closeBar();
      const bar = document.createElement("div");
      bar.id = "rev-undo-bar"; bar.setAttribute("role", "status"); bar.setAttribute("aria-live", "polite");
      // bottom 76px — 이미지 개정 직후 뜨는 하단 원본 안내 바(bottom 16px)를 덮지 않게 그 위(CDP 1280 스크린샷 실측).
      bar.style.cssText = "position:fixed;left:50%;bottom:76px;transform:translateX(-50%);z-index:10050;max-width:min(560px,calc(100vw - 24px));"
        + "box-sizing:border-box;background:#111827;color:#ffffff;border-radius:10px;padding:10px 12px;font-size:14px;line-height:1.45;"
        + "box-shadow:0 6px 24px rgba(0,0,0,.35);display:flex;flex-wrap:wrap;gap:8px;align-items:center;";
      const msg = document.createElement("div");
      msg.className = "rev-undo-msg"; msg.style.cssText = "flex:1 1 220px;min-width:0;color:#ffffff;";
      const c = j.carried || {};
      msg.textContent = "개정 " + (j.prev_label || "") + " → " + j.rev_label + " 적용 — 핀 " + (c.pins || 0) + "개 이월(검토 필요)" + (c.out ? " · 도면 밖 " + c.out : "");
      bar.appendChild(msg);
      const mk = (label, cls, bg, fn) => {
        const b = document.createElement("button");
        b.type = "button"; b.className = cls; b.textContent = label;
        b.style.cssText = "background:" + bg + ";color:#111827;border:0;border-radius:8px;padding:6px 12px;font-size:14px;font-weight:700;cursor:pointer;min-height:36px;";
        b.addEventListener("click", (e) => { e.stopPropagation(); fn(b); });
        bar.appendChild(b);
        return b;
      };
      if (j.undo_until) {
        const until = Number(j.undo_until);
        const ub = mk("되돌리기", "rev-undo", "#fde68a", (b) => { b.disabled = true; this.undo(tg, j.id); });
        const tick = () => {
          const left = until - Date.now();
          if (left <= 0) { this._dropUndo(); this._barText(msg.textContent + " · 되돌리기 시간이 지났습니다"); this._autoClose(6000); return; }
          const sec = Math.ceil(left / 1000);
          ub.textContent = "되돌리기 " + Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
        };
        tick();
        this._barTimer = setInterval(tick, 1000);
      }
      mk("닫기", "rev-undo-close", "#e5e7eb", () => this.closeBar());
      document.body.appendChild(bar);
      this._bar = bar; this._barMsg = msg;
    },
    _barText(t, bad) { if (this._barMsg) { this._barMsg.textContent = t; this._barMsg.style.color = bad ? "#fecaca" : "#ffffff"; } },
    _dropUndo() { if (this._barTimer) { clearInterval(this._barTimer); this._barTimer = null; } const b = this._bar && this._bar.querySelector(".rev-undo"); if (b) b.remove(); },
    _autoClose(ms) { const bar = this._bar; setTimeout(() => { if (this._bar === bar) this.closeBar(); }, ms); },
    closeBar() {
      if (this._barTimer) { clearInterval(this._barTimer); this._barTimer = null; }
      if (this._bar && this._bar.parentNode) this._bar.parentNode.removeChild(this._bar);
      this._bar = null; this._barMsg = null;
    },

    async undo(tg, rid) {
      const r = await this._req("POST", this._url(tg.depId, "/" + encodeURIComponent(rid) + "/undo"));
      if (!this._bar) this._toast(r.status === 200 ? "개정을 되돌렸습니다 — " + (r.j.prev_label || "이전 개정") + " 로 복원" : "되돌리지 못했습니다 — " + (r.j.error || r.status), 4200);
      if (r.status === 200) {
        await this._afterServerChange(tg);
        this._barText("되돌렸습니다 — " + (r.j.prev_label || "이전 개정") + " 로 복원(핀 " + ((r.j.restored && r.j.restored.pins) || 0) + "개" + (r.j.exact ? "" : " · 적용 뒤 저장한 변경은 유지") + ")");
      } else {
        this._barText("되돌리지 못했습니다 — " + (r.j.error || r.status), true);
      }
      this._dropUndo();
      this._autoClose(8000);
      if (this._hist && this._hist.tg && this._hist.tg.depId === tg.depId) this.openHistory(this._hist.t);
      return { status: r.status, j: r.j };
    },

    /* ══ ③ 개정 이력 · 이전 개정 보기 · 겹쳐 비교 ══ */
    async openHistory(t) {
      t = t || this.currentTarget();
      const why = this.reason(t, "history");
      if (why) { this._toast("개정 이력 — " + why); return { done: false, stage: "reason", why }; }
      const tg = this.resolve(t);
      const r = await this._req("GET", this._url(tg.depId));
      if (r.status !== 200) { this._toast("개정 이력을 불러오지 못했습니다 — " + (r.j.error || r.status)); return { done: false, stage: "info" }; }
      this.closeHistory();
      const C = this.C, j = r.j;
      const ov = this._overlay("rev-history", "개정 이력 — " + tg.name);
      ov._head.appendChild(this._btn("새 개정 올리기", "pri", () => { this.closeHistory(); this.start(t); }));
      const upWhy = this.reason(t, "upload");
      if (upWhy) this._setDisabled(ov._head.lastChild, true, upWhy);
      ov._head.lastChild.dataset.kind = "pri";
      ov._head.appendChild(this._btn("닫기", "sec", () => this.closeHistory()));
      this._hist = { ov, t, tg, j };
      const top = document.createElement("div");
      top.style.cssText = "background:" + C.panel + ";border-radius:10px;padding:10px;margin-bottom:8px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;";
      const st = document.createElement("div"); st.style.cssText = "flex:1 1 260px;color:" + C.text + ";";
      st.textContent = !j.ready ? "서버 준비 전(마이그레이션 0040) — 개정 이력을 쓸 수 없습니다"
        : "현재 개정: " + (j.current_label || "(이력 없음)") + " · 다음 제안 번호: " + j.next_label + " · 검토 필요 핀: " + (j.review_pins || 0) + "개";
      top.appendChild(st);
      if (j.review_pins) {
        const open = this._isOpen(tg.depId);
        const cb = this._btn("검토 필요 핀 모두 확정", "pri", () => this.confirmReview(tg, null));
        cb.dataset.kind = "pri"; cb.id = "rev-confirm-all";
        const cwhy = !open ? "이 도면을 연 뒤 확정하세요(트리에서 열기)" : ((typeof UI !== "undefined" && UI.permCheck) ? UI.permCheck("designer") : "");
        this._setDisabled(cb, !!cwhy, cwhy);
        top.appendChild(cb);
        if (cwhy) { const w = document.createElement("span"); w.textContent = cwhy; w.style.cssText = "color:" + C.sub + ";font-size:13px;"; top.appendChild(w); }
      }
      ov.appendChild(top);
      if (j.review_pins && this._isOpen(tg.depId)) ov.appendChild(this._reviewList(tg));
      const list = document.createElement("div");
      list.id = "rev-history-list";
      list.style.cssText = "display:flex;flex-direction:column;gap:6px;";
      const rows = (j.revisions || []).slice().reverse();
      if (j.base_label) rows.push({ id: null, kind: "base", rev_label: j.base_label });
      if (!rows.length) { const e = document.createElement("div"); e.textContent = "아직 개정 이력이 없습니다 — [새 개정 올리기]로 첫 개정을 올리면 지금 도면이 기준 개정으로 보관됩니다."; e.style.color = C.sub; list.appendChild(e); }
      const firstRev = (j.revisions || []).find((x) => x.kind === "revision");
      rows.forEach((rv) => list.appendChild(this._historyRow(tg, j, rv, firstRev)));
      ov.appendChild(list);
      document.body.appendChild(ov);
      return { done: true, count: (j.revisions || []).length };
    },
    closeHistory() { if (this._hist && this._hist.ov && this._hist.ov.parentNode) this._hist.ov.parentNode.removeChild(this._hist.ov); this._hist = null; },

    _historyRow(tg, j, rv, firstRev) {
      const C = this.C, row = document.createElement("div");
      row.className = "rev-row"; if (rv.id) row.dataset.rev = rv.id;
      row.style.cssText = "background:" + C.panel + ";border-radius:10px;padding:8px 10px;display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;";
      const chip = (txt, bg) => { const c = document.createElement("span"); c.textContent = txt; c.style.cssText = "background:" + bg + ";color:#111827;border-radius:6px;padding:1px 6px;font-size:12px;font-weight:800;"; return c; };
      const title = document.createElement("strong"); title.style.cssText = "font-size:15px;color:" + C.text + ";";
      const meta = document.createElement("span"); meta.style.cssText = "flex:1 1 220px;color:" + C.sub + ";font-size:13px;";
      const day = (ms) => ms ? new Date(Number(ms)).toISOString().slice(0, 10) : "";
      if (rv.kind === "base") {
        title.textContent = rv.rev_label;
        row.append(title, chip("기준 개정", "#e5e7eb"));
        meta.textContent = "첫 개정 적용 전 도면(보관됨)";
        row.appendChild(meta);
        if (firstRev) row.appendChild(this._btn("이 개정 보기", "sec", () => this.openViewer(tg, firstRev.id, "prev")));
        return row;
      }
      if (rv.kind === "replaced") {
        title.textContent = "교체로 보관된 도면";
        row.append(title, chip("보관", "#e5e7eb"));
        meta.textContent = [day(rv.created_at), rv.author, "종전 [도면 교체] 저장 때 밀려난 도면"].filter(Boolean).join(" · ");
        row.appendChild(meta);
        row.appendChild(this._btn("보기", "sec", () => this.openViewer(tg, rv.id, "prev")));
        return row;
      }
      title.textContent = (rv.kind === "proposal" ? "제안 " : "") + (rv.rev_label || "");
      row.appendChild(title);
      const status = rv.kind === "proposal" ? (rv.status === "accepted" ? chip("적용됨", "#bbf7d0") : chip("제안", "#bfdbfe"))
        : rv.status === "reverted" ? chip("되돌림", "#e5e7eb") : rv.current ? chip("현행", "#fde68a") : chip("이전 개정", "#e5e7eb");
      row.appendChild(status);
      meta.textContent = [rv.rev_date || day(rv.created_at), rv.author, rv.memo].filter(Boolean).join(" · ") + (rv.prev_label ? " (이전: " + rv.prev_label + ")" : "");
      row.appendChild(meta);
      row.appendChild(this._btn(rv.kind === "proposal" ? "현재와 비교" : "이전 개정 보기", "sec", () => this.openViewer(tg, rv.id, rv.kind === "proposal" ? "compare" : "prev")));
      if (rv.kind !== "proposal") row.appendChild(this._btn("겹쳐 비교", "sec", () => this.openViewer(tg, rv.id, "compare")));
      if (rv.kind === "proposal" && rv.status === "proposed") {
        const ab = this._btn("적용", "pri", () => this.applyProposal(tg, rv.id));
        ab.dataset.kind = "pri";
        const w = !j.can_apply ? "소유자·관리자 전용" : (!this._online() ? "온라인에서만" : "");
        this._setDisabled(ab, !!w, w);
        row.appendChild(ab);
      }
      if (rv.current && rv.undo_until) {
        const ub = this._btn("되돌리기", "pri", () => this.undo(tg, rv.id));
        ub.dataset.kind = "pri"; ub.className = "rev-hist-undo";
        this._setDisabled(ub, !j.can_apply, j.can_apply ? "" : "소유자·관리자 전용");
        row.appendChild(ub);
      }
      return row;
    },

    _reviewList(tg) {
      const C = this.C, box = document.createElement("div");
      box.id = "rev-review-list";
      box.style.cssText = "background:" + C.panel + ";border-radius:10px;padding:8px 10px;margin-bottom:8px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;";
      const h = document.createElement("span"); h.textContent = "검토 필요 핀:"; h.style.cssText = "color:" + C.sub + ";font-size:13px;";
      box.appendChild(h);
      (State.pins || []).filter((p) => p && p.revReview && !p._deleted).slice(0, 60).forEach((p) => {
        const b = this._btn((p.label || p.id) + (p.revReview.out ? " (도면 밖)" : "") + " 확정", "sec", () => this.confirmReview(tg, [p.id]));
        b.className = "rev-review-one"; b.dataset.pin = String(p.id);
        b.style.padding = "4px 10px"; b.style.fontSize = "13px";
        box.appendChild(b);
      });
      return box;
    },

    /** ④ 검토 필요 배지 확정(지움) — 열려 있는 도면의 핀만(편집 경로 그대로: _markDirty → 저장). ids = null 이면 전부. */
    async confirmReview(tg, ids) {
      if (!this._isOpen(tg.depId)) { this._toast("이 도면을 연 뒤 확정하세요"); return 0; }
      const why = (typeof UI !== "undefined" && UI.permCheck) ? UI.permCheck("designer") : "";
      if (why || State.mode !== "designer") { this._toast("확정 — " + (why || "편집 화면에서 사용하세요")); return 0; }
      let n = 0;
      (State.pins || []).forEach((p) => {
        if (p && p.revReview && (!ids || ids.some((x) => String(x) === String(p.id)))) { p.revReview = null; n++; }
      });
      if (!n) return 0;
      try { UI.renderPinsOnMap(); UI.renderPinList(); } catch (e) {}
      App._markDirty();
      const ok = await App._saveNow({ silent: true });
      this._toast(ok ? "핀 " + n + "개 위치 확정 — 검토 필요 표시를 지웠습니다" : "확정은 했지만 저장하지 못했습니다 — [저장]을 눌러 주세요", 4200);
      if (this._hist && this._hist.tg.depId === tg.depId) this.openHistory(this._hist.t);
      return n;
    },

    async applyProposal(tg, rid) {
      if (!this._online()) { this._toast("오프라인 — 온라인에서만 적용합니다"); return { done: false }; }
      if (this._isOpen(tg.depId) && App._dirty) { this._toast("저장하지 않은 변경이 있습니다 — 먼저 [저장]하세요", 5200); return { done: false, stage: "dirty" }; }
      const info = await this._req("GET", this._url(tg.depId));
      const one = await this._req("GET", this._url(tg.depId, "/" + encodeURIComponent(rid)));
      if (info.status !== 200 || one.status !== 200) { this._toast("제안을 불러오지 못했습니다"); return { done: false }; }
      const rv = one.j.revision || {};
      const d = one.j.diff || {};
      if (!(await Prompt.confirm("제안 적용", (info.j.current_label || "현재") + " → " + rv.rev_label + " (제안: " + (rv.author || "") + ")\n"
        + (rv.memo ? "메모: " + rv.memo + "\n" : "") + "· 핀 좌표를 제안의 변환으로 이월(검토 필요 표시) · 이전 도면은 보관\n· 적용 후 10분 안에 되돌릴 수 있습니다\n계속할까요?"))) return { done: false, stage: "confirm" };
      const res = await this._req("POST", this._url(tg.depId), { from_proposal: rid, base_version: info.j.deployment.version });
      if (res.status !== 200) { this._toast("적용하지 않았습니다 — " + (res.j.error || res.status), 5200); return { done: false, status: res.status }; }
      this.closeHistory();
      await this._afterServerChange(tg);
      this._showBar(tg, res.j);
      return { done: true, id: res.j.id, moved: (d.moved || []).length };
    },

    /** 읽기 전용 보기. mode: "prev" = 그 개정 직전(이전) 도면 + 그때 핀 · "compare" = 새 도면 위에 이전 도면(변환) 겹침 + 투명도 + diff. */
    async openViewer(tg, rid, mode) {
      const r = await this._req("GET", this._url(tg.depId, "/" + encodeURIComponent(rid)));
      if (r.status !== 200) { this._toast("개정을 불러오지 못했습니다 — " + (r.j.error || r.status)); return { done: false }; }
      this.closeViewer();
      const C = this.C, j = r.j, rv = j.revision || {};
      const pagesOf = (side) => { try { const a = JSON.parse((side && side.pages_data) || "[]"); return Array.isArray(a) ? a : []; } catch (e) { return []; } };
      const prevPages = pagesOf(j.prev), nextPages = pagesOf(j.next);
      if (mode === "compare" && !nextPages.length) mode = "prev";
      const title = mode === "compare"
        ? "겹쳐 비교 — " + (j.prev.label || "현재") + " → " + (j.next && j.next.label || "") + " (읽기 전용)"
        : "이전 개정 보기 — " + (rv.kind === "replaced" ? "교체로 보관된 도면" : (j.prev.label || "")) + " (읽기 전용)";
      const ov = this._overlay("rev-viewer", title);
      ov.style.zIndex = "10045";
      ov._head.appendChild(this._btn("닫기", "sec", () => this.closeViewer()));
      const v = { ov, page: 1, opacity: 0.5 };
      this._viewer = v;
      const info = document.createElement("div");
      info.className = "rev-viewer-info"; info.setAttribute("aria-live", "polite");
      info.style.cssText = "background:" + C.panel + ";border-radius:10px;padding:8px 10px;margin-bottom:8px;white-space:pre-line;color:" + C.text + ";";
      const d = j.diff || { moved: [], added: [], removed: [], unchanged: 0 };
      const pins = (() => { try { return JSON.parse(j.prev.pins || "[]").filter((p) => p && !p._deleted && typeof p.x === "number"); } catch (e) { return []; } })();
      info.textContent = mode === "compare"
        ? "핀 변화(이전 개정 핀을 새 좌표로 옮긴 뒤 비교): 이동 " + d.moved.length + " · 추가 " + d.added.length + " · 삭제 " + d.removed.length + " · 그대로 " + d.unchanged
          + (d.moved.length ? "\n이동: " + d.moved.slice(0, 12).map((m) => (m.label || m.id) + " " + m.dist + "%").join(", ") : "")
        : "파일: " + (j.prev.file_name || "") + " · 그때 핀 " + pins.length + "개 · 이 화면은 읽기 전용입니다(지금 도면은 바뀌지 않음)";
      ov.appendChild(info);
      const tools = document.createElement("div");
      tools.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px;";
      const n = Math.max(1, mode === "compare" ? Math.min(prevPages.length || 1, nextPages.length || 1) : (prevPages.length || 1));
      const sel = document.createElement("select");
      sel.setAttribute("aria-label", "페이지");
      sel.style.cssText = "background:#ffffff;color:" + C.ink + ";border-radius:7px;min-height:36px;padding:4px 8px;font-size:14px;";
      for (let i = 1; i <= n; i++) { const o = document.createElement("option"); o.value = String(i); o.textContent = "페이지 " + i; sel.appendChild(o); }
      sel.disabled = n <= 1;
      if (n <= 1) { sel.style.background = "#cbd5e1"; sel.style.opacity = "1"; }
      tools.appendChild(sel);
      let sl = null;
      if (mode === "compare") {
        const sll = document.createElement("span"); sll.textContent = "이전 도면 투명도"; sll.style.color = C.sub;
        sl = document.createElement("input"); sl.type = "range"; sl.min = "0"; sl.max = "100"; sl.value = "50"; sl.id = "rev-viewer-opacity";
        sl.setAttribute("aria-label", "이전 도면 투명도"); sl.style.cssText = "min-height:32px;width:180px;";
        tools.append(sll, sl);
      }
      ov.appendChild(tools);
      const box = document.createElement("div");
      box.className = "rev-viewer-box";
      box.style.cssText = "position:relative;width:100%;max-width:1200px;margin:0 auto;background:#ffffff;overflow:hidden;";
      ov.appendChild(box);
      const draw = () => {
        box.innerHTML = "";
        const pg = v.page;
        const baseSrc = mode === "compare" ? (nextPages[pg - 1] || nextPages[0]) : (prevPages[pg - 1] || prevPages[0]);
        const base = document.createElement("img");
        base.alt = mode === "compare" ? "새 개정" : "이전 개정";
        base.src = /^data:/i.test(baseSrc || "") ? baseSrc : this._r2(baseSrc);
        base.style.cssText = "display:block;width:100%;height:auto;";
        box.appendChild(base);
        const place = () => {
          const W = box.clientWidth, H = base.clientHeight;
          if (mode === "compare") {
            const o = document.createElement("img");
            const os = prevPages[pg - 1] || prevPages[0];
            o.src = /^data:/i.test(os || "") ? os : this._r2(os); o.alt = "이전 개정(변환)"; o.className = "rev-viewer-old";
            o.style.cssText = "position:absolute;left:0;top:0;width:" + W + "px;height:" + H + "px;transform-origin:0 0;transform:" + this._cssMatrix(j.transform, W, H) + ";opacity:" + v.opacity + ";pointer-events:none;mix-blend-mode:multiply;";
            box.appendChild(o); v.old = o;
          } else {
            pins.filter((p) => (p.page || 1) === pg).forEach((p) => {
              const dd = document.createElement("div"); dd.className = "rev-viewer-pin";
              dd.textContent = p.label != null ? String(p.label) : "•";
              dd.style.cssText = "position:absolute;left:" + p.x + "%;top:" + p.y + "%;transform:translate(-50%,-50%);min-width:22px;height:22px;padding:0 3px;box-sizing:border-box;border-radius:11px;"
                + "background:#fde68a;color:#111827;border:2px solid #111827;font-size:11px;font-weight:800;line-height:18px;text-align:center;";
              box.appendChild(dd);
            });
          }
        };
        if (base.complete && base.naturalWidth) place(); else base.onload = place;
      };
      sel.addEventListener("change", () => { v.page = Number(sel.value) || 1; draw(); });
      if (sl) sl.addEventListener("input", () => { v.opacity = Number(sl.value) / 100; if (v.old) v.old.style.opacity = String(v.opacity); });
      v.onKey = (e) => { if (e.key === "Escape") this.closeViewer(); };
      document.addEventListener("keydown", v.onKey);
      v.onResize = draw;
      window.addEventListener("resize", draw);
      document.body.appendChild(ov);
      draw();
      return { done: true, mode, diff: d };
    },
    closeViewer() {
      const v = this._viewer; this._viewer = null;
      if (!v) return;
      if (v.onKey) document.removeEventListener("keydown", v.onKey);
      if (v.onResize) window.removeEventListener("resize", v.onResize);
      if (v.ov && v.ov.parentNode) v.ov.parentNode.removeChild(v.ov);
    }
  };
