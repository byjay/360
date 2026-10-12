  /* ══════════════════════════════════════════════════════════════
     PIN ALIAS — [WO 20261012-pinsync] 원본 ↔ 벡터 복사 구역 핀 연동: 기존 구역 핀 이관 안내(설계 .tmp/design-pinsync.md §2-1)
     마스터 "전체 PDF에서 구역을 지정하고 그 구역에 핀을 박았는데 구역의 페이지에서는 그게 연동이 안되네 서로 연동되게해야지."
     ────────────────────────────────────────────────────────────────
     서버가 벡터 복사 구역(D1)의 핀을 원본(D0)에서 투영·역변환한다(src/index.tsx resolvePinHome). 구역에 핀이 하나도 없으면 즉시 연동.
     🔴 이미 구역에 따로 저장된 핀이 있으면(서버 pin_alias:'pending') **자동 변환하지 않는다** — 번호 겹침·화면 밖 핀이 생길 수 있어 사람이 본다:
       구역을 열면 하단 안내([닫기]·[취소]로 물리치면 이 세션엔 다시 안 띄움) → [원본과 합치기] → 미리보기(N개 · 화면 안 M · 밖 K · id 재발급 · 번호 겹침 · 노트) → 확인 →
       서버가 원본 blob 을 region_pin_migration 에 보관 후 한 트랜잭션으로 이관 → [되돌리기](서버가 준 undo_until 까지).
     열람 전용·비디자이너 = 안내 없음(쓰기 권한 없음 — 서버도 403). 오프라인 = 실행 안 함(온라인에서만).
     색: 하단 바 = 53_PinPurge 와 같은 팔레트(#111827 배경·#ffffff 글자 17:1 · #fde68a/#e5e7eb 버튼 위 #111827 글자 ≥14:1).
     ══════════════════════════════════════════════════════════════ */
  const PinAlias = {
    _shown: {},      // depId → 1 (사용자가 물리친 안내 — 세션 동안 다시 안 띄움)
    _bar: null, _msg: null, _timer: null, _barDep: null,

    _url(depId, tail) { return "/tables/deployments/" + encodeURIComponent(depId) + "/pin-alias" + (tail || ""); },
    _toast(m, ms) { try { Prompt.toast(m, ms || 4200); } catch (e) {} },
    _canWrite() {
      const A = (typeof Auth !== "undefined") ? Auth : null;
      return !!(A && A.isDesigner && !A.readonly);
    },
    async _req(method, url, body) {
      try {
        const r = await fetch(url, { method, headers: Auth.headers(), body: body == null ? undefined : JSON.stringify(body) });
        let j = null; try { j = await r.json(); } catch (e) {}
        return { status: r.status, j: j || {} };
      } catch (e) { return { status: 0, j: { error: "네트워크 오류 — 서버에 닿지 못했습니다" } }; }
    },

    /** 로더(App._applyPinAlias fromLoad) 진입점 — 도면을 새로 열 때마다 호출된다. */
    onLoad(dep) {
      if (!dep || dep.id == null) { this.closeBar(); return; }
      const id = String(dep.id);
      // 다른 도면으로 바뀌면 이전 도면의 안내·되돌리기 바를 닫는다. 같은 도면 재로드(합치기 직후 재열기·폴링)는 바를 유지한다.
      if (this._barDep != null && this._barDep !== id) this.closeBar();
      if (dep.pin_alias === "ambiguous") {
        if (!this._shown[id]) { this._shown[id] = 1; this._toast("이 구역 도면을 서로 다른 원본 영역으로 가리키는 구역이 2개 이상이라 원본과 핀을 연동하지 않았습니다 — 이 구역 핀은 따로 저장됩니다", 6000); }
        return;
      }
      if (dep.pin_alias !== "pending" || !(Number(dep.pin_alias_pending) > 0)) return;
      // 사용자가 [닫기]·[취소]로 물리친 도면만 이 세션에서 다시 안 띄운다(다른 도면 갔다 오면 다시 보여야 행동할 수 있다)
      if (!this._canWrite() || this._shown[id]) return;
      if (this._bar && this._barDep === id) return;   // 같은 도면 재로드 — 이미 떠 있음
      this._showBar(id, "이 구역의 핀 " + Number(dep.pin_alias_pending) + "개는 아직 원본과 따로 저장돼 있습니다",
        [{ label: "원본과 합치기", cls: "pin-alias-merge", run: (b) => { b.disabled = true; this.start(id); } }]);
    },

    previewText(pv) {
      const lines = ["이 구역에 따로 저장된 핀 " + (pv.count || 0) + "개를 원본 도면으로 옮깁니다(같은 위치 · 같은 사진).",
        "· 구역 화면 안 " + (pv.inside || 0) + "개" + (pv.outside ? " · 화면 밖 " + pv.outside + "개(원본에는 남지만 이 구역에선 안 보임)" : "")];
      if (pv.renamed) lines.push("· 원본과 id 가 겹치는 핀 " + pv.renamed + "개는 새 id 로 옮깁니다(노트 연결 유지)");
      if (pv.dup_numbers) lines.push("· 원본과 번호가 겹치는 핀 " + pv.dup_numbers + "개 — 자동으로 바꾸지 않습니다(중복 표시로 확인)");
      if (pv.notes) lines.push("· 핀 노트 " + pv.notes + "개도 함께 옮깁니다");
      lines.push("", "이후 이 구역과 원본은 같은 핀을 함께 보여줍니다(어느 쪽에서 고쳐도 양쪽에 반영).",
        "실행 후 " + Math.round((pv.undo_window_ms || 600000) / 60000) + "분 동안 [되돌리기]로 원래대로 돌릴 수 있습니다.");
      return lines.join("\n");
    },

    /** [원본과 합치기] — 미리보기 → 확인 → 실행 → 되돌리기 바. 반환 { done, stage } (테스트·진단용). */
    async start(depId) {
      if (typeof navigator !== "undefined" && navigator.onLine === false) { this._toast("온라인에서만 합칠 수 있습니다"); this.closeBar(); return { done: false, stage: "offline" }; }
      if (!this._canWrite()) { this._toast("디자이너만 합칠 수 있습니다"); return { done: false, stage: "perm" }; }
      // 저장 안 한 편집이 있으면 먼저 저장(이관은 서버 행 기준 — 화면의 미저장 핀을 빠뜨리지 않게)
      try { if (typeof App !== "undefined" && App._dirty && App._saveNow) await App._saveNow(); } catch (e) {}
      const pv = await this._req("GET", this._url(depId));
      if (pv.status !== 200) { this._toast("미리보기 실패 — " + (pv.j.error || ("HTTP " + pv.status))); this.closeBar(); return { done: false, stage: "preview" }; }
      if (pv.j.state === "alias") { this._toast("이미 원본과 연동돼 있습니다"); this.closeBar(); return { done: true, stage: "already" }; }
      if (pv.j.state !== "pending") { this._toast(pv.j.state === "ambiguous" ? "원본 영역이 하나로 정해지지 않아 합칠 수 없습니다" : "합칠 원본이 없는 구역입니다"); this.closeBar(); return { done: false, stage: "state" }; }
      if (!pv.j.ready) { this._toast("서버 준비 전(마이그레이션 0045 미적용) — 옮기지 않았습니다"); return { done: false, stage: "ready" }; }
      const ok = await Prompt.confirm("원본과 합치기", this.previewText(pv.j));
      if (!ok) { this._shown[String(depId)] = 1; return { done: false, stage: "cancel" }; }
      const r = await this._req("POST", this._url(depId), { version: pv.j.version });
      if (r.status !== 200 || !r.j.ok) { this._toast("합치기 실패 — " + (r.j.error || ("HTTP " + r.status)), 6000); return { done: false, stage: "run" }; }
      await this._reload(depId);
      if (r.j.migration_id && r.j.undo_until) {
        this._showBar(String(depId), "원본과 합쳤습니다 — 핀 " + (r.j.moved || 0) + "개", [{ label: "되돌리기", cls: "pin-alias-undo", run: (b) => { b.disabled = true; this.undo(depId, r.j.migration_id); } }], Number(r.j.undo_until));
      } else this._toast("원본과 합쳤습니다");
      return { done: true, stage: "done", moved: r.j.moved || 0 };
    },

    async undo(depId, migId) {
      const r = await this._req("POST", this._url(depId, "/undo"), { migration_id: migId });
      this.closeBar();
      if (r.status !== 200 || !r.j.ok) { this._toast("되돌리기 실패 — " + (r.j.error || ("HTTP " + r.status)), 6000); return false; }
      this._shown[String(depId)] = 1;   // 되돌린 직후 같은 안내를 다시 띄우지 않는다
      await this._reload(depId);
      this._toast("되돌렸습니다 — 구역 핀 " + (r.j.restored || 0) + "개");
      return true;
    },

    /** 지금 열린 그 도면이면 서버본으로 다시 연다(로더 SoT — App.loadDeckDrawing). */
    async _reload(depId) {
      try {
        if (typeof App !== "undefined" && App.loadDeckDrawing && typeof State !== "undefined" && String(State.currentDeploymentId) === String(depId)) await App.loadDeckDrawing(depId);
      } catch (e) {}
    },

    /* ── 하단 안내·되돌리기 바(53_PinPurge 와 같은 형태) ── */
    _showBar(depId, text, buttons, until) {
      this.closeBar();
      this._barDep = depId;
      const bar = document.createElement("div");
      bar.id = "pin-alias-bar";
      bar.setAttribute("role", "status");
      bar.setAttribute("aria-live", "polite");
      bar.style.cssText = "position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:10050;max-width:min(560px,calc(100vw - 24px));"
        + "box-sizing:border-box;background:#111827;color:#ffffff;border-radius:10px;padding:10px 12px;font-size:14px;line-height:1.45;"
        + "box-shadow:0 6px 24px rgba(0,0,0,.35);display:flex;flex-wrap:wrap;gap:8px;align-items:center;";
      const msg = document.createElement("div");
      msg.className = "pin-alias-msg";
      msg.style.cssText = "flex:1 1 220px;min-width:0;color:#ffffff;";
      msg.textContent = text;
      bar.appendChild(msg);
      const mk = (label, cls, fn, bg) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = cls;
        b.textContent = label;
        b.style.cssText = "background:" + (bg || "#fde68a") + ";color:#111827;border:0;border-radius:8px;padding:6px 12px;font-size:14px;font-weight:700;cursor:pointer;min-height:36px;";
        b.addEventListener("click", (e) => { e.stopPropagation(); fn(b); });
        bar.appendChild(b);
        return b;
      };
      (buttons || []).forEach((x) => {
        const b = mk(x.label, x.cls, x.run);
        if (until) {
          const tick = () => {
            const left = until - Date.now();
            if (left <= 0) { if (this._timer) { clearInterval(this._timer); this._timer = null; } b.remove(); return; }
            const s = Math.ceil(left / 1000);
            b.textContent = x.label + " " + Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
          };
          tick();
          this._timer = setInterval(tick, 1000);
        }
      });
      mk("닫기", "pin-alias-close", () => { if (depId != null) this._shown[String(depId)] = 1; this.closeBar(); }, "#e5e7eb");
      // 모바일 하단 도크(#mobile-dock)가 보이면 그 위로 올린다 — 도크 버튼(포인트·메뉴)을 가리지 않게(CSS 파일 무수정)
      try {
        const dock = document.getElementById("mobile-dock");
        const r = dock && dock.getBoundingClientRect();
        if (r && r.height > 0 && getComputedStyle(dock).display !== "none" && r.top < innerHeight) bar.style.bottom = Math.round(innerHeight - r.top + 12) + "px";
      } catch (e) {}
      document.body.appendChild(bar);
      this._bar = bar;
      this._msg = msg;
    },
    closeBar() {
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
      if (this._bar && this._bar.parentNode) this._bar.parentNode.removeChild(this._bar);
      this._bar = null; this._msg = null; this._barDep = null;
    }
  };
