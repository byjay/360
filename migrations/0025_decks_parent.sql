-- [WO 20260921] 마스터 확정 계층: 프로젝트 > 도면(deployment) > 구역(deck) > 영역(deck) > 핀
--   기존 구조의 결함: extractRegionAsDeck() 이 만든 "영역"도 decks 행이라
--   "구역"과 부모-자식 구분이 불가능했다(같은 deployment_id + 같은 level_no).
--   → decks.parent_id 로 자기참조 계층을 만든다.
--      parent_id IS NULL      = 구역(도면 바로 아래 최상위)
--      parent_id = <구역 id>  = 그 구역 안의 영역
--
-- 🔴 추가 전용(비파괴). 기존 컬럼·행은 한 건도 삭제·변형하지 않는다.
--   기존 decks 행은 parent_id 가 NULL 로 남아 종전처럼 "도면 바로 아래 구역"으로 표시된다
--   (마스터 승인 2026-09-21). 백필 UPDATE 없음.

ALTER TABLE decks ADD COLUMN parent_id TEXT;   -- 상위 구역(decks.id). NULL = 최상위 구역

-- 트리 렌더가 부모별 자식을 뽑는 경로(WHERE project_id = ? ... 후 parent_id 그룹핑)의 보조 인덱스
CREATE INDEX IF NOT EXISTS idx_decks_parent ON decks(parent_id);
