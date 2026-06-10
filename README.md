# 360° Location Viewer System — We:are Marine (v3)

> Ricoh THETA 호환 · Three.js WebGL 기반 GPU 파노라마 뷰어

선박/시설 도면(PDF·이미지) 위에 위치 포인트(핀)를 배치하고, 핀마다 360° 파노라마
이미지/영상을 연결해 현장을 탐색하는 정적 웹 시스템입니다.

---

## 🆕 v3 핵심 변경 (요청 반영)

| # | 요청 내용 | 구현 |
|---|-----------|------|
| 1 | 360° 뷰어 성능 (CPU 픽셀루프 버벅임) | ✅ **Three.js SphereGeometry GPU 렌더링**으로 전면 교체 (60fps·모바일 터치) |
| 2 | Ricoh THETA 파일 연동 | ✅ Equirectangular **.jpg/.png** + **.mp4 360° 영상**(VideoTexture) 지원 |
| 3 | 포인트 지정 시 정확한 위치로 이동 | ✅ 클릭 좌표로 **플라이투(flyTo) 줌인 애니메이션** |
| 4 | 핀 형식(드롭 모션) | ✅ 핀 생성 시 **drop 애니메이션** + 포커스 하이라이트 |
| 5 | 그림 파일 저장 + 이름 지정 | ✅ 파일 선택 → **저장 이름 입력** → 리사이즈 |
| 6 | 클라우드 서버 업로드/저장 | ✅ **테이블 API(`tables/pano_images`)에 영구 저장** |
| 7 | 다음 포인트 연속 지정 | ✅ 저장 직후 **"＋ 다음 포인트 지정"** 버튼으로 연속 배치 |
| 8 | 사용자 뷰: 핀 클릭 → 팝업 뷰어 | ✅ 핀 클릭 → 플라이투 → 360° 팝업 자동 오픈 |
| 9 | 뷰어 컨트롤 | ✅ 자동회전·줌±·초기시점·전체화면 컨트롤 바 |

---

## ⚠️ Ricoh THETA 파일 형식별 지원 범위 (정직한 한계)

| 형식 | 지원 | 비고 |
|------|------|------|
| `.jpg` / `.png` (Equirectangular) | ✅ 완전 지원 | GPU 텍스처 매핑, 클라우드 영구 저장 |
| `.mp4` / `.webm` (360° 영상) | ✅ 지원 | `THREE.VideoTexture`. **로컬 파일은 미리보기 전용**(테이블 용량 한계) → 배포용은 **영상 URL 직접 입력** 권장 |
| `.dng` (RAW) | ❌ 불가 | 브라우저에서 RAW 디코딩 불가(서버/네이티브 필요 = 정적 사이트 범위 밖). THETA 앱에서 JPG/MP4로 내보낸 파일 사용 |

---

## 360° 뷰어 구현 방식 (Three.js 표준)

```js
const geometry = new THREE.SphereGeometry(500, 60, 40);
geometry.scale(-1, 1, 1);                       // 구 내부에서 바라보기
const texture  = new THREE.Texture(img);        // 이미지
// const texture = new THREE.VideoTexture(video); // 360° 영상
const material = new THREE.MeshBasicMaterial({ map: texture });
const mesh     = new THREE.Mesh(geometry, material);
// 카메라 lon/lat → 구면 좌표로 lookAt, FOV로 줌
```
→ GPU 가속 + 실시간 60fps + 모바일 터치 전부 해결.

---

## 진입점 (URI)

| 경로 | 설명 |
|------|------|
| `/` → `index.html` | 홈(모드 선택) + 소스 ZIP 다운로드 버튼 |
| `/?mode=viewer` | **일반인 뷰어 전용**(업로드/배포 잠금). `&d` 없으면 **최신** 배포본 자동 로드 |
| `/?mode=viewer&d=<배포ID>` | **특정 배포본 고정 공유 링크**(배포 시 자동 발급). 새 도면을 배포해도 이 링크는 항상 같은 배포본을 표시 |
| `/?demo360=<이미지URL>` | 파노라마 직접 오픈(테스트 훅) |

---

## 워크플로우 (설계자)

1. **도면 업로드** (PDF 멀티페이지 / PNG / JPG)
2. **＋ 위치 포인트 추가** → 도면 클릭 → 클릭 위치로 줌인(플라이투)
3. 폼에서: 위치명 입력 + **그림(.jpg)/영상(.mp4) 파일 선택** + **저장 이름 지정**
   - 또는 **URL 직접 입력**(이미지/영상 자동 판별)
4. **☁ 저장 & 업로드** → 이미지가 클라우드(`pano_images`)에 영구 저장, 핀 드롭
5. **＋ 다음 포인트 지정** → 2~4 반복(연속 배치)
6. **🚀 뷰어로 배포** → 전 페이지 스냅샷 + 핀이 `deployments`에 저장 → 뷰어 링크 발급

## 워크플로우 (일반인 뷰어)

1. `?mode=viewer` 링크 접속 → 최신 배포 도면 자동 로드
2. 핀 클릭(또는 리스트 클릭) → 해당 페이지·위치로 이동 → **360° 팝업**
3. 드래그(시점)·휠(줌)·자동회전·전체화면 컨트롤

---

## 데이터 모델 (RESTful Table API)

### `pano_images` — 360° 그림 클라우드 저장
| 필드 | 타입 | 설명 |
|------|------|------|
| id | text | 고유 ID |
| name | text | 사용자 지정 저장 이름 |
| image_data | rich_text | 리사이즈 JPEG dataURL (장변 ≤4096px) |
| width / height | number | 이미지 크기 |

### `deployments` — 배포 스냅샷
| 필드 | 타입 | 설명 |
|------|------|------|
| id | text | 고유 ID |
| title / file_name | text | 도면 제목/원본 파일명 |
| drawing_data | text | 1페이지 스냅샷(레거시 호환) |
| pages_data | rich_text | 전 페이지 스냅샷 dataURL 배열(JSON) |
| pins | text | 핀 배열 JSON `[{id,x,y,page,label,imageId?,imageUrl?,isVideo?,localOnly?}]` (배포 시 로컬 영상 `videoUrl`은 제거되고 `localOnly:true`로 마킹) |

---

## 파일 구조
```
index.html      — 메인 HTML (홈/앱/360° 오버레이)
css/style.css   — 전체 스타일
js/main.js      — 앱 로직 (State / PDF / Cloud / PanoViewer(Three.js) / MapCtrl / UI / App)
README.md       — 이 파일
```

## 의존 라이브러리 (CDN)
- **Three.js 0.147.0** — 360° WebGL 파노라마
- PDF.js 3.11.174 — PDF 도면 렌더 (worker 동일 버전 고정)
- JSZip 3.10.1 — 소스 ZIP 다운로드
- Google Fonts (Share Tech Mono / Inter)

---

## 소스 코드 다운로드
- 홈 화면 **「전체 소스 ZIP 다운로드」** 버튼 → `wemare-360-viewer.zip`
- 앱 상단 **「소스 다운로드」** 버튼도 동일

## 배포(라이브 주소)
> 라이브 URL 발행은 **Publish 탭**에서 한 번의 클릭으로 진행됩니다(에이전트가 대신 수행 불가).

---

## 미구현 / 향후
- ⬜ `.dng` RAW (브라우저 한계 — 미지원 확정)
- ⬜ 360° 영상의 클라우드 영구 저장 (현재 영상은 URL 입력 권장)
- ⬜ 핀 드래그로 위치 재조정
- ⬜ 멀티 배포본 갤러리/버전 관리

## 🛠 저장·공유 기능 검토 보고서 반영 (2026-06-10)

`360viewer_저장공유_검토보고서.md`에서 지적된 공유 시나리오 결함을 모두 수정했습니다.

| ID | 등급 | 증상 | 수정 |
|----|------|------|------|
| **B1** | 🟠 G2 | `?mode=viewer` 단일 링크가 항상 "최신" 배포만 로드 → 새 도면 배포 시 기존 공유 링크가 바뀜 | 배포 성공 시 발급 레코드 `id`를 받아 **`?mode=viewer&d=<id>`** 링크 발급. 뷰어는 `d` 우선 로드 후 없을 때만 최신 폴백 (`_deployToViewer` / `loadLatestDeployment`) |
| **B2** | 🟠 G2 | 로컬 영상 핀의 `videoUrl(blob:)`이 배포 JSON에 직렬화 → 다른 세션에서 죽은 URL | 배포 본문 생성 시 `videoUrl` 제거 + `localOnly:true` 마킹 (원본 `State.pins`는 보존) |
| **B3** | 🟠 G2 | 미디어 식별자가 없는 핀 → `loadMedia(undefined)` 호출로 모호한 오류 | `openPano`에 `imageUrl` 분기 + **미디어 없음 명확 안내** 분기 추가 |
| **B4** | 🟡 G3 | `created_at` 정렬이 ISO 문자열이면 `문자열-문자열=NaN`으로 정렬 무효 | 숫자(epoch)/ISO 문자열/이상치 모두 안전 변환하는 `ts()` 정렬 |
| **B5** | 🟡 G3 | 영상 핀 blob URL이 어디서도 `revoke`되지 않아 메모리 누수 | `_videoBlobs` 추적 → `reset()` 일괄 해제 / 핀 삭제 시 즉시 해제 |

> B7(MB 표기 오차)·B8(`Date.now()` ID 충돌)은 표시값/저위험 항목으로, 보고서 권고대로 이번 범위에서는 보류했습니다.

### 검증 시나리오 (보고서 6장 대응)
1. **B1**: 도면 A 배포 → 링크1, 도면 B 배포 → 링크2. 링크1 재접속 시 **여전히 A** 표시 (`&d=<A의 id>` 고정).
2. **B2/B3**: 영상 핀 포함 배포 → 다른 브라우저 접속 → 영상 핀 클릭 시 **"로컬 전용" 안내 메시지**(CORS/로드 실패 대신).
3. **B4**: 배포 N건 후 뷰어(`d` 없이) 접속 → **마지막 배포본**과 일치.
4. **회귀**: 이미지 클라우드 핀 클릭 → 정상 360° 표시(기존 기능 무영향).

---

## 검증
- Three.js GPU 파노라마 / 영상 / 클라우드 업로드 / 플라이투 / 연속 배치 구현
- 수정 로직 단위 테스트(B1/B2/B4 URL·정렬·blob 제거) **전 케이스 통과**
- 정적 서버 구동 + PlaywrightConsoleCapture(홈 / `?mode=viewer&d=...`) — **콘솔 에러 0건**
