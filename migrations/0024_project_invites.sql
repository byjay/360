-- [보안 P40] 프로젝트 초대 링크 — 기본 비밀번호('1') 자동계정 생성 제거의 대체 구조.
--
-- 결함(제거 대상): POST /api/projects/:id/members 가 초대 즉시 local_users 를 비밀번호 '1' 로 만들었다.
--   must_change_password=1 로 변경을 강제해도, "본인이 첫 로그인 하기 전"의 창에서 이메일을 아는
--   제3자가 <email> + '1' 로 선점 로그인할 수 있었다(이메일은 추측이 쉽다).
--
-- 대체: 초대 시 계정을 만들지 않고 일회용 초대 토큰을 발급한다.
--   · 토큰 원문은 링크에만 존재하고 DB 에는 SHA-256 해시만 저장한다(DB 유출 시 재사용 불가).
--     토큰이 256비트 암호난수(crypto.getRandomValues)라 사전공격 대상이 아니므로 SHA-256 1회로 충분하다.
--     (비밀번호와 달리 저엔트로피 원문 추측이 불가능 → PBKDF2 스트레칭 불필요)
--   · 링크를 연 사용자가 이름 + 비밀번호를 직접 설정해야 계정이 생성된다.
--   · expires_at(만료) + used(1회 사용) 로 재사용을 차단한다.

CREATE TABLE IF NOT EXISTS project_invites (
  id          TEXT PRIMARY KEY,               -- inv-<hex>
  token_hash  TEXT NOT NULL UNIQUE,           -- SHA-256(token) hex — 원문 저장 금지
  project_id  TEXT NOT NULL,
  email       TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'viewer', -- viewer|editor|designer (project_members.role 과 동일 어휘)
  invited_by  TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,               -- 기본 14일
  used        INTEGER NOT NULL DEFAULT 0,     -- 1회 사용 플래그(소비 시 1)
  used_at     INTEGER,
  revoked     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pinv_project ON project_invites(project_id);
CREATE INDEX IF NOT EXISTS idx_pinv_email   ON project_invites(email);
