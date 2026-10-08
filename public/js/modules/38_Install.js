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

     [WO 20260929-회귀수정] 🔴 지휘자 CDP 실측(p42-cdp-real.mjs, 실 Chrome+실 CSS+재조립된 main.js) —
     편집 화면(#screen-app.active, 사이드바·도크·지도 조작)에 들어간 뒤에도 이 배너가 그대로 떠 있어
     사이드바 도구 행(사각영역/원형영역/다각영역 등, y≈686)을 덮어 클릭이 막혔다(hitTag: "B"/배너 DIV).
     근본원인: isMobile() 만 보고 "어느 화면이 떠 있는지"는 전혀 확인하지 않았다.
     조치: #screen-app 이 active 인 동안은 배너·상시버튼을 완전히 숨긴다(허브/로그인 화면에서만 노출).
     화면 전환은 App 코드가 #screen-app 의 class 를 바꾸는 것으로 이뤄지므로(20_App.js, 이 파일은
     수정 금지 대상) MutationObserver 로 그 class 변화를 그대로 관찰한다(App.js 에 훅을 추가하지 않음).
  ══════════════════════════════════════════ */
  const Install = {
    /** 🔴 SoT: 값 = 스누즈 만료 시각(ms, Date.now() 기준). 없거나 지났으면 다시 노출(영구 금지). */
    DISMISS_KEY: "wm_install_snooze_until",
    SNOOZE_MS: 7 * 24 * 60 * 60 * 1000, // 7일
    /* [WO 20261008-pwadesktop] 🔴 라이브 CDP 실측(Page.getInstallabilityErrors=[]): manifest·SW는
       이미 설치 가능 조건을 전부 만족한다 — "beforeinstallprompt 가 안 온다"는 코드 결함이 아니라
       Chrome/Edge 가 내부적으로 엔진 조건(참여도·이전 거절 쿨다운)을 더 걸기 때문. 근본 수정은
       "안 오면 영원히 대기"를 없애는 것 — N초 뒤 타임아웃으로 브라우저별 수동 설치 안내로 전환한다. */
    PROMPT_TIMEOUT_MS: 5000,
    _deferred: null,
    _booted: false,
    _promptTimedOut: false,
    _promptTimer: null,
    _relatedInstalled: false, // navigator.getInstalledRelatedApps() best-effort(아래 _checkRelatedApps 참조)

    init() {
      try {
        window.addEventListener("beforeinstallprompt", (e) => {
          e.preventDefault();          // 브라우저 기본 미니바 차단 → 우리 배너/버튼으로 시점 제어
          this._deferred = e;
          this._onDeferredReady();     // 이미 열려 있는 배너가 있으면 그 순간 활성화
          if (this._promptTimer) { clearTimeout(this._promptTimer); this._promptTimer = null; }
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

    /** [WO 20261008-pwadesktop] 이미 설치됨(= 지금 탭이 standalone 이 아니어도) — best-effort.
     *  getInstalledRelatedApps 는 manifest 의 related_applications 에 자기참조 항목이 있어야
     *  실제로 뭔가를 돌려준다(이 프로젝트는 그 항목을 두지 않음 — 배포 도메인을 manifest.webmanifest
     *  에 하드코딩하지 않기 위한 선택, CLAUDE.md §10). 그래서 지금은 항상 빈 배열 → isStandalone() 이
     *  사실상 유일한 판정 기준이고, 이 메서드는 브라우저가 향후 자기참조 없이도 알려주는 경우를 위한
     *  방어적 best-effort 훅으로만 둔다(없다고 거짓으로 "있다"고 하지 않음 — 정직한 실패).
     */
    isInstalled() { return this.isStandalone() || !!this._relatedInstalled; },
    async _checkRelatedApps() {
      try {
        if (!(navigator && typeof navigator.getInstalledRelatedApps === "function")) return;
        const apps = await navigator.getInstalledRelatedApps();
        if (apps && apps.length) {
          this._relatedInstalled = true;
          this._applyScreenVisibility();
        }
      } catch (e) {}
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

    /** [WO 20260929-회귀수정] 편집 화면(사이드바·도크·지도 조작) 활성 여부 — 이 화면에서는
     *  조작요소가 화면 대부분을 차지하므로(375px 폭에서도 사이드바 clientWidth≈366) 배너/버튼이
     *  "빈 곳에만" 놓일 자리를 보장할 수 없다 → 이 화면에서는 아예 숨긴다(겹침 0 을 구조적으로 보장).
     *  #screen-app 은 App 이 화면 전환 시 class 로만 표시하는 기존 SoT(00_header.js .screen/.active) —
     *  새 상태값을 만들지 않고 그 class 를 그대로 읽기만 한다. */
    isEditorScreenActive() {
      try {
        const app = document.getElementById("screen-app");
        return !!(app && app.classList && app.classList.contains("active"));
      } catch (e) { return false; }
    },

    /** [WO 20261008-pwadesktop] FeatureMenu 의 "앱 설치" 항목용 — 이미 설치됐으면 비활성 사유를
     *  돌려준다(기존 reasonOf() 의 동적 why 패턴 재사용, 새 렌더 경로를 만들지 않음). */
    alreadyInstalledReason() { return this.isInstalled() ? "이미 설치됨" : ""; },

    /** [WO 20261008-pwadesktop] beforeinstallprompt 가 끝내 오지 않을 때(이미 설치됨도 아니고,
     *  엔진이 그냥 안 주는 경우) 보여줄 브라우저별 수동 설치 안내 — UA 추정이라 실패할 수 있으므로
     *  모르면 가장 보편적인 Chromium 계열 안내로 폴백(지어내지 않고 "일반적으로"로 표현). */
    browserGuideText() {
      const ua = String((window.navigator && window.navigator.userAgent) || "");
      if (/Edg\//.test(ua)) return "주소창 오른쪽의 설치 아이콘(⊕) 또는 ⋯ 메뉴 → 앱 → “이 사이트를 앱으로 설치”를 선택하세요.";
      if (/Firefox\//.test(ua)) return "Firefox는 이 사이트 설치를 지원하지 않습니다. 메뉴 → “페이지를 북마크”로 추가해 바로가기를 만드세요.";
      if (/Safari\//.test(ua) && !/Chrome|Chromium|Edg\//.test(ua)) return "공유 버튼(⬆) → “Dock에 추가”를 선택하세요.";
      // Chrome·기타 Chromium 계열(Opera·Brave 등) 폴백
      return "주소창 오른쪽의 설치 아이콘(⊕) 또는 ⋮ 메뉴 → 앱 설치(“홈 화면에 추가”)를 선택하세요.";
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
      this._checkRelatedApps(); // best-effort, 비동기(결과 오면 _applyScreenVisibility 재호출)
      this._ensureButton();
      this._watchScreen();
      this._applyScreenVisibility();
      // [WO 20261008-pwadesktop] beforeinstallprompt 가 PROMPT_TIMEOUT_MS 안에 안 오면
      // "준비 중" 무한 대기를 끝내고 브라우저별 수동 안내로 전환한다(iOS는 처음부터 안내 전용).
      if (!this.isIOS()) {
        this._promptTimer = setTimeout(() => {
          this._promptTimer = null;
          if (!this._deferred) { this._promptTimedOut = true; this._applyScreenVisibility(); }
        }, this.PROMPT_TIMEOUT_MS);
      }
    },

    /** [WO 20260929-회귀수정] #screen-app 의 class 변화(허브↔편집화면 전환)를 관찰해 그때마다
     *  배너/버튼 노출 상태를 재계산한다 — 20_App.js 는 건드리지 않고(수정 금지 파일) 결과만 구독. */
    _watchScreen() {
      try {
        const app = document.getElementById("screen-app");
        if (!app || typeof MutationObserver === "undefined") return;
        if (this._screenObserver) return; // 중복 관찰 방지
        this._screenObserver = new MutationObserver(() => this._applyScreenVisibility());
        this._screenObserver.observe(app, { attributes: true, attributeFilter: ["class"] });
      } catch (e) {}
    },

    /** 화면 상태에 따라 배너/상시버튼 노출을 단일 지점에서 재계산(SoT) — 편집 화면에서는
     *  둘 다 완전히 숨겨 겹침을 구조적으로 0 으로 만든다(부분 배치·칩 축소보다 안전). */
    _applyScreenVisibility() {
      if (this.isInstalled()) { this._hideButton(); this.hide(); return; }
      const editing = this.isEditorScreenActive();
      const btn = document.getElementById("pwa-install-btn");
      if (btn) btn.style.display = editing ? "none" : "inline-flex";
      if (editing) {
        this.hide();
      } else if (this.isMobile() && !this._dismissed()) {
        this.showBanner();
      }
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

    /** 상시 버튼 클릭 — 조용한 무반응 금지: 상황별로 항상 반응을 준다.
     *  [WO 20261008-pwadesktop] 🔴 SoT 단일화 — 데스크톱에서 토스트로 따로 안내하던 것을 없애고
     *  배너와 똑같이 showBanner(true) 하나로 합쳤다(배너는 "준비 중", 버튼은 "앱 설치"로 서로 다른
     *  문구를 보이던 분기 제거). deferred 가 이미 와 있으면 그대로 즉시 설치창을 띄운다(한 클릭 유지). */
    _onButtonClick() {
      if (this.isEditorScreenActive()) return; // 방어적 가드(버튼 자체가 이 화면에서 숨겨져 있음)
      if (this._deferred) { this.accept(); return; }
      this.showBanner(true); // 직접 클릭은 스누즈 무시 — iOS/모바일/데스크톱 모두 배너가 상태에 맞게 표시
    },

    /** 배너 노출 — 첫 화면(로그인 전)에서도 호출 가능. force=true 면 7일 스누즈를 무시(버튼 직접 클릭).
     *  🔴 편집 화면(#screen-app.active)에서는 force 여부와 무관하게 절대 띄우지 않는다(겹침 0 보장).
     *  [WO 20261008-pwadesktop] "설치 준비 중" 무한 대기 제거 — PROMPT_TIMEOUT_MS 안에 prompt 가 안
     *  오면(_promptTimedOut) iOS와 동일하게 "안내 전용" 모드로 전환해 설치 버튼을 숨기고 브라우저별
     *  수동 설치 방법을 보여준다(조용히 숨기지 않음 — 문구만 바뀜). */
    showBanner(force) {
      if (this.isInstalled()) return false;
      if (this.isEditorScreenActive()) return false;
      if (!force && this._dismissed()) return false;
      const b = document.getElementById("pwa-install-banner");
      if (!b) return false;
      const $ = (id) => document.getElementById(id);
      const ios = $("pwa-install-ios");
      const btn = $("pwa-install-accept");
      const sub = $("pwa-install-sub");
      const isIosNow = this.isIOS();
      const guideMode = !isIosNow && !this._deferred && this._promptTimedOut; // iOS 는 처음부터 안내 전용
      if (ios) ios.classList.toggle("hidden", !isIosNow);
      if (btn) {
        btn.classList.toggle("hidden", isIosNow || guideMode);
        if (!isIosNow && !guideMode) {
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
            : guideMode
              ? this.browserGuideText()
              : "브라우저가 설치를 준비하는 중입니다 — 준비되면 자동으로 활성화돼요.";
        }
      }
      b.classList.remove("hidden");
      requestAnimationFrame(() => b.classList.add("on"));
      return true;
    },

    /** beforeinstallprompt 가 늦게 도착했을 때 — 이미 열려 있는 배너를 그 순간 활성화(재노출 아님).
     *  편집 화면이면 애초에 배너가 열려있지 않으므로(showBanner 가드) 자연히 아무 일도 안 한다. */
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
