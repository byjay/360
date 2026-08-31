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


---
> 🎀 **Ponytail full 상시 적용** (전역 `~/.claude/CLAUDE.md` 3장 상속, 2026-06-23 박음). 매 태스크: YAGNI → 기존 재사용 → stdlib → 네이티브 → 설치된 의존성 → 한 줄 → 최소 코드. 검증·보안·접근성·근본원인 수정은 절대 양보 금지. 명령: `/ponytail [lite|full|ultra]` `/ponytail-review` `/ponytail-audit`.

---

## 🔒 공통 작업 규율 (전역 상속 · 발주서에 재기술 금지)

> 🔴 마스터 박음(2026-08-24). **발주 프롬프트에는 이 장을 `"CLAUDE.md §공통 작업 규율 준수"` 한 줄로 참조**한다.
> 같은 규율을 발주서마다 복붙하는 것은 순수 토큰 낭비다(실측: 한 세션 200줄 x 20회).
> 모델 라우팅·토큰 규율은 전역 `~/.claude/CLAUDE.md` **§6**(서브에이전트 기본값 = Haiku, 토큰 규율 5종)을 따른다.

### G-1. 🔴 git — 파일 유실 방지
- `git add` 는 **자기가 만진 파일만.** 맨 `git commit` 금지 → `git commit -- <경로>` **경로 한정**.
- 🔴 **`git stash` 절대 금지** · 🔴 **`git checkout .` / `git reset --hard` 절대 금지.** 되돌릴 땐 파일 하나씩 지정. (다른 세션 작업까지 쓸어간 실사고 있음)
- **동시 작업 중인 다른 에이전트가 항상 있다고 가정.** 공유 파일은 `Edit` 로 **추가만**, `Write` 전체 덮어쓰기 금지.
- **검증 통과분이 생길 때마다 즉시 경로 한정 중간 커밋.** 세션 한도로 죽어도 다음 사람이 이어받는다.
- **배포는 지휘자만.** 에이전트는 커밋까지.

### G-2. 🔴 검증 — 증거 없는 PASS 금지
1. 정적(타입체크/lint) EXIT 0 → 빌드 EXIT 0 → 테스트 → 런타임 재현. 변경 규모에 비례해 단계를 고른다.
2. **테스트는 실 환경에서. 목(mock)으로 핵심 동작을 흉내내지 마라** — 거짓 초록이 난다.
3. 🔴 **뮤테이션 증명** — 고친 부분을 일부러 되돌리면 그 테스트가 **실패해야** 한다. 확인 후 원복. 실패하지 않으면 그 테스트는 가짜다.
4. **라이브 재현으로 마무리.** 코드만 읽고 "됐다" 금지.
5. **수정 전 `grep` 으로 형제 호출부 전수 확인.** 공유 함수를 **한 번** 고쳐라. 한쪽만 고치면 형제 호출부가 깨진 채 남는다.

### G-3. 보고 규율
- **과장·치어리딩 금지.** 안 되면 안 된다고, 못 했으면 못 했다고. **미완 항목은 반드시 명시.**
- 확정형 수치는 **실행 결과만.** 근거가 없으면 `[Uncertain]` + 보수적 가정 한 문장.
- **정상인 것은 정상이라고.** 없는 결함을 지어내지 마라.
- **지시가 틀렸다고 판단되면 근거를 대고 반박하라.**
- 보고는 **착지·결함 발견 시에만, 표 위주로 짧게.** 진행 중 중계방송 금지.
- 형식: 근본원인 → 판단 근거 → 변경 → 검증 증거(EXIT·출력·뮤테이션) → 미완 항목.
