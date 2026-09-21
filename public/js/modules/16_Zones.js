  const Zones = {
    _drag: null,        // {sx,sy} 시작 % 좌표 (rect/circle 드래그)
    _active: null,      // 현재 하이라이트된 zone id
    _shape: "rect",     // 현재 그리기 도형: rect | circle | poly
    _poly: null,        // 다각형 그리는 중 점 배열 [{x,y}...]

    _newId() { return "zone_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); },

    init() {
      const $ = (id) => document.getElementById(id);
      // 도형 도구 버튼 (사각형/원형/다각형)
      ["rect", "circle", "poly"].forEach(sh => {
        const b = $("btn-zone-" + sh);
        if (b) b.addEventListener("click", () => this.pickShape(sh));
      });
      // [WO 20260918-B] 🔴 도면 영역 추출 — 여러 뷰가 담긴 도면에서 드래그한 부분만 새 영역(구역)으로.
      //   그리기 도구와 같은 자리에서 관리한다(Projects._pickDeckCrop 이 이 모듈의 드래그를 그대로 재사용).
      $("btn-region-extract") && $("btn-region-extract").addEventListener("click", () => {
        if (typeof Projects === "undefined" || !Projects.extractRegionAsDeck) {
          Prompt && Prompt.toast && Prompt.toast("영역 추출을 사용할 수 없습니다");   // 조용한 실패 금지
          return;
        }
        Projects.extractRegionAsDeck();
      });
      // 레거시 단일 버튼 호환
      $("btn-zone") && $("btn-zone").addEventListener("click", () => this.toggleDraw());
      // 다각형: 더블클릭/Enter 로 완료
      const vp = $("map-viewport");
      if (vp) vp.addEventListener("dblclick", (e) => { if (State.drawingZone && this._shape === "poly" && this._poly && this._poly.length >= 3) { e.preventDefault(); this._finishPoly(); } });
      document.addEventListener("keydown", (e) => {
        if (!State.drawingZone) return;
        if (e.key === "Enter" && this._shape === "poly" && this._poly && this._poly.length >= 3) { e.preventDefault(); this._finishPoly(); }
        if (e.key === "Escape") { this._cancelDraw(); }
      });
      // [버그복원] 모바일 다각형 완료 — 더블클릭/Enter 가 없어 닫을 수 없던 문제 해결
      const pf = $("btn-poly-finish");
      if (pf) pf.addEventListener("click", () => { if (this._poly && this._poly.length >= 3) this._finishPoly(); });
    },

    isDesigner() { return !!(typeof Auth !== "undefined" && Auth.isDesigner); },

    /** 도형 선택 → 그리기 모드 토글 */
    pickShape(shape) {
      if (!this.isDesigner()) return;
      // [마스터 버그] ISO 3D 에서는 영역 그리기 좌표가 회전 때문에 왜곡(commit 실패/도형 깨짐) →
      //   영역 도구를 켤 때 평면으로 강제 전환. (핀 선택 자동 ISO 의 부작용 차단)
      if (State.isoView && typeof MapCtrl !== "undefined" && MapCtrl.exitIso) {
        MapCtrl.exitIso();
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("평면 뷰로 전환 — 영역을 그린 뒤 ISO 로 돌아가세요");
      }
      // 같은 도형 다시 누르면 끄기
      if (State.drawingZone && this._shape === shape) { this._cancelDraw(); return; }
      this._shape = shape;
      this._poly = null;
      if (!State.drawingZone) State.drawingZone = true;
      // 핀 배치 모드와 상호 배타
      if (State.placing) {
        State.placing = false;
        UI.$("btn-place") && UI.$("btn-place").classList.remove("active");
        UI.$("place-hint") && UI.$("place-hint").classList.add("hidden");
        UI.$("crosshair-overlay") && UI.$("crosshair-overlay").classList.add("hidden");
      }
      this._syncToolUi();
    },

    /** 레거시 toggle (뷰어 차단/기본 rect) */
    toggleDraw() {
      if (!this.isDesigner()) { State.drawingZone = false; return; }
      State.drawingZone = !State.drawingZone;
      this._poly = null;
      if (State.drawingZone && State.placing) {
        State.placing = false;
        UI.$("btn-place") && UI.$("btn-place").classList.remove("active");
        UI.$("place-hint") && UI.$("place-hint").classList.add("hidden");
        UI.$("crosshair-overlay") && UI.$("crosshair-overlay").classList.add("hidden");
      }
      this._syncToolUi();
    },

    _cancelDraw() {
      State.drawingZone = false;
      this._poly = null; this._drag = null;
      this._clearDraft();
      this._syncToolUi();
    },

    _syncToolUi() {
      // [WO 20260917 색음영] 영역 그리기 중엔 기존 영역들이 도면을 덮지 않도록 옅게 표시
      // (da479bf 의 body.deck-view-active 패턴 재사용). 완성 영역 기본 스타일(.zone-shape)은 불변.
      try { document.body.classList.toggle("zone-drawing-active", !!State.drawingZone); } catch (e) {}
      ["rect", "circle", "poly"].forEach(sh => {
        const b = UI.$("btn-zone-" + sh);
        if (b) b.classList.toggle("active", State.drawingZone && this._shape === sh);
      });
      const btn = UI.$("btn-zone");
      if (btn) btn.classList.toggle("active", State.drawingZone);
      const hint = UI.$("zone-hint");
      if (hint) hint.classList.toggle("hidden", !(State.drawingZone && this._shape !== "poly"));
      const ph = UI.$("zone-poly-hint");
      if (ph) ph.classList.toggle("hidden", !(State.drawingZone && this._shape === "poly"));
      const vp = UI.$("map-viewport");
      if (vp) vp.style.cursor = State.drawingZone ? "crosshair" : "grab";
      this._renderDraft();
    },

    /* ── 드래그 그리기 (rect/circle) ── */
    onDrawStart(clientX, clientY) {
      if (!State.drawingZone) return false;
      const pct = MapCtrl.viewportToPercent(clientX, clientY);
      if (!pct) return false;
      if (this._shape === "poly") {
        // 다각형: 클릭마다 점 추가 (시작점 근처 클릭 시 닫기)
        this._poly = this._poly || [];
        if (this._poly.length >= 3) {
          const s = this._poly[0];
          if (Math.hypot(pct.x - s.x, pct.y - s.y) < 4.5) { this._finishPoly(); return true; }
        }
        this._poly.push({ x: +pct.x.toFixed(3), y: +pct.y.toFixed(3) });
        this._renderDraft();
        return true;
      }
      this._drag = { sx: pct.x, sy: pct.y, cx: pct.x, cy: pct.y };
      this._renderDraft();
      return true;
    },
    onDrawMove(clientX, clientY) {
      const pct = MapCtrl.viewportToPercent(clientX, clientY);
      if (!pct) return;
      if (this._shape === "poly") { this._polyCursor = { x: pct.x, y: pct.y }; this._renderDraft(); return; }
      if (!this._drag) return;
      this._drag.cx = pct.x; this._drag.cy = pct.y;
      this._renderDraft();
    },
    async onDrawEnd(clientX, clientY) {
      if (this._shape === "poly") return; // 다각형은 클릭 누적 방식
      if (!this._drag) return;
      const pct = MapCtrl.viewportToPercent(clientX, clientY);
      const start = this._drag; this._drag = null;
      this._clearDraft();
      if (!pct) return;
      const x = Math.min(start.sx, pct.x), y = Math.min(start.sy, pct.y);
      const w = Math.abs(pct.x - start.sx), h = Math.abs(pct.y - start.sy);
      if (w < 0.8 || h < 0.8) { this._cancelDraw(); return; } // 너무 작은 영역만 무시(모바일 드래그 완화)
      let geom;
      if (this._shape === "circle") {
        const cx = (start.sx + pct.x) / 2, cy = (start.sy + pct.y) / 2;
        const r = Math.max(w, h) / 2;
        geom = { shape: "circle", cx: +cx.toFixed(3), cy: +cy.toFixed(3), r: +r.toFixed(3) };
      } else {
        geom = { shape: "rect", x: +x.toFixed(3), y: +y.toFixed(3), w: +w.toFixed(3), h: +h.toFixed(3) };
      }
      await this._commitZone(geom);
    },

    /** 다각형 완료 → 닫힌 구역으로 저장 */
    async _finishPoly() {
      const pts = (this._poly || []).map(p => ({ x: +p.x.toFixed(3), y: +p.y.toFixed(3) }));
      this._poly = null; this._polyCursor = null;
      this._clearDraft();
      if (pts.length < 3) { this._cancelDraw(); return; }
      await this._commitZone({ shape: "poly", points: pts });
    },

    /** 도형 → 라벨 입력 → zone 객체 생성/저장 (공통) */
    async _commitZone(geom) {
      let label = "";
      const defLabel = "구역 " + (State.zones.filter(z => (z.page||1)===(State.pdfPage||1)).length + 1);
      if (typeof Prompt !== "undefined" && Prompt.ask) {
        try { const r = await Prompt.ask({ title: "영역 이름", placeholder: "예: 1번 화물창 / 엔진룸 구역" }); if (r && r.value != null && r.value !== "") label = r.value; else if (r && r.value === "") label = defLabel; else { this._cancelDraw(); return; } }
        catch (e) { this._cancelDraw(); return; }
      } else {
        label = prompt("영역 이름", defLabel) || "";
        if (!label) { this._cancelDraw(); return; }
      }
      // [버그수정] 라벨은 현재 페이지 기준인데 색상이 전체 기준이라 페이지별 색이 불일치 → 페이지 기준으로 통일
      const _pgZones = State.zones.filter(z => (z.page||1)===(State.pdfPage||1)).length;
      const color = ZONE_COLORS[_pgZones % ZONE_COLORS.length];
      const bb = this._bbox(geom);
      const zone = Object.assign({
        id: this._newId(), page: State.pdfPage || 1,
        label: label || defLabel, color, pinIds: [], note: "",
        x: bb.x, y: bb.y, w: bb.w, h: bb.h, // 항상 바운딩 박스 보관(검색/플라이 호환)
      }, geom);
      zone.pinIds = (State.pins || []).filter(p => (p.page||1) === zone.page && this._contains(zone, p.x, p.y)).map(p => p.id);
      State.zones.push(zone);
      this._cancelDraw();
      this.render();
      this.renderList();
      // [오프라인 작업지시서 ] 오프라인이면 구역 upsert op 기록 + 로컬 스냅샷
      if (!navigator.onLine && typeof OpLog !== "undefined") {
        OpLog.recordCurrent("zone", "upsert", zone.id, zone).then(() => persistLocalDeployment()).catch(() => {});
      }
      if (typeof App !== "undefined" && App._autoSave) App._autoSave();
    },

    /** 도형의 바운딩 박스(%) 계산 */
    _bbox(g) {
      if (g.shape === "circle") return { x: +(g.cx - g.r).toFixed(3), y: +(g.cy - g.r).toFixed(3), w: +(g.r * 2).toFixed(3), h: +(g.r * 2).toFixed(3) };
      if (g.shape === "poly") {
        const xs = g.points.map(p => p.x), ys = g.points.map(p => p.y);
        const minX = Math.min(...xs), minY = Math.min(...ys);
        return { x: +minX.toFixed(3), y: +minY.toFixed(3), w: +(Math.max(...xs) - minX).toFixed(3), h: +(Math.max(...ys) - minY).toFixed(3) };
      }
      return { x: g.x, y: g.y, w: g.w, h: g.h };
    },

    /** 점(x,y%)이 영역(도형) 내부인지 — rect/circle/poly 각각 정확 판정 */
    _contains(z, x, y) {
      if (z.shape === "circle") return Math.hypot(x - z.cx, y - z.cy) <= z.r;
      if (z.shape === "poly" && Array.isArray(z.points)) {
        let inside = false; const pts = z.points;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
          if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-9) + xi)) inside = !inside;
        }
        return inside;
      }
      return x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h;
    },

    /* ── 그리기 미리보기(SVG draft) ── */
    _clearDraft() {
      this._polyCursor = null;
      const svg = document.getElementById("zones-svg");
      if (svg) { const d = svg.querySelector(".zone-draft-svg"); if (d) d.remove(); }
      const legacy = document.getElementById("zone-draft");
      if (legacy) { legacy.classList.add("hidden"); }
      const pf = document.getElementById("btn-poly-finish");
      if (pf) pf.classList.add("hidden");
    },
    _renderDraft() {
      const svg = document.getElementById("zones-svg");
      if (!svg) return;
      let d = svg.querySelector(".zone-draft-svg");
      if (d) d.remove();
      if (!State.drawingZone) return;
      d = document.createElementNS("http://www.w3.org/2000/svg", "g");
      d.setAttribute("class", "zone-draft-svg");
      let inner = "";
      if (this._shape === "rect" && this._drag) {
        const x = Math.min(this._drag.sx, this._drag.cx), y = Math.min(this._drag.sy, this._drag.cy);
        const w = Math.abs(this._drag.cx - this._drag.sx), h = Math.abs(this._drag.cy - this._drag.sy);
        inner = `<rect x="${x}" y="${y}" width="${w}" height="${h}" class="zd-shape"/>`;
      } else if (this._shape === "circle" && this._drag) {
        const cx = (this._drag.sx + this._drag.cx) / 2, cy = (this._drag.sy + this._drag.cy) / 2;
        const r = Math.max(Math.abs(this._drag.cx - this._drag.sx), Math.abs(this._drag.cy - this._drag.sy)) / 2;
        inner = `<ellipse cx="${cx}" cy="${cy}" rx="${r}" ry="${r}" class="zd-shape"/>`;
      } else if (this._shape === "poly" && this._poly && this._poly.length) {
        const live = this._polyCursor ? this._poly.concat([this._polyCursor]) : this._poly;
        const pts = live.map(p => `${p.x},${p.y}`).join(" ");
        inner = `<polyline points="${pts}" class="zd-line"/>` +
          this._poly.map((p, i) => `<circle cx="${p.x}" cy="${p.y}" r="${i === 0 ? 1.3 : 0.9}" class="zd-dot${i === 0 ? " first" : ""}"/>`).join("");
      }
      d.innerHTML = inner;
      svg.appendChild(d);
      // 다각형 완료 버튼: 점 3개 이상일 때만 노출
      const pf = document.getElementById("btn-poly-finish");
      if (pf) pf.classList.toggle("hidden", !(State.drawingZone && this._shape === "poly" && this._poly && this._poly.length >= 3));
    },

    _shapeLabel(z) { return z.shape === "circle" ? "원형" : z.shape === "poly" ? "다각형" : "사각형"; },
    _shapeIcon(z) {
      const c = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
      if (z.shape === "circle") return `<svg viewBox="0 0 24 24" ${c}><circle cx="12" cy="12" r="8.5"/></svg>`;
      if (z.shape === "poly") return `<svg viewBox="0 0 24 24" ${c}><polygon points="12,3 21,9 17.5,20 6.5,20 3,9"/></svg>`;
      return `<svg viewBox="0 0 24 24" ${c}><rect x="3.5" y="5.5" width="17" height="13" rx="1.5"/></svg>`;
    },

    /* ── 렌더: 도면 위 영역 (SVG 도형 + HTML 라벨/삭제) ── */
    render() {
      const page = State.pdfPage || 1;
      const zones = (State.zones || []).filter(z => (z.page || 1) === page);
      const svg = document.getElementById("zones-svg");
      const layer = document.getElementById("zones-layer");
      if (!svg || !layer) return;

      // 1) SVG 도형(채움+테두리). 구역뷰 진입 중이면 현재 구역 외 도형 dim
      const draft = svg.querySelector(".zone-draft-svg");
      const zv = State.zoneView;
      svg.innerHTML = zones.map(z => {
        const a = z.id === this._active ? " active" : "";
        const d = (zv && z.id !== zv) ? " zone-dim" : "";
        if (z.shape === "circle") return `<ellipse data-zone="${z.id}" class="zone-shape${a}${d}" cx="${z.cx}" cy="${z.cy}" rx="${z.r}" ry="${z.r}" style="--zc:${z.color}"/>`;
        if (z.shape === "poly") return `<polygon data-zone="${z.id}" class="zone-shape${a}${d}" points="${(z.points||[]).map(p=>p.x+","+p.y).join(" ")}" style="--zc:${z.color}"/>`;
        return `<rect data-zone="${z.id}" class="zone-shape${a}${d}" x="${z.x}" y="${z.y}" width="${z.w}" height="${z.h}" rx="0.6" style="--zc:${z.color}"/>`;
      }).join("");
      if (draft) svg.appendChild(draft);

      // 2) HTML 라벨/삭제 버튼 (바운딩 박스 좌상단)
      layer.innerHTML = zones.map(z => {
        const isActive = z.id === this._active;
        const cnt = (z.pinIds || []).length;
        return `<div class="zone-box${isActive ? " active" : ""}" data-zone="${z.id}"
            style="left:${z.x}%;top:${z.y}%;width:${z.w}%;height:${z.h}%;--zc:${z.color}">
            <div class="zone-box-label">${UI.escapeHtml(z.label)}${cnt ? ` <span class="zone-box-cnt">${cnt}</span>` : ""}</div>
            ${this.isDesigner() ? `<button class="zone-box-del" data-zdel="${z.id}" title="영역 삭제" aria-label="영역 삭제"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></button>` : ""}
          </div>`;
      }).join("");

      // 이벤트 — SVG 도형 + HTML 박스
      svg.querySelectorAll(".zone-shape").forEach(el => {
        const id = el.getAttribute("data-zone");
        el.addEventListener("mouseenter", () => this.highlight(id));
        el.addEventListener("mouseleave", () => this.highlight(null));
        el.addEventListener("click", () => this.focus(id));
      });
      layer.querySelectorAll(".zone-box").forEach(el => {
        const id = el.dataset.zone;
        el.addEventListener("mouseenter", () => this.highlight(id));
        el.addEventListener("mouseleave", () => this.highlight(null));
        el.addEventListener("click", (e) => { if (e.target.closest("[data-zdel]")) return; this.inspect(id); });
      });
      layer.querySelectorAll("[data-zdel]").forEach(b => {
        b.addEventListener("click", (e) => { e.stopPropagation(); this.remove(b.dataset.zdel); });
      });
      // 구역 페이저(전체+구역 탭) 갱신
      try { if (typeof App !== "undefined" && App._renderZonePager) App._renderZonePager(); } catch (e) {}
      if (typeof UI !== "undefined" && UI.renderTree) UI.renderTree();
      this.updateLabelScale();
    },

    /** [마스터] 확대해도 흐려지지 않게: 부모 #map-transform 의 scale(zoom) 을
     *  라벨마다 역스케일(1/zoom) 로 상쇄 → 라벨은 항상 "화면상 일정 크기"로
     *  자연 해상도 렌더(업스케일 없음 → 크리스프). 핀 마커의 pinScreenScale()과 동일 원리. */
    updateLabelScale() {
      const layer = document.getElementById("zones-layer");
      if (!layer) return;
      const zoom = (typeof State !== "undefined" && State.zoom) || 1;
      const inv = (1 / zoom).toFixed(3);
      layer.querySelectorAll(".zone-box-label").forEach(el => {
        el.style.transform = `scale(${inv})`;
      });
    },

    /* ── 사이드바 목록 ── */
    renderList() {
      const sec = document.getElementById("section-zones");
      const list = document.getElementById("zone-list");
      const cntEl = document.getElementById("zone-count");
      if (!list) return;
      const zones = State.zones || [];
      if (cntEl) cntEl.textContent = zones.length;
      if (sec) sec.classList.toggle("hidden", zones.length === 0 && !this.isDesigner());
      if (zones.length === 0) {
        list.innerHTML = `<p class="zone-empty">${this.isDesigner() ? "위 ‘영역 지정 도구’(사각형·원형·선)로 구역을 그려보세요." : "지정된 영역이 없습니다."}</p>`;
        return;
      }
      list.innerHTML = zones.map(z => {
        const cnt = (z.pinIds || []).length;
        return `<div class="zone-item" data-zone="${z.id}">
            <span class="zone-item-color" style="background:${z.color}"></span>
            <span class="zone-item-shape" title="${this._shapeLabel(z)}">${this._shapeIcon(z)}</span>
            <span class="zone-item-label">${UI.escapeHtml(z.label)}</span>
            <span class="zone-item-page">p.${z.page || 1}</span>
            <span class="zone-item-cnt" title="연결된 핀"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>${cnt}</span>
            <span class="zone-item-arrow" title="상세 정보"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg></span>
          </div>`;
      }).join("");
      list.querySelectorAll(".zone-item").forEach(el => {
        const id = el.dataset.zone;
        el.addEventListener("mouseenter", () => this.highlight(id));
        el.addEventListener("mouseleave", () => this.highlight(null));
        el.addEventListener("click", () => this.inspect(id));
      });
    },

    /** 영역 + 내부 핀 하이라이트 */
    highlight(id) {
      this._active = id;
      // SVG 도형
      document.querySelectorAll("#zones-svg .zone-shape").forEach(el => {
        el.classList.toggle("active", el.getAttribute("data-zone") === id);
      });
      // 영역 박스(라벨)
      document.querySelectorAll("#zones-layer .zone-box").forEach(el => {
        el.classList.toggle("active", el.dataset.zone === id);
      });
      // 사이드바 항목
      document.querySelectorAll("#zone-list .zone-item").forEach(el => {
        el.classList.toggle("active", el.dataset.zone === id);
      });
      // 내부 핀 강조
      const zone = id ? (State.zones || []).find(z => z.id === id) : null;
      const ids = zone ? new Set(zone.pinIds || []) : new Set();
      document.querySelectorAll("#pins-layer .pin-marker").forEach(el => {
        const pid = el.dataset.pinId || el.dataset.id;
        el.classList.toggle("zone-dim", !!id && !ids.has(pid));
        el.classList.toggle("zone-hot", !!id && ids.has(pid));
      });
    },

    /** 영역으로 화면 이동(플라이) + 일시 하이라이트 */
    focus(id) {
      const zone = (State.zones || []).find(z => z.id === id);
      if (!zone) return;
      // 다른 페이지면 페이지 전환 후 이동
      if ((zone.page || 1) !== (State.pdfPage || 1) && typeof App !== "undefined" && App._gotoPage) {
        Promise.resolve(App._gotoPage(zone.page)).then(() => {
          this.render();
          setTimeout(() => { this._flyToZone(zone); this.highlight(id); }, 60);
        });
        return;
      }
      this._flyToZone(zone);
      this.highlight(id);
    },
    _flyToZone(zone) {
      const bb = this._bbox(zone);   // rect/circle/poly 모두 {x,y,w,h}
      // [WO 20260917 ISO 제거] 영역 클릭은 항상 평면으로 확대한다(강제 ISO 전환 금지 — 마스터 지시).
      //   되돌리려면 아래 주석 해제:
      //   if (State.isoView && MapCtrl.focusZoneIso) { MapCtrl.focusZoneIso(bb); return; }
      const cx = bb.x + bb.w / 2, cy = bb.y + bb.h / 2;
      // 영역 크기에 맞춰 줌 (작은 영역일수록 더 확대)
      const span = Math.max(bb.w, bb.h);
      const z = Math.max(1, Math.min(4.5, 60 / Math.max(span, 8)));
      if (MapCtrl.flyTo) MapCtrl.flyTo(cx, cy, z, 650);
    },

    remove(id) {
      if (!this.isDesigner()) return;
      const z = (State.zones || []).find(x => x.id === id);
      if (!z) return;
      if (!confirm(`영역 “${z.label}”을(를) 삭제할까요?`)) return;
      State.zones = (State.zones || []).filter(x => x.id !== id);
      if (this._active === id) this._active = null;
      this.render();
      this.renderList();
      // [오프라인 작업지시서 ] 오프라인이면 구역 삭제 op 기록 + 로컬 스냅샷
      if (!navigator.onLine && typeof OpLog !== "undefined") {
        OpLog.recordCurrent("zone", "delete", id).then(() => persistLocalDeployment()).catch(() => {});
      }
      if (typeof App !== "undefined" && App._autoSave) App._autoSave();
    },

    /** 핀 추가/이동 후 영역-핀 연결 갱신 */
    refreshPinLinks() {
      (State.zones || []).forEach(z => {
        z.pinIds = (State.pins || []).filter(p => (p.page||1) === (z.page||1) && this._contains(z, p.x, p.y)).map(p => p.id);
      });
    },

    /* ── CAD 인스펙터: 구역 상세 ── */
    inspect(id) {
      const z = (State.zones || []).find(x => x.id === id);
      if (!z) return;
      this.focus(id);
      Inspector.showZone(z);
    },

    serialize() { return JSON.stringify(State.zones || []); },
    load(arr) {
      State.zones = Array.isArray(arr) ? arr : [];
      this.render();
      this.renderList();
    },
  };

  /* ══════════════════════════════════════════
     INSPECTOR — CAD/3D 스타일 우측 상세 패널(구역/포인트)
  ══════════════════════════════════════════ */