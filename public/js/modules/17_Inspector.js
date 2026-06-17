  const Inspector = {
    _kind: null, _id: null,

    _open() {
      const el = document.getElementById("inspector");
      if (!el) return;
      el.classList.remove("hidden");
      requestAnimationFrame(() => el.classList.add("on"));
    },
    close() {
      const el = document.getElementById("inspector");
      if (!el) return;
      el.classList.remove("on");
      setTimeout(() => el.classList.add("hidden"), 220);
      this._kind = null; this._id = null;
      if (typeof Zones !== "undefined") Zones.highlight(null);
    },
    init() {
      const c = document.getElementById("inspector-close");
      if (c) c.addEventListener("click", () => this.close());
    },

    _fmt(n) { return (Math.round((n || 0) * 10) / 10).toFixed(1); },
    _shapeName(z) {
      if (z.shape === "circle") return "원형 (CIRCLE)";
      if (z.shape === "poly") return "다각형 (POLYGON)";
      return "사각형 (RECT)";
    },
    _area(z) {
      // % 기준 근사 면적
      if (z.shape === "circle") {
        const r = Math.max(z.w, z.h) / 2;
        return Math.PI * r * r;
      }
      if (z.shape === "poly" && Array.isArray(z.points) && z.points.length > 2) {
        let a = 0; const p = z.points;
        for (let i = 0, n = p.length; i < n; i++) {
          const j = (i + 1) % n;
          a += p[i].x * p[j].y - p[j].x * p[i].y;
        }
        return Math.abs(a) / 2;
      }
      return (z.w || 0) * (z.h || 0);
    },

    showZone(z) {
      this._kind = "zone"; this._id = z.id;
      const kindEl = document.getElementById("inspector-kind");
      const titleEl = document.getElementById("inspector-title");
      const body = document.getElementById("inspector-body");
      if (kindEl) { kindEl.textContent = "ZONE"; kindEl.className = "inspector-kind kind-zone"; }
      if (titleEl) titleEl.textContent = z.label || "(이름 없음)";

      const pins = (State.pins || []).filter(p => (z.pinIds || []).includes(p.id));
      const cx = z.x + (z.w || 0) / 2, cy = z.y + (z.h || 0) / 2;
      const designer = (typeof Auth !== "undefined" && Auth.isDesigner);

      const pinRows = pins.length
        ? pins.map((p, i) => `<button class="insp-pinrow" data-pin="${p.id}">
              <span class="insp-pinrow-no">${i + 1}</span>
              <span class="insp-pinrow-label">${UI.escapeHtml(p.label || "포인트")}</span>
              ${p.imageId || p.url || (p.attachments && p.attachments.length) ? '<span class="insp-pinrow-tag">360°</span>' : ''}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 18l6-6-6-6"/></svg>
           </button>`).join("")
        : `<div class="insp-empty">이 구역에 연결된 포인트가 없습니다.</div>`;

      body.innerHTML = `
        <div class="insp-swatch-row">
          <span class="insp-swatch" style="background:${z.color}"></span>
          <span class="insp-shape-name">${this._shapeName(z)}</span>
          <span class="insp-page-badge">PAGE ${z.page || 1}</span>
        </div>

        <div class="insp-section">
          <div class="insp-section-h">좌표 · 치수 <span class="insp-unit">(도면 % 기준)</span></div>
          <div class="insp-metrics">
            <div class="insp-metric"><span class="m-k">X</span><span class="m-v">${this._fmt(z.x)}%</span></div>
            <div class="insp-metric"><span class="m-k">Y</span><span class="m-v">${this._fmt(z.y)}%</span></div>
            <div class="insp-metric"><span class="m-k">W</span><span class="m-v">${this._fmt(z.w)}%</span></div>
            <div class="insp-metric"><span class="m-k">H</span><span class="m-v">${this._fmt(z.h)}%</span></div>
            <div class="insp-metric"><span class="m-k">중심</span><span class="m-v">${this._fmt(cx)} , ${this._fmt(cy)}</span></div>
            <div class="insp-metric"><span class="m-k">면적</span><span class="m-v">${this._fmt(this._area(z))}%²</span></div>
          </div>
        </div>

        <div class="insp-section">
          <div class="insp-section-h">연결 포인트 <span class="insp-count">${pins.length}</span></div>
          <div class="insp-pinlist">${pinRows}</div>
        </div>

        ${z.note ? `<div class="insp-section"><div class="insp-section-h">메모</div><div class="insp-note">${UI.escapeHtml(z.note)}</div></div>` : ""}

        <div class="insp-actions">
          <button class="insp-btn primary" data-act="zoom">📄 구역 페이지 열기</button>
          <button class="insp-btn ghost" data-act="fly">화면 이동</button>
          ${designer ? `<button class="insp-btn ghost" data-act="rename">이름 변경</button>
          <button class="insp-btn danger" data-act="del">구역 삭제</button>` : ""}
        </div>
      `;

      // 핀 행 클릭 → 핀 인스펙터
      body.querySelectorAll(".insp-pinrow").forEach(b => {
        b.addEventListener("click", () => {
          const p = (State.pins || []).find(x => x.id === b.dataset.pin);
          if (p) this.showPin(p);
        });
      });
      // 액션
      body.querySelectorAll(".insp-btn").forEach(b => {
        b.addEventListener("click", () => {
          const act = b.dataset.act;
          if (act === "zoom") { if (typeof App !== "undefined" && App.enterZoneView) App.enterZoneView(z.id); }
          else if (act === "fly") Zones.focus(z.id);
          else if (act === "del") { Zones.remove(z.id); this.close(); }
          else if (act === "rename") {
            const nv = prompt("구역 이름", z.label || "");
            if (nv != null) { z.label = nv.trim() || z.label; Zones.render(); Zones.renderList(); this.showZone(z); if (App._autoSave) App._autoSave(); }
          }
        });
      });
      this._open();
    },

    showPin(p) {
      this._kind = "pin"; this._id = p.id;
      const kindEl = document.getElementById("inspector-kind");
      const titleEl = document.getElementById("inspector-title");
      const body = document.getElementById("inspector-body");
      if (kindEl) { kindEl.textContent = "POINT"; kindEl.className = "inspector-kind kind-pin"; }
      if (titleEl) titleEl.textContent = p.label || "포인트";

      const designer = (typeof Auth !== "undefined" && Auth.isDesigner);
      const has360 = !!(p.imageId || (p.attachments && p.attachments.length));
      const inZone = (State.zones || []).find(z => (z.pinIds || []).includes(p.id));
      const docs = (p.attachments || []).filter(a => a && a.type !== "pano");

      body.innerHTML = `
        <div class="insp-swatch-row">
          <span class="insp-pin-ico ${has360 ? 'ok' : ''}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/><circle cx="12" cy="9" r="2.4"/></svg>
          </span>
          <span class="insp-shape-name">${has360 ? "360° 파노라마 등록됨" : "파노라마 미등록"}</span>
          <span class="insp-page-badge">PAGE ${p.page || 1}</span>
        </div>

        <div class="insp-section">
          <div class="insp-section-h">위치 <span class="insp-unit">(도면 % 기준)</span></div>
          <div class="insp-metrics">
            <div class="insp-metric"><span class="m-k">X</span><span class="m-v">${this._fmt(p.x)}%</span></div>
            <div class="insp-metric"><span class="m-k">Y</span><span class="m-v">${this._fmt(p.y)}%</span></div>
            <div class="insp-metric wide"><span class="m-k">소속 구역</span><span class="m-v">${inZone ? UI.escapeHtml(inZone.label) : "—"}</span></div>
          </div>
        </div>

        ${p.note ? `<div class="insp-section"><div class="insp-section-h">메모</div><div class="insp-note">${UI.escapeHtml(p.note)}</div></div>` : ""}
        ${docs.length ? `<div class="insp-section"><div class="insp-section-h">첨부 자료 <span class="insp-count">${docs.length}</span></div><div class="insp-docs">${docs.map(d => `<span class="insp-doc">📎 ${UI.escapeHtml(d.name || "자료")}</span>`).join("")}</div></div>` : ""}

        <div class="insp-actions">
          ${has360 ? `<button class="insp-btn primary" data-act="open">360° 열기</button>` : ""}
          <button class="insp-btn ghost" data-act="fly">화면 이동</button>
          ${designer ? `<button class="insp-btn ghost" data-act="edit">수정</button>
          <button class="insp-btn danger" data-act="del">삭제</button>` : ""}
        </div>
      `;
      body.querySelectorAll(".insp-btn").forEach(b => {
        b.addEventListener("click", () => {
          const act = b.dataset.act;
          if (act === "open" && typeof PanoViewer !== "undefined") PanoViewer.open(p);
          else if (act === "fly" && MapCtrl.flyTo) MapCtrl.flyTo(p.x, p.y, 2.4, 600);
          else if (act === "edit" && App.editPin) { App.editPin(p.id); this.close(); }
          else if (act === "del" && App.deletePin) { App.deletePin(p.id); this.close(); }
        });
      });
      this._open();
    },
  };

  /* ══════════════════════════════════════════
     BRAND  ── 회사 로고·테마 주입 (window.WM_BRAND)
  ══════════════════════════════════════════ */