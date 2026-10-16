-- [WO 20261016-multisheet P2] 시트 묶음 번호 연결 + 핀 번호 접두 — 설계 .tmp/design-multisheet.md §2-4 / §3-2 / §4-2.
-- 🔴 추가 전용(비파괴) · 백필 UPDATE 0 · 기본값 없음(0022/0025/0029/0031/0048 과 같은 규율).
--   sheet_link : 1 = 이 구역(시트 묶음) 아래 같은 PDF 도면끼리 핀 번호 공간을 하나로 + 같은 번호 연결. NULL/0 = 종전(페이지별).
--   num_prefix : 자동 채번 접두(A, ER-, B2- …). NULL = 순수 숫자(종전). 자식 구역은 가장 가까운 조상 값을 쓴다(클라 Projects.numPrefixOf).
-- 원격(prod) 적용은 지휘자가 한다. 서버는 이 컬럼을 "보낸 경우에만" 쓴다(미적용 DB 에서도 기존 구역 생성·수정은 그대로 동작).
ALTER TABLE decks ADD COLUMN sheet_link INTEGER;
ALTER TABLE decks ADD COLUMN num_prefix TEXT;
