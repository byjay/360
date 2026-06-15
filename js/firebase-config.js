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

window.FIREBASE_CONFIG = {
  apiKey:            "YOUR_API_KEY",              // ← 콘솔의 apiKey
  authDomain:        "YOUR_PROJECT.firebaseapp.com",
  projectId:         "YOUR_PROJECT_ID",
  storageBucket:     "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId:             "YOUR_APP_ID"
};

/* 본인 Google 계정 이메일 (super-admin) — 비워두면 백엔드 SUPER_ADMIN 사용 */
window.FIREBASE_OWNER_EMAIL = "designssir@gmail.com";

/* Firebase 사용 여부 자동 판정 (placeholder 가 남아있으면 비활성) */
window.FIREBASE_ENABLED = !String(window.FIREBASE_CONFIG.apiKey).startsWith("YOUR_");
