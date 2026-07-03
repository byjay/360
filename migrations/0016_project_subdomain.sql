-- ════════════════════════════════════════════════════════════
-- PART · 프로젝트별 서브도메인 (멀티테넌트 URL)
--   <subdomain>.seastar.work → 해당 프로젝트로 바로 진입.
--   슈퍼/관리자가 프로젝트에 슬러그를 부여하면, 와일드카드 DNS(*.seastar.work) +
--   워커 호스트 라우팅으로 고객사별/프로젝트별 직접 접속이 된다. (추가/하위호환)
-- ════════════════════════════════════════════════════════════
ALTER TABLE projects ADD COLUMN subdomain TEXT;
-- 활성 프로젝트 내에서 서브도메인 유일성 보장(부분 유니크 인덱스)
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_subdomain
  ON projects(subdomain) WHERE subdomain IS NOT NULL;
