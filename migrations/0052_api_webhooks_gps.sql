-- [WO 20261019-gap3] SIGNAX 격차3 — GPS 자동배치 · 외부 API/웹훅 · 촬영세션 잔여.
-- 🔴 추가 전용(비파괴). 기존 테이블 컬럼 변경 없음. 로컬 전용 — 원격(D1 production) 적용 금지(지시).

-- ── GPS 기준점 맞추기(구역+시트별 상사/아핀 변환, 판정기준 §1) ──
--   points     : JSON [{x,y,lat,lng}] 사용자가 탭한 기준점(도면 픽셀% + 현장 GPS)
--   matrix     : JSON {a,b,c,d,e,f,refLat,refLng} 픽셀→ENU(m) 아핀 변환(캐시, 재계산 없이 재사용)
--   residual_m : 적합 잔차(최대, m) — 정확도 경고 임계(5m)와 비교해 UI 가 표시
CREATE TABLE IF NOT EXISTS gps_calibrations (
  id            TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL,
  page          INTEGER NOT NULL DEFAULT 1,
  points        TEXT NOT NULL,
  matrix        TEXT,
  residual_m    REAL,
  created_by    TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gps_calib_dep ON gps_calibrations(deployment_id, page);

-- ── 외부 API 키(프로젝트별 발급, 읽기 기본/쓰기 옵션) ──
--   key_hash   : sha256(원문) — 원문은 발급 응답 1회만, 이후 저장 0(마스터 지시 "원문은 1회만 표시").
--   key_prefix : 원문 앞 8자(표시용 식별 — "wk_7f3a9c2e...") — 원문 재구성 불가(prefix 만으로 추측 불가한 길이).
--   scope      : 'read' | 'write' — 쓰기는 옵션, 기본 read.
--   rl_*       : 고정 윈도(60s) 레이트리밋 카운터(이 행 자체에 저장 — 별도 KV/Durable Object 없음, D1 단일 SoT).
CREATE TABLE IF NOT EXISTS api_keys (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  name            TEXT,
  key_hash        TEXT NOT NULL,
  key_prefix      TEXT NOT NULL,
  scope           TEXT NOT NULL DEFAULT 'read',
  created_by      TEXT,
  created_at      INTEGER NOT NULL,
  revoked_at      INTEGER,
  rl_window_start INTEGER NOT NULL DEFAULT 0,
  rl_count        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_api_keys_project ON api_keys(project_id, revoked_at);

-- ── 웹훅(프로젝트별 URL 등록) ──
--   secret     : HMAC-SHA256 서명 키(원문 그대로 저장 — 서버가 매 발송 때 서명해야 하므로 해시 불가.
--                응답에는 발급 후 다시 노출하지 않는다, 재발급만 가능).
--   events     : JSON 배열 — pin.created | photo.attached | issue.created | issue.updated | issue.status_changed | deployment.published
--   test_mode  : 1 이면 사설 IP·localhost 대상 허용(SSRF 가드 예외, §지시).
CREATE TABLE IF NOT EXISTS webhooks (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  url         TEXT NOT NULL,
  secret      TEXT NOT NULL,
  events      TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  test_mode   INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webhooks_project ON webhooks(project_id, active);

-- ── 발송 기록(최근 전송 화면 + 재시도 추적) ──
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id             TEXT PRIMARY KEY,
  webhook_id     TEXT NOT NULL,
  event          TEXT NOT NULL,
  payload        TEXT NOT NULL,
  status         TEXT NOT NULL,   -- 'success' | 'failed'
  attempt        INTEGER NOT NULL DEFAULT 1,
  response_code  INTEGER,
  error          TEXT,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wh_deliveries_webhook ON webhook_deliveries(webhook_id, created_at);
