-- [WO 20261012-pinsync] 원본 ↔ 벡터 복사 구역 핀 연동 — 기존 구역 핀 이관 보관함(설계 .tmp/design-pinsync.md §2-2).
--   벡터 복사 구역 배포본(D1)은 이제 핀에 관해 원본(D0)의 별칭이다(서버가 읽기 투영 · 쓰기 역변환).
--   이미 구역에 따로 저장된 핀(D1.pins)이 있으면 자동 변환하지 않고, 사용자가 [원본과 합치기]를 눌렀을 때만 D0 로 옮긴다.
--   그때 옮기기 전 원본 blob(D1.pins · 그 구역 노트)을 여기에 **그대로** 보관한다(롤백 근거 · 되돌리기 10분).
--   멱등 표식 = (deployment_id) 행 존재 + undone_at IS NULL. 되돌리면 undone_at 을 채우고 다시 이관할 수 있다.
--
-- 🔴 추가 전용(비파괴). 백필 없음.
CREATE TABLE IF NOT EXISTS region_pin_migration (
  id            TEXT PRIMARY KEY,
  deck_id       TEXT NOT NULL,
  deployment_id TEXT NOT NULL,     -- 구역 배포본 D1
  home_id       TEXT NOT NULL,     -- 원본 배포본 D0
  pins_json     TEXT NOT NULL,     -- 이관 전 D1.pins 원문
  notes_json    TEXT NOT NULL,     -- 이관 전 D1 핀 노트 행(pin_notes) 원문
  id_map        TEXT NOT NULL,     -- 충돌로 재발급한 핀 id {old:new}
  moved_ids     TEXT NOT NULL,     -- D0 에 추가된 핀 id 목록(되돌리기 대상)
  actor_email   TEXT,
  migrated_at   INTEGER NOT NULL,
  undone_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_region_pin_migration_dep ON region_pin_migration (deployment_id);
