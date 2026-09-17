-- [WORK_ORDER_20260916] 구역(deck) = 도면의 한 조각(페이지+크롭). 영역(zone)은 그 조각 "안"의 핀 묶음.
--   실례: 메인데크는 구역(deck) — 큰 PDF의 1개 페이지(+선택적 크롭)를 가리킨다.
--         그 데크 안의 "00룸"은 영역(zone) — 데크 안에서 핀을 묶는 논리적 그룹(기존 zones 그대로).
--   계층: 프로젝트 > 구역(deck)=page+crop > 영역(zone)=방/구획 > 핀
-- 🔴 추가 전용. 기존 컬럼·데이터는 손대지 않는다. NULL(구버전 구역)은 종전대로(페이지 전체) 동작.

ALTER TABLE decks ADD COLUMN page INTEGER;   -- 이 구역이 가리키는 PDF 페이지(1-base). NULL = 구버전(페이지 무관)
ALTER TABLE decks ADD COLUMN crop TEXT;      -- JSON {"x":..,"y":..,"w":..,"h":..} (% 좌표). NULL = 페이지 전체
