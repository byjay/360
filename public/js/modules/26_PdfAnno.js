  const PdfAnno = {
    _drawing: false,
    _start: null,
    _cur: null,
    _NS: "http://www.w3.org/2000/svg",
    init() {
      const svg = document.getElementById("anno-svg");
      if (!svg) return;
      const tools = ["cursor", "highlight", "rect", "pen", "text"];
      tools.forEach(t => {
        const btn = document.getElementById("tb-anno-" + (t === "highlight" ? "hl" : t));
        if (btn) btn.addEventListener("click", () => this.setTool(t));
      });
      const colorEl = document.getElementById("tb-anno-color");
      if (colorEl) colorEl.addEventListener("input", e => { State.annoColor = e.target.value; });
      const undo = document.getElementById("tb-anno-undo");
      if (undo) undo.addEventListener("click", () => this.undo());
      const clr = document.getElementById("tb-anno-clear");
      if (clr) clr.addEventListener("click", () => this.clearPage());
      svg.addEventListener("pointerdown", e => this._onDown(e));
      window.addEventListener("pointermove", e => this._onMove(e));
      window.addEventListener("pointerup", () => this._onUp());
    },
    setTool(tool) {
      State.annoTool = tool;
      document.querySelectorAll(".tb-anno[data-tool]").forEach(b => {
        b.classList.toggle("active", b.getAttribute("data-tool") === tool);
      });
      const svg = document.getElementById("anno-svg");
      if (svg) {
        svg.style.pointerEvents = (tool === "cursor") ? "none" : "auto";
        svg.style.cursor = (tool === "cursor") ? "default" : (tool === "text" ? "text" : "crosshair");
      }
    },
    updateToolbar() {
      const grp = document.getElementById("tb-anno-group");
      if (!grp) return;
      const show = (State.mode === "designer");
      grp.classList.toggle("hidden", !show);
      if (!show) this.setTool("cursor");
    },
    _pt(e) {
      const svg = document.getElementById("anno-svg");
      const r = svg.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return {
        x: Math.max(0, Math.min(1000, ((e.clientX - r.left) / r.width) * 1000)),
        y: Math.max(0, Math.min(1000, ((e.clientY - r.top) / r.height) * 1000))
      };
    },
    _onDown(e) {
      if (State.mode !== "designer") return;
      const tool = State.annoTool;
      if (tool === "cursor") return;
      const p = this._pt(e);
      if (!p) return;
      e.preventDefault(); e.stopPropagation();
      if (tool === "text") { this._addText(p); return; }
      this._drawing = true;
      this._start = p;
      const id = "an-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      if (tool === "pen") {
        this._cur = { id, page: State.pdfPage, type: "pen", color: State.annoColor, pts: [p] };
      } else if (tool === "highlight") {
        this._cur = { id, page: State.pdfPage, type: "highlight", color: State.annoColor, x: p.x, y: p.y, w: 0, h: 0 };
      } else {
        this._cur = { id, page: State.pdfPage, type: "rect", color: State.annoColor, x: p.x, y: p.y, w: 0, h: 0 };
      }
    },
    _onMove(e) {
      if (!this._drawing || !this._cur) return;
      const p = this._pt(e);
      if (!p) return;
      if (this._cur.type === "pen") {
        this._cur.pts.push(p);
      } else {
        this._cur.x = Math.min(this._start.x, p.x);
        this._cur.y = Math.min(this._start.y, p.y);
        this._cur.w = Math.abs(p.x - this._start.x);
        this._cur.h = Math.abs(p.y - this._start.y);
      }
      this._renderLive();
    },
    _onUp() {
      if (!this._drawing || !this._cur) { this._drawing = false; return; }
      this._drawing = false;
      const c = this._cur; this._cur = null;
      if ((c.type === "rect" || c.type === "highlight") && (c.w < 6 || c.h < 6)) { this._render(); return; }
      if (c.type === "pen" && c.pts.length < 2) { this._render(); return; }
      State.annotations.push(c);
      this._render();
      this._persist();
    },
    _addText(p) {
      const txt = (typeof prompt === "function") ? prompt("메모 내용을 입력하세요") : "";
      if (!txt) return;
      const id = "an-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      State.annotations.push({ id, page: State.pdfPage, type: "text", color: State.annoColor, x: p.x, y: p.y, text: txt });
      this._render();
      this._persist();
    },
    undo() {
      for (let i = State.annotations.length - 1; i >= 0; i--) {
        if ((State.annotations[i].page || 1) === State.pdfPage) {
          State.annotations.splice(i, 1);
          this._render(); this._persist(); return;
        }
      }
    },
    async clearPage() {
      if (!State.annotations.some(a => (a.page || 1) === State.pdfPage)) return;
      if (!await Prompt.confirm("주석 전체 삭제", "현재 페이지의 모든 주석을 삭제할까요?")) return;
      State.annotations = State.annotations.filter(a => (a.page || 1) !== State.pdfPage);
      this._render(); this._persist();
    },
    _renderLive() {
      this._render();
      if (!this._cur) return;
      const svg = document.getElementById("anno-svg");
      if (svg) svg.appendChild(this._buildShape(this._cur));
    },
    _buildShape(a) {
      const NS = this._NS;
      if (a.type === "pen") {
        const pl = document.createElementNS(NS, "polyline");
        pl.setAttribute("points", a.pts.map(p => p.x + "," + p.y).join(" "));
        pl.setAttribute("fill", "none");
        pl.setAttribute("stroke", a.color);
        pl.setAttribute("stroke-width", "3");
        pl.setAttribute("stroke-linecap", "round");
        pl.setAttribute("stroke-linejoin", "round");
        pl.setAttribute("vector-effect", "non-scaling-stroke");
        pl.dataset.aid = a.id;
        return pl;
      }
      const rect = document.createElementNS(NS, "rect");
      rect.setAttribute("x", a.x); rect.setAttribute("y", a.y);
      rect.setAttribute("width", a.w); rect.setAttribute("height", a.h);
      rect.dataset.aid = a.id;
      if (a.type === "highlight") {
        rect.setAttribute("fill", a.color);
        rect.setAttribute("fill-opacity", "0.28");
        rect.setAttribute("stroke", "none");
      } else {
        rect.setAttribute("fill", "none");
        rect.setAttribute("stroke", a.color);
        rect.setAttribute("stroke-width", "2.5");
        rect.setAttribute("vector-effect", "non-scaling-stroke");
      }
      return rect;
    },
    _render() {
      const svg = document.getElementById("anno-svg");
      const tl = document.getElementById("anno-text-layer");
      if (!svg || !tl) return;
      svg.innerHTML = "";
      tl.innerHTML = "";
      const page = State.pdfPage;
      State.annotations.forEach(a => {
        if ((a.page || 1) !== page) return;
        if (a.type === "text") {
          const box = document.createElement("div");
          box.className = "anno-text-box";
          box.style.left = (a.x / 10) + "%";
          box.style.top = (a.y / 10) + "%";
          box.style.borderColor = a.color;
          box.dataset.aid = a.id;
          box.innerHTML = `<span class="anno-text-content">${(a.text || "").replace(/</g, "&lt;")}</span>`;
          if (State.mode === "designer") {
            const del = document.createElement("button");
            del.className = "anno-text-del";
            del.textContent = "✕";
            del.title = "메모 삭제";
            del.addEventListener("click", ev => { ev.stopPropagation(); this._removeById(a.id); });
            box.appendChild(del);
            box.style.pointerEvents = "auto";
          }
          tl.appendChild(box);
        } else {
          svg.appendChild(this._buildShape(a));
        }
      });
    },
    _removeById(id) {
      State.annotations = State.annotations.filter(a => a.id !== id);
      this._render(); this._persist();
    },
    refresh() { this._render(); this.updateToolbar(); },
    _persist() {
      if (State.mode !== "designer") return;
      // [오프라인 작업지시서 ] 오프라인이면 현재 주석들을 id 단위 upsert op 로 기록 + 로컬 스냅샷
      if (!navigator.onLine && typeof OpLog !== "undefined") {
        try {
          const arr = (State.annotations || []).filter(a => a && a.id != null);
          (async () => {
            for (const a of arr) await OpLog.recordCurrent("anno", "upsert", a.id, a);
            await persistLocalDeployment();
          })().catch(() => {});
        } catch (e) {}
      }
      try { if (typeof App !== "undefined" && App._autoSave) App._autoSave({}); } catch (e) {}
    }
  };

  /* ══════════════════════════════════════════
     PIN ACTION POP — 핀 작업 전용 팝업
     (디자이너가 핀 클릭 → 이동/수정·사진추가/삭제/360°보기)
  ══════════════════════════════════════════ */