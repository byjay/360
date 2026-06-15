# SEASTAR · Firebase 세팅 가이드 (본인 Google ID로 데이터 저장)

## 1. Firebase 프로젝트 만들기 (5분)
1. https://console.firebase.google.com → 본인 Google 계정(`designsir102@gmail.com`)으로 로그인
2. **프로젝트 추가** → 이름 `seastar-viewer`
3. ⚙️ 프로젝트 설정 → **내 앱** → 웹앱(`</>`) 등록
4. 표시되는 `firebaseConfig` 값을 `public/js/firebase-config.js` 의 `FIREBASE_CONFIG` 에 붙여넣기
5. **Authentication → 시작하기 → Google** 공급업체 사용 설정 (지원 이메일: 본인 Gmail)
6. **Firestore Database → 데이터베이스 만들기**
7. (선택) **Storage → 시작하기** — 도면/파노라마 원본 저장용

설정값을 채우면 앱이 자동으로 Firebase를 활성화합니다(`FIREBASE_ENABLED` 자동 판정).

## 2. Firestore 보안 규칙 (본인만 쓰기, 누구나 읽기)
Firestore → 규칙 탭에 붙여넣기:
```
rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    // 누구나 조회, 로그인 사용자만 쓰기
    match /{col}/{doc} {
      allow read: if true;
      allow write: if request.auth != null;
    }
    // super-admin 전용 로그
    match /activity_log/{doc} {
      allow read, write: if request.auth.token.email == "designsir102@gmail.com";
    }
  }
}
```

## 3. Storage 보안 규칙 (선택)
```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read: if true;
      allow write: if request.auth != null;
    }
  }
}
```

## 4. 승인된 도메인
Authentication → 설정 → **승인된 도메인** 에 배포 도메인 추가
(예: `seastar-viewer.pages.dev`, `seastargo.com`)

## 5. 아키텍처 메모
- **Cloudflare D1/R2** = 기본 백엔드(현재 동작). 서버리스 API(`/tables/*`, `/api/r2/*`).
- **Firebase** = 본인 Google 계정 기반의 대체/병행 저장소. `SeaFirebase.*` API로 사용.
- 둘은 독립적으로 동작하며, Firebase 미설정 시 자동으로 D1/R2만 사용합니다.
