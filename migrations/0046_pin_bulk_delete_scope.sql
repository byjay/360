-- [WO 20261015-bulkdel-undo] 구역/선택 범위 일괄삭제도 기존 pin_bulk_deletes 로 기록 — 범위 구분 컬럼만 추가.
--   scope: 'project'(모든 핀 삭제, 0039 기존 경로) | 'zone'(구역/영역 범위) | 'selection'(사용자가 고른 핀).
--   기존 행(과거 프로젝트 전체 삭제)은 DEFAULT 'project' 로 그대로 집계된다 — 과거 데이터 재작성 0.
-- 🔴 추가 전용(기존 컬럼·테이블 불변). prod 적용은 지휘자가 한다(서버는 이 컬럼이 없으면 구역/선택 삭제를 거부 = 503).
ALTER TABLE pin_bulk_deletes ADD COLUMN scope TEXT NOT NULL DEFAULT 'project';
ALTER TABLE pin_bulk_deletes ADD COLUMN scope_label TEXT;
