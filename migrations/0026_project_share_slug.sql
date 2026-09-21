-- ════════════════════════════════════════════════════════════
-- [P61] 공유 주소 체계 — https://scan.seastar.work/srview/<프로젝트명>-<토큰>
--
-- 마스터 요구 2건이 정면 충돌한다:
--   (2026-09-18) "다른 프로젝트를 유추할 수 없도록"  ← 이름만 알면 열리면 안 된다
--   (2026-09-21) "프로젝트 이름은 그쪽 고객이 봐도 알 수 있게"  ← 이름은 보여야 한다
-- 해법: 이름은 **주소에 노출하되 장식**이고, 실제 열쇠는 **불투명 토큰**이다.
--   → 이름을 맞춰도 토큰이 없으면 404. 이름을 바꿔도 토큰이 같으면 계속 열린다.
--
-- 🔴 share_slug 컬럼은 만들지 않는다(작업지시서 대비 의도적 이탈 · 근거):
--   ① slug 는 projects.name 에서 100% 파생된다 — 저장하면 SoT 가 둘이 되고,
--      이름 변경 시 반드시 갈라진다(전역 CLAUDE.md §5 SoT).
--   ② 조회 키가 아니다. 서버는 오직 share_token 으로만 프로젝트를 찾는다
--      (그래야 "이름 바꿔도 링크가 산다"는 요구가 코드로 강제된다).
--   ③ 따라서 저장된 slug 는 읽는 사람이 0인 죽은 데이터가 된다.
--   → slug 는 응답 시점에 slugifyProjectName(name) 으로 파생한다(src/lib/util.ts).
--
-- 🔴 추가 전용 비파괴 — 기존 행 변형/삭제 0. 기존 `?d=` 링크·subdomain 경로는 그대로 산다.
-- ════════════════════════════════════════════════════════════

ALTER TABLE projects ADD COLUMN share_token TEXT;

-- 토큰 유일성(부분 유니크) — NULL(미배포/구 프로젝트)은 몇 개든 공존한다.
-- 0016_project_subdomain.sql 의 idx_projects_subdomain 과 동일 패턴.
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_share_token
  ON projects(share_token) WHERE share_token IS NOT NULL;
