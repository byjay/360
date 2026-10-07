  /* ══════════════════════════════════════════════════════════════
     AI VISION — 360 사진 AI 분석 (WO 20261007-aivision, 지휘자 발주 2026-10-07)
     장비·결함·위험 후보 태깅 + 이전 사진 대비 변화 요약 + 결함 등록 제안.
     ────────────────────────────────────────────────────────────────
     🔴 AI 는 제안만 한다 — 결함 등록은 기존 결함 작성 폼(#pnp-form)을 미리 채우기만 하고 사람이 [등록]을 눌러야
        저장된다. 360 마커도 임시 레이어(PanoViewer.setAiSpots)로 보여만 주고 [마커 저장]을 눌러야 pin.spots 에 들어간다.
     🔴 숨김 금지 — 권한·사진·오프라인·키·한도가 안 맞아도 버튼은 보이고 비활성 + 사유(buttonState 가 SoT).
     🔴 오프라인 — 비활성("온라인에서 사용"). 요청을 큐(OpLog/SyncQueue)에 넣지 않는다(비용·중복 방지).
     🔴 서버 응답은 데이터로만 — 전부 UI.escapeHtml 로 이스케이프(프롬프트 인젝션 대비).
     🔴 새 CSS 규칙 0 — 인라인 스타일, 리터럴 hex(36_Help.js 관례: OS 강제다크가 var() 만 밝게 재해석하는 함정 회피).
        대비 실측 근거: light 본문 #0f172a/#fff 17.9:1 · 보조 #475569/#fff 7.6:1 · 「추정」 #92400e/#fef3c7 6.4:1
                      dark 본문 #f1f5f9/#0a1020 17:1 · 보조 #cbd5e1/#0a1020 12:1 · 버튼 #fff/#1d4ed8 6.3:1
     좌표 SoT — 서버 스키마 yaw(이미지 왼쪽 끝 0 → 오른쪽 끝 360)·pitch(위 +90 → 아래 -90) 는 06_PanoViewer 의
        lon/lat 과 같은 축(SphereGeometry u→θ, scale(-1,1,1) 내부 시점)이라 변환 없이 lon=yaw, lat=pitch.
     🔴 반드시 `_manifest.txt` 에 등록해야 번들(main.js)에 포함된다.
  ══════════════════════════════════════════════════════════════ */
  const AiVision = {
    /** 「추정」 기준(서버 estimate_p 가 오면 그 값이 SoT — 전역 §1-B 0.70 과 동일). */
    ESTIMATE_P: 0.7,
    STATUS_TTL_MS: 60000,
    SEV_MAP: { low: "하", mid: "중", high: "상" },   // 서버 enum → 기존 결함 폼(#pnp-severity) 값
    KIND_ICON: { equipment: "⚙", defect: "⚠", hazard: "⚡", other: "•" },
    KIND_LABEL: { equipment: "장비", defect: "결함", hazard: "위험", other: "기타" },
    KIND_SPOT: { equipment: "equip", defect: "defect", hazard: "safety", other: "note" },   // 06_PanoViewer 마커 kind
    _status: null, _statusAt: 0,
    _results: {},        // pinId → 마지막 서버 응답(세션 메모리 — 서버 캐시가 정본)
    _hosts: {},          // hostId → { pin, opts }
    _busy: false,
    _inited: false,

    init() {
      if (this._inited || typeof window === "undefined" || !window.addEventListener) return;
      this._inited = true;
      // 오프라인 ↔ 온라인 전환 시 버튼 상태(사유) 즉시 재계산 — 숨김 없이 사유만 바뀐다
      window.addEventListener("online", () => this._refreshHosts());
      window.addEventListener("offline", () => this._refreshHosts());
    },

    _esc(s) { return (typeof UI !== "undefined" && UI.escapeHtml) ? UI.escapeHtml(String(s == null ? "" : s)) : String(s == null ? "" : s); },
    _toast(m, ms) { try { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast(m, ms || 3200); } catch (e) {} },
    _online() { return (typeof navigator === "undefined") ? true : navigator.onLine !== false; },
    canEdit() {
      const A = (typeof Auth !== "undefined") ? Auth : null;
      return !!(A && A.isDesigner && !A.readonly) && (typeof State === "undefined" || State.mode === "designer");
    },
    /** 서버가 읽을 수 있는 사진만 "있다"고 본다(D1 imageId 또는 /api/r2/object/<key> URL). 외부 URL·업로드 전 미리보기는 불가. */
    hasPhoto(pin) {
      if (!pin) return false;
      if (pin.imageId) return true;
      return typeof pin.imageUrl === "string" && /^\/api\/r2\/object\//.test(pin.imageUrl);
    },
    /** 비교(이전 사진) 식별자 — 이력(timeline) 중 가장 최근의 서버가 읽을 수 있는 항목. 없으면 null. */
    compareIdOf(pin) {
      const tl = (pin && Array.isArray(pin.timeline)) ? pin.timeline : [];
      for (let i = tl.length - 1; i >= 0; i--) {
        const t = tl[i]; if (!t) continue;
        if (t.imageId) return String(t.imageId);
        const m = typeof t.imageUrl === "string" ? t.imageUrl.match(/^\/api\/r2\/object\/([^?#]+)/) : null;
        if (m) return m[1];
      }
      return null;
    },
    imageIdOf(pin) {
      if (!pin) return null;
      if (pin.imageId) return String(pin.imageId);
      const m = typeof pin.imageUrl === "string" ? pin.imageUrl.match(/^\/api\/r2\/object\/([^?#]+)/) : null;
      return m ? m[1] : null;
    },

    /** 🔴 버튼 상태 SoT(순수) — 순서: 권한 → 온라인 → 사진 → 키 → 한도. "" = 사용 가능. */
    buttonState(a) {
      a = a || {};
      if (!a.canEdit) return { disabled: true, reason: "디자이너(편집) 전용 — 열람 화면에서는 사용할 수 없습니다" };
      if (!a.online) return { disabled: true, reason: "온라인에서 사용 — 오프라인에서는 AI 분석을 보내지 않습니다" };
      if (!a.pin || !this.hasPhoto(a.pin)) {
        const pending = !!(a.pin && (a.pin.pendingOpId || a.pin.localPreview));
        return { disabled: true, reason: pending ? "사진 업로드(동기화)가 끝난 뒤 사용할 수 있습니다" : "사진이 없습니다 — 먼저 360 사진을 등록하세요" };
      }
      const s = a.status;
      if (s && s.enabled === false) return { disabled: true, reason: s.reason || "AI 분석 비활성" };
      if (s && typeof s.remaining === "number" && s.remaining <= 0) return { disabled: true, reason: "오늘 한도 소진(" + (s.daily_limit || "") + "회/24h) — 내일 다시 사용할 수 있습니다" };
      return { disabled: false, reason: "" };
    },
    isEstimated(conf, p) { return !(typeof conf === "number") || conf < (typeof p === "number" ? p : this.ESTIMATE_P); },

    async fetchStatus(force) {
      if (!force && this._status && Date.now() - this._statusAt < this.STATUS_TTL_MS) return this._status;
      if (!this._online()) return this._status;
      if (typeof fetch !== "function" || typeof Auth === "undefined" || !Auth.headers) return this._status;
      try {
        const r = await fetch("/api/ai/vision-status", { headers: Auth.headers() });
        if (r.status === 401) this._status = { enabled: false, reason: "로그인 후 사용" };
        else this._status = await r.json();
      } catch (e) {
        this._status = { enabled: false, reason: "서버에 연결할 수 없습니다(상태 확인 실패)" };
      }
      this._statusAt = Date.now();
      return this._status;
    },

    /* ─── 마운트/렌더 ─── */
    /** hostId 요소 안에 [🤖 AI 분석] 버튼 + 사유 + 결과 카드를 그린다. opts.theme: "light"(핀 팝업) | "dark"(360 패널). */
    mount(hostId, pin, opts) {
      this._hosts[hostId] = { pin, opts: opts || {} };
      this.render(hostId);
      // 상태(키·한도)는 비동기로 보강 — 먼저 그리고(사유: 권한/사진/오프라인은 즉시) 받으면 다시 그린다
      const st = this._status;
      if (!st || Date.now() - this._statusAt >= this.STATUS_TTL_MS) this.fetchStatus().then(() => { if (this._hosts[hostId]) this.render(hostId); });
    },
    unmount(hostId) { delete this._hosts[hostId]; },
    _refreshHosts() { Object.keys(this._hosts).forEach((id) => this.render(id)); },
    _theme(t) {
      return t === "dark"
        ? { text: "#f1f5f9", muted: "#cbd5e1", border: "rgba(255,255,255,.18)", bg: "rgba(255,255,255,.06)", pill: "rgba(255,255,255,.14)", pillText: "#f1f5f9", est: "rgba(251,191,36,.2)", estText: "#fde68a", btn: "#1d4ed8", btnText: "#ffffff", btn2: "rgba(255,255,255,.12)", btn2Text: "#f1f5f9" }
        : { text: "#0f172a", muted: "#475569", border: "rgba(0,0,0,.12)", bg: "#f8fafc", pill: "#e2e8f0", pillText: "#1e293b", est: "#fef3c7", estText: "#92400e", btn: "#1d4ed8", btnText: "#ffffff", btn2: "#e2e8f0", btn2Text: "#0f172a" };
    },
    render(hostId) {
      const h = this._hosts[hostId]; if (!h) return;
      const host = document.getElementById(hostId); if (!host) return;
      const pin = h.pin, T = this._theme(h.opts.theme);
      const canEdit = (typeof h.opts.canEdit === "boolean") ? h.opts.canEdit : this.canEdit();
      const st = this.buttonState({ pin, online: this._online(), status: this._status, canEdit });
      const busy = this._busy;
      const res = pin ? this._results[pin.id] : null;
      const cmpId = this.compareIdOf(pin);
      const esc = (s) => this._esc(s);
      let html = '<div class="aiv-box" style="color:' + T.text + ';font-size:12px;">';
      html += '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">';
      html += '<button type="button" id="' + esc(hostId) + '-run" class="aiv-run" data-help="ai-analyze" aria-disabled="' + (st.disabled || busy) + '" ' +
        'style="display:inline-flex;align-items:center;gap:6px;min-height:40px;padding:8px 14px;border-radius:10px;border:1px solid transparent;font-size:13px;font-weight:700;cursor:' + ((st.disabled || busy) ? "not-allowed" : "pointer") + ';' +
        'background:' + T.btn + ';color:' + T.btnText + ';opacity:' + ((st.disabled || busy) ? ".55" : "1") + ';">' +
        '<span aria-hidden="true">🤖</span><span>' + (busy ? "분석 중…" : (res ? "AI 다시 분석" : "AI 분석")) + '</span></button>';
      if (pin && !st.disabled && cmpId && !busy) {
        html += '<button type="button" id="' + esc(hostId) + '-cmp" class="aiv-cmp" style="min-height:40px;padding:8px 12px;border-radius:10px;border:1px solid ' + T.border + ';background:' + T.btn2 + ';color:' + T.btn2Text + ';font-size:12px;font-weight:700;cursor:pointer;">이전 사진과 비교</button>';
      }
      html += '</div>';
      if (st.disabled) html += '<div class="aiv-reason" style="margin-top:6px;color:' + T.muted + ';">' + esc(st.reason) + '</div>';
      else if (this._status && typeof this._status.remaining === "number") html += '<div class="aiv-quota" style="margin-top:6px;color:' + T.muted + ';">오늘 남은 횟수 ' + esc(this._status.remaining) + '/' + esc(this._status.daily_limit) + ' · 같은 사진은 다시 과금되지 않습니다(캐시)</div>';
      if (h.error) html += '<div class="aiv-error" style="margin-top:8px;color:' + (h.opts.theme === "dark" ? "#fca5a5" : "#b91c1c") + ';">' + esc(h.error) + '</div>';
      if (res && res.result) html += this._card(res, pin, T, hostId);
      html += '</div>';
      host.innerHTML = html;
      const run = document.getElementById(hostId + "-run");
      if (run) run.addEventListener("click", () => {
        if (busy) return;
        if (st.disabled) { this._toast("AI 분석 — " + st.reason, 4200); return; }
        this.analyze(hostId, { compare: false });
      });
      const cmp = document.getElementById(hostId + "-cmp");
      if (cmp) cmp.addEventListener("click", () => { if (!busy) this.analyze(hostId, { compare: true }); });
      this._bindCard(hostId, pin, res);
    },
    _card(res, pin, T, hostId) {
      const esc = (s) => this._esc(s);
      const r = res.result, P = (typeof res.estimate_p === "number") ? res.estimate_p : this.ESTIMATE_P;
      const pct = (c) => Math.round((Number(c) || 0) * 100) + "%";
      const estBadge = (c) => this.isEstimated(c, P) ? ' <span class="aiv-est" style="display:inline-block;padding:1px 6px;border-radius:999px;background:' + T.est + ';color:' + T.estText + ';font-size:11px;font-weight:700;">추정</span>' : "";
      let html = '<div class="aiv-card" style="margin-top:10px;padding:10px 12px;border:1px solid ' + T.border + ';border-radius:10px;background:' + T.bg + ';">';
      html += '<div style="font-weight:700;margin-bottom:4px;">AI 요약' + (res.cached ? ' <span style="font-weight:400;color:' + T.muted + ';">(캐시)</span>' : "") + '</div>';
      html += '<div class="aiv-summary" style="line-height:1.5;">' + esc(r.summary) + '</div>';
      const items = Array.isArray(r.items) ? r.items : [];
      html += '<div style="font-weight:700;margin:10px 0 4px;">항목 ' + items.length + '</div>';
      if (!items.length) html += '<div style="color:' + T.muted + ';">감지된 항목이 없습니다.</div>';
      else {
        html += '<ul class="aiv-items" style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;">';
        items.forEach((it, i) => {
          const hasPos = typeof it.yaw === "number" && typeof it.pitch === "number";
          html += '<li class="aiv-item" data-kind="' + esc(it.kind) + '" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">' +
            '<span aria-hidden="true">' + esc(this.KIND_ICON[it.kind] || "•") + '</span>' +
            '<span style="padding:1px 6px;border-radius:999px;background:' + T.pill + ';color:' + T.pillText + ';font-size:11px;">' + esc(this.KIND_LABEL[it.kind] || it.kind) + '</span>' +
            '<span>' + esc(it.label) + '</span>' +
            '<span style="color:' + T.muted + ';">' + pct(it.confidence) + '</span>' + estBadge(it.confidence) +
            (hasPos ? '<span title="360 안 위치 있음" style="color:' + T.muted + ';">📍' + (i + 1) + '</span>' : "") + '</li>';
        });
        html += '</ul>';
      }
      if (r.change_summary) html += '<div style="font-weight:700;margin:10px 0 4px;">이전 사진 대비 변화</div><div class="aiv-change" style="line-height:1.5;">' + esc(r.change_summary) + '</div>';
      else if (res.compare) html += '<div style="margin-top:8px;color:' + T.muted + ';">이전 사진 대비 변화: 보고된 변화 없음</div>';
      const d = r.defect_suggestion;
      if (d) {
        const sev = this.SEV_MAP[d.severity] || d.severity;
        html += '<div class="aiv-defect" style="margin-top:10px;padding:8px 10px;border:1px dashed ' + T.border + ';border-radius:8px;">' +
          '<div style="font-weight:700;">결함 등록 제안 <span style="font-weight:400;color:' + T.muted + ';">심각도 ' + esc(sev) + ' · ' + pct(d.confidence) + '</span>' + estBadge(d.confidence) + '</div>' +
          '<div style="margin-top:2px;">' + esc(d.title) + '</div><div style="color:' + T.muted + ';margin-top:2px;">' + esc(d.detail) + '</div>' +
          '<button type="button" id="' + esc(hostId) + '-defect" class="aiv-defect-btn" style="margin-top:8px;min-height:36px;padding:6px 12px;border-radius:8px;border:1px solid transparent;background:' + T.btn + ';color:' + T.btnText + ';font-weight:700;cursor:pointer;">결함으로 등록(폼 채우기)</button>' +
          '<div style="margin-top:4px;color:' + T.muted + ';font-size:11px;">폼이 미리 채워질 뿐입니다 — 내용 확인 후 사람이 [등록]을 눌러야 저장됩니다.</div></div>';
      }
      const posN = items.filter((it) => typeof it.yaw === "number" && typeof it.pitch === "number").length;
      if (posN) {
        const showing = typeof PanoViewer !== "undefined" && PanoViewer._aiSpotsPinId != null && pin && String(PanoViewer._aiSpotsPinId) === String(pin.id);
        html += '<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;">' +
          '<button type="button" id="' + esc(hostId) + '-mark" class="aiv-mark-btn" style="min-height:36px;padding:6px 12px;border-radius:8px;border:1px solid ' + T.border + ';background:' + T.btn2 + ';color:' + T.btn2Text + ';font-weight:700;cursor:pointer;">' + (showing ? "360 마커 지우기" : "360 안에 마커 보기(" + posN + ")") + '</button>' +
          (showing ? '<button type="button" id="' + esc(hostId) + '-marksave" class="aiv-marksave-btn" style="min-height:36px;padding:6px 12px;border-radius:8px;border:1px solid transparent;background:' + T.btn + ';color:' + T.btnText + ';font-weight:700;cursor:pointer;">마커로 저장(사람 확정)</button>' : "") +
          '</div>';
      }
      const u = res.usage || {};
      const cost = (typeof u.cost_usd === "number") ? ("$" + u.cost_usd.toFixed(4)) : "비용 미보고";
      html += '<div class="aiv-meta" style="margin-top:8px;color:' + T.muted + ';font-size:11px;">' + esc(res.model || "") + ' · 토큰 ' + esc(u.prompt_tokens != null ? u.prompt_tokens : "?") + '/' + esc(u.completion_tokens != null ? u.completion_tokens : "?") + ' · ' + esc(cost) +
        (res.analyzed_at ? ' · ' + esc(new Date(res.analyzed_at).toLocaleString()) : "") + ' · 신뢰도 ' + Math.round(P * 100) + '% 미만은 「추정」</div>';
      html += '</div>';
      return html;
    },
    _bindCard(hostId, pin, res) {
      if (!res || !res.result) return;
      const d = document.getElementById(hostId + "-defect");
      if (d) d.addEventListener("click", () => this.prefillDefect(pin, res.result.defect_suggestion, res.estimate_p));
      const m = document.getElementById(hostId + "-mark");
      if (m) m.addEventListener("click", () => {
        const showing = typeof PanoViewer !== "undefined" && PanoViewer._aiSpotsPinId != null && String(PanoViewer._aiSpotsPinId) === String(pin.id);
        if (showing) this.clearMarkers(); else this.showMarkers(pin, res.result.items, res.estimate_p);
      });
      const s = document.getElementById(hostId + "-marksave");
      if (s) s.addEventListener("click", () => this.saveMarkers(pin));
    },

    /* ─── 분석 호출 ─── */
    async analyze(hostId, o) {
      const h = this._hosts[hostId]; if (!h || !h.pin) return null;
      const pin = h.pin;
      const st = this.buttonState({ pin, online: this._online(), status: this._status, canEdit: (typeof h.opts.canEdit === "boolean") ? h.opts.canEdit : this.canEdit() });
      if (st.disabled) { this._toast("AI 분석 — " + st.reason, 4200); return null; }
      // 🔴 오프라인이면 여기서 끝 — 큐 적립 없음(발주서 §3)
      if (!this._online()) { this._toast("온라인에서 사용 — 오프라인 요청은 저장하지 않습니다"); return null; }
      const dep = (typeof State !== "undefined") ? State.currentDeploymentId : null;
      if (!dep) { h.error = "배포본이 없습니다 — 도면을 먼저 저장한 뒤 사용하세요"; this.render(hostId); return null; }
      const body = { deployment_id: dep, pin_id: pin.id, image_id: this.imageIdOf(pin) };
      if (o && o.compare) { const c = this.compareIdOf(pin); if (c) body.compare_image_id = c; }
      this._busy = true; h.error = null; this._refreshHosts();
      let out = null;
      try {
        const r = await fetch("/api/ai/analyze-photo", { method: "POST", headers: Auth.headers(), body: JSON.stringify(body) });
        let j = null; try { j = await r.json(); } catch (e) {}
        if (r.ok && j && j.ok) {
          this._results[pin.id] = j; out = j;
          if (typeof j.estimate_p === "number") this.ESTIMATE_P = j.estimate_p;
          if (!j.cached) { this._statusAt = 0; }   // 사용량 변동 → 다음 렌더에서 재조회
          this._toast(j.cached ? "AI 분석 결과(캐시) 불러옴" : "AI 분석 완료 — " + ((j.result.items || []).length) + "개 항목");
        } else {
          h.error = (j && j.error) ? j.error : ("AI 분석 실패(" + r.status + ")");
          if (r.status === 503 || r.status === 429) { this._statusAt = 0; }
        }
      } catch (e) {
        h.error = "네트워크 오류 — 잠시 후 다시 시도하세요";
      }
      this._busy = false;
      if (this._statusAt === 0) await this.fetchStatus(true);
      this._refreshHosts();
      return out;
    },

    /* ─── 결함 등록 제안 → 기존 결함 폼 미리 채우기(저장 0) ─── */
    _waitFor(cond, ms) {
      return new Promise((resolve) => {
        const t0 = Date.now();
        const tick = () => { let v = false; try { v = !!cond(); } catch (e) {} if (v) return resolve(true); if (Date.now() - t0 > ms) return resolve(false); setTimeout(tick, 60); };
        tick();
      });
    },
    /** 🔴 사람이 확정해야 저장된다 — 여기서는 #pnp-input/#pnp-severity 값만 채우고 포커스를 준다(fetch/OpLog 0). */
    async prefillDefect(pin, s, estimateP) {
      if (!pin || !s) return false;
      if (!this.canEdit()) { this._toast("디자이너(편집) 전용"); return false; }
      const P = (typeof estimateP === "number") ? estimateP : this.ESTIMATE_P;
      const inPano = typeof PanoViewer !== "undefined" && PanoViewer.open && PanoViewer._currentPin && String(PanoViewer._currentPin.id) === String(pin.id);
      if (!inPano) {
        if (typeof PinActionPop !== "undefined" && PinActionPop.close) { try { PinActionPop.close(); } catch (e) {} }
        if (typeof App === "undefined" || !App.openPano) return false;
        App.openPano(pin);
        const opened = await this._waitFor(() => { const ov = document.getElementById("pano-overlay"); return ov && ov.classList && !ov.classList.contains("hidden"); }, 4000);
        if (!opened) { this._toast("360 뷰어를 열 수 없어 결함 폼을 채우지 못했습니다"); return false; }
      }
      if (typeof Notes === "undefined" || !Notes.openPanel) return false;
      Notes.setPin(pin);
      Notes.openPanel();
      const input = document.getElementById("pnp-input");
      const sev = document.getElementById("pnp-severity");
      const estimated = this.isEstimated(s.confidence, P);
      if (input) input.value = String(s.title || "").trim() + (s.detail ? "\n" + String(s.detail).trim() : "") + "\n(AI 제안 · 신뢰도 " + Math.round((Number(s.confidence) || 0) * 100) + "%" + (estimated ? " · 추정" : "") + ")";
      // 심각도 — 신뢰도 ≥ 기준이면 채우고, 「추정」이면 비워 사람이 고르게 한다(jevSeverity 게이트와 같은 정책)
      if (sev) sev.value = estimated ? "" : (this.SEV_MAP[s.severity] || "");
      if (input && input.focus) { try { input.focus(); } catch (e) {} }
      this._toast(estimated ? "AI 제안(추정)을 채웠습니다 — 심각도는 직접 고르고 [등록]을 눌러야 저장됩니다" : "AI 제안을 채웠습니다 — 내용 확인 후 [등록]을 눌러야 저장됩니다", 4800);
      return true;
    },

    /* ─── 360 임시 마커(저장 전) ─── */
    toSpots(items, estimateP) {
      const P = (typeof estimateP === "number") ? estimateP : this.ESTIMATE_P;
      return (Array.isArray(items) ? items : []).filter((it) => typeof it.yaw === "number" && typeof it.pitch === "number").map((it, k) => ({
        id: "ai-" + k, lon: it.yaw, lat: it.pitch, kind: this.KIND_SPOT[it.kind] || "note",
        label: String(it.label || "") + (this.isEstimated(it.confidence, P) ? " (추정)" : ""),
        note: "AI " + (this.KIND_LABEL[it.kind] || it.kind) + " · 신뢰도 " + Math.round((Number(it.confidence) || 0) * 100) + "%",
        ai: true, confidence: it.confidence, ts: Date.now()
      }));
    },
    async showMarkers(pin, items, estimateP) {
      if (typeof PanoViewer === "undefined" || !PanoViewer.setAiSpots) return false;
      const spots = this.toSpots(items, estimateP);
      if (!spots.length) { this._toast("위치(yaw/pitch)가 있는 항목이 없습니다"); return false; }
      const inPano = PanoViewer.open && PanoViewer._currentPin && String(PanoViewer._currentPin.id) === String(pin.id);
      if (!inPano) {
        if (typeof PinActionPop !== "undefined" && PinActionPop.close) { try { PinActionPop.close(); } catch (e) {} }
        if (typeof App === "undefined" || !App.openPano) return false;
        App.openPano(pin);
        const opened = await this._waitFor(() => PanoViewer.open && PanoViewer._currentPin && String(PanoViewer._currentPin.id) === String(pin.id), 4000);
        if (!opened) return false;
      }
      PanoViewer.setAiSpots(pin.id, spots);
      PanoViewer.renderSpots(pin.spots || []);
      this._refreshHosts();
      this._toast("AI 마커 " + spots.length + "개 표시(임시) — [마커로 저장]을 눌러야 남습니다");
      return true;
    },
    clearMarkers() {
      if (typeof PanoViewer === "undefined" || !PanoViewer.setAiSpots) return;
      PanoViewer.setAiSpots(null, null);
      if (PanoViewer._currentPin) PanoViewer.renderSpots(PanoViewer._currentPin.spots || []);
      this._refreshHosts();
    },
    /** 사람이 [마커로 저장] — 임시 마커를 pin.spots(기존 마커 데이터 모델) 에 옮기고 기존 저장 경로(App._saveSpots) 재사용. */
    saveMarkers(pin) {
      if (typeof PanoViewer === "undefined" || !PanoViewer._aiSpots || String(PanoViewer._aiSpotsPinId) !== String(pin.id)) return 0;
      if (!this.canEdit()) { this._toast("디자이너(편집) 전용"); return 0; }
      if (!Array.isArray(pin.spots)) pin.spots = [];
      const n = PanoViewer._aiSpots.length;
      PanoViewer._aiSpots.forEach((s) => {
        pin.spots.push({ id: "sp-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), lon: s.lon, lat: s.lat, label: s.label, note: s.note, kind: s.kind, ts: Date.now(), ai: true, confidence: s.confidence });
      });
      PanoViewer.setAiSpots(null, null);
      PanoViewer.renderSpots(pin.spots);
      if (typeof App !== "undefined" && App._saveSpots) { try { App._saveSpots(pin); } catch (e) {} }
      this._refreshHosts();
      this._toast("AI 마커 " + n + "개를 이 포인트 마커로 저장했습니다(미저장 표시 — [저장]으로 서버 반영)");
      return n;
    },
    /** 임시 AI 마커 탭 → 라벨·노트 안내(편집 폼 없음 — 저장 전이라 수정 대상이 아님). App._openSpot 이 못 찾을 때 호출. */
    describeSpot(id) {
      if (typeof PanoViewer === "undefined" || !PanoViewer._aiSpots) return false;
      const s = PanoViewer._aiSpots.find((x) => x.id === id); if (!s) return false;
      this._toast(s.label + " — " + s.note + " · 임시 마커([마커로 저장] 전)", 3600);
      return true;
    },

    /* ─── 360 뷰어 패널(#pano-ai-panel) ─── */
    togglePanoPanel() {
      const p = document.getElementById("pano-ai-panel"); if (!p) return;
      const pin = (typeof PanoViewer !== "undefined") ? PanoViewer._currentPin : null;
      if (!p.classList.contains("hidden")) { p.classList.add("hidden"); this.unmount("pano-ai-host"); return; }
      p.innerHTML = '<div class="pano-info-title"><span>AI 분석</span><button class="pano-info-close" id="pano-ai-close" title="닫기" aria-label="닫기">✕</button></div><div id="pano-ai-host"></div>';
      p.classList.remove("hidden");
      const c = document.getElementById("pano-ai-close");
      if (c) c.addEventListener("click", () => { p.classList.add("hidden"); this.unmount("pano-ai-host"); });
      this.mount("pano-ai-host", pin, { theme: "dark" });
    },
    onPanoOpen() {
      const p = document.getElementById("pano-ai-panel");
      if (p) { p.classList.add("hidden"); p.innerHTML = ""; }
      this.unmount("pano-ai-host");
      if (typeof PanoViewer !== "undefined" && PanoViewer.setAiSpots) PanoViewer.setAiSpots(null, null);
    },
    onPanoClose() { this.onPanoOpen(); }
  };
