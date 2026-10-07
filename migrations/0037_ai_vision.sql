-- [WO 20261007-aivision] 360 사진 AI 분석 결과 캐시 + 호출 기록(일일 상한 집계)
-- 🔴 새 테이블만(기존 테이블 불변). prod 적용은 지휘자가 한다(wrangler d1 migrations apply webapp-production).
--   status='ok'   → result(JSON) 캐시 적중 대상(같은 cache_key 재호출 0)
--   status='error'→ 업스트림/스키마 실패 기록(캐시 아님, 상한 집계에는 포함 — 재시도 폭주 방지)
CREATE TABLE IF NOT EXISTS ai_vision_results (
  id            TEXT PRIMARY KEY,
  cache_key     TEXT NOT NULL,        -- model|image_ref|compare_ref (src/lib/aiVision.ts visionCacheKey)
  deployment_id TEXT,
  pin_id        TEXT,
  image_ref     TEXT NOT NULL,        -- img:<pano_images.id> | r2:<key>  (원본 URL·키 값은 응답에 싣지 않음)
  compare_ref   TEXT,
  model         TEXT NOT NULL,
  status        TEXT NOT NULL,        -- 'ok' | 'error'
  result        TEXT,                 -- JSON(VisionResult) — status='ok' 만
  error         TEXT,                 -- 실패 사유(키 값 제외)
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  cost_usd      REAL,                 -- OpenRouter usage.cost (없으면 NULL — 지어내지 않음)
  ms            INTEGER,
  created_by    TEXT NOT NULL,        -- 호출자 이메일(일일 상한 집계 키)
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_vision_cache ON ai_vision_results(cache_key, status);
CREATE INDEX IF NOT EXISTS idx_ai_vision_user  ON ai_vision_results(created_by, created_at);
