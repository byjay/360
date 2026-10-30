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
    // [재현 R4, WO 20261019-pinscale4 회귀수정] 고정 MIN_ZOOM(0.2)이 큰 PDF(ga.pdf fitZoom≈0.125)
    // 보다 커서, 화면맞춤 상태에서 [축소]를 누르면 오히려 0.2 로 확대되는 역행이 났다(실측
    // tests/p172-pin-screen-px-cdp.mjs). fitZoom 기반으로 하한을 낮춰 맞춤보다 항상 더 축소할
    // 여지를 둔다 — zoomBy/pinchTransform/handleWheel 공유 SoT(§G-2-5 단일 진입점).

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
     *  단일 진입점: PDF.setDeckCrop() 이 호출한다(§G-2-5 공유 지점 한 곳).
     *  [WO 20261016-pinscale] scaleRef(0~1, 원본 도면 폭 대비 이 페이지 폭 비율) — 벡터 복사 구역
     *  (src_crop, crop 창과 달리 clip 경계가 없는 "복사본 1페이지 전체"도 포함)에서 핀 크기를
     *  원본 대비 같은 크기로 보정하려고 pinScreenScale() 이 쓴다. 생략/무효면 1(보정 없음). */
    setCropBoundary(crop, scaleRef) {
      this._pinScaleRef = (typeof scaleRef === "number" && scaleRef > 0 && scaleRef <= 1) ? scaleRef : 1;
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
      // [WO 20261016-pinscale §2] 360 동선 선 두께·화살표도 핀과 같은 정책(도면과 비례 + 바닥).
      try { if (typeof Routes !== "undefined" && Routes.updateLineScale) Routes.updateLineScale(); } catch (e) {}
      // [WO 20261016-pinscale §2] PDF 주석(펜·사각형) 선 두께도 동일 정책 적용.
      try { if (typeof PdfAnno !== "undefined" && PdfAnno.updateLineScale) PdfAnno.updateLineScale(); } catch (e) {}
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
    /** [마스터 2026-10-16] 핀 크기 정책 전면 교체 — "부분 역보정"(1/zoom 의 지수 0.6승, 2026-08-31
     *  절충안)을 폐기하고 "도면과 완전 비례 + 최소 크기 보장 + 최대 크기 상한"으로 바꾼다.
     *   · 핀은 도면에 인쇄된 것처럼 줌과 함께 커지고 작아진다: 화면 배율 ∝ zoom(지수 1, 부분보정 없음).
     *   · 너무 축소돼 안 보이거나 못 누를 때만 "최소 화면 px"에서 멈춘다(바닥).
     *   · [WO 20261016-pinscale2, 마스터 "핀이 너무 커지는 거 아니니"] 과도줌으로 도면을 가리는 것을
     *     막으려 "최대 화면 px"(PIN_MAX_PX)에서도 멈춘다(상한) — 2026-08-31 PIN_MAX_SCALE 4.5 폐기
     *     때 없앤 상한을 절대 px 기준으로 재도입.
     *   · 기준 배율(PIN_SCALE)을 2 → 0.75 로 낮춤: zoom=1 화면 높이가 기존 80px → 약 30px(40×0.75).
     *     PinSizePrefs.DEFAULT 도 동일(슬라이더는 이 기준값만 조절, 바닥·상한은 그대로 둘러쌈).
     *   · 원본 도면과 "구역"(벡터 복사 구역의 src_crop·crop 창 둘 다)에서 같은 배율이 되려면, 구역이
     *     원본의 일부만 담아 "확대해 그린" 몫을 되돌려야 한다 — setCropBoundary(crop, scaleRef) 로
     *     받은 _pinScaleRef(원본 폭 대비 이 구역 폭 비율, src_crop.w/100)를 zoom 에 곱한다.
     *   · ISO/평면 두 경로 + 리더선(11_UI.js refreshLeaders)·360 동선(63_RouteDraw)이 모두 이 함수
     *     하나(또는 같은 바닥·상한·보정 로직)를 공유 → 상수만 바꾸면 전체 반영(§G-2-5).
     *   · 상한을 적용해도 translate(앵커 좌표)는 그대로 — CSS 변수(--pin-scale)만 바뀌고 마커의
     *     위치(픽셀 anchor)는 별도 로직(도면 좌표→화면 변환)이라 scale 상한과 무관(§4 유지 확인).
     *
     *  [WO 20261019-pinscale3, 마스터 "핀이, 포인트가 너무 크기가 작아서 안 보여. 전체 비율을 봐"]
     *  근본원인: 기준이 "zoom=1"(임의의 절대 배율)이었다 — 실제 도면은 화면 맞춤(fit) 상태에서
     *  zoom≈0.16 인 경우가 흔해(큰 PDF), raw=0.75×0.16×40≈4.8px 가 바닥(14px)에 깔려 거의 안 보였다.
     *  채택: 분모를 "zoom=1" 에서 "화면 맞춤 배율"(computeFitZoom, fit()·_fitBoundary() 와 동일 공식,
     *  §G-2-5 단일 진입점)로 바꾼다 — effZoom = (zoom/fitZoom) × scaleRef. fitZoom 에서 PIN_SCALE(0.75,
     *  =30px) 그대로 나오므로 "맞춤 상태에서 약 30px"이 보장된다. fitZoom 을 모르면(로드 전·구역
     *  경계도 미확정·테스트 환경처럼 viewport/content 크기가 없음) 1 로 폴백 — 종전 zoom 직접 기준과
     *  동일해 회귀 0(테스트 하니스는 DOM 셸만 있어 전부 이 폴백 경로를 탄다, tests/p159 참조).
     *  판단(구역 scaleRef 중복보정 제거, pinScreenScale/lineScreenScale 안 주석 참조): 구역 "경계"
     *  (크롭 보기, _cropBoundary)는 fitZoom 자체가 이미 computeCoverZoom 으로 그 경계의 확대비를
     *  반영하므로, scaleRef 를 또 곱하면 이중보정이 된다(핀이 비정상적으로 작아짐 — tests/p159 ⑥,
     *  nofit 뮤테이션이 증명). 경계 없는 "벡터 복사" 구역(crop=null, scaleRef<1)은 fitZoom 계산이
     *  (아직) 그 구역 자신의 렌더 캔버스 크기를 보지 못하는 경로라 scaleRef 를 그대로 유지한다. */
    PIN_SCALE: 0.75,           // 맞춤(fitZoom) 기준 배율 — 30px(40×0.75). PinSizePrefs.DEFAULT 와 동일
    PIN_SCALE_TOUCH: 0.8,      // [WO 20261019-pinscale3] 터치 기기 맞춤 기준 — 32px(40×0.8, 마우스보다 살짝 큼)
    PIN_NATIVE_PX: 40,         // .pin-marker-teardrop .pin-pin svg 세로(style.css ~4791) — px 환산 기준
    FIT_PAD: 0.92,             // [WO 20261019-pinscale3] fit() 여백과 동일(SoT) — computeFitZoom 공유
    /** [WO 20261019-pinscale4, 마스터 "너무 줌 아웃 했을 때는 핀 머리가 너무 크게 보이지 않게"]
     *  [재현] 99dbf1b: 바닥 20/24px 가 맞춤(30px)보다 더 축소해도 버텨, 도면은 계속 작아지는데
     *  핀 머리만 상대적으로 커져 겹쳐 보였다. 채택: 바닥을 "점"(8~10px) 수준까지 낮춰 맞춤 아래
     *  구간도 계속 비례 축소되게 한다 — 탭 영역은 ::after 역스케일(style.css .pin-marker::after)로
     *  별도 보장하므로 이 바닥은 더 이상 "최소 탭 크기"가 아니라 "최소 가시 크기"다.
     *  터치를 마우스보다 살짝(20%, 종전과 같은 비율) 크게 유지(10 vs 8). */
    PIN_MIN_PX_TOUCH: 10,      // [WO 20261019-pinscale4] 점 바닥(24→10)
    PIN_MIN_PX_MOUSE: 8,       // [WO 20261019-pinscale4] 점 바닥(20→8) — 마스터 예시값 그대로
    PIN_MAX_PX: 56,            // [WO 20261019-pinscale3] 화면 최대 핀 높이(px, 48→56) — 과도줌 가림 방지 상한
    /** [WO 20261019-pinscale4] 핀 번호 "자동" 옵션 — 화면 핀 높이가 이 밑이면 숫자를 숨기고
     *  머리(색 점)만 남긴다(_applyPinBillboard 가 매 줌마다 #pins-layer.pin-num-off 로 토글,
     *  CSS #pins-layer.pin-num-off .pin-num-text{display:none} 가 실제 숨김 — 11_UI.js 참조). */
    LABEL_HIDE_PX: 16,
    _pinScaleRef: 1,           // 구역 보정(0~1) — setCropBoundary(crop, scaleRef) 단일 진입점이 설정
    _pinIsoPrev: null,         // [성능] flat↔ISO 전환 감지용(전환 시 1회만 인라인 정리)
    /** 터치 환경 판정(공유 패턴 — 19_PinGrid.js:10 / 20_App.js:11 / 48_GPS.js:18 과 동일). */
    _coarsePointer() {
      try { return !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches); } catch (e) { return false; }
    },
    /** [WO 20261019-pinscale3] 핀/선 기준 배율의 SoT — "화면 맞춤"(F 버튼·fit()) 과 똑같은 배율.
     *  구역 경계(크롭 보기) 활성이면 그 경계를 덮는 최소 배율(computeCoverZoom) — _enforceBoundary 가
     *  매 applyTransform 마다 캐시해 둔 _boundaryFitZoom 을 우선 쓰고(최신), 없으면(아직 한 번도
     *  적용 안 됨) 그 자리에서 즉시 재계산한다. 경계가 없으면 도면 전체를 뷰포트에 맞추는 배율
     *  (fit() 과 동일, FIT_PAD 포함). 캐시를 따로 두지 않고 viewport/offsetWidth 를 그때그때 읽으므로
     *  로드·리사이즈·구역전환 후 별도 이벤트 리스너 없이 항상 최신값이다. 크기를 아직 모르면
     *  (로드 전·테스트 환경) null. */
    computeFitZoom() {
      const vw = this.viewport && this.viewport.clientWidth;
      const vh = this.viewport && this.viewport.clientHeight;
      if (!vw || !vh) return null;
      if (this._cropBoundary) {
        if (this._boundaryFitZoom > 0) return this._boundaryFitZoom;
        const cw = this.transform && this.transform.offsetWidth, ch = this.transform && this.transform.offsetHeight;
        const z = this.computeCoverZoom(this._cropBoundary, vw, vh, cw, ch);
        return (z > 0) ? z : null;
      }
      const size = this._contentSize();
      if (!size || !(size.w > 0) || !(size.h > 0)) return null;
      const z = Math.min(vw / size.w, vh / size.h) * this.FIT_PAD;
      return (z > 0) ? z : null;
    },
    /** [재현 R4] 줌 하한 SoT — 고정 MIN_ZOOM(0.2)과 "화면맞춤의 1/4" 중 더 작은 값. fitZoom 을
     *  모르면(로드 전·테스트) 고정값 그대로(회귀 0). zoomBy/pinchTransform/handleWheel 공유. */
    minZoom() {
      const fitZoom = this.computeFitZoom();
      return (fitZoom > 0) ? Math.min(this.MIN_ZOOM, fitZoom * 0.25) : this.MIN_ZOOM;
    },
    /** [WO 20261019-pinpx] 상위 transform 상쇄의 SoT — #map-transform 은 `scale(State.zoom)` 이고
     *  #pins-layer·#routes-svg·#anno-svg·#leader-layer·#zones-layer 는 전부 그 자손이라, 자손에 준 로컬
     *  크기에는 이 값이 한 번 더 곱해져 화면에 나온다. "화면 px" 로 정한 크기를 로컬 단위로 바꿀 때는
     *  반드시 이 함수로 나눈다(핀·풍선·리더선·ISO 빌보드·탭 패드·동선·주석·구역 라벨 공용).
     *  [재현] ae36a91: pinScreenScale() 이 화면 배율을 그대로 --pin-scale 로 넣어 화면 px =
     *  zoom × scale × 40 — 큰 PDF(ga.pdf, fitZoom 0.125) 맞춤 3.76px(사양 30px), tests/p172 CDP 실측. */
    parentScale() {
      const z = State.zoom;
      return (z > 0) ? z : 1;
    },
    /** 화면 맞춤(fitZoom) 대비 현재 줌 × 구역 보정 — 핀·선 공용 기준(위 헤더 주석 판단 근거). */
    _fitRelZoom() {
      const zoom = State.zoom || 1;
      const fitZoom = this.computeFitZoom() || 1; // 모르면 종전처럼 zoom 을 그대로 기준으로(회귀 0)
      // 경계(구역 창)는 fitZoom 이 이미 확대비를 반영 → scaleRef 중복보정 제거(위 헤더 주석 판단 근거).
      const scaleRef = this._cropBoundary ? 1 : (this._pinScaleRef || 1);
      return (zoom / fitZoom) * scaleRef;
    },
    /** 핀 머리의 "실제 화면 px"(상위 transform 포함) — 맞춤 30px(터치 32) · 비례 · 하한 8/10 · 상한 56. */
    pinScreenPx() {
      const touch = this._coarsePointer();
      const prefBase = (typeof PinSizePrefs !== "undefined" && PinSizePrefs.scale) ? PinSizePrefs.scale() : this.PIN_SCALE;
      // 터치는 사용자 설정값 대비 PIN_SCALE_TOUCH/PIN_SCALE(기본 32/30)배 — 설정을 올리거나 내려도 비율 유지.
      const base = touch ? prefBase * (this.PIN_SCALE_TOUCH / this.PIN_SCALE) : prefBase;
      const raw = base * this.PIN_NATIVE_PX * this._fitRelZoom();
      const minPx = touch ? this.PIN_MIN_PX_TOUCH : this.PIN_MIN_PX_MOUSE;
      const px = Math.max(raw, minPx);        // 하한(점)
      return Math.min(px, this.PIN_MAX_PX);   // 상한
    },
    /** --pin-scale 로 쓰는 "로컬" 배율 — 화면 px 를 상위 scale(zoom) 로 상쇄한 값. */
    pinScreenScale() {
      return this.pinScreenPx() / this.PIN_NATIVE_PX / this.parentScale();
    },
    /** [WO 20261022-pindots, 마스터 "핀 크기가 너무 커서 도면을 다 가린다. 방식을 다른 방식으로"]
     *  [재현] 라이브(scan.seastar.work main.js?v=ac4c31536c) PIN_MIN_PX_TOUCH/MOUSE 20~24px 바닥 +
     *  화면고정 px 방식이 "핀 밀도"(핀 간 거리)를 전혀 보지 않아, 촘촘한 도면에서 핀 머리끼리 겹쳐
     *  도면을 덮는다 — 5번째 반복된 "크기 숫자만 바꾸는" 미세조정은 근본 해결이 아니었다.
     *  채택: 기본 마커를 "점"(dot)으로 바꾸고, 지름을 화면상 최근접 이웃 핀 거리(d)에 비례(0.8×d)
     *  시켜 핀끼리 항상 겹치지 않게 한다(아래 증명). 선택/호버/방금 배치한 핀만(.focused/.drop/:hover)
     *  기존 물방울(teardrop) 머리로 전환 — DOM·색상·번호·tier 로직은 그대로(SoT 불변), CSS 가시성
     *  토글만 담당(style.css #pins-layer:not(.iso-mode) .pin-dot/.pin-pin, §G-2-5 단일 진입점).
     *  ISO(3D) 뷰는 이 WO 범위 밖 — 기존처럼 항상 teardrop(회귀 0, iso-mode 스코프 밖).
     *
     *  [겹침 방지 증명] 점 i 의 지름 = clamp(0.8×nearest_i, MIN, MAX). 임의의 두 점 i,j 사이 거리
     *  d_ij 에 대해 nearest_i ≤ d_ij, nearest_j ≤ d_ij(정의상 최근접 거리가 d_ij 보다 클 수 없음) →
     *  반지름 합 = 0.4×nearest_i + 0.4×nearest_j ≤ 0.4×d_ij + 0.4×d_ij = 0.8×d_ij ≤ d_ij. 바닥(MIN)
     *  클램프로 올려질 때만(극단적 밀집) 겹칠 수 있다 — 그 경우도 가시 최소 크기(점)는 유지하고
     *  탭 영역은 아래 PIN_DOT_HIT_MIN_PX 로 별도 보장한다(발주 §4, 시각 크기와 탭 판정 분리). */
    PIN_DOT_RATIO: 0.8,
    PIN_DOT_MIN_PX: 6,
    PIN_DOT_MAX_PX: 28,
    PIN_DOT_NUM_MIN_PX: 16,   // 점 지름이 이 이상이어야 원 안에 번호(마커에 dot-show-num 클래스)
    PIN_DOT_HIT_MIN_PX: 24,   // 탭 히트영역(::after 패드) 최소 — 시각 크기와 분리
    /** 현재 #pins-layer 의 핀 마커들을 화면(screen) 좌표 px 로 — 밀도 계산 입력.
     *  좌표계: 콘텐츠(도면) CSS 크기 × zoom(= 화면 px, parentScale() 과 동일 스케일). 아직 레이아웃을
     *  모르면(로드 전) null(호출부가 건너뜀 → 기존 기본값 유지, 회귀 0). */
    _pinScreenPoints(layer) {
      const cw = this.transform && this.transform.offsetWidth;
      const ch = this.transform && this.transform.offsetHeight;
      const zoom = State.zoom || 1;
      if (!(cw > 0) || !(ch > 0)) return null;
      const pts = [];
      for (const m of layer.children) {
        if (!m.classList || !m.classList.contains("pin-marker")) continue;
        const xPct = parseFloat(m.style.left), yPct = parseFloat(m.style.top);
        if (!Number.isFinite(xPct) || !Number.isFinite(yPct)) continue;
        pts.push({ id: m.dataset.id, x: (xPct / 100) * cw * zoom, y: (yPct / 100) * ch * zoom, el: m });
      }
      return pts;
    },
    /** [WO 20261022-singleattach R3, 재현: 점 마커 탭 히트영역(PIN_DOT_HIT_MIN_PX 패드)이 겹치면
     *  브라우저는 DOM 적층(topmost — 보통 나중에 그려진 핀) 하나만 click 타깃으로 주고, 그게
     *  탭 좌표에서 더 먼 핀일 수 있다. 후보들(각 {id,cx,cy} — 실제 화면 중심) 중 (x,y)에 화면
     *  거리가 가장 가까운 id를 고르는 순수 함수(SoT) — 11_UI.js._resolveTapPin 이 elementsFromPoint
     *  로 모은 후보를 넘겨 호출한다. 후보 0개면 null. */
    nearestByRect(candidates, x, y) {
      if (!Array.isArray(candidates) || !candidates.length) return null;
      let bestId = null, bestD = Infinity;
      for (const c of candidates) {
        const d = Math.hypot(c.cx - x, c.cy - y);
        if (d < bestD) { bestD = d; bestId = c.id; }
      }
      return bestId;
    },
    /** [WO 20261022-pinprefs] 설정 슬라이더(PinSizePrefs) 대비 배율 — 기본값(DEFAULT)에서 1,
     *  슬라이더를 올리면 >1·내리면 <1. teardrop(선택/호버)은 이미 pinScreenPx()(§472)가
     *  PinSizePrefs.scale() 을 직접 쓴다 — 점(dot) 지름에도 같은 배율을 입히는 SoT. 미로드
     *  (테스트 셸 등)·DEFAULT=0 이면 1(회귀 0). */
    _pinSizeFactor() {
      try {
        if (typeof PinSizePrefs !== "undefined" && PinSizePrefs.get && PinSizePrefs.DEFAULT) {
          return PinSizePrefs.get() / PinSizePrefs.DEFAULT;
        }
      } catch (e) {}
      return 1;
    },
    /** "항상 보이기" 라벨 모드면 번호가 들어갈 최소 지름(numMinPx, 설정 배율 반영)까지 diam을
     *  끌어올린다. 이 상향은 극단적 밀집에서만 겹침 방지(§497)를 깨뜨릴 수 있음(사용자가 명시로
     *  "항상 보이기"를 선택한 결과로 허용 — 발주 §2 근거, tests/p179 실측). 크기 슬라이더
     *  (PinSizePrefs)는 여기서 곱하지 않는다 — _computePinDotPx 가 클램프의 상/하한 자체
     *  (PIN_DOT_MIN/MAX_PX)를 배율만큼 넓혀서 적용한다(겹침 방지 비율 0.8×d는 그대로 유지,
     *  아래 주석 — "슬라이더로 커진 핀이 보통 밀집에서도 서로 겹친다" 회귀 실측 후 교정). */
    _applyLabelAlwaysBump(diam, labelMode, numMinPx) {
      return (labelMode === "always") ? Math.max(diam, numMinPx) : diam;
    },
    /** 격자 버킷 최근접 이웃(O(n) 평균, 수천 개에서도 n² 회피) — 점 i 의 "화면 지름"(px) 맵 반환.
     *  cell 크기는 전체 분포의 평균 밀도로 추정(국소 밀집·희소가 섞여도, 링 확장 탐색이 안전망이라
     *  추정이 어긋나도 정확도는 유지되고 속도만 영향). 외딴 점(이웃 없음)은 PIN_DOT_MAX_PX.
     *  [WO 20261022-pinprefs] PinSizePrefs 슬라이더(factor)는 클램프의 상/하한(PIN_DOT_MIN/MAX_PX)
     *  "자체"를 넓히지, 비율 계산(RATIO×nearest)의 결과를 사후에 곱하지 않는다 — 사후 곱(옛 구현)은
     *  이미 안전한(0.8×d ≤ d) 중간 구간 점까지 통째로 키워 factor>1.25 에서 보통 밀집(20px 간격)
     *  구역조차 겹치는 회귀를 냈다(tests/p179 실측 90쌍). this.PIN_DOT_MIN/MAX_PX 를 호출 동안만
     *  배율값으로 바꿔두면(동기 실행, 재진입 없음) 기존 클램프 리터럴(아래 diam 식)을 그대로 두고도
     *  "경계(MAX)에 닿은 희소 점만 커지고, 중간 구간(RATIO 지배)은 factor 와 무관하게 안전"을
     *  보장한다(MAX 경계 쪽은 §497 증명과 같은 비율로 안전 — nearest ≥ MAX×factor/RATIO 일 때만
     *  닿으므로 radius/d ≤ RATIO/2 로 동일). MIN 경계(초밀집) 쪽만 사용자가 더 키우면 겹칠 수
     *  있음(발주 §1 "슬라이더 최대 구간에서만 허용" 그대로) — tests/p179 "[보고]" 라인 참조.
     *  tests/p177 뮤테이션 needle(클램프 리터럴)은 그대로 보존(G-4⑧). */
    _computePinDotPx(points) {
      const diamMap = new Map();
      const n = points.length;
      if (n === 0) return diamMap;
      const factor = this._pinSizeFactor();
      const labelMode = (typeof PinLabelPrefs !== "undefined" && PinLabelPrefs.get) ? PinLabelPrefs.get() : "auto";
      const numMinPx = this.PIN_DOT_NUM_MIN_PX * factor;
      const origMinPx = this.PIN_DOT_MIN_PX, origMaxPx = this.PIN_DOT_MAX_PX;
      this.PIN_DOT_MIN_PX = origMinPx * factor;
      this.PIN_DOT_MAX_PX = origMaxPx * factor;
      try {
        return this._computePinDotPxScaled(points, n, labelMode, numMinPx);
      } finally {
        this.PIN_DOT_MIN_PX = origMinPx;
        this.PIN_DOT_MAX_PX = origMaxPx;
      }
    },
    _computePinDotPxScaled(points, n, labelMode, numMinPx) {
      const diamMap = new Map();
      if (n === 1) { diamMap.set(points[0].id, this._applyLabelAlwaysBump(this.PIN_DOT_MAX_PX, labelMode, numMinPx)); return diamMap; }
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of points) {
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
      }
      const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
      let cell = Math.sqrt((w * h) / n);
      if (!(cell > 0)) cell = 32;
      const colOf = (p) => Math.floor((p.x - minX) / cell);
      const rowOf = (p) => Math.floor((p.y - minY) / cell);
      const grid = new Map();
      points.forEach((p, i) => {
        const k = colOf(p) + "_" + rowOf(p);
        let bucket = grid.get(k);
        if (!bucket) { bucket = []; grid.set(k, bucket); }
        bucket.push(i);
      });
      const MAX_RING = 8;
      points.forEach((p, i) => {
        const cx = colOf(p), cy = rowOf(p);
        let best = Infinity, ring = 1;
        while (ring <= MAX_RING) {
          best = Infinity;
          for (let gx = cx - ring; gx <= cx + ring; gx++) {
            for (let gy = cy - ring; gy <= cy + ring; gy++) {
              const bucket = grid.get(gx + "_" + gy);
              if (!bucket) continue;
              for (const j of bucket) {
                if (j === i) continue;
                const dx = points[j].x - p.x, dy = points[j].y - p.y;
                const d = Math.hypot(dx, dy);
                if (d < best) best = d;
              }
            }
          }
          // 안전 종료: 쿼리점이 자기 셀 "가장자리"에 있는 최악의 경우에도, 이미 스캔한 범위
          // 밖(ring+1)에 best 보다 더 가까운 점이 없음을 보장하려면 (ring-1)*cell 이하여야 한다
          // (ring*cell 로는 한 셀 덜 보고 멈춰 실제보다 먼 "최근접"을 확정해 지름이 과대해질 수
          // 있었다 — tests/p177 겹침 1쌍 실측으로 발견, (ring-1) 로 교정 후 0쌍).
          if ((ring > 1 && best <= (ring - 1) * cell) || ring === MAX_RING) break;
          ring++;
        }
        const diam = (best === Infinity)
          ? this.PIN_DOT_MAX_PX
          : Math.min(this.PIN_DOT_MAX_PX, Math.max(this.PIN_DOT_MIN_PX, best * this.PIN_DOT_RATIO));
        diamMap.set(p.id, this._applyLabelAlwaysBump(diam, labelMode, numMinPx));
      });
      return diamMap;
    },
    /** 매 줌/팬/핀 변경마다 — 점 지름(--dot-local-px)·탭패드(--dot-pad-local-px)·번호표시
     *  (dot-show-num 클래스)를 마커별로 갱신한다. 요청 프레임 1회로 묶음(_dotRaf) — 핀치/줌 중
     *  연타해도 실제 계산은 프레임당 1번. "로컬" 단위 환산 = 화면 px ÷ (상위 scale 전체).
     *  상위 scale 전체(zoom × --pin-scale) = pinScreenPx()/PIN_NATIVE_PX(§460 parentScale 주석 참조,
     *  zoom 이 상쇄되어 상수) — 그 역수를 곱해 "화면 px 그대로"가 되는 로컬 크기를 구한다. */
    _applyPinDotSizes(layer) {
      if (this._dotRaf) return;
      this._dotRaf = (typeof requestAnimationFrame === "function") ? requestAnimationFrame(() => {
        this._dotRaf = null;
        this._applyPinDotSizesNow(document.getElementById("pins-layer"));
      }) : (this._applyPinDotSizesNow(layer), null);
    },
    _applyPinDotSizesNow(layer) {
      if (!layer) return;
      const points = this._pinScreenPoints(layer);
      if (!points) return; // 레이아웃 미확정(로드 전·테스트 셸) — CSS 기본값(폴백) 유지
      const diamMap = this._computePinDotPx(points);
      const screenPx = this.pinScreenPx();
      const factor = screenPx > 0 ? (this.PIN_NATIVE_PX / screenPx) : 1; // 화면px → 로컬px 환산
      // [WO 20261022-pinprefs] 번호 표시 옵션(PinLabelPrefs) — "always"/"hidden" 은 지름과 무관하게
      // 강제, "auto"(기본)는 현재 규칙(지름 ≥ numMinPx, 설정 배율 반영)을 유지(§460 PinSizePrefs 주석).
      const labelMode = (typeof PinLabelPrefs !== "undefined" && PinLabelPrefs.get) ? PinLabelPrefs.get() : "auto";
      const numMinPx = this.PIN_DOT_NUM_MIN_PX * this._pinSizeFactor();
      const canSetProp = (st) => st && typeof st.setProperty === "function";
      for (const p of points) {
        const diam = diamMap.get(p.id) || this.PIN_DOT_MIN_PX;
        const padDiam = Math.max(diam, this.PIN_DOT_HIT_MIN_PX);
        const localPx = (diam * factor).toFixed(2) + "px";
        const localPadPx = (padDiam * factor).toFixed(2) + "px";
        // [테스트 셸] style 이 plain object(setProperty 無)인 경량 DOM 모의(p133 등) 대비 — 값은
        // 그대로 보존(후속 읽기 가능), 실제 CSS 반영은 없음(해당 하니스는 시각 렌더 자체를 안 봄).
        if (canSetProp(p.el.style)) {
          p.el.style.setProperty("--dot-local-px", localPx);
          p.el.style.setProperty("--dot-pad-local-px", localPadPx);
        } else if (p.el.style) {
          p.el.style["--dot-local-px"] = localPx;
          p.el.style["--dot-pad-local-px"] = localPadPx;
        }
        const showNum = labelMode === "hidden" ? false : labelMode === "always" ? true : (diam >= numMinPx);
        if (p.el.classList) p.el.classList.toggle("dot-show-num", showNum);
      }
    },
    /** [WO 20261016-pinscale §2, pinscale2 / 20261019-pinscale3] 선(360 동선·주석) 공용 — 핀과 같은
     *  기준(zoom/fitZoom × 구역 scaleRef, 경계면 scaleRef 중복보정 제거)에 LINE_FIT_RATIO 를 곱해
     *  "맞춤 상태에서 기준선(route-line 3px)이 약 1.5px"가 되게 한다(마스터 "전체 비율을 봐" — 핀과
     *  같은 분모를 쓰되 선은 핀보다 더 얇게 시작). 바닥은 절대 px 가 아니라 "비율"로 둔다(선 종류마다
     *  기준 두께가 달라 픽셀 바닥 하나로 못 묶는다 — 판단: 지금 모양의 40% 밑으로는 안 가늘어지게).
     *  상한(LINE_MAX_RATIO=1)은 원본 css 두께(effZoom=2, 맞춤의 2배 확대에서 도달) — "최대 3px".
     *  lineScreenRatio = 화면 기준 비율(css 두께 대비). */
    LINE_FIT_RATIO: 0.5,
    LINE_MAX_RATIO: 1,
    lineScreenRatio(minRatio) {
      const effZoom = this._fitRelZoom() * this.LINE_FIT_RATIO;
      const floor = (typeof minRatio === "number" && minRatio > 0) ? minRatio : 0.4;
      return Math.min(Math.max(effZoom, floor), this.LINE_MAX_RATIO);
    },
    /** [WO 20261019-pinpx] SVG 사용자 단위 1 이 transform 안에서 차지하는 로컬 CSS px(viewBox→박스, 기하평균 —
     *  preserveAspectRatio=none 이라 축마다 다르다). 크기를 모르면(테스트 셸·미표시) 1. */
    svgUnitPx(svg) {
      const vb = svg && svg.viewBox && svg.viewBox.baseVal;
      const w = svg && svg.clientWidth, h = svg && svg.clientHeight;
      if (!vb || !(vb.width > 0) || !(vb.height > 0) || !(w > 0) || !(h > 0)) return 1;
      return Math.sqrt((w / vb.width) * (h / vb.height));
    },
    /** --route-scale/--anno-scale 로 쓰는 배율 — css 두께(SVG 사용자 단위)에 곱하면 화면 두께가
     *  css 두께 × lineScreenRatio 가 되도록 viewBox 배율과 상위 scale(zoom)을 상쇄한다. */
    lineScreenScale(minRatio, svg) {
      return this.lineScreenRatio(minRatio) / this.parentScale() / this.svgUnitPx(svg);
    },
    _applyPinBillboard() {
      const layer = document.getElementById("pins-layer");
      if (!layer) return;
      // [WO 20261023-pinviewopt §1] 핀 모양 강제(자동/핀/점) — PinShapePrefs(23c_PinSizePrefs.js) SoT.
      // style.css #pins-layer.shape-pin/.shape-dot 규칙(§G-2-5 단일 진입점, 이 토글 한 곳만)이
      // teardrop↔dot CSS 표시를 덮어쓴다. auto(기본, 클래스 둘 다 없음)는 종전 규칙 그대로.
      if (layer.classList) {
        const shapeMode = (typeof PinShapePrefs !== "undefined" && PinShapePrefs.get) ? PinShapePrefs.get() : "auto";
        layer.classList.toggle("shape-pin", shapeMode === "pin");
        layer.classList.toggle("shape-dot", shapeMode === "dot");
      }
      const inv = this.pinScreenScale();
      // [성능] 핀치/줌 중 매 프레임 재계산 — 마커 전체를 순회해 인라인 transform 을 다시 쓰지 않는다.
      // CSS 변수 하나(--pin-scale)만 갱신하면 평면 마커·리더 풍선은 정적 스타일시트 규칙
      // (style.css #pins-layer .pin-marker / .pin-leader-bubble)이 알아서 반영한다(O(1)).
      const px = this.pinScreenPx(); // 실제 화면 px(상위 scale 포함) — 번호 숨김·탭 패드 판정 기준
      if (layer.style && typeof layer.style.setProperty === "function") {
        layer.style.setProperty("--pin-scale", inv.toFixed(4));
        // [WO 20261019-pinpx] 탭 패드(.pin-marker::after 44px)는 마커(--pin-scale)·상위 scale(zoom) 둘 다 상쇄해야
        // 화면 44px — 그 곱 = px/PIN_NATIVE_PX 를 따로 넘긴다(style.css .pin-marker::after).
        layer.style.setProperty("--pin-screen-k", (px / this.PIN_NATIVE_PX).toFixed(4));
        // [WO 20261030-pinopacity] 핀 투명도 — PinOpacityPrefs(23c_PinSizePrefs.js) SoT.
        // style.css .pin-marker/.pin-leader-bubble 가 이 변수로 opacity 적용(선택/호버/드래그 중은
        // CSS 예외 규칙이 1 로 강제 — §G-2-5 단일 진입점).
        const op = (typeof PinOpacityPrefs !== "undefined" && PinOpacityPrefs.get) ? PinOpacityPrefs.get() : 1;
        layer.style.setProperty("--pin-opacity", op.toFixed(2));
      }
      // [WO 20261019-pinscale4] 핀 번호 표시 — PinLabelPrefs(23c_PinSizePrefs.js) 옵션 SoT.
      // always=항상 켬 / hidden=항상 끔 / auto(기본)=화면 핀 높이 < LABEL_HIDE_PX(16px) 면 끔.
      // 매 줌마다(이 함수가 호출될 때) 다시 판정 — SVG 재생성 없이 CSS 클래스 토글 1개로 즉시 반영.
      if (layer.classList) {
        const hideLabel = (typeof PinLabelPrefs !== "undefined" && PinLabelPrefs.shouldHide)
          ? PinLabelPrefs.shouldHide(px)
          : (px < this.LABEL_HIDE_PX); // PinLabelPrefs 미로드(테스트 하니스 등) → auto 폴백
        layer.classList.toggle("pin-num-off", !!hideLabel);
      }
      // [WO 20261008-pinstyle §2] 화살촉·선 굵기도 같은 inv 로(풍선과 비례 고정) — SVG 좌표라 UI 쪽에서 재계산.
      if (typeof UI !== "undefined" && UI.refreshLeaders) { try { UI.refreshLeaders(); } catch (e) {} }
      // [WO 20261001-leader] 리더 풍선(.pin-leader-bubble) — 바늘형 핀과 앵커가 다르다(중앙 vs 하단).
      // ISO 여부와 무관하게 항상 평면 중앙 역스케일만 적용(요구사항 §3) — 이제 CSS 정적 규칙이 전담.
      const ISO_Z = [-32, 58, 148, 238];
      if (State.isoView) {
        if (layer.classList) layer.classList.add("iso-mode"); // 평면용 정적 CSS 규칙 비활성화 → 아래 JS 가 전담
        this._pinIsoPrev = true;
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
          if (m.classList && m.classList.contains("pin-leader-bubble")) continue; // CSS 정적 규칙이 전담
          m.style.transformOrigin = "50% 100%";   // 바늘 끝(하단 중앙) = 땅에 박히는 지점
          m.style.transformStyle = "preserve-3d"; // 마커 내부도 3D 보존(머리가 +Z로 솟음)
          m.style.transform = billboard;
          m.style.zIndex = "20";                   // 기울인 도면 위로 핀을 띄움
        }
      } else {
        if (layer.classList) layer.classList.remove("iso-mode"); // 정적 CSS 규칙(scale(var(--pin-scale))) 활성화
        // ISO → 평면으로 막 전환된 그 1회만 이전 인라인 스타일을 지워 정적 규칙이 보이게 한다.
        // (steady-state 평면 줌/핀치 중에는 이 루프를 돌지 않음 — 그게 이번 성능 개선의 핵심.)
        if (this._pinIsoPrev) {
          for (const m of layer.children) {
            if (m.classList && m.classList.contains("pin-leader-bubble")) continue;
            m.style.transform = ""; m.style.transformOrigin = ""; m.style.transformStyle = ""; m.style.zIndex = "";
          }
        }
        this._pinIsoPrev = false;
        // [WO 20261022-pindots] 평면 모드만 — 밀도 기반 점 지름 재계산(ISO 는 범위 밖, 항상 teardrop).
        this._applyPinDotSizes(layer);
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
      const newZoom = Math.max(this.minZoom(), Math.min(this.MAX_ZOOM, State.zoom * factor));
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
      const newZoom = Math.max(this.minZoom(), Math.min(this.MAX_ZOOM, rawZoom));
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
     *  원본 전체가 아니라 그 경계를 화면에 꽉 채운다(요구④).
     *  [WO 20261019-pinscale3] z 계산을 computeFitZoom() 으로 통일(§G-2-5 단일 진입점) — pinScreenScale()
     *  이 "맞춤 상태에서 약 30px"를 보장하려면 이 함수가 실제로 쓰는 배율과 같은 값을 봐야 한다. */
    fit() {
      this.cancelFly();
      if (this._cropBoundary) { this._fitBoundary(); return; }
      const size = this._contentSize();
      if (!size) return;
      const vw = this.viewport.clientWidth;
      const vh = this.viewport.clientHeight;
      const z = this.computeFitZoom();
      if (!(z > 0)) return;
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
      const newZoom = Math.max(this.minZoom(), Math.min(this.MAX_ZOOM, State.zoom + delta * State.zoom));
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