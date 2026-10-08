  /* ══════════════════════════════════════════════════════════════
     PIN PURGE — 프로젝트 모든 핀 삭제 (WO 20261008-pinpurge, 마스터 "관리자는 모든 핀 삭제 기능도 구현해")
     ────────────────────────────────────────────────────────────────
     범위 = 그 프로젝트의 모든 배포본(메인 + 벡터 복사 구역의 별도 배포본)의 모든 핀(CHECKER·360).
       기존 구역 단위 삭제(11_UI._pinBulkButtons → App.deletePins)는 그대로 둔다 — 이건 서버 일괄 경로다.
     권한 = 소유자·super(서버 can_manage_members SoT). 서버(GET/POST /api/projects/:id/pins/purge)도 403 으로 막는다.
       🔴 숨김 금지 — 그 외에는 비활성 + "소유자·관리자 전용"(reason()).
     확인 3단계 = ① 미리보기(구역·핀·CHECKER/360·사진 연결) → ② 프로젝트 이름 직접 입력 → ③ 본인 재인증(Auth.ensureReauth, X-Reauth).
       하나라도 실패·취소면 요청 자체를 보내지 않는다(서버도 이름·재인증을 다시 검사한다).
     삭제 = 서버 tombstone(하드 삭제·R2 삭제 0). 배포본별 base_version — 어긋난 곳은 409 로 따로 보고.
     되돌리기 = 서버가 준 undo_until 까지 하단 바의 [되돌리기](서버 스냅샷 복원). 오프라인 = 비활성("온라인에서만"), 큐에 넣지 않는다.
     🔴 색은 인라인 리터럴(테마 변수 재해석 함정 회피): 바 #111827 위 #ffffff 17.7:1 · [되돌리기] #fde68a 위 #111827 14.2:1
       · [닫기] #e5e7eb 위 #111827 14.3:1 · 실패 줄 #fecaca on #111827 12.3:1 (p132-cdp 가 getComputedStyle 로 재측정).
  ══════════════════════════════════════════════════════════════ */
  const PinPurge = {
    _bar: null,
    _timer: null,

    _proj() { return (typeof Projects !== "undefined" && Projects.currentProject) || null; },
    _url(pid, tail) { return "/api/projects/" + encodeURIComponent(pid) + "/pins/purge" + (tail || ""); },

    /** "" = 실행 가능, 그 외 = 비활성 사유(트리 ⋯ 메뉴·전체 기능 메뉴가 같은 문구를 쓴다). */
    reason() {
      if (typeof navigator !== "undefined" && navigator.onLine === false) return "온라인에서만 — 대량 삭제는 오프라인에서 실행하지 않습니다";
      const proj = this._proj();
      if (!proj || !proj.id) return "프로젝트를 먼저 여세요";
      const A = (typeof Auth !== "undefined") ? Auth : null;
      if (!(proj.can_manage_members || (A && A.isSuper)) || (A && A.readonly)) return "소유자·관리자 전용";
      const why = (typeof UI !== "undefined" && UI.permCheck) ? UI.permCheck("owner") : "";
      return why || "";
    },

    async _req(method, url, body, extra) {
      try {
        const r = await fetch(url, { method, headers: Auth.headers(extra), body: body == null ? undefined : JSON.stringify(body) });
        let j = null; try { j = await r.json(); } catch (e) {}
        return { status: r.status, j: j || {} };
      } catch (e) { return { status: 0, j: { error: "네트워크 오류 — 서버에 닿지 못했습니다" } }; }
    },

    previewText(pv) {
      const t = pv.totals || {};
      const lines = ["구역 " + (pv.decks || 0) + "개 · 핀 " + (t.pins || 0) + "개(CHECKER " + (t.checker || 0) + " / 360 " + (t.pano || 0) + ") · 사진 연결 " + (t.photos || 0) + "개"];
      const deps = (pv.deployments || []).filter((d) => d.pins > 0);
      if (deps.length) {
        lines.push("", "도면(배포본) " + deps.length + "곳:");
        deps.forEach((d) => lines.push("· " + (d.title || d.id) + " — 핀 " + d.pins + "개"));
      }
      lines.push("", "지우지 않는 것: 360 사진 원본 · 사진 이력 · PDF 주석 · 구역 윤곽",
        "삭제 후 " + Math.round((pv.undo_window_ms || 600000) / 60000) + "분 동안 [되돌리기]로 복원할 수 있습니다.");
      return lines.join("\n");
    },

    /** 진입점(트리 원본 ⋯ · 전체 기능 메뉴). 반환: { done, deleted?, stage? } — stage = 멈춘 단계(테스트·진단용). */
    async start() {
      const toast = (m, ms) => { try { Prompt.toast(m, ms || 3600); } catch (e) {} };
      const why = this.reason();
      if (why) { toast("모든 핀 삭제 — " + why); return { done: false, stage: "reason", why }; }
      const proj = this._proj(), pid = String(proj.id);
      // ① 미리보기
      const pv = await this._req("GET", this._url(pid));
      if (pv.status !== 200) { toast("미리보기를 불러오지 못했습니다 — " + (pv.j.error || pv.status)); return { done: false, stage: "preview" }; }
      if (!pv.j.ready) { toast("서버 준비가 끝나지 않아(마이그레이션 0039) 삭제할 수 없습니다"); return { done: false, stage: "preview" }; }
      if (!(pv.j.totals && pv.j.totals.pins > 0)) { toast("이 프로젝트에는 삭제할 핀이 없습니다"); return { done: false, stage: "empty" }; }
      if (!(await Prompt.confirm("모든 핀 삭제 — 1/3 미리보기", this.previewText(pv.j)))) return { done: false, stage: "confirm" };
      // ② 프로젝트 이름 직접 입력
      const name = String((pv.j.project && pv.j.project.name) || proj.name || "");
      const typed = await Prompt.ask({ title: "모든 핀 삭제 — 2/3 프로젝트 이름 확인",
        sub: "계속하려면 프로젝트 이름 「" + name + "」을(를) 정확히 입력하세요.", placeholder: name });
      if (!typed || String(typed.value || "").trim() !== name.trim()) { toast("프로젝트 이름이 일치하지 않아 삭제하지 않았습니다"); return { done: false, stage: "name" }; }
      // ③ 본인 재인증
      if (!Auth.ensureReauth || !(await Auth.ensureReauth())) { toast("본인 확인이 끝나지 않아 삭제하지 않았습니다"); return { done: false, stage: "reauth" }; }
      if (typeof navigator !== "undefined" && navigator.onLine === false) { toast("오프라인 — 삭제하지 않았습니다"); return { done: false, stage: "offline" }; }
      const base = {};
      (pv.j.deployments || []).forEach((d) => { base[d.id] = d.version; });
      const body = { confirm_name: typed.value, base_versions: base };
      let res = await this._req("POST", this._url(pid), body, Auth.reauthHeader());
      if (res.status === 403 && res.j.reauth_required) {
        Auth.clearReauth();
        if (!(await Auth.ensureReauth())) { toast("본인 확인이 끝나지 않아 삭제하지 않았습니다"); return { done: false, stage: "reauth" }; }
        res = await this._req("POST", this._url(pid), body, Auth.reauthHeader());
      }
      if (res.status !== 200 && res.status !== 409) { toast("삭제하지 않았습니다 — " + (res.j.error || res.status)); return { done: false, stage: "server", status: res.status }; }
      this._afterServerChange();
      this._showBar(pid, res.j);
      return { done: true, deleted: res.j.deleted || 0, failed: res.j.failed || 0, batch: res.j.batch || null };
    },

    async undo(pid, batch) {
      const res = await this._req("POST", this._url(pid, "/" + encodeURIComponent(batch) + "/undo"));
      const j = res.j || {};
      if (res.status === 200 || res.status === 409) {
        this._afterServerChange();
        const failed = (j.results || []).filter((r) => !r.ok);
        this._setBarText("핀 " + (j.restored || 0) + "개 복원" + (failed.length ? " · 실패 " + failed.length + "곳: " + failed.map((r) => r.reason || r.id).join(", ") : ""), !!failed.length);
      } else {
        this._setBarText("되돌리지 못했습니다 — " + (j.error || res.status), true);
      }
      this._dropUndoButton();
      this._autoClose(8000);
      return { status: res.status, restored: j.restored || 0 };
    },

    /** 서버본이 바뀌었다 — 지금 열린 배포본을 병합 SoT(App._mergeConflict → _mergePins: 서버 tombstone 반영)로 당긴다.
     *  _liveTick 을 그대로 부르면 "다른 사용자 변경 N건" 토스트가 떠 내 작업을 남의 것으로 잘못 알린다 → 같은 가드(_liveTick 과 동일)로 직접 병합.
     *  편집 중·도면 전환 중이면 건너뛴다(다음 라이브폴 틱이 같은 병합을 한다 — 유실 0). */
    async _afterServerChange() {
      try {
        if (typeof App === "undefined" || !App._mergeConflict || !State.autoSaveDepId) return;
        if (App._liveEditingNow && App._liveEditingNow()) return;
        const depId = State.autoSaveDepId, seq = App._loadSeq;
        const r = await fetch("/tables/deployments/" + encodeURIComponent(depId), { headers: Auth.headers() });
        if (!r.ok) return;
        const dep = await r.json();
        if (State.autoSaveDepId !== depId || seq !== App._loadSeq || (App._liveEditingNow && App._liveEditingNow())) return;
        if (!dep || dep.deleted || !(Number(dep.version) > Number(State.depVersion != null ? State.depVersion : 0))) return;
        App._mergeConflict(dep);
        if (UI.renderTree) UI.renderTree();
      } catch (e) {}
    },

    /* ── 하단 결과·되돌리기 바 ── */
    _showBar(pid, j) {
      this.closeBar();
      const bar = document.createElement("div");
      bar.id = "pin-purge-bar";
      bar.setAttribute("role", "status");
      bar.setAttribute("aria-live", "polite");
      bar.style.cssText = "position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:10050;max-width:min(560px,calc(100vw - 24px));"
        + "box-sizing:border-box;background:#111827;color:#ffffff;border-radius:10px;padding:10px 12px;font-size:14px;line-height:1.45;"
        + "box-shadow:0 6px 24px rgba(0,0,0,.35);display:flex;flex-wrap:wrap;gap:8px;align-items:center;";
      const msg = document.createElement("div");
      msg.className = "pin-purge-msg";
      msg.style.cssText = "flex:1 1 220px;min-width:0;color:#ffffff;";
      const results = j.results || [];
      const okN = results.filter((r) => r.ok && r.deleted > 0).length;
      const fails = results.filter((r) => !r.ok);
      msg.textContent = "모든 핀 삭제 — 핀 " + (j.deleted || 0) + "개 삭제(도면 " + okN + "곳)" + (fails.length ? " · 실패 " + fails.length + "곳" : "");
      bar.appendChild(msg);
      if (fails.length) {
        const ul = document.createElement("div");
        ul.className = "pin-purge-fails";
        ul.style.cssText = "flex:1 1 100%;color:#fecaca;font-size:13px;";
        ul.textContent = fails.map((r) => "· " + (r.title || r.id) + ": " + (r.reason || ("HTTP " + r.status))).join("\n");
        ul.style.whiteSpace = "pre-line";
        bar.appendChild(ul);
      }
      const mkBtn = (label, cls, fn) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = cls;
        b.textContent = label;
        b.style.cssText = "background:#fde68a;color:#111827;border:0;border-radius:8px;padding:6px 12px;font-size:14px;font-weight:700;cursor:pointer;min-height:36px;";
        b.addEventListener("click", (e) => { e.stopPropagation(); fn(b); });
        bar.appendChild(b);
        return b;
      };
      if (j.batch && j.undo_until) {
        const until = Number(j.undo_until);
        const ub = mkBtn("되돌리기", "pin-purge-undo", (b) => { b.disabled = true; this.undo(pid, j.batch); });
        const tick = () => {
          const left = until - Date.now();
          if (left <= 0) { this._dropUndoButton(); this._setBarText(msg.textContent + " · 되돌리기 시간이 지났습니다"); this._autoClose(6000); return; }
          const s = Math.ceil(left / 1000);
          ub.textContent = "되돌리기 " + Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
        };
        tick();
        this._timer = setInterval(tick, 1000);
      }
      const close = mkBtn("닫기", "pin-purge-close", () => this.closeBar());
      close.style.background = "#e5e7eb";
      document.body.appendChild(bar);
      this._bar = bar;
      this._msg = msg;
    },
    _setBarText(t, bad) { if (this._msg) { this._msg.textContent = t; this._msg.style.color = bad ? "#fecaca" : "#ffffff"; } },
    _dropUndoButton() {
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
      const b = this._bar && this._bar.querySelector(".pin-purge-undo");
      if (b) b.remove();
    },
    _autoClose(ms) { const bar = this._bar; setTimeout(() => { if (this._bar === bar) this.closeBar(); }, ms); },
    closeBar() {
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
      if (this._bar && this._bar.parentNode) this._bar.parentNode.removeChild(this._bar);
      this._bar = null; this._msg = null;
    }
  };
