-- [WO 20261011-offmerge R2] 개정 되돌리기(undo)가 일어난 배포본 버전(되돌림 직전 version).
-- 오프라인 편집 재기준화(src/index.tsx revsSinceVersion)가 "편집 기준 버전 이후에 되돌렸는가"를 판정해 역변환(invertAff)을 적용한다.
ALTER TABLE drawing_revisions ADD COLUMN reverted_version INTEGER;
-- 이 마이그레이션 전에 되돌린 행은 정확한 버전을 모른다 — 상한만 남긴다(되돌림은 지금 배포본 버전 이하에서 일어났다).
-- 기준 버전이 이 상한 이하인 편집만 "순서 모름 → 좌표 유지 + 검토 표시", 상한보다 새 기준은 되돌림 이후가 확실하므로 표시하지 않는다.
-- 기존 열 값은 바꾸지 않는다(새 열 채움만).
ALTER TABLE drawing_revisions ADD COLUMN reverted_version_max INTEGER;
UPDATE drawing_revisions SET reverted_version_max = (SELECT d.version FROM deployments d WHERE d.id = drawing_revisions.deployment_id) WHERE status = 'reverted' AND reverted_version IS NULL;
