-- 0018_sync_idempotency.sql
-- /api/sync/batch 멱등성 — 응답유실 재시도 시 중복 INSERT 방지.
-- pano_images 에 source_op_id(클라 큐 opId) 기록 + 인덱스.
-- 같은 opId 재전송이면 기존 행 id 를 그대로 돌려주어 중복 생성 0.
ALTER TABLE pano_images ADD COLUMN source_op_id TEXT;
CREATE INDEX IF NOT EXISTS idx_pano_source_op ON pano_images (source_op_id);
