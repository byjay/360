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
      "checkerboard": "체크보드 모드 — 버튼 한 번으로 핀을 1번부터 순서대로 연속 배치하는 빠른 입력 모드입니다.",
      "checkboard-renumber": "체크보드 번호 일괄 변경 — 누르면 새 시작 번호를 물어보고, 이 페이지의 체크보드 핀 전체를 현재 순서 그대로 그 번호부터 다시 매깁니다(예: 1~40번 → 시작번호 101 입력 시 101~140번). 사진·노트는 번호가 아니라 핀 자체에 연결돼 있어 번호가 바뀌어도 그대로 유지됩니다. 번호 하나만 고치려면 핀을 눌러 '위치명/번호' 칸에서 직접 바꾸세요(이미 쓰는 번호로는 바꿀 수 없습니다).",
      "radar-zoom": "미니맵 도면 확대 — +/− 버튼, 두 손가락 핀치, 더블탭(더블클릭)으로 미니맵 안의 도면만 1~6배 확대/축소합니다. 패널 크기는 그대로 유지되고, 확대해도 현재 위치가 항상 중앙에 표시됩니다.",
      "offline-download": "오프라인 다운로드 — 이 프로젝트의 도면(PDF/이미지)과 배치된 핀, 그리고 핀에 연결된 360° 파노라마 사진을 전부 이 기기에 내려받습니다. 다운로드가 끝나면 인터넷이 끊긴 현장에서도 도면과 360° 사진을 그대로 열람하고 작업할 수 있고, 나중에 인터넷이 다시 연결되면 자동으로 서버와 동기화됩니다. 버튼에 '저장됨'이 표시되면 이미 내려받아 오프라인 사용 준비가 된 상태입니다.",
      "pin-mobile-photo-only": "모바일에서는 사진만 등록할 수 있습니다(화면이 좁아 사진 등록에 집중). 360° 사진·문서·노트·동영상·URL 첨부는 PC(데스크톱)에서 추가하세요. 이미 등록된 다른 종류의 첨부는 모바일에서도 그대로 보이고 열람됩니다.",
      "invite-share": "초대 링크 공유 — 누르면 폰의 공유 시트가 열려 카카오톡 등 원하는 앱으로 바로 보낼 수 있습니다. PC 등 지원하지 않는 환경에서는 자동으로 링크가 복사됩니다."
    },

    _inited: false,
    active: false,        // 도움말 모드 on/off
    _toggleBtn: null,
    _badges: [],           // [{ badge, target }]
    _popup: null,
    _hideTimer: null,

    /** 정본에서 값을 읽는다. 키가 없으면 undefined(조용한 대체값 날조 금지). */
    get(key) {
      return Object.prototype.hasOwnProperty.call(this.CONTENT, key) ? this.CONTENT[key] : undefined;
    },

    init() {
      if (this._inited) return;
      this._inited = true;
      this._createToggle();
      document.addEventListener("keydown", (e) => { if (e.key === "Escape") this.hide(); });
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

    toggle() { this.active ? this.disable() : this.enable(); },

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
