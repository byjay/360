-- 0007_company_signup.sql
-- 회사 이메일 자체가입(self-signup) 시스템
--  · email_codes      : 이메일 인증코드 (회원가입/비밀번호재설정용 1회성 코드)
--  · local_users      : 회사 이메일 + 비밀번호로 가입한 뷰어 계정
--  · allowed_domains  : 관리자가 허용한 회사 도메인 화이트리스트(선택)

-- 인증코드: 이메일로 발송된 6자리 코드를 임시 저장. 검증되거나 만료되면 무효화.
CREATE TABLE IF NOT EXISTS email_codes (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  code        TEXT NOT NULL,          -- 6자리 숫자 코드
  purpose     TEXT NOT NULL DEFAULT 'signup', -- signup | reset
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,       -- 만료 시각(ms)
  attempts    INTEGER NOT NULL DEFAULT 0,
  consumed    INTEGER NOT NULL DEFAULT 0  -- 1=사용완료
);
CREATE INDEX IF NOT EXISTS idx_email_codes_email ON email_codes(email);
CREATE INDEX IF NOT EXISTS idx_email_codes_expires ON email_codes(expires_at);

-- 회사 이메일 자체가입 사용자 계정 (뷰어)
CREATE TABLE IF NOT EXISTS local_users (
  email          TEXT PRIMARY KEY,    -- 소문자 정규화된 이메일
  name           TEXT NOT NULL DEFAULT '',
  domain         TEXT NOT NULL,       -- 회사 도메인(@ 뒤)
  pw_hash        TEXT NOT NULL,       -- PBKDF2(SHA-256) hex
  pw_salt        TEXT NOT NULL,       -- salt hex
  email_verified INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  last_login_at  INTEGER,
  deleted        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_local_users_domain ON local_users(domain);

-- 회사 도메인 화이트리스트(프로젝트별 권한 세팅)
--  · project_id = '*' 이면 전역(모든 프로젝트 공통) 허용 도메인
--  · project_id = '<id>' 이면 해당 프로젝트 전용 허용 도메인
CREATE TABLE IF NOT EXISTS allowed_domains (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL DEFAULT '*',
  domain      TEXT NOT NULL,          -- 예: seastargo.com
  note        TEXT,
  added_by    TEXT,
  created_at  INTEGER NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0,
  UNIQUE(project_id, domain)
);
CREATE INDEX IF NOT EXISTS idx_allowed_domains_project ON allowed_domains(project_id);

-- 로컬 세션 토큰(회사 이메일 로그인 후 발급). 구글 토큰 대신 사용.
CREATE TABLE IF NOT EXISTS local_sessions (
  token       TEXT PRIMARY KEY,       -- 랜덤 세션 토큰(local- 접두)
  email       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  revoked     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_local_sessions_email ON local_sessions(email);
CREATE INDEX IF NOT EXISTS idx_local_sessions_expires ON local_sessions(expires_at);
