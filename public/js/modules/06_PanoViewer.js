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
      // 🔴 [핵심 버그 수정] crossOrigin 은 "외부 http(s) 출처" 일 때만 설정.
      //   data:/blob:/same-origin 에 crossOrigin="anonymous" 를 붙이면 일부 모바일
      //   브라우저가 WebGL 텍스처 보안정책으로 onerror 처리 → "이미지를 불러올 수 없습니다".
      if (/^https?:\/\//i.test(src) && !src.startsWith(location.origin)) {
        img.crossOrigin = "anonymous";
      }
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

    /* ── [마스터 요청] 자이로(폰 기울임) 둘러보기 — 삼성폰 DeviceOrientation ── */
    isGyroSupported() { return typeof window !== "undefined" && "DeviceOrientationEvent" in window; },

    /** 자이로 켜기/끄기 토글. iOS는 권한요청 필요(삼성폰=Android는 즉시 동작). 반환: 켜짐 여부 */
    async toggleGyro() {
      if (this._gyroOn) { this._stopGyro(); return false; }
      if (!this.isGyroSupported()) {
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("이 기기는 자이로 센서를 지원하지 않습니다");
        return false;
      }
      // iOS 13+ 권한 요청(Android/삼성폰은 해당 없음)
      try {
        const DOE = window.DeviceOrientationEvent;
        if (DOE && typeof DOE.requestPermission === "function") {
          const res = await DOE.requestPermission();
          if (res !== "granted") {
            if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("자이로 권한이 거부되었습니다");
            return false;
          }
        }
      } catch (e) {/* Android는 requestPermission 없음 → 무시 */}
      this._startGyro();
      return true;
    },

    _startGyro() {
      if (this._gyroHandler) this._stopGyro();
      this.S.autoRotate = false; // 자이로 중엔 자동회전 끔(충돌 방지)
      this._gyroBase = null;     // 첫 측정값을 기준으로 상대 이동
      this._gyroHandler = (e) => {
        if (!this.open || this.S.dragging) return;
        // alpha=나침반(yaw), beta=앞뒤기울임(pitch). 가로/세로 회전 보정은 화면방향 고려.
        const alpha = (e.alpha == null) ? null : e.alpha;
        const beta  = (e.beta  == null) ? null : e.beta;
        if (alpha == null && beta == null) return;
        if (!this._gyroBase) {
          this._gyroBase = { alpha: alpha || 0, beta: beta || 0, lon: this.S.lon, lat: this.S.lat };
          return;
        }
        const b = this._gyroBase;
        // yaw: alpha 증가 → 좌측 회전. 부호는 직관에 맞게 보정.
        let dAlpha = (alpha == null) ? 0 : (alpha - b.alpha);
        // -180~180 정규화
        dAlpha = ((dAlpha + 540) % 360) - 180;
        const dBeta = (beta == null) ? 0 : (beta - b.beta);
        this.S.lon = b.lon - dAlpha;
        this.S.lat = b.lat + dBeta;
        this._invalidate();
      };
      window.addEventListener("deviceorientation", this._gyroHandler, true);
      this._gyroOn = true;
      if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("🧭 자이로 켜짐 — 폰을 돌려 둘러보세요");
    },

    _stopGyro() {
      if (this._gyroHandler) {
        window.removeEventListener("deviceorientation", this._gyroHandler, true);
        this._gyroHandler = null;
      }
      this._gyroOn = false;
      this._gyroBase = null;
    },

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
      this._stopGyro();           // [마스터 요청] 자이로 리스너 정리(닫을 때 누수 방지)
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