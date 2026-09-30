  /* [P14 설계 메모] 원본 PDF 를 `State.pdfDoc` 에 넣지 않고 `State.srcPdfDoc` 로 분리한 이유:
     `State.pdfDoc` 는 "지금 화면을 PDF 캔버스 파이프라인으로 그리고 있다"는 뜻으로
     UI.renderPdfThumbs / Radar._buildHiResSnapshot / PinGrid / App._rotatePdf 가 분기한다.
     뷰어(스냅샷 <img> 바탕)에서 여기에 문서를 넣으면 그 형제 호출부들이 전부 오작동한다.
     두 값은 같은 사실의 중복이 아니라 서로 다른 사실이며,
     "재래스터할 원본이 있는가" 는 MapCtrl.hasRerenderSource() 한 곳에서만 파생시킨다. */
  const State = {
    mode:        null,      // 'designer' | 'viewer'
    checkboard:  false,     // 체크보드 모드: 디자이너와 동일하나 핀에 이름 대신 번호만 자동 부여
    editMode:    false,     // [마스터 요청] 포인트 수정 모드: ON이면 핀 클릭 시 수정/이동/삭제 팝업
    fileType:    null,      // 'pdf' | 'image'
    fileName:    null,
    imageUrl:    null,      // blob URL (revoke on reset)
    fileData:    null,      // ArrayBuffer (PDF)
    pdfDoc:      null,
    pdfPage:     1,
    pdfPages:    0,
    pdfRotation: 0,         // 0 | 90 | 180 | 270 (PDF.js 내장 회전)
    viewerPages: null,      // 뷰어 모드: 배포본 페이지 dataURL 배열
    /* ── [P14] 배포 스냅샷의 "원본 PDF" (확대 시 재래스터용) ──
       뷰어/구역 재열람은 배포 스냅샷(비트맵)만 그리므로 확대하면 뭉갠다.
       배포 시 R2 에 보관해 둔 원본 PDF 를 임계 배율을 넘겼을 때만 1회 지연 로드한다. */
    sourceMeta:   null,     // 배포본 source_meta 파싱 결과 { v, pdf_url, pages:[{w,h,pw,ph}] }
    sourcePdfUrl: null,     // 원본 PDF 의 R2 URL (없으면 구버전 배포본 = 스냅샷 확대 폴백)
    srcPdfDoc:    null,     // 지연 로드된 원본 PDFDocumentProxy (State.pdfDoc 과 별개 — 아래 주석)
    srcNoticed:   false,    // 구버전 안내를 이미 1회 했는가(반복 알림 금지)
    srcFailed:    false,    // 원본 다운로드/파싱 실패 — 재시도 금지(불필요 다운로드 0)
    pins:        [],        // {id,x,y,page,label,imageUrl?,imageId?,imageName?}
    annotations: [],        // {id,page,type:'highlight'|'rect'|'pen'|'text',color,...좌표(%)} PDF 주석
    annoTool:    "cursor",  // 현재 주석 도구
    annoColor:   "#ff3b30", // 현재 주석 색상
    zones:       [],        // {id,page,x,y,w,h,label,color,pinIds[],note} 영역(%) 줌무관
    // [WO 20260929-bulkdel] 핀 삭제 부활 방지(20_App._mergePins) — 도면 단위, reset() 에서 초기화.
    pinTombstones: {},      // { [String(pinId)]: 삭제시각ms } 이 도면에서 내가 지운 핀
    pinBaseIds:   null,     // 내가 아는 서버 버전(depVersion)의 핀 id 목록(String[]) — null=모름
    placing:     false,
    drawingZone: false,     // 영역 그리기 모드
    isoView:     false,     // ISO 3D 아이소메트릭 뷰 (평면↔입체 회전)
    isoDir:      0,          // ISO 시점 방향 0~3 (북동/남동/남서/북서) — 4방향 회전
    pending:     null,      // { x, y }
    intakeFile:  null,      // [THETA 인입] 위치지정 대기 중인 R* 360 사진 파일 (도면 탭 시 핀에 주입)
    pendingFile: null,      // 선택된 360° 그림/영상 파일
    pendingIsVideo: false,
    pendingDocs: [],        // 첨부 문서 후보 [{tempId, file, name, size, kind, status, docId}]
    pendingFls:  null,      // 첨부된 3D 포인트클라우드 { localId, name, size }
    pendingIcon: "number",  // [마스터 요청] 핀(호스팟)별 아이콘 선택값 (기본=번호)
    editingPinId: null,     // 기존 포인트 편집 중인 id (null=신규)
    movingPinId: null,      // 드래그로 위치 이동 중인 포인트 id
    pinEditUnlocked: null,  // '수정' 버튼으로 이동/편집 잠금 해제된 핀 id (이 id만 드래그 이동 가능)
    autoSaveDepId: null,    // 자동 저장된 배포본(작업본) id — 도면 업로드 즉시 생성
    autoSaving: false,      // 자동 저장 진행 중 플래그
    depVersion: 0,          // [멀티유저 충돌방지] 현재 로드된 배포본의 서버 version(낙관적 잠금 기준값)
    activePin:   null,
    zoom:        1,
    pan:         { x: 0, y: 0 },
    panDragging: false,
    panStart:    { mx: 0, my: 0, px: 0, py: 0 },
    viewerLocked: false,
    currentProjectId: null,
    currentProjectName: null,
    currentDeploymentId: null,   // 현재 로드된 배포본 id (노트/협업 연결용)
    noteSummary: {},             // { pin_id: {total,open,progress,done} } 도면 뱃지용
    pinColor:    null,           // 핀 기본 색상(설정에서 변경) — null이면 PinPrefs 기본(green)
    checkboardStart: {},         // [WO 20260929 addendum] { checkboard:{page:n}, content:{page:n} } 계열별·구역(페이지)별 시작 번호 — SoT 정규화는 App._normalizeCheckboardStart()(20_App.js)
    zoneView:    null,           // 구역 페이지(crop-view) 진입 중인 zone id — null이면 전체 도면

    reset() {
      if (this.imageUrl) { URL.revokeObjectURL(this.imageUrl); this.imageUrl = null; }
      _revokeAllVideoBlobs(); // [B5] 영상 핀 blob URL 일괄 해제
      this.fileType = null; this.fileName = null;
      this.fileData = null; this.pdfDoc = null;
      this.pdfPage = 1; this.pdfPages = 0; this.pdfRotation = 0; this.viewerPages = null;
      // [P14] 원본 PDF 지연 로드 상태 초기화 — 도면이 바뀌면 이전 원본은 거짓 화면이 된다.
      this.sourceMeta = null; this.sourcePdfUrl = null; this.srcPdfDoc = null;
      this.srcNoticed = false; this.srcFailed = false;
      this.pins = []; this.zones = []; this.pinTombstones = {}; this.pinBaseIds = null; this.placing = false; this.drawingZone = false; this.pending = null;
      this.pendingFile = null; this.pendingIsVideo = false;
      this.pendingDocs = [];
      this.pendingFls = null;
      this.pendingIcon = "number";
      this.editingPinId = null; this.movingPinId = null;
      this.autoSaveDepId = null; this.autoSaving = false; this.depVersion = 0;
      this.activePin = null; this.zoom = 1; this.pan = { x: 0, y: 0 };
    }
  };

  /* ══════════════════════════════════════════
     PDF MODULE
  ══════════════════════════════════════════ */