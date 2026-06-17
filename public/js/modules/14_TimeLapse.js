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