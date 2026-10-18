  /* ══════════════════════════════════════════
     SCALE — 도면 축척 측정 (WO 20261019-gap1, 지휘자 발주 "SIGNAX 등 경쟁 제품 기능 격차 R2")
     [재현] R2: grep -E "setScale|scaleRef.*mm|실거리|축척 설정" public/js/modules/*.js → 0건
            (09_FLS:790 의 measure 는 E57 포인트클라우드 전용 — 이 도면 축척 측정과 다른 기능).

     설계:
     · 저장 = 기존 State.annotations 배열(26_PdfAnno.js SoT) 안에 type:"scale"/"measure" 항목을
       추가하는 것뿐 — 서버 스키마 변경 0(원격 마이그레이션 금지 준수). 좌표계도 PdfAnno._pt()와
       동일한 0~1000(viewBox) 정규화를 그대로 재사용(새 수식 0 — §G-2-5).
     · 좌표 캡처 = #anno-svg 위에 "전용 캡처 오버레이"(이 모듈이 만드는 투명 div)를 덮어 클릭을
       가로챈다 — PdfAnno 의 기존 pointerdown 리스너(_onDown, 사각형/펜/하이라이트 도구)와
       같은 엘리먼트에 리스너를 추가로 걸면 등록 순서에 따라 의도치 않은 도형이 먼저 그려질
       위험이 있어(26_PdfAnno.js 비수정 원칙), 완전히 분리된 오버레이로 피한다.
     · 렌더 = PdfAnno._render 를 1회 감싸(monkey-patch) 매 렌더 후 Scale.renderOverlay() 를
       호출 — 26_PdfAnno.js 파일 자체는 건드리지 않고(동시 팀 비점유 지점 보존) 페이지 전환·undo·
       zoom reflow 때마다 축척선/측정선이 다시 그려지게 한다.
     · 벡터 복사 구역(src_crop) 축척 파생 = 원본 배포본의 scale 주석을 1회 네트워크로 가져와
       deriveForCrop(base, scaleRef) 로 곱셈 파생(31_Projects.js:1107 과 동일한 scaleRef 정의 재사용).
     · 진입 버튼 = 하단 플로팅바 금지(p86 실측 — 모바일 하단 도크 .mdock-tool 영역과 겹침) 대신
       47_Report.js 가 이미 쓰는 자리(#pin-grid-csv 옆 줄)에 인라인으로 붙인다(같은 안전 지점 재사용).
  ══════════════════════════════════════════ */
  const Scale = {
    _mode: null,      // null | "calibrate" | "distance" | "area"
    _pts: [],
    _marks: [],
    _patched: false,

    /* ══ 순수 함수(테스트 대상 — DOM 무의존) ══════════════════════════════════════ */

    /** 0~1000 정규화 좌표 → 도면의 "논리(CSS) 픽셀" 좌표. content = {w,h}(MapCtrl._contentSize()). */
    _px(pt, content) { return { x: (pt.x / 1000) * content.w, y: (pt.y / 1000) * content.h }; },
    _dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); },

    /** 두 점 + 실제 길이(mm) → mm/px 배율. 두 점이 겹치거나 길이가 0/음수면 null(조용한 실패 금지 — 호출측이 이유를 표시). */
    mmPerPxFromTwoPoints(content, p1, p2, realMM) {
      if (!content || !(content.w > 0) || !(content.h > 0)) return null;
      const d = this._dist(this._px(p1, content), this._px(p2, content));
      if (!(d > 0) || !Number.isFinite(realMM) || !(realMM > 0)) return null;
      return realMM / d;
    },

    distanceMM(content, p1, p2, mmPerPx) {
      if (!content || !(mmPerPx > 0)) return null;
      return this._dist(this._px(p1, content), this._px(p2, content)) * mmPerPx;
    },

    /** 폴리곤(3점 이상, 0~1000 좌표) 실면적(mm²) — 신발끈 공식(shoelace). */
    areaMM2(content, pts, mmPerPx) {
      if (!content || !(mmPerPx > 0) || !Array.isArray(pts) || pts.length < 3) return null;
      const px = pts.map((p) => this._px(p, content));
      let a = 0;
      for (let i = 0; i < px.length; i++) {
        const j = (i + 1) % px.length;
        a += px[i].x * px[j].y - px[j].x * px[i].y;
      }
      const pxArea = Math.abs(a) / 2;
      return pxArea * mmPerPx * mmPerPx;
    },

    /** [WO 20261016-pinscale] 31_Projects.js:1107 scaleRef = src_crop.w/100 과 같은 정의 — 원본 mm/px 에
     *  이 비율을 곱해 "확대해 그린" 복사본의 mm/px 를 파생한다(실측 재보정 없이도 바로 쓸 수 있는 근사치). */
    deriveForCrop(baseMmPerPx, scaleRef) {
      if (!(baseMmPerPx > 0) || !(scaleRef > 0)) return null;
      return baseMmPerPx * scaleRef;
    },

    /** annotations 배열에서 이 페이지의 축척 주석(가장 최근 것, 1건/페이지 정책) */
    findScaleAnno(annotations, page) {
      const list = (annotations || []).filter((a) => a && a.type === "scale" && (a.page || 1) === (page || 1));
      return list.length ? list[list.length - 1] : null;
    },

    fmtMM(mm) {
      if (!Number.isFinite(mm)) return "";
      return mm >= 1000 ? (mm / 1000).toFixed(3) + " m" : mm.toFixed(1) + " mm";
    },
    fmtArea(mm2) {
      if (!Number.isFinite(mm2)) return "";
      return mm2 >= 1e6 ? (mm2 / 1e6).toFixed(3) + " m2" : mm2.toFixed(0) + " mm2";
    },

    /* ══ DOM 글루 ══════════════════════════════════════════════════════════════ */

    init() {
      this._injectToolbar();
      this._patchRender();
    },

    _canEdit() { return !(typeof Auth !== "undefined" && (Auth.role === "viewer" || Auth.readonly)); },

    /** PdfAnno._render 를 1회만 감싸 렌더 후 내 오버레이도 그린다(파일 비수정 — 헤더 주석 참조). */
    _patchRender() {
      if (this._patched) return;
      if (typeof PdfAnno === "undefined" || !PdfAnno._render) return;
      this._patched = true;
      const orig = PdfAnno._render.bind(PdfAnno);
      PdfAnno._render = () => { orig(); try { this.renderOverlay(); } catch (e) {} };
    },

    /** [p86 수정] 하단 플로팅바는 모바일 하단 도크(.mdock-tool, 탭 시 트레이 72px 확장)와 겹친다 —
     *  47_Report.js 가 이미 쓰는 안전한 자리(#pin-grid-csv 줄, 인라인)에 이어 붙인다. */
    _injectToolbar() {
      if (document.getElementById("scale-cal-btn")) return;
      const host = document.getElementById("rpt-xlsx-btn") || document.getElementById("pin-grid-csv");
      if (!host) return;
      const mk = (id, text, title) => {
        const b = document.createElement("button"); b.type = "button"; b.id = id; b.textContent = text; b.title = title || "";
        b.className = (document.getElementById("pin-grid-csv") || {}).className || "";
        b.setAttribute("style", "margin-left:2px;padding:4px 6px;border-radius:6px;border:1px solid #1d4f88;background:#2f6db5;color:#fff;cursor:pointer;font-size:11px;");
        return b;
      };
      const calBtn = mk("scale-cal-btn", "축척", "축척 설정 — 실제 길이를 아는 두 점을 클릭");
      const distBtn = mk("scale-dist-btn", "거리", "거리 측정");
      const areaBtn = mk("scale-area-btn", "면적", "면적 측정(폴리곤)");
      const cancelBtn = mk("scale-cancel-btn", "✕", "측정 취소");
      cancelBtn.setAttribute("style", "margin-left:2px;padding:4px 6px;border-radius:6px;border:1px solid #666;background:#555;color:#fff;cursor:pointer;font-size:11px;display:none;");
      const status = document.createElement("span"); status.id = "scale-status-text";
      status.setAttribute("style", "display:block;width:100%;font-size:11px;color:#334155;margin-top:4px;");
      host.insertAdjacentElement("afterend", calBtn);
      calBtn.insertAdjacentElement("afterend", distBtn);
      distBtn.insertAdjacentElement("afterend", areaBtn);
      areaBtn.insertAdjacentElement("afterend", cancelBtn);
      cancelBtn.insertAdjacentElement("afterend", status);
      calBtn.addEventListener("click", () => this.startCalibrate());
      distBtn.addEventListener("click", () => this.startMeasure("distance"));
      areaBtn.addEventListener("click", () => this.startMeasure("area"));
      cancelBtn.addEventListener("click", () => this._cancel());
    },

    _setStatus(t) { const el = document.getElementById("scale-status-text"); if (el) el.textContent = t || ""; const cb = document.getElementById("scale-cancel-btn"); if (cb) cb.style.display = t ? "" : "none"; },

    startCalibrate() {
      if (!this._canEdit()) { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("보기 권한으로는 축척을 설정할 수 없습니다."); return; }
      this._start("calibrate");
    },
    startMeasure(kind) { this._start(kind === "area" ? "area" : "distance"); },

    _start(mode) {
      this._cancel();
      if (!document.getElementById("anno-svg")) { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("도면이 펼쳐져 있을 때만 사용할 수 있습니다."); return; }
      this._mode = mode; this._pts = [];
      this._showOverlay();
      this._setStatus(mode === "calibrate" ? "기준선의 두 점을 클릭하세요 (1/2)"
        : mode === "distance" ? "거리를 측정할 두 점을 클릭하세요 (1/2)"
        : "폴리곤 점을 순서대로 클릭하고 더블클릭으로 완료하세요(최소 3점)");
    },

    _showOverlay() {
      const svg = document.getElementById("anno-svg");
      if (!svg) return;
      let ov = document.getElementById("scale-capture-layer");
      if (!ov) {
        ov = document.createElement("div");
        ov.id = "scale-capture-layer";
        document.body.appendChild(ov);
        ov.addEventListener("click", (e) => this._onClick(e));
        ov.addEventListener("dblclick", (e) => { e.preventDefault(); this._finishArea(); });
        window.addEventListener("resize", () => { if (this._mode) this._syncOverlayRect(); });
      }
      this._syncOverlayRect();
      ov.style.display = "block";
    },
    _syncOverlayRect() {
      const svg = document.getElementById("anno-svg"), ov = document.getElementById("scale-capture-layer");
      if (!svg || !ov) return;
      const r = svg.getBoundingClientRect();
      ov.setAttribute("style", "position:fixed;left:" + r.left + "px;top:" + r.top + "px;width:" + r.width + "px;height:" + r.height + "px;z-index:950;cursor:crosshair;background:transparent;display:block;");
    },
    _hideOverlay() { const ov = document.getElementById("scale-capture-layer"); if (ov) ov.style.display = "none"; },
    _cancel() {
      this._mode = null; this._pts = [];
      this._hideOverlay();
      this._setStatus("");
    },

    _onClick(e) {
      if (!this._mode) return;
      const p = (typeof PdfAnno !== "undefined" && PdfAnno._pt) ? PdfAnno._pt(e) : null;
      if (!p) return;
      this._pts.push(p);
      if (this._mode === "area") {
        this._setStatus("폴리곤 점 " + this._pts.length + "개 (더블클릭으로 완료, 최소 3점)");
        return;
      }
      if (this._pts.length === 1) {
        this._setStatus(this._mode === "calibrate" ? "기준선의 두 점을 클릭하세요 (2/2)" : "거리를 측정할 두 점을 클릭하세요 (2/2)");
        return;
      }
      this._complete2Point();
    },

    _finishArea() {
      if (this._mode !== "area" || this._pts.length < 3) { this._cancel(); return; }
      const pts = this._pts.slice();
      this._cancel();
      this._completeArea(pts);
    },

    async _complete2Point() {
      const [p1, p2] = this._pts;
      const mode = this._mode;
      this._cancel();
      const content = (typeof MapCtrl !== "undefined" && MapCtrl._contentSize) ? MapCtrl._contentSize() : null;
      if (!content) { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("도면 크기를 확인할 수 없습니다."); return; }
      if (mode === "calibrate") {
        const raw = (typeof prompt === "function") ? prompt("이 두 점 사이의 실제 길이(mm)를 입력하세요") : null;
        const realMM = parseFloat(raw);
        if (!Number.isFinite(realMM) || realMM <= 0) { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("축척 설정 취소 — 유효한 길이가 아닙니다."); return; }
        const mmPerPx = this.mmPerPxFromTwoPoints(content, p1, p2, realMM);
        if (!mmPerPx) { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("축척 설정 실패 — 두 점이 너무 가깝습니다."); return; }
        this._saveScaleAnno(p1, p2, realMM, mmPerPx);
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("축척 설정 완료 (" + mmPerPx.toFixed(4) + " mm/px)");
        return;
      }
      const mmPerPx = await this.resolveMmPerPxAsync();
      if (mmPerPx == null) { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("이 페이지에 설정된 축척이 없습니다 — 먼저 [축척]을 설정하세요.", 4000); return; }
      const mm = this.distanceMM(content, p1, p2, mmPerPx);
      if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("거리: " + this.fmtMM(mm), 4000);
      this._offerSaveMeasure("line", [p1, p2], this.fmtMM(mm));
    },

    async _completeArea(pts) {
      const content = (typeof MapCtrl !== "undefined" && MapCtrl._contentSize) ? MapCtrl._contentSize() : null;
      if (!content) { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("도면 크기를 확인할 수 없습니다."); return; }
      const mmPerPx = await this.resolveMmPerPxAsync();
      if (mmPerPx == null) { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("이 페이지에 설정된 축척이 없습니다 — 먼저 [축척]을 설정하세요.", 4000); return; }
      const mm2 = this.areaMM2(content, pts, mmPerPx);
      if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("면적: " + this.fmtArea(mm2), 4000);
      this._offerSaveMeasure("polygon", pts, this.fmtArea(mm2));
    },

    /** 이 페이지 자체 축척 → 없으면(벡터 복사 구역) 원본 배포본의 축척 x scaleRef 로 1회 네트워크 파생. */
    async resolveMmPerPxAsync() {
      const own = this.findScaleAnno(State.annotations, State.pdfPage);
      if (own) return own.mmPerPx;
      const deck = (typeof Projects !== "undefined") ? Projects.currentDeck : null;
      if (!deck || !deck.src_dep_id || !deck.src_crop || !(deck.src_crop.w > 0)) return null;
      try {
        const r = await fetch("/tables/deployments/" + encodeURIComponent(deck.src_dep_id), { headers: (typeof Auth !== "undefined" ? Auth.headers() : {}) });
        if (!r.ok) return null;
        const dep = await r.json();
        const annos = JSON.parse(dep.annotations || "[]");
        const base = this.findScaleAnno(annos, deck.src_page || 1);
        if (!base) return null;
        return this.deriveForCrop(base.mmPerPx, deck.src_crop.w / 100);
      } catch (e) { return null; }
    },

    _saveScaleAnno(p1, p2, realMM, mmPerPx) {
      // 페이지당 1건 정책 — 기존 축척 주석은 교체(중복 누적 방지, SoT 1개).
      State.annotations = (State.annotations || []).filter((a) => !(a && a.type === "scale" && (a.page || 1) === State.pdfPage));
      const id = "sc-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      State.annotations.push({ id, page: State.pdfPage, type: "scale", color: "#ff7a00", p1, p2, realMM, mmPerPx });
      this._afterChange();
    },

    /** 측정 결과를 주석으로 남길지 묻는다(26_PdfAnno 저장경로 재사용) — 보기 권한이면 묻지 않고 넘김(저장 불가). */
    async _offerSaveMeasure(shape, pts, label) {
      if (!this._canEdit()) return;
      let keep = true;
      if (typeof Prompt !== "undefined" && Prompt.confirm) {
        keep = await Prompt.confirm("주석으로 남기기", "이 측정 결과(" + label + ")를 도면 주석으로 남겨둘까요?");
      }
      if (!keep) return;
      const id = "ms-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      State.annotations.push({ id, page: State.pdfPage, type: "measure", color: "#ff2fb0", shape, pts, label });
      this._afterChange();
    },

    _afterChange() {
      if (typeof PdfAnno !== "undefined" && PdfAnno._render) PdfAnno._render();
      else this.renderOverlay();
      if (typeof PdfAnno !== "undefined" && PdfAnno._persist) PdfAnno._persist();
    },

    /** scale/measure 주석을 #anno-svg 에 추가로 그린다 — PdfAnno._render 가 매번 innerHTML 을 비우므로
     *  (patchRender 로) 그 직후 호출되어야 한다. 0~1000 좌표(viewBox 동일, §헤더 주석). */
    renderOverlay() {
      const svg = document.getElementById("anno-svg");
      if (!svg) return;
      const page = (typeof State !== "undefined") ? State.pdfPage : 1;
      const NS = "http://www.w3.org/2000/svg";
      (State.annotations || []).forEach((a) => {
        if (!a || (a.page || 1) !== page) return;
        if (a.type === "scale" && a.p1 && a.p2) {
          const l = document.createElementNS(NS, "line");
          l.setAttribute("x1", a.p1.x); l.setAttribute("y1", a.p1.y); l.setAttribute("x2", a.p2.x); l.setAttribute("y2", a.p2.y);
          l.setAttribute("stroke", a.color || "#ff7a00"); l.setAttribute("stroke-width", "3"); l.setAttribute("stroke-dasharray", "10,6");
          l.dataset.scaleMark = "1";
          svg.appendChild(l);
        } else if (a.type === "measure" && Array.isArray(a.pts) && a.pts.length >= 2) {
          const el = document.createElementNS(NS, a.shape === "polygon" ? "polygon" : "polyline");
          el.setAttribute("points", a.pts.map((p) => p.x + "," + p.y).join(" "));
          el.setAttribute("fill", a.shape === "polygon" ? (a.color || "#ff2fb0") + "33" : "none");
          el.setAttribute("stroke", a.color || "#ff2fb0"); el.setAttribute("stroke-width", "3");
          el.dataset.scaleMark = "1";
          svg.appendChild(el);
        }
      });
    }
  };
