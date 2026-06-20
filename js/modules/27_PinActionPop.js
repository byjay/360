  const PinActionPop = {
    _pinId: null,
    init() {
      const $ = (id) => document.getElementById(id);
      const el = $("pin-action-pop");
      if (!el) return;
      $("pap-close") && $("pap-close").addEventListener("click", () => this.close());
      const bd = el.querySelector(".pin-action-backdrop");
      bd && bd.addEventListener("click", () => this.close());
      $("pap-view") && $("pap-view").addEventListener("click", () => {
        const pin = this._pin(); if (!pin) return;
        this.close();
        if (App.pinHasContent(pin)) App.openPano(pin);
        else { App.focusPin(pin, false); if (typeof Inspector !== "undefined") Inspector.showPin(pin); }
      });
      $("pap-move") && $("pap-move").addEventListener("click", () => {
        const pin = this._pin(); if (!pin) return;
        State.pinEditUnlocked = pin.id;
        this.close();
        UI.renderPinsOnMap();
        const m = document.querySelector('.pin-marker[data-id="' + pin.id + '"]');
        if (m) m.classList.add("edit-unlocked");
        Prompt.toast && Prompt.toast("🔓 '" + (pin.label || ("#" + (pin.page||1))) + "' 이동 잠금 해제 — 도면에서 핀을 드래그하세요");
      });
      $("pap-edit") && $("pap-edit").addEventListener("click", () => {
        const pin = this._pin(); if (!pin) return;
        State.pinEditUnlocked = pin.id;
        this.close();
        App.editPin(pin.id);
      });
      $("pap-del") && $("pap-del").addEventListener("click", () => {
        const pin = this._pin(); if (!pin) return;
        this.close();
        App.deletePin(pin.id);
      });
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !el.classList.contains("hidden")) this.close();
      });
    },
    _pin() { return (State.pins || []).find(p => p.id === this._pinId) || null; },
    open(pinId) {
      const el = document.getElementById("pin-action-pop");
      if (!el) return;
      const pin = (State.pins || []).find(p => p.id === pinId);
      if (!pin) return;
      this._pinId = pinId;
      // 페이지 기준 번호 계산
      const page = pin.page || 1;
      const samePage = (State.pins || []).filter(p => (p.page || 1) === page);
      const no = samePage.indexOf(pin) + 1;
      const hasContent = App.pinHasContent(pin);
      const $ = (id) => document.getElementById(id);
      $("pap-no").textContent = "#" + (no > 0 ? no : "?");
      $("pap-title").textContent = pin.label && pin.label.trim() ? pin.label : ("포인트 " + no);
      const mediaTxt = hasContent ? "360° 미디어 있음" : "미디어 없음";
      const addrTxt = (pin.label && pin.label.trim()) ? pin.label : "위치명 없음";
      $("pap-meta").textContent = addrTxt + " · " + mediaTxt + " · " + page + "페이지";
      // 360° 보기 버튼은 미디어 있을 때 강조
      const viewBtn = $("pap-view");
      if (viewBtn) viewBtn.classList.toggle("dim", !hasContent);
      el.classList.remove("hidden");
    },
    close() {
      const el = document.getElementById("pin-action-pop");
      if (el) el.classList.add("hidden");
      this._pinId = null;
    }
  };

  /* ══════════════════════════════════════════
     ADMIN PANELS — 최상위 관리자: 기능/메뉴 관장 · AI 설정 · 코드맵
  ══════════════════════════════════════════ */
  // 이 프로젝트에서 켜고 끌 수 있는 기능 정의(키 = app_settings.features 의 키)
  const FEATURE_DEFS = [
    { key: "annotations", label: "PDF 주석(형광펜·도형·메모)", desc: "도면 위 주석 도구 모음" },
    { key: "zones",       label: "영역/구역 지정",            desc: "사각형·원·다각형 구역 그리기" },
    { key: "pin360",      label: "360° 파노라마 핀",          desc: "핀 클릭 시 360 뷰어 열기" },
    { key: "fls3d",       label: "3D 포인트 클라우드(FLS)",   desc: "FLS/E57/LAS 첨부·듀얼뷰" },
    { key: "ai",          label: "AI 도우미",                 desc: "에러·사용 가이드 LLM(키 설정 시)" },
    { key: "timelapse",   label: "타임랩스 비교",             desc: "동일 위치 시점 비교" },
    { key: "export",      label: "내보내기/배포",             desc: "JSON 내보내기·뷰어 배포" }
  ];
