  /* ══════════════════════════════════════════
     INSTALL — 모바일 "홈 화면에 설치" 유도 (PWA)
     · Android/Chrome: beforeinstallprompt 를 보관해 두었다가 사용자가 버튼을 누를 때 실행.
     · iOS(Safari): beforeinstallprompt 자체가 없다 → 공유→"홈 화면에 추가" 안내 문구로 대체.
     · 이미 설치된 상태(display-mode: standalone)면 절대 띄우지 않는다.
     · 배너는 하단 도크(.mobile-dock) 위로 띄운다 — 작업 화면을 가리지 않는다(CSS --mdock-h SoT).
  ══════════════════════════════════════════ */
  const Install = {
    DISMISS_KEY: "wm_install_dismissed",
    _deferred: null,

    init() {
      try {
        window.addEventListener("beforeinstallprompt", (e) => {
          e.preventDefault();          // 브라우저 기본 미니바 차단 → 우리 배너로 시점 제어
          this._deferred = e;
        });
        window.addEventListener("appinstalled", () => { this._deferred = null; this.hide(); });
      } catch (e) {}
      const $ = (id) => document.getElementById(id);
      $("pwa-install-accept") && $("pwa-install-accept").addEventListener("click", () => this.accept());
      $("pwa-install-close") && $("pwa-install-close").addEventListener("click", () => this.dismiss());
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

    _dismissed() {
      try { return localStorage.getItem(this.DISMISS_KEY) === "1"; } catch (e) { return false; }
    },

    /** 설치 안내를 띄워야 하는가 — 설치됨/거절함/설치수단 없음 이면 false */
    _shouldPrompt() {
      if (this.isStandalone()) return false;     // 🔴 이미 설치 → 안내 금지
      if (this._dismissed()) return false;
      return !!this._deferred || this.isIOS();   // 안드로이드=프롬프트 보유 / iOS=수동 안내
    },

    /** 로그인 직후 호출. 조건을 만족할 때만 배너를 띄운다. 반환: 띄웠는지 여부 */
    maybePrompt() {
      if (!this._shouldPrompt()) return false;
      const b = document.getElementById("pwa-install-banner");
      if (!b) return false;
      const ios = document.getElementById("pwa-install-ios");
      const btn = document.getElementById("pwa-install-accept");
      const isIos = this.isIOS() && !this._deferred;
      if (ios) ios.classList.toggle("hidden", !isIos);
      if (btn) btn.classList.toggle("hidden", isIos);
      b.classList.remove("hidden");
      requestAnimationFrame(() => b.classList.add("on"));
      return true;
    },

    hide() {
      const b = document.getElementById("pwa-install-banner");
      if (!b) return;
      b.classList.remove("on");
      setTimeout(() => b.classList.add("hidden"), 200);
    },

    dismiss() {
      try { localStorage.setItem(this.DISMISS_KEY, "1"); } catch (e) {}
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
