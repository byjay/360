  const State = {
    mode:        null,      // 'designer' | 'viewer'
    checkboard:  false,     // 체크보드 모드: 디자이너와 동일하나 핀에 이름 대신 번호만 자동 부여
    fileType:    null,      // 'pdf' | 'image'
    fileName:    null,
    imageUrl:    null,      // blob URL (revoke on reset)
    fileData:    null,      // ArrayBuffer (PDF)
    pdfDoc:      null,
    pdfPage:     1,
    pdfPages:    0,
    pdfRotation: 0,         // 0 | 90 | 180 | 270 (PDF.js 내장 회전)
    viewerPages: null,      // 뷰어 모드: 배포본 페이지 dataURL 배열
    pins:        [],        // {id,x,y,page,label,imageUrl?,imageId?,imageName?}
    annotations: [],        // {id,page,type:'highlight'|'rect'|'pen'|'text',color,...좌표(%)} PDF 주석
    annoTool:    "cursor",  // 현재 주석 도구
    annoColor:   "#ff3b30", // 현재 주석 색상
    zones:       [],        // {id,page,x,y,w,h,label,color,pinIds[],note} 영역(%) 줌무관
    placing:     false,
    drawingZone: false,     // 영역 그리기 모드
    isoView:     false,     // ISO 3D 아이소메트릭 뷰 (평면↔입체 회전)
    isoDir:      0,          // ISO 시점 방향 0~3 (북동/남동/남서/북서) — 4방향 회전
    pending:     null,      // { x, y }
    pendingFile: null,      // 선택된 360° 그림/영상 파일
    pendingIsVideo: false,
    pendingDocs: [],        // 첨부 문서 후보 [{tempId, file, name, size, kind, status, docId}]
    pendingFls:  null,      // 첨부된 3D 포인트클라우드 { localId, name, size }
    editingPinId: null,     // 기존 포인트 편집 중인 id (null=신규)
    movingPinId: null,      // 드래그로 위치 이동 중인 포인트 id
    pinEditUnlocked: null,  // '수정' 버튼으로 이동/편집 잠금 해제된 핀 id (이 id만 드래그 이동 가능)
    autoSaveDepId: null,    // 자동 저장된 배포본(작업본) id — 도면 업로드 즉시 생성
    autoSaving: false,      // 자동 저장 진행 중 플래그
    depVersion: 0,          // ★[멀티유저 충돌방지] 현재 로드된 배포본의 서버 version(낙관적 잠금 기준값)
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
    checkboardStart: {},         // { [page]: 시작번호 } 구역(페이지)별 체크보드 시작 번호
    zoneView:    null,           // 구역 페이지(crop-view) 진입 중인 zone id — null이면 전체 도면

    reset() {
      if (this.imageUrl) { URL.revokeObjectURL(this.imageUrl); this.imageUrl = null; }
      _revokeAllVideoBlobs(); // [B5] 영상 핀 blob URL 일괄 해제
      this.fileType = null; this.fileName = null;
      this.fileData = null; this.pdfDoc = null;
      this.pdfPage = 1; this.pdfPages = 0; this.pdfRotation = 0; this.viewerPages = null;
      this.pins = []; this.zones = []; this.placing = false; this.drawingZone = false; this.pending = null;
      this.pendingFile = null; this.pendingIsVideo = false;
      this.pendingDocs = [];
      this.pendingFls = null;
      this.editingPinId = null; this.movingPinId = null;
      this.autoSaveDepId = null; this.autoSaving = false; this.depVersion = 0;
      this.activePin = null; this.zoom = 1; this.pan = { x: 0, y: 0 };
    }
  };

  /* ══════════════════════════════════════════
     PDF MODULE
  ══════════════════════════════════════════ */