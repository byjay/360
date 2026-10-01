-- [WO 20261001-viewreq] 열람자 요청·질문 + 디자이너 구역별 요청함 — 새 테이블 없이 pin_notes 재사용.
-- 마스터: "열람자는 보기만 할 거다. 단 요청을 할 수 있다. 노트를 하듯이 디자이너에게 요청이나 질문은 가능하게 해"
--         "그걸 디자이너는 구역별로 리스트해서 볼 수 있게 해"
-- kind        : 'note'(기존 이슈 노트) | 'request'(요청) | 'question'(질문) | 'reply'(디자이너 답변)
-- parent_id   : reply 가 가리키는 원 요청 id(pin_notes.id). 그 외 NULL
-- deck_id     : 요청이 속한 구역/영역(decks.id) — 서버가 작성 시 핀 좌표·deck crop 으로 확정(요청함 그룹핑 키)
-- pin_id = '' : 핀 없는 요청(도면/구역 단위). 기존 NOT NULL 스키마를 그대로 쓴다.
-- author_contact  : 익명 열람자의 회신 이메일(선택). 디자이너에게만 응답에 실린다
-- author_key_hash : 익명 작성자 본인 확인용 수정키 sha256(원문은 작성 응답에만 1회 — DB 에 원문 없음)
-- ip              : 레이트리밋 키(실 IP 또는 'anon') — inquiries.ip 와 같은 규칙
-- 🔴 추가 컬럼만 — 기존 노트 행은 kind='note' 로 그대로 유지(동작 불변).
ALTER TABLE pin_notes ADD COLUMN kind TEXT NOT NULL DEFAULT 'note';
ALTER TABLE pin_notes ADD COLUMN parent_id TEXT;
ALTER TABLE pin_notes ADD COLUMN deck_id TEXT;
ALTER TABLE pin_notes ADD COLUMN author_contact TEXT;
ALTER TABLE pin_notes ADD COLUMN author_key_hash TEXT;
ALTER TABLE pin_notes ADD COLUMN ip TEXT;
CREATE INDEX IF NOT EXISTS idx_pin_notes_ip_rate ON pin_notes(ip, created_at);
CREATE INDEX IF NOT EXISTS idx_pin_notes_kind_dep ON pin_notes(kind, deployment_id, deleted);
