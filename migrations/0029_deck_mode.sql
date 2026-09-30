-- [WO 20260930-fixmode] 마스터: "모드를 체커와 360으로 구분 — 프로젝트 하위 최상단에 체커/360, 그 하위로 구역-영역"
--   구역·영역(decks)이 어느 모드 작업공간에 속하는지 태그한다.
--     mode = 'checker' : CHECKER 작업공간 전용
--     mode = '360'     : 360 작업공간 전용
--     mode IS NULL     : 이 마이그레이션 이전의 기존 구역 → 두 모드 트리 모두에 표시(유실 0)
--   허용값 검사는 서버(src/index.tsx parseDeckMode)가 한다 — POST/PUT 에서 그 외 값은 400.
--
-- 🔴 추가 전용(비파괴). 기본값 없음·백필 UPDATE 없음 — 기존 행은 전부 NULL 로 남는다.
ALTER TABLE decks ADD COLUMN mode TEXT;
