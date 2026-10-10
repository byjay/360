  /* ══════════════════════════════════════════════════════════════
     FEATURE MENU — 전체 기능 메뉴 (WO 20261002-allmenu §1·§3)
     ────────────────────────────────────────────────────────────────
     마스터: "메뉴는 모든 기능을 다 담아" + "숨기지 마".
     🔴 단일 SoT = 아래 FEATURES 배열 하나. 데스크톱 상단바 [☰ 전체 기능] 패널과 모바일 도크 [더보기] 시트가
        같은 배열에서 같은 렌더 함수(renderInto)로 파생된다(두 벌 금지).
     🔴 숨김 금지 — 권한·모드·기기가 안 맞아도 목록에서 빼지 않는다. 비활성 + 사유 글자("소유자·관리자 전용",
        "360 뷰어에서 사용", "휴대폰에서 사용")를 항목 안에 보인다. 모드(CHECKER/360)만 다르면 비활성이 아니라
        누를 때 그 모드로 전환(App._setRegMode — 상단 세그먼트와 같은 SoT) 후 실행한다.
     🔴 실행 = 기존 진입점 재사용(click: 기존 버튼 .click() 위임 / run: 기존 모듈 함수). 새 기능 로직 0.
     문구 SoT: help 키가 있으면 설명 = 36_Help.CONTENT 그 키의 첫 문장(도움말과 공유). 반대로 Help.get(기능 id)도
        이 배열의 desc 를 돌려준다(36_Help.get 폴백). 권한 사유 문구 SoT = UI.permCheck(11_UI.js).
     기존 버튼(툴바·도크·트리·FAB)은 그대로 둔다 — 이 메뉴는 추가 진입점이다.
  ══════════════════════════════════════════════════════════════ */
  const FeatureMenu = {
    GROUPS: [
      { id: "project", label: "프로젝트" },
      { id: "drawing", label: "도면·구역" },
      { id: "checker", label: "포인트 (CHECKER)" },
      { id: "pano", label: "360" },
      { id: "collab", label: "협업·요청" },
      { id: "report", label: "보고·내보내기" },
      { id: "offline", label: "오프라인" },
      { id: "settings", label: "설정" },
      { id: "admin", label: "관리자" },
      { id: "help", label: "도움말" }
    ],

    /* 필드: id · group · label · icon(글리프) · desc(1줄) 또는 help(36_Help 키) · keys(단축) · perm(any|login|designer|owner|admin|super)
       · mode(checkboard|photo — 다르면 전환 후 실행) · needs(project|drawing|deck|pano|mobile|pin|soon|module:<이름>)
       · click(기존 버튼 id 로 위임) 또는 run() · covers(이 기능의 기존 진입점 버튼 id — 전수 검사용) */
    FEATURES: [
      /* ── 프로젝트 ── */
      { id: "project-hub", group: "project", icon: "⌂", label: "프로젝트 목록(홈)", desc: "모든 프로젝트 카드로 돌아갑니다", click: "btn-back", covers: ["btn-back"] },
      { id: "project-new", group: "project", icon: "+", label: "새 프로젝트", desc: "프로젝트를 만듭니다(디자이너)", perm: "designer", click: "btn-new-project", covers: ["btn-new-project", "hub-btn-new"] },
      { id: "project-info", group: "project", icon: "ⓘ", label: "프로젝트 정보", desc: "메모·일정 보기/편집", needs: "project",
        run: () => ProjectInfo.open(Projects.currentProject) },
      { id: "project-rename", group: "project", icon: "✎", label: "프로젝트 이름 변경", desc: "프로젝트 이름을 바꿉니다", perm: "owner", needs: "project",
        run: () => Projects.renameProject() },
      { id: "project-members", group: "project", icon: "👥", label: "멤버 관리", desc: "이 프로젝트에 접근할 사용자 배정", perm: "owner", needs: "project",
        run: () => ProjectHub.openMembers(Projects.currentProject) },
      { id: "project-delete", group: "project", icon: "✕", label: "프로젝트 삭제", desc: "프로젝트와 모든 구역을 삭제(확인창)", perm: "owner", needs: "project", danger: true,
        click: "btn-delete-project", covers: ["btn-delete-project"] },
      { id: "pin-purge", group: "project", icon: "✕", label: "모든 핀 삭제", desc: "프로젝트 전체 구역·도면의 핀(미리보기 → 이름 입력 → 본인 확인, 10분 되돌리기)", needs: "project", danger: true, mod: "PinPurge",
        why: () => PinPurge.reason(), run: () => PinPurge.start() },
      { id: "edit-mode", group: "project", icon: "✎", label: "편집 모드로 전환", desc: "디자이너 권한이 있을 때 편집 화면으로", perm: "login",
        click: "btn-enter-edit", covers: ["btn-enter-edit", "btn-go-edit", "btn-exit-edit"] },
      { id: "mode-checker", group: "project", icon: "#", label: "CHECKER 모드", help: "checkerboard", perm: "designer", needs: "drawing",
        run: () => App._setRegMode("checkboard"), covers: ["btn-regmode-checkboard", "btn-checkboard-enter"] },
      { id: "mode-360", group: "project", icon: "◎", label: "360 모드", desc: "핀을 만들면 바로 360 사진 선택창", perm: "designer", needs: "drawing",
        run: () => App._setRegMode("photo"), covers: ["btn-regmode-photo"] },

      /* ── 도면·구역 ── */
      { id: "drawing-upload", group: "drawing", icon: "⇪", label: "도면 등록", help: "drawing-upload", perm: "designer", needs: "project",
        click: "btn-upload-drawing", covers: ["btn-upload-drawing", "tq-upload"] },
      { id: "deck-drawing", group: "drawing", icon: "⇪", label: "구역 도면 등록/교체", desc: "지금 구역·영역에 자기 PDF·이미지를 따로(메인 PDF 는 그대로)", perm: "designer", needs: "deck",
        run: () => App.registerDrawingFor({ kind: "deck", deck: Projects.currentDeck }) },
      { id: "main-replace", group: "drawing", icon: "⟳", label: "메인 도면 교체", desc: "프로젝트 메인 PDF 를 새 파일로(확인창)", perm: "owner", needs: "project", danger: true,
        run: () => App.registerDrawingFor({ kind: "main" }) },
      // [WO 20261010-revision] 도면 개정 — 대상 = 지금 보는 자기 도면 구역, 아니면 메인(Revision.currentTarget SoT). 사유 = Revision.reason
      { id: "revision-upload", group: "drawing", icon: "⇡", label: "새 개정 올리기(Rev)", desc: "이전 도면 보관 + 기준점 정렬로 핀·영역·주석 좌표 이월(10분 되돌리기)", perm: "designer", needs: "project", mod: "Revision",
        why: () => Revision.reason(null, "upload"), run: () => Revision.start() },
      { id: "revision-history", group: "drawing", icon: "☰", label: "개정 이력·비교", desc: "번호·일자·작성자·메모 · 이전 개정 보기 · 겹쳐 비교 · 검토 필요 핀 확정", perm: "login", needs: "project", mod: "Revision",
        why: () => Revision.reason(null, "history"), run: () => Revision.openHistory() },
      { id: "origin-open", group: "drawing", icon: "▤", label: "메인(원본) 전체 도면 열기", desc: "구역이 아닌 원본 PDF 전체", needs: "project", run: () => Projects.openOriginal() },
      { id: "origin-set", group: "drawing", icon: "★", label: "지금 도면을 원본으로 지정", desc: "원본 미지정 프로젝트에서", perm: "owner", needs: "drawing", run: () => Projects.setOriginalToCurrent() },
      { id: "deck-new", group: "drawing", icon: "+", label: "구역 생성", help: "deck-source-select", perm: "designer", needs: "project", click: "btn-new-deck", covers: ["btn-new-deck"] },
      { id: "region-extract", group: "drawing", icon: "⌗", label: "도면 영역 추출(구역 만들기)", help: "region-extract", perm: "designer", needs: "drawing", click: "btn-region-extract", covers: ["btn-region-extract"] },
      { id: "zone-rect", group: "drawing", icon: "▭", label: "영역 그리기 — 사각형", help: "zone-create", perm: "designer", needs: "drawing", click: "btn-zone-rect", covers: ["btn-zone-rect"] },
      { id: "zone-circle", group: "drawing", icon: "○", label: "영역 그리기 — 원형", help: "zone-create", perm: "designer", needs: "drawing", click: "btn-zone-circle", covers: ["btn-zone-circle"] },
      { id: "zone-poly", group: "drawing", icon: "⬠", label: "영역 그리기 — 다각형", help: "zone-create", perm: "designer", needs: "drawing", click: "btn-zone-poly", covers: ["btn-zone-poly", "btn-poly-finish"] },
      { id: "region-merge", group: "drawing", icon: "⇄", label: "구역 합치기(다른 구역 포인트 가져오기)", desc: "지금 구역·영역으로 다른 구역의 포인트를 옮겨 옵니다", perm: "designer", needs: "deck", mod: "RegionMerge",
        run: () => RegionMerge.open(Projects.currentDeck) },
      { id: "deck-outline", group: "drawing", icon: "⬚", label: "구역 윤곽 표시 켜기/끄기", desc: "메인 도면 위에 캡처해 만든 구역 윤곽", click: "chk-deck-outline" },
      { id: "page-thumbs", group: "drawing", icon: "▦", label: "페이지 썸네일", keys: "T", needs: "drawing", click: "tb-thumbs", covers: ["tb-thumbs"] },
      { id: "page-first", group: "drawing", icon: "⏮", label: "첫 페이지", keys: "Home", needs: "drawing", click: "tb-first", covers: ["tb-first", "btn-first-page"] },
      { id: "page-prev", group: "drawing", icon: "◀", label: "이전 페이지", keys: "←", needs: "drawing", click: "tb-prev", covers: ["tb-prev", "btn-prev-page"] },
      { id: "page-next", group: "drawing", icon: "▶", label: "다음 페이지", keys: "→", needs: "drawing", click: "tb-next", covers: ["tb-next", "btn-next-page"] },
      { id: "page-last", group: "drawing", icon: "⏭", label: "마지막 페이지", keys: "End", needs: "drawing", click: "tb-last", covers: ["tb-last", "btn-last-page"] },
      { id: "zoom-in", group: "drawing", icon: "＋", label: "확대", keys: "+", needs: "drawing", click: "tb-zoom-in", covers: ["tb-zoom-in", "btn-zoom-in"] },
      { id: "zoom-out", group: "drawing", icon: "－", label: "축소", keys: "-", needs: "drawing", click: "tb-zoom-out", covers: ["tb-zoom-out", "btn-zoom-out", "tb-zoom-level"] },
      { id: "zoom-fit", group: "drawing", icon: "⤢", label: "화면 맞춤", keys: "F", needs: "drawing", click: "tb-fit", covers: ["tb-fit", "btn-fit", "tq-fit"] },
      { id: "zoom-actual", group: "drawing", icon: "1:1", label: "실제 크기", keys: "1", needs: "drawing", click: "tb-actual", covers: ["tb-actual", "btn-actual"] },
      { id: "rotate-ccw", group: "drawing", icon: "↺", label: "왼쪽 회전", keys: "Shift+←", needs: "drawing", click: "tb-rotate-ccw", covers: ["tb-rotate-ccw", "btn-rotate-ccw"] },
      { id: "rotate-cw", group: "drawing", icon: "↻", label: "오른쪽 회전", keys: "Shift+→", needs: "drawing", click: "tb-rotate-cw", covers: ["tb-rotate-cw", "btn-rotate-cw"] },
      { id: "iso-view", group: "drawing", icon: "◇", label: "ISO 3D 보기", desc: "평면 ↔ 입체", needs: "drawing", click: "tb-iso", covers: ["tb-iso", "btn-iso"] },
      { id: "anno-select", group: "drawing", icon: "↖", label: "주석 — 선택/이동", keys: "V", perm: "designer", needs: "drawing", click: "tb-anno-cursor", covers: ["tb-anno-cursor"] },
      { id: "anno-hl", group: "drawing", icon: "▮", label: "주석 — 형광펜", perm: "designer", needs: "drawing", click: "tb-anno-hl", covers: ["tb-anno-hl"] },
      { id: "anno-rect", group: "drawing", icon: "▭", label: "주석 — 사각형", perm: "designer", needs: "drawing", click: "tb-anno-rect", covers: ["tb-anno-rect"] },
      { id: "anno-pen", group: "drawing", icon: "✐", label: "주석 — 자유선", perm: "designer", needs: "drawing", click: "tb-anno-pen", covers: ["tb-anno-pen"] },
      { id: "anno-text", group: "drawing", icon: "T", label: "주석 — 텍스트 메모", perm: "designer", needs: "drawing", click: "tb-anno-text", covers: ["tb-anno-text"] },
      { id: "anno-undo", group: "drawing", icon: "↶", label: "주석 — 실행취소", perm: "designer", needs: "drawing", click: "tb-anno-undo", covers: ["tb-anno-undo"] },
      { id: "anno-clear", group: "drawing", icon: "⌫", label: "주석 — 이 페이지 모두 삭제", perm: "designer", needs: "drawing", danger: true, click: "tb-anno-clear", covers: ["tb-anno-clear"] },
      { id: "sidebar", group: "drawing", icon: "☰", label: "사이드바(트리) 열기/닫기", desc: "프로젝트 → 원본 → 구역 → 영역 → 포인트", click: "tq-menu", covers: ["tq-menu", "stb-toggle", "btn-sidebar-collapse"] },

      /* ── 포인트 (CHECKER) ── */
      { id: "pin-add", group: "checker", icon: "⊕", label: "포인트 추가", help: "pin-place", perm: "designer", needs: "drawing", click: "btn-place", covers: ["btn-place", "tq-place", "btn-next-point"] },
      { id: "pin-quick", group: "checker", icon: "⊕", label: "빠른 포인트(CHECKER 순차 배치)", desc: "번호 핀을 1번부터 연속으로", perm: "designer", needs: "drawing", mode: "checkboard", click: "btn-quickpoint", covers: ["btn-quickpoint"] },
      { id: "pin-edit-mode", group: "checker", icon: "✎", label: "포인트 수정 모드", desc: "켠 뒤 핀을 눌러 수정·이동·삭제", perm: "designer", needs: "drawing", click: "tb-pin-edit", covers: ["tb-pin-edit"] },
      { id: "pin-mark", group: "checker", icon: "M", label: "포인트 마킹", keys: "M", perm: "designer", needs: "drawing", click: "tb-mark", covers: ["tb-mark"] },
      { id: "align-v", group: "checker", icon: "↕", label: "리더선 정렬 — 세로", desc: "선택(없으면 이 구역·영역) 리더선 포인트의 풍선을 클릭 위치 기준 등간격 — 리더선 핀만(pinstyle)", perm: "designer", needs: "drawing", mode: "checkboard",
        run: () => UI._startAlign("v") },
      { id: "align-h", group: "checker", icon: "↔", label: "리더선 정렬 — 가로", desc: "선택(없으면 이 구역·영역) 리더선 포인트의 풍선을 클릭 위치 기준 등간격 — 리더선 핀만(pinstyle)", perm: "designer", needs: "drawing", mode: "checkboard",
        run: () => UI._startAlign("h") },
      { id: "align-undo", group: "checker", icon: "↶", label: "리더선 정렬 되돌리기", desc: "직전 정렬 1회", perm: "designer", needs: "drawing", run: () => UI.undoAlign() },
      { id: "pin-select", group: "checker", icon: "☑", label: "포인트 여러 개 선택", desc: "정렬·삭제할 포인트를 고릅니다", perm: "designer", needs: "drawing",
        run: () => { UI.setPinSelectMode(true); if (UI.togglePinList) UI.togglePinList(true); } },
      { id: "pin-bulk-delete", group: "checker", icon: "✕", label: "포인트 일괄 삭제", desc: "선택한 포인트를 한꺼번에(본인 확인)", perm: "owner", needs: "drawing", danger: true,
        run: () => { UI.setPinSelectMode(true); if (UI.togglePinList) UI.togglePinList(true); FeatureMenu._toast("삭제할 포인트를 고른 뒤 [선택 삭제]"); } },
      { id: "num-band", group: "checker", icon: "№", label: "번호 대역", desc: "100번 단위로 사람마다 번호대를 나눠 씁니다", perm: "designer", mod: "NumBand",
        run: () => NumBand.open(), covers: ["btn-numband", "btn-settings-numband", "allpins-band-btn"] },
      { id: "renumber", group: "checker", icon: "⇅", label: "번호 다시 매기기", help: "checkboard-renumber", perm: "designer", needs: "drawing", mode: "checkboard",
        click: "btn-checkboard-renumber", covers: ["btn-checkboard-renumber", "btn-settings-checkboard-renumber", "allpins-btn-renumber"] },
      { id: "all-pins", group: "checker", icon: "≡", label: "전체 포인트 목록", keys: "P", desc: "검색·정렬·선택", needs: "drawing", mod: "AllPins",
        run: () => AllPins.toggle(), covers: ["btn-all-pins", "allpins-select-all", "allpins-select-clear", "allpins-btn-delete"] },
      { id: "pin-list", group: "checker", icon: "≣", label: "포인트 리스트 패널", desc: "현재 페이지 포인트", needs: "drawing", click: "tq-pins", covers: ["tq-pins", "pin-list-toggle", "pin-grid-toggle", "pin-grid-reopen"] },

      /* ── 360 ── */
      { id: "theta-app", group: "pano", icon: "📷", label: "RICOH THETA 앱 열기", desc: "THETA 앱에서 촬영 → 돌아와 사진 선택", perm: "designer", needs: "mobile", mode: "photo",
        run: () => ThetaIntake.openApp({ pinId: State.activePin }) },
      { id: "theta-received", group: "pano", icon: "⇩", label: "받은 사진 등록", desc: "THETA 에서 공유받아 보관된 360 사진 → 어디에 등록? → 포인트 탭", perm: "designer", needs: "drawing", mod: "ThetaIntake",
        run: () => ThetaIntake.startFromPending() },
      { id: "theta-intake", group: "pano", icon: "⇩", label: "THETA 360 사진 가져오기", desc: "갤러리의 R* 360 사진 → 도면에 위치 지정", perm: "designer", needs: "drawing", mode: "photo", click: "btn-theta-intake", covers: ["btn-theta-intake", "theta-tray-close"] },
      { id: "field-capture", group: "pano", icon: "📷", label: "현장 촬영", desc: "사진을 바로 찍어 도면에 위치 등록(THETA 공유·갤러리·카메라·안드로이드 앱 중 선택)", perm: "designer", needs: "drawing", mode: "photo", mod: "FieldCapture",
        run: () => FieldCapture.open(), covers: ["mdock-field-capture"] },
      { id: "field-capture-method", group: "pano", icon: "⇄", label: "현장 촬영 방식 변경", desc: "THETA 공유·갤러리·카메라·안드로이드 앱 중 다시 고릅니다", perm: "designer", needs: "drawing", mod: "FieldCapture",
        run: () => FieldCapture.open(true) },
      { id: "photo-batch", group: "pano", icon: "▣", label: "사진 폴더 일괄 매칭", help: "photo-batch", perm: "designer", needs: "drawing", mode: "photo", click: "btn-photobatch", covers: ["btn-photobatch", "mdock-photobatch"] },
      { id: "coverage", group: "pano", icon: "◔", label: "촬영 현황 보기 켜기/끄기", help: "coverage", needs: "drawing", mod: "Coverage",
        why: () => Coverage.reason(), run: () => Coverage.toggle() },
      { id: "pano-setdir-map", group: "pano", icon: "⌖", label: "360 시야 방향 보정(도면)", help: "orientation-fix", perm: "designer", needs: "drawing", click: "tb-setdir", covers: ["tb-setdir"] },
      { id: "pano-notes", group: "pano", icon: "✉", label: "이슈·필드노트(360)", desc: "현장 협업 메모", needs: "pano", click: "btn-pano-notes", covers: ["btn-pano-notes"] },
      { id: "pano-spot", group: "pano", icon: "◉", label: "360 안에 마커 추가", perm: "designer", needs: "pano", click: "btn-pano-spot", covers: ["btn-pano-spot"] },
      { id: "pano-shape-rect", group: "pano", icon: "▭", label: "360 도형 — 사각형", perm: "designer", needs: "pano", click: "btn-pano-shape-rect", covers: ["btn-pano-shape-rect"] },
      { id: "pano-shape-circle", group: "pano", icon: "○", label: "360 도형 — 원", perm: "designer", needs: "pano", click: "btn-pano-shape-circle", covers: ["btn-pano-shape-circle"] },
      { id: "pano-spotlist", group: "pano", icon: "≡", label: "360 마커 목록", needs: "pano", click: "btn-pano-spotlist", covers: ["btn-pano-spotlist"] },
      { id: "pano-rotate", group: "pano", icon: "⟲", label: "360 자동 회전", needs: "pano", click: "btn-pano-rotate", covers: ["btn-pano-rotate"] },
      { id: "pano-level", group: "pano", icon: "⊥", label: "360 수평 보정", needs: "pano", click: "btn-pano-level-r", covers: ["btn-pano-level-l", "btn-pano-level-r"] },
      { id: "pano-setdir", group: "pano", icon: "⌖", label: "360 선수 방향 지정", perm: "designer", needs: "pano", click: "btn-pano-setdir", covers: ["btn-pano-setdir", "pano-radar-dir"] },
      { id: "pano-reset", group: "pano", icon: "⌂", label: "360 초기 시점", needs: "pano", click: "btn-pano-reset", covers: ["btn-pano-reset"] },
      { id: "pano-zoom", group: "pano", icon: "＋", label: "360 확대/축소", needs: "pano", click: "btn-pano-zoomin", covers: ["btn-pano-zoomin", "btn-pano-zoomout"] },
      { id: "pano-full", group: "pano", icon: "⛶", label: "360 전체화면", needs: "pano", click: "btn-pano-full", covers: ["btn-pano-full"] },
      { id: "pano-nav", group: "pano", icon: "⇆", label: "360 이전/다음 포인트", keys: "← →", needs: "pano", click: "btn-pano-next", covers: ["btn-pano-prev", "btn-pano-next"] },
      { id: "pano-minimap", group: "pano", icon: "◫", label: "360 미니맵(확대·접기)", help: "radar-zoom", needs: "pano", click: "pano-radar-expand",
        covers: ["pano-radar-expand", "pano-radar-zoom-in", "pano-radar-zoom-out", "pano-radar-toggle", "pano-radar-more"] },
      { id: "photo-history", group: "pano", icon: "◷", label: "사진 이력(재방선)", desc: "같은 포인트의 이전 사진 · 되돌리기", needs: "pano", click: "btn-tl-prev", covers: ["btn-tl-prev", "btn-tl-next", "btn-tl-revert"] },
      { id: "photo-history-delete", group: "pano", icon: "✕", label: "사진 이력 삭제", perm: "admin", needs: "pano", danger: true, click: "btn-tl-delete", covers: ["btn-tl-delete"] },
      { id: "photo-compare", group: "pano", icon: "◧", label: "전/후 분할 비교(360 동기)", desc: "두 시점 360을 나란히, 한쪽을 돌리면 같이 돈다. 평면 슬라이더 보조 모드 포함", needs: "pano", click: "btn-tl-compare", covers: ["btn-tl-compare", "btn-cmp-close", "btn-cmp360-close", "btn-cmp360-sync", "btn-cmp360-flat"] },
      { id: "photo-original", group: "pano", icon: "⤓", label: "360 원본 보기·다운로드", desc: "풀해상도 원본", needs: "pano", click: "btn-pano-orig" },
      { id: "ai-analyze", group: "pano", icon: "🤖", label: "AI 사진 분석", help: "ai-analyze", perm: "designer", needs: "pano", click: "btn-pano-ai", covers: ["btn-pano-ai"] },
      { id: "scan-3d", group: "pano", icon: "◈", label: "3D 스캔 도구(오비트·팬·단면·측정)", desc: "3D 스캔 포인트에서", needs: "pano", click: "btn-cad-orbit",
        covers: ["btn-cad-orbit", "btn-cad-pan", "btn-cad-section", "btn-cad-measure", "btn-fls-reset", "btn-fls-collapse"] },

      /* ── 협업·요청 ── */
      { id: "requests-inbox", group: "collab", icon: "✉", label: "요청함·결함 목록", desc: "열람자 요청·질문·결함(상태·기한·심각도)", perm: "designer", needs: "project", mod: "Requests",
        run: () => Requests.openInbox() },
      { id: "defect-severity", group: "collab", icon: "⚑", label: "결함 심각도 제안(Jev)", desc: "요청함 → 결함 상세에서 [심각도 제안]", perm: "designer", needs: "project", mod: "Requests",
        run: () => Requests.openInbox() },
      { id: "request-send", group: "collab", icon: "✉", label: "요청·질문 보내기", desc: "디자이너에게 수정 요청/질문", needs: "project", mod: "Requests",
        run: () => Requests.openViewer({}) },
      { id: "invite", group: "collab", icon: "✚", label: "초대 링크 공유", help: "invite-share", perm: "owner", needs: "project",
        run: () => ProjectHub.openMembers(Projects.currentProject), covers: ["pm-invite-share", "pm-invite-copy"] },

      /* ── 보고·내보내기 ── */
      { id: "report-print", group: "report", icon: "⎙", label: "보고서 인쇄(PDF)", desc: "지금 범위의 포인트·사진 보고서", needs: "project", mod: "Report",
        run: () => Report.print(Report.currentScope ? Report.currentScope() : undefined) },
      { id: "report-csv", group: "report", icon: "⇩", label: "보고서 CSV", desc: "지금 범위의 포인트 표", needs: "project", mod: "Report",
        run: () => Report.csv(Report.currentScope ? Report.currentScope() : undefined) },
      // [WO 20261010-delivery] 납품 보고서(표지·요약·위치도·핀별 사진/결함) · 오프라인 묶음(zip)
      { id: "report-delivery", group: "report", icon: "⎘", label: "납품 보고서(PDF)", desc: "표지·요약·핀 위치도·사진 전후·결함 — 인쇄창에서 PDF 저장", needs: "project", mod: "Delivery",
        run: () => Delivery.open(Report.currentScope ? Report.currentScope() : undefined) },
      { id: "report-bundle", group: "report", icon: "⇩", label: "오프라인 묶음(zip)", desc: "보고서 HTML + 축소 사진을 한 파일로", needs: "project", mod: "Delivery",
        run: () => Delivery.bundle(Report.currentScope ? Report.currentScope() : undefined) },
      { id: "qr-deck", group: "report", icon: "▣", label: "이 구역 QR 위치 태그 일괄 인쇄", help: "qr-tag", needs: "deck", mod: "QrPrint",
        why: () => QrPrint.deckReason(Projects.currentDeck), run: () => QrPrint.printDeck(Projects.currentDeck) },
      { id: "pin-csv", group: "report", icon: "⇩", label: "포인트 CSV 내보내기", needs: "drawing", click: "pin-grid-csv", covers: ["pin-grid-csv"] },
      { id: "deploy-viewer", group: "report", icon: "⇗", label: "뷰어로 배포(열람 링크)", help: "deploy-viewer", perm: "designer", needs: "drawing", click: "btn-deploy", covers: ["btn-deploy"] },
      { id: "json-export", group: "report", icon: "{}", label: "JSON 내보내기", perm: "designer", needs: "drawing", click: "btn-export-json", covers: ["btn-export-json"] },
      { id: "json-import", group: "report", icon: "{}", label: "JSON 포인트 가져오기", perm: "designer", needs: "drawing", click: "btn-import-json", covers: ["btn-import-json"] },
      { id: "deploy-reload", group: "report", icon: "⟳", label: "배포본 다시 불러오기", perm: "designer", needs: "drawing", click: "btn-reload-deploy", covers: ["btn-reload-deploy"] },

      /* ── 오프라인 ── */
      { id: "save", group: "offline", icon: "💾", label: "저장", desc: "미저장 변경을 서버에 반영", perm: "designer", needs: "drawing", click: "btn-save", covers: ["btn-save"] },
      { id: "sync-now", group: "offline", icon: "⇅", label: "지금 동기화(업로드)", desc: "오프라인 대기분 올리기", click: "sync-badge", covers: ["sync-badge", "mdock-upload"] },
      { id: "offline-download", group: "offline", icon: "⤓", label: "오프라인 보관(다운로드)", help: "offline-download", needs: "project", click: "btn-download-project", covers: ["btn-download-project"] },

      /* ── 설정 ── */
      { id: "settings", group: "settings", icon: "⚙", label: "설정", desc: "로그인·편집 모드·핀 색상·표시 옵션", click: "btn-settings", covers: ["btn-settings", "settings-close"] },
      { id: "leader360", group: "settings", icon: "↗", label: "리더선 일괄 켜기/끄기", desc: "선택한 포인트(없으면 이 구역 현재 모드) — 기본은 핀, 좁은 곳만 리더선", click: "chk-leader360" },
      { id: "install-app", group: "settings", icon: "⬇", label: "앱 설치(홈 화면에 추가)", desc: "아이콘으로 바로 열기", mod: "Install",
        why: () => (typeof Install !== "undefined" && Install.alreadyInstalledReason) ? Install.alreadyInstalledReason() : "",
        run: () => Install.showBanner(true), covers: ["pwa-install-accept", "pwa-install-close"] },
      { id: "apk-install", group: "settings", icon: "📱", label: "안드로이드 앱 설치(APK)", help: "apk-install", mod: "ApkInstall",
        why: () => ApkInstall.availabilityReason(), run: () => ApkInstall.open(), covers: ["install-gate-apk"] },
      { id: "signout", group: "settings", icon: "⎋", label: "로그아웃", perm: "login", click: "btn-settings-signout", covers: ["btn-settings-signout", "btn-signout", "hub-btn-signout"] },

      /* ── 관리자 ── */
      { id: "admin-users", group: "admin", icon: "👤", label: "디자이너·도메인·멤버·로그 관리", perm: "admin", click: "btn-open-designers", covers: ["btn-open-designers", "btn-manage-designers", "hub-btn-manage-designers", "designers-close"] },
      { id: "admin-features", group: "admin", icon: "⚑", label: "기능 플래그", perm: "super", click: "btn-open-features", covers: ["btn-open-features"] },
      { id: "admin-ai", group: "admin", icon: "✦", label: "AI 연동 설정", perm: "super", click: "btn-open-ai", covers: ["btn-open-ai"] },
      { id: "admin-firebase", group: "admin", icon: "☁", label: "Firebase 설정", perm: "super", click: "btn-open-firebase", covers: ["btn-open-firebase"] },
      { id: "admin-codemap", group: "admin", icon: "⌘", label: "코드 지도", perm: "super", click: "btn-open-codemap", covers: ["btn-open-codemap"] },

      /* ── 도움말 ── */
      { id: "help-mode", group: "help", icon: "?", label: "도움말 모드(버튼마다 ? 표시)", desc: "켜면 기능마다 설명 배지", mod: "Help", run: () => Help.toggle() },
      { id: "help-viewer", group: "help", icon: "?", label: "사용법(열람자)", desc: "도면 이동·핀 종류·360 조작", mod: "Help", run: () => Help.openViewerPanel() },
      { id: "help-inquiry", group: "help", icon: "✉", label: "문의하기", desc: "운영자에게 문의(화면 정보 첨부)", mod: "Help", run: () => Help.openInquiry() }
    ],

    /* 기능이 아닌 버튼(모달 내부 조작·닫기·제출 등) — 전수 검사에서 "빠짐" 으로 세지 않는 이유를 적는다. */
    NON_FEATURE: [
      { re: "^(pm|pms|dsm|par|sg|pwc|inv|cg|ar|um|adm|log|matrix|members|domain|designer-add|invite-add|proj-req|pnp|pap|ai|firebase|features|codemap|prompt-modal|deck-link|pdf-popup|photobatch|login-gate|company|access-gate|invite-gate|company-gate)-", why: "모달·패널 내부 조작(그 모달을 여는 기능이 메뉴에 있다)" },
      { re: "^hub-btn-(demo-viewer|google-login)$", why: "허브 로그인 화면 전용" },
      { re: "-(close|cancel)$", why: "닫기·취소" },
      { re: "^btn-(cancel-pin|confirm-pin|pin-[a-z-]+|photo-reselect|pano-more|pano-close|pano-tools-toggle)$", why: "포인트 폼·360 헤더 내부 조작(포인트 추가·360 열기 흐름 안)" },
      { re: "^(btn-photobatch-pick|btn-photobatch-pick-files|btn-photobatch-run)$", why: "사진 폴더 일괄 매칭 패널 내부" },
      { re: "^mdock-more-toggle$", why: "이 메뉴를 여는 버튼 자체" }
    ],

    /* ─── 판정 ─── */
    _f(id) { return this.FEATURES.find((f) => f.id === id) || null; },
    /** 설명 1줄 — help 키가 있으면 36_Help.CONTENT 의 첫 문장(— 뒤) 을 SoT 로 쓴다. */
    descOf(f) {
      if (f.help && typeof Help !== "undefined" && Help.CONTENT && Help.CONTENT[f.help]) {
        const t = String(Help.CONTENT[f.help]);
        const body = t.indexOf(" — ") >= 0 ? t.slice(t.indexOf(" — ") + 3) : t;
        const cut = body.search(/[.!?]\s|다\.|요\./);
        return (cut > 0 ? body.slice(0, cut + 2) : body).trim();
      }
      return f.desc || "";
    },
    _isMobileNav() { return typeof ThetaIntake !== "undefined" && ThetaIntake.appDisabledReason ? ThetaIntake.appDisabledReason() : "휴대폰에서 사용"; },
    /** 360 뷰어가 열려 있나 — SoT = #pano-overlay 의 hidden 클래스(20_App.openPano/closePano 가 토글). */
    _panoOpen() {
      const el = typeof document !== "undefined" ? document.getElementById("pano-overlay") : null;
      return !!(el && el.classList && !el.classList.contains("hidden"));
    },
    /** 협력 모듈 로드 여부 — 번들은 모듈을 한 IIFE 안 const 로 선언하므로 globalThis 로는 볼 수 없다.
     *  식별자를 그대로 typeof 로 본다(eval 금지). 미로드면 "준비 중"(지어내지 않고 정직하게). */
    _modReady(name) {
      try {
        switch (name) {
          case "RegionMerge": return typeof RegionMerge !== "undefined";
          case "NumBand": return typeof NumBand !== "undefined";
          case "AllPins": return typeof AllPins !== "undefined";
          case "ThetaIntake": return typeof ThetaIntake !== "undefined";
          case "Requests": return typeof Requests !== "undefined";
          case "Report": return typeof Report !== "undefined";
          case "QrPrint": return typeof QrPrint !== "undefined";
          case "Coverage": return typeof Coverage !== "undefined";
          case "Install": return typeof Install !== "undefined";
          case "ApkInstall": return typeof ApkInstall !== "undefined";
          case "Help": return typeof Help !== "undefined";
          case "PinPurge": return typeof PinPurge !== "undefined";
          case "FieldCapture": return typeof FieldCapture !== "undefined";
          case "Revision": return typeof Revision !== "undefined";
          case "Delivery": return typeof Delivery !== "undefined" && typeof ZipStore !== "undefined";
          default: return false;
        }
      } catch (e) { return false; }   // 선언 전(TDZ) 접근도 "미로드"로
    },
    /** 비활성 사유("" = 사용 가능). 순서: 모듈 → 권한 → 기기 → 컨텍스트. 모드 불일치는 사유가 아니다(전환 후 실행). */
    reasonOf(f) {
      if (f.needs === "soon") return "준비 중";
      if (f.mod && !this._modReady(f.mod)) return "준비 중";
      const perm = (typeof UI !== "undefined" && UI.permCheck) ? UI.permCheck(f.perm || "any") : "";
      if (perm) return perm;
      if (f.needs === "mobile") { const m = this._isMobileNav(); if (m) return m; }
      const P = (typeof Projects !== "undefined") ? Projects : null;
      if (f.needs === "project" && !(P && P.currentProject)) return "프로젝트를 먼저 여세요";
      if (f.needs === "deck" && !(P && P.currentDeck)) return "구역·영역을 먼저 여세요(트리에서 선택)";
      if (f.needs === "drawing" && !(typeof State !== "undefined" && State.fileType)) return "도면을 먼저 여세요";
      if (f.needs === "pano" && !this._panoOpen()) return "360 뷰어에서 사용 — 포인트를 눌러 360 을 여세요";
      if (f.click && typeof document !== "undefined" && !document.getElementById(f.click)) return "이 화면에서는 사용할 수 없습니다";
      // [WO 20261007-qrcov] 기능 자신의 사유 함수(정본은 그 모듈) — 숨김 금지, 비활성 + 사유
      if (typeof f.why === "function") { try { const w = f.why(); if (w) return w; } catch (e) { return "준비 중"; } }
      return "";
    },
    modeHint(f) {
      if (!f.mode || typeof State === "undefined") return "";
      if (State.regMode === f.mode) return "";
      return (f.mode === "checkboard" ? "CHECKER" : "360") + " 모드로 전환 후 실행";
    },

    /** 실행 — 사유가 있으면 토스트(실행 0). 모드가 다르면 App._setRegMode 로 전환 후 실행. */
    run(id) {
      const f = typeof id === "string" ? this._f(id) : id;
      if (!f) return false;
      const why = this.reasonOf(f);
      if (why) { this._toast(f.label + " — " + why); return false; }
      const exec = () => {
        try {
          if (f.click) { const el = document.getElementById(f.click); if (el && el.click) el.click(); }
          else if (f.run) f.run();
        } catch (e) { this._toast(f.label + " 실행 실패: " + ((e && e.message) || e)); }
      };
      if (f.mode && State.regMode !== f.mode && typeof App !== "undefined" && App._setRegMode) {
        App._setRegMode(f.mode);
        setTimeout(exec, 120);   // _setRegMode 가 openApp 으로 화면을 다시 그린 뒤 실행
      } else exec();
      this.close();
      return true;
    },
    _toast(m) { try { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast(m, 4200); } catch (e) {} },

    /* ─── 렌더(공유 생성기 — 데스크톱 패널·모바일 더보기 시트가 같이 쓴다) ─── */
    renderInto(host, query) {
      if (!host) return 0;
      const esc = (s) => (typeof UI !== "undefined" && UI.escapeHtml) ? UI.escapeHtml(String(s)) : String(s);
      const q = String(query || "").trim().toLowerCase();
      host.innerHTML = "";
      let shown = 0;
      this.GROUPS.forEach((g) => {
        const items = this.FEATURES.filter((f) => f.group === g.id).filter((f) => {
          if (!q) return true;
          return (f.label + " " + this.descOf(f) + " " + g.label + " " + (f.keys || "")).toLowerCase().indexOf(q) >= 0;
        });
        if (!items.length) return;
        const sec = document.createElement("section");
        sec.className = "fm-group";
        sec.dataset.group = g.id;
        const h = document.createElement("h3");
        h.className = "fm-group-title";
        h.textContent = g.label;
        sec.appendChild(h);
        items.forEach((f) => {
          const why = this.reasonOf(f);
          const hint = why ? "" : this.modeHint(f);
          const b = document.createElement("button");
          b.type = "button";
          b.className = "fm-item" + (why ? " is-disabled" : "") + (f.danger ? " danger" : "");
          b.dataset.feature = f.id;
          if (why) b.setAttribute("aria-disabled", "true");
          b.innerHTML = '<span class="fm-ico" aria-hidden="true">' + esc(f.icon || "•") + '</span>'
            + '<span class="fm-main"><span class="fm-label">' + esc(f.label) + (f.keys ? ' <kbd class="fm-keys">' + esc(f.keys) + '</kbd>' : "") + '</span>'
            + (this.descOf(f) ? '<span class="fm-desc">' + esc(this.descOf(f)) + '</span>' : "")
            + (why ? '<span class="fm-why">' + esc(why) + '</span>' : (hint ? '<span class="fm-mode">' + esc(hint) + '</span>' : ""))
            + '</span>';
          // 이벤트 전파는 막지 않는다 — 모바일 [더보기] 시트는 안의 버튼 클릭으로 닫힌다(06_PanoViewer 배선 재사용).
          b.addEventListener("click", () => this.run(f));
          sec.appendChild(b);
          shown++;
        });
        host.appendChild(sec);
      });
      if (!shown) { const p = document.createElement("p"); p.className = "fm-empty"; p.textContent = "‘" + query + "’ 에 맞는 기능이 없습니다"; host.appendChild(p); }
      return shown;
    },

    _panel: null,
    open() {
      const p = this._ensurePanel();
      if (!p) return;
      p.classList.remove("hidden");
      const inp = p.querySelector ? p.querySelector(".fm-search") : null;
      if (inp) inp.value = "";
      this.renderInto(p.querySelector ? p.querySelector(".fm-list") : null, "");
      const btn = document.getElementById("btn-feature-menu");
      if (btn) btn.setAttribute("aria-expanded", "true");
      try { if (inp && inp.focus) inp.focus(); } catch (e) {}
    },
    close() {
      const p = this._panel;
      if (p && p.classList) p.classList.add("hidden");
      const btn = typeof document !== "undefined" ? document.getElementById("btn-feature-menu") : null;
      if (btn) btn.setAttribute("aria-expanded", "false");
    },
    toggle() { if (this._panel && !this._panel.classList.contains("hidden")) this.close(); else this.open(); },
    _searchBox(onInput) {
      const wrap = document.createElement("div");
      wrap.className = "fm-search-wrap";
      const inp = document.createElement("input");
      inp.type = "search"; inp.className = "fm-search"; inp.placeholder = "기능 검색 (예: 정렬, 도면, 360)"; inp.setAttribute("aria-label", "기능 검색");
      inp.addEventListener("input", () => onInput(inp.value));
      inp.addEventListener("click", (e) => { if (e && e.stopPropagation) e.stopPropagation(); });
      wrap.appendChild(inp);
      return wrap;
    },
    _ensurePanel() {
      if (this._panel) return this._panel;
      if (typeof document === "undefined" || !document.body) return null;
      const p = document.createElement("div");
      p.id = "feature-menu";
      p.className = "fm-panel hidden";
      p.setAttribute("role", "dialog");
      p.setAttribute("aria-label", "전체 기능");
      const head = document.createElement("div");
      head.className = "fm-head";
      head.innerHTML = '<span class="fm-title">전체 기능</span>';
      const x = document.createElement("button");
      x.type = "button"; x.className = "fm-close"; x.setAttribute("aria-label", "닫기"); x.textContent = "✕";
      x.addEventListener("click", () => this.close());
      head.appendChild(x);
      p.appendChild(head);
      const list = document.createElement("div");
      list.className = "fm-list";
      p.appendChild(this._searchBox((v) => this.renderInto(list, v)));
      p.appendChild(list);
      document.body.appendChild(p);
      document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !p.classList.contains("hidden")) this.close(); });
      this._panel = p;
      return p;
    },
    /** 진입점 마운트 — 데스크톱 상단바 [☰ 전체 기능](설정 앞) · 모바일 [더보기] 시트 아래 같은 목록(검색 포함). */
    mount() {
      if (typeof document === "undefined") return;
      const top = document.getElementById("topbar");
      if (top && !document.getElementById("btn-feature-menu")) {
        const b = document.createElement("button");
        b.id = "btn-feature-menu";
        b.type = "button";
        b.className = "btn-feature-menu";
        b.title = "전체 기능 — 모든 기능을 한곳에서(권한이 없는 기능도 사유와 함께 보입니다)";
        b.setAttribute("aria-haspopup", "dialog");
        b.setAttribute("aria-expanded", "false");
        b.innerHTML = '<span aria-hidden="true">☰</span><span class="btn-feature-menu-label">전체 기능</span>';
        b.addEventListener("click", (e) => { if (e && e.stopPropagation) e.stopPropagation(); this.toggle(); });
        const settings = document.getElementById("btn-settings");
        if (settings && settings.parentNode === top) top.insertBefore(b, settings); else top.appendChild(b);
      }
      const sheet = document.getElementById("mdock-more-sheet");
      if (sheet && !document.getElementById("mdock-feature-menu")) {
        const box = document.createElement("div");
        box.id = "mdock-feature-menu";
        box.className = "fm-inline";
        const h = document.createElement("div");
        h.className = "fm-inline-title";
        h.textContent = "전체 기능";
        box.appendChild(h);
        const list = document.createElement("div");
        list.className = "fm-list";
        box.appendChild(this._searchBox((v) => this.renderInto(list, v)));
        box.appendChild(list);
        sheet.appendChild(box);
        this.renderInto(list, "");
        // 더보기를 열 때마다 권한·모드·도면 상태를 다시 반영(사유가 현재 상태와 어긋나지 않게)
        const tgl = document.getElementById("mdock-more-toggle");
        if (tgl) tgl.addEventListener("click", () => { const inp = box.querySelector ? box.querySelector(".fm-search") : null; this.renderInto(list, inp ? inp.value : ""); });
      }
    },
    init() { this.mount(); }
  };
