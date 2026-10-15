  /* ══════════════════════════════════════════════════════════════
     번호 리셋 — 구역(또는 페이지) 단위로 핀 번호를 1부터 연속 재부여 + 되돌리기
     ────────────────────────────────────────────────────────────────
     [WO 20261015-numunify] 마스터(음성): "번호 리셋기능도 구현하고" — 체커·360 번호를 하나로 합친 뒤
     (01b_PinSeries 번호 공간 = (배포본, 페이지) 1개) 기존 중복·흩어진 번호를 사용자가 직접 정리하는 수단.
     🔴 자동 실행 경로 없음 — 이 모듈은 사용자가 [번호 리셋] 을 눌러야만 동작한다(자동 재채번 금지 규율과 충돌 없음).

     흐름: 미리보기 시트(순서 기준 · 옛 번호 → 새 번호 전부 · 겹침/사진 매칭 경고) → [리셋 실행]
           → 확인 1(개수·범위) → 확인 2(사진 매칭 키 변경 · 되돌리기 방법) → 적용 → 저장 → 토스트 [되돌리기].
     계산·적용·되돌리기 정본 = PinSeries.resetPlan / applyReset / lastResetBatch / undoResetPlan / applyUndoReset.
     되돌리기 스냅샷은 핀 자신(pin.numReset)에 남아 일반 저장 경로로 D1 에 간다 — 새로고침·다른 기기에서도
     기능 메뉴 [번호 리셋 되돌리기] 로 복원된다(마이그레이션 0).
     권한: 소유자·super(App.canBulkDeletePins 와 같은 정본 — UI.permCheck("owner")) · 오프라인이면 비활성 · 열람자 0.
     스타일: 24b_NumBand/21_AllPins 의 .numband-sheet(흰 패널·진한 글자, style.css 대비 감사 완료) 재사용 — 새 CSS 0.
  ══════════════════════════════════════════════════════════════ */
  const NumReset = {
    _plan: null,

    /** 비활성 사유("" = 사용 가능). 기능 메뉴 why·open()·undo() 가 같은 판정을 쓴다. */
    reason() {
      if (typeof State === "undefined" || State.mode !== "designer" || (typeof Auth !== "undefined" && Auth.readonly)) return "디자이너(편집) 전용 — 열람 화면에서는 사용할 수 없습니다";
      const why = (typeof UI !== "undefined" && UI.permCheck) ? UI.permCheck("owner") : "";
      if (why) return why;
      if (typeof navigator !== "undefined" && navigator.onLine === false) return "온라인에서만 — 오프라인에서는 번호 리셋을 실행하지 않습니다";
      if (!State.fileType) return "도면을 먼저 여세요";
      return "";
    },
    undoReason() {
      const r = this.reason();
      if (r) return r;
      return PinSeries.lastResetBatch(State.pins, this._page()) ? "" : "이 화면에 되돌릴 번호 리셋이 없습니다";
    },

    _page() { return (typeof State !== "undefined" && State.pdfPage) || 1; },

    /** 대상 = 지금 보고 있는 구역(창 구역이면 그 크롭 안 — Projects.pinsForDeck SoT)의 이 페이지 핀. */
    _targets() {
      const all = State.pins || [];
      const deck = (typeof Projects !== "undefined") ? Projects.currentDeck : null;
      const scoped = (typeof Projects !== "undefined" && Projects.pinsForDeck) ? Projects.pinsForDeck(all, deck) : all;
      const pg = this._page();
      return (scoped || []).filter((p) => p && !p._deleted && (p.page || 1) === pg);
    },

    _scopeName() {
      const deck = (typeof Projects !== "undefined") ? Projects.currentDeck : null;
      return (deck && deck.name) ? ("구역 ‘" + deck.name + "’") : ("이 도면 " + this._page() + "쪽");
    },

    _matchKeyOf(no) {
      try { if (typeof PhotoFolder !== "undefined" && PhotoFolder._matchKey) { const k = PhotoFolder._matchKey(no); if (k) return k; } } catch (e) {}
      return String(no);
    },

    _ensureSheet() {
      let m = document.getElementById("numreset-sheet");
      if (m) return m;
      m = document.createElement("div");
      m.id = "numreset-sheet";
      m.className = "numband-sheet hidden";
      m.innerHTML =
        '<div class="numband-backdrop" data-nrs-close></div>' +
        '<div class="numband-panel" role="dialog" aria-modal="true" aria-labelledby="nrs-title">' +
          '<div class="numband-head"><h3 id="nrs-title" class="numband-title">번호 리셋</h3>' +
          '<button type="button" class="numband-x" data-nrs-close aria-label="닫기">&times;</button></div>' +
          '<p id="nrs-sub" class="numband-sub"></p>' +
          '<div class="allpins-arn-row" role="radiogroup" aria-label="순서 기준">' +
            '<label><input type="radio" name="nrs-order" value="pos" checked /> 도면 위치순(위→아래, 왼→오)</label>' +
            '<label><input type="radio" name="nrs-order" value="no" /> 기존 번호 순서</label>' +
          '</div>' +
          '<div id="nrs-preview" class="allpins-arn-preview" aria-live="polite"></div>' +
          '<p id="nrs-collide" class="numband-status hidden"></p>' +
          '<p id="nrs-photo-warn" class="numband-status"></p>' +
          '<div class="allpins-arn-actions"><button id="nrs-cancel" type="button" class="numband-apply" data-nrs-close>취소</button>' +
          '<button id="nrs-apply" type="button" class="numband-apply">리셋 실행</button></div>' +
        '</div>';
      document.body.appendChild(m);
      m.addEventListener("click", (e) => {
        if (e.target && e.target.closest && e.target.closest("[data-nrs-close]")) this.close();
      });
      m.querySelectorAll('input[name="nrs-order"]').forEach((r) => r.addEventListener("change", () => this._renderPreview()));
      m.querySelector("#nrs-apply").addEventListener("click", () => this.confirmAndApply());
      m.addEventListener("keydown", (e) => { if (e.key === "Escape") this.close(); });
      return m;
    },

    close() {
      const m = document.getElementById("numreset-sheet");
      if (m) m.classList.add("hidden");
      this._plan = null;
    },

    _order() {
      const r = document.querySelector('#numreset-sheet input[name="nrs-order"]:checked');
      return r ? r.value : "pos";
    },

    /** 미리보기 = 옛 번호 → 새 번호 전부(60개 초과분은 개수만) + 겹침·사진 매칭 경고. */
    _renderPreview() {
      const m = document.getElementById("numreset-sheet");
      if (!m) return null;
      const plan = PinSeries.resetPlan(State.pins, this._page(), { order: this._order(), targets: this._targets() });
      this._plan = plan;
      const esc = (s) => (typeof UI !== "undefined" && UI.escapeHtml) ? UI.escapeHtml(String(s)) : String(s);
      const prev = m.querySelector("#nrs-preview");
      const coll = m.querySelector("#nrs-collide");
      const warn = m.querySelector("#nrs-photo-warn");
      const apply = m.querySelector("#nrs-apply");
      if (!plan.ok) {
        prev.innerHTML = "";
        coll.classList.remove("hidden"); coll.textContent = plan.reason || "리셋할 수 없습니다";
        warn.textContent = "";
        apply.disabled = true; apply.style.opacity = ".5";
        return plan;
      }
      apply.disabled = false; apply.style.opacity = "";
      const LIMIT = 60;
      const oldTxt = (c) => (Number.isFinite(c.oldNo) ? PinSeries.formatNo(c.oldNo) : (c.oldLabel || "(없음)"));
      prev.innerHTML = plan.changes.slice(0, LIMIT).map((c) =>
        '<span class="allpins-arn-pair" data-id="' + esc(c.id) + '">' + esc(oldTxt(c)) + " → " + esc(PinSeries.formatNo(c.newLabel)) + "</span>"
      ).join("") + (plan.changes.length > LIMIT ? '<span class="allpins-arn-more">외 ' + (plan.changes.length - LIMIT) + "개</span>" : "");
      coll.classList.toggle("hidden", !plan.collisions.size);
      if (plan.collisions.size) coll.textContent = "⚠ 범위 밖 같은 페이지 핀 " + plan.collisions.size + "개와 새 번호가 겹칩니다 — 적용하면 중복(빨강)으로 표시됩니다";
      const ex = plan.changes.find((c) => Number.isFinite(c.oldNo) && String(c.oldNo) !== c.newLabel);
      warn.textContent = "⚠ 번호가 바뀌면 사진 파일명 매칭 키도 바뀝니다" +
        (ex ? "(예: 인식 " + this._matchKeyOf(ex.oldNo) + " → " + this._matchKeyOf(ex.newLabel) + ")" : "") +
        ". 이미 등록된 사진은 핀에 그대로 붙어 있지만, 이후 사진 폴더 일괄 등록은 새 번호로 파일을 찾습니다.";
      return plan;
    },

    /** 진입(기능 메뉴) — 권한·오프라인 사유가 있으면 토스트만(실행 0). */
    open() {
      const why = this.reason();
      if (why) { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("번호 리셋 — " + why); return false; }
      const m = this._ensureSheet();
      const n = this._targets().length;
      m.querySelector("#nrs-sub").textContent = this._scopeName() + "의 핀 " + n + "개 번호를 1부터 연속으로 다시 매깁니다. 순서 기준을 고르고 미리보기를 확인하세요.";
      m.querySelectorAll('input[name="nrs-order"]').forEach((r) => { r.checked = r.value === "pos"; });
      m.classList.remove("hidden");
      this._renderPreview();
      return true;
    },

    /** [리셋 실행] → 확인 2회 → 적용·저장. @returns 바뀐 핀 수(취소·실패 0) */
    async confirmAndApply() {
      const why = this.reason();
      if (why) { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("번호 리셋 — " + why); return 0; }
      const plan = this._plan || this._renderPreview();
      if (!plan || !plan.ok) return 0;
      const n = plan.changes.length;
      const ok1 = await Prompt.confirm("번호 리셋 (1/2)",
        this._scopeName() + "의 핀 " + n + "개 번호를 1~" + n + " 으로 바꿉니다(실제로 바뀌는 핀 " + plan.changed + "개)." +
        (plan.collisions.size ? "\n범위 밖 핀 " + plan.collisions.size + "개와 번호가 겹칩니다." : ""),
        { okText: "다음", cancelText: "취소" });
      if (!ok1) return 0;
      const ok2 = await Prompt.confirm("번호 리셋 (2/2) — 마지막 확인",
        "번호가 바뀌면 사진 파일명 매칭 키(001 형식)도 새 번호를 따릅니다.\n이미 붙은 사진·노트 연결은 그대로입니다.\n기능 메뉴 [번호 리셋 되돌리기] 로 옛 번호를 복원할 수 있습니다.",
        { okText: "리셋 실행", cancelText: "취소" });
      if (!ok2) return 0;
      // 확인 사이에 오프라인이 됐을 수 있다 — 재판정(조용한 반쯤 적용 금지)
      const why2 = this.reason();
      if (why2) { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("번호 리셋 — " + why2); return 0; }
      const batch = "nr" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const changed = PinSeries.applyReset(State.pins, plan, batch);
      changed.forEach((pin) => { if (typeof Log !== "undefined" && Log.push) Log.push("pin.renumber", pin.id, { oldLabel: pin.numReset.from, newLabel: pin.label, page: pin.page || 1, reason: "reset", batch: batch }); });
      this._persist();
      this.close();
      if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("번호 리셋 " + changed.length + "개 · 1~" + changed.length, 6000, { action: { label: "되돌리기", onClick: () => this.undo(true) } });
      return changed.length;
    },

    /** 가장 최근 리셋 되돌리기. skipConfirm = 방금 리셋 토스트의 [되돌리기](이미 의도 명확). @returns 복원한 핀 수 */
    async undo(skipConfirm) {
      const why = this.undoReason();
      if (why) { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("번호 리셋 되돌리기 — " + why); return 0; }
      const last = PinSeries.lastResetBatch(State.pins, this._page());
      const plan = PinSeries.undoResetPlan(State.pins, last.batch);
      if (!skipConfirm) {
        const ok = await Prompt.confirm("번호 리셋 되돌리기",
          "최근 리셋한 핀 " + plan.restore.length + "개를 옛 번호로 되돌립니다." +
          (plan.skipped.length ? "\n리셋 뒤 번호를 다시 고친 " + plan.skipped.length + "개는 그대로 둡니다." : ""),
          { okText: "되돌리기", cancelText: "취소" });
        if (!ok) return 0;
      }
      PinSeries.applyUndoReset(State.pins, plan);
      plan.restore.forEach((r) => { if (typeof Log !== "undefined" && Log.push) Log.push("pin.renumber", r.id, { oldLabel: r.to, newLabel: r.from, reason: "reset-undo", batch: plan.batch }); });
      this._persist();
      if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("옛 번호로 되돌렸습니다 " + plan.restore.length + "개" + (plan.skipped.length ? " · 건너뜀 " + plan.skipped.length : ""));
      return plan.restore.length;
    },

    /** 저장·다시 그리기 — 21_AllPins._confirmRenumber 와 같은 경로(App._markDirty → _autoSave). */
    _persist() {
      if (typeof App !== "undefined") { App._markDirty && App._markDirty(); App._autoSave && App._autoSave(); }
      if (typeof UI !== "undefined") { UI.renderPinsOnMap && UI.renderPinsOnMap(); UI.renderPinList && UI.renderPinList(); }
      if (typeof AllPins !== "undefined" && AllPins.open && AllPins.render) { try { AllPins.render(); } catch (e) {} }
      if (typeof NumBand !== "undefined" && NumBand.render) { try { NumBand.render(); } catch (e) {} }
    }
  };
