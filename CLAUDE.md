# SEASTAR 360° Location Viewer — 도면 위 360° 파노라마 위치 뷰어

> 🚀 세션 시작 시 가장 먼저 읽을 것: `ECOSYSTEM_START_GUIDE.md` (패밀리 공통 기준서)

## ⛓️ IRON RULE — 절대 페르소나(최우선·예외 없음)
마스터의 명시 지시로 영구 고정. 어떤 새 요청이 들어와도 아래를 먼저 지킨다.
1. **미완료 우선**: 이전 세션/턴에서 진행 중이던 작업(이 파일·`.claude/HANDOFF.md`의 미완료 체크리스트)을 **새 요청보다 먼저 끝까지 완료**한다. 새 요청은 미완료 작업에 합류시켜 함께 처리한다.
2. **중단 없음**: 임무 도중 멈추지 않는다. 막히면 우회·재시도하며, 모든 트랙을 **병렬**로 동시에 밀어붙인다(단, 동일 코드베이스의 상호의존 파일은 메인이 직접 순차-병렬 편집해 충돌을 막는다).
3. **완료까지 루프**: 4단계 검증(정적→빌드→런타임→UI)이 전부 PASS하고, 커밋·빌드URL·다운로드 링크를 제공할 때까지 루프를 멈추지 않는다.
4. **턴 종료 시 HANDOFF 갱신**: 매 턴 끝에 `.claude/HANDOFF.md`의 미완료/완료 체크리스트를 갱신해, 다음 턴이 이어받을 수 있게 한다.
5. **정직 보고**: 과장 없이, 검증 증거(빌드 EXIT, curl/E2E 결과)를 붙여 한국어로 보고한다.

## 정체 카드
- 도메인: 엔지니어링 도면(PDF/PNG/JPG) 위에 360° THETA 파노라마 핀을 배치하고, 열람자가 핀을 눌러 파노라마를 보는 시스템. (씨스타/SEASTAR Inc., 부산 조선·해양 설계)
- 스택: **Hono on Cloudflare Workers (SSR + API)** + 바닐라 JS 클라이언트(`public/`) + PDF.js 3.11.174 + Three.js 0.147.0
- 데이터: **Cloudflare D1** (`webapp-production`, 바인딩 `DB`) + **R2** (바인딩 `R2`)
- 배포: CF Pages (사용자가 직접 배포) · 빌드 `vite build` → `dist/_worker.js`
- 인증: Google OAuth(`verifyGoogleToken`) + 데모 토큰(demo-super/designer/viewer) + **로컬 세션(회사 이메일 자체가입, `local-` 접두)**. SUPER_ADMIN = `designssir@gmail.com`
- 진입 파일: `src/index.tsx`(서버/API), `public/js/main.js`(클라이언트 전체), `public/index.html`, `public/css/style.css`
- PWA: `public/sw.js`(앱셸 캐시), `public/manifest.webmanifest`, 오프라인 큐 `SyncQueue`(IndexedDB+localStorage 폴백)

## ⛔ Non-Negotiables
1. **빌드는 반드시** `pm2 stop webapp` 후 `NODE_OPTIONS="--max-old-space-size=640" npx vite build` (평빌드는 OOM exit 137).
2. **public/ 수정 후 MIRROR 필수**: `cp public/js/main.js js/main.js && cp public/index.html index.html && cp public/css/style.css css/style.css`.
3. **데이터는 D1/R2에만** — 메모리·파일 저장 금지.
4. **API 키는 Cloudflare 시크릿으로만** (`AI_API_KEY` 등). 프론트 노출 절대 금지.
5. 검증 4단계(정적→빌드→런타임→UI) 통과 전 "완료" 금지.

## 메뉴 ↔ 파일 매핑
| 기능 | 클라이언트(public/js/main.js) | 서버/API(src/index.tsx) |
|------|------------------------------|-------------------------|
| 도면 업로드/렌더 | `App._loadDrawing`, `PDF.*` | `/tables/deployments` |
| 핀 배치/팝업 | `UI.renderPinsOnMap`, `PinActionPop` | `/tables/deployments`(pins) |
| PDF 주석(ezPDF) | `PdfAnno` | (배포본 annotations 직렬화) |
| 구역(zone) | `Zones` | (배포본 zones 직렬화) |
| 360° 뷰어 | `PanoViewer`, `Radar`, `PanoNav` | R2(media) |
| 회사 자체가입 | `CompanyAuth` | `/api/signup/*` |
| 관리자(도메인/멤버/로그) | `Designers` | `/api/allowed-domains`, `/api/local-users`, `/api/activity-logs` |
| AI 연동 | (프론트 호출부 추후) | `/api/ai/config`, `/api/ai/chat` |
| 오프라인 동기화 | `SyncQueue` | `/tables/*` |

## 진행 이력
→ `.claude/HANDOFF.md` 참조
