-- [WO 20261010-revision] 도면 개정(Rev) 관리 — 개정 이력 · 이전 개정 도면 보관 · 좌표 이월 되돌리기 스냅샷.
--   한 행 = 한 사건:
--     kind='revision'  : 소유자·super 가 새 개정을 적용(status applied → 10분 안 되돌리면 reverted)
--     kind='proposal'  : 디자이너가 새 개정을 제안(status proposed → 소유자가 적용하면 accepted)
--     kind='replaced'  : 종전 [도면 교체] 저장(PATCH pages_data 변경)으로 밀려난 도면 자동 보관(status archived)
--   이전 도면 원본은 지우지 않는다: R2 객체는 그대로 두고, 그 참조(pages_data·source_meta)를 prev_snapshot 에 남긴다.
-- 🔴 추가 전용(새 테이블). 기존 테이블 불변. prod 적용은 지휘자가 한다(서버는 이 테이블이 없으면 개정 적용을 거부 = 503,
--    종전 교체 저장은 보관만 건너뛰고 그대로 동작).
CREATE TABLE IF NOT EXISTS drawing_revisions (
  id                 TEXT PRIMARY KEY,
  deployment_id      TEXT NOT NULL,
  project_id         TEXT,
  kind               TEXT NOT NULL,          -- revision | proposal | replaced
  status             TEXT NOT NULL,          -- applied | reverted | proposed | accepted | archived
  rev_label          TEXT,                   -- 새 개정 번호(정규화 "Rev.A"/"Rev.1") — replaced 는 NULL
  prev_label         TEXT,                   -- 적용 직전 도면의 개정 번호(이력 첫 개정 = 기준 개정 이름)
  rev_date           TEXT,                   -- 개정 일자(사용자 입력 YYYY-MM-DD)
  memo               TEXT,
  author_email       TEXT,
  file_name          TEXT,
  drawing_data       TEXT,                   -- 새 개정 도면(제안·적용) — 1페이지
  pages_data         TEXT,                   -- 새 개정 도면 전 페이지(JSON, 보통 R2 URL 배열)
  source_meta        TEXT,                   -- 새 개정 원본 PDF 위치(JSON)
  transform          TEXT,                   -- 이전 → 새 개정 % 좌표 아핀 {a,b,c,d,e,f}(JSON)
  prev_snapshot      TEXT,                   -- 적용 직전 배포본 {title,file_name,drawing_data,pages_data,source_meta,pins,zones,annotations,decks,version}
  prev_pages_hash    TEXT,                   -- 보관한 이전 도면 페이지 지문(같은 도면 중복 보관 방지)
  dep_version_before INTEGER,
  dep_version_after  INTEGER,
  created_at         INTEGER NOT NULL,
  applied_at         INTEGER,
  applied_by         TEXT,
  reverted_at        INTEGER,
  reverted_by        TEXT,
  ref_id             TEXT                    -- proposal → 이를 적용한 revision id / revision → 원 제안 id
);
CREATE INDEX IF NOT EXISTS idx_drawing_revisions_dep ON drawing_revisions(deployment_id, created_at);
