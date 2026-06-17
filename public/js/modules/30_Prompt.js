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
    /** 가벼운 토스트 알림 (화면 하단 중앙, 자동 소멸) */
    toast(msg, ms) {
      let host = document.getElementById("wm-toast-host");
      if (!host) {
        host = document.createElement("div");
        host.id = "wm-toast-host";
        host.className = "wm-toast-host";
        document.body.appendChild(host);
      }
      const t = document.createElement("div");
      t.className = "wm-toast";
      t.textContent = msg;
      host.appendChild(t);
      requestAnimationFrame(() => t.classList.add("on"));
      setTimeout(() => { t.classList.remove("on"); setTimeout(() => t.remove(), 280); }, ms || 2200);
    },
    /** opts: { title, sub, placeholder, second } → Promise<string|{value,second}|null> */
    ask(opts) {
      return new Promise((resolve) => {
        this._resolve = resolve;
        document.getElementById("prompt-modal-title").textContent = opts.title || "입력";
        document.getElementById("prompt-modal-sub").textContent = opts.sub || "";
        const inp = document.getElementById("prompt-modal-input");
        inp.value = ""; inp.placeholder = opts.placeholder || "";
        const inp2 = document.getElementById("prompt-modal-input2");
        inp2.value = "";
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
      if (!val) { err.textContent = "값을 입력하세요."; err.classList.remove("hidden"); return; }
      const second = inp2.classList.contains("hidden") ? undefined : (inp2.value || "").trim();
      this._close({ value: val, second });
    },
    _close(result) {
      const m = document.getElementById("prompt-modal");
      m.classList.remove("on");
      setTimeout(() => m.classList.add("hidden"), 200);
      const r = this._resolve; this._resolve = null;
      if (r) r(result);
    }
  };

  /* ══════════════════════════════════════════
     PROJECTS — 프로젝트 + 데크(선박 층) 관리 (디자이너)
  ══════════════════════════════════════════ */