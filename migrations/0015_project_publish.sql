-- 프로젝트 배포(Publish) 상태 — 설계자가 설계·핀 완성 후 "배포"하면 뷰어에게 공개되는 게이트.
-- 워크플로: 설계자 모드에서 전부 편집/등록 → 배포(published=1) → 권한받은 뷰어가 그 프로젝트 열람.
-- 미배포(published=0) 프로젝트는 설계자/소유자/슈퍼에게만 보이고 뷰어에겐 숨겨진다.

ALTER TABLE projects ADD COLUMN published    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN published_at INTEGER;
ALTER TABLE projects ADD COLUMN published_by TEXT;
