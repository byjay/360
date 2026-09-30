-- [WO 20260930-WP3] 백필 dry-run (읽기 전용). 0030 적용 후 실행.
-- 확정 규칙: decks.deployment_id 로 연결된 deck 들의 project_id 가 **정확히 1종**이고 그 projects 행이 존재할 때만.
--   (삭제된 프로젝트도 포함 — 그 배포본은 이후 쓰기 409 가 된다) 추정 백필 없음.
SELECT
  (SELECT COUNT(*) FROM deployments) AS deps_total,
  (SELECT COUNT(*) FROM deployments WHERE project_id IS NULL) AS deps_project_null,
  (SELECT COUNT(*) FROM deployments dp WHERE dp.project_id IS NULL
     AND (SELECT COUNT(DISTINCT d.project_id) FROM decks d WHERE d.deployment_id = dp.id) = 1
     AND EXISTS (SELECT 1 FROM projects p WHERE p.id = (SELECT MIN(d.project_id) FROM decks d WHERE d.deployment_id = dp.id))
  ) AS will_backfill,
  (SELECT COUNT(*) FROM deployments dp WHERE dp.project_id IS NULL
     AND (SELECT COUNT(DISTINCT d.project_id) FROM decks d WHERE d.deployment_id = dp.id) = 1
     AND EXISTS (SELECT 1 FROM projects p WHERE p.deleted = 1 AND p.id = (SELECT MIN(d.project_id) FROM decks d WHERE d.deployment_id = dp.id))
  ) AS will_backfill_to_deleted_project,
  (SELECT COUNT(*) FROM deployments dp WHERE (SELECT COUNT(DISTINCT d.project_id) FROM decks d WHERE d.deployment_id = dp.id) > 1) AS skip_ambiguous_multi_project,
  (SELECT COUNT(*) FROM deployments dp WHERE NOT EXISTS (SELECT 1 FROM decks d WHERE d.deployment_id = dp.id)) AS skip_no_deck,
  (SELECT COUNT(*) FROM deployments dp WHERE (SELECT COUNT(DISTINCT d.project_id) FROM decks d WHERE d.deployment_id = dp.id) = 1
     AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = (SELECT MIN(d.project_id) FROM decks d WHERE d.deployment_id = dp.id))
  ) AS skip_project_row_missing;
