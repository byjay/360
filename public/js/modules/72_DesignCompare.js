  /* ══════════════════════════════════════════
     DESIGN COMPARE — 설계 360(조선 3D 뷰 equirectangular 내보내기) 등록 + 일괄 등록
     (WO 20261019-gap1 R1, 지휘자 발주 "SIGNAX 등 경쟁 제품 기능 격차")
     [재현] R1: grep -i -E "bim|ifc|\.glb|design360|designPano" public/js/modules/*.js src/index.tsx → 0건.

     설계:
     · 핀 필드 = designImageId/designImageName/designYawOffset(pin.imageId 와 별개 슬롯,
       pins JSON 안의 새 키 — 서버 스키마 변경 0, 원격 마이그레이션 금지 준수).
     · 단건 등록 업로드 = 27_PinActionPop.js._registerPhotoFile 과 같은 저장 경로(Cloud.resizeImage/
       uploadImage)만 재사용 — 호출부(PhotoBatch._uploadOneRow)는 거치지 않는다(§동시 팀 점유:
       35_PhotoBatch.js/54_FieldCapture.js/20_App.js 는 "현장 촬영 세션" 팀이 쓰는 중이라 건드리지 않음).
     · 일괄 등록 번호 매칭 = 60_PhotoFolder.js 의 순수 함수(findMatches/isMatch, DOM·PhotoBatch 무의존)만
       호출 — 파일 자체 읽기/업로드/핀 대입은 이 모듈이 직접 한다(같은 이유로 PhotoFolder._registerEntry
       체인을 거치지 않음).
     · 비교 보기 = 52_CompareSync.js.openDesign(pin) 위임(좌우 동기 분할 재사용, 거기서 구현).
     · 열람자(viewer)는 비교만 — 등록/일괄등록 버튼은 canEdit 일 때만 노출.
  ══════════════════════════════════════════ */
  const DesignCompare = {
    _batchInput: null,

    /* ══ 핀 팝업 — 등록/비교 박스(27_PinActionPop.js._renderPhoto 가 호출) ══════════════ */

    renderPinBox(pin, canEdit, anchorEl) {
      let box = document.getElementById("pap-design-box");
      if (!box) {
        box = document.createElement("div");
        box.id = "pap-design-box";
        box.setAttribute("style", "margin-top:10px;padding-top:10px;border-top:1px solid #e2e8f0;display:flex;flex-direction:column;gap:6px;");
        anchorEl.insertAdjacentElement("afterend", box);
      }
      box.innerHTML = "";
      const status = document.createElement("div");
      status.id = "pap-design-status";
      status.setAttribute("style", "font-size:12px;color:#64748b;"); // 흰 배경 4.76:1(기존 metaEl과 동일 실측값 재사용)
      status.textContent = pin.designImageId ? "설계 360: 등록됨" + (pin.designImageName ? " (" + pin.designImageName + ")" : "") : "설계 360: 미등록";
      box.appendChild(status);

      const row = document.createElement("div");
      row.setAttribute("style", "display:flex;gap:8px;flex-wrap:wrap;");
      box.appendChild(row);

      if (canEdit) {
        const regBtn = document.createElement("button");
        regBtn.type = "button"; regBtn.id = "pap-design-reg-btn";
        regBtn.textContent = pin.designImageId ? "설계 360 교체" : "설계 360 등록";
        regBtn.setAttribute("style", "padding:6px 10px;border-radius:6px;border:1px solid #1d4f88;background:#2f6db5;color:#fff;cursor:pointer;font-size:12px;");
        const fileInput = document.createElement("input");
        fileInput.type = "file"; fileInput.accept = "image/*"; fileInput.id = "pap-design-file"; fileInput.className = "hidden";
        regBtn.addEventListener("click", () => fileInput.click());
        fileInput.addEventListener("change", (e) => {
          const f = e.target.files && e.target.files[0];
          e.target.value = "";
          if (f) this.registerFromFile(pin, f);
        });
        row.appendChild(regBtn); row.appendChild(fileInput);
        const batchBtn = document.createElement("button");
        batchBtn.type = "button"; batchBtn.id = "pap-design-batch-btn";
        batchBtn.textContent = "폴더에서 일괄 등록(번호 매칭)";
        batchBtn.title = "현재 페이지 핀 번호와 파일명을 매칭해 한 번에 등록합니다. 예: DESIGN_A012.jpg";
        batchBtn.setAttribute("style", "padding:6px 10px;border-radius:6px;border:1px solid #666;background:#f5f5f5;color:#111;cursor:pointer;font-size:12px;");
        batchBtn.addEventListener("click", () => this.pickBatchFolder());
        row.appendChild(batchBtn);
      }

      const cmpBtn = document.createElement("button");
      cmpBtn.type = "button"; cmpBtn.id = "pap-design-cmp-btn";
      cmpBtn.textContent = "설계와 비교";
      const canCompare = !!(pin.imageId && pin.designImageId);
      cmpBtn.disabled = !canCompare;
      cmpBtn.title = canCompare ? "" : "현장 사진과 설계 360 이 모두 등록돼야 비교할 수 있습니다.";
      cmpBtn.setAttribute("style", "padding:6px 10px;border-radius:6px;border:1px solid #666;background:" + (canCompare ? "#0f766e" : "#cbd5e1") + ";color:" + (canCompare ? "#fff" : "#475569") + ";cursor:" + (canCompare ? "pointer" : "not-allowed") + ";font-size:12px;");
      cmpBtn.addEventListener("click", () => { if (canCompare && typeof CompareSync !== "undefined") CompareSync.openDesign(pin); });
      row.appendChild(cmpBtn);
    },

    /* ══ 단건 등록 — PinActionPop._registerPhotoFile 과 같은 저장 경로만 재사용 ══════════════ */

    async registerFromFile(pin, file, silent) {
      if (!pin || !file) return;
      if (!silent && typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("설계 360 업로드 중…");
      try {
        const { dataURL, width, height } = await Cloud.resizeImage(file);
        const base = (pin.label || ("pin_" + pin.id)).toString().replace(/[^a-zA-Z0-9_\-가-힣]/g, "_");
        const imgName = "DESIGN_" + base + "_" + Date.now().toString(36);
        const imageId = await Cloud.uploadImage(imgName, dataURL, width, height);
        pin.designImageId = imageId;
        pin.designImageName = file.name;
        pin.designYawOffset = Number.isFinite(pin.designYawOffset) ? pin.designYawOffset : 0;
        if (typeof Cloud !== "undefined") { Cloud._cache = Cloud._cache || {}; Cloud._cache[imageId] = dataURL; }
        if (typeof PinActionPop !== "undefined" && PinActionPop._commitLocal) PinActionPop._commitLocal();
        if (!silent) {
          if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("설계 360 등록됨 (미저장 — 저장 버튼으로 서버에 반영하세요)");
          if (typeof PinActionPop !== "undefined" && PinActionPop._pin && PinActionPop._pin() === pin) {
            const box = document.getElementById("pap-photo-register");
            if (box) this.renderPinBox(pin, PinActionPop._canEdit(), box);
          }
        }
      } catch (e) {
        if (!silent && typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("설계 360 업로드 실패: " + (e && e.message || e));
        throw e;
      }
    },

    /* ══ 일괄 등록 — 60_PhotoFolder 의 순수 매칭 함수만 재사용(§헤더 주석) ══════════════ */

    _pinNo(pin, page) {
      try {
        if (typeof PinSeries === "undefined" || !PinSeries.numbers) return null;
        const info = PinSeries.numbers(State.pins, page).get(pin.id);
        return info ? info.no : null;
      } catch (e) { return null; }
    },
    _existingNumbers(page) {
      try {
        const set = new Set();
        if (typeof PinSeries === "undefined" || !PinSeries.numbers) return set;
        PinSeries.numbers(State.pins, page).forEach((info) => { if (info && Number.isFinite(info.no)) set.add(info.no); });
        return set;
      } catch (e) { return new Set(); }
    },

    /** [설계 360 일괄 등록] — 폴더(파일 다중 선택)를 열어 현재 페이지 핀 번호와 파일명을 매칭한다.
     *  매칭 알고리즘은 60_PhotoFolder.findMatches(순수 함수) 그대로 — 새 수식 0. */
    pickBatchFolder() {
      if (!this._batchInput) {
        const input = document.createElement("input");
        input.type = "file"; input.multiple = true; input.accept = "image/*"; input.className = "hidden";
        input.id = "design-batch-input";
        // webkitdirectory 가 있으면 폴더 선택도 허용(지원 브라우저만 — 없으면 다중 파일 선택으로 폴백).
        try { input.setAttribute("webkitdirectory", ""); } catch (e) {}
        document.body.appendChild(input);
        input.addEventListener("change", (e) => { const files = Array.from(e.target.files || []); e.target.value = ""; this.runBatch(files); });
        this._batchInput = input;
      }
      this._batchInput.click();
    },

    async runBatch(files) {
      if (!files || !files.length) return;
      if (typeof PhotoFolder === "undefined" || !PhotoFolder.findMatches) {
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("사진 폴더 매칭 모듈을 불러오지 못했습니다.");
        return;
      }
      const page = (typeof State !== "undefined" ? State.pdfPage : 1) || 1;
      const entries = files.map((f) => ({ name: f.name, _file: f }));
      const existingNumbers = this._existingNumbers(page);
      const allPins = (typeof PinSeries !== "undefined" && PinSeries.modePins) ? PinSeries.modePins(State.pins) : (State.pins || []);
      const pagePins = allPins.filter((p) => (p.page || 1) === page);
      let matched = 0, ambiguous = 0, skipped = 0;
      for (const pin of pagePins) {
        const no = this._pinNo(pin, page);
        if (no == null) { skipped++; continue; }
        const found = PhotoFolder.findMatches(no, entries, existingNumbers);
        if (found.length !== 1) { if (found.length > 1) ambiguous++; else skipped++; continue; }
        try { await this.registerFromFile(pin, found[0]._file, true); matched++; } catch (e) { skipped++; }
      }
      if (typeof UI !== "undefined") { UI.renderPinsOnMap && UI.renderPinsOnMap(); UI.renderPinList && UI.renderPinList(); }
      if (typeof PinActionPop !== "undefined" && PinActionPop._pin && PinActionPop._pin()) {
        const cur = PinActionPop._pin();
        const box = document.getElementById("pap-photo-register");
        if (box && cur) this.renderPinBox(cur, PinActionPop._canEdit(), box);
      }
      if (typeof Prompt !== "undefined" && Prompt.toast) {
        Prompt.toast("설계 360 일괄 등록 — 매칭 " + matched + "건 · 모호 " + ambiguous + "건 · 건너뜀 " + skipped + "건", 5000);
      }
    },

    /** 기능 메뉴/사진 폴더 바 쪽에서 호출할 진입 버튼 — 45_FeatureMenu.js 가 있으면 항목을 추가한다.
     *  없거나 등록 규격이 달라도 조용히 무시(없는 메뉴를 지어내지 않음 — 다른 진입은 pickBatchFolder() 직접 호출). */
    init() {}
  };
