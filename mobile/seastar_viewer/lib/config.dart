/// ════════════════════════════════════════════════════════════
///  SEASTAR Viewer — 전역 설정
///  ⚠️ 프로덕션 배포 후, 아래 kApiBaseUrl 만 본인 Cloudflare Pages 주소로 교체하세요.
///     예) https://seastar-viewer.pages.dev
/// ════════════════════════════════════════════════════════════
class AppConfig {
  /// 백엔드 API 베이스 URL (끝에 '/' 없이)
  static const String kApiBaseUrl =
      'https://3000-iqtsdhe42ft6qbmasacvh-5c13a017.sandbox.novita.ai';

  /// 브랜드 컬러
  static const int kDeepBlue = 0xFF0A2540; // 딥블루
  static const int kGold = 0xFFC9A227;     // 골드
  static const int kAccentBlue = 0xFF1B75BB;

  static const String appName = 'SEASTAR 뷰어';
  static const String company = 'SEASTAR Inc. · 씨스타';
}
