  /* ── 진입 ── */
  document.addEventListener("DOMContentLoaded", () => {
    App.init();

    // [오프라인 작업지시서 ❼] 오프라인 상태 배지/네트워크 이벤트 연결
    if (typeof Offline !== "undefined" && Offline.init) { try { Offline.init(); } catch (e) {} }

    // ── E2E 테스트 훅 (프로덕션 무해): 핀을 직접 주입해 UI 워크플로우 없이 검증 ──
    window.__wm = {
      State, App, AllPins, UI, MapCtrl, Auth, Settings, PinPrefs, Designers, Projects, ProjectHub, Prompt, PanoViewer, Radar, PanoNav, Brand, Notes, TimeLapse, Compare, Zones, Inspector, PinGrid, SyncQueue, Cloud, PDF, FLS, PinActionPop, CompanyAuth, PdfAnno, AdminPanels,
      Offline, OfflineBundle, OfflineLoad, OpLog,
      addPin(p) {
        const pin = Object.assign({ id: "t" + Date.now() + Math.random().toString(36).slice(2,6), x: 50, y: 50, page: 1, label: "Pin" }, p);
        State.pins.push(pin);
        UI.renderPinList(); UI.renderPinsOnMap();
        return pin.id;
      }
    };

    const params  = new URLSearchParams(location.search);
    const urlMode = params.get("mode");
    const depId   = params.get("d");
    if (urlMode === "viewer" || depId) {
      // 배포 링크(?mode=viewer / ?d=배포ID) — 특정 배포본 바로 뷰어 (허브 스킵)
      State.viewerLocked = true;
      App.openApp("viewer");
    } else if (urlMode === "designer") {
      // 설계자 직접 진입 — 로그인+디자이너 권한 필요, 통과 시 프로젝트 허브로
      Auth.requireDesigner(() => ProjectHub.open());
      ProjectHub.open();
    } else {
      // ── 첫 화면 = 프로젝트 선택 대시보드 (상용툴 모방) ──
      //   카드 클릭 → (디자이너)편집 / (그 외)뷰어. 디자이너는 +새 프로젝트.
      ProjectHub.open();
    }

    /* ── 360° 테스트 훅: ?demo360=<이미지URL> 로 파노라마 직접 오픈 ── */
    const demo = params.get("demo360");
    if (demo) {
      PanoViewer.loadMedia(decodeURIComponent(demo), "TEST PANORAMA");
    }
  });

})();
