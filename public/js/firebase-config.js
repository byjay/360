/* ════════════════════════════════════════════════════════════
   SEASTAR · Firebase 설정 (본인 Google 계정으로 데이터 저장)
   ─────────────────────────────────────────────────────────────
   ▶ 사용법 (5분 세팅)
   1) https://console.firebase.google.com 접속 → 본인 Google ID로 로그인
   2) "프로젝트 추가" → 이름: seastar-viewer (원하는 이름)
   3) 좌측 톱니바퀴 → 프로젝트 설정 → "내 앱" → 웹앱(</>) 추가
   4) 표시되는 firebaseConfig 값을 아래 FIREBASE_CONFIG 에 그대로 붙여넣기
   5) Authentication → 시작하기 → "Google" 공급업체 사용 설정
   6) Firestore Database → 데이터베이스 만들기 → (테스트/프로덕션 모드)
   7) Storage → 시작하기 (도면/파노라마 파일 저장용, 선택)

   ※ 이 값들은 "비밀키"가 아니라 공개되어도 되는 클라이언트 식별자입니다.
     실제 보안은 Firestore/Storage 보안 규칙으로 제어합니다 (아래 가이드 참고).
════════════════════════════════════════════════════════════ */

/* ── 기본값(코드에 직접 박는 경우) ── */
var __FB_DEFAULT = {
  apiKey:            "YOUR_API_KEY",              // ← 콘솔의 apiKey
  authDomain:        "YOUR_PROJECT.firebaseapp.com",
  projectId:         "YOUR_PROJECT_ID",
  storageBucket:     "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId:             "YOUR_APP_ID"
};

/* ────────────────────────────────────────────────────────────
   ★ 자동 세팅: 설정 화면에서 입력한 값(localStorage)을 최우선 적용.
     → 마스터가 코드 파일을 손대지 않고, 앱 안에서 "내 ID로 등록만"
       하면 새로고침 시 자동으로 Firebase가 켜집니다.
   ──────────────────────────────────────────────────────────── */
(function () {
  var saved = null, savedEmail = "";
  try {
    var raw = localStorage.getItem("seastar.firebaseConfig");
    if (raw) saved = JSON.parse(raw);
    savedEmail = localStorage.getItem("seastar.firebaseOwnerEmail") || "";
  } catch (e) {}

  window.FIREBASE_CONFIG = (saved && saved.apiKey) ? saved : __FB_DEFAULT;

  /* 본인 Google 계정 이메일 (super-admin) — 설정값 > 기본값 */
  window.FIREBASE_OWNER_EMAIL = savedEmail || "designssir@gmail.com";

  /* Firebase 사용 여부 자동 판정 (placeholder 가 남아있으면 비활성) */
  window.FIREBASE_ENABLED =
    !!window.FIREBASE_CONFIG.apiKey &&
    !String(window.FIREBASE_CONFIG.apiKey).startsWith("YOUR_");

  /* ── 설정 저장/해제 헬퍼(설정 UI에서 호출) ── */
  window.SeaFirebaseConfig = {
    save: function (cfg, ownerEmail) {
      localStorage.setItem("seastar.firebaseConfig", JSON.stringify(cfg));
      if (ownerEmail) localStorage.setItem("seastar.firebaseOwnerEmail", ownerEmail);
    },
    clear: function () {
      localStorage.removeItem("seastar.firebaseConfig");
      localStorage.removeItem("seastar.firebaseOwnerEmail");
    },
    current: function () { return window.FIREBASE_CONFIG; },
    isEnabled: function () { return !!window.FIREBASE_ENABLED; },
    /* 콘솔의 "firebaseConfig = { ... }" 또는 순수 JSON 붙여넣기 → 객체로 파싱 */
    parsePasted: function (text) {
      if (!text) return null;
      var t = String(text).trim();
      // const firebaseConfig = { ... }; 형태에서 객체 본문만 추출
      var m = t.match(/\{[\s\S]*\}/);
      if (m) t = m[0];
      // 키에 따옴표 없는 JS 객체도 허용 → 안전 파서
      try { return JSON.parse(t); } catch (e) {}
      try {
        // 키:값 형태를 정규화 (apiKey: "x" → "apiKey":"x")
        var norm = t
          .replace(/([{,]\s*)([A-Za-z0-9_]+)\s*:/g, '$1"$2":')
          .replace(/,(\s*})/g, '$1')
          .replace(/'/g, '"');
        return JSON.parse(norm);
      } catch (e2) { return null; }
    }
  };
})();
