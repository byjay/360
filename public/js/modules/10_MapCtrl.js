  const MapCtrl = {
    viewport: null, transform: null, _flyRaf: null,

    init(viewport, transform) {
      this.viewport = viewport; this.transform = transform;
      // GPU 합성 힌트 → 패닝/줌/flyTo 가 부드럽고 빠르게 동작
      try {
        transform.style.willChange = "transform";
        transform.style.transformOrigin = "0 0";
        transform.style.backfaceVisibility = "hidden";
        // [마스터 요청] ISO 3D에서 핀이 "서 있게" 보이려면 부모가 3D 컨텍스트를 보존해야 함.
        //   (없으면 rotateX(54)가 자식을 평면으로 눕혀 핀 역회전이 무효 → 핀이 안 섬)
        transform.style.transformStyle = "preserve-3d";
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
      // ── [마스터 요청] ISO(기울임)에서도 핀은 항상 "서 있게"(빌보드 3D) ──
      //   도면(map-transform)이 rotateX/rotateZ 로 눕는 만큼, 핀 마커에
      //   역회전(rotateZ -각 → rotateX -54deg)을 걸어 화면 기준 수직으로 세운다.
      this._applyPinBillboard();
      // [마스터] 구역 라벨도 핀처럼 부모 zoom 을 상쇄 → 확대해도 흐려지지 않고 크리스프
      try { if (typeof Zones !== "undefined" && Zones.updateLabelScale) Zones.updateLabelScale(); } catch (e) {}
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
    /** ISO → 평면 강제 복귀(영역 그리기 등 평면 좌표가 필요한 작업 진입 시) */
    exitIso() {
      if (!State.isoView) return;
      State.isoView = false; State.isoDir = 0;
      this._applyIso();
    },
    toggleIso() {
      // [마스터 버그] 영역 그리는 중엔 ISO(원근)에서 클릭좌표가 틀어지므로 ISO 진입 금지
      if (!State.isoView && State.drawingZone) {
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("영역을 다 그린 뒤 ISO 보기를 켜주세요 (정확한 좌표 위해)");
        return;
      }
      // [마스터 버그] 배치 모드 중엔 ISO(원근)에서 클릭좌표가 틀어지므로 ISO 진입 금지 → 배치 먼저 종료
      if (!State.isoView && State.placing && typeof App !== "undefined" && App._togglePlacing) {
        App._togglePlacing();  // 배치 종료(평면 유지)
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("핀 배치를 끝낸 뒤 ISO 보기를 켜주세요 (정확한 배치 위해)");
        return;
      }
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
    /** ISO 버튼/뷰포트 클래스 동기화(공용 — toggleIso·focusZoneIso 둘 다 사용) */
    _syncIsoButtons() {
      ["btn-iso", "tb-iso", "mnav-iso"].forEach((bid) => {
        const btn = document.getElementById(bid);
        if (!btn) return;
        btn.classList.toggle("active", State.isoView);
        try {
          const base = btn.dataset.baseLabel || (btn.dataset.baseLabel = (btn.getAttribute("title") || "ISO"));
          btn.setAttribute("title", State.isoView ? (base + " · " + this.ISO_LABELS[State.isoDir]) : base);
        } catch (e) {}
      });
      if (this.viewport) this.viewport.classList.toggle("iso-active", State.isoView);
    },
    _applyIso() {
      const vp = this.viewport, tr = this.transform;
      this._syncIsoButtons();
      // [토스트 스팸 제거] ISO 시점/평면 복귀는 화면 자체가 즉시 바뀌어 결과가 보인다.
      // 버튼 반복 클릭(4방향 회전)마다 토스트가 쌓여 검은 박스 스택의 주범이었다 → 제거.
      const size = this._contentSize();
      if (tr) {
        tr.style.transition = "transform 1s cubic-bezier(.16,1,.3,1)";
        { const _pl = document.getElementById("pins-layer"); if (_pl) _pl.classList.add("iso-animating"); }
        if (State.isoView && size) {
          const vw = this.viewport.clientWidth, vh = this.viewport.clientHeight;
          const z = Math.min(vw / size.w, vh / size.h) * 0.62; // 입체 변형 고려 여유 축소
          State.zoom = z;
          State.pan = { x: (vw - size.w * z) / 2, y: (vh - size.h * z) / 2 + vh * 0.04 };
        }
        this.applyTransform();
        setTimeout(() => { try { tr.style.transition = ""; } catch (e) {} const _pl = document.getElementById("pins-layer"); if (_pl) _pl.classList.remove("iso-animating"); }, 1050);
      }
    },

    /** ISO 뷰에서 핀 마커를 화면 기준 수직(빌보드)으로 세운다.
     *  · 평면 뷰  : 핀 보정 없음(원래대로 도면에 누움 — 평면이라 무관)
     *  · ISO 뷰   : 도면 rotateX(54)·rotateZ(θ) 의 역(rotateZ(-θ)·rotateX(-54))을
     *               각 핀에 적용 → 핀 머리는 항상 위, 바늘은 항상 아래로 "서 있음".
     *    핀 tip(바늘 끝, viewBox 18/64 ≒ 하단)이 좌표에 박히도록 transform-origin 도 하단 중앙. */
    /** [마스터] 핀이 줌에 따라 깨지거나(고배율 업스케일) 너무 작아지는 것 방지:
     *  부모 #map-transform 의 scale(zoom) 을 핀마다 역스케일(1/zoom) 로 상쇄 →
     *  핀은 항상 "화면상 일정 크기"로 자연 해상도 렌더(업스케일 없음 → 또렷).
     *  줌아웃(zoom<1) 일 땐 살짝 확대해 항상 잘 보이게. ISO 에선 +세움/가독 확대. */
    /** [마스터] 핀 기본 크기 배율 — "포인트는 지금보다 2배 정도만 크게".
     *  ISO/평면 두 경로가 pinScreenScale() 하나를 공유하므로 여기 한 곳만 바꾸면
     *  핀 바늘 SVG·번호 텍스트·라벨이 모두 같은 비율로 커진다(숫자만 작게 남는 문제 없음). */
    PIN_SCALE: 2,
    pinScreenScale() {
      const zoom = State.zoom || 1;
      let f = (zoom < 1) ? (1 + (1 - zoom) * 0.65) : 1;  // 화면상 핀 크기 계수
      f = Math.max(0.85, Math.min(1.7, f));
      return (f * this.PIN_SCALE) / zoom;                 // 부모 zoom 상쇄(+줌아웃 확대)
    },
    _applyPinBillboard() {
      const layer = document.getElementById("pins-layer");
      if (!layer) return;
      const inv = this.pinScreenScale();
      const ISO_Z = [-32, 58, 148, 238];
      if (State.isoView) {
        const z = ISO_Z[State.isoDir % 4];
        // ── [마스터] 진짜 3D 박힌 핀(2D 카드 아님) ──
        //  도면은 rotateX(54)·rotateZ(z)로 기운다. 핀을 화면 정면으로 완전히 눕히면(rotateX(-54))
        //  납작한 2D 카드가 된다. 대신:
        //   · rotateZ(-z): 시점(평면 법선)축 회전만 상쇄 → 번호는 항상 정면(어느 ISO 방향서도 동일).
        //   · rotateX(-22): 도면 pitch(54)를 부분만 상쇄 → 최종 화면 pitch 54-22 = 32° 기립.
        //  결과: 바늘 tip(하단)은 땅(도면 평면)에 박히고, 머리는 평면 위로 솟아 "서 있는" 입체.
        //  preserve-3d + origin 하단 → 머리가 +Z로 떠 도면 위로 입체감(시점 무관 32° 동일, 행렬 검증).
        const billboard =
          `translate(-50%, calc(-100% + 2px)) rotateZ(${-z}deg) rotateX(-22deg) scale(${(inv * 1.18).toFixed(3)})`;
        layer.style.transformStyle = "preserve-3d";
        for (const m of layer.children) {
          m.style.transformOrigin = "50% 100%";   // 바늘 끝(하단 중앙) = 땅에 박히는 지점
          m.style.transformStyle = "preserve-3d"; // 마커 내부도 3D 보존(머리가 +Z로 솟음)
          m.style.transform = billboard;
          m.style.zIndex = "20";                   // 기울인 도면 위로 핀을 띄움
        }
      } else {
        // 평면: 역스케일만(화면상 일정 크기 → 또렷 + 줌아웃 시 약간 확대)
        const flat = `translate(-50%, calc(-100% + 2px)) scale(${inv.toFixed(3)})`;
        for (const m of layer.children) {
          m.style.transformOrigin = "50% 100%";
          m.style.transform = flat;
          m.style.zIndex = "";
        }
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
    },

    /** [핀 선택 → ISO 영역확대] ISO 3D를 켜고, 구역(bbox %)이 화면 중앙에 꽉 차도록 줌/팬.
     *  fitZone 과 달리 ISO 변형(rotateX54·rotateZθ, transform-origin 0 0, 직교투영)을
     *  역산해 정확히 중앙 정렬한다. 회전·팬·줌을 CSS transition 으로 한 번에 부드럽게.
     *  bbox:{x,y,w,h}(%), pad: 여백(0.2=20%). 이후 사용자는 휠/버튼으로 자유 확대·축소. */
    focusZoneIso(bbox, pad = 0.2, duration = 700) {
      if (!bbox || !(bbox.w > 0) || !(bbox.h > 0)) return;
      const vw = this.viewport.clientWidth, vh = this.viewport.clientHeight;
      const cw = this.transform.offsetWidth, ch = this.transform.offsetHeight;
      if (!vw || !vh || !cw || !ch) return;
      // ISO 켜기(이미 켜져 있으면 현재 코너 시점 유지, 새로 진입하면 북동=0)
      if (!State.isoView) { State.isoView = true; State.isoDir = 0; }
      const ISO_Z = [-32, 58, 148, 238];
      const th = ISO_Z[State.isoDir % 4] * Math.PI / 180;
      const cs = Math.cos(th), sn = Math.sin(th);
      const cosX = Math.cos(54 * Math.PI / 180); // rotateX(54°) → 화면 Y 단축계수(≈0.588)
      // 구역의 도면 로컬 px(줌1 기준)
      const lw = (bbox.w / 100) * cw, lh = (bbox.h / 100) * ch;
      // rotateZ 회전 후 화면정렬 바운딩 박스(Y는 rotateX 로 단축)
      const bw = Math.abs(lw * cs) + Math.abs(lh * sn);
      const bh = (Math.abs(lw * sn) + Math.abs(lh * cs)) * cosX;
      const padK = 1 - Math.max(0, Math.min(0.4, pad));
      let z = Math.min((vw * padK) / bw, (vh * padK) / bh);
      z = Math.max(0.3, Math.min(8, z)); // 줌 한계 내
      // 구역 중심의 로컬 px → ISO 변환 후 화면좌표(origin 0,0): 직교투영이라 Z 무시
      const lx = ((bbox.x + bbox.w / 2) / 100) * cw;
      const ly = ((bbox.y + bbox.h / 2) / 100) * ch;
      const sx = lx * cs - ly * sn;
      const sy = (lx * sn + ly * cs) * cosX;
      // 중심을 뷰포트 중앙(vw/2,vh/2)에 두는 pan (translate 는 scale·rotate 바깥)
      this.cancelFly();
      State.zoom = z;
      State.pan = { x: vw / 2 - z * sx, y: vh / 2 - z * sy };
      const tr = this.transform;
      try { tr.style.transition = "transform " + (duration / 1000) + "s cubic-bezier(.16,1,.3,1)"; } catch (e) {}
      { const _pl = document.getElementById("pins-layer"); if (_pl) _pl.classList.add("iso-animating"); }
      this.applyTransform();
      this._syncIsoButtons();
      setTimeout(() => { try { tr.style.transition = ""; } catch (e) {} const _pl = document.getElementById("pins-layer"); if (_pl) _pl.classList.remove("iso-animating"); }, duration + 40);
      return z;
    }
  };

  /* ══════════════════════════════════════════
     UI UTILITIES
  ══════════════════════════════════════════ */