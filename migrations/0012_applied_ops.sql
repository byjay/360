-- 0012_applied_ops.sql
-- [오프라인 작업지시서 ❶] 충돌 없는 op 병합을 위한 멱등 적용 로그
-- 같은 opId 를 재전송해도 1회만 반영되도록 보장(중복 업로드 무해화).
CREATE TABLE IF NOT EXISTS applied_ops (
  op_id         TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL,
  applied_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_applied_ops_dep ON applied_ops(deployment_id);
