  const Compare = {
    _a: null, _b: null, _ratio: 0.5, _dragging: false, _busy: false,

    /** [WO 20261008-comparesync] 기본 모드 = 360 동기 비교(두 뷰어를 나란히, 한쪽을 돌리면 같이 돈다).
     *  CompareSync/THREE 가 없거나 시점이 영상/1개뿐이면 기존 평면 슬라이더로 자동 대체(기능 유지). */
    async open() {
      if (this._busy) return;
      if (typeof CompareSync !== "undefined" && CompareSync.open) {
        const ok360 = await CompareSync.open();
        if (ok360) return;
      }
      return this.openFlat();
    },

    /** 기존 "평면 슬라이더" 비교(등장방형 이미지를 canvas 에 cover 로 그려 클립 경계 이동) — 보조 모드.
     *  CompareSync 의 [평면 슬라이더] 버튼이 호출하거나, 360 로드가 불가능할 때 open()이 대체 호출한다. */
    async openFlat(aShot, bShot) {
      if (this._busy) return;
      if (!TimeLapse.hasMultiple()) { return; }
      const a = aShot || TimeLapse.currentShot();      // 선택 시점(과거)
      const b = bShot || TimeLapse.latestShot();       // 최신
      if (!a || !b) return;
      this._busy = true;
      try {
        const ra = await TimeLapse._resolveSrc(a);
        const rb = await TimeLapse._resolveSrc(b);
        if (!ra || !rb || ra.isVideo || rb.isVideo) { this._busy = false; this._toast("정적 이미지 시점만 분할 비교할 수 있습니다."); return; }
        const [ia, ib] = await Promise.all([this._loadImg(ra.src), this._loadImg(rb.src)]);
        this._a = ia; this._b = ib;
        const ov = document.getElementById("pano-compare");
        ov.classList.remove("hidden");
        document.getElementById("cmp-label-a").textContent = a.label;
        document.getElementById("cmp-label-b").textContent = b.label;
        this._ratio = 0.5;
        this._bind();
        this._resizeAndDraw();
      } catch (e) {
        this._toast("이미지를 불러올 수 없습니다.");
      }
      this._busy = false;
    },

    _loadImg(src) {
      return new Promise((res, rej) => {
        const im = new Image(); im.crossOrigin = "anonymous";
        im.onload = () => res(im); im.onerror = rej;
        im.src = (typeof Auth !== "undefined" && Auth.r2) ? Auth.r2(src) : src;
      });
    },

    _bind() {
      if (this._bound) return; this._bound = true;
      const div = document.getElementById("cmp-divider");
      const ov = document.getElementById("pano-compare");
      const closeBtn = document.getElementById("btn-cmp-close");
      const onMove = (clientX) => {
        const r = ov.getBoundingClientRect();
        let ratio = (clientX - r.left) / r.width;
        ratio = Math.max(0.02, Math.min(0.98, ratio));
        this._ratio = ratio; this._applyClip();
      };
      div.addEventListener("pointerdown", (e) => { this._dragging = true; div.setPointerCapture(e.pointerId); });
      window.addEventListener("pointermove", (e) => { if (this._dragging) onMove(e.clientX); });
      window.addEventListener("pointerup", () => { this._dragging = false; });
      ov.addEventListener("click", (e) => { if (e.target === ov) onMove(e.clientX); });
      closeBtn && closeBtn.addEventListener("click", () => this.close());
      window.addEventListener("resize", () => { if (!document.getElementById("pano-compare").classList.contains("hidden")) this._resizeAndDraw(); });
    },

    _resizeAndDraw() {
      const ov = document.getElementById("pano-compare");
      const w = ov.clientWidth, h = ov.clientHeight;
      ["cmp-canvas-a", "cmp-canvas-b"].forEach((id) => {
        const c = document.getElementById(id);
        c.width = w; c.height = h;
      });
      this._drawCover(document.getElementById("cmp-canvas-a"), this._a);
      this._drawCover(document.getElementById("cmp-canvas-b"), this._b);
      this._applyClip();
    },

    /** equirectangular 이미지를 화면에 cover로 중앙 표시(중앙 시야 미리보기) */
    _drawCover(canvas, img) {
      if (!canvas || !img) return;
      const ctx = canvas.getContext("2d");
      const cw = canvas.width, ch = canvas.height;
      ctx.clearRect(0, 0, cw, ch);
      const ir = img.width / img.height, cr = cw / ch;
      let dw, dh, dx, dy;
      if (ir > cr) { dh = ch; dw = ch * ir; dx = (cw - dw) / 2; dy = 0; }
      else { dw = cw; dh = cw / ir; dx = 0; dy = (ch - dh) / 2; }
      ctx.drawImage(img, dx, dy, dw, dh);
    },

    _applyClip() {
      const clip = document.getElementById("cmp-clip");
      const div = document.getElementById("cmp-divider");
      const pct = (this._ratio * 100).toFixed(2) + "%";
      // 우측(B=최신)을 ratio 우측만 보이게: clip-path 사용
      clip.style.clipPath = `inset(0 0 0 ${pct})`;
      div.style.left = pct;
    },

    /** 둘 다 닫는다(360 동기 + 평면 슬라이더) — 06_PanoViewer._closeImmediate()가 Compare.close()
     *  1개만 호출하므로(grep 확인됨), 여기서 분기 없이 둘 다 정리해야 WebGL 컨텍스트 누수가 없다. */
    close() {
      const ov = document.getElementById("pano-compare");
      if (ov) ov.classList.add("hidden");
      this._a = this._b = null;
      if (typeof CompareSync !== "undefined" && CompareSync.close) CompareSync.close();
    },

    _toast(msg) {
      // 간단 안내 (이미 Prompt 모듈이 있으면 사용, 없으면 alert 대체 최소화)
      const ov = document.getElementById("pano-compare");
      if (ov && !ov.classList.contains("hidden")) return;
      try { console.info(msg); } catch (e) {}
    },
  };

  /* ══════════════════════════════════════════
     ZONES ── 도면 영역(구역) 지정 + 하이라이트
        · zone = {id,page,x,y,w,h,label,color,pinIds[],note} (좌표 % → 줌/팬 무관)
        · 설계자: 드래그로 사각형 그리기(줌 상태에서도 viewportToPercent 사용)
        · 뷰어/설계자: 영역 호버/클릭 → 하이라이트, 내부 핀 강조
        · 배포 스냅샷(deployment.zones)에 저장
  ══════════════════════════════════════════ */
  const ZONE_COLORS = ["#f59e0b", "#3b82f6", "#10b981", "#ef4444", "#a855f7", "#06b6d4"];