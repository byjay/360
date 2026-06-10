-- 360° Location Viewer — 저장/배포 테이블

-- 360° 파노라마 그림 클라우드 저장소
CREATE TABLE IF NOT EXISTS pano_images (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  image_data  TEXT NOT NULL,          -- 리사이즈 JPEG dataURL (장변 ≤4096px)
  width       INTEGER,
  height      INTEGER,
  created_at  INTEGER NOT NULL,       -- epoch ms
  updated_at  INTEGER NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0
);

-- 배포 스냅샷 (설계자 → 뷰어)
CREATE TABLE IF NOT EXISTS deployments (
  id            TEXT PRIMARY KEY,
  title         TEXT,
  file_name     TEXT,
  drawing_data  TEXT,                 -- 1페이지 스냅샷(레거시 호환)
  pages_data    TEXT,                 -- 전 페이지 스냅샷 dataURL 배열(JSON)
  pins          TEXT,                 -- 핀 배열 JSON
  created_at    INTEGER NOT NULL,     -- epoch ms
  updated_at    INTEGER NOT NULL,
  deleted       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_pano_images_created ON pano_images(created_at);
CREATE INDEX IF NOT EXISTS idx_deployments_created ON deployments(created_at);
