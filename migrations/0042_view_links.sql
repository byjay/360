-- [WO 20261011-viewmode] 마스터: "배포는 체커보드와 360 모드 각각 가능하게"
--   뷰어 배포 링크에 모드(체커/360/둘다)를 영구히 싣는다. 기존 ?d=<배포본> 링크(이 테이블에 행이 없음)는
--   mode=NULL(둘다)로 간주 — 하위호환(유실 0). 서버 읽기 SoT(readScopeOf)가 이 행을 조회해 필터링한다.
--
-- 🔴 추가 전용(비파괴). 백필 없음.
CREATE TABLE IF NOT EXISTS view_links (
  id TEXT PRIMARY KEY,
  dep_id TEXT NOT NULL,
  mode TEXT,              -- 'checker' | '360' | NULL(둘다)
  created_by TEXT,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_view_links_dep ON view_links(dep_id);
