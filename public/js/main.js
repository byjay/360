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
 * 의존: PDF.js 3.11.174 / Three.js 0.147.0 / JSZip 3.10.1 (모두 CDN)
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
    viewerPages: null,      // 뷰어 모드: 배포본 페이지 dataURL 배열
    pins:        [],        // {id,x,y,page,label,imageUrl?,imageId?,imageName?}
    placing:     false,
    pending:     null,      // { x, y }
    pendingFile: null,      // 선택된 360° 그림/영상 파일
    pendingIsVideo: false,
    activePin:   null,
    zoom:        1,
    pan:         { x: 0, y: 0 },
    panDragging: false,
    panStart:    { mx: 0, my: 0, px: 0, py: 0 },
    viewerLocked: false,

    reset() {
      if (this.imageUrl) { URL.revokeObjectURL(this.imageUrl); this.imageUrl = null; }
      _revokeAllVideoBlobs(); // [B5] 영상 핀 blob URL 일괄 해제
      this.fileType = null; this.fileName = null;
      this.fileData = null; this.pdfDoc = null;
      this.pdfPage = 1; this.pdfPages = 0; this.viewerPages = null;
      this.pins = []; this.placing = false; this.pending = null;
      this.pendingFile = null; this.pendingIsVideo = false;
      this.activePin = null; this.zoom = 1; this.pan = { x: 0, y: 0 };
    }
  };

  /* ══════════════════════════════════════════
     PDF MODULE
  ══════════════════════════════════════════ */
  const PDF = {
    // 로컬 번들 worker 우선(외부 CDN worker가 차단/지연될 때 PDF가 무한 로딩되는 문제 방지)
    WORKER_SRC: "vendor/pdf.worker.min.js",
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

    _configWorker() {
      if (this.ready) return;
      // disableWorker 모드(메인스레드 파싱)를 사용하므로 workerSrc 는 형식상만 설정.
      try { window.pdfjsLib.GlobalWorkerOptions.workerSrc = this.WORKER_SRC; } catch (e) {}
      this.ready = true;
    },

    async load(arrayBuffer) {
      const lib = await this.ensureLib();
      // ⚠️ worker(blob/CDN) 사용 시 일부 환경에서 page.render().promise 가
      //    화면은 그려지지만 resolve 되지 않고 hang 되는 문제가 있다.
      //    도면 PDF(수 MB)는 메인스레드 파싱도 충분히 빠르므로 disableWorker 로 안정화한다.
      const task = lib.getDocument({ data: arrayBuffer.slice(0), disableWorker: true });
      // task.promise 만 await. destroy/race 로 진행 중 task 를 끊으면
      // 이후 getPage/render 가 "Rendering cancelled" 로 실패하므로 절대 끊지 않는다.
      return await task.promise;
    },

    async renderPage(pdfDoc, pageNum, canvas, scale = 1.5) {
      const page = await pdfDoc.getPage(pageNum);
      const vp   = page.getViewport({ scale });
      canvas.width  = vp.width;
      canvas.height = vp.height;
      const task = page.render({ canvasContext: canvas.getContext("2d"), viewport: vp });
      // ⚠️ 일부 환경에서 render().promise 가 화면은 그려진 뒤에도 resolve 되지 않고
      //    hang 되는 경우가 있다. 이미 캔버스에 그려졌으므로, 정상 resolve 를 우선 기다리되
      //    일정 시간 내 끝나지 않으면 task 를 끊지 않고(=화면 유지) 그대로 진행한다.
      await Promise.race([
        task.promise.catch(() => {}),
        new Promise(res => setTimeout(res, 4000))
      ]);
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
    }
  };

  /* ══════════════════════════════════════════
     PANO VIEWER  — Three.js WebGL (고속)
  ══════════════════════════════════════════ */
  const PanoViewer = {
    S: { lon: 0, lat: 0, fov: 75, dragging: false, lx: 0, ly: 0, autoRotate: false },
    renderer: null, scene: null, camera: null, mesh: null, texture: null,
    videoEl: null, rafId: null, canvas: null, open: false,

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
    },

    _startLoop() {
      cancelAnimationFrame(this.rafId);
      const loop = () => {
        if (!this.open) return;
        if (this.S.autoRotate && !this.S.dragging) this.S.lon += 0.06;
        this._renderFrame();
        this.rafId = requestAnimationFrame(loop);
      };
      loop();
    },

    _renderFrame() {
      if (!this.renderer) return;
      const S = this.S;
      S.lat = Math.max(-85, Math.min(85, S.lat));
      const phi   = THREE.MathUtils.degToRad(90 - S.lat);
      const theta = THREE.MathUtils.degToRad(S.lon);
      this.camera.target = new THREE.Vector3(
        500 * Math.sin(phi) * Math.cos(theta),
        500 * Math.cos(phi),
        500 * Math.sin(phi) * Math.sin(theta)
      );
      this.camera.lookAt(this.camera.target);
      this.camera.fov = S.fov;
      this.camera.updateProjectionMatrix();
      this.renderer.render(this.scene, this.camera);
    },

    /* ── 컨트롤 ── */
    setFov(delta) { this.S.fov = Math.max(30, Math.min(110, this.S.fov + delta)); },
    resetView()   { this.S.lon = 0; this.S.lat = 0; this.S.fov = 75; },
    toggleAuto()  { this.S.autoRotate = !this.S.autoRotate; return this.S.autoRotate; },

    onPointerDown(x, y) { this.S.dragging = true; this.S.lx = x; this.S.ly = y; },
    onPointerMove(x, y) {
      if (!this.S.dragging) return;
      const k = this.S.fov / 500; // FOV 비례 감도
      this.S.lon += (this.S.lx - x) * k;
      this.S.lat += (y - this.S.ly) * k;
      this.S.lx = x; this.S.ly = y;
    },
    onPointerUp() { this.S.dragging = false; },
    onWheel(e)    { e.preventDefault(); this.setFov(e.deltaY * 0.05); },

    close() {
      this.open = false;
      cancelAnimationFrame(this.rafId);
      this._disposeVideo();
      document.getElementById("pano-overlay").classList.add("hidden");
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    }
  };

  /* ══════════════════════════════════════════
     MAP CTRL  — 줌/패닝 + 좌표 변환 + 플라이투
  ══════════════════════════════════════════ */
  const MapCtrl = {
    viewport: null, transform: null, _flyRaf: null,

    init(viewport, transform) { this.viewport = viewport; this.transform = transform; },

    applyTransform() {
      const { x, y } = State.pan;
      this.transform.style.transform = `translate(${x}px, ${y}px) scale(${State.zoom})`;
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

        if (State.mode === "designer") {
          item.innerHTML = `
            <div class="pin-num">${idx + 1}</div>
            <div class="pin-info">
              <div class="pin-name">${this.escapeHtml(pin.label)}${cloudTag}</div>
              <div class="pin-coords">${pin.x.toFixed(1)}%, ${pin.y.toFixed(1)}%${pageTag}</div>
            </div>
            <button class="pin-del" data-id="${pin.id}" title="삭제">✕</button>`;
          item.querySelector(".pin-del").addEventListener("click", e => {
            e.stopPropagation();
            App.deletePin(pin.id);
          });
          item.addEventListener("click", () => App.focusPin(pin));
        } else {
          item.innerHTML = `
            <div class="pin-num">${idx + 1}</div>
            <div class="pin-info">
              <div class="pin-name">${this.escapeHtml(pin.label)}${cloudTag}</div>
              <div class="pin-coords">${pin.x.toFixed(1)}%, ${pin.y.toFixed(1)}%${pageTag}</div>
            </div>
            <span class="pin-arrow">▶</span>`;
          item.addEventListener("click", () => App.focusPin(pin, true));
        }
        list.appendChild(item);
      });
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
        marker.innerHTML = `
          <div class="pin-marker-label">${this.escapeHtml(pin.label)}</div>
          <div class="pin-marker-bubble"><span>${idx + 1}</span></div>`;
        marker.addEventListener("click", e => {
          e.stopPropagation();
          if (State.mode === "designer") App.setActivePin(pin.id);
          else App.openPano(pin);
        });
        layer.appendChild(marker);
      });
    },

    updatePdfPagination() {
      const total = State.mode === "viewer" && State.viewerPages
        ? State.viewerPages.length : State.pdfPages;
      if (total > 1) {
        this.$("pdf-pagination").classList.remove("hidden");
        this.text("page-info", `${State.pdfPage} / ${total}`);
        this.$("btn-prev-page").disabled = State.pdfPage <= 1;
        this.$("btn-next-page").disabled = State.pdfPage >= total;
      } else {
        this.$("pdf-pagination").classList.add("hidden");
      }
    }
  };

  /* ══════════════════════════════════════════
     APP
  ══════════════════════════════════════════ */
  const App = {

    init() {
      this._bindHome();
      this._bindTopbar();
      this._bindSidebar();
      this._bindMap();
      this._bindPano();
      MapCtrl.init(UI.$("map-viewport"), UI.$("map-transform"));
      PanoViewer.init(UI.$("pano-canvas"));
    },

    /* ── Home ── */
    _bindHome() {
      document.querySelectorAll(".mode-card").forEach(card => {
        const open = () => this.openApp(card.dataset.mode);
        card.addEventListener("click", open);
        card.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") open(); });
      });
    },

    openApp(mode) {
      State.mode = mode;
      const isDesigner = mode === "designer";
      document.documentElement.style.setProperty("--accent", isDesigner ? "var(--gold)" : "var(--green)");
      UI.$("topbar").style.borderBottomColor = isDesigner ? "rgba(245,158,11,.2)" : "rgba(16,185,129,.2)";
      const dot = UI.$("topbar-dot");
      if (dot) dot.style.background = isDesigner ? "var(--gold)" : "var(--green)";
      UI.text("mode-label", isDesigner ? "DESIGNER MODE" : "VIEWER MODE");
      UI.$("mode-label").style.color = isDesigner ? "var(--gold)" : "var(--green)";

      // ── 뷰어는 "보기 전용". 업로드/편집/배포 관련 UI는 모두 숨긴다. ──
      //  (사용자 요청: "뷰어는 업로드가 왜 필요하지. 뷰어만 완벽하게 되게 만들어")
      UI.toggle("section-upload",    isDesigner);   // 도면 업로드
      UI.toggle("section-place",     isDesigner);   // 위치 포인트 추가
      UI.toggle("section-export",    isDesigner);   // 뷰어로 배포
      UI.toggle("section-pin-form",  false);        // 핀 입력 폼 (항상 숨김으로 시작)
      UI.toggle("section-next-point", false);
      UI.toggle("btn-import-json",   false);        // JSON 가져오기 — 뷰어/디자이너 모두 숨김
      UI.toggle("section-viewer-load", !isDesigner); // 뷰어 로드 상태 표시

      if (!isDesigner) {
        // 뷰어 전용 링크(?mode=viewer)로 진입한 경우 홈 버튼도 숨긴다.
        if (State.viewerLocked) UI.$("btn-back").style.display = "none";
      } else {
        UI.$("btn-back").style.display = "";
      }

      UI.$("pin-empty").textContent = isDesigner
        ? "포인트를 추가하세요"
        : "배포된 포인트를 불러오는 중...";

      UI.showScreen("screen-app");
      if (!isDesigner) this.loadLatestDeployment();
    },

    /* ── Topbar ── */
    _bindTopbar() {
      UI.$("btn-back").addEventListener("click", () => {
        State.reset();
        PanoViewer.close();
        UI.showScreen("screen-home");
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
    },

    async _changePage(dir) {
      const total = State.mode === "viewer" && State.viewerPages
        ? State.viewerPages.length : State.pdfPages;
      const next = State.pdfPage + dir;
      if (next < 1 || next > total) return;
      State.pdfPage = next;

      if (State.mode === "viewer" && State.viewerPages) {
        // 뷰어: 페이지 이미지 교체
        const imgEl = UI.$("map-image");
        imgEl.onload = () => { this._showMapViewport(); };
        imgEl.src = State.viewerPages[next - 1];
        UI.updatePdfPagination();
      } else {
        await this._renderPdfPage();
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

      UI.$("input-pin-url").addEventListener("input", () => this._updateConfirmEnabled());
      UI.$("btn-confirm-pin").addEventListener("click", () => this._confirmPin());
      UI.$("btn-cancel-pin").addEventListener("click", () => this._resetPinForm(true));

      UI.$("btn-export-json").addEventListener("click", () => this._exportJson());
      UI.$("btn-deploy").addEventListener("click", () => this._deployToViewer());
      UI.$("btn-reload-deploy").addEventListener("click", () => this.loadLatestDeployment());
      UI.$("btn-download-src").addEventListener("click", () => this._downloadSource());
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
      UI.$("btn-confirm-pin").disabled = !(hasFile || hasUrl);
    },

    _resetPinForm(hideForm) {
      State.pending = null;
      State.pendingFile = null;
      State.pendingIsVideo = false;
      UI.$("pending-pin").classList.add("hidden");
      UI.clearVal("input-pin-label");
      UI.clearVal("input-pin-url");
      UI.clearVal("input-pin-imgname");
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
        if (e.key === "Escape" && PanoViewer.open) PanoViewer.close();
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
      await PDF.renderPage(State.pdfDoc, State.pdfPage, canvas);
      UI.updatePdfPagination();
      State.pan = { x: 0, y: 0 }; State.zoom = 1;
      MapCtrl.applyTransform();
      UI.renderPinsOnMap();
    },

    _showMapViewport() {
      State.pan  = { x: 0, y: 0 };
      State.zoom = 1;
      MapCtrl.applyTransform();
      UI.$("map-viewport").classList.remove("hidden");
      UI.renderPinsOnMap();
      UI.updatePdfPagination();
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
      const file  = State.pendingFile;
      if (!file && !url) return;

      const btn    = UI.$("btn-confirm-pin");
      const status = UI.$("pin-upload-status");
      btn.disabled = true;
      btn.textContent = file ? "☁ 업로드 중..." : "저장 중...";

      const pin = {
        id:    Date.now(),
        x:     State.pending.x,
        y:     State.pending.y,
        page:  State.pdfPage,
        label
      };

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
        } else {
          // URL 직접 입력 (이미지 또는 영상 자동 판별)
          pin.imageUrl = url;
          if (/\.(mp4|webm|mov)(\?|#|$)/i.test(url)) pin.isVideo = true;
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
      if (pin.imageId)        savedNote += " (☁ 클라우드 업로드됨)";
      else if (pin.isVideo && pin.videoUrl) savedNote += " (🎬 영상 — 로컬 미리보기, 배포 시 URL 권장)";
      else if (pin.isVideo)   savedNote += " (🎬 360° 영상)";
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
      if (openAfter) setTimeout(() => this.openPano(pin), 800);
    },

    deletePin(id) {
      const removed = State.pins.find(p => p.id === id);
      if (removed && removed.videoUrl) _revokeVideoBlob(removed.videoUrl); // [B5] 삭제 시 즉시 해제
      State.pins = State.pins.filter(p => p.id !== id);
      if (State.activePin === id) State.activePin = null;
      UI.renderPinList();
      UI.renderPinsOnMap();
    },

    /* ── 360° 팝업 열기 (클라우드 저장본 / 영상 / URL) ── */
    async openPano(pin) {
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

    /* ── 소스코드 ZIP 다운로드 ── */
    async _downloadSource() {
      const btn = UI.$("btn-download-src");
      btn.classList.add("loading");
      try { await buildAndDownloadZip(); }
      catch (err) { alert("다운로드 실패: " + err.message + "\n\n배포 환경(HTTP 서버)에서 실행해 주세요."); }
      finally { btn.classList.remove("loading"); }
    }
  };

  /* ══════════════════════════════════════════
     ZIP 다운로드 (공용)
  ══════════════════════════════════════════ */
  async function buildAndDownloadZip() {
    if (!window.JSZip) throw new Error("JSZip 라이브러리 로드 중입니다. 잠시 후 다시 시도하세요.");
    const [html, css, js] = await Promise.all([
      fetch("index.html").then(r => r.text()),
      fetch("css/style.css").then(r => r.text()),
      fetch("js/main.js").then(r => r.text())
    ]);
    const zip = new JSZip();
    zip.file("index.html", html);
    zip.folder("css").file("style.css", css);
    zip.folder("js").file("main.js", js);
    zip.file("README.md", [
      "# 360° Location Viewer System — We:are Marine",
      "",
      "## 실행 방법 (로컬 웹서버 필요)",
      "",
      "### Python",
      "```",
      "python -m http.server 8080",
      "# 브라우저에서 http://localhost:8080 접속",
      "```",
      "",
      "### Node.js",
      "```",
      "npx serve .",
      "```",
      "",
      "## 파일 구조",
      "index.html     — 메인 HTML",
      "css/style.css  — 스타일",
      "js/main.js     — 앱 로직 (PDF.js + Three.js WebGL 파노라마)",
      "",
      "## 의존 라이브러리 (CDN, 인터넷 필요)",
      "- PDF.js 3.11.174",
      "- Three.js 0.147.0",
      "- JSZip 3.10.1",
      "- Google Fonts",
      "",
      "## 주의",
      "클라우드 저장(테이블 API: tables/pano_images, tables/deployments)은",
      "Genspark 배포 환경에서만 동작합니다. 로컬 실행 시 URL 방식 핀만 사용 가능."
    ].join("\n"));
    const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "wemare-360-viewer.zip";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); document.body.removeChild(a); }, 1500);
  }

  /* ── 진입 ── */
  document.addEventListener("DOMContentLoaded", () => {
    App.init();

    const params  = new URLSearchParams(location.search);
    const urlMode = params.get("mode");
    if (urlMode === "viewer") {
      State.viewerLocked = true;
      App.openApp("viewer");
    }

    /* ── 360° 테스트 훅: ?demo360=<이미지URL> 로 파노라마 직접 오픈 ── */
    const demo = params.get("demo360");
    if (demo) {
      PanoViewer.loadMedia(decodeURIComponent(demo), "TEST PANORAMA");
    }

    const zipBtn = document.getElementById("btn-zip-download");
    if (zipBtn) {
      zipBtn.addEventListener("click", async () => {
        zipBtn.classList.add("loading");
        try { await buildAndDownloadZip(); }
        catch (e) { alert("다운로드 실패: " + e.message); }
        finally { zipBtn.classList.remove("loading"); }
      });
    }
  });

})();
