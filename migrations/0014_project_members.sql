-- PART 0 · 프로젝트별 멤버십(누가 어느 프로젝트에 접근) — 멀티고객 뷰어 격리의 핵심
-- 마스터 요구: 회사마다 프로젝트 N개, 관리자가 "어느 프로젝트에 누구를" 세팅 → 뷰어는 권한받은 프로젝트만.
-- 기존 격리는 tenant(회사) 레벨까지였고, project 레벨 사용자 배정 테이블이 없었음 → 신설.

CREATE TABLE IF NOT EXISTS project_members (
  project_id  TEXT NOT NULL,
  email       TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'viewer',  -- viewer|editor|designer (프로젝트 한정 역할)
  granted_by  TEXT,                            -- 배정한 관리자 이메일
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (project_id, email)
);
CREATE INDEX IF NOT EXISTS idx_pm_email   ON project_members(email);
CREATE INDEX IF NOT EXISTS idx_pm_project ON project_members(project_id);
