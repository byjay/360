-- [360 동선] 도면 위 선(동선) + 연결된 360 동영상 — 재이식(참조: worktree 4e1b93b 0021_deployment_routes.sql).
-- 패턴은 0011_deployment_annotations.sql(annotations)과 동일: pins/zones/annotations 와
-- 나란히 deployments 에 저장되는 엔티티 배열(JSON TEXT, 기본 '[]').
-- 🔴 추가 전용(비파괴). 원격(prod) 적용은 지휘자가 한다 — src/index.tsx 의 routesReady() 가드가
--   이 컬럼 미적용 환경에서도 다른 필드 저장을 막지 않도록 모든 쓰기 경로를 감싼다.
ALTER TABLE deployments ADD COLUMN routes TEXT DEFAULT '[]';
