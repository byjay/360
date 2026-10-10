  /* ── 진입 ── */
  document.addEventListener("DOMContentLoaded", async () => {
    // [버그①수정 2026-08-31] App.init()이 Auth.init()(데모 자동로그인)을 await하므로
    // 여기서도 await해 ProjectHub.open() 등 하위 로직이 로그인 완료 후 실행되게 한다.
    await App.init();

    // [WO 20261008-layout] 사이드바 폭 조절/접기 — 데스크톱 전체 배치 재설계. 다른 모듈과
    // 동일 패턴(try/catch, 있으면 실행)으로 배선해 충돌 지점을 늘리지 않는다.
    if (typeof UI !== "undefined" && UI.initSidebarResize) { try { UI.initSidebarResize(); } catch (e) {} }

    // [오프라인 작업지시서 ] 오프라인 상태 배지/네트워크 이벤트 연결
    if (typeof Offline !== "undefined" && Offline.init) { try { Offline.init(); } catch (e) {} }

    // [P40] PWA 설치 유도 배선 — beforeinstallprompt 는 페이지 초기에 발화하므로 먼저 등록한다.
    if (typeof Install !== "undefined" && Install.init) { try { Install.init(); } catch (e) {} }
    // [WO 20261009-installgate] 모바일 강제 설치 게이트 — Install.init() 다음(같은 beforeinstallprompt
    // 캡처를 공유하므로 순서 중요: Install이 먼저 리스너를 걸어야 _deferred가 채워진다).
    if (typeof InstallGate !== "undefined" && InstallGate.init) { try { InstallGate.init(); } catch (e) {} }
    // [WO 20261007-aivision] 온라인/오프라인 전환 시 AI 분석 버튼 사유 재계산
    if (typeof AiVision !== "undefined" && AiVision.init) { try { AiVision.init(); } catch (e) {} }
    // [WO 20261007-qrcov] 핀 팝업 [QR] 주입 · 촬영 현황(커버리지) 초기화
    if (typeof QrPrint !== "undefined" && QrPrint.init) { try { QrPrint.init(); } catch (e) {} }
    if (typeof Coverage !== "undefined" && Coverage.init) { try { Coverage.init(); } catch (e) {} }
    // [WO 20261010-delivery] 음성 메모 [🎤] — 노트·결함 입력칸(요청·답변 칸은 42_Requests 가 생성 시 attach)
    if (typeof Voice !== "undefined" && Voice.init) { try { Voice.init(); } catch (e) {} }
    // [P40] 프로젝트 초대 링크(?invite=<token>) — 있으면 이름/비번 설정 모달을 띄운다.
    if (typeof Invite !== "undefined" && Invite.init) { try { Invite.init(); } catch (e) {} }

    // ── E2E 테스트 훅 (프로덕션 무해): 핀을 직접 주입해 UI 워크플로우 없이 검증 ──
    window.__wm = {
      State, App, AllPins, UI, MapCtrl, Auth, Settings, PinPrefs, PinSeries, PinIcons, Designers, Projects, ProjectHub, Prompt, PanoViewer, Radar, PanoNav, Brand, Notes, TimeLapse, Compare, Zones, Inspector, PinGrid, SyncQueue, Cloud, PDF, FLS, PinActionPop, CompanyAuth, PdfAnno, AdminPanels,
      Offline, OfflineBundle, OfflineLoad, OpLog, Invite, Install, InstallGate,
      UserMgmt: (typeof UserMgmt !== "undefined" ? UserMgmt : null),
      ThetaIntake: (typeof ThetaIntake !== "undefined" ? ThetaIntake : null),
      DeepLink: (typeof DeepLink !== "undefined" ? DeepLink : null),
      CompareSync: (typeof CompareSync !== "undefined" ? CompareSync : null),
      QrPrint: (typeof QrPrint !== "undefined" ? QrPrint : null),
      Coverage: (typeof Coverage !== "undefined" ? Coverage : null),
      AiVision: (typeof AiVision !== "undefined" ? AiVision : null),
      PdfPopup: (typeof PdfPopup !== "undefined" ? PdfPopup : null),
      NumBand: (typeof NumBand !== "undefined" ? NumBand : null),
      FieldCapture: (typeof FieldCapture !== "undefined" ? FieldCapture : null),
      Report: (typeof Report !== "undefined" ? Report : null),
      Requests: (typeof Requests !== "undefined" ? Requests : null),
      ProjectInfo: (typeof ProjectInfo !== "undefined" ? ProjectInfo : null),
      Delivery: (typeof Delivery !== "undefined" ? Delivery : null),
      ZipStore: (typeof ZipStore !== "undefined" ? ZipStore : null),
      Voice: (typeof Voice !== "undefined" ? Voice : null),
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
        // [P63] 🔴 도면보다 **먼저** 초대코드 게이트를 지난다. 통과 전에는 서버가 데이터를 주지 않으므로
        //   여기서 먼저 통행증을 받아야 뒤의 열람 요청이 성립한다(UI 가리기가 아니다).
        if (typeof ShareGate !== "undefined") await ShareGate.ensure({ t: shareTok });
        const j = await ShareLink.resolve();
        if (!j || !j.project) {
          // 해석 실패(링크 해제/삭제) — 조용한 빈 화면 대신 이유와 재요청처를 보여준다.
          if (typeof ShareGate !== "undefined") ShareGate.showDeadLink();
          return;
        }
        App.openApp("viewer", { project: { id: j.project.id, name: j.project.name } });
      })();
    } else if (depId) {
      // [마스터 2026-09-13] 뷰어는 배포 링크(?d=배포ID) 전용 — mode=viewer 단독은 디자이너로 보낸다.
      State.viewerLocked = true;
      (async () => {
        // [P63] 🔴 `?d=` 에도 같은 게이트를 적용한다 — 적용하지 않으면 이 경로가 게이트 우회로가 된다.
        //   링크가 죽는 게 아니라 코드 입력 화면이 먼저 뜰 뿐이라 하위호환은 그대로다.
        if (typeof ShareGate !== "undefined") await ShareGate.ensure({ d: depId });
        App.openApp("viewer");
      })();
    } else if (typeof DeepLink !== "undefined" && DeepLink.parse(location.search)) {
      // [WO 20261007-qrcov] QR 위치 태그 딥링크(?qp=&qk=&qpin=) — 위의 열람·공유 링크 분기보다 **뒤**에 둔다
      //   (d·공유 토큰이 있으면 그 게이트가 정본, DeepLink.parse 도 d/invite 가 있으면 null). 권한 = 기존 게이트 그대로.
      DeepLink.boot();
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
            // [WO 20260929-parent-guard] SoT — Projects.setCurrentProject() 경유(31_Projects.js).
            if (typeof Projects !== 'undefined') {
              const tp = { id: t.project.id, name: t.project.name };
              if (Projects.setCurrentProject) Projects.setCurrentProject(tp); else Projects.currentProject = tp;
            }
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
