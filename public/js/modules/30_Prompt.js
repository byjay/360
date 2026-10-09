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
    /** 가벼운 토스트 알림 (화면 하단 중앙, 자동 소멸).
     *  @param {{action?:{label:string,onClick:Function}}} [opts] [WO 20261001-autophoto2]
     *  360 자동연결 "[다른 사진]" 재요청용 — 기존 2-인자 호출부(25곳)는 전부 하위호환. */
    toast(msg, ms, opts) {
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
      if (opts && opts.action && opts.action.label && typeof opts.action.onClick === "function") {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = opts.action.label;
        btn.className = "wm-toast-action";
        btn.style.marginLeft = "10px";
        btn.addEventListener("click", (ev) => { ev.stopPropagation(); kill(t); opts.action.onClick(); });
        t.appendChild(btn);
      }
      host.appendChild(t);
      requestAnimationFrame(() => t.classList.add("on"));
      arm(t, life);
    },
    /** opts: { title, sub, placeholder, second, checkbox, checkboxValue } → Promise<{value,second,checked}|null>
     *  [WO 20261001-panoshapes] checkbox — 선택적 체크박스(라벨 텍스트). 미지정이면 기존 호출부(수십 곳)
     *  100% 하위호환(요소가 hidden 유지, r.checked 는 그냥 false). */
    ask(opts) {
      return new Promise((resolve) => {
        this._resolve = resolve;
        // [지휘자 2026-10-09 재현 — WO 20261008-pinpurge 3/3 재인증] 🔴 연속 ask() 충돌 가드.
        // _close() 의 지연 숨김 타이머(아래)가 아직 안 끝났는데 바로 다음 ask()가 같은 #prompt-modal
        // 을 다시 열면, 그 타이머가 나중에 발동해 방금 연 모달을 도로 숨긴다(PinPurge 2/3→3/3 연쇄
        // 호출에서 100% 재현 — 핀 일괄삭제 재인증도 같은 경로를 쓴다). Prompt.confirm()(아래, 기존
        // 정상 동작)과 같은 가드를 연다(open) 시점에도 건다 — 닫을 때 가드만으론 "닫는 중 다시 열기"
        // 경합을 못 막는다.
        clearTimeout(this._hideTimer);
        document.getElementById("prompt-modal-title").textContent = opts.title || "입력";
        document.getElementById("prompt-modal-sub").textContent = opts.sub || "";
        const inp = document.getElementById("prompt-modal-input");
        inp.value = opts.value || ""; inp.placeholder = opts.placeholder || ""; this._allowEmpty = !!opts.allowEmpty;
        // [WO 20261001-bulkreauth] opts.password — 같은 모달을 비밀번호 입력으로(가림 + 브라우저 저장 비번 자동완성). 닫힐 때 원복.
        inp.type = opts.password ? "password" : "text";
        inp.setAttribute("autocomplete", opts.password ? "current-password" : "off");
        const inp2 = document.getElementById("prompt-modal-input2");
        inp2.value = opts.secondValue || "";
        inp2.placeholder = (typeof opts.second === "string") ? opts.second : "";
        inp2.classList.toggle("hidden", !opts.second);
        const cbWrap = document.getElementById("prompt-modal-checkbox-wrap");
        const cb = document.getElementById("prompt-modal-checkbox");
        const cbLabel = document.getElementById("prompt-modal-checkbox-label");
        if (cbWrap && cb && cbLabel) {
          const hasCb = typeof opts.checkbox === "string" && opts.checkbox;
          cbWrap.classList.toggle("hidden", !hasCb);
          if (hasCb) { cbLabel.textContent = opts.checkbox; cb.checked = !!opts.checkboxValue; }
        }
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
      const cbWrap = document.getElementById("prompt-modal-checkbox-wrap");
      const cb = document.getElementById("prompt-modal-checkbox");
      const val = inp.type === "password" ? (inp.value || "") : (inp.value || "").trim();   // 비밀번호는 공백도 값이다
      if (!val && !this._allowEmpty) { err.textContent = "값을 입력하세요."; err.classList.remove("hidden"); return; }
      const second = inp2.classList.contains("hidden") ? undefined : (inp2.value || "").trim();
      const checked = (cbWrap && cb && !cbWrap.classList.contains("hidden")) ? !!cb.checked : false;
      this._close({ value: val, second, checked });
    },
    _close(result) {
      const m = document.getElementById("prompt-modal");
      m.classList.remove("on");
      // [지휘자 2026-10-09 재현] Prompt.confirm()의 close()(아래)와 같은 가드 — 이 타이머가 발동할
      // 때 모달이 그 사이 다시 열려 있으면("on" 복귀) 숨기지 않는다. clearTimeout 은 이 함수가 짧은
      // 간격으로 두 번 불릴 때를 막고, 콜백의 "on" 재확인은 ask() 가 그 사이 다시 열었을 때를 막는다
      // (이중 가드 — 어느 한쪽만으로는 경합 창이 남는다).
      clearTimeout(this._hideTimer);
      this._hideTimer = setTimeout(() => { if (!m.classList.contains("on")) m.classList.add("hidden"); }, 200);
      // [버그수정] 에러 텍스트 잔류 정리 — 다음 ask 모달에 이전 오류가 깜빡이지 않게
      const err = document.getElementById("prompt-modal-error"); if (err) { err.textContent = ""; err.classList.add("hidden"); }
      // [WO 20261001-bulkreauth] 비밀번호 입력값을 DOM 에 남기지 않는다
      const inp = document.getElementById("prompt-modal-input");
      if (inp && inp.type === "password") { inp.value = ""; inp.type = "text"; inp.setAttribute("autocomplete", "off"); }
      const r = this._resolve; this._resolve = null;
      if (r) r(result);
    },
    /** [지휘자 2026-10-08 재현] 화면 전환(UI.showScreen — 공유 지점 한 곳) 시 열려 있는 모달을
     *  취소로 닫는다. ask() 가 이름 검증 실패 등으로 열린 채 남아 있다가 뒤로가기로 다른
     *  프로젝트/화면까지 떠 있던 결함 — 전환 시점에 한 번 정리하면 모든 진입 경로가 같이 고쳐진다. */
    closeAll() {
      try {
        const m = document.getElementById("prompt-modal");
        if (m && !m.classList.contains("hidden")) this._close(null);
      } catch (e) {}
      try {
        const c = document.getElementById("wm-confirm-modal");
        if (c && c.classList.contains("on")) { const cancel = document.getElementById("wm-confirm-cancel"); if (cancel) cancel.click(); }
      } catch (e) {}
    },

    /** [WO 20260921 publish-fix] 커스텀 확인 모달 — Promise<boolean>.
     *  근본원인: window.confirm()/alert()/prompt()는 PWA 독립실행모드(display:standalone,
     *  manifest.webmanifest 참조)에서 플랫폼에 따라 아무 표시 없이 즉시 false를 반환하며 조용히
     *  실패한다(iOS 홈화면 추가 앱의 알려진 WebKit 제약). 배포 버튼이 "아무 일도 하지 않던" 원인이
     *  이것 — confirm()이 무음으로 false를 반환해 즉시 return된 것으로, 자체 DOM 모달은 이 제약을
     *  받지 않는다. #prompt-modal(admin-gate) 과 동일한 CSS를 재사용해 신규 스타일 불필요. */
    confirm(title, message) {
      return new Promise((resolve) => {
        let modal = document.getElementById("wm-confirm-modal");
        if (!modal) {
          modal = document.createElement("div");
          modal.id = "wm-confirm-modal";
          modal.className = "admin-gate hidden";
          modal.setAttribute("role", "dialog");
          modal.setAttribute("aria-modal", "true");
          modal.innerHTML =
            '<div class="admin-gate-backdrop"></div>' +
            '<div class="admin-gate-card">' +
              '<h2 class="admin-gate-title" id="wm-confirm-title"></h2>' +
              '<p class="admin-gate-sub" id="wm-confirm-msg" style="white-space:pre-line"></p>' +
              '<div class="admin-gate-actions">' +
                '<button id="wm-confirm-cancel" class="admin-gate-btn ghost" type="button">취소</button>' +
                '<button id="wm-confirm-ok" class="admin-gate-btn primary" type="button">확인</button>' +
              '</div>' +
            '</div>';
          document.body.appendChild(modal);
        }
        document.getElementById("wm-confirm-title").textContent = title || "확인";
        document.getElementById("wm-confirm-msg").textContent = message || "";
        const okBtn = document.getElementById("wm-confirm-ok");
        const cancelBtn = document.getElementById("wm-confirm-cancel");
        const backdrop = modal.querySelector(".admin-gate-backdrop");
        // 🔴 [WO 20260928-copy · 라이브 실측] 확인창을 연달아 띄우면(닫자마자 다음 confirm) 앞 창의
        //   200ms 지연 숨김 타이머가 새 창에 "hidden" 을 붙여 두 번째 창이 사라지고 약속이 영원히 대기했다.
        //   열 때 앞 타이머를 취소하고, 닫힐 때는 그 사이 다시 열리지 않았을 때만 숨긴다.
        clearTimeout(modal._hideTimer);
        const close = (result) => {
          modal.classList.remove("on");
          modal._hideTimer = setTimeout(() => { if (!modal.classList.contains("on")) modal.classList.add("hidden"); }, 200);
          okBtn.removeEventListener("click", onOk);
          cancelBtn.removeEventListener("click", onCancel);
          backdrop.removeEventListener("click", onCancel);
          resolve(result);
        };
        const onOk = () => close(true);
        const onCancel = () => close(false);
        okBtn.addEventListener("click", onOk);
        cancelBtn.addEventListener("click", onCancel);
        backdrop.addEventListener("click", onCancel);
        modal.classList.remove("hidden");
        requestAnimationFrame(() => modal.classList.add("on"));
      });
    }
  };

  /* ══════════════════════════════════════════
     PROJECTS — 프로젝트 + 데크(선박 층) 관리 (디자이너)
  ══════════════════════════════════════════ */