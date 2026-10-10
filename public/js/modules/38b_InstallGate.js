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
       독립적으로 먼저 검사하지 않고 이 로그인 검사 하나로 자연히 성립시킨다 — 열람 공유 링크의
       실제 사용자는 비로그인이므로 Auth.user 가 없어 여기서 그대로 빠진다. 링크 여부로 별도
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
  ══════════════════════════════════════════ */
  const InstallGate = {
    FLAG_KEY: "install-required",
    _gateEl: null,
    _justInstalled: false,
    _declinedOnce: false,

    /** 지금 게이트를 띄워야 하는가 — 단일 판정 지점(SoT). */
    shouldGate() {
      try {
        if (typeof Install === "undefined") return false;
        if (Install.isStandalone()) return false;     // 이미 설치된 앱(요구 6)
        if (!Install.isMobile()) return false;         // PC 제외
        // 로그인 사용자만 대상 — 공유 열람 링크(비로그인)는 이 한 줄로 자연히 예외가 된다(위 설계 메모).
        if (!(typeof Auth !== "undefined" && Auth.user)) return false;
        if (typeof AdminPanels !== "undefined" && AdminPanels.isEnabled && !AdminPanels.isEnabled(this.FLAG_KEY)) return false; // 관리자 스위치
        return true;
      } catch (e) { return false; }
    },

    init() {
      this._ensureDom();
      window.addEventListener("pageshow", () => this.recheck());
      document.addEventListener("visibilitychange", () => { if (!document.hidden) this.recheck(); });
      window.addEventListener("appinstalled", () => { this._justInstalled = true; this.recheck(); });
      // Install 모듈이 beforeinstallprompt 를 캡처해 Install._deferred 를 채운다(새 캡처 0, 중복 금지) —
      // 게이트가 떠 있는 동안 그 순간 "설치 준비 중" → "지금 설치"로 내부 렌더만 갱신한다.
      window.addEventListener("beforeinstallprompt", () => this._render());
      this.recheck();
    },

    /** 단일 재검사 지점 — 보여야 하면 보이고, 아니면 숨긴다(리스너·init 모두 이것만 호출). */
    recheck() {
      if (this.shouldGate()) this.show(); else this.hide();
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
        // 🔴 인라인 = 스타일시트 캐스케이드 우회(위 설계 메모). 닫기 버튼 없음(요구 2 — 의도적).
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
          "</div>";
        document.body.appendChild(d);
      }
      this._gateEl = d;
      const btn = document.getElementById("install-gate-btn");
      if (btn && !btn._igBound) { btn._igBound = true; btn.addEventListener("click", () => this._onInstallClick()); }
      const apkBtn = document.getElementById("install-gate-apk");
      if (apkBtn && !apkBtn._igBound) { apkBtn._igBound = true; apkBtn.addEventListener("click", () => { if (typeof ApkInstall !== "undefined") ApkInstall.open(); }); }
      return d;
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
    }
  };
