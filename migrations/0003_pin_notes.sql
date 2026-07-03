-- 이슈/필드노트 협업 — 핀(위치) 단위 코멘트 스레드
--  · 도면 위 핀마다 여러 개의 노트(이슈/코멘트)를 달 수 있음
--  · 상태: open(미해결) / progress(진행중) / done(완료)
--  · 현장 협업을 위해 누구나 작성 가능, 수정/삭제/상태변경은 작성자 또는 디자이너
--  · deployment_id + pin_id 로 핀을 식별 (배포 스냅샷의 핀과 연결)
CREATE TABLE IF NOT EXISTS pin_notes (
  id            TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL,            -- 어느 배포(도면+핀 스냅샷)에 속하는지
  pin_id        TEXT NOT NULL,            -- 핀 식별자 (pins JSON의 id)
  pin_label     TEXT,                     -- 작성 시점 핀 이름 스냅샷(표시용)
  body          TEXT NOT NULL,            -- 노트 내용
  status        TEXT NOT NULL DEFAULT 'open',  -- open | progress | done
  assignee      TEXT,                     -- 담당자(자유 텍스트 또는 이메일)
  author        TEXT,                     -- 작성자 표시명
  author_email  TEXT,                     -- 작성자 이메일(권한 판정용, 없으면 익명)
  author_role   TEXT,                     -- 작성 시점 역할 super/designer/viewer
  created_at    INTEGER NOT NULL,         -- epoch ms
  updated_at    INTEGER NOT NULL,
  resolved_at   INTEGER,                  -- 완료 처리 시각(선택)
  deleted       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_pin_notes_dep_pin ON pin_notes(deployment_id, pin_id, deleted);
CREATE INDEX IF NOT EXISTS idx_pin_notes_status ON pin_notes(status, deleted);
CREATE INDEX IF NOT EXISTS idx_pin_notes_created ON pin_notes(created_at);
