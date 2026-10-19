-- [WO 20261019-issueflow] 이슈 워크플로 — 담당자 계정 연결 + 알림(앱 내·메일) + 마크업↔이슈 연동(SIGNAX 격차2)
-- 🔴 추가 전용(비파괴). 기존 pin_notes.assignee(자유텍스트) 값은 그대로 보존 — 유실 0. 백필 UPDATE 0(SELECT 로 즉시 정규화해 서버가 매번 재계산해도 되나,
--    목록 필터·정렬에 쓰므로 저장해 둔다. 기존 행은 NULL — 다음 PATCH/표시 시점에 서버가 자연 채움, 강제 마이그레이션 없음).
--   assignee_email : assignee 문자열이 유효한 이메일이면 소문자 정규화 값. 아니면 NULL(지어내지 않음).
ALTER TABLE pin_notes ADD COLUMN assignee_email TEXT;
CREATE INDEX IF NOT EXISTS idx_pin_notes_assignee ON pin_notes(assignee_email, deleted);

-- 사용자(이메일)별 알림 함 — project_members/local_users 와 동일 키(이메일)로 수신자를 식별.
--   kind       : assignee(담당자 지정/변경) | status(상태 변경) | due_soon(마감 24h 전) | due_over(마감 초과) | comment(새 댓글/답변)
--   dedupe_key : 멱등 키(UNIQUE) — 같은 사건의 중복 발송을 막는다. 사건별 키 설계는 src/index.tsx notifyEvent() 주석 참조.
--   mailed_at  : 메일 발송 완료 시각(NULL = 메일 미발송 — 설정으로 끈 경우 포함). 앱 내 알림(이 행 자체)은 메일 여부와 무관하게 항상 쌓인다.
CREATE TABLE IF NOT EXISTS notifications (
  id              TEXT PRIMARY KEY,
  recipient_email TEXT NOT NULL,
  project_id      TEXT,
  note_id         TEXT,
  kind            TEXT NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT,
  dedupe_key      TEXT NOT NULL,
  mailed_at       INTEGER,
  read_at         INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notif_dedupe ON notifications(dedupe_key);
CREATE INDEX IF NOT EXISTS idx_notif_recipient ON notifications(recipient_email, read_at, created_at);

-- 사용자별 메일 알림 설정(끄기 / 즉시·일일요약). 행이 없으면 기본값(즉시발송, 메일 켜짐)으로 동작(코드 SoT).
CREATE TABLE IF NOT EXISTS notify_prefs (
  email        TEXT PRIMARY KEY,
  mail_enabled INTEGER NOT NULL DEFAULT 1,
  digest       TEXT NOT NULL DEFAULT 'instant',
  updated_at   INTEGER NOT NULL
);
