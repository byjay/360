/**
 * 360° Location Viewer System — We:are Marine  (v3)
 *
 * v3 주요 변경:
 *  - 360° 뷰어: CPU 픽셀루프 → Three.js WebGL (수십 배 빠름, 자동회전/줌/초기시점/전체화면 컨트롤)
 *  - 핀 생성 시 그림 파일 직접 업로드 + 저장 이름 지정 → 클라우드(테이블 API)에 영구 저장
 *  - 저장 직후 "다음 포인트 지정" 버튼으로 연속 배치 워크플로우
 *  - 핀 저장/선택 시 해당 위치로 플라이투(줌인 이동) 애니메이션 + 핀 드롭 모션
 *  - PDF 멀티페이지: 핀에 page 기록, 배포 시 전 페이지 스냅샷, 뷰어에서 페이지 전환 지원
 *
 * 의존: PDF.js 3.11.174 / Three.js 0.147.0 (모두 CDN)
 */

(function () {
  "use strict";

  /* ══════════════════════════════════════════
     STATE
  ══════════════════════════════════════════ */
  // [B5] 영상 핀 blob URL 추적 — reset/삭제 시 revoke 하여 메모리 누수 차단
  const _videoBlobs = [];
  function _trackVideoBlob(url) { if (url) _videoBlobs.push(url); }
  function _revokeVideoBlob(url) {
    if (!url) return;
    const i = _videoBlobs.indexOf(url);
    if (i !== -1) _videoBlobs.splice(i, 1);
    try { URL.revokeObjectURL(url); } catch (e) {}
  }
  function _revokeAllVideoBlobs() {
    _videoBlobs.splice(0).forEach(u => { try { URL.revokeObjectURL(u); } catch (e) {} });
  }
