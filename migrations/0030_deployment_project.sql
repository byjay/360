-- [WO 20260930-WP3] 배포본의 프로젝트 귀속 + 프로젝트 원본 지정
--   ① deployments.project_id — 배포본 쓰기(PATCH/PUT/DELETE/ops) 권한을 "그 프로젝트" 기준으로 판정하는 단일 기준.
--      NULL = 레거시(귀속 불명) → 서버는 종전 규칙(requireDesigner) 유지(잠금 사고 방지).
--   ② projects.original_deployment_id — 프로젝트에 처음 등록한 전체 도면(원본) 배포본.
--      구역/영역 복사본은 원본이 아니다. 서버가 "비어 있을 때만" 1회 기록한다(first-wins).
--
-- 🔴 추가 전용(비파괴). 기본값·백필 없음 — 기존 행은 전부 NULL.
--    백필은 별도 파일 migrations/manual/0030_deployment_project_backfill.sql (지휘자가 dry-run 후 수동 적용).
ALTER TABLE deployments ADD COLUMN project_id TEXT;
CREATE INDEX IF NOT EXISTS idx_deployments_project ON deployments(project_id);
ALTER TABLE projects ADD COLUMN original_deployment_id TEXT;
