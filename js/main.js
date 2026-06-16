/**
 * 360° Location Viewer System — We:are Marine  (v3)
 *
 * v3 주요 변경:
 *  - 360° 뷰어: CPU 픽셀루프 → Three.js WebGL (수십 배 빠름, 자동회전/줌/초기시점/전체화면 컨트롤)
 *  - 핀 생성 시 그림 파일 직접 업로드 + 저장 이름 지정 → 클라우드(테이블 API)에 영구 저장
 *  - 저장 직후 "다음 포인트 지정" 버튼으로 연속 배치 워크플로우
 *  - 핀 저장/선택 시 해당 위치로 플라이투(줌인 이동) 애니메이션 + 핀 드롭 모션
 *  - PDF 멀티페이지: 핀에 page 기록, 배포 시 전 페이지 스냅샷, 뷰어에서 페이지 전환 지원
 *
 * 의존: PDF.js 3.11.174 / Three.js 0.147.0 (모두 CDN)
 */

(function () {
  "use strict";

  /* ══════════════════════════════════════════
     STATE
  ══════════════════════════════════════════ */
  // [B5] 영상 핀 blob URL 추적 — reset/삭제 시 revoke 하여 메모리 누수 차단
  const _videoBlobs = [];
  function _trackVideoBlob(url) { if (url) _videoBlobs.push(url); }
  function _revokeVideoBlob(url) {
    if (!url) return;
    const i = _videoBlobs.indexOf(url);
    if (i !== -1) _videoBlobs.splice(i, 1);
    try { URL.revokeObjectURL(url); } catch (e) {}
  }
  function _revokeAllVideoBlobs() {
    _videoBlobs.splice(0).forEach(u => { try { URL.revokeObjectURL(u); } catch (e) {} });
  }

  const State = {
    mode:        null,      // 'designer' | 'viewer'
    fileType:    null,      // 'pdf' | 'image'
    fileName:    null,
    imageUrl:    null,      // blob URL (revoke on reset)
    fileData:    null,      // ArrayBuffer (PDF)
    pdfDoc:      null,
    pdfPage:     1,
    pdfPages:    0,
    pdfRotation: 0,         // 0 | 90 | 180 | 270 (PDF.js 내장 회전)
    viewerPages: null,      // 뷰어 모드: 배포본 페이지 dataURL 배열
    pins:        [],        // {id,x,y,page,label,imageUrl?,imageId?,imageName?}
    annotations: [],        // {id,page,type:'highlight'|'rect'|'pen'|'text',color,...좌표(%)} PDF 주석
    annoTool:    "cursor",  // 현재 주석 도구
    annoColor:   "#ff3b30", // 현재 주석 색상
    zones:       [],        // {id,page,x,y,w,h,label,color,pinIds[],note} 영역(%) 줌무관
    placing:     false,
    drawingZone: false,     // 영역 그리기 모드
    isoView:     false,     // ISO 3D 아이소메트릭 뷰 (평면↔입체 회전)
    pending:     null,      // { x, y }
    pendingFile: null,      // 선택된 360° 그림/영상 파일
    pendingIsVideo: false,
    pendingDocs: [],        // 첨부 문서 후보 [{tempId, file, name, size, kind, status, docId}]
    pendingFls:  null,      // 첨부된 3D 포인트클라우드 { localId, name, size }
    editingPinId: null,     // 기존 포인트 편집 중인 id (null=신규)
    movingPinId: null,      // 드래그로 위치 이동 중인 포인트 id
    pinEditUnlocked: null,  // '수정' 버튼으로 이동/편집 잠금 해제된 핀 id (이 id만 드래그 이동 가능)
    autoSaveDepId: null,    // 자동 저장된 배포본(작업본) id — 도면 업로드 즉시 생성
    autoSaving: false,      // 자동 저장 진행 중 플래그
    activePin:   null,
    zoom:        1,
    pan:         { x: 0, y: 0 },
    panDragging: false,
    panStart:    { mx: 0, my: 0, px: 0, py: 0 },
    viewerLocked: false,
    currentProjectId: null,
    currentProjectName: null,
    currentDeploymentId: null,   // 현재 로드된 배포본 id (노트/협업 연결용)
    noteSummary: {},             // { pin_id: {total,open,progress,done} } 도면 뱃지용

    reset() {
      if (this.imageUrl) { URL.revokeObjectURL(this.imageUrl); this.imageUrl = null; }
      _revokeAllVideoBlobs(); // [B5] 영상 핀 blob URL 일괄 해제
      this.fileType = null; this.fileName = null;
      this.fileData = null; this.pdfDoc = null;
      this.pdfPage = 1; this.pdfPages = 0; this.pdfRotation = 0; this.viewerPages = null;
      this.pins = []; this.zones = []; this.placing = false; this.drawingZone = false; this.pending = null;
      this.pendingFile = null; this.pendingIsVideo = false;
      this.pendingDocs = [];
      this.pendingFls = null;
      this.editingPinId = null; this.movingPinId = null;
      this.autoSaveDepId = null; this.autoSaving = false;
      this.activePin = null; this.zoom = 1; this.pan = { x: 0, y: 0 };
    }
  };

  /* ══════════════════════════════════════════
     PDF MODULE
  ══════════════════════════════════════════ */
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
      pending: null          // 디바운스 타이머
    },

    /** PDF.js 권장 렌더 한계(메모리/캔버스 면적). 모바일/저사양도 안전한 상한. */
    MAX_CANVAS_PX: 16777216,   // 4096×4096 ≈ 캔버스 최대 픽셀 (Safari 제한 고려)
    MAX_SIDE_HARD: 8192,       // 한 변 하드 상한

    async renderPage(pdfDoc, pageNum, canvas, scale = 1.5, rotation = 0) {
      const page = await pdfDoc.getPage(pageNum);
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
      let rs = renderScale;
      const maxBySide = this.MAX_SIDE_HARD / Math.max(baseVp.width, baseVp.height);
      const maxByArea = Math.sqrt(this.MAX_CANVAS_PX / (baseVp.width * baseVp.height));
      rs = Math.min(rs, maxBySide, maxByArea);
      rs = Math.max(rs, 0.1);
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

    /** 줌 변경 시 호출 — 현재 줌에 맞는 해상도로 PDF 재래스터화(디바운스).
     *  zoom = MapCtrl 의 State.zoom (CSS transform 배율). */
    requestZoomRerender(zoom) {
      const st = this._renderState;
      if (!st.pdfDoc) return;
      const canvas = document.getElementById("pdf-canvas");
      if (!canvas || canvas.classList.contains("hidden")) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      // 목표 렌더 스케일 = 논리스케일 × 줌 × dpr.
      // 즉 화면에 실제로 보이는 픽셀 밀도만큼 PDF 를 다시 그린다 → 항상 선명.
      const target = st.baseCssScale * Math.max(1, zoom) * dpr;
      // 이미 충분히 높은 해상도면(목표가 현재의 1.15배 미만) 재렌더 생략
      if (target <= st.renderScale * 1.15) return;
      clearTimeout(st.pending);
      st.pending = setTimeout(async () => {
        try {
          const page = await st.pdfDoc.getPage(st.pageNum);
          const rot = ((page.rotate || 0) + (st.rotation || 0)) % 360;
          await this._rasterize(page, canvas, target, rot, st.baseCssScale);
        } catch (e) {}
      }, 140);
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
  const Log = {
    /** action(화이트리스트), targetId?, detail? */
    push(action, targetId, detail) {
      try {
        // 로그인 안 된 상태면 서버가 401 → 조용히 무시됨
        fetch("/api/client-log", {
          method: "POST",
          headers: Auth.headers(),
          body: JSON.stringify({ action, targetId: targetId || undefined, detail: detail || undefined }),
          keepalive: true
        }).catch(() => {});
      } catch (e) {}
    }
  };

  /* ══════════════════════════════════════════
     CLOUD  — 360° 그림 파일 저장소 (RESTful Table API)
  ══════════════════════════════════════════ */
  const Cloud = {
    /** 업로드 목표 최대 용량(JPEG 바이트). THETA 고해상도도 D1에 안전히 저장되도록 제한 */
    MAX_UPLOAD_BYTES: 1400 * 1024, // ≈1.4MB (base64 환산 ≈1.9MB)

    /** File → 디코딩된 비트맵 소스(ImageBitmap 또는 HTMLImageElement) 반환
     *  THETA 등 고해상도/특수 JPEG도 안정적으로 읽도록 createImageBitmap 우선 사용,
     *  실패 시 HTMLImageElement로 폴백한다. */
    async _decode(file, targetMax = 4096) {
      // 1순위: createImageBitmap — 디코딩과 동시에 다운스케일하여 메모리 폭증/탭 크래시 방지.
      //  (THETA 등 5376×2688↑ 초고해상도 JPEG를 원본 그대로 디코딩하면 메모리 한계로 크래시)
      if (typeof createImageBitmap === "function") {
        // ⚠️ THETA 등 초고해상도 JPEG(6720×3360 등)를 createImageBitmap(file) 으로
        //    "원본 그대로" 디코딩하면 메모리 한계로 탭이 크래시(=업로드 hang)된다.
        //    따라서 절대 풀해상도 probe 를 하지 않고, 처음부터 resizeWidth 만 지정해
        //    비율을 유지한 채 축소 디코딩한다. (360° 도면은 가로가 장변인 2:1 파노라마)
        try {
          const bmp = await createImageBitmap(file, {
            imageOrientation: "from-image",
            resizeWidth: targetMax,        // 가로를 targetMax 이하로 (비율 자동 유지)
            resizeQuality: "high"
          });
          if (bmp && bmp.width && bmp.height) {
            // 혹시 세로가 더 긴 이미지면 면적이 클 수 있으니, draw 단계(resizeImage)에서
            // MAX_AREA 로 한 번 더 제한된다. 여기서는 안전한 비트맵만 반환.
            return { src: bmp, w: bmp.width, h: bmp.height, bitmap: true };
          }
        } catch (e) { /* 폴백으로 진행 */ }
      }
      // 2순위: HTMLImageElement (objectURL → 실패 시 dataURL)
      const tryImg = (srcUrl) => new Promise((resolve, reject) => {
        const img = new Image();
        const to = setTimeout(() => reject(new Error("timeout")), 20000);
        img.onload  = () => { clearTimeout(to); resolve(img); };
        img.onerror = () => { clearTimeout(to); reject(new Error("decode")); };
        img.src = srcUrl;
      });
      const objUrl = URL.createObjectURL(file);
      try {
        const img = await tryImg(objUrl);
        if (img.naturalWidth && img.naturalHeight)
          return { src: img, w: img.naturalWidth, h: img.naturalHeight, bitmap: false, _objUrl: objUrl };
        throw new Error("empty");
      } catch (e) {
        URL.revokeObjectURL(objUrl);
        // 3순위: FileReader → dataURL → Image (objectURL이 막힌 환경 대응)
        const dataUrl = await new Promise((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(r.result);
          r.onerror = () => rej(new Error("파일 읽기 실패"));
          r.readAsDataURL(file);
        });
        const img2 = await tryImg(dataUrl);
        if (img2.naturalWidth && img2.naturalHeight)
          return { src: img2, w: img2.naturalWidth, h: img2.naturalHeight, bitmap: false };
        throw new Error("이미지를 디코딩할 수 없습니다(지원하지 않는 형식일 수 있음)");
      }
    },

    /** File → 리사이즈 JPEG dataURL.
     *  장변 maxDim 이하로 줄이고, 목표 용량을 넘으면 품질/크기를 자동으로 낮춰 보장한다. */
    async resizeImage(file, maxDim = 4096, quality = 0.85) {
      if (!file) throw new Error("이미지 파일이 없습니다");

      let decoded;
      try {
        decoded = await this._decode(file, maxDim);
      } catch (e) {
        throw new Error("이미지 파일을 읽을 수 없습니다 (" + (e.message || "decode") + ")");
      }

      const draw = (targetMax, q) => {
        let w = decoded.w, h = decoded.h;
        // canvas 면적 제한(브라우저별 ~16M~268M px) 대응: 장변 + 면적 동시 제한
        const MAX_AREA = 24 * 1000 * 1000; // 2400만 px (≈ 6928px²)
        let ratio = Math.min(1, targetMax / Math.max(w, h));
        let aw = Math.round(w * ratio), ah = Math.round(h * ratio);
        if (aw * ah > MAX_AREA) {
          const ar = Math.sqrt(MAX_AREA / (aw * ah));
          aw = Math.round(aw * ar); ah = Math.round(ah * ar);
        }
        const cv = document.createElement("canvas");
        cv.width = aw; cv.height = ah;
        const ctx = cv.getContext("2d");
        if (!ctx) throw new Error("캔버스 컨텍스트를 만들 수 없습니다");
        ctx.drawImage(decoded.src, 0, 0, aw, ah);
        const durl = cv.toDataURL("image/jpeg", q);
        return { dataURL: durl, width: aw, height: ah };
      };

      // 1차 시도
      let dim = maxDim, q = quality;
      let out = draw(dim, q);
      if (!out.dataURL || out.dataURL.length < 100 || out.dataURL.indexOf("data:image/jpeg") !== 0) {
        throw new Error("이미지 인코딩에 실패했습니다(해상도가 너무 큼)");
      }

      // 목표 용량 초과 시: 품질 → 크기 순으로 단계적 축소
      const bytesOf = d => Math.floor((d.length - "data:image/jpeg;base64,".length) * 0.75);
      let guard = 0;
      while (bytesOf(out.dataURL) > this.MAX_UPLOAD_BYTES && guard < 8) {
        guard++;
        if (q > 0.55) q -= 0.1;          // 먼저 품질을 낮추고
        else { dim = Math.round(dim * 0.8); q = 0.7; } // 그래도 크면 해상도를 줄임
        out = draw(dim, Math.max(0.4, q));
      }

      // 비트맵 자원 정리
      if (decoded.bitmap && decoded.src.close) { try { decoded.src.close(); } catch (e) {} }
      if (decoded._objUrl) { try { URL.revokeObjectURL(decoded._objUrl); } catch (e) {} }

      return out;
    },

    /** 업로드 → 레코드 id 반환 (타임아웃·명확한 오류 처리 포함) */
    async uploadImage(name, dataURL, width, height) {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 60000); // 최대 60초
      let res;
      try {
        res = await fetch("/tables/pano_images", {
          method: "POST",
          headers: Auth.headers(),
          body: JSON.stringify({ name, image_data: dataURL, width, height }),
          signal: ctrl.signal
        });
      } catch (e) {
        clearTimeout(to);
        if (e.name === "AbortError") throw new Error("업로드 시간 초과(네트워크가 느리거나 파일이 큽니다)");
        throw new Error("네트워크 오류: " + (e.message || e));
      }
      clearTimeout(to);
      if (!res.ok) {
        let detail = "";
        try { detail = (await res.text()).slice(0, 120); } catch (e) {}
        throw new Error("서버 저장 실패 (HTTP " + res.status + (detail ? " · " + detail : "") + ")");
      }
      let rec;
      try { rec = await res.json(); } catch (e) { throw new Error("서버 응답을 해석할 수 없습니다"); }
      if (!rec || !rec.id) throw new Error("서버가 이미지 ID를 반환하지 않았습니다");
      return rec.id;
    },

    /** id → dataURL (간단 메모리 캐시) */
    _cache: {},
    async fetchImage(id) {
      if (this._cache[id]) return this._cache[id];
      const res = await fetch("/tables/pano_images/" + encodeURIComponent(id));
      if (!res.ok) throw new Error("저장된 이미지를 불러올 수 없습니다 (HTTP " + res.status + ")");
      const rec = await res.json();
      if (!rec.image_data) throw new Error("이미지 데이터가 비어 있습니다");
      this._cache[id] = rec.image_data;
      return rec.image_data;
    },

    /* ── 첨부 문서(PDF/Word 등) — pano_images 테이블을 범용 dataURL 저장소로 재사용 ── */
    /** 단일 첨부 최대 용량(원본 바이트). D1 안전 한도 내. */
    MAX_DOC_BYTES: 3 * 1024 * 1024, // 3MB (base64 환산 ≈4MB)

    /** File → base64 dataURL (그대로, 무손실) */
    fileToDataURL(file) {
      return new Promise((res, rej) => {
        const r = new FileReader();
        r.onload  = () => res(r.result);
        r.onerror = () => rej(new Error("파일 읽기 실패"));
        r.readAsDataURL(file);
      });
    },

    /** 문서 업로드 → docId 반환. name 에 표시명 그대로 저장. */
    async uploadDoc(name, dataURL) {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 60000);
      let res;
      try {
        res = await fetch("/tables/pano_images", {
          method: "POST",
          headers: Auth.headers(),
          body: JSON.stringify({ name: "[doc] " + name, image_data: dataURL }),
          signal: ctrl.signal
        });
      } catch (e) {
        clearTimeout(to);
        if (e.name === "AbortError") throw new Error("업로드 시간 초과(파일이 큽니다)");
        throw new Error("네트워크 오류: " + (e.message || e));
      }
      clearTimeout(to);
      if (!res.ok) {
        let detail = "";
        try { detail = (await res.text()).slice(0, 120); } catch (e) {}
        throw new Error("문서 저장 실패 (HTTP " + res.status + (detail ? " · " + detail : "") + ")");
      }
      const rec = await res.json();
      if (!rec || !rec.id) throw new Error("서버가 문서 ID를 반환하지 않았습니다");
      this._cache[rec.id] = dataURL; // 즉시 다운로드 캐시
      return rec.id;
    },

    /** docId → dataURL */
    async fetchDoc(id) {
      if (this._cache[id]) return this._cache[id];
      const res = await fetch("/tables/pano_images/" + encodeURIComponent(id));
      if (!res.ok) throw new Error("첨부 문서를 불러올 수 없습니다 (HTTP " + res.status + ")");
      const rec = await res.json();
      if (!rec.image_data) throw new Error("문서 데이터가 비어 있습니다");
      this._cache[id] = rec.image_data;
      return rec.image_data;
    }
  };

  /* ══════════════════════════════════════════
     SyncQueue — 오프라인 우선 동기화 큐 (IndexedDB)
     · 핀의 미디어/문서 업로드를 "작업(op)"으로 로컬에 영구 보관한다.
     · 온라인이면 즉시 서버로 일괄(batch) 업로드, 오프라인이면 큐에 쌓아두고
       'online' 이벤트(=WiFi/인터넷 복구) 시 자동으로 전체 업로드/업데이트한다.
     · 스마트폰에서 인터넷이 끊겨도 핀 등록이 가능하며, 새로고침 후에도 큐가 유지된다.
     · 서버 의존 없는 안정 설계: IndexedDB 미지원 환경은 localStorage 폴백.
  ══════════════════════════════════════════ */
  const SyncQueue = {
    DB_NAME: "wm_sync",
    STORE: "ops",
    _db: null,
    _syncing: false,
    _listeners: [],

    /** 상태 변경 구독 (배지 갱신용) */
    onChange(fn) { this._listeners.push(fn); },
    _emit() {
      this.count().then(n => {
        this._listeners.forEach(fn => { try { fn(n, navigator.onLine); } catch (e) {} });
      });
    },

    async _open() {
      if (this._db) return this._db;
      if (!("indexedDB" in window)) return null; // localStorage 폴백 사용
      this._db = await new Promise((res, rej) => {
        const req = indexedDB.open(this.DB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(this.STORE)) {
            db.createObjectStore(this.STORE, { keyPath: "opId" });
          }
        };
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error || new Error("indexedDB open failed"));
      }).catch(() => null);
      return this._db;
    },

    /* ── localStorage 폴백 ── */
    _lsKey() { return "wm_sync_ops"; },
    _lsAll() { try { return JSON.parse(localStorage.getItem(this._lsKey()) || "[]"); } catch (e) { return []; } },
    _lsSet(arr) { try { localStorage.setItem(this._lsKey(), JSON.stringify(arr)); } catch (e) {} },

    /** op 추가 — {opId, kind:'image'|'doc', name, image_data, width?, height?, meta?} */
    async enqueue(op) {
      op.opId = op.opId || ("op" + Date.now() + Math.random().toString(36).slice(2, 8));
      op.createdAt = Date.now();
      op.status = "pending";
      const db = await this._open();
      if (db) {
        await new Promise((res, rej) => {
          const tx = db.transaction(this.STORE, "readwrite");
          tx.objectStore(this.STORE).put(op);
          tx.oncomplete = res; tx.onerror = () => rej(tx.error);
        });
      } else {
        const all = this._lsAll(); all.push(op); this._lsSet(all);
      }
      this._emit();
      return op.opId;
    },

    async all() {
      const db = await this._open();
      if (db) {
        return await new Promise((res) => {
          const tx = db.transaction(this.STORE, "readonly");
          const rq = tx.objectStore(this.STORE).getAll();
          rq.onsuccess = () => res(rq.result || []);
          rq.onerror = () => res([]);
        });
      }
      return this._lsAll();
    },

    async count() {
      const all = await this.all();
      return all.filter(o => o.status !== "done").length;
    },

    async _remove(opId) {
      const db = await this._open();
      if (db) {
        await new Promise((res) => {
          const tx = db.transaction(this.STORE, "readwrite");
          tx.objectStore(this.STORE).delete(opId);
          tx.oncomplete = res; tx.onerror = res;
        });
      } else {
        this._lsSet(this._lsAll().filter(o => o.opId !== opId));
      }
    },

    /** 전체 큐를 서버로 일괄 업로드/업데이트. 결과: {ok, uploaded, failed, map:{opId:serverId}} */
    async flush() {
      if (this._syncing) return { ok: false, busy: true };
      if (!navigator.onLine) return { ok: false, offline: true };
      const pending = (await this.all()).filter(o => o.status !== "done");
      if (pending.length === 0) { this._emit(); return { ok: true, uploaded: 0, map: {} }; }

      this._syncing = true; this._emit();
      const map = {};
      let uploaded = 0, failed = 0;
      try {
        // 한 번에 너무 큰 페이로드 방지 — 청크로 분할 업로드
        const CHUNK = 4;
        for (let i = 0; i < pending.length; i += CHUNK) {
          const batch = pending.slice(i, i + CHUNK).map(o => ({
            opId: o.opId, kind: o.kind, name: o.name,
            image_data: o.image_data, width: o.width, height: o.height
          }));
          let res;
          try {
            res = await fetch("/api/sync/batch", {
              method: "POST",
              headers: Auth.headers(),
              body: JSON.stringify({ ops: batch })
            });
          } catch (e) { failed += batch.length; break; } // 네트워크 단절 → 다음 online 때 재시도
          if (!res.ok) { failed += batch.length; break; }
          const data = await res.json();
          for (const r of (data.results || [])) {
            if (r.ok && r.id) { map[r.opId] = r.id; uploaded++; await this._remove(r.opId); }
            else { failed++; }
          }
        }
      } finally {
        this._syncing = false; this._emit();
      }
      return { ok: failed === 0, uploaded, failed, map };
    },

    /** online 복구 시 자동 일괄 동기화 시작 */
    init() {
      window.addEventListener("online", () => { this.flush().then(r => {
        if (r && r.uploaded > 0 && typeof App !== "undefined") App._onSyncDone(r);
      }); });
      window.addEventListener("offline", () => this._emit());
      // 초기 1회 + 주기적 재시도(앱이 열려 있는 동안 백그라운드 동기화)
      this._emit();
      if (navigator.onLine) this.flush();
      setInterval(() => { if (navigator.onLine) this.flush(); }, 30000);
    }
  };

  /* 파일 종류 헬퍼 — 아이콘/라벨용 */
  function docKind(nameOrMime) {
    const s = (nameOrMime || "").toLowerCase();
    if (/\.pdf|pdf/.test(s)) return { type: "pdf", label: "PDF", color: "#f87171" };
    if (/\.docx?|word|officedocument\.wordprocessing|msword/.test(s)) return { type: "word", label: "WORD", color: "#60a5fa" };
    if (/\.xlsx?|sheet|excel/.test(s)) return { type: "excel", label: "XLS", color: "#34d399" };
    if (/\.pptx?|presentation|powerpoint/.test(s)) return { type: "ppt", label: "PPT", color: "#fb923c" };
    if (/\.txt|text\/plain/.test(s)) return { type: "txt", label: "TXT", color: "#cbd5e1" };
    if (/\.(png|jpe?g|gif|webp|bmp)|^image\//.test(s)) return { type: "img", label: "IMG", color: "#a78bfa" };
    return { type: "file", label: "FILE", color: "#94a3b8" };
  }
  function fmtBytes(n) {
    if (!n) return "";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
    return (n / 1024 / 1024).toFixed(1) + " MB";
  }

  /* ══════════════════════════════════════════
     PANO VIEWER  — Three.js WebGL (고속)
  ══════════════════════════════════════════ */
  const PanoViewer = {
    S: { lon: 0, lat: 0, fov: 75, dragging: false, lx: 0, ly: 0, autoRotate: false },
    renderer: null, scene: null, camera: null, mesh: null, texture: null,
    videoEl: null, rafId: null, canvas: null, open: false, _currentPin: null,

    init(canvas) { this.canvas = canvas; },

    /** 확장자/MIME으로 360° 영상 여부 판단 후 적절한 로더 호출 */
    loadMedia(src, locationName, isVideo) {
      if (typeof Log !== "undefined") Log.push("pano.open", null, { name: locationName || "" });
      const looksVideo = isVideo === true ||
        (typeof src === "string" && /\.(mp4|webm|mov)(\?|#|$)/i.test(src));
      if (looksVideo) this.loadVideo(src, locationName);
      else this.load(src, locationName);
    },

    _ensureGL() {
      if (this.renderer) return true;
      if (!window.THREE) return false;
      try {
        this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        this.scene  = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 1100);
        const geo = new THREE.SphereGeometry(500, 60, 40);
        geo.scale(-1, 1, 1); // 구 내부에서 보기
        this.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x000000 }));
        this.scene.add(this.mesh);
        return true;
      } catch (e) { this.renderer = null; return false; }
    },

    load(src, locationName) {
      const $ = id => document.getElementById(id);
      this.S = { lon: 0, lat: 0, fov: 75, dragging: false, lx: 0, ly: 0, autoRotate: false };

      $("pano-location-name").textContent = "360° — " + locationName;
      $("pano-loading").classList.remove("hidden");
      $("pano-error").classList.add("hidden");
      $("pano-canvas").classList.add("hidden");
      $("pano-hint").classList.add("hidden");
      $("pano-controls").classList.add("hidden");
      $("pano-overlay").classList.remove("hidden");
      this.open = true;

      if (!this._ensureGL()) {
        this._showError(src, "WebGL을 사용할 수 없는 환경입니다");
        return;
      }

      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        if (!this.open) return;
        this.isVideo = false; // 정지 이미지 → 온디맨드 렌더
        if (this.texture) this.texture.dispose();
        this.texture = new THREE.Texture(img);
        this.texture.needsUpdate = true;
        this.texture.minFilter = THREE.LinearFilter;
        this.mesh.material.dispose();
        this.mesh.material = new THREE.MeshBasicMaterial({ map: this.texture });

        $("pano-loading").classList.add("hidden");
        $("pano-canvas").classList.remove("hidden");
        $("pano-hint").classList.remove("hidden");
        $("pano-controls").classList.remove("hidden");
        this._resize();
        this._startLoop();
      };
      img.onerror = () => {
        const isExternal = /^https?:\/\//i.test(src) && !src.startsWith(location.origin);
        this._showError(src, isExternal
          ? "외부 이미지 로드 실패 — CORS 차단 또는 잘못된 URL"
          : "이미지를 불러올 수 없습니다");
        if (isExternal) {
          const hint = document.querySelector("#pano-error .pano-error-hint");
          if (hint) hint.textContent =
            "이 이미지 서버가 외부 접근(CORS)을 막고 있습니다. " +
            "설계자 모드에서 '그림 파일 선택'으로 직접 업로드하면 클라우드 저장되어 항상 표시됩니다.";
        }
      };
      img.src = src;
    },

    /** Ricoh THETA 등 360° equirectangular .mp4 → VideoTexture (GPU) */
    loadVideo(src, locationName) {
      const $ = id => document.getElementById(id);
      this.S = { lon: 0, lat: 0, fov: 75, dragging: false, lx: 0, ly: 0, autoRotate: false };

      $("pano-location-name").textContent = "360° ▶ " + locationName;
      $("pano-loading").classList.remove("hidden");
      $("pano-error").classList.add("hidden");
      $("pano-canvas").classList.add("hidden");
      $("pano-hint").classList.add("hidden");
      $("pano-controls").classList.add("hidden");
      $("pano-overlay").classList.remove("hidden");
      this.open = true;

      if (!this._ensureGL()) { this._showError(src, "WebGL을 사용할 수 없는 환경입니다"); return; }

      this._disposeVideo();
      const video = document.createElement("video");
      video.crossOrigin = "anonymous";
      video.loop = true;
      video.muted = true;          // 자동재생 정책 충족
      video.playsInline = true;
      video.setAttribute("playsinline", "");
      video.setAttribute("webkit-playsinline", "");
      this.videoEl = video;

      video.addEventListener("loadeddata", () => {
        if (!this.open) return;
        this.isVideo = true; // 영상 → 매 프레임 렌더
        if (this.texture) this.texture.dispose();
        this.texture = new THREE.VideoTexture(video);
        this.texture.minFilter = THREE.LinearFilter;
        this.texture.magFilter = THREE.LinearFilter;
        this.mesh.material.dispose();
        this.mesh.material = new THREE.MeshBasicMaterial({ map: this.texture });

        $("pano-loading").classList.add("hidden");
        $("pano-canvas").classList.remove("hidden");
        $("pano-hint").classList.remove("hidden");
        $("pano-controls").classList.remove("hidden");
        this._resize();
        this._startLoop();
        video.play().catch(() => {/* 사용자 제스처 후 재생됨 */});
      }, { once: true });
      video.addEventListener("error", () => this._showError(src, "360° 영상을 불러올 수 없습니다 (코덱/CORS 확인)"));

      video.src = src;
      video.load();
    },

    _disposeVideo() {
      if (this.videoEl) {
        try { this.videoEl.pause(); } catch (e) {}
        this.videoEl.removeAttribute("src");
        this.videoEl.load && this.videoEl.load();
        this.videoEl = null;
      }
    },

    _showError(url, msg) {
      const $ = id => document.getElementById(id);
      $("pano-loading").classList.add("hidden");
      $("pano-error").classList.remove("hidden");
      $("pano-error").querySelector(".pano-error-msg").textContent = msg;
      $("pano-error-url").textContent = (url || "").slice(0, 120);
    },

    _resize() {
      if (!this.renderer) return;
      const W = window.innerWidth, H = window.innerHeight;
      this.renderer.setSize(W, H, false);
      this.camera.aspect = W / H;
      this.camera.updateProjectionMatrix();
      this._invalidate();
    },

    _startLoop() {
      cancelAnimationFrame(this.rafId);
      this._dirty = true; // 첫 프레임은 반드시 렌더
      if (!this._tgt) this._tgt = new THREE.Vector3(); // 재사용(매 프레임 GC 방지)
      const loop = () => {
        if (!this.open) return;
        // 자동회전/영상은 매 프레임 갱신, 그 외엔 변경(_dirty) 있을 때만 렌더 → CPU/GPU 절약 = 빠름
        if (this.S.autoRotate && !this.S.dragging) { this.S.lon += 0.06; this._dirty = true; }
        if (this.isVideo) this._dirty = true;
        if (this._dirty) { this._renderFrame(); this._dirty = false; }
        this.rafId = requestAnimationFrame(loop);
      };
      loop();
    },

    _invalidate() { this._dirty = true; },

    _renderFrame() {
      if (!this.renderer) return;
      const S = this.S;
      S.lat = Math.max(-85, Math.min(85, S.lat));
      const phi   = THREE.MathUtils.degToRad(90 - S.lat);
      const theta = THREE.MathUtils.degToRad(S.lon);
      const t = this._tgt || (this._tgt = new THREE.Vector3());
      t.set(
        500 * Math.sin(phi) * Math.cos(theta),
        500 * Math.cos(phi),
        500 * Math.sin(phi) * Math.sin(theta)
      );
      this.camera.lookAt(t);
      this.camera.fov = S.fov;
      this.camera.updateProjectionMatrix();
      this.renderer.render(this.scene, this.camera);
      // 레이더 부채꼴을 현재 시야(yaw=lon)에 맞춰 회전
      Radar.spin(S.lon, S.fov);
    },

    /* ── 컨트롤 ── */
    setFov(delta) { this.S.fov = Math.max(30, Math.min(110, this.S.fov + delta)); this._invalidate(); },
    resetView()   { this.S.lon = 0; this.S.lat = 0; this.S.fov = 75; this._invalidate(); },
    /** ISO 코너 뷰: 4개 모서리(꼭지점) 시점으로 전환. corner 0~3 = 좌상/우상/우하/좌하 느낌.
     *  부드러운 전환을 위해 목표각으로 애니메이션 보간. */
    setIsoView(corner) {
      // 4개 꼭지점 방위각(yaw): 45/135/225/315°, 약간 내려보는 피치(-28°)로 등각 느낌
      const yaws = [45, 135, 225, 315];
      const c = ((corner % 4) + 4) % 4;
      this._isoCorner = c;
      const targetLon = yaws[c];
      const targetLat = -28;
      const targetFov = 82; // 등각투상 느낌의 약간 넓은 화각
      // 현재값 → 목표값 부드럽게(최단 회전 경로)
      const startLon = this.S.lon, startLat = this.S.lat, startFov = this.S.fov;
      let dLon = ((targetLon - (startLon % 360)) + 540) % 360 - 180;
      const t0 = performance.now(), dur = 480;
      if (this._isoRaf) cancelAnimationFrame(this._isoRaf);
      const step = (now) => {
        const k = Math.min(1, (now - t0) / dur);
        const e = k < .5 ? 2*k*k : 1-Math.pow(-2*k+2,2)/2; // easeInOutQuad
        this.S.lon = startLon + dLon * e;
        this.S.lat = startLat + (targetLat - startLat) * e;
        this.S.fov = startFov + (targetFov - startFov) * e;
        this._invalidate();
        if (k < 1) this._isoRaf = requestAnimationFrame(step);
      };
      this._isoRaf = requestAnimationFrame(step);
      return c;
    },
    toggleAuto()  { this.S.autoRotate = !this.S.autoRotate; this._invalidate(); return this.S.autoRotate; },

    onPointerDown(x, y) { this.S.dragging = true; this.S.lx = x; this.S.ly = y; },
    onPointerMove(x, y) {
      if (!this.S.dragging) return;
      const k = this.S.fov / 500; // FOV 비례 감도
      this.S.lon += (this.S.lx - x) * k;
      this.S.lat += (y - this.S.ly) * k;
      this.S.lx = x; this.S.ly = y;
      this._invalidate();
    },
    onPointerUp() { this.S.dragging = false; },
    onWheel(e)    { e.preventDefault(); this.setFov(e.deltaY * 0.05); },

    close() {
      this.open = false;
      this._currentPin = null;
      cancelAnimationFrame(this.rafId);
      this._disposeVideo();
      document.getElementById("pano-overlay").classList.add("hidden");
      const ip = document.getElementById("pano-info-panel");
      if (ip) { ip.classList.add("hidden"); ip.innerHTML = ""; }
      if (typeof Notes !== "undefined") Notes.closePanel();  // 노트 패널 함께 닫기
      if (typeof TimeLapse !== "undefined") TimeLapse.hide();
      if (typeof Compare !== "undefined") Compare.close();
      if (typeof FLS !== "undefined") FLS.close();  // FLS 3D 패널 함께 닫기
      const ov2 = document.getElementById("pano-overlay");
      if (ov2) ov2.classList.remove("with-fls");
      Radar.hide();
      PanoNav.hide();
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    }
  };

  /* ══════════════════════════════════════════
     RADAR — 파노라마 내 도면 미니맵 + 시야 부채꼴 (3DVista radar 참고)
  ══════════════════════════════════════════ */
  const Radar = {
    _pin: null,

    /** 현재 핀 기준으로 미니맵(도면 썸네일+핀들) 렌더 */
    update(pin) {
      this._pin = pin;
      const box = document.getElementById("pano-radar");
      if (!box) return;
      // 현재 페이지의 도면 이미지 소스 확보 (뷰어/디자이너 공통)
      const mapSrc = this._currentMapSrc();
      if (!mapSrc) { this.hide(); return; }

      const page = pin.page || 1;
      const imgEl = document.getElementById("pano-radar-map");
      if (imgEl && imgEl.src !== mapSrc) imgEl.src = mapSrc;
      const pageEl = document.getElementById("pano-radar-page");
      if (pageEl) pageEl.textContent = "p." + page;

      // 같은 페이지의 핀들을 점으로 표시
      const pinsLayer = document.getElementById("pano-radar-pins");
      if (pinsLayer) {
        pinsLayer.innerHTML = "";
        (State.pins || []).filter(p => (p.page || 1) === page).forEach(p => {
          const dot = document.createElement("div");
          dot.className = "pano-radar-pin" + (p.id === pin.id ? " current" : "");
          dot.style.left = p.x + "%";
          dot.style.top  = p.y + "%";
          dot.title = p.label || "";
          dot.addEventListener("click", (e) => { e.stopPropagation(); if (p.id !== pin.id && App.pinHasContent(p)) App.openPano(p); });
          pinsLayer.appendChild(dot);
        });
      }
      // 시야 부채꼴을 현재 핀 위치로 이동
      const cone = document.getElementById("pano-radar-cone");
      if (cone) { cone.style.left = pin.x + "%"; cone.style.top = pin.y + "%"; }

      box.classList.remove("hidden");
    },

    /** 시야 방향(yaw=lon) + FOV에 맞춰 부채꼴 회전/너비 */
    spin(lon, fov) {
      const fan = document.querySelector("#pano-radar-cone .pano-radar-fan");
      if (!fan) return;
      // lon(deg): 0 = +Z 방향. 도면 위 "위(12시)"를 기준으로 회전시킨다.
      // conic-gradient가 -35°~+35°(약 70°) 부채꼴이므로 회전만 적용.
      fan.style.transform = "rotate(" + (lon) + "deg)";
    },

    /** 현재 표시 중인 도면(페이지) 이미지 src */
    _currentMapSrc() {
      // 뷰어 모드: 배포본 페이지 이미지
      if (State.mode === "viewer" && State.viewerPages && State.viewerPages.length) {
        const idx = (State.pdfPage || 1) - 1;
        return State.viewerPages[idx] || State.viewerPages[0] || null;
      }
      // 디자이너 모드: 이미지 도면이면 그대로
      const mapImg = document.getElementById("map-image");
      if (mapImg && !mapImg.classList.contains("hidden") && mapImg.src) return mapImg.src;
      // PDF 캔버스 → dataURL 캐시 (한 번만 생성)
      const pdfCanvas = document.getElementById("pdf-canvas");
      if (pdfCanvas && !pdfCanvas.classList.contains("hidden")) {
        try {
          const key = "p" + (State.pdfPage || 1);
          this._pdfCache = this._pdfCache || {};
          if (!this._pdfCache[key]) this._pdfCache[key] = pdfCanvas.toDataURL("image/jpeg", 0.6);
          return this._pdfCache[key];
        } catch (e) { return null; }
      }
      return null;
    },

    hide() { const b = document.getElementById("pano-radar"); if (b) b.classList.add("hidden"); }
  };

  /* ══════════════════════════════════════════
     PANO NAV — 파노라마 내 이전/다음 포인트 이동 (탐색 핫스팟)
  ══════════════════════════════════════════ */
  const PanoNav = {
    _list: [], _idx: -1,

    init() {
      const $ = (id) => document.getElementById(id);
      $("btn-pano-prev") && $("btn-pano-prev").addEventListener("click", () => this.go(-1));
      $("btn-pano-next") && $("btn-pano-next").addEventListener("click", () => this.go(1));
    },

    /** 현재 핀 기준으로 같은 페이지의 "콘텐츠 있는" 핀 목록 + 위치 갱신 */
    update(pin) {
      const page = pin.page || 1;
      this._list = (State.pins || [])
        .filter(p => (p.page || 1) === page && App.pinHasContent(p));
      this._idx = this._list.findIndex(p => p.id === pin.id);
      const box = document.getElementById("pano-nav");
      if (!box) return;
      if (this._list.length <= 1) { box.classList.add("hidden"); return; }
      box.classList.remove("hidden");
      const label = document.getElementById("pano-nav-label");
      if (label) label.textContent = (this._idx + 1) + " / " + this._list.length;
      const prev = document.getElementById("btn-pano-prev");
      const next = document.getElementById("btn-pano-next");
      if (prev) prev.disabled = this._idx <= 0;
      if (next) next.disabled = this._idx >= this._list.length - 1;
    },

    go(delta) {
      const ni = this._idx + delta;
      if (ni < 0 || ni >= this._list.length) return;
      const target = this._list[ni];
      if (target) App.openPano(target);
    },

    hide() { const b = document.getElementById("pano-nav"); if (b) b.classList.add("hidden"); }
  };

  /* ══════════════════════════════════════════
     FLS — FARO 포인트 클라우드(LiDAR) 직접 로드/표출 (Three.js)
       · 표준 포맷(.ply/.pcd/.xyz/.pts/.las/.laz) → 브라우저에서 100% 직접 파싱·렌더
       · .fls(FARO 독점) → 헤더 best-effort + 변환 안내 (FARO SCENE → e57/las)
       · 360 파노라마와 나란히(split) 표시. 안정성 최우선: 점 개수 상한·다운샘플.
  ══════════════════════════════════════════ */
  const FLS = {
    MAX_POINTS: 1_800_000,     // 렌더 안정 상한 (초과 시 균등 다운샘플)
    renderer: null, scene: null, camera: null, points: null,
    _raf: null, _drag: null, _rot: { theta: 0.6, phi: 1.1, r: 3 },
    _target: { x: 0, y: 0, z: 0 }, _inited: false, _ro: null,

    SUPPORTED: ["ply", "pcd", "xyz", "pts", "asc", "txt", "las", "laz", "fls", "e57"],

    extOf(name) { return (name || "").split(".").pop().toLowerCase(); },
    isSupported(name) { return this.SUPPORTED.includes(this.extOf(name)); },

    _el(id) { return document.getElementById(id); },
    _show(which) {
      ["fls-loading", "fls-empty", "fls-error", "fls-stats"].forEach(id => {
        const e = this._el(id); if (e) e.classList.add("hidden");
      });
      const t = this._el(which); if (t) t.classList.remove("hidden");
    },

    /** 3D 패널 표시/숨김 */
    showPane(show) {
      const p = this._el("fls-pane");
      if (!p) return;
      p.classList.toggle("hidden", !show);
      if (show) {
        this._ensureRenderer();
        setTimeout(() => this._resize(), 30);
      }
    },

    /** 핀에 연결된 포인트클라우드가 있으면 로드. 없으면 empty 패널. */
    async openForPin(pin) {
      this.showPane(true);
      const src = pin && (pin.flsUrl || pin.fls);
      const name = pin && (pin.flsName || pin.flsUrl || "");
      const localData = pin && pin.flsLocalId ? Cloud._cache && Cloud._cache["fls:" + pin.flsLocalId] : null;
      if (!src && !localData) { this._show("fls-empty"); return; }
      try {
        this._show("fls-loading");
        let buf;
        if (localData) { buf = localData; }
        else {
          const res = await fetch(src);
          if (!res.ok) throw new Error("HTTP " + res.status);
          buf = await res.arrayBuffer();
        }
        await this.loadBuffer(buf, name || src);
      } catch (e) {
        this._showError("로드 실패", e.message || String(e));
      }
    },

    _showError(t, h) {
      this._show("fls-error");
      const et = this._el("fls-error-t"), eh = this._el("fls-error-h");
      if (et) et.textContent = t;
      if (eh) eh.textContent = h || "";
    },

    /** ArrayBuffer + 파일명 → 파싱 후 렌더 */
    async loadBuffer(buf, name) {
      const ext = this.extOf(name);
      const badge = this._el("fls-fmt-badge");
      if (badge) badge.textContent = ext ? ("." + ext) : "";
      let parsed = null;
      try {
        if (ext === "ply") parsed = this._parsePLY(buf);
        else if (ext === "pcd") parsed = this._parsePCD(buf);
        else if (["xyz", "pts", "asc", "txt"].includes(ext)) parsed = this._parseXYZ(buf);
        else if (ext === "las" || ext === "laz") parsed = this._parseLAS(buf, ext);
        else if (ext === "fls" || ext === "e57") parsed = this._parseFLS(buf, ext);
        else parsed = this._sniff(buf);
      } catch (e) {
        return this._showError("파싱 실패", (e && e.message) || "지원되지 않는 형식일 수 있습니다.");
      }
      if (!parsed || !parsed.count) {
        if (ext === "fls") {
          // ── 요청 #9: FLS 직접 로드 실패 → E57로 변경 등록 안내 ──
          return this._showError(
            "1단계: .fls 직접 로드 실패 — E57로 변경 등록하세요",
            "FARO .fls 는 독점 포맷이라 브라우저에서 직접 열 수 없습니다. " +
            "FARO SCENE에서 [내보내기 → E57] 로 변환한 .e57 파일을 다시 첨부하면 바로 표시됩니다. " +
            "(.e57 도 열리지 않으면 .las/.laz/.ply 로 추가 변환해 보세요. 그래도 안 되면 3D는 표시할 수 없습니다.)"
          );
        }
        if (ext === "e57") {
          // ── 요청 #9: E57 도 실패 → 둘 다 안 되면 포기(추가 변환 안내) ──
          return this._showError(
            "2단계: .e57 로드 실패 — 추가 변환이 필요합니다",
            "이 .e57 컨테이너는 직접 파싱이 어렵습니다. CloudCompare 등에서 .las/.laz/.ply/.pcd 로 다시 내보내 첨부해 주세요. " +
            "변환본도 열리지 않으면 해당 스캔의 3D 표시는 지원되지 않습니다(포기)."
          );
        }
        return this._showError("표시할 점이 없습니다", "파일이 비었거나 좌표 데이터를 찾지 못했습니다.");
      }
      this._render(parsed);
    },

    /* ── 파서들 (positions: Float32Array[xyz*n], colors: Float32Array|null) ── */

    _decim(posArr, colArr) {
      // 점 개수 상한 초과 시 균등 다운샘플 (안정성)
      const n = posArr.length / 3;
      if (n <= this.MAX_POINTS) return { positions: posArr, colors: colArr, count: n };
      const step = n / this.MAX_POINTS;
      const outN = Math.floor(this.MAX_POINTS);
      const pos = new Float32Array(outN * 3);
      const col = colArr ? new Float32Array(outN * 3) : null;
      for (let i = 0; i < outN; i++) {
        const si = Math.floor(i * step);
        pos[i * 3] = posArr[si * 3]; pos[i * 3 + 1] = posArr[si * 3 + 1]; pos[i * 3 + 2] = posArr[si * 3 + 2];
        if (col) { col[i * 3] = colArr[si * 3]; col[i * 3 + 1] = colArr[si * 3 + 1]; col[i * 3 + 2] = colArr[si * 3 + 2]; }
      }
      return { positions: pos, colors: col, count: outN };
    },

    _parseXYZ(buf) {
      const txt = new TextDecoder().decode(buf);
      const lines = txt.split(/\r?\n/);
      const pos = [], col = [];
      let hasColor = false;
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i].trim();
        if (!l || l[0] === "#" || /[a-df-zA-DF-Z]/.test(l[0])) continue; // 헤더/주석 스킵 (e는 지수표기 허용)
        const t = l.split(/[\s,;]+/).map(Number);
        if (t.length < 3 || !isFinite(t[0]) || !isFinite(t[1]) || !isFinite(t[2])) continue;
        pos.push(t[0], t[1], t[2]);
        if (t.length >= 6) {
          hasColor = true;
          // 색이 0~255 면 정규화
          const r = t[3] > 1 ? t[3] / 255 : t[3], g = t[4] > 1 ? t[4] / 255 : t[4], b = t[5] > 1 ? t[5] / 255 : t[5];
          col.push(r, g, b);
        } else col.push(0.7, 0.8, 0.95);
      }
      return this._decim(new Float32Array(pos), hasColor ? new Float32Array(col) : null);
    },

    _parsePCD(buf) {
      // ASCII PCD 우선 지원 (binary 는 best-effort)
      const head = new TextDecoder().decode(buf.slice(0, 2048));
      const fieldsM = head.match(/FIELDS (.+)/i);
      const dataM = head.match(/DATA (\w+)/i);
      const pointsM = head.match(/POINTS (\d+)/i);
      const fields = fieldsM ? fieldsM[1].trim().split(/\s+/) : ["x", "y", "z"];
      const xi = fields.indexOf("x"), yi = fields.indexOf("y"), zi = fields.indexOf("z");
      const rgbi = fields.findIndex(f => /rgb/i.test(f));
      const dataType = dataM ? dataM[1].toLowerCase() : "ascii";
      const headerEnd = head.indexOf("DATA");
      const bodyStart = buf.bytelength ? 0 : 0;
      if (dataType === "ascii") {
        const fullTxt = new TextDecoder().decode(buf);
        const after = fullTxt.slice(fullTxt.indexOf("DATA ascii") + 10);
        const lines = after.split(/\r?\n/);
        const pos = [], col = [];
        for (const ln of lines) {
          const l = ln.trim(); if (!l) continue;
          const t = l.split(/\s+/).map(Number);
          if (t.length <= Math.max(xi, yi, zi)) continue;
          if (!isFinite(t[xi])) continue;
          pos.push(t[xi], t[yi], t[zi]);
          if (rgbi >= 0 && isFinite(t[rgbi])) {
            const v = t[rgbi] >>> 0;
            col.push(((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255);
          } else col.push(0.7, 0.8, 0.95);
        }
        return this._decim(new Float32Array(pos), rgbi >= 0 ? new Float32Array(col) : null);
      }
      // binary PCD: best-effort — 안내로 폴백
      throw new Error("바이너리 PCD는 ASCII PCD로 변환 후 사용하세요.");
    },

    _parsePLY(buf) {
      const bytes = new Uint8Array(buf);
      // 헤더 끝(end_header) 찾기
      const headTxt = new TextDecoder().decode(buf.slice(0, 4096));
      const endIdx = headTxt.indexOf("end_header");
      if (endIdx < 0) throw new Error("PLY 헤더 없음");
      const headerStr = headTxt.slice(0, endIdx);
      const isAscii = /format\s+ascii/i.test(headerStr);
      const isLE = /format\s+binary_little_endian/i.test(headerStr);
      const vMatch = headerStr.match(/element vertex (\d+)/i);
      const vCount = vMatch ? parseInt(vMatch[1], 10) : 0;
      // 속성 파싱
      const props = [];
      headerStr.split(/\r?\n/).forEach(l => {
        const m = l.trim().match(/^property\s+(\w+)\s+(\w+)/i);
        if (m) props.push({ type: m[1].toLowerCase(), name: m[2].toLowerCase() });
      });
      const dataOffset = (new TextEncoder().encode(headTxt.slice(0, endIdx + "end_header".length))).length
        + (headTxt[endIdx + 10] === "\r" ? 2 : 1);
      const pos = new Float32Array(vCount * 3);
      const hasColor = props.some(p => /red|green|blue/.test(p.name));
      const col = hasColor ? new Float32Array(vCount * 3) : null;
      if (isAscii) {
        const fullTxt = new TextDecoder().decode(buf);
        const after = fullTxt.slice(fullTxt.indexOf("end_header") + 10).replace(/^\s+/, "");
        const lines = after.split(/\r?\n/);
        const xi = props.findIndex(p => p.name === "x"), yi = props.findIndex(p => p.name === "y"), zi = props.findIndex(p => p.name === "z");
        const ri = props.findIndex(p => p.name === "red"), gi = props.findIndex(p => p.name === "green"), bi = props.findIndex(p => p.name === "blue");
        let k = 0;
        for (let i = 0; i < lines.length && k < vCount; i++) {
          const t = lines[i].trim().split(/\s+/).map(Number);
          if (t.length < props.length) continue;
          pos[k * 3] = t[xi]; pos[k * 3 + 1] = t[yi]; pos[k * 3 + 2] = t[zi];
          if (col) { col[k * 3] = (t[ri] || 0) / 255; col[k * 3 + 1] = (t[gi] || 0) / 255; col[k * 3 + 2] = (t[bi] || 0) / 255; }
          k++;
        }
        return this._decim(pos.subarray(0, k * 3), col ? col.subarray(0, k * 3) : null);
      }
      // binary_little_endian
      const dv = new DataView(buf);
      const sizeOf = { char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2, int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };
      const readers = props.map(p => ({ name: p.name, size: sizeOf[p.type] || 4, type: p.type }));
      const stride = readers.reduce((s, r) => s + r.size, 0);
      let off = dataOffset;
      const le = isLE !== false;
      const readVal = (o, r) => {
        switch (r.type) {
          case "float": case "float32": return dv.getFloat32(o, le);
          case "double": case "float64": return dv.getFloat64(o, le);
          case "uchar": case "uint8": return dv.getUint8(o);
          case "char": case "int8": return dv.getInt8(o);
          case "ushort": case "uint16": return dv.getUint16(o, le);
          case "short": case "int16": return dv.getInt16(o, le);
          case "uint": case "uint32": return dv.getUint32(o, le);
          default: return dv.getInt32(o, le);
        }
      };
      for (let i = 0; i < vCount && off + stride <= buf.byteLength; i++) {
        let o = off;
        for (const r of readers) {
          const v = readVal(o, r);
          if (r.name === "x") pos[i * 3] = v;
          else if (r.name === "y") pos[i * 3 + 1] = v;
          else if (r.name === "z") pos[i * 3 + 2] = v;
          else if (col && r.name === "red") col[i * 3] = v / 255;
          else if (col && r.name === "green") col[i * 3 + 1] = v / 255;
          else if (col && r.name === "blue") col[i * 3 + 2] = v / 255;
          o += r.size;
        }
        off += stride;
      }
      return this._decim(pos, col);
    },

    _parseLAS(buf, ext) {
      if (ext === "laz") throw new Error("LAZ(압축)는 LAS로 풀어 첨부하거나 e57/ply를 사용하세요.");
      const dv = new DataView(buf);
      // LAS 헤더: signature 'LASF'
      const sig = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
      if (sig !== "LASF") throw new Error("유효한 LAS 파일이 아닙니다.");
      const pointDataOffset = dv.getUint32(96, true);
      const pointFormat = dv.getUint8(104);
      const pointLength = dv.getUint16(105, true);
      let numPoints = dv.getUint32(107, true);
      if (!numPoints) { // LAS 1.4 legacy 0 → extended
        try { numPoints = Number(dv.getBigUint64(247, true)); } catch (e) {}
      }
      const sx = dv.getFloat64(131, true), sy = dv.getFloat64(139, true), sz = dv.getFloat64(147, true);
      const ox = dv.getFloat64(155, true), oy = dv.getFloat64(163, true), oz = dv.getFloat64(171, true);
      const hasColor = pointFormat === 2 || pointFormat === 3 || pointFormat === 5 || pointFormat === 7 || pointFormat === 8 || pointFormat === 10;
      const colorOffsetMap = { 2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30 };
      const n = Math.min(numPoints, this.MAX_POINTS * 2);
      const pos = new Float32Array(n * 3);
      const col = hasColor ? new Float32Array(n * 3) : null;
      let off = pointDataOffset, k = 0;
      for (let i = 0; i < numPoints && off + pointLength <= buf.byteLength && k < n; i++, off += pointLength) {
        const X = dv.getInt32(off, true), Y = dv.getInt32(off + 4, true), Z = dv.getInt32(off + 8, true);
        pos[k * 3] = X * sx + ox; pos[k * 3 + 1] = Y * sy + oy; pos[k * 3 + 2] = Z * sz + oz;
        if (col) {
          const co = off + (colorOffsetMap[pointFormat] || 20);
          col[k * 3] = dv.getUint16(co, true) / 65535;
          col[k * 3 + 1] = dv.getUint16(co + 2, true) / 65535;
          col[k * 3 + 2] = dv.getUint16(co + 4, true) / 65535;
        }
        k++;
      }
      return this._decim(pos.subarray(0, k * 3), col ? col.subarray(0, k * 3) : null);
    },

    _parseFLS(buf, ext) {
      // FARO .fls 는 독점 포맷. e57 도 컨테이너가 복잡(XML+binary)해 안정 파싱이 어려움.
      // 일부 e57 은 단순 구조라 sniff 로 점이 잡히는 경우도 있으나, 신뢰성을 위해
      // 직접 파싱 실패 시 변환 안내로 폴백한다(loadBuffer 가 처리).
      return this._sniff(buf);
    },

    _sniff(buf) {
      // 텍스트면 XYZ 시도
      try {
        const head = new TextDecoder().decode(buf.slice(0, 256));
        if (/^[\s\d.\-eE,;]+$/.test(head.replace(/\r?\n/g, " ").slice(0, 80))) {
          return this._parseXYZ(buf);
        }
      } catch (e) {}
      return { positions: new Float32Array(0), colors: null, count: 0 };
    },

    /* ── Three.js 렌더링 ── */
    _ensureRenderer() {
      if (this._inited) return;
      const canvas = this._el("fls-canvas");
      if (!canvas || typeof THREE === "undefined") return;
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.scene = new THREE.Scene();
      this.scene.background = new THREE.Color(0x0a1422);
      this.camera = new THREE.PerspectiveCamera(60, 1, 0.01, 100000);
      const grid = new THREE.GridHelper(10, 20, 0x1b75bb, 0x16324d);
      grid.material.opacity = 0.25; grid.material.transparent = true;
      this.scene.add(grid);
      this._bindControls(canvas);
      this._inited = true;
      // 반응형 리사이즈
      try {
        this._ro = new ResizeObserver(() => this._resize());
        this._ro.observe(this._el("fls-stage"));
      } catch (e) {}
      this._loop();
    },

    _render(parsed) {
      this._ensureRenderer();
      if (!this.scene) { this._showError("WebGL 미지원", "이 브라우저에서 3D 렌더링을 사용할 수 없습니다."); return; }
      // 기존 points 제거
      if (this.points) { this.scene.remove(this.points); this.points.geometry.dispose(); this.points.material.dispose(); this.points = null; }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(parsed.positions, 3));
      let mat;
      if (parsed.colors) {
        geo.setAttribute("color", new THREE.BufferAttribute(parsed.colors, 3));
        mat = new THREE.PointsMaterial({ size: 0.02, vertexColors: true, sizeAttenuation: true });
      } else {
        mat = new THREE.PointsMaterial({ size: 0.02, color: 0x8ec5ff, sizeAttenuation: true });
      }
      geo.computeBoundingBox();
      const bb = geo.boundingBox;
      const cx = (bb.min.x + bb.max.x) / 2, cy = (bb.min.y + bb.max.y) / 2, cz = (bb.min.z + bb.max.z) / 2;
      const size = Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z) || 1;
      // 점 크기를 모델 스케일에 맞춤
      mat.size = size / 600;
      this.points = new THREE.Points(geo, mat);
      this.scene.add(this.points);
      this._target = { x: cx, y: cy, z: cz };
      this._rot = { theta: 0.7, phi: 1.05, r: size * 1.6 };
      this._show("fls-stats");
      const stats = this._el("fls-stats");
      if (stats) stats.textContent = parsed.count.toLocaleString() + " pts";
      this._resize();
    },

    _bindControls(canvas) {
      const down = e => {
        const p = e.touches ? e.touches[0] : e;
        this._drag = { x: p.clientX, y: p.clientY, theta: this._rot.theta, phi: this._rot.phi };
      };
      const move = e => {
        if (!this._drag) return;
        const p = e.touches ? e.touches[0] : e;
        const dx = p.clientX - this._drag.x, dy = p.clientY - this._drag.y;
        this._rot.theta = this._drag.theta - dx * 0.005;
        this._rot.phi = Math.max(0.05, Math.min(Math.PI - 0.05, this._drag.phi - dy * 0.005));
      };
      const up = () => { this._drag = null; };
      canvas.addEventListener("mousedown", down);
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
      canvas.addEventListener("touchstart", down, { passive: true });
      canvas.addEventListener("touchmove", e => { move(e); }, { passive: true });
      canvas.addEventListener("touchend", up);
      canvas.addEventListener("wheel", e => {
        e.preventDefault();
        this._rot.r *= (1 + (e.deltaY > 0 ? 0.1 : -0.1));
        this._rot.r = Math.max(0.01, this._rot.r);
      }, { passive: false });
      const rb = this._el("btn-fls-reset");
      if (rb) rb.addEventListener("click", () => {
        if (this.points) { const bb = this.points.geometry.boundingBox; const s = Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z) || 1; this._rot = { theta: 0.7, phi: 1.05, r: s * 1.6 }; }
      });
      const cb = this._el("btn-fls-collapse");
      if (cb) cb.addEventListener("click", () => {
        const pane = this._el("fls-pane");
        if (pane) { pane.classList.toggle("fls-collapsed"); setTimeout(() => this._resize(), 260); }
      });
    },

    _resize() {
      if (!this.renderer) return;
      const stage = this._el("fls-stage");
      if (!stage) return;
      const w = stage.clientWidth || 1, h = stage.clientHeight || 1;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    },

    _loop() {
      const tick = () => {
        this._raf = requestAnimationFrame(tick);
        if (!this.renderer || !this.scene) return;
        const pane = this._el("fls-pane");
        if (!pane || pane.classList.contains("hidden")) return;
        const { theta, phi, r } = this._rot;
        this.camera.position.set(
          this._target.x + r * Math.sin(phi) * Math.cos(theta),
          this._target.y + r * Math.cos(phi),
          this._target.z + r * Math.sin(phi) * Math.sin(theta)
        );
        this.camera.lookAt(this._target.x, this._target.y, this._target.z);
        this.renderer.render(this.scene, this.camera);
      };
      this._raf = requestAnimationFrame(tick);
    },

    close() { this.showPane(false); }
  };

  /* ══════════════════════════════════════════
     MAP CTRL  — 줌/패닝 + 좌표 변환 + 플라이투
  ══════════════════════════════════════════ */
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
      const iso = State.isoView ? " rotateX(54deg) rotateZ(-32deg)" : "";
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

    /** ISO 3D 뷰 토글 — 평면 ↔ 아이소메트릭 입체 회전 (부드러운 전환) */
    toggleIso() {
      State.isoView = !State.isoView;
      const vp = this.viewport, tr = this.transform;
      const btn = document.getElementById("btn-iso");
      if (btn) btn.classList.toggle("active", State.isoView);
      if (vp) vp.classList.toggle("iso-active", State.isoView);
      // ISO 진입 시 입체 도면이 화면 안에 들어오도록 살짝 축소·중앙 정렬
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
    }
  };

  /* ══════════════════════════════════════════
     UI UTILITIES
  ══════════════════════════════════════════ */
  const UI = {
    $:  id  => document.getElementById(id),

    show(id)  { this.$(id).classList.remove("hidden"); },
    hide(id)  { this.$(id).classList.add("hidden");    },
    toggle(id, force) {
      const el = this.$(id);
      if (force === undefined) el.classList.toggle("hidden");
      else force ? el.classList.remove("hidden") : el.classList.add("hidden");
    },
    text(id, val)  { const el = this.$(id); if (el) el.textContent = val; },
    val(id)        { return this.$(id).value; },
    clearVal(id)   { this.$(id).value = ""; },
    enable(id)     { this.$(id).disabled = false; },
    disable(id)    { this.$(id).disabled = true; },

    showScreen(name) {
      document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
      this.$(name).classList.add("active");
    },

    escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, c =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    },

    renderPinList() {
      const list  = this.$("pin-list");
      const empty = this.$("pin-empty");
      const badge = this.$("pin-count-badge");
      list.innerHTML = "";

      if (State.pins.length === 0) {
        empty.classList.remove("hidden");
        badge.classList.add("hidden");
        this.hide("section-export");
        if (typeof AllPins !== "undefined") { AllPins.syncButton(); if (AllPins.open) AllPins.render(); }
        if (typeof PinGrid !== "undefined") PinGrid.render();
        return;
      }
      empty.classList.add("hidden");
      badge.textContent = State.pins.length + " PINS";
      badge.classList.remove("hidden");
      if (State.mode === "designer") this.show("section-export");

      const totalPages = State.mode === "viewer"
        ? (State.viewerPages ? State.viewerPages.length : 1)
        : State.pdfPages;

      // 다중 페이지 도면: 현재 페이지의 핀만 목록에 표시(페이지별 완벽 구분)
      const curPage = State.pdfPage || 1;
      const isMulti = totalPages > 1;
      const visiblePins = isMulti
        ? State.pins.filter(p => (p.page || 1) === curPage)
        : State.pins;

      // 현재 페이지에 핀이 없으면 안내(다른 페이지에 핀이 있을 수 있음)
      if (isMulti && visiblePins.length === 0) {
        const other = State.pins.length;
        empty.classList.remove("hidden");
        const et = empty.querySelector(".pin-empty-sub") || empty;
        list.innerHTML = `<p class="pin-empty-page">현재 페이지(P${curPage})에 등록된 포인트가 없습니다.${other ? ` 다른 페이지에 ${other}개의 포인트가 있습니다.` : ""}</p>`;
        badge.textContent = State.pins.length + " PINS";
        badge.classList.remove("hidden");
        if (State.mode === "designer") this.show("section-export");
        if (typeof AllPins !== "undefined") { AllPins.syncButton(); if (AllPins.open) AllPins.render(); }
        if (typeof PinGrid !== "undefined") PinGrid.render();
        return;
      }

      visiblePins.forEach((pin, idx) => {
        const item = document.createElement("div");
        item.className = "pin-item" + (State.activePin === pin.id ? " active" : "");
        item.dataset.id = pin.id;
        const pageTag = (totalPages > 1) ? ` · P${pin.page || 1}` : "";
        const cloudTag = pin.imageId ? " ☁" : "";
        // 노트/첨부 메타 아이콘
        const noteIco = pin.note ? `<svg viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>` : "";
        const attCount = pin.attachments ? pin.attachments.length : 0;
        const attIco = attCount ? `<svg viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>` : "";
        const metaIcons = (noteIco || attIco)
          ? `<span class="pin-meta-icons">${noteIco}${attIco}${attCount > 1 ? attCount : ""}</span>` : "";
        // 미해결 이슈 카운트 뱃지(이슈/필드노트)
        const openIssues = (typeof Notes !== "undefined") ? Notes.openCountFor(pin.id) : 0;
        const issueBadge = openIssues > 0
          ? `<span class="pin-issue-badge" title="미해결 이슈 ${openIssues}건">${openIssues}</span>` : "";

        if (State.mode === "designer") {
          item.innerHTML = `
            <div class="pin-num">${idx + 1}</div>
            <div class="pin-info">
              <div class="pin-name">${this.escapeHtml(pin.label)}${cloudTag}${metaIcons}${issueBadge}</div>
              <div class="pin-coords">${pin.x.toFixed(1)}%, ${pin.y.toFixed(1)}%${pageTag}</div>
            </div>
            <div class="pin-acts">
              <button class="pin-act pin-edit" data-id="${pin.id}" title="수정" aria-label="수정">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
              </button>
              <button class="pin-act pin-del" data-id="${pin.id}" title="삭제" aria-label="삭제">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
              </button>
            </div>`;
          item.querySelector(".pin-edit").addEventListener("click", e => {
            e.stopPropagation();
            App.editPin(pin.id);
          });
          item.querySelector(".pin-del").addEventListener("click", e => {
            e.stopPropagation();
            App.deletePin(pin.id);
          });
          // 디자이너 모드: 콘텐츠 있는 핀은 이동+오픈, 없는 핀은 CAD 인스펙터 상세 표시
          item.addEventListener("click", () => {
            if (App.pinHasContent(pin)) App.focusPin(pin, true);
            else if (typeof Inspector !== "undefined") { App.focusPin(pin, false); Inspector.showPin(pin); }
            else App.focusPin(pin, false);
          });
        } else {
          item.innerHTML = `
            <div class="pin-num">${idx + 1}</div>
            <div class="pin-info">
              <div class="pin-name">${this.escapeHtml(pin.label)}${cloudTag}${metaIcons}${issueBadge}</div>
              <div class="pin-coords">${pin.x.toFixed(1)}%, ${pin.y.toFixed(1)}%${pageTag}</div>
            </div>
            <span class="pin-arrow">▶</span>`;
          item.addEventListener("click", () => App.focusPin(pin, true));
        }
        list.appendChild(item);
      });
      if (typeof AllPins !== "undefined") { AllPins.syncButton(); if (AllPins.open) AllPins.render(); }
      if (typeof PinGrid !== "undefined") PinGrid.render();
    },

    renderPinsOnMap(dropPinId) {
      const layer = this.$("pins-layer");
      layer.innerHTML = "";
      const curPage = State.pdfPage;
      let pageIdx = 0; // 페이지별 1부터 시작하는 번호
      State.pins.forEach((pin) => {
        if ((pin.page || 1) !== curPage) return; // 현재 페이지 핀만
        pageIdx++;
        const marker = document.createElement("div");
        marker.className = "pin-marker" + (pin.id === dropPinId ? " drop" : "")
          + (State.activePin === pin.id ? " focused" : "");
        marker.style.left = pin.x + "%";
        marker.style.top  = pin.y + "%";
        marker.dataset.id = pin.id;
        const hasContent = App.pinHasContent(pin);
        const openIssues = (typeof Notes !== "undefined") ? Notes.openCountFor(pin.id) : 0;
        const issueDot = openIssues > 0
          ? `<span class="pin-marker-issue" title="미해결 이슈 ${openIssues}건">${openIssues}</span>` : "";
        if (hasContent) marker.classList.add("has-content");
        marker.classList.add("pin-marker-teardrop"); // 진짜 핀(물방울) 모양 + 중앙 번호
        marker.dataset.no = pageIdx;
        // ── 바늘형 핀(영역=골드와 색상 완전 분리):
        //    미배치=선명한 코랄레드(#ef4444), 사진 있음=에메랄드(#10b981).
        //    바늘을 길고 가늘게 → "찌르는" 느낌. tip(18,62)으로 수렴.
        const headFill  = hasContent ? '#10b981' : '#ef4444';
        const headFill2 = hasContent ? '#047857' : '#b91c1c';
        const needleTip = hasContent ? '#064e3b' : '#7f1d1d';
        const txtFill   = hasContent ? '#065f46' : '#991b1b';
        marker.innerHTML = `
          ${hasContent ? '<div class="pin-pulse"></div>' : ''}
          <div class="pin-pin">
            <svg viewBox="0 0 36 64" xmlns="http://www.w3.org/2000/svg">
              <defs>
                <radialGradient id="pgbody${pageIdx}" cx="38%" cy="32%" r="74%">
                  <stop offset="0%" stop-color="${headFill}"/>
                  <stop offset="100%" stop-color="${headFill2}"/>
                </radialGradient>
                <linearGradient id="pgneedle${pageIdx}" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color="${headFill2}"/>
                  <stop offset="55%" stop-color="${needleTip}"/>
                  <stop offset="100%" stop-color="#1a1a1a"/>
                </linearGradient>
                <filter id="pgshadow${pageIdx}" x="-60%" y="-20%" width="220%" height="180%">
                  <feDropShadow dx="0" dy="2" stdDeviation="1.6" flood-color="rgba(0,0,0,.5)"/>
                </filter>
              </defs>
              <!-- 길고 날카로운 바늘: 머리 하단(13.6/22.4)에서 한 점(18,62)으로 수렴 -->
              <path d="M13.6 15 L18 62 L22.4 15 Z" fill="url(#pgneedle${pageIdx})" filter="url(#pgshadow${pageIdx})"/>
              <!-- 둥근 머리 -->
              <circle cx="18" cy="12" r="11" fill="url(#pgbody${pageIdx})" stroke="#ffffff" stroke-width="2.2"/>
              <circle cx="18" cy="12" r="7.3" fill="#ffffff" opacity="0.96"/>
              <text x="18" y="12.3" text-anchor="middle" dominant-baseline="central"
                    font-family="'Segoe UI',sans-serif" font-size="9.5" font-weight="800"
                    fill="${txtFill}">${pageIdx}</text>
              <!-- 머리 하이라이트(광택) -->
              <ellipse cx="14.5" cy="8" rx="3.6" ry="2.3" fill="#ffffff" opacity="0.5"/>
            </svg>
            ${issueDot}
          </div>
          <div class="pin-actions">
            ${hasContent ? '<button class="pin-act pin-act-view" data-act="view" title="360° 보기"><i class="fa-solid fa-panorama"></i></button>' : ''}
            <button class="pin-act pin-act-move" data-act="move" title="이동(드래그)"><i class="fa-solid fa-up-down-left-right"></i></button>
            <button class="pin-act pin-act-edit" data-act="edit" title="수정"><i class="fa-solid fa-pen"></i></button>
            <button class="pin-act pin-act-del" data-act="del" title="삭제"><i class="fa-solid fa-trash"></i></button>
          </div>`;
        // ── 디자이너: 포인터 드래그로 핀 위치 이동 (click 과 구분: 이동 임계값) ──
        if (State.mode === "designer") {
          marker.classList.add("draggable");
          let dragging = false, moved = false, startX = 0, startY = 0;
          const onMove = (ev) => {
            const cx = ev.touches ? ev.touches[0].clientX : ev.clientX;
            const cy = ev.touches ? ev.touches[0].clientY : ev.clientY;
            if (!dragging) return;
            if (!moved && Math.hypot(cx - startX, cy - startY) < 5) return; // 임계값 미만은 클릭으로 취급
            moved = true;
            State.movingPinId = pin.id;
            marker.classList.add("moving");
            const pct = MapCtrl.viewportToPercent(cx, cy);
            if (pct) {
              pin.x = Math.max(0, Math.min(100, pct.x));
              pin.y = Math.max(0, Math.min(100, pct.y));
              marker.style.left = pin.x + "%";
              marker.style.top  = pin.y + "%";
              const lbl = marker.querySelector(".pin-marker-label");
              // 좌표 라이브 갱신은 리스트 쪽에서 (성능 위해 드래그 끝에 한 번)
            }
            if (ev.cancelable) ev.preventDefault();
          };
          const onUp = () => {
            document.removeEventListener("pointermove", onMove);
            document.removeEventListener("pointerup", onUp);
            document.removeEventListener("touchmove", onMove);
            document.removeEventListener("touchend", onUp);
            dragging = false;
            marker.classList.remove("moving");
            if (moved) {
              State.movingPinId = null;
              State.pinEditUnlocked = null; // 이동 끝나면 다시 잠금
              if (typeof Zones !== "undefined" && Zones.refreshPinLinks) Zones.refreshPinLinks();
              UI.renderPinList();
              if (typeof Zones !== "undefined") Zones.render();
              Prompt.toast("📍 '" + pin.label + "' 위치 이동됨 · 자동저장");
              App._autoSave();
            }
          };
          const onDown = (ev) => {
            if (State.placing) return; // 배치 모드에서는 드래그 비활성
            if (State.isoView) { Prompt.toast("ISO 3D 뷰에서는 위치 이동이 불가합니다. 평면 뷰로 전환하세요."); return; }
            // ── 요청사항 #6: '수정' 버튼으로 잠금 해제한 핀만 드래그 이동 가능 ──
            if (State.pinEditUnlocked !== pin.id) {
              // 잠긴 상태 → 클릭으로만 동작(보기). 이동하려면 ✏ 수정 버튼을 눌러야 함.
              return;
            }
            startX = ev.touches ? ev.touches[0].clientX : ev.clientX;
            startY = ev.touches ? ev.touches[0].clientY : ev.clientY;
            dragging = true; moved = false;
            document.addEventListener("pointermove", onMove, { passive: false });
            document.addEventListener("pointerup", onUp);
            document.addEventListener("touchmove", onMove, { passive: false });
            document.addEventListener("touchend", onUp);
          };
          marker.addEventListener("pointerdown", onDown);
          marker.addEventListener("click", e => {
            e.stopPropagation();
            if (moved) { moved = false; return; } // 드래그 직후 클릭 무시
            if (State.pinEditUnlocked === pin.id) return; // 이동 잠금해제 상태에서는 클릭 무시(드래그 대기)
            App.setActivePin(pin.id);
            // 디자이너: 핀 클릭 → 전용 작업 팝업(이동/수정/사진추가/삭제/보기)
            if (typeof PinActionPop !== "undefined") PinActionPop.open(pin.id);
            else if (App.pinHasContent(pin)) App.openPano(pin);
          });
          // 액션 아이콘 바인딩 (보기/이동/수정/삭제)
          marker.querySelectorAll(".pin-act").forEach(btn => {
            btn.addEventListener("click", ev => {
              ev.stopPropagation();
              const act = btn.dataset.act;
              if (act === "view") App.openPano(pin);
              else if (act === "move") {
                // ── #6: 이동 잠금 해제 후 드래그 안내 ──
                State.pinEditUnlocked = pin.id;
                marker.classList.add("edit-unlocked");
                Prompt.toast("🔓 '" + pin.label + "' 이동 잠금 해제 — 핀을 드래그하세요");
              }
              else if (act === "edit") {
                // ── #6: 수정 버튼 → 편집 폼 + 이동 잠금 해제(사진추가/위치이동 가능) ──
                State.pinEditUnlocked = pin.id;
                App.editPin(pin.id);
              }
              else if (act === "del") App.deletePin(pin.id);
            });
          });
        } else {
          marker.addEventListener("click", e => {
            e.stopPropagation();
            App.openPano(pin); // 뷰어: 미디어 없으면 openPano가 안내 표시
          });
        }
        layer.appendChild(marker);
      });
      if (typeof Zones !== "undefined") Zones.render();
      if (typeof PdfAnno !== "undefined") PdfAnno.refresh();
    },

    updatePdfPagination() {
      const total = State.mode === "viewer" && State.viewerPages
        ? State.viewerPages.length : State.pdfPages;
      if (total > 1) {
        this.$("pdf-pagination").classList.remove("hidden");
        const jump = this.$("input-page-jump");
        if (jump && document.activeElement !== jump) jump.value = State.pdfPage;
        this.text("page-total", "/ " + total);
        this.$("btn-first-page").disabled = State.pdfPage <= 1;
        this.$("btn-prev-page").disabled  = State.pdfPage <= 1;
        this.$("btn-next-page").disabled  = State.pdfPage >= total;
        this.$("btn-last-page").disabled  = State.pdfPage >= total;
      } else {
        this.$("pdf-pagination").classList.add("hidden");
      }
      // 새 ezPDF 툴바 페이지 동기화 (단일 페이지도 1/1 표시)
      const tbInput = this.$("tb-page-input");
      if (tbInput && document.activeElement !== tbInput) tbInput.value = State.pdfPage;
      this.text("tb-page-total", "/ " + (total || 1));
      const setDis = (id, v) => { const el = this.$(id); if (el) el.disabled = v; };
      setDis("tb-first", State.pdfPage <= 1);
      setDis("tb-prev",  State.pdfPage <= 1);
      setDis("tb-next",  State.pdfPage >= (total || 1));
      setDis("tb-last",  State.pdfPage >= (total || 1));
    },

    /** 좌측 썸네일 도킹 패널 토글 (ezPDF 스타일) */
    toggleThumbPanel(force) {
      const strip = this.$("pdf-thumb-strip");
      const btn = this.$("tb-thumbs");
      if (!strip) return;
      const willHide = (typeof force === "boolean") ? !force : !strip.classList.contains("hidden");
      strip.classList.toggle("hidden", willHide);
      strip.classList.toggle("docked", !willHide);
      document.body.classList.toggle("thumbs-open", !willHide);
      if (btn) btn.classList.toggle("active", !willHide);
      if (!willHide && typeof this.renderPdfThumbs === "function") this.renderPdfThumbs();
    },

    /** 회전 각도 라벨 + 버튼 노출 (도면 로드 시에만 표시) */
    updateRotationLabel() {
      const grp = this.$("rotate-group");
      if (!grp) return;
      const hasDoc = !!(State.fileType && (State.pdfDoc || State.imageUrl || State.viewerPages));
      grp.classList.toggle("hidden", !hasDoc);
      const lbl = this.$("rotate-level");
      if (lbl) lbl.textContent = (State.pdfRotation || 0) + "°";
    },

    /** 멀티페이지 PDF 썸네일 스트립 (디자이너 PDF 전용) */
    async renderPdfThumbs() {
      const strip = this.$("pdf-thumb-strip");
      if (!strip) return;
      // 디자이너 PDF + 2페이지 이상에서만 표시
      const show = State.mode === "designer" && State.fileType === "pdf"
        && State.pdfDoc && State.pdfPages > 1;
      strip.classList.toggle("hidden", !show);
      if (!show) { strip.innerHTML = ""; return; }

      // 최초 1회만 썸네일 캐시 생성 (페이지 전환 시 재생성 방지)
      if (this._thumbDocId !== State.pdfDoc || strip.childElementCount !== State.pdfPages) {
        this._thumbDocId = State.pdfDoc;
        strip.innerHTML = "";
        for (let p = 1; p <= State.pdfPages; p++) {
          const item = document.createElement("button");
          item.className = "pdf-thumb-item";
          item.dataset.page = p;
          item.title = p + " 페이지";
          item.innerHTML =
            `<canvas class="pdf-thumb-canvas"></canvas><span class="pdf-thumb-no">${p}</span>`;
          item.addEventListener("click", () => App._gotoPage(p));
          strip.appendChild(item);
          // 작은 썸네일 렌더 (비차단, 순차)
          this._renderThumbInto(item.querySelector("canvas"), p);
        }
      }
      // 현재 페이지 하이라이트
      Array.from(strip.children).forEach((el) => {
        const active = Number(el.dataset.page) === State.pdfPage;
        el.classList.toggle("active", active);
        if (active) el.scrollIntoView({ block: "nearest", inline: "nearest" });
      });
    },

    async _renderThumbInto(canvas, pageNum) {
      try {
        const page = await State.pdfDoc.getPage(pageNum);
        const rot = ((page.rotate || 0) + (State.pdfRotation || 0)) % 360;
        const base = page.getViewport({ scale: 1, rotation: rot });
        const scale = 120 / Math.max(base.width, base.height); // 최대 변 120px
        const vp = page.getViewport({ scale, rotation: rot });
        canvas.width = Math.round(vp.width);
        canvas.height = Math.round(vp.height);
        await page.render({ canvasContext: canvas.getContext("2d", { alpha: false }), viewport: vp }).promise;
      } catch (e) { /* 썸네일 실패는 무시 */ }
    }
  };

  /* ══════════════════════════════════════════
     PROJECT HUB  ── 첫 화면 = 프로젝트 선택 대시보드 (상용툴 모방)
       · 로그인 안 함/뷰어: 카드 클릭 → 뷰어로 해당 프로젝트 열람
       · 디자이너/슈퍼: "+새 프로젝트" + 카드 편집/삭제, 카드 클릭 → 디자이너 작업
  ══════════════════════════════════════════ */
  const ProjectHub = {
    list: [],
    _loaded: false,

    init() {
      const $ = (id) => document.getElementById(id);
      $("hub-btn-new") && $("hub-btn-new").addEventListener("click", () => this.createProject());
      // hub 인증바 버튼들 (홈 인증바와 동일 동작)
      $("hub-btn-signout") && $("hub-btn-signout").addEventListener("click", () => Auth.signOut());
      $("hub-btn-manage-designers") && $("hub-btn-manage-designers").addEventListener("click", () => Designers.open());
    },

    /** 화면 진입 시 호출 — 목록 로드 + 렌더 */
    async open() {
      UI.showScreen("screen-projects");
      Auth._applyUi();          // 인증바 상태 동기화 (hub 슬롯 포함)
      Auth._renderHubSignin();  // 미로그인 시 hub 로그인 버튼 렌더
      await this.load();
    },

    async load() {
      try {
        const r = await fetch("/api/projects");
        const { data } = await r.json();
        this.list = data || [];
      } catch (e) { this.list = []; }
      this._loaded = true;
      this.render();
    },

    /** Auth 상태 변경 시 (로그인/로그아웃) 다시 그려 +새프로젝트·편집 버튼 토글 */
    refreshIfVisible() {
      const sc = document.getElementById("screen-projects");
      if (sc && sc.classList.contains("active")) {
        this.render();
        Auth._renderHubSignin();
      }
    },

    render() {
      const grid  = document.getElementById("hub-grid");
      const empty = document.getElementById("hub-empty");
      const btnNew = document.getElementById("hub-btn-new");
      const emptyHint = document.getElementById("hub-empty-hint");
      if (!grid) return;

      const isDesigner = Auth.isDesigner;
      // +새 프로젝트 버튼: 디자이너만
      if (btnNew) btnNew.classList.toggle("hidden", !isDesigner);

      grid.innerHTML = "";

      if (!this.list.length) {
        empty && empty.classList.remove("hidden");
        if (emptyHint) emptyHint.textContent = isDesigner
          ? "우측 상단 '+ 새 프로젝트'로 첫 프로젝트를 만들어 보세요."
          : "설계자로 로그인하면 새 프로젝트를 만들 수 있습니다.";
        return;
      }
      empty && empty.classList.add("hidden");

      this.list.forEach((p) => {
        const card = document.createElement("div");
        card.className = "hub-card";
        card.setAttribute("role", "listitem");
        card.tabIndex = 0;
        const deckTxt = (p.deck_count != null) ? (p.deck_count + " DECKS") : "";
        const dateTxt = this._fmtDate(p.created_at);
        const code = "SS-" + String(Math.abs(this._hash(p.id || p.name)) % 9000 + 1000);
        card.innerHTML =
          '<div class="hub-card-thumb">' +
            '<div class="hub-thumb-grid"></div>' +
            '<div class="hub-thumb-scan"></div>' +
            '<svg class="hub-thumb-ship" viewBox="0 0 120 64" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
              '<path d="M10 40 L100 40 L92 52 L20 52 Z"/>' +
              '<path d="M22 40 L22 26 L74 26 L74 40"/>' +
              '<path d="M30 26 L30 18 L60 18 L60 26"/>' +
              '<line x1="36" y1="22" x2="40" y2="22"/><line x1="46" y1="22" x2="50" y2="22"/>' +
              '<line x1="80" y1="40" x2="80" y2="30"/><line x1="80" y1="30" x2="92" y2="32"/>' +
              '<path d="M6 46 q6 4 12 0 q6 -4 12 0 q6 4 12 0 q6 -4 12 0 q6 4 12 0 q6 -4 12 0 q6 4 12 0" opacity=".4"/>' +
            '</svg>' +
            '<span class="hub-thumb-code">' + code + '</span>' +
          '</div>' +
          '<div class="hub-card-body">' +
            '<div class="hub-card-name">' + UI.escapeHtml(p.name) + '</div>' +
            '<div class="hub-card-meta">' +
              (deckTxt ? '<span class="hub-card-decks">' + deckTxt + '</span>' : '') +
              (dateTxt ? '<span class="hub-card-date">' + dateTxt + '</span>' : '') +
            '</div>' +
          '</div>' +
          (isDesigner
            ? '<div class="hub-card-actions">' +
                '<button class="hub-card-act hub-card-del" title="삭제" data-act="del" aria-label="삭제">' +
                  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>' +
                '</button>' +
              '</div>'
            : '');

        // 카드 클릭 → 진입
        card.addEventListener("click", (e) => {
          if (e.target.closest("[data-act]")) return; // 액션 버튼은 제외
          this.openProject(p);
        });
        card.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.openProject(p); }
        });
        // 삭제 버튼
        const del = card.querySelector('[data-act="del"]');
        if (del) del.addEventListener("click", (e) => { e.stopPropagation(); this.deleteProject(p); });

        grid.appendChild(card);
      });

      // 디자이너면 "+새 프로젝트" 카드도 그리드 맨 앞에 추가
      if (isDesigner) {
        const add = document.createElement("div");
        add.className = "hub-card hub-card-add";
        add.tabIndex = 0;
        add.setAttribute("role", "listitem");
        add.innerHTML = '<div class="hub-card-add-plus">+</div><div class="hub-card-add-label">새 프로젝트</div>';
        const go = () => this.createProject();
        add.addEventListener("click", go);
        add.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
        grid.insertBefore(add, grid.firstChild);
      }
    },

    /** 프로젝트 진입: 디자이너면 편집, 아니면 뷰어 */
    openProject(p) {
      // 선택 프로젝트를 Projects 모듈과 공유 (작업화면 사이드바 동기화용)
      Projects.list = this.list;
      Projects.currentProject = p;
      State.currentProjectId = p.id;
      State.currentProjectName = p.name;
      if (Auth.isDesigner) {
        App.openApp("designer", { project: p });
      } else {
        App.openApp("viewer", { project: p });
      }
    },

    async createProject() {
      if (!Auth.isDesigner) { Auth.requireDesigner(() => this.createProject()); return; }
      const res = await Prompt.ask({ title: "프로젝트 생성", sub: "새 프로젝트 이름을 입력하세요 (예: ○○호 검사)", placeholder: "프로젝트 이름" });
      if (!res || !res.value) return;
      try {
        const r = await fetch("/api/projects", { method: "POST", headers: Auth.headers(), body: JSON.stringify({ name: res.value }) });
        const p = await r.json();
        if (!r.ok) { alert(p.error || "생성 실패(권한 필요)"); return; }
        await this.load();
      } catch (e) { alert("네트워크 오류"); }
    },

    async deleteProject(p) {
      if (!Auth.isDesigner) return;
      if (!confirm("'" + p.name + "' 프로젝트와 모든 데크를 삭제할까요?")) return;
      try {
        await fetch("/api/projects/" + p.id, { method: "DELETE", headers: Auth.headers() });
        await this.load();
      } catch (e) {}
    },

    _fmtDate(v) {
      if (v == null) return "";
      const n = (typeof v === "number") ? v : Date.parse(v);
      if (!Number.isFinite(n)) return "";
      const d = new Date(n);
      const p = (x) => String(x).padStart(2, "0");
      return d.getFullYear() + "." + p(d.getMonth() + 1) + "." + p(d.getDate());
    },

    /** 프로젝트 식별 코드(SS-####) 생성용 간이 해시 */
    _hash(str) {
      str = String(str || "");
      let h = 0;
      for (let i = 0; i < str.length; i++) { h = ((h << 5) - h + str.charCodeAt(i)) | 0; }
      return h;
    }
  };

  /* ══════════════════════════════════════════
     NOTES ── 이슈/필드노트 협업 (핀 단위 코멘트 스레드)
       · 파노라마 우측 패널에서 핀별 이슈를 작성/상태관리
       · 상태: open(미해결) / progress(진행) / done(완료)
       · 도면 핀 + 핀 리스트에 미해결 카운트 뱃지 표시
  ══════════════════════════════════════════ */
  const Notes = {
    _pin: null,          // 현재 패널의 핀 객체
    _list: [],           // 현재 핀의 노트 배열
    _filter: "all",
    _busy: false,
    STATUS: { open: "미해결", progress: "진행중", done: "완료" },

    init() {
      const $ = (id) => document.getElementById(id);
      $("btn-pano-notes") && $("btn-pano-notes").addEventListener("click", () => this.toggle());
      $("pnp-close") && $("pnp-close").addEventListener("click", () => this.closePanel());
      // 필터
      document.querySelectorAll("#pnp-filter .pnp-fbtn").forEach((b) => {
        b.addEventListener("click", () => {
          this._filter = b.dataset.f;
          document.querySelectorAll("#pnp-filter .pnp-fbtn").forEach((x) => x.classList.toggle("active", x === b));
          this.render();
        });
      });
      // 작성 폼
      const form = $("pnp-form");
      form && form.addEventListener("submit", (e) => { e.preventDefault(); this.submit(); });
    },

    /** 현재 배포의 핀별 노트 요약 로드 → 도면/리스트 뱃지 */
    async loadSummary() {
      const dep = State.currentDeploymentId;
      if (!dep) { State.noteSummary = {}; return; }
      try {
        const r = await fetch("/api/notes/summary?deployment_id=" + encodeURIComponent(dep));
        if (!r.ok) return;
        const j = await r.json();
        State.noteSummary = j.data || {};
      } catch (e) { State.noteSummary = {}; }
      // 뱃지 갱신
      if (typeof UI !== "undefined") { UI.renderPinList(); UI.renderPinsOnMap(); }
      this._syncHeaderCount();
    },

    /** 특정 핀의 미해결 카운트 (뱃지용) */
    openCountFor(pinId) {
      const s = State.noteSummary && State.noteSummary[pinId];
      if (!s) return 0;
      return (s.open || 0) + (s.progress || 0);
    },
    totalCountFor(pinId) {
      const s = State.noteSummary && State.noteSummary[pinId];
      return s ? (s.total || 0) : 0;
    },

    /** 파노라마 헤더 이슈 버튼의 현재 핀 카운트 */
    _syncHeaderCount() {
      const el = document.getElementById("pano-notes-count");
      if (!el) return;
      const pin = this._pin;
      const n = pin ? this.totalCountFor(pin.id) : 0;
      if (n > 0) { el.textContent = n; el.classList.remove("hidden"); }
      else el.classList.add("hidden");
    },

    /** 파노라마 열릴 때 현재 핀 지정 */
    setPin(pin) {
      this._pin = pin || null;
      const lbl = document.getElementById("pnp-pin-label");
      if (lbl) lbl.textContent = pin ? (pin.label || "이름 없는 위치") : "—";
      this._syncHeaderCount();
      // 패널이 열려 있으면 즉시 다시 로드
      if (!document.getElementById("pano-notes-panel").classList.contains("hidden")) this.loadForPin();
    },

    toggle() {
      const p = document.getElementById("pano-notes-panel");
      if (!p) return;
      if (p.classList.contains("hidden")) this.openPanel();
      else this.closePanel();
    },
    openPanel() {
      const p = document.getElementById("pano-notes-panel");
      if (!p || !this._pin) return;
      p.classList.remove("hidden");
      requestAnimationFrame(() => p.classList.add("on"));
      // 미로그인 작성자 입력 표시
      const ar = document.getElementById("pnp-author-row");
      if (ar) ar.classList.toggle("hidden", !!(Auth && Auth.user));
      this.loadForPin();
    },
    closePanel() {
      const p = document.getElementById("pano-notes-panel");
      if (!p) return;
      p.classList.remove("on");
      setTimeout(() => p.classList.add("hidden"), 200);
    },

    async loadForPin() {
      const dep = State.currentDeploymentId;
      const pin = this._pin;
      const listEl = document.getElementById("pnp-list");
      if (!dep || !pin) { if (listEl) listEl.innerHTML = ""; return; }
      if (listEl) listEl.innerHTML = '<div class="pnp-loading">불러오는 중…</div>';
      try {
        const r = await fetch("/api/notes?deployment_id=" + encodeURIComponent(dep) + "&pin_id=" + encodeURIComponent(pin.id));
        const j = await r.json();
        this._list = j.data || [];
      } catch (e) { this._list = []; }
      this.render();
    },

    render() {
      const listEl = document.getElementById("pnp-list");
      const emptyEl = document.getElementById("pnp-empty");
      if (!listEl) return;
      let items = this._list;
      if (this._filter !== "all") items = items.filter((n) => n.status === this._filter);
      if (items.length === 0) {
        listEl.innerHTML = "";
        emptyEl && emptyEl.classList.remove("hidden");
        this._syncHeaderCount();
        return;
      }
      emptyEl && emptyEl.classList.add("hidden");
      const canEdit = (n) => {
        if (!Auth) return false;
        if (Auth.isDesigner) return true;
        return n.author_email && Auth.user && n.author_email === Auth.user.email;
      };
      listEl.innerHTML = items.map((n) => {
        const st = n.status || "open";
        const stLabel = this.STATUS[st] || st;
        const assignee = n.assignee ? `<span class="pnp-assignee-tag">👤 ${UI.escapeHtml(n.assignee)}</span>` : "";
        const editable = canEdit(n);
        const stBtns = editable ? `
          <div class="pnp-status-actions">
            ${["open","progress","done"].map((s) =>
              `<button class="pnp-st-btn ${s} ${s===st?'active':''}" data-act="status" data-id="${n.id}" data-status="${s}">${this.STATUS[s]}</button>`
            ).join("")}
            <button class="pnp-del" data-act="del" data-id="${n.id}" title="삭제">✕</button>
          </div>` : "";
        return `
          <article class="pnp-item st-${st}" data-id="${n.id}">
            <div class="pnp-item-head">
              <span class="pnp-badge st-${st}">${stLabel}</span>
              <span class="pnp-author">${UI.escapeHtml(n.author || "익명")}</span>
              ${assignee}
              <span class="pnp-time">${this._timeAgo(n.created_at)}</span>
            </div>
            <div class="pnp-body">${UI.escapeHtml(n.body)}</div>
            ${stBtns}
          </article>`;
      }).join("");
      // 이벤트 위임
      listEl.querySelectorAll('[data-act="status"]').forEach((b) => {
        b.addEventListener("click", () => this.updateStatus(b.dataset.id, b.dataset.status));
      });
      listEl.querySelectorAll('[data-act="del"]').forEach((b) => {
        b.addEventListener("click", () => this.remove(b.dataset.id));
      });
      this._syncHeaderCount();
    },

    async submit() {
      if (this._busy) return;
      const dep = State.currentDeploymentId;
      const pin = this._pin;
      if (!dep || !pin) return;
      const input = document.getElementById("pnp-input");
      const body = (input.value || "").trim();
      if (!body) { input.focus(); return; }
      const status = (document.getElementById("pnp-status-sel") || {}).value || "open";
      const assignee = (document.getElementById("pnp-assignee") || {}).value || "";
      const author = (document.getElementById("pnp-author") || {}).value || "";
      this._busy = true;
      const submitBtn = document.getElementById("pnp-submit");
      if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "등록 중…"; }
      try {
        const r = await fetch("/api/notes", {
          method: "POST",
          headers: Auth.headers(),
          body: JSON.stringify({
            deployment_id: dep, pin_id: pin.id, pin_label: pin.label || "",
            body, status, assignee, author,
          }),
        });
        if (r.ok) {
          input.value = "";
          if (document.getElementById("pnp-assignee")) document.getElementById("pnp-assignee").value = "";
          await this.loadForPin();
          await this.loadSummary();
        }
      } catch (e) {}
      this._busy = false;
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "등록"; }
    },

    async updateStatus(id, status) {
      try {
        const r = await fetch("/api/notes/" + encodeURIComponent(id), {
          method: "PATCH", headers: Auth.headers(),
          body: JSON.stringify({ status }),
        });
        if (r.ok) { await this.loadForPin(); await this.loadSummary(); }
      } catch (e) {}
    },

    async remove(id) {
      if (!confirm("이 이슈/노트를 삭제할까요?")) return;
      try {
        const r = await fetch("/api/notes/" + encodeURIComponent(id), {
          method: "DELETE", headers: Auth.headers(),
        });
        if (r.ok) { await this.loadForPin(); await this.loadSummary(); }
      } catch (e) {}
    },

    _timeAgo(v) {
      const n = (typeof v === "number") ? v : Date.parse(v);
      if (!Number.isFinite(n)) return "";
      const diff = Date.now() - n;
      const m = Math.floor(diff / 60000);
      if (m < 1) return "방금";
      if (m < 60) return m + "분 전";
      const h = Math.floor(m / 60);
      if (h < 24) return h + "시간 전";
      const d = new Date(n);
      const p = (x) => String(x).padStart(2, "0");
      return (d.getMonth() + 1) + "." + p(d.getDate());
    },
  };

  /* ══════════════════════════════════════════
     TIMELAPSE ── 같은 위치의 시점별(전/후) 파노라마 비교
        · 핀.timeline[] = [{id,label,imageId|imageUrl,isVideo,capturedAt}]
        · timeline 없으면 현재 단일 파노라마를 1개 시점으로 취급
        · 시점 전환 시 카메라 각도(lon/lat/fov) 유지 → 정확한 전/후 비교
        · 분할비교: 좌=선택 시점, 우=최신, 슬라이더로 경계 이동
  ══════════════════════════════════════════ */
  const TimeLapse = {
    _pin: null,
    _shots: [],       // 정규화된 시점 배열 (오래된 → 최신)
    _idx: 0,          // 현재 표시 중인 시점 index
    _busy: false,

    init() {
      const $ = (id) => document.getElementById(id);
      $("btn-tl-prev") && $("btn-tl-prev").addEventListener("click", () => this.step(-1));
      $("btn-tl-next") && $("btn-tl-next").addEventListener("click", () => this.step(1));
      $("btn-tl-compare") && $("btn-tl-compare").addEventListener("click", () => Compare.open());
    },

    /** 핀의 timeline을 정규화 (단일 파노라마 fallback 포함) */
    _normalize(pin) {
      const out = [];
      if (Array.isArray(pin.timeline) && pin.timeline.length) {
        pin.timeline.forEach((t, i) => {
          if (!t) return;
          out.push({
            id: t.id || ("tl" + i),
            label: t.label || ("시점 " + (i + 1)),
            imageId: t.imageId || null,
            imageUrl: t.imageUrl || null,
            isVideo: !!t.isVideo,
            capturedAt: t.capturedAt || null,
          });
        });
      }
      // 현재 핀의 기본 파노라마를 "최신" 시점으로 합류(이미 timeline에 동일 소스가 없을 때만)
      const baseSrc = pin.imageId || pin.imageUrl || pin.videoUrl;
      if (baseSrc) {
        const dup = out.some((s) => (s.imageId && s.imageId === pin.imageId) || (s.imageUrl && s.imageUrl === pin.imageUrl));
        if (!dup) {
          out.push({
            id: "current",
            label: out.length ? "현재" : (pin.label || "현재"),
            imageId: pin.imageId || null,
            imageUrl: pin.imageUrl || null,
            isVideo: !!(pin.videoUrl || pin.isVideo),
            videoUrl: pin.videoUrl || null,
            capturedAt: pin.capturedAt || null,
          });
        }
      }
      // 정렬: capturedAt 있는 것 우선 시간순, 없으면 입력 순서 유지(최신은 끝)
      return out;
    },

    /** 파노라마 열릴 때 호출 — 시점 바 구성 */
    setPin(pin) {
      this._pin = pin || null;
      this._shots = pin ? this._normalize(pin) : [];
      this._idx = Math.max(0, this._shots.length - 1); // 기본 = 최신
      this._renderBar();
    },

    _renderBar() {
      const bar = document.getElementById("pano-timeline");
      if (!bar) return;
      // 시점 2개 이상일 때만 표시
      if (this._shots.length < 2) { bar.classList.add("hidden"); return; }
      bar.classList.remove("hidden");
      const cur = document.getElementById("tl-current");
      if (cur) cur.textContent = (this._idx + 1) + " / " + this._shots.length;
      this.render();
    },

    render() {
      const wrap = document.getElementById("tl-chips");
      if (!wrap) return;
      wrap.innerHTML = this._shots.map((s, i) => {
        const active = i === this._idx ? " active" : "";
        const latest = i === this._shots.length - 1 ? '<span class="tl-chip-tag">최신</span>' : "";
        const sub = s.capturedAt ? `<span class="tl-chip-date">${this._fmtDate(s.capturedAt)}</span>` : "";
        return `<button class="tl-chip${active}" data-i="${i}" title="${UI.escapeHtml(s.label)}">
          <span class="tl-chip-label">${UI.escapeHtml(s.label)}</span>${sub}${latest}
        </button>`;
      }).join("");
      wrap.querySelectorAll(".tl-chip").forEach((b) => {
        b.addEventListener("click", () => this.goto(parseInt(b.dataset.i, 10)));
      });
    },

    step(delta) {
      const n = this._shots.length;
      if (n < 2) return;
      let i = this._idx + delta;
      if (i < 0) i = 0; if (i > n - 1) i = n - 1;
      if (i !== this._idx) this.goto(i);
    },

    /** 시점 전환 — 카메라 각도 유지하며 소스 교체 */
    async goto(i) {
      if (this._busy) return;
      const n = this._shots.length;
      if (i < 0 || i >= n || i === this._idx) return;
      const shot = this._shots[i];
      this._idx = i;
      this._busy = true;
      // 현재 카메라 각도 보존
      const cam = { lon: PanoViewer.S.lon, lat: PanoViewer.S.lat, fov: PanoViewer.S.fov };
      try {
        const src = await this._resolveSrc(shot);
        if (src == null) { this._busy = false; return; }
        await this._loadKeepingCamera(src, shot, cam);
      } catch (e) {
        if (typeof console !== "undefined") console.warn("timelapse goto fail", e);
      }
      this._busy = false;
      this._renderBar();
    },

    /** 시점 소스 해석 (클라우드 이미지 → dataURL, URL → 그대로) */
    async _resolveSrc(shot) {
      if (shot.videoUrl) return { src: shot.videoUrl, isVideo: true };
      if (shot.imageId) {
        const dataURL = await Cloud.fetchImage(shot.imageId);
        return { src: dataURL, isVideo: false };
      }
      if (shot.imageUrl) return { src: shot.imageUrl, isVideo: !!shot.isVideo };
      return null;
    },

    _loadKeepingCamera(resolved, shot, cam) {
      return new Promise((resolve) => {
        const name = (this._pin ? (this._pin.label || "") : "") + " · " + shot.label;
        if (resolved.isVideo) {
          PanoViewer.loadVideo(resolved.src, name);
          // 비디오는 즉시 각도 복원 시도
          setTimeout(() => { Object.assign(PanoViewer.S, cam); PanoViewer._invalidate && PanoViewer._invalidate(); resolve(); }, 50);
          return;
        }
        PanoViewer.load(resolved.src, name);
        // load는 img.onload 후 S를 리셋하므로, 다음 틱에 각도 복원
        setTimeout(() => {
          Object.assign(PanoViewer.S, cam);
          PanoViewer._invalidate && PanoViewer._invalidate();
          resolve();
        }, 60);
      });
    },

    currentShot() { return this._shots[this._idx] || null; },
    latestShot()  { return this._shots[this._shots.length - 1] || null; },
    hasMultiple() { return this._shots.length >= 2; },

    hide() {
      const bar = document.getElementById("pano-timeline");
      if (bar) bar.classList.add("hidden");
    },

    _fmtDate(v) {
      const n = (typeof v === "number") ? v : Date.parse(v);
      if (!Number.isFinite(n)) return String(v);
      const d = new Date(n);
      const p = (x) => String(x).padStart(2, "0");
      return (d.getFullYear() + "").slice(2) + "." + p(d.getMonth() + 1) + "." + p(d.getDate());
    },
  };

  /* ══════════════════════════════════════════
     COMPARE ── 전/후 분할 비교(좌=선택시점, 우=최신) + 슬라이더
        · 2개 정적 이미지를 canvas로 그려 클립 경계 이동
        · 같은 위치를 한 화면에서 직접 대조 (OpenSpace/Matterport 비교 모방)
  ══════════════════════════════════════════ */
  const Compare = {
    _a: null, _b: null, _ratio: 0.5, _dragging: false, _busy: false,

    async open() {
      if (this._busy) return;
      if (!TimeLapse.hasMultiple()) { return; }
      const a = TimeLapse.currentShot();      // 선택 시점(과거)
      const b = TimeLapse.latestShot();       // 최신
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
        im.onload = () => res(im); im.onerror = rej; im.src = src;
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

    close() {
      const ov = document.getElementById("pano-compare");
      if (ov) ov.classList.add("hidden");
      this._a = this._b = null;
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
  const Zones = {
    _drag: null,        // {sx,sy} 시작 % 좌표 (rect/circle 드래그)
    _active: null,      // 현재 하이라이트된 zone id
    _shape: "rect",     // 현재 그리기 도형: rect | circle | poly
    _poly: null,        // 다각형 그리는 중 점 배열 [{x,y}...]

    _newId() { return "zone_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); },

    init() {
      const $ = (id) => document.getElementById(id);
      // 도형 도구 버튼 (사각형/원형/다각형)
      ["rect", "circle", "poly"].forEach(sh => {
        const b = $("btn-zone-" + sh);
        if (b) b.addEventListener("click", () => this.pickShape(sh));
      });
      // 레거시 단일 버튼 호환
      $("btn-zone") && $("btn-zone").addEventListener("click", () => this.toggleDraw());
      // 다각형: 더블클릭/Enter 로 완료
      const vp = $("map-viewport");
      if (vp) vp.addEventListener("dblclick", (e) => { if (State.drawingZone && this._shape === "poly" && this._poly && this._poly.length >= 3) { e.preventDefault(); this._finishPoly(); } });
      document.addEventListener("keydown", (e) => {
        if (!State.drawingZone) return;
        if (e.key === "Enter" && this._shape === "poly" && this._poly && this._poly.length >= 3) { e.preventDefault(); this._finishPoly(); }
        if (e.key === "Escape") { this._cancelDraw(); }
      });
    },

    isDesigner() { return !!(typeof Auth !== "undefined" && Auth.isDesigner); },

    /** 도형 선택 → 그리기 모드 토글 */
    pickShape(shape) {
      if (!this.isDesigner()) return;
      // 같은 도형 다시 누르면 끄기
      if (State.drawingZone && this._shape === shape) { this._cancelDraw(); return; }
      this._shape = shape;
      this._poly = null;
      if (!State.drawingZone) State.drawingZone = true;
      // 핀 배치 모드와 상호 배타
      if (State.placing) {
        State.placing = false;
        UI.$("btn-place") && UI.$("btn-place").classList.remove("active");
        UI.$("place-hint") && UI.$("place-hint").classList.add("hidden");
        UI.$("crosshair-overlay") && UI.$("crosshair-overlay").classList.add("hidden");
      }
      this._syncToolUi();
    },

    /** 레거시 toggle (뷰어 차단/기본 rect) */
    toggleDraw() {
      if (!this.isDesigner()) { State.drawingZone = false; return; }
      State.drawingZone = !State.drawingZone;
      this._poly = null;
      if (State.drawingZone && State.placing) {
        State.placing = false;
        UI.$("btn-place") && UI.$("btn-place").classList.remove("active");
        UI.$("place-hint") && UI.$("place-hint").classList.add("hidden");
        UI.$("crosshair-overlay") && UI.$("crosshair-overlay").classList.add("hidden");
      }
      this._syncToolUi();
    },

    _cancelDraw() {
      State.drawingZone = false;
      this._poly = null; this._drag = null;
      this._clearDraft();
      this._syncToolUi();
    },

    _syncToolUi() {
      ["rect", "circle", "poly"].forEach(sh => {
        const b = UI.$("btn-zone-" + sh);
        if (b) b.classList.toggle("active", State.drawingZone && this._shape === sh);
      });
      const btn = UI.$("btn-zone");
      if (btn) btn.classList.toggle("active", State.drawingZone);
      const hint = UI.$("zone-hint");
      if (hint) hint.classList.toggle("hidden", !(State.drawingZone && this._shape !== "poly"));
      const ph = UI.$("zone-poly-hint");
      if (ph) ph.classList.toggle("hidden", !(State.drawingZone && this._shape === "poly"));
      const vp = UI.$("map-viewport");
      if (vp) vp.style.cursor = State.drawingZone ? "crosshair" : "grab";
      this._renderDraft();
    },

    /* ── 드래그 그리기 (rect/circle) ── */
    onDrawStart(clientX, clientY) {
      if (!State.drawingZone) return false;
      const pct = MapCtrl.viewportToPercent(clientX, clientY);
      if (!pct) return false;
      if (this._shape === "poly") {
        // 다각형: 클릭마다 점 추가 (시작점 근처 클릭 시 닫기)
        this._poly = this._poly || [];
        if (this._poly.length >= 3) {
          const s = this._poly[0];
          if (Math.hypot(pct.x - s.x, pct.y - s.y) < 2.2) { this._finishPoly(); return true; }
        }
        this._poly.push({ x: +pct.x.toFixed(3), y: +pct.y.toFixed(3) });
        this._renderDraft();
        return true;
      }
      this._drag = { sx: pct.x, sy: pct.y, cx: pct.x, cy: pct.y };
      this._renderDraft();
      return true;
    },
    onDrawMove(clientX, clientY) {
      const pct = MapCtrl.viewportToPercent(clientX, clientY);
      if (!pct) return;
      if (this._shape === "poly") { this._polyCursor = { x: pct.x, y: pct.y }; this._renderDraft(); return; }
      if (!this._drag) return;
      this._drag.cx = pct.x; this._drag.cy = pct.y;
      this._renderDraft();
    },
    async onDrawEnd(clientX, clientY) {
      if (this._shape === "poly") return; // 다각형은 클릭 누적 방식
      if (!this._drag) return;
      const pct = MapCtrl.viewportToPercent(clientX, clientY);
      const start = this._drag; this._drag = null;
      this._clearDraft();
      if (!pct) return;
      const x = Math.min(start.sx, pct.x), y = Math.min(start.sy, pct.y);
      const w = Math.abs(pct.x - start.sx), h = Math.abs(pct.y - start.sy);
      if (w < 1.5 || h < 1.5) { this._cancelDraw(); return; } // 너무 작은 영역 무시
      let geom;
      if (this._shape === "circle") {
        const cx = (start.sx + pct.x) / 2, cy = (start.sy + pct.y) / 2;
        const r = Math.max(w, h) / 2;
        geom = { shape: "circle", cx: +cx.toFixed(3), cy: +cy.toFixed(3), r: +r.toFixed(3) };
      } else {
        geom = { shape: "rect", x: +x.toFixed(3), y: +y.toFixed(3), w: +w.toFixed(3), h: +h.toFixed(3) };
      }
      await this._commitZone(geom);
    },

    /** 다각형 완료 → 닫힌 구역으로 저장 */
    async _finishPoly() {
      const pts = (this._poly || []).map(p => ({ x: +p.x.toFixed(3), y: +p.y.toFixed(3) }));
      this._poly = null; this._polyCursor = null;
      this._clearDraft();
      if (pts.length < 3) { this._cancelDraw(); return; }
      await this._commitZone({ shape: "poly", points: pts });
    },

    /** 도형 → 라벨 입력 → zone 객체 생성/저장 (공통) */
    async _commitZone(geom) {
      let label = "";
      const defLabel = "구역 " + (State.zones.filter(z => (z.page||1)===(State.pdfPage||1)).length + 1);
      if (typeof Prompt !== "undefined" && Prompt.ask) {
        try { const r = await Prompt.ask({ title: "영역 이름", placeholder: "예: 1번 화물창 / 엔진룸 구역" }); if (r && r.value != null && r.value !== "") label = r.value; else if (r && r.value === "") label = defLabel; else { this._cancelDraw(); return; } }
        catch (e) { this._cancelDraw(); return; }
      } else {
        label = prompt("영역 이름", defLabel) || "";
        if (!label) { this._cancelDraw(); return; }
      }
      const color = ZONE_COLORS[State.zones.length % ZONE_COLORS.length];
      const bb = this._bbox(geom);
      const zone = Object.assign({
        id: this._newId(), page: State.pdfPage || 1,
        label: label || defLabel, color, pinIds: [], note: "",
        x: bb.x, y: bb.y, w: bb.w, h: bb.h, // 항상 바운딩 박스 보관(검색/플라이 호환)
      }, geom);
      zone.pinIds = (State.pins || []).filter(p => (p.page||1) === zone.page && this._contains(zone, p.x, p.y)).map(p => p.id);
      State.zones.push(zone);
      this._cancelDraw();
      this.render();
      this.renderList();
      if (typeof App !== "undefined" && App._autoSave) App._autoSave();
    },

    /** 도형의 바운딩 박스(%) 계산 */
    _bbox(g) {
      if (g.shape === "circle") return { x: +(g.cx - g.r).toFixed(3), y: +(g.cy - g.r).toFixed(3), w: +(g.r * 2).toFixed(3), h: +(g.r * 2).toFixed(3) };
      if (g.shape === "poly") {
        const xs = g.points.map(p => p.x), ys = g.points.map(p => p.y);
        const minX = Math.min(...xs), minY = Math.min(...ys);
        return { x: +minX.toFixed(3), y: +minY.toFixed(3), w: +(Math.max(...xs) - minX).toFixed(3), h: +(Math.max(...ys) - minY).toFixed(3) };
      }
      return { x: g.x, y: g.y, w: g.w, h: g.h };
    },

    /** 점(x,y%)이 영역(도형) 내부인지 — rect/circle/poly 각각 정확 판정 */
    _contains(z, x, y) {
      if (z.shape === "circle") return Math.hypot(x - z.cx, y - z.cy) <= z.r;
      if (z.shape === "poly" && Array.isArray(z.points)) {
        let inside = false; const pts = z.points;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
          if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-9) + xi)) inside = !inside;
        }
        return inside;
      }
      return x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h;
    },

    /* ── 그리기 미리보기(SVG draft) ── */
    _clearDraft() {
      this._polyCursor = null;
      const svg = document.getElementById("zones-svg");
      if (svg) { const d = svg.querySelector(".zone-draft-svg"); if (d) d.remove(); }
      const legacy = document.getElementById("zone-draft");
      if (legacy) { legacy.classList.add("hidden"); }
    },
    _renderDraft() {
      const svg = document.getElementById("zones-svg");
      if (!svg) return;
      let d = svg.querySelector(".zone-draft-svg");
      if (d) d.remove();
      if (!State.drawingZone) return;
      d = document.createElementNS("http://www.w3.org/2000/svg", "g");
      d.setAttribute("class", "zone-draft-svg");
      let inner = "";
      if (this._shape === "rect" && this._drag) {
        const x = Math.min(this._drag.sx, this._drag.cx), y = Math.min(this._drag.sy, this._drag.cy);
        const w = Math.abs(this._drag.cx - this._drag.sx), h = Math.abs(this._drag.cy - this._drag.sy);
        inner = `<rect x="${x}" y="${y}" width="${w}" height="${h}" class="zd-shape"/>`;
      } else if (this._shape === "circle" && this._drag) {
        const cx = (this._drag.sx + this._drag.cx) / 2, cy = (this._drag.sy + this._drag.cy) / 2;
        const r = Math.max(Math.abs(this._drag.cx - this._drag.sx), Math.abs(this._drag.cy - this._drag.sy)) / 2;
        inner = `<ellipse cx="${cx}" cy="${cy}" rx="${r}" ry="${r}" class="zd-shape"/>`;
      } else if (this._shape === "poly" && this._poly && this._poly.length) {
        const live = this._polyCursor ? this._poly.concat([this._polyCursor]) : this._poly;
        const pts = live.map(p => `${p.x},${p.y}`).join(" ");
        inner = `<polyline points="${pts}" class="zd-line"/>` +
          this._poly.map((p, i) => `<circle cx="${p.x}" cy="${p.y}" r="${i === 0 ? 1.3 : 0.9}" class="zd-dot${i === 0 ? " first" : ""}"/>`).join("");
      }
      d.innerHTML = inner;
      svg.appendChild(d);
    },

    _shapeLabel(z) { return z.shape === "circle" ? "원형" : z.shape === "poly" ? "다각형" : "사각형"; },
    _shapeIcon(z) {
      const c = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
      if (z.shape === "circle") return `<svg viewBox="0 0 24 24" ${c}><circle cx="12" cy="12" r="8.5"/></svg>`;
      if (z.shape === "poly") return `<svg viewBox="0 0 24 24" ${c}><polygon points="12,3 21,9 17.5,20 6.5,20 3,9"/></svg>`;
      return `<svg viewBox="0 0 24 24" ${c}><rect x="3.5" y="5.5" width="17" height="13" rx="1.5"/></svg>`;
    },

    /* ── 렌더: 도면 위 영역 (SVG 도형 + HTML 라벨/삭제) ── */
    render() {
      const page = State.pdfPage || 1;
      const zones = (State.zones || []).filter(z => (z.page || 1) === page);
      const svg = document.getElementById("zones-svg");
      const layer = document.getElementById("zones-layer");
      if (!svg || !layer) return;

      // 1) SVG 도형(채움+테두리)
      const draft = svg.querySelector(".zone-draft-svg");
      svg.innerHTML = zones.map(z => {
        const a = z.id === this._active ? " active" : "";
        if (z.shape === "circle") return `<ellipse data-zone="${z.id}" class="zone-shape${a}" cx="${z.cx}" cy="${z.cy}" rx="${z.r}" ry="${z.r}" style="--zc:${z.color}"/>`;
        if (z.shape === "poly") return `<polygon data-zone="${z.id}" class="zone-shape${a}" points="${(z.points||[]).map(p=>p.x+","+p.y).join(" ")}" style="--zc:${z.color}"/>`;
        return `<rect data-zone="${z.id}" class="zone-shape${a}" x="${z.x}" y="${z.y}" width="${z.w}" height="${z.h}" rx="0.6" style="--zc:${z.color}"/>`;
      }).join("");
      if (draft) svg.appendChild(draft);

      // 2) HTML 라벨/삭제 버튼 (바운딩 박스 좌상단)
      layer.innerHTML = zones.map(z => {
        const isActive = z.id === this._active;
        const cnt = (z.pinIds || []).length;
        return `<div class="zone-box${isActive ? " active" : ""}" data-zone="${z.id}"
            style="left:${z.x}%;top:${z.y}%;width:${z.w}%;height:${z.h}%;--zc:${z.color}">
            <div class="zone-box-label">${UI.escapeHtml(z.label)}${cnt ? ` <span class="zone-box-cnt">${cnt}</span>` : ""}</div>
            ${this.isDesigner() ? `<button class="zone-box-del" data-zdel="${z.id}" title="영역 삭제" aria-label="영역 삭제"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></button>` : ""}
          </div>`;
      }).join("");

      // 이벤트 — SVG 도형 + HTML 박스
      svg.querySelectorAll(".zone-shape").forEach(el => {
        const id = el.getAttribute("data-zone");
        el.addEventListener("mouseenter", () => this.highlight(id));
        el.addEventListener("mouseleave", () => this.highlight(null));
        el.addEventListener("click", () => this.focus(id));
      });
      layer.querySelectorAll(".zone-box").forEach(el => {
        const id = el.dataset.zone;
        el.addEventListener("mouseenter", () => this.highlight(id));
        el.addEventListener("mouseleave", () => this.highlight(null));
        el.addEventListener("click", (e) => { if (e.target.closest("[data-zdel]")) return; this.inspect(id); });
      });
      layer.querySelectorAll("[data-zdel]").forEach(b => {
        b.addEventListener("click", (e) => { e.stopPropagation(); this.remove(b.dataset.zdel); });
      });
    },

    /* ── 사이드바 목록 ── */
    renderList() {
      const sec = document.getElementById("section-zones");
      const list = document.getElementById("zone-list");
      const cntEl = document.getElementById("zone-count");
      if (!list) return;
      const zones = State.zones || [];
      if (cntEl) cntEl.textContent = zones.length;
      if (sec) sec.classList.toggle("hidden", zones.length === 0 && !this.isDesigner());
      if (zones.length === 0) {
        list.innerHTML = `<p class="zone-empty">${this.isDesigner() ? "위 ‘영역 지정 도구’(사각형·원형·선)로 구역을 그려보세요." : "지정된 영역이 없습니다."}</p>`;
        return;
      }
      list.innerHTML = zones.map(z => {
        const cnt = (z.pinIds || []).length;
        return `<div class="zone-item" data-zone="${z.id}">
            <span class="zone-item-color" style="background:${z.color}"></span>
            <span class="zone-item-shape" title="${this._shapeLabel(z)}">${this._shapeIcon(z)}</span>
            <span class="zone-item-label">${UI.escapeHtml(z.label)}</span>
            <span class="zone-item-page">p.${z.page || 1}</span>
            <span class="zone-item-cnt" title="연결된 핀"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>${cnt}</span>
            <span class="zone-item-arrow" title="상세 정보"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg></span>
          </div>`;
      }).join("");
      list.querySelectorAll(".zone-item").forEach(el => {
        const id = el.dataset.zone;
        el.addEventListener("mouseenter", () => this.highlight(id));
        el.addEventListener("mouseleave", () => this.highlight(null));
        el.addEventListener("click", () => this.inspect(id));
      });
    },

    /** 영역 + 내부 핀 하이라이트 */
    highlight(id) {
      this._active = id;
      // SVG 도형
      document.querySelectorAll("#zones-svg .zone-shape").forEach(el => {
        el.classList.toggle("active", el.getAttribute("data-zone") === id);
      });
      // 영역 박스(라벨)
      document.querySelectorAll("#zones-layer .zone-box").forEach(el => {
        el.classList.toggle("active", el.dataset.zone === id);
      });
      // 사이드바 항목
      document.querySelectorAll("#zone-list .zone-item").forEach(el => {
        el.classList.toggle("active", el.dataset.zone === id);
      });
      // 내부 핀 강조
      const zone = id ? (State.zones || []).find(z => z.id === id) : null;
      const ids = zone ? new Set(zone.pinIds || []) : new Set();
      document.querySelectorAll("#pins-layer .pin-marker").forEach(el => {
        const pid = el.dataset.pinId || el.dataset.id;
        el.classList.toggle("zone-dim", !!id && !ids.has(pid));
        el.classList.toggle("zone-hot", !!id && ids.has(pid));
      });
    },

    /** 영역으로 화면 이동(플라이) + 일시 하이라이트 */
    focus(id) {
      const zone = (State.zones || []).find(z => z.id === id);
      if (!zone) return;
      // 다른 페이지면 페이지 전환 후 이동
      if ((zone.page || 1) !== (State.pdfPage || 1) && typeof App !== "undefined" && App._gotoPage) {
        Promise.resolve(App._gotoPage(zone.page)).then(() => {
          this.render();
          setTimeout(() => { this._flyToZone(zone); this.highlight(id); }, 60);
        });
        return;
      }
      this._flyToZone(zone);
      this.highlight(id);
    },
    _flyToZone(zone) {
      const cx = zone.x + zone.w / 2, cy = zone.y + zone.h / 2;
      // 영역 크기에 맞춰 줌 (작은 영역일수록 더 확대)
      const span = Math.max(zone.w, zone.h);
      const z = Math.max(1, Math.min(4.5, 60 / Math.max(span, 8)));
      if (MapCtrl.flyTo) MapCtrl.flyTo(cx, cy, z, 650);
    },

    remove(id) {
      if (!this.isDesigner()) return;
      const z = (State.zones || []).find(x => x.id === id);
      if (!z) return;
      if (!confirm(`영역 “${z.label}”을(를) 삭제할까요?`)) return;
      State.zones = (State.zones || []).filter(x => x.id !== id);
      if (this._active === id) this._active = null;
      this.render();
      this.renderList();
      if (typeof App !== "undefined" && App._autoSave) App._autoSave();
    },

    /** 핀 추가/이동 후 영역-핀 연결 갱신 */
    refreshPinLinks() {
      (State.zones || []).forEach(z => {
        z.pinIds = (State.pins || []).filter(p => (p.page||1) === (z.page||1) && this._contains(z, p.x, p.y)).map(p => p.id);
      });
    },

    /* ── CAD 인스펙터: 구역 상세 ── */
    inspect(id) {
      const z = (State.zones || []).find(x => x.id === id);
      if (!z) return;
      this.focus(id);
      Inspector.showZone(z);
    },

    serialize() { return JSON.stringify(State.zones || []); },
    load(arr) {
      State.zones = Array.isArray(arr) ? arr : [];
      this.render();
      this.renderList();
    },
  };

  /* ══════════════════════════════════════════
     INSPECTOR — CAD/3D 스타일 우측 상세 패널(구역/포인트)
  ══════════════════════════════════════════ */
  const Inspector = {
    _kind: null, _id: null,

    _open() {
      const el = document.getElementById("inspector");
      if (!el) return;
      el.classList.remove("hidden");
      requestAnimationFrame(() => el.classList.add("on"));
    },
    close() {
      const el = document.getElementById("inspector");
      if (!el) return;
      el.classList.remove("on");
      setTimeout(() => el.classList.add("hidden"), 220);
      this._kind = null; this._id = null;
      if (typeof Zones !== "undefined") Zones.highlight(null);
    },
    init() {
      const c = document.getElementById("inspector-close");
      if (c) c.addEventListener("click", () => this.close());
    },

    _fmt(n) { return (Math.round((n || 0) * 10) / 10).toFixed(1); },
    _shapeName(z) {
      if (z.shape === "circle") return "원형 (CIRCLE)";
      if (z.shape === "poly") return "다각형 (POLYGON)";
      return "사각형 (RECT)";
    },
    _area(z) {
      // % 기준 근사 면적
      if (z.shape === "circle") {
        const r = Math.max(z.w, z.h) / 2;
        return Math.PI * r * r;
      }
      if (z.shape === "poly" && Array.isArray(z.points) && z.points.length > 2) {
        let a = 0; const p = z.points;
        for (let i = 0, n = p.length; i < n; i++) {
          const j = (i + 1) % n;
          a += p[i].x * p[j].y - p[j].x * p[i].y;
        }
        return Math.abs(a) / 2;
      }
      return (z.w || 0) * (z.h || 0);
    },

    showZone(z) {
      this._kind = "zone"; this._id = z.id;
      const kindEl = document.getElementById("inspector-kind");
      const titleEl = document.getElementById("inspector-title");
      const body = document.getElementById("inspector-body");
      if (kindEl) { kindEl.textContent = "ZONE"; kindEl.className = "inspector-kind kind-zone"; }
      if (titleEl) titleEl.textContent = z.label || "(이름 없음)";

      const pins = (State.pins || []).filter(p => (z.pinIds || []).includes(p.id));
      const cx = z.x + (z.w || 0) / 2, cy = z.y + (z.h || 0) / 2;
      const designer = (typeof Auth !== "undefined" && Auth.isDesigner);

      const pinRows = pins.length
        ? pins.map((p, i) => `<button class="insp-pinrow" data-pin="${p.id}">
              <span class="insp-pinrow-no">${i + 1}</span>
              <span class="insp-pinrow-label">${UI.escapeHtml(p.label || "포인트")}</span>
              ${p.imageId || p.url || (p.attachments && p.attachments.length) ? '<span class="insp-pinrow-tag">360°</span>' : ''}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 18l6-6-6-6"/></svg>
           </button>`).join("")
        : `<div class="insp-empty">이 구역에 연결된 포인트가 없습니다.</div>`;

      body.innerHTML = `
        <div class="insp-swatch-row">
          <span class="insp-swatch" style="background:${z.color}"></span>
          <span class="insp-shape-name">${this._shapeName(z)}</span>
          <span class="insp-page-badge">PAGE ${z.page || 1}</span>
        </div>

        <div class="insp-section">
          <div class="insp-section-h">좌표 · 치수 <span class="insp-unit">(도면 % 기준)</span></div>
          <div class="insp-metrics">
            <div class="insp-metric"><span class="m-k">X</span><span class="m-v">${this._fmt(z.x)}%</span></div>
            <div class="insp-metric"><span class="m-k">Y</span><span class="m-v">${this._fmt(z.y)}%</span></div>
            <div class="insp-metric"><span class="m-k">W</span><span class="m-v">${this._fmt(z.w)}%</span></div>
            <div class="insp-metric"><span class="m-k">H</span><span class="m-v">${this._fmt(z.h)}%</span></div>
            <div class="insp-metric"><span class="m-k">중심</span><span class="m-v">${this._fmt(cx)} , ${this._fmt(cy)}</span></div>
            <div class="insp-metric"><span class="m-k">면적</span><span class="m-v">${this._fmt(this._area(z))}%²</span></div>
          </div>
        </div>

        <div class="insp-section">
          <div class="insp-section-h">연결 포인트 <span class="insp-count">${pins.length}</span></div>
          <div class="insp-pinlist">${pinRows}</div>
        </div>

        ${z.note ? `<div class="insp-section"><div class="insp-section-h">메모</div><div class="insp-note">${UI.escapeHtml(z.note)}</div></div>` : ""}

        <div class="insp-actions">
          <button class="insp-btn primary" data-act="fly">화면 이동</button>
          ${designer ? `<button class="insp-btn ghost" data-act="rename">이름 변경</button>
          <button class="insp-btn danger" data-act="del">구역 삭제</button>` : ""}
        </div>
      `;

      // 핀 행 클릭 → 핀 인스펙터
      body.querySelectorAll(".insp-pinrow").forEach(b => {
        b.addEventListener("click", () => {
          const p = (State.pins || []).find(x => x.id === b.dataset.pin);
          if (p) this.showPin(p);
        });
      });
      // 액션
      body.querySelectorAll(".insp-btn").forEach(b => {
        b.addEventListener("click", () => {
          const act = b.dataset.act;
          if (act === "fly") Zones.focus(z.id);
          else if (act === "del") { Zones.remove(z.id); this.close(); }
          else if (act === "rename") {
            const nv = prompt("구역 이름", z.label || "");
            if (nv != null) { z.label = nv.trim() || z.label; Zones.render(); Zones.renderList(); this.showZone(z); if (App._autoSave) App._autoSave(); }
          }
        });
      });
      this._open();
    },

    showPin(p) {
      this._kind = "pin"; this._id = p.id;
      const kindEl = document.getElementById("inspector-kind");
      const titleEl = document.getElementById("inspector-title");
      const body = document.getElementById("inspector-body");
      if (kindEl) { kindEl.textContent = "POINT"; kindEl.className = "inspector-kind kind-pin"; }
      if (titleEl) titleEl.textContent = p.label || "포인트";

      const designer = (typeof Auth !== "undefined" && Auth.isDesigner);
      const has360 = !!(p.imageId || (p.attachments && p.attachments.length));
      const inZone = (State.zones || []).find(z => (z.pinIds || []).includes(p.id));
      const docs = (p.attachments || []).filter(a => a && a.type !== "pano");

      body.innerHTML = `
        <div class="insp-swatch-row">
          <span class="insp-pin-ico ${has360 ? 'ok' : ''}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/><circle cx="12" cy="9" r="2.4"/></svg>
          </span>
          <span class="insp-shape-name">${has360 ? "360° 파노라마 등록됨" : "파노라마 미등록"}</span>
          <span class="insp-page-badge">PAGE ${p.page || 1}</span>
        </div>

        <div class="insp-section">
          <div class="insp-section-h">위치 <span class="insp-unit">(도면 % 기준)</span></div>
          <div class="insp-metrics">
            <div class="insp-metric"><span class="m-k">X</span><span class="m-v">${this._fmt(p.x)}%</span></div>
            <div class="insp-metric"><span class="m-k">Y</span><span class="m-v">${this._fmt(p.y)}%</span></div>
            <div class="insp-metric wide"><span class="m-k">소속 구역</span><span class="m-v">${inZone ? UI.escapeHtml(inZone.label) : "—"}</span></div>
          </div>
        </div>

        ${p.note ? `<div class="insp-section"><div class="insp-section-h">메모</div><div class="insp-note">${UI.escapeHtml(p.note)}</div></div>` : ""}
        ${docs.length ? `<div class="insp-section"><div class="insp-section-h">첨부 자료 <span class="insp-count">${docs.length}</span></div><div class="insp-docs">${docs.map(d => `<span class="insp-doc">📎 ${UI.escapeHtml(d.name || "자료")}</span>`).join("")}</div></div>` : ""}

        <div class="insp-actions">
          ${has360 ? `<button class="insp-btn primary" data-act="open">360° 열기</button>` : ""}
          <button class="insp-btn ghost" data-act="fly">화면 이동</button>
          ${designer ? `<button class="insp-btn ghost" data-act="edit">수정</button>
          <button class="insp-btn danger" data-act="del">삭제</button>` : ""}
        </div>
      `;
      body.querySelectorAll(".insp-btn").forEach(b => {
        b.addEventListener("click", () => {
          const act = b.dataset.act;
          if (act === "open" && typeof PanoViewer !== "undefined") PanoViewer.open(p);
          else if (act === "fly" && MapCtrl.flyTo) MapCtrl.flyTo(p.x, p.y, 2.4, 600);
          else if (act === "edit" && App.editPin) { App.editPin(p.id); this.close(); }
          else if (act === "del" && App.deletePin) { App.deletePin(p.id); this.close(); }
        });
      });
      this._open();
    },
  };

  /* ══════════════════════════════════════════
     BRAND  ── 회사 로고·테마 주입 (window.WM_BRAND)
  ══════════════════════════════════════════ */
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
        img.src = url;
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
  const PinGrid = {
    collapsed: false,
    query: "",

    init() {
      const toggle = document.getElementById("pin-grid-toggle");
      const reopen = document.getElementById("pin-grid-reopen");
      const csvBtn = document.getElementById("pin-grid-csv");
      const search = document.getElementById("pin-grid-search");
      if (toggle) toggle.addEventListener("click", () => this.setCollapsed(true));
      if (reopen) reopen.addEventListener("click", () => this.setCollapsed(false));
      if (csvBtn) csvBtn.addEventListener("click", () => this.exportCsv());
      if (search) search.addEventListener("input", (e) => { this.query = (e.target.value || "").trim().toLowerCase(); this.render(); });
    },

    setCollapsed(v) {
      this.collapsed = !!v;
      const panel  = document.getElementById("pin-grid-panel");
      const reopen = document.getElementById("pin-grid-reopen");
      if (!panel) return;
      const hasDrawing = (typeof State !== "undefined") && (State.pdfDoc || (State.viewerPages && State.viewerPages.length));
      if (this.collapsed) {
        panel.classList.add("collapsed");
        if (reopen && hasDrawing) reopen.classList.remove("hidden");
      } else {
        panel.classList.remove("collapsed");
        if (reopen) reopen.classList.add("hidden");
      }
    },

    /** 현재 페이지 핀 목록(번호는 renderPinsOnMap 과 동일 규칙: 페이지 내 순번) */
    _currentPins() {
      if (typeof State === "undefined" || !State.pins) return [];
      const totalPages = State.mode === "viewer"
        ? (State.viewerPages ? State.viewerPages.length : 1)
        : State.pdfPages;
      const curPage = State.pdfPage || 1;
      const isMulti = totalPages > 1;
      const base = isMulti ? State.pins.filter(p => (p.page || 1) === curPage) : State.pins.slice();
      return base.map((p, i) => ({ pin: p, no: i + 1 }));
    },

    render() {
      const panel = document.getElementById("pin-grid-panel");
      const body  = document.getElementById("pin-grid-body");
      const empty = document.getElementById("pin-grid-empty");
      const cnt   = document.getElementById("pin-grid-count");
      const pgB   = document.getElementById("pin-grid-page-badge");
      const reopen= document.getElementById("pin-grid-reopen");
      if (!panel || !body) return;

      const hasDrawing = (typeof State !== "undefined") && (State.pdfDoc || (State.viewerPages && State.viewerPages.length));
      if (!hasDrawing) {
        panel.classList.add("hidden");
        if (reopen) reopen.classList.add("hidden");
        return;
      }
      panel.classList.remove("hidden");
      // 접힌 상태면 패널은 숨고 리오픈 탭만
      if (this.collapsed) { if (reopen) reopen.classList.remove("hidden"); }
      else { if (reopen) reopen.classList.add("hidden"); }

      if (pgB) pgB.textContent = "P" + (State.pdfPage || 1);

      let rows = this._currentPins();
      const totalOnPage = rows.length;
      if (this.query) {
        rows = rows.filter(r => (r.pin.label || "").toLowerCase().includes(this.query));
      }
      if (cnt) cnt.textContent = this.query ? (rows.length + "/" + totalOnPage) : String(totalOnPage);

      body.innerHTML = "";
      if (rows.length === 0) {
        if (empty) {
          empty.classList.remove("hidden");
          empty.textContent = this.query
            ? "검색 결과가 없습니다."
            : "현재 페이지(P" + (State.pdfPage || 1) + ")에 등록된 포인트가 없습니다.";
        }
        return;
      }
      if (empty) empty.classList.add("hidden");

      const esc = (typeof UI !== "undefined" && UI.escapeHtml) ? UI.escapeHtml.bind(UI) : (s => String(s == null ? "" : s));
      rows.forEach(({ pin, no }) => {
        const hasContent = (typeof App !== "undefined" && App.pinHasContent) ? App.pinHasContent(pin) : !!pin.imageId;
        const active = (typeof State !== "undefined" && State.activePin === pin.id) ? " active" : "";
        const noteTag = pin.note ? `<span class="pin-grid-tag has" title="노트"><i class="fa-solid fa-note-sticky"></i></span>` : "";
        const attN = pin.attachments ? pin.attachments.length : 0;
        const attTag = attN ? `<span class="pin-grid-tag has" title="첨부 ${attN}"><i class="fa-solid fa-paperclip"></i>${attN}</span>` : "";
        const cloudTag = pin.imageId ? `<span class="pin-grid-tag has" title="클라우드 동기화"><i class="fa-solid fa-cloud"></i></span>` : "";
        const goBtn = hasContent
          ? `<button class="pin-grid-go" title="360° 뷰어 실행"><i class="fa-solid fa-panorama"></i></button>`
          : `<span class="pin-grid-go no-content" title="등록된 360° 미디어 없음"><i class="fa-solid fa-minus"></i></span>`;
        const tr = document.createElement("tr");
        tr.className = "pin-grid-row" + active;
        tr.dataset.id = pin.id;
        tr.innerHTML =
          `<td class="pgt-no">${no}</td>` +
          `<td class="pgt-name"><div class="pin-grid-name-cell">` +
            `<span class="pin-grid-name-txt" title="${esc(pin.label)}">${esc(pin.label)}</span>` +
            `<span class="pin-grid-name-tags">${cloudTag}${noteTag}${attTag}</span>` +
          `</div></td>` +
          `<td class="pgt-page">${pin.page || 1}</td>` +
          `<td class="pgt-coord">${(pin.x).toFixed(1)}, ${(pin.y).toFixed(1)}</td>` +
          `<td class="pgt-360">${goBtn}</td>`;
        // 행 전체 클릭 → 포커스 + (콘텐츠 있으면) 360° 자동 실행
        tr.addEventListener("click", () => this._go(pin, hasContent));
        body.appendChild(tr);
      });
    },

    /** 핵심 동작: PDF 페이지 이동 + 핀 포커스(flyTo) + 360° 뷰어 자동 실행 */
    _go(pin, hasContent) {
      if (typeof App === "undefined" || !App.focusPin) return;
      // focusPin(pin, true): 페이지 전환 → flyTo → openPano(360°) 까지 일괄 처리
      App.focusPin(pin, !!hasContent);
      if (!hasContent && typeof Prompt !== "undefined" && Prompt.toast) {
        Prompt.toast("ℹ️ 이 포인트에는 등록된 360° 미디어가 없습니다.");
      }
    },

    exportCsv() {
      const rows = this._currentPins();
      if (!rows.length) { if (typeof Prompt !== "undefined") Prompt.toast("내보낼 포인트가 없습니다."); return; }
      const head = ["No", "Name", "Page", "X(%)", "Y(%)", "Has360"];
      const csvEsc = (v) => {
        const s = String(v == null ? "" : v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      const lines = [head.join(",")];
      rows.forEach(({ pin, no }) => {
        const has = (typeof App !== "undefined" && App.pinHasContent) ? (App.pinHasContent(pin) ? "Y" : "N") : (pin.imageId ? "Y" : "N");
        lines.push([no, csvEsc(pin.label), pin.page || 1, pin.x.toFixed(2), pin.y.toFixed(2), has].join(","));
      });
      const blob = new Blob(["\ufeff" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "seastar_points_P" + (State.pdfPage || 1) + ".csv";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      if (typeof Prompt !== "undefined") Prompt.toast("📋 CSV 내보내기 완료");
    }
  };

  /* ══════════════════════════════════════════
     APP
  ══════════════════════════════════════════ */
  const App = {

    init() {
      Brand.apply();
      this._bindHome();
      this._bindTopbar();
      this._bindSidebar();
      // 모바일: 영역 지정 도구를 기본 접힘으로 시작(화면 가림 방지)
      try {
        const ztw = document.getElementById("zone-tools-wrap");
        if (ztw && window.matchMedia && window.matchMedia("(max-width: 640px)").matches) {
          ztw.removeAttribute("open");
        }
      } catch (e) {}
      this._bindMap();
      this._bindPano();
      MapCtrl.init(UI.$("map-viewport"), UI.$("map-transform"));
      PanoViewer.init(UI.$("pano-canvas"));
      AllPins.init();
      Auth.init();
      Settings.init();
      Designers.init();
      Prompt.init();
      Projects.init();
      ProjectHub.init();
      PanoNav.init();
      Notes.init();
      TimeLapse.init();
      Zones.init();
      Inspector.init();
      PinGrid.init();
      PinActionPop.init();
      CompanyAuth.init();
      PdfAnno.init();
      this._bindMobileNav();
      // 최상위 관리자 패널(기능관장·AI·코드맵) 초기화 + 기능 온오프 UI 반영
      if (typeof AdminPanels !== "undefined") { AdminPanels.init(); AdminPanels.applyFeaturesToUI(); }
      // 오프라인 우선 동기화 큐 — 배지 갱신 구독 + 자동 동기화 시작
      SyncQueue.onChange(() => this._updateSyncBadge());
      SyncQueue.init();
      this._updateSyncBadge();
    },

    /* ── Home ── */
    _bindHome() {
      document.querySelectorAll(".mode-card").forEach(card => {
        const open = () => {
          const mode = card.dataset.mode;
          // 설계자(디자이너) 모드는 구글 로그인 + 디자이너 권한 필요. 일반인은 뷰어만.
          if (mode === "designer") {
            Auth.requireDesigner(() => this.openApp("designer"));
            return;
          }
          this.openApp(mode);
        };
        card.addEventListener("click", open);
        card.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") open(); });
      });
    },

    openApp(mode, opts) {
      State.mode = mode;
      opts = opts || {};
      const isDesigner = mode === "designer";
      if (typeof Log !== "undefined") Log.push(mode === "viewer" ? "viewer.open" : "app.open", null, { mode });
      // 모바일 하단 네비 designer-only 버튼 표시/숨김용 body 클래스
      document.body.classList.toggle("role-designer", isDesigner);
      document.body.classList.toggle("role-viewer", !isDesigner);
      document.documentElement.style.setProperty("--accent", isDesigner ? "var(--gold)" : "var(--green)");
      UI.$("topbar").style.borderBottomColor = isDesigner ? "rgba(245,158,11,.2)" : "rgba(16,185,129,.2)";
      const dot = UI.$("topbar-dot");
      if (dot) dot.style.background = isDesigner ? "var(--gold)" : "var(--green)";
      UI.text("mode-label", isDesigner ? "DESIGNER MODE" : "VIEWER MODE");
      UI.$("mode-label").style.color = isDesigner ? "var(--gold)" : "var(--green)";

      // ── 뷰어는 "보기 전용". 업로드/편집/배포 관련 UI는 모두 숨긴다. ──
      //  (사용자 요청: "뷰어는 업로드가 왜 필요하지. 뷰어만 완벽하게 되게 만들어")
      UI.toggle("section-projects",  isDesigner);   // 프로젝트/데크 관리
      UI.toggle("section-upload",    isDesigner);   // 도면 업로드
      UI.toggle("section-place",     isDesigner);   // 위치 포인트 추가 (도구 패널 — 항상 유지)
      if (typeof Zones !== "undefined") Zones.renderList(); // 영역 목록(디자이너=항상, 뷰어=영역 있을 때)
      UI.toggle("section-export",    isDesigner);   // 뷰어로 배포
      // 핀 편집 폼은 사이드바가 아닌 도면 위 플로팅 패널 — 시작 시 닫힘
      this._closePinForm();
      UI.toggle("section-next-point", false);
      UI.toggle("btn-import-json",   false);        // JSON 가져오기 — 뷰어/디자이너 모두 숨김
      UI.toggle("section-viewer-load", !isDesigner); // 뷰어 로드 상태 표시

      if (isDesigner) Projects.load();              // 프로젝트 목록 로드

      if (!isDesigner) {
        // 뷰어 전용 링크(?mode=viewer)로 진입한 경우 홈 버튼도 숨긴다.
        if (State.viewerLocked) UI.$("btn-back").style.display = "none";
      } else {
        UI.$("btn-back").style.display = "";
      }

      UI.$("pin-empty").textContent = isDesigner
        ? "포인트를 추가하세요"
        : "배포된 포인트를 불러오는 중...";

      // ── A안 topbar 버튼 ──
      // ⚙️ 설정 버튼은 항상 노출(로그인·편집 전환 진입점)
      const btnSettings = UI.$("btn-settings");
      if (btnSettings) btnSettings.classList.remove("hidden");
      // "뷰어로" 버튼은 편집(designer) 모드에서만
      const btnExit = UI.$("btn-exit-edit");
      if (btnExit) btnExit.classList.toggle("hidden", !isDesigner);
      // ←(뒤로) 버튼: 프로젝트 허브로 돌아가기 (뷰어 전용 잠금 링크에서는 숨김)
      const btnBack = UI.$("btn-back");
      if (btnBack) btnBack.style.display = State.viewerLocked ? "none" : "";

      // 진입한 프로젝트명을 topbar에 표시 (있을 때)
      if (opts.project && opts.project.name) {
        UI.text("file-name-label", opts.project.name);
        State.currentProjectId = opts.project.id;
        State.currentProjectName = opts.project.name;
      }

      UI.showScreen("screen-app");
      if (!isDesigner) this.loadLatestDeployment();
    },

    /** 편집(designer) 모드 → 뷰어 모드로 전환 (A안: 홈으로 안 가고 뷰어 화면 유지) */
    exitEdit() {
      // 디자이너 편집 UI 정리 후 뷰어로 재진입
      PanoViewer.close();
      this.openApp("viewer");
    },

    /* ── Topbar ── */
    _bindTopbar() {
      UI.$("btn-back").addEventListener("click", () => {
        State.reset();
        PanoViewer.close();
        // 첫 화면 = 프로젝트 허브로 복귀
        ProjectHub.open();
        UI.$("map-viewport").classList.add("hidden");
        UI.$("drop-hint").classList.remove("hidden");
        UI.$("pdf-error").classList.add("hidden");
        UI.$("pdf-pagination").classList.add("hidden");
        { const tb = UI.$("pdf-toolbar"); if (tb) tb.classList.add("hidden"); UI.toggleThumbPanel(false); }
        UI.$("pin-count-badge").classList.add("hidden");
        UI.$("pins-layer").innerHTML = "";
        UI.$("pin-list").innerHTML = "";
        UI.$("pin-empty").classList.remove("hidden");
        this._closePinForm();
        UI.$("section-next-point").classList.add("hidden");
        UI.$("section-export").classList.add("hidden");
        UI.$("pdf-canvas").classList.add("hidden");
        UI.$("map-image").classList.add("hidden");
        UI.text("file-name-label", "도면 없음");
        State.pan = { x: 0, y: 0 }; State.zoom = 1;
        MapCtrl.applyTransform();
      });

      UI.$("btn-prev-page").addEventListener("click", () => this._changePage(-1));
      UI.$("btn-next-page").addEventListener("click", () => this._changePage(1));
      UI.$("btn-first-page").addEventListener("click", () => this._gotoPage(1));
      UI.$("btn-last-page").addEventListener("click", () => this._gotoPage(this._totalPages()));

      // 페이지 직접 입력 (점프)
      const jump = UI.$("input-page-jump");
      const doJump = () => {
        const n = parseInt(jump.value, 10);
        if (!isNaN(n)) this._gotoPage(n);
        else jump.value = State.pdfPage;
      };
      jump.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); jump.blur(); } });
      jump.addEventListener("blur", doJump);
      jump.addEventListener("focus", () => jump.select());
    },

    _totalPages() {
      return State.mode === "viewer" && State.viewerPages
        ? State.viewerPages.length : State.pdfPages;
    },

    _changePage(dir) { return this._gotoPage(State.pdfPage + dir); },

    /** 도면 90° 회전 (PDF: 내장 getViewport 재렌더 / 이미지·뷰어: CSS transform) */
    async _rotatePdf(deg) {
      State.pdfRotation = (((State.pdfRotation + deg) % 360) + 360) % 360;
      if (State.mode !== "viewer" && State.fileType === "pdf" && State.pdfDoc) {
        // 디자이너 PDF: 캔버스를 회전값으로 다시 렌더 (핀 좌표는 비율 기준이라 그대로 유지)
        if (this._pageRendering) { this._pendingRotate = true; return; }
        this._pageRendering = true;
        try { await this._renderPdfPage(); }
        finally {
          this._pageRendering = false;
          if (this._pendingRotate) { this._pendingRotate = false; this._renderPdfPage(); }
        }
      } else {
        // 이미지 또는 뷰어(스냅샷 이미지): map-image 를 CSS 로 회전
        MapCtrl.applyTransform();
      }
      UI.updateRotationLabel();
    },

    /** 절대 페이지로 이동 (범위 클램프 + 렌더 중복 가드) */
    async _gotoPage(target) {
      const total = this._totalPages();
      if (total <= 1) return;
      const next = Math.max(1, Math.min(total, target | 0));
      if (next === State.pdfPage) { UI.updatePdfPagination(); return; }
      if (this._pageRendering) { this._pendingPage = next; return; } // 중복 렌더 방지
      State.pdfPage = next;
      UI.updatePdfPagination(); // 페이지 번호/버튼 상태 즉시 반영 (렌더 완료 전에도)
      this._pageRendering = true;
      try {
        if (State.mode === "viewer" && State.viewerPages) {
          const imgEl = UI.$("map-image");
          await new Promise((res) => {
            imgEl.onload = () => res();
            imgEl.onerror = () => res();
            imgEl.src = State.viewerPages[next - 1];
          });
          this._showMapViewport();
        } else {
          await this._renderPdfPage();
        }
      } catch (e) {
        console.warn("페이지 전환 실패:", e);
      } finally {
        this._pageRendering = false;
        // 전환 중 들어온 마지막 요청 처리
        if (this._pendingPage != null && this._pendingPage !== State.pdfPage) {
          const p = this._pendingPage; this._pendingPage = null;
          this._gotoPage(p);
        } else {
          this._pendingPage = null;
        }
      }
    },

    /* ── Sidebar ── */
    _bindSidebar() {
      UI.$("btn-upload-drawing").addEventListener("click", async () => {
        // ── 요청사항: 도면 등록 시 '구역'을 먼저 보장한다 ──
        // (구역이 없으면 자동으로 기본 구역을 만들고, 여러 구역이 있는데 미선택이면 선택을 유도하되
        //  업로드 자체는 막지 않는다 — 과거 "업로드가 아무 반응 없이 막힘" 회귀 방지)
        if (typeof Projects !== "undefined" && Projects.currentProject) {
          if (!Projects.currentDeck) {
            if (Projects.decks && Projects.decks.length > 1) {
              // 구역이 여러 개인데 선택 안 됨 → 선택 유도(차단하지 않음, 안내만)
              Prompt.toast("⚠️ 여러 구역이 있습니다. 위쪽 '구역'에서 등록할 구역을 먼저 선택하세요.");
              const db = document.getElementById("decks-block");
              if (db) { db.classList.add("zone-required-flash"); setTimeout(() => db.classList.remove("zone-required-flash"), 1600); }
              return;
            }
            // 구역이 0개 또는 1개 → 자동 보장(없으면 '구역 1' 생성, 1개면 그걸 선택)
            try { await Projects.ensureDeck(); } catch (e) {}
          }
        }
        UI.$("input-drawing").click();
      });
      UI.$("input-drawing").addEventListener("change", e => {
        const f = e.target.files[0]; if (!f) return;
        e.target.value = "";
        this._loadDrawing(f);
      });

      // ── 드래그 앤 드롭 업로드: 도면 영역에 PDF/이미지를 끌어다 놓으면 즉시 로드 ──
      this._bindDragDrop();

      UI.$("btn-import-json").addEventListener("click", () => UI.$("input-json").click());
      UI.$("input-json").addEventListener("change", e => {
        const f = e.target.files[0]; if (!f) return;
        e.target.value = "";
        const reader = new FileReader();
        reader.onload = ev => {
          try {
            const data = JSON.parse(ev.target.result);
            if (Array.isArray(data.pins)) {
              State.pins = data.pins;
              if (data.fileName) UI.text("file-name-label", data.fileName);
              UI.renderPinList();
              UI.renderPinsOnMap();
            }
          } catch { alert("JSON 파싱 실패: 올바른 포인트 파일인지 확인하세요."); }
        };
        reader.readAsText(f);
      });

      // 포인트 배치 모드 토글
      UI.$("btn-place").addEventListener("click", () => this._togglePlacing());

      // "다음 포인트 지정" — 연속 배치
      UI.$("btn-next-point").addEventListener("click", () => {
        UI.hide("section-next-point");
        if (!State.placing) this._togglePlacing();
      });

      // 핀 폼: 그림 파일 선택
      UI.$("btn-pin-file").addEventListener("click", () => UI.$("input-pin-file").click());
      UI.$("input-pin-file").addEventListener("change", e => {
        const f = e.target.files[0];
        e.target.value = "";
        if (!f) return;
        const isImg = f.type.startsWith("image/");
        const isVid = f.type.startsWith("video/") || /\.(mp4|webm|mov)$/i.test(f.name);
        if (!isImg && !isVid) { alert("이미지(.jpg/.png) 또는 360° 영상(.mp4) 파일을 선택하세요."); return; }
        State.pendingFile = f;
        State.pendingIsVideo = isVid;
        const info = UI.$("pin-file-info");
        info.textContent = (isVid ? "🎬 " : "🖼 ") + f.name + " (" + (f.size / 1024 / 1024).toFixed(1) + " MB)";
        info.classList.remove("hidden");
        UI.show("field-pin-imgname");
        // ── 요청사항: 구역이 선택돼 있으면 파일명을 '구역명_번호'(예: ER1_1, ER1_2)로 자동 지정 ──
        const autoName = this._zoneImageName();
        UI.$("input-pin-imgname").value = autoName || f.name.replace(/\.[^.]+$/, "");
        this._updateConfirmEnabled();
        // ── 요청사항: 새 포인트 + 사진 등록 시 별도 저장 버튼 없이 즉시 저장 ──
        //    (편집 모드는 '변경 저장' 버튼을 명시적으로 눌러야 반영)
        if (!State.editingPinId) {
          setTimeout(() => this._confirmPin(), 120);
        }
      });

      // 핀 폼: 첨부 문서 선택 (PDF/Word 등 — 다중)
      UI.$("btn-pin-doc").addEventListener("click", () => UI.$("input-pin-doc").click());
      UI.$("input-pin-doc").addEventListener("change", e => {
        const files = Array.from(e.target.files || []);
        e.target.value = "";
        files.forEach(f => this._addPendingDoc(f));
      });

      // 핀 폼: 3D 포인트 클라우드(FLS/E57/LAS/PLY 등) 첨부
      const flsBtn = UI.$("btn-pin-fls");
      if (flsBtn) flsBtn.addEventListener("click", () => UI.$("input-pin-fls").click());
      const flsInput = UI.$("input-pin-fls");
      if (flsInput) flsInput.addEventListener("change", async e => {
        const f = e.target.files[0];
        e.target.value = "";
        if (!f) return;
        if (typeof FLS !== "undefined" && !FLS.isSupported(f.name)) {
          Prompt.toast && Prompt.toast("지원 형식: .fls .e57 .las .laz .ply .pcd .xyz .pts");
        }
        try {
          const ab = await this._readAsArrayBuffer(f);
          // 로컬 캐시에 보관(즉시 미리보기/저장은 배포 시 처리)
          const lid = "f" + Date.now() + Math.random().toString(36).slice(2, 6);
          Cloud._cache = Cloud._cache || {};
          Cloud._cache["fls:" + lid] = ab;
          State.pendingFls = { localId: lid, name: f.name, size: f.size };
          const info = UI.$("pin-file-info");
          if (info) {
            const prev = info.classList.contains("hidden") ? "" : info.textContent + "  ·  ";
            info.textContent = prev + "🧊 " + f.name + " (" + (f.size / 1024 / 1024).toFixed(1) + " MB)";
            info.classList.remove("hidden");
          }
          this._updateConfirmEnabled();
        } catch (err) {
          Prompt.toast && Prompt.toast("3D 파일 읽기 실패: " + (err.message || err));
        }
      });

      UI.$("input-pin-url").addEventListener("input", () => this._updateConfirmEnabled());
      UI.$("input-pin-note").addEventListener("input", () => this._updateConfirmEnabled());
      UI.$("btn-confirm-pin").addEventListener("click", () => this._confirmPin());
      UI.$("btn-cancel-pin").addEventListener("click", () => this._resetPinForm(true));

      // 컴팩트 폼: 노트/URL 접이식 토글
      const tog = (fieldId, btnId, focusId) => {
        const field = UI.$(fieldId), b = UI.$(btnId);
        if (!field || !b) return;
        const open = field.classList.toggle("hidden") === false;
        b.classList.toggle("active", open);
        if (open && focusId) { const el = UI.$(focusId); if (el) el.focus(); }
      };
      const nt = UI.$("btn-pin-note-toggle");
      if (nt) nt.addEventListener("click", () => tog("field-pin-note", "btn-pin-note-toggle", "input-pin-note"));
      const ut = UI.$("btn-pin-url-toggle");
      if (ut) ut.addEventListener("click", () => tog("field-pin-url", "btn-pin-url-toggle", "input-pin-url"));

      // 동기화 배지 클릭 → 지금 즉시 동기화
      const sb = UI.$("sync-badge");
      if (sb) sb.addEventListener("click", async () => {
        if (!navigator.onLine) { alert("현재 오프라인입니다. 인터넷 연결 시 자동으로 업로드됩니다."); return; }
        const r = await SyncQueue.flush();
        if (r && r.map) this._onSyncDone(r);
      });

      UI.$("btn-export-json").addEventListener("click", () => this._exportJson());
      UI.$("btn-deploy").addEventListener("click", () => this._deployToViewer());
      UI.$("btn-reload-deploy").addEventListener("click", () => this.loadLatestDeployment());
    },

    _togglePlacing() {
      State.placing = !State.placing;
      if (State.placing) {
        State.pending = null;
        State.editingPinId = null;
        this._closePinForm();         // 편집 폼이 떠 있으면 닫고 새 배치 모드
        UI.hide("section-next-point");
      }
      UI.$("btn-place").classList.toggle("active", State.placing);
      UI.$("place-hint").classList.toggle("hidden", !State.placing);
      UI.$("crosshair-overlay").classList.toggle("hidden", !State.placing);
      UI.$("map-viewport").style.cursor = State.placing ? "crosshair" : "grab";
    },

    /** 플로팅 핀 편집 패널 열기 (새 포인트 or 기존 포인트 편집) */
    _openPinForm(opts) {
      opts = opts || {};
      const panel = UI.$("section-pin-form");
      if (!panel) return;
      panel.classList.remove("hidden");
      // 헤더 타이틀: 신규 vs 수정
      const tt = UI.$("pf-title-text");
      if (tt) tt.textContent = opts.editing ? "포인트 수정" : "새 포인트";
      const saveLbl = UI.$("pf-save-label");
      if (saveLbl) saveLbl.textContent = opts.editing ? "변경 저장" : "저장하기";
      // ── #7: 구역이 선택돼 있고 신규 포인트면 위치명 입력 숨김(번호 자동부여).
      //   편집이거나 구역이 없으면 위치명 입력 표시.
      const addr = UI.$("pf-addr");
      if (addr) {
        const zoneSelected = (typeof Projects !== "undefined" && Projects.currentDeck);
        const hideAddr = !opts.editing && !!zoneSelected;
        addr.classList.toggle("hidden", hideAddr);
      }
      // 진입 애니메이션 트리거
      panel.classList.remove("pf-in");
      void panel.offsetWidth;
      panel.classList.add("pf-in");
    },

    /** 플로팅 핀 편집 패널 닫기 */
    _closePinForm() {
      const panel = UI.$("section-pin-form");
      if (panel) { panel.classList.add("hidden"); panel.classList.remove("pf-in"); }
    },

    _updateConfirmEnabled() {
      const hasFile = !!State.pendingFile;
      const hasUrl  = !!UI.val("input-pin-url").trim();
      const hasNote = !!UI.val("input-pin-note").trim();
      const hasDoc  = State.pendingDocs.length > 0;
      const hasFls  = !!State.pendingFls;
      // 360° 미디어가 없어도 노트/문서/3D 데이터만 있어도 저장 가능 (정보 포인트)
      UI.$("btn-confirm-pin").disabled = !(hasFile || hasUrl || hasNote || hasDoc || hasFls);
    },

    /** 첨부 문서 후보 추가 + 검증 */
    _addPendingDoc(file) {
      if (!file) return;
      if (file.size > Cloud.MAX_DOC_BYTES) {
        alert(`"${file.name}" 은 너무 큽니다 (${fmtBytes(file.size)}). 최대 ${fmtBytes(Cloud.MAX_DOC_BYTES)} 까지 첨부할 수 있습니다.`);
        return;
      }
      // 중복(같은 이름+크기) 방지
      if (State.pendingDocs.some(d => d.name === file.name && d.size === file.size)) return;
      const kind = docKind(file.type || file.name);
      State.pendingDocs.push({
        tempId: "d" + Date.now() + Math.random().toString(36).slice(2, 6),
        file, name: file.name, size: file.size, kind, status: "ready"
      });
      this._renderPendingDocs();
      this._updateConfirmEnabled();
    },

    _removePendingDoc(tempId) {
      State.pendingDocs = State.pendingDocs.filter(d => d.tempId !== tempId);
      this._renderPendingDocs();
      this._updateConfirmEnabled();
    },

    _renderPendingDocs() {
      const wrap = UI.$("pin-doc-list");
      wrap.innerHTML = "";
      State.pendingDocs.forEach(d => {
        const chip = document.createElement("div");
        chip.className = "pin-doc-chip";
        chip.innerHTML = `
          <span class="pin-doc-badge" style="background:${d.kind.color}">${d.kind.label}</span>
          <div class="pin-doc-meta">
            <div class="pin-doc-name">${UI.escapeHtml(d.name)}</div>
            <div class="pin-doc-size">${fmtBytes(d.size)}</div>
          </div>
          <button class="pin-doc-remove" title="제거" aria-label="제거">✕</button>`;
        chip.querySelector(".pin-doc-remove").addEventListener("click", () => this._removePendingDoc(d.tempId));
        wrap.appendChild(chip);
      });
    },

    _resetPinForm(hideForm) {
      State.pending = null;
      State.pendingFile = null;
      State.pendingIsVideo = false;
      State.pendingDocs = [];
      State.pendingFls = null;
      UI.$("pending-pin").classList.add("hidden");
      UI.clearVal("input-pin-label");
      UI.clearVal("input-pin-url");
      UI.clearVal("input-pin-imgname");
      UI.clearVal("input-pin-note");
      UI.$("pin-doc-list").innerHTML = "";
      UI.$("pin-file-info").classList.add("hidden");
      UI.$("pin-file-info").textContent = "";
      UI.hide("field-pin-imgname");
      UI.hide("pin-upload-status");
      // 접이식 필드/토글 초기화
      ["field-pin-url", "field-pin-note"].forEach(id => { const el = UI.$(id); if (el) el.classList.add("hidden"); });
      ["btn-pin-note-toggle", "btn-pin-url-toggle"].forEach(id => { const b = UI.$(id); if (b) b.classList.remove("active"); });
      UI.disable("btn-confirm-pin");
      if (hideForm) { State.editingPinId = null; this._closePinForm(); UI.$("pending-pin").classList.add("hidden"); }
    },

    /* ── 모바일 하단 네비 바인딩 (메뉴=바텀시트, 콘텐츠 안 가림) ── */
    _bindMobileNav() {
      const $ = (id) => UI.$(id);
      const closeSheet = () => document.body.classList.remove("sidebar-open");
      const toggleSheet = () => document.body.classList.toggle("sidebar-open");

      const menu = $("mnav-menu");
      if (menu) menu.addEventListener("click", () => {
        toggleSheet();
        menu.classList.toggle("active", document.body.classList.contains("sidebar-open"));
      });

      const bd = $("sidebar-backdrop");
      if (bd) bd.addEventListener("click", closeSheet);

      // 도면 등록 → 기존 업로드 버튼 위임
      const up = $("mnav-upload");
      if (up) up.addEventListener("click", () => {
        closeSheet();
        const b = $("btn-upload-drawing"); if (b) b.click();
      });

      // 포인트 추가 → 기존 마킹 토글
      const place = $("mnav-place");
      if (place) place.addEventListener("click", () => {
        closeSheet();
        const b = $("btn-place"); if (b) b.click();
      });

      // 포인트 목록 → 전체 핀 드로어
      const pins = $("mnav-pins");
      if (pins) pins.addEventListener("click", () => {
        closeSheet();
        if (typeof AllPins !== "undefined" && AllPins.show) AllPins.show();
      });

      // 화면 맞춤
      const fit = $("mnav-fit");
      if (fit) fit.addEventListener("click", () => { closeSheet(); MapCtrl.fit(); });

      // 시트 열렸을 때 사이드바 내 버튼 클릭 시 자동 닫기(업로드/배포 등 액션성)
      const sb = $("sidebar");
      if (sb) sb.addEventListener("click", (e) => {
        if (!document.body.classList.contains("sidebar-open")) return;
        const t = e.target.closest("button");
        if (t && (t.id === "btn-upload-drawing" || t.id === "btn-deploy" || t.classList.contains("deck-name"))) {
          setTimeout(closeSheet, 120);
        }
      });
    },

    /* ── Map ── */
    _bindMap() {
      const vp = UI.$("map-viewport");

      vp.addEventListener("wheel", e => { e.preventDefault(); MapCtrl.handleWheel(e); }, { passive: false });

      vp.addEventListener("mousedown", e => {
        if (State.placing) { this._handlePlaceClick(e); return; }
        if (State.drawingZone) { if (Zones.onDrawStart(e.clientX, e.clientY)) { e.preventDefault(); return; } }
        MapCtrl.handlePanStart(e);
      });
      window.addEventListener("mousemove", e => {
        if (State.drawingZone && (Zones._drag || Zones._shape === "poly")) { Zones.onDrawMove(e.clientX, e.clientY); return; }
        MapCtrl.handlePanMove(e);
      });
      window.addEventListener("mouseup",   e => {
        if (State.drawingZone && Zones._drag) { Zones.onDrawEnd(e.clientX, e.clientY); return; }
        MapCtrl.handlePanEnd();
      });

      // ═══ 터치 제스처: 1손가락 팬 + 2손가락 핀치 줌 + 더블탭 줌 ═══
      // 딥리서치 결과: 모바일 PDF/도면 뷰어에서 핀치 줌은 필수(미지원 시 이탈)
      let lastTouch = null;          // 1손가락 팬 추적
      let pinch = null;              // 2손가락 핀치 상태 {dist, cx, cy}
      let lastTapTime = 0;           // 더블탭 추적
      let lastTapXY = null;

      const touchDist = (t0, t1) => Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
      const touchMid  = (t0, t1) => ({ x: (t0.clientX + t1.clientX) / 2, y: (t0.clientY + t1.clientY) / 2 });

      vp.addEventListener("touchstart", e => {
        MapCtrl.cancelFly();
        if (e.touches.length === 2) {
          // 핀치 시작 — 팬 종료, 두 손가락 거리/중점 기록
          lastTouch = null;
          const mid = touchMid(e.touches[0], e.touches[1]);
          pinch = { dist: touchDist(e.touches[0], e.touches[1]), cx: mid.x, cy: mid.y };
          e.preventDefault();
          return;
        }
        if (e.touches.length === 1) {
          if (State.placing) { this._handlePlaceTouch(e); return; }
          lastTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        }
      }, { passive: false });

      vp.addEventListener("touchmove", e => {
        if (e.touches.length === 2 && pinch) {
          // 핀치 줌: 거리 비율만큼 확대/축소, 두 손가락 중점을 기준점으로
          const newDist = touchDist(e.touches[0], e.touches[1]);
          const mid = touchMid(e.touches[0], e.touches[1]);
          if (pinch.dist > 0) {
            const ratio = newDist / pinch.dist;
            if (ratio && isFinite(ratio)) MapCtrl.zoomBy(ratio, mid.x, mid.y);
          }
          // 두 손가락 중점 이동분만큼 팬도 함께(자연스러운 동작)
          State.pan.x += mid.x - pinch.cx;
          State.pan.y += mid.y - pinch.cy;
          MapCtrl.applyTransform();
          pinch = { dist: newDist, cx: mid.x, cy: mid.y };
          e.preventDefault();
          return;
        }
        if (e.touches.length === 1 && lastTouch) {
          State.pan.x += e.touches[0].clientX - lastTouch.x;
          State.pan.y += e.touches[0].clientY - lastTouch.y;
          lastTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
          MapCtrl.applyTransform();
        }
        e.preventDefault();
      }, { passive: false });

      vp.addEventListener("touchend", e => {
        // 핀치 종료(손가락이 2개 미만이 되면)
        if (pinch && (!e.touches || e.touches.length < 2)) pinch = null;
        // 손가락이 0개면 팬도 종료
        if (!e.touches || e.touches.length === 0) {
          // 더블탭 줌 감지 (touchend 시점, 직전 탭과 시간·위치 근접)
          const t = (e.changedTouches && e.changedTouches[0]) || null;
          if (t && !State.placing) {
            const now = Date.now();
            const x = t.clientX, y = t.clientY;
            if (now - lastTapTime < 300 && lastTapXY &&
                Math.hypot(x - lastTapXY.x, y - lastTapXY.y) < 30) {
              // 더블탭: 현재 줌 기준 토글식 확대(이미 크면 fit)
              if (State.zoom >= 2.4) MapCtrl.fit();
              else MapCtrl.zoomBy(1.8, x, y);
              lastTapTime = 0; lastTapXY = null;
            } else {
              lastTapTime = now; lastTapXY = { x, y };
            }
          }
          lastTouch = null;
        }
      });

      // 더블클릭으로 클릭 지점 중심 줌인 (데스크톱)
      vp.addEventListener("dblclick", e => {
        if (State.placing) return;
        MapCtrl.zoomBy(1.6, e.clientX, e.clientY);
      });

      // 플로팅 네비게이션 툴바 (Bluebeam 스타일 — 확대/축소/맞춤/실제크기)
      const bind = (id, fn) => { const el = UI.$(id); if (el) el.addEventListener("click", fn); };
      bind("btn-zoom-in",  () => MapCtrl.zoomBy(1.25));
      bind("btn-zoom-out", () => MapCtrl.zoomBy(0.8));
      bind("btn-fit",      () => MapCtrl.fit());
      bind("btn-actual",   () => MapCtrl.actualSize());
      bind("zoom-level",   () => MapCtrl.actualSize());
      bind("btn-iso",      () => MapCtrl.toggleIso());
      // 회전 (PDF.js 내장 getViewport({rotation}) 활용)
      bind("btn-rotate-cw",  () => this._rotatePdf(90));
      bind("btn-rotate-ccw", () => this._rotatePdf(-90));
      bind("rotate-level",   () => { State.pdfRotation = 0; this._rotatePdf(0); });

      // ═══ ezPDF 스타일 상단 도구 툴바 (동일 핸들러 재사용) ═══
      bind("tb-zoom-in",   () => MapCtrl.zoomBy(1.25));
      bind("tb-zoom-out",  () => MapCtrl.zoomBy(0.8));
      bind("tb-zoom-level",() => MapCtrl.actualSize());
      bind("tb-fit",       () => MapCtrl.fit());
      bind("tb-actual",    () => MapCtrl.actualSize());
      bind("tb-iso",       () => MapCtrl.toggleIso());
      bind("tb-rotate-cw", () => this._rotatePdf(90));
      bind("tb-rotate-ccw",() => this._rotatePdf(-90));
      // 페이지 이동
      bind("tb-first", () => this._gotoPage(1));
      bind("tb-prev",  () => this._changePage(-1));
      bind("tb-next",  () => this._changePage(1));
      bind("tb-last",  () => this._gotoPage(this._totalPages()));
      // 썸네일 패널 토글
      bind("tb-thumbs", () => UI.toggleThumbPanel());
      // 포인트 마킹 — 기존 마킹 버튼(btn-place) 위임
      bind("tb-mark", () => { const b = UI.$("btn-place"); if (b) b.click(); });
      // 페이지 직접 입력
      const tbJump = UI.$("tb-page-input");
      if (tbJump) {
        const doTbJump = () => {
          const n = parseInt(tbJump.value, 10);
          if (!isNaN(n)) this._gotoPage(n);
          else tbJump.value = State.pdfPage;
        };
        tbJump.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); tbJump.blur(); } });
        tbJump.addEventListener("blur", doTbJump);
        tbJump.addEventListener("focus", () => tbJump.select());
      }
    },

    /** 선택된 구역명 기반 자동 사진 파일명: '구역명_번호'. 구역 없으면 null. */
    _zoneImageName() {
      const deck = (typeof Projects !== "undefined") ? Projects.currentDeck : null;
      if (!deck || !deck.name) return null;
      const base = String(deck.name).trim().replace(/\s+/g, "_").replace(/[^\w가-힣\-]/g, "");
      const page = State.pdfPage || 1;
      let n = 0;
      (State.pins || []).forEach((p) => {
        if ((p.page || 1) !== page) return;
        if (p.imageId || p.pendingOpId || p.imageName) n++;
      });
      const next = State.editingPinId ? Math.max(n, 1) : (n + 1);
      return base + "_" + next;
    },

    _handlePlaceClick(e) {
      if (!State.placing) return;
      const pct = MapCtrl.viewportToPercent(e.clientX, e.clientY);
      if (!pct) return;
      State.pending = pct;
      State.placing = false;
      UI.$("btn-place").classList.remove("active");
      UI.$("place-hint").classList.add("hidden");
      UI.$("crosshair-overlay").classList.add("hidden");
      UI.$("map-viewport").style.cursor = "grab";

      // ⚠️ _resetPinForm이 pending-pin을 hidden 처리 + State.pending=null 로 만들므로
      //    반드시 먼저 폼을 리셋한 뒤, 그 다음에 임시 핀을 표시/좌표 설정한다.
      State.editingPinId = null;
      this._resetPinForm(false);
      State.pending = pct; // resetPinForm이 지우므로 재설정

      const pp = UI.$("pending-pin");
      pp.style.left = pct.x + "%";
      pp.style.top  = pct.y + "%";
      pp.classList.remove("hidden");

      // 지정한 위치로 줌인 (플라이투) — 정확한 위치 확인
      MapCtrl.flyTo(pct.x, pct.y, Math.max(State.zoom, 2.2));

      this._openPinForm({ editing: false });
      // 포인트를 추가하면 바로 사진 업로드 다이얼로그를 띄운다 (요청사항)
      setTimeout(() => { const fi = UI.$("input-pin-file"); if (fi) fi.click(); }, 280);
      // 위치명 입력이 표시돼 있을 때만 포커스 (구역 선택 시엔 숨겨짐)
      const addr = UI.$("pf-addr");
      if (addr && !addr.classList.contains("hidden")) UI.$("input-pin-label").focus();
    },

    _handlePlaceTouch(e) {
      e.preventDefault();
      const t = e.touches[0];
      this._handlePlaceClick({ clientX: t.clientX, clientY: t.clientY });
    },

    /* ── Pano ── */
    _bindPano() {
      UI.$("btn-pano-close").addEventListener("click", () => PanoViewer.close());

      const canvas = UI.$("pano-canvas");
      canvas.addEventListener("mousedown", e => PanoViewer.onPointerDown(e.clientX, e.clientY));
      window.addEventListener("mousemove", e => PanoViewer.onPointerMove(e.clientX, e.clientY));
      window.addEventListener("mouseup",   () => PanoViewer.onPointerUp());
      canvas.addEventListener("wheel", e => PanoViewer.onWheel(e), { passive: false });
      // ═══ 360 뷰어 터치: 1손가락 회전 + 2손가락 핀치 줌(FOV) ═══
      let panoPinchDist = null;
      const pDist = (t0, t1) => Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
      canvas.addEventListener("touchstart", e => {
        if (e.touches.length === 2) {
          panoPinchDist = pDist(e.touches[0], e.touches[1]);
          e.preventDefault();
        } else if (e.touches.length === 1) {
          PanoViewer.onPointerDown(e.touches[0].clientX, e.touches[0].clientY);
        }
      }, { passive: false });
      canvas.addEventListener("touchmove", e => {
        e.preventDefault();
        if (e.touches.length === 2 && panoPinchDist != null) {
          const d = pDist(e.touches[0], e.touches[1]);
          const delta = panoPinchDist - d;        // 벌리면 줌인(FOV↓), 모으면 줌아웃(FOV↑)
          if (Math.abs(delta) > 1) { PanoViewer.setFov(delta * 0.18); panoPinchDist = d; }
        } else if (e.touches.length === 1) {
          PanoViewer.onPointerMove(e.touches[0].clientX, e.touches[0].clientY);
        }
      }, { passive: false });
      canvas.addEventListener("touchend", e => {
        if (!e.touches || e.touches.length < 2) panoPinchDist = null;
        PanoViewer.onPointerUp();
      });

      // 파노라마 컨트롤 버튼
      UI.$("btn-pano-rotate").addEventListener("click", e => {
        const on = PanoViewer.toggleAuto();
        e.currentTarget.classList.toggle("on", on);
      });
      UI.$("btn-pano-zoomin").addEventListener("click",  () => PanoViewer.setFov(-10));
      UI.$("btn-pano-zoomout").addEventListener("click", () => PanoViewer.setFov(10));
      UI.$("btn-pano-reset").addEventListener("click",   () => PanoViewer.resetView());
      // ISO 4-꼭지점 뷰 전환
      document.querySelectorAll("#pano-iso-views .pano-iso-btn").forEach((b) => {
        b.addEventListener("click", (e) => {
          const corner = parseInt(e.currentTarget.getAttribute("data-iso"), 10) || 0;
          if (PanoViewer.open && typeof PanoViewer.setIsoView === "function") {
            PanoViewer.setIsoView(corner);
            document.querySelectorAll("#pano-iso-views .pano-iso-btn").forEach((x) => x.classList.remove("active"));
            e.currentTarget.classList.add("active");
          }
        });
      });
      UI.$("btn-pano-full").addEventListener("click", () => {
        const ov = UI.$("pano-overlay");
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else ov.requestFullscreen && ov.requestFullscreen().catch(() => {});
      });

      window.addEventListener("resize", () => {
        if (PanoViewer.open) PanoViewer._resize();
      });

      document.addEventListener("keydown", e => {
        if (e.key === "Escape" && PanoViewer.open) { PanoViewer.close(); return; }
        // 파노라마가 열려 있을 때: ← / → 로 이전/다음 포인트 이동
        if (PanoViewer.open) {
          if (e.key === "ArrowLeft")  { e.preventDefault(); PanoNav.go(-1); }
          else if (e.key === "ArrowRight") { e.preventDefault(); PanoNav.go(1); }
          return;
        }
        const tag = (e.target && e.target.tagName) || "";
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        // 회전 단축키 (Shift+←/→) — 도면이 로드돼 있으면 페이지 수와 무관하게 동작
        const rotGroup = UI.$("rotate-group");
        const canRotate = rotGroup && !rotGroup.classList.contains("hidden");
        if (e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
          if (canRotate) { e.preventDefault(); this._rotatePdf(e.key === "ArrowRight" ? 90 : -90); }
          return;
        }
        if (UI.$("pdf-pagination").classList.contains("hidden")) return;
        if (e.key === "ArrowLeft")      { e.preventDefault(); this._changePage(-1); }
        else if (e.key === "ArrowRight"){ e.preventDefault(); this._changePage(1); }
        else if (e.key === "Home")      { e.preventDefault(); this._gotoPage(1); }
        else if (e.key === "End")       { e.preventDefault(); this._gotoPage(this._totalPages()); }
      });
    },

    /* ── Drawing Load ── */
    /** 드래그 앤 드롭으로 도면 업로드 (디자이너 모드 전용) */
    _bindDragDrop() {
      const zone = UI.$("map-area");
      if (!zone || zone.dataset.dropBound) return;
      zone.dataset.dropBound = "1";
      // 모바일 쉬운 등록: 빈 화면(도면 안내)을 탭하면 바로 파일 선택
      const dropHint = UI.$("drop-hint");
      if (dropHint) {
        dropHint.style.cursor = "pointer";
        dropHint.addEventListener("click", () => {
          if (State.mode !== "designer") return;
          const inp = UI.$("input-drawing"); if (inp) inp.click();
        });
      }
      const accept = (f) => {
        if (!f) return false;
        const n = (f.name || "").toLowerCase();
        return f.type === "application/pdf" || f.type.startsWith("image/") ||
               /\.(pdf|png|jpe?g)$/i.test(n);
      };
      const setOver = (on) => {
        const hint = UI.$("drop-hint");
        if (hint) hint.classList.toggle("dragover", on);
        zone.classList.toggle("drop-active", on);
      };
      ["dragenter", "dragover"].forEach(ev =>
        zone.addEventListener(ev, (e) => {
          if (State.mode !== "designer") return;
          e.preventDefault(); e.stopPropagation();
          if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
          setOver(true);
        })
      );
      ["dragleave", "dragend"].forEach(ev =>
        zone.addEventListener(ev, (e) => {
          e.preventDefault(); e.stopPropagation();
          // 영역을 완전히 벗어났을 때만 해제
          if (ev === "dragleave" && zone.contains(e.relatedTarget)) return;
          setOver(false);
        })
      );
      zone.addEventListener("drop", (e) => {
        e.preventDefault(); e.stopPropagation();
        setOver(false);
        if (State.mode !== "designer") {
          if (typeof Prompt !== "undefined") Prompt.toast("ℹ️ 도면 업로드는 디자이너 모드에서만 가능합니다.");
          return;
        }
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (!accept(f)) {
          if (typeof Prompt !== "undefined") Prompt.toast("⚠️ PDF · PNG · JPG 파일만 업로드할 수 있습니다.");
          return;
        }
        this._loadDrawing(f);
      });
    },

    async _loadDrawing(file) {
      const _isPdf = file.type === "application/pdf" || (file.name || "").toLowerCase().endsWith(".pdf");
      if (typeof Log !== "undefined") Log.push(_isPdf ? "pdf.register" : "drawing.upload", file.name, { type: file.type, size: file.size });
      State.reset();
      State.fileName = file.name;
      UI.text("file-name-label", file.name);
      UI.$("pin-count-badge").classList.add("hidden");
      UI.$("pins-layer").innerHTML = "";
      UI.$("pin-list").innerHTML = "";
      UI.$("pin-empty").classList.remove("hidden");
      this._closePinForm();
      UI.$("section-next-point").classList.add("hidden");
      UI.$("section-export").classList.add("hidden");

      const isPDF = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");

      if (isPDF) {
        State.fileType = "pdf";
        UI.$("drop-hint").classList.add("hidden");
        UI.$("pdf-loading").classList.remove("hidden");
        UI.$("pdf-error").classList.add("hidden");
        UI.$("map-viewport").classList.add("hidden");

        try {
          const ab = await this._readAsArrayBuffer(file);
          State.fileData = ab;
          const pdf = await PDF.load(ab);
          State.pdfDoc  = pdf;
          State.pdfPages = pdf.numPages;
          State.pdfPage  = 1;
          UI.$("pdf-loading").classList.add("hidden");
          UI.$("pdf-canvas").classList.remove("hidden");
          UI.$("map-image").classList.add("hidden");
          await this._renderPdfPage();
          this._showMapViewport();
          this._afterDrawingLoaded();
        } catch (err) {
          UI.$("pdf-loading").classList.add("hidden");
          UI.$("pdf-error").classList.remove("hidden");
          const em = UI.$("pdf-error-msg"); if (em) em.textContent = "PDF 로드 실패: " + err.message;
        }
      } else {
        State.fileType = "image";
        State.imageUrl = URL.createObjectURL(file);
        UI.$("drop-hint").classList.add("hidden");
        UI.$("pdf-loading").classList.add("hidden");
        UI.$("pdf-error").classList.add("hidden");
        UI.$("pdf-canvas").classList.add("hidden");
        UI.$("pdf-pagination").classList.add("hidden");

        const imgEl = UI.$("map-image");
        imgEl.onload = () => { this._showMapViewport(); this._afterDrawingLoaded(); };
        imgEl.onerror = () => {
          UI.$("pdf-error").classList.remove("hidden");
          UI.$("pdf-error-msg").textContent = "이미지 로드 실패";
        };
        imgEl.src = State.imageUrl;
        imgEl.classList.remove("hidden");
      }
    },

    async _renderPdfPage() {
      const canvas = UI.$("pdf-canvas");
      // 핵심(캔버스 래스터화)은 반드시 성공해야 한다 → 여기서 실패하면 상위 catch 로 전달.
      await PDF.renderPage(State.pdfDoc, State.pdfPage, canvas, 1.5, State.pdfRotation);
      State.pan = { x: 0, y: 0 }; State.zoom = 1;
      // 부수 UI 갱신(페이지네이션·핀·썸네일)은 하나가 실패해도 PDF 표시는 유지되도록 개별 격리.
      try { MapCtrl.applyTransform(); } catch (e) { console.warn("applyTransform", e); }
      try { UI.updatePdfPagination(); } catch (e) { console.warn("pagination", e); }
      try { UI.renderPinsOnMap(); } catch (e) { console.warn("pinsOnMap", e); }
      try { UI.renderPinList(); } catch (e) { console.warn("pinList", e); }
      try { UI.renderPdfThumbs(); } catch (e) { console.warn("thumbs", e); }
    },

    _showMapViewport() {
      State.pan  = { x: 0, y: 0 };
      State.zoom = 1;
      MapCtrl.applyTransform();
      UI.$("map-viewport").classList.remove("hidden");
      const nav = UI.$("nav-toolbar"); if (nav) nav.classList.remove("hidden");
      // ezPDF 스타일 상단 도구 툴바 표시 + 마킹 버튼(설계자 전용)
      const tb = UI.$("pdf-toolbar");
      if (tb) tb.classList.remove("hidden");
      const tbMark = UI.$("tb-mark");
      if (tbMark) tbMark.classList.toggle("hidden", State.mode !== "designer");
      if (typeof PdfAnno !== "undefined") PdfAnno.updateToolbar();  // 주석 도구(설계자 전용) 표시
      UI.renderPinsOnMap();
      UI.renderPinList();      // 현재 페이지 핀 목록 갱신
      UI.updatePdfPagination();
      UI.updateRotationLabel();
      UI.renderPdfThumbs();
      // 도면이 화면에 표시되면 버튼 없이 즉시 자동 저장(배포본 생성)
      if (State.mode === "designer" && !State.autoSaveDepId) {
        // 이미지의 경우 naturalWidth 가 확정된 직후이므로 약간 지연 후 스냅샷
        setTimeout(() => this._createInitialSave(), 150);
      }
    },

    _readAsArrayBuffer(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload  = e => resolve(e.target.result);
        reader.onerror = () => reject(new Error("파일 읽기 실패"));
        reader.readAsArrayBuffer(file);
      });
    },

    /* ── Pin: 저장 & 업로드 ── */
    async _confirmPin() {
      if (!State.pending) return;
      const label = UI.val("input-pin-label").trim() || `위치 ${State.pins.length + 1}`;
      const url   = UI.val("input-pin-url").trim();
      const note  = UI.val("input-pin-note").trim();
      const file  = State.pendingFile;
      const docs  = State.pendingDocs.slice();

      // ── 편집 모드 판정 ──
      const editing = !!State.editingPinId;
      const existing = editing ? State.pins.find(p => p.id === State.editingPinId) : null;
      // 신규: 미디어·노트·첨부 중 최소 하나 필요. 편집: 라벨/노트만 바꿔도 저장 허용.
      if (!editing && !file && !url && !note && docs.length === 0) return;

      const btn    = UI.$("btn-confirm-pin");
      const status = UI.$("pin-upload-status");
      const setBtnLabel = (t) => { const l = UI.$("pf-save-label"); if (l) l.textContent = t; else btn.textContent = t; };
      btn.disabled = true;
      setBtnLabel((file || docs.length) ? (navigator.onLine ? "업로드 중..." : "임시 저장 중...") : "저장 중...");

      // 편집이면 기존 객체를 베이스로(기존 미디어 보존), 신규면 새 객체
      const pin = editing && existing
        ? existing
        : { id: Date.now(), x: State.pending.x, y: State.pending.y, page: State.pdfPage, label };
      pin.label = label;
      if (note) pin.note = note; else if (editing) delete pin.note;

      try {
        if (file && State.pendingIsVideo) {
          // 360° 영상: 테이블 용량 제한으로 클라우드 저장 불가 → 로컬 blob URL (현재 세션 미리보기)
          status.textContent = "🎬 360° 영상 연결 중...";
          status.classList.remove("hidden", "error");
          const vidName = UI.val("input-pin-imgname").trim() || file.name.replace(/\.[^.]+$/, "");
          pin.videoUrl  = URL.createObjectURL(file);
          _trackVideoBlob(pin.videoUrl); // [B5] 누수 추적
          pin.isVideo   = true;
          pin.imageName = vidName;
          pin.localOnly = true; // 배포/새로고침 시 사라짐 안내용
        } else if (file) {
          // 이미지: 1) 리사이즈 → 2) 온라인이면 즉시 업로드 / 오프라인·실패면 로컬 큐잉
          status.textContent = "이미지 최적화 중...";
          status.classList.remove("hidden", "error");
          const { dataURL, width, height } = await Cloud.resizeImage(file);
          const imgName = UI.val("input-pin-imgname").trim() || file.name.replace(/\.[^.]+$/, "");
          pin.imageName = imgName;

          let uploaded = false;
          if (navigator.onLine) {
            try {
              status.textContent = "☁ 클라우드 업로드 중... (" + (dataURL.length / 1024 / 1024).toFixed(1) + " MB)";
              const imageId = await Cloud.uploadImage(imgName, dataURL, width, height);
              pin.imageId = imageId;
              Cloud._cache[imageId] = dataURL; // 즉시 미리보기용 캐시
              uploaded = true;
            } catch (e) { uploaded = false; } // 네트워크 단절 등 → 큐로 폴백
          }
          if (!uploaded) {
            // 오프라인/실패: 로컬에 즉시 저장하고 인터넷 복구 시 일괄 업로드
            status.textContent = "📥 오프라인 — 휴대폰에 임시 저장 (인터넷 복구 시 자동 업로드)";
            const opId = await SyncQueue.enqueue({
              kind: "image", name: imgName, image_data: dataURL, width, height
            });
            pin.pendingOpId = opId;     // 동기화 완료 시 imageId 로 치환
            pin.pendingSync = true;     // 미동기화 표시
            Cloud._cache["op:" + opId] = dataURL; // 미동기화 미리보기 캐시
          }
        } else if (url) {
          // URL 직접 입력 (이미지 또는 영상 자동 판별)
          pin.imageUrl = url;
          if (/\.(mp4|webm|mov)(\?|#|$)/i.test(url)) pin.isVideo = true;
        }

        // ── 첨부 문서 업로드 (PDF/Word 등) — 오프라인 우선 ──
        if (docs.length) {
          if (!Array.isArray(pin.attachments)) pin.attachments = [];
          for (let i = 0; i < docs.length; i++) {
            const d = docs[i];
            const dataURL = await Cloud.fileToDataURL(d.file);
            let docOk = false, docId = null;
            if (navigator.onLine) {
              try {
                status.textContent = `📎 첨부 업로드 중... (${i + 1}/${docs.length}) ${d.name}`;
                status.classList.remove("hidden", "error");
                docId = await Cloud.uploadDoc(d.name, dataURL);
                docOk = true;
              } catch (e) { docOk = false; }
            }
            const att = { id: d.tempId, name: d.name, size: d.size, type: d.kind.type };
            if (docOk) { att.docId = docId; }
            else {
              // 오프라인 큐잉
              const opId = await SyncQueue.enqueue({ kind: "doc", name: d.name, image_data: dataURL });
              att.pendingOpId = opId; att.pendingSync = true;
              Cloud._cache["op:" + opId] = dataURL;
              pin.pendingSync = true;
            }
            pin.attachments.push(att);
          }
        }

        // ── 3D 포인트 클라우드(FLS/E57/LAS/PLY) 연결 ──
        // 현 세션에선 로컬 캐시(Cloud._cache['fls:'+id])로 즉시 표출.
        // 용량이 큰 3D 원본은 D1에 통째로 넣지 않고 메타만 보관(배포 후 URL 연결 권장).
        if (State.pendingFls) {
          pin.flsLocalId = State.pendingFls.localId;
          pin.flsName    = State.pendingFls.name;
          pin.flsSize    = State.pendingFls.size;
          pin.has3D      = true;
        }
      } catch (e) {
        status.textContent = "❌ 업로드 실패: " + e.message;
        status.classList.add("error");
        status.classList.remove("hidden");
        btn.disabled = false;
        setBtnLabel("저장하기");
        return;
      }

      if (!editing) State.pins.push(pin);   // 편집 시 기존 객체를 그대로 갱신했으므로 push 안 함
      if (typeof Log !== "undefined") Log.push(editing ? "pin.edit" : "pin.add", pin.id, { label: pin.label, page: pin.page });
      State.activePin = pin.id;
      if (typeof Zones !== "undefined") Zones.refreshPinLinks(); // 영역-핀 연결 갱신
      const wasEditing = editing;
      State.editingPinId = null;
      this._resetPinForm(true);
      setBtnLabel("저장하기");
      this._updateSyncBadge();

      UI.renderPinList();
      UI.renderPinsOnMap(wasEditing ? null : pin.id); // 신규만 드롭 애니메이션
      MapCtrl.flyTo(pin.x, pin.y, Math.max(State.zoom, 2.2), 500);
      this._autoSave(); // 버튼 없이 즉시 서버 저장

      // 편집 완료면 별도 안내만, 신규면 다음 포인트 연속 배치 안내
      if (wasEditing) {
        State.pinEditUnlocked = null; // 수정 완료 → 다시 잠금
        Prompt.toast("✅ '" + label + "' 수정 완료 · 자동저장");
        return;
      }
      let savedNote = (pin.pendingSync ? "📥 '" : "✅ '") + label + (pin.pendingSync ? "' 임시 저장 (오프라인)" : "' 저장 완료");
      const tags = [];
      if (pin.imageId)        tags.push("☁ 360° 그림");
      else if (pin.pendingOpId) tags.push("📥 360° 그림(대기)");
      else if (pin.isVideo && pin.videoUrl) tags.push("🎬 영상(로컬)");
      else if (pin.isVideo)   tags.push("🎬 360° 영상");
      else if (pin.imageUrl)  tags.push("🔗 URL");
      if (pin.note)           tags.push("📝 노트");
      if (pin.has3D)          tags.push("🧊 3D 클라우드");
      if (pin.attachments && pin.attachments.length) tags.push("📎 첨부 " + pin.attachments.length);
      if (tags.length) savedNote += " (" + tags.join(" · ") + ")";
      UI.text("pin-saved-msg", savedNote);
      UI.show("section-next-point");
    },

    /** 동기화 완료 콜백 — 큐 op id → 서버 imageId/docId 로 치환 후 화면 갱신 */
    _onSyncDone(result) {
      const map = (result && result.map) || {};
      let changed = false;
      State.pins.forEach(pin => {
        if (pin.pendingOpId && map[pin.pendingOpId]) {
          pin.imageId = map[pin.pendingOpId];
          // 미리보기 캐시 키 이관
          const cached = Cloud._cache["op:" + pin.pendingOpId];
          if (cached) Cloud._cache[pin.imageId] = cached;
          delete pin.pendingOpId; changed = true;
        }
        if (pin.attachments) {
          pin.attachments.forEach(att => {
            if (att.pendingOpId && map[att.pendingOpId]) {
              att.docId = map[att.pendingOpId];
              const c = Cloud._cache["op:" + att.pendingOpId];
              if (c) Cloud._cache[att.docId] = c;
              delete att.pendingOpId; delete att.pendingSync; changed = true;
            }
          });
        }
        // 모든 대기 항목이 해소되면 pendingSync 해제
        if (pin.pendingSync && !pin.pendingOpId &&
            !(pin.attachments || []).some(a => a.pendingOpId)) {
          delete pin.pendingSync; changed = true;
        }
      });
      if (changed) { try { UI.renderPinList(); UI.renderPinsOnMap(); } catch (e) {} }
      this._updateSyncBadge();
    },

    /** 동기화 상태 배지 갱신 */
    _updateSyncBadge() {
      const badge = UI.$("sync-badge");
      if (!badge) return;
      SyncQueue.count().then(n => {
        const dot = UI.$("sync-dot"), txt = UI.$("sync-text");
        const online = navigator.onLine;
        if (!online && n === 0) {
          badge.classList.remove("hidden", "online", "pending");
          badge.classList.add("offline");
          if (txt) txt.textContent = "오프라인";
        } else if (n > 0) {
          badge.classList.remove("hidden", "online", "offline");
          badge.classList.add("pending");
          if (txt) txt.textContent = (online ? "동기화 대기 " : "오프라인 저장 ") + n;
        } else {
          // 온라인 + 대기 0 → 잠시 표시 후 숨김
          badge.classList.remove("offline", "pending");
          badge.classList.add("online");
          if (txt) txt.textContent = "동기화됨";
          // 디자이너 모드에서만 굳이 항상 표시할 필요는 없으나, 일관성 위해 유지
        }
      });
    },

    setActivePin(id) {
      State.activePin = State.activePin === id ? null : id;
      UI.renderPinList();
      UI.renderPinsOnMap();
    },

    /** 핀 리스트 클릭 → 해당 페이지로 전환 + 플라이투 (+뷰어는 파노라마 오픈) */
    async focusPin(pin, openAfter) {
      State.activePin = pin.id;
      const targetPage = pin.page || 1;
      if (targetPage !== State.pdfPage) {
        State.pdfPage = targetPage;
        if (State.mode === "viewer" && State.viewerPages) {
          const imgEl = UI.$("map-image");
          await new Promise(res => { imgEl.onload = res; imgEl.src = State.viewerPages[targetPage - 1]; });
          UI.updatePdfPagination();
          UI.renderPinsOnMap();
        } else if (State.pdfDoc) {
          await this._renderPdfPage();
        }
      }
      UI.renderPinList();
      UI.renderPinsOnMap();
      MapCtrl.flyTo(pin.x, pin.y, Math.max(State.zoom, 2.2));
      // flyTo 와 동시에 360° 로딩을 시작(병렬)해 체감 속도를 높인다. (지연 최소화)
      if (openAfter) setTimeout(() => this.openPano(pin), 250);
    },

    deletePin(id) {
      const removed = State.pins.find(p => p.id === id);
      if (!removed) return;
      if (!confirm(`'${removed.label}' 포인트를 삭제할까요?\n(첨부된 사진·노트·문서 정보도 함께 제거됩니다)`)) return;
      if (removed.videoUrl) _revokeVideoBlob(removed.videoUrl); // [B5] 삭제 시 즉시 해제
      State.pins = State.pins.filter(p => p.id !== id);
      if (State.activePin === id) State.activePin = null;
      if (State.editingPinId === id) { State.editingPinId = null; this._closePinForm(); }
      if (typeof Zones !== "undefined" && Zones.refreshPinLinks) Zones.refreshPinLinks();
      UI.renderPinList();
      UI.renderPinsOnMap();
      Prompt.toast("🗑️ '" + removed.label + "' 삭제됨");
      this._autoSave();
    },

    /** 기존 포인트 편집 — 플로팅 폼을 기존 값으로 채워 연다 */
    editPin(id) {
      const pin = State.pins.find(p => p.id === id);
      if (pin == null) return;
      // 다른 모드 정리
      if (State.placing) this._togglePlacing();
      State.editingPinId = id;
      State.pending = { x: pin.x, y: pin.y };   // 좌표 보존
      State.pendingFile = null; State.pendingIsVideo = false; State.pendingDocs = [];
      // 폼 필드 채우기
      UI.$("input-pin-label").value = pin.label || "";
      UI.$("input-pin-note").value = pin.note || "";
      UI.$("input-pin-url").value = pin.imageUrl || "";
      UI.$("input-pin-imgname").value = pin.imageName || "";
      // 노트/URL 있으면 펼쳐서 보여줌
      const showField = (fid, btnId, on) => {
        const f = UI.$(fid), b = UI.$(btnId);
        if (f) f.classList.toggle("hidden", !on);
        if (b) b.classList.toggle("active", on);
      };
      showField("field-pin-note", "btn-pin-note-toggle", !!pin.note);
      showField("field-pin-url",  "btn-pin-url-toggle",  !!pin.imageUrl);
      // 기존 첨부/미디어 요약 표시
      const info = UI.$("pin-file-info");
      const summ = [];
      if (pin.imageId || pin.pendingOpId) summ.push("360° 사진 등록됨");
      else if (pin.isVideo) summ.push("360° 영상 등록됨");
      if (pin.attachments && pin.attachments.length) summ.push("첨부 " + pin.attachments.length + "개");
      if (summ.length) { info.textContent = "현재: " + summ.join(" · ") + " (새 파일 선택 시 교체)"; info.classList.remove("hidden"); }
      else { info.textContent = ""; info.classList.add("hidden"); }
      UI.disable("btn-confirm-pin"); UI.$("btn-confirm-pin").disabled = false; // 편집은 항상 저장 가능
      // 화면 이동 + 폼 열기
      State.activePin = id;
      UI.renderPinList(); UI.renderPinsOnMap();
      MapCtrl.flyTo(pin.x, pin.y, Math.max(State.zoom, 2.2));
      this._openPinForm({ editing: true });
      setTimeout(() => UI.$("input-pin-label").focus(), 120);
    },

    /** 핀에 360° 미디어(클라우드 이미지/로컬 영상/외부 URL/미동기화 로컬)가 등록되어 있는가 */
    pinHasMedia(pin) {
      return !!(pin && (pin.imageId || pin.videoUrl || pin.imageUrl || pin.pendingOpId));
    },

    /** 핀에 노트/첨부/3D 포인트클라우드가 있는가 */
    pinHasInfo(pin) {
      return !!(pin && (pin.note || (pin.attachments && pin.attachments.length) || pin.has3D || pin.flsLocalId || pin.flsUrl));
    },

    /** 핀에 클릭 시 보여줄 콘텐츠(미디어 또는 정보)가 있는가 */
    pinHasContent(pin) {
      return this.pinHasMedia(pin) || this.pinHasInfo(pin);
    },

    /** 360° 오버레이 안에 노트/첨부 정보 패널 렌더 */
    _renderPanoInfoPanel(pin) {
      const panel = document.getElementById("pano-info-panel");
      if (!panel) return;
      if (!this.pinHasInfo(pin)) { panel.classList.add("hidden"); panel.innerHTML = ""; return; }

      const dlIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
      let html = `
        <div class="pano-info-title">
          <span>📋 ${UI.escapeHtml(pin.label)}</span>
          <button class="pano-info-close" id="pano-info-close" title="닫기" aria-label="닫기">✕</button>
        </div>`;
      if (pin.note) html += `<div class="pano-note-text">${UI.escapeHtml(pin.note)}</div>`;
      if (pin.attachments && pin.attachments.length) {
        html += `<div class="pano-attach-head">첨부 문서 ${pin.attachments.length}</div>`;
        pin.attachments.forEach((a, i) => {
          const k = docKind(a.type || a.name);
          html += `
            <div class="pano-attach-item" data-attach-idx="${i}" title="클릭하여 열기/다운로드">
              <span class="pin-doc-badge" style="background:${k.color}">${k.label}</span>
              <span class="pano-attach-name">${UI.escapeHtml(a.name)}</span>
              <span class="pano-attach-dl">${dlIcon}</span>
            </div>`;
        });
      }
      panel.innerHTML = html;
      panel.classList.remove("hidden");
      const closeBtn = document.getElementById("pano-info-close");
      if (closeBtn) closeBtn.addEventListener("click", () => panel.classList.add("hidden"));
      panel.querySelectorAll(".pano-attach-item").forEach(el => {
        el.addEventListener("click", () => {
          const idx = parseInt(el.dataset.attachIdx, 10);
          this._openAttachment(pin.attachments[idx], el);
        });
      });
    },

    /** 첨부 문서 열기/다운로드 */
    async _openAttachment(att, el) {
      if (!att || !att.docId) return;
      const nameEl = el ? el.querySelector(".pano-attach-name") : null;
      const orig = nameEl ? nameEl.textContent : "";
      if (nameEl) nameEl.textContent = "불러오는 중...";
      try {
        const dataURL = await Cloud.fetchDoc(att.docId);
        // dataURL → Blob → 다운로드 (브라우저가 처리할 수 없는 형식도 안전하게 저장)
        const blob = await (await fetch(dataURL)).blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = att.name || "attachment";
        document.body.appendChild(a);
        a.click();
        a.remove();
        // PDF/이미지는 새 탭 미리보기도 함께 제공
        if (/pdf|img|image/.test(att.type || "") || /\.pdf$|\.(png|jpe?g|gif|webp)$/i.test(att.name || "")) {
          window.open(blobUrl, "_blank");
        }
        setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
      } catch (e) {
        alert("첨부를 불러올 수 없습니다: " + (e.message || e));
      } finally {
        if (nameEl) nameEl.textContent = orig;
      }
    },

    /* ── 360° 팝업 열기 (클라우드 저장본 / 영상 / URL) ── */
    async openPano(pin) {
      // 현재 핀 기록 + 레이더/네비게이션 갱신 (3DVista radar · 핀 이동 핫스팟)
      State.activePin = pin.id;
      PanoViewer._currentPin = pin;
      Radar.update(pin);
      PanoNav.update(pin);
      // FLS 포인트 클라우드가 연결된 핀이면 3D 뷰어를 360과 나란히 표시
      if (typeof FLS !== "undefined") {
        const hasFls = !!(pin && (pin.flsUrl || pin.fls || pin.flsLocalId));
        const ov = document.getElementById("pano-overlay");
        if (ov) ov.classList.toggle("with-fls", hasFls);
        if (hasFls) FLS.openForPin(pin); else FLS.showPane(false);
      }
      if (typeof Notes !== "undefined") Notes.setPin(pin);  // 이슈/노트 패널 핀 연결
      if (typeof TimeLapse !== "undefined") TimeLapse.setPin(pin);  // 타임랩스 시점 바

      // 노트/첨부만 있고 360° 미디어가 없는 정보 포인트 → 정보 패널만 표시
      if (!this.pinHasMedia(pin) && this.pinHasInfo(pin)) {
        const $ = id => document.getElementById(id);
        $("pano-location-name").textContent = "📋 " + pin.label;
        $("pano-loading").classList.add("hidden");
        $("pano-error").classList.add("hidden");
        $("pano-canvas").classList.add("hidden");
        $("pano-hint").classList.add("hidden");
        $("pano-controls").classList.add("hidden");
        $("pano-overlay").classList.remove("hidden");
        PanoViewer.open = true;
        this._renderPanoInfoPanel(pin);
        return;
      }
      this._renderPanoInfoPanel(pin); // 미디어와 함께 노트/첨부도 표시
      // 1) 로컬 영상 blob
      if (pin.videoUrl) { PanoViewer.loadVideo(pin.videoUrl, pin.label); return; }
      // 1.5) 미동기화 로컬 이미지(오프라인 임시 저장) — 로컬 캐시로 즉시 미리보기
      if (pin.pendingOpId && Cloud._cache["op:" + pin.pendingOpId]) {
        const $ = id => document.getElementById(id);
        $("pano-location-name").textContent = "360°(임시 저장) — " + pin.label;
        $("pano-loading").classList.add("hidden");
        $("pano-error").classList.add("hidden");
        $("pano-hint").classList.add("hidden");
        $("pano-controls").classList.add("hidden");
        $("pano-overlay").classList.remove("hidden");
        PanoViewer.open = true;
        PanoViewer.load(Cloud._cache["op:" + pin.pendingOpId], pin.label);
        return;
      }
      // 2) 클라우드 저장 이미지
      if (pin.imageId) {
        const $ = id => document.getElementById(id);
        $("pano-location-name").textContent = "360° — " + pin.label;
        $("pano-loading").classList.remove("hidden");
        $("pano-error").classList.add("hidden");
        $("pano-canvas").classList.add("hidden");
        $("pano-hint").classList.add("hidden");
        $("pano-controls").classList.add("hidden");
        $("pano-overlay").classList.remove("hidden");
        PanoViewer.open = true;
        try {
          const dataURL = await Cloud.fetchImage(pin.imageId);
          PanoViewer.load(dataURL, pin.label);
        } catch (e) {
          PanoViewer._showError("(클라우드: " + (pin.imageName || pin.imageId) + ")", e.message);
        }
      } else if (pin.imageUrl) {
        // 3) URL 직접 입력 (이미지/영상 자동 판별)
        PanoViewer.loadMedia(pin.imageUrl, pin.label, pin.isVideo);
      } else {
        // 4) [B3] 미디어 없음 (로컬 영상이 배포 과정에서 제거된 경우 등) — 명확히 안내
        const $ = id => document.getElementById(id);
        $("pano-location-name").textContent = "360° — " + pin.label;
        $("pano-loading").classList.add("hidden");
        $("pano-canvas").classList.add("hidden");
        $("pano-controls").classList.add("hidden");
        $("pano-hint").classList.add("hidden");
        $("pano-error").querySelector(".pano-error-msg").textContent =
          "이 포인트의 360° 영상은 로컬 전용이라 배포본에 포함되지 않았습니다. 설계자 모드에서 영상 URL로 다시 저장해 주세요.";
        $("pano-error-url").textContent = "";
        const hint = $("pano-error").querySelector(".pano-error-hint");
        if (hint) hint.textContent = "영상은 외부에 호스팅된 URL(.mp4) 형태로 저장하면 모든 환경에서 재생됩니다.";
        $("pano-error").classList.remove("hidden");
        $("pano-overlay").classList.remove("hidden");
        PanoViewer.open = true;
      }
    },

    /* ── 배포 (설계자 → 뷰어) ── */
    /* ── 자동 저장 (버튼 없이 즉시 저장) ──
       도면 업로드 즉시 배포본(작업본)을 생성하고, 핀·영역 변경 시 디바운스 갱신한다.
       사용자가 "배포" 버튼을 누르지 않아도 도면과 작업 내용이 서버에 보존된다. */
    _buildSavePayload(pagesData) {
      const deployablePins = State.pins.map(p => {
        const q = Object.assign({}, p);
        if (q.videoUrl) { delete q.videoUrl; q.localOnly = true; }
        return q;
      });
      const body = {
        title:       State.fileName || "도면",
        file_name:   State.fileName || "",
        pins:        JSON.stringify(deployablePins),
        zones:       (typeof Zones !== "undefined") ? Zones.serialize() : "[]",
        annotations: JSON.stringify(State.annotations || [])
      };
      if (pagesData && pagesData.length) {
        body.drawing_data = pagesData[0];
        body.pages_data   = JSON.stringify(pagesData);
      }
      return body;
    },

    async _snapshotPages() {
      if (State.fileType === "pdf" && State.pdfDoc) {
        return await PDF.snapshotAllPages(State.pdfDoc);
      } else if (State.fileType === "image") {
        const imgEl = UI.$("map-image");
        if (!imgEl || !imgEl.naturalWidth) return [];
        const off = document.createElement("canvas");
        const maxDim = 2000;
        const ratio = Math.min(1, maxDim / Math.max(imgEl.naturalWidth, imgEl.naturalHeight));
        off.width  = Math.round(imgEl.naturalWidth * ratio);
        off.height = Math.round(imgEl.naturalHeight * ratio);
        off.getContext("2d").drawImage(imgEl, 0, 0, off.width, off.height);
        return [off.toDataURL("image/jpeg", 0.8)];
      }
      return [];
    },

    _setSaveIndicator(stateStr) {
      // stateStr: 'saving' | 'saved' | 'error' | 'offline'
      const el = UI.$("autosave-indicator");
      if (!el) return;
      el.classList.remove("hidden", "saving", "saved", "error", "offline");
      el.classList.add(stateStr);
      const map = {
        saving:  "저장 중…",
        saved:   "자동 저장됨",
        error:   "저장 실패 — 재시도",
        offline: "오프라인 — 로컬 보관"
      };
      const t = UI.$("autosave-text");
      if (t) t.textContent = map[stateStr] || "";
    },

    /** #3: 도면 로드 직후 — 구역 보장 + 즉시 자동저장(스냅샷) + 구역에 도면 연결 */
    async _afterDrawingLoaded() {
      if (State.mode !== "designer") return;
      try {
        // 1) 구역이 없으면 강제 생성(현재 구역 보장)
        let deck = null;
        if (typeof Projects !== "undefined" && Projects.currentProject) {
          deck = await Projects.ensureDeck();
        }
        // 2) 도면 스냅샷 즉시 저장 (배포본 생성)
        State.autoSaveDepId = null; // 새 도면이므로 새 스냅샷
        await this._createInitialSave();
        // 3) 생성된 도면 배포본을 현재 구역에 연결
        if (deck && State.autoSaveDepId) {
          deck.deployment_id = State.autoSaveDepId;
          try {
            await fetch("/api/decks/" + deck.id, {
              method: "PUT", headers: Auth.headers(),
              body: JSON.stringify({ name: deck.name, level_no: deck.level_no || null, deployment_id: State.autoSaveDepId })
            });
            Projects._renderDecks();
          } catch (e) { /* 연결 실패해도 도면/스냅샷은 저장됨 */ }
        }
        Prompt.toast && Prompt.toast("📄 도면 등록 · 자동저장 완료" + (deck ? " (구역: " + deck.name + ")" : ""));
      } catch (e) { /* 비치명적 */ }
    },

    /** 구역 선택 시 연결된 도면(배포 스냅샷)을 불러와 화면(디자이너 편집)에 표시 */
    async loadDeckDrawing(deploymentId) {
      if (!deploymentId) return;
      try {
        const r = await fetch("/tables/deployments/" + encodeURIComponent(deploymentId));
        if (!r.ok) return;
        const dep = await r.json();
        let pages = [];
        try { pages = JSON.parse(dep.pages_data || "[]"); } catch { pages = []; }
        if (!Array.isArray(pages) || pages.length === 0) pages = dep.drawing_data ? [dep.drawing_data] : [];
        if (!pages.length) return;

        State.reset();
        State.fileType = "image";       // 스냅샷은 이미지(dataURL)로 보관됨
        State.viewerPages = pages;
        State.pdfPage = 1;
        State.fileName = dep.file_name || dep.title || "구역 도면";
        UI.text("file-name-label", State.fileName);
        UI.$("drop-hint").classList.add("hidden");
        UI.$("pdf-canvas").classList.add("hidden");
        try { State.pins  = JSON.parse(dep.pins  || "[]"); } catch { State.pins = []; }
        try { State.zones = JSON.parse(dep.zones || "[]"); } catch { State.zones = []; }
        try { State.annotations = JSON.parse(dep.annotations || "[]"); } catch { State.annotations = []; }

        const imgEl = UI.$("map-image");
        imgEl.onload = () => {
          this._showMapViewport();
          UI.renderPinList(); UI.renderPinsOnMap();
          if (typeof Zones !== "undefined") { Zones.render(); Zones.renderList(); }
        };
        imgEl.src = pages[0];
        imgEl.classList.remove("hidden");

        State.autoSaveDepId = deploymentId;       // 이후 자동저장은 이 배포본 갱신
        State.currentDeploymentId = deploymentId;
      } catch (e) { /* 무시 */ }
    },

    /** 도면 업로드 직후 1회: 배포본 생성(도면 스냅샷 포함) */
    async _createInitialSave() {
      if (State.mode !== "designer") return;
      if (State.autoSaveDepId) return; // 이미 생성됨
      if (!State.fileType) return;
      try {
        this._setSaveIndicator("saving");
        const pages = await this._snapshotPages();
        if (!pages.length) { this._setSaveIndicator("error"); return; }
        const body = this._buildSavePayload(pages);
        const res = await fetch("/tables/deployments", {
          method: "POST",
          headers: Auth.headers(),
          body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const rec = await res.json();
        State.autoSaveDepId = (rec && rec.id) ? rec.id : null;
        State.currentDeploymentId = State.autoSaveDepId;
        this._setSaveIndicator("saved");
      } catch (e) {
        this._setSaveIndicator(navigator.onLine ? "error" : "offline");
      }
    },

    /** 핀/영역 변경 시 디바운스 자동 저장 (도면 스냅샷은 보통 변경 안 되므로 생략) */
    _autoSave(opts) {
      if (State.mode !== "designer") return;
      opts = opts || {};
      clearTimeout(this._autoSaveTimer);
      this._autoSaveTimer = setTimeout(async () => {
        if (this.autoSaving) { this._autoSave(opts); return; } // 진행 중이면 잠시 후 재시도
        // 배포본이 아직 없으면 먼저 생성
        if (!State.autoSaveDepId) { await this._createInitialSave(); if (!State.autoSaveDepId) return; }
        this.autoSaving = true;
        try {
          this._setSaveIndicator("saving");
          const includePages = !!opts.withPages;
          const pages = includePages ? await this._snapshotPages() : null;
          const body = this._buildSavePayload(pages);
          const res = await fetch("/tables/deployments/" + encodeURIComponent(State.autoSaveDepId), {
            method: "PATCH",
            headers: Auth.headers(),
            body: JSON.stringify(body)
          });
          if (!res.ok) throw new Error("HTTP " + res.status);
          this._setSaveIndicator("saved");
        } catch (e) {
          this._setSaveIndicator(navigator.onLine ? "error" : "offline");
        } finally {
          this.autoSaving = false;
        }
      }, opts.now ? 0 : 700);
    },

    async _deployToViewer() {
      const btn    = UI.$("btn-deploy");
      const status = UI.$("deploy-status");

      if (State.pins.length === 0) { alert("배포할 핀이 없습니다. 먼저 포인트를 추가하세요."); return; }
      if (typeof Log !== "undefined") Log.push("deploy.click", null, { pins: State.pins.length });

      // ── 오프라인 등록은 허용하되, 서버 빌드(배포)는 인증 완료 필수 ──
      // (요구사항: 오프라인일 때 등록은 가능하지만 서버에 빌드하려면 반드시 인증이 완료되어야 함)
      if (!navigator.onLine) {
        alert("현재 오프라인 상태입니다.\n\n• 포인트/도면 '등록'은 계속 가능합니다(자동 임시저장).\n• 단, 서버에 '빌드(배포)'하려면 인터넷 연결 + 인증 완료가 필요합니다.\n\n인터넷에 연결한 뒤 다시 시도해 주세요.");
        return;
      }
      const authed = (typeof Auth !== "undefined") && !!Auth.idToken && !!Auth.user;
      if (!authed || !Auth.isDesigner) {
        alert("서버 빌드(배포)에는 설계자 인증이 필요합니다.\n\nGoogle 로그인 또는 @seastargo.com 계정으로 로그인하고 인증을 완료한 뒤 다시 시도해 주세요.");
        if (typeof Auth !== "undefined" && Auth.requireDesigner) { try { Auth.requireDesigner(() => this._deployToViewer()); } catch (e) {} }
        return;
      }

      // 미동기화(오프라인 임시 저장) 핀이 있으면 배포 전에 먼저 서버로 일괄 업로드
      const hasPending = State.pins.some(p => p.pendingOpId || (p.attachments || []).some(a => a.pendingOpId));
      if (hasPending) {
        if (!navigator.onLine) {
          alert("아직 업로드되지 않은 오프라인 핀이 있습니다. 인터넷에 연결한 뒤 다시 배포해 주세요.");
          return;
        }
        btn.disabled = true; btn.textContent = "임시 저장 핀 업로드 중...";
        const r = await SyncQueue.flush();
        this._onSyncDone(r);
        if (State.pins.some(p => p.pendingOpId || (p.attachments || []).some(a => a.pendingOpId))) {
          alert("일부 핀 업로드에 실패했습니다. 네트워크를 확인하고 다시 시도해 주세요.");
          btn.disabled = false; btn.textContent = "🚀 뷰어로 배포";
          return;
        }
      }

      btn.disabled = true; btn.textContent = "배포 중...";
      status.classList.add("hidden"); status.classList.remove("error");

      let pagesData = [];
      try {
        if (State.fileType === "pdf" && State.pdfDoc) {
          btn.textContent = "도면 전 페이지 스냅샷 중...";
          pagesData = await PDF.snapshotAllPages(State.pdfDoc);
        } else if (State.fileType === "image") {
          const imgEl = UI.$("map-image");
          const off = document.createElement("canvas");
          const maxDim = 2000;
          const ratio = Math.min(1, maxDim / Math.max(imgEl.naturalWidth, imgEl.naturalHeight));
          off.width  = Math.round(imgEl.naturalWidth * ratio);
          off.height = Math.round(imgEl.naturalHeight * ratio);
          off.getContext("2d").drawImage(imgEl, 0, 0, off.width, off.height);
          pagesData = [off.toDataURL("image/jpeg", 0.8)];
        }
      } catch (e) {
        alert("도면 스냅샷 생성 실패: " + e.message);
        btn.disabled = false; btn.textContent = "🚀 뷰어로 배포";
        return;
      }
      if (pagesData.length === 0) {
        alert("도면이 없습니다. 먼저 도면을 업로드하세요.");
        btn.disabled = false; btn.textContent = "🚀 뷰어로 배포";
        return;
      }

      btn.textContent = "서버 저장 중...";
      // [B2] 로컬 전용 영상 blob URL은 다른 세션에서 무효 → 배포본에서 제거
      const deployablePins = State.pins.map(p => {
        const q = Object.assign({}, p);
        if (q.videoUrl) { delete q.videoUrl; q.localOnly = true; }
        return q;
      });
      try {
        const res = await fetch("/tables/deployments", {
          method: "POST",
          headers: Auth.headers(),
          body: JSON.stringify({
            title:        State.fileName || "도면",
            file_name:    State.fileName || "",
            drawing_data: pagesData[0],
            pages_data:   JSON.stringify(pagesData),
            pins:         JSON.stringify(deployablePins),
            zones:        (typeof Zones !== "undefined") ? Zones.serialize() : "[]"
          })
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        // [B1] 발급된 배포 레코드의 id를 뷰어 링크에 부여 → 특정 배포본 고정 공유
        const rec = await res.json();
        const depId = (rec && rec.id) ? rec.id : null;

        const viewerUrl = location.origin + location.pathname +
          "?mode=viewer" + (depId ? "&d=" + encodeURIComponent(depId) : "");
        // [C-LOOP1 결함1] 공유가 목적인 시스템 → 원클릭 링크 복사 버튼 제공
        status.innerHTML =
          "✅ 배포 완료! (" + pagesData.length + "페이지 / " + State.pins.length + "핀)<br>" +
          "뷰어 전용 링크:<br>" +
          "<a id='deploy-link' href='" + viewerUrl + "' target='_blank' style='color:#10b981;word-break:break-all'>" + viewerUrl + "</a><br>" +
          "<button id='btn-copy-link' type='button' style='margin-top:8px;padding:6px 14px;border-radius:8px;border:1px solid #10b981;background:transparent;color:#10b981;cursor:pointer;font-size:13px'>📋 링크 복사</button>";
        status.classList.remove("hidden");
        // 복사 버튼 핸들러 (clipboard API + execCommand 폴백)
        const copyBtn = document.getElementById("btn-copy-link");
        if (copyBtn) {
          copyBtn.addEventListener("click", async () => {
            const ok = await App._copyToClipboard(viewerUrl);
            copyBtn.textContent = ok ? "✅ 복사됨!" : "⚠ 복사 실패 — 링크를 길게 눌러 복사하세요";
            setTimeout(() => { copyBtn.textContent = "📋 링크 복사"; }, 2200);
          });
        }
      } catch (e) {
        status.textContent = "❌ 배포 실패: " + e.message;
        status.classList.add("error");
        status.classList.remove("hidden");
      } finally {
        btn.disabled = false; btn.textContent = "🚀 뷰어로 배포";
      }
    },

    /* ── 클립보드 복사 (Clipboard API → execCommand 폴백) ── */
    async _copyToClipboard(text) {
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch (e) { /* 폴백으로 진행 */ }
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        return ok;
      } catch (e) { return false; }
    },

    /* ── 뷰어: 최신 배포본 자동 로드 ── */
    async loadLatestDeployment() {
      const statusEl = UI.$("viewer-load-status");
      statusEl.textContent = "배포된 도면 불러오는 중...";

      try {
        // [B1] 링크에 배포 ID(?d=)가 있으면 그 배포본을 정확히 로드
        const params = new URLSearchParams(location.search);
        const wantId = params.get("d");
        let latest = null;

        if (wantId) {
          const r1 = await fetch("/tables/deployments/" + encodeURIComponent(wantId));
          if (r1.ok) latest = await r1.json();
        }

        // 없거나 실패 시 최신 배포본으로 폴백
        if (!latest) {
          const res = await fetch("/tables/deployments?limit=100");
          if (!res.ok) throw new Error("HTTP " + res.status);
          const json = await res.json();
          const rows = (json.data || []).filter(r => (r.drawing_data || r.pages_data) && !r.deleted);
          if (rows.length === 0) {
            statusEl.textContent = "아직 배포된 도면이 없습니다.";
            UI.$("pin-empty").textContent = "아직 배포된 도면이 없습니다.\n설계자가 배포하면 자동 표시됩니다.";
            return;
          }
          // [B4] created_at가 숫자(epoch)/ISO 문자열 어느 쪽이든 안전 정렬
          const ts = r => {
            const v = r.created_at;
            const n = (typeof v === "number") ? v : Date.parse(v);
            return Number.isFinite(n) ? n : 0;
          };
          rows.sort((a, b) => ts(b) - ts(a));
          latest = rows[0];
        }

        // 페이지 배열 복원 (신규 pages_data → 레거시 drawing_data)
        let pages = [];
        try { pages = JSON.parse(latest.pages_data || "[]"); } catch { pages = []; }
        if (!Array.isArray(pages) || pages.length === 0) pages = [latest.drawing_data];

        State.currentDeploymentId = latest.id || null;  // 노트/협업 연결
        State.fileType   = "image";
        State.viewerPages = pages;
        State.pdfPage    = 1;
        State.fileName   = latest.file_name || latest.title || "배포 도면";
        UI.text("file-name-label", State.fileName);
        UI.$("drop-hint").classList.add("hidden");
        UI.$("pdf-canvas").classList.add("hidden");

        try { State.pins = JSON.parse(latest.pins || "[]"); }
        catch { State.pins = []; }
        try { State.zones = JSON.parse(latest.zones || "[]"); }
        catch { State.zones = []; }
        try { State.annotations = JSON.parse(latest.annotations || "[]"); }
        catch { State.annotations = []; }

        const imgEl = UI.$("map-image");
        imgEl.onload = () => {
          this._showMapViewport();
          UI.renderPinList();
          UI.renderPinsOnMap();
          if (typeof Zones !== "undefined") { Zones.render(); Zones.renderList(); }  // 영역 표시
          if (typeof PdfAnno !== "undefined") PdfAnno.refresh();  // PDF 주석 복원
          if (typeof Notes !== "undefined") Notes.loadSummary();  // 핀별 이슈 카운트
        };
        imgEl.src = pages[0];
        imgEl.classList.remove("hidden");

        // [C-LOOP1 결함2] 뷰어 첫 진입 어포던스 — 핀 클릭으로 360°가 열림을 명시
        if (State.pins.length > 0) {
          statusEl.innerHTML =
            "✅ 로드 완료 (" + pages.length + "페이지 / " + State.pins.length + "개 포인트)<br>" +
            "<span style='color:var(--green)'>📍 도면 위 번호 핀을 클릭하면 360° 파노라마가 열립니다.</span>";
        } else {
          statusEl.textContent = "✅ 배포본 로드 완료 (" + pages.length + "페이지 / 포인트 없음)";
        }
        UI.renderPinList();
      } catch (e) {
        statusEl.textContent = "❌ 불러오기 실패: " + e.message;
      }
    },

    /* ── Export JSON ── */
    _exportJson() {
      const data = JSON.stringify({ fileName: State.fileName, pins: State.pins }, null, 2);
      const blob = new Blob([data], { type: "application/json" });
      const a = document.createElement("a");
      a.href     = URL.createObjectURL(blob);
      a.download = "360_points.json";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); document.body.removeChild(a); }, 1000);
    },
  };

  /* ══════════════════════════════════════════
     ALL-PINS DRAWER — 전체 핀 리스트 보기
     · 모든 페이지의 핀을 이름/번호순으로 한눈에
     · 검색, 360°/문서 미리보기 썸네일, 클릭 시 페이지 구분 없이 줌인+360° 오픈
  ══════════════════════════════════════════ */
  const AllPins = {
    open: false,
    sort: "page",     // 'page' | 'name'
    query: "",
    _thumbCache: {},  // imageId → dataURL (썸네일 1회 fetch 캐시)

    init() {
      const $ = (id) => document.getElementById(id);
      $("btn-all-pins") && $("btn-all-pins").addEventListener("click", () => this.toggle());
      $("btn-allpins-close") && $("btn-allpins-close").addEventListener("click", () => this.hide());
      $("allpins-backdrop") && $("allpins-backdrop").addEventListener("click", () => this.hide());
      const search = $("allpins-search-input");
      if (search) search.addEventListener("input", () => { this.query = search.value.trim().toLowerCase(); this.render(); });
      document.querySelectorAll(".allpins-sort-btn").forEach((b) => {
        b.addEventListener("click", () => {
          this.sort = b.dataset.sort;
          document.querySelectorAll(".allpins-sort-btn").forEach((x) => x.classList.toggle("active", x === b));
          this.render();
        });
      });
      // 단축키 P 로 토글 (입력 중/파노라마 열림 제외)
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && this.open) { this.hide(); return; }
        const tag = (e.target && e.target.tagName) || "";
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (PanoViewer.open) return;
        if ((e.key === "p" || e.key === "P") && State.pins.length) { e.preventDefault(); this.toggle(); }
      });
    },

    /** 핀이 있을 때만 topbar 버튼 노출 */
    syncButton() {
      const btn = document.getElementById("btn-all-pins");
      if (!btn) return;
      btn.classList.toggle("hidden", !State.pins.length);
    },

    toggle() { this.open ? this.hide() : this.show(); },

    show() {
      if (!State.pins.length) return;
      this.open = true;
      document.getElementById("allpins-drawer").classList.remove("hidden");
      requestAnimationFrame(() => document.getElementById("allpins-drawer").classList.add("on"));
      this.render();
    },

    hide() {
      this.open = false;
      const d = document.getElementById("allpins-drawer");
      d.classList.remove("on");
      setTimeout(() => { if (!this.open) d.classList.add("hidden"); }, 220);
    },

    _kindBadge(pin) {
      if (pin.isVideo || (pin.imageUrl && /\.(mp4|webm|mov)(\?|$)/i.test(pin.imageUrl)))
        return { ico: "🎬", cls: "video", txt: "360° 영상" };
      if (pin.imageId || pin.imageUrl) return { ico: "🌐", cls: "pano", txt: "360° 파노라마" };
      if (pin.attachments && pin.attachments.length) return { ico: "📎", cls: "doc", txt: pin.attachments.length + "개 첨부" };
      if (pin.note) return { ico: "📝", cls: "note", txt: "노트" };
      return { ico: "📍", cls: "empty", txt: "콘텐츠 없음" };
    },

    _sorted() {
      const arr = State.pins.map((p, i) => ({ pin: p, idx: i }));
      if (this.query) {
        arr.splice(0, arr.length, ...arr.filter((o) =>
          (o.pin.label || "").toLowerCase().includes(this.query)));
      }
      if (this.sort === "name") {
        arr.sort((a, b) => (a.pin.label || "").localeCompare(b.pin.label || "", "ko"));
      } else {
        arr.sort((a, b) => ((a.pin.page || 1) - (b.pin.page || 1)) || (a.idx - b.idx));
      }
      return arr;
    },

    render() {
      if (!this.open) return;
      const listEl = document.getElementById("allpins-list");
      const emptyEl = document.getElementById("allpins-empty");
      const countEl = document.getElementById("allpins-count");
      if (countEl) countEl.textContent = State.pins.length;
      const rows = this._sorted();
      listEl.innerHTML = "";
      if (!rows.length) { emptyEl.classList.remove("hidden"); return; }
      emptyEl.classList.add("hidden");

      const totalPages = State.mode === "viewer"
        ? (State.viewerPages ? State.viewerPages.length : 1) : State.pdfPages;

      rows.forEach(({ pin, idx }) => {
        const badge = this._kindBadge(pin);
        const hasMedia = App.pinHasContent(pin);
        const pageTag = totalPages > 1 ? `P${pin.page || 1}` : "";
        const row = document.createElement("button");
        row.className = "allpins-item" + (State.activePin === pin.id ? " active" : "");
        row.dataset.id = pin.id;
        row.innerHTML = `
          <span class="allpins-thumb ${badge.cls}" data-imgid="${pin.imageId || ""}">
            <span class="allpins-thumb-ico">${badge.ico}</span>
            <span class="allpins-thumb-no">${idx + 1}</span>
          </span>
          <span class="allpins-meta">
            <span class="allpins-name">${UI.escapeHtml(pin.label || "(이름 없음)")}</span>
            <span class="allpins-sub">
              <span class="allpins-kind ${badge.cls}">${badge.txt}</span>
              ${pageTag ? `<span class="allpins-page">${pageTag}</span>` : ""}
            </span>
          </span>
          <span class="allpins-go" title="이동 + 보기">
            ${hasMedia
              ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/></svg>'
              : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>'}
          </span>`;
        row.addEventListener("click", () => this._goto(pin));
        listEl.appendChild(row);

        // 360° 그림 썸네일 비동기 로드 (캐시)
        if (pin.imageId) this._loadThumb(row.querySelector(".allpins-thumb"), pin.imageId);
      });
    },

    async _loadThumb(thumbEl, imageId) {
      try {
        let url = this._thumbCache[imageId] || (Cloud._cache && Cloud._cache[imageId]);
        if (!url) { url = await Cloud.fetchImage(imageId); this._thumbCache[imageId] = url; }
        if (!url || !thumbEl) return;
        thumbEl.style.backgroundImage = `url("${url}")`;
        thumbEl.classList.add("has-img");
      } catch (e) { /* 썸네일 실패 무시 */ }
    },

    /** 페이지 구분 없이 해당 포인트로 이동(줌인) + 콘텐츠 있으면 360°/정보 함께 오픈 */
    async _goto(pin) {
      const hasContent = App.pinHasContent(pin);
      // 1) 먼저 도면을 해당 포인트로 이동(페이지 전환 포함)시켜 결과를 확정한 뒤
      await App.focusPin(pin, hasContent);
      // 2) 드로어를 닫는다 (이동 결과가 보이도록). 콘텐츠 없으면 닫고 도면만 보여줌.
      this.hide();
    }
  };

  /* ══════════════════════════════════════════
     AUTH — Google Identity 로그인 + 권한(슈퍼관리자/디자이너/뷰어)
     · 일반인(미로그인/권한없음) = 뷰어만
     · 디자이너로 지정된 구글 계정 = 설계자 기능
     · 슈퍼관리자(designssir@gmail.com) = 디자이너 지정 + 모든 권한
  ══════════════════════════════════════════ */
  const Auth = {
    idToken: null,
    user: null,           // { email, name, picture, role }
    role: "viewer",       // 'super' | 'designer' | 'viewer'
    superAdmin: "designssir@gmail.com",
    _pendingDesigner: null,
    _gsiInited: false,

    get clientId() {
      const id = (typeof window !== "undefined" && window.WM_GOOGLE_CLIENT_ID) || "";
      return id && id !== "GOOGLE_CLIENT_ID" ? id : "";
    },
    get isDesigner() { return this.role === "super" || this.role === "designer"; },
    get isSuper() { return this.role === "super"; },

    init() {
      const $ = (id) => document.getElementById(id);
      // 로그아웃
      $("btn-signout") && $("btn-signout").addEventListener("click", () => this.signOut());
      // 디자이너 관리(슈퍼)
      $("btn-manage-designers") && $("btn-manage-designers").addEventListener("click", () => Designers.open());
      // 로그인 게이트 닫기
      $("login-gate-cancel") && $("login-gate-cancel").addEventListener("click", () => this._closeGate());
      const gb = document.querySelector("#login-gate .admin-gate-backdrop");
      gb && gb.addEventListener("click", () => this._closeGate());

      // ── 데모 진입 (구글 로그인 없이 바로 체험) ──
      // 허브 인증바
      $("hub-btn-demo-designer") && $("hub-btn-demo-designer").addEventListener("click", () => this.demoLogin("designer"));
      $("hub-btn-demo-viewer")   && $("hub-btn-demo-viewer").addEventListener("click", () => this.demoLogin("viewer"));
      // 로그인 게이트 내 데모(설계자)
      $("login-gate-demo") && $("login-gate-demo").addEventListener("click", () => this.demoLogin("designer"));
      // 구글 로그인 폴백 버튼(클라이언트 ID 미설정 시 안내)
      $("login-gate-google-fallback") && $("login-gate-google-fallback").addEventListener("click", () => {
        if (!this.clientId) {
          Prompt && Prompt.toast && Prompt.toast("구글 로그인은 관리자 설정(클라이언트 ID) 후 사용할 수 있어요. 우선 체험으로 진행하세요.", 3200);
        }
      });
      $("login-gate-learn") && $("login-gate-learn").addEventListener("click", () => {
        Prompt && Prompt.toast && Prompt.toast("SEASTAR 360° Viewer — 도면 위 360° 파노라마 위치 점검 시스템", 3000);
      });

      // ── 사용 신청(Request Access) 게이트 ──
      $("access-gate-cancel") && $("access-gate-cancel").addEventListener("click", () => this._closeAccessGate());
      const ab = document.querySelector("#access-gate .access-gate-backdrop");
      ab && ab.addEventListener("click", () => this._closeAccessGate());
      const af = $("access-gate-form");
      af && af.addEventListener("submit", (e) => { e.preventDefault(); this._submitAccessRequest(); });

      // 저장된 토큰 복원 (구글 idToken 또는 회사 이메일 로컬 토큰)
      try {
        const saved = sessionStorage.getItem("wm_id_token") || localStorage.getItem("wm_local_token");
        if (saved) { this.idToken = saved; }
      } catch (e) {}

      this._initGsi();
      // 복원된 토큰으로 권한 재확인
      if (this.idToken) this.refresh();
    },

    _initGsi() {
      if (this._gsiInited) return;
      if (!window.google || !window.google.accounts || !window.google.accounts.id) {
        // GIS 스크립트 로딩 대기
        setTimeout(() => this._initGsi(), 300);
        return;
      }
      if (!this.clientId) {
        // 클라이언트 ID 미설정 — 버튼 자리에 안내
        const hint = document.querySelector(".auth-hint");
        if (hint) hint.textContent = "구글 로그인 미설정 (관리자가 클라이언트 ID 설정 필요)";
        return;
      }
      this._gsiInited = true;
      window.google.accounts.id.initialize({
        client_id: this.clientId,
        callback: (resp) => this._onCredential(resp),
        auto_select: false,
      });
      this._renderButtons();
    },

    _renderButtons() {
      const g = window.google.accounts.id;
      const b1 = document.getElementById("google-signin-btn");
      const b2 = document.getElementById("login-gate-signin");
      const b3 = document.getElementById("settings-signin");
      if (b1) { b1.innerHTML = ""; g.renderButton(b1, { theme: "filled_blue", size: "medium", text: "signin_with", shape: "pill" }); }
      if (b2) { b2.innerHTML = ""; g.renderButton(b2, { theme: "filled_blue", size: "large", text: "signin_with", shape: "pill" }); }
      if (b3) { b3.innerHTML = ""; g.renderButton(b3, { theme: "filled_blue", size: "large", text: "signin_with", shape: "pill" }); }
      this._renderHubSignin();
    },

    async _onCredential(resp) {
      if (!resp || !resp.credential) return;
      this.idToken = resp.credential;
      try { sessionStorage.setItem("wm_id_token", this.idToken); } catch (e) {}
      await this.refresh();
      // 디자이너 모드 진입을 기다리던 경우 처리
      if (this._pendingDesigner) {
        const cb = this._pendingDesigner;
        if (this.isDesigner) { this._pendingDesigner = null; this._closeGate(); cb(); }
        else {
          // 권한 없는 계정 → 반드시 권한없음/사용신청 페이지로 연결 (Genspark 모방)
          this._closeGate();
          this._openAccessGate();
        }
      }
    },

    /** 인증 헤더 (API 호출용) */
    headers(extra) {
      const h = Object.assign({ "Content-Type": "application/json" }, extra || {});
      if (this.idToken) h["Authorization"] = "Bearer " + this.idToken;
      return h;
    },

    /** 서버에 권한 확인 → UI 갱신 */
    async refresh() {
      let data = { authenticated: false, role: "viewer" };
      try {
        const r = await fetch("/api/auth/me", { headers: this.headers() });
        data = await r.json();
      } catch (e) {}
      if (data.authenticated) {
        this.user = { email: data.email, name: data.name, picture: data.picture, role: data.role, request_status: data.request_status || null };
        this.role = data.role;
        this.superAdmin = data.super_admin || this.superAdmin;
      } else {
        this.user = null; this.role = "viewer"; this.idToken = null;
        try { sessionStorage.removeItem("wm_id_token"); } catch (e) {}
      }
      this._applyUi();
      return this.role;
    },

    _applyUi() {
      // 홈 인증바 + 프로젝트 허브 인증바 모두 갱신
      this._applyUiTo("");      // home: auth-signed-in / user-name ...
      this._applyUiTo("hub-");  // hub:  hub-auth-signed-in / hub-user-name ...

      // 디자이너 카드 잠금 표시
      document.querySelectorAll(".mode-card.designer").forEach((c) => c.classList.toggle("locked", !this.isDesigner));
      // 설정 패널이 열려 있으면 권한에 맞춰 다시 렌더
      if (typeof Settings !== "undefined" && Settings._isOpen) Settings.render();
      // 프로젝트 허브가 보이는 중이면 +새프로젝트/편집 버튼 갱신
      if (typeof ProjectHub !== "undefined") ProjectHub.refreshIfVisible();
      // 데모 모드 배지 동기화
      if (this._showDemoBadge) this._showDemoBadge();
    },

    _applyUiTo(pfx) {
      const $ = (id) => document.getElementById(pfx + id);
      const signedIn  = $("auth-signed-in");
      const signedOut = $("auth-signed-out");
      if (this.user) {
        signedIn && signedIn.classList.remove("hidden");
        signedOut && signedOut.classList.add("hidden");
        $("user-name") && ($("user-name").textContent = this.user.name || this.user.email);
        const roleEl = $("user-role");
        if (roleEl) {
          roleEl.textContent = this.role === "super" ? "슈퍼관리자" : this.role === "designer" ? "디자이너" : "뷰어";
          roleEl.className = "user-role role-" + this.role;
        }
        const av = $("user-avatar");
        if (av) { if (this.user.picture) { av.src = this.user.picture; av.style.display = ""; } else av.style.display = "none"; }
        $("btn-manage-designers") && $("btn-manage-designers").classList.toggle("hidden", !this.isSuper);
      } else {
        signedIn && signedIn.classList.add("hidden");
        signedOut && signedOut.classList.remove("hidden");
      }
    },

    /** 프로젝트 허브의 구글 로그인 버튼 렌더 */
    _renderHubSignin() {
      if (!this._gsiInited || !window.google || !window.google.accounts) return;
      const b = document.getElementById("hub-google-signin-btn");
      if (b) { b.innerHTML = ""; window.google.accounts.id.renderButton(b, { theme: "filled_blue", size: "medium", text: "signin_with", shape: "pill" }); }
    },

    /** 디자이너 진입 요청. 권한 있으면 콜백 즉시, 없으면 로그인 게이트. */
    requireDesigner(onPass) {
      if (this.isDesigner) { onPass(); return; }
      this._pendingDesigner = onPass;
      this._openGate();
    },

    _openGate() {
      // 이미 로그인했지만 권한이 없는 계정이면 → 바로 사용신청(권한없음) 게이트로
      if (this.user && !this.isDesigner) { this._openAccessGate(); return; }
      const gate = document.getElementById("login-gate");
      const err = document.getElementById("login-gate-error");
      if (err) err.classList.add("hidden");
      gate.classList.remove("hidden");
      requestAnimationFrame(() => gate.classList.add("on"));
      // 게이트 안 버튼 렌더 (로그인은 됐지만 권한 없는 경우엔 안내)
      if (this._gsiInited) this._renderButtons();
      // 구글 클라이언트 ID가 있으면 폴백 버튼 숨김(실제 GIS 버튼 사용)
      const fb = document.getElementById("login-gate-google-fallback");
      if (fb) fb.classList.toggle("hidden", !!this.clientId);
    },
    _showGateError() {
      const err = document.getElementById("login-gate-error");
      if (err) err.classList.remove("hidden");
    },

    /* ── 권한 없음 / 사용 신청(Request Access) 게이트 ── */
    _openAccessGate() {
      const gate = document.getElementById("access-gate");
      if (!gate) return;
      // 본인 이메일 표시
      const email = (this.user && this.user.email) || "";
      const emEl = document.getElementById("access-gate-email");
      const roEl = document.getElementById("ar-email-readonly");
      if (emEl) emEl.textContent = email || "로그인 계정";
      if (roEl) roEl.textContent = email || "—";
      // 이름 기본값
      const nameEl = document.getElementById("ar-name");
      if (nameEl && !nameEl.value) nameEl.value = (this.user && this.user.name) || "";
      // 메시지 초기화
      const errEl = document.getElementById("access-gate-error");
      const okEl = document.getElementById("access-gate-success");
      if (errEl) errEl.classList.add("hidden");
      if (okEl) okEl.classList.add("hidden");
      // 이미 신청한 상태면 안내
      const status = this.user && this.user.request_status;
      const submitLabel = document.getElementById("ar-submit-label");
      if (status === "pending" && okEl && submitLabel) {
        okEl.textContent = "이미 신청이 접수되었습니다. 관리자 승인을 기다려 주세요.";
        okEl.classList.remove("hidden");
        submitLabel.textContent = "신청 내용 수정";
      } else if (submitLabel) {
        submitLabel.textContent = "Submit Request";
      }
      gate.classList.remove("hidden");
      requestAnimationFrame(() => gate.classList.add("on"));
    },
    _closeAccessGate() {
      const gate = document.getElementById("access-gate");
      if (!gate) return;
      gate.classList.remove("on");
      setTimeout(() => gate.classList.add("hidden"), 200);
      this._pendingDesigner = null;
    },
    async _submitAccessRequest() {
      const $ = (id) => document.getElementById(id);
      const errEl = $("access-gate-error");
      const okEl = $("access-gate-success");
      const btn = $("ar-submit");
      if (errEl) errEl.classList.add("hidden");
      if (okEl) okEl.classList.add("hidden");
      const name = ($("ar-name").value || "").trim();
      const company = ($("ar-company").value || "").trim();
      const country = ($("ar-country").value || "").trim();
      const phone = ($("ar-phone").value || "").trim();
      if (!name || !company || !country || !phone) {
        if (errEl) { errEl.textContent = "모든 필수 항목(*)을 입력해 주세요."; errEl.classList.remove("hidden"); }
        return;
      }
      if (!this.idToken) {
        if (errEl) { errEl.textContent = "구글 로그인 후 신청할 수 있습니다."; errEl.classList.remove("hidden"); }
        return;
      }
      if (btn) { btn.disabled = true; btn.classList.add("loading"); }
      try {
        const res = await fetch("/api/access-requests", {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({ name, company, country, phone }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
        if (okEl) {
          okEl.textContent = "✅ 사용 신청이 접수되었습니다. 관리자(" + (this.user && this.user.email ? "" : "") + "admin) 승인 후 설계자 기능을 사용할 수 있습니다.";
          okEl.classList.remove("hidden");
        }
        if (this.user) this.user.request_status = "pending";
        Prompt && Prompt.toast && Prompt.toast("📩 사용 신청이 관리자에게 전달되었습니다.", 2800);
      } catch (e) {
        if (errEl) { errEl.textContent = "신청 실패: " + (e && e.message ? e.message : "네트워크 오류"); errEl.classList.remove("hidden"); }
      } finally {
        if (btn) { btn.disabled = false; btn.classList.remove("loading"); }
      }
    },
    _closeGate() {
      const gate = document.getElementById("login-gate");
      if (!gate) return;
      gate.classList.remove("on");
      setTimeout(() => gate.classList.add("hidden"), 200);
      this._pendingDesigner = null;
    },

    /** 데모 진입 — 구글 로그인 없이 바로 권한 부여(서버가 demo 토큰 인식).
     *  role: 'designer' | 'viewer' */
    async demoLogin(role) {
      this.idToken = role === "super" ? "demo-super" : (role === "designer" ? "demo-designer" : "demo-viewer");
      try { sessionStorage.setItem("wm_id_token", this.idToken); } catch (e) {}
      await this.refresh();  // 서버가 demo 토큰을 검증해 role/user 세팅
      this._closeGate();
      // 디자이너 진입을 기다리던 콜백이 있으면 실행
      if (this._pendingDesigner) {
        const cb = this._pendingDesigner;
        this._pendingDesigner = null;
        if (this.isDesigner) cb();
      }
      // 데모 모드 안내 배지 표시
      this._showDemoBadge();
    },

    /** 데모 모드 안내 배지(허브 상단) */
    _showDemoBadge() {
      if (!this.user || !this.user.email || this.user.email.indexOf("demo.") !== 0) {
        // 데모가 아니면 배지 제거
        const ex = document.getElementById("demo-mode-badge");
        if (ex) ex.remove();
        return;
      }
      if (document.getElementById("demo-mode-badge")) return;
      const b = document.createElement("div");
      b.id = "demo-mode-badge";
      b.className = "demo-mode-badge";
      b.innerHTML = '<span class="demo-dot"></span>데모 모드 — 구글 로그인 없이 체험 중';
      document.body.appendChild(b);
    },

    signOut() {
      try {
        if (window.google && window.google.accounts && window.google.accounts.id)
          window.google.accounts.id.disableAutoSelect();
      } catch (e) {}
      // 회사 이메일(로컬) 세션이면 서버에서 무효화
      try {
        if (this.idToken && this.idToken.indexOf("local-") === 0) {
          fetch("/api/signup/logout", { method: "POST", headers: { "Authorization": "Bearer " + this.idToken } }).catch(() => {});
        }
      } catch (e) {}
      this.idToken = null; this.user = null; this.role = "viewer";
      try { sessionStorage.removeItem("wm_id_token"); localStorage.removeItem("wm_local_token"); } catch (e) {}
      this._applyUi();
      this._showDemoBadge();  // 데모 배지 제거
      // 디자이너 화면(편집 모드)에 있었다면 뷰어로 전환
      if (State.mode === "designer") {
        App.exitEdit();
      }
    }
  };

  /* ══════════════════════════════════════════
     SETTINGS — 설정 패널 (A안: 접속=뷰어, ⚙️ 설정 → 로그인 → 편집)
  ══════════════════════════════════════════ */
  const Settings = {
    _isOpen: false,

    init() {
      const $ = (id) => document.getElementById(id);
      // ⚙️ 설정 버튼 → 패널 열기
      $("btn-settings") && $("btn-settings").addEventListener("click", () => this.open());
      // 닫기
      $("settings-close") && $("settings-close").addEventListener("click", () => this.close());
      const bd = document.querySelector('#settings-modal .admin-gate-backdrop');
      bd && bd.addEventListener("click", () => this.close());
      // 편집 모드로 전환
      $("btn-go-edit") && $("btn-go-edit").addEventListener("click", () => {
        if (!Auth.isDesigner) return;
        this.close();
        App.openApp("designer");
      });
      // 디자이너 지정 관리(슈퍼)
      $("btn-open-designers") && $("btn-open-designers").addEventListener("click", () => {
        if (!Auth.isSuper) return;
        Designers.open();
      });
      // 기능·메뉴 관장 / AI 설정 / 코드맵 (슈퍼)
      $("btn-open-features") && $("btn-open-features").addEventListener("click", () => { if (Auth.isSuper && typeof AdminPanels !== "undefined") AdminPanels.openFeatures(); });
      $("btn-open-ai") && $("btn-open-ai").addEventListener("click", () => { if (Auth.isSuper && typeof AdminPanels !== "undefined") AdminPanels.openAI(); });
      $("btn-open-codemap") && $("btn-open-codemap").addEventListener("click", () => { if (Auth.isSuper && typeof AdminPanels !== "undefined") AdminPanels.openCodemap(); });
      // 설정 패널 내 로그아웃
      $("btn-settings-signout") && $("btn-settings-signout").addEventListener("click", () => {
        Auth.signOut();
        this.render();
      });
      // topbar "뷰어로" 버튼 → 편집 모드 종료
      $("btn-exit-edit") && $("btn-exit-edit").addEventListener("click", () => App.exitEdit());
    },

    open() {
      const m = document.getElementById("settings-modal");
      if (!m) return;
      this._isOpen = true;
      this.render();
      m.classList.remove("hidden");
      requestAnimationFrame(() => m.classList.add("on"));
      // GIS 버튼이 아직 렌더 안됐으면 렌더 시도
      if (Auth._gsiInited) Auth._renderButtons();
      else Auth._initGsi();
    },

    close() {
      const m = document.getElementById("settings-modal");
      if (!m) return;
      this._isOpen = false;
      m.classList.remove("on");
      setTimeout(() => m.classList.add("hidden"), 200);
    },

    /** 로그인 상태/권한에 따라 설정 패널 내용 토글 */
    render() {
      const $ = (id) => document.getElementById(id);
      const out = $("settings-loggedout");
      const inn = $("settings-loggedin");
      if (Auth.user) {
        // 로그인됨
        out && out.classList.add("hidden");
        inn && inn.classList.remove("hidden");
        $("settings-name") && ($("settings-name").textContent = Auth.user.name || Auth.user.email);
        $("settings-email") && ($("settings-email").textContent = Auth.user.email || "");
        const roleEl = $("settings-role");
        if (roleEl) {
          roleEl.textContent = Auth.role === "super" ? "슈퍼관리자" : Auth.role === "designer" ? "디자이너" : "뷰어";
          roleEl.className = "user-role role-" + Auth.role;
        }
        const av = $("settings-avatar");
        if (av) { if (Auth.user.picture) { av.src = Auth.user.picture; av.style.display = ""; } else av.style.display = "none"; }
        // 권한별 액션
        $("settings-designer-actions") && $("settings-designer-actions").classList.toggle("hidden", !Auth.isDesigner);
        $("settings-viewer-note")      && $("settings-viewer-note").classList.toggle("hidden", Auth.isDesigner);
        $("settings-super-actions")    && $("settings-super-actions").classList.toggle("hidden", !Auth.isSuper);
      } else {
        // 미로그인 — 구글 로그인 안내
        out && out.classList.remove("hidden");
        inn && inn.classList.add("hidden");
        // 클라이언트 ID 미설정 안내
        const noclient = $("settings-noclient");
        if (noclient) noclient.classList.toggle("hidden", !!Auth.clientId);
        if (Auth._gsiInited) Auth._renderButtons();
      }
    }
  };

  /* ══════════════════════════════════════════
     DESIGNERS — 디자이너 지정 관리 (슈퍼관리자 전용)
  ══════════════════════════════════════════ */
  const Designers = {
    _tab: "designers",
    _reqStatus: "pending",
    _reqCache: [],
    init() {
      const $ = (id) => document.getElementById(id);
      $("designers-close") && $("designers-close").addEventListener("click", () => this.close());
      const bd = document.querySelector('#designers-modal .admin-gate-backdrop');
      bd && bd.addEventListener("click", () => this.close());
      $("designer-add-btn") && $("designer-add-btn").addEventListener("click", () => this.add());
      const inp = $("designer-email-input");
      if (inp) inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); this.add(); } });
      // 탭 전환
      $("adm-tab-designers") && $("adm-tab-designers").addEventListener("click", () => this.switchTab("designers"));
      $("adm-tab-requests") && $("adm-tab-requests").addEventListener("click", () => this.switchTab("requests"));
      $("adm-tab-domains") && $("adm-tab-domains").addEventListener("click", () => this.switchTab("domains"));
      $("adm-tab-members") && $("adm-tab-members").addEventListener("click", () => this.switchTab("members"));
      $("adm-tab-logs") && $("adm-tab-logs").addEventListener("click", () => this.switchTab("logs"));
      // 도메인 관리
      $("domain-add-btn") && $("domain-add-btn").addEventListener("click", () => this.addDomain());
      const dinp = $("domain-input");
      if (dinp) dinp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); this.addDomain(); } });
      // 멤버
      $("members-refresh") && $("members-refresh").addEventListener("click", () => this.loadMembers());
      // 사전 등록(초대)
      $("invite-add-btn") && $("invite-add-btn").addEventListener("click", () => this.addInvite());
      const iinp = $("invite-email-input");
      if (iinp) iinp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); this.addInvite(); } });
      // 로그 도구
      $("log-refresh") && $("log-refresh").addEventListener("click", () => this.loadLogs(true));
      $("log-more") && $("log-more").addEventListener("click", () => this.loadLogs(false));
      $("log-purge") && $("log-purge").addEventListener("click", () => this.purgeLogs());
      const _ls = $("log-search");
      if (_ls) _ls.addEventListener("input", () => { clearTimeout(this._logT); this._logT = setTimeout(() => this.loadLogs(true), 280); });
      const _lf = $("log-action-filter");
      if (_lf) _lf.addEventListener("change", () => this.loadLogs(true));
      // 상태 필터
      document.querySelectorAll("#adm-panel-requests .adm-filter-item").forEach((b) => {
        b.addEventListener("click", () => {
          this._reqStatus = b.dataset.status;
          document.querySelectorAll("#adm-panel-requests .adm-filter-item").forEach((x) => x.classList.toggle("active", x === b));
          this.renderRequests();
        });
      });
    },
    switchTab(tab) {
      this._tab = tab;
      const tabs = { designers: "adm-tab-designers", requests: "adm-tab-requests", domains: "adm-tab-domains", members: "adm-tab-members", logs: "adm-tab-logs" };
      const panels = { designers: "adm-panel-designers", requests: "adm-panel-requests", domains: "adm-panel-domains", members: "adm-panel-members", logs: "adm-panel-logs" };
      Object.keys(tabs).forEach((k) => {
        const tEl = document.getElementById(tabs[k]);
        const pEl = document.getElementById(panels[k]);
        if (tEl) tEl.classList.toggle("active", k === tab);
        if (pEl) pEl.classList.toggle("hidden", k !== tab);
      });
      if (tab === "requests") this.loadRequests();
      if (tab === "domains") this.loadDomains();
      if (tab === "members") this.loadMembers();
      if (tab === "logs") { this.loadLogActions(); this.loadLogs(true); }
    },

    /* ── 회사 도메인(프로젝트별 허용) 관리 ── */
    async _fillProjectSelect() {
      const sel = document.getElementById("domain-project-select");
      if (!sel) return;
      const cur = sel.value || "*";
      let projects = [];
      try {
        const r = await fetch("/api/projects", { headers: Auth.headers() });
        const j = await r.json();
        projects = j.data || j.results || j || [];
      } catch (e) {}
      sel.innerHTML = '<option value="*">전체 공통 (모든 프로젝트)</option>';
      (projects || []).forEach((p) => {
        const o = document.createElement("option");
        o.value = p.id; o.textContent = p.name || p.id;
        sel.appendChild(o);
      });
      sel.value = cur;
    },
    async loadDomains() {
      await this._fillProjectSelect();
      const listEl = document.getElementById("domains-list");
      if (!listEl) return;
      listEl.innerHTML = '<div class="designers-loading">불러오는 중...</div>';
      try {
        const r = await fetch("/api/allowed-domains", { headers: Auth.headers() });
        if (!r.ok) throw new Error("forbidden");
        const { data } = await r.json();
        if (!data || !data.length) {
          listEl.innerHTML = '<div class="designers-empty">등록된 회사 도메인이 없습니다. (개인 무료메일 제외 모든 회사메일 허용)</div>';
          return;
        }
        // 프로젝트 id→이름 매핑
        let pmap = {};
        try {
          const rp = await fetch("/api/projects", { headers: Auth.headers() });
          const jp = await rp.json();
          (jp.data || jp.results || jp || []).forEach((p) => { pmap[p.id] = p.name || p.id; });
        } catch (e) {}
        listEl.innerHTML = "";
        data.forEach((d) => {
          const scope = d.project_id === "*" ? "전체 공통" : ("프로젝트: " + (pmap[d.project_id] || d.project_id));
          const row = document.createElement("div");
          row.className = "domain-row";
          row.innerHTML = `<span class="domain-name">@${d.domain}</span>
            <span class="domain-scope">${scope}</span>
            <button class="designer-del" data-id="${encodeURIComponent(d.id)}" title="삭제">✕</button>`;
          row.querySelector(".designer-del").addEventListener("click", () => this.removeDomain(d.id));
          listEl.appendChild(row);
        });
      } catch (e) {
        listEl.innerHTML = '<div class="designers-empty">목록을 불러올 수 없습니다(권한 필요).</div>';
      }
    },
    async addDomain() {
      const inp = document.getElementById("domain-input");
      const sel = document.getElementById("domain-project-select");
      const err = document.getElementById("domain-add-error");
      err.classList.add("hidden");
      const domain = (inp.value || "").trim().toLowerCase().replace(/^@/, "");
      const projectId = sel ? (sel.value || "*") : "*";
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) { err.textContent = "올바른 도메인을 입력하세요. (예: company.com)"; err.classList.remove("hidden"); return; }
      try {
        const r = await fetch("/api/allowed-domains", { method: "POST", headers: Auth.headers(), body: JSON.stringify({ domain, project_id: projectId }) });
        const j = await r.json();
        if (!r.ok) { err.textContent = j.error || "추가 실패"; err.classList.remove("hidden"); return; }
        inp.value = "";
        await this.loadDomains();
      } catch (e) { err.textContent = "네트워크 오류"; err.classList.remove("hidden"); }
    },
    async removeDomain(id) {
      try {
        await fetch("/api/allowed-domains/" + encodeURIComponent(id), { method: "DELETE", headers: Auth.headers() });
        await this.loadDomains();
      } catch (e) {}
    },

    /* ── 가입 사용자(회사 이메일 자체가입) + 로그인 기록 ── */
    async loadMembers() {
      this.loadInvites();  // 사전 등록(초대) 목록도 함께 갱신
      const listEl = document.getElementById("members-list");
      if (!listEl) return;
      listEl.innerHTML = '<div class="designers-loading">불러오는 중...</div>';
      try {
        const r = await fetch("/api/local-users", { headers: Auth.headers() });
        if (!r.ok) throw new Error("forbidden");
        const { data } = await r.json();
        const totalEl = document.getElementById("members-total");
        if (totalEl) totalEl.textContent = (data ? data.length : 0) + "명";
        if (!data || !data.length) { listEl.innerHTML = '<div class="designers-empty">아직 회사 이메일로 가입한 사용자가 없습니다.</div>'; return; }
        const fmt = (ts) => { if (!ts) return "—"; const d = new Date(ts); return d.toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" }); };
        listEl.innerHTML = "";
        data.forEach((u) => {
          const row = document.createElement("div");
          row.className = "member-row";
          row.innerHTML = `<span class="mem-col-email" title="${u.email}">${u.email}</span>
            <span class="mem-col-name">${u.name || "—"}</span>
            <span class="mem-col-company" title="${u.company || ""}">${u.company || "—"}</span>
            <span class="mem-col-login">${fmt(u.last_login_at)}</span>
            <span class="mem-col-act"><button class="designer-del" title="가입 취소(삭제)">✕</button></span>`;
          row.querySelector(".designer-del").addEventListener("click", () => this.removeMember(u.email));
          listEl.appendChild(row);
        });
      } catch (e) {
        listEl.innerHTML = '<div class="designers-empty">목록을 불러올 수 없습니다(권한 필요).</div>';
      }
    },
    async removeMember(email) {
      if (typeof Prompt !== "undefined" && Prompt.confirm) {
        const ok = await Prompt.confirm("가입 취소", email + " 사용자의 가입을 취소(삭제)하시겠습니까?");
        if (!ok) return;
      }
      try {
        await fetch("/api/local-users/" + encodeURIComponent(email), { method: "DELETE", headers: Auth.headers() });
        await this.loadMembers();
      } catch (e) {}
    },

    /* ── 사전 등록(초대) 관리 ── */
    async loadInvites() {
      const listEl = document.getElementById("invites-list");
      if (!listEl) return;
      try {
        const r = await fetch("/api/invites", { headers: Auth.headers() });
        if (!r.ok) throw new Error("forbidden");
        const { data } = await r.json();
        if (!data || !data.length) { listEl.innerHTML = '<div class="invites-empty">사전 등록된 이메일이 없습니다.</div>'; return; }
        listEl.innerHTML = "";
        data.forEach((iv) => {
          const row = document.createElement("div");
          row.className = "invite-row" + (iv.used ? " used" : "");
          const roleLabel = iv.role === "designer" ? "디자이너" : "뷰어";
          const status = iv.used ? '<span class="invite-status used">가입완료</span>' : '<span class="invite-status pending">대기</span>';
          row.innerHTML = `<span class="invite-mail" title="${iv.email}">${iv.email}</span>
            <span class="invite-role-badge role-${iv.role}">${roleLabel}</span>
            ${status}
            <button class="designer-del" title="사전등록 삭제">✕</button>`;
          row.querySelector(".designer-del").addEventListener("click", () => this.removeInvite(iv.email));
          listEl.appendChild(row);
        });
      } catch (e) {
        listEl.innerHTML = '<div class="invites-empty">목록을 불러올 수 없습니다(권한 필요).</div>';
      }
    },
    async addInvite() {
      const inp = document.getElementById("invite-email-input");
      const sel = document.getElementById("invite-role-select");
      const err = document.getElementById("invite-add-error");
      if (err) err.classList.add("hidden");
      const email = (inp.value || "").trim().toLowerCase();
      const role = sel ? sel.value : "viewer";
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { if (err) { err.textContent = "올바른 이메일을 입력하세요."; err.classList.remove("hidden"); } return; }
      try {
        const r = await fetch("/api/invites", { method: "POST", headers: Auth.headers(), body: JSON.stringify({ email, role }) });
        const j = await r.json();
        if (!r.ok) { if (err) { err.textContent = j.error || "등록 실패"; err.classList.remove("hidden"); } return; }
        inp.value = "";
        if (j.already_registered && typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("이미 가입된 사용자입니다. 권한만 갱신됩니다.");
        await this.loadInvites();
      } catch (e) { if (err) { err.textContent = "네트워크 오류"; err.classList.remove("hidden"); } }
    },
    async removeInvite(email) {
      try {
        await fetch("/api/invites/" + encodeURIComponent(email), { method: "DELETE", headers: Auth.headers() });
        await this.loadInvites();
      } catch (e) {}
    },

    async open() {
      if (!Auth.isSuper) return;
      const sa = document.getElementById("super-admin-email");
      if (sa) sa.textContent = Auth.user ? Auth.user.email : (Auth.superAdmin || "designssir@gmail.com");
      document.getElementById("designers-modal").classList.remove("hidden");
      requestAnimationFrame(() => document.getElementById("designers-modal").classList.add("on"));
      this.switchTab(this._tab);
      await this.render();
      this.loadRequests(); // 배지 갱신용 선로딩
    },
    close() {
      const m = document.getElementById("designers-modal");
      m.classList.remove("on");
      setTimeout(() => m.classList.add("hidden"), 200);
    },
    async render() {
      const listEl = document.getElementById("designers-list");
      listEl.innerHTML = '<div class="designers-loading">불러오는 중...</div>';
      try {
        const r = await fetch("/api/designers", { headers: Auth.headers() });
        if (!r.ok) throw new Error("forbidden");
        const { data } = await r.json();
        if (!data || !data.length) { listEl.innerHTML = '<div class="designers-empty">지정된 디자이너가 없습니다.</div>'; return; }
        listEl.innerHTML = "";
        data.forEach((d) => {
          const row = document.createElement("div");
          row.className = "designer-row";
          row.innerHTML = `<span class="designer-email">${d.email}</span>
            <button class="designer-del" data-email="${encodeURIComponent(d.email)}" title="삭제">✕</button>`;
          row.querySelector(".designer-del").addEventListener("click", () => this.remove(d.email));
          listEl.appendChild(row);
        });
      } catch (e) {
        listEl.innerHTML = '<div class="designers-empty">목록을 불러올 수 없습니다(권한 필요).</div>';
      }
    },
    async add() {
      const inp = document.getElementById("designer-email-input");
      const err = document.getElementById("designer-add-error");
      err.classList.add("hidden");
      const email = (inp.value || "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { err.textContent = "올바른 이메일을 입력하세요."; err.classList.remove("hidden"); return; }
      try {
        const r = await fetch("/api/designers", { method: "POST", headers: Auth.headers(), body: JSON.stringify({ email }) });
        const j = await r.json();
        if (!r.ok) { err.textContent = j.error || "추가 실패"; err.classList.remove("hidden"); return; }
        inp.value = "";
        await this.render();
      } catch (e) { err.textContent = "네트워크 오류"; err.classList.remove("hidden"); }
    },
    async remove(email) {
      if (!confirm(email + " 의 디자이너 권한을 해제할까요?")) return;
      try {
        await fetch("/api/designers/" + encodeURIComponent(email), { method: "DELETE", headers: Auth.headers() });
        await this.render();
      } catch (e) {}
    },

    /* ── 사용 신청(access requests) 관리 ── */
    async loadRequests() {
      try {
        const r = await fetch("/api/access-requests", { headers: Auth.headers() });
        if (!r.ok) { this._reqCache = []; }
        else { const j = await r.json(); this._reqCache = (j && j.data) || []; }
      } catch (e) { this._reqCache = []; }
      this._updateCounts();
      if (this._tab === "requests") this.renderRequests();
    },
    _updateCounts() {
      const c = { pending: 0, approved: 0, rejected: 0, all: this._reqCache.length };
      this._reqCache.forEach((q) => { if (c[q.status] != null) c[q.status]++; });
      const set = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = n; };
      set("adm-cnt-pending", c.pending); set("adm-cnt-approved", c.approved);
      set("adm-cnt-rejected", c.rejected); set("adm-cnt-all", c.all);
      const badge = document.getElementById("adm-req-badge");
      if (badge) { badge.textContent = c.pending; badge.classList.toggle("hidden", c.pending === 0); }
    },
    _statusLabel(s) {
      return s === "approved" ? "승인됨" : s === "rejected" ? "거절됨" : "대기 중";
    },
    renderRequests() {
      const listEl = document.getElementById("adm-req-list");
      if (!listEl) return;
      const rows = this._reqStatus === "all"
        ? this._reqCache
        : this._reqCache.filter((q) => q.status === this._reqStatus);
      if (!rows.length) {
        listEl.innerHTML = '<div class="adm-req-empty"><i class="fa-regular fa-folder-open"></i><span>해당 상태의 신청이 없습니다.</span></div>';
        return;
      }
      listEl.innerHTML = "";
      rows.forEach((q) => {
        const row = document.createElement("div");
        row.className = "adm-req-row st-" + q.status;
        const initials = (q.name || q.email || "?").trim().charAt(0).toUpperCase();
        row.innerHTML = `
          <div class="adm-col-name">
            <span class="adm-avatar">${UI.escapeHtml(initials)}</span>
            <span class="adm-name-block">
              <span class="adm-name">${UI.escapeHtml(q.name || "(이름 없음)")}</span>
              <span class="adm-email">${UI.escapeHtml(q.email)}</span>
            </span>
          </div>
          <div class="adm-col-company">
            <span class="adm-company">${UI.escapeHtml(q.company || "—")}</span>
            <span class="adm-country">${UI.escapeHtml(q.country || "")}</span>
          </div>
          <div class="adm-col-contact">${UI.escapeHtml(q.phone || "—")}</div>
          <div class="adm-col-status"><span class="adm-badge ${q.status}">${this._statusLabel(q.status)}</span></div>
          <div class="adm-col-act"></div>
        `;
        const act = row.querySelector(".adm-col-act");
        if (q.status === "pending") {
          act.innerHTML = `<button class="adm-act-btn approve" title="승인"><i class="fa-solid fa-check"></i></button>
            <button class="adm-act-btn reject" title="거절"><i class="fa-solid fa-xmark"></i></button>`;
          act.querySelector(".approve").addEventListener("click", () => this.approve(q));
          act.querySelector(".reject").addEventListener("click", () => this.reject(q));
        } else if (q.status === "rejected") {
          act.innerHTML = `<button class="adm-act-btn approve" title="승인으로 변경"><i class="fa-solid fa-rotate-left"></i></button>`;
          act.querySelector(".approve").addEventListener("click", () => this.approve(q));
        } else {
          act.innerHTML = `<button class="adm-act-btn reject" title="권한 회수"><i class="fa-solid fa-ban"></i></button>`;
          act.querySelector(".reject").addEventListener("click", () => this.reject(q));
        }
        listEl.appendChild(row);
      });
    },
    async approve(q) {
      try {
        const r = await fetch("/api/access-requests/" + encodeURIComponent(q.id) + "/approve", { method: "POST", headers: Auth.headers() });
        if (!r.ok) { Prompt.toast("승인 실패"); return; }
        Prompt.toast(q.name + " 님을 디자이너로 승인했습니다");
        await this.loadRequests();
        await this.render();
      } catch (e) { Prompt.toast("네트워크 오류"); }
    },
    async reject(q) {
      if (!confirm((q.name || q.email) + " 의 신청을 거절/회수할까요?")) return;
      try {
        const r = await fetch("/api/access-requests/" + encodeURIComponent(q.id) + "/reject", { method: "POST", headers: Auth.headers() });
        if (!r.ok) { Prompt.toast("처리 실패"); return; }
        Prompt.toast("처리되었습니다");
        await this.loadRequests();
        await this.render();
      } catch (e) { Prompt.toast("네트워크 오류"); }
    },

    /* ── 활동 로그(슈퍼관리자 전용) ── */
    _logOffset: 0,
    _logActionLabel(a) {
      const m = {
        "auth.login": "로그인", "access.approve": "신청 승인", "access.reject": "신청 거절/회수",
        "project.create": "프로젝트 생성", "project.delete": "프로젝트 삭제",
        "deployment.create": "배포(저장)",
      };
      return m[a] || a;
    },
    _fmtTime(ts) {
      try {
        const d = new Date(ts);
        const p = (n) => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
      } catch (e) { return String(ts); }
    },
    async loadLogActions() {
      const sel = document.getElementById("log-action-filter");
      if (!sel) return;
      try {
        const r = await fetch("/api/activity-logs/actions", { headers: Auth.headers() });
        if (!r.ok) return;
        const { data } = await r.json();
        const cur = sel.value;
        sel.innerHTML = '<option value="">모든 액션</option>';
        (data || []).forEach((row) => {
          const o = document.createElement("option");
          o.value = row.action;
          o.textContent = `${this._logActionLabel(row.action)} (${row.n})`;
          sel.appendChild(o);
        });
        sel.value = cur;
      } catch (e) {}
    },
    async loadLogs(reset) {
      const listEl = document.getElementById("log-list");
      if (!listEl) return;
      if (reset) { this._logOffset = 0; listEl.innerHTML = '<div class="log-empty">불러오는 중…</div>'; }
      const q = (document.getElementById("log-search") || {}).value || "";
      const action = (document.getElementById("log-action-filter") || {}).value || "";
      const limit = 80;
      const params = new URLSearchParams({ limit: String(limit), offset: String(this._logOffset) });
      if (q) params.set("q", q);
      if (action) params.set("action", action);
      try {
        const r = await fetch("/api/activity-logs?" + params.toString(), { headers: Auth.headers() });
        if (!r.ok) { listEl.innerHTML = '<div class="log-empty">로그를 불러올 수 없습니다(권한 필요).</div>'; return; }
        const j = await r.json();
        const rows = j.data || [];
        const totalEl = document.getElementById("log-total");
        if (totalEl) totalEl.textContent = (j.total || 0) + "건";
        if (reset) listEl.innerHTML = "";
        if (!rows.length && reset) {
          listEl.innerHTML = '<div class="log-empty"><i class="fa-regular fa-folder-open"></i><span>기록이 없습니다.</span></div>';
        } else {
          rows.forEach((it) => listEl.appendChild(this._logRow(it)));
        }
        this._logOffset += rows.length;
        const moreWrap = document.getElementById("log-more-wrap");
        if (moreWrap) moreWrap.classList.toggle("hidden", this._logOffset >= (j.total || 0));
      } catch (e) {
        listEl.innerHTML = '<div class="log-empty">네트워크 오류</div>';
      }
    },
    _logRow(it) {
      const row = document.createElement("div");
      row.className = "log-row role-" + (it.actor_role || "guest");
      const actor = it.actor_email || "(게스트)";
      const target = [it.target_type, it.target_id].filter(Boolean).join(" · ") || "—";
      let detail = "";
      if (it.detail) { try { detail = JSON.stringify(JSON.parse(it.detail)); } catch (e) { detail = it.detail; } }
      row.innerHTML = `
        <span class="log-col-time">${UI.escapeHtml(this._fmtTime(it.ts))}</span>
        <span class="log-col-actor">
          <span class="log-role-badge ${UI.escapeHtml(it.actor_role || "guest")}">${UI.escapeHtml(it.actor_role || "guest")}</span>
          <span class="log-actor-email">${UI.escapeHtml(actor)}</span>
        </span>
        <span class="log-col-action"><span class="log-action-badge">${UI.escapeHtml(this._logActionLabel(it.action))}</span></span>
        <span class="log-col-target" title="${UI.escapeHtml(detail)}">${UI.escapeHtml(target)}</span>
        <span class="log-col-act"><button class="log-del-btn" title="이 기록 삭제"><i class="fa-solid fa-xmark"></i></button></span>
      `;
      row.querySelector(".log-del-btn").addEventListener("click", () => this.deleteLog(it.id, row));
      return row;
    },
    async deleteLog(id, rowEl) {
      try {
        const r = await fetch("/api/activity-logs/" + encodeURIComponent(id), { method: "DELETE", headers: Auth.headers() });
        if (r.ok && rowEl) rowEl.remove();
      } catch (e) {}
    },
    async purgeLogs() {
      if (!confirm("모든 활동 로그를 비울까요? (되돌릴 수 없습니다)")) return;
      try {
        const r = await fetch("/api/activity-logs?all=1", { method: "DELETE", headers: Auth.headers() });
        if (r.ok) { Prompt.toast("로그를 정리했습니다"); this.loadLogActions(); this.loadLogs(true); }
        else Prompt.toast("정리 실패");
      } catch (e) { Prompt.toast("네트워크 오류"); }
    }
  };

  /* ══════════════════════════════════════════
     PDF ANNO — 최소 PDF 주석(ezPDF) : 형광펜/사각형/자유선/텍스트메모
     주석은 State.annotations[]에 % 좌표(0~1000)로 저장, 페이지별 렌더.
  ══════════════════════════════════════════ */
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
    clearPage() {
      if (!State.annotations.some(a => (a.page || 1) === State.pdfPage)) return;
      if (typeof confirm === "function" && !confirm("현재 페이지의 모든 주석을 삭제할까요?")) return;
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
      try { if (typeof App !== "undefined" && App._autoSave) App._autoSave({}); } catch (e) {}
    }
  };

  /* ══════════════════════════════════════════
     PIN ACTION POP — 핀 작업 전용 팝업
     (디자이너가 핀 클릭 → 이동/수정·사진추가/삭제/360°보기)
  ══════════════════════════════════════════ */
  const PinActionPop = {
    _pinId: null,
    init() {
      const $ = (id) => document.getElementById(id);
      const el = $("pin-action-pop");
      if (!el) return;
      $("pap-close") && $("pap-close").addEventListener("click", () => this.close());
      const bd = el.querySelector(".pin-action-backdrop");
      bd && bd.addEventListener("click", () => this.close());
      $("pap-view") && $("pap-view").addEventListener("click", () => {
        const pin = this._pin(); if (!pin) return;
        this.close();
        if (App.pinHasContent(pin)) App.openPano(pin);
        else { App.focusPin(pin, false); if (typeof Inspector !== "undefined") Inspector.showPin(pin); }
      });
      $("pap-move") && $("pap-move").addEventListener("click", () => {
        const pin = this._pin(); if (!pin) return;
        State.pinEditUnlocked = pin.id;
        this.close();
        UI.renderPinsOnMap();
        const m = document.querySelector('.pin-marker[data-id="' + pin.id + '"]');
        if (m) m.classList.add("edit-unlocked");
        Prompt.toast && Prompt.toast("🔓 '" + (pin.label || ("#" + (pin.page||1))) + "' 이동 잠금 해제 — 도면에서 핀을 드래그하세요");
      });
      $("pap-edit") && $("pap-edit").addEventListener("click", () => {
        const pin = this._pin(); if (!pin) return;
        State.pinEditUnlocked = pin.id;
        this.close();
        App.editPin(pin.id);
      });
      $("pap-del") && $("pap-del").addEventListener("click", () => {
        const pin = this._pin(); if (!pin) return;
        this.close();
        App.deletePin(pin.id);
      });
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !el.classList.contains("hidden")) this.close();
      });
    },
    _pin() { return (State.pins || []).find(p => p.id === this._pinId) || null; },
    open(pinId) {
      const el = document.getElementById("pin-action-pop");
      if (!el) return;
      const pin = (State.pins || []).find(p => p.id === pinId);
      if (!pin) return;
      this._pinId = pinId;
      // 페이지 기준 번호 계산
      const page = pin.page || 1;
      const samePage = (State.pins || []).filter(p => (p.page || 1) === page);
      const no = samePage.indexOf(pin) + 1;
      const hasContent = App.pinHasContent(pin);
      const $ = (id) => document.getElementById(id);
      $("pap-no").textContent = "#" + (no > 0 ? no : "?");
      $("pap-title").textContent = pin.label && pin.label.trim() ? pin.label : ("포인트 " + no);
      const mediaTxt = hasContent ? "360° 미디어 있음" : "미디어 없음";
      const addrTxt = (pin.label && pin.label.trim()) ? pin.label : "위치명 없음";
      $("pap-meta").textContent = addrTxt + " · " + mediaTxt + " · " + page + "페이지";
      // 360° 보기 버튼은 미디어 있을 때 강조
      const viewBtn = $("pap-view");
      if (viewBtn) viewBtn.classList.toggle("dim", !hasContent);
      el.classList.remove("hidden");
    },
    close() {
      const el = document.getElementById("pin-action-pop");
      if (el) el.classList.add("hidden");
      this._pinId = null;
    }
  };

  /* ══════════════════════════════════════════
     ADMIN PANELS — 최상위 관리자: 기능/메뉴 관장 · AI 설정 · 코드맵
  ══════════════════════════════════════════ */
  // 이 프로젝트에서 켜고 끌 수 있는 기능 정의(키 = app_settings.features 의 키)
  const FEATURE_DEFS = [
    { key: "annotations", label: "PDF 주석(형광펜·도형·메모)", desc: "도면 위 주석 도구 모음" },
    { key: "zones",       label: "영역/구역 지정",            desc: "사각형·원·다각형 구역 그리기" },
    { key: "pin360",      label: "360° 파노라마 핀",          desc: "핀 클릭 시 360 뷰어 열기" },
    { key: "fls3d",       label: "3D 포인트 클라우드(FLS)",   desc: "FLS/E57/LAS 첨부·듀얼뷰" },
    { key: "ai",          label: "AI 도우미",                 desc: "에러·사용 가이드 LLM(키 설정 시)" },
    { key: "timelapse",   label: "타임랩스 비교",             desc: "동일 위치 시점 비교" },
    { key: "export",      label: "내보내기/배포",             desc: "JSON 내보내기·뷰어 배포" }
  ];

  const AdminPanels = {
    _features: {},           // 현재 적용된 기능 토글 상태
    _featScope: "*",

    /** 앱 시작 시 한 번 호출: 현재 적용 기능을 불러와 본문에 반영 */
    async applyFeaturesToUI() {
      try {
        const r = await fetch("/api/app-settings?scope=*&key=features", { headers: Auth.headers() });
        if (!r.ok) return;
        const j = await r.json();
        this._features = j.value || {};
      } catch (e) { this._features = {}; }
      this._reflect();
    },
    /** 기능 키가 켜져 있는지(미설정=기본 ON) */
    isEnabled(key) {
      const v = this._features ? this._features[key] : undefined;
      return v === undefined ? true : !!v;
    },
    /** body 클래스로 기능 on/off 표시 → CSS가 해당 메뉴/버튼 숨김 */
    _reflect() {
      FEATURE_DEFS.forEach((f) => {
        document.body.classList.toggle("feat-off-" + f.key, !this.isEnabled(f.key));
      });
    },

    /* ── 기능·메뉴 관장 모달 ── */
    async openFeatures() {
      const m = document.getElementById("features-modal");
      if (!m) return;
      if (typeof Log !== "undefined") Log.push("settings.open", "features");
      await this._fillFeatScope();
      await this._loadFeatures();
      m.classList.remove("hidden"); requestAnimationFrame(() => m.classList.add("on"));
    },
    closeFeatures() { const m = document.getElementById("features-modal"); if (m) { m.classList.remove("on"); setTimeout(() => m.classList.add("hidden"), 180); } },
    async _fillFeatScope() {
      const sel = document.getElementById("feat-scope-select");
      if (!sel) return;
      const cur = sel.value || "*";
      let projects = [];
      try { const r = await fetch("/api/projects", { headers: Auth.headers() }); const j = await r.json(); projects = j.data || j.results || j || []; } catch (e) {}
      sel.innerHTML = '<option value="*">전체 공통(모든 프로젝트)</option>';
      (projects || []).forEach((p) => { const o = document.createElement("option"); o.value = p.id; o.textContent = p.name || p.id; sel.appendChild(o); });
      sel.value = cur;
      if (!sel._bound) { sel._bound = true; sel.addEventListener("change", () => { this._featScope = sel.value || "*"; this._loadFeatures(); }); }
      this._featScope = sel.value || "*";
    },
    async _loadFeatures() {
      const listEl = document.getElementById("features-list");
      if (!listEl) return;
      let cur = {};
      try { const r = await fetch("/api/app-settings?scope=" + encodeURIComponent(this._featScope) + "&key=features", { headers: Auth.headers() }); const j = await r.json(); cur = j.value || {}; } catch (e) {}
      listEl.innerHTML = "";
      FEATURE_DEFS.forEach((f) => {
        const on = cur[f.key] === undefined ? true : !!cur[f.key];
        const row = document.createElement("label");
        row.className = "feature-row";
        row.innerHTML = `<span class="feature-meta"><b>${f.label}</b><span>${f.desc}</span></span>
          <input type="checkbox" class="feature-toggle" data-key="${f.key}" ${on ? "checked" : ""} />`;
        listEl.appendChild(row);
      });
    },
    async saveFeatures() {
      const listEl = document.getElementById("features-list");
      const note = document.getElementById("features-save-note");
      const value = {};
      listEl.querySelectorAll(".feature-toggle").forEach((c) => { value[c.dataset.key] = c.checked; });
      try {
        const r = await fetch("/api/app-settings", { method: "PUT", headers: Auth.headers(), body: JSON.stringify({ scope: this._featScope, key: "features", value }) });
        if (!r.ok) throw new Error("fail");
        if (note) { note.textContent = "✅ 저장되었습니다. 화면에 즉시 반영됩니다."; note.className = "features-save-note ok"; }
        // 전체 공통 저장 시 현재 화면에도 즉시 반영
        if (this._featScope === "*") { this._features = value; this._reflect(); }
      } catch (e) { if (note) { note.textContent = "저장 실패(권한 필요)"; note.className = "features-save-note err"; } }
    },

    /* ── AI 설정 모달 ── */
    async openAI() {
      const m = document.getElementById("ai-modal");
      if (!m) return;
      const statusEl = document.getElementById("ai-status-line");
      try {
        const r = await fetch("/api/ai/config", { headers: Auth.headers() });
        const j = await r.json();
        if (statusEl) { statusEl.textContent = j.enabled ? "🟢 활성화됨 (API 키 설정됨)" : "🔴 비활성 — API 키(AI_API_KEY) 미설정"; statusEl.className = "ai-status-line " + (j.enabled ? "on" : "off"); }
        const bu = document.getElementById("ai-base-url"); if (bu) bu.value = j.base_url || "";
        const md = document.getElementById("ai-model"); if (md) md.value = j.model || "";
      } catch (e) { if (statusEl) statusEl.textContent = "상태를 불러올 수 없습니다."; }
      // 저장된 base_url/model(app_settings) 우선 표시
      try { const r2 = await fetch("/api/app-settings?scope=*&key=ai", { headers: Auth.headers() }); const j2 = await r2.json(); if (j2.value && j2.value.base_url) document.getElementById("ai-base-url").value = j2.value.base_url; if (j2.value && j2.value.model) document.getElementById("ai-model").value = j2.value.model; } catch (e) {}
      m.classList.remove("hidden"); requestAnimationFrame(() => m.classList.add("on"));
    },
    closeAI() { const m = document.getElementById("ai-modal"); if (m) { m.classList.remove("on"); setTimeout(() => m.classList.add("hidden"), 180); } },
    async saveAI() {
      const note = document.getElementById("ai-save-note");
      const value = { base_url: (document.getElementById("ai-base-url").value || "").trim(), model: (document.getElementById("ai-model").value || "").trim() };
      try {
        const r = await fetch("/api/app-settings", { method: "PUT", headers: Auth.headers(), body: JSON.stringify({ scope: "*", key: "ai", value }) });
        if (!r.ok) throw new Error("fail");
        if (note) { note.textContent = "✅ Base URL·모델 저장됨. (키는 wrangler secret으로 별도 설정)"; note.className = "features-save-note ok"; }
      } catch (e) { if (note) { note.textContent = "저장 실패(권한 필요)"; note.className = "features-save-note err"; } }
    },
    async testAI() {
      const note = document.getElementById("ai-save-note");
      if (note) { note.textContent = "연결 테스트 중…"; note.className = "features-save-note"; }
      try {
        const r = await fetch("/api/ai/chat", { method: "POST", headers: Auth.headers(), body: JSON.stringify({ messages: [{ role: "user", content: "연결 테스트입니다. OK라고만 답해주세요." }], max_tokens: 16 }) });
        const j = await r.json();
        if (r.ok) { if (note) { note.textContent = "✅ 연결 성공: " + (j.content || "(응답)"); note.className = "features-save-note ok"; } }
        else { if (note) { note.textContent = "⚠️ " + (j.error || "실패") + (j.hint ? " — " + j.hint : ""); note.className = "features-save-note err"; } }
      } catch (e) { if (note) { note.textContent = "네트워크 오류"; note.className = "features-save-note err"; } }
    },

    /* ── 코드 구조 · 파일 설명 대시보드 ── */
    openCodemap() {
      const m = document.getElementById("codemap-modal");
      if (!m) return;
      this._renderCodemap("");
      const s = document.getElementById("codemap-search");
      if (s && !s._bound) { s._bound = true; s.addEventListener("input", () => this._renderCodemap(s.value || "")); }
      m.classList.remove("hidden"); requestAnimationFrame(() => m.classList.add("on"));
    },
    closeCodemap() { const m = document.getElementById("codemap-modal"); if (m) { m.classList.remove("on"); setTimeout(() => m.classList.add("hidden"), 180); } },
    _renderCodemap(filter) {
      const el = document.getElementById("codemap-tree");
      if (!el) return;
      const f = (filter || "").toLowerCase();
      el.innerHTML = "";
      CODE_MAP.forEach((grp) => {
        const items = grp.items.filter((it) => !f || (it.path + " " + it.desc + " " + (it.detail || "")).toLowerCase().includes(f));
        if (!items.length) return;
        const g = document.createElement("div");
        g.className = "codemap-group";
        g.innerHTML = `<div class="codemap-group-h">${grp.group}</div>`;
        items.forEach((it) => {
          const row = document.createElement("div");
          row.className = "codemap-file";
          row.innerHTML = `<div class="codemap-file-h"><code>${it.path}</code><span class="codemap-badge">${it.kind}</span></div>
            <div class="codemap-file-desc">${it.desc}</div>${it.detail ? `<div class="codemap-file-detail">${it.detail}</div>` : ""}`;
          g.appendChild(row);
        });
        el.appendChild(g);
      });
      if (!el.children.length) el.innerHTML = '<div class="invites-empty">검색 결과가 없습니다.</div>';
    },

    init() {
      const $ = (id) => document.getElementById(id);
      $("features-save") && $("features-save").addEventListener("click", () => this.saveFeatures());
      $("features-close") && $("features-close").addEventListener("click", () => this.closeFeatures());
      $("ai-save") && $("ai-save").addEventListener("click", () => this.saveAI());
      $("ai-test") && $("ai-test").addEventListener("click", () => this.testAI());
      $("ai-close") && $("ai-close").addEventListener("click", () => this.closeAI());
      $("codemap-close") && $("codemap-close").addEventListener("click", () => this.closeCodemap());
      document.querySelectorAll('.admin-gate-backdrop[data-close]').forEach((bd) => {
        const which = bd.getAttribute("data-close");
        if (which === "features") bd.addEventListener("click", () => this.closeFeatures());
        if (which === "ai") bd.addEventListener("click", () => this.closeAI());
        if (which === "codemap") bd.addEventListener("click", () => this.closeCodemap());
      });
    }
  };

  /* 코드 구조 설명 데이터 — 관리자 대시보드용(파일별 기능 설명) */
  const CODE_MAP = [
    { group: "🖥️ 서버 / API (Hono on Cloudflare Workers)", items: [
      { path: "src/index.tsx", kind: "서버", desc: "모든 백엔드 API·SSR 진입점. 인증·프로젝트·핀·배포·도메인·초대·설정·AI 라우트를 한 파일에 정의.", detail: "주요: /api/auth/me, /api/projects, /api/pins, /api/deploy, /api/signup/*, /api/allowed-domains, /api/invites, /api/app-settings, /api/ai/*" },
      { path: "src/renderer.tsx", kind: "서버", desc: "Hono JSX 렌더러(HTML 셸 구성)." }
    ]},
    { group: "🎨 클라이언트 (public/)", items: [
      { path: "public/index.html", kind: "마크업", desc: "앱 전체 화면 구조 — 상단바·사이드바·맵 뷰포트·각종 모달(로그인/가입/관리자/설정/기능/AI/코드맵)." },
      { path: "public/js/main.js", kind: "로직", desc: "클라이언트 전체 로직. 모듈 집합으로 구성.", detail: "App(부트), MapCtrl(줌·팬·핀치), PanoViewer(360), PDF(렌더), PdfAnno(주석), Zones(구역), Pins/PinGrid/PinActionPop(핀), Auth/CompanyAuth(인증·가입), Designers(권한·도메인·멤버·초대·로그), Settings/AdminPanels(설정·기능관장·AI·코드맵), SyncQueue(오프라인 큐)." },
      { path: "public/css/style.css", kind: "스타일", desc: "전체 디자인·반응형(모바일 바텀시트·하단네비)·주석/관리자 UI 스타일." }
    ]},
    { group: "📱 PWA / 오프라인", items: [
      { path: "public/sw.js", kind: "서비스워커", desc: "앱 셸 캐시(stale-while-revalidate). /api/·/tables/ 는 절대 가로채지 않음 → 데이터는 항상 최신.", detail: "오프라인에서 화면 로딩 가능. PDF.js·Three.js CDN도 캐시." },
      { path: "public/manifest.webmanifest", kind: "PWA", desc: "홈 화면 설치용 매니페스트(이름·아이콘·표시 모드)." }
    ]},
    { group: "🗄️ 데이터 (Cloudflare D1 / R2)", items: [
      { path: "migrations/0001~0008_*.sql", kind: "DB", desc: "스키마 마이그레이션.", detail: "핀/배포(0001), 인증·프로젝트·구역(0002), 핀노트(0003), 구역(0004), 사용신청(0005), 활동로그(0006), 회사가입·도메인(0007), 초대·앱설정(0008)." }
    ]},
    { group: "⚙️ 빌드 / 운영", items: [
      { path: "vite.config.ts", kind: "빌드", desc: "Cloudflare Pages용 Vite 빌드 → dist/_worker.js 생성." },
      { path: "wrangler.jsonc", kind: "설정", desc: "CF Pages 설정(D1·R2 바인딩, nodejs_compat)." },
      { path: "ecosystem.config.cjs", kind: "운영", desc: "PM2 개발 서버(wrangler pages dev) 구동 설정." },
      { path: "CLAUDE.md / .claude/HANDOFF.md", kind: "문서", desc: "프로젝트 정체 카드 + 세션 인수인계(IRON RULE 포함)." }
    ]}
  ];

  /* ══════════════════════════════════════════
     COMPANY AUTH — 회사 이메일 자체가입 / 로그인
     (인증코드 → 비밀번호 → 로컬 세션 토큰)
  ══════════════════════════════════════════ */
  const CompanyAuth = {
    _email: null,
    init() {
      const $ = (id) => document.getElementById(id);
      const el = $("company-gate");
      if (!el) return;
      // 진입 버튼(로그인 게이트 안)
      $("login-gate-company") && $("login-gate-company").addEventListener("click", () => {
        const lg = $("login-gate"); if (lg) lg.classList.add("hidden");
        this.open();
      });
      $("company-gate-cancel") && $("company-gate-cancel").addEventListener("click", () => this.close());
      const bd = el.querySelector(".company-gate-backdrop");
      bd && bd.addEventListener("click", () => this.close());
      // 탭 전환
      $("company-tab-signup") && $("company-tab-signup").addEventListener("click", () => this._tab("signup"));
      $("company-tab-login") && $("company-tab-login").addEventListener("click", () => this._tab("login"));
      // 가입 흐름
      $("cg-send-code") && $("cg-send-code").addEventListener("click", () => this._sendCode());
      $("cg-resend") && $("cg-resend").addEventListener("click", () => this._sendCode(true));
      $("cg-change-email") && $("cg-change-email").addEventListener("click", () => this._backToEmail());
      $("cg-create") && $("cg-create").addEventListener("click", () => this._verify());
      // 로그인 흐름
      $("cg-login-btn") && $("cg-login-btn").addEventListener("click", () => this._login());
    },
    _projectId() {
      try { return (typeof Projects !== "undefined" && Projects.currentProject) ? Projects.currentProject.id : null; }
      catch { return null; }
    },
    _err(msg) {
      const e = document.getElementById("company-gate-error");
      if (!e) return;
      if (msg) { e.textContent = msg; e.classList.remove("hidden"); }
      else { e.textContent = ""; e.classList.add("hidden"); }
    },
    _tab(which) {
      const $ = (id) => document.getElementById(id);
      this._err(null);
      $("company-tab-signup").classList.toggle("active", which === "signup");
      $("company-tab-login").classList.toggle("active", which === "login");
      $("company-panel-signup").classList.toggle("hidden", which !== "signup");
      $("company-panel-login").classList.toggle("hidden", which !== "login");
    },
    async open() {
      const el = document.getElementById("company-gate");
      if (!el) return;
      this._err(null);
      this._backToEmail();
      this._tab("signup");
      el.classList.remove("hidden");
      // 가입 정책 안내 로드
      try {
        const pid = this._projectId();
        const r = await fetch("/api/signup/policy" + (pid ? ("?project_id=" + encodeURIComponent(pid)) : ""));
        const j = await r.json();
        const note = document.getElementById("cg-policy-note");
        if (note) {
          if (j.whitelist_enabled && j.allowed_domains && j.allowed_domains.length) {
            note.textContent = "허용 회사 도메인: " + j.allowed_domains.map(d => "@" + d).join(", ");
          } else {
            note.textContent = j.note || "회사 이메일(@회사도메인)로만 가입할 수 있습니다.";
          }
        }
      } catch (e) {}
    },
    close() {
      const el = document.getElementById("company-gate");
      if (el) el.classList.add("hidden");
    },
    _backToEmail() {
      const $ = (id) => document.getElementById(id);
      $("company-step-email") && $("company-step-email").classList.remove("hidden");
      $("company-step-verify") && $("company-step-verify").classList.add("hidden");
      const dc = $("cg-dev-code"); if (dc) { dc.classList.add("hidden"); dc.textContent = ""; }
    },
    async _sendCode(isResend) {
      const $ = (id) => document.getElementById(id);
      this._err(null);
      const email = ($("cg-email").value || "").trim().toLowerCase();
      if (!email) { this._err("회사 이메일 주소를 입력해 주세요."); return; }
      const btn = isResend ? $("cg-resend") : $("cg-send-code");
      const orig = btn ? btn.textContent : "";
      if (btn) { btn.disabled = true; btn.textContent = "전송 중..."; }
      try {
        const pid = this._projectId();
        const r = await fetch("/api/signup/send-code", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, project_id: pid || undefined })
        });
        const j = await r.json();
        if (!r.ok) { this._err(j.error || "코드 발송에 실패했습니다."); return; }
        this._email = email;
        this._invited = !!j.invited;
        $("cg-verify-email").textContent = email;
        $("company-step-email").classList.add("hidden");
        $("company-step-verify").classList.remove("hidden");
        // 사전 등록(초대) 계정 안내 + 회사명 기본값 채움
        const badge = $("cg-invited-badge");
        if (badge) badge.classList.toggle("hidden", !j.invited);
        if (j.invited && j.invite_company) { const cc = $("cg-company"); if (cc && !cc.value) cc.value = j.invite_company; }
        // dev-fallback 코드 표시(메일 미설정 시)
        const dc = $("cg-dev-code");
        if (j.dev_code) {
          dc.innerHTML = "📧 메일 발송 미설정 — 개발/시연용 인증코드: <b>" + j.dev_code + "</b>";
          dc.classList.remove("hidden");
          $("cg-code").value = j.dev_code;
        } else {
          dc.classList.add("hidden"); dc.textContent = "";
          const mins = j.valid_minutes || 60;
          Prompt.toast && Prompt.toast("📧 인증코드를 이메일로 발송했습니다. (" + mins + "분 이내 입력)");
        }
      } catch (e) {
        this._err("네트워크 오류로 코드 발송에 실패했습니다.");
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = orig; }
      }
    },
    async _verify() {
      const $ = (id) => document.getElementById(id);
      this._err(null);
      const code = ($("cg-code").value || "").trim();
      const pw = $("cg-pw").value || "";
      const pw2 = $("cg-pw2").value || "";
      const name = ($("cg-name").value || "").trim();
      const company = (($("cg-company") && $("cg-company").value) || "").trim();
      const dept = (($("cg-dept") && $("cg-dept").value) || "").trim();
      if (!/^\d{6}$/.test(code)) { this._err("인증코드 6자리를 입력해 주세요."); return; }
      if (pw.length < 8) { this._err("비밀번호는 8자 이상이어야 합니다."); return; }
      if (pw !== pw2) { this._err("비밀번호가 일치하지 않습니다."); return; }
      if (!name) { this._err("이름을 입력해 주세요."); return; }
      if (!dept) { this._err("부서/소속을 입력해 주세요."); return; }
      // 사전 등록(초대) 계정은 회사명 필수
      if (this._invited && !company) { this._err("회사명을 입력해 주세요."); return; }
      const btn = $("cg-create"); const orig = btn ? btn.textContent : "";
      if (btn) { btn.disabled = true; btn.textContent = "처리 중..."; }
      try {
        const pid = this._projectId();
        const r = await fetch("/api/signup/verify", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: this._email, code, password: pw, name, company, department: dept, project_id: pid || undefined })
        });
        const j = await r.json();
        if (!r.ok) { this._err(j.error || "가입에 실패했습니다."); return; }
        this._onAuthed(j.token, j.name || j.email);
      } catch (e) {
        this._err("네트워크 오류로 가입에 실패했습니다.");
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = orig; }
      }
    },
    async _login() {
      const $ = (id) => document.getElementById(id);
      this._err(null);
      const email = ($("cg-login-email").value || "").trim().toLowerCase();
      const pw = $("cg-login-pw").value || "";
      if (!email || !pw) { this._err("이메일과 비밀번호를 입력해 주세요."); return; }
      const btn = $("cg-login-btn"); const orig = btn ? btn.textContent : "";
      if (btn) { btn.disabled = true; btn.textContent = "로그인 중..."; }
      try {
        const r = await fetch("/api/signup/login", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password: pw })
        });
        const j = await r.json();
        if (!r.ok) { this._err(j.error || "로그인에 실패했습니다."); return; }
        this._onAuthed(j.token, j.name || j.email);
      } catch (e) {
        this._err("네트워크 오류로 로그인에 실패했습니다.");
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = orig; }
      }
    },
    _onAuthed(token, displayName) {
      // 로컬 세션 토큰 저장 → Auth 가 Bearer 로 사용 (idToken 슬롯 공용)
      try {
        sessionStorage.setItem("wm_id_token", token);
        localStorage.setItem("wm_local_token", token);
      } catch (e) {}
      if (typeof Auth !== "undefined") Auth.idToken = token;
      this.close();
      Prompt.toast && Prompt.toast("✅ " + displayName + " 님으로 로그인되었습니다.");
      // 인증 상태 갱신 후 뷰어로
      if (typeof Auth !== "undefined" && Auth.refresh) {
        Auth.refresh().then(() => { if (App.openApp) App.openApp("viewer"); }).catch(() => { if (App.openApp) App.openApp("viewer"); });
      } else {
        if (App.openApp) App.openApp("viewer");
      }
    }
  };

  /* ══════════════════════════════════════════
     PROMPT — 범용 입력 모달 (프로젝트/데크 생성)
  ══════════════════════════════════════════ */
  const Prompt = {
    _resolve: null,
    init() {
      const $ = (id) => document.getElementById(id);
      $("prompt-modal-ok") && $("prompt-modal-ok").addEventListener("click", () => this._submit());
      $("prompt-modal-cancel") && $("prompt-modal-cancel").addEventListener("click", () => this._close(null));
      const bd = document.querySelector('#prompt-modal .admin-gate-backdrop');
      bd && bd.addEventListener("click", () => this._close(null));
      const inp = $("prompt-modal-input");
      if (inp) inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); this._submit(); } if (e.key === "Escape") this._close(null); });
    },
    /** 가벼운 토스트 알림 (화면 하단 중앙, 자동 소멸) */
    toast(msg, ms) {
      let host = document.getElementById("wm-toast-host");
      if (!host) {
        host = document.createElement("div");
        host.id = "wm-toast-host";
        host.className = "wm-toast-host";
        document.body.appendChild(host);
      }
      const t = document.createElement("div");
      t.className = "wm-toast";
      t.textContent = msg;
      host.appendChild(t);
      requestAnimationFrame(() => t.classList.add("on"));
      setTimeout(() => { t.classList.remove("on"); setTimeout(() => t.remove(), 280); }, ms || 2200);
    },
    /** opts: { title, sub, placeholder, second } → Promise<string|{value,second}|null> */
    ask(opts) {
      return new Promise((resolve) => {
        this._resolve = resolve;
        document.getElementById("prompt-modal-title").textContent = opts.title || "입력";
        document.getElementById("prompt-modal-sub").textContent = opts.sub || "";
        const inp = document.getElementById("prompt-modal-input");
        inp.value = ""; inp.placeholder = opts.placeholder || "";
        const inp2 = document.getElementById("prompt-modal-input2");
        inp2.value = "";
        inp2.classList.toggle("hidden", !opts.second);
        document.getElementById("prompt-modal-error").classList.add("hidden");
        const m = document.getElementById("prompt-modal");
        m.classList.remove("hidden");
        requestAnimationFrame(() => m.classList.add("on"));
        setTimeout(() => inp.focus(), 60);
      });
    },
    _submit() {
      const inp = document.getElementById("prompt-modal-input");
      const inp2 = document.getElementById("prompt-modal-input2");
      const err = document.getElementById("prompt-modal-error");
      const val = (inp.value || "").trim();
      if (!val) { err.textContent = "값을 입력하세요."; err.classList.remove("hidden"); return; }
      const second = inp2.classList.contains("hidden") ? undefined : (inp2.value || "").trim();
      this._close({ value: val, second });
    },
    _close(result) {
      const m = document.getElementById("prompt-modal");
      m.classList.remove("on");
      setTimeout(() => m.classList.add("hidden"), 200);
      const r = this._resolve; this._resolve = null;
      if (r) r(result);
    }
  };

  /* ══════════════════════════════════════════
     PROJECTS — 프로젝트 + 데크(선박 층) 관리 (디자이너)
  ══════════════════════════════════════════ */
  const Projects = {
    list: [],
    decks: [],
    currentProject: null,
    currentDeck: null,

    init() {
      const $ = (id) => document.getElementById(id);
      $("btn-new-project") && $("btn-new-project").addEventListener("click", () => this.createProject());
      $("btn-delete-project") && $("btn-delete-project").addEventListener("click", () => this.deleteProject());
      $("btn-new-deck") && $("btn-new-deck").addEventListener("click", () => this.createDeck());
      // #1: 프로젝트 드롭다운 '이동(전환)' 기능 제거 — select 대신 현재 프로젝트명만 표시.
    },

    /** 디자이너 진입 시 호출 */
    async load() {
      try {
        const r = await fetch("/api/projects");
        const { data } = await r.json();
        this.list = data || [];
      } catch (e) { this.list = []; }
      this._renderSelect();
    },

    _renderSelect() {
      // #1: 드롭다운 전환 제거 → 현재 프로젝트명 라벨만 갱신.
      const cur = document.getElementById("project-current");
      const has = !!this.currentProject;
      if (cur) cur.textContent = has ? this.currentProject.name : "— 프로젝트 선택 —";
      const pa = document.getElementById("project-actions");
      if (pa) pa.classList.toggle("hidden", !has);
      const db = document.getElementById("decks-block");
      if (db) db.classList.toggle("hidden", !has);
    },

    async createProject() {
      if (!Auth.isDesigner) return;
      const res = await Prompt.ask({ title: "프로젝트 생성", sub: "새 프로젝트 이름을 입력하세요 (예: ○○호 검사)", placeholder: "프로젝트 이름" });
      if (!res) return;
      try {
        const r = await fetch("/api/projects", { method: "POST", headers: Auth.headers(), body: JSON.stringify({ name: res.value }) });
        const p = await r.json();
        if (!r.ok) { alert(p.error || "생성 실패(권한 필요)"); return; }
        await this.load();
        await this.selectProject(p.id);
      } catch (e) { alert("네트워크 오류"); }
    },

    async deleteProject() {
      if (!this.currentProject) return;
      if (!confirm(`'${this.currentProject.name}' 프로젝트와 모든 데크를 삭제할까요?`)) return;
      try {
        await fetch("/api/projects/" + this.currentProject.id, { method: "DELETE", headers: Auth.headers() });
        this.currentProject = null; this.currentDeck = null; this.decks = [];
        await this.load();
        this._renderDecks();
      } catch (e) {}
    },

    async selectProject(id) {
      this.currentProject = this.list.find((p) => p.id === id) || null;
      this._renderSelect();
      if (!this.currentProject) { this.decks = []; this._renderDecks(); return; }
      await this.loadDecks();
    },

    async loadDecks() {
      try {
        const r = await fetch("/api/projects/" + this.currentProject.id + "/decks");
        const { data } = await r.json();
        this.decks = data || [];
      } catch (e) { this.decks = []; }
      this._renderDecks();
    },

    /** #3: 구역 생성. 반환된 구역 객체를 돌려줌(없으면 강제 생성 흐름에서 사용). */
    async createDeck(opts) {
      opts = opts || {};
      if (!this.currentProject) { alert("먼저 프로젝트를 선택하세요."); return null; }
      let name = opts.name;
      if (!name) {
        const res = await Prompt.ask({ title: "구역 생성", sub: "구역 이름을 입력하세요 (예: Main Deck, Engine Room, No.1 Hold)", placeholder: "구역 이름" });
        if (!res) return null;
        name = res.value;
      }
      try {
        const r = await fetch("/api/projects/" + this.currentProject.id + "/decks", {
          method: "POST", headers: Auth.headers(),
          body: JSON.stringify({ name })
        });
        const d = await r.json();
        if (!r.ok) { alert(d.error || "생성 실패(권한 필요)"); return null; }
        await this.loadDecks();
        const created = this.decks.find((x) => x.id === d.id) || d;
        if (opts.select !== false) { this.currentDeck = created; this._renderDecks(); }
        return created;
      } catch (e) { alert("네트워크 오류"); return null; }
    },

    /** #3: 구역이 하나도 없으면 자동으로 기본 구역을 만들어 반환(도면 등록 전 보장). */
    async ensureDeck() {
      if (this.currentDeck) return this.currentDeck;
      if (this.decks.length) { this.currentDeck = this.decks[0]; this._renderDecks(); return this.currentDeck; }
      // 구역이 전혀 없음 → 강제 생성
      const created = await this.createDeck({ name: "구역 1", select: true });
      return created;
    },

    async deleteDeck(id, name) {
      if (!confirm(`구역 '${name}' 를 삭제할까요?`)) return;
      try {
        await fetch("/api/decks/" + id, { method: "DELETE", headers: Auth.headers() });
        if (this.currentDeck && this.currentDeck.id === id) this.currentDeck = null;
        await this.loadDecks();
      } catch (e) {}
    },

    /** 구역 선택 — 해당 구역에 연결된 도면(배포 스냅샷)이 있으면 불러옴 */
    async selectDeck(d) {
      this.currentDeck = d;
      this._renderDecks();
      Prompt.toast && Prompt.toast("🗂️ 구역 '" + d.name + "' 선택됨 — 도면을 등록하거나 포인트를 추가하세요");
      // 연결된 도면이 있으면 로드
      if (d.deployment_id && typeof App !== "undefined" && App.loadDeckDrawing) {
        await App.loadDeckDrawing(d.deployment_id);
      }
    },

    _renderDecks() {
      const listEl = document.getElementById("decks-list");
      const emptyEl = document.getElementById("decks-empty");
      if (!listEl) return;
      listEl.innerHTML = "";
      if (!this.decks.length) { emptyEl.classList.remove("hidden"); return; }
      emptyEl.classList.add("hidden");
      this.decks.forEach((d) => {
        const isActive = this.currentDeck && this.currentDeck.id === d.id;
        const row = document.createElement("div");
        row.className = "deck-row" + (isActive ? " active" : "");
        const hasDoc = !!d.deployment_id;
        // 트리 가이드(└) + 구역 아이콘 + 도면 등록 여부
        const dot = hasDoc
          ? '<span class="deck-hasdoc" title="도면 등록됨"><i class="fa-solid fa-file-lines"></i></span>'
          : '<span class="deck-nodoc" title="도면 미등록"><i class="fa-regular fa-folder-open"></i></span>';
        row.innerHTML = `<span class="deck-tree-guide">└</span><span class="deck-name">${dot}${this._esc(d.name)}</span>
          <button class="deck-del" title="삭제">✕</button>`;
        row.querySelector(".deck-name").addEventListener("click", () => this.selectDeck(d));
        row.querySelector(".deck-del").addEventListener("click", (e) => { e.stopPropagation(); this.deleteDeck(d.id, d.name); });
        listEl.appendChild(row);
        // ── 선택된 구역: 등록된 도면을 트리 하위로 표시(없으면 '도면 등록 필요') ──
        if (isActive) {
          const sub = document.createElement("div");
          sub.className = "deck-doc-sub";
          if (hasDoc) {
            const fname = (typeof State !== "undefined" && State.fileName) ? State.fileName : "등록 도면";
            sub.innerHTML = `<span class="deck-doc-line"><span class="deck-tree-guide sub">└─</span><i class="fa-solid fa-image"></i> ${this._esc(fname)}</span>`;
          } else {
            sub.innerHTML = `<span class="deck-doc-line empty"><span class="deck-tree-guide sub">└─</span>도면을 등록하세요 (아래 버튼)</span>`;
          }
          listEl.appendChild(sub);
        }
      });
    },

    _esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
  };

  /* ── 진입 ── */
  document.addEventListener("DOMContentLoaded", () => {
    App.init();

    // ── E2E 테스트 훅 (프로덕션 무해): 핀을 직접 주입해 UI 워크플로우 없이 검증 ──
    window.__wm = {
      State, App, AllPins, UI, MapCtrl, Auth, Settings, Designers, Projects, ProjectHub, Prompt, PanoViewer, Radar, PanoNav, Brand, Notes, TimeLapse, Compare, Zones, Inspector, PinGrid, SyncQueue, Cloud, PDF, FLS, PinActionPop, CompanyAuth, PdfAnno, AdminPanels,
      addPin(p) {
        const pin = Object.assign({ id: "t" + Date.now() + Math.random().toString(36).slice(2,6), x: 50, y: 50, page: 1, label: "Pin" }, p);
        State.pins.push(pin);
        UI.renderPinList(); UI.renderPinsOnMap();
        return pin.id;
      }
    };

    const params  = new URLSearchParams(location.search);
    const urlMode = params.get("mode");
    const depId   = params.get("d");
    if (urlMode === "viewer" || depId) {
      // 배포 링크(?mode=viewer / ?d=배포ID) — 특정 배포본 바로 뷰어 (허브 스킵)
      State.viewerLocked = true;
      App.openApp("viewer");
    } else if (urlMode === "designer") {
      // 설계자 직접 진입 — 로그인+디자이너 권한 필요, 통과 시 프로젝트 허브로
      Auth.requireDesigner(() => ProjectHub.open());
      ProjectHub.open();
    } else {
      // ── 첫 화면 = 프로젝트 선택 대시보드 (상용툴 모방) ──
      //   카드 클릭 → (디자이너)편집 / (그 외)뷰어. 디자이너는 +새 프로젝트.
      ProjectHub.open();
    }

    /* ── 360° 테스트 훅: ?demo360=<이미지URL> 로 파노라마 직접 오픈 ── */
    const demo = params.get("demo360");
    if (demo) {
      PanoViewer.loadMedia(decodeURIComponent(demo), "TEST PANORAMA");
    }
  });

})();
