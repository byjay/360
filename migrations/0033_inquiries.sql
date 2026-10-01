-- [WO 20261001-viewerhelp] 개발자 문의 — 뷰어(공유/배포 링크, 로그인 불필요) + 편집 화면 공용.
-- 로그인 없는 열람자도 보낼 수 있어야 하므로 sender_email 은 NULL 허용(로그인 상태면 채워짐).
-- ip 는 IP 또는 로컬환경 폴백 버킷('anon') — 분당 N건 레이트리밋 조회에 쓰인다.

CREATE TABLE IF NOT EXISTS inquiries (
  id            TEXT PRIMARY KEY,             -- inq-<hex>
  created_at    INTEGER NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  reply_email   TEXT,                         -- 사용자가 회신받고 싶은 이메일(선택)
  sender_email  TEXT,                         -- 로그인 상태였던 보낸 사람(열람전용 세션은 NULL)
  project_name  TEXT,
  deployment_id TEXT,
  mode          TEXT,                         -- 'designer' | 'viewer' 등 현재 화면 모드
  user_agent    TEXT,
  app_version   TEXT,                         -- 클라이언트 번들 버전 해시(index.html main.js?v=)
  ip            TEXT,                         -- 레이트리밋 키(실 IP 또는 'anon')
  mail_sent     INTEGER NOT NULL DEFAULT 0,   -- Resend/SendGrid 발송 성공 여부
  resolved      INTEGER NOT NULL DEFAULT 0,   -- 관리자 처리완료 체크
  resolved_at   INTEGER,
  deleted       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_inquiries_created ON inquiries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inquiries_ip_rate ON inquiries(ip, created_at);
