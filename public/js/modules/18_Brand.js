  const Brand = {
    cfg: null,

    apply() {
      const b = (typeof window !== "undefined" && window.WM_BRAND) || {};
      this.cfg = {
        logoUrl:      b.logoUrl || "",
        company:      b.company || "We:are Engineering",
        companyShort: b.companyShort || (b.company || "We:are").split(" ")[0],
        product:      b.product || "360° Location Viewer",
        tagline:      b.tagline || "GA DRAWING · PANORAMIC INSPECTION",
        accent:       b.accent  || ""
      };

      // 1) 테마색(accent) 주입 — 지정 시 --gold / --accent 덮어쓰기
      if (this.cfg.accent) {
        try {
          const root = document.documentElement;
          root.style.setProperty("--gold", this.cfg.accent);
          root.style.setProperty("--accent", this.cfg.accent);
        } catch (e) { /* noop */ }
      }

      // 2) 로고 슬롯 채우기 (home / topbar / pano / hub)
      this._fillLogo("brand-logo-home", "home");
      this._fillLogo("brand-logo-top",  "top");
      this._fillLogo("brand-logo-pano", "pano");
      this._fillLogo("hub-brand-logo",  "top");

      // 3) 텍스트 슬롯
      this._setText("home-badge",  this.cfg.company);
      this._setText("home-title",  this.cfg.product);
      this._setText("home-sub",    this.cfg.tagline);
      this._setText("home-footer", "POWERED BY " + this.cfg.company.toUpperCase());

      // 4) 문서 제목
      try { document.title = this.cfg.product + " · " + this.cfg.company; } catch (e) {}
    },

    _wordmark() {
      // 우선 companyShort(예: "SEASTAR")로 워드마크 생성
      const cs = (this.cfg.companyShort || "").trim();
      // "SEASTAR" → SEA(accent) + STAR(red) 2색 분할
      if (/^SEASTAR$/i.test(cs)) {
        return '<span class="brand-wm-1">SEA</span>'
             + '<span class="brand-wm-3">STAR</span>';
      }
      const c = (cs || this.cfg.company).trim();
      const sp = c.indexOf(" ");
      if (sp > 0) {
        const head = c.slice(0, sp), tail = c.slice(sp + 1);
        return '<span class="brand-wm-1">' + this._esc(head) + '</span>'
             + '<span class="brand-wm-2">' + this._esc(tail) + '</span>';
      }
      return '<span class="brand-wm-1">' + this._esc(c) + '</span>';
    },

    _fillLogo(id, variant) {
      const el = document.getElementById(id);
      if (!el) return;
      el.innerHTML = "";
      el.classList.remove("brand-logo--img", "brand-logo--text");

      const url = this.cfg.logoUrl;
      if (url) {
        const img = document.createElement("img");
        img.alt = this.cfg.company;
        img.className = "brand-logo-img";
        // 로드 실패 시 텍스트 워드마크로 폴백
        img.onerror = () => {
          el.classList.remove("brand-logo--img");
          el.classList.add("brand-logo--text");
          el.innerHTML = this._wordmark();
        };
        img.onload = () => {
          el.classList.add("brand-logo--img");
        };
        img.src = (typeof Auth !== "undefined" && Auth.r2) ? Auth.r2(url) : url;
        el.appendChild(img);
      } else {
        el.classList.add("brand-logo--text");
        el.innerHTML = this._wordmark();
      }
    },

    _setText(id, txt) {
      const el = document.getElementById(id);
      if (el && txt != null) el.textContent = txt;
    },

    _esc(s) {
      return String(s).replace(/[&<>"']/g, m => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]
      ));
    }
  };

  /* ══════════════════════════════════════════
     PIN GRID — 오른쪽 엑셀형 포인트 리스트
     현재 PDF 페이지의 핀을 표로 표시. 행 클릭 → 페이지 이동 + 핀 포커스 + 360° 자동 실행.
  ══════════════════════════════════════════ */