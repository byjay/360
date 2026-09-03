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
      cropScale: 0           // 크롭 캔버스의 렌더 스케일
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

    /** 기기별 캔버스 면적 상한 (순수 함수 — 테스트 가능) */
    canvasPxCap(env) {
      const e = env || {};
      if (e.mobile) return this.CANVAS_PX_MOBILE;
      const mem = e.deviceMemory;
      if (typeof mem === "number" && mem > 0 && mem <= this.LOW_MEMORY_GB) return this.CANVAS_PX_MOBILE;
      return this.CANVAS_PX_DESKTOP;
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
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      // 논리(=화면 1배) CSS 크기는 PDF 1포인트 = 1px 로 고정한다.
      // → map-transform/pins-layer 레이아웃 크기가 줌 재렌더와 무관하게 불변(핀 % 좌표 정합 보장).
      const baseCss = 1;
      canvas.style.width  = Math.round(base.width  * baseCss) + "px";
      canvas.style.height = Math.round(base.height * baseCss) + "px";
      this._renderState.pdfDoc = pdfDoc;
      this._renderState.pageNum = pageNum;
      this._renderState.rotation = rotation;
      this._renderState.baseCssScale = baseCss;
      // 첫 렌더 해상도: 초기 화질 확보를 위해 scale(권장 1.5)×dpr 로 미리 선명하게.
      // 이후 줌인하면 requestZoomRerender 가 더 높은 해상도로 재래스터화한다.
      const initRender = Math.max(1, scale) * dpr;
      await this._rasterize(page, canvas, initRender, rot, baseCss);
    },

    /** 실제 캔버스 래스터화 (renderScale = PDF 포인트당 캔버스 픽셀) */
    async _rasterize(page, canvas, renderScale, rot, cssScale) {
      // 캔버스 면적/변 상한으로 클램프 (안정성)
      const baseVp = page.getViewport({ scale: 1, rotation: rot });
      const rs = this.clampScale(renderScale, baseVp.width, baseVp.height, this.canvasPxCap(this._env()), this.MAX_SIDE_HARD);
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
      const canvas = document.getElementById("pdf-canvas");
      if (!canvas || canvas.classList.contains("hidden")) { this._clearCrop(); return; }
      const dpr = Math.min((typeof window !== "undefined" && window.devicePixelRatio) || 1, 2);
      st.lastZoom = zoom;
      clearTimeout(st.pending);
      const wait = Math.max(this.SETTLE_MS, delayMs || 0);
      st.pending = setTimeout(async () => {
        try {
          const page = await st.pdfDoc.getPage(st.pageNum);
          const rot = ((page.rotate || 0) + (st.rotation || 0)) % 360;
          const baseVp = page.getViewport({ scale: 1, rotation: rot });
          // 🔴 실익 판정은 "상한으로 자른 뒤" 한다 — 상한에 걸려 화질이 안 오르는데
          //    대형 PDF 를 다시 그리면 화면만 멈추고 얻는 게 없다(구 코드의 실제 버그).
          const plan = this.planRerender({
            zoom: st.lastZoom, dpr: dpr, baseCssScale: st.baseCssScale, renderScale: st.renderScale,
            pageW: baseVp.width, pageH: baseVp.height,
            pxCap: this.canvasPxCap(this._env()), maxSide: this.MAX_SIDE_HARD
          });
          // 전면 캔버스가 목표에 못 미치면(상한에 막힘) → 보이는 영역만 고해상도로 얹는다.
          if (plan.target > plan.capped * this.RERENDER_GAIN) {
            await this.renderCrop(page, canvas, plan.target, rot);
            return;
          }
          this._clearCrop(); // 전면 캔버스만으로 충분한 배율 → 크롭 오버레이는 불필요
          if (!plan.worth) return;
          await this._rasterize(page, canvas, plan.target, rot, st.baseCssScale);
        } catch (e) {}
      }, wait);
    },

    /** [화질 · 구조적 한계 우회] 지금 보이는 도면 영역만 목표 배율로 다시 그려 전면 캔버스 위에 얹는다.
     *  전면 캔버스 한 장은 페이지 전체를 담아야 해서 한 변 8192px·면적 상한에 막힌다
     *  (A1 기준 최대 배율 ≈3.44 → dpr2 화면에서 선명한 줌은 ≈1.7배까지). 구역 확대는 4~8배다.
     *  크롭은 보이는 만큼만 그리므로 면적이 뷰포트 크기로 묶여 상한에 걸리지 않는다.
     *  레이아웃 불변: 오버레이는 position:absolute 라 #map-transform 크기에 영향을 주지 않는다
     *  → 핀 % 좌표 정합이 그대로 유지된다. */
    async renderCrop(page, baseCanvas, scale, rot) {
      const st = this._renderState;
      const rect = (typeof MapCtrl !== "undefined" && MapCtrl.visibleDrawingRect)
        ? MapCtrl.visibleDrawingRect() : null;
      if (!rect || (rect.w >= 1 && rect.h >= 1)) { this._clearCrop(); return; } // 전면이 다 보이면 크롭 이득 없음
      const baseVp = page.getViewport({ scale: 1, rotation: rot });
      const x0 = rect.x * baseVp.width,  y0 = rect.y * baseVp.height;
      const w0 = rect.w * baseVp.width,  h0 = rect.h * baseVp.height;
      const rs = this.clampScale(scale, w0, h0, this.canvasPxCap(this._env()), this.MAX_SIDE_HARD);
      // 전면 캔버스보다 선명하지 않으면 얹을 이유가 없다(메모리만 먹는다).
      if (rs <= (st.renderScale || 0) * this.RERENDER_GAIN) { this._clearCrop(); return; }
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

    /** 전 페이지를 오프스크린 렌더 → 고화질 이미지 dataURL 배열 (배포 스냅샷용).
     *  뷰어에서 확대해도 선명하도록 해상도를 충분히 높게 잡되(maxDim 4096),
     *  엔지니어링 도면(선/텍스트 위주)은 PNG 가 JPEG보다 선명하고 용량도 작은 경우가 많아
     *  PNG/JPEG 중 더 작은 쪽을 자동 선택한다. 너무 크면 단계적으로 해상도를 낮춰 D1 저장 안정성 확보. */
    async snapshotAllPages(pdfDoc, maxDim = 4096, quality = 0.92) {
      const out = [];
      const SOFT_LIMIT = 2_600_000; // dataURL 문자수 상한 (≈2MB) — 초과 시 해상도 자동 강등
      for (let p = 1; p <= pdfDoc.numPages; p++) {
        const page = await pdfDoc.getPage(p);
        const base = page.getViewport({ scale: 1 });
        let dim = maxDim, q = quality, data = null;
        for (let attempt = 0; attempt < 4; attempt++) {
          const scale = Math.min(dim / Math.max(base.width, base.height), 4);
          const vp = page.getViewport({ scale });
          const cv = document.createElement("canvas");
          cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
          const ctx = cv.getContext("2d", { alpha: false });
          ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, cv.width, cv.height);
          await page.render({ canvasContext: ctx, viewport: vp }).promise;
          // 선화 도면은 PNG 가 더 선명/경량인 경우가 많음 → PNG·JPEG 중 작은 쪽 채택
          const png = cv.toDataURL("image/png");
          const jpg = cv.toDataURL("image/jpeg", q);
          data = (png.length <= jpg.length) ? png : jpg;
          if (data.length <= SOFT_LIMIT || dim <= 1600) break;
          // 용량 초과 → 해상도/품질 강등 후 재시도
          dim = Math.round(dim * 0.8); q = Math.max(0.8, q - 0.04);
        }
        out.push(data);
      }
      return out;
    }
  };

  /* ══════════════════════════════════════════
     LOG  — 사용자 액션 추적(로그인 이후 모든 주요 행위)
     서버 /api/client-log 로 비동기 전송. 실패해도 앱 흐름 방해 안 함.
  ══════════════════════════════════════════ */