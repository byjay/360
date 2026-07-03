  /* ══════════════════════════════════════════════════════════════
     PDF POPUP — 핀에 사진 대신 PDF가 등록된 경우, 내장 PDF.js로 팝업 표시
     ────────────────────────────────────────────────────────────────
     · 마스터 요청: 사진 대신 PDF가 등록돼 있으면 현재 내장 PDF 뷰어로 팝업.
     · PDF.load(=내장 PDF.js getDocument)로 문서를 열고, 페이지를 자체 캔버스에
       직접 렌더(메인 도면 렌더상태와 분리). prev/next 페이지 + 닫기.
     · 오프라인(미업로드) PDF는 Cloud._cache["op:"+pendingOpId] dataURL로 표시.
  ══════════════════════════════════════════════════════════════ */
  const PdfPopup = {
    _doc: null, _page: 1, _pages: 1, _busy: false,

    init() {
      const $ = (id) => document.getElementById(id);
      $("pdf-popup-close") && $("pdf-popup-close").addEventListener("click", () => this.close());
      const bd = document.querySelector("#pdf-popup .pdf-popup-backdrop");
      if (bd) bd.addEventListener("click", () => this.close());
      $("pdf-popup-prev") && $("pdf-popup-prev").addEventListener("click", () => this._go(-1));
      $("pdf-popup-next") && $("pdf-popup-next").addEventListener("click", () => this._go(1));
      document.addEventListener("keydown", (e) => {
        const m = document.getElementById("pdf-popup");
        if (!m || m.classList.contains("hidden")) return;
        if (e.key === "Escape") this.close();
        else if (e.key === "ArrowLeft") this._go(-1);
        else if (e.key === "ArrowRight") this._go(1);
      });
    },

    /** dataURL(application/pdf) 또는 PDF URL 을 받아 팝업 표시 */
    async open(src, title) {
      const modal = document.getElementById("pdf-popup");
      if (!src) return;
      if (!modal || typeof PDF === "undefined" || !PDF.load) {
        // 폴백: 내장 뷰어 불가 → 새 탭
        try { window.open(src, "_blank"); } catch (e) {}
        return;
      }
      const ttl = document.getElementById("pdf-popup-title");
      if (ttl) ttl.textContent = title || "PDF";
      modal.classList.remove("hidden");
      requestAnimationFrame(() => modal.classList.add("on"));
      const canvas = document.getElementById("pdf-popup-canvas");
      if (canvas) { const c = canvas.getContext("2d"); c && c.clearRect(0, 0, canvas.width, canvas.height); }
      try {
        const ab = await this._toArrayBuffer(src);
        this._doc = await PDF.load(ab);
        this._pages = (this._doc && this._doc.numPages) || 1;
        this._page = 1;
        await this._render();
      } catch (e) {
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("PDF를 열 수 없습니다 — " + (e && e.message ? e.message : ""));
        this.close();
      }
    },

    async _render() {
      const canvas = document.getElementById("pdf-popup-canvas");
      if (!canvas || !this._doc) return;
      const page = await this._doc.getPage(this._page);
      const body = canvas.parentElement;
      const maxW = (body ? body.clientWidth : 820) - 8;
      const base = page.getViewport({ scale: 1 });
      const dpr = window.devicePixelRatio || 1;
      const fit = Math.max(0.3, Math.min(3, maxW / base.width));
      const vp = page.getViewport({ scale: fit * dpr });
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      canvas.style.width = Math.floor(vp.width / dpr) + "px";
      canvas.style.height = Math.floor(vp.height / dpr) + "px";
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const ind = document.getElementById("pdf-popup-page");
      if (ind) ind.textContent = this._page + " / " + this._pages;
      const prev = document.getElementById("pdf-popup-prev"), next = document.getElementById("pdf-popup-next");
      if (prev) prev.disabled = this._page <= 1;
      if (next) next.disabled = this._page >= this._pages;
    },

    async _go(d) {
      if (this._busy || !this._doc) return;
      const n = this._page + d;
      if (n < 1 || n > this._pages) return;
      this._busy = true; this._page = n;
      try { await this._render(); } catch (e) {} finally { this._busy = false; }
    },

    close() {
      const modal = document.getElementById("pdf-popup");
      if (modal) { modal.classList.remove("on"); setTimeout(() => modal.classList.add("hidden"), 200); }
      this._doc = null; this._page = 1; this._pages = 1;
    },

    /** dataURL → ArrayBuffer (URL이면 fetch) */
    async _toArrayBuffer(src) {
      if (typeof src === "string" && src.indexOf("data:") === 0) {
        const base64 = src.split(",")[1] || "";
        const bin = atob(base64); const len = bin.length; const u8 = new Uint8Array(len);
        for (let i = 0; i < len; i++) u8[i] = bin.charCodeAt(i);
        return u8.buffer;
      }
      const r = await fetch(src);
      return await r.arrayBuffer();
    },
  };
