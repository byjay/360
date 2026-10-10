  /* ══════════════════════════════════════════════════════════════
     APK INSTALL — 안드로이드 앱(APK) 내려받기 + 설치 단계 안내 + APK 안 네이티브 연결 (WO 20261010-apk)
     ────────────────────────────────────────────────────────────────
     마스터: "다운로드 시 핸드폰에 설치할 수 있게 해. 보안 사항에서 '무시하고 설치' 같은 거 있잖아.
              그런 안내 문구를 정확하게 팝업으로 띄우고 설치 가능하게끔 유도해."

     ① 설치 안내(브라우저, 안드로이드 UA 전용) — 단계 데이터(STEPS)가 SoT. 그림(폰 화면 모형, 누를 곳 강조)
        + 큰 글씨 + [이전]/[다음]. 제조사(삼성/그 외)로 분기한다.
        🔴 문구는 전부 공식 출처에서 확인한 실제 화면 문구다(아래 SOURCES — 추측 금지).
           확인하지 못한 버튼 이름(Play 프로텍트 경고의 펼침/설치 버튼)은 "버전에 따라 다를 수 있음"으로 정직하게 표시한다.
        🔴 정직성: 사내 배포 앱이라 Play 스토어를 거치지 않아 경고가 뜬다는 사실 + SHA-256 확인 방법을 같이 보여준다.
           경고를 숨기거나 "안전하니 무시해도 된다"고 거짓 안심시키는 문구 금지.
     ② 파일 정보 SoT = /download/seastar360.json (android-app/scripts/publish-apk.mjs 가 실제 APK 에서 생성).
        버전·크기·SHA-256 을 코드에 박지 않는다(하드코딩 금지) — 못 읽으면 다운로드 버튼을 막고 사유를 보인다.
     ③ APK(Capacitor WebView) 안에서만: 공유 받기(SeastarNative 플러그인) · 하드웨어 뒤로가기(BackGuard 연동)
        · <a download> 저장(WebView 는 무반응 — Filesystem+Share 로 공유 시트) · 새 APK 버전 알림.
        원격 URL 모드라 @capacitor/core 번들이 없다 → Capacitor 네이티브 브리지의 nativePromise/nativeCallback 을 직접 쓴다.
     스타일: 인라인 + 리터럴 hex(36_Help 와 같은 이유 — OS 강제 다크가 var() 글자만 밝히는 함정 차단).
        대비: 본문 #111827 on #ffffff 17.7:1 · 보조 #374151 on #ffffff 10.3:1 · 버튼 #ffffff on #1b75bb 4.9:1
        · 경고 #7c2d12 on #fff7ed 9.6:1 · 강조 테두리 #c2410c on #ffffff 5.2:1(UI 3:1 이상).
  ══════════════════════════════════════════════════════════════ */
  const ApkInstall = {
    META_URL: "/download/seastar360.json",
    Z: 2147483100, // InstallGate(2147483000) 위 — 게이트에서 열어도 가려지지 않게
    _meta: null,
    _metaErr: "",
    _metaPromise: null,
    _vendor: null,
    _step: 0,
    _el: null,
    _exitEl: null,
    _updateAvailable: false,
    _nativeBooted: false,

    /** 공식 출처(문구 대조 근거) — 화면 하단 "출처"에 그대로 노출한다. */
    SOURCES: {
      chrome: { label: "Chromium 소스 문자열(Chrome 안드로이드 다운로드 경고, ko 번역)", url: "https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/ui/android/strings/android_chrome_strings.grd" },
      aospInstaller: { label: "Android 오픈소스 — 패키지 설치 프로그램 문구(ko)", url: "https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/packages/PackageInstaller/res/values-ko/strings.xml" },
      aospSettings: { label: "Android 오픈소스 — 설정 앱 문구(ko)", url: "https://android.googlesource.com/platform/packages/apps/Settings/+/refs/heads/main/res/values-ko/strings.xml" },
      samsungUnknown: { label: "삼성전자서비스 — ‘출처를 알 수 없는 앱’ 설정", url: "https://www.samsungsvc.co.kr/solution/23445" },
      samsungBlocker: { label: "삼성전자서비스 — 보안 위험 자동 차단", url: "https://www.samsungsvc.co.kr/solution/1711930" },
      playProtect: { label: "Google — Play 프로텍트 경고 안내(개발자용)", url: "https://developers.google.com/android/play-protect/warning-dev-guidance?hl=ko" },
      playHelp: { label: "Google Play 고객센터 — Play 프로텍트", url: "https://support.google.com/googleplay/answer/2812853?hl=ko" }
    },

    init() {
      this._initNative();
    },

    /* ── 판정 ── */
    _ua() { return String((window.navigator && window.navigator.userAgent) || ""); },
    _isIOS() { return (typeof Install !== "undefined" && Install.isIOS) ? Install.isIOS() : /iPad|iPhone|iPod/.test(this._ua()); },
    isNative() { return typeof Install !== "undefined" && Install.isNativeApp ? Install.isNativeApp() : false; },
    /** 안드로이드 휴대폰(브라우저 또는 앱). iOS·PC 는 false. */
    isAndroid() { return !this._isIOS() && /Android/i.test(this._ua()); },
    /** 메뉴·게이트 공용 비활성 사유("" = 사용 가능). */
    availabilityReason() {
      if (this.isNative()) return this._updateAvailable ? "" : "이미 SEASTAR 360 앱에서 실행 중";
      if (!this.isAndroid()) return "안드로이드 휴대폰 전용(iPhone은 홈 화면에 추가)";
      return "";
    },
    /** 삼성 갤럭시 추정 — UA 의 SM- 모델명/SamsungBrowser. Chrome 축소 UA 는 모델을 숨기므로 UA-CH 로 보강(비동기). */
    detectVendor() {
      if (/SM-[A-Z0-9]|SAMSUNG|SamsungBrowser/i.test(this._ua())) return "samsung";
      return "other";
    },
    async _refineVendor() {
      try {
        const uad = window.navigator && window.navigator.userAgentData;
        if (!uad || typeof uad.getHighEntropyValues !== "function") return;
        const v = await uad.getHighEntropyValues(["model"]);
        if (v && /^SM-/i.test(String(v.model || "")) && this._vendor !== "samsung" && !this._vendorPicked) {
          this._vendor = "samsung"; this._render();
        }
      } catch (e) {}
    },

    /* ── 파일 정보(SoT: publish-apk.mjs 가 만든 JSON) ── */
    loadMeta(force) {
      if (this._metaPromise && !force) return this._metaPromise;
      this._metaErr = "";
      // ?t= : CF 존 브라우저 캐시(4h)가 no-cache 를 덮는 전례(CLAUDE.md G-4⑨) — 메타는 항상 최신이어야 지문이 파일과 맞는다.
      this._metaPromise = fetch(this.META_URL + "?t=" + Date.now(), { cache: "no-store" })
        .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .then((j) => {
          if (!j || !/^[0-9a-f]{64}$/.test(String(j.sha256 || "")) || !j.file || !(j.bytes > 0)) throw new Error("파일 정보 형식 오류");
          this._meta = j; return j;
        })
        .catch((e) => { this._meta = null; this._metaErr = String((e && e.message) || e); this._metaPromise = null; return null; });
      return this._metaPromise;
    },
    downloadUrl(m) { m = m || this._meta; return m ? ("/download/" + encodeURIComponent(m.file) + "?v=" + m.sha256.slice(0, 12)) : ""; },
    sizeLabel(m) { m = m || this._meta; return m ? ((m.bytes / 1048576).toFixed(1) + " MB") : ""; },
    /** 64자 지문을 8자씩 띄어 보여준다(눈으로 대조하기 쉽게 — 값 자체는 그대로). */
    groupHex(h) { return String(h || "").replace(/(.{8})(?=.)/g, "$1 "); },

    /* ── 단계 데이터(SoT) ── vendor: "all" | "samsung" ── */
    steps(vendor) {
      const v = vendor || this._vendor || this.detectVendor();
      const host = (location && location.host) || "";
      const fname = (this._meta && this._meta.file) || "seastar360.apk";
      const all = [
        {
          id: "download", vendor: "all", title: "내려받기 — Chrome 경고",
          lead: "아래 [APK 내려받기]를 누르면 Chrome이 경고 창을 띄웁니다. 창에서 [무시하고 다운로드]를 누르세요.",
          honest: true, download: true,
          mocks: [
            { kind: "dialog", title: "유해한 파일일 수도 있음", body: "그래도 “" + fname + "” 파일을 다운로드하시겠습니까?", buttons: [{ label: "취소" }, { label: "무시하고 다운로드", hl: true }] }
          ],
          notes: [
            "Chrome 버전에 따라 ‘이 사이트에서 다운로드하시겠습니까?’ 창이 대신 뜨면 [다운로드]를, ‘이러한 형식의 파일은 기기를 손상시킬 수 있습니다.’ 문구가 뜨면 다운로드 확인 버튼을 누르세요.",
            "창에 파일 크기나 사이트 주소(" + host + ")가 함께 표시될 수 있습니다."
          ],
          src: ["chrome"]
        },
        {
          id: "blocker", vendor: "samsung", title: "삼성 — 보안 위험 자동 차단",
          lead: "갤럭시(One UI 6 이상)에서 ‘보안 위험 자동 차단’이 켜져 있으면 Play 스토어·Galaxy Store 밖에서 받은 앱은 경고와 함께 설치되지 않습니다.",
          mocks: [
            { kind: "path", items: ["설정", "보안 및 개인정보 보호", "보안 위험 자동 차단"] },
            { kind: "toggle", header: "보안 위험 자동 차단", label: "사용 중", on: true, hl: true, after: "끄기" }
          ],
          does: ["설정 → 보안 및 개인정보 보호 → 보안 위험 자동 차단 을 엽니다.", "스위치를 끈 뒤 내려받은 파일을 다시 엽니다.", "설치가 끝나면 다시 켜 두는 것을 권합니다."],
          notes: ["이 경고가 뜨지 않으면 이 단계는 건너뛰세요. 삼성 안내: ‘안전한 앱으로 확인된 경우 보안 위험 자동 차단 기능을 잠시 끄고 다시 시도해주세요.’"],
          src: ["samsungBlocker"]
        },
        {
          id: "unknown", vendor: "all", title: "출처를 알 수 없는 앱 허용",
          lead: "다운로드 알림이나 ‘내 파일’에서 " + fname + " 을 누르면, 처음 한 번은 설치가 막히고 아래 창이 뜹니다. [설정]을 누르세요.",
          mocks: [
            { kind: "dialog", title: "Chrome", body: "보안상의 이유로 현재 이 출처의 알 수 없는 앱을 휴대전화에 설치할 수 없습니다. 설정에서 변경할 수 있습니다.", buttons: [{ label: "취소" }, { label: "설정", hl: true }] },
            v === "samsung"
              ? { kind: "toggle", header: "출처를 알 수 없는 앱 설치", label: "이 출처 허용", on: false, hl: true, after: "켜기" }
              : { kind: "toggle", header: "알 수 없는 앱 설치", label: "이 소스에서 가져온 앱 설치 허용", on: false, hl: true, after: "켜기" },
            { kind: "dialog", title: "SEASTAR 360", body: "이 앱을 설치하시겠습니까?", buttons: [{ label: "취소" }, { label: "설치", hl: true }] }
          ],
          does: v === "samsung"
            ? ["[설정] → ‘이 출처 허용’ 스위치 켜기", "뒤로 가기 → ‘이 앱을 설치하시겠습니까?’ 에서 [설치]"]
            : ["[설정] → ‘이 소스에서 가져온 앱 설치 허용’ 스위치 켜기", "뒤로 가기 → ‘이 앱을 설치하시겠습니까?’ 에서 [설치]"],
          notes: [
            v === "samsung"
              ? "나중에 끄려면: 설정 → 애플리케이션 → 특별한 접근 → 출처를 알 수 없는 앱 설치 → Chrome."
              : "나중에 끄려면: 설정 → 앱 → 특수 앱 액세스 → 알 수 없는 앱 설치 → Chrome.",
            "Android 7 이하: 설정 → 보안 → ‘알 수 없는 소스’를 켭니다.",
            "브라우저 이름(Chrome)은 파일을 연 앱 이름으로 바뀌어 보입니다(예: 내 파일)."
          ],
          src: v === "samsung" ? ["aospInstaller", "samsungUnknown"] : ["aospInstaller", "aospSettings"]
        },
        {
          id: "protect", vendor: "all", title: "Google Play 프로텍트",
          lead: "Play 스토어 밖에서 받은 앱이라 Play 프로텍트가 검사를 권하거나 경고할 수 있습니다.",
          mocks: [
            { kind: "dialog", title: "앱 검사 권장됨", body: "Play 프로텍트에서 이 앱을 이전에 본 적이 없습니다. 기기와 데이터를 보호하기 위해 설치하기 전에 Google이 검사할 수 있도록 이 앱에 관한 정보를 보내주세요.", buttons: [{ label: "검사 받기(버튼 이름 예시)", hl: true }] }
          ],
          does: [
            "검사를 권하면 검사를 받는 쪽을 고르세요 — 잠시 뒤 설치해도 안전한지 결과가 표시됩니다.",
            "경고 창이 설치를 막으면 창 아래 펼침 메뉴(‘자세히’ / ‘세부정보 더보기’)를 열고 [무시하고 설치]를 누르세요."
          ],
          notes: [
            "⚠ Play 프로텍트 창의 버튼 이름은 Play 서비스 버전마다 조금씩 다릅니다(Google 공식 문서에 버튼 이름이 없음). 위 그림의 버튼 이름은 예시입니다.",
            "‘Play 프로텍트에서 식별할 수 없는 앱입니다. 모두의 안전을 위해 앱을 Google에 전송하여 보안 확인을 받으세요.’ 창이 뜨면 전송(검사)을 허용하면 됩니다.",
            "SEASTAR 360 앱은 문자(SMS)·접근성·알림 접근 같은 민감 권한을 쓰지 않습니다(위치만 사용) — Google이 이런 권한을 쓰는 사이드로드 앱만 자동 차단합니다."
          ],
          src: ["playProtect", "playHelp"]
        },
        {
          id: "done", vendor: "all", title: "설치 완료 — 열기",
          lead: "‘앱이 설치되었습니다.’ 가 보이면 [열기]를 누르세요. 홈 화면에 SEASTAR 360 아이콘이 생깁니다.",
          mocks: [
            { kind: "dialog", title: "SEASTAR 360", body: "앱이 설치되었습니다.", buttons: [{ label: "완료" }, { label: "열기", hl: true }] }
          ],
          does: [
            "앱에서 다시 로그인하세요(브라우저와 로그인·오프라인 저장분이 따로 보관됩니다). 앱 안에서 Google 로그인이 막히면 회사 이메일 로그인을 쓰세요.",
            "이미 홈 화면에 웹 바로가기(웹 앱)가 있다면 둘 다 같은 서버·같은 데이터를 엽니다. 앱만 쓰기로 했다면 웹 바로가기 아이콘은 길게 눌러 삭제해도 됩니다.",
            "앱 화면은 항상 서버의 최신 버전으로 열립니다. 앱 자체를 새로 받아야 할 때는 이 안내에서 다시 내려받아 덮어 설치하면 됩니다(데이터 유지)."
          ],
          notes: ["설치 후 ‘출처를 알 수 없는 앱’ 허용을 다시 꺼 두어도 앱은 그대로 실행됩니다."],
          src: ["aospInstaller"]
        }
      ];
      return all.filter((s) => s.vendor === "all" || s.vendor === v);
    },

    /* ── 열기/닫기/이동 ── */
    open(opts) {
      opts = opts || {};
      const why = this.availabilityReason();
      if (why && !opts.force) { this._toast(why); return false; }
      if (!this._vendor) this._vendor = this.detectVendor();
      this._step = 0;
      this._ensureDom();
      this._el.style.display = "flex";
      this._render();
      this._refineVendor();
      this.loadMeta().then(() => this._render());
      return true;
    },
    close() {
      if (this._el) this._el.style.display = "none";
    },
    isOpen() { return !!(this._el && this._el.style.display !== "none"); },
    go(i) {
      const n = this.steps().length;
      this._step = Math.max(0, Math.min(n - 1, i));
      this._render();
    },
    next() { this.go(this._step + 1); },
    prev() { this.go(this._step - 1); },
    setVendor(v) { this._vendor = v === "samsung" ? "samsung" : "other"; this._vendorPicked = true; const n = this.steps().length; if (this._step > n - 1) this._step = n - 1; this._render(); },

    _ensureDom() {
      if (this._el) return this._el;
      const d = document.createElement("div");
      d.id = "apk-guide";
      d.setAttribute("role", "dialog");
      d.setAttribute("aria-modal", "true");
      d.setAttribute("aria-labelledby", "apk-guide-title");
      d.setAttribute("data-installgate-allow", "1"); // 38b 게이트의 inert 잠금에서 제외(게이트에서 열 수 있게)
      d.style.cssText = "position:fixed;inset:0;z-index:" + this.Z + ";display:none;align-items:stretch;justify-content:center;background:rgba(17,24,39,.72);";
      d.innerHTML = '<div id="apk-guide-card" style="background:#ffffff;color:#111827;width:100%;max-width:520px;height:100%;overflow:auto;-webkit-overflow-scrolling:touch;font:400 18px/1.55 system-ui,-apple-system,\'Noto Sans KR\',sans-serif;box-sizing:border-box;padding:16px 16px calc(16px + env(safe-area-inset-bottom));display:flex;flex-direction:column;"></div>';
      d.addEventListener("click", (e) => {
        const t = e.target && e.target.closest ? e.target.closest("[data-apk]") : null;
        if (!t) return;
        const act = t.getAttribute("data-apk");
        if (act === "close") this.close();
        else if (act === "next") this.next();
        else if (act === "prev") this.prev();
        else if (act === "vendor") this.setVendor(t.getAttribute("data-v"));
        else if (act === "retry") { this.loadMeta(true).then(() => this._render()); this._render(); }
        else if (act === "copy") this._copy(this._meta ? this._meta.sha256 : "");
        else if (act === "download") { this._downloaded = true; setTimeout(() => this._render(), 0); }
      });
      document.body.appendChild(d);
      this._el = d;
      return d;
    },

    _esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); },

    /** 폰 화면 모형 — 지금 눌러야 할 곳을 주황 테두리 + "누르세요"로 강조. */
    _mockHtml(m) {
      const e = (s) => this._esc(s);
      const frame = (inner) => '<div class="apk-mock" style="width:250px;max-width:100%;margin:0 auto;background:#1f2937;border-radius:22px;padding:10px;box-sizing:border-box;">' +
        '<div style="background:#e5e7eb;border-radius:14px;min-height:150px;padding:14px 10px;display:flex;align-items:center;justify-content:center;">' + inner + "</div></div>";
      const hlBadge = '<span style="display:inline-block;margin-left:6px;font:700 13px/1 system-ui,sans-serif;color:#ffffff;background:#c2410c;border-radius:999px;padding:4px 8px;vertical-align:middle;">누르세요</span>';
      if (m.kind === "dialog") {
        const btns = (m.buttons || []).map((b) => '<span data-mock-btn="' + e(b.label) + '"' + (b.hl ? ' data-hl="1"' : "") + ' style="display:inline-block;font:700 15px/1.2 system-ui,sans-serif;color:#1d4ed8;padding:8px 10px;border-radius:8px;' +
          (b.hl ? "outline:3px solid #c2410c;outline-offset:1px;background:#fff7ed;" : "") + '">' + e(b.label) + "</span>").join(" ");
        return frame('<div style="background:#ffffff;border-radius:12px;padding:12px;width:100%;box-shadow:0 2px 8px rgba(0,0,0,.18);">' +
          '<div style="font:700 16px/1.3 system-ui,sans-serif;color:#111827;margin-bottom:6px;">' + e(m.title) + "</div>" +
          '<div style="font:400 14px/1.45 system-ui,sans-serif;color:#374151;margin-bottom:8px;">' + e(m.body) + "</div>" +
          '<div style="text-align:right;">' + btns + "</div>" +
          ((m.buttons || []).some((b) => b.hl) ? '<div style="text-align:right;margin-top:4px;">' + hlBadge + "</div>" : "") + "</div>");
      }
      if (m.kind === "toggle") {
        const track = m.on ? "#1d4ed8" : "#6b7280"; // 꺼짐 트랙도 흰 배경 대비 4.8:1(UI 3:1 이상)
        return frame('<div style="background:#ffffff;border-radius:12px;padding:12px;width:100%;">' +
          '<div style="font:700 15px/1.3 system-ui,sans-serif;color:#111827;border-bottom:1px solid #d1d5db;padding-bottom:8px;margin-bottom:10px;">' + e(m.header) + "</div>" +
          '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;' + (m.hl ? "outline:3px solid #c2410c;outline-offset:3px;border-radius:8px;" : "") + '">' +
          '<span style="font:600 14px/1.35 system-ui,sans-serif;color:#111827;">' + e(m.label) + "</span>" +
          '<span aria-hidden="true" style="flex:none;width:42px;height:24px;border-radius:12px;background:' + track + ';position:relative;"><span style="position:absolute;top:3px;' + (m.on ? "right:3px;" : "left:3px;") + 'width:18px;height:18px;border-radius:50%;background:#ffffff;"></span></span></div>' +
          '<div style="text-align:right;margin-top:8px;"><span style="font:700 14px/1 system-ui,sans-serif;color:#7c2d12;">→ ' + e(m.after || "") + "</span>" + hlBadge + "</div></div>");
      }
      if (m.kind === "path") {
        return frame('<div style="background:#ffffff;border-radius:12px;padding:10px 12px;width:100%;">' +
          (m.items || []).map((it, i) => '<div style="font:' + (i === m.items.length - 1 ? "700" : "500") + ' 15px/1.3 system-ui,sans-serif;color:#111827;padding:8px 4px;' +
            (i < m.items.length - 1 ? "border-bottom:1px solid #e5e7eb;" : "outline:3px solid #c2410c;outline-offset:1px;border-radius:6px;") + '">' + (i ? "› " : "") + e(it) + "</div>").join("") + "</div>");
      }
      return "";
    },

    _render() {
      if (!this._el) return;
      const card = document.getElementById("apk-guide-card");
      if (!card) return;
      const e = (s) => this._esc(s);
      const list = this.steps();
      if (this._step > list.length - 1) this._step = list.length - 1;
      const s = list[this._step];
      const m = this._meta;
      const isFirst = this._step === 0, isLast = this._step === list.length - 1;
      const vend = this._vendor || "other";
      const chip = (v, label) => '<button type="button" data-apk="vendor" data-v="' + v + '" aria-pressed="' + (vend === v) + '" style="font:600 15px/1.2 system-ui,sans-serif;padding:8px 12px;border-radius:999px;cursor:pointer;' +
        (vend === v ? "background:#111827;color:#ffffff;border:2px solid #111827;" : "background:#ffffff;color:#111827;border:2px solid #9ca3af;") + '">' + label + "</button>";
      const dots = list.map((x, i) => '<span data-step-dot="' + x.id + '" style="display:inline-block;width:' + (i === this._step ? 22 : 10) + 'px;height:10px;border-radius:5px;margin:0 3px;background:' + (i === this._step ? "#1b75bb" : "#9ca3af") + ';"></span>').join("");

      let fileBox = "";
      if (s.download) {
        if (m) {
          fileBox = '<div id="apk-file-info" style="border:1px solid #d1d5db;border-radius:12px;padding:12px;margin:12px 0;background:#f9fafb;">' +
            '<div style="font:700 17px/1.4 system-ui,sans-serif;color:#111827;">' + e(m.file) + "</div>" +
            '<div style="font:400 16px/1.5 system-ui,sans-serif;color:#374151;">버전 <b id="apk-ver" style="color:#111827;">' + e(m.versionName) + "</b> · 크기 <b id=\"apk-size\" style=\"color:#111827;\">" + e(this.sizeLabel(m)) + "</b></div>" +
            '<div style="font:600 15px/1.4 system-ui,sans-serif;color:#111827;margin-top:8px;">파일 SHA-256 지문</div>' +
            '<div id="apk-sha256" data-sha256="' + e(m.sha256) + '" style="font:500 15px/1.5 ui-monospace,Consolas,monospace;color:#111827;word-break:break-all;background:#ffffff;border:1px solid #d1d5db;border-radius:8px;padding:8px;">' + e(this.groupHex(m.sha256)) + "</div>" +
            '<button type="button" data-apk="copy" style="margin-top:6px;font:600 15px/1 system-ui,sans-serif;padding:8px 12px;border-radius:8px;border:1px solid #6b7280;background:#ffffff;color:#111827;cursor:pointer;">지문 복사</button>' +
            (m.signerSha256 ? '<div style="font:400 13px/1.5 system-ui,sans-serif;color:#374151;margin-top:8px;word-break:break-all;">서명 인증서 SHA-256(전산 담당 확인용): <span id="apk-signer" style="font-family:ui-monospace,Consolas,monospace;">' + e(m.signerSha256) + "</span></div>" : "") +
            '<a id="apk-download" data-apk="download" href="' + e(this.downloadUrl(m)) + '" download="' + e(m.file) + '" style="display:block;text-align:center;margin-top:12px;font:700 20px/1.2 system-ui,sans-serif;padding:16px;border-radius:12px;background:#1b75bb;color:#ffffff;text-decoration:none;">APK 내려받기 (' + e(this.sizeLabel(m)) + ")</a>" +
            (this._downloaded ? '<div role="status" style="margin-top:8px;font:600 16px/1.4 system-ui,sans-serif;color:#14532d;">다운로드를 시작했습니다 — Chrome 경고 창이 뜨면 아래 그림처럼 누른 뒤 [다음]으로 넘어가세요.</div>' : "") +
            "</div>";
        } else {
          fileBox = '<div id="apk-file-info" role="alert" style="border:1px solid #fca5a5;border-radius:12px;padding:12px;margin:12px 0;background:#fef2f2;color:#7f1d1d;font:500 16px/1.5 system-ui,sans-serif;">' +
            (this._metaErr ? ("앱 파일 정보를 불러오지 못했습니다(" + e(this._metaErr) + "). 지문을 확인할 수 없는 파일은 내려받지 않도록 다운로드를 막아 두었습니다.") : "앱 파일 정보를 불러오는 중…") +
            (this._metaErr ? '<br><button type="button" data-apk="retry" style="margin-top:8px;font:600 16px/1 system-ui,sans-serif;padding:10px 14px;border-radius:8px;border:1px solid #7f1d1d;background:#ffffff;color:#7f1d1d;cursor:pointer;">다시 시도</button>' : "") + "</div>";
        }
      }
      const honest = s.honest ? '<div id="apk-honest" style="border-left:5px solid #c2410c;background:#fff7ed;color:#7c2d12;border-radius:8px;padding:10px 12px;margin:10px 0;font:500 16px/1.55 system-ui,sans-serif;">' +
        "<b>왜 경고가 뜨나요?</b> SEASTAR 360 앱은 씨스타 <b>사내 배포 앱</b>입니다. Play 스토어를 거치지 않고 이 사이트(" + e(location.host) + ")에서 직접 받기 때문에 휴대폰이 보안 경고를 띄웁니다. 경고는 정상 동작이며 숨길 수 없습니다. " +
        "받은 파일이 진짜인지는 아래 <b>SHA-256 지문</b>으로 확인하세요(PC: Windows <code>certutil -hashfile " + e((m && m.file) || "seastar360.apk") + " SHA256</code>, Mac <code>shasum -a 256 " + e((m && m.file) || "seastar360.apk") + "</code> 결과가 같아야 함). " +
        "이 사이트가 아닌 곳에서 받은 SEASTAR APK는 설치하지 마세요.</div>" : "";
      const mocks = (s.mocks || []).map((mk, i) => (i ? '<div aria-hidden="true" style="text-align:center;font:700 22px/1 system-ui,sans-serif;color:#374151;margin:6px 0;">↓</div>' : "") + this._mockHtml(mk)).join("");
      const does = (s.does || []).length ? '<ol style="margin:12px 0 0;padding-left:24px;font:600 18px/1.55 system-ui,sans-serif;color:#111827;">' + s.does.map((d) => "<li style=\"margin-bottom:6px;\">" + e(d) + "</li>").join("") + "</ol>" : "";
      const notes = (s.notes || []).map((n) => '<p style="margin:8px 0 0;font:400 15px/1.5 system-ui,sans-serif;color:#374151;">' + e(n) + "</p>").join("");
      const srcs = (s.src || []).map((k) => this.SOURCES[k]).filter(Boolean).map((x) => '<a href="' + e(x.url) + '" target="_blank" rel="noopener" style="color:#1d4ed8;">' + e(x.label) + "</a>").join(" · ");

      card.innerHTML =
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">' +
          '<div style="font:700 15px/1.2 system-ui,sans-serif;color:#374151;">안드로이드 앱 설치 · <span id="apk-step-no">' + (this._step + 1) + "</span>/" + list.length + "</div>" +
          '<button type="button" data-apk="close" aria-label="닫기" style="font:700 22px/1 system-ui,sans-serif;width:44px;height:44px;border-radius:10px;border:1px solid #9ca3af;background:#ffffff;color:#111827;cursor:pointer;">✕</button>' +
        "</div>" +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;margin:10px 0 6px;" aria-label="휴대폰 제조사">' + chip("samsung", "삼성 갤럭시") + chip("other", "그 외 안드로이드") + "</div>" +
        '<h2 id="apk-guide-title" data-step-id="' + e(s.id) + '" style="font:800 23px/1.3 system-ui,sans-serif;color:#111827;margin:10px 0 6px;">' + e(s.title) + "</h2>" +
        '<p id="apk-lead" style="margin:0;font:600 18px/1.55 system-ui,sans-serif;color:#111827;">' + e(s.lead) + "</p>" +
        honest + fileBox +
        '<div style="margin:14px 0 4px;">' + mocks + "</div>" +
        does + notes +
        (srcs ? '<p style="margin:12px 0 0;font:400 13px/1.5 system-ui,sans-serif;color:#374151;">출처: ' + srcs + "</p>" : "") +
        '<div style="flex:1 0 12px;"></div>' +
        '<div style="text-align:center;margin:12px 0 8px;" aria-hidden="true">' + dots + "</div>" +
        '<div style="display:flex;gap:10px;">' +
          '<button type="button" data-apk="prev" id="apk-prev" ' + (isFirst ? "disabled" : "") + ' style="flex:1;font:700 19px/1 system-ui,sans-serif;padding:16px;border-radius:12px;border:2px solid #6b7280;background:#ffffff;color:#111827;' + (isFirst ? "opacity:.45;" : "cursor:pointer;") + '">이전</button>' +
          (isLast
            ? '<button type="button" data-apk="close" id="apk-next" style="flex:1;font:700 19px/1 system-ui,sans-serif;padding:16px;border-radius:12px;border:0;background:#1b75bb;color:#ffffff;cursor:pointer;">닫기</button>'
            : '<button type="button" data-apk="next" id="apk-next" style="flex:1;font:700 19px/1 system-ui,sans-serif;padding:16px;border-radius:12px;border:0;background:#1b75bb;color:#ffffff;cursor:pointer;">다음</button>') +
        "</div>";
      try { card.scrollTop = 0; } catch (err) {}
    },

    _copy(text) {
      if (!text) return;
      const ok = () => this._toast("SHA-256 지문을 복사했습니다");
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(ok, () => this._toast("복사하지 못했습니다 — 길게 눌러 선택하세요")); return; }
      } catch (e) {}
      this._toast("복사하지 못했습니다 — 길게 눌러 선택하세요");
    },
    _toast(m, ms) { try { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast(m, ms); } catch (e) {} },

    /* ══ APK(Capacitor) 안에서만 ══ */
    _cap() {
      const c = window.Capacitor;
      return (c && typeof c.nativePromise === "function" && this.isNative()) ? c : null;
    },
    _initNative() {
      if (this._nativeBooted) return;
      const cap = this._cap();
      if (!cap) return;
      this._nativeBooted = true;
      // 원격 URL 모드엔 @capacitor/core 가 없어 Capacitor.Plugins 가 비어 있다 → 58_BackGuard.leave() 가 찾는
      // Plugins.App.exitApp 만 브리지로 이어 준다. addListener 는 일부러 두지 않는다 — backButton 배선은 여기 한 곳
      // (BackGuard.wireCapacitor 가 따로 걸면 한 번 누름에 두 번 처리된다).
      try {
        if (!cap.Plugins) cap.Plugins = {};
        if (!cap.Plugins.App) cap.Plugins.App = { exitApp: () => cap.nativePromise("App", "exitApp", {}) };
      } catch (e) {}
      // 공유 받기 — 부팅 시 쌓인 것 + 실행 중 새로 들어온 것
      this.pullShared();
      window.addEventListener("seastarshared", () => this.pullShared());
      // 하드웨어 뒤로가기 — 리스너가 있으면 @capacitor/app 은 기본 동작(웹뷰 goBack)을 하지 않고 우리에게 넘긴다.
      try { cap.nativeCallback("App", "addListener", { eventName: "backButton" }, (data) => { this.onBackButton(data); }); } catch (e) {}
      this._installDownloadShim(cap);
      this._checkUpdate(cap);
    },

    /** 네이티브가 cache/shared/ 에 복사해 둔 공유 사진 → File → 기존 ThetaIntake.receive(새 수신 로직 0). */
    async pullShared() {
      const cap = this._cap();
      if (!cap) return 0;
      let res = null;
      try { res = await cap.nativePromise("SeastarNative", "takeShared", {}); } catch (e) { return 0; }
      const list = (res && res.files) || [];
      if (!list.length) return 0;
      const files = [];
      for (const f of list) {
        try {
          const r = await fetch(cap.convertFileSrc(f.path));
          const blob = await r.blob();
          files.push(new File([blob], f.name || "shared.jpg", { type: f.type || blob.type || "image/jpeg" }));
        } catch (e) {}
      }
      try { await cap.nativePromise("SeastarNative", "releaseShared", { paths: list.map((f) => f.path) }); } catch (e) {}
      if (!files.length) { this._toast("공유받은 사진을 읽지 못했습니다"); return 0; }
      if (typeof ThetaIntake !== "undefined" && ThetaIntake.receive) {
        try { await ThetaIntake.receive(files, { source: "share" }); } catch (e) {}
      }
      return files.length;
    },

    /** 하드웨어 뒤로가기.
     *  58_BackGuard.js(다른 팀) 계약 — handleBack() 은 항상 스스로 처리한다(이전 화면·레이어 닫기·최상위면
     *  "정말 나가시겠습니까?" 확인 → [나가기] 때만 Capacitor.Plugins.App.exitApp()). 반환값은 진단 문자열.
     *  BackGuard 가 없으면(구버전 번들 등): 웹뷰 history 가 있으면 history.back(), 최상위면 자체 종료 확인. */
    async onBackButton(data) {
      if (this._exitEl && this._exitEl.style.display !== "none") { this._exitEl.style.display = "none"; return "dismiss-exit"; }
      if (this.isOpen()) { this.close(); return "close-guide"; }
      const canGoBack = !!(data && data.canGoBack);
      if (typeof BackGuard !== "undefined" && BackGuard && typeof BackGuard.handleBack === "function") {
        let r = "";
        try { r = await BackGuard.handleBack(); } catch (e) { r = "error"; }
        if (r !== "error") return "backguard:" + r;
      } else if (canGoBack) {
        window.history.back();
        return "history";
      }
      this.confirmExit();
      return "confirm";
    },
    confirmExit() {
      let d = this._exitEl;
      if (!d) {
        d = document.createElement("div");
        d.id = "apk-exit-confirm";
        d.setAttribute("role", "alertdialog");
        d.setAttribute("aria-modal", "true");
        d.setAttribute("aria-labelledby", "apk-exit-title");
        d.setAttribute("data-installgate-allow", "1");
        d.style.cssText = "position:fixed;inset:0;z-index:" + (this.Z + 1) + ";display:flex;align-items:center;justify-content:center;background:rgba(17,24,39,.6);";
        d.innerHTML = '<div style="background:#ffffff;color:#111827;border-radius:16px;padding:20px;width:min(320px,88vw);font:400 17px/1.5 system-ui,sans-serif;">' +
          '<h2 id="apk-exit-title" style="margin:0 0 8px;font:800 20px/1.3 system-ui,sans-serif;">정말 나가시겠습니까?</h2>' +
          '<p style="margin:0 0 16px;color:#374151;">저장하지 않은 작업이 있으면 먼저 저장하세요.</p>' +
          '<div style="display:flex;gap:10px;"><button type="button" id="apk-exit-cancel" style="flex:1;font:700 18px/1 system-ui,sans-serif;padding:14px;border-radius:10px;border:2px solid #6b7280;background:#ffffff;color:#111827;">취소</button>' +
          '<button type="button" id="apk-exit-ok" style="flex:1;font:700 18px/1 system-ui,sans-serif;padding:14px;border-radius:10px;border:0;background:#b91c1c;color:#ffffff;">나가기</button></div></div>';
        document.body.appendChild(d);
        d.querySelector("#apk-exit-cancel").addEventListener("click", () => { d.style.display = "none"; });
        d.querySelector("#apk-exit-ok").addEventListener("click", () => { d.style.display = "none"; this.exitApp(); });
        this._exitEl = d;
      }
      d.style.display = "flex";
      try { d.querySelector("#apk-exit-cancel").focus(); } catch (e) {}
    },
    exitApp() {
      const cap = this._cap();
      if (cap) { try { cap.nativePromise("App", "exitApp", {}); } catch (e) {} }
    },

    /** WebView 는 <a download> 를 무시한다(창고 레시피 함정 #3) — blob:/data:/같은 출처 링크를
     *  Filesystem(CACHE)에 쓰고 공유 시트로 넘겨 "저장/보내기"가 실제로 되게 한다. 앱 안에서만 설치. */
    _installDownloadShim(cap) {
      const self = this;
      const should = (a) => {
        try {
          if (!a || !a.hasAttribute || !a.hasAttribute("download")) return false;
          const href = a.href || "";
          if (/^(blob:|data:)/i.test(href)) return true;
          return new URL(href, location.href).origin === location.origin;
        } catch (e) { return false; }
      };
      const proto = window.HTMLAnchorElement && window.HTMLAnchorElement.prototype;
      if (proto && !proto.__apkShim) {
        const orig = proto.click;
        proto.click = function () { if (should(this)) { self._saveAnchor(cap, this); return; } return orig.apply(this, arguments); };
        proto.__apkShim = true;
      }
      document.addEventListener("click", (ev) => {
        const a = ev.target && ev.target.closest ? ev.target.closest("a[download]") : null;
        if (a && should(a)) { ev.preventDefault(); self._saveAnchor(cap, a); }
      }, true);
    },
    _saveAnchor(cap, a) {
      const name = String(a.getAttribute("download") || "download").replace(/[\\/:*?"<>|]+/g, "_") || "download";
      // fetch 를 동기적으로 시작한다 — 호출부가 click() 직후 revokeObjectURL 해도 blob 을 이미 잡았다.
      const p = fetch(a.href);
      (async () => {
        try {
          const blob = await (await p).blob();
          const b64 = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1] || ""); fr.onerror = rej; fr.readAsDataURL(blob); });
          const w = await cap.nativePromise("Filesystem", "writeFile", { path: name, data: b64, directory: "CACHE" });
          await cap.nativePromise("Share", "share", { title: name, url: w.uri, dialogTitle: "파일 저장·보내기" });
        } catch (e) {
          this._toast("파일을 저장하지 못했습니다: " + String((e && e.message) || e));
        }
      })();
    },

    /** 설치된 APK 의 versionCode 가 서버 메타보다 낮으면 알린다(앱 화면은 원격이라 늘 최신 — 네이티브 변경 때만 필요). */
    async _checkUpdate(cap) {
      try {
        const info = await cap.nativePromise("App", "getInfo", {});
        const meta = await this.loadMeta();
        if (!info || !meta) return;
        if (Number(meta.versionCode) > Number(info.build)) {
          this._updateAvailable = true;
          this._toast("새 SEASTAR 360 앱(" + meta.versionName + ")이 있습니다 — 전체 기능 › 안드로이드 앱 설치에서 받으세요", 6000);
        }
      } catch (e) {}
    }
  };
