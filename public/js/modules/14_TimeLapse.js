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
      // [WO 20261002-gap 묶음A④⑤] 원본 보기·되돌리기·삭제(이력)
      $("btn-tl-revert") && $("btn-tl-revert").addEventListener("click", () => this.revertCurrent());
      $("btn-tl-delete") && $("btn-tl-delete").addEventListener("click", () => this.deleteShot());
    },

    /** 핀의 timeline을 정규화 (단일 파노라마 fallback 포함).
     *  [WO 20261002-gap 묶음A②] 촬영시각 SoT = shotAt — capturedAt은 과거 데이터 호환용 읽기 폴백.
     *  rawIndex: pin.timeline 안의 실제 배열 index(현재/승격 전 "current" 슬롯은 -1) — 되돌리기·삭제가
     *  정확한 항목을 가리키도록(정규화 배열은 매번 새 객체라 참조 비교를 쓸 수 없다). */
    _normalize(pin) {
      const out = [];
      if (Array.isArray(pin.timeline) && pin.timeline.length) {
        pin.timeline.forEach((t, i) => {
          if (!t) return;
          out.push({
            id: t.id || ("tl" + i),
            rawIndex: i,
            label: t.label || ("시점 " + (i + 1)),
            imageId: t.imageId || null,
            imageUrl: t.imageUrl || null,
            pendingOpId: t.pendingOpId || null,
            origKey: t.origKey || null,
            isVideo: !!t.isVideo,
            capturedAt: (Number.isFinite(t.shotAt) ? t.shotAt : null) || t.capturedAt || null,
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
            rawIndex: -1,
            label: out.length ? "현재" : (pin.label || "현재"),
            imageId: pin.imageId || null,
            imageUrl: pin.imageUrl || null,
            pendingOpId: pin.pendingOpId || null,
            origKey: pin.origKey || null,
            isVideo: !!(pin.videoUrl || pin.isVideo),
            videoUrl: pin.videoUrl || null,
            capturedAt: (Number.isFinite(pin.shotAt) ? pin.shotAt : null) || pin.capturedAt || null,
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
      if (this._shots.length < 2) { bar.classList.add("hidden"); this._renderActions(); return; }
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
      this._renderActions();
    },

    /** [WO 20261002-gap 묶음A④⑤] 선택된 시점의 원본 보기 링크 + 되돌리기·삭제 버튼 노출 제어.
     *  원본 보기 = 누구나(열람 전용 — 신규 업로드 아님). 되돌리기 = 편집 권한. 삭제(이력) = 관리자만. */
    _renderActions() {
      const $ = (id) => document.getElementById(id);
      // 원본 링크는 선택 시점(있으면)·없으면 핀의 현재 사진 기준(타임라인 바가 숨겨진 단일사진 핀도 노출)
      const shot = this.currentShot() || (this._shots[this._shots.length - 1] || null);
      const origKey = (shot && shot.origKey) || (this._pin && this._pin.origKey) || null;
      const origBtn = $("btn-pano-orig");
      if (origBtn) {
        if (origKey) {
          origBtn.href = (typeof Auth !== "undefined" && Auth.r2) ? Auth.r2(origKey) : origKey;
          origBtn.classList.remove("hidden");
        } else { origBtn.classList.add("hidden"); origBtn.removeAttribute("href"); }
      }
      const canEdit = typeof PanoViewer !== "undefined" && PanoViewer.canEditSpots && PanoViewer.canEditSpots();
      const isAdmin = typeof Auth !== "undefined" && Auth.isAdmin;
      const revertBtn = $("btn-tl-revert");
      if (revertBtn) revertBtn.classList.toggle("hidden", !(canEdit && shot && shot.rawIndex >= 0));
      const deleteBtn = $("btn-tl-delete");
      if (deleteBtn) deleteBtn.classList.toggle("hidden", !(isAdmin && shot && shot.rawIndex >= 0));
    },

    /** [WO 20261002-gap 묶음A⑤] 선택한 과거 시점을 "현재"로 되돌린다 — 지금 현재는 이력으로 적립.
     *  (이미 현재인 시점(rawIndex===-1)은 되돌릴 대상이 아니다.) */
    revertCurrent() {
      const shot = this.currentShot(), pin = this._pin;
      if (!shot || !pin || shot.rawIndex == null || shot.rawIndex < 0) return;
      if (!Array.isArray(pin.timeline)) return;
      if (typeof PhotoNaming !== "undefined" && PhotoNaming.pushHistory) PhotoNaming.pushHistory(pin, "되돌리기");
      pin.timeline.splice(shot.rawIndex, 1); // 되돌린 항목은 이력에서 제거 → 현재로 승격
      pin.imageId = shot.imageId || null;
      pin.imageUrl = shot.imageUrl || null;
      pin.pendingOpId = shot.pendingOpId || null;
      pin.origKey = shot.origKey || null;
      pin.isVideo = !!shot.isVideo;
      if (shot.capturedAt != null) { pin.shotAt = shot.capturedAt; pin.shotSrc = "되돌림"; }
      try { App._markDirty && App._markDirty(); } catch (e) {}
      try { UI.renderPinsOnMap && UI.renderPinsOnMap(); UI.renderPinList && UI.renderPinList(); } catch (e) {}
      if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("이전 사진으로 되돌렸습니다 (미저장)");
      this.setPin(pin);
    },

    /** [WO 20261002-gap 묶음A⑤] 이력 항목 1개를 완전히 삭제(관리자). 현재(아직 승격 전) 사진은
     *  대상이 아니다 — 먼저 되돌리기로 교체한 뒤 지워야 한다(조용한 데이터 소실 금지). */
    async deleteShot() {
      const shot = this.currentShot(), pin = this._pin;
      if (!shot || !pin || shot.rawIndex == null || shot.rawIndex < 0) return;
      if (!Array.isArray(pin.timeline)) return;
      const ok = (typeof Prompt !== "undefined" && Prompt.confirm)
        ? await Prompt.confirm("이력 삭제", "이 시점(" + (shot.label || "") + ")을 이력에서 완전히 삭제합니다. 되돌릴 수 없습니다.")
        : true;
      if (!ok) return;
      pin.timeline.splice(shot.rawIndex, 1);
      try { App._markDirty && App._markDirty(); } catch (e) {}
      this._idx = Math.max(0, this._idx - 1);
      if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("이력 삭제됨 (미저장)");
      this.setPin(pin);
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