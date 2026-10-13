  /* ══════════════════════════════════════════════════════════════
     사진 폴더 지정 — 핀 번호 ↔ 파일명 자동 매칭·등록
     ────────────────────────────────────────────────────────────────
     마스터 요청(2026-10-13, 음성): "지정한 폴더에서 핀 번호와 일치하는 360 사진 — 핀만 찍으면
     바로 찾아서 '이 사진을 등록할까요?' 이러면 … 다음부터 핀만 찍으면 이름이 똑같은 사진을
     계속 자동으로 등록하는 기능까지 구현해. 당연히 지정 폴더부터 먼저 지정한 다음에 진행해야겠지."

     기존 35_PhotoBatch.js(시각 최근접/일괄 매칭)와는 완전히 다른 경로다 — 이 모듈은 "파일명 ↔
     핀 번호" 매칭만 담당한다. 등록 자체(저장 API 조합)는 재구현하지 않고 PhotoBatch._uploadOneRow
     (resizeImage/uploadImage/SyncQueue.enqueue, 오프라인 폴백 포함)를 그대로 재사용한다(§10 SoT).
     360 판별도 App._detect360 재사용(자체 판별 로직 추가 금지).

     진입 훅: 20_App.js _handlePlaceClick() 의 State.regMode==="photo" 분기 — 핀 생성 직후
     PhotoFolder.handlePinPlaced(pin) 을 먼저 묻고, false(미처리)면 기존 PhotoBatch.autoConnectPin
     폴백으로 넘어간다(기존 동작 100% 보존 — 폴더 미지정 시 체감 변화 0).

     폴더 핸들 영속화: 새 IndexedDB 스토어/DB버전 업그레이드 없이 SyncQueue.saveDraft/loadDraft
     (05_SyncQueue.js DRAFT_STORE, 기존 스토어 재사용)를 키 "photofolder:<projectId>" 로 재사용한다
     — FileSystemDirectoryHandle 은 구조적 복제(structured clone) 가능해 기존 draft 저장경로에
     그대로 담긴다(§5 사다리: 새 스토어보다 기존 재사용 우선).
  ══════════════════════════════════════════════════════════════ */
  const PhotoFolder = {
    _EXT_RE: /\.(jpe?g|png|heic)$/i,
    _dirHandle: null,
    _permGranted: null,      // handle 모드에서만 의미: true/false/null(미확인)
    _fallbackFiles: null,    // webkitdirectory 스냅샷(File[])
    _mode: null,             // 'handle' | 'fallback' | null(미지정)
    _folderLabel: "",
    _fileCount: null,
    _restoredOnce: false,
    _restoring: null,

    /* ══ 순수 로직 — 회귀 테스트가 직접 호출한다(DOM 무의존) ══════════ */

    /** 소문자화 + 구분자(- _ 공백) 제거 + 선택 접두 "p" 제거 + 앞자리 0 제거(parseInt).
     *  숫자가 아니면 null(매칭 대상 아님 — 조용히 0으로 취급하지 않는다). */
    _normalizeToken(s) {
      let t = String(s == null ? "" : s).toLowerCase().replace(/[-_\s]/g, "");
      t = t.replace(/^p/, "");
      if (!/^\d+$/.test(t)) return null;
      return String(parseInt(t, 10));
    },

    /** 핀 번호(순수 정수) ↔ 파일명(확장자 포함) 1:1 매칭 — 확장자 제거 후 정규화 비교.
     *  예: 12 ↔ "P12.jpg"/"p012.JPG"/"12.jpg"/"P-12.jpeg" 모두 true. 12 ↔ "P120.jpg"/"P1.jpg" false. */
    isMatch(pinNo, filename) {
      const base = String(filename || "").replace(/\.[^.]+$/, "");
      const a = this._normalizeToken(base);
      const b = this._normalizeToken(String(pinNo));
      return a !== null && b !== null && a === b;
    },

    /** 대상 확장자(jpg/jpeg/png/heic) + 번호 일치 항목만. entries: [{name,...}]. 순수 함수. */
    findMatches(pinNo, entries) {
      return (entries || []).filter((e) => e && e.name && this._EXT_RE.test(e.name) && this.isMatch(pinNo, e.name));
    },

    /* ══ 상태/영속화 ══════════════════════════════════════════════ */

    isSupported() { return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function"; },
    hasFolder() {
      if (this._mode === "handle") return !!this._dirHandle;
      if (this._mode === "fallback") return !!(this._fallbackFiles && this._fallbackFiles.length);
      return false;
    },
    _projectId() { return (typeof Projects !== "undefined" && Projects.currentProject && Projects.currentProject.id) || "default"; },
    _draftKey() { return "photofolder:" + this._projectId(); },
    _prefsKey() { return "wm_photofolder_auto_" + this._projectId(); },
    isAutoOn() { try { return localStorage.getItem(this._prefsKey()) === "1"; } catch (e) { return false; } },
    setAuto(on) { try { localStorage.setItem(this._prefsKey(), on ? "1" : "0"); } catch (e) {} this._updateStatusUI(); },

    /** 지원 브라우저: showDirectoryPicker. 미지원: webkitdirectory input 폴백(스냅샷만, 재열거 없음). */
    async pickFolder() {
      if (this.isSupported()) {
        try {
          const handle = await window.showDirectoryPicker({ mode: "read" });
          this._dirHandle = handle; this._mode = "handle"; this._folderLabel = handle.name; this._permGranted = true;
          try { if (typeof SyncQueue !== "undefined" && SyncQueue.saveDraft) await SyncQueue.saveDraft(this._draftKey(), { name: handle.name, handle: handle }); } catch (e) {}
          await this._refreshCount();
          return true;
        } catch (e) { return false; } // 사용자 취소 포함
      }
      this._ensureFallbackInput();
      const input = document.getElementById("photofolder-fallback-input");
      if (input) input.click();
      return null; // 비동기(change 이벤트)로 결정됨
    },

    _ensureFallbackInput() {
      if (document.getElementById("photofolder-fallback-input")) return;
      const input = document.createElement("input");
      input.type = "file"; input.multiple = true; input.id = "photofolder-fallback-input";
      input.setAttribute("webkitdirectory", "");
      input.setAttribute("accept", "image/*");
      input.style.display = "none";
      input.addEventListener("change", (e) => {
        const files = Array.from(e.target.files || []);
        e.target.value = "";
        if (!files.length) return;
        this._fallbackFiles = files;
        this._mode = "fallback";
        this._folderLabel = (files[0] && files[0].webkitRelativePath) ? files[0].webkitRelativePath.split("/")[0] : "선택한 폴더";
        this._fileCount = files.length;
        this._updateStatusUI();
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("사진 폴더 지정됨(" + files.length + "장) — 새 사진이 생기면 폴더를 다시 지정하세요");
      });
      document.body.appendChild(input);
    },

    /** 세션당 1회, IndexedDB에서 이전에 지정한 폴더 핸들을 복원(있으면). 권한은 재요청 전까지
     *  "확인" 상태로만 두고(queryPermission, 사용자 제스처 불필요), 실제 읽기는 requestPermission()
     *  (버튼 클릭 = 사용자 제스처)이 통과해야 진행한다(hasFolder()는 true 여도 permGranted!==true면
     *  handlePinPlaced 가 자동 매칭을 하지 않는다 — §5 "값이 없으면 없다고 정직하게 표시"). */
    async restore() {
      if (this._restoredOnce) return;
      this._restoredOnce = true;
      try {
        if (typeof SyncQueue === "undefined" || !SyncQueue.loadDraft) return;
        const rec = await SyncQueue.loadDraft(this._draftKey());
        if (!rec || !rec.handle) return;
        this._dirHandle = rec.handle; this._mode = "handle"; this._folderLabel = rec.name || rec.handle.name || "";
        try {
          const perm = await this._dirHandle.queryPermission({ mode: "read" });
          this._permGranted = perm === "granted";
        } catch (e) { this._permGranted = false; }
        if (this._permGranted) await this._refreshCount(); else this._updateStatusUI();
      } catch (e) {}
    },

    /** 사용자 제스처(버튼 클릭) 안에서만 호출 — 재방문 시 권한 재요청. */
    async requestPermission() {
      if (!this._dirHandle || typeof this._dirHandle.requestPermission !== "function") return false;
      try {
        const perm = await this._dirHandle.requestPermission({ mode: "read" });
        this._permGranted = perm === "granted";
        if (this._permGranted) await this._refreshCount(); else this._updateStatusUI();
        return this._permGranted;
      } catch (e) { return false; }
    },

    async _listEntries() {
      if (this._mode === "handle" && this._dirHandle) {
        if (this._permGranted === false) return [];
        const out = [];
        try {
          for await (const entry of this._dirHandle.values()) {
            if (entry.kind === "file") out.push({ name: entry.name, getFile: () => entry.getFile() });
          }
        } catch (e) {}
        return out;
      }
      if (this._mode === "fallback" && this._fallbackFiles) {
        return this._fallbackFiles.map((f) => ({ name: f.name, getFile: async () => f }));
      }
      return [];
    },

    async _refreshCount() {
      const entries = await this._listEntries();
      this._fileCount = entries.length;
      this._updateStatusUI();
      return entries;
    },

    _updateStatusUI() {
      const el = document.getElementById("photofolder-status-text");
      const autoCb = document.getElementById("photofolder-auto-cb");
      if (autoCb) autoCb.checked = this.isAutoOn();
      const reBtn = document.getElementById("photofolder-reconnect-btn");
      if (reBtn) reBtn.classList.toggle("hidden", !(this._mode === "handle" && this._permGranted === false));
      if (!el) return;
      if (!this.hasFolder()) { el.textContent = "사진 폴더: 지정 안됨"; return; }
      if (this._mode === "handle" && this._permGranted === false) { el.textContent = "사진 폴더: " + this._folderLabel + " — 재연결 필요"; return; }
      el.textContent = "사진 폴더: " + this._folderLabel + (Number.isFinite(this._fileCount) ? (" (" + this._fileCount + "장)") : "");
    },

    /* ══ DOM 연결 — 상태 바(floating, index.html 비점유) ══════════════ */

    init() {
      this._ensureBar();
      try { this.restore(); } catch (e) {}
    },

    _ensureBar() {
      if (document.getElementById("photofolder-bar")) return;
      const bar = document.createElement("div");
      bar.id = "photofolder-bar";
      bar.className = "hidden";
      bar.setAttribute("style", "position:fixed;left:50%;bottom:64px;transform:translateX(-50%);z-index:900;background:rgba(17,17,17,.92);color:#fff;border-radius:10px;padding:8px 12px;display:flex;align-items:center;gap:8px;font-size:12px;max-width:92vw;flex-wrap:wrap;");
      const status = document.createElement("span"); status.id = "photofolder-status-text"; status.textContent = "사진 폴더: 지정 안됨";
      const pickBtn = document.createElement("button"); pickBtn.type = "button"; pickBtn.id = "photofolder-pick-btn"; pickBtn.textContent = "📁 사진 폴더 지정";
      pickBtn.setAttribute("style", "padding:4px 8px;border-radius:6px;border:1px solid #666;background:#2f6db5;color:#fff;cursor:pointer;font-size:12px;");
      const reBtn = document.createElement("button"); reBtn.type = "button"; reBtn.id = "photofolder-reconnect-btn"; reBtn.textContent = "재연결"; reBtn.className = "hidden";
      reBtn.setAttribute("style", "padding:4px 8px;border-radius:6px;border:1px solid #666;background:#f5f5f5;color:#111;cursor:pointer;font-size:12px;");
      const autoLabel = document.createElement("label"); autoLabel.setAttribute("style", "display:flex;align-items:center;gap:4px;cursor:pointer;");
      const autoCb = document.createElement("input"); autoCb.type = "checkbox"; autoCb.id = "photofolder-auto-cb";
      autoLabel.appendChild(autoCb); autoLabel.appendChild(document.createTextNode("자동 등록"));
      bar.appendChild(status); bar.appendChild(pickBtn); bar.appendChild(reBtn); bar.appendChild(autoLabel);
      document.body.appendChild(bar);
      pickBtn.addEventListener("click", () => this.pickFolder());
      reBtn.addEventListener("click", () => this.requestPermission());
      autoCb.addEventListener("change", () => this.setAuto(autoCb.checked));
      this._updateStatusUI();
    },

    /** [WO 20261013-photofolder §5] 열람자(Auth.readonly)에게는 바를 포함해 기능 0. */
    syncUI() {
      const bar = document.getElementById("photofolder-bar");
      if (!bar) return;
      const readonly = typeof Auth !== "undefined" && Auth.readonly;
      const active = !readonly && typeof State !== "undefined" && State.checkboard && State.regMode === "photo";
      bar.classList.toggle("hidden", !active);
    },

    /* ══ 등록 1건 — PhotoBatch._uploadOneRow 재사용 ══════════════════ */

    _pinNo(pin) {
      try {
        if (typeof PinSeries === "undefined" || !PinSeries.numbers) return null;
        const page = (typeof State !== "undefined" ? (State.pdfPage || 1) : 1);
        const map = PinSeries.numbers(State.pins, page);
        const info = map.get(pin.id);
        return info ? info.no : null;
      } catch (e) { return null; }
    },

    async _registerEntry(pin, entry, source) {
      const file = await entry.getFile();
      const row = { file: file, name: entry.name, sortKey: Number.isFinite(file.lastModified) ? file.lastModified : NaN, timeSource: "폴더 매칭", is360: null, w: 0, h: 0 };
      await new Promise((resolve) => {
        if (typeof App === "undefined" || !App._detect360) { resolve(); return; }
        App._detect360(file, (is360, w, h) => { row.is360 = is360; row.w = w; row.h = h; resolve(); });
      });
      const usedNames = (typeof PhotoBatch !== "undefined" && PhotoBatch._usedPhotoNames) ? PhotoBatch._usedPhotoNames() : new Set();
      const r = (typeof PhotoBatch !== "undefined" && PhotoBatch._uploadOneRow) ? await PhotoBatch._uploadOneRow(pin, row, false, usedNames, source) : { status: "fail", reason: "PhotoBatch 미로드" };
      if (r.status === "done") {
        try { UI.renderPinList(); UI.renderPinsOnMap(); if (typeof PinGrid !== "undefined") PinGrid.render(); } catch (e) {}
        try { App._updateSyncBadge && App._updateSyncBadge(); } catch (e) {}
        try { if (typeof PhotoBatch !== "undefined" && PhotoBatch._markUnsaved) PhotoBatch._markUnsaved(); } catch (e) {}
      }
      return r;
    },

    _undoLast(pin) {
      try {
        pin.imageId = null; pin.imageUrl = null; pin.pendingOpId = null; pin.pendingSync = false;
        pin.imageName = null; pin.origName = null; pin.shotAt = null; pin.shotSrc = null; pin.is360 = false;
        if (typeof UI !== "undefined") { UI.renderPinList(); UI.renderPinsOnMap(); }
        if (typeof PhotoBatch !== "undefined" && PhotoBatch._markUnsaved) PhotoBatch._markUnsaved();
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("등록을 취소했습니다");
      } catch (e) {}
    },

    /* ══ 확인/선택 모달(JS 생성 — index.html 비점유, 기존 pb-tm-panel 관례와 동일) ══════ */

    _ensureConfirmModal() {
      if (document.getElementById("photofolder-confirm-modal")) return;
      const modal = document.createElement("div");
      modal.id = "photofolder-confirm-modal";
      modal.className = "admin-gate-backdrop hidden";
      modal.setAttribute("style", "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;");
      modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.add("hidden"); });
      const panel = document.createElement("div");
      panel.setAttribute("style", "background:#fff;color:#111;max-width:420px;width:88vw;border-radius:12px;padding:18px;");
      const msg = document.createElement("p"); msg.id = "photofolder-confirm-msg"; msg.setAttribute("style", "margin:0 0 14px;font-size:14px;color:#111;");
      const btnBar = document.createElement("div"); btnBar.setAttribute("style", "display:flex;flex-direction:column;gap:8px;");
      const mkBtn = (id, text, primary) => {
        const b = document.createElement("button"); b.type = "button"; b.id = id; b.textContent = text;
        b.setAttribute("style", "padding:10px 14px;border-radius:8px;border:1px solid #ccc;font-size:14px;cursor:pointer;" + (primary ? "background:#2f6db5;color:#fff;border-color:#1d4f88;" : "background:#f5f5f5;color:#111;"));
        return b;
      };
      btnBar.appendChild(mkBtn("photofolder-confirm-register", "등록", true));
      btnBar.appendChild(mkBtn("photofolder-confirm-auto", "앞으로 자동 등록", false));
      btnBar.appendChild(mkBtn("photofolder-confirm-skip", "건너뛰기", false));
      panel.appendChild(msg); panel.appendChild(btnBar);
      modal.appendChild(panel);
      document.body.appendChild(modal);
    },

    _showConfirmModal(pin, no, entry) {
      this._ensureConfirmModal();
      const modal = document.getElementById("photofolder-confirm-modal");
      const label = (typeof PinSeries !== "undefined" && PinSeries.formatNo) ? PinSeries.formatNo(no, "content") : ("P" + no);
      document.getElementById("photofolder-confirm-msg").textContent = label + " ← " + entry.name + " — 이 사진을 등록할까요?";
      const close = () => modal.classList.add("hidden");
      document.getElementById("photofolder-confirm-register").onclick = async () => {
        close();
        const r = await this._registerEntry(pin, entry, "폴더확인");
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast(r.status === "done" ? (label + " ← " + entry.name + " 등록 완료") : ("등록 실패: " + (r.reason || "")));
      };
      document.getElementById("photofolder-confirm-auto").onclick = async () => {
        this.setAuto(true); close();
        const r = await this._registerEntry(pin, entry, "폴더자동");
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast(r.status === "done" ? ("자동 등록 켬 · " + label + " ← " + entry.name + " 등록 완료") : ("등록 실패: " + (r.reason || "")));
      };
      document.getElementById("photofolder-confirm-skip").onclick = () => close();
      modal.classList.remove("hidden");
    },

    _ensurePickModal() {
      if (document.getElementById("photofolder-pick-modal")) return;
      const modal = document.createElement("div");
      modal.id = "photofolder-pick-modal";
      modal.className = "admin-gate-backdrop hidden";
      modal.setAttribute("style", "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;");
      modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.add("hidden"); });
      const panel = document.createElement("div");
      panel.setAttribute("style", "background:#fff;color:#111;max-width:420px;width:88vw;max-height:70vh;overflow:auto;border-radius:12px;padding:18px;");
      const title = document.createElement("p"); title.id = "photofolder-pick-title"; title.setAttribute("style", "margin:0 0 10px;font-size:14px;color:#111;");
      const list = document.createElement("div"); list.id = "photofolder-pick-list";
      const cancelBtn = document.createElement("button"); cancelBtn.type = "button"; cancelBtn.id = "photofolder-pick-cancel"; cancelBtn.textContent = "취소";
      cancelBtn.setAttribute("style", "margin-top:10px;padding:8px 14px;border-radius:8px;border:1px solid #ccc;background:#f5f5f5;color:#111;cursor:pointer;font-size:14px;");
      panel.appendChild(title); panel.appendChild(list); panel.appendChild(cancelBtn);
      modal.appendChild(panel);
      document.body.appendChild(modal);
      cancelBtn.addEventListener("click", () => modal.classList.add("hidden"));
    },

    _showPickModal(pin, no, candidates) {
      this._ensurePickModal();
      const modal = document.getElementById("photofolder-pick-modal");
      const list = document.getElementById("photofolder-pick-list");
      list.innerHTML = "";
      const label = (typeof PinSeries !== "undefined" && PinSeries.formatNo) ? PinSeries.formatNo(no, "content") : ("P" + no);
      document.getElementById("photofolder-pick-title").textContent = label + " — 일치하는 사진이 여러 개입니다. 선택하세요";
      candidates.forEach((entry) => {
        const b = document.createElement("button"); b.type = "button"; b.textContent = entry.name; b.className = "photofolder-pick-item";
        b.setAttribute("style", "display:block;width:100%;text-align:left;padding:8px 10px;margin-bottom:6px;border-radius:6px;border:1px solid #ccc;background:#f5f5f5;color:#111;cursor:pointer;");
        b.addEventListener("click", async () => {
          modal.classList.add("hidden");
          const r = await this._registerEntry(pin, entry, "폴더선택");
          if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast(r.status === "done" ? (label + " ← " + entry.name + " 등록 완료") : ("등록 실패: " + (r.reason || "")));
        });
        list.appendChild(b);
      });
      modal.classList.remove("hidden");
    },

    /* ══ [핵심 API] 20_App.js 360 핀 생성 훅 ══════════════════════════
       @returns {Promise<boolean>} true=이 모듈이 처리함(호출부가 기존 폴백을 하지 않는다),
       false=미처리(호출부가 PhotoBatch.autoConnectPin 등 기존 경로로 폴백해야 한다). */
    async handlePinPlaced(pin) {
      try {
        if (!pin) return false;
        if (typeof Auth !== "undefined" && Auth.readonly) return false;
        if (typeof PinSeries !== "undefined" && PinSeries.seriesOf && PinSeries.seriesOf(pin) === "checkboard") return false;
        if (typeof PinSeries !== "undefined" && PinSeries.mediaOf && PinSeries.mediaOf(pin)) return false; // 이미 사진 있는 핀은 덮어쓰지 않는다
        if (!this.hasFolder()) return false;
        if (this._mode === "handle" && this._permGranted === false) return false; // 재연결 전엔 자동 매칭 안 함
        const no = this._pinNo(pin);
        if (no == null) return false;
        const entries = await this._listEntries();
        const candidates = this.findMatches(no, entries);
        if (!candidates.length) {
          const label = (typeof PinSeries !== "undefined" && PinSeries.formatNo) ? PinSeries.formatNo(no, "content") : ("P" + no);
          if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("폴더에 " + label + " 사진이 없습니다");
          return false;
        }
        if (candidates.length > 1) { this._showPickModal(pin, no, candidates); return true; }
        const entry = candidates[0];
        if (this.isAutoOn()) {
          const r = await this._registerEntry(pin, entry, "폴더자동");
          const label = (typeof PinSeries !== "undefined" && PinSeries.formatNo) ? PinSeries.formatNo(no, "content") : ("P" + no);
          if (typeof Prompt !== "undefined" && Prompt.toast) {
            if (r.status === "done") {
              Prompt.toast(label + " ← " + entry.name + " 자동 등록" + (r.offline ? "(오프라인 저장됨)" : "") + " · [되돌리기]", 4000, { action: { label: "되돌리기", onClick: () => this._undoLast(pin) } });
            } else {
              Prompt.toast("자동 등록 실패: " + (r.reason || ""));
            }
          }
          return true;
        }
        this._showConfirmModal(pin, no, entry);
        return true;
      } catch (e) { return false; }
    }
  };
