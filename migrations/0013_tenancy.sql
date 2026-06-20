-- PART 0 · Tenant Architecture (멀티테넌트 SaaS 기반 — 빈 껍데기 + 하위호환 백필)
-- 주의: HANDOFF 문서는 0012로 명시했으나 0012는 이미 applied_ops가 점유 → 0013으로 배치(번호 충돌 방지)

-- 1) 테넌트(회사) + 멤버십
CREATE TABLE IF NOT EXISTS tenants (
  id          TEXT PRIMARY KEY,              -- 'tnt_xxx'
  name        TEXT NOT NULL,                 -- 회사명
  slug        TEXT UNIQUE,                   -- url용 (seastar, hanwha ...)
  plan        TEXT NOT NULL DEFAULT 'free',  -- free|team|enterprise
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  INTEGER NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tenant_members (
  tenant_id   TEXT NOT NULL,
  email       TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'viewer',  -- owner|admin|designer|viewer
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, email)
);
CREATE INDEX IF NOT EXISTS idx_members_email ON tenant_members(email);

-- 2) 모든 1급 리소스에 tenant_id 추가 (NULL 허용 후 백필 → 추후 NOT NULL 승격)
ALTER TABLE projects     ADD COLUMN tenant_id TEXT;
ALTER TABLE decks        ADD COLUMN tenant_id TEXT;
ALTER TABLE deployments  ADD COLUMN tenant_id TEXT;
ALTER TABLE pano_images  ADD COLUMN tenant_id TEXT;
ALTER TABLE pin_notes    ADD COLUMN tenant_id TEXT;
ALTER TABLE activity_log ADD COLUMN tenant_id TEXT;

-- 3) 기존 데이터를 기본 테넌트로 백필(하위호환)
INSERT OR IGNORE INTO tenants (id, name, slug, plan, status, created_at, deleted)
  VALUES ('tnt_default', 'SEASTAR', 'seastar', 'enterprise', 'active', 0, 0);
UPDATE projects     SET tenant_id = 'tnt_default' WHERE tenant_id IS NULL;
UPDATE decks        SET tenant_id = 'tnt_default' WHERE tenant_id IS NULL;
UPDATE deployments  SET tenant_id = 'tnt_default' WHERE tenant_id IS NULL;
UPDATE pano_images  SET tenant_id = 'tnt_default' WHERE tenant_id IS NULL;
UPDATE pin_notes    SET tenant_id = 'tnt_default' WHERE tenant_id IS NULL;
UPDATE activity_log SET tenant_id = 'tnt_default' WHERE tenant_id IS NULL;

-- 4) 테넌트 스코프 인덱스
CREATE INDEX IF NOT EXISTS idx_projects_tenant    ON projects(tenant_id);
CREATE INDEX IF NOT EXISTS idx_deployments_tenant ON deployments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_panos_tenant       ON pano_images(tenant_id);
CREATE INDEX IF NOT EXISTS idx_decks_tenant       ON decks(tenant_id);
