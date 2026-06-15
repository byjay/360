-- 사용 신청(Request Access) — 승인받지 않은 사용자가 설계자 권한을 요청
--  · 권한 없는 구글 계정이 설계자 로그인 시 "권한 없음" 화면 + 신청 폼 노출
--  · 슈퍼관리자가 신청 목록을 확인하고 승인 → designers 테이블에 등록
CREATE TABLE IF NOT EXISTS access_requests (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,            -- 신청자 구글 계정 이메일(소문자)
  name        TEXT,                     -- 신청자 이름
  company     TEXT,                     -- 회사/조직
  country     TEXT,                     -- 국가
  phone       TEXT,                     -- 연락처
  message     TEXT,                     -- 추가 메시지(선택)
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
  reviewed_by TEXT,                     -- 처리한 슈퍼관리자 이메일
  created_at  INTEGER NOT NULL,         -- epoch ms
  updated_at  INTEGER NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_access_requests_status ON access_requests(status);
CREATE INDEX IF NOT EXISTS idx_access_requests_email ON access_requests(email);
CREATE INDEX IF NOT EXISTS idx_access_requests_created ON access_requests(created_at);
