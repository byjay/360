# SEASTAR 360° Viewer — 완료보고서 체크리스트

> 작업: P0 batch + 오프라인 완전구현(SEASTAR_OFFLINE_WORKORDER ❶-❿) 병렬처리·병렬검증
> 통합 인수인계: SEASTAR_MASTER_WORKORDER (HANDOFF) 2-A 결함 D1/S1/S2 = 본 P0와 동일 매핑 확인
> commit: `1cf5f20` / 빌드 EXIT 0 / 모든 E2E PASS
> 최종 검증일: 2026-06-20

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

## 8. 잔여(권장 — 다음 배치 후보, 마스터 확인 요)

- 오프라인 클라이언트 **브라우저 E2E**(IndexedDB bundle 키/OpLog pending/오프라인 부팅) — 현재 서버측 로직 + JS 무결성까지 검증, 실기기 PWA 테스트는 미실시
- HANDOFF PART 3 디자인 시스템 8분야 체크리스트(패밀리룩) — 별도 배치
- 전략문서 P1~P3 로드맵 항목
