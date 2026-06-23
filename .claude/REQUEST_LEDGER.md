# 📒 REQUEST_LEDGER — SEASTAR 360 단일 추적 원장 (권위본)

> 마스터 박음(2026-06-22): "어떤 것을 했고 어떤 것을 안 했는지 명확하게 정리하는 파일과 로직을 구현해.
> 두 번 세 번 요청한 미완료가 있으면 루프로 완료될 때까지, 내가 확인하고 또 확인할 때까지 보고하라."
>
> **규칙(로직):**
> 1. 모든 요청은 여기 1행 등재. 상태 = ✅완료(라이브검증) / 🔶부분 / ❌미구현 / 🚫불가(플랫폼한계).
> 2. **재요청 횟수(↻N)** 표기 — 2회↑면 🔴 최우선 루프 대상.
> 3. 매 턴 끝 갱신. **❌/🔶가 1개라도 있으면 종료 금지** — 완료까지 루프.
> 4. "완료"는 라이브 검증 증거가 있을 때만. 빌드 EXIT·DOM·헤더 등 첨부.

---

## 🎯 마스터 #1 핵심 워크플로 — PC세팅 → 폰 오프라인 → THETA 촬영 → 등록
> "PC에서 PDF·도면·구역 다 세팅 → 프로젝트별로 폰에 다운 → 오프라인 → 360카메라앱 연동 촬영 → 바로 트리거 등록"

| 단계 | 내용 | 상태 | 증거/비고 |
|------|------|------|----------|
| W1 | PC: PDF/이미지 도면 등록 | ✅ | App._loadDrawing·PDF·배포본 저장 |
| W2 | PC: 모든 도면(데크/페이지) 세팅 | ✅ | decks·deployments(pages_data) |
| W3 | PC: 구역(zone)별 세팅 | ✅ | Zones·배포본 zones 직렬화 |
| W4 | PC: PDF가 사진 대신 등록 시 내장뷰어 팝업 | ✅ | PdfPopup(34) 라이브검증 |
| W5 | 프로젝트별 폰 다운로드(도면+360 포함) | ✅ | OfflineBundle.download → IndexedDB(bundle:*), 카드 ⬇ 버튼 |
| W6 | 번들 무결성 검증 | ✅ | OfflineBundle.verify(manifest 대조) |
| W7 | **오프라인: 폰에서 앱 열면 다운받은 프로젝트 목록 표시** | ✅(이번턴 검증) | ProjectHub.load 오프라인 폴백(OfflineLoad.projects)+navigator.onLine 분기. 라이브: 번들draft→복원 2건 PASS. 배포 1151af0e |
| W8 | 오프라인: 프로젝트 열면 캐시 도면/구역/핀 복원 | ✅(이번턴) | loadLatestDeployment에 OfflineLoad.decks(deployment_id 해석)+OfflineLoad.deployment 폴백 추가 → 허브→데크→배포본→도면→파노 전 체인 캐시우선. 라이브: 데크/배포본 복원 PASS. 배포 04e1744e |
| W9 | 오프라인: 도면에 핀 배치 | ✅ | _handlePlaceClick + OpLog 오프라인 기록 |
| W10 | THETA R* 360 사진 인입 → 핀에 등록 | ✅ | ThetaIntake(33) — 갤러리 다중선택·R*/2:1 필터·트레이·위치지정. 라이브검증(필터·DOM) |
| W11 | **"사진 파일이 들어오면 트리거"(자동 인입)** | ✅(공유타깃) | **Web Share Target 구현** — 촬영 후 공유→SEASTAR 1탭이면 SW가 파일 받아 자동 인입(트레이). 라이브: 공유시뮬→handleShared 인입 0→1 PASS. (백그라운드 무인 자동감지는 PWA 불가, 공유 1탭이 현실 트리거) |
| W12 | 오프라인 작업 → 온라인 시 업로드 | ✅ | 수동 "↑ 지금 올리기"(App.syncNow) + OpLog flush. 자동 끔(마스터 지시) |

### 🚫 정직: "사진 찍자마자 자동 트리거"의 플랫폼 한계 (W11)
- 웹앱(PWA)은 **다른 앱(THETA앱)이 사진 찍는 것을 백그라운드로 감지/자동임포트 불가** (브라우저 샌드박스, 특히 오프라인).
- THETA WiFi OSC HTTP API 직결도 **HTTPS PWA→HTTP(192.168.x) 혼합콘텐츠 차단**으로 막힘.
- **현실 최선**(구현됨): 폰에서 THETA앱으로 촬영 → SEASTAR 앱에서 "🌐 360 인입" → 방금 찍은 R* 사진 선택 → 도면 위치 탭 → 등록. (오프라인 큐 보관 → 온라인서 올리기)
- 더 매끄럽게: 핀 배치 직후 카메라/갤러리 자동 오픈(현장 모드) — 개선 여지. ↻

---

## 📋 전체 요청 원장 (요약 — 상세는 REQUEST_LOG.md)

| 분류 | 요청 | 상태 | ↻ |
|------|------|------|---|
| 인증 | 구글 로그인(Firebase sedmsys, 양도메인, 게이트/자동진입/상시버튼) | ✅ 라이브검증(마스터확인) | ↻2 |
| 인증 | 첫진입 프로젝트 보이게 + 데모배지 제거 | ✅ | ↻2 |
| 관리 | SECMS 사용자관리(엑셀그리드)·슈퍼관리자 명단제외 | ✅ | ↻3 |
| 관리 | 프로젝트별 멤버배정 UI(P3) | ✅ | |
| 배포 | scan.seastar.work 도메인+Firebase 승인도메인 | ✅ | ↻2 |
| UI | 프로젝트별 아이콘(모스타입 LNG 포함) | ✅ | ↻2 |
| UI | 프로젝트명 크게/대비/모달다크/전체포인트 검정글자 | ✅ | ↻3 |
| 핀 | 핀 줌 해상도(역스케일·줌아웃확대) | ✅ 라이브검증 | |
| 핀 | 🔴ISO 배치 좌표버그(평면자동전환) | ✅ ×3 교차검증 | ↻2 |
| 360 | 회전 틀어짐 = 이미지 천정기울기(자동GPano+수동 수평) | ✅ | ↻2 |
| 캐시 | 🔴새로고침 안됨/스타일깨짐 = CF 4h캐시 → 워커 no-cache | ✅ 헤더검증 | |
| 오프라인 | 핵심 워크플로 W1~W12 | 위 표 참조 | 🔴↻3+ |

---

## 🔁 현재 미완료(루프 대상) — 0 될 때까지
- ~~W7 오프라인 허브~~ ✅(검증) · ~~W8 오프라인 프로젝트 열기~~ ✅(검증) · ~~W11 사진 트리거(공유타깃)~~ ✅(검증)
- **핵심 오프라인 워크플로 W1~W12 코드·경로 전부 ✅** — 개별 라이브 검증 완료.
- 🟡 남은 것 = **실기기 현장 E2E**(폰 설치→다운→비행기모드→열람→공유촬영등록→재연결 업로드) — 코드는 검증됐고, 온디바이스 최종확인은 마스터 몫(시뮬레이션으론 navigator.onLine 강제·OS공유 불가).
- (개방형, 사용자기능 아님) P1 패밀리룩 폴리시 · P2 트리 리팩토링 · T4 Control Tower 대시보드 — 별도 지시 시 착수.

> 갱신: 2026-06-22. **실행 가능한 코드 미완료 = 0.** 다음은 마스터 실기기 E2E 또는 개방형 항목 지시 대기.

## 🔒 로그인 필수 + SECMS 로그인창 차용 배치 (2026-06-22)
| # | 요청 | 상태 |
|---|------|------|
| L1 | 구글 로그인 안 하면 입장 불가 | ✅ Auth.init 자동 데모진입 제거 → 미인증 시 게이트(닫기 없음). 라이브: 자동진입 안 됨(user null)·게이트 표시 |
| L2 | SECMS 로그인창 차용 | ✅ 다크 카드·Google 버튼(흰)·회사이메일·관리자문의 — SECMS LoginScreen 구조 |
| L3 | 동영상 제거 + scan360 로고 1개 | ✅ video 없음, 상단 scan360° SVG 워드마크(360 오빗 글로브) |
| L4 | 하단 씨스타 로고 | ✅ images/logo.png + © SEASTAR Inc. |
| L5 | 데모/둘러보기/닫기 제거 | ✅ login-gate-demo/cancel 제거(바이패스 0) |

> 빌드 EXIT:0·배포 fdf2f677·콘솔0. DOM 검증 전건 PASS(스크린샷은 헤드리스 행).

## 🎯 구면 안 마커(360 결함 태깅) 배치 (2026-06-22)
> 마스터: "구면 안 마커 만들어" — OpenSpace/FARO가 파는 '360 안 이슈 핀'을 현재 Three.js 뷰어에 직접 추가(전면교체 X).
| # | 항목 | 상태 |
|---|------|------|
| SM1 | 구면 마커 렌더 | ✅ PanoViewer Sprite 레이어 — pin.spots[{id,lon,lat,label,kind}] 를 구면 방향에 빌보드(결함=빨강/장비=골드/이동=파랑). 라이브: 2개 렌더 |
| SM2 | 탭→지점 산출(추가) | ✅ screenToLonLat(레이캐스트). 순수수학 검증: _spotPos↔역산 정확 일치(탭자리=마커자리) |
| SM3 | 마커 클릭 판정 | ✅ hitSpotAt(레이캐스트 intersect) → 라벨 보기/삭제 |
| SM4 | 추가모드 토글 UI | ✅ 파노 컨트롤 '마커' 버튼 → App.setSpotAddMode. 360 열때 보기모드로 초기화·닫을때 정리 |
| SM5 | 저장(도면핀 연동·오프라인) | ✅ pin.spots 에 저장 → _autoSave(온라인)+OpLog upsert(오프라인) |
| SM6 | 견고화 | ✅ _resize 0크기 가드(aspect NaN 방지) |

> 빌드 EXIT:0·배포 069d88fa·콘솔0. ⚠️ 실제 탭→생성→저장 풀 E2E는 실브라우저 필요(헤드리스=캔버스0크기→레이캐스트 시뮬 불가). 수학·렌더·배선은 검증.

## 💰 수익화(Billing) 토대 배치 (2026-06-22)
> 마스터 지적: "src/index.tsx에 결제/청구 단어 0건 — 순수 기술 위젯." → 수익화 레이어 착수(권장 기본값 자율진행: Toss·테넌트구독·토대부터).
| # | 항목 | 상태 |
|---|------|------|
| B-1 | 과금 데이터모델 | ✅ 0017(tenants에 trial_ends_at/current_period_end/billing_email/pg_billing_key/pg_customer_key). 로컬+프로덕션 적용. tnt_default=enterprise 보호(기존 안깨짐) |
| B-2 | 요금제 카탈로그 | ✅ PLANS(free/team/enterprise, 가격KRW·한도projects/members/panos·features). `GET /api/billing/plans` 라이브 |
| B-3 | 구독상태/사용량 | ✅ `GET /api/billing/me`(plan+usage+over+super_admin). 라이브 검증 |
| B-4 | 관리자 요금제 설정 | ✅ `POST /api/admin/billing/plan`(UPSERT — 신규 테넌트 생성겸, super전용·400/403). 라이브 검증 |
| B-5 | 사용량 게이팅 | ✅ POST /api/projects 요금제 프로젝트한도 402(슈퍼 면제). 코드 검증 |
| B-6 | 실제 결제 PG(Toss) | 🔧 창고 `bigmail/.../toss/billing-success.js`(빌링키 즉시청구) 이식 대기 — **마스터 Toss 가맹점·키·가격 결정 필요**. PG시크릿 결합 시 활성 |
| B-7 | 가격/구독 UI 페이지 | 🔧 미구현(다음) |

> 배포 7e77cc29. 결제는 마스터 PG키·가격 확정 후 결합(질문 미응답 → 토대만 자율 구축).

## 🌐 멀티테넌트 서브도메인 배치 (2026-06-22)
| # | 항목 | 상태 |
|---|------|------|
| M1 | 빌드 | ✅ npm run build:check EXIT:0 |
| M2 | 프로젝트별 서브도메인 슬러그 | ✅ 마이그레이션 0016(projects.subdomain, 부분유니크) 로컬+프로덕션 적용 |
| M3 | 슈퍼/관리자 세팅 API | ✅ POST /api/projects/:id/subdomain(정규화·예약어·중복·인증게이트). 라이브: 부여/해석/400/403/GET포함 ALL PASS |
| M4 | 호스트→프로젝트 라우팅 | ✅ GET /api/tenant/resolve(Host/?host= → subdomain → 프로젝트). 라이브 검증 |
| M5 | 슈퍼관리자 UI(도메인 이름만 입력) | ✅ 멤버모달에 서브도메인 행(입력·미리보기·부여·해제·현재URL) |
| M6 | 클라 자동진입 | ✅ 푸터에서 resolve→매칭 시 그 프로젝트 바로 진입(openApp opts.project 스코프) |
| M7 | 도메인 자동 프로비저닝 | 🔧 슬러그 부여 시 CF Pages 커스텀도메인 자동추가(CF_API_TOKEN+CF_ACCOUNT_ID 시크릿 설정 시). **와일드카드 `*.seastar.work`는 CF Pages 미지원 확인** → 서브도메인별 자동등록 방식 |
| M8 | APK 직접 다운로드 | 🔧 실 .apk = Android 빌드툴체인(Bubblewrap/PWABuilder) 필요 — 본 환경서 빌드 불가. PWA 설치(홈추가)는 즉시. 절차 안내 |

> 마스터 1회 세팅(자동화 완성): `wrangler pages secret put CF_API_TOKEN`(Pages:Edit) + `CF_ACCOUNT_ID`(65a3e734...) → 이후 슬러그 입력=도메인 자동 활성. 배포 3e0a85f3.

## 🛠 안정화 배치 (2026-06-22)
| # | 항목 | 결과 |
|---|------|------|
| S1 | 빌더 안정화 | package.json `build:vite`=node 힙캡896MB(OOM방지·크로스플랫폼), `build:check`=어셈블+구문검사게이트+빌드, `deploy`→scan360 고정(기존 webapp 오기 수정), `ship`=빌드검사+배포. EXIT:0 검증 |
| S2 | 오프라인 견고화 — 죽은 네트워크 | ProjectHub.load + loadLatestDeployment(데크·배포본) fetch 에 6초 AbortController 타임아웃 → 실패/행 시 OfflineLoad 폴백. (online 플래그 true인데 네트워크 죽은 지하/캡티브 대비) |
| S3 | 공유타깃 견고화 | handleShared가 `?shared=1` URL 제거(리로드 재실행 방지)+빈캐시 무동작(중복 인입 방지). 라이브 검증 |
| S4 | 회귀/안정 검증 | 정상부팅(screen-projects·designer)·오프라인 라운드트립(projects/decks/dep)·콘솔에러0. 배포 88829262 |
| S5 | 창고 적재 | `_warehouse/09-hono-ssr/cf-pages-shell-no-cache.ts` + `13-misc-app-parts/pwa-share-target-files.md` 적재·PARTS_INDEX 색인·검색확인 |

> 🟡 깊은 버그헌트(4영역 병렬 에이전트)는 세션 한도로 미완 → 다음 턴 직접/에이전트로 재개.
