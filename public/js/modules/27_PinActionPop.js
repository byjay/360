  /** 사진 URL 로 허용하는 확장자(이미지·영상) — pap-photo-url 검증의 유일한 기준(SoT). */
  const PAP_URL_RE = /^https?:\/\/.+\.(jpe?g|png|gif|webp|bmp|mp4|webm|mov)(\?.*)?$/i;
  const PAP_VIDEO_RE = /\.(mp4|webm|mov)(\?.*)?$/i;

  /** [WO 20260921] 🔴 등록 종류(B#pf-tools 흡수) — SoT. 라벨/순서가 여기 하나뿐이면
   *  중복 배치가 물리적으로 불가능하다(렌더 지점이 한 곳: _renderRegTools). */
  const PAP_REG_CATS = [
    { id: "photo", label: "사진" },
    { id: "theta", label: "360" },
    { id: "doc",   label: "문서" },
    { id: "note",  label: "노트" },
    { id: "video", label: "동영상" },
    { id: "url",   label: "URL" }
  ];
  /** 모바일 기준(720px) — style.css 전역과 동일 값(2720/2769 등). CSS 는 타 팀 점유라
   *  JS 로 직접 판정한다(인라인 스타일 방식은 이 파일 상단 주석과 동일 이유). */
  const PAP_MOBILE_MQ = "(max-width: 720px)";

  const PinActionPop = {
    _pinId: null,
    _layoutDone: false,

    /** [마스터 2026-09-17] 패널 = 화면 오른쪽 고정, 상(정보)/하(사진) 2분할.
     *  style.css 는 타 에이전트 점유 중이라 신규 클래스를 만들지 않고 인라인 스타일로 배치한다.
     *  ISO 전환 코드는 여기 없다(핀 클릭 시 ISO 를 켜지 않는다 — 마스터 명시). */
    _applyLayoutOnce() {
      if (this._layoutDone) return;
      this._layoutDone = true;
      const pop = document.getElementById("pin-action-pop");
      const card = document.getElementById("pap-card");
      if (pop) { pop.style.display = "flex"; pop.style.alignItems = "stretch"; pop.style.justifyContent = "flex-end"; }
      if (card) {
        card.style.cssText += "width:380px;max-width:92vw;height:100vh;max-height:100vh;" +
          "border-radius:0;display:flex;flex-direction:column;margin:0;";
      }
    },

    init() {
      const $ = (id) => document.getElementById(id);
      const el = $("pin-action-pop");
      if (!el) return;
      this._applyLayoutOnce();
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
        Prompt.toast && Prompt.toast("'" + (pin.label || ("#" + (pin.page||1))) + "' 이동 잠금 해제 — 도면에서 핀을 드래그하세요");
      });
      // [WO 20260921] 🔴 이중 편집창 제거 — B(#section-pin-form) 를 더 이상 열지 않는다.
      //   A 안에서 이미 위치명·사진·문서·노트를 전부 편집할 수 있으므로, 라벨 입력에
      //   포커스만 이동시켜 "여기서 바로 수정하라"는 신호만 준다(새 창 0).
      $("pap-edit") && $("pap-edit").addEventListener("click", () => {
        const pin = this._pin(); if (!pin) return;
        const input = $("pap-label-input");
        if (input && !input.readOnly) { input.focus(); input.select(); }
        Prompt.toast && Prompt.toast("아래에서 위치명·사진·노트를 바로 수정하세요");
      });
      $("pap-del") && $("pap-del").addEventListener("click", () => {
        const pin = this._pin(); if (!pin) return;
        this.close();
        App.deletePin(pin.id);
      });
      // ── 등록정보(위치명) / 번호 수정 — 저장은 명시 버튼(자동저장 OFF, 미저장 표시만) ──
      $("pap-label-save") && $("pap-label-save").addEventListener("click", () => this._saveLabel());
      // ── 사진 미리보기 클릭 → 전체화면(기존 파노 뷰어 경로 재사용) ──
      $("pap-photo-img") && $("pap-photo-img").addEventListener("click", () => {
        const pin = this._pin(); if (!pin) return;
        this.close();
        App.openPano(pin);
      });
      // ── 사진 등록: 파일 선택 ──
      $("pap-photo-file") && $("pap-photo-file").addEventListener("change", (e) => {
        const file = e.target.files && e.target.files[0];
        this._registerPhotoFile(file);
      });
      // ── 사진 등록: 경로(URL) 직접 입력 — 검증 없이 저장 금지 ──
      $("pap-photo-url-add") && $("pap-photo-url-add").addEventListener("click", () => this._registerPhotoUrl());
      // ── 노트(이슈) 등록 — 13_Notes.js 재사용(같은 /api/notes) ──
      $("pap-notes-submit") && $("pap-notes-submit").addEventListener("click", () => this._submitNote());
      // ── [WO 20260921] 등록 종류 선택(위임 바인딩, 중복 방지) ──
      const regGrid = $("pap-reg-tools");
      if (regGrid && !regGrid._papBound) {
        regGrid.addEventListener("click", (e) => {
          const btn = e.target.closest(".pap-reg-btn");
          if (!btn || btn.classList.contains("hidden")) return;
          this._selectRegCategory(btn.dataset.reg);
        });
        regGrid._papBound = true;
      }
      // ── 문서 등록: 파일 선택(다중) ──
      $("pap-doc-file") && $("pap-doc-file").addEventListener("change", (e) => {
        const files = Array.from(e.target.files || []);
        e.target.value = "";
        files.forEach((f) => this._registerDocFile(f));
      });
      // 화면 폭이 바뀌어도(모바일↔데스크톱 회전 등) 등록 종류 노출 상태를 다시 계산한다.
      if (typeof window !== "undefined" && window.addEventListener) {
        window.addEventListener("resize", () => { if (!el.classList.contains("hidden")) this._applyRegVisibility(); });
      }
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !el.classList.contains("hidden")) this.close();
      });
    },

    /** [WO 20260921] 등록 종류 그리드 렌더 — 렌더 지점이 여기 하나뿐(중복 배치 물리적으로 불가). */
    _renderRegTools() {
      const grid = document.getElementById("pap-reg-tools");
      if (!grid) return;
      const cur = this._regCat || "photo";
      grid.innerHTML = PAP_REG_CATS.map((c) => {
        const active = c.id === cur;
        const style = "padding:6px 10px;border-radius:8px;font-size:12px;cursor:pointer;border:1px solid " +
          (active ? "#0f172a;background:#0f172a;color:#fff;" : "rgba(0,0,0,.14);background:#f8fafc;color:#334155;");
        return `<button type="button" class="pap-reg-btn" data-reg="${c.id}" aria-pressed="${active}" style="${style}">${c.label}</button>`;
      }).join("");
      this._applyRegVisibility();
      this._selectRegCategory(cur); // 버튼 active 색상 + 문서박스 표시/숨김 상태를 한 곳(SoT)에서 동기화
    },

    /** querySelectorAll 미지원 환경(테스트 fake DOM 등)에서도 안전하게 빈 배열을 준다. */
    _regBtns(grid) {
      return (grid && typeof grid.querySelectorAll === "function") ? Array.from(grid.querySelectorAll(".pap-reg-btn")) : [];
    },

    /** 모바일(≤720px)에서는 '사진'만 노출 — 마스터 기존 지시(B#pf-tools 와 동일 규칙, CSS 미의존). */
    _applyRegVisibility() {
      const grid = document.getElementById("pap-reg-tools");
      if (!grid) return;
      const mobile = !!(window.matchMedia && window.matchMedia(PAP_MOBILE_MQ).matches);
      this._regBtns(grid).forEach((btn) => {
        btn.classList.toggle("hidden", mobile && btn.dataset.reg !== "photo");
      });
      const hint = document.getElementById("pap-reg-mobile-hint");
      if (hint) hint.classList.toggle("hidden", !mobile);
    },

    /** 등록 종류 선택 — 사진/URL/360 은 기존 단일 위젯 재사용(중복 위젯 생성 금지),
     *  노트는 이미 상단에 있는 위젯으로 포커스만 이동, 문서만 신규 위젯 표시. */
    _selectRegCategory(cat) {
      this._regCat = cat;
      const grid = document.getElementById("pap-reg-tools");
      this._regBtns(grid).forEach((b) => {
        const active = b.dataset.reg === cat;
        b.setAttribute("aria-pressed", String(active));
        b.style.background = active ? "#0f172a" : "#f8fafc";
        b.style.color = active ? "#fff" : "#334155";
        b.style.borderColor = active ? "#0f172a" : "rgba(0,0,0,.14)";
      });
      const $ = (id) => document.getElementById(id);
      const title = $("pap-reg-title");
      const docBox = $("pap-doc-register");
      if (docBox) docBox.classList.toggle("hidden", cat !== "doc");
      if (title) title.textContent = (cat === "doc") ? "문서" : "사진";
      if (cat === "note") {
        const top = $("pap-top"); if (top) top.scrollTop = 0;
        const noteInput = $("pap-notes-input"); if (noteInput) noteInput.focus();
        return;
      }
      if (cat === "theta" && Prompt.toast) Prompt.toast("RICOH THETA 360 사진도 '사진'과 동일하게 등록됩니다(파일 선택 또는 경로)");
      if (cat === "video" && Prompt.toast) Prompt.toast("동영상은 경로(URL, .mp4/.webm/.mov)로 등록하세요");
      if (cat === "url" || cat === "video") { const u = $("pap-photo-url"); if (u) u.focus(); }
    },
    _pin() { return (State.pins || []).find(p => p.id === this._pinId) || null; },

    /** 편집 권한(번호 수정·사진 등록·노트 작성) = 디자이너만. 뷰어는 보기 전용. */
    _canEdit() {
      if (typeof Auth !== "undefined" && Auth && typeof Auth.isDesigner !== "undefined") return !!Auth.isDesigner;
      return (typeof State !== "undefined" && State.mode === "designer");
    },

    open(pinId) {
      const el = document.getElementById("pin-action-pop");
      if (!el) return;
      const pin = (State.pins || []).find(p => p.id === pinId);
      if (!pin) return;
      this._pinId = pinId;
      this._applyLayoutOnce();
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

      const canEdit = this._canEdit();

      // ── 등록정보/번호(위치명) — 뷰어는 읽기전용 ──
      const labelInput = $("pap-label-input");
      if (labelInput) {
        labelInput.value = pin.label || "";
        labelInput.readOnly = !canEdit;
      }
      const labelSaveBtn = $("pap-label-save");
      if (labelSaveBtn) labelSaveBtn.classList.toggle("hidden", !canEdit);
      const labelHint = $("pap-label-hint");
      if (labelHint) labelHint.textContent = "";

      this._renderPhoto(pin, canEdit);
      this._loadNotes(pin, canEdit);
      // [WO 20260921] 등록 종류 그리드 — 열 때마다 '사진'으로 초기화(이전 핀의 선택 상태 유지 금지)
      this._regCat = "photo";
      this._renderRegTools();
      this._renderDocList(pin);

      el.classList.remove("hidden");
    },
    close() {
      const el = document.getElementById("pin-action-pop");
      if (el) el.classList.add("hidden");
      this._pinId = null;
    },

    /** ── 등록정보/번호 저장 — 자동저장 OFF: pin.label 만 갱신하고 미저장 표시만 남긴다 ──
     *  [WO 20260918] 🔴 체크보드 핀은 label 이 곧 번호(유일해야 함) — 이미 쓰는 번호로
     *  바꾸려 하면 조용히 삼키지 않고 거부한다(01b_PinSeries.js validateCheckboardLabel 정본).
     *  콘텐츠/빈 핀은 label 이 자유 텍스트라 이 검증을 적용하지 않는다(기존 동작 불변). */
    _saveLabel() {
      const pin = this._pin(); if (!pin) return;
      if (!this._canEdit()) return;
      const $ = (id) => document.getElementById(id);
      const v = ($("pap-label-input") && $("pap-label-input").value || "").trim();
      if (pin.checkboard && typeof PinSeries !== "undefined" && PinSeries.validateCheckboardLabel) {
        const check = PinSeries.validateCheckboardLabel(State.pins, pin.page || 1, pin.id, v);
        if (!check.ok) {
          const hintEl = $("pap-label-hint");
          if (hintEl) hintEl.textContent = check.reason;
          Prompt.toast && Prompt.toast(check.reason);
          return; // 저장하지 않는다 — 조용한 실패 금지(이유를 보여주고 중단)
        }
      }
      pin.label = v;
      if (typeof App !== "undefined" && App._markDirty) App._markDirty();
      if (!navigator.onLine && typeof OpLog !== "undefined" && OpLog.recordCurrent) { try { OpLog.recordCurrent("pin", "upsert", pin.id, pin); } catch (e) {} }
      if (typeof UI !== "undefined") { UI.renderPinsOnMap && UI.renderPinsOnMap(); UI.renderPinList && UI.renderPinList(); }
      // 화면 갱신(번호/제목/메타 재계산) — 페이지 재조회 없이 open()의 표시 로직만 재사용
      const page = pin.page || 1;
      const samePage = (State.pins || []).filter(p => (p.page || 1) === page);
      const no = samePage.indexOf(pin) + 1;
      $("pap-title").textContent = pin.label && pin.label.trim() ? pin.label : ("포인트 " + no);
      const hint = $("pap-label-hint");
      if (hint) hint.textContent = "미저장 변경 — '저장하기'(포인트 편집 패널) 또는 자동저장 이벤트 발생 시 서버에 반영됩니다.";
      Prompt.toast && Prompt.toast("위치명/번호 반영됨 (미저장)");
    },

    /** ── 사진 섹션: 있으면 미리보기, 없으면 등록 UI(뷰어는 등록 UI 숨김) ── */
    _renderPhoto(pin, canEdit) {
      const $ = (id) => document.getElementById(id);
      const previewBox = $("pap-photo-preview");
      const registerBox = $("pap-photo-register");
      const img = $("pap-photo-img");
      const hasPhoto = (typeof App !== "undefined" && App.pinHasMedia) ? App.pinHasMedia(pin) : !!(pin && (pin.imageId || pin.imageUrl || pin.videoUrl || pin.pendingOpId || pin.localPreview));
      if (hasPhoto) {
        if (previewBox) previewBox.classList.remove("hidden");
        if (registerBox) registerBox.classList.add("hidden");
        this._resolvePhotoSrc(pin).then((src) => { if (img && src) img.src = src; });
      } else {
        if (previewBox) previewBox.classList.add("hidden");
        if (registerBox) registerBox.classList.toggle("hidden", !canEdit);
        const errEl = $("pap-photo-err"); if (errEl) errEl.classList.add("hidden");
        const statusEl = $("pap-photo-status"); if (statusEl) statusEl.textContent = "";
        const urlInput = $("pap-photo-url"); if (urlInput) urlInput.value = "";
        const fileInput = $("pap-photo-file"); if (fileInput) fileInput.value = "";
      }
    },

    /** 미리보기 이미지 소스 해석 — 21_AllPins.js._loadThumb 과 같은 캐시/조회 경로 재사용 */
    async _resolvePhotoSrc(pin) {
      try {
        if (pin.imageId) {
          if (typeof Cloud !== "undefined" && Cloud._cache && Cloud._cache[pin.imageId]) return Cloud._cache[pin.imageId];
          if (typeof Cloud !== "undefined" && Cloud.fetchImage) return await Cloud.fetchImage(pin.imageId);
        }
        if (pin.localPreview) return pin.localPreview;
        if (pin.imageUrl && !PAP_VIDEO_RE.test(pin.imageUrl)) return pin.imageUrl;
      } catch (e) { /* 썸네일 실패는 무시 — 등록 상태 자체는 이미 표시됨 */ }
      return null;
    },

    /** ── 사진 등록: 파일 선택 — 기존 저장 경로(Cloud.resizeImage/uploadImage, imageId/imageName) 재사용 ── */
    async _registerPhotoFile(file) {
      const pin = this._pin(); if (!pin || !this._canEdit()) return;
      const $ = (id) => document.getElementById(id);
      const errEl = $("pap-photo-err"), statusEl = $("pap-photo-status");
      if (errEl) errEl.classList.add("hidden");
      if (!file) { if (errEl) { errEl.textContent = "파일을 선택하세요."; errEl.classList.remove("hidden"); } return; }
      if (statusEl) statusEl.textContent = "업로드 중…";
      try {
        const { dataURL, width, height } = await Cloud.resizeImage(file);
        const imgName = (pin.label || ("pin_" + pin.id)).replace(/[^a-zA-Z0-9_\-가-힣]/g, "_");
        const imageId = await Cloud.uploadImage(imgName, dataURL, width, height);
        pin.imageId = imageId; pin.imageName = imgName;
        if (typeof Cloud !== "undefined") { Cloud._cache = Cloud._cache || {}; Cloud._cache[imageId] = dataURL; }
        if (typeof App !== "undefined" && App._markDirty) App._markDirty();
        if (typeof UI !== "undefined") { UI.renderPinsOnMap && UI.renderPinsOnMap(); UI.renderPinList && UI.renderPinList(); }
        if (statusEl) statusEl.textContent = "사진 등록됨 (미저장 — 저장 버튼으로 서버에 반영하세요)";
        this._renderPhoto(pin, true);
      } catch (e) {
        if (errEl) { errEl.textContent = "업로드 실패: " + (e.message || e); errEl.classList.remove("hidden"); }
        if (statusEl) statusEl.textContent = "";
      }
    },

    /** ── 사진 등록: 경로(URL) 직접 입력 — 빈 값·잘못된 형식은 거부하고 이유 표시 ── */
    _registerPhotoUrl() {
      const pin = this._pin(); if (!pin || !this._canEdit()) return;
      const $ = (id) => document.getElementById(id);
      const errEl = $("pap-photo-err"), statusEl = $("pap-photo-status");
      const raw = ($("pap-photo-url") && $("pap-photo-url").value || "").trim();
      if (errEl) errEl.classList.add("hidden");
      if (!raw) { if (errEl) { errEl.textContent = "경로를 입력하세요."; errEl.classList.remove("hidden"); } return; }
      let parsed;
      try { parsed = new URL(raw); } catch (e) { parsed = null; }
      if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
        if (errEl) { errEl.textContent = "올바른 URL 형식이 아닙니다(http:// 또는 https:// 로 시작해야 함)."; errEl.classList.remove("hidden"); }
        return;
      }
      if (!PAP_URL_RE.test(raw)) {
        if (errEl) { errEl.textContent = "지원하지 않는 형식입니다(.jpg/.png/.gif/.webp/.mp4/.webm/.mov 만 허용)."; errEl.classList.remove("hidden"); }
        return;
      }
      pin.imageUrl = raw;
      pin.isVideo = PAP_VIDEO_RE.test(raw);
      if (typeof App !== "undefined" && App._markDirty) App._markDirty();
      if (typeof UI !== "undefined") { UI.renderPinsOnMap && UI.renderPinsOnMap(); UI.renderPinList && UI.renderPinList(); }
      if (statusEl) statusEl.textContent = "경로 등록됨 (미저장 — 저장 버튼으로 서버에 반영하세요)";
      this._renderPhoto(pin, true);
    },

    /** ── [WO 20260921] 문서 등록 — Cloud.uploadDoc/fileToDataURL 재사용(20_App.js 수정 0),
     *  pin.attachments 에 직접 추가(20_App.js 의 기존 attachments 형태 {id,name,size,type/docId}와 동일 SoT). ── */
    async _registerDocFile(file) {
      const pin = this._pin(); if (!pin || !this._canEdit()) return;
      const $ = (id) => document.getElementById(id);
      const statusEl = $("pap-doc-status");
      if (!file) return;
      if (typeof Cloud !== "undefined" && Cloud.MAX_DOC_BYTES && file.size > Cloud.MAX_DOC_BYTES) {
        const mb = (Cloud.MAX_DOC_BYTES / 1024 / 1024).toFixed(0);
        if (statusEl) statusEl.textContent = "\"" + file.name + "\" 은 너무 큽니다(최대 " + mb + "MB).";
        return;
      }
      if (statusEl) statusEl.textContent = "업로드 중…";
      try {
        const dataURL = await Cloud.fileToDataURL(file);
        const docId = await Cloud.uploadDoc(file.name, dataURL);
        if (!Array.isArray(pin.attachments)) pin.attachments = [];
        pin.attachments.push({ id: "d" + Date.now() + Math.random().toString(36).slice(2, 6), name: file.name, size: file.size, docId });
        if (typeof App !== "undefined" && App._markDirty) App._markDirty();
        if (typeof UI !== "undefined") { UI.renderPinList && UI.renderPinList(); }
        this._renderDocList(pin);
        if (statusEl) statusEl.textContent = "문서 등록됨 (미저장 — 저장 버튼으로 서버에 반영하세요)";
      } catch (e) {
        if (statusEl) statusEl.textContent = "업로드 실패: " + (e.message || e);
      }
    },

    /** 문서 첨부 목록 표시(등록된 문서 없으면 안내문) — pin.attachments 를 그대로 읽는다(SoT 1개). */
    _renderDocList(pin) {
      const list = document.getElementById("pap-doc-list");
      if (!list) return;
      const atts = (pin && pin.attachments) || [];
      const esc = (typeof UI !== "undefined" && UI.escapeHtml) ? UI.escapeHtml : (s) => String(s);
      list.innerHTML = atts.length
        ? atts.map((a) => "<div>· " + esc(a.name || "문서") + "</div>").join("")
        : "<span style=\"color:#94a3b8\">등록된 문서가 없습니다.</span>";
    },

    /** ── 노트(이슈) — 13_Notes.js 데이터/엔드포인트 재사용 ── */
    async _loadNotes(pin, canEdit) {
      const $ = (id) => document.getElementById(id);
      const formRow = $("pap-notes-form-row");
      if (formRow) formRow.classList.toggle("hidden", !canEdit);
      if (typeof Notes === "undefined") return;
      Notes.setPin(pin);
      try { await Notes.loadForPin(); } catch (e) {}
      if (Notes.renderCompact) Notes.renderCompact("pap-notes-list");
    },
    async _submitNote() {
      const pin = this._pin(); if (!pin || !this._canEdit()) return;
      const $ = (id) => document.getElementById(id);
      const input = $("pap-notes-input");
      const body = (input && input.value || "").trim();
      if (!body || typeof Notes === "undefined" || !Notes.submitCompact) return;
      const ok = await Notes.submitCompact(pin, body);
      if (ok) {
        if (input) input.value = "";
        if (Notes.renderCompact) Notes.renderCompact("pap-notes-list");
        Prompt.toast && Prompt.toast("노트 등록됨");
      } else {
        Prompt.toast && Prompt.toast("노트 등록 실패(네트워크 확인)");
      }
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
