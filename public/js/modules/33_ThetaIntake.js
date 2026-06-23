  /* ══════════════════════════════════════════════════════════════
     THETA 360 인입 — 오프라인 R* 360 사진을 가져와 도면에 핀 위치 지정 등록
     ────────────────────────────────────────────────────────────────
     · 마스터 요청: THETA 앱이 폰에 저장한 R*(R00xxxxx.JPG) 360 사진이 "들어오면",
       이 프로젝트 도면 위에 "사진 위치를 등록할 핀을 지정"하는 기능. 오프라인 동작.
     · 흐름: [360 인입] 버튼 → 갤러리에서 R* 360 사진 다중 선택 → R*·2:1 필터 →
       미배치 트레이(IndexedDB 영속) → 사진 탭 → 도면에서 위치 탭 → 그 자리에 360 핀 등록.
       오프라인이면 OpLog/SyncQueue 큐잉 → 온라인 시 "↑ 지금 올리기"로 반영.
     · 통합: 위치 탭은 기존 배치 흐름(App._handlePlaceClick) 재사용. 인입 사진은
       State.intakeFile 로 주입 → 파일 선택 없이 _acceptPinMediaFile 로 360 핀 자동 등록.
  ══════════════════════════════════════════════════════════════ */
  const ThetaIntake = {
    _pending: [],          // [{ id, name, dataURL }]
    _activeId: null,
    _KEY: "theta_intake_v1",

    init() {
      const $ = (id) => document.getElementById(id);
      $("btn-theta-intake") && $("btn-theta-intake").addEventListener("click", () => this.openPicker());
      const inp = $("input-theta-intake");
      if (inp) inp.addEventListener("change", (e) => { const files = Array.from(e.target.files || []); e.target.value = ""; this.importFiles(files); });
      $("theta-tray-close") && $("theta-tray-close").addEventListener("click", () => this.hideTray());
      this._restore();
      // [마스터: 사진 들어오면 트리거] 공유로 들어온 사진 자동 인입(?shared=1)
      try { if (new URLSearchParams(location.search).get("shared") === "1") this.handleShared(); } catch (e) {}
    },

    /** Web Share Target 으로 들어온 사진을 캐시에서 읽어 자동 인입(트리거). */
    async handleShared() {
      // [견고화] ?shared=1 을 URL 에서 제거(항상) → 리로드/controllerchange 시 재실행·재인입 방지.
      try {
        const u = new URL(location.href);
        if (u.searchParams.has("shared")) { u.searchParams.delete("shared"); history.replaceState(null, "", u.pathname + u.search + u.hash); }
      } catch (e) {}
      try {
        if (!("caches" in window)) return;
        const cache = await caches.open("wm-shared");
        const idxRes = await cache.match("/__shared__/index");
        if (!idxRes) return;
        const meta = await idxRes.json();
        const ids = meta.ids || [], names = meta.names || [];
        const files = [];
        for (let i = 0; i < ids.length; i++) {
          const r = await cache.match(ids[i]);
          if (r) { const blob = await r.blob(); files.push(new File([blob], names[i] || ("shared-" + i + ".jpg"), { type: blob.type || "image/jpeg" })); }
        }
        for (const id of ids) { try { await cache.delete(id); } catch (e) {} }
        try { await cache.delete("/__shared__/index"); } catch (e) {}
        if (files.length) {
          await this.importFiles(files, { lenient: true });  // 공유=명시적 의도 → R* 아니어도 360이면 인입
        }
      } catch (e) {}
    },

    openPicker() {
      if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("🌐 THETA로 찍은 R* 360 사진을 선택하세요 (여러 장 가능)");
      const inp = document.getElementById("input-theta-intake");
      if (inp) inp.click();
    },

    _isR(name) { return /^r/i.test((name || "").trim()); },

    /** 2:1 equirectangular(THETA 360) 여부 — 실제 픽셀 비율 검사 */
    _is360(file) {
      return new Promise((resolve) => {
        try {
          const url = URL.createObjectURL(file);
          const im = new Image();
          im.onload = () => { const r = im.naturalWidth / Math.max(1, im.naturalHeight); URL.revokeObjectURL(url); resolve(r >= 1.8 && r <= 2.2); };
          im.onerror = () => { URL.revokeObjectURL(url); resolve(false); };
          im.src = url;
        } catch (e) { resolve(false); }
      });
    },

    _toDataURL(file) {
      return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = () => reject(fr.error || new Error("read fail"));
        fr.readAsDataURL(file);
      });
    },

    _dataURLtoFile(dataURL, name) {
      try {
        const arr = String(dataURL).split(",");
        const mime = (arr[0].match(/:(.*?);/) || [])[1] || "image/jpeg";
        const bstr = atob(arr[1]); let n = bstr.length; const u8 = new Uint8Array(n);
        while (n--) u8[n] = bstr.charCodeAt(n);
        return new File([u8], name || "theta_360.jpg", { type: mime });
      } catch (e) { return null; }
    },

    async importFiles(files, opts) {
      if (!files || !files.length) return;
      const lenient = !!(opts && opts.lenient);   // 공유로 들어온 경우: R* 아니어도 360이면 인입
      let accepted = 0, skipped = 0;
      for (const f of files) {
        if (!f.type || !f.type.startsWith("image/")) { skipped++; continue; }
        if (!lenient && !this._isR(f.name)) { skipped++; continue; }     // R* 파일명만 (버튼 인입)
        const ok360 = await this._is360(f);
        if (!ok360) { skipped++; continue; }                 // THETA equirectangular(2:1)만
        try {
          const dataURL = await this._toDataURL(f);
          this._pending.push({ id: "ti_" + Date.now() + "_" + accepted, name: f.name, dataURL: dataURL });
          accepted++;
        } catch (e) { skipped++; }
      }
      await this._persist();
      this.renderTray(); this.showTray();
      if (typeof Prompt !== "undefined" && Prompt.toast)
        Prompt.toast("🌐 360 인입 " + accepted + "장" + (skipped ? " · 제외 " + skipped + "장(R*/360 아님)" : "") + (accepted ? " — 사진을 눌러 도면에 위치를 지정하세요" : ""));
    },

    renderTray() {
      const list = document.getElementById("theta-tray-list");
      const cnt = document.getElementById("theta-tray-count");
      if (cnt) cnt.textContent = this._pending.length;
      if (!list) return;
      if (!this._pending.length) { list.innerHTML = '<div class="theta-tray-empty">미배치 360 사진이 없습니다.</div>'; return; }
      const esc = (s) => (typeof UI !== "undefined" && UI.escapeHtml) ? UI.escapeHtml(s) : s;
      list.innerHTML = this._pending.map((p) =>
        '<div class="theta-item" data-id="' + p.id + '">' +
          '<img class="theta-thumb" src="' + p.dataURL + '" alt="" />' +
          '<div class="theta-item-name" title="' + esc(p.name) + '">' + esc(p.name) + '</div>' +
          '<button class="theta-item-assign" type="button">위치 지정 ›</button>' +
        '</div>'
      ).join("");
      list.querySelectorAll(".theta-item").forEach((el) => {
        const id = el.dataset.id;
        const go = () => this.assign(id);
        const ab = el.querySelector(".theta-item-assign"); if (ab) ab.addEventListener("click", go);
        const th = el.querySelector(".theta-thumb"); if (th) th.addEventListener("click", go);
      });
    },
    showTray() { const t = document.getElementById("theta-tray"); if (t && this._pending.length) t.classList.remove("hidden"); },
    hideTray() { const t = document.getElementById("theta-tray"); if (t) t.classList.add("hidden"); },

    /** 사진 선택 → 배치 모드 진입(도면에서 위치 탭 대기). 도면 탭은 App._handlePlaceClick 가 처리. */
    assign(id) {
      const item = this._pending.find((p) => p.id === id) || this._pending[0];
      if (!item) return;
      if (typeof App === "undefined" || !App._handlePlaceClick) { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("도면을 먼저 연 뒤 다시 시도하세요"); return; }
      const file = this._dataURLtoFile(item.dataURL, item.name);
      if (!file) { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("사진을 읽지 못했습니다"); return; }
      this._activeId = item.id;
      State.intakeFile = file;
      this.hideTray();
      if (!State.placing) App._togglePlacing();   // 배치 모드 ON (도면 탭 대기)
      if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("📍 '" + item.name + "' — 도면에서 이 사진의 위치를 탭하세요");
    },

    /** App._handlePlaceClick 에서 인입 사진을 핀에 주입·등록한 직후 호출 — 트레이에서 제거·진행 */
    _afterPlaced() {
      const id = this._activeId; this._activeId = null;
      if (id) this._pending = this._pending.filter((p) => p.id !== id);
      this._persist();
      this.renderTray();
      if (this._pending.length) {
        this.showTray();
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("✅ 등록 — 남은 360 인입 " + this._pending.length + "장. 계속 지정하세요");
      } else {
        this.hideTray();
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("✅ 360 인입 사진 위치 등록 완료" + (navigator.onLine ? "" : " — 온라인 시 '↑ 지금 올리기'로 반영"));
      }
    },

    async _persist() {
      try { if (typeof SyncQueue !== "undefined" && SyncQueue.saveDraft) await SyncQueue.saveDraft(this._KEY, this._pending); } catch (e) {}
    },
    async _restore() {
      try {
        if (typeof SyncQueue === "undefined" || !SyncQueue.loadDraft) return;
        const d = await SyncQueue.loadDraft(this._KEY);
        if (d && Array.isArray(d) && d.length) { this._pending = d; this.renderTray(); this.showTray(); }
      } catch (e) {}
    },
  };
