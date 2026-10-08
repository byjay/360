-- [WO 20261008-pinpurge] 프로젝트 모든 핀 삭제(소유자·super) — 되돌리기용 스냅샷 + 감사 보조.
--   핀 삭제 자체는 배포본 pins JSON 의 tombstone({id,_deleted,ts}) 이다(하드 삭제 아님, R2 원본 불변).
--   tombstone 은 다음 전체 저장(PATCH pins)에 사라질 수 있어 복원 원본을 여기 따로 둔다.
--   한 배치(batch_id) = 한 번의 [모든 핀 삭제] 실행, 배포본마다 1행.
-- 🔴 추가 전용(새 테이블). 기존 테이블 불변. prod 적용은 지휘자가 한다(서버는 이 테이블이 없으면 삭제를 거부 = 503).
CREATE TABLE IF NOT EXISTS pin_bulk_deletes (
  batch_id       TEXT NOT NULL,
  deployment_id  TEXT NOT NULL,
  project_id     TEXT NOT NULL,
  actor_email    TEXT,
  pins           TEXT NOT NULL,          -- 삭제 직전 살아있던 핀 객체 배열(JSON) — 복원 원본
  pin_count      INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  restored_at    INTEGER,                -- NULL = 아직 복원 안 됨
  restored_by    TEXT,
  restored_count INTEGER,
  PRIMARY KEY (batch_id, deployment_id)
);
CREATE INDEX IF NOT EXISTS idx_pin_bulk_deletes_project ON pin_bulk_deletes(project_id, created_at);
