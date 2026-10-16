-- [WO 20261016-viewmail] 열람 링크 이메일 인증 + 이메일별 열람 기록. 추가 전용(비파괴) · 백필 0.
--   마스터: "본인 이메일로 보안코드 받고 메일 주소별 사용자 사용 로그" · "메일로 받은 링크가 진짜인 거지"
--   범위 = 프로젝트(배포 링크 1개 = 프로젝트 공유 주소). 정책이 켜진 프로젝트는 모든 익명 링크 경로(/v · /srview · ?d= · ?lk=)가
--   이메일 통행증을 요구한다. 행 없음 = 종전(무인증 링크) — 기존 링크는 디자이너가 켜기 전까지 그대로.
--   🔴 개인정보: 원본 IP 저장 금지(국가 + 서버비밀 HMAC 해시만). 보관 기간 = PERSONAL_LOG_RETENTION_DAYS(365일, src/index.tsx 정본).
--   원격(prod) 적용은 지휘자가 한다.
CREATE TABLE IF NOT EXISTS viewer_access_policy (
  project_id TEXT PRIMARY KEY,
  email_auth INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS viewer_recipients (
  project_id TEXT NOT NULL,
  email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  auth_epoch INTEGER NOT NULL DEFAULT 0,
  invited_by TEXT,
  invited_at INTEGER,
  last_invite_at INTEGER,
  blocked_at INTEGER,
  PRIMARY KEY (project_id, email)
);
CREATE TABLE IF NOT EXISTS viewer_auth_challenges (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  email TEXT,
  email_hash TEXT NOT NULL,
  method TEXT NOT NULL,
  secret_hash TEXT,
  ip_hash TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_vac_email ON viewer_auth_challenges(email_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_vac_ip ON viewer_auth_challenges(ip_hash, created_at);
CREATE TABLE IF NOT EXISTS viewer_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  email TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  detail TEXT,
  device TEXT,
  country TEXT,
  ip_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_ve_proj_email ON viewer_events(project_id, email, ts);
