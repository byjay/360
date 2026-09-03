  const Prompt = {
    _resolve: null,
    init() {
      const $ = (id) => document.getElementById(id);
      $("prompt-modal-ok") && $("prompt-modal-ok").addEventListener("click", () => this._submit());
      $("prompt-modal-cancel") && $("prompt-modal-cancel").addEventListener("click", () => this._close(null));
      const bd = document.querySelector('#prompt-modal .admin-gate-backdrop');
      bd && bd.addEventListener("click", () => this._close(null));
      const inp = $("prompt-modal-input");
      if (inp) inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); this._submit(); } if (e.key === "Escape") this._close(null); });
    },
    /** [스팸 방지] 동시에 화면에 떠 있을 수 있는 토스트 최대 개수.
     *  이 캡이 없으면 버튼 연타·연쇄 액션 시 토스트가 세로로 무한정 쌓여
     *  360 뷰어 컨트롤바를 가리는 "검은 박스 스택"이 된다(마스터 스크린샷 실측). */
    TOAST_MAX: 2,
    /** 가벼운 토스트 알림 (화면 하단 중앙, 자동 소멸) */
    toast(msg, ms) {
      // [빈 토스트 방지] 빈/undefined/공백 메시지는 내용 없는 검은 상자만 띄우므로 무시.
      const text = (msg === undefined || msg === null) ? "" : String(msg).trim();
      if (!text) return;
      let host = document.getElementById("wm-toast-host");
      if (!host) {
        host = document.createElement("div");
        host.id = "wm-toast-host";
        host.className = "wm-toast-host";
        document.body.appendChild(host);
      }
      const life = ms || 2200;
      const kill = (el) => {
        if (el._wmT) { clearTimeout(el._wmT); el._wmT = null; }
        if (el._wmT2) { clearTimeout(el._wmT2); el._wmT2 = null; }
        el.remove();
      };
      const arm = (el, dur) => {
        if (el._wmT) clearTimeout(el._wmT);
        el._wmT = setTimeout(() => {
          el.classList.remove("on");
          el._wmT2 = setTimeout(() => el.remove(), 280);
        }, dur);
      };
      // ① 같은 메시지가 이미 떠 있으면 새로 쌓지 말고 수명만 연장(중복 스택 차단)
      const dup = Array.prototype.filter.call(host.children, (n) => n.dataset && n.dataset.wmMsg === text)[0];
      if (dup) { arm(dup, life); return; }
      // ② 캡 초과분은 가장 오래된 것부터 즉시 제거 — 어떤 호출부가 남아 있어도 무한 스택 불가
      while (host.children.length >= this.TOAST_MAX) kill(host.firstElementChild);
      const t = document.createElement("div");
      t.className = "wm-toast";
      t.textContent = text;
      t.dataset.wmMsg = text;
      host.appendChild(t);
      requestAnimationFrame(() => t.classList.add("on"));
      arm(t, life);
    },
    /** opts: { title, sub, placeholder, second } → Promise<string|{value,second}|null> */
    ask(opts) {
      return new Promise((resolve) => {
        this._resolve = resolve;
        document.getElementById("prompt-modal-title").textContent = opts.title || "입력";
        document.getElementById("prompt-modal-sub").textContent = opts.sub || "";
        const inp = document.getElementById("prompt-modal-input");
        inp.value = opts.value || ""; inp.placeholder = opts.placeholder || ""; this._allowEmpty = !!opts.allowEmpty;
        const inp2 = document.getElementById("prompt-modal-input2");
        inp2.value = opts.secondValue || "";
        inp2.placeholder = (typeof opts.second === "string") ? opts.second : "";
        inp2.classList.toggle("hidden", !opts.second);
        document.getElementById("prompt-modal-error").classList.add("hidden");
        const m = document.getElementById("prompt-modal");
        m.classList.remove("hidden");
        requestAnimationFrame(() => m.classList.add("on"));
        setTimeout(() => inp.focus(), 60);
      });
    },
    _submit() {
      const inp = document.getElementById("prompt-modal-input");
      const inp2 = document.getElementById("prompt-modal-input2");
      const err = document.getElementById("prompt-modal-error");
      const val = (inp.value || "").trim();
      if (!val && !this._allowEmpty) { err.textContent = "값을 입력하세요."; err.classList.remove("hidden"); return; }
      const second = inp2.classList.contains("hidden") ? undefined : (inp2.value || "").trim();
      this._close({ value: val, second });
    },
    _close(result) {
      const m = document.getElementById("prompt-modal");
      m.classList.remove("on");
      setTimeout(() => m.classList.add("hidden"), 200);
      // [버그수정] 에러 텍스트 잔류 정리 — 다음 ask 모달에 이전 오류가 깜빡이지 않게
      const err = document.getElementById("prompt-modal-error"); if (err) { err.textContent = ""; err.classList.add("hidden"); }
      const r = this._resolve; this._resolve = null;
      if (r) r(result);
    }
  };

  /* ══════════════════════════════════════════
     PROJECTS — 프로젝트 + 데크(선박 층) 관리 (디자이너)
  ══════════════════════════════════════════ */