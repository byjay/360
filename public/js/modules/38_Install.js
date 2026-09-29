  /* ══════════════════════════════════════════
     INSTALL — 모바일 "홈 화면에 설치" 유도 (PWA)
     [WO 20260929] 🔴 SoT 단일화 — public/index.html 안에 있던 중복 IIFE(#pwa-install-btn 을
     따로 만들고 beforeinstallprompt 를 별도로 캡처하던 코드)를 제거하고 여기 하나로 합쳤다.
     · 모바일(터치·좁은 폭)은 첫 화면(로그인 전 포함)에 배너를 즉시 띄운다. 데스크톱은 조용히
       "앱 설치" 버튼만 상시 노출(미설치 시).
     · Android/Chrome: beforeinstallprompt 가 도착하는 순간(늦게 와도) 배너/버튼을 그 순간 활성화.
       도착 전에는 버튼을 비활성 + "설치 준비 중" 문구로 상태를 보여준다(조용한 무반응 금지).
     · iOS(Safari): beforeinstallprompt 자체가 없다 → 공유→"홈 화면에 추가" 인라인 SVG 안내로 대체.
     · 닫기 = 7일 스누즈(영구 아님). standalone(이미 설치)이면 절대 띄우지 않는다.
     · 배너는 하단 도크(.mobile-dock) 위로 띄운다 — 작업 화면을 가리지 않는다(CSS --mdock-h SoT).
  ══════════════════════════════════════════ */
  const Install = {
    /** 🔴 SoT: 값 = 스누즈 만료 시각(ms, Date.now() 기준). 없거나 지났으면 다시 노출(영구 금지). */
    DISMISS_KEY: "wm_install_snooze_until",
    SNOOZE_MS: 7 * 24 * 60 * 60 * 1000, // 7일
    _deferred: null,
    _booted: false,

    init() {
      try {
        window.addEventListener("beforeinstallprompt", (e) => {
          e.preventDefault();          // 브라우저 기본 미니바 차단 → 우리 배너/버튼으로 시점 제어
          this._deferred = e;
          this._onDeferredReady();     // 이미 열려 있는 배너가 있으면 그 순간 활성화
        });
        window.addEventListener("appinstalled", () => {
          this._deferred = null;
          this.hide();
          this._hideButton();
        });
      } catch (e) {}
      const $ = (id) => document.getElementById(id);
      $("pwa-install-accept") && $("pwa-install-accept").addEventListener("click", () => this.accept());
      $("pwa-install-close") && $("pwa-install-close").addEventListener("click", () => this.dismiss());
      this._boot();
    },

    /** 이미 앱으로 설치돼 실행 중인가 */
    isStandalone() {
      try {
        if (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) return true;
      } catch (e) {}
      return !!(window.navigator && window.navigator.standalone);   // iOS Safari
    },

    /** iOS 계열(iPadOS 13+ 는 MacIntel + 터치로 보고된다) */
    isIOS() {
      const nav = window.navigator || {};
      const ua = String(nav.userAgent || "");
      if (/iPad|iPhone|iPod/.test(ua)) return true;
      return nav.platform === "MacIntel" && Number(nav.maxTouchPoints || 0) > 1;
    },

    /** 모바일(터치 또는 좁은 폭) — 배너를 첫 화면에 바로 띄울지 판정(데스크톱은 버튼만). */
    isMobile() {
      try {
        if (!window.matchMedia) return false;
        return window.matchMedia("(pointer: coarse)").matches || window.matchMedia("(max-width: 760px)").matches;
      } catch (e) { return false; }
    },

    /** 7일 스누즈 — 영구 저장 금지(닫아도 일주일 뒤 다시 노출). */
    _dismissed() {
      try {
        const until = Number(localStorage.getItem(this.DISMISS_KEY) || 0);
        return Date.now() < until;
      } catch (e) { return false; }
    },

    /** 첫 화면 부팅 — 로그인 여부와 무관하게 한 번 실행. 모바일이면 즉시 배너, 아니면 버튼만. */
    _boot() {
      if (this._booted) return;
      this._booted = true;
      if (this.isStandalone()) return;
      this._ensureButton();
      if (this.isMobile() && !this._dismissed()) this.showBanner();
    },

    /** 상시 노출되는 "앱 설치" 원형 버튼 — 렌더 지점 1곳(SoT). */
    _ensureButton() {
      let b = document.getElementById("pwa-install-btn");
      if (!b) {
        b = document.createElement("button");
        b.id = "pwa-install-btn";
        b.type = "button";
        b.setAttribute("aria-label", "앱 설치");
        b.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/></svg><span>앱 설치</span>';
        b.style.cssText = "position:fixed;right:16px;bottom:calc(16px + env(safe-area-inset-bottom));z-index:10000;display:inline-flex;align-items:center;gap:8px;"
          + "padding:10px 16px;border:none;border-radius:999px;cursor:pointer;font:600 14px/1 var(--sea-font-ui,system-ui,sans-serif);"
          + "color:#fff;background:#1b75bb;box-shadow:0 8px 24px rgba(43,40,32,.18),0 2px 8px rgba(43,40,32,.12);"
          + "transition:transform .15s ease,filter .15s ease;touch-action:manipulation;";
        b.onmouseenter = () => { b.style.filter = "brightness(1.08)"; b.style.transform = "translateY(-1px)"; };
        b.onmouseleave = () => { b.style.filter = ""; b.style.transform = ""; };
        b.addEventListener("click", () => this._onButtonClick());
        document.body.appendChild(b);
      }
      b.classList.remove("hidden");
      b.style.display = "inline-flex";
      return b;
    },

    _hideButton() {
      const b = document.getElementById("pwa-install-btn");
      if (b) b.style.display = "none";
    },

    /** 상시 버튼 클릭 — 조용한 무반응 금지: 상황별로 항상 반응을 준다. */
    _onButtonClick() {
      if (this._deferred) { this.accept(); return; }
      if (this.isIOS() || this.isMobile()) { this.showBanner(true); return; } // 직접 클릭은 스누즈 무시
      if (window.Prompt && Prompt.toast) Prompt.toast('브라우저 메뉴 → "홈 화면에 추가/설치"를 이용하세요.', 4000);
    },

    /** 배너 노출 — 첫 화면(로그인 전)에서도 호출 가능. force=true 면 7일 스누즈를 무시(버튼 직접 클릭). */
    showBanner(force) {
      if (this.isStandalone()) return false;
      if (!force && this._dismissed()) return false;
      const b = document.getElementById("pwa-install-banner");
      if (!b) return false;
      const $ = (id) => document.getElementById(id);
      const ios = $("pwa-install-ios");
      const btn = $("pwa-install-accept");
      const sub = b.querySelector(".pwa-install-sub");
      const isIosNow = this.isIOS();
      if (ios) ios.classList.toggle("hidden", !isIosNow);
      if (btn) {
        btn.classList.toggle("hidden", isIosNow);
        if (!isIosNow) {
          const ready = !!this._deferred;
          btn.disabled = !ready;
          btn.textContent = ready ? "설치" : "설치 준비 중";
        }
      }
      if (sub) {
        sub.classList.toggle("hidden", isIosNow);
        if (!isIosNow) {
          sub.textContent = this._deferred
            ? "앱처럼 열리고 오프라인에서도 작업할 수 있습니다."
            : "브라우저가 설치를 준비하는 중입니다 — 준비되면 자동으로 활성화돼요.";
        }
      }
      b.classList.remove("hidden");
      requestAnimationFrame(() => b.classList.add("on"));
      return true;
    },

    /** beforeinstallprompt 가 늦게 도착했을 때 — 이미 열려 있는 배너를 그 순간 활성화(재노출 아님). */
    _onDeferredReady() {
      const b = document.getElementById("pwa-install-banner");
      if (b && !b.classList.contains("hidden")) this.showBanner(true);
    },

    /** 로그인 직후 등 기존 호출부 호환용 — 이미 첫 화면에서 떴으면 중복 표시 없이 그대로 둔다. */
    maybePrompt() {
      return this.showBanner();
    },

    hide() {
      const b = document.getElementById("pwa-install-banner");
      if (!b) return;
      b.classList.remove("on");
      setTimeout(() => b.classList.add("hidden"), 200);
    },

    /** 닫기 = 7일 스누즈(영구 금지). */
    dismiss() {
      try { localStorage.setItem(this.DISMISS_KEY, String(Date.now() + this.SNOOZE_MS)); } catch (e) {}
      this.hide();
    },

    async accept() {
      const d = this._deferred;
      if (!d) { this.hide(); return false; }
      this._deferred = null;
      try {
        d.prompt();
        const choice = await d.userChoice;
        this.hide();
        return !!(choice && choice.outcome === "accepted");
      } catch (e) { this.hide(); return false; }
    }
  };
