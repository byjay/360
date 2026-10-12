-- [WO 20261012-viewlink] 배포 = 고정 스냅샷 — 추가 전용(비파괴). 백필 없음(배포 중 프로젝트는 첫 열람 시 1회 동결 — 서버 snapshotOf).
--   마스터 "이때는 반드시 디자이너의 프로젝트의 수정내용이 반영돼서는 안돼"
--        "배포취소도 기능구현하고 이거한후 재배포하면 업데이트되게해"
-- 배포(POST /api/projects/:id/publish — 최초·다시 배포 모두)가 그 시점의 구역 트리 + 배포본 행 전부를 여기에 동결한다.
-- 열람 링크 세션(/v/<토큰> · /srview · ?d= · ?lk=)은 작업본(deployments·decks)이 아니라 이 스냅샷만 읽는다.
-- 배포 취소 = projects.published=0(링크·통행증 즉시 무효). 재배포 = 같은 공유 토큰 + 스냅샷 교체.
CREATE TABLE IF NOT EXISTS pub_snapshots (
  project_id TEXT PRIMARY KEY,
  decks_json TEXT NOT NULL,        -- 배포 시점 구역 트리(GET /api/projects/:id/decks 의 행 그대로)
  original_deployment_id TEXT,     -- 배포 시점 프로젝트 원본 배포본
  created_at INTEGER NOT NULL,
  created_by TEXT
);
CREATE TABLE IF NOT EXISTS pub_snapshot_deps (
  project_id TEXT NOT NULL,
  dep_id TEXT NOT NULL,
  row_json TEXT NOT NULL,          -- 배포 시점 deployments 행(SELECT *) JSON
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, dep_id)
);
