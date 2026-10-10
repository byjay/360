  /* ══════════════════════════════════════════════════════════════
     VOICE — 음성 메모 입력 (WO 20261010-delivery 요구 B · 경쟁조사 후보 7 ①안)
     ────────────────────────────────────────────────────────────────
     브라우저 Web Speech API(SpeechRecognition / webkitSpeechRecognition, ko-KR) — 외부 비용 0, 새 의존성 0.
     🔴 인식 결과는 입력칸에 **채우기만** 한다(자동 저장·자동 전송 0 — 사람이 확인 후 기존 [등록]/[저장]으로 확정).
     🔴 숨김 금지 — 지원 안 하는 브라우저·비보안 연결이면 버튼을 비활성(aria-disabled)으로 두고 사유를 글자로 보인다.
     🔴 오프라인 정직 표시 — Chrome 계열은 인식을 서버에서 하므로 오프라인이면 실패할 수 있다. 막지는 않고
        (기기 내 인식 브라우저도 있다) 경고 글자를 상시 표시, 실패하면 오류 사유를 그대로 보인다.
     대상: 핀 노트(#input-pin-note) · 결함/이슈 노트(#pnp-input) · 요청·질문/답변(42_Requests 가 attach 호출).
     🔴 색은 인라인 리터럴(테마 변수 재해석 함정 회피 — 42_Requests/51_Coverage 와 같은 규칙):
        버튼 #ffffff on #1e3a8a 10.4:1 · 비활성 #374151 on #e5e7eb 8.6:1 · 상태칩 #78350f on #fef3c7 8.9:1.
  ══════════════════════════════════════════════════════════════ */
  const Voice = {
    LANG: "ko-KR",
    TARGETS: ["input-pin-note", "pnp-input"],
    _active: null,   // { rec, btn, input }
    STYLE: {
      ready:    "background:#1e3a8a;color:#ffffff;border:1px solid #1e3a8a;cursor:pointer",
      listening:"background:#b91c1c;color:#ffffff;border:1px solid #b91c1c;cursor:pointer",
      disabled: "background:#e5e7eb;color:#374151;border:1px solid #9ca3af;cursor:not-allowed",
      chip:     "background:#fef3c7;color:#78350f;border-radius:6px;padding:2px 6px"
    },
    ERRORS: {
      "not-allowed": "마이크 권한이 거부되었습니다 — 브라우저 주소창 옆 권한에서 허용하세요",
      "service-not-allowed": "이 브라우저에서 음성 인식 서비스가 막혀 있습니다",
      "network": "네트워크가 없어 인식하지 못했습니다(오프라인) — 연결 후 다시 시도하세요",
      "no-speech": "음성이 들리지 않았습니다 — 다시 눌러 말하세요",
      "audio-capture": "마이크를 찾을 수 없습니다",
      "aborted": "음성 입력을 멈췄습니다",
      "language-not-supported": "이 브라우저는 한국어 음성 인식을 지원하지 않습니다"
    },

    /** 순수 판정 — env {hasApi, secure, online, listening} → { state, enabled, label, reason }
     *  reason 은 사용자에게 그대로 보이는 사유 문구("" = 사유 없음, 표시 생략). */
    stateOf(env) {
      const e = env || {};
      if (!e.hasApi) return { state: "unsupported", enabled: false, label: "🎤", reason: "이 브라우저는 음성 입력을 지원하지 않습니다 — Chrome·Edge·Safari 최신판에서 사용하세요" };
      if (e.secure === false) return { state: "insecure", enabled: false, label: "🎤", reason: "보안 연결(HTTPS)에서만 음성 입력을 쓸 수 있습니다" };
      if (e.listening) return { state: "listening", enabled: true, label: "■", reason: "듣는 중… 말을 마치면 자동으로 멈춥니다(다시 누르면 중지)" };
      if (e.online === false) return { state: "offline", enabled: true, label: "🎤", reason: "오프라인 — 음성 인식이 동작하지 않을 수 있습니다" };
      return { state: "ready", enabled: true, label: "🎤", reason: "" };
    },

    /** 순수 — 기존 입력값 뒤에 인식 결과를 이어 붙인다(덮어쓰기 금지: 사람이 쓰던 글을 지우지 않는다). */
    merge(prev, text) {
      const t = String(text == null ? "" : text).trim();
      if (!t) return String(prev == null ? "" : prev);
      const p = String(prev == null ? "" : prev);
      if (!p.trim()) return t;
      return p.replace(/\s+$/, "") + " " + t;
    },

    _api() {
      if (typeof window === "undefined") return null;
      return window.SpeechRecognition || window.webkitSpeechRecognition || null;
    },
    _env(listening) {
      return {
        hasApi: !!this._api(),
        secure: (typeof window !== "undefined" && window.isSecureContext !== undefined) ? !!window.isSecureContext : true,
        online: (typeof navigator !== "undefined" && navigator.onLine !== undefined) ? !!navigator.onLine : true,
        listening: !!listening
      };
    },

    /** 입력칸(textarea/input) 뒤에 [🎤] 줄을 붙인다(멱등). 반환 = 줄 요소. */
    attach(input) {
      if (!input || typeof document === "undefined") return null;
      if (input._voiceRow && input._voiceRow.isConnected) return input._voiceRow;
      if (!input.parentNode) return null;
      const row = document.createElement("div");
      row.className = "voice-row";
      row.setAttribute("data-voice-row", input.id || "1");
      row.style.cssText = "display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:4px 0;font:12px/1.4 sans-serif";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "voice-btn";
      btn.setAttribute("data-voice-btn", input.id || "1");
      const status = document.createElement("span");
      status.className = "voice-status";
      status.setAttribute("data-voice-status", "1");
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      row.appendChild(btn); row.appendChild(status);
      input.insertAdjacentElement("afterend", row);
      input._voiceRow = row;
      row._input = input;
      btn.addEventListener("click", (ev) => {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        this.toggle(input, row);
      });
      this._paint(row, this.stateOf(this._env(false)));
      return row;
    },

    _paint(row, st, msg) {
      const btn = row.querySelector("[data-voice-btn]");
      const status = row.querySelector("[data-voice-status]");
      row.dataset.voiceState = st.state;
      btn.textContent = st.label + (st.state === "listening" ? " 멈춤" : " 음성");
      btn.style.cssText = "padding:4px 10px;border-radius:6px;font:700 12px/1.2 sans-serif;" + (st.enabled ? (st.state === "listening" ? this.STYLE.listening : this.STYLE.ready) : this.STYLE.disabled);
      btn.setAttribute("aria-disabled", st.enabled ? "false" : "true");
      const text = msg || st.reason || "";
      btn.title = text || "음성으로 입력(한국어) — 결과는 입력칸에만 채워지고 저장은 직접 합니다";
      btn.setAttribute("aria-label", "음성 입력" + (text ? " — " + text : ""));
      status.textContent = text;
      status.style.cssText = text ? this.STYLE.chip : "display:none";
    },

    /** 모든 줄의 상태 재계산(온라인/오프라인 전환 시). 듣는 중인 줄은 건드리지 않는다. */
    refreshAll() {
      if (typeof document === "undefined") return;
      document.querySelectorAll("[data-voice-row]").forEach((row) => {
        if (this._active && this._active.row === row) return;
        this._paint(row, this.stateOf(this._env(false)));
      });
    },

    toggle(input, row) {
      const st = this.stateOf(this._env(false));
      if (!st.enabled) {   // 비활성이어도 눌렀을 때 사유를 다시 보인다(모바일은 title 이 안 보인다)
        this._paint(row, st);
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast(st.reason, 3600);
        return false;
      }
      if (this._active) {
        const same = this._active.row === row;
        this.stop();
        if (same) return false;
      }
      return this.start(input, row);
    },

    start(input, row) {
      const Api = this._api();
      if (!Api) return false;
      let rec;
      try { rec = new Api(); } catch (e) { this._paint(row, this.stateOf(this._env(false)), "음성 인식을 시작하지 못했습니다"); return false; }
      rec.lang = this.LANG;
      rec.interimResults = false;
      rec.continuous = false;
      rec.maxAlternatives = 1;
      const act = { rec, row, input, error: null };
      this._active = act;
      rec.onresult = (ev) => {
        let text = "";
        const res = ev && ev.results;
        if (res) for (let i = (ev.resultIndex || 0); i < res.length; i++) { const r = res[i]; if (r && r[0] && (r.isFinal !== false)) text += r[0].transcript; }
        if (!text.trim()) return;
        input.value = this.merge(input.value, text);
        // 기존 입력 리스너(초안 보존·글자수 등)가 알도록 input 이벤트만 보낸다 — submit/저장 이벤트는 보내지 않는다.
        try { input.dispatchEvent(new Event("input", { bubbles: true })); } catch (e) {}
      };
      rec.onerror = (ev) => {
        const code = (ev && ev.error) || "unknown";
        act.error = this.ERRORS[code] || ("음성 인식 오류(" + code + ")");
      };
      rec.onend = () => {
        if (this._active === act) this._active = null;
        this._paint(row, this.stateOf(this._env(false)), act.error || "");
        try { input.focus(); } catch (e) {}
      };
      try { rec.start(); } catch (e) {
        this._active = null;
        this._paint(row, this.stateOf(this._env(false)), "음성 인식을 시작하지 못했습니다(" + (e && e.name || "오류") + ")");
        return false;
      }
      this._paint(row, this.stateOf(this._env(true)));
      return true;
    },

    stop() {
      const a = this._active;
      if (!a) return;
      try { a.rec.stop(); } catch (e) {}
    },

    init() {
      if (typeof document === "undefined") return;
      this.TARGETS.forEach((id) => { const el = document.getElementById(id); if (el) this.attach(el); });
      if (!this._netBound && typeof window !== "undefined") {
        this._netBound = true;
        window.addEventListener("online", () => this.refreshAll());
        window.addEventListener("offline", () => this.refreshAll());
      }
    }
  };
