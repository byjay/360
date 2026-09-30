-- [WO 20260930-WP3] deployments.project_id 백필 — 🔴 수동 적용 전용(wrangler 자동 마이그레이션 대상 아님: 하위 폴더).
-- 선행: migrations/0030_deployment_project.sql · 먼저 0030_deployment_project_backfill.dryrun.sql 로 will_backfill 행 수 확인.
-- 규칙(확정 가능한 것만): decks.deployment_id 로 연결된 deck 의 project_id 가 정확히 1종 + projects 행 존재.
--   연결 deck 없음 / 2개 이상 프로젝트에 걸침 / 프로젝트 행 없음 → NULL 유지(레거시 규칙 = 종전 권한).
-- 멱등: project_id IS NULL 인 행만 건드린다. 되돌리기: UPDATE deployments SET project_id = NULL WHERE id IN (...).
UPDATE deployments SET project_id = (
  SELECT MIN(d.project_id) FROM decks d WHERE d.deployment_id = deployments.id
)
WHERE project_id IS NULL
  AND (SELECT COUNT(DISTINCT d.project_id) FROM decks d WHERE d.deployment_id = deployments.id) = 1
  AND EXISTS (SELECT 1 FROM projects p WHERE p.id = (SELECT MIN(d.project_id) FROM decks d WHERE d.deployment_id = deployments.id));
