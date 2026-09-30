-- [WO 20260930-merge] 구역 단위 포인트 합치기(D5) — 벡터 복사 구역이 "원본의 어느 상자"였는지 기록한다.
--   벡터 복사 구역은 새 1페이지 배포본을 가리키고 crop 이 NULL 이라, 이 기록이 없으면 두 구역 사이의
--   공통 좌표계를 알 수 없다(좌표 변환 불가). 합치기는 아래 3개로만 좌표를 변환한다.
--     src_dep_id : 상자의 기준 배포본(원본 도면). 원본이 이미 기록된 복사본에서 다시 잘랐으면 그 원본까지 합성해 둔다
--     src_page   : 기준 배포본의 페이지(1-base)
--     src_crop   : JSON {"x","y","w","h"} — 기준 페이지 % 상자(MapCtrl.deckCropPctToPage/pageToDeckCropPct 입력)
--   NULL = 레거시(이 마이그레이션 이전 복사본) 또는 창/원본 구역 → 클라가 "좌표 변환 불가" 로 정직하게 표시.
--
-- 🔴 추가 전용(비파괴). 기본값·백필 없음 — 기존 행은 전부 NULL.
ALTER TABLE decks ADD COLUMN src_dep_id TEXT;
ALTER TABLE decks ADD COLUMN src_page INTEGER;
ALTER TABLE decks ADD COLUMN src_crop TEXT;
