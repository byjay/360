  const MapCtrl = {
    viewport: null, transform: null, _flyRaf: null,
    // [WO 20260928-crop] 구역(crop)이 "새 페이지"로 열려 있는 동안의 경계.
    // {x,y,w,h}(% 단위, 페이지 기준) 또는 null(경계 없음 = 종전 전체 페이지 동작).
    _cropBoundary: null,
    _boundaryFitZoom: null,        // 경계를 화면에 꽉 채우는(cover) 최소 배율(캐시)
    BOUNDARY_ZOOM_HEADROOM: 6,     // 경계 최소 배율 대비 추가로 확대 가능한 배수
    BOUNDARY_ZOOM_MAX_HARD: 64,    // 절대 상한(메모리 예산은 PDF.effectivePxCap 이 별도로 지킴)
    // [WO 20261001-mobilefast] 일반 줌(휠·핀치·+/-버튼) 상한 — 종전 8배는 모바일 핀치로 세밀한
    // 도면 판독(치수선·작은 글자)에 부족하다는 마스터 지적. zoomBy/handleWheel/pinchTransform 공유.
    MIN_ZOOM: 0.2,
    MAX_ZOOM: 16,

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

    /** [P14] 재래스터할 "원본"을 갖고 있는가 — 모드가 아니라 원본 보유 여부가 진짜 조건이다.
     *  · 편집모드 PDF        : State.pdfDoc (전면 캔버스 재래스터)
     *  · 뷰어/스냅샷 재열람  : State.srcPdfDoc (지연 로드한 원본 → 크롭 오버레이) */
    hasRerenderSource() {
      if (typeof PDF === "undefined" || !PDF.requestZoomRerender) return false;
      if (State.srcPdfDoc) return true;
      return State.fileType === "pdf" && !!State.pdfDoc;
    },

    /** [WO 20260928-crop] 구역 경계를 활성/해제한다. crop 이 {x,y,w,h}(%, w>0,h>0) 면 그
     *  사각형을 "이 페이지의 전체"로 취급(바깥 클리핑 + 줌/팬 경계). crop 이 null/무효면
     *  해제(= 크롭 없는 구버전 구역·일반 도면은 종전대로 전체 페이지 동작, 회귀 0).
     *  단일 진입점: PDF.setDeckCrop() 이 호출한다(§G-2-5 공유 지점 한 곳). */
    setCropBoundary(crop) {
      if (!crop || !(crop.w > 0) || !(crop.h > 0)) {
        this._cropBoundary = null;
        this._boundaryFitZoom = null;
        this._clearBoundaryClip();
        return null;
      }
      this._cropBoundary = { x: crop.x, y: crop.y, w: crop.w, h: crop.h };
      this._boundaryFitZoom = null; // _enforceBoundary 가 실제 뷰포트 크기로 재계산
      this._applyBoundaryClip(this._cropBoundary);
      return this._cropBoundary;
    },

    /** 경계 밖을 숨긴다. clip-path 는 transform 적용 "이전"의 로컬 레이아웃 박스 기준
     *  %로 해석되므로(스펙), pan/zoom(transform)과 무관하게 항상 도면의 같은 영역을 가린다. */
    _applyBoundaryClip(b) {
      if (!this.transform) return;
      const top    = Math.max(0, Math.min(100, b.y));
      const left   = Math.max(0, Math.min(100, b.x));
      const right  = Math.max(0, Math.min(100, 100 - b.x - b.w));
      const bottom = Math.max(0, Math.min(100, 100 - b.y - b.h));
      try { this.transform.style.clipPath = `inset(${top}% ${right}% ${bottom}% ${left}%)`; } catch (e) {}
    },
    _clearBoundaryClip() {
      try { if (this.transform) this.transform.style.clipPath = ""; } catch (e) {}
    },

    /** 순수함수(테스트 가능): bbox(%)가 vw×vh 화면을 "덮도록"(cover, 여백 없음) 하는 배율.
     *  cw/ch = 콘텐츠(도면)의 로컬(줌1) CSS 크기. 유효하지 않으면 null. */
    computeCoverZoom(bbox, vw, vh, cw, ch) {
      if (!bbox || !(bbox.w > 0) || !(bbox.h > 0) || !vw || !vh || !cw || !ch) return null;
      const zoneW = (bbox.w / 100) * cw, zoneH = (bbox.h / 100) * ch;
      if (!(zoneW > 0) || !(zoneH > 0)) return null;
      return Math.max(vw / zoneW, vh / zoneH);
    },

    /** 순수함수(테스트 가능): pan 을 "경계(bbox) 화면 영역이 뷰포트를 항상 덮도록" 가둔다.
     *  zoom >= cover 배율일 때 범위가 유효(min<=max)하다. */
    clampPanToBoundary(pan, zoom, bbox, cw, ch, vw, vh) {
      if (!bbox || !cw || !ch || !vw || !vh || !(zoom > 0)) return pan;
      const x0 = (bbox.x / 100) * cw, y0 = (bbox.y / 100) * ch;
      const w0 = (bbox.w / 100) * cw, h0 = (bbox.h / 100) * ch;
      let minX = vw - zoom * (x0 + w0), maxX = -zoom * x0;
      let minY = vh - zoom * (y0 + h0), maxY = -zoom * y0;
      if (minX > maxX) { const mid = (minX + maxX) / 2; minX = maxX = mid; }
      if (minY > maxY) { const mid = (minY + maxY) / 2; minY = maxY = mid; }
      return {
        x: Math.max(minX, Math.min(maxX, pan.x)),
        y: Math.max(minY, Math.min(maxY, pan.y))
      };
    },

    /** applyTransform() 매 호출마다 경계를 강제한다(휠/드래그/flyTo/fit 전부 여길 거친다).
     *  ISO(3D 기울임)는 화면좌표 산식이 달라 대상에서 제외(경계 없이 종전 동작). */
    _enforceBoundary() {
      if (!this._cropBoundary || State.isoView) return;
      const cw = this.transform.offsetWidth, ch = this.transform.offsetHeight;
      const vw = this.viewport.clientWidth, vh = this.viewport.clientHeight;
      if (!cw || !ch || !vw || !vh) return;
      const minZ = this.computeCoverZoom(this._cropBoundary, vw, vh, cw, ch);
      if (!(minZ > 0)) return;
      this._boundaryFitZoom = minZ;
      const maxZ = Math.min(this.BOUNDARY_ZOOM_MAX_HARD, Math.max(8, minZ * this.BOUNDARY_ZOOM_HEADROOM));
      if (State.zoom < minZ) State.zoom = minZ;
      else if (State.zoom > maxZ) State.zoom = maxZ;
      const clamped = this.clampPanToBoundary(State.pan, State.zoom, this._cropBoundary, cw, ch, vw, vh);
      State.pan.x = clamped.x; State.pan.y = clamped.y;
    },

    /** F(화면 맞춤)를 경계로 리다이렉트 — 경계 활성 시 "새 페이지"(크롭)를 화면에 꽉 채운다. */
    _fitBoundary() {
      const b = this._cropBoundary;
      const cw = this.transform.offsetWidth, ch = this.transform.offsetHeight;
      const vw = this.viewport.clientWidth, vh = this.viewport.clientHeight;
      if (!cw || !ch || !vw || !vh) return;
      const z = this.computeCoverZoom(b, vw, vh, cw, ch);
      if (!(z > 0)) return;
      const x0 = (b.x / 100) * cw, y0 = (b.y / 100) * ch;
      const w0 = (b.w / 100) * cw, h0 = (b.h / 100) * ch;
      this._animateTo({
        z,
        x: (vw - w0 * z) / 2 - x0 * z,
        y: (vh - h0 * z) / 2 - y0 * z
      });
    },

    applyTransform() {
      this._enforceBoundary();
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
      // ── 벡터 원본 화질 보존: 줌이 오르면 그 배율로 원본을 다시 래스터화 ──
      // [P14 근본원인 2026-09-03] 종전 조건은 `State.mode !== "viewer"` 였다. 진짜 조건은
      //   모드가 아니라 **재렌더할 원본을 갖고 있는가** 다. 뷰어는 배포 스냅샷(비트맵)만
      //   갖고 있어 CSS 확대 = 뭉갬이었다 → 원본 PDF 를 지연 로드하면 뷰어도 선명해진다.
      if (this.hasRerenderSource()) {
        // 애니메이션(플라이/ISO/구역 확대)이 남아 있으면 그 잔여시간만큼 재렌더를 미룬다
        // → 애니메이션 중에는 부하 0, 끝난 뒤 최종 배율로 딱 한 번 고품질 렌더.
        PDF.requestZoomRerender(State.zoom, this._settleRemain());
      } else if (typeof App !== "undefined" && App.maybeLoadSourcePdf) {
        // 원본이 없다 → 스냅샷 해상도를 실제로 넘어섰을 때만 원본을 1회 지연 로드한다.
        App.maybeLoadSourcePdf(State.zoom);
      }
      // [화질] 확대가 끝나면 합성 힌트를 풀어, 브라우저가 현재 배율로 다시 래스터화하게 한다.
      this._scheduleSettle();
    },

    /* ── 확대 종료 후 화질 수렴(settle) ──────────────────────────────────
       will-change:transform 이 걸린 레이어는 브라우저가 "확대 전 해상도" 텍스처를
       재사용하는 경향이 있어, 특히 ISO(rotateX/rotateZ 3D) 아래에서 확대 결과가 흐릿하다.
       MDN 권고대로 "변화가 끝나면 will-change 를 제거"해 재래스터화를 유도한다.
       (조작이 다시 시작되면 즉시 되돌려 성능을 지킨다 — 아래 _armWillChange)
       ⚠ 정직 고지: 이 항목은 라이브 브라우저로 효과를 실측하지 못했다(코드/명세 근거만).
          되돌리려면 _scheduleSettle 호출 한 줄만 제거하면 된다. */
    SETTLE_IDLE_MS: 180,
    _settleUntil: 0,     // 진행 중인 CSS transition 종료 시각(performance.now 기준)
    _settleTimer: null,
    /** 진행 중 애니메이션의 남은 시간(ms) */
    _settleRemain() {
      const now = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
      if (this._flyRaf) return this.SETTLE_IDLE_MS;      // rAF 플라이: 매 프레임 리셋되므로 최소값
      return Math.max(0, this._settleUntil - now);
    },
    /** CSS transition 기반 애니메이션 시작을 알린다(focusZoneIso/_applyIso 공용) */
    _markAnimating(durationMs) {
      const now = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
      this._settleUntil = now + (durationMs || 0) + 40;
      this._armWillChange();
    },
    _armWillChange() {
      try { if (this.transform && this.transform.style.willChange !== "transform") this.transform.style.willChange = "transform"; } catch (e) {}
    },
    _scheduleSettle() {
      if (typeof setTimeout !== "function") return;
      this._armWillChange();
      clearTimeout(this._settleTimer);
      const wait = this.SETTLE_IDLE_MS + this._settleRemain();
      this._settleTimer = setTimeout(() => {
        if (this._flyRaf || State.panDragging) { this._scheduleSettle(); return; } // 아직 조작 중
        try { if (this.transform) this.transform.style.willChange = "auto"; } catch (e) {}
      }, wait);
    },

    /* ══ [화질] 보이는 도면 영역 산출 — 고해상도 크롭 렌더용 ══════════════════
       전면 캔버스 한 장으로는 대형 도면의 구역 확대를 감당할 수 없다(구조적 상한):
         A1(2384×1684pt) · 캔버스 한 변 상한 8192px → 최대 렌더 배율 ≈ 3.44
         → dpr 2 화면에서 선명함이 유지되는 줌은 ≈1.7배까지. 구역 확대는 4~8배다.
       그래서 확대가 끝나면 "지금 보이는 영역만" 그 배율로 다시 그려 위에 얹는다
       (02_PDF.renderCrop). 크롭 면적은 뷰포트 크기로 자연히 묶여 메모리가 안 터진다. */
    ISO_ANGLES: [-32, 58, 148, 238],   // applyTransform 의 ISO_Z 와 같은 값(코너 시점 4종)
    ISO_TILT_DEG: 54,                  // applyTransform 의 rotateX(54deg)

    /** 도면 로컬좌표(px) → 화면좌표(px). applyTransform 과 같은 모델.
     *  ⚠ CSS perspective(2600px)는 무시하는 직교 근사다 — focusZoneIso 가 중앙정렬에
     *     쓰는 것과 동일한 근사이며, 그래서 크롭 영역에 넉넉한 여백(pad)을 준다.
     *  순수 함수(테스트 가능). */
    projectPoint(lx, ly, o) {
      const z = o.zoom, px = o.panX, py = o.panY;
      if (!o.iso) return { x: px + z * lx, y: py + z * ly };
      const th = (o.isoAngleDeg || 0) * Math.PI / 180;
      const cs = Math.cos(th), sn = Math.sin(th);
      const tilt = (o.tiltDeg == null ? this.ISO_TILT_DEG : o.tiltDeg) * Math.PI / 180;
      const cosX = Math.cos(tilt);
      return { x: px + z * (lx * cs - ly * sn), y: py + z * ((lx * sn + ly * cs) * cosX) };
    },

    /** 뷰포트에 실제로 보이는 도면 영역 (0~1 비율 {x,y,w,h}). 순수 함수.
     *  역행렬 대신 전진 투영 격자 표본을 쓴다: ISO(3D+perspective) 역변환은 정확히 풀 수 없고,
     *  근사 역행렬은 "조용히 틀린 영역"을 그린다. 표본은 둔하지만 틀리지 않는다.
     *  ponytail: O(n²) 격자(97×97≈9.4k, 확대 종료 시 1회만). 정밀도가 더 필요하면 N만 올린다. */
    computeVisibleRect(o) {
      const N = o.grid || 96;
      const pad = (o.pad == null ? 0.25 : o.pad);
      const cw = o.contentW, ch = o.contentH, vw = o.viewW, vh = o.viewH;
      const FULL = { x: 0, y: 0, w: 1, h: 1 };
      if (!(cw > 0 && ch > 0 && vw > 0 && vh > 0)) return FULL;
      let x0 = 1, y0 = 1, x1 = 0, y1 = 0, hit = 0;
      for (let i = 0; i <= N; i++) {
        const u = i / N, lx = u * cw;
        for (let j = 0; j <= N; j++) {
          const v = j / N;
          const p = this.projectPoint(lx, v * ch, o);
          if (p.x < 0 || p.y < 0 || p.x > vw || p.y > vh) continue;
          hit++;
          if (u < x0) x0 = u;
          if (u > x1) x1 = u;
          if (v < y0) y0 = v;
          if (v > y1) y1 = v;
        }
      }
      // 표본이 거의 안 잡히면(격자보다 좁은 영역 등) 전면으로 안전하게 폴백한다.
      if (hit < 2) return FULL;
      const mx = (x1 - x0) * pad + 1 / N;
      const my = (y1 - y0) * pad + 1 / N;
      x0 = Math.max(0, x0 - mx); x1 = Math.min(1, x1 + mx);
      y0 = Math.max(0, y0 - my); y1 = Math.min(1, y1 + my);
      return { x: x0, y: y0, w: Math.max(0.01, x1 - x0), h: Math.max(0.01, y1 - y0) };
    },

    /** [WO 20260917] 핀 표시좌표 변환 — 페이지 기준 %(pin.x/y 저장 형식) → 구역 크롭 기준 %.
     *  순수 함수(테스트 가능) · 저장값(x,y)은 변경하지 않고 새 좌표만 반환한다.
     *  crop 없으면 항등(변환 없음, 종전대로 페이지 전체 기준). 크롭 밖이면 null(표시 안 함). */
    pageToDeckCropPct(x, y, crop) {
      if (!crop || !(crop.w > 0) || !(crop.h > 0)) return { x, y };
      if (x < crop.x || x > crop.x + crop.w || y < crop.y || y > crop.y + crop.h) return null;
      return { x: (x - crop.x) / crop.w * 100, y: (y - crop.y) / crop.h * 100 };
    },

    /** 역변환 — 크롭 기준 표시 % → 페이지 기준 %(저장용). 순수 함수.
     *  🔴 새 핀을 크롭 화면에서 찍을 때 반드시 이 함수로 되돌려 저장해야
     *  기존 페이지 기준 % 저장 형식(마이그레이션 없음)과 어긋나지 않는다. */
    deckCropPctToPage(x, y, crop) {
      if (!crop || !(crop.w > 0) || !(crop.h > 0)) return { x, y };
      return { x: crop.x + (x / 100) * crop.w, y: crop.y + (y / 100) * crop.h };
    },

    /** 현재 화면 기준 보이는 도면 영역 (PDF.renderCrop 입력) */
    visibleDrawingRect() {
      if (!this.viewport || !this.transform) return null;
      return this.computeVisibleRect({
        contentW: this.transform.offsetWidth, contentH: this.transform.offsetHeight,
        viewW: this.viewport.clientWidth, viewH: this.viewport.clientHeight,
        zoom: State.zoom, panX: State.pan.x, panY: State.pan.y,
        iso: !!State.isoView, isoAngleDeg: this.ISO_ANGLES[(State.isoDir || 0) % 4]
      });
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
        this._markAnimating(1010); // 전환 끝난 뒤 최종 배율로 1회 고품질 재렌더
        this.applyTransform();
        setTimeout(() => { try { tr.style.transition = ""; } catch (e) {} const _pl = document.getElementById("pins-layer"); if (_pl) _pl.classList.remove("iso-animating"); }, 1050);
      }
    },

    /** ISO 뷰에서 핀 마커를 화면 기준 수직(빌보드)으로 세운다.
     *  · 평면 뷰  : 핀 보정 없음(원래대로 도면에 누움 — 평면이라 무관)
     *  · ISO 뷰   : 도면 rotateX(54)·rotateZ(θ) 의 역(rotateZ(-θ)·rotateX(-54))을
     *               각 핀에 적용 → 핀 머리는 항상 위, 바늘은 항상 아래로 "서 있음".
     *    핀 tip(바늘 끝, viewBox 18/64 ≒ 하단)이 좌표에 박히도록 transform-origin 도 하단 중앙. */
    /** [마스터 2026-08-31] 핀 크기 = 도면 대비 "완전 고정"(1/zoom 전체 상쇄)이 아니라
     *  "부분 보정"(1/zoom 의 지수 k 승)으로 바꿈. 이유: 완전 고정이면 줌아웃 시 핀이
     *  도면과 함께 작아지지 않아 도면 대비 과도하게 커 보임(마스터 스샷 1번 지적).
     *  대신 지수 k(0~1)만큼만 상쇄 → 줌아웃하면 핀도 어느 정도 같이 작아지되(k<1이라
     *  1/zoom 만큼 다 커지진 않음), 줌인해도 너무 작아지지 않는 절충.
     *  ISO/평면 두 경로가 pinScreenScale() 하나를 공유 → 상수만 바꾸면 전체 반영. */
    PIN_SCALE: 2,           // 기준 줌(zoom=1)에서의 핀 배율 — 마스터가 "적당하다"고 한 크기
    PIN_SCALE_EXP: 0.6,     // 줌 보정 지수(0=보정 없음=도면과 완전히 같이 축소, 1=기존처럼 화면상 완전 고정)
    PIN_MIN_SCALE: 0.8,     // 최종 배율 하한 — 줌인해도 핀이 이보다 작아지지 않음(가독성 하한)
    PIN_MAX_SCALE: 4.5,     // 최종 배율 상한 — 줌아웃해도 핀이 이보다 커지지 않음(도면 대비 과대 방지)
    pinScreenScale() {
      const zoom = State.zoom || 1;
      const raw = this.PIN_SCALE * Math.pow(1 / zoom, this.PIN_SCALE_EXP); // 부분 역스케일
      return Math.max(this.PIN_MIN_SCALE, Math.min(this.PIN_MAX_SCALE, raw));
    },
    _applyPinBillboard() {
      const layer = document.getElementById("pins-layer");
      if (!layer) return;
      const inv = this.pinScreenScale();
      // [WO 20261008-pinstyle §2] 화살촉·선 굵기도 같은 inv 로(풍선과 비례 고정) — SVG 좌표라 UI 쪽에서 재계산.
      if (typeof UI !== "undefined" && UI.refreshLeaders) { try { UI.refreshLeaders(); } catch (e) {} }
      // [WO 20261001-leader] 리더 풍선(.pin-leader-bubble) — 바늘형 핀과 앵커가 다르다(중앙 vs 하단).
      // ISO 여부와 무관하게 항상 평면 중앙 역스케일만 적용해 화면 기준 크기 고정(요구사항 §3).
      for (const m of layer.children) {
        if (m.classList && m.classList.contains("pin-leader-bubble")) {
          m.style.transformOrigin = "50% 50%";
          m.style.transform = `translate(-50%, -50%) scale(${inv.toFixed(3)})`;
          m.style.zIndex = "21";
        }
      }
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
          if (m.classList && m.classList.contains("pin-leader-bubble")) continue; // 위에서 이미 처리(중앙 앵커)
          m.style.transformOrigin = "50% 100%";   // 바늘 끝(하단 중앙) = 땅에 박히는 지점
          m.style.transformStyle = "preserve-3d"; // 마커 내부도 3D 보존(머리가 +Z로 솟음)
          m.style.transform = billboard;
          m.style.zIndex = "20";                   // 기울인 도면 위로 핀을 띄움
        }
      } else {
        // 평면: 역스케일만(화면상 일정 크기 → 또렷 + 줌아웃 시 약간 확대)
        const flat = `translate(-50%, calc(-100% + 2px)) scale(${inv.toFixed(3)})`;
        for (const m of layer.children) {
          if (m.classList && m.classList.contains("pin-leader-bubble")) continue; // 위에서 이미 처리(중앙 앵커)
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
      const newZoom = Math.max(this.MIN_ZOOM, Math.min(this.MAX_ZOOM, State.zoom * factor));
      const f = newZoom / State.zoom;
      State.pan.x = mx - f * (mx - State.pan.x);
      State.pan.y = my - f * (my - State.pan.y);
      State.zoom = newZoom;
      this.applyTransform();
    },

    /** [WO 20261001-mobilefast] 2손가락 핀치 줌+팬을 "한 번에" 정확히 계산하는 순수 함수(테스트 가능,
     *  DOM 비의존). prevMid/curMid 는 client 좌표. 직전 프레임 중점이 가리키던 도면좌표가, 이번
     *  프레임 중점(화면 위치)에 그대로 유지되도록 pan 을 역산한다 — 기존 구현(zoomBy 로 중점을
     *  맞춘 뒤 중점 이동분만큼 pan 을 추가로 더하는 2단계 합성)은 ratio≠1(줌과 팬이 동시에 일어나는
     *  매 프레임)일 때 (curMid-prevMid)*(1-ratio) 만큼 드리프트가 났다(대수적으로 유도·검증).
     *  zoom 은 [MIN_ZOOM,MAX_ZOOM] 으로 클램프하고, pan 산식은 "실제로 적용된" actualRatio 를
     *  써서 경계에서도(배율이 더 안 늘어도) 드리프트 없이 일관된 중점 고정을 유지한다. */
    pinchTransform(pan, zoom, rectLeft, rectTop, prevMidX, prevMidY, curMidX, curMidY, distRatio) {
      const r = (distRatio && isFinite(distRatio) && distRatio > 0) ? distRatio : 1;
      const rawZoom = zoom * r;
      const newZoom = Math.max(this.MIN_ZOOM, Math.min(this.MAX_ZOOM, rawZoom));
      const actualRatio = zoom > 0 ? newZoom / zoom : 1;
      const prevLocalX = prevMidX - rectLeft, prevLocalY = prevMidY - rectTop;
      const curLocalX = curMidX - rectLeft, curLocalY = curMidY - rectTop;
      return {
        zoom: newZoom,
        pan: {
          x: curLocalX - actualRatio * (prevLocalX - pan.x),
          y: curLocalY - actualRatio * (prevLocalY - pan.y)
        }
      };
    },

    /** 화면 맞춤 — 도면 전체가 뷰포트에 들어오도록.
     *  [WO 20260928-crop] 구역 경계가 활성(구역이 "새 페이지"로 열려 있음)이면
     *  원본 전체가 아니라 그 경계를 화면에 꽉 채운다(요구④). */
    fit() {
      this.cancelFly();
      if (this._cropBoundary) { this._fitBoundary(); return; }
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
      const newZoom = Math.max(0.3, Math.min(this.MAX_ZOOM, State.zoom + delta * State.zoom));
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
      // 구역 확대(ISO)는 CSS transition 이라 프레임 콜백이 없다 → 전환 종료 시각을 명시적으로 알린다.
      // 이게 없으면 재렌더가 전환 도중(140ms)에 돌아 애니메이션이 끊기고, 최종 배율도 아닌 값으로 그려진다.
      this._markAnimating(duration);
      this.applyTransform();
      this._syncIsoButtons();
      setTimeout(() => { try { tr.style.transition = ""; } catch (e) {} const _pl = document.getElementById("pins-layer"); if (_pl) _pl.classList.remove("iso-animating"); }, duration + 40);
      return z;
    }
  };

  /* ══════════════════════════════════════════
     UI UTILITIES
  ══════════════════════════════════════════ */