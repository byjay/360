-- 0008_invites_and_settings.sql
-- (T2) invited_users    : 관리자가 사전 등록한 이메일 → 사용자는 회사/이름만 입력 후 즉시 가입
-- (T2) local_users.company 컬럼 추가 : 가입 시 회사명 저장
-- (T3) app_settings     : 최상위 관리자가 프로젝트별 기능/메뉴/레이아웃/AI를 관장(키-값 JSON)

-- 사전 등록(초대) 이메일 화이트리스트
--  · 관리자가 이메일을 미리 등록해두면, 해당 이메일은 도메인 검사를 우회하고 즉시 가입 가능
--  · used = 가입 완료 시 1
CREATE TABLE IF NOT EXISTS invited_users (
  email       TEXT PRIMARY KEY,         -- 소문자 정규화된 이메일
  company     TEXT,                     -- 기대 회사명(선택; 가입 시 입력값으로 갱신)
  role        TEXT NOT NULL DEFAULT 'viewer',  -- viewer | designer
  note        TEXT,                     -- 관리자 메모
  invited_by  TEXT,                     -- 초대한 관리자 이메일
  project_id  TEXT NOT NULL DEFAULT '*',-- 특정 프로젝트 한정(선택). '*'=전체
  created_at  INTEGER NOT NULL,
  used        INTEGER NOT NULL DEFAULT 0,
  deleted     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_invited_users_used ON invited_users(used);

-- local_users 에 회사명 컬럼 추가 (이미 있으면 무시)
ALTER TABLE local_users ADD COLUMN company TEXT;

-- 앱 설정 키-값 저장 (최상위 관리자 전용)
--  · scope = '*'(전역) | 프로젝트 id
--  · key   = 'features' | 'layout' | 'ai' 등
--  · value = JSON 문자열
CREATE TABLE IF NOT EXISTS app_settings (
  scope       TEXT NOT NULL DEFAULT '*',
  skey        TEXT NOT NULL,
  value       TEXT NOT NULL DEFAULT '{}',
  updated_by  TEXT,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (scope, skey)
);
