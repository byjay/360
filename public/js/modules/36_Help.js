  /* ══════════════════════════════════════════════════════════════
     도움말(Help) 체계 — 마스터 지시: "항상 모든 메뉴마다 사용자 매뉴얼을 구현해"
     ────────────────────────────────────────────────────────────────
     [설계 방침 — 작게 시작] 버튼 259개에 개별 문서를 일일이 다는 대신, 재사용
     가능한 얇은 체계 하나만 둔다: 요소에 `data-help="키"` 를 달면 그 요소를 길게
     누르는(hold) 것만으로 근처에 도움말 팝업이 뜬다.

     트리거 방식 = Pointer Events 기반 "길게 누르기" 단일 방식.
       - 마우스(누르고 있기)·터치(길게 누르기)를 Pointer Events 하나로 통합 처리
         → 디자이너(PC, 마우스)·뷰어(모바일, 터치) 모두 별도 구현 없이 동일 코드로 커버.
       - 기존 `title` 속성(브라우저 기본 툴팁, 130개 이미 존재)은 절대 건드리지 않는다.
         이 레이어는 그 위에 "얹는" 것이지 대체가 아니다.
       - 클릭(짧게 누름)은 원래 버튼 동작 그대로 통과시킨다 — 길게 눌러 팝업이 뜬
         직후의 click 한 번만 억제해 버튼이 오작동(의도치 않은 실행)하지 않게 한다.

     SoT(정본) = 아래 `Help.CONTENT` 객체 하나. 도움말 문구를 다른 파일에 복제하지 않는다.
     내용이 없는 키는 조용히 무시하지 않고 "준비 중" 문구 + console.warn 으로 알린다
     (사용자에게는 오류로 보이지 않게, 개발자에게는 빠뜨린 키를 알 수 있게).

     🔴 반드시 `_manifest.txt` 에 등록해야 번들(main.js)에 포함된다(빠뜨리면 고아 모듈).
     🔴 새 CSS 규칙 추가 금지(style.css 는 다른 트랙이 점유 중) — 전부 인라인 스타일.
        색상은 var(--text) 등 테마 변수 대신 리터럴 hex 를 쓴다(이 앱은 다크토글이 없지만,
        p7-contrast.test.mjs 가 실측한 "OS 강제다크모드가 var() 텍스트만 밝게 재해석" 함정을
        원천 차단하기 위함 — 배경/글자 모두 고정 리터럴이면 그 함정 자체가 성립하지 않는다).
        대비: #ffffff on #1a1712 ≈ 18.7:1 (WCAG AAA 여유).
  ══════════════════════════════════════════════════════════════ */
  const Help = {
    // ── SoT: 도움말 문구 정본. 여기 한 곳에서만 관리한다 ──
    // 초기 8개(마스터 지정 핵심 메뉴). 나머지 버튼은 키를 비워두고 점진 확장한다.
    CONTENT: {
      "zone-create": "구역/영역 만들기 — 도면 위에서 사각형·원형·다각형 도구를 선택한 뒤 그리면, 그 안에 속한 핀들을 하나의 구역(영역)으로 묶어 관리할 수 있습니다.",
      "drawing-upload": "도면 등록 — PDF 또는 이미지(JPG/PNG) 파일을 업로드하면 그 위에 포인트(핀)를 찍을 수 있는 캔버스가 만들어집니다.",
      "pin-place": "포인트(핀) 찍기 — 도면 위 원하는 위치를 클릭하면 그 자리에 360° 파노라마를 연결할 핀이 생성됩니다.",
      "zone-assign": "영역 지정 — 핀을 특정 구역(zone)에 소속시켜 도면이 복잡해도 구역별로 찾아보기 쉽게 정리합니다.",
      "photo-batch": "사진 폴더 일괄 매칭 — 핀을 순서대로 찍은 뒤 사진이 담긴 폴더를 선택하면, 촬영 시각 순서대로 핀 번호에 자동으로 1:1 매칭됩니다.",
      "deploy-viewer": "뷰어로 배포 — 지금까지 작업한 도면·핀·영역을 열람 전용 링크로 만들어 다른 사람과 공유합니다(공유받은 사람은 로그인 없이 볼 수 있습니다).",
      "orientation-fix": "방향 보정 — 360° 파노라마가 실제 도면 방향과 다르게 찍혔을 때, 회전시켜 도면 방향과 맞춥니다.",
      "checkerboard": "체크보드 모드 — 버튼 한 번으로 핀을 1번부터 순서대로 연속 배치하는 빠른 입력 모드입니다."
    },

    _inited: false,
    _popup: null,
    _hideTimer: null,
    _downInfo: null,   // { x, y, el, timer }
    _shownAt: 0,       // 팝업을 띄운 시각(ms) — 직후 click 1회 억제용
    HOLD_MS: 480,
    MOVE_TOL: 10,
    SUPPRESS_CLICK_MS: 400,

    /** 정본에서 값을 읽는다. 키가 없으면 undefined(조용한 대체값 날조 금지). */
    get(key) {
      return Object.prototype.hasOwnProperty.call(this.CONTENT, key) ? this.CONTENT[key] : undefined;
    },

    init() {
      if (this._inited) return;
      this._inited = true;
      document.addEventListener("pointerdown", (e) => this._onDown(e));
      document.addEventListener("pointermove", (e) => this._onMove(e));
      document.addEventListener("pointerup", () => this._onUp());
      document.addEventListener("pointercancel", () => this._onUp());
      document.addEventListener("click", (e) => this._onClickCapture(e), true);
      document.addEventListener("keydown", (e) => { if (e.key === "Escape") this.hide(); });
      window.addEventListener("scroll", () => this.hide(), true);
      window.addEventListener("resize", () => this.hide());
    },

    _findHelpEl(target) {
      if (!target) return null;
      if (target.closest) return target.closest("[data-help]");
      // closest 미지원 환경 폴백(구형 목 DOM 등)
      let n = target;
      while (n) {
        if (n.dataset && n.dataset.help) return n;
        n = n.parentNode || null;
      }
      return null;
    },

    _onDown(e) {
      const el = this._findHelpEl(e.target);
      if (!el) return;
      const x = e.clientX || 0, y = e.clientY || 0;
      const timer = setTimeout(() => {
        this._shownAt = Date.now();
        this.show(el, el.dataset ? el.dataset.help : el.getAttribute("data-help"));
      }, this.HOLD_MS);
      this._downInfo = { x, y, el, timer };
    },

    _onMove(e) {
      if (!this._downInfo) return;
      const dx = Math.abs((e.clientX || 0) - this._downInfo.x);
      const dy = Math.abs((e.clientY || 0) - this._downInfo.y);
      if (dx > this.MOVE_TOL || dy > this.MOVE_TOL) {
        clearTimeout(this._downInfo.timer);
        this._downInfo = null;
      }
    },

    _onUp() {
      if (this._downInfo) { clearTimeout(this._downInfo.timer); this._downInfo = null; }
    },

    /** 길게 눌러 팝업이 막 뜬 경우, 뒤따르는 click 1회만 삼켜 버튼 오작동을 막는다.
     *  팝업이 떠 있는 상태에서 팝업 바깥을 클릭하면 닫는다. */
    _onClickCapture(e) {
      if (this._shownAt && (Date.now() - this._shownAt) < this.SUPPRESS_CLICK_MS) {
        this._shownAt = 0;
        if (e.preventDefault) e.preventDefault();
        if (e.stopPropagation) e.stopPropagation();
        return;
      }
      if (this._popup) {
        const insidePopup = e.target && e.target.closest && e.target.closest("[data-help-popup]");
        if (!insidePopup) this.hide();
      }
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
