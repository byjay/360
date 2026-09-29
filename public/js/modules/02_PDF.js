  const PDF = {
    // 로컬 번들 worker 우선(외부 CDN worker가 차단/지연될 때 PDF가 무한 로딩되는 문제 방지)
    WORKER_SRC: "/vendor/pdf.worker.min.js",
    WORKER_SRC_CDN: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js",
    ready: false,

    ensureLib() {
      return new Promise((resolve, reject) => {
        if (window.pdfjsLib) { this._configWorker(); resolve(window.pdfjsLib); return; }
        let attempts = 0;
        const check = () => {
          attempts++;
          if (window.pdfjsLib) { this._configWorker(); resolve(window.pdfjsLib); }
          else if (attempts < 50) { setTimeout(check, 100); }
          else { reject(new Error("PDF.js 라이브러리 로드 타임아웃")); }
        };
        check();
      });
    },

    useWorker: true, // 로컬 worker 사용 가능 여부 (실패 시 자동 false)

    _configWorker() {
      if (this.ready) return;
      // 로컬 번들 worker 를 사용한다(백그라운드 파싱 → 빠르고 메인스레드 안 막힘).
      // 로드 실패 시 load() 에서 disableWorker 로 자동 폴백한다.
      try { window.pdfjsLib.GlobalWorkerOptions.workerSrc = this.WORKER_SRC; }
      catch (e) { this.useWorker = false; }
      this.ready = true;
    },

    /** 타임아웃 경쟁: worker 파싱이 멈춰도(무한 로딩 방지) 일정 시간 후 폴백/실패 처리 */
    _withTimeout(promise, ms, onTimeoutCleanup) {
      return new Promise((resolve, reject) => {
        let done = false;
        const t = setTimeout(() => {
          if (done) return;
          done = true;
          try { if (onTimeoutCleanup) onTimeoutCleanup(); } catch (e) {}
          reject(new Error("__PDF_TIMEOUT__"));
        }, ms);
        promise.then(
          v => { if (done) return; done = true; clearTimeout(t); resolve(v); },
          e => { if (done) return; done = true; clearTimeout(t); reject(e); }
        );
      });
    },

    async load(arrayBuffer) {
      const lib = await this.ensureLib();
      // 1차: worker 로 파싱 시도하되 2.5초 내 응답 없으면 즉시 메인스레드로 폴백.
      //      (일부 환경에서 worker 가 응답 없이 멈춰 "PDF 렌더링 중..." 이 오래 떠 있는 문제 방지)
      if (this.useWorker) {
        let task = null;
        try {
          task = lib.getDocument({ data: arrayBuffer.slice(0), disableWorker: false });
          return await this._withTimeout(task.promise, 2500, () => {
            try { task && task.destroy && task.destroy(); } catch (e) {}
          });
        } catch (e) {
          // worker 가 느리거나(timeout) 실패 → 세션 내내 메인스레드 파싱 사용(다시 안 기다림)
          this.useWorker = false;
          try { task && task.destroy && task.destroy(); } catch (e2) {}
        }
      }
      // 2차: 메인스레드 파싱 (worker 없이). 20초 타임아웃으로 무한 로딩 차단.
      const task2 = lib.getDocument({ data: arrayBuffer.slice(0), disableWorker: true });
      try {
        return await this._withTimeout(task2.promise, 20000, () => {
          try { task2 && task2.destroy && task2.destroy(); } catch (e) {}
        });
      } catch (e) {
        if (e && e.message === "__PDF_TIMEOUT__") {
          throw new Error("PDF 파싱 시간 초과 — 파일이 너무 크거나 손상되었을 수 있습니다.");
        }
        throw e;
      }
    },

    /* ── 동적 고해상도 렌더링 상태 (벡터 PDF 화질 보존의 핵심) ──
       PDF 는 벡터이므로, "보이는 줌 배율"에 맞춰 그 배율로 다시 래스터화하면
       확대해도 원도면 화질이 그대로 유지된다. CSS transform: scale() 로만 키우면
       이미 그려진 비트맵을 늘리는 것이라 깨진다 → 이를 방지하기 위해
       캔버스를 줌에 비례한 해상도로 재렌더하고, CSS 는 "렌더 배율 대비 보정"만 한다. */
    _renderState: {
      pdfDoc: null, pageNum: 0, rotation: 0,
      renderScale: 0,        // 현재 캔버스가 래스터화된 PDF 스케일 (CSS 1배 기준 픽셀/포인트)
      baseCssScale: 1,       // 캔버스가 표현하는 "논리적(=화면 1배)" 크기 기준 스케일
      task: null,            // 진행 중인 render task (취소용)
      pending: null,         // 디바운스 타이머
      lastZoom: 1,           // 마지막으로 요청된 줌(= 확대가 끝난 시점의 화면 배율)
      crop: null,            // 고해상도 크롭 오버레이 캔버스
      cropTask: null,        // 진행 중인 크롭 render task
      cropScale: 0,          // 크롭 캔버스의 렌더 스케일
      // [P14] 바탕이 전면 PDF 캔버스가 아니라 "배포 스냅샷 <img>" 인 상태(뷰어/구역 재열람).
      //   이때는 전면 캔버스를 다시 그릴 수 없다(레이아웃·핀 좌표가 스냅샷 기준) →
      //   보이는 영역만 크롭 오버레이로 얹는다.
      overlayOnly: false,
      // [WO 20260917] 활성 구역(deck)의 크롭 — 0~1 비율 {x,y,w,h}. 설정돼 있으면
      // renderCrop 은 "현재 보이는 영역" 대신 이 영역을 렌더 대상으로 고정한다.
      deckCrop: null
    },

    /* ── 캔버스 해상도 상한 (근거를 남긴다 · 매직넘버 금지) ────────────────────
       [근본원인 2026-09-03] 상한이 전 기기 공통 16.7M px 였다. A1 도면(≈2384×1684pt)은
       면적 상한만으로 렌더 스케일이 √(16.7M / 4.01M) ≈ 2.04 로 잘린다. 그런데 retina(dpr 2)
       에서는 첫 렌더가 이미 1.5×2 = 3.0 → 2.04 로 클램프되어 **상한에 닿은 상태로 시작**한다.
       이후 아무리 확대해도 재래스터 결과가 2.04 로 되돌아가 화질이 1도 오르지 않았고,
       (재렌더 임계 1.15 는 통과하므로) 확대할 때마다 이득 0 인 전체 재렌더만 반복했다.
       → 기기별로 상한을 나눠 "모바일=안전 / 데스크톱=선명" 을 둘 다 만족시킨다. */
    // iOS/iPadOS Safari 하드 제한: 캔버스 면적 16,777,216px(4096²) 초과 시 캔버스가 통째로 빈다.
    CANVAS_PX_MOBILE: 16777216,
    // 데스크톱: RGBA 4byte/px → 40M px ≈ 160MB. 저사양(deviceMemory ≤ 4GB)은 모바일 상한으로 강등.
    CANVAS_PX_DESKTOP: 40000000,
    LOW_MEMORY_GB: 4,
    MAX_SIDE_HARD: 8192,       // 한 변 하드 상한
    RERENDER_GAIN: 1.15,       // 이 배율 미만의 화질 향상은 재렌더 비용 대비 이득이 없다
    SHRINK_RATIO: 2.5,         // 축소 후 이만큼 과잉 해상도면 메모리 회수용으로 다시 그린다
    SETTLE_MS: 140,            // 줌 조작이 끝났다고 보는 디바운스(애니메이션 중에는 더 미룬다)
    /* [P14] 원본 PDF 지연 로드 임계 — 스냅샷 비트맵이 화면 요구 해상도에 "얼마나" 부족해야
       네트워크로 원본을 받아올 값어치가 있는가.
       근거: RERENDER_GAIN(1.15)은 "원본이 이미 로컬에 있을 때 다시 그릴 값어치" 기준이다.
       원본 다운로드는 수 MB · 현장 모바일 회선이므로 같은 기준을 쓰면 기본 화면에서도 곧바로
       받아버린다. 배포 스냅샷은 CSS 1:1(.map-image 자연 크기)로 보도록 만들어진 것이므로
       판정 기준은 device px 가 아니라 CSS px 이고, 확실히 부족할 때(1.5배)만 받는다.
       → 1:1 스냅샷 기준 zoom > 1.5 에서 발동. 구역 확대(MapCtrl.fitZone 4~8배)는 항상 발동.
       원본을 확보한 뒤의 실제 렌더 목표 배율은 종전대로 zoom×dpr 이다(planRerender).
       🔴 [WO 20260929-lossless · 마스터 확정 "스냅샷은 미리보기, 표시 정본은 원본 PDF"] 위 1.5·CSS px 기준은
       "화면 픽셀×DPR 보다 스냅샷 픽셀이 적은" 구간(DPR2 에서 1:1~1.5배)을 흐린 채 방치했다(실측 밀도 0.50).
       → 판정을 device px(cssPx×zoom×dpr) 로 바꾸고 임계를 1(=부족해지는 순간)로 둔다. 전체 맞춤(fit) 화면은
       스냅샷(긴 변 4096px)이 여전히 충분해 다운로드 0 — 확대해서 실제로 부족해질 때만 받는다. */
    SOURCE_GAIN: 1,

    /** 마지막 snapshotAllPages 가 실제로 저장한 페이지 픽셀 크기
     *  [{ w, h, pw, ph }] — w/h = 스냅샷 비트맵 px, pw/ph = PDF 페이지 포인트.
     *  SOFT_LIMIT 강등으로 요청(maxDim)보다 낮아진 실제 값을 배포본에 정직하게 기록하기 위함. */
    lastSnapshotDims: null,

    /* [회귀수정 2026-09-28] 0c5a7b6 의 pageWeightedPxCap()/LARGE_PAGE_SHARE_COUNT 를 제거했다.
       [근본원인] 그 코드는 "페이지 크기(A1 이상)"만으로 예산을 무조건 반으로 깎았다 — 마스터
       요구(대형 도면일수록 해상도가 더 필요하다)와 정반대 방향이었고, 근거로 든 "base+crop
       두 캔버스 동시 상주"도 실제로는 renderCrop() 호출 시에만 성립(평상시 crop 캔버스는
       DOM 에 없음) 하는데 평상시에도 무조건 적용돼 A1 이 이유 없이 반토막났다.
       → 페이지 크기는 예산 산정 근거에서 제외한다(YAGNI). 대신 "지금 실제로 동시에 화면에
       떠 있는 캔버스 수" 로만 나눈다: 평상시 1장(=전체 예산 그대로) / 크롭 오버레이 렌더 중엔
       2장(=절반씩, 메모리 안전 유지). 상주 수는 각 호출부의 실제 실행 맥락에서 정해진다
       (base 캔버스 경로는 renderCrop 이전에 항상 _clearCrop 되므로 1, renderCrop() 은
       정의상 base 위에 겹쳐 그리므로 2 — 아래 각 호출부 주석 참조). */

    /** 기기별 캔버스 면적 상한 (순수 함수 — 테스트 가능) */
    canvasPxCap(env) {
      const e = env || {};
      if (e.mobile) return this.CANVAS_PX_MOBILE;
      const mem = e.deviceMemory;
      if (typeof mem === "number" && mem > 0 && mem <= this.LOW_MEMORY_GB) return this.CANVAS_PX_MOBILE;
      return this.CANVAS_PX_DESKTOP;
    },

    /** [회귀수정 2026-09-28] clampScale 에 넘길 "실제 적용 예산" 단일 진입점
     *  (공유 함수 1곳만 고치면 호출부 전체 반영). residentCanvasCount = 지금 이 호출 시점에
     *  동시 상주하는 캔버스 수(기본 1). 🔴 페이지 크기는 입력에서 제외 — 크기로 깎지 않는다. */
    effectivePxCap(env, residentCanvasCount) {
      const n = Math.max(1, residentCanvasCount || 1);
      return this.canvasPxCap(env) / n;
    },

    /* [WO 20260917-dpr] 상주 페이지 수 기준 dpr 상한 — 출처: PDF VIEW°917 pdfCore.js:331-347
       pickDpr() (MIT). 로직만 이식(단위·상수는 우리 구조에 맞게 재정의).
       [근본원인] 종전 dpr = min(devicePixelRatio, 2) 는 페이지 크기·상주 페이지 수와 무관한
       고정값이라, 화면에 실제로 뜬 페이지가 몇 장이든 같은 dpr 을 요구했다(가드 없음).
       → dpr² × 페이지당 픽셀 × 상주 페이지 수 ≤ pxCap 을 만족하는 dpr 로 자른다.
       residentPages 기본 1 — 우리 뷰어는 페이지 1장만 캔버스로 렌더하는 단일 캔버스 구조라
       "전체 페이지 수" 가 아니라 "실제로 화면에 뜬 페이지 수(=1)" 를 쓴다(이식 1 요구사항).
       [회귀수정 2026-09-28] pxCap 인자로 effectivePxCap() 결과를 넘겨받게 해 "동시 상주 캔버스
       수 나누기" 를 dpr 산정에도 동일하게 적용한다(개념 통합 — 별도 페이지수 가중을 두지 않음). */
    residentDpr(o) {
      const opt = o || {};
      const raw = Math.min(opt.devicePixelRatio || (typeof window !== "undefined" && window.devicePixelRatio) || 1, 2);
      const resident = Math.max(1, opt.residentPages || 1);
      const pageW = Math.max(1, opt.pageW || 1), pageH = Math.max(1, opt.pageH || 1);
      const perPagePx = pageW * pageH;
      const pxCap = opt.pxCap || this.CANVAS_PX_DESKTOP;
      if (!(perPagePx > 0) || !(pxCap > 0)) return raw;
      const allowed = Math.sqrt(pxCap / (perPagePx * resident));
      // 1 미만으로는 내리지 않는다(그 아래는 눈에 보이게 흐려진다 — 출처 동일 하한).
      return Math.max(1, Math.min(raw, allowed));
    },

    /** 현재 실행 환경 스냅샷 (canvasPxCap 입력) */
    _env() {
      if (typeof navigator === "undefined") return {};
      const ua = navigator.userAgent || "";
      const touch = navigator.maxTouchPoints || 0;
      return {
        // iPadOS 는 UA 가 Mac 으로 나오므로 멀티터치로 보강 판정
        mobile: /iP(hone|ad|od)|Android|Mobile/i.test(ua) || (touch > 1 && /Mac/i.test(navigator.platform || "")),
        deviceMemory: navigator.deviceMemory
      };
    },

    /** [P14] 스냅샷 비트맵이 현재 배율을 감당하는가 = 원본을 지연 로드할 때인가 (순수 함수).
     *  snapPx : 배포본에 기록된(또는 <img>.naturalWidth 로 실측한) 스냅샷 가로 픽셀
     *  cssPx  : 화면 1배(zoom=1)에서 그 스냅샷이 차지하는 CSS 가로 픽셀
     *  zoom   : 현재 CSS 확대 배율
     *  dpr    : 화면 픽셀 밀도(렌더러와 같은 상한 2 — residentDpr) · 미지정이면 1
     *  크기를 모르면(0) 받지 않는다 — 불필요한 다운로드 0 이 기본값이다. */
    needsSourceRerender(o) {
      const opt = o || {};
      const snapPx = Number(opt.snapPx) || 0;
      const cssPx  = Number(opt.cssPx)  || 0;
      const zoom   = Number(opt.zoom)   || 0;
      const dpr    = Math.max(1, Math.min(2, Number(opt.dpr) || 1));
      if (!(snapPx > 0) || !(cssPx > 0) || !(zoom > 0)) return false;
      const gain = Number(opt.gain) || this.SOURCE_GAIN;
      return (cssPx * zoom * dpr) > (snapPx * gain);
    },

    /** [P14] 크롭 오버레이를 얹을 "바탕" 요소 — 전면 PDF 캔버스(편집) 또는 배포 스냅샷 <img>(뷰어).
     *  [근본원인] 종전엔 #pdf-canvas 만 보고 없으면 즉시 반환했다. 뷰어는 스냅샷 <img> 를
     *  그리므로 재래스터 경로 자체에 진입하지 못했고, 확대하면 비트맵이 늘어나 뭉갰다. */
    _baseEl() {
      if (typeof document === "undefined") return null;
      const cv = document.getElementById("pdf-canvas");
      if (cv && !cv.classList.contains("hidden")) return cv;
      const img = document.getElementById("map-image");
      if (img && !img.classList.contains("hidden")) return img;
      return null;
    },

    /** 캔버스 상한으로 렌더 스케일을 자른다 (순수 함수) */
    clampScale(scale, pageW, pageH, pxCap, maxSide) {
      const w = Math.max(1, pageW || 1), h = Math.max(1, pageH || 1);
      const cap = pxCap || this.CANVAS_PX_MOBILE;
      const side = maxSide || this.MAX_SIDE_HARD;
      let rs = Math.min(scale, side / Math.max(w, h), Math.sqrt(cap / (w * h)));
      return Math.max(rs, 0.1);
    },

    /**
     * 줌에 맞는 목표 렌더 스케일 + 재렌더 실익 판정 (순수 함수 — 테스트 가능).
     * @returns {{target:number, capped:number, worth:boolean, reason:string}}
     *   target : 화면에 실제로 보이는 픽셀 밀도(= 논리스케일 × 줌 × dpr)
     *   capped : 기기 상한으로 자른 실제 렌더 스케일
     *   worth  : 다시 그릴 값어치가 있는가(선명해지거나 / 메모리를 회수하거나)
     */
    planRerender(o) {
      const opt = o || {};
      const gain = opt.gain || this.RERENDER_GAIN;
      const cur = opt.renderScale || 0;
      const target = (opt.baseCssScale || 1) * Math.max(1, opt.zoom || 1) * Math.max(1, opt.dpr || 1);
      const capped = this.clampScale(target, opt.pageW, opt.pageH, opt.pxCap, opt.maxSide);
      // 🔴 상한에 걸려 해상도가 안 오르는데 재렌더하면 "화질 그대로 + 대형 PDF 재렌더" 순수 손해다.
      //    실제로 오를 때(capped 기준)만 다시 그린다.
      if (capped > cur * gain) return { target: target, capped: capped, worth: true, reason: "sharpen" };
      // 🔴 [WO 20260929-lossless] 지금 캔버스가 목표(화면 픽셀×DPR)에 **못 미치고** 올릴 여지가 있으면 여유율과
      //   무관하게 다시 그린다 — 종전엔 목표의 87~100% 구간(예: 1.5배 초기렌더 뒤 1.6배 확대)이 흐린 채 남았다.
      if (cur < target && capped > cur) return { target: target, capped: capped, worth: true, reason: "sharpen" };
      // 크게 축소한 뒤 남은 과잉 해상도 캔버스는 메모리만 먹는다 → 회수(히스테리시스로 진동 방지).
      if (cur > 0 && capped < cur / (opt.shrink || this.SHRINK_RATIO)) {
        return { target: target, capped: capped, worth: true, reason: "shrink" };
      }
      return { target: target, capped: capped, worth: false, reason: "enough" };
    },

    async renderPage(pdfDoc, pageNum, canvas, scale = 1.5, rotation = 0) {
      const page = await pdfDoc.getPage(pageNum);
      // 페이지/문서/회전이 바뀌면 이전 페이지의 크롭 오버레이는 즉시 거짓 화면이 된다 → 제거.
      clearTimeout(this._renderState.pending);
      this._clearCrop();
      const rot = ((page.rotate || 0) + (rotation || 0)) % 360;
      const base = page.getViewport({ scale: 1, rotation: rot });
      // 초기 렌더는 "화면 1배(=CSS 100%)" 에 맞는 해상도로 그린다.
      // baseCssScale: 도면 1포인트가 화면 몇 px 로 보이는가 (디자이너 첫 표시 기준).
      // 여기서는 캔버스의 CSS 폭 = base.width 로 두고, 줌은 별도로 처리한다.
      // [WO 20260917-dpr] 상주 페이지 수(=1, 단일 캔버스 구조) 기준 dpr — residentDpr 참조.
      // [회귀수정 2026-09-28] 이 시점은 항상 _clearCrop() 직후(위 260행) → 상주 캔버스 1개.
      const dpr = this.residentDpr({ pageW: base.width, pageH: base.height, pxCap: this.effectivePxCap(this._env(), 1), residentPages: 1 });
      // 논리(=화면 1배) CSS 크기는 PDF 1포인트 = 1px 로 고정한다.
      // → map-transform/pins-layer 레이아웃 크기가 줌 재렌더와 무관하게 불변(핀 % 좌표 정합 보장).
      const baseCss = 1;
      canvas.style.width  = Math.round(base.width  * baseCss) + "px";
      canvas.style.height = Math.round(base.height * baseCss) + "px";
      this._renderState.pdfDoc = pdfDoc;
      this._renderState.pageNum = pageNum;
      this._renderState.rotation = rotation;
      this._renderState.baseCssScale = baseCss;
      this._renderState.overlayOnly = false;   // 전면 캔버스를 직접 그리는 경로(편집모드 PDF)
      // [WO 20260917] 새 문서/페이지 로드 시 이전 구역의 크롭 고정을 초기화(누출 방지).
      // 구역 진입 시 selectDeck 이 다시 PDF.setDeckCrop 으로 설정한다.
      this._renderState.deckCrop = null;
      // [WO 20260928-crop] 이 경로는 setDeckCrop() 을 거치지 않는 직접 초기화라
      // MapCtrl 페이지 경계(클리핑+줌/팬 한계)도 여기서 별도로 풀어야 한다(요구⑦, 누출 방지).
      if (typeof MapCtrl !== "undefined" && MapCtrl.setCropBoundary) MapCtrl.setCropBoundary(null);
      // 첫 렌더 해상도: 초기 화질 확보를 위해 scale(권장 1.5)×dpr 로 미리 선명하게.
      // 이후 줌인하면 requestZoomRerender 가 더 높은 해상도로 재래스터화한다.
      const initRender = Math.max(1, scale) * dpr;
      await this._rasterize(page, canvas, initRender, rot, baseCss);
    },

    /** 실제 캔버스 래스터화 (renderScale = PDF 포인트당 캔버스 픽셀) */
    async _rasterize(page, canvas, renderScale, rot, cssScale) {
      // 캔버스 면적/변 상한으로 클램프 (안정성)
      const baseVp = page.getViewport({ scale: 1, rotation: rot });
      // [회귀수정 2026-09-28] base 캔버스 래스터화 경로는 renderPage(_clearCrop 직후) 또는
      // requestZoomRerender 의 "_clearCrop() 이후 재래스터" 분기에서만 호출된다 → 상주 1개.
      const rs = this.clampScale(renderScale, baseVp.width, baseVp.height, this.effectivePxCap(this._env(), 1), this.MAX_SIDE_HARD);
      const vp = page.getViewport({ scale: rs, rotation: rot });
      const ctx = canvas.getContext("2d", { alpha: false });
      // 진행 중 task 취소 (줌 연타 시 누적 방지)
      try { if (this._renderState.task) this._renderState.task.cancel(); } catch (e) {}
      canvas.width  = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      // CSS 크기 = 논리 크기(cssScale 기준). 캔버스 내부 픽셀이 더 많으므로 선명.
      canvas.style.width  = Math.round(baseVp.width  * cssScale) + "px";
      canvas.style.height = Math.round(baseVp.height * cssScale) + "px";
      const task = page.render({ canvasContext: ctx, viewport: vp });
      this._renderState.task = task;
      this._renderState.renderScale = rs;
      if (this.useWorker) {
        try { await task.promise; } catch (e) { /* cancel 등 무시 */ }
      } else {
        await Promise.race([
          task.promise.catch(() => {}),
          new Promise(res => setTimeout(res, 4000))
        ]);
      }
    },

    /** 줌 변경 시 호출 — 확대가 "끝난 뒤" 그 배율에 맞는 해상도로 PDF 를 딱 한 번 재래스터화.
     *  zoom    = MapCtrl 의 State.zoom (CSS transform 배율. 구역 crop/ISO 확대 배율도 여기에 들어온다)
     *  delayMs = 조작 종료 판정 지연. 애니메이션(플라이/ISO 전환) 중에는 MapCtrl 이 애니메이션
     *            잔여시간을 넘겨 렌더를 뒤로 미룬다 → 애니메이션은 가볍고, 끝나면 선명해진다.
     *  ⚠ 매 호출마다 타이머를 리셋하므로(디바운스) 연속 줌·rAF 애니메이션 중에는 렌더가 돌지 않는다. */
    requestZoomRerender(zoom, delayMs) {
      const st = this._renderState;
      if (!st.pdfDoc) return;
      const canvas = this._baseEl();
      if (!canvas) { this._clearCrop(); return; }
      st.lastZoom = zoom;
      clearTimeout(st.pending);
      const wait = Math.max(this.SETTLE_MS, delayMs || 0);
      st.pending = setTimeout(async () => {
        try {
          const page = await st.pdfDoc.getPage(st.pageNum);
          const rot = ((page.rotate || 0) + (st.rotation || 0)) % 360;
          const baseVp = page.getViewport({ scale: 1, rotation: rot });
          // [WO 20260917-dpr] 상주 페이지 수(=1) 기준 dpr — baseVp 확보 후 계산(residentDpr 참조).
          // [회귀수정 2026-09-28] plan.capped 는 "크롭 없이 base 만 다시 그리면 도달 가능한
          // 배율" 을 뜻한다(아래에서 실제로 그 분기를 타면 _clearCrop() 후 _rasterize 한다)
          // → 이 계획 단계의 pxCap 도 상주 1개 기준이어야 한다(크롭이 이겨도 무방 — 그 경우
          // 아래 renderCrop() 이 자신의 pxCap 을 별도로 상주 2개로 다시 계산한다).
          const dpr = this.residentDpr({ pageW: baseVp.width, pageH: baseVp.height, pxCap: this.effectivePxCap(this._env(), 1), residentPages: 1 });
          // 🔴 실익 판정은 "상한으로 자른 뒤" 한다 — 상한에 걸려 화질이 안 오르는데
          //    대형 PDF 를 다시 그리면 화면만 멈추고 얻는 게 없다(구 코드의 실제 버그).
          const plan = this.planRerender({
            zoom: st.lastZoom, dpr: dpr, baseCssScale: st.baseCssScale, renderScale: st.renderScale,
            pageW: baseVp.width, pageH: baseVp.height,
            pxCap: this.effectivePxCap(this._env(), 1), maxSide: this.MAX_SIDE_HARD
          });
          // 🔴 [WO 20260929-lossless] 크롭(보이는 영역만) 목표는 **실제 화면 DPR** 로 잡는다. residentDpr 는 "페이지 전체를
          //   한 장에" 담기 위한 감산(GA 7143×2384pt → 1.53)이라 크롭에 쓰면 DPR2 화면에서 밀도 0.77 로 굳었다(실측).
          //   크롭 면적은 뷰포트로 묶이므로 이 감산이 필요 없다(메모리 상한은 renderCrop 의 effectivePxCap(,2)가 지킨다).
          const rawDpr = Math.max(1, Math.min((typeof window !== "undefined" && window.devicePixelRatio) || 1, 2));
          const cropTarget = (st.baseCssScale || 1) * Math.max(1, st.lastZoom || 1) * rawDpr;
          // [WO 20260917] 구역(deck) 크롭이 고정돼 있으면 전체 페이지 임계와 무관하게
          //   항상 그 영역만 렌더 대상으로 삼는다 — 같은 픽셀 예산을 그 영역에 집중시켜
          //   A1/A0 가 첫 렌더부터 상한에 닿아 확대해도 선명해지지 않던 문제를 해소한다.
          if (st.deckCrop) { await this.renderCrop(page, canvas, cropTarget, rot); return; }
          // [P14] 바탕이 배포 스냅샷 <img> 면 전면 캔버스를 다시 그릴 수 없다(레이아웃·핀 좌표 기준).
          //   → 스냅샷보다 선명해질 때만 보이는 영역을 크롭 오버레이로 얹는다.
          //   🔴 [WO 20260929-lossless] 임계 = 스냅샷 밀도 그 자체(×1). RERENDER_GAIN(1.15) 을 곱하면 목표의
          //   87~100% 구간이 스냅샷으로 남아 "화면 픽셀×DPR 이상" 을 못 지킨다. 오버레이는 보이는 영역만
          //   그리므로 비용이 뷰포트 크기로 묶인다(전면 재래스터와 달리 여유율이 필요 없다).
          if (st.overlayOnly) {
            if (cropTarget > (st.renderScale || 0)) await this.renderCrop(page, canvas, cropTarget, rot);
            else this._clearCrop();
            return;
          }
          // 전면 캔버스가 목표에 못 미치면(상한에 막힘) → 보이는 영역만 고해상도로 얹는다.
          //   (종전 임계 ×RERENDER_GAIN 은 목표의 87~100% 를 흐린 전면으로 남겼다 → 못 미치면 곧바로 크롭)
          if (cropTarget > plan.capped) {
            await this.renderCrop(page, canvas, cropTarget, rot);
            return;
          }
          this._clearCrop(); // 전면 캔버스만으로 충분한 배율 → 크롭 오버레이는 불필요
          if (!plan.worth) return;
          await this._rasterize(page, canvas, plan.target, rot, st.baseCssScale);
        } catch (e) {}
      }, wait);
    },

    /** [WO 20260917] 구역(deck) 크롭(%, 0~100) → 렌더 대상 비율(0~1). 순수 함수.
     *  crop 없거나 폭/높이가 0 이하면 null(=구역 크롭 없음). 입력 객체는 변경하지 않는다. */
    deckCropToFraction(crop) {
      if (!crop || !(crop.w > 0) || !(crop.h > 0)) return null;
      return { x: crop.x / 100, y: crop.y / 100, w: crop.w / 100, h: crop.h / 100 };
    },

    /** 활성 구역 크롭을 렌더 상태에 고정 — 이후 렌더는 "현재 보이는 영역" 대신
     *  이 영역을 대상으로 삼는다(같은 픽셀 예산을 그 영역에 집중). crop 이 없으면 해제
     *  (= 구버전 구역·페이지 전체 구역은 종전대로 visibleDrawingRect 로 동작).
     *  [WO 20260928-crop] 같은 crop 을 MapCtrl 의 "페이지 경계"(클리핑+줌/팬 한계)에도
     *  전달하는 단일 진입점(§G-2-5) — 호출부(31_Projects.js)를 건드리지 않고 여기서 겸한다. */
    setDeckCrop(crop) {
      this._renderState.deckCrop = this.deckCropToFraction(crop);
      if (typeof MapCtrl !== "undefined" && MapCtrl.setCropBoundary) MapCtrl.setCropBoundary(crop);
      return this._renderState.deckCrop;
    },

    /** renderCrop 이 실제로 그릴 영역 선택(순수 로직 · 테스트 가능):
     *  구역 크롭이 고정돼 있으면 그것을, 아니면 종전대로 현재 보이는 영역. */
    _cropRenderRect() {
      const st = this._renderState;
      if (st.deckCrop) return st.deckCrop;
      return (typeof MapCtrl !== "undefined" && MapCtrl.visibleDrawingRect)
        ? MapCtrl.visibleDrawingRect() : null;
    },

    /** 예산이 모자랄 때 보이는 영역에 붙이는 여백(뷰포트 폭 대비 비율). 평면 뷰는 역변환이 정확하므로
     *  팬 직후 가장자리가 비치지 않을 만큼만 남긴다(기본 MapCtrl.visibleDrawingRect 여백 = 25%). */
    TIGHT_PAD: 0.04,
    /** 보이는 도면 영역(0~1). pad=null → MapCtrl.visibleDrawingRect() 그대로(종전).
     *  pad 지정 + 평면 뷰(ISO 아님)면 applyTransform 모델(translate·scale, 원점 좌상단)의 정확한 역변환으로 계산한다
     *  — 격자 표본(96칸)은 확대가 커지면(>~×50) 표본이 뷰포트에 안 잡혀 "전면"으로 폴백해 버린다.
     *  ISO(3D)는 역변환이 불가 → 종전 표본 함수. */
    _visibleRect(pad) {
      if (typeof MapCtrl === "undefined" || !MapCtrl.visibleDrawingRect) return null;
      if (pad == null || State.isoView || !MapCtrl.viewport || !MapCtrl.transform) return MapCtrl.visibleDrawingRect();
      const cw = MapCtrl.transform.offsetWidth, ch = MapCtrl.transform.offsetHeight;
      const vw = MapCtrl.viewport.clientWidth, vh = MapCtrl.viewport.clientHeight;
      const z = State.zoom;
      if (!(cw > 0 && ch > 0 && vw > 0 && vh > 0 && z > 0)) return null;
      const mx = pad * vw, my = pad * vh;
      const x0 = (-State.pan.x - mx) / (z * cw), y0 = (-State.pan.y - my) / (z * ch);
      const x1 = (vw - State.pan.x + mx) / (z * cw), y1 = (vh - State.pan.y + my) / (z * ch);
      return this.intersectRect({ x: 0, y: 0, w: 1, h: 1 }, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    },

    /** 두 비율 사각형(0~1 {x,y,w,h})의 교집합 — 겹침이 없거나 입력이 없으면 null. 순수 함수. */
    intersectRect(a, b) {
      if (!a || !b) return null;
      const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
      const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
      return (x1 > x0 && y1 > y0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
    },

    /** [화질 · 구조적 한계 우회] 지금 보이는 도면 영역만 목표 배율로 다시 그려 전면 캔버스 위에 얹는다.
     *  전면 캔버스 한 장은 페이지 전체를 담아야 해서 한 변 8192px·면적 상한에 막힌다
     *  (A1 기준 최대 배율 ≈3.44 → dpr2 화면에서 선명한 줌은 ≈1.7배까지). 구역 확대는 4~8배다.
     *  크롭은 보이는 만큼만 그리므로 면적이 뷰포트 크기로 묶여 상한에 걸리지 않는다.
     *  레이아웃 불변: 오버레이는 position:absolute 라 #map-transform 크기에 영향을 주지 않는다
     *  → 핀 % 좌표 정합이 그대로 유지된다. */
    async renderCrop(page, baseCanvas, scale, rot) {
      const st = this._renderState;
      let rect = this._cropRenderRect();
      if (!rect || (rect.w >= 1 && rect.h >= 1)) { this._clearCrop(); return; } // 전면이 다 보이면 크롭 이득 없음
      const baseVp = page.getViewport({ scale: 1, rotation: rot });
      // [회귀수정 2026-09-28] renderCrop() 은 정의상 "전면(base) 캔버스 위에 겹쳐 그린다"
      // (함수 상단 주석) — 이 함수가 실행되는 순간 base 는 이미 DOM 에 존재하고 이 크롭
      // 오버레이가 그 위에 추가로 상주한다 → 상주 캔버스는 항상 2개(고정 상수가 아니라
      // 이 함수의 실행 전제 자체가 2다).
      const cap = this.effectivePxCap(this._env(), 2);
      // 🔴 [WO 20260929-lossless] 목표 배율에 못 미치면(상한에 막힘) 그릴 영역을 단계적으로 좁힌다 —
      //   같은 픽셀 예산을 "지금 화면에 보이는 부분"에 집중해 화면 픽셀×DPR 이상을 지킨다.
      //   실측(수정 전): GA 60% 폭 구역 1600% 밀도 0.06 · 여백 25% 붙은 보이는 영역 DPR2 밀도 0.77.
      //   ① 구역 크롭 전체 → ② 크롭 ∩ 보이는 영역(여백 포함) → ③ 크롭 ∩ 보이는 영역(여백 최소).
      //   (_cropRenderRect 계약 = 크롭 그대로는 유지: 맞춤 배율처럼 예산이 충분하면 종전대로 한 장으로 그린다.)
      const fits = (r) => this.clampScale(scale, r.w * baseVp.width, r.h * baseVp.height, cap, this.MAX_SIDE_HARD) >= scale;
      if (!fits(rect)) {
        const base = st.deckCrop || { x: 0, y: 0, w: 1, h: 1 };
        for (const pad of (st.deckCrop ? [null, this.TIGHT_PAD] : [this.TIGHT_PAD])) {
          const v = this.intersectRect(base, this._visibleRect(pad));
          if (v) rect = v;
          if (fits(rect)) break;
        }
      }
      const x0 = rect.x * baseVp.width,  y0 = rect.y * baseVp.height;
      const w0 = rect.w * baseVp.width,  h0 = rect.h * baseVp.height;
      const rs = this.clampScale(scale, w0, h0, cap, this.MAX_SIDE_HARD);
      // 전면 캔버스보다 선명하지 않으면 얹을 이유가 없다(메모리만 먹는다).
      //   🔴 [WO 20260929-lossless] 여유율(×1.15) 없이 ×1 — 요청측(requestZoomRerender)은 전면이 목표에 못 미칠 때만
      //   이 함수를 부른다. 여기서 1.15 를 또 요구하면 목표의 87~100% 구간이 흐린 전면 캔버스로 남았다.
      if (rs <= (st.renderScale || 0)) { this._clearCrop(); return; }
      const cv = this._ensureCrop(baseCanvas);
      if (!cv) return;
      const cssW = baseVp.width * st.baseCssScale, cssH = baseVp.height * st.baseCssScale;
      cv.width  = Math.max(1, Math.round(w0 * rs));
      cv.height = Math.max(1, Math.round(h0 * rs));
      cv.style.left   = (rect.x * cssW) + "px";
      cv.style.top    = (rect.y * cssH) + "px";
      cv.style.width  = (rect.w * cssW) + "px";
      cv.style.height = (rect.h * cssH) + "px";
      const ctx = cv.getContext("2d", { alpha: false });
      ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, cv.width, cv.height);
      try { if (st.cropTask) st.cropTask.cancel(); } catch (e) {}
      const vp = page.getViewport({ scale: rs, rotation: rot });
      // transform: 페이지 전체 뷰포트를 크롭 원점만큼 밀어 넣는다(크롭 좌상단이 캔버스 0,0).
      const task = page.render({
        canvasContext: ctx, viewport: vp,
        transform: [1, 0, 0, 1, -Math.round(x0 * rs), -Math.round(y0 * rs)]
      });
      st.cropTask = task;
      st.cropScale = rs;
      try { await task.promise; } catch (e) { /* cancel 등 무시 */ }
    },

    /** 크롭 오버레이 캔버스 확보 — 전용 CSS 없이 인라인 스타일만 쓴다.
     *  z-index 0 = 전면 캔버스(비위치 in-flow) 위 · 구역(1)·주석·핀(3) 레이어 아래. */
    _ensureCrop(baseCanvas) {
      const st = this._renderState;
      if (st.crop && st.crop.parentNode) return st.crop;
      const host = (baseCanvas && baseCanvas.parentNode) || document.getElementById("map-transform");
      if (!host) return null;
      const cv = document.createElement("canvas");
      cv.id = "pdf-canvas-hi";
      cv.style.cssText = "position:absolute;z-index:0;display:block;pointer-events:none;";
      if (baseCanvas && baseCanvas.nextSibling) host.insertBefore(cv, baseCanvas.nextSibling);
      else host.appendChild(cv);
      st.crop = cv;
      return cv;
    },

    /** 크롭 오버레이 제거(페이지·문서 전환, 축소, 전면 캔버스로 충분해진 경우) */
    _clearCrop() {
      const st = this._renderState;
      try { if (st.cropTask) st.cropTask.cancel(); } catch (e) {}
      st.cropTask = null; st.cropScale = 0;
      try { if (st.crop && st.crop.parentNode) st.crop.parentNode.removeChild(st.crop); } catch (e) {}
      st.crop = null;
    },

    /* ══════════════════════════════════════════════════════════════════
       [WO 20260928-copy] 영역 = "지정한 부분만 복사한 새 1페이지 PDF" (마스터: "확대하면 해상도가 깨지잖아")
       원본 페이지를 pdf-lib 로 통째 복사(벡터 그대로)한 뒤 MediaBox/CropBox 를 영역 사각형으로
       좁힌다 → 새 PDF 의 페이지 자체가 그 영역이라, 열면 일반 도면처럼 벡터 재렌더로 선명하다.
       pdf-lib(MIT 1.17.1)는 /vendor 에 벤더링 — CDN 금지, 영역 생성 때만 지연 로드(첫 화면 비용 0).
       ══════════════════════════════════════════════════════════════════ */
    PDFLIB_SRC: "/vendor/pdf-lib.min.js",
    _pdfLibPromise: null,

    /** pdf-lib 지연 로드(1회). 실패하면 약속을 비워 다음 시도에서 다시 받는다. */
    ensurePdfLib() {
      if (typeof window !== "undefined" && window.PDFLib) return Promise.resolve(window.PDFLib);
      if (this._pdfLibPromise) return this._pdfLibPromise;
      this._pdfLibPromise = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = this.PDFLIB_SRC;
        s.async = true;
        s.onload = () => (window.PDFLib ? resolve(window.PDFLib) : reject(new Error("pdf-lib 로드 실패")));
        s.onerror = () => reject(new Error("pdf-lib 로드 실패"));
        document.head.appendChild(s);
      }).catch((e) => { this._pdfLibPromise = null; throw e; });
      return this._pdfLibPromise;
    },

    /** 영역 crop(%, 화면=pdf.js 뷰포트 기준, 원점 좌상단) → PDF 사용자 공간 사각형(pt). 순수 함수.
     *  view   = [x0,y0,x1,y1] 페이지 보이는 상자(pdf.js page.view 와 같은 정의 = CropBox∩MediaBox)
     *  rotate = 페이지 /Rotate (0/90/180/270, 시계방향 — pdf.js 뷰포트 기본 회전과 동일)
     *  🔴 PDF 사용자 공간은 원점이 **좌하단**(y 가 위로 증가) — 화면 v(아래로 증가)를 뒤집어야 한다.
     *  @returns {{x,y,width,height}|null} */
    cropPctToPdfBox(crop, view, rotate) {
      const f = this.deckCropToFraction(crop);
      if (!f || !Array.isArray(view) || view.length < 4) return null;
      const r = ((Math.round(Number(rotate) || 0) % 360) + 360) % 360;
      if (r % 90) return null;
      const x0 = Math.min(view[0], view[2]), x1 = Math.max(view[0], view[2]);
      const y0 = Math.min(view[1], view[3]), y1 = Math.max(view[1], view[3]);
      const W = x1 - x0, H = y1 - y0;
      if (!(W > 0) || !(H > 0)) return null;
      // (u,v) = 화면 분수(u: 왼→오, v: 위→아래) → 사용자 공간. 회전별로 화면 좌상단이 가리키는 모서리가 다르다.
      const toUser = (u, v) => {
        if (r === 90)  return [x0 + v * W, y0 + u * H];
        if (r === 180) return [x1 - u * W, y0 + v * H];
        if (r === 270) return [x1 - v * W, y1 - u * H];
        return [x0 + u * W, y1 - v * H];                    // 0° — y 뒤집기(좌하단 원점)
      };
      const a = toUser(f.x, f.y), b = toUser(f.x + f.w, f.y + f.h);
      const x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]);
      return { x, y, width: Math.abs(b[0] - a[0]), height: Math.abs(b[1] - a[1]) };
    },

    /** 원본 PDF 가 화면의 도면(스냅샷)과 같은 파일인지 — 다르면 crop % 가 엉뚱한 곳을 가리킨다. 순수 함수.
     *  expect = { count?, pw?, ph? (스냅샷이 기록한 페이지 pt) , w?, h? (스냅샷 px — 비율만 비교) }
     *  actual = { count, w, h } (원본 PDF 의 해당 페이지, 회전 반영한 화면 기준 pt)
     *  @returns {string|null} 불일치 사유(사용자에게 그대로 보여줄 문장) · 일치/판단불가면 null */
    regionSizeMismatch(expect, actual, tol) {
      if (!expect || !actual) return null;
      const t = tol > 0 ? tol : 0.01;
      const off = (a, b) => Math.abs(a - b) / b > t;
      if (expect.count > 0 && actual.count !== expect.count)
        return "페이지 수가 다릅니다(도면 " + expect.count + "쪽 · 올린 PDF " + actual.count + "쪽)";
      if (expect.pw > 0 && expect.ph > 0) {
        if (off(actual.w, expect.pw) || off(actual.h, expect.ph))
          return "페이지 크기가 다릅니다(도면 " + Math.round(expect.pw) + "×" + Math.round(expect.ph) + "pt · 올린 PDF " + Math.round(actual.w) + "×" + Math.round(actual.h) + "pt)";
        return null;
      }
      if (expect.w > 0 && expect.h > 0 && actual.w > 0 && actual.h > 0) {
        if (off(actual.w / actual.h, expect.w / expect.h)) return "페이지 가로세로 비율이 다릅니다";
      }
      return null;
    },

    /** pdf-lib 페이지의 보이는 상자 [x0,y0,x1,y1] — pdf.js page.view 와 같은 규칙(CropBox∩MediaBox). */
    _pdfLibView(pg) {
      const mb = pg.getMediaBox();
      const m = [mb.x, mb.y, mb.x + mb.width, mb.y + mb.height];
      let c = m;
      try { const cb = pg.getCropBox(); c = [cb.x, cb.y, cb.x + cb.width, cb.y + cb.height]; } catch (e) {}
      const v = [Math.max(m[0], c[0]), Math.max(m[1], c[1]), Math.min(m[2], c[2]), Math.min(m[3], c[3])];
      return (v[2] > v[0] && v[3] > v[1]) ? v : m;
    },

    /** 원본 PDF 한 페이지의 영역만 담은 새 1페이지 PDF 를 만든다(벡터 복사 — 래스터 0).
     *  원본 바이트는 읽기만 한다(원본 파일·배포본 무변경).
     *  @param {ArrayBuffer|Uint8Array} srcBytes 원본 PDF
     *  @param {number} pageNo 1-base
     *  @param {object} crop {x,y,w,h} %
     *  @param {object} [expect] regionSizeMismatch 의 기대값 — 다르면 code="SIZE_MISMATCH" 로 throw
     *  @returns {Promise<{bytes:Uint8Array, box:{x,y,width,height}, rotate:number, pageCount:number}>} */
    async copyRegionToPdf(srcBytes, pageNo, crop, expect) {
      const L = await this.ensurePdfLib();
      const src = await L.PDFDocument.load(srcBytes, { ignoreEncryption: true, updateMetadata: false });
      const n = src.getPageCount();
      const idx = Math.round(Number(pageNo) || 1) - 1;
      if (idx < 0 || idx >= n) { const e = new Error("원본 PDF 에 " + (idx + 1) + "쪽이 없습니다"); e.code = "SIZE_MISMATCH"; throw e; }
      const sp = src.getPage(idx);
      const rot = ((((sp.getRotation() && sp.getRotation().angle) || 0) % 360) + 360) % 360;
      const view = this._pdfLibView(sp);
      const vw = view[2] - view[0], vh = view[3] - view[1];
      const why = this.regionSizeMismatch(expect, { count: n, w: rot % 180 ? vh : vw, h: rot % 180 ? vw : vh });
      if (why) { const e = new Error(why); e.code = "SIZE_MISMATCH"; throw e; }
      const box = this.cropPctToPdfBox(crop, view, rot);
      if (!box || !(box.width > 0) || !(box.height > 0)) throw new Error("영역 좌표를 PDF 좌표로 바꿀 수 없습니다");
      const out = await L.PDFDocument.create();
      const copied = await out.copyPages(src, [idx]);   // 페이지 내용(벡터·폰트·이미지)을 그대로 복사
      const pg = copied[0];
      out.addPage(pg);
      // 보이는 상자를 영역으로 — 5종 상자를 모두 맞춰야 뷰어마다 같은 크기로 보인다.
      pg.setMediaBox(box.x, box.y, box.width, box.height);
      pg.setCropBox(box.x, box.y, box.width, box.height);
      pg.setBleedBox(box.x, box.y, box.width, box.height);
      pg.setTrimBox(box.x, box.y, box.width, box.height);
      pg.setArtBox(box.x, box.y, box.width, box.height);
      pg.setRotation(L.degrees(rot));                   // 회전 유지 → 원본 화면과 같은 방향
      const bytes = await out.save();
      return { bytes, box, rotate: rot, pageCount: n };
    },

    /** [WO 20260917] 구역 크롭이 있는 페이지의 스냅샷 렌더 대상 사각형(페이지 포인트 단위). 순수 함수.
     *  crop 없으면 페이지 전체(종전 동작) — snapshotAllPages 자체는 변경하지 않는다(비파괴). */
    deckSnapshotRect(crop, pageW, pageH) {
      const f = this.deckCropToFraction(crop);
      if (!f) return { x0: 0, y0: 0, w0: pageW, h0: pageH };
      return { x0: f.x * pageW, y0: f.y * pageH, w0: f.w * pageW, h0: f.h * pageH };
    },

    /** 전 페이지를 오프스크린 렌더 → 고화질 이미지 dataURL 배열 (배포 스냅샷용).
     *  뷰어에서 확대해도 선명하도록 해상도를 충분히 높게 잡되(maxDim 4096),
     *  엔지니어링 도면(선/텍스트 위주)은 PNG 가 JPEG보다 선명하고 용량도 작은 경우가 많아
     *  PNG/JPEG 중 더 작은 쪽을 자동 선택한다. 너무 크면 단계적으로 해상도를 낮춰 D1 저장 안정성 확보.
     *  [WO 20260917] deckCrop = { page(1-base), crop:{x,y,w,h}(%) } 이 주어지고 그 페이지 번호와
     *  일치하면, 그 페이지만 deckSnapshotRect 로 잘라낸 영역을 대상으로 스케일을 계산해
     *  같은 픽셀 예산(maxDim)을 크롭 영역에 집중한다(renderCrop 과 동일한 transform 오프셋 기법 재사용).
     *  🔴 [지휘자 판단 필요] 이 페이지에 16_Zones.js 구역·PDF 주석이 있으면 좌표(페이지 기준 %)가
     *  크롭 이미지 기준과 어긋난다 — 핀(x,y)만 MapCtrl.pageToDeckCropPct 로 재매핑했고
     *  zones/annotations 재매핑은 이번 범위에 없다(별도 함수 필요, 미구현). */
    async snapshotAllPages(pdfDoc, maxDim = 4096, quality = 0.92, deckCrop = null) {
      const out = [];
      // [P14] 실제로 저장된 픽셀 크기를 기록한다 — SOFT_LIMIT 강등(dim*=0.8, 최대 4회)으로
      //   요청 maxDim(4096)보다 훨씬 낮게 저장되는 경우가 있고, 뷰어는 그 값을 알아야
      //   "언제 원본이 필요한지"를 추측이 아니라 사실로 판정할 수 있다.
      const dims = [];
      this.lastSnapshotDims = null;
      const SOFT_LIMIT = 2_600_000; // dataURL 문자수 상한 (≈2MB) — 초과 시 해상도 자동 강등
      for (let p = 1; p <= pdfDoc.numPages; p++) {
        const page = await pdfDoc.getPage(p);
        const base = page.getViewport({ scale: 1 });
        const isCropPage = !!(deckCrop && (deckCrop.page || 1) === p && deckCrop.crop);
        const rect = isCropPage ? this.deckSnapshotRect(deckCrop.crop, base.width, base.height)
                                 : { x0: 0, y0: 0, w0: base.width, h0: base.height };
        const px = { w: 0, h: 0, pw: Math.round(rect.w0), ph: Math.round(rect.h0) };
        let dim = maxDim, q = quality, data = null;
        for (let attempt = 0; attempt < 4; attempt++) {
          const scale = Math.min(dim / Math.max(rect.w0, rect.h0), 4);
          const vp = page.getViewport({ scale });
          const cv = document.createElement("canvas");
          cv.width = Math.max(1, Math.round(rect.w0 * scale));
          cv.height = Math.max(1, Math.round(rect.h0 * scale));
          px.w = cv.width; px.h = cv.height;   // 이 시도가 채택되면 이 값이 최종 저장 픽셀
          const ctx = cv.getContext("2d", { alpha: false });
          ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, cv.width, cv.height);
          if (isCropPage) {
            // renderCrop(02_PDF.js)과 동일한 오프셋 기법: 페이지 전체를 그리되 크롭 원점만큼 밀어
            // 캔버스(=크롭 크기)에는 크롭 영역만 담긴다.
            await page.render({
              canvasContext: ctx, viewport: vp,
              transform: [1, 0, 0, 1, -Math.round(rect.x0 * scale), -Math.round(rect.y0 * scale)]
            }).promise;
          } else {
            await page.render({ canvasContext: ctx, viewport: vp }).promise;
          }
          // 선화 도면은 PNG 가 더 선명/경량인 경우가 많음 → PNG·JPEG 중 작은 쪽 채택
          const png = cv.toDataURL("image/png");
          const jpg = cv.toDataURL("image/jpeg", q);
          data = (png.length <= jpg.length) ? png : jpg;
          if (data.length <= SOFT_LIMIT || dim <= 1600) break;
          // 용량 초과 → 해상도/품질 강등 후 재시도
          dim = Math.round(dim * 0.8); q = Math.max(0.8, q - 0.04);
        }
        out.push(data);
        dims.push(px);
      }
      this.lastSnapshotDims = dims;
      return out;
    }
  };

  /* ══════════════════════════════════════════
     LOG  — 사용자 액션 추적(로그인 이후 모든 주요 행위)
     서버 /api/client-log 로 비동기 전송. 실패해도 앱 흐름 방해 안 함.
  ══════════════════════════════════════════ */