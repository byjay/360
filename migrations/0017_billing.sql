-- ════════════════════════════════════════════════════════════
-- PART · 과금/구독(Billing) 토대 — 테넌트(고객사)별 구독
--   tenants.plan/status 는 이미 존재(0013). 여기에 구독주기·결제 필드 추가.
--   ⚠️ 기본 테넌트(tnt_default = 내부/마스터)는 enterprise(무제한)로 보호 → 기존 사용 안 깨짐.
--   실제 결제(Toss 등)는 PG 키 설정 후 결합. (추가/하위호환)
-- ════════════════════════════════════════════════════════════
ALTER TABLE tenants ADD COLUMN trial_ends_at      INTEGER;   -- 체험 종료(ms)
ALTER TABLE tenants ADD COLUMN current_period_end INTEGER;   -- 구독 만료(ms)
ALTER TABLE tenants ADD COLUMN billing_email      TEXT;      -- 청구 이메일
ALTER TABLE tenants ADD COLUMN pg_billing_key     TEXT;      -- PG 빌링키(Toss billingKey 등)
ALTER TABLE tenants ADD COLUMN pg_customer_key    TEXT;      -- PG 고객키

-- 내부 기본 테넌트는 무제한(enterprise)으로 — 마스터/기존 데이터 보호
UPDATE tenants SET plan = 'enterprise', status = 'active' WHERE id = 'tnt_default';
