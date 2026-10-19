  /* ══════════════════════════════════════════════════════════════
     도움말(Help) 체계 — 마스터 지시: "항상 모든 메뉴마다 사용자 매뉴얼을 구현해"
     ────────────────────────────────────────────────────────────────
     [설계 방침 — 작게 시작] 버튼 259개에 개별 문서를 일일이 다는 대신, 재사용
     가능한 얇은 체계 하나만 둔다: 요소에 `data-help="키"` 를 달면, 도움말 모드를
     켰을 때 그 요소 옆에 "?" 표시(배지)가 나타나고, 배지를 누르면 설명이 뜬다.

     🔴 [2026-09-17 재작업 — "길게 누르기" 반려] 최초 구현은 요소를 길게 누르면
     팝업이 뜨는 방식이었으나, **화면에 아무 단서가 없어 존재를 알 수 없다**는
     이유로 반려됨(방향보정 기능이 있는데도 "사라졌다"고 보고됐던 것과 동일한 패턴 —
     기능이 있어도 발견 못 하면 없는 것과 같다). 추가로 길게 누르기는 버튼의 원래
     클릭 동작과 물리적으로 충돌해(누르다 떼면 클릭 발생) 오작동 억제 코드가
     필요했다 — 그 자체가 방식이 틀렸다는 신호였다.

     트리거 방식 = **도움말 모드 토글("?" 버튼 1개, 화면에 항상 보임) + 배지**.
       - 토글을 켜면 `data-help` 가 있는 모든 요소 옆(우상단)에 작은 "?" 배지가
         **화면에 보이는 형태로** 나타난다 → 사용자가 "도움말이 있다"는 사실 자체를
         한눈에 알 수 있다(요구① 충족). 평소(꺼짐)엔 화면이 깨끗하다.
       - 배지는 대상 요소의 **자식이 아니라 `document.body` 에 별도로 추가되는
         완전히 분리된 엘리먼트**이므로, 배지를 눌러도 그 아래 버튼의 클릭 이벤트가
         발생하지 않는다(요구: 원래 동작과 충돌 금지 — 억제 코드로 땜질하는 게 아니라
         구조적으로 겹치지 않게 설계). 방어적으로 stopPropagation/preventDefault 도
         호출한다.
       - 토글·배지 모두 **click 이벤트만으로 동작**한다(hover/mouseenter 의존 0) →
         터치 기기(현장 폰)에서도 탭 한 번으로 100% 도달 가능(요구②: 호버 전용 금지).
       - 기존 `title` 속성(브라우저 기본 툴팁, 130개 이미 존재)은 전혀 건드리지 않는다.

     SoT(정본) = 아래 `Help.CONTENT` 객체 하나. 도움말 문구를 다른 파일에 복제하지 않는다.
     내용이 없는 키는 조용히 무시하지 않고 "준비 중" 문구 + console.warn 으로 알린다
     (사용자에게는 오류로 보이지 않게, 개발자에게는 빠뜨린 키를 알 수 있게).

     🔴 반드시 `_manifest.txt` 에 등록해야 번들(main.js)에 포함된다(빠뜨리면 고아 모듈).
     🔴 새 CSS 규칙 추가 금지(style.css 는 다른 트랙이 점유 중) — 전부 인라인 스타일,
        리터럴 hex(테마 변수 var() 미사용 — OS 강제다크모드가 var() 텍스트만 밝게
        재해석하는 이 코드베이스의 기존 함정을 원천 차단).
        대비 실측: 배지/팝업 #ffffff on #1a1712 ≈ 18.7:1. 토글 on-상태 #1a1712 on
        #c9962a ≈ 8.0:1(WCAG AAA). 모두 4.5:1 기준 여유.
     🔴 토글 버튼은 이 모듈이 JS로 직접 body 에 생성해 붙인다(index.html 수정 불필요,
        다른 트랙과 충돌 없음). 배치는 좌하단(bottom:16,left:16) — 우하단 wm-toast,
        상단 net-badge 등 기존 고정 UI와 자리가 겹치지 않는다(겹치면 지휘자가
        index.html/좌표로 재배치 가능하도록 z-index/스타일을 한 곳에 모아둠).
  ══════════════════════════════════════════════════════════════ */
  const Help = {
    // ── SoT: 도움말 문구 정본. 여기 한 곳에서만 관리한다 ──
    // 초기 8개(마스터 지정 핵심 메뉴). 나머지 버튼은 키를 비워두고 점진 확장한다.
    CONTENT: {
      "zone-create": "구역/영역 만들기 — 도면 위에서 사각형·원형·다각형 도구를 선택한 뒤 그리면, 그 안에 속한 핀들을 하나의 구역(영역)으로 묶어 관리할 수 있습니다.",
      "drawing-upload": "도면 등록 — PDF 또는 이미지(JPG/PNG) 파일을 업로드하면 그 위에 포인트(핀)를 찍을 수 있는 캔버스가 만들어집니다.",
      "pin-place": "포인트(핀) 찍기 — 도면 위 원하는 위치를 클릭하면 그 자리에 360° 파노라마를 연결할 핀이 생성됩니다.",
      "region-extract": "도면 영역 추출 — A0 같은 한 장짜리 도면에 평면도·측면도·단면도가 여러 개 들어 있을 때, 그중 하나를 드래그로 긁으면 그 부분만 보이는 새 영역(구역)이 만들어집니다. 원본 PDF 는 전혀 바뀌지 않고 '그 부분만 확대해서 보는 창'이 하나 더 생기는 것이라, 같은 도면에서 몇 번이든 반복해 뽑을 수 있고 뽑은 영역을 지워도 원본 도면은 그대로 남습니다. 새 영역 안에서 찍은 핀은 원본 도면 좌표로 그대로 저장되므로 원본과 영역 어느 쪽에서 봐도 같은 자리에 있습니다.",
      "zone-assign": "영역 지정 — 핀을 특정 구역(zone)에 소속시켜 도면이 복잡해도 구역별로 찾아보기 쉽게 정리합니다.",
      "photo-batch": "사진 폴더 일괄 매칭 — 핀을 순서대로 찍은 뒤 사진이 담긴 폴더를 선택하면, 촬영 시각 순서대로 핀 번호에 자동으로 1:1 매칭됩니다.",
      "deploy-viewer": "뷰어로 배포 — 지금까지 작업한 도면·핀·영역을 열람 전용 링크로 만들어 다른 사람과 공유합니다(공유받은 사람은 로그인 없이 볼 수 있습니다).",
      "orientation-fix": "방향 보정 — 360° 파노라마가 실제 도면 방향과 다르게 찍혔을 때, 회전시켜 도면 방향과 맞춥니다.",
      "checkerboard": "등록 방식 — [번호 먼저]는 탭할 때마다 번호 핀만 1번부터 순서대로 찍고 사진은 나중에 사진 폴더·촬영 세션으로 한꺼번에 넣습니다. [바로 사진]은 탭할 때마다 번호 핀을 찍고 곧바로 사진 선택창을 엽니다. 상단 토글이나 설정에서 바꾸며 구역마다 따로 기억합니다(기본 = 번호 먼저). 핀은 하나이고 상태는 사진 유무로 보입니다.",
      "checkboard-renumber": "번호 일괄 변경 — 누르면 새 시작 번호를 물어보고, 이 페이지의 핀 전체를 현재 순서 그대로 그 번호부터 다시 매깁니다(예: 1~40번 → 시작번호 101 입력 시 101~140번). 사진·노트는 번호가 아니라 핀 자체에 연결돼 있어 번호가 바뀌어도 그대로 유지됩니다. 번호 하나만 고치려면 핀을 눌러 '위치명/번호' 칸에서 직접 바꾸세요(이미 쓰는 번호로는 바꿀 수 없습니다).",
      "radar-zoom": "미니맵 도면 확대 — +/− 버튼, 두 손가락 핀치, 더블탭(더블클릭)으로 미니맵 안의 도면만 1~6배 확대/축소합니다. 패널 크기는 그대로 유지되고, 확대해도 현재 위치가 항상 중앙에 표시됩니다.",
      "offline-download": "오프라인 다운로드 — 이 프로젝트의 도면(PDF/이미지)과 배치된 핀, 그리고 핀에 연결된 360° 파노라마 사진을 전부 이 기기에 내려받습니다. 다운로드가 끝나면 인터넷이 끊긴 현장에서도 도면과 360° 사진을 그대로 열람하고 작업할 수 있고, 나중에 인터넷이 다시 연결되면 자동으로 서버와 동기화됩니다. 버튼에 '저장됨'이 표시되면 이미 내려받아 오프라인 사용 준비가 된 상태입니다.",
      "pin-mobile-photo-only": "모바일에서는 사진만 등록할 수 있습니다(화면이 좁아 사진 등록에 집중). 360° 사진·문서·노트·동영상·URL 첨부는 PC(데스크톱)에서 추가하세요. 이미 등록된 다른 종류의 첨부는 모바일에서도 그대로 보이고 열람됩니다.",
      "apk-install": "안드로이드 앱 설치(APK) — 안드로이드 휴대폰에서 SEASTAR 360 앱 파일을 내려받아 설치합니다. 사내 배포 앱이라 Play 스토어를 거치지 않아 Chrome·설치 화면·Play 프로텍트(삼성은 보안 위험 자동 차단 포함)가 보안 경고를 띄우며, 안내 팝업이 화면마다 무엇을 눌러야 하는지 그림으로 보여 줍니다. 내려받은 파일이 진짜인지는 안내 첫 화면의 버전·크기·SHA-256 지문으로 확인하세요. iPhone 은 해당 없음 — 공유 버튼의 '홈 화면에 추가'를 쓰세요.",
      "invite-share": "초대 링크 공유 —누르면 폰의 공유 시트가 열려 카카오톡 등 원하는 앱으로 바로 보낼 수 있습니다. PC 등 지원하지 않는 환경에서는 자동으로 링크가 복사됩니다.",
      "ai-analyze": "AI 사진 분석 — 360 사진을 AI가 읽어 장비·결함·위험 후보를 태깅하고, 이전 사진이 있으면 달라진 점을 요약합니다. 신뢰도 70% 미만은 「추정」으로 표시되고, 위치가 잡힌 항목은 360 안에 임시 마커로 볼 수 있습니다. [결함으로 등록]은 결함 작성 폼을 미리 채울 뿐이며 사람이 [등록]을 눌러야 저장됩니다(AI 자동 등록 없음). 디자이너 전용 · 온라인에서만 · Cloudflare Workers AI 무료 할당량 안에서만 동작해 비용이 들지 않으며(유료 전환 없음), 사용자당 하루 30회, 전체 무료 할당이 소진되면 '오늘 무료 사용량 소진 — 내일 다시'로 비활성됩니다. 같은 사진은 캐시로 다시 계산하지 않습니다.",
      "qr-tag": "QR 위치 태그 — 핀 팝업 [QR] 또는 구역 ⋯ → [이 구역 QR 일괄 인쇄]로 A4 한 장에 여러 칸의 QR 을 인쇄해 현장 구획에 붙입니다. 폰 기본 카메라로 찍으면 그 프로젝트·구역이 열리고 해당 포인트가 가운데 강조되며 팝업이 뜹니다. 로그인·권한 확인은 평소와 똑같이 거칩니다(QR 자체는 권한을 주지 않습니다).",
      "coverage": "촬영 현황 — 도면 필터 바의 [◔ 촬영 현황]을 켜면 포인트마다 최신 촬영 시각으로 ✕미촬영 / !오래됨(기준일 초과, 기본 14일 — 프로젝트 정보에서 변경) / ✓최신 / ?시각 미상 배지와 색 링이 붙고, 트리와 전체 포인트 패널에 구역별 개수가 나옵니다. 번호만 찍은 포인트는 ✕미촬영으로 보여 일괄 등록할 남은 곳을 바로 알 수 있습니다.",
      "deck-source-select": "구역 생성 방식 선택 — '+ 구역 생성'을 누르면 이 구역의 도면을 어떻게 마련할지 고를 수 있습니다. ① 기존 도면에서 영역 지정: 지금 열려 있는 도면 위에서 원하는 부분을 드래그로 긁으면, 원본은 그대로 둔 채 그 부분만 보이는 새 구역이 만들어집니다(도면 영역 추출과 동일 기능). ② 새 도면 파일 업로드: PDF·이미지 파일을 새로 올려 그 파일을 이 구역의 도면으로 씁니다. 지금 열려 있는 도면이 없으면 ①은 고를 수 없고 그 이유가 안내됩니다."
    },

    /* [WO 20261001-viewerhelp] 뷰어 배포 화면(role-viewer)용 도움말 — SoT 는 이 배열 하나.
     * 편집 전용 기능(핀 생성/삭제/정렬/합치기 등, 위 CONTENT 의 data-help 배지 체계)은
     * 뷰어에는 그 대상 요소 자체가 DOM 에 없어 애초에 노출되지 않는다 — 여기서는 열람자가
     * 실제로 쓰는 조작만 별도 패널(토글 클릭 시 전체 패널)로 보여준다. */
    VIEWER_SECTIONS: [
      { title: "도면 이동·확대", body: "손가락 두 개로 벌리거나 마우스 휠로 도면을 확대/축소합니다. 한 손가락 드래그(마우스는 클릭 드래그)로 도면을 이동합니다." },
      { title: "핀 상태", body: "핀은 한 종류입니다. 속이 찬 핀은 사진(360°)이 연결된 지점으로 탭하면 360° 뷰어가 열리고, 속이 빈 점선 핀은 번호만 있는 지점입니다. 도면 위 [전체 / 사진 있음 / 사진 없음] 필터로 골라 볼 수 있습니다." },
      { title: "360° 뷰어 조작", body: "화면을 드래그해 둘러보고 두 손가락(또는 휠)으로 확대/축소합니다. 미니맵에서 현재 위치·꼭지점을 확인하고 다른 지점을 눌러 이동할 수 있습니다. 전체화면 버튼으로 크게 보고, 닫기(X) 또는 ESC 키로 돌아갑니다." },
      { title: "구역 찾기(트리)", body: "좌측 트리는 프로젝트 → 구역 → 영역 → 포인트 순서로 구성됩니다(사진 필터를 따라 보입니다). 원하는 항목을 누르면 바로 그 위치로 이동합니다." },
      { title: "앱 설치", body: "브라우저 메뉴에서 '홈 화면에 추가'를 선택하면 아이콘으로 설치해 앱처럼 바로 열 수 있습니다." }
    ],

    _inited: false,
    active: false,        // 도움말 모드 on/off
    _toggleBtn: null,
    _badges: [],           // [{ badge, target }]
    _popup: null,
    _hideTimer: null,
    viewerPanelOpen: false,     // [WO 20261001-viewerhelp] 뷰어 패널 열림 상태
    _viewerPanelEl: null,
    _inquiryEl: null,
    _inquiryEntryBtn: null,

    /** 정본에서 값을 읽는다. 키가 없으면 undefined(조용한 대체값 날조 금지). */
    get(key) {
      if (Object.prototype.hasOwnProperty.call(this.CONTENT, key)) return this.CONTENT[key];
      // [WO 20261002-allmenu §3] 문구 SoT 공유 — 전체 기능 메뉴(45_FeatureMenu.FEATURES)의 id 도 도움말 키로 쓸 수 있다
      //   (`data-help="align-v"` 등). 그 설명은 메뉴 정의 한 곳에서만 온다(복제 금지).
      try {
        if (typeof FeatureMenu !== "undefined" && FeatureMenu._f) {
          const f = FeatureMenu._f(key);
          const d = f ? FeatureMenu.descOf(f) : "";
          if (f && d) return f.label + " — " + d + (f.keys ? " (단축키 " + f.keys + ")" : "");
        }
      } catch (e) {}
      return undefined;
    },

    /** [WO 20261001-viewerhelp] 뷰어 배포 화면인지 — SoT: body.role-viewer 클래스(20_App.js openApp 가
     *  유일하게 세팅). 이 모듈은 그 값을 읽기만 한다(값을 새로 만들지 않음 — SoT 1개). */
    _isViewerRole() {
      try { return !!(document.body && document.body.classList && document.body.classList.contains("role-viewer")); }
      catch (e) { return false; }
    },

    init() {
      if (this._inited) return;
      this._inited = true;
      this._createToggle();
      this._createInquiryEntryBtn();
      document.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        this.hide();
        this.closeInquiry();
        this.closeViewerPanel();
      });
      window.addEventListener("scroll", () => { if (this.active) this._reposition(); }, true);
      window.addEventListener("resize", () => { if (this.active) this._reposition(); });
    },

    /** 화면에 항상 보이는 "?" 토글 — 도움말 체계의 존재 자체를 알리는 유일한 진입점. */
    _createToggle() {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.setAttribute("data-help-toggle", "1");
      btn.setAttribute("aria-label", "도움말 모드 켜기/끄기");
      btn.setAttribute("aria-pressed", "false");
      btn.textContent = "?";
      btn.style.cssText = this._toggleStyle(false);
      btn.addEventListener("click", (e) => {
        if (e.preventDefault) e.preventDefault();
        if (e.stopPropagation) e.stopPropagation();
        this.toggle();
      });
      document.body.appendChild(btn);
      this._toggleBtn = btn;
    },

    _toggleStyle(isActive) {
      return [
        "position:fixed", "left:16px", "bottom:16px", "width:40px", "height:40px",
        "border-radius:50%", "border:none", "cursor:pointer", "z-index:9550",
        "display:flex", "align-items:center", "justify-content:center",
        "font-size:18px", "font-weight:700", "font-family:sans-serif",
        "box-shadow:0 4px 14px rgba(0,0,0,.3)",
        isActive ? "background:#c9962a" : "background:#1a1712",
        isActive ? "color:#1a1712" : "color:#ffffff"
      ].join(";");
    },

    /** [WO 20261001-viewerhelp] 뷰어 배포 화면에서는 data-help 배지 대상 요소 자체가 없으므로
     *  배지 모드 대신 역할별 섹션을 담은 패널을 연다(판정 기준 1 — 역할별 분기, 편집 기능 자동 숨김:
     *  편집 전용 버튼이 뷰어 DOM 에 없어 애초에 노출되지 않는다). 편집 화면은 종전 배지 토글 그대로. */
    toggle() {
      if (this._isViewerRole()) { this.viewerPanelOpen ? this.closeViewerPanel() : this.openViewerPanel(); return; }
      this.active ? this.disable() : this.enable();
    },

    /** [지휘자 발주 2026-09-29 항목2] 🔴 다른 화면의 플로팅 패널(예: 27_PinActionPop.js 핀 패널)이
     *  이 좌하단 토글과 겹칠 때 호출해 숨긴다/되돌린다(38_Install.js isEditorScreenActive 와 동일
     *  관례 — 겹치는 상시 UI 는 그 화면이 떠 있는 동안만 숨긴다). display 속성만 건드려 다른
     *  스타일(_toggleStyle 로 이미 적용된 색상/위치 등)은 그대로 유지한다. */
    setVisible(visible) {
      if (this._toggleBtn) this._toggleBtn.style.display = visible ? "flex" : "none";
      if (this._inquiryEntryBtn) this._inquiryEntryBtn.style.display = visible ? "flex" : "none";
    },

    /* ══ [WO 20261001-viewerhelp] 뷰어 전용 도움말 패널 ══════════════════════════ */
    openViewerPanel() {
      this.closeViewerPanel();
      if (this._toggleBtn) { this._toggleBtn.setAttribute("aria-pressed", "true"); this._toggleBtn.style.cssText = this._toggleStyle(true); }

      const backdrop = document.createElement("div");
      backdrop.setAttribute("data-help-viewer-backdrop", "1");
      backdrop.style.cssText = [
        "position:fixed", "inset:0", "background:rgba(0,0,0,.55)", "z-index:99990",
        "display:flex", "align-items:flex-end", "justify-content:center"
      ].join(";");
      backdrop.addEventListener("click", (e) => { if (e.target === backdrop) this.closeViewerPanel(); });

      const panel = document.createElement("div");
      panel.setAttribute("data-help-viewer-panel", "1");
      panel.style.cssText = [
        "position:relative", "width:100%", "max-width:480px", "max-height:80vh", "overflow-y:auto",
        "background:#1a1712", "color:#ffffff", "border-radius:16px 16px 0 0", "padding:20px",
        "box-sizing:border-box", "font-family:sans-serif"
      ].join(";");

      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.textContent = "닫기";
      closeBtn.setAttribute("aria-label", "도움말 닫기");
      closeBtn.style.cssText = "position:absolute;top:12px;right:12px;background:transparent;border:1px solid #665;color:#ffffff;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px";
      closeBtn.addEventListener("click", () => this.closeViewerPanel());
      panel.appendChild(closeBtn);

      const h = document.createElement("h3");
      h.textContent = "사용 안내";
      h.style.cssText = "margin:0 0 14px;font-size:17px;color:#ffffff;padding-right:60px";
      panel.appendChild(h);

      this.VIEWER_SECTIONS.forEach((sec) => {
        const wrap = document.createElement("div");
        wrap.style.cssText = "margin-bottom:14px";
        const t = document.createElement("div");
        t.textContent = sec.title;
        t.style.cssText = "font-weight:700;color:#c9962a;margin-bottom:4px;font-size:13.5px";
        const b = document.createElement("div");
        b.textContent = sec.body;
        b.style.cssText = "font-size:13px;line-height:1.6;color:#f2ede1";
        wrap.appendChild(t);
        wrap.appendChild(b);
        panel.appendChild(wrap);
      });

      const hr = document.createElement("div");
      hr.style.cssText = "border-top:1px solid rgba(255,255,255,.15);margin:14px 0";
      panel.appendChild(hr);

      // [WO 20261011-viewmode] 그림으로 보는 설명서(매뉴얼) — 링크 모드(State.viewMode)에 맞는 쪽을 연다.
      {
        const manBtn = document.createElement("button");
        manBtn.type = "button";
        manBtn.textContent = "그림으로 보는 설명서(매뉴얼)";
        manBtn.setAttribute("data-help-manual-open", "1");
        manBtn.style.cssText = "width:100%;padding:12px;margin:0 0 8px;border:1px solid #6b7280;border-radius:10px;background:transparent;color:#e5e7eb;font-weight:700;font-size:14px;cursor:pointer";
        manBtn.addEventListener("click", () => {
          const vm = (typeof State !== "undefined" && State.viewMode) || null;
          window.open(vm === "360" ? "/manual/viewer-360.html" : "/manual/viewer-checker.html", "_blank");
        });
        panel.appendChild(manBtn);
      }

      // [WO 20261001-viewreq] 핀 없는(도면/구역 단위) 요청 진입 — 디자이너에게 가는 요청은 개발자 문의와 별개다.
      if (typeof Requests !== "undefined" && Requests.openViewer) {
        const reqBtn = document.createElement("button");
        reqBtn.type = "button";
        reqBtn.textContent = "디자이너에게 요청·질문 (이 도면)";
        reqBtn.setAttribute("data-help-request-open", "1");
        reqBtn.style.cssText = "width:100%;padding:12px;margin:0 0 8px;border:1px solid #c9962a;border-radius:10px;background:transparent;color:#f7d98a;font-weight:700;font-size:14px;cursor:pointer";
        reqBtn.addEventListener("click", () => { this.closeViewerPanel(); Requests.openViewer({}); });
        panel.appendChild(reqBtn);
      }

      const inquiryBtn = document.createElement("button");
      inquiryBtn.type = "button";
      inquiryBtn.textContent = "개발자에게 문의";
      inquiryBtn.setAttribute("data-help-inquiry-open", "1");
      inquiryBtn.style.cssText = "width:100%;padding:12px;border:none;border-radius:10px;background:#c9962a;color:#1a1712;font-weight:700;font-size:14px;cursor:pointer";
      inquiryBtn.addEventListener("click", () => this.openInquiry());
      panel.appendChild(inquiryBtn);

      backdrop.appendChild(panel);
      document.body.appendChild(backdrop);
      this._viewerPanelEl = backdrop;
      this.viewerPanelOpen = true;
    },

    closeViewerPanel() {
      if (this._viewerPanelEl && this._viewerPanelEl.parentNode) this._viewerPanelEl.parentNode.removeChild(this._viewerPanelEl);
      this._viewerPanelEl = null;
      this.viewerPanelOpen = false;
      if (this._toggleBtn) { this._toggleBtn.setAttribute("aria-pressed", "false"); this._toggleBtn.style.cssText = this._toggleStyle(false); }
    },

    /* ══ [WO 20261001-viewerhelp] 개발자 문의 — 편집 화면·뷰어 화면 공용(둘 다 "?" 옆 "✉" 버튼으로 진입,
     *  뷰어는 도움말 패널 하단에서도 진입). 로그인 여부와 무관하게 보낼 수 있다(서버가 열람전용 세션도 허용). ══ */
    _createInquiryEntryBtn() {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.setAttribute("data-help-inquiry-toggle", "1");
      btn.setAttribute("aria-label", "개발자에게 문의");
      btn.textContent = "✉";
      btn.style.cssText = [
        "position:fixed", "left:64px", "bottom:16px", "width:40px", "height:40px",
        "border-radius:50%", "border:none", "cursor:pointer", "z-index:9550",
        "display:flex", "align-items:center", "justify-content:center",
        "font-size:16px", "font-family:sans-serif", "box-shadow:0 4px 14px rgba(0,0,0,.3)",
        "background:#1a1712", "color:#ffffff"
      ].join(";");
      btn.addEventListener("click", (e) => {
        if (e.preventDefault) e.preventDefault();
        if (e.stopPropagation) e.stopPropagation();
        this.openInquiry();
      });
      document.body.appendChild(btn);
      this._inquiryEntryBtn = btn;
    },

    /** 현재 화면 정보 자동 첨부용 컨텍스트 — State/스크립트 태그에서 읽기만 한다(값을 새로 만들지 않음). */
    _gatherContext() {
      const ctx = { project_name: null, deployment_id: null, mode: null, app_version: null };
      try {
        if (typeof State !== "undefined" && State) {
          ctx.project_name = State.currentProjectName || null;
          ctx.deployment_id = State.currentDeploymentId || null;
          ctx.mode = State.mode || null;
        }
      } catch (e) { /* State 미정의 환경(테스트 등) — 조용히 비워둠 */ }
      try {
        const s = document.querySelector('script[src*="main.js"]');
        if (s && s.src) {
          const m = String(s.src).match(/[?&]v=([^&]+)/);
          ctx.app_version = m ? m[1] : null;
        }
      } catch (e) { /* 조회 불가 환경 — 비워둠 */ }
      return ctx;
    },

    _fieldStyle() {
      return "width:100%;box-sizing:border-box;padding:10px;margin-bottom:4px;border-radius:8px;border:1px solid #554;background:#2a2518;color:#ffffff;font-size:13.5px;font-family:sans-serif";
    },

    _fieldLabel(text) {
      const l = document.createElement("div");
      l.textContent = text;
      l.style.cssText = "font-size:11.5px;color:#cbbfa0;margin-bottom:4px";
      return l;
    },

    openInquiry() {
      this.closeInquiry();
      const backdrop = document.createElement("div");
      backdrop.setAttribute("data-help-inquiry-backdrop", "1");
      backdrop.style.cssText = [
        "position:fixed", "inset:0", "background:rgba(0,0,0,.6)", "z-index:100000",
        "display:flex", "align-items:center", "justify-content:center", "padding:16px", "box-sizing:border-box"
      ].join(";");
      backdrop.addEventListener("click", (e) => { if (e.target === backdrop) this.closeInquiry(); });

      const panel = document.createElement("div");
      panel.setAttribute("data-help-inquiry-form", "1");
      panel.style.cssText = [
        "width:100%", "max-width:420px", "max-height:90vh", "overflow-y:auto",
        "background:#1a1712", "color:#ffffff", "border-radius:14px", "padding:20px",
        "box-sizing:border-box", "font-family:sans-serif"
      ].join(";");

      const h = document.createElement("h3");
      h.textContent = "개발자에게 문의";
      h.style.cssText = "margin:0 0 12px;font-size:16px";
      panel.appendChild(h);

      panel.appendChild(this._fieldLabel("제목"));
      const titleInput = document.createElement("input");
      titleInput.type = "text";
      titleInput.placeholder = "무엇이 궁금하거나 불편하신가요?";
      titleInput.setAttribute("data-help-inquiry-title", "1");
      titleInput.style.cssText = this._fieldStyle();
      panel.appendChild(titleInput);

      panel.appendChild(this._fieldLabel("내용"));
      const bodyInput = document.createElement("textarea");
      bodyInput.placeholder = "내용을 자세히 적어주세요";
      bodyInput.setAttribute("data-help-inquiry-body", "1");
      bodyInput.rows = 5;
      bodyInput.style.cssText = this._fieldStyle() + ";resize:vertical;min-height:100px";
      panel.appendChild(bodyInput);

      panel.appendChild(this._fieldLabel("회신 받을 이메일(선택)"));
      const emailInput = document.createElement("input");
      emailInput.type = "email";
      emailInput.placeholder = "example@company.com";
      emailInput.setAttribute("data-help-inquiry-email", "1");
      emailInput.style.cssText = this._fieldStyle();
      panel.appendChild(emailInput);

      const ctx = this._gatherContext();
      const ctxNote = document.createElement("div");
      ctxNote.textContent = "자동 첨부: " + (ctx.project_name || "프로젝트 미지정") + " · " + (ctx.mode || "모드 미상") + (ctx.deployment_id ? (" · " + ctx.deployment_id) : "");
      ctxNote.style.cssText = "font-size:11px;color:#9c927c;margin:2px 0 12px";
      panel.appendChild(ctxNote);

      const errEl = document.createElement("div");
      errEl.setAttribute("data-help-inquiry-error", "1");
      errEl.style.cssText = "font-size:12.5px;color:#ff8a8a;margin-bottom:8px;display:none";
      panel.appendChild(errEl);

      const btnRow = document.createElement("div");
      btnRow.style.cssText = "display:flex;gap:8px;margin-top:4px";
      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.textContent = "취소";
      cancelBtn.style.cssText = "flex:1;padding:10px;border-radius:8px;border:1px solid #665;background:transparent;color:#ffffff;cursor:pointer";
      cancelBtn.addEventListener("click", () => this.closeInquiry());
      const sendBtn = document.createElement("button");
      sendBtn.type = "button";
      sendBtn.textContent = "보내기";
      sendBtn.setAttribute("data-help-inquiry-send", "1");
      sendBtn.style.cssText = "flex:1;padding:10px;border-radius:8px;border:none;background:#c9962a;color:#1a1712;font-weight:700;cursor:pointer";
      sendBtn.addEventListener("click", () => this._submitInquiry({ titleInput, bodyInput, emailInput, errEl, sendBtn, ctx }));
      btnRow.appendChild(cancelBtn);
      btnRow.appendChild(sendBtn);
      panel.appendChild(btnRow);

      backdrop.appendChild(panel);
      document.body.appendChild(backdrop);
      this._inquiryEl = backdrop;
    },

    closeInquiry() {
      if (this._inquiryEl && this._inquiryEl.parentNode) this._inquiryEl.parentNode.removeChild(this._inquiryEl);
      this._inquiryEl = null;
    },

    /** 서버 POST /api/inquiries 호출. 성공·실패 어느 쪽이든 사용자에게 조용히 넘어가지 않는다. */
    async _submitInquiry(f) {
      const title = (f.titleInput.value || "").trim();
      const body = (f.bodyInput.value || "").trim();
      const replyEmail = (f.emailInput.value || "").trim();
      const showErr = (msg) => { f.errEl.textContent = msg; f.errEl.style.display = "block"; };
      if (!title || !body) { showErr("제목과 내용을 입력하세요."); return; }

      f.sendBtn.disabled = true;
      const prevLabel = f.sendBtn.textContent;
      f.sendBtn.textContent = "보내는 중…";
      try {
        const headers = { "Content-Type": "application/json" };
        try { if (typeof Auth !== "undefined" && Auth.headers) Object.assign(headers, Auth.headers()); } catch (e) { /* 비로그인 — 헤더 없이 전송 */ }
        const res = await fetch("/api/inquiries", {
          method: "POST",
          headers,
          body: JSON.stringify({
            title, body, reply_email: replyEmail || undefined,
            context: { project_name: f.ctx.project_name, deployment_id: f.ctx.deployment_id, mode: f.ctx.mode, app_version: f.ctx.app_version }
          })
        });
        const j = await res.json().catch(() => ({}));
        if (res.status === 429) { showErr(j.error || "잠시 후 다시 시도해 주세요."); return; }
        if (!res.ok || !j.success) { showErr(j.error || "문의 접수에 실패했습니다."); return; }
        this.closeInquiry();
        try { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("문의가 접수되었습니다. 감사합니다."); } catch (e) { /* 토스트 미정의 환경 */ }
      } catch (e) {
        showErr("네트워크 오류로 전송하지 못했습니다. 잠시 후 다시 시도하세요.");
      } finally {
        f.sendBtn.disabled = false;
        f.sendBtn.textContent = prevLabel;
      }
    },

    /** 도움말 모드 ON — data-help 요소마다 눈에 보이는 "?" 배지를 붙인다. */
    enable() {
      this.active = true;
      if (this._toggleBtn) {
        this._toggleBtn.setAttribute("aria-pressed", "true");
        this._toggleBtn.style.cssText = this._toggleStyle(true);
      }
      this._mountBadges();
    },

    /** 도움말 모드 OFF — 배지를 전부 제거해 평소 화면으로 복귀한다. */
    disable() {
      this.active = false;
      if (this._toggleBtn) {
        this._toggleBtn.setAttribute("aria-pressed", "false");
        this._toggleBtn.style.cssText = this._toggleStyle(false);
      }
      this._unmountBadges();
      this.hide();
    },

    _mountBadges() {
      this._unmountBadges();
      const targets = document.querySelectorAll("[data-help]");
      for (let i = 0; i < targets.length; i++) {
        const el = targets[i];
        const badge = document.createElement("button");
        badge.type = "button";
        badge.setAttribute("data-help-badge", "1");
        badge.setAttribute("aria-label", "도움말 보기");
        badge.textContent = "?";
        badge.style.cssText = [
          "position:fixed", "width:18px", "height:18px", "border-radius:50%",
          "border:1.5px solid #ffffff", "background:#1a1712", "color:#ffffff",
          "font-size:11px", "font-weight:700", "line-height:1", "padding:0",
          "cursor:pointer", "z-index:99997", "display:flex", "align-items:center",
          "justify-content:center", "box-shadow:0 2px 6px rgba(0,0,0,.35)", "font-family:sans-serif"
        ].join(";");
        badge.addEventListener("click", (e) => {
          // 배지는 대상 요소의 자식이 아니라 body 에 별도로 붙는 독립 엘리먼트라
          // 원래 버튼의 클릭 핸들러가 구조적으로 실행되지 않는다. stopPropagation/
          // preventDefault 는 방어적 이중 안전장치다(요구: 원래 동작 차단).
          if (e.preventDefault) e.preventDefault();
          if (e.stopPropagation) e.stopPropagation();
          this.show(el, el.dataset ? el.dataset.help : el.getAttribute("data-help"));
        });
        document.body.appendChild(badge);
        this._badges.push({ badge, target: el });
      }
      this._reposition();
    },

    _unmountBadges() {
      this._badges.forEach(({ badge }) => { if (badge.parentNode) badge.parentNode.removeChild(badge); });
      this._badges = [];
    },

    _reposition() {
      this._badges.forEach(({ badge, target }) => {
        const rect = (target && target.getBoundingClientRect) ? target.getBoundingClientRect() : { left: 0, top: 0, width: 0 };
        badge.style.left = Math.max(0, rect.left + rect.width - 9) + "px";
        badge.style.top = Math.max(0, rect.top - 9) + "px";
      });
    },

    /** 도움말 팝업을 el 근처에 띄운다. content 없는 키는 "준비 중"으로 표시(조용한 실패 금지). */
    show(el, key) {
      this.hide();
      const content = this.get(key);
      const isPlaceholder = content == null;
      const text = isPlaceholder
        ? "[도움말 준비 중] 이 항목의 설명은 아직 작성되지 않았습니다."
        : content;
      if (isPlaceholder && typeof console !== "undefined" && console.warn) {
        console.warn("[Help] 정의되지 않은 도움말 키:", key);
      }

      const pop = document.createElement("div");
      pop.setAttribute("data-help-popup", "1");
      pop.setAttribute("role", "tooltip");
      pop.textContent = text;
      pop.style.cssText = [
        "position:fixed", "max-width:280px", "padding:10px 14px",
        "background:#1a1712", "color:#ffffff", "font-size:13px", "line-height:1.5",
        "border-radius:8px", "box-shadow:0 6px 20px rgba(0,0,0,.35)",
        "z-index:99999", "pointer-events:none", "font-family:sans-serif",
        isPlaceholder ? "font-style:italic" : "font-style:normal",
        "opacity:0.98"
      ].join(";");
      document.body.appendChild(pop);

      const rect = (el && el.getBoundingClientRect) ? el.getBoundingClientRect() : { left: 12, top: 12, bottom: 12, width: 0 };
      let left = rect.left, top = rect.bottom + 8;
      const vw = (typeof window !== "undefined" && window.innerWidth) || 1024;
      const vh = (typeof window !== "undefined" && window.innerHeight) || 768;
      const POP_W = 280;
      if (left + POP_W > vw - 8) left = Math.max(8, vw - POP_W - 8);
      if (top > vh - 60) top = Math.max(8, rect.top - 68);
      pop.style.left = left + "px";
      pop.style.top = top + "px";

      this._popup = pop;
      this._hideTimer = setTimeout(() => this.hide(), 6000);
      return pop;
    },

    hide() {
      if (this._hideTimer) { clearTimeout(this._hideTimer); this._hideTimer = null; }
      if (this._popup && this._popup.parentNode) this._popup.parentNode.removeChild(this._popup);
      this._popup = null;
    }
  };

  document.addEventListener("DOMContentLoaded", () => Help.init());
