
  /* ══════════════════════════════════════════════════════════════
     핀 멀티선택 ↔ 사진 멀티선택 → 번호 매칭 일괄 등록
     ────────────────────────────────────────────────────────────────
     마스터 지시: "폴더 전체가 아니라 핀 멀티 선택 후 그림 멀티 선택하면 뒤에 숫자 기준으로
     일괄 360 삽입 기능 구현" / "폴더 전체 기능은 그대로 유지".

     🔴 매칭 순수 로직은 60_PhotoFolder.js 의 isMatch/rankMatches/_peers/_existingNumbers 를
     그대로 재사용한다(§SoT — 새 매칭 함수를 만들지 않는다). 이 모듈이 다른 점은 후보 범위뿐이다:
       - 후보 핀  = 호출 시 넘겨준 선택 집합만(11_UI.js UI._pinSel.ids, 트리 핀 멀티선택과 같은 UI).
       - 후보 파일 = <input type=file multiple> 로 고른 파일들만(폴더 전체 아님).
     단, 폴백 억제 판정(existingNumbers)·접두 충돌 판정(peers)은 "이 페이지 전체 핀" 기준을 그대로
     쓴다(헤더 발주 R2 — 선택 범위를 좁혀도 그 페이지의 다른 핀 번호와는 여전히 충돌 판정해야 한다).

     연결 핀(linkId, 66_PinLink.js — 다른 팀 진행 중) 대상: PinLink 가 로드돼 있으면 선택 핀을
     대표(head)로 치환 + 중복 제거한다(사진은 대표에만, 60_PhotoFolder._batchTargets 와 동일 패턴).
     PinLink 미로드 시 선택 핀 그대로(무시) — PinLink.isMember 가드 자체가 아직 없다는 전제.

     업로드 1건은 PhotoFolder._registerEntry(pin, entry, source, overwrite) 를 재사용한다
     (detect360·_uploadOneRow·UI 리프레시까지 포함된 기존 경로 — 재구현 금지). 기본 덮어쓰기 OFF.
  ══════════════════════════════════════════════════════════════ */
  const PinMultiPhoto = {
    _pending: null,   // {rows, overwrite} — 파일 선택 완료 후 모달이 참조하는 마지막 미리보기

    _esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); },

    /* ══ 순수 로직 — 회귀 테스트가 직접 호출한다(DOM 무의존) ══════════════════════════ */

    /** 선택한 핀 id 들을 대표(head)로 치환 + 중복 제거. PinLink 없으면(아직 미도입/미로드) 그대로. */
    _resolveHeads(pins, selectedIds) {
      const idSet = new Set((selectedIds || []).map((v) => String(v)));
      const selPins = (pins || []).filter((p) => p && !p._deleted && idSet.has(String(p.id)));
      const PL = (typeof PinLink !== "undefined") ? PinLink : null;
      if (!PL || !PL.headOf || !PL.dedupe) return selPins;
      return PL.dedupe(selPins.map((p) => PL.headOf(pins, p)));
    },

    /** [핵심 API] 미리보기 행 계산 — 순수(DOM 無). files 는 File 또는 {name} 객체 배열.
     *  @returns {Array<{pin,no,label,candidates,status,chosenIdx}>}
     *  status: "일치" | "다중/확인필요" | "없음" | "번호없음" */
    buildPreview(pins, page, selectedIds, files) {
      const heads = this._resolveHeads(pins, selectedIds);
      const entries = (files || []).map((f) => ({ name: f.name, getFile: async () => f, _file: f }));
      const existing = (typeof PhotoFolder !== "undefined" && PhotoFolder._existingNumbers) ? PhotoFolder._existingNumbers(page) : new Set();
      const peers = (typeof PhotoFolder !== "undefined" && PhotoFolder._peers) ? PhotoFolder._peers(page) : [];
      return heads.map((pin) => {
        const no = (typeof PhotoFolder !== "undefined" && PhotoFolder._pinNo) ? PhotoFolder._pinNo(pin) : null;
        if (no == null) return { pin: pin, no: null, label: this._fallbackLabel(pin), candidates: [], status: "번호없음", chosenIdx: 0 };
        const prefix = (typeof PhotoFolder !== "undefined" && PhotoFolder._prefixFor) ? PhotoFolder._prefixFor(pin) : "";
        const label = (typeof PhotoFolder !== "undefined" && PhotoFolder._labelFor) ? PhotoFolder._labelFor(pin, no) : String(no);
        const rk = (typeof PhotoFolder !== "undefined" && PhotoFolder.rankMatches) ? PhotoFolder.rankMatches(no, prefix, entries, peers, existing) : { matches: [], ambiguous: [] };
        const candidates = rk.matches.length ? rk.matches : rk.ambiguous;
        let status;
        if (!rk.matches.length && rk.ambiguous.length) status = "다중/확인필요";
        else if (!candidates.length) status = "없음";
        else if (candidates.length > 1) status = "다중/확인필요";
        else status = "일치";
        return { pin: pin, no: no, label: label, candidates: candidates, status: status, chosenIdx: 0 };
      });
    },

    _fallbackLabel(pin) { return "핀 " + ((pin && pin.id) || "?"); },

    /** 등록 대상 — "일치" 또는(다중/확인필요 행에서) 사용자가 candidates[chosenIdx] 를 골랐을 때.
     *  "없음"/"번호없음"은 대상에서 제외(조용히 아무 파일이나 꽂지 않는다). 순수 함수. */
    applicableRows(rows) {
      return (rows || []).filter((r) => r && r.candidates && r.candidates.length
        && (r.status === "일치" || (r.status === "다중/확인필요" && Number.isFinite(r.chosenIdx) && r.candidates[r.chosenIdx])));
    },

    /** 순차 등록(동시성 없음 — 진행률/부분실패 표시 목적). PhotoFolder._registerEntry 재사용.
     *  이미 사진 있는 핀은 overwrite=false 면 _uploadOneRow 내부 가드로 건너뜀(skip). */
    async runSelected(rows, overwrite, onProgress) {
      const applicable = this.applicableRows(rows);
      let done = 0, skip = 0, fail = 0;
      for (const r of applicable) {
        const entry = r.candidates[r.chosenIdx] || r.candidates[0];
        const result = (typeof PhotoFolder !== "undefined" && PhotoFolder._registerEntry)
          ? await PhotoFolder._registerEntry(r.pin, entry, "멀티선택", !!overwrite)
          : { status: "fail", reason: "PhotoFolder 미로드" };
        r._result = result;
        if (result.status === "done") done++; else if (result.status === "skip") skip++; else fail++;
        if (onProgress) { try { onProgress({ done: done, skip: skip, fail: fail, total: applicable.length, row: r }); } catch (e) {} }
      }
      return { done: done, skip: skip, fail: fail, total: applicable.length, excluded: (rows || []).length - applicable.length };
    },

    /** 실패한 행만 다시 1건 등록(재시도). */
    async retryRow(r, overwrite) {
      if (!r || !r.candidates || !r.candidates.length) return { status: "fail", reason: "후보 없음" };
      const entry = r.candidates[r.chosenIdx] || r.candidates[0];
      const result = (typeof PhotoFolder !== "undefined" && PhotoFolder._registerEntry)
        ? await PhotoFolder._registerEntry(r.pin, entry, "멀티선택-재시도", !!overwrite)
        : { status: "fail", reason: "PhotoFolder 미로드" };
      r._result = result;
      return result;
    },

    /* ══ DOM 연결 — 버튼(11_UI.js 핀 선택 모드) → 파일 선택 → 미리보기 모달 ══════════════ */

    _ensureFileInput() {
      if (typeof document === "undefined") return null;
      if (document.getElementById("pinmultiphoto-fileinput")) return document.getElementById("pinmultiphoto-fileinput");
      const input = document.createElement("input");
      input.type = "file"; input.multiple = true; input.id = "pinmultiphoto-fileinput";
      input.setAttribute("accept", "image/*");
      input.style.display = "none";
      input.addEventListener("change", (e) => {
        const files = Array.from(e.target.files || []);
        e.target.value = "";
        if (!files.length) return;
        this._onFilesChosen(files);
      });
      document.body.appendChild(input);
      return input;
    },

    /** [핵심 API] 11_UI.js 의 [선택] 모드에서 "선택한 핀에 360 사진 넣기" 버튼이 호출. */
    openForSelection(selectedIds) {
      if (typeof Auth !== "undefined" && Auth.readonly) return;
      if (!selectedIds || !selectedIds.length) {
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("먼저 핀을 선택하세요");
        return;
      }
      this._pendingIds = selectedIds.slice();
      const input = this._ensureFileInput();
      if (input) input.click();
    },

    async _onFilesChosen(files) {
      const page = (typeof State !== "undefined") ? (State.pdfPage || 1) : 1;
      const pins = (typeof State !== "undefined" ? State.pins : []) || [];
      const rows = this.buildPreview(pins, page, this._pendingIds || [], files);
      this._showPreviewModal(rows);
    },

    _ensurePreviewModal() {
      if (document.getElementById("pinmultiphoto-modal")) return;
      const modal = document.createElement("div");
      modal.id = "pinmultiphoto-modal";
      modal.className = "admin-gate-backdrop hidden";
      modal.setAttribute("style", "position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;");
      const panel = document.createElement("div");
      panel.setAttribute("style", "background:#fff;color:#111;max-width:560px;width:92vw;max-height:80vh;overflow:auto;border-radius:12px;padding:18px;");
      const title = document.createElement("h3"); title.id = "pinmultiphoto-title"; title.setAttribute("style", "margin:0 0 10px;font-size:15px;color:#111;");
      const ovLabel = document.createElement("label"); ovLabel.setAttribute("style", "display:flex;align-items:center;gap:6px;font-size:12px;color:#111;margin-bottom:8px;");
      const ovCb = document.createElement("input"); ovCb.type = "checkbox"; ovCb.id = "pinmultiphoto-overwrite";
      ovLabel.appendChild(ovCb); ovLabel.appendChild(document.createTextNode("이미 사진 있는 핀도 덮어쓰기(기본 꺼짐)"));
      const rowsEl = document.createElement("div"); rowsEl.id = "pinmultiphoto-rows"; rowsEl.setAttribute("style", "font-size:12px;max-height:48vh;overflow:auto;border:1px solid #eee;border-radius:6px;");
      const prog = document.createElement("div"); prog.id = "pinmultiphoto-progress"; prog.setAttribute("style", "font-size:12px;color:#444;margin-top:8px;");
      const btnBar = document.createElement("div"); btnBar.setAttribute("style", "display:flex;gap:8px;margin-top:12px;");
      const confirmBtn = document.createElement("button"); confirmBtn.type = "button"; confirmBtn.id = "pinmultiphoto-confirm"; confirmBtn.textContent = "확인하고 등록";
      confirmBtn.setAttribute("style", "padding:8px 14px;border-radius:8px;border:1px solid #1d4f88;background:#2f6db5;color:#fff;cursor:pointer;font-size:14px;");
      const cancelBtn = document.createElement("button"); cancelBtn.type = "button"; cancelBtn.id = "pinmultiphoto-cancel"; cancelBtn.textContent = "취소";
      cancelBtn.setAttribute("style", "padding:8px 14px;border-radius:8px;border:1px solid #ccc;background:#f5f5f5;color:#111;cursor:pointer;font-size:14px;");
      cancelBtn.addEventListener("click", () => modal.classList.add("hidden"));
      btnBar.appendChild(confirmBtn); btnBar.appendChild(cancelBtn);
      panel.appendChild(title); panel.appendChild(ovLabel); panel.appendChild(rowsEl); panel.appendChild(prog); panel.appendChild(btnBar);
      modal.appendChild(panel);
      document.body.appendChild(modal);
    },

    _rowHtml(r, idx) {
      const color = r.status === "일치" ? "#1a7f37" : (r.status === "없음" || r.status === "번호없음" ? "#767676" : "#9a4a00");
      const fname = r.candidates.length ? (r.candidates.length === 1 ? r.candidates[0].name : "") : "-";
      let picker = "";
      if (r.status === "다중/확인필요" && r.candidates.length > 1) {
        picker = '<select class="pmp-pick" data-idx="' + idx + '" style="margin-left:6px;font-size:12px;">'
          + r.candidates.map((c, ci) => '<option value="' + ci + '"' + (ci === r.chosenIdx ? " selected" : "") + '>' + this._esc(c.name) + '</option>').join("")
          + '</select>';
      }
      const retry = (r._result && r._result.status === "fail") ? '<button type="button" class="pmp-retry" data-idx="' + idx + '" style="margin-left:6px;font-size:11px;">재시도</button>' : "";
      const resultTxt = r._result ? (" · " + (r._result.status === "done" ? (r._result.offline ? "오프라인저장" : "완료") : r._result.status === "skip" ? "건너뜀(기존사진)" : "실패: " + (r._result.reason || ""))) : "";
      return '<div class="pmp-row" data-idx="' + idx + '" style="display:flex;justify-content:space-between;gap:8px;padding:6px 8px;border-bottom:1px solid #eee;color:#111;align-items:center;">'
        + '<span>' + this._esc(r.label) + '</span>'
        + '<span style="flex:1;text-align:left;margin-left:8px;color:#333;">' + this._esc(fname) + picker + '</span>'
        + '<span style="font-weight:600;color:' + color + ';">' + r.status + resultTxt + retry + '</span>'
        + '</div>';
    },

    _showPreviewModal(rows) {
      this._ensurePreviewModal();
      this._rows = rows;
      const modal = document.getElementById("pinmultiphoto-modal");
      document.getElementById("pinmultiphoto-title").textContent = "선택한 핀에 360 사진 넣기 — " + rows.length + "개 핀 대상";
      const ovCb = document.getElementById("pinmultiphoto-overwrite"); if (ovCb) ovCb.checked = false;
      this._renderRows();
      document.getElementById("pinmultiphoto-progress").textContent = "";
      const confirmBtn = document.getElementById("pinmultiphoto-confirm");
      confirmBtn.disabled = this.applicableRows(rows).length === 0;
      confirmBtn.onclick = async () => {
        confirmBtn.disabled = true;
        const overwrite = !!(document.getElementById("pinmultiphoto-overwrite") || {}).checked;
        const summary = await this.runSelected(this._rows, overwrite, (p) => {
          const el = document.getElementById("pinmultiphoto-progress");
          if (el) el.textContent = "진행 " + p.done + "/" + p.total + " (건너뜀 " + p.skip + " · 실패 " + p.fail + ")";
          this._renderRows();
        });
        confirmBtn.disabled = false;
        this._renderRows();
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("등록 완료 " + summary.done + "건 · 제외 " + summary.excluded + "건" + (summary.fail ? (" · 실패 " + summary.fail) : ""));
      };
      modal.classList.remove("hidden");
    },

    _renderRows() {
      const host = document.getElementById("pinmultiphoto-rows");
      if (!host) return;
      host.innerHTML = this._rows.map((r, i) => this._rowHtml(r, i)).join("") || '<div style="padding:10px;color:#444;">대상 핀이 없습니다</div>';
      host.querySelectorAll && host.querySelectorAll(".pmp-pick").forEach((sel) => {
        sel.addEventListener("change", (e) => {
          const idx = parseInt(e.target.dataset.idx, 10);
          if (this._rows[idx]) this._rows[idx].chosenIdx = parseInt(e.target.value, 10);
          const confirmBtn = document.getElementById("pinmultiphoto-confirm");
          if (confirmBtn) confirmBtn.disabled = this.applicableRows(this._rows).length === 0;
        });
      });
      host.querySelectorAll && host.querySelectorAll(".pmp-retry").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const idx = parseInt(btn.dataset.idx, 10);
          const r = this._rows[idx];
          if (!r) return;
          const overwrite = !!(document.getElementById("pinmultiphoto-overwrite") || {}).checked;
          await this.retryRow(r, overwrite);
          this._renderRows();
        });
      });
    }
  };
