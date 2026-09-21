  /* ── 진입 ── */
  document.addEventListener("DOMContentLoaded", async () => {
    // [버그①수정 2026-08-31] App.init()이 Auth.init()(데모 자동로그인)을 await하므로
    // 여기서도 await해 ProjectHub.open() 등 하위 로직이 로그인 완료 후 실행되게 한다.
    await App.init();

    // [오프라인 작업지시서 ] 오프라인 상태 배지/네트워크 이벤트 연결
    if (typeof Offline !== "undefined" && Offline.init) { try { Offline.init(); } catch (e) {} }

    // [P40] PWA 설치 유도 배선 — beforeinstallprompt 는 페이지 초기에 발화하므로 먼저 등록한다.
    if (typeof Install !== "undefined" && Install.init) { try { Install.init(); } catch (e) {} }
    // [P40] 프로젝트 초대 링크(?invite=<token>) — 있으면 이름/비번 설정 모달을 띄운다.
    if (typeof Invite !== "undefined" && Invite.init) { try { Invite.init(); } catch (e) {} }

    // ── E2E 테스트 훅 (프로덕션 무해): 핀을 직접 주입해 UI 워크플로우 없이 검증 ──
    window.__wm = {
      State, App, AllPins, UI, MapCtrl, Auth, Settings, PinPrefs, PinSeries, PinIcons, Designers, Projects, ProjectHub, Prompt, PanoViewer, Radar, PanoNav, Brand, Notes, TimeLapse, Compare, Zones, Inspector, PinGrid, SyncQueue, Cloud, PDF, FLS, PinActionPop, CompanyAuth, PdfAnno, AdminPanels,
      Offline, OfflineBundle, OfflineLoad, OpLog, Invite, Install,
      UserMgmt: (typeof UserMgmt !== "undefined" ? UserMgmt : null),
      ThetaIntake: (typeof ThetaIntake !== "undefined" ? ThetaIntake : null),
      PdfPopup: (typeof PdfPopup !== "undefined" ? PdfPopup : null),
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
    // [P61] 공유 주소 `/srview/<프로젝트명>-<토큰>` — 서버가 토큰을 이미 검증해 셸을 내줬다.
    //   여기서는 토큰으로 프로젝트/배포본만 해석해 **열람 전용**으로 연다(?d= 와 동일 취급).
    const shareTok = (typeof ShareLink !== "undefined") ? ShareLink.token() : null;
    if (shareTok) {
      State.viewerLocked = true;
      (async () => {
        const j = await ShareLink.resolve();
        // 해석 실패(오프라인/링크 해제)여도 설계자 화면으로 새지 않는다 — 잠긴 뷰어 유지.
        App.openApp("viewer", (j && j.project) ? { project: { id: j.project.id, name: j.project.name } } : undefined);
      })();
    } else if (depId) {
      // [마스터 2026-09-13] 뷰어는 배포 링크(?d=배포ID) 전용 — mode=viewer 단독은 디자이너로 보낸다.
      State.viewerLocked = true;
      App.openApp("viewer");
    } else if (urlMode === "designer") {
      // 설계자 직접 진입 — 로그인+디자이너 권한 필요, 통과 시 프로젝트 허브로
      Auth.requireDesigner(() => ProjectHub.open());
      ProjectHub.open();
    } else {
      // [멀티테넌트] <name>.seastar.work 서브도메인이면 그 프로젝트로 바로 진입, 아니면 허브.
      (async () => {
        try {
          const t = await fetch('/api/tenant/resolve').then(r => r.json());
          if (t && t.matched && t.project && t.project.id) {
            if (typeof Projects !== 'undefined') Projects.currentProject = { id: t.project.id, name: t.project.name };
            // [마스터 2026-09-13] 뷰어는 배포 링크(?d=배포ID) 전용 — 서브도메인 자동진입은 디자이너로 고정한다.
            // 원복(뷰어 자동진입 부활) 시 아래 줄로 교체: App.openApp((typeof Auth !== 'undefined' && Auth.isDesigner) ? 'designer' : 'viewer', { project: { id: t.project.id, name: t.project.name } });
            App.openApp((typeof PinSeries !== 'undefined' ? PinSeries.preferredMode() : 'designer'), { project: { id: t.project.id, name: t.project.name } });
            return;
          }
        } catch (e) {}
        // ── 첫 화면 = 프로젝트 선택 대시보드 (상용툴 모방) ──
        ProjectHub.open();
      })();
    }

    /* ── 360° 테스트 훅: ?demo360=<이미지URL> 로 파노라마 직접 오픈 ── */
    const demo = params.get("demo360");
    if (demo) {
      PanoViewer.loadMedia(decodeURIComponent(demo), "TEST PANORAMA");
    }
  });

})();
