-- [WO 20261016-treednd] 트리 구역 드래그 순서 — 형제 사이의 사용자 지정 순서.
-- 🔴 추가 전용(비파괴). NULL 이면 기존 정렬(COALESCE(level_no,999999), created_at)로 폴백한다
--   (mapDeck/GET decks SoT — src/index.tsx). 원격(prod) 적용은 지휘자가 한다.
ALTER TABLE decks ADD COLUMN sort_order INTEGER;
CREATE INDEX IF NOT EXISTS idx_decks_sort ON decks(project_id, parent_id, sort_order);
