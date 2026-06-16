# 360° Location Viewer — APK 패키징 가이드

이 앱은 **PWA(Progressive Web App)** 로 완성되어 있어, 별도 네이티브 개발 없이
배포 URL을 그대로 **Android APK / AAB** 로 래핑할 수 있습니다.

## 1. PWA 준비 상태 (이미 완료됨)

| 항목 | 상태 | 비고 |
|---|---|---|
| `manifest.webmanifest` | ✅ | name/short_name/icons/maskable/shortcuts 완비 |
| 앱 아이콘 192·512 | ✅ | `images/icon-{192,512}.png` (정사각형) |
| maskable 아이콘 | ✅ | `images/icon-maskable-{192,512}.png` (Android 적응형) |
| Service Worker | ✅ | `sw.js` (CACHE v3) — 오프라인 셸 + 샘플 PLY 캐시 |
| `start_url` / `scope` | ✅ | `./` (상대경로, 어느 도메인에서도 동작) |
| theme/background color | ✅ | `#0b1220` (다크 네이비) |
| HTTPS | ✅ | Cloudflare Pages 자동 제공 |

→ **PWA 설치 기준(installability) 충족.** 모바일 크롬에서 "홈 화면에 추가" 즉시 가능.

## 2. APK로 만드는 방법 (3가지 경로)

### 경로 A — PWABuilder (가장 쉬움, 권장)
1. 앱을 Cloudflare Pages에 배포 → 공개 URL 확보 (예: `https://360viewer.pages.dev`)
2. https://www.pwabuilder.com 접속 → URL 입력 → **Start**
3. 점수 리포트 확인 (manifest/SW/보안 항목 모두 녹색이어야 함)
4. **Package For Stores → Android** 선택
5. 패키지 옵션:
   - Package ID: `app.seastargo.viewer360` (역도메인 형식)
   - App name: `360 Viewer`
   - 서명 키: 신규 생성(.keystore) 또는 기존 키 업로드
6. **Generate** → `.apk`(테스트용) + `.aab`(Play 스토어용) + `signing key` ZIP 다운로드
7. `.apk` 를 안드로이드 기기에 직접 설치(사이드로드)하여 테스트

### 경로 B — Bubblewrap CLI (직접 빌드, 로컬 환경 필요)
> 이 샌드박스(Cloudflare Workers 런타임)에서는 Android SDK/JDK를 실행할 수 없으므로
> **로컬 PC 또는 CI 환경**에서 진행하세요.

```bash
# 사전 요구: Node 18+, JDK 17, Android SDK
npm install -g @bubblewrap/cli

# 1) manifest URL로 프로젝트 초기화
bubblewrap init --manifest=https://360viewer.pages.dev/manifest.webmanifest

#   (대화형으로 packageId, appName, signing key 등 입력)
#   - Application ID: app.seastargo.viewer360
#   - Host: 360viewer.pages.dev

# 2) APK/AAB 빌드
bubblewrap build

# 산출물: app-release-signed.apk, app-release-bundle.aab
```

### 경로 C — Capacitor (네이티브 기능 확장이 필요할 때)
카메라/파일시스템 등 네이티브 플러그인이 추가로 필요하면 Capacitor 래핑 고려:
```bash
npm install @capacitor/core @capacitor/cli @capacitor/android
npx cap init "360 Viewer" app.seastargo.viewer360 --web-dir=dist
npx cap add android
npx cap sync
npx cap open android   # Android Studio에서 빌드
```

## 3. TWA Digital Asset Links (경로 A·B 사용 시 필수)

TWA(Trusted Web Activity)는 주소창을 숨기려면 **도메인 소유 증명**이 필요합니다.
PWABuilder/Bubblewrap이 생성한 `assetlinks.json` 을 배포 도메인의 다음 경로에 올리세요:

```
https://<도메인>/.well-known/assetlinks.json
```

내용 예시(서명 키의 SHA-256 지문 필요):
```json
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "app.seastargo.viewer360",
    "sha256_cert_fingerprints": ["<APK 서명키 SHA-256 지문>"]
  }
}]
```

> Cloudflare Pages에서는 `public/.well-known/assetlinks.json` 로 두면 자동 서빙됩니다.
> 이 파일이 없으면 APK 실행 시 주소창이 보입니다(기능은 정상 동작).

## 4. 오프라인 동작 확인 체크리스트
- [ ] 첫 실행(온라인) 후 비행기 모드로 전환 → 앱 셸/도면/샘플 3D 로드 OK
- [ ] PDF 도면: `vendor/pdf.worker.min.js` 캐시되어 오프라인 렌더 OK
- [ ] 3D 샘플: `samples/seastar-fsru.ply` 캐시되어 오프라인 로드 OK
- [ ] 핀 등록 등 쓰기 작업 → IndexedDB 큐(SyncQueue)에 적재 후 온라인 시 동기화

## 5. 주의 사항
- **이 에이전트(Cloudflare 샌드박스)에서는 APK를 직접 빌드할 수 없습니다.** Android SDK/JDK
  네이티브 툴체인이 필요하므로, 위 경로 A(PWABuilder, 브라우저만으로 가능) 또는 로컬 PC를 사용하세요.
- 서명 키(.keystore)는 **반드시 안전하게 백업**하세요. 분실 시 Play 스토어 앱 업데이트가 불가능합니다.
- Play 스토어 등록 시에는 `.aab`(Android App Bundle), 사이드로드 테스트는 `.apk` 를 사용합니다.
