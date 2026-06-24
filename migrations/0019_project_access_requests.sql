-- 0019: 프로젝트별 접근 신청 테이블
-- 비멤버 구글 로그인 사용자가 특정 프로젝트 접근을 신청 → 관리자 승인 시 viewer로 자동 배정
CREATE TABLE IF NOT EXISTS project_access_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  email TEXT NOT NULL,
  message TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
  handled_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_par_proj_email ON project_access_requests(project_id, email);
CREATE INDEX IF NOT EXISTS idx_par_email ON project_access_requests(email);
CREATE INDEX IF NOT EXISTS idx_par_status ON project_access_requests(project_id, status);
