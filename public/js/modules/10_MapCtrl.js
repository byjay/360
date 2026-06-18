  const MapCtrl = {
    viewport: null, transform: null, _flyRaf: null,

    init(viewport, transform) {
      this.viewport = viewport; this.transform = transform;
      // GPU 합성 힌트 → 패닝/줌/flyTo 가 부드럽고 빠르게 동작
      try {
        transform.style.willChange = "transform";
        transform.style.transformOrigin = "0 0";
        transform.style.backfaceVisibility = "hidden";
      } catch (e) {}
    },

    applyTransform() {
      const { x, y } = State.pan;
      // 이미지/뷰어(스냅샷) 모드에서는 CSS rotate 로 회전(디자이너 PDF 는 캔버스 재렌더로 처리하므로 0).
      const cssRot = (State.mode !== "viewer" && State.fileType === "pdf") ? 0 : (State.pdfRotation || 0);
      const rot = cssRot ? ` rotate(${cssRot}deg)` : "";
      // ISO 3D 아이소메트릭: 평면 도면을 입체로 기울여 회전(엔지니어링 ISO 뷰 느낌)
      // 4방향(0~3) = 북동/남동/남서/북서 코너 시점 → rotateZ 각도만 90° 간격으로 회전.
      const ISO_Z = [-32, 58, 148, 238];  // 4개 코너 시점(도)
      const iso = State.isoView ? ` rotateX(54deg) rotateZ(${ISO_Z[State.isoDir % 4]}deg)` : "";
      // translate3d 로 GPU 레이어 승격 (체감 속도 향상)
      this.transform.style.transform =
        `translate3d(${x}px, ${y}px, 0) scale(${State.zoom})${iso}${rot}`;
      this._updateZoomLabel();
      // ── 벡터 PDF 화질 보존: 줌이 오르면 그 배율로 PDF 를 다시 래스터화 ──
      // (디자이너 PDF 모드에서만. 이미지/뷰어 스냅샷은 비트맵이라 해당 없음)
      if (State.mode !== "viewer" && State.fileType === "pdf" && State.pdfDoc
          && typeof PDF !== "undefined" && PDF.requestZoomRerender) {
        PDF.requestZoomRerender(State.zoom);
      }
    },

    /** ISO 3D 뷰 — 4방향 순환:
     *  평면 → 북동(0) → 남동(1) → 남서(2) → 북서(3) → 평면 …
     *  버튼을 누를 때마다 한 단계씩 코너 시점을 회전한다. */
    ISO_LABELS: ["북동", "남동", "남서", "북서"],
    toggleIso() {
      if (!State.isoView) {
        // 평면 → ISO 진입(북동부터)
        State.isoView = true; State.isoDir = 0;
      } else if (State.isoDir < 3) {
        // 다음 코너로 회전
        State.isoDir += 1;
      } else {
        // 마지막 코너에서 한 번 더 → 평면 복귀
        State.isoView = false; State.isoDir = 0;
      }
      this._applyIso();
    },
    /** 특정 코너 시점으로 직접 전환 (0~3). */
    setIsoDir(dir) {
      State.isoView = true;
      State.isoDir = ((dir % 4) + 4) % 4;
      this._applyIso();
    },
    _applyIso() {
      const vp = this.viewport, tr = this.transform;
      // ★ 하단 nav 버튼(btn-iso) + 상단 툴바 버튼(tb-iso) 모두 동기화 + 방향 라벨 표시
      ["btn-iso", "tb-iso"].forEach((bid) => {
        const btn = document.getElementById(bid);
        if (!btn) return;
        btn.classList.toggle("active", State.isoView);
        try {
          const base = btn.dataset.baseLabel || (btn.dataset.baseLabel = (btn.getAttribute("title") || "ISO"));
          btn.setAttribute("title", State.isoView ? (base + " · " + this.ISO_LABELS[State.isoDir]) : base);
        } catch (e) {}
      });
      if (vp) vp.classList.toggle("iso-active", State.isoView);
      // ISO 방향 표시 토스트
      try {
        if (State.isoView && typeof Prompt !== "undefined" && Prompt.toast)
          Prompt.toast("🧊 ISO 3D · " + this.ISO_LABELS[State.isoDir] + " 시점 (버튼 반복 → 4방향 회전, 평면 복귀)");
        else if (!State.isoView && typeof Prompt !== "undefined" && Prompt.toast)
          Prompt.toast("🗺️ 평면 뷰로 복귀");
      } catch (e) {}
      const size = this._contentSize();
      if (tr) {
        tr.style.transition = "transform .75s cubic-bezier(.22,.61,.36,1)";
        if (State.isoView && size) {
          const vw = this.viewport.clientWidth, vh = this.viewport.clientHeight;
          const z = Math.min(vw / size.w, vh / size.h) * 0.62; // 입체 변형 고려 여유 축소
          State.zoom = z;
          State.pan = { x: (vw - size.w * z) / 2, y: (vh - size.h * z) / 2 + vh * 0.04 };
        }
        this.applyTransform();
        setTimeout(() => { try { tr.style.transition = ""; } catch (e) {} }, 800);
      }
    },

    _updateZoomLabel() {
      const pct = Math.round(State.zoom * 100) + "%";
      const el = document.getElementById("zoom-level");
      if (el) el.textContent = pct;
      const tb = document.getElementById("tb-zoom-level");
      if (tb) tb.textContent = pct;
    },

    /** 도면 콘텐츠의 "논리(CSS) 크기" — 줌/팬 계산용.
     *  PDF 캔버스는 내부 픽셀(width)이 dpr·줌에 따라 달라지므로,
     *  레이아웃상 차지하는 CSS 크기(style.width/offsetWidth)를 기준으로 한다. */
    _contentSize() {
      const cv = document.getElementById("pdf-canvas");
      const img = document.getElementById("map-image");
      if (cv && !cv.classList.contains("hidden") && cv.width) {
        // CSS 크기 우선(고해상도 재렌더와 무관하게 일정). 미설정 시 픽셀 폴백.
        const w = parseFloat(cv.style.width)  || cv.offsetWidth  || cv.width;
        const h = parseFloat(cv.style.height) || cv.offsetHeight || cv.height;
        return { w, h };
      }
      if (img && !img.classList.contains("hidden") && img.naturalWidth)
        return { w: img.naturalWidth, h: img.naturalHeight };
      return null;
    },

    /** 뷰포트 중심 기준으로 배율 변경 (부드러운 줌) */
    zoomBy(factor, cx, cy) {
      this.cancelFly();
      const rect = this.viewport.getBoundingClientRect();
      const mx = (cx != null ? cx : rect.left + rect.width / 2) - rect.left;
      const my = (cy != null ? cy : rect.top + rect.height / 2) - rect.top;
      const newZoom = Math.max(0.2, Math.min(8, State.zoom * factor));
      const f = newZoom / State.zoom;
      State.pan.x = mx - f * (mx - State.pan.x);
      State.pan.y = my - f * (my - State.pan.y);
      State.zoom = newZoom;
      this.applyTransform();
    },

    /** 화면 맞춤 — 도면 전체가 뷰포트에 들어오도록 */
    fit() {
      this.cancelFly();
      const size = this._contentSize();
      if (!size) return;
      const vw = this.viewport.clientWidth;
      const vh = this.viewport.clientHeight;
      const pad = 0.92; // 여백
      const z = Math.min(vw / size.w, vh / size.h) * pad;
      this._animateTo({
        z,
        x: (vw - size.w * z) / 2,
        y: (vh - size.h * z) / 2
      });
    },

    /** 실제 크기 (1:1, 100%) — 중앙 정렬 */
    actualSize() {
      this.cancelFly();
      const size = this._contentSize();
      if (!size) return;
      const vw = this.viewport.clientWidth;
      const vh = this.viewport.clientHeight;
      this._animateTo({ z: 1, x: (vw - size.w) / 2, y: (vh - size.h) / 2 });
    },

    /** pan/zoom 목표값으로 부드럽게 이동 */
    _animateTo(to, duration = 380) {
      const from = { x: State.pan.x, y: State.pan.y, z: State.zoom };
      const t0 = performance.now();
      const ease = t => 1 - Math.pow(1 - t, 3);
      this.cancelFly();
      const step = now => {
        const t = Math.min(1, (now - t0) / duration);
        const k = ease(t);
        State.pan.x = from.x + (to.x - from.x) * k;
        State.pan.y = from.y + (to.y - from.y) * k;
        State.zoom  = from.z + (to.z - from.z) * k;
        this.applyTransform();
        if (t < 1) this._flyRaf = requestAnimationFrame(step);
        else this._flyRaf = null;
      };
      this._flyRaf = requestAnimationFrame(step);
    },

    viewportToPercent(clientX, clientY) {
      const tRect = this.transform.getBoundingClientRect();
      if (!tRect.width || !tRect.height) return null;
      const localX = clientX - tRect.left;
      const localY = clientY - tRect.top;
      return {
        x: Math.max(0, Math.min(100, (localX / tRect.width) * 100)),
        y: Math.max(0, Math.min(100, (localY / tRect.height) * 100))
      };
    },

    handleWheel(e) {
      e.preventDefault();
      this.cancelFly();
      const delta = -e.deltaY * 0.001;
      const newZoom = Math.max(0.3, Math.min(8, State.zoom + delta * State.zoom));
      const rect = this.viewport.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const f = newZoom / State.zoom;
      State.pan.x = mx - f * (mx - State.pan.x);
      State.pan.y = my - f * (my - State.pan.y);
      State.zoom = newZoom;
      this.applyTransform();
    },

    handlePanStart(e) {
      if (State.placing) return;
      this.cancelFly();
      State.panDragging = true;
      State.panStart = { mx: e.clientX, my: e.clientY, px: State.pan.x, py: State.pan.y };
      this.viewport.style.cursor = "grabbing";
    },
    handlePanMove(e) {
      if (!State.panDragging) return;
      State.pan.x = State.panStart.px + (e.clientX - State.panStart.mx);
      State.pan.y = State.panStart.py + (e.clientY - State.panStart.my);
      this.applyTransform();
    },
    handlePanEnd() {
      State.panDragging = false;
      this.viewport.style.cursor = State.placing ? "crosshair" : "grab";
    },

    /** 핀 위치(% 좌표)로 부드럽게 줌인 이동 (플라이투) */
    flyTo(xPct, yPct, targetZoom = 2.2, duration = 750) {
      this.cancelFly();
      const cw = this.transform.offsetWidth;
      const ch = this.transform.offsetHeight;
      const vw = this.viewport.clientWidth;
      const vh = this.viewport.clientHeight;
      if (!cw || !ch || !vw || !vh) return;

      const from = { x: State.pan.x, y: State.pan.y, z: State.zoom };
      const to = {
        x: vw / 2 - targetZoom * (xPct / 100) * cw,
        y: vh / 2 - targetZoom * (yPct / 100) * ch,
        z: targetZoom
      };
      const t0 = performance.now();
      const ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

      const step = now => {
        const t = Math.min(1, (now - t0) / duration);
        const k = ease(t);
        State.pan.x = from.x + (to.x - from.x) * k;
        State.pan.y = from.y + (to.y - from.y) * k;
        State.zoom  = from.z + (to.z - from.z) * k;
        this.applyTransform();
        if (t < 1) this._flyRaf = requestAnimationFrame(step);
        else this._flyRaf = null;
      };
      this._flyRaf = requestAnimationFrame(step);
    },
    cancelFly() {
      if (this._flyRaf) { cancelAnimationFrame(this._flyRaf); this._flyRaf = null; }
    },

    /** 구역(zone bbox %)을 화면에 꽉 차게 확대(crop-view). 구역 페이지 진입에 사용.
     *  bbox: {x,y,w,h} (% 단위). pad: 여백 비율(0.12 = 12%). */
    fitZone(bbox, pad = 0.12, duration = 620) {
      if (!bbox || !(bbox.w > 0) || !(bbox.h > 0)) return;
      const vw = this.viewport.clientWidth, vh = this.viewport.clientHeight;
      const cw = this.transform.offsetWidth, ch = this.transform.offsetHeight;
      if (!vw || !vh || !cw || !ch) return;
      // 구역의 픽셀 크기(줌1 기준) = (w% / 100) * cw
      const zoneW = (bbox.w / 100) * cw;
      const zoneH = (bbox.h / 100) * ch;
      // 패딩 포함해 화면에 맞추는 배율 (가로/세로 중 더 빡빡한 쪽)
      const padK = 1 - Math.max(0, Math.min(0.4, pad));
      let z = Math.min((vw * padK) / zoneW, (vh * padK) / zoneH);
      z = Math.max(0.3, Math.min(8, z)); // MapCtrl 줌 한계 내로
      const cx = bbox.x + bbox.w / 2;
      const cy = bbox.y + bbox.h / 2;
      this.flyTo(cx, cy, z, duration);
      return z;
    }
  };

  /* ══════════════════════════════════════════
     UI UTILITIES
  ══════════════════════════════════════════ */