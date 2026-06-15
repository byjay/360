# 씨스타 뷰어 (SEASTAR Viewer) — Flutter 모바일 연동 앱

SEASTAR 360° Location Viewer System 의 **모바일 동반 앱**입니다.
웹(Cloudflare Pages) 백엔드와 동일한 REST API 를 사용해, 현장에서 스마트폰으로
도면 위 핀을 탭하면 360° THETA 파노라마를 전방위로 둘러볼 수 있습니다.

## 주요 기능
- 배포본(도면 스냅샷) 목록 조회 (당겨서 새로고침)
- 도면 핀치 줌 / 팬 (PhotoView) + 핀 오버레이
- 핀 탭 → 360° 파노라마 뷰어 (드래그/핀치/자이로)
- 멀티 페이지 도면 페이지 이동
- 핀 정보(메모·3D 첨부 표시) 바텀시트
- 한글(UTF-8) 완전 지원

> 3D 포인트클라우드(FLS/E57/LAS) 뷰는 데스크톱 웹 뷰어에서 표시됩니다.
> 모바일에서는 핀 정보에 "3D 연결됨"으로 표기됩니다.

## 폴더 구조
```
seastar_viewer/
├── pubspec.yaml
├── analysis_options.yaml
├── lib/
│   ├── config.dart              # ★ API 주소/색상/앱이름 (배포 시 여기만 수정)
│   ├── main.dart
│   ├── models/
│   │   ├── pin.dart
│   │   └── deployment.dart
│   ├── services/
│   │   └── api_service.dart
│   ├── widgets/
│   │   └── smart_image.dart
│   └── screens/
│       ├── home_screen.dart     # 배포본 목록
│       ├── drawing_screen.dart  # 도면 + 핀
│       └── panorama_screen.dart # 360 뷰어
└── android/app/src/main/
    ├── AndroidManifest.xml      # INTERNET 권한 포함
    ├── res/values/styles.xml
    └── kotlin/.../MainActivity.kt
```

## 빌드 방법 (Android APK)

이 패키지에는 Dart 소스 + 핵심 Android 설정만 포함되어 있습니다.
Flutter SDK/Gradle 버전 호환을 위해, **플랫폼 폴더는 flutter 가 자동 생성**하도록 합니다.

```bash
# 1) 압축 해제 후 폴더로 이동
cd seastar_viewer

# 2) (중요) API 주소를 운영 도메인으로 변경
#    lib/config.dart 의 kApiBaseUrl 을 본인의 Cloudflare Pages 주소로 수정
#    예: 'https://seastar-viewer.pages.dev'

# 3) Android/iOS 플랫폼 폴더 생성 (기존 lib/는 보존됨)
flutter create . --platforms=android,ios --org com.seastar

# 4) 우리가 제공한 AndroidManifest.xml(INTERNET 권한) 유지 확인
#    flutter create 가 덮어썼다면 android/app/src/main/AndroidManifest.xml 에
#    <uses-permission android:name="android.permission.INTERNET"/> 가 있는지 확인

# 5) 패키지 설치
flutter pub get

# 6) 디버그 실행(연결된 기기/에뮬레이터)
flutter run

# 7) 릴리즈 APK 빌드
flutter build apk --release
#    결과물: build/app/outputs/flutter-apk/app-release.apk
```

### iOS 빌드 (선택)
```bash
flutter build ios --release   # macOS + Xcode 필요
```

## 설정 (lib/config.dart)
| 키 | 설명 | 기본값 |
|----|------|--------|
| `kApiBaseUrl` | 백엔드 API 주소 | (개발 샌드박스 주소) |
| `kDeepBlue` | 메인 딥블루 | `0xFF0A2540` |
| `kGold` | 포인트 골드 | `0xFFC9A227` |
| `appName` | 앱 표시 이름 | `SEASTAR 뷰어` |

> **운영 배포 전 반드시 `kApiBaseUrl` 을 운영 도메인으로 변경하세요.**

## 사용 API (백엔드와 동일)
| 메서드 | 경로 | 용도 |
|--------|------|------|
| GET | `/tables/deployments?limit=100` | 배포본 목록 |
| GET | `/tables/deployments/:id` | 배포본 상세(pages_data, pins) |
| GET | `/tables/pano_images/:id` | 360 이미지 dataURL |

## 의존 패키지
- `http` — REST 통신
- `provider` — 상태관리
- `photo_view` — 도면 줌/팬
- `panorama_viewer` — 360 파노라마
- `cached_network_image` — 이미지 캐시
- `url_launcher` — 외부 링크

---
© SEASTAR Inc. (씨스타) — Busan Shipbuilding & Offshore Design
