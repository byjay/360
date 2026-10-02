-- [WO 20261002-gap · 묶음C/D] 결함 워크플로(기한·심각도) + 메일 실패 사유 기록
-- 🔴 추가 컬럼만(기존 행 동작 불변). status='verified' 는 코드(VALID_STATUS_PATCH)에서만 허용 — 컬럼 타입 변경 없음(TEXT 그대로).
ALTER TABLE pin_notes ADD COLUMN due_at INTEGER;     -- 기한(epoch ms, 선택)
ALTER TABLE pin_notes ADD COLUMN severity TEXT;      -- '상'|'중'|'하'(선택) — 사람이 확정한 값만 저장(Jev 는 제안만, 자동확정 금지)

-- [묶음D] 메일 발송 실패 사유 — 상태코드 + 응답 본문 요약(키 값 제외). 성공/미시도 시 NULL.
ALTER TABLE inquiries ADD COLUMN mail_error TEXT;
