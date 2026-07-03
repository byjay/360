-- 인증/권한 + 프로젝트/데크(선박 층) 구조

-- 디자이너 권한 부여 목록 (슈퍼관리자가 지정)
--  · email 이 여기에 있으면 디자이너 권한
--  · 슈퍼관리자(designssir@gmail.com)는 코드에 하드코딩되어 항상 디자이너+관리 권한
CREATE TABLE IF NOT EXISTS designers (
  email       TEXT PRIMARY KEY,        -- 구글 계정 이메일(소문자)
  name        TEXT,                    -- 표시 이름(로그인 시 갱신)
  added_by    TEXT,                    -- 지정한 슈퍼관리자 이메일
  created_at  INTEGER NOT NULL,        -- epoch ms
  updated_at  INTEGER NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0
);

-- 프로젝트 (예: "○○호 검사")
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  owner       TEXT,                    -- 생성한 디자이너 이메일
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0
);

-- 데크 = 서브프로젝트(선박의 층). 프로젝트에 속함
CREATE TABLE IF NOT EXISTS decks (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  name          TEXT NOT NULL,         -- 예: "Main Deck", "2nd Deck", "Engine Deck"
  level_no      INTEGER,               -- 층 번호(정렬용, 선택)
  deployment_id TEXT,                  -- 연결된 배포 스냅샷(도면+핀) id (선택)
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  deleted       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_projects_created ON projects(created_at);
CREATE INDEX IF NOT EXISTS idx_decks_project ON decks(project_id);
CREATE INDEX IF NOT EXISTS idx_decks_created ON decks(created_at);
