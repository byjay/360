  const PanoViewer = {
    S: { lon: 0, lat: 0, fov: 75, dragging: false, lx: 0, ly: 0, autoRotate: false, roll: 0 },
    renderer: null, scene: null, camera: null, mesh: null, texture: null,
    videoEl: null, rafId: null, canvas: null, open: false, _currentPin: null,
    _dragSpotId: null, // [마스터: 마커 드래그] 현재 끌고 있는 spot.id (null이면 카메라 드래그)
    _dragOrigLL: null, _dragArrow: null, _dragArrowActive: false, // [마스터: 이동 화살표] 드래그 시작 lon/lat, 화살표 3D 오브젝트, 활성 플래그

    init(canvas) { this.canvas = canvas; },

    /* ══════════════════════════════════════════
       [지휘자 발주 2026-10-01] "사진으로 빨려 들어가는" 전환 효과 — Dive
       핀 탭(및 트리/핀패널의 모든 진입점) → 도면 줌인 → 원형 개방 → 화각 펼침(총 ~800ms).
       닫기는 역재생. 모든 진입점이 이미 App.openPano() 1개로 수렴하므로(grep 확인됨)
       그 선두에서 open()을 1회 호출하는 것만으로 전수 적용된다 — 호출부 복제 없음.
       🔴 MapCtrl/State는 절대 건드리지 않는다(#map-viewport 인라인 style만 조작 → 시각효과만,
       끝나면 완전히 원복). close()의 역재생도 이 파일(06_PanoViewer.js) 안에서 전부 처리한다
       (닫기 버튼/Esc/뒤로 전부 PanoViewer.close() 1개로 수렴 — grep 확인됨). */
    Dive: {
      ZOOM_MS: 350,          // ① 도면 줌인 구간 길이(0~350ms)
      OPEN_DELAY_MS: 250,    // ② 원형 개방 시작 시각
      OPEN_MS: 350,          //    원형 개방 지속시간(250~600ms)
      FOV_DELAY_MS: 300,     // ③ 화각 펼침 시작 시각(최소값 — 텍스처가 늦으면 로드 완료 후 시작)
      FOV_MS: 500,           //    화각 펼침 지속시간(300~800ms)
      TOTAL_MS: 800,
      ZOOM_SCALE: 3,         // 도면 확대 배율
      FOV_NARROW: 30,        // 시작 화각(좁게)
      CLOSE_FOV_MS: 200,     // 닫기 역재생: fov 좁히기
      CLOSE_OPEN_MS: 300,    //               원형 닫기
      CLOSE_ZOOM_MS: 300,    //               도면 줌아웃 (합 800ms)
      REDUCED_FADE_MS: 200,  // 접근성/저사양 대체: 페이드
      busy: false,           // 진행 중(열기 또는 닫기) — true면 재입장 무시("중복 탭 무시")
      closing: false,
      _raf: null,
      _targetFov: 75,
      _startTs: 0,
      _pos: null,

      /** prefers-reduced-motion 또는 저사양(코어 ≤2) → 풀 연출 대신 페이드로 대체 */
      reduced() {
        try {
          if (typeof window !== "undefined" && window.matchMedia &&
            window.matchMedia("(prefers-reduced-motion: reduce)").matches) return true;
        } catch (e) {}
        try {
          if (typeof navigator !== "undefined" && navigator.hardwareConcurrency &&
            navigator.hardwareConcurrency <= 2) return true;
        } catch (e) {}
        return false;
      },

      /** 핀 마커의 현재 화면좌표(중심). 마커가 없거나 화면 밖이면 화면 중앙. */
      screenPos(pin) {
        const vw = (typeof window !== "undefined" && window.innerWidth) || 0;
        const vh = (typeof window !== "undefined" && window.innerHeight) || 0;
        try {
          const el = pin && typeof document !== "undefined" &&
            document.querySelector('.pin-marker[data-id="' + pin.id + '"]');
          if (el) {
            const r = el.getBoundingClientRect();
            const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
            if (cx >= 0 && cy >= 0 && (!vw || cx <= vw) && (!vh || cy <= vh)) return { x: cx, y: cy };
          }
        } catch (e) {}
        return { x: vw / 2, y: vh / 2 };
      },

      _mapEl() { return typeof document !== "undefined" ? document.getElementById("map-viewport") : null; },
      _ovEl() { return typeof document !== "undefined" ? document.getElementById("pano-overlay") : null; },
      _now() { return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now(); },

      /** #map-viewport(도면 컨테이너)를 화면좌표 pos 중심으로 scale까지 애니메이션.
       *  🔴 MapCtrl.transform/State는 절대 건드리지 않는 별개 엘리먼트 — 순수 시각효과. */
      _zoomMap(pos, scale, ms, easing, instant) {
        const el = this._mapEl(); if (!el) return;
        el.style.transformOrigin = pos.x + "px " + pos.y + "px";
        if (instant) { el.style.transition = "none"; el.style.transform = "scale(" + scale + ")"; return; }
        el.style.transition = "transform " + ms + "ms " + easing;
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(() => { el.style.transform = "scale(" + scale + ")"; });
        } else {
          el.style.transform = "scale(" + scale + ")";
        }
      },
      /** 도면 확대를 완전히 원복(MapCtrl이 다음 applyTransform에서 쓰는 값과 무관 — 그냥 이 엘리먼트의 흔적 제거). */
      _resetMap() {
        const el = this._mapEl(); if (!el) return;
        el.style.transition = "none"; el.style.transform = ""; el.style.transformOrigin = "";
      },

      _setClip(pos, pct) {
        const ov = this._ovEl(); if (!ov) return;
        ov.style.clipPath = "circle(" + pct + "% at " + pos.x + "px " + pos.y + "px)";
      },

      /** S.fov를 from→to 로 ms간 보간(ease-out cubic). PanoViewer의 기존 렌더루프(_invalidate)를 재사용. */
      _rampFov(pv, from, to, ms, onDone) {
        if (this._raf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this._raf);
        const t0 = this._now();
        const step = (now) => {
          const k = Math.min(1, (now - t0) / ms);
          const e = 1 - Math.pow(1 - k, 3);
          pv.S.fov = from + (to - from) * e;
          pv._invalidate();
          if (k < 1 && typeof requestAnimationFrame === "function") { this._raf = requestAnimationFrame(step); }
          else { this._raf = null; if (onDone) onDone(); }
        };
        if (typeof requestAnimationFrame === "function") this._raf = requestAnimationFrame(step);
        else step(t0 + ms); // rAF 없는 환경(테스트) — 즉시 종료값으로
      },

      /** load()/loadVideo()가 S를 리셋한 직후 호출 — 기본 화각(target)을 기억하고,
       *  다이빙 중이면 즉시 좁은 화각으로 바꿔 "펼쳐지는" 시작점을 만든다. */
      markLoadStart(pv) {
        this._targetFov = pv.S.fov;
        if (this.busy && !this.closing && !this.reduced()) pv.S.fov = this.FOV_NARROW;
      },
      /** 텍스처(이미지/영상) 준비 완료 시 load()/loadVideo()가 호출 — 화각 펼침 애니메이션 시작.
       *  최소 FOV_DELAY_MS 는 보장하되, 로드가 늦었으면(이미 지났으면) 그 즉시 시작한다. */
      onTextureReady(pv) {
        if (!this.busy || this.closing || this.reduced()) return;
        const wait = Math.max(0, this.FOV_DELAY_MS - (this._now() - this._startTs));
        const start = () => this._rampFov(pv, this.FOV_NARROW, this._targetFov, this.FOV_MS);
        if (typeof setTimeout === "function") setTimeout(start, wait); else start();
      },

      /** ① 진입 — App.openPano() 선두에서 1회 호출(모든 진입점 공유). */
      open(pv, pin) {
        if (this.busy) return; // 🔴 중복 탭 무시(재시작 금지)
        this.busy = true; this.closing = false;
        this._startTs = this._now();
        const pos = this.screenPos(pin);
        this._pos = pos;
        const ov = this._ovEl(), map = this._mapEl();
        if (this.reduced() || !ov || !map) {
          // 접근성/저사양/DOM 없음 — 200ms 페이드로 대체(줌/원형/화각 생략)
          if (ov) {
            ov.classList.remove("hidden");
            ov.style.transition = "none"; ov.style.opacity = "0";
            const go = () => { ov.style.transition = "opacity " + this.REDUCED_FADE_MS + "ms ease"; ov.style.opacity = "1"; };
            if (typeof requestAnimationFrame === "function") requestAnimationFrame(go); else go();
          }
          if (typeof setTimeout === "function") {
            setTimeout(() => {
              if (ov) { ov.style.transition = ""; ov.style.opacity = ""; }
              this.busy = false;
            }, this.REDUCED_FADE_MS + 40);
          } else { this.busy = false; }
          return;
        }
        ov.classList.remove("hidden");
        this._setClip(pos, 0);
        ov.style.transition = "none";
        this._zoomMap(pos, this.ZOOM_SCALE, this.ZOOM_MS, "ease-in");
        map.classList.add("dive-dim");
        setTimeout(() => {
          ov.style.transition = "clip-path " + this.OPEN_MS + "ms ease-out";
          const go = () => this._setClip(pos, 150);
          if (typeof requestAnimationFrame === "function") requestAnimationFrame(go); else go();
        }, this.OPEN_DELAY_MS);
        setTimeout(() => { this._resetMap(); map.classList.remove("dive-dim"); }, this.OPEN_DELAY_MS + this.OPEN_MS + 20);
        setTimeout(() => {
          ov.style.transition = ""; ov.style.clipPath = "";
          this.busy = false;
        }, this.TOTAL_MS);
      },

      /** ④ 닫기 역재생 — PanoViewer.close()가 호출. 핀 위치는 "지금" 다시 계산(그사이 이동했을 수 있음). */
      close(pv, onDone) {
        if (this.closing) { return; } // 🔴 닫기 중복 호출 무시(재시작 금지)
        const ov = this._ovEl(), map = this._mapEl();
        const pin = pv._currentPin;
        const pos = this.screenPos(pin) || this._pos || { x: 0, y: 0 };
        if (this.reduced() || !ov || !map) {
          if (ov) {
            this.closing = true;
            ov.style.transition = "opacity " + this.REDUCED_FADE_MS + "ms ease";
            ov.style.opacity = "0";
            setTimeout(() => {
              ov.style.transition = ""; ov.style.opacity = "";
              this.closing = false; this.busy = false;
              onDone();
            }, this.REDUCED_FADE_MS);
          } else { this.busy = false; onDone(); }
          return;
        }
        this.closing = true; this.busy = true;
        if (this._raf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this._raf);
        const fromFov = pv.S.fov;
        const finish = () => {
          this._resetMap(); map.classList.remove("dive-dim");
          ov.style.transition = ""; ov.style.clipPath = "";
          this.closing = false; this.busy = false;
          onDone();
        };
        // 원형이 아직 열려있어 화면이 전부 덮여 있는 동안 미리 확대해 둔다(무해 — 안 보임).
        this._zoomMap(pos, this.ZOOM_SCALE, 0, "linear", true);
        map.classList.add("dive-dim");
        // ① fov 좁히기 → ② 원형을 핀 위치로 닫기 → ③ 도면 줌아웃
        this._rampFov(pv, fromFov, this.FOV_NARROW, this.CLOSE_FOV_MS, () => {
          ov.style.transition = "clip-path " + this.CLOSE_OPEN_MS + "ms ease-in";
          const go = () => this._setClip(pos, 0);
          if (typeof requestAnimationFrame === "function") requestAnimationFrame(go); else go();
          setTimeout(() => {
            ov.style.transition = "";
            this._zoomMap(pos, 1, this.CLOSE_ZOOM_MS, "ease-out");
            setTimeout(finish, this.CLOSE_ZOOM_MS + 20);
          }, this.CLOSE_OPEN_MS + 20);
        });
      }
    },

    /** [지휘자 발주 2026-09-29 항목6] 뷰어 제목에 사진 저장명(영역/구역_시각 등, PhotoNaming.describe
     *  가 정본 — 35_PhotoBatch.js, 27_PinActionPop.js 사진 캡션과 동일 SoT)을 덧붙인다.
     *  PhotoNaming 미로드/정보 없음이면 빈 문자열 → 기존 제목 그대로(요구사항 "없으면 기존 동작 유지"). */
    _savedNameSuffix() {
      const pin = this._currentPin;
      if (!pin || typeof PhotoNaming === "undefined" || !PhotoNaming.describe) return "";
      const desc = PhotoNaming.describe(pin);
      return desc ? " · " + desc : "";
    },

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
      this.S = { lon: 0, lat: 0, fov: 75, dragging: false, lx: 0, ly: 0, autoRotate: false, roll: 0 };
      this.Dive.markLoadStart(this);

      $("pano-location-name").textContent = "360° — " + locationName + this._savedNameSuffix();
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
      // [핵심 버그 수정] crossOrigin 은 "외부 http(s) 출처" 일 때만 설정.
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
        // [마스터: 자동 수평] GPano 메타데이터가 있으면 천정 기울기 자동 보정(없으면 무동작)
        this._applyGPanoLevel(src);
        // [마스터: 구면 마커] 이 핀에 저장된 360 안 마커 렌더
        if (this._currentPin) this.renderSpots(this._currentPin.spots || []);
        this.Dive.onTextureReady(this);
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
            "편집모드에서 '그림 파일 선택'으로 직접 업로드하면 클라우드 저장되어 항상 표시됩니다.";
        }
      };
      img.src = (typeof Auth !== "undefined" && Auth.r2) ? Auth.r2(src) : src;
    },

    /** Ricoh THETA 등 360° equirectangular .mp4 → VideoTexture (GPU) */
    loadVideo(src, locationName) {
      const $ = id => document.getElementById(id);
      this.S = { lon: 0, lat: 0, fov: 75, dragging: false, lx: 0, ly: 0, autoRotate: false, roll: 0 };
      this.Dive.markLoadStart(this);

      $("pano-location-name").textContent = "360° ▶ " + locationName + this._savedNameSuffix();
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
        this.Dive.onTextureReady(this);
      }, { once: true });
      video.addEventListener("error", () => this._showError(src, "360° 영상을 불러올 수 없습니다 (코덱/CORS 확인)"));

      video.src = (typeof Auth !== "undefined" && Auth.r2) ? Auth.r2(src) : src;
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
      let W = window.innerWidth, H = window.innerHeight;
      if (!W || !H) { W = 1280; H = 720; }   // [견고화] 0크기(레이아웃 전) → aspect NaN/레이캐스트 깨짐 방지
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
      // [마스터: 360 회전 시 옆으로 비틀어짐] 이미지 천정(zenith)이 기울어진 파노라마를
      //   수평 보정 — 구 메쉬를 카메라 전방축 기준 roll 회전(고정 월드 보정 → 모든 yaw에서 수평 유지).
      if (this.mesh) this.mesh.rotation.x = THREE.MathUtils.degToRad(S.roll || 0);
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
    resetView()   { this.S.lon = 0; this.S.lat = 0; this.S.fov = 75; this.S.roll = 0; this._invalidate(); },
    /** [FARO Markers] 특정 마커(lon/lat)로 시점을 부드럽게 이동(최단 회전 경로) */
    lookAtSpot(lon, lat) {
      const startLon = this.S.lon, startLat = this.S.lat;
      const dLon = ((lon - (startLon % 360)) + 540) % 360 - 180;
      const tLat = Math.max(-85, Math.min(85, lat || 0));
      const t0 = performance.now(), dur = 500;
      if (this._spotRaf) cancelAnimationFrame(this._spotRaf);
      const step = (now) => {
        const k = Math.min(1, (now - t0) / dur);
        const e = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        this.S.lon = startLon + dLon * e;
        this.S.lat = startLat + (tLat - startLat) * e;
        this._invalidate();
        if (k < 1) this._spotRaf = requestAnimationFrame(step);
      };
      this._spotRaf = requestAnimationFrame(step);
    },
    /** [P23: 마커목록 사진별] 전체 핀 배열 → "사진(핀) 단위" 그룹으로 묶고 정렬.
     *  - 현재 사진(currentPin)은 항상 맨 앞(스팟이 0개여도 포함 — 빈 상태를 정직하게 보여주기 위함).
     *  - 다른 사진은 "마커가 있는 핀만" 포함(마커 0개인 핀은 목록 자체가 무의미하므로 제외),
     *    label(없으면 id) 오름차순 정렬.
     *  App.renderSpotList()가 이 결과로 그룹 렌더 + 행 클릭 시 spotRowAction()을 호출하는 용도.
     *  (렌더 자체는 20_App.js 소관이라 이 함수는 순수 데이터만 만든다.) */
    buildSpotGroups(pins, currentPin) {
      const list = Array.isArray(pins) ? pins : [];
      const cur = currentPin || null;
      const groups = [];
      if (cur) groups.push({ pin: cur, spots: Array.isArray(cur.spots) ? cur.spots : [], isCurrent: true });
      const others = list.filter((p) => p && p !== cur && (!cur || p.id !== cur.id) &&
        Array.isArray(p.spots) && p.spots.length > 0);
      others.sort((a, b) => String(a.label || a.id || "").localeCompare(String(b.label || b.id || ""), "ko"));
      others.forEach((p) => groups.push({ pin: p, spots: p.spots, isCurrent: false }));
      return groups;
    },
    /** [P23] 마커 목록 행 클릭 → 어떤 동작을 해야 하는지 결정(순수 함수, 부수효과 없음).
     *  - 같은 사진(그룹)의 마커: 그 마커로 시점 이동(기존 lookAtSpot 재사용) → {type:'look', lon, lat}
     *  - 다른 사진(그룹): 그 사진으로 이동(기존 App.openPano 재사용) → {type:'openPano', pin}
     *  실제 이동 호출은 배선하는 쪽(App.renderSpotList)이 이 반환값을 보고 수행한다. */
    spotRowAction(group, spot) {
      if (!group) return null;
      if (group.isCurrent) {
        if (!spot) return null;
        return { type: "look", lon: spot.lon, lat: spot.lat };
      }
      return { type: "openPano", pin: group.pin };
    },
    /** [마스터: 수평 보정] 천정 기울기 보정 — roll 을 deg 만큼 가감(한계 ±20°). */
    // [토스트 스팸 제거] ↺/↻ 는 0.7°씩 연타하는 버튼이라 클릭마다 토스트가 쌓였다.
    // 보정 결과는 화면이 기울어지는 것으로 즉시 보이므로 토스트 불필요.
    adjustRoll(deg) { this.S.roll = Math.max(-20, Math.min(20, (this.S.roll || 0) + deg)); this._invalidate(); },

    /** [마스터: 360 자동 수평] THETA 등이 JPEG XMP(GPano:PoseRollDegrees)에 박는 천정 기울기를
     *  읽어 자동으로 수평 보정. 메타데이터가 없으면 아무것도 하지 않음(안전). 수동 버튼으로 덮어쓸 수 있음. */
    async _applyGPanoLevel(src) {
      try {
        let bytes;
        if (typeof src === "string" && src.indexOf("data:") === 0) {
          const b64 = src.split(",")[1] || ""; const bin = atob(b64); const n = bin.length;
          bytes = new Uint8Array(n); for (let i = 0; i < n; i++) bytes[i] = bin.charCodeAt(i);
        } else if (typeof src === "string") {
          const r = await fetch(src); bytes = new Uint8Array(await r.arrayBuffer());
        } else { return; }
        const lim = Math.min(bytes.length, 300000); // XMP 는 보통 파일 앞부분
        const text = new TextDecoder("latin1").decode(bytes.subarray(0, lim));
        const m = text.match(/PoseRollDegrees\s*[=>]\s*["']?\s*(-?\d+(?:\.\d+)?)/);
        if (m) {
          const roll = parseFloat(m[1]);
          if (isFinite(roll) && Math.abs(roll) > 0.05 && Math.abs(roll) <= 20) {
            this.S.roll = -roll;   // 카메라 roll 의 역 → 수평 복원
            this._invalidate();
            if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("자동 수평 보정 적용 (" + roll.toFixed(1) + "°) — 하단 ↺/↻로 미세조정");
          }
        }
      } catch (e) { /* 파싱 실패 시 무시(수동 보정 사용) */ }
    },
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

    /** [마스터: 마커 드래그] 편집 권한 + 디자이너 모드일 때만 마커 이동 허용(뷰어는 종전대로 탭=열기만) */
    canEditSpots() {
      return typeof State !== "undefined" && State.mode === "designer" &&
        (typeof Auth === "undefined" || Auth.isDesigner);
    },
    onPointerDown(x, y) {
      this._downX = x; this._downY = y; this._moved = false;
      const hitId = this.canEditSpots() ? this.hitSpotAt(x, y) : null;
      this._dragSpotId = hitId || null;
      if (hitId) {
        // 마커를 잡은 동안엔 카메라가 회전하면 안 됨
        this.S.dragging = false;
        if (this.canvas) this.canvas.style.cursor = "grabbing";
        // [마스터: 이동 화살표] 원래 위치 기억(화살표 시작점) — moveSpot이 spot 데이터를 그 자리에서
        // 바꿔버리므로 드래그 시작 시점의 lon/lat을 별도로 떠 둔다.
        const data = (this._spots || []).find(s => s.id === hitId);
        this._dragOrigLL = data ? { lon: data.lon || 0, lat: data.lat || 0 } : null;
      } else {
        this.S.dragging = true; this.S.lx = x; this.S.ly = y;
      }
    },
    onPointerMove(x, y) {
      if (this._dragSpotId) {
        if (!this._moved && Math.hypot(x - (this._downX || x), y - (this._downY || y)) > 6) {
          this._moved = true;
          this._dragArrowActive = true;
          if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("마커 이동 중 — 놓으면 저장됩니다");
        }
        const ll = this.screenToLonLat(x, y);
        if (ll) {
          this.moveSpot(this._dragSpotId, ll.lon, ll.lat);
          // 전체 재생성 없이 화살표 오브젝트 1개만 갱신(성능 원칙 — moveSpot과 동일)
          if (this._moved && this._dragOrigLL) this._updateDragArrow(this._dragOrigLL, ll);
        }
        return;
      }
      if (!this.S.dragging) return;
      if (Math.hypot(x - (this._downX || x), y - (this._downY || y)) > 6) this._moved = true;
      const k = this.S.fov / 500; // FOV 비례 감도
      this.S.lon += (this.S.lx - x) * k;
      this.S.lat += (y - this.S.ly) * k;
      this.S.lx = x; this.S.ly = y;
      this._invalidate();
    },
    /** 포인터를 뗐을 때: 마커를 실제로 옮겼으면 { spotMoved:id } 반환(호출부가 저장 확정), 아니면 null */
    onPointerUp() {
      this.S.dragging = false;
      const draggedId = this._dragSpotId;
      this._dragSpotId = null;
      this._dragOrigLL = null;
      this._dragArrowActive = false;
      if (this._dragArrow) this._dragArrow.visible = false;
      if (this.canvas) this.canvas.style.cursor = "";
      return (draggedId && this._moved) ? { spotMoved: draggedId } : null;
    },
    /** 마지막 포인터 동작이 '탭'(드래그 아님)이었나 */
    wasTap() { return !this._moved; },

    /* ══════════════════════════════════════════
       [마스터: 구면 안 마커] 360 사진 속 특정 지점(결함/장비/이동)에 핀 — Three.js Sprite 레이어
       · 핀의 spots[{id,lon,lat,label,note,kind}] 를 구면 방향에 빌보드 마커로 렌더.
       · 화면 탭 → 레이캐스트로 (lon,lat) 산출(추가) 또는 마커 적중판정(열기).
    ══════════════════════════════════════════ */
    _ensureSpotGroup() {
      if (!this._spotGroup && this.scene) { this._spotGroup = new THREE.Group(); this.scene.add(this._spotGroup); }
      return this._spotGroup;
    },
    _spotPos(lon, lat, R) {
      const phi = THREE.MathUtils.degToRad(90 - lat), theta = THREE.MathUtils.degToRad(lon);
      return new THREE.Vector3(R * Math.sin(phi) * Math.cos(theta), R * Math.cos(phi), R * Math.sin(phi) * Math.sin(theta));
    },
    // [마스터: 마커 투명화] 채움 알파를 낮춰 뒤 사진이 비치게 하되, 숫자는 검은 헤일로(외곽선)로
    // 감싸 어떤 배경 위에서도 대비를 보장한다(배경 사진 색과 무관 — 헤일로 자체가 로컬 배경 역할).
    SPOT_FILL_ALPHA: .42,
    _spotTexture(spot, idx) {
      const c = document.createElement("canvas"); c.width = c.height = 128;
      const g = c.getContext("2d");
      const col = { defect: "#e0503e", equip: "#e0b14a", safety: "#f2820a", note: "#3a97dd", nav: "#3a97dd" }[spot.kind] || "#e0503e"; // 결함/장비/안전/메모/이동
      g.beginPath(); g.arc(64, 64, 40, 0, Math.PI * 2); g.fillStyle = col; g.globalAlpha = this.SPOT_FILL_ALPHA; g.fill(); g.globalAlpha = 1;
      g.lineWidth = 6; g.strokeStyle = "rgba(255,255,255,.9)"; g.stroke();
      g.font = "bold 52px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
      const label = spot.kind === "nav" ? "" : String(idx + 1);
      g.lineWidth = 8; g.lineJoin = "round"; g.strokeStyle = "rgba(0,0,0,.9)"; g.strokeText(label, 64, 70);
      g.fillStyle = "#fff"; g.fillText(label, 64, 70);
      const t = new THREE.CanvasTexture(c); t.needsUpdate = true; return t;
    },
    renderSpots(spots) {
      const grp = this._ensureSpotGroup(); if (!grp) return;
      while (grp.children.length) { const ch = grp.children.pop(); if (ch.material) { if (ch.material.map) ch.material.map.dispose(); ch.material.dispose(); } }
      this._spots = Array.isArray(spots) ? spots : [];
      this._spots.forEach((s, i) => {
        const mat = new THREE.SpriteMaterial({ map: this._spotTexture(s, i), depthTest: false, depthWrite: false, transparent: true });
        const sp = new THREE.Sprite(mat);
        sp.position.copy(this._spotPos(s.lon || 0, s.lat || 0, 470));
        sp.scale.set(34, 34, 1);
        sp.userData.spotId = s.id;
        sp.renderOrder = 10;
        grp.add(sp);
      });
      this._invalidate();
    },
    _ndc(clientX, clientY) {
      const rect = this.canvas.getBoundingClientRect();
      return new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    },
    /** 화면 좌표 → 구면 방향(lon,lat) — 마커 추가용 */
    screenToLonLat(clientX, clientY) {
      if (!this.renderer || !this.camera) return null;
      const rc = new THREE.Raycaster(); rc.setFromCamera(this._ndc(clientX, clientY), this.camera);
      const d = rc.ray.direction.clone().normalize();
      const lat = 90 - THREE.MathUtils.radToDeg(Math.acos(Math.max(-1, Math.min(1, d.y))));
      const lon = THREE.MathUtils.radToDeg(Math.atan2(d.z, d.x));
      return { lon, lat };
    },
    /** 화면 좌표에 마커가 있으면 그 spotId, 없으면 null */
    hitSpotAt(clientX, clientY) {
      if (!this._spotGroup || !this.camera || !this._spotGroup.children.length) return null;
      const rc = new THREE.Raycaster(); rc.setFromCamera(this._ndc(clientX, clientY), this.camera);
      const hits = rc.intersectObjects(this._spotGroup.children, false);
      return hits.length ? hits[0].object.userData.spotId : null;
    },
    /** [마스터: 마커 드래그] 전체 재생성 없이 스프라이트 1개 position만 갱신(드래그 중 매 프레임 호출).
     *  spot 데이터(this._spots — pin.spots 와 동일 참조)의 lon/lat 도 그 자리에서 갱신해
     *  드래그 종료 시 별도 반영 없이 그대로 저장할 수 있게 한다. */
    moveSpot(id, lon, lat) {
      if (!this._spotGroup) return false;
      let sp = null;
      for (let i = 0; i < this._spotGroup.children.length; i++) {
        if (this._spotGroup.children[i].userData.spotId === id) { sp = this._spotGroup.children[i]; break; }
      }
      if (!sp) return false;
      sp.position.copy(this._spotPos(lon, lat, 470));
      const data = (this._spots || []).find(s => s.id === id);
      if (data) { data.lon = lon; data.lat = lat; }
      this._invalidate();
      return true;
    },
    /** [마스터: 이동 화살표] 드래그 중 "원래 위치 → 현재 위치" 화살표를 1개만 생성해 계속 재사용.
     *  THREE.ArrowHelper가 없는 환경(구형 THREE/목)에서는 조용히 no-op — 드래그 저장 동작에는 영향 없음. */
    _ensureDragArrow() {
      if (this._dragArrow) return this._dragArrow;
      if (!this.scene || typeof THREE === "undefined" || typeof THREE.ArrowHelper !== "function") return null;
      const arrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 0), 1, 0xffffff, 10, 6);
      arrow.visible = false;
      arrow.renderOrder = 20;
      this.scene.add(arrow);
      this._dragArrow = arrow;
      return arrow;
    },
    _updateDragArrow(origLL, curLL) {
      const arrow = this._ensureDragArrow(); if (!arrow) return;
      const from = this._spotPos(origLL.lon, origLL.lat, 470);
      const to = this._spotPos(curLL.lon, curLL.lat, 470);
      const dir = to.clone().sub(from);
      const len = dir.length();
      if (len < 0.01) { arrow.visible = false; return; }
      dir.normalize();
      arrow.position.copy(from);
      arrow.setDirection(dir);
      arrow.setLength(len, Math.min(24, len * 0.35), Math.min(14, len * 0.25));
      arrow.visible = true;
    },
    onWheel(e)    { e.preventDefault(); this.setFov(e.deltaY * 0.05); },

    /** 닫기(×/Esc/뒤로 전부 이 함수 1개로 수렴 — grep 확인됨). 역재생 연출 뒤 실제 정리(_closeImmediate)를 돌린다.
     *  중복 호출(연타)은 Dive.close() 안에서 무시된다("중복 탭 무시"). */
    close() {
      if (!this.open) return;
      this.Dive.close(this, () => this._closeImmediate());
    },
    _closeImmediate() {
      this.open = false;
      this._currentPin = null;
      try { this.renderSpots([]); } catch (e) {}   // 구면 마커 정리
      this._spotAddMode = false;
      this._dragSpotId = null;
      this._dragOrigLL = null;
      this._dragArrowActive = false;
      if (this._dragArrow) this._dragArrow.visible = false;
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
     [WO 20260929-mobile] 모바일(≤760px) 전용 더보기 토글 배선.
     🔴 20_App.js(타 팀 점유)를 건드리지 않는다 — 새 독립 DOMContentLoaded 리스너로
     기존 요소(id·data-* 불변)에 "펼침/접힘" 상태만 덧붙인다. 기존 버튼 클릭 배선은
     20_App.js가 이미 id/class로 elementById/querySelectorAll 하므로 위치·펼침 상태와
     무관하게 그대로 동작(재구현 0). 데스크톱(>760px)은 CSS가 이 토글들을 숨기므로 무해.
     🔴 [p3/p23/p29 회귀수정] 이 파일은 테스트가 vm으로 전체를 그대로 평가하기도 한다
     (document 전역 없이). typeof 가드 없이 최상위에서 document.addEventListener를 부르면
     그 시점에 즉시 ReferenceError가 나 파일 평가 자체가 깨진다 — 실브라우저에서만 실행되게 가드.
  ══════════════════════════════════════════ */
  if (typeof document !== "undefined" && document.addEventListener) {
  document.addEventListener("DOMContentLoaded", () => {
    // [지휘자 발주 2026-10-01] "사진으로 빨려 들어가는" 전환 효과 — 진입점 전수(핀 탭/트리/핀패널/
    // Radar/PanoNav)가 이미 App.openPano() 1개로 수렴한다(grep 확인됨). 20_App.js는 타 팀(열람자
    // 요청 기능) 점유라 편집하지 않고, 위 R1/R2/R4/R6과 같은 방식으로 DOMContentLoaded 이후
    // App.openPano를 비침투적으로 감싸(monkey-patch) Dive.open()을 선두에 끼운다(재구현 0,
    // 원 함수는 그대로 이어서 호출). App.openPano가 아직 없거나 이미 감싸졌으면 건너뛴다.
    if (typeof App !== "undefined" && typeof App.openPano === "function" && !App.openPano.__diveWrapped) {
      const _origOpenPano = App.openPano.bind(App);
      const _wrappedOpenPano = function (pin) {
        if (typeof PanoViewer !== "undefined" && PanoViewer.Dive) PanoViewer.Dive.open(PanoViewer, pin);
        return _origOpenPano(pin);
      };
      _wrappedOpenPano.__diveWrapped = true;
      App.openPano = _wrappedOpenPano;
    }

    // R1/R2 — 파노 헤더 "더보기"(꼭지점4+이슈)
    const moreBtn = document.getElementById("btn-pano-more");
    const morePanel = document.getElementById("pano-header-more");
    if (moreBtn && morePanel) {
      moreBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const open = morePanel.classList.toggle("open");
        moreBtn.classList.toggle("active", open);
        moreBtn.setAttribute("aria-expanded", open ? "true" : "false");
      });
      document.addEventListener("click", (e) => {
        if (!morePanel.classList.contains("open")) return;
        if (morePanel.contains(e.target) || moreBtn.contains(e.target)) return;
        morePanel.classList.remove("open");
        moreBtn.classList.remove("active");
        moreBtn.setAttribute("aria-expanded", "false");
      });
    }

    // R4 — 파노 컨트롤 패드 접기/펼치기
    const toolsBtn = document.getElementById("btn-pano-tools-toggle");
    const toolsPanel = document.getElementById("pano-controls");
    if (toolsBtn && toolsPanel) {
      toolsBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const open = toolsPanel.classList.toggle("mobile-open");
        toolsBtn.classList.toggle("active", open);
        toolsBtn.setAttribute("aria-expanded", open ? "true" : "false");
      });
    }
    // 뷰어를 닫으면 다음 오픈 때 항상 접힌 상태로 시작(마스터: "기본 접힘")
    const closeBtn = document.getElementById("btn-pano-close");
    if (closeBtn && toolsPanel && toolsBtn) {
      closeBtn.addEventListener("click", () => {
        toolsPanel.classList.remove("mobile-open");
        toolsBtn.classList.remove("active");
        toolsBtn.setAttribute("aria-expanded", "false");
      });
    }

    // R6 — 모바일 하단 도크 "더보기" 시트 + 사진 등록(기존 #btn-photobatch 위임, 재구현 0)
    const dockMoreBtn = document.getElementById("mdock-more-toggle");
    const dockMoreSheet = document.getElementById("mdock-more-sheet");
    if (dockMoreBtn && dockMoreSheet) {
      dockMoreBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const open = dockMoreSheet.classList.toggle("open");
        dockMoreBtn.classList.toggle("active", open);
        dockMoreBtn.setAttribute("aria-expanded", open ? "true" : "false");
      });
      // 시트 안의 버튼(보기/편집/페이지/주석/목록/업로드)을 누르면 그 동작은 기존 배선이
      // 처리하고, 여기서는 시트만 닫아 화면을 가리지 않게 한다.
      dockMoreSheet.addEventListener("click", (e) => {
        if (!e.target.closest("button")) return;
        dockMoreSheet.classList.remove("open");
        dockMoreBtn.classList.remove("active");
        dockMoreBtn.setAttribute("aria-expanded", "false");
      });
      document.addEventListener("click", (e) => {
        if (!dockMoreSheet.classList.contains("open")) return;
        if (dockMoreSheet.contains(e.target) || dockMoreBtn.contains(e.target)) return;
        dockMoreSheet.classList.remove("open");
        dockMoreBtn.classList.remove("active");
        dockMoreBtn.setAttribute("aria-expanded", "false");
      });
    }
    const photoBtn = document.getElementById("mdock-photobatch");
    if (photoBtn) {
      photoBtn.addEventListener("click", () => {
        const t = document.getElementById("btn-photobatch");
        if (t) t.click();
      });
    }
  });
  }

  /* ══════════════════════════════════════════
     RADAR — 파노라마 내 도면 미니맵 + 시야 부채꼴 (3DVista radar 참고)
  ══════════════════════════════════════════ */