# SEASTAR 360° Viewer — 완료보고서 체크리스트

> 작업: P0 batch + 오프라인 완전구현(SEASTAR_OFFLINE_WORKORDER ❶-❿) 병렬처리·병렬검증
> 통합 인수인계: SEASTAR_MASTER_WORKORDER (HANDOFF) 2-A 결함 D1/S1/S2 = 본 P0와 동일 매핑 확인
> 빌드 EXIT 0 / 멱등 10회 + 전체 E2E ALL PASS / 클린 재검증 ①~⑥ 통과
> 최종 검증일: 2026-06-20 (클린 재검증 + Tenant Architecture 추가)

---

## 1. P0 batch (HANDOFF 2-A 결함 봉인)

| HANDOFF ID | 항목 | 구현 | E2E 검증 |
|---|---|---|---|
| **D1** | annotations 영속화 — migration 0011 + mapDeployment/INSERT/PATCH 4지점 | ✅ | ✅ PASS (저장+update 라운드트립) |
| **S1** | GET /tables/deployments 무인증 차단 (list + :id getUser 게이트) | ✅ | ✅ PASS (무인증 401 / 인증 200) |
| **S2** | DEMO_LOGIN_ENABLED → demoLoginEnabled(c) 환경변수화 | ✅ | ✅ 코드 검증 (프로덕션 secret 0 봉인 대기) |

## 2. 오프라인 완전구현 ❶-❿ (킬러기능)

| 단계 | 작업 | 구현 | 검증 |
|---|---|---|---|
| ❶ | applied_ops(migration 0012) + op-apply endpoint `POST /tables/deployments/:id/ops` | ✅ | ✅ PASS |
| ❷ | OfflineBundle.download + ProjectHub 다운로드 버튼 | ✅ | ✅ JS 무결성 |
| ❸ | OfflineBundle.verify (manifest 무결성) | ✅ | ✅ JS 무결성 |
| ❹ | OfflineLoad + loadDeckDrawing 오프라인 분기 | ✅ | ✅ JS 무결성 |
| ❺ | resolvePanoSource + openPano 통합 | ✅ | ✅ JS 무결성 |
| ❻ | OpLog + 편집점 연결(pin/zone/anno) + persistLocalDeployment | ✅ | ✅ JS 무결성 |
| ❼ | net-badge HTML+CSS+updateNetBadge+Offline.init | ✅ | ✅ CSS_BALANCED |
| ❽ | App._flushOpLogs + _onReconnect + 지수백오프 | ✅ | ✅ JS 무결성 |
| ❾ | 필드단위 얕은병합 + tombstone + 멱등(applied_ops) | ✅ | ✅ PASS (충돌제로/LWW/병합/tombstone) |
| ❿ | 통합 E2E 시나리오 | ✅ | ✅ 서버 E2E PASS |

## 3. 🔴 멱등성 버그 수정 (정직한 보고 — runtime 검증)

- **발견**: A4 테스트에서 중복 opId 재전송 시 version 1→2 증가 (버그)
- **원인**: `changed = applied.length > 0` 이 중복 op까지 포함
- **수정**: `newlyApplied` 카운터 도입 — 실제 새로 적용된 op만 카운트, `changed = newlyApplied > 0`
- **재검증 결과 (실제 런타임)**:
  - 1차: version 1, 핀 1개
  - 2차(같은 opId): **version 1 유지** ✅, 핀 1개
  - 3차(다른 opId): version 2, 핀 2개 ✅
  - **IDEMPOTENT_OVERALL: PASS**

## 4. 병렬검증 결과 (E2E ALL PASS)

```
[PASS] P0-2 무인증 list 401
[PASS] P0-2 인증 list 200
[PASS] P0-1 annotations 저장
[PASS] P0-1 annotations update
[PASS] ❾ 충돌제로(다른핀 둘다 보존)
[PASS] ❾ 필드병합(label최신+note보존)
[PASS] ❾ delete tombstone(_deleted)
OVERALL: ALL PASS
```

## 5. 빌드/무결성 상태

| 항목 | 결과 |
|---|---|
| vite build (640MB) | **EXIT 0** / dist/_worker.js 75.40 kB / 675ms |
| JS 문법 (new Function) | **JS_OK** |
| offline identifiers | 42개 |
| CSS 균형 | **BALANCED** (1503 braces) |
| sw.js 캐시 | wm-shell-v11 |
| MIRROR (public↔root) | 동기화 완료 |
| 로컬/공개 URL | HTTP 200 / 200 |

## 6. 산출물

- **빌드 URL**: https://3000-iqtsdhe42ft6qbmasacvh-3844e1b6.sandbox.novita.ai
- **백업(다운로드)**: https://www.genspark.ai/api/files/s/byw31LkK
- **commit**: `1cf5f20`

## 7. 마스터 배포 봉인 대기 항목 (사용자 실행)

1. 프로덕션 D1 마이그레이션: `npx wrangler d1 migrations apply webapp-production` (0011 + 0012)
2. DEMO_LOGIN 봉인: `npx wrangler pages secret put DEMO_LOGIN` → 값 `0`
3. 배포: `npx wrangler pages deploy dist --project-name webapp`

## 8. 클린 재검증 (설치→오프라인 실행, 처음부터 재수행)

> 마스터 지시: "설치부터 오프라인 실행 검증까지 완벽 재검증" — dist 삭제 후 처음부터 재구성

| # | 단계 | 결과 |
|---|---|---|
| ① | 의존성 무결성 (node_modules / vite·wrangler bin / hono 4.12.23) | ✅ PASS |
| ② | 마이그레이션 D1 적용 (0001~0012 전부 + annotations·applied_ops 존재) | ✅ PASS |
| ③ | 클린 빌드 (dist 삭제 → 640MB build) EXIT 0 / _worker.js 75.40 kB | ✅ PASS |
| ④ | PM2 재기동 + HTTP 200 + 정적자원(main.js/style.css/sw.js) 200 | ✅ PASS |
| ⑤ | 서버 E2E: 멱등 10회 ALL PASS + P0/충돌제로 전체 ALL PASS | ✅ PASS |
| ⑥ | dist 산출물에 오프라인 함수 실제 포함(OfflineBundle/OpLog/resolvePanoSource/_flushOpLogs/net-badge/sw v11) | ✅ PASS |

### 멱등성 "간헐 FAIL" 정밀 분석 (정직 보고)
- 5회 루프 테스트에서 간헐 FAIL 발생 → **서버 버그 아님, 테스트 스크립트 결함**
- 원인: 옛 스크립트가 opId를 `op-{초단위 timestamp}`로 생성 → 1초 내 반복 시 opId 중복 → 서버가 "이미 적용"으로 정상 멱등 처리(version 미증가)하나 테스트는 새 dep 가정으로 오판정
- **고유 opId(uuid)로 교체 후 10/10 ALL PASS** → 서버 멱등성은 오히려 완벽(applied_ops 전역 PK = 의도된 동작, 실제 클라 opId는 uuid라 충돌 없음)

## 9. PART 0 — Tenant Architecture (멀티테넌트 SaaS 기반)

> HANDOFF PART 0 "🥇 1위 Tenant Architecture" 반영 — 빈 껍데기 + 하위호환 백필

| 항목 | 결과 |
|---|---|
| migration `0013_tenancy.sql` (문서 0012→번호충돌로 0013 조정) | ✅ 생성·적용 |
| tenants / tenant_members 테이블 | ✅ 생성 |
| 6개 1급 리소스 tenant_id 컬럼 추가(projects/decks/deployments/pano_images/pin_notes/activity_log) | ✅ |
| tnt_default 테넌트 + 기존 데이터 백필(projects 4건) | ✅ |
| 테넌트 스코프 인덱스 4종 | ✅ |
| **하위호환**: 서버 코드 변경 0 → 기존 동작 무영향 (E2E 재실행 ALL PASS로 입증) | ✅ |

## 10. 잔여(권장 — 다음 배치 후보, 마스터 확인 요)

- **서버 스코핑 헬퍼** (PART 0 문서가 "모든 쿼리가 통과해야 하는…"에서 잘림) — tenant_id 강제 필터 미들웨어. 현재는 스키마만 박은 상태(빈 껍데기). 실제 격리 enforce는 다음 배치
- 오프라인 클라이언트 **실기기 브라우저 E2E**(IndexedDB bundle 키/OpLog pending/오프라인 부팅) — 서버 로직 + 빌드 포함은 검증, 실기기 PWA 테스트 미실시
- HANDOFF PART 3 디자인 시스템 8분야(패밀리룩), 전략문서 P1~P3
