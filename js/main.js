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
    placing:     false,
    pending:     null,      // { x, y }
    pendingFile: null,      // 선택된 360° 그림/영상 파일
    pendingIsVideo: false,
    pendingDocs: [],        // 첨부 문서 후보 [{tempId, file, name, size, kind, status, docId}]
    activePin:   null,
    zoom:        1,
    pan:         { x: 0, y: 0 },
    panDragging: false,
    panStart:    { mx: 0, my: 0, px: 0, py: 0 },
    viewerLocked: false,
    currentProjectId: null,
    currentProjectName: null,

    reset() {
      if (this.imageUrl) { URL.revokeObjectURL(this.imageUrl); this.imageUrl = null; }
      _revokeAllVideoBlobs(); // [B5] 영상 핀 blob URL 일괄 해제
      this.fileType = null; this.fileName = null;
      this.fileData = null; this.pdfDoc = null;
      this.pdfPage = 1; this.pdfPages = 0; this.pdfRotation = 0; this.viewerPages = null;
      this.pins = []; this.placing = false; this.pending = null;
      this.pendingFile = null; this.pendingIsVideo = false;
      this.pendingDocs = [];
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

    async load(arrayBuffer) {
      const lib = await this.ensureLib();
      const data = arrayBuffer.slice(0);
      // 1차: worker 로 빠르게 파싱
      if (this.useWorker) {
        try {
          const task = lib.getDocument({ data, disableWorker: false });
          return await task.promise;
        } catch (e) {
          // worker 로드/실행 실패 → 메인스레드 파싱으로 폴백 (안정성 우선)
          this.useWorker = false;
        }
      }
      const task = lib.getDocument({ data: arrayBuffer.slice(0), disableWorker: true });
      return await task.promise;
    },

    async renderPage(pdfDoc, pageNum, canvas, scale = 1.5, rotation = 0) {
      const page = await pdfDoc.getPage(pageNum);
      // 적응형 스케일: 너무 큰 캔버스는 렌더가 느리고 메모리를 많이 쓴다.
      // 캔버스 최대 변을 2400px 로 제한해 큰 도면도 빠르고 안정적으로 그린다.
      // 회전은 PDF.js 내장 getViewport({rotation}) 으로 처리 (페이지 자체 회전값과 합산).
      const rot = ((page.rotate || 0) + (rotation || 0)) % 360;
      const base = page.getViewport({ scale: 1, rotation: rot });
      const MAX_SIDE = 2400;
      const fit = MAX_SIDE / Math.max(base.width, base.height);
      const useScale = Math.min(scale, fit > 0 ? fit : scale);
      const vp   = page.getViewport({ scale: useScale, rotation: rot });
      canvas.width  = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      const ctx = canvas.getContext("2d", { alpha: false });
      const task = page.render({ canvasContext: ctx, viewport: vp });
      // worker 모드면 render().promise 가 정상 resolve 된다.
      // 폴백(disableWorker) 환경에서만 드물게 hang 될 수 있으므로,
      // worker 모드: 정상 await / 폴백 모드: 화면은 이미 그려졌으므로 비파괴 타임아웃 보호.
      if (this.useWorker) {
        await task.promise;
      } else {
        await Promise.race([
          task.promise.catch(() => {}),
          new Promise(res => setTimeout(res, 4000))
        ]);
      }
    },

    /** 전 페이지를 오프스크린 렌더 → JPEG dataURL 배열 (배포 스냅샷용) */
    async snapshotAllPages(pdfDoc, maxDim = 2000, quality = 0.75) {
      const out = [];
      for (let p = 1; p <= pdfDoc.numPages; p++) {
        const page = await pdfDoc.getPage(p);
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(maxDim / Math.max(base.width, base.height), 2);
        const vp = page.getViewport({ scale });
        const cv = document.createElement("canvas");
        cv.width = vp.width; cv.height = vp.height;
        await page.render({ canvasContext: cv.getContext("2d"), viewport: vp }).promise;
        out.push(cv.toDataURL("image/jpeg", quality));
      }
      return out;
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
        res = await fetch("tables/pano_images", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
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
      const res = await fetch("tables/pano_images/" + encodeURIComponent(id));
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
        res = await fetch("tables/pano_images", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
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
      const res = await fetch("tables/pano_images/" + encodeURIComponent(id));
      if (!res.ok) throw new Error("첨부 문서를 불러올 수 없습니다 (HTTP " + res.status + ")");
      const rec = await res.json();
      if (!rec.image_data) throw new Error("문서 데이터가 비어 있습니다");
      this._cache[id] = rec.image_data;
      return rec.image_data;
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
      // translate3d 로 GPU 레이어 승격 (체감 속도 향상)
      this.transform.style.transform =
        `translate3d(${x}px, ${y}px, 0) scale(${State.zoom})${rot}`;
      this._updateZoomLabel();
    },

    _updateZoomLabel() {
      const el = document.getElementById("zoom-level");
      if (el) el.textContent = Math.round(State.zoom * 100) + "%";
    },

    /** 도면 콘텐츠의 실제 픽셀 크기 (canvas 또는 image) */
    _contentSize() {
      const cv = document.getElementById("pdf-canvas");
      const img = document.getElementById("map-image");
      if (cv && !cv.classList.contains("hidden") && cv.width)
        return { w: cv.width, h: cv.height };
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
    text(id, val)  { this.$(id).textContent = val; },
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
        return;
      }
      empty.classList.add("hidden");
      badge.textContent = State.pins.length + " PINS";
      badge.classList.remove("hidden");
      if (State.mode === "designer") this.show("section-export");

      const totalPages = State.mode === "viewer"
        ? (State.viewerPages ? State.viewerPages.length : 1)
        : State.pdfPages;

      State.pins.forEach((pin, idx) => {
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

        if (State.mode === "designer") {
          item.innerHTML = `
            <div class="pin-num">${idx + 1}</div>
            <div class="pin-info">
              <div class="pin-name">${this.escapeHtml(pin.label)}${cloudTag}${metaIcons}</div>
              <div class="pin-coords">${pin.x.toFixed(1)}%, ${pin.y.toFixed(1)}%${pageTag}</div>
            </div>
            <button class="pin-del" data-id="${pin.id}" title="삭제">✕</button>`;
          item.querySelector(".pin-del").addEventListener("click", e => {
            e.stopPropagation();
            App.deletePin(pin.id);
          });
          // 디자이너 모드에서도 콘텐츠(미디어/노트/첨부)가 있는 핀은 리스트 클릭 시 이동 후 오픈
          item.addEventListener("click", () => App.focusPin(pin, App.pinHasContent(pin)));
        } else {
          item.innerHTML = `
            <div class="pin-num">${idx + 1}</div>
            <div class="pin-info">
              <div class="pin-name">${this.escapeHtml(pin.label)}${cloudTag}${metaIcons}</div>
              <div class="pin-coords">${pin.x.toFixed(1)}%, ${pin.y.toFixed(1)}%${pageTag}</div>
            </div>
            <span class="pin-arrow">▶</span>`;
          item.addEventListener("click", () => App.focusPin(pin, true));
        }
        list.appendChild(item);
      });
      if (typeof AllPins !== "undefined") { AllPins.syncButton(); if (AllPins.open) AllPins.render(); }
    },

    renderPinsOnMap(dropPinId) {
      const layer = this.$("pins-layer");
      layer.innerHTML = "";
      const curPage = State.pdfPage;
      State.pins.forEach((pin, idx) => {
        if ((pin.page || 1) !== curPage) return; // 현재 페이지 핀만
        const marker = document.createElement("div");
        marker.className = "pin-marker" + (pin.id === dropPinId ? " drop" : "")
          + (State.activePin === pin.id ? " focused" : "");
        marker.style.left = pin.x + "%";
        marker.style.top  = pin.y + "%";
        marker.dataset.id = pin.id;
        const hasContent = App.pinHasContent(pin);
        marker.innerHTML = `
          <div class="pin-marker-label">${this.escapeHtml(pin.label)}</div>
          ${hasContent ? '<div class="pin-pulse"></div>' : ''}
          <div class="pin-pin">
            <svg viewBox="0 0 34 45" xmlns="http://www.w3.org/2000/svg">
              <path class="pin-pin-fill" d="M17 1.5C9.27 1.5 3 7.77 3 15.5c0 8.9 11.2 23.3 13.3 26.04a2.1 2.1 0 0 0 3.4 0C22.8 38.8 31 26 31 15.5 31 7.77 24.73 1.5 17 1.5z"/>
              <circle class="pin-pin-hole" cx="17" cy="15.5" r="6.2"/>
            </svg>
            <span class="pin-pin-num">${idx + 1}</span>
          </div>`;
        marker.addEventListener("click", e => {
          e.stopPropagation();
          // 콘텐츠(360° 사진/영상/URL/노트/첨부)가 등록된 핀은 모드와 무관하게 클릭 즉시 오픈한다.
          // 디자이너 모드에서 아직 콘텐츠가 없는(작성 중) 핀만 편집(활성화)한다.
          if (App.pinHasContent(pin)) App.openPano(pin);
          else if (State.mode === "designer") App.setActivePin(pin.id);
          else App.openPano(pin); // 뷰어에서 미디어 없는 핀 → openPano가 안내 표시
        });
        layer.appendChild(marker);
      });
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
        const deckTxt = (p.deck_count != null) ? (p.deck_count + " decks") : "";
        const dateTxt = this._fmtDate(p.created_at);
        card.innerHTML =
          '<div class="hub-card-thumb"><span class="hub-card-thumb-ico">🚢</span></div>' +
          '<div class="hub-card-body">' +
            '<div class="hub-card-name">' + UI.escapeHtml(p.name) + '</div>' +
            '<div class="hub-card-meta">' +
              (deckTxt ? '<span class="hub-card-decks">' + deckTxt + '</span>' : '') +
              (dateTxt ? '<span class="hub-card-date">' + dateTxt + '</span>' : '') +
            '</div>' +
          '</div>' +
          (isDesigner
            ? '<div class="hub-card-actions">' +
                '<button class="hub-card-act hub-card-del" title="삭제" data-act="del">🗑</button>' +
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
    }
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
     APP
  ══════════════════════════════════════════ */
  const App = {

    init() {
      Brand.apply();
      this._bindHome();
      this._bindTopbar();
      this._bindSidebar();
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
      UI.toggle("section-place",     isDesigner);   // 위치 포인트 추가
      UI.toggle("section-export",    isDesigner);   // 뷰어로 배포
      UI.toggle("section-pin-form",  false);        // 핀 입력 폼 (항상 숨김으로 시작)
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
        UI.$("pin-count-badge").classList.add("hidden");
        UI.$("pins-layer").innerHTML = "";
        UI.$("pin-list").innerHTML = "";
        UI.$("pin-empty").classList.remove("hidden");
        UI.$("section-pin-form").classList.add("hidden");
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
      UI.$("btn-upload-drawing").addEventListener("click", () => UI.$("input-drawing").click());
      UI.$("input-drawing").addEventListener("change", e => {
        const f = e.target.files[0]; if (!f) return;
        e.target.value = "";
        this._loadDrawing(f);
      });

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
        UI.$("input-pin-imgname").value = f.name.replace(/\.[^.]+$/, "");
        this._updateConfirmEnabled();
      });

      // 핀 폼: 첨부 문서 선택 (PDF/Word 등 — 다중)
      UI.$("btn-pin-doc").addEventListener("click", () => UI.$("input-pin-doc").click());
      UI.$("input-pin-doc").addEventListener("change", e => {
        const files = Array.from(e.target.files || []);
        e.target.value = "";
        files.forEach(f => this._addPendingDoc(f));
      });

      UI.$("input-pin-url").addEventListener("input", () => this._updateConfirmEnabled());
      UI.$("input-pin-note").addEventListener("input", () => this._updateConfirmEnabled());
      UI.$("btn-confirm-pin").addEventListener("click", () => this._confirmPin());
      UI.$("btn-cancel-pin").addEventListener("click", () => this._resetPinForm(true));

      UI.$("btn-export-json").addEventListener("click", () => this._exportJson());
      UI.$("btn-deploy").addEventListener("click", () => this._deployToViewer());
      UI.$("btn-reload-deploy").addEventListener("click", () => this.loadLatestDeployment());
    },

    _togglePlacing() {
      State.placing = !State.placing;
      if (State.placing) {
        State.pending = null;
        this._resetPinForm(false);
        UI.hide("section-next-point");
      }
      UI.$("btn-place").classList.toggle("active", State.placing);
      UI.$("place-hint").classList.toggle("hidden", !State.placing);
      UI.$("crosshair-overlay").classList.toggle("hidden", !State.placing);
      UI.$("map-viewport").style.cursor = State.placing ? "crosshair" : "grab";
    },

    _updateConfirmEnabled() {
      const hasFile = !!State.pendingFile;
      const hasUrl  = !!UI.val("input-pin-url").trim();
      const hasNote = !!UI.val("input-pin-note").trim();
      const hasDoc  = State.pendingDocs.length > 0;
      // 360° 미디어가 없어도 노트나 첨부 문서만 있으면 저장 가능 (정보 포인트)
      UI.$("btn-confirm-pin").disabled = !(hasFile || hasUrl || hasNote || hasDoc);
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
      UI.disable("btn-confirm-pin");
      if (hideForm) UI.$("section-pin-form").classList.add("hidden");
    },

    /* ── Map ── */
    _bindMap() {
      const vp = UI.$("map-viewport");

      vp.addEventListener("wheel", e => { e.preventDefault(); MapCtrl.handleWheel(e); }, { passive: false });

      vp.addEventListener("mousedown", e => {
        if (State.placing) { this._handlePlaceClick(e); return; }
        MapCtrl.handlePanStart(e);
      });
      window.addEventListener("mousemove", e => MapCtrl.handlePanMove(e));
      window.addEventListener("mouseup",   () => MapCtrl.handlePanEnd());

      let lastTouch = null;
      vp.addEventListener("touchstart", e => {
        if (e.touches.length === 1) {
          if (State.placing) { this._handlePlaceTouch(e); return; }
          MapCtrl.cancelFly();
          lastTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        }
      }, { passive: false });
      vp.addEventListener("touchmove", e => {
        if (e.touches.length === 1 && lastTouch) {
          State.pan.x += e.touches[0].clientX - lastTouch.x;
          State.pan.y += e.touches[0].clientY - lastTouch.y;
          lastTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
          MapCtrl.applyTransform();
        }
        e.preventDefault();
      }, { passive: false });
      vp.addEventListener("touchend", () => { lastTouch = null; });

      // 더블클릭으로 클릭 지점 중심 줌인
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
      // 회전 (PDF.js 내장 getViewport({rotation}) 활용)
      bind("btn-rotate-cw",  () => this._rotatePdf(90));
      bind("btn-rotate-ccw", () => this._rotatePdf(-90));
      bind("rotate-level",   () => { State.pdfRotation = 0; this._rotatePdf(0); });
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
      this._resetPinForm(false);
      State.pending = pct; // resetPinForm이 지우므로 재설정

      const pp = UI.$("pending-pin");
      pp.style.left = pct.x + "%";
      pp.style.top  = pct.y + "%";
      pp.classList.remove("hidden");

      // 지정한 위치로 줌인 (플라이투) — 정확한 위치 확인
      MapCtrl.flyTo(pct.x, pct.y, Math.max(State.zoom, 2.2));

      UI.$("section-pin-form").classList.remove("hidden");
      UI.$("input-pin-label").focus();
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
      canvas.addEventListener("touchstart", e => {
        if (e.touches.length === 1) PanoViewer.onPointerDown(e.touches[0].clientX, e.touches[0].clientY);
      }, { passive: false });
      canvas.addEventListener("touchmove", e => {
        e.preventDefault();
        if (e.touches.length === 1) PanoViewer.onPointerMove(e.touches[0].clientX, e.touches[0].clientY);
      }, { passive: false });
      canvas.addEventListener("touchend", () => PanoViewer.onPointerUp());

      // 파노라마 컨트롤 버튼
      UI.$("btn-pano-rotate").addEventListener("click", e => {
        const on = PanoViewer.toggleAuto();
        e.currentTarget.classList.toggle("on", on);
      });
      UI.$("btn-pano-zoomin").addEventListener("click",  () => PanoViewer.setFov(-10));
      UI.$("btn-pano-zoomout").addEventListener("click", () => PanoViewer.setFov(10));
      UI.$("btn-pano-reset").addEventListener("click",   () => PanoViewer.resetView());
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
    async _loadDrawing(file) {
      State.reset();
      State.fileName = file.name;
      UI.text("file-name-label", file.name);
      UI.$("pin-count-badge").classList.add("hidden");
      UI.$("pins-layer").innerHTML = "";
      UI.$("pin-list").innerHTML = "";
      UI.$("pin-empty").classList.remove("hidden");
      UI.$("section-pin-form").classList.add("hidden");
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
        } catch (err) {
          UI.$("pdf-loading").classList.add("hidden");
          UI.$("pdf-error").classList.remove("hidden");
          UI.$("pdf-error-msg").textContent = "PDF 로드 실패: " + err.message;
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
        imgEl.onload = () => { this._showMapViewport(); };
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
      await PDF.renderPage(State.pdfDoc, State.pdfPage, canvas, 1.5, State.pdfRotation);
      UI.updatePdfPagination();
      State.pan = { x: 0, y: 0 }; State.zoom = 1;
      MapCtrl.applyTransform();
      UI.renderPinsOnMap();
      UI.renderPdfThumbs();
    },

    _showMapViewport() {
      State.pan  = { x: 0, y: 0 };
      State.zoom = 1;
      MapCtrl.applyTransform();
      UI.$("map-viewport").classList.remove("hidden");
      const nav = UI.$("nav-toolbar"); if (nav) nav.classList.remove("hidden");
      UI.renderPinsOnMap();
      UI.updatePdfPagination();
      UI.updateRotationLabel();
      UI.renderPdfThumbs();
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
      // 360° 미디어·노트·첨부 중 최소 하나는 있어야 저장
      if (!file && !url && !note && docs.length === 0) return;

      const btn    = UI.$("btn-confirm-pin");
      const status = UI.$("pin-upload-status");
      btn.disabled = true;
      btn.textContent = (file || docs.length) ? "☁ 업로드 중..." : "저장 중...";

      const pin = {
        id:    Date.now(),
        x:     State.pending.x,
        y:     State.pending.y,
        page:  State.pdfPage,
        label
      };
      if (note) pin.note = note;

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
          // 이미지: 1) 리사이즈 → 2) 클라우드 업로드 → 3) imageId 연결
          status.textContent = "이미지 최적화 중...";
          status.classList.remove("hidden", "error");
          const { dataURL, width, height } = await Cloud.resizeImage(file);
          const imgName = UI.val("input-pin-imgname").trim() || file.name.replace(/\.[^.]+$/, "");
          status.textContent = "☁ 클라우드 업로드 중... (" + (dataURL.length / 1024 / 1024).toFixed(1) + " MB)";
          const imageId = await Cloud.uploadImage(imgName, dataURL, width, height);
          pin.imageId   = imageId;
          pin.imageName = imgName;
          Cloud._cache[imageId] = dataURL; // 즉시 미리보기용 캐시
        } else if (url) {
          // URL 직접 입력 (이미지 또는 영상 자동 판별)
          pin.imageUrl = url;
          if (/\.(mp4|webm|mov)(\?|#|$)/i.test(url)) pin.isVideo = true;
        }

        // ── 첨부 문서 업로드 (PDF/Word 등) ──
        if (docs.length) {
          pin.attachments = [];
          for (let i = 0; i < docs.length; i++) {
            const d = docs[i];
            status.textContent = `📎 첨부 업로드 중... (${i + 1}/${docs.length}) ${d.name}`;
            status.classList.remove("hidden", "error");
            const dataURL = await Cloud.fileToDataURL(d.file);
            const docId   = await Cloud.uploadDoc(d.name, dataURL);
            pin.attachments.push({
              id: d.tempId, name: d.name, size: d.size,
              type: d.kind.type, docId
            });
          }
        }
      } catch (e) {
        status.textContent = "❌ 업로드 실패: " + e.message;
        status.classList.add("error");
        status.classList.remove("hidden");
        btn.disabled = false;
        btn.textContent = "☁ 저장 & 업로드";
        return;
      }

      State.pins.push(pin);
      State.activePin = pin.id;
      this._resetPinForm(true);
      btn.textContent = "☁ 저장 & 업로드";

      UI.renderPinList();
      UI.renderPinsOnMap(pin.id); // 드롭 애니메이션
      MapCtrl.flyTo(pin.x, pin.y, Math.max(State.zoom, 2.2), 500);

      // 다음 포인트 연속 배치 안내
      let savedNote = "✅ '" + label + "' 저장 완료";
      const tags = [];
      if (pin.imageId)        tags.push("☁ 360° 그림");
      else if (pin.isVideo && pin.videoUrl) tags.push("🎬 영상(로컬)");
      else if (pin.isVideo)   tags.push("🎬 360° 영상");
      else if (pin.imageUrl)  tags.push("🔗 URL");
      if (pin.note)           tags.push("📝 노트");
      if (pin.attachments && pin.attachments.length) tags.push("📎 첨부 " + pin.attachments.length);
      if (tags.length) savedNote += " (" + tags.join(" · ") + ")";
      UI.text("pin-saved-msg", savedNote);
      UI.show("section-next-point");
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
      if (removed && removed.videoUrl) _revokeVideoBlob(removed.videoUrl); // [B5] 삭제 시 즉시 해제
      State.pins = State.pins.filter(p => p.id !== id);
      if (State.activePin === id) State.activePin = null;
      UI.renderPinList();
      UI.renderPinsOnMap();
    },

    /** 핀에 360° 미디어(클라우드 이미지/로컬 영상/외부 URL)가 등록되어 있는가 */
    pinHasMedia(pin) {
      return !!(pin && (pin.imageId || pin.videoUrl || pin.imageUrl));
    },

    /** 핀에 노트 또는 첨부가 있는가 */
    pinHasInfo(pin) {
      return !!(pin && (pin.note || (pin.attachments && pin.attachments.length)));
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
    async _deployToViewer() {
      const btn    = UI.$("btn-deploy");
      const status = UI.$("deploy-status");

      if (State.pins.length === 0) { alert("배포할 핀이 없습니다. 먼저 포인트를 추가하세요."); return; }

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
        const res = await fetch("tables/deployments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title:        State.fileName || "도면",
            file_name:    State.fileName || "",
            drawing_data: pagesData[0],
            pages_data:   JSON.stringify(pagesData),
            pins:         JSON.stringify(deployablePins)
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
          const r1 = await fetch("tables/deployments/" + encodeURIComponent(wantId));
          if (r1.ok) latest = await r1.json();
        }

        // 없거나 실패 시 최신 배포본으로 폴백
        if (!latest) {
          const res = await fetch("tables/deployments?limit=100");
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

        State.fileType   = "image";
        State.viewerPages = pages;
        State.pdfPage    = 1;
        State.fileName   = latest.file_name || latest.title || "배포 도면";
        UI.text("file-name-label", State.fileName);
        UI.$("drop-hint").classList.add("hidden");
        UI.$("pdf-canvas").classList.add("hidden");

        try { State.pins = JSON.parse(latest.pins || "[]"); }
        catch { State.pins = []; }

        const imgEl = UI.$("map-image");
        imgEl.onload = () => {
          this._showMapViewport();
          UI.renderPinList();
          UI.renderPinsOnMap();
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

      // 저장된 토큰 복원
      try {
        const saved = sessionStorage.getItem("wm_id_token");
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
        this._pendingDesigner = null;
        if (this.isDesigner) { this._closeGate(); cb(); }
        else this._showGateError();
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
        this.user = { email: data.email, name: data.name, picture: data.picture, role: data.role };
        this.role = data.role;
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
      const gate = document.getElementById("login-gate");
      const err = document.getElementById("login-gate-error");
      if (err) err.classList.add("hidden");
      gate.classList.remove("hidden");
      requestAnimationFrame(() => gate.classList.add("on"));
      // 게이트 안 버튼 렌더 (로그인은 됐지만 권한 없는 경우엔 안내)
      if (this._gsiInited) this._renderButtons();
      if (this.user && !this.isDesigner) this._showGateError();
    },
    _showGateError() {
      const err = document.getElementById("login-gate-error");
      if (err) err.classList.remove("hidden");
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
      this.idToken = role === "designer" ? "demo-designer" : "demo-viewer";
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
      this.idToken = null; this.user = null; this.role = "viewer";
      try { sessionStorage.removeItem("wm_id_token"); } catch (e) {}
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
    init() {
      const $ = (id) => document.getElementById(id);
      $("designers-close") && $("designers-close").addEventListener("click", () => this.close());
      const bd = document.querySelector('#designers-modal .admin-gate-backdrop');
      bd && bd.addEventListener("click", () => this.close());
      $("designer-add-btn") && $("designer-add-btn").addEventListener("click", () => this.add());
      const inp = $("designer-email-input");
      if (inp) inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); this.add(); } });
    },
    async open() {
      if (!Auth.isSuper) return;
      const sa = document.getElementById("super-admin-email");
      if (sa) sa.textContent = Auth.user ? Auth.user.email : "designssir@gmail.com";
      document.getElementById("designers-modal").classList.remove("hidden");
      requestAnimationFrame(() => document.getElementById("designers-modal").classList.add("on"));
      await this.render();
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
      const sel = $("project-select");
      if (sel) sel.addEventListener("change", () => this.selectProject(sel.value));
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
      const sel = document.getElementById("project-select");
      if (!sel) return;
      const keep = this.currentProject ? this.currentProject.id : "";
      sel.innerHTML = '<option value="">— 프로젝트 선택 —</option>' +
        this.list.map((p) => `<option value="${p.id}">${this._esc(p.name)}</option>`).join("");
      sel.value = keep && this.list.some((p) => p.id === keep) ? keep : "";
      document.getElementById("project-actions").classList.toggle("hidden", !sel.value);
      document.getElementById("decks-block").classList.toggle("hidden", !sel.value);
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
        document.getElementById("project-select").value = p.id;
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
      document.getElementById("project-actions").classList.toggle("hidden", !this.currentProject);
      document.getElementById("decks-block").classList.toggle("hidden", !this.currentProject);
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

    async createDeck() {
      if (!this.currentProject) { alert("먼저 프로젝트를 선택하세요."); return; }
      const res = await Prompt.ask({ title: "데크(선박 층) 생성", sub: "데크 이름을 입력하세요 (예: Main Deck, 2nd Deck, Engine Deck)", placeholder: "데크 이름", second: true });
      if (!res) return;
      const level = res.second && /^\d+$/.test(res.second) ? Number(res.second) : null;
      try {
        const r = await fetch("/api/projects/" + this.currentProject.id + "/decks", {
          method: "POST", headers: Auth.headers(),
          body: JSON.stringify({ name: res.value, level_no: level })
        });
        const d = await r.json();
        if (!r.ok) { alert(d.error || "생성 실패(권한 필요)"); return; }
        await this.loadDecks();
      } catch (e) { alert("네트워크 오류"); }
    },

    async deleteDeck(id, name) {
      if (!confirm(`데크 '${name}' 를 삭제할까요?`)) return;
      try {
        await fetch("/api/decks/" + id, { method: "DELETE", headers: Auth.headers() });
        if (this.currentDeck && this.currentDeck.id === id) this.currentDeck = null;
        await this.loadDecks();
      } catch (e) {}
    },

    _renderDecks() {
      const listEl = document.getElementById("decks-list");
      const emptyEl = document.getElementById("decks-empty");
      if (!listEl) return;
      listEl.innerHTML = "";
      if (!this.decks.length) { emptyEl.classList.remove("hidden"); return; }
      emptyEl.classList.add("hidden");
      this.decks.forEach((d) => {
        const row = document.createElement("div");
        row.className = "deck-row" + (this.currentDeck && this.currentDeck.id === d.id ? " active" : "");
        const lvl = (d.level_no || d.level_no === 0) ? `<span class="deck-lvl">L${d.level_no}</span>` : "";
        row.innerHTML = `${lvl}<span class="deck-name">${this._esc(d.name)}</span>
          <button class="deck-del" title="삭제">✕</button>`;
        row.querySelector(".deck-name").addEventListener("click", () => { this.currentDeck = d; this._renderDecks(); });
        row.querySelector(".deck-del").addEventListener("click", (e) => { e.stopPropagation(); this.deleteDeck(d.id, d.name); });
        listEl.appendChild(row);
      });
    },

    _esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
  };

  /* ── 진입 ── */
  document.addEventListener("DOMContentLoaded", () => {
    App.init();

    // ── E2E 테스트 훅 (프로덕션 무해): 핀을 직접 주입해 UI 워크플로우 없이 검증 ──
    window.__wm = {
      State, App, AllPins, UI, MapCtrl, Auth, Settings, Designers, Projects, ProjectHub, Prompt, PanoViewer, Radar, PanoNav, Brand,
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
