  /* ══════════════════════════════════════════
     INSTALL GATE — 모바일 브라우저 탭 강제 설치 게이트 (WO 20261009)
     마스터: "앱 설치 시 스마트폰에서 보안 어쩌고 하고 설치하겠냐고 물어보고, 강제로 설치하는 거
     있잖아. 그런 것도 구현하고, 뒤로 빠져나가지 않게끔 세팅해."

     ── 기술적 한계(정직하게 반영) ──
     브라우저는 웹페이지가 설치를 강제로 실행하게 허용하지 않는다. 우리가 할 수 있는 것은
     1) beforeinstallprompt 를 즉시 prompt() 으로 띄우는 것(Android Chrome·삼성 인터넷, 탭 1회 필요),
     2) 설치되지 않은 동안 전체 화면으로 덮어 앱을 못 쓰게 막는 것. 최종 설치 확인창은 항상
     브라우저 자신이 띄운다("보안 어쩌고 설치하시겠습니까" = 이 창).
     뒤로가기 가로채기(history 함정)는 Chrome 이 사용자 동작 없는 history 조작을 건너뛰고 악성
     패턴으로 분류한다 — 대신 **어느 경로로 들어와도(새로고침·뒤로가기·주소 직접 입력) 설치되지
     않은 휴대폰이면 게이트가 다시 덮는다**(pageshow/visibilitychange/최초 진입마다 재검사)로
     동일 효과를 낸다. 빠져나가도 쓸 수 없으니 결과적으로 "못 나간다"와 같다.

     ── 게이트 조건(전부 참일 때만 표시) ──
     · Install.isMobile() — 휴대폰(터치 또는 좁은 폭). 기존 판정 재사용(새 판정 0).
     · !Install.isStandalone() — 이미 설치된 앱(standalone)이면 영향 없음(요구 6).
     · Auth.user — 로그인 사용자만 대상. 🔴 공유 열람 링크(`?d=`) 예외는 Auth._isViewLink()를
       독립적으로 먼저 검사하지 않는다. 열람 링크 방문자는 /api/auth/me 가 통행증 세션으로
       user 를 채우므로(Auth.user 있음) 서버 판정 Auth.readonly=true 로 예외 처리한다(URL 로는
       readonly 가 되지 않아 우회 불가 — 실계정 세션은 readonly=false). 링크 여부로 별도
       분기를 두면 "로그인된 사용자가 URL에 ?d= 만 붙이면 강제설치를 피해간다"는 우회로가
       생긴다(로그인했다면 공유링크로 들어왔어도 설치 대상이 맞다 — 마스터 지시 "비로그인
       열람자"만 예외).
     · AdminPanels.isEnabled(FLAG_KEY) — 관리자 기능 플래그, 기본값 ON(28_AdminPanels.js SoT 재사용).

     ── 우회 방지 ──
     · 배경 차단은 CSS 겹침(z-index) 하나로 끝내지 않는다 — body 의 다른 모든 자식에 `inert`
       속성을 걸어 포인터·키보드·포커스를 네이티브로 차단한다(커스텀 포커스 트랩 루프보다 견고).
     · 위치/z-index 는 인라인 스타일로 고정한다(스타일시트 캐스케이드 우회 — family-tokens.css가
       `#login-gate.signin-gate{z-index:10000}`처럼 ID 선택자로 base 규칙을 이긴 전례가 있다,
       CLAUDE.md G-4⑤). 인라인 스타일은 `!important` 없는 시트 규칙을 항상 이긴다.
     · 게이트 DOM을 지워도 되살리는 감시자는 만들지 않는다(과한 대응) — 재진입 지점에서만 재검사.

     ── [WO 20261019] 수정 — "닫히지 않아 못 쓴다" 신고로 이전 지시(강제·닫기 버튼 없음)를 철회 ──
     마스터: "이 화면이 닫히지도 않아. 왜 그래? 사용할 수 있게 해."
     · 강제 화면에도 [브라우저에서 계속 사용] 버튼을 둔다(shouldGate 가 7일 스누즈를 본다).
     · 태블릿/폴드 펼침(짧은 변 ≥600px)은 전체화면으로 강제하지 않고 작은 배너만(shouldBanner).
     · 관리자 스위치(AdminPanels FLAG_KEY)·열람자 readonly 예외는 그대로 유지(_eligible 로 통합).
  ══════════════════════════════════════════ */
  const InstallGate = {
    FLAG_KEY: "install-required",
    TABLET_MIN_SHORT_SIDE: 600,            // [WO 20261019] 짧은 변 ≥600px = 태블릿/폴드 펼침(요구 2)
    CONTINUE_DISMISS_KEY: "ig-continue-until",
    CONTINUE_DISMISS_MS: 7 * 24 * 60 * 60 * 1000, // 7일(요구 1)
    _gateEl: null,
    _bannerEl: null,
    _justInstalled: false,
    _declinedOnce: false,
    _sessionContinueDismissed: false,      // localStorage 차단 환경 폴백 — 이 세션 동안만(요구 1 하위)
    _bannerDismissedThisSession: false,

    /** 공통 자격 조건(로그인·readonly·관리자 플래그) — 강제화면/배너 판정이 공유(SoT). */
    _eligible() {
      try {
        if (typeof Install === "undefined") return false;
        if (Install.isStandalone()) return false;     // 이미 설치된 앱(요구 6)
        if (!Install.isMobile()) return false;         // PC 제외
        // 로그인 사용자만 대상 — 비로그인 방문자는 여기서 빠진다(위 설계 메모).
        if (!(typeof Auth !== "undefined" && Auth.user)) return false;
        // 열람 링크=readonly 세션도 예외 — /api/auth/me 가 통행증 세션에도 user 를 채우므로 서버 판정 Auth.readonly 로 거른다.
        if (Auth.readonly) return false;
        if (typeof AdminPanels !== "undefined" && AdminPanels.isEnabled && !AdminPanels.isEnabled(this.FLAG_KEY)) return false; // 관리자 스위치
        return true;
      } catch (e) { return false; }
    },

    /** 짧은 변 ≥600px = 태블릿/폴드 펼침(요구 2) — 기기 모델 하드코딩 없이 뷰포트 크기만으로 판정(CLAUDE.md §10). */
    _isTabletLike() {
      try {
        const w = window.innerWidth || 0, h = window.innerHeight || 0;
        return Math.min(w, h) >= this.TABLET_MIN_SHORT_SIDE;
      } catch (e) { return false; }
    },

    /** "브라우저에서 계속 사용" 선택 후 7일 — 영구 저장 금지, 스누즈만(요구 1). */
    _isContinueDismissed() {
      if (this._sessionContinueDismissed) return true;
      try {
        const until = Number(localStorage.getItem(this.CONTINUE_DISMISS_KEY) || 0);
        return Date.now() < until;
      } catch (e) { return false; } // 저장소 읽기 차단 — 세션 플래그가 이미 있으면 위에서 잡힘
    },
    _markContinueDismissed() {
      this._sessionContinueDismissed = true; // 저장소가 막혀도 최소 "이 세션 동안"은 보장(요구 1 단서)
      try { localStorage.setItem(this.CONTINUE_DISMISS_KEY, String(Date.now() + this.CONTINUE_DISMISS_MS)); } catch (e) { /* 저장소 차단 — 세션 플래그로 폴백 */ }
    },

    /** 지금 전체화면 게이트를 띄워야 하는가(휴대폰 전용) — 단일 판정 지점(SoT). */
    shouldGate() {
      if (!this._eligible()) return false;
      if (this._isTabletLike()) return false;        // 태블릿/폴드 펼침은 배너만(요구 2)
      if (this._isContinueDismissed()) return false;  // "계속 사용" 선택 후 7일(요구 1)
      return true;
    },

    /** 지금 태블릿용 작은 배너를 띄워야 하는가(요구 2). */
    shouldBanner() {
      if (!this._eligible()) return false;
      if (!this._isTabletLike()) return false;
      if (this._bannerDismissedThisSession) return false;
      return true;
    },

    init() {
      this._ensureDom();
      window.addEventListener("pageshow", () => this.recheck());
      document.addEventListener("visibilitychange", () => { if (!document.hidden) this.recheck(); });
      window.addEventListener("appinstalled", () => { this._justInstalled = true; this.recheck(); });
      window.addEventListener("resize", () => this.recheck()); // [WO 20261019] 폴드 펼침/회전 — 짧은 변 재판정
      // Install 모듈이 beforeinstallprompt 를 캡처해 Install._deferred 를 채운다(새 캡처 0, 중복 금지) —
      // 게이트가 떠 있는 동안 그 순간 "설치 준비 중" → "지금 설치"로 내부 렌더만 갱신한다.
      window.addEventListener("beforeinstallprompt", () => this._render());
      this.recheck();
    },

    /** 단일 재검사 지점 — 보여야 하면 보이고, 아니면 숨긴다(리스너·init 모두 이것만 호출). */
    recheck() {
      if (this.shouldGate()) this.show(); else this.hide();
      if (this.shouldBanner()) this.showTabletBanner(); else this.hideTabletBanner();
    },

    _ensureDom() {
      if (this._gateEl) return this._gateEl;
      let d = document.getElementById("install-gate");
      if (!d) {
        d = document.createElement("div");
        d.id = "install-gate";
        d.className = "install-gate hidden";
        d.setAttribute("role", "dialog");
        d.setAttribute("aria-modal", "true");
        d.setAttribute("aria-label", "앱 설치 필요");
        // 🔴 인라인 = 스타일시트 캐스케이드 우회(위 설계 메모).
        // [WO 20261019] "닫기 버튼 없음"(이전 WO 20261009 요구)은 마스터의 최신 지시로 철회됨 —
        // 화면이 안 닫혀 앱을 못 쓴다는 신고(2026-10-19) 뒤 [브라우저에서 계속 사용] 버튼 추가.
        d.style.position = "fixed";
        d.style.inset = "0";
        d.style.zIndex = "2147483000";
        d.innerHTML =
          '<div class="install-gate-card">' +
            '<img src="/images/icon-192.png" alt="" class="install-gate-icon" onerror="this.style.display=\'none\'" />' +
            '<h2>SEASTAR 360은 앱으로 설치해야 사용할 수 있습니다</h2>' +
            '<p class="install-gate-sub">설치하면 보안 연결과 오프라인 작업을 바로 쓸 수 있습니다.</p>' +
            '<div id="install-gate-ios" class="install-gate-ios hidden">공유 버튼(⬆)을 누른 뒤 “홈 화면에 추가”를 선택하세요.</div>' +
            '<div id="install-gate-guide" class="install-gate-guide hidden"></div>' +
            '<button id="install-gate-btn" type="button" class="install-gate-btn">설치 준비 중…</button>' +
            // [WO 20261010-apk] 안드로이드는 "웹 앱(PWA) 설치 또는 APK 설치" 중 선택 — 렌더는 _render() 가 결정.
            '<div id="install-gate-apk-box" class="hidden" style="margin-top:14px;">' +
              '<div style="font:500 15px/1.5 system-ui,sans-serif;color:inherit;margin-bottom:8px;">또는 안드로이드 앱(APK)을 직접 설치할 수 있습니다(사내 배포 — 설치 중 보안 경고가 뜹니다).</div>' +
              '<button id="install-gate-apk" type="button" style="font:700 17px/1.2 system-ui,sans-serif;padding:14px 18px;border-radius:12px;border:2px solid #1b75bb;background:#ffffff;color:#1b75bb;cursor:pointer;width:100%;">안드로이드 앱(APK)으로 설치</button>' +
            "</div>" +
            '<div id="install-gate-done" class="install-gate-done hidden">설치되었습니다 — 홈 화면의 SEASTAR 아이콘으로 열어 주세요.</div>' +
            // [WO 20261019] 요구 1 — 강제 화면을 닫을 수 있는 유일한 길. 대비 4.5:1 이상(#1b75bb on #fff ≈4.88:1)
            // · 높이 44px 이상(터치 타겟). 인라인 스타일 = 같은 캐스케이드 우회 사유(위 설계 메모) + 공유
            // CSS 파일(style.css) 비점유 준수(다른 팀 작업 중, CLAUDE.md G-4⑥).
            '<p id="install-gate-continue-note" style="color:#6b645a;font:500 12px/1.5 system-ui,sans-serif;margin:14px 0 8px;text-align:left;">설치하면 오프라인·카메라 연결을 쓸 수 있습니다. 지금은 브라우저로 계속할 수도 있습니다.</p>' +
            '<button id="install-gate-continue" type="button" style="display:block;width:100%;min-height:44px;padding:11px 14px;font:700 14px/1.3 system-ui,sans-serif;border:2px solid #1b75bb;border-radius:12px;background:#ffffff;color:#1b75bb;cursor:pointer;">브라우저에서 계속 사용</button>' +
          "</div>";
        document.body.appendChild(d);
      }
      this._gateEl = d;
      const btn = document.getElementById("install-gate-btn");
      if (btn && !btn._igBound) { btn._igBound = true; btn.addEventListener("click", () => this._onInstallClick()); }
      const apkBtn = document.getElementById("install-gate-apk");
      if (apkBtn && !apkBtn._igBound) { apkBtn._igBound = true; apkBtn.addEventListener("click", () => { if (typeof ApkInstall !== "undefined") ApkInstall.open(); }); }
      const continueBtn = document.getElementById("install-gate-continue");
      if (continueBtn && !continueBtn._igBound) { continueBtn._igBound = true; continueBtn.addEventListener("click", () => this._onContinueClick()); }
      return d;
    },

    /** [WO 20261019] 요구 1 — "브라우저에서 계속 사용" 클릭: 화면을 닫고 7일(또는 저장소 차단 시 이 세션) 재노출 금지. */
    _onContinueClick() {
      this._markContinueDismissed();
      this.hide();
    },

    async _onInstallClick() {
      if (typeof Install === "undefined") return;
      if (Install._deferred) {
        const accepted = await Install.accept(); // 기존 Install 모듈의 유일한 prompt() 호출 경로 재사용(중복 금지)
        if (!accepted) this._declinedOnce = true; // 거부 → 수동 안내로 전환(재시도 가능하게)
      } else {
        this._declinedOnce = true;
      }
      this._render();
    },

    /** body 의 다른 모든 직계 자식을 inert — 포인터·키보드·포커스 네이티브 차단(요구 3). */
    _lockBackground() {
      Array.prototype.forEach.call(document.body.children, (el) => {
        // [WO 20261010-apk] data-installgate-allow = 게이트 위에서 열리는 설치 안내(38c ApkInstall) — 잠그면 안내를 못 누른다.
        if (el === this._gateEl || el.hasAttribute("inert") || el.hasAttribute("data-installgate-allow")) return;
        el.setAttribute("data-installgate-inert", "1");
        el.setAttribute("inert", "");
      });
      document.body.style.overflow = "hidden";
    },
    _unlockBackground() {
      Array.prototype.forEach.call(document.querySelectorAll("[data-installgate-inert]"), (el) => {
        el.removeAttribute("inert");
        el.removeAttribute("data-installgate-inert");
      });
      document.body.style.overflow = "";
    },

    show() {
      this._ensureDom();
      this._render();
      this._gateEl.classList.remove("hidden");
      this._lockBackground();
      const btn = document.getElementById("install-gate-btn");
      if (btn && !btn.disabled) { try { btn.focus(); } catch (e) {} }
    },

    hide() {
      if (!this._gateEl) return;
      this._gateEl.classList.add("hidden");
      this._unlockBackground();
    },

    /** 상태(iOS·대기중·안내모드·설치완료)에 맞춰 게이트 내부만 갱신 — 렌더 지점 1곳(SoT). */
    _render() {
      const btn = document.getElementById("install-gate-btn");
      const iosBox = document.getElementById("install-gate-ios");
      const guideBox = document.getElementById("install-gate-guide");
      const doneBox = document.getElementById("install-gate-done");
      if (!btn || !iosBox || !guideBox || !doneBox) return;
      // [WO 20261019] "계속 사용" 섹션 — 설치 완료 후에는 숨긴다(이미 설치 흐름을 탄 상태라 불필요).
      const continueBtn = document.getElementById("install-gate-continue");
      const continueNote = document.getElementById("install-gate-continue-note");
      if (continueBtn) continueBtn.classList.toggle("hidden", !!this._justInstalled);
      if (continueNote) continueNote.classList.toggle("hidden", !!this._justInstalled);
      // [WO 20261010-apk] APK 선택지 — 안드로이드(iOS 아님)·ApkInstall 로드됨·설치 완료 전일 때만.
      const apkBox = document.getElementById("install-gate-apk-box");
      if (apkBox) {
        const apkOk = !this._justInstalled && typeof ApkInstall !== "undefined" && ApkInstall.isAndroid && ApkInstall.isAndroid();
        apkBox.classList.toggle("hidden", !apkOk);
      }
      if (this._justInstalled) {
        btn.classList.add("hidden"); iosBox.classList.add("hidden"); guideBox.classList.add("hidden");
        doneBox.classList.remove("hidden");
        return;
      }
      doneBox.classList.add("hidden");
      const ios = typeof Install !== "undefined" && Install.isIOS();
      if (ios) {
        btn.classList.add("hidden"); guideBox.classList.add("hidden");
        iosBox.classList.remove("hidden");
        return;
      }
      iosBox.classList.add("hidden");
      const ready = typeof Install !== "undefined" && !!Install._deferred;
      const guideMode = !ready && typeof Install !== "undefined" && (Install._promptTimedOut || this._declinedOnce);
      if (guideMode) {
        btn.classList.add("hidden");
        guideBox.classList.remove("hidden");
        guideBox.textContent = Install.browserGuideText();
      } else {
        guideBox.classList.add("hidden");
        btn.classList.remove("hidden");
        btn.disabled = !ready;
        btn.textContent = ready ? "지금 설치" : "설치 준비 중…";
      }
    },

    /* ── [WO 20261019] 요구 2 — 태블릿/폴드 펼침: 전체화면 강제 대신 우측 하단 작은 배너만 ──
       배경을 가리거나 inert 로 잠그지 않는다(비모달) — "닫을 수 있다"가 요구이므로 모달 강제와
       대칭되는 가벼운 UI로 둔다. 설치 자체는 기존 Install.showBanner(true) 로 위임(요구 4, 중복 0). */
    _ensureBannerDom() {
      if (this._bannerEl) return this._bannerEl;
      let d = document.getElementById("install-gate-banner");
      if (!d) {
        d = document.createElement("div");
        d.id = "install-gate-banner";
        d.className = "hidden";
        d.setAttribute("role", "note");
        d.setAttribute("aria-label", "앱 설치 안내");
        // 🔴 인라인 = 같은 캐스케이드 우회 사유(위 설계 메모) + style.css 비점유(다른 팀 작업 중).
        d.style.position = "fixed";
        d.style.right = "16px";
        d.style.bottom = "16px";
        d.style.zIndex = "2147483000";
        d.style.maxWidth = "280px";
        d.style.display = "flex";
        d.style.alignItems = "flex-start";
        d.style.gap = "10px";
        d.style.background = "#faf7f0";
        d.style.border = "1px solid rgba(43,40,32,0.18)";
        d.style.borderRadius = "14px";
        d.style.boxShadow = "0 12px 32px rgba(0,0,0,.28)";
        d.style.padding = "14px 14px 14px 16px";
        d.innerHTML =
          '<div style="flex:1 1 auto;min-width:0;">' +
            '<div style="font:700 13px/1.4 system-ui,sans-serif;color:#2b2820;margin-bottom:8px;">앱으로 설치하면 오프라인·카메라 연결을 바로 쓸 수 있습니다</div>' +
            '<button id="install-gate-banner-install" type="button" style="min-height:40px;padding:8px 14px;font:700 13px/1 system-ui,sans-serif;border:none;border-radius:9px;background:#1b75bb;color:#fff;cursor:pointer;">앱 설치</button>' +
          "</div>" +
          '<button id="install-gate-banner-close" type="button" aria-label="닫기" style="flex:0 0 auto;width:28px;height:28px;border:none;background:transparent;color:#6b645a;font:16px/1 system-ui,sans-serif;cursor:pointer;">×</button>';
        document.body.appendChild(d);
      }
      this._bannerEl = d;
      const installBtn = document.getElementById("install-gate-banner-install");
      if (installBtn && !installBtn._igBound) {
        installBtn._igBound = true;
        installBtn.addEventListener("click", () => { if (typeof Install !== "undefined" && Install.showBanner) Install.showBanner(true); }); // 요구 4 — 기존 38_Install 재사용
      }
      const closeBtn = document.getElementById("install-gate-banner-close");
      if (closeBtn && !closeBtn._igBound) {
        closeBtn._igBound = true;
        closeBtn.addEventListener("click", () => { this._bannerDismissedThisSession = true; this.hideTabletBanner(); });
      }
      return d;
    },
    showTabletBanner() {
      this._ensureBannerDom();
      this._bannerEl.classList.remove("hidden");
    },
    hideTabletBanner() {
      if (!this._bannerEl) return;
      this._bannerEl.classList.add("hidden");
    }
  };
