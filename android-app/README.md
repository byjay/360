# SEASTAR 360 Android APK (Capacitor 7, 원격 URL 모드)

출처: 창고 `13-misc-app-parts/capacitor-local-bundle-android` (함정 7종 그대로 적용). 웹 쪽 안내/연결은 `public/js/modules/38c_ApkInstall.js`.

## 구조
- `capacitor.config.json` — `server.url` = 배포 사이트. 앱은 그 사이트를 그대로 띄운다(웹 배포 = 앱 갱신). `www/offline.html` = 첫 실행 오프라인 화면.
- `android/app/src/main/java/work/seastar/scan360/SeastarNativePlugin.java` — 공유 받기(ACTION_SEND image/*) · THETA 앱 열기(`intent://` → 패키지 런처, 그 외 Intent 는 열지 않음).
- 버전 SoT = `package.json` `version`(x.y.z) → versionCode = x*10000 + y*100 + z (`android/app/build.gradle`).

## 빌드 → 배포 파일 생성
```
cd android-app && npm install            # npm_config_cache 는 E: 로 (CLAUDE.md G-5)
npx cap sync android
scripts\build-apk.bat                    # JBR 21, GRADLE_USER_HOME/TEMP = <repo>\.tmp
node scripts/publish-apk.mjs             # public/download/seastar360.apk + seastar360.json(버전·크기·SHA-256·서명지문)
```
아이콘: `python scripts/generate_icons.py` (원본 = `public/images/icon-maskable-512.png`).

## 서명 — 🔴 키스토어를 잃으면 업데이트 불가
- 키스토어·비밀번호 파일은 저장소 밖 `E:\code-project\_keystores\` 에만 있다. 비밀번호는 창고 `secrets.json` 의 `keystores.seastar360.password`.
- 같은 키로 서명해야 기존 설치 위에 덮어 설치된다. 키를 잃으면 사용자는 앱을 지우고 새로 설치해야 한다(로컬 데이터 소실). **백업 2곳 이상 필수.**
- 경로 변경: 환경변수 `SEASTAR360_KEYSTORE_PROPERTIES`. 설정이 없으면 릴리스 빌드는 실패한다(미서명 APK 를 조용히 만들지 않음).
