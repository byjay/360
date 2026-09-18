  /** 사진 URL 로 허용하는 확장자(이미지·영상) — pap-photo-url 검증의 유일한 기준(SoT). */
  const PAP_URL_RE = /^https?:\/\/.+\.(jpe?g|png|gif|webp|bmp|mp4|webm|mov)(\?.*)?$/i;
  const PAP_VIDEO_RE = /\.(mp4|webm|mov)(\?.*)?$/i;

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
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !el.classList.contains("hidden")) this.close();
      });
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
